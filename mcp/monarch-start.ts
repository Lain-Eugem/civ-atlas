/**
 * 君主开局定制:会话开始后、第一回合推演之前,给这一局挑一个"君主国家"——
 * 可以是地图上已有的国家(调它的初始州数),也可以在地图上点一个位置新建一个国家,
 * 然后写一张君主角色卡(session.cards)。角色卡会被 mcp/monarch.ts 的 ensureCards 钉住,
 * 不会在下一轮方案里被引擎按推演君主重建覆盖。
 *
 * 约束:只改 Session 状态(世界坐标 + civ 数据 + session.cards),不改推演/引擎回合逻辑。
 * 必须在第一回合之前(rounds === 0)调用;调用后 stateGet/sessionSummary 立即能读到新国家,
 * turnStep/monarchRound 照常跑(直接改 civ.polity 后,续推会以它作为当前国土)。
 */
import type { Session } from './engine';
import { civHash, isFinished, sizesNow } from './engine';
import type { Civ, Polity, Settlement } from '../src/gen/civ/types';
import { capitalAt, polityAlive, polityName } from '../src/gen/civ/growth';
import { POLITY_PALETTE } from '../src/gen/civ/polities';
import { namePolities } from '../src/gen/civ/naming';
import { cardIsCurrent, cleanCardInput, monarchCard, personaOf, type MonarchCard } from '../src/gen/civ/monarchCard';
import { createPersonNamer } from '../src/gen/names/persons';

/** 初始疆域最小州数(再小就守不住国都) */
export const CUSTOM_START_SIZE_MIN = 3;
/** 初始疆域最大州数(再大就把邻居吃光了) */
export const CUSTOM_START_SIZE_MAX = 40;
/** 没给 size 时默认给 8 州("中") */
export const CUSTOM_START_SIZE_DEFAULT = 8;

/** 陆上相邻的 AdjKind:Flat=0 / River=1 / Mountain=2(不 import const enum,isolatedModules 下当值用会报错) */
const LAND_EDGE_MAX = 2;

/** 开局可选的现有国家(给前端下拉用) */
export interface StartNation {
  polityId: number;
  name: string;
  /** #rrggbb */
  color: string;
  /** 国都的世界像素坐标(主图坐标系,地图点选传回来的也是这个) */
  capital: { x: number; y: number } | null;
  /** 当前州数 */
  regions: number;
  /** 国都名 */
  seatName: string | null;
  cultureName?: string;
}

/** 开局定制输入:polityId 给国家;不给则按 at 新建;size 可省(默认 8);card 给角色卡字段;autoCard 用引擎算出来的卡 */
export interface CustomStartInput {
  /** 现有国家 id;省略 = 按 at 新建一个国家(或重设本会话已定制的那个) */
  polityId?: number;
  /** 新建国家时君主国家的落点(世界像素 {x,y});省略时回退到最大的无主州 */
  at?: { x: number; y: number };
  /** 目标州数,clamp 3..40;省略时用 8(新建)或保持当前州数(现有国) */
  size?: number;
  /** 角色卡字段:{ name?, persona?, traits?, preferences?, competence? } */
  card?: Record<string, unknown>;
  /** true = 不读 card,按引擎的 monarchCard 自动生成(新国用随机人名占位) */
  autoCard?: boolean;
}

/** applyCustomStart 的返回(路由把 result 直接透给前端) */
export interface CustomStartResult {
  polityId: number;
  /** 应用后的实际州数 */
  regions: number;
  card: MonarchCard;
  warnings: string[];
  created: boolean;
  mode: 'new' | 'existing';
  name: string;
  /** #rrggbb */
  color: string;
  capital: { x: number; y: number } | null;
  seatName: string | null;
  cultureName?: string;
  startYear: number;
  /** civHash(civ):应用后的状态指纹,和应用前不同就说明改动进了当前 civ */
  fingerprint: string;
}

/**
 * 列出这一局开局时可选的现有国家:开局年还活着、且手里有州的国家,州数多的在前。
 * 位置是国都地块的世界像素坐标(与地图点选回调同一坐标系)。
 */
