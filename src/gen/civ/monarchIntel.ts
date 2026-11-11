/**
 * 君主能看到的"数字":本国逐州属性 + 他国情报(字段级遮蔽)。
 *
 * 纯计算,不碰 DOM。两类口径必须分清:
 *   - 真值:人口(regionPopulationAt)、乡村容量(ruralCapacity)、五种能力(developmentAt)、控制度(controlAt)、国家账本(fiscalAt);
 *   - 推算:逐州税收(国家账本按人口分摊)、稳定度(控制档位 − 近 20 年战乱/灾荒)、产粮能力(乡村容量 × 生产能力)。
 * 推算字段在结构上带 derived 标记,提示词与界面都写"估算",不当成引擎事实。
 *
 * 情报遮蔽:没有渗透过 = 只有公开的州数;渗透成功才按 result 给字段(full 含税收,partial 只有人口与稳定);
 * 超过 INTEL_STALE_YEARS 年的情报标"陈旧",由调用方决定是否再派人。
 */
import type { Civ } from './types';
import { ownersAt } from '../readers/openQuery';
import { polityName } from './growth';
import { regionPopulationAt, ruralCapacity } from './growth';
import { controlAt, controlShare, controlTier, CONTROL_TIERS, LORD_BYTE } from './control';
import { knobSet } from './knobs';
import { developmentAt } from './development';
import { CAPS } from './inventions';
import { fiscalAt } from './fiscalBook';

/** 情报过几年算陈旧 */
export const INTEL_STALE_YEARS = 10;
/** 逐州表最多逐行列几州,其余汇总 */
export const REGION_ROWS_MAX = 10;

export interface RegionRow {
  region: number;
  name: string;
  /** 人口(千人),真值 */
  pop: number;
  /** 产粮能力(千人当量,推算:乡村容量 × 生产能力) */
  food: number;
  foodDerived: true;
  /** 税收(国家账本按人口分摊,推算);没有账本 = null */
  tax: number | null;
  taxDerived: true;
  /** 稳定度 0–100(推算:控制档位 − 近 20 年战乱/灾荒);不在国家里 = null */
  stability: number | null;
  stabilityDerived: true;
  /** 控制档位名(直辖/代管/自治/割据) */
  control: string;
  /** 生产能力档(真值,developmentAt 的第 0 样) */
  prod: number;
}

export interface RegionTable {
  polityId: number;
  year: number;
  rows: RegionRow[];
  /** 没逐行列出的那些州的汇总 */
  others: { count: number; pop: number; tax: number | null };
  total: { count: number; pop: number; food: number; tax: number | null; stability: number | null };
  note: string;
}

function ownerAt(civ: Civ, year: number): Int16Array {
  return year >= civ.endYear ? civ.polity : ownersAt(civ, year).polity;
}

/** 近 20 年各州的战乱/灾荒扣分(史事里带 region 的才算) */
function regionPenalties(civ: Civ, year: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const e of civ.annals) {
    if (e.year < year - 20 || e.year > year) continue;
    if (e.region < 0) continue;
    if (e.kind !== 'war' && e.kind !== 'famine' && e.kind !== 'plague' && e.kind !== 'revolt' && e.kind !== 'sack') continue;
    out.set(e.region, Math.min(45, (out.get(e.region) ?? 0) + 15));
  }
  return out;
}

function stabilityOf(control: Uint8Array | null, penalties: Map<number, number>, knobs: ReturnType<typeof knobSet>, r: number): { value: number | null; tier: string } {
  if (!control) return { value: null, tier: '未知' };
  const v = control[r] ?? 0;
  if (v === 0) return { value: null, tier: '不在国家里' };
  const tierName = CONTROL_TIERS[controlTier(knobs, v)] ?? '自治';
  const share = v === LORD_BYTE ? 0 : controlShare(v);
  const base = Number.isFinite(share) ? share * 100 : 50;
  return { value: Math.max(0, Math.min(100, Math.round(base - (penalties.get(r) ?? 0)))), tier: tierName };
}

