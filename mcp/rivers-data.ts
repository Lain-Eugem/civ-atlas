/**
 * 河流 → 州/地块层的读数(沙盒侧,只读上游引擎,不重算推演)。
 *
 * 为什么要有这个文件:
 * 用户对「河流影响地块」的补充是——人口、商路、国界都有影响。上游引擎 src/gen/civ
 * 其实已经把这些影响算进推演里了,沙盒不需要、也不该再算一遍:
 * - 人口/宜居: habitat.ts 的 RIVER_BANK=0.75(:34)、MAJOR_RIVER=6(:36),河/河岸给淡水加成
 *   fresh()=min(40,12*log2(1+flux/thr)),FLOODPLAIN/ESTUARY 另算;population.ts RIVER_SILT=0.5
 *   让沿河土地耐种。结果落在 regions.capacity / 人口里。
 * - 商路: routes.ts RIVER_ALONG=1.5(:100)、RIVER_CROSS=0.25(:102):沿河好走、过河难走。
 * - 国界: regions.ts RIVER_STEPS=0.9(:54)、RIVER_BORDER_FRAC=0.4(:68):州之间过河加步数,
 *   以河为界的州对直接标成 AdjKind.River(types.ts:76-82)。
 * 这里只做「暴露 + 派生」:把 world.rivers[].cells 翻成州级读数,并把国界、商路里
 * 用到河流的那部分挑出来给模型看。模型据此能判断:哪些州靠河吃红利(值得发展)、
 * 哪些州对沿河相连(商路顺河走)、哪些国界是大河(守河比硬冲划算)。
 *
 * 口径:
 * - 河道分级和引擎一致:陆地块 flux >= world.riverThreshold 算「河」,
 *   flux >= MAJOR_RIVER * riverThreshold 算「大河」。water != 0 的地块不算州的地块
 *   (regions.of 是 -1),所以湖/海端点只当作链的两端。
 * - 河长按每段两端的地块各记一半;某端是湖/海(链端点)时陆端记整段。这样各州河长
 *   相加正好等于全部河道总长,不重不漏。
 * - 以河为界的州对直接用 regions.adjKind === AdjKind.River 和 regions.adjBorder(世界单位,
 *   finishRegions 里按 len*0.577 累计),换算成公里展示;不自己再判一遍。
 * - 沿河相邻州对来自每条河的地块链:把链压成「州 run」,相邻 run 属不同州就记一对。
 *
 * 体积:seed=7、cells=34043 的世界约 267 条河、912 个河道地块、820 个州。全量按州数组
 * (820 条)只给按需函数;stateGet 里只放 top 8 州 + 国界/沿河州对各 top 6,几个 KB。
 *
 * 缓存:世界级的索引按 World、州级的聚合按 Regions 各缓一份(WeakMap)。推演里 world 不会
 * 原地改河流(没有写 rivers/flux 的地方),civ 每回合整份换新,所以命中即安全。
 */
import type { World } from '../src/gen/world';
import type { Civ, Polity, Regions } from '../src/gen/civ/types';
import { MAJOR_RIVER } from '../src/gen/civ/habitat';
import { KM_PER_UNIT } from '../src/gen/civ/scale';
import { polityKey, regionKey } from '../src/gen/edits';
import { capitalAt, polityName } from '../src/gen/civ/growth';

/* ------------------------------------------------------------------ *
 * 常量 / 小工具
 * ------------------------------------------------------------------ */

/** types.ts:76-82 的 AdjKind 是 const enum,isolatedModules 下不能当值 import,这里写死 1。 */
const ADJ_RIVER = 1;
/** stateGet 里每块的条数上限(控制返回体积;全量走 riverAdjacency/riverCellsByRegion)。 */
const TOP_REGIONS = 8;
const TOP_POLITY_BORDERS = 6;
const TOP_POLITY_LINKS = 6;
const TOP_POLITIES = 6;
/** 每个国界条目里附几条最长的州对(给模型看具体是哪两州)。 */
const PAIRS_PER_BORDER = 4;

function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/* ------------------------------------------------------------------ *
 * 世界级:地块 → 河道分级 + 每块分到的河长
 * ------------------------------------------------------------------ */

