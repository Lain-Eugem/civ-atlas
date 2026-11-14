/**
 * 「魔力」动态图层的渲染层:只读 Civ 里的 simLayers(按州的魔力浓度),按年份取帧、上色成 PNG。
 * 和 src/gen/field.ts / mcp/field-render.ts 的分工一样:数值由引擎表算好、这里只负责显示,不改任何状态。
 *
 * 分辨率与地形底图一致(2048×1024):先把每州的值摊到地块上,再用球面三角形重心插值铺满
 * 主图(`sphereField`),州界因此是渐变而不是一格一格的马赛克;再叠一层柔光和辉光。
 */
import type { Raster } from '../src/gen/raster';
import { rasterize, sphereField } from '../src/gen/raster';
import { sphereCoverWindow } from '../src/gen/rasterWindow';
import type { World } from '../src/gen/world';
import type { Civ } from '../src/gen/civ/types';
import { encodePng } from './png';

/** 输出宽度与地形底图同为 2048(世界宽度通常就是 2048,这里只是兜底) */
export const MAGIC_OUT_W = 2048;

export interface MagicLayerFrame {
  years: number[];
  /** 每帧的格数(按州 = 州数;按地块 = 地块数) */
  count: number;
  unit: 'region' | 'tile';
  values: Float32Array;
}

export interface MagicRenderStyle {
  opacity: number;
  /** 玩家自选的色带(2–8 个 #rrggbb);不给时用图层自带 ramp(默认紫色系) */
  colors?: readonly string[];
}

export const DEFAULT_MAGIC_STYLE: MagicRenderStyle = { opacity: 0.85 };

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** 解析查看器传进来的 colors=#aabbcc,#ddeeff;格式不合规返回 null(用默认色带) */
export function parseMagicColors(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 8) return null;
  if (!parts.every((p) => HEX_COLOR.test(p))) return null;
  return parts;
}

/** 实际渲染用的色带:玩家选的优先,否则用图层自带 ramp */
export function magicColorsOf(layer: { colors: string[] }, style?: MagicRenderStyle): string[] {
  const pick = style?.colors;
  if (pick && pick.length >= 2) return [...pick];
  return [...layer.colors];
}

export interface MagicLegend {
  title: string;
  legend: string;
  colors: string[];
  min: number;
  max: number;
  frameYear: number | null;
  ticks: { value: number; label: string }[];
}

export interface MagicRender {
  width: number;
  height: number;
  png: Buffer;
  legend: MagicLegend;
  frameYear: number | null;
}

/** 一局魔力层的元数据:按州(旧)或按地块(现在内置魔力场) */
export interface MagicLayer extends MagicLayerFrame {
  title: string;
  colors: string[];
  min: number;
  max: number;
  legend: string;
}

const rasterCache = new WeakMap<World, Raster>();

export function magicRaster(world: World): Raster {
  const hit = rasterCache.get(world);
  if (hit) return hit;
  const r = rasterize(world, 0.5, false);
  rasterCache.set(world, r);
  return r;
}

/** 取本局魔力层(没有 = null);unit 决定是「一州一值」还是「一地块一值」 */
export function magicLayerOf(civ: Civ): MagicLayer | null {
  const L = (civ.simLayers ?? []).find((v) => v.by === 'magic' && v.id === 'magic');
  if (!L || !L.years.length) return null;
  const unit: 'region' | 'tile' = L.unit === 'tile' ? 'tile' : 'region';
  const count = Math.floor(L.values.length / L.years.length);
  if (count <= 0) return null;
  return {
    years: [...L.years],
    values: L.values,
    unit,
    count,
    title: L.title,
    colors: [...(L.ramp?.colors ?? ['#1b1036', '#5b2a9e', '#a46cff', '#f2e6ff'])],
    min: L.ramp?.min ?? 0,
    max: L.ramp?.max ?? 60,
    legend: L.legend ?? '魔力（0–100）',
  };
}

/** 选帧:取不晚于 year 的最后一帧;早了取第一帧 */
export function magicFrameIndex(years: readonly number[], year: number): number {
  let pick = 0;
  for (let i = 0; i < years.length; i++) {
    if (years[i] <= year) pick = i;
    else break;
  }
  return pick;
}

