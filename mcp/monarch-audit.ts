/**
 * 君主决策的合理性审核:高影响命令交给 Jev,其余交给玩家 / DM(复核模式)。
 *
 * 三层护栏,顺序不能反:
 *   1. 引擎硬校验(compileMonarchOrders:在世/接壤/参数)——永远先跑,本模块之前已完成;
 *   2. 角色卡规则(auditByRule):按性格与能力做确定性的便宜判断,Jev 不可达时也靠它;
 *   3. Jev 概率审核(choice: fit / stretch / beyond),按阈值落成 放行 / 降级 / 退回。
 *
 * Jev 只给概率,不给"禁令";阈值全在这里,写进日志可复现。Jev 失败/超时 → 整批退回规则审核,
 * 绝不阻塞回合(与小事件裁决层的降级策略一致)。审核只改"哪些命令进引擎",不改引擎语义。
 */
import type { Intervention } from '../src/gen/edits';
import { monarchOrderText, type MonarchBrief } from '../src/gen/civ/monarch';
import type { MonarchCard } from '../src/gen/civ/monarchCard';
import { answerWeights, askJev, type JevSettings } from './petty-client';
import type { Session } from './engine';

/** 只有这些命令要过 Jev;其余由玩家 / DM 在复核界面决定 */
export const HIGH_IMPACT_KINDS: ReadonlySet<string> = new Set(['declare', 'press', 'destroy', 'cede']);

export type AuditOutcome = 'allow' | 'soften' | 'reject';

export interface AuditVerdict {
  polityId: number;
  /** 在该国本回合命令里的下标 */
  index: number;
  kind: string;
  outcome: AuditOutcome;
  source: 'jev' | 'rule';
  reason: string;
  probabilities?: Record<string, number>;
}

export interface AuditEntry {
  polityId: number;
  brief: MonarchBrief;
  card: MonarchCard;
  commands: Intervention[];
}

/** 阈值:p(beyond) ≥ REJECT 退回;p(fit) ≥ ALLOW 放行;其余降级 */
export const AUDIT_THRESHOLD = { allowFit: 0.55, rejectBeyond: 0.35 };

export function isHighImpact(v: Intervention): boolean {
  return HIGH_IMPACT_KINDS.has(v.kind);
}

/** 降级成什么:宣战 → 守成;坚持打 → 停止扩张 */
export function softenCommand(kind: string): unknown {
  if (kind === 'press') return { kind: 'halt' };
  return { kind: 'policy', preset: 'hold' };
}

/** 规则审核(确定性;Jev 不在时也是它) */
export function auditByRule(entry: AuditEntry, index: number): AuditVerdict {
  const v = entry.commands[index]!;
  const c = entry.card;
  const base = { polityId: entry.polityId, index, kind: v.kind, source: 'rule' as const };
  const sizes = entry.brief.neighbors.map((n) => n.size);
  if (v.kind === 'declare') {
    const bigger = sizes.some((s) => s > entry.brief.size * 1.5);
    if (c.preferences.war === 'avoid' && c.traits.caution >= 60) {
      return { ...base, outcome: 'soften', reason: `他${c.preferences.war === 'avoid' ? '不好战' : ''}且谨慎(${c.traits.caution}),主动宣战不像他会做的事` };
    }
    if (bigger && c.traits.caution >= 70 && c.competence.war === 0) {
      return { ...base, outcome: 'soften', reason: '邻国里有比本国大一半的,而他用兵不行又谨慎' };
    }
  }
  if (v.kind === 'press' && c.preferences.war === 'avoid') {
    return { ...base, outcome: 'soften', reason: '他偏好避战,坚持打到底不符合角色' };
  }
  return { ...base, outcome: 'allow', reason: '规则审核:未见与角色冲突' };
}

function auditQuestionKey(polityId: number, index: number): string {
  return `audit_p${polityId}_${index}`;
}

