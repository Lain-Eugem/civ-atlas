/**
 * 官方规则包里总流程要走的几步(开头几步、推到一半拼结果、地形大事、推完的整理);包本身在 modules.ts 的 OFFICIAL_PACK。
 * 这里不引 modules.ts:要再推一遍时用 run.pack。
 */
import { generateWorld, type World, type WorldParams } from '../world';
import type { Sketch } from '../sketch';
import { withoutLayers, type MapPlugin } from '../mapHooks';
import type { Annal, Civ, CivEra, CivParams, Culture, Habitat, NamePins, PlanetNames, PlanetTempo, Place, Polity, Regions, Route, Settlement, UpheavalFact } from './types';
import { subSeed } from '../util';
import { computeHabitat } from './habitat';
import { buildRegions } from './regions';
import type { CivSim } from './engine/sim';
import type { KnobPatch, KnobSet } from './engine/knobs';
import { BIRTH_SPAN, cultureKey, cultureModelOf, finishCultures, planCultures, type CultureModel } from './cultures';
import { buildRoutes, usedLanes } from './routes';
import { capacityNorm, finishPolities, planPolities, polityModelOf, routeCities, ruinGaps, type PolityModel } from './polities';
import { devModelOf } from './development';
import { findPlaces, keepPlaceNames, nameRefs, type NameRef } from './places';
import { passSites } from './passSites';
import { commandedList, scheduleInterventions } from './interventions';
import { commandTaker } from './commands';
import { buildPeople } from './people';
import { installUpheaval, reshapeCities, scheduleUpheaval, upheavalImpact, type TerrainEra } from './upheaval';
import { isCommand, type Intervention, type TerrainOp } from '../edits';
import { breakRoads } from './pandemicRoads';
import { cleanCalamity, type Calamity } from './calamity';
import { migrationsOf } from './migration';
import { cleanMix, type NameMix } from '../names';
import { cleanFrontier, cleanOrigins, type Frontier, type Origins } from './frontier';
import { knobSet, knobsKey } from './knobs';
import { DEFAULT_CIV_PARAMS, runPack, viability, type CivPack, type CivRun, type EraStep, type Segment, type Upheave, type UpheaveStep } from './run';
import type { InstallCtx } from './modules';
import type { PluginBridge } from './engine/plugin';
import { OFFICIAL_NAMES, officialUnit, simRead, type OfficialName, type SimRead } from './simRead';

/**
 * 一颗星球的扩张节拍(民族走一个"标准路程"要几年,不含 pace;cultures.ts 的 calibrate)和城的人口折算(polities.ts 的 capacityNorm),
 * 按**没改地形**的这组世界参数生成、标定。
 * 两个数都是整个世界一起定的(节拍:到第 3000 年约九成可居州有人住;折算:可居州人口上限的第 90 百分位):
 * 改过地形的世界要是按改后的地形重算,远海放一座小岛也会把全世界的扩张拨快或拨慢、城都大一点或小一点,各处的历史全跟着错开。
 * 所以改过地形的世界沿用原来星球的这两个数,只有改动附近(和受它牵连)的历史跟着地形变。
 * 要多生成一遍没改过的地形;worker 按参数缓存,经 CivParams.tempo 传给 generateCiv。
 * 草图(新建世界时画的大陆和海)、地图插件都算星球的一部分:画过草图的世界,"没改地形的星球"是照草图长出来的那一颗(sketch 传进来),
 * 用地图插件长的世界照同样的地图插件长(mapPlugins,按先后)。
 * 没改过的星球长不出文明 = undefined(改过的世界按它自己标定)
 */
export function planetTempo(params: WorldParams, civ: Partial<CivParams> = {}, sketch?: Sketch | null, mapPlugins?: readonly MapPlugin[]): PlanetTempo | undefined {
  const p: CivParams = { ...DEFAULT_CIV_PARAMS, ...civ };
  const knobs = knobSet(p.knobs);
  const world = generateWorld(params, undefined, undefined, sketch, undefined, mapPlugins && withoutLayers(mapPlugins));
  const habitat = computeHabitat(world);
  if (!viability(world, habitat).viable) return undefined;
  const seed = params.seed;
  const regions = buildRegions(world, habitat, { regionArea: p.regionArea, seed, knobs });
  const model = planCultures(world, habitat, regions, { seed, cultures: p.cultures, pace: 1, birthSpan: p.birthSpan ?? BIRTH_SPAN });
  return model ? { spread: model.spreadYears, capNorm: capacityNorm(knobs, model.terrain) } : undefined;
}

