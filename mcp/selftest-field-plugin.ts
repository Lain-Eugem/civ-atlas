/**
 * 「可配置场」自检(阶段A:铲子)。
 *
 * 验的是:
 * 1) spec 校验:合法设定过、坏 id/保留名/缺 density/坏端口/超 6 条/坏图层都拒,并给中文原因;
 * 2) 强度 0:引擎指纹与官方完全一致(不影响确定性);
 * 3) 强度 1:指纹与官方不同,同样 spec 两次独立会话逐位一致;
 * 4) 玩家自设影响口:同一个场可以接 city.capacity / war.odds / unrest.add 等,影响真的进引擎(人口/指纹变化);
 * 5) stateGet.fields/layers 元数据正确(by/id/unit/年份升序/帧数/州数/统计);
 * 6) civ_field_catalog 工具能列端口与示例,MCP 工具带 fields 能开会话;
 * 7) 图层随回合推进出现新帧;verifySession 回放一致。
 */
import { civHash, createWorld, openSession, stateGet, turnStep } from './engine';
import type { FieldView, LayerView } from './engine';
import { verifySession } from './monarch';
import { callTool } from './tools';
import {
  cleanFieldSpec,
  EXAMPLE_FIELD_SPEC,
  fieldInfluenceCatalog,
  fieldSpecProblems,
  FIELD_STRENGTH,
} from '../src/gen/civ/fieldPlugin';
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

function layerList(s: Parameters<typeof stateGet>[0]): LayerView[] {
  return (stateGet(s) as { layers?: LayerView[] }).layers ?? [];
}
function fieldList(s: Parameters<typeof stateGet>[0]): FieldView[] {
  return (stateGet(s) as { fields?: FieldView[] }).fields ?? [];
}

