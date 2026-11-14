/*
 * 地图文字标签层(浏览器端):画 mcp/labels.ts 下发的 items。
 *
 * 坐标换算与 vec-draw.js 完全相同(同一套视口 rect):
 *   sx  = P / mapW,  sy = H / mapH
 *   fx(px) = r.x + px * sx
 *   fy(py) = r.odd ? (r.yTop + H - py * sy) : (r.yTop + py * sy)
 * rects 是跨 180° / 跨极的同一张图的若干份,每份都画;奇数列(odd)整图上下镜像,
 * 所以世界坐标里的旋转角要取反。
 *
 * 用法(app.js 接线):
 *   CivLabels.draw(ctx, {
 *     items,                 // labels.ts 的 items(或整个 {items,...} 包)
 *     rects,                 // [{ x, yTop, odd }, ...](app.js draw() 里那份)
 *     k, P, H,               // viewMetrics() 的结果
 *     mapW, mapH,            // 世界尺寸(底图 1× 像素,2048×1024)
 *     style,                 // 'fantasy' | 'geo' | 'satellite' | 'white' | 'classic'(classic 不画)
 *     relK,                  // = S.view.k,1 = 默认视图;分级/缩放都按它
 *     cw, ch,                // 可选,可视区 CSS 尺寸(给出后做屏幕裁剪)
 *   })
 *
 * 字号:item.s 是世界单位(底图 1× 像素),屏幕 px = s * (P/mapW) * relK^(g-1),
 * 再夹在 [MIN_PX, MAX_PX];g 是 labels.ts 里的 grow 指数(城名 0.3 / 国名 0.45 / 海 0.5)。
 */
