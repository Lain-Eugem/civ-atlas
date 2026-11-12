/**
 * 插件存进世界的数据(worldVault.ts 的 readPluginData、changePluginData)和世界清单里的插件记录(plugin/pluginWorld.ts):
 * 存、读回、换掉、去掉,块名和记录对,存成文件读得开、认得出不能公开分享,重推以后还在。IndexedDB 用 fake-indexeddb。
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makePart, type SnapshotPart } from '../src/gen/snapshot';
import { opaqueParts, openWorldFile, packWorldParts, type PackInput, type WorldEras } from '../src/gen/worldFile';
import { PLUGIN_DATA_MAX_BYTES, type WorldManifest, type WorldPlugin } from '../src/gen/worldFormat';
import { openPluginFile } from '../src/plugin/pluginFile';
import { PluginApiError } from '../src/plugin/check';
import { worldDataStore } from '../src/plugin/pluginData';
import { pluginsInWorld, worldPluginOf } from '../src/plugin/pluginWorld';
import type { VaultCaller } from '../src/ui/worldStore';
import { _resetVault, changePluginData, changePluginLayer, commitWorld, opaquePartsOf, readPluginData, readPluginLayers, readRevision, revisionFile, vaultOps, type CommitRequest } from '../src/worldVault';
import { goodPlugin } from './lib/pluginFileSample';
import { MADE, READERS, makeSample } from './lib/worldFileSample';

const g = globalThis as unknown as { indexedDB: IDBFactory | undefined };

let sample: PackInput & { eras: WorldEras };
let viewParts: SnapshotPart[];
let tool: WorldPlugin;

beforeAll(async () => {
  sample = makeSample();
  const { parts } = await packWorldParts(sample);
  viewParts = parts
    .filter((p) => !['author', 'thumb'].includes(p.info.name))
    .map((p) => ({ name: p.info.name, bytes: p.info.bytes, sum: p.info.sum, zip: p.info.zip as 'gzip' | 'none', data: p.data as ArrayBuffer }));
  tool = worldPluginOf(await openPluginFile(await goodPlugin()));
}, 60_000);

beforeEach(() => {
  _resetVault();
  g.indexedDB = new IDBFactory();
});
afterEach(() => _resetVault());

const copies = (list: SnapshotPart[]) => list.map((p) => ({ ...p, data: p.data.slice(0) }));
const request = (over: Partial<CommitRequest> = {}): CommitRequest => ({ id: sample.id, recipe: sample.recipe, recipeKey: 'k1', parts: copies(viewParts), made: MADE, readers: READERS, ...over });
const latest = async (): Promise<WorldManifest> => (await readRevision(sample.id, undefined, []))!.manifest;

describe('插件存进世界的数据', () => {
  it('记录照插件文件来:编号、第几版、文件指纹、种类', async () => {
    const opened = await openPluginFile(await goodPlugin());
    expect(tool).toEqual({ id: 'route-measure', version: '1.0.0', sum: opened.sum, role: 'tool', name: opened.manifest.name });
  });

  it('还没存过的世界存不了;没存过数据读出来是 null', async () => {
    expect(await changePluginData(sample.id, tool, { schema: 1, value: 1 })).toEqual({ status: 'nobase' });
    expect(await readPluginData(sample.id, tool.id)).toBeNull();
    await commitWorld(request());
    expect(await readPluginData(sample.id, tool.id)).toBeNull();
  });

  it('存、读回:块叫 ext.<插件编号>、可选、写着谁存的,清单记上插件;别的块、配方都不动', async () => {
    await commitWorld(request());
    const before = await latest();
    expect(await opaquePartsOf(sample.id)).toEqual([]);
    const value = { route: new Int32Array([3, 9, 27]), days: 4.5, note: '走山路' };
    expect(await changePluginData(sample.id, tool, { schema: 2, value })).toEqual({ status: 'saved', n: 2 });
    expect(await readPluginData(sample.id, tool.id)).toEqual({ schema: 2, value, plugin: tool });
    const m = await latest();
    expect(m.parts.find((p) => p.name === 'ext.route-measure')).toMatchObject({ file: 'parts/ext.route-measure.gz', schema: 2, need: 'extra', by: 'route-measure' });
    expect(m.plugins).toEqual([tool]);
    expect(m.parts.filter((p) => p.name !== 'ext.route-measure')).toEqual(before.parts);
    expect(m.recipe).toEqual(before.recipe);
    expect(m.revision.n).toBe(2);
    expect(await opaquePartsOf(sample.id)).toEqual(['ext.route-measure']);

    // 存成文件:别人读得开,只当字节;认得出不能公开分享
    const opened = await openWorldFile((await revisionFile(sample.id))!, { readers: READERS });
    expect(opened.kept.map((p) => p.name)).toEqual(['ext.route-measure']);
    expect(opaqueParts(opened.manifest.parts)).toEqual(['ext.route-measure']);
  });

  it('一样的再存不写新修订;插件换了版本,数据一样也记上新的版本', async () => {
    await commitWorld(request());
    await changePluginData(sample.id, tool, { schema: 1, value: [1, 2] });
    expect(await changePluginData(sample.id, tool, { schema: 1, value: [1, 2] })).toEqual({ status: 'same', n: 2 });
    const newer = { ...tool, version: '1.1.0', sum: 'b'.repeat(64) };
    expect(await changePluginData(sample.id, newer, { schema: 1, value: [1, 2] })).toEqual({ status: 'saved', n: 3 });
    expect((await latest()).plugins).toEqual([newer]);
    expect(await changePluginData(sample.id, newer, { schema: 2, value: [1, 2] })).toEqual({ status: 'saved', n: 4 });
  });

  it('去掉:块和工具插件的记录一起去掉;推演插件的记录留着(世界是它推的)', async () => {
    await commitWorld(request());
    const sim: WorldPlugin = { id: 'magic-sim', version: '1.0.0', sum: 'c'.repeat(64), role: 'sim' };
    await changePluginData(sample.id, sim, { schema: 1, value: 'x' });
    await changePluginData(sample.id, tool, { schema: 1, value: 'y' });
    expect((await latest()).plugins.map((p) => p.id)).toEqual(['magic-sim', 'route-measure']);
    expect((await changePluginData(sample.id, tool, null)).status).toBe('saved');
    expect((await changePluginData(sample.id, sim, null)).status).toBe('saved');
    const m = await latest();
    expect(m.parts.some((p) => p.name.startsWith('ext.'))).toBe(false);
    expect(m.plugins).toEqual([sim]);
    expect(await opaquePartsOf(sample.id)).toEqual([]);
    // 本来就没有的去不掉,不写新修订
    expect(await changePluginData(sample.id, tool, null)).toEqual({ status: 'same', n: m.revision.n });
  });

  it('超过上限:不写,说多大;读不回来的值(绕回自己、层数太多)报错,原来的不动', async () => {
    await commitWorld(request());
    const r = await changePluginData(sample.id, tool, { schema: 1, value: new Uint8Array(PLUGIN_DATA_MAX_BYTES) });
    expect(r.status).toBe('big');
    expect(r.status === 'big' && r.bytes).toBeGreaterThan(PLUGIN_DATA_MAX_BYTES);
    expect((await latest()).revision.n).toBe(1);
    await changePluginData(sample.id, tool, { schema: 1, value: 'old' });
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = [deep];
    for (const value of [loop, deep]) await expect(changePluginData(sample.id, tool, { schema: 1, value })).rejects.toMatchObject({ kind: 'failed' });
    expect((await readPluginData(sample.id, tool.id))?.value).toBe('old');
  });

  it('之后重推、改配方存新修订:插件的数据和记录跟着走', async () => {
    await commitWorld(request());
    await changePluginData(sample.id, tool, { schema: 1, value: { a: 1 } });
    const civ = await makePart('civ', { ...sample.civ, tag: 'again' });
    expect((await commitWorld(request({ recipeKey: 'k2', parts: copies(viewParts.map((p) => (p.name === 'civ' ? civ : p))) }))).status).toBe('saved');
    expect(await readPluginData(sample.id, tool.id)).toEqual({ schema: 1, value: { a: 1 }, plugin: tool });
    expect((await latest()).plugins).toEqual([tool]);
  });

  it('走后台线程的那张表里有这几个;没存过的世界没有不能公开的块', async () => {
    expect(vaultOps.readPluginData).toBe(readPluginData);
    expect(vaultOps.changePluginData).toBe(changePluginData);
    expect(vaultOps.opaquePartsOf).toBe(opaquePartsOf);
    expect(await opaquePartsOf('nope')).toEqual([]);
  });
});

describe('插件接口存世界的数据(store.world)', () => {
  const call: VaultCaller = (op, args) => (vaultOps[op] as (...a: unknown[]) => Promise<never>)(...args);

  it('存、取、删走世界仓库;世界还没存下来回 unavailable,太大回 limit', async () => {
    const store = worldDataStore(call, sample.id, tool);
    await expect(store.set(tool.id, { schema: 1, value: 1 })).rejects.toMatchObject({ code: 'unavailable' });
    await commitWorld(request());
    expect(await store.get(tool.id)).toBeNull();
    await store.set(tool.id, { schema: 3, value: { cells: new Float32Array([1, 2]) } });
    expect(await store.get(tool.id)).toEqual({ schema: 3, value: { cells: new Float32Array([1, 2]) } });
    expect((await latest()).plugins).toEqual([tool]);
    const err = await Promise.resolve(store.set(tool.id, { schema: 1, value: new Uint8Array(PLUGIN_DATA_MAX_BYTES) })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginApiError);
    expect((err as PluginApiError).code).toBe('limit');
    await store.set(tool.id, null);
    expect(await store.get(tool.id)).toBeNull();
    expect((await latest()).plugins).toEqual([]);
  });
});

describe('世界用到的插件和本机装没装', () => {
  it('清单里记的、存了数据的都列出来;装的版本一样 / 不一样 / 没装', () => {
    const data = (id: string) => ({ name: `ext.${id}`, file: `parts/ext.${id}.gz`, schema: 1, sum: 'a'.repeat(64), bytes: 1, zip: 'gzip', need: 'extra' as const, by: id });
    const m = {
      plugins: [tool, { id: 'magic-sim', version: '1.0.0', sum: 'c'.repeat(64), role: 'sim' }],
      parts: [data('route-measure'), data('orphan')],
    };
    const uses = pluginsInWorld(m, [
      { id: 'route-measure', current: { sum: tool.sum } },
      { id: 'magic-sim', current: { sum: 'd'.repeat(64) } },
    ]);
    expect(uses.map((u) => [u.id, u.here, !!u.plugin, !!u.data])).toEqual([
      ['route-measure', 'same', true, true],
      ['magic-sim', 'other', true, false],
      ['orphan', 'none', false, true],
    ]);
  });

  it('存了图层的也列出来,连同存了哪几层', () => {
    const layer = (pid: string, l: string) => ({ name: `layer.${pid}.${l}`, file: `parts/layer.${pid}.${l}.gz`, schema: 1, sum: 'a'.repeat(64), bytes: 1, zip: 'gzip', need: 'extra' as const, by: pid });
    const uses = pluginsInWorld({ plugins: [tool], parts: [layer('route-measure', 'a'), layer('coast-distance', 'coast'), layer('route-measure', 'b')] }, []);
    expect(uses.map((u) => [u.id, u.layers, !!u.plugin])).toEqual([
      ['route-measure', ['a', 'b'], true],
      ['coast-distance', ['coast'], false],
    ]);
  });
});

describe('只复制插件内容(copyPluginRevision)', () => {
  it('源世界没有插件记录、数据、图层:返回 none,不建副本', async () => {
    await commitWorld(request());
    expect(await vaultOps.copyPluginRevision(sample.id, 'copy-none', '复制的')).toBe('none');
    expect(await readRevision('copy-none', undefined, [])).toBeNull();
  });

  it('源世界读不到、清单读不懂:返回 corrupt,不能当成没有插件', async () => {
    expect(await vaultOps.copyPluginRevision('nothing', 'copy-x', undefined)).toBe('corrupt');
  });

  it('有插件:原样复制成第一份修订,数据、图层都能从副本读回', async () => {
    await commitWorld(request());
    const sim: WorldPlugin = { id: 'magic-sim', version: '1.0.0', sum: 'c'.repeat(64), role: 'sim' };
    await changePluginData(sample.id, sim, { schema: 1, value: 'x' });
    await changePluginData(sample.id, tool, { schema: 2, value: { route: [3, 9] } });
    const cells = sample.map.mesh.n;
    await changePluginLayer(sample.id, tool, 'dist', { title: '距离', unit: 'cell', values: new Float32Array(cells).fill(1), classes: [{ value: 1, color: '#2b83ba', label: '近' }], legend: '', opacity: 0.7 });
    const from = await latest();

    expect(await vaultOps.copyPluginRevision(sample.id, 'copy-p', '复制的')).toBe('ok');
    const copy = (await readRevision('copy-p', undefined, []))!;
    expect(copy.head.n).toBe(1);
    expect(copy.manifest.plugins).toEqual(from.plugins);
    expect(copy.manifest.parts).toEqual(from.parts);
    expect(await readPluginData('copy-p', tool.id)).toMatchObject({ schema: 2, value: { route: [3, 9] } });
    expect((await readPluginLayers('copy-p', cells)).map((l) => l.layer)).toEqual(['dist']);
  });

  it('副本已经被后台转存抢先写了第一份:再补一份插件版修订,不覆盖(只有这一份时)', async () => {
    await commitWorld(request());
    await changePluginData(sample.id, tool, { schema: 2, value: { route: [3, 9] } });
    // 模拟后台转存:副本先有了一份不带插件的自动修订
    await commitWorld(request({ id: 'copy-race' }));
    const before = (await readRevision('copy-race', undefined, []))!.head;
    expect(before.n).toBe(1);

    expect(await vaultOps.copyPluginRevision(sample.id, 'copy-race', '复制的')).toBe('ok');
    const copy = (await readRevision('copy-race', undefined, []))!;
    expect(copy.head.n).toBe(2);
    expect(copy.manifest.plugins).toEqual((await latest()).plugins);
    expect(await readPluginData('copy-race', tool.id)).toMatchObject({ schema: 2, value: { route: [3, 9] } });
  });

  it('副本已经有两份以上修订(用户动过):不再覆盖,返回 conflict', async () => {
    await commitWorld(request());
    await changePluginData(sample.id, tool, { schema: 2, value: { route: [3, 9] } });
    await commitWorld(request({ id: 'copy-busy' }));
    await commitWorld(request({ id: 'copy-busy', recipe: { ...sample.recipe, title: '第二份' } }));
    expect(await vaultOps.copyPluginRevision(sample.id, 'copy-busy', '复制的')).toBe('conflict');
    expect((await readRevision('copy-busy', undefined, []))!.head.n).toBe(2);
  });
});

describe('复制世界(copyRevision)', () => {
  it('最新的修订原样成为新世界的第一份:插件记录、数据、图层、块都在,配方换成新名字', async () => {
    await commitWorld(request());
    const sim: WorldPlugin = { id: 'magic-sim', version: '1.0.0', sum: 'c'.repeat(64), role: 'sim' };
    await changePluginData(sample.id, sim, { schema: 1, value: 'x' });
    await changePluginData(sample.id, tool, { schema: 2, value: { route: [3, 9] } });
    const cells = sample.map.mesh.n;
    await changePluginLayer(sample.id, tool, 'dist', { title: '距离', unit: 'cell', values: new Float32Array(cells).fill(1), classes: [{ value: 1, color: '#2b83ba', label: '近' }], legend: '', opacity: 0.7 });
    const from = await latest();
    const recipe = { ...from.recipe, title: '复制的' };

    expect(await vaultOps.copyRevision(sample.id, 'copy-1', '复制的')).toBe(true);
    const copy = (await readRevision('copy-1', undefined, []))!;
    expect(copy.manifest.id).toBe('copy-1');
    expect(copy.manifest.revision).toEqual({ n: 1 });
    expect(copy.manifest.recipe).toEqual(recipe);
    expect(copy.manifest.plugins).toEqual(from.plugins);
    expect(copy.manifest.parts).toEqual(from.parts);
    expect(copy.head.recipeKey).toBe('k1');
    expect(await readPluginData('copy-1', tool.id)).toMatchObject({ schema: 2, value: { route: [3, 9] } });
    expect((await readPluginLayers('copy-1', cells)).map((l) => l.layer)).toEqual(['dist']);

    // 原来的世界不动;已经有修订的、没有修订的世界复制不了
    expect((await latest()).revision.n).toBe(4);
    expect(await vaultOps.copyRevision(sample.id, 'copy-1', '复制的')).toBe(false);
    expect(await vaultOps.copyRevision('nothing', 'copy-2', '复制的')).toBe(false);
  });
});
