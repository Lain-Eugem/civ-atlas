/* 地区栅格:把服务端下发的 gzip+base64 的 Uint16 州归属图解到内存,并提供 O(1) 的本地命中查询。
 * 和 vec-draw.js / labels.js / regions.js 一样是普通 <script>(IIFE),全局名 CivRegionAtlas;
 * 不用 import/export,不碰 DOM、不缓存 DOM。
 *
 * 服务端契约(GET /api/map/region-atlas?sessionId=<id>&scale=2):
 *   { w, h, scale,
 *     regions: [{ region, name, polity:{id,name,color}|null, biomeName, area, capacity,
 *                 elevation, seatName, cells, river:{cells,majorCells,lengthKm,maxFlux}|null }],
 *     owner: number[]     // 州 → 国 id(-1 无主),开局连续点选用;旧服务端没有时从 regions[].polity.id 拼
 *     dataGzB64: string }
 * dataGzB64 = gzip(Uint16Array 小端, 长度 w*h, 0xFFFF=水) 再 base64。
 * 默认 scale=2 时 w*h = 1024×512,世界主图是 2048×1024(mapW = w*scale)。
 *
 * 用途:悬停时用 lookup(世界像素) 在本地拿州 id(3×3 多数派修正半像素错位),
 * 不再每次 pointermove 都打 /api/map/region-info;meta(id) 取该州的展示信息;
 * ownerOf(region) / regionsOf(polity) 给区域点选面板用;snapshot() 给高亮覆盖层画栅格。
 */
