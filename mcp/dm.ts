/**
 * DM 小决策:让外部模型(或离线 mock)决定"天灾 / 小贸易"这类小事件。
 *
 * 这层是给"另一个设备上的本地模型"留的接口:
 *   - 只要对方提供 OpenAI 兼容的 /chat/completions(OpenJEV、Ollama、LM Studio、vLLM 都行),
 *     填 baseUrl + model 就能接;Key 可选,只存进程内存,不写日志、不写导出。
 *   - 也可以设置环境变量 CIV_DM_BASE_URL / CIV_DM_MODEL / CIV_DM_API_KEY(或 CIV_DM_PROVIDER)。
 *   - mock:true 不联网,用确定性规则演示/做自检。
 *
 * 决策 → 引擎命令的边界:
 *   - 天灾会编译成引擎已有的 disaster 干预(真改人口/发展,可回放对账);
 *   - 小贸易目前只做叙事记录(引擎没有贸易结果这个原语),写进 dm-round 日志和返回值,不改引擎状态。
 *
 * 确定性:DM 调用本身不可复现(真模型),但它产出的命令和普通君主命令一样写进 s.play.commands;
 * civ_session_verify 仍然能逐位对账"同一串命令 → 同一结果"。mock 模式连决策也确定。
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanIntervention,
  DISASTER_KINDS,
  polityKey,
  regionKey,
  settlementKey,
  type DisasterKind,
  type DisasterLevel,
  type Intervention,
} from '../src/gen/edits';
import { buildChronicle } from '../src/gen/civ/story/chronicle';
import { capitalAt, polityAlive } from '../src/gen/civ/growth';
import type { Civ, Settlement } from '../src/gen/civ/types';
import { submitOrders, turnStep, type Session, type TurnResult } from './engine';
import {
  askLlm,
  providerSettings,
  providerView,
  type LlmProviderInput,
  type LlmProviderSettings,
} from './llm';

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

export interface DmSetupInput extends LlmProviderInput {
  /** 不联网,用确定性 mock(默认 false) */
  mock?: boolean;
  /** 每回合最多几条小决策(1–5,默认 2) */
  maxDecisions?: number;
  /** 配置完顺手发一个最小请求测连通(默认 false) */
  probe?: boolean;
}

interface DmConfig {
  mock: boolean;
  maxDecisions: number;
  label: string;
  provider?: LlmProviderSettings;
}

export interface DmStatus {
  sessionId: string;
  configured: boolean;
  enabled: boolean;
  mode: 'mock' | 'openai-compatible' | null;
  label: string;
  maxDecisions: number;
  rounds: number;
  provider: Record<string, unknown> | null;
  last: { round: number; year: number; decisions: number; commands: number } | null;
  note: string;
}

const DM_SYSTEM_PROMPT = `你在给一个文明推演沙盒当"DM 小决策"助手。
你只决定小事:天灾、小贸易的结果。不要决定战争、结盟、灭国、换君主、改地形。
只输出一个 JSON 对象,不要解释:
{"reason":"一句话理由","decisions":[...]}
decisions 里每一项只能是:
{"kind":"disaster","type":"plague|famine|quake|pandemic","level":1|2|3,"target":{"city?":"城编号或城名","polity?":"P6","region?":"R12","regions?":["R12","R15"]},"note":"中文描述"}
{"kind":"trade","a":"P6","b":"P9","goods":"货物","outcome":"profit|loss|neutral","note":"中文描述"}
瘟疫/全球大疫必须给 target.city;地震水旱必须给 target.region;饥荒给 target.polity 或 target.regions。
小贸易 a、b 是两个国家编号,可不填其中一个。`;

function dmConfigOf(s: Session): DmConfig | null {
  if (!s.dm) return null;
  return s.dm.config as unknown as DmConfig;
}

/** 这个会话是否配置了 DM 小决策 */
export function hasDm(s: Session): boolean {
  return s.dm !== undefined;
}

