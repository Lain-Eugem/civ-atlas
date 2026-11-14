/**
 * DM 对话 / Jev 裁决的展示数据（纯函数，不碰 DOM）
 *
 * 查看器原来把 DM 小决策、小事件裁决都挤在「回合日志」页签里（app.js 的 dmOnly /
 * pettyOnly 合并渲染）。这里把它们各自整理成一条条「对话回合」，给前端单独的
 * DM 对话 / Jev 裁决页签用：
 *   - DM：一次 dmRound（或君主回合内嵌的一次 DM 决策）= 一条 DialogueRound；
 *   - Jev：一次 pettyRound（或君主回合内嵌的小事件结算）= 一条 DialogueRound；
 *   - monarch：可选的君主回合（kind:'monarch' 时才返回），一回合一条。
 *
 * 关于「模型原始对话」：这个仓库目前没有任何地方把 DM / Jev 的原始提示词与
 * 原始回复落盘 ——
 *   - DM：dm-round-*.json 与内存记录同构，只有 reason/decisions/notes；
 *     提示词由 renderDmPrompt 临时生成后丢弃，模型回复解析后也丢弃。
 *   - Jev：PettySettlement.context 是真实提示词（落盘在 petty-round-*.json 里）；
 *     模型的原始回答（answers 文本）只转成 probabilities，不落盘。
 * 所以这里做了两件事：
 *   1) 先尝试从 round 日志文件里读 prompt / reply 之类的原文（未来若补了落盘字段，
 *      自动用上）；读不到就退化为按回合记录生成的摘要；
 *   2) 把「哪些字段是摘要」写进 warnings，界面上一眼能看见，不冒充原始对话。
 *
 * 体积：所有文本单条裁剪到 ≤2000 字；返回的整体 JSON 压到约 280KB 以内
 * （先缩文本，再丢最早的回合，total 仍保留完整回合数），避免 200 回合时把查看器
 * 的接口撑爆。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { polityName } from '../src/gen/civ/growth';
import {
  DISASTER_LEVEL_NAMES,
  DISASTER_NAMES,
  polityKey,
  regionKey,
  settlementKey,
} from '../src/gen/edits';
import type { Session } from './engine';

export type DialogueKind = 'dm' | 'jev' | 'monarch';
export type DialogueStatus = 'ok' | 'fallback' | 'error';

export interface DialogueCommand {
  kind: string;
  text: string;
}

export interface DialogueDecision {
  kind: string;
  title: string;
  detail: string;
  commands: DialogueCommand[];
  accepted?: boolean;
  rejected?: string[];
}

export interface DialogueRound {
  id: string;
  kind: DialogueKind;
  round: number;
  fromYear: number;
  toYear: number;
  source: string;
  status: DialogueStatus;
  prompt: string;
  reply: string;
  decisions: DialogueDecision[];
  notes: string[];
  error?: string;
}

export interface DialogueViewData {
  rounds: DialogueRound[];
  total: { dm: number; jev: number };
  warnings: string[];
}

export interface DialogueViewOptions {
  /** 每类最多返回最近多少回合（默认 60，钳到 1..200） */
  limit?: number;
  /** 只取某一类；不传 = dm + jev（monarch 需要显式传） */
  kind?: DialogueKind;
}

const MAX_TEXT = 2000;
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;
const MAX_DECISIONS = 40;
const MAX_NOTES = 12;
const MAX_WARNINGS = 12;
const RAW_BUDGET = 280_000;
const SOFT_BUDGET = RAW_BUDGET - 4_000;
const TEXT_CAPS = [MAX_TEXT, 1200, 800, 500, 350, 240, 160] as const;

const DM_KIND_LABEL: Record<string, string> = {
  disaster: '天灾',
  trade: '小贸易',
  story: '故事事件',
  rejected: '拒收',
  digest: '汇总',
};

/* ------------------------------------------------------------------ *
 * 读数据的防御小工具（rounds 里是 Record<string, unknown>）
 * ------------------------------------------------------------------ */

function recOf(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function listOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function strOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return String(v);
  }
}

