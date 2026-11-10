/**
 * 逐项核对世界文件读出来的内容。文件是别人给的,每一个数字、每一个字都可能是乱填的:读包函数(snapshot.ts)只保证能安全读完,
 * 读出来的东西对不对在这里查。地块数、编号、年份这些错了,后面画图、查询的代码会读越界、卡死或者白屏。
 *
 * 规矩:
 * - 不合格就抛 WorldFileError(broken),不尝试修。比软件新的版本号抛 newer。别的错不会有:任何字段都先查类型再用
 * - 只拦读坏了会出事的东西,不拦「看着不太对」的:**误伤好世界比漏掉坏文件更糟**,好世界被拦下就是打不开了。
 *   所以每条规则都拿真实世界(默认、地形大事、20 万地块、长历史)跑过,比如地块数的下限比参数范围低,因为实际撒出来的点比参数少约 6%;
 *   ideology.arrive 里的 NaN、development.found 里的 Infinity 都是约定的写法,不在非数检查的范围里
 * - 能在 worker 和 Node 里跑(服务器共用同一份),不碰 DOM。每一项的耗时都和数据量成正比,没有会卡死的循环
 *
 * 对外:parseManifest(清单)、validateWorld(地图)、validateEras(地形大事以后的各段)、validateCiv(历史)、
 * validateChronicle(编年史)、validateFlags(旗)、validateAuthor(作者内容)、validateThumb(封面)、validatePluginLayer(插件图层)、
 * validatePlanet(星球参照)。
 */
import { BIOMES } from './biomes';
import { BOOK_COLS } from './civ/fiscalBook';
import { CAP_COUNT, RESOURCE_COUNT } from './civ/development';
import { THOUGHT_COUNT } from './civ/ideology';
import { TINCTS, decodeFlag, encodeFlag, type FlagSpec } from './civ/story/flagSpec';
import { ANNAL_KINDS } from './civ/annals';
import type { EntryKind } from './civ/story/chronicle';
import type { ChronicleBlock } from './civ/story/nameTokens';
import type { FlagBook, Seat } from './civ/story/flags';
import type { AnnalKind, Civ, CultureKind, DevEvent, ExileTie, FaithEventKind, FaithKind, Person, PersonDeed, PersonExile, PersonFate, PersonRegency, Place, Regions, Route, RulerRise } from './civ/types';
import type { TradeEvent } from './civ/trade';
import { END_YEAR_MAX } from './edits';
import { PARAM_RANGE, SAVE_FORMAT, parseSave } from './savefile';
import { SKETCH_H, SKETCH_W } from './sketch';
import { LOCAL_HEAD_MAX_BYTES, LOCAL_PART_MAX_BYTES, checkDepth, partLimit } from './snapshot';
import { TERRAIN_MAX_OPS, cleanTerrainOp } from './terrainOps';
import { MAP_H, MAP_W, type World } from './world';
import { currentSchema, type MigrationTable } from './worldMigrate';
import {
  KNOWN_PARTS,
  PLUGIN_DATA_MAX_BYTES,
  PLUGIN_DATA_PREFIX,
  PLUGIN_ID,
  PLUGIN_ID_MAX,
  PLUGIN_LAYERS_MAX,
  PLUGIN_LAYER_ID,
  PLUGIN_LAYER_MAX_BYTES,
  PLUGIN_LAYER_PREFIX,
  SIM_STATE_MAX_BYTES,
  SIM_STATE_PREFIX,
  WORLD_APP,
  WORLD_FORMAT,
  WORLD_KIND,
  broken,
  newer,
  pluginLayerOf,
  type AuthorContent,
  type PlanetValue,
  type PluginLayerValue,
  type WorldManifest,
} from './worldFormat';
import { PLUGIN_LIMITS, cleanRefused, type SimPluginState } from './civ/engine/plugin';
import { OFFICIAL_INFLUENCES } from './civ/influence';
import { checkStoredChronicle, type ChronicleRefKind } from './civ/engine/pluginChronicle';
import { checkLayerLook, sameLayerLook } from './layerLook';
import { ZIP_LOCAL_MAX_BYTES, ZIP_UPLOAD_MAX_BYTES } from './zipStore';

// ---------------------------------------------------------------------------
// 小工具

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v) && !ArrayBuffer.isView(v) && !(v instanceof Map) && !(v instanceof Set);

function obj(v: unknown, at: string): Obj {
  if (!isObj(v)) broken(`${at} 不是对象`);
  return v;
}

function list(v: unknown, at: string): unknown[] {
  if (!Array.isArray(v)) broken(`${at} 不是列表`);
  return v;
}

type TypedCtor<T> = { new (n: number): T; readonly name: string };

/** 指定种类的数字数组;len 给了就核对长度 */
function typed<T extends ArrayLike<number>>(v: unknown, C: TypedCtor<T>, at: string, len?: number): T {
  if (!(v instanceof (C as unknown as abstract new () => object))) broken(`${at} 不是 ${C.name}`);
  const a = v as unknown as T;
  if (len !== undefined && a.length !== len) broken(`${at} 的长度不对:${a.length},应该是 ${len}`);
  return a;
}

function allFinite(a: ArrayLike<number>, at: string, n = a.length): void {
  for (let i = 0; i < n; i++) if (!Number.isFinite(a[i])) broken(`${at}[${i}] 不是数`);
}

/** 每个值都在 [lo, hi) 里(NaN 过不去) */
function allIn(a: ArrayLike<number>, lo: number, hi: number, at: string, n = a.length): void {
  for (let i = 0; i < n; i++) if (!(a[i] >= lo && a[i] < hi)) broken(`${at}[${i}] 超出范围`);
}

/** 不减:年份一类按先后排的 */
function ascending(a: ArrayLike<number>, at: string, n = a.length): void {
  for (let i = 1; i < n; i++) if (a[i] < a[i - 1]) broken(`${at} 没按先后排`);
}

function num(v: unknown, at: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) broken(`${at} 不是数`);
  return v;
}

/** [lo, hi) 里的整数 */
function int(v: unknown, lo: number, hi: number, at: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v >= hi) broken(`${at} 超出范围`);
  return v;
}

const optNum = (v: unknown, at: string) => {
  if (v !== undefined) num(v, at);
};

/**
 * 年份绝对值的上限。有的年份合法地比结束那年晚(还没诞生的民族、到期要废的路),也有早于第 0 年的(开国之君的生年),都到不了这个数。
 * 再大的数没有真实世界用得上,而且界面上按年份走的循环(一步 20 年之类)碰到 1e300 这种数,加上步长也不变,就卡死了
 */
const YEAR_ABS_MAX = 1e6;

function yearOk(v: unknown, at: string): number {
  const y = num(v, at);
  if (Math.abs(y) > YEAR_ABS_MAX) broken(`${at} 的年份太离谱`);
  return y;
}

const optYearOk = (v: unknown, at: string) => {
  if (v !== undefined) yearOk(v, at);
};
const optInt = (v: unknown, lo: number, hi: number, at: string) => {
  if (v !== undefined) int(v, lo, hi, at);
};

/** 控制字符:名字一类的字里不该有(换行、制表符只在长文里有) */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function str(v: unknown, at: string, max: number): string {
  if (typeof v !== 'string') broken(`${at} 不是字符串`);
  if (v.length > max) broken(`${at} 太长`);
  return v;
}

/**
 * 有就得是字符串。界面拿这些字段直接当文字显示,混进一个对象 React 就抛错、白屏(allStrings 只管字符串的长度,不管该是字符串的地方是不是字符串)
 */
function optStr(v: unknown, at: string, max: number): void {
  if (v !== undefined) str(v, at, max);
}

function oneOf(v: unknown, values: readonly string[], at: string): void {
  if (typeof v !== 'string' || !values.includes(v)) broken(`${at} 认不出`);
}

/** 颜色:[红, 绿, 蓝],只认 0–255 的数(不许字符串,进了样式就是能跑的东西) */
function rgb(v: unknown, at: string): void {
  const c = list(v, at);
  if (c.length !== 3) broken(`${at} 不是三个数`);
  for (const x of c) if (typeof x !== 'number' || !(x >= 0 && x <= 255)) broken(`${at} 不是颜色`);
}

/**
 * 「上级」一类的链不许绕成圈:next(i) 是 i 的上一级(没有 = undefined、−1)。
 * 走过的做记号,每个编号最多走一遍,链再长也是线性的
 */
function noCycle(n: number, next: (i: number) => number | undefined, at: string): void {
  const state = new Uint8Array(n); // 0 没走过,1 正走着,2 走完了
  const path: number[] = [];
  for (let i = 0; i < n; i++) {
    let j: number | undefined = i;
    path.length = 0;
    while (j !== undefined && j >= 0 && state[j] === 0) {
      state[j] = 1;
      path.push(j);
      j = next(j);
    }
    if (j !== undefined && j >= 0 && state[j] === 1) broken(`${at} 绕成了圈`);
    for (const p of path) state[p] = 2;
  }
}

/**
 * 值里所有字符串:一条不超过 maxOne,加起来不超过 maxTotal。同一个对象只走一遍(引用)。
 * 读包函数限了层数,这里递归不会把栈撑爆
 */
function allStrings(root: unknown, maxOne: number, maxTotal: number, at: string): void {
  const seen = new Set<object>();
  let total = 0;
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.length > maxOne) broken(`${at} 里有太长的字`);
      total += v.length;
      if (total > maxTotal) broken(`${at} 里的字太多`);
      return;
    }
    if (v === null || typeof v !== 'object' || ArrayBuffer.isView(v) || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) v.forEach(walk);
    else if (v instanceof Map) {
      for (const [k, x] of v) {
        walk(k);
        walk(x);
      }
    } else if (v instanceof Set) v.forEach(walk);
    else {
      for (const k of Object.keys(v)) {
        // 字段名都是代码写死的,给人看的字才算总字数(字段名加起来比字还多)
        if (k.length > maxOne) broken(`${at} 里有太长的字`);
        walk((v as Obj)[k]);
      }
    }
  };
  walk(root);
}

// ---------------------------------------------------------------------------
// 清单

/**
 * 清单最多多大。清单里最大的是配方:存档读的时候最多 8 MiB 个字符(savefile.ts),全是汉字时 UTF-8 下约 25 MB,
 * 其余的块、插件的列表再大也就几 MB。按存得下的算,不能让现在打得开的存档放进文件以后反而打不开
 */
export const MANIFEST_MAX_BYTES = 32e6;
/** 最多几块:一个世界连同插件的附加数据也就几十块 */
const MANIFEST_MAX_PARTS = 1024;
/** 最多记几个插件 */
const MANIFEST_MAX_PLUGINS = 64;
/** 一个插件的参数最多多少字(只有数据;这里写不下的放附加数据那一块) */
const PLUGIN_PARAMS_MAX = 64 * 1024;
/** 世界编号最长几个字(老世界的编号是种子 + 参数拼的,有几百个字) */
const ID_MAX = 1024;
/** 世界名最长几个字(界面上还要短得多,这里只防离谱的) */
const TITLE_MAX = 256;
/** 块名最长几个字 */
const PART_NAME_MAX = 64;

const SUM = /^[0-9a-f]{64}$/;
/** 块名:小写字母开头,点分几段(ext.magic-sim);只有小写,解压到不分大小写的磁盘上也不会撞 */
const PART_NAME = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;
/** 块的路径:parts/ 底下一层 */
const PART_FILE = /^parts\/[a-z0-9][a-z0-9._-]{0,127}$/;
/** Windows 上不能当文件名的几个词(带不带后缀都不行) */
const WINDOWS_RESERVED = /^parts\/(con|prn|aux|nul|com\d|lpt\d)(\.|$)/;
/** 插件编号、插件的用途、kind、读取规则的名字这些短名字 */
const SHORT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** 版本号这种给人看的短字:可见的 ASCII 字符 */
const VERSION_TEXT = /^[!-~]{1,64}$/;

/** 不许当对象键的名字(和 snapshot.ts 一样):读进来会换掉对象的原型、盖掉谁都有的字段 */
function noBadKeys(root: unknown): void {
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') broken(`清单里有不许用的键 ${k}`);
        walk((v as Obj)[k]);
      }
    }
  };
  walk(root);
}

/** 读清单要知道的:这一版软件的读取规则版本、迁移表、文件的大小上限 */
export interface ManifestOptions {
  /** 这一版软件有的读取规则版本(terrain、query) */
  readers: Readonly<Record<string, number>>;
  /** 不给 = 现在的 MIGRATIONS(单测用假的) */
  migrations?: MigrationTable;
  /** 这个文件的大小上限(不给 = 本机存取的上限);按它定各块解压的上限,见 worldPartLimit */
  maxBytes?: number;
}