/** 官方规则包这次推演自己记着的 */
export interface OfficialOwn {
  /** 整个世界的地名风格、拓荒设定、自选的起源、「天灾」(清理过;默认 = undefined) */
  mix: NameMix | undefined;
  frontier: Frontier | undefined;
  origins: Origins | undefined;
  calamity: Calamity | undefined;
  /** 带着的干预(推完、推到一半都记进结果;作者立国时起好的国名按它认) */
  interventions: readonly Intervention[] | undefined;
  /** 第一段的两层模型(标定的扩张节拍、人口折算、国家的节拍按它记) */
  model: CultureModel | null;
  pm: PolityModel | null;
  /** 各段的州地形(城的人口上限和它最后一次记下的那一段比,reshapeCities) */
  terrains: TerrainEra[];
  /** 地形大事以前各段起好、钉住的名字(第一件大事那一支推完时建) */
  pins?: NamePins;
}

type Run = CivRun<OfficialOwn>;

/** 引擎上的两层模型;接着推时两层各复制了一份民族表,起城名、国名要用起好名的那份。只在这一段推完以后取 */
function modelsOf(sim: CivSim): { cm: CultureModel | null; pm: PolityModel | null } {
  const cm = cultureModelOf(sim) ?? null;
  const pm = polityModelOf(sim) ?? null;
  if (cm && pm) pm.cultures = cm.cultures;
  return { cm, pm };
}

/** 改过地形:带地形修改或草图(草图只改了板块的也算) */
const edited = (world: World) => !!world.terrain?.length || !!world.sketch;

/** 重长没改地形的星球要用的地图插件:要和世界记的那一串一一对上,不然长出来的不是同一颗星球 */
function planetPlugins(world: World, p: CivParams): readonly MapPlugin[] | undefined {
  const want = world.mapPlugins;
  if (!want?.length) return undefined;
  const have = p.mapPlugins ?? [];
  if (have.length !== want.length || have.some((pl, i) => pl.key !== want[i])) throw new Error('这个世界是用地图插件长的,推历史要带上同样的地图插件');
  return withoutLayers(have);
}

/** 文明这边定"谁住在哪、按什么语感起名"的几项设定(地名照着沿用的那一份按它们算,见 nameRefOf) */
interface RefSetup {
  p: CivParams;
  /** 这个世界的那套数(划州按它;清理过的改动,官方 = undefined) */
  knobs?: KnobPatch;
  mix?: NameMix;
  frontier?: Frontier;
  origins?: Origins;
}

/**
 * 地名照着沿用的那一份按什么认:世界参数 + 文明种子、地名风格、每州面积、民族数、扩张快慢、诞生跨度、拓荒、起源。
 * 推演年数、干预、地形大事、国家数不算:地名只看计划中的疆域和各民族的语感(和推到哪一年无关),干预立国来的民族不在计划中的疆域里
 */
function refKeyOf(world: Pick<World, 'params' | 'mapPlugins'>, s: RefSetup): string {
  const { p } = s;
  const entries = Object.entries(world.params).sort(([a], [b]) => (a < b ? -1 : 1));
  // 一套数只在改过的时候进键(官方的和加这一项以前一样)
  const k = s.knobs ? [knobsKey(s.knobs)] : [];
  const m = world.mapPlugins?.length ? [{ map: world.mapPlugins }] : [];
  return JSON.stringify([entries, p.civSeed ?? null, s.mix ?? null, p.regionArea, p.cultures, p.pace, p.birthSpan ?? null, s.frontier ?? null, s.origins ?? null, ...k, ...m]);
}

/** 设定键的指纹(存进世界的那一份地名带着它):两条 32 位散列拼成 16 位十六进制 */
const refSum = (key: string): string => [1, 2].map((s) => subSeed(s, key).toString(16).padStart(8, '0')).join('');

