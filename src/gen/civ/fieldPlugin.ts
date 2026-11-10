/**
 * 可配置的「场」:玩家给一份 FieldSpec(生成密度、扩散/衰减/人口耗散、影响哪些官方数值、图层怎么画),
 * 工厂造出一个原生推演插件。这里不写死任何具体设定——魔力/矿产/辐射只是别人填的 spec。
 *
 * 表结构(照官方 examples/plugins/magic 的做法):
 *   vein  按州,每 1000 年算一次:按 density 撒灵脉,初值 sourceMin..sourceMax
 *   rural 接官方乡村人口(输入表),拿来算人口耗散
 *   <id>  按州,每 every 年一步:向邻州扩散 + 从灵脉渗出 + 自然衰减 + 被人口消耗
 *
 * 影响口(官方 OFFICIAL_INFLUENCES):每 1 点场值给目标加 perPoint × strength。
 * 乘类口基准 1、加类口基准 0;单栏、region/polity 单位的口都能接(polity 口按治下州取平均)。
 */
import type { SimPlugin } from './engine/plugin';
import type { SimRead } from './simRead';
import type { TableCard } from './engine/tables/cards';
import { FREQUENCIES } from './engine/tables/cards';
import { OFFICIAL_INFLUENCES } from './influence';

/** 影响口:target 见 OFFICIAL_INFLUENCES;perPoint = 每 1 点场值的影响;base 不给则乘类 = 1、加类 = 0 */
export interface FieldInfluenceSpec {
  target: string;
  perPoint: number;
  base?: number;
}

/** 图层画法;keep 不给 = 50 年一帧 */
export interface FieldLayerSpec {
  title?: string;
  colors?: string[];
  min?: number;
  max?: number;
  legend?: string;
  keep?: number;
  /** 叠在底图上的不透明度(0–1,默认 0.78) */
  opacity?: number;
}

/** 一份场设定(玩家/前端可改) */
export interface FieldSpec {
  /** 场的编号,也是表名、图层名:小写字母数字连字符,最长 25 */
  id: string;
  /** 显示名(例:魔脉浓度) */
  name: string;
  /** 灵脉占比 0..1:每州有多大概率有灵脉 */
  density: number;
  /** 灵脉初值下限/上限(0..max) */
  sourceMin: number;
  sourceMax: number;
  /** 从邻州扩散进来的快慢(0..10) */
  spread: number;
  /** 从灵脉渗出的快慢(0..10) */
  seep: number;
  /** 自然衰减(0..10) */
  fade: number;
  /** 被人口消耗(0..10) */
  drain: number;
  /** 人口消耗到一半时的人口参考值(1..1e9) */
  crowd: number;
  /** 场值上限(1..1e6,默认 100) */
  max?: number;
  /** 几年算一步,默认 5,必须是官方频率 */
  every?: number;
  /** 影响哪些官方数值,1..6 条 */
  influences: FieldInfluenceSpec[];
  /** 图层画法;不给 = 会自动生成一套(ember 色带) */
  layer?: FieldLayerSpec;
  /** 总强度倍率 0..3(默认 1),乘在 perPoint 上;0 = 只记图层、不影响推演 */
  strength?: number;
}

export const FIELD_ID = /^[a-z0-9][a-z0-9-]{0,24}$/;
export const FIELD_INFLUENCE_MAX = 6;
export const FIELD_COLORS = ['#1b1036', '#5b2a9e', '#a46cff', '#f2e6ff'] as const;
export const FIELD_STRENGTH = { min: 0, max: 3, step: 0.5, default: 1 } as const;

/** 可以接的影响口(只列插件能用单栏表达的;dev.rate 这种多栏口先不列) */
export interface FieldPortInfo {
  id: string;
  unit: 'region' | 'polity';
  op: 'mul' | 'add';
  min: number;
  max: number;
}

export function fieldPorts(): FieldPortInfo[] {
  const out: FieldPortInfo[] = [];
  for (const p of OFFICIAL_INFLUENCES) {
    if (p.cols !== undefined && p.cols !== 1) continue;
    out.push({ id: p.id, unit: p.unit, op: p.op, min: p.min, max: p.max });
  }
  return out;
}

/** 端口说明(给工具/前端列清单用) */
export function fieldInfluenceCatalog() {
  return {
    strength: FIELD_STRENGTH,
    ports: fieldPorts(),
    example: EXAMPLE_FIELD_SPEC,
    note: 'perPoint 是「每 1 点场值」的影响:乘类口 base 默认 1(例 perPoint 0.01 = 每点 +1%),加类口 base 默认 0;strength 再乘一次。',
  } as const;
}

