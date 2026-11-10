/**
 * 地块级「场」的渲染层(原型)。
 *
 * 上层约定(见 src/gen/field.ts 文件头):
 * - 计算层给 FieldFrame(每格一个精确数),本层只读,绝不改 values、绝不重新算场;
 * - 改色带/拉伸/等高线/辉光/透明度只重画 PNG,不触发推演或计算层;
 * - 灰阶/等值线对数值的映射是「显示」,原始值通过 data 接口/hover 单独给出;
 * - 同 world+frame+style 逐字节一致(便于 compare/缓存),所以不放时间、随机数。
 *
 * 像素来源:src/gen/raster.ts 的 rasterize(world, 0.5, false)。
 * Raster.cell 是「最近的地块编号」,正好把每格的值铺到 1024×512 的图上,
 * 不用再手写三角形栅格化;水/湖像素也照常取值(魔脉可以在海里)。
 */
import type { World } from '../src/gen/world';
import { rasterize, type Raster } from '../src/gen/raster';
import type { FieldFrame } from '../src/gen/field';
import { FIELD_LABEL } from '../src/gen/field';
import { encodePng } from './png';

export type FieldRamp = 'ember' | 'viridis' | 'magma' | 'ice';

export const FIELD_RAMPS: readonly FieldRamp[] = ['ember', 'viridis', 'magma', 'ice'];

export const FIELD_RAMP_LABEL: Record<FieldRamp, string> = {
  ember: '余烬(紫→橙→金)',
  viridis: '青绿(蓝→绿→黄)',
  magma: '岩浆(黑→紫→橙→白)',
  ice: '寒冰(深蓝→青→白)',
};

export interface FieldStyle {
  ramp: FieldRamp;
  /** 色带拉伸:p1p99 = 按 1%–99% 分位拉伸(默认);minmax = 按真实最小/最大 */
  stretch: 'p1p99' | 'minmax';
  /** 叠加透明度 0–1 */
  opacity: number;
  /** 等高线:false=不画,true=默认 6 条,或直接给条数 2–16 */
  contour: boolean | number;
  /** 数值高处的辉光(只影响显示) */
  glow: boolean;
  /** 叠一点地形浮雕,热力图不至于浮在空白上 */
  hillshade: boolean;
  /** 显示级平滑(只影响图;hover/导出仍是原始值) */
  smooth: boolean;
}

export const DEFAULT_FIELD_STYLE: FieldStyle = {
  ramp: 'ember',
  stretch: 'p1p99',
  opacity: 0.85,
  contour: true,
  glow: true,
  hillshade: true,
  smooth: true,
};

export interface FieldLegendTick {
  /** 归一化位置 0–1 */
  t: number;
  /** 真实数值 */
  value: number;
}

export interface FieldLegend {
  kind: string;
  label: string;
  ramp: FieldRamp;
  rampLabel: string;
  min: number;
  max: number;
  p50: number;
  /** 色带 9 个采样点的 CSS 颜色,前端直接画渐变条 */
  stops: { t: number; hex: string }[];
  /** 色带下方 5 个刻度(位置 + 真实值) */
  ticks: FieldLegendTick[];
  unit: string;
}

export interface FieldRender {
  width: number;
  height: number;
  png: Buffer;
  legend: FieldLegend;
}

export interface FieldDataJson {
  kind: string;
  label: string;
  unit: 'cell';
  version: number;
  cells: number;
  hash: string;
  stats: FieldFrame['stats'];
  /** Float32 小端原始字节的 base64,长度 = cells*4 */
  values: string;
  /** 用于 hover 的索引网格,base64 Int32(每像素最近地块 -1) */
  grid: string;
  gridW: number;
  gridH: number;
  width: number;
  height: number;
  frameId: string;
}

/* ------------------------------------------------------------------ *
 * 色带
 * ------------------------------------------------------------------ */

interface Stop {
  t: number;
  r: number;
  g: number;
  b: number;
}