function numOf(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function hasText(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/** 有的字段是数组（命令列表），有的字段是数字（条数），统一取个数 */
function countOf(v: unknown): number {
  if (Array.isArray(v)) return v.length;
  return Math.max(0, Math.round(numOf(v)));
}

function clip(v: unknown, max = MAX_TEXT): string {
  const t = strOf(v);
  const lim = Math.max(16, Math.floor(max));
  if (t.length <= lim) return t;
  return `${t.slice(0, lim - 1)}…`;
}

function clipList(v: unknown, max = 240, limit = MAX_NOTES): string[] {
  return listOf(v)
    .map((x) => clip(x, max))
    .filter((x) => x.length > 0)
    .slice(0, limit);
}

function pad4(n: number): string {
  return String(Math.max(0, Math.floor(n))).padStart(4, '0');
}

function fixed(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '?';
}

/* ------------------------------------------------------------------ *
 * 稳定键 → 可读名字（找不到就退回键本身）
 * ------------------------------------------------------------------ */

interface BuildCtx {
  s: Session;
  names: Map<string, string> | null;
  dmLogMissing: number;
  dmLogNoRaw: number;
  dmLogRaw: number;
  jevCtxMissing: number;
  jevLogMissing: number;
  monarchBriefsMissing: number;
  embeddedDm: number;
  embeddedJev: number;
  embeddedJevDigestOnly: number;
}

/** 给命令 chip 用：把 polity:/settlement:/region: 稳定键翻成国名/城名/州名 */
function buildNameMap(s: Session): Map<string, string> | null {
  try {
    const out = new Map<string, string>();
    const year = Math.floor(numOf(s.play.year));
    const civ = s.civ;
    for (const p of civ.polities) {
      try {
        out.set(polityKey(civ, p.id), polityName(p, year));
      } catch {
        /* 单个国家翻不出来就跳过 */
      }
    }
    for (const st of civ.settlements) {
      if (st && typeof st.name === 'string' && st.name) out.set(settlementKey(civ, st.id), st.name);
    }
    const regions = civ.regions;
    for (let r = 0; r < regions.count; r += 1) {
      out.set(regionKey(civ, r), regions.name?.[r] || `第 ${r + 1} 州`);
    }
    return out;
  } catch {
    return null;
  }
}

function refText(ctx: BuildCtx, key: unknown): string {
  const k = strOf(key);
  if (!k) return '';
  const name = ctx.names?.get(k);
  if (name) return name;
  return k.length > 48 ? `${k.slice(0, 47)}…` : k;
}

/* ------------------------------------------------------------------ *
 * 引擎命令 → 一行可读文本（给 chip 用）
 * ------------------------------------------------------------------ */

function commandText(ctx: BuildCtx, c: Record<string, unknown>): string {
  const kind = strOf(c.kind);
  const ref = (v: unknown): string => refText(ctx, v);
  const refs = (v: unknown): string =>
    listOf(v)
      .map((x) => ref(x))
      .filter(Boolean)
      .join('、');
  const where = (): string => ref(c.city) || ref(c.region) || ref(c.a) || refs(c.regions);
  const at = (): string => {
    const w = where();
    if (w) return ` → ${w}`;
    const b = ref(c.b);
    return b ? ` → ${b}` : '';
  };
  switch (kind) {
    case 'disaster': {
      const type = strOf(c.type) as keyof typeof DISASTER_NAMES;
      const name = DISASTER_NAMES[type] ?? strOf(c.type) ?? '天灾';
      const lv = DISASTER_LEVEL_NAMES[numOf(c.level, 2)] ?? '';
      return `天灾·${name}${lv ? `(${lv})` : ''}${at()}`;
    }
    case 'petty': {
      const e = recOf(c.effect);
      const t = strOf(e.type) || 'effect';
      if (t === 'sack') {
        const city = ref(e.city) || ref(e.region);
        return `小事件·洗劫(loss ${numOf(e.loss, 1)}${city ? `, ${city}` : ''})${at()}`;
      }
      if (t === 'dev') return `小事件·发展加速(${numOf(e.years, 0)} 年)${at()}`;
      return `小事件·${t}${at()}`;
    }
    case 'story': {
      const title = clip(strOf(c.title) || '无题', 60);
      return `故事「${title}」${at()}`;
    }
    case 'policy': {
      if (hasText(c.preset)) return `国策·${strOf(c.preset)}`;
      return '国策调整';
    }
    case 'declare':
      return `宣战${at()}`;
    case 'ally':
      return `结盟${at()}`;
    case 'halt':
      return '休养生息(不扩张)';
    case 'protect':
      return '保护本国';
    case 'boost':
      return `发展加速 ×${strOf(c.mul) || '?'}`;
    case 'press':
      return `坚持打${ref(c.b) ? ` → ${ref(c.b)}` : ''}`;
    case 'treaty':
      return `立约${at()}`;
    case 'cede':
      return `割让${at()}`;
    case 'destroy':
      return `灭国${at()}`;
    case 'move':
      return `迁都${ref(c.city) ? ` → ${ref(c.city)}` : ''}`;
    case 'intel':
      return `渗透${ref(c.b) ? ` → ${ref(c.b)}` : ''}`;
    case 'found':
      return `立国${ref(c.region) ? ` → ${ref(c.region)}` : ''}`;
    case 'crown':
      return `即位${at()}`;
    case 'keep':
      return '守成';
    case 'death':
      return '人物去世';
    case 'temper':
      return '改倾向';
    case 'marry':
      return `联姻${at()}`;
    case 'appoint':
      return `任命${at()}`;
    case 'trek':
      return '迁徙';
    case 'stay':
      return '定居';
    case 'unity':
      return '统一';
    case 'neutral':
      return `中立${at()}`;
    case 'regent':
      return '摄政';
    default:
      return kind || '命令';
  }
}

function commandOf(ctx: BuildCtx, raw: unknown): DialogueCommand | null {
  const c = recOf(raw);
  const kind = strOf(c.kind);
  if (!kind) return null;
  return { kind, text: clip(commandText(ctx, c), 240) };
}

function commandsOf(ctx: BuildCtx, raw: unknown): DialogueCommand[] {
  return listOf(raw)
    .map((x) => commandOf(ctx, x))
    .filter((x): x is DialogueCommand => x !== null)
    .slice(0, MAX_DECISIONS);
}

/* ------------------------------------------------------------------ *
 * 日志文件补原文（只读；读不到就退化）
 * ------------------------------------------------------------------ */

function pickLogText(o: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) {
    if (hasText(o[k])) return strOf(o[k]);
  }
  // 兼容未来可能存的 messages: [{role,content},…]
  const messages = listOf(o.messages);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = recOf(messages[i]);
    const role = strOf(m.role);
    if ((role === 'assistant' || role === 'user') && hasText(m.content)) return strOf(m.content);
  }
  return '';
}

