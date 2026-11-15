/**
 * 存储满了:世界还能存成文件带走(src/ui/worldFiles.ts、worldVault.ts 的 draftFile),删掉的世界尽快腾地方(src/ui/worldStore.ts 的 drainTrash、src/ui/worldHolds.ts)。
 * IndexedDB 用 fake-indexeddb,写满用 put 抛 QuotaExceededError 来装;后台线程换成直接调。
 * 浏览器里真的把存储写满再走一遍,见 scripts/world-files-check.ts 的 --only=full,trash。
 */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { putNote } from '../src/ai/library';
import { _notesSettled, _resetNotes } from '../src/ai/libraryVault';
import { generateCiv } from '../src/gen/civ';
import { EMPTY_EDITS, GENERATOR_VERSION, type WorldEdits } from '../src/gen/edits';
import { READER_VERSIONS } from '../src/gen/readers/versions';
import { makeSave, worldCheck, type SaveFile } from '../src/gen/savefile';
import { SNAPSHOT_FORMAT, makePart, recipeKey, recipeOfSave } from '../src/gen/snapshot';
import { DEFAULT_PARAMS, generateWorld, type World } from '../src/gen/world';
import { walkZip } from '../src/gen/zipStore';
import { clearEdits, getEdits, setEdits } from '../src/ui/editsStore';
import { _setResultBackend, memoryResults, resultHeads } from '../src/ui/resultStore';
import * as saveStore from '../src/ui/saveStore';
import { _resetToasts, clearToast, peekToast, showToast } from '../src/ui/toastStore';
import { _setWorldFiles, lookWorldFile, keepWorldFile, saveAllWorldFiles, saveWorldFile, type LookedWorldFile } from '../src/ui/worldFiles';
import { _setHolds, holdWorld, ifNotHeld, isHeld } from '../src/ui/worldHolds';
import { setSimNow, simsOf } from '../src/ui/world/simNow';
import { NEAR_FULL_BYTES, TRASH_KEEP_MS, _setWorldStore, _settled, clearTrashNow, fullWorldIds, holdTrashed, notesVault, keepCarried, offerWorldParts, packPage, setWorldStoreSim, spaceBoard, startWorldStore, trashFreed, trashInfo, vaultCall, vaultIsFull, type ConvertRunner, type WorldStoreSim } from '../src/ui/worldStore';
import { runConvert, type FullWithFile } from '../src/worldConvert';
import type { ConvertReply } from '../src/worldConvertWorker';
import { lookFile } from '../src/worldFileLook';
import { mapValue, worldChronicle, worldFlags } from '../src/worldRun';
import { _resetVault, asVaultError, commitWorld, draftFile, latestOf, readRevision, revisionFile, revisionsOf, spaceOf, sweepParts, vaultOps, type VaultOps, type WorldPartsOffer } from '../src/worldVault';
import { bytesOf } from './lib/worldFileSample';

// 每个测试都要打包、核对一个真的小世界,检查机忙的时候第一个测试就过了默认的 5 秒
vi.setConfig({ testTimeout: 30_000 });

class FakeStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

/** navigator.locks 的样子:几个标签页共用一份,够这里用 */
class FakeLocks {
  held = new Map<string, { mode: string }[]>();
  async request(name: string, a: LockOptions | ((l: unknown) => unknown), b?: (l: unknown) => unknown): Promise<unknown> {
    const o = typeof a === 'function' ? {} : a;
    const f = (typeof a === 'function' ? a : b)!;
    const list = this.held.get(name) ?? [];
    const free = !list.length || (o.mode === 'shared' && list.every((x) => x.mode === 'shared'));
    if (!free && o.ifAvailable) return f(null);
    const me = { mode: o.mode ?? 'exclusive' };
    this.held.set(name, [...list, me]);
    try {
      return await f(me);
    } finally {
      this.held.set(name, (this.held.get(name) ?? []).filter((x) => x !== me));
    }
  }
  async query() {
    return { held: [...this.held].flatMap(([name, l]) => l.map((x) => ({ name, mode: x.mode }))), pending: [] };
  }
}

const g = globalThis as unknown as { localStorage?: FakeStorage; indexedDB: IDBFactory };
type Caller = NonNullable<Parameters<typeof _setWorldStore>[0]['caller']>;
const direct = ((op: keyof VaultOps, args: unknown[]) => (vaultOps[op] as (...a: unknown[]) => Promise<unknown>)(...args)) as unknown as Caller;
const OPEN = { readers: READER_VERSIONS };
const PARAMS = { ...DEFAULT_PARAMS, seed: 7, cells: 2000 };

let world: World;
let check: string;
let results = memoryResults();
let stopAuto: (() => void) | null = null;
let locks: FakeLocks;

beforeAll(() => {
  world = generateWorld(PARAMS);
  check = worldCheck(world);
  // 下面用到的几份历史先推好,机器慢时不算在单个测试的时限里
  for (const endYear of [undefined, 200, 500]) civOf({ ...EMPTY_EDITS, endYear });
}, 120_000);

/** 按这份修改推的历史(推演年数一样的记着,不重推) */
const civs = new Map<number, ReturnType<typeof generateCiv>>();
function civOf(edits: WorldEdits) {
  const y = edits.endYear ?? 3000;
  if (!civs.has(y)) civs.set(y, generateCiv(world, { endYear: y }));
  return civs.get(y)!;
}

/** 这份修改的世界内容(生成世界的线程交回来的那一份)。tag = 历史那一块多带一个记号,内容就不一样了(这样的文件过不了校验器,只用来占地方) */
async function offerOf(edits: WorldEdits, tag?: string): Promise<WorldPartsOffer> {
  const recipe = await recipeKey(recipeOfSave(makeSave(PARAMS, edits, check)));
  const civ = civOf(edits);
  const parts = [await makePart('map', mapValue(world)), await makePart('civ', tag ? { ...civ, tag } : civ), await makePart('chronicle', worldChronicle(civ, edits.characters)), await makePart('flags', worldFlags(world, civ))];
  return { generator: GENERATOR_VERSION, recipe, parts };
}

/** 模拟 App 打开一个世界 */
function openWorld(id: string, edits: WorldEdits = EMPTY_EDITS, kind: saveStore.WorldKind = 'created') {
  saveStore.detachWorld();
  clearEdits();
  const stored = saveStore.loadWorld(id);
  const e = stored?.save.edits ?? edits;
  setEdits(e);
  saveStore.attachWorld({ id, params: PARAMS, check, kind, saved: stored?.save.edits ?? e });
}