export interface RiverWorldIndex {
  /** 地块 → 0 不是河道地块 / 1 河 / 2 大河 */
  tier: Uint8Array;
  /** 地块 → 分到的河长(公里) */
  lengthKm: Float32Array;
  /** 河道条数 */
  count: number;
  /** 河道地块数(陆地,去重) */
  cells: number;
  majorCells: number;
  lengthTotalKm: number;
  /** 大河阈值 = MAJOR_RIVER * world.riverThreshold */
  majorFlux: number;
}

const worldCache = new WeakMap<World, RiverWorldIndex>();

function worldIndex(world: World): RiverWorldIndex {
  const hit = worldCache.get(world);
  if (hit) return hit;
  const n = world.mesh.n;
  const tier = new Uint8Array(n);
  const lengthKm = new Float32Array(n);
  const water = world.water;
  const flux = world.flux;
  const majorFlux = MAJOR_RIVER * world.riverThreshold;
  const width = world.width;
  const height = world.height;
  for (const river of world.rivers) {
    const cells = river.cells;
    const pts = river.pts;
    const m = cells.length;
    // 1) 分级:同一条河链上的陆地块,按 flux 分河/大河
    for (let k = 0; k < m; k++) {
      const c = cells[k]!;
      if (c < 0 || c >= n || water[c] !== 0 || tier[c] !== 0) continue;
      tier[c] = flux[c]! >= majorFlux ? 2 : 1;
    }
    // 2) 河长:按河点坐标逐段量,两端地块各半;水端整段给陆端
    for (let k = 1; k < m; k++) {
      const ia = k - 1;
      const ib = k;
      const ca = cells[ia]!;
      const cb = cells[ib]!;
      const ax = pts[ia * 3]!;
      const ay = pts[ia * 3 + 1]!;
      const bx = pts[ib * 3]!;
      const by = pts[ib * 3 + 1]!;
      let dx = Math.abs(bx - ax);
      if (dx > width / 2) dx = width - dx; // 跨 180° 经线时 x 会跳边
      let dy = Math.abs(by - ay);
      if (dy > height / 2) dy = height - dy;
      const len = Math.hypot(dx, dy) * KM_PER_UNIT;
      const la = ca >= 0 && ca < n && water[ca] === 0;
      const lb = cb >= 0 && cb < n && water[cb] === 0;
      if (la && lb) {
        lengthKm[ca] += len / 2;
        lengthKm[cb] += len / 2;
      } else if (la) {
        lengthKm[ca] += len;
      } else if (lb) {
        lengthKm[cb] += len;
      }
    }
  }
  let cells = 0;
  let majorCells = 0;
  let lengthTotalKm = 0;
  for (let i = 0; i < n; i++) {
    const t = tier[i]!;
    if (t === 0) continue;
    cells++;
    if (t === 2) majorCells++;
    lengthTotalKm += lengthKm[i]!;
  }
  const idx: RiverWorldIndex = { tier, lengthKm, count: world.rivers.length, cells, majorCells, lengthTotalKm, majorFlux };
  worldCache.set(world, idx);
  return idx;
}

/**
 * 地块 → 河道分级:0 不是河道地块 / 1 河 / 2 大河(阈值同 habitat.ts)。
 * 返回的是缓存数组,调用方只读。
 */
export function riverCellsByCell(world: World): Uint8Array {
  return worldIndex(world).tier;
}

/* ------------------------------------------------------------------ *
 * 州级:每州的河道读数、以河为界的州对、沿河相邻州对
 * ------------------------------------------------------------------ */

export interface RiverRegionInfo {
  /** 州编号(0 起) */
  region: number;
  /** 州名(引擎起名,可能为空串) */
  name: string;
  /** 本州河道地块数 */
  cells: number;
  /** 其中大河地块数 */
  majorCells: number;
  /** 本州分到的河道长度(公里) */
  lengthKm: number;
  /** 本州河道地块的最大径流(和 world.flux 同量纲) */
  maxFlux: number;
  /** 经过本州的河道条数 */
  rivers: number;
  /** 治所地块的河道分级:0 无河 / 1 河 / 2 大河 */
  seatTier: number;
  /** 治所有相邻地块是河道(引擎 RIVER_BANK 河岸加成大致按这一圈给) */
  seatBank: boolean;
  /** 本州承载力(人口上限,已含引擎的河流加成) */
  capacity: number;
  /** 本州面积(世界单位²) */
  area: number;
}

export interface RiverBorderPair {
  a: number;
  b: number;
  borderKm: number;
}

