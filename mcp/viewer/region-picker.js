/*
 * 疆域连续点选覆盖层(独立客户端模块,IIFE,globalThis.CivRegionPicker)。
 *
 * 由开局面板(mcp/viewer/start-custom.js)调用:
 *   CivRegionPicker.open({
 *     nations: [{ polityId, name, color, capital:{x,y} }, ...],  // /api/start/nations 的列表,capital 是世界像素
 *     api: fetch 包装, sessionId,                                // 用于按需补拉 region-atlas
 *     initialPolityId?, initialSelection?: number[],
 *     onSelection(sel:number[], highlightPolityId:number|null),
 *     onNation(polityId), onExit()
 *   })
 *   CivRegionPicker.close() / selection() / setSelection(ids) / highlightPolity(pid) / isActive()
 *
 * 交互:
 *   - 点一个州:它属于某国 → 高亮该国全部州,并平滑飞到该国国都居中(CivMap.flyTo,跨 180° 取最近镜像)
 *   - 点高亮国(或任意国)的州 / 无主州 → 选中/取消(青色),可跨州连续点
 *   - 再点另一个国家的州 → 切换高亮国(已选州保留)
 *   - 地图拖动/缩放照常(app.js 管),覆盖层每帧跟着重画
 *   - Esc → 清空选择 + 退出;面板上的「退出选疆域」按钮走 close()
 *
 * 实现要点:不改 app.js。覆盖层是 #mapWrap 里的一张 absolute canvas(pointer-events:none),
 * 用 window.CivMap.view() 拿相机参数,按 app.js draw() 相同的镜像/折返规则贴图;
 * 命中检测用 CivMap.screenToWorld + 折返公式,再用 CivRegionAtlas.lookup 查州号。
 * 州→国对照来自 region-atlas 响应新增的 owner[]。
 */