/** 建好一个世界,内容存进仓库 */
async function makeWorld(title?: string): Promise<string> {
  const id = saveStore.newWorldId();
  openWorld(id);
  saveStore.markCreated();
  if (title) saveStore.renameWorld(id, title);
  expect(await offerWorldParts(await offerOf(getEdits()))).toBe(true);
  return id;
}

/** 从现在起仓库什么都写不进去(浏览器存储满了) */
function fillUp(): () => void {
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
    throw Object.assign(new Error('满了'), { name: 'QuotaExceededError' });
  });
  return () => spy.mockRestore();
}

/** 线程打页面里的世界:记下要了什么,按它要的配方打 */
function simThatPacks(tag?: string): WorldStoreSim & { asks: unknown[] } {
  const asks: unknown[] = [];
  return {
    asks,
    busy: () => false,
    packNow: () => {},
    packParts: async (ask) => {
      asks.push(ask);
      return offerOf(getEdits(), tag);
    },
  };
}

const asLooked = (x: unknown) => {
  const r = x as LookedWorldFile | { ok: false; kind: string; message: string };
  if (!r.ok) throw new Error(`没过:${r.kind} ${r.message}`);
  return r;
};

const looks = async (file: Blob) => {
  const r = await lookFile(file, OPEN);
  if (!r.ok) throw new Error(`文件没过校验:${r.kind} ${r.message}`);
  return r;
};

/** 和转存的线程一样:写满时把装好的文件一起交回来 */
const runnerOf = (): ConvertRunner => (job) => ({
  done: runConvert(job, results).then(
    (result): ConvertReply => ({ ok: true, result }),
    (e: unknown): ConvertReply => {
      const v = asVaultError(e) as FullWithFile;
      return { ok: false, kind: v.kind, message: v.message, ...(v.drafted ? { drafted: v.drafted } : {}) };
    },
  ),
  stop: () => {},
});

beforeEach(() => {
  g.localStorage = new FakeStorage();
  g.indexedDB = new IDBFactory();
  _resetVault();
  saveStore._resetForTest();
  _resetNotes({ vault: { read: vaultOps.readAuthor, change: vaultOps.changeAuthor } });
  _resetToasts();
  clearEdits();
  stopAuto = saveStore.startAutoSave();
  results = memoryResults();
  _setResultBackend(results);
  locks = new FakeLocks();
  _setHolds({ locks: locks as unknown as LockManager });
  _setWorldStore({ caller: direct, runner: runnerOf(), timing: { quiet: 0, poll: 1, pause: 0, holdGap: 0 } });
  _setWorldFiles({ once: direct, look: (f) => lookFile(f, OPEN) });
});

afterEach(async () => {
  vi.restoreAllMocks();
  stopAuto?.();
  stopAuto = null;
  saveStore.detachWorld();
  await _notesSettled();
  await _settled();
  _setResultBackend(undefined);
  _setWorldStore({ caller: null });
  _setWorldFiles({});
  _setHolds();
  _resetVault();
});

// ---------------------------------------------------------------------------

describe('不写库拼世界文件(draftFile)', () => {
  it('什么都没变:和拼出存下的修订一个字节都不差;一个字也不写', async () => {
    const id = await makeWorld('甲');
    const w = saveStore.loadWorld(id)!;
    const key = await recipeKey(recipeOfSave(w.save));
    const before = await revisionsOf(id);
    const out = (await draftFile({ id, recipe: w.save, recipeKey: key }))!;
    expect(out.n).toBe(before.at(-1)!.n);
    expect(out.content).toBe(before.at(-1)!.content);
    expect(await bytesOf(out.file)).toEqual(await bytesOf((await revisionFile(id))!));
    expect(await revisionsOf(id)).toEqual(before);
  });

  it('接不上最新的一份(还没有修订、配方变了):null,不瞎拼', async () => {
    const save = makeSave(PARAMS, EMPTY_EDITS, check);
    expect(await draftFile({ id: 'wnothinghere', recipe: save, recipeKey: 'x' })).toBeNull();
    const id = await makeWorld();
    expect(await draftFile({ id, recipe: makeSave(PARAMS, { ...EMPTY_EDITS, endYear: 500 }, check), recipeKey: 'other' })).toBeNull();
  });

  it('带上完整的内容:写满了也拼得出来,过校验器,版本和读取规则都写对', async () => {
    const edits = { ...EMPTY_EDITS, endYear: 500 };
    const offer = await offerOf(edits, 'b');
    const stop = fillUp();
    const recipe = makeSave(PARAMS, edits, check, '新的');
    const out = (await draftFile({ id: 'wnew1234', recipe, recipeKey: offer.recipe, parts: offer.parts, made: { app: 'x', generator: GENERATOR_VERSION, commit: 'c', at: '2026-11-04T00:00:00.000Z' }, readers: { ...READER_VERSIONS } }))!;
    stop();
    const f = await looks(out.file);
    expect(f.manifest.made.generator).toBe(GENERATOR_VERSION);
    expect(f.manifest.readers).toEqual(READER_VERSIONS);
    expect(f.save.title).toBe('新的');
    expect(f.save.edits.endYear).toBe(500);
    expect(f.manifest.revision.n).toBe(1);
    expect(await latestOf('wnew1234')).toBeNull();
  });

  it('块坏了:不当备份交出去', async () => {
    const id = await makeWorld();
    const w = saveStore.loadWorld(id)!;
    const head = (await readRevision(id))!;
    const civKey = head.manifest.parts.find((p) => p.name === 'civ')!;
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open('civ-atlas:worlds');
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const t = r.result.transaction('parts', 'readwrite');
        t.objectStore('parts').put({ key: `${civKey.sum}.${civKey.zip}`, at: 1, data: new Uint8Array([1, 2, 3]).buffer });
        t.oncomplete = () => {
          r.result.close();
          resolve();
        };
      };
    });
    await expect(draftFile({ id, recipe: w.save, recipeKey: head.head.recipeKey })).rejects.toMatchObject({ kind: 'corrupt' });
  });
});