/**
 * 一块解压后最多多大:传上服务器的文件照量过的表(snapshot.ts 的 partLimit),压缩炸弹撑不开内存;
 * 本机存取的世界不设额度,只防撑爆内存(LOCAL_PART_MAX_BYTES)。封面是一张小图,哪儿都照表
 */
export function worldPartLimit(name: string, maxBytes: number = ZIP_LOCAL_MAX_BYTES): number {
  return maxBytes <= ZIP_UPLOAD_MAX_BYTES || name === 'thumb' ? partLimit(name) : LOCAL_PART_MAX_BYTES;
}

/** 一块里结构(JSON)最多多大,分法同 worldPartLimit;undefined = 读包函数自己的上限 */
export function worldHeadLimit(maxBytes: number = ZIP_LOCAL_MAX_BYTES): number | undefined {
  return maxBytes <= ZIP_UPLOAD_MAX_BYTES ? undefined : LOCAL_HEAD_MAX_BYTES;
}

/** 配方:照存档那样读一遍,读不了的算坏;比软件新的报 newer。origin.url 只认 https(界面上它是能点的链接) */
function checkRecipe(raw: unknown): void {
  const r = obj(raw, '配方');
  if (typeof r.format === 'number' && r.format > SAVE_FORMAT) newer(`配方比软件新(存档格式 ${r.format})`);
  const read = parseSave(JSON.stringify(r));
  if (!read.ok) {
    // parseSave 把「比软件新」写在错误的话里(规则换算的版本比软件新时走这里)
    if (read.error.includes('更新版本')) newer(read.error);
    broken(`配方不对:${read.error}`);
  }
  if (r.origin !== undefined) {
    const o = obj(r.origin, '配方的 origin');
    if (typeof o.url !== 'string' || !o.url.startsWith('https://')) broken('配方的 origin.url 只认 https');
  }
}

function checkPartInfo(raw: unknown, at: string, opts: ManifestOptions): void {
  const p = obj(raw, at);
  const name = str(p.name, `${at}.name`, PART_NAME_MAX);
  if (!PART_NAME.test(name)) broken(`${at}.name 不合规矩`);
  const file = str(p.file, `${at}.file`, 255);
  if (!PART_FILE.test(file) || WINDOWS_RESERVED.test(file) || /[. ]$/.test(file) || file.includes('..')) broken(`${at}.file 不合规矩`);
  const schema = int(p.schema, 1, Number.MAX_SAFE_INTEGER, `${at}.schema`);
  if (typeof p.sum !== 'string' || !SUM.test(p.sum)) broken(`${at}.sum 不是 SHA-256`);
  const bytes = int(p.bytes, 0, Number.MAX_SAFE_INTEGER, `${at}.bytes`);
  const zip = str(p.zip, `${at}.zip`, 32);
  if (!SHORT_NAME.test(zip)) broken(`${at}.zip 不合规矩`);
  oneOf(p.need, ['view', 'extra'], `${at}.need`);
  if (p.by !== undefined && (typeof p.by !== 'string' || !SHORT_NAME.test(p.by))) broken(`${at}.by 不合规矩`);
  if (name.startsWith(PLUGIN_DATA_PREFIX)) {
    const id = name.slice(PLUGIN_DATA_PREFIX.length);
    if (id.length > PLUGIN_ID_MAX || !PLUGIN_ID.test(id)) broken(`${at}.name 不是插件编号`);
    // 看世界永远用不着插件
    if (p.need !== 'extra') broken(`${at} 是插件存的数据,只能是 extra`);
    if (p.by !== id) broken(`${at}.by 要写存它的插件 ${id}`);
    if (bytes > PLUGIN_DATA_MAX_BYTES) broken(`${name} 这一块超过上限`);
  }
  if (name.startsWith(SIM_STATE_PREFIX)) {
    const id = name.slice(SIM_STATE_PREFIX.length);
    if (id.length > PLUGIN_ID_MAX || !PLUGIN_ID.test(id)) broken(`${at}.name 不是插件编号`);
    if (p.need !== 'extra') broken(`${at} 是推演插件的状态,只能是 extra`);
    if (p.by !== id) broken(`${at}.by 要写推演插件 ${id}`);
    if (bytes > SIM_STATE_MAX_BYTES) broken(`${name} 这一块超过上限`);
  }
  if (name.startsWith(PLUGIN_LAYER_PREFIX)) {
    const ids = pluginLayerOf(name);
    if (!ids) broken(`${at}.name 不是 layer.<插件编号>.<图层编号>`);
    if (p.need !== 'extra') broken(`${at} 是插件图层,只能是 extra`);
    if (p.by !== ids![0]) broken(`${at}.by 要写插件 ${ids![0]}`);
    if (bytes > PLUGIN_LAYER_MAX_BYTES) broken(`${name} 这一块超过上限`);
  }
  const known = KNOWN_PARTS.get(name);
  // 必须有的块只能是 view:当成可选,读的时候就跳过了
  if (known?.required && p.need !== 'view') broken(`${at} 必须是 view`);
  if (p.need === 'view') {
    if (!known) newer(`${name} 这一块要新版软件才看得懂`);
    if (schema > currentSchema(name, opts.migrations)) newer(`${name} 这一块比软件新(第 ${schema} 版)`);
    if (zip !== 'gzip' && zip !== 'none') newer(`${name} 这一块的压缩方式要新版软件才解得开`);
    if (bytes > worldPartLimit(name, opts.maxBytes)) broken(`${name} 这一块超过上限`);
  }
}

/** 清单里插件名字最长几个字(和插件文件清单的 name 一样) */
const PLUGIN_NAME_MAX = 40;

function checkPlugin(raw: unknown, at: string): void {
  const p = obj(raw, at);
  if (typeof p.id !== 'string' || !SHORT_NAME.test(p.id)) broken(`${at}.id 不合规矩`);
  if (typeof p.version !== 'string' || !VERSION_TEXT.test(p.version)) broken(`${at}.version 不合规矩`);
  if (typeof p.sum !== 'string' || !SUM.test(p.sum)) broken(`${at}.sum 不是 SHA-256`);
  if (typeof p.role !== 'string' || !SHORT_NAME.test(p.role)) broken(`${at}.role 不合规矩`);
  if (p.name !== undefined && (typeof p.name !== 'string' || !p.name.trim() || p.name.length > PLUGIN_NAME_MAX || CONTROL.test(p.name))) broken(`${at}.name 不合规矩`);
  if (p.params !== undefined && JSON.stringify(obj(p.params, `${at}.params`)).length > PLUGIN_PARAMS_MAX) broken(`${at}.params 太大`);
}

/** 清单的字节 → 清单。坏的报 broken,比软件新的报 newer;先看版本号:比软件新的文件别的字段可能都变了,不能按这一版的规矩查 */
export function parseManifest(bytes: Uint8Array, opts: ManifestOptions): WorldManifest {
  if (bytes.length > MANIFEST_MAX_BYTES) broken('清单太大');
  let raw: unknown;
  try {
    checkDepth(bytes);
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    broken('清单不是合格的 JSON');
  }
  const m = obj(raw, '清单');
  noBadKeys(m);
  if (m.app !== WORLD_APP) broken('这不是「文明与地图」的世界文件');
  const format = int(m.format, 1, Number.MAX_SAFE_INTEGER, '清单的 format');
  if (format > WORLD_FORMAT) newer(`文件比软件新(格式 ${format})`);
  if (typeof m.kind !== 'string' || !SHORT_NAME.test(m.kind)) broken('清单的 kind 不合规矩');
  if (m.kind !== WORLD_KIND) newer(`这种文件(${m.kind})要新版软件才打得开`);

  const id = str(m.id, '清单的 id', ID_MAX);
  if (!id || CONTROL.test(id)) broken('清单的 id 不合规矩');
  if (m.title !== undefined && CONTROL.test(str(m.title, '清单的 title', TITLE_MAX))) broken('清单的 title 不合规矩');

  const made = obj(m.made, '清单的 made');
  if (typeof made.app !== 'string' || !VERSION_TEXT.test(made.app)) broken('清单的 made.app 不合规矩');
  int(made.generator, 0, Number.MAX_SAFE_INTEGER, '清单的 made.generator');
  if (typeof made.commit !== 'string' || (made.commit !== '' && !VERSION_TEXT.test(made.commit))) broken('清单的 made.commit 不合规矩');
  if (typeof made.at !== 'string' || made.at.length > 64 || Number.isNaN(Date.parse(made.at))) broken('清单的 made.at 不是时间');

  const readers = obj(m.readers, '清单的 readers');
  for (const need of ['terrain', 'query']) if (readers[need] === undefined) broken(`清单的 readers 缺 ${need}`);
  for (const k of Object.keys(readers)) {
    if (!SHORT_NAME.test(k)) broken('清单的 readers 不合规矩');
    const v = int(readers[k], 1, Number.MAX_SAFE_INTEGER, `清单的 readers.${k}`);
    const have = Object.prototype.hasOwnProperty.call(opts.readers, k) ? opts.readers[k] : 0;
    if (v > have) newer(`读这个世界要新版软件(读取规则 ${k} 第 ${v} 版)`);
  }

  const parts = list(m.parts, '清单的 parts');
  if (parts.length > MANIFEST_MAX_PARTS) broken('清单的块太多');
  const names = new Set<string>();
  const files = new Set<string>();
  parts.forEach((p, i) => {
    checkPartInfo(p, `清单的 parts[${i}]`, opts);
    const { name, file } = p as { name: string; file: string };
    if (names.has(name)) broken(`清单里有两块都叫 ${name}`);
    if (files.has(file)) broken(`清单里有两块都放在 ${file}`);
    names.add(name);
    files.add(file);
  });
  for (const [name, info] of KNOWN_PARTS) if (info.required && !names.has(name)) broken(`缺 ${name} 这一块`);
  if ([...names].filter((n) => n.startsWith(PLUGIN_LAYER_PREFIX)).length > PLUGIN_LAYERS_MAX) broken(`插件图层最多 ${PLUGIN_LAYERS_MAX} 个`);

  const plugins = list(m.plugins, '清单的 plugins');
  if (plugins.length > MANIFEST_MAX_PLUGINS) broken('清单的插件太多');
  plugins.forEach((p, i) => checkPlugin(p, `清单的 plugins[${i}]`));

  const rev = obj(m.revision, '清单的 revision');
  int(rev.n, 1, Number.MAX_SAFE_INTEGER, '清单的 revision.n');
  if (rev.parent !== undefined && (typeof rev.parent !== 'string' || !SUM.test(rev.parent))) broken('清单的 revision.parent 不是 SHA-256');

  checkRecipe(m.recipe);
  return m as unknown as WorldManifest;
}

// ---------------------------------------------------------------------------
// 地图

/**
 * 地块数的范围。参数 cells 的范围是 2000–200000,实际撒出来的点比参数少约 6%(参数 2000 实际约 1880),
 * 所以下限要比 2000 低,不然最小的世界打不开;上限不会超过参数
 */
const CELLS_MIN = 1500;
const CELLS_MAX = 200000;
/** 地块间距的范围,见 checkMesh */
const MESH_SPACING_RANGE: readonly [number, number] = [1, 64];
/**
 * 海拔、气候各数组的范围(都比实测留了几十倍:造山、气温、降水开到头时海拔实测 −7551–30552 米,气温 −172–68 度,降水最高 102324,径流最高 4699)。
 * 只防离谱的数,不是说世界就该长这样
 */
const FIELD_RANGE: Readonly<Record<string, readonly [number, number]>> = {
  elevation: [-1e6, 1e6],
  waterLevel: [-1e6, 1e6],
  temperature: [-1e4, 1e4],
  precipitation: [-1, 1e7],
  seaIce: [-1, 2],
  flux: [-1, 1e12],
};

