/**
 * 放大后按屏幕现算的一块(写实风的细节,见 ui/TerrainTiles.ts):把主图上的一块按 S 像素 / 世界单位重新铺像素,
 * 结果和整张主图的 Raster 一样用(画风照常上色),只是多带 win(这一块在 S 倍主图里的位置)。
 *
 * 和整张主图同一套铺法(gen/raster.ts 的 shadeSphere),区别:
 *   - 海拔底图不重新柔化:取整张主图柔化后的海拔(1 倍),按三次 B 样条放大 —— 每一块各算各的也接得上,放大多少倍都不出台阶;
 *     海岸挪动也到整张底图上取
 *   - 沟和山脊直接算进海拔(海岸、浅海也跟着碎),另外多叠两层更细的细节噪声
 *   - 河谷连小溪也刻(gen/creeks.ts)
 *   - 海冰按整张主图铺好的冰取样(浮冰的形状和全图一样)
 *   - 河口:海岸凹出喇叭口、大河口外长出三角洲、河一定通到海,带上浑水和河水颜色(gen/estuary.ts;整张主图不画)
 * 每一块四周要多铺几个像素再裁掉(晕渲、岸线抗锯齿要用到邻居),见 rasterizeWindow 的说明。
 * 纯计算:不碰页面,worker / Node 都能跑;同一个世界、同一块,结果一样。
 */
import type { World } from './world';
import type { Mesh } from './mesh';
import type { Raster } from './raster';
import { bankBytes, carveValleys, noiseTiles, rasterBase, sampleSpline, shadeSphere, stampVeins, streamsOf, valleyLines, veinLinesOf, type SphereGrid, type ValleyLines } from './raster';
import type { DrainLines } from './pixelDrain';
import { Gullies } from './gully';
import { subSeed } from './util';
import { mouthsOf, stampEstuaries, type Mouth } from './estuary';

/** 放大现算要用的东西(每个世界准备一次,之后每一块都用它) */
export interface ZoomSource {
  seed: number;
  /** 世界宽高(世界单位)、球半径 */
  width: number;
  height: number;
  R: number;
  /** 地块间距(世界单位) */
  spacing: number;
  triangles: Uint32Array;
  /** 每个三角形三条边所在大圆的法向(朝三角形里面),9 个数 */
  nrm: Float64Array;
  /**
   * 每个三角形的经纬度范围,4 个数:上边、下边(纬度,0 = 北极 ~ 1 = 南极)、
   * 经度从 lo 到 hi(0 ~ 1 = 一整圈,hi 可以超过 1;lo = NaN = 整圈都要扫)
   */
  box: Float32Array;
  /** 三角形上的插值源(见 gen/raster.ts 的 cellPlanes) */
  planes: Float32Array;
  /** 整张主图(1 倍)柔化后的海拔 */
  base: Float32Array;
  bw: number;
  bh: number;
  /** 河和小溪的河道(刻河谷用) */
  lines: ValleyLines;
  threshold: number;
  /** 细沟(整张主图逐像素汇流串出来的,见 stampVeins) */
  veins: DrainLines;
  gullies: Gullies;
  dTile: Float32Array;
  jTile: Float32Array;
  /** 整张主图铺好的海冰(和 Raster 同名字段一样,bw × bh) */
  ice: Float32Array;
  iceConc: Uint8Array;
  iceTone: Uint8Array;
  /** 入海的河口(放大后海岸照它们凹出喇叭口、长出三角洲,见 estuary.ts) */
  mouths: Mouth[];
}

/** 准备放大现算:whole = 这个世界的整张主图(1 倍;只取海冰和细沟,细沟的线没带来就现算) */
export function zoomSource(world: World, whole: Pick<Raster, 'w' | 'h' | 'scale' | 'elev' | 'water' | 'ice' | 'iceConc' | 'iceTone' | 'bank' | 'veinLines'>): ZoomSource {
  const b = rasterBase(world, 1);
  if (whole.w !== b.w || whole.h !== b.h) throw new Error('整张主图要是 1 倍的');
  const mesh = world.mesh;
  const { nrm, box } = triangleBounds(mesh.xyz!, mesh.triangles);
  const { dTile, jTile } = noiseTiles(world.params.seed);
  const streams = streamsOf(world);
  const lines = valleyLines(streams.rivers, world.riverThreshold, world.width);
  return {
    seed: world.params.seed,
    width: world.width,
    height: world.height,
    R: world.width / (2 * Math.PI),
    spacing: mesh.spacing,
    triangles: mesh.triangles,
    nrm,
    box,
    planes: b.planes,
    base: b.elev,
    bw: b.w,
    bh: b.h,
    lines,
    mouths: mouthsOf(world, lines, whole, b.elev, b.w, b.h),
    threshold: world.riverThreshold,
    veins: whole.veinLines ?? veinLinesOf(whole, streams),
    gullies: new Gullies(subSeed(world.params.seed, 'gully')),
    dTile,
    jTile,
    ice: whole.ice,
    iceConc: whole.iceConc,
    iceTone: whole.iceTone,
  };
}