/** 帧里的值按线性插值取(年落在两帧之间时),显示用;两端取端点 */
export function magicValuesAt(layer: { years: number[]; values: Float32Array; count: number }, year: number): { frame: number; values: Float32Array } {
  const i = magicFrameIndex(layer.years, year);
  const n = layer.count;
  const cur = layer.values.subarray(i * n, (i + 1) * n);
  if (i + 1 >= layer.years.length) return { frame: layer.years[i], values: Float32Array.from(cur) };
  const y0 = layer.years[i];
  const y1 = layer.years[i + 1];
  if (year <= y0 || y1 <= y0) return { frame: y0, values: Float32Array.from(cur) };
  const t = Math.min(1, Math.max(0, (year - y0) / (y1 - y0)));
  const nxt = layer.values.subarray((i + 1) * n, (i + 2) * n);
  const out = new Float32Array(n);
  for (let r = 0; r < n; r++) out[r] = cur[r]! + (nxt[r]! - cur[r]!) * t;
  return { frame: y0, values: out };
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = Number.parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** 色带采样:t ∈ [0,1] */
export function rampColor(colors: readonly string[], t: number): [number, number, number] {
  if (!colors.length) return [255, 255, 255];
  const x = Math.min(1, Math.max(0, t)) * (colors.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = hexRgb(colors[i]);
  const b = hexRgb(colors[Math.min(colors.length - 1, i + 1)]);
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

export function magicLegendOf(civ: Civ, year: number, colors?: readonly string[]): MagicLegend {
  const layer = magicLayerOf(civ);
  if (!layer) return { title: '魔力浓度', legend: '魔力（0–100）', colors: [], min: 0, max: 60, frameYear: null, ticks: [] };
  const { frame } = magicValuesAt(layer, year);
  const ticks: { value: number; label: string }[] = [];
  const steps = [0, 0.25, 0.5, 0.75, 1];
  for (const f of steps) {
    const value = layer.min + (layer.max - layer.min) * f;
    ticks.push({ value, label: value >= 100 ? value.toFixed(0) : value.toFixed(1) });
  }
  const palette = colors && colors.length >= 2 ? [...colors] : layer.colors;
  return { title: layer.title, legend: layer.legend, colors: palette, min: layer.min, max: layer.max, frameYear: frame, ticks };
}

/** 显示级盒式模糊:横向按经度取模;纵向按最近的边延伸。只改观感,不碰数值。 */
function blurField(a: Float32Array, w: number, h: number, r: number): void {
  if (r <= 0) return;
  const tmp = new Float32Array(a.length);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let d = -r; d <= r; d++) sum += a[row + (((d % w) + w) % w)]!;
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * inv;
      const add = (((x + r + 1) % w) + w) % w;
      const sub = (((x - r) % w) + w) % w;
      sum += a[row + add]! - a[row + sub]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let d = -r; d <= r; d++) sum += tmp[Math.min(h - 1, Math.max(0, d)) * w + x]!;
    for (let y = 0; y < h; y++) {
      a[y * w + x] = sum * inv;
      const add = Math.min(h - 1, y + r + 1);
      const sub = Math.max(0, y - r);
      sum += tmp[add * w + x]! - tmp[sub * w + x]!;
    }
  }
}

/**
 * 一帧的值 → 每地块的显示强度 t ∈ [0,1]。
 * - 按州记的旧层:州内常数,水地块 0;
 * - 按地块记的新层:直接取每地块的值,水地块仍是 0(魔力只长在陆地上)。
 * 数值本身不改;这里只做显示前的归一化。
 */
export function magicCellField(world: World, civ: Civ, layer: MagicLayer, values: Float32Array): Float32Array {
  const mesh = world.mesh;
  const cells = new Float32Array(mesh.n);
  const span = Math.max(1e-6, layer.max - layer.min);
  const of = civ.regions.of;
  if (layer.unit === 'tile') {
    const n = Math.min(mesh.n, values.length);
    for (let c = 0; c < n; c++) {
      const v = of[c]! >= 0 ? values[c]! : NaN;
      cells[c] = Number.isFinite(v) ? (v - layer.min) / span : 0;
    }
    return cells;
  }
  for (let c = 0; c < mesh.n; c++) {
    const region = of[c]!;
    const v = region >= 0 && region < values.length ? values[region]! : NaN;
    cells[c] = Number.isFinite(v) ? (v - layer.min) / span : 0;
  }
  return cells;
}

/**
 * 每地块的显示强度 → 按球面三角形插值成 w×h 的连续场(显示用)。
 * 州内是常数时,跨州界的一圈三角形里线性过渡;按地块的层本身就是连续的。
 */
export function magicFieldOf(world: World, civ: Civ, layer: MagicLayer, values: Float32Array, w: number, h: number): Float32Array {
  return sphereField(world.mesh, magicCellField(world, civ, layer, values), w, h);
}

