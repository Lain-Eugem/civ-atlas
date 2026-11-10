/**
 * 小事件裁决层 · ContextBudgetManager（token 预算与问题打包）。
 *
 * 官方 Jev 没有在文档里写死单次输入上限，但账单和延迟仍要控；沿用任务书给的默认值：
 *   硬上限 4250、目标 4000、环境描述占 40–50%、每批最多 8 个问题（全部可配置）。
 *
 * 规则：
 *   - 环境描述（地区/年份/季节/关键数值）不可省略：先放，且不裁；
 *   - P0（战争/灾害）必含；P1（经济/社会）应含；P2（基建/闲事）可裁，先裁 P2 再裁 P1；
 *   - 超预算时先少打包问题，不裁 P0；若环境+P0 本身超硬上限，照发但返回 overBudget 标记，日志记录；
 *   - 每批记录估算、各优先级占用、问题数，供回合日志与 usage 对照校准。
 *
 * estimateTokens 是估算（中文≈1 字 1 token；英文/数字≈4 字符 1；JSON 符号 1/个；整体 ×1.1 上取整），
 * 真实 token 以官方 usage.input_tokens 为准。
 */

export type PettyPriority = 0 | 1 | 2;

export interface PettyQuestionSpec {
  /** 问题 key（会原样回显；只允许短英文/编号） */
  key: string;
  /** 0 = P0 战争/灾害；1 = P1 经济/社会；2 = P2 基建/闲事 */
  priority: PettyPriority;
  type: 'noul' | 'choice' | 'score';
  instructions: string;
  criteria?: Record<string, string> | string[] | { true?: string; false?: string };
  /** 给日志看的事件/模式 id（可选） */
  label?: string;
}

export interface PettyBudgetConfig {
  /** 硬上限，默认 4250 */
  hardTokens?: number;
  /** 目标，默认 4000 */
  targetTokens?: number;
  /** 每批最多几个问题，默认 8 */
  maxQuestions?: number;
  /** 环境段目标占比，默认 0.45（即 4000 的 45% = 1800） */
  envRatio?: number;
}

export interface PettyBudgetConfigResolved {
  hardTokens: number;
  targetTokens: number;
  maxQuestions: number;
  envRatio: number;
}

export interface PettyBudgetQuestion {
  key: string;
  priority: PettyPriority;
  type: 'noul' | 'choice' | 'score';
  instructions: string;
  criteria?: Record<string, string> | string[] | { true?: string; false?: string };
  label?: string;
  tokens: number;
}

export interface PettyBudgetDropped {
  key: string;
  priority: PettyPriority;
  label?: string;
  reason: 'budget' | 'question-cap';
}

export interface PettyBudgetPlan {
  /** 原样发出去的环境描述 */
  env: string;
  /** 原样发出去的 questions（可直接给 askJev） */
  questions: Record<string, PettyBudgetQuestion>;
  included: PettyBudgetQuestion[];
  dropped: PettyBudgetDropped[];
  tokens: {
    /** 环境段估算 */
    env: number;
    /** 请求外壳（model/state/questions 字段名与 JSON 结构） */
    shell: number;
    /** 所有问题估算之和 */
    questions: number;
    /** 估算总量（已含 ×1.1 余量） */
    total: number;
    /** 按优先级拆的估算：0/1/2 */
    byPriority: Record<'0' | '1' | '2', number>;
    target: number;
    hard: number;
    /** 环境段占 target 的比例 */
    envShare: number;
    /** 超过硬上限（环境+P0 都无法压时才会出现） */
    overBudget: boolean;
    /** 环境段超过 envRatio 目标（不裁，只提示） */
    envOver: boolean;
  };
}

/** 请求外壳的估算基数：{"model":"…","state":"…","questions":{}} 与 JSON 结构约 60 tokens */
const SHELL_TOKENS = 60;

function isCjk(cp: number): boolean {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // 基本区
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容区
    (cp >= 0x20000 && cp <= 0x2ffff) || // 扩展 B+
    (cp >= 0x3000 && cp <= 0x303f) || // 中日韩标点
    (cp >= 0xff00 && cp <= 0xffef) || // 全角
    (cp >= 0xfe30 && cp <= 0xfe4f) // 竖排标点
  );
}

function isAsciiAlnum(cp: number): boolean {
  return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}

/**
 * 粗略估算 token 数：中文/全角字符 1 个 1 token；英文与数字 4 个 1 token；
 * JSON 符号与其它可见 ASCII 标点 1 个 1 token；空白不计；最后 ×1.1 上取整。
 * 只用于“别把请求撑爆”的守门，真实值以服务端 usage 为准。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let ascii = 0;
  let symbols = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isCjk(cp)) cjk++;
    else if (isAsciiAlnum(cp)) ascii++;
    else if (cp === 0x0a || cp === 0x0d || cp === 0x20 || cp === 0x09) {
      /* 空白不计 */
    } else symbols++;
  }
  const raw = cjk + Math.ceil(ascii / 4) + symbols;
  return Math.ceil(raw * 1.1);
}

