/**
 * DM 小决策自检(不联网):
 * - 配置 mock oracle / 状态/校验
 * - 手动决策编译:饥荒(国家)、地震(州)、瘟疫(城)、小贸易(叙事)、坏决策逐条拒收、超上限
 * - mock dmRound 两回合:年份推进、天灾命令进引擎、小贸易只记叙事、日志落盘
 * - 回放对账:同一份世界 + 同一串命令重推,指纹一致
 * - 两次独立会话同配置同 mock,最终指纹一致(oracle 层没有引入不确定性)
 *
 * 运行: node mcp/.build/mcp/selftest-dm-oracle.js
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createWorld, getSession, openSession, stateGet } from './engine';
import { capitalAt, polityAlive } from '../src/gen/civ/growth';
import { polityKey, regionKey, settlementKey } from '../src/gen/edits';
import { compileDmDecisions, dmRound, dmSetup, dmStatus, hasDm } from './dm';
import { verifySession } from './monarch';

let pass = 0;
let fail = 0;

function ok(cond: boolean, name: string, detail?: unknown): void {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}`);
    if (detail !== undefined) console.log('       ' + JSON.stringify(detail).slice(0, 500));
  }
}

async function main(): Promise<void> {
  console.log('== civ-atlas DM 小决策自检(mock,不联网)==');
  const world = createWorld({ seed: 7, params: { cells: 12000 } });
  ok(!!world.id, 'civ_world_create', world.id);

  const opened = openSession({ worldId: world.id, startYear: 1200, stepYears: 5, maxRounds: 8 });
  const s = getSession(opened.summary.sessionId);
  ok(opened.summary.year === 1200, '会话停在起始年 1200', opened.summary.year);
  ok(!hasDm(s), '会话初始没有 DM 小决策');

  const state = stateGet(s);
  const alive = state.polities as { id: number; key: string; name: string; size: number }[];
  const top = alive[0]!;
  const year = Math.floor(s.play.year);
  const civ = s.civ;

  // 找一个在世国家的州/城,供天灾定位
  let regionForQuake: string | null = null;
  for (let r = 0; r < civ.regions.count; r += 1) {
    const owner = civ.polity[r];
    if (owner >= 0 && polityAlive(civ.polities[owner]!, year)) {
      regionForQuake = regionKey(civ, r);
      break;
    }
  }
  const capId = capitalAt(civ.polities[top.id]!, year);
  const capitalKey = capId >= 0 ? settlementKey(civ, capId) : null;

  // 手动决策编译
  const good = compileDmDecisions(
    civ,
    year,
    [
      { kind: 'disaster', type: 'famine', level: 2, target: { polity: `P${top.id}` }, note: '测试饥荒' },
      { kind: 'disaster', type: 'quake', level: 1, target: { region: regionForQuake }, note: '测试地震' },
      { kind: 'disaster', type: 'plague', level: 2, target: { city: capitalKey }, note: '测试瘟疫' },
      { kind: 'trade', a: `P${top.id}`, goods: '盐', outcome: 'profit', note: '测试小贸易' },
    ],
    4,
  );
  ok(good.decisions.length === 4 && good.rejected.length === 0, '4 条合法决策全部编译', good.rejected);
  ok(good.commands.length === 3, '3 条天灾编译成引擎命令(小贸易不产生命令)', good.commands.map((c) => c.kind));
  const famine = good.commands.find((c) => c.kind === 'disaster' && c.type === 'famine') as
    | { from: number; a?: string }
    | undefined;
  ok(!!famine && famine.from === year && famine.a === polityKey(civ, top.id), '饥荒 from=今年、a=国家稳定键', famine);
  const quake = good.commands.find((c) => c.kind === 'disaster' && c.type === 'quake') as { region?: string } | undefined;
  ok(!!quake?.region && quake.region === regionForQuake, '地震带上了州稳定键', quake);
  const plague = good.commands.find((c) => c.kind === 'disaster' && c.type === 'plague') as { city?: string } | undefined;
  ok(!!plague?.city && plague.city === capitalKey, '瘟疫带上了城稳定键', plague);

  const bad = compileDmDecisions(
    civ,
    year,
    [
      { kind: 'disaster', type: 'plague', level: 2 }, // 缺城
      { kind: 'disaster', type: 'quake', level: 2 }, // 缺州
      { kind: 'disaster', type: 'famine', level: 2 }, // 缺国家/州
      { kind: 'trade' }, // 缺国家
      { kind: 'war' }, // 不认识的 kind
      { kind: 'disaster', type: 'meteor', level: 2 }, // 不认识的灾种
    ],
    10,
  );
  ok(bad.commands.length === 0 && bad.rejected.length === 6, '坏决策逐条拒收', bad.rejected.map((r) => r.reason));

  const over = compileDmDecisions(civ, year, [
    { kind: 'trade', a: `P${top.id}` },
    { kind: 'trade', a: `P${top.id}` },
    { kind: 'trade', a: `P${top.id}` },
  ], 2);
  ok(over.decisions.length === 2 && over.rejected.length === 1, '超过每回合上限只收前 2 条', { d: over.decisions.length, r: over.rejected.length });

  // 配置 mock oracle
  const status0 = await dmSetup(s, { mock: true, maxDecisions: 2 });
  ok(status0.configured && status0.mode === 'mock' && status0.maxDecisions === 2, 'mock oracle 配置成功', status0);
  ok(hasDm(s), '会话已挂 DM 状态');
  const status1 = dmStatus(s);
  ok(status1.rounds === 0 && (status1.last === null || status1.last.decisions === 0), '初始回合数为 0', status1);

  // 第一回合:1200 年,1200 % 6 === 0 → mock 会给 1 条饥荒
  const r1 = await dmRound(s);
  ok(r1.source === 'mock', '第一回合来自 mock oracle', r1.source);
  ok(r1.decisions.length === 1, '第一回合给了 1 条小决策', r1.decisions.length);
  ok(r1.commands.length === 1 && r1.commands[0]!.kind === 'disaster', '天灾进了引擎命令', r1.commands);
  ok(r1.engineRejected.length === 0, '引擎没有拒收', r1.engineRejected);
  ok(r1.fromYear === 1200 && r1.toYear === 1205, '第一回合推进 1200 → 1205', [r1.fromYear, r1.toYear]);
  ok(/^[0-9a-f]{16}$/.test(r1.fingerprint), '返回 16 位指纹', r1.fingerprint);
  ok(s.play.commands.some((v) => v.kind === 'disaster' && v.from === 1200), '命令写进了会话命令表');

  // 第二回合:1205 年,1205 % 4 === 1 → mock 会给 1 条小贸易(不产生命令)
  const r2 = await dmRound(s);
  ok(r2.source === 'mock' && r2.decisions.length === 1, '第二回合给了 1 条小决策', r2.decisions.length);
  ok(r2.decisions[0]!.kind === 'trade', '第二回合是小贸易', r2.decisions[0]!.kind);
  ok(r2.commands.length === 0, '小贸易不产生引擎命令', r2.commands.length);
  ok(r2.fromYear === 1205 && r2.toYear === 1210, '第二回合推进 1205 → 1210', [r2.fromYear, r2.toYear]);

  const logDir = s.logDir;
  ok(existsSync(join(logDir, 'dm-round-0001.json')), 'dm-round-0001.json 已落盘');
  ok(existsSync(join(logDir, 'dm-round-0002.json')), 'dm-round-0002.json 已落盘');
  ok(existsSync(join(logDir, 'dm-rounds.jsonl')), 'dm-rounds.jsonl 已落盘');
  const st2 = dmStatus(s);
  ok(st2.rounds === 2, '状态里回合数 = 2', st2.rounds);

  // 回放对账
  const replay = verifySession(s);
  ok(replay.ok, '回放对账一致(同一串命令 → 同一结果)', { expected: replay.expected, actual: replay.actual });
  ok(replay.commands === s.play.commands.length, '回放命令数与会话一致', replay.commands);

  // 手动传入决策(跳过模型):再来一回合
  const r3 = await dmRound(s, { decisions: [{ kind: 'trade', a: `P${top.id}`, goods: '茶', outcome: 'neutral', note: '手动小买卖' }] });
  ok(r3.source === 'manual' && r3.decisions.length === 1 && r3.commands.length === 0, '手动 decisions 绕过模型并正常记录', r3.source);
  const replay3 = verifySession(s);
  ok(replay3.ok, '手动回合后回放仍一致');

  // 两次独立会话同配置同 mock → 最终指纹一致
  const opened2 = openSession({ worldId: world.id, startYear: 1200, stepYears: 5, maxRounds: 8 });
  const s2 = getSession(opened2.summary.sessionId);
  await dmSetup(s2, { mock: true, maxDecisions: 2 });
  await dmRound(s2);
  await dmRound(s2);
  const fp1 = (stateGet(s2).fingerprint as string) ?? '';
  const s3 = getSession(openSession({ worldId: world.id, startYear: 1200, stepYears: 5, maxRounds: 8 }).summary.sessionId);
  await dmSetup(s3, { mock: true, maxDecisions: 2 });
  await dmRound(s3);
  await dmRound(s3);
  const fp2 = (stateGet(s3).fingerprint as string) ?? '';
  ok(fp1 === fp2 && fp1.length > 0, '两次独立 mock 会话两回合后指纹一致', { fp1, fp2 });

  // 配置校验:没有 baseUrl 的 custom 服务应报错
  const opened4 = openSession({ worldId: world.id, startYear: 1300, stepYears: 5, maxRounds: 1 });
  const s4 = getSession(opened4.summary.sessionId);
  let threw = '';
  try {
    await dmSetup(s4, { provider: 'custom' });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  ok(threw.includes('baseUrl') || threw.includes('CIV_DM_BASE_URL'), 'custom 缺 baseUrl 时给出清晰报错', threw);

  console.log(`\n${fail === 0 ? '通过' : '失败'}: ${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
