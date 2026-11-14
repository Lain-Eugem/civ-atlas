/**
 * 主线程这边的世界仓库(../worldVault.ts):什么时候存、存哪个世界、现有的世界怎么转进来。
 *
 * 打开世界先读这里存的内容(../worldOpen.ts,生成世界的线程直接读),读不出来退回旧的路(saveStore 的存档、resultStore 的原件),所以旧的存档和原件照写。
 * 这里任何一步出错都只记下来、不往外抛,不提示,也不碰存档和原件。字节全程在后台线程里,主线程只发消息。
 *
 * 什么时候存:
 * - 推完、改完:生成世界的线程把这次的内容打好交回来(offerWorldParts),对得上这个世界存着的存档才存,对不上的先放着(和原件同样的规矩)。
 *   块按内容存,重推只会写变了的块;逐年推演不每步都存(线程那边停够了才打),页面藏起来、要关时叫线程马上打(packNow)
 * - 只改了配方以外的东西(改名、改旗、换投影、换了封面):停 LIGHT_DELAY 毫秒写一份新清单,只有封面变了才写块。
 *   换世界、页面藏起来、要关时马上写。配方变了(历史要重推)的不写:那是待完成的修改,等推完。
 *   没来得及写的(关得太快、在「我的世界」里改的别的世界),下次打开转存那一遍会补上
 * - AI 写的正文不走这里:ai/libraryVault.ts 一有改动就写进仓库的 author 块(changeAuthor),这里存世界时不带作者内容,仓库沿用最新的那块。
 *   转存那一遍顺手把 localStorage 里的老正文也转进去(moveNotes)
 *
 * 待完成的修改:存着的修订在仓库里,配方草稿就是存档(saveStore),两边分开放。崩了以后拿两边比(pendingEdit、pendingOf)就知道有没有没推完的修改。
 *
 * 把现有的世界转进来(startConversions):打开页面过一会儿在后台一个一个转,一次一个、一个线程转一个。
 * - 有原件的直接转(用了推演、地图插件的世界不看原件:原件不记插件);没有原件但是当前版本建的,电脑上算一遍,手机上不算(打开时自然就存了);没有原件的更旧版本只记下来(old),不转
 * - 用的人一开始推演就关掉线程让路(写到一半的不算数),闲下来再从这个世界重来;关了页面下次接着转(转完的不再转)
 * - 转失败了记下(failed),这一版软件不再试;转的时候页面崩了(下次打开时还有 CONVERTING 这条记录)也算失败,不然每次打开都崩
 * - 几个标签页同时开着,只有一个转(navigator.locks)
 *
 * 删世界(maintain):只认 saveStore 的 trashMarks,用的人删的、又过了 TRASH_KEEP_MS 才清内容。撤销了、账号里取回来了的不清。
 * 不拿「我的世界」的列表反推:浏览器清了 localStorage、读不出列表时,一个世界也不清。退出登录选了「从这台设备上删掉」时全清(clearWorldStore)。
 * 全清时记一笔(CLEARED),别的标签页看到了就停下正在转的;正好在这时候写完的,这个世界的修订删掉,不留在清过的仓库里。
 *
 * 存储紧张时删掉的世界不等 30 天(drainTrash):写不下了、或者还能存的不到 NEAR_FULL_BYTES 时,撤销提示一收起就清,用的人也可以点「现在清掉」(clearTrashNow)。
 * 这些时候绝不清(worldHolds.ts,几个标签页都算):撤销提示还开着、有标签页正开着它、正在写它。别的世界的地图还要从它这里拿的也不清(keptMap)。
 * 没人点的时候,在名单上过的世界要确定这次删除不能再撤销了才提前清:删除记录可能是撤销以后被回退的(../worldRoster.ts),这种只等 30 天。撤销过的这一次,哪条路都不清。
 * 不删任何还在的世界。腾出了地方就接着存(roomMade):正开着的世界让线程重打一份,别的世界再转一遍。写不下的那一次不重试,等腾出地方。
 *
 * 名单丢了(rescueLostWorlds):仓库里有、名单上没有的世界按 ../worldRoster.ts 的规则认回来。写不进名单就算了,这次打开不再试,也不提示。
 *
 * 存储满了也要存得成文件(worldFiles.ts):settleForFile 让转存的线程写不下时直接交回文件,packPage 让生成世界的线程把页面里的世界打成几块。都不写库。
 *
 * 第一次存世界时申请长期保存(navigator.storage.persist)。Firefox 会弹浏览器自己的询问框,只问一次;Safari、Chromium 不弹,自己定,每次打开问一次。
 */
import { cleanNoteList } from '../authorNotes';
import { copyNotes, exportNotes, flushNotes, notesKnown, notesReady } from '../ai/library';
import { moveNotes, tidyNotes, warmNotes, type NotesVault } from '../ai/libraryVault';
import { stampCalc, worldTuning } from '../gen/civ/ruleSet';
import { GENERATOR_VERSION, civSeedOf, cleanMapRef, keptMapOf, type Intervention, type TerrainOp, type Upheaval, type WorldEdits } from '../gen/edits';
import { READER_VERSIONS } from '../gen/readers/versions';
import { parseSave, type SaveFile } from '../gen/savefile';
import { recipeKey, recipeOfSave, recipeText } from '../gen/snapshot';
import { shapesWorld, type AuthorContent, type WorldMade } from '../gen/worldFormat';
import type { SimPluginsReady } from '../plugin/simPlugins';
import type { MapPluginFile, SimPluginFile } from '../plugin/pluginWorld';
import type { ConvertJob } from '../worldConvert';
import type { ConvertReply } from '../worldConvertWorker';
import { pendingEdit, type CommitRequest, type CommitResult, type DraftedFile, type PendingEdit, type VaultErrorKind, type VaultOps, type WorldPartsOffer } from '../worldVault';
import type { VaultCall, VaultReply } from '../worldVaultWorker';
import { rosterStep, undidThis, type RosterMarks } from '../worldRoster';
import { isCoarse, isNarrow } from './device';
import { dropResults, resultHeads, resultSizes } from './resultStore';
import type { PackAsk } from './sim/simClient';
import { MAX_WORLDS, TRASH, VAULT_CLEARED, allWorldIds, currentWorld, deleteWorld, isStored, listWorlds, loadWorld, markTrash, originalOf, persistent, putSyncedWorld, reportVaultFull, saveAsNewVersion, storageFullWhy, storedCount, subscribe, syncable, trashMarks, unmarkTrash, vaultRoomBack } from './saveStore';
import { NEAR_FULL_BYTES, PERSIST_ASKED, appleDevice, askPersisted, firstHintSaid, isNearFull, noteFirstHint, noteVaultFull, rawRoom, spaceChanged } from './spaceFacts';
import { afterOkToasts, clearToast, showToast } from './toastStore';
import { withFileFlow } from './worldFileLazy';
import { getMapNow } from './world/mapNow';
import { getSimNow } from './world/simNow';
import { pluginsUiOn } from './plugins/flag';
import { APP_COMMIT, APP_VERSION } from './version';
import { canSeeHolds, holdWorld, ifNotHeld, isHeld } from './worldHolds';

/** 改完以后停多久写新清单(毫秒) */
const LIGHT_DELAY = 3000;
/** 用的人删掉的世界,内容留多久(毫秒):和账号里「最近删除」能找回的时间一样 */
export const TRASH_KEEP_MS = 30 * 24 * 3600_000;
/** 这个浏览器看不到别的标签页(没有 Web Locks)时,存储紧张也只清删掉超过这么久的世界(毫秒):别的标签页的撤销提示肯定收起了 */
const FULL_TRASH_AGE = 3600_000;
export { NEAR_FULL_BYTES };

/** 几个时间(毫秒);单测调短 */
const timing = {
  /** 打开页面过多久开始转 */
  convertDelay: 20_000,
  /** 打开页面过多久清理第一次 */
  maintainDelay: 60_000,
  /** 之后多久清理一次 */
  maintainEvery: 3_600_000,
  /** 用的人停下来多久才开始转 */
  quiet: 10_000,
  /** 多久看一次用的人是不是在忙 */
  poll: 1000,
  /** 转完一个歇多久 */
  pause: 1500,
  /** 别的标签页刚删的世界,不让清的记号可能还没拿到手:删了不到这么久的先不清 */
  holdGap: 3000,
  /** 存储紧张、有世界被别的标签页拿着:隔多久再看一眼(那边关了、崩了不会告诉这边) */
  holdRetry: 60_000,
  /** 打开页面过多久对一遍名单和仓库:在清理原件、转存之前 */
  rosterDelay: 3000,
};