(function () {
  'use strict';

  /** 栅格里的「水/无主」哨兵值;服务端约定 0xFFFF */
  const WATER = 0xFFFF;
  /** atlas 默认降采样倍数(1024×512 栅格 ↔ 2048×1024 世界主图) */
  const DEFAULT_SCALE = 2;
  /** 只用浏览器内置的 DecompressionStream('gzip'),不引第三方解压库 */
  const GZIP_FORMAT = 'gzip';

  /** 当前会话的地图数据;null = 未加载。换会话整体替换,不做增量。 */
  let state = null;
  /** 每次 load/clear 递增;await 回来发现 token 变了 = 被更新的请求取代,丢弃旧结果 */
  let loadToken = 0;
  /** lookup 的 3×3 邻域临时区(模块级复用,悬停时零分配) */
  const nbIds = new Uint16Array(9);

  /* ------------------------------------------------------------------ *
   * 解码
   * ------------------------------------------------------------------ */

  function b64ToBytes(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** ReadableStream → ArrayBuffer;优先 Response(浏览器全支持),老环境退回 reader 手拼 */
  async function streamToBuffer(stream) {
    if (typeof Response === 'function') return new Response(stream).arrayBuffer();
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      const c = r.value;
      const n = c && typeof c.byteLength === 'number' ? c.byteLength : c ? c.length : 0;
      chunks.push(c);
      total += n;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      out.set(c, off);
      off += c && typeof c.byteLength === 'number' ? c.byteLength : c.length;
    }
    return out.buffer;
  }

  /** base64 → gzip → Uint16Array(小端);长度必须正好是 w*h,否则报错(避免读越界静默错位) */
  async function decodeAtlas(dataGzB64, expect) {
    const bytes = b64ToBytes(dataGzB64);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(GZIP_FORMAT));
    const buf = await streamToBuffer(stream);
    if (buf.byteLength % 2 !== 0) throw new Error('解压长度不是 2 的倍数: ' + buf.byteLength);
    const cells = new Uint16Array(buf);
    if (expect > 0 && cells.length !== expect) {
      throw new Error('栅格长度不符: 期望 ' + expect + ' 格, 实际 ' + cells.length + ' 格');
    }
    return cells;
  }

  /* ------------------------------------------------------------------ *
   * 本地查询
   * ------------------------------------------------------------------ */

  /**
   * 纯函数版 lookup:世界像素 → 州 id。
   *   ax = floor(mx / mapW * w), ay = floor(my / mapH * h)(越界夹到边缘);
   *   在 3×3 邻域里取出现次数最多的有效州 id(0xFFFF=水,不参与);
   *   并列时如果中心本身有效,优先中心(治所通常落在州中心,边界上 3×3 容易一边倒)。
   * 全无效 → null。O(1)(固定 9 格、最多 81 次比较),不分配大对象。
   * 导出成 _lookup 方便 Node 侧单测(lookup(cells, w, h, mx, my, mapW, mapH))。
   */
  function lookupFrom(cells, w, h, mx, my, mapW, mapH) {
    if (!cells || !(w > 0) || !(h > 0) || !(mapW > 0) || !(mapH > 0)) return null;
    if (typeof mx !== 'number' || typeof my !== 'number' || !isFinite(mx) || !isFinite(my)) return null;

    let ax = Math.floor((mx / mapW) * w);
    let ay = Math.floor((my / mapH) * h);
    if (ax < 0) ax = 0; else if (ax >= w) ax = w - 1;
    if (ay < 0) ay = 0; else if (ay >= h) ay = h - 1;

    const center = cells[ay * w + ax];
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const y = ay + dy;
      if (y < 0 || y >= h) continue;
      const row = y * w;
      for (let dx = -1; dx <= 1; dx++) {
        const x = ax + dx;
        if (x < 0 || x >= w) continue;
        const v = cells[row + x];
        if (v !== WATER) nbIds[m++] = v;
      }
    }
    if (m === 0) return null;

    // 多数派:扫描顺序左上→右下,严格大于才换,所以并列时取先遇到的那个(确定性)
    let best = -1, bestCount = 0;
    for (let i = 0; i < m; i++) {
      const id = nbIds[i];
      let c = 0;
      for (let j = 0; j < m; j++) if (nbIds[j] === id) c++;
      if (c > bestCount) { bestCount = c; best = id; }
    }
    // 中心优先:中心有效且中心票数并列最多 → 用中心
    if (center !== WATER) {
      let cc = 0;
      for (let i = 0; i < m; i++) if (nbIds[i] === center) cc++;
      if (cc === bestCount) return center;
    }
    return best;
  }

  /* ------------------------------------------------------------------ *
   * 对外 API
   * ------------------------------------------------------------------ */

  /** 州 → 国:服务端 owner 数组优先;旧服务端没下发时退回用 regions[].polity.id 拼 */
  function ownerArrayFrom(regions, resOwner) {
    if (Array.isArray(resOwner)) {
      const out = new Int16Array(resOwner.length);
      for (let i = 0; i < resOwner.length; i++) out[i] = Number(resOwner[i]) | 0;
      return out;
    }
    if (!regions.length) return null;
    let max = -1;
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i];
      if (r && typeof r.region === 'number' && r.region > max) max = r.region;
    }
    if (max < 0) return null;
    const out = new Int16Array(max + 1);
    out.fill(-1);
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i];
      if (!r || typeof r.region !== 'number') continue;
      const pid = r.polity && typeof r.polity.id === 'number' ? r.polity.id : -1;
      out[r.region] = pid | 0;
    }
    return out;
  }

  /** 拉取并解码一个会话的地区栅格。
   * @param {function(string):Promise<object>} apiFetch app.js 里的 api(url) 或 fetch 包装
   * @param {string|function():string} sessionId 会话 id(也可传函数,每次调用取当前值)
   * @param {{scale?:number}} [options]
   * @returns {Promise<boolean>} true=成功;失败(不支持 DecompressionStream/请求/解码)只 warn,不抛
   */
  async function load(apiFetch, sessionId, options) {
    const opt = options || {};
    let scale = opt.scale === undefined ? DEFAULT_SCALE : Number(opt.scale);
    if (!isFinite(scale) || scale <= 0) scale = DEFAULT_SCALE;

    const myToken = ++loadToken;
    state = null; // 换会话先清:旧世界的数据绝不能拿来查新会话

    if (typeof apiFetch !== 'function') {
      console.warn('[CivRegionAtlas] load:缺少 apiFetch 函数');
      return false;
    }
    const sid = typeof sessionId === 'function' ? sessionId() : sessionId;
    if (sid === undefined || sid === null || String(sid) === '') {
      console.warn('[CivRegionAtlas] load:缺少 sessionId');
      return false;
    }
    if (typeof DecompressionStream !== 'function') {
      console.warn('[CivRegionAtlas] 当前浏览器不支持 DecompressionStream,无法解码地区栅格');
      return false;
    }

    const url = '/api/map/region-atlas?sessionId=' + encodeURIComponent(String(sid)) +
      '&scale=' + encodeURIComponent(String(scale));
    try {
      const res = await apiFetch(url);
      if (myToken !== loadToken) return false; // 已被更新的 load/clear 取代
      if (!res || typeof res !== 'object') throw new Error('响应不是对象');

      const w = Math.floor(Number(res.w));
      const h = Math.floor(Number(res.h));
      if (!(w > 0) || !(h > 0)) throw new Error('w/h 无效: ' + res.w + '×' + res.h);
      if (typeof res.dataGzB64 !== 'string' || !res.dataGzB64) throw new Error('缺少 dataGzB64');

      const cells = await decodeAtlas(res.dataGzB64, w * h);
      if (myToken !== loadToken) return false;

      const respScale = Number(res.scale);
      const useScale = isFinite(respScale) && respScale > 0 ? respScale : scale;
      const regions = Array.isArray(res.regions) ? res.regions : [];
      const byId = new Map();
      for (let i = 0; i < regions.length; i++) {
        const r = regions[i];
        if (r && typeof r.region === 'number') byId.set(r.region, r);
      }
      // 世界主图尺寸:默认 w*scale;服务端若直接给了 mapW/mapH(或 worldW/worldH)就信它
      const respMapW = Number(res.mapW !== undefined ? res.mapW : res.worldW);
      const respMapH = Number(res.mapH !== undefined ? res.mapH : res.worldH);
      const mapW = isFinite(respMapW) && respMapW > 0 ? respMapW : w * useScale;
      const mapH = isFinite(respMapH) && respMapH > 0 ? respMapH : h * useScale;
      const owner = ownerArrayFrom(regions, res.owner);
      state = { w, h, scale: useScale, cells, regions, byId, owner, mapW, mapH };
      return true;
    } catch (err) {
      if (myToken === loadToken) state = null;
      console.warn('[CivRegionAtlas] 加载地区栅格失败:', err && err.message ? err.message : err);
      return false;
    }
  }

  /** 是否已有一份可用的栅格 */
  function ready() { return state !== null; }

  /** 本次下发的州元数据条数 */
  function count() { return state ? state.regions.length : 0; }

  /** 州 id → 服务端下发的元数据(不存在 = null) */
  function meta(regionId) {
    if (!state || regionId === undefined || regionId === null) return null;
    const m = state.byId.get(regionId);
    return m === undefined ? null : m;
  }

  /** 世界像素 → 州 id(0xFFFF=水/无主 → null);未加载 → null。O(1)。 */
  function lookup(mx, my, mapW, mapH) {
    if (!state) return null;
    return lookupFrom(state.cells, state.w, state.h, mx, my, mapW, mapH);
  }

  /** 州 id → 所属国 id(0 起,-1=无主);未加载/越界 → -1 */
  function ownerOf(regionId) {
    if (!state || typeof regionId !== 'number' || !isFinite(regionId) || regionId < 0) return -1;
    if (state.owner && regionId < state.owner.length) return state.owner[regionId];
    const m = state.byId.get(regionId);
    return m && m.polity && typeof m.polity.id === 'number' ? m.polity.id : -1;
  }

  /** 某国的全部州 id(按州号升序);未加载 → [] */
  function regionsOf(polityId) {
    const out = [];
    if (!state || typeof polityId !== 'number' || polityId < 0) return out;
    if (state.owner) {
      for (let r = 0; r < state.owner.length; r++) if (state.owner[r] === polityId) out.push(r);
      return out;
    }
    for (const pair of state.byId) {
      const m = pair[1];
      if (m && m.polity && m.polity.id === polityId) out.push(pair[0]);
    }
    out.sort((a, b) => a - b);
    return out;
  }

  /** 只读快照(高亮覆盖层用):cells / owner 是内部数组,调用方不要改。 */
  function snapshot() {
    if (!state) return null;
    return {
      w: state.w,
      h: state.h,
      scale: state.scale,
      mapW: state.mapW,
      mapH: state.mapH,
      cells: state.cells,
      owner: state.owner,
      regions: state.regions,
      byId: state.byId,
    };
  }

  /** 栅格/世界尺寸信息;未加载 = null */
  function size() {
    if (!state) return null;
    return { w: state.w, h: state.h, scale: state.scale, mapW: state.mapW, mapH: state.mapH };
  }

  /** 清缓存(换会话/换世界时调) */
  function clear() {
    loadToken++;
    state = null;
  }

  const API = {
    load: load,
    ready: ready,
    count: count,
    meta: meta,
    lookup: lookup,
    ownerOf: ownerOf,
    regionsOf: regionsOf,
    snapshot: snapshot,
    size: size,
    clear: clear,
    /** 纯函数测试入口:lookupFrom(cells, w, h, mx, my, mapW, mapH) */
    _lookup: lookupFrom,
    /** 哨兵值 0xFFFF(测试/调试用) */
    WATER: WATER,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else globalThis.CivRegionAtlas = API;
})();
