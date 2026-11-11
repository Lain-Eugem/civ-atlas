/**
 * 外部 LLM 调用(DeepSeek / 阿里云百炼 / 任意 OpenAI 兼容服务)。
 *
 * 和网页版的 src/ai 分开:这里跑在 Node(MCP 进程)里,不依赖浏览器。
 * API Key 只从调用参数或环境变量读,不写日志、不进导出文件。
 */
import type { MonarchBrief } from '../src/gen/civ/monarch';

export type LlmProviderName = 'deepseek' | 'bailian' | 'custom';

export interface LlmProviderSettings {
  provider: LlmProviderName;
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature: number;
  timeoutMs: number;
}

export interface LlmProviderInput {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  timeoutMs?: number;
}

const DEFAULTS: Record<Exclude<LlmProviderName, 'custom'>, { baseUrl: string; model: string; env: string }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', env: 'DEEPSEEK_API_KEY' },
  bailian: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    env: 'DASHSCOPE_API_KEY',
  },
};

/** 把工具参数/环境变量整理成一套服务商设置;不合法抛 Error(会被 MCP 转成 isError) */
export function providerSettings(input: LlmProviderInput = {}): LlmProviderSettings {
  const asked = (input.provider ?? 'deepseek').toLowerCase();
  const provider: LlmProviderName = asked === 'bailian' || asked === 'custom' || asked === 'deepseek' ? asked : 'deepseek';
  const preset = provider === 'custom' ? undefined : DEFAULTS[provider];
  const envKey = preset ? process.env[preset.env] : undefined;
  const baseUrl = (input.baseUrl ?? preset?.baseUrl ?? '').replace(/\/+$/, '');
  const model = input.model ?? preset?.model ?? '';
  if (!baseUrl) throw new Error('缺少 baseUrl(provider=custom 时必须给)');
  if (!model) throw new Error('缺少 model(provider=custom 时必须给)');
  const temperature = clampNum(input.temperature ?? 0.7, 0, 2, 'temperature');
  const timeoutMs = clampNum(input.timeoutMs ?? 120_000, 5_000, 600_000, 'timeoutMs');
  const apiKey = input.apiKey ?? envKey;
  const out: LlmProviderSettings = { provider, baseUrl, model, temperature, timeoutMs };
  if (apiKey) out.apiKey = apiKey;
  return out;
}

/** 给用户看的服务商信息(不含 Key) */
export function providerView(s: LlmProviderSettings): Record<string, unknown> {
  return { provider: s.provider, baseUrl: s.baseUrl, model: s.model, temperature: s.temperature, timeoutMs: s.timeoutMs, hasApiKey: !!s.apiKey };
}

export interface LlmMessage {
  role: 'system' | 'user';
  content: string;
}

export interface LlmReply {
  text: string;
  model: string;
  ms: number;
  /** 服务商回的用量(有就给):提示词 tokens 与前缀缓存命中数,用来验证分层是否有效 */
  promptTokens?: number;
  cachedTokens?: number;
}

