/**
 * 打包、读世界文件(格式见 worldFormat.ts)。
 *
 * 用法:
 * - 存:packWorldFile(内容) → Blob。清单的 made、readers 由调用方传进来。
 *   按块存的(浏览器里的仓库,worldVault.ts)用同一层:packWorldParts 打成清单 + 各块,zipWorld 把清单和块拼成文件,所以两边打出来的字节一样
 * - 读:openWorldFile(文件) 只看外壳和清单,很快;readWorldContent(打开的文件) 再解开各块、迁移到现在的结构、逐项核对
 * - 另存、改名:rewriteWorldFile(打开的文件, 改了什么):没改的块连字节都不动,认不出的、结构比软件新的块原样带着
 *
 * 读的时候出错一律抛 WorldFileError,kind 分三种(worldFormat.ts):broken 坏了、newer 要更新软件、readonly 只读。
 *
 * 大小:本机存取的文件按 ZIP_LOCAL_MAX_BYTES,传上服务器的调用方传 maxBytes = ZIP_UPLOAD_MAX_BYTES;单块解压的上限跟着它走(worldPartLimit)。
 *
 * 纯计算,不碰 DOM:网页、worker、Node(服务器)共用。
 */
import type { ChronicleBlock } from './civ/story/nameTokens';
import type { FlagBook } from './civ/story/flags';
import type { Civ } from './civ/types';
import type { SimPluginState } from './civ/engine/plugin';
import type { SimLayer } from './civ/engine/pluginLayers';
import { parseSave, type SaveFile } from './savefile';
import { makePart, partBytes, sha256, unpackValue, type SnapshotPart } from './snapshot';
import type { World } from './world';
import { MIGRATIONS, currentSchema, migratePart, type MigrationTable } from './worldMigrate';
import { parseManifest, validateAuthor, validateChronicle, validateCiv, validateEras, validateFlags, validatePlanet, validatePluginLayer, validateSimState, validateThumb, validateWorld, worldHeadLimit, worldPartLimit, type LayerSizes } from './worldValidate';
import { ZIP_LOCAL_MAX_BYTES, ZIP_UPLOAD_MAX_BYTES, parseZip, writeZip } from './zipStore';
import {
  KNOWN_PARTS,
  MANIFEST_FILE,
  PLUGIN_LAYER_MAX_BYTES,
  PLUGIN_LAYER_PREFIX,
  PLUGIN_LAYER_SCHEMA,
  SIM_STATE_PREFIX,
  SIM_STATE_SCHEMA,
  WORLD_APP,
  WORLD_FORMAT,
  WORLD_KIND,
  asWorldFileError,
  broken,
  pluginLayerOf,
  pluginLayerPart,
  simStatePart,
  type AuthorContent,
  type PlanetValue,
  type PluginLayerValue,
  type WorldMade,
  type WorldManifest,
  type WorldPartInfo,
  type WorldPlugin,
  type WorldReaders,
  type WorldRevision,
} from './worldFormat';

/** 地形大事以后的一段世界:不带网格(和地图同一套)、不带回放快照 */
export interface WorldEra {
  /** 这一段的键(网站按它对上主图的补丁) */
  key: string;
  world: Omit<World, 'mesh'>;
}

/** eras 那一块 */
export interface WorldEras {
  /** 原来那段世界的键 */
  baseKey: string;
  eras: WorldEra[];
}

/** 一个世界的内容 */
export interface WorldValues {
  /** 地图:打包时去掉形成过程的回放快照(不存) */
  map: World;
  /** 地形大事以后的各段;没有地形大事 = 不给,或者给空的(都不写这一块) */
  eras?: WorldEras | null;
  civ: Civ;
  chronicle: ChronicleBlock;
  flags: FlagBook;
  /** 作者内容(AI 写的正文);没有 = 不给 */
  author?: AuthorContent | null;
  /** 封面(JPEG 的字节);没有 = 不给 */
  thumb?: Uint8Array | null;
  /** 星球参照;没有 = 不给 */
  planet?: PlanetValue | null;
}

/** 插件放的附加数据:只当字节留着,看世界用不着 */
export interface WorldExtra {
  /** 块名(不能和认得的几块重名);插件存的数据叫 ext.<插件编号>(worldFormat.ts 的 PLUGIN_DATA_PREFIX) */
  name: string;
  /** 这一块的结构版本(插件自己的) */
  schema: number;
  by?: string;
  value: unknown;
}

