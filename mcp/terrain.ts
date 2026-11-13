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
import { riverGeometry } from '../src/gen/riverGeometry';
import { traceMaskValue } from './coast-trace';
import {
  fantasyCoastLines,
  fantasyFullPixels,
  glyphScale,
  iceLines,
  inkRuns,
  planGlyphs,
  seaRippleLines,
  simplifyLine,
  type Glyph,
} from '../src/render/fantasy';
import { Biome } from '../src/gen/biomes';
import { subSeed } from '../src/gen/util';
import { macroGrids, realisticPixels, realisticWindowPixels, type MacroGrids } from '../src/render/realistic';
import type { SurfaceLook } from '../src/render/surface';

/** 沙盒里可选的地形画法。classic = 改造前的三角栅格底图,由 viewer.ts 自己画,这里不处理。 */
export const TERRAIN_STYLES = ['fantasy', 'satellite', 'geo', 'white', 'classic'] as const;
export type TerrainStyle = (typeof TERRAIN_STYLES)[number];

export function isTerrainStyle(x: unknown): x is TerrainStyle {
  return TERRAIN_STYLES.includes(x as TerrainStyle);
}

const LOOK: Record<'satellite' | 'geo', SurfaceLook> = { satellite: 'detail', geo: 'geo' };

/**
 * 河网几何的固定线宽档:只用来算 DenseRiver.w(真正下发的是 f / m,前端按当前画风和缩放现算宽度)。
 * 走向、f、m 都与画风无关,所以这一份几何所有画风共用。
 */
const RIVER_GEOM_WIDTH = { minW: 0.55, maxW: 2.45, fluxRef: 1400 } as const;
/** 河口喇叭口倍率,和主站 realisticRiverStyle 的 mouthFlare 一致 */
const RIVER_MOUTH_FLARE = 1.5;
/** 河宽曲线的次方,和主站 realisticRiverStyle 的 widthPower 一致 */
const RIVER_WIDTH_POWER = 0.65;
/** 折线抽稀容差(世界单位):1200% 时约 0.2 屏幕像素,肉眼看不出来 */
const RIVER_NET_TOL = 0.02;

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
  /** 河网几何缓存(与画风无关,只算一次) */
  riverNet: RiverNetLine[] | null;
}

/**
 * 一条河网折线:x/y = 折线坐标(1 倍整图像素,可能跨 180° 展开成连续坐标),
 * f = 每点流量,m = 每点线宽系数(含源头收细与河口喇叭口)。客户端现算宽度:
 * 宽 = 河宽(f, 画风) × (m[i] + m[i+1]) / 2。
 */
export interface RiverNetLine {
  x: number[];
  y: number[];
  f: number[];
  m: number[];
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
  /** 冰缘墨线(低倍率用的抽稀版),每条 [x0,y0,x1,y1,…] */
  ice: number[][];
  /** 冰缘墨线(放大后的精细版) */
  iceFine: number[][];
  /** 河流分级阈值:flux 低于它的河段不画,和主站 world.riverThreshold 同义 */
  riverThreshold: number;
  /**
   * 河网:主站地理图那套 riverGeometry(并干流 + 统一平滑 + Catmull-Rom 加密 + 河口喇叭口)的几何,
   * 已按水陆图裁掉水面、RDP 抽稀到 0.02 世界单位。所有画风与缩放共用这一份,只按 f/m 重算线宽。
   */
  riverNet?: RiverNetLine[];
  /**
   * 林块:扁平存 [x, y, kind, flags, i, …] 每个有林的地块一项。
   * kind: 1 阔叶 / 2 针叶 / 3 雨林(和主站 fantasy.ts 的 F_BROAD / F_PINE / F_JUNGLE 同值);
   * flags: 1 = 林块边界(有邻格不是同种林,画成扇贝边的小圆)、2 = 临水(圆会缩小);
   * i = 地块序号,树冠的随机数按它现算(主站 forestTiles 的 hash2(i, …))。
   * 树冠不烘进底图:前端照主站 render/fantasy.ts 的 forestTiles 现画,放大多少倍都保持矢量。
   */
  forest: number[];
  /** 地块间距(世界单位)= world.mesh.spacing,林块几何按它铺 */
  forestSpacing: number;
  /** 树冠随机种子 = subSeed(seed, 'glyphs'),和主站 forestTiles 的 seed 同一个 */
  forestSeed: number;
}

/** 每个世界只准备一次;WeakMap 保证世界被丢掉时这些大数组也能回收 */
const contexts = new WeakMap<World, TerrainCtx>();

