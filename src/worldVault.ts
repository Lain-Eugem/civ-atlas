/**
 * 世界仓库:每个世界完整的内容(地图、各段世界、历史、编年史、国旗、作者内容、封面)存在浏览器的 IndexedDB 里('civ-atlas:worlds' 库),
 * 格式是世界文件(gen/worldFormat.ts)拆开的样子:块和清单能原样拼回一个 .civworld(revisionFile)。
 *
 * 四张表:
 * - parts:块。键 = 解压后字节的指纹 + 压缩方式,相同内容只存一份。值 = 压缩后的字节,带写入时间 at(有索引:清理时不用把字节读出来)
 * - manifests:清单。键 = 世界编号 + 修订号。值 = 清单原文和几项简要信息(RevisionRow)
 * - states:每个世界一行小状态(WorldState):转存到哪了、最近一次是不是写不下。不是世界内容,丢了只是多做一遍
 * - notes:还没有修订、块读不了的世界的 AI 正文(LooseNotes)。有了修订就并进 author 块,这一行删掉
 *
 * AI 正文以最新修订的 author 块为准(readAuthor、changeAuthor)。改动按操作传,这里读最新的那份、改完写新修订,配方、看世界的几块都不动,
 * 所以历史正在重推(配方变了还没推完)也照样存得下;几个标签页同时写谁也盖不掉谁。
 * 块读不了分两种:字节好好的但这一版不认(校验没过、结构比软件新)= 另起一个名字留着,字节不动,新写的进新的 author 块;字节坏了、没了 = 不动它,新写的放进 notes 表。
 *
 * 一次写完不留半截(commitWorld):
 *   1. 新块先写,一块一个事务;写完读回来,解压、核对指纹。对不上就删掉这一块(不然以后都当它存好了),这次算没存成
 *   2. 最后写清单。写清单的事务同时查一遍:修订号有没有被别的标签页抢先、清单要的块是不是都在。不对就从头再来一次
 *   清单写成功才算存好。任何一步断掉(关页面、写满、线程被关)都只多出几个没有清单引用的块,读不到半截,上一份修订还在。
 *
 * 清理(sweepParts)和写清单靠事务互相挡着:清理的事务先读全部清单、再删块,写清单的事务先查块、再写清单,两张表都在事务里,浏览器让它们一个一个来。
 * 所以被清单引用的块绝不会被清;刚写的、还没写清单的块放够 PART_GRACE_MS 才清,别的标签页、这个线程正在写的不受影响;
 * 万一时钟跳了提前清了,写清单时查得出来,补写一遍。
 *
 * 这里自己只删两样东西:没有清单引用的块;同一个世界保留规则以外的旧修订(keepRows)。不按时间淘汰。
 * 删整个世界(purgeWorld、clearVault)只听调用方的(ui/worldStore.ts),这里不看「我的世界」的列表。
 *
 * 不碰 DOM:在后台线程里跑(worldVaultWorker.ts、worldConvertWorker.ts),多个线程、多个标签页同时用也不会写坏。
 * 出错一律抛 VaultError;调用方接住以后世界照常用,这里出什么事都不影响旧的存档和原件。
 *
 * 读:打开世界时生成世界的线程直接从这里读(worldOpen.ts),不经主线程。发现哪份修订的块坏了,小状态里记一笔(corrupt):
 * 按内容存的块不会再写第二遍,所以下一次存完整的内容时不管一样不一样,块全部重写、写新清单,坏的块就补好了。
 *
 * 存储满了也要拿得出文件(draftFile):和 commitWorld 同样拼一份修订,只是不写库,直接装成世界文件。这条路只读不写,不要求有空间。
 */
import { applyNoteOps, cleanNoteList, mergeNotes, sameNotes, type NoteOp } from './authorNotes';
import { LOCAL_HEAD_MAX_BYTES, LOCAL_PART_MAX_BYTES, packValue, partBytes, sha256, unpackValue, type SnapshotPart } from './gen/snapshot';
import { GENERATOR_VERSION } from './gen/edits';
import { VAULT_DB, type RosterMarks } from './worldRoster';
import { worldKey, type SaveFile } from './gen/savefile';
import { buildManifest, historyParts, manifestBytes, offeredPart, opaqueParts, openWorldFile, packExtra, packKnown, packPluginLayer, packThumb, zipWorld, type PackedPart } from './gen/worldFile';
import {
  KNOWN_PARTS,
  PLUGIN_DATA_MAX_BYTES,
  PLUGIN_LAYERS_MAX,
  PLUGIN_LAYER_MAX_BYTES,
  PLUGIN_LAYER_PREFIX,
  WorldFileError,
  asWorldFileError,
  pluginDataPart,
  pluginLayerOf,
  pluginLayerPart,
  type AuthorContent,
  type AuthorNote,
  type PluginLayerValue,
  type WorldMade,
  type WorldManifest,
  type WorldPartInfo,
  type WorldPlugin,
  type WorldReaders,
} from './gen/worldFormat';
import { pluginsInWorld } from './plugin/pluginWorld';
import { currentSchema } from './gen/worldMigrate';
import { parseManifest, validatePluginLayer, validateThumb } from './gen/worldValidate';
import { writeZip, type ZipInput } from './gen/zipStore';

export { VAULT_DB };

/** 没有清单引用的块放多久才清(毫秒):比写一个最大的世界用的时间长得多 */
export const PART_GRACE_MS = 3_600_000;

/** 看世界用的几块:这几块都一样,才算内容没变(作者内容、封面、配方变了不算) */
const VIEW_PARTS = ['map', 'eras', 'civ', 'chronicle', 'flags'];

/** 写清单时发现别的标签页抢先了、块被清了:从头再来几次 */
const COMMIT_TRIES = 5;

/** 仓库出错 */
export type VaultErrorKind =
  /** 写不下(浏览器存储满了) */
  | 'full'
  /** 浏览器不让用 IndexedDB */
  | 'unavailable'
  /** 写进去读回来对不上、清单要的块没了、交进来的文件和核对时不一样 */
  | 'corrupt'
  /** 这台设备内存不够,读不下这么大的世界(东西不一定有问题) */
  | 'memory'
  | 'failed';

export class VaultError extends Error {
  readonly kind: VaultErrorKind;
  constructor(kind: VaultErrorKind, message: string) {
    super(message);
    this.name = 'VaultError';
    this.kind = kind;
  }
}

function isQuota(e: unknown): boolean {
  const x = e as { name?: string } | null;
  return !!x && (x.name === 'QuotaExceededError' || x.name === 'NS_ERROR_DOM_QUOTA_REACHED');
}

/** 不管抛出来的是什么,都折成 VaultError */
export function asVaultError(e: unknown): VaultError {
  if (e instanceof VaultError) return e;
  const message = e instanceof Error ? e.message : String(e);
  if (isQuota(e)) return new VaultError('full', message);
  if (asWorldFileError(e).kind === 'memory') return new VaultError('memory', message);
  return new VaultError(e instanceof WorldFileError ? 'corrupt' : 'failed', message);
}

/** 这一份修订怎么来的 */
export type RevisionSource =
  /** 推完、改完存的 */
  | 'made'
  /** 把旧的原件、存档转进来的那一份(迁移前的原样,不淘汰) */
  | 'migrated'
  /** 比现在的存档更旧的版本留下的原件,转进来留底:不是这个世界现在的样子,不算最新的修订 */
  | 'archive';

interface PartRow {
  key: string;
  at: number;
  data: ArrayBuffer;
}

/** 清单那张表的一行 */
export interface RevisionRow {
  id: string;
  n: number;
  /** manifest.json 的原文 */
  text: string;
  /** 清单引用的块(parts 表的键) */
  keys: string[];
  /** 看世界用的几块的指纹连起来:一样 = 看世界的内容没变 */
  content: string;
  /** 配方指纹(gen/snapshot.ts 的 recipeKey) */
  recipeKey: string;
  /** 这份内容是哪一版生成器算的 */
  generator: number;
  source: RevisionSource;
  at: number;
}

/** 一行清单的简要信息 */
export type RevisionHead = Omit<RevisionRow, 'text' | 'keys'>;

/** 一个世界的小状态 */
export interface WorldState extends RosterMarks {
  id: string;
  /** old:没有原件的更旧版本,转不了;failed:转的时候失败了 */
  status?: 'old' | 'failed';
  /** 记 old 时存档的生成器版本 */
  generator?: number;
  /** 记 failed 时的软件版本(换了版本才再试) */
  app?: string;
  error?: string;
  /** 已经转过的旧版原件(生成器版本) */
  archived?: number[];
  /** 最近一次写不下的时间(写成功一次就清掉) */
  full?: number;
  /** 校验器过了的内容(RevisionRow.content):内容没变,再打开只核指纹,不再逐项校验 */
  checked?: string;
  /** 打开时发现这一份修订的块坏了(修订号):下一次存完整的内容时块全部重写 */
  corrupt?: number;
  /** 要按配方重推,但本机没有世界记的那一版推演插件(插件编号):不重推,照原样留着,装上了再推 */
  simWait?: string[];
  /** 要按配方重算,但网站关了插件、它用了推演或地图插件(插件编号):不算,照原样留着,插件开回来再算 */
  pluginsOff?: string[];
  /** 放进来时校验没过的 author 块(指纹):字节留着,不当正文读 */
  authorSkip?: string;
  /** 只有 SIZES_ROW 这一行有:块的键 → 压缩后的字节数 */
  sizes?: Record<string, number>;
}

/** notes 表的一行:还进不了 author 块的 AI 正文 */
interface LooseNotes {
  id: string;
  notes: AuthorNote[];
  at: number;
}

