/**
 * 沙盒地形渲染:直接复用主站的渲染管线(gen/raster.ts、gen/rasterWindow.ts、render/realistic.ts、
 * render/fantasy.ts),在 Node 里跑纯计算的那几个入口,产出 RGBA 交给 png.ts 编码。
 *
 * 这一层解决的三个问题:
 *  1. 画风:底图不再是 mcp/viewer.ts 里自己写的三角形栅格,而是主站的手绘 / 写实风的像素层;
 *  2. 分辨率:整张主图只是"够用的底图",放大后按当前倍数现算屏幕上的那几块(同主站 tileWorker);
 *  3. 跨极:瓦片坐标是"球面展开坐标",可以超出南北极;按球面的真实接法(越过极点 = 余纬取负,
 *     等价于纬度镜像 + 经度挪半圈)把奇数层映射回 [0, H) 再栅格化,所以上下也能一直拖。
 *
 * 不新增任何依赖:上面那些模块本来就是"纯计算,worker / Node 都能跑";唯一碰到页面的是
 * render/labels/fonts.ts 里的 import.meta.env(Vite 专属),由构建产物的兼容补丁处理,见 mcp/build.ps1
 * 与 scripts/lib/sandboxViewer.ts。
 */
import type { World } from '../src/gen/world';
import { rasterize, type Raster } from '../src/gen/raster';
import { rasterizeWindow, zoomSource, WINDOW_PAD, type ZoomSource } from '../src/gen/rasterWindow';
import {
  fantasyCoastLines,
  fantasyFullPixels,
  glyphScale,
  planGlyphs,
  seaRippleLines,
  simplifyLine,
  type Glyph,
} from '../src/render/fantasy';
import { macroGrids, realisticPixels, realisticWindowPixels, type MacroGrids } from '../src/render/realistic';
import type { SurfaceLook } from '../src/render/surface';

/** 沙盒里可选的地形画法。classic = 改造前的三角栅格底图,由 viewer.ts 自己画,这里不处理。 */
export const TERRAIN_STYLES = ['fantasy', 'satellite', 'geo', 'classic'] as const;
export type TerrainStyle = (typeof TERRAIN_STYLES)[number];

export function isTerrainStyle(x: unknown): x is TerrainStyle {
  return TERRAIN_STYLES.includes(x as TerrainStyle);
}

const LOOK: Record<'satellite' | 'geo', SurfaceLook> = { satellite: 'detail', geo: 'geo' };

interface TerrainCtx {
  /** 1 倍整张主图:放大现算要用的海冰 / 细沟 / 大尺度晕渲都从它取 */
  whole: Raster;
  src: ZoomSource;
  grids: MacroGrids;
  /** 各画法的整张像素层(手绘风已去掉墨线/波纹,改由前端矢量画),给高清块做颜色对齐用 */
  px: Map<TerrainStyle, Uint8ClampedArray>;
  /** 手绘风的墨线补丁与海面场,生成矢量数据要用 */
  fantasy: ReturnType<typeof fantasyFullPixels> | null;
  /** 矢量层缓存(海岸线 / 波纹 / 符号),只算一次 */
  vectors: VectorData | null;
}

/** 送到浏览器用 Canvas 画的矢量层。坐标都是 1 倍整张主图的像素(0..2048, 0..1024)。 */
export interface VectorData {
  /** 海岸线,每条 [x0,y0,x1,y1,…] */
  coast: number[][];
  /** 湖岸线 */
  lake: number[][];
  /** 近岸波纹,按圈分组:[[线…],[线…],[线…]] */
  ripple: number[][][];
  /** 放大后用的精细版(抽稀更轻,曲线才不会放大成折线) */
  coastFine: number[][];
  lakeFine: number[][];
  rippleFine: number[][][];
  /** 山 / 丘陵 / 沙丘 / 草丛 / 沼泽符号:[x, y, kind, s, v, a, c, z] */
  glyphs: number[][];
}

