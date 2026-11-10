/**
 * 小事件裁决层 · Resolver(回合编排)。
 *
 * 每回合：
 *   1. 扫描当前局势 → 生成候选小事件(只来自 registry 里登记过的模式)；
 *   2. 按优先级 P0→P1→P2 分批，ContextBudgetManager 控 token；
 *   3. OpenJevQueue 严格串行地调官方 Jev(或 mock)；
 *   4. 概率 → 用引擎统一随机流派生的 keyed 抽签 → 选项；
 *   5. 选项效果编译成引擎干预(disaster / petty)，取不到目标 = 记日志跳过；
 *   6. 写回合日志(含 token/队列统计)，并给 DM 提供"已结算摘要"。
 *
 * 失败/超时/格式错误 → 该批走引擎确定性降级规则(circuit breaker 见队列)。
 * 确定性：抽样只用 keyed(seed, year, polityId, modeIndex)；HTTP 结果本身不可复现，
 * 但每回合把概率、抽签数与命令落盘，回放时用已结算命令即可。
 */
import { polityKey, regionKey, settlementKey, cleanInterventions, type Intervention } from '../src/gen/edits';
import { capitalAt, populationAt } from '../src/gen/civ/growth';
import type { Session } from './engine';
import { getSession, submitOrders, turnStep } from './engine';
import { PETTY_MODES, PETTY_PRIORITY_NUM, pickByWeight, pettyMode, pettyRoll, type PettyMode, type PettyModeId, type PettyProfile } from '../src/gen/civ/petty';
import { askJev, jevSettings, jevSettingsView, type JevQuestion, type JevSettings } from './petty-client';
import { estimateCostUsd, estimateTokens, planPettyBatch, type PettyBudgetConfig, type PettyBudgetConfigResolved, type PettyQuestionSpec } from './petty-budget';
import { PettyQueue, type PettyQueueStats } from './petty-queue';

export interface PettySetupInput {
  mock?: boolean;
  profile?: PettyProfile;
  maxQuestions?: number;
  budget?: Partial<PettyBudgetConfig>;
  queue?: { maxPending?: number; roundWaitMs?: number; failuresToTrip?: number };
  // 官方 Jev 客户端参数(不传 = 环境变量；mock=true 时可不传)
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  probe?: boolean;
}

export interface PettyConfig {
  mock: boolean;
  profile: PettyProfile;
  maxQuestions: number;
  budget: PettyBudgetConfigResolved;
  queue: { maxPending: number; roundWaitMs: number; failuresToTrip: number };
  client: JevSettings | null;
}

interface PettyRuntime {
  config: PettyConfig;
  queue: PettyQueue;
}

const runtimes = new Map<string, PettyRuntime>();