/** 存一份修订要的东西 */
export interface CommitRequest {
  id: string;
  /** 存档的全部内容 */
  recipe: SaveFile;
  /** 配方指纹 */
  recipeKey: string;
  /**
   * 这次打好的、看世界用的几块(map、eras、civ、chronicle、flags),已经压缩好。相同内容不会再写一遍。
   * 不给 = 只改了配方、作者内容、封面:这几块沿用最新的修订;配方指纹对不上(历史改了还没推完)就不存,等推完
   */
  parts?: SnapshotPart[];
  /** parts 里这几块的结构版本(块名 → 版本);没写的 = 现在的。原件里的块写 1 */
  schemas?: Readonly<Record<string, number>>;
  /** 什么时候用哪一版做的(给了 parts 必须给) */
  made?: WorldMade;
  readers?: WorldReaders;
  /** 作者内容:不给 = 沿用最新的修订;null = 去掉 */
  author?: AuthorContent | null;
  /** 封面(JPEG 字节):不给 = 沿用最新的修订;null = 去掉。不是 JPEG 的不要(封面是可选的,不为它存坏世界) */
  thumb?: Uint8Array | null;
  /** 不给 = made */
  source?: RevisionSource;
  /** 给了 parts 才看:这份历史用的推演插件(按出手的先后),清单里原来记的推演插件换成这几条(空 = 没用);不给 = 不知道,照上一份 */
  simPlugins?: WorldPlugin[];
  /**
   * 给了 parts 才看:这张地图用的地图插件(按出手的先后),清单里原来记的地图插件、它们的图层块换成这几条和 parts 里带的图层块
   * (空 = 没用);不给 = 不知道,照上一份
   */
  mapPlugins?: WorldPlugin[];
  /**
   * 给了 mapPlugins 才看,只管还没有修订的世界:地图照原样用的是这个世界(编号)存着的那张(本机没装那几个地图插件,parts 里没有它们出的图层)。
   * 它最新一份修订用的地图插件和地图的配方都一样时,它的地图插件图层块、星球参照(这次没带的)照原样带过来,块按内容存,不另写字节
   */
  mapsFrom?: string;
}

export type CommitResult =
  /** 存好了,第 n 份 */
  | { status: 'saved'; n: number }
  /** 和最新的一份一样,没写 */
  | { status: 'same'; n: number }
  /** 只改配方、作者内容,但这个世界还没有修订 */
  | { status: 'nobase' }
  /** 只改配方、作者内容,但配方变了:有待完成的修改,等推完 */
  | { status: 'draft' };

/**
 * 崩了以后拿存着的修订和配方草稿比:
 * - none:没有待完成的修改(还没有修订的也算:没有东西可比)
 * - recompute:修订是当前版本算的,按草稿重算就补上了
 * - readonly:修订是别的版本算的,重算出来不是它原来的样子,只能只读打开、提示有没推完的修改
 */
export type PendingEdit = 'none' | 'recompute' | 'readonly';

export function pendingEdit(stored: Pick<RevisionHead, 'recipeKey' | 'generator'> | null, draftKey: string, generator: number = GENERATOR_VERSION): PendingEdit {
  if (!stored || stored.recipeKey === draftKey) return 'none';
  return stored.generator === generator ? 'recompute' : 'readonly';
}

/** 主线程交给仓库的、后台线程打好的一份内容 */
export interface WorldPartsOffer {
  generator: number;
  recipe: string;
  parts: SnapshotPart[];
  /** 地图留着的世界:世界记的读取版本(地形按地图长出来时那一版);不给 = 现在的 */
  readers?: WorldReaders;
  /** 地图留着的世界:地图那一块照原样留着,结构版本也照它原来的;不给 = 现在的 */
  schemas?: Readonly<Record<string, number>>;
  /** 这份历史用的推演插件(世界清单里记的那几条,空 = 没用);历史是读存着的、线程不知道 = 不给 */
  plugins?: WorldPlugin[];
  /** 这张地图用的地图插件(世界清单里记的那几条,空 = 没用),parts 里带着它们出的图层块;地图是读存着的、线程不知道 = 不给 */
  mapPlugins?: WorldPlugin[];
}

// ---------------------------------------------------------------------------
// 库

let dbp: Promise<IDBDatabase> | null = null;

const VAULT_STORES = ['parts', 'manifests', 'states', 'notes'];

/**
 * 打开库;version 不给 = 现在是第几版就开第几版:以后的版本加了表,这一版的代码照样用(测试网站和正式网站共用一个库)。
 * 表不全(比如别处先空开过这个库)就升一版建上
 */
function openDb(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined') throw new Error('没有 IndexedDB');
      r = version === undefined ? indexedDB.open(VAULT_DB) : indexedDB.open(VAULT_DB, version);
    } catch (e) {
      reject(new VaultError('unavailable', e instanceof Error ? e.message : String(e)));
      return;
    }
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('parts')) d.createObjectStore('parts', { keyPath: 'key' }).createIndex('at', 'at');
      if (!d.objectStoreNames.contains('manifests')) d.createObjectStore('manifests', { keyPath: ['id', 'n'] });
      if (!d.objectStoreNames.contains('states')) d.createObjectStore('states', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('notes')) d.createObjectStore('notes', { keyPath: 'id' });
    };
    r.onsuccess = () => {
      const d = r.result;
      if (!VAULT_STORES.every((n) => d.objectStoreNames.contains(n))) {
        const next = d.version + 1;
        d.close();
        openDb(next).then(resolve, reject);
        return;
      }
      const drop = () => {
        dbp = null;
      };
      // 别的标签页要升版本:让开。连接断了(浏览器回收、页面从后台回来):下次重开
      d.onversionchange = () => {
        d.close();
        drop();
      };
      d.onclose = drop;
      resolve(d);
    };
    // 硬盘真的满了时 WebKit 连库都打不开:UnknownError「Unable to open database file on disk」
    r.onerror = () => reject(new VaultError(isQuota(r.error) || /\bdisk\b/i.test(r.error?.message ?? '') ? 'full' : 'unavailable', r.error?.message ?? 'IndexedDB 打不开'));
  });
}

const db = () =>
  (dbp ??= openDb().catch((e: unknown) => {
    // 打不开的下次再试
    dbp = null;
    throw e;
  }));

/** 单测用:换了一个库以后放掉连接 */
export function _resetVault(): void {
  void dbp?.then((d) => d.close()).catch(() => undefined);
  dbp = null;
}

/** 开一个事务:body 里发请求,done 记下结果;事务完成才算数,中止、出错 reject */
async function run<T>(stores: string[], mode: IDBTransactionMode, body: (t: IDBTransaction, done: (v: T) => void) => void, strict = false): Promise<T> {
  for (let tries = 0; ; tries++) {
    const d = await db();
    let t: IDBTransaction;
    try {
      t = strict ? d.transaction(stores, mode, { durability: 'strict' }) : d.transaction(stores, mode);
    } catch (e) {
      // 连接已经断了:重开一次
      dbp = null;
      if (tries) throw asVaultError(e);
      continue;
    }
    return new Promise<T>((resolve, reject) => {
      let value: T;
      t.oncomplete = () => resolve(value);
      t.onerror = (e) => {
        // 请求报的错这时候可能还没记到事务上。中止时排着的请求都报 AbortError:原因看 onabort
        const err = t.error ?? (e.target as IDBRequest | null)?.error;
        if (err?.name !== 'AbortError') reject(asVaultError(err ?? new Error('IndexedDB 写入失败')));
      };
      // 没有说原因就中止了写:硬盘真的满了时 WebKit 就是这样(不报 QuotaExceededError,t.error 是空的)。自己中止的不走到这里(下面已经 reject 了)
      t.onabort = () => reject(asVaultError(t.error ?? (mode === 'readwrite' ? new VaultError('full', '浏览器没有说原因就中止了写入') : new Error('IndexedDB 读取中止'))));
      try {
        body(t, (v) => (value = v));
      } catch (e) {
        try {
          t.abort();
        } catch {
          /* 已经结束了 */
        }
        reject(asVaultError(e));
      }
    });
  }
}

const rangeOf = (id: string) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);
const headOf = ({ text: _text, keys: _keys, ...head }: RevisionRow): RevisionHead => {
  void _text;
  void _keys;
  return head;
};
const chainOf = (rows: readonly RevisionRow[]) => rows.filter((r) => r.source !== 'archive');

/** 一个世界的全部修订(按修订号从小到大) */
function rowsOf(id: string): Promise<RevisionRow[]> {
  return run<RevisionRow[]>(['manifests'], 'readonly', (t, done) => {
    const q = t.objectStore('manifests').getAll(rangeOf(id));
    q.onsuccess = () => done(q.result as RevisionRow[]);
  });
}

// ---------------------------------------------------------------------------
// 写

/** 块在 parts 表里的键 */
export const partKey = (p: Pick<WorldPartInfo, 'sum' | 'zip'>) => `${p.sum}.${p.zip}`;

/** 这些键里哪些已经有了 */
function existing(keys: readonly string[]): Promise<Set<string>> {
  return run<Set<string>>(['parts'], 'readonly', (t, done) => {
    const have = new Set<string>();
    const s = t.objectStore('parts');
    for (const k of keys) {
      const c = s.count(k);
      c.onsuccess = () => {
        if (c.result) have.add(k);
      };
    }
    done(have);
  });
}

function toBuffer(d: Uint8Array | ArrayBuffer): ArrayBuffer {
  if (!(d instanceof Uint8Array)) return d;
  return d.byteOffset === 0 && d.byteLength === d.buffer.byteLength ? (d.buffer as ArrayBuffer) : (d.slice().buffer as ArrayBuffer);
}

