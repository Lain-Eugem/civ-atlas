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
import type { NationControl, Session } from './engine';
import { civHash, isFinished, nationControlOf, nationControlView, sizesNow } from './engine';
import type { Annal, Civ, Polity, Settlement } from '../src/gen/civ/types';
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
/** 开局国家数量下限(与 plan §P1 的 3–30 一致) */
export const START_COUNT_MIN = 3;
/** 开局国家数量上限 */
export const START_COUNT_MAX = 30;
/** 按数量补建国家时,新国家默认州数 */
export const START_ADD_SIZE_DEFAULT = 6;

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
  /**
   * 精确州号数组(连续点选的结果),优先于 size / at:
   * - 已有国:把这个国家的疆域正好设成这些州(原来的其余州变无主,被拿州的原主可能灭亡)
   * - 新建国:拿这些州建国(可以同时含无主州和别国的州;不强制连通,允许飞地)
   * 给了 regionIds 就忽略 size 与 at。
   */
  regionIds?: number[];
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
  // 连续点选的结果:先严格校验,全部合法才开始改,避免半途抛错留下脏状态。
  const regionIds = readRegionIds(s, input.regionIds);

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
    polityId = regionIds ? createNationFromRegions(s, regionIds, year, warnings) : createNewNation(s, input, year, warnings);
    created = true;
  }

  if (regionIds) {
    // 连续点选:regionIds 优先于 size / at,按所选州精确设置疆域。
    if (typeof input.size === 'number') warnings.push('给了 regionIds,忽略 size(按所选州精确设置)');
    if (input.at) warnings.push('给了 regionIds,忽略 at(落点只用于按大小扩地)');
    if (!created) {
      const before = sizesNow(s.civ).get(polityId) ?? 0;
      const ctx = customStartCtx(year, warnings);
      installRegions(s, polityId, regionIds, year, ctx);
      const target = s.civ.polities[polityId];
      if (target) {
        const capRegion = capitalRegionOf(s.civ, target, year);
        // 首都州没被选中:沿用现有规则从剩下的州里随机迁都(capitals 追加一条)
        if (!regionIds.includes(capRegion)) migrateCapital(s, polityId, ctx);
        const after = sizesNow(s.civ).get(polityId) ?? 0;
        warnings.push(`按所选州设置疆域:现在 ${after} 州(原 ${before} 州)`);
      }
    }
  } else {
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

  finishNewPolity(s, newId, cap, year, warnings);
  return newId;
}

/**
 * 新国家的收尾:定民族 → 借最大国家的族群特征 / 颜色 → 推入 civ.polities → 预生成国名。
 * createNewNation(按 size 扩地)与 createNationFromRegions(按连续点选的州)共用。
 */
function finishNewPolity(
  s: Session,
  newId: number,
  cap: { settlement: number; region: number },
  year: number,
  warnings: string[],
): void {
  const civ = s.civ;
  let culture = pickCulture(civ, newId);
  const sizes = sizesNow(civ);
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
}

/**
 * 按"连续点选"的州号数组新建国家:拿这些州(允许同时是无主州和别国的州),
 * 选中的州里没有城时把最近一座城连州一起拿来定都;被拿空的国家走 endNation 收尾。
 */
function createNationFromRegions(s: Session, regionIds: number[], year: number, warnings: string[]): number {
  const civ = s.civ;
  const newId = civ.polities.length;
  const ctx = customStartCtx(year, warnings);
  const ids = [...regionIds];

  // 先确认定都方案(全在内存副本上,不动 civ)
  let capSettlement = pickSettlementInRegions(civ, ids, ids[0]!);
  if (capSettlement < 0) {
    const seedCell = civ.regions.seat[ids[0]!];
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
    if (nearest < 0) throw new Error('这个年份地图上还没有城,无法新建国家');
    const st = civ.settlements[nearest]!;
    if (st.region < 0) throw new Error('找到的城没有所属州,无法新建国家');
    if (!ids.includes(st.region)) ids.push(st.region);
    capSettlement = nearest;
    warnings.push('所选州里没有城:把最近的一座城连同它的州一起拿来当国都');
  }

  // 拿地:被拿空的国家整国灭亡(清战争 / 条约 / 角色卡 / 控制方式等)
  const sizes = sizesNow(civ);
  const stolen = new Map<number, number>();
  for (const r of ids) {
    const owner = civ.polity[r];
    if (owner >= 0) {
      stolen.set(owner, (stolen.get(owner) ?? 0) + 1);
      sizes.set(owner, (sizes.get(owner) ?? 1) - 1);
      if ((sizes.get(owner) ?? 0) <= 0) endNation(s, owner, ctx, 'remove');
    }
    civ.polity[r] = newId;
    sizes.set(newId, (sizes.get(newId) ?? 0) + 1);
  }
  for (const [owner, n] of stolen) {
    const p = civ.polities[owner];
    if (p) warnings.push(`从「${polityName(p, year)}」手里接管 ${n} 州`);
  }
  const capRegion = civ.settlements[capSettlement]!.region;
  finishNewPolity(s, newId, { settlement: capSettlement, region: capRegion }, year, warnings);
  warnings.push(`新国家按所选 ${ids.length} 个州建立`);
  return newId;
}

