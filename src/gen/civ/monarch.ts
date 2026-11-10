/**
 * 君主回合循环的纯计算部分:不碰 DOM、不 import src/ai、不联网。
 *
 * 它只做三件事:
 * 1. 从「现在」选哪些国家交给外部 LLM 扮演;
 * 2. 给每个国家写一份今年看的局势简报(中文);
 * 3. 把 LLM 的决策(以「我们国家」为主语的命令)编译成引擎认的外部干预(Intervention)。
 *
 * 真正的「暂停 → 收集 → 再推」由调用方(浏览器主线程 / MCP 会话层)用
 * src/gen/civ/play.ts 的 playCiv / playTurn 完成;这里保持纯函数,
 * 同一份 civ + 同一串命令永远得到同一串 Intervention,便于确定性对账。
 */
import type { Civ, Polity } from './types';
import { cleanIntervention, POLICY_PRESETS_KEYS, polityKey, resolveKey, type Intervention } from '../edits';
import { capitalAt, polityAlive, polityName } from './growth';
import { canCross } from './polities';
import { rulerAt } from './story/peopleInfo';
import { buildChronicle, entryInvolves, entryYearLabel, type ChronicleEntry } from './story/chronicle';
import { ownersAt } from '../readers/openQuery';

/** 一次最多让多少个国家由外部君主接管(防止一个回合发太多请求) */
export const MONARCH_MAX_COUNTRIES = 12;

/** 每回合每个国家最多收几条命令 */
export const MONARCH_MAX_ORDERS = 3;

/** 君主能下的命令(和 compileMonarchOrders 一一对应) */
export const MONARCH_KINDS = ['policy', 'declare', 'ally', 'halt', 'boost', 'protect'] as const;
export type MonarchKind = (typeof MONARCH_KINDS)[number];

/** 第 y 年各国几州(y≥civ.endYear 时直接用 civ.polity) */
export function sizesAt(civ: Civ, y: number): Map<number, number> {
  const own = y >= civ.endYear ? civ.polity : ownersAt(civ, y).polity;
  const m = new Map<number, number>();
  for (let r = 0; r < own.length; r++) {
    const id = own[r];
    if (id >= 0) m.set(id, (m.get(id) ?? 0) + 1);
  }
  return m;
}

/** 国家在 y 年的全称(没立国/已亡:用立国时、亡国前的国号) */
export function monarchName(p: Polity | undefined, y: number): string {
  if (!p) return '某国';
  const t = y < p.founded ? p.founded : p.ended !== undefined && y >= p.ended ? p.ended - 1 / 512 : y;
  return polityName(p, t) || p.name || '某国';
}

/**
 * y 年和国家 id 接壤的国家(和国家面板"宣战"同一口径:
 * 能出海的国家隔海峡也算,航线也算,见 canCross)。
 */
export function monarchBorders(civ: Civ, own: Int16Array, id: number, year: number): Set<number> {
  const reg = civ.regions;
  const near = new Set<number>();
  const P = civ.polities[id];
  if (!P) return near;
  for (let r = 0; r < reg.count; r++) {
    if (own[r] !== id) continue;
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      const q = own[reg.adj[k]];
      if (q >= 0 && q !== id && canCross(civ, P, reg.adjKind[k], year)) near.add(q);
    }
  }
  return near;
}

/** 一条编年史("第 1200—1215 年 正文〔P3、P5〕") */
export function monarchEntryLine(e: ChronicleEntry): string {
  return `${entryYearLabel(e)} ${e.text}${e.polities.length ? `〔${e.polities.slice(0, 4).map((p) => `P${p}`).join('、')}〕` : ''}`;
}

