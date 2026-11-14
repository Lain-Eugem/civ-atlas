/*
 * 君主开局面板(viewer 客户端模块,IIFE,不依赖 app.js 内部状态)。
 *
 * 由 mcp/viewer/app.js 的「✦ 开局设置」按钮调用:
 *   window.CivStart.open({ sessionId, state, api, pick, onApplied })
 * - api(path, body):app.js 的 fetch 包装;body 省略是 GET,否则 POST JSON,返回 JSON 对象
 * - pick(cb):进入地图点选模式;用户点地图后回调 cb({ x, y })(主图世界像素 0..2048 / 0..1024)
 * - onApplied(data):应用成功后的回调,data = { state, result }(Lead 用它刷新看板)
 *
 * 面板分两段:
 *   ① 国家名单:数量(3–30)、每国控制方式(AI 君主 / 程序自动)、删国、新建国家(带落点)
 *      —— 走 POST /api/session/start-setup,每个会话只能应用一次(第一回合前)
 *   ② 君主定制:选一个现有国家或新建国家,改角色卡与起始疆域
 *      —— 走 POST /api/session/custom-start(原有能力,保留)
 * 两段都只是本地预览,点「应用开局」才提交;有删改时先提交国家设置,再提交君主定制。
 *
 * 后端路由:
 *   GET  /api/start/config?sessionId=<id>   -> { nations:[{polityId,name,color,capital,regions,seatName,control}], count, min, max, canSetup, applied, control, regions }
 *   GET  /api/start/nations?sessionId=<id>  -> { nations: StartNation[] }
 *   POST /api/session/start-setup           -> { ok, result: StartSetupResult, state }
 *        body: { sessionId, count?, remove?:number[], controls?:{[id]:'ai'|'program'}, nations?:[{at?,size?,card?,control?}], force? }
 *        409 = 删到最后一州需要确认,body = { error, needConfirm:[{polityId,name,message}] },确认后带 force:true 重提
 *   POST /api/session/custom-start          -> { state, result: CustomStartResult }
 *        body: { sessionId, polityId?, at?: {x,y}, size?, card?, autoCard? }
 */
