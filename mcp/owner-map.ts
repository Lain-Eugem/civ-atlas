/**
 * 疆域图层(无头版):逐像素归属 + 水彩罩染 + 平滑国界,和主站同一套画法。
 *
 * 主站在浏览器里画这一层(src/render/civ);沙盒查看器在 Node 里画同一张图,
 * 直接复用那三个纯函数:
 *   - pixelRegions():每个像素属于哪个州(水 = −1);
 *   - washPixels():州 → 国家的归属上水彩(手绘风是半透明罩染 + 紧贴国界的浓边);
 *   - borderLines():国界线(已 Chaikin 平滑两遍 + 手绘抖动 + 海岸断头接岸)。
 *
 * 只 import src/gen 与 src/render 的纯计算函数,不碰 DOM / canvas。
 * 第一次调用会 rasterize 一次(约 0.9 秒,之后按 World 缓存),之后每次重画约 0.1 秒。
 */
import type { World } from '../src/gen/world';
import type { Raster } from '../src/gen/raster';
import { Layer, type Civ } from '../src/gen/civ/types';
import type { CivDrawParams } from '../src/render/civ/overlay';
import { pixelRegions, washPixels } from '../src/render/civ/territory';
import { borderLines, mergeChains, regionChains } from '../src/render/civ/borders';
import { chaikin } from '../src/render/civ/lines';
import { rasterizeWindow, sphereCoverWindow, zoomSource, type ZoomSource } from '../src/gen/rasterWindow';
import { worldRaster } from './terrain';

export interface OwnerPixels {
  width: number;
  height: number;
  /** 全分辨率 RGBA(w×h×4,不预乘);水和无主像素的 alpha = 0 */
  rgba: Uint8ClampedArray;
  /** 国界线:每条是扁平的 [x0,y0,x1,y1,…],主图像素坐标(已平滑;跨 180° 的线会落到 [0,W] 之外,前端按 shift 再画一份) */
  borders: number[][];
  /** 州界线:同上格式(已 Chaikin 平滑 + RDP 抽稀);国界线之外的第二层细线,同样会落到 [0,W] 之外 */
  regions: number[][];
}

/** 找不到国家颜色时的兜底灰(查看器其它图层的无主色也用这个) */
const FALLBACK_RGB: readonly [number, number, number] = [128, 128, 128];

/**
 * 画整张疆域图(raster 的全分辨率,和底图同尺寸):返回 RGBA + 国界线。
 * 第一次调用会 rasterize 一次(worldRaster 按 World 缓存,别在别处再 rasterize)。
 */
export function renderOwnerPixels(world: World, civ: Civ): OwnerPixels {
  const raster = worldRaster(world);
  const w = raster.w;
  const h = raster.h;
  const pixRegion = pixelRegions(world.mesh, raster, civ.regions.of);
  const out = new Uint8ClampedArray(w * h * 4);
  washPixels(
    { w, h, f: 1, pixRegion, owner: civ.polity, colors: polityColors(civ), style: 'fantasy', polity: true },
    out,
  );
  return {
    width: w,
    height: h,
    rgba: out,
    borders: ownerBorderLines(world, raster, civ),
    regions: regionBorderLines(world, raster, civ),
  };
}

/** 国家 id → RGB:colors[id×3 .. id×3+2](id 不保证连续,长度按最大 id 算) */
function polityColors(civ: Civ): Uint8Array {
  let maxId = 0;
  for (const p of civ.polities) if (p.id > maxId) maxId = p.id;
  const colors = new Uint8Array((maxId + 1) * 3);
  for (let i = 0; i < colors.length; i += 3) {
    colors[i] = FALLBACK_RGB[0];
    colors[i + 1] = FALLBACK_RGB[1];
    colors[i + 2] = FALLBACK_RGB[2];
  }
  for (const p of civ.polities) {
    const c = p.color;
    colors[p.id * 3] = c[0];
    colors[p.id * 3 + 1] = c[1];
    colors[p.id * 3 + 2] = c[2];
  }
  return colors;
}

/**
 * 国界线:borderLines() 只读 p.civ / p.world / p.style / p.year / p.raster / p.thumb,
 * 其余字段(投影、显示开关…)它用不到,所以伪造一份最小的 CivDrawParams 传进去 ——
 * CivDrawParams 是给 canvas 层的类型,这里只是借用它的形状,不引入任何 canvas 代码。
 * 坐标 = 世界坐标 × raster.scale(= 1,所以就是主图像素),四舍五入到 2 位小数(JSON 小一半);
 * 跨 180° 的线坐标会落在 [0,W] 之外,前端按 wrap shift 再画一份(和主站 borders.ts 的约定一致)。
 */
