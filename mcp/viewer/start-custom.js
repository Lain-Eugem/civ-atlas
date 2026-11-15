/*
 * 君主开局面板(P1.5,实时生效版;viewer 客户端模块,IIFE,不依赖 app.js 内部状态)。
 *
 * 由 mcp/viewer/app.js 的「✦ 开局设置」按钮调用:
 *   window.CivStart.open({ sessionId, state, api, pick, onApplied })
 * - api(path, body):app.js 的 fetch 包装;body 省略是 GET,否则 POST JSON,返回 JSON 对象
 * - pick(cb):进入地图点选模式;用户点地图后回调 cb({ x, y })(世界像素)
 * - onApplied(data):保存成功后的回调,data.state = 最新的 stateView(看板/地图刷新)
 *
 * P1.5 起不再「本地预览 + 应用开局」:任何编辑(删国/控制方式/新建国家/改名/清理飞地/
 * 选疆域/角色卡字段)都会 debounce 180ms 直接提交,成功后用返回的 state 刷新地图与面板。
 * 第一回合前可以反复改;底部「完成」只关闭面板(改动早已即时保存)。
 *
 * 后端路由:
 *   GET  /api/start/config?sessionId=     -> 国家名单(含 regionIds/control/capital 世界像素)、canSetup...
 *   GET  /api/start/auto-name?sessionId= -> { name } 中文随机国名(不撞现有名)
 *   GET  /api/start/nations?sessionId=   -> { nations: StartNation[] }(保留兼容)
 *   POST /api/session/start-setup        -> { ok, result, state }
 *        body: { sessionId, remove?, removeRegions?, controls?, nations?, names?, cleanExclaves?, allowExclaves?, force? }
 *        (历史遗留:playerPolityId 旧前端会带,服务端仍兼容,但界面不再发送、也不表示"玩家国家")
 *        409 = 删到最后一州需要确认,body = { error, needConfirm:[...] },确认后带 force:true 重提
 *   POST /api/session/custom-start       -> { state, result }(编辑该国的角色卡 + 连续点选疆域; polityId = 要改哪一国,m05242 起无"玩家国家")
 *        body: { sessionId, polityId, regionIds?, allowExclaves?, card?, autoCard? }
 */
