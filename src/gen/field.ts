/**
 * 地块级「场」(field)原型:计算层。
 *
 * 这一层只负责把世界变成每格一个精确的数,不改任何已有数据、不碰 DOM、不碰渲染颜色。
 * 渲染(热力图、等高线、色带)在 mcp/field-render.ts,两层之间只通过 FieldFrame 通信。
 *
 * 设计约定(原型阶段就定下来,以后搬进引擎时不变):
 * - 同一个世界 + 同一个 kind/seed/scale/specVersion,生成的 values 逐字节一致;
 * - 随机只从世界种子派生(subSeed),不用 Math.random;
 * - 值用 double 生成、Float32 存储(4 字节/格);统计先转 double 再加/排序;
 * - hash 只盖 values 的字节,与渲染样式无关。
 */
import { subSeed, clamp, smoothstep } from './util';
import { fbm3, noise3, ridged3 } from './noise';
import type { World } from './world';

/** 场类型。原型先做三种;以后加新场只加到这张表 + 生成函数。 */
export type FieldKind = 'magic' | 'ore' | 'radiation';

export const FIELD_KINDS: readonly FieldKind[] = ['magic', 'ore', 'radiation'];

export const FIELD_LABEL: Record<FieldKind, string> = {
  magic: '魔脉浓度',
  ore: '矿产资源',
  radiation: '辐射本底',
};

/** 规格版本:生成公式一变就加一,存档/分享里要带上。 */
export const FIELD_VERSION = 1;

export interface FieldOptions {
  /** 同一世界换一条魔脉:不影响别的世界;不给 = 只按世界种子 */
  seed?: number;
  /** 尺度倍数:越大纹路越粗;默认 1,夹在 0.25–4 */
  scale?: number;
}

export interface FieldStats {
  min: number;
  max: number;
  mean: number;
  std: number;
  p01: number;
  p50: number;
  p90: number;
  p99: number;
  p999: number;
}

export interface FieldFrame {
  kind: FieldKind;
  /** 稳定编号:`${kind}:${seed}:v${FIELD_VERSION}`,渲染缓存/日志用 */
  id: string;
  version: number;
  unit: 'cell';
  /** 地块数,与 world.elevation.length 一致 */
  cells: number;
  seed: number;
  /** 0–1 的精确值,长度 = cells */
  values: Float32Array;
  stats: FieldStats;
  /** 只盖 values 字节的 32 位 FNV-1a;同值同 hash,和渲染无关 */
  hash: string;
}

/** 逐字节 FNV-1a(不依赖 node:crypto,浏览器也能跑)。 */
export function hashValues(values: Float32Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + '-' + values.length.toString(16);
}

/** 统计:先按 Float32 存下来的值算,保证展示与存储一致。 */
export function fieldStats(values: Float32Array): FieldStats {
  const n = values.length;
  if (n === 0) return { min: 0, max: 0, mean: 0, std: 0, p01: 0, p50: 0, p90: 0, p99: 0, p999: 0 };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = values[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i]! - mean;
    sq += d * d;
  }
  const std = Math.sqrt(sq / n);
  const sorted = Float64Array.from(values);
  sorted.sort();
  const at = (q: number) => sorted[Math.min(n - 1, Math.max(0, Math.round(q * (n - 1))))]!;
  return { min, max, mean, std, p01: at(0.01), p50: at(0.5), p90: at(0.9), p99: at(0.99), p999: at(0.999) };
}

interface SamplePoint {
  /** 单位球上的一点(按等距圆柱的格心换算) */
  x: number;
  y: number;
  z: number;
  /** 海拔归一化:陆地 0–1,海面 0 */
  land: number;
}

/** 按格心把 mesh 的经纬度换成单位球坐标(接缝处同一 3D 点,所以噪声无缝)。 */
function samplePoints(world: World): SamplePoint[] {
  const mesh = world.mesh;
  const cells = world.elevation.length;
  const W = Math.max(1, world.width);
  const H = Math.max(1, world.height);
  const maxElev = Math.max(1, world.maxElevation || 1);
  const out: SamplePoint[] = new Array(cells);
  for (let i = 0; i < cells; i++) {
    const lon = (mesh.x[i]! / W) * Math.PI * 2 - Math.PI;
    const lat = Math.PI / 2 - (mesh.y[i]! / H) * Math.PI;
    const cl = Math.cos(lat);
    const elev = world.elevation[i]!;
    out[i] = {
      x: cl * Math.cos(lon),
      y: cl * Math.sin(lon),
      z: Math.sin(lat),
      land: clamp(elev / maxElev, 0, 1),
    };
  }
  return out;
}

function normalize(raw: Float64Array): Float32Array {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min > 1e-12 ? max - min : 1;
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = clamp((raw[i]! - min) / span, 0, 1);
  return out;
}

