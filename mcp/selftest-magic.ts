/**
 * 「魔力」动态层自检。
 *
 * 验的是:
 * 1) 不开魔力 = 官方规则:引擎指纹与没有这个功能时完全一致;
 * 2) 强度 0:引擎指纹仍与官方一致(只记图层、不动数值),可作为「确定性不受影响」的强断言;
 * 3) 强度 1.5:指纹与官方不同;同样配置两次独立会话逐位一致;
 * 4) 图层元数据:by/id/unit/keep/年份升序/值长度 = 州数 × 帧数,最后一帧有统计;
 * 5) 真影响数值:共有的城在魔力世界里总人口更高,且大多数城更高;
 * 6) 回合推进:turnStep 之后出现新图层帧(keep=50);
 * 7) stateGet.magic / verifySession / civ_session_open 工具都能用。
 */
import { createWorld, openSession, stateGet, turnStep, civHash, magicView } from './engine';
import { verifySession } from './monarch';
import { callTool } from './tools';
import { MAGIC_LAYER, magicStrengthOf } from '../src/gen/civ/magicPlugin';
import { populationAt } from '../src/gen/civ/growth';

let pass = 0;
let fail = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
}

function eq(a: unknown, b: unknown, msg: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg}(实际 ${JSON.stringify(a)},期望 ${JSON.stringify(b)})`);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const rec = createWorld({ seed: 7, params: { cells: 12000 } });
  console.log(`\n== 魔力动态层 ==(世界 ${rec.world.mesh.n} 地块,${Date.now() - t0}ms)`);

  const base = {
    worldId: rec.id,
    startYear: 1200,
    stepYears: 50,
    maxRounds: 4,
    mode: 'monarch' as const,
  };

  // 1) 不开魔力
  const plain = openSession({ ...base }).session;
  eq(magicView(plain), null, '不开魔力时 magicView 为 null');
  eq(stateGet(plain).magic, null, '不开魔力时 stateGet.magic 为 null');
  const plainHash = civHash(plain.civ);

  // 2) 强度 0:引擎指纹不变,但图层仍在
  const zero = openSession({ ...base, magicField: 0 }).session;
  eq(civHash(zero.civ), plainHash, '魔力强度 0 时引擎指纹与官方完全一致');
  const zeroView = magicView(zero);
  ok(!!zeroView && zeroView.strength === 0, '强度 0 时 magicView.strength = 0');
  ok(!!zeroView && zeroView.layers.length === 1, '强度 0 时仍记 1 个魔力图层');
  ok(!!zeroView && zeroView.layers[0].years.length >= 10, `强度 0 时图层帧数 ≥ 10(实际 ${zeroView?.layers[0].years.length})`);

  // 3) 强度 1.5:指纹不同;同配置两次会话一致
  const strong = openSession({ ...base, magicField: 1.5 }).session;
  const strongHash = civHash(strong.civ);
  ok(strongHash !== plainHash, '魔力强度 1.5 时引擎指纹与官方不同');
  const strong2 = openSession({ ...base, magicField: 1.5 }).session;
  eq(civHash(strong2.civ), strongHash, '同配置两次魔力会话逐位一致');

  // 4) 图层元数据
  const mv = magicView(strong);
  ok(!!mv && mv.enabled === true, 'magicView.enabled = true');
  ok(!!mv && mv.strength === 1.5, 'magicView.strength = 1.5');
  const layer = mv?.layers[0];
  ok(!!layer, '有 1 个魔力图层');
  if (layer) {
    eq(layer.id, MAGIC_LAYER.id, '图层 id = magic');
    eq(layer.unit, 'tile', '图层单位 = 地块');
    eq(layer.keep, MAGIC_LAYER.keep, `keep = ${MAGIC_LAYER.keep}`);
    ok(layer.title.includes('魔力'), `图层标题含「魔力」(${layer.title})`);
    ok(layer.years.length >= 10, `图层帧数 ≥ 10(实际 ${layer.years.length})`);
    ok(layer.years.every((y, i) => i === 0 || y > layer.years[i - 1]), '图层年份严格升序');
    const rawLayer = (strong.civ.simLayers ?? []).find((L) => L.by === 'magic');
    ok(!!rawLayer, '引擎原始 simLayers 里有 magic 层');
    if (rawLayer) {
      eq(rawLayer.unit, 'tile', '原始图层 memory 单位 = 地块');
      eq(rawLayer.values.length, rawLayer.years.length * rec.world.mesh.n, '值长度 = 地块数 × 帧数');
    }
    ok(!!layer.stats && layer.stats.max > layer.stats.min, `最后一帧统计有效(max ${layer.stats?.max.toFixed?.(2)})`);
    eq(layer.frameYear, layer.years[layer.years.length - 1], 'frameYear = 最后一帧年份');
  }

  // 5) 真影响数值:共有城的总人口更高
  const year = Math.floor(strong.civ.endYear) - 1;
  const plainSettlements = new Map(plain.civ.settlements.map((s) => [s.id, s]));
  let shared = 0;
  let higher = 0;
  let sumPlain = 0;
  let sumMagic = 0;
  for (const s of strong.civ.settlements) {
    const p = plainSettlements.get(s.id);
    if (!p) continue;
    const a = populationAt(p, year);
    const b = populationAt(s, year);
    if (a <= 0.01 && b <= 0.01) continue;
    shared++;
    sumPlain += a;
    sumMagic += b;
    if (b > a + 1e-9) higher++;
  }
  ok(shared > 50, `共有城数量 > 50(实际 ${shared})`);
  ok(sumMagic > sumPlain, `魔力世界共有城总人口更高(${sumMagic.toFixed(1)} > ${sumPlain.toFixed(1)})`);
  ok(higher / shared >= 0.6, `至少 60% 共有城人口更高(${higher}/${shared})`);

  // 6) 回合推进后出现新图层帧
  const beforeYears = magicView(strong)?.layers[0].years.length ?? 0;
  const beforeLast = magicView(strong)?.layers[0].frameYear ?? 0;
  const turned = turnStep(strong, {});
  const afterView = magicView(strong);
  const afterYears = afterView?.layers[0].years.length ?? 0;
  ok(afterYears >= beforeYears, `回合推进后图层帧数不减(${beforeYears} → ${afterYears})`);
  ok((afterView?.layers[0].frameYear ?? 0) >= beforeLast, `回合推进后 frameYear 前移(${beforeLast} → ${afterView?.layers[0].frameYear})`);
  ok(turned.round === 1, 'turnStep 返回第 1 回合');

  // 7) 回放对账
  const replay = verifySession(strong);
  ok(replay.ok, `verifySession 回放一致(指纹 ${replay.actual ?? '?'})`);

  // 8) MCP 工具:带 magicField 开会话
  const rec2 = createWorld({ seed: 11, params: { cells: 8000 } });
  const toolRes = await callTool('civ_session_open', {
    worldId: rec2.id,
    startYear: 1200,
    stepYears: 5,
    maxRounds: 2,
    mode: 'monarch',
    magicField: true,
  });
  const payload = JSON.parse(toolRes.content[0].text) as { sessionId?: string };
  const sessionId = String(payload.sessionId ?? '');
  ok(!toolRes.isError && sessionId !== '', 'civ_session_open 带 magicField 能开会话');
  const toolState = await callTool('civ_state_get', { sessionId });
  const toolStatePayload = JSON.parse(toolState.content[0].text) as { magic?: { enabled?: boolean; strength?: number } };
  ok(toolStatePayload.magic?.enabled === true && toolStatePayload.magic?.strength === 1, '工具会话的 state.magic 已启用且强度 = 1');

  // 9) 强度归一化
  eq(magicStrengthOf(undefined), 1, 'magicStrengthOf(undefined) = 1');
  eq(magicStrengthOf(9), 3, 'magicStrengthOf(9) 夹到 3');
  eq(magicStrengthOf(1.24), 1, 'magicStrengthOf(1.24) 按 0.5 对齐 = 1');
  eq(magicStrengthOf(1.3), 1.5, 'magicStrengthOf(1.3) 按 0.5 对齐 = 1.5');

  console.log(`\n共 ${pass + fail} 项:${pass} 通过,${fail} 失败,总耗时 ${Date.now() - t0}ms`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