function ownerBorderLines(world: World, raster: Raster, civ: Civ): number[][] {
  const fake = {
    world,
    raster,
    civ,
    style: 'fantasy',
    year: civ.endYear,
    show: {},
  } as unknown as CivDrawParams;
  return borderLines(fake, Layer.Polity)
    .filter((l) => l.pts.length >= 4)
    .map((l) => Array.from(l.pts, (v) => Math.round(v * 100) / 100));
}

/* ------------------------------------------------------------------ *
 * 州界线:每个州自己的边界(国界之外的第二层细线)
 * ------------------------------------------------------------------ */

/** 州界线平滑几轮:1 轮把网格折角抹圆就够;2 轮点数翻 4 倍,还要多抽一次,划不来 */
const REGION_SMOOTH_ROUNDS = 1;
/** 抽稀容差(主图像素):虚线只有 0.7px 宽,0.9px 的偏差看不出来,JSON 却能小一半以上 */
const REGION_SIMPLIFY_TOL = 0.9;

/** 州界线按州缓存:州不随年份变,换了历史但州没换就直接复用(和国界的 chainCache 同一个道理) */
const regionLineCache = new WeakMap<Civ['regions'], { mesh: World['mesh']; lines: number[][] }>();

/**
 * 州界线:每个州自己的边界(不含海岸线 —— 链只存在于两个陆地块之间)。
 * 做法和国界同一条链:regionChains() 里是所有「两个州之间」的网格边,给 mergeChains() 传一份
 * identity 归属表(owner[i] = i),它只跳过左右归属相同的链,于是每个州的边界都留下来,
 * 并在只有两条线相接的交汇处接成长线;再 Chaikin 平滑 + RDP 抽稀(虚线只要看得出形状),
 * 坐标 round 2 位。
 * 坐标 = 世界坐标(= 主图像素);跨 180° 的线会落到 [0,W] 之外,前端按 wrap shift 再画一份。
 */
export function regionBorderLines(world: World, raster: Raster, civ: Civ): number[][] {
  void raster; // 坐标本来就是主图像素(raster.scale = 1);参数和 ownerBorderLines 对齐,以后换倍率时再用
  const hit = regionLineCache.get(civ.regions);
  if (hit && hit.mesh === world.mesh) return hit.lines;
  const rc = regionChains(world.mesh, civ);
  const owner = new Int32Array(civ.regions.count);
  for (let i = 0; i < owner.length; i++) owner[i] = i;
  const lines: number[][] = [];
  for (const merged of mergeChains(rc, owner)) {
    if (merged.pts.length < 4) continue;
    const smooth = chaikin(merged, REGION_SMOOTH_ROUNDS);
    const pts = simplifyLine(smooth.pts, REGION_SIMPLIFY_TOL);
    if (pts.length >= 4) lines.push(pts);
  }
  regionLineCache.set(civ.regions, { mesh: world.mesh, lines });
  return lines;
}

/**
 * Douglas–Peucker 抽稀:pts 是扁平 [x,y,x,y,…],返回保留点的扁平坐标(round 2 位)。
 * 首尾必留:开放的州界在交汇处不能断,环的首尾原本就差一整圈,也照样留。
 */
function simplifyLine(pts: Float32Array, tol: number): number[] {
  const m = pts.length >> 1;
  if (m < 2) return [];
  const round2 = (v: number): number => Math.round(v * 100) / 100;
  if (m === 2) return [round2(pts[0]), round2(pts[1]), round2(pts[2]), round2(pts[3])];
  const keep = new Uint8Array(m);
  keep[0] = 1;
  keep[m - 1] = 1;
  const tol2 = tol * tol;
  const stack: number[] = [0, m - 1];
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    if (b - a < 2) continue;
    const ax = pts[a * 2];
    const ay = pts[a * 2 + 1];
    const mx = pts[b * 2] - ax;
    const my = pts[b * 2 + 1] - ay;
    const len2 = mx * mx + my * my;
    let far = -1;
    let farD = -1;
    for (let i = a + 1; i < b; i++) {
      let ex = pts[i * 2] - ax;
      let ey = pts[i * 2 + 1] - ay;
      if (len2 > 0) {
        let t = (ex * mx + ey * my) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        ex -= t * mx;
        ey -= t * my;
      }
      const d2 = ex * ex + ey * ey;
      if (d2 > farD) {
        farD = d2;
        far = i;
      }
    }
    if (far >= 0 && farD > tol2) {
      keep[far] = 1;
      stack.push(a, far, far, b);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < m; i++) {
    if (!keep[i]) continue;
    out.push(round2(pts[i * 2]), round2(pts[i * 2 + 1]));
  }
  return out;
}
/* ------------------------------------------------------------------ *
 * 疆域高清瓦片:放大后按当前倍率现算一块(和地形瓦片同一套坐标)
 *
 * 整张疆域图是 1 倍主图(2048 宽)的 PNG,放大到 8 倍就是拿 256 像素宽的位图去铺屏,
 * 糊成一片。这里照 terrain.ts 的 renderTile 做:屏幕上要多大就从球面重新铺像素,
 * 再跑同一条 washPixels,所以水彩、浓边、颗粒和整张图逐像素一致(留边裁掉后无缝)。
 * ------------------------------------------------------------------ */