(function () {
  'use strict';

  var CANVAS_ID = 'regionPickerLayer';
  var WATER = 0xffff;

  /** 国家高亮色(暖橙) / 已选州(青) */
  var HL_FILL = [255, 168, 48, 104];
  var HL_EDGE = [196, 96, 0, 230];
  var SEL_FILL = [40, 196, 236, 150];
  var SEL_EDGE = [0, 120, 168, 235];

  var st = {
    active: false,
    nations: [],
    api: null,
    sessionId: '',
    hlPid: null,
    sel: [],
    onSelection: null,
    onNation: null,
    onExit: null,
    raf: 0,
    canvas: null,
    ctx: null,
    off: null,
    offKey: '',
    dpr: 1,
    down: null,
    cursorBefore: '',
  };

  function mapEl() {
    return document.getElementById('map');
  }

  function wrap() {
    return document.getElementById('mapWrap');
  }

  function wrapX(v, W) {
    var r = v % W;
    return r < 0 ? r + W : r;
  }

  // ── 覆盖画布 ───────────────────────────────────────────────────────────────
  function ensureCanvas() {
    var m = mapEl();
    var host = wrap();
    if (!m || !host) return null;
    var cv = document.getElementById(CANVAS_ID);
    if (!cv) {
      cv = document.createElement('canvas');
      cv.id = CANVAS_ID;
      cv.setAttribute('aria-hidden', 'true');
      host.appendChild(cv);
    }
    cv.style.position = 'absolute';
    cv.style.inset = '0';
    cv.style.width = '100%';
    cv.style.height = '100%';
    cv.style.pointerEvents = 'none';
    cv.style.zIndex = '2';
    st.canvas = cv;
    st.ctx = cv.getContext('2d');
    var dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    var cw = m.clientWidth || 1;
    var ch = m.clientHeight || 1;
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
      cv.width = Math.round(cw * dpr);
      cv.height = Math.round(ch * dpr);
    }
    st.dpr = dpr;
    return cv;
  }

  function hideCanvas() {
    var cv = document.getElementById(CANVAS_ID);
    if (cv && cv.parentNode) cv.parentNode.removeChild(cv);
    st.canvas = null;
    st.ctx = null;
  }

  // ── 高亮栅格(州号 → 颜色) ─────────────────────────────────────────────────
  function atlasSnapshot() {
    var atlas = window.CivRegionAtlas;
    if (!atlas || !atlas.ready || !atlas.ready()) return null;
    return atlas.snapshot ? atlas.snapshot() : null;
  }

  function ensureAtlas() {
    var atlas = window.CivRegionAtlas;
    if (!atlas) return Promise.resolve(false);
    if (atlas.ready && atlas.ready()) return Promise.resolve(true);
    if (!st.api || !st.sessionId || !atlas.load) return Promise.resolve(false);
    return Promise.resolve(atlas.load(function (url) { return st.api(url); }, st.sessionId, { scale: 2 }))
      .then(function (ok) { return !!ok; })
      .catch(function () { return false; });
  }

  function classOf(region, selSet, hlPid, owner) {
    if (selSet[region]) return 1;
    if (hlPid != null && owner && owner[region] === hlPid) return 2;
    return 0;
  }

  /** 用 atlas 的 cells/owner 画一张 w×h 的离屏图;颜色只在 class 变化处描边。 */
  function buildOffscreen(snap) {
    var w = snap.w;
    var h = snap.h;
    var cells = snap.cells;
    var owner = snap.owner;
    var selSet = {};
    for (var s = 0; s < st.sel.length; s++) selSet[st.sel[s]] = true;
    var key = w + 'x' + h + '|' + st.hlPid + '|' + st.sel.join(',');
    if (st.off && st.offKey === key) return st.off;

    var cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    var ctx = cv.getContext('2d');
    var img = ctx.createImageData(w, h);
    var data = img.data;

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        var r = cells[i];
        if (r === WATER || r == null) continue;
        var cls = classOf(r, selSet, st.hlPid, owner);
        if (!cls) continue;
        // 描边:上下左右任一邻居的 class 不同(横向跨 180° 环绕,纵向不环绕)
        var left = x === 0 ? w - 1 : x - 1;
        var right = x === w - 1 ? 0 : x + 1;
        var edge = false;
        if (classOf(cells[y * w + left], selSet, st.hlPid, owner) !== cls) edge = true;
        else if (classOf(cells[y * w + right], selSet, st.hlPid, owner) !== cls) edge = true;
        else if (y > 0 && classOf(cells[i - w], selSet, st.hlPid, owner) !== cls) edge = true;
        else if (y < h - 1 && classOf(cells[i + w], selSet, st.hlPid, owner) !== cls) edge = true;
        var src = edge ? (cls === 1 ? SEL_EDGE : HL_EDGE) : (cls === 1 ? SEL_FILL : HL_FILL);
        var o = i * 4;
        data[o] = src[0];
        data[o + 1] = src[1];
        data[o + 2] = src[2];
        data[o + 3] = src[3];
      }
    }
    ctx.putImageData(img, 0, 0);
    st.off = cv;
    st.offKey = key;
    return cv;
  }

  // ── 相机 / 折返 ────────────────────────────────────────────────────────────
  function civMap() {
    return window.CivMap || null;
  }

  /** 客户端像素 → 世界上未折叠坐标(与 app.js 的 viewMetrics 一致) */
  function baseMetrics(view) {
    var k = view.fit * view.k;
    var P = view.mapW * k;
    var H = view.mapH * k;
    return {
      k: k,
      P: P,
      H: H,
      oxAbs: (view.cw - P) / 2 + view.x,
      oyAbs: (view.ch - H) / 2 + view.y,
    };
  }

  /** 客户端像素 → {mx,my}(世界像素,折返到 0..mapW / 0..mapH);点不到 → null */
  function mapPointAt(clientX, clientY) {
    var view = civMap() && civMap().view ? civMap().view() : null;
    if (!view) return null;
    var m = baseMetrics(view);
    var ux = wrapX((clientX - m.oxAbs) / m.k, view.mapW);
    var vy = (clientY - m.oyAbs) / m.k;
    var n = Math.floor(vy / view.mapH);
    var odd = ((n % 2) + 2) % 2 === 1;
    var mx = odd ? wrapX(ux - view.mapW / 2, view.mapW) : ux;
    var my = odd ? (n + 1) * view.mapH - vy : vy - n * view.mapH;
    if (!isFinite(mx) || !isFinite(my) || my < 0 || my > view.mapH) return null;
    return { mx: mx, my: my, view: view };
  }

  function regionAt(clientX, clientY) {
    var atlas = window.CivRegionAtlas;
    if (!atlas || !atlas.ready || !atlas.ready()) return null;
    var p = mapPointAt(clientX, clientY);
    if (!p) return null;
    var r = atlas.lookup(p.mx, p.my, p.view.mapW, p.view.mapH);
    return r == null || r === WATER ? null : r;
  }

  // ── 绘制 ──────────────────────────────────────────────────────────────────
  function draw() {
    if (!st.active) return;
    var view = civMap() && civMap().view ? civMap().view() : null;
    var cv = st.canvas;
    var ctx = st.ctx;
    if (!view || !cv || !ctx) return;
    var m = mapEl();
    if (!m) return;
    var dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    if (cv.width !== Math.round(m.clientWidth * dpr) || cv.height !== Math.round(m.clientHeight * dpr)) {
      cv.width = Math.round(m.clientWidth * dpr);
      cv.height = Math.round(m.clientHeight * dpr);
      st.dpr = dpr;
    }
    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    ctx.clearRect(0, 0, cv.width / st.dpr, cv.height / st.dpr);

    if (st.hlPid == null && st.sel.length === 0) return;
    var snap = atlasSnapshot();
    if (!snap) return;
    var off = buildOffscreen(snap);
    if (!off) return;

    var mm = baseMetrics(view);
    var cw = view.cw;
    var ch = view.ch;
    var P = mm.P;
    var H = mm.H;
    var oxAbs = mm.oxAbs;
    var oyAbs = mm.oyAbs;
    var ox = ((oxAbs % P) + P) % P - P;
    var n0 = Math.floor((0 - oyAbs) / H);
    var n1 = Math.floor((ch - oyAbs) / H);
    var mCount = Math.max(1, Math.ceil(cw / P) + 1);
    ctx.imageSmoothingEnabled = true;
    for (var n = n0; n <= n1; n++) {
      var yTop = oyAbs + n * H;
      if (yTop > ch || yTop + H < 0) continue;
      var odd = ((n % 2) + 2) % 2 === 1;
      for (var k = 0; k < mCount; k++) {
        var x = ox + k * P - (odd ? P / 2 : 0);
        if (x > cw || x + P < 0) continue;
        if (odd) {
          ctx.save();
          ctx.translate(0, 2 * yTop + H);
          ctx.scale(1, -1);
          ctx.drawImage(off, x, yTop, P, H);
          ctx.restore();
        } else {
          ctx.drawImage(off, x, yTop, P, H);
        }
      }
    }
  }

  function tick() {
    if (!st.active) return;
    draw();
    st.raf = window.requestAnimationFrame(tick);
  }

  // ── 选择状态 ──────────────────────────────────────────────────────────────
  function emitSelection() {
    if (typeof st.onSelection === 'function') {
      try { st.onSelection(st.sel.slice(), st.hlPid); } catch (e) { console.warn('region-picker onSelection', e); }
    }
  }

  function emitNation() {
    if (typeof st.onNation === 'function') {
      try { st.onNation(st.hlPid); } catch (e) { console.warn('region-picker onNation', e); }
    }
  }

  function nationOf(pid) {
    for (var i = 0; i < st.nations.length; i++) if (st.nations[i].polityId === pid) return st.nations[i];
    return null;
  }

  function flyToNation(pid) {
    var n = nationOf(pid);
    var cm = civMap();
    if (!n || !n.capital || !cm || !cm.flyTo) return;
    var x = Number(n.capital.x);
    var y = Number(n.capital.y);
    if (!isFinite(x) || !isFinite(y)) return;
    cm.flyTo(x, y, null, 480);
  }

  function toggleSelected(region) {
    var idx = st.sel.indexOf(region);
    if (idx >= 0) st.sel.splice(idx, 1);
    else st.sel.push(region);
    st.sel.sort(function (a, b) { return a - b; });
    emitSelection();
  }

  function handleClick(clientX, clientY) {
    var atlas = window.CivRegionAtlas;
    var r = regionAt(clientX, clientY);
    if (r == null || !atlas) return;
    var owner = atlas.ownerOf ? atlas.ownerOf(r) : -1;
    if (owner >= 0 && owner !== st.hlPid) {
      st.hlPid = owner;
      flyToNation(owner);
      emitNation();
      emitSelection();
      return;
    }
    // 高亮国内的州 / 无主州 / 已高亮国的州:选中或取消
    toggleSelected(r);
  }

  // ── 事件 ──────────────────────────────────────────────────────────────────
  function onPointerDown(e) {
    if (!st.active || e.button !== 0) return;
    st.down = { x: e.clientX, y: e.clientY, id: e.pointerId };
  }

  function onPointerUp(e) {
    if (!st.active || !st.down) return;
    var d = st.down;
    st.down = null;
    if (d.id !== undefined && e.pointerId !== undefined && d.id !== e.pointerId) return;
    var moved = Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y);
    if (moved >= 4) return; // 拖动地图,不算点选
    var m = mapEl();
    if (!m) return;
    var rect = m.getBoundingClientRect();
    // 捕获阶段吃掉这次点击,避免 app.js 顺手选中/取消选中某个国家
    e.preventDefault();
    e.stopPropagation();
    handleClick(e.clientX - rect.left, e.clientY - rect.top);
    // 我们 stopPropagation 吃掉了这次 pointerup,app.js 自己的拖动状态(drag)会留下来,
    // 之后不按键移动鼠标也会平移地图(第二次点击就会点到错的州)。主动派发 pointercancel,
    // 让 app.js 的 pointercancel 监听器把 drag 清掉。
    try {
      m.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: e.pointerId }));
    } catch (_) { /* 没有 PointerEvent 的旧浏览器忽略 */ }
  }

  function onKeyDown(e) {
    if (!st.active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function bind() {
    var m = mapEl();
    if (!m || m.__regionPickerBound) return;
    m.addEventListener('pointerdown', onPointerDown, true);
    m.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('keydown', onKeyDown, true);
    m.__regionPickerBound = true;
  }

  function unbind() {
    var m = mapEl();
    if (m) {
      m.removeEventListener('pointerdown', onPointerDown, true);
      m.removeEventListener('pointerup', onPointerUp, true);
    }
    document.removeEventListener('keydown', onKeyDown, true);
  }

  // ── 对外 API ──────────────────────────────────────────────────────────────
  function open(opts) {
    opts = opts || {};
    var atlasReady = !!(window.CivRegionAtlas && window.CivRegionAtlas.ready && window.CivRegionAtlas.ready());
    var m = mapEl();
    if (!m) return false;
    st.nations = Array.isArray(opts.nations) ? opts.nations.slice() : [];
    st.api = typeof opts.api === 'function' ? opts.api : null;
    st.sessionId = opts.sessionId || '';
    st.hlPid = typeof opts.initialPolityId === 'number' ? opts.initialPolityId : null;
    st.sel = [];
    if (Array.isArray(opts.initialSelection)) {
      for (var i = 0; i < opts.initialSelection.length; i++) {
        var r = opts.initialSelection[i];
        if (typeof r === 'number' && isFinite(r) && r >= 0 && st.sel.indexOf(r) < 0) st.sel.push(r);
      }
      st.sel.sort(function (a, b) { return a - b; });
    }
    st.onSelection = typeof opts.onSelection === 'function' ? opts.onSelection : null;
    st.onNation = typeof opts.onNation === 'function' ? opts.onNation : null;
    st.onExit = typeof opts.onExit === 'function' ? opts.onExit : null;
    st.active = true;
    bind();
    ensureCanvas();
    st.cursorBefore = m.style.cursor || '';
    m.style.cursor = 'crosshair';
    ensureAtlas().then(function () {
      if (!st.active) return;
      tick();
      emitSelection();
    });
    return true;
  }

  function close() {
    if (!st.active) return false;
    st.active = false;
    if (st.raf) { window.cancelAnimationFrame(st.raf); st.raf = 0; }
    st.down = null;
    unbind();
    hideCanvas();
    var m = mapEl();
    if (m) m.style.cursor = st.cursorBefore || '';
    st.hlPid = null;
    st.sel = [];
    var cb = st.onExit;
    st.onExit = null;
    st.onSelection = null;
    st.onNation = null;
    if (typeof cb === 'function') {
      try { cb(); } catch (e) { console.warn('region-picker onExit', e); }
    }
    return true;
  }

  function selection() {
    return st.sel.slice();
  }

  function setSelection(ids) {
    st.sel = [];
    if (Array.isArray(ids)) {
      for (var i = 0; i < ids.length; i++) {
        var r = ids[i];
        if (typeof r === 'number' && isFinite(r) && r >= 0 && st.sel.indexOf(r) < 0) st.sel.push(r);
      }
    }
    st.sel.sort(function (a, b) { return a - b; });
    emitSelection();
  }

  function highlightPolity(pid, fly) {
    st.hlPid = typeof pid === 'number' ? pid : null;
    if (fly && st.hlPid != null) flyToNation(st.hlPid);
    emitSelection();
  }

  function isActive() {
    return st.active;
  }

  /** 调试/测试用:内部状态快照(不参与正常流程) */
  function debugState() {
    return { active: st.active, hlPid: st.hlPid, sel: st.sel.slice(), down: st.down, nations: st.nations.length };
  }

  var API = {
    open: open,
    close: close,
    selection: selection,
    setSelection: setSelection,
    highlightPolity: highlightPolity,
    isActive: isActive,
    debugState: debugState,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else globalThis.CivRegionPicker = API;
})();