/** 开局定制用的最小 SetupContext:只为复用 endNation / migrateCapital 的收尾逻辑 */
function customStartCtx(year: number, warnings: string[]): SetupContext {
  return {
    year,
    force: false,
    warnings,
    removed: [],
    added: [],
    resized: [],
    movedCapitals: [],
    warsEnded: [],
    treatiesEnded: [],
    needConfirm: [],
  };
}

/** 已有国按所选州精确设置疆域:原国其余州变无主,被拿州的原主可能灭亡(走 endNation) */
function installRegions(s: Session, polityId: number, regionIds: number[], year: number, ctx: SetupContext): void {
  const civ = s.civ;
  const want = new Set(regionIds);
  const sizes = sizesNow(civ);
  let released = 0;
  for (const r of ownRegions(civ, polityId)) {
    if (want.has(r)) continue;
    civ.polity[r] = -1;
    sizes.set(polityId, (sizes.get(polityId) ?? 1) - 1);
    released++;
  }
  const stolen = new Map<number, number>();
  let taken = 0;
  for (const r of regionIds) {
    if (civ.polity[r] === polityId) continue;
    const owner = civ.polity[r];
    if (owner >= 0) {
      stolen.set(owner, (stolen.get(owner) ?? 0) + 1);
      sizes.set(owner, (sizes.get(owner) ?? 1) - 1);
      if ((sizes.get(owner) ?? 0) <= 0) endNation(s, owner, ctx, 'remove');
    }
    civ.polity[r] = polityId;
    sizes.set(polityId, (sizes.get(polityId) ?? 0) + 1);
    taken++;
  }
  if (released) ctx.warnings.push(`按所选州设置:放掉 ${released} 州(变无主)`);
  for (const [owner, n] of stolen) {
    const p = civ.polities[owner];
    if (p) ctx.warnings.push(`从「${polityName(p, year)}」手里接管 ${n} 州`);
  }
  if (taken) ctx.warnings.push(`按所选州设置:接管 ${taken} 州`);
}

/** 校验 regionIds(严格整数州号,去重,范围内,非空);没给返回 null */
function readRegionIds(s: Session, raw: unknown): number[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw new Error('regionIds 要是州号数组');
  const out: number[] = [];
  for (const v of raw) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
    if (!Number.isInteger(n)) throw new Error(`regionIds 里 ${JSON.stringify(v)} 不是整数州号`);
    if (n < 0 || n >= s.civ.regions.count) {
      throw new Error(`regionIds 里州 ${n} 越界(这个世界共 ${s.civ.regions.count} 个州)`);
    }
    if (!out.includes(n)) out.push(n);
  }
  if (!out.length) throw new Error('regionIds 不能是空数组(至少要选一个州)');
  return out;
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

// ── 开局国家设置:数量 / 控制方式 / 增删 ──────────────────────────────────────

/**
 * 第一回合推演之前,一次性定下「这一局有哪些国家、谁由 AI 君主接管、谁交给引擎自动推演」。
 * 与 applyCustomStart 的区别:这里管整张名单(增删 + 数量),applyCustomStart 只管一个君主国家。
 * 两者都只能在 rounds === 0 时调用;本函数每个会话只能应用一次。
 *
 * 删国规则(plan §0.3-4):
 * - 删掉的国家:它的州全部变无主(civ.polity[r] = -1),国家标记 ended = 开局年;
 * - 删到首都州(还有别的州):从保留的州里挑一个作为新国都,capitals 里追加一条;
 * - 删到最后一州:没传 force 就抛错让人确认;force = true 才把整个国家删掉。
 * 删国同时清:进行中的战争(补 peace 史事)、进行中的条约(补 expire 史事)、
 * 角色卡 / 君主记忆 / 渗透情报 / 控制方式 / 玩家席位 / 开局定制记录 / 君主配置名单。
 */
