/**
 * 审推演插件时的试跑(帮手第 3 版,见 ui/helperProtocol.ts):在一个示例世界上官方推一遍、带插件推一遍,和官方比几样数;
 * 再带插件推到 SIM_TRIAL_HALF 年存成世界文件、读回来另装一份插件接着推,看和一口气推的一样不一样。
 * 纯计算,不碰 DOM;后台线程(simTrialWorker.ts)和单测里跑。
 */
import type { SimPlugin } from '../gen/civ/engine/plugin';
import { extendCiv } from '../gen/civ/extend';
import { polityAlive, regionPopulationAt } from '../gen/civ/growth';
import type { SimRead } from '../gen/civ/simRead';
import { flagBook } from '../gen/civ/story/flags';
import { chronicleBlock } from '../gen/civ/story/nameTokens';
import { pluginEntries } from '../gen/civ/story/pluginText';
import { civOrStuck } from '../gen/civ/stuck';
import type { AnnalKind, Civ } from '../gen/civ/types';
import { GENERATOR_VERSION } from '../gen/edits';
import { READER_VERSIONS } from '../gen/readers/versions';
import { makeSave, worldCheck } from '../gen/savefile';
import type { World } from '../gen/world';
import { openWorldFile, packWorldFile, readWorldContent } from '../gen/worldFile';
import { framePaint, regionsToCells, type CellPaint } from '../render/pluginLayer';
import { simPluginsOn, type SimBoxer } from '../simPluginRun';
import type { SimPluginFile } from './pluginWorld';

/** 推几年;推到哪年存成世界文件再接着推 */
export const SIM_TRIAL_YEARS = 3000;
export const SIM_TRIAL_HALF = 1500;
/** 交回插件写的编年史前几句 */
export const SIM_TRIAL_LINES = 20;

/** 到第 year 年为止的几样数:现存几国、打了几场仗、灭了几国、分裂几次、改朝换代几次、几场瘟疫、人口(千人) */
export interface SimStats {
  states: number;
  wars: number;
  fallen: number;
  splits: number;
  dynasties: number;
  plagues: number;
  people: number;
}

/** 一个种子上推演插件的试跑结果(后台存试跑结果的接口收的 runs[].sim) */
export interface SimTrial {
  /** 带插件推到第几年(推完 = SIM_TRIAL_YEARS) */
  years: number;
  /** 推不下去:停在第几年 */
  stuck?: number;
  /** 带插件那一遍:插件出手几回合、一共用了多久、最长的一回合多久(毫秒) */
  turns: number;
  pluginMs: number;
  worstMomentMs: number;
  /** 插件下的命令:种类 → 条数 */
  commands: Record<string, number>;
  /** 插件写了几句编年史;前 SIM_TRIAL_LINES 句(名字换好了) */
  lines: number;
  chronicle: { year: number; text: string }[];
  /** 插件的图层(名字) */
  layers: string[];
  /** 都按带插件推到的那一年算;没推出来 = null */
  stats: { official: SimStats | null; plugin: SimStats | null };
  /** 推到 SIM_TRIAL_HALF 年存成世界文件、读回来接着推,和一口气推的一样不一样;没查(带插件推不完、到时停掉了)= null */
  resumeSame: boolean | null;
  /** 不一样在哪、没查成为什么 */
  resumeNote?: string;
}

export interface SimTrialSeed {
  sim: SimTrial;
  /** 每一步做了什么、多久 */
  log: string[];
  /** 插件装不上、推不下去 */
  error?: string;
}

export const emptySimTrial = (): SimTrial => ({
  years: 0,
  turns: 0,
  pluginMs: 0,
  worstMomentMs: 0,
  commands: {},
  lines: 0,
  chronicle: [],
  layers: [],
  stats: { official: null, plugin: null },
  resumeSame: null,
});

const countAnnals = (civ: Civ, kind: AnnalKind, year: number) => civ.annals.reduce((n, a) => n + (a.kind === kind && a.year <= year ? 1 : 0), 0);

export function simStats(civ: Civ, year: number): SimStats {
  if (!civ.viable) return { states: 0, wars: 0, fallen: 0, splits: 0, dynasties: 0, plagues: 0, people: 0 };
  let people = 0;
  for (let r = 0; r < civ.regions.count; r++) people += regionPopulationAt(civ, r, year);
  return {
    states: civ.polities.filter((p) => polityAlive(p, year)).length,
    wars: countAnnals(civ, 'war', year),
    fallen: countAnnals(civ, 'fall', year),
    splits: countAnnals(civ, 'split', year),
    dynasties: countAnnals(civ, 'dynasty', year),
    plagues: countAnnals(civ, 'plague', year),
    people: Math.round(people),
  };
}