export function listStartNations(s: Session): StartNation[] {
  const civ = s.civ;
  const year = startYearOf(s);
  const sizes = sizesNow(civ);
  const out: StartNation[] = [];
  for (const p of civ.polities) {
    const regions = sizes.get(p.id) ?? 0;
    if (regions <= 0 || !polityAlive(p, year)) continue;
    const seat = civ.settlements[capitalAt(p, year)];
    const capital = seat && seat.cell >= 0 ? pointOf(s, seat.cell) : null;
    out.push({
      polityId: p.id,
      name: polityName(p, year),
      color: hexOf(p.color),
      capital,
      regions,
      seatName: seat ? seat.name : null,
      cultureName: civ.cultures[p.culture]?.name,
    });
  }
  out.sort((a, b) => b.regions - a.regions || a.polityId - b.polityId);
  return out;
}

/**
 * 应用君主开局定制。只允许在第一回合前(rounds === 0)调用。
 *
 * - 给 polityId:用这个现有国家;给 size 则把它的初始疆域扩/缩到目标州数。
 * - 不给 polityId:按 at 找一个陆上州作种子,新建一个国家;size 为初始州数(默认 8)。
 * - 一个会话只定制一个国家;已定制过时只能用同一个 polityId 重设大小/角色卡。
 * - card 里的 name/persona/traits/preferences/competence 会合并进角色卡;autoCard=true 时忽略 card。
 *
 * 返回结果里 regions 是应用后的实际州数,fingerprint 是 civHash(civ)。
 */
export function applyCustomStart(s: Session, input: CustomStartInput = {}): CustomStartResult {
  const year = startYearOf(s);
  if (s.rounds !== 0) {
    throw new Error(`开局定制只能在第一回合前(还没推演)做,当前已经跑了 ${s.rounds} 回合`);
  }
  if (isFinished(s)) throw new Error('这一局已经结束,不能再定制开局');
  if (input.at && (typeof input.at.x !== 'number' || !Number.isFinite(input.at.x) || typeof input.at.y !== 'number' || !Number.isFinite(input.at.y))) {
    throw new Error('at 需要 { x, y } 两个有限数字(世界像素坐标)');
  }

  const warnings: string[] = [];
  const prev = s.customStart;
  const wantId = integerOrUndefined(input.polityId);
  let polityId: number;
  let created = false;

  if (prev) {
    if (wantId !== undefined && wantId !== prev.polityId) {
      throw new Error(`这个会话已经定制过 P${prev.polityId},一个会话只能定制一个国家`);
    }
    polityId = prev.polityId;
    created = prev.created;
    if (!s.civ.polities[polityId]) {
      throw new Error(`之前定制的 P${polityId} 已经不在了,请重新开局`);
    }
  } else if (wantId !== undefined) {
    const p = s.civ.polities[wantId];
    if (!p) throw new Error(`P${wantId} 不存在`);
    if (!polityAlive(p, year) || (sizesNow(s.civ).get(wantId) ?? 0) <= 0) {
      throw new Error(`P${wantId} 在第 ${year} 年已经不在了,换一个国家或新建`);
    }
    polityId = wantId;
    if (typeof input.at === 'object' && input.at) warnings.push('给了 polityId,忽略 at(位置只用于新建国家)');
  } else {
    polityId = createNewNation(s, input, year, warnings);
    created = true;
  }

  // 目标州数:新国在 createNewNation 里已经按 size 扩好;这里处理已有国 / 重设尺寸。
  const sizes = sizesNow(s.civ);
  const current = sizes.get(polityId) ?? 0;
  const requestSize = typeof input.size === 'number' && Number.isFinite(input.size)
    ? clampSize(input.size)
    : undefined;
  if (requestSize !== undefined && requestSize !== current) {
    if (requestSize > current) growTerritory(s, polityId, requestSize, sizes, warnings);
    else shrinkTerritory(s, polityId, requestSize, year, warnings);
  }

  // 改完 civ 换一个对象:edits.ts 的 polityKey 按 civ 对象缓存(WeakMap),不换对象新 id 的键是 undefined。
  s.civ = { ...s.civ };

  const card = buildCard(s, polityId, created, input, warnings);
  s.cards ??= new Map();
  s.cards.set(polityId, card);

  const pinnedCard = created || !cardIsCurrent(s.civ, card, year);
  const p = s.civ.polities[polityId];
  const seat = s.civ.settlements[capitalAt(p, year)];
  const regions = sizesNow(s.civ).get(polityId) ?? 0;
  s.customStart = {
    polityId,
    created,
    pinnedCard,
    appliedYear: year,
    regions,
    warnings: [...warnings],
  };

  return {
    polityId,
    regions,
    card,
    warnings: [...warnings],
    created,
    mode: created ? 'new' : 'existing',
    name: polityName(p, year),
    color: hexOf(p.color),
    capital: seat && seat.cell >= 0 ? pointOf(s, seat.cell) : null,
    seatName: seat ? seat.name : null,
    cultureName: s.civ.cultures[p.culture]?.name,
    startYear: s.startYear,
    fingerprint: civHash(s.civ),
  };
}