/** 一条命令的简短中文说法(简报/日志用) */
export function monarchOrderText(civ: Civ, v: Intervention): string {
  const target = (k: unknown) => {
    if (typeof k !== 'string') return '?';
    const r = resolveKey(civ, k);
    return r && r.kind === 'polity' ? `P${r.id} ${monarchName(civ.polities[r.id], v.from)}` : k;
  };
  const until = 'until' in v && v.until !== undefined ? `,至第 ${v.until} 年` : '';
  if (v.kind === 'policy') return `定国策${v.preset ? `(${v.preset})` : ''}`;
  if (v.kind === 'declare') return `向 ${target(v.b)} 宣战`;
  if (v.kind === 'ally') return `与 ${target(v.b)} 结盟${until}`;
  if (v.kind === 'boost') return `推一把发展${v.mul ? `(快 ${v.mul} 倍)` : '(直接进下一个时代)'}${until}`;
  if (v.kind === 'halt') return `停止扩张${until}`;
  if (v.kind === 'protect') return `自保${until}`;
  return v.kind;
}

export interface MonarchRuler {
  name: string;
  born: number;
  title?: string;
  leanings?: { expand?: number; war?: number; develop?: number; trade?: number };
}

export interface MonarchNeighbor {
  id: number;
  name: string;
  size: number;
}

export interface MonarchBrief {
  year: number;
  polityId: number;
  key: string;
  name: string;
  alive: boolean;
  size: number;
  capital: number;
  capitalName: string;
  ruler: MonarchRuler | null;
  neighbors: MonarchNeighbor[];
  wars: string[];
  /** 给 LLM 的完整中文简报 */
  text: string;
}

/** 现在能下的命令说明(给简报用) */
const COMMAND_HELP = `## 你能下的命令(每回合 0–${MONARCH_MAX_ORDERS} 条,不用写 from,也不用写 a;程序会填成今年、你的国家)
- {"kind":"policy","preset":"expand|hold|trade|peace"}
  定国策:以后按这个方针走,直到下一条国策换掉。
  expand=扩张、hold=守成、trade=通商、peace=求和。
  也可以不写 preset,直接给四个数(各 -50~50,0=照君主性格):war(好战)、expand(扩张)、coast(重商)、peace(和谈底线)。
- {"kind":"declare","b":国家编号}
  向某国宣战。b 是简报里 P 后面那个编号(如 6)。必须接壤,不然打不成。
- {"kind":"ally","b":国家编号}
  与某国结盟。
- {"kind":"halt"}
  停止扩张、不主动宣战。
- {"kind":"boost","mul":3}
  推一把发展:mul 只能是 3 或 10(不写 = 直接进下一个时代)。
- {"kind":"protect"}
  保护自己:别的国家不能把你灭掉(但仍可能丢州)。`;

/** 一次为多个国家写简报(编年史只算一遍) */
export function buildMonarchBriefs(
  civ: Civ,
  play: { year: number; commands?: readonly Intervention[] },
  ids: readonly number[],
  opts: { maxCountries?: number } = {},
): MonarchBrief[] {
  const Y = Math.floor(Number(play.year));
  const size = sizesAt(civ, Y);
  const own = Y >= civ.endYear ? civ.polity : ownersAt(civ, Y).polity;
  const chronicle = buildChronicle(civ);
  const commands = play.commands ?? [];
  const aliveList = civ.polities
    .filter((p) => polityAlive(p, Y) && (size.get(p.id) ?? 0) > 0)
    .sort((a, b) => (size.get(b.id) ?? 0) - (size.get(a.id) ?? 0) || a.id - b.id);
  const aliveIds = new Set(aliveList.map((p) => p.id));
  const briefed = ids.filter((id) => aliveIds.has(id)).slice(0, opts.maxCountries ?? MONARCH_MAX_COUNTRIES);
  return briefed.map((id) => buildOne(civ, Y, id, size, own, chronicle, aliveList, commands));
}