export interface StartNationSpec {
  /** 现有国家 id;省略 = 按 at(或不给落点)新建一个国家 */
  polityId?: number;
  /** 新建时的落点(世界像素坐标,与地图点选回调同一坐标系) */
  at?: { x: number; y: number };
  /** 目标州数:新建默认 6,现有国省略 = 不调;给了 regionIds 时忽略 */
  size?: number;
  /** 精确州号数组(优先于 size / at):新建=拿这些州建国,现有国=正好设成这些州 */
  regionIds?: number[];
  /** 角色卡字段(与 applyCustomStart 的 card 同义) */
  card?: Record<string, unknown>;
  /** true = 不读 card,按引擎的 monarchCard 自动生成 */
  autoCard?: boolean;
  /** 这个国家由谁控制;省略 = 按会话 mode 缺省(monarch 会话默认 ai) */
  control?: NationControl;
}

/** 开局国家设置输入(openSession.setup 与 POST /api/session/start-setup 同一形状) */
export interface StartSetupInput {
  /** 应用后保留的国家数量(3–30):少了删最小的,多了补建 */
  count?: number;
  /** 新建 / 调整现有国家 */
  nations?: StartNationSpec[];
  /** 整国删除(州全部变无主;会清战争/条约/角色卡等) */
  remove?: number[];
  /** 只删几个州(州变无主;删到首都州会随机迁都;删成最后一州要 force) */
  removeRegions?: number[];
  /** 每国控制方式:{ "3": "ai", "5": "program" } */
  controls?: Record<string, NationControl>;
  /** 允许把删到最后一州的国家整个删掉(前端确认对话框后传 true) */
  force?: boolean;
}

/** 已应用的开局国家设置(存在 Session.startSetup;一次性) */
export interface StartSetupState {
  appliedYear: number;
  /** 应用后的国家数 */
  count: number;
  /** 用户要求的目标国家数(没给 = null) */
  targetCount: number | null;
  /** 实际写进 Session.nationControl 的显式覆盖(国家编号 → 控制方式) */
  controls: Record<string, NationControl>;
  /** 这次删掉的国家编号 */
  removed: number[];
  /** 这次新建的国家编号 */
  added: number[];
  warnings: string[];
}

/** 迁都记录 */
export interface StartSetupCapitalMove {
  polityId: number;
  name: string;
  fromRegion: number;
  fromCapital: string | null;
  toRegion: number;
  toCapital: string | null;
}

/** applyStartSetup 的返回(路由原样透给前端) */
export interface StartSetupResult extends StartSetupState {
  sessionId: string;
  startYear: number;
  /** 被改过州数的现有国家 */
  resized: { polityId: number; name: string; regions: number }[];
  movedCapitals: StartSetupCapitalMove[];
  warsEnded: { war: number; a: number; b: number }[];
  treatiesEnded: number[];
  /** force=false 时删到最后一州的国家(同时挂在抛出的 error.needConfirm 上) */
  needConfirm: { polityId: number; name: string; regions: number; message: string }[];
  applied: true;
  fingerprint: string;
}

interface SetupContext {
  year: number;
  force: boolean;
  warnings: string[];
  removed: number[];
  added: number[];
  resized: StartSetupResult['resized'];
  movedCapitals: StartSetupCapitalMove[];
  warsEnded: StartSetupResult['warsEnded'];
  treatiesEnded: number[];
  needConfirm: StartSetupResult['needConfirm'];
}

/** 开局国家设置能不能做:第一回合前、会话没结束、还没应用过 */
export function canSetupStart(s: Session): boolean {
  return s.rounds === 0 && !isFinished(s) && !s.startSetup;
}

/** 开局面板需要的名单与状态(GET /api/start/config 用) */
export function startConfigStatus(s: Session): Record<string, unknown> {
  const year = startYearOf(s);
  const nations = listStartNations(s).map((n) => ({ ...n, control: nationControlOf(s, n.polityId) }));
  let owned = 0;
  for (let r = 0; r < s.civ.regions.count; r++) if (s.civ.polity[r] >= 0) owned++;
  return {
    sessionId: s.id,
    year,
    startYear: s.startYear,
    rounds: s.rounds,
    canSetup: canSetupStart(s),
    applied: s.startSetup ? cloneSetupState(s.startSetup) : null,
    pending: s.pendingStartSetup ?? null,
    count: nations.length,
    min: START_COUNT_MIN,
    max: START_COUNT_MAX,
    control: nationControlView(s),
    regions: { total: s.civ.regions.count, owned, unowned: s.civ.regions.count - owned },
    nations,
  };
}

/**
 * 应用开局国家设置。只允许在第一回合前调用,每个会话只能应用一次。
 * 参数省略时用 openSession 带进来的 setup(pendingStartSetup)。
 */