/** Raster.win:这一块在 S 倍主图(W × H)里的位置 */
export interface RasterWindow {
  x0: number;
  y0: number;
  W: number;
  H: number;
}

/**
 * 铺 S 倍主图(宽 = 世界宽 × S)上从 (x0, y0) 开始的 w × h 像素(x0 可以出左右边:东西相连)。
 * 四周的 WINDOW_PAD 个像素邻居不全,上色后要裁掉(调用方把要的那块往外各扩 WINDOW_PAD 再来铺)
 */
export function rasterizeWindow(src: ZoomSource, S: number, x0: number, y0: number, w: number, h: number): Raster & { win: RasterWindow } {
  const W = Math.round(src.width * S);
  const H = Math.round(src.height * S);
  const N = w * h;
  // 这一块每列 / 每行像素中心的经纬度
  const cosLon = new Float32Array(w);
  const sinLon = new Float32Array(w);
  const cosLat = new Float32Array(h);
  const sinLat = new Float32Array(h);
  for (let px = 0; px < w; px++) {
    const l = ((x0 + px + 0.5) / W) * 2 * Math.PI - Math.PI;
    cosLon[px] = Math.cos(l);
    sinLon[px] = Math.sin(l);
  }
  for (let py = 0; py < h; py++) {
    // 上下出了主图的行按贴着极点算(这些行只在要裁掉的那一圈里)
    const yy = Math.min(H - 0.5, Math.max(0.5, y0 + py + 0.5));
    const l = Math.PI / 2 - (yy / H) * Math.PI;
    cosLat[py] = Math.cos(l);
    sinLat[py] = Math.sin(l);
  }
  const g: SphereGrid = { w, h, cosLon, sinLon, cosLat, sinLat };
  const { tri, wa, wb } = coverWindow(src, W, H, x0, y0, g);

  // 海拔底图:整张主图柔化后的海拔,三次 B 样条放大
  const fx = src.bw / W;
  const fy = src.bh / H;
  const base = new Float32Array(N);
  for (let py = 0; py < h; py++) {
    const sy = (y0 + py + 0.5) * fy - 0.5;
    for (let px = 0; px < w; px++) base[py * w + px] = sampleSpline(src.base, src.bw, src.bh, (x0 + px + 0.5) * fx - 0.5, sy);
  }
  const carve = new Float32Array(N);
  const calm = new Float32Array(N);
  carveValleys(src.lines, src.threshold, S, w, h, carve, calm, x0, y0, W);

  const out: Raster & { win: RasterWindow } = {
    w,
    h,
    scale: S,
    elev: new Float32Array(N),
    temp: new Float32Array(N),
    precip: new Float32Array(N),
    water: new Uint8Array(N),
    biome: new Uint8Array(N),
    wet: new Uint8Array(N),
    cell: new Int32Array(0),
    ice: new Float32Array(N),
    iceConc: new Uint8Array(N),
    iceTone: new Uint8Array(N),
    wrap: true,
    win: { x0, y0, W, H },
  };
  const zoom = { gullies: src.gullies, base: src.base, w: src.bw, h: src.bh, x0, y0, S: W / src.bw };
  shadeSphere(out, tri, wa, wb, src.planes, base, carve, calm, src.dTile, src.jTile, g, src.R, src.spacing, null, zoom);
  stampEstuaries(out, src.mouths, src.threshold, src.width, S, x0, y0);
  out.bank = bankBytes(calm);
  out.vein = new Uint8Array(N);
  stampVeins(src.veins, S, w, h, out.vein, x0, y0, W);
  windowIce(src, out, fx, fy);
  return out;
}

/** 放大现算的一块四周要多铺、上色后裁掉的像素数 */
export const WINDOW_PAD = 4;