/** 示例设定(不是内置预设,只是给玩家抄的模板) */
export const EXAMPLE_FIELD_SPEC: FieldSpec = {
  id: 'mana',
  name: '魔脉浓度',
  density: 0.06,
  sourceMin: 40,
  sourceMax: 100,
  spread: 0.05,
  seep: 0.02,
  fade: 0.002,
  drain: 0.01,
  crowd: 100,
  max: 100,
  every: 5,
  influences: [{ target: 'city.capacity', perPoint: 0.01 }],
  layer: { title: '魔脉浓度', colors: [...FIELD_COLORS], min: 0, max: 60, legend: '魔脉(0–100)', keep: 50 },
};

const num = (v: number): string => String(Number(v.toFixed(6)));

/** 查一份设定:返回问题清单(空 = 没问题);写错时给中文原因 */
export function fieldSpecProblems(raw: unknown): string[] {
  const bad: string[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return ['设定要是一个对象'];
  const s = raw as Record<string, unknown>;
  const id = s.id;
  if (typeof id !== 'string' || !FIELD_ID.test(id)) bad.push('id 要小写字母/数字/连字符,1–25 个字');
  else if (id === 'vein' || id === 'rural') bad.push(`id 不能用 ${id}(和内部表重名)`);
  if (typeof s.name !== 'string' || !s.name.trim() || s.name.length > 24) bad.push('name 要 1–24 个字');
  const nums: [string, number, number, number][] = [
    ['density', 0, 0, 1],
    ['sourceMin', 0, 0, 1e6],
    ['sourceMax', 0, 0, 1e6],
    ['spread', 0, 0, 10],
    ['seep', 0, 0, 10],
    ['fade', 0, 0, 10],
    ['drain', 0, 0, 10],
    ['crowd', 1, 1, 1e9],
  ];
  for (const [k, fallback, lo, hi] of nums) {
    const v = s[k];
    if (v === undefined && k === 'density') {
      bad.push('density 要给');
      continue;
    }
    if (v === undefined) {
      bad.push(`${k} 要给`);
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) bad.push(`${k} 要是数`);
    else if (v < lo || v > hi) bad.push(`${k} 要在 ${lo}..${hi} 之间`);
  }
  const max = s.max === undefined ? 100 : s.max;
  if (typeof max !== 'number' || !Number.isFinite(max) || max < 1 || max > 1e6) bad.push('max 要在 1..1000000 之间');
  const every = s.every === undefined ? 5 : s.every;
  if (typeof every !== 'number' || !(FREQUENCIES as readonly number[]).includes(every)) bad.push(`every 只能是 ${FREQUENCIES.join('、')} 年`);
  if (typeof s.sourceMin === 'number' && typeof s.sourceMax === 'number' && typeof max === 'number') {
    if (s.sourceMin > s.sourceMax) bad.push('sourceMin 不能大于 sourceMax');
    if (s.sourceMax > max) bad.push('sourceMax 不能大于 max');
  }
  const strength = s.strength === undefined ? 1 : s.strength;
  if (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > 3) bad.push('strength 要在 0..3 之间');
  const inf = s.influences;
  if (!Array.isArray(inf) || inf.length < 1) bad.push('influences 要给 1–6 条');
  else {
    if (inf.length > FIELD_INFLUENCE_MAX) bad.push(`influences 最多 ${FIELD_INFLUENCE_MAX} 条`);
    const ports = fieldPorts();
    const seen = new Set<string>();
    inf.forEach((it, i) => {
      if (it === null || typeof it !== 'object') {
        bad.push(`influences[${i}] 要是一个对象`);
        return;
      }
      const o = it as Record<string, unknown>;
      if (typeof o.target !== 'string' || !ports.some((p) => p.id === o.target)) bad.push(`influences[${i}].target 不认得(见 fieldPorts())`);
      else if (seen.has(o.target)) bad.push(`influences[${i}].target 重复了`);
      else seen.add(o.target);
      if (typeof o.perPoint !== 'number' || !Number.isFinite(o.perPoint) || Math.abs(o.perPoint) > 1000) bad.push(`influences[${i}].perPoint 要在 ±1000 之间`);
      if (o.base !== undefined && (typeof o.base !== 'number' || !Number.isFinite(o.base))) bad.push(`influences[${i}].base 要是数`);
    });
  }
  const layer = s.layer;
  if (layer !== undefined) {
    if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) bad.push('layer 要是一个对象');
    else {
      const l = layer as Record<string, unknown>;
      if (l.title !== undefined && (typeof l.title !== 'string' || l.title.length > 40)) bad.push('layer.title 最长 40 个字');
      if (l.legend !== undefined && (typeof l.legend !== 'string' || l.legend.length > 40)) bad.push('layer.legend 最长 40 个字');
      if (l.keep !== undefined && (typeof l.keep !== 'number' || !Number.isInteger(l.keep) || l.keep < 1 || l.keep > 1000)) bad.push('layer.keep 要是 1..1000 的整数');
      if (l.colors !== undefined) {
        if (!Array.isArray(l.colors) || l.colors.length < 2 || l.colors.length > 16) bad.push('layer.colors 要 2–16 个颜色');
        else if (l.colors.some((c) => typeof c !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(c))) bad.push('layer.colors 里每个颜色要 #rrggbb');
      }
      for (const k of ['min', 'max'] as const) if (l[k] !== undefined && (typeof l[k] !== 'number' || !Number.isFinite(l[k]))) bad.push(`layer.${k} 要是数`);
    }
  }
  return bad;
}

