/* 州界线 + 地区悬停信息:查看器里的第二层线(国界之下)和悬停小窗的共用代码。
 * 和 vec-draw.js / labels.js 一样是普通 <script>,全局名 CivRegions;
 * 不依赖 app.js 里的状态:所有参数(视角、屏幕矩形、会话 id)都从 opts 传进来,
 * 所以 Node 里 require 也能测(绘制喂假 canvas,fetch 喂假函数)。
 *
 * 分工:
 *   - 服务端:mcp/owner-map.ts 的 regionBorderLines() 算出所有州界线,随疆域图下发;
 *   - 这里:drawRegionLines() 画线,initHover() 管 pointermove → /api/map/region-info → 小窗。
 */
(function () {
  'use strict';

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

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

  /** 服务端下发的州界线是原始扁平折线,第一次用到时包 bbox(结果按数组缓存,每帧复用) */
  const boxedCache = new WeakMap();
  function boxLines(list) {
    if (!Array.isArray(list)) return [];
    let out = boxedCache.get(list);
    if (out) return out;
    out = list;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (!b || !b.p) { out = list.map(withBox); break; }
    }
    boxedCache.set(list, out);
    return out;
  }

  /** 当前那一份州界线的缓存(setLines 换图/换会话时调;drawRegionLines 也认 opts.lines === 缓存源) */
  let lineCache = { src: null, boxed: null };
  function setLines(lines) {
    if (!lines) { lineCache = { src: null, boxed: null }; return null; }
    if (lineCache.src !== lines) lineCache = { src: lines, boxed: boxLines(lines) };
    return lineCache.boxed;
  }
  function getLines() { return lineCache.boxed; }

  /**
   * 州界线的画法:比国界(墨色 rgba(58,32,20,0.85) 宽 1 dash [4,3])更淡、更细、更碎,
   * 只在有国界压在旁边时当"州界"看。线宽和虚线长度都是屏幕固定值,不随缩放变。
   */
  function regionLineStyle(style) {
    if (style === 'geo' || style === 'satellite') {
      return { stroke: 'rgba(118,134,150,0.34)', width: 0.7, dash: [2, 3], lineCap: 'round', lineJoin: 'round' };
    }
    if (style === 'white' || style === 'classic') {
      return { stroke: 'rgba(90,82,70,0.22)', width: 0.7, dash: [2, 3], lineCap: 'round', lineJoin: 'round' };
    }
    // fantasy(默认手绘风):暖褐色,和国界的墨线一个色系,压淡
    return { stroke: 'rgba(90,70,48,0.30)', width: 0.7, dash: [2, 3], lineCap: 'round', lineJoin: 'round' };
  }

  /**
   * 在 canvas 上画州界线。坐标换算和 vec-draw.js 的 strokeLines / app.js 的 drawOwnerBorders 完全一致:
   *   fx = rect.x + px * sx, fy = rect.yTop + py * sy(sx = P / mapW,sy = H / mapH);
   *   奇数层(odd)先 translate(0, 2*yTop + H) + scale(1, -1) 再按上面的式子画,等价于上下镜像;
   *   bbox 跨 180° 的线(x1 > mapW 或 x0 < 0)在 [0, ±mapW] 两个位置各画一份。
   * opts = { lines, rects, k, P, H, mapW, mapH, cw, ch, style, relK }(和 drawVectorsInto 对齐;
   *        这里只用到 lines / rects / P / H / mapW / mapH / style)。
   * 返回画出来的折线数(lines 为空 / 参数不给 = 0)。每条线只 moveTo/lineTo,整组一次 stroke。
   */
  function drawRegionLines(g, opts) {
    if (!g || !opts) return 0;
    const lines = opts.lines;
    if (!Array.isArray(lines) || !lines.length) return 0;
    const mapW = opts.mapW, mapH = opts.mapH, P = opts.P, H = opts.H;
    if (!(mapW > 0) || !(mapH > 0) || !(P > 0) || !(H > 0)) return 0;
    const rects = Array.isArray(opts.rects) ? opts.rects : [];
    if (!rects.length) return 0;
    const boxed = lines === lineCache.src && lineCache.boxed ? lineCache.boxed : boxLines(lines);
    const sx = P / mapW, sy = H / mapH;
    const st = regionLineStyle(opts.style);
    const shift0 = [0];
    const shiftW = [0, -mapW];
    const shiftE = [0, mapW];

    g.save();
    g.strokeStyle = st.stroke;
    g.lineWidth = st.width;
    g.setLineDash(st.dash);
    g.lineCap = st.lineCap;
    g.lineJoin = st.lineJoin;
    for (let ri = 0; ri < rects.length; ri++) {
      const r = rects[ri];
      if (!r) continue;
      g.save();
      if (r.odd) { g.translate(0, 2 * r.yTop + H); g.scale(1, -1); }
      g.beginPath();
      for (let i = 0; i < boxed.length; i++) {
        const b = boxed[i];
        const p = b && b.p;
        if (!p || p.length < 4) continue;
        const shifts = b.x1 > mapW ? shiftW : b.x0 < 0 ? shiftE : shift0;
        for (let s = 0; s < shifts.length; s++) {
          const sh = shifts[s];
          g.moveTo(r.x + (p[0] + sh) * sx, r.yTop + p[1] * sy);
          for (let k = 2; k + 1 < p.length; k += 2) g.lineTo(r.x + (p[k] + sh) * sx, r.yTop + p[k + 1] * sy);
        }
      }
      g.stroke();
      g.restore();
    }
    g.setLineDash([]);
    g.restore();
    return boxed.length;
  }

  /* ------------------------------------------------------------------ *
   * 悬停小窗
   * ------------------------------------------------------------------ */

  /** pointermove 节流:每 120ms 最多问一次服务端(小窗跟着鼠标走,慢一点也够用) */
  const HOVER_DELAY = 120;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;';
    });
  }

  /** 整数加千位分隔(不依赖 toLocaleString,Node 里结果和浏览器一致) */
  function fmtInt(v) {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    const n = Math.round(v);
    const neg = n < 0;
    const s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return neg ? '-' + s : s;
  }

  function tipRow(k, v) {
    return '<div class="region-tip-row"><span class="region-tip-k">' + k + '</span><span class="region-tip-v">' + v + '</span></div>';
  }

  /**
   * RegionInfo(见 mcp/region-info.ts)→ 小窗 HTML 字符串(纯函数,可直接测)。
   * 字段:州名 / 州号、所属国(带国家色)、群落、面积与人口上限、海拔、河流、治所。
   */
  function formatRegionTip(info) {
    if (!info || typeof info !== 'object') return '';
    const nr = typeof info.region === 'number' ? info.region : -1;
    const name = info.name ? esc(info.name) : nr >= 0 ? '第 ' + (nr + 1) + ' 州' : '—';
    const polity = info.polity && info.polity.name
      ? '<span class="region-tip-polity" style="color:' + esc(info.polity.color) + '">' + esc(info.polity.name) + '</span>'
      : '<span class="muted">无主之地</span>';
    const river = info.river
      ? fmtInt(info.river.cells) + ' 地块<span class="muted">（大河 ' + fmtInt(info.river.majorCells) + '）</span> · ' + fmtInt(info.river.lengthKm) + ' 公里'
      : '<span class="muted">无</span>';
    const seat = info.seatName
      ? esc(info.seatName) + (info.seatTier ? ' <span class="muted">（沿河）</span>' : '')
      : info.seatCell >= 0
        ? '<span class="muted">地块 #' + fmtInt(info.seatCell) + '</span>'
        : '<span class="muted">无</span>';
    return (
      '<div class="region-tip-head"><b>' + name + '</b>' +
      (nr >= 0 && info.name ? '<span class="region-tip-no">#' + fmtInt(nr) + '</span>' : '') +
      '</div>' +
      tipRow('所属国', polity) +
      tipRow('群落', esc(info.biomeName) || '<span class="muted">—</span>') +
      tipRow('面积', fmtInt(info.area) + '<span class="muted"> / 人口上限 </span>' + fmtInt(info.capacity)) +
      tipRow('海拔', fmtInt(info.elevation) + ' 米') +
      tipRow('河流', river) +
      tipRow('治所', seat) +
      (typeof info.cells === 'number' ? tipRow('地块', fmtInt(info.cells)) : '')
    );
  }

  /** 把 info 写进小窗(不传 el = 不显示);info 为空 = 隐藏。返回是否显示 */
  function renderRegionTip(el, info) {
    if (!el) return false;
    if (!info) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return false;
    }
    el.innerHTML = formatRegionTip(info);
    el.classList.remove('hidden');
    return true;
  }

  function createTipElement(doc, host) {
    if (!doc || !doc.createElement) return null;
    const div = doc.createElement('div');
    div.className = 'region-tip hidden';
    const parent = host && host.appendChild ? host : doc.body;
    if (!parent || !parent.appendChild) return null;
    parent.appendChild(div);
    return div;
  }

  /**
   * 绑 pointermove 悬停:客户端坐标 → 世界像素用 opts.worldOf(cx, cy)(查看器传 mapPointAt 包一层),
   * 然后 fetch /api/map/region-info?sessionId=…&x=…&y=…,回来 renderRegionTip()。
   *
   * opts = {
   *   api,        // 可选:统一 fetch 封装(查看器传 app.js 的 api());不传就用 fetch
   *   worldOf,    // 必填:function(canvasX, canvasY) → {x,y} 世界像素 或 null(地图外)
   *   sessionId,  // function() → 当前会话 id(空 = 不查);也接受直接给字符串
   *   el,         // 可选:tooltip 容器(查看器传 #regionTip);不传就自己建一个挂到 canvas 父节点
   *   canvas,     // 可选:默认 #map
   *   bind,       // 可选:false = 不自己挂 pointermove(Lead 在 bindMap 里手动调 hover.query/hide)
   *   onPick,     // 可选:function(info|null),服务端返回时回调
   * }
   * 返回 { el, lookup(x,y), show(info), hide(), dispose(), last() } —— lookup 方便测试,不用真的动鼠标。
   */
  function initHover(opts) {
    const o = opts || {};
    if (typeof o.worldOf !== 'function') throw new Error('CivRegions.initHover: opts.worldOf 必填');
    const doc = typeof document !== 'undefined' ? document : null;
    const canvas = o.canvas || (doc && doc.getElementById ? doc.getElementById('map') : null);
    const tipEl = o.el || createTipElement(doc, canvas && canvas.parentElement);
    const apiFn = typeof o.api === 'function' ? o.api : null;
    const sessionIdOf = typeof o.sessionId === 'function' ? o.sessionId : function () { return o.sessionId; };
    let seq = 0, timer = 0, lastAt = 0, alive = true, lastInfo = null, pending = null;

    function lookup(x, y) {
      const sid = String(sessionIdOf() || '');
      if (!sid) return Promise.resolve(null);
      const url = '/api/map/region-info?sessionId=' + encodeURIComponent(sid) +
        '&x=' + Math.round(x * 100) / 100 + '&y=' + Math.round(y * 100) / 100;
      const p = apiFn
        ? Promise.resolve(apiFn(url))
        : fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
      return p.then(function (d) {
        if (!d || typeof d !== 'object') return null;
        if (d.info !== undefined) return d.info;
        return typeof d.region === 'number' ? d : null;
      }).catch(function () { return null; });
    }

    function place(x, y) {
      if (!tipEl) return;
      const cw = canvas ? canvas.clientWidth || 0 : 0;
      tipEl.style.left = clamp(x + 14, 6, Math.max(6, cw - 260)) + 'px';
      tipEl.style.top = Math.max(6, y - 54) + 'px';
    }

    function show(info, x, y) {
      lastInfo = info;
      if (!tipEl) return;
      if (x !== undefined) place(x, y);
      renderRegionTip(tipEl, info);
      if (typeof o.onPick === 'function') o.onPick(info);
    }

    function hide() {
      pending = null;
      if (timer) { clearTimeout(timer); timer = 0; }
      seq++;
      show(null);
    }

    function query(canvasX, canvasY, world) {
      const mine = ++seq;
      return lookup(world.x, world.y).then(function (info) {
        if (!alive || mine !== seq) return null;
        show(info, canvasX, canvasY);
        return info;
      });
    }

    function flush() {
      timer = 0;
      if (!alive || !pending) return;
      lastAt = Date.now();
      const p = pending;
      pending = null;
      void query(p.cx, p.cy, p.w);
    }

    function onMove(e) {
      if (!alive || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      const world = o.worldOf(cx, cy);
      if (!world) { hide(); return; }
      const gap = HOVER_DELAY - (Date.now() - lastAt);
      if (gap <= 0) {
        lastAt = Date.now();
        void query(cx, cy, world);
        return;
      }
      pending = { cx: cx, cy: cy, w: world };
      if (!timer) timer = setTimeout(flush, gap);
    }

    function onLeave() { hide(); }

    /** 对外方便版:传 canvas 坐标,自己过 worldOf(测试/调试用);地图外 = null */
    function queryAt(cx, cy) {
      const world = o.worldOf(cx, cy);
      if (!world) return Promise.resolve(null);
      return query(cx, cy, world);
    }

    function dispose() {
      alive = false;
      hide();
      if (canvas && canvas.removeEventListener) {
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerleave', onLeave);
      }
    }

    if (o.bind !== false && canvas && canvas.addEventListener) {
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerleave', onLeave);
    }

    return {
      el: tipEl,
      lookup: lookup,
      query: queryAt,
      show: show,
      hide: hide,
      dispose: dispose,
      last: function () { return lastInfo; },
    };
  }

  const API = {
    regionLineStyle: regionLineStyle,
    withBox: withBox,
    boxLines: boxLines,
    setLines: setLines,
    getLines: getLines,
    drawRegionLines: drawRegionLines,
    formatRegionTip: formatRegionTip,
    renderRegionTip: renderRegionTip,
    initHover: initHover,
    hoverDelay: HOVER_DELAY,
  };
  /** CivRegions.hover.init/format/render:initHover 的别名组,方便 Lead 只记一个名字 */
  API.hover = { init: initHover, format: formatRegionTip, render: renderRegionTip };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else globalThis.CivRegions = API;
})();