describe('写满了怎么认', () => {
  it('浏览器没说原因就中止了写(硬盘真的满了时 WebKit 就是这样):算写满了,不算转失败', async () => {
    const edits = { ...EMPTY_EDITS, endYear: 500 };
    const offer = await offerOf(edits);
    const real = IDBDatabase.prototype.transaction;
    const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...a: Parameters<IDBDatabase['transaction']>) {
      const t = real.apply(this, a);
      // 请求都发了,提交时才中止
      if (a[1] === 'readwrite') queueMicrotask(() => t.abort());
      return t;
    });
    const req = { id: 'wabort12', recipe: makeSave(PARAMS, edits, check), recipeKey: offer.recipe, parts: offer.parts, made: { app: 'x', generator: GENERATOR_VERSION, commit: 'c', at: '2026-11-04T00:00:00.000Z' }, readers: { ...READER_VERSIONS } };
    await expect(commitWorld(req)).rejects.toMatchObject({ kind: 'full' });
    spy.mockRestore();
    // 读不算
    const q = await latestOf('wabort12');
    expect(q).toBeNull();
  });
});

describe('写的时候清理也在扫', () => {
  it('没有宽限的清理扫了好几遍(别的标签页在腾地方):写的这一份照样存得进去,不算写坏', async () => {
    const edits = { ...EMPTY_EDITS, endYear: 500 };
    const offer = await offerOf(edits, 'b');
    const req = { id: 'wsweep12', recipe: makeSave(PARAMS, edits, check), recipeKey: offer.recipe, parts: offer.parts, made: { app: 'x', generator: GENERATOR_VERSION, commit: 'c', at: '2026-11-04T00:00:00.000Z' }, readers: { ...READER_VERSIONS } };
    let done = false;
    const sweeping = (async () => {
      for (let i = 0; i < 8 && !done; i++) await sweepParts(0);
    })();
    const out = await commitWorld(req).finally(() => (done = true));
    await sweeping;
    expect(out.status).toBe('saved');
    expect((await readRevision('wsweep12'))!.parts.length).toBe(offer.parts.length);
    expect(await sweepParts(0)).toBe(0);
  });
});

