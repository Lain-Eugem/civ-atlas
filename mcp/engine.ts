/**
 * 无头引擎门面:在 Node 里直接跑 civ-atlas 的纯计算推演,不经过浏览器/Worker。
 *
 * 只用 src/gen 下的纯计算模块(不 import src/ui / src/worker / src/ai),
 * 因此可以被 MCP 进程、测试脚本或任意 Node 程序复用。
 *
 * 这个文件是「任务一 MCP 工具层」的引擎侧实现:
 * - 世界注册表(createWorld)
 * - 推演会话(openSession):把世界推到起始年,停在那一刻
 * - 读状态(stateGet)、交命令(submitOrders)、单步推演(turnStep)
 * - 编年史(chronicleGet)、导出(exportSession)
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_PARAMS, generateWorld, type World, type WorldParams } from '../src/gen/world';
import { DEFAULT_CIV_PARAMS } from '../src/gen/civ';
import { playCiv, playTurn } from '../src/gen/civ/play';
import type { Civ, CivParams, Person, Polity } from '../src/gen/civ/types';
import { polityKey, type Intervention, type PlayState } from '../src/gen/edits';
import { polityAlive, capitalAt, polityName } from '../src/gen/civ/growth';
import { rulerAt } from '../src/gen/civ/story/peopleInfo';
import { buildChronicle, entryInvolves, type ChronicleEntry } from '../src/gen/civ/story/chronicle';
import { cleanOrders, ORDER_KINDS, KEY_HELP, type CleanedOrders } from './orders';
import { dmKnobs, dmTuningValues, mergeKnobs } from '../src/gen/civ/dm';
import { MAGIC_LAYER, magicPlugin, magicStrengthOf } from '../src/gen/civ/magicPlugin';
import { cleanFieldSpec, fieldPlugin, type FieldSpec } from '../src/gen/civ/fieldPlugin';
import type { TuningValues } from '../src/gen/civ/tuning';

/* ------------------------------------------------------------------ *
 * 世界注册表
 * ------------------------------------------------------------------ */

export interface WorldRecord {
  id: string;
  world: World;
  params: WorldParams;
  generatedMs: number;
}

export interface WorldCreateInput {
  seed: number;
  /** 覆盖默认生成参数(WorldParams 里除 seed 外的任意字段) */
  params?: Partial<WorldParams>;
}

const worlds = new Map<string, WorldRecord>();
let sessionSeq = 0;

/** 世界 id:由 seed + 全部生成参数算出,同一个世界永远同一个 id */
export function worldIdOf(params: WorldParams): string {
  const h = createHash('sha1').update(JSON.stringify(params)).digest('hex').slice(0, 10);
  return `w-${params.seed}-${h}`;
}

/** 新建一个世界(纯计算,约 0.5–3 秒,取决于 cells) */
export function createWorld(input: WorldCreateInput): WorldRecord {
  const seed = Number(input.seed);
  if (!Number.isInteger(seed)) throw new Error('seed 必须是整数');
  const overrides = input.params ?? {};
  const params: WorldParams = { ...DEFAULT_PARAMS, ...overrides, seed };
  params.cells = Math.round(clampNum(params.cells, 1000, 200000, 'cells'));
  const started = Date.now();
  const world = generateWorld(params);
  const rec: WorldRecord = { id: worldIdOf(params), world, params, generatedMs: Date.now() - started };
  worlds.set(rec.id, rec);
  return rec;
}

export function getWorldRecord(id: string): WorldRecord {
  const rec = worlds.get(id);
  if (!rec) throw new Error(`找不到世界 ${id};先调用 civ_world_create(本次进程内有效)`);
  return rec;
}

/* ------------------------------------------------------------------ *
 * 推演会话
 * ------------------------------------------------------------------ */

export type SessionMode = 'auto' | 'monarch';

