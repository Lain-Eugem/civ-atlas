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
    ownerBorders: null,
    // 后台预加载的其它画法底图:style -> { img, w, h };换世界时清空
    baseCache: new Map(),
    baseCacheWorldId: null,
    // 矢量层(fantasy / white)的离屏缓存:一帧只画一次,拖动时贴图
    vecCache: null,
    mapW: 1024,
    mapH: 512,
    cw: 800,
    ch: 480,
    dpr: 1,
    /** 画布实际的设备像素比(交互中也不降,见 resizeCanvas) */
    rdpr: 1,
    view: { k: 1, x: 0, y: 0 },
    draw: { k: 1, ox: 0, oy: 0, P: 1, H: 1 },
    // 地形画法 + 放大后现算的高清瓦片(坐标锚在世界展开平面,不是屏幕,所以拖动时缓存照样命中)
    style: 'fantasy',
    tiles: new Map(),
    // 每块瓦片自带的海岸线(key 与 tiles 同):瓦片内坐标的 Path2D,跟着贴图一起缩放
    tileLines: new Map(),
    // 本帧画了自带海岸线的瓦片在屏幕上的矩形,用来把全局那份(1 倍底图追的)裁掉
    tileCover: [],
    /** 当前层的瓦片已经铺满视口(此时全局海岸线整份都不用画) */
    tileFull: false,
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
    /** 复核模式下待提交的回合方案(mcp/monarch.ts 的 MonarchPlan) */
    plan: null,
    toastTimer: 0,
    field: { on: false, img: null, data: null, legend: null, kind: 'magic' },
    // 魔力层:整张 2048 图用于缩小时;放大后按地形同款瓦片贴,柔边/光晕按瓦片像素算
    magic: { on: false, img: null, data: null, legend: null, meta: null, year: null, colors: null },
    magicTiles: new Map(),
    magicPending: new Set(),
    magicSeq: 0,
    magicTimer: 0,
    magicLoading: false,
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
    magicPalette: $('#magicPalette'),
    magicColor0: $('#magicColor0'),
    magicColor1: $('#magicColor1'),
    magicColor2: $('#magicColor2'),
    btnMagicColorsReset: $('#btnMagicColorsReset'),
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
    featLlm: $('#featLlm'),
    featJev: $('#featJev'),
    reviewMode: $('#reviewMode'),
    reviewPanel: $('#reviewPanel'),
    reviewBody: $('#reviewBody'),
    reviewSub: $('#reviewSub'),
    btnReviewCommit: $('#btnReviewCommit'),
    btnReviewCancel: $('#btnReviewCancel'),
    onboard: $('#onboard'),
    obProvider: $('#obProvider'),
    obBaseUrl: $('#obBaseUrl'),
    obModel: $('#obModel'),
    obKey: $('#obKey'),
    obJevKey: $('#obJevKey'),
    obJevBase: $('#obJevBase'),
    obJevModel: $('#obJevModel'),
    obMock: $('#obMock'),
    obLlmState: $('#obLlmState'),
    obJevState: $('#obJevState'),
    btnOnboardSave: $('#btnOnboardSave'),
    btnOnboardSkip: $('#btnOnboardSkip'),
    toast: $('#toast'),
    busy: $('#busy'),
    busyTitle: $('#busyTitle'),
    busySub: $('#busySub'),
  };

  const ctx = el.map ? el.map.getContext('2d') : null;

  /* ------------------------------------------------------------------ *
   * 本机配置(两把 Key 落盘在 localStorage;只发给 127.0.0.1 的监视台)
   * ------------------------------------------------------------------ */

  const CFG_KEY = 'civSandbox.config.v1';

  function loadCfg() {
    try {
      return JSON.parse(localStorage.getItem(CFG_KEY) || '{}') || {};
    } catch {
      return {};
    }
  }

  function saveCfg(cfg) {
    try {
      localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    } catch {
      /* 隐私模式下写不进去:本次仍可用,只是下次要重填 */
    }
  }

  /** 把存下的配置灌进参数栏与引导浮层(参数栏是实际提交用的那一份) */
  function applyCfg(cfg) {
    if (!cfg) return;
    const llm = cfg.llm || {};
    if (el.provider && llm.provider) el.provider.value = llm.provider;
    if (el.baseUrl) el.baseUrl.value = llm.baseUrl || '';
    if (el.model) el.model.value = llm.model || '';
    if (el.apiKey) el.apiKey.value = llm.apiKey || '';
    const jev = cfg.jev || {};
    if (el.pettyKey) el.pettyKey.value = jev.apiKey || '';
    if (el.obProvider && llm.provider) el.obProvider.value = llm.provider;
    if (el.obBaseUrl) el.obBaseUrl.value = llm.baseUrl || '';
    if (el.obModel) el.obModel.value = llm.model || '';
    if (el.obKey) el.obKey.value = llm.apiKey || '';
    if (el.obJevKey) el.obJevKey.value = jev.apiKey || '';
    if (el.obJevBase) el.obJevBase.value = jev.baseUrl || '';
    if (el.obJevModel) el.obJevModel.value = jev.model || '';
    if (cfg.features) {
      if (el.featLlm) el.featLlm.checked = cfg.features.llm !== false;
      if (el.featJev) el.featJev.checked = !!cfg.features.jev;
    }
    if (el.reviewMode && cfg.review !== undefined) el.reviewMode.checked = !!cfg.review;
    if (el.mock && cfg.mock !== undefined) el.mock.checked = !!cfg.mock;
    if (cfg.style === 'fantasy' || cfg.style === 'satellite' || cfg.style === 'geo' || cfg.style === 'white' || cfg.style === 'classic') {
      S.style = cfg.style;
      if (el.mapStyle) el.mapStyle.value = cfg.style;
    }
    if (Array.isArray(cfg.magicColors) && cfg.magicColors.length >= 2 && cfg.magicColors.every((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c))) {
      S.magic.colors = [...cfg.magicColors];
    }
    syncMagicColorInputs();
  }

  /** 当前参数栏里的配置(保存用) */
  function cfgFromForm() {
    return {
      llm: {
        provider: el.provider ? el.provider.value : 'deepseek',
        baseUrl: el.baseUrl ? el.baseUrl.value.trim() : '',
        model: el.model ? el.model.value.trim() : '',
        apiKey: el.apiKey ? el.apiKey.value : '',
      },
      jev: {
        apiKey: el.pettyKey ? el.pettyKey.value : '',
        baseUrl: el.obJevBase ? el.obJevBase.value.trim() : '',
        model: el.obJevModel ? el.obJevModel.value.trim() : '',
      },
      features: {
        llm: el.featLlm ? el.featLlm.checked : true,
        jev: el.featJev ? el.featJev.checked : false,
      },
      review: el.reviewMode ? el.reviewMode.checked : false,
      mock: el.mock ? el.mock.checked : false,
      style: S.style,
      magicColors: S.magic.colors ? [...S.magic.colors] : null,
      onboarded: true,
    };
  }

  /** 引导浮层里的值 → 参数栏(再一起存) */
  function applyOnboardToForm() {
    if (el.obProvider && el.provider) el.provider.value = el.obProvider.value;
    if (el.obBaseUrl && el.baseUrl) el.baseUrl.value = el.obBaseUrl.value.trim();
    if (el.obModel && el.model) el.model.value = el.obModel.value.trim();
    if (el.obKey && el.apiKey) el.apiKey.value = el.obKey.value;
    if (el.obJevKey && el.pettyKey) el.pettyKey.value = el.obJevKey.value;
  }

  function onboardState() {
    const llmKey = el.obKey ? el.obKey.value.trim() : '';
    const jevKey = el.obJevKey ? el.obJevKey.value.trim() : '';
    if (el.obLlmState) el.obLlmState.textContent = llmKey ? '已填(只存在这台机器)' : '没填:只能先勾 mock 离线演示';
    if (el.obJevState) el.obJevState.textContent = jevKey ? '已填(只存在这台机器)' : '没填:审核与渗透会退回确定性规则';
  }

  function showOnboard() {
    if (!el.onboard) return;
    if (el.obProvider && el.provider) el.obProvider.value = el.provider.value;
    if (el.obBaseUrl && el.baseUrl) el.obBaseUrl.value = el.baseUrl.value;
    if (el.obModel && el.model) el.obModel.value = el.model.value;
    if (el.obKey && el.apiKey) el.obKey.value = el.apiKey.value;
    if (el.obJevKey && el.pettyKey) el.obJevKey.value = el.pettyKey.value;
    el.onboard.hidden = false;
    onboardState();
  }

  function hideOnboard() {
    if (el.onboard) el.onboard.hidden = true;
  }

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
    // 画布分辨率只跟设备像素比走:拖动 / 缩放不再临时降分辨率,免得松手时
    // 画面突然从糊变清晰。高倍率下的清晰度由瓦片负责(拖动中也照贴)。
    S.rdpr = S.dpr;
    // 视口尺寸 / 分辨率变了,矢量层缓存按旧尺寸画的,直接作废
    S.vecCache = null;
    el.map.width = Math.round(S.cw * S.rdpr);
    el.map.height = Math.round(S.ch * S.rdpr);
    normalizeView();
    draw();
  }

  /** 最近一次输入(拖动/滚轮/缩放)的时间:交互中矢量层同步描线,停手 260ms 后换上缓存 */
  let lastInputAt = 0;
  let vecIdleTimer = 0;
  function beginInteractive() {
    lastInputAt = performance.now();
    clearTimeout(vecIdleTimer);
    vecIdleTimer = setTimeout(() => requestDraw(), 260);
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

  /**
   * 把重绘合并到下一帧:拖动 / 滚轮一秒钟能来上百个事件,每个都同步重绘一次会把
   * 主线程和渲染队列一起塞满(实测 dpr2 的 1920×1000 下单帧就要几十毫秒)。
   * 这里保证一帧最多画一次,事件只更新状态。
   */
  let drawTicket = 0;
  function requestDraw() {
    if (drawTicket) return;
    drawTicket = requestAnimationFrame(() => {
      drawTicket = 0;
      draw();
    });
  }

  /** 当前层的瓦片是否已经铺满视口(铺满了就不必再画 1 倍底图和全局海岸线) */
  function tilesCoverView() {
    if (!S.lod || !S.tiles.size) return false;
    const g = tileGridAt(S.lod);
    return !!g && g.step >= 4 && levelComplete(g);
  }

  function draw() {
    if (!el.map || !ctx) return;
    const { cw, ch } = S;
    const rdpr = S.rdpr || S.dpr;
    ctx.setTransform(rdpr, 0, 0, rdpr, 0, 0);
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
    // 这样国家颜色不会被地形盖掉。瓦片已经铺满视口时整张底图都不用画:
    // 高倍率下把 2048 宽的图放大到几万像素再被瓦片完全盖住,纯粹是白fill。
    // 拖动 / 缩放中:跳过高清瓦片,只铺底图(2048 整图比十几块瓦片便宜得多),停手再补
    const interacting = performance.now() - lastInputAt < 200;
    const baseCovered = !interacting && tilesCoverView();
    if (!baseCovered) {
      for (const r of rects) {
        ctx.save();
        if (r.odd) { ctx.translate(0, 2 * r.yTop + H); ctx.scale(1, -1); }
        ctx.drawImage(S.baseImg, r.x, r.yTop, P, H);
        ctx.restore();
      }
    }
    const nextLod = currentLod();
    if (nextLod !== S.lod) S.tileSeq++;  // 换档时让上一档还没发完的请求作废(缓存留着,来回缩放还能用)
    S.lod = nextLod;
    // 拖动 / 缩放中也照样贴已经缓存的高清瓦片(连每块自己的海岸墨线一起)。
    // 以前这里整段跳过,放大后一拖就退回 1 倍底图,看起来像"一动就变糊、松手才清晰"。
    drawHiTiles();
    drawMagicHiTiles();
    const magicSharp = !interacting && S.magic.on && magicTilesCoverView();
    for (const r of rects) {
      ctx.save();
      if (r.odd) { ctx.translate(0, 2 * r.yTop + H); ctx.scale(1, -1); }
      // 魔力层:缩小时用整张 2048 图;放大后等当前层瓦片全部到齐再切瓦片(避免缺块闪烁)。
      const magicFlat = S.magic.on && !magicSharp ? S.magic.img : null;
      const overlays = [S.field.on ? S.field.img : null, magicFlat, S.ownersImg];
      for (const img of overlays) if (img) ctx.drawImage(img, r.x, r.yTop, P, H);
      ctx.restore();
    }
    // 墨线 / 波纹 / 符号是矢量,按固定屏幕线宽画在最上层,放大多少倍都不变粗
    drawVectorsCached();
    drawOwnerBorders(rects);
    for (const r of rects) {
      // 文字不能跟着翻转,单独按镜像后的位置画
      if (S.state) drawLabels(ctx, r.x, r.yTop, k, r.odd, H);
    }
    scheduleTiles();
    scheduleMagicTiles();
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
  // 预渲染只做 2/4/8 三档;把最高档也钉在 8,这样任何放大倍率都落在已渲染的瓦片上,
  // 不会在 1200% 才现算 S=16 的 4096 块。代价是超过 800% 时瓦片最多放大到 1.5 倍。
  const LOD_MAX = 8;
  /**
   * 底图 / 瓦片 URL 的版本号。服务端把它们标成 immutable 让浏览器长期缓存,
   * 所以只要改了地形或上色的算法,这里就要 +1,否则老浏览器会一直用旧图。
   */
  // 改地形 / 上色算法时 +1:瓦片和底图都是 immutable 缓存,不换 URL 老浏览器会一直用旧图
  const MAP_VER = 5;
  /** 与 mcp/terrain.ts 的 TERRAIN_STYLES 一致 */
  const STYLES = ['fantasy', 'satellite', 'geo', 'white', 'classic'];

  function currentLod() {
    const kd = fitScale() * S.view.k * S.dpr;
    // 1 倍底图(2048 宽)本身够缩小时用。高分屏上 100% 的 kd 也可能 > 1,但那样
    // 只会生成 1.4 倍的低档瓦片,和整图拼起来反而出现细线 / 色块(见"缩小错乱"),
    // 所以只有真正放大到 2 倍档才现算,最小档也从 2 倍起。
    if (kd <= 1.8 || S.style === 'classic') return 0;
    // 只取 2 的整数次幂:这样一圈地图正好 tileCols(lod)=4*lod 列、一层 tileRows(lod)=2*lod 行,
    // 都是整数 —— 同一块世界区域不管落在哪个重复单元,列号取模后都是同一个键、同一张图,
    // 拖到第几个"世界"都不用重渲,也不会出现越拖越大的坐标。档数还比 √2 少一半。
    return clamp(2 ** Math.round(Math.log2(kd)), 2, LOD_MAX);
  }

  function clearTiles() {
    S.tiles.clear();
    S.tileLines.clear();
    S.tileCover.length = 0;
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

  /** 某一层里,视口需要哪些块,以及每块贴在屏幕哪里 */
  function tileGridAt(lod) {
    if (!lod || !S.baseImg || !S.worldId) return null;
    const { k, oxAbs, oyAbs } = viewMetrics();
    const f = lod / k;
    const step = TILE * k / lod;
    return {
      lod, step, oxAbs, oyAbs,
      i0: Math.floor((-oxAbs * f) / TILE),
      i1: Math.floor(((S.cw - oxAbs) * f) / TILE),
      j0: Math.floor((-oyAbs * f) / TILE),
      j1: Math.floor(((S.ch - oyAbs) * f) / TILE),
    };
  }

  function tileGrid() {
    return tileGridAt(S.lod);
  }

  /** 这一档一圈地图有多少列、一层有多少行(2 的幂档下都是整数) */
  function tileCols(lod) { return Math.round(4 * lod); }
  function tileRows(lod) { return Math.round(2 * lod); }

  /**
   * 世界坐标 (i,j) → 规范块。
   *
   * 球面在 x 方向每 tileCols 列、y 方向每两层完全重复(过极点镜像一次),
   * 所以一块的内容只由 列号 / 层内的行 / 层的奇偶 决定。取模之后:
   *   - 拖到任意一个重复单元,键都一样,命中的是同一张图;
   *   - 发给服务端的 x / y 永远落在 [0, 一圈) 内,不会越拖越大。
   */
  function tileAt(lod, i, j) {
    const cols = tileCols(lod);
    const rows = tileRows(lod);
    const col = ((i % cols) + cols) % cols;
    const layer = Math.floor(j / rows);
    const row = ((j % rows) + rows) % rows;
    const par = ((layer % 2) + 2) % 2;
    return {
      key: `${lod}|${col}|${row}|${par}`,
      col, row, par, cols, rows,
      x: col * TILE,
      // 偶数层直接落在第 0 / 1 层上;奇数层用第 1 层(服务端会自己按奇数层镜像)
      y: (par * rows + row) * TILE,
    };
  }

  /** 缓存里已经有哪几层(升序)。每帧扫一遍键,一百来个,可以忽略不计 */
  function cachedLods() {
    const set = new Set();
    for (const key of S.tiles.keys()) {
      const lod = Number(key.slice(0, key.indexOf('|')));
      if (Number.isFinite(lod) && lod > 0) set.add(lod);
    }
    return [...set].sort((a, b) => a - b);
  }

  /** 这一层的可见块是不是齐了 */
  function levelComplete(g) {
    for (let j = g.j0; j <= g.j1; j++) {
      for (let i = g.i0; i <= g.i1; i++) if (!S.tiles.has(tileAt(g.lod, i, j).key)) return false;
    }
    return true;
  }

  /** 这一块在 2 倍档上的四块子瓦片是不是都已经在缓存里(在的话就不必再按低档渲一遍) */
  function childrenCover(lod, i, j) {
    const l2 = lod * 2;
    if (!l2 || l2 > LOD_MAX) return false;
    const t = tileAt(lod, i, j);
    const cols2 = t.cols * 2;
    const rows2 = t.rows * 2;
    const has = (dc, dr) => S.tiles.has(
      `${l2}|${(t.col * 2 + dc) % cols2}|${(t.row * 2 + dr) % rows2}|${t.par}`,
    );
    return has(0, 0) && has(1, 0) && has(0, 1) && has(1, 1);
  }

  /**
   * 从低倍率往高倍率叠画,当前层最后画。
   *
   * 换档时新层一块都没有,缺块的地方由已缓存的档顶着(低一档或高一档),补上再替换,
   * 观感上不会"先糊一下"。倍率不同的块在世界平面上是对齐的,贴图位置按 k / lod
   * 换算即可,源图会被 drawImage 按目标尺寸重采样,不需要额外裁切。
   *
   * 块的键是规范化的(见 tileAt):列取模、层内行 + 层奇偶 —— 拖动到第几个重复单元
   * 都一样,所以同一块世界区域只渲染一次,其它单元直接命中同一张图。
   *
   * 海岸 / 湖岸线只由"当前档里真正露在最上面的块"画:低档块会被高档块整块盖住,
   * 再描一遍就是两条线叠着;被 2× 子块拼满的那块也不描,留给子块描。
   */
  function drawHiTiles() {
    S.tileCover.length = 0;
    S.tileFull = false;
    if (!S.lod || !S.tiles.size) return;
    const lods = cachedLods();
    const below = lods.filter((lod) => lod <= S.lod);
    if (!below.length) return;
    let from = 0;
    for (let n = 0; n < below.length; n++) {
      const g = tileGridAt(below[n]);
      if (!g || g.step < 4) continue;
      if (levelComplete(g)) {
        from = n;
        if (below[n] === S.lod) S.tileFull = true;   // 当前层齐了,全局那份海岸线整份都不用画
      }
    }
    const paint = (g, i, j, withCoast) => {
      const t = tileAt(g.lod, i, j);
      const img = S.tiles.get(t.key);
      if (!img) return;
      const x = g.oxAbs + i * g.step;
      const y = g.oyAbs + j * g.step;
      ctx.drawImage(img, x, y, g.step + 0.6, g.step + 0.6);
      if (withCoast && drawTileCoast(t.key, x, y, g.step + 0.6)) S.tileCover.push({ x, y, w: g.step + 0.6, h: g.step + 0.6 });
    };
    for (let n = from; n < below.length; n++) {
      const g = tileGridAt(below[n]);
      if (!g || g.step < 4) continue;
      for (let j = g.j0; j <= g.j1; j++) {
        for (let i = g.i0; i <= g.i1; i++) {
          // 海岸线只画一层:低档块会被高档块整块盖住,再描一遍就是两条线叠着;
          // 被 2× 子块拼满的那块也不描,留给子块自己描。
          paint(g, i, j, g.lod === S.lod && !childrenCover(g.lod, i, j));
        }
      }
    }
    // 缩小时直接复用放大时已经渲染过的高清块:同一块世界区域只渲染一次,
    // 缩小时把它降采样贴回去,而不是再按低一档重新渲一遍。只叠最近两档 ——
    // 再高的档在屏幕上更小,已经被这两档完全盖住,画了也看不见。
    for (const lod of lods.filter((l) => l > S.lod).slice(0, 2)) {
      const g = tileGridAt(lod);
      if (!g || g.step < 4) continue;
      for (let j = g.j0; j <= g.j1; j++) {
        for (let i = g.i0; i <= g.i1; i++) paint(g, i, j, true);
      }
    }
  }

  /** 把服务端给的折线(瓦片内坐标)编成 Path2D,每块只编一次 */
  function coastPathOf(json) {
    const mk = (lines) => {
      const p = new Path2D();
      if (!Array.isArray(lines)) return p;
      for (const line of lines) {
        if (!Array.isArray(line) || line.length < 4) continue;
        p.moveTo(line[0], line[1]);
        for (let i = 2; i + 1 < line.length; i += 2) p.lineTo(line[i], line[i + 1]);
      }
      return p;
    };
    return { coast: mk(json && json.sea), lake: mk(json && json.lake) };
  }

  /** 一块瓦片自带的海岸 / 湖岸线:坐标是瓦片内像素,按贴图尺寸放大即可 */
  function drawTileCoast(key, x, y, size) {
    const lines = S.tileLines.get(key);
    if (!lines) return false;
    const m = size / TILE;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(m, m);
    // 裁在本块矩形内:相邻两块在接缝处会各自画到对方一点,不裁就会在那条线上叠成双倍深
    ctx.beginPath();
    ctx.rect(0, 0, TILE, TILE);
    ctx.clip();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = S.style === 'white' ? 'rgba(70,72,76,0.82)' : 'rgba(58,45,34,0.86)';
    ctx.lineWidth = 1.15 / m;
    ctx.stroke(lines.coast);
    if (lines.lake) ctx.stroke(lines.lake);
    ctx.restore();
    return true;
  }

  async function loadHiTiles() {
    const g = tileGrid();
    if (!g) return;
    const seq = S.tileSeq;
    const style = S.style;   // 换画法时旧任务必须整批作废,否则会用新画法 + 旧倍数发请求
    // 视口外再预取一圈:平移时新露出来的那块往往已经有图,不用先糊一片底图再等。
    // 排序按"离视口中心近的优先",所以这一圈永远排在可见块后面,不会抢它们的带宽。
    const PAD = 1;
    const want = [];
    for (let j = g.j0 - PAD; j <= g.j1 + PAD; j++) {
      for (let i = g.i0 - PAD; i <= g.i1 + PAD; i++) {
        const t = tileAt(g.lod, i, j);
        if (!S.tiles.has(t.key) && !S.tilePending.has(t.key) && !childrenCover(g.lod, i, j)) {
          want.push({ i, j, key: t.key, x: t.x, y: t.y });
        }
      }
    }
    if (!want.length) return;
    const cx = (g.i0 + g.i1) / 2;
    const cy = (g.j0 + g.j1) / 2;
    want.sort((a, b) => (Math.abs(a.i - cx) + Math.abs(a.j - cy)) - (Math.abs(b.i - cx) + Math.abs(b.j - cy)));
    const jobs = want.slice(0, 24);
    for (const w of jobs) S.tilePending.add(w.key);
    const stale = () => seq !== S.tileSeq || S.style !== style || S.lod !== g.lod;
    const one = async (w) => {
      if (stale()) { S.tilePending.delete(w.key); return; }
      const qs = `worldId=${encodeURIComponent(S.worldId)}&style=${encodeURIComponent(style)}`
        + `&S=${g.lod}&x=${w.x}&y=${w.y}&size=${TILE}&v=${MAP_VER}`;
      try {
        // 图和这一块自己的海岸线一起要:线是按这块的倍率追的,和这块的地形严丝合缝
        const [r, rc] = await Promise.all([
          fetch(`/api/map/tile?${qs}`),
          fetch(`/api/map/coast?${qs}`).catch(() => null),
        ]);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const img = await createImageBitmap(await r.blob());
        let lines = null;
        if (rc && rc.ok) {
          try { lines = coastPathOf(await rc.json()); } catch (_) { lines = null; }
        }
        if (stale()) return;
        S.tiles.set(w.key, img);
        if (lines) S.tileLines.set(w.key, lines);
        while (S.tiles.size > 160) {
          const first = S.tiles.keys().next().value;
          if (first === undefined) break;
          S.tiles.delete(first);
          S.tileLines.delete(first);
        }
        requestDraw();
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
    // 一批 6 块并发:浏览器的 HTTP/1.1 单域并发上限是 6,再多也要排队
    for (let p = 0; p < jobs.length; p += 6) await Promise.all(jobs.slice(p, p + 6).map(one));
  }

  /* ------------------------------------------------------------------ *
   * 魔力层的高清瓦片
   *
   * 整张魔力图固定 2048,柔边/光晕也是按 2048 的像素算的;放大到十几倍时
   * 被拉成几十像素宽,糊成一片。这里跟地形一样按当前 LOD 向服务端要 512 的块
   * (/api/magic/tile),柔边和光晕在服务端按瓦片像素重新算,屏幕上始终是 2~4 像素。
   * 块的坐标锚在世界展开平面上,和地形瓦片同一套 tileGridAt,所以叠得严丝合缝。
   * ------------------------------------------------------------------ */
  function magicTileKey(lod, i, j) {
    const t = tileAt(lod, i, j);
    return `${t.key}|${S.magic.year}|${magicColorsKey()}`;
  }

  function magicTileAt(lod, i, j) {
    const t = tileAt(lod, i, j);
    return { key: `${t.key}|${S.magic.year}|${magicColorsKey()}`, x: t.x, y: t.y };
  }

  function clearMagicTiles() {
    S.magicTiles.clear();
    S.magicPending.clear();
    S.magicSeq++;
    if (S.magicTimer) clearTimeout(S.magicTimer);
    S.magicTimer = 0;
  }

  function scheduleMagicTiles() {
    if (!S.magic.on || S.style === 'classic' || !S.lod) return;
    if (S.magicTimer) clearTimeout(S.magicTimer);
    S.magicTimer = setTimeout(() => { S.magicTimer = 0; void loadMagicTiles(); }, 180);
  }

  /** 当前层魔力瓦片是否已全部到齐(到齐才从整图切到瓦片,避免中间缺块闪一下) */
  function magicTilesCoverView() {
    if (!S.magic.on || !S.lod || !S.magicTiles.size) return false;
    const g = tileGridAt(S.lod);
    if (!g || g.step < 4) return false;
    for (let j = g.j0; j <= g.j1; j++) {
      for (let i = g.i0; i <= g.i1; i++) {
        if (!S.magicTiles.has(magicTileKey(g.lod, i, j))) return false;
      }
    }
    return true;
  }

  /** 已缓存的魔力块:当前层到齐后画(低倍率整图负责兜底) */
  function drawMagicHiTiles() {
    if (!S.magic.on || !S.lod || !S.magicTiles.size) return;
    if (!magicTilesCoverView()) return;
    const g = tileGridAt(S.lod);
    if (!g) return;
    for (let j = g.j0; j <= g.j1; j++) {
      for (let i = g.i0; i <= g.i1; i++) {
        const img = S.magicTiles.get(magicTileKey(g.lod, i, j));
        if (img) ctx.drawImage(img, g.oxAbs + i * g.step, g.oyAbs + j * g.step, g.step + 0.6, g.step + 0.6);
      }
    }
  }

  async function loadMagicTiles() {
    if (!S.magic.on || !S.magic.img || !S.sessionId || !S.lod) return;
    const g = tileGrid();
    if (!g) return;
    const seq = S.magicSeq;
    const year = S.magic.year;
    const want = [];
    for (let j = g.j0; j <= g.j1; j++) {
      for (let i = g.i0; i <= g.i1; i++) {
        const t = magicTileAt(g.lod, i, j);
        if (!S.magicTiles.has(t.key) && !S.magicPending.has(t.key)) want.push({ i, j, key: t.key, x: t.x, y: t.y });
      }
    }
    if (!want.length) return;
    const cx = (g.i0 + g.i1) / 2;
    const cy = (g.j0 + g.j1) / 2;
    want.sort((a, b) => (Math.abs(a.i - cx) + Math.abs(a.j - cy)) - (Math.abs(b.i - cx) + Math.abs(b.j - cy)));
    const jobs = want.slice(0, 16);
    for (const w of jobs) S.magicPending.add(w.key);
    const stale = () => seq !== S.magicSeq || S.magic.year !== year || S.lod !== g.lod;
    /** 换档作废时把还没发的 pending 一起清掉,否则它们会永远留在 Set 里挡住重试 */
    const dropRest = (from) => {
      for (let q = from; q < jobs.length; q++) S.magicPending.delete(jobs[q].key);
    };
    const one = async (w) => {
      if (stale()) { S.magicPending.delete(w.key); return; }
      const qs = `sessionId=${encodeURIComponent(S.sessionId)}&year=${encodeURIComponent(String(year))}`
        + `&S=${g.lod}&x=${w.x}&y=${w.y}&size=${TILE}${magicColorsParam()}`;
      try {
        const r = await fetch(`/api/magic/tile?${qs}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const img = await createImageBitmap(await r.blob());
        if (stale()) { if (img.close) img.close(); return; }
        S.magicTiles.set(w.key, img);
        while (S.magicTiles.size > 64) {
          const first = S.magicTiles.keys().next().value;
          if (first === undefined) break;
          const old = S.magicTiles.get(first);
          if (old && old.close) { try { old.close(); } catch (_) { /* ignore */ } }
          S.magicTiles.delete(first);
        }
        requestDraw();
      } catch (_) {
        // 单块失败就继续用整张图兜底,不打断对局
      } finally {
        S.magicPending.delete(w.key);
      }
    };
    for (let p = 0; p < jobs.length; p += 6) {
      if (stale()) { dropRest(p); return; } // 换档途中不再排新请求,免得把服务端塞满旧档
      await Promise.all(jobs.slice(p, p + 6).map(one));
    }
  }

  /* ------------------------------------------------------------------ *
   * 矢量细节层(主站 render/detail.ts 的做法):海岸线、近岸波纹、山/树符号
   *
   * 底图与高清瓦片里的墨线 / 波纹已经在服务端去掉,这里按固定屏幕线宽画。
   * 所以放大到 1200% 墨线仍是 1.15px、符号按倍数分级变多,而不是把位图拉糊。
   *
   * 绘制本体在 vec-draw.js(主线程和 vec-worker.js 共用同一份):主线程只做
   * 兜底,正常情况下重烘交给 Worker 的 OffscreenCanvas,不阻塞拖动 / 缩放。
   * ------------------------------------------------------------------ */
  const { withBox, drawVectorsInto: drawVectorsIntoShared, visibleRectsFor } = window.CivVecDraw;

  function loadVectors() {
    // 矢量和画法无关:默认 fantasy 要用,white 也要用;提前拿好,切过去时不用等
    if (S.vec && S.vecWorldId === S.worldId) return;
    const wid = S.worldId;
    fetch(`/api/map/vectors?worldId=${encodeURIComponent(wid)}`)
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((v) => {
        if (wid !== S.worldId) return;
        v.coast = v.coast.map(withBox);
        v.lake = v.lake.map(withBox);
        v.ice = (v.ice || []).map(withBox);
        v.ripple = v.ripple.map((group) => group.map(withBox));
        v.coastFine = v.coastFine.map(withBox);
        v.lakeFine = v.lakeFine.map(withBox);
        v.iceFine = (v.iceFine || []).map(withBox);
        v.rippleFine = v.rippleFine.map((group) => group.map(withBox));
        S.vec = v;
        S.vecWorldId = wid;
        clearVecCache();
        draw();
      })
      .catch(() => {
        // 拿不到矢量层多半是监视台进程还是旧代码(没重启),此时位图墨线已被服务端抹掉,
        // 画面会缺描边。明确提示,别让用户以为是地图坏了。
        S.vec = null;
        clearVecCache();
        toast('矢量地图数据加载失败:请关掉旧窗口、重新双击 启动.bat', true);
      });
  }

  /**
   * 矢量层重烘优先交给 Worker(OffscreenCanvas):主线程不再被上万段线阻塞。
   * 拿不到 Worker / OffscreenCanvas / 出错时回退到主线程同步绘制。
   */
  let vecWorker = null;
  let vecWorkerSeq = 0;
  let vecWorkerBusy = false;
  let vecWorkerBroken = false;
  let vecWorkerWorldId = null;
  let vecWorkerPending = null;

  function vecWorkerAvailable() {
    return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
  }

  function ensureVecWorker() {
    if (vecWorker || vecWorkerBroken) return vecWorker;
    try {
      vecWorker = new Worker('./vec-worker.js');
      vecWorker.onmessage = (ev) => {
        const m = ev.data || {};
        vecWorkerBusy = false;
        if (m.ok) {
          if (m.seq === vecWorkerSeq) {
            if (S.vecCache && S.vecCache.canvas && S.vecCache.canvas !== m.bitmap && S.vecCache.canvas.close) {
              S.vecCache.canvas.close();
            }
            S.vecCache = {
              canvas: m.bitmap, x0: m.x0, y0: m.y0, w: m.w, h: m.h, pad: m.pad, k: m.k,
              ox: m.ox, oy: m.oy, cw: m.cw, ch: m.ch, rdpr: m.rdpr, style: m.style,
              tileFull: m.tileFull, vecWorldId: m.vecWorldId
            };
            requestDraw();
          } else if (m.bitmap && m.bitmap.close) {
            m.bitmap.close();
          }
        } else if (m.seq === vecWorkerSeq) {
          // Worker 内部报错(比如极端参数):后续改回主线程,保证有图可看
          vecWorkerBroken = true;
          requestDraw();
        }
        const next = vecWorkerPending;
        vecWorkerPending = null;
        if (next && !vecWorkerBroken) sendVecBuild(next);
      };
      vecWorker.onerror = () => {
        vecWorkerBroken = true;
        vecWorkerBusy = false;
        vecWorkerPending = null;
        requestDraw();
      };
    } catch (e) {
      vecWorkerBroken = true;
      vecWorker = null;
    }
    return vecWorker;
  }

  function sendVecBuild(p) {
    if (vecWorkerBusy) { vecWorkerPending = p; return; }
    const w = ensureVecWorker();
    if (!w) return;
    vecWorkerBusy = true;
    vecWorkerSeq = p.seq;
    const msg = {
      seq: p.seq, worldId: p.worldId, style: p.style, k: p.k, P: p.P, H: p.H,
      oxAbs: p.oxAbs, oyAbs: p.oyAbs, cw: p.cw, ch: p.ch, rdpr: p.rdpr,
      tileFull: p.tileFull, tileCover: p.tileCover, x0: p.x0, y0: p.y0, w: p.w, h: p.h,
      mapW: p.mapW, mapH: p.mapH, relK: p.relK, pad: p.pad
    };
    // 1.3MB 的矢量 JSON 每个世界只传一次,之后 worker 自己缓存
    if (vecWorkerWorldId !== p.worldId) {
      msg.vec = S.vec;
      vecWorkerWorldId = p.worldId;
    }
    w.postMessage(msg);
  }

  function requestVecBuildWorker(p) {
    p.seq = ++vecWorkerSeq;
    if (vecWorkerBusy) { vecWorkerPending = p; return true; }
    sendVecBuild(p);
    return true;
  }


  function clearVecCache() {
    if (S.vecCache && S.vecCache.canvas && S.vecCache.canvas.close) S.vecCache.canvas.close();
    S.vecCache = null;
  }

  const VEC_PAD_MIN = 180;
  const VEC_PAD_MAX = 340;

  /**
   * 重建矢量层缓存:视口四周多画一圈边距,拖动时先贴图,快拖出边距再重画。
   * 正常走 Worker 异步重烘(不阻塞主线程);Worker 不可用才退回主线程同步画。
   */
  function buildVecCache() {
    if (!S.vec || (S.style !== 'fantasy' && S.style !== 'white')) { clearVecCache(); return null; }
    const { k, oxAbs, P, H } = S.draw;
    const oyAbs = S.draw.oy;
    const rdpr = S.rdpr || S.dpr;
    const pad = Math.round(clamp(Math.min(S.cw, S.ch) * 0.3, VEC_PAD_MIN, VEC_PAD_MAX));
    const w = S.cw + pad * 2;
    const h = S.ch + pad * 2;
    const x0 = oxAbs - pad;
    const y0 = oyAbs - pad;
    const cover = S.tileCover.map((t) => ({ x: t.x - x0, y: t.y - y0, w: t.w, h: t.h }));
    if (!vecWorkerBroken && vecWorkerAvailable()) {
      requestVecBuildWorker({
        worldId: S.vecWorldId, style: S.style, k, P, H, oxAbs, oyAbs,
        cw: S.cw, ch: S.ch, rdpr, tileFull: S.tileFull, tileCover: cover,
        x0, y0, w, h, mapW: S.mapW, mapH: S.mapH, relK: S.view.k, pad
      });
      // Worker 正在算:先把上一张缓存继续贴着(可能位置略旧,但不会闪空)
      return S.vecCache;
    }
    // 兜底:主线程同步画
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * rdpr));
    cv.height = Math.max(1, Math.round(h * rdpr));
    const g = cv.getContext('2d');
    if (!g) return null;
    g.setTransform(rdpr, 0, 0, rdpr, 0, 0);
    const rects = visibleRectsFor(k, P, H, oxAbs - x0, oyAbs - y0, w, h);
    drawVectorsIntoShared(g, {
      vec: S.vec, rects, k, P, H, mapW: S.mapW, mapH: S.mapH, cw: w, ch: h,
      style: S.style, relK: S.view.k, tileFull: S.tileFull, tileCover: cover
    });
    S.vecCache = { canvas: cv, x0, y0, w, h, pad, k, ox: oxAbs, oy: oyAbs, cw: S.cw, ch: S.ch, rdpr, style: S.style, tileFull: S.tileFull, vecWorldId: S.vecWorldId };
    return S.vecCache;
  }
  /**
   * 矢量层:平稳时不重描,每帧只把离屏缓存贴到画布。
   * 缩放明显变化、拖动快把边距拖光、换画法 / 换世界 / 瓦片覆盖状态变化时才重画。
   */
  function drawVectorsCached() {
    if (!S.vec || (S.style !== 'fantasy' && S.style !== 'white') || !S.baseImg) { S.vecCache = null; return; }
    const { k, oxAbs, P, H } = S.draw;
    const oyAbs = S.draw.oy;
    // 拖动 / 缩放进行中也要有墨线:主线程直接描线只要几毫秒,
    // 比"贴一张没盖住新视口的旧缓存"更稳(否则新露出的区域会整块没有海岸线)。
    if (vecWorkerBroken) {
      // Worker 起不来:主线程直接描线(比每帧贴 6MP 位图便宜),不建缓存
      const rects = visibleRectsFor(k, P, H, oxAbs, oyAbs, S.cw, S.ch);
      drawVectorsIntoShared(ctx, { vec: S.vec, rects, k, P, H, mapW: S.mapW, mapH: S.mapH, cw: S.cw, ch: S.ch, style: S.style, relK: S.view.k, tileFull: S.tileFull, tileCover: S.tileCover });
      S.vecCache = null;
      return;
    }
    const rdpr = S.rdpr || S.dpr;
    let c = S.vecCache;
    let reuse = false;
    if (c) {
      const s = k / c.k;
      const dx = oxAbs + s * (c.x0 - c.ox);
      const dy = oyAbs + s * (c.y0 - c.oy);
      const right = dx + c.w * s;
      const bottom = dy + c.h * s;
      const mx = c.pad * 0.45;
      const my = c.pad * 0.45;
      reuse = c.style === S.style && c.cw === S.cw && c.ch === S.ch && c.rdpr === rdpr
        && c.tileFull === S.tileFull && c.vecWorldId === S.vecWorldId
        && s >= 0.82 && s <= 1.22
        && dx <= mx && dy <= my && right >= S.cw - mx && bottom >= S.ch - my;
    }
    if (!reuse) {
      // 缓存没盖住当前视口(或根本没有):先同步补这一帧,再在后台重烘下一张。
      const rects = visibleRectsFor(k, P, H, oxAbs, oyAbs, S.cw, S.ch);
      drawVectorsIntoShared(ctx, { vec: S.vec, rects, k, P, H, mapW: S.mapW, mapH: S.mapH, cw: S.cw, ch: S.ch, style: S.style, relK: S.view.k, tileFull: S.tileFull, tileCover: S.tileCover });
      if (performance.now() - lastInputAt >= 200) buildVecCache();
      return;
    }
    const s = k / c.k;
    const dx = oxAbs + s * (c.x0 - c.ox);
    const dy = oyAbs + s * (c.y0 - c.oy);
    ctx.drawImage(c.canvas, dx, dy, c.w * s, c.h * s);
  }

  function updateZoomLabel() {
    if (el.zoomVal) el.zoomVal.textContent = `${Math.round(S.view.k * 100)}%`;
  }

  /**
   * 国界:主站 borderLines 已经平滑好的折线(坐标 = 主图像素),按屏幕固定线宽画。
   * 只叠在手绘风上(white / classic 等不画,和主站 civ 层一致);跨 180° 的线在另一侧再画一份。
   */
  function drawOwnerBorders(rects) {
    const lines = S.ownerBorders;
    if (!lines || !lines.length || S.style !== 'fantasy') return;
    if (!S.draw || !S.mapW || !S.mapH) return;
    const sx = S.draw.P / S.mapW;
    const sy = S.draw.H / S.mapH;
    const drawPass = (strokeStyle, lineWidth, dash) => {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash(dash);
      for (const r of rects) {
        ctx.save();
        if (r.odd) {
          ctx.translate(0, 2 * r.yTop + S.draw.H);
          ctx.scale(1, -1);
        }
        for (const b of lines) {
          const p = b.p;
          const shifts = b.x1 > S.mapW ? [0, -S.mapW] : b.x0 < 0 ? [0, S.mapW] : [0];
          for (const sh of shifts) {
            ctx.beginPath();
            ctx.moveTo(r.x + (p[0] + sh) * sx, r.yTop + p[1] * sy);
            for (let i = 2; i + 1 < p.length; i += 2) ctx.lineTo(r.x + (p[i] + sh) * sx, r.yTop + p[i + 1] * sy);
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    };
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // 第一遍奶白底线压住底图纹理,第二遍墨色虚线(屏幕像素,放大多少倍都不变粗)
    drawPass('rgba(246,236,210,0.6)', 3.2, []);
    drawPass('rgba(58,32,20,0.85)', 2, [5, 3]);
    ctx.setLineDash([]);
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
    const { k, oxAbs, oyAbs } = viewMetrics();
    const ux = wrapX((x - oxAbs) / k);
    const vy = (y - oyAbs) / k;
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
    beginInteractive();
    const { k: k0, oxAbs, oyAbs } = viewMetrics();
    const wx = (px - oxAbs) / k0;
    const wy = (py - oyAbs) / k0;
    const next = clamp(S.view.k * factor, 1, 12);
    if (Math.abs(next - S.view.k) < 1e-4) return;
    S.view.k = next;
    const k2 = fitScale() * next;
    S.view.x = px - wx * k2 - (S.cw - S.mapW * k2) / 2;
    S.view.y = py - wy * k2 - (S.ch - S.mapH * k2) / 2;
    normalizeView();
    requestDraw();
  }

  function resetView() {
    S.view = { k: 1, x: 0, y: 0 };
    normalizeView();
    requestDraw();
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
      beginInteractive();
      requestDraw();
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

  /* 换世界时底图缓存必须丢;同一个世界的其它画法由 schedulePreloadMaps 在后台慢慢补 */
  function baseCacheFor() {
    if (S.baseCacheWorldId !== S.worldId) {
      S.baseCache.clear();
      S.baseCacheWorldId = S.worldId;
    }
    return S.baseCache;
  }

  /**
   * 其它画法在后台排队预取:用户切到卫星 / 地理 / 白模时直接命中缓存,
   * 不用再等服务端 2–3 秒现算还要盯着「地图绘制中…」。
   * 每次只取一张,取完歇 80ms,避免和当前地图的瓦片 / 矢量请求抢带宽与主线程。
   */
  let preloadSeq = 0;
  /** 最近一次用户操作的时间:预取底图会占住服务端线程 2–3 秒,只在用户停下来之后再排队 */
  let lastActive = 0;
  const PRELOAD_IDLE_MS = 6000;
  function schedulePreloadMaps() {
    if (!S.worldId) return;
    const token = ++preloadSeq;
    const wid = S.worldId;
    const pending = STYLES.filter((st) => st !== S.style && !baseCacheFor().has(st));
    if (!pending.length) return;
    const waitIdle = async (i) => {
      for (let n = 0; n < 300; n++) {
        if (token !== preloadSeq || wid !== S.worldId) return false;
        // 服务端渲染是同步的(一张 2048 底图 2–3 秒):用户正在拖 / 正在等瓦片时不排预取,
        // 否则会把 tile 请求也堵在服务器后面,反而更卡。
        if (!S.busy && !document.hidden
          && !S.tilePending.size && !S.magicPending.size
          && performance.now() - lastActive > PRELOAD_IDLE_MS) return true;
        await new Promise((res) => setTimeout(res, 400));
      }
      return false;
    };
    const one = async (i) => {
      if (i >= pending.length || token !== preloadSeq || wid !== S.worldId) return;
      if (!(await waitIdle(i))) return;
      const st = pending[i];
      try {
        // 后台预取让路给正在拖动的请求:低优先级,浏览器支持时会把它排后面
        const r = await fetch(`/api/map/base?worldId=${encodeURIComponent(wid)}&style=${encodeURIComponent(st)}&v=${MAP_VER}`, { priority: 'low' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        const img = await createImageBitmap(blob);
        if (token !== preloadSeq || wid !== S.worldId) { if (img.close) img.close(); return; }
        baseCacheFor().set(st, { img, w: img.width, h: img.height });
      } catch (_) {
        // 预取失败不打扰用户;真切过去时还会再试一次并给出明确报错
      }
      await new Promise((res) => setTimeout(res, 120));
      void one(i + 1);
    };
    setTimeout(() => { void one(0); }, 600);
  }

  async function loadBaseMap(keepView = false) {
    if (!S.worldId) return;
    const cached = baseCacheFor().get(S.style);
    if (cached) {
      el.mapLoading.classList.add('hidden');
      el.mapEmpty.classList.add('hidden');
      S.baseImg = cached.img;
      S.mapW = cached.w;
      S.mapH = cached.h;
      if (!keepView) S.view = { k: 1, x: 0, y: 0 };
      clearTiles();
      clearVecCache();
      resizeCanvas();
      void loadVectors();
      schedulePreloadMaps();
      return;
    }
    el.mapLoading.classList.remove('hidden');
    el.mapLoadingText.textContent = '地图绘制中…';
    el.mapEmpty.classList.add('hidden');
    try {
      const r = await fetch(`/api/map/base?worldId=${encodeURIComponent(S.worldId)}&style=${encodeURIComponent(S.style)}&v=${MAP_VER}`);
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try { msg = (await r.json()).error || msg; } catch (_) { /* ignore */ }
        throw new Error(msg);
      }
      const blob = await r.blob();
      S.baseImg = await createImageBitmap(blob);
      S.mapW = S.baseImg.width;
      S.mapH = S.baseImg.height;
      baseCacheFor().set(S.style, { img: S.baseImg, w: S.mapW, h: S.mapH });
      if (!keepView) S.view = { k: 1, x: 0, y: 0 };
      clearTiles();
      clearVecCache();
      resizeCanvas();
      void loadVectors();
      schedulePreloadMaps();
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
      S.ownerBorders = (d.borders || []).map(withBox);
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
      const idx = magic.grid[gy * magic.gridW + gx];
      if (typeof idx === 'number' && idx >= 0 && idx < magic.values.length) {
        if (lines.length) lines.push('<span class="muted">——</span>');
        const where = magic.unit === 'tile' ? `地块 #${idx}` : `州 #${idx}`;
        lines.push(`<b>魔力浓度</b> <span class="field-tip-value">${magic.values[idx].toFixed(4)}</span>`);
        lines.push(`<span class="muted">第 ${fmtInt(magic.frameYear)} 年图层(取不晚于本回合的帧)· ${where} · ${lon}°E, ${lat}°N</span>`);
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

  /** 内置色带(给玩家一键切换;custom 用下面三个取色器现拼) */
  const MAGIC_PALETTES = {
    default: ['#1b1036', '#5b2a9e', '#a46cff', '#f2e6ff'],
    ember: ['#1b0f08', '#7a2d0e', '#e8862a', '#ffe6a8'],
    verdant: ['#06180f', '#14532d', '#22c55e', '#dcfce7'],
    frost: ['#071722', '#0e4f6e', '#38bdf8', '#e0f2fe'],
    mono: ['#101010', '#4a4a4a', '#9a9a9a', '#f5f5f5'],
  };
  /** 自定义取色器只给三档(低 / 中 / 高),渲染层会在相邻两档之间插值 */
  const MAGIC_PALETTE_ANCHORS = { default: [0, 2, 3], ember: [0, 2, 3], verdant: [0, 2, 3], frost: [0, 2, 3], mono: [0, 2, 3] };

  /** 当前色带的 URL 片段(没有自定义就空串,让服务端用图层自带色带) */
  function magicColorsParam() {
    const c = S.magic.colors;
    return c && c.length >= 2 ? `&colors=${encodeURIComponent(c.join(','))}` : '';
  }

  /** 色带签名字符串,参与瓦片缓存键 */
  function magicColorsKey() {
    const c = S.magic.colors;
    return c && c.length >= 2 ? c.join(',') : '';
  }

  /** 把色带同步到三个取色器 + 下拉选项 */
  function syncMagicColorInputs() {
    const c = S.magic.colors;
    const preset = c ? Object.keys(MAGIC_PALETTES).find((k) => MAGIC_PALETTES[k].join(',') === c.join(',')) ?? 'custom' : '';
    if (el.magicPalette) el.magicPalette.value = preset;
    let low = MAGIC_PALETTES.default[0];
    let mid = MAGIC_PALETTES.default[2];
    let high = MAGIC_PALETTES.default[3];
    if (c && c.length >= 2) {
      low = c[0];
      mid = c[Math.floor(c.length / 2)];
      high = c[c.length - 1];
    }
    if (el.magicColor0) el.magicColor0.value = low;
    if (el.magicColor1) el.magicColor1.value = mid;
    if (el.magicColor2) el.magicColor2.value = high;
  }

  /** 换色:立刻重渲染整图与瓦片(色带只影响显示,不动游戏数值) */
  function setMagicColors(colors) {
    S.magic.colors = colors && colors.length >= 2 ? [...colors] : null;
    syncMagicColorInputs();
    clearMagicTiles();
    if (S.sessionId && el.magicEnable && el.magicEnable.checked) void refreshMagic(S.magic.year ?? undefined);
    saveCfg(cfgFromForm());
    draw();
  }

  function magicColorsFromInputs() {
    const v = (e) => (e && /^#[0-9a-f]{6}$/i.test(e.value) ? e.value : '#000000');
    return [v(el.magicColor0), v(el.magicColor1), v(el.magicColor2)];
  }

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
      `${fmtInt(d.count)} ${d.unit === 'tile' ? '地块' : '州'} · min ${d.stats.min.toFixed(2)} / mean ${d.stats.mean.toFixed(2)} / max ${d.stats.max.toFixed(2)}`;
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
    clearMagicTiles();
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
      const meta = await api(`/api/magic/meta?sessionId=${sid}${magicColorsParam()}`);
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
      const q = `sessionId=${sid}&year=${encodeURIComponent(String(pick))}${magicColorsParam()}`;
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
      clearMagicTiles();
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

  /** 君主标签页:角色卡 + 独立记忆 + 情报(选中哪个国家就看哪个) */
  function renderCrown() {
    const st = S.state;
    const p = (st.polities || []).find((x) => x.id === S.sel);
    if (!p) return '<div class="side-empty">先在右侧选一个国家。</div>';
    const card = (st.cards || []).find((c) => c.polityId === p.id);
    if (!card) return `<div class="side-empty">${esc(p.name)} 还没有角色卡。跑一次「跑一回合」或「本回合方案」后,君主卡会在这里出现。</div>`;
    const t = card.traits || {};
    const c = card.competence || {};
    const pref = card.preferences || {};
    const cell = (k, v) => `<div class="crown-cell"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`;
    const book = (st.memory || []).find((m) => m.polityId === p.id);
    const entries = (book && book.entries ? book.entries : []).slice(-8).reverse();
    const memHtml = entries.length
      ? entries.map((e) => `<div class="mem-row"><span class="mem-year">${fmtInt(e.year)}</span><span class="mem-src">${e.source === 'self' ? '自述' : '史事'}</span><span>${esc(e.text)}</span></div>`).join('')
      : '<div class="review-note">还没有记忆。战败、饥荒、背盟会自动记;君主也可以自己写。</div>';
    const intel = (st.intel || {})[String(p.id)] || {};
    const intelRows = Object.entries(intel)
      .map(([tid, k]) => {
        const target = (st.polities || []).find((x) => x.id === Number(tid));
        const fields = (k.fields || []).join('、') || '无';
        return `<div class="mem-row"><span class="mem-year">${fmtInt(k.year)}</span><span>P${tid} ${esc(target ? target.name : '')}:${esc(fields)}(${esc(k.quality)})</span></div>`;
      })
      .join('') || '<div class="review-note">还没派人渗透过任何国家;他国的人口、税收、稳定度在提示词里显示为「未知」。</div>';
    return `
      <div class="crown-wrap">
        <div class="crown-head"><span class="crown-name">${esc(card.name)}</span>
          <span class="crown-sub">第 ${fmtInt(card.born)} 年生 · ${esc(card.title || '君主')} · ${esc(p.name)}(P${p.id})</span></div>
        <div class="crown-grid">
          ${cell('谨慎', t.caution ?? '—')}${cell('野心', t.ambition ?? '—')}${cell('荣誉感', t.honor ?? '—')}${cell('贪欲', t.greed ?? '—')}
        </div>
        <div class="crown-grid">
          ${cell('用兵', c.war ?? 0)}${cell('理财', c.economy ?? 0)}${cell('密谋', c.intrigue ?? 0)}${cell('理政', c.admin ?? 0)}
        </div>
        <div class="review-note">偏好:战争 ${esc(pref.war || '—')} · 经济 ${esc(pref.economy || '—')} · 外交 ${esc(pref.diplomacy || '—')}(玩家 / DM 可改下面的性格说明)</div>
        <textarea class="crown-persona" id="crownPersona" data-polity="${p.id}">${esc(card.persona || '')}</textarea>
        <div><button class="btn" id="btnCrownSave" type="button" data-polity="${p.id}">保存角色卡</button></div>
        <div><h4 style="margin:2px 0 4px;font-size:12px">独立记忆(最近 8 条)</h4>${memHtml}</div>
        <div><h4 style="margin:2px 0 4px;font-size:12px">情报</h4>${intelRows}</div>
      </div>`;
  }

  function renderTabBody() {
    if (!S.state || !el.tabBody) return;
    if (S.tab === 'crown') {
      el.tabBody.innerHTML = renderCrown();
      const card = (S.state.cards || []).find((c) => c.polityId === S.sel);
      el.tabNote.textContent = card ? `${card.name} · 记忆 ${((S.state.memory || []).find((m) => m.polityId === S.sel) || {}).entries?.length || 0} 条` : '跑一回合后生成';
      return;
    }
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
    el.btnSession.disabled = !hasWorld || S.busy || S.autoOn || !!S.plan;
    el.btnRound.disabled = !hasSession || finished || S.busy || S.autoOn || !!S.plan;
    el.btnAuto.disabled = !hasSession || finished || S.busy || !!S.plan || (el.reviewMode && el.reviewMode.checked);
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

  // 预渲染:建完世界先让服务端把 S=2/4/8 的瓦片全部算好落盘,再进地图。
  // 这样拖动 / 缩放不用再等瓦片,河流在所有倍率下也共用同一份几何。
  async function prewarmWorld(worldId, style) {
    const box = document.getElementById('prewarm');
    if (!box || !worldId) return;
    const fill = document.getElementById('prewarmFill');
    const text = document.getElementById('prewarmText');
    box.hidden = false;
    if (fill) fill.style.width = '0%';
    if (text) text.textContent = '准备中…';
    try {
      const q = `worldId=${encodeURIComponent(worldId)}&style=${encodeURIComponent(style)}`;
      let st = await (await fetch(`/api/map/prewarm?${q}`, { method: 'POST' })).json();
      const t0 = performance.now();
      while (st.state === 'running') {
        const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
        const elapsed = (performance.now() - t0) / 1000;
        const eta = st.done > 8 ? Math.max(1, Math.round((elapsed / st.done) * (st.total - st.done))) : null;
        if (fill) fill.style.width = `${pct}%`;
        if (text) text.textContent = `${pct}% · ${st.done}/${st.total} 块${eta ? ` · 约 ${eta} 秒` : ''}`;
        await new Promise((r) => setTimeout(r, 500));
        st = await (await fetch(`/api/map/prewarm?${q}`)).json();
      }
      if (fill) fill.style.width = '100%';
      if (text) text.textContent = st.state === 'done' ? '渲染完成' : '部分瓦片渲染失败，仍可进入';
      await new Promise((r) => setTimeout(r, 260));
    } catch (e) {
      if (text) text.textContent = '预渲染失败，直接进入';
      await new Promise((r) => setTimeout(r, 500));
    }
    box.hidden = true;
  }

  async function createWorld() {
    try {
      setBusy(true, '正在生成世界…', '同样的种子 + 同样的地块数,每次都会得到同一个世界');
      const seed = int(el.seed, 7);
      const cells = int(el.cells, 34043);
      const d = await api('/api/world', { seed, cells });
      S.worldId = d.worldId;
      S.sessionId = null;
      S.state = null;
      S.plan = null;
      if (el.reviewPanel) el.reviewPanel.hidden = true;
      S.ownersImg = null;
      S.ownerBorders = null;
      S.grid = null;
      S.sel = null;
      S.baseImg = null;
      // 换世界:上一张图的底图缓存、矢量层缓存全部作废
      S.baseCache.clear();
      S.baseCacheWorldId = d.worldId;
      S.vecCache = null;
      S.vec = null;
      S.vecWorldId = null;
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
      await prewarmWorld(d.worldId, S.style);
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
      const features = { llm: !!el.featLlm.checked, jev: !!el.featJev.checked };
      const d = await api('/api/session', {
        worldId: S.worldId,
        startYear: int(el.startYear, 2500),
        stepYears: int(el.stepYears, 5),
        maxRounds: int(el.maxRounds, 12),
        dmPreset: el.dmPreset.checked,
        magicField: el.magicField.checked,
        magicStrength: Number(el.magicStrength.value) || 1,
        features,
        review: !!el.reviewMode.checked,
      });
      S.sessionId = d.session.sessionId;
      S.autoOn = false;
      S.plan = null;
      if (el.reviewPanel) el.reviewPanel.hidden = true;
      saveCfg(cfgFromForm());
      let setup = null;
      if (features.llm) {
        setBusy(true, '正在配置君主…', '选君主范围、mock 或真模型;Key 只存在服务端内存。');
        setup = await api('/api/monarch/setup', {
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
      } else {
        await applyState(d.state);
        toast('「LLM 扮演」关着:这一局国家按引擎规则自动行动,只有 Jev 在结算小事。');
      }
      if (el.dmEnable.checked) {
        try {
          setBusy(true, '正在连接 DM 小决策…', el.dmMock.checked ? 'mock 模式,不联网' : 'OpenAI 兼容服务;Key 只在服务端内存。');
          await connectDm(true);
        } catch (e) {
          toast(`DM 小决策未连接(不影响君主):${e instanceof Error ? e.message : String(e)}`, true);
        }
      }
      if (features.jev) {
        el.pettyEnable.checked = true;
        try {
          setBusy(true, '正在连接 Jev 判断…', el.pettyMock.checked || el.mock.checked ? 'mock 模式,不联网' : '官方 Jev;Key 只在服务端内存。');
          await connectPetty(true);
        } catch (e) {
          toast(`Jev 未连接:审核与渗透会退回确定性规则;小事也不结算。${e instanceof Error ? e.message : String(e)}`, true);
        }
      }
      const king = setup && setup.setup ? setup.setup.monarchs.length : 0;
      toast(
        features.llm
          ? `会话已开始:第 ${fmtInt(yearOf(d.session.year))} 年,${king} 家君主接管${el.mock.checked ? '(mock)' : '(真模型)'}${features.jev ? ' · Jev 判断已开' : ''}`
          : `会话已开始:第 ${fmtInt(yearOf(d.session.year))} 年,引擎自动推演${features.jev ? ' + Jev 结算小事' : ''}`,
      );
      setHint(
        el.reviewMode.checked
          ? '复核模式:点「跑一回合」只出方案;在「本回合方案」里勾选要执行的命令,再点「提交本回合」。'
          : '点「跑一回合」:每个君主先看简报,再下命令;高影响命令过 Jev 审核,收齐后引擎统一推演一个回合。',
      );
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
    if (el.reviewMode.checked) { await planRound(); return; }
    if (el.featLlm && !el.featLlm.checked) { await engineRound(); return; }
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

  /** LLM 关着时的回合:开了 Jev 就先结算小事,否则纯引擎推演 */
  async function engineRound() {
    if (!S.sessionId || S.busyAutoBusy) return;
    const jevOnly = !!(el.featJev && el.featJev.checked);
    S.busyAutoBusy = true;
    try {
      setBusy(true, jevOnly ? '小事件裁决回合…' : '引擎推演中…', jevOnly ? '先扫小事 → Jev 裁决 → 落效果 → 推演;国家行为按引擎规则。' : '没有 LLM、没有 Jev:纯引擎规则推进一步。');
      const d = await api(jevOnly ? '/api/petty/round' : '/api/turn', { sessionId: S.sessionId });
      if (d.state) await applyState(d.state);
      const r = d.petty || d.turn || {};
      toast(`第 ${r.round ?? '?'} 回合:第 ${fmtInt(yearOf(r.fromYear))} → ${fmtInt(yearOf(r.toYear))} 年${jevOnly ? ' · Jev 结算小事' : ' · 引擎自动'}`);
    } catch (e) {
      toast(`回合失败:${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      S.busyAutoBusy = false;
      setBusy(false);
      refreshButtons();
    }
  }

  /** 给已有会话接上/重接君主模式(引导浮层保存后调用) */
  async function connectMonarchNow() {
    if (!S.sessionId) return;
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
    if (setup.state) await applyState(setup.state);
  }

  /** 复核模式第一步:只出方案,不推演 */
  async function planRound() {
    if (!S.sessionId || S.busyAutoBusy) return;
    S.busyAutoBusy = true;
    try {
      setBusy(true, '正在出本回合方案…', '君主读简报 → 下命令 → 高影响命令过 Jev 审核;这一步还不推演。');
      refreshButtons();
      const d = await api('/api/monarch/plan', { sessionId: S.sessionId });
      S.plan = d.plan;
      if (d.state) await applyState(d.state);
      renderReview();
      const n = (d.plan && d.plan.commands ? d.plan.commands.length : 0);
      toast(`方案已出:${n} 条命令待复核;在「本回合方案」里取消勾选即可否决。`);
    } catch (e) {
      toast(`出方案失败:${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      S.busyAutoBusy = false;
      setBusy(false);
      refreshButtons();
    }
  }

  function renderReview() {
    if (!el.reviewPanel || !el.reviewBody) return;
    const plan = S.plan;
    if (!plan) {
      el.reviewPanel.hidden = true;
      return;
    }
    el.reviewPanel.hidden = false;
    const names = keyNamesOf(S.state);
    el.reviewSub.textContent = `第 ${fmtInt(yearOf(plan.fromYear))} 年 · ${plan.decisions.length} 位君主 · ${plan.commands.length} 条命令 · 推 ${plan.years} 年 · ${plan.audit && plan.audit.source === 'jev' ? 'Jev 审核' : '规则审核'}`;
    const refs = plan.commandRefs || [];
    const byPolity = new Map();
    plan.commands.forEach((c, i) => {
      const ref = refs[i] || { polityId: -1, index: i };
      if (!byPolity.has(ref.polityId)) byPolity.set(ref.polityId, []);
      byPolity.get(ref.polityId).push({ c, ref });
    });
    const blocks = plan.decisions
      .map((d) => {
        const mine = byPolity.get(d.polityId) || [];
        const rows = mine.length
          ? mine
              .map(
                ({ c, ref }) => `
            <label class="review-item">
              <input type="checkbox" checked data-polity="${d.polityId}" data-index="${ref.index}">
              <div>
                <div class="rv-head"><b>${esc(d.name)}</b><span class="rv-cmd">${esc(cmdText(c, names))}</span></div>
                ${d.reason ? `<div class="rv-reason">${esc(d.reason)}</div>` : ''}
              </div>
            </label>`,
              )
              .join('')
          : '<div class="review-note">今年没有命令。</div>';
        const audits = (d.audits || [])
          .map((a) => `<div class="review-note"><span class="audit-chip ${a.outcome}">${a.outcome === 'allow' ? '放行' : a.outcome === 'soften' ? '降级' : '退回'}</span> ${esc(a.kind)}:${esc(a.reason)}</div>`)
          .join('');
        const rej = (d.rejected || [])
          .map((r) => `<div class="review-note">拒收:${esc(r.reason)}</div>`)
          .join('');
        return `<div class="review-block"><div class="rv-head"><b>${esc(d.name)}</b><span class="muted">P${d.polityId} · ${mine.length} 条命令</span></div>${rows}${audits}${rej}</div>`;
      })
      .join('');
    el.reviewBody.innerHTML =
      `<div class="review-note">取消勾选 = 这条命令不执行(玩家/DM 否决)。Jev 只审高影响命令(宣战/坚持打);其余命令由你在这里决定。</div>` +
      blocks +
      `<div class="review-note">方案之外还会执行:小事件裁决产生的 ${(plan.pettyCommands || []).length} 条命令、DM 小决策产生的 ${(plan.dmCommands || []).length} 条命令。</div>`;
  }

  /** 复核模式第二步:按勾选结果提交 */
  async function commitRound() {
    if (!S.plan || !S.sessionId) return;
    const reject = [...el.reviewBody.querySelectorAll('input[type=checkbox][data-polity]')]
      .filter((x) => !x.checked)
      .map((x) => ({ polityId: Number(x.dataset.polity), index: Number(x.dataset.index) }));
    try {
      setBusy(true, '正在提交本回合…', reject.length ? `已否决 ${reject.length} 条命令;其余交给引擎推演。` : '全部放行;交给引擎推演。');
      const d = await api('/api/monarch/commit', { sessionId: S.sessionId, reject });
      S.plan = null;
      el.reviewPanel.hidden = true;
      await applyState(d.state);
      const r = d.round;
      toast(`第 ${r.round} 回合已提交:第 ${fmtInt(yearOf(r.fromYear))} → ${fmtInt(yearOf(r.toYear))} 年${reject.length ? ` · 否决 ${reject.length} 条` : ''}`);
    } catch (e) {
      toast(`提交失败:${e instanceof Error ? e.message : String(e)}`, true);
    } finally {
      setBusy(false);
      refreshButtons();
    }
  }

  function cancelReview() {
    S.plan = null;
    if (el.reviewPanel) el.reviewPanel.hidden = true;
    toast('方案已放弃(还没推演,世界没有变化)');
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
    const mock = el.pettyMock.checked || el.mock.checked;
    const d = await api('/api/petty/setup', {
      sessionId: S.sessionId,
      mock,
      profile: el.pettyProfile.value,
      maxQuestions: int(el.pettyMax, 8),
      apiKey: mock ? '' : el.pettyKey.value,
      // 引导里填过的自定义地址/模型(留空 = 官方默认)
      baseUrl: mock ? '' : (el.obJevBase ? el.obJevBase.value.trim() : ''),
      model: mock ? '' : (el.obJevModel ? el.obJevModel.value.trim() : ''),
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
        saveCfg(cfgFromForm());
        if (!S.worldId) return;
        clearTiles();
        clearVecCache();
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

    // 首次引导:保存两把 Key(落盘 localStorage),有会话就顺手接上
    if (el.btnOnboardSave) {
      el.btnOnboardSave.addEventListener('click', () => {
        applyOnboardToForm();
        const cfg = cfgFromForm();
        saveCfg(cfg);
        hideOnboard();
        toast('配置已存在这台机器;只发给 127.0.0.1 的监视台进程。');
        if (S.sessionId) {
          if (cfg.features.llm) connectMonarchNow().catch((e) => toast(`君主模式未连上:${e instanceof Error ? e.message : String(e)}`, true));
          if (cfg.features.jev) connectPetty(true).catch((e) => toast(`Jev 未连上:${e instanceof Error ? e.message : String(e)}`, true));
        }
      });
    }
    if (el.btnOnboardSkip) {
      el.btnOnboardSkip.addEventListener('click', () => {
        // 跳过不等于关掉君主：保留 LLM 扮演、切成 mock，这样「先演示」时君主仍会开口。
        saveCfg({ ...cfgFromForm(), onboarded: true, features: { llm: true, jev: false }, mock: true });
        if (el.mock) el.mock.checked = true;
        if (el.featLlm) el.featLlm.checked = true;
        if (el.featJev) el.featJev.checked = false;
        hideOnboard();
        toast('已跳过:先用 mock 离线演示;随时点顶栏「参数」补 Key。');
      });
    }
    for (const id of ['obProvider', 'obBaseUrl', 'obModel', 'obKey', 'obJevKey', 'obJevBase', 'obJevModel']) {
      const input = el[id];
      if (input) input.addEventListener('input', onboardState);
    }
    if (el.featJev) {
      el.featJev.addEventListener('change', () => {
        if (el.pettyEnable) el.pettyEnable.checked = el.featJev.checked;
      });
    }
    if (el.reviewMode) {
      el.reviewMode.addEventListener('change', () => {
        if (el.reviewMode.checked && el.btnAuto) el.btnAuto.disabled = true;
        refreshButtons();
      });
    }
    if (el.btnReviewCommit) el.btnReviewCommit.addEventListener('click', () => { void commitRound(); });
    if (el.btnReviewCancel) el.btnReviewCancel.addEventListener('click', () => cancelReview());

    // 君主卡保存(事件委托:卡片是动态渲染的)
    el.tabBody.addEventListener('click', (e) => {
      const btn = e.target.closest('#btnCrownSave');
      if (!btn) return;
      const polityId = Number(btn.dataset.polity);
      const ta = el.tabBody.querySelector('#crownPersona');
      if (!ta) return;
      void (async () => {
        try {
          const d = await api('/api/monarch/card', { sessionId: S.sessionId, polityId, patch: { persona: ta.value } });
          if (d.state) await applyState(d.state);
          toast('角色卡已保存(只影响提示词与审核,不改引擎数值)');
        } catch (err) {
          toast(`保存角色卡失败:${err instanceof Error ? err.message : String(err)}`, true);
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
    if (el.magicPalette) {
      el.magicPalette.addEventListener('change', () => {
        const key = el.magicPalette.value;
        if (!key) { setMagicColors(null); return; }
        if (key === 'custom') { setMagicColors(magicColorsFromInputs()); return; }
        const preset = MAGIC_PALETTES[key];
        setMagicColors(preset ? [...preset] : null);
      });
    }
    for (const picker of [el.magicColor0, el.magicColor1, el.magicColor2]) {
      if (!picker) continue;
      picker.addEventListener('change', () => {
        if (el.magicPalette) el.magicPalette.value = 'custom';
        setMagicColors(magicColorsFromInputs());
      });
    }
    if (el.btnMagicColorsReset) {
      el.btnMagicColorsReset.addEventListener('click', () => {
        setMagicColors(null);
        if (el.magicPalette) el.magicPalette.value = '';
      });
    }

    window.addEventListener('resize', () => resizeCanvas());
    // 底图后台预取只在用户停下来之后做:服务端渲染一张 2048 底图要 2–3 秒,会占住线程
    const markActive = () => { lastActive = performance.now(); };
    for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown']) {
      window.addEventListener(ev, markActive, { passive: true });
    }
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

  const savedCfg = loadCfg();
  applyCfg(savedCfg);
  bind();
  if (!savedCfg.onboarded) showOnboard();
  refreshButtons();
  resizeCanvas();
})();
