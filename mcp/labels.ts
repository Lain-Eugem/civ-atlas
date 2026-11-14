/**
 * 地图文字标签层:服务端数据端(纯函数)。
 *
 * 把「世界 + 文明快照」转成一份可直接 JSON 下发的标签数组,交给 mcp/viewer/labels.js
 * 在浏览器里画(坐标换算、避让、字号、描边都在客户端)。本模块不碰 DOM、不读文件。
 *
 * 覆盖四类:
 *   1. 国名 —— civ.polities 里当年还在的国家;领土重心用 civ.polity(地区→国家)按地块均权算
 *      (跨 180° 用圆均值)。国号用 growth.polityName(p, year),与图鉴/界面同一套国号。
 *   2. 城市/聚落名 —— civ.settlements,等级按 growth.populationAt + growth.settlementRank,
 *      国都用 growth.capitalAt 认(和主站 src/render/civ/settlements.ts 的 settlementsAt 同规则)。
 *   3. 河名 —— 直接用 civ.places 里 kind='river' 的地名。这些名字是 src/gen/civ/places.ts 的
 *      findPlaces() 命名的:它把 world.rivers 在汇流处归并成干流、按河口流量挑最大的若干条再取名
 *      (取名器 src/gen/names.ts),所以正是"按 flux/长度挑前 N 条 + 上游取名器"的结果,且与主站
 *      地图一致。本模块另导出 riverCoverage() 供自查"流量前 N 的河有几条已命名"。
 *   4. 湖泊/内海名 —— civ.places 的 kind='lake'(湖泊)与 kind='sea'(海/内海/海湾/洋);
 *      又按名字后缀分洋/海/湾(同主站 kindOf)。世界数据没有 world.lakes 字段(湖只是 water===2
 *      的地块),没有 civ 时无名可取,这类标签直接不出,由 stats 报告。
 *
 * 返回 {year, w, h, count, items, stats};items 每项:
 *   t  文字
 *   x,y  世界坐标(世界单位 = 底图 1× 主图像素;本世界宽 2048,高 1024)
 *   s  字号,世界单位(同样 1× 主图像素)。客户端屏幕字号 px = s * P/mapW(再乘 relK^(g-1))
 *   k  类型: 'polity' | 'capital' | 'bigcity' | 'city' | 'town' | 'village'
 *           | 'ocean' | 'sea' | 'bay' | 'mountains' | 'desert' | 'island' | 'river' | 'lake'
 *   p  优先级(越大越先占位;沿用主站 draw.ts placeMap 的排队口径)
 *   g  字号随缩放的指数(grow):px ∝ relK^g(城名 0.3 / 国名 0.45 / 海 0.5 / 河湖 0.35)
 *   d  出现所需的最小缩放倍数(minZoom;相对默认视图的 relK)
 *   a? 旋转弧度(世界坐标 +y 向下;客户端在奇数列镜像时取反)
 *   w? 字重
 *   c? 国名的国色 '#rrggbb'(其余类型用客户端调色板)
 *
 * 数值来源:主站 src/render/labels/settlements.ts(等级/字号/优先级)、
 * src/render/civ/labels.ts(TYPE/LOOKS/MIN_ZOOM)、src/render/labels/draw.ts(REF_MAP_CSS=1300)。
 * 本仓库 src/render/labels/*.ts 与上游逐字节一致,这里只抽常量,不把渲染器整包带进 mcp 构建。
 */
import type { Civ, Place, Settlement, Year } from '../src/gen/civ/types';
import { capitalAt, polityAlive, polityName, populationAt, settlementRank } from '../src/gen/civ/growth';
import type { World } from '../src/gen/world';

/* ------------------------------------------------------------------ *
 * 常量(与主站渲染器对应关系见文件头)
 * ------------------------------------------------------------------ */

/** 主站标签字号参照的 CSS 地图宽度(render/labels/draw.ts REF_MAP_CSS) */
export const REF_MAP_CSS = 1300;
/** 主站最小可读字号(CSS px,render/labels/draw.ts MIN_LABEL_PX);客户端会再夹一次 */
export const MIN_LABEL_PX = 10.5;
/**
 * 主站字号(1300 CSS 宽地图上的 px)换算到本世界的系数:(world.width / 1300) * 0.92。
 * 0.92 是经验值:查看器默认视口 P≈1.8×世界宽,主站按 sqrt(P/1300) 长字号,这里按线性长,
 * 压 8% 让默认视图下两边看起来差不多大。
 */