(function () {
  'use strict';

  var STYLE_ID = 'start-custom-style';
  var PANEL_ID = 'startCustomPanel';

  /** @type {null | {sessionId:string, state:any, api:Function, pick:Function, onApplied:Function}} */
  var cfg = null;
  /** ② 君主定制的点选位置;null = 没选(新建国家时后端回退到最大无主州) */
  var pickedAt = null;
  /** ① 新增国家的点选位置;null = 让后端挑最大的无主州 */
  var addAt = null;
  /** ② 当前国家列表(GET /api/start/nations) */
  var nations = [];
  /** ① 开局国家设置状态(GET /api/start/config);null = 这个版本没有该接口 */
  var setupInfo = null;
  /** ① 本地预览:将删除的国家编号 */
  var removedIds = {};
  /** ① 本地预览:国家编号 → 控制方式 */
  var controls = {};
  /** ① 应用前的控制方式(只提交改过的) */
  var initialControls = {};
  /** ① 本地预览:将新建的国家 [{size, at?}] */
  var addedNations = [];
  var addedSeq = 0;
  /** ① 目标国家数量(滑块值) */
  var countTarget = 0;
  /** ① 滑块初始值(没动就不提交 count) */
  var countBase = 0;
  /** ① 应用过之后锁定(一个会话只能应用一次) */
  var countriesLocked = false;
  /** ② 君主定制是否有本地改动 */
  var customDirty = false;
  /** 正在请求中 */
  var busy = false;
  /** 待确认的删除动作 */
  var confirmAction = null;
  /** bindPick 注册的外部回调(可选) */
  var externalPick = null;
  /** ② 连续点选已选的州号(升序);提交时作为 regionIds 优先于 size/at */
  var regionSel = [];
  /** ② 疆域连续点选覆盖层是否打开 */
  var regionPickerOn = false;
  /** ② 点选覆盖层当前高亮的国家编号 */
  var regionHighlight = null;
  /** 防止「点选回调同步下拉 → 下拉 change」再飞一次 */
  var syncingFromPicker = false;

  function $(id) {
    return document.getElementById(id);
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function el(id) {
    var node = $(id);
    if (!node) throw new Error('start-custom: 缺少 #' + id);
    return node;
  }

  function toastMsg(text, isErr) {
    var box = $('startMsg');
    if (!box) return;
    box.textContent = text || '';
    box.className = 'start-msg' + (isErr ? ' err' : ' ok');
  }

  function setBtnBusy(on) {
    var apply = el('startApply');
    apply.disabled = on;
    apply.textContent = on ? '应用中…' : '应用开局';
  }

  // ── 样式:最小自足样式(不改 style.css;Lead 可以覆盖/补充 start-* 类) ─────
  function injectStyle() {
    if ($(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + PANEL_ID + '[hidden]{display:none!important}',
      '#' + PANEL_ID + '{position:absolute;left:var(--gap,12px);top:calc(var(--top-h,0px) + var(--gap,12px)*2);z-index:60;width:404px;max-height:calc(100vh - var(--top-h,0px) - var(--gap,12px)*3);display:flex;flex-direction:column;overflow:hidden;background:var(--panel-solid,#fffdf8);color:var(--ink,#2b2622);border:1px solid var(--line,#d9d2c6);border-radius:var(--r-panel,10px);box-shadow:0 10px 30px rgba(0,0,0,.18)}',
      '#' + PANEL_ID + ' .panel-head{flex:0 0 auto}',
      '#startCustomPanel .start-panel-body{overflow:auto;display:flex;flex-direction:column;gap:10px;padding:10px 12px}',
      '#startCustomPanel .start-panel-body .field{display:flex;flex-direction:column;gap:4px;margin:0}',
      '#startCustomPanel .field>span,#startCustomPanel .field>label{font-size:12px;color:var(--ink-2,#5c544a)}',
      '#startCustomPanel input[type=text],#startCustomPanel select,#startCustomPanel textarea{width:100%;box-sizing:border-box;background:var(--field,#f6f1e7);color:var(--ink,#2b2622);border:1px solid var(--line-soft,#e6ded0);border-radius:6px;padding:5px 7px;font:inherit;font-size:13px}',
      '#startCustomPanel textarea{min-height:62px;resize:vertical}',
      '#startCustomPanel input[type=range]{width:100%}',
      '#startCustomPanel .field.check{flex-direction:row;align-items:center;gap:6px;font-size:13px}',
      '#startCustomPanel .start-coord{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '#startCustomPanel .start-coord .hint{font-size:12px;color:var(--ink-3,#857b6d);flex:1 1 130px}',
      '#startCustomPanel .start-card-fields{display:flex;flex-direction:column;gap:8px;border:0;margin:0;padding:0;min-width:0}',
      '#startCustomPanel .start-card-fields[disabled]{opacity:.45}',
      '#startCustomPanel .start-card-fields .row{display:flex;gap:8px}',
      '#startCustomPanel .start-card-fields .row>.field{flex:1 1 0}',
      '#startCustomPanel .start-msg{min-height:18px;font-size:12px;line-height:1.5;white-space:pre-wrap;color:var(--ink-3,#857b6d)}',
      '#startCustomPanel .start-msg.err{color:#b23a2e}',
      '#startCustomPanel .start-msg.ok{color:#2f7d4f}',
      '#startCustomPanel .start-foot{flex:0 0 auto;display:flex;gap:8px;padding:8px 12px;border-top:1px solid var(--line-soft,#e6ded0)}',
      '#startCustomPanel .start-foot .btn{flex:1 1 0}',
      '#startCustomPanel .start-trait-val{font-variant-numeric:tabular-nums;font-size:12px;color:var(--ink-3,#857b6d)}',
      // ① 国家名单
      '#startCustomPanel .start-section{display:flex;flex-direction:column;gap:6px;border-top:1px dashed var(--line-soft,#e6ded0);padding-top:8px;min-width:0}',
      '#startCustomPanel .start-section:first-child{border-top:0;padding-top:0}',
      '#startCustomPanel .start-section-head{display:flex;align-items:baseline;gap:8px;font-size:12px;font-weight:600;color:var(--ink-2,#5c544a)}',
      '#startCustomPanel .start-section-head .hint{font-weight:400;font-size:11px;color:var(--ink-3,#857b6d);flex:1 1 auto;text-align:right}',
      '#startCustomPanel .start-hint{font-size:11px;line-height:1.5;color:var(--ink-3,#857b6d);white-space:pre-wrap}',
      '#startCustomPanel .start-kit{display:flex;gap:8px;flex-wrap:wrap}',
      '#startCustomPanel .start-kit .btn{flex:1 1 0}',
      '#startCustomPanel .start-nations{display:flex;flex-direction:column;gap:3px;max-height:210px;overflow:auto;padding-right:2px}',
      '#startCustomPanel .start-nation-row{display:flex;align-items:center;gap:6px;border:1px solid var(--line-soft,#e6ded0);border-radius:6px;padding:3px 6px;background:var(--field,#f6f1e7);font-size:12px;min-width:0}',
      '#startCustomPanel .start-nation-row .swatch{flex:0 0 auto;width:10px;height:10px;border-radius:2px;border:1px solid rgba(0,0,0,.15)}',
      '#startCustomPanel .start-nation-row .nm{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#startCustomPanel .start-nation-row .meta{flex:0 0 auto;color:var(--ink-3,#857b6d);font-variant-numeric:tabular-nums}',
      '#startCustomPanel .start-nation-row select{flex:0 0 auto;width:auto;padding:1px 4px;font-size:11px}',
      '#startCustomPanel .start-nation-row .btn-del{flex:0 0 auto;border:0;background:transparent;color:#b23a2e;cursor:pointer;font-size:13px;padding:1px 3px;border-radius:4px}',
      '#startCustomPanel .start-nation-row .btn-del:hover{background:rgba(178,58,46,.12)}',
      '#startCustomPanel .start-nation-row.removed{opacity:.55;text-decoration:line-through}',
      '#startCustomPanel .start-nation-row.removed .btn-del{text-decoration:none}',
      '#startCustomPanel .start-nation-row.auto-trim{border-style:dashed;border-color:#c98a2e;background:rgba(201,138,46,.08)}',
      '#startCustomPanel .start-nation-row.auto-trim .nm::after{content:"（数量调整:将自动删除）";color:#a36f1d;font-size:11px}',
      '#startCustomPanel .start-add{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '#startCustomPanel .start-add input[type=range]{flex:1 1 60px;width:auto}',
      '#startCustomPanel .start-add .hint{font-size:11px;color:var(--ink-3,#857b6d);flex:1 1 100%}',
      '#startCustomPanel .start-confirm{border:1px solid #c98a2e;border-radius:6px;background:rgba(201,138,46,.1);padding:6px 8px;display:flex;flex-direction:column;gap:6px}',
      '#startCustomPanel .start-confirm[hidden]{display:none!important}',
      '#startCustomPanel .start-confirm .msg{font-size:12px;line-height:1.5;color:#7a5212;white-space:pre-wrap}',
      '#startCustomPanel .start-confirm .btns{display:flex;gap:6px}',
      '#startCustomPanel .start-confirm .btns .btn{flex:1 1 0;font-size:12px;padding:3px 6px}',
      // ② 连续点选:已选州盒子
      '#startCustomPanel .start-regions{display:flex;flex-direction:column;gap:4px;border:1px solid #7fc7dd;border-radius:6px;background:rgba(64,196,236,.08);padding:5px 7px}',
      '#startCustomPanel .start-regions[hidden]{display:none!important}',
      '#startCustomPanel .start-regions-head{display:flex;align-items:center;gap:6px;font-size:12px;color:#1a6e86}',
      '#startCustomPanel .start-regions-head .btn{margin-left:auto;font-size:11px;padding:1px 6px}',
      '#startCustomPanel .start-region-chips{display:flex;flex-wrap:wrap;gap:3px;max-height:72px;overflow:auto}',
      '#startCustomPanel .start-region-chip{display:inline-flex;align-items:center;gap:2px;font-size:11px;line-height:1.4;padding:0 5px;border-radius:9px;background:rgba(40,196,236,.2);color:#12566b;border:1px solid rgba(20,140,170,.35);white-space:nowrap}',
      '#startCustomPanel .start-region-chip button{border:0;background:transparent;color:#12566b;cursor:pointer;font-size:12px;padding:0 1px;line-height:1}'
    ].join('\n');
    document.head.appendChild(style);
  }

  // ── 面板 DOM ───────────────────────────────────────────────────────────────
  function buildPanel() {
    if ($(PANEL_ID)) return;
    var host = document.getElementById('mapWrap') || document.getElementById('stage') || document.body;
    var wrap = document.createElement('aside');
    wrap.id = PANEL_ID;
    wrap.className = 'panel start-panel';
    wrap.hidden = true;
    wrap.innerHTML = [
      '<div class="panel-head">',
      '  <div>',
      '    <div class="panel-title">✦ 君主开局</div>',
      '    <div class="panel-sub" id="startSub">第一回合推演前定制</div>',
      '  </div>',
      '  <button class="btn ghost" id="startClose" type="button" title="关闭">✕</button>',
      '</div>',
      '<div class="params-body start-panel-body">',
      '  <div class="start-section">',
      '    <div class="start-section-head"><span>① 国家名单</span><span class="hint" id="startSetupState"></span></div>',
      '    <label class="field"><span>国家数量 <b id="startCountVal">0</b></span>',
      '      <input id="startCount" type="range" min="3" max="30" step="1" value="3">',
      '    </label>',
      '    <div class="start-hint" id="startCountHint"></div>',
      '    <div class="start-nations" id="startNationRows"></div>',
      '    <div class="start-add">',
      '      <button class="btn ghost" id="startAddNation" type="button">＋ 新增国家</button>',
      '      <span class="start-trait-val">州数 <b id="startAddSizeVal">6</b></span>',
      '      <input id="startAddSize" type="range" min="3" max="20" step="1" value="6">',
      '      <button class="btn ghost" id="startAddPick" type="button">📍 落点</button>',
      '    </div>',
      '    <div class="start-hint" id="startAddAtLabel">落点未选(默认落在最大的无主州)</div>',
      '    <div class="start-confirm" id="startConfirm" hidden>',
      '      <div class="msg" id="startConfirmMsg"></div>',
      '      <div class="btns">',
      '        <button class="btn primary" id="startConfirmYes" type="button">确认删除</button>',
      '        <button class="btn ghost" id="startConfirmNo" type="button">取消</button>',
      '      </div>',
      '    </div>',
      '  </div>',
      '  <div class="start-section">',
      '    <div class="start-section-head"><span>② 君主定制</span><span class="hint" id="startCustomState"></span></div>',
      '    <label class="field"><span>君主国家</span><select id="startNation"></select></label>',
      '    <div class="start-coord">',
      '      <button class="btn" id="startPick" type="button">🗺 在地图上选疆域</button>',
      '      <span class="hint" id="startAtLabel">未选位置(默认落在最大的无主州)</span>',
      '    </div>',
      '    <div class="start-hint">点国家高亮全部州并飞首都;点州选中/取消;Esc 退出</div>',
      '    <div class="start-regions" id="startRegionBox" hidden>',
      '      <div class="start-regions-head"><span>已选 <b id="startRegionCount">0</b> 州</span><button class="btn ghost" id="startRegionClear" type="button">清空</button></div>',
      '      <div class="start-region-chips" id="startRegionChips"></div>',
      '    </div>',
      '    <label class="field"><span>初始州数 <b id="startSizeVal">8</b></span>',
      '      <input id="startSize" type="range" min="3" max="40" step="1" value="8">',
      '    </label>',
      '    <label class="field check"><input id="startAutoCard" type="checkbox" checked><span>自动生成角色卡</span></label>',
      '  </div>',
      '  <fieldset id="startCardFields" class="start-card-fields" disabled>',
      '    <label class="field"><span>君主名(留空 = 自动)</span><input id="startName" type="text" maxlength="16" placeholder="例如:萧景桓"></label>',
      '    <label class="field"><span>君主生平(≤600 字,可留空)</span><textarea id="startBiography" maxlength="600" placeholder="例如:少年从军、极好战,崇尚武力,梦想征服四方…(可点「从生平推断性格」)"></textarea></label>',
      '    <div class="row">',
      '      <label class="field"><span>谨慎 <b class="start-trait-val" id="startCautionVal">50</b></span><input id="startCaution" type="range" min="0" max="100" value="50"></label>',
      '      <label class="field"><span>野心 <b class="start-trait-val" id="startAmbitionVal">50</b></span><input id="startAmbition" type="range" min="0" max="100" value="50"></label>',
      '    </div>',
      '    <div class="row">',
      '      <label class="field"><span>荣誉 <b class="start-trait-val" id="startHonorVal">50</b></span><input id="startHonor" type="range" min="0" max="100" value="50"></label>',
      '      <label class="field"><span>贪欲 <b class="start-trait-val" id="startGreedVal">50</b></span><input id="startGreed" type="range" min="0" max="100" value="50"></label>',
      '    </div>',
      '    <div class="row">',
      '      <label class="field"><span>军事</span><select id="startWar"><option value="0">低</option><option value="1">中</option><option value="2">高</option></select></label>',
      '      <label class="field"><span>经济</span><select id="startEconomy"><option value="0">低</option><option value="1">中</option><option value="2">高</option></select></label>',
      '    </div>',
      '    <div class="row">',
      '      <label class="field"><span>权谋</span><select id="startIntrigue"><option value="0">低</option><option value="1">中</option><option value="2">高</option></select></label>',
      '      <label class="field"><span>治理</span><select id="startAdmin"><option value="0">低</option><option value="1">中</option><option value="2">高</option></select></label>',
      '    </div>',
      '    <div class="row">',
      '      <label class="field"><span>战争偏好</span><select id="startPrefWar"><option value="avoid">避战</option><option value="opportunist">见机行事</option><option value="seek">主动求战</option></select></label>',
      '      <label class="field"><span>经济偏好</span><select id="startPrefEconomy"><option value="develop">发展</option><option value="trade">贸易</option></select></label>',
      '    </div>',
      '    <label class="field"><span>外交偏好</span><select id="startPrefDiplomacy"><option value="honor">重信义</option><option value="pragmatic">讲实利</option></select></label>',
      '    <label class="field"><span>人物小传(可留空)</span><textarea id="startPersona" maxlength="200" placeholder="这个君主是什么样的人…"></textarea></label>',
      '    <div class="row">',
      '      <label class="field"><span>种族(自由文本,占位)</span><input id="startRace" type="text" maxlength="40" placeholder="例如:人类 / 精灵 / 矮人"></label>',
      '      <label class="field check"><input id="startRaceSystem" type="checkbox"><span>启用种族系统</span></label>',
      '    </div>',
      '    <div class="row">',
      '      <label class="field"><span>寿命(岁)</span><input id="startLifespan" type="number" min="20" max="200" step="1" value="90" disabled></label>',
      '      <div class="start-hint" id="startRaceHint">种族系统未启用:寿命一律 90 岁</div>',
      '    </div>',
      '    <div class="start-kit">',
      '      <button class="btn ghost" id="startInfer" type="button">🔮 从生平推断性格</button>',
      '      <button class="btn ghost" id="startRandom" type="button">🎲 随机性格</button>',
      '    </div>',
      '  </fieldset>',
      '  <div class="start-msg" id="startMsg"></div>',
      '</div>',
      '<div class="start-foot">',
      '  <button class="btn primary" id="startApply" type="button">应用开局</button>',
      '  <button class="btn ghost" id="startCancel" type="button">取消</button>',
      '</div>'
    ].join('');
    host.appendChild(wrap);

    el('startClose').addEventListener('click', close);
    el('startCancel').addEventListener('click', close);
    el('startApply').addEventListener('click', onApply);
    el('startPick').addEventListener('click', toggleRegionPicker);
    el('startAddPick').addEventListener('click', function () { onPick('add'); });
    el('startRegionClear').addEventListener('click', clearRegionSelection);
    el('startRegionChips').addEventListener('click', onRegionChipsClick);
    el('startRandom').addEventListener('click', randomizeCard);
    el('startInfer').addEventListener('click', inferFromBiography);
    el('startRaceSystem').addEventListener('change', function () {
      syncRaceFields();
      customDirty = true;
    });
    el('startRace').addEventListener('input', updateRaceHint);
    el('startNation').addEventListener('change', function () {
      customDirty = true;
      onNationChanged();
    });
    el('startSize').addEventListener('input', function () {
      customDirty = true;
      el('startSizeVal').textContent = String(el('startSize').value);
    });
    el('startAutoCard').addEventListener('change', function () {
      customDirty = true;
      el('startCardFields').disabled = el('startAutoCard').checked;
    });
    el('startCardFields').addEventListener('input', function () { customDirty = true; });
    el('startCardFields').addEventListener('change', function () { customDirty = true; });
    var traits = [['startCaution', 'startCautionVal'], ['startAmbition', 'startAmbitionVal'], ['startHonor', 'startHonorVal'], ['startGreed', 'startGreedVal']];
    traits.forEach(function (pair) {
      el(pair[0]).addEventListener('input', function () {
        el(pair[1]).textContent = String(el(pair[0]).value);
      });
    });
    // ① 国家数量 / 增删 / 控制方式
    el('startCount').addEventListener('input', onCountInput);
    el('startAddSize').addEventListener('input', function () {
      el('startAddSizeVal').textContent = String(el('startAddSize').value);
    });
    el('startAddNation').addEventListener('click', onAddNation);
    el('startNationRows').addEventListener('click', onRowsClick);
    el('startNationRows').addEventListener('change', onRowsChange);
    el('startConfirmYes').addEventListener('click', function () {
      var act = confirmAction;
      hideConfirm();
      if (typeof act === 'function') act();
    });
    el('startConfirmNo').addEventListener('click', hideConfirm);
  }

  // ── 通用请求 ───────────────────────────────────────────────────────────────
  function apiCall(path, body) {
    if (cfg && typeof cfg.api === 'function') return cfg.api(path, body);
    var opts = body === undefined ? undefined : {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    };
    return fetch(path, opts).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
        return data;
      });
    });
  }

  /** start-setup 要能读到 409 里的 needConfirm,直接用 fetch 而不是 cfg.api */
  function setupCall(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || ('HTTP ' + res.status));
          err.needConfirm = data && data.needConfirm;
          throw err;
        }
        return data;
      });
    });
  }

  // ── ② 君主定制:国家列表 ───────────────────────────────────────────────────
  function fallbackNations() {
    var st = cfg && cfg.state;
    var list = st && Array.isArray(st.polities) ? st.polities : [];
    return list.map(function (p) {
      var cap = p.capitalPoint || p.capital || null; // 后端 stateView 的 capital 是城 id,这里只用来显示
      return {
        polityId: p.id,
        name: p.name,
        color: '#999999',
        capital: cap && typeof cap === 'object' && typeof cap.x === 'number' ? cap : null,
        regions: p.size || 0,
        seatName: p.capitalName || null
      };
    });
  }

  function loadNations() {
    var sid = cfg.sessionId;
    var req = apiCall('/api/start/nations?sessionId=' + encodeURIComponent(sid));
    return Promise.resolve(req).then(function (data) {
      var list = data && Array.isArray(data.nations) ? data.nations : null;
      setNations(list || fallbackNations());
    }).catch(function () {
      setNations(fallbackNations());
    });
  }

  function setNations(list) {
    nations = list || [];
    var select = el('startNation');
    var keep = select.value;
    select.innerHTML = '';
    var blank = document.createElement('option');
    blank.value = 'new';
    blank.textContent = '＋ 新建国家(在地图上点选)';
    select.appendChild(blank);
    nations.forEach(function (n) {
      var opt = document.createElement('option');
      opt.value = String(n.polityId);
      opt.textContent = n.name + ' · ' + n.regions + ' 州' + (n.seatName ? ' · ' + n.seatName : '');
      select.appendChild(opt);
    });
    if (keep && select.querySelector('option[value="' + keep + '"]')) select.value = keep;
    onNationChanged();
  }

  function selectedNation() {
    var v = el('startNation').value;
    if (!v || v === 'new') return null;
    var id = Number(v);
    for (var i = 0; i < nations.length; i++) if (nations[i].polityId === id) return nations[i];
    return null;
  }

  function onNationChanged() {
    var n = selectedNation();
    var size = el('startSize');
    if (n) {
      var v = Math.max(3, Math.min(40, n.regions || 8));
      size.value = String(v);
      size.disabled = false;
      el('startSizeVal').textContent = String(v);
      pickedAt = null;
      // 下拉选国 = 高亮该国并飞首都(和地图点选保持一致);从点选回调同步过来的不再重复飞
      if (!syncingFromPicker && regionPickerOn && window.CivRegionPicker &&
          n.polityId !== regionHighlight) {
        regionHighlight = n.polityId;
        window.CivRegionPicker.highlightPolity(n.polityId, true);
      }
    } else {
      size.disabled = false;
    }
    renderPickButton();
  }

  /** ② 点选按钮与说明文字(随已选州数变化) */
  function renderPickButton() {
    var btn = $('startPick');
    if (!btn) return;
    btn.disabled = false;
    btn.textContent = regionPickerOn ? '✕ 退出选疆域'
      : (regionSel.length ? '🗺 继续选疆域(' + regionSel.length + ' 州)' : '🗺 在地图上选疆域');
    var label = $('startAtLabel');
    if (!label) return;
    if (regionSel.length) {
      label.textContent = '已选 ' + regionSel.length + ' 州(提交时按这些州精确设置,忽略州数/落点)';
    } else if (selectedNation()) {
      label.textContent = '现有国家:按国都位置;要改疆域请点「在地图上选疆域」';
    } else {
      label.textContent = pickedAt
        ? '已选位置:x=' + Math.round(pickedAt.x) + ', y=' + Math.round(pickedAt.y)
        : '未选位置(默认落在最大的无主州)';
    }
  }

  // ── 地图点选(cfg.pick 回调) ───────────────────────────────────────────────
  function onPick(target) {
    if (!cfg || typeof cfg.pick !== 'function') {
      toastMsg('这个页面没有提供地图点选能力,请手动填坐标或直接应用', true);
      return;
    }
    toastMsg(target === 'add' ? '在地图上点选新国家的落点…' : '在地图上点选君主的起始位置…');
    cfg.pick(function (pt) {
      if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number') return;
      if (target === 'add') {
        addAt = { x: pt.x, y: pt.y };
        el('startAddAtLabel').textContent = '落点:已选 x=' + Math.round(pt.x) + ', y=' + Math.round(pt.y);
        toastMsg('新国家落点已选(继续调州数或再加一个)');
      } else {
        pickedAt = { x: pt.x, y: pt.y };
        customDirty = true;
        el('startAtLabel').textContent = '已选位置:x=' + Math.round(pt.x) + ', y=' + Math.round(pt.y);
        toastMsg('已选位置(可以继续改州数/角色卡)');
      }
      if (typeof externalPick === 'function') externalPick(pickedAt || addAt);
    });
  }

  function pickAt(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number') return;
    pickedAt = { x: x, y: y };
    customDirty = true;
    el('startAtLabel').textContent = '已选位置:x=' + Math.round(x) + ', y=' + Math.round(y);
  }

  function bindPick(cb) {
    externalPick = typeof cb === 'function' ? cb : null;
  }

  // ── ② 疆域连续点选(CivRegionPicker 覆盖层) ───────────────────────────────
  function regionName(region) {
    var atlas = window.CivRegionAtlas;
    var m = atlas && atlas.meta ? atlas.meta(region) : null;
    return m && m.name ? m.name : ('州 #' + (region + 1));
  }

  function renderRegionBox() {
    var box = $('startRegionBox');
    if (!box) return;
    box.hidden = regionSel.length === 0;
    var count = $('startRegionCount');
    if (count) count.textContent = String(regionSel.length);
    var chips = $('startRegionChips');
    if (chips) {
      chips.innerHTML = regionSel.map(function (r) {
        return '<span class="start-region-chip">' + esc(regionName(r)) +
          '<button type="button" data-region-remove="' + r + '" title="移除这个州">×</button></span>';
      }).join('');
    }
    renderPickButton();
  }

  function syncNationSelect(pid) {
    var select = $('startNation');
    if (!select || pid == null) return;
    var v = String(pid);
    if (select.value === v) return;
    if (!select.querySelector('option[value="' + v + '"]')) return;
    select.value = v;
    syncingFromPicker = true;
    try { onNationChanged(); } finally { syncingFromPicker = false; }
  }

  function onPickerSelection(sel, hlPid) {
    regionSel = (sel || []).slice();
    regionHighlight = hlPid == null ? null : hlPid;
    customDirty = true;
    renderRegionBox();
    if (hlPid != null) syncNationSelect(hlPid);
    if (typeof externalPick === 'function') externalPick(null);
  }

  function onRegionChipsClick(e) {
    var t = e.target && e.target.closest ? e.target.closest('button[data-region-remove]') : null;
    if (!t) return;
    var r = Number(t.getAttribute('data-region-remove'));
    var idx = regionSel.indexOf(r);
    if (idx < 0) return;
    regionSel.splice(idx, 1);
    customDirty = true;
    renderRegionBox();
    if (window.CivRegionPicker && window.CivRegionPicker.isActive()) {
      window.CivRegionPicker.setSelection(regionSel);
    }
  }

  function clearRegionSelection() {
    regionSel = [];
    regionHighlight = null;
    customDirty = true;
    renderRegionBox();
    if (window.CivRegionPicker && window.CivRegionPicker.isActive()) {
      window.CivRegionPicker.setSelection([]);
    }
  }

  function nationPickerData() {
    return nations.map(function (n) {
      return { polityId: n.polityId, name: n.name, color: n.color, capital: n.capital };
    });
  }

  function openRegionPicker() {
    if (!window.CivRegionPicker) {
      toastMsg('选疆域模块没加载:刷新页面再试', true);
      return;
    }
    if (!nations.length) {
      loadNations().then(openRegionPicker);
      return;
    }
    if (regionPickerOn) return;
    var current = selectedNation();
    regionPickerOn = true;
    var ok = window.CivRegionPicker.open({
      nations: nationPickerData(),
      api: cfg && cfg.api,
      sessionId: cfg && cfg.sessionId,
      initialPolityId: current ? current.polityId : regionHighlight,
      initialSelection: regionSel,
      onSelection: onPickerSelection,
      onNation: function (pid) { syncNationSelect(pid); },
      onExit: function () {
        regionPickerOn = false;
        renderPickButton();
        renderRegionBox();
      }
    });
    if (!ok) {
      regionPickerOn = false;
      toastMsg('地图还没准备好,稍后再试点选', true);
      return;
    }
    renderPickButton();
    toastMsg('点国家高亮全部州并飞首都;点州选中/取消;Esc 退出');
  }

  /** 关闭点选覆盖层;clearSelection=true 时同时清空已选州 */
  function closeRegionPicker(clearSelection) {
    if (window.CivRegionPicker && window.CivRegionPicker.isActive()) window.CivRegionPicker.close();
    regionPickerOn = false;
    if (clearSelection) {
      regionSel = [];
      regionHighlight = null;
    }
    renderRegionBox();
  }

  function toggleRegionPicker() {
    if (regionPickerOn) closeRegionPicker(false);
    else openRegionPicker();
  }

  // ── ① 开局国家设置:加载 + 预览 ────────────────────────────────────────────
  function loadConfig() {
    var sid = cfg.sessionId;
    return apiCall('/api/start/config?sessionId=' + encodeURIComponent(sid))
      .then(function (data) {
        if (!data || !Array.isArray(data.nations)) throw new Error('bad config');
        setSetupInfo(data);
      })
      .catch(function () {
        setSetupInfo(null);
      });
  }

  function setSetupInfo(data) {
    setupInfo = data;
    removedIds = {};
    controls = {};
    initialControls = {};
    addedNations = [];
    addAt = null;
    if (data) {
      data.nations.forEach(function (n) {
        var c = n.control === 'program' ? 'program' : 'ai';
        controls[n.polityId] = c;
        initialControls[n.polityId] = c;
      });
      countriesLocked = data.canSetup === false;
      countTarget = effectiveCount();
      countBase = countTarget;
      var slider = el('startCount');
      slider.min = String(data.min || 3);
      slider.max = String(data.max || 30);
      slider.value = String(countTarget);
      el('startAddSizeVal').textContent = String(el('startAddSize').value);
      el('startSetupState').textContent = countriesLocked ? '已应用(每局一次)' : '';
    } else {
      countriesLocked = true;
      el('startSetupState').textContent = '这个版本没有开局国家设置接口';
    }
    el('startAddAtLabel').textContent = '落点未选(默认落在最大的无主州)';
    renderSetup();
    renderCustomState();
  }

  function liveNations() {
    if (!setupInfo) return [];
    return setupInfo.nations.filter(function (n) { return !removedIds[n.polityId]; });
  }

  function effectiveCount() {
    if (!setupInfo) return 0;
    return liveNations().length + addedNations.length;
  }

  function sortedBySizeAsc(list) {
    return list.slice().sort(function (a, b) {
      return (a.regions || 0) - (b.regions || 0) || b.polityId - a.polityId;
    });
  }

  /** 预览:按数量目标,哪些国家会被自动删掉(后端删州数最少的) */
  function autoTrimIds() {
    var ids = {};
    if (!setupInfo) return ids;
    var diff = effectiveCount() - countTarget;
    if (diff <= 0) return ids;
    var victims = sortedBySizeAsc(liveNations()).slice(0, diff);
    victims.forEach(function (n) { ids[n.polityId] = true; });
    return ids;
  }

  function countHint() {
    if (!setupInfo) return '';
    var diff = countTarget - effectiveCount();
    if (removedIdsHasAny() || addedNations.length) {
      var manual = [];
      if (removedIdsHasAny()) manual.push('手动删除 ' + Object.keys(removedIds).length + ' 国');
      if (addedNations.length) manual.push('手动新建 ' + addedNations.length + ' 国');
      var base = '当前预览:' + effectiveCount() + ' 国(' + manual.join('、') + ')';
      if (diff < 0) return base + '\n数量目标:' + countTarget + ' 国,应用时会再自动删 ' + (-diff) + ' 个州数最少的国家';
      if (diff > 0) return base + '\n数量目标:' + countTarget + ' 国,应用时会再自动补建 ' + diff + ' 个国家(默认 6 州)';
      return base + '\n数量目标:' + countTarget + ' 国,数量一致';
    }
    if (diff < 0) return '应用时会自动删掉 ' + (-diff) + ' 个州数最少的国家(' + countTarget + ' 国)';
    if (diff > 0) return '应用时会自动补建 ' + diff + ' 个国家(默认 6 州,' + countTarget + ' 国)';
    return '国家数量不变(' + countTarget + ' 国)';
  }

  function removedIdsHasAny() {
    for (var k in removedIds) if (Object.prototype.hasOwnProperty.call(removedIds, k)) return true;
    return false;
  }

  function renderSetup() {
    var slider = el('startCount');
    el('startCountVal').textContent = String(countTarget || 0);
    slider.disabled = countriesLocked || !setupInfo;
    el('startAddNation').disabled = countriesLocked;
    el('startAddPick').disabled = countriesLocked;
    el('startAddSize').disabled = countriesLocked;
    el('startCountHint').textContent = countriesLocked ? '' : countHint();
    var box = el('startNationRows');
    if (!setupInfo) { box.innerHTML = ''; return; }
    var autos = autoTrimIds();
    var rows = [];
    setupInfo.nations.forEach(function (n) {
      var isRemoved = !!removedIds[n.polityId];
      var isAuto = !isRemoved && !!autos[n.polityId];
      var cls = 'start-nation-row' + (isRemoved ? ' removed' : '') + (isAuto ? ' auto-trim' : '');
      var control = controls[n.polityId] === 'program' ? 'program' : 'ai';
      rows.push(
        '<div class="' + cls + '" data-id="' + n.polityId + '">' +
        '<span class="swatch" style="background:' + esc(n.color || '#999999') + '"></span>' +
        '<span class="nm" title="' + esc(n.name + (n.seatName ? ' · 国都 ' + n.seatName : '')) + '">' + esc(n.name) + '</span>' +
        '<span class="meta">' + (n.regions || 0) + ' 州</span>' +
        (isRemoved
          ? '<button class="btn-del" type="button" data-act="undo" title="撤销删除">↺</button>'
          : '<select data-act="control" title="控制方式"' + (countriesLocked ? ' disabled' : '') + '>' +
            '<option value="ai"' + (control === 'ai' ? ' selected' : '') + '>AI 君主</option>' +
            '<option value="program"' + (control === 'program' ? ' selected' : '') + '>程序自动</option>' +
            '</select>' +
            '<button class="btn-del" type="button" data-act="del" title="删除这个国家(州变无主)"' + (countriesLocked ? ' disabled' : '') + '>✕</button>') +
        '</div>'
      );
    });
    addedNations.forEach(function (a, i) {
      rows.push(
        '<div class="start-nation-row auto-trim" data-added="' + i + '">' +
        '<span class="swatch" style="background:#2f7d4f"></span>' +
        '<span class="nm">待新建国家 #' + (i + 1) + '</span>' +
        '<span class="meta">' + a.size + ' 州' + (a.at ? ' · 已选落点' : '') + '</span>' +
        '<button class="btn-del" type="button" data-act="undo-add" title="撤销新建"' + (countriesLocked ? ' disabled' : '') + '>↺</button>' +
        '</div>'
      );
    });
    if (!setupInfo.nations.length && !addedNations.length) {
      rows.push('<div class="start-hint">这个会话在当前年份没有在世的国。</div>');
    }
    box.innerHTML = rows.join('');
  }

  function onCountInput() {
    countTarget = Number(el('startCount').value) || 3;
    renderSetup();
  }

  function onRowsClick(ev) {
    var target = ev.target;
    if (!target || !target.getAttribute) return;
    var act = target.getAttribute('data-act');
    if (!act) return;
    var row = target.parentNode;
    while (row && row.getAttribute && !row.getAttribute('data-id') && !row.getAttribute('data-added')) row = row.parentNode;
    if (!row) return;
    if (act === 'del') {
      var id = Number(row.getAttribute('data-id'));
      var n = null;
      setupInfo.nations.forEach(function (x) { if (x.polityId === id) n = x; });
      if (!n) return;
      confirmDelete(n);
    } else if (act === 'undo') {
      delete removedIds[Number(row.getAttribute('data-id'))];
      renderSetup();
    } else if (act === 'undo-add') {
      addedNations.splice(Number(row.getAttribute('data-added')), 1);
      renderSetup();
    }
  }

  function onRowsChange(ev) {
    var target = ev.target;
    if (!target || target.getAttribute('data-act') !== 'control') return;
    var row = target.parentNode;
    while (row && row.getAttribute && !row.getAttribute('data-id')) row = row.parentNode;
    if (!row) return;
    controls[Number(row.getAttribute('data-id'))] = target.value === 'program' ? 'program' : 'ai';
  }

  // ── ① 删除确认 ────────────────────────────────────────────────────────────
  function confirmDelete(n) {
    var msg = (n.regions || 0) <= 1
      ? '「' + n.name + '」该国家只有最后一个州，删除将移除整个国家，是否继续？'
      : '删除「' + n.name + '」:' + (n.regions || 0) + ' 个州会变成无主,是否继续？';
    confirmAction = function () {
      removedIds[n.polityId] = true;
      renderSetup();
      toastMsg('已标记删除:「' + n.name + '」(点「应用开局」后生效)');
    };
    el('startConfirmMsg').textContent = msg;
    el('startConfirm').hidden = false;
  }

  function hideConfirm() {
    confirmAction = null;
    var box = $('startConfirm');
    if (box) box.hidden = true;
  }

  function onAddNation() {
    if (!setupInfo || countriesLocked) return;
    addedNations.push({
      size: Math.max(3, Math.min(20, Number(el('startAddSize').value) || 6)),
      at: addAt ? { x: addAt.x, y: addAt.y } : undefined
    });
    addAt = null;
    el('startAddAtLabel').textContent = '落点未选(默认落在最大的无主州)';
    renderSetup();
    toastMsg('已加入待新建国家(' + addedNations.length + ' 个待新建,点「应用开局」后生效)');
  }

  function renderCustomState() {
    var box = $('startCustomState');
    if (!box) return;
    var st = cfg && cfg.state;
    var applied = st && st.customStart;
    box.textContent = applied ? '已定制:' + applied.polityId : '';
    if (applied) fillCardFromState();
  }

  // ── 角色卡 ────────────────────────────────────────────────────────────────
  function num(id) {
    return Number(el(id).value) || 0;
  }

  function collectCard() {
    var raceSystem = el('startRaceSystem').checked;
    var life = Math.round(Number(el('startLifespan').value) || 90);
    return {
      name: el('startName').value.trim(),
      persona: el('startPersona').value.trim(),
      biography: el('startBiography').value.trim(),
      race: el('startRace').value.trim(),
      raceSystem: raceSystem,
      lifespan: raceSystem ? Math.max(20, Math.min(200, life)) : 90,
      traits: {
        caution: num('startCaution'),
        ambition: num('startAmbition'),
        honor: num('startHonor'),
        greed: num('startGreed')
      },
      competence: {
        war: num('startWar'),
        economy: num('startEconomy'),
        intrigue: num('startIntrigue'),
        admin: num('startAdmin')
      },
      preferences: {
        war: el('startPrefWar').value,
        economy: el('startPrefEconomy').value,
        diplomacy: el('startPrefDiplomacy').value
      }
    };
  }

  /** 收集 ② 君主定制的请求 body(不含 sessionId,由调用方补) */
  function collect() {
    var n = selectedNation();
    var autoCard = el('startAutoCard').checked;
    var body = { autoCard: autoCard };
    if (n) body.polityId = n.polityId;
    if (regionSel.length) {
      // 连续点选:按所选州精确设置(服务端 regionIds 优先于 size/at)
      body.regionIds = regionSel.slice();
    } else {
      body.size = Number(el('startSize').value);
      if (!n && pickedAt) body.at = { x: pickedAt.x, y: pickedAt.y };
      if (!n && autoCard) {
        // 新国自动卡:后端用占位名;仍然允许给一个名字
        var name = el('startName').value.trim();
        if (name) body.card = { name: name };
      }
    }
    if (!autoCard) body.card = collectCard();
    return body;
  }

  function randomizeCard() {
    customDirty = true;
    el('startAutoCard').checked = false;
    el('startCardFields').disabled = false;
    var rnd = function (lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); };
    el('startCaution').value = String(rnd(20, 85));
    el('startAmbition').value = String(rnd(15, 90));
    el('startHonor').value = String(rnd(15, 90));
    el('startGreed').value = String(rnd(15, 90));
    ['startCaution', 'startAmbition', 'startHonor', 'startGreed'].forEach(function (id) {
      el(id).dispatchEvent(new Event('input', { bubbles: true }));
    });
    el('startWar').value = String(rnd(0, 2));
    el('startEconomy').value = String(rnd(0, 2));
    el('startIntrigue').value = String(rnd(0, 2));
    el('startAdmin').value = String(rnd(0, 2));
    el('startPrefWar').value = ['avoid', 'opportunist', 'seek'][rnd(0, 2)];
    el('startPrefEconomy').value = rnd(0, 1) ? 'trade' : 'develop';
    el('startPrefDiplomacy').value = rnd(0, 1) ? 'honor' : 'pragmatic';
  }

  /** 种族/寿命提示:未启用种族系统或种族为空时,寿命一律按 90 岁 */
  function updateRaceHint() {
    var box = $('startRaceHint');
    if (!box) return;
    var race = el('startRace') ? el('startRace').value.trim() : '';
    if (!el('startRaceSystem').checked) {
      box.textContent = '种族系统未启用:寿命一律 90 岁';
    } else if (!race) {
      box.textContent = '未填写种族，将按默认寿命 90 岁';
    } else {
      box.textContent = '种族「' + race + '」:寿命按下面填的岁数';
    }
  }

  /** 启用种族系统才允许改寿命;关掉时固定回 90 */
  function syncRaceFields() {
    var on = el('startRaceSystem').checked;
    el('startLifespan').disabled = !on;
    if (!on) el('startLifespan').value = '90';
    updateRaceHint();
  }

  /** 把推断结果填进 sliders / selects(仍是可手改的本地预览) */
  function fillCardFields(r) {
    var traits = r && r.traits ? r.traits : {};
    var comp = r && r.competence ? r.competence : {};
    var prefs = r && r.preferences ? r.preferences : {};
    el('startAutoCard').checked = false;
    el('startCardFields').disabled = false;
    [['startCaution', 'caution'], ['startAmbition', 'ambition'], ['startHonor', 'honor'], ['startGreed', 'greed']].forEach(function (pair) {
      if (typeof traits[pair[1]] === 'number') {
        el(pair[0]).value = String(Math.max(0, Math.min(100, Math.round(traits[pair[1]]))));
        el(pair[0]).dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    [['startWar', 'war'], ['startEconomy', 'economy'], ['startIntrigue', 'intrigue'], ['startAdmin', 'admin']].forEach(function (pair) {
      if (typeof comp[pair[1]] === 'number') el(pair[0]).value = String(Math.max(0, Math.min(2, Math.round(comp[pair[1]]))));
    });
    if (prefs.war) el('startPrefWar').value = prefs.war;
    if (prefs.economy) el('startPrefEconomy').value = prefs.economy;
    if (prefs.diplomacy) el('startPrefDiplomacy').value = prefs.diplomacy;
  }

  /** 「从生平推断性格」:走 /api/start/infer-card(LLM 可用走 LLM,否则规则) */
  function inferFromBiography() {
    if (busy) return;
    var biography = el('startBiography').value.trim();
    if (!biography) {
      toastMsg('先在「君主生平」里写一两句,再点推断', true);
      return;
    }
    busy = true;
    setBtnBusy(true);
    apiCall('/api/start/infer-card', { sessionId: cfg.sessionId, biography: biography }).then(function (data) {
      var r = data && data.result ? data.result : data;
      if (!r || !r.traits) throw new Error('推断结果不完整');
      fillCardFields(r);
      customDirty = true;
      var src = r.source === 'llm' ? 'LLM' : '关键词规则';
      var warn = r.warnings && r.warnings.length ? '(' + r.warnings[0] + ')' : '';
      toastMsg('已按生平推断性格(' + src + ')' + warn);
    }).catch(function (err) {
      toastMsg('推断失败:' + (err && err.message ? err.message : String(err)), true);
    }).then(function () {
      busy = false;
      setBtnBusy(false);
    });
  }

  /** 应用后从 state.cards 把这张卡回填到面板(姓名/生平/种族/寿命/数值) */
  function fillCardFromState() {
    var st = cfg && cfg.state;
    if (!st || !Array.isArray(st.cards)) return;
    var applied = st.customStart;
    var pid = applied && typeof applied.polityId === 'number' ? applied.polityId : st.playerPolityId;
    if (typeof pid !== 'number') return;
    var card = null;
    for (var i = 0; i < st.cards.length; i++) {
      if (st.cards[i] && st.cards[i].polityId === pid) { card = st.cards[i]; break; }
    }
    if (!card) return;
    el('startAutoCard').checked = false;
    el('startCardFields').disabled = false;
    if (typeof card.name === 'string') el('startName').value = card.name;
    if (typeof card.persona === 'string') el('startPersona').value = card.persona;
    if (typeof card.biography === 'string') el('startBiography').value = card.biography;
    if (typeof card.race === 'string') el('startRace').value = card.race;
    el('startRaceSystem').checked = card.raceSystem === true;
    el('startLifespan').value = String(typeof card.lifespan === 'number' ? card.lifespan : 90);
    syncRaceFields();
    fillCardFields(card);
  }

  // ── 应用 ──────────────────────────────────────────────────────────────────
  /** ① 国家设置请求体;null = 没有要提交的改动 */
  function setupBody(force) {
    if (!setupInfo || countriesLocked) return null;
    var body = { sessionId: cfg.sessionId };
    var dirty = removedIdsHasAny() || addedNations.length > 0;
    if (countTarget !== countBase) {
      body.count = countTarget;
      dirty = true;
    }
    if (removedIdsHasAny()) body.remove = Object.keys(removedIds).map(Number);
    var changedControls = {};
    for (var id in controls) {
      if (!Object.prototype.hasOwnProperty.call(controls, id)) continue;
      if (controls[id] !== initialControls[id]) changedControls[id] = controls[id];
    }
    if (Object.keys(changedControls).length) {
      body.controls = changedControls;
      dirty = true;
    }
    if (addedNations.length) {
      body.nations = addedNations.map(function (a) {
        return a.at ? { at: a.at, size: a.size } : { size: a.size };
      });
    }
    if (force === true) { body.force = true; dirty = true; }
    return dirty ? body : null;
  }

  function applySetup(force) {
    var body = setupBody(force);
    if (!body) return Promise.resolve({ skipped: true });
    toastMsg('正在应用国家设置(删国/新建/控制方式)…');
    return setupCall('/api/session/start-setup', body).then(function (data) {
      var result = (data && data.result) || {};
      var parts = [];
      if (result.removed && result.removed.length) parts.push('删除 ' + result.removed.length + ' 国');
      if (result.added && result.added.length) parts.push('新建 ' + result.added.length + ' 国');
      if (result.resized && result.resized.length) parts.push('调整 ' + result.resized.length + ' 国州数');
      if (result.movedCapitals && result.movedCapitals.length) parts.push('迁都 ' + result.movedCapitals.length + ' 次');
      if (result.warsEnded && result.warsEnded.length) parts.push('结束战争 ' + result.warsEnded.length + ' 场');
      var warns = result.warnings && result.warnings.length ? '\n⚠ ' + result.warnings.join('\n⚠ ') : '';
      countriesLocked = true;
      if (data && data.state && cfg) cfg.state = data.state;
      toastMsg('✓ 国家设置已应用:' + (parts.join(' · ') || '数量 ' + result.count + ' 国') + warns);
      if (cfg && typeof cfg.onApplied === 'function') {
        try {
          var maybe = cfg.onApplied(data);
          if (maybe && typeof maybe.then === 'function') return maybe.catch(function () {});
        } catch (e) { /* 刷新失败不影响已经应用的结果 */ }
      }
      return data;
    }).catch(function (err) {
      if (err && err.needConfirm && Array.isArray(err.needConfirm)) {
        var msg = err.needConfirm.map(function (c) { return c.message || ''; }).join('\n');
        confirmAction = function () { return applySetup(true); };
        el('startConfirmMsg').textContent = msg;
        el('startConfirm').hidden = false;
        toastMsg('有国家只剩最后一个州:确认后才能整个删掉', true);
        throw err;
      }
      toastMsg('国家设置失败:' + (err && err.message ? err.message : String(err)), true);
      throw err;
    });
  }

  function applyCustomStart() {
    var body = collect();
    body.sessionId = cfg.sessionId;
    toastMsg('正在应用君主定制…');
    return apiCall('/api/session/custom-start', body).then(function (data) {
      var result = (data && (data.result || data.start)) || {};
      var summary = '✓ 已应用:' + (result.name || ('P' + result.polityId)) +
        ' · ' + (result.regions != null ? result.regions + ' 州' : '') +
        (result.seatName ? ' · 国都 ' + result.seatName : '') +
        (result.mode === 'new' ? '(新建)' : '');
      var warns = result.warnings && result.warnings.length ? '\n⚠ ' + result.warnings.join('\n⚠ ') : '';
      toastMsg(summary + warns);
      customDirty = false;
      regionSel = [];
      regionHighlight = null;
      if (window.CivRegionPicker && window.CivRegionPicker.isActive()) window.CivRegionPicker.close();
      regionPickerOn = false;
      renderRegionBox();
      if (data && data.state && cfg) cfg.state = data.state;
      if (cfg && typeof cfg.onApplied === 'function') {
        try {
          var maybe = cfg.onApplied(data);
          if (maybe && typeof maybe.then === 'function') return maybe.catch(function () {});
        } catch (e) { /* 刷新失败不影响已经应用的结果 */ }
      }
      return data;
    }).catch(function (err) {
      toastMsg('君主定制失败:' + (err && err.message ? err.message : String(err)), true);
      throw err;
    });
  }

  function onApply() {
    if (!cfg || busy) return;
    var hasSetup = !!setupBody(false);
    if (!hasSetup && !customDirty) {
      toastMsg('没有要应用的改动:先调数量/控制方式/删国/新增国家,或在地图上选疆域、改角色卡');
      return;
    }
    // 提交期间关掉点选覆盖层(已选州保留在 regionSel 里,提交时照样带上)
    if (regionPickerOn) closeRegionPicker(false);
    busy = true;
    setBtnBusy(true);
    hideConfirm();
    var chain = Promise.resolve();
    if (hasSetup) {
      chain = chain.then(function () { return applySetup(false); });
    }
    if (customDirty) {
      chain = chain.then(function () { return applyCustomStart(); });
    }
    chain.then(function () {
      busy = false;
      setBtnBusy(false);
      return Promise.all([loadConfig(), loadNations()]).then(function () {
        renderCustomState();
      });
    }).catch(function () {
      busy = false;
      setBtnBusy(false);
      loadConfig();
    });
  }

  // ── 打开/关闭 ─────────────────────────────────────────────────────────────
  function resetLocalPreview() {
    removedIds = {};
    controls = {};
    initialControls = {};
    addedNations = [];
    addAt = null;
    countTarget = 0;
    countBase = 0;
    countriesLocked = false;
    customDirty = false;
    busy = false;
    hideConfirm();
    el('startAddAtLabel').textContent = '落点未选(默认落在最大的无主州)';
    el('startAddSizeVal').textContent = String(el('startAddSize').value);
  }

  function open(options) {
    if (!options || !options.sessionId) throw new Error('CivStart.open 需要 sessionId');
    cfg = {
      sessionId: options.sessionId,
      state: options.state || null,
      api: options.api,
      pick: options.pick,
      onApplied: options.onApplied
    };
    injectStyle();
    buildPanel();
    pickedAt = null;
    addAt = null;
    regionSel = [];
    regionHighlight = null;
    if (window.CivRegionPicker && window.CivRegionPicker.isActive()) window.CivRegionPicker.close();
    regionPickerOn = false;
    resetLocalPreview();
    el('startMsg').textContent = '';
    el('startMsg').className = 'start-msg';
    el('startSize').value = String(8);
    el('startSizeVal').textContent = '8';
    el('startAutoCard').checked = true;
    el('startCardFields').disabled = true;
    el('startName').value = '';
    el('startPersona').value = '';
    el('startBiography').value = '';
    el('startRace').value = '';
    el('startRaceSystem').checked = false;
    el('startLifespan').value = '90';
    el('startLifespan').disabled = true;
    updateRaceHint();
    renderRegionBox();
    renderPickButton();
    el(PANEL_ID).hidden = false;
    setBtnBusy(false);
    loadConfig();
    loadNations();
  }

  function close() {
    if (regionPickerOn && window.CivRegionPicker && window.CivRegionPicker.isActive()) {
      window.CivRegionPicker.close();
    }
    regionPickerOn = false;
    var panel = $(PANEL_ID);
    if (panel) panel.hidden = true;
  }

  window.CivStart = {
    open: open,
    close: close,
    collect: collect,
    bindPick: bindPick,
    pickAt: pickAt,
    // 调试/测试用:当前本地预览的 start-setup 请求体
    setupBody: setupBody,
    // 调试/测试用:连续点选
    regionSelection: function () { return regionSel.slice(); },
    openRegionPicker: openRegionPicker,
    closeRegionPicker: closeRegionPicker
  };
})();
