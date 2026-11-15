/**
 * 推一把发展(干预 boost,字段见 gen/edits.ts 文件头的表):作者让一国(或几州)从某年起发展快几倍,或者直接进下一个时代。
 *   快几倍(mul = 3 / 10):from 到 until(不含)这些年里,那些州四样能力(生产、运输、信息、行政)的"自己长"和"向邻居学"都 × mul
 *     (发展度的输入表「推」,development.ts 每步按这一步里管了几成折算;动员跟着生产、行政走)。整国 = 每一步那一刻归这国的州
 *     (新打下的也推、丢了的不推);几州 = 只推这几州(换了主也照推)。跨时代的门槛照旧:卡在门口(缺物产、组织、太平、地理)时
 *     自己长不乘(和没推一样慢),乘出来的那一截也至多长到门口;生产到了门口、缺下一个时代要的物产的州四样能力都不乘(自己长、向邻居学
 *     都照常慢,等邻居传过来)。前后接着下的几条按一步里各段管了多久合起来算(和一条管到底的一样)。到期以后照常长,长上去的不退。
 *     和方针的发展重点相乘。
 *   直接进(没有 mul):from 那一刻以这国国都所在州的时代为准,进它的下一个时代 —— 治下各州(几州 = 那几州)四样能力都拉到
 *     那个时代开头(本来就在或更高的不动;development.ts 的 jumpEra),不看物产等门槛;国都已在最后一个时代 = 不生效。
 *     带出来的"始入某时代""为天下之先"、发明、发现大矿都记在这一刻。
 *
 * 史事:intervene,a = 国家,b = −1 生效了 / −3 那一年这国已亡 / IV_TOP_ERA 直接进时国都已在最后一个时代;
 *   region / settlement = 国都所在州 / 国都(几州 = 那几州里城最大的一州 / 它的城);
 *   n = 推了几州 × BOOST_N + 直接进到第几个时代(快几倍 = 0;推了几州:快几倍是生效那一刻的州数)。
 * 不存内存状态:管着的快几倍由史事 intervene 推出来(installBoosts),接着推和一口气推完一样。纯计算,不碰 DOM。
 */
import { keyCells, regionOfKey, type Intervention } from '../edits';
import { Layer, type Year } from './types';
import type { CivSim } from './engine/sim';
import type { InterventionModel } from './interventions';
import type { PolityModel } from './polities';
import { capitalAt, populationAt } from './growth';
import { ERAS, devModelOf, eraNowAt, jumpEra } from './development';
import { civApi } from './api';

export type BoostIv = Extract<Intervention, { kind: 'boost' }>;

/** 史事 intervene 的 b:直接进时国都已在最后一个时代,没有下一个了 */
export const IV_TOP_ERA = -17;
/** 史事 intervene 的 n = 推了几州 × BOOST_N + 直接进到第几个时代 */
export const BOOST_N = 16;
/** 小事件 / 故事事件的 dev 委托"快 3 倍"的倍数(pettyEngine / storyEngine 和回放重建都用这一个) */
export const DEV_BOOST_MUL = 3;

/** 管着的一条快几倍:哪国(几州的 = 那几州)、哪几年、几倍 */
interface BoostSeg {
  p: number;
  regions: number[] | null;
  from: Year;
  until: Year;
  mul: number;
}

const segsOf = new WeakMap<CivSim, BoostSeg[]>();

/** 几州的州键 → 这份地形里的州号(去重、指不到的去掉,升序) */
function regionsOf(keys: readonly string[], of: ArrayLike<number>, R: number): number[] {
  return [...new Set(keys.map((k) => regionOfKey(k, of)).filter((r) => r >= 0 && r < R))].sort((x, y) => x - y);
}

function segOf(v: BoostIv, p: number, pm: PolityModel): BoostSeg | null {
  if (v.mul === undefined || v.until === undefined) return null;
  return { p, regions: v.regions ? regionsOf(v.regions, keyCells(pm.terrain.regions), pm.terrain.R) : null, from: v.from, until: v.until, mul: v.mul };
}

/**
 * 挂上推一把发展(interventions.ts 的 installInterventions 调用;一口气推和接着推都走这里):已经生效的快几倍按史事 intervene 推出来,
 * 发展度每一步按它们填「推」。列表里没有快几倍的什么都不挂(没下这条干预的世界逐字节不变)
 */
