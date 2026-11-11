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
    draw: { k: 1, ox: 0, oy: 0, P: 1, H: 1 },
    // 地形画法 + 放大后现算的高清瓦片(坐标锚在世界展开平面,不是屏幕,所以拖动时缓存照样命中)
    style: 'fantasy',
    tiles: new Map(),
    tilePending: new Set(),
    tileTimer: 0,
    tileSeq: 0,
    tileRetry: 0,
    lod: 0,
    vec: null,
    vecWorldId: null,
    sel: null,
    grid: null,
    colors: {},
    autoOn: false,
    busy: false,
    tab: 'decisions',
    toastTimer: 0,
    field: { on: false, img: null, data: null, legend: null, kind: 'magic' },
    magic: { on: false, img: null, data: null, legend: null, meta: null, year: null },
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
    magicField: $('#magicField'),
    magicStrength: $('#magicStrength'),
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
    fieldEnable: $('#fieldEnable'),
    fieldKind: $('#fieldKind'),
    fieldRamp: $('#fieldRamp'),
    fieldStretch: $('#fieldStretch'),
    fieldOpacity: $('#fieldOpacity'),
    fieldOpacityVal: $('#fieldOpacityVal'),
    fieldContour: $('#fieldContour'),
    fieldGlow: $('#fieldGlow'),
    fieldHillshade: $('#fieldHillshade'),
    fieldSmooth: $('#fieldSmooth'),
    fieldSeed: $('#fieldSeed'),
    fieldScale: $('#fieldScale'),
    btnFieldApply: $('#btnFieldApply'),
    btnFieldOff: $('#btnFieldOff'),
    btnFieldData: $('#btnFieldData'),
    fieldStatusLine: $('#fieldStatusLine'),
    fieldLegendWrap: $('#fieldLegendWrap'),
    fieldLegendName: $('#fieldLegendName'),
    fieldLegendHash: $('#fieldLegendHash'),
    fieldLegendBar: $('#fieldLegendBar'),
    fieldLegendTicks: $('#fieldLegendTicks'),
    fieldTip: $('#fieldTip'),
    magicEnable: $('#magicEnable'),
    magicYearPick: $('#magicYearPick'),
    btnMagicNow: $('#btnMagicNow'),
    magicStatusLine: $('#magicStatusLine'),
    magicLegendWrap: $('#magicLegendWrap'),
    magicLegendName: $('#magicLegendName'),
    magicLegendHash: $('#magicLegendHash'),
    magicLegendBar: $('#magicLegendBar'),
    magicLegendTicks: $('#magicLegendTicks'),
    btnWorld: $('#btnWorld'),
    btnEmptyCreate: $('#btnEmptyCreate'),
    btnSession: $('#btnSession'),
    btnRound: $('#btnRound'),
    btnAuto: $('#btnAuto'),
    btnVerify: $('#btnVerify'),
    btnExport: $('#btnExport'),
    paramsPanel: $('#paramsPanel'),
    btnParams: $('#btnParams'),
    btnParamsClose: $('#btnParamsClose'),
    zoomIn: $('#zoomIn'),
    zoomOut: $('#zoomOut'),
    zoomReset: $('#zoomReset'),
    zoomVal: $('#zoomVal'),
    mapStyle: $('#mapStyle'),
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

  // 地图铺满窗口:缩放基准取两向里较大的那个,整张图永远盖住舞台。
  // 横向多出来的部分可以无限拖,拖到头会接上另一侧(和主站一样,世界东西相连)。
  function fitScale() {
    return Math.max(S.cw / Math.max(1, S.mapW), S.ch / Math.max(1, S.mapH));
  }

  function resizeCanvas() {
    if (!el.map || !el.mapWrap) return;
    const rect = el.mapWrap.getBoundingClientRect();
    S.cw = Math.max(240, Math.round(rect.width));
    S.ch = Math.max(180, Math.round(rect.height));
    S.dpr = Math.min(2, window.devicePixelRatio || 1);
    el.map.width = Math.round(S.cw * S.dpr);
    el.map.height = Math.round(S.ch * S.dpr);
    normalizeView();
    draw();
  }

  // 纵向不再夹住:世界是球面,越过极点会接到另一侧。只把累积的位移折回偶数层
  // (两层 = 绕极点转一整圈 360°,画面完全相同),免得长时间拖动后坐标变成很大的浮点数。
  function normalizeView() {
    const H = Math.max(1, S.mapH * fitScale() * S.view.k);
    if (Math.abs(S.view.y) > H * 8) {
      const even = 2 * Math.round(S.view.y / (2 * H));
      S.view.y -= even * H;
    }
    const P = Math.max(1, S.mapW * fitScale() * S.view.k);
    if (Math.abs(S.view.x) > P * 8) S.view.x -= Math.round(S.view.x / P) * P;
  }

  // 世界 x 折算回 [0, mapW):拖出去的那一份按同一条经线算
  function wrapX(mx) {
    const w = Math.max(1, S.mapW);
    return ((mx % w) + w) % w;
  }

  /**
   * 当前视图。ox / oyAbs 是"第 0 层、第 0 份主图左上角"的屏幕位置(不再取模,
   * 因为纵向层的奇偶决定要不要镜像);ox 另给一个落到 [-P, 0) 的版本用来横向平铺。
   */
  function viewMetrics() {
    const k = fitScale() * S.view.k;
    const P = S.mapW * k;
    const H = S.mapH * k;
    const oxAbs = (S.cw - P) / 2 + S.view.x;
    const oyAbs = (S.ch - H) / 2 + S.view.y;
    const ox = ((oxAbs % P) + P) % P - P;
    return { k, P, H, ox, oxAbs, oyAbs };
  }

  function draw() {
    if (!el.map || !ctx) return;
    const { cw, ch, dpr } = S;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!S.baseImg) {
      updateZoomLabel();
      return;
    }

    const { k, P, H, ox, oxAbs, oyAbs } = viewMetrics();
    S.draw = { k, ox, oy: oyAbs, P, H, oxAbs };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 可见的纵向层(可正可负)。奇数层 = 越过一次极点:整张图上下翻转 + 横向挪半圈,
    // 这正是球面在极点的真实接法,和主站地球仪跨极一致;地形、气候、疆域都跟着接上。
    const n0 = Math.floor((0 - oyAbs) / H);
    const n1 = Math.floor((ch - oyAbs) / H);
    const mCount = Math.max(1, Math.ceil(cw / P) + 1);
    const rects = [];
    for (let n = n0; n <= n1; n++) {
      const yTop = oyAbs + n * H;
      if (yTop > ch || yTop + H < 0) continue;
      const odd = ((n % 2) + 2) % 2 === 1;
      for (let m = 0; m <= mCount; m++) {
        const x = ox + m * P - (odd ? P / 2 : 0);
        if (x > cw || x + P < 0) continue;
        rects.push({ x, yTop, odd });
      }
    }
    // 每层先铺底图,再把现算的高清瓦片盖在底图上,最后才叠场 / 魔力 / 疆域,
    // 这样国家颜色不会被地形盖掉。
    for (const r of rects) {
      ctx.save();
      if (r.odd) { ctx.translate(0, 2 * r.yTop + H); ctx.scale(1, -1); }
      ctx.drawImage(S.baseImg, r.x, r.yTop, P, H);
      ctx.restore();
    }
    const nextLod = currentLod();
    if (nextLod !== S.lod) S.tileSeq++;  // 换档时让上一档还没发完的请求作废(缓存留着,来回缩放还能用)
    S.lod = nextLod;
    drawHiTiles();
    for (const r of rects) {
      ctx.save();
      if (r.odd) { ctx.translate(0, 2 * r.yTop + H); ctx.scale(1, -1); }
      const overlays = [S.field.on ? S.field.img : null, S.magic.on ? S.magic.img : null, S.ownersImg];
      for (const img of overlays) if (img) ctx.drawImage(img, r.x, r.yTop, P, H);
      ctx.restore();
    }
    // 墨线 / 波纹 / 符号是矢量,按固定屏幕线宽画在最上层,放大多少倍都不变粗
    drawVectors(rects, k, P, H);
    for (const r of rects) {
      // 文字不能跟着翻转,单独按镜像后的位置画
      if (S.state) drawLabels(ctx, r.x, r.yTop, k, r.odd, H);
    }
    scheduleTiles();
    updateZoomLabel();
  }

  /* ------------------------------------------------------------------ *
   * 放大后按倍数现算的高清地形(和主站 tileWorker 同一套 rasterizeWindow)
   *
   * 底图是 1 倍主图(2048 × 1024),够缩小时用;放大到超过它以后,服务端按当前
   * 倍数把屏幕上那几块重新铺像素 + 上色,前端只负责贴。块的坐标锚在球面展开
   * 平面上(不是屏幕上),所以拖动时已经算过的块还能接着用。
   * ------------------------------------------------------------------ */
  const TILE = 512;
  const LOD_MAX = 16;

  function currentLod() {
    const kd = fitScale() * S.view.k * S.dpr;
    // 1 倍底图(2048 宽)本身够缩小时用。高分屏上 100% 的 kd 也可能 > 1,但那样
    // 只会生成 1.4 倍的低档瓦片,和整图拼起来反而出现细线 / 色块(见"缩小错乱"),
    // 所以只有真正放大到 2 倍档才现算,最小档也从 2 倍起。
    if (kd <= 1.8 || S.style === 'classic') return 0;
    // √2 一档:倍数小幅变化时不必重算,又能在 2 / 4 / 8 倍明显提分辨率
    return clamp(2 ** (Math.round(Math.log2(kd) * 2) / 2), 2, LOD_MAX);
  }

  function clearTiles() {
    S.tiles.clear();
    S.tilePending.clear();
    S.tileSeq++;
    S.tileRetry = 0;
    if (S.tileTimer) clearTimeout(S.tileTimer);
    S.tileTimer = 0;
  }

  function scheduleTiles() {
    if (!S.worldId || S.style === 'classic' || !S.lod) return;
    if (S.tileTimer) clearTimeout(S.tileTimer);
    S.tileTimer = setTimeout(() => { S.tileTimer = 0; void loadHiTiles(); }, 180);
  }

  /** 当前视口需要哪些块,以及每块贴在屏幕哪里 */
  function tileGrid() {
    if (!S.lod || !S.baseImg || !S.worldId) return null;
    const { k, oxAbs, oyAbs } = viewMetrics();
    const f = S.lod / k;
    const step = TILE * k / S.lod;
    return {
      lod: S.lod, step, oxAbs, oyAbs,
      i0: Math.floor((-oxAbs * f) / TILE),
      i1: Math.floor(((S.cw - oxAbs) * f) / TILE),
      j0: Math.floor((-oyAbs * f) / TILE),
      j1: Math.floor(((S.ch - oyAbs) * f) / TILE),
    };
  }

  function drawHiTiles() {
    const g = tileGrid();
    if (!g) return;
    for (let j = g.j0; j <= g.j1; j++) {
      for (let i = g.i0; i <= g.i1; i++) {
        const img = S.tiles.get(`${g.lod}|${i}|${j}`);
        if (!img) continue;
        ctx.drawImage(img, g.oxAbs + i * g.step, g.oyAbs + j * g.step, g.step + 0.6, g.step + 0.6);
      }
    }
  }

  async function loadHiTiles() {
    const g = tileGrid();
    if (!g) return;
    const seq = S.tileSeq;
    const style = S.style;   // 换画法时旧任务必须整批作废,否则会用新画法 + 旧倍数发请求
    const want = [];
    for (let j = g.j0; j <= g.j1; j++) {
      for (let i = g.i0; i <= g.i1; i++) {
        const key = `${g.lod}|${i}|${j}`;
        if (!S.tiles.has(key) && !S.tilePending.has(key)) want.push({ i, j, key });
      }
    }
    if (!want.length) return;
    // 屏幕中间的先算,观感上先清楚起来;最多一批 3 块并发
    const cx = (g.i0 + g.i1) / 2;
    const cy = (g.j0 + g.j1) / 2;
    want.sort((a, b) => (Math.abs(a.i - cx) + Math.abs(a.j - cy)) - (Math.abs(b.i - cx) + Math.abs(b.j - cy)));
    const jobs = want.slice(0, 16);
    for (const w of jobs) S.tilePending.add(w.key);
    const stale = () => seq !== S.tileSeq || S.style !== style || S.lod !== g.lod;
    const one = async (w) => {
      if (stale()) { S.tilePending.delete(w.key); return; }
      const url = `/api/map/tile?worldId=${encodeURIComponent(S.worldId)}&style=${encodeURIComponent(style)}`
        + `&S=${g.lod}&x=${w.i * TILE}&y=${w.j * TILE}&size=${TILE}`;
      try {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const img = await createImageBitmap(await r.blob());
        if (stale()) return;
        S.tiles.set(w.key, img);
        if (S.tiles.size > 160) {
          const first = S.tiles.keys().next().value;
          if (first) S.tiles.delete(first);
        }
        draw();
      } catch (_) {
        // 单块失败(代理超时等)就继续用拉伸的底图,晚点再试一次,不打断对局
        if (!stale() && S.tileRetry < 3) {
          S.tileRetry++;
          setTimeout(() => scheduleTiles(), 1400);
        }
      } finally {
        S.tilePending.delete(w.key);
      }
    };
    for (let p = 0; p < jobs.length; p += 3) await Promise.all(jobs.slice(p, p + 3).map(one));
  }

  /* ------------------------------------------------------------------ *
   * 矢量细节层(主站 render/detail.ts 的做法):海岸线、近岸波纹、山/树符号
   *
   * 底图与高清瓦片里的墨线 / 波纹已经在服务端去掉,这里按固定屏幕线宽画。
   * 所以放大到 1200% 墨线仍是 1.15px、符号按倍数分级变多,而不是把位图拉糊。
   * ------------------------------------------------------------------ */
  function withBox(line) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < line.length; i += 2) {
      const x = line[i], y = line[i + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return { p: line, x0, y0, x1, y1 };
  }

  function loadVectors() {
    if (S.style !== 'fantasy') return;
    if (S.vec && S.vecWorldId === S.worldId) return;
    const wid = S.worldId;
    fetch(`/api/map/vectors?worldId=${encodeURIComponent(wid)}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((v) => {
        if (wid !== S.worldId) return;
        v.coast = v.coast.map(withBox);
        v.lake = v.lake.map(withBox);
        v.ripple = v.ripple.map((group) => group.map(withBox));
        v.coastFine = v.coastFine.map(withBox);
        v.lakeFine = v.lakeFine.map(withBox);
        v.rippleFine = v.rippleFine.map((group) => group.map(withBox));
        S.vec = v;
        S.vecWorldId = wid;
        draw();
      })
      .catch(() => {
        // 拿不到矢量层多半是监视台进程还是旧代码(没重启),此时位图墨线已被服务端抹掉,
        // 画面会缺描边。明确提示,别让用户以为是地图坏了。
        S.vec = null;
        toast('矢量地图数据加载失败:请关掉旧窗口、重新双击 启动.bat', true);
      });
  }

  function drawGlyph(g, x, y, unit) {
    const kind = g[2];
    // 后几级(放大后才出现)的符号画小一点:像主站那样一级一级补细节,而不是一起撑成大三角
    const tier = 1 / (1 + Math.log2(Math.max(1, g[7])) * 0.55);
    const s = clamp(g[3] * unit * tier, 2.5, 24);
    const w = s * (0.75 + g[6] * 0.12);
    ctx.lineWidth = clamp(s * 0.085, 0.8, 1.5);
    ctx.strokeStyle = 'rgba(58,45,34,0.78)';
    ctx.fillStyle = 'rgba(238,228,201,0.82)';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (kind === 0 || kind === 7) {          // 山 / 火山
      ctx.moveTo(x - w, y);
      ctx.lineTo(x - w * 0.12, y - s * 0.9);
      ctx.lineTo(x + w, y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - w * 0.12, y - s * 0.9);
      ctx.lineTo(x + w * 0.16, y - s * 0.45);
      ctx.lineTo(x + w * 0.38, y);
      ctx.stroke();
      if (kind === 7) {
        ctx.beginPath();
        ctx.moveTo(x - w * 0.12, y - s * 0.9);
        ctx.quadraticCurveTo(x + w * 0.1, y - s * 1.3, x, y - s * 1.55);
        ctx.stroke();
      }
    } else if (kind === 1) {                 // 丘陵
      ctx.moveTo(x - s * 0.7, y);
      ctx.quadraticCurveTo(x, y - s * 0.85, x + s * 0.7, y);
      ctx.stroke();
    } else if (kind === 5) {                 // 沙丘
      ctx.moveTo(x - s * 0.6, y);
      ctx.quadraticCurveTo(x - s * 0.1, y - s * 0.45, x + s * 0.6, y);
      ctx.stroke();
    } else if (kind === 6) {                 // 草丛
      for (let i = -1; i <= 1; i++) {
        ctx.moveTo(x + i * s * 0.18, y);
        ctx.lineTo(x + i * s * 0.18 + s * 0.12, y - s * 0.5);
      }
      ctx.stroke();
    } else {                                 // 沼泽
      ctx.moveTo(x - s * 0.5, y);
      ctx.lineTo(x + s * 0.5, y);
      ctx.moveTo(x - s * 0.35, y - s * 0.22);
      ctx.lineTo(x + s * 0.2, y - s * 0.22);
      ctx.stroke();
    }
  }

  function drawVectors(rects, k, P, H) {
    const v = S.vec;
    if (!v || S.style !== 'fantasy' || !rects.length) return;
    const { cw, ch } = S;
    const W = S.mapW;
    const sx = P / S.mapW;              // 屏幕像素 / 整图像素
    const sy = H / S.mapH;
    const relK = S.view.k;              // 1 = 默认视图;符号的分级 / 收缩按相对倍数算
    const gs = relK <= 1.35 ? 1 : Math.pow(relK / 1.35, -0.22);
    const unit = gs * sx;               // 符号大小:比地图放大得慢,不会撑满屏幕
    const fine = relK >= 2.5;           // 放大后换成没怎么抽稀的线,曲线才不会被放大成折线
    const coast = fine ? v.coastFine : v.coast;
    const lake = fine ? v.lakeFine : v.lake;
    const ripples = fine ? v.rippleFine : v.ripple.slice(0, 2);

    for (const r of rects) {
      const fx = (px) => r.x + px * sx;
      const fy = (py) => (r.odd ? r.yTop + H - py * sy : r.yTop + py * sy);
      // 逐线段裁剪,而不是整条折线的包围盒:长海岸线可能横跨整幅地图,用整条线的
      // bbox 判断会漏画局部;一次塞进超长路径描边也可能丢后半段。每 3000 段 flush 一次。
      const strokeLines = (lists, color, lw) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        ctx.beginPath();
        let seg = 0;
        for (const list of lists) {
          for (const b of list) {
            const p = b.p;
            // 东西相连:跨 180° 经线的海岸线会伸出左右边界,要在另一侧再补一份,
            // 否则那段海岸只在"某一份平铺副本"里出现,拖到屏幕边缘就没了(主站 chunkPath / wrapShifts 同款)。
            const shifts = b.x1 > W ? [0, -W] : b.x0 < 0 ? [0, W] : [0];
            for (const sh of shifts) {
              for (let i = 0; i + 3 < p.length; i += 2) {
                const x0 = fx(p[i] + sh), y0 = fy(p[i + 1]);
                const x1 = fx(p[i + 2] + sh), y1 = fy(p[i + 3]);
                if (!Number.isFinite(x0 + y0 + x1 + y1)) continue;
                if (Math.max(x0, x1) < -6 || Math.min(x0, x1) > cw + 6
                  || Math.max(y0, y1) < -6 || Math.min(y0, y1) > ch + 6) continue;
                ctx.moveTo(x0, y0);
                ctx.lineTo(x1, y1);
                if (++seg >= 3000) { ctx.stroke(); ctx.beginPath(); seg = 0; }
              }
            }
          }
        }
        ctx.stroke();
      };
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      strokeLines(ripples, 'rgba(58,45,34,0.17)', 1);
      strokeLines([lake, coast], 'rgba(58,45,34,0.86)', 1.15);
      ctx.restore();
      for (const g of v.glyphs) {
        if (g[7] > relK + 0.01) continue;   // z:放大后逐级出现更多符号
        const gy = r.odd ? r.yTop + H - g[1] * sy : r.yTop + g[1] * sy;
        if (gy < -24 || gy > ch + 24) continue;
        // 贴着 ±180° 经线的符号也在另一侧补一份,免得拖到边缘时缺一截
        const shifts = g[0] < 24 ? [0, W] : g[0] > W - 24 ? [0, -W] : [0];
        for (const sh of shifts) {
          const gx = r.x + (g[0] + sh) * sx;   // 位置跟着地图,不跟着符号缩放
          if (gx < -24 || gx > cw + 24) continue;
          drawGlyph(g, gx, gy, unit);
        }
      }
    }
  }

  function updateZoomLabel() {
    if (el.zoomVal) el.zoomVal.textContent = `${Math.round(S.view.k * 100)}%`;
  }

  function drawLabels(c, ox, oy, k, odd, H) {
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
      const sy = odd ? oy + H - p.capital.y * S.mapH * k : oy + p.capital.y * S.mapH * k;
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

  /** 屏幕点 → 主图上的 (mx, my)。跨极层按 draw() 用的同一套镜像 / 半圈偏移反算。 */
  function mapPointAt(x, y) {
    const { k, ox, oy } = S.draw;
    const ux = wrapX((x - ox) / k);
    const vy = (y - oy) / k;
    const n = Math.floor(vy / S.mapH);
    const odd = ((n % 2) + 2) % 2 === 1;
    const mx = odd ? wrapX(ux - S.mapW / 2) : ux;
    const my = odd ? (n + 1) * S.mapH - vy : vy - n * S.mapH;
    if (my < 0 || my > S.mapH) return null;
    return { mx, my };
  }

  function pickPolity(clientX, clientY) {
    if (!el.map || !S.grid) return null;
    const rect = el.map.getBoundingClientRect();
    const p = mapPointAt(clientX - rect.left, clientY - rect.top);
    if (!p) return null;
    const gx = Math.floor((p.mx / S.mapW) * S.grid.w);
    const gy = Math.floor((p.my / S.mapH) * S.grid.h);
    if (gx < 0 || gy < 0 || gx >= S.grid.w || gy >= S.grid.h) return null;
    const id = S.grid.owner[gy * S.grid.w + gx];
    return typeof id === 'number' && id >= 0 ? id : null;
  }

  // 以 (px, py) 为中心缩放(px/py 是画布内坐标);横向回环时锚点照样对得上
  function zoomAt(factor, px, py) {
    if (!S.baseImg) return;
    const fit = fitScale();
    const k0 = fit * S.view.k;
    const { oxAbs, oy } = S.draw;
    const wx = (px - oxAbs) / k0;
    const wy = (py - oy) / k0;
    const next = clamp(S.view.k * factor, 1, 12);
    if (Math.abs(next - S.view.k) < 1e-4) return;
    S.view.k = next;
    const k2 = fit * next;
    S.view.x = px - wx * k2 - (S.cw - S.mapW * k2) / 2;
    S.view.y = py - wy * k2 - (S.ch - S.mapH * k2) / 2;
    normalizeView();
    draw();
  }

  function resetView() {
    S.view = { k: 1, x: 0, y: 0 };
    normalizeView();
    draw();
  }

  // 浮窗的开关:参数抽屉、面板收起、缩放按钮
  function bindChrome() {
    const setParams = (on) => {
      if (!el.paramsPanel) return;
      el.paramsPanel.hidden = !on;
      document.body.classList.toggle('params-open', on);
      if (el.btnParams) el.btnParams.setAttribute('aria-expanded', on ? 'true' : 'false');
    };
    el.btnParams?.addEventListener('click', () => setParams(el.paramsPanel ? el.paramsPanel.hidden : false));
    el.btnParamsClose?.addEventListener('click', () => setParams(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el.paramsPanel && !el.paramsPanel.hidden) setParams(false);
    });

    for (const btn of $$('[data-fold]')) {
      btn.addEventListener('click', () => {
        const panel = document.getElementById(btn.dataset.fold);
        if (!panel) return;
        const folded = panel.classList.toggle('folded');
        btn.setAttribute('aria-label', folded ? '展开面板' : '收起面板');
        btn.title = folded ? '展开' : '收起';
      });
    }

    el.zoomIn?.addEventListener('click', () => zoomAt(1.5, S.cw / 2, S.ch / 2));
    el.zoomOut?.addEventListener('click', () => zoomAt(1 / 1.5, S.cw / 2, S.ch / 2));
    el.zoomReset?.addEventListener('click', () => resetView());

    // 窄屏先把国家面板收起来,地图留大点
    if (window.innerWidth < 860) {
      const side = document.getElementById('sidePanel');
      if (side) side.classList.add('folded');
    }
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
      if (!drag) {
        showFieldTip(e);
        return;
      }
      setFieldTipVisible(false);
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
      S.view.x = drag.ox + dx;
      S.view.y = drag.oy + dy;
      normalizeView();
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
    el.map.addEventListener('pointerleave', () => setFieldTipVisible(false));
    el.map.addEventListener('dblclick', (e) => {
      if (!S.baseImg) return;
      const rect = el.map.getBoundingClientRect();
      zoomAt(1.6, e.clientX - rect.left, e.clientY - rect.top);
    });
    el.map.addEventListener('wheel', (e) => {
      if (!S.baseImg) return;
      e.preventDefault();
      const rect = el.map.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0012), e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });
  }

  async function loadBaseMap(keepView = false) {
    if (!S.worldId) return;
    el.mapLoading.classList.remove('hidden');
    el.mapLoadingText.textContent = '地图绘制中…';
    el.mapEmpty.classList.add('hidden');
    try {
      const r = await fetch(`/api/map/base?worldId=${encodeURIComponent(S.worldId)}&style=${encodeURIComponent(S.style)}`);
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { msg = (await r.json()).error || msg; } catch (_) { /* ignore */ }
        throw new Error(msg);
      }
      const blob = await r.blob();
      S.baseImg = await createImageBitmap(blob);
      S.mapW = S.baseImg.width;
      S.mapH = S.baseImg.height;
      if (!keepView) S.view = { k: 1, x: 0, y: 0 };
      clearTiles();
      resizeCanvas();
      void loadVectors();
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
   * 自定义场(原型:计算层给数值,渲染层只上色)
   * ------------------------------------------------------------------ */

  const FIELD_KIND_CN = { magic: '魔脉浓度', ore: '矿产资源', radiation: '辐射本底' };

  function fieldQuery() {
    const q = new URLSearchParams();
    q.set('worldId', S.worldId || '');
    q.set('kind', el.fieldKind ? el.fieldKind.value : 'magic');
    const seed = el.fieldSeed && el.fieldSeed.value.trim();
    if (seed) q.set('seed', seed);
    const scale = Number(el.fieldScale && el.fieldScale.value);
    if (Number.isFinite(scale)) q.set('scale', String(scale));
    q.set('ramp', el.fieldRamp.value);
    q.set('stretch', el.fieldStretch.value);
    q.set('opacity', String(Number(el.fieldOpacity.value) || 0.85));
    q.set('contour', el.fieldContour.checked ? '6' : '0');
    q.set('glow', el.fieldGlow.checked ? '1' : '0');
    q.set('hillshade', el.fieldHillshade.checked ? '1' : '0');
    q.set('smooth', el.fieldSmooth.checked ? '1' : '0');
    return q;
  }

  function decodeB64(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function decodeFieldData(d) {
    const vb = decodeB64(d.values);
    const gb = decodeB64(d.grid);
    return {
      ...d,
      values: new Float32Array(vb.buffer, vb.byteOffset, vb.byteLength / 4),
      grid: new Int32Array(gb.buffer, gb.byteOffset, gb.byteLength / 4),
    };
  }

  function setFieldTipVisible(on) {
    if (!el.fieldTip) return;
    el.fieldTip.classList.toggle('hidden', !on);
    if (!on) el.fieldTip.textContent = '';
  }

  function showFieldTip(e) {
    const field = S.field.on && S.field.data ? S.field.data : null;
    const magic = S.magic.on && S.magic.data ? S.magic.data : null;
    if ((!field && !magic) || !el.map) return setFieldTipVisible(false);
    const rect = el.map.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const p = mapPointAt(x, y);
    if (!p) return setFieldTipVisible(false);
    const { mx, my } = p;
    const lon = ((mx / S.mapW) * 360 - 180).toFixed(1);
    const lat = (90 - (my / S.mapH) * 180).toFixed(1);
    const lines = [];
    if (field) {
      const gx = Math.min(field.gridW - 1, Math.max(0, Math.floor((mx / S.mapW) * field.gridW)));
      const gy = Math.min(field.gridH - 1, Math.max(0, Math.floor((my / S.mapH) * field.gridH)));
      const cell = field.grid[gy * field.gridW + gx];
      if (typeof cell !== 'number' || cell < 0 || cell >= field.values.length) {
        if (!magic) return setFieldTipVisible(false);
      } else {
        lines.push(`<b>${esc(field.label)}</b> <span class="field-tip-value">${field.values[cell].toFixed(6)}</span>`);
        lines.push(`<span class="muted">地块 #${cell} · ${lon}°E, ${lat}°N · hash ${short(field.hash, 10)}</span>`);
      }
    }
    if (magic) {
      const gx = Math.min(magic.gridW - 1, Math.max(0, Math.floor((mx / S.mapW) * magic.gridW)));
      const gy = Math.min(magic.gridH - 1, Math.max(0, Math.floor((my / S.mapH) * magic.gridH)));
      const region = magic.grid[gy * magic.gridW + gx];
      if (typeof region === 'number' && region >= 0 && region < magic.values.length) {
        if (lines.length) lines.push('<span class="muted">——</span>');
        lines.push(`<b>魔力浓度</b> <span class="field-tip-value">${magic.values[region].toFixed(4)}</span>`);
        lines.push(`<span class="muted">第 ${fmtInt(magic.frameYear)} 年图层(取不晚于本回合的帧)· 州 #${region} · ${lon}°E, ${lat}°N</span>`);
      } else if (!lines.length) {
        return setFieldTipVisible(false);
      }
    }
    el.fieldTip.innerHTML = lines.join('<br>');
    el.fieldTip.classList.remove('hidden');
    const bx = Math.min(S.cw - 250, Math.max(6, x + 14));
    const by = Math.max(6, y - 54);
    el.fieldTip.style.left = `${bx}px`;
    el.fieldTip.style.top = `${by}px`;
  }

  function renderFieldLegend() {
    const lg = S.field.legend;
    if (!lg || !el.fieldLegendWrap) return;
    el.fieldLegendWrap.classList.remove('hidden');
    el.fieldLegendName.textContent = `${lg.label} · ${lg.rampLabel || ''}`;
    el.fieldLegendHash.textContent = S.field.data ? `hash ${S.field.data.hash}` : '';
    el.fieldLegendBar.style.background = `linear-gradient(90deg, ${(lg.stops || []).map((s) => `${s.hex} ${(s.t * 100).toFixed(1)}%`).join(', ')})`;
    el.fieldLegendTicks.innerHTML = (lg.ticks || [])
      .map((t) => `<span style="left:${(t.t * 100).toFixed(2)}%"><i></i>${t.value.toFixed(3)}</span>`)
      .join('');
  }

  function updateFieldStatus() {
    if (!el.fieldStatusLine) return;
    if (!S.field.data) {
      el.fieldStatusLine.textContent = '先创建世界,再生成场。PNG 只是上色;数值以计算层和 hover 为准。';
      return;
    }
    const d = S.field.data;
    el.fieldStatusLine.textContent =
      `${d.label} · ${fmtInt(d.cells)} 地块 · hash ${short(d.hash, 12)} · ` +
      `min ${d.stats.min.toFixed(4)} / mean ${d.stats.mean.toFixed(4)} / max ${d.stats.max.toFixed(4)} · ` +
      `改样式不会重算数值`;
  }

  async function applyField() {
    if (!S.worldId || S.busy) return;
    const q = fieldQuery();
    const kind = q.get('kind');
    try {
      setBusy(true, '正在生成场…', '计算层先算出一格一个数;渲染层再按样式上色。');
      const pngRes = await fetch(`/api/field/base?${q}`);
      if (!pngRes.ok) {
        let msg = `HTTP ${pngRes.status}`;
        try { msg = (await pngRes.json()).error || msg; } catch (_) { /* ignore */ }
        throw new Error(msg);
      }
      const blob = await pngRes.blob();
      const dataRaw = await api(`/api/field/data?${q}`);
      if (S.field.img && S.field.img.close) {
        try { S.field.img.close(); } catch (_) { /* ImageBitmap.close 在部分环境不存在 */ }
      }
      S.field.img = await createImageBitmap(blob);
      S.field.data = decodeFieldData(dataRaw);
      S.field.legend = dataRaw.legend;
      S.field.kind = kind;
      S.field.on = true;
      el.fieldEnable.checked = true;
      renderFieldLegend();
      updateFieldStatus();
      draw();
      toast(`场已生成:${dataRaw.label} · ${fmtInt(dataRaw.cells)} 地块 · hash ${short(dataRaw.hash, 12)}`);
    } catch (e) {
      toast(`生成场失败:${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(false);
      refreshButtons();
    }
  }

  function hideField() {
    S.field.on = false;
    if (el.fieldEnable) el.fieldEnable.checked = false;
    setFieldTipVisible(false);
    draw();
    refreshButtons();
  }

  async function exportFieldData() {
    if (!S.field.data) {
      toast('先生成场,才能导出数值', true);
      return;
    }
    const d = S.field.data;
    const values = Array.from(d.values, (v) => Number(v.toFixed(8)));
    const payload = {
      note: '每个地块一个值;索引对应 1024 宽地图最近地块。计算层数值,未经渲染修改。',
      kind: d.kind,
      label: d.label,
      cells: d.cells,
      version: d.version,
      hash: d.hash,
      stats: d.stats,
      values,
    };
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `field-${d.kind}-${String(d.hash).slice(0, 8)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast(`已导出 ${d.label} 数值:${fmtInt(d.cells)} 个地块,${fmtInt(blob.size)} 字节`);
  }

  let fieldTimer = 0;
  function scheduleField() {
    window.clearTimeout(fieldTimer);
    fieldTimer = window.setTimeout(() => {
      if (S.worldId && el.fieldEnable.checked) void applyField();
    }, 260);
  }

  /* ------------------------------------------------------------------ *
   * 本局动态层:魔力(引擎逐年演化、真影响城上限)
   * ------------------------------------------------------------------ */

  function decodeMagicData(d) {
    const vb = decodeB64(d.values);
    const gb = decodeB64(d.grid);
    return {
      ...d,
      values: new Float32Array(vb.buffer, vb.byteOffset, vb.byteLength / 4),
      grid: new Int32Array(gb.buffer, gb.byteOffset, gb.byteLength / 4),
    };
  }

  function renderMagicLegend() {
    const lg = S.magic.legend;
    if (!lg || !el.magicLegendWrap) return;
    el.magicLegendWrap.classList.remove('hidden');
    el.magicLegendName.textContent = `${lg.title || '魔力浓度'} · ${lg.legend || ''}`;
    el.magicLegendHash.textContent = S.magic.year === null ? '' : `第 ${fmtInt(S.magic.year)} 年 · 图层帧 ${fmtInt(S.magic.data && S.magic.data.frameYear)}`;
    el.magicLegendBar.style.background = `linear-gradient(90deg, ${(lg.colors || []).map((c, i, a) => `${c} ${((i / Math.max(1, a.length - 1)) * 100).toFixed(1)}%`).join(', ')})`;
    el.magicLegendTicks.innerHTML = (lg.ticks || [])
      .map((t, i, a) => `<span style="left:${((i / Math.max(1, a.length - 1)) * 100).toFixed(2)}%"><i></i>${t.value.toFixed(1)}</span>`)
      .join('');
  }

  function updateMagicStatus(meta, year) {
    if (!el.magicStatusLine) return;
    const d = S.magic.data;
    if (!d) {
      el.magicStatusLine.textContent = '开一个带「魔力场」的会话后,这里会出现逐年图层。';
      return;
    }
    el.magicStatusLine.textContent =
      `魔力强度 ${meta && meta.strength !== null && meta.strength !== undefined ? meta.strength : '?'} · 图层第 ${fmtInt(year)} 年(帧 ${fmtInt(d.frameYear)}) · ` +
      `${fmtInt(d.regions)} 州 · min ${d.stats.min.toFixed(2)} / mean ${d.stats.mean.toFixed(2)} / max ${d.stats.max.toFixed(2)}`;
  }

  function resetMagic(quiet) {
    S.magic.on = false;
    S.magic.meta = null;
    S.magic.data = null;
    S.magic.legend = null;
    S.magic.year = null;
    if (S.magic.img && S.magic.img.close) {
      try { S.magic.img.close(); } catch (_) { /* ignore */ }
    }
    S.magic.img = null;
    if (el.magicLegendWrap) el.magicLegendWrap.classList.add('hidden');
    if (el.magicYearPick) el.magicYearPick.innerHTML = '';
    if (el.magicStatusLine && !quiet) el.magicStatusLine.textContent = '这个会话没有开「魔力场」(创建会话时勾「魔力场」)。';
    draw();
  }

  /** 拉本局魔力图层;year 省略 = 跟当前回合 */
  async function refreshMagic(year) {
    if (!S.sessionId) { resetMagic(true); return; }
    try {
      const sid = encodeURIComponent(S.sessionId);
      const meta = await api(`/api/magic/meta?sessionId=${sid}`);
      S.magic.meta = meta;
      if (!meta || !meta.enabled || !meta.layers || !meta.layers.length) { resetMagic(true); return; }
      const layer = meta.layers[0];
      const years = layer.years || [];
      const playYear = yearOf(meta.year);
      const want = year === undefined ? playYear : Number(year);
      let pick = years.length ? years[0] : playYear;
      for (const y of years) if (y <= want) pick = y;
      if (years.length && want > years[years.length - 1]) pick = years[years.length - 1];
      if (el.magicYearPick) {
        el.magicYearPick.innerHTML = years
          .map((y) => `<option value="${y}"${y === pick ? ' selected' : ''}>第 ${fmtInt(y)} 年</option>`)
          .join('');
      }
      const q = `sessionId=${sid}&year=${encodeURIComponent(String(pick))}`;
      const pngRes = await fetch(`/api/magic/base?${q}`);
      if (!pngRes.ok) {
        let msg = `HTTP ${pngRes.status}`;
        try { msg = (await pngRes.json()).error || msg; } catch (_) { /* ignore */ }
        throw new Error(msg);
      }
      const blob = await pngRes.blob();
      const dataRaw = await api(`/api/magic/data?${q}`);
      if (S.magic.img && S.magic.img.close) {
        try { S.magic.img.close(); } catch (_) { /* ignore */ }
      }
      S.magic.img = await createImageBitmap(blob);
      S.magic.data = decodeMagicData(dataRaw);
      S.magic.legend = dataRaw.legend;
      S.magic.year = pick;
      S.magic.on = !!(el.magicEnable && el.magicEnable.checked);
      if (S.magic.on) renderMagicLegend();
      updateMagicStatus(meta, pick);
      draw();
      refreshButtons();
    } catch (e) {
      toast(`魔力图层加载失败:${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  function hideMagic() {
    S.magic.on = false;
    if (el.magicEnable) el.magicEnable.checked = false;
    setFieldTipVisible(false);
    draw();
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
        return `<div class="ev-row war-line"><div class="ev-text">与 ${others.map(esc).join('、')}:${esc(w.text)} <span class="muted">(${w.year}–${w.end} 年)</span></div></div>`;
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
            <span class="pol-dot dm"></span>
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
    if (el.btnFieldApply) el.btnFieldApply.disabled = !hasWorld || S.busy;
    if (el.btnFieldOff) el.btnFieldOff.disabled = !S.field.on || S.busy;
    if (el.btnFieldData) el.btnFieldData.disabled = !S.field.data || S.busy;
    if (el.magicField) el.magicField.disabled = S.busy;
    if (el.magicStrength) el.magicStrength.disabled = S.busy;
    if (el.magicEnable) el.magicEnable.disabled = !hasSession || S.busy;
    if (el.magicYearPick) el.magicYearPick.disabled = !S.magic.meta || S.busy;
    if (el.btnMagicNow) el.btnMagicNow.disabled = !hasSession || S.busy;
    el.btnAuto.textContent = S.autoOn ? '暂停自动播放' : '自动播放';
    el.btnAuto.classList.toggle('playing', S.autoOn);
    // 已经有世界了就把「创建世界」从主按钮降级,免得一直抢眼
    el.btnWorld.classList.toggle('cta', !hasWorld);
    el.btnWorld.classList.toggle('quiet', hasWorld);
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
      S.field = { on: false, img: null, data: null, legend: null, kind: 'magic' };
      if (el.fieldEnable) el.fieldEnable.checked = false;
      if (el.fieldLegendWrap) el.fieldLegendWrap.classList.add('hidden');
      resetMagic(true);
      setFieldTipVisible(false);
      updateFieldStatus();
      el.polityList.innerHTML = '';
      el.polityDetail.innerHTML = '<div class="side-empty">世界建好了,点「开始会话」让 AI 君主接管。</div>';
      setStatus(`${d.worldId} · ${fmtInt(d.cells)} 地块 · 生成 ${d.generatedMs} ms`);
      setHint(`世界 ${d.worldId} 已生成(${fmtInt(d.cells)} 地块)。下一步:设置起始年,点「开始会话」。`);
      await loadBaseMap();
      if (S.baseImg) el.mapEmpty.classList.add('hidden');
      if (el.mapTitle) el.mapTitle.textContent = '世界已就绪';
      if (el.mapSub) el.mapSub.textContent = '主站同款地形画法 · 东西与跨极都能无限拖动 · 放大会现算高清 · 下一步点「② 开始会话」';
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
        magicField: el.magicField.checked,
        magicStrength: Number(el.magicStrength.value) || 1,
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
    if (state.magic) void refreshMagic();
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
    if (el.mapStyle) {
      el.mapStyle.value = S.style;
      el.mapStyle.addEventListener('change', () => {
        S.style = el.mapStyle.value;
        if (!S.worldId) return;
        clearTiles();
        void loadBaseMap(true);   // 换画法不重置缩放 / 拖动位置
      });
    }
    el.btnWorld.addEventListener('click', () => { void createWorld(); });
    if (el.btnEmptyCreate) el.btnEmptyCreate.addEventListener('click', () => { void createWorld(); });
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

    el.btnFieldApply.addEventListener('click', () => { void applyField(); });
    el.btnFieldOff.addEventListener('click', hideField);
    el.btnFieldData.addEventListener('click', () => { void exportFieldData(); });

    el.fieldEnable.addEventListener('change', () => {
      if (!el.fieldEnable.checked) { hideField(); return; }
      if (S.field.img) {
        S.field.on = true;
        renderFieldLegend();
        updateFieldStatus();
        draw();
        refreshButtons();
      } else {
        void applyField();
      }
    });
    [el.fieldKind, el.fieldRamp, el.fieldStretch, el.fieldContour, el.fieldGlow, el.fieldHillshade, el.fieldSmooth, el.fieldSeed, el.fieldScale]
      .forEach((ctl) => ctl && ctl.addEventListener('change', () => { if (el.fieldEnable.checked) scheduleField(); }));
    el.fieldOpacity.addEventListener('input', () => {
      el.fieldOpacityVal.textContent = (Number(el.fieldOpacity.value) || 0.85).toFixed(2);
      if (el.fieldEnable.checked) scheduleField();
    });
    el.fieldOpacityVal.textContent = (Number(el.fieldOpacity.value) || 0.85).toFixed(2);

    if (el.magicEnable) {
      el.magicEnable.addEventListener('change', () => {
        if (!el.magicEnable.checked) { hideMagic(); return; }
        S.magic.on = true;
        if (S.magic.data) {
          renderMagicLegend();
          draw();
          refreshButtons();
        } else {
          void refreshMagic();
        }
      });
    }
    if (el.magicYearPick) {
      el.magicYearPick.addEventListener('change', () => { void refreshMagic(Number(el.magicYearPick.value)); });
    }
    if (el.btnMagicNow) {
      el.btnMagicNow.addEventListener('click', () => { void refreshMagic(); });
    }

    window.addEventListener('resize', () => resizeCanvas());
    if (window.ResizeObserver && el.mapWrap) {
      new ResizeObserver(() => resizeCanvas()).observe(el.mapWrap);
    }
    bindMap();
    bindChrome();

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