export interface MagicPixels {
  width: number;
  height: number;
  rgba: Uint8Array;
  frameYear: number | null;
}

/** 把连续场 t + 辉光场 glow 上色成 RGBA(低值近透明,高值实色 + 柔光) */
function paintMagic(t: Float32Array, glow: Float32Array, w: number, h: number, opacityIn: number, colors: readonly string[]): Uint8Array {
  const n = w * h;
  const rgba = new Uint8Array(n * 4);
  const opacity = Math.min(1, Math.max(0.05, opacityIn));
  const hot = rampColor(colors, 0.92);
  for (let p = 0; p < n; p++) {
    const tv = Math.min(1, Math.max(0, t[p]!));
    const [R0, G0, B0] = rampColor(colors, tv);
    let R = R0;
    let G = G0;
    let B = B0;
    const g = glow[p]!;
    if (g > 0.01) {
      const add = Math.min(0.6, g * 0.95);
      R = Math.min(255, R + hot[0] * add);
      G = Math.min(255, G + hot[1] * add);
      B = Math.min(255, B + hot[2] * add);
    }
    // 低值留一层很淡的雾,高值更实;再叠辉光带来的额外不透明度
    const alpha = Math.min(1, opacity * (0.02 + Math.pow(tv, 0.55) * 0.96) + 0.18 * g);
    if (alpha < 0.012) continue;
    const o = p * 4;
    rgba[o] = Math.round(R);
    rgba[o + 1] = Math.round(G);
    rgba[o + 2] = Math.round(B);
    rgba[o + 3] = Math.round(alpha * 255);
  }
  return rgba;
}

/** 高值掩膜糊开当辉光(radius 按画面像素给) */
function glowOf(t: Float32Array, w: number, h: number, radius: number): Float32Array {
  const n = w * h;
  const glow = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const tv = t[p]!;
    if (tv > 0.55) glow[p] = (tv - 0.55) / 0.45;
  }
  blurField(glow, w, h, radius);
  return glow;
}

/**
 * 魔力图层的 RGBA 像素(2048 级,和地形底图同分辨率)。
 * 观感:低值只留一层薄雾,值越高颜色越实、越亮,高值外面再加一圈柔光。
 */
export function renderMagicPixels(world: World, civ: Civ, year: number, style: MagicRenderStyle = DEFAULT_MAGIC_STYLE): MagicPixels | null {
  const layer = magicLayerOf(civ);
  if (!layer) return null;
  const w = Math.max(512, Math.round(world.width));
  const h = Math.max(256, Math.round(world.height));
  const { values, frame } = magicValuesAt(layer, year);
  const t = magicFieldOf(world, civ, layer, values, w, h);
  // 三角形插值在格与格之间的折线再用约 2px 的柔化抹一下
  blurField(t, w, h, Math.max(1, Math.round(w / 1024)));
  const glow = glowOf(t, w, h, Math.max(2, Math.round(w / 190)));
  return { width: w, height: h, rgba: paintMagic(t, glow, w, h, style.opacity, magicColorsOf(layer, style)), frameYear: frame };
}

/**
 * 魔力图层的一块高清瓦片(给查看器放大后按 LOD 贴图用)。
 * 坐标与地形瓦片一致:S 倍主图上从 (x0, y0) 开始的 size × size 像素;
 * 球面覆盖复用 rasterWindow 的窗口化三角形覆盖,模糊 / 辉光半径按瓦片像素算,
 * 所以放大到多少倍,柔边和光晕在屏幕上都是固定几像素,不会像整张 2048 图那样被拉糊。
 */
export function renderMagicTilePixels(world: World, civ: Civ, year: number, S: number, x0: number, y0: number, size: number, style: MagicRenderStyle = DEFAULT_MAGIC_STYLE): MagicPixels | null {
  const layer = magicLayerOf(civ);
  if (!layer) return null;
  const mesh = world.mesh;
  const { values, frame } = magicValuesAt(layer, year);
  const cells = magicCellField(world, civ, layer, values);
  const cov = sphereCoverWindow(world, S, x0, y0, size, size);
  const tris = mesh.triangles;
  const t = new Float32Array(size * size);
  for (let p = 0; p < t.length; p++) {
    const ti = cov.tri[p]! - 1;
    if (ti < 0) continue;
    const a = tris[3 * ti]!;
    const b = tris[3 * ti + 1]!;
    const c = tris[3 * ti + 2]!;
    const ua = cov.wa[p]!;
    const ub = cov.wb[p]!;
    t[p] = ua * cells[a]! + ub * cells[b]! + (1 - ua - ub) * cells[c]!;
  }
  // 半径按瓦片像素(≈屏幕像素)给:512 块 → 2px 柔化、4px 辉光
  blurField(t, size, size, Math.max(1, Math.round(size / 256)));
  const glow = glowOf(t, size, size, Math.max(2, Math.round(size / 128)));
  return { width: size, height: size, rgba: paintMagic(t, glow, size, size, style.opacity, magicColorsOf(layer, style)), frameYear: frame };
}