interface LogTexts {
  existed: boolean;
  prompt: string;
  reply: string;
}

function readRoundLog(s: Session, file: string, promptKeys: readonly string[], replyKeys: readonly string[]): LogTexts {
  const path = join(s.logDir, file);
  try {
    if (!existsSync(path)) return { existed: false, prompt: '', reply: '' };
    const o = recOf(JSON.parse(readFileSync(path, 'utf8')));
    return { existed: true, prompt: pickLogText(o, promptKeys), reply: pickLogText(o, replyKeys) };
  } catch {
    return { existed: false, prompt: '', reply: '' };
  }
}

const DM_PROMPT_KEYS = ['prompt', 'promptText', 'userPrompt', 'input'] as const;
const DM_REPLY_KEYS = ['reply', 'rawReply', 'assistantReply', 'output'] as const;
const PETTY_PROMPT_KEYS = ['context', 'prompt', 'userPrompt', 'input'] as const;
const PETTY_REPLY_KEYS = ['reply', 'rawReply', 'answers', 'output'] as const;

function readDmLog(s: Session, round: number, ctx: BuildCtx): LogTexts {
  const log = readRoundLog(s, `dm-round-${pad4(round)}.json`, DM_PROMPT_KEYS, DM_REPLY_KEYS);
  if (!log.existed) {
    ctx.dmLogMissing += 1;
    return log;
  }
  if (log.prompt || log.reply) ctx.dmLogRaw += 1;
  else ctx.dmLogNoRaw += 1;
  return log;
}

function readPettyLog(s: Session, round: number, ctx: BuildCtx): LogTexts {
  const log = readRoundLog(s, `petty-round-${pad4(round)}.json`, PETTY_PROMPT_KEYS, PETTY_REPLY_KEYS);
  if (!log.existed) ctx.jevLogMissing += 1;
  return log;
}

function readMonarchBriefs(s: Session, round: number, ctx: BuildCtx): string {
  const log = readRoundLog(s, `monarch-round-${pad4(round)}.json`, ['briefs'], []);
  if (!log.existed) {
    ctx.monarchBriefsMissing += 1;
    return '';
  }
  return log.prompt;
}

/* ------------------------------------------------------------------ *
 * 决策 → DialogueDecision
 * ------------------------------------------------------------------ */

function rejectedDecision(raw: unknown, label = '拒收/退回'): DialogueDecision {
  const o = recOf(raw);
  const reason = clip(strOf(o.reason) || strOf(o.error) || '未知原因', 300);
  const original = o.decision ?? o.order ?? raw;
  return {
    kind: 'rejected',
    title: clip(`${label}：${reason}`, 240),
    detail: clip(`原因：${reason}\n原始内容：${strOf(original)}`, 1200),
    commands: [],
    accepted: false,
    rejected: [reason],
  };
}

function dmDecision(ctx: BuildCtx, raw: unknown): DialogueDecision {
  const d = recOf(raw);
  const kind = strOf(d.kind) || 'dm';
  const label = DM_KIND_LABEL[kind] ?? kind;
  const summary = strOf(d.summary) || strOf(d.note);
  const bits: string[] = [];
  if (hasText(d.note) && strOf(d.note) !== summary) bits.push(strOf(d.note));
  const trade = recOf(d.trade);
  if (Object.keys(trade).length) {
    const a = strOf(trade.a);
    const b = strOf(trade.b);
    bits.push(`小贸易：${a ? `${a} ↔ ` : ''}${b || '?'} · 货物 ${strOf(trade.goods) || '—'} · 结果 ${strOf(trade.outcome) || '—'}`);
  }
  const story = recOf(d.story);
  if (Object.keys(story).length) {
    const effects = listOf(story.effects)
      .map((e) => {
        const ef = recOf(e);
        const t = strOf(ef.type);
        if (t === 'note') return `叙事：${clip(strOf(ef.text), 160)}`;
        if (t === 'sack') return `洗劫 ${strOf(ef.city) || '?'} (loss ${numOf(ef.loss, 1)})`;
        if (t === 'capacity') return `人口上限 ${numOf(ef.delta) >= 0 ? '+' : ''}${numOf(ef.delta)}%`;
        if (t === 'dev') return `发展加速 ${numOf(ef.years)} 年`;
        return clip(strOf(e), 120);
      })
      .filter(Boolean);
    bits.push(`故事「${strOf(story.title) || '无题'}」${hasText(story.text) ? `：${clip(story.text, 400)}` : ''}`);
    if (effects.length) bits.push(`效果：${effects.join('；')}`);
  }
  const commands = d.command ? commandsOf(ctx, [d.command]) : [];
  return {
    kind,
    title: clip(`${label}${summary ? `：${summary}` : '（无说明）'}`, 240),
    detail: clip(bits.join('\n'), 1200),
    commands,
    accepted: true,
  };
}

