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
} from './llm';
import { decideDm, type DmDecisionOutcome } from './dm';
import { MONARCH_SYSTEM_PROMPT, monarchUserPrompt } from './prompt';

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
  const ids = pickMonarchIds(s.civ, s.play.year, cfg ? cfg.polities : 'all');
  const briefs = buildMonarchBriefs(s.civ, s.play, ids);
  return {
    sessionId: s.id,
    year: s.play.year,
    stepYears: s.stepYears,
    polities: briefs.length,
    briefs,
    note: cfg
      ? 'briefs[].text 是发给对应君主的完整提示;不调用 LLM,也不改任何状态'
      : '还没配置君主模式,这里按全部在世国家出简报;先调 civ_monarch_setup 才会按配置的国家出',
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
  error?: string;
  ms?: number;
}

export interface MonarchRoundResult {
  sessionId: string;
  round: number;
  fromYear: number;
  toYear: number;
  years: number;
  decisions: MonarchDecisionRecord[];
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
}

/** 跑一个君主回合:简报 → 并发 LLM/mock → 编译命令 → 统一 turnStep → 写日志 */
export async function monarchRound(s: Session, opts: { years?: number } = {}): Promise<MonarchRoundResult> {
  const cfg = configOf(s);
  if (s.rounds >= s.maxRounds) throw new Error(`会话已经跑满 ${s.maxRounds} 回合`);
  if (s.endYear !== undefined && s.play.year >= s.endYear) throw new Error(`会话已经到第 ${s.play.year} 年(>= endYear ${s.endYear})`);

  const year = Math.floor(s.play.year);
  const ids = pickMonarchIds(s.civ, s.play.year, cfg.polities);
  if (!ids.length) throw new Error(`第 ${year} 年没有在世的君主可接管`);
  const briefs = buildMonarchBriefs(s.civ, s.play, ids);
  const turnIndex = s.rounds;

  const settled = await Promise.all(
    briefs.map(async (brief): Promise<{ brief: MonarchBrief; source: 'mock' | 'llm'; decision: unknown; ms?: number; error?: string }> => {
      if (cfg.mock) {
        return { brief, source: 'mock', decision: mockDecision(brief, turnIndex) };
      }
      try {
        const reply = await askLlm(
          [
            { role: 'system', content: MONARCH_SYSTEM_PROMPT },
            { role: 'user', content: monarchUserPrompt(brief) },
          ],
          cfg.provider,
        );
        return { brief, source: 'llm', decision: parseDecision(reply.text), ms: reply.ms };
      } catch (e) {
        return { brief, source: 'llm', decision: { reason: '', commands: [] }, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );

  // 命令按国家编号固定顺序落地,和 LLM 的返回快慢无关
  const ordered = [...settled].sort((a, b) => a.brief.polityId - b.brief.polityId);
  const decisions: MonarchDecisionRecord[] = [];
  const allCommands: Intervention[] = [];
  for (const item of ordered) {
    const brief = item.brief;
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
        error: item.error,
      });
      continue;
    }
    const parsed = item.decision as { reason?: string; commands?: unknown[] };
    const compiled = compileMonarchOrders(s.civ, s.play.year, brief.polityId, parsed.commands ?? []);
    allCommands.push(...compiled.commands);
    decisions.push({
      polityId: brief.polityId,
      name: brief.name,
      key: brief.key,
      source: item.source,
      reason: parsed.reason ?? '',
      rawCommands: parsed.commands ?? [],
      commands: compiled.commands,
      rejected: compiled.rejected,
      ...(item.ms !== undefined ? { ms: item.ms } : {}),
    });
  }

  // 同一回合的 DM 小决策(天灾/小贸易):和君主命令一起,在同一刻交给引擎
  let dm: MonarchRoundResult['dm'] | undefined;
  const dmCommands: Intervention[] = [];
  if (s.dm) {
    try {
      const out = await decideDm(s);
      dmCommands.push(...out.commands);
      dm = {
        source: out.source,
        reason: out.reason,
        decisions: out.decisions,
        commands: out.commands.length,
        rejected: out.rejected.length,
        notes: out.notes,
      };
    } catch (e) {
      dm = {
        source: 'llm',
        reason: '',
        decisions: [],
        commands: 0,
        rejected: 0,
        notes: [],
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  submitOrders(s, dmCommands.length ? [...allCommands, ...dmCommands] : allCommands);
  const turn = turnStep(s, { years: opts.years });

  const record: Record<string, unknown> = {
    sessionId: s.id,
    round: turn.round,
    fromYear: turn.fromYear,
    toYear: turn.toYear,
    years: turn.years,
    year,
    decisions,
    engineRejected: turn.rejected,
    changes: turn.polities,
    events: turn.events,
    fingerprint: turn.fingerprint,
    briefs: briefs.map((b) => ({ polityId: b.polityId, name: b.name, text: b.text })),
    ...(dm ? { dm } : {}),
  };
  s.monarch!.rounds.push(record);
  const path = join(s.logDir, `monarch-round-${String(turn.round).padStart(4, '0')}.json`);
  writeFileSync(path, JSON.stringify(record, null, 2));
  appendFileSync(join(s.logDir, 'monarch-rounds.jsonl'), JSON.stringify({
    round: turn.round,
    fromYear: turn.fromYear,
    toYear: turn.toYear,
    decisions: decisions.map((d) => ({ polityId: d.polityId, source: d.source, commands: d.commands.length, rejected: d.rejected.length, error: d.error ?? null })),
    ...(dm ? { dm: { source: dm.source, decisions: dm.decisions.length, commands: dm.commands, error: dm.error ?? null } } : {}),
    fingerprint: turn.fingerprint,
  }) + '\n');

  return {
    sessionId: s.id,
    round: turn.round,
    fromYear: turn.fromYear,
    toYear: turn.toYear,
    years: turn.years,
    decisions,
    ...(dm ? { dm } : {}),
    engineRejected: turn.rejected,
    changes: turn.polities,
    events: turn.events,
    finished: turn.finished,
    fingerprint: turn.fingerprint,
  };
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