/** 君主模式在会话上的状态(配置 + 每回合日志;具体结构由 mcp/monarch.ts 解释) */
export interface MonarchState {
  config: Record<string, unknown>;
  rounds: Record<string, unknown>[];
}

/** DM 小决策在会话上的状态(配置 + 每回合日志;具体结构由 mcp/dm.ts 解释) */
export interface DmState {
  /** 运行期配置(可能含 Key,只在当前进程内存;对外展示请用 mcp/dm.ts 的 dmStatus) */
  config: Record<string, unknown>;
  rounds: Record<string, unknown>[];
}

/** 小事件裁决层在会话上的状态(配置 + 每回合日志;具体结构由 mcp/petty.ts 解释) */
export interface PettyState {
  /** 运行期配置(可能含 Key,只在当前进程内存;对外展示请用 mcp/petty.ts 的 pettyStatus) */
  config: Record<string, unknown>;
  rounds: Record<string, unknown>[];
}

export interface SessionOpenInput {
  worldId: string;
  /** 起始年(必填;第一轮从这个年份年初开始) */
  startYear: number;
  /** 一个回合推几年(默认 1;1–1000) */
  stepYears?: number;
  /** 最多几个回合(默认 1;1–200) */
  maxRounds?: number;
  /** 到这一年就停(可选;必须 > startYear) */
  endYear?: number;
  mode?: SessionMode;
  /**
   * 传给推演引擎的 CivParams 覆盖项(可选)。常用:tempo、regionArea、names、knobs 等。
   * 注意:interventions 可以放"起始年之前的历史命令",引擎会照它们从第 0 年重推。
   */
  civParams?: Partial<CivParams>;
  /**
   * DM 规则预设(可选):true = 用默认预设,对象 = 在预设上覆盖单项(键名见 src/gen/civ/dm.ts)。
   * 预设改的是引擎自动战争/议和/结盟/分裂的劲头,经 tuningPatch 写进 CivParams.knobs 随世界存;
   * 不给 / false = 官方规则,与改造前逐字节一致。
   */
  dmPreset?: boolean | TuningValues;
  /**
   * 内置「魔力」场(可选):true = 默认强度 1,数字 = 强度 0–3(0 不影响城)。
   * 用的是 examples/plugins/magic 的灵脉/扩散/影响口 city.capacity/图层逻辑的原生版;
   * 不给 = 官方规则,与改造前逐字节一致。
   */
  magicField?: boolean | number;
  /**
   * 自定义场(可选,0–4 份;每份是 src/gen/civ/fieldPlugin.ts 的 FieldSpec)。
   * 玩家自己设生成密度/扩散/衰减/影响哪些官方数值;参数与魔力场同一套机制,不写死具体设定。
   */
  fields?: readonly unknown[];
  /**
   * 已加载好的官方推演插件(`mcp/plugin-loader.ts` 装好再传;openSession 本身是同步的)。
   * 插件实例带 QuickJS 状态,一局一份;不给 = 不装官方插件。
   */
  simPlugins?: readonly unknown[];
  /** 上面这些插件的 id 与 dispose(会话结束时由调用方决定何时卸) */
  pluginIds?: readonly string[];
  pluginDispose?: () => void;
}

export interface Session {
  id: string;
  mode: SessionMode;
  world: World;
  worldParams: WorldParams;
  civParams: Partial<CivParams>;
  /** DM 规则预设(生效后的完整 values;没开 = 没有) */
  dmPreset?: TuningValues;
  /** 内置「魔力」场(没开 = 没有);强度 0 = 只记图层、不影响城 */
  magicField?: { strength: number };
  /** 玩家自定义的场(没开 = 没有);每份 spec 原样存着,便于导出/回看 */
  fields?: FieldSpec[];
  /** 装上的官方推演插件(.civplugin)id;世界清单里只记 id/sum */
  plugins?: { id: string }[];
  /** 卸载这些官方插件(QuickJS 运行时) */
  pluginDispose?: () => void;
  startYear: number;
  stepYears: number;
  maxRounds: number;
  endYear?: number;
  civ: Civ;
  play: PlayState;
  rounds: number;
  queue: Intervention[];
  logDir: string;
  createdAt: number;
  /** 君主模式的状态(先用 civ_monarch_setup 配置) */
  monarch?: MonarchState;
  /** DM 小决策的状态(先用 civ_dm_oracle_setup 配置;天灾会真改引擎,小贸易只记叙事) */
  dm?: DmState;
  /** 小事件裁决层的状态(先用 civ_petty_setup 配置;需要 v2 petty 干预生效) */
  petty?: PettyState;
}

