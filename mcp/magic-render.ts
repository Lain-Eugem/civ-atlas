/**
 * 「魔力」动态图层的渲染层:只读 Civ 里的 simLayers(按州的魔力浓度),按年份取帧、上色成 PNG。
 * 和 src/gen/field.ts / mcp/field-render.ts 的分工一样:数值由引擎表算好、这里只负责显示,不改任何状态。
 */
import type { Raster } from '../src/gen/raster';
import { rasterize } from '../src/gen/raster';
import type { World } from '../src/gen/world';
import type { Civ } from '../src/gen/civ/types';
import { encodePng } from './png';

export const MAGIC_OUT_W = 1024;

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

/** 渲染 1024×512 的魔力图层 PNG(每像素按所属州上色,低值近透明以便看到底图) */
export function renderMagicMap(world: World, civ: Civ, year: number, style: MagicRenderStyle = DEFAULT_MAGIC_STYLE): MagicRender | null {
  const layer = magicLayerOf(civ);
  if (!layer) return null;
  const r = magicRaster(world);
  const w = MAGIC_OUT_W;
  const h = Math.round((world.height / world.width) * w);
  const rgba = new Uint8Array(w * h * 4);
  const { values, frame } = magicValuesAt(layer, year);
  const span = Math.max(1e-6, layer.max - layer.min);
  const by = new Uint16Array(layer.regions);
  const opacity = Math.min(1, Math.max(0.05, style.opacity));
  for (let py = 0; py < h; py++) {
    const gy = Math.min(r.h - 1, Math.floor((py + 0.5) * (r.h / h)));
    for (let px = 0; px < w; px++) {
      const gx = Math.min(r.w - 1, Math.floor((px + 0.5) * (r.w / w)));
      const cell = r.cell[gy * r.w + gx];
      const region = cell >= 0 ? civ.regions.of[cell] : -1;
      if (region < 0 || region >= values.length) continue;
      const v = values[region];
      if (!Number.isFinite(v)) continue;
      const t = Math.min(1, Math.max(0, (v - layer.min) / span));
      by[region]++;
      const [R, G, B] = rampColor(layer.colors, t);
      const alpha = opacity * (0.02 + Math.pow(t, 0.55) * 0.98);
      if (alpha < 0.012) continue;
      const o = (py * w + px) * 4;
      rgba[o] = R;
      rgba[o + 1] = G;
      rgba[o + 2] = B;
      rgba[o + 3] = Math.round(alpha * 255);
    }
  }
  return { width: w, height: h, png: encodePng(w, h, rgba), legend: magicLegendOf(civ, year), frameYear: frame };
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