function cityPop(civ: { settlements: any[]; endYear: number }): number {
  const year = Math.max(0, Math.floor(civ.endYear) - 1);
  let sum = 0;
  for (const s of civ.settlements) {
    if (s.ended !== undefined && s.ended <= year) continue;
    if (s.founded > year) continue;
    sum += populationAt(s, year);
  }
  return sum;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const rec = createWorld({ seed: 7, params: { cells: 12000 } });
  console.log(`\n== 可配置场(铲子) ==(世界 ${rec.world.mesh.n} 地块,${Date.now() - t0}ms)`);

  // 1) spec 校验
  eq(fieldSpecProblems(EXAMPLE_FIELD_SPEC), [], '合法示例 spec 没有问题');
  const clean = cleanFieldSpec(EXAMPLE_FIELD_SPEC);
  eq(clean.id, 'mana', 'clean 后 id = mana');
  eq(clean.every, 5, 'clean 后 every 默认 5');
  eq(clean.strength, 1, 'clean 后 strength 默认 1');
  eq(clean.layer?.keep, 50, 'clean 后 layer.keep 默认 50');
  ok(fieldSpecProblems({ ...EXAMPLE_FIELD_SPEC, id: 'Magic' }).length > 0, '坏 id(大写)被拒');
  ok(fieldSpecProblems({ ...EXAMPLE_FIELD_SPEC, id: 'vein' }).length > 0, '保留 id vein 被拒');
  ok(fieldSpecProblems({ ...EXAMPLE_FIELD_SPEC, density: undefined }).length > 0, '缺 density 被拒');
  ok(
    fieldSpecProblems({ ...EXAMPLE_FIELD_SPEC, influences: [{ target: 'nope.x', perPoint: 1 }] }).length > 0,
    '不存在的端口被拒',
  );
  ok(
    fieldSpecProblems({
      ...EXAMPLE_FIELD_SPEC,
      influences: Array.from({ length: 7 }, () => ({ target: 'city.capacity', perPoint: 0.01 })),
    }).length > 0,
    'influences 超过 6 条被拒',
  );
  ok(
    fieldSpecProblems({ ...EXAMPLE_FIELD_SPEC, layer: { colors: ['#123456'] } }).length > 0,
    '图层颜色少于 2 个被拒',
  );
  ok(
    fieldSpecProblems({ ...EXAMPLE_FIELD_SPEC, layer: { keep: 0 } }).length > 0,
    'layer.keep 非正被拒',
  );
  let threw = false;
  try {
    cleanFieldSpec({ foo: 1 });
  } catch {
    threw = true;
  }
  ok(threw, 'cleanFieldSpec 对坏设定抛中文错误');

  const cat = fieldInfluenceCatalog();
  ok(Array.isArray(cat.ports) && cat.ports.some((p) => p.id === 'city.capacity'), 'catalog 端口含 city.capacity');
  ok(cat.ports.some((p) => p.id === 'war.odds'), 'catalog 端口含 war.odds');
  ok(cat.ports.some((p) => p.id === 'unrest.add'), 'catalog 端口含 unrest.add');
  eq(cat.strength, FIELD_STRENGTH, 'catalog 的强度档位与常量一致');
  ok(!!cat.example && typeof cat.example === 'object', 'catalog 带一份可抄的示例 spec');

  // 2) 官方基线 / 强度 0
  const base = {
    worldId: rec.id,
    startYear: 1200,
    stepYears: 50,
    maxRounds: 4,
    mode: 'auto' as const,
  };
  const plain = openSession({ ...base }).session;
  const plainHash = civHash(plain.civ);
  const plainPop = cityPop(plain.civ);
  eq(stateGet(plain).fields, [], '没开自定义场时 stateGet.fields = []');
  eq(stateGet(plain).layers, [], '没开自定义场时 stateGet.layers = []');

  const zero = openSession({
    ...base,
    fields: [{ ...EXAMPLE_FIELD_SPEC, strength: 0 }],
  }).session;
  eq(civHash(zero.civ), plainHash, '强度 0 的场不影响引擎指纹(与官方一致)');
  const zeroFields = fieldList(zero);
  ok(zeroFields.length === 1 && zeroFields[0].id === 'mana', '强度 0 时仍登记 fields = [mana]');
  const zeroLayers = layerList(zero);
  ok(zeroLayers.length === 1, '强度 0 时仍记 1 个图层');
  eq(zeroLayers[0].unit, 'region', '图层单位 = region');

  // 3) 强度 1:真影响;同 spec 两次一致
  const fieldSpec = { ...EXAMPLE_FIELD_SPEC, strength: 1, influences: [{ target: 'city.capacity', perPoint: 0.03 }] };
  const strong = openSession({ ...base, fields: [fieldSpec] }).session;
  const strongHash = civHash(strong.civ);
  ok(strongHash !== plainHash, '场启用后引擎指纹与官方不同');
  const strong2 = openSession({ ...base, fields: [fieldSpec] }).session;
  eq(civHash(strong2.civ), strongHash, '同一 spec 两次独立会话逐位一致');

  // 4) 影响真的进引擎(城容量 → 人口)
  const strongPop = cityPop(strong.civ);
  ok(strongPop > plainPop * 1.02, `场把城市总人口抬高(官方 ${plainPop.toFixed(1)} → 场 ${strongPop.toFixed(1)})`);

  // 5) fields/layers 元数据
  const view = stateGet(strong) as { fields: FieldView[]; layers: LayerView[] };
  ok(view.fields.length === 1 && view.fields[0].name === '魔脉浓度', 'stateGet.fields 带名字');
  const layer = view.layers.find((l) => l.id === 'mana');
  ok(!!layer, 'layers 里有 id = mana 的图层');
  if (layer) {
    eq(layer.unit, 'region', '图层单位是州');
    ok(layer.years.length >= 20, `图层帧数 ≥ 20(实际 ${layer.years.length})`);
    ok(layer.years.every((y, i) => i === 0 || y > layer.years[i - 1]), '图层年份严格升序');
    eq(layer.frameYear, layer.years[layer.years.length - 1], 'frameYear = 最后一帧年份');
    ok(layer.cells > 0 && layer.cells < rec.world.mesh.n, `每帧州数合理(实际 ${layer.cells})`);
    ok(!!layer.stats && Number.isFinite(layer.stats.max), '最后一帧有统计');
  }

  // 6) 回合推进:出现新帧、回放一致
  const framesBefore = layerList(strong).find((l) => l.id === 'mana')?.frameCount ?? 0;
  const step = turnStep(strong, { years: 50 });
  ok(step.round === 1, 'turnStep 后 round = 1');
  const framesAfter = layerList(strong).find((l) => l.id === 'mana')?.frameCount ?? 0;
  ok(framesAfter > framesBefore, `回合推进后图层帧数增加(${framesBefore} → ${framesAfter})`);
  const verify = verifySession(strong);
  ok(verify.ok, `verifySession 回放一致(${verify.note ?? ''})`);

  // 7) 同一个场可以接多种影响口(铲子,不是固定预设)
  const multi = openSession({
    ...base,
    fields: [
      {
        ...EXAMPLE_FIELD_SPEC,
        id: 'ley',
        name: '灵脉',
        influences: [
          { target: 'city.capacity', perPoint: 0.02 },
          { target: 'war.odds', perPoint: -0.02 },
          { target: 'unrest.add', perPoint: 0.03 },
        ],
      },
    ],
  }).session;
  ok(civHash(multi.civ) !== plainHash, '多影响口的场也真的进引擎(指纹不同)');
  const multiLayers = layerList(multi);
  ok(multiLayers.length === 1 && multiLayers[0].id === 'ley', '多影响口的场图层 = ley');

  // 8) MCP 工具
  const catalogOut = await callTool('civ_field_catalog', {});
  const catalogJson = JSON.parse(catalogOut.content[0].text) as { ports: { id: string }[]; example: unknown };
  ok(Array.isArray(catalogJson.ports) && catalogJson.ports.length > 0, 'civ_field_catalog 返回端口表');
  ok(!!catalogJson.example, 'civ_field_catalog 返回示例 spec');
  const opened = await callTool('civ_session_open', {
    worldId: rec.id,
    startYear: 1200,
    stepYears: 50,
    maxRounds: 3,
    fields: [EXAMPLE_FIELD_SPEC],
  });
  ok(!opened.isError, 'MCP civ_session_open 能带 fields 开会话');
  const summary = JSON.parse(opened.content[0].text) as { sessionId: string; fields?: string[] };
  eq(summary.fields, ['mana'], '会话 summary 带 fields = [mana]');
  const stateOut = await callTool('civ_state_get', { sessionId: summary.sessionId, chronicle: false });
  const stateJson = JSON.parse(stateOut.content[0].text) as {
    fields: { id: string }[];
    layers: { id: string; unit: string }[];
  };
  ok(stateJson.fields.length === 1 && stateJson.fields[0].id === 'mana', 'MCP stateGet.fields 正确');
  ok(stateJson.layers.length === 1 && stateJson.layers[0].unit === 'region', 'MCP stateGet.layers 正确');

  console.log(`\n共 ${pass + fail} 项:${pass} 通过,${fail} 失败,总耗时 ${Date.now() - t0}ms`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