/** 疆域瓦片渲染要用的 Civ 数据:只留三个 TypedArray,方便丢进 worker 线程 */
export interface OwnerCivData {
  /** 州 → 国家编号(= Civ.regions.of;水 / 无主 = −1) */
  of: Int32Array;
  /** 州 → 国家编号的归属表(= Civ.polity) */
  polity: Int16Array;
  /** 国 id → RGB(colors[id×3 …]) */
  colors: Uint8Array;
}

/** 从 Civ 里抽出画疆域要用的最小数据(整张图 / 瓦片共用) */
export function ownerCivData(civ: Civ): OwnerCivData {
  return { of: civ.regions.of, polity: civ.polity, colors: polityColors(civ) };
}

/**
 * 疆域瓦片的留边(1 倍像素):washPixels 的浓边查表最远 64 像素,
 * 留 72 保证裁掉留边后每块算出来的水彩和整张图逐像素一致(拼块无缝)。
 */
const OWNER_TILE_PAD = 72;

/** zoomSource 会算河口 / 谷线 / 刻痕,约 0.6 秒;每个 World 只算一次 */
const ownerSrcCache = new WeakMap<World, ZoomSource>();
function ownerSrcOf(world: World): ZoomSource {
  let src = ownerSrcCache.get(world);
  if (!src) {
    src = zoomSource(world, worldRaster(world));
    ownerSrcCache.set(world, src);
  }
  return src;
}

/**
 * 单块疆域 RGBA。坐标约定完全照抄 terrain.ts 的 renderTile:
 * (x,y) = 这块左上角在 S 倍展开平面上的像素坐标,可以越过左右边(经度周期)、
 * 上下边(跨极点时整块镜像,奇数层),返回 size×size 的未预乘 RGBA(水 / 无主 alpha = 0)。
 * 低倍率仍用 renderOwnerPixels 的整张 PNG 兜底,两边是同一套 wash 管线。
 */
export function renderOwnerTilePixels(
  world: World,
  civ: OwnerCivData,
  S: number,
  x: number,
  y: number,
  size: number,
): OwnerPixels {
  const src = ownerSrcOf(world);
  const whole = worldRaster(world);
  const W = world.width * S;
  const H = world.height * S;
  const P = OWNER_TILE_PAD;
  const n = size + 2 * P;
  const out = new Uint8ClampedArray(size * size * 4);
  let py = 0;
  while (py < size) {
    const layer = Math.floor((y + py) / H);
    let end = py + 1;
    while (end < size && Math.floor((y + end) / H) === layer) end++;
    const segH = end - py;
    const odd = ((layer % 2) + 2) % 2 === 1;
    const ysFirst = odd ? (layer + 1) * H - (y + py) : (y + py) - layer * H;
    const ysLast = odd ? (layer + 1) * H - (y + end - 1) : (y + end - 1) - layer * H;
    const y0 = Math.min(ysFirst, ysLast);
    const xs = odd ? x - W / 2 : x;
    const xr = (((xs - P) % W) + W) % W;
    const m = segH + 2 * P;
    // 水陆 / 像素→地块 / 州→国家归属:和整张图同一条算路,只是窗口带留边
    const water = waterWindow(world, src, whole, S, xs - P, y0 - P, n, m);
    const cov = sphereCoverWindow(world, S, xr, y0 - P, n, m);
    const cell = cellsOf(world.mesh, cov);
    const pixRegion = pixelRegions(
      world.mesh,
      { w: n, h: m, water, cell } as unknown as Raster,
      civ.of,
    );
    const buf = new Uint8ClampedArray(n * m * 4);
    washPixels(
      { w: n, h: m, f: 1, pixRegion, owner: civ.polity, colors: civ.colors, style: 'fantasy', polity: true },
      buf,
    );
    for (let t = 0; t < segH; t++) {
      const srcRow = odd ? segH - 1 - t : t;
      const from = ((srcRow + P) * n + P) * 4;
      out.set(buf.subarray(from, from + size * 4), (py + t) * size * 4);
    }
    py = end;
  }
  return { width: size, height: size, rgba: out, borders: [], regions: [] };
}