const RAMPS: Record<FieldRamp, Stop[]> = {
  ember: [
    { t: 0, r: 24, g: 8, b: 48 },
    { t: 0.22, r: 66, g: 18, b: 108 },
    { t: 0.42, r: 132, g: 32, b: 132 },
    { t: 0.6, r: 196, g: 60, b: 96 },
    { t: 0.76, r: 236, g: 112, b: 60 },
    { t: 0.9, r: 250, g: 178, b: 76 },
    { t: 1, r: 255, g: 240, b: 184 },
  ],
  viridis: [
    { t: 0, r: 22, g: 20, b: 68 },
    { t: 0.22, r: 40, g: 60, b: 110 },
    { t: 0.42, r: 34, g: 102, b: 116 },
    { t: 0.6, r: 46, g: 142, b: 92 },
    { t: 0.76, r: 122, g: 172, b: 60 },
    { t: 0.9, r: 198, g: 196, b: 56 },
    { t: 1, r: 252, g: 244, b: 140 },
  ],
  magma: [
    { t: 0, r: 6, g: 4, b: 10 },
    { t: 0.2, r: 44, g: 12, b: 66 },
    { t: 0.4, r: 104, g: 24, b: 106 },
    { t: 0.58, r: 166, g: 44, b: 96 },
    { t: 0.74, r: 222, g: 92, b: 70 },
    { t: 0.88, r: 252, g: 172, b: 98 },
    { t: 1, r: 252, g: 250, b: 224 },
  ],
  ice: [
    { t: 0, r: 8, g: 16, b: 42 },
    { t: 0.24, r: 22, g: 54, b: 96 },
    { t: 0.46, r: 30, g: 104, b: 148 },
    { t: 0.64, r: 74, g: 158, b: 188 },
    { t: 0.8, r: 150, g: 208, b: 222 },
    { t: 0.92, r: 222, g: 242, b: 248 },
    { t: 1, r: 255, g: 255, b: 255 },
  ],
};