/** 开局定制状态(前端判断按钮可不可点、显示已经定制成什么样) */
export function monarchStartStatus(s: Session): Record<string, unknown> {
  const year = startYearOf(s);
  return {
    sessionId: s.id,
    canCustomize: s.rounds === 0 && !isFinished(s),
    year,
    startYear: s.startYear,
    rounds: s.rounds,
    mode: s.mode,
    customStart: s.customStart ?? null,
    cards: s.cards?.size ?? 0,
    pinned: s.customStart?.pinnedCard ?? false,
    nations: s.rounds === 0 && !isFinished(s) ? listStartNations(s).length : 0,
  };
}

// ── 新建国家 ────────────────────────────────────────────────────────────────

/** 在地图上新建君主国家:拿种子州 → BFS 扩到 size → 定国都 → 推 Polity → 预生成国名。返回新 id。 */
function createNewNation(s: Session, input: CustomStartInput, year: number, warnings: string[]): number {
  const civ = s.civ;
  const newId = civ.polities.length;
  const sizes = sizesNow(civ);
  const seedRegion = chooseSeedRegion(s, input.at, year, warnings);

  const owner = civ.polity[seedRegion];
  if (owner >= 0) {
    const ownerSize = sizes.get(owner) ?? 0;
    sizes.set(owner, ownerSize - 1);
    if (ownerSize - 1 <= 0) {
      const victim = civ.polities[owner];
      if (victim && victim.ended === undefined) {
        victim.ended = year;
        warnings.push(`${labelOf(civ, owner, year)} 的最后一块地被拿走,标记第 ${year} 年灭亡`);
      }
    }
  }
  civ.polity[seedRegion] = newId;
  sizes.set(newId, 1);

  const target = typeof input.size === 'number' && Number.isFinite(input.size)
    ? clampSize(input.size)
    : CUSTOM_START_SIZE_DEFAULT;
  growTerritory(s, newId, target, sizes, warnings);
  const cap = pickCapital(s, newId, seedRegion, year, sizes, warnings);

  let culture = pickCulture(civ, newId);
  const alive = alivePolities(civ, year, sizes);
  const biggest = alive[0] ?? null;
  if (culture < 0) {
    if (!biggest) throw new Error('这个年份既没有民族也没有国家,无法新建国家');
    culture = biggest.culture;
    warnings.push('种子州没有有效的民族记录:借用当前最大国家的民族');
  }
  const donor = alive.find((p) => p.culture === culture) ?? biggest;
  const color = pickColor(civ);

  const p: Polity = {
    id: newId,
    name: '',
    culture,
    capital: cap.settlement,
    founded: year,
    kind: donor?.kind ?? civ.cultures[culture]?.kind ?? 'farm',
    expansionism: donor ? Math.round(donor.expansionism) : 50,
    color: [color[0], color[1], color[2]],
    titles: [{ year, tier: 0 }],
    capitals: [{ year, settlement: cap.settlement }],
  };
  if (donor?.lineage !== undefined) p.lineage = donor.lineage;
  civ.polities.push(p);

  // 预生成国名/语感:模拟引擎 settle 的做法——所有国名先清零,再整体跑一遍 namePolities。
  const staged = civ.polities.map((q): Polity => {
    const copy: Polity = { ...q, name: '' };
    if (q.dynasties) copy.dynasties = q.dynasties.map((d) => ({ ...d, name: '' }));
    return copy;
  });
  namePolities(civ.seed, staged, civ.cultures, { settlements: civ.settlements, regionNames: civ.regions.name });
  const predicted = staged[newId];
  if (predicted) {
    p.name = predicted.name;
    p.eastern = predicted.eastern;
  }
  if (!p.name) warnings.push('没能预生成国名:第一回合结算后会由引擎起名');
  warnings.push(`国名/颜色在第一回合结算时会被引擎按全图规则重算(预览可能与结算后略有出入),州数与角色卡不受影响`);
  return newId;
}

