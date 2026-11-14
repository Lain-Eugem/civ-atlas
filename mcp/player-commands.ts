/**
 * 玩家硬命令(推演中的 DM 对话框):把中文自然语言解析成引擎命令 → 排队 → 下一回合开始时由 turnStep 取走执行。
 *
 * 设计:
 * - 解析只做"意图 → 命令骨架";字段合法性仍由 orders.ts 的 cleanOrders 把关(route 层调用);
 * - 队列挂在 Session.playerCommands 上;每回合最多取 PLAYER_CMD_PER_ROUND 条;
 * - 记录保留原文、解析摘要、状态(applied/rejected/撤销),给 UI 与 DM 页签展示;
 * - 本模块不 import engine 的运行时符号(只用 type),避免引擎 ↔ 本模块的运行时循环依赖。
 * - LLM 通道:后续可在 parsePlayerCommand 之前加一层 LLM 解析;当前规则解析离线可跑、可回放。
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
  /** 玩家自己的国家(没选 = null,此时需要 a 的命令会被拒) */
  player: PlayerPolity | null;
  /** 全部在世国家(含玩家自己) */
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

/** 在在世国家里按 名字/简称/编号 找目标;找不到返回候选提示 */
function findPolity(token: string, ctx: ParseContext, allowSelf: boolean): PlayerPolity | string {
  const raw = token.trim().replace(/[《》"“”'']/g, '');
  if (!raw) return '没写国家名';
  const pool = allowSelf ? ctx.polities : ctx.polities.filter((p) => !ctx.player || p.id !== ctx.player.id);
  const direct = raw.match(/^(?:P|p)?(\d{1,4})$/);
  if (direct) {
    const id = Number(direct[1]);
    const hit = pool.find((p) => p.id === id);
    return hit ?? `没有编号 P${id} 的国家`;
  }
  const lower = raw.toLowerCase();
  const exact = pool.filter((p) => p.name === raw || bare(p.name) === raw);
  if (exact.length === 1) return exact[0];
  const fuzzy = pool.filter((p) => p.name.includes(raw) || bare(p.name).includes(raw) || p.name.toLowerCase().includes(lower));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) return `「${raw}」不唯一,可能是:${fuzzy.slice(0, 4).map((p) => p.name).join('、')}`;
  return `没有找到国名含「${raw}」的国家(可用 P<编号>,例如 P8)`;
}

function pickPlayer(ctx: ParseContext): PlayerPolity | string {
  if (ctx.player) return ctx.player;
  return '还没选自己的国家:先在「开局设置」里选国家,再下命令';
}

/** 规则解析:返回命令骨架 + 摘要;不合法/不支持时 ok=false 并给提示 */
export function parsePlayerCommand(text: string, ctx: ParseContext): ParseResult {
  const src = String(text || '').trim();
  const out: ParseResult = { ok: false, commands: [], summary: '', notes: [], rejected: [] };
  if (!src) { out.rejected.push('命令是空的'); return out; }
  if (src.length > 500) { out.rejected.push('命令太长了(限 500 字)'); return out; }
  const t = src.replace(/[。！!？?，,;；\s]+$/g, '');

  const needPlayer = (): PlayerPolity | null => {
    const p = pickPlayer(ctx);
    if (typeof p === 'string') { out.rejected.push(p); return null; }
    return p;
  };

  // 1) 宣战 / 开战
  let m = t.match(/^(?:对|向|跟|和)\s*(.+?)\s*(?:宣战|开战)$/) || t.match(/^(?:宣战|开战)\s*(.+)$/) || t.match(/^打\s*(.+)$/);
  if (m) {
    const me = needPlayer(); if (!me) return out;
    const target = findPolity(m[1], ctx, false);
    if (typeof target === 'string') { out.rejected.push(target); return out; }
    out.commands.push({ kind: 'declare', a: me.key, b: target.key });
    out.summary = `对 ${target.name} 宣战`;
    out.ok = true;
    return out;
  }
  // 2) 结盟
  m = t.match(/^(?:与|和|跟)\s*(.+?)\s*(?:结盟|联盟|同盟|缔结同盟)$/);
  if (m) {
    const me = needPlayer(); if (!me) return out;
    const target = findPolity(m[1], ctx, false);
    if (typeof target === 'string') { out.rejected.push(target); return out; }
    out.commands.push({ kind: 'ally', a: me.key, b: target.key });
    out.summary = `与 ${target.name} 结盟`;
    out.ok = true;
    return out;
  }
  // 3) 灭国 / 征服
  m = t.match(/^(?:灭掉|消灭|征服|吞并)\s*(.+)$/);
  if (m) {
    const me = needPlayer(); if (!me) return out;
    const target = findPolity(m[1], ctx, false);
    if (typeof target === 'string') { out.rejected.push(target); return out; }
    out.commands.push({ kind: 'destroy', a: me.key, b: target.key });
    out.summary = `灭掉 ${target.name}`;
    out.notes.push('灭国命令由引擎判定可行性(不接壤/实力悬殊时可能打不成)');
    out.ok = true;
    return out;
  }
  // 4) 渗透 / 打探
  m = t.match(/^(?:渗透|打探|派间谍|刺探)\s*(.+)$/);
  if (m) {
    const me = needPlayer(); if (!me) return out;
    const target = findPolity(m[1], ctx, false);
    if (typeof target === 'string') { out.rejected.push(target); return out; }
    out.commands.push({ kind: 'intel', a: me.key, b: target.key, focus: 'all' });
    out.summary = `渗透 ${target.name}`;
    out.ok = true;
    return out;
  }
  // 5) 国策类 / 其他单国命令
  const solo: { re: RegExp; spec: (me: PlayerPolity) => PlayerCommandSpec; summary: string }[] = [
    { re: /^(?:停战|议和|休战|停火)$/, spec: (me) => ({ kind: 'policy', a: me.key, preset: 'peace' }), summary: '转为议和姿态' },
    { re: /^(?:扩张|进攻|开疆|扩张领土)$/, spec: (me) => ({ kind: 'policy', a: me.key, preset: 'expand' }), summary: '转为扩张姿态' },
    { re: /^(?:防守|守成|停止扩张|休养生息)$/, spec: (me) => ({ kind: 'policy', a: me.key, preset: 'hold' }), summary: '转为守成姿态' },
    { re: /^(?:通商|贸易|发展贸易)$/, spec: (me) => ({ kind: 'policy', a: me.key, preset: 'trade' }), summary: '转为通商姿态' },
    { re: /^(?:发展|繁荣|提升发展|搞发展)$/, spec: (me) => ({ kind: 'boost', a: me.key }), summary: '推一把发展' },
    { re: /^(?:坚持打|继续打|不许议和)$/, spec: (me) => ({ kind: 'press', a: me.key }), summary: '坚持打这一仗' },
    { re: /^(?:禁止分裂|不许分裂)$/, spec: (me) => ({ kind: 'unity', a: me.key }), summary: '禁止分裂' },
    { re: /^(?:保住王室|不许改朝换代)$/, spec: (me) => ({ kind: 'keep', a: me.key }), summary: '保住王室' },
    { re: /^(?:中立)$/, spec: (me) => ({ kind: 'neutral', a: me.key }), summary: '改为中立' },
  ];
  for (const rule of solo) {
    if (rule.re.test(t)) {
      const me = needPlayer(); if (!me) return out;
      out.commands.push(rule.spec(me));
      out.summary = rule.summary;
      out.ok = true;
      return out;
    }
  }

  out.rejected.push(
    '没听懂这条命令。可用示例:对 X 开战 / 与 X 结盟 / 灭掉 X / 渗透 X / 停止扩张 / 扩张 / 通商 / 发展 / 坚持打 / 中立(把 X 换成国家名或 P<编号>)',
  );
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
    atYear: s.play.year,
  };
  st.pending.push(rec);
  return rec;
}