/** 网格:长度、邻接、三角形的编号都对得上 */
function checkMesh(raw: unknown): number {
  const m = obj(raw, '地图的 mesh');
  const n = int(m.n, CELLS_MIN, CELLS_MAX + 1, '地块数');
  if (m.width !== MAP_W || m.height !== MAP_H) broken('地图的尺寸不对');
  // 地块间距决定找最近地块的格子多大、铺像素时刷多宽:太小找不到头,太大刷不完。实际约 2(20 万地块)到 21(2000 地块)
  const spacing = num(m.spacing, '地图的 mesh.spacing');
  if (spacing < MESH_SPACING_RANGE[0] || spacing > MESH_SPACING_RANGE[1]) broken('地图的 mesh.spacing 不对');
  const x = typed(m.x, Float32Array, '地图的 mesh.x', n);
  const y = typed(m.y, Float32Array, '地图的 mesh.y', n);
  // 坐标决定铺像素时落在哪一格:差一点没事,离谱的会越界
  allIn(x, -1, MAP_W + 1, '地图的 mesh.x');
  allIn(y, -1, MAP_H + 1, '地图的 mesh.y');
  // 单位球面上的点
  allIn(typed(m.xyz, Float32Array, '地图的 mesh.xyz', n * 3), -1.01, 1.01, '地图的 mesh.xyz');
  const start = typed(m.adjStart, Int32Array, '地图的 mesh.adjStart', n + 1);
  const adj = typed(m.adj, Int32Array, '地图的 mesh.adj');
  if (start[0] !== 0 || start[n] !== adj.length) broken('地图的 mesh.adjStart 不对');
  ascending(start, '地图的 mesh.adjStart');
  allIn(adj, 0, n, '地图的 mesh.adj');
  const tri = typed(m.triangles, Uint32Array, '地图的 mesh.triangles');
  if (tri.length % 3) broken('地图的 mesh.triangles 不是三个一组');
  allIn(tri, 0, n, '地图的 mesh.triangles');
  return n;
}

/** 地图除网格以外的部分(各段世界共用这一套;at = 哪一段) */
function checkWorldBody(w: Obj, n: number, at: string): void {
  if (w.width !== MAP_W || w.height !== MAP_H) broken(`${at}的尺寸不对`);
  const params = obj(w.params, `${at}的 params`);
  for (const k of Object.keys(params)) {
    const v = num(params[k], `${at}的 params.${k}`);
    // 存档、网址里超范围的都调回范围内了,所以真实世界不会超;再大重新生成(看世界长出来)会慢到卡死
    const range = Object.prototype.hasOwnProperty.call(PARAM_RANGE, k) ? PARAM_RANGE[k as keyof typeof PARAM_RANGE] : null;
    if (range && (v < range[0] || v > range[1])) broken(`${at}的 params.${k} 超出范围`);
  }
  const climate = obj(w.climate, `${at}的 climate`);
  for (const k of Object.keys(climate)) num(climate[k], `${at}的 climate.${k}`);
  // 海拔、气候里的非数会一路传进铺像素、算人口;数太离谱时等值线按范围一条条排(从最小到最大、一步一步走),走不到头
  for (const k of ['elevation', 'waterLevel', 'temperature', 'precipitation', 'seaIce', 'flux']) {
    const a = typed(w[k], Float32Array, `${at}的 ${k}`, n);
    const [lo, hi] = FIELD_RANGE[k];
    allIn(a, lo, hi, `${at}的 ${k}`);
  }
  allIn(typed(w.water, Uint8Array, `${at}的 water`, n), 0, 3, `${at}的 water`);
  allIn(typed(w.biome, Uint8Array, `${at}的 biome`, n), 0, BIOMES.length, `${at}的 biome`);
  num(w.riverThreshold, `${at}的 riverThreshold`);
  if (Math.abs(num(w.maxElevation, `${at}的 maxElevation`)) > FIELD_RANGE.elevation[1]) broken(`${at}的 maxElevation 超出范围`);

  const tect = obj(w.tect, `${at}的 tect`);
  const plates = int(tect.plateCount, 0, 1 << 15, `${at}的 tect.plateCount`);
  allIn(typed(tect.plate, Int16Array, `${at}的 tect.plate`, n), -1, plates, `${at}的 tect.plate`);
  for (const k of ['plateVx', 'plateVy']) allFinite(typed(tect[k], Float32Array, `${at}的 tect.${k}`, plates), `${at}的 tect.${k}`);
  allFinite(typed(tect.plateOmega, Float32Array, `${at}的 tect.plateOmega`, plates * 3), `${at}的 tect.plateOmega`);
  typed(tect.plateContinental, Uint8Array, `${at}的 tect.plateContinental`, plates);
  for (const k of ['convergence', 'distConv', 'strengthConv', 'distDiv', 'strengthDiv', 'oceanDepth', 'uplift', 'plateau']) typed(tect[k], Float32Array, `${at}的 tect.${k}`, n);
  typed(tect.land, Uint8Array, `${at}的 tect.land`, n);

  const cur = obj(w.currents, `${at}的 currents`);
  for (const k of ['sst', 'u', 'v']) typed(cur[k], Float32Array, `${at}的 currents.${k}`, n);

  list(w.rivers, `${at}的 rivers`).forEach((r, i) => {
    const o = obj(r, `${at}的 rivers[${i}]`);
    const cells = typed(o.cells, Int32Array, `${at}的 rivers[${i}].cells`);
    allIn(cells, 0, n, `${at}的 rivers[${i}].cells`);
    const pts = typed(o.pts, Float32Array, `${at}的 rivers[${i}].pts`, cells.length * 3);
    allFinite(pts, `${at}的 rivers[${i}].pts`);
    pathPointsOk(pts, 3, `${at}的 rivers[${i}].pts`);
    if (o.drawn !== undefined) typed(o.drawn, Uint8Array, `${at}的 rivers[${i}].drawn`, cells.length);
  });
  list(w.volcanoes, `${at}的 volcanoes`).forEach((c, i) => int(c, 0, n, `${at}的 volcanoes[${i}]`));

  // 形成过程的回放不存
  if (list(w.history, `${at}的 history`).length) broken(`${at}带了形成过程的回放`);

  if (w.terrain !== undefined) {
    const ops = list(w.terrain, `${at}的 terrain`);
    if (ops.length > TERRAIN_MAX_OPS) broken(`${at}的地形修改太多`);
    ops.forEach((x, i) => {
      // 世界里存的是清理过的,再清理一遍还是它;清理会改的(坐标出了地图之类)就是别人写的
      const clean = cleanTerrainOp(x);
      if (!clean || JSON.stringify(clean) !== JSON.stringify(x)) broken(`${at}的 terrain[${i}] 认不出`);
    });
  }
  if (w.sketch !== undefined) {
    const s = obj(w.sketch, `${at}的 sketch`);
    typed(s.grid, Uint8Array, `${at}的 sketch.grid`, SKETCH_W * SKETCH_H);
    num(s.coast, `${at}的 sketch.coast`);
  }
  if (w.mapPlugins !== undefined) {
    const keys = list(w.mapPlugins, `${at}的 mapPlugins`);
    if (!keys.length || keys.length > MAP_PLUGINS_MAX) broken(`${at}的 mapPlugins 不对`);
    keys.forEach((k, i) => {
      if (!MAP_PLUGIN_KEY.test(str(k, `${at}的 mapPlugins[${i}]`, MAP_PLUGIN_KEY_MAX))) broken(`${at}的 mapPlugins[${i}] 认不出`);
    });
  }
  // 地图插件出的图层另存成图层块,不放在地图里
  if (w.mapLayers !== undefined) broken(`${at}带了地图插件的图层`);
}

/** 一张地图最多用几个地图插件 */
const MAP_PLUGINS_MAX = 16;
/** World.mapPlugins 的一项:「插件编号@文件指纹」,有滑条的后面接 [名字, 值] 串(worldFormat.ts 的 mapPluginKey) */
const MAP_PLUGIN_KEY = /^[a-z][a-z0-9]*(-[a-z0-9]+)*@[0-9a-f]{64}(\[.*\])?$/;
const MAP_PLUGIN_KEY_MAX = 1024;

/** 地图(map 那一块):不合格抛 broken */
export function validateWorld(v: unknown): asserts v is World {
  const w = obj(v, '地图');
  const n = checkMesh(w.mesh);
  checkWorldBody(w, n, '地图');
  allStrings(w, NAME_TEXT_MAX, TEXT_TOTAL_MAX, '地图');
}

/** 地形大事以后的各段世界(eras 那一块,没有网格:和 map 同一套)最多几段:一件大事一段 */
const ERAS_MAX = 64;

/** eras 那一块:{ baseKey, eras: [{ key, world }] } */
export function validateEras(v: unknown, map: World): void {
  const e = obj(v, '各段世界');
  // 键是参数、地形修改、草图拼成的,画了草图、导入过图片的有几 MB;只看是字符串(总量归这一块的上限管)
  str(e.baseKey, '各段世界的 baseKey', TEXT_TOTAL_MAX);
  const eras = list(e.eras, '各段世界的 eras');
  if (eras.length > ERAS_MAX) broken('各段世界太多');
  eras.forEach((raw, i) => {
    const era = obj(raw, `各段世界 [${i}]`);
    str(era.key, `各段世界 [${i}].key`, TEXT_TOTAL_MAX);
    const w = obj(era.world, `各段世界 [${i}].world`);
    if (w.mesh !== undefined) broken(`各段世界 [${i}] 不该带网格`);
    checkWorldBody(w, map.mesh.n, `各段世界 [${i}] `);
  });
  allStrings(e, TEXT_TOTAL_MAX, TEXT_TOTAL_MAX, '各段世界');
}

/** 照着沿用的地名最多几个(实测几十个;只防离谱的) */
const PLANET_NAMES_MAX = 100_000;
const PLANET_NAME_KEYS = ['kind', 'x', 'y', 'size', 'rank', 'name', 'latin', 'style', 'hearth'];

/** planet 那一块(worldFormat.ts 的 PlanetValue):只有数和地名,多一个字段都不认 */
export function validatePlanet(v: unknown, map: World): asserts v is PlanetValue {
  const p = obj(v, '星球参照');
  onlyKeys(p, ['tempo', 'names'], '星球参照');
  if (p.tempo !== undefined && p.tempo !== null) {
    const t = obj(p.tempo, '星球参照的 tempo');
    onlyKeys(t, ['spread', 'capNorm'], '星球参照的 tempo');
    if (!(num(t.spread, '星球参照的 tempo.spread') > 0) || !(num(t.capNorm, '星球参照的 tempo.capNorm') > 0)) broken('星球参照的 tempo 不对');
  }
  if (p.names !== undefined) {
    const at = '星球参照的 names';
    const s = obj(p.names, at);
    onlyKeys(s, ['key', 'ref'], at);
    if (!/^[0-9a-f]{16}$/.test(str(s.key, `${at}.key`, 16))) broken(`${at}.key 认不出`);
    const ref = list(s.ref, `${at}.ref`);
    if (ref.length > PLANET_NAMES_MAX) broken(`${at} 太多`);
    ref.forEach((raw, i) => {
      const r = obj(raw, `${at}.ref[${i}]`);
      onlyKeys(r, PLANET_NAME_KEYS, `${at}.ref[${i}]`);
      oneOf(r.kind, PLACE_KINDS, `${at}.ref[${i}].kind`);
      for (const k of ['x', 'y', 'size', 'rank']) num(r[k], `${at}.ref[${i}].${k}`);
      str(r.name, `${at}.ref[${i}].name`, NAME_TEXT_MAX);
      optStr(r.latin, `${at}.ref[${i}].latin`, NAME_TEXT_MAX);
      str(r.style, `${at}.ref[${i}].style`, NAME_TEXT_MAX);
      int(r.hearth, -1, map.mesh.n, `${at}.ref[${i}].hearth`);
    });
  }
}

// ---------------------------------------------------------------------------
// 历史

/** 名字一类的字最长多少(实测最长的几十个字;这里只防离谱的) */
const NAME_TEXT_MAX = 4096;
/** 编年史一条最长多少字、配方键这类长字最长多少(实测见 tests;这里只防离谱的) */
const TEXT_ONE_MAX = 256 * 1024;
/** 一块里最多多少字(块的上限是字节,一个字至少一个字节;这个数只防撑爆后面的显示和搜索) */
const TEXT_TOTAL_MAX = 64e6;

/**
 * 各种「种类」字段认得的值。界面拿它们查表(这种结局写什么字、这种关系画什么),认不出的查出 undefined 就抛错。
 * 写成表而不是列表:类型里加了新值、这里没跟上,编译就报错,不会等到用的人的世界打不开才发现
 */