const sessions = new Map<string, Session>();

function runsRoot(): string {
  const dir = join(process.cwd(), 'mcp', '.runs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function openSession(input: SessionOpenInput): { session: Session; summary: SessionSummary } {
  const worldRec = getWorldRecord(input.worldId);
  const startYear = Math.round(clampNum(input.startYear, 1, 60000, 'startYear'));
  const stepYears = Math.round(clampNum(input.stepYears ?? 1, 1, 1000, 'stepYears'));
  const maxRounds = Math.round(clampNum(input.maxRounds ?? 1, 1, 200, 'maxRounds'));
  const endYear = input.endYear === undefined ? undefined : Math.round(clampNum(input.endYear, startYear + 1, 65535, 'endYear'));
  const mode: SessionMode = input.mode ?? 'auto';
  if (mode !== 'auto' && mode !== 'monarch') throw new Error(`mode 只能是 "auto"(内置规则自动推演) 或 "monarch"(外部君主接管),收到 ${String(mode)}`);

  const started = Date.now();
  const play0: PlayState = { year: startYear, commands: [] };
  const civParams: Partial<CivParams> = { ...(input.civParams ?? {}) };
  let dmPreset: TuningValues | undefined;
  if (input.dmPreset !== undefined && input.dmPreset !== false) {
    if (input.dmPreset !== true && (!input.dmPreset || typeof input.dmPreset !== 'object' || Array.isArray(input.dmPreset))) {
      throw new Error('dmPreset 只能是 true/false,或一个覆盖项对象(键名见 civ_dm_preset 工具)');
    }
    const overrides = input.dmPreset === true ? {} : input.dmPreset;
    dmPreset = dmTuningValues(overrides);
    const merged = mergeKnobs(dmKnobs(overrides), civParams.knobs);
    if (merged) civParams.knobs = merged;
    else delete civParams.knobs;
  }
  let magicField: { strength: number } | undefined;
  if (input.magicField !== undefined && input.magicField !== false) {
    const raw = input.magicField === true ? undefined : Number(input.magicField);
    const strength = magicStrengthOf(raw);
    magicField = { strength };
    const plugins = [...(civParams.plugins ?? []), magicPlugin(strength)];
    civParams.plugins = plugins;
  }
  let fields: FieldSpec[] | undefined;
  if (input.fields !== undefined) {
    if (!Array.isArray(input.fields) || input.fields.length > 4) throw new Error('fields 要是 0–4 份的数组');
    fields = input.fields.map((raw, i) => {
      try {
        return cleanFieldSpec(raw);
      } catch (e) {
        throw new Error(`fields[${i}]:${e instanceof Error ? e.message : String(e)}`);
      }
    });
    const plugins = [...(civParams.plugins ?? []), ...fields.map((f) => fieldPlugin(f))];
    civParams.plugins = plugins;
  }
  if (input.simPlugins !== undefined) {
    if (!Array.isArray(input.simPlugins) || input.simPlugins.length === 0 || input.simPlugins.length > 4) {
      throw new Error('simPlugins 要是 1–4 个已加载的推演插件');
    }
    const plugins = [
      ...(civParams.plugins ?? []),
      ...(input.simPlugins as unknown as NonNullable<Partial<CivParams>['plugins']>),
    ];
    civParams.plugins = plugins;
  }
  const civ = playCiv(worldRec.world, civParams, play0);  sessionSeq += 1;
  const id = `s-${Date.now().toString(36)}-${sessionSeq.toString(36)}`;
  const logDir = join(runsRoot(), id);
  mkdirSync(logDir, { recursive: true });
  const session: Session = {
    id,
    mode,
    world: worldRec.world,
    worldParams: worldRec.params,
    civParams,
    dmPreset,
    magicField,
    fields,
    plugins: input.pluginIds?.map((id) => ({ id })),
    pluginDispose: input.pluginDispose,
    startYear,
    stepYears,
    maxRounds,
    endYear,
    civ,
    play: play0,
    rounds: 0,
    queue: [],
    logDir,
    createdAt: started,
  };
  sessions.set(id, session);
  writeFileSync(
    join(logDir, 'session.json'),
    JSON.stringify(
      {
        id,
        mode,
        worldId: worldRec.id,
        worldParams: worldRec.params,
        civParams,
        dmPreset,
        magicField,
        fields,
        plugins: input.pluginIds ?? [],
        startYear,
        stepYears,
        maxRounds,
        endYear,
        createdAt: started,
      },
      null,
      2,
    ),
  );
  return { session, summary: sessionSummary(session) };
}

export function getSession(id: string): Session {
  const s = sessions.get(id);
  if (!s) throw new Error(`找不到会话 ${id};先调用 civ_session_open(本次进程内有效)`);
  return s;
}

export function listSessions(): SessionSummary[] {
  return [...sessions.values()].map((s) => sessionSummary(s));
}

/* ------------------------------------------------------------------ *
 * 状态读取
 * ------------------------------------------------------------------ */

export interface PolityView {
  id: number;
  key: string;
  name: string;
  size: number;
  capital: number;
  capitalName: string;
  ruler: RulerView | null;
}

export interface RulerView {
  name: string;
  born: number;
  title?: string;
  leanings?: { expand?: number; war?: number; develop?: number; trade?: number };
}

export interface EventView {
  year: number;
  end: number;
  kind: string;
  text: string;
  polities: number[];
}

export interface SessionSummary {
  sessionId: string;
  mode: SessionMode;
  year: number;
  startYear: number;
  stepYears: number;
  rounds: number;
  maxRounds: number;
  endYear?: number;
  finished: boolean;
  world: { worldId: string; seed: number; cells: number };
  polities: number;
  fingerprint: string;
  logDir: string;
  /** 本局玩家自定义场(没开 = 不给这个字段) */
  fields?: string[];
  /** 装上的官方推演插件 id(没装 = 没有) */
  plugins?: string[];
  /** 本局内置魔力场强度(没开 = 不给) */
  magicField?: number;
}

export function sessionSummary(s: Session): SessionSummary {
  return {
    sessionId: s.id,
    mode: s.mode,
    year: s.play.year,
    startYear: s.startYear,
    stepYears: s.stepYears,
    rounds: s.rounds,
    maxRounds: s.maxRounds,
    endYear: s.endYear,
    finished: isFinished(s),
    world: { worldId: worldIdOf(s.worldParams), seed: s.worldParams.seed, cells: s.worldParams.cells },
    polities: aliveCount(s.civ, s.play.year),
    fingerprint: civHash(s.civ),
    logDir: s.logDir,
    ...(s.fields?.length ? { fields: s.fields.map((f) => f.id) } : {}),
    ...(s.plugins?.length ? { plugins: s.plugins.map((p) => p.id) } : {}),
    ...(s.magicField ? { magicField: s.magicField.strength } : {}),
  };
}

export function isFinished(s: Session): boolean {
  if (s.rounds >= s.maxRounds) return true;
  if (s.endYear !== undefined && s.play.year >= s.endYear) return true;
  return false;
}

/** 当前时刻各国占几州(以引擎推到的这一刻为准) */
export function sizesNow(civ: Civ): Map<number, number> {
  const m = new Map<number, number>();
  for (let r = 0; r < civ.polity.length; r++) {
    const id = civ.polity[r];
    if (id >= 0) m.set(id, (m.get(id) ?? 0) + 1);
  }
  return m;
}

function aliveCount(civ: Civ, year: number): number {
  const size = sizesNow(civ);
  return civ.polities.filter((p) => polityAlive(p, year) && (size.get(p.id) ?? 0) > 0).length;
}

function rulerView(civ: Civ, polity: number, year: number): RulerView | null {
  const p: Person | null = rulerAt(civ, polity, year);
  if (!p) return null;
  const out: RulerView = { name: p.name, born: Math.floor(p.born) };
  if (p.title) out.title = p.title;
  if (p.leanings) out.leanings = p.leanings;
  return out;
}

function polityView(civ: Civ, p: Polity, size: Map<number, number>, year: number): PolityView {
  const cap = capitalAt(p, year);
  const settlement = civ.settlements[cap];
  return {
    id: p.id,
    key: polityKey(civ, p.id),
    name: polityName(p, year),
    size: size.get(p.id) ?? 0,
    capital: cap,
    capitalName: settlement ? settlement.name : `C${cap}`,
    ruler: rulerView(civ, p.id, year),
  };
}

function eventView(e: ChronicleEntry): EventView {
  return { year: Math.floor(e.year), end: Math.floor(e.end), kind: e.kind, text: e.text, polities: [...e.polities] };
}

/** 一个会话的完整状态快照(给外部模型看的全部数据都在这里) */
export interface MagicLayerView {
  id: string;
  title: string;
  unit: 'region';
  keep: number;
  legend: string;
  years: number[];
  frameYear: number | null;
  stats: { min: number; max: number; mean: number } | null;
}

export interface MagicView {
  enabled: true;
  strength: number;
  layers: MagicLayerView[];
}

/** 本局开着的「魔力」场(没开 = null);图层来自 civ.simLayers,只读 */
export function magicView(s: Session): MagicView | null {
  if (!s.magicField) return null;
  const layers: MagicLayerView[] = [];
  for (const L of s.civ.simLayers ?? []) {
    if (L.by !== 'magic') continue;
    const n = L.years.length ? Math.floor(L.values.length / L.years.length) : 0;
    const last = n ? L.values.subarray(L.values.length - n) : undefined;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let k = 0;
    if (last) {
      for (const v of last) {
        if (!Number.isFinite(v)) continue;
        min = Math.min(min, v);
        max = Math.max(max, v);
        sum += v;
        k++;
      }
    }
    layers.push({
      id: L.id,
      title: L.title,
      unit: 'region',
      keep: MAGIC_LAYER.keep,
      legend: MAGIC_LAYER.legend,
      years: [...L.years],
      frameYear: L.years.length ? L.years[L.years.length - 1] : null,
      stats: k ? { min, max, mean: sum / k } : null,
    });
  }
  return { enabled: true, strength: s.magicField.strength, layers };
}

/** 任意插件存的图层(按州或按地块),给查看器/工具用;不带具体数值,只给元信息 */
export interface LayerView {
  by: string;
  id: string;
  unit: 'region' | 'tile';
  title: string;
  ramp?: { colors: string[]; min?: number; max?: number };
  classes?: { value: number; color: string; label: string }[];
  legend?: string;
  opacity?: number;
  years: number[];
  frameYear: number | null;
  frameCount: number;
  cells: number;
  stats: { min: number; max: number; mean: number } | null;
}

export function layerViews(s: Session): LayerView[] {
  const out: LayerView[] = [];
  for (const L of s.civ.simLayers ?? []) {
    const frames = L.years.length;
    const cells = frames ? Math.floor(L.values.length / frames) : 0;
    const last = frames ? L.values.subarray(L.values.length - cells) : undefined;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let k = 0;
    if (last) {
      for (const v of last) {
        if (!Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
        k++;
      }
    }
    out.push({
      by: L.by,
      id: L.id,
      unit: L.unit as 'region' | 'tile',
      title: L.title,
      ...(L.ramp ? { ramp: { colors: [...L.ramp.colors], min: L.ramp.min, max: L.ramp.max } } : {}),
      ...(L.classes ? { classes: L.classes.map((c) => ({ ...c })) } : {}),
      ...(L.legend !== undefined ? { legend: L.legend } : {}),
      ...(L.opacity !== undefined ? { opacity: L.opacity } : {}),
      years: [...L.years],
      frameYear: frames ? L.years[frames - 1] : null,
      frameCount: frames,
      cells,
      stats: k ? { min, max, mean: sum / k } : null,
    });
  }
  return out;
}

/** 本局玩家自定义的场(spec 原样带出) */
export interface FieldView {
  id: string;
  name: string;
  spec: FieldSpec;
}

export function fieldViews(s: Session): FieldView[] {
  return (s.fields ?? []).map((spec) => ({ id: spec.id, name: spec.name, spec }));
}

export function stateGet(s: Session, opts: { chronicle?: boolean; limit?: number } = {}): Record<string, unknown> {
  const year = s.play.year;
  const size = sizesNow(s.civ);
  const alive = s.civ.polities
    .filter((p) => polityAlive(p, year) && (size.get(p.id) ?? 0) > 0)
    .map((p) => polityView(s.civ, p, size, year))
    .sort((a, b) => b.size - a.size || a.id - b.id);
  const chronicle = opts.chronicle ? chronicleGet(s, { limit: opts.limit ?? 40 }) : undefined;
  return {
    session: sessionSummary(s),
    year,
    stepYears: s.stepYears,
    rounds: s.rounds,
    finished: isFinished(s),
    polities: alive,
    commandQueue: s.queue.length,
    commands: s.play.commands.map((v) => ({ kind: v.kind, from: v.from, time: commandTime(v), ...restOf(v) })),
    fingerprint: civHash(s.civ),
    magic: magicView(s),
    fields: fieldViews(s),
    layers: layerViews(s),
    ...(chronicle ? { chronicle } : {}),
  };
}

function commandTime(v: Intervention): string {
  return 'from' in v ? `第 ${v.from} 年` : '';
}

function restOf(v: Intervention): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === 'kind' || k === 'from') continue;
    o[k] = val;
  }
  return o;
}

