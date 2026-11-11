/**
 * 渗透他国:君主下 intel 命令 → 裁决层判定成败 → 结果写进命令的 result(随命令史落盘、回放一致)。
 *
 * 情报本身不改历史(引擎里 intel 只记一笔史事,见 interventions.ts);它只改变"这位君主知道什么",
 * 状态存在会话的 s.intel 里,下一轮提示词按字段级遮蔽(monarchIntel.ts 的 foreignIntel)。
 *
 * 成败判定:有 Jev 就用 Jev 的 choice 概率 + 引擎统一随机流派生的确定性抽签(pettyRoll);
 * 没有/失败就用确定性规则分布。被发觉(blown)后 5 年内再派人手必败。
 */
import { resolveKey, type Intervention } from '../src/gen/edits';
import { fieldsForResult, type IntelResult } from '../src/gen/civ/monarchIntel';
import { pickByWeight, pettyRoll } from '../src/gen/civ/petty';
import { answerWeights, askJev, type JevSettings } from './petty-client';
import type { Session } from './engine';

export type IntelCommand = Extract<Intervention, { kind: 'intel' }>;

export interface IntelResolution {
  polityId: number;
  target: number;
  focus: string;
  result: IntelResult;
  fields: string[];
  source: 'jev' | 'rule';
  reason: string;
}

/** 被发觉后几年内不能再探 */
export const INTEL_BLOWN_REST = 5;

/** 规则分布(没有 Jev 时用):全身而退并拿全 25%、只拿到人口与稳定 40%、一无所获 25%、被发觉 10% */
const RULE_WEIGHTS: [IntelResult, number][] = [
  ['full', 0.25],
  ['partial', 0.4],
  ['none', 0.25],
  ['blown', 0.1],
];

function targetOf(s: Session, v: IntelCommand): number {
  const r = resolveKey(s.civ, v.b);
  return r && r.kind === 'polity' ? r.id : -1;
}

function blownRecently(s: Session, a: number, b: number, year: number): boolean {
  const k = s.intel?.[String(a)]?.[String(b)];
  return !!k && k.quality === 'blown' && year - k.year < INTEL_BLOWN_REST;
}

function remember(s: Session, a: number, b: number, year: number, result: IntelResult, focus: string): void {
  s.intel ??= {};
  const mine = (s.intel[String(a)] ??= {});
  mine[String(b)] = { year: Math.floor(year), fields: fieldsForResult(result, focus), quality: result };
}

/**
 * 判定一批渗透命令,把 result 写回命令(返回新数组,原命令不改)。
 * 同时更新 s.intel 的知识状态。
 */
export async function resolveIntel(
  s: Session,
  commands: readonly Intervention[],
  jev: JevSettings | null,
): Promise<{ commands: Intervention[]; resolutions: IntelResolution[]; source: 'jev' | 'rule'; error?: string }> {
  const year = Math.floor(s.play.year);
  const items: { i: number; v: IntelCommand; a: number; b: number }[] = [];
  commands.forEach((v, i) => {
    if (v.kind !== 'intel') return;
    const r = resolveKey(s.civ, v.a);
    const a = r && r.kind === 'polity' ? r.id : -1;
    const b = targetOf(s, v);
    if (a >= 0 && b >= 0) items.push({ i, v, a, b });
  });
  if (!items.length) return { commands: [...commands], resolutions: [], source: jev ? 'jev' : 'rule' };

  const out = [...commands];
  const resolutions: IntelResolution[] = [];
  const apply = (it: (typeof items)[number], result: IntelResult, source: 'jev' | 'rule', reason: string) => {
    const fields = fieldsForResult(result, it.v.focus ?? 'all');
    out[it.i] = { ...it.v, result };
    remember(s, it.a, it.b, year, result, it.v.focus ?? 'all');
    resolutions.push({ polityId: it.a, target: it.b, focus: it.v.focus ?? 'all', result, fields, source, reason });
  };

  // 冷却期里的直接判败,不问 Jev
  const ask: typeof items = [];
  for (const it of items) {
    if (blownRecently(s, it.a, it.b, year)) apply(it, 'none', 'rule', `上次被发觉,${INTEL_BLOWN_REST} 年内不宜再派`);
    else ask.push(it);
  }
  if (!ask.length) return { commands: out, resolutions, source: jev ? 'jev' : 'rule' };

  if (jev) {
    const questions: Record<string, unknown> = {};
    for (const it of ask) {
      questions[`intel_${it.a}_${it.b}`] = {
        type: 'choice',
        instructions: `第 ${year} 年,P${it.a} 的君主派人渗透到 P${it.b},想打探${it.v.focus === 'tax' ? '税收账目' : it.v.focus === 'pop' ? '人口' : it.v.focus === 'stability' ? '稳定度' : '人口、稳定度与税收'}。这次渗透的结果如何?`,
        criteria: {
          full: '顺利:拿到了想要的全部情况(含税收账目)',
          partial: '有收获但不全:只拿到人口与稳定度,没摸到账目',
          none: '一无所获:探子没接触到有用的消息',
          blown: '被发觉:对方起了戒心,这几年不宜再派',
        },
      };
    }
    try {
      const reply = await askJev(questions as never, `第 ${year} 年的${ask.length} 次渗透。`, jev, { sessionId: `${s.id}-intel-${s.rounds}` });
      for (const it of ask) {
        const ans = reply.answers[`intel_${it.a}_${it.b}`];
        const w = ans ? answerWeights(ans) : {};
        const roll = pettyRoll(s.civ.seed, year, it.a, it.b);
        const picked = pickByWeight(Object.entries(w), roll) as IntelResult;
        const result: IntelResult = picked === 'full' || picked === 'partial' || picked === 'none' || picked === 'blown' ? picked : 'none';
        apply(it, result, 'jev', `Jev 概率 ${JSON.stringify(w)} → 抽签 ${roll.toFixed(3)} = ${result}`);
      }
      return { commands: out, resolutions, source: 'jev' };
    } catch (e) {
      for (const it of ask) {
        const roll = pettyRoll(s.civ.seed, year, it.a, it.b);
        apply(it, pickByWeight(RULE_WEIGHTS, roll) as IntelResult, 'rule', `Jev 不可用,按确定性规则抽签(${roll.toFixed(3)})`);
      }
      return { commands: out, resolutions, source: 'rule', error: e instanceof Error ? e.message : String(e) };
    }
  }

  for (const it of ask) {
    const roll = pettyRoll(s.civ.seed, year, it.a, it.b);
    apply(it, pickByWeight(RULE_WEIGHTS, roll) as IntelResult, 'rule', `无 Jev,按确定性规则抽签(${roll.toFixed(3)})`);
  }
  return { commands: out, resolutions, source: 'rule' };
}
