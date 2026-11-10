/**
 * Petty 层核心自检：官方 Jev 客户端 + token 预算 + 串行优先队列。
 * 不需要真实 API Key：客户端测试用本地 http 假服务器；队列用可控 promise。
 *
 * 运行：node mcp/.build/mcp/selftest-petty-core.js
 */
import * as http from 'node:http';
import { JevError, askJev, answerWeights, checkQuestions, jevSettings, jevSettingsView } from './petty-client';
import { describeBudgetPlan, estimateCostUsd, estimateTokens, planPettyBatch, type PettyQuestionSpec } from './petty-budget';
import { PettyQueue, PettyQueueError } from './petty-queue';

async function main(): Promise<void> {
let passed = 0;
const ok = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(`断言失败：${msg}`);
  passed++;
};

const near = (a: number, b: number, eps: number, msg: string) => ok(Math.abs(a - b) <= eps, `${msg}（${a} vs ${b}）`);

async function throwsKind(fn: () => Promise<unknown>, kind: string, msg: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    ok((e as PettyQueueError).kind === kind, `${msg} 的 kind 应为 ${kind}，实际 ${String((e as PettyQueueError).kind)}`);
    return;
  }
  throw new Error(`断言失败：${msg} 应该抛错`);
}

/** 本地假 Jev 服务器 */
async function fakeServer(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void): Promise<{ url: string; close: () => Promise<void>; lastAuth?: string; lastBody?: string }> {
  const state: { lastAuth?: string; lastBody?: string } = {};
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      state.lastAuth = req.headers.authorization;
      state.lastBody = body;
      handler(req, body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('假服务器没有端口');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    get lastAuth(): string | undefined {
      return state.lastAuth;
    },
    get lastBody(): string | undefined {
      return state.lastBody;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

// ---------- 1. estimateTokens ----------
ok(estimateTokens('') === 0, '空串 0 token');
ok(estimateTokens('你好') >= 2 && estimateTokens('你好') <= 4, '两个汉字约 2–4 token');
ok(estimateTokens('abcd') >= 1 && estimateTokens('abcd') <= 2, '4 个英文字符约 1–2 token');
ok(estimateTokens('{"a":1}') >= 4, 'JSON 符号按个计');
const big = '很'.repeat(2000);
ok(estimateTokens(big) > 2000 && estimateTokens(big) < 2400, '2000 汉字约 2000–2400 token');
near(estimateCostUsd(1_000_000), 0.084, 1e-9, '100 万 input token ≈ $0.084');

// ---------- 2. 预算打包 ----------
const spec = (key: string, priority: 0 | 1 | 2, extra: Partial<PettyQuestionSpec> = {}): PettyQuestionSpec => ({
  key,
  priority,
  type: 'noul',
  instructions: '判断这件事是否发生。',
  ...extra,
});

{
  const env = '第 2510 年，明河国东部，秋季。连月少雨，粮价上涨 12%。';
  const plan = planPettyBatch(env, [spec('a_p0', 0), spec('b_p1', 1), spec('c_p1', 1), spec('d_p2', 2), spec('e_p2', 2)], { maxQuestions: 3 });
  ok(plan.included.length === 3, 'maxQuestions=3 只收 3 个');
  ok(plan.included[0].key === 'a_p0', 'P0 排第一');
  ok(plan.dropped.some((d) => d.key === 'd_p2' && d.reason === 'question-cap'), 'P2 因问题数上限被丢');
  ok(plan.tokens.byPriority['0'] > 0, 'P0 占用有统计');
  const desc = describeBudgetPlan(plan);
  ok(Array.isArray(desc.dropped), '日志摘要可序列化');
}

{
  // 环境把预算撑满：P0 仍保留，并标 overBudget
  const env = '很'.repeat(4000);
  const plan = planPettyBatch(env, [spec('p0_a', 0, { instructions: '这是一个问题。' })], { targetTokens: 4000, hardTokens: 4250 });
  ok(plan.included.length === 1, '环境超预算时 P0 仍必含');
  ok(plan.tokens.overBudget, '环境+P0 超硬上限时标 overBudget');
  ok(plan.tokens.envOver, '环境占比超 45% 时标 envOver');
}

{
  // P1/P2 装不下按目标裁
  const env = '第 2500 年，某地，冬。';
  const plan = planPettyBatch(env, [spec('p1_big', 1, { instructions: '很'.repeat(600) }), spec('p2_small', 2)], {
    targetTokens: 300,
    hardTokens: 4250,
  });
  ok(!plan.included.some((q) => q.key === 'p1_big'), '长 P1 因预算被丢');
  ok(plan.included.some((q) => q.key === 'p2_small'), '小 P2 还能装下');
  ok(plan.dropped.some((d) => d.key === 'p1_big' && d.reason === 'budget'), 'P1 丢弃原因是 budget');
}

// ---------- 3. 串行优先队列 ----------
{
  const q = new PettyQueue({ maxPending: 10, roundWaitMs: 60_000, failuresToTrip: 99 });
  const order: string[] = [];
  let release: () => void = () => undefined;
  const blocker = new Promise<void>((resolve) => (release = resolve));
  const pBlock = q.enqueue(async () => {
    order.push('first');
    await blocker;
    return 'first';
  }, { priority: 1 });
  // 等第一个真正开始
  await new Promise((r) => setTimeout(r, 5));
  const p2 = q.enqueue(async () => {
    order.push('p2');
    return 2;
  }, { priority: 2 });
  const p1 = q.enqueue(async () => {
    order.push('p1');
    return 1;
  }, { priority: 1 });
  const p0 = q.enqueue(async () => {
    order.push('p0');
    return 0;
  }, { priority: 0 });
  // 在途始终 ≤1
  let maxRun = 0;
  for (let i = 0; i < 5; i++) {
    maxRun = Math.max(maxRun, q.stats.running);
    await new Promise((r) => setTimeout(r, 5));
  }
  ok(maxRun <= 1, '在途始终 ≤1');
  release();
  await Promise.all([pBlock, p2, p1, p0]);
  release = () => undefined;
  ok(order.join(',') === 'first,p0,p1,p2', `优先级顺序 first,p0,p1,p2，实际 ${order.join(',')}`);
  ok(q.stats.completed === 4, '完成 4 条');
  ok(q.stats.maxWaitMs >= 0, '等待统计存在');
}

// 超时
{
  const q = new PettyQueue({ failuresToTrip: 99 });
  const started = Date.now();
  const p = q.enqueue((signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))), {
    priority: 0,
    timeoutMs: 40,
  });
  await throwsKind(() => p, 'timeout', '超时任务');
  ok(Date.now() - started >= 30, '确实等到了超时');
  ok(q.stats.timedOut === 1, '超时统计 +1');
}

// 背压：P2 被拒，P1 照收
{
  const q = new PettyQueue({ maxPending: 1, failuresToTrip: 99 });
  let release: () => void = () => undefined;
  const blocker = q.enqueue(async () => {
    await new Promise<void>((r) => (release = r));
    return 0;
  }, { priority: 0 });
  await new Promise((r) => setTimeout(r, 5));
  const p2 = q.enqueue(async () => 2, { priority: 2 });
  await throwsKind(() => p2, 'throttled', '挂起满时 P2 背压');
  ok(q.stats.throttled === 1, 'throttled 统计 +1');
  const p1 = q.enqueue(async () => 1, { priority: 1 });
  release();
  await Promise.all([blocker, p1]);
}

// 熔断：连续失败 2 次后直接 circuit-open
{
  const q = new PettyQueue({ failuresToTrip: 2 });
  const bad = () => Promise.reject(new Error('boom'));
  for (const nth of [1, 2]) {
    let thrown: unknown = null;
    try {
      await q.enqueue(bad, { priority: 0 });
    } catch (e) {
      thrown = e;
    }
    ok(thrown instanceof Error && thrown.message === 'boom', `第 ${nth} 次失败原样抛给调用方`);
  }
  ok(q.isTripped, '两次失败后熔断');
  await throwsKind(() => q.enqueue(async () => 0, { priority: 0 }), 'circuit-open', '熔断后直接拒绝');
  q.reset();
  ok(!q.isTripped, 'reset 后恢复');
  await q.enqueue(async () => 1, { priority: 0 });
}

// 回合等待超时降级
{
  const q = new PettyQueue({ roundWaitMs: 1_000_000, failuresToTrip: 99 });
  q.beginRound();
  let release: () => void = () => undefined;
  const blocker = q.enqueue(async () => {
    await new Promise<void>((r) => (release = r));
    return 0;
  }, { priority: 0 });
  await new Promise((r) => setTimeout(r, 5));
  // 手动把回合计时提前：用 now 注入的队列更干净，这里直接 close 验收 closed
  const q2 = new PettyQueue({ now: () => Date.now(), roundWaitMs: 100, failuresToTrip: 99 });
  q2.beginRound();
  await new Promise((r) => setTimeout(r, 160));
  await throwsKind(() => q2.enqueue(async () => 1, { priority: 0 }), 'degraded', '回合超时后入队即降级');
  release();
  await blocker;
}

// 关闭
{
  const q = new PettyQueue({ failuresToTrip: 99 });
  let release: () => void = () => undefined;
  const blocker = q.enqueue(async () => {
    await new Promise<void>((r) => (release = r));
    return 0;
  }, { priority: 0 });
  await new Promise((r) => setTimeout(r, 5));
  const queued = q.enqueue(async () => 1, { priority: 1 });
  q.close();
  await throwsKind(() => queued, 'closed', '关闭后挂起任务被拒');
  release();
  await blocker;
}

// ---------- 4. 官方 Jev 客户端 ----------
{
  // 缺 Key
  const oldKey = process.env.JEV_API_KEY;
  const oldKey2 = process.env.DEFAPI_API_KEY;
  delete process.env.JEV_API_KEY;
  delete process.env.DEFAPI_API_KEY;
  let threw = false;
  try {
    jevSettings({});
  } catch (e) {
    threw = e instanceof JevError && e.kind === 'config';
  }
  ok(threw, '缺 API Key 抛 config 错误');
  if (oldKey !== undefined) process.env.JEV_API_KEY = oldKey;
  if (oldKey2 !== undefined) process.env.DEFAPI_API_KEY = oldKey2;

  const s = jevSettings({ apiKey: 'dk-test', baseUrl: 'https://example.com/', timeoutMs: 10_000 });
  ok(s.baseUrl === 'https://example.com', 'baseUrl 去掉末尾斜杠');
  ok(s.model === 'typesafe/jev-1.14.0', '默认模型 typesafe/jev-1.14.0');
  const view = jevSettingsView(s);
  ok(view.hasApiKey === true && !('apiKey' in view), '配置视图不含 Key');

  // 问题校验
  let badChoice = false;
  try {
    checkQuestions({ q: { type: 'choice', instructions: '选一个', criteria: {} } });
  } catch (e) {
    badChoice = e instanceof JevError && e.kind === 'request';
  }
  ok(badChoice, 'choice 空 criteria 被拒');
  let badScore = false;
  try {
    checkQuestions({ q: { type: 'score', instructions: '打分', criteria: ['只有一档'] } });
  } catch (e) {
    badScore = e instanceof JevError && e.kind === 'request';
  }
  ok(badScore, 'score 少于 2 档被拒');
}

// 成功解析：noul/choice/score 三种答案
{
  const server = await fakeServer((_req, _body, res) =>
    json(res, 200, {
      id: 'gen-dec-1',
      model: 'typesafe/jev-1.14.0',
      provider: 'TypeSafe',
      answers: {
        drought: { type: 'noul', noul: 0.7 },
        raid: { type: 'choice', choice: 'major', probabilities: { none: 0.2, major: 0.8 }, confidence: 0.8 },
        damage: { type: 'score', score: 1.9, legend: { '0': '无', '1': '小', '2': '大' }, probabilities: { '0': 0, '1': 0.1, '2': 0.9 }, confidence: 0.9 },
      },
      usage: { input_tokens: 321, output_tokens: 44, cost: 0.000027 },
      task_id: 'task-1',
      consumed: '0.000027',
    }),
  );
  try {
    const s = jevSettings({ apiKey: 'dk-test', baseUrl: server.url });
    const reply = await askJev(
      {
        drought: { type: 'noul', instructions: '是否旱灾' },
        raid: { type: 'choice', instructions: '劫掠规模', criteria: { none: '无', major: '大' } },
        damage: { type: 'score', instructions: '损失多大', criteria: ['无', '小', '大'] },
      },
      '第 2500 年，某地。',
      s,
      { sessionId: 'petty-round-1' },
    );
    ok(reply.answers.drought.noul === 0.7, 'noul 解析');
    ok(reply.answers.raid.choice === 'major', 'choice 解析');
    ok((reply.answers.damage.probabilities?.['2'] ?? 0) === 0.9, 'score 概率解析');
    ok(reply.usage.inputTokens === 321 && reply.usage.outputTokens === 44, 'usage 解析');
    ok(reply.taskId === 'task-1' && reply.consumed === '0.000027', 'task_id/consumed 解析');
    ok(server.lastAuth === 'Bearer dk-test', 'Authorization 头正确');
    const sent = JSON.parse(server.lastBody ?? '{}') as { model?: string; session_id?: string; questions?: unknown };
    ok(sent.model === 'typesafe/jev-1.14.0', '请求里 model 正确');
    ok(sent.session_id === 'petty-round-1', 'session_id 透传');
    const w = answerWeights(reply.answers.raid);
    near(w.major, 0.8, 1e-9, 'choice 权重');
    near(Object.values(w).reduce((a, b) => a + b, 0), 1, 1e-9, 'choice 权重归一');
    const noul = answerWeights(reply.answers.drought);
    near(noul.true, 0.7, 1e-9, 'noul true 权重');
    near(noul.false, 0.3, 1e-9, 'noul false 权重');
  } finally {
    await server.close();
  }
}

// 401 / 400 / 500 / 坏响应
{
  const server = await fakeServer((req, _body, res) => {
    if (req.url === '/api/v1/decisions') {
      const auth = req.headers.authorization ?? '';
      if (auth.includes('bad')) return json(res, 401, { code: 1, message: 'Invalid API Key' });
      return json(res, 400, { code: 1, message: 'model not found' });
    }
    json(res, 404, {});
  });
  try {
    const s401 = jevSettings({ apiKey: 'bad-key', baseUrl: server.url });
    let authErr: JevError | null = null;
    try {
      await askJev({ q: { type: 'noul', instructions: 'x' } }, 's', s401);
    } catch (e) {
      authErr = e as JevError;
    }
    ok(authErr?.kind === 'auth' && authErr.status === 401, '401 映射 auth');
    ok((authErr?.message ?? '').includes('API Key'), '401 提示 Key');

    const s400 = jevSettings({ apiKey: 'ok', baseUrl: server.url });
    let reqErr: JevError | null = null;
    try {
      await askJev({ q: { type: 'noul', instructions: 'x' } }, 's', s400);
    } catch (e) {
      reqErr = e as JevError;
    }
    ok(reqErr?.kind === 'request' && reqErr.status === 400, '400 映射 request');
  } finally {
    await server.close();
  }
}

// 5xx
{
  const server = await fakeServer((_req, _body, res) => json(res, 503, { code: 1, message: 'upstream down' }));
  try {
    const s = jevSettings({ apiKey: 'ok', baseUrl: server.url });
    let err: JevError | null = null;
    try {
      await askJev({ q: { type: 'noul', instructions: 'x' } }, 's', s);
    } catch (e) {
      err = e as JevError;
    }
    ok(err?.kind === 'server' && err.status === 503, '503 映射 server');
  } finally {
    await server.close();
  }
}

// 响应缺 answers
{
  const server = await fakeServer((_req, _body, res) => json(res, 200, { model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }));
  try {
    const s = jevSettings({ apiKey: 'ok', baseUrl: server.url });
    let err: JevError | null = null;
    try {
      await askJev({ q: { type: 'noul', instructions: 'x' } }, 's', s);
    } catch (e) {
      err = e as JevError;
    }
    ok(err?.kind === 'response', '缺 answers 映射 response');
  } finally {
    await server.close();
  }
}

// 超时
{
  const server = await fakeServer((_req, _body, res) => {
    setTimeout(() => json(res, 200, { model: 'm', answers: { q: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: 1, output_tokens: 1 } }), 300);
  });
  try {
    const s = jevSettings({ apiKey: 'ok', baseUrl: server.url, timeoutMs: 50 });
    let err: JevError | null = null;
    try {
      await askJev({ q: { type: 'noul', instructions: 'x' } }, 's', s);
    } catch (e) {
      err = e as JevError;
    }
    ok(err?.kind === 'timeout', '客户端超时映射 timeout');
  } finally {
    await server.close();
  }
}

console.log(`petty core 自检通过：${passed} 条断言`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