/** 配置/重配 DM 小决策 oracle。Key 只在内存。 */
export async function dmSetup(s: Session, input: DmSetupInput = {}): Promise<DmStatus & { probe?: ProbeResult }> {
  const maxDecisions = clampInt(input.maxDecisions ?? 2, 1, 5, 'maxDecisions');
  const mock = input.mock === true;
  const envBase = process.env.CIV_DM_BASE_URL;
  const envModel = process.env.CIV_DM_MODEL;
  const envKey = process.env.CIV_DM_API_KEY;
  let config: DmConfig;

  if (mock) {
    config = { mock: true, maxDecisions, label: '离线 mock' };
  } else {
    const baseUrl = input.baseUrl ?? envBase;
    const model = input.model ?? envModel;
    const providerName = input.provider ?? (baseUrl ? 'custom' : 'deepseek');
    if (providerName === 'custom' && (!baseUrl || !model)) {
      throw new Error(
        'DM 小决策要一个 OpenAI 兼容服务:传 baseUrl + model(例如 http://192.168.1.20:8000/v1 + openjev),' +
          '或设置环境变量 CIV_DM_BASE_URL / CIV_DM_MODEL;离线演示请传 mock:true',
      );
    }
    const provider = providerSettings({
      provider: providerName,
      baseUrl,
      model,
      apiKey: input.apiKey ?? envKey,
      temperature: input.temperature,
      timeoutMs: input.timeoutMs,
    });
    config = {
      mock: false,
      maxDecisions,
      label: `${provider.baseUrl} · ${provider.model}`,
      provider,
    };
  }

  s.dm = { config: config as unknown as Record<string, unknown>, rounds: [] };
  const probe = input.probe === true ? await probeDm(s) : undefined;
  return { ...dmStatus(s), ...(probe ? { probe } : {}) };
}

export interface ProbeResult {
  ok: boolean;
  ms: number;
  model?: string;
  error?: string;
}

