/**
 * 让 AI 做一年一次的决定。
 * 两条路:① 真调 OpenAI 兼容接口(DeepSeek / 阿里云百炼 / 本地 Ollama 等);② --mock:不用 Key,按君主性格给一条能跑通的决策。
 * 只输出 {reason, commands};命令怎么变成引擎的干预由 run.ts 的 buildCommands 负责。
 */
import type { Briefing } from './briefing';

export interface Decision {
  reason: string;
  commands: unknown[];
}

export interface LlmSettings {
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  temperature: number;
}

const SYSTEM = [
  '你是一个历史模拟游戏里的统治者,正在一年一年地治理自己的国家。',
  '你只能通过游戏提供的命令行动,不能编造命令,不能直接改写地形或历史。',
  '你只输出一个 JSON 对象:{"reason":"一句话说明今年为什么这么做","commands":[...]}。',
  '命令里的国家用 P 编号(如 6)。不确定的命令不要下。',
].join('\n');

/** 真调接口;失败时把 HTTP 状态和正文一起抛出来,方便看是哪一步的问题 */
export async function askLlm(briefing: string, s: LlmSettings): Promise<{ text: string; usage?: unknown }> {
  const url = `${s.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = (useJsonMode: boolean) => ({
    model: s.model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: briefing },
    ],
    temperature: s.temperature,
    max_tokens: 1200,
    ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
  });
  const once = async (useJsonMode: boolean): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify(body(useJsonMode)),
      signal: AbortSignal.timeout(180_000),
    });
  let res = await once(true);
  // 有的 OpenAI 兼容服务不支持 response_format,400 时去掉再试一次
  if (!res.ok && res.status === 400) res = await once(false);
  const text = await res.text();
  if (!res.ok) throw new Error(`调用 ${s.label}失败:HTTP ${res.status}\n${text.slice(0, 800)}`);
  let json: { choices?: { message?: { content?: string } }[]; usage?: unknown };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new Error(`接口返回的不是 JSON:${text.slice(0, 500)}`);
  }
  const out = json.choices?.[0]?.message?.content ?? '';
  if (!out.trim()) throw new Error(`接口返回了空内容:${text.slice(0, 500)}`);
  return { text: out, usage: json.usage };
}

/** 从模型回复里取出 {reason, commands};容忍 ```json 代码块和前后废话 */
export function parseDecision(text: string): Decision {
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`回复里找不到 JSON:${text.slice(0, 400)}`);
  let obj: unknown;
  try {
    obj = JSON.parse(s.slice(start, end + 1));
  } catch (err) {
    throw new Error(`回复的 JSON 解析失败(${(err as Error).message}):${s.slice(start, end + 1).slice(0, 400)}`);
  }
  if (!obj || typeof obj !== 'object') throw new Error('回复不是 JSON 对象');
  const o = obj as Record<string, unknown>;
  const reason = typeof o.reason === 'string' ? o.reason : '(没说理由)';
  const commands = Array.isArray(o.commands) ? o.commands : [];
  if (o.commands !== undefined && !Array.isArray(o.commands)) throw new Error('commands 不是数组');
  return { reason, commands };
}

/** mock 模式的输入:够按性格做出一个说得通的决定了 */
export interface MockContext {
  briefing: Briefing;
  ruler: { name: string; leanings?: { expand?: number; war?: number; develop?: number; trade?: number } } | null;
  neighbors: { id: number; name: string; size: number }[];
  wars: number;
  turn: number;
}

/**
 * 不用 Key 的假 AI:按君主性格 + 回合数挑一条像样的命令。
 * 完全确定(同一份局势永远给同一个决定,便于复现),但会轮换手段,不会每年重复同一句。
 */
export function mockDecision(ctx: MockContext): Decision {
  const { briefing, ruler, neighbors, wars, turn } = ctx;
  const l = ruler?.leanings ?? {};
  const expand = l.expand ?? 40;
  const war = l.war ?? 40;
  const develop = l.develop ?? 40;
  const trade = l.trade ?? 40;
  const Y = briefing.year;

  if (!briefing.alive) return { reason: '国家已经不存在了', commands: [] };

  // 在打仗:先求和稳一稳
  if (wars > 0) {
    return { reason: '战事不利,先定和谈的方针', commands: [{ kind: 'policy', preset: 'peace' }] };
  }

  // 扩张/好战倾向高，且接壤：每 8 个回合挑最弱的邻国动手
  if ((expand >= 60 || war >= 60) && neighbors.length > 0 && turn % 8 === 0) {
    const target = [...neighbors].sort((a, b) => a.size - b.size || a.id - b.id)[0];
    return {
      reason: `君主${expand >= 60 ? `重扩张(${expand})` : `好战(${war})`},向最弱的邻国 P${target.id} ${target.name} 动手`,
      commands: [{ kind: 'declare', b: target.id }, { kind: 'policy', preset: 'expand' }],
    };
  }

  // 重商且接壤：每 6 个回合拉一个最强的邻国结盟
  if (trade >= 40 && neighbors.length > 0 && turn % 6 === 2) {
    const partner = [...neighbors].sort((a, b) => b.size - a.size || a.id - b.id)[0];
    return {
      reason: `君主重商(${trade}),与最强的邻国 P${partner.id} ${partner.name} 结盟通商`,
      commands: [{ kind: 'ally', b: partner.id }],
    };
  }

  // 发展型:每三年推一把建设
  if (develop >= 55 && turn % 3 === 0) {
    return {
      reason: `君主重发展(${develop}),推一把建设,先守成`,
      commands: [{ kind: 'boost', mul: 3, until: Math.min(65535, Y + 50) }, { kind: 'policy', preset: 'hold' }],
    };
  }

  // 偶尔休整一年:给日志留出「什么也不做」的对照
  if (turn % 7 === 4) return { reason: '今年国中无事,休养生息', commands: [] };

  // 平时:在三条说得通的方针之间轮换,每年都重新判断一次
  const ranked = [
    { preset: 'trade', score: trade, word: '重商' },
    { preset: 'expand', score: expand, word: '重扩张' },
    { preset: 'hold', score: develop, word: '重守成' },
  ].sort((a, b) => b.score - a.score || a.preset.localeCompare(b.preset));
  const pick = ranked[turn % 3] ?? ranked[0];
  return {
    reason: `君主${pick.word}(倾向 ${pick.score}),今年按「${pick.preset}」走`,
    commands: [{ kind: 'policy', preset: pick.preset }],
  };
}