export function applyStartSetup(s: Session, setupIn?: StartSetupInput): StartSetupResult {
  const year = startYearOf(s);
  if (s.rounds !== 0) throw new Error(`开局国家设置只能在第一回合前(还没推演)做,当前已经跑了 ${s.rounds} 回合`);
  if (isFinished(s)) throw new Error('这一局已经结束,不能再改开局国家');
  if (s.startSetup) throw new Error('开局国家设置已经应用过,一个会话只能应用一次;要改请重开一局');
  const setup = setupIn ?? s.pendingStartSetup ?? {};
  if (!setup || typeof setup !== 'object' || Array.isArray(setup)) {
    throw new Error('setup 要是 { count?, nations?, remove?, removeRegions?, controls?, force? } 对象');
  }

  const ctx: SetupContext = {
    year,
    force: setup.force === true,
    warnings: [],
    removed: [],
    added: [],
    resized: [],
    movedCapitals: [],
    warsEnded: [],
    treatiesEnded: [],
    needConfirm: [],
  };

  /* ---- 1. 解析 + 预校验(全部通过才开始改,避免半途抛错留下脏状态) ---- */
  const removeIds = readIdList(setup.remove, 'remove');
  const removeRegions = readRegionList(setup.removeRegions, s.civ.regions.count);
  const specs = readNations(setup.nations, s.civ.regions.count);
  const controls = readControls(setup.controls);
  const targetCount = setup.count === undefined || setup.count === null ? null : readCount(setup.count);
  const sizes0 = sizesNow(s.civ);

  const removedSet = new Set(removeIds);
  for (const id of removeIds) {
    const p = s.civ.polities[id];
    if (!p) throw new Error(`P${id} 不存在,不能删除`);
    if (!polityAlive(p, year) || (sizes0.get(id) ?? 0) <= 0) throw new Error(`P${id} 在第 ${year} 年已经不在了,不能删除`);
  }
  // 只删州时,算每个国家还剩几州:删到 0 州要 force 才继续
  const left = new Map<number, number>();
  for (const [id, n] of sizes0) left.set(id, n);
  for (const id of removeIds) left.set(id, 0);
  const regionSet = new Set<number>();
  for (const r of removeRegions) {
    const owner = s.civ.polity[r];
    if (owner < 0) throw new Error(`州 ${r} 本来就是无主的(或已随国家删掉),不用再删`);
    if (removedSet.has(owner)) continue;
    left.set(owner, (left.get(owner) ?? 0) - 1);
    regionSet.add(r);
  }
  if (!ctx.force) {
    for (const [id, n] of left) {
      if (removedSet.has(id)) continue; // 整国删 = 已确认
      if (n > 0 || (sizes0.get(id) ?? 0) <= 0) continue;
      let touched = false;
      for (let r = 0; r < s.civ.regions.count; r++) {
        if (s.civ.polity[r] === id && regionSet.has(r)) { touched = true; break; }
      }
      if (!touched) continue;
      const p = s.civ.polities[id]!;
      const name = polityName(p, year);
      ctx.needConfirm.push({ polityId: id, name, regions: sizes0.get(id) ?? 0, message: lastRegionMessage(name) });
    }
  }
  if (ctx.needConfirm.length) {
    const err = new Error(ctx.needConfirm.map((c) => c.message).join(' ')) as Error & { needConfirm?: unknown };
    err.needConfirm = ctx.needConfirm;
    throw err;
  }
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    if (spec.polityId !== undefined) {
      const p = s.civ.polities[spec.polityId];
      if (!p) throw new Error(`nations[${i}]:P${spec.polityId} 不存在`);
      if (removedSet.has(spec.polityId)) throw new Error(`nations[${i}]:P${spec.polityId} 同时在 remove 里,不能既删又改`);
      if (!polityAlive(p, year) || (sizes0.get(spec.polityId) ?? 0) <= 0) throw new Error(`nations[${i}]:P${spec.polityId} 在第 ${year} 年已经不在了`);
    }
    if (spec.control !== undefined && spec.control !== 'ai' && spec.control !== 'program') {
      throw new Error(`nations[${i}]:control 只能是 "ai" 或 "program"`);
    }
  }

  /* ---- 2. 删国家 / 删州 ---- */
  for (const id of removeIds) removeNation(s, id, ctx);
  for (const r of removeRegions) {
    if (!regionSet.has(r)) continue; // 属于被整国删掉的,已经无主
    removeOneRegion(s, r, ctx, false);
  }

  /* ---- 3. nations:新建 / 调州数 / 按所选州精确设置 ---- */
  for (const spec of specs) {
    let id: number;
    if (spec.polityId !== undefined) {
      id = spec.polityId;
      if (spec.regionIds) {
        if (spec.size !== undefined) ctx.warnings.push(`nations:P${id} 给了 regionIds,忽略 size`);
        installRegions(s, id, spec.regionIds, year, ctx);
        const p = s.civ.polities[id];
        if (p) {
          const capRegion = capitalRegionOf(s.civ, p, year);
          if (!spec.regionIds.includes(capRegion)) migrateCapital(s, id, ctx);
          const after = sizesNow(s.civ).get(id) ?? 0;
          ctx.resized.push({ polityId: id, name: polityName(p, year), regions: after });
          ctx.warnings.push(`P${id} 按所选 ${spec.regionIds.length} 州设置疆域:现在 ${after} 州`);
        }
      } else {
        const current = sizesNow(s.civ).get(id) ?? 0;
        const want = spec.size === undefined ? undefined : clampSize(spec.size);
        if (want !== undefined && want !== current) {
          const sizes = sizesNow(s.civ);
          if (want > current) growTerritory(s, id, want, sizes, ctx.warnings);
          else shrinkTerritory(s, id, want, year, ctx.warnings);
          const after = sizesNow(s.civ).get(id) ?? 0;
          if (after !== current) {
            const p = s.civ.polities[id]!;
            ctx.resized.push({ polityId: id, name: polityName(p, year), regions: after });
          }
        }
      }
    } else {
      try {
        id = spec.regionIds
          ? createNationFromRegions(s, spec.regionIds, year, ctx.warnings)
          : createNewNation(s, { at: spec.at, size: spec.size ?? START_ADD_SIZE_DEFAULT }, year, ctx.warnings);
      } catch (e) {
        ctx.warnings.push(`新建国家失败:${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      ctx.added.push(id);
      addStartCard(s, id, ctx, spec.card, spec.autoCard === true);
    }
    if (spec.control !== undefined) {
      const p = s.civ.polities[id];
      if (p && polityAlive(p, year) && (sizesNow(s.civ).get(id) ?? 0) > 0) s.nationControl.set(id, spec.control);
      else ctx.warnings.push(`nations:应用后 P${id} 已经不在,忽略它的 control`);
    }
  }

  /* ---- 4. 数量:多删("最小"的先走)少补(默认 6 州) ---- */
  if (targetCount !== null) {
    let guard = 0;
    for (;;) {
      const alive = aliveNow(s, year);
      if (alive.length === targetCount) break;
      if (guard++ > Math.abs(alive.length - targetCount) + 30) {
        ctx.warnings.push('数量调整没有收敛,先停在当前数量');
        break;
      }
      if (alive.length > targetCount) {
        const victim = [...alive].sort((a, b) => a.regions - b.regions || b.polityId - a.polityId)[0]!;
        removeNation(s, victim.polityId, ctx);
      } else {
        const before = alive.length;
        try {
          const id = createNewNation(s, { size: START_ADD_SIZE_DEFAULT }, year, ctx.warnings);
          ctx.added.push(id);
          addStartCard(s, id, ctx);
        } catch (e) {
          ctx.warnings.push(`补建国家失败:${e instanceof Error ? e.message : String(e)}`);
          break;
        }
        if (aliveNow(s, year).length <= before) {
          ctx.warnings.push('补建国家没有让总数变多:地图上没有可拿的州了');
          break;
        }
      }
    }
  }

  /* ---- 5. 控制方式:写显式覆盖,清掉已经不在的国家 ---- */
  for (const [k, v] of Object.entries(controls)) {
    const id = Number(k);
    const p = s.civ.polities[id];
    if (!p || !polityAlive(p, year) || (sizesNow(s.civ).get(id) ?? 0) <= 0) {
      ctx.warnings.push(`controls 里的 P${id} 应用后已经不在,忽略`);
      continue;
    }
    s.nationControl.set(id, v);
  }
  for (const id of [...s.nationControl.keys()]) {
    const p = s.civ.polities[id];
    if (!p || !polityAlive(p, year) || (sizesNow(s.civ).get(id) ?? 0) <= 0) s.nationControl.delete(id);
  }

  /* ---- 6. 换 civ 对象(edits.ts 的 polityKey 按 civ 对象缓存 WeakMap) ---- */
  s.civ = { ...s.civ };
  s.pendingStartSetup = undefined;

  /* ---- 7. 汇总 ---- */
  const alive = aliveNow(s, year);
  if (targetCount !== null && alive.length !== targetCount) {
    ctx.warnings.push(`目标 ${targetCount} 国,实际 ${alive.length} 国(地图上能建 / 能删的到头了)`);
  }
  const finalControls: Record<string, NationControl> = {};
  for (const n of alive) {
    const c = s.nationControl.get(n.polityId);
    if (c) finalControls[String(n.polityId)] = c;
  }
  const state: StartSetupState = {
    appliedYear: year,
    count: alive.length,
    targetCount,
    controls: finalControls,
    removed: [...ctx.removed],
    added: [...ctx.added],
    warnings: [...ctx.warnings],
  };
  s.startSetup = state;
  return {
    sessionId: s.id,
    startYear: s.startYear,
    ...state,
    resized: ctx.resized,
    movedCapitals: ctx.movedCapitals,
    warsEnded: ctx.warsEnded,
    treatiesEnded: ctx.treatiesEnded,
    needConfirm: ctx.needConfirm,
    applied: true,
    fingerprint: civHash(s.civ),
  };
}

/** 最后一州的确认文案(前端直接展示;单元测试按这个短语断言) */
export function lastRegionMessage(name: string): string {
  return `「${name}」该国家只有最后一个州，删除将移除整个国家，是否继续？`;
}

// ── 开局国家设置的内部实现 ──────────────────────────────────────────────────

function cloneSetupState(state: StartSetupState): StartSetupState {
  return {
    ...state,
    controls: { ...state.controls },
    removed: [...state.removed],
    added: [...state.added],
    warnings: [...state.warnings],
  };
}

function readIdList(raw: unknown, field: string): number[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${field} 要是国家编号数组`);
  const out: number[] = [];
  for (const v of raw) {
    const id = Number(v);
    if (!Number.isInteger(id) || id < 0) throw new Error(`${field} 里 "${String(v)}" 不是国家编号`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function readRegionList(raw: unknown, count: number): number[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('removeRegions 要是州编号数组');
  const out: number[] = [];
  for (const v of raw) {
    const r = Number(v);
    if (!Number.isInteger(r) || r < 0 || r >= count) throw new Error(`removeRegions 里 "${String(v)}" 不是有效州编号(0–${count - 1})`);
    if (!out.includes(r)) out.push(r);
  }
  return out;
}

function readControls(raw: unknown): Record<string, NationControl> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('controls 要是 { "国家编号": "ai" | "program" } 对象');
  const out: Record<string, NationControl> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(k);
    if (!Number.isInteger(id) || id < 0) throw new Error(`controls 的键 "${k}" 不是国家编号`);
    if (v !== 'ai' && v !== 'program') throw new Error(`controls["${k}"] 只能是 "ai" 或 "program"`);
    out[String(id)] = v;
  }
  return out;
}

function readCount(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error('count 要是数字');
  return Math.min(START_COUNT_MAX, Math.max(START_COUNT_MIN, Math.round(n)));
}

function readNations(raw: unknown, regionCount: number): StartNationSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('nations 要是数组');
  return raw.map((v, i) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`nations[${i}] 要是对象`);
    const o = v as Record<string, unknown>;
    const spec: StartNationSpec = {};
    if (o.polityId !== undefined && o.polityId !== null) {
      const id = Number(o.polityId);
      if (!Number.isInteger(id) || id < 0) throw new Error(`nations[${i}].polityId 要是国家编号`);
      spec.polityId = id;
    }
    if (o.regionIds !== undefined && o.regionIds !== null) {
      if (!Array.isArray(o.regionIds)) throw new Error(`nations[${i}].regionIds 要是州号数组`);
      const ids: number[] = [];
      for (const rv of o.regionIds) {
        const r = Number(rv);
        if (!Number.isInteger(r)) throw new Error(`nations[${i}].regionIds 里 ${JSON.stringify(rv)} 不是整数州号`);
        if (r < 0 || r >= regionCount) throw new Error(`nations[${i}].regionIds 里州 ${r} 越界(共 ${regionCount} 州)`);
        if (!ids.includes(r)) ids.push(r);
      }
      if (!ids.length) throw new Error(`nations[${i}].regionIds 不能是空数组(至少要选一个州)`);
      spec.regionIds = ids;
    }
    if (o.at !== undefined && o.at !== null) {
      if (typeof o.at !== 'object' || Array.isArray(o.at)) throw new Error(`nations[${i}].at 要是 { x, y }`);
      const at = o.at as Record<string, unknown>;
      const x = Number(at.x);
      const y = Number(at.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`nations[${i}].at 需要两个有限数字 x / y`);
      spec.at = { x, y };
    }
    if (o.size !== undefined && o.size !== null) {
      const size = Number(o.size);
      if (!Number.isFinite(size) || size <= 0) throw new Error(`nations[${i}].size 要是正数`);
      spec.size = size;
    }
    if (o.card !== undefined && o.card !== null) {
      if (typeof o.card !== 'object' || Array.isArray(o.card)) throw new Error(`nations[${i}].card 要是对象`);
      spec.card = o.card as Record<string, unknown>;
    }
    if (o.autoCard !== undefined) spec.autoCard = o.autoCard === true;
    if (o.control !== undefined && o.control !== null) {
      const c = o.control;
      if (c !== 'ai' && c !== 'program') throw new Error(`nations[${i}].control 只能是 "ai" 或 "program"`);
      spec.control = c;
    }
    return spec;
  });
}

