/**
 * 瓦片自带海岸线自检:
 * - 合成蒙版:直线、闭合环、空图、海/湖分开
 * - 真实瓦片:renderTile 给出的折线必须落在这一块自己的水陆边界上(≤1 瓦片像素),
 *   而全局那份(1 倍底图追的)在同一块上明显更偏 —— 这正是"放大后描边对不上"的根因
 * - 折线连续(相邻点不跳)、体积可控
 *
 * 运行: node mcp/.build/mcp/selftest-coast.js
 */
import { rasterize } from '../src/gen/raster';
import { rasterizeWindow, zoomSource } from '../src/gen/rasterWindow';
import { generateWorld, DEFAULT_PARAMS } from '../src/gen/world';
import { traceMaskValue } from './coast-trace';
import { renderTile, renderVectors } from './terrain';

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

function synthetic(): void {
  const n = 32;
  const half = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (x >= 16) half[y * n + x] = 1;
  const lines = traceMaskValue(half, n, 1);
  ok(lines.length === 1, '直线蒙版 → 一条折线', lines.length);
  const l0 = lines[0] ?? [];
  const xs = [];
  for (let i = 0; i < l0.length; i += 2) xs.push(l0[i]);
  ok(xs.every((x) => Math.abs(x - 15.5) < 0.6), '直线位置在 x ≈ 15.5(像素中心之间)', xs.slice(0, 4));
  ok(l0.length / 2 >= 2, '折线至少两个点', l0.length / 2);

  const ring = new Uint8Array(n * n);
  for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) ring[y * n + x] = 1;
  const loops = traceMaskValue(ring, n, 1);
  ok(loops.length === 1, '空心方块 → 一个闭合环', loops.length);
  const r0 = loops[0] ?? [];
  ok(
    r0.length > 8 && Math.abs(r0[0] - r0[r0.length - 2]) < 0.15 && Math.abs(r0[1] - r0[r0.length - 1]) < 0.15,
    '闭合环首尾相接',
    [r0[0], r0[1], r0[r0.length - 2], r0[r0.length - 1]],
  );

  ok(traceMaskValue(new Uint8Array(n * n), n, 1).length === 0, '全陆地 → 没有线');

  const mixed = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (x >= 16) mixed[y * n + x] = 1;
  for (let y = 12; y < 16; y++) for (let x = 20; x < 24; x++) mixed[y * n + x] = 2;
  ok(traceMaskValue(mixed, n, 1).length === 2, '海(1)与湖(2)分开追:海是"外圈 + 湖挖的洞"两条', traceMaskValue(mixed, n, 1).length);
  ok(traceMaskValue(mixed, n, 2).length >= 1, '湖(2)单独追得到环', traceMaskValue(mixed, n, 2).length);
}

function realTile(): void {
  const world = generateWorld({ ...DEFAULT_PARAMS, seed: 7, cells: 12000 });
  const S = 8;
  const size = 512;
  const bx0 = 1344;
  const by0 = 384;
  const t0 = Date.now();
  const map = renderTile(world, 'fantasy', S, bx0 * S, by0 * S, size);
  const ms = Date.now() - t0;
  ok(map.sea.length > 0, '瓦片带回了海岸线', { lines: map.sea.length, ms });

  const pts: number[] = [];
  for (const line of map.sea) for (let i = 0; i < line.length; i += 2) pts.push(line[i], line[i + 1]);
  ok(pts.length > 100, '海岸线点数合理', pts.length / 2);

  // 抽稀会把笔直的一段压成两个端点,所以不能拿"相邻点间距"当连续性指标;
  // 这里检查坐标没有跑飞(0..size 之外一点点可以,那是 pad)
  let far = 0;
  for (const line of [...map.sea, ...map.lake]) {
    for (let i = 0; i < line.length; i += 2) {
      far = Math.max(far, Math.abs(line[i] - size / 2), Math.abs(line[i + 1] - size / 2));
    }
  }
  ok(far < size / 2 + 12, '坐标都在瓦片范围内(含 pad)', far.toFixed(1));

  // 这块自己的水陆边界
  const whole = rasterize(world, 1, false);
  const src = zoomSource(world, whole);
  const r = rasterizeWindow(src, S, bx0 * S, by0 * S, size, size);
  const bnd: number[] = [];
  for (let j = 1; j < size - 1; j++) {
    for (let i = 1; i < size - 1; i++) {
      const k = j * size + i;
      const w0 = r.water[k];
      if (r.water[k - 1] !== w0 || r.water[k + 1] !== w0 || r.water[k - size] !== w0 || r.water[k + size] !== w0) {
        bnd.push(i, j);
      }
    }
  }
  const dist = (px: number, py: number): number => {
    let m = Infinity;
    for (let i = 0; i < bnd.length; i += 2) {
      const d = (bnd[i] - px) ** 2 + (bnd[i + 1] - py) ** 2;
      if (d < m) m = d;
    }
    return Math.sqrt(m);
  };
  const stats = (list: number[][]): { mean: number; p90: number; max: number } => {
    const d: number[] = [];
    for (const line of list) {
      for (let i = 0; i + 1 < line.length; i += 2) {
        const x = line[i];
        const y = line[i + 1];
        if (x < 2 || y < 2 || x > size - 2 || y > size - 2) continue;
        const v = dist(x, y);
        if (Number.isFinite(v)) d.push(v);
      }
    }
    d.sort((a, b) => a - b);
    const q = (p: number) => (d.length ? d[Math.min(d.length - 1, Math.floor(p * d.length))] : 0);
    return { mean: d.reduce((a, b) => a + b, 0) / Math.max(1, d.length), p90: q(0.9), max: d[d.length - 1] ?? 0 };
  };
  const mine = stats(map.sea);

  // 全局那份(1 倍底图上追的)换算到这块里
  const vec = renderVectors(world);
  const global: number[][] = [];
  for (const line of vec.coastFine) {
    const out: number[] = [];
    for (let i = 0; i + 1 < line.length; i += 2) {
      out.push(line[i] * S - bx0 * S, line[i + 1] * S - by0 * S);
    }
    if (out.length >= 4) global.push(out);
  }
  const old = stats(global);

  ok(mine.mean <= 1 && mine.p90 <= 1.5, '本块自带的线贴着自己的水陆边界(≤1 瓦片像素)', mine);
  ok(mine.mean < old.mean * 0.75, '明显好于全局那份(1 倍底图追的)', { 本块: mine, 全局: old });

  const kb = JSON.stringify({ sea: map.sea, lake: map.lake }).length / 1024;
  ok(kb < 80, '单块海岸线 JSON < 80 KB(抽稀后)', Math.round(kb));
}