/** 种子州:给了 at 取最近陆上州;没给回退到最大的无主州;落点属于小国时尽量改到附近无主州。 */
function chooseSeedRegion(s: Session, at: { x: number; y: number } | undefined, year: number, warnings: string[]): number {
  const civ = s.civ;
  let region: number;
  if (at) {
    region = nearestRegionAt(s, at);
    if (region < 0) throw new Error('这个点附近找不到陆上州(可能落在海面),请换一个位置');
  } else {
    region = defaultSeedRegion(s, year, warnings);
  }
  const owner = civ.polity[region];
  if (owner >= 0) {
    const sizes = sizesNow(civ);
    const ownerSize = sizes.get(owner) ?? 0;
    if (ownerSize < CUSTOM_START_SIZE_MIN) {
      const alt = at ? nearestUnownedRegionAt(s, at) : -1;
      if (alt >= 0) {
        warnings.push(`落点属于小国 ${labelOf(civ, owner, year)}(只剩 ${ownerSize} 州),改在最近的无主州开局`);
        return alt;
      }
      warnings.push(`落点属于小国 ${labelOf(civ, owner, year)}(只剩 ${ownerSize} 州),开局会把它最后的地拿走`);
    } else {
      warnings.push(`落点从 ${labelOf(civ, owner, year)} 手里接管(该国有 ${ownerSize} 州)`);
    }
  }
  return region;
}

/** 没给落点:最大的无主州;没有无主州就落最大国家的国都州;再不行第一个州。 */
function defaultSeedRegion(s: Session, year: number, warnings: string[]): number {
  const civ = s.civ;
  let best = -1;
  let bestCap = -1;
  for (let r = 0; r < civ.regions.count; r++) {
    if (civ.polity[r] !== -1) continue;
    const cap = civ.regions.capacity[r];
    if (cap > bestCap) {
      bestCap = cap;
      best = r;
    }
  }
  if (best >= 0) {
    warnings.push('没有给落点:落在当前最大的无主州');
    return best;
  }
  const sizes = sizesNow(civ);
  const alive = alivePolities(civ, year, sizes);
  if (alive.length) {
    const seat = civ.settlements[capitalAt(alive[0], year)];
    if (seat && seat.region >= 0) {
      warnings.push('地图上没有无主州:落在最大国家的国都附近');
      return seat.region;
    }
  }
  for (let r = 0; r < civ.regions.count; r++) {
    const cell = civ.regions.seat[r];
    if (cell >= 0) {
      warnings.push('没有可用落点:回退到第一个陆上州');
      return r;
    }
  }
  throw new Error('这个世界没有可用的陆上州');
}

// ── 疆域扩张/收缩 ────────────────────────────────────────────────────────────