export interface RawRiverLink {
  upstream: number;
  downstream: number;
  rivers: number;
  lengthKm: number;
  maxFlux: number;
}

interface RegionGeo {
  world: World;
  byRegion: RiverRegionInfo[];
  borderPairs: RiverBorderPair[];
  /** 陆上邻接边总数(引擎 Regions 的边) */
  edgeTotal: number;
  links: RawRiverLink[];
  capacityTotal: number;
  capacityRiver: number;
}

const regionsCache = new WeakMap<Regions, RegionGeo>();

function regionGeo(world: World, regions: Regions): RegionGeo {
  const hit = regionsCache.get(regions);
  if (hit && hit.world === world) return hit;
  const idx = worldIndex(world);
  const n = world.mesh.n;
  const count = regions.count;
  const cells = new Int32Array(count);
  const majorCells = new Int32Array(count);
  const maxFlux = new Float32Array(count);
  const lengthKm = new Float32Array(count);
  const riverHits = new Int32Array(count);

  for (let i = 0; i < n; i++) {
    if (idx.tier[i] === 0) continue;
    const r = regions.of[i]!;
    if (r < 0 || r >= count) continue;
    cells[r]! += 1;
    if (idx.tier[i] === 2) majorCells[r]! += 1;
    const f = world.flux[i]!;
    if (f > maxFlux[r]!) maxFlux[r] = f;
    lengthKm[r]! += idx.lengthKm[i]!;
  }

  // 经过本州的河道条数:同一条河穿过同一个州只算一次
  const marker = new Int32Array(count);
  for (let ri = 0; ri < world.rivers.length; ri++) {
    const rc = world.rivers[ri]!.cells;
    for (let k = 0; k < rc.length; k++) {
      const c = rc[k]!;
      if (c < 0 || c >= n) continue;
      const r = regions.of[c]!;
      if (r < 0 || r >= count) continue;
      if (marker[r] !== ri + 1) {
        marker[r] = ri + 1;
        riverHits[r]! += 1;
      }
    }
  }

  // 每州一条读数(没河的州也留一条 0,方便按 region 下标取)
  const byRegion: RiverRegionInfo[] = new Array(count);
  for (let r = 0; r < count; r++) {
    const seat = regions.seat[r]!;
    const seatTier = seat >= 0 && seat < n ? idx.tier[seat]! : 0;
    let seatBank = false;
    if (seat >= 0 && seat < n) {
      const as = world.mesh.adjStart[seat]!;
      const ae = world.mesh.adjStart[seat + 1]!;
      for (let e = as; e < ae; e++) {
        if (idx.tier[world.mesh.adj[e]!]! > 0) {
          seatBank = true;
          break;
        }
      }
    }
    byRegion[r] = {
      region: r,
      name: regions.name?.[r] ?? '',
      cells: cells[r]!,
      majorCells: majorCells[r]!,
      lengthKm: r1(lengthKm[r]!),
      maxFlux: Math.round(maxFlux[r]!),
      rivers: riverHits[r]!,
      seatTier,
      seatBank,
      capacity: r1(regions.capacity[r]!),
      area: r1(regions.area[r]!),
    };
  }

  // 以河为界的州对:引擎已经判好 AdjKind.River,这里只取边和长度(邻接表两头各存一次,按 q>r 去重)
  const borderPairs: RiverBorderPair[] = [];
  let edgeTotal = 0;
  for (let r = 0; r < count; r++) {
    const as = regions.adjStart[r]!;
    const ae = regions.adjStart[r + 1]!;
    for (let e = as; e < ae; e++) {
      const q = regions.adj[e]!;
      if (q <= r) continue;
      edgeTotal++;
      if (regions.adjKind[e] === ADJ_RIVER) {
        borderPairs.push({ a: r, b: q, borderKm: r1(regions.adjBorder[e]! * KM_PER_UNIT) });
      }
    }
  }

  // 沿河相邻州对:把每条河的地块链压成州 run,相邻 run 不同州就记一次跨州
  const linkMap = new Map<number, RawRiverLink>();
  const linkRivers = new Map<number, Set<number>>();
  const stride = Math.max(count, 1);
  for (let ri = 0; ri < world.rivers.length; ri++) {
    const rc = world.rivers[ri]!.cells;
    interface Run {
      r: number;
      lenKm: number;
      maxFlux: number;
    }
    const runs: Run[] = [];
    let run: Run | null = null;
    for (let k = 0; k < rc.length; k++) {
      const c = rc[k]!;
      if (c < 0 || c >= n) {
        run = null;
        continue;
      }
      const r = regions.of[c]!;
      if (r < 0 || r >= count) {
        run = null; // 湖/海端点:链的两端,断开
        continue;
      }
      const f = world.flux[c]!;
      const len = idx.lengthKm[c]!;
      if (run !== null && run.r === r) {
        run.lenKm += len;
        if (f > run.maxFlux) run.maxFlux = f;
      } else {
        run = { r, lenKm: len, maxFlux: f };
        runs.push(run);
      }
    }
    for (let k = 1; k < runs.length; k++) {
      const up = runs[k - 1]!;
      const down = runs[k]!;
      if (up.r === down.r) continue;
      const lo = up.r < down.r ? up.r : down.r;
      const hi = up.r < down.r ? down.r : up.r;
      const key = lo * stride + hi;
      let link = linkMap.get(key);
      if (!link) {
        link = { upstream: up.r, downstream: down.r, rivers: 0, lengthKm: 0, maxFlux: 0 };
        linkMap.set(key, link);
        linkRivers.set(key, new Set<number>());
      }
      linkRivers.get(key)!.add(ri);
      link.lengthKm += up.lenKm + down.lenKm;
      if (up.maxFlux > link.maxFlux) link.maxFlux = up.maxFlux;
      if (down.maxFlux > link.maxFlux) link.maxFlux = down.maxFlux;
    }
  }
  const links: RawRiverLink[] = [];
  for (const [key, link] of linkMap) {
    link.rivers = linkRivers.get(key)?.size ?? 0;
    link.lengthKm = r1(link.lengthKm);
    link.maxFlux = Math.round(link.maxFlux);
    links.push(link);
  }
  linkRivers.clear();

  let capacityTotal = 0;
  let capacityRiver = 0;
  for (let r = 0; r < count; r++) {
    const cap = regions.capacity[r]!;
    capacityTotal += cap;
    if (cells[r]! > 0) capacityRiver += cap;
  }

  const geo: RegionGeo = { world, byRegion, borderPairs, edgeTotal, links, capacityTotal, capacityRiver };
  regionsCache.set(regions, geo);
  return geo;
}