/** 撤销一条待执行;返回被撤销的记录,null = 没找到 */
export function cancelPlayerCommand(s: Session, id: number): PlayerCommandRecord | null {
  const st = stateOf(s);
  const idx = st.pending.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const [rec] = st.pending.splice(idx, 1);
  rec.status = 'rejected';
  rec.note = '玩家撤销';
  st.history.push(rec);
  return rec;
}

/** 回合开始时取走待执行命令(最多 max 条),标记已执行;返回命令骨架数组 */
export function drainPlayerCommands(s: Session, max: number = PLAYER_CMD_PER_ROUND): PlayerCommandSpec[] {
  const st = stateOf(s);
  if (!st.pending.length) return [];
  const take = st.pending.splice(0, Math.max(0, Math.min(max, st.pending.length)));
  const round = s.rounds + 1;
  const out: PlayerCommandSpec[] = [];
  for (const rec of take) {
    out.push(...rec.commands);
    rec.status = 'applied';
    rec.round = round;
    rec.note = `第 ${round} 回合执行(第 ${s.play.year} 年)`;
    st.history.push(rec);
  }
  return out;
}

/** 给 stateView / API 的只读视图 */
export function playerCommandView(s: Session): {
  pending: PlayerCommandRecord[];
  recent: PlayerCommandRecord[];
  maxPending: number;
  perRound: number;
} {
  const st = stateOf(s);
  return {
    pending: st.pending.map((r) => ({ ...r })),
    recent: st.history.slice(-20).reverse().map((r) => ({ ...r })),
    maxPending: PLAYER_CMD_MAX_PENDING,
    perRound: PLAYER_CMD_PER_ROUND,
  };
}