/** 每个世界只准备一次;WeakMap 保证世界被丢掉时这些大数组也能回收 */
const contexts = new WeakMap<World, TerrainCtx>();

function ctxOf(world: World): TerrainCtx {
  const hit = contexts.get(world);
  if (hit) return hit;
  // gully = false:沟壑只影响写实风的明暗,手绘风用不到;省掉一整张图的逐像素噪声
  const whole = rasterize(world, 1, false);
  const ctx: TerrainCtx = { whole, src: zoomSource(world, whole), grids: macroGrids(whole), px: new Map(), fantasy: null, vectors: null };
  contexts.set(world, ctx);
  return ctx;
}

/**
 * 去掉像素层里的墨线 / 波纹,这几样改由浏览器按屏幕线宽画成矢量,放大多少倍都保持 1px。
 * 顺序照主站 fantasyBaseClean:湖岸 → 海岸 → 波纹/排线 → 冰缘墨线。
 */
function cleanInk(px: Uint8ClampedArray, patch: ReturnType<typeof fantasyFullPixels>['patch']): void {
  patch.lake.putInto(px);
  patch.coast.putInto(px);
  patch.sea.putInto(px);
  patch.iceW.putInto(px);
}

/** 整张像素层(每种画法算一次):既是底图,也是高清块的颜色基准 */
function wholePixels(world: World, ctx: TerrainCtx, style: TerrainStyle): Uint8ClampedArray {
  let px = ctx.px.get(style);
  if (!px) {
    if (style === 'fantasy') {
      const fp = fantasyFullPixels(world, ctx.whole);
      ctx.fantasy = fp;
      cleanInk(fp.px, fp.patch);
      px = fp.px;
    } else {
      px = realisticPixels(ctx.whole, LOOK[style as 'satellite' | 'geo'] ?? 'detail').px;
    }
    ctx.px.set(style, px);
  }
  return px;
}

/** 生成矢量层:海岸线、近岸波纹、地形符号。全部抽稀过,总量不到 1 MB。 */
export function renderVectors(world: World): VectorData {
  const ctx = ctxOf(world);
  if (ctx.vectors) return ctx.vectors;
  // 先确保手绘风的像素层算过(矢量数据要用它的海面场)
  if (!ctx.fantasy) wholePixels(world, ctx, 'fantasy');
  const fp = ctx.fantasy!;
  const lines = fantasyCoastLines(ctx.whole);
  const flat = (arr: Float32Array[], tol: number): number[][] =>
    arr.map((p) => Array.from(simplifyLine(p, tol)));
  const groups = seaRippleLines(ctx.whole, fp.sea.dist, fp.sea.fade);
  const glyphs: Glyph[] = planGlyphs(world).glyphs;
  // 低倍率用抽稀版(线少、画得快),放大后换精细版 —— 否则 1 整图像素 = 十几屏幕像素,
  // 抽稀留下的折角会变成明显的多边形,就不像矢量线了
  ctx.vectors = {
    coast: flat(lines.sea, 0.9),
    lake: flat(lines.lake, 0.9),
    ripple: groups.map((group) => flat(group, 1.4)),
    coastFine: flat(lines.sea, 0.12),
    lakeFine: flat(lines.lake, 0.12),
    rippleFine: groups.map((group) => flat(group, 0.25)),
    glyphs: glyphs.map((g) => [g.x, g.y, g.kind, g.s, g.v, g.a, g.c, g.z]),
  };
  return ctx.vectors;
}

/** 符号在屏幕上不该跟着地图等比放大:和主站同一条曲线 */
export const glyphScaleOf = glyphScale;

function asBytes(px: Uint8ClampedArray): Uint8Array {
  return new Uint8Array(px.buffer, px.byteOffset, px.byteLength);
}

/** 整张主图(固定 1 倍、2048 × 1024):拖动画面时的底图,也是缩小时的成品图 */
export function renderWhole(world: World, style: TerrainStyle): { width: number; height: number; rgba: Uint8Array } {
  const ctx = ctxOf(world);
  const px = wholePixels(world, ctx, style);
  return { width: ctx.whole.w, height: ctx.whole.h, rgba: asBytes(px.slice()) };
}