const SIZE_TUNE = 0.92;

/** 聚落五级:0 村 / 1 镇 / 2 城 / 3 大城 / 4 国都(主站 render/labels/settlements.ts) */
export const SETTLEMENT_NAME_SIZE = [10.5, 10.5, 11.5, 12, 13.5] as const;
export const SETTLEMENT_NAME_MIN_ZOOM = [6, 3.2, 2, 1.3, 1] as const;
export const SETTLEMENT_NAME_PRIORITY = [20, 45, 70, 89, 100.5] as const;
export const SETTLEMENT_NAME_GROW = 0.3;
const SETTLEMENT_KIND = ['village', 'town', 'city', 'bigcity', 'capital'] as const;
const SETTLEMENT_WEIGHT = [500, 500, 600, 600, 700] as const;

/** 地名类型:字号(1300 CSS px 下按总览/放大 1.8×/放大 3× 三档)、grow、优先级(主站 civ/labels.ts TYPE) */
interface PlaceType {
  size: readonly [number, number, number];
  grow: number;
  priority: number;
}
export const PLACE_TYPE: Record<'ocean' | 'sea' | 'bay' | 'mountains' | 'desert' | 'island' | 'river' | 'lake', PlaceType> = {
  ocean: { size: [19, 16.5, 14.5], grow: 0.5, priority: 100 },
  sea: { size: [14.5, 12.5, 11.5], grow: 0.5, priority: 88 },
  bay: { size: [11.5, 11, 10.5], grow: 0.5, priority: 60 },
  mountains: { size: [13, 11.5, 10.5], grow: 0.45, priority: 92 },
  desert: { size: [13, 11.5, 10.5], grow: 0.45, priority: 84 },
  island: { size: [12, 11, 10.5], grow: 0.4, priority: 80 },
  river: { size: [11.5, 11, 10.5], grow: 0.35, priority: 76 },
  lake: { size: [11.5, 11, 10.5], grow: 0.35, priority: 72 },
};
/** rank 1/2/3 → 从哪一级缩放开始显示(主站 civ/labels.ts MIN_ZOOM) */
export const PLACE_MIN_ZOOM = [1, 1, 1.8] as const;
const PLACE_WEIGHT = 500;

/** 一个世界最多带多少条城名(按等级/人口从大到小取),其余由 stats.droppedSettlements 报告 */
const DEFAULT_MAX_SETTLEMENTS = 1600;

/* ------------------------------------------------------------------ *
 * 类型
 * ------------------------------------------------------------------ */

export type LabelKind =
  | 'polity'
  | 'capital'
  | 'bigcity'
  | 'city'
  | 'town'
  | 'village'
  | 'ocean'
  | 'sea'
  | 'bay'
  | 'mountains'
  | 'desert'
  | 'island'
  | 'river'
  | 'lake';

export interface MapLabel {
  t: string;
  x: number;
  y: number;
  s: number;
  k: LabelKind;
  p: number;
  g: number;
  d: number;
  a?: number;
  w?: number;
  c?: string;
}

export interface LabelStats {
  /** 显示年份 */
  year: number;
  /** 国名条数 */
  polities: number;
  /** 城名条数(含国都) */
  settlements: number;
  /** 地名条数(河/湖/海/山/漠/岛) */
  places: number;
  rivers: number;
  lakes: number;
  seas: number;
  mountains: number;
  deserts: number;
  islands: number;
  /** 因 maxSettlements 上限被截掉的城 */
  droppedSettlements: number;
  /** 被跳过的国家(没有领土/没有国号) */
  droppedPolities: number;
}

export interface LabelMap {
  year: number;
  /** 世界宽(世界单位;标签 x 的取值范围) */
  w: number;
  /** 世界高(世界单位;标签 y 的取值范围) */
  h: number;
  /** items.length */
  count: number;
  items: MapLabel[];
  stats: LabelStats;
}

