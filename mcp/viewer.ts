/**
 * 本地可视化查看器(阶段 4)
 *
 * 一个只监听 127.0.0.1 的零依赖 HTTP 服务:
 *   - 复用 mcp/engine.ts 与 mcp/monarch.ts 的进程内世界/会话表;
 *   - 把地图画成 PNG(基础地形 + 各国疆域两层),浏览器里直接看;
 *   - 提供 创建世界 / 开君主会话 / 跑一回合 / 状态 / 编年史 / 回放对账 / 导出 的 JSON 接口;
 *   - 前端是 mcp/viewer/ 下的 index.html + style.css + app.js。
 *
 * 用法:先构建,再启动(在本仓库根目录执行):
 *   powershell -NoProfile -ExecutionPolicy Bypass -File mcp/build.ps1
 *   node mcp/.build/mcp/viewer.js --port 5190
 * 然后浏览器打开 http://127.0.0.1:5190
 *
 * 说明:
 *   - 不引入任何新依赖(不用 express / sharp / canvas),PNG 用 node:zlib 手写;
 *   - LLM 的 Key 只存在本进程内存,不进日志、不进导出;
 *   - 世界生成和推演都是纯计算,接口本身不改变确定性。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep, dirname, basename, isAbsolute } from 'node:path';
import { gzipSync } from 'node:zlib';
import { constants as osConstants, setPriority } from 'node:os';

import { encodePng } from './png';

import {
  createWorld,
  openSession,
  getSession,
  getWorldRecord,
  stateGet,
  turnStep,
  chronicleGet,
  exportSession,
  isFinished,
  sessionSummary,
  magicView,
  worldIdOf,
  nationControlOf,
  nationControlView,
  listSessions,
  withSessionLock,
  deleteSession,
  type EventView,
  type PolityView,
  type RulerView,
  type Session,
} from './engine';
import { setupMonarch, monarchRound, monarchPlan, monarchCommit, monarchStatus, monarchPanels, setMonarchCard, verifySession, cancelMonarchPlan } from './monarch';
import { listStartNations, applyCustomStart, applyStartSetup, startConfigStatus, autoNationName, inferCardFromBiography, hasUsableCities, noCitiesMessage, previewNationAt, type StartSetupInput } from './monarch-start';
import { CARD_LIFESPAN_DEFAULT } from '../src/gen/civ/monarchCard';
import { dmRound, dmSetup, dmStatus } from './dm';
import { pettyRound, pettySetup, pettyStatus } from './petty';
import { monarchBorders, pickMonarchIds } from '../src/gen/civ/monarch';
import { polityName } from '../src/gen/civ/growth';
import { fieldFrame, FIELD_KINDS, FIELD_LABEL, type FieldFrame, type FieldKind } from '../src/gen/field';
import {
  renderFieldMap,
  fieldDataJson,
  fieldLegend,
  DEFAULT_FIELD_STYLE,
  FIELD_RAMPS,
  type FieldRamp,
  type FieldStyle,
} from './field-render';
import { DEFAULT_MAGIC_STYLE, renderMagicMap, renderMagicTile, magicDataJson, magicLegendOf, magicLayerOf, parseMagicColors } from './magic-render';
import { isTerrainStyle, renderTile, renderVectors, renderVeinOverlay, renderWhole, type TerrainStyle } from './terrain';
import { renderOwnerPixels, ownerCivData, renderOwnerTilePixels } from './owner-map';
import { buildLabels } from './labels';
import { regionAtlas, regionInfoAt } from './region-info';
import { cancelPlayerCommand, parsePlayerCommand, playerCommandView, queuePlayerCommand } from './player-commands';
import { cleanOrders } from './orders';
import { dialogueView } from './dialogue';
import { disposeMapPools, renderViaPool } from './map-pool';
import type { World } from '../src/gen/world';
import type { Civ, Polity } from '../src/gen/civ/types';

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

type RGB = readonly [number, number, number];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function hexOf(c: readonly [number, number, number]): string {
  const p = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${p(c[0])}${p(c[1])}${p(c[2])}`;
}

function gameYearOf(playYear: number): number {
  // play.year = 年份 − 1/256(停在该年年初的前一刻),换回人看的年份
  return Math.floor(playYear + 1 / 256 + 1e-9);
}

/* ------------------------------------------------------------------ *
 * 旧沙盒底图(classic)的兼容导出
 * ------------------------------------------------------------------ */

interface MapImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/**
 * 兼容导出:改造前的沙盒底图(classic)是「三角形栅格 + 地块小方块」这套纯 viewer 内的画法,
 * 现已并入 mcp/terrain.ts 的 renderWhole(和 geo/satellite 同一条写实流水线)。
 * 这里只留一层转发,内部不再保留那套死代码;外部若曾 import 本函数也不会落到空符号。
 */
function renderWorldMap(world: World): MapImage {
  return renderWhole(world, 'classic');
}

interface OwnerMap extends MapImage {
  grid: { w: number; h: number; owner: number[] };
  colors: Record<string, string>;
  /** 国界线:扁平 [x0,y0,x1,y1,…],主图像素坐标(跨 180° 的线会超出 [0,W],前端按 shift 再画一份) */
  regions: number[][];
  borders: number[][];
  fingerprint: string;
}

/** 疆域图:逐像素归属 + 水彩罩染 + 平滑国界,和主站同一套画法(见 mcp/owner-map.ts);水/无主透明 */
function renderOwnerMap(s: Session): OwnerMap {
  const world = s.world;
  const civ: Civ = s.civ;
  const pixels = renderOwnerPixels(world, civ);
  const W = pixels.width;
  const H = pixels.height;
  // Uint8ClampedArray → Uint8Array 零拷贝视图(encodePng 收 Uint8Array)
  const px = new Uint8Array(pixels.rgba.buffer, pixels.rgba.byteOffset, pixels.rgba.byteLength);

  const colors: Record<string, string> = {};
  for (const p of civ.polities) {
    if (p.ended === undefined) colors[String(p.id)] = hexOf(p.color);
  }

  // 点击/悬停选国用的低分辨率网格:每格取落进去的最后一个有主地块
  const n = world.mesh.n;
  const gw = 240;
  const gh = Math.max(32, Math.round((gw * H) / W));
  const ownerGrid = new Int16Array(gw * gh).fill(-1);
  for (let i = 0; i < n; i++) {
    const region = civ.regions.of[i] ?? -1;
    const id = region >= 0 ? (civ.polity[region] ?? -1) : -1;
    if (id < 0) continue;
    const gx = Math.min(gw - 1, Math.max(0, Math.floor(((world.mesh.x[i] ?? 0) / world.width) * gw)));
    const gy = Math.min(gh - 1, Math.max(0, Math.floor(((world.mesh.y[i] ?? 0) / world.height) * gh)));
    ownerGrid[gy * gw + gx] = id;
  }
  return {
    width: W,
    height: H,
    rgba: px,
    grid: { w: gw, h: gh, owner: Array.from(ownerGrid) },
    colors,
    borders: pixels.borders,
    regions: pixels.regions,
    fingerprint: '',
  };
}

/* ------------------------------------------------------------------ *
 * 会话状态(给前端)
 * ------------------------------------------------------------------ */

function trimRound(r: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = { ...r };
  delete o.briefs; // 简报正文很长,查看器不需要
  return o;
}

function neighborNames(civ: Civ, id: number, year: number): { id: number; name: string }[] {
  const set = monarchBorders(civ, civ.polity, id, year);
  const out: { id: number; name: string }[] = [];
  for (const nid of set) {
    const p = civ.polities[nid];
    out.push({ id: nid, name: p ? polityName(p, year) : `P${nid}` });
  }
  return out;
}