function commandFacts(entry: AuditEntry, v: Intervention): string {
  const c = entry.card;
  return [
    `君主:${c.name};性格 谨慎${c.traits.caution}/野心${c.traits.ambition}/荣誉${c.traits.honor};`,
    `偏好战争=${c.preferences.war};能力 用兵${c.competence.war}/密谋${c.competence.intrigue};`,
    `本国 ${entry.brief.size} 州,邻国 ${entry.brief.neighbors.map((n) => `P${n.id}(${n.size}州)`).join('、') || '无'};`,
    `命令:${v.kind} ${JSON.stringify(v).slice(0, 200)}`,
  ].join('');
}

/**
 * 审一批君主的命令。返回 verdict 表(key = `${polityId}:${index}`),只含高影响命令。
 * jev 给了才走 Jev;没给/失败 = 规则审核。
 */
export async function auditMonarchCommands(
  s: Session,
  entries: readonly AuditEntry[],
  jev: JevSettings | null,
): Promise<{ verdicts: Map<string, AuditVerdict>; source: 'jev' | 'rule'; error?: string }> {
  const verdicts = new Map<string, AuditVerdict>();
  const pending: { entry: AuditEntry; index: number; key: string }[] = [];
  for (const entry of entries) {
    entry.commands.forEach((v, index) => {
      if (!isHighImpact(v)) return;
      const key = `${entry.polityId}:${index}`;
      if (!jev) verdicts.set(key, auditByRule(entry, index));
      else pending.push({ entry, index, key });
    });
  }
  if (!pending.length) return { verdicts, source: jev ? 'jev' : 'rule' };
  if (!jev) return { verdicts, source: 'rule' };

  const questions: Record<string, unknown> = {};
  for (const p of pending) {
    questions[auditQuestionKey(p.entry.polityId, p.index)] = {
      type: 'choice',
      instructions:
        '判断这位君主的这条命令是否符合"他这个人"的身份、性格与能力(不是判断对不对国家有利)。' + commandFacts(p.entry, p.entry.commands[p.index]!),
      criteria: {
        fit: '符合:像他这样的人会想到、也办得到',
        stretch: '勉强:有点出格,但可以说得通',
        beyond: '超出:完全不像他会做的事,或超出他的判断能力',
      },
    };
  }
  const state = `第 ${Math.floor(s.play.year)} 年,共 ${pending.length} 条高影响命令待审核。审核只看"是否符合角色",不看战略优劣。`;
  try {
    const reply = await askJev(questions as never, state, jev, { sessionId: `${s.id}-audit-${s.rounds}` });
    for (const p of pending) {
      const ans = reply.answers[auditQuestionKey(p.entry.polityId, p.index)];
      const w = ans ? answerWeights(ans) : {};
      const fit = w.fit ?? 0;
      const beyond = w.beyond ?? 0;
      // 没有概率时按模型选中的选项算(answerWeights 已退化);抽签只用于没有明确概率的边角
      const outcome: AuditOutcome = beyond >= AUDIT_THRESHOLD.rejectBeyond ? 'reject' : fit >= AUDIT_THRESHOLD.allowFit ? 'allow' : 'soften';
      verdicts.set(p.key, {
        polityId: p.entry.polityId,
        index: p.index,
        kind: p.entry.commands[p.index]!.kind,
        outcome,
        source: 'jev',
        probabilities: w,
        reason: `fit ${fit.toFixed(2)} / stretch ${(w.stretch ?? 0).toFixed(2)} / beyond ${beyond.toFixed(2)}(fit≥${AUDIT_THRESHOLD.allowFit} 放行,beyond≥${AUDIT_THRESHOLD.rejectBeyond} 退回,其余降级)`,
      });
    }
    return { verdicts, source: 'jev' };
  } catch (e) {
    for (const p of pending) verdicts.set(p.key, auditByRule(p.entry, p.index));
    return { verdicts, source: 'rule', error: e instanceof Error ? e.message : String(e) };
  }
}

/** 给界面看的简短说明 */
export function auditText(v: AuditVerdict): string {
  const label = v.outcome === 'allow' ? '放行' : v.outcome === 'soften' ? '降级' : '退回';
  return `${label}(${v.source === 'jev' ? 'Jev' : '规则'})：${v.reason}`;
}

/** 简报里的命令原文(日志用) */
export function auditCommandText(brief: MonarchBrief, v: Intervention, civ: Session['civ']): string {
  return monarchOrderText(civ, v);
}
