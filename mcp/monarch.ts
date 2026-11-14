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
import { cleanIntervention, polityKey, regionKey, type Intervention, type PlayState } from '../src/gen/edits';
import { capitalAt } from '../src/gen/civ/growth';
import { createPersonNamer } from '../src/gen/names/persons';
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
  sizesNow,
  submitOrders,
  turnStep,
  worldIdOf,
  type MonarchActionLog,
  type MonarchHeir,
  type MonarchPolityState,
  type MonarchRoundAp,
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
import { CARD_LIFESPAN_DEFAULT, cardIsCurrent, cleanCardInput, monarchCard, type MonarchCard, type MonarchCompetence, type MonarchTraits } from '../src/gen/civ/monarchCard';
import { addMemory, cleanMemoryWrites, deriveEngineMemories, memoryBook, type MemoryEntry } from '../src/gen/civ/monarchMemory';
import { foreignIntel, regionTable } from '../src/gen/civ/monarchIntel';
import { auditMonarchCommands, softenCommand, type AuditEntry, type AuditVerdict } from './monarch-audit';
import { resolveIntel, type IntelResolution } from './intel';
import {
  CULTIVATE_HEIR_GROWTH,
  PACIFY_BOOST_MUL,
  SPECIAL_ACTION_AP,
  SPECIAL_ACTION_NAMES,
  SPECIAL_ACTIONS,
  engineCommandAp,
  hashFraction,
  leadArmyRisk,
  monarchApBreakdown,
  stepMonthsOf,
  type MonarchApBreakdown,
  type SpecialActionKind,
} from './tuning';
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
    lifespan: s.monarch.lifespan ?? CARD_LIFESPAN_DEFAULT,
    configured: {
      polities: cfg.polities,
      maxOrders: cfg.maxOrders,
      mock: cfg.mock,
      provider: providerView(cfg.provider),
    },
    monarchRounds: s.monarch.rounds.length,
    panels: monarchPanels(s),
  };
}

/** P5:给 UI / 报告用的君主面板数据(只读,不改状态) */
export interface MonarchPanel {
  polityId: number;
  name: string;
  year: number;
  ap: {
    stepMonths: number;
    stepFactor: number;
    tech: number;
    economy: number;
    apTotal: number;
    apSpent: number;
    remaining: number;
    log: MonarchActionLog[];
    breakdown: MonarchApBreakdown;
  };
  location: { regionId: number; regionName: string } | null;
  heirs: MonarchHeir[];
  journal: { year: number; kind: string; text: string }[];
  capturedUntil?: number;
  died?: number;
}