interface Meter {
  turns: number;
  ms: number;
  worst: number;
}

/** 量插件每一回合用了多久(只量出手那一下,不改它做的事) */
function metered(plugins: readonly SimPlugin<SimRead>[], m: Meter, now: () => number): SimPlugin<SimRead>[] {
  return plugins.map((p) => ({
    ...p,
    act(turn) {
      const t0 = now();
      try {
        return p.act(turn);
      } finally {
        const d = now() - t0;
        m.turns++;
        m.ms += d;
        if (d > m.worst) m.worst = d;
      }
    },
  }));
}

const isView = (v: unknown): v is ArrayLike<number> & ArrayBufferView => ArrayBuffer.isView(v) && !(v instanceof DataView);

/** a、b 第一处不一样的地方(路径;一样 = null):数按 Object.is 比(分得清 -0 和 0),对象不看键的先后,值是 undefined 的键当没有 */
export function firstDiff(a: unknown, b: unknown, at = ''): string | null {
  if (Object.is(a, b)) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return at || '(整个)';
  if (isView(a) || isView(b)) {
    if (!isView(a) || !isView(b) || a.constructor !== b.constructor || a.length !== b.length) return at;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return `${at}[${i}]`;
    return null;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return at;
    for (let i = 0; i < a.length; i++) {
      const d = firstDiff(a[i], b[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
  for (const k of keys) {
    const d = firstDiff(x[k], y[k], at ? `${at}.${k}` : k);
    if (d) return d;
  }
  return null;
}

/** 接着推的(rest)和一口气推的(full)不一样在哪:史事从哪年起不一样;史事都一样就说哪一项 */
export function resumeDiff(rest: Civ, full: Civ): string | null {
  const d = firstDiff(rest, full);
  if (!d) return null;
  const n = Math.max(rest.annals.length, full.annals.length);
  for (let i = 0; i < n; i++) {
    if (!firstDiff(rest.annals[i], full.annals[i])) continue;
    const year = Math.floor(Math.min(rest.annals[i]?.year ?? Infinity, full.annals[i]?.year ?? Infinity));
    return `从第 ${year} 年起史事不一样`;
  }
  return `史事一样，${d.split(/[.[]/)[0]} 不一样`;
}

/** 带插件那一遍第一个图层在 year 那年(那年以前最近存的一份)按地块铺开;没有图层 = null */
export function simLayerPaint(civ: Civ, year: number): CellPaint | null {
  const l = civ.simLayers?.[0];
  if (!l?.years.length) return null;
  const frame = framePaint(l, year);
  // 按地块记的图层本来就是地块数,按州的要摊到地块
  return frame && (l.unit === 'tile' ? frame : regionsToCells(frame, civ.regions.of));
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

export interface SimTrialHooks {
  /** 每做完一步交一次到这一步为止的结果(帮手到时停掉线程时用最后一次的) */
  report?: (r: SimTrialSeed) => void;
  /** 带插件推出来了(推不下去的停在那一年) */
  ran?: (civ: Civ) => void;
  now?: () => number;
}

/**
 * 在 world 上试跑这几个推演插件(按给的先后出手):装不上、推不下去照实写进 error;
 * 交回结果和带插件推出来的历史(截图用;装不上 = null)
 */
export async function trialSim(world: World, files: readonly SimPluginFile[], box: SimBoxer, hooks: SimTrialHooks = {}): Promise<SimTrialSeed & { civ: Civ | null }> {
  const now = hooks.now ?? (() => performance.now());
  const seed = world.params.seed;
  const sim = emptySimTrial();
  const log: string[] = [];
  const out: SimTrialSeed = { sim, log };
  const report = () => hooks.report?.({ sim: { ...sim }, log: [...log], ...(out.error ? { error: out.error } : {}) });
  const install = async () => {
    try {
      return await simPluginsOn(files, seed, box);
    } catch (e) {
      throw new Error(`插件装不上：${msg(e)}`);
    }
  };

  let t0 = now();
  let on;
  try {
    on = await install();
  } catch (e) {
    out.error = msg(e);
    log.push(out.error);
    return { ...out, civ: null };
  }
  const official = civOrStuck(world, { endYear: SIM_TRIAL_YEARS });
  log.push(`官方推 ${SIM_TRIAL_YEARS} 年：${sec(now() - t0)}`);
  report();

  t0 = now();
  const meter: Meter = { turns: 0, ms: 0, worst: 0 };
  let first: Meter | null = null;
  let failure = '';
  const failed = (e: unknown) => {
    // 推不下去时还要从头一年年找停在哪年:用时只算第一遍
    first ??= { ...meter };
    failure ||= msg(e);
  };
  let full: Civ | null = null;
  try {
    full = civOrStuck(world, { endYear: SIM_TRIAL_YEARS, plugins: metered(on.plugins, meter, now) }, { failed });
  } catch (e) {
    failed(e);
  } finally {
    on.dispose();
  }
  const m = first ?? meter;
  sim.turns = m.turns;
  sim.pluginMs = Math.round(m.ms);
  sim.worstMomentMs = Math.round(m.worst * 10) / 10;
  if (!full) {
    out.error = `推不出来：${failure}`;
    log.push(out.error);
    report();
    return { ...out, civ: null };
  }
  const year = Math.floor(full.endYear);
  sim.years = year;
  if (full.stuck) {
    sim.stuck = Math.floor(full.stuck.at);
    out.error = `推到第 ${sim.stuck} 年推不下去：${failure || '出错了'}`;
  }
  sim.stats = { official: simStats(official, year), plugin: simStats(full, year) };
  for (const v of full.interventions ?? []) if (v.plugin) sim.commands[v.kind] = (sim.commands[v.kind] ?? 0) + 1;
  sim.lines = full.simChronicle?.length ?? 0;
  sim.chronicle = pluginEntries(full, [])
    .slice(0, SIM_TRIAL_LINES)
    .map((e) => ({ year: Math.floor(e.year), text: e.text }));
  sim.layers = (full.simLayers ?? []).map((l) => l.title);
  log.push(`带插件推${full.stuck ? `到第 ${year} 年` : ` ${SIM_TRIAL_YEARS} 年`}：${sec(now() - t0)}，插件出手 ${sim.turns} 回合，一共 ${sec(sim.pluginMs)}`);
  if (out.error) log.push(out.error);
  hooks.ran?.(full);
  report();
  if (full.stuck) return { ...out, civ: full };

  t0 = now();
  const resume = await resumeCheck(world, files, box, install, full).catch((e: unknown) => `查的时候出错：${msg(e)}`);
  sim.resumeSame = resume === null;
  if (resume) {
    sim.resumeNote = resume;
    out.error = `分段推和一口气推的对不上：${resume}`;
  }
  log.push(`推到 ${SIM_TRIAL_HALF} 年存成世界文件、读回来接着推：${sec(now() - t0)}，${resume ? `和一口气推的对不上（${resume}）` : '和一口气推的一样'}`);
  report();
  return { ...out, civ: full };
}

/** 推到 SIM_TRIAL_HALF 年存成世界文件、读回来另装一份插件接着推,和 full 比:一样 = null,不一样、没接上 = 一句话 */
async function resumeCheck(world: World, files: readonly SimPluginFile[], box: SimBoxer, install: () => ReturnType<typeof simPluginsOn>, full: Civ): Promise<string | null> {
  let failure = '';
  const failed = (e: unknown) => (failure ||= msg(e));
  const on = await install();
  let half: Civ;
  try {
    half = civOrStuck(world, { endYear: SIM_TRIAL_HALF, plugins: on.plugins }, { failed });
  } finally {
    on.dispose();
  }
  if (half.stuck) return `推到 ${SIM_TRIAL_HALF} 年时第 ${Math.floor(half.stuck.at)} 年推不下去：${failure}`;
  let read: Civ;
  try {
    const at = new Date(0).toISOString();
    const recipe = makeSave(world.params, { names: {}, interventions: [], terrain: [], upheavals: [] }, worldCheck(world), '试跑', at);
    const file = await packWorldFile({
      id: 'trial',
      title: '试跑',
      made: { app: 'trial', generator: GENERATOR_VERSION, commit: '', at },
      readers: { ...READER_VERSIONS },
      recipe,
      plugins: on.records,
      map: world,
      civ: half,
      chronicle: chronicleBlock(half),
      flags: flagBook(world, half),
    });
    const opened = await openWorldFile(new Uint8Array(await file.arrayBuffer()), { readers: { ...READER_VERSIONS } });
    const civ = (await readWorldContent(opened)).civ;
    if (!civ) return '存成的世界文件里读不出历史';
    read = civ;
  } catch (e) {
    return `存成世界文件、读回来时出错：${msg(e)}`;
  }
  const again = await install();
  let rest: Civ | null;
  try {
    rest = await extendCiv(world, read, { endYear: SIM_TRIAL_YEARS, plugins: again.plugins }, { failed });
  } finally {
    again.dispose();
  }
  if (!rest) return '读回来接不着推';
  if (rest.stuck) return `读回来接着推，第 ${Math.floor(rest.stuck.at)} 年推不下去：${failure}`;
  return resumeDiff(rest, full);
}
