/**
 * 地区悬停信息:世界主图像素 (x, y) → 那个像素所属的州,以及这个州的状态
 * (所属国 / 群落 / 面积 / 人口上限 / 海拔 / 治所 / 河流)。
 *
 * 只 import src/gen 与 src/render 的纯计算函数,不碰 DOM / canvas:
 *   - worldRaster() + pixelRegions():像素 → 州(和疆域图上色同一套,水 = −1);
 *   - Civ.regions 的州级字段(面积、承载力、群落、海拔、治所……);
 *   - Civ.polity[州] → 国家编号,polityName() 取当年的国名;
 *   - riverCellsByRegion():本州河道读数(没河 = null)。
 *
 * 两个索引都按 World / Regions 缓存:
 *   - 第一次调用会 rasterize 一次(约 0.9 秒;worldRaster 按 World 缓存,和地形/疆域图层共用),
 *     然后 pixelRegions() 扫一遍全图(2048×1024 像素)建"像素 → 州"表;
 *   - 之后每次查一个像素是 O(1),悬停可以 100 次/秒地查。
 */
import type { World } from '../src/gen/world';
import type { Raster } from '../src/gen/raster';
import type { Civ } from '../src/gen/civ/types';
import { BIOMES } from '../src/gen/biomes';
import { polityName } from '../src/gen/civ/growth';
import { regionLabel } from '../src/gen/civ/story/display';
import { pixelRegions } from '../src/render/civ/territory';
import { worldRaster } from './terrain';
import { riverCellsByRegion } from './rivers-data';

export interface RegionInfo {
  /** 州编号(0 起;和 OwnerPixels 里 regionBorderLines 的州号一致) */
  region: number;
  /** 显示用州名:用户改过 > 生成时起的 > "第 N 州"(和主站 regionLabel 同一套) */
  name: string;
  /** 所属国(endYear 时的归属;无主 = null) */
  polity: { id: number; name: string; color: string } | null;
  /** 主导群落的 Biome 枚举值 */
  biome: number;
  /** 群落中文名(BIOMES[biome].name) */
  biomeName: string;
  /** 面积(世界单位²) */
  area: number;
  /** 人口上限(承载力) */
  capacity: number;
  /** 平均海拔(米) */
  elevation: number;
  /** 治所地块编号 */
  seatCell: number;
  /** 治所城名(治所上没有城 = null) */
  seatName: string | null;
  /** 治所的河道分级:0 无河 / 1 河 / 2 大河 */
  seatTier: number;
  /** 州内地块数 */
  cells: number;
  /** 本州河道读数(没河 = null) */
  river: { cells: number; majorCells: number; lengthKm: number; maxFlux: number } | null;
}

/** 像素 → 州 的索引(raster 按 World 缓存,pixRegions 按 Regions 缓存) */
interface RegionPixelIndex {
  raster: Raster;
  pix: Int16Array;
}

const indexCache = new WeakMap<World, { raster: Raster; byRegions: WeakMap<Civ['regions'], Int16Array> }>();

/** 取世界 + 这一份州划分的"像素 → 州"表;第一次建,之后直接用 */
function regionPixelIndex(world: World, civ: Civ): RegionPixelIndex {
  const raster = worldRaster(world);
  let hit = indexCache.get(world);
  if (!hit || hit.raster !== raster) {
    hit = { raster, byRegions: new WeakMap() };
    indexCache.set(world, hit);
  }
  let pix = hit.byRegions.get(civ.regions);
  if (!pix) {
    pix = pixelRegions(world.mesh, raster, civ.regions.of);
    hit.byRegions.set(civ.regions, pix);
  }
  return { raster, pix };
}

/** 治所地块 → 城名;城名不随年份变,按 Civ 缓存(只收还在的城,故城遗址不算治所) */
const seatNameCache = new WeakMap<Civ, Map<number, string>>();
function seatNames(civ: Civ): Map<number, string> {
  let m = seatNameCache.get(civ);
  if (!m) {
    m = new Map();
    for (const s of civ.settlements) {
      if (s.ended !== undefined || !s.name) continue;
      if (!m.has(s.cell)) m.set(s.cell, s.name);
    }
    seatNameCache.set(civ, m);
  }
  return m;
}