describe('一个世界存成文件', () => {
  it('写满了,只改了名、写了 AI 正文(同一段历史):现在的样子都在文件里,不落后', async () => {
    const id = await makeWorld('甲');
    const stop = fillUp();
    openWorld(id);
    setEdits({ ...getEdits(), names: { 'polity:c1#0': '只在页面里' } });
    putNote(id, { key: '史书:新', kind: '史书', title: '新', text: '写满以后写的', createdAt: '2026-11-04T09:00:00.000Z', provider: 'p', model: 'm' });
    const out = await saveWorldFile(id);
    stop();
    if (!out.ok) throw new Error(out.message);
    expect(out.stale).toBe(false);
    const f = await looks(out.file);
    expect(f.save.edits.names['polity:c1#0']).toBe('只在页面里');
    expect(f.author?.notes.map((n) => n.key)).toEqual(['史书:新']);
    // 没写进仓库、也没写坏
    expect((await readRevision(id))!.manifest.recipe.edits.names).toEqual({});
  });

  it('localStorage 也满了:存档写不进去,页面里的改动照样在文件里', async () => {
    const id = await makeWorld('甲');
    const stop = fillUp();
    openWorld(id);
    vi.spyOn(g.localStorage!, 'setItem').mockImplementation(() => {
      throw Object.assign(new Error('满了'), { name: 'QuotaExceededError' });
    });
    setEdits({ ...getEdits(), names: { 'polity:c1#0': '只在页面里' } });
    expect(saveStore.currentUnsaved()).toBe(true);
    expect(saveStore.loadWorld(id)!.save.edits.names).toEqual({});
    const out = await saveWorldFile(id);
    stop();
    if (!out.ok) throw new Error(out.message);
    expect(out.stale).toBe(false);
    expect((await looks(out.file)).save.edits.names['polity:c1#0']).toBe('只在页面里');
  });

  it('写满了,历史也变了:用页面里的世界打包(线程只打,不存),新的历史在文件里', async () => {
    const id = await makeWorld('甲');
    const old = await readRevision(id);
    const stop = fillUp();
    const sim = simThatPacks();
    setWorldStoreSim(sim);
    openWorld(id);
    const edits = { ...getEdits(), endYear: 500, interventions: [{ kind: 'protect', a: 'c1#0', from: 10, until: 20 }] } as WorldEdits;
    setEdits(edits);
    const out = await saveWorldFile(id);
    stop();
    if (!out.ok) throw new Error(out.message);
    expect(out.stale).toBe(false);
    expect(sim.asks.length).toBe(1);
    expect(sim.asks[0]).toMatchObject({ params: PARAMS, interventions: edits.interventions });
    const f = await looks(out.file);
    expect(f.save.edits.interventions).toEqual(edits.interventions);
    expect(f.content).not.toBe(old!.head.content);
    expect(f.manifest.made.generator).toBe(GENERATOR_VERSION);
    expect(f.manifest.revision.n).toBe(old!.head.n + 1);
    // 接在存下的那份后面;仓库里还是原来的
    expect((await readRevision(id))!.head.n).toBe(old!.head.n);
  });

  it('从没存进去的世界(写满了、localStorage 也写不进去):线程打的内容照样出文件,干净的浏览器打得开', async () => {
    const stop = fillUp();
    vi.spyOn(g.localStorage!, 'setItem').mockImplementation(() => {
      throw Object.assign(new Error('满了'), { name: 'QuotaExceededError' });
    });
    setWorldStoreSim(simThatPacks());
    const id = saveStore.newWorldId();
    openWorld(id, { ...EMPTY_EDITS, names: { 'polity:c1#0': '从没存下' } });
    saveStore.markCreated();
    expect(saveStore.loadWorld(id)).toBeNull();
    const out = await saveWorldFile(id);
    stop();
    vi.restoreAllMocks();
    if (!out.ok) throw new Error(out.message);
    expect(out.stale).toBe(false);
    expect(out.name.endsWith('.civworld')).toBe(true);
    g.localStorage = new FakeStorage();
    g.indexedDB = new IDBFactory();
    _resetVault();
    saveStore._resetForTest();
    const kept = await keepWorldFile(asLooked(await lookWorldFile(out.file)));
    if (!kept.ok) throw new Error(kept.message);
    expect(saveStore.loadWorld(kept.id)!.save.edits.names['polity:c1#0']).toBe('从没存下');
  });

  it('内存不够打不了:有上次存下的就给它,说清楚落后了、为什么;没有就报 memory,不说文件坏了', async () => {
    const memory = (): WorldStoreSim => ({ busy: () => false, packNow: () => {}, packParts: () => Promise.reject(Object.assign(new Error('内存不够'), { kind: 'memory' })) });
    const id = await makeWorld();
    const stop = fillUp();
    setWorldStoreSim(memory());
    openWorld(id);
    setEdits({ ...getEdits(), endYear: 500 });
    const out = await saveWorldFile(id);
    if (!out.ok) throw new Error(out.message);
    expect(out.stale).toBe(true);
    expect(out.behind).toBe('memory');
    expect((await looks(out.file)).save.edits.endYear).not.toBe(500);

    const nid = saveStore.newWorldId();
    openWorld(nid);
    saveStore.markCreated();
    const none = await saveWorldFile(nid);
    stop();
    expect(none.ok).toBe(false);
    expect(!none.ok && none.kind).toBe('memory');
  });

  it('正开着的世界还没转进来、页面里又改过:转的线程按存下的存档装的文件不算数,用页面里的', async () => {
    const edits = { ...EMPTY_EDITS, endYear: 200 };
    const id = saveStore.importSave(makeSave(PARAMS, edits, check, '有原件的'))!;
    const stored = saveStore.loadWorld(id)!;
    const o = await offerOf(edits);
    await results.put({ id, generator: GENERATOR_VERSION, app: 'x', at: '2026-11-04T00:00:00.000Z', snapshot: { format: SNAPSHOT_FORMAT, generator: GENERATOR_VERSION, recipe: await recipeKey(recipeOfSave(stored.save)), formation: false, parts: o.parts.filter((p) => p.name === 'map' || p.name === 'civ').map((p) => ({ ...p, data: p.data.slice(0) })) } }, { id, generator: GENERATOR_VERSION, recipe: await recipeKey(recipeOfSave(stored.save)), sums: '', size: 1, at: '2026-11-04T00:00:00.000Z' });
    const stop = fillUp();
    const sim = simThatPacks();
    setWorldStoreSim(sim);
    vi.spyOn(g.localStorage!, 'setItem').mockImplementation(() => {
      throw Object.assign(new Error('满了'), { name: 'QuotaExceededError' });
    });
    openWorld(id);
    setEdits({ ...getEdits(), endYear: 500 });
    expect(saveStore.currentUnsaved()).toBe(true);
    const out = await saveWorldFile(id);
    stop();
    if (!out.ok) throw new Error(out.message);
    expect(out.stale).toBe(false);
    expect(sim.asks.length).toBe(1);
    expect((await looks(out.file)).save.edits.endYear).toBe(500);
  });

  it('正开着的世界用了推演插件:打页面里的内容(存成文件、腾出地方补存)带着插件;本机对不上的不打', async () => {
    const id = await makeWorld('插件世界');
    const sim = simThatPacks();
    setWorldStoreSim({ ...sim, sims: () => simsOf(saveStore.currentWorld()?.id) });
    const file = { id: 'weariness', sum: 'a'.repeat(64), bytes: new Uint8Array([1, 2]), params: { k: 2 } };
    const list = [{ id: 'weariness', version: '1.0.0', sum: file.sum, role: 'sim', name: '厌战', params: { k: 2 } }];
    try {
      setSimNow({ id, list, files: [file], checks: [] });
      const save = saveStore.loadWorld(id)!.save;
      await packPage(save);
      expect((sim.asks[0] as { simPlugins?: unknown }).simPlugins).toEqual([file]);
      setSimNow({ id, list, files: null, checks: [{ id: 'weariness', plugin: list[0], status: 'missing' }] });
      expect(packPage(save)).toBeNull();
      setSimNow({ id: 'another', list, files: [file], checks: [] });
      await packPage(save);
      expect((sim.asks[1] as { simPlugins?: unknown }).simPlugins).toBeUndefined();
    } finally {
      setSimNow(null);
    }
  });

  it('以它为底稿新建、用了推演插件的世界建好马上存进仓库,带着推演插件的记录;推演重推了的不抢着存', async () => {
    const id = saveStore.newWorldId();
    openWorld(id);
    saveStore.markCreated();
    const file = { id: 'weariness', sum: 'a'.repeat(64), bytes: new Uint8Array([1, 2]), params: { k: 2 } };
    const list = [{ id: 'weariness', version: '1.0.0', sum: file.sum, role: 'sim', name: '厌战', params: { k: 2 } }];
    const sim = simThatPacks();
    setWorldStoreSim({ ...sim, packParts: async (ask) => ({ ...(await sim.packParts!(ask)), plugins: list }), sims: () => simsOf(saveStore.currentWorld()?.id) });
    try {
      setSimNow({ id, list, files: [file], checks: [] });
      await keepCarried(id);
      expect(await latestOf(id)).toBeNull();
      await keepCarried(id, true);
      const head = (await readRevision(id))!;
      expect(head.manifest.plugins?.map((x) => [x.id, x.role])).toEqual([['weariness', 'sim']]);
      expect(head.manifest.parts.some((x) => x.name === 'civ')).toBe(true);
      const n = head.head.n;
      await keepCarried(id, true);
      expect((await readRevision(id))!.head.n).toBe(n);
    } finally {
      setSimNow(null);
    }
  });

  it('没开着的世界,内容从没存进去:现算一遍,写不下就直接装成文件;写得下的还是存进去', async () => {
    const id = saveStore.importSave(makeSave(PARAMS, { ...EMPTY_EDITS, endYear: 200 }, check, '没开着'))!;
    saveStore.detachWorld();
    const stop = fillUp();
    const out = await saveWorldFile(id);
    stop();
    if (!out.ok) throw new Error(out.message);
    expect(out.stale).toBe(false);
    const f = await looks(out.file);
    expect(f.save.title).toBe('没开着');
    expect(await latestOf(id)).toBeNull();
    const again = await saveWorldFile(id);
    expect(again.ok && again.stale).toBe(false);
    expect(await latestOf(id)).not.toBeNull();
  });

  it('没建完的、没开着也算不出来的(更旧的版本):照旧分开报', async () => {
    const id = saveStore.newWorldId();
    openWorld(id, EMPTY_EDITS, 'draft');
    const draft = await saveWorldFile(id);
    expect(!draft.ok && draft.kind).toBe('draft');
    saveStore.detachWorld();
    const old = saveStore.importSave({ ...makeSave(PARAMS, EMPTY_EDITS, check, '旧'), generator: 1 } as SaveFile)!;
    saveStore.detachWorld();
    const out = await saveWorldFile(old);
    expect(!out.ok && out.kind).toBe('old');
  });
});

