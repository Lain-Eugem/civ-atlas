/**
 * DM 硬命令(上帝视角):把中文自然语言解析成引擎命令 → 排队 → 下一回合开始时由 turnStep 取走执行。
 *
 * 修正(m05242):这个游戏里**没有"玩家国家"**。DM 是上帝/裁定者,可以直接对任意国家下硬命令,
 * 所以解析必须显式点名国家(A 对 B 开战 / 让 A 停止扩张 / 灭掉 X),不再从"自己的国家"补参数。
 * 找不到国家名或动作时返回 ok:false,并给上帝视角的示例。
 *
 * 设计:
 * - 解析只做"意图 → 命令骨架";字段合法性仍由 orders.ts 的 cleanOrders 把关(route 层调用);
 * - 队列挂在 Session.playerCommands 上;每回合最多取 PLAYER_CMD_PER_ROUND 条;
 * - 记录保留原文、解析摘要、状态(applied/rejected/撤销),给 UI 与 DM 页签展示;
 * - 本模块不 import engine 的运行时符号(只用 type),避免引擎 ↔ 本模块的运行时循环依赖。
 */
import type { Session } from './engine';

export interface PlayerCommandSpec {
  kind: string;
  [k: string]: unknown;
}

export interface PlayerCommandRecord {
  id: number;
  text: string;
  commands: PlayerCommandSpec[];
  summary: string;
  status: 'pending' | 'applied' | 'rejected';
  note?: string;
  round?: number;
  atYear?: number;
}

export interface PlayerCommandState {
  nextId: number;
  pending: PlayerCommandRecord[];
  history: PlayerCommandRecord[];
}

/** 待执行上限(防止刷屏/一次塞爆回合) */
export const PLAYER_CMD_MAX_PENDING = 10;
/** 每个回合开始最多执行几条 */
export const PLAYER_CMD_PER_ROUND = 5;

export function newPlayerCommandState(): PlayerCommandState {
  return { nextId: 1, pending: [], history: [] };
}

function stateOf(s: Session): PlayerCommandState {
  if (!s.playerCommands) s.playerCommands = newPlayerCommandState();
  return s.playerCommands;
}

export interface PlayerPolity {
  id: number;
  name: string;
  key: string;
}

export interface ParseContext {
  /** 全部在世国家;命令必须显式点名其中至少一个 */
  polities: PlayerPolity[];
}

export interface ParseResult {
  ok: boolean;
  commands: PlayerCommandSpec[];
  summary: string;
  notes: string[];
  rejected: string[];
}

const POLITY_SUFFIX = /(王国|帝国|共和国|汗国|皇朝|王朝|联邦|公国|酋长国|城邦|部|联盟)$/;

/** 去掉国名后缀,便于「埃维罗尔」这种简称也能匹配 */
function bare(name: string): string {
  return name.replace(POLITY_SUFFIX, '');
}

interface Alias {
  text: string;
  polity: PlayerPolity;
}

function aliasesOf(p: PlayerPolity): Alias[] {
  const out: Alias[] = [{ text: p.name, polity: p }];
  // P<编号> / p<编号>
  out.push({ text: `P${p.id}`, polity: p }, { text: `p${p.id}`, polity: p });
  const b = bare(p.name);
  if (b.length >= 2 && b !== p.name) out.push({ text: b, polity: p });
  return out;
}

interface Mention {
  polity: PlayerPolity;
  start: number;
  end: number;
}

/**
 * 扫描文本里出现的所有国家(全名/去后缀简称/P编号),按起点升序、长度降序贪心取不重叠的提及。
 * 例如「让 康罗皇朝 对 新哈德斯坦帝国 开战」→ [康罗皇朝, 新哈德斯坦帝国]。
 */