const kinds = <T extends string>(table: Record<T, 1>): readonly string[] => Object.keys(table);
const POLITY_KINDS = kinds<CultureKind>({ farm: 1, nomad: 1, sea: 1, highland: 1, river: 1, lake: 1, forest: 1 });
const PLACE_KINDS = kinds<Place['kind']>({ sea: 1, mountains: 1, river: 1, lake: 1, island: 1, desert: 1, pass: 1 });
const ROUTE_KINDS = kinds<Route['kind']>({ road: 1, trail: 1, sea: 1 });
const PERSON_ROLES = kinds<Person['role']>({ ruler: 1, general: 1, prince: 1, minister: 1, consort: 1 });
const PERSON_FATES = kinds<PersonFate>({ died: 1, murdered: 1, deposed: 1, overthrown: 1, fell: 1, surrendered: 1, fled: 1, merged: 1, retired: 1, battle: 1, yielded: 1, purged: 1 });
const RULER_RISES = kinds<RulerRise>({ found: 1, rebel: 1, restore: 1, usurp: 1, rise: 1, heir: 1, crown: 1, reform: 1 });
const CLAIM_HOWS = kinds<NonNullable<Person['claim']>['how']>({ merit: 1, coup: 1, revolt: 1, intrigue: 1, usurp: 1, secede: 1, march: 1, seize: 1 });
const REGENCY_KINDS = kinds<PersonRegency['kind']>({ march: 1, heir: 1, uncle: 1, minister: 1, dowager: 1, chancellor: 1, general: 1 });
const REGENCY_ENDS = kinds<NonNullable<PersonRegency['end']>>({ succeed: 1, return: 1, purged: 1, usurp: 1, died: 1, ruler: 1, fallen: 1 });
const EXILE_HOWS = kinds<PersonExile['how']>({ heir: 1, deposed: 1, fled: 1 });
const EXILE_TIES_KNOWN = kinds<ExileTie>({ kin: 1, ally: 1, pact: 1, folk: 1, foe: 1, near: 1 });
const DEED_KINDS = kinds<PersonDeed['kind']>({ found: 1, regent: 1, rank: 1, enthrone: 1, capital: 1, relief: 1, peace: 1, war: 1, defend: 1, power: 1 });
const FAITH_KINDS = kinds<FaithKind>({ folk: 1, great: 1, sect: 1 });
const FAITH_EVENT_KINDS = kinds<FaithEventKind>({ found: 1, enter: 1, state: 1, schism: 1, holy: 1 });
const DEV_EVENT_KINDS = kinds<DevEvent['kind']>({ first: 1, enter: 1, discover: 1, deplete: 1, invent: 1, regress: 1 });
const TRADE_EVENT_KINDS = kinds<TradeEvent['kind']>({ open: 1, break: 1, reopen: 1, end: 1 });
/** 史事的种类:annals.ts 的表就是全的(编译时核对过) */
const ANNAL_KIND_NAMES = new Set(Object.keys(ANNAL_KINDS));
/** 编年史条目的种类:史事的种类,再加这几种 */
const ENTRY_KIND_NAMES = new Set([...ANNAL_KIND_NAMES, ...kinds<Exclude<EntryKind, AnnalKind>>({ reign: 1, faith: 1, era: 1, thought: 1, revolution: 1, coup: 1, plugin: 1 })]);
/** 河、地名路径上的点:都在地图上,最多跨出去一圈(经线那边接回来的)。太离谱的点按长度细分时分不完 */
function pathPointsOk(a: ArrayLike<number>, step: number, at: string): void {
  for (let i = 0; i + 1 < a.length; i += step) {
    if (!(a[i] >= -MAP_W && a[i] <= 2 * MAP_W && a[i + 1] >= -MAP_H && a[i + 1] <= 2 * MAP_H)) broken(`${at}[${i}] 出了地图`);
  }
}
/** 史事里 a 列记的是民族的几种(别的都是国家;upheaval 是第几件大事),见 annals.ts */
const ANNAL_A_CULTURE = new Set(['migrate', 'assimilate', 'vanish', 'diverge', 'trek']);
/** 这两种史事的州、城两列按子类各记各的(annals.ts),只看是整数 */
const ANNAL_OWN_COLUMNS = new Set(['intervene', 'trek']);

/** 历史里各种编号的个数 */
interface Counts {
  cells: number;
  regions: number;
  cultures: number;
  settlements: number;
  polities: number;
  people: number;
  annals: number;
  endYear: number;
}

/** 州的划分(各段共用):长度、编号 */
function checkRegions(raw: unknown, n: number, at: string): Regions {
  const r = obj(raw, at);
  const count = int(r.count, 0, n + 1, `${at}.count`);
  allIn(typed(r.of, Int32Array, `${at}.of`, n), -1, count, `${at}.of`);
  allIn(typed(r.seat, Int32Array, `${at}.seat`, count), -1, n, `${at}.seat`);
  const cellStart = typed(r.cellStart, Int32Array, `${at}.cellStart`, count + 1);
  const cells = typed(r.cells, Int32Array, `${at}.cells`);
  if (cellStart[0] !== 0 || cellStart[count] !== cells.length) broken(`${at}.cellStart 不对`);
  ascending(cellStart, `${at}.cellStart`);
  allIn(cells, 0, n, `${at}.cells`);
  const adjStart = typed(r.adjStart, Int32Array, `${at}.adjStart`, count + 1);
  const adj = typed(r.adj, Int32Array, `${at}.adj`);
  if (adjStart[0] !== 0 || adjStart[count] !== adj.length) broken(`${at}.adjStart 不对`);
  ascending(adjStart, `${at}.adjStart`);
  allIn(adj, 0, count, `${at}.adj`);
  allIn(typed(r.adjKind, Uint8Array, `${at}.adjKind`, adj.length), 0, 5, `${at}.adjKind`);
  typed(r.adjLen, Float32Array, `${at}.adjLen`, adj.length);
  typed(r.adjBorder, Float32Array, `${at}.adjBorder`, adj.length);
  allIn(typed(r.adjCoast, Int32Array, `${at}.adjCoast`, adj.length), -1, n, `${at}.adjCoast`);
  typed(r.area, Float32Array, `${at}.area`, count);
  typed(r.capacity, Float32Array, `${at}.capacity`, count);
  allIn(typed(r.biome, Uint8Array, `${at}.biome`, count), 0, BIOMES.length, `${at}.biome`);
  typed(r.elevation, Float32Array, `${at}.elevation`, count);
  typed(r.landmass, Int32Array, `${at}.landmass`, count);
  if (r.name !== undefined) {
    const names = list(r.name, `${at}.name`);
    if (names.length !== count) broken(`${at}.name 的长度不对`);
    names.forEach((x, i) => str(x, `${at}.name[${i}]`, NAME_TEXT_MAX));
  }
  if (r.keyOf !== undefined) typed(r.keyOf, Int32Array, `${at}.keyOf`, n);
  if (r.keySeat !== undefined) typed(r.keySeat, Int32Array, `${at}.keySeat`, count);
  return r as unknown as Regions;
}

function checkHabitat(raw: unknown, n: number, at: string): void {
  const h = obj(raw, at);
  typed(h.suitability, Float32Array, `${at}.suitability`, n);
  typed(h.capacity, Float32Array, `${at}.capacity`, n);
  typed(h.coastDist, Int8Array, `${at}.coastDist`, n);
  typed(h.harbor, Uint8Array, `${at}.harbor`, n);
}

function checkRoutes(raw: unknown, n: number, at: string): void {
  list(raw, at).forEach((x, i) => {
    const r = obj(x, `${at}[${i}]`);
    oneOf(r.kind, ROUTE_KINDS, `${at}[${i}].kind`);
    allIn(typed(r.cells, Int32Array, `${at}[${i}].cells`), 0, n, `${at}[${i}].cells`);
    startYear(r.built, `${at}[${i}].built`);
    optYearOk(r.abandoned, `${at}[${i}].abandoned`);
  });
}

function checkPlaces(raw: unknown, c: Counts, at: string): void {
  list(raw, at).forEach((x, i) => {
    const p = obj(x, `${at}[${i}]`);
    oneOf(p.kind, PLACE_KINDS, `${at}[${i}].kind`);
    str(p.name, `${at}[${i}].name`, NAME_TEXT_MAX);
    int(p.culture, -1, c.cultures, `${at}[${i}].culture`);
    const path = typed(p.path, Float32Array, `${at}[${i}].path`);
    allFinite(path, `${at}[${i}].path`);
    pathPointsOk(path, 2, `${at}[${i}].path`);
    num(p.rank, `${at}[${i}].rank`);
    optNum(p.size, `${at}[${i}].size`);
    optInt(p.cell, 0, c.cells, `${at}[${i}].cell`);
    optInt(p.keyCell, 0, c.cells, `${at}[${i}].keyCell`);
    optStr(p.latin, `${at}[${i}].latin`, NAME_TEXT_MAX);
    optStr(p.defaultName, `${at}[${i}].defaultName`, NAME_TEXT_MAX);
    if (p.pass !== undefined) {
      const pass = obj(p.pass, `${at}[${i}].pass`);
      list(pass.regions, `${at}[${i}].pass.regions`).forEach((r, k) => int(r, 0, c.regions, `${at}[${i}].pass.regions[${k}]`));
      // stands 只当查表的键用。地形大事以前那几段里记的是推演中途的下标,对不上最后的史事,也可能比史事的条数大,所以不卡范围
      if (pass.stands !== undefined) list(pass.stands, `${at}[${i}].pass.stands`).forEach((a, k) => int(a, 0, Number.MAX_SAFE_INTEGER, `${at}[${i}].pass.stands[${k}]`));
    }
  });
}

/** 已经发生的事的年份:在 0 到推演年数之间(史事、日志、检查点、地形大事、编年史) */
function yearIn(v: unknown, c: Counts, at: string): void {
  const y = num(v, at);
  if (y < 0 || y > c.endYear) broken(`${at} 的年份不对(要在 0 到 ${c.endYear} 之间)`);
}

/**
 * 开头的年份(民族诞生、建城、立国、修路):不早于第 0 年。不卡结束那年:有的事推演时就排好了,可能比结束那年晚
 * (还没诞生的民族、到期要废的路),这样的世界是好的
 */
function startYear(v: unknown, at: string): void {
  if (yearOk(v, at) < 0) broken(`${at} 的年份是负数`);
}

function checkCultures(raw: unknown, c: Counts): void {
  const list0 = list(raw, '历史的 cultures');
  list0.forEach((x, i) => {
    const at = `历史的 cultures[${i}]`;
    const u = obj(x, at);
    if (u.id !== i) broken(`${at}.id 不对`);
    str(u.name, `${at}.name`, NAME_TEXT_MAX);
    str(u.style, `${at}.style`, NAME_TEXT_MAX);
    optStr(u.autoStyle, `${at}.autoStyle`, NAME_TEXT_MAX);
    optStr(u.branch, `${at}.branch`, NAME_TEXT_MAX);
    oneOf(u.kind, POLITY_KINDS, `${at}.kind`);
    int(u.hearth, 0, c.regions, `${at}.hearth`);
    startYear(u.born, `${at}.born`);
    optYearOk(u.ended, `${at}.ended`);
    rgb(u.color, `${at}.color`);
    optInt(u.parent, 0, c.cultures, `${at}.parent`);
  });
  noCycle(c.cultures, (i) => (list0[i] as { parent?: number }).parent, '民族的 parent');
}

function checkSettlements(raw: unknown, c: Counts): void {
  const list0 = list(raw, '历史的 settlements');
  list0.forEach((x, i) => {
    const at = `历史的 settlements[${i}]`;
    const s = obj(x, at);
    if (s.id !== i) broken(`${at}.id 不对`);
    int(s.cell, 0, c.cells, `${at}.cell`);
    int(s.region, 0, c.regions, `${at}.region`);
    int(s.culture, 0, c.cultures, `${at}.culture`);
    str(s.name, `${at}.name`, NAME_TEXT_MAX);
    startYear(s.founded, `${at}.founded`);
    optYearOk(s.ended, `${at}.ended`);
    // 人口按这几个数算:非数会一路传到界面上
    num(s.capacity, `${at}.capacity`);
    num(s.growth, `${at}.growth`);
    optInt(s.rebuilds, 0, c.settlements, `${at}.rebuilds`);
    if (s.capitalSpans !== undefined) {
      list(s.capitalSpans, `${at}.capitalSpans`).forEach((y, k) => {
        const o = obj(y, `${at}.capitalSpans[${k}]`);
        int(o.polity, 0, c.polities, `${at}.capitalSpans[${k}].polity`);
        yearOk(o.from, `${at}.capitalSpans[${k}].from`);
        optYearOk(o.until, `${at}.capitalSpans[${k}].until`);
      });
    }
    if (s.sacks !== undefined) {
      list(s.sacks, `${at}.sacks`).forEach((y, k) => {
        const o = obj(y, `${at}.sacks[${k}]`);
        yearOk(o.year, `${at}.sacks[${k}].year`);
        optYearOk(o.until, `${at}.sacks[${k}].until`);
        num(o.loss, `${at}.sacks[${k}].loss`);
      });
    }
    if (s.reshaped !== undefined) {
      list(s.reshaped, `${at}.reshaped`).forEach((y, k) => {
        const o = obj(y, `${at}.reshaped[${k}]`);
        yearOk(o.year, `${at}.reshaped[${k}].year`);
        num(o.capacity, `${at}.reshaped[${k}].capacity`);
      });
    }
    if (s.devCap !== undefined) list(s.devCap, `${at}.devCap`).forEach((d, k) => num(d, `${at}.devCap[${k}]`));
  });
  noCycle(c.settlements, (i) => (list0[i] as { rebuilds?: number }).rebuilds, '城的 rebuilds');
}

