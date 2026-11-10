/**
 * 把「现在」整理成一段给 AI 看的局势简报(中文)。
 * 只读:civ 是推到 play 那一刻的历史,play 是逐年推演的进度。
 */
import type { Civ } from '../../src/gen/civ/types';
import type { PlayState, Intervention } from '../../src/gen/edits';
import { polityKey, resolveKey } from '../../src/gen/edits';
import { polityAlive, capitalAt } from '../../src/gen/civ/growth';
import { ownersAt } from '../../src/gen/readers/openQuery';
import { rulerAt } from '../../src/gen/civ/story/peopleInfo';
import { buildChronicle, entryInvolves, entryYearLabel, type ChronicleEntry } from '../../src/gen/civ/story/chronicle';
import { nameAt, bordersAt } from '../../src/ai/prompts/rewrite';

/** 第 y 年各国几州 */
export function sizesAt(civ: Civ, y: number): Map<number, number> {
  const own = y >= civ.endYear ? civ.polity : ownersAt(civ, y).polity;
  const m = new Map<number, number>();
  for (let r = 0; r < own.length; r++) if (own[r] >= 0) m.set(own[r], (m.get(own[r]) ?? 0) + 1);
  return m;
}

/** 编年史一条(给 AI 看):"第 1200—1215 年 正文〔P3、P5〕" */
export function entryLine(e: ChronicleEntry): string {
  return `${entryYearLabel(e)} ${e.text}${e.polities.length ? `〔${e.polities.slice(0, 4).map((p) => `P${p}`).join('、')}〕` : ''}`;
}

/** 第 year 年在世的国家(按州数排) */
export function alivePolities(civ: Civ, year: number): { id: number; size: number }[] {
  const size = sizesAt(civ, year);
  return civ.polities.filter((p) => polityAlive(p, year) && (size.get(p.id) ?? 0) > 0).map((p) => ({ id: p.id, size: size.get(p.id) ?? 0 })).sort((a, b) => b.size - a.size || a.id - b.id);
}

/** 我们的国家第 year 年的邻国(带名字和州数) */
export function neighborsOf(civ: Civ, meId: number, year: number): { id: number; name: string; size: number }[] {
  const own = year >= civ.endYear ? civ.polity : ownersAt(civ, year).polity;
  const size = sizesAt(civ, year);
  return [...bordersAt(civ, own, meId, year)].map((id) => ({ id, size: size.get(id) ?? 0, name: nameAt(civ.polities[id], year) })).sort((a, b) => a.size - b.size || a.id - b.id);
}

/** 我们的国家第 year 年正在打的仗 */
export function activeWars(civ: Civ, meId: number, year: number): ChronicleEntry[] {
  return buildChronicle(civ).filter((e) => e.kind === 'war' && Math.floor(e.year) <= year && Math.floor(e.end) >= year && (e.polities.includes(meId) || entryInvolves(e, meId)));
}

const KIND_WORD: Record<string, string> = {
  policy: '定国策',
  declare: '宣战',
  ally: '结盟',
  halt: '停止扩张',
  boost: '推一把发展',
  protect: '受保护',
};

/** 一条命令的简短说法(给简报和日志用) */
export function ivText(civ: Civ, v: Intervention): string {
  const name = (k: unknown) => {
    if (typeof k !== 'string') return '?';
    const r = resolveKey(civ, k);
    return r && r.kind === 'polity' ? `P${r.id} ${nameAt(civ.polities[r.id], v.from)}` : k;
  };
  const until = 'until' in v && v.until !== undefined ? `,至第 ${v.until} 年` : '';
  if (v.kind === 'policy') return `定国策${v.preset ? `(${v.preset})` : ''}`;
  if (v.kind === 'declare') return `向 ${name(v.b)} 宣战`;
  if (v.kind === 'ally') return `与 ${name(v.b)} 结盟${until}`;
  if (v.kind === 'boost') return `推一把发展${v.mul ? `(快 ${v.mul} 倍)` : '(直接进下一个时代)'}${until}`;
  return `${KIND_WORD[v.kind] ?? v.kind}${until}`;
}

export interface Briefing {
  year: number;
  myId: number;
  myKey: string;
  size: number;
  alive: boolean;
  text: string;
}

/** 现在能下哪些命令、每个字段什么意思(和 run.ts 的 buildCommands 一一对应) */
const COMMAND_HELP = `## 你能下的命令(每回合 0–3 条,from 不用写,程序会填成今年)
- {"kind":"policy","preset":"expand|hold|trade|peace"}
  定国策:以后按这个方针走,直到下一条国策换掉。
  expand=扩张、hold=守成、trade=通商、peace=求和。
  也可以不写 preset,直接给四个数(各 -50~50,0=照君主性格):war(好战)、expand(扩张)、coast(重商)、peace(和谈底线)。
- {"kind":"declare","b":国家编号}
  向某国宣战。b 是 P 后面那个编号(如 6)。必须接壤,不然打不成。
- {"kind":"ally","b":国家编号,"until":结束年}
  与某国结盟。until 可不写。
- {"kind":"halt","until":结束年}
  停止扩张、不主动宣战。until 可不写。
- {"kind":"boost","mul":3,"until":结束年}
  推一把发展:mul 只能是 3 或 10(不写 = 直接进下一个时代)。until 可不写。`;