function scanMentions(text: string, ctx: ParseContext): Mention[] {
  const cands: Mention[] = [];
  for (const p of ctx.polities) {
    for (const a of aliasesOf(p)) {
      if (!a.text) continue;
      let from = 0;
      while (from <= text.length - a.text.length) {
        const i = text.indexOf(a.text, from);
        if (i < 0) break;
        cands.push({ polity: p, start: i, end: i + a.text.length });
        from = i + 1;
      }
    }
  }
  cands.sort((x, y) => x.start - y.start || y.end - y.start - (x.end - x.start) || x.polity.id - y.polity.id);
  const picked: Mention[] = [];
  let lastEnd = -1;
  for (const c of cands) {
    if (c.start < lastEnd) continue;
    picked.push(c);
    lastEnd = c.end;
  }
  return picked;
}

/** 把命中的国家名替换成等长空格,剩下的是动词/介词等,便于判断意图 */
function maskMentions(text: string, mentions: Mention[]): string {
  let out = '';
  let last = 0;
  for (const m of mentions) {
    out += text.slice(last, m.start);
    out += ' '.repeat(m.end - m.start);
    last = m.end;
  }
  out += text.slice(last);
  return out;
}

type Intent =
  | 'destroy'
  | 'war'
  | 'ally'
  | 'intel'
  | 'peace'
  | 'expand'
  | 'hold'
  | 'trade'
  | 'boost'
  | 'press'
  | 'unity'
  | 'keep'
  | 'neutral';

/** 动作识别:按顺序取第一个命中的,顺序对「停止扩张/不许议和/不结盟」这类否定式很关键 */
const INTENT_RULES: { kind: Intent; re: RegExp }[] = [
  { kind: 'destroy', re: /(灭掉|消灭|征服|吞并|灭国|灭亡)/ },
  { kind: 'war', re: /(宣战|开战|开打|发动战争)/ },
  { kind: 'press', re: /(坚持打|继续打|打到底|不许议和|不准议和)/ },
  { kind: 'peace', re: /(停战|议和|休战|停火|和谈)/ },
  { kind: 'hold', re: /(停止扩张|别扩张|不要扩张|休养生息|守住|防守|守成|防御)/ },
  { kind: 'expand', re: /(扩张|进攻|出击|开疆)/ },
  { kind: 'trade', re: /(通商|贸易|做生意|经商)/ },
  { kind: 'boost', re: /(发展|繁荣|建设|兴修)/ },
  { kind: 'unity', re: /(禁止分裂|不许分裂)/ },
  { kind: 'keep', re: /(保住王室|保住王朝|不许改朝换代)/ },
  { kind: 'intel', re: /(渗透|打探|派间谍|刺探)/ },
  { kind: 'neutral', re: /(不结盟|保持中立|中立)/ },
  { kind: 'ally', re: /(结盟|联盟|同盟|缔结同盟)/ },
];

const DUAL_INTENTS = new Set<Intent>(['war', 'ally', 'intel']);

function namesOf(mentions: Mention[]): string {
  return mentions.map((m) => m.polity.name).join('、');
}

function exampleHint(ctx: ParseContext): string {
  const names = ctx.polities.slice(0, 4).map((p) => p.name);
  const a = names[0] ?? '甲国';
  const b = names[1] ?? names[0] ?? '乙国';
  return `例如:「让 ${a} 对 ${b} 开战」「让 ${a} 停止扩张」「灭掉 ${b}」(国家名可换成全名/简称,或用 P<编号> 指代)`;
}

function reject(out: ParseResult, ...messages: string[]): ParseResult {
  out.rejected.push(...messages);
  return out;
}

interface SoloRule {
  kind: Intent;
  spec: (key: string) => PlayerCommandSpec;
  summary: (name: string) => string;
}