describe('用了推演插件、本机对不上时线程交回的内容', () => {
  it('插件被删了、网站关了插件,打开时按配方重推出来的(没带插件)不存:世界记的推演插件和历史照留;对得上时照常存', async () => {
    const list = [{ id: 'weariness', version: '1.0.0', sum: 'a'.repeat(64), role: 'sim', name: '厌战' }];
    const file = { id: 'weariness', sum: list[0].sum, bytes: new Uint8Array([1, 2]) };
    setWorldStoreSim({ ...simThatPacks(), sims: () => simsOf(saveStore.currentWorld()?.id) });
    try {
      const id = saveStore.newWorldId();
      openWorld(id);
      saveStore.markCreated();
      setSimNow({ id, list, files: [file], checks: [] });
      expect(await offerWorldParts({ ...(await offerOf(getEdits())), plugins: list })).toBe(true);
      const kept = (await readRevision(id))!;
      // 插件删了(或网站关了插件)以后再打开:推演不带文件
      setSimNow({ id, list, files: null, checks: [{ id: 'weariness', plugin: list[0], status: 'missing' }], stored: true });
      expect(await offerWorldParts({ ...(await offerOf(getEdits(), 'official')), plugins: [] })).toBe(false);
      const now = (await readRevision(id))!;
      expect(now.head.n).toBe(kept.head.n);
      expect(now.manifest.plugins?.map((x) => [x.id, x.role])).toEqual([['weariness', 'sim']]);
      // 装回来:照常存
      setSimNow({ id, list, files: [file], checks: [], stored: true });
      expect(await offerWorldParts({ ...(await offerOf(getEdits(), 'again')), plugins: list })).toBe(true);
      expect((await readRevision(id))!.manifest.plugins?.map((x) => x.id)).toEqual(['weariness']);
    } finally {
      setSimNow(null);
      setWorldStoreSim(simThatPacks());
    }
  });
});

describe('全部存成文件', () => {
  it('当前世界用页面里的,别的用存的;存不上的世界说得清', async () => {
    const stored = await makeWorld('存好的');
    const old = saveStore.importSave({ ...makeSave(PARAMS, EMPTY_EDITS, check, '旧的'), generator: 1 } as SaveFile)!;
    const open = await makeWorld('开着的');
    const stop = fillUp();
    setWorldStoreSim(simThatPacks());
    openWorld(open);
    const edits = { ...getEdits(), endYear: 500 };
    setEdits(edits);
    const out = await saveAllWorldFiles();
    stop();
    if (!out.ok) throw new Error(out.message);
    expect(out.whole).toBe(2);
    expect(out.behind).toEqual([]);
    expect(out.left).toEqual([{ id: old, title: '旧的', kind: 'old' }]);
    expect(out.recipeOnly).toEqual([old]);
    const { entries } = await walkZip(out.files[0].file);
    const dir = (id: string) => entries.filter((e) => e.name.startsWith(`worlds/${id}/`));
    expect(dir(stored).length).toBe(1);
    expect(dir(open).length).toBe(2);
    expect(entries.some((e) => e.name === 'recipes.json')).toBe(true);
    const last = dir(open).at(-1)!;
    expect((await looks(last.data)).save.edits.endYear).toBe(500);
  });

  it('打不了的世界不挡着别的:只带配方,说得清是内存不够', async () => {
    const stored = await makeWorld('存好的');
    const nid = saveStore.newWorldId();
    const stop = fillUp();
    setWorldStoreSim({ busy: () => false, packNow: () => {}, packParts: () => Promise.reject(Object.assign(new Error('内存不够'), { kind: 'memory' })) });
    openWorld(nid);
    saveStore.markCreated();
    const out = await saveAllWorldFiles();
    stop();
    if (!out.ok) throw new Error(out.message);
    expect(out.whole).toBe(1);
    expect(out.left.map((x) => [x.id, x.kind])).toEqual([[nid, 'memory']]);
    expect((await walkZip(out.files[0].file)).entries.some((e) => e.name.startsWith(`worlds/${stored}/`))).toBe(true);
  });

  it('库打不开、读不了留底的旧修订:手上打好的世界照样带着', async () => {
    const nid = saveStore.newWorldId();
    const stop = fillUp();
    vi.spyOn(g.localStorage!, 'setItem').mockImplementation(() => {
      throw Object.assign(new Error('满了'), { name: 'QuotaExceededError' });
    });
    setWorldStoreSim(simThatPacks());
    openWorld(nid);
    saveStore.markCreated();
    _setWorldStore({
      caller: ((op: keyof VaultOps, args: unknown[]) => (op === 'revisionsOf' || op === 'latestOf' || op === 'stateOf' ? Promise.reject(Object.assign(new Error('打不开'), { kind: 'full' })) : (vaultOps[op] as (...a: unknown[]) => Promise<unknown>)(...args))) as never,
    });
    setWorldStoreSim(simThatPacks());
    const out = await saveAllWorldFiles();
    stop();
    if (!out.ok) throw new Error(out.message);
    expect(out.whole).toBe(1);
    expect(out.left).toEqual([]);
    expect((await walkZip(out.files[0].file)).entries.some((e) => e.name.startsWith(`worlds/${nid}/`))).toBe(true);
  });

  it('落后的世界在 behind 里,配方另带一份;一次都没存进去的开着的世界也带上', async () => {
    const stored = await makeWorld('存好的');
    const stop = fillUp();
    setWorldStoreSim({ busy: () => false, packNow: () => {}, packParts: () => Promise.reject(Object.assign(new Error('满'), { kind: 'memory' })) });
    openWorld(stored);
    setEdits({ ...getEdits(), endYear: 500 });
    const out = await saveAllWorldFiles();
    stop();
    if (!out.ok) throw new Error(out.message);
    expect(out.whole).toBe(1);
    expect(out.behind.map((x) => [x.id, x.kind])).toEqual([[stored, 'memory']]);
    expect((await walkZip(out.files[0].file)).entries.some((e) => e.name === 'recipes.json')).toBe(true);
    expect(out.recipeOnly).toEqual([]);

    // 开着的世界一次都没存进去(不在列表里),页面里打得出来
    vi.spyOn(g.localStorage!, 'setItem').mockImplementation(() => {
      throw Object.assign(new Error('满了'), { name: 'QuotaExceededError' });
    });
    const again = fillUp();
    setWorldStoreSim(simThatPacks());
    const nid = saveStore.newWorldId();
    openWorld(nid, { ...EMPTY_EDITS, endYear: 200 });
    saveStore.markCreated();
    expect(saveStore.loadWorld(nid)).toBeNull();
    expect(saveStore.currentUnsaved()).toBe(true);
    const all = await saveAllWorldFiles();
    again();
    if (!all.ok) throw new Error(all.message);
    expect((await walkZip(all.files[0].file)).entries.some((e) => e.name.startsWith(`worlds/${nid}/`))).toBe(true);
    expect(all.whole).toBe(2);
  });
});

