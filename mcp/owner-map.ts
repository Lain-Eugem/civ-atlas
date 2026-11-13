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
import { borderLines } from '../src/render/civ/borders';
import { worldRaster } from './terrain';

export interface OwnerPixels {
  width: number;
  height: number;
  /** 全分辨率 RGBA(w×h×4,不预乘);水和无主像素的 alpha = 0 */
  rgba: Uint8ClampedArray;
  /** 国界线:每条是扁平的 [x0,y0,x1,y1,…],主图像素坐标(已平滑;跨 180° 的线会落到 [0,W] 之外,前端按 shift 再画一份) */
  borders: number[][];
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
  return { width: w, height: h, rgba: out, borders: ownerBorderLines(world, raster, civ) };
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