function jevDecision(ctx: BuildCtx, raw: unknown): DialogueDecision {
  const d = recOf(raw);
  const source = strOf(d.source) || 'jev';
  const modeId = strOf(d.modeId) || 'event';
  const polity = strOf(d.polityName) || (numOf(d.polityId, -1) >= 0 ? `P${numOf(d.polityId)}` : '某国');
  const optionLabel = strOf(d.optionLabel) || (strOf(d.option) ? `选项 ${strOf(d.option)}` : '无特别结果');
  const probs = recOf(d.probabilities);
  const probKeys = Object.keys(probs).slice(0, 8);
  const bits: string[] = [
    `事件 ${strOf(d.eventId) || '?'} · 模式 ${modeId} · 来源 ${source}`,
    probKeys.length
      ? `概率 ${probKeys.map((k) => `${k}=${fixed(numOf(probs[k]))}`).join(' ')} · 随机值 ${fixed(numOf(d.roll), 3)}`
      : `随机值 ${fixed(numOf(d.roll), 3)}`,
  ];
  if (hasText(d.effect)) bits.push(`效果：${strOf(d.effect)}`);
  if (hasText(d.note)) bits.push(`备注：${strOf(d.note)}`);
  if (hasText(d.error)) bits.push(`降级原因：${strOf(d.error)}`);
  const commands = d.command ? commandsOf(ctx, [d.command]) : [];
  const accepted = source !== 'engine-rule' && !hasText(d.error);
  const out: DialogueDecision = {
    kind: modeId,
    title: clip(`${polity}：${optionLabel}`, 240),
    detail: clip(bits.join('\n'), 1200),
    commands,
    accepted,
  };
  if (hasText(d.error) && source !== 'engine-rule') out.rejected = [clip(strOf(d.error), 300)];
  return out;
}

function monarchDecision(ctx: BuildCtx, raw: unknown): DialogueDecision {
  const d = recOf(raw);
  const name = strOf(d.name) || `P${numOf(d.polityId)}`;
  const source = strOf(d.source) || 'llm';
  const commands = commandsOf(ctx, d.commands);
  const rejected = listOf(d.rejected)
    .map((r) => {
      const rr = recOf(r);
      return clip(`${strOf(rr.outcome) || '退回'}：${strOf(rr.reason) || strOf(rr.order)}`, 220);
    })
    .filter(Boolean)
    .slice(0, MAX_NOTES);
  const audits = listOf(d.audits)
    .map((a) => {
      const aa = recOf(a);
      return clip(`${strOf(aa.kind) || '审核'}:${strOf(aa.outcome) || '?'}${hasText(aa.reason) ? `（${strOf(aa.reason)}）` : ''}`, 200);
    })
    .filter(Boolean)
    .slice(0, 6);
  const bits: string[] = [`来源 ${source}`];
  bits.push(hasText(d.reason) ? `理由：${clip(strOf(d.reason), 700)}` : '理由：（空）');
  if (hasText(d.error)) bits.push(`错误：${clip(strOf(d.error), 300)}`);
  if (audits.length) bits.push(`审核：${audits.join('；')}`);
  if (rejected.length) bits.push(`退回/降级：${rejected.join('；')}`);
  const out: DialogueDecision = {
    kind: source,
    title: clip(`${name} · ${commands.length} 条命令`, 240),
    detail: clip(bits.join('\n'), 1200),
    commands,
    accepted: !hasText(d.error) && source !== 'error',
  };
  if (rejected.length) out.rejected = rejected;
  return out;
}

/* ------------------------------------------------------------------ *
 * DM 回合
 * ------------------------------------------------------------------ */

