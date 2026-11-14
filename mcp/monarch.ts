/**
 * 任务二:君主回合循环(会话层编排)。
 *
 * 引擎本身不暂停、不知道 LLM:这里在年份边界用 playTurn 停一下,
 * 把每个在世国家的简报发外部模型(或 mock),把决策编译成引擎命令,
 * 统一交给同一次 turnStep,再写回合日志。
 *
 * 设计约束(对应用户要求):
 * - 不阻塞推演:引擎调用是同步的、很快;LLM 请求都在这里异步等待,推演线程/进程不在等网络。
 * - 不改确定性:同一份世界 + 同一串命令,引擎结果与"一口气推"一致(见 verifySession 回放)。
 * - 参数不写死:国家数、回合年数、服务商、模型、Key、温度全部由工具参数/环境变量给。
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { playCiv, playTurn } from '../src/gen/civ/play';
import type { Civ } from '../src/gen/civ/types';
import type { Intervention, PlayState } from '../src/gen/edits';
import {
  aliveMonarchs,
  buildMonarchBriefs,
  compileMonarchOrders,
  pickMonarchIds,
  MONARCH_MAX_COUNTRIES,
  MONARCH_MAX_ORDERS,
  type MonarchBrief,
  type MonarchReject,
} from '../src/gen/civ/monarch';
import {
  civHash,
  nationControlOf,
  submitOrders,
  turnStep,
  worldIdOf,
  type Session,
  type TurnResult,
} from './engine';
import {
  askLlm,
  mockDecision,
  parseDecision,
  providerSettings,
  providerView,
  type LlmProviderInput,
  type LlmProviderSettings,
  type ParsedDecision,
} from './llm';
import { decideDm, type DmDecisionOutcome } from './dm';
import { pettyDigest, pettyRuntime, settlePetty, type PettySettlement } from './petty';
import { monarchMessages } from './prompt';
import { cardIsCurrent, cleanCardInput, monarchCard } from '../src/gen/civ/monarchCard';
import { addMemory, cleanMemoryWrites, deriveEngineMemories, memoryBook, type MemoryEntry } from '../src/gen/civ/monarchMemory';
import { foreignIntel, regionTable } from '../src/gen/civ/monarchIntel';
import { auditMonarchCommands, softenCommand, type AuditEntry, type AuditVerdict } from './monarch-audit';
import { resolveIntel, type IntelResolution } from './intel';
import type { JevSettings } from './petty-client';

export interface MonarchRunConfig {
  polities: 'all' | number[] | number;
  maxOrders: number;
  mock: boolean;
  provider: LlmProviderSettings;
}

export interface MonarchSetupInput extends LlmProviderInput {
  /** 'all' = 全部在世国家;number = 前 N 个大国;number[] = 指定编号 */
  polities?: 'all' | number | number[];
  maxOrders?: number;
  mock?: boolean;
}

export interface MonarchSetupResult {
  sessionId: string;
  year: number;
  mode: string;
  config: Record<string, unknown>;
  monarchs: { id: number; name: string; size: number }[];
  note: string;
}

function configOf(s: Session): MonarchRunConfig {
  const c = s.monarch?.config;
  if (!c) throw new Error('这个会话还没有配置君主模式;先调用 civ_monarch_setup');
  return c as unknown as MonarchRunConfig;
}

/**
 * 只保留控制方式为 AI 的国家。
 * 开局设置(P1)里标成 'program' 的国家不交给 LLM,由引擎在 turnStep 里自动推演;
 * 没做过开局设置时按会话 mode 缺省(monarch 会话 = 全部 AI,行为与改造前一致)。
 */
function aiMonarchIds(s: Session, ids: readonly number[]): number[] {
  return ids.filter((id) => nationControlOf(s, id) === 'ai');
}

