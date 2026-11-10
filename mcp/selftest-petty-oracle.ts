/**
 * 小事件裁决层自检（mock 模式，不联网）。
 */
import { existsSync, readFileSync } from 'node:fs';

import { createWorld, openSession, stateGet, submitOrders, turnStep, type Session } from './engine';
import { verifySession } from './monarch';
import { monarchRound, setupMonarch } from './monarch';
import { dmSetup } from './dm';
import { buildPettyContext, pettyDigest, pettyRound, pettyRuntime, pettySetup, pettyStatus, scanPettyEvents } from './petty';
import { pettyMode } from '../src/gen/civ/petty';
import { polityKey, settlementKey } from '../src/gen/edits';

let passed = 0;
let failed = 0;
function ok(cond: unknown, name: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}
function eq(actual: unknown, expected: unknown, name: string): void {
  ok(actual === expected, `${name}（得到 ${String(actual)}，期望 ${String(expected)}）`);
}

function sacksOf(s: Session): number {
  let n = 0;
  for (const st of s.civ.settlements) n += st.sacks?.length ?? 0;
  return n;
}

const WORLD_SEED = 7;
const WORLD_CELLS = 12000;
const newWorld = () => createWorld({ seed: WORLD_SEED, params: { cells: WORLD_CELLS } });
const newSession = (rounds = 12) => openSession({ worldId: newWorld().id, startYear: 1200, stepYears: 5, maxRounds: rounds }).session;