/** 海面像素的海冰:按整张主图铺好的冰双线性取样(冰的色调取最近的像素) */
function windowIce(src: ZoomSource, r: Raster & { win: RasterWindow }, fx: number, fy: number) {
  const { w, h, water, ice, iceConc, iceTone } = r;
  const { x0, y0 } = r.win;
  const { bw, bh } = src;
  for (let py = 0; py < h; py++) {
    let sy = (y0 + py + 0.5) * fy - 0.5;
    sy = sy < 0 ? 0 : sy > bh - 1 ? bh - 1 : sy;
    const ya = Math.floor(sy);
    const yb = ya < bh - 1 ? ya + 1 : ya;
    const ty = sy - ya;
    const ra = ya * bw;
    const rb = yb * bw;
    for (let px = 0; px < w; px++) {
      const k = py * w + px;
      if (water[k] !== 1) {
        ice[k] = 0;
        continue;
      }
      const sx = (x0 + px + 0.5) * fx - 0.5;
      const xf = Math.floor(sx);
      const tx = sx - xf;
      let xa = xf % bw;
      if (xa < 0) xa += bw;
      const xb = xa + 1 === bw ? 0 : xa + 1;
      const c = bilerp(src.iceConc, ra + xa, ra + xb, rb + xa, rb + xb, tx, ty);
      if (!(c > 0)) {
        ice[k] = 0;
        continue;
      }
      iceConc[k] = Math.round(c);
      ice[k] = bilerp(src.ice, ra + xa, ra + xb, rb + xa, rb + xb, tx, ty);
      iceTone[k] = src.iceTone[(ty < 0.5 ? ra : rb) + (tx < 0.5 ? xa : xb)];
    }
  }
}

function bilerp(a: ArrayLike<number>, i00: number, i10: number, i01: number, i11: number, tx: number, ty: number): number {
  const top = a[i00] + (a[i10] - a[i00]) * tx;
  const bot = a[i01] + (a[i11] - a[i01]) * tx;
  return top + (bot - top) * ty;
}

/**
 * 每个三角形三条边的大圆法向(朝里)和经纬度范围(和 gen/raster.ts 的 sphereCover 同一个算法,只是先存起来,
 * 每一块只扫和它相交的三角形)
 */
function triangleBounds(xyz: Float64Array | Float32Array, triangles: Uint32Array): { nrm: Float64Array; box: Float32Array } {
  const nt = triangles.length / 3;
  const nrm = new Float64Array(nt * 9);
  const box = new Float32Array(nt * 4);
  const TAU = 2 * Math.PI;
  const ext = [0, 0];
  const latOf = (z: number) => (Math.PI / 2 - Math.asin(z < -1 ? -1 : z > 1 ? 1 : z)) / Math.PI;
  for (let t = 0; t < nt; t++) {
    const a = triangles[3 * t];
    const b = triangles[3 * t + 1];
    const c = triangles[3 * t + 2];
    const ax = xyz[3 * a];
    const ay = xyz[3 * a + 1];
    const az = xyz[3 * a + 2];
    const bx = xyz[3 * b];
    const by = xyz[3 * b + 1];
    const bz = xyz[3 * b + 2];
    const cx = xyz[3 * c];
    const cy = xyz[3 * c + 1];
    const cz = xyz[3 * c + 2];
    let n1x = ay * bz - az * by;
    let n1y = az * bx - ax * bz;
    let n1z = ax * by - ay * bx;
    let n2x = by * cz - bz * cy;
    let n2y = bz * cx - bx * cz;
    let n2z = bx * cy - by * cx;
    let n3x = cy * az - cz * ay;
    let n3y = cz * ax - cx * az;
    let n3z = cx * ay - cy * ax;
    const vol = ax * n2x + ay * n2y + az * n2z;
    const o = t * 4;
    if (vol === 0) {
      // 退化的三角形:不扫
      box[o] = 2;
      box[o + 1] = -1;
      continue;
    }
    ext[0] = Math.max(az, bz, cz);
    ext[1] = Math.min(az, bz, cz);
    arcZ(ax, ay, az, bx, by, bz, n1x, n1y, n1z, ext);
    arcZ(bx, by, bz, cx, cy, cz, n2x, n2y, n2z, ext);
    arcZ(cx, cy, cz, ax, ay, az, n3x, n3y, n3z, ext);
    if (vol < 0) {
      n1x = -n1x;
      n1y = -n1y;
      n1z = -n1z;
      n2x = -n2x;
      n2y = -n2y;
      n2z = -n2z;
      n3x = -n3x;
      n3y = -n3y;
      n3z = -n3z;
    }
    const q = t * 9;
    nrm[q] = n1x;
    nrm[q + 1] = n1y;
    nrm[q + 2] = n1z;
    nrm[q + 3] = n2x;
    nrm[q + 4] = n2y;
    nrm[q + 5] = n2z;
    nrm[q + 6] = n3x;
    nrm[q + 7] = n3y;
    nrm[q + 8] = n3z;
    const north = n1z >= 0 && n2z >= 0 && n3z >= 0;
    const south = n1z <= 0 && n2z <= 0 && n3z <= 0;
    box[o] = north ? 0 : latOf(ext[0]);
    box[o + 1] = south ? 1 : latOf(ext[1]);
    box[o + 2] = NaN;
    box[o + 3] = NaN;
    if (!north && !south && Math.max(Math.abs(az), Math.abs(bz), Math.abs(cz)) < 0.999) {
      let l0 = Math.atan2(ay, ax);
      let l1 = Math.atan2(by, bx);
      let l2 = Math.atan2(cy, cx);
      if (l0 > l1) [l0, l1] = [l1, l0];
      if (l1 > l2) [l1, l2] = [l2, l1];
      if (l0 > l1) [l0, l1] = [l1, l0];
      const g1 = l1 - l0;
      const g2 = l2 - l1;
      const g3 = l0 + TAU - l2;
      const gmax = Math.max(g1, g2, g3);
      if (gmax > Math.PI * 1.1) {
        const lo = g3 === gmax ? l0 : g1 === gmax ? l1 : l2;
        const hi = g3 === gmax ? l2 : g1 === gmax ? l0 + TAU : l1 + TAU;
        box[o + 2] = (lo + Math.PI) / TAU;
        box[o + 3] = (hi + Math.PI) / TAU;
      }
    }
  }
  return { nrm, box };
}