/**
 * 窗口起点带小数时不能漏行。
 *
 * `coverWindow` 的三角形扫描用 `cosLat[py]` / `cosLon[px]` 取值,下标必须是整数;
 * 瓦片坐标 `(x - pad) % W` 里的 W 不是整数,起点会算出 3067.999…,于是整段三角形
 * 被静默跳过 —— 表现为瓦片里一条横带完全没有地形(水陆图退化成一整片"陆地"),
 * 前端就会在那儿画出一条笔直的海岸线。这里直接盯这个症状。
 */
function fractionalOrigin(): void {
  const world = generateWorld({ ...DEFAULT_PARAMS, seed: 7, cells: 12000 });
  const S = Math.SQRT2 * 2;
  const size = 512;
  const P = 4;
  const n = size + 2 * P;
  const whole = rasterize(world, 1, false);
  const src = zoomSource(world, whole);

  const gaps = (x0: number, y0: number): number => {
    const r = rasterizeWindow(src, S, x0, y0, n, n);
    let bad = 0;
    for (let y = 0; y < n; y++) {
      let sea = 0;
      for (let x = 0; x < n; x++) if (r.water[y * n + x] === 1) sea++;
      // 整行没有海、海拔又是初始值 2 → 这一行没被任何三角形覆盖到
      if (sea === 0 && r.elev[y * n + 300] === 2) bad++;
    }
    return bad;
  };
  const x = 3072;
  const y = 1024;
  const xr = (((x - P) % (src.width * S)) + src.width * S) % (src.width * S);
  // 注意:浮点误差只有 1e-12 也足以让 cosLat[py] 取到 undefined,所以判据是"不相等",不是"差多少"
  ok(xr !== Math.round(xr), '这条用例的起点确实是小数(和 renderTile 算出来的一样)', xr);
  ok(gaps(xr, y - P) === 0, '起点带小数:没有整行漏铺', gaps(xr, y - P));
  ok(gaps(Math.round(xr), y - P) === 0, '起点取整:同样不漏', gaps(Math.round(xr), y - P));

  // 真正的症状:瓦片底部那条笔直的深色横带
  const tile = renderTile(world, 'fantasy', S, x, y, size);
  const px = tile.rgba;
  const rowLum: number[] = [];
  for (let j = 0; j < size; j++) {
    let s = 0;
    for (let i = 0; i < size; i++) {
      const k = (j * size + i) * 4;
      s += 0.299 * px[k] + 0.587 * px[k + 1] + 0.114 * px[k + 2];
    }
    rowLum.push(s / size);
  }
  const band = rowLum.map((v, i) => [i, v] as [number, number]).filter(([, v]) => v < 150);
  ok(band.length === 0, '瓦片里没有整行发黑的横带(笔直假海岸线的来源)', band.slice(0, 4));
}

function main(): void {
  const t0 = Date.now();
  synthetic();
  realTile();
  fractionalOrigin();
  const ms = Date.now() - t0;
  console.log(`\n${pass} 通过, ${fail} 失败, ${ms}ms`);
  if (fail > 0) process.exitCode = 1;
}

main();