(function () {
  'use strict';

  var STYLE_ID = 'start-custom-style';
  var PANEL_ID = 'startCustomPanel';
  var DEBOUNCE_MS = 180;

  /** @type {null | {sessionId:string, state:any, api:Function, pick:Function, onApplied:Function}} */
  var cfg = null;
  /** GET /api/start/config 的返回 */
  var setupInfo = null;
  /** 国家名单(GET /api/start/config 的 nations,含 regionIds/control/capital) */
  var nations = [];
  /** 当前选中的国家编号(用于编辑该国的君主卡/疆域) */
  var selectedPid = null;
  /** 新建国家的地图落点(世界像素) */
  var newAt = null;
  /** 新国家是否允许飞地 */
  var allowExclaves = false;
  /** 已选疆域州号(连续点选) */
  var regionSel = [];
  /** 疆域点选覆盖层是否打开 */
  var regionPickerOn = false;
  /** 角色卡有未保存改动 */
  var cardDirty = false;
  /** 疆域选择有未保存改动 */
  var regionDirty = false;
  /** 正在请求中 */
  var busy = false;
  /** 请求期间又有新编辑 */
  var dirtyAgain = false;
  var applyTimer = 0;
  /** 本次 flush 的请求体快照:409 需要确认时用它带 force 重提 */
  var pendingSnapshot = null;
  /** 当前 flush 的 Promise:关闭面板时 await 它,确保改动落盘 */
  var inFlight = null;
  /** 删除确认框里的待执行动作 */
  var confirmAction = null;
  /** bindPick 注册的外部回调 */
  var externalPick = null;
  /** 改名中的国家编号 */
  var editingPid = null;
  /** 上一次保存返回里新建的国家(保存完成后自动选中) */
  var createdPid = null;
  /** 落点模式:鼠标在地图上游走时高亮所在州 */
  var placeMode = false;
  /** 落点模式点击起点(位移 <4px 才算一次点击) */
  var placeDown = null;
  /** 落点预览返回的州号(多州浅蓝高亮) */
  var previewIds = [];
  /** 落点 hover 节流时间戳 */
  var placeMoveAt = 0;
  /** #map 上的落点 hover/点击监听是否已绑定 */
  var placeBound = false;
  /** 防下拉/点选同步时递归 */
  var syncing = false;

  /** 累积的 start-setup 增量 */
  function emptyPending() {
    return { remove: [], removeRegions: [], controls: {}, names: {}, nations: [], cleanExclaves: [] };
  }
  var pending = emptyPending();

  function $(id) { return document.getElementById(id); }
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
  function setBusy(on) {
    var apply = $('startApply');
    if (apply) {
      apply.disabled = on;
      apply.textContent = on ? '保存中…' : '完成';
    }
    var create = $('btnCreate');
    if (create) create.disabled = on || !canEdit();
  }
  function canEdit() {
    // hasCities=false(第 1 年这种还没有城的年份)时只能看/改起始年,不能动国家
    return !!setupInfo && setupInfo.canSetup !== false && setupInfo.hasCities !== false && !busy;
  }

  // ── 样式(自包含,不改 style.css) ──────────────────────────────────────────
  function injectStyle() {
    if ($(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + PANEL_ID + '[hidden]{display:none!important}',
      '#' + PANEL_ID + '{position:absolute;left:var(--gap,12px);top:calc(var(--top-h,0px) + var(--gap,12px)*2);z-index:60;width:416px;max-height:calc(100vh - var(--top-h,0px) - var(--gap,12px)*3);display:flex;flex-direction:column;overflow:hidden;background:var(--panel-solid,#fffdf8);color:var(--ink,#2b2622);border:1px solid var(--line,#d9d2c6);border-radius:var(--r-panel,10px);box-shadow:0 10px 30px rgba(0,0,0,.18)}',
      '#' + PANEL_ID + ' .panel-head{flex:0 0 auto}',
      '#startCustomPanel .start-panel-body{overflow:auto;display:flex;flex-direction:column;gap:9px;padding:9px 12px}',
      '#startCustomPanel .start-section{display:flex;flex-direction:column;gap:6px;border-top:1px dashed var(--line-soft,#e6ded0);padding-top:8px;min-width:0}',
      '#startCustomPanel .start-section:first-child{border-top:0;padding-top:0}',
      '#startCustomPanel .start-section-head{display:flex;align-items:baseline;gap:8px;font-size:12px;font-weight:600;color:var(--ink-2,#5c544a)}',
      '#startCustomPanel .start-section-head .hint{font-weight:400;font-size:11px;color:var(--ink-3,#857b6d);flex:1 1 auto;text-align:right}',
      '#startCustomPanel .start-hint{font-size:11px;line-height:1.5;color:var(--ink-3,#857b6d);white-space:pre-wrap}',
      '#startCustomPanel .start-stats{font-size:12px;color:var(--ink-2,#5c544a);font-variant-numeric:tabular-nums}',
      '#startCustomPanel .start-player{font-size:12px;color:var(--ink-2,#5c544a)}',
      '#startCustomPanel .start-player b{color:var(--ink,#2b2622)}',
      '#startCustomPanel .field{display:flex;flex-direction:column;gap:4px;margin:0}',
      '#startCustomPanel .field>span,#startCustomPanel .field>label{font-size:12px;color:var(--ink-2,#5c544a)}',
      '#startCustomPanel input[type=text],#startCustomPanel input[type=number],#startCustomPanel select,#startCustomPanel textarea{width:100%;box-sizing:border-box;background:var(--field,#f6f1e7);color:var(--ink,#2b2622);border:1px solid var(--line-soft,#e6ded0);border-radius:6px;padding:5px 7px;font:inherit;font-size:13px}',
      '#startCustomPanel textarea{min-height:58px;resize:vertical}',
      '#startCustomPanel input[type=range]{width:100%}',
      '#startCustomPanel .field.check{flex-direction:row;align-items:center;gap:6px;font-size:12px}',
      '#startCustomPanel .row{display:flex;gap:8px}',
      '#startCustomPanel .row>.field{flex:1 1 0}',
      '#startCustomPanel .start-card-fields{display:flex;flex-direction:column;gap:8px;border:0;margin:0;padding:0;min-width:0}',
      '#startCustomPanel .start-card-fields[disabled]{opacity:.45}',
      // flex:0 0 auto:否则作为 flex 子项会被压到 18px,多行警告会被裁掉/盖住下面的内容
      '#startCustomPanel .start-msg{flex:0 0 auto;min-height:18px;font-size:12px;line-height:1.5;white-space:pre-wrap;color:var(--ink-3,#857b6d)}',
      '#startCustomPanel .start-msg.err{color:#b23a2e}',
      '#startCustomPanel .start-msg.ok{color:#2f7d4f}',
      // P1.6:还没有城市的年份(比如第 1 年)给一条引导,禁用国家编辑
      '#startCustomPanel .start-nocities{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid #c98a2e;border-radius:7px;background:rgba(201,138,46,.12);font-size:12px;line-height:1.55;color:#7a5314}',
      '#startCustomPanel .start-nocities[hidden]{display:none!important}',
      '#startCustomPanel .start-nocities .msg{white-space:pre-wrap}',
      '#startCustomPanel .start-nocities .btns{display:flex;gap:8px}',
      '#startCustomPanel .start-foot{flex:0 0 auto;display:flex;gap:8px;padding:8px 12px;border-top:1px solid var(--line-soft,#e6ded0)}',
      '#startCustomPanel .start-foot .btn{flex:1 1 0}',
      '#startCustomPanel .start-trait-val{font-variant-numeric:tabular-nums;font-size:12px;color:var(--ink-3,#857b6d)}',
      // 国家名单
      '#startCustomPanel .start-nations{display:flex;flex-direction:column;gap:3px;max-height:238px;overflow:auto;padding-right:2px}',
      '#startCustomPanel .start-nation-row{display:flex;align-items:center;gap:6px;border:1px solid var(--line-soft,#e6ded0);border-left:3px solid transparent;border-radius:6px;padding:3px 6px;background:var(--field,#f6f1e7);font-size:12px;min-width:0;cursor:pointer}',
      '#startCustomPanel .start-nation-row:hover{background:#fff}',
      '#startCustomPanel .start-nation-row.selected{border-left-color:var(--accent,#2f6fdf);background:rgba(47,111,223,.1);font-weight:600}',
      '#startCustomPanel .start-nation-row .swatch{flex:0 0 auto;width:10px;height:10px;border-radius:2px;border:1px solid rgba(0,0,0,.15)}',
      '#startCustomPanel .start-nation-row .nm{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#startCustomPanel .start-nation-row.selected .nm::after{content:" · 已选";color:var(--accent,#2f6fdf);font-size:11px}',
      '#startCustomPanel .start-nation-row .meta{flex:0 0 auto;color:var(--ink-3,#857b6d);font-variant-numeric:tabular-nums;font-weight:400}',
      '#startCustomPanel .start-nation-row select{flex:0 0 auto;width:auto;padding:1px 4px;font-size:11px}',
      '#startCustomPanel .start-nation-row .row-btn{flex:0 0 auto;border:0;background:transparent;cursor:pointer;font-size:12px;padding:1px 3px;border-radius:4px;color:var(--ink-2,#5c544a)}',
      '#startCustomPanel .start-nation-row .row-btn:hover{background:rgba(0,0,0,.08)}',
      '#startCustomPanel .start-nation-row .row-btn.danger{color:#b23a2e}',
      '#startCustomPanel .start-nation-row .row-btn.danger:hover{background:rgba(178,58,46,.12)}',
      '#startCustomPanel .start-rename{flex:1 1 auto;min-width:0;padding:1px 4px!important;font-size:12px!important}',
      // 新建国家表单
      '#startCustomPanel .start-create{display:flex;flex-direction:column;gap:6px;border:1px dashed var(--line-soft,#e6ded0);border-radius:8px;padding:7px 8px;background:rgba(0,0,0,.015)}',
      '#startCustomPanel .start-create .row{align-items:flex-end}',
      '#startCustomPanel .start-create .name-row{display:flex;gap:6px}',
      '#startCustomPanel .start-create .name-row input{flex:1 1 auto}',
      '#startCustomPanel .start-create .name-row .btn{flex:0 0 auto}',
      '#startCustomPanel .start-create .coord{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '#startCustomPanel .start-create .coord .hint{font-size:11px;color:var(--ink-3,#857b6d);flex:1 1 120px}',
      // 已选疆域
      '#startCustomPanel .start-regions{display:flex;flex-direction:column;gap:4px;border:1px solid #7fc7dd;border-radius:6px;background:rgba(64,196,236,.08);padding:5px 7px}',
      '#startCustomPanel .start-regions[hidden]{display:none!important}',
      '#startCustomPanel .start-regions-head{display:flex;align-items:center;gap:6px;font-size:12px;color:#1a6e86}',
      '#startCustomPanel .start-regions-head .btn{margin-left:auto;font-size:11px;padding:1px 6px}',
      '#startCustomPanel .start-region-chips{display:flex;flex-wrap:wrap;gap:3px;max-height:72px;overflow:auto}',
      '#startCustomPanel .start-region-chip{display:inline-flex;align-items:center;gap:2px;font-size:11px;line-height:1.4;padding:0 5px;border-radius:9px;background:rgba(40,196,236,.2);color:#12566b;border:1px solid rgba(20,140,170,.35);white-space:nowrap}',
      '#startCustomPanel .start-region-chip button{border:0;background:transparent;color:#12566b;cursor:pointer;font-size:12px;padding:0 1px;line-height:1}',
      // 删除确认
      '#startCustomPanel .start-confirm{border:1px solid #c98a2e;border-radius:6px;background:rgba(201,138,46,.1);padding:6px 8px;display:flex;flex-direction:column;gap:6px}',
      '#startCustomPanel .start-confirm[hidden]{display:none!important}',
      '#startCustomPanel .start-confirm .msg{font-size:12px;line-height:1.5;color:#7a5212;white-space:pre-wrap}',
      '#startCustomPanel .start-confirm .btns{display:flex;gap:6px}',
      '#startCustomPanel .start-confirm .btns .btn{flex:1 1 0;font-size:12px;padding:3px 6px}',
      '#startCustomPanel .start-kit{display:flex;gap:8px;flex-wrap:wrap}',
      '#startCustomPanel .start-kit .btn{flex:1 1 0}'
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
      '    <div class="panel-title">✦ 开局设置</div>',
      '    <div class="panel-sub" id="startSub">第一回合推演前,改动即时保存</div>',
      '  </div>',
      '  <button class="btn ghost" id="startClose" type="button" title="关闭">✕</button>',
      '</div>',
      '<div class="params-body start-panel-body">',
      '  <div class="start-nocities" id="startNoCities" hidden>',
      '    <div class="msg" id="startNoCitiesMsg"></div>',
      '    <div class="btns"><button class="btn primary" id="startGotoYear" type="button">去改起始年</button></div>',
      '  </div>',
      '  <div class="start-section">',
      '    <div class="start-section-head"><span>① 国家</span><span class="hint">点一行 = 选中该国(用于编辑君主/疆域),并高亮+飞首都</span></div>',
      '    <div class="start-stats" id="startStats"></div>',
      '    <div class="start-nations" id="startNationRows"></div>',
      '    <div class="start-confirm" id="startConfirm" hidden>',
      '      <div class="msg" id="startConfirmMsg"></div>',
      '      <div class="btns">',
      '        <button class="btn primary" id="startConfirmYes" type="button">确认删除</button>',
      '        <button class="btn ghost" id="startConfirmNo" type="button">取消</button>',
      '      </div>',
      '    </div>',
      '    <div class="start-create">',
      '      <div class="name-row">',
      '        <input id="startNewName" type="text" maxlength="24" placeholder="新国家名(留空 = 自动)">',
      '        <button class="btn ghost" id="startNewAuto" type="button" title="随机中文国名">🎲</button>',
      '      </div>',
      '      <div class="row">',
      '        <label class="field"><span>州数</span><input id="startNewSize" type="number" min="3" max="40" step="1" value="8"></label>',
      '        <label class="field"><span>控制方式</span><select id="startNewControl"><option value="ai">AI 君主</option><option value="program">程序自动</option></select></label>',
      '      </div>',
      '      <div class="coord">',
      '        <button class="btn ghost" id="startNewPick" type="button">📍 在地图上点选落点</button>',
      '        <span class="hint" id="startNewAtLabel">落点自动(最大的无主州)</span>',
      '      </div>',
      '      <label class="field check"><input id="startAllowExclaves" type="checkbox"><span>允许飞地(默认只保留最大连通块)</span></label>',
      '      <button class="btn primary" id="btnCreate" type="button">＋ 创建国家</button>',
      '    </div>',
      '  </div>',
      '  <div class="start-section">',
      '    <div class="start-section-head"><span>② 君主定制</span><span class="hint" id="startCustomState"></span></div>',
      '    <div class="start-player" id="startPlayerLine">所选国家:<b>未选择</b>(点 ① 里的国家)</div>',
      '    <div class="coord" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">',
      '      <button class="btn" id="startPick" type="button">🗺 在地图上选疆域</button>',
      '      <span class="hint" id="startAtLabel" style="font-size:11px;color:var(--ink-3,#857b6d);flex:1 1 140px">点州选中/取消;Esc 退出</span>',
      '    </div>',
      '    <div class="start-regions" id="startRegionBox" hidden>',
      '      <div class="start-regions-head"><span>已选 <b id="startRegionCount">0</b> 州</span><button class="btn ghost" id="startRegionClear" type="button">清空</button></div>',
      '      <div class="start-region-chips" id="startRegionChips"></div>',
      '    </div>',
      '    <label class="field check"><input id="startAutoCard" type="checkbox" checked><span>自动生成角色卡</span></label>',
      '    <fieldset id="startCardFields" class="start-card-fields" disabled>',
      '      <label class="field"><span>君主名(留空 = 自动)</span><input id="startName" type="text" maxlength="16" placeholder="例如:萧景桓"></label>',
      '      <label class="field"><span>君主生平(≤600 字,可留空)</span><textarea id="startBiography" maxlength="600" placeholder="例如:少年从军、极好战,崇尚武力…(可点「从生平推断性格」)"></textarea></label>',
      '      <div class="row">',
      '        <label class="field"><span>谨慎 <b class="start-trait-val" id="startCautionVal">50</b></span><input id="startCaution" type="range" min="0" max="100" value="50"></label>',
      '        <label class="field"><span>野心 <b class="start-trait-val" id="startAmbitionVal">50</b></span><input id="startAmbition" type="range" min="0" max="100" value="50"></label>',
      '      </div>',
      '      <div class="row">',
      '        <label class="field"><span>荣誉 <b class="start-trait-val" id="startHonorVal">50</b></span><input id="startHonor" type="range" min="0" max="100" value="50"></label>',
      '        <label class="field"><span>贪欲 <b class="start-trait-val" id="startGreedVal">50</b></span><input id="startGreed" type="range" min="0" max="100" value="50"></label>',
      '      </div>',
      '      <div class="row">',
      '        <label class="field"><span>军事</span><select id="startWar"><option value="0">低</option><option value="1">中</option><option value="2">高</option></select></label>',
      '        <label class="field"><span>经济</span><select id="startEconomy"><option value="0">低</option><option value="1">中</option><option value="2">高</option></select></label>',
      '      </div>',
      '      <div class="row">',
      '        <label class="field"><span>权谋</span><select id="startIntrigue"><option value="0">低</option><option value="1">中</option><option value="2">高</option></select></label>',
      '        <label class="field"><span>治理</span><select id="startAdmin"><option value="0">低</option><option value="1">中</option><option value="2">高</option></select></label>',
      '      </div>',
      '      <div class="row">',
      '        <label class="field"><span>战争偏好</span><select id="startPrefWar"><option value="avoid">避战</option><option value="opportunist">见机行事</option><option value="seek">主动求战</option></select></label>',
      '        <label class="field"><span>经济偏好</span><select id="startPrefEconomy"><option value="develop">发展</option><option value="trade">贸易</option></select></label>',
      '      </div>',
      '      <label class="field"><span>外交偏好</span><select id="startPrefDiplomacy"><option value="honor">重信义</option><option value="pragmatic">讲实利</option></select></label>',
      '      <label class="field"><span>人物小传(可留空)</span><textarea id="startPersona" maxlength="200" placeholder="这个君主是什么样的人…"></textarea></label>',
      '      <div class="row">',
      '        <label class="field"><span>种族(自由文本,占位)</span><input id="startRace" type="text" maxlength="40" placeholder="例如:人类 / 精灵 / 矮人"></label>',
      '        <label class="field check"><input id="startRaceSystem" type="checkbox"><span>启用种族系统</span></label>',
      '      </div>',
      '      <div class="row">',
      '        <label class="field"><span>寿命(岁)</span><input id="startLifespan" type="number" min="20" max="200" step="1" value="90" disabled></label>',
      '        <div class="start-hint" id="startRaceHint">种族系统未启用:寿命一律 90 岁</div>',
      '      </div>',
      '      <div class="start-kit">',
      '        <button class="btn ghost" id="startInfer" type="button">🔮 从生平推断性格</button>',
      '        <button class="btn ghost" id="startRandom" type="button">🎲 随机性格</button>',
      '      </div>',
      '    </fieldset>',
      '  </div>',
      '  <div class="start-msg" id="startMsg"></div>',
      '</div>',
      '<div class="start-foot">',
      '  <button class="btn primary" id="startApply" type="button">完成</button>',
      '  <button class="btn ghost" id="startCancel" type="button">关闭</button>',
      '</div>'
    ].join('');
    host.appendChild(wrap);

    el('startClose').addEventListener('click', close);
    el('startCancel').addEventListener('click', close);
    el('startApply').addEventListener('click', finish);
    el('startPick').addEventListener('click', toggleRegionPicker);
    el('startNewPick').addEventListener('click', onNewPick);
    el('startNewAuto').addEventListener('click', fetchAutoName);
    el('startGotoYear').addEventListener('click', gotoStartYear);
    el('startNewSize').addEventListener('input', function () {
      if (newAt) previewCreateNation();
    });
    el('startAllowExclaves').addEventListener('change', function () {
      allowExclaves = el('startAllowExclaves').checked;
      if (newAt) previewCreateNation();
      if (regionSel.length) { regionDirty = true; schedule(); }
    });
    el('btnCreate').addEventListener('click', createNation);
    el('startRegionClear').addEventListener('click', clearRegionSelection);
    el('startRegionChips').addEventListener('click', onRegionChipsClick);
    el('startRandom').addEventListener('click', randomizeCard);
    el('startInfer').addEventListener('click', inferFromBiography);
    el('startRaceSystem').addEventListener('change', function () { syncRaceFields(); markCardDirty(); });
    el('startRace').addEventListener('input', function () { updateRaceHint(); markCardDirty(); });
    el('startAutoCard').addEventListener('change', function () {
      el('startCardFields').disabled = el('startAutoCard').checked;
      markCardDirty();
    });
    el('startCardFields').addEventListener('input', markCardDirty);
    el('startCardFields').addEventListener('change', markCardDirty);
    var traits = [['startCaution', 'startCautionVal'], ['startAmbition', 'startAmbitionVal'], ['startHonor', 'startHonorVal'], ['startGreed', 'startGreedVal']];
    traits.forEach(function (pair) {
      el(pair[0]).addEventListener('input', function () { el(pair[1]).textContent = String(el(pair[0]).value); });
    });
    el('startNationRows').addEventListener('click', onRowsClick);
    el('startNationRows').addEventListener('change', onRowsChange);
    el('startNationRows').addEventListener('dblclick', onRowsDblClick);
    el('startNationRows').addEventListener('keydown', onRenameKey);
    el('startNationRows').addEventListener('blur', onRenameBlur, true);
    el('startConfirmYes').addEventListener('click', function () {
      var act = confirmAction;
      confirmAction = null;
      hideConfirm();
      if (typeof act === 'function') act();
    });
    el('startConfirmNo').addEventListener('click', function () {
      confirmAction = null;
      pendingSnapshot = null;
      hideConfirm();
    });
  }

  // ── 请求 ──────────────────────────────────────────────────────────────────
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
  function setupCall(body) {
    return fetch('/api/session/start-setup', {
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

  // ── 加载配置 ──────────────────────────────────────────────────────────────
  function loadConfig(opts) {
    return apiCall('/api/start/config?sessionId=' + encodeURIComponent(cfg.sessionId))
      .then(function (data) {
        if (!data || !Array.isArray(data.nations)) throw new Error('bad config');
        setupInfo = data;
        nations = data.nations;
        if (data.hasCities === false) {
          // 没有城市的年份:清掉落点/预览,避免地图残留
          newAt = null;
          setPlaceMode(false);
          clearPlacePreview();
        }
        if (selectedPid != null && !nationOf(selectedPid)) selectedPid = null;
        el('startSub').textContent = data.canSetup === false ? '第一回合已开始:开局设置已锁定' : '第一回合推演前,改动即时保存';
        renderAll();
        if (opts && opts.fillCard) fillCardFromState(selectedPid);
        if (opts && opts.select && selectedPid != null) selectPolity(selectedPid, false);
        return data;
      })
      .catch(function (err) {
        toastMsg('开局设置接口不可用:' + (err && err.message ? err.message : String(err)), true);
        renderAll();
      });
  }

  function nationOf(pid) {
    for (var i = 0; i < nations.length; i++) if (nations[i].polityId === pid) return nations[i];
    return null;
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────────
  function renderAll() {
    renderStats();
    renderRows();
    renderPlayerLine();
    renderRegionBox();
    renderPickButton();
    var createBtns = ['btnCreate'];
    createBtns.forEach(function (id) { var b = $(id); if (b) b.disabled = !canEdit(); });
    var size = $('startNewSize');
    if (size) size.disabled = !canEdit();
    var control = $('startNewControl');
    if (control) control.disabled = !canEdit();
    el('startNewPick').disabled = !canEdit();
    el('startNewAuto').disabled = !canEdit();
    el('startAllowExclaves').disabled = !canEdit();
    var newName = $('startNewName');
    if (newName) newName.disabled = !canEdit();
    renderNoCities();
    renderCreateDefaults();
  }

  function renderStats() {
    var ai = 0, pro = 0;
    nations.forEach(function (n) { if (n.control === 'program') pro++; else ai++; });
    el('startStats').textContent = '共 ' + nations.length + ' 国 · AI ' + ai + ' · 程序 ' + pro;
  }

  function renderRows() {
    var box = el('startNationRows');
    if (!nations.length) {
      box.innerHTML = '<div class="start-hint">这个会话在当前年份没有在世的国。</div>';
      return;
    }
    var html = [];
    nations.forEach(function (n) {
      var selected = n.polityId === selectedPid;
      var control = n.control === 'program' ? 'program' : 'ai';
      var renaming = editingPid === n.polityId;
      var nameCell = renaming
        ? '<input class="start-rename" data-id="' + n.polityId + '" value="' + esc(n.name) + '" maxlength="24">'
        : '<span class="nm" title="' + esc(n.name + (n.seatName ? ' · 国都 ' + n.seatName : '')) + '">' + esc(n.name) + '</span>';
      html.push(
        '<div class="start-nation-row' + (selected ? ' selected' : '') + '" data-id="' + n.polityId + '">' +
        '<span class="swatch" style="background:' + esc(n.color || '#999999') + '"></span>' +
        nameCell +
        '<span class="meta">' + (n.regions || 0) + ' 州</span>' +
        '<select data-act="control" title="控制方式"' + (canEdit() ? '' : ' disabled') + '>' +
        '<option value="ai"' + (control === 'ai' ? ' selected' : '') + '>AI</option>' +
        '<option value="program"' + (control === 'program' ? ' selected' : '') + '>程序</option>' +
        '</select>' +
        '<button class="row-btn" type="button" data-act="rename" title="改名"' + (canEdit() ? '' : ' disabled') + '>✎</button>' +
        ((n.regions || 0) > 1 ? '<button class="row-btn" type="button" data-act="clean" title="清理飞地:删掉不连通的州"' + (canEdit() ? '' : ' disabled') + '>⌗</button>' : '') +
        '<button class="row-btn danger" type="button" data-act="del" title="删除这个国家(州变无主)"' + (canEdit() ? '' : ' disabled') + '>✕</button>' +
        '</div>'
      );
    });
    box.innerHTML = html.join('');
    if (editingPid != null) {
      var input = box.querySelector('.start-rename');
      if (input) { input.focus(); input.select(); }
    }
  }

  function renderPlayerLine() {
    var n = selectedPid != null ? nationOf(selectedPid) : null;
    el('startPlayerLine').innerHTML = n
      ? '所选国家:<b>' + esc(n.name) + '</b> · ' + (n.regions || 0) + ' 州' + (n.seatName ? ' · 国都 ' + esc(n.seatName) : '')
      : '所选国家:<b>未选择</b>(点 ① 里的国家)';
    el('startCustomState').textContent = n ? '（所选国家：' + n.name + '）' : '';
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

  function regionName(region) {
    var atlas = window.CivRegionAtlas;
    var m = atlas && atlas.meta ? atlas.meta(region) : null;
    return m && m.name ? m.name : ('州 #' + (region + 1));
  }

  function renderPickButton() {
    var btn = $('startPick');
    if (!btn) return;
    btn.disabled = !canEdit() || selectedPid == null;
    btn.textContent = regionPickerOn ? '✕ 退出选疆域'
      : (regionSel.length ? '🗺 继续选疆域(' + regionSel.length + ' 州)' : '🗺 在地图上选疆域');
    var label = $('startAtLabel');
    if (!label) return;
    if (selectedPid == null) label.textContent = '先在 ① 里选一个国家';
    else if (regionSel.length) label.textContent = '已选 ' + regionSel.length + ' 州(即时生效)';
    else label.textContent = '点州选中/取消;Esc 退出';
  }

  function renderCreateDefaults() {
    var label = $('startNewAtLabel');
    if (!label) return;
    if (newAt) {
      if (previewIds.length) {
        label.textContent = '落点:' + regionName(previewIds[0]) + ' · 预计 ' + previewIds.length + ' 州' +
          (allowExclaves ? '(允许飞地)' : '');
      } else {
        label.textContent = '落点:x=' + Math.round(newAt.x) + ', y=' + Math.round(newAt.y);
      }
      return;
    }
    label.textContent = placeMode ? '移动鼠标看州高亮,点一下选中' : '落点自动(最大的无主州)';
  }

  // ── 选中 / 飞行 / 预览 ────────────────────────────────────────────────────
  function selectPolity(pid, fly) {
    if (!nationOf(pid)) return;
    selectedPid = pid;
    renderAll();
    fillCardFromState(pid);
    if (fly) flyToCapital(pid);
    previewNation(pid);
    schedule();
  }

  function flyToCapital(pid) {
    var n = nationOf(pid);
    var cm = window.CivMap;
    if (!n || !n.capital || !cm || !cm.flyTo) return;
    var x = Number(n.capital.x);
    var y = Number(n.capital.y);
    if (!isFinite(x) || !isFinite(y)) return;
    var fit = cm.view ? cm.view().fit : 0;
    if (!fit) return;
    var mult = (n.regions || 0) <= 10 ? 2.6 : ((n.regions || 0) <= 40 ? 1.8 : 1.5);
    cm.flyTo(x, y, Math.min(fit * 12, fit * mult), 520);
  }

  function previewNation(pid) {
    if (!window.CivRegionPicker || !window.CivRegionPicker.preview) return;
    window.CivRegionPicker.preview(pid, {
      api: cfg && cfg.api,
      sessionId: cfg && cfg.sessionId,
      nations: nationPickerData()
    });
  }

  // ── 名单交互 ──────────────────────────────────────────────────────────────
  function onRowsClick(e) {
    var t = e.target;
    var row = t && t.closest ? t.closest('.start-nation-row[data-id]') : null;
    if (!row) return;
    var pid = Number(row.getAttribute('data-id'));
    var actNode = t.closest ? t.closest('button[data-act]') : null;
    if (actNode) {
      var act = actNode.getAttribute('data-act');
      if (act === 'rename') { startRename(pid); return; }
      if (act === 'del') { confirmDelete(pid); return; }
      if (act === 'clean') { queueCleanExclaves(pid); return; }
      return;
    }
    if (t.closest && t.closest('select,option,input,label')) return;
    selectPolity(pid, true);
  }

  function onRowsDblClick(e) {
    var t = e.target;
    var row = t && t.closest ? t.closest('.start-nation-row[data-id]') : null;
    if (!row) return;
    if (t.closest && t.closest('button,select,input')) return;
    startRename(Number(row.getAttribute('data-id')));
  }

  function onRowsChange(e) {
    var t = e.target;
    if (!t || t.getAttribute('data-act') !== 'control') return;
    var row = t.closest ? t.closest('.start-nation-row[data-id]') : null;
    if (!row) return;
    pending.controls[String(row.getAttribute('data-id'))] = t.value === 'program' ? 'program' : 'ai';
    // 本地先更新,避免等待刷新时下拉回跳
    var n = nationOf(Number(row.getAttribute('data-id')));
    if (n) n.control = t.value === 'program' ? 'program' : 'ai';
    renderStats();
    schedule();
  }

  function startRename(pid) {
    if (!canEdit()) return;
    editingPid = pid;
    renderRows();
  }

  function onRenameKey(e) {
    if (!e.target || !e.target.classList || !e.target.classList.contains('start-rename')) return;
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    else if (e.key === 'Escape') { editingPid = null; renderRows(); }
  }

  function onRenameBlur(e) {
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains('start-rename')) return;
    var id = Number(t.getAttribute('data-id'));
    var name = String(t.value || '').trim();
    editingPid = null;
    if (name && nationOf(id)) {
      pending.names[String(id)] = name;
      var n = nationOf(id);
      if (n) n.name = name; // 立即本地显示
      schedule();
    }
    renderRows();
  }

  function confirmDelete(pid) {
    var n = nationOf(pid);
    if (!n || !canEdit()) return;
    var msg = (n.regions || 0) <= 1
      ? '「' + n.name + '」该国家只有最后一个州，删除将移除整个国家，是否继续？'
      : '删除「' + n.name + '」:' + (n.regions || 0) + ' 个州会变成无主,是否继续？';
    confirmAction = function () {
      pending.remove.push(pid);
      if (selectedPid === pid) selectedPid = null;
      renderAll();
      schedule();
    };
    el('startConfirmMsg').textContent = msg;
    el('startConfirm').hidden = false;
  }
  function hideConfirm() {
    confirmAction = null;
    var box = $('startConfirm');
    if (box) box.hidden = true;
  }

  function queueCleanExclaves(pid) {
    if (!canEdit()) return;
    if (pending.cleanExclaves.indexOf(pid) < 0) pending.cleanExclaves.push(pid);
    schedule();
  }

  // ── 新建国家 ──────────────────────────────────────────────────────────────
  function createNation() {
    if (!canEdit()) return;
    var name = el('startNewName').value.trim();
    var size = Math.max(3, Math.min(40, Number(el('startNewSize').value) || 8));
    var control = el('startNewControl').value === 'program' ? 'program' : 'ai';
    var spec = { size: size, control: control, allowExclaves: allowExclaves };
    if (name) spec.name = name;
    if (newAt) spec.at = { x: newAt.x, y: newAt.y };
    pending.nations.push(spec);
    el('startNewName').value = '';
    newAt = null;
    setPlaceMode(false);
    clearPlacePreview();
    renderCreateDefaults();
    toastMsg('正在创建国家…');
    schedule();
  }

  // ── 落点:地图 hover 高亮 + 点击预览(P1.6) ────────────────────────────────
  function setPlaceMode(on) {
    placeMode = !!on;
    var btn = $('startNewPick');
    if (btn) btn.textContent = placeMode ? '✕ 取消点选落点' : '📍 在地图上点选落点';
    var map = document.getElementById('map');
    if (map) map.style.cursor = placeMode ? 'crosshair' : '';
    if (placeMode) {
      bindPlaceEvents();
      var P = window.CivRegionPicker;
      if (P) {
        // 不 open() 的 hover 预览也要能加载 atlas(需要 api/sessionId/nations)
        if (P.configure) P.configure({ api: cfg && cfg.api, sessionId: cfg && cfg.sessionId, nations: nationPickerData() });
        if (P.ensure) P.ensure();
      }
      toastMsg('在地图上移动鼠标看州高亮,点一下选落点');
    } else {
      placeDown = null;
      if (window.CivRegionPicker && window.CivRegionPicker.setHover) window.CivRegionPicker.setHover(null);
    }
    renderCreateDefaults();
  }

  function onNewPick() {
    if (!canEdit()) return;
    setPlaceMode(!placeMode);
  }

  function bindPlaceEvents() {
    if (placeBound) return;
    var map = document.getElementById('map');
    if (!map) return;
    placeBound = true;
    map.addEventListener('pointermove', onPlaceMove, true);
    map.addEventListener('pointerdown', onPlaceDown, true);
    map.addEventListener('pointerup', onPlaceUp, true);
  }

  function onPlaceMove(e) {
    if (!placeMode) return;
    var now = Date.now();
    if (now - placeMoveAt < 120) return;
    placeMoveAt = now;
    var P = window.CivRegionPicker;
    if (!P || !P.regionAtClient || !P.setHover) return;
    var r = P.regionAtClient(e.clientX, e.clientY);
    if (r == null && (!window.CivRegionAtlas || !window.CivRegionAtlas.ready || !window.CivRegionAtlas.ready())) {
      // atlas 还在加载:先预热,下一帧 mouse move 再查
      if (P.ensure) P.ensure();
      return;
    }
    P.setHover(r == null ? null : r);
    if (!newAt) {
      var label = $('startNewAtLabel');
      if (label) label.textContent = r == null ? '落点:把鼠标移到陆地上' : '落点预览:' + regionName(r) + ' (点一下选中)';
    }
  }

  function onPlaceDown(e) {
    if (!placeMode || e.button !== 0) return;
    placeDown = { x: e.clientX, y: e.clientY };
  }

  function onPlaceUp(e) {
    if (!placeMode || !placeDown) return;
    var d = placeDown;
    placeDown = null;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) >= 4) return;
    var map = document.getElementById('map');
    var P = window.CivRegionPicker;
    if (!map || !P || !P.worldPointAt) return;
    e.preventDefault();
    e.stopPropagation();
    // 我们把 pointerup 吃掉了,app.js 的 drag 状态会残留(不按键移动鼠标也会平移地图);补发 pointercancel 清掉
    try { map.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: e.pointerId })); } catch (_) {}
    var rect = map.getBoundingClientRect();
    var wp = P.worldPointAt(e.clientX - rect.left, e.clientY - rect.top);
    if (!wp) { toastMsg('这个位置点不到地图,换个地方', true); return; }
    newAt = { x: wp.x, y: wp.y };
    setPlaceMode(false);
    previewCreateNation();
  }

  function clearPlacePreview() {
    previewIds = [];
    if (window.CivRegionPicker) {
      if (window.CivRegionPicker.previewRegions) window.CivRegionPicker.previewRegions([]);
      if (window.CivRegionPicker.setHover) window.CivRegionPicker.setHover(null);
    }
  }

  /** 落点预览:调只读接口,拿预计州数/首都并多州高亮;失败时清预览并提示。 */
  function previewCreateNation() {
    if (!cfg || !newAt) return Promise.resolve(null);
    var size = Math.max(3, Math.min(40, Number(el('startNewSize').value) || 8));
    return apiCall('/api/start/preview-nation', {
      sessionId: cfg.sessionId,
      at: { x: newAt.x, y: newAt.y },
      size: size,
      allowExclaves: allowExclaves
    }).then(function (data) {
      if (!data || !data.ok) return null;
      previewIds = Array.isArray(data.regionIds) ? data.regionIds.slice() : [];
      if (window.CivRegionPicker) {
        if (window.CivRegionPicker.previewRegions) window.CivRegionPicker.previewRegions(previewIds);
        if (window.CivRegionPicker.setHover) window.CivRegionPicker.setHover(null);
      }
      renderCreateDefaults();
      return data;
    }).catch(function (err) {
      var msg = err && err.message ? err.message : String(err);
      clearPlacePreview();
      newAt = null;
      renderCreateDefaults();
      toastMsg(msg, true);
      return null;
    });
  }

  // ── 还没有城市的年份(P1.6):只提示+禁用编辑,保留完成/关闭 ────────────────
  function renderNoCities() {
    var box = $('startNoCities');
    if (!box) return;
    var noCities = !!setupInfo && setupInfo.hasCities === false;
    box.hidden = !noCities;
    if (noCities) {
      var year = setupInfo && typeof setupInfo.year === 'number' ? Math.floor(setupInfo.year) : null;
      var hint = setupInfo && typeof setupInfo.hintCityYear === 'number' ? setupInfo.hintCityYear : 2500;
      el('startNoCitiesMsg').textContent = '第 ' + (year == null ? '?' : year) +
        ' 年世界还没有城市(尚未进入建国阶段),不能新建或调整国家。\n把起始年改成 ' + hint +
        ' 左右(默认 ' + hint + ' 年)再点「开始会话」,会重新开始这个世界的会话。';
    }
  }

  async function gotoStartYear() {
    await close();
    var btn = document.getElementById('btnParams');
    if (btn) btn.click();
    window.setTimeout(function () {
      var year = document.getElementById('startYear');
      if (year) { try { year.focus(); year.select(); } catch (_) {} }
      toastMsg('把起始年改成 2500 后点「开始会话」会重新开始本世界的会话');
    }, 200);
  }

  function fetchAutoName() {
    if (!cfg) return;
    apiCall('/api/start/auto-name?sessionId=' + encodeURIComponent(cfg.sessionId))
      .then(function (data) {
        if (data && data.name) { el('startNewName').value = data.name; toastMsg('已生成国名:' + data.name); }
      })
      .catch(function (err) { toastMsg('自动命名失败:' + (err && err.message ? err.message : String(err)), true); });
  }

  // ── 疆域连续点选 ──────────────────────────────────────────────────────────
  function nationPickerData() {
    return nations.map(function (n) {
      return { polityId: n.polityId, name: n.name, color: n.color, capital: n.capital, regions: n.regions };
    });
  }

  function openRegionPicker() {
    if (selectedPid == null) { toastMsg('先在 ① 里选一个国家,再在地图上选疆域', true); return; }
    if (!window.CivRegionPicker) { toastMsg('选疆域模块没加载:刷新页面再试', true); return; }
    if (regionPickerOn) return;
    var n = nationOf(selectedPid);
    var initial = regionSel.length ? regionSel.slice() : ((n && Array.isArray(n.regionIds)) ? n.regionIds.slice() : []);
    regionPickerOn = true;
    var ok = window.CivRegionPicker.open({
      nations: nationPickerData(),
      api: cfg && cfg.api,
      sessionId: cfg && cfg.sessionId,
      initialPolityId: selectedPid,
      initialSelection: initial,
      onSelection: function (sel, hlPid) {
        regionSel = (sel || []).slice();
        if (hlPid != null && hlPid !== selectedPid && nationOf(hlPid)) {
          syncing = true;
          try { selectedPid = hlPid; } finally { syncing = false; }
          renderAll();
          fillCardFromState(hlPid);
        }
        regionDirty = true;
        renderRegionBox();
        schedule();
      },
      onNation: function (pid) {
        if (pid == null || !nationOf(pid)) return;
        if (pid !== selectedPid) {
          selectedPid = pid;
                renderAll();
          fillCardFromState(pid);
        }
      },
      onExit: function () {
        regionPickerOn = false;
        renderPickButton();
        renderRegionBox();
      }
    });
    if (!ok) { regionPickerOn = false; toastMsg('地图还没准备好,稍后再试', true); return; }
    renderPickButton();
    toastMsg('点州选中/取消,改动即时生效;Esc 退出');
  }

  function closeRegionPicker(clearSelection) {
    if (window.CivRegionPicker && window.CivRegionPicker.isActive()) window.CivRegionPicker.close();
    regionPickerOn = false;
    if (clearSelection) regionSel = [];
    renderRegionBox();
  }

  function toggleRegionPicker() {
    if (regionPickerOn) closeRegionPicker(false);
    else openRegionPicker();
  }

  function onRegionChipsClick(e) {
    var t = e.target && e.target.closest ? e.target.closest('button[data-region-remove]') : null;
    if (!t) return;
    var r = Number(t.getAttribute('data-region-remove'));
    var idx = regionSel.indexOf(r);
    if (idx < 0) return;
    regionSel.splice(idx, 1);
    regionDirty = true;
    renderRegionBox();
    if (window.CivRegionPicker && window.CivRegionPicker.isActive()) {
      window.CivRegionPicker.setSelection(regionSel);
    }
    if (!regionSel.length) toastMsg('已清空所选州(疆域保持上一次保存的结果)');
    schedule();
  }

  function clearRegionSelection() {
    regionSel = [];
    regionDirty = true;
    renderRegionBox();
    if (window.CivRegionPicker && window.CivRegionPicker.isActive()) window.CivRegionPicker.setSelection([]);
    schedule();
  }

  // ── 角色卡 ────────────────────────────────────────────────────────────────
  function num(id) { return Number(el(id).value) || 0; }
  function markCardDirty() {
    if (el('startAutoCard').checked) return;
    cardDirty = true;
    schedule();
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
      traits: { caution: num('startCaution'), ambition: num('startAmbition'), honor: num('startHonor'), greed: num('startGreed') },
      competence: { war: num('startWar'), economy: num('startEconomy'), intrigue: num('startIntrigue'), admin: num('startAdmin') },
      preferences: {
        war: el('startPrefWar').value,
        economy: el('startPrefEconomy').value,
        diplomacy: el('startPrefDiplomacy').value
      }
    };
  }

  /** 兼容旧接口:返回当前选中国家的 custom-start body */
  function collect() {
    var body = { autoCard: el('startAutoCard').checked };
    if (selectedPid != null) body.polityId = selectedPid;
    if (regionSel.length) body.regionIds = regionSel.slice();
    if (!body.autoCard) body.card = collectCard();
    return body;
  }

  function randomizeCard() {
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
    markCardDirty();
  }

  function updateRaceHint() {
    var box = $('startRaceHint');
    if (!box) return;
    var race = el('startRace').value.trim();
    if (!el('startRaceSystem').checked) box.textContent = '种族系统未启用:寿命一律 90 岁';
    else if (!race) box.textContent = '未填写种族，将按默认寿命 90 岁';
    else box.textContent = '种族「' + race + '」:寿命按下面填的岁数';
  }

  function syncRaceFields() {
    var on = el('startRaceSystem').checked;
    el('startLifespan').disabled = !on;
    if (!on) el('startLifespan').value = '90';
    updateRaceHint();
  }

  function fillCardFields(r) {
    var traits = r && r.traits ? r.traits : {};
    var comp = r && r.competence ? r.competence : {};
    var prefs = r && r.preferences ? r.preferences : {};
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

  function inferFromBiography() {
    if (busy || !cfg) return;
    var biography = el('startBiography').value.trim();
    if (!biography) { toastMsg('先在「君主生平」里写一两句,再点推断', true); return; }
    setBusy(true);
    apiCall('/api/start/infer-card', { sessionId: cfg.sessionId, biography: biography }).then(function (data) {
      var r = data && data.result ? data.result : data;
      if (!r || !r.traits) throw new Error('推断结果不完整');
      el('startAutoCard').checked = false;
      el('startCardFields').disabled = false;
      fillCardFields(r);
      var src = r.source === 'llm' ? 'LLM' : '关键词规则';
      var warn = r.warnings && r.warnings.length ? '(' + r.warnings[0] + ')' : '';
      toastMsg('已按生平推断性格(' + src + ')' + warn);
      markCardDirty();
    }).catch(function (err) {
      toastMsg('推断失败:' + (err && err.message ? err.message : String(err)), true);
    }).then(function () { setBusy(false); });
  }

  /** 从 state.cards 里把当前选中国家的卡回填到面板 */
  function fillCardFromState(pid) {
    var st = cfg && cfg.state;
    if (pid == null || !st || !Array.isArray(st.cards)) return resetCardFields();
    var card = null;
    for (var i = 0; i < st.cards.length; i++) {
      if (st.cards[i] && st.cards[i].polityId === pid) { card = st.cards[i]; break; }
    }
    if (!card) return resetCardFields();
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

  function resetCardFields() {
    el('startAutoCard').checked = true;
    el('startCardFields').disabled = true;
    el('startName').value = '';
    el('startPersona').value = '';
    el('startBiography').value = '';
    el('startRace').value = '';
    el('startRaceSystem').checked = false;
    el('startLifespan').value = '90';
    syncRaceFields();
    ['startCaution', 'startAmbition', 'startHonor', 'startGreed'].forEach(function (id) {
      el(id).value = '50';
      el(id).dispatchEvent(new Event('input', { bubbles: true }));
    });
    ['startWar', 'startEconomy', 'startIntrigue', 'startAdmin'].forEach(function (id) { el(id).value = '1'; });
    el('startPrefWar').value = 'opportunist';
    el('startPrefEconomy').value = 'develop';
    el('startPrefDiplomacy').value = 'honor';
  }

  // ── 实时保存 ──────────────────────────────────────────────────────────────
  function schedule() {
    if (!canEdit()) return;
    if (applyTimer) window.clearTimeout(applyTimer);
    applyTimer = window.setTimeout(function () {
      applyTimer = 0;
      flush();
    }, DEBOUNCE_MS);
  }

  function buildSetupBody() {
    var body = {};
    var dirty = false;
    if (pending.remove.length) { body.remove = pending.remove.slice(); dirty = true; }
    if (pending.removeRegions.length) { body.removeRegions = pending.removeRegions.slice(); dirty = true; }
    if (Object.keys(pending.controls).length) { body.controls = pending.controls; dirty = true; }
    if (Object.keys(pending.names).length) { body.names = pending.names; dirty = true; }
    if (pending.nations.length) { body.nations = pending.nations.slice(); dirty = true; }
    if (pending.cleanExclaves.length) { body.cleanExclaves = pending.cleanExclaves.slice(); dirty = true; }
    if (allowExclaves) body.allowExclaves = true;
    return dirty ? body : null;
  }

  function buildCustomBody() {
    if (selectedPid == null) return null;
    var autoCard = el('startAutoCard').checked;
    var wantRegion = regionDirty && regionSel.length > 0;
    if (!cardDirty && !wantRegion) return null;
    var body = { polityId: selectedPid, autoCard: autoCard, allowExclaves: allowExclaves };
    if (wantRegion) body.regionIds = regionSel.slice();
    if (!autoCard) body.card = collectCard();
    return body;
  }

  function resetPending() {
    pending = emptyPending();
    cardDirty = false;
    regionDirty = false;
  }

  function flush() {
    if (!cfg || !canEdit()) { dirtyAgain = true; return inFlight || Promise.resolve(); }
    var setupBody = buildSetupBody();
    var customBody = buildCustomBody();
    if (!setupBody && !customBody) return inFlight || Promise.resolve();
    if (busy) { dirtyAgain = true; return inFlight || Promise.resolve(); }
    // 409 快照:确认删除时要拿这次的请求体带 force 重提,不能事后重建(pending 已被清掉)
    pendingSnapshot = { setupBody: setupBody, customBody: customBody };
    busy = true;
    setBusy(true);
    var setupData = null;
    var customData = null;
    var chain = setupBody
      ? setupCall(Object.assign({ sessionId: cfg.sessionId }, setupBody))
      : Promise.resolve(null);
    chain = chain.then(function (data) {
      setupData = data;
      if (data && data.result && Array.isArray(data.result.added) && data.result.added.length) {
        createdPid = data.result.added[data.result.added.length - 1];
      }
      return data;
    });
    if (customBody) {
      chain = chain.then(function () {
        return apiCall('/api/session/custom-start', Object.assign({ sessionId: cfg.sessionId }, customBody)).then(function (d) {
          customData = d;
          return d;
        });
      });
    }
    inFlight = chain.then(function (data) {
      var latest = data && data.state ? data : (setupData && setupData.state ? setupData : null);
      pendingSnapshot = null;
      resetPending();
      if (latest) {
        if (latest.state && cfg) cfg.state = latest.state;
        var parts = [];
        var result = (setupData && setupData.result) || {};
        if (result.removed && result.removed.length) parts.push('删除 ' + result.removed.length + ' 国');
        if (result.added && result.added.length) parts.push('新建 ' + result.added.length + ' 国');
        if (result.renamed && result.renamed.length) parts.push('改名 ' + result.renamed.length + ' 国');
        if (result.cleanedExclaves && result.cleanedExclaves.length) parts.push('清理飞地 ' + result.cleanedExclaves.length + ' 国');
        if (result.movedCapitals && result.movedCapitals.length) parts.push('迁都 ' + result.movedCapitals.length + ' 次');
        var warns = result.warnings && result.warnings.length ? '\n⚠ ' + result.warnings.join('\n⚠ ') : '';
        var customWarns = customData && customData.result && customData.result.warnings && customData.result.warnings.length
          ? '\n⚠ ' + customData.result.warnings.join('\n⚠ ') : '';
        if (customWarns) warns += customWarns;
        if (parts.length) toastMsg('✓ 已保存:' + parts.join(' · ') + warns);
        else if (warns) toastMsg('✓ 已保存' + warns);
        if (cfg && typeof cfg.onApplied === 'function') {
          try {
            var maybe = cfg.onApplied(latest);
            if (maybe && typeof maybe.then === 'function') maybe.catch(function () {});
          } catch (e) { /* 刷新失败不影响保存 */ }
        }
      }
      return loadConfig({ fillCard: false }).then(function () {
        if (createdPid != null && nationOf(createdPid)) {
          var pid = createdPid;
          createdPid = null;
          selectPolity(pid, true);
        }
      });
    }).catch(function (err) {
      // 失败后清掉落点 hover/预览,避免地图残留色块
      setPlaceMode(false);
      clearPlacePreview();
      if (err && err.needConfirm && Array.isArray(err.needConfirm)) {
        var msg = err.needConfirm.map(function (c) { return c.message || ''; }).join('\n');
        var snap = pendingSnapshot || { setupBody: buildSetupBody(), customBody: null };
        confirmAction = function () {
          var body = Object.assign({ sessionId: cfg.sessionId, force: true }, snap.setupBody || {});
          pendingSnapshot = null;
          return setupCall(body).then(function () {
            var tail = snap.customBody
              ? apiCall('/api/session/custom-start', Object.assign({ sessionId: cfg.sessionId }, snap.customBody))
              : Promise.resolve();
            return tail.then(function () { return loadConfig({ fillCard: false }); });
          }).catch(function (e2) {
            toastMsg('删除失败:' + (e2 && e2.message ? e2.message : String(e2)), true);
          });
        };
        el('startConfirmMsg').textContent = msg;
        el('startConfirm').hidden = false;
        toastMsg('有国家只剩最后一个州:确认后才能整个删掉', true);
      } else {
        toastMsg('保存失败:' + (err && err.message ? err.message : String(err)), true);
        pendingSnapshot = null;
      }
      resetPending();
      return loadConfig({ fillCard: false }).catch(function () {});
    }).then(function () {
      busy = false;
      setBusy(false);
      renderAll();
      inFlight = null;
      if (dirtyAgain) { dirtyAgain = false; schedule(); }
    });
    return inFlight;
  }

  // ── 打开/关闭 ─────────────────────────────────────────────────────────────
  function resetAll() {
    setupInfo = null;
    nations = [];
    selectedPid = null;
    newAt = null;
    previewIds = [];
    placeDown = null;
    setPlaceMode(false);
    clearPlacePreview();
    allowExclaves = false;
    regionSel = [];
    regionPickerOn = false;
    cardDirty = false;
    regionDirty = false;
    busy = false;
    dirtyAgain = false;
    pendingSnapshot = null;
    inFlight = null;
    editingPid = null;
    createdPid = null;
    confirmAction = null;
    pending = emptyPending();
    if (applyTimer) { window.clearTimeout(applyTimer); applyTimer = 0; }
    hideConfirm();
    el('startNewName').value = '';
    el('startNewSize').value = '8';
    el('startNewControl').value = 'ai';
    el('startAllowExclaves').checked = false;
    renderCreateDefaults();
    resetCardFields();
    el('startMsg').textContent = '';
    el('startMsg').className = 'start-msg';
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
    el(PANEL_ID).hidden = false;
    resetAll();
    setBusy(false);
    loadConfig({ fillCard: true, select: true }).then(function () {
      if (selectedPid != null) previewNation(selectedPid);
      var row = document.querySelector('#startNationRows .start-nation-row[data-id="' + selectedPid + '"]');
      if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    });
  }

  /** 关闭前把 debounce 里还没落盘的改动 flush 完,避免一关就丢 */
  async function flushPending() {
    if (applyTimer) { window.clearTimeout(applyTimer); applyTimer = 0; }
    if (inFlight) await inFlight;
    if (!cfg || !canEdit() || busy) return;
    // 等完上一轮后再把期间新攒的 pending 也落盘
    if (buildSetupBody() || buildCustomBody()) await flush();
  }

  async function finish() {
    await close();
    toastMsg('✓ 开局设置已保存(改动是即时生效的)');
  }

  async function close() {
    try { await flushPending(); }
    catch (_) { /* flush 内部已给出提示 */ }
    // 409 还在等确认时不能悄悄关掉,否则确认框(在面板里)就看不见了
    if (pendingSnapshot) {
      toastMsg('有改动需要先点「确认删除」再关闭', true);
      return;
    }
    if (applyTimer) { window.clearTimeout(applyTimer); applyTimer = 0; }
    setPlaceMode(false);
    clearPlacePreview();
    if (regionPickerOn) closeRegionPicker(false);
    if (window.CivRegionPicker && window.CivRegionPicker.clearPreview) window.CivRegionPicker.clearPreview();
    regionPickerOn = false;
    var panel = $(PANEL_ID);
    if (panel) panel.hidden = true;
  }

  function pickAt(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number') return;
    newAt = { x: x, y: y };
    renderCreateDefaults();
  }

  function bindPick(cb) { externalPick = typeof cb === 'function' ? cb : null; }

  window.CivStart = {
    open: open,
    close: close,
    collect: collect,
    bindPick: bindPick,
    pickAt: pickAt,
    // 调试/测试用
    setupBody: function () { return buildSetupBody(); },
    regionSelection: function () { return regionSel.slice(); },
    openRegionPicker: openRegionPicker,
    closeRegionPicker: closeRegionPicker,
    refresh: function () { return loadConfig({ fillCard: false }); },
    state: function () { return { selectedPid: selectedPid, busy: busy, regionSel: regionSel.slice(), canEdit: canEdit() }; }
  };
})();
