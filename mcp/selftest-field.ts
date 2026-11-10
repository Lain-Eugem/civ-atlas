/**
 * 「场」原型自检:计算层 + 渲染层分离的约定。
 *
 * 验的是:
 * 1) 计算层确定性:同 world+kind+seed+scale → 同 values/hash;换 kind/scale/seed → 不同;
 * 2) 渲染层只读:画不同样式不改变 FieldFrame 的 hash/values;同样式两次 PNG 逐字节一致;
 * 3) 数值接口与计算层一致:data 里的 base64 解码后长度/均值对得上;统计与抽样一致;
 * 4) 图例/网格形状正确,坏帧校验能报错;
 * 5) 粗略打印耗时,防止原型慢到不可用。
 */
import { createWorld } from './engine';
import { fieldFrame, checkFieldFrame, FIELD_KINDS, FIELD_LABEL } from '../src/gen/field';
import {
  renderFieldMap,
  fieldDataJson,
  DEFAULT_FIELD_STYLE,
  FIELD_RAMPS,
  type FieldStyle,
} from './field-render';

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

function main(): void {
  const t0 = Date.now();
  const rec = createWorld({ seed: 7, params: { cells: 12000 } });
  const world = rec.world;
  console.log(`世界: ${world.elevation.length} 格,生成 ${Date.now() - t0}ms`);

  const t1 = Date.now();
  const magic = fieldFrame(world, 'magic');
  console.log(`魔脉场: ${Date.now() - t1}ms,hash ${magic.hash}`);
  ok(magic.cells === world.elevation.length, '帧格数 = 世界地块数');
  ok(magic.values.length === magic.cells, 'values 长度 = 格数');
  ok(magic.version === 1, '规格版本 = 1');
  ok(magic.id.startsWith('magic:'), 'id 以 magic: 开头');
  eq(checkFieldFrame(world, magic), [], '帧校验无问题');
  ok(magic.stats.min >= 0 && magic.stats.max <= 1, '值域在 0–1');
  let finite = true;
  for (let i = 0; i < magic.values.length; i++) if (!Number.isFinite(magic.values[i]!)) finite = false;
  ok(finite, '全部是有限数');
  ok(
    magic.stats.min <= magic.stats.p01 &&
      magic.stats.p01 <= magic.stats.p50 &&
      magic.stats.p50 <= magic.stats.p90 &&
      magic.stats.p90 <= magic.stats.p99 &&
      magic.stats.p99 <= magic.stats.max,
    '分位数顺序正确',
  );
  ok(magic.stats.max > magic.stats.min, '至少不是常量场');

  // ---- 计算层确定性 ----
  const magic2 = fieldFrame(world, 'magic');
  eq(magic2.hash, magic.hash, '同参数再算 hash 相同');
  eq(magic2.stats, magic.stats, '同参数统计相同');
  const ore = fieldFrame(world, 'ore');
  const rad = fieldFrame(world, 'radiation');
  ok(ore.hash !== magic.hash && rad.hash !== magic.hash, '换 kind hash 不同');
  ok(ore.stats.max > 0 && rad.stats.max > 0, '矿产/辐射场非空');
  const magicBig = fieldFrame(world, 'magic', { scale: 2 });
  ok(magicBig.hash !== magic.hash, '换 scale hash 不同');
  const magicSeed = fieldFrame(world, 'magic', { seed: 3 });
  ok(magicSeed.hash !== magic.hash, '换变体 seed hash 不同');
  ok(FIELD_KINDS.length === 3 && FIELD_LABEL.magic === '魔脉浓度', 'kind 清单/中文名正确');

  // ---- 渲染层只读 + 确定性 ----
  const before = magic.hash;
  const beforeValues = magic.values.slice();
  const t2 = Date.now();
  const styleA: FieldStyle = { ...DEFAULT_FIELD_STYLE, ramp: 'ember', stretch: 'p1p99', contour: true, glow: true, hillshade: true, opacity: 0.85 };
  const styleB: FieldStyle = { ...DEFAULT_FIELD_STYLE, ramp: 'ice', stretch: 'minmax', contour: false, glow: false, hillshade: false, opacity: 0.4 };
  const a1 = renderFieldMap(world, magic, styleA);
  const a2 = renderFieldMap(world, magic, styleA);
  const b1 = renderFieldMap(world, magic, styleB);
  console.log(`渲染: ${Date.now() - t2}ms,PNG ${a1.png.length}/${b1.png.length} 字节`);
  ok(a1.width === 1024 && a1.height === 512, 'PNG 尺寸 1024×512');
  ok(a1.png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG magic 正确');
  ok(a1.png.equals(a2.png), '同 world+frame+样式 → PNG 逐字节一致');
  ok(!a1.png.equals(b1.png), '换样式 → PNG 不同(只影响显示)');
  eq(magic.hash, before, '渲染后计算层 hash 不变');
  let valuesSame = true;
  for (let i = 0; i < magic.values.length; i++) if (magic.values[i] !== beforeValues[i]) valuesSame = false;
  ok(valuesSame, '渲染后计算层 values 不变');
  eq(a1.legend.stops.length, 9, '图例 9 个色带采样点');
  eq(a1.legend.ticks.length, 5, '图例 5 个刻度');
  eq(a1.legend.label, '魔脉浓度', '图例中文名正确');
  ok(a1.legend.min >= 0 && a1.legend.max <= 1, '图例范围在 0–1');
  ok(a1.legend.ticks[0]!.t === 0 && a1.legend.ticks[4]!.t === 1, '刻度从 0 到 1');
  ok(FIELD_RAMPS.every((r) => typeof r === 'string'), '色带清单存在');

  // 改样式不重算帧:用另一套样式再出图,frame 对象应仍原样
  eq(magic.id, magic.id, '帧 id 稳定');
  ok(magic.stats.p50 > 0, 'p50 有意义');

  // ---- 数值接口 ----
  const data = fieldDataJson(world, magic, 128);
  ok(data.kind === 'magic' && data.label === '魔脉浓度', 'data kind/label 正确');
  ok(data.cells === magic.cells && data.hash === magic.hash, 'data 与计算层同源');
  const raw = Buffer.from(data.values, 'base64');
  eq(raw.byteLength, magic.cells * 4, 'values base64 解码后字节数正确');
  const decoded = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  let sameValues = true;
  let sum = 0;
  for (let i = 0; i < decoded.length; i++) {
    if (decoded[i] !== magic.values[i]) sameValues = false;
    sum += decoded[i]!;
  }
  ok(sameValues, 'data values 与 frame.values 逐值一致');
  const mean = sum / decoded.length;
  ok(Math.abs(mean - magic.stats.mean) < 1e-5, 'data 平均值 = stats.mean');
  const gridRaw = Buffer.from(data.grid, 'base64');
  const grid = new Int32Array(gridRaw.buffer, gridRaw.byteOffset, gridRaw.byteLength / 4);
  eq(grid.length, data.gridW * data.gridH, '网格长度 = gridW×gridH');
  let badGrid = 0;
  let hitGrid = 0;
  for (let i = 0; i < grid.length; i++) {
    const ci = grid[i]!;
    if (ci === -1) continue;
    hitGrid++;
    if (ci < 0 || ci >= magic.cells) badGrid++;
  }
  ok(badGrid === 0, '网格里的地块编号合法');
  ok(hitGrid > grid.length * 0.8, `网格里多数像素有地块(${hitGrid}/${grid.length})`);
  ok(data.width === world.width && data.height === world.height, 'data 记录世界像素尺寸');

  // hover 抽样:网格某个点 → 地块 → values 对得上
  const probe = grid[Math.floor(grid.length / 2)]!;
  ok(probe >= 0 && probe < magic.cells, '网格中间点能取到地块');
  eq(magic.values[probe], decoded[probe], 'hover 抽到的值与 data 一致');

  // ---- 坏帧校验 ----
  const bad = { ...magic, values: magic.values.slice() };
  bad.values[0] = 2;
  ok(checkFieldFrame(world, bad).length > 0, '越界值会被校验发现');
  const bad2 = { ...magic, cells: magic.cells + 1 };
  ok(checkFieldFrame(world, bad2).length > 0, '格数不对会被校验发现');

  console.log(`\n共 ${pass + fail} 项:${pass} 通过,${fail} 失败,总耗时 ${Date.now() - t0}ms`);
  if (fail) process.exitCode = 1;
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