/* ------------------------------------------------------------------ *
 * 交命令 / 推演
 * ------------------------------------------------------------------ */

export function submitOrders(s: Session, raw: readonly unknown[]): CleanedOrders & { queued: number } {
  const cleaned = cleanOrders(s.play, raw);
  s.queue.push(...cleaned.commands);
  return { ...cleaned, queued: s.queue.length };
}

export interface TurnResult {
  sessionId: string;
  round: number;
  fromYear: number;
  toYear: number;
  years: number;
  orders: number;
  rejected: unknown[];
  polities: { id: number; name: string; size: number; delta: number }[];
  events: EventView[];
  finished: boolean;
  fingerprint: string;
}

/** 把队列里的命令交给引擎,再推 stepYears 年 */
export function turnStep(s: Session, opts: { years?: number; orders?: readonly unknown[] } = {}): TurnResult {
  if (isFinished(s)) throw new Error(`会话 ${s.id} 已经结束(第 ${s.play.year} 年,${s.rounds}/${s.maxRounds} 回合)`);
  if (opts.orders && opts.orders.length) {
    const cleaned = cleanOrders(s.play, opts.orders);
    s.queue.push(...cleaned.commands);
  }
  const years = Math.round(clampNum(opts.years ?? s.stepYears, 1, 1000, 'years'));
  const before = sizesNow(s.civ);
  const fromYear = s.play.year;
  const orders = [...s.queue];
  const step = playTurn(s.world, s.civ, s.civParams, s.play, orders, years);
  s.civ = step.civ;
  s.play = step.play;
  s.queue = [];
  s.rounds += 1;
  const after = sizesNow(s.civ);
  const toYear = s.play.year;
  const polities = [...after.entries()]
    .map(([id]) => {
      const p = s.civ.polities[id];
      return {
        id,
        name: polityName(p, toYear),
        size: after.get(id) ?? 0,
        delta: (after.get(id) ?? 0) - (before.get(id) ?? 0),
      };
    })
    .sort((a, b) => b.size - a.size || a.id - b.id);
  const events = buildChronicle(s.civ)
    .filter((e) => {
      const start = Math.floor(e.year);
      const end = Math.floor(e.end);
      return (start >= fromYear && start <= toYear) || (end >= fromYear && end <= toYear);
    })
    .map(eventView);
  const result: TurnResult = {
    sessionId: s.id,
    round: s.rounds,
    fromYear,
    toYear,
    years,
    orders: orders.length,
    rejected: step.rejected,
    polities,
    events,
    finished: isFinished(s),
    fingerprint: civHash(s.civ),
  };
  const logPath = join(s.logDir, `round-${String(s.rounds).padStart(4, '0')}.json`);
  writeFileSync(logPath, JSON.stringify({ result, orders }, null, 2));
  appendFileSync(join(s.logDir, 'rounds.jsonl'), JSON.stringify({ round: s.rounds, fromYear, toYear, orders, rejected: step.rejected, fingerprint: result.fingerprint }) + '\n');
  return result;
}