/** 配置哪些国家由外部君主接管(可重复调用覆盖配置) */
export function setupMonarch(s: Session, input: MonarchSetupInput): MonarchSetupResult {
  const provider = providerSettings({
    provider: input.provider,
    baseUrl: input.baseUrl,
    model: input.model,
    apiKey: input.apiKey,
    temperature: input.temperature,
    timeoutMs: input.timeoutMs,
  });
  const maxOrders = Math.round(clampNum(input.maxOrders ?? MONARCH_MAX_ORDERS, 1, MONARCH_MAX_ORDERS, 'maxOrders'));
  const polities = input.polities ?? 'all';
  if (polities !== 'all' && typeof polities !== 'number' && !Array.isArray(polities)) {
    throw new Error('polities 只能是 "all"、一个数字(前 N 个大国)或国家编号数组');
  }
  const ids = pickMonarchIds(s.civ, s.play.year, polities);
  if (!ids.length) throw new Error(`第 ${s.play.year} 年没有可接管的在世国家`);
  const config: MonarchRunConfig = {
    polities: Array.isArray(polities) ? [...polities] : polities,
    maxOrders,
    mock: !!input.mock,
    provider,
  };
  s.monarch = { config: config as unknown as Record<string, unknown>, rounds: [] };
  s.mode = 'monarch';
  // 配了君主 = 打开「LLM 扮演」这一开关(老调用方常常先开 auto 会话再配君主,不能因此被挡住)
  s.features.llm = true;
  const monarchs = aliveMonarchs(s.civ, s.play.year).filter((p) => ids.includes(p.id));
  return {
    sessionId: s.id,
    year: s.play.year,
    mode: s.mode,
    config: {
      polities: config.polities,
      maxOrders,
      mock: config.mock,
      provider: providerView(provider),
      kingCount: ids.length,
      maxCountries: MONARCH_MAX_COUNTRIES,
    },
    monarchs,
    note: config.mock
      ? 'mock 模式:不联网,用确定性规则模拟君主,适合自检/对账'
      : '每回合会对每个君主各发一次 LLM 请求;Key 只在本次进程内存里,不写日志/导出',
  };
}

export function monarchStatus(s: Session): Record<string, unknown> | null {
  if (!s.monarch) return null;
  const cfg = s.monarch.config as unknown as MonarchRunConfig;
  return {
    sessionId: s.id,
    year: s.play.year,
    rounds: s.rounds,
    features: { ...s.features },
    review: s.review,
    pendingPlan: !!s.pendingPlan,
    configured: {
      polities: cfg.polities,
      maxOrders: cfg.maxOrders,
      mock: cfg.mock,
      provider: providerView(cfg.provider),
    },
    monarchRounds: s.monarch.rounds.length,
  };
}

export interface BriefResult {
  sessionId: string;
  year: number;
  stepYears: number;
  polities: number;
  briefs: MonarchBrief[];
  note: string;
}

/** 只读本回合每个君主的简报(不调 LLM、不推演),给外部编排器/调试用 */
export function monarchBriefList(s: Session): BriefResult {
  const cfg = s.monarch ? (s.monarch.config as unknown as MonarchRunConfig) : null;
  const ids = aiMonarchIds(s, pickMonarchIds(s.civ, s.play.year, cfg ? cfg.polities : 'all'));
  const briefs = buildMonarchBriefs(s.civ, s.play, ids);
  return {
    sessionId: s.id,
    year: s.play.year,
    stepYears: s.stepYears,
    polities: briefs.length,
    briefs,
    note: cfg
      ? 'briefs[].text 是发给对应君主的完整提示;不调用 LLM,也不改任何状态(只含控制方式为 AI 的国家)'
      : '还没配置君主模式,这里按全部在世国家出简报;先调 civ_monarch_setup 才会按配置的国家出(只含 AI 国)',
  };
}

export interface MonarchDecisionRecord {
  polityId: number;
  name: string;
  key: string;
  source: 'mock' | 'llm' | 'error';
  reason: string;
  rawCommands: unknown[];
  commands: Intervention[];
  rejected: MonarchReject[];
  /** 高影响命令的审核结论(其余命令由玩家 / DM 在复核里决定) */
  audits?: AuditVerdict[];
  /** 本国的渗透判定 */
  intel?: IntelResolution[];
  /** 君主自主写下的记忆(提交回合时才进记忆库) */
  remember?: MemoryEntry[];
  error?: string;
  ms?: number;
  /** 提示词 tokens 与前缀缓存命中(分层是否有效的证据) */
  promptTokens?: number;
  cachedTokens?: number;
}

