/**
 * 小事件裁决层(v2)：把 `petty` 干预落到引擎里的真实状态。
 *
 * 两种效果：
 *   - sack：某座城记一次折损(Settlement.sacks；growth.ts 里会像天灾一样慢慢恢复)，
 *     不额外写 famine 史事，避免小事件天天上编年史；
 *   - dev：委托 boost.ts 的 strikeBoost(快 3 倍、管 years 年)。
 *
 * 设计原则：小事件只改"能慢慢恢复的局部量"，不碰灭国/战争/外交/方针。
 * 纯计算，不碰 DOM；不存额外内存状态(折损在城镇表里，接着推和一口气推一致)。
 */
import { regionOfKey, type Intervention } from '../edits';
import { Layer, type Year } from './types';
import type { CivSim } from './engine/sim';
import type { InterventionModel } from './interventions';
import { strikeBoost, type BoostIv } from './boost';

export type PettyIv = Extract<Intervention, { kind: 'petty' }>;

/** loss 1/2/3 对应死掉的人口比例(比天灾的 IV_LOSS 更轻，小事件不该像大灾)。 */
const PETTY_SACK_LOSS = [0.05, 0.1, 0.2] as const;

/** 这条 petty 干预此刻落下(interventions.ts 在生效那一刻调用；a = 国家编号)。 */
export function strikePetty(sim: CivSim, iv: InterventionModel, v: PettyIv, i: number, a: number, t: Year): void {
  const pm = iv.pm!;
  const S = pm.settlements;
  const owner = sim.owners[Layer.Polity];
  const culture = sim.owners[Layer.Culture];
  const R = pm.terrain.R;

  /** 州 r 此刻有人烟的城(没有 = -1) */
  const cityNow = (r: number): number => {
    const sid = pm.cityOf[r];
    if (sid < 0 || culture[r] < 0) return -1;
    const s = S[sid];
    return s.ended === undefined && t >= s.founded ? sid : -1;
  };

  if (v.effect.type === 'dev') {
    // 委托 boost：快 3 倍、管 years 年；史事由 strikeBoost 记(intervene)
    const boost: BoostIv = { kind: 'boost', a: v.a, from: v.from, mul: 3, until: v.from + v.effect.years } as BoostIv;
    const me = a >= 0 ? a : iv.resolve(v.a);
    if (me < 0) return;
    strikeBoost(sim, iv, boost, i, me, t);
    return;
  }

  // sack：定一座城(或一个州，取州里此刻的城)
  let r = -1;
  if (v.effect.city !== undefined) {
    const sid = iv.resolveCity(v.effect.city);
    r = sid >= 0 ? S[sid].region : -1;
  } else if (v.effect.region !== undefined) {
    r = regionOfKey(v.effect.region, iv.of);
  }
  if (r < 0 || r >= R) {
    sim.record('intervene', { a: -1, b: 0, region: -1, settlement: -1, war: i });
    return;
  }
  const sid = cityNow(r);
  if (sid < 0) {
    sim.record('intervene', { a: owner[r], b: 0, region: r, settlement: -1, war: i });
    return;
  }
  const loss = PETTY_SACK_LOSS[v.effect.loss - 1];
  (S[sid].sacks ??= []).push({ year: t, loss, cause: 'famine' });
  sim.record('intervene', { a: owner[r], b: 1, region: r, settlement: sid, war: i, n: v.effect.loss });
}