/** 从已有领土 BFS 往外扩到 target 州:先陆上,不够再允许跨海/海峡;只抢州数 >= 3 的国家。 */
function growTerritory(s: Session, polityId: number, target: number, sizes: Map<number, number>, warnings: string[]): number {
  const civ = s.civ;
  const year = startYearOf(s);
  const count = (): number => {
    let n = 0;
    for (let r = 0; r < civ.regions.count; r++) if (civ.polity[r] === polityId) n++;
    return n;
  };
  const pass = (allowSea: boolean): void => {
    let owned = count();
    if (owned >= target) return;
    const seen = new Set<number>();
    const queue: number[] = [];
    for (let r = 0; r < civ.regions.count; r++) {
      if (civ.polity[r] === polityId) {
        seen.add(r);
        queue.push(r);
      }
    }
    for (let qi = 0; qi < queue.length && owned < target; qi++) {
      const r = queue[qi];
      for (const nb of regionNeighbors(civ, r, allowSea)) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        if (owned >= target) break;
        const owner = civ.polity[nb];
        if (owner === polityId) continue;
        if (owner >= 0) {
          const os = sizes.get(owner) ?? 0;
          if (os < CUSTOM_START_SIZE_MIN) continue; // 留给小国一条活路
          sizes.set(owner, os - 1);
          if (os - 1 <= 0) {
            const victim = civ.polities[owner];
            if (victim && victim.ended === undefined) {
              victim.ended = year;
              warnings.push(`${labelOf(civ, owner, year)} 被拿空,标记第 ${year} 年灭亡`);
            }
          }
        }
        civ.polity[nb] = polityId;
        owned++;
        queue.push(nb);
      }
    }
  };

  pass(false);
  let got = count();
  if (got < target) {
    pass(true);
    got = count();
    if (got < target) warnings.push(`实际只扩到 ${got} 州(目标 ${target}):周围没有更多可以拿的地了`);
    else warnings.push('陆地不够,跨海峡/航线取了几个州');
  }
  return got;
}

/** 把现有国家的初始疆域缩到 target 州:从国都 BFS 保内圈,外圈放回无主。 */
function shrinkTerritory(s: Session, polityId: number, target: number, year: number, warnings: string[]): number {
  const civ = s.civ;
  const p = civ.polities[polityId];
  const seat = civ.settlements[capitalAt(p, year)];
  const seatRegion = seat && seat.region >= 0 ? seat.region : -1;
  const order: number[] = [];
  const seen = new Set<number>();
  const queue: number[] = [];
  const enqueue = (r: number): void => {
    if (r < 0 || r >= civ.regions.count || civ.polity[r] !== polityId || seen.has(r)) return;
    seen.add(r);
    queue.push(r);
    order.push(r);
  };
  enqueue(seatRegion);
  for (let qi = 0; qi < queue.length; qi++) {
    for (const nb of regionNeighbors(civ, queue[qi], true)) enqueue(nb);
  }
  for (let r = 0; r < civ.regions.count; r++) enqueue(r); // 飞地也按顺序补在最后
  const keep = new Set(order.slice(0, target));
  let released = 0;
  for (const r of order) {
    if (keep.has(r)) continue;
    civ.polity[r] = -1;
    released++;
  }
  if (released > 0) warnings.push(`缩到 ${target} 州:放掉 ${released} 州(变无主)`);
  if (order.length < target) warnings.push(`这个国家本来只有 ${order.length} 州,没有缩到 ${target}`);
  return Math.min(order.length, target);
}

/** 定国都:优先领土内还活着的城;没有就用领土内废弃城;再没有就把最近的一座城连州一起拿过来。 */
function pickCapital(
  s: Session,
  polityId: number,
  seedRegion: number,
  year: number,
  sizes: Map<number, number>,
  warnings: string[],
): { settlement: number; region: number } {
  const civ = s.civ;
  const ownRegions = new Set<number>();
  for (let r = 0; r < civ.regions.count; r++) if (civ.polity[r] === polityId) ownRegions.add(r);

  const pickBest = (aliveOnly: boolean): number => {
    let best = -1;
    let bestCap = -1;
    for (const st of civ.settlements) {
      if (!ownRegions.has(st.region)) continue;
      if (aliveOnly && st.ended !== undefined && st.ended <= year) continue;
      if (st.capacity > bestCap) {
        bestCap = st.capacity;
        best = st.id;
      }
    }
    return best;
  };

  let best = pickBest(true);
  if (best < 0) {
    best = pickBest(false);
    if (best >= 0) warnings.push('新国家领土里没有活城:用一座废弃的城当国都');
  }
  if (best < 0) {
    const seedCell = civ.regions.seat[seedRegion];
    let nearest = -1;
    let nearestD = Number.POSITIVE_INFINITY;
    for (const st of civ.settlements) {
      if (st.cell < 0) continue;
      const d = pointDistance(s, seedCell, st.cell);
      if (d < nearestD) {
        nearestD = d;
        nearest = st.id;
      }
    }
    if (nearest < 0) throw new Error('当前年份地图上还没有城,无法新建国家');
    const st = civ.settlements[nearest];
    const region = st.region;
    if (region < 0) throw new Error('找到的城没有所属州,无法新建国家');
    if (civ.polity[region] !== polityId) {
      const owner = civ.polity[region];
      if (owner >= 0) {
        const os = sizes.get(owner) ?? 0;
        sizes.set(owner, os - 1);
        if (os - 1 <= 0) {
          const victim = civ.polities[owner];
          if (victim && victim.ended === undefined) {
            victim.ended = year;
            warnings.push(`${labelOf(civ, owner, year)} 被拿空,标记第 ${year} 年灭亡`);
          }
        }
      }
      civ.polity[region] = polityId;
      warnings.push('领土里没有城:把最近的一座城连同它的州一起拿过来当国都');
    }
    best = nearest;
  }
  const st = civ.settlements[best];
  return { settlement: best, region: st.region };
}