/** 记着的几份(按 refKeyOf;最近用过的在后面) */
const refMemo = new Map<string, readonly NameRef[]>();
const REF_KEEP = 4;
function rememberRef(key: string, ref: readonly NameRef[]): void {
  refMemo.delete(key);
  refMemo.set(key, ref);
  if (refMemo.size > REF_KEEP) refMemo.delete(refMemo.keys().next().value!);
}

/**
 * 改过地形的世界里,山海湖岛的地名照着沿用的那一份(places.ts 的 PlaceNaming.ref):没改过地形(不带地形修改、不带草图)的
 * 同一颗星球、同样的文明设定起出来的地名。改地形以后历史重推,远处民族的分布和语感会变,按当地民族起的地名也会跟着换 ——
 * 照着它起,没改到的地方名字不变。没改过地形的世界、CivParams.placeRef = false(照原样打开的旧版本世界)= undefined(照常起名)。
 * 要多生成一遍没改过的星球、推到第 0 年(地名和推到哪一年无关,tests/names-stable.test.ts 钉住);
 * 按设定记着最近几份,没改过地形的世界推完时顺手记下(新建世界以后头一次改地形就不用再生成)
 */
function nameRefOf(pack: CivPack<OfficialOwn>, world: World, s: RefSetup): readonly NameRef[] | undefined {
  if (!edited(world) || s.p.placeRef === false) return undefined;
  const key = refKeyOf(world, s);
  const kept = s.p.planetNames;
  let ref = kept && kept.key === refSum(key) ? kept.ref : refMemo.get(key);
  if (!ref) {
    const { p, mix, frontier, origins, knobs } = s;
    const w0 = generateWorld(world.params, undefined, undefined, undefined, undefined, planetPlugins(world, p));
    const c0 = runPack(pack, w0, {
      endYear: 0,
      ...(knobs ? { knobs } : {}),
      regionArea: p.regionArea,
      cultures: p.cultures,
      pace: p.pace,
      ...(p.birthSpan !== undefined ? { birthSpan: p.birthSpan } : {}),
      ...(p.civSeed !== undefined ? { civSeed: p.civSeed } : {}),
      ...(mix ? { names: mix } : {}),
      ...(frontier ? { frontier } : {}),
      ...(origins ? { origins } : {}),
    });
    ref = nameRefs(w0, c0.places, c0.cultures, c0.regions);
  }
  rememberRef(key, ref);
  return ref;
}

/** 同 index.ts 的 planetNames;设定照 prelude、settle 里的取法,和推的时候认的是同一个键 */
export function planetNamesOf(pack: CivPack<OfficialOwn>, world: World, params: Partial<CivParams>, grow: boolean): PlanetNames | null | undefined {
  const p: CivParams = { ...DEFAULT_CIV_PARAMS, ...params };
  if (!edited(world) || p.placeRef === false) return undefined;
  const s: RefSetup = { p, mix: cleanMix(p.names), frontier: cleanFrontier(p.frontier), origins: cleanOrigins(p.origins), knobs: knobSet(p.knobs, pack.knobs).patch };
  const key = refKeyOf(world, s);
  const kept = p.planetNames;
  if (!grow && !(kept && kept.key === refSum(key)) && !refMemo.has(key)) return null;
  return { key: refSum(key), ref: nameRefOf(pack, world, s)! };
}