/** 渲染一块魔力瓦片 PNG */
export function renderMagicTile(world: World, civ: Civ, year: number, S: number, x0: number, y0: number, size: number, style: MagicRenderStyle = DEFAULT_MAGIC_STYLE): { width: number; height: number; png: Buffer; frameYear: number | null } | null {
  const px = renderMagicTilePixels(world, civ, year, S, x0, y0, size, style);
  if (!px) return null;
  return { width: px.width, height: px.height, png: encodePng(px.width, px.height, px.rgba), frameYear: px.frameYear };
}

/** 渲染魔力图层 PNG(分辨率与地形底图一致;低值透明,高值实色 + 柔光) */
export function renderMagicMap(world: World, civ: Civ, year: number, style: MagicRenderStyle = DEFAULT_MAGIC_STYLE): MagicRender | null {
  const px = renderMagicPixels(world, civ, year, style);
  if (!px) return null;
  return {
    width: px.width,
    height: px.height,
    png: encodePng(px.width, px.height, px.rgba),
    legend: magicLegendOf(civ, year, style.colors),
    frameYear: px.frameYear,
  };
}

export interface MagicDataJson {
  sessionId: string;
  year: number;
  frameYear: number | null;
  years: number[];
  /** region = 值按州、grid 存州编号;tile = 值按地块、grid 存地块编号(水 = -1) */
  unit: 'region' | 'tile';
  count: number;
  values: string;
  grid: string;
  gridW: number;
  gridH: number;
  stats: { min: number; max: number; mean: number };
  colors: string[];
  min: number;
  max: number;
  legend: string;
}

/** 给 hover / 导出用的精确值:按州或按地块,按 unit 判读(不经过颜色反推) */
export function magicDataJson(world: World, civ: Civ, sessionId: string, year: number, gridW = 256, colors?: readonly string[]): MagicDataJson | null {
  const layer = magicLayerOf(civ);
  if (!layer) return null;
  const r = magicRaster(world);
  const { values, frame } = magicValuesAt(layer, year);
  const of = civ.regions.of;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let k = 0;
  // 水地块不算进统计(魔力只长在陆地上,按地块层里海水那部分显示为 0)
  const counted = (i: number): boolean => (layer.unit === 'tile' ? of[i]! >= 0 : true);
  for (let i = 0; i < values.length; i++) {
    if (!counted(i)) continue;
    const v = values[i]!;
    if (!Number.isFinite(v)) continue;
    min = Math.min(min, v);
    max = Math.max(max, v);
    sum += v;
    k++;
  }
  const gridH = Math.max(32, Math.round((world.height / world.width) * gridW));
  const grid = new Int32Array(gridW * gridH);
  for (let gy = 0; gy < gridH; gy++) {
    const y = Math.min(r.h - 1, Math.floor((gy + 0.5) * (r.h / gridH)));
    for (let gx = 0; gx < gridW; gx++) {
      const x = Math.min(r.w - 1, Math.floor((gx + 0.5) * (r.w / gridW)));
      const cell = r.cell[y * r.w + x];
      if (cell < 0) {
        grid[gy * gridW + gx] = -1;
      } else if (layer.unit === 'tile') {
        grid[gy * gridW + gx] = of[cell]! >= 0 ? cell : -1;
      } else {
        grid[gy * gridW + gx] = of[cell]!;
      }
    }
  }
  return {
    sessionId,
    year,
    frameYear: frame,
    years: layer.years,
    unit: layer.unit,
    count: layer.count,
    values: Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64'),
    grid: Buffer.from(grid.buffer, grid.byteOffset, grid.byteLength).toString('base64'),
    gridW,
    gridH,
    stats: k ? { min, max, mean: sum / k } : { min: 0, max: 0, mean: 0 },
    colors: colors && colors.length >= 2 ? [...colors] : layer.colors,
    min: layer.min,
    max: layer.max,
    legend: layer.legend,
  };
}