function ctxOf(world: World): TerrainCtx {
  const hit = contexts.get(world);
  if (hit) return hit;
  // gully = false:沟壑只影响写实风的明暗,手绘风用不到;省掉一整张图的逐像素噪声
  const whole = rasterize(world, 1, false);
  const ctx: TerrainCtx = {
    whole,
    src: zoomSource(world, whole),
    grids: macroGrids(whole),
    px: new Map(),
    fantasy: null,
    vectors: null,
    riverNet: null,
  };
  contexts.set(world, ctx);
  return ctx;
}

/**
 * 整图 1 倍的栅格(海岸线、疆域归属、国界端点共用这一份:rasterize 一次要 852ms,别重复算)。
 */
export function worldRaster(world: World): Raster {
  return ctxOf(world).whole;
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

/**
 * 白模画法:灰白、无生物群系颜色,只留海拔晕渲 + 海陆/湖泊/海冰,方便和叠在上面的
 * 「自定义场 / 魔力」颜色区分开 —— 看到的彩色就是图层本身的颜色。
 * 输出与 rasterize 同尺寸的 RGBA,后续整图/瓦片共用同一份逻辑。
 */
function whitePixels(r: Raster): Uint8ClampedArray {
  const { w, h, elev, water, ice } = r;
  const out = new Uint8ClampedArray(w * h * 4);
  const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
  const mix = (a: readonly number[], b: readonly number[], t: number): [number, number, number] => {
    const k = t < 0 ? 0 : t > 1 ? 1 : t;
    return [a[0]! + (b[0]! - a[0]!) * k, a[1]! + (b[1]! - a[1]!) * k, a[2]! + (b[2]! - a[2]!) * k];
  };
  const LAND = [233, 231, 226] as const;
  const PEAK = [250, 249, 246] as const;
  const SEA = [196, 206, 212] as const;
  const DEEP = [170, 184, 191] as const;
  const LAKE = [214, 223, 227] as const;
  const ICE = [244, 247, 248] as const;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      const o = p * 4;
      const sea = water[p]!;
      let c: readonly [number, number, number] = LAND;
      if (sea !== 0) {
        c = sea === 2 ? LAKE : mix(SEA, DEEP, Math.min(1, Math.max(0, -elev[p]!) / 4200));
        const ic = ice[p]!;
        if (ic >= 0.5) c = mix(c, ICE, Math.min(1, (ic - 0.5) * 2));
      } else {
        // 越高越接近白,再叠西北向山体晕渲;海冰/湖泊不参与晕渲
        c = mix(LAND, PEAK, Math.min(1, Math.max(0, (elev[p]! - 1200) / 2600)));
        const xl = x > 0 ? elev[p - 1]! : elev[p]!;
        const xr = x < w - 1 ? elev[p + 1]! : elev[p]!;
        const yu = y > 0 ? elev[p - w]! : elev[p]!;
        const yd = y < h - 1 ? elev[p + w]! : elev[p]!;
        const shade = Math.min(1.16, Math.max(0.74, 1 + ((xr - xl) * 0.55 + (yd - yu) * 0.85) / 1400));
        c = [c[0]! * shade, c[1]! * shade, c[2]! * shade];
      }
      out[o] = clamp255(c[0]!);
      out[o + 1] = clamp255(c[1]!);
      out[o + 2] = clamp255(c[2]!);
      out[o + 3] = 255;
    }
  }
  return out;
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
    } else if (style === 'white') {
      px = whitePixels(ctx.whole);
    } else {
      px = realisticPixels(ctx.whole, LOOK[style as 'satellite' | 'geo'] ?? 'detail').px;
    }
    ctx.px.set(style, px);
  }
  return px;
}

/**
 * 冰缘墨线:上游 fantasyFullPixels 在冰 / 海交界没有描边,只有一条硬色带。
 * 取"群落 = 海冰"的像素(和 seaIceField 的 mask 同一判据),交给 iceLines 追线,
 * 再用 inkRuns 拆成"只描冰 / 开阔海交界"的那几段。
 */