/** 大圆弧 p → q 上 z 的最高 / 最低点(同 gen/raster.ts) */
function arcZ(px: number, py: number, pz: number, qx: number, qy: number, qz: number, nx: number, ny: number, nz: number, ext: number[]) {
  const nn = nx * nx + ny * ny + nz * nz;
  if (!(nn > 0)) return;
  const t2 = (nz * nz) / nn;
  if (t2 >= 1) return;
  const mx = -nz * nx;
  const my = -nz * ny;
  const mz = nn - nz * nz;
  const s1 = (py * mz - pz * my) * nx + (pz * mx - px * mz) * ny + (px * my - py * mx) * nz;
  const s2 = (my * qz - mz * qy) * nx + (mz * qx - mx * qz) * ny + (mx * qy - my * qx) * nz;
  const top = Math.sqrt(1 - t2);
  if (s1 >= 0 && s2 >= 0 && top > ext[0]) ext[0] = top;
  if (s1 <= 0 && s2 <= 0 && -top < ext[1]) ext[1] = -top;
}

/**
 * 这一块里每个像素在哪个球面三角形里、重心权重(同 sphereCover;只扫经纬度范围和这一块相交的三角形)。
 * W × H = S 倍主图;这一块左上角在 (x0, y0)
 */
function coverWindow(src: { nrm: Float64Array; box: Float32Array }, W: number, H: number, x0: number, y0: number, g: SphereGrid) {
  const { w, h, cosLon, sinLon, cosLat, sinLat } = g;
  const { nrm, box } = src;
  const N = w * h;
  const tri = new Int32Array(N);
  const wa = new Float32Array(N);
  const wb = new Float32Array(N);
  const nt = box.length / 4;
  const yLo = y0;
  const yHi = y0 + h - 1;
  for (let t = 0; t < nt; t++) {
    const o = t * 4;
    // 行:上下边各多放一行(同 sphereCover)
    const ya = Math.max(yLo, Math.ceil(box[o] * H - 0.5) - 1);
    const yb = Math.min(yHi, Math.floor(box[o + 1] * H - 0.5) + 1);
    if (ya > yb) continue;
    const lo = box[o + 2];
    let xa: number;
    let xb: number;
    if (lo === lo) {
      xa = Math.ceil(lo * W - 0.5) - 1;
      xb = Math.floor(box[o + 3] * W - 0.5) + 1;
    } else {
      xa = x0;
      xb = x0 + w - 1;
    }
    const q = t * 9;
    const n1x = nrm[q];
    const n1y = nrm[q + 1];
    const n1z = nrm[q + 2];
    const n2x = nrm[q + 3];
    const n2y = nrm[q + 4];
    const n2z = nrm[q + 5];
    const n3x = nrm[q + 6];
    const n3y = nrm[q + 7];
    const n3z = nrm[q + 8];
    const tv = t + 1;
    for (let s = -1; s <= 1; s++) {
      // 东西相连:三角形的列范围挪一整圈再试。
      // 起止列 / 行必须是整数:cosLon / cosLat 按下标取,带小数的下标会取到 undefined,
      // 整段三角形就被静默跳过(窗口起点带小数时,瓦片底部会留下一条没铺到的横带)。
      // 这里往外取整,多算的一列 / 一行由下面的三角形内测试挡掉。
      const c0 = Math.max(0, Math.floor((lo === lo ? xa + s * W : xa) - x0));
      const c1 = Math.min(w - 1, Math.ceil((lo === lo ? xb + s * W : xb) - x0));
      if (c0 > c1 || (lo !== lo && s !== 0)) continue;
      const py0 = Math.max(0, Math.floor(ya - y0));
      const py1 = Math.min(h - 1, Math.ceil(yb - y0));
      for (let py = py0; py <= py1; py++) {
        const cl = cosLat[py];
        const sl = sinLat[py];
        const e1 = n1z * sl;
        const e2 = n2z * sl;
        const e3 = n3z * sl;
        const row = py * w;
        for (let px = c0; px <= c1; px++) {
          const qx = cl * cosLon[px];
          const qy = cl * sinLon[px];
          const dC = n1x * qx + n1y * qy + e1;
          if (dC < 0) continue;
          const dA = n2x * qx + n2y * qy + e2;
          if (dA < 0) continue;
          const dB = n3x * qx + n3y * qy + e3;
          if (dB < 0) continue;
          const sum = dA + dB + dC;
          if (!(sum > 0)) continue;
          const k = row + px;
          tri[k] = tv;
          wa[k] = dA / sum;
          wb[k] = dB / sum;
        }
      }
    }
  }
  // 没盖到的像素(应为 0):沿用左边(行首用上一行)的
  for (let k = 0; k < N; k++) {
    if (tri[k]) continue;
    const j = k % w ? k - 1 : k - w;
    if (j < 0) continue;
    tri[k] = tri[j];
    wa[k] = wa[j];
    wb[k] = wb[j];
  }
  return { tri, wa, wb };
}