/** 魔脉:大尺度山脊 + 细分支 + 一点底噪;山里与河谷更浓。 */
function magicField(world: World, seed: number, scale: number): Float32Array {
  const big = ridged3(noise3(subSeed(seed, 'magic-big')), 3);
  const fine = ridged3(noise3(subSeed(seed, 'magic-fine')), 4);
  const broad = fbm3(noise3(subSeed(seed, 'magic-broad')), 3);
  const pts = samplePoints(world);
  const raw = new Float64Array(pts.length);
  const f1 = 1.15 * scale;
  const f2 = 3.6 * scale;
  const f3 = 0.62 * scale;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const a = big(p.x * f1, p.y * f1, p.z * f1);
    const b = fine(p.x * f2, p.y * f2, p.z * f2);
    const c = broad(p.x * f3, p.y * f3, p.z * f3) * 0.5 + 0.5;
    // 山脊聚成「灵脉」:尖脊压得更细,粗脉为主、细脉分枝
    const spine = Math.pow(a, 3.6) * 1.15;
    const branch = Math.pow(b, 4.4) * 0.3;
    const veins = Math.max(spine, branch);
    // 山里更容易涌出灵脉,但不全在山里(海中也有暗脉);底噪只做很淡的底
    raw[i] = veins * 0.86 + Math.pow(c, 1.6) * 0.12 + Math.pow(p.land, 1.6) * 0.1;
  }
  return normalize(raw);
}

/** 矿产:大团簇 + 细纹理,山里更富。 */
function oreField(world: World, seed: number, scale: number): Float32Array {
  const cluster = fbm3(noise3(subSeed(seed, 'ore-cluster')), 3);
  const detail = fbm3(noise3(subSeed(seed, 'ore-detail')), 5);
  const pts = samplePoints(world);
  const raw = new Float64Array(pts.length);
  const f1 = 0.55 * scale;
  const f2 = 2.2 * scale;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const cl = cluster(p.x * f1, p.y * f1, p.z * f1) * 0.5 + 0.5;
    const de = detail(p.x * f2, p.y * f2, p.z * f2) * 0.5 + 0.5;
    // 大团簇做门,细纹理做里面的品位;山区加成
    raw[i] = smoothstep(0.35, 0.85, cl) * 0.66 + de * 0.3 + Math.pow(p.land, 2) * 0.22;
  }
  return normalize(raw);
}

/** 辐射:低频本底 + 少量「热点」;原型只依赖噪声与海拔,不碰虚构地图外的东西。 */
function radiationField(world: World, seed: number, scale: number): Float32Array {
  const broad = fbm3(noise3(subSeed(seed, 'rad-broad')), 2);
  const hot = ridged3(noise3(subSeed(seed, 'rad-hot')), 3);
  const pts = samplePoints(world);
  const raw = new Float64Array(pts.length);
  const f1 = 0.38 * scale;
  const f2 = 5.2 * scale;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const bg = broad(p.x * f1, p.y * f1, p.z * f1) * 0.5 + 0.5;
    const h = Math.pow(hot(p.x * f2, p.y * f2, p.z * f2), 5.5);
    raw[i] = Math.pow(bg, 1.6) * 0.7 + h * 0.6;
  }
  return normalize(raw);
}

function seedFor(world: World, kind: FieldKind, opts: FieldOptions): number {
  const base = subSeed(world.params.seed, `field:${kind}:v${FIELD_VERSION}`);
  return opts.seed === undefined ? base : subSeed(base, `variant:${opts.seed | 0}`);
}

/**
 * 生成一帧场。纯函数:同一个 world + kind + options 必得同一组 values/hash。
 * 注意:这里的 seed 语义与 World 生成无关,换 seed 只换这一帧场。
 */
export function fieldFrame(world: World, kind: FieldKind = 'magic', opts: FieldOptions = {}): FieldFrame {
  const scale = clamp(opts.scale ?? 1, 0.25, 4);
  const seed = seedFor(world, kind, opts);
  let values: Float32Array;
  if (kind === 'magic') values = magicField(world, seed, scale);
  else if (kind === 'ore') values = oreField(world, seed, scale);
  else values = radiationField(world, seed, scale);
  const cells = world.elevation.length;
  if (values.length !== cells) throw new Error(`field 长度不对: ${values.length} !== ${cells}`);
  return {
    kind,
    id: `${kind}:${seed}:v${FIELD_VERSION}`,
    version: FIELD_VERSION,
    unit: 'cell',
    cells,
    seed,
    values,
    stats: fieldStats(values),
    hash: hashValues(values),
  };
}

/** 校验一帧场:长度、有限值、0–1 范围;测试与接口都用它。 */
export function checkFieldFrame(world: World, frame: FieldFrame): string[] {
  const problems: string[] = [];
  if (frame.cells !== world.elevation.length) problems.push(`cells ${frame.cells} != world ${world.elevation.length}`);
  if (frame.values.length !== frame.cells) problems.push('values 长度不对');
  if (frame.unit !== 'cell') problems.push('unit 必须是 cell');
  let bad = 0;
  for (let i = 0; i < frame.values.length; i++) {
    const v = frame.values[i]!;
    if (!Number.isFinite(v) || v < 0 || v > 1) bad++;
  }
  if (bad) problems.push(`${bad} 个值不在 0–1`);
  if (!(frame.stats.min <= frame.stats.p01 && frame.stats.p01 <= frame.stats.p50 && frame.stats.p50 <= frame.stats.p90 && frame.stats.p90 <= frame.stats.p99 && frame.stats.p99 <= frame.stats.max)) {
    problems.push('分位数顺序不对');
  }
  return problems;
}
