/*
 * 君主开局定制面板(viewer 客户端模块,IIFE,不依赖 app.js 内部状态)。
 *
 * 由 mcp/viewer/app.js 的「✦ 开局设置」按钮调用:
 *   window.CivStart.open({ sessionId, state, api, pick, onApplied })
 * - api(path, body):app.js 的 fetch 包装;body 省略是 GET,否则 POST JSON,返回 JSON 对象
 * - pick(cb):进入地图点选模式;用户点地图后回调 cb({ x, y })(主图世界像素 0..2048 / 0..1024)
 * - onApplied(data):应用成功后的回调,data = { state, result }(Lead 用它刷新看板)
 *
 * 对外契约:
 *   window.CivStart.open(cfg) / close() / collect() / bindPick(cb) / pickAt(x, y)
 *
 * 后端路由(Lead 接线):
 *   GET  /api/start/nations?sessionId=<id>  -> { nations: StartNation[] }
 *   POST /api/session/custom-start          -> { state, result: CustomStartResult }
 *        body: { sessionId, polityId?, at?: {x,y}, size?, card?, autoCard? }
 */
(function () {
  'use strict';

  var STYLE_ID = 'start-custom-style';
  var PANEL_ID = 'startCustomPanel';

  /** @type {null | {sessionId:string, state:any, api:Function, pick:Function, onApplied:Function}} */
  var cfg = null;
  /** 点选得到的世界像素坐标;null = 没选(新建国家时后端回退到最大无主州) */
  var pickedAt = null;
  /** 当前国家列表 */
  var nations = [];
  /** 正在请求中 */
  var busy = false;
  /** bindPick 注册的外部回调(可选) */
  var externalPick = null;

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

  // ── 样式:最小自足样式(不改 style.css;Lead 可以覆盖/补充 start-* 类) ─────
  function injectStyle() {
    if ($(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + PANEL_ID + '[hidden]{display:none!important}',
      '#' + PANEL_ID + '{position:absolute;left:var(--gap,12px);top:calc(var(--top-h,0px) + var(--gap,12px)*2);z-index:60;width:392px;max-height:calc(100vh - var(--top-h,0px) - var(--gap,12px)*3);display:flex;flex-direction:column;overflow:hidden;background:var(--panel-solid,#fffdf8);color:var(--ink,#2b2622);border:1px solid var(--line,#d9d2c6);border-radius:var(--r-panel,10px);box-shadow:0 10px 30px rgba(0,0,0,.18)}',
      '#' + PANEL_ID + ' .panel-head{flex:0 0 auto}',
      '#startCustomPanel .start-panel-body{overflow:auto;display:flex;flex-direction:column;gap:8px;padding:10px 12px}',
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
      '#startCustomPanel .start-trait-val{font-variant-numeric:tabular-nums;font-size:12px;color:var(--ink-3,#857b6d)}'
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
      '  <label class="field"><span>君主国家</span><select id="startNation"></select></label>',
      '  <div class="start-coord">',
      '    <button class="btn" id="startPick" type="button">📍 在地图上点选</button>',
      '    <span class="hint" id="startAtLabel">未选位置(默认落在最大的无主州)</span>',
      '  </div>',
      '  <label class="field"><span>初始州数 <b id="startSizeVal">8</b></span>',
      '    <input id="startSize" type="range" min="3" max="40" step="1" value="8">',
      '  </label>',
      '  <label class="field check"><input id="startAutoCard" type="checkbox" checked><span>自动生成角色卡</span></label>',
      '  <fieldset id="startCardFields" class="start-card-fields" disabled>',
      '    <label class="field"><span>君主名(留空 = 自动)</span><input id="startName" type="text" maxlength="16" placeholder="例如:萧景桓"></label>',
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
      '    <div><button class="btn ghost" id="startRandom" type="button">🎲 随机性格</button></div>',
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
    el('startPick').addEventListener('click', onPick);
    el('startRandom').addEventListener('click', randomizeCard);
    el('startNation').addEventListener('change', onNationChanged);
    el('startSize').addEventListener('input', function () {
      el('startSizeVal').textContent = String(el('startSize').value);
    });
    el('startAutoCard').addEventListener('change', function () {
      el('startCardFields').disabled = el('startAutoCard').checked;
    });
    var traits = [['startCaution', 'startCautionVal'], ['startAmbition', 'startAmbitionVal'], ['startHonor', 'startHonorVal'], ['startGreed', 'startGreedVal']];
    traits.forEach(function (pair) {
      el(pair[0]).addEventListener('input', function () {
        el(pair[1]).textContent = String(el(pair[0]).value);
      });
    });
  }

  // ── 国家列表 ───────────────────────────────────────────────────────────────
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
      el('startAtLabel').textContent = '现有国家:按国都位置,不需要点选';
      el('startPick').disabled = true;
    } else {
      size.disabled = false;
      el('startAtLabel').textContent = pickedAt
        ? '已选位置:x=' + Math.round(pickedAt.x) + ', y=' + Math.round(pickedAt.y)
        : '未选位置(默认落在最大的无主州)';
      el('startPick').disabled = false;
    }
  }

  // ── 地图点选(cfg.pick 回调) ───────────────────────────────────────────────
  function onPick() {
    if (!cfg || typeof cfg.pick !== 'function') {
      toastMsg('这个页面没有提供地图点选能力,请手动填坐标或直接应用', true);
      return;
    }
    toastMsg('在地图上点选君主的起始位置…');
    cfg.pick(function (pt) {
      if (!pt || typeof pt.x !== 'number' || typeof pt.y !== 'number') return;
      pickedAt = { x: pt.x, y: pt.y };
      el('startAtLabel').textContent = '已选位置:x=' + Math.round(pt.x) + ', y=' + Math.round(pt.y);
      toastMsg('已选位置(可以继续改州数/角色卡)');
      if (typeof externalPick === 'function') externalPick(pickedAt);
    });
  }

  function pickAt(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number') return;
    pickedAt = { x: x, y: y };
    el('startAtLabel').textContent = '已选位置:x=' + Math.round(x) + ', y=' + Math.round(y);
  }

  function bindPick(cb) {
    externalPick = typeof cb === 'function' ? cb : null;
  }

  // ── 角色卡 ────────────────────────────────────────────────────────────────
  function num(id) {
    return Number(el(id).value) || 0;
  }

  function collectCard() {
    return {
      name: el('startName').value.trim(),
      persona: el('startPersona').value.trim(),
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

  /** 收集本次请求的 body(不含 sessionId,由调用方补) */
  function collect() {
    var n = selectedNation();
    var body = {
      size: Number(el('startSize').value),
      autoCard: el('startAutoCard').checked
    };
    if (n) {
      body.polityId = n.polityId;
    } else {
      if (pickedAt) body.at = { x: pickedAt.x, y: pickedAt.y };
      if (body.autoCard) {
        // 新国自动卡:后端用占位名;仍然允许给一个名字
        var name = el('startName').value.trim();
        if (name) body.card = { name: name };
      }
    }
    if (!body.autoCard && !n) body.card = collectCard();
    else if (!body.autoCard && n) body.card = collectCard();
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
  }

  // ── 应用 ──────────────────────────────────────────────────────────────────
  function onApply() {
    if (!cfg || busy) return;
    busy = true;
    var apply = el('startApply');
    apply.disabled = true;
    apply.textContent = '应用中…';
    toastMsg('正在应用开局定制…');
    var body = collect();
    body.sessionId = cfg.sessionId;
    Promise.resolve()
      .then(function () { return apiCall('/api/session/custom-start', body); })
      .then(function (data) {
        var result = (data && (data.result || data.start)) || {};
        var summary = '✓ 已应用:' + (result.name || ('P' + result.polityId)) +
          ' · ' + (result.regions != null ? result.regions + ' 州' : '') +
          (result.seatName ? ' · 国都 ' + result.seatName : '') +
          (result.mode === 'new' ? '(新建)' : '');
        var warns = result.warnings && result.warnings.length ? '\n⚠ ' + result.warnings.join('\n⚠ ') : '';
        toastMsg(summary + warns);
        if (data && data.state && cfg) cfg.state = data.state;
        if (cfg && typeof cfg.onApplied === 'function') {
          try {
            var maybe = cfg.onApplied(data);
            if (maybe && typeof maybe.then === 'function') return maybe.then(afterApplied);
          } catch (e) { /* 刷新失败不影响已经应用的结果 */ }
        }
        afterApplied();
      })
      .catch(function (err) {
        toastMsg('应用失败:' + (err && err.message ? err.message : String(err)), true);
      })
      .then(function () {
        busy = false;
        apply.disabled = false;
        apply.textContent = '应用开局';
      });
  }

  function afterApplied() {
    return loadNations().then(function () {
      if (cfg && cfg.state && cfg.state.customStart) { /* 保持当前选择 */ }
    });
  }

  // ── 打开/关闭 ─────────────────────────────────────────────────────────────
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
    el('startMsg').textContent = '';
    el('startMsg').className = 'start-msg';
    el('startAtLabel').textContent = '未选位置(默认落在最大的无主州)';
    el('startPick').disabled = false;
    el('startSize').value = String(8);
    el('startSizeVal').textContent = '8';
    el('startAutoCard').checked = true;
    el('startCardFields').disabled = true;
    el('startName').value = '';
    el('startPersona').value = '';
    el(PANEL_ID).hidden = false;
    loadNations();
  }

  function close() {
    var panel = $(PANEL_ID);
    if (panel) panel.hidden = true;
  }

  window.CivStart = {
    open: open,
    close: close,
    collect: collect,
    bindPick: bindPick,
    pickAt: pickAt
  };
})();