function checkPolities(raw: unknown, c: Counts): void {
  const list0 = list(raw, '历史的 polities');
  list0.forEach((x, i) => {
    const at = `历史的 polities[${i}]`;
    const p = obj(x, at);
    if (p.id !== i) broken(`${at}.id 不对`);
    str(p.name, `${at}.name`, NAME_TEXT_MAX);
    int(p.culture, 0, c.cultures, `${at}.culture`);
    int(p.capital, 0, c.settlements, `${at}.capital`);
    startYear(p.founded, `${at}.founded`);
    optYearOk(p.ended, `${at}.ended`);
    oneOf(p.kind, POLITY_KINDS, `${at}.kind`);
    rgb(p.color, `${at}.color`);
    optInt(p.parent, 0, c.polities, `${at}.parent`);
    optInt(p.restores, 0, c.polities, `${at}.restores`);
    optInt(p.mentor, 0, c.polities, `${at}.mentor`);
    optStr(p.lineage, `${at}.lineage`, NAME_TEXT_MAX);
    if (p.titles !== undefined) {
      ascendingBy(p.titles, 'year', `${at}.titles`);
      (p.titles as Obj[]).forEach((y, k) => num(y.tier, `${at}.titles[${k}].tier`));
    }
    if (p.capitals !== undefined) {
      ascendingBy(p.capitals, 'year', `${at}.capitals`);
      (p.capitals as Obj[]).forEach((y, k) => int(y.settlement, 0, c.settlements, `${at}.capitals[${k}].settlement`));
    }
    if (p.dynasties !== undefined) {
      ascendingBy(p.dynasties, 'year', `${at}.dynasties`);
      (p.dynasties as Obj[]).forEach((y, k) => {
        str(y.name, `${at}.dynasties[${k}].name`, NAME_TEXT_MAX);
        int(y.seat, 0, c.settlements, `${at}.dynasties[${k}].seat`);
        optInt(y.house, 0, (p.dynasties as Obj[]).length, `${at}.dynasties[${k}].house`);
      });
    }
  });
  const ofField = (k: string) => (i: number) => (list0[i] as Record<string, number | undefined>)[k];
  noCycle(c.polities, ofField('parent'), '国家的 parent');
  noCycle(c.polities, ofField('restores'), '国家的 restores');
  noCycle(c.polities, ofField('mentor'), '国家的 mentor');
}

/** 对象列表,按某一列(年份)不减 */
function ascendingBy(raw: unknown, key: string, at: string): void {
  const a = list(raw, at);
  let last = -Infinity;
  a.forEach((x, i) => {
    const y = yearOk(obj(x, `${at}[${i}]`)[key], `${at}[${i}].${key}`);
    if (y < last) broken(`${at} 没按先后排`);
    last = y;
  });
}

function checkAnnals(raw: unknown, c: Counts, upheavals: number): void {
  let last = 0;
  list(raw, '历史的 annals').forEach((x, i) => {
    const at = `历史的 annals[${i}]`;
    const a = obj(x, at);
    const y = num(a.year, `${at}.year`);
    if (y < last || y > c.endYear) broken(`${at}.year 不对(要按先后排、在 0 到 ${c.endYear} 之间)`);
    last = y;
    const kind = str(a.kind, `${at}.kind`, 32);
    if (!ANNAL_KIND_NAMES.has(kind)) broken(`${at}.kind 认不出`);
    // a 列按种类是国家、民族或第几件大事;b 列的意思各不相同(州数、第几朝……),只看是整数
    const top = kind === 'upheaval' ? upheavals : ANNAL_A_CULTURE.has(kind) ? c.cultures : c.polities;
    int(a.a, -1, top, `${at}(${kind}).a`);
    if (!Number.isInteger(a.b)) broken(`${at}(${kind}).b 不是整数`);
    // 州、城两列有几种借去记别的(annals.ts):peace 的州列是割了几州,war 的城列是援的哪国,intervene、trek 按它们自己的子类
    if (ANNAL_OWN_COLUMNS.has(kind) || kind === 'peace') {
      if (!Number.isInteger(a.region)) broken(`${at}(${kind}).region 不是整数`);
    } else int(a.region, -1, c.regions, `${at}(${kind}).region`);
    if (ANNAL_OWN_COLUMNS.has(kind)) {
      if (!Number.isInteger(a.settlement)) broken(`${at}(${kind}).settlement 不是整数`);
    } else if (kind === 'war') int(a.settlement, -1, c.polities, `${at}(${kind}).settlement`);
    else int(a.settlement, -1, c.settlements, `${at}(${kind}).settlement`);
    if (!Number.isInteger(a.war)) broken(`${at}(${kind}).war 不是整数`);
    optInt(a.via, 0, 5, `${at}.via`);
    optStr(a.cause, `${at}.cause`, NAME_TEXT_MAX);
    if (a.ps !== undefined) list(a.ps, `${at}.ps`).forEach((p, k) => int(p, 0, c.polities, `${at}.ps[${k}]`));
  });
}

function checkUpheavals(raw: unknown, c: Counts): void {
  ascendingBy(raw, 'year', '历史的 upheavals');
  (raw as Obj[]).forEach((x, i) => {
    const at = `历史的 upheavals[${i}]`;
    yearIn(x.year, c, `${at}.year`);
    int(x.region, -1, c.regions, `${at}.region`);
    int(x.polity, -1, c.polities, `${at}.polity`);
    for (const k of ['drowned', 'shrunk', 'grown', 'added']) list(x[k], `${at}.${k}`).forEach((r, j) => int(r, 0, c.regions, `${at}.${k}[${j}]`));
    list(x.drownedBy, `${at}.drownedBy`).forEach((p, j) => int(p, -1, c.polities, `${at}.drownedBy[${j}]`));
    if (x.ruins !== undefined) list(x.ruins, `${at}.ruins`).forEach((s, j) => int(s, 0, c.settlements, `${at}.ruins[${j}]`));
  });
}

function checkLog(raw: unknown, c: Counts): void {
  const l = obj(raw, '历史的 log');
  const year = typed(l.year, Float32Array, '历史的 log.year');
  const size = int(l.size, 0, year.length + 1, '历史的 log.size');
  const region = typed(l.region, Int32Array, '历史的 log.region', year.length);
  const layer = typed(l.layer, Uint8Array, '历史的 log.layer', year.length);
  const value = typed(l.value, Int16Array, '历史的 log.value', year.length);
  typed(l.cause, Uint8Array, '历史的 log.cause', year.length);
  ascending(year, '历史的 log.year', size);
  allIn(region, 0, c.regions, '历史的 log.region', size);
  for (let i = 0; i < size; i++) {
    if (!(year[i] >= 0 && year[i] <= c.endYear)) broken(`历史的 log.year[${i}] 不对`);
    if (layer[i] > 1) broken(`历史的 log.layer[${i}] 认不出`);
    if (value[i] < -1 || value[i] >= (layer[i] === 0 ? c.cultures : c.polities)) broken(`历史的 log.value[${i}] 超出范围`);
  }
}

function checkCheckpoints(raw: unknown, c: Counts): void {
  ascendingBy(raw, 'year', '历史的 checkpoints');
  (raw as Obj[]).forEach((x, i) => {
    const at = `历史的 checkpoints[${i}]`;
    yearIn(x.year, c, `${at}.year`);
    allIn(typed(x.culture, Int16Array, `${at}.culture`, c.regions), -1, c.cultures, `${at}.culture`);
    allIn(typed(x.polity, Int16Array, `${at}.polity`, c.regions), -1, c.polities, `${at}.polity`);
  });
}

function checkMigrations(raw: unknown, c: Counts): void {
  list(raw, '历史的 migrations').forEach((x, i) => {
    const at = `历史的 migrations[${i}]`;
    const m = obj(x, at);
    int(m.culture, 0, c.cultures, `${at}.culture`);
    yearOk(m.year, `${at}.year`);
    const route = list(m.route, `${at}.route`);
    route.forEach((r, k) => int(r, 0, c.regions, `${at}.route[${k}]`));
    const years = list(m.years, `${at}.years`);
    if (years.length !== route.length) broken(`${at}.years 的长度不对`);
    years.forEach((y, k) => yearOk(y, `${at}.years[${k}]`));
    int(m.target, -1, c.polities, `${at}.target`);
    optInt(m.polity, 0, c.polities, `${at}.polity`);
    optInt(m.stormed, 0, c.polities, `${at}.stormed`);
    if (m.lands !== undefined) list(m.lands, `${at}.lands`).forEach((r, k) => int(r, 0, c.regions, `${at}.lands[${k}]`));
  });
}

function checkPeople(raw: unknown, c: Counts): void {
  const list0 = list(raw, '历史的 people');
  const ref = (v: unknown, at: string) => optInt(v, 0, c.people, at);
  list0.forEach((x, i) => {
    const at = `历史的 people[${i}]`;
    const p = obj(x, at);
    if (p.id !== i) broken(`${at}.id 不对`);
    oneOf(p.role, PERSON_ROLES, `${at}.role`);
    int(p.polity, 0, c.polities, `${at}.polity`);
    str(p.name, `${at}.name`, NAME_TEXT_MAX);
    for (const k of ['maleName', 'title', 'defaultName', 'courtesy', 'art']) optStr(p[k], `${at}.${k}`, NAME_TEXT_MAX);
    if (p.fate !== undefined) oneOf(p.fate, PERSON_FATES, `${at}.fate`);
    if (p.rise !== undefined) oneOf(p.rise, RULER_RISES, `${at}.rise`);
    if (p.posts !== undefined) {
      list(p.posts, `${at}.posts`).forEach((y, k) => {
        const o = obj(y, `${at}.posts[${k}]`);
        str(o.title, `${at}.posts[${k}].title`, NAME_TEXT_MAX);
        yearOk(o.from, `${at}.posts[${k}].from`);
      });
    }
    yearOk(p.born, `${at}.born`);
    optYearOk(p.died, `${at}.died`);
    optYearOk(p.from, `${at}.from`);
    optYearOk(p.until, `${at}.until`);
    ref(p.parent, `${at}.parent`);
    ref(p.mom, `${at}.mom`);
    ref(p.husband, `${at}.husband`);
    ref(p.rival, `${at}.rival`);
    optInt(p.home, 0, c.settlements, `${at}.home`);
    if (p.descent !== undefined) ref(obj(p.descent, `${at}.descent`).from, `${at}.descent.from`);
    if (p.claim !== undefined) {
      const claim = obj(p.claim, `${at}.claim`);
      oneOf(claim.how, CLAIM_HOWS, `${at}.claim.how`);
      list(claim.rivals, `${at}.claim.rivals`).forEach((r, k) => ref(r, `${at}.claim.rivals[${k}]`));
    }
    if (p.commands !== undefined) {
      list(p.commands, `${at}.commands`).forEach((y, k) => {
        const o = obj(y, `${at}.commands[${k}]`);
        yearOk(o.from, `${at}.commands[${k}].from`);
        yearOk(o.until, `${at}.commands[${k}].until`);
        int(o.first, 0, c.annals, `${at}.commands[${k}].first`);
        int(o.last, 0, c.annals, `${at}.commands[${k}].last`);
      });
    }
    if (p.regencies !== undefined) {
      list(p.regencies, `${at}.regencies`).forEach((y, k) => {
        const o = obj(y, `${at}.regencies[${k}]`);
        oneOf(o.kind, REGENCY_KINDS, `${at}.regencies[${k}].kind`);
        if (o.end !== undefined) oneOf(o.end, REGENCY_ENDS, `${at}.regencies[${k}].end`);
        yearOk(o.from, `${at}.regencies[${k}].from`);
        optYearOk(o.until, `${at}.regencies[${k}].until`);
        ref(o.ruler, `${at}.regencies[${k}].ruler`);
        int(o.annal, 0, c.annals, `${at}.regencies[${k}].annal`);
        optInt(o.endAnnal, 0, c.annals, `${at}.regencies[${k}].endAnnal`);
      });
    }
    if (p.spouses !== undefined) {
      list(p.spouses, `${at}.spouses`).forEach((y, k) => {
        const o = obj(y, `${at}.spouses[${k}]`);
        int(o.polity, 0, c.polities, `${at}.spouses[${k}].polity`);
        int(o.father, -1, c.people, `${at}.spouses[${k}].father`);
        str(o.name, `${at}.spouses[${k}].name`, NAME_TEXT_MAX);
        yearOk(o.year, `${at}.spouses[${k}].year`);
        int(o.annal, 0, c.annals, `${at}.spouses[${k}].annal`);
        ref(o.person, `${at}.spouses[${k}].person`);
      });
    }
    if (p.exile !== undefined) {
      const e = obj(p.exile, `${at}.exile`);
      oneOf(e.how, EXILE_HOWS, `${at}.exile.how`);
      if (e.tie !== undefined) oneOf(e.tie, EXILE_TIES_KNOWN, `${at}.exile.tie`);
      int(e.annal, 0, c.annals, `${at}.exile.annal`);
      yearOk(e.year, `${at}.exile.year`);
      optYearOk(e.until, `${at}.exile.until`);
      int(e.region, -1, c.regions, `${at}.exile.region`);
      ref(e.by, `${at}.exile.by`);
      optInt(e.to, 0, c.polities, `${at}.exile.to`);
    }
    if (p.deeds !== undefined) {
      list(p.deeds, `${at}.deeds`).forEach((y, k) => {
        const o = obj(y, `${at}.deeds[${k}]`);
        oneOf(o.kind, DEED_KINDS, `${at}.deeds[${k}].kind`);
        yearOk(o.year, `${at}.deeds[${k}].year`);
        optYearOk(o.until, `${at}.deeds[${k}].until`);
        optInt(o.annal, 0, c.annals, `${at}.deeds[${k}].annal`);
        ref(o.person, `${at}.deeds[${k}].person`);
      });
    }
  });
  noCycle(c.people, (i) => (list0[i] as { parent?: number }).parent, '人物的 parent');
}