export function installBoosts(sim: CivSim, iv: InterventionModel): void {
  const api = civApi(sim);
  const d = devModelOf(sim);
  const pm = iv.pm;
  // 快几倍除了直接的 boost 干预,还有 story / petty 把 dev 托给 boost 的:它们史事里的 war 指向 story / petty
  // (不是 boost 干预),靠史事自带的 until 重建。没有这两类快几倍的世界什么都不挂,逐位不变
  const hasMul = iv.list.some((v) => (v.kind === 'boost' && v.mul !== undefined) ||
    (v.kind === 'petty' && v.effect.type === 'dev') ||
    (v.kind === 'story' && (v.effects ?? []).some((x) => x.type === 'dev')));
  if (!d || !pm || !hasMul) return;
  const segs: BoostSeg[] = [];
  for (let k = 0; k < sim.annalCount; k++) {
    const e = sim.annal(k);
    if (e.kind !== 'intervene' || e.b !== -1) continue;
    const v = iv.list[e.war];
    if (v?.kind === 'boost') {
      const s = segOf(v, e.a, pm);
      if (s) segs.push(s);
    } else if (e.until !== undefined && v !== undefined &&
      ((v.kind === 'petty' && v.effect.type === 'dev') ||
        (v.kind === 'story' && (v.effects ?? []).some((x) => x.type === 'dev')))) {
      // dev 委托:整国、快 3 倍、从史事那一年到 until,和 strikeBoost 当时 push 的那一段逐位一致
      segs.push({ p: e.a, regions: null, from: e.year, until: e.until, mul: DEV_BOOST_MUL });
    }
  }
  segsOf.set(sim, segs);
  // 一步里各州的倍数:这一步按各条的起止切成几段,每段取管着这州的最大倍数,再按各段占这一步的几成加起来
  // (前后接着下的几条和一条管到底的一样;同时管着的几条取大的,不叠乘)
  api.dev.boostFill = (t0, y, out) => {
    const dt = y - t0;
    const act = segs.filter((s) => Math.min(y, s.until) > Math.max(t0, s.from));
    if (!act.length) return;
    const cut = [...new Set([t0, y, ...act.flatMap((s) => [s.from, s.until]).filter((t) => t > t0 && t < y)])].sort((a, b) => a - b);
    const best = new Map<number, number>();
    for (let k = 0; k + 1 < cut.length; k++) {
      const a = cut[k];
      const b = cut[k + 1];
      best.clear();
      for (const s of act) {
        if (!(s.from <= a && s.until >= b)) continue;
        const rs = s.regions ?? (pm.polities[s.p]?.ended === undefined ? (pm.lands[s.p] ?? []) : []);
        for (const r of rs) if (r < out.length && s.mul > (best.get(r) ?? 1)) best.set(r, s.mul);
      }
      const w = (b - a) / dt;
      for (const [r, m] of best) out[r] += (m - 1) * w;
    }
  };
}

/**
 * 推一把发展此刻生效(interventions.ts 在 from 那一刻调用;a = 国家此刻的编号,第 i 条干预)。史事见文件头。
 * devUntil:story / petty 委托 dev 时才传(快几倍的到期年份),把生效区间记进史事的 until 列,接着推时
 * installBoosts 只凭这一条就能重建出同一段;普通 boost 不传,史事逐位不变(既有世界指纹不动)。
 */
export function strikeBoost(sim: CivSim, iv: InterventionModel, v: BoostIv, i: number, a: number, t: Year, devUntil?: number): void {
  const pm = iv.pm!;
  const S = pm.settlements;
  const R = pm.terrain.R;
  const P = pm.polities[a];
  const alive = P.ended === undefined;
  const sid = capitalAt(P, t);
  const capR = S[sid]?.region ?? -1;
  const culture = sim.owners[Layer.Culture];
  const regions = v.regions ? regionsOf(v.regions, iv.of, R) : alive ? pm.lands[a].slice() : [];
  // 史事记哪一州:整国 = 国都;几州 = 那几州里城最大的一州(都没城 = 头一州)
  let at = capR;
  let city = sid;
  if (v.regions) {
    at = regions[0] ?? -1;
    city = at >= 0 ? pm.cityOf[at] : -1;
    let most = -1;
    for (const r of regions) {
      const c = pm.cityOf[r];
      const s = c >= 0 ? S[c] : undefined;
      if (!s || s.ended !== undefined || culture[r] < 0) continue;
      const n = populationAt(s, t);
      if (n > most) {
        most = n;
        at = r;
        city = c;
      }
    }
  }
  const rec = (b: number, n = 0, until?: number) => sim.record('intervene', { a, b, region: at, settlement: city, war: i, n, ...(until !== undefined ? { until } : {}) });
  if (!alive) return rec(-3);
  if (v.mul !== undefined) {
    rec(-1, regions.length * BOOST_N, devUntil);
    const s = segOf(v, a, pm);
    if (s) segsOf.get(sim)?.push(s);
    return;
  }
  // 直接进:以国都所在州的时代为准,进下一个
  const now = eraNowAt(sim, capR);
  const target = Math.floor(now) + 1;
  if (capR < 0 || now < 0 || target >= ERAS.length) return rec(IV_TOP_ERA);
  const n = jumpEra(sim, regions, target, capR, t);
  rec(-1, n * BOOST_N + target);
}