function dmRoundOf(
  ctx: BuildCtx,
  r: Record<string, unknown>,
  embedded: boolean,
): DialogueRound {
  const s = ctx.s;
  const round = numOf(r.round);
  const fromYear = numOf(r.fromYear);
  const years = numOf(r.years, Math.max(0, numOf(r.toYear) - fromYear));
  const toYear = numOf(r.toYear, fromYear + years);
  const source = strOf(r.source) || 'dm';
  const decisions = listOf(r.decisions).map((d) => dmDecision(ctx, d));
  const rejected = listOf(r.rejected);
  for (const rej of rejected) decisions.push(rejectedDecision(rej, 'DM 决策拒收'));
  const notes = clipList(r.notes);
  const engineRejected = listOf(r.engineRejected);
  if (engineRejected.length) notes.push(`引擎退回 ${engineRejected.length} 条命令`);
  const error = clip(strOf(r.error), 500);

  let prompt: string;
  let reply: string;
  if (embedded) {
    prompt = clip(
      `【输入摘要】君主回合第 ${round} 回合（第 ${fromYear} → ${toYear} 年）内，在君主命令之外追加的一次 DM 小决策。` +
        `\n原始 DM 提示词未落盘（monarch-round 日志只保存 reason/decisions/notes），此处按回合记录生成摘要。`,
    );
    reply = clip(
      `【回复摘要】来源=${source} · 决定 ${decisions.length} 条 · 引擎命令 ${numOf(r.commands)} 条 · 拒收 ${numOf(r.rejected)} 条` +
        `${hasText(r.reason) ? `\n理由：${clip(strOf(r.reason), 700)}` : ''}`,
    );
  } else {
    const log = readDmLog(s, round, ctx);
    const ctxLine =
      `第 ${fromYear} → ${toYear} 年（${years} 年）` +
      (numOf(r.maxDecisions, 0) > 0 ? ` · 最多 ${numOf(r.maxDecisions)} 条小决策` : '') +
      `\n原始 DM 提示词未落盘（dm-round-*.json 只有 reason/decisions/notes），此处按回合上下文字段生成摘要；完整叙事见「回合日志」页签。`;
    prompt = log.prompt ? clip(`【原始提示词（dm-round 日志）】\n${log.prompt}`) : clip(`【输入摘要】${ctxLine}`);
    const bits: string[] = [`来源=${source}`];
    if (numOf(r.ms, 0) > 0) bits.push(`耗时 ${Math.round(numOf(r.ms))}ms`);
    bits.push(`决定 ${decisions.length} 条 · 引擎命令 ${countOf(r.commands)} 条`);
    if (rejected.length) bits.push(`拒收 ${rejected.length} 条`);
    const reason = clip(strOf(r.reason), 700);
    const summaries = listOf(r.decisions)
      .map((d) => clip(strOf(recOf(d).summary), 160))
      .filter(Boolean)
      .slice(0, 8);
    reply = log.reply
      ? clip(`【原始回复（dm-round 日志）】\n${log.reply}`)
      : clip(
          `【回复摘要】${bits.join(' · ')}${reason ? `\n理由：${reason}` : ''}${summaries.length ? `\n决定：${summaries.join('；')}` : ''}`,
        );
  }

  const status: DialogueStatus = error ? 'error' : rejected.length ? 'fallback' : 'ok';
  const out: DialogueRound = {
    id: `dm-${embedded ? 'm' : ''}${pad4(round)}`,
    kind: 'dm',
    round,
    fromYear,
    toYear,
    source,
    status,
    prompt,
    reply,
    decisions: decisions.slice(0, MAX_DECISIONS),
    notes,
  };
  if (error) out.error = error;
  return out;
}