export interface MonarchRoundResult {
  sessionId: string;
  round: number;
  fromYear: number;
  toYear: number;
  years: number;
  decisions: MonarchDecisionRecord[];
  /** 同一回合里由小事件裁决层结算的部分;没配置 = 不存在 */
  petty?: {
    source: 'mock' | 'jev';
    events: number;
    decisions: number;
    commands: number;
    fallback: number;
    digest: string;
    error?: string;
  };
  /** 同一回合里由 DM 小决策(oracle)产生的那部分;没配置 DM = 不存在 */
  dm?: {
    source: DmDecisionOutcome['source'];
    reason: string;
    decisions: DmDecisionOutcome['decisions'];
    commands: number;
    rejected: number;
    notes: string[];
    error?: string;
  };
  engineRejected: unknown[];
  changes: TurnResult['polities'];
  events: TurnResult['events'];
  finished: boolean;
  fingerprint: string;
  /** 本回合的审核与渗透汇总 */
  audits?: AuditVerdict[];
  intel?: { source: 'jev' | 'rule'; resolutions: IntelResolution[]; error?: string };
}

/** 一回合的方案(尚未推演):复核模式下先给人看,再由 monarchCommit 落地 */
export interface MonarchPlan {
  sessionId: string;
  round: number;
  fromYear: number;
  years: number;
  decisions: MonarchDecisionRecord[];
  /** commands[i] 来自哪个国家的第几条命令(复核按它否决) */
  commandRefs: { polityId: number; index: number }[];
  commands: Intervention[];
  audits: AuditVerdict[];
  audit: { source: 'jev' | 'rule'; error?: string };
  intel: { source: 'jev' | 'rule'; resolutions: IntelResolution[]; error?: string };
  briefs: { polityId: number; name: string; text: string }[];
  /** 同回合小事件与 DM 命令(提交时一起进引擎) */
  pettyCommands: Intervention[];
  dmCommands: Intervention[];
  petty?: MonarchRoundResult['petty'];
  dm?: MonarchRoundResult['dm'];
  createdAt: number;
}

/** 本局的 Jev 客户端:双开关里 Jev 关着 = null(审核/渗透都退化为确定性规则) */
function jevFor(s: Session): JevSettings | null {
  if (!s.features.jev) return null;
  return pettyRuntime(s.id)?.config.client ?? null;
}

/**
 * 开局定制钉住的角色卡: 玩家在开局设置里亲手定了君主姓名/性格时,
 * 不按引擎推演出来的君主重建这张卡(否则第一回合就会被覆盖)。
 * 只钉定制的那个国家;其它国家照旧。
 */
function pinnedCard(s: Session, id: number): boolean {
  const cs = s.customStart;
  return !!cs && cs.pinnedCard && cs.polityId === id;
}

/** 建卡/换卡:君主换人时重建角色卡,旧君主的记忆保留并记一笔"继位" */
function ensureCards(s: Session, ids: readonly number[], year: number): void {
  s.cards ??= new Map();
  s.memory ??= new Map();
  for (const id of ids) {
    const prev = s.cards.get(id);
    if (!(prev && pinnedCard(s, id)) && (!prev || !cardIsCurrent(s.civ, prev, year))) {
      const card = monarchCard(s.civ, id, year);
      if (card) {
        s.cards.set(id, card);
        if (prev) {
          const book = s.memory.get(id) ?? memoryBook(id);
          addMemory(book, { year, kind: 'dynasty', text: `${prev.name} 之后由 ${card.name} 继位`, weight: 0.5, source: 'engine' });
          s.memory.set(id, book);
        }
      }
    }
    if (!s.memory.has(id)) s.memory.set(id, memoryBook(id));
  }
}

/** 把 decisions 里的命令摊平(带引用),渗透/审核之后再摊一次 */
function flatten(decisions: readonly MonarchDecisionRecord[]): { commands: Intervention[]; refs: { polityId: number; index: number }[] } {
  const commands: Intervention[] = [];
  const refs: { polityId: number; index: number }[] = [];
  for (const d of decisions) d.commands.forEach((v, index) => { commands.push(v); refs.push({ polityId: d.polityId, index }); });
  return { commands, refs };
}