function checkReligion(raw: unknown, c: Counts): void {
  const r = obj(raw, '历史的 religion');
  const faiths = list(r.faiths, '历史的 religion.faiths');
  const F = faiths.length;
  faiths.forEach((x, i) => {
    const at = `历史的 religion.faiths[${i}]`;
    const f = obj(x, at);
    if (f.id !== i) broken(`${at}.id 不对`);
    oneOf(f.kind, FAITH_KINDS, `${at}.kind`);
    str(f.name, `${at}.name`, NAME_TEXT_MAX);
    optStr(f.form, `${at}.form`, NAME_TEXT_MAX);
    optYearOk(f.founded, `${at}.founded`);
    if (f.founder !== undefined) {
      const o = obj(f.founder, `${at}.founder`);
      str(o.name, `${at}.founder.name`, NAME_TEXT_MAX);
      yearOk(o.born, `${at}.founder.born`);
      yearOk(o.died, `${at}.founder.died`);
    }
    optInt(f.culture, 0, c.cultures, `${at}.culture`);
    optInt(f.parent, 0, F, `${at}.parent`);
    optInt(f.holy, 0, c.settlements, `${at}.holy`);
    optInt(f.polity, 0, c.polities, `${at}.polity`);
    optInt(f.seat, 0, c.settlements, `${at}.seat`);
    rgb(f.color, `${at}.color`);
  });
  noCycle(F, (i) => (faiths[i] as { parent?: number }).parent, '信仰的 parent');
  ascendingBy(r.events, 'year', '历史的 religion.events');
  (r.events as Obj[]).forEach((e, i) => {
    const at = `历史的 religion.events[${i}]`;
    oneOf(e.kind, FAITH_EVENT_KINDS, `${at}.kind`);
    int(e.faith, 0, F, `${at}.faith`);
    int(e.polity, -1, c.polities, `${at}.polity`);
    int(e.region, -1, c.regions, `${at}.region`);
    int(e.settlement, -1, c.settlements, `${at}.settlement`);
    optInt(e.ruler, -1, c.people, `${at}.ruler`);
    optInt(e.from, -1, c.polities, `${at}.from`);
  });
  list(r.states, '历史的 religion.states').forEach((x, i) => {
    const at = `历史的 religion.states[${i}]`;
    const s = obj(x, at);
    int(s.polity, 0, c.polities, `${at}.polity`);
    int(s.faith, 0, F, `${at}.faith`);
    yearOk(s.from, `${at}.from`);
    optYearOk(s.until, `${at}.until`);
  });
  const log = obj(r.log, '历史的 religion.log');
  const year = typed(log.year, Float32Array, '历史的 religion.log.year');
  const size = int(log.size, 0, year.length + 1, '历史的 religion.log.size');
  ascending(year, '历史的 religion.log.year', size);
  allIn(typed(log.region, Int32Array, '历史的 religion.log.region', year.length), 0, c.regions, '历史的 religion.log.region', size);
  allIn(typed(log.value, Int16Array, '历史的 religion.log.value', year.length), -1, F, '历史的 religion.log.value', size);
  ascendingBy(r.checkpoints, 'year', '历史的 religion.checkpoints');
  (r.checkpoints as Obj[]).forEach((x, i) => allIn(typed(x.faith, Int16Array, `历史的 religion.checkpoints[${i}].faith`, c.regions), -1, F, `历史的 religion.checkpoints[${i}].faith`));
}

/** 几份快照(一份一个年份,数组长度固定) */
function checkSnaps<T extends ArrayLike<number>>(snaps: unknown, years: unknown, C: TypedCtor<T>, len: number, at: string): void {
  const s = list(snaps, at);
  const y = list(years, `${at} 的年份`);
  if (s.length !== y.length) broken(`${at} 和年份对不上`);
  y.forEach((v, i) => yearOk(v, `${at} 的年份[${i}]`));
  ascending(y as number[], `${at} 的年份`);
  s.forEach((v, i) => typed(v, C, `${at}[${i}]`, len));
}

function checkDevelopment(raw: unknown, c: Counts): void {
  const d = obj(raw, '历史的 development');
  const R = c.regions;
  typed(d.resources, Uint8Array, '历史的 development.resources', R * RESOURCE_COUNT);
  typed(d.found, Float64Array, '历史的 development.found', R * RESOURCE_COUNT);
  checkSnaps(d.avail, d.snapYears, Uint8Array, R * RESOURCE_COUNT, '历史的 development.avail');
  checkSnaps(d.snaps, d.snapYears, Uint8Array, R * CAP_COUNT, '历史的 development.snaps');
  if (d.control !== undefined) checkSnaps(d.control, d.controlYears, Uint8Array, R, '历史的 development.control');
  if (d.rural !== undefined) checkSnaps(d.rural, d.ruralYears, Float32Array, R, '历史的 development.rural');
  if (d.fiscal !== undefined) {
    const f = obj(d.fiscal, '历史的 development.fiscal');
    const year = typed(f.year, Int32Array, '历史的 development.fiscal.year');
    const size = int(f.size, 0, year.length + 1, '历史的 development.fiscal.size');
    allIn(typed(f.polity, Int32Array, '历史的 development.fiscal.polity', year.length), 0, c.polities, '历史的 development.fiscal.polity', size);
    if (typed(f.data, Float32Array, '历史的 development.fiscal.data').length < size * BOOK_COLS.length) broken('历史的 development.fiscal.data 不够长');
  }
  ascendingBy(d.events, 'year', '历史的 development.events');
  (d.events as Obj[]).forEach((e, i) => {
    const at = `历史的 development.events[${i}]`;
    oneOf(e.kind, DEV_EVENT_KINDS, `${at}.kind`);
    int(e.region, -1, R, `${at}.region`);
    int(e.culture, -1, c.cultures, `${at}.culture`);
    int(e.polity, -1, c.polities, `${at}.polity`);
    int(e.settlement, -1, c.settlements, `${at}.settlement`);
  });
  if (d.state !== undefined) {
    const s = obj(d.state, '历史的 development.state');
    yearOk(s.last, '历史的 development.state.last');
    for (const k of ['cur', 'best']) typed(s[k], Float64Array, `历史的 development.state.${k}`, R * CAP_COUNT);
    for (const k of ['war', 'era', 'pop', 'city']) typed(s[k], Float64Array, `历史的 development.state.${k}`, R);
    for (const k of ['flags', 'road']) typed(s[k], Uint8Array, `历史的 development.state.${k}`, R);
    for (const k of ['stock', 'availNow']) typed(s[k], Float64Array, `历史的 development.state.${k}`, R * RESOURCE_COUNT);
    typed(s.depleted, Uint8Array, '历史的 development.state.depleted', R * RESOURCE_COUNT);
    if (s.resFrom !== undefined) typed(s.resFrom, Float64Array, '历史的 development.state.resFrom', R * RESOURCE_COUNT);
    list(s.polityEra, '历史的 development.state.polityEra');
    list(s.military, '历史的 development.state.military');
  }
}

function checkIdeology(raw: unknown, c: Counts): void {
  const d = obj(raw, '历史的 ideology');
  checkSnaps(d.snaps, d.snapYears, Uint8Array, c.regions * THOUGHT_COUNT, '历史的 ideology.snaps');
  const series = list(d.polities, '历史的 ideology.polities');
  if (series.length !== c.polities) broken('历史的 ideology.polities 的长度不对');
  series.forEach((s, i) => {
    if (s === null) return;
    const o = obj(s, `历史的 ideology.polities[${i}]`);
    yearOk(o.from, `历史的 ideology.polities[${i}].from`);
    const v = typed(o.v, Uint8Array, `历史的 ideology.polities[${i}].v`);
    if (v.length % THOUGHT_COUNT) broken(`历史的 ideology.polities[${i}].v 的长度不对`);
  });
  typed(d.arrive, Float64Array, '历史的 ideology.arrive', c.polities * THOUGHT_COUNT);
  ascendingBy(d.events, 'year', '历史的 ideology.events');
  (d.events as Obj[]).forEach((e, i) => {
    const at = `历史的 ideology.events[${i}]`;
    int(e.thought, 0, THOUGHT_COUNT, `${at}.thought`);
    int(e.region, -1, c.regions, `${at}.region`);
    int(e.settlement, -1, c.settlements, `${at}.settlement`);
    int(e.culture, -1, c.cultures, `${at}.culture`);
    int(e.polity, -1, c.polities, `${at}.polity`);
  });
}

function checkTrade(raw: unknown, c: Counts): void {
  const t = obj(raw, '历史的 trade');
  list(t.routes, '历史的 trade.routes').forEach((x, i) => {
    const at = `历史的 trade.routes[${i}]`;
    const r = obj(x, at);
    if (r.id !== i) broken(`${at}.id 不对`);
    str(r.name, `${at}.name`, NAME_TEXT_MAX);
    int(r.buyer, 0, c.polities, `${at}.buyer`);
    int(r.from, 0, c.regions, `${at}.from`);
    // 界面直接取第一件事、第一条路线、第一样货:商道生下来就有,空的就白屏了
    const goods = list(r.goods, `${at}.goods`);
    if (!goods.length) broken(`${at}.goods 是空的`);
    goods.forEach((g, k) => {
      const o = obj(g, `${at}.goods[${k}]`);
      int(o.res, 0, RESOURCE_COUNT, `${at}.goods[${k}].res`);
      yearOk(o.from, `${at}.goods[${k}].from`);
      optYearOk(o.until, `${at}.goods[${k}].until`);
    });
    ascendingBy(r.events, 'year', `${at}.events`);
    if (!(r.events as unknown[]).length) broken(`${at}.events 是空的`);
    (r.events as Obj[]).forEach((e, k) => {
      oneOf(e.kind, TRADE_EVENT_KINDS, `${at}.events[${k}].kind`);
      optStr(e.why, `${at}.events[${k}].why`, NAME_TEXT_MAX);
      optInt(e.foe, 0, c.polities, `${at}.events[${k}].foe`);
    });
    const paths = list(r.paths, `${at}.paths`);
    if (!paths.length) broken(`${at}.paths 是空的`);
    paths.forEach((p, k) => {
      const o = obj(p, `${at}.paths[${k}]`);
      yearOk(o.year, `${at}.paths[${k}].year`);
      list(o.regions, `${at}.paths[${k}].regions`).forEach((g, j) => int(g, 0, c.regions, `${at}.paths[${k}].regions[${j}]`));
    });
  });
  obj(t.state, '历史的 trade.state');
}