/**
 * 把一块高清像素的大尺度颜色对齐到整张底图。
 *
 * 手绘风的像素层里有几样"全局场"(纸纹、水彩斑驳、山符号羽化、离岸波纹),整图是按
 * 2048 × 1024 一次算出来的;按窗口现算时这些场只覆盖这一小块,基底颜色会偏(有的块偏纸黄、
 * 有的偏水绿),拼起来就是明显的方块。这里按 32 × 32 的小格统计"本块均值 − 整图同位置
 * 均值",把差值做成平滑的偏移场扣回去:高频细节(墨线、岸线、纹理)全部保留,低频颜色
 * 与底图一致,块与块、块与未加载的底图之间就接得上了。
 */
function alignColors(
  tile: Uint8ClampedArray,
  wholePx: Uint8ClampedArray,
  W: number,
  H: number,
  S: number,
  x: number,
  y: number,
  size: number,
): void {
  const G = 32;
  const gw = Math.ceil(size / G);
  const gh = Math.ceil(size / G);
  const sum = new Float64Array(gw * gh * 3);
  const cnt = new Uint32Array(gw * gh);
  const du = 1 / S;
  for (let py = 0; py < size; py++) {
    const v1 = (y + py) * du;
    const layer = Math.floor(v1 / H);
    const odd = ((layer % 2) + 2) % 2 === 1;
    const sy = Math.min(H - 1, Math.max(0, Math.floor(odd ? (layer + 1) * H - v1 : v1 - layer * H)));
    const row = sy * W;
    const g = Math.floor(py / G) * gw;
    // 整图的列下标按 1/S 累加,逐像素不做除法和取模
    let u = (x * du - (odd ? W / 2 : 0)) % W;
    if (u < 0) u += W;
    for (let px = 0; px < size; px++) {
      const k = (row + (u | 0)) * 4;
      const t = (py * size + px) * 4;
      const c = g + Math.floor(px / G);
      sum[c * 3] += tile[t] - wholePx[k];
      sum[c * 3 + 1] += tile[t + 1] - wholePx[k + 1];
      sum[c * 3 + 2] += tile[t + 2] - wholePx[k + 2];
      cnt[c]++;
      u += du;
      if (u >= W) u -= W;
    }
  }
  const off = new Float32Array(gw * gh * 3);
  for (let c = 0; c < gw * gh; c++) {
    const n = Math.max(1, cnt[c]);
    off[c * 3] = sum[c * 3] / n;
    off[c * 3 + 1] = sum[c * 3 + 1] / n;
    off[c * 3 + 2] = sum[c * 3 + 2] / n;
  }
  // 列的双线性权重先算好,逐像素只剩几次乘加
  const ci0 = new Int32Array(size);
  const ci1 = new Int32Array(size);
  const ctx0 = new Float32Array(size);
  for (let px = 0; px < size; px++) {
    const fx = (px + 0.5) / G - 0.5;
    const i0 = Math.min(gw - 1, Math.max(0, Math.floor(fx)));
    ci0[px] = i0;
    ci1[px] = Math.min(gw - 1, i0 + 1);
    ctx0[px] = Math.min(1, Math.max(0, fx - i0));
  }
  for (let py = 0; py < size; py++) {
    const fy = (py + 0.5) / G - 0.5;
    const j0 = Math.min(gh - 1, Math.max(0, Math.floor(fy)));
    const j1 = Math.min(gh - 1, j0 + 1);
    const ty = Math.min(1, Math.max(0, fy - j0));
    const a0 = j0 * gw;
    const b0 = j1 * gw;
    for (let px = 0; px < size; px++) {
      const i0 = ci0[px], i1 = ci1[px], tx = ctx0[px];
      const t = (py * size + px) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const a = off[(a0 + i0) * 3 + ch] * (1 - tx) + off[(a0 + i1) * 3 + ch] * tx;
        const b = off[(b0 + i0) * 3 + ch] * (1 - tx) + off[(b0 + i1) * 3 + ch] * tx;
        tile[t + ch] = tile[t + ch] - (a * (1 - ty) + b * ty);
      }
    }
  }
}