/** 种子州/领土里的民族;没有就沿领土边界找一个有效民族。 */
function pickCulture(civ: Civ, polityId: number): number {
  const valid = (c: number): boolean => c >= 0 && c < civ.cultures.length;
  for (let r = 0; r < civ.regions.count; r++) {
    if (civ.polity[r] === polityId && valid(civ.culture[r])) return civ.culture[r];
  }
  for (let r = 0; r < civ.regions.count; r++) {
    if (civ.polity[r] !== polityId) continue;
    for (const nb of regionNeighbors(civ, r, true)) {
      if (valid(civ.culture[nb])) return civ.culture[nb];
    }
  }
  return -1;
}

/** 取一个没被占用的调色板颜色。 */
function pickColor(civ: Civ): [number, number, number] {
  const used = new Set<string>();
  for (const p of civ.polities) used.add(p.color.join(','));
  for (const c of POLITY_PALETTE) {
    if (!used.has(c.join(','))) return [c[0], c[1], c[2]];
  }
  const fallback = POLITY_PALETTE[civ.polities.length % POLITY_PALETTE.length];
  return [fallback[0], fallback[1], fallback[2]];
}

// ── 角色卡 ──────────────────────────────────────────────────────────────────

/** 用 monarchCard 作底,合并 card 里的字段;autoCard 时直接用引擎生成的卡。 */
function buildCard(s: Session, polityId: number, created: boolean, input: CustomStartInput, warnings: string[]): MonarchCard {
  const year = startYearOf(s);
  const base = monarchCard(s.civ, polityId, year);
  if (!base) throw new Error(`P${polityId} 还建不出角色卡`);
  const raw = input.card && typeof input.card === 'object' && !Array.isArray(input.card)
    ? input.card as Record<string, unknown>
    : undefined;

  if (input.autoCard === true && !raw) {
    if (!created) return base;
    const card: MonarchCard = { ...base, name: defaultMonarchName(s, polityId) };
    card.persona = personaOf(card);
    return card;
  }
  if (input.autoCard === true) warnings.push('autoCard=true:忽略传入的角色卡字段');

  const card = cleanCardInput(raw ?? {}, base);
  const rawName = raw && typeof raw.name === 'string' ? raw.name.trim().slice(0, 16) : '';
  const name = rawName || (created ? defaultMonarchName(s, polityId) : '');
  if (name) {
    card.name = name;
    card.persona = personaOf(card);
  } else if (raw && typeof raw.persona === 'string') {
    // cleanCardInput 已收下 persona;没有改名时保留它
  }
  return card;
}

/** 新国还没有推演君主,先用现成的姓名生成器起一个占位名(引擎第一回合后会生成真正的在位君主)。 */
function defaultMonarchName(s: Session, polityId: number): string {
  const civ = s.civ;
  const p = civ.polities[polityId];
  const year = startYearOf(s);
  const style = civ.cultures[p.culture]?.style ?? 'kingdom';
  const namer = createPersonNamer(civ.seed, style);
  const surname = namer.surname(polityId, year);
  const given = namer.given(polityId, year);
  const name = namer.surnamed ? `${surname}${given}` : given;
  return (name || surname || `${polityId} 号君主`).slice(0, 16);
}