const SOLO_RULES: Record<string, SoloRule> = {
  peace: { kind: 'peace', spec: (key) => ({ kind: 'policy', a: key, preset: 'peace' }), summary: (n) => `${n} 转为议和姿态` },
  expand: { kind: 'expand', spec: (key) => ({ kind: 'policy', a: key, preset: 'expand' }), summary: (n) => `${n} 转为扩张姿态` },
  hold: { kind: 'hold', spec: (key) => ({ kind: 'policy', a: key, preset: 'hold' }), summary: (n) => `${n} 转为守成姿态` },
  trade: { kind: 'trade', spec: (key) => ({ kind: 'policy', a: key, preset: 'trade' }), summary: (n) => `${n} 转为通商姿态` },
  boost: { kind: 'boost', spec: (key) => ({ kind: 'boost', a: key }), summary: (n) => `${n} 推一把发展` },
  press: { kind: 'press', spec: (key) => ({ kind: 'press', a: key }), summary: (n) => `${n} 坚持打这一仗` },
  unity: { kind: 'unity', spec: (key) => ({ kind: 'unity', a: key }), summary: (n) => `${n} 禁止分裂` },
  keep: { kind: 'keep', spec: (key) => ({ kind: 'keep', a: key }), summary: (n) => `${n} 保住王室` },
  neutral: { kind: 'neutral', spec: (key) => ({ kind: 'neutral', a: key }), summary: (n) => `${n} 改为中立` },
};

/** 规则解析:返回命令骨架 + 摘要;不合法/不支持时 ok=false 并给上帝视角示例 */
export function parsePlayerCommand(text: string, ctx: ParseContext): ParseResult {
  const src = String(text || '').trim();
  const out: ParseResult = { ok: false, commands: [], summary: '', notes: [], rejected: [] };
  if (!src) return reject(out, '命令是空的');
  if (src.length > 500) return reject(out, '命令太长了(限 500 字)');
  const t = src.replace(/[。！!？?，,;；\s]+$/g, '');
  const polities = ctx.polities ?? [];

  const mentions = scanMentions(t, { polities });
  const masked = maskMentions(t, mentions);
  const rule = INTENT_RULES.find((r) => r.re.test(masked));
  if (!rule) {
    return reject(
      out,
      mentions.length
        ? `没听懂要对「${mentions[0].polity.name}」做什么。可用动作:宣战/开战、结盟、渗透、灭掉、停止扩张、扩张、通商、发展、坚持打、中立。${exampleHint({ polities })}`
        : `没听懂这条命令。命令里要明确点名国家。${exampleHint({ polities })}`,
    );
  }

  const kind = rule.kind;
  const n = mentions.length;
  const unique = [...new Set(mentions.map((m) => m.polity.id))];

  // 1) 灭国:1 个国家 = 灭掉它(国土散成无主);2 个国家 = 让第一个灭掉第二个(国土并入第一个)
  if (kind === 'destroy') {
    if (n === 0) return reject(out, `命令里没有点名国家。${exampleHint({ polities })}`);
    if (n > 2) return reject(out, `灭国命令最多点名两个国家(识别到 ${n} 个:${namesOf(mentions)})。请分开下命令。`);
    if (n === 2 && unique.length === 1) return reject(out, `两方都是「${mentions[0].polity.name}」,需要两个不同国家。`);
    if (n === 1) {
      const victim = mentions[0].polity;
      out.commands.push({ kind: 'destroy', a: victim.key });
      out.summary = `灭掉 ${victim.name}(国土散成无主)`;
    } else {
      const joiner = mentions[0].polity;
      const victim = mentions[1].polity;
      if (victim.id === joiner.id) return reject(out, '灭国需要两个不同国家。');
      out.commands.push({ kind: 'destroy', a: victim.key, b: joiner.key });
      out.summary = `让 ${joiner.name} 灭掉 ${victim.name}(国土并入 ${joiner.name})`;
    }
    out.notes.push('灭国命令由引擎判定可行性(不接壤/实力悬殊时可能打不成)');
    out.ok = true;
    return out;
  }

  // 2) 两国命令:必须正好点名两个不同国家
  if (DUAL_INTENTS.has(kind)) {
    if (n === 0) return reject(out, `命令里没有点名国家。${exampleHint({ polities })}`);
    if (n === 1) {
      const one = mentions[0].polity;
      const other = polities.find((p) => p.id !== one.id);
      const hint = other
        ? `例如:「让 ${one.name} 对 ${other.name} 开战」「让 ${one.name} 与 ${other.name} 结盟」`
        : '请点名两个国家。';
      return reject(out, `命令里只点名了「${one.name}」,还差一方。${hint}`);
    }
    if (n > 2) return reject(out, `这条命令一次只能点名两个国家(识别到 ${n} 个:${namesOf(mentions)})。请分开下命令。`);
    const a = mentions[0].polity;
    const b = mentions[1].polity;
    if (a.id === b.id) return reject(out, `两方都是「${a.name}」,${kind === 'war' ? '宣战' : kind === 'ally' ? '结盟' : '渗透'}需要两个不同国家。`);
    if (kind === 'war') {
      out.commands.push({ kind: 'declare', a: a.key, b: b.key });
      out.summary = `${a.name} 对 ${b.name} 宣战`;
    } else if (kind === 'ally') {
      out.commands.push({ kind: 'ally', a: a.key, b: b.key });
      out.summary = `${a.name} 与 ${b.name} 结盟`;
    } else {
      out.commands.push({ kind: 'intel', a: a.key, b: b.key, focus: 'all' });
      out.summary = `${a.name} 渗透 ${b.name}(收集情报)`;
    }
    out.ok = true;
    return out;
  }

  // 3) 单国命令:必须正好点名一个国家
  if (n === 0) return reject(out, `命令里没有点名国家。${exampleHint({ polities })}`);
  if (n > 1) return reject(out, `这条单国命令只作用于一个国家,但识别到 ${n} 个:${namesOf(mentions)}。请分开下命令。`);
  const solo = SOLO_RULES[kind];
  if (!solo) return reject(out, `暂时不支持这个动作:${kind}`);
  const self = mentions[0].polity;
  out.commands.push(solo.spec(self.key));
  out.summary = solo.summary(self.name);
  out.ok = true;
  return out;
}

