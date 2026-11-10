/**
 * 小事件裁决层（Petty Event Resolver）· 官方 Jev 1.14.0 决策客户端。
 *
 * 官方文档（2026-11-10）：
 *   POST https://api.defapi.org/api/v1/decisions
 *   Authorization: Bearer <API Key>
 *   body { model, state, questions, session_id? }
 *   answers[q] = { type, noul?, choice?, score?, probabilities?, legend?, confidence? }
 *   usage = { input_tokens, output_tokens, cost? }, 另有 task_id、consumed、model。
 *
 * 这里只负责“把问题发出去、把概率收回严格校验”，不负责抽样（抽样在引擎层用统一随机流做，
 * 见 src/gen/civ/petty.ts），也不负责队列（见 petty-queue.ts）。
 * Key 只从参数或环境变量读，不写日志、不进导出文件。
 *
 * 注意：官方请求 schema 没有 temperature / top_p，客户端不能设置；复现性靠“结果落盘 + 引擎抽样”，
 * 不依赖模型逐位可复现（日志里记 model / task_id / usage 以便追溯）。
 */

export type JevQuestionType = 'noul' | 'choice' | 'score';

export interface JevNoulQuestion {
  type: 'noul';
  instructions: string;
  /** 可选：true/false 两级分别怎么算 */
  criteria?: { true?: string; false?: string };
}

export interface JevChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** 必填：选项 key → 说明。key 会原样回显 */
  criteria: Record<string, string>;
}