function stateView(s: Session): Record<string, unknown> {
  const st = stateGet(s, { chronicle: false });
  const civ = s.civ;
  const world = s.world;
  const year = gameYearOf(s.play.year);
  // 历史遗留的 playerPolityId 可能指向已被删除 / 越界的国家:polityName 收到 undefined 会抛,先守卫
  const playerPolity = s.playerPolityId != null ? civ.polities[s.playerPolityId] : undefined;
  const polities = (st.polities as PolityView[]).map((p) => {
    const pol: Polity | undefined = civ.polities[p.id];
    const cap = p.capital >= 0 ? civ.settlements[p.capital] : undefined;
    const cell = cap ? cap.cell : -1;
    const capital =
      cell >= 0
        ? { x: (world.mesh.x[cell] ?? 0) / world.width, y: (world.mesh.y[cell] ?? 0) / world.height }
        : null;
    return {
      ...p,
      color: pol ? hexOf(pol.color as unknown as RGB) : '#808080',
      capital,
      neighbors: neighborNames(civ, p.id, year),
    };
  });

  const chron = chronicleGet(s, { limit: 500 });
  const events = chron.entries;
  const wars = events.filter((e) => e.kind === 'war' && e.year <= year && e.end >= year);

  const kingIds = s.monarch
    ? pickMonarchIds(civ, year, (s.monarch.config as unknown as { polities: 'all' | number | number[] }).polities)
    : [];
  // 只数「控制方式 = AI」的国家:标成 program 的国家由引擎自动推演,不占君主席位
  const kingCount = kingIds.filter((id) => nationControlOf(s, id) === 'ai').length;
  // P5:君主面板(每个 AI 国的 AP / 位置 / 后代 / 日志);当前选中国优先
  const panels = s.monarch ? monarchPanels(s) : [];
  const focusPanel = panels.find((p) => p.polityId === s.playerPolityId) ?? panels[0] ?? null;

  return {
    summary: sessionSummary(s),
    year,
    playYear: s.play.year,
    stepYears: s.stepYears,
    rounds: s.rounds,
    maxRounds: s.maxRounds,
    endYear: s.endYear ?? null,
    finished: isFinished(s),
    dmPreset: s.dmPreset ?? null,
    fingerprint: st.fingerprint,
    polities,
    wars,
    events: events.slice(-140).reverse(),
    chronicleTotal: chron.total,
    commandQueue: st.commandQueue,
    commands: st.commands,
    monarch: s.monarch ? { ...monarchStatus(s), kingCount } : null,
    monarchRounds: s.monarch ? s.monarch.rounds.map(trimRound) : [],
    // P5:君主机制(行动点 / 位置 / 后代 / 事件日志);monarchAp 等是「当前聚焦国」的便捷别名
    monarchPanels: panels,
    monarchAp: focusPanel?.ap ?? null,
    monarchLocation: focusPanel?.location ?? null,
    monarchHeirs: focusPanel?.heirs ?? [],
    // DM 小决策(oracle)的状态;天灾会真改引擎,小贸易只记叙事
    dm: s.dm ? dmStatus(s) : null,
    dmRounds: s.dm
      ? s.dm.rounds.map((r) => {
          const o = r as Record<string, unknown>;
          return {
            round: o.round,
            year: o.year,
            fromYear: o.fromYear,
            toYear: o.toYear,
            source: o.source,
            reason: o.reason,
            decisions: Array.isArray(o.decisions) ? o.decisions : [],
            notes: Array.isArray(o.notes) ? o.notes : [],
            changes: Array.isArray(o.changes) ? o.changes : [],
            fingerprint: o.fingerprint,
          };
        })
      : [],
    // 小事件裁决层(Jev)的状态;小事会先结算,再进君主/DM 回合
    petty: s.petty ? pettyStatus(s) : null,
    pettyRounds: s.petty
      ? s.petty.rounds.map((r) => {
          const o = r as Record<string, unknown>;
          return {
            round: o.round,
            year: o.year,
            fromYear: o.fromYear,
            toYear: o.toYear,
            source: o.mock === true ? 'mock' : 'jev',
            events: o.events,
            decisions: Array.isArray(o.decisions) ? o.decisions : [],
            commands: o.commands,
            fallbackCount: o.fallbackCount,
            tokens: o.tokens,
            fingerprint: o.fingerprint,
          };
        })
      : [],
    // 本局「魔力」场(逐年演化、真实影响城上限);没开 = null
    magic: magicView(s),
    // 让前端能直接拿到君主信息(与 polities[].ruler 相同,单独列一份方便调试)
    monarchOn: !!s.monarch,
    // 双开关 / 复核 / 角色卡 / 记忆 / 情报
    features: s.features,
    review: s.review,
    cards: s.cards ? [...s.cards.values()] : [],
    // 本局君主寿命(岁):默认 90;开局角色卡启用种族系统时按卡上的 lifespan
    monarchLifespan: s.monarch?.lifespan ?? CARD_LIFESPAN_DEFAULT,
    memory: s.memory ? [...s.memory.values()] : [],
    intel: s.intel ?? {},
    pendingPlan: !!s.pendingPlan,
    // 开局定制(角色卡/起始疆域);没定制 = null
    customStart: s.customStart ? { ...s.customStart, warnings: [...s.customStart.warnings] } : null,
    // 开局国家设置(数量 / 控制方式 / 增删):nationControl 是应用后的即时结果
    nationControl: nationControlView(s),
    startSetup: s.startSetup ?? null,
    pendingStartSetup: s.pendingStartSetup ?? null,
    // DM 硬命令(上帝视角):不依赖任何"玩家国家";playerPolityId 只是历史遗留的面板聚焦字段
    playerPolityId: s.playerPolityId ?? null,
    playerPolityName: playerPolity ? polityName(playerPolity, year) : null,
    playerCommands: playerCommandView(s),
  };
}

/* ------------------------------------------------------------------ *
 * 会话表 / 缓存
 * ------------------------------------------------------------------ */

/**
 * 所有内存缓存统一的封顶容器:超过上限时淘汰最久没用到的键(LRU),
 * 取代原来散落在各处的「size > N 就 clear()」(那会把热数据一起冲掉)。
 * set 返回被淘汰的 key,供 tileCache 同步清掉 tileLines 这类伴生缓存。
 */
class BoundedCache<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  has(key: string): boolean { return this.map.has(key); }

  set(key: string, value: V): string[] {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    const evicted: string[] = [];
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
      evicted.push(oldest);
    }
    return evicted;
  }

  delete(key: string): boolean { return this.map.delete(key); }

  /** 按前缀清理:会话状态变了,把该会话所有回合的旧缓存一次性作废 */
  deletePrefix(prefix: string): void {
    for (const key of [...this.map.keys()]) if (key.startsWith(prefix)) this.map.delete(key);
  }

  keys(): IterableIterator<string> { return this.map.keys(); }
  clear(): void { this.map.clear(); }
  get size(): number { return this.map.size; }
}

/** 按会话缓存的键统一带回合号:同一回合里的开局设置/改卡会改状态但年份不一定变,
 * 只靠 fingerprint 可能命中旧缓存;加上 rounds 后每次推演自然换键。 */
function sessionKey(s: Session, ...parts: (string | number)[]): string {
  return [s.id, `r${s.rounds}`, ...parts].join('|');
}

const baseCache = new BoundedCache<Buffer>(64);
/** 瓦片像素的渲染版本:terrain.ts 改了底图 / 瓦片的上色、河网等算法时 +1 */
const TILE_RENDER_VER = 11;
/** 高清瓦片:key = worldId | 画法 | 渲染版本 | LOD | 球面展开坐标上的块号 */
const tileCache = new BoundedCache<Buffer>(192);
/** 每块瓦片自己的海岸 / 湖岸线(按该块的倍率追的,和这块地形严丝合缝) */
const tileLines = new BoundedCache<{ sea: number[][]; lake: number[][] }>(192);
/** 矢量层(海岸线 / 波纹 / 符号):按世界缓存一份 JSON */
const vectorCache = new BoundedCache<string>(32);
const ownerCache = new BoundedCache<{ fingerprint: string; json: Record<string, unknown> }>(64);
const chronCache = new BoundedCache<{ fingerprint: string; entries: EventView[]; total: number }>(64);
/** 场的计算层帧缓存:键 = worldId|kind|seed|scale;同世界同参数只算一次 */
const fieldFrames = new BoundedCache<FieldFrame>(32);
/** 场的渲染层缓存:键 = frame.hash|样式 JSON;改样式只重画,不动计算层 */
const fieldPngs = new BoundedCache<{ png: Buffer; legend: unknown }>(48);
/** 「魔力」动态图层的 PNG 缓存:键 = sessionKey(年份) */
const magicPngs = new BoundedCache<{ png: Buffer; legend: unknown; frameYear: number | null }>(24);
/** 「魔力」高清瓦片缓存:键 = sessionKey(年份|S|x|y|size) */
const magicTilePngs = new BoundedCache<Buffer>(512);
/** 疆域高清瓦片缓存:键 = sessionKey(状态指纹|S|x|y|size) */
const ownerTilePngs = new BoundedCache<Buffer>(512);
/** 标签层缓存:键 = sessionKey(年份) */
const labelsCache = new BoundedCache<string>(8);
const dialogueCache = new BoundedCache<string>(16);
const veinCache = new BoundedCache<string>(16);
/** Region atlas cache: key = sessionKey(fingerprint|scale) */
const atlasCache = new BoundedCache<string>(6);

/** 会话状态变了:整张疆域图和它的疆域瓦片都作废(按会话前缀清,覆盖该会话所有回合号) */
function invalidateOwnerCache(sid: string): void {
  const prefix = `${sid}|`;
  ownerCache.deletePrefix(prefix);
  ownerTilePngs.deletePrefix(prefix);
  atlasCache.deletePrefix(prefix);
  // 标签层也按会话缓存:开局增删国家发生在同一回合里,年份没变,不清理会继续显示已删国家的国名。
  labelsCache.deletePrefix(prefix);
  chronCache.deletePrefix(prefix);
}

