/**
 * 文明与地图 · 多 Agent 沙盒监视台 —— 前端
 *
 * 只做三件事:
 *   1. 把参数发给本地 viewer 服务,拿回世界 / 会话 / 回合状态;
 *   2. 把地图(基础地形 + 各国疆域两张 PNG)画在 canvas 上,支持缩放、平移、点选;
 *   3. 把每个君主的理由、命令、编年史、回合日志摊开看。
 *
 * 没有框架、没有构建步骤,改完刷新浏览器即可。
 */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 状态
   * ------------------------------------------------------------------ */
  const S = {
    worldId: null,
    sessionId: null,
    state: null,
    baseImg: null,
    ownersImg: null,
    mapW: 1024,
    mapH: 512,
    cw: 800,
    ch: 480,
    dpr: 1,
    view: { k: 1, x: 0, y: 0 },
    draw: { k: 1, ox: 0, oy: 0 },
    sel: null,
    grid: null,
    colors: {},
    autoOn: false,
    busy: false,
    tab: 'decisions',
    toastTimer: 0,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const el = {
    seed: $('#seed'),
    cells: $('#cells'),
    startYear: $('#startYear'),
    stepYears: $('#stepYears'),
    maxRounds: $('#maxRounds'),
    polities: $('#polities'),
    dmPreset: $('#dmPreset'),
    mock: $('#mock'),
    provider: $('#provider'),
    baseUrl: $('#baseUrl'),
    model: $('#model'),
    apiKey: $('#apiKey'),
    temperature: $('#temperature'),
    dmEnable: $('#dmEnable'),
    dmMock: $('#dmMock'),
    dmBaseUrl: $('#dmBaseUrl'),
    dmModel: $('#dmModel'),
    dmKey: $('#dmKey'),
    dmMax: $('#dmMax'),
    btnDmConnect: $('#btnDmConnect'),
    dmStatusLine: $('#dmStatusLine'),
    pettyEnable: $('#pettyEnable'),
    pettyMock: $('#pettyMock'),
    pettyProfile: $('#pettyProfile'),
    pettyMax: $('#pettyMax'),
    pettyKey: $('#pettyKey'),
    btnPettyConnect: $('#btnPettyConnect'),
    pettyStatusLine: $('#pettyStatusLine'),
    btnWorld: $('#btnWorld'),
    btnSession: $('#btnSession'),
    btnRound: $('#btnRound'),
    btnAuto: $('#btnAuto'),
    btnVerify: $('#btnVerify'),
    btnExport: $('#btnExport'),
    status: $('#status'),
    hint: $('#hint'),
    map: $('#map'),
    mapWrap: $('#mapWrap'),
    mapEmpty: $('#mapEmpty'),
    mapLoading: $('#mapLoading'),
    mapLoadingText: $('#mapLoadingText'),
    mapTitle: $('#mapTitle'),
    mapSub: $('#mapSub'),
    legend: $('#legend'),
    polityList: $('#polityList'),
    polityDetail: $('#polityDetail'),
    polSub: $('#polSub'),
    roundChip: $('#roundChip'),
    tabs: $('#tabs'),
    tabBody: $('#tabBody'),
    tabNote: $('#tabNote'),
    toast: $('#toast'),
    busy: $('#busy'),
    busyTitle: $('#busyTitle'),
    busySub: $('#busySub'),
  };

  const ctx = el.map ? el.map.getContext('2d') : null;

  /* ------------------------------------------------------------------ *
   * 通用小工具
   * ------------------------------------------------------------------ */

  const int = (input, fallback) => {
    const n = Number(input && input.value);
    return Number.isFinite(n) ? Math.round(n) : fallback;
  };
  const fmtInt = (n) => Number(n ?? 0).toLocaleString('zh-CN');
  const yearOf = (v) => Math.floor(Number(v) + 1 / 256 + 1e-9);
  const short = (s, n = 8) => String(s ?? '').slice(0, n);
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function toast(message, isError = false) {
    if (!el.toast) return;
    el.toast.textContent = message;
    el.toast.classList.toggle('error', !!isError);
    el.toast.classList.add('show');
    window.clearTimeout(S.toastTimer);
    S.toastTimer = window.setTimeout(() => el.toast.classList.remove('show'), isError ? 6500 : 3800);
  }

  function setBusy(on, title, sub) {
    S.busy = !!on;
    if (!el.busy) return;
    el.busy.classList.toggle('show', !!on);
    if (title) el.busyTitle.textContent = title;
    if (sub !== undefined) el.busySub.textContent = sub;
  }

  function setStatus(text) {
    if (el.status) el.status.textContent = text;
  }

  function setHint(text) {
    if (el.hint) el.hint.textContent = text;
  }

  async function api(path, body) {
    const opt = body === undefined
      ? {}
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const r = await fetch(path, opt);
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = await r.json();
      if (!r.ok) throw new Error(data && data.error ? data.error : `HTTP ${r.status}`);
      return data;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = src;
    });
  }

  /* ------------------------------------------------------------------ *
   * 命令 / 名称显示
   * ------------------------------------------------------------------ */

  const PRESET_CN = { expand: '扩张', hold: '守成', trade: '商贸', peace: '和平发展' };
  const KIND_CN = {
    war: '战争', fall: '亡国', split: '分裂', dynasty: '王朝', collapse: '崩溃',
    plague: '瘟疫', famine: '饥荒', quake: '地震', pandemic: '大疫', disaster: '天灾',
    found: '立国', capital: '迁都', peace: '议和', ally: '结盟', reform: '改革',
    religion: '宗教', revolt: '民变', ruin: '遗址', battle: '战役', siege: '围城',
  };

  function keyNamesOf(state) {
    const map = {};
    for (const p of state.polities || []) map[p.key] = p.name;
    return map;
  }

  function cmdText(c, keyNames) {
    const kn = (k) => (k && keyNames[k] ? keyNames[k] : k);
    switch (c.kind) {
      case 'policy': {
        if (c.preset) return `国策:${PRESET_CN[c.preset] || c.preset}`;
        const parts = [];
        for (const [k, label] of [['war', '战'], ['expand', '拓'], ['coast', '商'], ['peace', '和']]) {
          if (typeof c[k] === 'number' && c[k] !== 0) parts.push(`${label}${c[k] > 0 ? '+' : ''}${c[k]}`);
        }
        return parts.length ? `国策:${parts.join(' ')}` : '国策';
      }
      case 'declare': return `宣战 → ${kn(c.b)}`;
      case 'ally': return `结盟 → ${kn(c.b)}`;
      case 'halt': return '休养生息(不扩张)';
      case 'protect': return '保护本国';
      case 'boost': return `发展加速 ×${c.mul || '?'}`;
      case 'press': return `坚持打${c.b ? ' → ' + kn(c.b) : ''}`;
      case 'petty': return '小事件';
      case 'story': return `故事「${c.title || ''}」`;
      case 'treaty': return '立约';
      case 'cede': return `割让 → ${kn(c.b)}`;
      case 'destroy': return `灭国 → ${kn(c.b)}`;
      case 'move': return '迁都';
      default: return String(c.kind);
    }
  }

  function colorOf(state, id) {
    const p = (state.polities || []).find((x) => x.id === id);
    return p ? p.color : '#808080';
  }

  /* ------------------------------------------------------------------ *
   * 地图
   * ------------------------------------------------------------------ */

  function fitScale() {
    return Math.min(S.cw / Math.max(1, S.mapW), S.ch / Math.max(1, S.mapH));
  }

  function resizeCanvas() {
    if (!el.map || !el.mapWrap) return;
    const rect = el.mapWrap.getBoundingClientRect();
    S.cw = Math.max(240, Math.round(rect.width));
    S.ch = Math.max(180, Math.round(rect.height));
    S.dpr = Math.min(2, window.devicePixelRatio || 1);
    el.map.width = Math.round(S.cw * S.dpr);
    el.map.height = Math.round(S.ch * S.dpr);
    draw();
  }

  function draw() {
    if (!el.map || !ctx || !S.baseImg) return;
    const { cw, ch, dpr } = S;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const fit = fitScale();
    const k = fit * S.view.k;
    const ox = (cw - S.mapW * k) / 2 + S.view.x;
    const oy = (ch - S.mapH * k) / 2 + S.view.y;
    S.draw = { k, ox, oy };

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(S.baseImg, ox, oy, S.mapW * k, S.mapH * k);
    if (S.ownersImg) ctx.drawImage(S.ownersImg, ox, oy, S.mapW * k, S.mapH * k);

    if (S.state) drawLabels(ctx, ox, oy, k);
  }

  function drawLabels(c, ox, oy, k) {
    const state = S.state;
    const list = (state.polities || []).slice(0, 16);
    if (S.sel !== null) {
      const sel = (state.polities || []).find((p) => p.id === S.sel);
      if (sel && !list.includes(sel)) list.push(sel);
    }
    c.font = '600 11px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'bottom';
    for (const p of list) {
      if (!p.capital) continue;
      const sx = ox + p.capital.x * S.mapW * k;
      const sy = oy + p.capital.y * S.mapH * k;
      if (sx < -40 || sy < -20 || sx > S.cw + 40 || sy > S.ch + 20) continue;
      const selected = p.id === S.sel;
      c.save();
      c.beginPath();
      c.arc(sx, sy, selected ? 3.2 : 2.2, 0, Math.PI * 2);
      c.fillStyle = selected ? '#ffffff' : '#0c1117';
      c.strokeStyle = selected ? p.color : '#e9eff7';
      c.lineWidth = 1.4;
      c.fill();
      c.stroke();
      c.lineWidth = 3.2;
      c.strokeStyle = 'rgba(5, 8, 12, 0.88)';
      c.strokeText(p.name, sx, sy - 5);
      c.fillStyle = selected ? '#ffffff' : '#dfe8f2';
      c.fillText(p.name, sx, sy - 5);
      c.restore();
    }
  }

  function pickPolity(clientX, clientY) {
    if (!el.map || !S.grid) return null;
    const rect = el.map.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const { k, ox, oy } = S.draw;
    const mx = (x - ox) / k;
    const my = (y - oy) / k;
    if (mx < 0 || my < 0 || mx > S.mapW || my > S.mapH) return null;
    const gx = Math.floor((mx / S.mapW) * S.grid.w);
    const gy = Math.floor((my / S.mapH) * S.grid.h);
    if (gx < 0 || gy < 0 || gx >= S.grid.w || gy >= S.grid.h) return null;
    const id = S.grid.owner[gy * S.grid.w + gx];
    return typeof id === 'number' && id >= 0 ? id : null;
  }

  function bindMap() {
    if (!el.map) return;
    let drag = null;
    el.map.addEventListener('pointerdown', (e) => {
      if (!S.baseImg) return;
      el.map.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, ox: S.view.x, oy: S.view.y, moved: 0 };
      el.map.classList.add('dragging');
    });
    el.map.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
      S.view.x = drag.ox + dx;
      S.view.y = drag.oy + dy;
      draw();
    });
    el.map.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      el.map.classList.remove('dragging');
      if (moved < 4) selectPolity(pickPolity(e.clientX, e.clientY));
    });
    el.map.addEventListener('pointercancel', () => {
      drag = null;
      el.map.classList.remove('dragging');
    });
    el.map.addEventListener('wheel', (e) => {
      if (!S.baseImg) return;
      e.preventDefault();
      const rect = el.map.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const { k, ox, oy } = S.draw;
      const wx = (px - ox) / k;
      const wy = (py - oy) / k;
      const next = clamp(S.view.k * Math.exp(-e.deltaY * 0.0012), 1, 12);
      if (Math.abs(next - S.view.k) < 1e-4) return;
      S.view.k = next;
      const fit = fitScale();
      const k2 = fit * next;
      S.view.x = px - wx * k2 - (S.cw - S.mapW * k2) / 2;
      S.view.y = py - wy * k2 - (S.ch - S.mapH * k2) / 2;
      draw();
    }, { passive: false });
  }

  async function loadBaseMap() {
    if (!S.worldId) return;
    el.mapLoading.classList.remove('hidden');
    el.mapLoadingText.textContent = '地图绘制中…';
    el.mapEmpty.classList.add('hidden');
    try {
      const r = await fetch(`/api/map/base?worldId=${encodeURIComponent(S.worldId)}`);
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { msg = (await r.json()).error || msg; } catch (_) { /* ignore */ }
        throw new Error(msg);
      }
      const blob = await r.blob();
      S.baseImg = await createImageBitmap(blob);
      S.mapW = S.baseImg.width;
      S.mapH = S.baseImg.height;
      S.view = { k: 1, x: 0, y: 0 };
      resizeCanvas();
    } catch (e) {
      toast(`地图生成失败:${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      el.mapLoading.classList.add('hidden');
    }
  }

  async function loadOwners() {
    if (!S.sessionId) return;
    try {
      const d = await api(`/api/map/owners?sessionId=${encodeURIComponent(S.sessionId)}`);
      S.grid = d.grid;
      S.colors = d.colors || {};
      S.mapW = d.width || S.mapW;
      S.mapH = d.height || S.mapH;
      S.ownersImg = await loadImage(`data:image/png;base64,${d.png}`);
      draw();
    } catch (e) {
      toast(`疆域图生成失败:${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  /* ------------------------------------------------------------------ *
   * 渲染:状态 / 列表 / 详情 / 图例 / 日志
   * ------------------------------------------------------------------ */

  function renderAll() {
    if (!S.state) return;
    renderHead();
    renderPolities();
    renderDetail();
    renderLegend();
    renderTabBody();
    refreshButtons();
  }

  function renderHead() {
    const st = S.state;
    const w = st.summary.world;
    setStatus(`${w.worldId} · 第 ${fmtInt(yearOf(st.year))} 年 · ${st.rounds}/${st.maxRounds} 回合 · ${st.polities.length} 国 · ${short(st.fingerprint)}`);
    el.roundChip.textContent = `第 ${st.rounds} / ${st.maxRounds} 回合`;
    el.polSub.textContent = `${st.polities.length} 个在世国家 · 君主 ${st.monarch ? (st.monarch.kingCount ?? 0) : 0} 家${st.finished ? ' · 已结束' : ''}`;
    el.mapTitle.textContent = `第 ${fmtInt(yearOf(st.year))} 年`;
    el.mapSub.textContent = `当前回合 ${st.rounds}/${st.maxRounds}${st.dmPreset ? ' · DM 规则' : ' · 官方规则'}${st.finished ? ' · 会话已结束' : ''} · 点击国家看详情`;
    if (el.dmStatusLine) {
      const dm = st.dm;
      el.dmStatusLine.textContent =
        dm && dm.configured
          ? `DM 已连接:${dm.mode === 'mock' ? 'mock(离线)' : esc(dm.label)} · 每回合最多 ${dm.maxDecisions} 条 · 已跑 ${dm.rounds} 回合${dm.last ? ` · 上回合 ${dm.last.decisions} 条决定` : ''}`
          : 'DM 未连接。填地址和模型后点「连接 / 测试 DM」;天灾会写成引擎命令,小贸易只记叙事。';
    }
    if (el.pettyStatusLine) {
      const pt = st.petty;
      el.pettyStatusLine.textContent =
        pt && pt.configured
          ? `小事件已连接:${pt.mock ? 'mock(离线)' : `${esc(pt.client && pt.client.baseUrl ? pt.client.baseUrl : 'Jev')} / ${esc(pt.client && pt.client.model ? pt.client.model : '')}`} · 画像 ${pt.profile} · 已跑 ${pt.rounds} 回合${pt.last ? ` · 上回合 ${pt.last.events} 件 / ${pt.last.decided} 条决定` : ''}`
          : '未连接。官方 Jev 默认 https://api.defapi.org + typesafe/jev-1.14.0;离线演示勾 mock。';
    }
  }

  function renderPolities() {
    const st = S.state;
    if (!el.polityList) return;
    const list = st.polities || [];
    if (!list.length) {
      el.polityList.innerHTML = '<div class="side-empty">这个时刻没有在世国家。</div>';
      return;
    }
    el.polityList.innerHTML = list
      .map((p) => `
        <div class="pol-row${S.sel === p.id ? ' selected' : ''}" data-id="${p.id}">
          <span class="pol-dot" style="background:${p.color}"></span>
          <span class="pol-name">${esc(p.name)}</span>
          <span class="pol-size">${fmtInt(p.size)} 州</span>
          <span class="pol-meta">P${p.id}</span>
        </div>`)
      .join('');
  }

  function renderDetail() {
    const st = S.state;
    if (!el.polityDetail) return;
    const p = (st.polities || []).find((x) => x.id === S.sel);
    if (!p) {
      el.polityDetail.innerHTML = '<div class="side-empty">选中一个国家,看它的君主、邻国和正在打的仗。</div>';
      return;
    }
    const r = p.ruler;
    const wars = (st.wars || []).filter((w) => (w.polities || []).includes(p.id));
    const traits = [
      ['扩张', r && r.leanings ? r.leanings.expand : undefined],
      ['好战', r && r.leanings ? r.leanings.war : undefined],
      ['发展', r && r.leanings ? r.leanings.develop : undefined],
      ['商贸', r && r.leanings ? r.leanings.trade : undefined],
    ];
    const traitHtml = traits
      .map(([name, v]) => {
        const val = typeof v === 'number' ? clamp(Math.round(v), 0, 100) : 0;
        return `<div class="trait-row"><span>${name}</span><div class="trait-bar"><i style="width:${val}%"></i></div><span>${typeof v === 'number' ? val : '—'}</span></div>`;
      })
      .join('');
    const neighbors = (p.neighbors || [])
      .map((n) => `<span class="tag">${esc(n.name)} <span class="muted">P${n.id}</span></span>`)
      .join('') || '<span class="muted">不接壤任何国家</span>';
    const warHtml = wars
      .map((w) => {
        const others = (w.polities || []).filter((id) => id !== p.id).map((id) => nameOfPolity(st, id));
        return `<div class="ev-row" style="grid-template-columns: 1fr; border-bottom: 1px dashed #18232e;"><div class="ev-text">与 ${others.map(esc).join('、')}:${esc(w.text)} <span class="muted">(${w.year}–${w.end} 年)</span></div></div>`;
      })
      .join('') || '<span class="muted">现在没有在打的仗</span>';

    el.polityDetail.innerHTML = `
      <div class="detail-name"><span class="pol-dot" style="background:${p.color};width:13px;height:13px"></span>${esc(p.name)}</div>
      <div class="detail-key">${esc(p.key)}</div>
      <div class="detail-grid">
        <div class="detail-cell"><div class="k">州数</div><div class="v">${fmtInt(p.size)}</div></div>
        <div class="detail-cell"><div class="k">国都</div><div class="v">${esc(p.capitalName)}${p.capital ? ` <span class="muted">(${Math.round((p.capital.x * 360 - 180) * 10) / 10}°, ${Math.round((90 - p.capital.y * 180) * 10) / 10}°)</span>` : ''}</div></div>
        <div class="detail-cell"><div class="k">君主</div><div class="v">${r ? esc(r.name) + (r.title ? ` · ${esc(r.title)}` : '') : '—'}</div></div>
        <div class="detail-cell"><div class="k">生年</div><div class="v">${r ? fmtInt(r.born) : '—'}</div></div>
      </div>
      <div class="detail-section"><h4>君主倾向</h4>${traitHtml}</div>
      <div class="detail-section"><h4>邻国</h4><div class="tag-list">${neighbors}</div></div>
      <div class="detail-section"><h4>正在打的仗</h4>${warHtml}</div>
    `;
  }

  function nameOfPolity(state, id) {
    const p = (state.polities || []).find((x) => x.id === id);
    return p ? p.name : `P${id}`;
  }

  function renderLegend() {
    if (!el.legend) return;
    const st = S.state;
    const top = (st.polities || []).slice(0, 6);
    el.legend.innerHTML =
      top.map((p) => `<span class="legend-item"><span class="legend-swatch" style="background:${p.color}"></span>${esc(p.name)}</span>`).join('') +
      '<span class="legend-item"><span class="legend-swatch" style="background:#5c7a52"></span>地形</span>' +
      '<span class="legend-item"><span class="legend-swatch" style="background:#2e4a66"></span>海洋</span>';
  }

  function renderTabBody() {
    if (!S.state || !el.tabBody) return;
    if (S.tab === 'decisions') {
      el.tabBody.innerHTML = renderDecisions();
      el.tabNote.textContent = `${S.state.monarchRounds.length} 回合${S.state.dmRounds && S.state.dmRounds.length ? ` · DM ${S.state.dmRounds.length} 回合` : ''}${S.state.pettyRounds && S.state.pettyRounds.length ? ` · 小事件 ${S.state.pettyRounds.length} 回合` : ''}`;
    } else if (S.tab === 'chronicle') {
      el.tabBody.innerHTML = renderChronicle();
      el.tabNote.textContent = `共 ${fmtInt(S.state.chronicleTotal)} 条,最近 ${S.state.events.length} 条`;
    } else {
      el.tabBody.innerHTML = renderRounds();
      el.tabNote.textContent = `指纹 ${short(S.state.fingerprint, 12)}`;
    }
  }

  function dmInlineHtml(dm, keyNames) {
    if (!dm) return '';
    const decisions = dm.decisions || [];
    const cmdNum = typeof dm.commands === 'number' ? dm.commands : (dm.commands || []).length;
    const items = decisions
      .map((d) => {
        const cmd = d.command
          ? `<span class="cmd-chip">${esc(cmdText(d.command, keyNames))}</span>`
          : '<span class="muted" style="font-size:11px">叙事(不产生引擎命令)</span>';
        const label = d.kind === 'trade' ? '小贸易' : d.kind === 'disaster' ? '天灾' : d.kind === 'story' ? '故事事件' : 'DM';
        return `
          <div class="dec-item">
            <span class="pol-dot" style="background:#8a7cff"></span>
            <div class="dec-country"><span class="name">${esc(label)}</span><span class="badge">DM</span></div>
            <div class="dec-body">
              <div class="dec-reason${d.summary || d.note ? '' : ' empty'}">${esc(d.summary || d.note || '（没有说明）')}</div>
              <div class="dec-cmds">${cmd}</div>
            </div>
          </div>`;
      })
      .join('') || '<div class="muted" style="font-size:11px">本回合没有小决策</div>';
    const rej = (dm.rejected || []).length
      ? `<span class="cmd-chip rej">拒收 ${dm.rejected.length} 条</span>`
      : '';
    const err = dm.error ? `<span class="cmd-chip err">${esc(dm.error)}</span>` : '';
    return `
      <div class="dm-inline">
        <div class="dm-inline-head"><b>DM 小决策</b><span>${esc(dm.source || '')} · ${decisions.length} 条 · ${cmdNum} 条引擎命令</span>${err}${rej}</div>
        ${items}
      </div>`;
  }

  function pettyInlineHtml(pt) {
    if (!pt) return '';
    const err = pt.error ? `<span class="cmd-chip err">${esc(pt.error)}</span>` : '';
    const digest = pt.digest
      ? `<div class="dec-reason" style="margin-top:2px">${esc(String(pt.digest).slice(0, 260))}</div>`
      : '';
    return `
      <div class="dm-inline petty-inline">
        <div class="dm-inline-head"><b>小事件裁决</b><span>${esc(pt.source || '')} · ${fmtInt(pt.events || 0)} 件 · ${pt.decisions || 0} 条决定 · ${pt.commands || 0} 条引擎命令${pt.fallback ? ` · 降级 ${pt.fallback}` : ''}</span>${err}</div>
        ${digest}
      </div>`;
  }

  function renderDecisions() {
    const st = S.state;
    const rounds = st.monarchRounds || [];
    const dmRounds = st.dmRounds || [];
    const pettyRounds = st.pettyRounds || [];
    if (!rounds.length && !dmRounds.length && !pettyRounds.length) {
      return '<div class="side-empty">还没有跑过回合。点「跑一回合」,这里会列出每个君主看到了什么、为什么这么下命令;启用 DM 或小事件裁决层后还会列出天灾、小贸易和边境小事。</div>';
    }
    const keyNames = keyNamesOf(st);
    const royal = rounds
      .slice()
      .reverse()
      .map((r) => {
        const decisions = r.decisions || [];
        const cmdCount = decisions.reduce((n, d) => n + ((d.commands || []).length), 0);
        const rejCount = decisions.reduce((n, d) => n + ((d.rejected || []).length), 0);
        const items = decisions
          .map((d) => {
            const color = colorOf(st, d.polityId);
            const cmds = (d.commands || [])
              .map((c) => `<span class="cmd-chip">${esc(cmdText(c, keyNames))}</span>`)
              .join('') || '<span class="muted" style="font-size:11px">本回合没有下命令</span>';
            const rej = (d.rejected || [])
              .map((x) => `<span class="cmd-chip rej">${esc((x && x.reason) || '被拒')}</span>`)
              .join('');
            const err = d.error ? `<span class="cmd-chip err">${esc(d.error)}</span>` : '';
            const source = d.source === 'mock' ? 'mock' : d.source === 'llm' ? 'LLM' : '出错';
            return `
              <div class="dec-item">
                <span class="pol-dot" style="background:${color}"></span>
                <div class="dec-country"><span class="name">${esc(d.name)}</span><span class="badge ${esc(d.source)}">${source}</span></div>
                <div class="dec-body">
                  <div class="dec-reason${d.reason ? '' : ' empty'}">${esc(d.reason || '（没有写理由）')}</div>
                  <div class="dec-cmds">${cmds}${rej}${err}</div>
                  <div class="dec-meta">P${d.polityId}${d.ms !== undefined ? ` · ${d.ms} ms` : ''}${rejCount ? '' : ''}</div>
                </div>
              </div>`;
          })
          .join('');
        return `
          <div class="dec-round">
            <div class="dec-round-head"><b>第 ${r.round} 回合</b>
              <span>第 ${fmtInt(yearOf(r.fromYear))} → ${fmtInt(yearOf(r.toYear))} 年 · ${decisions.length} 位君主 · ${cmdCount} 条命令${rejCount ? ` · 拒收 ${rejCount}` : ''}${(r.engineRejected || []).length ? ` · 引擎拒收 ${r.engineRejected.length}` : ''}</span>
            </div>
            ${items}
            ${pettyInlineHtml(r.petty)}
            ${dmInlineHtml(r.dm, keyNames)}
          </div>`;
      })
      .join('');
    const dmOnly = dmRounds
      .slice()
      .reverse()
      .map((r) => {
        const decisions = r.decisions || [];
        const cmdNum = (r.commands || []).length;
        return `
          <div class="dec-round">
            <div class="dec-round-head"><b>DM 第 ${r.round} 回合</b>
              <span>第 ${fmtInt(yearOf(r.fromYear))} → ${fmtInt(yearOf(r.toYear))} 年 · ${decisions.length} 条小决策 · ${cmdNum} 条引擎命令${(r.engineRejected || []).length ? ` · 引擎拒收 ${r.engineRejected.length}` : ''}</span>
            </div>
            ${dmInlineHtml({ source: r.source, decisions, commands: r.commands, notes: r.notes }, keyNames)}
          </div>`;
      })
      .join('');
    const pettyOnly = pettyRounds
      .slice()
      .reverse()
      .map((r) => {
        const decisions = Array.isArray(r.decisions) ? r.decisions : [];
        return `
          <div class="dec-round">
            <div class="dec-round-head"><b>小事件第 ${r.round} 回合</b>
              <span>第 ${fmtInt(yearOf(r.fromYear))} → ${fmtInt(yearOf(r.toYear))} 年 · ${fmtInt(r.events || 0)} 件 · ${decisions.length} 条决定 · ${r.commands || 0} 条引擎命令${r.fallbackCount ? ` · 降级 ${r.fallbackCount}` : ''}</span>
            </div>
            ${pettyInlineHtml({ source: r.source, events: r.events, decisions: decisions.length, commands: r.commands, fallback: r.fallbackCount, digest: decisions.slice(0, 4).map((d) => `${d.polityName || `P${d.polityId}`}:${d.modeId}→${d.option || d.optionKey || ''}`).join('；') })}
          </div>`;
      })
      .join('');
    return royal + dmOnly + pettyOnly;
  }

  function renderChronicle() {
    const events = S.state.events || [];
    if (!events.length) return '<div class="side-empty">编年史还是空的。</div>';
    return events
      .map((e) => {
        const kind = e.kind;
        const cls = kind === 'war' ? 'war' : kind === 'split' || kind === 'fall' || kind === 'collapse' ? 'split' : '';
        return `<div class="ev-row"><div class="ev-year">${fmtInt(e.year)}${e.end !== e.year ? `–${fmtInt(e.end)}` : ''}</div><div class="ev-text"><span class="ev-kind ${cls}">${esc(KIND_CN[kind] || kind)}</span>${esc(e.text)}</div></div>`;
      })
      .join('');
  }

  function renderRounds() {
    const st = S.state;
    const rounds = st.monarchRounds || [];
    if (!rounds.length) return '<div class="side-empty">还没有回合日志。</div>';
    const rows = rounds
      .slice()
      .reverse()
      .map((r) => {
        const decisions = r.decisions || [];
        const cmdCount = decisions.reduce((n, d) => n + ((d.commands || []).length), 0);
        const rejCount = decisions.reduce((n, d) => n + ((d.rejected || []).length), 0);
        const errCount = decisions.filter((d) => d.source === 'error' || d.error).length;
        const changes = (r.changes || [])
          .filter((c) => c.delta)
          .slice(0, 3)
          .map((c) => `${esc(c.name)} ${c.delta > 0 ? '+' : ''}${c.delta}`)
          .join('、');
        return `<tr>
          <td class="num">${r.round}</td>
          <td class="num">${fmtInt(yearOf(r.fromYear))} → ${fmtInt(yearOf(r.toYear))}</td>
          <td class="num">${decisions.length}</td>
          <td class="num">${cmdCount}${rejCount ? ` / 拒 ${rejCount}` : ''}${errCount ? ` / 错 ${errCount}` : ''}</td>
          <td>${changes || '<span class="muted">—</span>'}</td>
          <td class="mono">${short(r.fingerprint, 10)}</td>
        </tr>`;
      })
      .join('');
    return `<table class="round-table"><thead><tr><th>回合</th><th>年份</th><th>君主</th><th>命令</th><th>领土变化</th><th>指纹</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function selectPolity(id) {
    S.sel = id;
    if (!S.state) return;
    renderPolities();
    renderDetail();
    draw();
  }

  /* ------------------------------------------------------------------ *
   * 按钮状态
   * ------------------------------------------------------------------ */

  function refreshButtons() {
    const hasWorld = !!S.worldId;
    const hasSession = !!S.sessionId;
    const finished = !!(S.state && S.state.finished);
    el.btnSession.disabled = !hasWorld || S.busy || S.autoOn;
    el.btnRound.disabled = !hasSession || finished || S.busy || S.autoOn;
    el.btnAuto.disabled = !hasSession || finished || S.busy;
    el.btnVerify.disabled = !hasSession || S.busy;
    el.btnExport.disabled = !hasSession || S.busy;
    el.btnDmConnect.disabled = !hasSession || S.busy;
    el.btnPettyConnect.disabled = !hasSession || S.busy;
    el.btnAuto.textContent = S.autoOn ? '暂停自动播放' : '自动播放';
    el.btnAuto.classList.toggle('playing', S.autoOn);
  }

  /* ------------------------------------------------------------------ *
   * 操作流程
   * ------------------------------------------------------------------ */

  async function createWorld() {
    try {
      setBusy(true, '正在生成世界…', '同样的种子 + 同样的地块数,每次都会得到同一个世界');
      const seed = int(el.seed, 7);
      const cells = int(el.cells, 34043);
      const d = await api('/api/world', { seed, cells });
      S.worldId = d.worldId;
      S.sessionId = null;
      S.state = null;
      S.ownersImg = null;
      S.grid = null;
      S.sel = null;
      S.baseImg = null;
      S.autoOn = false;
      el.polityList.innerHTML = '';
      el.polityDetail.innerHTML = '<div class="side-empty">世界建好了,点「开始会话」让 AI 君主接管。</div>';
      setStatus(`${d.worldId} · ${fmtInt(d.cells)} 地块 · 生成 ${d.generatedMs} ms`);
      setHint(`世界 ${d.worldId} 已生成(${fmtInt(d.cells)} 地块)。下一步:设置起始年,点「开始会话」。`);
      await loadBaseMap();
      if (S.baseImg) el.mapEmpty.classList.add('hidden');
      refreshButtons();
      toast(`世界已创建:${d.worldId}`);
    } catch (e) {
      toast(`创建世界失败:${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(false);
      refreshButtons();
    }
  }

  async function startSession() {
    if (!S.worldId) return;
    try {
      setBusy(true, '正在推演到起始年…', '会话会先用引擎自动规则把历史推到起始年,再交给 AI 君主。');
      const d = await api('/api/session', {
        worldId: S.worldId,
        startYear: int(el.startYear, 2500),
        stepYears: int(el.stepYears, 5),
        maxRounds: int(el.maxRounds, 12),
        dmPreset: el.dmPreset.checked,
      });
      S.sessionId = d.session.sessionId;
      S.autoOn = false;
      setBusy(true, '正在配置君主…', '选君主范围、mock 或真模型;Key 只存在服务端内存。');
      const setup = await api('/api/monarch/setup', {
        sessionId: S.sessionId,
        polities: el.polities.value === 'all' ? 'all' : Number(el.polities.value),
        mock: el.mock.checked,
        provider: el.provider.value,
        baseUrl: el.baseUrl.value.trim(),
        model: el.model.value.trim(),
        apiKey: el.apiKey.value,
        temperature: Number(el.temperature.value) || 0.7,
      });
      await applyState(setup.state || d.state);
      if (el.dmEnable.checked) {
        try {
          setBusy(true, '正在连接 DM 小决策…', el.dmMock.checked ? 'mock 模式,不联网' : 'OpenAI 兼容服务;Key 只在服务端内存。');
          await connectDm(true);
        } catch (e) {
          toast(`DM 小决策未连接(不影响君主):${e instanceof Error ? e.message : String(e)}`, true);
        }
      }
      if (el.pettyEnable.checked) {
        try {
          setBusy(true, '正在连接小事件裁决层…', el.pettyMock.checked ? 'mock 模式,不联网' : '官方 Jev;Key 只在服务端内存。');
          await connectPetty(true);
        } catch (e) {
          toast(`小事件裁决层未连接(不影响君主/DM):${e instanceof Error ? e.message : String(e)}`, true);
        }
      }
      const king = setup.setup.monarchs.length;
      toast(`会话已开始:第 ${fmtInt(yearOf(d.session.year))} 年,${king} 家君主接管${el.mock.checked ? '(mock)' : '(真模型)'}`);
      setHint('点「跑一回合」:每个君主先看简报,再下命令;收齐后引擎统一推演一个回合。');
    } catch (e) {
      toast(`开始会话失败:${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(false);
      refreshButtons();
    }
  }

  async function applyState(state) {
    S.state = state;
    const exists = (state.polities || []).some((p) => p.id === S.sel);
    if (!exists) S.sel = state.polities && state.polities.length ? state.polities[0].id : null;
    renderAll();
    await loadOwners();
  }

  async function runRound() {
    if (!S.sessionId || S.busyAutoBusy) return;
    if (S.state && S.state.finished) {
      toast('会话已经结束;改起始年/回合数再开一个。', true);
      return;
    }
    S.busyAutoBusy = true;
    try {
      setBusy(true, 'AI 君主回合进行中…', '每个君主看简报 → 下命令 → 收齐后统一推演;真模型时这一步要等网络。');
      refreshButtons();
      const d = await api('/api/monarch/round', { sessionId: S.sessionId });
      await applyState(d.state);
      const r = d.round;
      toast(`第 ${r.round} 回合:第 ${fmtInt(yearOf(r.fromYear))} → ${fmtInt(yearOf(r.toYear))} 年,${(r.decisions || []).length} 位君主、${(r.decisions || []).reduce((n, x) => n + (x.commands || []).length, 0)} 条命令`);
    } catch (e) {
      toast(`回合失败:${e instanceof Error ? e.message : String(e)}`, true);
      throw e;
    } finally {
      S.busyAutoBusy = false;
      setBusy(false);
      refreshButtons();
    }
  }

  async function autoLoop() {
    if (S.autoOn) return;
    if (!S.sessionId) return;
    S.autoOn = true;
    refreshButtons();
    try {
      while (S.autoOn && S.sessionId && S.state && !S.state.finished) {
        await runRound();
      }
    } finally {
      S.autoOn = false;
      refreshButtons();
    }
  }

  function stopAuto() {
    S.autoOn = false;
    refreshButtons();
  }

  async function connectDm(silent = false) {
    if (!S.sessionId) return;
    const mock = el.dmMock.checked;
    const d = await api('/api/dm/setup', {
      sessionId: S.sessionId,
      mock,
      provider: 'custom',
      baseUrl: el.dmBaseUrl.value.trim(),
      model: el.dmModel.value.trim(),
      apiKey: el.dmKey.value,
      maxDecisions: int(el.dmMax, 2),
      probe: !mock,
    });
    if (d && d.state) await applyState(d.state);
    if (!silent) {
      toast(
        mock
          ? 'DM 已连接(mock):天灾会写成引擎命令,小贸易只记叙事'
          : `DM 已连接:${d && d.dm && d.dm.label ? d.dm.label : 'OpenAI 兼容'}`,
      );
    }
  }

  async function connectPetty(silent = false) {
    if (!S.sessionId) return;
    const mock = el.pettyMock.checked;
    const d = await api('/api/petty/setup', {
      sessionId: S.sessionId,
      mock,
      profile: el.pettyProfile.value,
      maxQuestions: int(el.pettyMax, 8),
      apiKey: mock ? '' : el.pettyKey.value,
      probe: !mock,
    });
    if (d && d.state) await applyState(d.state);
    if (!silent) {
      toast(
        mock
          ? '小事件裁决层已连接(mock):每回合先结算小事,再让君主/DM 决策'
          : `小事件裁决层已连接:${d && d.petty && d.petty.client ? `${d.petty.client.baseUrl} / ${d.petty.client.model}` : '官方 Jev'}`,
      );
    }
  }

  async function verifySession() {
    if (!S.sessionId) return;
    try {
      setBusy(true, '正在回放对账…', '同一份世界 + 同一串命令,从第 0 年重推到当前年,比对指纹。');
      const d = await api('/api/verify', { sessionId: S.sessionId });
      const v = d.verify;
      if (v.ok) {
        toast(`回放一致 ✓ 第 ${fmtInt(v.actualYear)} 年,指纹 ${short(v.actual, 16)}(共 ${v.steps} 步)`);
      } else {
        toast(`回放不一致:期望 ${short(v.expected, 12)} / 实际 ${short(v.actual, 12)}${v.problems && v.problems.length ? ` · ${v.problems.join(';')}` : ''}`, true);
      }
    } catch (e) {
      toast(`回放对账失败:${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(false);
    }
  }

  async function exportSession() {
    if (!S.sessionId) return;
    try {
      setBusy(true, '正在导出会话…');
      const d = await api('/api/export', { sessionId: S.sessionId });
      toast(`已导出:${d.export.path}(${fmtInt(d.export.bytes)} 字节)`);
    } catch (e) {
      toast(`导出失败:${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------------------------------------------ *
   * 绑定事件
   * ------------------------------------------------------------------ */

  function bind() {
    el.btnWorld.addEventListener('click', () => { void createWorld(); });
    el.btnSession.addEventListener('click', () => { void startSession(); });
    el.btnRound.addEventListener('click', () => { void runRound(); });
    el.btnAuto.addEventListener('click', () => {
      if (S.autoOn) stopAuto();
      else void autoLoop();
    });
    el.btnVerify.addEventListener('click', () => { void verifySession(); });
    el.btnExport.addEventListener('click', () => { void exportSession(); });
    el.btnDmConnect.addEventListener('click', () => {
      void (async () => {
        try {
          setBusy(true, el.dmMock.checked ? '正在连接 DM(mock)…' : '正在测试 DM 连接…', '只决定天灾和小贸易;Key 只在服务端内存。');
          await connectDm(false);
          setHint('DM 已接上:跑一回合时,君主命令和 DM 小决策会一起提交给引擎。');
        } catch (e) {
          toast(`连接 DM 失败:${e instanceof Error ? e.message : String(e)}`, true);
        } finally {
          setBusy(false);
          refreshButtons();
        }
      })();
    });

    el.btnPettyConnect.addEventListener('click', () => {
      void (async () => {
        try {
          setBusy(true, el.pettyMock.checked ? '正在连接小事件裁决层(mock)…' : '正在测试官方 Jev 连接…', '只裁决小事;Key 只在服务端内存。');
          await connectPetty(false);
          setHint('小事件裁决层已接上:跑一回合时,会先结算小事,再让君主/DM 决策。');
        } catch (e) {
          toast(`连接小事件裁决层失败:${e instanceof Error ? e.message : String(e)}`, true);
        } finally {
          setBusy(false);
          refreshButtons();
        }
      })();
    });

    el.tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      S.tab = btn.dataset.tab;
      $$('.tab', el.tabs).forEach((b) => b.classList.toggle('active', b === btn));
      renderTabBody();
    });

    el.polityList.addEventListener('click', (e) => {
      const row = e.target.closest('.pol-row');
      if (row) selectPolity(Number(row.dataset.id));
    });

    el.mock.addEventListener('change', () => {
      el.provider.disabled = el.mock.checked;
      el.apiKey.disabled = el.mock.checked;
    });

    el.dmMock.addEventListener('change', () => {
      el.dmBaseUrl.disabled = el.dmMock.checked;
      el.dmModel.disabled = el.dmMock.checked;
      el.dmKey.disabled = el.dmMock.checked;
    });

    el.pettyMock.addEventListener('change', () => {
      el.pettyKey.disabled = el.pettyMock.checked;
    });

    window.addEventListener('resize', () => resizeCanvas());
    if (window.ResizeObserver && el.mapWrap) {
      new ResizeObserver(() => resizeCanvas()).observe(el.mapWrap);
    }
    bindMap();

    el.provider.disabled = el.mock.checked;
    el.apiKey.disabled = el.mock.checked;
    el.dmBaseUrl.disabled = el.dmMock.checked;
    el.dmModel.disabled = el.dmMock.checked;
    el.dmKey.disabled = el.dmMock.checked;
    el.pettyKey.disabled = el.pettyMock.checked;
  }

  bind();
  refreshButtons();
  resizeCanvas();
})();