/** 每州的河道读数(按州下标;没河的州 cells=0)。返回缓存数组,调用方只读。 */
export function riverCellsByRegion(world: World, regions: Regions): readonly RiverRegionInfo[] {
  return regionGeo(world, regions).byRegion;
}

export interface RiverSummary {
  /** 河道条数 */
  count: number;
  /** 河道地块数(陆地,去重) */
  cells: number;
  /** 其中大河地块数 */
  majorCells: number;
  /** 河道总长(公里) */
  lengthKm: number;
  /** 州数 */
  regions: number;
  /** 有河道地块的州数 */
  withRiver: number;
  /** 有大河地块的州数 */
  withMajor: number;
  /** 治所就在河道地块上的州数 */
  seatsOnRiver: number;
  /** 有河州的承载力之和 / 全部州的承载力之和(引擎已把河流加成算进 capacity) */
  capacityShare: number;
}

/** 静态地理读数:河道多少、多少州沾河、靠河的州占多少承载力(stateGet/sessionSummary 都放它)。 */
export function riverSummary(world: World, civ: Civ): RiverSummary {
  const idx = worldIndex(world);
  const regions = civ.regions;
  const geo = regionGeo(world, regions);
  let withRiver = 0;
  let withMajor = 0;
  let seatsOnRiver = 0;
  for (const info of geo.byRegion) {
    if (info.cells > 0) withRiver++;
    if (info.majorCells > 0) withMajor++;
    if (info.seatTier > 0) seatsOnRiver++;
  }
  return {
    count: idx.count,
    cells: idx.cells,
    majorCells: idx.majorCells,
    lengthKm: r1(idx.lengthTotalKm),
    regions: regions.count,
    withRiver,
    withMajor,
    seatsOnRiver,
    capacityShare: geo.capacityTotal > 0 ? r3(geo.capacityRiver / geo.capacityTotal) : 0,
  };
}

/* ------------------------------------------------------------------ *
 * 派生:以河为界 / 沿河相邻(全量,按需调用)
 * ------------------------------------------------------------------ */

