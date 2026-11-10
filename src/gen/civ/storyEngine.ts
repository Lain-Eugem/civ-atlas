/**
 * DM 故事事件(v2 故事通道)：把 `story` 干预落到引擎里的真实状态。
 *
 * 允许的效果：
 *   - sack：某座城记一次折损(Settlement.sacks；growth.ts 里会像天灾一样慢慢恢复)；
 *   - capacity：某座城的人口上限按百分比增减(往 Settlement.reshaped 里添一段，过去的历史一点不变)；
 *   - dev：委托 boost.ts 的 strikeBoost(快 3 倍、管 years 年)；
 *   - note：纯叙事，不改引擎。
 *
 * 设计原则：DM 可以自由写"发生了什么"，但能改的只有这些能慢慢恢复/按时间线生效的局部量；
 * 不碰灭国、战争、外交、方针、地形。纯计算，不碰 DOM；不存额外内存状态(都记在城镇表里)，
 * 所以带着同一条命令从第 0 年整段重推，结果和接着推逐字节一致。
 */
import { type Intervention } from '../edits';
import { Layer, type Year } from './types';
import type { CivSim } from './engine/sim';
import type { InterventionModel } from './interventions';
import { strikeBoost, type BoostIv } from './boost';
import { capacityAt, portAt } from './growth';

export type StoryIv = Extract<Intervention, { kind: 'story' }>;

/** loss 1/2/3 对应死掉的人口比例(比天灾的 IV_LOSS 更轻，故事事件不该像大灾)。 */
const STORY_SACK_LOSS = [0.05, 0.1, 0.2] as const;

/** 人口上限的下限(千人)：别让一两条故事事件把城抹成 0。 */
const STORY_CAPACITY_MIN = 50;

/** 这条 story 干预此刻落下(interventions.ts 在生效那一刻调用；t = 事件年份)。 */
export function strikeStory(sim: CivSim, iv: InterventionModel, v: StoryIv, i: number, t: Year): void {
  const pm = iv.pm!;
  const S = pm.settlements;
  const owner = sim.owners[Layer.Polity];
  const culture = sim.owners[Layer.Culture];

  /** 事件带的国家编号(a 可选；解析不出来 = -1，只影响编年史记在哪一国名下)。 */
  let me = v.a !== undefined ? iv.resolve(v.a) : -1;
  let lastRegion = -1;
  let lastSettlement = -1;
  let applied = 0;

  /** 某座城此刻还在(没被毁、已经建起来、州里还有人烟)。 */
  const liveCity = (city: string): { sid: number; r: number } | null => {
    const sid = iv.resolveCity(city);
    if (sid < 0) return null;
    const s = S[sid];
    if (s.ended !== undefined || t < s.founded) return null;
    const r = s.region;
    if (culture[r] < 0 || pm.cityOf[r] !== sid) return null;
    return { sid, r };
  };

  for (const e of v.effects ?? []) {
    if (e.type === 'note') continue;
    if (e.type === 'dev') {
      let pol = me;
      if (pol < 0 && v.a !== undefined) {
        pol = iv.resolve(v.a);
        me = pol;
      }
      if (pol < 0) continue;
      const boost: BoostIv = { kind: 'boost', a: v.a!, from: v.from, mul: 3, until: v.from + e.years } as BoostIv;
      strikeBoost(sim, iv, boost, i, pol, t);
      applied++;
      continue;
    }
    const hit = liveCity(e.city);
    if (!hit) continue;
    const s = S[hit.sid];
    if (e.type === 'sack') {
      const loss = STORY_SACK_LOSS[e.loss - 1];
      (s.sacks ??= []).push({ year: t, loss, cause: 'famine' });
    } else {
      // capacity：按已经生效的容量算百分比，添一段 reshaped(涨要 60 年、降是当即；过去的历史不变)
      const cur = capacityAt(s, t);
      const next = Math.max(STORY_CAPACITY_MIN, Math.round(cur * (1 + e.delta / 100) * 1000) / 1000);
      (s.reshaped ??= []).push({ year: t, capacity: next, port: portAt(s, t) });
    }
    lastRegion = hit.r;
    lastSettlement = hit.sid;
    applied++;
  }

  if (me < 0 && lastRegion >= 0) me = owner[lastRegion];
  if (applied > 0) {
    sim.record('intervene', {
      a: me,
      b: applied,
      region: lastRegion,
      settlement: lastSettlement,
      war: i,
      n: v.effects?.length ?? 0,
    });
  }
}