const clampInt = (v: unknown, lo: number, hi: number, name: string): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} 必须是数字`);
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

export function pettyRuntime(sessionId: string): PettyRuntime | null {
  return runtimes.get(sessionId) ?? null;
}

/** 配置小事件裁决层；mock=true 时完全离线。 */
export async function pettySetup(s: Session, input: PettySetupInput): Promise<{ sessionId: string; petty: PettyStatus }> {
  const mock = input.mock === true;
  const profile: PettyProfile = input.profile ?? 'L2';
  if (profile !== 'L1' && profile !== 'L2' && profile !== 'L3') throw new Error('profile 只能是 L1 / L2 / L3');
  const maxQuestions = clampInt(input.maxQuestions ?? 8, 1, 64, 'maxQuestions');
  const budget: PettyBudgetConfigResolved = {
    hardTokens: clampInt(input.budget?.hardTokens ?? 4250, 200, 200_000, 'hardTokens'),
    targetTokens: clampInt(input.budget?.targetTokens ?? 4000, 200, 200_000, 'targetTokens'),
    maxQuestions: clampInt(input.budget?.maxQuestions ?? maxQuestions, 1, 64, 'maxQuestions'),
    envRatio: typeof input.budget?.envRatio === 'number' ? input.budget.envRatio : 0.45,
  };
  if (budget.targetTokens > budget.hardTokens) budget.targetTokens = budget.hardTokens;
  const queueOpts = {
    maxPending: clampInt(input.queue?.maxPending ?? 40, 1, 10_000, 'maxPending'),
    roundWaitMs: clampInt(input.queue?.roundWaitMs ?? 120_000, 100, 3_600_000, 'roundWaitMs'),
    failuresToTrip: clampInt(input.queue?.failuresToTrip ?? 5, 1, 1_000, 'failuresToTrip'),
  };
  const client = mock
    ? null
    : jevSettings({
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      });
  const config: PettyConfig = { mock, profile, maxQuestions, budget, queue: queueOpts, client };
  const prev = runtimes.get(s.id);
  const queue = prev?.queue ?? new PettyQueue(queueOpts);
  runtimes.set(s.id, { config, queue });
  s.petty = { config: configView(config), rounds: [] };
  let probe: { ok: boolean; ms: number; error?: string } | null = null;
  if (input.probe === true) probe = await probePetty(s);
  return { sessionId: s.id, petty: { ...pettyStatus(s), probe } as PettyStatus & { probe: typeof probe } };
}

function configView(c: PettyConfig): Record<string, unknown> {
  return {
    mock: c.mock,
    profile: c.profile,
    maxQuestions: c.maxQuestions,
    budget: c.budget,
    queue: c.queue,
    client: c.client ? jevSettingsView(c.client) : null,
  };
}

export interface PettyStatus {
  sessionId: string;
  configured: boolean;
  mock: boolean;
  profile: PettyProfile;
  maxQuestions: number;
  budget: PettyBudgetConfigResolved;
  client: ReturnType<typeof jevSettingsView> | null;
  rounds: number;
  queue: PettyQueueStats | null;
  last: { round: number; year: number; events: number; decided: number; fallback: number; commands: number } | null;
  note: string;
}

export function pettyStatus(s: Session): PettyStatus {
  const rt = runtimes.get(s.id);
  const config = rt?.config ?? null;
  // 君主回合会把小事件摘要嵌在 monarch rounds 里(不单独写 s.petty.rounds)
  const embedded = (s.monarch?.rounds ?? [])
    .map((r) => (r as Record<string, unknown>).petty as Record<string, unknown> | undefined)
    .filter((x): x is Record<string, unknown> => !!x);
  const own = (s.petty?.rounds ?? []) as Record<string, unknown>[];
  const last = (own.at(-1) ?? embedded.at(-1) ?? null) as Record<string, unknown> | null;
  const decided = last
    ? Array.isArray(last.decisions)
      ? last.decisions.length
      : Number(last.decisions ?? 0)
    : 0;
  const summarized = last
    ? {
        round: Number(last.round ?? 0),
        year: Number(last.year ?? 0),
        events: Number(last.events ?? 0),
        decided,
        fallback: Number(last.fallback ?? last.fallbackCount ?? 0),
        commands: Number(last.commands ?? 0),
      }
    : null;
  return {
    sessionId: s.id,
    configured: !!config,
    mock: config?.mock ?? false,
    profile: config?.profile ?? 'L2',
    maxQuestions: config?.maxQuestions ?? 8,
    budget: config?.budget ?? { hardTokens: 4250, targetTokens: 4000, maxQuestions: 8, envRatio: 0.45 },
    client: config?.client ? jevSettingsView(config.client) : null,
    rounds: own.length + embedded.length,
    queue: rt ? rt.queue.stats : null,
    last: summarized,
    note: config
      ? config.mock
        ? 'mock 模式：不联网，按固定规则出答案，用来演示/测试'
        : `官方 Jev：${config.client?.baseUrl ?? ''} · ${config.client?.model ?? ''}`
      : '还没配置小事件裁决层；先调用 civ_petty_setup',
  };
}

/** 探活：mock 恒通过；真服务发一个最小 noul 问题。 */
export async function probePetty(s: Session): Promise<{ ok: boolean; ms: number; error?: string }> {
  const rt = runtimes.get(s.id);
  if (!rt) return { ok: false, ms: 0, error: '还没配置小事件裁决层' };
  if (rt.config.mock) return { ok: true, ms: 0 };
  try {
    await askJev({ ping: { type: 'noul', instructions: '这是一次连通性测试，请随便回答。' } }, '连通性测试', rt.config.client!);
    return { ok: true, ms: 0 };
  } catch (e) {
    return { ok: false, ms: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------
// 扫描：从当前局势生成候选小事件
// ---------------------------------------------------------------------------

export interface PettyEvent {
  id: string;
  modeId: PettyModeId;
  mode: PettyMode;
  priority: 0 | 1 | 2;
  polityId: number;
  polityName: string;
  year: number;
  region: number;
  city: number;
  question: JevQuestion;
}

interface PolityBrief {
  id: number;
  name: string;
  size: number;
  capital: number;
  region: number;
  neighbors: number[];
  atWar: boolean;
}

const TOP_POLITIES = 6;

function polityBriefs(s: Session): PolityBrief[] {
  const civ = s.civ;
  const year = s.play.year;
  const sizes = new Map<number, number>();
  for (let r = 0; r < civ.polity.length; r++) {
    const p = civ.polity[r];
    if (p >= 0) sizes.set(p, (sizes.get(p) ?? 0) + 1);
  }
  const atWar = new Set<number>();
  for (const a of civ.annals) {
    if (a.kind === 'war' && a.a >= 0) atWar.add(a.a);
  }
  const out: PolityBrief[] = [];
  for (const [id, size] of [...sizes.entries()].sort((x, y) => y[1] - x[1] || x[0] - y[0])) {
    if (out.length >= TOP_POLITIES) break;
    const P = civ.polities[id];
    if (!P || P.ended !== undefined) continue;
    const cap = capitalAt(P, year);
    const region = cap >= 0 && civ.settlements[cap] ? civ.settlements[cap].region : -1;
    out.push({
      id,
      name: P.name,
      size,
      capital: cap,
      region,
      neighbors: [],
      atWar: atWar.has(id),
    });
  }
  return out;
}

const MODE_TRIGGER_RATE = (mode: PettyMode): number => (mode.priority === 'P0' ? 0.3 : mode.priority === 'P1' ? 0.25 : 0.15);

function modesForProfile(profile: PettyProfile): readonly PettyMode[] {
  if (profile === 'L1') return PETTY_MODES.filter((m) => m.priority === 'P0');
  if (profile === 'L2') return PETTY_MODES.filter((m) => m.priority !== 'P2');
  return PETTY_MODES;
}

/** 从局势里扫候选小事件(确定性；同一 seed/年份/国家 → 同一批)。 */
export function scanPettyEvents(s: Session, opts: { profile: PettyProfile; maxEvents?: number }): PettyEvent[] {
  const civ = s.civ;
  const year = s.play.year;
  const briefs = polityBriefs(s);
  const events: PettyEvent[] = [];
  const modes = modesForProfile(opts.profile);
  for (const b of briefs) {
    for (let mi = 0; mi < modes.length; mi++) {
      const mode = modes[mi];
      // 触发判定：确定性触发器 + 一点局势门槛
      const roll = pettyRoll(civ.seed, year, b.id, 1000 + mi);
      if (roll >= MODE_TRIGGER_RATE(mode)) continue;
      if (mode.domain === 'military' && (mode.id === 'ambush' || mode.id === 'siege_morale') && !b.atWar) continue;
      if ((mode.id === 'riot' || mode.id === 'ambush') && b.capital < 0) continue;
      if (mode.id === 'market_shortage' && b.size < 4) continue;
      if (mode.id === 'plague_seed' && b.capital < 0) continue;
      const region = b.region >= 0 ? b.region : firstRegion(civ, b.id);
      const city = b.capital >= 0 ? b.capital : -1;
      const priority = PETTY_PRIORITY_NUM[mode.priority];
      const question = {
        type: mode.question.type,
        instructions: mode.question.instructions,
      } as JevQuestion;
      if (mode.question.criteria !== undefined) {
        if (Array.isArray(mode.question.criteria)) question.criteria = [...mode.question.criteria];
        else question.criteria = { ...(mode.question.criteria as Record<string, string>) };
      }
      events.push({
        id: `${mode.id}:${year}:${b.id}`,
        modeId: mode.id,
        mode,
        priority,
        polityId: b.id,
        polityName: b.name,
        year,
        region,
        city,
        question,
      });
    }
  }
  events.sort((a, b) => a.priority - b.priority || a.polityId - b.polityId || a.modeId.localeCompare(b.modeId));
  const max = opts.maxEvents ?? 24;
  return events.slice(0, max);
}

function firstRegion(civ: Session['civ'], polity: number): number {
  for (let r = 0; r < civ.polity.length; r++) if (civ.polity[r] === polity) return r;
  return -1;
}

// ---------------------------------------------------------------------------
// 环境描述(给 Jev 的 state)
// ---------------------------------------------------------------------------

export function buildPettyContext(s: Session, events: PettyEvent[]): string {
  const civ = s.civ;
  const year = s.play.year;
  const briefs = polityBriefs(s);
  const lines: string[] = [];
  lines.push(`第 ${year} 年，天下共有 ${briefs.length} 个主要国家。`);
  for (const b of briefs) {
    const capName = b.capital >= 0 ? civ.settlements[b.capital]?.name ?? '无名城' : '没有城';
    const regionName = b.region >= 0 ? civ.regionNames?.[b.region] ?? `第 ${b.region} 州` : '无';
    lines.push(`- ${b.name}：${b.size} 州；国都 ${capName}（${regionName}）；${b.atWar ? '正在打仗' : '没有大战'}。`);
  }
  const recent = civ.annals
    .filter((a) => a.kind === 'war' || a.kind === 'peace' || a.kind === 'famine' || a.kind === 'plague' || a.kind === 'split' || a.kind === 'collapse')
    .slice(-5);
  if (recent.length) {
    lines.push('最近发生的大事：');
    for (const a of recent) lines.push(`- 第 ${Math.floor(a.year)} 年：${annalLabel(a.kind)}。`);
  }
  const byId = new Map(briefs.map((b) => [b.id, b]));
  lines.push('本回合待裁决的小事：');
  for (const e of events) {
    const b = byId.get(e.polityId);
    const cap = e.city >= 0 ? civ.settlements[e.city]?.name ?? '某城' : '某地';
    lines.push(`- ${e.mode.label}（${b?.name ?? '某国'}，${cap}）：${e.mode.question.instructions}`);
  }
  return lines.join('\n');
}

const ANNAL_LABELS: Partial<Record<string, string>> = {
  war: '爆发战争',
  peace: '议和',
  famine: '闹饥荒',
  plague: '爆发瘟疫',
  split: '国家分裂',
  collapse: '王朝崩溃',
};

const annalLabel = (kind: string): string => ANNAL_LABELS[kind] ?? kind;

// ---------------------------------------------------------------------------
// 答案 → 选项 → 效果
// ---------------------------------------------------------------------------

export interface PettyDecisionResult {
  eventId: string;
  modeId: PettyModeId;
  polityId: number;
  polityName: string;
  option: string | null;
  optionLabel: string | null;
  probabilities: Record<string, number>;
  roll: number;
  source: 'jev' | 'mock' | 'engine-rule';
  effect: string | null;
  command: Intervention | null;
  note?: string;
  error?: string;
}

function weightsFor(mode: PettyMode, answer: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!answer || typeof answer !== 'object') return out;
  const a = answer as Record<string, unknown>;
  const type = a.type;
  if (type === 'noul') {
    const p = typeof a.noul === 'number' && Number.isFinite(a.noul) ? Math.min(1, Math.max(0, a.noul)) : 0.5;
    out.yes = p;
    out.no = 1 - p;
    return out;
  }
  const probs = a.probabilities;
  if (probs && typeof probs === 'object') {
    for (const o of mode.options) {
      const v = (probs as Record<string, unknown>)[o.key];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[o.key] = v;
    }
  }
  return out;
}

function effectMemory(modeId: PettyModeId, optionKey: string | null): { effect: string | null; optionLabel: string | null } {
  if (optionKey === null) return { effect: null, optionLabel: null };
  const mode = pettyMode(modeId);
  const option = mode.options.find((o) => o.key === optionKey) ?? null;
  if (!option) return { effect: null, optionLabel: null };
  const e = option.effect;
  let effect: string | null = null;
  if (e?.disaster) effect = `disaster:${e.disaster.type}:L${e.disaster.level ?? 2}`;
  else if (e?.sack) effect = `sack:${e.sack.loss}`;
  else if (e?.dev) effect = `dev:${e.dev.years}`;
  else if (e?.note) effect = `note:${e.note}`;
  return { effect, optionLabel: option.label };
}

/** 把抽中的选项落成引擎命令(取不到目标 = null，由调用方记日志跳过)。 */
export function optionToCommand(s: Session, ev: PettyEvent, optionKey: string): { command: Intervention | null; note: string | null } {
  const civ = s.civ;
  const year = s.play.year;
  const mode = ev.mode;
  const option = mode.options.find((o) => o.key === optionKey);
  if (!option || !option.effect) return { command: null, note: null };
  const e = option.effect;
  const pKey = polityKey(civ, ev.polityId);
  if (e.disaster) {
    const d = e.disaster;
    const region = ev.region >= 0 ? ev.region : firstRegion(civ, ev.polityId);
    if (d.type === 'plague' || d.type === 'pandemic') {
      if (ev.city < 0) return { command: null, note: null };
      const cityKey = settlementKey(civ, ev.city);
      return {
        command: { kind: 'disaster', type: d.type, level: d.level ?? 2, from: year, city: cityKey } as Intervention,
        note: null,
      };
    }
    if (d.type === 'quake') {
      if (region < 0) return { command: null, note: null };
      return { command: { kind: 'disaster', type: 'quake', level: d.level ?? 2, from: year, region: regionKey(civ, region) } as Intervention, note: null };
    }
    // famine：优先落到具体州(有城才行)
    const target = region >= 0 ? region : ev.region;
    if (target < 0) return { command: { kind: 'disaster', type: 'famine', level: d.level ?? 2, from: year, a: pKey } as Intervention, note: null };
    return { command: { kind: 'disaster', type: 'famine', level: d.level ?? 2, from: year, regions: [regionKey(civ, target)] } as Intervention, note: null };
  }
  if (e.sack) {
    if (ev.city < 0) return { command: null, note: null };
    return {
      command: { kind: 'petty', a: pKey, from: year, effect: { type: 'sack', loss: e.sack.loss, city: settlementKey(civ, ev.city) } } as Intervention,
      note: null,
    };
  }
  if (e.dev) {
    return { command: { kind: 'petty', a: pKey, from: year, effect: { type: 'dev', years: e.dev.years } } as Intervention, note: null };
  }
  return { command: null, note: e.note ?? null };
}

function pickMockOption(mode: PettyMode, roll: number): string | null {
  const options = mode.options.filter((o) => o.effect !== null);
  if (!options.length) return null;
  const idx = Math.min(options.length - 1, Math.floor(roll * options.length));
  return options[idx].key;
}

function degradeOption(mode: PettyMode, roll: number): string | null {
  // 引擎降级规则：低概率事件默认不发生；只有 roll 落在最轻效果上才发生
  const options = mode.options.filter((o) => o.effect !== null);
  if (!options.length) return null;
  return roll < 0.15 ? options[0].key : null;
}

// ---------------------------------------------------------------------------
// 回合执行
// ---------------------------------------------------------------------------

export interface PettySettlement {
  sessionId: string;
  fromYear: number;
  /** 本回合推几年 */
  years: number;
  /** 本轮发给 Jev 的环境描述(日志/回放用) */
  context: string;
  profile: PettyProfile;
  mock: boolean;
  events: number;
  batches: { priority: 0 | 1 | 2; questions: number; tokens: number; overBudget: boolean; dropped: number }[];
  tokens: { env: number; shell: number; questions: number; total: number; inputReported: number | null; outputReported: number | null; costUsd: number | null };
  queue: PettyQueueStats;
  decisions: PettyDecisionResult[];
  /** 已清洗、可直接交给引擎的命令 */
  commands: Intervention[];
  fallbackCount: number;
  events_log: string[];
}

export interface PettyRoundResult extends PettySettlement {
  round: number;
  toYear: number;
  year: number;
  engineRejected: unknown[];
  changes: { id: number; name: string; size: number; delta: number }[];
  finished: boolean;
  fingerprint: string;
  note?: string;
}

/**
 * 只结算小事件，不推进引擎、不写日志。
 * 君主回合会先调它拿到命令，再和君主命令一起走同一次 turnStep。
 */
export async function settlePetty(s: Session, opts: { years?: number } = {}): Promise<PettySettlement> {
  const rt = runtimes.get(s.id);
  if (!rt) throw new Error('还没配置小事件裁决层；先调用 civ_petty_setup');
  if (s.mode === 'monarch' && !s.petty) throw new Error('这个会话的 petty 状态丢了；请重新 setup');
  const queue = rt.queue;
  const cfg = rt.config;
  const fromYear = s.play.year;
  const years = clampInt(opts.years ?? s.stepYears, 1, 1000, 'years');
  const events = scanPettyEvents(s, { profile: cfg.profile, maxEvents: cfg.maxQuestions * 3 });
  const context = buildPettyContext(s, events);
  queue.beginRound();
  if (queue.isTripped) {
    const probe = await probePetty(s);
    if (probe.ok) queue.reset();
  }

  const decisions: PettyDecisionResult[] = [];
  const commands: Intervention[] = [];
  const batches: PettyRoundResult['batches'] = [];
  let inputReported: number | null = null;
  let outputReported: number | null = null;
  let fallbackCount = 0;

  const groups: { priority: 0 | 1 | 2; evs: PettyEvent[] }[] = [];
  for (const priority of [0, 1, 2] as const) {
    const evs = events.filter((e) => e.priority === priority);
    if (evs.length) groups.push({ priority, evs });
  }

  for (const group of groups) {
    const specs: PettyQuestionSpec[] = group.evs.map((e) => {
      const spec: PettyQuestionSpec = {
        key: e.id,
        priority: e.priority,
        type: e.mode.question.type,
        instructions: e.mode.question.instructions,
        label: `${e.mode.label}·${e.polityName}`,
      };
      if (e.mode.question.criteria !== undefined) spec.criteria = e.mode.question.criteria as PettyQuestionSpec['criteria'];
      return spec;
    });
    let plan: ReturnType<typeof planPettyBatch>;
    try {
      plan = planPettyBatch(context, specs, cfg.budget);
    } catch (e) {
      // 预算层出错 = 整批降级，不让回合崩
      for (const e of group.evs) {
        fallbackCount++;
        decisions.push(degradeDecision(s, e, 'budget-error'));
      }
      batches.push({ priority: group.priority, questions: 0, tokens: 0, overBudget: false, dropped: group.evs.length });
      continue;
    }
    const planned = group.evs.filter((e) => plan.included.some((q) => q.key === e.id));
    batches.push({
      priority: group.priority,
      questions: planned.length,
      tokens: plan.tokens.total,
      overBudget: plan.tokens.overBudget,
      dropped: group.evs.length - planned.length,
    });
    if (!planned.length) {
      for (const e of group.evs) {
        fallbackCount++;
        decisions.push(degradeDecision(s, e, 'budget'));
      }
      continue;
    }

    const questions: Record<string, JevQuestion> = {};
    for (const e of planned) questions[e.id] = e.question;

    let answerMap: Record<string, unknown> | null = null;
    let source: 'jev' | 'mock' = 'mock';
    if (cfg.mock) {
      answerMap = {};
      for (const e of planned) answerMap[e.id] = mockAnswer(e, pettyRoll(s.civ.seed, fromYear, e.polityId, 2000 + PETTY_PRIORITY_NUM[e.mode.priority]));
    } else {
      try {
        const reply = await queue.enqueue(
          (signal) => askJev(questions, context, cfg.client!, { sessionId: s.id, signal }),
          { priority: group.priority, batchId: `petty-${s.id}-${s.rounds + 1}-p${group.priority}`, label: `P${group.priority}` },
        );
        source = 'jev';
        answerMap = reply.answers as unknown as Record<string, unknown>;
        if (reply.usage.inputTokens !== undefined) inputReported = (inputReported ?? 0) + reply.usage.inputTokens;
        if (reply.usage.outputTokens !== undefined) outputReported = (outputReported ?? 0) + reply.usage.outputTokens;
      } catch (e) {
        fallbackCount += planned.length;
        for (const ev of planned) decisions.push(degradeDecision(s, ev, e instanceof Error ? e.message : String(e)));
        continue;
      }
    }

    for (const ev of planned) {
      const answer = answerMap?.[ev.id];
      const weights = weightsFor(ev.mode, answer);
      const roll = pettyRoll(s.civ.seed, fromYear + (decisions.length % 3), ev.polityId, 3000 + PETTY_PRIORITY_NUM[ev.mode.priority]);
      const optionKey = Object.keys(weights).length ? pickByWeight(Object.entries(weights), roll) : null;
      if (optionKey === null) {
        fallbackCount++;
        decisions.push(degradeDecision(s, ev, 'no-answer'));
        continue;
      }
      const { effect, optionLabel } = effectMemory(ev.modeId, optionKey);
      const { command, note } = optionToCommand(s, ev, optionKey);
      if (command) commands.push(command);
      const decision: PettyDecisionResult = {
        eventId: ev.id,
        modeId: ev.modeId,
        polityId: ev.polityId,
        polityName: ev.polityName,
        option: optionKey,
        optionLabel,
        probabilities: weights,
        roll,
        source,
        effect,
        command,
      };
      if (note) decision.note = note;
      decisions.push(decision);
    }
  }

  const valid = cleanInterventions(commands);
  return {
    sessionId: s.id,
    fromYear,
    years,
    context,
    profile: cfg.profile,
    mock: cfg.mock,
    events: events.length,
    batches,
    tokens: {
      env: estimateTokens(context),
      shell: 60,
      questions: batches.reduce((a, b) => a + b.questions, 0),
      total: batches.reduce((a, b) => a + b.tokens, 0),
      inputReported,
      outputReported,
      costUsd: inputReported !== null ? estimateCostUsd(inputReported) : null,
    },
    queue: queue.stats,
    decisions,
    commands: valid,
    fallbackCount,
    events_log: events.map((e) => e.id),
  };
}

/** 跑一个独立的小事件回合：结算 → 交命令 → 推进引擎 → 写日志。 */
export async function pettyRound(s: Session, opts: { years?: number } = {}): Promise<PettyRoundResult> {
  const settlement = await settlePetty(s, opts);
  const submitted = submitOrders(s, settlement.commands);
  const step = turnStep(s, { years: settlement.years });
  const result: PettyRoundResult = {
    ...settlement,
    round: step.round,
    toYear: step.toYear,
    year: step.toYear,
    engineRejected: step.rejected as unknown[],
    changes: step.polities,
    finished: step.finished,
    fingerprint: step.fingerprint,
  };
  const logDir = s.logDir;
  const name = `petty-round-${String(result.round).padStart(4, '0')}`;
  try {
    const fs = await import('node:fs');
    fs.writeFileSync(
      `${logDir}/${name}.json`,
      JSON.stringify(
        {
          ...result,
          submitted,
          budget: {
            contextTokens: result.tokens.env,
            shellTokens: result.tokens.shell,
            hardTokens: 4250,
            targetTokens: 4000,
            batches: result.batches,
          },
        },
        null,
        2,
      ),
    );
    fs.appendFileSync(`${logDir}/petty-rounds.jsonl`, JSON.stringify(result) + '\n');
  } catch {
    // 日志写不进去不挡回合
  }
  s.petty?.rounds.push(result as unknown as Record<string, unknown>);
  return result;
}

function mockAnswer(ev: PettyEvent, roll: number): Record<string, unknown> {
  const mode = ev.mode;
  if (mode.question.type === 'noul') {
    const opt = mode.options.find((o) => o.effect !== null);
    return { type: 'noul', noul: roll < 0.2 && opt ? 0.75 : 0.2 };
  }
  const weights: Record<string, number> = {};
  for (const o of mode.options) weights[o.key] = o.effect ? 0.6 / Math.max(1, mode.options.filter((x) => x.effect).length) : 0.4 / Math.max(1, mode.options.filter((x) => !x.effect).length);
  return { type: mode.question.type, probabilities: weights };
}

function degradeDecision(s: Session, ev: PettyEvent, why: string): PettyDecisionResult {
  const roll = pettyRoll(s.civ.seed, ev.year, ev.polityId, 4000 + PETTY_PRIORITY_NUM[ev.mode.priority]);
  const optionKey = degradeOption(ev.mode, roll);
  const { effect, optionLabel } = effectMemory(ev.modeId, optionKey);
  const { command, note } = optionKey !== null ? optionToCommand(s, ev, optionKey) : { command: null, note: null };
  const d: PettyDecisionResult = {
    eventId: ev.id,
    modeId: ev.modeId,
    polityId: ev.polityId,
    polityName: ev.polityName,
    option: optionKey,
    optionLabel,
    probabilities: {},
    roll,
    source: 'engine-rule',
    effect,
    command,
    error: why,
  };
  if (note) d.note = note;
  return d;
}

/** 给 DM 的已结算摘要(不含概率/选项/置信度/队列)。 */
export function pettyDigest(result: PettySettlement, limit = 6): string {
  const lines: string[] = [];
  for (const d of result.decisions.slice(0, limit)) {
    if (d.source === 'engine-rule' && !d.command) continue;
    const label = d.optionLabel ?? '无特别结果';
    const tail = d.command ? '' : '（叙事）';
    lines.push(`${d.polityName}：${label}${tail}`);
  }
  return lines.length ? lines.join('；') : '本回合无值得载入史册的小事。';
}