export interface RiverBorder {
  a: number;
  b: number;
  keyA: string;
  keyB: string;
  /** 这段河界长度(公里,引擎 adjBorder 是六边形近似) */
  borderKm: number;
  ownerA: number;
  ownerB: number;
  /** 两国交界(不同国家) */
  polityBorder: boolean;
}

export interface RiverLink {
  upstream: number;
  downstream: number;
  keyUpstream: string;
  keyDownstream: string;
  /** 这条州对之间经过的河道条数 */
  rivers: number;
  /** 该河在这两州内的河段总长(公里) */
  lengthKm: number;
  maxFlux: number;
  ownerUpstream: number;
  ownerDownstream: number;
  polityLink: boolean;
}

export interface RiverAdjacency {
  /** 引擎标成 AdjKind.River 的州对(以河为界) */
  borders: RiverBorder[];
  /** 沿同一条河上下游相邻的州对 */
  links: RiverLink[];
}

/** 全量的以河为界州对 + 沿河相邻州对(给按需查询/工具用;stateGet 里只放聚合后的 top)。 */
export function riverAdjacency(world: World, civ: Civ): RiverAdjacency {
  const geo = regionGeo(world, civ.regions);
  const borders: RiverBorder[] = geo.borderPairs.map((b) => {
    const ownerA = civ.polity[b.a]!;
    const ownerB = civ.polity[b.b]!;
    return {
      a: b.a,
      b: b.b,
      keyA: regionKey(civ, b.a),
      keyB: regionKey(civ, b.b),
      borderKm: b.borderKm,
      ownerA,
      ownerB,
      polityBorder: ownerA >= 0 && ownerB >= 0 && ownerA !== ownerB,
    };
  });
  const links: RiverLink[] = geo.links.map((l) => {
    const ownerUpstream = civ.polity[l.upstream]!;
    const ownerDownstream = civ.polity[l.downstream]!;
    return {
      upstream: l.upstream,
      downstream: l.downstream,
      keyUpstream: regionKey(civ, l.upstream),
      keyDownstream: regionKey(civ, l.downstream),
      rivers: l.rivers,
      lengthKm: l.lengthKm,
      maxFlux: l.maxFlux,
      ownerUpstream,
      ownerDownstream,
      polityLink: ownerUpstream >= 0 && ownerDownstream >= 0 && ownerUpstream !== ownerDownstream,
    };
  });
  return { borders, links };
}

/* ------------------------------------------------------------------ *
 * stateGet 用:聚合读数(控制体积)
 * ------------------------------------------------------------------ */

export interface RiverRegionView extends RiverRegionInfo {
  /** 州键(和 civ_state_get 里 polities[].key 同一套说法,可直接拿来下命令) */
  key: string;
  owner: number;
}

export interface RiverBorderPairView {
  a: string;
  b: string;
  borderKm: number;
}

export interface RiverPolityBorderView {
  a: number;
  keyA: string;
  b: number;
  keyB: string;
  nameA: string;
  nameB: string;
  /** 这两国之间以河为界的州对数 */
  regions: number;
  borderKm: number;
  /** 最长的几条州对(最多 PAIRS_PER_BORDER 条) */
  pairs: RiverBorderPairView[];
}

export interface RiverPolityLinkView {
  up: number;
  keyUp: string;
  down: number;
  keyDown: string;
  nameUp: string;
  nameDown: string;
  /** 这两国之间沿河相邻的州对数 */
  regions: number;
  /** 涉及的河道条数(两边去重后相加) */
  rivers: number;
  lengthKm: number;
  maxFlux: number;
}

export interface RiverPolityView {
  id: number;
  key: string;
  name: string;
  /** 拥有几个沾河的州 */
  regions: number;
  cells: number;
  majorCells: number;
  lengthKm: number;
  /** 国都就在河上 */
  capitalOnRiver: boolean;
}

export interface RiverRoutesView {
  total: number;
  /** 商路经过的地块总数(陆路 + 海路) */
  cells: number;
  /** 其中踩在河道地块上的 */
  cellsOnRiver: number;
  share: number;
}

export interface RiverBordersView {
  /** 引擎里全部陆上邻接边 */
  edges: number;
  /** 以河为界的州对 */
  pairs: number;
  /** 以河为界的边占全部陆上邻接边 */
  share: number;
  /** 不同国家之间以河为界的州对 */
  polityEdges: number;
  /** 不同国家之间以河为界的国对 */
  polityPairs: number;
}