/** 写一块,读回来核对指纹。对不上就删掉、抛错 */
async function storePart(p: PackedPart): Promise<void> {
  const key = partKey(p.info);
  const put = () =>
    run<void>(['parts'], 'readwrite', (t) => {
      t.objectStore('parts').put({ key, at: Date.now(), data: toBuffer(p.data) } satisfies PartRow);
    });
  const get = () =>
    run<PartRow | undefined>(['parts'], 'readonly', (t, done) => {
      const q = t.objectStore('parts').get(key);
      q.onsuccess = () => done(q.result as PartRow | undefined);
    });
  await put();
  let row = await get();
  // 这一会儿被清理扫掉了(别的标签页在腾地方,这一块还没有清单引用):不是写坏了,再写一遍;
  // 又被扫掉了,也不算写坏:写清单时查得出来,从头再来
  if (!row) {
    await put();
    row = await get();
    if (!row) return;
  }
  try {
    if (!row) throw new Error('读不回来');
    const back = new Uint8Array(row.data);
    if (p.info.zip === 'gzip' || p.info.zip === 'none') await partBytes(p.info as Pick<SnapshotPart, 'name' | 'bytes' | 'sum' | 'zip'>, back, LOCAL_PART_MAX_BYTES);
    // 认不出的压缩方式解不开,比压缩后的字节
    else if ((await sha256(back)) !== (await sha256(new Uint8Array(toBuffer(p.data))))) throw new Error('字节不一样');
  } catch (e) {
    // 坏的这一块不留:留着的话以后都当它存好了
    await run<void>(['parts'], 'readwrite', (t) => {
      t.objectStore('parts').delete(key);
    }).catch(() => undefined);
    throw new VaultError('corrupt', `${p.info.name} 写进去读回来对不上:${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 一个世界留哪几份修订:当前的、上一份内容不一样的(只改名、只换封面的不算,改十次名也还留着改名以前那段历史)、转进来的原样 */
export function keepRows(rows: readonly Pick<RevisionRow, 'n' | 'source' | 'content'>[]): Set<number> {
  const keep = new Set<number>();
  for (const r of rows) if (r.source !== 'made') keep.add(r.n);
  const chain = rows.filter((r) => r.source !== 'archive').sort((a, b) => a.n - b.n);
  const cur = chain.at(-1);
  if (!cur) return keep;
  keep.add(cur.n);
  const earlier = chain.slice(0, -1).reverse();
  const prev = earlier.find((r) => r.content !== cur.content) ?? earlier[0];
  if (prev) keep.add(prev.n);
  return keep;
}

/**
 * 写清单。一个事务里:最大的修订号还是 maxN(不然别的标签页抢先了)、要的块都在(不然被清了);都对才写,顺手去掉保留规则以外的旧修订。
 * folded = 这份清单的 author 块已经并进了 notes 表的这一行:还是这一行就一起去掉,又写过(别的标签页)算抢先了,从头再来
 */
function publish(row: RevisionRow, maxN: number, folded?: LooseNotes | null): Promise<'ok' | 'conflict' | 'missing'> {
  return run<'ok' | 'conflict' | 'missing'>(
    folded ? ['parts', 'manifests', 'notes'] : ['parts', 'manifests'],
    'readwrite',
    (t, done) => {
      const m = t.objectStore('manifests');
      const p = t.objectStore('parts');
      done('ok');
      const q = m.getAll(rangeOf(row.id));
      q.onsuccess = () => {
        const rows = q.result as RevisionRow[];
        if ((rows.at(-1)?.n ?? 0) !== maxN) return done('conflict');
        let left = row.keys.length;
        let missing = false;
        const write = () => {
          if (missing) return done('missing');
          m.put(row);
          const keep = keepRows([...rows, row]);
          for (const r of rows) if (!keep.has(r.n)) m.delete([r.id, r.n]);
          if (folded) t.objectStore('notes').delete(row.id);
        };
        const check = () => {
          if (!left) return write();
          for (const k of row.keys) {
            const c = p.count(k);
            c.onsuccess = () => {
              if (!c.result) missing = true;
              if (--left === 0) write();
            };
          }
        };
        if (!folded) return check();
        const l = t.objectStore('notes').get(row.id);
        l.onsuccess = () => {
          const now = l.result as LooseNotes | undefined;
          if (!now || !sameNotes(now.notes, folded.notes)) return done('conflict');
          check();
        };
      };
    },
    true,
  );
}

/** 认得的块按文件里的先后排,认不出的跟在后面(和 packWorldParts 打出来的一样) */
function sortParts(list: Iterable<WorldPartInfo>): WorldPartInfo[] {
  const order = [...KNOWN_PARTS.keys()];
  const rank = (p: WorldPartInfo) => {
    const i = order.indexOf(p.name);
    return i < 0 ? order.length : i;
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

const contentOf = (parts: readonly WorldPartInfo[]) =>
  parts
    .filter((p) => VIEW_PARTS.includes(p.name))
    .map((p) => `${p.name}:${p.sum}`)
    .join('|');

/** 一份清单看世界用的几块的指纹连起来(和存下时 RevisionRow.content 一样;不管文件里的先后) */
export const contentOfParts = (parts: readonly WorldPartInfo[]) => contentOf(sortParts(parts));

/** 除了修订号、存的时间,两份清单一样 */
function sameManifest(a: WorldManifest, b: WorldManifest): boolean {
  const norm = (m: WorldManifest) => JSON.stringify({ ...m, revision: 0, made: 0, recipe: { ...m.recipe, savedAt: '' } });
  return norm(a) === norm(b);
}

/**
 * 新的一份修订清单里记的插件:带着完整内容、说了用哪些推演插件的,推演插件跟着历史换成这次的那几条;
 * 说了用哪些地图插件的,地图插件跟着地图换;别的照上一份
 */
function pluginsFor(req: CommitRequest, prev: WorldManifest | null): WorldPlugin[] {
  const had = prev?.plugins ?? [];
  if (!req.parts || (!req.simPlugins && !req.mapPlugins)) return [...had];
  const sims = req.simPlugins?.map((p) => ({ ...p, role: 'sim' }));
  const maps = req.mapPlugins?.map((p) => ({ ...p, role: 'map' }));
  const fresh = [...(maps ?? []), ...(sims ?? [])];
  return [...had.filter((p) => !(sims && p.role === 'sim') && !(maps && p.role === 'map') && !fresh.some((s) => s.id === p.id)), ...fresh];
}

/** 请求里这次带来的几块打包 */
async function packGiven(req: CommitRequest) {
  const incoming = (req.parts ?? []).map((p) => offeredPart(p, req.schemas?.[p.name]));
  const author = req.author === undefined ? undefined : req.author?.notes.length ? await packKnown('author', req.author) : null;
  let thumb: PackedPart | null | undefined;
  if (req.thumb) {
    try {
      validateThumb(req.thumb);
      thumb = await packThumb(req.thumb);
    } catch {
      thumb = undefined;
    }
  } else thumb = req.thumb;
  return { incoming, author, thumb, given: [...incoming, ...(author ? [author] : []), ...(thumb ? [thumb] : [])] };
}

/**
 * 换了一段历史(civ 块变了)时,工具插件存的按州图层是照旧历史算的:交回它们的块名,新修订里不留。
 * 历史没变、没有这种块的交回空;读不出来的块不管(照旧留着,读世界时自会跳过)
 */
async function staleRegionLayers(id: string, n: number, prev: WorldManifest, incoming: readonly PackedPart[]): Promise<string[]> {
  const civ = incoming.find((p) => p.info.name === 'civ');
  const old = prev.parts.find((p) => p.name === 'civ');
  if (!civ || !old || civ.info.sum === old.sum) return [];
  const all = prev.parts.map((p) => p.name);
  const keep = new Set([...historyParts(all), ...opaqueParts(prev.parts)]);
  const names = all.filter((x) => x.startsWith(PLUGIN_LAYER_PREFIX) && !keep.has(x));
  if (!names.length) return [];
  const got = await readRevision(id, n, names, names);
  const out: string[] = [];
  for (const p of got?.parts ?? []) {
    try {
      const v = unpackValue(await partBytes(p.info as Pick<SnapshotPart, 'name' | 'bytes' | 'sum' | 'zip'>, new Uint8Array(p.data), PLUGIN_LAYER_MAX_BYTES)) as { unit?: unknown } | null;
      if (v?.unit === 'region') out.push(p.info.name);
    } catch {
      // 读不出来的照旧留着
    }
  }
  return out;
}

/** 拿掉了按州图层(stale)以后,世界里一块都不剩的工具插件,清单里的记录跟着去掉 */
function toolsLeft(plugins: WorldPlugin[], stale: readonly string[], parts: readonly WorldPartInfo[]): WorldPlugin[] {
  return plugins.filter((p) => p.role !== 'tool' || !stale.some((x) => pluginLayerOf(x)?.[0] === p.id) || parts.some((x) => x.by === p.id));
}

/** 新的一份修订有哪几块:上一份的,换上这次带来的 */
function partsAfter(req: CommitRequest, prev: WorldManifest | null, incoming: readonly PackedPart[], author: PackedPart | null | undefined, thumb: PackedPart | null | undefined): Map<string, WorldPartInfo> {
  const infos = new Map<string, WorldPartInfo>((prev?.parts ?? []).map((p) => [p.name, p]));
  if (req.parts) {
    // 一次完整的结果:看世界的几块整个换掉(这次没有地形大事,上一次的 eras 就不算了);推演插件的状态、图层跟着历史,上一份的不留
    for (const n of VIEW_PARTS) infos.delete(n);
    for (const n of historyParts(infos.keys())) infos.delete(n);
    // 说了用哪些地图插件的:地图换了,原来那几个地图插件存的图层、星球参照不留
    if (req.mapPlugins) {
      const maps = new Set([...(prev?.plugins ?? []).filter((p) => p.role === 'map'), ...req.mapPlugins].map((p) => p.id));
      for (const n of [...infos.keys()]) if (maps.has(pluginLayerOf(n)?.[0] ?? '')) infos.delete(n);
      infos.delete('planet');
    }
    for (const p of incoming) infos.set(p.info.name, p.info);
    // 图层块超了上限:这次带来的从后往前不存(工具插件存的留着)
    let over = [...infos.keys()].filter((n) => n.startsWith(PLUGIN_LAYER_PREFIX)).length - PLUGIN_LAYERS_MAX;
    for (let i = incoming.length - 1; i >= 0 && over > 0; i--) {
      if (!pluginLayerOf(incoming[i].info.name)) continue;
      infos.delete(incoming[i].info.name);
      over--;
    }
  }
  if (author !== undefined) {
    if (author) infos.set('author', author.info);
    else infos.delete('author');
  }
  if (thumb !== undefined) {
    if (thumb) infos.set('thumb', thumb.info);
    else infos.delete('thumb');
  }
  return infos;
}

/** 地图那一块按什么长的(参数、地形修改、草图、地形大事):一样 = 同一张地图、同几段地形 */
const mapRecipe = (s: SaveFile) => JSON.stringify([worldKey(s.params), s.edits.terrain ?? [], s.edits.sketch ?? null, s.edits.upheavals ?? []]);

/**
 * 照原样用别的世界那张地图的(CommitRequest.mapsFrom):那个世界最新一份修订里这几个地图插件出的图层块、星球参照,infos 里还没有、块还在的。
 * 它用的地图插件、地图的配方对不上 = 空
 */
async function carriedMapParts(req: CommitRequest, infos: ReadonlyMap<string, WorldPartInfo>): Promise<WorldPartInfo[]> {
  const head = chainOf(await rowsOf(req.mapsFrom!)).at(-1);
  const from = head ? manifestOf(head) : null;
  const keys = (ps: readonly WorldPlugin[]) => JSON.stringify(ps.map((p) => [p.id, p.sum, Object.entries(p.params ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))]));
  if (!from || keys((from.plugins ?? []).filter((p) => p.role === 'map')) !== keys(req.mapPlugins ?? []) || mapRecipe(from.recipe) !== mapRecipe(req.recipe)) return [];
  const ids = new Set(req.mapPlugins!.map((p) => p.id));
  const want = from.parts.filter((p) => !infos.has(p.name) && (p.name === 'planet' || ids.has(pluginLayerOf(p.name)?.[0] ?? '')));
  const have = await existing(want.map(partKey));
  return want.filter((p) => have.has(partKey(p)));
}

/**
 * 存一份修订。不改传进来的请求之外的任何东西;存不下抛 VaultError,上一份修订、别的世界都不受影响。
 * 这里只查清单能不能读(写坏的清单谁都读不了),不跑世界的校验器:万一校验器误伤,东西也得先存下来
 */
export async function commitWorld(req: CommitRequest): Promise<CommitResult> {
  try {
    const { incoming, author, thumb, given } = await packGiven(req);
    const source = req.source ?? 'made';
    // 上次打开时发现块坏了:这次带着完整的内容来,不管一样不一样都重写一遍(只改配方、作者内容的不算,等完整的内容)
    const rewrite = !!req.parts && source !== 'archive' && (await stateOf(req.id).catch(() => null))?.corrupt !== undefined;

    for (let tries = 0; tries < COMMIT_TRIES; tries++) {
      const rows = await rowsOf(req.id);
      const maxN = rows.at(-1)?.n ?? 0;
      // 留底的旧版原件自成一份,不接在最新的修订后面
      const base = source === 'archive' ? undefined : chainOf(rows).at(-1);
      if (!req.parts) {
        if (!base) return { status: 'nobase' };
        if (base.recipeKey !== req.recipeKey || base.generator !== req.recipe.generator) return { status: 'draft' };
      }
      if (source === 'archive') {
        const had = rows.find((r) => r.source === 'archive' && r.generator === req.recipe.generator);
        if (had) return { status: 'same', n: had.n };
      }
      // 清单读不懂的(坏了):当没有上一份,带着完整内容来的照样写得进去
      const prev = base ? manifestOf(base) : null;
      // 照原样用别的世界那张地图的,只有头一份照它带;已经有修订的,地图插件的记录、图层照上一份
      const r = base && req.mapsFrom ? { ...req, mapPlugins: undefined, mapsFrom: undefined } : req;
      const infos = partsAfter(r, prev, incoming, author, thumb);
      if (r.mapsFrom && r.parts && r.mapPlugins?.length) for (const p of await carriedMapParts(r, infos)) infos.set(p.name, p);
      const stale = base && prev ? await staleRegionLayers(req.id, base.n, prev, incoming) : [];
      for (const name of stale) infos.delete(name);
      // 没给作者内容 = 沿用。notes 表里等着的并进来;块坏了要重写时,坏的这一块不留(读不出来,留着存不成文件)
      const fold = source !== 'archive' && req.author === undefined ? await foldedAuthor(req.id, infos, rewrite) : null;
      if (fold?.packed) infos.set('author', fold.packed.info);
      const fresh = fold?.packed ? [...given, fold.packed] : given;
      const parts = sortParts(infos.values());
      const made = (req.parts ? req.made : prev?.made) ?? null;
      const readers = (req.parts ? req.readers : prev?.readers) ?? null;
      if (!made || !readers) throw new VaultError('failed', '存世界没给版本');
      const plugins = toolsLeft(pluginsFor(r, prev), stale, parts);
      const n = maxN + 1;
      const parent = base ? await sha256(new TextEncoder().encode(base.text)) : undefined;
      // 清单里认不出的字段(以后的版本写的)原样带着
      const manifest: WorldManifest = { ...(prev ?? {}), ...buildManifest({ id: req.id, title: req.recipe.title, made, readers, recipe: req.recipe, plugins, revision: { n, ...(parent ? { parent } : {}) } }, parts) };
      if (!req.recipe.title) delete manifest.title;
      if (!rewrite && prev && sameManifest(prev, manifest)) {
        if (fold?.loose) await dropLoose(fold.loose);
        return { status: 'same', n: base!.n };
      }
      const text = manifestBytes(manifest);
      parseManifest(text, { readers: { ...readers } });

      const have = rewrite ? new Set<string>() : await existing(fresh.map((p) => partKey(p.info)));
      const seen = new Set<string>();
      for (const p of fresh) {
        const key = partKey(p.info);
        if (have.has(key) || seen.has(key)) continue;
        seen.add(key);
        await storePart(p);
      }
      const row: RevisionRow = {
        id: req.id,
        n,
        text: new TextDecoder().decode(text),
        keys: [...new Set(parts.map(partKey))],
        content: contentOf(parts),
        recipeKey: req.recipeKey,
        generator: req.recipe.generator,
        source,
        at: Date.now(),
      };
      const out = await publish(row, maxN, fold?.loose);
      if (out === 'ok') {
        if (rewrite) await patchState(req.id, { corrupt: undefined, checked: undefined }).catch(() => undefined);
        return { status: 'saved', n };
      }
    }
    throw new VaultError('corrupt', '写清单时块总是不全');
  } catch (e) {
    throw asVaultError(e);
  }
}

/** 不写库拼出来的世界文件 */
export interface DraftedFile {
  file: Blob;
  /** 这份修订算第几份(和最新的一份一模一样 = 那一份的号,没有 = 接在最后面) */
  n: number;
  /** 看世界用的几块的指纹连起来(同 RevisionRow.content) */
  content: string;
  /** 这份内容的配方指纹、哪一版生成器算的(同 RevisionRow) */
  recipeKey: string;
  generator: number;
}

/**
 * 和 commitWorld 同样拼一份修订,但不写库,直接装成世界文件交回去:浏览器写不下了也拿得出来。
 * 这次没带的块从仓库里读,读的时候逐块核对(坏了的东西不能当备份交出去);一块读完就变成 Blob,整个世界不同时留在内存里。
 * 和最新的一份一模一样(只差存的时间):清单用它的原文,字节和 revisionFile 拼出来的一样。
 * 只改配方、作者内容,又接不上最新的一份(还没有修订、配方变了)= null:要带上完整的内容才拼得出来
 */
export async function draftFile(req: CommitRequest): Promise<DraftedFile | null> {
  try {
    const { incoming, author, thumb, given } = await packGiven(req);
    // 带着完整内容来的,仓库打不开(硬盘真的满了时 WebKit 连库都打不开)也拼得出来,只是接不上存着的那些
    let shut = false;
    const rows = await rowsOf(req.id).catch((e: unknown) => {
      if (!req.parts) throw e;
      shut = true;
      return [] as RevisionRow[];
    });
    const base = chainOf(rows).at(-1);
    if (!req.parts && (!base || base.recipeKey !== req.recipeKey || base.generator !== req.recipe.generator)) return null;
    const prev = base ? manifestOf(base) : null;
    const infos = partsAfter(req, prev, incoming, author, thumb);
    // 和存的时候一样:换了历史,按州的工具插件图层不带
    const stale = base && prev ? await staleRegionLayers(req.id, base.n, prev, incoming).catch(() => []) : [];
    for (const name of stale) infos.delete(name);
    // 和存的时候一样:notes 表里等着的并进来(这里只读,那一行不动)。上次发现块坏了的,坏的 author 块不带
    const damaged = !shut && (await stateOf(req.id).catch(() => null))?.corrupt !== undefined;
    const fold = !shut && req.author === undefined ? await foldedAuthor(req.id, infos, damaged) : null;
    if (fold?.packed) infos.set('author', fold.packed.info);
    const fresh = new Map((fold?.packed ? [...given, fold.packed] : given).map((p) => [partKey(p.info), p]));
    const parts = sortParts(infos.values());
    const made = (req.parts ? req.made : prev?.made) ?? null;
    const readers = (req.parts ? req.readers : prev?.readers) ?? null;
    if (!made || !readers) throw new VaultError('failed', '存世界没给版本');
    const n = (rows.at(-1)?.n ?? 0) + 1;
    const parent = base ? await sha256(new TextEncoder().encode(base.text)) : undefined;
    const manifest: WorldManifest = { ...(prev ?? {}), ...buildManifest({ id: req.id, title: req.recipe.title, made, readers, recipe: req.recipe, plugins: toolsLeft(pluginsFor(req, prev), stale, parts), revision: { n, ...(parent ? { parent } : {}) } }, parts) };
    if (!req.recipe.title) delete manifest.title;
    const same =!!base && !!prev && !req.parts && sameManifest(prev, manifest);
    const text = same ? new TextEncoder().encode(base.text) : manifestBytes(manifest);
    parseManifest(text, { readers: { ...readers } });
    const data: { info: WorldPartInfo; data: Uint8Array | ArrayBuffer | Blob }[] = [];
    const total = parts.reduce((sum, p) => sum + p.bytes, 0);
    let done = 0;
    for (const info of parts) {
      data.push({ info, data: fresh.get(partKey(info))?.data ?? (await partBlob(info, true)) });
      done += info.bytes;
      // 读、核对占大头;最后的一小段留给装 ZIP
      if (total > 0) partWatcher?.((done / total) * 0.9);
    }
    return { file: await zipWorld(text, data), n: same ? base.n : n, content: contentOf(parts), recipeKey: req.recipeKey, generator: req.recipe.generator };
  } catch (e) {
    throw asVaultError(e);
  }
}

// ---------------------------------------------------------------------------
// AI 正文

function looseOf(id: string): Promise<LooseNotes | null> {
  return run<LooseNotes | null>(['notes'], 'readonly', (t, done) => {
    done(null);
    const q = t.objectStore('notes').get(id);
    q.onsuccess = () => done((q.result as LooseNotes | undefined) ?? null);
  });
}

/** 这一行已经并进 author 块了:去掉。这一会儿又写过的留着 */
function dropLoose(seen: LooseNotes): Promise<void> {
  return run<void>(['notes'], 'readwrite', (t) => {
    const s = t.objectStore('notes');
    const q = s.get(seen.id);
    q.onsuccess = () => {
      const now = q.result as LooseNotes | undefined;
      if (now && sameNotes(now.notes, seen.notes)) s.delete(seen.id);
    };
  });
}

/**
 * 读 author 块:
 * - ok:读到了
 * - skip:字节好好的,但是不当正文读(放进来时校验没过、结构比这一版软件新、解不开的压缩方式、结构不对)
 * - bad:字节坏了、没了
 * 浏览器读不出来(事务出错)照常抛:那不是块的问题,等一下再试
 */
async function readBlock(id: string, info: WorldPartInfo): Promise<{ kind: 'ok'; notes: AuthorNote[] } | { kind: 'skip' } | { kind: 'bad' }> {
  if (info.schema > currentSchema('author') || (info.zip !== 'gzip' && info.zip !== 'none')) return { kind: 'skip' };
  if ((await stateOf(id))?.authorSkip === info.sum) return { kind: 'skip' };
  const row = await run<PartRow | undefined>(['parts'], 'readonly', (t, done) => {
    const q = t.objectStore('parts').get(partKey(info));
    q.onsuccess = () => done(q.result as PartRow | undefined);
  });
  if (!row) return { kind: 'bad' };
  let bytes: Uint8Array;
  try {
    bytes = await partBytes(info as Pick<SnapshotPart, 'name' | 'bytes' | 'sum' | 'zip'>, new Uint8Array(row.data), LOCAL_PART_MAX_BYTES);
  } catch (e) {
    if (asWorldFileError(e).kind === 'memory') throw e;
    return { kind: 'bad' };
  }
  try {
    const v = unpackValue(bytes, LOCAL_HEAD_MAX_BYTES) as { notes?: unknown } | null;
    return Array.isArray(v?.notes) ? { kind: 'ok', notes: cleanNoteList(v.notes) } : { kind: 'skip' };
  } catch (e) {
    if (asWorldFileError(e).kind === 'memory') throw e;
    return { kind: 'skip' };
  }
}

/** 这个世界要存的时候,notes 表里等着的怎么并进 author 块;没有要做的 = null */
async function foldedAuthor(id: string, infos: Map<string, WorldPartInfo>, rewrite: boolean): Promise<{ packed: PackedPart; loose: LooseNotes } | null> {
  const loose = await looseOf(id);
  if (!loose && !rewrite) return null;
  const info = infos.get('author');
  const got = info ? await readBlock(id, info) : ({ kind: 'ok', notes: [] } as const);
  if (got.kind === 'skip' || (got.kind === 'bad' && !rewrite)) return null;
  if (got.kind === 'bad') infos.delete('author');
  if (!loose) return null;
  return { packed: await packKnown('author', { notes: mergeNotes(got.kind === 'ok' ? got.notes : [], loose.notes) }), loose };
}

/** 读出来的 AI 正文 */
export interface AuthorRead {
  notes: AuthorNote[];
  /** 这个世界有过正文、这次没读到(块坏了、没了,清单读不懂):notes 不是全部,不能当「用的人删了」 */
  unread?: true;
}

/** 这个世界现在的 AI 正文:author 块加上 notes 表里等着的。不写东西 */
export async function readAuthor(id: string): Promise<AuthorRead> {
  try {
    // 清单和 notes 表在同一个事务里读:并进 author 块是一个事务里做的,这样读不到「清单还是旧的、那一行已经没了」
    const { rows, loose } = await run<{ rows: RevisionRow[]; loose: LooseNotes | null }>(['manifests', 'notes'], 'readonly', (t, done) => {
      const out: { rows: RevisionRow[]; loose: LooseNotes | null } = { rows: [], loose: null };
      done(out);
      const q = t.objectStore('manifests').getAll(rangeOf(id));
      q.onsuccess = () => {
        out.rows = q.result as RevisionRow[];
      };
      const l = t.objectStore('notes').get(id);
      l.onsuccess = () => {
        out.loose = (l.result as LooseNotes | undefined) ?? null;
      };
    });
    const extra = loose?.notes ?? [];
    const base = chainOf(rows).at(-1);
    if (!base) return { notes: extra };
    const prev = manifestOf(base);
    if (!prev) return { notes: extra, unread: true };
    const info = prev.parts.find((p) => p.name === 'author');
    if (!info) return { notes: extra };
    const got = await readBlock(id, info);
    if (got.kind === 'ok') return { notes: mergeNotes(got.notes, extra) };
    return got.kind === 'bad' ? { notes: extra, unread: true } : { notes: extra };
  } catch (e) {
    throw asVaultError(e);
  }
}

/** 写好的 AI 正文:写完这个世界一共几条 */
export interface AuthorWrote {
  count: number;
}

/** 写进 notes 表;读回来核对 */
async function changeLoose(id: string, ops: readonly NoteOp[]): Promise<AuthorWrote> {
  const next = await run<AuthorNote[]>(
    ['notes'],
    'readwrite',
    (t, done) => {
      const s = t.objectStore('notes');
      done([]);
      const q = s.get(id);
      q.onsuccess = () => {
        const list = applyNoteOps((q.result as LooseNotes | undefined)?.notes ?? [], ops);
        if (list.length) s.put({ id, notes: list, at: Date.now() } satisfies LooseNotes);
        else s.delete(id);
        done(list);
      };
    },
    true,
  );
  if (!sameNotes((await looseOf(id))?.notes ?? [], next)) throw new VaultError('corrupt', 'AI 正文写进去读回来对不上');
  return { count: next.length };
}

/** 字节好好的、不当正文读的那一块:另起一个名字留着(认不出的附加数据,谁都原样带着),字节不动 */
function keptAside(info: WorldPartInfo): WorldPartInfo {
  const name = `author.kept.${info.sum.slice(0, 12).toLowerCase()}`;
  return { ...info, name, file: `parts/${name}.${info.zip === 'gzip' ? 'gz' : 'bin'}`, need: 'extra' };
}

/**
 * 改一个世界的 AI 正文。有修订的写一份新修订:读最新的 author 块、改完换上,别的都照上一份(配方也是,有待完成的修改也不碍事);
 * 块先写、读回来核对,最后写清单,和 commitWorld 一样断在哪都没有半截。没有修订的、块坏了的放进 notes 表。
 * 存不下抛 VaultError,上一份修订不受影响
 */
export async function changeAuthor(id: string, ops: readonly NoteOp[]): Promise<AuthorWrote> {
  try {
    for (let tries = 0; tries < COMMIT_TRIES; tries++) {
      const rows = await rowsOf(id);
      const maxN = rows.at(-1)?.n ?? 0;
      const base = chainOf(rows).at(-1);
      const prev = base ? manifestOf(base) : null;
      if (!base || !prev) return await changeLoose(id, ops);
      const infos = new Map<string, WorldPartInfo>(prev.parts.map((p) => [p.name, p]));
      const info = infos.get('author');
      const got = info ? await readBlock(id, info) : ({ kind: 'ok', notes: [] } as const);
      if (got.kind === 'bad') return await changeLoose(id, ops);
      const loose = await looseOf(id);
      const had = got.kind === 'ok' ? got.notes : [];
      const next = applyNoteOps(loose ? mergeNotes(had, loose.notes) : had, ops);
      if (got.kind === 'skip') {
        // 还没有新写的:那一块不动
        if (!next.length) return { count: 0 };
        infos.set(keptAside(info!).name, keptAside(info!));
      } else if (sameNotes(next, had)) {
        if (loose) await dropLoose(loose);
        return { count: next.length };
      }
      infos.delete('author');
      const packed = next.length ? await packKnown('author', { notes: next }) : null;
      if (packed) infos.set('author', packed.info);
      const parts = sortParts(infos.values());
      const n = maxN + 1;
      const manifest: WorldManifest = { ...prev, parts, revision: { n, parent: await sha256(new TextEncoder().encode(base.text)) } };
      const text = manifestBytes(manifest);
      parseManifest(text, { readers: { ...prev.readers } });
      if (packed && !(await existing([partKey(packed.info)])).size) await storePart(packed);
      const row: RevisionRow = { id, n, text: new TextDecoder().decode(text), keys: [...new Set(parts.map(partKey))], content: contentOf(parts), recipeKey: base.recipeKey, generator: base.generator, source: 'made', at: Date.now() };
      if ((await publish(row, maxN, loose)) === 'ok') return { count: next.length };
    }
    throw new VaultError('corrupt', '写清单时块总是不全');
  } catch (e) {
    throw asVaultError(e);
  }
}

// ---------------------------------------------------------------------------
// 插件存的数据

/** 插件存在一个世界里的自己的数据 */
export interface PluginDataRead {
  /** 插件自己的结构版本 */
  schema: number;
  value: unknown;
  /** 清单里记的这个插件(存的时候是哪一版);没记 = null */
  plugin: WorldPlugin | null;
}

/** 这个插件存在这个世界最新修订里的数据;没有 = null。字节坏了、解不开抛 corrupt */
export async function readPluginData(id: string, pluginId: string): Promise<PluginDataRead | null> {
  try {
    const got = await readRevision(id, undefined, [pluginDataPart(pluginId)]);
    const p = got?.parts[0];
    if (!got || !p) return null;
    let value: unknown;
    try {
      value = unpackValue(await partBytes(p.info as Pick<SnapshotPart, 'name' | 'bytes' | 'sum' | 'zip'>, new Uint8Array(p.data), PLUGIN_DATA_MAX_BYTES));
    } catch (e) {
      const f = asWorldFileError(e);
      throw f.kind === 'memory' ? f : new VaultError('corrupt', `${p.info.name} 读不出来:${f.message}`);
    }
    return { schema: p.info.schema, value, plugin: got.manifest.plugins.find((x) => x.id === pluginId) ?? null };
  } catch (e) {
    throw asVaultError(e);
  }
}

/** 存插件的数据:big = 打包后超过上限(bytes 是打包后的字节数),什么都没写 */
export type PluginDataWrote = { status: 'saved'; n: number } | { status: 'same'; n: number } | { status: 'nobase' } | { status: 'big'; bytes: number };

/** 清单的插件记录:存了数据就记上这一版(记录里别的字段留着);删了数据、世界里也没有它放的别的块了,工具插件的记录跟着去掉 */
function pluginsAfter(list: readonly WorldPlugin[], plugin: WorldPlugin, stored: boolean, parts: readonly WorldPartInfo[]): WorldPlugin[] {
  const at = list.findIndex((x) => x.id === plugin.id);
  const had = at < 0 ? undefined : list[at];
  if (!stored) return had?.role === 'tool' && !parts.some((p) => p.by === plugin.id) ? list.filter((x) => x.id !== plugin.id) : [...list];
  const next: WorldPlugin = { ...had, id: plugin.id, version: plugin.version, sum: plugin.sum, role: plugin.role, ...(plugin.name !== undefined ? { name: plugin.name } : {}) };
  if (at < 0) return [...list, next];
  return list.flatMap((x, i) => (i === at ? [next] : x.id === plugin.id ? [] : [x]));
}

/**
 * 换掉(data = null:去掉)一个插件存在这个世界里的数据,写一份新修订,别的块、配方都照上一份。还没有修订的世界存不了(nobase)。
 * 写法和 changeAuthor 一样:块先写、读回来核对,最后写清单,断在哪都没有半截
 */
export async function changePluginData(id: string, plugin: WorldPlugin, data: { schema: number; value: unknown } | null): Promise<PluginDataWrote> {
  try {
    const name = pluginDataPart(plugin.id);
    if (data) {
      const raw = packValue(data.value);
      if (raw.length > PLUGIN_DATA_MAX_BYTES) return { status: 'big', bytes: raw.length };
      // 打得出来、读不回来的(绕回自己、层数太多)不存,原来的不动
      try {
        unpackValue(raw);
      } catch (e) {
        throw new VaultError('failed', `插件的数据读不回来:${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const packed = data ? await packExtra({ name, schema: data.schema, by: plugin.id, value: data.value }) : null;
    for (let tries = 0; tries < COMMIT_TRIES; tries++) {
      const rows = await rowsOf(id);
      const maxN = rows.at(-1)?.n ?? 0;
      const base = chainOf(rows).at(-1);
      const prev = base ? manifestOf(base) : null;
      if (!base || !prev) return { status: 'nobase' };
      if (!packed && !prev.parts.some((p) => p.name === name)) return { status: 'same', n: base.n };
      const infos = new Map<string, WorldPartInfo>(prev.parts.map((p) => [p.name, p]));
      if (packed) infos.set(name, packed.info);
      else infos.delete(name);
      const parts = sortParts(infos.values());
      const plugins = pluginsAfter(prev.plugins, plugin, !!packed, parts);
      const n = maxN + 1;
      const manifest: WorldManifest = { ...prev, parts, plugins, revision: { n, parent: await sha256(new TextEncoder().encode(base.text)) } };
      if (sameManifest(prev, manifest)) return { status: 'same', n: base.n };
      const text = manifestBytes(manifest);
      parseManifest(text, { readers: { ...prev.readers } });
      if (packed && !(await existing([partKey(packed.info)])).size) await storePart(packed);
      const row: RevisionRow = { id, n, text: new TextDecoder().decode(text), keys: [...new Set(parts.map(partKey))], content: contentOf(parts), recipeKey: base.recipeKey, generator: base.generator, source: 'made', at: Date.now() };
      if ((await publish(row, maxN)) === 'ok') return { status: 'saved', n };
    }
    throw new VaultError('corrupt', '写清单时块总是不全');
  } catch (e) {
    throw asVaultError(e);
  }
}

// ---------------------------------------------------------------------------
// 插件存进世界的图层

/** 存在世界里的一个工具插件、地图插件的图层:块名、哪个插件、图层编号(块名里那一段)、内容、清单里记的这个插件(没记 = null) */
export interface PluginLayerRead {
  name: string;
  by: string;
  layer: string;
  data: PluginLayerValue;
  plugin: WorldPlugin | null;
}

/**
 * 这个世界最新修订里存着的工具插件的图层(按清单里的先后;cells = 地图有几个地块,history = 历史的州数和推到哪年,
 * 不给就不读按州的)。跟着历史走的(推演插件的)不在这里;读不出来、核对不过、结构比软件新的跳过
 */
export async function readPluginLayers(id: string, cells: number, history?: { regions: number; endYear: number }): Promise<PluginLayerRead[]> {
  try {
    const head = await readRevision(id, undefined, []);
    if (!head) return [];
    const all = head.manifest.parts.map((p) => p.name);
    const skip = new Set([...opaqueParts(head.manifest.parts), ...historyParts(all)]);
    const names = all.filter((n) => n.startsWith(PLUGIN_LAYER_PREFIX) && !skip.has(n));
    if (!names.length) return [];
    const got = await readRevision(id, head.head.n, names);
    const out: PluginLayerRead[] = [];
    for (const p of got?.parts ?? []) {
      const ids = pluginLayerOf(p.info.name);
      if (!ids) continue;
      try {
        const v = unpackValue(await partBytes(p.info as Pick<SnapshotPart, 'name' | 'bytes' | 'sum' | 'zip'>, new Uint8Array(p.data), PLUGIN_LAYER_MAX_BYTES));
        const byRegion = (v as { unit?: unknown } | null)?.unit === 'region';
        if (byRegion && !history) continue;
        validatePluginLayer(v, byRegion ? { cells, ...history! } : { cells, regions: 0 }, `插件图层 ${p.info.name}`);
        const plugin = head.manifest.plugins.find((x) => x.id === ids[0]) ?? null;
        // 带年份的地块图层只列地图插件的(有地形大事时一段一份,长地图时存的,不在这里拿掉再放回去);别处写的先不列
        if (byRegion ? v.years === undefined : v.years !== undefined && plugin?.role !== 'map') continue;
        out.push({ name: p.info.name, by: ids[0], layer: ids[1], data: v, plugin });
      } catch (e) {
        if (asWorldFileError(e).kind === 'memory') throw e;
      }
    }
    return out;
  } catch (e) {
    throw asVaultError(e);
  }
}

/** 存插件图层:many = 这个世界存的插件图层已经满了(PLUGIN_LAYERS_MAX),什么都没写;存了的 size = 这一块压缩后多少字节 */
export type PluginLayerWrote = Exclude<PluginDataWrote, { status: 'saved' }> | { status: 'saved'; n: number; size?: number } | { status: 'many' };

/**
 * 换掉(data = null:拿掉)这个世界里存着的一个工具插件的图层(块名 layer.<插件编号>.<图层编号>),写一份新修订,别的块、配方都照上一份;
 * 清单的插件记录和存数据一样(pluginsAfter;plugin.sum 是空串 = 不动)。还没有修订的世界存不了(nobase)
 */
export async function changePluginLayer(id: string, plugin: WorldPlugin, layerId: string, data: PluginLayerValue | null): Promise<PluginLayerWrote> {
  try {
    const name = pluginLayerPart(plugin.id, layerId);
    if (data) {
      const frames = data.years?.length ?? 1;
      validatePluginLayer(data, { cells: data.values.length, regions: data.values.length / frames }, `插件图层 ${name}`);
      if (data.unit === 'cell' ? data.years !== undefined : data.years === undefined) throw new VaultError('failed', '工具插件的图层要么按地块一份,要么按州带年份');
    }
    const packed = data ? await packPluginLayer(plugin.id, layerId, data) : null;
    for (let tries = 0; tries < COMMIT_TRIES; tries++) {
      const rows = await rowsOf(id);
      const maxN = rows.at(-1)?.n ?? 0;
      const base = chainOf(rows).at(-1);
      const prev = base ? manifestOf(base) : null;
      if (!base || !prev) return { status: 'nobase' };
      const had = prev.parts.some((p) => p.name === name);
      if (!packed && !had) return { status: 'same', n: base.n };
      if (packed && !had && prev.parts.filter((p) => p.name.startsWith(PLUGIN_LAYER_PREFIX)).length >= PLUGIN_LAYERS_MAX) return { status: 'many' };
      const infos = new Map<string, WorldPartInfo>(prev.parts.map((p) => [p.name, p]));
      if (packed) infos.set(name, packed.info);
      else infos.delete(name);
      const parts = sortParts(infos.values());
      // 没给指纹 = 清单里的插件记录不动(调用的地方不知道插件是哪一版)
      const plugins = plugin.sum ? pluginsAfter(prev.plugins, plugin, !!packed, parts) : [...prev.plugins];
      const n = maxN + 1;
      const manifest: WorldManifest = { ...prev, parts, plugins, revision: { n, parent: await sha256(new TextEncoder().encode(base.text)) } };
      if (sameManifest(prev, manifest)) return { status: 'same', n: base.n };
      const text = manifestBytes(manifest);
      parseManifest(text, { readers: { ...prev.readers } });
      if (packed && !(await existing([partKey(packed.info)])).size) await storePart(packed);
      const row: RevisionRow = { id, n, text: new TextDecoder().decode(text), keys: [...new Set(parts.map(partKey))], content: contentOf(parts), recipeKey: base.recipeKey, generator: base.generator, source: 'made', at: Date.now() };
      if ((await publish(row, maxN)) === 'ok') return packed ? { status: 'saved', n, size: packed.data.byteLength } : { status: 'saved', n };
    }
    throw new VaultError('corrupt', '写清单时块总是不全');
  } catch (e) {
    throw asVaultError(e);
  }
}

// ---------------------------------------------------------------------------
// 把文件收进来

/** 把一个核对过的世界文件收进仓库 */
export interface AdoptRequest {
  /** 存在哪个世界编号下;清单里的编号换成它 */
  id: string;
  file: Blob;
  /** 核对时清单字节的指纹:对不上就是文件在核对之后变了 */
  sum: string;
  /** 配方指纹(文件里的配方清理以后算的) */
  recipeKey: string;
  /** 配方的生成器版本 */
  generator: number;
  readers: WorldReaders;
  /** 不给 = made */
  source?: RevisionSource;
  /** 文件里的 author 块字节坏了(对不上指纹):这个文件的世界照收,这一块不收 */
  dropAuthor?: boolean;
}

/**
 * 校验器不解开只当字节留着的块(认不出的附加数据、结构比软件新的),它们的指纹没人核过。块是按指纹存的,没核过的就可能冒充别的世界那一块,
 * 所以写之前核一遍(只解压算指纹,不读内容)。压缩方式认不出的解不开也就核不了,但它们的键(指纹.压缩方式)碰不到认得的块(只有 gzip、none),已经有的块也不会重写
 */
async function checkKept(parts: readonly PackedPart[]): Promise<void> {
  for (const p of parts) {
    if (p.info.zip !== 'gzip' && p.info.zip !== 'none') continue;
    try {
      await partBytes(p.info as Pick<SnapshotPart, 'name' | 'bytes' | 'sum' | 'zip'>, p.data instanceof Uint8Array ? p.data : new Uint8Array(p.data), LOCAL_PART_MAX_BYTES);
    } catch (e) {
      const f = asWorldFileError(e);
      throw f.kind === 'memory' ? f : new VaultError('corrupt', `${p.info.name} 对不上指纹`);
    }
  }
}

/**
 * 把核对过的世界文件原样收进仓库,成为这个编号的一份新修订:块的字节不动(认不出的附加数据也带着),清单只换编号、修订号,认不出的字段留着。
 * 校验在调用这里之前做完(ui/worldFiles.ts),这里只拿清单的指纹确认是同一份。写法和 commitWorld 一样:块先写、读回来核对,最后写清单,断在哪都没有半截。
 * 不看别的世界,别的世界的修订、块都不会被改:相同内容的块已经有了就不写。
 */
export async function adoptFile(req: AdoptRequest): Promise<{ n: number }> {
  try {
    const opened = await openWorldFile(req.file, { readers: req.readers });
    if ((await sha256(opened.manifestBytes)) !== req.sum) throw new VaultError('corrupt', '文件和核对时的不一样');
    const infos = sortParts(req.dropAuthor ? opened.manifest.parts.filter((p) => p.name !== 'author') : opened.manifest.parts);
    const packed: PackedPart[] = infos.map((info) => ({ info, data: opened.bytes.get(info.name)! }));
    await checkKept(packed.filter((p) => opened.kept.includes(p.info)));
    const source = req.source ?? 'made';
    for (let tries = 0; tries < COMMIT_TRIES; tries++) {
      const rows = await rowsOf(req.id);
      const maxN = rows.at(-1)?.n ?? 0;
      const base = source === 'archive' ? undefined : chainOf(rows).at(-1);
      const n = maxN + 1;
      const parent = base ? await sha256(new TextEncoder().encode(base.text)) : undefined;
      const manifest: WorldManifest = { ...opened.manifest, id: req.id, parts: infos, revision: { n, ...(parent ? { parent } : {}) } };
      const text = manifestBytes(manifest);
      parseManifest(text, { readers: { ...req.readers } });
      const have = await existing(packed.map((p) => partKey(p.info)));
      const seen = new Set<string>();
      for (const p of packed) {
        const key = partKey(p.info);
        if (have.has(key) || seen.has(key)) continue;
        seen.add(key);
        await storePart(p);
      }
      const out = await publish({ id: req.id, n, text: new TextDecoder().decode(text), keys: [...new Set(infos.map(partKey))], content: contentOf(infos), recipeKey: req.recipeKey, generator: req.generator, source, at: Date.now() }, maxN);
      if (out === 'ok') return { n };
    }
    throw new VaultError('corrupt', '写清单时块总是不全');
  } catch (e) {
    throw asVaultError(e);
  }
}

// ---------------------------------------------------------------------------
// 读

/** 一个世界最新的修订(简要信息;留底的旧版原件不算);没有 = null */
export async function latestOf(id: string): Promise<RevisionHead | null> {
  const last = chainOf(await rowsOf(id)).at(-1);
  return last ? headOf(last) : null;
}

/** 一个世界最新的修订里记的插件和各块(看用到了哪些插件、存了什么);没有修订、清单读不懂 = null */
export async function worldPluginsOf(id: string): Promise<Pick<WorldManifest, 'plugins' | 'parts'> | null> {
  const last = chainOf(await rowsOf(id)).at(-1);
  const m = last ? manifestOf(last) : null;
  return m ? { plugins: m.plugins, parts: m.parts } : null;
}

/** 复制出来的清单:配方照原来的、只换名字;revision.n = 这一份是目标世界的第几份修订 */
function copyRowOf(base: RevisionRow, prev: WorldManifest, to: string, title: string | undefined, n: number): RevisionRow {
  const named = title === undefined ? {} : { title };
  const manifest: WorldManifest = { ...prev, id: to, ...(prev.title !== undefined ? named : {}), recipe: { ...prev.recipe, ...named }, revision: { n } };
  const text = manifestBytes(manifest);
  parseManifest(text, { readers: { ...prev.readers } });
  return { id: to, n, text: new TextDecoder().decode(text), keys: [...base.keys], content: base.content, recipeKey: base.recipeKey, generator: base.generator, source: 'made', at: Date.now() };
}

/**
 * 复制一个世界:from 最新的修订原样成为 to 的第一份修订(块不动、插件记录和插件存的数据、图层都在),清单里的配方照原来的、只换名字。
 * from 没有修订、to 已经有修订(别的标签页抢先转了) = false
 */
export async function copyRevision(from: string, to: string, title: string | undefined): Promise<boolean> {
  try {
    const base = chainOf(await rowsOf(from)).at(-1);
    const prev = base ? manifestOf(base) : null;
    if (!base || !prev) return false;
    const out = await publish(copyRowOf(base, prev, to, title, 1), 0);
    if (out === 'missing') throw new VaultError('corrupt', '写清单时块不全');
    return out === 'ok';
  } catch (e) {
    throw asVaultError(e);
  }
}

/** 把源世界的插件内容复制到副本的结果 */
export type CopyPluginRevisionResult =
  /** 源世界没有插件记录、插件存的数据、图层(读是读到了) */
  | 'none'
  | 'ok'
  /** 副本已经被别的标签页、后台转存或用户改动抢先写了修订,这一份不覆盖 */
  | 'conflict'
  /** 源世界的最新修订读不到、清单读不懂、块不全 */
  | 'corrupt'
  | 'full'
  | 'unavailable'
  | 'failed';

/**
 * 只把「用到的插件」复制到副本:源世界读一次,没有插件记录、插件数据、图层 = none(读失败不是 none,是 corrupt);
 * 有 = 把最新修订原样写成 to 的修订。如果后台转存抢先给 to 写了第一份(不带插件),而 to 还只有这一份、又是自动转出来的,
 * 就在它上面再补一份插件版修订(别盖掉用户后来自己存的内容);只有一份以上(用户动过) = conflict。
 */
export async function copyPluginRevision(from: string, to: string, title: string | undefined): Promise<CopyPluginRevisionResult> {
  try {
    const base = chainOf(await rowsOf(from)).at(-1);
    const prev = base ? manifestOf(base) : null;
    if (!base || !prev) return 'corrupt';
    if (!pluginsInWorld(prev, []).length) return 'none';
    const first = await publish(copyRowOf(base, prev, to, title, 1), 0);
    if (first === 'missing') return 'corrupt';
    if (first === 'ok') return 'ok';
    const existing = chainOf(await rowsOf(to));
    const last = existing.at(-1);
    if (existing.length !== 1 || !last || last.source !== 'made') return 'conflict';
    const second = await publish(copyRowOf(base, prev, to, title, last.n + 1), last.n);
    if (second === 'missing') return 'corrupt';
    return second === 'ok' ? 'ok' : 'conflict';
  } catch (e) {
    const err = asVaultError(e);
    return err.kind === 'full' || err.kind === 'unavailable' ? err.kind : err.kind === 'memory' || err.kind === 'failed' ? 'failed' : 'corrupt';
  }
}

/** 一个世界最新的修订里只当字节留着的块(gen/worldFile.ts 的 opaqueParts):有就不能公开分享、投稿;没有修订、清单读不懂 = 没有 */
export async function opaquePartsOf(id: string): Promise<string[]> {
  const last = chainOf(await rowsOf(id)).at(-1);
  const m = last ? manifestOf(last) : null;
  return m ? opaqueParts(m.parts) : [];
}

/** 一个世界存着的修订(简要信息,按修订号从小到大) */
export async function revisionsOf(id: string): Promise<RevisionHead[]> {
  return (await rowsOf(id)).map(headOf);
}

/** 读出来的一份修订 */
export interface StoredRevision {
  head: RevisionHead;
  /** manifest.json 的字节 */
  text: Uint8Array;
  manifest: WorldManifest;
  parts: PackedPart[];
}

/** 一行清单解开;读不懂 = null */
function manifestOf(row: RevisionRow): WorldManifest | null {
  try {
    const m = JSON.parse(row.text) as WorldManifest | null;
    return m && Array.isArray(m.parts) ? m : null;
  } catch {
    return null;
  }
}

/**
 * 读一份修订(n 不给 = 最新的);没有 = null。清单和块在同一个事务里读,读到的是完整的一份。缺块抛 corrupt。
 * only = 只读这几块(打开核对过的世界时看世界用不着的不读);StoredRevision.parts 只有这几块,清单照样是全的。
 * spare = 这几块没有了不算坏(能重新算出来的),StoredRevision.parts 里就没有它
 */
export async function readRevision(id: string, n?: number, only?: readonly string[], spare?: readonly string[]): Promise<StoredRevision | null> {
  const got = await run<{ row: RevisionRow; datas: Map<string, ArrayBuffer> } | null>(['parts', 'manifests'], 'readonly', (t, done) => {
    done(null);
    const q = t.objectStore('manifests').getAll(rangeOf(id));
    q.onsuccess = () => {
      const rows = q.result as RevisionRow[];
      const row = n === undefined ? chainOf(rows).at(-1) : rows.find((r) => r.n === n);
      if (!row) return;
      const datas = new Map<string, ArrayBuffer>();
      done({ row, datas });
      const keys = only ? (manifestOf(row)?.parts ?? []).filter((p) => only.includes(p.name)).map(partKey) : row.keys;
      for (const k of keys) {
        const g = t.objectStore('parts').get(k);
        g.onsuccess = () => {
          const v = g.result as PartRow | undefined;
          if (v) datas.set(k, v.data);
        };
      }
    };
  }).catch((e: unknown) => {
    throw asVaultError(e);
  });
  if (!got) return null;
  const manifest = manifestOf(got.row);
  if (!manifest) throw new VaultError('corrupt', '清单读不懂');
  const parts = manifest.parts.flatMap((info): PackedPart[] => {
    if (only && !only.includes(info.name)) return [];
    const data = got.datas.get(partKey(info));
    if (data) return [{ info, data }];
    if (spare?.includes(info.name)) return [];
    throw new VaultError('corrupt', `${info.name} 这一块没有了`);
  });
  return { head: headOf(got.row), text: new TextEncoder().encode(got.row.text), manifest, parts };
}

/** 读一块,变成 Blob(字节不留在内存里);verify = 先解开核对指纹 */
async function partBlob(info: WorldPartInfo, verify: boolean): Promise<Blob> {
  const row = await run<PartRow | undefined>(['parts'], 'readonly', (t, done) => {
    const q = t.objectStore('parts').get(partKey(info));
    q.onsuccess = () => done(q.result as PartRow | undefined);
  });
  if (!row) throw new VaultError('corrupt', `${info.name} 这一块没有了`);
  if (verify && (info.zip === 'gzip' || info.zip === 'none')) {
    try {
      await partBytes(info as Pick<SnapshotPart, 'name' | 'bytes' | 'sum' | 'zip'>, new Uint8Array(row.data), LOCAL_PART_MAX_BYTES);
    } catch (e) {
      const f = asWorldFileError(e);
      throw f.kind === 'memory' ? f : new VaultError('corrupt', `${info.name} 这一块坏了`);
    }
  }
  return new Blob([row.data]);
}

/** 拼文件时报进度(只有一次性的线程会设,见 worldVaultWorker.ts):拼到几分之几 */
let partWatcher: ((share: number) => void) | null = null;
export function watchParts(f: ((share: number) => void) | null): void {
  partWatcher = f;
}

/**
 * 一份修订拼回 .civworld(n 不给 = 最新的);没有 = null。一块读完就变成 Blob,整个世界不同时留在内存里。
 * 清单和块不在同一个事务里读:读的这一会儿修订被换掉、用不着的旧块被清了,重新读一次清单。
 * verify = 每块解开核对指纹再装(存成文件时用:坏了的东西不能当备份交出去)
 */
export async function revisionFile(id: string, n?: number, verify = false): Promise<Blob | null> {
  for (let tries = 0; ; tries++) {
    const rows = await rowsOf(id);
    const row = n === undefined ? chainOf(rows).at(-1) : rows.find((r) => r.n === n);
    if (!row) return null;
    const manifest = manifestOf(row);
    if (!manifest) throw new VaultError('corrupt', '清单读不懂');
    try {
      const parts: { info: WorldPartInfo; data: Blob }[] = [];
      const total = manifest.parts.reduce((s, p) => s + p.bytes, 0);
      let done = 0;
      for (const info of manifest.parts) {
        parts.push({ info, data: await partBlob(info, verify) });
        done += info.bytes;
        // 读、核对占大头;最后的一小段留给装 ZIP
        if (total > 0) partWatcher?.((done / total) * 0.9);
      }
      return await zipWorld(new TextEncoder().encode(row.text), parts);
    } catch (e) {
      const v = asVaultError(e);
      if (tries || v.kind !== 'corrupt') throw v;
    }
  }
}

/** 几块(Blob)装成一个不压缩的 ZIP:算校验时一段段读,放在后台线程里算 */
export function zipBlobs(entries: readonly ZipInput[], maxBytes: number): Promise<Blob> {
  return writeZip(entries, maxBytes).catch((e: unknown) => {
    throw asVaultError(e);
  });
}

// ---------------------------------------------------------------------------
// 清理、删

/**
 * 清掉没有清单引用、放了超过 grace 毫秒的块;返回清了几块。
 * 读清单和删块在同一个事务里:写清单的事务排在它前面或者后面,不会夹在中间。清单有一行读不懂就一块也不清
 */
export function sweepParts(grace: number = PART_GRACE_MS, now: number = Date.now()): Promise<number> {
  return run<number>(['parts', 'manifests'], 'readwrite', (t, done) => {
    done(0);
    const p = t.objectStore('parts');
    const q = t.objectStore('manifests').getAll();
    q.onsuccess = () => {
      const used = new Set<string>();
      for (const r of q.result as RevisionRow[]) {
        if (!Array.isArray(r.keys)) return;
        for (const k of r.keys) used.add(k);
      }
      let gone = 0;
      const c = p.index('at').openKeyCursor(IDBKeyRange.upperBound(now - grace));
      c.onsuccess = () => {
        const cur = c.result;
        if (!cur) return done(gone);
        const key = cur.primaryKey as string;
        if (!used.has(key)) {
          p.delete(key);
          gone++;
        }
        cur.continue();
      };
    };
  });
}

/** 删掉一个世界的全部修订、小状态、等着的 AI 正文(块下次清理时清)。只有用的人删了这个世界才调 */
export function purgeWorld(id: string): Promise<void> {
  return run<void>(['manifests', 'states', 'notes'], 'readwrite', (t) => {
    t.objectStore('manifests').delete(rangeOf(id));
    t.objectStore('states').delete(id);
    t.objectStore('notes').delete(id);
  });
}

/** 块多大(压缩后的字节)。键相同内容就相同,记住不用再读 */
const partSizes = new Map<string, number>();

async function sizeOfPart(key: string): Promise<number> {
  const known = partSizes.get(key);
  if (known !== undefined) return known;
  // 一次读一块,读完只留下大小:读完这些块不会同时占着内存
  const size = await run<number>(['parts'], 'readonly', (t, done) => {
    done(0);
    const q = t.objectStore('parts').get(key);
    q.onsuccess = () => done((q.result as PartRow | undefined)?.data.byteLength ?? 0);
  });
  if (size) partSizes.set(key, size);
  return size;
}

/**
 * 这几个世界占多少地方:只算没有别的世界用到的块,就是把它们清掉真能腾出来的字节。have = 其中仓库里真有内容的。
 * 块的大小要把块读出来才知道,所以只读这几个世界独占的块,在后台线程里一块一块读
 */
export async function spaceOf(ids: readonly string[]): Promise<{ bytes: number; have: string[] }> {
  const rows = await run<RevisionRow[]>(['manifests'], 'readonly', (t, done) => {
    done([]);
    const q = t.objectStore('manifests').getAll();
    q.onsuccess = () => done(q.result as RevisionRow[]);
  });
  const mine = new Set(ids);
  const others = new Set<string>();
  for (const r of rows) if (!mine.has(r.id) && Array.isArray(r.keys)) for (const k of r.keys) others.add(k);
  const have = new Set<string>();
  const only = new Set<string>();
  for (const r of rows) {
    if (!mine.has(r.id)) continue;
    have.add(r.id);
    if (Array.isArray(r.keys)) for (const k of r.keys) if (!others.has(k)) only.add(k);
  }
  let bytes = 0;
  for (const k of only) bytes += await sizeOfPart(k);
  return { bytes, have: [...have] };
}

/** states 表里这一行不是世界 */
const SIZES_ROW = '#part-sizes';

export interface VaultSpace {
  /** 和别的世界共用的块也算 */
  worlds: Record<string, number>;
  /** 共用的块只算一次 */
  total: number;
}

/** 块的大小要读出块才知道,读过的记在仓库里,不然每次都要读几百 MB */
export async function spaceBoard(): Promise<VaultSpace> {
  const rows = await run<RevisionRow[]>(['manifests'], 'readonly', (t, done) => {
    done([]);
    const q = t.objectStore('manifests').getAll();
    q.onsuccess = () => done(q.result as RevisionRow[]);
  });
  const saved = await stateOf(SIZES_ROW).catch(() => null);
  for (const [k, n] of Object.entries(saved?.sizes ?? {})) partSizes.set(k, n);
  const byWorld = new Map<string, Set<string>>();
  const all = new Set<string>();
  for (const r of rows) {
    if (!Array.isArray(r.keys)) continue;
    let mine = byWorld.get(r.id);
    if (!mine) byWorld.set(r.id, (mine = new Set()));
    for (const k of r.keys) {
      mine.add(k);
      all.add(k);
    }
  }
  const sizes: Record<string, number> = {};
  let total = 0;
  for (const k of all) total += sizes[k] = await sizeOfPart(k);
  const had = saved?.sizes ?? {};
  if (Object.keys(had).length !== all.size || [...all].some((k) => had[k] !== sizes[k])) await patchState(SIZES_ROW, { sizes }).catch(() => {});
  const worlds: Record<string, number> = {};
  for (const [id, keys] of byWorld) worlds[id] = [...keys].reduce((s, k) => s + (sizes[k] ?? 0), 0);
  return { worlds, total };
}

export function fullStates(): Promise<string[]> {
  return run<string[]>(['states'], 'readonly', (t, done) => {
    done([]);
    const q = t.objectStore('states').getAll();
    q.onsuccess = () => done((q.result as WorldState[]).filter((s) => s.full !== undefined).map((s) => s.id));
  });
}

/** 全删(退出登录时选了「从这台设备上删掉」) */
export function clearVault(): Promise<void> {
  return run<void>(VAULT_STORES, 'readwrite', (t) => {
    for (const s of VAULT_STORES) t.objectStore(s).clear();
  });
}

// ---------------------------------------------------------------------------
// 小状态

export function stateOf(id: string): Promise<WorldState | null> {
  return run<WorldState | null>(['states'], 'readonly', (t, done) => {
    done(null);
    const q = t.objectStore('states').get(id);
    q.onsuccess = () => done((q.result as WorldState | undefined) ?? null);
  });
}

/** 改几个世界的小状态:写 patch 里的几项,值是 undefined 的去掉 */
export function patchStates(list: readonly (readonly [string, Partial<Omit<WorldState, 'id'>>])[]): Promise<void> {
  return run<void>(['states'], 'readwrite', (t) => {
    const s = t.objectStore('states');
    for (const [id, patch] of list) {
      const q = s.get(id);
      q.onsuccess = () => {
        const next: WorldState = { ...((q.result as WorldState | undefined) ?? { id }), ...patch };
        for (const k of Object.keys(patch) as (keyof typeof patch)[]) if (patch[k] === undefined) delete next[k];
        s.put(next);
      };
    }
  });
}

export const patchState = (id: string, patch: Partial<Omit<WorldState, 'id'>>): Promise<void> => patchStates([[id, patch]]);

/** 仓库里的一个世界:最新一份的时间和小状态(只有留底旧版的不算) */
export interface RosterRow {
  id: string;
  at: number;
  state: WorldState | null;
}

/** 仓库里有哪些世界(不读块) */
export function rosterOf(): Promise<RosterRow[]> {
  return run<RosterRow[]>(['manifests', 'states'], 'readonly', (t, done) => {
    done([]);
    const m = t.objectStore('manifests').getAll();
    const s = t.objectStore('states').getAll();
    s.onsuccess = () => {
      const states = new Map((s.result as WorldState[]).map((x) => [x.id, x]));
      const latest = new Map<string, number>();
      for (const r of chainOf(m.result as RevisionRow[])) latest.set(r.id, r.at);
      done([...latest].map(([id, at]) => ({ id, at, state: states.get(id) ?? null })));
    };
  });
}

/** 把一个世界放回名单要的东西:最新一份的存档、封面;没有 = null */
export async function rosterCopy(id: string): Promise<{ recipe: SaveFile; thumb: Uint8Array | null } | null> {
  const r = await readRevision(id, undefined, ['thumb'], ['thumb']);
  if (!r) return null;
  const t = r.parts[0];
  return { recipe: r.manifest.recipe, thumb: t ? new Uint8Array(t.data) : null };
}

/** 主线程通过后台线程调的几样(worldVaultWorker.ts、ui/worldStore.ts) */
export const vaultOps = { commitWorld, draftFile, adoptFile, latestOf, revisionsOf, readRevision, revisionFile, zipBlobs, sweepParts, spaceOf, spaceBoard, fullStates, purgeWorld, clearVault, stateOf, patchState, patchStates, rosterOf, rosterCopy, readAuthor, changeAuthor, readPluginData, changePluginData, readPluginLayers, changePluginLayer, worldPluginsOf, copyRevision, copyPluginRevision, opaquePartsOf };
export type VaultOps = typeof vaultOps;