/** [r,g,b] → '#rrggbb'(和国家颜色同一套;viewer.ts 的 hexOf 也是这么写的) */
function hexOf(c: readonly number[]): string {
  const two = (i: number): string => {
    const v = c[i];
    const n = Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0;
    return n.toString(16).padStart(2, '0');
  };
  return `#${two(0)}${two(1)}${two(2)}`;
}

/**
 * 世界主图像素 (x, y) → 这个像素所属的州的信息;像素在水上(海 / 湖)或世界外 = null。
 * x 折回 [0, W)(地图东西相连),y 夹在 [0, H-1](底边那一个像素算最后一格)。
 * 想按客户端坐标查的,先用查看器自己的 mapPointAt() 换成世界像素再进来。
 */
export function regionInfoAt(world: World, civ: Civ, x: number, y: number): RegionInfo | null {
  const { raster, pix } = regionPixelIndex(world, civ);
  const w = raster.w;
  const h = raster.h;
  const wx = Math.floor(x);
  const px = ((wx % w) + w) % w;
  const py = Math.min(h - 1, Math.floor(y));
  if (!(py >= 0)) return null;
  const region = pix[py * w + px];
  if (!(region >= 0) || region >= civ.regions.count) return null;

  const regions = civ.regions;
  const polities = civ.polities;
  const pid = civ.polity[region];
  const pol = pid >= 0 && pid < polities.length ? polities[pid] : undefined;
  const polity = pol && pid >= 0 ? { id: pid, name: polityName(pol, civ.endYear), color: hexOf(pol.color) } : null;

  const bi = regions.biome[region];
  const biomeName = BIOMES[bi]?.name ?? '';
  const seatCell = regions.seat[region];
  const riverInfo = riverCellsByRegion(world, regions)[region];
  const riverCells = riverInfo ? riverInfo.cells : 0;

  return {
    region,
    name: regionLabel(civ, region),
    polity,
    biome: bi,
    biomeName,
    area: Math.round(regions.area[region]),
    capacity: Math.round(regions.capacity[region]),
    elevation: Math.round(regions.elevation[region]),
    seatCell,
    seatName: seatNames(civ).get(seatCell) ?? null,
    seatTier: riverInfo ? riverInfo.seatTier : 0,
    cells: regions.cellStart[region + 1] - regions.cellStart[region],
    river:
      riverCells > 0
        ? {
            cells: riverCells,
            majorCells: riverInfo.majorCells,
            lengthKm: riverInfo.lengthKm,
            maxFlux: Math.round(riverInfo.maxFlux),
          }
        : null,
  };
}

export interface RegionIndexStats {
  /** 州数 */
  regions: number;
  /** 州划分覆盖的地块数 */
  cells: number;
  /** "像素 → 州"表的像素数(构建耗时主要在这里) */
  pixels: number;
  /** 有主的州数 */
  owned: number;
  /** 有名字的州数 */
  named: number;
}

/**
 * 索引统计:顺便把索引建好(Lead 的 /api/map/region-info?warm=1 或预热用)。
 * 第一次调用会 rasterize + 扫全图,要几百毫秒到 1 秒;之后是 O(州数)。
 */
export function regionIndexStats(world: World, civ: Civ): RegionIndexStats {
  const { raster } = regionPixelIndex(world, civ);
  const regions = civ.regions;
  let owned = 0;
  let named = 0;
  for (let r = 0; r < regions.count; r++) {
    if (civ.polity[r] >= 0) owned++;
    if (regionLabel(civ, r) !== `第 ${r + 1} 州`) named++;
  }
  return { regions: regions.count, cells: regions.cellStart[regions.count], pixels: raster.w * raster.h, owned, named };
}