export interface RiverLinksView {
  /** 沿同一条河相邻的州对(去重) */
  pairs: number;
  /** 其中属于不同国家的州对 */
  polityPairs: number;
}

export interface RiverReport {
  summary: RiverSummary;
  borders: RiverBordersView;
  links: RiverLinksView;
  routes: RiverRoutesView;
  /** 沾河程度最高的几个州 */
  topRegions: RiverRegionView[];
  /** 河流当国界最明显的几对国 */
  polityBorders: RiverPolityBorderView[];
  /** 沿河跨国(顺河商路/顺河扩张的口子) */
  polityLinks: RiverPolityLinkView[];
  /** 沾河的国(top P,按河长) */
  polities: RiverPolityView[];
}

function capitalOnRiver(civ: Civ, p: Polity, year: number, tier: Uint8Array): boolean {
  const capId = capitalAt(p, year);
  const st = civ.settlements[capId];
  if (!st) return false;
  const c = st.cell;
  return c >= 0 && c < tier.length && tier[c]! > 0;
}

/**
 * civ_state_get 里那一块河流读数:静态 summary + 以河为界/沿河相邻的聚合 + 商路踩河
 * + 几个 top。year 默认 civ.endYear(和推演到的那一年一致),stateGet 传 s.play.year。
 */