function iceInkRuns(r: Raster): Float32Array[] {
  const mask = new Uint8Array(r.w * r.h);
  for (let k = 0; k < mask.length; k++) if (r.biome[k] === Biome.SeaIce) mask[k] = 1;
  const out: Float32Array[] = [];
  for (const line of iceLines(r, mask)) for (const p of inkRuns(line, r.w)) out.push(p);
  return out;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * RDP 折线抽稀:返回保留下来的点索引(首尾一定保留)。用下标而不是坐标,是为了 f / m 能按同一套
 * 下标取出来,和抽稀后的折线点一一对应(宽度不能插值错位)。
 */
function rdpKeep(x: number[], y: number[], tol: number): number[] {
  const n = x.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = tol * tol;
  const stack: number[] = [0, n - 1]; // 成对压栈:[起点, 终点]
  while (stack.length > 0) {
    const i1 = stack.pop()!;
    const i0 = stack.pop()!;
    if (i1 - i0 < 2) continue;
    const dx = x[i1]! - x[i0]!;
    const dy = y[i1]! - y[i0]!;
    const len2 = dx * dx + dy * dy;
    let best = -1;
    let far = tol2;
    for (let i = i0 + 1; i < i1; i++) {
      const px = x[i]! - x[i0]!;
      const py = y[i]! - y[i0]!;
      // 到首尾连线的垂距平方;首尾重合时退化成到点的距离
      const d2 = len2 > 0 ? ((px * dy - py * dx) * (px * dy - py * dx)) / len2 : px * px + py * py;
      if (d2 > far) {
        far = d2;
        best = i;
      }
    }
    if (best < 0) continue;
    keep[best] = 1;
    stack.push(i0, best, best, i1);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

/**
 * 河网几何:每世界只算一次(所有画风、所有缩放共用)。主站的河网最后用画布 destination-in
 * 按水陆蒙版裁掉水面(河口伸进海里的那一小截),这里没有画布蒙版,就逐点判水;在水陆交界处
 * 二分插一个点,让河端正好落在岸上。裁完再 RDP 抽稀:2.8 万个加密点直接下发要 2.4MB JSON。
 */
function riverNetOf(world: World, ctx: TerrainCtx): RiverNetLine[] {
  const hit = ctx.riverNet;
  if (hit) return hit;
  const raster = ctx.whole;
  const W = world.width; // 世界坐标 = 1 倍整图像素坐标(scale = 1),wrap 也用同一个宽度
  const dense = riverGeometry(
    world.rivers,
    world.riverThreshold,
    RIVER_GEOM_WIDTH,
    RIVER_MOUTH_FLARE,
    RIVER_WIDTH_POWER,
    world.width,
  );
  const isLand = (x: number, y: number): boolean => {
    let xx = Math.round(((x % W) + W) % W);
    if (xx >= raster.w) xx -= raster.w;
    let yy = Math.round(y);
    yy = yy < 0 ? 0 : yy >= raster.h ? raster.h - 1 : yy;
    return raster.water[yy * raster.w + xx] === 0;
  };
  const out: RiverNetLine[] = [];
  for (const d of dense) {
    const n = d.x.length;
    if (n < 2) continue;
    let cur: RiverNetLine | null = null;
    let wasLand = isLand(d.x[0]!, d.y[0]!);
    let lx = d.x[0]!;
    let ly = d.y[0]!;
    let lf = d.f[0]!;
    let lm = d.m[0]!;
    if (wasLand) cur = { x: [lx], y: [ly], f: [lf], m: [lm] };
    for (let i = 1; i < n; i++) {
      const qx = d.x[i]!;
      const qy = d.y[i]!;
      const qf = d.f[i]!;
      const qm = d.m[i]!;
      const land = isLand(qx, qy);
      if (land === wasLand) {
        if (cur) {
          cur.x.push(qx);
          cur.y.push(qy);
          cur.f.push(qf);
          cur.m.push(qm);
        }
      } else if (wasLand) {
        // 陆地 → 水:这一段到岸边为止;二分找水陆分界,插一个点让河口贴岸
        let ax = lx;
        let ay = ly;
        let af = lf;
        let am = lm;
        let bx = qx;
        let by = qy;
        let bf = qf;
        let bm = qm;
        for (let it = 0; it < 8; it++) {
          const mx = (ax + bx) / 2;
          const my = (ay + by) / 2;
          const mf = (af + bf) / 2;
          const mm = (am + bm) / 2;
          if (isLand(mx, my)) {
            ax = mx;
            ay = my;
            af = mf;
            am = mm;
          } else {
            bx = mx;
            by = my;
            bf = mf;
            bm = mm;
          }
        }
        if (cur) {
          cur.x.push(ax);
          cur.y.push(ay);
          cur.f.push(af);
          cur.m.push(am);
          pushRiverNet(out, cur);
        }
        cur = null;
      } else {
        // 水 → 陆地:从岸边重新起一段(河穿过湖泊时会被切成几段)
        cur = { x: [qx], y: [qy], f: [qf], m: [qm] };
      }
      lx = qx;
      ly = qy;
      lf = qf;
      lm = qm;
      wasLand = land;
    }
    if (cur) pushRiverNet(out, cur);
  }
  ctx.riverNet = out;
  return out;
}

/** 抽稀并压成下发格式(坐标 / 流量 / 宽度系数都取到 0.01) */
function pushRiverNet(out: RiverNetLine[], run: RiverNetLine): void {
  if (run.x.length < 2) return;
  const keep = rdpKeep(run.x, run.y, RIVER_NET_TOL);
  if (keep.length < 2) return;
  const x: number[] = [];
  const y: number[] = [];
  const f: number[] = [];
  const m: number[] = [];
  for (const i of keep) {
    x.push(round2(run.x[i]!));
    y.push(round2(run.y[i]!));
    f.push(round2(run.f[i]!));
    m.push(round2(run.m[i]!));
  }
  out.push({ x, y, f, m });
}

/** 生成矢量层:海岸线、近岸波纹、地形符号、冰缘墨线、河流、河网、林块。墨线类都抽稀过,总量约 2 MB 级。 */
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
  // planGlyphs 一次算出两样:地形符号和林块(主站 render/fantasy.ts 的 Plan),这里都复用
  const plan = planGlyphs(world);
  const glyphs: Glyph[] = plan.glyphs;
  // 林块:每格是什么林(0 = 无 / 1 阔叶 / 2 针叶 / 3 雨林)主站已经按生物群系 + 低频噪声算好了,
  // 这里只补两个标记 —— 林块边界(有邻格不是同种林 → 画成扇贝边)和临水(圆更小)。
  // 前端只有一张扁平表,没有邻接关系,所以这两样必须在这算;树冠的随机数仍按地块序号 i 现算。
  const mesh = world.mesh;
  const forestKind = plan.forest;
  const forest: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    const kind = forestKind[i];
    if (!kind) continue;
    let flags = 0;
    for (let e = mesh.adjStart[i], e1 = mesh.adjStart[i + 1]; e < e1; e++) {
      const j = mesh.adj[e];
      if (forestKind[j] !== kind) flags |= 1;
      if (world.water[j] !== 0) flags |= 2;
      if (flags === 3) break;
    }
    // 坐标取到 0.01 世界单位:659% 时这不到 0.06 屏幕像素,肉眼无差;JSON 却能省一截
    forest.push(Math.round(mesh.x[i] * 100) / 100, Math.round(mesh.y[i] * 100) / 100, kind, flags, i);
  }
  // 冰缘墨线:只追一次线,再抽稀成粗 / 细两份给不同倍率用
  const iceRuns = iceInkRuns(ctx.whole);
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
    ice: flat(iceRuns, 0.9),
    iceFine: flat(iceRuns, 0.12),
    riverThreshold: world.riverThreshold,
    // 河网几何:所有画风共用这一份,前端按 f/m 现算线宽(裁陆 + RDP 抽稀在这一步做)
    riverNet: riverNetOf(world, ctx),
    forest,
    forestSpacing: mesh.spacing,
    forestSeed: subSeed(world.params.seed, 'glyphs'),
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
): { width: number; height: number; rgba: Uint8Array; sea: number[][]; lake: number[][] } {
  const ctx = ctxOf(world);
  const { src, grids } = ctx;
  const W = src.width * S;
  const H = src.height * S;
  const out = new Uint8ClampedArray(size * size * 4);
  // 和这块瓦片同分辨率的水陆图,最后用来追本块的海岸 / 湖岸线(见文件末尾)
  const mN = size + 2 * WINDOW_PAD;
  const mask = new Uint8Array(mN * mN);
  let maskOk = true;

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
    } else if (style === 'white') {
      px = whitePixels(r);
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
    // 整块的窗口(含 pad)一次铺满时,这份水陆图就是瓦片坐标系下的完整水陆图,直接拿来用;
    // 跨极点的块是翻转 + 挪半圈的,对不上,放弃追线(前端会退回全局那份)
    if (!odd && py === 0 && segH === size) mask.set(r.water);
    else maskOk = false;
    py = end;
  }
  // 手绘风的窗口像素层会重算全局场,低频颜色和整图不一样,拉回底图才不出现方块色差。
  // 写实风的 realisticWindowPixels 本来就是按整图粗网格取的,不需要这一步。
  if (style === 'fantasy') alignColors(out, wholePixels(world, ctx, style), src.width, src.height, S, x, y, size);
  // 本块的海岸 / 湖岸线:在这块自己的水陆图上追,所以和这块的地形严丝合缝。
  // 坐标是瓦片内的像素坐标(0..size),前端按贴图尺寸放大即可,不用再管世界坐标和跨极。
  let sea: number[][] = [];
  let lake: number[][] = [];
  if (maskOk) {
    const ox = WINDOW_PAD - 0.5;
    sea = traceMaskValue(mask, mN, 1, ox, ox);
    lake = traceMaskValue(mask, mN, 2, ox, ox);
  }
  return { width: size, height: size, rgba: asBytes(out), sea, lake };
}