(function () {
  'use strict';

  /** 最小可读字号(与主站 draw.ts MIN_LABEL_PX 一致,CSS px) */
  const MIN_PX = 10.5;
  /** 最大字号(免得放大到 12 倍时国名撑满屏幕) */
  const MAX_PX = 60;

  /** 每类标签的默认值(server 会显式带上 g/d/w;这里兜底,字段缺了也能画) */
  const KIND = {
    polity: { g: 0.45, d: 1, w: 700, group: 'name' },
    capital: { g: 0.3, d: 1, w: 700, group: 'town' },
    bigcity: { g: 0.3, d: 1.3, w: 600, group: 'town' },
    city: { g: 0.3, d: 2, w: 600, group: 'town' },
    town: { g: 0.3, d: 3.2, w: 500, group: 'town' },
    village: { g: 0.3, d: 6, w: 500, group: 'town' },
    ocean: { g: 0.5, d: 1, w: 500, group: 'water' },
    sea: { g: 0.5, d: 1, w: 500, group: 'water' },
    bay: { g: 0.5, d: 1, w: 500, group: 'water' },
    river: { g: 0.35, d: 1, w: 500, group: 'water' },
    lake: { g: 0.35, d: 1, w: 500, group: 'water' },
    mountains: { g: 0.45, d: 1, w: 500, group: 'mountains' },
    desert: { g: 0.45, d: 1, w: 500, group: 'desert' },
    island: { g: 0.4, d: 1, w: 500, group: 'island' },
  };
  const KIND_DEFAULT = { g: 0.35, d: 1, w: 500, group: 'name' };
  /** 聚落五级 0 村 … 4 国都(labels.ts 的 k 是名字,这里换算成下标) */
  const TOWN_LEVEL = { village: 0, town: 1, city: 2, bigcity: 3, capital: 4 };
  /**
   * 字距(px 的倍数,只给"铺开在地形上"的地名用):海洋/海的字拉开一点像海图,
   * 山脊/河的字顺着线拉长。城名/国名不加(主站城名 tracking 也是 0.04,几乎为零)。
   */
  const TRACKING = {
    ocean: 0.5,
    sea: 0.34,
    bay: 0.18,
    mountains: 0.14,
    desert: 0.14,
    river: 0.12,
    lake: 0.06,
    island: 0.05,
  };

  const FONT_FANTASY = '"LXGW WenKai", "Kaiti SC", "STKaiti", "KaiTi", "BiauKai", "Noto Serif SC", "Songti SC", "Microsoft YaHei", serif';
  const FONT_GEO = '"Noto Serif SC", "Songti SC", "STSong", "SimSun", "Source Han Serif SC", "Microsoft YaHei", serif';
  const FONT_SANS = '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", sans-serif';

  /**
   * 不同画风的调色板。国名用 item.c(国色)与 palette.name 混出墨色;
   * 城镇按等级深浅;河湖海用 palette.water。halo 是描边色,保证压在任何地形上都读得清。
   */
  const PALETTES = {
    fantasy: {
      font: FONT_FANTASY,
      name: '#241d16',
      town: ['#4a3d2f', '#3f3428', '#342a20', '#2a2118', '#211a13'],
      water: '#1d4a60',
      mountain: '#4d3520',
      desert: '#7c5a2b',
      island: '#3f4a2c',
      halo: 'rgba(242, 231, 203, 0.88)', // 纸色描边(主站 PAPER_HALO)
      haloPx: 2.6,
      mix: 0.55, // 国色往墨色里混的比例
    },
    geo: {
      font: FONT_GEO,
      name: '#123552',
      town: ['#23445f', '#1f3f5d', '#1b3a58', '#16334d', '#0f2a42'],
      water: '#1b5e8a',
      mountain: '#5b4a35',
      desert: '#8a6a3a',
      island: '#46603b',
      halo: 'rgba(255, 255, 255, 0.90)',
      haloPx: 2.4,
      mix: 0.45,
    },
    satellite: {
      font: FONT_SANS,
      name: '#e9f1f9',
      town: ['#dfe9f2', '#e3edf5', '#e7f0f8', '#f0f6fb', '#ffffff'],
      water: '#a9cbe4',
      mountain: '#d8c9b3',
      desert: '#e0b781',
      island: '#b9d0a8',
      halo: 'rgba(4, 8, 14, 0.86)',
      haloPx: 2.8,
      mix: 0.35,
    },
    white: {
      font: FONT_SANS,
      name: '#22303c',
      town: ['#414b55', '#3a444e', '#333d47', '#2a343e', '#1f2933'],
      water: '#2a6280',
      mountain: '#5b4c3c',
      desert: '#8a6a3a',
      island: '#4c5a44',
      halo: 'rgba(255, 255, 255, 0.92)',
      haloPx: 2.2,
      mix: 0.4,
    },
  };

  /* ------------------------------------------------------------------ *
   * 小工具
   * ------------------------------------------------------------------ */

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  function parseHex(h) {
    if (typeof h !== 'string' || h.length < 7 || h.charAt(0) !== '#') return null;
    const n = parseInt(h.slice(1, 7), 16);
    if (!Number.isFinite(n)) return null;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbCss(rgb) {
    return 'rgb(' + rgb[0] + ', ' + rgb[1] + ', ' + rgb[2] + ')';
  }

  /** 把 a 往 b 混 t(0..1),两边都是 [r,g,b] */
  function mixRgb(a, b, t) {
    return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
  }

  /**
   * 字号→文字宽度缓存(模块级,跨帧复用)。chrome 第一次设置某个 font 串 ~1ms
   * (要解析整条字体栈),之后同一个串近乎免费,所以只要文字/字号不换就不用再量。
   */
  const WIDTH_CACHE = new Map();
  function measureWidth(g, text, font) {
    const key = font + '\u0000' + text;
    let w = WIDTH_CACHE.get(key);
    if (w === undefined) {
      g.font = font;
      w = g.measureText(text).width;
      if (WIDTH_CACHE.size > 20000) WIDTH_CACHE.clear();
      WIDTH_CACHE.set(key, w);
    }
    return w;
  }

  /* ------------------------------------------------------------------ *
   * 绘制
   * ------------------------------------------------------------------ */

  /**
   * 把一批标签画进 g(ctx)。返回画出的文字条数(调试用)。
   * g 可以是主 canvas 的 2d context,也可以是离屏 canvas 的(不依赖 app.js 状态)。
   */
  function draw(g, opts) {
    if (!g || !opts || typeof g.save !== 'function') return 0;
    const rawStyle = opts.style || 'fantasy';
    if (rawStyle === 'classic') return 0; // 经典底图不叠标签
    const pal = PALETTES[rawStyle] || PALETTES.fantasy;

    const src = opts.items;
    const items = Array.isArray(src) ? src : src && Array.isArray(src.items) ? src.items : null;
    if (!items || !items.length) return 0;

    const rects = Array.isArray(opts.rects) && opts.rects.length ? opts.rects : [{ x: 0, yTop: 0, odd: false }];
    const mapW = +opts.mapW || 2048;
    const mapH = +opts.mapH || 1024;
    const P = +opts.P || 0;
    const H = +opts.H || 0;
    if (!(P > 0) || !(H > 0) || !(mapW > 0) || !(mapH > 0)) return 0;

    const sx = P / mapW;
    const sy = H / mapH;
    const relK = Math.max(0, +opts.relK || 1);
    const relGrow = Math.max(1, relK); // 字号只长大不缩小
    const cw = +opts.cw || (g.canvas ? g.canvas.width : 0) || 1e9;
    const ch = +opts.ch || (g.canvas ? g.canvas.height : 0) || 1e9;
    const ink = parseHex(pal.name) || [30, 30, 30];

    // 一帧内的量字宽缓存(模块级 WIDTH_CACHE 跨帧复用,这里是快路径)
    const widthCache = new Map();
    function textWidth(text, font) {
      const key = font + '\u0000' + text;
      let w = widthCache.get(key);
      if (w === undefined) {
        w = measureWidth(g, text, font);
        widthCache.set(key, w);
      }
      return w;
    }

    /* ---- 1. 生成候选(每个可见 rect 一份) ---- */
    const dots = [];
    const cand = [];
    // 先按锚点粗筛(不用量字宽),屏幕外的绝大多数直接扔掉,再量字宽。
    // rough 是"文字可能伸到锚点外多远"的上界:半宽 + 旋转多出来的高度 + 描边余量。
    const CULL = 24;
    const visible = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || !it.t) continue;
      const kd = KIND[it.k] || KIND_DEFAULT;
      const minZoom = it.d !== undefined ? +it.d : kd.d;
      if (relK + 1e-6 < minZoom) continue;
      const grow = it.g !== undefined ? +it.g : kd.g;
      let px = (+it.s || 10) * sx * Math.pow(relGrow, grow - 1);
      if (!(px > 0) || !Number.isFinite(px)) continue;
      px = Math.round(clamp(px, MIN_PX, MAX_PX) * 2) / 2;
      const rough = it.t.length * px * 1.05 + px * 1.5 + CULL;
      let seen = false;
      for (let ri = 0; ri < rects.length; ri++) {
        const r = rects[ri];
        if (!r) continue;
        const fx = r.x + it.x * sx;
        const anchorY = r.odd ? r.yTop + H - it.y * sy : r.yTop + it.y * sy;
        if (!Number.isFinite(fx) || !Number.isFinite(anchorY)) continue;
        if (fx < -rough || fx > cw + rough || anchorY < -rough || anchorY > ch + rough) continue;
        visible.push({ it, kd, px, fx, anchorY, ri });
        seen = true;
      }
      if (!seen) continue;
      // 至少有一份 rect 可见,才去量字宽
      const weight = it.w || kd.w || 500;
      it.__f = weight + ' ' + px.toFixed(2) + 'px ' + pal.font;
      it.__w = textWidth(it.t, it.__f);
    }
    for (let vi = 0; vi < visible.length; vi++) {
      const v = visible[vi];
      const it = v.it;
      const kd = v.kd;
      const px = v.px;
      const font = it.__f;
      const text = it.t;
      const kt = TRACKING[it.k] || 0;
      const trackPx = kt * px;
      const tw = it.__w + (kt && text.length > 1 ? text.length * trackPx : 0);
      const a = +it.a || 0;
      const ca = Math.abs(Math.cos(a));
      const sa = Math.abs(Math.sin(a));
      const th = px * 1.02;
      const bw = tw * ca + th * sa;
      const bh = tw * sa + th * ca;
      const isTown = kd.group === 'town';
      const level = TOWN_LEVEL[it.k];
      // 城名抬到锚点上方,给城点符号留位置
      const lift = isTown ? px * 0.62 + 2.2 : 0;
      // 颜色:国名用国色混墨;城镇按等级;其他按组
      let color;
      if (it.k === 'polity') {
        const rgb = parseHex(it.c);
        color = rgb ? rgbCss(mixRgb(rgb, ink, pal.mix)) : pal.name;
      } else if (isTown) {
        color = pal.town[level === undefined ? 1 : level];
      } else if (kd.group === 'water') {
        color = pal.water;
      } else if (kd.group === 'mountains') {
        color = pal.mountain;
      } else if (kd.group === 'desert') {
        color = pal.desert;
      } else if (kd.group === 'island') {
        color = pal.island;
      } else {
        color = pal.name;
      }
      const pad = Math.max(1.4, px * (it.k === 'polity' ? 0.1 : 0.14));
      const ri = v.ri;
      const cy = v.anchorY - lift;
      const r = rects[ri];
      cand.push({
        idx: vi,
        ri,
        it,
        px,
        font,
        text,
        tw,
        a,
        odd: !!(r && r.odd),
        bw,
        bh,
        fx: v.fx,
        cy,
        anchorY: v.anchorY,
        isTown,
        level,
        color,
        pad,
        trackPx,
      });
      if (isTown) {
        const dotR = clamp(px * 0.13, 1.1, 3.4);
        dots.push({ x: v.fx, y: v.anchorY, r: dotR, level });
      }
    }
    if (!cand.length) return 0;

    /* ---- 2. 按优先级排队,贪心避让 ---- */
    cand.sort(function (a, b) {
      return (b.it.p || 0) - (a.it.p || 0) || a.idx - b.idx || a.ri - b.ri;
    });

    const GRID = 64;
    const grid = new Map();
    function boxHits(l, t, r, b) {
      const x0 = Math.floor(l / GRID);
      const x1 = Math.floor(r / GRID);
      const y0 = Math.floor(t / GRID);
      const y1 = Math.floor(b / GRID);
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const arr = grid.get(gx + ',' + gy);
          if (!arr) continue;
          for (let i = 0; i < arr.length; i++) {
            const o = arr[i];
            if (r > o[0] && l < o[2] && b > o[1] && t < o[3]) return true;
          }
        }
      }
      return false;
    }
    function boxAdd(l, t, r, b) {
      const box = [l, t, r, b];
      const x0 = Math.floor(l / GRID);
      const x1 = Math.floor(r / GRID);
      const y0 = Math.floor(t / GRID);
      const y1 = Math.floor(b / GRID);
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          const key = gx + ',' + gy;
          let arr = grid.get(key);
          if (!arr) {
            arr = [];
            grid.set(key, arr);
          }
          arr.push(box);
        }
      }
    }

    // 避让失败时挪一挪再试:城名上下挪,国名小幅度上下挪(国名位置是领土重心,别挪太远)
    const TOWN_TRIES = [0, -1.15, 1.15];
    const NAME_TRIES = [0, -1.5, 1.5];
    let drawn = 0;
    g.save();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.miterLimit = 2;
    for (let ci = 0; ci < cand.length; ci++) {
      const c = cand[ci];
      const tries = c.isTown && !c.a ? TOWN_TRIES : c.it.k === 'polity' ? NAME_TRIES : null;
      let ok = false;
      let cx = c.fx;
      let cy = c.cy;
      if (!tries) {
        const l = cx - c.bw / 2 - c.pad;
        const t = cy - c.bh / 2 - c.pad;
        if (!boxHits(l, t, cx + c.bw / 2 + c.pad, cy + c.bh / 2 + c.pad)) {
          boxAdd(l, t, cx + c.bw / 2 + c.pad, cy + c.bh / 2 + c.pad);
          ok = true;
        }
      } else {
        for (let ti = 0; ti < tries.length; ti++) {
          const ty = c.cy + tries[ti] * c.px;
          const l = cx - c.bw / 2 - c.pad;
          const t = ty - c.bh / 2 - c.pad;
          const r = cx + c.bw / 2 + c.pad;
          const b = ty + c.bh / 2 + c.pad;
          if (!boxHits(l, t, r, b)) {
            boxAdd(l, t, r, b);
            cy = ty;
            ok = true;
            break;
          }
        }
      }
      if (!ok) continue;

      g.save();
      // letterSpacing 会在最后一个字后面也加一份,居中会偏左,向右补 half
      g.translate(cx + (c.trackPx || 0) / 2, cy);
      if (c.a) g.rotate(c.odd ? -c.a : c.a);
      g.font = c.font;
      if (c.trackPx && 'letterSpacing' in g) g.letterSpacing = c.trackPx.toFixed(2) + 'px';
      g.lineWidth = pal.haloPx;
      g.strokeStyle = pal.halo;
      g.strokeText(c.text, 0, 0);
      g.fillStyle = c.color;
      g.fillText(c.text, 0, 0);
      g.restore();
      drawn++;
    }
    g.restore();

    /* ---- 3. 城点(即使城名被挤掉也留个点,看得出聚落位置) ---- */
    if (dots.length) {
      g.save();
      g.lineJoin = 'round';
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        const townIdx = d.level === undefined ? 1 : d.level;
        g.beginPath();
        g.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        g.fillStyle = pal.town[townIdx];
        g.fill();
        g.lineWidth = Math.max(1, d.r * 0.55);
        g.strokeStyle = pal.halo;
        g.stroke();
      }
      g.restore();
    }

    return drawn;
  }

  globalThis.CivLabels = {
    draw: draw,
    MIN_PX: MIN_PX,
    MAX_PX: MAX_PX,
    /** 标签类型 → 默认分级/字重表,接线/调试时可直接查 */
    KINDS: KIND,
    PALETTES: PALETTES,
  };
})();