function buildOne(
  civ: Civ,
  Y: number,
  id: number,
  size: Map<number, number>,
  own: Int16Array,
  chronicle: ChronicleEntry[],
  aliveList: Polity[],
  commands: readonly Intervention[],
): MonarchBrief {
  const me = civ.polities[id];
  const mySize = size.get(id) ?? 0;
  const alive = !!me && mySize > 0;
  const myKey = me ? polityKey(civ, id) : '';
  const near = alive ? [...monarchBorders(civ, own, id, Y)].sort((a, b) => (size.get(b) ?? 0) - (size.get(a) ?? 0) || a - b) : [];
  const ruler = alive ? rulerAt(civ, id, Y) : null;
  const wars = chronicle.filter(
    (e) => e.kind === 'war' && entryInvolves(e, id) && Math.floor(e.year) <= Y && Math.floor(e.end) >= Y,
  );

  const out: string[] = [];
  out.push(`你是《文明与地图》世界里 ${monarchName(me, Y)} 的统治者。现在是第 ${Y} 年。`);
  out.push('');
  out.push('## 你的国家');
  if (!alive) {
    out.push(`- 你的国家在第 ${Y} 年已经不存在了。`);
  } else {
    const cap = capitalAt(me!, Y);
    const capName = civ.settlements[cap]?.name ?? `C${cap}`;
    out.push(`- ${monarchName(me, Y)}(P${id}),${mySize} 州,国都 ${capName}`);
    if (ruler) {
      const l = ruler.leanings;
      out.push(
        `- 在位君主:${ruler.name}(第 ${Math.floor(ruler.born)} 年生${ruler.title ? `,${ruler.title}` : ''};性格倾向:扩张 ${l?.expand ?? '?'}、好战 ${l?.war ?? '?'}、发展 ${l?.develop ?? '?'}、贸易 ${l?.trade ?? '?'})`,
      );
    } else {
      out.push('- 在位君主:没有查到推演里的君主');
    }
    const nearText = near.slice(0, 8).map((q) => `P${q} ${monarchName(civ.polities[q], Y)}(${size.get(q) ?? 0} 州)`);
    out.push(`- 邻国:${nearText.length ? nearText.join('、') : '不接壤任何国家'}`);
    out.push(`- 正在打的仗:${wars.length ? wars.slice(0, 4).map(monarchEntryLine).join(';') : '没有'}`);
    const mine = chronicle.filter((e) => entryInvolves(e, id) && Math.floor(e.year) <= Y).slice(-6);
    if (mine.length) {
      out.push('- 我国最近的大事:');
      for (const e of mine) out.push(`  - ${monarchEntryLine(e)}`);
    }
    const cmds = commands.filter((v) => 'a' in v && v.a === myKey).slice(-6);
    if (cmds.length) out.push(`- 你之前下过的命令:${cmds.map((v) => `第 ${v.from} 年 ${monarchOrderText(civ, v)}`).join(';')}`);
  }
  out.push('');
  out.push(`## 天下大势(第 ${Y} 年在世 ${aliveList.length} 国,按大小排)`);
  for (const p of aliveList.slice(0, 12)) {
    const cap = capitalAt(p, Y);
    const pNear = [...monarchBorders(civ, own, p.id, Y)].sort((a, b) => a - b).slice(0, 5);
    out.push(
      `- P${p.id} ${monarchName(p, Y)} · ${size.get(p.id) ?? 0} 州 · 国都 ${civ.settlements[cap]?.name ?? `C${cap}`}${pNear.length ? ` · 邻国 ${pNear.map((q) => `P${q}`).join('、')}` : ''}`,
    );
  }
  const latest = chronicle.filter((e) => Math.floor(e.year) <= Y).slice(-8);
  if (latest.length) {
    out.push('');
    out.push('## 天下最近发生的事(编年史)');
    for (const e of latest) out.push(`- ${monarchEntryLine(e)}`);
  }
  out.push('');
  out.push(COMMAND_HELP);
  out.push('');
  out.push('## 输出格式');
  out.push('只输出一个 JSON 对象,不要解释、不要代码块标记:');
  out.push(`{"reason":"一句话说明今年为什么这么决定","commands":[{"kind":"policy","preset":"expand"}]}`);
  out.push('commands 可以是空数组(今年什么也不做)。');

  const cap = alive ? capitalAt(me!, Y) : -1;
  return {
    year: Y,
    polityId: id,
    key: myKey,
    name: monarchName(me, Y),
    alive,
    size: mySize,
    capital: cap,
    capitalName: cap >= 0 ? (civ.settlements[cap]?.name ?? `C${cap}`) : '',
    ruler: ruler
      ? {
          name: ruler.name,
          born: Math.floor(ruler.born),
          ...(ruler.title ? { title: ruler.title } : {}),
          ...(ruler.leanings ? { leanings: ruler.leanings } : {}),
        }
      : null,
    neighbors: near.map((q) => ({ id: q, name: monarchName(civ.polities[q], Y), size: size.get(q) ?? 0 })),
    wars: wars.slice(0, 4).map(monarchEntryLine),
    text: out.join('\n'),
  };
}