/** 开头几步:定民族、定国家;干预的事件最先预约(同一刻里只排在地形大事和看王朝、新君即位、迁都后重看边地后面,干预之前的历史一字不差) */
function prelude(run: Run, seg: Segment): { own: OfficialOwn; install: InstallCtx | null } {
  const { p, seed, knobs, viable } = run;
  const { sim, world, habitat, regions } = seg;
  const birthSpan = p.birthSpan ?? BIRTH_SPAN;
  const frontier = cleanFrontier(p.frontier);
  const origins = cleanOrigins(p.origins);
  const calamity = cleanCalamity(p.calamity);
  // 改过地形:扩张节拍、城的人口折算沿用没改地形时的同一颗星球(planetTempo);没改 = 按这个世界自己标定。
  // 给了文明种子的(一张地图上新开的历史)一律按这张地图本身标定:地图是定下来的那一张,不另按现在的生成器长一颗没改地形的星球
  const tempo = viable && world.terrain?.length && p.civSeed === undefined ? (p.tempo === undefined ? planetTempo(world.params, p, world.sketch, planetPlugins(world, p)) : (p.tempo ?? undefined)) : undefined;
  // 推演插件以前下的命令不当输入:从第 0 年推,插件会再下一遍
  const interventions = p.interventions?.some((v) => v && isCommand(v)) ? p.interventions.filter((v) => !(v && isCommand(v))) : p.interventions;
  const model = viable
    ? planCultures(world, habitat, regions, { seed, cultures: p.cultures, pace: p.pace, birthSpan, tempo: tempo?.spread, frontier, origins, interventions })
    : null;
  const pm = model ? planPolities(world, model, { knobs, polities: p.polities, pace: p.pace, capNorm: tempo?.capNorm, expand: frontier?.expand }) : null;
  const iv = pm ? scheduleInterventions(sim, seed, interventions) : null;
  const own: OfficialOwn = {
    mix: cleanMix(p.names),
    frontier,
    origins,
    calamity,
    interventions: iv?.stored,
    model,
    pm,
    terrains: pm ? [{ from: -Infinity, terrain: pm.terrain }] : [],
  };
  return { own, install: pm ? { sim, world, habitat, regions, seed, cm: model, pm, iv, calamity } : null };
}

/** 这段推演带着的干预:推演插件下过命令的照引擎上的那一份(作者的接上插件下的) */
const carried = (sim: CivSim, own: OfficialOwn) => commandedList(sim) ?? own.interventions;

/** 推到一半的历史拼成接着推要的 Civ(州、宜居度按给的);归属数组、检查点按州数补齐(新州 = 没人) */
function half(run: Run, own: OfficialOwn, seg: Segment, habitat: Habitat, regions: Regions): Civ {
  const sim = seg.sim;
  const { cm: model, pm } = modelsOf(sim) as { cm: CultureModel; pm: PolityModel };
  const res = sim.result();
  const interventions = carried(sim, own);
  const pad = (a: Int16Array) => {
    if (a.length >= regions.count) return a;
    const b = new Int16Array(regions.count).fill(-1);
    b.set(a);
    return b;
  };
  return {
    seed: run.seed,
    endYear: res.endYear,
    habitat,
    regions,
    cultures: model.cultures,
    settlements: pm.settlements,
    polities: pm.polities,
    routes: [],
    places: [],
    culture: pad(res.culture),
    polity: pad(res.polity),
    log: res.log,
    checkpoints: res.checkpoints.map((c) => (c.culture.length >= regions.count ? c : { year: c.year, culture: pad(c.culture), polity: pad(c.polity) })),
    annals: res.annals,
    viable: true,
    spreadYears: model.spreadYears,
    capNorm: pm.capNorm,
    polityYears: pm.years,
    capSpacing: pm.spacing,
    sailFrom: pm.sailFrom,
    ...(own.frontier ? { frontier: own.frontier } : {}),
    ...(own.calamity ? { calamity: own.calamity } : {}),
    ...(sim.knobs.patch ? { knobs: sim.knobs.patch } : {}),
    ...(migrationsOf(sim) ? { migrations: migrationsOf(sim)! } : {}),
    ...(interventions ? { interventions: interventions.slice() } : {}),
    people: [],
  } as Civ;
}

/** 作者在干预"立国"时起好的国名:国家编号 → 国名(史事 intervene 的 a = 新国,war = 第几条干预) */
function authoredNames(annals: readonly Annal[], interventions?: readonly Intervention[]): Map<number, string> {
  const out = new Map<number, string>();
  if (!interventions?.length) return out;
  for (const e of annals) {
    if (e.kind !== 'intervene' || e.a < 0) continue;
    const v = interventions[e.war];
    if (v?.kind === 'found' && v.name) out.set(e.a, v.name);
  }
  return out;
}

/**
 * 一段推演(到第 k 件大事的前一刻)不套这件大事、照原样推到底(branch)以后起的名字、配色:
 * 年份在 [from, to) 里出现的国家、城、王朝,和这一段里新划出来的州,钉住(第一段还钉住民族)。
 * 返回 branch 起好名的民族、城、国家和计划中的疆域(这一段的地名、道路照它定)
 */
