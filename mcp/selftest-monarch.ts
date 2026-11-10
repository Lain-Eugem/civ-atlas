/**
 * 君主回合自检(不联网):
 * - 简报生成(每个国家一份、含命令说明与输出格式)
 * - 君主命令编译(合法 / 目标不在世 / 不接壤 / 超量 / 坏 JSON)
 * - mock 君王跑 2 个回合:年份推进、每国决策落日志、命令进引擎
 * - 回放对账:同一份世界 + 同一串命令重推,指纹一致
 * - 两次独立会话同配置同 mock,最终指纹一致(君主层没有引入不确定性)
 *
 * 运行: node mcp/.build/mcp/selftest-monarch.js
 */
import { existsSync, readdirSync } from 'node:fs';
import { createWorld, getSession, openSession, sessionSummary, stateGet } from './engine';
import { compileMonarchOrders } from '../src/gen/civ/monarch';
import { monarchBriefList, monarchRound, monarchStatus, setupMonarch, verifySession } from './monarch';

let pass = 0;
let fail = 0;

function ok(cond: boolean, name: string, detail?: unknown): void {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`);
    if (detail !== undefined) console.log('       ' + JSON.stringify(detail).slice(0, 400));
  }
}

async function main(): Promise<void> {
  console.log('== civ-atlas 君主回合自检(mock,不联网)==');
  const started = Date.now();

  const world = createWorld({ seed: 7, params: { cells: 12000 } });
  ok(!!world.id, 'civ_world_create', world.id);

  const opened = openSession({ worldId: world.id, startYear: 1200, stepYears: 5, maxRounds: 4, mode: 'monarch' });
  const sid = opened.summary.sessionId;
  const s = getSession(sid);
  ok(s.mode === 'monarch', '会话模式为 monarch', s.mode);
  ok(opened.summary.year === 1200, '会话停在起始年 1200', opened.summary.year);

  const state = stateGet(s);
  const alive = state.polities as { id: number; name: string; size: number }[];
  ok(Array.isArray(alive) && alive.length >= 2, '第 1200 年有至少 2 个在世国家', alive?.length);

  // 简报
  const briefs = monarchBriefList(s);
  ok(briefs.polities === alive.length, '简报数与在世国家数一致', `${briefs.polities} vs ${alive.length}`);
  const first = briefs.briefs[0]!;
  ok(first.text.includes('## 你的国家') && first.text.includes('## 输出格式'), '简报含国家段与输出格式段');
  ok(first.text.includes('你能下的命令') && first.text.includes('declare'), '简报含命令说明');
  ok(first.key.startsWith('polity:'), '简报带稳定键', first.key);

  // 命令编译
  const me = alive[0]!;
  const legal = compileMonarchOrders(s.civ, s.play.year, me.id, [{ kind: 'policy', preset: 'expand' }]);
  ok(legal.commands.length === 1 && legal.rejected.length === 0, '合法国策编译成 1 条命令', legal);
  const firstCmd = legal.commands[0] as { from: number; a?: string };
  ok(firstCmd.from === 1200 && firstCmd.a === first.key, '命令 from=今年、a=本国稳定键', legal.commands[0]);

  const illegal = compileMonarchOrders(s.civ, s.play.year, me.id, [
    { kind: 'policy', preset: 'no-such-preset' },
    { kind: 'declare', b: 99999 },
    { kind: 'ally', b: me.id },
    { kind: 'wat' },
    { kind: 'halt' },
  ]);
  ok(illegal.commands.length === 1 && illegal.rejected.length === 4, '坏命令逐条拒收(不影响好命令)', illegal);

  const over = compileMonarchOrders(s.civ, s.play.year, me.id, [
    { kind: 'halt' },
    { kind: 'protect' },
    { kind: 'boost', mul: 3 },
    { kind: 'policy', preset: 'hold' },
  ]);
  ok(over.commands.length === 3 && over.rejected.length === 1, '超过每回合上限只收前 3 条', over);

  // 配置 mock 君主:接管前 2 个大国
  const setup = setupMonarch(s, { polities: 2, mock: true, maxOrders: 3 });
  ok(setup.monarchs.length === 2, '配置接管 2 个大国', setup.monarchs);
  ok(setup.config.mock === true, '配置记录 mock=true', setup.config);
  const status = monarchStatus(s);
  ok(status?.configured !== undefined && status?.monarchRounds === 0, '状态显示已配置、0 回合', status);

  // 回合 1
  const round1 = await monarchRound(s);
  ok(round1.round === 1 && round1.fromYear === 1200 && round1.toYear === 1205, '第 1 回合推 1200→1205', round1);
  ok(round1.decisions.length === 2, '第 1 回合有 2 个君主决策', round1.decisions.length);
  ok(round1.decisions.every((d) => d.source === 'mock'), '全部走 mock(不联网)');
  ok(/^[0-9a-f]{16}$/.test(round1.fingerprint), '返回 16 位 civ 指纹', round1.fingerprint);
  const decisionsWithCommands = round1.decisions.filter((d) => d.commands.length > 0).length;
  ok(decisionsWithCommands >= 1, '至少一个君主下了命令', round1.decisions.map((d) => d.commands.length));
  ok(s.rounds === 1 && s.play.year === 1205, '会话回合/年份已推进', `${s.rounds}/${s.play.year}`);

  // 回合 2
  const round2 = await monarchRound(s);
  ok(round2.round === 2 && round2.toYear === 1210, '第 2 回合推 1205→1210', round2);
  ok(round2.decisions.length === 2, '第 2 回合仍有 2 个君主决策', round2.decisions.length);

  // 回放对账
  const replay = verifySession(s);
  ok(replay.ok === true, '回放对账一致(君主回合不破坏确定性)', replay);
  ok(replay.expected === replay.actual && replay.expectedYear === replay.actualYear, '重推指纹/年份相同', replay);

  // 日志文件
  const files = readdirSync(s.logDir);
  ok(files.some((f) => f.startsWith('monarch-round-')), '写下 monarch-round-*.json 日志', files);
  ok(files.includes('rounds.jsonl') && files.includes('monarch-rounds.jsonl'), '写下两份回合流水');

  // 两次独立会话同配置 → 同指纹
  const openedB = openSession({ worldId: world.id, startYear: 1200, stepYears: 5, maxRounds: 4, mode: 'monarch' });
  const sB = getSession(openedB.summary.sessionId);
  setupMonarch(sB, { polities: 2, mock: true, maxOrders: 3 });
  await monarchRound(sB);
  await monarchRound(sB);
  ok(sessionSummary(sB).fingerprint === sessionSummary(s).fingerprint, '两次独立会话(mock)两回合后指纹一致', {
    a: sessionSummary(s).fingerprint,
    b: sessionSummary(sB).fingerprint,
  });

  const briefs2 = monarchBriefList(s);
  ok(briefs2.year === 1210, '简报读的是当前年份 1210', briefs2.year);

  console.log(`\n通过 ${pass} 项,失败 ${fail} 项,用时 ${Date.now() - started} ms`);
  if (fail > 0) {
    console.log('有失败项,查看上面的 FAIL 行。');
  }
  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error('自检崩了:', e);
  process.exitCode = 1;
});