/** 第 year 年在世的国家,按州数排(给"选哪些国家当君主"用) */
export function aliveMonarchs(civ: Civ, year: number): { id: number; name: string; size: number }[] {
  const size = sizesAt(civ, year);
  return civ.polities
    .filter((p) => polityAlive(p, year) && (size.get(p.id) ?? 0) > 0)
    .map((p) => ({ id: p.id, name: monarchName(p, year), size: size.get(p.id) ?? 0 }))
    .sort((a, b) => b.size - a.size || a.id - b.id);
}

/**
 * 选哪些国家交给外部君主。
 * - 'all':今年在世的所有国家(最多 MONARCH_MAX_COUNTRIES 个,按大小)
 * - number:前 N 个大国
 * - number[]:指定编号(按给的顺序,过滤掉已亡的)
 */
export function pickMonarchIds(civ: Civ, year: number, spec: 'all' | number | readonly number[] | undefined): number[] {
  const alive = aliveMonarchs(civ, year);
  const ready = new Set(alive.map((p) => p.id));
  let ids: number[];
  if (spec === undefined || spec === 'all') ids = alive.map((p) => p.id);
  else if (typeof spec === 'number') ids = alive.slice(0, Math.max(1, Math.min(MONARCH_MAX_COUNTRIES, Math.round(spec)))).map((p) => p.id);
  else ids = [...spec].filter((id) => ready.has(id));
  return [...new Set(ids)].slice(0, MONARCH_MAX_COUNTRIES);
}

export interface MonarchReject {
  order: unknown;
  reason: string;
}