function optNum(v: string | null): number | undefined {
  if (v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function fieldKindOf(v: string | null): FieldKind {
  const kind = (v ?? 'magic') as FieldKind;
  if (!FIELD_KINDS.includes(kind)) throw new Error('kind 只能是 magic / ore / radiation');
  return kind;
}

function getFieldFrameCached(world: World, worldId: string, kind: FieldKind, seed?: number, scale?: number): FieldFrame {
  const key = `${worldId}|${kind}|${seed ?? ''}|${scale ?? ''}`;
  const hit = fieldFrames.get(key);
  if (hit) return hit;
  const frame = fieldFrame(world, kind, { seed, scale });
  fieldFrames.set(key, frame);
  return frame;
}

function fieldStyleOf(url: URL): FieldStyle {
  const q = url.searchParams;
  const ramp = q.get('ramp') ?? DEFAULT_FIELD_STYLE.ramp;
  const stretch = q.get('stretch') === 'minmax' ? 'minmax' : 'p1p99';
  const opacity = Math.min(1, Math.max(0.05, optNum(q.get('opacity')) ?? DEFAULT_FIELD_STYLE.opacity));
  let contour: boolean | number = q.get('contour') !== '0';
  const levels = optNum(q.get('contour'));
  if (contour && levels !== undefined) contour = Math.max(2, Math.min(16, Math.round(levels)));
  return {
    ramp: (FIELD_RAMPS.includes(ramp as FieldRamp) ? ramp : DEFAULT_FIELD_STYLE.ramp) as FieldRamp,
    stretch,
    opacity,
    contour,
    glow: q.get('glow') !== '0',
    hillshade: q.get('hillshade') !== '0',
    smooth: q.get('smooth') !== '0',
  };
}

function sendPng(res: ServerResponse, png: Buffer): void {
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
  res.end(png);
}

/**
 * 地形底图与瓦片:同一个 worldId / 画法 / 倍率 / 块号永远对应同一张图(世界是不可变的),
 * 所以让浏览器长期缓存。前端 URL 上带 v=,改了渲染算法就把 MAP_VER 加一。
 *
 * 效果:刷新页面、来回切倍率都不再走网络,直接命中磁盘缓存;服务端那 192 块的
 * 上限也就不会被"同一批块反复重传"挤掉。
 */
function sendImmutablePng(res: ServerResponse, png: Buffer): void {
  res.writeHead(200, {
    'content-type': 'image/png',
    'cache-control': 'public, max-age=31536000, immutable',
  });
  res.end(png);
}

/** 瓦片自带的海岸线,和瓦片同 key、同缓存策略 */
function sendImmutableJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=31536000, immutable',
  });
  res.end(JSON.stringify(body));
}


function styleOf(q: URLSearchParams): TerrainStyle {
  const s = q.get('style');
  return isTerrainStyle(s) ? s : 'fantasy';
}

interface TileQuery {
  worldId: string;
  style: TerrainStyle;
  S: number;
  x: number;
  y: number;
  size: number;
  key: string;
}

/** /api/map/tile 与 /api/map/coast 共用一套参数,不合法就抛(路由里翻成 400) */
function parseTileQuery(q: URLSearchParams): TileQuery {
  const worldId = q.get('worldId') ?? '';
  if (!worldId) throw new Error('缺 worldId');
  const S = Number(q.get('S'));
  const x = Number(q.get('x'));
  const y = Number(q.get('y'));
  const size = Number(q.get('size'));
  if (!Number.isFinite(S) || S < 0.25 || S > 24) throw new Error('S 超出范围');
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('x / y 必须是数字');
  if (!Number.isInteger(size) || size < 16 || size > 1024) throw new Error('size 超出范围');
  const style = styleOf(q);
  return { worldId, style, S, x, y, size, key: `${worldId}|${style}|r${TILE_RENDER_VER}|${S}|${x}|${y}|${size}` };
}

async function getBasePng(worldId: string, style: TerrainStyle): Promise<Buffer> {
  const key = `${worldId}|${style}`;
  const hit = baseCache.get(key);
  if (hit) return hit;
  const rec = getWorldRecord(worldId);
  // 所有画法(含 classic)都走主站同一条渲染管线;首次渲染在 worker 池里跑(不阻塞其它请求),
  // 池不可用就原地渲染。
  const map = (await renderViaPool(worldId, rec.world, { kind: 'whole', style })) ?? renderWhole(rec.world, style);
  const png = encodePng(map.width, map.height, map.rgba);
  baseCache.set(key, png);
  return png;
}

/** 缓存按 LRU 简单封顶,伴生的 tileLines 跟着被淘汰的 key 一起删 */
function cacheTile(key: string, png: Buffer, lines?: { sea: number[][]; lake: number[][] }): void {
  const evicted = tileCache.set(key, png);
  for (const k of evicted) tileLines.delete(k);
  if (lines) tileLines.set(key, lines);
}

// ---- 预渲染:启动时把 S=2/4/8 的瓦片算好落盘,前端按进度条等到全部就绪 ----
const PREWARM_LEVELS = [2, 4, 8] as const;
const PREWARM_SIZE = 512;
const TILE_DISK_ROOT = resolve('.runs', 'tiles');

interface PrewarmState { state: 'running' | 'done' | 'failed'; done: number; total: number; startedAt: number; style: TerrainStyle }
const prewarmState = new BoundedCache<PrewarmState>(16);

function tileDiskPath(t: TileQuery, ext = 'png'): string {
  return join(TILE_DISK_ROOT, t.worldId, t.style, `v${TILE_RENDER_VER}`, String(t.S), `${t.x}_${t.y}_${t.size}.${ext}`);
}

function readTileDisk(t: TileQuery, ext = 'png'): Buffer | undefined {
  try {
    const p = tileDiskPath(t, ext);
    return existsSync(p) ? readFileSync(p) : undefined;
  } catch { return undefined; }
}

function writeTileDisk(t: TileQuery, png: Buffer, lines?: { sea: number[][]; lake: number[][] }): void {
  try {
    const p = tileDiskPath(t);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, png);
    if (lines) writeFileSync(tileDiskPath(t, 'json'), JSON.stringify(lines));
  } catch { /* 磁盘缓存失败不影响出图 */ }
}

/** 只保留最近 keep 个世界的瓦片目录,避免 .runs 无限膨胀 */
function pruneTileDisk(keep = 1): void {
  try {
    if (!existsSync(TILE_DISK_ROOT)) return;
    const dirs = readdirSync(TILE_DISK_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, m: statSync(join(TILE_DISK_ROOT, d.name)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const d of dirs.slice(keep)) rmSync(join(TILE_DISK_ROOT, d.name), { recursive: true, force: true });
  } catch { /* 清理失败不影响启动 */ }
}

function startPrewarm(worldId: string, style: TerrainStyle): PrewarmState {
  const key = `${worldId}|${style}`;
  const cur = prewarmState.get(key);
  if (cur && cur.state === 'running') return cur;
  const jobs: TileQuery[] = [];
  for (const S of PREWARM_LEVELS) {
    const cols = 4 * S;
    const rows = 2 * S;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = col * PREWARM_SIZE;
        const y = row * PREWARM_SIZE;
        jobs.push({ worldId, style, S, x, y, size: PREWARM_SIZE, key: `${worldId}|${style}|r${TILE_RENDER_VER}|${S}|${x}|${y}|${PREWARM_SIZE}` });
      }
    }
  }
  const st: PrewarmState = { state: 'running', done: 0, total: jobs.length, startedAt: Date.now(), style };
  prewarmState.set(key, st);
  void (async () => {
    const rec = getWorldRecord(worldId);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < jobs.length) {
        const t = jobs[next++]!;
        if (!existsSync(tileDiskPath(t))) {
          const map = (await renderViaPool(worldId, rec.world, { kind: 'tile', style: t.style, S: t.S, x: t.x, y: t.y, size: t.size })) ??
            renderTile(rec.world, t.style, t.S, t.x, t.y, t.size);
          const png = encodePng(map.width, map.height, map.rgba);
          const lines = { sea: map.sea ?? [], lake: map.lake ?? [] };
          cacheTile(t.key, png, lines);
          writeTileDisk(t, png, lines);
        }
        st.done++;
      }
    };
    try {
      await Promise.all([worker(), worker(), worker(), worker()]);
      st.state = 'done';
    } catch {
      st.state = 'failed';
    }
  })();
  return st;
}

function getOwnerMap(s: Session): {
  png: Buffer;
  grid: { w: number; h: number; owner: number[] };
  colors: Record<string, string>;
  regions: number[][];
  borders: number[][];
  fingerprint: string;
  width: number;
  height: number;
} {
  const fingerprint = String(stateGet(s, { chronicle: false }).fingerprint ?? '');
  const hit = ownerCache.get(sessionKey(s));
  if (hit && hit.fingerprint === fingerprint) {
    const j = hit.json as {
      png: string;
      grid: { w: number; h: number; owner: number[] };
      colors: Record<string, string>;
      borders: number[][];
      regions: number[][];
      width: number;
      height: number;
    };
    return { ...j, png: Buffer.from(j.png, 'base64'), fingerprint };
  }
  const map = renderOwnerMap(s);
  const png = encodePng(map.width, map.height, map.rgba);
  const json = {
    png: png.toString('base64'),
    grid: map.grid,
    colors: map.colors,
    borders: map.borders,
    regions: map.regions,
    width: map.width,
    height: map.height,
  };
  ownerCache.set(sessionKey(s), { fingerprint, json });
  return {
    png,
    grid: map.grid,
    colors: map.colors,
    borders: map.borders,
    regions: map.regions,
    width: map.width,
    height: map.height,
    fingerprint,
  };
}