/** 跑一个回合的方案:简报 → 并发 LLM/mock → 编译 → 渗透判定 → 高影响命令审核;不推演 */
export async function monarchPlan(s: Session, opts: { years?: number } = {}): Promise<MonarchPlan> {
  if (!s.features.llm) throw new Error('本局没有打开「LLM 扮演」;仅 Jev 时请用小事件回合(civ_petty_round)');
  const cfg = configOf(s);
  if (s.rounds >= s.maxRounds) throw new Error(`会话已经跑满 ${s.maxRounds} 回合`);
  if (s.endYear !== undefined && s.play.year >= s.endYear) throw new Error(`会话已经到第 ${s.play.year} 年(>= endYear ${s.endYear})`);

  const year = Math.floor(s.play.year);
  const ids = aiMonarchIds(s, pickMonarchIds(s.civ, s.play.year, cfg.polities));
  // 控制方式为 'program' 的国家不交给 LLM:留 0 个 AI 国也合法,本回合由引擎自动推演它们
  ensureCards(s, ids, year);
  const briefs = buildMonarchBriefs(s.civ, s.play, ids);
  const turnIndex = s.rounds;

  const settled = await Promise.all(
    briefs.map(async (brief): Promise<{ brief: MonarchBrief; source: 'mock' | 'llm'; decision: ParsedDecision; ms?: number; promptTokens?: number; cachedTokens?: number; error?: string }> => {
      const card = s.cards!.get(brief.polityId) ?? null;
      const memory = s.memory!.get(brief.polityId);
      const regions = regionTable(s.civ, brief.polityId, year);
      const intel = brief.neighbors.map((n) => foreignIntel(s.civ, n.id, year, s.intel?.[String(brief.polityId)]?.[String(n.id)]));
      if (cfg.mock) return { brief, source: 'mock', decision: mockDecision(brief, turnIndex) };
      try {
        const reply = await askLlm(monarchMessages({ brief, card, memory, regions, intel }), cfg.provider);
        return { brief, source: 'llm', decision: parseDecision(reply.text), ms: reply.ms, promptTokens: reply.promptTokens, cachedTokens: reply.cachedTokens };
      } catch (e) {
        return { brief, source: 'llm', decision: { reason: '', commands: [] }, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  // 命令按国家编号固定顺序落地,和 LLM 的返回快慢无关
  const ordered = [...settled].sort((a, b) => a.brief.polityId - b.brief.polityId);
  const decisions: MonarchDecisionRecord[] = [];
  const auditEntries: AuditEntry[] = [];
  for (const item of ordered) {
    const brief = item.brief;
    if (item.error) {
      decisions.push({ polityId: brief.polityId, name: brief.name, key: brief.key, source: 'error', reason: '', rawCommands: [], commands: [], rejected: [], error: item.error });
      continue;
    }
    const parsed = item.decision;
    const compiled = compileMonarchOrders(s.civ, s.play.year, brief.polityId, parsed.commands ?? []);
    const card = s.cards!.get(brief.polityId);
    decisions.push({
      polityId: brief.polityId,
      name: brief.name,
      key: brief.key,
      source: item.source,
      reason: parsed.reason ?? '',
      rawCommands: parsed.commands ?? [],
      commands: compiled.commands,
      rejected: compiled.rejected,
      ...(parsed.remember ? { remember: cleanMemoryWrites(parsed.remember, year) } : {}),
      ...(item.ms !== undefined ? { ms: item.ms } : {}),
      ...(item.promptTokens !== undefined ? { promptTokens: item.promptTokens } : {}),
      ...(item.cachedTokens !== undefined ? { cachedTokens: item.cachedTokens } : {}),
    });
    if (card) auditEntries.push({ polityId: brief.polityId, brief, card, commands: compiled.commands });
  }

  const jev = jevFor(s);

  // 渗透:判定成败并写回命令的 result(命令史里就有"拿到了什么",回放逐位一致)
  const flat0 = flatten(decisions);
  const intelOut = await resolveIntel(s, flat0.commands, jev);
  if (intelOut.resolutions.length) {
    flat0.refs.forEach((ref, i) => {
      const d = decisions.find((x) => x.polityId === ref.polityId);
      if (d) d.commands[ref.index] = intelOut.commands[i]!;
    });
    for (const d of decisions) {
      const mine = intelOut.resolutions.filter((r) => r.polityId === d.polityId);
      if (mine.length) d.intel = mine;
    }
  }

  // 高影响命令(declare/press/destroy/cede)的合理性审核;其余命令留给玩家 / DM 复核
  const audit = await auditMonarchCommands(s, auditEntries, jev);
  const allAudits: AuditVerdict[] = [];
  for (const d of decisions) {
    if (!d.commands.length) continue;
    const kept: Intervention[] = [];
    const mine: AuditVerdict[] = [];
    d.commands.forEach((v, index) => {
      const verdict = audit.verdicts.get(`${d.polityId}:${index}`);
      if (!verdict) { kept.push(v); return; }
      mine.push(verdict);
      if (verdict.outcome === 'allow') { kept.push(v); return; }
      if (verdict.outcome === 'reject') {
        d.rejected.push({ order: d.rawCommands[index] ?? v, reason: `审核退回:${verdict.reason}` });
        return;
      }
      // 降级:换成一条更保守的等价命令(宣战→守成,坚持打→停止扩张)
      const soft = compileMonarchOrders(s.civ, s.play.year, d.polityId, [softenCommand(v.kind)]);
      if (soft.commands.length) kept.push(...soft.commands);
      d.rejected.push({ order: d.rawCommands[index] ?? v, reason: `审核降级为「${v.kind === 'press' ? '停止扩张' : '守成'}」:${verdict.reason}` });
    });
    d.commands = kept;
    if (mine.length) d.audits = mine;
    allAudits.push(...mine);
  }

  // 同一回合的「小事件裁决层」:先结算小事,结果作为既定事实给 DM,再和君主命令一起交给引擎
  let petty: MonarchRoundResult['petty'] | undefined;
  let pettySettlement: PettySettlement | undefined;
  if (s.petty) {
    try {
      pettySettlement = await settlePetty(s, { years: opts.years });
      petty = {
        source: (s.petty.config as { mock?: boolean }).mock === true ? 'mock' : 'jev',
        events: pettySettlement.events,
        decisions: pettySettlement.decisions.length,
        commands: pettySettlement.commands.length,
        fallback: pettySettlement.fallbackCount,
        digest: pettyDigest(pettySettlement),
      };
    } catch (e) {
      petty = { source: s.petty && (s.petty.config as { mock?: boolean }).mock === true ? 'mock' : 'jev', events: 0, decisions: 0, commands: 0, fallback: 0, digest: '', error: e instanceof Error ? e.message : String(e) };
    }
  }

  // 同一回合的 DM 小决策(天灾/小贸易):和君主命令一起,在同一刻交给引擎
  let dm: MonarchRoundResult['dm'] | undefined;
  const dmCommands: Intervention[] = [];
  if (s.dm) {
    try {
      const out = await decideDm(s, undefined, petty?.digest);
      dmCommands.push(...out.commands);
      dm = { source: out.source, reason: out.reason, decisions: out.decisions, commands: out.commands.length, rejected: out.rejected.length, notes: out.notes };
    } catch (e) {
      dm = { source: 'llm', reason: '', decisions: [], commands: 0, rejected: 0, notes: [], error: e instanceof Error ? e.message : String(e) };
    }
  }

  const flat = flatten(decisions);
  const plan: MonarchPlan = {
    sessionId: s.id,
    round: s.rounds + 1,
    fromYear: year,
    years: Math.max(1, Math.round(opts.years ?? s.stepYears)),
    decisions,
    commandRefs: flat.refs,
    commands: flat.commands,
    audits: allAudits,
    audit: { source: audit.source, ...(audit.error ? { error: audit.error } : {}) },
    intel: { source: intelOut.source, resolutions: intelOut.resolutions, ...(intelOut.error ? { error: intelOut.error } : {}) },
    briefs: briefs.map((b) => ({ polityId: b.polityId, name: b.name, text: b.text })),
    pettyCommands: pettySettlement?.commands ?? [],
    dmCommands,
    ...(petty ? { petty } : {}),
    ...(dm ? { dm } : {}),
    createdAt: Date.now(),
  };
  s.pendingPlan = plan;
  return plan;
}

/** 提交一个已出的方案:可按 {polityId,index} 否决若干条(玩家 / DM 复核),再统一推演并写日志 */
export async function monarchCommit(s: Session, opts: { reject?: readonly { polityId: number; index: number }[] } = {}): Promise<MonarchRoundResult> {
  const plan = s.pendingPlan as MonarchPlan | undefined;
  if (!plan) throw new Error('没有待提交的回合方案;先跑 civ_monarch_plan(或直接用 civ_monarch_round)');
  const drop = new Set((opts.reject ?? []).map((r) => `${r.polityId}:${r.index}`));
  const kept = plan.commands.filter((_, i) => {
    const ref = plan.commandRefs[i]!;
    return !drop.has(`${ref.polityId}:${ref.index}`);
  });
  const dropped = plan.commandRefs.filter((ref) => drop.has(`${ref.polityId}:${ref.index}`));
  const engineCommands = [...kept, ...plan.pettyCommands, ...plan.dmCommands];
  submitOrders(s, engineCommands);
  const turn = turnStep(s, { years: plan.years });

  // 记忆库:本回合的引擎事实(战败/饥荒/背盟……)+ 君主自己写下的
  s.memory ??= new Map();
  for (const d of plan.decisions) {
    const book = s.memory.get(d.polityId) ?? memoryBook(d.polityId);
    for (const m of deriveEngineMemories(s.civ, d.polityId, turn.fromYear, turn.toYear)) addMemory(book, m);
    for (const m of d.remember ?? []) addMemory(book, m);
    s.memory.set(d.polityId, book);
  }

  const record: Record<string, unknown> = {
    sessionId: s.id,
    round: turn.round,
    fromYear: turn.fromYear,
    toYear: turn.toYear,
    years: turn.years,
    decisions: plan.decisions,
    audits: plan.audits,
    audit: plan.audit,
    intel: plan.intel,
    ...(dropped.length ? { rejectedByReview: dropped } : {}),
    engineRejected: turn.rejected,
    changes: turn.polities,
    events: turn.events,
    fingerprint: turn.fingerprint,
    briefs: plan.briefs,
    ...(plan.petty ? { petty: plan.petty } : {}),
    ...(plan.dm ? { dm: plan.dm } : {}),
  };
  s.monarch!.rounds.push(record);
  const path = join(s.logDir, `monarch-round-${String(turn.round).padStart(4, '0')}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2));
  appendFileSync(join(s.logDir, 'monarch-rounds.jsonl'), JSON.stringify({
    round: turn.round,
    fromYear: turn.fromYear,
    toYear: turn.toYear,
    decisions: plan.decisions.map((d) => ({ polityId: d.polityId, source: d.source, commands: d.commands.length, rejected: d.rejected.length, error: d.error ?? null, cachedTokens: d.cachedTokens ?? null })),
    audits: plan.audits.map((a) => ({ polityId: a.polityId, kind: a.kind, outcome: a.outcome, source: a.source })),
    intel: plan.intel.resolutions,
    ...(plan.petty ? { petty: { source: plan.petty.source, events: plan.petty.events, decisions: plan.petty.decisions, commands: plan.petty.commands, fallback: plan.petty.fallback, error: plan.petty.error ?? null } } : {}),
    ...(plan.dm ? { dm: { source: plan.dm.source, decisions: plan.dm.decisions.length, commands: plan.dm.commands, error: plan.dm.error ?? null } } : {}),
    fingerprint: turn.fingerprint,
  }) + '\n');
  s.pendingPlan = undefined;

  return {
    sessionId: s.id,
    round: turn.round,
    fromYear: turn.fromYear,
    toYear: turn.toYear,
    years: turn.years,
    decisions: plan.decisions,
    ...(plan.petty ? { petty: plan.petty } : {}),
    ...(plan.dm ? { dm: plan.dm } : {}),
    audits: plan.audits,
    intel: plan.intel,
    engineRejected: turn.rejected,
    changes: turn.polities,
    events: turn.events,
    finished: turn.finished,
    fingerprint: turn.fingerprint,
  };
}

/** 跑一个完整的君主回合(不等复核):plan → commit;复核模式下界面用 plan / commit 两步 */
export async function monarchRound(s: Session, opts: { years?: number } = {}): Promise<MonarchRoundResult> {
  await monarchPlan(s, opts);
  return monarchCommit(s);
}

/** 玩家 / DM 改某国的角色卡 */
export function setMonarchCard(s: Session, polityId: number, patch: unknown): unknown {
  const base = s.cards?.get(polityId);
  if (!base) throw new Error(`P${polityId} 还没有角色卡;先跑一个回合的方案`);
  const next = cleanCardInput(patch, base);
  s.cards!.set(polityId, next);
  return next;
}

/* ------------------------------------------------------------------ *
 * 回放对账:同一份世界 + 同一串命令,重推一遍应该逐位一致
 * ------------------------------------------------------------------ */

export interface ReplayResult {
  sessionId: string;
  ok: boolean;
  expected: string;
  actual: string;
  expectedYear: number;
  actualYear: number;
  commands: number;
  steps: number;
  worldId: string;
  note: string;
  problems: string[];
}

const commandFrom = (v: Intervention): number => ('from' in v && typeof v.from === 'number' ? v.from : 0);

/**
 * 用会话自己的 worldParams/civParams 从第 0 年重推:
 * 按命令的 from 年份分批 issue → playTurn,一直推到会话当前年份。
 * 只比较引擎事实(civ 指纹 + 年份),不依赖 LLM/日志;用来证明"君主回合没有破坏确定性"。
 */
export function verifySession(s: Session): ReplayResult {
  const world: World = generateWorld({ ...DEFAULT_PARAMS, ...s.worldParams });
  const params = { ...s.civParams };
  const startPlay: PlayState = { year: s.startYear, commands: [] };
  let civ: Civ = playCiv(world, params, startPlay);
  let play: PlayState = startPlay;
  const problems: string[] = [];
  const indexed = s.play.commands
    .map((v, i) => ({ v, i }))
    .sort((a, b) => commandFrom(a.v) - commandFrom(b.v) || a.i - b.i);
  let idx = 0;
  let steps = 0;
  while (play.year < s.play.year) {
    const cur = Math.floor(play.year);
    const batch: Intervention[] = [];
    while (idx < indexed.length) {
      const from = Math.floor(commandFrom(indexed[idx]!.v));
      if (from > cur) break;
      if (from < cur) problems.push(`命令 #${indexed[idx]!.i} 的 from=${from} 早于重放到第 ${cur} 年`);
      batch.push(indexed[idx]!.v);
      idx += 1;
    }
    const nextFrom = idx < indexed.length ? Math.floor(commandFrom(indexed[idx]!.v)) : s.play.year;
    const stop = Math.max(cur + 1, Math.min(s.play.year, nextFrom));
    const step = playTurn(world, civ, params, play, batch, stop - cur);
    civ = step.civ;
    play = step.play;
    steps += 1;
    if (civ.stuck) {
      problems.push(`重推到第 ${play.year} 年时引擎卡住了`);
      break;
    }
  }
  const expected = civHash(s.civ);
  const actual = civHash(civ);
  const ok = expected === actual && Math.floor(play.year) === Math.floor(s.play.year);
  return {
    sessionId: s.id,
    ok,
    expected,
    actual,
    expectedYear: Math.floor(s.play.year),
    actualYear: Math.floor(play.year),
    commands: s.play.commands.length,
    steps,
    worldId: worldIdOf(s.worldParams),
    note: ok
      ? '回放一致:君主回合只是把同一串命令分批交给引擎,没有改变引擎结果'
      : '回放不一致!检查是否有命令在错误年份生效,或会话状态被外部修改',
    problems,
  };
}

function clampNum(v: number, min: number, max: number, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} 必须是数字`);
  return Math.min(max, Math.max(min, v));
}