/** 在世国家(含州数),按州数从多到少 */
function aliveNow(s: Session, year: number): { polityId: number; name: string; regions: number }[] {
  const sizes = sizesNow(s.civ);
  const out: { polityId: number; name: string; regions: number }[] = [];
  for (const p of s.civ.polities) {
    const regions = sizes.get(p.id) ?? 0;
    if (regions <= 0 || !polityAlive(p, year)) continue;
    out.push({ polityId: p.id, name: polityName(p, year), regions });
  }
  out.sort((a, b) => b.regions - a.regions || a.polityId - b.polityId);
  return out;
}

/** 给新建的国家建一张角色卡(失败只记 warning,下一轮 ensureCards 会重建) */
function addStartCard(
  s: Session,
  polityId: number,
  ctx: SetupContext,
  card?: Record<string, unknown>,
  autoCard = true,
): void {
  try {
    const useAuto = card ? autoCard === true : true;
    const built = buildCard(s, polityId, true, { card, autoCard: useAuto }, ctx.warnings);
    s.cards ??= new Map();
    s.cards.set(polityId, built);
  } catch (e) {
    ctx.warnings.push(`P${polityId} 的角色卡没建成(第一回合会按引擎君主重建):${e instanceof Error ? e.message : String(e)}`);
  }
}