function eventsOf(s: Session): { entries: EventView[]; total: number } {
  const hit = chronCache.get(sessionKey(s));
  const fingerprint = String(stateGet(s, { chronicle: false }).fingerprint ?? '');
  if (hit && hit.fingerprint === fingerprint) return hit;
  const chron = chronicleGet(s, { limit: 500 });
  const v = { fingerprint, entries: chron.entries, total: chron.total };
  chronCache.set(sessionKey(s), v);
  return v;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

const HERE = typeof __dirname === 'string' ? __dirname : process.cwd();
const STATIC_DIR = [
  join(HERE, 'viewer'),
  join(HERE, '..', '..', 'viewer'),
  join(process.cwd(), 'mcp', 'viewer'),
].find((p) => existsSync(join(p, 'index.html'))) ?? join(HERE, 'viewer');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function fail(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

const BODY_MAX = 4 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    // Content-Length 明显超限时直接拒,并把流排空(不 destroy:还要写回 413 响应体)
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > BODY_MAX) {
      reject(new Error('请求体太大'));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return; // 超限后继续把流读完,但不再堆积内存
      size += chunk.length;
      if (size > BODY_MAX) {
        tooLarge = true;
        reject(new Error('请求体太大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!chunks.length) return resolveBody({});
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

interface Args {
  [key: string]: unknown;
}

function num(args: Args, key: string, fallback: number): number {
  const v = args[key];
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} 必须是数字`);
  return n;
}

const VALID_PROVIDERS = new Set(['deepseek', 'bailian', 'custom', 'mock']);

/** 放弃复核:撤销服务端待提交方案(回滚 plan 阶段落下的角色卡/继位/死亡/后代/AP/情报),幂等。
 * 不进全局锁,免得长回合正占着锁时按不到。 */
function handleMonarchCancel(res: ServerResponse, args: Args): boolean {
  const sid = String(args.sessionId ?? '');
  if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
  let s: Session;
  try { s = getSession(sid); } catch (e) {
    fail(res, 404, e instanceof Error ? e.message : String(e));
    return true;
  }
  cancelMonarchPlan(s);
  invalidateOwnerCache(s.id);
  sendJson(res, 200, { ok: true, state: stateView(s) });
  return true;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, viewer: 'civ-atlas-mcp-viewer', staticDir: STATIC_DIR });
    return true;
  }

  // 进程内会话清单(重启会清空):前端可据此恢复会话、发现没被正确清理的幽灵会话
  if (method === 'GET' && pathname === '/api/sessions') {
    sendJson(res, 200, { sessions: listSessions() });
    return true;
  }

  // 导出文件下载:只按 sessionId 定位该会话 logDir 下的 basename,
  // 拒绝 .. / 绝对路径 / 任何路径分隔符,从根上堵住路径穿越;没有先导出过就 404。
  if (method === 'GET' && pathname === '/api/export/file') {
    const sid = url.searchParams.get('sessionId') ?? '';
    const name = url.searchParams.get('name') ?? 'export.json';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    if (!name || name === '.' || name === '..' || name.includes('..') ||
        name.includes('/') || name.includes('\\') || isAbsolute(name) || basename(name) !== name) {
      fail(res, 400, 'name 只能是该会话目录下的文件名');
      return true;
    }
    const s = getSession(sid);
    const root = resolve(s.logDir);
    const file = resolve(root, name);
    if (!file.startsWith(root + sep) || !existsSync(file)) {
      fail(res, 404, '导出文件不存在,请先 POST /api/export');
      return true;
    }
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    });
    res.end(body);
    return true;
  }

  if (method === 'GET' && pathname === '/api/map/base') {
    const worldId = url.searchParams.get('worldId') ?? '';
    if (!worldId) { fail(res, 400, '缺 worldId'); return true; }
    sendImmutablePng(res, await getBasePng(worldId, styleOf(url.searchParams)));
    return true;
  }

  // 矢量层:墨线、近岸波纹、山/树符号,放大后按固定屏幕线宽画,不随倍率变粗
  if (method === 'GET' && pathname === '/api/map/vectors') {
    const worldId = url.searchParams.get('worldId') ?? '';
    if (!worldId) { fail(res, 400, '缺 worldId'); return true; }
    let json = vectorCache.get(worldId);
    if (!json) {
      const rec = getWorldRecord(worldId);
      json = JSON.stringify(renderVectors(rec.world));
      vectorCache.set(worldId, json);
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(json);
    return true;
  }

  // 细沟描线(卫星画风高倍用):底图上的沟影来自 raster 的逐像素汇流明暗,和河网不是同一套数据,
  // 所以单独下发一份折线 + 强度;只在卫星画风打开时按需拉,每世界算一次(约 2.5s)。
  if (method === 'GET' && pathname === '/api/map/veins') {
    const worldId = url.searchParams.get('worldId') ?? '';
    if (!worldId) { fail(res, 400, '缺 worldId'); return true; }
    let json = veinCache.get(worldId);
    if (!json) {
      const rec = getWorldRecord(worldId);
      json = JSON.stringify(renderVeinOverlay(rec.world));
      veinCache.set(worldId, json);
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(json);
    return true;
  }

  // 预渲染:POST 启动,GET 查进度。前端建完世界先等它把 S=2/4/8 的瓦片算完再进地图。
  if (pathname === '/api/map/prewarm') {
    const worldId = url.searchParams.get('worldId') ?? '';
    if (!worldId) { fail(res, 400, '缺 worldId'); return true; }
    const style = styleOf(url.searchParams);
    const st = method === 'POST'
      ? startPrewarm(worldId, style)
      : prewarmState.get(`${worldId}|${style}`) ?? { state: 'idle', done: 0, total: 0, startedAt: 0, style };
    sendJson(res, 200, { state: st.state, done: st.done, total: st.total, style });
    return true;
  }

  // 放大后按屏幕现算的一块(同主站 tileWorker):(x, y) 是球面展开平面上的坐标,可以越过南北极
  if (method === 'GET' && (pathname === '/api/map/tile' || pathname === '/api/map/coast')) {
    let t: TileQuery;
    try {
      t = parseTileQuery(url.searchParams);
    } catch (e) {
      fail(res, 400, e instanceof Error ? e.message : '瓦片参数不合法');
      return true;
    }
    const render = async (): Promise<{ png: Buffer; sea: number[][]; lake: number[][] }> => {
      const rec = getWorldRecord(t.worldId);
      // 池里渲染后再送回主线程编码;池不可用/超时就回退单进程。
      const map =
        (await renderViaPool(t.worldId, rec.world, { kind: 'tile', style: t.style, S: t.S, x: t.x, y: t.y, size: t.size })) ??
        renderTile(rec.world, t.style, t.S, t.x, t.y, t.size);
      return { png: encodePng(map.width, map.height, map.rgba), sea: map.sea ?? [], lake: map.lake ?? [] };
    };
    if (pathname === '/api/map/tile') {
      let png = tileCache.get(t.key) ?? readTileDisk(t);
      if (!png) {
        const r = await render();
        cacheTile(t.key, r.png, { sea: r.sea, lake: r.lake });
        writeTileDisk(t, r.png, { sea: r.sea, lake: r.lake });
        png = r.png;
      }
      sendImmutablePng(res, png);
      return true;
    }
    // 海岸线:按这块瓦片自己的倍率追的,和这块的地形严丝合缝(1 倍底图追的那份放大后会对不上)
    let lines = tileLines.get(t.key);
    if (!lines) {
      const disk = readTileDisk(t, 'json');
      if (disk) {
        try { lines = JSON.parse(disk.toString('utf8')) as { sea: number[][]; lake: number[][] }; } catch { lines = undefined; }
      }
    }
    if (!lines) {
      const r = await render();
      lines = { sea: r.sea, lake: r.lake };
      cacheTile(t.key, r.png, lines);
      writeTileDisk(t, r.png, lines);
    }
    sendImmutableJson(res, lines);
    return true;
  }

  if (method === 'GET' && pathname === '/api/map/owners') {
    const sid = url.searchParams.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    const s = getSession(sid);
    const m = getOwnerMap(s);
    sendJson(res, 200, {
      png: m.png.toString('base64'),
      grid: m.grid,
      colors: m.colors,
      width: m.width,
      height: m.height,
      borders: m.borders,
      regions: m.regions,
      fingerprint: m.fingerprint,
    });
    return true;
  }

  // 标签层:地名 / 河名 / 湖名 / 国名,按会话当前年份生成(几百条,JSON 传一次)
  if (method === 'GET' && pathname === '/api/labels') {
    const sid = url.searchParams.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    const s = getSession(sid);
    const year = s.play.year;
    const key = sessionKey(s, year);
    let json = labelsCache.get(key);
    if (!json) {
      json = JSON.stringify(buildLabels(s.world, s.civ, { year }));
      labelsCache.set(key, json);
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(json);
    return true;
  }

  // 疆域高清瓦片:放大后按当前倍率现算一块(和 /api/map/tile 同一套坐标约定);
  // 整张疆域网(/api/map/owners)仍负责缩小时的兜底 + 240 网格 + 国界线。
  if (method === 'GET' && pathname === '/api/map/owner-tile') {
    const q = url.searchParams;
    const sid = q.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    const S = Number(q.get('S'));
    const x = Number(q.get('x'));
    const y = Number(q.get('y'));
    const size = Number(q.get('size'));
    if (!Number.isFinite(S) || S < 0.25 || S > 24) { fail(res, 400, 'S 超出范围'); return true; }
    if (!Number.isFinite(x) || !Number.isFinite(y)) { fail(res, 400, 'x / y 必须是数字'); return true; }
    if (!Number.isInteger(size) || size < 16 || size > 1024) { fail(res, 400, 'size 超出范围'); return true; }
    const s = getSession(sid);
    const fingerprint = String(stateGet(s, { chronicle: false }).fingerprint ?? '');
    const key = sessionKey(s, fingerprint, S, x, y, size);
    const hit = ownerTilePngs.get(key);
    if (hit) { sendPng(res, hit); return true; }
    const civ = ownerCivData(s.civ);
    const map =
      (await renderViaPool(worldIdOf(s.worldParams), s.world, { kind: 'owner', S, x, y, size, civ })) ??
      renderOwnerTilePixels(s.world, civ, S, x, y, size);
    const png = encodePng(map.width, map.height, map.rgba);
    ownerTilePngs.set(key, png);
    sendPng(res, png);
    return true;
  }

  // 州信息:鼠标悬停时按世界像素查这一州的归属 / 群落 / 河流(像素→州 的索引服务端按世界缓存)
  if (method === 'GET' && pathname === '/api/map/region-info') {
    const q = url.searchParams;
    const sid = q.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    const x = Number(q.get('x'));
    const y = Number(q.get('y'));
    if (!Number.isFinite(x) || !Number.isFinite(y)) { fail(res, 400, 'x / y 必须是数字'); return true; }
    const s = getSession(sid);
    const info = regionInfoAt(s.world, s.civ, x, y);
    sendJson(res, 200, { info });
    return true;
  }

  // Region atlas: downsampled pixel->region grid (gzip base64) + all region metadata.
  // The client keeps it locally so hover needs zero requests; built once per session state.
  if (method === 'GET' && pathname === '/api/map/region-atlas') {
    const q = url.searchParams;
    const sid = q.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, 'missing sessionId'); return true; }
    const scale = Math.max(1, Math.min(8, Math.round(Number(q.get('scale') ?? 2)) || 2));
    const s = getSession(sid);
    const fingerprint = String(stateGet(s, { chronicle: false }).fingerprint ?? '');
    const key = sessionKey(s, fingerprint, scale);
    let json = atlasCache.get(key);
    if (!json) {
      const at = regionAtlas(s.world, s.civ, scale);
      const buf = Buffer.from(at.data.buffer, at.data.byteOffset, at.data.byteLength);
      const gz = gzipSync(buf, { level: 6 });
      json = JSON.stringify({
        w: at.w,
        h: at.h,
        scale: at.scale,
        regions: at.regions,
        // 州 → 国 对照(每州所属国 id,-1 无主),开局连续点选用,客户端不用再拉新接口
        owner: Array.from(s.civ.polity.subarray(0, s.civ.regions.count)),
        dataGzB64: gz.toString('base64'),
      });
      atlasCache.set(key, json);
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(json);
    return true;
  }

  // DM 对话 / Jev 裁决:从会话日志里整理出“每回合说了什么、裁了什么”,日志页签直接渲染
  if (method === 'GET' && pathname === '/api/dialogue') {
    const q = url.searchParams;
    const sid = q.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    const s = getSession(sid);
    const rawLimit = q.get('limit');
    const limit = Math.max(1, Math.min(500, Math.round(
      rawLimit === null || rawLimit === '' ? 80 : Number(rawLimit),
    )));
    if (!Number.isFinite(limit)) { fail(res, 400, 'limit 必须是数字'); return true; }
    const kindRaw = q.get('kind');
    const kind = kindRaw === 'dm' || kindRaw === 'jev' || kindRaw === 'monarch' ? kindRaw : undefined;
    const fingerprint = String(stateGet(s, { chronicle: false }).fingerprint ?? '');
    const key = sessionKey(s, fingerprint, limit, kind ?? '');
    let json = dialogueCache.get(key);
    if (!json) {
      json = JSON.stringify(dialogueView(s, { limit, kind }));
      dialogueCache.set(key, json);
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(json);
    return true;
  }

  if (method === 'GET' && pathname === '/api/field/meta') {
    sendJson(res, 200, {
      kinds: FIELD_KINDS.map((kind) => ({ kind, label: FIELD_LABEL[kind] })),
      ramps: FIELD_RAMPS,
      defaults: DEFAULT_FIELD_STYLE,
    });
    return true;
  }

  if (method === 'GET' && pathname === '/api/field/base') {
    const worldId = url.searchParams.get('worldId') ?? '';
    if (!worldId) { fail(res, 400, '缺 worldId'); return true; }
    const rec = getWorldRecord(worldId);
    if (!rec) { fail(res, 400, '世界不存在(先创建世界)'); return true; }
    const q = url.searchParams;
    const kind = fieldKindOf(q.get('kind'));
    const seed = optNum(q.get('seed'));
    const scale = optNum(q.get('scale'));
    const frame = getFieldFrameCached(rec.world, worldId, kind, seed, scale);
    const style = fieldStyleOf(url);
    const key = `${frame.hash}|${JSON.stringify(style)}`;
    const hit = fieldPngs.get(key);
    if (hit) { sendPng(res, hit.png); return true; }
    const out = renderFieldMap(rec.world, frame, style);
    fieldPngs.set(key, { png: out.png, legend: out.legend });
    sendPng(res, out.png);
    return true;
  }

  if (method === 'GET' && pathname === '/api/field/data') {
    const worldId = url.searchParams.get('worldId') ?? '';
    if (!worldId) { fail(res, 400, '缺 worldId'); return true; }
    const rec = getWorldRecord(worldId);
    if (!rec) { fail(res, 400, '世界不存在(先创建世界)'); return true; }
    const q = url.searchParams;
    const kind = fieldKindOf(q.get('kind'));
    const seed = optNum(q.get('seed'));
    const scale = optNum(q.get('scale'));
    const frame = getFieldFrameCached(rec.world, worldId, kind, seed, scale);
    const style = fieldStyleOf(url);
    const data = fieldDataJson(rec.world, frame, Math.max(16, Math.min(1024, optNum(q.get('gridW')) ?? 256)));
    // 图例随数据返回(只算色带/刻度,不重画 PNG),前端显示真实刻度
    sendJson(res, 200, {
      ...data,
      style,
      legend: fieldLegend(frame, style),
      kinds: FIELD_KINDS.map((k) => ({ kind: k, label: FIELD_LABEL[k] })),
    });
    return true;
  }

  if (method === 'GET' && pathname === '/api/field/legend') {
    const worldId = url.searchParams.get('worldId') ?? '';
    if (!worldId) { fail(res, 400, '缺 worldId'); return true; }
    const rec = getWorldRecord(worldId);
    if (!rec) { fail(res, 400, '世界不存在(先创建世界)'); return true; }
    const q = url.searchParams;
    const kind = fieldKindOf(q.get('kind'));
    const seed = optNum(q.get('seed'));
    const scale = optNum(q.get('scale'));
    const frame = getFieldFrameCached(rec.world, worldId, kind, seed, scale);
    sendJson(res, 200, fieldLegend(frame, fieldStyleOf(url)));
    return true;
  }



  if (method === 'GET' && pathname === '/api/magic/meta') {
    const sid = url.searchParams.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    const s = getSession(sid);
    const colors = parseMagicColors(url.searchParams.get('colors'));
    const view = magicView(s);
    sendJson(res, 200, {
      enabled: !!view,
      strength: view?.strength ?? null,
      layers: view?.layers ?? [],
      legend: magicLegendOf(s.civ, s.play.year, colors ?? undefined),
      year: s.play.year,
      yearNow: gameYearOf(s.play.year),
    });
    return true;
  }

  if (method === 'GET' && pathname === '/api/magic/base') {
    const sid = url.searchParams.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    const s = getSession(sid);
    const layer = magicLayerOf(s.civ);
    if (!layer) { fail(res, 404, '这个会话没有开「魔力」场(开会话时 magicField:true)'); return true; }
    const colors = parseMagicColors(url.searchParams.get('colors'));
    const colorKey = colors ? colors.join(',') : '';
    const asked = optNum(url.searchParams.get('year'));
    const lo = layer.years[0];
    if (lo === undefined) { fail(res, 404, '魔力图层还没有帧(推演一回合后再看)'); return true; }
    const year = asked === undefined ? s.play.year : Math.min(s.play.year, Math.max(lo, asked));
    const key = sessionKey(s, year, colorKey);
    const hit = magicPngs.get(key);
    if (hit) { sendPng(res, hit.png); return true; }
    const style = colors ? { ...DEFAULT_MAGIC_STYLE, colors } : DEFAULT_MAGIC_STYLE;
    const out = renderMagicMap(s.world, s.civ, year, style);
    if (!out) { fail(res, 404, '没有魔力图层'); return true; }
    magicPngs.set(key, { png: out.png, legend: out.legend, frameYear: out.frameYear });
    sendPng(res, out.png);
    return true;
  }

  if (method === 'GET' && pathname === '/api/magic/data') {
    const sid = url.searchParams.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    const s = getSession(sid);
    const layer = magicLayerOf(s.civ);
    if (!layer) { fail(res, 404, '这个会话没有开「魔力」场(开会话时 magicField:true)'); return true; }
    const colors = parseMagicColors(url.searchParams.get('colors'));
    const asked = optNum(url.searchParams.get('year'));
    const lo = layer.years[0];
    if (lo === undefined) { fail(res, 404, '魔力图层还没有帧(推演一回合后再看)'); return true; }
    const year = asked === undefined ? s.play.year : Math.min(s.play.year, Math.max(lo, asked));
    const data = magicDataJson(s.world, s.civ, s.id, year, Math.max(32, Math.min(512, optNum(url.searchParams.get('gridW')) ?? 256)), colors ?? undefined);
    if (!data) { fail(res, 404, '没有魔力图层'); return true; }
    sendJson(res, 200, { ...data, legend: magicLegendOf(s.civ, year, colors ?? undefined) });
    return true;
  }

  if (method === 'GET' && pathname === '/api/magic/tile') {
    const q = url.searchParams;
    const sid = q.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    const s = getSession(sid);
    const layer = magicLayerOf(s.civ);
    if (!layer) { fail(res, 404, '这个会话没有开「魔力」场(开会话时 magicField:true)'); return true; }
    const S = Number(q.get('S'));
    const x = Number(q.get('x'));
    const y = Number(q.get('y'));
    const size = Number(q.get('size'));
    if (!Number.isFinite(S) || S < 0.25 || S > 24) { fail(res, 400, 'S 超出范围'); return true; }
    if (!Number.isFinite(x) || !Number.isFinite(y)) { fail(res, 400, 'x / y 必须是数字'); return true; }
    if (!Number.isInteger(size) || size < 16 || size > 1024) { fail(res, 400, 'size 超出范围'); return true; }
    const asked = optNum(q.get('year'));
    const lo = layer.years[0];
    if (lo === undefined) { fail(res, 404, '魔力图层还没有帧(推演一回合后再看)'); return true; }
    const year = asked === undefined ? s.play.year : Math.min(s.play.year, Math.max(lo, asked));
    const colors = parseMagicColors(q.get('colors'));
    const colorKey = colors ? colors.join(',') : '';
    const key = sessionKey(s, year, S, x, y, size, colorKey);
    const hit = magicTilePngs.get(key);
    if (hit) { sendPng(res, hit); return true; }
    const style = colors ? { ...DEFAULT_MAGIC_STYLE, colors } : DEFAULT_MAGIC_STYLE;
    const out = renderMagicTile(s.world, s.civ, year, S, x, y, size, style);
    if (!out) { fail(res, 404, '没有魔力图层'); return true; }
    magicTilePngs.set(key, out.png);
    sendPng(res, out.png);
    return true;
  }

  if (method === 'GET' && pathname === '/api/start/config') {
    const sid = url.searchParams.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    sendJson(res, 200, startConfigStatus(getSession(sid)));
    return true;
  }

  if (method === 'GET' && pathname === '/api/start/nations') {
    const sid = url.searchParams.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    const s = getSession(sid);
    sendJson(res, 200, { nations: listStartNations(s) });
    return true;
  }

  // P1.5:新建国家表单的「🎲自动命名」;规则与服务端自动命名一致,不撞现有国名
  if (method === 'GET' && pathname === '/api/start/auto-name') {
    const sid = url.searchParams.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    const s = getSession(sid);
    sendJson(res, 200, { name: autoNationName(s) });
    return true;
  }

  if (method === 'GET' && pathname === '/api/state') {
    const sid = url.searchParams.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    sendJson(res, 200, stateView(getSession(sid)));
    return true;
  }

  if (method === 'GET' && pathname === '/api/rounds') {
    const sid = url.searchParams.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    const s = getSession(sid);
    sendJson(res, 200, { sessionId: sid, rounds: s.monarch ? s.monarch.rounds.map(trimRound) : [] });
    return true;
  }

  if (method === 'GET' && pathname === '/api/chronicle') {
    const sid = url.searchParams.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    const s = getSession(sid);
    const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit') ?? 200)));
    sendJson(res, 200, chronicleGet(s, { limit }));
    return true;
  }

  if (method === 'POST') {
    let args: Args;
    try {
      args = (await readBody(req)) as Args;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      fail(res, message === '请求体太大' ? 413 : 400, message);
      return true;
    }
    // 放弃复核不需要排队:长回合可能正占着全局锁,而它只清待提交方案、不改推演状态
    if (pathname === '/api/monarch/cancel') return handleMonarchCancel(res, args);
    return await withPostLock(() => handlePost(res, pathname, args));
  }

  return false;
}

/** engine 的全局会话锁(单参数重载):所有写操作串行,避免并发改同一份会话状态。 */
function withPostLock<T>(fn: () => Promise<T>): Promise<T> {
  return withSessionLock(fn) as Promise<T>;
}

/** 所有会改会话状态的 POST 在这里串行执行;readBody / cancel 已在锁外处理完。 */
async function handlePost(res: ServerResponse, pathname: string, args: Args): Promise<boolean> {
  if (pathname === '/api/world') {
      const seed = num(args, 'seed', 7);
      const cells = num(args, 'cells', 34043);
      const rec = createWorld({ seed, params: { cells } });
      sendJson(res, 200, {
        worldId: rec.id,
        seed: rec.params.seed,
        cells: rec.params.cells,
        width: rec.world.width,
        height: rec.world.height,
        generatedMs: rec.generatedMs,
        maxElevation: Math.round(rec.world.maxElevation),
      });
      return true;
    }

    if (pathname === '/api/session') {
      const worldId = String(args.worldId ?? '');
      if (!worldId) { fail(res, 400, '缺 worldId'); return true; }
      const startYear = num(args, 'startYear', 2500);
      const stepYears = num(args, 'stepYears', 5);
      const maxRounds = num(args, 'maxRounds', 12);
      const dmPreset = args.dmPreset === true ? true : undefined;
      const magicField = args.magicField === true
        ? (Number.isFinite(Number(args.magicStrength)) ? Number(args.magicStrength) : true)
        : undefined;
      const features = {
        llm: args.features && typeof args.features === 'object' ? (args.features as Record<string, unknown>).llm !== false : true,
        jev: args.features && typeof args.features === 'object' ? (args.features as Record<string, unknown>).jev === true : false,
      };
      // 开局国家设置(数量 / 控制方式 / 增删):可以在建会话时一起带上,建完立刻应用
      const setupArg =
        args.setup && typeof args.setup === 'object' && !Array.isArray(args.setup)
          ? (args.setup as StartSetupInput)
          : undefined;
      const { session } = openSession({
        worldId,
        startYear,
        stepYears,
        maxRounds,
        mode: 'monarch',
        features,
        review: args.review === true,
        ...(dmPreset ? { dmPreset: true } : {}),
        ...(magicField !== undefined ? { magicField } : {}),
        ...(setupArg ? { setup: setupArg } : {}),
      });
      let startSetup: unknown = null;
      if (setupArg) {
        try {
          startSetup = applyStartSetup(session);
        } catch (e) {
          // 会话已经注册进引擎,但前端这次拿不到 id:删掉它 + 清掉日志目录,
          // 别留一个谁也访问不到的幽灵会话(内存和磁盘都算)
          deleteSession(session.id);
          try { rmSync(session.logDir, { recursive: true, force: true }); } catch { /* 清理失败不盖掉原始错误 */ }
          fail(res, 400, e instanceof Error ? e.message : String(e));
          return true;
        }
      }
      invalidateOwnerCache(session.id);
      // 摘要必须在应用 setup 之后重取:openSession 返回的还是 pendingStartSetup 的旧快照
      sendJson(res, 200, { session: sessionSummary(session), state: stateView(session), ...(startSetup ? { startSetup } : {}) });
      return true;
    }

    // 角色卡:从生平推断性格(LLM 可用且 DM 非 mock 时走 LLM,否则关键词规则;离线也有结果)
    if (pathname === '/api/start/infer-card') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      const biography = typeof args.biography === 'string' ? args.biography : '';
      let result: unknown;
      try {
        result = await inferCardFromBiography(s, biography, { llm: args.llm !== false });
      } catch (e) {
        fail(res, 400, e instanceof Error ? e.message : String(e));
        return true;
      }
      sendJson(res, 200, { ok: true, result });
      return true;
    }

    // 落点预览:只算不改状态(P1.6 落点 hover/无城市引导用;无城市年份返回 409 NO_CITIES)
    if (pathname === '/api/start/preview-nation') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      const atRaw = args.at as Record<string, unknown> | undefined;
      const input: { at?: { x: number; y: number }; size?: number; allowExclaves?: boolean } = {};
      if (atRaw && typeof atRaw === 'object' && Number.isFinite(Number(atRaw.x)) && Number.isFinite(Number(atRaw.y))) {
        input.at = { x: Number(atRaw.x), y: Number(atRaw.y) };
      }
      if (args.size !== undefined && args.size !== null && args.size !== '') input.size = num(args, 'size', 8);
      if (args.allowExclaves === true) input.allowExclaves = true;
      try {
        sendJson(res, 200, previewNationAt(s, input));
      } catch (e) {
        const err = e as Error & { code?: string };
        if (err.code === 'NO_CITIES') {
          sendJson(res, 409, { code: 'NO_CITIES', error: err.message });
        } else {
          fail(res, 400, err.message);
        }
      }
      return true;
    }

    // 开局国家设置:数量 / 控制方式 / 增删国家(只允许第一回合前,每个会话一次)
    if (pathname === '/api/session/start-setup') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      const setupYear = Math.floor(s.play.year);
      // P1.6:年份太早(如第 1 年)城市还没建立,明确 409 提示,避免前端只看到"点了没反应"
      if (!hasUsableCities(s, setupYear)) {
        sendJson(res, 409, { code: 'NO_CITIES', error: noCitiesMessage(s, setupYear) });
        return true;
      }
      const setup: Record<string, unknown> = {};
      if (args.count !== undefined && args.count !== null && args.count !== '') setup.count = num(args, 'count', 0);
      if (args.remove !== undefined) setup.remove = args.remove;
      if (args.removeRegions !== undefined) setup.removeRegions = args.removeRegions;
      if (args.controls !== undefined) setup.controls = args.controls;
      if (args.nations !== undefined) setup.nations = args.nations;
      else if (args.add !== undefined) setup.nations = args.add;
      if (args.force === true) setup.force = true;
      if (args.names !== undefined) setup.names = args.names;
      // 历史遗留兼容:旧面板会带 playerPolityId,现在界面不再发送,也不表示"玩家国家"。
      if (args.playerPolityId !== undefined) setup.playerPolityId = args.playerPolityId === null ? null : Number(args.playerPolityId);
      if (args.cleanExclaves !== undefined) setup.cleanExclaves = args.cleanExclaves;
      if (args.allowExclaves === true) setup.allowExclaves = true;
      let result: unknown;
      try {
        result = applyStartSetup(s, setup as StartSetupInput);
      } catch (e) {
        const err = e as Error & { needConfirm?: unknown };
        if (Array.isArray(err.needConfirm)) {
          // 删到最后一州:前端据此弹确认框,确认后带 force:true 再提交
          sendJson(res, 409, { error: err.message, needConfirm: err.needConfirm });
        } else {
          fail(res, 400, err.message);
        }
        return true;
      }
      invalidateOwnerCache(s.id);
      sendJson(res, 200, { ok: true, result, state: stateView(s) });
      return true;
    }

    // 开局定制:君主角色卡 + 起始疆域大小/位置(只允许第一回合前)
    if (pathname === '/api/session/custom-start') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      const customYear = Math.floor(s.play.year);
      // P1.6:无城市年份明确 409,而不是让 applyCustomStart 抛 500
      if (!hasUsableCities(s, customYear)) {
        sendJson(res, 409, { code: 'NO_CITIES', error: noCitiesMessage(s, customYear) });
        return true;
      }
      const atRaw = args.at as Record<string, unknown> | undefined;
      const input: Record<string, unknown> = {};
      if (args.polityId !== undefined && args.polityId !== null && args.polityId !== '') input.polityId = Number(args.polityId);
      if (atRaw && typeof atRaw === 'object' && Number.isFinite(Number(atRaw.x)) && Number.isFinite(Number(atRaw.y))) {
        input.at = { x: Number(atRaw.x), y: Number(atRaw.y) };
      }
      if (args.size !== undefined && args.size !== null && args.size !== '') input.size = Number(args.size);
      if (args.regionIds !== undefined && args.regionIds !== null && !Array.isArray(args.regionIds)) {
        fail(res, 400, 'regionIds 要是州号数组');
        return true;
      }
      if (Array.isArray(args.regionIds)) input.regionIds = args.regionIds;
      if (args.card && typeof args.card === 'object') input.card = args.card as Record<string, unknown>;
      if (args.autoCard === true) input.autoCard = true;
      if (args.allowExclaves === true) input.allowExclaves = true;
      const result = applyCustomStart(s, input);
      // m05242 修正:custom-start 的 polityId 只表示"要改哪一国的君主卡/疆域",不再写入 playerPolityId(没有玩家国家)。
      invalidateOwnerCache(s.id);
      sendJson(res, 200, { state: stateView(s), result });
      return true;
    }

    if (pathname === '/api/monarch/setup') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      const polities = (() => {
        const raw = args.polities;
        if (raw === undefined || raw === null || raw === '' || raw === 'all') return 'all' as const;
        if (Array.isArray(raw)) return raw.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v >= 0);
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) throw new Error('polities 只能是 "all"、一个整数或国家编号数组');
        return n;
      })();
      const provider = String(args.provider ?? 'deepseek');
      const mock = args.mock === true || provider === 'mock';
      if (!mock && !VALID_PROVIDERS.has(provider)) throw new Error(`provider 只能是 ${[...VALID_PROVIDERS].join(' / ')}`);
      const result = setupMonarch(s, {
        polities,
        maxOrders: num(args, 'maxOrders', 3),
        mock,
        provider: provider === 'mock' ? 'deepseek' : (provider as 'deepseek' | 'bailian' | 'custom'),
        model: args.model === undefined || args.model === '' ? undefined : String(args.model),
        apiKey: args.apiKey === undefined || args.apiKey === '' ? undefined : String(args.apiKey),
        baseUrl: args.baseUrl === undefined || args.baseUrl === '' ? undefined : String(args.baseUrl),
        temperature: args.temperature === undefined ? undefined : num(args, 'temperature', 0.7),
      });
      sendJson(res, 200, { setup: result, state: stateView(s) });
      return true;
    }

    if (pathname === '/api/monarch/round') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      // 复核模式必须走 plan → commit;monarchRound 内部也会拒绝,这里先给个友好提示
      if (s.review) { fail(res, 409, '复核模式下请先 /api/monarch/plan 出方案,再 /api/monarch/commit 提交'); return true; }
      const round = await monarchRound(s, args.years === undefined ? {} : { years: num(args, 'years', s.stepYears) });
      invalidateOwnerCache(s.id);
      sendJson(res, 200, { round, state: stateView(s) });
      return true;
    }

    // 复核模式:先出方案(不推演),玩家/DM 勾选后再提交
    if (pathname === '/api/monarch/plan') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      const plan = await monarchPlan(s, args.years === undefined ? {} : { years: num(args, 'years', s.stepYears) });
      sendJson(res, 200, { plan, state: stateView(s) });
      return true;
    }

    if (pathname === '/api/monarch/commit') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      const reject = Array.isArray(args.reject)
        ? (args.reject as { polityId?: unknown; index?: unknown }[])
            .map((r) => ({ polityId: Number(r.polityId), index: Number(r.index) }))
            .filter((r) => Number.isInteger(r.polityId) && Number.isInteger(r.index))
        : undefined;
      const planId = args.planId === undefined || args.planId === null || args.planId === ''
        ? undefined : String(args.planId);
      const pending = s.pendingPlan as { planId?: string } | undefined;
      if (!pending) { fail(res, 409, '没有待提交的回合方案;先跑 /api/monarch/plan'); return true; }
      // 防止把上一回合 / 另一个会话的旧方案提交到当前状态上
      if (planId !== undefined && pending.planId !== undefined && String(pending.planId) !== planId) {
        fail(res, 409, '方案已过期(planId 不匹配),请重新出方案');
        return true;
      }
      const round = await monarchCommit(s, {
        ...(reject ? { reject } : {}),
        ...(planId !== undefined ? { planId } : {}),
      });
      invalidateOwnerCache(s.id);
      sendJson(res, 200, { round, state: stateView(s) });
      return true;
    }

    // 玩家 / DM 改角色卡(只改文案与档位,不改编号)
    if (pathname === '/api/monarch/card') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      const polityId = num(args, 'polityId', 0);
      const card = setMonarchCard(s, Math.round(polityId), args.patch);
      sendJson(res, 200, { card, state: stateView(s) });
      return true;
    }

    if (pathname === '/api/dm/setup') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      const mock = args.mock === true;
      const provider = args.provider === undefined || args.provider === '' ? 'custom' : String(args.provider);
      const dm = await dmSetup(s, {
        mock,
        provider: mock ? undefined : provider,
        baseUrl: args.baseUrl === undefined || args.baseUrl === '' ? undefined : String(args.baseUrl),
        model: args.model === undefined || args.model === '' ? undefined : String(args.model),
        apiKey: args.apiKey === undefined || args.apiKey === '' ? undefined : String(args.apiKey),
        temperature: args.temperature === undefined ? undefined : num(args, 'temperature', 0.8),
        timeoutMs: args.timeoutMs === undefined ? undefined : num(args, 'timeoutMs', 120000),
        maxDecisions: args.maxDecisions === undefined ? undefined : num(args, 'maxDecisions', 2),
        probe: args.probe === true,
      });
      sendJson(res, 200, { dm, state: stateView(s) });
      return true;
    }

    if (pathname === '/api/dm/round') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      const dm = await dmRound(s, {
        ...(args.years === undefined ? {} : { years: num(args, 'years', s.stepYears) }),
        ...(Array.isArray(args.decisions) ? { decisions: args.decisions } : {}),
      });
      invalidateOwnerCache(s.id);
      sendJson(res, 200, { dm, state: stateView(s) });
      return true;
    }

    // 推演中的 DM 对话框:上帝视角直接对任意国家下硬命令(解析 → 引擎校验 → 排队,下一回合开始执行)
    // 修正(m05242):这里没有"玩家国家",命令必须显式点名国家;不再读取 playerPolityId。
    if (pathname === '/api/dm/chat') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      const text = String(args.text ?? '').trim();
      const polities = (stateGet(s, { chronicle: false }).polities as { id: number; name: string; key: string }[])
        .map((p) => ({ id: p.id, name: p.name, key: p.key }));
      const parsed = parsePlayerCommand(text, { polities });
      let reply: Record<string, unknown> = { ...parsed };
      if (parsed.ok) {
        const cleaned = cleanOrders(s.play, parsed.commands);
        if (!cleaned.commands.length) {
          reply = { ...parsed, ok: false, rejected: cleaned.rejected.map((r) => r.reason) };
        } else {
          const rec = queuePlayerCommand(s, { text, commands: parsed.commands, summary: parsed.summary });
          reply = rec
            ? { ...parsed, queued: rec }
            : { ...parsed, ok: false, rejected: ['待执行命令已满(最多 10 条),先撤销几条再发'] };
        }
      }
      sendJson(res, 200, { reply, state: stateView(s) });
      return true;
    }

    if (pathname === '/api/dm/chat/cancel') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      const rec = cancelPlayerCommand(s, Math.round(num(args, 'id', 0)));
      sendJson(res, 200, { cancelled: rec, state: stateView(s) });
      return true;
    }

    if (pathname === '/api/petty/setup') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      const mock = args.mock !== false;
      const petty = await pettySetup(s, {
        mock,
        profile: args.profile === undefined || args.profile === '' ? undefined : (String(args.profile) as 'L1' | 'L2' | 'L3'),
        maxQuestions: args.maxQuestions === undefined ? undefined : num(args, 'maxQuestions', 8),
        apiKey: args.apiKey === undefined || args.apiKey === '' ? undefined : String(args.apiKey),
        baseUrl: args.baseUrl === undefined || args.baseUrl === '' ? undefined : String(args.baseUrl),
        model: args.model === undefined || args.model === '' ? undefined : String(args.model),
        timeoutMs: args.timeoutMs === undefined ? undefined : num(args, 'timeoutMs', 120000),
        probe: args.probe === true,
      });
      sendJson(res, 200, { petty: petty.petty, state: stateView(s) });
      return true;
    }

    if (pathname === '/api/petty/round') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      const petty = await pettyRound(s, args.years === undefined ? {} : { years: num(args, 'years', s.stepYears) });
      invalidateOwnerCache(s.id);
      sendJson(res, 200, { petty, state: stateView(s) });
      return true;
    }

    if (pathname === '/api/turn') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      const turn = turnStep(s, args.years === undefined ? {} : { years: num(args, 'years', s.stepYears) });
      invalidateOwnerCache(s.id);
      sendJson(res, 200, { turn, state: stateView(s) });
      return true;
    }

    if (pathname === '/api/verify') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      sendJson(res, 200, { verify: verifySession(s) });
      return true;
    }

  if (pathname === '/api/export') {
    const sid = String(args.sessionId ?? '');
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    const s = getSession(sid);
    const out = exportSession(s);
    const filename = `civ-atlas-${sid}.json`;
    sendJson(res, 200, {
      export: out,
      filename,
      downloadUrl: `/api/export/file?sessionId=${encodeURIComponent(sid)}&name=export.json`,
    });
    return true;
  }

  return false;
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  let rel: string;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
  } catch {
    fail(res, 400, '路径编码不合法');
    return;
  }
  const file = resolve(STATIC_DIR, normalize(rel));
  const root = resolve(STATIC_DIR) + sep;
  if (!file.startsWith(root) && file !== resolve(STATIC_DIR, 'index.html')) {
    fail(res, 403, '禁止访问');
    return;
  }
  if (!existsSync(file)) {
    fail(res, 404, `找不到 ${rel}`);
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * 只给本机浏览器用:挡住 DNS rebinding / 跨站 CSRF。
 * 服务只监听 127.0.0.1,但恶意网页仍能用简单 POST 打到本机并触发副作用(推演、开会话、导出),
 * CORS 只挡响应读取、挡不住请求本身,所以按 Host / Sec-Fetch-Site / Origin 三重校验:
 *   - Host 必须是 127.0.0.1 / localhost / [::1](可带端口);
 *   - 浏览器发的 Sec-Fetch-Site 只能是 same-origin 或 none(地址栏直接访问),其余一律拒绝;
 *   - 带 Origin 时,它的主机必须也是这几个本机别名;端口允许不同,因为 /sandbox/ 是
 *     dev server(5188) 转发到监视台(随机端口),两边都是本机服务,严格比 host:port 会把
 *     这条合法路径误判成跨源攻击。
 * 外部页面伪造不了 127.0.0.1 的 Origin,DNS rebinding 的 Host 也不是本机别名(第一关已挡住)。
 * 非浏览器客户端(curl / Node fetch)不带这两个头,只按 Host 校验。
 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function checkLocalRequest(req: IncomingMessage): string | null {
  const host = (req.headers.host ?? '').toLowerCase();
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(host)) {
    return `拒绝非本机来源的 Host:${host || '(空)'}`;
  }
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'none' && site !== 'same-origin') {
    return `拒绝跨站请求(Sec-Fetch-Site: ${String(site)})`;
  }
  const origin = req.headers.origin;
  if (origin) {
    let u: URL;
    try { u = new URL(String(origin)); }
    catch { return 'Origin 不合法'; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return `拒绝非 HTTP 来源的 Origin:${u.protocol}`;
    // 只认本机别名,不比端口:浏览器按真实来源填 Origin,外部站点伪造不了它。
    if (!LOCAL_HOSTS.has(u.hostname.toLowerCase())) return `拒绝非本机来源的 Origin:${u.host}`;
  }
  return null;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const denied = checkLocalRequest(req);
  if (denied) { fail(res, 403, denied); return; }
  let url: URL;
  try {
    // 畸形 Host / 畸形 req.url 都会让 new URL 抛异常:别让它冒泡成 500 或把连接挂死
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  } catch {
    if (!res.headersSent && !res.writableEnded) fail(res, 400, '请求地址不合法');
    return;
  }
  const pathname = url.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, pathname, url);
      if (!handled) fail(res, 404, `没有这个接口:${req.method} ${pathname}`);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fail(res, 405, '静态文件只支持 GET');
      return;
    }
    serveStatic(req, res, pathname);
  } catch (e) {
    // 413 等响应可能已经写出去了,别二次写导致 ERR_STREAM_WRITE_AFTER_END
    if (res.headersSent || res.writableEnded) return;
    const message = e instanceof Error ? e.message : String(e);
    const status = /找不到|缺 |只能是|必须是|已经|没有可|请求体/.test(message) ? 400 : 500;
    fail(res, status, message);
  }
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

function parseArgs(argv: string[]): { port: number } {
  let port = 5190;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--port' && argv[i + 1] !== undefined) {
      port = Number(argv[++i]);
    } else if (a.startsWith('--port=')) {
      port = Number(a.slice('--port='.length));
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port 不合法:${String(port)}`);
  return { port };
}

/**
 * 后台渲染给前台让路:把 viewer 进程优先级降到「低于正常」。
 * 用户在别的窗口打字/聊天时,调度器会优先照顾前台应用;本进程只在有空闲 CPU 时干活。
 * 浏览器侧还有「空闲 6 秒才预取」与「拖动中不画细节层」两道闸,这里再压一层。
 */
function softenPriority(): void {
  try {
    setPriority(process.pid, osConstants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // 权限不够(或平台不支持)就算了,不影响功能
  }
}

function main(): void {
  const { port } = parseArgs(process.argv.slice(2));
  softenPriority();
  pruneTileDisk(1);
  process.on('exit', () => disposeMapPools());
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`[viewer] 本地查看器已启动:http://127.0.0.1:${port}\n`);
    process.stdout.write('[viewer] 只监听本机;Ctrl+C 退出。世界/会话数据只在这个进程内存里,重启会清空。\n');
    process.stdout.write(`[viewer] 静态文件目录:${STATIC_DIR}\n`);
  });
  server.on('error', (e) => {
    process.stderr.write(`[viewer] 启动失败:${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}

if (require.main === module) main();

export { renderWorldMap, renderOwnerMap, encodePng, stateView };