export interface LabelOptions {
  /** 显示年份,默认 civ.endYear(与 session 里这份文明快照同一时刻) */
  year?: number;
  /** 城名上限(按等级/人口从大到小取),默认 1600;Infinity = 不限 */
  maxSettlements?: number;
  /** 是否出山川湖海地名,默认 true */
  geography?: boolean;
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

const r1 = (v: number): number => Math.round(v * 10) / 10;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function hexOf(rgb: readonly number[] | undefined): string | undefined {
  if (!rgb || rgb.length < 3) return undefined;
  const h = (v: number): string => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${h(rgb[0])}${h(rgb[1])}${h(rgb[2])}`;
}

/** 折线弧长中点 + 切线角(世界坐标,+y 向下);角度归一到 [-π/2, π/2] 让字不倒着写 */
function pathAnchor(path: ArrayLike<number> | undefined): { x: number; y: number; a: number } | null {
  if (!path || path.length < 2) return null;
  const n = Math.floor(path.length / 2);
  if (n === 1) return { x: path[0], y: path[1], a: 0 };
  const seg = new Float64Array(n - 1);
  let total = 0;
  for (let i = 0; i < n - 1; i++) {
    const dx = path[2 * i + 2] - path[2 * i];
    const dy = path[2 * i + 3] - path[2 * i + 1];
    const l = Math.hypot(dx, dy);
    seg[i] = l;
    total += l;
  }
  if (!(total > 0)) return { x: path[0], y: path[1], a: 0 };
  let half = total / 2;
  let i = 0;
  while (i < n - 2 && half > seg[i]) {
    half -= seg[i];
    i++;
  }
  const dx = path[2 * i + 2] - path[2 * i];
  const dy = path[2 * i + 3] - path[2 * i + 1];
  const l = seg[i] || 1;
  const t = clamp(half / l, 0, 1);
  const x = path[2 * i] + dx * t;
  const y = path[2 * i + 1] + dy * t;
  let a = Math.atan2(dy, dx);
  if (a > Math.PI / 2) a -= Math.PI;
  else if (a < -Math.PI / 2) a += Math.PI;
  return { x, y, a };
}

/* ------------------------------------------------------------------ *
 * 国名:领土重心 + 国号 + 国色
 * ------------------------------------------------------------------ */

interface Territory {
  regions: number;
  area: number;
  /** 地块数与圆均值用的累加 */
  n: number;
  cos: number;
  sin: number;
  /** 非跨缝时的普通均值(与圆均值互相校验:跨缝时直角均值不可用) */
  sumX: number;
  minY: number;
  maxY: number;
}

function newTerritory(): Territory {
  return { regions: 0, area: 0, n: 0, cos: 0, sin: 0, sumX: 0, minY: Infinity, maxY: -Infinity };
}

/**
 * 每个国家在 civ.polity(地区→国家)里的领土聚合:面积、跨 180° 的圆均值重心。
 * 世界坐标 y 就是底图行号(0 = 北极,向下增大),x 跨 180° 会从 2047 跳回 0,
 * 所以 x 走圆均值:把 x 看成 2πx/W 的角度取平均。
 */
function territoriesOf(world: World, civ: Civ): Map<number, Territory> {
  const out = new Map<number, Territory>();
  const regions = civ.regions;
  const mesh = world.mesh;
  const W = world.width || 2048;
  const TAU = Math.PI * 2;
  for (let r = 0; r < regions.count; r++) {
    const id = civ.polity[r];
    if (id === undefined || id < 0) continue;
    let t = out.get(id);
    if (!t) {
      t = newTerritory();
      out.set(id, t);
    }
    t.regions += 1;
    t.area += regions.area[r] ?? 0;
    const start = regions.cellStart[r];
    const end = regions.cellStart[r + 1];
    for (let ci = start; ci < end; ci++) {
      const cell = regions.cells[ci];
      if (cell < 0 || cell >= mesh.n) continue;
      const x = mesh.x[cell];
      const y = mesh.y[cell];
      t.n += 1;
      t.sumX += x;
      t.cos += Math.cos((TAU * x) / W);
      t.sin += Math.sin((TAU * x) / W);
      if (y < t.minY) t.minY = y;
      if (y > t.maxY) t.maxY = y;
    }
  }
  return out;
}

/** 领土重心(跨 180° 的圆均值);领土为空返回 null */
function territoryCenter(t: Territory, W: number): { x: number; y: number } | null {
  if (t.n <= 0) return null;
  // 直角均值与圆均值的差:领土不跨缝时用直角均值(更稳),跨缝时圆均值才对
  const plainX = t.sumX / t.n;
  const cyc = Math.atan2(t.sin / t.n, t.cos / t.n);
  const circX = ((cyc / (Math.PI * 2)) * W + W) % W;
  const span = Math.abs(plainX - circX);
  const x = Math.min(span, W - span) < W * 0.25 ? plainX : circX;
  const y = (t.minY + t.maxY) / 2;
  return { x, y };
}

function polityLabels(world: World, civ: Civ, year: Year): { items: MapLabel[]; dropped: number } {
  const items: MapLabel[] = [];
  let dropped = 0;
  const W = world.width || 2048;
  const H = world.height || 1024;
  const mesh = world.mesh;
  const territories = territoriesOf(world, civ);
  const settlementById = new Map<number, Settlement>();
  for (const s of civ.settlements) settlementById.set(s.id, s);

  for (const p of civ.polities) {
    if (!polityAlive(p, year)) continue;
    const text = polityName(p, year) || p.name;
    if (!text) {
      dropped++;
      continue;
    }
    const t = territories.get(p.id);
    const center = t ? territoryCenter(t, W) : null;
    if (!t || !center || t.regions <= 0) {
      dropped++;
      continue;
    }
    const area = Math.max(t.area, t.regions * 400);
    // 字号:想让国名大致放得进领土——面积开方除以字数,再夹到 [17, 46] 世界单位
    // (相当于 1300 CSS 宽地图上 11–29px 左右,和主站国名量级一致)
    const len = clamp(text.length, 2, 7);
    let size = (0.8 * Math.sqrt(area)) / len;
    size = clamp(size, 17, 46);
    // 两个字的名字按面积算会偏大(宽度 = 字数×字号),单独压一下,免得"大景"这类压过邻国
    size = Math.min(size, 16 + 6 * text.length);
    // 优先级:主站 101 + log2(1+州数)*0.7(封顶 4.9),比国都名(100.5)先占位
    const prio = 101 + Math.min(4.9, Math.log2(1 + t.regions) * 0.7);
    // 国名位置:重心离国都太近时,把国名抬到国都上方一个字高处,免得和国都名叠在一起
    let x = center.x;
    let y = center.y;
    const cap = settlementById.get(capitalAt(p, year));
    if (cap && cap.cell >= 0 && cap.cell < mesh.n) {
      const capX = mesh.x[cap.cell];
      const capY = mesh.y[cap.cell];
      const labelHalf = Math.min(W * 0.45, text.length * size * 0.55);
      if (Math.abs(x - capX) < labelHalf && Math.abs(y - capY) < size * 1.15) {
        y = capY - size * 1.9 - 6;
      }
    }
    const item: MapLabel = {
      t: text,
      x: r1(((x % W) + W) % W),
      y: r1(clamp(y, size, H - size)),
      s: r1(size),
      k: 'polity',
      p: r1(prio),
      g: 0.45,
      d: 1,
      w: 700,
    };
    const c = hexOf(p.color);
    if (c) item.c = c;
    items.push(item);
  }
  return { items, dropped };
}

/* ------------------------------------------------------------------ *
 * 城名
 * ------------------------------------------------------------------ */

interface SettleRow {
  s: Settlement;
  kind: number;
  pop: number;
}

function settlementLabels(
  world: World,
  civ: Civ,
  year: Year,
  maxCount: number,
): { items: MapLabel[]; dropped: number } {
  const W = world.width || 2048;
  const H = world.height || 1024;
  const scale = (W / REF_MAP_CSS) * SIZE_TUNE;

  // 当年国都:civ.polities 里活着的国家按 growth.capitalAt(和主站 settlementsAt 同一规则)
  const capitalOf = new Set<number>();
  for (const p of civ.polities) {
    if (!polityAlive(p, year)) continue;
    const cap = capitalAt(p, year);
    if (cap >= 0) capitalOf.add(cap);
  }

  const rows: SettleRow[] = [];
  for (const s of civ.settlements) {
    const pop = populationAt(s, year);
    if (!(pop > 0)) continue;
    const kind = capitalOf.has(s.id) ? 4 : settlementRank(pop);
    rows.push({ s, kind: clamp(kind, 0, 4), pop });
  }
  rows.sort((a, b) => b.kind - a.kind || b.pop - a.pop || a.s.id - b.s.id);

  const limit = Number.isFinite(maxCount) ? Math.max(0, Math.floor(maxCount)) : rows.length;
  const kept = Math.min(limit, rows.length);
  const items: MapLabel[] = [];
  const mesh = world.mesh;
  for (let i = 0; i < kept; i++) {
    const { s, kind } = rows[i];
    const cell = s.cell;
    if (cell < 0 || cell >= mesh.n) continue;
    const x = mesh.x[cell];
    const y = mesh.y[cell];
    const size = SETTLEMENT_NAME_SIZE[kind] * scale;
    items.push({
      t: s.name,
      x: r1(x),
      y: r1(y),
      s: r1(size),
      k: SETTLEMENT_KIND[kind],
      p: SETTLEMENT_NAME_PRIORITY[kind],
      g: SETTLEMENT_NAME_GROW,
      d: SETTLEMENT_NAME_MIN_ZOOM[kind],
      w: SETTLEMENT_WEIGHT[kind],
    });
  }
  return { items, dropped: rows.length - kept };
}

/* ------------------------------------------------------------------ *
 * 地名(河/湖/海/山/漠/岛)
 * ------------------------------------------------------------------ */

/** 海类地名按名字后缀细分:…洋 → 洋、…湾 → 湾,其余为海(同主站 kindOf) */
function seaKind(place: Place): 'ocean' | 'sea' | 'bay' {
  const name = place.name || place.defaultName || '';
  if (name.endsWith('洋')) return 'ocean';
  if (name.endsWith('湾')) return 'bay';
  return 'sea';
}

const PLACE_KIND_OF: Record<string, 'ocean' | 'sea' | 'bay' | 'mountains' | 'desert' | 'island' | 'river' | 'lake'> = {
  sea: 'sea',
  mountains: 'mountains',
  desert: 'desert',
  island: 'island',
  river: 'river',
  lake: 'lake',
};

function placeLabels(world: World, civ: Civ): { items: MapLabel[]; byKind: Record<string, number> } {
  const items: MapLabel[] = [];
  const byKind: Record<string, number> = { river: 0, lake: 0, sea: 0, mountains: 0, desert: 0, island: 0 };
  const W = world.width || 2048;
  const H = world.height || 1024;
  const scale = (W / REF_MAP_CSS) * SIZE_TUNE;
  const mesh = world.mesh;

  for (const place of civ.places) {
    if (place.kind === 'pass') continue;
    const base = PLACE_KIND_OF[place.kind];
    if (!base) continue;
    const kind = base === 'sea' ? seaKind(place) : base;
    const type = PLACE_TYPE[kind];
    const rank = clamp(Math.round(place.rank || 1), 1, 3);

    // 锚点 + 角度:优先用命名路径(山脊线/河道/海域中心弧/湖心点);退化时用 keyCell/cell 的中心
    let anchor = pathAnchor(place.path);
    if (!anchor) {
      const cell = place.keyCell ?? place.cell ?? -1;
      if (cell >= 0 && cell < mesh.n) anchor = { x: mesh.x[cell], y: mesh.y[cell], a: 0 };
    }
    if (!anchor) continue;
    const x = ((anchor.x % W) + W) % W;
    const y = clamp(anchor.y, 0, H);
    const size = type.size[rank - 1] * scale;
    const prio = type.priority - (rank - 1) * 30 + Math.min(9, Math.log2(1 + (place.size ?? 0)) * 0.8);
    const item: MapLabel = {
      t: place.name,
      x: r1(x),
      y: r1(y),
      s: r1(size),
      k: kind,
      p: r1(prio),
      g: type.grow,
      d: PLACE_MIN_ZOOM[rank - 1],
      w: PLACE_WEIGHT,
    };
    if (Math.abs(anchor.a) > 0.02) item.a = r3(anchor.a);
    items.push(item);
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  return { items, byKind };
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/**
 * 生成一个世界(某一年)的全部文字标签,可直接 JSON.stringify 下发。
 * world 必须有;civ 可选:没有 civ 时只有世界数据,但世界本身没有地名体系,结果为空(由 stats 说明)。
 */
export function buildLabels(world: World, civ?: Civ | null, opts: LabelOptions = {}): LabelMap {
  const year: Year = opts.year ?? (civ ? (civ.endYear as Year) : 0);
  const items: MapLabel[] = [];
  const stats: LabelStats = {
    year: typeof year === 'number' ? Math.round(year * 100) / 100 : 0,
    polities: 0,
    settlements: 0,
    places: 0,
    rivers: 0,
    lakes: 0,
    seas: 0,
    mountains: 0,
    deserts: 0,
    islands: 0,
    droppedSettlements: 0,
    droppedPolities: 0,
  };

  if (civ) {
    const pol = polityLabels(world, civ, year);
    items.push(...pol.items);
    stats.polities = pol.items.length;
    stats.droppedPolities = pol.dropped;

    const maxS = opts.maxSettlements ?? DEFAULT_MAX_SETTLEMENTS;
    const set = settlementLabels(world, civ, year, maxS);
    items.push(...set.items);
    stats.settlements = set.items.length;
    stats.droppedSettlements = set.dropped;

    if (opts.geography !== false) {
      const geo = placeLabels(world, civ);
      items.push(...geo.items);
      stats.places = geo.items.length;
      stats.rivers = geo.byKind.river ?? 0;
      stats.lakes = geo.byKind.lake ?? 0;
      stats.seas = geo.byKind.sea ?? 0;
      stats.mountains = geo.byKind.mountains ?? 0;
      stats.deserts = geo.byKind.desert ?? 0;
      stats.islands = geo.byKind.island ?? 0;
    }
  }

  return {
    year: stats.year,
    w: world.width || 2048,
    h: world.height || 1024,
    count: items.length,
    items,
    stats,
  };
}

/** 只要数组时用这个(和 buildLabels().items 相同) */
export function labelItems(world: World, civ?: Civ | null, opts: LabelOptions = {}): MapLabel[] {
  return buildLabels(world, civ, opts).items;
}

/* ------------------------------------------------------------------ *
 * 自查:河名覆盖(测试/报告用,不进下发数据)
 * ------------------------------------------------------------------ */

export interface RiverCoverage {
  /** 参与检查的河数 */
  top: number;
  /** 其中 civ.places 已命名的河数 */
  named: number;
  /** 每条河的河口最大流量与是否已命名 */
  rows: { flux: number; named: boolean }[];
}

/**
 * 检查 world.rivers 里流量最大的前 top 条河,有几条在 civ.places 里有名字。
 * 河名来自 findPlaces(),它正是按河口流量挑的大河;这里用于确认"流量最大的河基本都有名字"。
 * 判定:某条已命名河的路径顶点与这条河的河口(终点)距离 < 40 世界单位,就算覆盖。
 */
export function riverCoverage(world: World, civ: Civ, top = 20): RiverCoverage {
  const named = civ.places.filter((p) => p.kind === 'river');
  const namedPts: number[] = [];
  for (const p of named) {
    for (let i = 0; i + 1 < p.path.length; i += 2) namedPts.push(p.path[i], p.path[i + 1]);
  }
  const rivers = world.rivers.map((r) => {
    let flux = 0;
    for (let i = 2; i < r.pts.length; i += 3) if (r.pts[i] > flux) flux = r.pts[i];
    const n = Math.floor(r.pts.length / 3);
    const mouthX = n > 0 ? r.pts[(n - 1) * 3] : 0;
    const mouthY = n > 0 ? r.pts[(n - 1) * 3 + 1] : 0;
    return { flux, mouthX, mouthY };
  });
  rivers.sort((a, b) => b.flux - a.flux);
  const rows = rivers.slice(0, Math.max(0, top)).map((r) => {
    let hit = false;
    for (let i = 0; i + 1 < namedPts.length && !hit; i += 2) {
      if (Math.hypot(namedPts[i] - r.mouthX, namedPts[i + 1] - r.mouthY) < 40) hit = true;
    }
    return { flux: Math.round(r.flux * 10) / 10, named: hit };
  });
  return { top: rows.length, named: rows.filter((r) => r.named).length, rows };
}