/** 历史(civ 那一块):world = 同一个文件里的地图。不合格抛 broken */
export function validateCiv(v: unknown, world: World): asserts v is Civ {
  const civ = obj(v, '历史');
  const n = world.mesh.n;
  num(civ.seed, '历史的 seed');
  const endYear = num(civ.endYear, '历史的 endYear');
  if (endYear < 0 || endYear > END_YEAR_MAX) broken('历史的 endYear 超出范围');
  if (typeof civ.viable !== 'boolean') broken('历史的 viable 不对');
  // 这个字段是界面临时挂上去的,存下来的世界里不该有
  if (civ.history !== undefined) broken('历史里不该有 history');

  checkHabitat(civ.habitat, n, '历史的 habitat');
  const regions = checkRegions(civ.regions, n, '历史的 regions');
  const c: Counts = {
    cells: n,
    regions: regions.count,
    cultures: list(civ.cultures, '历史的 cultures').length,
    settlements: list(civ.settlements, '历史的 settlements').length,
    polities: list(civ.polities, '历史的 polities').length,
    people: civ.people === undefined ? 0 : list(civ.people, '历史的 people').length,
    annals: list(civ.annals, '历史的 annals').length,
    endYear,
  };
  checkCultures(civ.cultures, c);
  checkSettlements(civ.settlements, c);
  checkPolities(civ.polities, c);
  checkRoutes(civ.routes, n, '历史的 routes');
  checkPlaces(civ.places, c, '历史的 places');
  allIn(typed(civ.culture, Int16Array, '历史的 culture', c.regions), -1, c.cultures, '历史的 culture');
  allIn(typed(civ.polity, Int16Array, '历史的 polity', c.regions), -1, c.polities, '历史的 polity');
  checkLog(civ.log, c);
  checkCheckpoints(civ.checkpoints, c);
  const upheavals = civ.upheavals === undefined ? 0 : list(civ.upheavals, '历史的 upheavals').length;
  if (civ.upheavals !== undefined) checkUpheavals(civ.upheavals, c);
  checkAnnals(civ.annals, c, upheavals);
  const eras = civ.eras === undefined ? [] : list(civ.eras, '历史的 eras');
  if (eras.length !== upheavals) broken('历史的 eras 和 upheavals 对不上');
  eras.forEach((x, i) => {
    const at = `历史的 eras[${i}]`;
    const e = obj(x, at);
    yearOk(e.until, `${at}.until`);
    checkHabitat(e.habitat, n, `${at}.habitat`);
    checkRegions(e.regions, n, `${at}.regions`);
    checkPlaces(e.places, c, `${at}.places`);
    checkRoutes(e.routes, n, `${at}.routes`);
  });
  if (civ.regionNames !== undefined) {
    const names = list(civ.regionNames, '历史的 regionNames');
    if (names.length > c.regions) broken('历史的 regionNames 太长');
    names.forEach((x, i) => str(x, `历史的 regionNames[${i}]`, NAME_TEXT_MAX));
  }
  for (const k of ['authorNames', 'treatyNames']) {
    if (civ[k] !== undefined) {
      const names = obj(civ[k], `历史的 ${k}`);
      for (const id of Object.keys(names)) str(names[id], `历史的 ${k}.${id}`, NAME_TEXT_MAX);
    }
  }
  if (civ.migrations !== undefined) checkMigrations(civ.migrations, c);
  if (civ.people !== undefined) checkPeople(civ.people, c);
  if (civ.religion !== undefined) checkReligion(civ.religion, c);
  if (civ.development !== undefined) checkDevelopment(civ.development, c);
  if (civ.ideology !== undefined) checkIdeology(civ.ideology, c);
  if (civ.trade !== undefined) checkTrade(civ.trade, c);
  if (civ.simPlugins !== undefined) validateSimStates(civ.simPlugins);
  if (civ.simChronicle !== undefined) checkSimChronicle(civ.simChronicle, c);
  if (civ.simLayers !== undefined) validateSimLayers(civ.simLayers, { cells: n, regions: c.regions, endYear });
  allStrings(civ, TEXT_ONE_MAX, TEXT_TOTAL_MAX, '历史');
}

// ---------------------------------------------------------------------------
// 推演插件的状态

/** 数表名(和登记卡的表名同一个规矩)、avg / total 的累计名(读者表<被读的表) */
const SIM_TABLE_NAME = /^[\p{L}_][\p{L}\p{N}_]{0,63}$/u;
const SIM_ACC_KEY = /^[\p{L}_][\p{L}\p{N}_]{0,63}<[\p{L}_][\p{L}\p{N}_]{0,63}$/u;

/** 只许这几个键 */
function onlyKeys(o: Obj, keys: readonly string[], at: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) broken(`${at} 里有认不出的 ${k}`);
}

/** 数表引擎记的时刻:年份,或者「还没算过」(NaN、−Infinity) */
function engineYear(v: unknown, at: string): void {
  if (typeof v !== 'number' || v === Infinity || Math.abs(v) > YEAR_ABS_MAX) {
    if (!(Number.isNaN(v) || v === -Infinity)) broken(`${at} 不是年份`);
  }
}

function bool(v: unknown, at: string): void {
  if (typeof v !== 'boolean') broken(`${at} 不是真假`);
}

/** 小本子:只有有限的数、数组、普通对象 */
function checkNote(v: unknown, at: string): void {
  let size = 0;
  const walk = (x: unknown, depth: number, here: string): void => {
    if (depth > PLUGIN_LIMITS.depth) broken(`${at} 套得太深`);
    size += 8;
    if (size > PLUGIN_LIMITS.note) broken(`${at} 太大`);
    if (typeof x === 'number') return void num(x, here);
    if (Array.isArray(x)) return x.forEach((y, i) => walk(y, depth + 1, `${here}[${i}]`));
    const o = obj(x, here);
    for (const k of Object.keys(o)) {
      size += k.length * 2;
      walk(o[k], depth + 1, `${here}.${k}`);
    }
  };
  walk(v, 0, at);
}

/** 插件那组数表的快照(engine/tables 的 TableSnapshot) */
function checkTableSnapshot(v: unknown, at: string): void {
  const t = obj(v, at);
  onlyKeys(t, ['year', 'lastStep', 'polityCount', 'polityAnchor', 'tables', 'acc'], at);
  engineYear(t.year, `${at}.year`);
  engineYear(t.lastStep, `${at}.lastStep`);
  const P = int(t.polityCount, 0, 2 ** 15 + 1, `${at}.polityCount`);
  typed(t.polityAnchor, Int32Array, `${at}.polityAnchor`, P);
  const tables = obj(t.tables, `${at}.tables`);
  const names = Object.keys(tables);
  // 插件自己的表,外加按国记时对上州 → 国的那一张
  if (names.length > PLUGIN_LIMITS.tables + 1) broken(`${at} 的表太多`);
  for (const name of names) {
    const here = `${at}.tables.${name}`;
    if (!SIM_TABLE_NAME.test(name)) broken(`${here} 的名字不合规矩`);
    const x = obj(tables[name], here);
    onlyKeys(x, ['cur', 'last', 'disabled', 'fallback', 'delta', 'oscStreak', 'runStreak', 'warned', 'flowStart', 'flowOpen', 'flowWindows'], here);
    allFinite(typed(x.cur, Float64Array, `${here}.cur`), `${here}.cur`);
    engineYear(x.last, `${here}.last`);
    bool(x.disabled, `${here}.disabled`);
    bool(x.fallback, `${here}.fallback`);
    if (x.delta !== null) allFinite(typed(x.delta, Float64Array, `${here}.delta`), `${here}.delta`);
    int(x.oscStreak, 0, 2 ** 31, `${here}.oscStreak`);
    int(x.runStreak, 0, 2 ** 31, `${here}.runStreak`);
    bool(x.warned, `${here}.warned`);
    engineYear(x.flowStart, `${here}.flowStart`);
    list(x.flowOpen, `${here}.flowOpen`).forEach((f, i) => {
      const pair = list(f, `${here}.flowOpen[${i}]`);
      if (pair.length !== 2) broken(`${here}.flowOpen[${i}] 不是两个数`);
      pair.forEach((y, j) => num(y, `${here}.flowOpen[${i}][${j}]`));
    });
    int(x.flowWindows, 0, 2 ** 31, `${here}.flowWindows`);
  }
  list(t.acc, `${at}.acc`).forEach((raw, i) => {
    const here = `${at}.acc[${i}]`;
    const a = obj(raw, here);
    onlyKeys(a, ['key', 'data', 'from', 'at'], here);
    if (typeof a.key !== 'string' || !SIM_ACC_KEY.test(a.key)) broken(`${here}.key 不合规矩`);
    allFinite(typed(a.data, Float64Array, `${here}.data`), `${here}.data`);
    engineYear(a.from, `${here}.from`);
    engineYear(a.at, `${here}.at`);
  });
}

/**
 * 一个推演插件推到哪的状态(sim.<插件编号> 那一块,或者历史里 simPlugins 的一项):只有数、数表的名字和挡下的命令的种类名,不合格抛 broken。
 * 和插件现在的样子对不对得上(表、栏、事件的先后),接着推时再查
 */
export function validateSimState(v: unknown, id: string, at = `推演插件 ${id} 的状态`): asserts v is SimPluginState {
  const s = obj(v, at);
  onlyKeys(s, ['id', 'sig', 'year', 'heard', 'seq', 'events', 'note', 'tables', 'influences', 'refused'], at);
  if (s.id !== id) broken(`${at} 的 id 对不上`);
  int(s.sig, 0, 2 ** 32, `${at}.sig`);
  const year = yearOk(s.year, `${at}.year`);
  if (year < 0 || year > END_YEAR_MAX) broken(`${at}.year 超出范围`);
  int(s.heard, 0, 2 ** 31, `${at}.heard`);
  int(s.seq, 0, Number.MAX_SAFE_INTEGER, `${at}.seq`);
  const ev = typed(s.events, Float64Array, `${at}.events`);
  let n = 0;
  for (let i = 0; i < ev.length; n++) {
    const k = ev[i + 3];
    if (i + 4 > ev.length || !Number.isInteger(k) || k < 0 || k > PLUGIN_LIMITS.data || i + 4 + k > ev.length) broken(`${at}.events 不对`);
    allFinite(ev.subarray(i, i + 4 + k), `${at}.events`);
    i += 4 + k;
  }
  if (n > PLUGIN_LIMITS.pending) broken(`${at}.events 太多`);
  if (s.note !== undefined) checkNote(s.note, `${at}.note`);
  if (s.tables !== undefined) checkTableSnapshot(s.tables, `${at}.tables`);
  if (s.influences !== undefined) checkInfluences(s.influences, `${at}.influences`);
  if (s.refused !== undefined && !cleanRefused(s.refused)) broken(`${at}.refused 不对`);
}

/** 插件交给影响口的几栏:口名是官方登记的,数在口的上下限里(格数和州、国对不对得上,接着推时再查) */
function checkInfluences(v: unknown, at: string): void {
  const o = obj(v, at);
  for (const id of Object.keys(o)) {
    const p = OFFICIAL_INFLUENCES.find((q) => q.id === id);
    if (!p) broken(`${at} 里没有影响口 ${id}`);
    const cols = p!.cols ?? 1;
    const a = typed(o[id], Float64Array, `${at}.${id}`);
    if (a.length % cols || a.length > 2 ** 15 * cols) broken(`${at}.${id} 的格数不对`);
    for (let i = 0; i < a.length; i++) if (!(a[i] >= p!.min && a[i] <= p!.max)) broken(`${at}.${id} 超出上下限`);
  }
}

/** 历史里 simPlugins 那一项:几个推演插件的状态,编号不重复 */
export function validateSimStates(v: unknown): asserts v is SimPluginState[] {
  const states = list(v, '历史的 simPlugins');
  if (states.length > PLUGIN_LIMITS.plugins) broken('历史的 simPlugins 太多');
  const ids = new Set<string>();
  states.forEach((x, i) => {
    const id = obj(x, `历史的 simPlugins[${i}]`).id;
    if (typeof id !== 'string' || id.length > PLUGIN_ID_MAX || !PLUGIN_ID.test(id) || ids.has(id)) broken(`历史的 simPlugins[${i}].id 不合规矩`);
    ids.add(id);
    validateSimState(x, id);
  });
}

const isPluginId = (v: unknown): v is string => typeof v === 'string' && v.length <= PLUGIN_ID_MAX && PLUGIN_ID.test(v);