async function main(): Promise<void> {
  console.log('== 引擎 v2 petty 干预（sack / dev，独立会话）');
  {
    const s = newSession();
    await pettySetup(s, { mock: true, profile: 'L2' });
    const st = stateGet(s) as { polities: { id: number; key: string; capital: number; capitalName: string }[] };
    const polity = st.polities[0];
    ok(!!polity && polity.capital >= 0, '有可用的国家与国都');
    const cityKey = settlementKey(s.civ, polity.capital);
    const beforeSacks = sacksOf(s);
    const beforeFp = (stateGet(s) as { fingerprint: string }).fingerprint;
    const order = submitOrders(s, [{ kind: 'petty', a: polityKey(s.civ, polity.id), from: s.play.year, effect: { type: 'sack', loss: 2, city: cityKey } }]);
    eq(order.commands.length, 1, 'sack 命令被引擎接收');
    eq(order.rejected.length, 0, 'sack 无拒收');
    const step = turnStep(s, { years: 2 });
    ok(sacksOf(s) > beforeSacks, 'Settlement.sacks 增加（城市真折损）');
    ok(step.fingerprint !== beforeFp, '指纹变化');
    eq(step.toYear, 1202, '推进到 1202');

    const st2 = stateGet(s) as { polities: { id: number; capital: number }[] };
    const p = st2.polities[0];
    const devOrder = submitOrders(s, [{ kind: 'petty', a: polityKey(s.civ, p.id), from: s.play.year, effect: { type: 'dev', years: 3 } }]);
    eq(devOrder.commands.length, 1, 'dev 命令被接收');
    const devStep = turnStep(s, { years: 2 });
    eq(devStep.finished, false, 'dev 回合推进正常');
  }

  console.log('== 主会话：setup / 扫描');
  const s = newSession();
  const setup = await pettySetup(s, { mock: true, profile: 'L2', maxQuestions: 8 });
  eq(setup.petty.configured, true, '已配置');
  eq(setup.petty.mock, true, 'mock 模式');
  eq(pettyStatus(s).rounds, 0, '初始回合 0');
  eq(pettyStatus(s).profile, 'L2', 'profile L2');

  const events1 = scanPettyEvents(s, { profile: 'L2' });
  const events2 = scanPettyEvents(s, { profile: 'L2' });
  ok(events1.length > 0, `扫出候选事件（${events1.length} 条）`);
  eq(JSON.stringify(events1.map((e) => e.id)), JSON.stringify(events2.map((e) => e.id)), '扫描确定');
  ok(events1.every((e, i) => i === 0 || events1[i - 1].priority <= e.priority), '按优先级排序');
  ok(events1.some((e) => e.priority === 0), '含 P0 事件');
  ok(events1.every((e) => e.mode.domain !== 'infrastructure' || e.priority === 2), '基建模式都是 P2');
  const ctx = buildPettyContext(s, events1);
  ok(ctx.includes('第 1,200 年') || ctx.includes('第 1200 年'), '上下文含年份');
  ok(ctx.includes('本回合待裁决的小事'), '上下文含待裁决段');

  console.log('== mock 回合 1');
  const r1 = await pettyRound(s, { years: 5 });
  eq(r1.round, 1, '回合号 1');
  eq(r1.fromYear, 1200, '起始年 1200');
  eq(r1.toYear, 1205, '结束年 1205');
  ok(r1.decisions.length > 0, `有决策（${r1.decisions.length}）`);
  ok(r1.decisions.some((d) => d.source === 'mock'), '决策来自 mock');
  ok(r1.tokens.total >= 0, 'token 统计存在');
  ok(existsSync(`${s.logDir}/petty-round-0001.json`), '回合日志 json 存在');
  ok(existsSync(`${s.logDir}/petty-rounds.jsonl`), '回合日志 jsonl 存在');
  const digest = pettyDigest(r1);
  ok(typeof digest === 'string' && digest.length > 0, 'DM 摘要非空');
  ok(!digest.includes('概率') && !digest.includes('confidence'), 'DM 摘要不含概率/置信度');

  console.log('== mock 回合 2 + 回放');
  const r2 = await pettyRound(s, { years: 5 });
  eq(r2.round, 2, '回合号 2');
  eq(r2.toYear, 1210, '结束年 1210');
  eq(pettyStatus(s).rounds, 2, '状态里回合数 2');
  eq(verifySession(s).ok, true, '回放一致');
  eq((pettyStatus(s).last as { round: number } | null)?.round, 2, '状态 last.round=2');

  console.log('== 确定性：两个独立会话同配置');
  const sA = newSession();
  const sB = newSession();
  await pettySetup(sA, { mock: true, profile: 'L2', maxQuestions: 8 });
  await pettySetup(sB, { mock: true, profile: 'L2', maxQuestions: 8 });
  await pettyRound(sA, { years: 5 });
  await pettyRound(sB, { years: 5 });
  await pettyRound(sA, { years: 5 });
  await pettyRound(sB, { years: 5 });
  eq((stateGet(sB) as { fingerprint: string }).fingerprint, (stateGet(sA) as { fingerprint: string }).fingerprint, '同种子/同配置/两回合后指纹一致');

  console.log('== 预算极小：P0 保留、P1/P2 降级');
  const s3 = newSession();
  await pettySetup(s3, { mock: true, profile: 'L3', maxQuestions: 8, budget: { hardTokens: 300, targetTokens: 300, maxQuestions: 1 } });
  const r3 = await pettyRound(s3, { years: 5 });
  ok(r3.fallbackCount > 0, `有降级（${r3.fallbackCount}）`);
  ok(r3.decisions.some((d) => d.source === 'engine-rule'), '存在 engine-rule 决策');
  ok(r3.decisions.filter((d) => pettyMode(d.modeId).priority === 'P0').every((d) => d.source !== 'engine-rule'), 'P0 不被预算降级');

  console.log('== 熔断后恢复（mock probe）');
  const rt = pettyRuntime(s3.id);
  ok(!!rt, '拿得到 runtime');
  rt?.queue.trip();
  eq(rt?.queue.isTripped, true, '已熔断');
  eq((await pettyRound(s3, { years: 5 })).round, 2, '熔断后仍能跑回合（probe 成功自动 reset）');
  eq(pettyRuntime(s3.id)?.queue.isTripped, false, '队列已恢复');

  console.log('== 君主回合合流（petty + DM + 君主，同一次 turnStep）');
  const sM = newSession();
  await pettySetup(sM, { mock: true, profile: 'L2' });
  setupMonarch(sM, { polities: 'all', maxOrders: 3, mock: true });
  await dmSetup(sM, { mock: true, maxDecisions: 2 });
  const mr = await monarchRound(sM, { years: 5 });
  ok(!!mr.petty, '君主回合结果里带 petty');
  ok(!!mr.dm, '君主回合结果里带 dm');
  eq(mr.round, 1, '合流回合号 1');
  eq(!!mr.petty && mr.petty.source, 'mock', 'petty 来源 mock');
  ok((mr.petty?.events ?? 0) > 0, '本回合结算了小事');
  ok((mr.decisions.length ?? 0) > 0, '君主决策非空');
  eq(verifySession(sM).ok, true, '合流回合回放一致');

  const sM2 = newSession();
  await pettySetup(sM2, { mock: true, profile: 'L2' });
  setupMonarch(sM2, { polities: 'all', maxOrders: 3, mock: true });
  await dmSetup(sM2, { mock: true, maxDecisions: 2 });
  await monarchRound(sM2, { years: 5 });
  eq(
    (stateGet(sM2) as { fingerprint: string }).fingerprint,
    (stateGet(sM) as { fingerprint: string }).fingerprint,
    '同配置合流回合指纹一致',
  );

  console.log('== 日志内容');
  const log = JSON.parse(readFileSync(`${s.logDir}/petty-round-0001.json`, 'utf8')) as Record<string, unknown>;
  ok(typeof log.context === 'string' && (log.context as string).length > 0, '日志含上下文');
  ok(Array.isArray(log.decisions), '日志含决策');
  ok(log.budget !== undefined, '日志含预算统计');

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