export function monarchPanels(s: Session): MonarchPanel[] {
  if (!s.monarch) return [];
  const year = Math.floor(s.play.year);
  const cfg = s.monarch.config as unknown as MonarchRunConfig;
  const ids = aiMonarchIds(s, pickMonarchIds(s.civ, s.play.year, cfg.polities ?? 'all'));
  const out: MonarchPanel[] = [];
  for (const id of ids) {
    const polity = s.civ.polities[id];
    if (!polity) continue;
    const st = s.monarch.byPolity?.[String(id)] ?? {};
    const breakdown = monarchApBreakdown(s.civ, id, year, s.stepYears);
    const ap = st.roundAp ?? { year, apTotal: breakdown.apTotal, apSpent: 0, log: [] };
    const locRegion = st.location?.regionId ?? capitalRegionOf(s, id, year);
    out.push({
      polityId: id,
      name: String(polity.name),
      year,
      ap: {
        stepMonths: breakdown.stepMonths,
        stepFactor: breakdown.stepFactor,
        tech: breakdown.tech,
        economy: breakdown.economy,
        apTotal: ap.apTotal,
        apSpent: ap.apSpent,
        remaining: Math.max(0, ap.apTotal - ap.apSpent),
        log: [...ap.log],
        breakdown,
      },
      location: locRegion === null || locRegion === undefined ? null : { regionId: locRegion, regionName: regionLabel(s, locRegion) },
      heirs: [...(st.heirs ?? [])],
      journal: [...(st.journal ?? [])],
      ...(st.capturedUntil !== undefined ? { capturedUntil: st.capturedUntil } : {}),
      ...(st.died !== undefined ? { died: st.died } : {}),
    });
  }
  return out;
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
  /** P5:本回合的特殊动作(培养后代 / 御驾亲征 / 派兵 / 安抚地方)及 AP 记账 */
  actions?: MonarchSpecialRecord[];
  /** P5:本回合行动点摘要 */
  ap?: { apTotal: number; apSpent: number; remaining: number; stepMonths: number };
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

/** P5:一条特殊动作的执行记账(plan 阶段定案,commit 阶段落地) */
export interface MonarchSpecialRecord {
  kind: SpecialActionKind;
  cost: number;
  ok: boolean;
  reason?: string;
  /** 目标展示(国家名 / 州名) */
  target?: string;
  targetPolityId?: number;
  regionId?: number;
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
  /** P5:本回合行动点账本(按 AI 国) */
  ap?: MonarchPlan['ap'];
  /** P5:本回合的君主事件(亲征结果 / 继位 / 安抚) */
  monarchEvents?: MonarchPlan['monarchEvents'];
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
  /** P5:本回合的行动点账本(plan 阶段算好,提交时按它确认) */
  ap: {
    stepMonths: number;
    byPolity: {
      polityId: number;
      name: string;
      apTotal: number;
      apSpent: number;
      remaining: number;
      breakdown: MonarchApBreakdown;
      log: MonarchActionLog[];
    }[];
  };
  /** P5:本回合的君主事件(自然死亡 / 继位 / 亲征) */
  monarchEvents: { polityId: number; kind: string; text: string }[];
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
    // P5:后代继位出来的卡是钉住的(引擎推演出来的君主和它并不对应,不能覆盖)
    const pinnedByHeir = polityStateOf(s, id).pinned === true;
    if (!(prev && (pinnedCard(s, id) || pinnedByHeir)) && (!prev || !cardIsCurrent(s.civ, prev, year))) {
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

/* ------------------------------------------------------------------ *
 * P5:行动点 / 君主位置 / 后代 / 特殊动作
 *
 * 设计说明(见 mcp/tuning.ts 文件头):
 * - AP = monarchApTotal(科技替身, 经济替身, 回合月数),plan 阶段一次算好,
 *   引擎命令与特殊动作都从这里扣;超支的命令不进 commands,记 rejected + ap.log。
 * - 亲征 +20% 只是记账(引擎 war.led 只有 appoint 名将能注入),被俘/阵亡用
 *   确定性 hash 掷骰,阵亡走继位。
 * - 安抚地方落地为对本国目标州的一次 boost 发展干预,叙事记为「安抚某地」。
 * ------------------------------------------------------------------ */

/** 会话上的君主国家状态表(懒建) */
function byPolity(s: Session): Record<string, MonarchPolityState> {
  s.monarch ??= { config: {}, rounds: [] };
  s.monarch.byPolity ??= {};
  return s.monarch.byPolity;
}

function polityStateOf(s: Session, polityId: number): MonarchPolityState {
  const map = byPolity(s);
  const key = String(polityId);
  map[key] ??= {};
  return map[key]!;
}

/** 一国当前拥有的州(升序) */
function ownedRegions(civ: Civ, polityId: number): number[] {
  const out: number[] = [];
  for (let r = 0; r < civ.polity.length; r++) if (civ.polity[r] === polityId) out.push(r);
  return out;
}

/** 这一年的国都州(国都没了返回 null) */
function capitalRegionOf(s: Session, polityId: number, year: number): number | null {
  const p = s.civ.polities[polityId];
  if (!p) return null;
  const sid = capitalAt(p, year);
  const st = s.civ.settlements[sid];
  return st && st.region >= 0 ? st.region : null;
}

/** 君主所在州:优先用记录的位置;州丢了/易主了就回到国都州 */
function ensureLocation(s: Session, polityId: number, year: number): number | null {
  const st = polityStateOf(s, polityId);
  const cur = st.location?.regionId;
  if (typeof cur === 'number' && cur >= 0 && cur < s.civ.regions.count && s.civ.polity[cur] === polityId) return cur;
  const cap = capitalRegionOf(s, polityId, year);
  st.location = cap === null ? null : { regionId: cap };
  return cap;
}

function regionLabel(s: Session, region: number | null): string {
  if (region === null || region < 0) return '未知之地';
  const names = s.civ.regions.name;
  const name = names?.[region];
  return name ? String(name) : `州 #${region + 1}`;
}

/** 州的邻接州(含海路,用于「君主所在或相邻」的判定) */
function regionNeighborsOf(civ: Civ, region: number): number[] {
  const out: number[] = [];
  if (region < 0 || region >= civ.regions.count) return out;
  for (let k = civ.regions.adjStart[region]!; k < civ.regions.adjStart[region + 1]!; k++) out.push(civ.regions.adj[k]!);
  return out;
}

/** 从史事重放出这个国家还没结束的战争(只读,和 wars.ts 的判定一致) */
function activeWarIds(civ: Civ, polityId: number, year: number): number[] {
  const open = new Map<number, { a: number; b: number }>();
  for (const e of civ.annals) {
    if (e.kind === 'war') open.set(e.war, { a: e.a, b: e.b });
    else if (e.kind === 'peace') open.delete(e.war);
  }
  const out: number[] = [];
  for (const [id, w] of open) if (w.a === polityId || w.b === polityId) out.push(id);
  return out;
}

/** 确定性 [0,1) 小数:见 tuning.hashFraction(这里保留别名,回放逻辑与测试同源) */
const hash01 = hashFraction;

const SPECIAL_KIND_SET = new Set<string>(SPECIAL_ACTIONS);

/** 把 LLM 交回来的命令拆成「引擎命令」与「P5 特殊动作」两组 */
function splitSpecialOrders(raw: readonly unknown[]): { engine: unknown[]; special: Record<string, unknown>[] } {
  const engine: unknown[] = [];
  const special: Record<string, unknown>[] = [];
  for (const v of raw) {
    const kind = v && typeof v === 'object' ? (v as Record<string, unknown>).kind : undefined;
    if (typeof kind === 'string' && SPECIAL_KIND_SET.has(kind)) special.push(v as Record<string, unknown>);
    else engine.push(v);
  }
  return { engine, special };
}

/** 州号:接受数字 / 'r12' / 'region:c4567'(治所地块)/ 'c4567' */
function regionIdOf(civ: Civ, value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value >= 0 && value < civ.regions.count ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const cellForm = /^(?:region:)?c(\d+)$/.exec(text);
  if (cellForm) {
    const cell = Number(cellForm[1]);
    if (!Number.isInteger(cell) || cell < 0 || cell >= civ.regions.of.length) return null;
    const region = civ.regions.of[cell]!;
    return region >= 0 ? region : null;
  }
  const regionForm = /^(?:region:)?r(\d+)$/.exec(text);
  const num = regionForm ? Number(regionForm[1]) : Number(text);
  if (!Number.isInteger(num)) return null;
  return num >= 0 && num < civ.regions.count ? num : null;
}

/** 国家号:接受数字 / 稳定键 / 数字字符串;返回的可能是已灭亡的国家,调用方自己判活 */
function polityIdOf(civ: Civ, value: unknown, year: number): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value >= 0 && value < civ.polities.length ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const idx = civ.polities.findIndex((p) => p && polityKey(civ, p.id) === text);
  if (idx >= 0) return idx;
  const num = Number(text);
  if (Number.isInteger(num) && num >= 0 && num < civ.polities.length) return num;
  return null;
}

interface PlannedSpecial {
  kind: SpecialActionKind;
  cost: number;
  target?: string;
  targetPolityId?: number;
  regionId?: number;
}

/** 校验一条特殊动作并定下 AP 成本;不合法返回 reason(不进 commands,只记日志) */
function readSpecial(s: Session, polityId: number, year: number, raw: Record<string, unknown>): { planned?: PlannedSpecial; reason?: string } {
  const kind = raw.kind as SpecialActionKind;
  const cost = SPECIAL_ACTION_AP[kind];
  if (kind === 'cultivate-heir') return { planned: { kind, cost } };
  if (kind === 'lead-army') {
    const targetId = polityIdOf(s.civ, raw.b ?? raw.targetPolityId ?? raw.target, year);
    if (targetId !== null && targetId !== polityId) {
      const target = s.civ.polities[targetId];
      return { planned: { kind, cost, targetPolityId: targetId, target: target ? String(target.name) : `P${targetId}` } };
    }
    return { planned: { kind, cost } };
  }
  if (kind === 'dispatch-army') {
    const targetId = polityIdOf(s.civ, raw.b ?? raw.targetPolityId ?? raw.target, year);
    if (targetId === null || targetId === polityId) return { planned: { kind, cost }, reason: '派兵没有指定目标国家' };
    const target = s.civ.polities[targetId];
    return { planned: { kind, cost, targetPolityId: targetId, target: target ? String(target.name) : `P${targetId}` } };
  }
  // pacify-region:目标州必须是自己的州,且在君主所在州或相邻州
  const region = regionIdOf(s.civ, raw.region ?? raw.regionId ?? raw.r);
  if (region === null) return { planned: { kind, cost }, reason: '安抚地方没有指定合法州号' };
  if (s.civ.polity[region] !== polityId) return { planned: { kind, cost, regionId: region }, reason: `${regionLabel(s, region)} 不是这个国家的州` };
  const home = ensureLocation(s, polityId, year);
  if (home === null) return { planned: { kind, cost, regionId: region }, reason: '君主没有落脚的地方' };
  if (region !== home && !regionNeighborsOf(s.civ, home).includes(region)) {
    return { planned: { kind, cost, regionId: region }, reason: `${regionLabel(s, region)} 离君主所在(${regionLabel(s, home)})太远,安抚不到` };
  }
  return { planned: { kind, cost, regionId: region, target: regionLabel(s, region) } };
}

/** 扣 AP;超支返回 false 并记一条失败日志 */
function chargeAp(ap: MonarchRoundAp, action: string, cost: number, target?: string): boolean {
  const left = ap.apTotal - ap.apSpent;
  if (cost > left) {
    ap.log.push({ action, cost, ok: false, reason: `行动点不够:要 ${cost} AP,本回合只剩 ${Math.max(0, left)}`, ...(target ? { target } : {}) });
    return false;
  }
  ap.apSpent += cost;
  ap.log.push({ action, cost, ok: true, ...(target ? { target } : {}) });
  return true;
}

/** 一条引擎命令的 AP 成本(declare/press 按目标国力 4/5/6) */
function commandAp(s: Session, cmd: Intervention): number {
  const kind = String(cmd.kind);
  if (kind !== 'declare' && kind !== 'press') return engineCommandAp(kind);
  const targetKey = (cmd as { b?: unknown }).b;
  let size = 0;
  if (typeof targetKey === 'string') {
    const idx = s.civ.polities.findIndex((p) => p && polityKey(s.civ, p.id) === targetKey);
    if (idx >= 0) size = sizesNow(s.civ).get(idx) ?? 0;
  }
  return engineCommandAp(kind, size);
}

function commandTargetLabel(s: Session, cmd: Intervention): string | undefined {
  const b = (cmd as { b?: unknown }).b;
  if (typeof b !== 'string') return undefined;
  const idx = s.civ.polities.findIndex((p) => p && polityKey(s.civ, p.id) === b);
  if (idx < 0) return b;
  return String(s.civ.polities[idx]!.name);
}

/** 本回合的「战事类」动作:亲征/派兵/宣战/主动出击(用于培养后代的互斥) */
function hasCampaign(commands: readonly Intervention[], specials: readonly Record<string, unknown>[]): boolean {
  if (commands.some((c) => c.kind === 'declare' || c.kind === 'press')) return true;
  return specials.some((o) => o.kind === 'lead-army' || o.kind === 'dispatch-army');
}

/** 建一个后代:姓名按该国文化风格生成,性格从在位君主出发做确定性扰动 */
function makeHeir(s: Session, polityId: number, year: number): MonarchHeir {
  const civ = s.civ;
  const card = s.cards?.get(polityId);
  const polity = civ.polities[polityId];
  const style = polity && civ.cultures[polity.culture] ? String(civ.cultures[polity.culture]!.style) : 'kingdom';
  let name = '';
  try {
    const namer = createPersonNamer(civ.seed, style);
    name = `${namer.surname(polityId, year, 9)}${namer.given(polityId, year, 9)}`.trim();
  } catch {
    name = '';
  }
  if (!name) name = `无名后裔${polityId}`;
  const baseTraits: MonarchTraits = card?.traits ?? { caution: 50, ambition: 50, honor: 50, greed: 50 };
  const perturbTrait = (value: number, salt: number): number => clampNum(Math.round(value + (hash01(civ.seed, 'heir', polityId, year, salt) * 30 - 15)), 0, 100, 'heir.trait');
  const baseComp: MonarchCompetence = card?.competence ?? { war: 1, economy: 1, intrigue: 1, admin: 1 };
  const perturbComp = (value: 0 | 1 | 2, salt: number): 0 | 1 | 2 => {
    const step = hash01(civ.seed, 'heir-comp', polityId, year, salt) > 0.7 ? 1 : 0;
    return clampNum(value + step, 0, 2, 'heir.competence') as 0 | 1 | 2;
  };
  return {
    name,
    born: year,
    traits: {
      caution: perturbTrait(baseTraits.caution, 1),
      ambition: perturbTrait(baseTraits.ambition, 2),
      honor: perturbTrait(baseTraits.honor, 3),
      greed: perturbTrait(baseTraits.greed, 4),
    },
    competence: {
      war: perturbComp(baseComp.war, 5),
      economy: perturbComp(baseComp.economy, 6),
      intrigue: perturbComp(baseComp.intrigue, 7),
      admin: perturbComp(baseComp.admin, 8),
    },
    growth: 0,
    createdAt: year,
  };
}

/** 后代继位:用后代的姓名/生年/性格建一张新卡并钉住,旧君主的记忆留一笔 */
function succeedByHeir(s: Session, polityId: number, year: number, reason: string): { name: string; text: string } | null {
  const st = polityStateOf(s, polityId);
  const heirs = st.heirs ?? [];
  const heir = heirs.shift();
  st.heirs = heirs;
  const prev = s.cards?.get(polityId);
  if (!heir) {
    st.died = year;
    const text = `${prev?.name ?? `P${polityId}`} ${reason},但没有后代;由朝廷摄政(等引擎推演出的下一位君主)`;
    st.journal = [...(st.journal ?? []), { year, kind: 'death', text }];
    return { name: prev?.name ?? `P${polityId}`, text };
  }
  const base = prev;
  const persona = heirPersona(heir, prev?.name ?? '');
  const card: MonarchCard = {
    polityId,
    key: base?.key ?? '',
    name: heir.name,
    born: heir.born,
    persona,
    traits: heir.traits,
    preferences: base?.preferences ?? { war: 'opportunist', economy: 'develop', diplomacy: 'pragmatic' },
    competence: heir.competence,
    createdAt: Date.now(),
    lifespan: base?.lifespan ?? s.monarch?.lifespan ?? CARD_LIFESPAN_DEFAULT,
    ...(base?.title ? { title: base.title } : {}),
    ...(base?.race ? { race: base.race } : {}),
    ...(base?.raceSystem !== undefined ? { raceSystem: base.raceSystem } : {}),
    ...(base?.biography ? { biography: base.biography } : {}),
  };
  s.cards ??= new Map();
  s.cards.set(polityId, card);
  st.pinned = true;
  // 注意:这里不能设 st.died —— 它表示「这一位君主已经死亡」的标记,新一代君主还得接着按寿命自然死亡。
  const text = `${prev?.name ?? `P${polityId}`} ${reason},后代 ${heir.name} 继位(培养 ${heir.growth} 次)`;
  st.journal = [...(st.journal ?? []), { year, kind: 'succession', text }];
  const book = s.memory?.get(polityId);
  if (book) addMemory(book, { year, kind: 'dynasty', text, weight: 0.7, source: 'engine' });
  return { name: heir.name, text };
}

function heirPersona(heir: MonarchHeir, parentName: string): string {
  const bits = [
    `你是${heir.name},${parentName ? `${parentName}的后代。` : ''}`,
    '自小在宫廷里长大,听惯了朝臣的争论,也见过边关的烽火。',
    `你的性格被身边人这样形容:谨慎 ${heir.traits.caution}、野心 ${heir.traits.ambition}、荣誉 ${heir.traits.honor}、贪欲 ${heir.traits.greed}。`,
    '你知道自己迟早要接过这个国家,所以一直在学着判断人、判断时机。',
  ];
  return bits.join('').slice(0, 200);
}

/** 自然死亡检查:满寿命的君主走继位(没有后代则记摄政,等引擎自己的继承) */
function checkNaturalDeath(s: Session, polityId: number, year: number): { name: string; text: string } | null {
  const st = polityStateOf(s, polityId);
  if (st.died !== undefined) return null;
  const card = s.cards?.get(polityId);
  if (!card) return null;
  const lifespan = card.raceSystem ? card.lifespan : s.monarch?.lifespan ?? CARD_LIFESPAN_DEFAULT;
  const died = card.born + lifespan;
  if (year < died) return null;
  return succeedByHeir(s, polityId, year, `在第 ${year} 年去世(享年 ${year - card.born} 岁)`);
}

/** 测试/回放注入:直接给某个国家一份决策,跳过 LLM/mock(生产路径不传) */
export interface MonarchDecisionInjection {
  reason?: string;
  commands?: unknown[];
}

/** 跑一个回合的方案:简报 → 并发 LLM/mock → 编译 → 渗透判定 → 高影响命令审核;不推演 */
export async function monarchPlan(
  s: Session,
  opts: { years?: number; decisions?: Record<number, MonarchDecisionInjection> } = {},
): Promise<MonarchPlan> {
  if (!s.features.llm) throw new Error('本局没有打开「LLM 扮演」;仅 Jev 时请用小事件回合(civ_petty_round)');
  const cfg = configOf(s);
  if (s.rounds >= s.maxRounds) throw new Error(`会话已经跑满 ${s.maxRounds} 回合`);
  if (s.endYear !== undefined && s.play.year >= s.endYear) throw new Error(`会话已经到第 ${s.play.year} 年(>= endYear ${s.endYear})`);

  const year = Math.floor(s.play.year);
  const planYears = Math.max(1, Math.round(opts.years ?? s.stepYears));
  const ids = aiMonarchIds(s, pickMonarchIds(s.civ, s.play.year, cfg.polities));
  // 控制方式为 'program' 的国家不交给 LLM:留 0 个 AI 国也合法,本回合由引擎自动推演它们
  ensureCards(s, ids, year);

  // P5:先处理自然死亡(满寿命走继位),再算本回合 AP 账本
  const monarchEvents: MonarchPlan['monarchEvents'] = [];
  for (const id of ids) {
    const died = checkNaturalDeath(s, id, year);
    if (died) monarchEvents.push({ polityId: id, kind: 'succession', text: died.text });
  }
  const apById = new Map<number, MonarchRoundAp>();
  for (const id of ids) {
    const breakdown = monarchApBreakdown(s.civ, id, year, planYears);
    const ap: MonarchRoundAp = { year, apTotal: breakdown.apTotal, apSpent: 0, log: [] };
    apById.set(id, ap);
    polityStateOf(s, id).roundAp = ap;
    ensureLocation(s, id, year);
  }

  const briefs = buildMonarchBriefs(s.civ, s.play, ids);
  const turnIndex = s.rounds;

  const settled = await Promise.all(
    briefs.map(async (brief): Promise<{ brief: MonarchBrief; source: 'mock' | 'llm'; decision: ParsedDecision; ms?: number; promptTokens?: number; cachedTokens?: number; error?: string }> => {
      const card = s.cards!.get(brief.polityId) ?? null;
      const memory = s.memory!.get(brief.polityId);
      const regions = regionTable(s.civ, brief.polityId, year);
      const intel = brief.neighbors.map((n) => foreignIntel(s.civ, n.id, year, s.intel?.[String(brief.polityId)]?.[String(n.id)]));
      const injected = opts.decisions?.[brief.polityId];
      if (injected) return { brief, source: 'mock', decision: { reason: injected.reason ?? '注入的测试决策', commands: injected.commands ?? [] } };
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
    const ap = apById.get(brief.polityId)!;
    if (item.error) {
      decisions.push({
        polityId: brief.polityId,
        name: brief.name,
        key: brief.key,
        source: 'error',
        reason: '',
        rawCommands: [],
        commands: [],
        rejected: [],
        actions: [],
        ap: { apTotal: ap.apTotal, apSpent: 0, remaining: ap.apTotal, stepMonths: stepMonthsOf(planYears) },
        error: item.error,
      });
      continue;
    }
    const parsed = item.decision;
    const split = splitSpecialOrders(parsed.commands ?? []);
    const compiled = compileMonarchOrders(s.civ, s.play.year, brief.polityId, split.engine);
    const campaign = hasCampaign(compiled.commands, split.special);
    const actions: MonarchSpecialRecord[] = [];
    for (const raw of split.special) {
      const kind = raw.kind as SpecialActionKind;
      const cost = SPECIAL_ACTION_AP[kind] ?? 0;
      const read = readSpecial(s, brief.polityId, year, raw);
      const planned = read.planned;
      // 培养后代要占掉整回合:同一回合还有亲征/派兵/开战/主动出击就不许
      if (kind === 'cultivate-heir' && campaign) {
        actions.push({ kind, cost, ok: false, reason: '本回合有战事,培养后代要占用整回合主行动' });
        continue;
      }
      if (!planned) {
        actions.push({ kind, cost, ok: false, reason: read.reason ?? '动作不合法' });
        continue;
      }
      if (read.reason) {
        actions.push({ kind, cost, ok: false, reason: read.reason, ...(planned.target ? { target: planned.target } : {}), ...(planned.regionId !== undefined ? { regionId: planned.regionId } : {}) });
        continue;
      }
      if (!chargeAp(ap, SPECIAL_ACTION_NAMES[kind], cost, planned.target)) {
        actions.push({ kind, cost, ok: false, reason: '行动点不够', ...(planned.target ? { target: planned.target } : {}), ...(planned.regionId !== undefined ? { regionId: planned.regionId } : {}) });
        continue;
      }
      actions.push({
        kind,
        cost,
        ok: true,
        ...(planned.target ? { target: planned.target } : {}),
        ...(planned.targetPolityId !== undefined ? { targetPolityId: planned.targetPolityId } : {}),
        ...(planned.regionId !== undefined ? { regionId: planned.regionId } : {}),
      });
    }
    // 引擎命令同样吃 AP 预算:超支的命令不进 commands,写 rejected 并记 ap.log
    const keptCommands: Intervention[] = [];
    for (const cmd of compiled.commands) {
      const cost = commandAp(s, cmd);
      const target = commandTargetLabel(s, cmd);
      if (!chargeAp(ap, String(cmd.kind), cost, target)) {
        compiled.rejected.push({ order: cmd, reason: `行动点不够:${cmd.kind} 要 ${cost} AP` });
        continue;
      }
      keptCommands.push(cmd);
    }
    const card = s.cards!.get(brief.polityId);
    decisions.push({
      polityId: brief.polityId,
      name: brief.name,
      key: brief.key,
      source: item.source,
      reason: parsed.reason ?? '',
      rawCommands: parsed.commands ?? [],
      commands: keptCommands,
      rejected: compiled.rejected,
      actions,
      ap: { apTotal: ap.apTotal, apSpent: ap.apSpent, remaining: ap.apTotal - ap.apSpent, stepMonths: stepMonthsOf(planYears) },
      ...(parsed.remember ? { remember: cleanMemoryWrites(parsed.remember, year) } : {}),
      ...(item.ms !== undefined ? { ms: item.ms } : {}),
      ...(item.promptTokens !== undefined ? { promptTokens: item.promptTokens } : {}),
      ...(item.cachedTokens !== undefined ? { cachedTokens: item.cachedTokens } : {}),
    });
    if (card) auditEntries.push({ polityId: brief.polityId, brief, card, commands: keptCommands });
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
    years: planYears,
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
    ap: {
      stepMonths: stepMonthsOf(planYears),
      byPolity: decisions.map((d) => {
        const ap = apById.get(d.polityId);
        return {
          polityId: d.polityId,
          name: d.name,
          apTotal: ap?.apTotal ?? 0,
          apSpent: ap?.apSpent ?? 0,
          remaining: Math.max(0, (ap?.apTotal ?? 0) - (ap?.apSpent ?? 0)),
          breakdown: monarchApBreakdown(s.civ, d.polityId, year, planYears),
          log: [...(ap?.log ?? [])],
        };
      }),
    },
    monarchEvents,
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
  // P5:安抚地方落地为对本国目标州的一次 boost(发展)干预,和本回合命令一起交给引擎
  const specialCommands: Intervention[] = [];
  for (const d of plan.decisions) {
    for (const a of d.actions ?? []) {
      if (!a.ok || a.kind !== 'pacify-region' || a.regionId === undefined) continue;
      const cmd = cleanIntervention({
        kind: 'boost',
        a: polityKey(s.civ, d.polityId),
        from: plan.fromYear,
        mul: PACIFY_BOOST_MUL,
        regions: [regionKey(s.civ, a.regionId)],
      });
      if (cmd) specialCommands.push(cmd);
    }
  }
  const engineCommands = [...kept, ...specialCommands, ...plan.pettyCommands, ...plan.dmCommands];
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

  // P5:特殊动作的长期效果落地(后代成长 / 亲征风险 / 派兵 / 安抚 / 位置与日志)
  const monarchEvents: MonarchPlan['monarchEvents'] = [...plan.monarchEvents];
  for (const d of plan.decisions) {
    const actions = d.actions ?? [];
    if (!actions.length) continue;
    const st = polityStateOf(s, d.polityId);
    for (const a of actions) {
      if (!a.ok) continue;
      if (a.kind === 'cultivate-heir') {
        const heirs = (st.heirs ??= []);
        const last = heirs[heirs.length - 1];
        if (last) {
          last.growth += CULTIVATE_HEIR_GROWTH;
          monarchEvents.push({ polityId: d.polityId, kind: 'heir', text: `${d.name} 继续培养后代 ${last.name}(培养 ${last.growth} 次)` });
        } else {
          const heir = makeHeir(s, d.polityId, plan.fromYear);
          heirs.push(heir);
          monarchEvents.push({ polityId: d.polityId, kind: 'heir', text: `${d.name} 培养出后代 ${heir.name}` });
        }
      } else if (a.kind === 'lead-army') {
        const years = Math.max(1, plan.years);
        const wars = activeWarIds(s.civ, d.polityId, plan.fromYear);
        const risk = leadArmyRisk(s.civ.seed, d.polityId, plan.fromYear, years);
        const where = wars.length ? `亲临 ${wars.length} 场战事` : '在边境整军';
        if (risk.outcome === 'death') {
          const died = succeedByHeir(s, d.polityId, plan.fromYear, `御驾亲征时阵亡(风险判定 ${risk.roll.toFixed(3)} < ${risk.deathRate.toFixed(3)})`);
          if (died) monarchEvents.push({ polityId: d.polityId, kind: 'death', text: died.text });
        } else if (risk.outcome === 'captured') {
          st.capturedUntil = turn.toYear + 1;
          const text = `${d.name} ${where},被敌军俘获(到第 ${st.capturedUntil} 年才能视事)`;
          st.journal = [...(st.journal ?? []), { year: plan.fromYear, kind: 'captured', text }];
          monarchEvents.push({ polityId: d.polityId, kind: 'captured', text });
        } else {
          const text = `${d.name} ${where},安然还朝`;
          st.journal = [...(st.journal ?? []), { year: plan.fromYear, kind: 'lead-army', text }];
          monarchEvents.push({ polityId: d.polityId, kind: 'lead-army', text });
        }
      } else if (a.kind === 'dispatch-army') {
        const text = `${d.name} ${a.target ? `派兵出征「${a.target}」` : '派兵出征'}`;
        st.journal = [...(st.journal ?? []), { year: plan.fromYear, kind: 'dispatch-army', text }];
        monarchEvents.push({ polityId: d.polityId, kind: 'dispatch-army', text });
      } else if (a.kind === 'pacify-region') {
        const text = `${d.name} 安抚了${a.target ?? '地方'}`;
        st.journal = [...(st.journal ?? []), { year: plan.fromYear, kind: 'pacify', text }];
        monarchEvents.push({ polityId: d.polityId, kind: 'pacify', text });
      }
    }
    // 回合推完:君主位置跟着国都走(国都迁了 / 旧州丢了)
    const home = ensureLocation(s, d.polityId, turn.toYear);
    if (home !== null) st.location = { regionId: home };
    st.journal = (st.journal ?? []).slice(-40);
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
    ap: plan.ap,
    ...(monarchEvents.length ? { monarchEvents } : {}),
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
    decisions: plan.decisions.map((d) => ({ polityId: d.polityId, source: d.source, commands: d.commands.length, rejected: d.rejected.length, error: d.error ?? null, cachedTokens: d.cachedTokens ?? null, ap: d.ap ?? null, actions: (d.actions ?? []).map((a) => ({ kind: a.kind, cost: a.cost, ok: a.ok })) })),
    audits: plan.audits.map((a) => ({ polityId: a.polityId, kind: a.kind, outcome: a.outcome, source: a.source })),
    intel: plan.intel.resolutions,
    ap: plan.ap.byPolity.map((p) => ({ polityId: p.polityId, apTotal: p.apTotal, apSpent: p.apSpent, remaining: p.remaining })),
    ...(monarchEvents.length ? { monarchEvents } : {}),
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
    ap: plan.ap,
    ...(monarchEvents.length ? { monarchEvents } : {}),
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