/** 发一个最小请求,确认另一台设备的模型能连上 */
export async function probeDm(s: Session): Promise<ProbeResult> {
  const cfg = dmConfigOf(s);
  if (!cfg) throw new Error('还没有配置 DM 小决策;先调用 civ_dm_oracle_setup');
  if (cfg.mock) return { ok: true, ms: 0, model: 'mock' };
  const started = Date.now();
  try {
    const reply = await askLlm(
      [
        { role: 'system', content: '你是一个连通性测试端点。只输出 JSON。' },
        { role: 'user', content: '请只回复 {"ok":true}' },
      ],
      cfg.provider!,
    );
    return { ok: true, ms: reply.ms, model: reply.model };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}

export function dmStatus(s: Session): DmStatus {
  const cfg = dmConfigOf(s);
  const last = s.dm?.rounds.at(-1) as
    | { round?: unknown; fromYear?: unknown; decisions?: unknown[]; commands?: unknown[] }
    | undefined;
  const lastRound = typeof last?.round === 'number' ? last.round : 0;
  const lastDecisions = Array.isArray(last?.decisions) ? last.decisions.length : 0;
  const lastCommands = Array.isArray(last?.commands) ? last.commands.length : 0;

  // 君主回合里合并的 DM 小决策(monarchRound 把 dm 摘要放进 s.monarch.rounds 的记录里)
  const embedded = (s.monarch?.rounds ?? [])
    .map((r) => (r as { dm?: { source?: string; decisions?: unknown[]; commands?: number; rejected?: unknown[] } }).dm)
    .filter((d): d is NonNullable<typeof d> => !!d);
  const embeddedLast = embedded.at(-1);
  const embeddedHost = (s.monarch?.rounds ?? []).at(-1) as { round?: number; fromYear?: number } | undefined;
  const rounds = (s.dm?.rounds.length ?? 0) + embedded.length;
  const round = s.dm?.rounds.length ? lastRound : (embeddedHost?.round ?? embedded.length);
  const decisions = s.dm?.rounds.length ? lastDecisions : (embeddedLast?.decisions?.length ?? 0);
  const commands = s.dm?.rounds.length
    ? lastCommands
    : typeof embeddedLast?.commands === 'number'
      ? embeddedLast.commands
      : 0;
  const year = s.dm?.rounds.length
    ? typeof last?.fromYear === 'number'
      ? last.fromYear
      : 0
    : (embeddedHost?.fromYear ?? 0);

  return {
    sessionId: s.id,
    configured: !!cfg,
    enabled: !!cfg,
    mode: cfg ? (cfg.mock ? 'mock' : 'openai-compatible') : null,
    label: cfg?.label ?? '',
    maxDecisions: cfg?.maxDecisions ?? 0,
    rounds,
    provider: cfg?.provider ? providerView(cfg.provider) : null,
    last: cfg && rounds ? { round, year, decisions, commands } : cfg ? { round: 0, year: 0, decisions: 0, commands: 0 } : null,
    note: cfg
      ? cfg.mock
        ? '离线 mock:确定性小决策,用于演示/自检'
        : '每回合先问这个 OpenAI 兼容服务要小决策;天灾写成引擎 disaster 命令,小贸易只记叙事'
      : '还没有配置;先调用 civ_dm_oracle_setup(mock:true 可离线跑)',
  };
}

/* ------------------------------------------------------------------ *
 * 决策上下文
 * ------------------------------------------------------------------ */

interface DmAlive {
  id: number;
  key: string;
  name: string;
  size: number;
  capital: string | null;
}

interface DmRegion {
  key: string;
  name: string;
  owner: number;
  area: number;
}

interface DmCity {
  key: string;
  name: string;
  owner: number | null;
  capital: boolean;
}

interface DmContext {
  year: number;
  stepYears: number;
  maxDecisions: number;
  alive: DmAlive[];
  regions: DmRegion[];
  cities: DmCity[];
  events: string[];
}

function settlementAlive(s: Settlement, year: number): boolean {
  return s.ended === undefined || year < s.ended;
}

function buildDmContext(s: Session, maxDecisions: number): DmContext {
  const civ: Civ = s.civ;
  const year = Math.floor(s.play.year);
  const sizes = new Map<number, number>();
  for (let r = 0; r < civ.regions.count; r += 1) {
    const owner = civ.polity[r];
    if (owner < 0) continue;
    sizes.set(owner, (sizes.get(owner) ?? 0) + 1);
  }

  const alive: DmAlive[] = [];
  for (const p of civ.polities) {
    if (!polityAlive(p, year)) continue;
    const capId = capitalAt(p, year);
    alive.push({
      id: p.id,
      key: polityKey(civ, p.id),
      name: p.name,
      size: sizes.get(p.id) ?? 0,
      capital: civ.settlements[capId]?.name ?? null,
    });
  }
  alive.sort((a, b) => b.size - a.size || a.id - b.id);
  const aliveIds = new Set(alive.map((p) => p.id));
  const top = alive.slice(0, 16);

  const regionRows: DmRegion[] = [];
  for (let r = 0; r < civ.regions.count; r += 1) {
    const owner = civ.polity[r];
    if (owner < 0 || !aliveIds.has(owner)) continue;
    regionRows.push({
      key: regionKey(civ, r),
      name: civ.regions.name?.[r] || `第${r + 1}州`,
      owner,
      area: civ.regions.area[r] ?? 0,
    });
  }
  regionRows.sort((a, b) => b.area - a.area || a.key.localeCompare(b.key));
  const regions = regionRows.slice(0, 24);

  const cityRows: DmCity[] = [];
  const capitalIds = new Set<number>();
  for (const p of civ.polities) {
    if (!polityAlive(p, year)) continue;
    const id = capitalAt(p, year);
    if (id >= 0) capitalIds.add(id);
  }
  for (const st of civ.settlements) {
    if (!settlementAlive(st, year)) continue;
    const owner = st.region >= 0 && st.region < civ.regions.count ? civ.polity[st.region] : -1;
    cityRows.push({
      key: settlementKey(civ, st.id),
      name: st.name,
      owner: owner >= 0 && aliveIds.has(owner) ? owner : null,
      capital: capitalIds.has(st.id),
    });
  }
  cityRows.sort((a, b) => Number(b.capital) - Number(a.capital) || a.name.localeCompare(b.name));
  const cities = cityRows.slice(0, 24);

  const entries = buildChronicle(civ)
    .filter((e) => Math.floor(e.year) <= year && Math.floor(e.year) >= year - 60)
    .slice(-8);
  const events = entries.map((e) => `第${Math.floor(e.year)}年 ${e.text}`.slice(0, 160));

  return { year, stepYears: s.stepYears, maxDecisions, alive: top, regions, cities, events };
}

function renderDmPrompt(ctx: DmContext): string {
  const lines: string[] = [];
  lines.push(`现在是第 ${ctx.year} 年,一回合约 ${ctx.stepYears} 年。`);
  lines.push(`在世国家(编号·国名·州数·国都):`);
  for (const p of ctx.alive) lines.push(`- P${p.id} ${p.name} · ${p.size} 州${p.capital ? ` · 国都 ${p.capital}` : ''}`);
  lines.push(`可指认的州(键·名字·所属):`);
  for (const r of ctx.regions) lines.push(`- ${r.key} ${r.name} · P${r.owner}`);
  lines.push(`可指认的城(键·名字·所属):`);
  for (const c of ctx.cities) lines.push(`- ${c.key} ${c.name}${c.owner === null ? '' : ` · P${c.owner}`}${c.capital ? ' · 国都' : ''}`);
  if (ctx.events.length) {
    lines.push(`最近的大事:`);
    for (const e of ctx.events) lines.push(`- ${e}`);
  }
  lines.push(`请给最多 ${ctx.maxDecisions} 条小决策(没有就返回空数组),只输出 JSON。`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 决策解析与编译
 * ------------------------------------------------------------------ */

export interface DmDecisionView {
  kind: 'disaster' | 'trade';
  summary: string;
  note?: string;
  command?: Intervention;
  trade?: { a?: string; b?: string; goods?: string; outcome: string };
}

export interface DmDecisionOutcome {
  source: 'mock' | 'llm' | 'manual';
  reason: string;
  ms: number;
  decisions: DmDecisionView[];
  commands: Intervention[];
  rejected: { decision: unknown; reason: string }[];
  notes: string[];
}

interface ParsedDm {
  reason: string;
  decisions: unknown[];
}

function parseDmJson(text: string): ParsedDm {
  const raw = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1]!.trim() : raw;
  const objStart = candidate.indexOf('{');
  if (objStart >= 0) {
    const objEnd = candidate.lastIndexOf('}');
    if (objEnd > objStart) {
      try {
        const o = JSON.parse(candidate.slice(objStart, objEnd + 1)) as { reason?: unknown; decisions?: unknown };
        if (Array.isArray(o.decisions)) return { reason: typeof o.reason === 'string' ? o.reason : '', decisions: o.decisions };
      } catch {
        /* 继续试数组形式 */
      }
    }
  }
  const arrStart = candidate.indexOf('[');
  if (arrStart >= 0) {
    const arrEnd = candidate.lastIndexOf(']');
    if (arrEnd > arrStart) {
      try {
        const a = JSON.parse(candidate.slice(arrStart, arrEnd + 1)) as unknown;
        if (Array.isArray(a)) return { reason: '', decisions: a };
      } catch {
        /* 落到报错 */
      }
    }
  }
  throw new Error('DM 返回里找不到 {"reason":…,"decisions":[…]}');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asPolityKey(civ: Civ, v: unknown, year: number): string | null {
  if (typeof v === 'number' && Number.isInteger(v)) {
    const p = civ.polities[v];
    return p && polityAlive(p, year) ? polityKey(civ, v) : null;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^polity:/.test(s)) return s;
  const m = /^[Pp]?(\d+)$/.exec(s);
  if (!m) return null;
  const id = Number(m[1]);
  const p = civ.polities[id];
  return p && polityAlive(p, year) ? polityKey(civ, id) : null;
}

function asCityKey(civ: Civ, v: unknown, year: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^settlement:/.test(s)) return s;
  const m = /^[Cc]?(\d+)$/.exec(s);
  if (m) {
    const id = Number(m[1]);
    const st = civ.settlements[id];
    return st && settlementAlive(st, year) ? settlementKey(civ, id) : null;
  }
  const found = civ.settlements.find((st) => st.name === s && settlementAlive(st, year));
  return found ? settlementKey(civ, found.id) : null;
}

function asRegionKey(civ: Civ, v: unknown, year: number, aliveIds: Set<number>): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^region:/.test(s)) return s;
  const m = /^[Rr]?(\d+)$/.exec(s);
  if (m) {
    const r = Number(m[1]);
    return r >= 0 && r < civ.regions.count ? regionKey(civ, r) : null;
  }
  for (let r = 0; r < civ.regions.count; r += 1) {
    if (civ.regions.name?.[r] !== s) continue;
    const owner = civ.polity[r];
    if (owner >= 0 && aliveIds.has(owner)) return regionKey(civ, r);
  }
  void year;
  return null;
}