export interface CompiledMonarchOrders {
  year: number;
  polityId: number;
  commands: Intervention[];
  rejected: MonarchReject[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** "P6" / "6" / 6 都认成国家编号 6;其他 = null */
export function asPolityId(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === 'string') {
    const m = /^(?:P)?(\d{1,6})$/i.exec(v.trim());
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * 把君主决策编译成引擎命令。
 *
 * 输入是「以我们国家为主语」的原始命令(不带 a/from),输出带 from=year、a=我国稳定键 的 Intervention。
 * 任何一条不合格只影响它自己,原因写进 rejected;绝不抛出。
 */
export function compileMonarchOrders(civ: Civ, year: number, polityId: number, raw: readonly unknown[]): CompiledMonarchOrders {
  const Y = Math.floor(Number(year));
  const size = sizesAt(civ, Y);
  const me = civ.polities[polityId];
  const commands: Intervention[] = [];
  const rejected: MonarchReject[] = [];
  const myKey = me ? polityKey(civ, polityId) : '';
  const alive = !!me && polityAlive(me, Y) && (size.get(polityId) ?? 0) > 0;
  const own = Y >= civ.endYear ? civ.polity : ownersAt(civ, Y).polity;
  const near = alive ? monarchBorders(civ, own, polityId, Y) : new Set<number>();

  let taken = 0;
  for (let i = 0; i < raw.length; i++) {
    const order = raw[i];
    if (taken >= MONARCH_MAX_ORDERS) {
      rejected.push({ order, reason: `每回合每个国家最多 ${MONARCH_MAX_ORDERS} 条命令,这条超出的没有执行` });
      continue;
    }
    if (!isObj(order)) {
      rejected.push({ order, reason: '命令必须是 JSON 对象' });
      continue;
    }
    const kind = order.kind;
    if (typeof kind !== 'string' || !(MONARCH_KINDS as readonly string[]).includes(kind)) {
      rejected.push({ order, reason: `不认识的命令种类;可用:${MONARCH_KINDS.join(' / ')}` });
      continue;
    }
    if (!alive) {
      rejected.push({ order, reason: '你的国家在今年已经不存在了,下不了命令' });
      continue;
    }
    if (kind === 'policy') {
      const preset = order.preset;
      if (preset !== undefined && !(typeof preset === 'string' && (POLICY_PRESETS_KEYS as readonly string[]).includes(preset))) {
        rejected.push({ order, reason: `不认识的 preset;只能是 ${POLICY_PRESETS_KEYS.join('/')}` });
        continue;
      }
      const hasNumber = (['war', 'expand', 'coast', 'peace'] as const).some((k) => order[k] !== undefined);
      if (preset === undefined && !hasNumber) {
        rejected.push({ order, reason: '国策要么给 preset,要么给 war/expand/coast/peace 里至少一个数' });
        continue;
      }
      const built: Record<string, unknown> = { kind: 'policy', from: Y, a: myKey };
      if (preset !== undefined) built.preset = preset;
      for (const k of ['war', 'expand', 'coast', 'peace'] as const) {
        if (order[k] !== undefined) built[k] = order[k];
      }
      const v = cleanIntervention(built);
      if (!v) {
        rejected.push({ order, reason: `国策参数不合法;preset 只能是 ${POLICY_PRESETS_KEYS.join('/')} 或四个 -50~50 的数` });
        continue;
      }
      commands.push(v);
      taken += 1;
      continue;
    }
    if (kind === 'halt' || kind === 'boost' || kind === 'protect') {
      const built: Record<string, unknown> = { kind, from: Y, a: myKey };
      if (kind === 'boost' && order.mul !== undefined) built.mul = order.mul;
      if (order.until !== undefined) built.until = order.until;
      const v = cleanIntervention(built);
      if (!v) {
        rejected.push({ order, reason: `${kind} 参数不合法(boost 的 mul 只能是 3 或 10;until 要是不早于今年的年份)` });
        continue;
      }
      commands.push(v);
      taken += 1;
      continue;
    }
    // declare / ally:需要一个目标国家
    const target = asPolityId(order.b ?? order.target);
    if (target === null) {
      rejected.push({ order, reason: `缺少目标国家编号 b(如 {"kind":"${kind}","b":6})` });
      continue;
    }
    if (target === polityId) {
      rejected.push({ order, reason: '不能对自己下这条命令' });
      continue;
    }
    const tp = civ.polities[target];
    if (!tp || !polityAlive(tp, Y) || (size.get(target) ?? 0) === 0) {
      rejected.push({ order, reason: `P${target} 今年不在世` });
      continue;
    }
    if (kind === 'declare' && !near.has(target)) {
      rejected.push({ order, reason: `P${target} 不接壤,宣战打不成;先看简报里的邻国` });
      continue;
    }
    const v = cleanIntervention({ kind, from: Y, a: myKey, b: polityKey(civ, target) });
    if (!v) {
      rejected.push({ order, reason: `${kind} 参数不合法` });
      continue;
    }
    commands.push(v);
    taken += 1;
  }
  return { year: Y, polityId, commands, rejected };
}