function ownRegions(civ: Civ, polityId: number): number[] {
  const out: number[] = [];
  for (let r = 0; r < civ.polity.length; r++) if (civ.polity[r] === polityId) out.push(r);
  return out;
}

/** 某国当年国都所在的州(-1 = 找不到) */
function capitalRegionOf(civ: Civ, p: Polity, year: number): number {
  const sid = capitalAt(p, year);
  const st = civ.settlements[sid];
  return st ? st.region : -1;
}

/** 确定性伪随机:同一世界 / 国家 / 年份 / 序号总是同一个数(测试可复现) */
function hashIndex(seed: number, polityId: number, year: number, salt: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (polityId + 0x85ebca6b), 0xc2b2ae35) >>> 0;
  h = Math.imul(h ^ (Math.round(year) + 0x27d4eb2f + salt), 0x165667b1) >>> 0;
  return (h ^ (h >>> 15)) >>> 0;
}

/** 在给定的州里挑一座城:活城优先、容量大的优先、preferRegion 加权 */
function pickSettlementInRegions(civ: Civ, regions: readonly number[], preferRegion: number): number {
  const want = new Set(regions);
  let best = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const st of civ.settlements) {
    if (!want.has(st.region)) continue;
    let score = st.ended === undefined ? 1000 : 0;
    score += typeof st.capacity === 'number' && Number.isFinite(st.capacity) ? st.capacity : 0;
    if (st.region === preferRegion) score += 100;
    if (score > bestScore) {
      bestScore = score;
      best = st.id;
    }
  }
  return best;
}

