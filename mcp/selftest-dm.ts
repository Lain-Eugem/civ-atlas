/**
 * DM 规则预设自检:
 * - dmPresetInfo:默认 7 项、换算出的 knobs、覆盖项
 * - 打开 dmPreset 的会话与官方规则会话结果不同(引擎自动战争/分裂/结盟被压低)
 * - 同一 DM 预设两次独立会话最终指纹一致(没有引入不确定性)
 * - civ_dm_preset 工具返回默认值/覆盖值
 *
 * 运行: node mcp/.build/mcp/selftest-dm.js
 */
import { createWorld, getSession, openSession, stateGet, turnStep, type Session } from './engine';
import { dmPresetInfo } from '../src/gen/civ/dm';
import { callTool } from './tools';

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

type Knobs = Record<string, Record<string, unknown>>;

const SEED = 7;
const START = 1200;
const ROUNDS = 4;
const STEP = 5;

function run(worldId: string, dmPreset: boolean | undefined): { fps: string[]; year: number; s: Session } {
  const opened = openSession({ worldId, startYear: START, stepYears: STEP, maxRounds: ROUNDS, dmPreset });
  const s = getSession(opened.session.id);
  const fps: string[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    turnStep(s, { years: STEP });
    fps.push(stateGet(s).fingerprint as string);
  }
  return { fps, year: s.play.year, s };
}

async function main(): Promise<void> {
  console.log('== civ-atlas DM 规则预设自检 ==');
  const started = Date.now();

  // 预设内容
  const info = dmPresetInfo();
  ok(info.name === 'DM 沙盒', '预设名', info.name);
  ok(info.items.length === 7, '默认 7 项规则', info.items.length);
  ok(info.values['war.odds'] === 0.5, 'war.odds 默认 ×0.5', info.values['war.odds']);
  ok(info.values['war.truce'] === 10, 'war.truce 默认 10 年', info.values['war.truce']);
  const knobs = (info.knobs ?? {}) as Knobs;
  ok(Object.keys(knobs).length >= 3, 'DM knobs 至少 3 张表', Object.keys(knobs));
  ok(knobs.wars?.TRUCE === 10, '换算到 wars.TRUCE = 10', knobs.wars?.TRUCE);
  ok(knobs.wars?.REST === 2, '换算到 wars.REST = 2', knobs.wars?.REST);

  const over = dmPresetInfo({ 'war.odds': 0.25 });
  ok(over.values['war.odds'] === 0.25, '覆盖项生效(war.odds=0.25)', over.values['war.odds']);
  ok(info.values['war.odds'] === 0.5, '覆盖项不改默认值', info.values['war.odds']);

  // 推演效果与确定性
  const world = createWorld({ seed: SEED, params: { cells: 12000 } });
  ok(!!world.id, 'civ_world_create', world.id);

  const official = run(world.id, undefined);
  const dm1 = run(world.id, true);
  const dm2 = run(world.id, true);
  ok(official.year === START + ROUNDS * STEP, '官方规则会话推到目标年', official.year);
  ok(dm1.year === START + ROUNDS * STEP, 'DM 会话推到目标年', dm1.year);
  ok(official.fps[ROUNDS - 1] !== dm1.fps[ROUNDS - 1], 'DM 预设改变推演结果', {
    official: official.fps[ROUNDS - 1],
    dm: dm1.fps[ROUNDS - 1],
  });
  ok(dm1.fps[ROUNDS - 1] === dm2.fps[ROUNDS - 1], '同一 DM 预设两次独立会话结果一致', {
    a: dm1.fps[ROUNDS - 1],
    b: dm2.fps[ROUNDS - 1],
  });
  ok(
    JSON.stringify(dm1.s.civParams.knobs ?? null).includes('WAR_ODDS'),
    'DM 会话的 civParams.knobs 带 wars 表',
    Object.keys((dm1.s.civParams.knobs ?? {}) as Knobs),
  );

  // MCP 工具层
  const tool = await callTool('civ_dm_preset', {});
  const parsed = JSON.parse(tool.content[0]!.text) as { name: string; items: unknown[]; values: Record<string, unknown> };
  ok(parsed.name === 'DM 沙盒' && parsed.items.length === 7, 'civ_dm_preset 工具返回 7 项', parsed.name);
  const tool2 = await callTool('civ_dm_preset', { overrides: { 'war.odds': 0.25 } });
  const parsed2 = JSON.parse(tool2.content[0]!.text) as { values: Record<string, unknown> };
  ok(parsed2.values['war.odds'] === 0.25, 'civ_dm_preset overrides 生效', parsed2.values['war.odds']);

  const ms = Date.now() - started;
  console.log(`\n${pass} 通过, ${fail} 失败, ${ms}ms`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
