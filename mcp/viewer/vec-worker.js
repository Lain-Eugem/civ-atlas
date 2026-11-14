/* 矢量层重烘 worker:OffscreenCanvas 上画,算完把 ImageBitmap transfer 回主线程。
 * 主线程只负责贴图,缩放超过 20% 触发重烘时不再阻塞拖动 / 缩放。
 */
/* global CivVecDraw */
importScripts('./vec-draw.js');

let vec = null;            // 当前世界已经解包好的矢量数据
let vecWorldId = null;

self.onmessage = (event) => {
  const msg = event.data || {};
  const seq = msg.seq;
  try {
    if (msg.vec) {
      vec = msg.vec;
      vecWorldId = msg.worldId;
    }
    if (!vec || vecWorldId !== msg.worldId) throw new Error('没有这个世界的矢量数据');
    const w = Math.max(1, Math.round(msg.w));
    const h = Math.max(1, Math.round(msg.h));
    const rdpr = Math.max(0.5, msg.rdpr || 1);
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(w * rdpr)), Math.max(1, Math.round(h * rdpr)));
    const g = canvas.getContext('2d', { alpha: true });
    if (!g) throw new Error('OffscreenCanvas 2D 不可用');
    g.setTransform(rdpr, 0, 0, rdpr, 0, 0);
    const rects = CivVecDraw.visibleRectsFor(msg.k, msg.P, msg.H, msg.oxAbs - msg.x0, msg.oyAbs - msg.y0, w, h);
    CivVecDraw.drawVectorsInto(g, {
      vec,
      rects,
      k: msg.k,
      P: msg.P,
      H: msg.H,
      mapW: msg.mapW,
      mapH: msg.mapH,
      cw: w,
      ch: h,
      style: msg.style,
      relK: msg.relK,
      tileFull: msg.tileFull,
      tileCover: msg.tileCover || []
    });
    const bitmap = canvas.transferToImageBitmap();
    self.postMessage({
      seq, ok: true, bitmap,
      x0: msg.x0, y0: msg.y0, w, h,
      pad: msg.pad, k: msg.k,
      ox: msg.oxAbs, oy: msg.oyAbs,
      cw: msg.cw, ch: msg.ch, rdpr,
      style: msg.style, tileFull: msg.tileFull,
      vecWorldId: msg.worldId
    }, [bitmap]);
  } catch (err) {
    self.postMessage({ seq, ok: false, error: String((err && err.message) || err) });
  }
};