/** 入队(不超过上限);返回新记录,null = 待执行已满 */
export function queuePlayerCommand(
  s: Session,
  input: { text: string; commands: PlayerCommandSpec[]; summary: string },
): PlayerCommandRecord | null {
  const st = stateOf(s);
  if (st.pending.length >= PLAYER_CMD_MAX_PENDING) return null;
  const rec: PlayerCommandRecord = {
    id: st.nextId++,
    text: input.text,
    commands: input.commands,
    summary: input.summary,
    status: 'pending',
  };
  st.pending.push(rec);
  return rec;
}

/** 撤销一条待执行命令 */
export function cancelPlayerCommand(s: Session, id: number): PlayerCommandRecord | null {
  const st = stateOf(s);
  const i = st.pending.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const [rec] = st.pending.splice(i, 1);
  rec.status = 'rejected';
  rec.note = '已撤销';
  st.history.push(rec);
  return rec;
}

/** 取走本回合要执行的命令(最多 max 条),写回首年/回合信息 */
export function drainPlayerCommands(s: Session, max: number = PLAYER_CMD_PER_ROUND): PlayerCommandSpec[] {
  const st = stateOf(s);
  const take = st.pending.splice(0, Math.max(0, max));
  const commands: PlayerCommandSpec[] = [];
  for (const rec of take) {
    rec.status = 'applied';
    rec.round = s.rounds + 1;
    rec.atYear = s.play.year;
    rec.note = `第 ${rec.round} 回合执行(第 ${Math.floor(rec.atYear)} 年)`;
    st.history.push(rec);
    commands.push(...rec.commands);
  }
  return commands;
}

/** 给 UI 的视图:待执行 + 最近历史(逆序) */
export function playerCommandView(s: Session): {
  pending: PlayerCommandRecord[];
  recent: PlayerCommandRecord[];
  maxPending: number;
  perRound: number;
} {
  const st = stateOf(s);
  return {
    pending: st.pending.map((r) => ({ ...r, commands: r.commands.map((c) => ({ ...c })) })),
    recent: st.history.slice(-20).reverse().map((r) => ({ ...r })),
    maxPending: PLAYER_CMD_MAX_PENDING,
    perRound: PLAYER_CMD_PER_ROUND,
  };
}