function collectDmRounds(ctx: BuildCtx): DialogueRound[] {
  const out: DialogueRound[] = [];
  for (const raw of listOf(recOf(ctx.s.dm).rounds)) out.push(dmRoundOf(ctx, recOf(raw), false));
  for (const raw of listOf(recOf(ctx.s.monarch).rounds)) {
    const m = recOf(raw);
    const dm = recOf(m.dm);
    if (Object.keys(dm).length === 0) continue;
    ctx.embeddedDm += 1;
    out.push(dmRoundOf(ctx, { ...m, ...dm }, true));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Jev 回合
 * ------------------------------------------------------------------ */

function jevRoundOf(ctx: BuildCtx, r: Record<string, unknown>, embedded: boolean): DialogueRound {
  const s = ctx.s;
  const round = numOf(r.round);
  const fromYear = numOf(r.fromYear);
  const toYear = numOf(r.toYear, fromYear + numOf(r.years));
  const mock = r.mock === true || (embedded && strOf(r.source) === 'mock');
  const source = mock ? 'mock' : embedded ? strOf(r.source) || 'jev' : 'jev';
  const events = numOf(r.events);
  const fallback = numOf(r.fallbackCount ?? r.fallback);
  const decisions: DialogueDecision[] = listOf(r.decisions).map((d) => jevDecision(ctx, d));
  const notes: string[] = [];
  const error = clip(strOf(r.error), 500);

  let prompt: string;
  let reply: string;
  if (embedded) {
    const digest = strOf(r.digest);
    prompt = clip(
      `【输入摘要】君主回合第 ${round} 回合（第 ${fromYear} → ${toYear} 年）内结算的小事件。` +
        `\n逐条 Jev 输入没有单独落盘（monarch-round 日志只有汇总 digest），无法还原原始环境描述。`,
    );
    reply = clip(
      `【汇总摘要】来源=${source} · 事件 ${events} 个 · 决定 ${numOf(r.decisions, decisions.length)} 条 · 引擎命令 ${numOf(r.commands)} 条` +
        `${fallback ? ` · 降级 ${fallback} 条` : ''}${digest ? `\n${digest}` : ''}`,
    );
    if (digest) {
      decisions.push({
        kind: 'digest',
        title: '君主回合内的小事件结算（汇总）',
        detail: clip(digest, 1200),
        commands: [],
        accepted: true,
      });
    }
    notes.push('君主回合内嵌结算：只保存了汇总 digest，无逐条事件/选项/概率');
    ctx.embeddedJevDigestOnly += digest ? 1 : 0;
  } else {
    let context = strOf(r.context);
    if (!context) {
      // 内存里没有时再试日志；两边都没有就退化为摘要
      const log = readPettyLog(s, round, ctx);
      context = log.prompt || log.reply;
      if (!context) ctx.jevCtxMissing += 1;
    }
    prompt = context
      ? clip(`【Jev 输入 · 原始环境描述】\n${context}`)
      : clip(
          `【输入摘要】第 ${fromYear} → ${toYear} 年 · 小事件裁决。` +
            `\n原始环境描述没有落盘（内存与 petty-round 日志都没有 context），此处按回合记录生成摘要。`,
        );
    const bits: string[] = [`来源=${source}`, `事件 ${events} 个`, `裁决 ${decisions.length} 条`, `引擎命令 ${countOf(r.commands)} 条`];
    if (fallback) bits.push(`降级 ${fallback} 条`);
    const tokens = recOf(r.tokens);
    if (numOf(tokens.total, 0) > 0) bits.push(`tokens ${numOf(tokens.total)}`);
    const labels = listOf(r.decisions)
      .map((d) => {
        const dd = recOf(d);
        return clip(`${strOf(dd.polityName) || '某国'}：${strOf(dd.optionLabel) || strOf(dd.option) || '无特别结果'}`, 120);
      })
      .filter(Boolean)
      .slice(0, 10);
    reply = clip(`【回复摘要】${bits.join(' · ')}${labels.length ? `\n${labels.join('；')}` : ''}`);
    if (hasText(r.note)) notes.push(clip(strOf(r.note), 300));
    const queue = recOf(r.queue);
    if (numOf(queue.failures, 0) > 0) notes.push(`队列失败 ${numOf(queue.failures)} 次`);
  }
  const engineRejected = listOf(r.engineRejected);
  if (engineRejected.length) notes.push(`引擎退回 ${engineRejected.length} 条命令`);
  if (events > 0 && decisions.length === 0 && !embedded) notes.push(`扫描到 ${events} 个事件但没有裁决结果`);

  const status: DialogueStatus = error ? 'error' : fallback > 0 ? 'fallback' : 'ok';
  const out: DialogueRound = {
    id: `jev-${embedded ? 'm' : ''}${pad4(round)}`,
    kind: 'jev',
    round,
    fromYear,
    toYear,
    source,
    status,
    prompt,
    reply,
    decisions: decisions.slice(0, MAX_DECISIONS),
    notes,
  };
  if (error) out.error = error;
  return out;
}

function collectJevRounds(ctx: BuildCtx): DialogueRound[] {
  const out: DialogueRound[] = [];
  for (const raw of listOf(recOf(ctx.s.petty).rounds)) out.push(jevRoundOf(ctx, recOf(raw), false));
  for (const raw of listOf(recOf(ctx.s.monarch).rounds)) {
    const m = recOf(raw);
    const pt = recOf(m.petty);
    if (Object.keys(pt).length === 0) continue;
    ctx.embeddedJev += 1;
    out.push(jevRoundOf(ctx, { ...m, ...pt }, true));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Monarch 回合（可选）
 * ------------------------------------------------------------------ */

function monarchRoundOf(ctx: BuildCtx, r: Record<string, unknown>): DialogueRound {
  const s = ctx.s;
  const round = numOf(r.round);
  const fromYear = numOf(r.fromYear);
  const toYear = numOf(r.toYear, fromYear + numOf(r.years));
  const decisionsRaw = listOf(r.decisions);
  const decisions = decisionsRaw.map((d) => monarchDecision(ctx, d));
  const sourceSet = new Set<string>();
  for (const d of decisionsRaw) sourceSet.add(strOf(recOf(d).source) || 'llm');
  const source = sourceSet.size === 0 ? 'llm' : sourceSet.size === 1 ? [...sourceSet][0]! : 'mixed';

  const briefs = listOf(r.briefs);
  let prompt = '';
  if (briefs.length) {
    prompt = clip(
      briefs
        .map((b) => {
          const br = recOf(b);
          return `【${strOf(br.name) || '某国'}（P${numOf(br.polityId)}）】\n${strOf(br.text)}`;
        })
        .join('\n\n'),
    );
  } else {
    const fromLog = readMonarchBriefs(s, round, ctx);
    prompt = fromLog
      ? clip(`【君主简报（monarch-round 日志）】\n${fromLog}`)
      : clip(
          `【输入摘要】第 ${fromYear} → ${toYear} 年 · 君主回合。` +
            `\n简报正文（briefs）缺失（内存里没有，monarch-round 日志也读不到），只能按决策记录生成摘要。`,
        );
  }

  const reasons = decisionsRaw
    .map((d) => {
      const dd = recOf(d);
      const name = strOf(dd.name) || `P${numOf(dd.polityId)}`;
      return clip(`${name}：${strOf(dd.reason) || '（无理由）'}`, 220);
    })
    .filter(Boolean)
    .slice(0, 12);
  const totalCmds = decisions.reduce((n, d) => n + d.commands.length, 0);
  const totalRejected = decisions.reduce((n, d) => n + (d.rejected?.length ?? 0), 0);
  const reply = clip(
    `【回复摘要】来源=${source} · 国家 ${decisionsRaw.length} 个 · 引擎命令 ${totalCmds} 条` +
      `${totalRejected ? ` · 审核退回/降级 ${totalRejected} 条` : ''}${reasons.length ? `\n${reasons.join('\n')}` : ''}`,
  );

  const notes: string[] = [];
  const audits = listOf(r.audits);
  if (audits.length) notes.push(`审核 ${audits.length} 条`);
  const engineRejected = listOf(r.engineRejected);
  if (engineRejected.length) notes.push(`引擎退回 ${engineRejected.length} 条命令`);
  const petty = recOf(r.petty);
  if (Object.keys(petty).length) notes.push(`内嵌小事件：${strOf(petty.digest) || '（无汇总）'}`);
  const dm = recOf(r.dm);
  if (Object.keys(dm).length) notes.push(`内嵌 DM：${clip(strOf(dm.reason) || '（无理由）', 220)}`);
  const intel = recOf(r.intel);
  if (listOf(intel.resolutions).length) notes.push(`渗透判定 ${listOf(intel.resolutions).length} 条`);

  const errDecision = decisionsRaw.find((d) => hasText(recOf(d).error) || strOf(recOf(d).source) === 'error');
  const error = errDecision ? clip(strOf(recOf(errDecision).error) || '国家决策出错', 500) : '';
  const status: DialogueStatus = error ? 'error' : totalRejected > 0 ? 'fallback' : 'ok';

  const out: DialogueRound = {
    id: `mon-${pad4(round)}`,
    kind: 'monarch',
    round,
    fromYear,
    toYear,
    source,
    status,
    prompt,
    reply,
    decisions: decisions.slice(0, MAX_DECISIONS),
    notes: notes.slice(0, MAX_NOTES),
  };
  if (error) out.error = error;
  return out;
}

function collectMonarchRounds(ctx: BuildCtx): DialogueRound[] {
  return listOf(recOf(ctx.s.monarch).rounds).map((raw) => monarchRoundOf(ctx, recOf(raw)));
}

/* ------------------------------------------------------------------ *
 * 排序 / 限流 / 体积控制
 * ------------------------------------------------------------------ */

const KIND_ORDER: Record<DialogueKind, number> = { dm: 0, jev: 1, monarch: 2 };

function compareRounds(a: DialogueRound, b: DialogueRound): number {
  return (
    a.fromYear - b.fromYear ||
    a.round - b.round ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    a.id.localeCompare(b.id)
  );
}

function applyTextCap(rounds: DialogueRound[], cap: number): void {
  const c = Math.max(64, Math.floor(cap));
  const dTitle = Math.max(120, Math.min(240, c));
  const dDetail = Math.max(240, Math.min(1200, Math.round(c * 1.2)));
  for (const r of rounds) {
    r.prompt = clip(r.prompt, c);
    r.reply = clip(r.reply, c);
    if (r.error) r.error = clip(r.error, Math.min(500, c));
    r.notes = r.notes.slice(0, MAX_NOTES).map((n) => clip(n, Math.min(240, c)));
    for (const d of r.decisions) {
      d.title = clip(d.title, dTitle);
      d.detail = clip(d.detail, dDetail);
      d.commands = d.commands.map((cmd) => ({ kind: cmd.kind, text: clip(cmd.text, Math.min(240, c)) }));
      if (d.rejected) d.rejected = d.rejected.map((x) => clip(x, Math.min(300, c)));
    }
  }
}

function jsonBytes(data: DialogueViewData): number {
  return Buffer.byteLength(JSON.stringify(data), 'utf8');
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

export function dialogueView(s: Session, opts?: DialogueViewOptions): DialogueViewData {
  const warnings: string[] = [];
  const ctx: BuildCtx = {
    s,
    names: buildNameMap(s),
    dmLogMissing: 0,
    dmLogNoRaw: 0,
    dmLogRaw: 0,
    jevCtxMissing: 0,
    jevLogMissing: 0,
    monarchBriefsMissing: 0,
    embeddedDm: 0,
    embeddedJev: 0,
    embeddedJevDigestOnly: 0,
  };

  const dmRounds = collectDmRounds(ctx);
  const jevRounds = collectJevRounds(ctx);
  const total = { dm: dmRounds.length, jev: jevRounds.length };
  const all = [...dmRounds, ...jevRounds];

  let kind = opts?.kind;
  if (kind !== undefined && kind !== 'dm' && kind !== 'jev' && kind !== 'monarch') {
    warnings.push(`未知的 kind=${strOf(kind)}，已按默认的 dm + jev 返回`);
    kind = undefined;
  }
  if (kind === 'monarch') all.push(...collectMonarchRounds(ctx));

  const limitRaw = numOf(opts?.limit, DEFAULT_LIMIT);
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.round(limitRaw || DEFAULT_LIMIT)));
  const want: DialogueKind[] = kind === undefined ? ['dm', 'jev'] : [kind];
  const picked: DialogueRound[] = [];
  let truncated = false;
  for (const k of want) {
    const list = all.filter((r) => r.kind === k).sort(compareRounds);
    const tail = list.slice(Math.max(0, list.length - limit));
    if (tail.length < list.length) truncated = true;
    picked.push(...tail);
  }
  picked.sort(compareRounds);

  // ---- warnings：先讲清哪些字段是摘要 ----
  const hasDm = picked.some((r) => r.kind === 'dm');
  const hasJev = picked.some((r) => r.kind === 'jev');
  if (hasDm) {
    warnings.push(
      'DM 的原始提示词与模型原始回复没有落盘（内存与 dm-round-*.json 都只保存 reason/decisions/notes），prompt/reply 是按回合记录生成的摘要，不是原始对话。',
    );
    if (ctx.dmLogMissing > 0) {
      warnings.push(`${ctx.dmLogMissing} 个 DM 回合日志（dm-round-*.json）缺失或不可读，已退化为内存记录摘要。`);
    }
    if (ctx.dmLogRaw > 0) warnings.push(`${ctx.dmLogRaw} 个 DM 回合从日志里补到了原始 prompt/reply。`);
  }
  if (hasJev) {
    warnings.push('Jev 的模型原始回答只转成概率与选项、不落盘，reply 是按裁决结果（decisions/降级）合成的摘要。');
    const ownJev = picked.filter((r) => r.kind === 'jev' && r.id.startsWith('jev-'));
    if (ownJev.length && ctx.jevCtxMissing > 0) {
      warnings.push(`${ctx.jevCtxMissing} 个 Jev 回合的原始环境描述（context）缺失，prompt 已退化为摘要。`);
    }
    if (ctx.embeddedJevDigestOnly > 0) {
      warnings.push(
        `${ctx.embeddedJevDigestOnly} 个君主回合内嵌的 Jev 结算只保存了汇总 digest，无法还原逐条事件/选项/概率。`,
      );
    }
  }
  if (kind === 'monarch') {
    if (all.every((r) => r.kind !== 'monarch')) warnings.push('本会话还没有君主回合。');
    if (ctx.monarchBriefsMissing > 0) {
      warnings.push(`${ctx.monarchBriefsMissing} 个君主回合的简报（briefs）缺失，prompt 已退化为摘要。`);
    }
  }
  if (truncated) {
    warnings.push(
      `每类只返回最近 ${limit} 回合（完整总数：DM ${total.dm} / Jev ${total.jev}）；total 字段仍为完整计数。`,
    );
  }

  const data: DialogueViewData = { rounds: picked, total, warnings: [] };
  // ---- 体积控制：先按上限缩文本，再丢最早的回合 ----
  let capUsed = MAX_TEXT;
  for (const cap of TEXT_CAPS) {
    capUsed = cap;
    applyTextCap(picked, cap);
    if (jsonBytes(data) <= SOFT_BUDGET) break;
  }
  data.warnings = warnings.slice(0, MAX_WARNINGS).map((w) => clip(w, 400));
  if (jsonBytes(data) > SOFT_BUDGET) {
    let dropped = 0;
    const floor = Math.max(1, want.length);
    while (picked.length > floor && jsonBytes(data) > SOFT_BUDGET) {
      const drop = Math.max(1, Math.min(picked.length - floor, Math.ceil(picked.length * 0.05)));
      picked.splice(0, drop);
      dropped += drop;
    }
    if (dropped > 0) {
      warnings.push(`返回体积超过约 280KB，已省略最早的 ${dropped} 回合（total 仍为完整计数）。`);
      data.warnings = warnings.slice(0, MAX_WARNINGS).map((w) => clip(w, 400));
    }
  }
  if (capUsed < MAX_TEXT && picked.length > 0) {
    warnings.push(`为控制返回体积，文本已从 ${MAX_TEXT} 字压到 ${capUsed} 字。`);
    data.warnings = warnings.slice(0, MAX_WARNINGS).map((w) => clip(w, 400));
  }
  return { rounds: picked, total, warnings: data.warnings };
}