/**
 * 像素 → 最近顶点(= 地块 cell)。逐像素复刻 src/gen/raster.ts 的 sphereFill(2×10⁶ 像素实测零误差),
 * 因为 rasterizeWindow 出来的窗口 raster 的 cell 永远是空数组(它只给地形上色用)。
 */
function cellsOf(
  mesh: World['mesh'],
  cov: { tri: Int32Array; wa: Float32Array; wb: Float32Array },
): Int32Array {
  const tri = mesh.triangles;
  const N = cov.tri.length;
  const cell = new Int32Array(N);
  for (let k = 0; k < N; k++) {
    const ti = cov.tri[k] - 1;
    if (ti < 0) continue;
    const a = tri[ti * 3];
    const b = tri[ti * 3 + 1];
    const c = tri[ti * 3 + 2];
    const ua = cov.wa[k];
    const ub = cov.wb[k];
    const uc = 1 - ua - ub;
    cell[k] = ua >= ub ? (ua >= uc ? a : c) : ub >= uc ? b : c;
  }
  return cell;
}

/**
 * 窗口内的水陆(1 = 水,0 = 陆)。
 * 精确的 S 级水陆要把 rasterizeWindow 的整条地形上色管线跑一遍(656² 窗口 0.3–1.2 秒),
 * 这里只用水陆,所以按「高低倍率水陆近似不变」取低倍率再双线性放大:
 *   S ≤ 2 → 直接拿整张 1 倍水陆图取样(免费);
 *   S ≥ 4 → 在 2 倍平面 rasterizeWindow 一个小窗口(20–280 毫秒)。
 * 实测水彩 alpha 与 S 级精确水陆只差 0.0%–0.2%(沿岸 1–2 像素),和地形海岸严丝合缝。
 */
function waterWindow(
  world: World,
  src: ZoomSource,
  whole: Raster,
  S: number,
  x0: number,
  y0: number,
  n: number,
  m: number,
): Uint8Array {
  const Sw = S >= 4 ? 2 : 1;
  const scale = Sw / S;
  const xq0 = x0 * scale;
  const yq0 = y0 * scale;
  if (Sw === 1) {
    return sampleWater(whole.water, whole.w, whole.h, 0, 0, xq0, yq0, scale, n, m, true);
  }
  const srcW = world.width * Sw;
  const x0U = Math.floor(xq0) - 1;
  const y0U = Math.floor(yq0) - 1;
  const nw = Math.ceil((n + 2) * scale) + 3;
  const mw = Math.ceil((m + 2) * scale) + 3;
  const r = rasterizeWindow(src, Sw, ((x0U % srcW) + srcW) % srcW, y0U, nw, mw);
  return sampleWater(r.water, r.w, r.h, x0U, y0U, xq0, yq0, scale, n, m, false);
}

/**
 * 双线性取水陆:data 是源平面的 water(≠0 就算水);
 * (x0U, y0U) = 源窗口第 0 列 / 行对应的未 wrap 坐标;wrapX 时列按世界周期绕回,行永远夹在两极。
 */
function sampleWater(
  data: ArrayLike<number>,
  w: number,
  h: number,
  x0U: number,
  y0U: number,
  xq0: number,
  yq0: number,
  scale: number,
  n: number,
  m: number,
  wrapX: boolean,
): Uint8Array {
  const out = new Uint8Array(n * m);
  for (let y = 0; y < m; y++) {
    const qy = yq0 + (y + 0.5) * scale - 0.5 - y0U;
    let y1 = Math.floor(qy);
    const fy = qy - y1;
    const r1 = y1 < 0 ? 0 : y1 > h - 1 ? h - 1 : y1;
    const r2 = r1 + 1 > h - 1 ? h - 1 : r1 + 1;
    for (let x = 0; x < n; x++) {
      const qx = xq0 + (x + 0.5) * scale - 0.5 - x0U;
      let x1 = Math.floor(qx);
      const fx = qx - x1;
      let x2: number;
      if (wrapX) {
        x1 = ((x1 % w) + w) % w;
        x2 = (x1 + 1) % w;
      } else {
        x1 = x1 < 0 ? 0 : x1 > w - 1 ? w - 1 : x1;
        x2 = x1 + 1 > w - 1 ? w - 1 : x1 + 1;
      }
      const a = data[r1 * w + x1] > 0 ? 1 : 0;
      const b = data[r1 * w + x2] > 0 ? 1 : 0;
      const c = data[r2 * w + x1] > 0 ? 1 : 0;
      const d = data[r2 * w + x2] > 0 ? 1 : 0;
      out[y * n + x] = (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy > 0.5 ? 1 : 0;
    }
  }
  return out;
}