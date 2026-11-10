/**
 * press(坚持打)自检:
 * - 控制组:2557 年巴尔金汗国打大渭共和国,引擎在 2563 年自动议和(割七州)
 * - 实验组:同一起点给攻方下 press,同一场仗打到 2579 年攻方灭掉大渭才结束
 * - 坏命令(自己打自己 / 不存在的国家键)被拒;press 命令确实进了引擎命令表
 *
 * 运行: node mcp/.build/mcp/selftest-press.js
 */
import { chronicleGet, createWorld, getSession, openSession, stateGet, submitOrders, turnStep } from './engine';

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

const SEED = 7;
const START = 2557;
/** 攻方:巴尔金汗国 */
const A = 59;
/** 守方:大渭共和国 */
const B = 1;
/** 控制组自动议和年份 */
const CONTROL_PEACE = 2563;
/** 下了 press 之后,大渭亡国、战争结束的年份 */
const PRESS_PEACE = 2579;

type PolityRow = { id: number; key: string; name: string; size: number };

function warBetween(s: Parameters<typeof chronicleGet>[0]): { year: number; end: number; text: string }[] {
  return chronicleGet(s, { kind: 'war', limit: 5000 }).entries.filter(
    (e) => e.year === START && e.polities.includes(A) && e.polities.includes(B),
  );
}

function runTo(s: Parameters<typeof chronicleGet>[0], year: number): void {
  for (let guard = 0; guard < 400 && s.play.year < year; guard++) {
    turnStep(s, { years: Math.min(5, year - s.play.year) });
  }
}

function open(worldId: string) {
  return getSession(openSession({ worldId, startYear: START, stepYears: 5, maxRounds: 400 }).session.id);
}

function politiesOf(s: Parameters<typeof chronicleGet>[0]): PolityRow[] {
  return stateGet(s).polities as PolityRow[];
}

async function main(): Promise<void> {
  console.log('== civ-atlas press(坚持打)自检 ==');
  const started = Date.now();

  const world = createWorld({ seed: SEED, params: { cells: 12000 } });
  ok(!!world.id, 'civ_world_create', world.id);

  // 控制组
  const control = open(world.id);
  ok(control.play.year === START, '控制组停在起始年', control.play.year);
  const cPolities = politiesOf(control);
  const cA = cPolities.find((p) => p.id === A);
  const cB = cPolities.find((p) => p.id === B);
  ok(!!cA?.key && !!cB?.key, '控制组能看到交战国与稳定键', { A: cA?.key, B: cB?.key });
  runTo(control, 2580);
  const controlWar = warBetween(control);
  ok(controlWar.length === 1, '控制组有一场 2557 年的仗', controlWar.length);
  ok(controlWar[0]?.end === CONTROL_PEACE, `控制组在 ${CONTROL_PEACE} 年自动议和`, controlWar[0]?.end);

  // 实验组:同一世界、同一起点,给攻方下 press
  const pressed = open(world.id);
  const pA = politiesOf(pressed).find((p) => p.id === A);
  const pB = politiesOf(pressed).find((p) => p.id === B);
  const submit = submitOrders(pressed, [{ kind: 'press', a: pA!.key, b: pB!.key }]);
  ok(submit.commands.length === 1 && submit.rejected.length === 0, 'press 命令被接收', submit.rejected);
  ok(submit.commands[0]?.kind === 'press' && submit.commands[0]?.from === START, 'press 记在今年', submit.commands[0]);
  ok(submit.queued === 1, '队列里有 1 条命令', submit.queued);

  runTo(pressed, 2620);
  const pressedWar = warBetween(pressed);
  ok(pressedWar.length === 1, '实验组仍是同一场仗', pressedWar.length);
  ok(
    pressedWar[0]?.end === PRESS_PEACE,
    `下 press 后战争拖到 ${PRESS_PEACE} 年(攻方灭国)才结束`,
    pressedWar[0],
  );
  ok(
    (pressedWar[0]?.end ?? 0) > (controlWar[0]?.end ?? 0) + 5,
    'press 明显推迟了自动议和',
    { control: controlWar[0]?.end, pressed: pressedWar[0]?.end },
  );
  ok(pressedWar[0]?.text.includes('亡'), '实验组结局是守方亡国(不是议和割地)', pressedWar[0]?.text);
  const cmds = stateGet(pressed).commands as { kind: string; from: number }[];
  ok(cmds.some((v) => v.kind === 'press' && v.from === START), 'press 命令留在会话命令表里', cmds);

  // 坏命令:自己打自己、不存在的国家键
  const reject = open(world.id);
  const rA = politiesOf(reject).find((p) => p.id === A)!;
  const bad1 = submitOrders(reject, [{ kind: 'press', a: rA.key, b: rA.key }]);
  ok(bad1.commands.length === 0 && bad1.rejected.length === 1, 'press 自己打自己被拒', bad1.rejected);
  // 键的格式不对才算坏命令;格式对但世界里没有这个国家 = 引擎里解析成 −1,不生效(和其它干预一致)
  const bad2 = submitOrders(reject, [{ kind: 'press', a: 'polity:oops' }]);
  ok(bad2.commands.length === 0 && bad2.rejected.length === 1, 'press 国家键格式不对被拒', bad2.rejected);
  const ghost = submitOrders(reject, [{ kind: 'press', a: 'polity:c99999#0' }]);
  ok(ghost.commands.length === 1 && ghost.rejected.length === 0, '格式对但不存在的国家键被接收(推演时静默不生效)', ghost);

  const ms = Date.now() - started;
  console.log(`\n${pass} 通过, ${fail} 失败, ${ms}ms`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
