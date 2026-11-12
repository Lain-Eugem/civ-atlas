/**
 * 「魔力」动态图层的渲染层:只读 Civ 里的 simLayers(按州的魔力浓度),按年份取帧、上色成 PNG。
 * 和 src/gen/field.ts / mcp/field-render.ts 的分工一样:数值由引擎表算好、这里只负责显示,不改任何状态。
 *
 * 分辨率与地形底图一致(2048×1024):先把每州的值摊到地块上,再用球面三角形重心插值铺满
 * 主图(`sphereField`),州界因此是渐变而不是一格一格的马赛克;再叠一层柔光和辉光。
 */
import type { Raster } from '../src/gen/raster';
import { rasterize, sphereField } from '../src/gen/raster';
import type { World } from '../src/gen/world';
import type { Civ } from '../src/gen/civ/types';
import { encodePng } from './png';

/** 输出宽度与地形底图同为 2048(世界宽度通常就是 2048,这里只是兜底) */
export const MAGIC_OUT_W = 2048;

export interface MagicLayerFrame {
  years: number[];
  /** 每帧州数 */
  regions: number;
  values: Float32Array;
}

export interface MagicRenderStyle {
  opacity: number;
}

export const DEFAULT_MAGIC_STYLE: MagicRenderStyle = { opacity: 0.85 };

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

const rasterCache = new WeakMap<World, Raster>();

export function magicRaster(world: World): Raster {
  const hit = rasterCache.get(world);
  if (hit) return hit;
  const r = rasterize(world, 0.5, false);
  rasterCache.set(world, r);
  return r;
}

/** 取本局魔力层(没有 = null) */
export function magicLayerOf(civ: Civ): { years: number[]; values: Float32Array; regions: number; title: string; colors: string[]; min: number; max: number; legend: string } | null {
  const L = (civ.simLayers ?? []).find((v) => v.by === 'magic' && v.id === 'magic');
  if (!L || !L.years.length) return null;
  const regions = Math.floor(L.values.length / L.years.length);
  if (regions <= 0) return null;
  return {
    years: [...L.years],
    values: L.values,
    regions,
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

/** 帧里的州值按线性插值取(年落在两帧之间时),显示用;两端取端点 */
export function magicValuesAt(layer: { years: number[]; values: Float32Array; regions: number }, year: number): { frame: number; values: Float32Array } {
  const i = magicFrameIndex(layer.years, year);
  const n = layer.regions;
  const cur = layer.values.subarray(i * n, (i + 1) * n);
  if (i + 1 >= layer.years.length) return { frame: layer.years[i], values: Float32Array.from(cur) };
  const y0 = layer.years[i];
  const y1 = layer.years[i + 1];
  if (year <= y0 || y1 <= y0) return { frame: y0, values: Float32Array.from(cur) };
  const t = Math.min(1, Math.max(0, (year - y0) / (y1 - y0)));
  const nxt = layer.values.subarray((i + 1) * n, (i + 2) * n);
  const out = new Float32Array(n);
  for (let r = 0; r < n; r++) out[r] = cur[r] + (nxt[r] - cur[r]) * t;
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

export function magicLegendOf(civ: Civ, year: number): MagicLegend {
  const layer = magicLayerOf(civ);
  if (!layer) return { title: '魔力浓度', legend: '魔力（0–100）', colors: [], min: 0, max: 60, frameYear: null, ticks: [] };
  const { frame } = magicValuesAt(layer, year);
  const ticks: { value: number; label: string }[] = [];
  const steps = [0, 0.25, 0.5, 0.75, 1];
  for (const f of steps) {
    const value = layer.min + (layer.max - layer.min) * f;
    ticks.push({ value, label: value >= 100 ? value.toFixed(0) : value.toFixed(1) });
  }
  return { title: layer.title, legend: layer.legend, colors: layer.colors, min: layer.min, max: layer.max, frameYear: frame, ticks };
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
 * 每州的值 → 每地块 → 按球面三角形插值成 w×h 的连续场(t ∈ [0,1],显示用)。
 * 州内是常数,跨州界的一圈三角形里线性过渡,看起来就像连续扩散的魔力而不是色块。
 */
export function magicFieldOf(world: World, civ: Civ, values: Float32Array, min: number, span: number, w: number, h: number): Float32Array {
  const mesh = world.mesh;
  const cells = new Float32Array(mesh.n);
  const of = civ.regions.of;
  for (let c = 0; c < mesh.n; c++) {
    const region = of[c]!;
    const v = region >= 0 && region < values.length ? values[region]! : NaN;
    cells[c] = Number.isFinite(v) ? (v - min) / span : 0;
  }
  return sphereField(mesh, cells, w, h);
}

export interface MagicPixels {
  width: number;
  height: number;
  rgba: Uint8Array;
  frameYear: number | null;
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
  const n = w * h;
  const { values, frame } = magicValuesAt(layer, year);
  const span = Math.max(1e-6, layer.max - layer.min);
  const t = magicFieldOf(world, civ, values, layer.min, span, w, h);
  // 三角形插值在州界上的折线再用约 2px 的柔化抹一下;州内是常数,不会被抹淡
  blurField(t, w, h, Math.max(1, Math.round(w / 1024)));

  // 高值掩膜单独糊开当辉光(半径约 10px)
  const glow = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const tv = t[p]!;
    if (tv > 0.55) glow[p] = (tv - 0.55) / 0.45;
  }
  blurField(glow, w, h, Math.max(2, Math.round(w / 190)));

  const rgba = new Uint8Array(n * 4);
  const opacity = Math.min(1, Math.max(0.05, style.opacity));
  const hot = rampColor(layer.colors, 0.92);
  for (let p = 0; p < n; p++) {
    const tv = Math.min(1, Math.max(0, t[p]!));
    const [R0, G0, B0] = rampColor(layer.colors, tv);
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
  return { width: w, height: h, rgba, frameYear: frame };
}

/** 渲染魔力图层 PNG(分辨率与地形底图一致;低值透明,高值实色 + 柔光) */
export function renderMagicMap(world: World, civ: Civ, year: number, style: MagicRenderStyle = DEFAULT_MAGIC_STYLE): MagicRender | null {
  const px = renderMagicPixels(world, civ, year, style);
  if (!px) return null;
  return {
    width: px.width,
    height: px.height,
    png: encodePng(px.width, px.height, px.rgba),
    legend: magicLegendOf(civ, year),
    frameYear: px.frameYear,
  };
}

export interface MagicDataJson {
  sessionId: string;
  year: number;
  frameYear: number | null;
  years: number[];
  regions: number;
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

/** 给 hover / 导出用的精确州值(不经过颜色反推) */
export function magicDataJson(world: World, civ: Civ, sessionId: string, year: number, gridW = 256): MagicDataJson | null {
  const layer = magicLayerOf(civ);
  if (!layer) return null;
  const r = magicRaster(world);
  const { values, frame } = magicValuesAt(layer, year);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let k = 0;
  for (const v of values) {
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
      grid[gy * gridW + gx] = cell >= 0 ? civ.regions.of[cell] : -1;
    }
  }
  return {
    sessionId,
    year,
    frameYear: frame,
    years: layer.years,
    regions: layer.regions,
    values: Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64'),
    grid: Buffer.from(grid.buffer, grid.byteOffset, grid.byteLength).toString('base64'),
    gridW,
    gridH,
    stats: k ? { min, max, mean: sum / k } : { min: 0, max: 0, mean: 0 },
    colors: layer.colors,
    min: layer.min,
    max: layer.max,
    legend: layer.legend,
  };
}