/** 国都州被删掉、国家还有别的州:从保留的州里挑一个新国都,capitals 追加一条 */
function migrateCapital(s: Session, polityId: number, ctx: SetupContext): StartSetupCapitalMove | null {
  const civ = s.civ;
  const p = civ.polities[polityId];
  if (!p) return null;
  const own = ownRegions(civ, polityId);
  if (!own.length) return null;
  const oldSid = capitalAt(p, ctx.year);
  const old = civ.settlements[oldSid];
  const region = own[hashIndex(civ.seed, polityId, ctx.year, ctx.movedCapitals.length) % own.length]!;
  const chosen = pickSettlementInRegions(civ, own, region);
  if (chosen < 0) {
    ctx.warnings.push(`「${polityName(p, ctx.year)}」的首都州被删,但剩下的州里没有城:暂不记录新国都`);
    return null;
  }
  const to = civ.settlements[chosen];
  const base = p.capitals && p.capitals.length ? p.capitals : [{ year: p.founded, settlement: p.capital }];
  p.capitals = [...base, { year: ctx.year, settlement: chosen }];
  const move: StartSetupCapitalMove = {
    polityId,
    name: polityName(p, ctx.year),
    fromRegion: old ? old.region : -1,
    fromCapital: old ? old.name : null,
    toRegion: region,
    toCapital: to ? to.name : null,
  };
  ctx.movedCapitals.push(move);
  ctx.warnings.push(`「${move.name}」国都从${move.fromCapital ?? '旧城'}迁到${move.toCapital ?? '新址'}(原首都州被删)`);
  return move;
}

/** 删一个州;删到 0 州时按 fromWholeNation 收尾(删整国 / 删到最后一州) */
function removeOneRegion(s: Session, region: number, ctx: SetupContext, fromWholeNation: boolean): void {
  const civ = s.civ;
  const owner = civ.polity[region];
  if (owner < 0) return;
  const p = civ.polities[owner];
  if (!p) return;
  const sizes = sizesNow(civ);
  const capRegion = capitalRegionOf(civ, p, ctx.year);
  civ.polity[region] = -1;
  const after = (sizes.get(owner) ?? 0) - 1;
  sizes.set(owner, after);
  if (after > 0) {
    if (capRegion === region) migrateCapital(s, owner, ctx);
    return;
  }
  endNation(s, owner, ctx, fromWholeNation ? 'remove' : 'last-region');
}