/** 国家账本里的三项税(田赋 + 工商 + 市税);没有账本 = null */
function taxTotalOf(civ: Civ, polityId: number, year: number): number | null {
  const row = fiscalAt(civ, polityId, year);
  if (!row) return null;
  const t = row.values['田赋'] + row.values['工商'] + row.values['市税'];
  return Number.isFinite(t) ? t : null;
}

/** 本国在第 year 年的逐州属性表 */
export function regionTable(civ: Civ, polityId: number, year: number, opts: { maxRows?: number } = {}): RegionTable {
  const Y = Math.floor(year);
  const own = ownerAt(civ, Y);
  const R = civ.regions.count;
  const knobs = knobSet(civ.knobs);
  const control = controlAt(civ, Y);
  const penalties = regionPenalties(civ, Y);
  const lv = civ.development ? developmentAt(civ.development, Y) : null;
  const taxTotal = taxTotalOf(civ, polityId, Y);

  const owned: number[] = [];
  for (let r = 0; r < R; r++) if (own[r] === polityId) owned.push(r);
  const pops = owned.map((r) => regionPopulationAt(civ, r, Y));
  const popSum = pops.reduce((a, b) => a + b, 0);

  const rows: RegionRow[] = owned.map((r, i) => {
    const pop = pops[i]!;
    const prod = lv ? lv[r * CAPS.length]! : 0;
    const st = stabilityOf(control, penalties, knobs, r);
    return {
      region: r,
      name: civ.regions.name?.[r] || `第 ${r} 州`,
      pop: Math.round(pop),
      food: Math.round(ruralCapacity(civ.regions, r) * (1 + prod)),
      foodDerived: true as const,
      tax: taxTotal !== null && popSum > 0 ? Math.round((taxTotal * pop) / popSum) : null,
      taxDerived: true as const,
      stability: st.value,
      stabilityDerived: true as const,
      control: st.tier,
      prod: Math.round(prod * 10) / 10,
    };
  });
  rows.sort((a, b) => b.pop - a.pop || a.region - b.region);

  const maxRows = Math.max(1, Math.min(30, Math.round(opts.maxRows ?? REGION_ROWS_MAX)));
  const shown = rows.slice(0, maxRows);
  const rest = rows.slice(maxRows);
  const sum = (list: RegionRow[], f: (x: RegionRow) => number) => list.reduce((a, x) => a + f(x), 0);
  const stabValues = rows.map((r) => r.stability).filter((v): v is number => v !== null);
  return {
    polityId,
    year: Y,
    rows: shown,
    others: {
      count: rest.length,
      pop: sum(rest, (r) => r.pop),
      tax: taxTotal === null ? null : sum(rest, (r) => r.tax ?? 0),
    },
    total: {
      count: rows.length,
      pop: sum(rows, (r) => r.pop),
      food: sum(rows, (r) => r.food),
      tax: taxTotal,
      stability: stabValues.length ? Math.round(stabValues.reduce((a, b) => a + b, 0) / stabValues.length) : null,
    },
    note: '人口/控制档位/生产能力为引擎真值;产粮能力、逐州税收、稳定度为推算(税收按人口从国家账本分摊,稳定度 = 控制档位 − 近 20 年战乱灾荒)。',
  };
}

/** 逐州表的提示词文本(top-N + 其余汇总) */
export function formatRegionTable(t: RegionTable): string {
  const out: string[] = [`## 你的领土(第 ${t.year} 年,共 ${t.total.count} 州)`];
  out.push('州 | 人口(千) | 产粮能力(估) | 税收(估) | 稳定度(估) | 管辖');
  for (const r of t.rows) {
    out.push(`${r.name} | ${r.pop} | ${r.food} | ${r.tax === null ? '无账本' : r.tax} | ${r.stability === null ? '—' : r.stability} | ${r.control}`);
  }
  if (t.others.count) out.push(`其余 ${t.others.count} 州合计:人口 ${t.others.pop} 千,税收(估)${t.others.tax ?? '无账本'}`);
  out.push(`全国合计:人口 ${t.total.pop} 千,产粮能力(估)${t.total.food},税收(估)${t.total.tax ?? '无账本'},平均稳定度(估)${t.total.stability ?? '—'}`);
  out.push('注:带"估"的是推算值,不是精确账目;你没有逐州的精确密账。');
  return out.join('\n');
}

