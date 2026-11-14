/* 矢量细节层的共用绘制代码:主线程(回退)和 vec-worker.js 共用同一份。
 * 不依赖 app.js 里的状态:所有参数都从 opts 传进来,worker 里也能跑。
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

  /**
   * 服务端下发的写实系岸线字段(coastReal / lakeReal)是原始折线;手绘那份在 app.js 里已经
   * 包成 { p, x0, x1 }。两种都接受:整组第一次用到时现包(结果按数组缓存,worker 里各自缓存)。
   */
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

  /**
   * 一个地形符号的几何,塞进两条 Path2D:fill(山的实心三角)和 stroke(其余线条)。
   * 整帧只调两次 fill / stroke,避免三千多个符号时上万次 canvas 调用。
   */
  function glyphInto(g, x, y, unit, fillPath, linePath) {
    const kind = g[2];
    const tier = 1 / (1 + Math.log2(Math.max(1, g[7])) * 0.55);
    const s = clamp(g[3] * unit * tier, 2.5, 24);
    const w = s * (0.75 + g[6] * 0.12);
    if (kind === 0 || kind === 7) {          // 山 / 火山
      fillPath.moveTo(x - w, y);
      fillPath.lineTo(x - w * 0.12, y - s * 0.9);
      fillPath.lineTo(x + w, y);
      fillPath.closePath();
      linePath.moveTo(x - w * 0.12, y - s * 0.9);
      linePath.lineTo(x + w * 0.16, y - s * 0.45);
      linePath.lineTo(x + w * 0.38, y);
      if (kind === 7) {
        linePath.moveTo(x - w * 0.12, y - s * 0.9);
        linePath.quadraticCurveTo(x + w * 0.1, y - s * 1.3, x, y - s * 1.55);
      }
    } else if (kind === 1) {                 // 丘陵
      linePath.moveTo(x - s * 0.7, y);
      linePath.quadraticCurveTo(x, y - s * 0.85, x + s * 0.7, y);
    } else if (kind === 5) {                 // 沙丘
      linePath.moveTo(x - s * 0.6, y);
      linePath.quadraticCurveTo(x - s * 0.1, y - s * 0.45, x + s * 0.6, y);
    } else if (kind === 6) {                 // 草丛
      for (let i = -1; i <= 1; i++) {
        linePath.moveTo(x + i * s * 0.18, y);
        linePath.lineTo(x + i * s * 0.18 + s * 0.12, y - s * 0.5);
      }
    } else {                                 // 沼泽
      linePath.moveTo(x - s * 0.5, y);
      linePath.lineTo(x + s * 0.5, y);
      linePath.moveTo(x - s * 0.35, y - s * 0.22);
      linePath.lineTo(x + s * 0.2, y - s * 0.22);
    }
  }

  /* ---------- 林块矢量层 ----------
   * 照搬主站 src/render/fantasy.ts 的 forestTiles(非投影、平面那条路径):
   * 每个有林的地块画一个圆 —— 林块边界上的圆小、中心随机(拼成扇贝边),内部的圆大(连成一片);
   * 团块里再画树冠(阔叶 / 雨林是圆 + 顶上一道墨弧,针叶是小尖角),外加东南侧树影和斜排线。
   * 墨线、排线、阴影都是屏幕尺度,树冠数量随放大逐级增加(和主站 GLYPH_TIERS 同一套门槛),
   * 所以必须浏览器端现画;服务端只给扁平数组 [x,y,kind,flags,i,…] + 间距 + 随机种子。
   * 这里所有几何都按"世界单位"建进 Path2D,再由每个副本的 ctx 变换缩放到屏幕(和主站逐像素等价)。
   */
  const FOREST_TIERS = [1, 2, 3.5, 6];   // 主站 GLYPH_TIERS
  const FOREST_CANOPY = { 1: 'rgb(150,165,108)', 2: 'rgb(118,140,104)', 3: 'rgb(118,145,90)' };
  const FOREST_INK = 'rgba(58,45,34,';

  /** 主站 src/gen/noise.ts 的 hash2(树冠随机数,必须逐位一致) */
  function hash2(x, y, s) {
    let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function addCirclePath(p, cx, cy, R) {
    p.moveTo(cx + R, cy);
    p.arc(cx, cy, R, 0, Math.PI * 2);
  }

  /** 针叶林的扇贝边:上尖下圆的小树顶(主站 addPineTop) */
  function addPineTopPath(p, cx, cy, R) {
    p.moveTo(cx, cy - R * 1.55);
    p.quadraticCurveTo(cx + R * 0.35, cy - R * 0.45, cx + R, cy + R * 0.3);
    p.quadraticCurveTo(cx, cy + R * 1.15, cx - R, cy + R * 0.3);
    p.quadraticCurveTo(cx - R * 0.35, cy - R * 0.45, cx, cy - R * 1.55);
    p.closePath();
  }

  /** 针叶树冠的小尖角(closed = 封闭三角形,否则只画 ∧ 两笔;主站 addChevron) */
  function addChevronPath(p, cx, cy, r, closed) {
    p.moveTo(cx - r * 0.75, cy + r * 0.35);
    p.lineTo(cx, cy - r * 0.95);
    p.lineTo(cx + r * 0.75, cy + r * 0.35);
    if (closed) p.closePath();
  }

  /**
   * 把范围内(或整张图)的林块几何拼成每种林一组 4 条路径:
   * shape = 圆 / 尖顶, crowns = 树冠墨弧, crownShade / crownFill = 树冠的阴影与填色。
   * bounds = {x0,y0,x1,y1} 时只拼这些地块(已经加过林块半径余量),null = 整张图。
   */
  function buildForestPaths(vec, spacing, seed, gs, crownsPer, bounds) {
    const data = vec.forest || [];
    const out = { 1: null, 2: null, 3: null };
    for (let n = 0; n + 4 < data.length; n += 5) {
      const x = data[n], y = data[n + 1], kind = data[n + 2], flags = data[n + 3], i = data[n + 4];
      if (bounds && (x < bounds.x0 || x > bounds.x1 || y < bounds.y0 || y > bounds.y1)) continue;
      let g = out[kind];
      if (!g) {
        out[kind] = g = { shape: new Path2D(), crowns: new Path2D(), crownShade: new Path2D(), crownFill: new Path2D() };
      }
      const pointy = kind === 2;
      const h1 = hash2(i, 1, seed);
      if (flags & 1) {
        // 林块边界:小圆 + 随机中心,扇贝边;临水的再缩一圈,海岸看着更瘦
        let R = spacing * (0.62 + 0.32 * h1);
        if (flags & 2) R *= 0.62;
        const cx = x + (hash2(i, 2, seed) - 0.5) * spacing * 0.6;
        const cy = y + (hash2(i, 3, seed) - 0.5) * spacing * 0.6;
        if (pointy) addPineTopPath(g.shape, cx, cy, R);
        else addCirclePath(g.shape, cx, cy, R);
        continue;
      }
      // 内部地块:一个大圆保证连成一片,再往上叠树冠
      addCirclePath(g.shape, x, y, spacing * 1.35);
      for (let c = 0; c < crownsPer; c++) {
        if (c === 0 && hash2(i, 4, seed) >= (kind === 3 ? 0.72 : 0.6)) continue;
        const jx = c === 0 ? hash2(i, 2, seed) : hash2(i, 10 + c * 2, seed);
        const jy = c === 0 ? hash2(i, 3, seed) : hash2(i, 11 + c * 2, seed);
        const spread = c === 0 ? 0.6 : 1.05;
        const tx = x + (jx - 0.5) * spacing * spread;
        const ty = y + (jy - 0.5) * spacing * spread;
        const rr = spacing * (0.3 + 0.14 * (c === 0 ? h1 : hash2(i, 20 + c, seed))) * gs;
        const off = rr * 0.32;
        if (pointy) {
          addChevronPath(g.crownShade, tx + off, ty + off, rr, true);
          addChevronPath(g.crownFill, tx, ty, rr, true);
          addChevronPath(g.crowns, tx, ty, rr, false);
        } else {
          addCirclePath(g.crownShade, tx + off, ty + off, rr);
          addCirclePath(g.crownFill, tx, ty, rr);
          g.crowns.moveTo(tx - rr, ty);
          g.crowns.arc(tx, ty, rr, Math.PI, Math.PI * 2);
        }
      }
    }
    return out;
  }

  /** 默认视图(relK ≤ 1.35)整张图的林块几何不变:缓存一份,平移 / 缩放时不再重拼 */
  let forestFitCache = null;
  function forestFitPaths(vec, spacing, seed) {
    if (forestFitCache && forestFitCache.vec === vec) return forestFitCache.paths;
    const paths = buildForestPaths(vec, spacing, seed, 1, 1, null);
    forestFitCache = { vec: vec, paths: paths };
    return paths;
  }

  /**
   * 画一个副本里的林块(在湖 / 海岸墨线之后、河流之前 —— 和主站 detail.ts 的层级顺序一致)。
   * 主站 forestTiles 的坐标是屏幕像素;这里几何按世界单位建好,靠 ctx 变换缩放,数值完全对应。
   */
  function drawForestInRect(g, vec, r, sx, sy, H, relK, cw, ch, W) {
    const data = vec.forest;
    const spacing = vec.forestSpacing || 0;
    if (!data || !data.length || !spacing || !W) return;
    const seed = vec.forestSeed || 0;
    const gs = relK <= 1.35 ? 1 : Math.pow(relK / 1.35, -0.22);
    let crownsPer = 1;
    for (let t = 1; t < FOREST_TIERS.length; t++) if (relK >= FOREST_TIERS[t] * 0.95) crownsPer++;
    const lw = 0.55 * gs;                              // 墨线 / 排线宽(世界单位)
    const shadeD = spacing * 0.42 * gs;                // 东南侧树影的偏移
    const reach = spacing * 1.8 + shadeD + lw + 2 / sx; // 一个林块最远画到中心外多远
    // 本副本可见的世界范围(加余量):只跳过确实画不到的,不裁 —— 跨接缝 / 跨极的另一半由相邻副本补上
    const wx0 = (0 - r.x) / sx;
    const wx1 = (cw - r.x) / sx;
    const wyA = r.odd ? (r.yTop + H - ch) / sy : (0 - r.yTop) / sy;
    const wyB = r.odd ? (r.yTop + H) / sy : (ch - r.yTop) / sy;
    const wy0 = Math.min(wyA, wyB);
    const wy1 = Math.max(wyA, wyB);
    const paths = relK <= 1.35
      ? forestFitPaths(vec, spacing, seed)
      : buildForestPaths(vec, spacing, seed, gs, crownsPer, { x0: wx0 - reach, y0: wy0 - reach, x1: wx1 + reach, y1: wy1 + reach });
    if (!paths[1] && !paths[2] && !paths[3]) return;
    // 排线间距微调到"一整圈正好整数条",左右接缝处排线对得上(和主站同一算法)
    const hatchGap = W / Math.max(1, Math.round(W / (1.7 * gs)));
    g.save();
    g.translate(r.x, r.odd ? r.yTop + H : r.yTop);
    g.scale(sx, r.odd ? -sy : sy);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const kind of [1, 3, 2]) {
      const p = paths[kind];
      if (!p) continue;
      const canopy = FOREST_CANOPY[kind];
      // 1. 轮廓:先描一道粗墨线,再用树冠色填满 → 只剩外圈扇贝边
      g.strokeStyle = FOREST_INK + '0.85)';
      g.lineWidth = lw * 2;
      g.stroke(p.shape);
      g.fillStyle = canopy;
      g.fill(p.shape);
      // 2. 东南侧阴影 + 斜排线:只在林块内部(裁剪到 shape)
      g.save();
      g.clip(p.shape);
      g.fillStyle = FOREST_INK + '0.10)';
      g.fillRect(wx0 - 2, wy0 - 2, wx1 - wx0 + 4, wy1 - wy0 + 4);
      g.beginPath();
      const qStart = Math.ceil((wx0 + wy0) / hatchGap);
      const qEnd = (wx1 + wy1) / hatchGap;
      for (let q = qStart; q < qEnd; q++) {
        const c = q * hatchGap;
        const ax = Math.max(wx0 - 2, c - wy1 - 2);
        const bx = Math.min(wx1 + 2, c - wy0 + 2);
        if (ax >= bx) continue;
        g.moveTo(ax, c - ax);
        g.lineTo(bx, c - bx);
      }
      g.strokeStyle = FOREST_INK + '0.42)';
      g.lineWidth = 0.55 * gs;
      g.stroke();
      // 往西北平移后再填一遍树冠色 → 只有东南边那一圈还是暗的
      g.translate(-shadeD, -shadeD);
      g.fillStyle = canopy;
      g.fill(p.shape);
      g.restore();
      // 3. 树冠:阴影 → 填色 → 墨弧
      g.fillStyle = FOREST_INK + '0.22)';
      g.fill(p.crownShade);
      g.fillStyle = canopy;
      g.fill(p.crownFill);
      g.strokeStyle = FOREST_INK + '0.6)';
      g.lineWidth = 0.55 * gs;
      g.stroke(p.crowns);
    }
    g.restore();
  }

  /* ---------- 河网矢量层 ----------
   * 几何来自服务端 mcp/terrain.ts 的 riverNet:主站 gen/riverGeometry.ts 那一套
   * (并干流 → 统一平滑 → Catmull-Rom 加密 → 河口喇叭口),已按水陆图裁掉水面并 RDP 抽稀到
   * 0.02 世界单位。走向 / f / m 与画风无关,所以每个世界只算一次、所有画风与所有缩放共用;
   * 客户端只按画风与当前缩放重算线宽(和主站 render/common.ts strokeRivers 同一个公式):
   *   w = (widthOf(f) * 0.5 * (m[i]+m[i+1]) * lodTaper(style,f) + extra) * s
   */

  /** 各画风的河网外观:照主站 render/realistic.ts 的 MATERIALS.river / riverFlux */
  const RIVER_LOOKS = {
    // 地理图
    geo: { color: 'rgb(48,118,190)', minW: 0.55, growW: 1.9, bank: null, fluxRef: 1400, riverFlux: [0.7, 0.9] },
    // 卫星(细节)
    satellite: {
      color: 'rgb(28,64,92)',
      minW: 0.45,
      growW: 1.6,
      bank: { color: 'rgba(22,40,30,0.2)', thinW: 0.45 },
      fluxRef: 1400,
      riverFlux: [2.4, 1.4],
    },
    // 经典卫星(写实系默认画法):主站 MATERIALS.classic.river / riverFlux
    classic: {
      color: 'rgb(58,124,180)',
      minW: 0.55,
      growW: 1.9,
      bank: { color: 'rgba(22,40,30,0.34)', thinW: 0.45 },
      fluxRef: 1400,
      riverFlux: [1, 1],
    },
    // 白模
    white: { color: 'rgb(150,186,214)', minW: 0.55, growW: 1.9, bank: null, fluxRef: 1400, riverFlux: [2.5, 1.5] },
    // 手绘羊皮纸:和主站 fantasyRiverStyle 同一套颜色 / 宽度,保留手绘的细线感
    fantasy: { color: 'rgba(48,82,110,0.9)', minW: 0.5, growW: 1.5, bank: null, fluxRef: 900, riverFlux: [1, 1] },
  };

  /** 把 x 折回离 ref 最近的一圈(主站 gen/util.ts 的 nearX) */
  function nearX(x, ref, W) { return W ? x - W * Math.round((x - ref) / W) : x; }

  /** 河流分级:缩放越大画出来的河越多(主站 common.ts riverLod) */
  function riverLod(k) { return Math.max(1, 4.5 * Math.pow(Math.max(1, k), -1.3)); }

  /**
   * 当前画风 + 缩放下的河宽参数,两套公式都照主站:
   * - 手绘(fantasy):fantasyRiverStyle(kk, threshold) —— maxW = 0.5 + 1.5×kk^-0.2、minFlux = threshold×riverLod(kk)、
   *   宽度指数 0.5、无河岸;
   * - 写实系(geo / satellite / white):realisticRiverStyle —— maxW = minW + growW×kk^-0.12、thin = kk^-0.6、
   *   minFlux = threshold×(kk>1 ? max(0.2, 4.5×kk^-2.2) : riverLod(kk))×riverFlux[kk>1 ? 1 : 0]、宽度指数 0.65。
   * 四画风共用的是河网几何;线宽公式各按主站那一套来(主站本来就不一样)。
   */
  function riverStyleOf(style, k, threshold) {
    const look = RIVER_LOOKS[style] || RIVER_LOOKS.fantasy;
    const kk = Math.max(1, k);
    const thin = Math.pow(kk, -0.6);
    if (style === 'fantasy') {
      return {
        color: look.color,
        minW: look.minW,
        maxW: 0.5 + 1.5 * Math.pow(kk, -0.2),
        fluxRef: look.fluxRef,
        thin: thin,
        minFlux: threshold * riverLod(kk),
        power: 0.5,
        bank: null,
      };
    }
    return {
      color: look.color,
      minW: look.minW,
      maxW: look.minW + look.growW * Math.pow(kk, -0.12),
      fluxRef: look.fluxRef,
      thin: thin,
      minFlux:
        threshold *
        (kk > 1 ? Math.max(0.2, 4.5 * Math.pow(kk, -2.2)) : riverLod(kk)) *
        look.riverFlux[kk > 1 ? 1 : 0],
      power: 0.65,
      bank: look.bank ? { color: look.bank.color, width: look.bank.thinW * thin } : null,
    };
  }

  /** 线宽(世界单位):flux 只在一段范围内起作用(主站 common.ts riverWidth;手绘 power 0.5、写实系 0.65) */
  function riverWidthOf(style, threshold) {
    const base = style.minW * (style.thin || 1);
    const span = style.maxW - style.minW;
    const power = style.power || 0.65;
    return function (f) {
      return base + span * Math.min(1, Math.pow(Math.max(0, f - threshold) / style.fluxRef, power));
    };
  }

  /** 刚过阈值的河段再细一点(主站 common.ts lodTaper) */
  function riverTaper(style, f) {
    const m = style.minFlux;
    if (!m) return 1;
    const t = Math.min(1, Math.max(0, (f - m) / (0.8 * m)));
    return 0.35 + 0.65 * t * t * (3 - 2 * t);
  }

  /**
   * 河网几何:把每条河的 x 展开(跨 180° 处接着上一点延出去,折线才不会横穿整张图),顺便算 bbox,
   * 跨 180° 时在另一边再画一份平移副本用。每份矢量数据(vec)只算一次,各视口 / 各画风复用。
   */
  const riverNetCache = new WeakMap();
  function riverNetGeometry(net, W) {
    const out = [];
    for (const line of net || []) {
      const xs = line.x;
      const ys = line.y;
      const fs = line.f;
      const ms = line.m;
      const n = xs ? xs.length : 0;
      if (n < 2) continue;
      const x = new Float64Array(n);
      const y = new Float64Array(n);
      const f = new Float64Array(n);
      const m = new Float64Array(n);
      let x0 = Infinity;
      let x1 = -Infinity;
      for (let i = 0; i < n; i++) {
        x[i] = i ? nearX(xs[i], x[i - 1], W) : xs[i];
        y[i] = ys[i];
        f[i] = fs[i];
        m[i] = ms[i];
        if (x[i] < x0) x0 = x[i];
        if (x[i] > x1) x1 = x[i];
      }
      out.push({ x: x, y: y, f: f, m: m, x0: x0, x1: x1 });
    }
    return out;
  }

  /**
   * 河网几何只算一次:几何与画风 / 缩放无关。
   * which = 'base' 只有河道(手绘 / 低倍);'creek' = 河道 + 小溪(主站 realistic 在 k>1 时用 riversOf 并进小溪)。
   */
  function riverNetGeoOf(v, W, which) {
    let hit = riverNetCache.get(v);
    if (hit && hit[which] !== undefined) return hit[which];
    const net = which === 'creek' ? v.riverNetCreek : v.riverNet;
    let geo = null;
    if (net && net.length) geo = riverNetGeometry(net, W);
    if (!hit) riverNetCache.set(v, (hit = {}));
    hit[which] = geo;
    return geo;
  }

  const RIVER_W_STEP = 0.25;

  /**
   * 画一层河网(河岸层 / 河层):分段画法同主站 drawRivers 的普通路径 —— 从上一段中点起笔、
   * 以当前顶点为控制点 quadraticCurveTo 到本段中点(最后一段直接到顶点),round cap / join,
   * 跨 180° 在另一边画平移副本,画布外按"线宽 + 两轴跨度"放宽后裁掉。
   * 线宽逐段不同,按 0.25 屏幕像素分桶后用 Path2D 一次描一桶(主站 strokeRivers 同一手:
   * 否则上万段每段一次 stroke 太慢;线宽误差 < 0.125px,看不出来)。
   */
  function drawRiverNetPass(g, net, threshold, style, color, extra, sx, fx, fy, cw, ch, W) {
    const widthOf = riverWidthOf(style, threshold);
    const minFlux = style.minFlux;
    const buckets = new Map();
    for (const river of net) {
      const x = river.x;
      const y = river.y;
      const f = river.f;
      const m = river.m;
      const n = x.length;
      const shifts = river.x1 > W ? [0, -W] : river.x0 < 0 ? [0, W] : [0];
      for (const sh of shifts) {
        let prevDrawn = false;
        let prevKey = -1;
        for (let i = 0; i < n - 1; i++) {
          // 一段河画不画 / 多宽,按两端平均流量算(和主站 strokeRivers 一样)
          const ff = 0.5 * (f[i] + f[i + 1]);
          if (ff < minFlux) { prevDrawn = false; continue; }
          const x0 = fx(x[i] + sh);
          const y0 = fy(y[i]);
          const x1 = fx(x[i + 1] + sh);
          const y1 = fy(y[i + 1]);
          if (!Number.isFinite(x0 + y0 + x1 + y1)) { prevDrawn = false; continue; }
          const wv = (widthOf(ff) * 0.5 * (m[i] + m[i + 1]) * riverTaper(style, ff) + extra) * sx;
          const lw = wv > 0.05 ? wv : 0.05;
          // pad 和主站一样按"线宽 + 两轴跨度"放宽,斜穿画布外的段不会被误裁
          const pad = lw + Math.abs(x1 - x0) + Math.abs(y1 - y0);
          if (x0 < -pad || y0 < -pad || x0 > cw + pad || y0 > ch + pad) { prevDrawn = false; continue; }
          const key = Math.max(1, Math.round(lw / RIVER_W_STEP));
          let path = buckets.get(key);
          if (!path) buckets.set(key, (path = new Path2D()));
          const endX = i === n - 2 ? x1 : (x0 + x1) / 2;
          const endY = i === n - 2 ? y1 : (y0 + y1) / 2;
          if (prevDrawn && prevKey === key) {
            path.quadraticCurveTo(x0, y0, endX, endY);
          } else {
            // 段被滤掉 / 换了桶:从上一段中点(或本段起点)重新起笔
            const startX = i === 0 || !prevDrawn ? x0 : (fx(x[i - 1] + sh) + x0) / 2;
            const startY = i === 0 || !prevDrawn ? y0 : (fy(y[i - 1]) + y0) / 2;
            path.moveTo(startX, startY);
            path.quadraticCurveTo(x0, y0, endX, endY);
          }
          prevDrawn = true;
          prevKey = key;
        }
      }
    }
    if (!buckets.size) return;
    g.strokeStyle = color;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const [key, path] of buckets) {
      g.lineWidth = key * RIVER_W_STEP;
      g.stroke(path);
    }
  }

  /** 画河网:主站顺序是河岸层在前、河层在后(netLayers);四套画法里只有卫星(细节)有可见河岸 */
  function drawRiverNetInRect(g, net, threshold, style, sx, fx, fy, cw, ch, W) {
    if (style.bank && style.bank.width > 0) {
      drawRiverNetPass(g, net, threshold, style, style.bank.color, style.bank.width * 2, sx, fx, fy, cw, ch, W);
    }
    drawRiverNetPass(g, net, threshold, style, style.color, 0, sx, fx, fy, cw, ch, W);
  }

  /**
   * 把一个"虚拟视口"里的矢量层画进 g。
   * opts: { vec, rects, k, P, H, mapW, mapH, cw, ch, style, relK, tileFull, tileCover }
   * rects 相对 cw×ch 的左上角;cross-pole 的 odd 与 draw() 同一套公式。
   */
  function drawVectorsInto(g, opts) {
    const v = opts.vec;
    const style = opts.style;
    const fantasy = style === 'fantasy';
    // 河网是所有画法共用的;写实系(geo / satellite / classic)在底色之上再补一层岸线墨线,
    // 纸感墨线 / 波纹 / 冰缘 / 林块 / 山符号只有手绘风有
    const realistic = style === 'geo' || style === 'satellite' || style === 'classic';
    const onlyRivers = realistic || style === 'white';
    if (!v || (!fantasy && !onlyRivers) || !opts.rects.length) return;
    const ink = 'rgba(58,45,34,0.86)';
    const inkSoft = 'rgba(58,45,34,0.17)';
    // 写实系岸线墨线:照主站 MATERIALS.geo.coast = rgb(63,111,152) α0.7。主站 COAST_PX=3、
    // 朝陆那半边被陆地盖住,看上去约 1.5px;这里按居中 1.5px 画。
    const realInk = 'rgba(63,111,152,0.7)';
    const realInkLW = 1.5;
    const W = opts.mapW, H = opts.H;
    const sx = opts.P / opts.mapW;              // 屏幕像素 / 整图像素
    const sy = opts.H / opts.mapH;
    const relK = opts.relK;                     // 1 = 默认视图;符号分级 / 收缩按相对倍数算
    const gs = relK <= 1.35 ? 1 : Math.pow(relK / 1.35, -0.22);
    const unit = gs * sx;                       // 符号大小:比地图放大得慢,不会撑满屏幕
    const fine = relK >= 2.5;
    // 写实系岸线用哪一档:低倍用服务端新下发的单档(tol 0.9)那份;高倍(fine,和手绘风同一个
    // 分级点)换成手绘的 fine 档 —— 同一份几何、只是抽稀更细,放大后不发毛。旧缓存缺新字段时退回手绘那份。
    const realCoast = fine ? boxLines(v.coastFine || v.coastReal || v.coast) : boxLines(v.coastReal || v.coast);
    const realLake = fine ? boxLines(v.lakeFine || v.lakeReal || v.lake) : boxLines(v.lakeReal || v.lake);
    const coast = fine ? v.coastFine : v.coast;
    const lake = fine ? v.lakeFine : v.lake;
    const ice = fine ? v.iceFine : v.ice;
    const ripples = fine ? v.rippleFine : v.ripple.slice(0, 2);
    const cw = opts.cw, ch = opts.ch;
    const tileFull = opts.tileFull;
    const tileCover = opts.tileCover || [];
    // 河网:几何每世界只算一次(服务端缓存的 riverNet),所有画法 / 所有视口复用。
    // 风格 k 用 relK(= S.view.k 缩放倍数,和主站 v.k 同一个量,不是 P/mapW):
    // 放大 → 分级放宽、世界线宽变细,屏幕线宽再按 sx 放大。
    const riverThreshold = v.riverThreshold || 0;
    // 放大后(主站 DETAIL_K = 1.2)非手绘画风换成"河道 + 小溪"那份几何:主站 realistic 的
    // riversOf(world, k>1) 就是把这个世界的 creeks.ts 并进河网一起平滑;手绘风主站不画小溪,保持只有河道。
    const useCreek = !fantasy && relK > 1.2;
    const riverNet = riverNetGeoOf(v, W, useCreek ? 'creek' : 'base') || riverNetGeoOf(v, W, 'base');
    const riverStyle = riverNet ? riverStyleOf(style, relK, riverThreshold) : null;

    for (const r of opts.rects) {
      const fx = (px) => r.x + px * sx;
      const fy = (py) => (r.odd ? r.yTop + H - py * sy : r.yTop + py * sy);
      const strokeLines = (lists, color, lw) => {
        g.strokeStyle = color;
        g.lineWidth = lw;
        g.beginPath();
        let seg = 0;
        for (const list of lists) {
          for (const b of list) {
            const p = b.p;
            const shifts = b.x1 > W ? [0, -W] : b.x0 < 0 ? [0, W] : [0];
            for (const sh of shifts) {
              let pen = false;    // 上一段还连着,可以省掉 moveTo
              for (let i = 0; i + 3 < p.length; i += 2) {
                const x0 = fx(p[i] + sh), y0 = fy(p[i + 1]);
                const x1 = fx(p[i + 2] + sh), y1 = fy(p[i + 3]);
                if (!Number.isFinite(x0 + y0 + x1 + y1)) { pen = false; continue; }
                if (Math.max(x0, x1) < -6 || Math.min(x0, x1) > cw + 6
                  || Math.max(y0, y1) < -6 || Math.min(y0, y1) > ch + 6) { pen = false; continue; }
                if (!pen) { g.moveTo(x0, y0); pen = true; }
                g.lineTo(x1, y1);
                if (++seg >= 3000) { g.stroke(); g.beginPath(); pen = false; seg = 0; }
              }
            }
          }
        }
        g.stroke();
      };
      if (fantasy) {
        g.save();
        g.lineJoin = 'round';
        g.lineCap = 'butt';
        strokeLines(ripples, inkSoft, 1);
        // 冰缘:底图里的冰 / 海交界只有一条硬填色边,这里按主站 fantasyIceParts 的墨线补
        // (主站 ICE_LW=1.5 / ICE_INK_A=0.62,屏幕上统一 1.15px 线宽、0.62 透明度)
        if (ice && ice.length) strokeLines([ice], 'rgba(58,45,34,0.62)', 1.15);

        if (!tileFull) {
          if (tileCover.length) {
            const cover = new Path2D();
            cover.rect(-20, -20, cw + 40, ch + 40);
            for (const t of tileCover) cover.rect(t.x, t.y, t.w, t.h);
            g.clip(cover, 'evenodd');
          }
          strokeLines([lake, coast], ink, 1.15);
        }
        g.restore();
        // 林块:主站 detail.ts 的层级顺序是 海岸墨线 → 林块 → 河流 → 山符号,所以插在这里(河流之前)。
        // 主站的林块从来不烘进底图,所以高清块(tileFull)里也照画。
        drawForestInRect(g, v, r, sx, sy, H, relK, cw, ch, W);
      } else if (realistic) {
        // 写实系(geo / satellite / classic)的岸线墨线:底色之上、河网之前。颜色 / 线宽照主站
        // 地图册(MATERIALS.geo.coast)。铺满高清块时瓦片自带一份岸线(app.js 的 tileLines),
        // 这里裁掉 tileCover 盖住的区域免得两条线叠着;tileFull 时整份都不画,和手绘风同一套机制。
        if (!tileFull) {
          g.save();
          g.lineJoin = 'round';
          g.lineCap = 'butt';
          if (tileCover.length) {
            const cover = new Path2D();
            cover.rect(-20, -20, cw + 40, ch + 40);
            for (const t of tileCover) cover.rect(t.x, t.y, t.w, t.h);
            g.clip(cover, 'evenodd');
          }
          strokeLines([realLake, realCoast], realInk, realInkLW);
          g.restore();
        }
      }
      // 河网画在墨线 / 林块之后(与主站 detail.ts 的层级顺序一致:墨线 → 林块 → 河 → 山符号),
      // 这样河口压在岸线墨线上而不是被墨线切断;tileCover 的裁剪已经结束,高清块里没烘河所以照画。
      // 单独 save / restore:河用 round cap,不能污染后面符号的笔状态。
      if (riverNet && riverStyle) {
        g.save();
        drawRiverNetInRect(g, riverNet, riverThreshold, riverStyle, sx, fx, fy, cw, ch, W);
        g.restore();
      }
      if (onlyRivers) continue;
      const gFill = new Path2D();
      const gLine = new Path2D();
      for (const glyph of v.glyphs) {
        if (glyph[7] > relK + 0.01) continue;   // z:放大后逐级出现更多符号
        const gy = r.odd ? r.yTop + H - glyph[1] * sy : r.yTop + glyph[1] * sy;
        if (gy < -24 || gy > ch + 24) continue;
        const shifts = glyph[0] < 24 ? [0, W] : glyph[0] > W - 24 ? [0, -W] : [0];
        for (const sh of shifts) {
          const gx = r.x + (glyph[0] + sh) * sx;
          if (gx < -24 || gx > cw + 24) continue;
          glyphInto(glyph, gx, gy, unit, gFill, gLine);
        }
      }
      g.fillStyle = 'rgba(238,228,201,0.82)';
      g.fill(gFill);
      g.lineWidth = 0.85;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.strokeStyle = 'rgba(58,45,34,0.78)';
      g.stroke(gLine);
    }
  }

  /** 一个"虚拟视口"里可见的平铺 / 跨极副本,和 draw() 里的循环同一套公式 */
  function visibleRectsFor(k, P, H, oxAbs, oyAbs, vw, vh) {
    const ox = ((oxAbs % P) + P) % P - P;
    const n0 = Math.floor((0 - oyAbs) / H);
    const n1 = Math.floor((vh - oyAbs) / H);
    const mCount = Math.max(1, Math.ceil(vw / P) + 1);
    const rects = [];
    for (let n = n0; n <= n1; n++) {
      const yTop = oyAbs + n * H;
      if (yTop > vh || yTop + H < 0) continue;
      const odd = ((n % 2) + 2) % 2 === 1;
      for (let m = 0; m <= mCount; m++) {
        const x = ox + m * P - (odd ? P / 2 : 0);
        if (x > vw || x + P < 0) continue;
        rects.push({ x, yTop, odd });
      }
    }
    return rects;
  }

  /** 卫星画风底图里的细沟描线:数据来自 /api/map/veins,一条线 = [x,y,s, x,y,s, …] */
  const VEIN_MIN_RELK = 2.5;      // 和"精细档"同一个分级点:低倍底图上的沟本身也只有 1px 上下,不描
  const VEIN_RGB = '92,112,86';   // multiply 用的暗橄榄绿:只把底图压暗一档,不抢河的蓝
  function drawVeinLines(g, opts) {
    const veins = opts.veins;
    if (!veins || !veins.lines || !veins.lines.length) return;
    if (!(opts.relK >= VEIN_MIN_RELK)) return;
    const rects = opts.rects;
    if (!rects || !rects.length) return;
    const W = opts.mapW, Hm = opts.mapH, cw = opts.cw, ch = opts.ch;
    const sx = opts.P / W;
    const sy = opts.H / Hm;
    const lines = veins.lines;
    // bbox 每世界算一次:跨 180° 时按 bbox 决定要不要在另一侧再画一份
    let bb = veins._bb;
    if (!bb) {
      bb = veins._bb = new Array(lines.length);
      for (let li = 0; li < lines.length; li++) {
        const p = lines[li].p;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let i = 0; i + 2 < p.length; i += 3) {
          if (p[i] < x0) x0 = p[i];
          if (p[i] > x1) x1 = p[i];
          if (p[i + 1] < y0) y0 = p[i + 1];
          if (p[i + 1] > y1) y1 = p[i + 1];
        }
        bb[li] = [x0, y0, x1, y1];
      }
    }
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const r of rects) {
      // 这个 rect 覆盖的世界范围(odd 层 y 是上下镜像的,两端都算完再取 min/max)
      const wx0 = (0 - r.x) / sx;
      const wx1 = (cw - r.x) / sx;
      const ya = (0 - r.yTop) / sy;
      const yb = (ch - r.yTop) / sy;
      const wy0 = r.odd ? Hm - Math.max(ya, yb) : Math.min(ya, yb);
      const wy1 = r.odd ? Hm - Math.min(ya, yb) : Math.max(ya, yb);
      const fx = (px) => r.x + px * sx;
      const fy = (py) => (r.odd ? r.yTop + Hm - py * sy : r.yTop + py * sy);
      const halo = new Map();
      const core = new Map();
      const pathOf = (m, key) => { let p = m.get(key); if (!p) m.set(key, (p = new Path2D())); return p; };
      for (let li = 0; li < lines.length; li++) {
        const b = bb[li];
        if (b[2] < wx0 - 2 || b[0] > wx1 + 2 || b[3] < wy0 - 2 || b[1] > wy1 + 2) continue;
        const p = lines[li].p;
        const shifts = b[2] > W ? [0, -W] : b[0] < 0 ? [0, W] : [0];
        for (const sh of shifts) {
          let prevB = -1, prevX = 0, prevY = 0, hasPrev = false;
          for (let i = 0; i + 5 < p.length; i += 3) {
            const s = 0.5 * (p[i + 2] + p[i + 5]);
            if (s < 0.45) { hasPrev = false; continue; }
            const bucket = s < 0.6 ? 1 : s < 0.8 ? 2 : 3;
            const x0 = fx(p[i] + sh), y0 = fy(p[i + 1]);
            const x1 = fx(p[i + 3] + sh), y1 = fy(p[i + 4]);
            if (!Number.isFinite(x0 + y0 + x1 + y1)) { hasPrev = false; continue; }
            if (Math.max(x0, x1) < -8 || Math.min(x0, x1) > cw + 8
              || Math.max(y0, y1) < -8 || Math.min(y0, y1) > ch + 8) { hasPrev = false; continue; }
            const hp = pathOf(halo, bucket);
            const cp = pathOf(core, bucket);
            // 短段之间用直线接上(细沟点很密,折线看不出来)
            if (hasPrev && prevB === bucket) { hp.moveTo(prevX, prevY); cp.moveTo(prevX, prevY); }
            else { hp.moveTo(x0, y0); cp.moveTo(x0, y0); }
            hp.lineTo(x1, y1);
            cp.lineTo(x1, y1);
            prevB = bucket; prevX = x1; prevY = y1; hasPrev = true;
          }
        }
      }
      // 先淡谷影(宽、淡),再沟心(窄、深)。用 multiply 压暗底图,和主站底图上的沟影同一种"阴影"观感;
      // 线宽跟缩放走(按世界像素),不然底图上的沟越放大越宽、我们的线却永远是 1px,对不上。
      g.globalCompositeOperation = 'multiply';
      for (const [m, wPx, aBase, aSpan] of [[halo, 1.8, 0.028, 0.030], [core, 0.9, 0.060, 0.060]]) {
        for (const [bucket, path] of m) {
          const s = (bucket + 0.5) / 4;
          g.strokeStyle = `rgba(${VEIN_RGB},${(aBase + aSpan * s).toFixed(3)})`;
          g.lineWidth = wPx + 0.5 * s;
          g.stroke(path);
        }
      }
      g.globalCompositeOperation = 'source-over';
    }
    g.restore();
  }


  const API = { clamp, withBox, glyphInto, drawVectorsInto, visibleRectsFor, drawVeinLines };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else globalThis.CivVecDraw = API;
})();