/** 转的时候记一下在转谁(页面崩了下次打开看得到) */
const CONVERTING = 'civ-atlas:converting';
const CLEARED = VAULT_CLEARED;

export function clearedAt(): string | null {
  try {
    return localStorage.getItem(CLEARED);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 调仓库(后台线程)

type VaultCaller = <K extends keyof VaultOps>(op: K, args: Parameters<VaultOps[K]>, transfer?: Transferable[]) => Promise<Awaited<ReturnType<VaultOps[K]>>>;

/** 开一个后台线程调仓库;线程出错了,等着的都算失败,下次再开 */
function workerCaller(): VaultCaller {
  let w: Worker | null = null;
  let seq = 0;
  const waiting = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  const broke = (message: string) => {
    w?.terminate();
    w = null;
    for (const f of waiting.values()) f.reject(new Error(message));
    waiting.clear();
  };
  return ((op, args, transfer = []) =>
    new Promise((resolve, reject) => {
      if (!w) {
        w = new Worker(new URL('../worldVaultWorker.ts', import.meta.url), { type: 'module' });
        w.onmessage = (e: MessageEvent<VaultReply>) => {
          const m = e.data;
          const f = waiting.get(m.rid);
          waiting.delete(m.rid);
          if (!f) return;
          if (m.ok) f.resolve(m.value as never);
          else f.reject(Object.assign(new Error(m.message), { kind: m.kind }));
        };
        w.onerror = (e) => broke(e.message || '世界仓库的线程出错了');
      }
      const rid = ++seq;
      waiting.set(rid, { resolve: resolve as (v: never) => void, reject });
      w.postMessage({ rid, op, args } satisfies VaultCall, { transfer });
    })) as VaultCaller;
}

let caller: VaultCaller | null = null;
const call: VaultCaller = (op, args, transfer) => {
  try {
    return (caller ??= workerCaller())(op, args, transfer);
  } catch (e) {
    // 开不了线程
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
};

export { call as vaultCall, type VaultCaller };

export const errKind = (e: unknown): VaultErrorKind | undefined => (e as { kind?: VaultErrorKind } | null)?.kind;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// 世界的内容

/** 封面的 dataURL 转成 JPEG 字节;没有、不是 JPEG = undefined(封面是可选的) */
export function thumbBytes(url: string | null | undefined): Uint8Array | undefined {
  const m = url ? /^data:image\/jpeg;base64,/.exec(url) : null;
  if (!url || !m) return undefined;
  try {
    const s = atob(url.slice(m[0].length));
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
  } catch {
    return undefined;
  }
}

/** 封面最大多少字节才放进卡片(localStorage 地方小;网页自己截的只有几十 KB)。太大的只留在仓库里 */
const THUMB_CARD_MAX = 750_000;

/** 封面的 JPEG 字节转成放进卡片的 dataURL;没有、太大 = null */
export function thumbUrl(b: Uint8Array | null): string | null {
  if (!b || b.length > THUMB_CARD_MAX) return null;
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return `data:image/jpeg;base64,${btoa(s)}`;
}

/** 这个世界能存进仓库:建好的世界(没建完的、只存了地图的不算,还没有历史) */
const canKeep = (w: { draft: boolean; map: boolean } | null) => !!w && !w.draft && !w.map;

// ---------------------------------------------------------------------------
// 存

/** 写都排队:一次写一个世界,等的时候不堆字节(手上只留最新的一份) */
let chain: Promise<unknown> = Promise.resolve();
const queue = <T>(f: () => Promise<T>): Promise<T> => {
  const p = chain.then(f);
  chain = p.catch(() => {});
  return p;
};

/** 线程交回来、还没对上存档的那一份 */
let offer: WorldPartsOffer | null = null;
/** 写不下了:这次打开不再转(推完、改完的照样试,可能已经腾出地方了) */
let vaultFull = false;

/** 这次打开写不下过、还没腾出地方(界面说「存储满了」用) */
export const vaultIsFull = (): boolean => vaultFull;

/** 写满时小状态也写不进去,这次打开写不下的世界要在这里也记一份 */
const fullHere = new Set<string>();

function setVaultFull(on: boolean) {
  vaultFull = on;
  noteVaultFull(on);
  if (!on) vaultRoomBack();
}

/** 存一份;存不下记下来,不往外抛 */
async function commit(req: CommitRequest, transfer?: Transferable[]): Promise<CommitResult | null> {
  const mark = clearedAt();
  const free = holdTrashed(req.id);
  try {
    const r = await call('commitWorld', [req], transfer);
    // 写的这一会儿仓库被清了(用的人在别的标签页选了从这台设备上删掉):这份不留
    if (clearedAt() !== mark) {
      await call('purgeWorld', [req.id]);
      return null;
    }
    if (r.status === 'saved') {
      fullHere.delete(req.id);
      setVaultFull(false);
      void askPersist().then(() => firstHint(req.id));
      void call('patchState', [req.id, { full: undefined, ...listedMarks(req.id) }])
        .then(spaceChanged)
        .catch(() => {});
      flushRoster();
    } else if (r.status === 'same' && fullHere.delete(req.id)) {
      void call('patchState', [req.id, { full: undefined }])
        .then(spaceChanged)
        .catch(() => {});
    }
    return r;
  } catch (e) {
    await noteFailure(req.id, e);
    return null;
  } finally {
    free();
  }
}

/** 没存成:写满了的腾地方。别的错只是这次没存,下次推完、下次打开再存。notes:只是 AI 正文没写进去,世界的内容还在,不标这个世界没存上 */
async function noteFailure(id: string, e: unknown, notes = false): Promise<void> {
  if (errKind(e) !== 'full') return;
  setVaultFull(true);
  if (currentWorld()?.id === id) reportVaultFull();
  if (!notes) {
    fullHere.add(id);
    await call('patchState', [id, { full: Date.now() }]).catch(() => {});
  }
  spaceChanged();
  await drainTrash().catch(() => {});
}

const partsSaved = new Set<(id: string) => void>();
/** 线程交回的整份内容存进了仓库(地图插件的图层这时才读得到);返回取消的函数 */
export function onPartsSaved(f: (id: string) => void): () => void {
  partsSaved.add(f);
  return () => void partsSaved.delete(f);
}

/** 生成世界的线程交回来一份完整的内容:对得上当前世界存着的存档就存 */
export function offerWorldParts(o: WorldPartsOffer): Promise<boolean> {
  offer = o;
  return keepOffer();
}

/** 手上的内容和当前世界存着的存档对得上就存;存了 = true */
function keepOffer(): Promise<boolean> {
  return queue(async () => {
    try {
      const o = offer;
      const c = currentWorld();
      if (!o || !c || c.kind !== 'created' || c.unsaved || c.gone || o.generator !== GENERATOR_VERSION) return false;
      // 用了推演插件、本机对不上(没装、停用、网站关了插件):线程这份是不带插件推的,存进去会把世界记的推演插件冲掉
      if (sim.sims?.() === null) {
        if (offer === o) offer = null;
        return false;
      }
      const w = loadWorld(c.id);
      if (!w || !canKeep(w) || w.save.generator !== o.generator) return false;
      const recipe = recipeOfSave(w.save);
      const text = recipeText(recipe);
      if ((await recipeKey(recipe)) !== o.recipe) return false;
      // 等的这一会儿换了世界、存档又改了、来了新的一份:这份不算它的结果
      const now = currentWorld();
      const again = now?.id === c.id && !now.unsaved && !now.gone ? loadWorld(c.id) : null;
      if (offer !== o || !again || !canKeep(again) || again.save.generator !== o.generator || recipeText(recipeOfSave(again.save)) !== text) return false;
      offer = null;
      const made: WorldMade = { app: APP_VERSION, generator: o.generator, commit: APP_COMMIT, at: new Date().toISOString() };
      // 以它为底稿新建、地图照原样放的(线程手上没有那几个地图插件,不知道记什么):照带过来的记,图层、星球参照从底稿那里带
      const maps = getMapNow();
      const carried = !o.mapPlugins && maps?.id === c.id && maps.from ? { mapPlugins: maps.list, mapsFrom: maps.from } : o.mapPlugins ? { mapPlugins: o.mapPlugins } : {};
      const r = await commit(
        { id: c.id, recipe: again.save, recipeKey: o.recipe, parts: o.parts, ...(o.schemas ? { schemas: o.schemas } : {}), ...(o.plugins ? { simPlugins: o.plugins } : {}), ...carried, made, readers: o.readers ?? { ...READER_VERSIONS }, thumb: thumbBytes(again.thumb) },
        o.parts.map((p) => p.data),
      );
      if (r?.status !== 'saved') return false;
      if (carried.mapPlugins?.length) for (const f of partsSaved) f(c.id);
      return true;
    } catch {
      return false;
    }
  });
}

/** 配方以外的东西变了:写一份新清单(内容一样的不写;还没有修订、配方变了的不写)。返回写成了没有(写满了之类 = false) */
function writeLight(id: string): Promise<boolean> {
  return queue(async () => {
    try {
      const w = loadWorld(id);
      if (!w || !canKeep(w)) return true;
      return (await commit({ id, recipe: w.save, recipeKey: await recipeKey(recipeOfSave(w.save)), thumb: thumbBytes(w.thumb) })) !== null;
    } catch {
      /* 配方算不了指纹(不是 https 的网页):这次不存 */
      return false;
    }
  });
}
const syncLight = (id: string): Promise<void> => writeLight(id).then(() => {});

let lightTimer: ReturnType<typeof setTimeout> | undefined;
let lightId: string | null = null;
function scheduleLight() {
  const c = currentWorld();
  if (!c || c.kind === 'draft') return;
  // 换了世界:上一个世界等着的先写,不能被这个顶掉
  if (lightId && lightId !== c.id) flushLight();
  clearTimeout(lightTimer);
  lightId = c.id;
  lightTimer = setTimeout(flushLight, LIGHT_DELAY);
}
function flushLight() {
  clearTimeout(lightTimer);
  const id = lightId;
  lightId = null;
  if (id) void syncLight(id);
}

/** 申请长期保存(见文件头);问不了就算了 */
let persistAsked = false;
async function askPersist(): Promise<void> {
  if (persistAsked) return;
  persistAsked = true;
  try {
    const s = navigator.storage;
    if (!s?.persist || (await s.persisted?.())) return;
    if (/firefox/i.test(navigator.userAgent)) {
      if (localStorage.getItem(PERSIST_ASKED)) return;
      localStorage.setItem(PERSIST_ASKED, '1');
    }
    await s.persist();
    spaceChanged();
  } catch {
    /* 问不了就是普通的存储 */
  }
}

let hintWaiting = false;
/** 存的不是正开着的世界(后台转的)这次不算,不然人在别处突然冒出来 */
async function firstHint(id: string): Promise<void> {
  if (hintWaiting || firstHintSaid() || !appleDevice() || currentWorld()?.id !== id || (await askPersisted())) return;
  // 这条带按钮、排最前:先让「已打开存档」这类 ok 提示露完,不然它在下面到时收掉
  hintWaiting = true;
  await afterOkToasts();
  hintWaiting = false;
  if (firstHintSaid() || currentWorld()?.id !== id) return;
  noteFirstHint();
  showToast({
    id: 'lose-first',
    kind: 'info',
    dismissible: true,
    ttl: 15_000,
    text: '世界存在这个浏览器里',
    more: ['7 天没打开这个网站可能被清掉，存成文件就不会丢'],
    action: {
      label: '存成文件',
      act: 'save-first-file',
      onClick: () => {
        clearToast('lose-first');
        withFileFlow('没能存成文件', (m) => m.saveCurrentToFile());
      },
    },
  });
}

// ---------------------------------------------------------------------------
// AI 正文(ai/libraryVault.ts 用,不排这里的队:AI 写的东西一有就写)

export const notesVault: NotesVault = {
  read: (id) => call('readAuthor', [id]),
  change: async (id, ops) => {
    const mark = clearedAt();
    try {
      const r = await call('changeAuthor', [id, ops]);
      // 写的这一会儿仓库被清了(用的人在别的标签页选了从这台设备上删掉):这份不留
      if (clearedAt() !== mark) await call('purgeWorld', [id]);
      setVaultFull(false);
      return r;
    } catch (e) {
      await noteFailure(id, e, true);
      throw e;
    }
  },
};

// ---------------------------------------------------------------------------
// 认世界内容变没变(助手的对话靠它,../ui/assistantStore.ts)

/** 一份世界内容的记号 */
export interface WorldMark {
  /** 地图、历史两块的指纹。改名、改旗只动编年史、国旗那两块,这个不变 */
  print: string;
  /** 这份内容的配方指纹 */
  recipe: string;
  /** 这份内容是哪一版生成器算的 */
  generator: number;
}

/**
 * 两个记号说的是不是同一段历史:地图、历史两块一样;或者同一个配方、同一版算的
 * (同一个世界会有不同的路算出来,比如后台转存和打开时推的,字节万一有出入,不算重推过)
 */
export function sameHistory(a: WorldMark, b: WorldMark): boolean {
  return a.print === b.print || (a.recipe === b.recipe && a.generator === b.generator);
}

/** 这个世界在仓库里最新一份的记号;仓库里还没有、读不了 = null */
export async function worldMark(id: string): Promise<WorldMark | null> {
  try {
    const h = await call('latestOf', [id]);
    if (!h) return null;
    const print = h.content
      .split('|')
      .filter((x) => x.startsWith('map:') || x.startsWith('civ:'))
      .join('|');
    return { print, recipe: h.recipeKey, generator: h.generator };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 待完成的修改

export { pendingEdit, type PendingEdit };

/** 这个世界有没有待完成的修改;读不了 = none */
export async function pendingOf(id: string): Promise<PendingEdit> {
  const w = loadWorld(id);
  if (!w) return 'none';
  try {
    return pendingEdit(await call('latestOf', [id]), await recipeKey(recipeOfSave(w.save)));
  } catch {
    return 'none';
  }
}

// ---------------------------------------------------------------------------
// 把现有的世界转进来

/** 转一个世界的线程;stop = 让路 */
export type ConvertRunner = (job: ConvertJob) => { done: Promise<ConvertReply | 'stopped'>; stop: () => void };

function workerRunner(job: ConvertJob): ReturnType<ConvertRunner> {
  let finish: (r: ConvertReply | 'stopped') => void = () => {};
  const done = new Promise<ConvertReply | 'stopped'>((r) => (finish = r));
  let w: Worker | null = null;
  const end = (r: ConvertReply | 'stopped') => {
    w?.terminate();
    w = null;
    finish(r);
  };
  try {
    w = new Worker(new URL('../worldConvertWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<ConvertReply>) => end(e.data);
    w.onerror = (e) => end({ ok: false, kind: 'failed', message: e.message || '转存的线程出错了' });
    w.postMessage(job, job.thumb ? [job.thumb.buffer as ArrayBuffer] : []);
  } catch (e) {
    end({ ok: false, kind: 'failed', message: errText(e) });
  }
  return { done, stop: () => end('stopped') };
}

let runner: ConvertRunner = workerRunner;
/** 用的人是不是正在推演;App 接上 */
let sim: WorldStoreSim = { busy: () => false, packNow: () => {} };

/** 生成世界的线程这边能做的 */
export interface WorldStoreSim {
  /** 忙不忙 */
  busy: () => boolean;
  /** 叫它把等着的内容马上打好 */
  packNow: () => void;
  /** 叫它把这份配方的世界打成几块交回来,不存(见 worker.ts 的 packParts);打不成 reject,错上带 kind */
  packParts?: (ask: Omit<PackAsk, 'id'>) => Promise<WorldPartsOffer>;
  /** 页面里这个世界推演带的推演插件(没用 = undefined;本机对不上、推不出来 = null) */
  sims?: () => SimPluginFile[] | null | undefined;
  /** 页面里这个世界长地图带的地图插件(没用 = undefined;本机对不上 = null) */
  maps?: () => MapPluginFile[] | null | undefined;
}

/** 接上生成世界的线程 */
export function setWorldStoreSim(s: WorldStoreSim) {
  sim = s;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 手机(不在后台算世界) */
const onPhone = () => isNarrow() || isCoarse();

/**
 * 这个世界最新的修订记的推演插件、地图插件本机有没有同一版:sims 没用推演插件、没有修订 = null;
 * maps 没用地图插件 = undefined,本机没有同一版 = null(按配方重算长出来是另一张地图)
 */
async function pluginFilesOf(id: string, read: <T>(p: Promise<T>) => Promise<T | null>): Promise<{ sims: SimPluginsReady | null; maps?: MapPluginFile[] | null }> {
  const m = await read(call('worldPluginsOf', [id]));
  const sims = m?.plugins.some((p) => p.role === 'sim') ? await (await import('../plugin/simPlugins')).simPluginsReady(m.plugins) : null;
  if (!m?.plugins.some((p) => p.role === 'map')) return { sims };
  const r = await (await import('../plugin/mapPlugins')).mapPluginsReady(m.plugins);
  return { sims, maps: r.ok ? r.files : null };
}

/** 这个世界最新的修订记的推演、地图插件(编号);没用、没有修订 = undefined */
async function shapingPluginsOf(id: string, read: <T>(p: Promise<T>) => Promise<T | null>): Promise<string[] | undefined> {
  const m = await read(call('worldPluginsOf', [id]));
  const ids = (m?.plugins ?? []).filter(shapesWorld).map((p) => p.id);
  return ids.length ? ids : undefined;
}

/**
 * 这个世界下一步要转什么;没有要转的 = null。
 * 先转比现在的存档更旧的那份原件(留底),再转现在的样子。没有原件的更旧版本只记下来。
 * asked = 用的人要用(存成文件):手机上、正开着的世界也算一遍。noArchive = 不看留底的旧版原件,只转现在的样子
 */
async function jobFor(id: string, asked = false, noArchive = false): Promise<ConvertJob | null> {
  const w = loadWorld(id);
  if (!w || !canKeep(w)) return null;
  // 用的人等着要文件:仓库打不开(硬盘真的满了时 WebKit 连库都打不开)也算得出来,算好了写不下就直接装成文件
  const read = <T>(p: Promise<T>): Promise<T | null> => (asked ? p.catch(() => null) : p);
  const state = await read(call('stateOf', [id]));
  // 等推演插件的不算转失败:装上了照样转
  if (state?.status === 'failed' && state.app === APP_VERSION && !state.simWait) return null;
  // 用了推演、地图插件的世界不从原件转:原件不记插件,浏览器里存着的可能是新建时先不带插件长的那一份
  const plugged = await shapingPluginsOf(id, read);
  // 网站关了插件:用了推演、地图插件的一样都不转(不带插件重算出来是另一个世界),照原样留着,记下在等哪几个
  const shut = pluginsUiOn() ? undefined : plugged;
  const hold = async (wait: string[] | undefined): Promise<null> => {
    if (JSON.stringify(state?.pluginsOff) !== JSON.stringify(wait)) await call('patchState', [id, { pluginsOff: wait }]).catch(() => {});
    return null;
  };
  const heads = plugged ? [] : await resultHeads(id);
  const body = { id, thumb: thumbBytes(w.thumb) };

  // 存档被新版重存过,原来那份还留着,也有那一版的原件
  const raw = originalOf(id);
  const parsed = !noArchive && raw && raw.generator !== w.save.generator ? parseSave(JSON.stringify(raw)) : null;
  if (parsed?.ok && !state?.archived?.includes(parsed.save.generator)) {
    const old = parsed.save;
    const key = await recipeKey(recipeOfSave(old));
    if (heads.some((h) => h.generator === old.generator && h.recipe === key)) return { kind: 'original', id, generator: old.generator, save: old, source: 'archive' };
  }

  const key = await recipeKey(recipeOfSave(w.save));
  const latest = await read(call('latestOf', [id]));
  // 打开时发现块坏了的(state.corrupt)再转一遍,commitWorld 会把块重写一遍
  if (latest && latest.recipeKey === key && latest.generator === w.save.generator && state?.corrupt === undefined) return hold(undefined);
  if (heads.some((h) => h.generator === w.save.generator && h.recipe === key)) return { ...body, kind: 'original', generator: w.save.generator, save: w.save, source: 'migrated' };
  if (w.save.generator === GENERATOR_VERSION) {
    // 打开着的世界线程自己会交内容;手机上打开哪个转哪个
    if (!asked && (onPhone() || currentWorld()?.id === id)) return null;
    await hold(shut);
    if (shut) return null;
    // 用了推演插件的带着世界记的那一版推;本机没有就不推(推出来是另一段历史),照原样留着,记下在等哪几个
    const { sims, maps } = await pluginFilesOf(id, read);
    const wait = sims && !sims.ok ? sims.checks.filter((c) => c.status !== 'ready').map((c) => c.id) : undefined;
    if (JSON.stringify(state?.simWait) !== JSON.stringify(wait)) await call('patchState', [id, { simWait: wait }]).catch(() => {});
    if (wait) return null;
    const more = sims?.ok && sims.files.length ? { simPlugins: sims.files } : {};
    // 地图留着的世界不按种子算:先看它自己、再看它出自的世界,再看别的世界有没有存着那张地图
    if (keptMapOf(w.save.edits)) return { ...body, ...more, kind: 'keptMap', save: w.save, from: [id, ...(w.save.edits.map?.from ? [w.save.edits.map.from] : []), ...allWorldIds()], app: APP_VERSION, commit: APP_COMMIT };
    // 用了地图插件的带着世界记的那一版长地图;本机没有就不转
    if (maps === null) return null;
    return { ...body, ...more, ...(maps?.length ? { mapPlugins: maps } : {}), kind: 'recompute', save: w.save, app: APP_VERSION, commit: APP_COMMIT };
  }
  // 只是记一笔:存储满了记不下也没事
  if (state?.status !== 'old' || state.generator !== w.save.generator) await call('patchState', [id, { status: 'old', generator: w.save.generator }]).catch(() => {});
  return null;
}

/** 不等后台转存跑到它:首页上转存还没开始 */
export async function contentTrouble(id: string): Promise<'old' | 'failed' | null> {
  try {
    const w = loadWorld(id);
    if (!w || !canKeep(w)) return null;
    const state = await call('stateOf', [id]);
    // 转失败以后,打开时线程交回来的内容可能已经存下了
    if (state?.status === 'failed') return (await storedFresh(id)) ? null : 'failed';
    const g = w.save.generator;
    if (!(g < GENERATOR_VERSION)) return null;
    if ((await call('latestOf', [id]))?.generator === g) return null;
    // 用了推演、地图插件的不从原件转(见 jobFor)
    if (await shapingPluginsOf(id, (p) => p)) return 'old';
    return (await resultHeads(id)).some((h) => h.generator === g) ? null : 'old';
  } catch {
    return null;
  }
}

/** 要按存档重推、却在等本机装上世界记的那一版推演插件(插件编号);没在等 = 空 */
export async function simWaitOf(id: string): Promise<string[]> {
  const state = await call('stateOf', [id]).catch(() => null);
  return state?.simWait ?? [];
}

/** 同一版软件本来不再试失败的世界,所以先清掉记录 */
export async function saveContentAgain(id: string): Promise<boolean> {
  try {
    await call('patchState', [id, { status: undefined, app: undefined, error: undefined }]);
    await settleWorld(id);
    if (await storedFresh(id)) return true;
    const state = await call('stateOf', [id]);
    if (state?.status !== 'failed') await call('patchState', [id, { status: 'failed', app: APP_VERSION }]);
    return false;
  } catch {
    return false;
  }
}

function setConverting(id: string | null) {
  try {
    if (id) localStorage.setItem(CONVERTING, id);
    else localStorage.removeItem(CONVERTING);
  } catch {
    /* 记不下就少一层保护 */
  }
}

/** 上次转的时候页面崩了:那个世界算转失败 */
async function noteCrash(): Promise<void> {
  let id: string | null = null;
  try {
    id = localStorage.getItem(CONVERTING);
  } catch {
    return;
  }
  if (!id) return;
  await call('patchState', [id, { status: 'failed', app: APP_VERSION, error: '转的时候页面崩了' }]);
  setConverting(null);
}

let converting: { stop: () => void } | null = null;
let stopped = false;
/** 最近一次看到用的人在推演的时间 */
let busyAt = 0;

/** 等用的人连着停够了;不转了 = false */
async function waitQuiet(): Promise<boolean> {
  for (;;) {
    if (stopped) return false;
    if (sim.busy()) busyAt = Date.now();
    else if (Date.now() - busyAt >= timing.quiet) return true;
    await sleep(timing.poll);
  }
}

/**
 * 转一个世界:让路了 = 'yield';别的转完(不管成败)= 'next';写满了 = 'full'。asked = 用的人等着要,不给推演让路。
 * job.fileIfFull 写不下时线程直接交回的文件给 onFile
 */
async function runJob(job: ConvertJob, asked = false, onFile?: (f: DraftedFile) => void): Promise<'next' | 'yield' | 'full'> {
  setConverting(job.id);
  const mark = clearedAt();
  // 转的时候被删了:等转完再清,不然清完了才写完,留下一份没人认的内容
  const free = holdTrashed(job.id);
  const h = runner(job);
  converting = h;
  const watch = setInterval(() => {
    if (clearedAt() !== mark) {
      stopped = true;
      h.stop();
    } else if (!asked && sim.busy()) {
      busyAt = Date.now();
      h.stop();
    }
  }, timing.poll);
  let out: ConvertReply | 'stopped';
  try {
    out = await h.done;
  } finally {
    clearInterval(watch);
    converting = null;
    setConverting(null);
    free();
  }
  // 转的这一会儿仓库被清了(也可能是别的标签页清的):线程可能正好写完了,这个世界的修订不留
  if (clearedAt() !== mark) {
    stopped = true;
    await call('purgeWorld', [job.id]);
    return 'yield';
  }
  if (out === 'stopped') return 'yield';
  if (out.ok) {
    if (job.kind === 'original' && job.source === 'archive') {
      const state = await call('stateOf', [job.id]);
      await call('patchState', [job.id, { archived: [...(state?.archived ?? []), job.generator] }]);
    } else {
      fullHere.delete(job.id);
      await call('patchState', [job.id, { status: undefined, generator: undefined, app: undefined, error: undefined, full: undefined, ...listedMarks(job.id) }]);
    }
    if (out.result.status === 'saved') void askPersist().then(() => firstHint(job.id));
    spaceChanged();
    return 'next';
  }
  if (out.kind === 'full') {
    if (out.drafted) onFile?.(out.drafted);
    await noteFailure(job.id, Object.assign(new Error(out.message), { kind: 'full' }));
    return 'full';
  }
  const error = out.message.slice(0, 200);
  // 留底的旧版原件转不了:记下不再试,现在的样子照转
  if (job.kind === 'original' && job.source === 'archive') {
    const state = await call('stateOf', [job.id]);
    await call('patchState', [job.id, { archived: [...(state?.archived ?? []), job.generator], error }]);
  } else await call('patchState', [job.id, { status: 'failed', app: APP_VERSION, error }]);
  return 'next';
}

/** 转一遍全部世界 */
async function convertAll(): Promise<void> {
  busyAt = Date.now();
  for (const id of allWorldIds()) {
    if (!(await waitQuiet()) || vaultFull) return;
    // 老的 AI 正文转进来:和世界本身转没转进来无关,没有修订的先放在 notes 表
    await moveNotes(id).catch(() => {});
    // 一个世界最多两步:留底的旧版原件、现在的样子。多一次防循环
    for (let step = 0; step < 3; ) {
      if (!(await waitQuiet()) || vaultFull) return;
      let job: ConvertJob | null;
      try {
        job = await jobFor(id);
      } catch {
        job = null;
      }
      if (!job) {
        // 转完了的:上次没来得及写的改名这时补上(内容一样的不写)
        await syncLight(id);
        break;
      }
      const r = await runJob(job);
      // 写不下,这一下也没能腾出地方;腾出来了就接着转这个世界
      if (r === 'full' && vaultFull) return;
      if (r === 'next') {
        step++;
        await sleep(timing.pause);
      }
    }
  }
}

/**
 * 存成文件之前让仓库跟上这个世界:该转的现在转(还没转进来的、留底的旧版原件),配方以外的改动(改名、AI 正文、封面)写进新清单。
 * 不抛错;没能写进去的返回为什么(仓库里可能还有上一份),别的 = null
 */
export async function settleWorld(id: string): Promise<VaultErrorKind | null> {
  try {
    await moveNotes(id);
    const notes = await flushNotes(id);
    // 一个世界最多两步,多一次防循环(同 convertAll)
    for (let step = 0; step < 3; step++) {
      const job = await jobFor(id, true);
      if (!job) break;
      const r = await runJob(job, true);
      if (r === 'full') return 'full';
      if (r === 'yield') return 'failed';
    }
    return (await writeLight(id)) && notes ? null : vaultFull ? 'full' : 'failed';
  } catch (e) {
    return errKind(e) ?? 'failed';
  }
}

/** 存成文件之前让仓库跟上这个世界的结果 */
export interface SettledForFile {
  /** 没能写进去的为什么;都写进去了 = null */
  stuck: VaultErrorKind | null;
  /** 现在的样子写不进仓库,转的线程直接装好的文件 */
  drafted: DraftedFile | null;
  /** 页面里有、没能写进仓库的 AI 正文(都写进去了 = 没有) */
  author?: AuthorContent;
}

/** 这个世界的 AI 正文没能全写进仓库:页面里的全部;手上不是全部(仓库没读到)= 没有,不拿它去掉东西 */
async function notesLeftOut(id: string, flushed: boolean): Promise<AuthorContent | undefined> {
  if (flushed) return undefined;
  await notesReady([id]);
  return notesKnown(id) ? { notes: cleanNoteList(exportNotes(id)) } : undefined;
}

/**
 * 同 settleWorld,但这是为了存成文件,写不进去也不白忙:现在的样子要算一遍的,算好了写不下就直接装成文件。
 * 正开着的世界不另开线程算:页面里已经有了,见 packPage。不抛错
 */
export async function settleForFile(id: string): Promise<SettledForFile> {
  let drafted: DraftedFile | null = null;
  try {
    await moveNotes(id).catch(() => {});
    const flushed = await flushNotes(id);
    const author = await notesLeftOut(id, flushed);
    const body = author ? { author } : {};
    let noArchive = false;
    let stuck: VaultErrorKind | null = null;
    for (let step = 0; step < 3; step++) {
      const job = await jobFor(id, true, noArchive);
      if (!job) break;
      const archive = job.kind === 'original' && job.source === 'archive';
      if (!archive && job.kind !== 'original' && currentWorld()?.id === id && sim.packParts) break;
      const r = await runJob(archive ? job : { ...job, fileIfFull: body }, true, (f) => (drafted = f));
      if (r === 'yield') return { stuck: 'failed', drafted, ...body };
      if (r === 'full') {
        stuck = 'full';
        // 留底的旧版原件写不下不碍事,现在的样子照样要
        if (!archive) return { stuck, drafted, ...body };
        noArchive = true;
      }
    }
    const light = await writeLight(id);
    return { stuck: light && flushed ? stuck : vaultFull ? 'full' : (stuck ?? 'failed'), drafted, ...body };
  } catch (e) {
    return { stuck: errKind(e) ?? 'failed', drafted };
  }
}

/**
 * 刚建好的、地图插件照原样从底稿带过来(sims = 用了推演插件、推演没有重推)的世界:页面接着用的是底稿的图和历史,线程没再算、不会自己交内容。
 * 仓库里还没有它就当场打一份存上:不然下次打开、后台转存只能按配方重长,没有那几个插件长出来是另一张图、另一段历史
 */
export async function keepCarried(id: string, sims = false): Promise<void> {
  try {
    const m = getMapNow();
    const s = getSimNow();
    const maps = m?.id === id && !!m.from;
    if ((!maps && !(sims && s?.id === id && s.files?.length)) || currentWorld()?.id !== id || (await storedFresh(id))) return;
    const w = loadWorld(id);
    const p = w && packPage(w.save);
    if (p) await offerWorldParts(await p);
  } catch {
    /* 这次没打成:推完、改完再存 */
  }
}

/** 线程把页面里的这个世界打成几块,不存(存成文件、腾出地方以后补存用)。这一版算不出来的世界(照原样打开的旧世界)= null;打不成 reject,错上带 kind */
export function packPage(save: SaveFile): Promise<WorldPartsOffer> | null {
  if (!sim.packParts || save.generator !== GENERATOR_VERSION) return null;
  // 用了推演插件的带着它们打;本机对不上的算不出来(按官方推出来是另一段历史,还会把世界记的插件冲掉)
  const sims = sim.sims?.();
  if (sims === null) return null;
  // 用了地图插件的同样:本机对不上的长不出这张地图(以它为底稿照原样带过来的除外:线程手上就是底稿那张)
  let maps = sim.maps?.();
  const now = getMapNow();
  if (maps === null && now?.from && now.id === currentWorld()?.id) maps = now.files;
  if (maps === null) return null;
  const r = recipeOfSave(save);
  return sim.packParts({
    ...(sims?.length ? { simPlugins: sims } : {}),
    ...(maps?.length ? { mapPlugins: maps } : {}),
    params: r.params,
    terrain: r.terrain as TerrainOp[] | undefined,
    sketch: r.sketch,
    interventions: r.interventions as Intervention[] | undefined,
    upheavals: r.upheavals as Upheaval[] | undefined,
    names: r.names,
    endYear: r.endYear,
    frontier: r.frontier,
    origins: r.origins,
    calamity: r.calamity,
    tuning: worldTuning(save.edits.rules),
    civSeed: r.civSeed,
    keptMap: r.keptMap,
    play: r.play,
    characters: save.edits.characters,
  });
}

/** 地图留着的世界(gen/edits.ts 文件头"地图留着的世界")还没有和存档对得上的内容:按存下的地图算一份。算好了 = true,找不到那张地图、推不出来 = false */
export async function settleKeptWorld(id: string): Promise<boolean> {
  // 用的人要打开它:上次没算成的再算一次(地图可能已经从文件放回来了)
  const state = await call('stateOf', [id]).catch(() => null);
  if (state?.status === 'failed') await call('patchState', [id, { status: undefined, app: undefined, error: undefined }]).catch(() => {});
  await settleWorld(id);
  return storedFresh(id);
}

/**
 * 这台设备上有没有这个世界要的那张地图(存着它的修订):打不开时分清是真没有,还是读的时候出错了。
 * 去的地方和算的时候一样(jobFor)。读不了仓库 = true,不能说成地图不在这里
 */
export async function keptMapHere(id: string): Promise<boolean> {
  const save = loadWorld(id)?.save;
  const sum = save && keptMapOf(save.edits);
  if (!save || !sum) return false;
  try {
    for (const x of new Set([id, ...(save.edits.map?.from ? [save.edits.map.from] : []), ...allWorldIds()])) {
      const head = await call('latestOf', [x]);
      if (head?.content.split('|').includes(`map:${sum}`)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** 仓库里最新的修订就是存档这份配方、这一版算的 */
async function storedFresh(id: string): Promise<boolean> {
  try {
    const w = loadWorld(id);
    const head = await call('latestOf', [id]);
    return !!w && !!head && head.generator === w.save.generator && head.recipeKey === (await recipeKey(recipeOfSave(w.save)));
  } catch {
    return false;
  }
}

export type KeepMapTrouble =
  /** 没有这个世界 */
  | 'missing'
  /** 还没建完、只存了地图 */
  | 'draft'
  /** 仓库里没有它的内容(没有原件的更旧版本):没有地图可留 */
  | 'nomap'
  /** 「我的世界」满了、浏览器存储满了 */
  | 'full'
  /** 推不出来、存不进去 */
  | 'failed';

export type KeptMapCopy = { ok: true; id: string; /** AI 写的史书、名字由来都带上了 */ notes: boolean } | { ok: false; kind: KeepMapTrouble; message: string };

/**
 * base 这份修改另存成地图留着的世界:别的修改照带(作者的干预、改名放不进新历史的,和重推时一样跳过,不删),
 * 记上地图(本来就是地图留着的:第几版、最早从哪个世界来的照旧)和文明种子,规则按现在的换算(是新世界)
 */
function keptMapEdits(base: WorldEdits, mapSeed: number, m: { sum: string; grown: number; from: string }): WorldEdits {
  const had = cleanMapRef(base.map);
  return {
    ...base,
    civSeed: civSeedOf(base, mapSeed),
    ...(base.rules ? { rules: stampCalc(base.rules) } : {}),
    map: { sum: m.sum, from: had?.from ?? m.from, grown: had?.grown ?? m.grown },
  };
}

/**
 * 另存一份,地图不变(gen/edits.ts 文件头"地图留着的世界"):用 id 这个世界存下的地图、各段世界,按现在的规则从第 0 年推历史,存成一个新世界。原来那份的存档、修订、原件都不动。
 * edits = 新世界带的修改(不给 = 它现在的);title 不给 = 名字加「（新版）」。不抛错;推的时候不占主线程,用的人等着要,不给推演让路。
 * 没有界面入口时走 window.__wfKeepMapCopy(检查脚本用)
 */
export async function keepMapCopy(id: string, o: { edits?: WorldEdits; title?: string } = {}): Promise<KeptMapCopy> {
  const w = loadWorld(id);
  if (!w) return { ok: false, kind: 'missing', message: '没有这个世界' };
  if (!canKeep(w)) return { ok: false, kind: 'draft', message: '这个世界还没建完' };
  const read = () => call('readRevision', [id, undefined, []]).catch(() => null);
  let rev = await read();
  // 有原件还没转进来的先转(转不了的下面就读不到);已经在仓库里的一个字不碰
  if (!rev || rev.head.generator !== w.save.generator) {
    await settleWorld(id);
    rev = await read();
  }
  const map = rev?.manifest.parts.find((p) => p.name === 'map');
  if (!rev || !map || rev.head.generator !== w.save.generator) return { ok: false, kind: 'nomap', message: '这个世界的地图没有存下来' };
  const nid = saveAsNewVersion(id, keptMapEdits(o.edits ?? w.save.edits, w.save.params.seed, { sum: map.sum, grown: rev.head.generator, from: id }), o.title);
  if (!nid) return { ok: false, kind: 'full', message: storageFullWhy() };
  const notes = copyNotes(id, nid);
  const stuck = await settleWorld(nid);
  if (await storedFresh(nid)) return { ok: true, id: nid, notes };
  // 新世界没存成:不留一个打不开的世界
  const why = await call('stateOf', [nid]).catch(() => null);
  deleteWorld(nid);
  return { ok: false, kind: stuck === 'full' ? 'full' : 'failed', message: why?.error ?? '没能存下这一份' };
}

/** 复制插件内容到副本的结果(界面按这个显示原因,不再一律当成存储满) */
export type CopyWorldPluginsResult =
  /** 源世界没有插件记录、插件存的数据、图层(确实读到了) */
  | { status: 'none' }
  | { status: 'ok' }
  /** 副本已经被后台转存或用户改动抢先写了修订,这一份不覆盖 */
  | { status: 'conflict' }
  /** 源世界的最新修订读不到、清单读不懂、块不全 */
  | { status: 'unreadable' }
  | { status: 'full' }
  | { status: 'unavailable' }
  | { status: 'failed' };

/** 复制一份:from 用了插件(推演、地图、工具)的,它最新的修订原样给 to,不然 to 打开时按不带插件长。没用插件 = none;读失败 = unreadable */
export async function copyWorldPlugins(from: string, to: string): Promise<CopyWorldPluginsResult> {
  try {
    const title = loadWorld(to)?.save.title;
    const r = await call('copyPluginRevision', [from, to, title]);
    switch (r) {
      case 'none':
      case 'ok':
      case 'conflict':
      case 'full':
      case 'unavailable':
        return { status: r };
      case 'corrupt':
        return { status: 'unreadable' };
      default:
        return { status: 'failed' };
    }
  } catch (e) {
    const kind = errKind(e);
    if (kind === 'full' || kind === 'unavailable') return { status: kind };
    return { status: 'failed' };
  }
}

if (typeof window !== 'undefined') (window as unknown as { __wfKeepMapCopy: typeof keepMapCopy }).__wfKeepMapCopy = keepMapCopy;

/** 这个标签页正在转一遍 */
let passing = false;
/** App 开始用了(startWorldStore):转存、接着存都从这一刻开始 */
let started = false;

/** 开始转;几个标签页只有一个转,别的这次不转 */
export async function startConversions(): Promise<void> {
  if (passing) return;
  passing = true;
  try {
    if (!persistent() || !allWorldIds().length) return;
    // 拿到锁才看崩溃的记录:没拿到是别的标签页正在转,那条记录是它的
    const pass = async () => {
      await noteCrash();
      await convertAll();
    };
    const locks = (navigator as { locks?: LockManager }).locks;
    if (!locks?.request) return await pass();
    await locks.request('civ-atlas:convert', { ifAvailable: true }, async (lock) => {
      if (lock) await pass();
    });
  } catch {
    /* 下次打开再转 */
  } finally {
    passing = false;
  }
}

// ---------------------------------------------------------------------------
// 清理、删

/**
 * 清内容:用的人删掉、又过了 trashKeep 毫秒的世界,内容删掉;没人引用的块清掉。
 * 还在列表里的世界(撤销了、账号里取回来了)不删,划掉记录。清不了就下次再清
 */
export async function maintain(trashKeep: number = TRASH_KEEP_MS, grace?: number): Promise<void> {
  if (!persistent()) return;
  const now = Date.now();
  for (const [id, at] of Object.entries(trashMarks())) {
    if (isStored(id)) unmarkTrash(id);
    else if (now - at >= trashKeep && !(await undone(id, at))) await purgeTrashed(id);
  }
  tidyNotes();
  await call('sweepParts', grace === undefined ? [] : [grace]);
}

/** 清掉一个删掉的世界的内容;有人拿着(worldHolds.ts)= false,没清 */
function purgeTrashed(id: string): Promise<boolean> {
  return ifNotHeld(id, async () => {
    await call('purgeWorld', [id]);
    tidyNotes(id);
    // 划掉以后原件那边就不认得它了,一起删
    await dropResults(id);
    unmarkTrash(id);
  });
}

/** 还在的世界里有地图留着的,自己还没有内容,要从这个世界拿地图(worldConvert.ts 的 keptMap):清了就再也打不开了 */
async function mapNeededFrom(id: string): Promise<boolean> {
  for (const w of listWorlds()) {
    if (w.save.edits.map?.from !== id) continue;
    if (!(await call('latestOf', [w.id]).catch(() => null))) return true;
  }
  return false;
}

/** 这次删除撤销过(撤销被回退了,见 ../worldRoster.ts):内容不能清 */
async function undone(id: string, at: number): Promise<boolean> {
  return undidThis(await call('stateOf', [id]), at);
}

/** 给 resultStore:同上,问不到算没有 */
export function trashUndone(id: string, at: number): Promise<boolean> {
  return undone(id, at).catch(() => false);
}

/** 这个标签页亲眼看着撤销提示收起的(世界编号 → 那次删除的时间):满了时那一笔可能写不进仓库 */
const settledHere = new Map<string, number>();

/** 不到 30 天能不能清。asked = 用的人自己点的「现在清掉」,听用的人的 */
async function mayDrain(id: string, at: number, asked: boolean): Promise<boolean> {
  const s = await call('stateOf', [id]);
  if (undidThis(s, at)) return false;
  return asked || settledHere.get(id) === at || s?.settled === at || s?.listed === undefined;
}

/** 清了哪些、这次没清的(还不能清,见文件头) */
export interface TrashCleared {
  cleared: string[];
  kept: string[];
}

let drainChain: Promise<unknown> = Promise.resolve();
let drainTimer: ReturnType<typeof setTimeout> | undefined;

/** 现在就清能清的删掉的世界,再清没人引用的块。一次一遍,几处同时要的排着 */
function drainTrash(asked = false): Promise<TrashCleared> {
  const p = drainChain.then(() => oneDrain(asked));
  drainChain = p.catch(() => {});
  return p;
}

async function oneDrain(asked: boolean): Promise<TrashCleared> {
  const out: TrashCleared = { cleared: [], kept: [] };
  if (!persistent()) return out;
  const now = Date.now();
  // 看不到别的标签页时只认时间
  const minAge = canSeeHolds() ? timing.holdGap : FULL_TRASH_AGE;
  let soon = Infinity;
  for (const [id, at] of Object.entries(trashMarks())) {
    if (isStored(id)) {
      unmarkTrash(id);
      continue;
    }
    const wait = minAge - (now - at);
    if (wait > 0) {
      out.kept.push(id);
      if (canSeeHolds()) soon = Math.min(soon, wait);
    } else if ((await mapNeededFrom(id)) || !(await mayDrain(id, at, asked))) out.kept.push(id);
    else if (await purgeTrashed(id)) out.cleared.push(id);
    else {
      out.kept.push(id);
      soon = Math.min(soon, timing.holdRetry);
    }
  }
  tidyNotes();
  // 块不放一会儿:正在写还没写清单的被扫掉了,写清单时查得出来,补写一遍(worldVault.ts)
  await call('sweepParts', [0]);
  // 刚删的没到时候、有人拿着:过一会儿再来一遍(到时候不紧张了就不清)
  if (soon < Infinity) drainSoon(soon);
  if (out.cleared.length) roomMade();
  return out;
}

/** 存储紧张:写不下过,或者快满了(spaceFacts.ts 的 isNearFull);问不到还能存多少、又没写不下过的不算 */
async function storageTight(): Promise<boolean> {
  if (vaultFull) return true;
  const room = await rawRoom();
  return !!room && isNearFull(room);
}

/** 过一会儿看一眼:存储紧张就清 */
function drainSoon(ms = 0) {
  clearTimeout(drainTimer);
  drainTimer = setTimeout(() => {
    void storageTight()
      .then((tight) => (tight ? drainTrash() : null))
      .catch(() => {});
  }, ms);
}

/**
 * 这个世界的内容先别清(见 worldHolds.ts),返回放开的函数。放开时它是删掉的世界、存储又紧张,就马上腾地方
 */
export function holdTrashed(id: string): () => void {
  const free = holdWorld(id);
  return () => {
    free();
    if (id in trashMarks()) drainSoon();
  };
}

/** 撤销提示收起了,这次删除不能再撤销了:它是删掉的世界、存储又紧张,就马上腾地方 */
export function trashFreed(id: string): void {
  const at = trashMarks()[id];
  if (at === undefined) return;
  settledHere.set(id, at);
  noteRoster(id, { settled: at });
  drainSoon();
}

/** 腾出了地方:接着存。正开着的世界让线程重打一份,别的世界再转一遍 */
function roomMade() {
  setVaultFull(false);
  spaceChanged();
  flushRoster();
  if (!started || stopped) return;
  void refillCurrent();
  void startConversions();
}

/** 正开着的世界仓库里还没有最新的内容(写不下时那份没存成,线程不会再交一次):重打一份,改名这些配方以外的也补上 */
async function refillCurrent(): Promise<void> {
  try {
    const c = currentWorld();
    if (!c || c.kind !== 'created' || c.unsaved || c.gone) return;
    const w = loadWorld(c.id);
    if (!w) return;
    if (!(await storedFresh(c.id))) {
      const p = packPage(w.save);
      if (p) await offerWorldParts(await p);
    } else await syncLight(c.id);
  } catch {
    /* 下次推完、下次打开再存 */
  }
}

/** 删掉的世界占多少地方 */
export interface TrashInfo {
  /** 几个世界(还占着地方的:没存进内容的不算) */
  count: number;
  /** 清掉能腾出多少字节(别的世界也在用的块不算) */
  bytes: number;
  /** 最晚哪一刻全都自己清掉(毫秒);一个都没有 = null */
  clearBy: number | null;
  /** 其中几个这时候还不能清(撤销提示还开着、有标签页开着它、正在写它):「现在清掉」不动它们 */
  held: number;
  ids: string[];
}

export interface SpaceBoard {
  /** 和别的世界共用的块也算 */
  worlds: Record<string, number>;
  /** 共用的块只算一次 */
  total: number;
  bigger: boolean;
}

/** 硬盘真的满了时 WebKit 连库都打不开:null */
export async function spaceBoard(): Promise<SpaceBoard | null> {
  try {
    const [v, originals] = await Promise.all([call('spaceBoard', []), resultSizes()]);
    const worlds = { ...v.worlds };
    let total = v.total;
    for (const [id, n] of Object.entries(originals)) {
      worlds[id] = (worlds[id] ?? 0) + n;
      total += n;
    }
    const sum = Object.values(worlds).reduce((a, b) => a + b, 0);
    return { worlds, total, bigger: sum > total || Object.keys(originals).some((id) => id in v.worlds) };
  } catch {
    return null;
  }
}

export async function fullWorldIds(): Promise<string[]> {
  const saved = await call('fullStates', []).catch((): string[] => []);
  return [...new Set([...fullHere, ...saved])].filter((id) => isStored(id));
}

/** 看一眼删掉的世界占多少、几个、哪天自己清掉。不抛错,问不到算没有 */
export async function trashInfo(): Promise<TrashInfo> {
  const none: TrashInfo = { count: 0, bytes: 0, clearBy: null, held: 0, ids: [] };
  try {
    if (!persistent()) return none;
    // 撤销过的这一次会被认回来,不算删掉的
    const marks: [string, number][] = [];
    for (const [id, at] of Object.entries(trashMarks())) if (!isStored(id) && !(await undone(id, at))) marks.push([id, at]);
    if (!marks.length) return none;
    const space = await call('spaceOf', [marks.map(([id]) => id)]);
    const have = new Set(space.have);
    let bytes = space.bytes;
    for (const [id] of marks) {
      const heads = await resultHeads(id);
      if (heads.length) have.add(id);
      bytes += heads.reduce((s, h) => s + h.size, 0);
    }
    const left = marks.filter(([id]) => have.has(id));
    if (!left.length) return none;
    let held = 0;
    for (const [id] of left) if (await isHeld(id)) held++;
    return { count: left.length, bytes, clearBy: Math.max(...left.map(([, at]) => at)) + TRASH_KEEP_MS, held, ids: left.map(([id]) => id) };
  } catch {
    return none;
  }
}

/** 用的人点了「现在清掉」:能清的现在清(还不能清的见 TrashInfo.held)。不抛错 */
export async function clearTrashNow(): Promise<TrashCleared> {
  return drainTrash(true).catch(() => ({ cleared: [], kept: Object.keys(trashMarks()) }));
}

// ---------------------------------------------------------------------------
// 名单和仓库对一遍(判断规则见 ../worldRoster.ts)

/** 写不进仓库的记号(写满了):腾出地方、下次写成了补上;关了页面就没了 */
const unwritten = new Map<string, RosterMarks>();
/** 每个世界每个记号最后要写的值:补写时不能拿旧的盖掉后来写成了的 */
const lastNoted = new Map<string, RosterMarks>();

/** 没写成:这几项还是最后要写的值才放着 */
function keepUnwritten(id: string, marks: RosterMarks): void {
  const last = lastNoted.get(id);
  const still = Object.fromEntries(Object.entries(marks).filter(([k, v]) => last?.[k as keyof RosterMarks] === v));
  if (Object.keys(still).length) unwritten.set(id, { ...still, ...unwritten.get(id) });
}

/** 记一笔。记不下先放着,不重试 */
export function noteRoster(id: string, marks: RosterMarks): void {
  lastNoted.set(id, { ...lastNoted.get(id), ...marks });
  const old = unwritten.get(id);
  if (old) {
    const left = Object.fromEntries(Object.entries(old).filter(([k]) => !(k in marks)));
    if (Object.keys(left).length) unwritten.set(id, left);
    else unwritten.delete(id);
  }
  void call('patchState', [id, marks]).catch(() => keepUnwritten(id, marks));
}

function flushRoster(): void {
  if (!unwritten.size) return;
  const list = [...unwritten];
  unwritten.clear();
  void call('patchStates', [list]).catch(() => {
    for (const [id, m] of list) keepUnwritten(id, m);
  });
}

/** 现在在名单上:写进小状态的那几项;不在 = 不写(写的同时看名单,看到的就是这一刻的) */
function listedMarks(id: string): RosterMarks {
  const w = loadWorld(id);
  return w ? { listed: Date.now(), alive: w.alive } : {};
}

/** 刚放进名单、写进仓库不走这里的世界(打开文件) */
export function noteListed(id: string): void {
  noteRoster(id, listedMarks(id));
}

/** 这一遍怎么样:认回来的;算删了的;说不清、留在仓库里不动的 */
export interface RosterReport {
  rescued: string[];
  deleted: string[];
  unsure: string[];
}

/** 认回来一个;full = 写不进名单。拿着世界的人不打扰(撤销提示开着、别的标签页开着它、正在写它),下次打开再看 */
async function rescueOne(id: string, alive: number | undefined, trashedAt: number | undefined, wiped: string | null): Promise<'done' | 'skip' | 'full'> {
  let out: 'done' | 'skip' | 'full' = 'skip';
  await ifNotHeld(id, async () => {
    const copy = await call('rosterCopy', [id]);
    if (!copy) return;
    const text = JSON.stringify(copy.recipe);
    if (!parseSave(text).ok) return;
    // 等的这一会儿名单、记录可能变了(别的标签页认了、删了、清了)
    if (isStored(id) || trashMarks()[id] !== trashedAt || clearedAt() !== wiped || currentWorld()?.id === id) return;
    if (!putSyncedWorld(id, { save: text, meta: alive === undefined ? {} : { alive }, thumb: thumbUrl(copy.thumb) })) {
      out = 'full';
      return;
    }
    if (trashedAt !== undefined) unmarkTrash(id);
    out = 'done';
  });
  return out;
}

async function rosterPass(): Promise<RosterReport> {
  const out: RosterReport = { rescued: [], deleted: [], unsure: [] };
  if (!persistent()) return out;
  const wiped = clearedAt();
  const rows = await call('rosterOf', []);
  const marks: [string, Partial<RosterMarks>][] = [];
  let room = true;
  for (const { id, at, state } of rows) {
    const w = loadWorld(id);
    if (w) {
      // 删过、又回到名单上了(账号里取回来的、从备份放回来的):现在算在名单上
      const back = state?.deleted !== undefined && state.deleted !== state.undid;
      if (state?.listed === undefined || state.alive !== w.alive || back) marks.push([id, { ...listedMarks(id), ...(back ? { undid: state.deleted } : {}) }]);
      continue;
    }
    if (isStored(id)) continue;
    const trashedAt = trashMarks()[id];
    const step = rosterStep(state, trashedAt);
    if (step === 'remark') markTrash(id, state!.deleted);
    if (step === 'remark' || step === 'deleted') out.deleted.push(id);
    if (step === 'unsure') out.unsure.push(id);
    if (step !== 'rescue' || !room || !syncable(id)) continue;
    // 退出登录全清时该清掉、没清掉的
    if (wiped !== null && at <= Number(wiped)) continue;
    if (storedCount() >= MAX_WORLDS) {
      room = false;
      continue;
    }
    const r = await rescueOne(id, state?.alive, trashedAt, wiped);
    if (r === 'done') out.rescued.push(id);
    if (r === 'full') room = false;
  }
  if (marks.length) await call('patchStates', [marks]).catch(() => {});
  return out;
}

let rosterRun: Promise<RosterReport> | null = null;

/** 对一遍名单和仓库,丢了的世界认回来。几个标签页只有一个对,别的这次不对。不抛错 */
export function rescueLostWorlds(): Promise<RosterReport> {
  const none: RosterReport = { rescued: [], deleted: [], unsure: [] };
  rosterRun ??= (async () => {
    try {
      const locks = (navigator as { locks?: LockManager }).locks;
      if (!locks?.request) return await rosterPass();
      return (await locks.request('civ-atlas:roster', { ifAvailable: true }, (lock) => (lock ? rosterPass() : none))) as RosterReport;
    } catch {
      return none;
    } finally {
      rosterRun = null;
    }
  })();
  return rosterRun;
}

/** 全清(退出登录时选了「从这台设备上删掉」):先停下正在转的、丢掉手上的,排在正在写的后面;清不了也不挡着退出 */
export async function clearWorldStore(): Promise<void> {
  try {
    localStorage.setItem(CLEARED, String(Date.now()));
  } catch {
    /* 记不下:别的标签页这时候正在转的可能留下一份 */
  }
  offer = null;
  lightId = null;
  clearTimeout(lightTimer);
  stopped = true;
  converting?.stop();
  await queue(() => call('clearVault', [])).catch(() => {});
  for (const id of Object.keys(trashMarks())) unmarkTrash(id);
}

/** 开始(App 挂载时调一次;返回取消函数) */
export function startWorldStore(): () => void {
  stopped = false;
  started = true;
  // 正开着的世界:别的标签页删了它,这边还在看,内容不能清
  let open: { id: string; free: () => void } | null = null;
  const holdOpen = () => {
    const id = currentWorld()?.id ?? null;
    if (open?.id === id) return;
    open?.free();
    open = id ? { id, free: holdTrashed(id) } : null;
  };
  holdOpen();
  const off = subscribe(() => {
    if (offer) void keepOffer();
    scheduleLight();
    const c = currentWorld();
    if (c) warmNotes(c.id);
    holdOpen();
  });
  const end = () => {
    started = false;
    off();
    open?.free();
    open = null;
  };
  if (typeof window === 'undefined' || typeof document === 'undefined') return end;
  const hidden = () => {
    if (document.visibilityState !== 'hidden') return;
    sim.packNow();
    flushLight();
    flushRoster();
  };
  // 关页面:正常关的不算崩(下次还接着转这个世界)。只收拾这个标签页自己的记录
  const leave = () => {
    sim.packNow();
    flushLight();
    if (converting) setConverting(null);
  };
  // 别的标签页清掉了删掉的世界:这边写不下的可以接着存了
  const otherTab = (e: StorageEvent) => {
    if (e.key === TRASH && vaultFull && (e.newValue?.length ?? 0) < (e.oldValue?.length ?? 0)) roomMade();
  };
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', leave);
  window.addEventListener('storage', otherTab);
  const t0 = setTimeout(() => void rescueLostWorlds(), timing.rosterDelay);
  const t1 = setTimeout(() => void startConversions(), timing.convertDelay);
  const clean = () => {
    if (allWorldIds().length || Object.keys(trashMarks()).length) void maintain().catch(() => {});
  };
  const t2 = setTimeout(clean, timing.maintainDelay);
  const t3 = setInterval(clean, timing.maintainEvery);
  return () => {
    end();
    document.removeEventListener('visibilitychange', hidden);
    window.removeEventListener('pagehide', leave);
    window.removeEventListener('storage', otherTab);
    clearTimeout(t0);
    clearTimeout(t1);
    clearTimeout(t2);
    clearInterval(t3);
    flushLight();
    stopped = true;
    converting?.stop();
  };
}

/** 单测用:换掉调仓库的办法、转世界的办法、时间,清掉手上的东西 */
export function _setWorldStore(o: { caller?: VaultCaller | null; runner?: ConvertRunner; timing?: Partial<typeof timing> }) {
  if (o.caller !== undefined) caller = o.caller;
  if (o.runner) runner = o.runner;
  Object.assign(timing, o.timing);
  offer = null;
  fullHere.clear();
  setVaultFull(false);
  persistAsked = false;
  stopped = false;
  converting = null;
  lightId = null;
  clearTimeout(lightTimer);
  chain = Promise.resolve();
  sim = { busy: () => false, packNow: () => {} };
  clearTimeout(drainTimer);
  drainChain = Promise.resolve();
  passing = false;
  started = false;
  settledHere.clear();
  unwritten.clear();
  lastNoted.clear();
}

/** 等手上排着的写完(单测用) */
export const _settled = () => chain;
export { syncLight as _syncLight };