function rampColor(ramp: FieldRamp, t: number, out: [number, number, number]): void {
  const stops = RAMPS[ramp];
  const x = clamp01(t);
  let i = 0;
  while (i < stops.length - 2 && x > stops[i + 1]!.t) i++;
  const a = stops[i]!;
  const b = stops[i + 1]!;
  const span = b.t - a.t || 1;
  const f = clamp01((x - a.t) / span);
  out[0] = Math.round(a.r + (b.r - a.r) * f);
  out[1] = Math.round(a.g + (b.g - a.g) * f);
  out[2] = Math.round(a.b + (b.b - a.b) * f);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function hex(r: number, g: number, b: number): string {
  const p = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${p(r)}${p(g)}${p(b)}`;
}

/* ------------------------------------------------------------------ *
 * Raster 缓存(每世界只栅格化一次)
 * ------------------------------------------------------------------ */

const rasterCache = new WeakMap<World, Raster>();

function rasterOf(world: World): Raster {
  const hit = rasterCache.get(world);
  if (hit) return hit;
  const r = rasterize(world, 0.5, false);
  rasterCache.set(world, r);
  return r;
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

function stretchOf(frame: FieldFrame, mode: FieldStyle['stretch']): [number, number] {
  const s = frame.stats;
  if (mode === 'minmax') return [s.min, s.max];
  // p1–p99 拉伸;退化时退回真实 min/max
  if (s.p99 - s.p01 > 1e-9) return [s.p01, s.p99];
  return [s.min, s.max];
}

/** 浮雕明暗:只读 raster.elev,不改场值;跨 180° 用 x 取模。 */
function shadeAt(r: Raster, x: number, y: number): number {
  const w = r.w;
  const h = r.h;
  const eL = r.elev[y * w + ((x - 1 + w) % w)]!;
  const eR = r.elev[y * w + ((x + 1) % w)]!;
  const eU = r.elev[Math.max(0, y - 1) * w + x]!;
  const eD = r.elev[Math.min(h - 1, y + 1) * w + x]!;
  // 西北光;坡度差按米换算成一个温和的明暗系数
  const gx = (eL - eR) * 0.0016;
  const gy = (eU - eD) * 0.0016;
  return Math.max(0, Math.min(1, 0.5 + gx * 0.9 + gy * 0.9));
}

export function renderFieldMap(world: World, frame: FieldFrame, style: FieldStyle = DEFAULT_FIELD_STYLE): FieldRender {
  const r = rasterOf(world);
  const w = r.w;
  const h = r.h;
  const n = w * h;
  const [lo, hi] = stretchOf(frame, style.stretch);
  const span = hi - lo > 1e-9 ? hi - lo : 1;
  const opacity = clamp01(style.opacity);
  const levels = style.contour === true ? 6 : typeof style.contour === 'number' ? Math.max(2, Math.min(16, Math.round(style.contour))) : 0;

  // 先把每像素的值取出来(最近地块),顺便算归一化 t
  const t = new Float32Array(n);
  const cellIdx = r.cell;
  for (let p = 0; p < n; p++) {
    const ci = cellIdx[p]!;
    if (ci < 0 || ci >= frame.values.length) {
      t[p] = NaN;
      continue;
    }
    t[p] = clamp01((frame.values[ci]! - lo) / span);
  }

  // 显示级平滑:把每格的值先铺成平场,再做一次可分离盒式模糊(不改 values,也不进 data)
  if (style.smooth) {
    const radius = Math.max(1, Math.round(w / 240));
    const tmp = new Float32Array(n);
    const blur = new Float32Array(n);
    const pass = (src: Float32Array, dst: Float32Array, horizontal: boolean) => {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sum = 0;
          let cnt = 0;
          for (let d = -radius; d <= radius; d++) {
            const xx = horizontal ? (x + d + w) % w : x;
            const yy = horizontal ? y : y + d;
            if (yy < 0 || yy >= h) continue;
            const v = src[yy * w + xx]!;
            if (Number.isNaN(v)) continue;
            sum += v;
            cnt++;
          }
          dst[y * w + x] = cnt ? sum / cnt : NaN;
        }
      }
    };
    pass(t, tmp, true);
    pass(tmp, blur, false);
    for (let p = 0; p < n; p++) if (!Number.isNaN(blur[p]!)) t[p] = blur[p]!;
  }

  // 等高线/辉光需要邻域 t;高斯只做显示,不写回 values
  const rgba = new Uint8Array(n * 4);
  const c: [number, number, number] = [0, 0, 0];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const tv = t[p]!;
      if (Number.isNaN(tv)) {
        rgba[p * 4 + 3] = 0;
        continue;
      }
      rampColor(style.ramp, tv, c);
      let rr = c[0];
      let gg = c[1];
      let bb = c[2];
      if (style.hillshade) {
        const sh = shadeAt(r, x, y);
        const k = 0.78 + 0.45 * sh;
        rr *= k;
        gg *= k;
        bb *= k;
      }
      if (levels > 0) {
        // 和左边/上边的等高线带不同 = 画线
        const band = Math.floor(tv * levels);
        const left = x > 0 ? t[p - 1]! : NaN;
        const up = y > 0 ? t[p - w]! : NaN;
        const edge =
          (Number.isFinite(left) && Math.floor(left * levels) !== band) ||
          (Number.isFinite(up) && Math.floor(up * levels) !== band);
        if (edge && tv > 0.08) {
          rr = Math.min(255, rr * 1.25 + 28);
          gg = Math.min(255, gg * 1.25 + 28);
          bb = Math.min(255, bb * 1.25 + 28);
        }
      }
      // 低值几乎透明,高值更实;这样底图地形能透出来
      const a = opacity * Math.min(1, 0.02 + Math.pow(tv, 1.6) * 1.02);
      if (a < 0.012) {
        rgba[p * 4 + 3] = 0;
        continue;
      }
      rgba[p * 4] = Math.min(255, Math.round(rr));
      rgba[p * 4 + 1] = Math.min(255, Math.round(gg));
      rgba[p * 4 + 2] = Math.min(255, Math.round(bb));
      rgba[p * 4 + 3] = Math.round(a * 255);
    }
  }

  if (style.glow) {
    // 亮部先做掩膜,再做一次可分离盒式模糊,加色叠加(纯显示)
    const mask = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      const tv = t[p]!;
      if (!Number.isNaN(tv) && tv > 0.55) mask[p] = (tv - 0.55) / 0.45;
    }
    const radius = Math.max(2, Math.round(w / 200));
    const tmp = new Float32Array(n);
    const blur = new Float32Array(n);
    const box = (src: Float32Array, dst: Float32Array, r: number, horizontal: boolean) => {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let sum = 0;
          let cnt = 0;
          for (let d = -r; d <= r; d++) {
            const xx = horizontal ? (x + d + w) % w : x;
            const yy = horizontal ? y : y + d;
            if (yy < 0 || yy >= h) continue;
            sum += src[yy * w + xx]!;
            cnt++;
          }
          dst[y * w + x] = cnt ? sum / cnt : 0;
        }
      }
    };
    box(mask, tmp, radius, true);
    box(tmp, blur, radius, false);
    const hot: [number, number, number] = [0, 0, 0];
    rampColor(style.ramp, 0.92, hot);
    for (let p = 0; p < n; p++) {
      const g = blur[p]!;
      if (g <= 0.02) continue;
      const add = Math.min(0.6, g * 0.9);
      rgba[p * 4] = Math.min(255, Math.round(rgba[p * 4]! + hot[0] * add));
      rgba[p * 4 + 1] = Math.min(255, Math.round(rgba[p * 4 + 1]! + hot[1] * add));
      rgba[p * 4 + 2] = Math.min(255, Math.round(rgba[p * 4 + 2]! + hot[2] * add));
      rgba[p * 4 + 3] = Math.min(255, Math.round(rgba[p * 4 + 3]! + 255 * 0.22 * add));
    }
  }

  const ticks: FieldLegendTick[] = [0, 0.25, 0.5, 0.75, 1].map((x) => ({ t: x, value: lo + (hi - lo) * x }));
  const legend = fieldLegend(frame, style);
  return { width: w, height: h, png: encodePng(w, h, rgba), legend };
}

/** 只算图例,不碰像素;PNG 与图例共用同一套拉伸/色带/刻度逻辑。 */
export function fieldLegend(frame: FieldFrame, style: FieldStyle = DEFAULT_FIELD_STYLE): FieldLegend {
  const [lo, hi] = stretchOf(frame, style.stretch);
  const stops: { t: number; hex: string }[] = [];
  const c: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 9; i++) {
    const x = i / 8;
    rampColor(style.ramp, x, c);
    stops.push({ t: x, hex: hex(c[0], c[1], c[2]) });
  }
  const ticks: FieldLegendTick[] = [0, 0.25, 0.5, 0.75, 1].map((x) => ({ t: x, value: lo + (hi - lo) * x }));
  return {
    kind: frame.kind,
    label: FIELD_LABEL[frame.kind] ?? frame.kind,
    ramp: style.ramp,
    rampLabel: FIELD_RAMP_LABEL[style.ramp],
    min: frame.stats.min,
    max: frame.stats.max,
    p50: frame.stats.p50,
    stops,
    ticks,
    unit: '0–1(相对浓度)',
  };
}

/* ------------------------------------------------------------------ *
 * 数值接口(给 hover / 导出用;与 PNG 解耦)
 * ------------------------------------------------------------------ */

export function fieldDataJson(world: World, frame: FieldFrame, gridW = 256): FieldDataJson {
  const r = rasterOf(world);
  const gw = Math.max(16, Math.min(1024, Math.round(gridW)));
  const gh = Math.max(8, Math.round((gw * r.h) / r.w));
  const grid = new Int32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    const ry = Math.min(r.h - 1, Math.floor((gy + 0.5) * (r.h / gh)));
    for (let gx = 0; gx < gw; gx++) {
      const rx = Math.min(r.w - 1, Math.floor((gx + 0.5) * (r.w / gw)));
      const ci = r.cell[ry * r.w + rx]!;
      grid[gy * gw + gx] = ci >= 0 && ci < frame.values.length ? ci : -1;
    }
  }
  const valuesB64 = Buffer.from(frame.values.buffer, frame.values.byteOffset, frame.values.byteLength).toString('base64');
  const gridB64 = Buffer.from(grid.buffer, grid.byteOffset, grid.byteLength).toString('base64');
  return {
    kind: frame.kind,
    label: FIELD_LABEL[frame.kind] ?? frame.kind,
    unit: 'cell',
    version: frame.version,
    cells: frame.cells,
    hash: frame.hash,
    stats: frame.stats,
    values: valuesB64,
    grid: gridB64,
    gridW: gw,
    gridH: gh,
    width: world.width,
    height: world.height,
    frameId: frame.id,
  };
}