/** 调一次 OpenAI 兼容的 /chat/completions;失败抛出带 HTTP 状态和正文的错误 */
export async function askLlm(messages: readonly LlmMessage[], s: LlmProviderSettings): Promise<LlmReply> {
  if (!s.apiKey && s.provider !== 'custom') {
    throw new Error(`没有 API Key:传 apiKey 或设置环境变量 ${s.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'DASHSCOPE_API_KEY'};也可以先用 mock:true 离线跑`);
  }
  const started = Date.now();
  const url = `${s.baseUrl}/chat/completions`;
  const base: Record<string, unknown> = { model: s.model, messages, temperature: s.temperature, max_tokens: 1200 };
  const body = JSON.stringify({ ...base, response_format: { type: 'json_object' } });
  let res = await fetchJson(url, body, s);
  if (res.status === 400) {
    // 有些服务商不支持 response_format,去掉再试一次
    res = await fetchJson(url, JSON.stringify(base), s);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM 请求失败 HTTP ${res.status}: ${text.slice(0, 500)}`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`LLM 返回的不是 JSON: ${text.slice(0, 300)}`);
  }
  const choice = (data as { choices?: { message?: { content?: unknown } }[] }).choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string') throw new Error('LLM 返回里没有 choices[0].message.content');
  const usage = (data as { usage?: { prompt_tokens?: unknown; prompt_cache_hit_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } } }).usage;
  const promptTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : undefined;
  const cachedTokens =
    typeof usage?.prompt_cache_hit_tokens === 'number'
      ? usage.prompt_cache_hit_tokens
      : typeof usage?.prompt_tokens_details?.cached_tokens === 'number'
        ? usage.prompt_tokens_details.cached_tokens
        : undefined;
  return {
    text: content,
    model: s.model,
    ms: Date.now() - started,
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
  };
}

async function fetchJson(url: string, body: string, s: LlmProviderSettings): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (s.apiKey) headers.Authorization = `Bearer ${s.apiKey}`;
  return fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(s.timeoutMs) });
}

export interface ParsedDecision {
  reason: string;
  commands: unknown[];
  /** 君主自主写入的记忆(清洗在 src/gen/civ/monarchMemory.ts) */
  remember?: unknown[];
}

/** 从 LLM 的文本里抠出 {"reason":...,"commands":[...]};允许 ```json 代码块和前后废话 */
export function parseDecision(text: string): ParsedDecision {
  const raw = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced ? fenced[1]!.trim() : raw;
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('LLM 输出里找不到 JSON 对象');
  let obj: unknown;
  try {
    obj = JSON.parse(candidate.slice(first, last + 1));
  } catch (e) {
    throw new Error(`LLM 输出的 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  const o = obj as { reason?: unknown; commands?: unknown; remember?: unknown };
  return {
    reason: typeof o.reason === 'string' ? o.reason : '',
    commands: Array.isArray(o.commands) ? o.commands : [],
    ...(Array.isArray(o.remember) ? { remember: o.remember } : {}),
  };
}

/**
 * 不联网的 mock 君主:确定性(同一简报/回合 → 同一决定),用来做离线自检/对账。
 * 决策只用简报里的公开字段(君主倾向、邻国、战争),不读隐藏状态。
 */
export function mockDecision(brief: MonarchBrief, turn: number): ParsedDecision {
  const l = brief.ruler?.leanings ?? {};
  const war = l.war ?? 50;
  const expand = l.expand ?? 50;
  const develop = l.develop ?? 50;
  const trade = l.trade ?? 50;
  const n = brief.neighbors;

  if (brief.wars.length > 0 && turn % 2 === 0) {
    return { reason: `${brief.name} 打累了,先把国策转成求和`, commands: [{ kind: 'policy', preset: 'peace' }] };
  }
  if (n.length === 0) {
    if (develop >= 55 && turn % 3 === 0) return { reason: `${brief.name} 没有邻国,先埋头发展`, commands: [{ kind: 'boost', mul: 3 }] };
    return { reason: `${brief.name} 没有邻国,今年休息`, commands: [] };
  }
  if (turn % 7 === 4) {
    return { reason: `${brief.name} 今年休整,不折腾`, commands: [] };
  }
  if ((war >= 60 || expand >= 60) && turn % 4 === 2) {
    const target = [...n].sort((a, b) => a.size - b.size || a.id - b.id)[0]!;
    return { reason: `${brief.name} 挑最弱的邻国 P${target.id} 动手`, commands: [{ kind: 'declare', b: target.id }] };
  }
  if (trade >= 40 && turn % 6 === 1) {
    const target = [...n].sort((a, b) => b.size - a.size || a.id - b.id)[0]!;
    return { reason: `${brief.name} 和最大的邻国 P${target.id} 结好`, commands: [{ kind: 'ally', b: target.id }] };
  }
  if (develop >= 55 && turn % 3 === 0) {
    return { reason: `${brief.name} 今年推发展`, commands: [{ kind: 'boost', mul: 3 }] };
  }
  if (trade >= Math.max(war, expand, develop)) {
    return { reason: `${brief.name} 走商贸`, commands: [{ kind: 'policy', preset: 'trade' }] };
  }
  if (expand >= Math.max(war, develop)) {
    return { reason: `${brief.name} 继续扩张`, commands: [{ kind: 'policy', preset: 'expand' }] };
  }
  return { reason: `${brief.name} 守成`, commands: [{ kind: 'policy', preset: 'hold' }] };
}

function clampNum(v: number, min: number, max: number, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} 必须是数字`);
  return Math.min(max, Math.max(min, v));
}