function pinNames(pins: NamePins, world: World, branch: CivSim, from: number, to: number, first: boolean, mix?: NameMix, interventions?: readonly Intervention[]) {
  const res = branch.result();
  const { cm, pm } = modelsOf(branch);
  const bm = cm!;
  const bpm = pm!;
  const planned = finishCultures(world, bm, res.log, first ? undefined : pins, mix);
  finishPolities(world, bpm, res.log, pins, authoredNames(res.annals, interventions));
  // 推演中分化出来的民族:大事以前就有的才钉住(大事以后的那份历史里未必还会这样分化);
  // 每一段都补上这一段大事以前新分出来的(前面几段钉过的照旧)
  pins.cultures ??= new Map();
  for (const c of bm.cultures) {
    if (c.parent !== undefined && c.born >= to) continue;
    const k = cultureKey(c);
    if (!pins.cultures.has(k)) pins.cultures.set(k, { name: c.name, style: c.style, ...(c.autoStyle ? { autoStyle: c.autoStyle } : {}), color: [...c.color] as [number, number, number] });
  }
  const names = bm.terrain.regions.name ?? [];
  for (let r = 0; r < bm.terrain.regions.count; r++) if (pins.regionNames[r] === undefined) pins.regionNames[r] = names[r] ?? '';
  for (const q of bpm.polities) {
    let v = pins.polities.get(q.id);
    if (q.founded >= from && q.founded < to) {
      v = { name: q.name, color: [...q.color] as [number, number, number], dynasties: [] };
      pins.polities.set(q.id, v);
    }
    if (!v) continue;
    q.dynasties?.forEach((d, i) => {
      if (d.year >= from && d.year < to) v.dynasties[i] = d.name;
    });
  }
  for (const c of bpm.settlements) if (c.founded >= from && c.founded < to) pins.settlements.set(c.id, c.name);
  return { cultures: bm.cultures, planned, settlements: bpm.settlements, polities: bpm.polities };
}

/** 名字、配色、这一段的地名和道路:照"没有这件大事、照原样推到底"的那一支(大事之前和它一模一样,见 NamePins) */
function era(run: Run, own: OfficialOwn, c: EraStep): CivEra {
  const { p, seed, knobs } = run;
  const { world: eraWorld, habitat: eraHabitat, regions: before } = c.seg;
  own.pins ??= { regionNames: [], polities: new Map(), settlements: new Map() };
  // 起名只读这一段的分支,不影响之后的推演
  const b = pinNames(own.pins, eraWorld, c.branch, c.from, c.to, c.k === 0, own.mix, carried(c.branch, own));
  // 第一段:改过地形的世界照没改过时的地名(nameRefOf);之后各段沿用前一段的
  const eraRef = c.k ? undefined : nameRefOf(run.pack, eraWorld, { p, mix: own.mix, frontier: own.frontier, origins: own.origins, knobs: knobs.patch });
  const br = c.branch.result();
  const eraLanes = usedLanes(before, br.log, b.cultures, c.from);
  const eraRoutes = buildRoutes(eraWorld, eraHabitat, before, {
    knobs,
    cities: b.settlements.length ? routeCities(knobs, b.settlements, b.polities, p.endYear) : undefined,
    lanes: eraLanes,
    ruins: ruinGaps(b.settlements),
  });
  // 关隘也照这一支(和没有这件大事时一样;passSites.ts)
  const eraPasses = passSites(eraWorld, before, eraRoutes, { regions: before, checkpoints: br.checkpoints, log: br.log, annals: br.annals });
  const eraAvoid = b.settlements.map((s) => ({ name: s.name, from: s.founded }));
  const eraPlaces = findPlaces(eraWorld, before, { cultures: b.cultures, culture: b.planned, names: own.mix, seed, passes: eraPasses, avoid: eraAvoid, ...(eraRef ? { ref: eraRef } : {}) });
  if (c.k) keepPlaceNames(eraWorld, c.eras[c.k - 1].places, eraPlaces);
  return { until: c.to, habitat: eraHabitat, regions: before, places: eraPlaces, routes: eraRoutes };
}

/** 一件地形大事里有哪几种修改(按第一次出现的先后) */
function kindsOf(ops: readonly TerrainOp[]): UpheavalFact['kinds'] {
  const out: UpheavalFact['kinds'] = [];
  for (const o of ops) if ((o.kind === 'volcano' || o.kind === 'raise' || o.kind === 'sink') && !out.includes(o.kind)) out.push(o.kind);
  return out;
}