/** 历史里 simChronicle 那一项:推演插件写的编年史,按年份先后;指代都要在历史里找得到 */
function checkSimChronicle(raw: unknown, c: Counts): void {
  const counts: Record<ChronicleRefKind, number> = { polity: c.polities, region: c.regions, settlement: c.settlements, culture: c.cultures };
  let last = 0;
  list(raw, '历史的 simChronicle').forEach((x, i) => {
    const at = `历史的 simChronicle[${i}]`;
    const l = obj(x, at);
    onlyKeys(l, ['year', 'by', 'text'], at);
    const year = num(l.year, `${at}.year`);
    if (year < last || year > c.endYear) broken(`${at}.year 不对(要按先后、不晚于 ${c.endYear})`);
    last = year;
    if (!isPluginId(l.by)) broken(`${at}.by 不是插件编号`);
    const text = str(l.text, `${at}.text`, NAME_TEXT_MAX);
    try {
      checkStoredChronicle(text, (k) => counts[k]);
    } catch (e) {
      broken(`${at}.text 不对:${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

/** 一个世界里一格是什么、有几格(按 unit) */
export interface LayerSizes {
  cells: number;
  regions: number;
  /** 跟着历史走的图层:历史推到哪年(年份不能更晚);不给 = 和历史无关(不晚于 END_YEAR_MAX) */
  endYear?: number;
}

/**
 * 插件图层(layer.<插件编号>.<图层编号> 那一块,或者历史里 simLayers 的一项去掉 by、id):不合格抛 broken。
 * 样子(标题、渐变或分类、图例、透明度)要和工具插件交图层时网站查完的那一份一模一样
 */
export function validatePluginLayer(v: unknown, sizes: LayerSizes, at = '插件图层', extra: readonly string[] = []): asserts v is PluginLayerValue {
  const o = obj(v, at);
  onlyKeys(o, [...extra, 'title', 'unit', 'years', 'values', 'ramp', 'classes', 'legend', 'opacity'], at);
  oneOf(o.unit, ['cell', 'region'], `${at}.unit`);
  let frames = 1;
  if (o.years !== undefined) {
    const years = list(o.years, `${at}.years`);
    const last = sizes.endYear ?? END_YEAR_MAX;
    if (!years.length) broken(`${at}.years 是空的`);
    years.forEach((y, i) => {
      const year = num(y, `${at}.years[${i}]`);
      if (year < 0 || year > last || (i > 0 && !(year > (years[i - 1] as number)))) broken(`${at}.years[${i}] 不对(要从小到大、在 0 到 ${last} 之间)`);
    });
    frames = years.length;
  }
  const values = typed(o.values, Float32Array, `${at}.values`, frames * (o.unit === 'cell' ? sizes.cells : sizes.regions));
  for (let i = 0; i < values.length; i++) if (values[i] === Infinity || values[i] === -Infinity) broken(`${at}.values[${i}] 不是数`);
  let same = false;
  try {
    same = sameLayerLook(o, checkLayerLook(o));
  } catch (e) {
    broken(`${at} 的样子不对:${e instanceof Error ? e.message : String(e)}`);
  }
  if (!same) broken(`${at} 的样子不对(标题、颜色、分类、图例、透明度要是网站查完的那一份)`);
}

/** 历史里 simLayers 那一项:推演插件存下的图层,(插件, 图层) 不重复 */
function validateSimLayers(raw: unknown, sizes: LayerSizes): void {
  const layers = list(raw, '历史的 simLayers');
  if (layers.length > PLUGIN_LAYERS_MAX) broken('历史的 simLayers 太多');
  const seen = new Set<string>();
  layers.forEach((x, i) => {
    const at = `历史的 simLayers[${i}]`;
    const l = obj(x, at);
    if (!isPluginId(l.by) || typeof l.id !== 'string' || !PLUGIN_LAYER_ID.test(l.id) || seen.has(`${l.by}.${l.id}`)) broken(`${at} 的 by、id 不合规矩`);
    seen.add(`${l.by}.${l.id}`);
    if ((l.unit !== 'region' && l.unit !== 'tile') || l.years === undefined) broken(`${at} 要按州或按地块、带年份`);
    // 内存里地块层记 'tile',世界文件那一块记 'cell';按地块的格数按 mesh 地块算
    validatePluginLayer(l.unit === 'tile' ? { ...l, unit: 'cell' } : l, sizes, at, ['by', 'id']);
  });
}

// ---------------------------------------------------------------------------
// 编年史

const entry = (raw: unknown, civ: Civ, at: string, depth: number): void => {
  const e = obj(raw, at);
  if (!Number.isInteger(e.id)) broken(`${at}.id 不是整数`);
  if (!ENTRY_KIND_NAMES.has(str(e.kind, `${at}.kind`, 32))) broken(`${at}.kind 认不出`);
  const year = num(e.year, `${at}.year`);
  const end = num(e.end, `${at}.end`);
  if (year < 0 || year > civ.endYear || end < 0 || end > civ.endYear) broken(`${at} 的年份不对(要在 0 到 ${civ.endYear} 之间)`);
  str(e.text, `${at}.text`, TEXT_ONE_MAX);
  str(e.tag, `${at}.tag`, 8);
  int(e.importance, 1, 4, `${at}.importance`);
  list(e.polities, `${at}.polities`).forEach((p, k) => int(p, 0, civ.polities.length, `${at}.polities[${k}]`));
  list(e.regions, `${at}.regions`).forEach((r, k) => int(r, 0, civ.regions.count, `${at}.regions[${k}]`));
  int(e.settlement, -1, civ.settlements.length, `${at}.settlement`);
  if (e.head !== undefined) str(e.head, `${at}.head`, TEXT_ONE_MAX);
  if (e.people !== undefined) list(e.people, `${at}.people`).forEach((p, k) => int(p, 0, civ.people?.length ?? 0, `${at}.people[${k}]`));
  optInt(e.faith, 0, civ.religion?.faiths.length ?? 0, `${at}.faith`);
  if (e.trade !== undefined) list(e.trade, `${at}.trade`).forEach((t, k) => int(t, 0, civ.trade?.routes.length ?? 0, `${at}.trade[${k}]`));
  optInt(e.thought, 0, THOUGHT_COUNT, `${at}.thought`);
  if (e.plugin !== undefined && !isPluginId(e.plugin)) broken(`${at}.plugin 不是插件编号`);
  if (e.children !== undefined) {
    // 真实的编年史只折叠一两层;读包函数已经限了总层数,这里再早一点拒绝
    if (depth >= 16) broken(`${at} 折叠得太深`);
    list(e.children, `${at}.children`).forEach((x, k) => entry(x, civ, `${at}.children[${k}]`, depth + 1));
  }
};

/** 编年史(chronicle 那一块):不合格抛 broken */
export function validateChronicle(v: unknown, civ: Civ): asserts v is ChronicleBlock {
  const block = obj(v, '编年史');
  list(block.entries, '编年史的 entries').forEach((x, i) => entry(x, civ, `编年史[${i}]`, 0));
  if (block.authorFemale !== undefined)
    list(block.authorFemale, '编年史的 authorFemale').forEach((x, i) => {
      if (!Number.isInteger(x)) broken(`编年史的 authorFemale[${i}] 不是整数`);
    });
  allStrings(v, TEXT_ONE_MAX, TEXT_TOTAL_MAX, '编年史');
}

// ---------------------------------------------------------------------------
// 旗

/**
 * 一面旗:画旗时这些字段会拼进 SVG、再写进网页,所以只认存档写法白名单(decodeFlag)里有的:
 * 按写法编一遍再读回来,要和原来的一模一样(多一个字段、一个认不出的值都不行)
 */
function checkFlagSpec(raw: unknown, at: string): void {
  const s = obj(raw, at);
  let code: string;
  try {
    code = encodeFlag(s as unknown as FlagSpec);
  } catch {
    broken(`${at} 不是一面旗`);
  }
  const back = decodeFlag(code);
  if (!back) broken(`${at} 不是一面旗`);
  if (canonFlag(s) !== canonFlag(back as unknown as Obj)) broken(`${at} 不是一面旗`);
}

/** 旗的固定写法(比两面旗一样不一样):键排好序、去掉 undefined;只有一颗小星时 mullets 可写可不写 */
function canonFlag(s: Obj): string {
  const c: Obj = { ...s };
  if (c.mullet !== undefined && c.mullets === undefined) c.mullets = 1;
  return JSON.stringify(c, (_, v: unknown) => (isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
}

/** 这一朝兴起的城是哪一类(flags.ts 的 Seat;选图案时按它查表) */
const SEATS: readonly Seat[] = ['sea', 'mountain', 'river', 'forest', 'dry', 'plain'];

/** 旗(flags 那一块):每国一列,下标 = 国家编号。不合格抛 broken */
export function validateFlags(v: unknown, civ: Civ): asserts v is FlagBook {
  const book = obj(v, '旗');
  const eras = list(book.eras, '旗的 eras');
  if (eras.length !== civ.polities.length) broken('旗的 eras 和国家对不上');
  eras.forEach((raw, i) => {
    list(raw, `旗的 eras[${i}]`).forEach((x, k) => {
      const at = `旗的 eras[${i}][${k}]`;
      const e = obj(x, at);
      yearOk(e.year, `${at}.year`);
      num(e.dyn, `${at}.dyn`);
      str(e.key, `${at}.key`, NAME_TEXT_MAX);
      checkFlagSpec(e.spec, `${at}.spec`);
      oneOf(e.how, ['auto', 'edited', 'derived'], `${at}.how`);
      const why = obj(e.why, `${at}.why`);
      oneOf(why.kind, ['east', 'khan', 'west'], `${at}.why.kind`);
      oneOf(why.seat, SEATS, `${at}.why.seat`);
      if (why.swap !== undefined) {
        const swap = list(why.swap, `${at}.why.swap`);
        if (swap.length !== 2) broken(`${at}.why.swap 不是两个颜色`);
        swap.forEach((t, j) => oneOf(t, TINCTS, `${at}.why.swap[${j}]`));
      }
      int(why.city, -1, civ.settlements.length, `${at}.why.city`);
      optInt(why.parent, 0, civ.polities.length, `${at}.why.parent`);
      optInt(why.restores, 0, civ.polities.length, `${at}.why.restores`);
      // 改制以前的那面只能往前指:讲旗的意思时顺着它往回走,指自己、指后面就走不到头
      optInt(why.prior, 0, k, `${at}.why.prior`);
      int(e.dyn, 0, Number.MAX_SAFE_INTEGER, `${at}.dyn`);
    });
  });
  allStrings(v, NAME_TEXT_MAX, TEXT_TOTAL_MAX, '旗');
}

// ---------------------------------------------------------------------------
// 作者内容、封面

/** 作者内容最多几条 */
const NOTES_MAX = 1e5;
/** 一条正文最长多少字:最长的一部史书一版也就八万多字(分 12 章写、一章最多 7000 个 token),留足 */
const NOTE_TEXT_MAX = 4e6;
/** 正文以外的字段最长多少字 */
const NOTE_FIELD_MAX = 4096;

/** 作者内容(author 那一块):不合格抛 broken;读世界文件的时候接住,只跳过这一块(gen/worldFile.ts) */
export function validateAuthor(v: unknown): asserts v is AuthorContent {
  const a = obj(v, '作者内容');
  const notes = list(a.notes, '作者内容的 notes');
  if (notes.length > NOTES_MAX) broken('作者内容太多');
  notes.forEach((x, i) => {
    const at = `作者内容的 notes[${i}]`;
    const n = obj(x, at);
    str(n.text, `${at}.text`, NOTE_TEXT_MAX);
    for (const k of ['key', 'kind', 'title', 'createdAt', 'provider', 'model']) str(n[k], `${at}.${k}`, NOTE_FIELD_MAX);
  });
}

/** 封面的图最大多少像素一边:封面是 480 × 240。图的文件很小、解开却很大的图片能撑爆内存,所以看图头里写的尺寸 */
const THUMB_MAX_SIDE = 4096;

/** 封面(thumb 那一块):要真是 JPEG(开头、结尾的记号,图头里的尺寸);大小上限在解块时已经卡了。不合格抛 broken */
export function validateThumb(b: Uint8Array): void {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8 || b[2] !== 0xff) broken('封面不是 JPEG');
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) broken('封面不完整');
  // 一段段往后看,找到带尺寸的那段(SOF0–SOF15,C4、C8、CC 不是)
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) broken('封面不是 JPEG');
    const m = b[p + 1];
    if (m === 0xff) {
      p++;
      continue;
    }
    if (m === 0xd9 || m === 0xda) break; // 到了正文、结尾都没见到尺寸
    const len = (b[p + 2] << 8) | b[p + 3];
    if (len < 2 || p + 2 + len > b.length) broken('封面不完整');
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (len < 7) broken('封面不完整');
      const h = (b[p + 5] << 8) | b[p + 6];
      const w = (b[p + 7] << 8) | b[p + 8];
      if (!w || !h || w > THUMB_MAX_SIDE || h > THUMB_MAX_SIDE) broken('封面的尺寸不对');
      return;
    }
    p += 2 + len;
  }
  broken('封面没有尺寸');
}
