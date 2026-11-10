/**
 * 「按地块逐年演化的场」自检(阶段C)。
 *
 * 验的是:
 * 1) spec:unit 只能是 region/tile,默认 region,地块示例合法;
 * 2) 地块场真的走 tile 表:图层 unit = tile、每帧 = 整张图的地块数(mesh.n)、年份升序;
 * 3) strength 0:与官方引擎指纹一致;strength 1:指纹与官方不同、与同参数按州的场不同;
 * 4) 同一 spec 两次独立会话逐位一致;
 * 5) 回合推进后图层出现新帧,verifySession 回放一致;
 * 6) 世界文件那条路:splitSimLayers 把地块层写成 unit=cell,字节解回来 values = 帧数×mesh.n,validatePluginLayer 认;
 * 7) MCP 工具带地块场能开会话,stateGet.layers 返回 tile。
 */
import { civHash, createWorld, openSession, stateGet, turnStep } from './engine';
import type { LayerView } from './engine';
import { verifySession } from './monarch';
import { callTool } from './tools';
import {
  cleanFieldSpec,
  EXAMPLE_FIELD_SPEC,
  EXAMPLE_TILE_FIELD_SPEC,
  fieldSpecProblems,
} from '../src/gen/civ/fieldPlugin';
import { splitSimLayers } from '../src/gen/worldFile';
import { readPart, type SnapshotPart } from '../src/gen/snapshot';
import { validatePluginLayer } from '../src/gen/worldValidate';

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
function fieldList(s: Parameters<typeof stateGet>[0]): { id: string; name: string }[] {
  return (stateGet(s) as { fields?: { id: string; name: string }[] }).fields ?? [];
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const rec = createWorld({ seed: 7, params: { cells: 12000 } });
  const meshN = rec.world.mesh.n;
  console.log(`\n== 地块级逐年演化场 ==(世界 ${meshN} 地块,${Date.now() - t0}ms)`);

  // 1) spec
  eq(fieldSpecProblems(EXAMPLE_TILE_FIELD_SPEC), [], '地块示例 spec 没有问题');
  eq(cleanFieldSpec(EXAMPLE_TILE_FIELD_SPEC).unit, 'tile', 'clean 后 unit = tile');
  eq(cleanFieldSpec(EXAMPLE_FIELD_SPEC).unit, 'region', '不写 unit 时默认 region');
  ok(fieldSpecProblems({ ...EXAMPLE_TILE_FIELD_SPEC, unit: 'cell' }).length > 0, 'unit 只能 region/tile,cell 被拒');

  const base = {
    worldId: rec.id,
    startYear: 1200,
    stepYears: 50,
    maxRounds: 4,
    mode: 'auto' as const,
  };
  const plain = openSession({ ...base }).session;
  const plainHash = civHash(plain.civ);

  // 2) 强度 0:不影响引擎,但仍记地块图层
  const zero = openSession({ ...base, fields: [{ ...EXAMPLE_TILE_FIELD_SPEC, strength: 0 }] }).session;
  eq(civHash(zero.civ), plainHash, '地块场强度 0 不影响引擎指纹(与官方一致)');
  const zeroLayers = layerList(zero);
  const zeroLayer = zeroLayers.find((l) => l.id === 'ley');
  ok(!!zeroLayer, '强度 0 时仍记 ley 图层');
  if (zeroLayer) {
    eq(zeroLayer.unit, 'tile', '地块场图层 unit = tile');
    eq(zeroLayer.cells, meshN, '每个地块图层帧 = 整张图的地块数');
    ok(!!zeroLayer.stats && zeroLayer.stats.max > 0, '强度 0 时场值本身照常算出来(只是不影响引擎)');
  }

  // 3) 强度 1:真的走 tile 表,与官方、与按州的场都不同
  const tileSpec = { ...EXAMPLE_TILE_FIELD_SPEC, strength: 1 };
  const tile = openSession({ ...base, fields: [tileSpec] }).session;
  const tileHash = civHash(tile.civ);
  ok(tileHash !== plainHash, '地块场启用后引擎指纹与官方不同');
  const tile2 = openSession({ ...base, fields: [tileSpec] }).session;
  eq(civHash(tile2.civ), tileHash, '同一地块 spec 两次独立会话逐位一致');

  const regionSpec = { ...EXAMPLE_TILE_FIELD_SPEC, id: 'leyr', unit: 'region' as const, layer: { ...EXAMPLE_TILE_FIELD_SPEC.layer, keep: 50 } };
  const region = openSession({ ...base, fields: [regionSpec] }).session;
  ok(civHash(region.civ) !== tileHash, '同样的参数按州算与按地块算结果不同');

  // 4) 图层元数据与帧
  const layer = layerList(tile).find((l) => l.id === 'ley');
  ok(!!layer, '地块场有 leyr/ley 图层');
  if (layer) {
    eq(layer.unit, 'tile', 'stateGet 里地块图层 unit = tile');
    eq(layer.cells, meshN, 'stateGet 里每帧地块数 = mesh.n');
    ok(layer.years.length >= 3, `图层帧数合理(实际 ${layer.years.length})`);
    ok(layer.years.every((y, i) => i === 0 || y > layer.years[i - 1]), '图层年份严格升序');
    eq(layer.frameYear, layer.years[layer.years.length - 1], 'frameYear = 最后一帧年份');
    ok(!!layer.stats && Number.isFinite(layer.stats.max) && layer.stats.max > 0, '最后一帧有统计且 max > 0');
  }
  const framesBefore = layerList(tile).find((l) => l.id === 'ley')?.frameCount ?? 0;
  const step = turnStep(tile, { years: 50 });
  ok(step.round === 1, 'turnStep 后 round = 1');
  const framesAfter = layerList(tile).find((l) => l.id === 'ley')?.frameCount ?? 0;
  ok(framesAfter > framesBefore, `回合推进后地块图层出现新帧(${framesBefore} → ${framesAfter})`);
  const verify = verifySession(tile);
  ok(verify.ok, `verifySession 回放一致(${verify.note ?? ''})`);

  // 5) 世界文件那条路:地块层落盘记成 cell,长度 = 帧数×mesh.n
  const parts = (await splitSimLayers(tile.civ)).parts;
  ok(parts.length === 1, `splitSimLayers 打出 1 块图层(实际 ${parts.length})`);
  const raw = parts[0];
  if (raw) {
    const part: SnapshotPart = {
      name: raw.info.name,
      bytes: raw.info.bytes,
      sum: raw.info.sum,
      zip: raw.info.zip as SnapshotPart['zip'],
      data: raw.data as Uint8Array,
    };
    const v = (await readPart(part)) as { unit?: unknown; years?: unknown; values?: unknown };
    eq(v.unit, 'cell', '写进世界文件的单位是 cell');
    const years = v.years as number[];
    const values = v.values as Float32Array;
    eq(values.length, years.length * meshN, '解回来的 values 长度 = 帧数×mesh.n');
    let accepted = true;
    try {
      validatePluginLayer(v, { cells: meshN, regions: tile.civ.regions.count, endYear: tile.civ.endYear });
    } catch (e) {
      accepted = false;
      console.log(`    validatePluginLayer 报错:${e instanceof Error ? e.message : String(e)}`);
    }
    ok(accepted, 'validatePluginLayer 认地块(落盘 cell)图层');
  }

  // 6) MCP 工具
  const opened = await callTool('civ_session_open', {
    worldId: rec.id,
    startYear: 1200,
    stepYears: 50,
    maxRounds: 3,
    fields: [EXAMPLE_TILE_FIELD_SPEC],
  });
  ok(!opened.isError, 'MCP civ_session_open 能带地块场开会话');
  const summary = JSON.parse(opened.content[0].text) as { sessionId: string; fields?: string[] };
  eq(summary.fields, ['ley'], 'summary.fields = [ley]');
  const stateOut = await callTool('civ_state_get', { sessionId: summary.sessionId, chronicle: false });
  const stateJson = JSON.parse(stateOut.content[0].text) as { fields: { id: string }[]; layers: { id: string; unit: string; cells: number }[] };
  ok(stateJson.fields.length === 1 && fieldList(plain).length === 0, 'MCP stateGet.fields 正确(地块场)');
  const ml = stateJson.layers.find((l) => l.id === 'ley');
  ok(!!ml && ml.unit === 'tile' && ml.cells === meshN, 'MCP stateGet.layers 返回 tile、cells = mesh.n');

  console.log(`\n共 ${pass + fail} 项:${pass} 通过,${fail} 失败,总耗时 ${Date.now() - t0}ms`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