/** 比出这件大事改了什么;还在的城港口、人口上限照新地形换值(从大事那一刻起;接着推时立国的年份按新的上限算) */
function upheave(run: Run, own: OfficialOwn, c: UpheaveStep): Upheave {
  const u = c.step;
  const impact = upheavalImpact(c.seg.world, c.seg.regions, u.world, c.regions, u.ops);
  const { joined, ...rest } = impact;
  const fact: UpheavalFact = { year: u.year, kinds: kindsOf(u.ops), items: u.items.slice(), ...rest, polity: -1, drownedBy: [], ...(joined ? { joined } : {}) };
  return {
    fact,
    reshape: (h) => {
      h.settlements = reshapeCities(run.knobs, h.settlements, own.terrains, u.world, c.habitat, c.regions, u.year, u.ops);
    },
    first: (sim) => scheduleUpheaval(sim, c.k, u.year),
    install: (sim) => {
      installUpheaval(sim, c.k, u, impact, fact, c.seg.world);
      own.terrains.push({ from: u.year, terrain: polityModelOf(sim)!.terrain });
    },
  };
}

/** 推完以后整理:起名、道路、地名、关隘、人物 */
function settle(run: Run, own: OfficialOwn, fin: Segment, eras: CivEra[], facts: UpheavalFact[]): Civ {
  const { p, seed, viable, progress } = run;
  const { mix, frontier, model, pm, pins } = own;
  const knobs: KnobSet = fin.sim.knobs;
  const last = modelsOf(fin.sim);
  const { log, checkpoints, culture, polity, annals } = fin.sim.result();
  const interventions = carried(fin.sim, own);
  progress('起名', 0.92);
  // 计划中的疆域:山河湖海的地名按它的语感起(推得再远地名也不变,见 cultures.ts 的 plannedOwners)
  const planned = last.cm ? finishCultures(fin.world, last.cm, log, pins, mix) : undefined;
  if (last.pm) finishPolities(fin.world, last.pm, log, pins, authoredNames(annals, interventions));
  const cultures: Culture[] = last.cm?.cultures ?? [];
  const settlements: Settlement[] = last.pm?.settlements ?? [];
  const polities: Polity[] = last.pm?.polities ?? [];
  // 城镇列表交给道路(国都之间修大路,路的修建年份取两端较晚者);推演里走过的航线一定画(usedLanes)
  // 全球大疫的凋敝里失修断掉、后来修回的路(pandemicRoads.ts 的 breakRoads;没有全球大疫 = 原样)
  const routes: Route[] = viable
    ? breakRoads(
        { seed, annals, settlements, regions: fin.regions },
        buildRoutes(fin.world, fin.habitat, fin.regions, {
          knobs,
          progress,
          cities: settlements.length ? routeCities(knobs, settlements, polities, p.endYear) : undefined,
          lanes: usedLanes(fin.regions, log, cultures, facts.length ? facts[facts.length - 1].year : -Infinity),
          ruins: ruinGaps(settlements),
        }),
      )
    : [];
  // 山海湖岛是地理,不看 viable:改过地形的世界同一处地方照没改过时的地名(nameRefOf)
  const setup: RefSetup = { p, mix, frontier, origins: own.origins, knobs: knobs.patch };
  const ref = eras.length ? undefined : nameRefOf(run.pack, fin.world, setup);
  // 关隘(passSites.ts):大路翻过去的名关、推演里据险断后守过的口子;只读地形、道路、史事,不改历史。
  // 起名排在山海湖岛之后、只挑没用过的名字,也不和关画上地图以前就有的城重名:别的地名一个不变
  const passes = viable ? passSites(fin.world, fin.regions, routes, { regions: fin.regions, checkpoints, log, annals }) : [];
  const avoid = settlements.map((s) => ({ name: s.name, from: s.founded }));
  const places: Place[] = findPlaces(fin.world, fin.regions, { cultures, culture: planned, names: mix, seed, passes, avoid, ...(ref ? { ref } : {}) });
  // 地形大事以后:同一处地方沿用大事以前的地名
  if (eras.length) keepPlaceNames(fin.world, eras[eras.length - 1].places, places);
  // 没改过地形、没有干预和地形大事的:这就是改地形以后要照着沿用的那一份,记下(nameRefOf)
  if (!edited(fin.world) && !interventions?.length && !eras.length) rememberRef(refKeyOf(fin.world, setup), nameRefs(fin.world, places, cultures, fin.regions));
  const people = buildPeople({
    knobs,
    seed,
    endYear: p.endYear,
    polities,
    settlements,
    cultures,
    annals,
    log,
    regionCount: fin.regions.count,
    ...(facts.length ? { upheavals: facts } : {}),
    // 生效了的即位(作者立的君主)、作者下令的仗由史事 intervene + 干预列表认(和推演里同一份在位表)
    ...(interventions ? { interventions } : {}),
  });

  return {
    seed,
    endYear: p.endYear,
    habitat: fin.habitat,
    regions: fin.regions,
    cultures,
    settlements,
    polities,
    routes,
    places,
    culture,
    polity,
    log,
    checkpoints,
    annals,
    viable,
    spreadYears: model?.spreadYears,
    capNorm: pm?.capNorm,
    polityYears: pm?.years,
    ...(pm ? { capSpacing: pm.spacing } : {}),
    ...(pm ? { sailFrom: pm.sailFrom } : {}),
    ...(frontier ? { frontier } : {}),
    ...(own.calamity ? { calamity: own.calamity } : {}),
    ...(knobs.patch ? { knobs: knobs.patch } : {}),
    ...(migrationsOf(fin.sim) ? { migrations: migrationsOf(fin.sim)! } : {}),
    ...(interventions ? { interventions: interventions.slice() } : {}),
    people,
    ...(facts.length ? { upheavals: facts, eras } : {}),
    ...(mix ? { names: mix } : {}),
  };
}