export type IntelField = 'pop' | 'stability' | 'tax';
export type IntelResult = 'none' | 'partial' | 'full' | 'blown';

/** 一次渗透的结果能拿到哪几样:full 含税收,partial 只有人口与稳定 */
export function fieldsForResult(result: IntelResult, focus?: string): IntelField[] {
  if (result === 'full') return focus === 'pop' ? ['pop'] : focus === 'stability' ? ['stability'] : focus === 'tax' ? ['tax'] : ['pop', 'stability', 'tax'];
  if (result === 'partial') return focus === 'tax' ? [] : focus === 'pop' ? ['pop'] : focus === 'stability' ? ['stability'] : ['pop', 'stability'];
  return [];
}

export interface IntelKnowledge {
  /** 情报是哪一年拿到的 */
  year: number;
  fields: IntelField[];
  quality: IntelResult;
}

export interface ForeignIntel {
  polityId: number;
  name: string;
  /** 公开信息:有几州 */
  size: number;
  known: boolean;
  year?: number;
  stale?: boolean;
  pop?: number;
  stability?: number | null;
  tax?: number | null;
  note: string;
}

/** 他国情报(按 knowledge 遮蔽字段;没有 = 只有公开州数) */
export function foreignIntel(civ: Civ, targetId: number, year: number, known?: IntelKnowledge): ForeignIntel {
  const Y = Math.floor(year);
  const own = ownerAt(civ, Y);
  const R = civ.regions.count;
  const p = civ.polities[targetId];
  const name = p ? polityName(p, Y) : `P${targetId}`;
  const owned: number[] = [];
  for (let r = 0; r < R; r++) if (own[r] === targetId) owned.push(r);
  const base: ForeignIntel = { polityId: targetId, name, size: owned.length, known: false, note: '未派人渗透,只有公开消息' };
  if (!known || known.quality === 'none' || known.quality === 'blown' || !known.fields.length) return base;

  const knobs = knobSet(civ.knobs);
  const control = controlAt(civ, Y);
  const penalties = regionPenalties(civ, Y);
  const out: ForeignIntel = {
    ...base,
    known: true,
    year: known.year,
    stale: Y - known.year > INTEL_STALE_YEARS,
    note: known.quality === 'partial' ? '探子只拿到人口与稳定,没摸到账目' : '探子带回了账目',
  };
  if (known.fields.includes('pop')) out.pop = Math.round(owned.reduce((a, r) => a + regionPopulationAt(civ, r, Y), 0));
  if (known.fields.includes('stability')) {
    const vals = owned.map((r) => stabilityOf(control, penalties, knobs, r).value).filter((v): v is number => v !== null);
    out.stability = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  }
  if (known.fields.includes('tax')) out.tax = taxTotalOf(civ, targetId, Y);
  return out;
}

/** 他国情报的提示词一行 */
export function formatForeignIntel(f: ForeignIntel): string {
  if (!f.known) return `- P${f.polityId} ${f.name}:${f.size} 州(公开);人口/税收/稳定度未知 —— ${f.note}`;
  const parts = [
    f.pop === undefined ? '人口未知' : `人口约 ${f.pop} 千`,
    f.stability === undefined ? '稳定度未知' : `稳定度(估)${f.stability ?? '—'}`,
    f.tax === undefined ? '税收未知' : `税收(估)${f.tax ?? '无账本'}`,
  ];
  const stamp = f.stale ? `(第 ${f.year} 年的旧情报,可能已变)` : `(第 ${f.year} 年)`;
  return `- P${f.polityId} ${f.name}:${f.size} 州;${parts.join(',')}${stamp}`;
}