// ---------------------------------------------------------------------------

/** 还能存的只有 room 字节 */
function estimateRoom(room: number) {
  vi.stubGlobal('navigator', { storage: { estimate: () => Promise.resolve({ usage: 1e9, quota: 1e9 + room }) } });
}

/** 让后台排着的做完 */
const later = async (ms = 30) => {
  await new Promise((r) => setTimeout(r, ms));
  await _settled();
  await new Promise((r) => setTimeout(r, ms));
};

describe('删掉的世界尽快腾地方', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 删一个世界,像提示条那样拿着记号 */
  async function trashed(title = '删的') {
    const id = await makeWorld(title);
    const keep = await makeWorld('留着的');
    openWorld(keep);
    const gone = saveStore.deleteWorld(id)!;
    const hold = holdWorld(id);
    const free = () => {
      hold();
      trashFreed(id);
    };
    return { id, keep, gone, free };
  }

  it('平时:提示收起也不清,留着 30 天', async () => {
    estimateRoom(NEAR_FULL_BYTES * 2);
    const { id, free } = await trashed();
    free();
    await later();
    expect(await latestOf(id)).not.toBeNull();
    expect(id in saveStore.trashMarks()).toBe(true);
  });

  it('快满了:提示开着绝不清,收起马上清;别的世界一点没动', async () => {
    estimateRoom(NEAR_FULL_BYTES / 2);
    const { id, keep, free } = await trashed();
    await later();
    expect(await latestOf(id)).not.toBeNull();
    const cl = await clearTrashNow();
    expect(cl.cleared).toEqual([]);
    expect(cl.kept).toEqual([id]);
    expect(await latestOf(id)).not.toBeNull();
    free();
    await later();
    expect(await latestOf(id)).toBeNull();
    expect(id in saveStore.trashMarks()).toBe(false);
    expect(await latestOf(keep)).not.toBeNull();
    expect((await readRevision(keep))!.parts.length).toBeGreaterThan(0);
  });

  it('提示开着时撤销:世界完整回来,内容、存档都在,收起也不清', async () => {
    estimateRoom(NEAR_FULL_BYTES / 2);
    const { id, gone, free } = await trashed();
    const before = await readRevision(id);
    expect(saveStore.restoreWorld(gone)).toBe(true);
    free();
    await later();
    expect(saveStore.loadWorld(id)).not.toBeNull();
    expect(id in saveStore.trashMarks()).toBe(false);
    const after = await readRevision(id);
    expect(after!.head).toEqual(before!.head);
    expect(after!.parts.length).toBe(before!.parts.length);
  });

  it('写满过(问不到还能存多少也算):提示收起就清', async () => {
    vi.stubGlobal('navigator', {});
    const { id, free } = await trashed();
    const stop = fillUp();
    const nid = saveStore.newWorldId();
    openWorld(nid);
    saveStore.markCreated();
    expect(await offerWorldParts(await offerOf(getEdits(), 'new'))).toBe(false);
    stop();
    await later();
    // 写不下时也清能清的,提示开着的不算
    expect(await latestOf(id)).not.toBeNull();
    free();
    await later();
    expect(await latestOf(id)).toBeNull();
  });

  it('写不下时清掉不再要的,但不抢别的标签页的:那边提示开着、那边开着它', async () => {
    const { id, free } = await trashed();
    free();
    // 别的标签页拿着(同一份锁)
    const other = await makeWorld('别的标签页开着');
    openWorld(await makeWorld('这边'));
    saveStore.deleteWorld(other);
    let release = () => {};
    void locks.request(`civ-atlas:world-hold:${other}`, { mode: 'shared' }, () => new Promise<void>((r) => (release = r)));
    await later();
    const cl = await clearTrashNow();
    expect(cl.cleared).toEqual([id]);
    expect(cl.kept).toEqual([other]);
    expect(await latestOf(other)).not.toBeNull();
    const info = await trashInfo();
    expect(info.count).toBe(1);
    expect(info.held).toBe(1);
    release();
    await later();
    expect((await clearTrashNow()).cleared).toEqual([other]);
    expect(await latestOf(other)).toBeNull();
  });

  it('别的标签页拿着,那边关了不会告诉这边:存储紧张时隔一会儿自己再看;不紧张了就不清', async () => {
    estimateRoom(NEAR_FULL_BYTES / 2);
    _setWorldStore({ timing: { holdRetry: 30 } });
    const id = await makeWorld('别的标签页开着');
    openWorld(await makeWorld('这边'));
    saveStore.deleteWorld(id);
    trashFreed(id);
    let release = () => {};
    void locks.request(`civ-atlas:world-hold:${id}`, { mode: 'shared' }, () => new Promise<void>((r) => (release = r)));
    await later(5);
    expect((await clearTrashNow()).kept).toEqual([id]);
    expect(await latestOf(id)).not.toBeNull();
    release();
    for (let i = 0; i < 40 && (await latestOf(id)); i++) await later(10);
    expect(await latestOf(id)).toBeNull();

    // 不紧张了:拿着的放开也不清
    estimateRoom(NEAR_FULL_BYTES * 2);
    const other = await makeWorld('另一个');
    openWorld(await makeWorld('又一个'));
    saveStore.deleteWorld(other);
    void locks.request(`civ-atlas:world-hold:${other}`, { mode: 'shared' }, () => new Promise<void>((r) => (release = r)));
    await later(5);
    expect((await clearTrashNow()).kept).toEqual([other]);
    release();
    await later(80);
    expect(await latestOf(other)).not.toBeNull();
    _setWorldStore({ timing: { holdRetry: 60_000 } });
  });

  it('删了还不到一会儿的先不清(别的标签页可能还没拿到手),到了再清', async () => {
    _setWorldStore({ timing: { holdGap: 60 } });
    estimateRoom(NEAR_FULL_BYTES / 2);
    const id = await makeWorld('刚删的');
    openWorld(await makeWorld('这边'));
    saveStore.deleteWorld(id);
    trashFreed(id);
    const first = await clearTrashNow();
    expect(first.kept).toEqual([id]);
    await later(120);
    expect(await latestOf(id)).toBeNull();
    _setWorldStore({ timing: { holdGap: 0 } });
  });

  it('看不到别的标签页(没有 Web Locks):只清删了超过一小时的', async () => {
    _setHolds({ locks: null });
    const id = await makeWorld('刚删的');
    const old = await makeWorld('早删的');
    openWorld(await makeWorld('这边'));
    saveStore.deleteWorld(id);
    saveStore.deleteWorld(old);
    const marks = saveStore.trashMarks();
    marks[old] = Date.now() - 2 * 3600_000;
    g.localStorage!.setItem(saveStore.TRASH, JSON.stringify(marks));
    const cl = await clearTrashNow();
    expect(cl.cleared).toEqual([old]);
    expect(cl.kept).toEqual([id]);
    expect(await latestOf(id)).not.toBeNull();
    expect(await latestOf(old)).toBeNull();
  });

  it('别的世界的地图还要从它这里拿:不清', async () => {
    const id = await makeWorld('有地图的');
    const edits = { ...EMPTY_EDITS, map: { sum: 'abc', from: id, grown: GENERATOR_VERSION } } as WorldEdits;
    const child = saveStore.importSave(makeSave(PARAMS, edits, check, '地图留着的'))!;
    openWorld(await makeWorld('这边'));
    saveStore.deleteWorld(id);
    expect(saveStore.loadWorld(child)).not.toBeNull();
    const cl = await clearTrashNow();
    expect(cl.kept).toContain(id);
    expect(await latestOf(id)).not.toBeNull();
  });

  it('每个世界占多少:共用的块每行都算,总数只算一次,原件加上;块的大小记下来', async () => {
    const a = await makeWorld('甲');
    const b = await makeWorld('乙');
    const none = await spaceBoard();
    expect(none!.worlds[a]).toBeGreaterThan(0);
    expect(none!.worlds[a]).toBe(none!.worlds[b]);
    // 两个世界用一样的块
    expect(none!.total).toBe(none!.worlds[a]);
    expect(none!.bigger).toBe(true);
    await results.put({ id: a, generator: GENERATOR_VERSION, app: 'x', at: '2026-11-04T00:00:00.000Z', snapshot: { format: 1, generator: GENERATOR_VERSION, recipe: 'r', formation: false, parts: [] } }, { id: a, generator: GENERATOR_VERSION, recipe: 'r', sums: '', size: 1000, at: '2026-11-04T00:00:00.000Z' });
    const withOriginal = await spaceBoard();
    expect(withOriginal!.worlds[a]).toBe(none!.worlds[a] + 1000);
    expect(withOriginal!.worlds[b]).toBe(none!.worlds[b]);
    expect(withOriginal!.total).toBe(none!.total + 1000);
    expect(Object.keys(withOriginal!.worlds).sort()).toEqual([a, b].sort());
    const memo = await vaultCall('stateOf', ['#part-sizes']);
    expect(Object.keys(memo!.sizes!).length).toBeGreaterThan(0);
  });

  it('只是 AI 正文写不进去:说满了,不标这个世界没存上;再写成就不说了', async () => {
    const a = await makeWorld('甲');
    let full = true;
    _setWorldStore({
      caller: ((op: keyof VaultOps, args: never[]) => {
        if (op === 'changeAuthor' && full) return Promise.reject(asVaultError(new DOMException('full', 'QuotaExceededError')));
        return (vaultOps[op] as (...x: never[]) => unknown)(...args);
      }) as never,
    });
    await expect(notesVault.change(a, [])).rejects.toBeTruthy();
    expect(vaultIsFull()).toBe(true);
    expect(await fullWorldIds()).toEqual([]);
    full = false;
    await notesVault.change(a, []);
    expect(vaultIsFull()).toBe(false);
  });

  it('哪些世界上次写不下:写成功一次就划掉;删掉的不算', async () => {
    const a = await makeWorld('甲');
    const b = await makeWorld('乙');
    await vaultCall('patchState', [a, { full: 1 }]);
    await vaultCall('patchState', [b, { full: 2 }]);
    expect((await fullWorldIds()).sort()).toEqual([a, b].sort());
    await vaultCall('patchState', [a, { full: undefined }]);
    expect(await fullWorldIds()).toEqual([b]);
    saveStore.deleteWorld(b);
    expect(await fullWorldIds()).toEqual([]);
  });

  it('占多少、几个、哪天清掉:共用的块不算,原件算上;没内容的不算;「现在清掉」真的腾出来', async () => {
    const a = await makeWorld('甲');
    const b = await makeWorld('乙');
    const keep = await makeWorld('留着的');
    await results.put({ id: a, generator: GENERATOR_VERSION, app: 'x', at: '2026-11-04T00:00:00.000Z', snapshot: { format: 1, generator: GENERATOR_VERSION, recipe: 'r', formation: false, parts: [] } }, { id: a, generator: GENERATOR_VERSION, recipe: 'r', sums: '', size: 1000, at: '2026-11-04T00:00:00.000Z' });
    const draft = saveStore.newWorldId();
    openWorld(draft);
    saveStore.markCreated();
    openWorld(keep);
    saveStore.deleteWorld(a);
    saveStore.deleteWorld(b);
    saveStore.deleteWorld(draft);
    // 三个世界用一样的块:都是「留着的」也在用的,清掉腾不出来
    const shared = await trashInfo();
    expect(shared.count).toBe(2);
    expect(shared.bytes).toBe(1000);
    expect(shared.held).toBe(0);
    const now = Date.now();
    expect(shared.clearBy).toBeGreaterThan(now + TRASH_KEEP_MS - 60_000);
    expect(shared.clearBy).toBeLessThanOrEqual(now + TRASH_KEEP_MS);
    // 换一份历史,独占的块才算
    const c = await makeWorld('丙');
    expect(await offerWorldParts(await offerOf(getEdits(), 'only-c'))).toBe(true);
    const sized = (await readRevision(c))!;
    const civPart = sized.parts.find((p) => p.info.name === 'civ')!;
    openWorld(keep);
    saveStore.deleteWorld(c);
    const info = await trashInfo();
    expect(info.count).toBe(3);
    expect(info.bytes).toBe(1000 + (civPart.data instanceof Uint8Array ? civPart.data.byteLength : (civPart.data as ArrayBuffer).byteLength));
    const cl = await clearTrashNow();
    expect(new Set(cl.cleared)).toEqual(new Set([a, b, c, draft]));
    expect(await trashInfo()).toEqual({ count: 0, bytes: 0, clearBy: null, held: 0, ids: [] });
    expect(await resultHeads(a)).toEqual([]);
    // 块真的没了,留着的世界的还在
    expect(await readRevision(keep)).not.toBeNull();
    expect(await spaceOf([keep])).toEqual({ bytes: expect.any(Number), have: [keep] });
    expect(await sweepParts(0)).toBe(0);
  });

  it('打开文件放进来的半路(先记成删掉的世界):不会被当成删掉的世界清掉', async () => {
    const id = await makeWorld('有内容的');
    const file = (await revisionFile(id))!;
    const looked = asLooked(await lookWorldFile(file));
    const seen: string[] = [];
    _setWorldFiles({
      once: ((op: keyof VaultOps, args: unknown[]) => {
        if (op !== 'adoptFile') return (vaultOps[op] as (...a: unknown[]) => Promise<unknown>)(...args);
        // 收文件的这一会儿,存储紧张开始清了
        return (vaultOps.adoptFile as (...a: unknown[]) => Promise<unknown>)(...args).then(async (r) => {
          seen.push(...(await clearTrashNow()).kept);
          return r;
        });
      }) as never,
      look: (f) => lookFile(f, OPEN),
    });
    const kept = await keepWorldFile(looked);
    if (!kept.ok) throw new Error(kept.message);
    expect(seen).toContain(kept.id);
    expect(await latestOf(kept.id)).not.toBeNull();
    expect(saveStore.loadWorld(kept.id)).not.toBeNull();
    expect(kept.id in saveStore.trashMarks()).toBe(false);
  });

  it('转存的时候被删了:等转完再清,不留没人认的内容', async () => {
    estimateRoom(NEAR_FULL_BYTES / 2);
    const id = saveStore.importSave(makeSave(PARAMS, { ...EMPTY_EDITS, endYear: 200 }, check, '转着的'))!;
    saveStore.detachWorld();
    let finish = () => {};
    const gate = new Promise<void>((r) => (finish = r));
    const run = runnerOf();
    _setWorldStore({ runner: (job) => ({ done: gate.then(() => run(job).done), stop: () => {} }) });
    const saving = saveWorldFile(id);
    await later();
    saveStore.deleteWorld(id);
    expect((await clearTrashNow()).kept).toContain(id);
    finish();
    await saving;
    await later();
    expect(await latestOf(id)).toBeNull();
    expect(id in saveStore.trashMarks()).toBe(false);
  });

  it('腾出地方后接着存:正开着的世界线程重打一份,没转进来的世界再转', async () => {
    const stopStore = startWorldStore();
    const sim = simThatPacks();
    setWorldStoreSim(sim);
    const id = await makeWorld('删的');
    const open = await makeWorld('开着的');
    const waiting = saveStore.importSave(makeSave(PARAMS, { ...EMPTY_EDITS, endYear: 200 }, check, '等着转的'))!;
    const stop = fillUp();
    openWorld(open);
    setEdits({ ...getEdits(), endYear: 500 });
    expect(await offerWorldParts(await offerOf(getEdits(), 'new'))).toBe(false);
    expect((await latestOf(open))!.n).toBe(1);
    saveStore.deleteWorld(id);
    const free = holdWorld(id);
    await later();
    expect(await latestOf(id)).not.toBeNull();
    stop();
    free();
    trashFreed(id);
    for (let i = 0; i < 100 && (!(await latestOf(waiting)) || (await latestOf(open))!.n < 2); i++) await later(20);
    expect(await latestOf(id)).toBeNull();
    expect((await latestOf(open))!.n).toBe(2);
    expect((await readRevision(open))!.manifest.recipe.edits.endYear).toBe(500);
    expect(await latestOf(waiting)).not.toBeNull();
    expect(sim.asks.length).toBeGreaterThan(0);
    stopStore();
  });

  it('什么也没腾出来:不反复试', async () => {
    const stopStore = startWorldStore();
    const sim = simThatPacks();
    setWorldStoreSim(sim);
    const open = await makeWorld('开着的');
    const stop = fillUp();
    openWorld(open);
    setEdits({ ...getEdits(), endYear: 500 });
    expect(await offerWorldParts(await offerOf(getEdits(), 'new'))).toBe(false);
    await later(60);
    expect(sim.asks.length).toBe(0);
    stop();
    stopStore();
  });
});