/** 分段接着推、推完以后:照接着推的那份历史取 */
function adopt(run: Run, civ: Civ, interventions: readonly Intervention[], sim: CivSim): OfficialOwn {
  const { cm, pm } = modelsOf(sim);
  return {
    mix: civ.names,
    frontier: civ.frontier,
    origins: cleanOrigins(run.p.origins),
    calamity: civ.calamity,
    interventions: interventions.length ? interventions : undefined,
    model: cm,
    pm,
    terrains: [],
  };
}

/** 接着推:地形大事(first)以后,干预的事件最先预约(和一口气推一样:同一刻里地形大事最先,干预只排在新君即位、迁都后重看边地后面) */
const resumePrelude: CivPack<OfficialOwn>['resumePrelude'] = ({ sim, world, civ, interventions, eras }) => ({
  sim,
  world,
  civ,
  interventions,
  iv: scheduleInterventions(sim, civ.seed, interventions, true),
  eras,
  extra: [],
});

const officialNames: ReadonlySet<string> = new Set(OFFICIAL_NAMES);

/** 推演插件那一段用的:读口、州的结构、官方表、收命令 */
function bridge(sim: CivSim, seed: number): PluginBridge<SimRead> | null {
  const read = simRead(sim);
  const pm = polityModelOf(sim);
  if (!read || !pm) return null;
  const reg = pm.terrain.regions;
  const R = sim.R;
  const mesh = devModelOf(sim)?.world.mesh;
  return {
    read,
    regions: { count: R, adjStart: reg.adjStart.slice(0, R + 1), adj: reg.adj.slice(), seat: reg.seat.slice(0, R) },
    ...(mesh ? { tiles: { count: mesh.n, adjStart: mesh.adjStart, adj: mesh.adj, of: reg.of } } : {}),
    polities: () => ({ count: pm.polities.length, anchor: pm.ptag }),
    unit: (name) => (officialNames.has(name) ? officialUnit(name as OfficialName) : undefined),
    official: (name) => read.official(name as OfficialName),
    commands: commandTaker(sim, seed),
    counts: () => ({ polities: pm.polities.length, settlements: pm.settlements.length, cultures: (cultureModelOf(sim)?.cultures ?? pm.cultures).length }),
  };
}

/** 官方规则包总流程要走的几步(和清单一起拼成 OFFICIAL_PACK) */
export const OFFICIAL_STEPS = { prelude, resumePrelude, adopt, half, era, upheave, settle, bridge };