const boundsCache = new WeakMap<Mesh, { nrm: Float64Array; box: Float32Array }>();

/**
 * 只算「某一块 S 倍窗口里每像素属于哪个球面三角形、重心权重多少」,不铺地形。
 * 供渲染层(如 mcp/magic-render.ts 的魔力瓦片)复用同一套球面覆盖;w×h 是块大小,
 * x0 / y0 是这一块左上角在 S 倍主图(W = 世界宽 × S)里的坐标。
 */
export function sphereCoverWindow(world: World, S: number, x0: number, y0: number, w: number, h: number): { tri: Int32Array; wa: Float32Array; wb: Float32Array } {
  const W = Math.round(world.width * S);
  const H = Math.round(world.height * S);
  const cosLon = new Float32Array(w);
  const sinLon = new Float32Array(w);
  const cosLat = new Float32Array(h);
  const sinLat = new Float32Array(h);
  for (let px = 0; px < w; px++) {
    const l = ((x0 + px + 0.5) / W) * 2 * Math.PI - Math.PI;
    cosLon[px] = Math.cos(l);
    sinLon[px] = Math.sin(l);
  }
  for (let py = 0; py < h; py++) {
    // 上下出了主图的行按贴着极点算(和 rasterizeWindow 一致)
    const yy = Math.min(H - 0.5, Math.max(0.5, y0 + py + 0.5));
    const l = Math.PI / 2 - (yy / H) * Math.PI;
    cosLat[py] = Math.cos(l);
    sinLat[py] = Math.sin(l);
  }
  const mesh = world.mesh;
  let b = boundsCache.get(mesh);
  if (!b) {
    b = triangleBounds(mesh.xyz!, mesh.triangles);
    boundsCache.set(mesh, b);
  }
  return coverWindow(b, W, H, x0, y0, { w, h, cosLon, sinLon, cosLat, sinLat });
}