/**
 * 一块高清地形:S = 像素 / 世界单位(即"放大倍数"),(x, y) 是这块左上角在球面展开平面上的
 * 坐标(S 倍主图的像素;x 可出左右边 —— 东西相连,y 可出上下边 —— 越过极点接另一侧)。
 *
 * 越极点的接法:等距圆柱图里 v = 余纬 / π × H。余纬 θ < 0 或 > π 时球面上的点等于
 * (|θ| 或 2π−θ, λ + π),也就是 y 镜像、x 挪半圈。所以:
 *   n = floor(v / H),n 偶数 → 直接取 (x, v − nH);
 *                    n 奇数 → 取 (x − W/2, (n+1)H − v),并且把渲染结果上下翻回来。
 * 这样每一层都落在 [0, H) 里,rasterizeWindow 能正常铺像素;层与层之间地形、气候、疆域都是连续的。
 */
export function renderTile(
  world: World,
  style: TerrainStyle,
  S: number,
  x: number,
  y: number,
  size: number,
): { width: number; height: number; rgba: Uint8Array } {
  const ctx = ctxOf(world);
  const { src, grids } = ctx;
  const W = src.width * S;
  const H = src.height * S;
  const out = new Uint8ClampedArray(size * size * 4);

  // 逐行找出连续的同一层,每段一次 rasterizeWindow + 上色(通常一段,靠近极点时两段)
  let py = 0;
  while (py < size) {
    const layer = Math.floor((y + py) / H);
    let end = py + 1;
    while (end < size && Math.floor((y + end) / H) === layer) end++;
    const segH = end - py;
    const odd = ((layer % 2) + 2) % 2 === 1;

    // 这一段在源主图里的窗口。偶数层 ys 随 py 递增,奇数层递减(下面按行倒着贴回去)
    const ysFirst = odd ? (layer + 1) * H - (y + py) : (y + py) - layer * H;
    const ysLast = odd ? (layer + 1) * H - (y + end - 1) : (y + end - 1) - layer * H;
    const y0 = Math.min(ysFirst, ysLast);
    const xs = odd ? x - W / 2 : x;

    // 四周多铺 WINDOW_PAD 像素(晕渲 / 岸线抗锯齿要邻居),上色后裁掉
    const P = WINDOW_PAD;
    const xr = (((xs - P) % W) + W) % W;
    const n = size + 2 * P;
    const r = rasterizeWindow(src, S, xr, y0 - P, n, segH + 2 * P);
    let px: Uint8ClampedArray;
    if (style === 'fantasy') {
      const fp = fantasyFullPixels(world, r);
      cleanInk(fp.px, fp.patch);   // 墨线 / 波纹交给前端矢量层,位图只留地形
      px = fp.px;
    } else {
      px = realisticWindowPixels(r, grids, LOOK[style as 'satellite' | 'geo'] ?? 'detail');
    }

    for (let t = 0; t < segH; t++) {
      // 奇数层:目标第 t 行对应源里倒过来的那一行
      const srcRow = odd ? segH - 1 - t : t;
      const from = ((srcRow + P) * n + P) * 4;
      const to = ((py + t) * size) * 4;
      out.set(px.subarray(from, from + size * 4), to);
    }
    py = end;
  }
  // 手绘风的窗口像素层会重算全局场,低频颜色和整图不一样,拉回底图才不出现方块色差。
  // 写实风的 realisticWindowPixels 本来就是按整图粗网格取的,不需要这一步。
  if (style === 'fantasy') alignColors(out, wholePixels(world, ctx, style), src.width, src.height, S, x, y, size);
  return { width: size, height: size, rgba: asBytes(out) };
}
