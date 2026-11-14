/* 文明与地图 · 多 Agent 沙盒 —— DM 对话框（玩家硬命令）渲染模块
 *
 * 独立文件，不依赖 app.js，不进打包器：
 *   <script src="./dm-chat.js"></script>
 *   然后 CivDmChat.renderInto(el, view, handlers)，view 来自 stateView：
 *   { ...state.playerCommands, playerPolityName: state.playerPolityName, stepYears: state.stepYears }
 *   即 { pending, recent, maxPending, perRound, playerPolityName, stepYears }。
 *
 * 设计：
 *   - 只读 view、纯字符串拼接，所有动态文本都过 esc()，防注入；
 *   - 首次 render 时自动注入一份 <style id="civ-dm-chat-style">，class 前缀统一 dmc-，
 *     Lead 想迁到 style.css 也能直接搬（删掉 injectStyles 调用即可，class 名不变）；
 *   - 用户输入走模块级 draft：重新 render 时不清空；发送成功后（handlers.send 的
 *     Promise resolve）才清空，失败保留，方便改一改再发；
 *   - 容器里只创建/复用 #dmc-root，不动容器里已有的其它内容；
 *   - 输入框 Ctrl+Enter / Cmd+Enter 发送；按钮在 disabled || busy || 输入为空时禁用。
 */