/** 一个问题定义本身的估算（含 key） */
export function estimateQuestionTokens(q: PettyQuestionSpec): number {
  const def: Record<string, unknown> = { type: q.type, instructions: q.instructions };
  if (q.criteria !== undefined) def.criteria = q.criteria;
  return Math.max(1, estimateTokens(q.key) + estimateTokens(JSON.stringify(def)));
}

function resolveConfig(cfg: PettyBudgetConfig): PettyBudgetConfigResolved {
  const hardTokens = clampInt(cfg.hardTokens ?? 4250, 200, 200_000, 'hardTokens');
  const targetTokens = clampInt(cfg.targetTokens ?? 4000, 100, hardTokens, 'targetTokens');
  const maxQuestions = clampInt(cfg.maxQuestions ?? 8, 1, 64, 'maxQuestions');
  const envRatio = clampFloat(cfg.envRatio ?? 0.45, 0.1, 0.9, 'envRatio');
  return { hardTokens, targetTokens, maxQuestions, envRatio };
}

function clampInt(v: unknown, lo: number, hi: number, name: string): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} 必须是数字`);
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function clampFloat(v: unknown, lo: number, hi: number, name: string): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} 必须是数字`);
  return Math.min(hi, Math.max(lo, n));
}

const PRIO_ORDER: readonly PettyPriority[] = [0, 1, 2];

/**
 * 打包一批问题：稳定排序（P0→P1→P2，同级保持传入顺序），先放环境，再按优先级塞问题。
 * 环境与 P0 永不裁；P1/P2 装不下就丢并说明原因。
 */
export function planPettyBatch(envText: string, specs: readonly PettyQuestionSpec[], cfg: PettyBudgetConfig = {}): PettyBudgetPlan {
  const c = resolveConfig(cfg);
  const env = envText ?? '';
  const envTokens = estimateTokens(env);
  const shell = SHELL_TOKENS;
  const base = shell + envTokens;
  const envOver = envTokens > Math.floor(c.targetTokens * c.envRatio);

  const sorted = specs
    .map((q, i) => ({ q, i }))
    .sort((a, b) => a.q.priority - b.q.priority || a.i - b.i)
    .map(({ q }) => q);

  const picked: PettyBudgetQuestion[] = [];
  const dropped: PettyBudgetDropped[] = [];
  const byPriority: Record<'0' | '1' | '2', number> = { '0': 0, '1': 0, '2': 0 };
  let used = base;
  let overBudget = false;

  for (const q of sorted) {
    const item: PettyBudgetQuestion = {
      key: q.key,
      priority: q.priority,
      type: q.type,
      instructions: q.instructions,
      tokens: estimateQuestionTokens(q),
    };
    if (q.criteria !== undefined) item.criteria = q.criteria;
    if (q.label !== undefined) item.label = q.label;

    if (picked.length >= c.maxQuestions) {
      dropped.push({ key: q.key, priority: q.priority, label: q.label, reason: 'question-cap' });
      continue;
    }
    if (q.priority === 0) {
      // P0 必含：即便越过目标也放；只有越过硬上限才标记 overBudget（仍放，交给上层决定是否拆批）
      picked.push(item);
      used += item.tokens;
      byPriority['0'] += item.tokens;
      if (used > c.hardTokens) overBudget = true;
      continue;
    }
    const limit = c.targetTokens;
    if (used + item.tokens > limit) {
      // 先试再塞更低优先级的；P1/P2 一律按目标裁
      dropped.push({ key: q.key, priority: q.priority, label: q.label, reason: 'budget' });
      continue;
    }
    picked.push(item);
    used += item.tokens;
    byPriority[String(q.priority) as '1' | '2'] += item.tokens;
  }

  const packed: Record<string, PettyBudgetQuestion> = {};
  for (const q of picked) packed[q.key] = q;

  return {
    env,
    questions: packed,
    included: picked,
    dropped,
    tokens: {
      env: envTokens,
      shell,
      questions: byPriority['0'] + byPriority['1'] + byPriority['2'],
      total: used,
      byPriority,
      target: c.targetTokens,
      hard: c.hardTokens,
      envShare: c.targetTokens > 0 ? envTokens / c.targetTokens : 0,
      overBudget,
      envOver,
    },
  };
}

/** 一行日志摘要：方便每回合写进 petty-round-*.json */
export function describeBudgetPlan(plan: PettyBudgetPlan): Record<string, unknown> {
  return {
    tokens: plan.tokens,
    included: plan.included.map((q) => ({ key: q.key, priority: q.priority, tokens: q.tokens, label: q.label })),
    dropped: plan.dropped,
  };
}

/** 估算费用（美元）：官方价目 input $0.084 / 1M tokens，output $0；只用估算值预判，实际以 usage.cost 为准 */
export function estimateCostUsd(inputTokens: number): number {
  return (inputTokens / 1_000_000) * 0.084;
}