export function riverReport(world: World, civ: Civ, year: number = civ.endYear): RiverReport {
  const regions = civ.regions;
  const idx = worldIndex(world);
  const geo = regionGeo(world, regions);
  const summary = riverSummary(world, civ);
  const count = regions.count;
  const stride = Math.max(count, 1);

  // 以河为界:按两国聚合
  interface BorderAcc {
    a: number;
    b: number;
    regions: number;
    borderKm: number;
    pairs: RiverBorderPair[];
  }
  const borderAcc = new Map<number, BorderAcc>();
  const borderPolityPairs = new Set<number>();
  let borderPolityEdges = 0;
  for (const b of geo.borderPairs) {
    const oa = civ.polity[b.a]!;
    const ob = civ.polity[b.b]!;
    if (oa < 0 || ob < 0 || oa === ob) continue;
    borderPolityEdges++;
    const lo = oa < ob ? oa : ob;
    const hi = oa < ob ? ob : oa;
    const key = lo * stride + hi;
    borderPolityPairs.add(key);
    let acc = borderAcc.get(key);
    if (!acc) {
      acc = { a: lo, b: hi, regions: 0, borderKm: 0, pairs: [] };
      borderAcc.set(key, acc);
    }
    acc.regions++;
    acc.borderKm += b.borderKm;
    acc.pairs.push({ a: b.a, b: b.b, borderKm: b.borderKm });
  }
  const polityBorders: RiverPolityBorderView[] = [...borderAcc.values()]
    .sort((x, y) => y.borderKm - x.borderKm || y.regions - x.regions)
    .slice(0, TOP_POLITY_BORDERS)
    .map((acc) => {
      const pa = civ.polities[acc.a];
      const pb = civ.polities[acc.b];
      return {
        a: acc.a,
        keyA: polityKey(civ, acc.a),
        b: acc.b,
        keyB: polityKey(civ, acc.b),
        nameA: pa ? polityName(pa, year) : '',
        nameB: pb ? polityName(pb, year) : '',
        regions: acc.regions,
        borderKm: r1(acc.borderKm),
        pairs: acc.pairs
          .sort((x, y) => y.borderKm - x.borderKm)
          .slice(0, PAIRS_PER_BORDER)
          .map((p) => ({ a: regionKey(civ, p.a), b: regionKey(civ, p.b), borderKm: p.borderKm })),
      };
    });

  // 沿河相邻:按两国聚合
  interface LinkAcc {
    up: number;
    down: number;
    regions: number;
    rivers: number;
    lengthKm: number;
    maxFlux: number;
  }
  const linkAcc = new Map<number, LinkAcc>();
  const linkPolityPairs = new Set<number>();
  for (const l of geo.links) {
    const ou = civ.polity[l.upstream]!;
    const od = civ.polity[l.downstream]!;
    if (ou < 0 || od < 0 || ou === od) continue;
    const lo = ou < od ? ou : od;
    const hi = ou < od ? od : ou;
    const key = lo * stride + hi;
    linkPolityPairs.add(key);
    let acc = linkAcc.get(key);
    if (!acc) {
      acc = { up: lo, down: hi, regions: 0, rivers: 0, lengthKm: 0, maxFlux: 0 };
      linkAcc.set(key, acc);
    }
    acc.regions++;
    acc.rivers += l.rivers;
    acc.lengthKm += l.lengthKm;
    if (l.maxFlux > acc.maxFlux) acc.maxFlux = l.maxFlux;
  }
  const polityLinks: RiverPolityLinkView[] = [...linkAcc.values()]
    .sort((x, y) => y.regions - x.regions || y.lengthKm - x.lengthKm)
    .slice(0, TOP_POLITY_LINKS)
    .map((acc) => {
      const pu = civ.polities[acc.up];
      const pd = civ.polities[acc.down];
      return {
        up: acc.up,
        keyUp: polityKey(civ, acc.up),
        down: acc.down,
        keyDown: polityKey(civ, acc.down),
        nameUp: pu ? polityName(pu, year) : '',
        nameDown: pd ? polityName(pd, year) : '',
        regions: acc.regions,
        rivers: acc.rivers,
        lengthKm: r1(acc.lengthKm),
        maxFlux: acc.maxFlux,
      };
    });

  // 商路踩河:引擎 routes.ts 里沿河 1.5 倍/过河 0.25 倍只影响选线,这里看结果
  let routeCells = 0;
  let routeCellsOnRiver = 0;
  for (const route of civ.routes) {
    const rc = route.cells;
    for (let k = 0; k < rc.length; k++) {
      const c = rc[k]!;
      routeCells++;
      if (c >= 0 && c < idx.tier.length && idx.tier[c]! > 0) routeCellsOnRiver++;
    }
  }

  const topRegions: RiverRegionView[] = geo.byRegion
    .filter((info) => info.cells > 0)
    .sort((x, y) => y.lengthKm - x.lengthKm || y.majorCells - x.majorCells || x.region - y.region)
    .slice(0, TOP_REGIONS)
    .map((info) => ({
      ...info,
      key: regionKey(civ, info.region),
      owner: civ.polity[info.region]!,
    }));

  // 沾河的国:按河长排
  interface PolityAcc {
    id: number;
    regions: number;
    cells: number;
    majorCells: number;
    lengthKm: number;
  }
  const polityAcc = new Map<number, PolityAcc>();
  for (const info of geo.byRegion) {
    if (info.cells === 0) continue;
    const owner = civ.polity[info.region]!;
    if (owner < 0) continue;
    let acc = polityAcc.get(owner);
    if (!acc) {
      acc = { id: owner, regions: 0, cells: 0, majorCells: 0, lengthKm: 0 };
      polityAcc.set(owner, acc);
    }
    acc.regions++;
    acc.cells += info.cells;
    acc.majorCells += info.majorCells;
    acc.lengthKm += info.lengthKm;
  }
  const polities: RiverPolityView[] = [...polityAcc.values()]
    .map((acc) => {
      const p = civ.polities[acc.id];
      return {
        id: acc.id,
        key: polityKey(civ, acc.id),
        name: p ? polityName(p, year) : '',
        regions: acc.regions,
        cells: acc.cells,
        majorCells: acc.majorCells,
        lengthKm: r1(acc.lengthKm),
        capitalOnRiver: p ? capitalOnRiver(civ, p, year, idx.tier) : false,
      };
    })
    .sort((x, y) => y.lengthKm - x.lengthKm || y.cells - x.cells || x.id - y.id)
    .slice(0, TOP_POLITIES);

  return {
    summary,
    borders: {
      edges: geo.edgeTotal,
      pairs: geo.borderPairs.length,
      share: geo.edgeTotal > 0 ? r3(geo.borderPairs.length / geo.edgeTotal) : 0,
      polityEdges: borderPolityEdges,
      polityPairs: borderPolityPairs.size,
    },
    links: {
      pairs: geo.links.length,
      polityPairs: linkPolityPairs.size,
    },
    routes: {
      total: civ.routes.length,
      cells: routeCells,
      cellsOnRiver: routeCellsOnRiver,
      share: routeCells > 0 ? r3(routeCellsOnRiver / routeCells) : 0,
    },
    topRegions,
    polityBorders,
    polityLinks,
    polities,
  };
}