/** 整国删除:按州逐个删(先删首都州,能记录一次随机迁都),最后 endNation */
function removeNation(s: Session, polityId: number, ctx: SetupContext): void {
  const civ = s.civ;
  const p = civ.polities[polityId];
  if (!p) return;
  const year = ctx.year;
  const name = polityName(p, year);
  const regs = ownRegions(civ, polityId);
  if (!regs.length) {
    ctx.warnings.push(`P${polityId} 已经没有州了,跳过删除`);
    return;
  }
  const capRegion = capitalRegionOf(civ, p, year);
  const order = regs.slice().sort((a, b) => (a === capRegion ? 0 : 1) - (b === capRegion ? 0 : 1) || a - b);
  for (const r of order) removeOneRegion(s, r, ctx, true);
  ctx.warnings.push(`删除国家「${name}」:${regs.length} 个州变无主`);
}

/** 进行中的战争(war 史事开、peace 史事关;按史事顺序重放) */
function openWars(civ: Civ): { id: number; a: number; b: number }[] {
  const wars = new Map<number, { id: number; a: number; b: number }>();
  for (const e of civ.annals) {
    if (e.kind === 'war' && e.war >= 0) wars.set(e.war, { id: e.war, a: e.a, b: e.b });
    else if (e.kind === 'peace') wars.delete(e.war);
  }
  return [...wars.values()];
}

/** 还活着的条约(约 / 续约 开,约满 关;背约不结束条约) */
function liveTreaties(civ: Civ): { id: number; parties: number[] }[] {
  const live = new Map<number, number[]>();
  for (const e of civ.annals) {
    if (e.kind === 'treaty') {
      if (e.cause === 'renew' && live.has(e.war)) {
        if (e.ps) live.set(e.war, [...e.ps]);
        continue;
      }
      live.set(e.war, e.ps ? [...e.ps] : [e.a, e.b]);
    } else if (e.kind === 'expire') {
      live.delete(e.war);
    }
  }
  return [...live.entries()].map(([id, parties]) => ({ id, parties }));
}

/** 国家灭亡:标记 ended、补 peace / expire 史事、清角色卡 / 记忆 / 情报 / 控制方式 / 席位与定制引用 */
function endNation(s: Session, polityId: number, ctx: SetupContext, reason: 'remove' | 'last-region'): void {
  const civ = s.civ;
  const year = ctx.year;
  const p = civ.polities[polityId];
  if (!p) return;
  if (p.ended === undefined) p.ended = year;
  const name = polityName(p, year);
  if (!ctx.removed.includes(polityId)) ctx.removed.push(polityId);
  for (const w of openWars(civ)) {
    if (w.a !== polityId && w.b !== polityId) continue;
    civ.annals.push({ year, kind: 'peace', a: w.a, b: w.b, region: -1, settlement: -1, war: w.id });
    ctx.warsEnded.push({ war: w.id, a: w.a, b: w.b });
  }
  for (const t of liveTreaties(civ)) {
    if (!t.parties.includes(polityId)) continue;
    const ps = t.parties.filter((x) => x !== polityId);
    const a = ps.length ? ps[0]! : polityId;
    const b = ps.length > 1 ? ps[1]! : a;
    civ.annals.push({ year, kind: 'expire', a, b, region: -1, settlement: -1, war: t.id, ps });
    ctx.treatiesEnded.push(t.id);
  }
  s.cards?.delete(polityId);
  s.memory?.delete(polityId);
  if (s.intel) {
    delete s.intel[String(polityId)];
    for (const key of Object.keys(s.intel)) delete s.intel[key]![String(polityId)];
  }
  s.nationControl.delete(polityId);
  if (s.playerPolityId === polityId) {
    s.playerPolityId = undefined;
    ctx.warnings.push('删掉的国家原来是玩家国家:玩家席位已清空');
  }
  if (s.customStart && s.customStart.polityId === polityId) {
    s.customStart = undefined;
    ctx.warnings.push('删掉的国家原来是开局定制国:定制记录已清除');
  }
  const cfg = s.monarch?.config as { polities?: unknown } | undefined;
  if (cfg && Array.isArray(cfg.polities)) {
    cfg.polities = (cfg.polities as unknown[]).filter((x) => Number(x) !== polityId);
  }
  ctx.warnings.push(`「${name}」第 ${year} 年灭亡(${reason === 'remove' ? '整国删除' : '删到最后一州'})`);
}
