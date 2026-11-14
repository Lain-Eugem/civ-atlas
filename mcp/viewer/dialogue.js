/* 文明与地图 · 多 Agent 沙盒 —— DM 对话 / Jev 裁决 渲染模块
 *
 * 独立文件,不依赖 app.js,不进打包器:
 *   <script src="./dialogue.js"></script>
 *   然后 CivDialogue.renderInto(el, data, 'dm' | 'jev')，data 是
 *   GET /api/dialogue 的返回：{ rounds, total, warnings }。
 *
 * 设计：
 *   - 只读数据、纯字符串拼接，所有动态文本都过 esc()，防注入；
 *   - 提供 TABS 常量（两个页签：dm / jev），Lead 在 index.html 加按钮、
 *     在 app.js 里调 renderHtml / renderInto 即可；class 前缀统一 dlg-；
 *   - CSS 自包含（CivDialogue.CSS），首次 renderInto 时自动注入一份
 *     <style id="civ-dialogue-style">；Lead 想迁到 style.css 也能直接搬
 *     （删掉 injectStyles 调用即可，class 名不变）。
 *
 * 数据来源的说明（哪些是摘要、哪些是原文）由服务端写在 data.warnings 里，
 * 这里原样展示在页签顶部，不吞掉。
 */
(function () {
  'use strict';

  var TABS = [
    {
      id: 'dm',
      label: 'DM 对话',
      hint: 'DM 小决策：每回合的输入摘要 / 回复摘要 / 决定与引擎命令'
    },
    {
      id: 'jev',
      label: 'Jev 裁决',
      hint: '小事件裁决：每回合的环境描述 / 事件决定 / 命令 / 降级'
    }
  ];

  var TAB_TITLE = {
    dm: 'DM 对话',
    jev: 'Jev 裁决',
    monarch: '君主对话'
  };

  var STATUS_LABEL = { ok: '正常', fallback: '降级 / 拒收', error: '出错' };

  var EMPTY_TEXT = {
    dm:
      '还没有 DM 回合。先调用 civ_dm_oracle_setup(mock:true) 配置 DM，再跑 civ_dm_round；' +
      '君主模式（civ_monarch_round）下每个君主回合也会内嵌一次 DM 小决策。',
    jev:
      '还没有 Jev 裁决回合。先调用 civ_petty_setup(mock:true)（或配真实 Jev）再跑 civ_petty_round；' +
      '君主模式下的君主回合会内嵌小事件结算。',
    monarch: '还没有君主回合。用 civ_monarch_setup + civ_monarch_round 跑几个回合后再来看。'
  };

  /* ------------------------------------------------------------------ *
   * 基础工具
   * ------------------------------------------------------------------ */

  function esc(v) {
    var s = v === null || v === undefined ? '' : String(v);
    return s.replace(/[&<>"']/g, function (ch) {
      if (ch === '&') return '&amp;';
      if (ch === '<') return '&lt;';
      if (ch === '>') return '&gt;';
      if (ch === '"') return '&quot;';
      return '&#39;';
    });
  }

  function toInt(v, fallback) {
    var n = typeof v === 'number' ? v : Number(v);
    if (!isFinite(n)) return fallback === undefined ? 0 : fallback;
    return Math.round(n);
  }

  function asList(v) {
    return Array.isArray(v) ? v : [];
  }

  function normData(data) {
    var d = data && typeof data === 'object' ? data : {};
    var total = d.total && typeof d.total === 'object' ? d.total : {};
    return {
      rounds: asList(d.rounds).filter(function (r) {
        return r && typeof r === 'object';
      }),
      total: { dm: toInt(total.dm), jev: toInt(total.jev) },
      warnings: asList(d.warnings)
        .map(function (w) {
          return String(w === null || w === undefined ? '' : w);
        })
        .filter(Boolean)
    };
  }

  function roundsOf(d, kind) {
    return d.rounds.filter(function (r) {
      return r.kind === kind;
    });
  }

  function statusClass(status) {
    if (status === 'error') return ' is-error';
    if (status === 'fallback') return ' is-fallback';
    return ' is-ok';
  }

  /* ------------------------------------------------------------------ *
   * 片段渲染
   * ------------------------------------------------------------------ */

  function badge(cls, text) {
    return '<span class="dlg-badge dlg-badge-' + esc(cls) + '">' + esc(text) + '</span>';
  }

  function sourceBadge(source) {
    var s = source === null || source === undefined ? '' : String(source);
    var cls = 'source';
    if (s === 'mock') cls = 'mock';
    else if (s === 'jev' || s === 'llm') cls = 'live';
    else if (s === 'manual') cls = 'manual';
    else if (s === 'mixed') cls = 'mixed';
    return badge(cls, s || '未知来源');
  }

  function statusBadge(status) {
    var s = status === 'error' || status === 'fallback' ? status : 'ok';
    return '<span class="dlg-status dlg-status-' + esc(s) + '">' + esc(STATUS_LABEL[s]) + '</span>';
  }

  function cardHead(round, extraChips) {
    var chips = extraChips && extraChips.length
      ? extraChips
          .map(function (c) {
            return '<span class="dlg-meta-chip">' + esc(c) + '</span>';
          })
          .join('')
      : '';
    return (
      '<header class="dlg-card-head">' +
      '<span class="dlg-round">#' + esc(round.round) + '</span>' +
      '<span class="dlg-years">第 ' + esc(round.fromYear) + ' → ' + esc(round.toYear) + ' 年</span>' +
      sourceBadge(round.source) +
      statusBadge(round.status) +
      chips +
      '</header>'
    );
  }

  function section(label, body, cls) {
    if (!body) return '';
    return (
      '<div class="dlg-sec ' + esc(cls || '') + '">' +
      '<div class="dlg-label">' + esc(label) + '</div>' +
      '<div class="dlg-text">' + esc(body) + '</div>' +
      '</div>'
    );
  }

  function decisionsHtml(list, kind) {
    var items = asList(list);
    if (!items.length) {
      return '<div class="dlg-sec"><div class="dlg-label">决定</div><div class="dlg-muted">没有决定</div></div>';
    }
    var rows = items
      .map(function (d) {
        var chips = asList(d.commands)
          .map(function (c) {
            return '<span class="dlg-chip" title="引擎命令 ' + esc(c.kind) + '">' + esc(c.text || '') + '</span>';
          })
          .join('');
        var rejected = asList(d.rejected).length
          ? '<div class="dlg-rejected">' +
            asList(d.rejected)
              .map(function (x) {
                return '<span class="dlg-chip dlg-chip-rej">拒收：' + esc(x) + '</span>';
              })
              .join('') +
            '</div>'
          : '';
        var notAccepted =
          d.accepted === false ? '<span class="dlg-status dlg-status-fallback">未采纳</span>' : '';
        var kindLabel = d.kind === 'rejected' ? '拒收' : d.kind || kind || '决定';
        return (
          '<li class="dlg-decision' + (d.accepted === false ? ' is-rejected' : '') + '">' +
          '<div class="dlg-decision-head"><span class="dlg-kind">' + esc(kindLabel) + '</span>' + notAccepted + '</div>' +
          '<div class="dlg-dtitle">' + esc(d.title || '') + '</div>' +
          (d.detail ? '<div class="dlg-ddetail">' + esc(d.detail) + '</div>' : '') +
          (chips ? '<div class="dlg-cmds">' + chips + '</div>' : '') +
          rejected +
          '</li>'
        );
      })
      .join('');
    return (
      '<div class="dlg-sec">' +
      '<div class="dlg-label">决定 ' + items.length + ' 条</div>' +
      '<ul class="dlg-decisions">' + rows + '</ul>' +
      '</div>'
    );
  }

  function notesHtml(notes) {
    var list = asList(notes).filter(Boolean);
    if (!list.length) return '';
    return (
      '<div class="dlg-sec dlg-notes-sec"><div class="dlg-label">备注</div>' +
      '<ul class="dlg-notes">' +
      list
        .map(function (n) {
          return '<li>' + esc(n) + '</li>';
        })
        .join('') +
      '</ul></div>'
    );
  }

  function errorHtml(error) {
    if (!error) return '';
    return '<div class="dlg-error">' + esc(error) + '</div>';
  }

  function card(kind, round) {
    var meta = [];
    if (kind === 'jev') {
      var cmds = asList(round.decisions).reduce(function (n, d) {
        return n + asList(d && d.commands).length;
      }, 0);
      meta.push('决定 ' + asList(round.decisions).length + ' 条');
      if (cmds) meta.push('命令 ' + cmds + ' 条');
    } else if (kind === 'dm') {
      var n = asList(round.decisions).length;
      if (n) meta.push('决定 ' + n + ' 条');
    }
    var body =
      cardHead(round, meta) +
      section(kind === 'jev' ? '输入（Jev 环境描述）' : '输入摘要', round.prompt, 'dlg-prompt') +
      section(kind === 'jev' ? '回复 / 裁决摘要' : '模型回复摘要', round.reply, 'dlg-reply') +
      decisionsHtml(round.decisions, kind) +
      notesHtml(round.notes) +
      errorHtml(round.error);
    return '<article class="dlg-card dlg-card-' + esc(kind) + statusClass(round.status) + '">' + body + '</article>';
  }

  /* ------------------------------------------------------------------ *
   * 页签
   * ------------------------------------------------------------------ */

  function warningsFor(warnings, kind) {
    return asList(warnings).filter(function (w) {
      var s = String(w);
      var aboutDm = s.indexOf('DM') >= 0;
      var aboutJev = s.indexOf('Jev') >= 0;
      if (kind === 'dm') return aboutDm || !aboutJev;
      if (kind === 'jev') return aboutJev || !aboutDm;
      return true;
    });
  }

  function warningsHtml(list) {
    if (!list.length) return '';
    return (
      '<details class="dlg-warn" open>' +
      '<summary>数据来源说明 · ' + list.length + ' 条（哪些是摘要、哪些不是）</summary>' +
      '<ul>' +
      list
        .map(function (w) {
          return '<li>' + esc(w) + '</li>';
        })
        .join('') +
      '</ul>' +
      '</details>'
    );
  }

  function paneHead(d, kind, rounds) {
    var total = kind === 'dm' ? d.total.dm : kind === 'jev' ? d.total.jev : d.rounds.length;
    var normal = 0;
    var fallback = 0;
    var error = 0;
    rounds.forEach(function (r) {
      if (r.status === 'error') error += 1;
      else if (r.status === 'fallback') fallback += 1;
      else normal += 1;
    });
    var stats = '正常 ' + normal;
    if (fallback) stats += ' · 降级/拒收 ' + fallback;
    if (error) stats += ' · 出错 ' + error;
    return (
      '<div class="dlg-pane-head">' +
      '<span class="dlg-pane-title">' + esc(TAB_TITLE[kind] || kind) + '</span>' +
      '<span class="dlg-pane-meta">返回 ' + rounds.length + ' / 共 ' + total + ' 回合 · ' + stats + '</span>' +
      '</div>'
    );
  }

  function renderPane(d, kind) {
    var rounds = kind === 'monarch' ? d.rounds : roundsOf(d, kind);
    var body = rounds.length
      ? rounds
          .map(function (r) {
            return card(kind, r);
          })
          .join('')
      : '<div class="dlg-empty">' + esc(EMPTY_TEXT[kind] || '还没有回合。') + '</div>';
    return (
      '<section class="dlg-pane" data-dlg-kind="' + esc(kind) + '">' +
      paneHead(d, kind, rounds) +
      warningsHtml(warningsFor(d.warnings, kind)) +
      body +
      '</section>'
    );
  }

  /* ------------------------------------------------------------------ *
   * 对外 API
   * ------------------------------------------------------------------ */

  function renderHtml(data, kind) {
    var d = normData(data);
    if (kind === 'monarch') return renderPane(d, 'monarch');
    if (kind === 'dm' || kind === 'jev' || kind === 'all') return renderPane(d, kind === 'all' ? 'dm' : kind);
    // 不传 kind = 两个页签内容一起返回（测试 / 无 app.js 的独立页面用）
    return renderPane(d, 'dm') + renderPane(d, 'jev');
  }

  var STYLE_ID = 'civ-dialogue-style';

  var CSS =
    '.dlg-pane{display:flex;flex-direction:column;gap:8px;padding:6px 2px 18px;color:var(--ink,#1d1d1f);font-size:12px;}' +
    '.dlg-pane-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;padding:2px 2px 4px;}' +
    '.dlg-pane-title{font-weight:650;font-size:13px;}' +
    '.dlg-pane-meta{color:var(--ink-2,#6e6e73);font-size:11px;}' +
    '.dlg-warn{border:1px solid var(--line,rgba(60,60,67,.14));border-left:3px solid var(--warn,#b97c0c);border-radius:8px;padding:6px 10px;background:var(--surface-2,#f5f5f7);font-size:11px;color:var(--ink-2,#6e6e73);}' +
    '.dlg-warn summary{cursor:pointer;color:var(--warn,#b97c0c);font-weight:600;}' +
    '.dlg-warn ul{margin:4px 0 0;padding-left:18px;line-height:1.5;}' +
    '.dlg-card{background:var(--panel-solid,#fbfbfc);border:1px solid var(--line,rgba(60,60,67,.14));border-radius:10px;padding:8px 10px;box-shadow:var(--shadow-card,none);border-left:3px solid var(--line-soft,rgba(60,60,67,.08));}' +
    '.dlg-card.is-ok{border-left-color:var(--ok,#2e9a58);}' +
    '.dlg-card.is-fallback{border-left-color:var(--warn,#b97c0c);}' +
    '.dlg-card.is-error{border-left-color:var(--err,#e0443a);}' +
    '.dlg-card-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:6px;}' +
    '.dlg-round{font-family:var(--mono,monospace);font-weight:650;font-size:12px;}' +
    '.dlg-years{color:var(--ink-2,#6e6e73);font-size:11px;}' +
    '.dlg-badge{display:inline-block;padding:0 6px;border-radius:999px;font-size:10px;line-height:16px;border:1px solid transparent;}' +
    '.dlg-badge-source{background:var(--field,rgba(118,118,128,.11));color:var(--ink-2,#6e6e73);}' +
    '.dlg-badge-mock{background:rgba(185,124,12,.12);color:var(--warn,#b97c0c);}' +
    '.dlg-badge-live{background:var(--accent-soft,rgba(0,122,255,.11));color:var(--accent,#007aff);}' +
    '.dlg-badge-manual{background:rgba(46,154,88,.12);color:var(--ok,#2e9a58);}' +
    '.dlg-badge-mixed{background:var(--field,rgba(118,118,128,.11));color:var(--ink-2,#6e6e73);}' +
    '.dlg-status{display:inline-block;padding:0 6px;border-radius:999px;font-size:10px;line-height:16px;}' +
    '.dlg-status-ok{background:rgba(46,154,88,.13);color:var(--ok,#2e9a58);}' +
    '.dlg-status-fallback{background:rgba(185,124,12,.13);color:var(--warn,#b97c0c);}' +
    '.dlg-status-error{background:rgba(224,68,58,.13);color:var(--err,#e0443a);}' +
    '.dlg-meta-chip{font-family:var(--mono,monospace);font-size:10px;color:var(--ink-3,#aeaeb2);}' +
    '.dlg-sec{margin:4px 0;padding-top:4px;border-top:1px dashed var(--line-soft,rgba(60,60,67,.08));}' +
    '.dlg-sec:first-of-type{border-top:none;padding-top:0;}' +
    '.dlg-label{font-size:11px;color:var(--ink-3,#aeaeb2);margin-bottom:2px;}' +
    '.dlg-text{white-space:pre-wrap;word-break:break-word;font-family:var(--mono,monospace);font-size:11.5px;line-height:1.55;max-height:200px;overflow:auto;background:var(--surface-2,#f5f5f7);border-radius:6px;padding:6px 8px;}' +
    '.dlg-muted{color:var(--ink-3,#aeaeb2);font-size:11px;}' +
    '.dlg-decisions{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;}' +
    '.dlg-decision{border-left:2px solid var(--line,rgba(60,60,67,.14));padding:4px 8px;background:var(--surface-2,#f5f5f7);border-radius:4px;}' +
    '.dlg-decision.is-rejected{border-left-color:var(--err,#e0443a);opacity:.88;}' +
    '.dlg-decision-head{display:flex;align-items:center;gap:6px;margin-bottom:1px;}' +
    '.dlg-kind{font-size:10px;color:var(--ink-2,#6e6e73);background:var(--field,rgba(118,118,128,.11));border-radius:4px;padding:0 4px;}' +
    '.dlg-dtitle{font-weight:600;font-size:12px;word-break:break-word;}' +
    '.dlg-ddetail{white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.45;color:var(--ink-2,#6e6e73);margin-top:1px;}' +
    '.dlg-cmds{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;}' +
    '.dlg-chip{font-family:var(--mono,monospace);font-size:10.5px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--accent-soft,rgba(0,122,255,.11));color:var(--accent,#007aff);border:1px solid transparent;word-break:break-all;}' +
    '.dlg-chip-rej{background:rgba(224,68,58,.12);color:var(--err,#e0443a);}' +
    '.dlg-rejected{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;}' +
    '.dlg-notes{list-style:disc;margin:0;padding-left:18px;color:var(--ink-2,#6e6e73);font-size:11px;line-height:1.5;}' +
    '.dlg-error{margin-top:6px;padding:5px 8px;border-radius:6px;background:rgba(224,68,58,.1);color:var(--err,#e0443a);font-size:11px;white-space:pre-wrap;}' +
    '.dlg-empty{padding:14px;border:1px dashed var(--line,rgba(60,60,67,.14));border-radius:8px;color:var(--ink-3,#aeaeb2);font-size:11.5px;line-height:1.6;}' +
    '@media (prefers-color-scheme: dark){.dlg-warn{background:rgba(255,255,255,.04);}.dlg-card{background:var(--panel-solid,#1c1c1e);}}';

  function injectStyles() {
    if (typeof document === 'undefined' || !document) return false;
    try {
      if (document.getElementById(STYLE_ID)) return false;
      var style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      var host = document.head || document.documentElement;
      if (!host) return false;
      host.appendChild(style);
      return true;
    } catch (e) {
      return false;
    }
  }

  function renderInto(el, data, kind) {
    if (!el) return '';
    injectStyles();
    var html = renderHtml(data, kind);
    el.innerHTML = html;
    return html;
  }

  var API = {
    version: '1.0.0',
    TABS: TABS,
    CSS: CSS,
    renderHtml: renderHtml,
    renderInto: renderInto,
    injectStyles: injectStyles
  };

  if (typeof globalThis !== 'undefined') globalThis.CivDialogue = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