/** 「今年」的完整简报 */
export function buildBriefing(civ: Civ, play: PlayState, meId: number): Briefing {
  const Y = play.year;
  const size = sizesAt(civ, Y);
  const aliveList = civ.polities.filter((p) => polityAlive(p, Y) && (size.get(p.id) ?? 0) > 0).sort((x, y) => (size.get(y.id) ?? 0) - (size.get(x.id) ?? 0) || x.id - y.id);
  const me = civ.polities[meId];
  const meAlive = !!me && polityAlive(me, Y) && (size.get(meId) ?? 0) > 0;
  const myKey = me ? polityKey(civ, meId) : '';
  const own = Y >= civ.endYear ? civ.polity : ownersAt(civ, Y).polity;
  const near = meAlive ? [...bordersAt(civ, own, meId, Y)].sort((a, b) => (size.get(b) ?? 0) - (size.get(a) ?? 0) || a - b) : [];
  const ruler = meAlive ? rulerAt(civ, meId, Y) : null;
  const chronicle = buildChronicle(civ);

  const out: string[] = [];
  out.push(`你是《文明与地图》世界里 ${me ? nameAt(me, Y) : '一个国家的'} 的统治者。现在是第 ${Y} 年。`);
  out.push('');
  out.push('## 你的国家');
  if (!meAlive) {
    out.push(`- 你的国家在第 ${Y} 年已经不存在了。`);
  } else {
    const cap = capitalAt(me, Y);
    out.push(`- ${nameAt(me, Y)}(P${meId}),${size.get(meId)} 州,国都 ${civ.settlements[cap]?.name ?? `C${cap}`}`);
    if (ruler) {
      const l = ruler.leanings;
      out.push(`- 在位君主:${ruler.name}(第 ${Math.floor(ruler.born)} 年生${ruler.title ? `,${ruler.title}` : ''};性格倾向:扩张 ${l?.expand ?? '?'}、好战 ${l?.war ?? '?'}、发展 ${l?.develop ?? '?'}、贸易 ${l?.trade ?? '?'})`);
    } else {
      out.push('- 在位君主:没有查到推演里的君主');
    }
    const nearText = near.slice(0, 6).map((q) => `P${q} ${nameAt(civ.polities[q], Y)}(${size.get(q)} 州)`);
    out.push(`- 邻国:${nearText.length ? nearText.join('、') : '不接壤任何国家'}`);
    const wars = chronicle.filter((e) => e.kind === 'war' && entryInvolves(e, meId) && Math.floor(e.year) <= Y && Math.floor(e.end) >= Y);
    out.push(`- 正在打的仗:${wars.length ? wars.slice(0, 4).map(entryLine).join(';') : '没有'}`);
    const mine = chronicle.filter((e) => entryInvolves(e, meId) && Math.floor(e.year) <= Y).slice(-6);
    if (mine.length) {
      out.push('- 我国最近的大事:');
      for (const e of mine) out.push(`  - ${entryLine(e)}`);
    }
    const cmds = play.commands.filter((v) => 'a' in v && v.a === myKey).slice(-6);
    if (cmds.length) {
      out.push(`- 你之前下过的命令:${cmds.map((v) => `第 ${v.from} 年 ${ivText(civ, v)}`).join(';')}`);
    }
  }
  out.push('');
  out.push(`## 天下大势(第 ${Y} 年在世 ${aliveList.length} 国,按大小排)`);
  for (const p of aliveList.slice(0, 12)) {
    const cap = capitalAt(p, Y);
    const pNear = [...bordersAt(civ, own, p.id, Y)].sort((a, b) => a - b).slice(0, 5);
    out.push(`- P${p.id} ${nameAt(p, Y)} · ${size.get(p.id)} 州 · 国都 ${civ.settlements[cap]?.name ?? `C${cap}`}${pNear.length ? ` · 邻国 ${pNear.map((q) => `P${q}`).join('、')}` : ''}`);
  }
  const latest = chronicle.filter((e) => Math.floor(e.year) <= Y).slice(-8);
  if (latest.length) {
    out.push('');
    out.push('## 天下最近发生的事(编年史)');
    for (const e of latest) out.push(`- ${entryLine(e)}`);
  }
  out.push('');
  out.push(COMMAND_HELP);
  out.push('');
  out.push('## 输出格式');
  out.push('只输出一个 JSON 对象,不要解释、不要代码块标记:');
  out.push(`{"reason":"一句话说明今年为什么这么决定","commands":[{"kind":"policy","preset":"expand"}]}`);
  out.push('commands 可以是空数组(今年什么也不做)。');
  return { year: Y, myId: meId, myKey, size: size.get(meId) ?? 0, alive: meAlive, text: out.join('\n') };
}