export interface JevScoreQuestion {
  type: 'score';
  instructions: string;
  /** 必填：2–10 条有序档位说明 */
  criteria: string[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;
export type JevQuestions = Record<string, JevQuestion>;

/** 官方 state：纯文本，或对象/数组形式的上下文 */
export type JevState = string | Record<string, unknown> | unknown[];

export interface JevAnswer {
  type: JevQuestionType;
  /** noul：答案为“真”的概率 0..1 */
  noul?: number;
  /** choice：选中的选项 key */
  choice?: string;
  /** score：按档位加权的期望分 */
  score?: number;
  /** choice/score：各选项/档位上的概率 */
  probabilities?: Record<string, number>;
  /** score：档位编号 → 说明 */
  legend?: Record<string, string>;
  /** choice/score：模型自报置信度 */
  confidence?: number;
}

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface JevReply {
  /** 上游评估编号（有的响应没有） */
  id?: string;
  model: string;
  provider?: string;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
  /** 支持/排查用编号 */
  taskId?: string;
  /** 实际计费金额（字符串，官方原样返回） */
  consumed?: string;
  /** 本地计时 */
  ms: number;
}

export type JevErrorKind = 'config' | 'auth' | 'request' | 'network' | 'timeout' | 'response' | 'server';

export class JevError extends Error {
  readonly kind: JevErrorKind;
  readonly status?: number;
  /** 官方错误体里的 code（有的 400/500 才有） */
  readonly code?: number;
  readonly detail?: string;

  constructor(kind: JevErrorKind, message: string, extra: { status?: number; code?: number; detail?: string } = {}) {
    super(message);
    this.name = 'JevError';
    this.kind = kind;
    this.status = extra.status;
    this.code = extra.code;
    this.detail = extra.detail;
  }
}

const DEFAULT_BASE_URL = 'https://api.defapi.org';
const DEFAULT_MODEL = 'typesafe/jev-1.14.0';
const DEFAULT_TIMEOUT_MS = 120_000;

export interface JevSettings {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

export interface JevSettingsInput {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
}

function clampNum(v: unknown, lo: number, hi: number, name: string): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new JevError('config', `${name} 必须是数字`);
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * 整理 Jev 配置：参数优先，其次环境变量，最后默认值。
 * Key 读 JEV_API_KEY（兼容 DEFAPI_API_KEY）；缺 Key 抛 config 错误。
 */
export function jevSettings(input: JevSettingsInput = {}): JevSettings {
  const baseUrl = (input.baseUrl ?? env('JEV_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (!baseUrl) throw new JevError('config', '缺少 baseUrl');
  if (!/^https?:\/\//.test(baseUrl)) throw new JevError('config', 'baseUrl 必须以 http:// 或 https:// 开头');
  const model = (input.model ?? env('JEV_MODEL') ?? DEFAULT_MODEL).trim();
  if (!model) throw new JevError('config', '缺少 model（官方默认 typesafe/jev-1.14.0）');
  const timeoutMs = clampNum(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100, 600_000, 'timeoutMs');
  const apiKey = input.apiKey ?? env('JEV_API_KEY') ?? env('DEFAPI_API_KEY');
  if (!apiKey) throw new JevError('config', '没有 API Key：传 apiKey，或设置环境变量 JEV_API_KEY（defapi.org 的 Key）');
  return { baseUrl, model, apiKey, timeoutMs };
}

/** 给用户/日志看的配置（不含 Key） */
export function jevSettingsView(s: JevSettings): Record<string, unknown> {
  return { baseUrl: s.baseUrl, model: s.model, timeoutMs: s.timeoutMs, hasApiKey: !!s.apiKey };
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function checkQuestion(key: string, q: JevQuestion): void {
  const where = `问题 ${key}`;
  if (!q || typeof q !== 'object') throw new JevError('request', `${where} 不是对象`);
  if (typeof q.instructions !== 'string' || !q.instructions.trim()) throw new JevError('request', `${where} 缺 instructions`);
  if (q.type === 'choice') {
    const criteria = asRecord((q as JevChoiceQuestion).criteria);
    if (!criteria || !Object.keys(criteria).length) throw new JevError('request', `${where}（choice）必须给 criteria 选项表`);
    for (const [k, v] of Object.entries(criteria)) {
      if (!k || typeof v !== 'string' || !v.trim()) throw new JevError('request', `${where} 的选项 ${k} 说明为空`);
    }
  } else if (q.type === 'score') {
    const criteria = (q as JevScoreQuestion).criteria;
    if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10) {
      throw new JevError('request', `${where}（score）criteria 必须是 2–10 条有序档位`);
    }
    if (criteria.some((c) => typeof c !== 'string' || !c.trim())) throw new JevError('request', `${where} 的档位说明为空`);
  } else if (q.type === 'noul') {
    const raw = (q as JevNoulQuestion).criteria;
    const criteria = asRecord(raw);
    // 官方 API 实测：noul 的 criteria 如果给，必须是 { true, false } 对象，字符串会 400。
    if (raw !== undefined && !criteria) {
      throw new JevError('request', `${where}（noul）的 criteria 如果给，必须是 { true, false } 对象；官方 API 不接受字符串`);
    }
    if (criteria && criteria.true !== undefined && typeof criteria.true !== 'string') throw new JevError('request', `${where} 的 criteria.true 必须是字符串`);
    if (criteria && criteria.false !== undefined && typeof criteria.false !== 'string') throw new JevError('request', `${where} 的 criteria.false 必须是字符串`);
  } else {
    throw new JevError('request', `${where} 的 type 只能是 noul / choice / score`);
  }
}

/** 校验 questions 并把错误提前暴露（不发请求） */
export function checkQuestions(questions: JevQuestions): void {
  const keys = Object.keys(questions);
  if (!keys.length) throw new JevError('request', '至少要有一个问题');
  if (keys.length > 64) throw new JevError('request', '一个问题批次最多 64 个问题');
  for (const key of keys) {
    if (!key || key.length > 120) throw new JevError('request', '问题 key 不能为空且不超过 120 字符');
    checkQuestion(key, questions[key]);
  }
}

/** 把响应里的 answers 收敛成严格形状；形状不对抛 response 错误（避免把垃圾概率带进引擎） */
function readAnswers(v: unknown, asked: JevQuestions): Record<string, JevAnswer> {
  const raw = asRecord(v);
  if (!raw) throw new JevError('response', '响应缺 answers 对象');
  const out: Record<string, JevAnswer> = {};
  for (const key of Object.keys(asked)) {
    const a = asRecord(raw[key]);
    if (!a) throw new JevError('response', `响应缺问题 ${key} 的答案`);
    const type = asked[key].type;
    if (a.type !== type) throw new JevError('response', `问题 ${key} 的答案类型 ${String(a.type)} 与问题类型 ${type} 不一致`);
    const ans: JevAnswer = { type };
    if (type === 'noul') {
      const p = asNumber(a.noul);
      if (p === undefined || p < 0 || p > 1) throw new JevError('response', `问题 ${key} 的 noul 概率不在 0..1`);
      ans.noul = p;
    } else if (type === 'choice') {
      const choice = typeof a.choice === 'string' ? a.choice : undefined;
      if (!choice) throw new JevError('response', `问题 ${key}（choice）缺 choice`);
      ans.choice = choice;
      const probs = asRecord(a.probabilities);
      if (probs) {
        const dist: Record<string, number> = {};
        for (const [k, vv] of Object.entries(probs)) {
          const n = asNumber(vv);
          if (n === undefined) throw new JevError('response', `问题 ${key} 的概率 ${k} 不是数字`);
          dist[k] = n;
        }
        ans.probabilities = dist;
      }
      const conf = asNumber(a.confidence);
      if (conf !== undefined) ans.confidence = conf;
    } else {
      const probs = asRecord(a.probabilities);
      if (!probs) throw new JevError('response', `问题 ${key}（score）缺 probabilities`);
      const dist: Record<string, number> = {};
      for (const [k, vv] of Object.entries(probs)) {
        const n = asNumber(vv);
        if (n === undefined) throw new JevError('response', `问题 ${key} 的概率 ${k} 不是数字`);
        dist[k] = n;
      }
      ans.probabilities = dist;
      const score = asNumber(a.score);
      if (score !== undefined) ans.score = score;
      const legend = asRecord(a.legend);
      if (legend) {
        const lg: Record<string, string> = {};
        for (const [k, vv] of Object.entries(legend)) lg[k] = String(vv);
        ans.legend = lg;
      }
      const conf = asNumber(a.confidence);
      if (conf !== undefined) ans.confidence = conf;
    }
    out[key] = ans;
  }
  return out;
}

function readUsage(v: unknown): JevUsage {
  const u = asRecord(v);
  if (!u) throw new JevError('response', '响应缺 usage');
  const input = asNumber(u.input_tokens);
  const output = asNumber(u.output_tokens);
  if (input === undefined || output === undefined) throw new JevError('response', 'usage 缺 input_tokens / output_tokens');
  const cost = asNumber(u.cost);
  return { inputTokens: input, outputTokens: output, cost: cost ?? 0 };
}

/**
 * 发一次决策请求。失败一律抛 JevError，调用方按 kind 决定重试/降级/熔断。
 * sessionId 会作为官方 session_id 透传（我们用“回合批次号”便于排查）。
 */
export async function askJev(
  questions: JevQuestions,
  state: JevState,
  s: JevSettings,
  opts: { sessionId?: string; signal?: AbortSignal } = {},
): Promise<JevReply> {
  checkQuestions(questions);
  if (!s.apiKey) throw new JevError('config', '没有 API Key');
  const started = Date.now();
  const url = `${s.baseUrl}/api/v1/decisions`;
  const body: Record<string, unknown> = { model: s.model, state, questions };
  if (opts.sessionId) body.session_id = opts.sessionId.slice(0, 256);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), s.timeoutMs);
  const onAbort = () => ctrl.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (ctrl.signal.aborted) throw new JevError('timeout', `Jev 请求超时（${s.timeoutMs}ms）`);
    throw new JevError('network', `Jev 请求失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }

  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 500);
    let code: number | undefined;
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { code?: unknown; message?: unknown; detail?: unknown };
      if (typeof parsed.code === 'number') code = parsed.code;
      if (typeof parsed.message === 'string' && parsed.message) message = parsed.message;
      if (typeof parsed.detail === 'string') detail = parsed.detail;
    } catch {
      /* 正文不是 JSON，保留原文 */
    }
    const kind: JevErrorKind = res.status === 401 ? 'auth' : res.status === 400 ? 'request' : res.status >= 500 ? 'server' : 'request';
    const hint =
      kind === 'auth'
        ? 'API Key 无效或未带上 Authorization: Bearer'
        : kind === 'request'
          ? '请求格式/模型不对（model 应为 typesafe/jev-1.14.0）'
          : '官方服务端错误，可稍后重试或降级';
    throw new JevError(kind, `Jev HTTP ${res.status}：${message}（${hint}）`, { status: res.status, code, detail });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JevError('response', `Jev 响应不是 JSON：${text.slice(0, 200)}`);
  }
  const root = asRecord(parsed);
  if (!root) throw new JevError('response', 'Jev 响应不是对象');
  const answers = readAnswers(root.answers, questions);
  const usage = readUsage(root.usage);
  const model = typeof root.model === 'string' ? root.model : s.model;
  const reply: JevReply = {
    model,
    answers,
    usage,
    ms: Date.now() - started,
  };
  if (typeof root.id === 'string') reply.id = root.id;
  if (typeof root.provider === 'string') reply.provider = root.provider;
  if (typeof root.task_id === 'string') reply.taskId = root.task_id;
  if (typeof root.consumed === 'string') reply.consumed = root.consumed;
  return reply;
}

/**
 * 把答案摊平成“选项 → 概率”（choice/score），或“true/false → 概率”（noul）。
 * 用于确定性抽样；没有概率时退化成“模型选中的那个 = 1”。
 */
export function answerWeights(a: JevAnswer): Record<string, number> {
  if (a.type === 'noul') {
    const p = a.noul ?? 0.5;
    return { true: p, false: 1 - p };
  }
  if (a.probabilities && Object.keys(a.probabilities).length) {
    const out: Record<string, number> = {};
    let sum = 0;
    for (const [k, v] of Object.entries(a.probabilities)) {
      if (!Number.isFinite(v) || v <= 0) continue;
      out[k] = v;
      sum += v;
    }
    if (sum > 0) for (const k of Object.keys(out)) out[k] /= sum;
    return out;
  }
  if (a.type === 'choice' && a.choice) return { [a.choice]: 1 };
  return {};
}
