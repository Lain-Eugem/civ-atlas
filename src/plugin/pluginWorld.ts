/**
 * 插件和世界文件之间:世界清单里怎么记插件、一个世界用到了哪些插件、本机装没装。纯计算,网页、Worker、服务器共用。
 */
import { PLUGIN_DATA_PREFIX, mapPluginKey, pluginLayerOf, type WorldManifest, type WorldPartInfo, type WorldPlugin } from '../gen/worldFormat';
import type { OpenedPlugin } from './pluginFile';
import type { SimParam } from './pluginSim';

/** 世界清单 plugins 里记这个插件的那一条 */
export function worldPluginOf(p: Pick<OpenedPlugin, 'manifest' | 'sum'>): WorldPlugin {
  return { id: p.manifest.id, version: p.manifest.version, sum: p.sum, role: p.manifest.role, name: p.manifest.name };
}

/** 世界里用到的一个插件 */
export interface WorldPluginUse {
  id: string;
  /** 清单里的记录;没记 = null */
  plugin: WorldPlugin | null;
  /** 它存的数据那一块;没存 = null */
  data: WorldPartInfo | null;
  /** 它存进世界的图层(块名里的图层编号,按清单里的先后) */
  layers: string[];
  /** 本机:same 装的正是世界记的那一版,other 装了别的版本,none 没装 */
  here: 'same' | 'other' | 'none';
}

/** 一个世界用到的插件(清单里记的,和存了数据、图层的),按清单里的先后;installed = 本机装的插件和现在用的那一版的指纹 */
export function pluginsInWorld(m: Pick<WorldManifest, 'parts' | 'plugins'>, installed: readonly { id: string; current: { sum: string } }[]): WorldPluginUse[] {
  const data = new Map(m.parts.filter((p) => p.name.startsWith(PLUGIN_DATA_PREFIX)).map((p) => [p.name.slice(PLUGIN_DATA_PREFIX.length), p]));
  const layers = new Map<string, string[]>();
  for (const p of m.parts) {
    const ids = pluginLayerOf(p.name);
    if (!ids) continue;
    const list = layers.get(ids[0]);
    if (list) list.push(ids[1]);
    else layers.set(ids[0], [ids[1]]);
  }
  const byId = new Map(m.plugins.map((p) => [p.id, p]));
  const installedById = new Map(installed.map((p) => [p.id, p]));
  const ids = [...new Set([...byId.keys(), ...data.keys(), ...layers.keys()])];
  return ids.map((id) => {
    const plugin = byId.get(id) ?? null;
    const have = installedById.get(id);
    const here = !have ? 'none' : plugin && have.current.sum === plugin.sum ? 'same' : 'other';
    return { id, plugin, data: data.get(id) ?? null, layers: layers.get(id) ?? [], here };
  });
}

/** 一个推演插件交给推演线程的:编号、文件的指纹、文件的原字节、滑条拨到几(一串按插件出手的先后排) */
export interface SimPluginFile {
  id: string;
  sum: string;
  bytes: Uint8Array;
  params?: Readonly<Record<string, number>>;
}

/** 滑条拨到几:清单 sim.params 里写的每一个都有;没给、不是数的按默认,超出的压回上下限,清单里没写的不要 */
export function simParamsOf(spec: Readonly<Record<string, Pick<SimParam, 'min' | 'max' | 'default'>>> | undefined, given?: Readonly<Record<string, unknown>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, s] of Object.entries(spec ?? {})) {
    const v = given && Object.prototype.hasOwnProperty.call(given, k) ? given[k] : undefined;
    out[k] = typeof v === 'number' && Number.isFinite(v) ? Math.min(s.max, Math.max(s.min, v)) : s.default;
  }
  return out;
}

/** 世界清单 plugins 里记这个推演插件的那一条:连同推这份历史时滑条拨到几(没有滑条不写) */
export function simPluginOf(p: Pick<OpenedPlugin, 'manifest' | 'sum'>, params: Readonly<Record<string, number>>): WorldPlugin {
  return { ...worldPluginOf(p), ...(Object.keys(params).length ? { params: { ...params } } : {}) };
}