/** 打包要的东西 */
export interface PackInput extends WorldValues {
  id: string;
  title?: string;
  made: WorldMade;
  readers: WorldReaders;
  /** 存档的全部内容 */
  recipe: SaveFile;
  plugins?: WorldPlugin[];
  /** 第几次修订(不给 = 第 1 次) */
  revision?: WorldRevision;
  extras?: WorldExtra[];
  /** 地图插件出的图层(块名 → 内容,见 worldRun.ts 的 mapLayerParts):地图那一块不带图层,要存的从这里另存成块 */
  layers?: readonly { name: string; value: PluginLayerValue }[];
  /** 文件最大多少字节(不给 = 本机存取的上限;传上服务器的传 ZIP_UPLOAD_MAX_BYTES) */
  maxBytes?: number;
}

/** 一块:清单那一项 + 压缩后的字节 */
export interface PackedPart {
  info: WorldPartInfo;
  data: Uint8Array | ArrayBuffer;
}

/** 块的路径:认得的块照表写,别的压缩了写 .gz、没压缩写 .bin */
function fileOf(name: string, zip: string): string {
  const known = KNOWN_PARTS.get(name);
  // 没有 CompressionStream 的环境 makePart 不压缩,认得的块也不能叫 .gz
  if (known && (zip === 'gzip' || !known.file.endsWith('.gz'))) return known.file;
  return `parts/${name}.${zip === 'gzip' ? 'gz' : 'bin'}`;
}

function packedFrom(p: SnapshotPart, schema: number, need: WorldPartInfo['need'], by?: string): PackedPart {
  return { info: { name: p.name, file: fileOf(p.name, p.zip), schema, sum: p.sum, bytes: p.bytes, zip: p.zip, need, ...(by !== undefined ? { by } : {}) }, data: p.data };
}

/**
 * 已经压缩好的一块(后台线程打的、原件里的)变成清单那一项 + 字节,不再压缩一遍。
 * schema = 这些字节是第几版结构;不给 = 现在的版本(刚打好的)。原件里的块是世界文件有版本以前打的,调用方传 1
 */
export function knownPart(p: SnapshotPart, schema?: number, migrations?: MigrationTable): PackedPart {
  const known = KNOWN_PARTS.get(p.name);
  if (!known) throw new Error(`认不出这一块:${p.name}`);
  return packedFrom(p, schema ?? currentSchema(p.name, migrations), known.need);
}

/** 后台线程打好的一块:认得的块同 knownPart;地图插件出的图层块(layer.<插件编号>.<图层编号>)by 写插件编号 */
export function offeredPart(p: SnapshotPart, schema?: number, migrations?: MigrationTable): PackedPart {
  const ids = pluginLayerOf(p.name);
  return ids ? packedFrom(p, PLUGIN_LAYER_SCHEMA, 'extra', ids[0]) : knownPart(p, schema, migrations);
}

/** 附加数据打包:need 是 extra */
export async function packExtra(x: WorldExtra): Promise<PackedPart> {
  if (KNOWN_PARTS.has(x.name) || isSimState(x.name) || isPluginLayer(x.name)) throw new Error(`附加数据不能叫 ${x.name}`);
  return packedFrom(await makePart(x.name, x.value), x.schema, 'extra', x.by);
}

const isSimState = (name: string) => name.startsWith(SIM_STATE_PREFIX);

/** 历史里的推演插件状态单独成块(sim.<插件编号>,按插件的先后),历史那一块不带它;没有插件状态的历史原样交回 */
export async function splitSimStates(civ: Civ): Promise<{ civ: Civ; parts: PackedPart[] }> {
  if (civ.simPlugins === undefined) return { civ, parts: [] };
  const { simPlugins, ...rest } = civ;
  const parts: PackedPart[] = [];
  for (const st of simPlugins) parts.push(packedFrom(await makePart(`${SIM_STATE_PREFIX}${st.id}`, st), SIM_STATE_SCHEMA, 'extra', st.id));
  return { civ: rest, parts };
}

const isPluginLayer = (name: string) => name.startsWith(PLUGIN_LAYER_PREFIX);

/** 一个插件图层打包(块名 layer.<插件编号>.<图层编号>,by 写插件编号);编号不合规矩抛错 */
export async function packPluginLayer(pluginId: string, layerId: string, value: PluginLayerValue): Promise<PackedPart> {
  const name = pluginLayerPart(pluginId, layerId);
  if (!pluginLayerOf(name)) throw new Error(`插件图层不能叫 ${name}`);
  return packedFrom(await makePart(name, value), PLUGIN_LAYER_SCHEMA, 'extra', pluginId);
}

/** 历史里推演插件存下的图层单独成块(按先后),历史那一块不带它;没有图层的历史原样交回 */
export async function splitSimLayers(civ: Civ): Promise<{ civ: Civ; parts: PackedPart[] }> {
  if (civ.simLayers === undefined) return { civ, parts: [] };
  const { simLayers, ...rest } = civ;
  const parts: PackedPart[] = [];
  for (const l of simLayers) {
    const { by, id, ...rest } = l;
    // 按地块记的图层写进文件时记成 cell(世界文件里的地块层不区分是州的还是地块的)
    const value: PluginLayerValue = rest.unit === 'tile' ? { ...rest, unit: 'cell' } : { ...rest, unit: 'region' };
    parts.push(await packPluginLayer(by, id, value));
  }
  return { civ: rest, parts };
}

