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

  /**
   * 把一个"虚拟视口"里的矢量层画进 g。
   * opts: { vec, rects, k, P, H, mapW, mapH, cw, ch, style, relK, tileFull, tileCover }
   * rects 相对 cw×ch 的左上角;cross-pole 的 odd 与 draw() 同一套公式。
   */
  function drawVectorsInto(g, opts) {
    const v = opts.vec;
    if (!v || (opts.style !== 'fantasy' && opts.style !== 'white') || !opts.rects.length) return;
    const white = opts.style === 'white';
    const ink = white ? 'rgba(70,72,76,0.82)' : 'rgba(58,45,34,0.86)';
    const inkSoft = white ? 'rgba(70,72,76,0.20)' : 'rgba(58,45,34,0.17)';
    const W = opts.mapW, H = opts.H;
    const sx = opts.P / opts.mapW;              // 屏幕像素 / 整图像素
    const sy = opts.H / opts.mapH;
    const relK = opts.relK;                     // 1 = 默认视图;符号分级 / 收缩按相对倍数算
    const gs = relK <= 1.35 ? 1 : Math.pow(relK / 1.35, -0.22);
    const unit = gs * sx;                       // 符号大小:比地图放大得慢,不会撑满屏幕
    const fine = relK >= 2.5;
    const coast = fine ? v.coastFine : v.coast;
    const lake = fine ? v.lakeFine : v.lake;
    const ripples = fine ? v.rippleFine : v.ripple.slice(0, 2);
    const cw = opts.cw, ch = opts.ch;
    const tileFull = opts.tileFull;
    const tileCover = opts.tileCover || [];

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
      g.save();
      g.lineJoin = 'round';
      g.lineCap = 'butt';
      if (!white) strokeLines(ripples, inkSoft, 1);
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
      if (white) continue;
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

  const API = { clamp, withBox, glyphInto, drawVectorsInto, visibleRectsFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else globalThis.CivVecDraw = API;
})();