/** 世界清单 plugins 里记这个地图插件的那一条:连同长这张地图时滑条拨到几(没有滑条不写) */
export const mapPluginOf = simPluginOf;

/** 世界清单里记的推演插件(按出手的先后) */
export const simPluginsIn = (plugins: readonly WorldPlugin[]): WorldPlugin[] => plugins.filter((p) => p.role === 'sim');

/** 世界清单里记的地图插件(按生成时出手的先后) */
export const mapPluginsIn = (plugins: readonly WorldPlugin[]): WorldPlugin[] => plugins.filter((p) => p.role === 'map');

/**
 * 一个地图插件交给生成线程的:编号、文件的指纹、滑条拨到几(清单里写的每一个都有,一串按出手的先后排)。
 * bytes = 文件的原字节;这台设备没有那一版 = 不给(线程认得出是哪张地图,但长不出来)
 */
export interface MapPluginFile {
  id: string;
  sum: string;
  params?: Readonly<Record<string, number>>;
  bytes?: Uint8Array;
}

export { mapPluginKey };

/** 世界清单里记的地图插件 → 交给生成线程的(不带字节) */
export const mapPluginIds = (plugins: readonly WorldPlugin[]): MapPluginFile[] =>
  mapPluginsIn(plugins).map((p) => {
    const params = recordParams(p);
    return { id: p.id, sum: p.sum, ...(params ? { params } : {}) };
  });

/** 世界清单里记的滑条(只要数;没记 = undefined) */
export function recordParams(p: WorldPlugin): Record<string, number> | undefined {
  if (!p.params) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(p.params)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}

/** 本机装着的一个插件:核对要用的几样(插件仓库的 InstalledPlugin 有这几样) */
export interface InstalledSim {
  id: string;
  current: { sum: string; manifest: { version: string } };
  previous?: { sum: string };
}

/**
 * 世界用的一个插件本机有没有(推演插件接着推之前、地图插件改地形之前):
 * - ready:有世界记的那一版(现在用的或留着的上一版,文件指纹一样),用它、用世界记的滑条
 * - missing:没装
 * - other:装了,两版都不是世界记的那一版;installed 是现在用的那一版(只能另存一份、按它重推 / 重长)
 * - blocked:世界记的那一版被网站停用了(按编号或指纹),不再跑;只能另存一份不带它的
 */
export type PluginCheck = { id: string; plugin: WorldPlugin } & (
  | { status: 'ready'; which: 'current' | 'previous' }
  | { status: 'missing' }
  | { status: 'other'; installed: { version: string; sum: string } }
  | { status: 'blocked'; why: string; day: string }
);
export type SimPluginCheck = PluginCheck;
export type MapPluginCheck = PluginCheck;

/** 世界清单里记的推演插件逐个核对(按记的先后);installed = 本机装的插件 */
export const checkSimPlugins = (world: readonly WorldPlugin[], installed: readonly InstalledSim[]): SimPluginCheck[] => checkPlugins(simPluginsIn(world), installed);

/** 世界清单里记的地图插件逐个核对(按记的先后) */
export const checkMapPlugins = (world: readonly WorldPlugin[], installed: readonly InstalledSim[]): MapPluginCheck[] => checkPlugins(mapPluginsIn(world), installed);

function checkPlugins(list: readonly WorldPlugin[], installed: readonly InstalledSim[]): PluginCheck[] {
  const installedById = new Map(installed.map((p) => [p.id, p]));
  return list.map((plugin): PluginCheck => {
    const id = plugin.id;
    const have = installedById.get(id);
    if (!have) return { id, plugin, status: 'missing' };
    if (have.current.sum === plugin.sum) return { id, plugin, status: 'ready', which: 'current' };
    if (have.previous?.sum === plugin.sum) return { id, plugin, status: 'ready', which: 'previous' };
    return { id, plugin, status: 'other', installed: { version: have.current.manifest.version, sum: have.current.sum } };
  });
}