/** 查、补默认值:写错抛 Error(中文原因) */
export function cleanFieldSpec(raw: unknown): FieldSpec {
  const bad = fieldSpecProblems(raw);
  if (bad.length) throw new Error(`场设定有问题:${bad.join(';')}`);
  const s = raw as FieldSpec;
  const max = s.max ?? 100;
  const layer = s.layer ?? {};
  return {
    ...s,
    name: s.name.trim(),
    max,
    every: s.every ?? 5,
    strength: s.strength ?? 1,
    layer: {
      title: (layer.title ?? s.name).trim(),
      colors: layer.colors ? [...layer.colors] : [...FIELD_COLORS],
      min: layer.min ?? 0,
      max: layer.max ?? Math.min(max, 60),
      legend: (layer.legend ?? `${s.name}(0–${max})`).trim(),
      keep: layer.keep ?? 50,
    },
    influences: s.influences.map((x) => ({ target: x.target, perPoint: x.perPoint, ...(x.base !== undefined ? { base: x.base } : {}) })),
  };
}

/** 倍率 0..3、按 0.5 对齐(和魔力场一致) */
export function fieldStrengthOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return FIELD_STRENGTH.default;
  const x = Math.max(FIELD_STRENGTH.min, Math.min(FIELD_STRENGTH.max, v));
  return Math.round(x / FIELD_STRENGTH.step) * FIELD_STRENGTH.step;
}

/** 造一个原生推演插件:表 + 图层 + 影响口映射 */
export function fieldPlugin(raw: FieldSpec | unknown): SimPlugin<SimRead> {
  const spec = cleanFieldSpec(raw);
  const strength = fieldStrengthOf(spec.strength);
  const max = spec.max ?? 100;
  const every = spec.every ?? 5;
  const layer = spec.layer!;
  const ports = fieldPorts();
  const table = spec.id;
  const tables: TableCard[] = [
    {
      id: 'vein',
      name: '灵脉',
      unit: 'region',
      every: 1000,
      min: 0,
      max: Math.max(max, spec.sourceMax),
      off: 0,
      init: `if(rand() < ${num(spec.density)}, ${num(spec.sourceMin)} + ${num(spec.sourceMax - spec.sourceMin)} * rand(1), 0)`,
      rule: 'vein',
    },
    { id: 'rural', name: '乡村人口', unit: 'region', input: true, min: 0, max: 1e9, off: 0 },
    {
      id: table,
      name: spec.name,
      unit: 'region',
      every,
      min: 0,
      max,
      off: 0,
      init: 0,
      consts: { spread: spec.spread, seep: spec.seep, fade: spec.fade, drain: spec.drain, crowd: spec.crowd },
      rate:
        `spread * (nbmean(nb.${table}) - ${table})` +
        ` + max(seep * (vein - ${table}), 0)` +
        ` - fade * ${table}` +
        ` - drain * ${table} * min(rural / crowd, 1)`,
    },
  ];
  const look = {
    title: layer.title!,
    ramp: { colors: [...layer.colors!], min: layer.min!, max: layer.max! },
    legend: layer.legend!,
    ...(layer.opacity !== undefined ? { opacity: layer.opacity } : {}),
  };
  return {
    id: spec.id,
    every,
    tables,
    inputs: { rural: 'rural' },
    influences: spec.influences.map((x) => x.target),
    layers: [{ id: spec.id, table, keep: layer.keep!, ...look }],
    act(turn) {
      const field = turn.table(table);
      const out: Record<string, Float64Array> = {};
      const polityOwner = turn.read.owners('polity');
      const polityCount = turn.read.polities().length;
      for (const inf of spec.influences) {
        const port = ports.find((p) => p.id === inf.target)!;
        const k = inf.perPoint * strength;
        const base = inf.base ?? (port.op === 'mul' ? 1 : 0);
        const R = field.length;
        if (port.unit === 'region') {
          const arr = new Float64Array(R);
          for (let r = 0; r < R; r++) arr[r] = clamp(base + field[r] * k, port.min, port.max);
          out[inf.target] = arr;
        } else {
          const sum = new Float64Array(polityCount);
          const cnt = new Float64Array(polityCount);
          for (let r = 0; r < R; r++) {
            const p = polityOwner[r];
            if (p >= 0 && p < polityCount) {
              sum[p] += field[r];
              cnt[p]++;
            }
          }
          const arr = new Float64Array(polityCount);
          for (let p = 0; p < polityCount; p++) arr[p] = clamp(base + (cnt[p] > 0 ? sum[p] / cnt[p] : 0) * k, port.min, port.max);
          out[inf.target] = arr;
        }
      }
      return { influences: out as never };
    },
  };
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