function alivePolityIds(civ: Civ, year: number): Set<number> {
  const ids = new Set<number>();
  for (const p of civ.polities) if (polityAlive(p, year)) ids.add(p.id);
  return ids;
}

/** 把外部模型的一批小决策编译成引擎命令;坏决策逐条拒收,不影响其它条 */
export function compileDmDecisions(
  civ: Civ,
  year: number,
  raw: unknown,
  maxDecisions: number,
): { decisions: DmDecisionView[]; commands: Intervention[]; rejected: { decision: unknown; reason: string }[] } {
  const list = Array.isArray(raw) ? raw : [];
  const decisions: DmDecisionView[] = [];
  const commands: Intervention[] = [];
  const rejected: { decision: unknown; reason: string }[] = [];
  const aliveIds = alivePolityIds(civ, year);

  for (const item of list) {
    if (decisions.length + rejected.length >= maxDecisions) {
      rejected.push({ decision: item, reason: `超过每回合上限 ${maxDecisions} 条` });
      continue;
    }
    if (!isObject(item)) {
      rejected.push({ decision: item, reason: '决策必须是对象' });
      continue;
    }
    const kind = item.kind;
    const target = isObject(item.target) ? item.target : {};
    try {
      if (kind === 'disaster') {
        const type = String(item.type ?? '');
        if (!(DISASTER_KINDS as readonly string[]).includes(type)) {
          rejected.push({ decision: item, reason: `不认识的灾种 ${type};只能是 ${DISASTER_KINDS.join('/')}` });
          continue;
        }
        const levelRaw = item.level;
        const level: DisasterLevel = levelRaw === 1 || levelRaw === 3 ? levelRaw : 2;
        const fields: Record<string, unknown> = { kind: 'disaster', type, level, from: year };
        if (type === 'plague' || type === 'pandemic') {
          const city = asCityKey(civ, item.city ?? target.city, year);
          if (!city) {
            rejected.push({ decision: item, reason: '瘟疫/全球大疫需要 target.city(城键或城名)' });
            continue;
          }
          fields.city = city;
          if (type === 'pandemic' && (item.slump === 10 || item.slump === 30 || item.slump === 60)) fields.slump = item.slump;
        } else if (type === 'quake') {
          const region = asRegionKey(civ, item.region ?? target.region, year, aliveIds);
          if (!region) {
            rejected.push({ decision: item, reason: '地震水旱需要 target.region(州键或州名)' });
            continue;
          }
          fields.region = region;
        } else {
          const a = asPolityKey(civ, item.polity ?? item.a ?? target.polity, year);
          if (a) fields.a = a;
          else {
            const rs = Array.isArray(item.regions ?? target.regions) ? (item.regions ?? target.regions) as unknown[] : [];
            const regions: string[] = [];
            for (const v of rs) {
              const key = asRegionKey(civ, v, year, aliveIds);
              if (key && !regions.includes(key) && regions.length < 8) regions.push(key);
            }
            if (!regions.length) {
              rejected.push({ decision: item, reason: '饥荒需要 target.polity 或 target.regions' });
              continue;
            }
            fields.regions = regions;
          }
        }
        const command = cleanIntervention(fields);
        if (!command) {
          rejected.push({ decision: item, reason: '引擎不接受这条天灾(键或参数不合法)' });
          continue;
        }
        const summary = `${disasterLabel(command)} 第${year}年起`;
        decisions.push({ kind: 'disaster', summary, note: typeof item.note === 'string' ? item.note.slice(0, 160) : undefined, command });
        commands.push(command);
      } else if (kind === 'trade') {
        const a = asPolityKey(civ, item.a, year);
        const b = asPolityKey(civ, item.b, year);
        if (!a && !b) {
          rejected.push({ decision: item, reason: '小贸易至少要给一个国家编号 a 或 b' });
          continue;
        }
        const outcomeRaw = item.outcome;
        const outcome = outcomeRaw === 'profit' || outcomeRaw === 'loss' || outcomeRaw === 'neutral' ? outcomeRaw : 'neutral';
        const goods = typeof item.goods === 'string' ? item.goods.slice(0, 40) : '';
        const note = typeof item.note === 'string' ? item.note.slice(0, 160) : '';
        const names = [a, b].filter((v): v is string => typeof v === 'string').join(' × ');
        decisions.push({
          kind: 'trade',
          summary: `${names || '某国'} 的小贸易(${outcome === 'profit' ? '赚' : outcome === 'loss' ? '亏' : '平'}${goods ? ` · ${goods}` : ''})`,
          note,
          trade: { ...(a ? { a } : {}), ...(b ? { b } : {}), ...(goods ? { goods } : {}), outcome },
        });
      } else {
        rejected.push({ decision: item, reason: `不认识的 kind ${String(kind)};只能是 disaster / trade` });
      }
    } catch (e) {
      rejected.push({ decision: item, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { decisions, commands, rejected };
}

function disasterLabel(v: Intervention): string {
  if (v.kind !== 'disaster') return '天灾';
  const name = { plague: '瘟疫', famine: '饥荒', quake: '地震水旱', pandemic: '全球大疫' }[v.type as DisasterKind];
  const where = v.city ? `从 ${v.city} 起` : v.region ? `在 ${v.region}` : v.a ? `在 ${v.a}` : v.regions?.length ? `在 ${v.regions.length} 个州` : '';
  return `${name}${where ? `(${where})` : ''}`;
}

function mockDmDecisions(ctx: DmContext): ParsedDm {
  const out: unknown[] = [];
  const top = ctx.alive[0];
  const second = ctx.alive[1];
  if (top && ctx.year % 6 === 0) {
    out.push({ kind: 'disaster', type: 'famine', level: 2, target: { polity: `P${top.id}` }, note: `${top.name} 今年收成不好(离线 mock)` });
  }
  if (top && second && ctx.year % 4 === 1) {
    out.push({
      kind: 'trade',
      a: `P${top.id}`,
      b: `P${second.id}`,
      goods: '粮布',
      outcome: 'profit',
      note: '两边商队做成一笔小买卖(离线 mock)',
    });
  }
  return { reason: '离线 mock 小决策', decisions: out.slice(0, ctx.maxDecisions) };
}

/* ------------------------------------------------------------------ *
 * 跑一轮
 * ------------------------------------------------------------------ */

export interface DmRoundResult {
  sessionId: string;
  round: number;
  fromYear: number;
  toYear: number;
  years: number;
  year: number;
  source: DmDecisionOutcome['source'];
  reason: string;
  ms: number;
  maxDecisions: number;
  decisions: DmDecisionView[];
  commands: Intervention[];
  rejected: { decision: unknown; reason: string }[];
  notes: string[];
  provider: Record<string, unknown> | null;
  engineRejected: TurnResult['rejected'];
  changes: TurnResult['polities'];
  events: TurnResult['events'];
  finished: boolean;
  fingerprint: string;
}

/** 只问 DM 要决策、编译成命令;不推演(供君主回合合并用)。extra = 本回合已结算的小事件摘要。 */
export async function decideDm(s: Session, manual?: unknown[], extra?: string): Promise<DmDecisionOutcome> {
  const cfg = dmConfigOf(s);
  if (!cfg) throw new Error('还没有配置 DM 小决策;先调用 civ_dm_oracle_setup(mock:true 可离线跑)');
  const base = buildDmContext(s, cfg.maxDecisions);
  const year = Math.floor(s.play.year);

  let source: DmDecisionOutcome['source'];
  let reason = '';
  let raw: unknown = [];
  let ms = 0;
  if (manual !== undefined) {
    source = 'manual';
    raw = manual;
    reason = '手动传入的小决策';
  } else if (cfg.mock) {
    source = 'mock';
    const parsed = mockDmDecisions(base);
    raw = parsed.decisions;
    reason = parsed.reason;
  } else {
    const started = Date.now();
    const userPrompt = extra ? `${renderDmPrompt(base)}\n\n本回合已由小事件裁决层结算的小事（既定事实，不要再裁决）：\n${extra}` : renderDmPrompt(base);
    const reply = await askLlm(
      [
        { role: 'system', content: DM_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      cfg.provider!,
    );
    const parsed = parseDmJson(reply.text);
    source = 'llm';
    raw = parsed.decisions;
    reason = parsed.reason;
    ms = reply.ms;
  }
  const compiled = compileDmDecisions(s.civ, year, raw, cfg.maxDecisions);
  const notes = compiled.decisions
    .map((d) => (d.note ? `${d.summary} — ${d.note}` : d.summary))
    .concat(compiled.rejected.map((r) => `拒收:${r.reason}`));
  return { source, reason, ms, decisions: compiled.decisions, commands: compiled.commands, rejected: compiled.rejected, notes };
}

/**
 * 跑一个"DM 小决策"回合:问 oracle(或用手动 decisions)→ 编译 → 交命令 → 推演 → 落盘日志。
 * 天灾是引擎真命令;小贸易只进日志/返回值。
 */
export async function dmRound(
  s: Session,
  opts: { years?: number; decisions?: unknown[] } = {},
): Promise<DmRoundResult> {
  const cfg = dmConfigOf(s);
  if (!cfg) throw new Error('还没有配置 DM 小决策;先调用 civ_dm_oracle_setup(mock:true 可离线跑)');
  if (s.rounds >= s.maxRounds) throw new Error(`会话已经跑满 ${s.maxRounds} 回合`);
  if (s.endYear !== undefined && s.play.year >= s.endYear) throw new Error(`会话已经到第 ${s.play.year} 年(>= endYear ${s.endYear})`);

  const outcome = await decideDm(s, opts.decisions);
  submitOrders(s, outcome.commands);
  const turn = turnStep(s, { years: opts.years });
  const record: DmRoundResult = {
    sessionId: s.id,
    round: turn.round,
    fromYear: turn.fromYear,
    toYear: turn.toYear,
    years: turn.years,
    year: Math.floor(s.play.year),
    source: outcome.source,
    reason: outcome.reason,
    ms: outcome.ms,
    maxDecisions: cfg.maxDecisions,
    decisions: outcome.decisions,
    commands: outcome.commands,
    rejected: outcome.rejected,
    notes: outcome.notes,
    provider: cfg.provider ? providerView(cfg.provider) : null,
    engineRejected: turn.rejected,
    changes: turn.polities,
    events: turn.events,
    finished: turn.finished,
    fingerprint: turn.fingerprint,
  };
  s.dm!.rounds.push(record as unknown as Record<string, unknown>);
  writeFileSync(join(s.logDir, `dm-round-${String(turn.round).padStart(4, '0')}.json`), JSON.stringify(record, null, 2));
  appendFileSync(
    join(s.logDir, 'dm-rounds.jsonl'),
    JSON.stringify({
      round: turn.round,
      fromYear: turn.fromYear,
      toYear: turn.toYear,
      source: record.source,
      decisions: record.decisions.length,
      commands: record.commands.length,
      rejected: record.rejected.length,
      fingerprint: turn.fingerprint,
    }) + '\n',
  );
  void cfg;
  return record;
}

export function dmRoundLogPath(s: Session, round: number): string {
  return join(s.logDir, `dm-round-${String(round).padStart(4, '0')}.json`);
}

function clampInt(v: number, min: number, max: number, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} 必须是数字`);
  return Math.min(max, Math.max(min, Math.round(v)));
}