(function () {
  'use strict';

  var STYLE_ID = 'civ-dm-chat-style';
  var ROOT_ID = 'dmc-root';
  var MAX_RECENT = 8;

  var CSS = [
    '.dmc{',
    '  box-sizing:border-box;',
    '  display:flex;flex-direction:column;gap:8px;',
    '  padding:8px 10px 12px;',
    '  font-size:12px;line-height:1.5;',
    '  color:var(--ink, #1f1d18);',
    '  -webkit-text-size-adjust:100%;',
    '}',
    '.dmc *{box-sizing:border-box;}',

    /* 顶部标题行 */
    '.dmc-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;}',
    '.dmc-title{font-size:12px;font-weight:700;letter-spacing:.02em;color:var(--ink, #1f1d18);}',
    '.dmc-head-meta{font-size:11px;color:var(--ink-3, #8a857a);white-space:normal;}',

    /* 没选国家时的提示 */
    '.dmc-warn{',
    '  font-size:11px;line-height:1.5;',
    '  padding:5px 8px;',
    '  border-left:2px solid #c98a2b;',
    '  border-radius:4px;',
    '  background:rgba(201,138,43,.09);',
    '  color:var(--ink-2, #3c3a33);',
    '}',

    /* 输入区 */
    '.dmc-input-row{display:flex;align-items:stretch;gap:6px;}',
    '.dmc-input{',
    '  flex:1 1 auto;min-width:0;',
    '  min-height:38px;padding:5px 8px;',
    '  resize:vertical;',
    '  font-family:inherit;font-size:12px;line-height:1.45;',
    '  color:var(--ink, #1f1d18);',
    '  background:#fff;',
    '  border:1px solid var(--line, #e6dfd0);border-radius:6px;',
    '  outline:none;',
    '}',
    '.dmc-input:focus{border-color:var(--accent, #2f6fb3);box-shadow:0 0 0 2px rgba(47,111,179,.16);}',
    '.dmc-input:disabled{opacity:.55;}',
    '.dmc-send{',
    '  flex:0 0 auto;align-self:stretch;',
    '  padding:0 12px;',
    '  font-family:inherit;font-size:12px;',
    '  color:#fff;',
    '  background:var(--accent, #2f6fb3);',
    '  border:1px solid transparent;border-radius:6px;',
    '  cursor:pointer;',
    '  white-space:nowrap;',
    '}',
    '.dmc-send:hover:not(:disabled){filter:brightness(1.06);}',
    '.dmc-send:disabled{opacity:.45;cursor:default;}',

    /* 句式示例（可折叠） */
    '.dmc-examples{font-size:11px;color:var(--ink-3, #8a857a);}',
    '.dmc-examples summary{cursor:pointer;outline:none;}',
    '.dmc-examples summary:focus-visible{text-decoration:underline;}',
    '.dmc-examples-body{margin-top:2px;font-size:11px;line-height:1.5;color:var(--ink-3, #8a857a);word-break:break-word;}',

    /* 分区 */
    '.dmc-sec{display:flex;flex-direction:column;gap:4px;}',
    '.dmc-sec + .dmc-sec{border-top:1px solid var(--line, #e6dfd0);padding-top:8px;}',
    '.dmc-sec-head{',
    '  font-size:11px;font-weight:600;',
    '  color:var(--ink-2, #3c3a33);',
    '}',
    '.dmc-empty{font-size:11px;color:var(--ink-3, #8a857a);padding:1px 0 2px;}',
    '.dmc-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;}',

    /* 待执行行 */
    '.dmc-p-item{',
    '  display:flex;align-items:flex-start;gap:6px;',
    '  padding:4px 6px;',
    '  border:1px solid var(--line, #e6dfd0);border-radius:6px;',
    '  background:rgba(127,127,127,.04);',
    '}',
    '.dmc-num{',
    '  flex:0 0 auto;min-width:16px;height:16px;',
    '  display:inline-flex;align-items:center;justify-content:center;',
    '  font-size:10px;font-weight:700;',
    '  color:var(--ink-2, #3c3a33);',
    '  background:rgba(127,127,127,.12);border-radius:8px;',
    '}',
    '.dmc-p-main{flex:1 1 auto;min-width:0;}',
    '.dmc-text{display:block;font-size:12px;color:var(--ink, #1f1d18);word-break:break-word;}',
    '.dmc-sub{display:block;font-size:11px;color:var(--ink-3, #8a857a);word-break:break-word;}',
    '.dmc-cancel{',
    '  flex:0 0 auto;',
    '  padding:2px 8px;',
    '  font-family:inherit;font-size:11px;',
    '  color:var(--ink-2, #3c3a33);',
    '  background:transparent;',
    '  border:1px solid var(--line, #e6dfd0);border-radius:5px;',
    '  cursor:pointer;',
    '}',
    '.dmc-cancel:hover:not(:disabled){border-color:var(--accent, #2f6fb3);color:var(--accent, #2f6fb3);}',
    '.dmc-cancel:disabled{opacity:.45;cursor:default;}',

    /* 最近记录行 */
    '.dmc-r-item{display:flex;align-items:flex-start;gap:6px;padding:3px 6px;}',
    '.dmc-r-main{flex:1 1 auto;min-width:0;}',
    '.dmc-badge{',
    '  flex:0 0 auto;',
    '  display:inline-block;',
    '  padding:0 6px;',
    '  font-size:10px;line-height:1.6;',
    '  border-radius:999px;',
    '  white-space:nowrap;',
    '}',
    '.dmc-badge-applied{background:rgba(46,138,87,.16);color:#1f7a4d;}',
    '.dmc-badge-rejected{background:rgba(190,54,54,.16);color:#a33030;}',
    '.dmc-badge-pending{background:rgba(127,127,127,.18);color:#666;}',
    '.dmc-note{display:block;font-size:10px;color:var(--ink-3, #8a857a);word-break:break-word;}',

    /* 深色模式 */
    '@media (prefers-color-scheme: dark){',
    '  .dmc{color:var(--ink, #f2efe8);}',
    '  .dmc-input{background:#1c1c1e;color:var(--ink, #f2efe8);border-color:var(--line, #3a3a3e);}',
    '  .dmc-input:focus{box-shadow:0 0 0 2px rgba(64,156,255,.22);}',
    '  .dmc-warn{background:rgba(201,138,43,.14);color:var(--ink-2, #d8d3c8);}',
    '  .dmc-p-item{background:rgba(255,255,255,.03);border-color:var(--line, #3a3a3e);}',
    '  .dmc-num{color:var(--ink-2, #d8d3c8);background:rgba(255,255,255,.1);}',
    '  .dmc-badge-applied{background:rgba(46,138,87,.24);color:#8fd6ab;}',
    '  .dmc-badge-rejected{background:rgba(190,54,54,.24);color:#e89a9a;}',
    '  .dmc-badge-pending{background:rgba(255,255,255,.12);color:#c9c5bc;}',
    '}'
  ].join('\n');

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */

  function esc(v) {
    var s = v === null || v === undefined ? '' : String(v);
    return s.replace(/[&<>"]/g, function (ch) {
      if (ch === '&') return '&amp;';
      if (ch === '<') return '&lt;';
      if (ch === '>') return '&gt;';
      return '&quot;';
    });
  }

  function asList(v) {
    return Array.isArray(v) ? v : [];
  }

  function toInt(v, fallback) {
    var n = typeof v === 'number' ? v : Number(v);
    if (!isFinite(n)) return fallback;
    return Math.round(n);
  }

  function textOf(v) {
    return v === null || v === undefined ? '' : String(v);
  }

  function normView(view) {
    var v = view && typeof view === 'object' ? view : {};
    var name = v.playerPolityName;
    return {
      pending: asList(v.pending),
      recent: asList(v.recent),
      maxPending: toInt(v.maxPending, 10),
      perRound: toInt(v.perRound, 5),
      playerPolityName: name === null || name === undefined || name === '' ? null : String(name),
      stepYears: toInt(v.stepYears, 5)
    };
  }

  var STATUS_LABEL = {
    applied: '已执行',
    rejected: '已拒绝',
    pending: '排队中'
  };

  function statusOf(item) {
    var s = item && typeof item === 'object' ? item.status : '';
    return Object.prototype.hasOwnProperty.call(STATUS_LABEL, s) ? s : 'pending';
  }

  /* ------------------------------------------------------------------ *
   * 样式注入（只注入一次）
   * ------------------------------------------------------------------ */

  function injectStyles() {
    if (typeof document === 'undefined' || !document) return;
    try {
      if (document.getElementById(STYLE_ID)) return;
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      var head = document.head || document.documentElement;
      if (head) head.appendChild(style);
    } catch (err) {
      /* 样式注入失败不影响功能（页面里可能已有等价样式） */
    }
  }

  /* ------------------------------------------------------------------ *
   * HTML 拼接
   * ------------------------------------------------------------------ */

  function renderHead(v) {
    return (
      '<div class="dmc-head">' +
      '<span class="dmc-title">DM 对话框</span>' +
      '<span class="dmc-head-meta">每回合最多 ' +
      v.perRound +
      ' 条 · 下一回合开始时执行</span>' +
      '</div>'
    );
  }

  function renderWarn(v) {
    if (v.playerPolityName) return '';
    return '<div class="dmc-warn">还没选自己的国家：先在「开局设置」里选国家，再下命令</div>';
  }

  function renderInput() {
    return (
      '<div class="dmc-input-row">' +
      '<textarea id="dmc-input" class="dmc-input" rows="2" ' +
      'aria-label="DM 命令输入" ' +
      'placeholder="直接下达硬命令，例：对 埃维罗尔王国 开战"></textarea>' +
      '<button id="dmc-send" class="dmc-send" type="button">发送命令</button>' +
      '</div>' +
      '<details class="dmc-examples">' +
      '<summary>支持的句式</summary>' +
      '<div class="dmc-examples-body">示例：对 X 开战 / 与 X 结盟 / 停止扩张 / 发展 / 通商 / 灭掉 X / 渗透 X / 坚持打</div>' +
      '</details>'
    );
  }

  function renderPending(v) {
    var out = ['<div class="dmc-sec">', '<div class="dmc-sec-head">待执行（下一回合开始）</div>'];
    if (!v.pending.length) {
      out.push('<div class="dmc-empty">暂无待执行命令</div>');
    } else {
      out.push('<ul class="dmc-list dmc-pend">');
      for (var i = 0; i < v.pending.length; i++) {
        var it = v.pending[i] && typeof v.pending[i] === 'object' ? v.pending[i] : {};
        var text = textOf(it.text);
        var summary = textOf(it.summary);
        out.push(
          '<li class="dmc-p-item">' +
            '<span class="dmc-num">' +
            (i + 1) +
            '</span>' +
            '<span class="dmc-p-main">' +
            '<span class="dmc-text">' +
            esc(text) +
            '</span>' +
            (summary ? '<span class="dmc-sub">→ 解析为：' + esc(summary) + '</span>' : '') +
            '</span>' +
            '<button type="button" class="dmc-cancel" data-dmc-index="' +
            i +
            '">撤销</button>' +
            '</li>'
        );
      }
      out.push('</ul>');
    }
    out.push('</div>');
    return out.join('');
  }

  function renderRecent(v) {
    var out = ['<div class="dmc-sec">', '<div class="dmc-sec-head">最近</div>'];
    var recent = v.recent.slice(0, MAX_RECENT);
    if (!recent.length) {
      out.push('<div class="dmc-empty">暂无命令记录</div>');
    } else {
      out.push('<ul class="dmc-list dmc-recent">');
      for (var i = 0; i < recent.length; i++) {
        var it = recent[i] && typeof recent[i] === 'object' ? recent[i] : {};
        var status = statusOf(it);
        var text = textOf(it.text);
        var summary = textOf(it.summary);
        var note = textOf(it.note);
        out.push(
          '<li class="dmc-r-item">' +
            '<span class="dmc-badge dmc-badge-' +
            status +
            '">' +
            STATUS_LABEL[status] +
            '</span>' +
            '<span class="dmc-r-main">' +
            '<span class="dmc-text">' +
            esc(text) +
            '</span>' +
            (summary ? '<span class="dmc-sub">→ 解析为：' + esc(summary) + '</span>' : '') +
            (note ? '<span class="dmc-note">' + esc(note) + '</span>' : '') +
            '</span>' +
            '</li>'
        );
      }
      out.push('</ul>');
    }
    out.push('</div>');
    return out.join('');
  }

  function renderHtml(view) {
    var v = normView(view);
    return (
      renderHead(v) +
      renderWarn(v) +
      renderInput() +
      renderPending(v) +
      renderRecent(v)
    );
  }

  /* ------------------------------------------------------------------ *
   * 交互状态（模块级：draft 跨 render 保留）
   * ------------------------------------------------------------------ */

  var draft = '';
  var live = { sending: false };
  var state = null;

  function isDisabled() {
    return !!(state && state.handlers && state.handlers.disabled);
  }

  function isBusy() {
    if (live.sending) return true;
    return !!(state && state.handlers && state.handlers.busy);
  }

  function syncControls() {
    if (!state) return;
    var ta = state.ta;
    var btn = state.sendBtn;
    var disabled = isDisabled();
    var busy = isBusy();
    if (ta) ta.disabled = disabled;
    if (btn) {
      btn.disabled = disabled || busy || !draft.trim();
      btn.textContent = busy ? '发送中…' : '发送命令';
    }
    var cancels = state.cancels || [];
    for (var i = 0; i < cancels.length; i++) {
      cancels[i].disabled = busy;
    }
  }

  function finishSend(text, ok) {
    live.sending = false;
    if (ok && draft === text) {
      draft = '';
      if (state && state.ta) state.ta.value = '';
    }
    syncControls();
  }

  function doSend() {
    if (!state) return;
    var handlers = state.handlers || {};
    if (typeof handlers.send !== 'function') return;
    if (isDisabled() || isBusy()) return;
    /* 以输入框实际内容为准（用户可能刚改过、或输入事件尚未同步） */
    if (state.ta && typeof state.ta.value === 'string') draft = state.ta.value;
    var text = draft.trim();
    if (!text) return;
    var ret;
    live.sending = true;
    syncControls();
    try {
      ret = handlers.send(text);
    } catch (err) {
      live.sending = false;
      syncControls();
      return;
    }
    if (ret && typeof ret.then === 'function') {
      try {
        ret.then(
          function () {
            finishSend(text, true);
          },
          function () {
            finishSend(text, false);
          }
        );
      } catch (err2) {
        finishSend(text, false);
      }
    } else {
      finishSend(text, true);
    }
  }

  function doCancel(index) {
    if (!state) return;
    if (isBusy()) return;
    var handlers = state.handlers || {};
    if (typeof handlers.cancel !== 'function') return;
    var list = state.view && state.view.pending ? state.view.pending : [];
    var item = list[index];
    if (!item || item.id === undefined || item.id === null) return;
    try {
      handlers.cancel(item.id);
    } catch (err) {
      /* 撤销失败就等下一次 state 刷新 */
    }
  }

  function onInput() {
    if (state && state.ta && typeof state.ta.value === 'string') draft = state.ta.value;
    syncControls();
  }

  function onKeyDown(e) {
    if (!e) return;
    var isEnter = e.key === 'Enter' || e.keyCode === 13;
    if (!isEnter) return;
    if (!e.ctrlKey && !e.metaKey) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    doSend();
  }

  function onSendClick() {
    doSend();
  }

  function wireCancel(node, index) {
    node.addEventListener('click', function () {
      doCancel(index);
    });
  }

  /* ------------------------------------------------------------------ *
   * 对外入口
   * ------------------------------------------------------------------ */

  function renderInto(container, view, handlers) {
    if (!container || typeof container.appendChild !== 'function') return;
    var doc = typeof document !== 'undefined' && document ? document : container.ownerDocument || null;
    if (!doc) return;

    injectStyles();

    /* 重新渲染前，把用户可能还没触发 input 事件的内容记进 draft */
    if (state && state.ta && typeof state.ta.value === 'string' && state.ta.value !== draft) {
      draft = state.ta.value;
    }

    var v = normView(view);
    var h = handlers && typeof handlers === 'object' ? handlers : {};

    var root = null;
    if (typeof container.querySelector === 'function') root = container.querySelector('#' + ROOT_ID);
    if (!root) {
      root = doc.createElement('div');
      root.id = ROOT_ID;
      root.className = 'dmc';
      container.appendChild(root);
    }

    root.innerHTML = renderHtml(v);

    var ta = root.querySelector('#dmc-input');
    var sendBtn = root.querySelector('#dmc-send');
    var cancelNodes = root.querySelectorAll('.dmc-cancel');
    var cancels = [];
    for (var i = 0; i < cancelNodes.length; i++) cancels.push(cancelNodes[i]);

    state = {
      container: container,
      view: v,
      handlers: h,
      root: root,
      ta: ta,
      sendBtn: sendBtn,
      cancels: cancels
    };

    if (ta) {
      ta.value = draft;
      ta.addEventListener('input', onInput);
      ta.addEventListener('keydown', onKeyDown);
    }
    if (sendBtn) sendBtn.addEventListener('click', onSendClick);
    for (var j = 0; j < cancels.length; j++) wireCancel(cancels[j], j);

    syncControls();
  }

  var API = {
    version: '1.0.0',
    CSS: CSS,
    injectStyles: injectStyles,
    renderHtml: renderHtml,
    renderInto: renderInto
  };

  if (typeof globalThis !== 'undefined') globalThis.CivDmChat = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