describe('不让清的记号(worldHolds)', () => {
  it('拿着的时候清不了;放开两次也没事;别的标签页拿着也算', async () => {
    const free = holdWorld('w1');
    let ran = 0;
    expect(await ifNotHeld('w1', async () => void ran++)).toBe(false);
    expect(await isHeld('w1')).toBe(true);
    const free2 = holdWorld('w1');
    free();
    free();
    expect(await isHeld('w1')).toBe(true);
    free2();
    await later(5);
    expect(await isHeld('w1')).toBe(false);
    expect(await ifNotHeld('w1', async () => void ran++)).toBe(true);
    expect(ran).toBe(1);
    // 只有别的标签页拿着
    let release = () => {};
    void locks.request('civ-atlas:world-hold:w2', { mode: 'shared' }, () => new Promise<void>((r) => (release = r)));
    await later(5);
    expect(await isHeld('w2')).toBe(true);
    expect(await ifNotHeld('w2', async () => void ran++)).toBe(false);
    release();
  });
});

describe('提示条没了要告诉一声(onGone)', () => {
  it('到时收起、被关掉都算;换成别的来源的不算;被同来源新提示盖住时收尾接给新提示;只调一次', async () => {
    let gone = 0;
    showToast({ id: 'a', kind: 'ok', text: '一', ttl: 10, onGone: () => gone++ });
    await new Promise((r) => setTimeout(r, 30));
    expect(gone).toBe(1);
    showToast({ id: 'a', kind: 'ok', text: '二', onGone: () => gone++ });
    clearToast('a');
    clearToast('a');
    expect(gone).toBe(2);
    showToast({ id: 'a', kind: 'ok', text: '三', onGone: () => gone++ });
    showToast({ id: 'b', kind: 'warn', text: '别的' });
    expect(gone).toBe(2);
    // 新提示没写 onGone:旧收尾接给它,「撤销」这类机会不因一次同来源替换提前消失
    showToast({ id: 'a', kind: 'ok', text: '四' });
    expect(gone).toBe(2);
    expect(peekToast('a')?.text).toBe('四');
    clearToast('a');
    expect(gone).toBe(3);
    // 新提示显式写了 onGone = 调用方明确接管这个来源,旧提示就地收尾
    showToast({ id: 'a', kind: 'ok', text: '五', onGone: () => gone++ });
    showToast({ id: 'a', kind: 'ok', text: '六', onGone: () => gone++ });
    expect(gone).toBe(4);
    clearToast('a');
    expect(gone).toBe(5);
  });
});