// ── 坐标 / 邻接 / 杂项 ──────────────────────────────────────────────────────

function startYearOf(s: Session): number {
  return Math.floor(s.play.year);
}

function clampSize(size: number): number {
  return Math.max(CUSTOM_START_SIZE_MIN, Math.min(CUSTOM_START_SIZE_MAX, Math.round(size)));
}

function integerOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

function pointOf(s: Session, cell: number): { x: number; y: number } {
  const mesh = s.world.mesh;
  return { x: mesh.x[cell], y: mesh.y[cell] };
}

/** 两地块中心的世界距离(经度方向绕一圈取近的)。 */
function pointDistance(s: Session, a: number, b: number): number {
  const mesh = s.world.mesh;
  const width = s.world.width;
  let dx = Math.abs(mesh.x[a] - mesh.x[b]);
  if (dx > width / 2) dx = width - dx;
  const dy = mesh.y[a] - mesh.y[b];
  return Math.hypot(dx, dy);
}

/** 世界像素点 → 最近的地块(只在有州的陆地上找)。 */
function nearestCellAt(s: Session, x: number, y: number): number {
  const of = s.civ.regions.of;
  const mesh = s.world.mesh;
  const width = s.world.width;
  let best = -1;
  let bestD = Number.POSITIVE_INFINITY;
  for (let cell = 0; cell < mesh.n; cell++) {
    if (of[cell] < 0) continue;
    let dx = Math.abs(x - mesh.x[cell]);
    if (dx > width / 2) dx = width - dx;
    const dy = y - mesh.y[cell];
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = cell;
    }
  }
  return best;
}

/** 世界像素点 → 最近的陆上州;找不到返回 -1。 */
function nearestRegionAt(s: Session, at: { x: number; y: number }): number {
  const cell = nearestCellAt(s, at.x, at.y);
  return cell >= 0 ? s.civ.regions.of[cell] : -1;
}

/** 世界像素点 → 最近的无主州;没有返回 -1。 */
function nearestUnownedRegionAt(s: Session, at: { x: number; y: number }): number {
  const civ = s.civ;
  const mesh = s.world.mesh;
  const width = s.world.width;
  let best = -1;
  let bestD = Number.POSITIVE_INFINITY;
  for (let r = 0; r < civ.regions.count; r++) {
    if (civ.polity[r] !== -1) continue;
    const cell = civ.regions.seat[r];
    if (cell < 0) continue;
    let dx = Math.abs(at.x - mesh.x[cell]);
    if (dx > width / 2) dx = width - dx;
    const dy = at.y - mesh.y[cell];
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = r;
    }
  }
  return best;
}

/** 州的邻接(allowSea=false 时只取陆地相邻:Flat/River/Mountain)。 */
function regionNeighbors(civ: Civ, region: number, allowSea: boolean): number[] {
  const { adjStart, adj, adjKind } = civ.regions;
  const out: number[] = [];
  for (let k = adjStart[region]; k < adjStart[region + 1]; k++) {
    if (!allowSea && adjKind[k] > LAND_EDGE_MAX) continue;
    out.push(adj[k]);
  }
  return out;
}

function alivePolities(civ: Civ, year: number, sizes: Map<number, number>): Polity[] {
  return civ.polities
    .filter((p) => polityAlive(p, year) && (sizes.get(p.id) ?? 0) > 0)
    .sort((a, b) => (sizes.get(b.id) ?? 0) - (sizes.get(a.id) ?? 0) || a.id - b.id);
}

function labelOf(civ: Civ, polityId: number, year: number): string {
  const p = civ.polities[polityId];
  return p ? `${polityName(p, year)}(P${polityId})` : `P${polityId}`;
}

function hexOf(color: readonly number[]): string {
  let out = '#';
  for (let i = 0; i < 3; i++) {
    const v = Math.max(0, Math.min(255, Math.round(color[i] ?? 0)));
    out += v.toString(16).padStart(2, '0');
  }
  return out;
}