/* ------------------------------------------------------------------ *
 * 编年史 / 导出
 * ------------------------------------------------------------------ */

export function chronicleGet(
  s: Session,
  opts: { from?: number; to?: number; kind?: string; limit?: number } = {},
): { year: number; total: number; entries: EventView[] } {
  const all = buildChronicle(s.civ);
  const from = opts.from ?? -Infinity;
  const to = opts.to ?? Infinity;
  const list = all
    .filter((e) => (opts.kind ? e.kind === opts.kind : true))
    .filter((e) => Math.floor(e.end) >= from && Math.floor(e.year) <= to)
    .slice(-Math.round(clampNum(opts.limit ?? 50, 1, 5000, 'limit')))
    .map(eventView);
  return { year: s.play.year, total: all.length, entries: list };
}

export function exportSession(s: Session, path?: string): { path: string; bytes: number } {
  const out = path ?? join(s.logDir, 'export.json');
  const payload = {
    format: 'civ-atlas-mcp-session-v1',
    exportedAt: new Date().toISOString(),
    session: sessionSummary(s),
    worldParams: s.worldParams,
    civParams: s.civParams,
    play: s.play,
    state: stateGet(s, { chronicle: true, limit: 300 }),
    chronicle: chronicleGet(s, { limit: 500 }).entries,
  };
  const text = JSON.stringify(payload, null, 2);
  writeFileSync(out, text);
  return { path: out, bytes: Buffer.byteLength(text) };
}

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

export function civHash(civ: Civ): string {
  const h = createHash('sha1');
  h.update(Buffer.from(civ.polity.buffer, civ.polity.byteOffset, civ.polity.byteLength));
  h.update(`|${civ.endYear}|${civ.polities.length}|${civ.settlements.length}`);
  return h.digest('hex').slice(0, 16);
}

export function catalog(): Record<string, unknown> {
  return { kinds: ORDER_KINDS, keyHelp: KEY_HELP, note: 'kind 是命令种类;国家/州用稳定键指定。当前回合的年份由 civ_state_get 返回。' };
}

function clampNum(v: number, min: number, max: number, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} 必须是数字`);
  return Math.min(max, Math.max(min, v));
}

export { entryInvolves };