/** 这一块是跟着历史走的插件图层:同一份清单里有它那个插件的 sim.<插件编号>(has 问清单里有没有这一块) */
function isHistoryLayer(name: string, has: (part: string) => boolean): boolean {
  const ids = pluginLayerOf(name);
  return !!ids && has(simStatePart(ids[0]));
}

/** 这几块里跟着历史走的:推演插件的状态、它们存下的图层(换了历史就整批换掉) */
export function historyParts(names: Iterable<string>): string[] {
  const all = new Set(names);
  return [...all].filter((n) => isSimState(n) || isHistoryLayer(n, (x) => all.has(x)));
}

/** 认得的一块打包;结构版本 = 现在的版本 */
export async function packKnown(name: string, value: unknown, migrations?: MigrationTable): Promise<PackedPart> {
  return knownPart(await makePart(name, value), undefined, migrations);
}

/** 封面:JPEG 本身压缩过,不再压缩 */
export async function packThumb(bytes: Uint8Array, migrations?: MigrationTable): Promise<PackedPart> {
  const sum = await sha256(bytes);
  return { info: { name: 'thumb', file: fileOf('thumb', 'none'), schema: currentSchema('thumb', migrations), sum, bytes: bytes.length, zip: 'none', need: 'extra' }, data: bytes };
}

/** 去掉回放快照(不存)、各段世界的网格(和地图同一套)、地图插件的图层(另存成图层块) */
function mapValue(map: World): World {
  const { mapLayers: _l, ...rest } = map;
  void _l;
  return { ...rest, history: [] };
}

function erasValue(e: WorldEras): WorldEras {
  return {
    baseKey: e.baseKey,
    eras: e.eras.map(({ key, world }) => {
      const { mesh: _mesh, mapLayers: _l, ...rest } = world as Omit<World, 'mesh'> & { mesh?: unknown };
      void _mesh;
      void _l;
      return { key, world: { ...rest, history: [] } };
    }),
  };
}

/** 配方进清单:origin.url 只认 https,开发环境里存的 http 出处去掉(出处只是一行署名),别的原样 */
function recipeValue(recipe: SaveFile): SaveFile {
  if (!recipe.origin || recipe.origin.url.startsWith('https://')) return recipe;
  const { origin: _origin, ...rest } = recipe;
  void _origin;
  return rest;
}

