/**
 * 探针:验证「无头推演 + 逐年停下 + 下命令 + 接着推」这条 demo 地基能跑通。
 * 用法:node ai-ruler/.build/ai-ruler/probe.js [起始年] [种子]
 */
import { DEFAULT_PARAMS, generateWorld } from '../src/gen/world';
import { DEFAULT_CIV_PARAMS, type Civ } from '../src/gen/civ';
import { playState } from '../src/gen/edits';
import { playCiv, playTurn } from '../src/gen/civ/play';
import { polityKey } from '../src/gen/edits';
import { polityAlive, polityName, capitalAt } from '../src/gen/civ/growth';
import { ownersAt } from '../src/gen/readers/openQuery';
import { rulerAt } from '../src/gen/civ/story/peopleInfo';

const START = Number(process.argv[2] ?? 1500);
const SEED = Number(process.argv[3] ?? 7);

function sizeOf(civ: Civ, id: number): number {
  const owners = ownersAt(civ, Math.floor(civ.endYear));
  let n = 0;
  for (let r = 0; r < owners.polity.length; r++) if (owners.polity[r] === id) n++;
  return n;
}

/** 第 years 年最能代表「一个国家」的名字和首都 */
function capitalName(civ: Civ, id: number): string {
  const p = civ.polities.find((x) => x.id === id);
  if (!p) return '?';
  const cap = capitalAt(p, civ.endYear);
  return cap === undefined ? '?' : (civ.settlements.find((s) => s.id === cap)?.name ?? `C${cap}`);
}

// 1. 世界 + 推到起始年(停在年初:那一刻的事一件还没发生)
const t0 = performance.now();
const world = generateWorld({ ...DEFAULT_PARAMS, seed: SEED });
const tGen = performance.now();
const params = { ...DEFAULT_CIV_PARAMS };
const play = playState(START, 0, []);
const civ = playCiv(world, params, play);
console.log(`世界 ${world.elevation.length} 块地 ${((tGen - t0) / 1000).toFixed(1)} 秒;推演到第 ${START} 年 ${((performance.now() - tGen) / 1000).toFixed(1)} 秒`);

// 2. 看看这年有哪些国家
const alive = civ.polities.filter((p) => polityAlive(p, civ.endYear)).map((p) => ({ p, size: sizeOf(civ, p.id) })).filter((x) => x.size > 0).sort((a, b) => b.size - a.size);
console.log(`第 ${START} 年在世国家 ${alive.length} 个:`);
for (const { p, size } of alive.slice(0, 8)) {
  const ruler = rulerAt(civ, p.id, civ.endYear);
  console.log(`  P${p.id} ${polityName(p, civ.endYear)} · ${size} 州 · 国都 ${capitalName(civ, p.id)} · 君主 ${ruler ? `${ruler.name}(倾向 ${JSON.stringify(ruler.leanings ?? {})})` : '无'}`);
}

// 3. 选中最大的那个,下一条方针 + 一条故意写错时刻的命令
const me = alive[0];
if (!me) throw new Error('没有国家,换一年或换种子');
const key = polityKey(civ, me.p.id);
const commands = [
  { kind: 'policy', from: START, a: key, preset: 'expand' },
  { kind: 'policy', from: START - 10, a: key, preset: 'hold' }, // 故意早于现在:应被拒
];
const step = playTurn(world, civ, params, play, commands, 5);
console.log(`\n一回合(5 年)后:第 ${step.play.year} 年;收下 ${step.play.commands.length} 条命令,拒收 ${step.rejected.length} 条`);
console.log(`拒收的:${JSON.stringify(step.rejected)}`);
const after = sizeOf(step.civ, me.p.id);
console.log(`我方 P${me.p.id} 州数 ${me.size} → ${after};在世 ${polityAlive(step.civ.polities.find((p) => p.id === me.p.id)!, step.civ.endYear)}`);

// 4. 再下一条,继续推,证明可以一届一届接下去
const step2 = playTurn(world, step.civ, params, step.play, [{ kind: 'policy', from: step.play.year, a: key, preset: 'hold' }], 5);
console.log(`再一回合:第 ${step2.play.year} 年;从第 ${START} 年起共 ${step2.play.commands.length} 条命令`);
console.log(`累计推演耗时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒`);