/** 清单写成 manifest.json 的字节 */
export function manifestBytes(manifest: WorldManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

/** 清单的字节和各块装成 ZIP;块可以是 Blob(字节不用留在内存里) */
export function zipWorld(text: Uint8Array, parts: readonly { info: Pick<WorldPartInfo, 'file'>; data: Uint8Array | ArrayBuffer | Blob }[], maxBytes: number = ZIP_LOCAL_MAX_BYTES): Promise<Blob> {
  return writeZip([{ name: MANIFEST_FILE, data: text }, ...parts.map((p) => ({ name: p.info.file, data: p.data }))], maxBytes);
}

/** 把清单和各块装成 ZIP。写出来之前按读的规矩核对一遍清单:写得出来的就读得回来 */
async function assemble(manifest: WorldManifest, parts: readonly PackedPart[], readers: Readonly<Record<string, number>>, maxBytes: number, migrations?: MigrationTable): Promise<Blob> {
  const text = manifestBytes(manifest);
  parseManifest(text, { readers, migrations, maxBytes });
  return zipWorld(text, parts, maxBytes);
}

/** 清单里除了各块以外的字段 */
export type ManifestFields = Pick<PackInput, 'id' | 'title' | 'made' | 'readers' | 'recipe' | 'plugins' | 'revision'>;

/** 写清单:parts = 各块那几项,按文件里的先后 */
export function buildManifest(input: ManifestFields, parts: readonly WorldPartInfo[]): WorldManifest {
  return {
    app: WORLD_APP,
    kind: WORLD_KIND,
    format: WORLD_FORMAT,
    id: input.id,
    ...(input.title ? { title: input.title } : {}),
    made: input.made,
    readers: input.readers,
    parts: [...parts],
    recipe: recipeValue(input.recipe),
    plugins: input.plugins ?? [],
    revision: input.revision ?? { n: 1 },
  };
}

/** 清单 + 各块,还没装成文件 */
export interface PackedWorld {
  manifest: WorldManifest;
  parts: PackedPart[];
}

/** 打成清单 + 各块(见 packWorldFile);整个文件和按块存的都从这里出 */
export async function packWorldParts(input: PackInput): Promise<PackedWorld> {
  const parts: PackedPart[] = [await packKnown('map', mapValue(input.map))];
  if (input.eras?.eras.length) parts.push(await packKnown('eras', erasValue(input.eras)));
  const split = await splitSimStates(input.civ);
  const layers = await splitSimLayers(split.civ);
  parts.push(await packKnown('civ', layers.civ), await packKnown('chronicle', input.chronicle), await packKnown('flags', input.flags));
  if (input.author) parts.push(await packKnown('author', input.author));
  if (input.thumb) parts.push(await packThumb(input.thumb));
  if (input.planet) parts.push(await packKnown('planet', input.planet));
  parts.push(...split.parts, ...layers.parts);
  for (const l of input.layers ?? []) {
    const ids = pluginLayerOf(l.name);
    if (!ids) throw new Error(`插件图层不能叫 ${l.name}`);
    parts.push(await packPluginLayer(ids[0], ids[1], l.value));
  }
  for (const x of input.extras ?? []) parts.push(await packExtra(x));
  return { manifest: buildManifest(input, parts.map((p) => p.info)), parts };
}

/**
 * 打成世界文件。这里不跑 validateWorld、validateCiv:存是自己的数据,万一校验器误伤,东西也得先存下来;
 * 读的时候才核对(清单除外,写坏的清单谁都读不了)
 */
export async function packWorldFile(input: PackInput): Promise<Blob> {
  const { manifest, parts } = await packWorldParts(input);
  return assemble(manifest, parts, { ...input.readers }, input.maxBytes ?? ZIP_LOCAL_MAX_BYTES);
}

// ---------------------------------------------------------------------------
// 读

/** 读文件要知道的 */
export interface OpenOptions {
  /** 这一版软件有的读取规则版本(terrain、query) */
  readers: WorldReaders;
  /** 文件最大多少字节(不给 = 本机存取的上限;服务器传 ZIP_UPLOAD_MAX_BYTES) */
  maxBytes?: number;
  /** 迁移表(不给 = 现在的;单测用假的) */
  migrations?: MigrationTable;
}

/** 打开的文件:清单 + 各块压缩后的字节(还没解开) */
export interface OpenedWorldFile {
  manifest: WorldManifest;
  /** manifest.json 的原字节(算修订的指纹) */
  manifestBytes: Uint8Array;
  /** 块名 → 压缩后的字节 */
  bytes: ReadonlyMap<string, Uint8Array>;
  /** 这一版软件只当字节留着的块:need 是 extra,而且认不出,或者结构比软件新 */
  kept: readonly WorldPartInfo[];
  options: OpenOptions;
}

/**
 * 打开文件:核对外壳和清单,不解开各块。
 * ZIP 里的东西要和清单一一对上(多一个没列的也不行:那些字节没有清单担保,校验、审核都看不到)。
 * 文件可以是 Blob 或者内存里的字节;坏的报 broken,比软件新的报 newer
 */
export async function openWorldFile(file: Blob | Uint8Array, options: OpenOptions): Promise<OpenedWorldFile> {
  try {
    const maxBytes = options.maxBytes ?? ZIP_LOCAL_MAX_BYTES;
    const size = file instanceof Blob ? file.size : file.length;
    if (size > maxBytes) broken('文件太大');
    const entries = parseZip(file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : file, maxBytes);
    const files = new Map(entries.map((e) => [e.name, e.data]));
    const manifestBytes = files.get(MANIFEST_FILE);
    if (!manifestBytes) broken('文件里没有清单');
    const manifest = parseManifest(manifestBytes, { readers: options.readers, migrations: options.migrations, maxBytes });
    if (files.size !== manifest.parts.length + 1) broken('文件里的东西和清单对不上');
    const bytes = new Map<string, Uint8Array>();
    const kept: WorldPartInfo[] = [];
    for (const p of manifest.parts) {
      const data = files.get(p.file);
      if (!data) broken(`文件里缺 ${p.file}`);
      bytes.set(p.name, data);
      if (isKept(p, options.migrations)) kept.push(p);
    }
    return { manifest, manifestBytes, bytes, kept, options };
  } catch (err) {
    throw asWorldFileError(err);
  }
}

/**
 * 按块存着的一份(浏览器里的仓库,worldVault.ts)当成打开的文件:清单照读文件的规矩核对,块的字节直接用,不用先拼成 ZIP。
 * parts 可以只有几块(readViewContent 要的),这时候只能读那几块
 */
export function openStoredParts(manifestBytes: Uint8Array, parts: readonly PackedPart[], options: OpenOptions): OpenedWorldFile {
  try {
    const manifest = parseManifest(manifestBytes, { readers: options.readers, migrations: options.migrations, maxBytes: options.maxBytes ?? ZIP_LOCAL_MAX_BYTES });
    const bytes = new Map<string, Uint8Array>();
    for (const p of parts) bytes.set(p.info.name, p.data instanceof Uint8Array ? p.data : new Uint8Array(p.data));
    return { manifest, manifestBytes, bytes, kept: manifest.parts.filter((p) => isKept(p, options.migrations)), options };
  } catch (err) {
    throw asWorldFileError(err);
  }
}

/** 这一版软件只当字节留着的块 */
function isKept(p: WorldPartInfo, migrations?: MigrationTable): boolean {
  if (isSimState(p.name)) return p.schema > SIM_STATE_SCHEMA || (p.zip !== 'gzip' && p.zip !== 'none');
  if (isPluginLayer(p.name)) return p.schema > PLUGIN_LAYER_SCHEMA || (p.zip !== 'gzip' && p.zip !== 'none');
  return !KNOWN_PARTS.has(p.name) || p.schema > currentSchema(p.name, migrations) || (p.zip !== 'gzip' && p.zip !== 'none');
}

/**
 * 这一版软件只当字节留着、不解开的块的名字:插件存的数据、认不出的附加块、结构比软件新的可选块(推演插件的状态、插件图层逐项核对,不算)。
 * 带着它们的世界能存、能存成文件,不能公开分享(审核看不到里面);空的 = 没有这种块
 */
export function opaqueParts(parts: readonly WorldPartInfo[], migrations?: MigrationTable): string[] {
  return parts.filter((p) => isKept(p, migrations)).map((p) => p.name);
}

/** 解开的世界 */
export interface WorldContent extends WorldValues {
  eras: WorldEras | null;
  author: AuthorContent | null;
  thumb: Uint8Array | null;
  planet: PlanetValue | null;
  /** 配方照存档的办法读出来的那份(清理过);界面用这一份,不用清单里的原样 */
  save: SaveFile;
  /** 读配方时的提示(和打开存档时一样) */
  warnings: string[];
  /** 转不了结构的可选块(need 是 extra):读不出来,字节还留着 */
  skipped: string[];
  /** author 那一块没读进来:skipped = 字节好好的,校验没过(太长之类),字节留着;damaged = 字节坏了,对不上指纹 */
  authorTrouble?: 'skipped' | 'damaged';
}

/**
 * 解开、迁移一块(没有、只当字节留着的 = null);decode = 字节怎么变成值(封面就是字节本身)。
 * done = 读好了的几块:后面的块转结构时要看(编年史要看历史),调用方读完 civ 记进去
 */
function partReader(opened: OpenedWorldFile, skipped: string[], done: { civ?: Civ }) {
  const { manifest } = opened;
  const migrations = opened.options.migrations ?? MIGRATIONS;
  return async (name: string, decode: (b: Uint8Array) => unknown = (b) => unpackValue(b, worldHeadLimit(opened.options.maxBytes))): Promise<unknown> => {
    const info = manifest.parts.find((p) => p.name === name);
    if (!info || opened.kept.includes(info)) return null;
    const data = opened.bytes.get(name);
    if (!data) broken(`缺 ${name} 这一块`);
    const b = await partBytes(info as Pick<SnapshotPart, 'name' | 'bytes' | 'sum' | 'zip'>, data, worldPartLimit(name, opened.options.maxBytes));
    try {
      return migratePart(name, info.schema, decode(b), manifest, migrations, done);
    } catch (err) {
      // 可选的块转不了结构不碍看世界
      if (info.need === 'extra' && asWorldFileError(err).kind === 'readonly') {
        skipped.push(name);
        return null;
      }
      throw err;
    }
  };
}

/**
 * 只解开这几块:核指纹、迁移,不逐项校验。只给校验器已经过了的内容用(本机再打开世界时,见 worldOpen.ts);别人给的文件要走 readWorldContent。
 * 返回 块名 → 值(清单里没有这一块 = null)。读了历史的,推演插件的状态块也在 opened 里就接回去(读不出来、过不了校验 = 不接)
 */
export async function readTrustedParts(opened: OpenedWorldFile, names: readonly string[], done: { civ?: Civ } = {}): Promise<Record<string, unknown>> {
  const read = partReader(opened, [], done);
  const out: Record<string, unknown> = {};
  try {
    for (const n of names) {
      out[n] = await read(n);
      if (n === 'civ') done.civ = out[n] as Civ;
    }
    const civ = out.civ as Civ | null | undefined;
    const sims = simPartNames(opened);
    if (civ && sims.length && sims.every((n) => opened.bytes.has(n)) && civ.simPlugins === undefined) {
      const got = await readSimParts(opened, read, []).catch(() => []);
      if (got.length) civ.simPlugins = got;
    }
    const layers = historyLayerNames(opened);
    if (civ && layers.length && layers.every((n) => opened.bytes.has(n)) && civ.simLayers === undefined && out.map) {
      const got = await readLayerParts(opened, read, [], sizesOf(out.map as World, civ)).catch(() => []);
      if (got.length) civ.simLayers = got;
    }
    return out;
  } catch (err) {
    throw asWorldFileError(err);
  }
}

/**
 * 推演插件的状态(sim.<插件编号>,按文件里的先后)。可选的块:本机读的有一块读不出来、过不了校验,就都不要(接着推时从第 0 年重推),记进 skipped;
 * 内存不够、传上服务器的文件照旧报错
 */
async function readSimParts(opened: OpenedWorldFile, read: ReturnType<typeof partReader>, skipped: string[]): Promise<SimPluginState[]> {
  const infos = opened.manifest.parts.filter((p) => isSimState(p.name) && !opened.kept.includes(p));
  if (infos.length !== simPartNames(opened).length) return [];
  const out: SimPluginState[] = [];
  for (const p of infos) {
    try {
      const v = await read(p.name);
      validateSimState(v, p.name.slice(SIM_STATE_PREFIX.length));
      out.push(v);
    } catch (err) {
      if (asWorldFileError(err).kind === 'memory' || (opened.options.maxBytes ?? ZIP_LOCAL_MAX_BYTES) <= ZIP_UPLOAD_MAX_BYTES) throw err;
      skipped.push(...infos.map((x) => x.name));
      return [];
    }
  }
  return out;
}

/** 清单里推演插件状态块的名字(按文件里的先后) */
export function simPartNames(opened: Pick<OpenedWorldFile, 'manifest'>): string[] {
  return opened.manifest.parts.filter((p) => isSimState(p.name)).map((p) => p.name);
}

/** 清单里跟着历史走的插件图层块的名字(按文件里的先后) */
export function historyLayerNames(opened: Pick<OpenedWorldFile, 'manifest'>): string[] {
  const names = new Set(opened.manifest.parts.map((p) => p.name));
  return opened.manifest.parts.filter((p) => isHistoryLayer(p.name, (x) => names.has(x))).map((p) => p.name);
}

const sizesOf = (map: World, civ: Civ): LayerSizes => ({ cells: map.mesh.n, regions: civ.regions.count, endYear: civ.endYear });

/**
 * 插件图层:每一块都逐项核对(别的插件放的也查,它们不算只当字节留着的块);交回跟着历史走的那几块(按文件里的先后)。
 * 本机读的有一块过不了:跟着历史的那几块都不要,别的只跳过这一块,都记进 skipped;内存不够、传上服务器的文件照旧报错
 */
async function readLayerParts(opened: OpenedWorldFile, read: ReturnType<typeof partReader>, skipped: string[], sizes: LayerSizes): Promise<SimLayer[]> {
  const history = new Set(historyLayerNames(opened));
  const out: SimLayer[] = [];
  let whole = true;
  for (const p of opened.manifest.parts) {
    if (!isPluginLayer(p.name)) continue;
    if (opened.kept.includes(p) || !opened.bytes.has(p.name)) {
      if (history.has(p.name)) whole = false;
      continue;
    }
    try {
      const v = await read(p.name);
      const hist = history.has(p.name);
      // 按地块、不跟着历史的年份不受历史长短限制(地图换了历史也还在)
      const byRegion = typeof v === 'object' && v !== null && (v as { unit?: unknown }).unit === 'region';
      validatePluginLayer(v, hist || byRegion ? sizes : { cells: sizes.cells, regions: sizes.regions }, `插件图层 ${p.name}`);
      if (byRegion && v.years === undefined) broken(`插件图层 ${p.name} 按州的要带年份`);
      if (!hist) continue;
      // 历史里的推演插件图层:按州(带年份)或按地块(写进文件时记成 cell)
      if (v.years === undefined) broken(`插件图层 ${p.name} 是推演插件的,要带年份`);
      const [by, id] = pluginLayerOf(p.name)!;
      out.push({ by, id, ...v, unit: byRegion ? 'region' : 'tile' } as SimLayer);
    } catch (err) {
      if (asWorldFileError(err).kind === 'memory' || (opened.options.maxBytes ?? ZIP_LOCAL_MAX_BYTES) <= ZIP_UPLOAD_MAX_BYTES) throw err;
      skipped.push(p.name);
      if (history.has(p.name)) whole = false;
    }
  }
  if (whole) return out;
  for (const l of out) skipped.push(pluginLayerPart(l.by, l.id));
  return [];
}

const AUTHOR_SKIPPED = 'AI 写的东西有一段太长，这次没读进来。世界不受影响，文件先别删';
const AUTHOR_DAMAGED = 'AI 写的东西这次没读出来，可能没存完整。世界不受影响，文件先别删';

/**
 * author 是可选的,过不了校验不连累整个世界:跳过,给提示,字节还在 opened 里,另存时照样带着。
 * 内存不够不算过不了(东西可能是好的),照常往外抛。传上服务器的文件照旧要全部合格:那边不留说不清的东西
 */
async function readAuthorPart(opened: OpenedWorldFile, read: ReturnType<typeof partReader>): Promise<{ author: AuthorContent | null; trouble?: 'skipped' | 'damaged' }> {
  const info = opened.manifest.parts.find((p) => p.name === 'author');
  if (!info || opened.kept.includes(info)) return { author: null };
  const pass = (err: unknown) => asWorldFileError(err).kind === 'memory' || (opened.options.maxBytes ?? ZIP_LOCAL_MAX_BYTES) <= ZIP_UPLOAD_MAX_BYTES;
  try {
    await partBytes(info as Pick<SnapshotPart, 'name' | 'bytes' | 'sum' | 'zip'>, opened.bytes.get('author')!, worldPartLimit('author', opened.options.maxBytes));
  } catch (err) {
    if (pass(err)) throw err;
    return { author: null, trouble: 'damaged' };
  }
  try {
    const author = (await read('author')) as AuthorContent | null;
    if (author) validateAuthor(author);
    return { author };
  } catch (err) {
    if (pass(err)) throw err;
    return { author: null, trouble: 'skipped' };
  }
}

/** 本机打开存的世界读到的内容:编年史、国旗读不出来 = null */
export type StoredContent = Omit<WorldContent, 'chronicle' | 'flags'> & { chronicle: ChronicleBlock | null; flags: FlagBook | null };

/**
 * 解开各块、迁移到现在的结构、逐项核对。原件的字节不动,出错了 opened 还能照样另存。
 * 只当字节留着的块(opened.kept)不解开。需要的块坏了报 broken;转不了结构报 readonly
 */
export function readWorldContent(opened: OpenedWorldFile): Promise<WorldContent> {
  return readContent(opened, false) as Promise<WorldContent>;
}

/** 同 readWorldContent,只是编年史、国旗读不出来、校验不过不算世界坏了:这两块能重新算出来,读不了 = null(本机打开存的世界时用,见 worldOpen.ts) */
export function readStoredContent(opened: OpenedWorldFile): Promise<StoredContent> {
  return readContent(opened, true);
}

async function readContent(opened: OpenedWorldFile, spare: boolean): Promise<StoredContent> {
  const { manifest } = opened;
  const skipped: string[] = [];
  const done: { civ?: Civ } = {};
  const read = partReader(opened, skipped, done);
  try {
    const map = await read('map');
    validateWorld(map);
    const eras = (await read('eras')) as WorldEras | null;
    if (eras) validateEras(eras, map);
    const civ = await read('civ');
    validateCiv(civ, map);
    done.civ = civ;
    // 各段历史按下标对各段世界(有的大事还没推到,世界可以比历史多,不能少)
    if ((civ.eras?.length ?? 0) > (eras?.eras.length ?? 0)) broken('历史的各段比世界的各段多');
    const sims = await readSimParts(opened, read, skipped);
    if (sims.length) {
      if (civ.simPlugins !== undefined) broken('推演插件的状态在历史里和单独的块里都有');
      civ.simPlugins = sims;
    }
    const layers = await readLayerParts(opened, read, skipped, sizesOf(map, civ));
    if (layers.length) {
      if (civ.simLayers !== undefined) broken('推演插件的图层在历史里和单独的块里都有');
      civ.simLayers = layers;
    }
    /** 读一块、校验;spare 时读不了 = null */
    const story = async <T>(name: string, check: (v: unknown) => asserts v is T): Promise<T | null> => {
      try {
        const v = await read(name);
        check(v);
        return v;
      } catch (err) {
        if (!spare) throw err;
        return null;
      }
    };
    const chronicle = await story<ChronicleBlock>('chronicle', (v) => validateChronicle(v, civ));
    const flags = await story<FlagBook>('flags', (v) => validateFlags(v, civ));
    const got = await readAuthorPart(opened, read);
    if (got.trouble) skipped.push('author');
    const thumb = (await read('thumb', (b) => b)) as Uint8Array | null;
    if (thumb) validateThumb(thumb);
    // 本机读的过不了只是没装地图插件时推不了历史,世界照样开
    const planet = await story<PlanetValue | null>('planet', (v) => {
      if (v !== null) validatePlanet(v, map);
    });
    const r = parseSave(JSON.stringify(manifest.recipe));
    if (!r.ok) broken(r.error);
    const warnings = got.trouble ? [...r.warnings, got.trouble === 'damaged' ? AUTHOR_DAMAGED : AUTHOR_SKIPPED] : r.warnings;
    return { map, eras, civ, chronicle, flags, author: got.author, thumb, planet, save: r.save, warnings, skipped, ...(got.trouble ? { authorTrouble: got.trouble } : {}) };
  } catch (err) {
    throw asWorldFileError(err);
  }
}

// ---------------------------------------------------------------------------
// 另存

/** 另存时改什么;没写的照原样 */
export interface RewriteChange {
  title?: string;
  made?: WorldMade;
  readers?: WorldReaders;
  recipe?: SaveFile;
  plugins?: WorldPlugin[];
  /** 换掉的块;eras、author、thumb、planet 给 null = 去掉这一块 */
  values?: Partial<WorldValues>;
  /** 文件最大多少字节(不给 = 本机存取的上限) */
  maxBytes?: number;
}

/** 文件里工具插件存的按州图层的块名(不算 skip 里的、只当字节留着的;读不出来的不算) */
async function regionLayerNames(opened: OpenedWorldFile, skip: ReadonlySet<string>): Promise<string[]> {
  const out: string[] = [];
  for (const p of opened.manifest.parts) {
    if (!isPluginLayer(p.name) || skip.has(p.name) || opened.kept.includes(p)) continue;
    try {
      const v = unpackValue(await partBytes(p as Pick<SnapshotPart, 'name' | 'bytes' | 'sum' | 'zip'>, opened.bytes.get(p.name)!, PLUGIN_LAYER_MAX_BYTES)) as { unit?: unknown } | null;
      if (v?.unit === 'region') out.push(p.name);
    } catch {
      // 读不出来的照原样带着
    }
  }
  return out;
}

/**
 * 另存一份:改清单、换几块,修订号加一、记上一份清单的指纹。没换的块(包括认不出的附加数据)字节不动;清单里认不出的字段也原样带着。
 * 换掉的块按现在的结构写
 */
export async function rewriteWorldFile(opened: OpenedWorldFile, change: RewriteChange = {}): Promise<Blob> {
  const { manifest } = opened;
  const v = change.values ?? {};
  const table = opened.options.migrations;
  const replaced = new Map<string, PackedPart | null>();
  if (v.map) replaced.set('map', await packKnown('map', mapValue(v.map), table));
  if (v.eras !== undefined) replaced.set('eras', v.eras?.eras.length ? await packKnown('eras', erasValue(v.eras), table) : null);
  // 推演插件的状态、图层跟着历史走:换了历史,原来的那几块都去掉(别的插件存的图层不动),换上这份历史带的
  const sims = v.civ ? await splitSimStates(v.civ) : null;
  const layers = sims ? await splitSimLayers(sims.civ) : null;
  if (layers) replaced.set('civ', await packKnown('civ', layers.civ, table));
  if (v.chronicle) replaced.set('chronicle', await packKnown('chronicle', v.chronicle, table));
  if (v.flags) replaced.set('flags', await packKnown('flags', v.flags, table));
  if (v.author !== undefined) replaced.set('author', v.author ? await packKnown('author', v.author, table) : null);
  if (v.thumb !== undefined) replaced.set('thumb', v.thumb ? await packThumb(v.thumb, table) : null);
  if (v.planet !== undefined) replaced.set('planet', v.planet ? await packKnown('planet', v.planet, table) : null);

  const parts: PackedPart[] = [];
  const stale = new Set(sims ? historyParts(manifest.parts.map((p) => p.name)) : []);
  for (const q of layers?.parts ?? []) stale.add(q.info.name);
  // 工具插件存的按州图层照旧历史算的:历史真变了(civ 块不一样)就去掉
  const oldCiv = manifest.parts.find((p) => p.name === 'civ');
  const newCiv = replaced.get('civ');
  if (newCiv && oldCiv && newCiv.info.sum !== oldCiv.sum) for (const name of await regionLayerNames(opened, stale)) stale.add(name);
  for (const p of manifest.parts) {
    if (stale.has(p.name)) continue;
    if (!replaced.has(p.name)) parts.push({ info: p, data: opened.bytes.get(p.name)! });
    else {
      const next = replaced.get(p.name);
      if (next) parts.push(next);
      replaced.delete(p.name);
    }
  }
  if (sims) parts.push(...sims.parts, ...layers!.parts);
  // 原来没有、这次才有的块
  for (const next of replaced.values()) if (next) parts.push(next);

  const readers = change.readers ?? manifest.readers;
  const next: WorldManifest = {
    ...manifest,
    ...(change.title !== undefined ? { title: change.title } : {}),
    ...(change.made ? { made: change.made } : {}),
    readers,
    parts: parts.map((p) => p.info),
    recipe: recipeValue(change.recipe ?? manifest.recipe),
    plugins: change.plugins ?? manifest.plugins,
    revision: { n: manifest.revision.n + 1, parent: await sha256(opened.manifestBytes) },
  };
  return assemble(next, parts, { ...opened.options.readers, ...readers }, change.maxBytes ?? ZIP_LOCAL_MAX_BYTES, opened.options.migrations);
}
