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
import { extname, join, normalize, resolve, sep, dirname } from 'node:path';
import { deflateSync } from 'node:zlib';
import { constants as osConstants, setPriority } from 'node:os';

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
  type EventView,
  type PolityView,
  type RulerView,
  type Session,
} from './engine';
import { setupMonarch, monarchRound, monarchPlan, monarchCommit, monarchStatus, setMonarchCard, verifySession } from './monarch';
import { listStartNations, applyCustomStart } from './monarch-start';
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
import { regionInfoAt } from './region-info';
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
 * PNG 编码(node:zlib 手写,8-bit RGBA)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typ = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typ, data])), 0);
  return Buffer.concat([len, typ, data, crc]);
}

function encodePng(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * 地图配色
 * ------------------------------------------------------------------ */

function cellColor(world: World, i: number): RGB {
  const e = world.elevation[i] ?? 0;
  const water = world.water[i] ?? 0;
  const ice = world.seaIce[i] ?? 0;
  if (water !== 0) {
    // 海:越深越暗;湖单独一点绿蓝
    const depth = clamp(-e / 1200, 0, 1);
    let r = 46 + (1 - depth) * 20;
    let g = 82 + (1 - depth) * 26;
    let b = 116 + (1 - depth) * 34;
    if (water === 2) {
      r = 58; g = 96; b = 104;
    }
    if (ice > 0.5) {
      const t = clamp((ice - 0.5) / 0.5, 0, 1);
      r = r * (1 - t) + 208 * t;
      g = g * (1 - t) + 218 * t;
      b = b * (1 - t) + 230 * t;
    }
    return [r, g, b];
  }
  // 陆地:海拔(绝对米数,按 6000m 归一)→ 低地绿、山地褐、高山灰白
  const t = clamp(e / 6000, 0, 1);
  const stops: Array<[number, number, number, number]> = [
    [0.0, 84, 112, 70],
    [0.03, 100, 126, 80],
    [0.09, 120, 136, 88],
    [0.16, 138, 140, 96],
    [0.25, 152, 142, 106],
    [0.36, 164, 150, 120],
    [0.5, 178, 168, 150],
    [0.65, 194, 190, 184],
    [0.8, 212, 214, 212],
    [0.92, 236, 238, 236],
    [1.0, 250, 250, 250],
  ];
  let rgb: RGB = [250, 250, 250];
  for (let s = 1; s < stops.length; s++) {
    const a = stops[s - 1]!;
    const b = stops[s]!;
    if (t <= b[0]) {
      const u = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      rgb = [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, a[3] + (b[3] - a[3]) * u];
      break;
    }
  }
  // 气候着色:高纬/高山加雪,干热区加土黄,湿热区压深绿
  const temp = world.temperature[i] ?? 0;
  const rain = world.precipitation[i] ?? 0;
  if (temp < -4) {
    const k = clamp((-4 - temp) / 20, 0, 1) * 0.85;
    rgb = [rgb[0] + (238 - rgb[0]) * k, rgb[1] + (242 - rgb[1]) * k, rgb[2] + (246 - rgb[2]) * k];
  } else if (temp > 8 && rain < 260) {
    const k = clamp((260 - rain) / 260, 0, 1) * 0.6;
    rgb = [rgb[0] + (198 - rgb[0]) * k, rgb[1] + (180 - rgb[1]) * k, rgb[2] + (128 - rgb[2]) * k];
  } else if (temp > 20 && rain > 1800) {
    const k = clamp((rain - 1800) / 1600, 0, 1) * 0.45;
    rgb = [rgb[0] + (48 - rgb[0]) * k, rgb[1] + (88 - rgb[1]) * k, rgb[2] + (52 - rgb[2]) * k];
  }
  return rgb;
}

/** 邻域海拔梯度光照:西北向光,给地形一点立体感(只作用在陆地上) */
function terrainShade(world: World): Float32Array {
  const mesh = world.mesh;
  const n = mesh.n;
  const out = new Float32Array(n);
  const max = Math.max(1, world.maxElevation);
  const W = mesh.width;
  const xs = mesh.x;
  const ys = mesh.y;
  const e = world.elevation;
  for (let i = 0; i < n; i++) {
    let gx = 0;
    let gy = 0;
    let cnt = 0;
    const ei = e[i] ?? 0;
    const xi = xs[i] ?? 0;
    const yi = ys[i] ?? 0;
    for (let k = mesh.adjStart[i] ?? 0; k < (mesh.adjStart[i + 1] ?? 0); k++) {
      const j = mesh.adj[k]!;
      let dx = (xs[j] ?? 0) - xi;
      if (dx > W / 2) dx -= W;
      else if (dx < -W / 2) dx += W;
      const dy = (ys[j] ?? 0) - yi;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1e-6) {
        const de = ((e[j] ?? 0) - ei) / max;
        gx += (de * dx) / d2;
        gy += (de * dy) / d2;
        cnt++;
      }
    }
    let f = 1;
    if (cnt > 0) {
      gx /= cnt;
      gy /= cnt;
      const lit = gx * -0.55 + gy * -0.83;
      f = 1 + lit * 130;
    }
    out[i] = clamp(f, 0.7, 1.3);
  }
  return out;
}

function mix(c0: RGB, c1: RGB, t: number, out: Uint8Array, o: number): void {
  const k = clamp(t, 0, 1);
  out[o] = Math.round(c0[0] * (1 - k) + c1[0] * k);
  out[o + 1] = Math.round(c0[1] * (1 - k) + c1[1] * k);
  out[o + 2] = Math.round(c0[2] * (1 - k) + c1[2] * k);
  out[o + 3] = 255;
}

/* ------------------------------------------------------------------ *
 * 三角形栅格化(等距圆柱主图,2048 像素宽)
 * 地图在页面上是铺满整个窗口的,1024 宽会被放大到 1.7 倍以上而发虚;
 * 2048 宽在常见屏幕上正好是 1:1 左右。点击选国用的是下面另算的 240 格网格,不受这里影响。
 * ------------------------------------------------------------------ */

const MAP_OUT_W = 2048;

function triangleFill(
  px: Uint8Array,
  W: number,
  H: number,
  ax: number, ay: number,
  bx: number, by: number,
  cx: number, cy: number,
  ca: RGB, cb: RGB, cc: RGB,
): void {
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
  if (minX > maxX || minY > maxY) return;
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < 1e-9) return;
  const inv = 1 / d;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const pxx = x + 0.5;
      let l0 = ((by - cy) * (pxx - cx) + (cx - bx) * (py - cy)) * inv;
      if (l0 < -0.0005 || l0 > 1.0005) continue;
      let l1 = ((cy - ay) * (pxx - cx) + (ax - cx) * (py - cy)) * inv;
      if (l1 < -0.0005 || l1 > 1.0005) continue;
      const l2 = 1 - l0 - l1;
      if (l2 < -0.0005 || l2 > 1.0005) continue;
      l0 = clamp(l0, 0, 1);
      l1 = clamp(l1, 0, 1);
      const o = (y * W + x) * 4;
      px[o] = Math.round(ca[0] * l0 + cb[0] * l1 + cc[0] * (1 - l0 - l1));
      px[o + 1] = Math.round(ca[1] * l0 + cb[1] * l1 + cc[1] * (1 - l0 - l1));
      px[o + 2] = Math.round(ca[2] * l0 + cb[2] * l1 + cc[2] * (1 - l0 - l1));
      px[o + 3] = 255;
    }
  }
}

function stampCells(
  px: Uint8Array,
  W: number,
  H: number,
  sx: number,
  sy: number,
  n: number,
  x: Float32Array,
  y: Float32Array,
  colorOf: (i: number) => RGB | null,
  radius: number,
): void {
  const r = Math.max(0, Math.round(radius));
  for (let i = 0; i < n; i++) {
    const c = colorOf(i);
    if (!c) continue;
    const cx = Math.round((x[i] ?? 0) * sx) % W;
    const cy = Math.round((y[i] ?? 0) * sy);
    for (let dy = -r; dy <= r; dy++) {
      const py = cy + dy;
      if (py < 0 || py >= H) continue;
      for (let dx = -r; dx <= r; dx++) {
        const pxx = (cx + dx + W) % W;
        const o = (py * W + pxx) * 4;
        px[o] = c[0];
        px[o + 1] = c[1];
        px[o + 2] = c[2];
        px[o + 3] = 255;
      }
    }
  }
}

interface MapImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** 基础地形图(海/陆/湖/冰),按世界 id 缓存 */
function renderWorldMap(world: World): MapImage {
  const W = MAP_OUT_W;
  const H = Math.max(64, Math.round((MAP_OUT_W * world.height) / world.width));
  const sx = W / world.width;
  const sy = H / world.height;
  const px = new Uint8Array(W * H * 4);
  // 先铺一层深海,三角形/地块没盖到的地方(缝、极区)也不会空
  for (let o = 0; o < px.length; o += 4) {
    px[o] = 14; px[o + 1] = 30; px[o + 2] = 48; px[o + 3] = 255;
  }
  const n = world.mesh.n;
  const colors = new Uint8Array(n * 3);
  const shade = terrainShade(world);
  for (let i = 0; i < n; i++) {
    const c = cellColor(world, i);
    const k = (world.water[i] ?? 0) === 0 ? shade[i]! : 1;
    colors[i * 3] = Math.min(255, Math.round(c[0] * k));
    colors[i * 3 + 1] = Math.min(255, Math.round(c[1] * k));
    colors[i * 3 + 2] = Math.min(255, Math.round(c[2] * k));
  }
  const colorAt = (i: number): RGB => [colors[i * 3]!, colors[i * 3 + 1]!, colors[i * 3 + 2]!];

  // 地块小方块保底,保证极区/接缝被覆盖
  stampCells(px, W, H, sx, sy, n, world.mesh.x, world.mesh.y, (i) => colorAt(i), Math.max(1, Math.round(world.mesh.spacing * sx * 0.55)));

  const tri = world.mesh.triangles;
  for (let t = 0; t + 2 < tri.length; t += 3) {
    const ia = tri[t]!;
    const ib = tri[t + 1]!;
    const ic = tri[t + 2]!;
    const ax = (world.mesh.x[ia] ?? 0) * sx;
    const bx = (world.mesh.x[ib] ?? 0) * sx;
    const cx = (world.mesh.x[ic] ?? 0) * sx;
    const ay = (world.mesh.y[ia] ?? 0) * sy;
    const by = (world.mesh.y[ib] ?? 0) * sy;
    const cy = (world.mesh.y[ic] ?? 0) * sy;
    const ca = colorAt(ia);
    const cb = colorAt(ib);
    const cc = colorAt(ic);
    const span = Math.max(ax, bx, cx) - Math.min(ax, bx, cx);
    if (span > W / 2) {
      // 跨 180° 经线 / 包着极点的三角形:三点各自折到同一边,再左右各画一份
      const wxs = [ax, bx, cx].map((v) => (v > W / 2 ? v - W : v));
      triangleFill(px, W, H, wxs[0]!, ay, wxs[1]!, by, wxs[2]!, cy, ca, cb, cc);
      triangleFill(px, W, H, wxs[0]! + W, ay, wxs[1]! + W, by, wxs[2]! + W, cy, ca, cb, cc);
    } else {
      triangleFill(px, W, H, ax, ay, bx, by, cx, cy, ca, cb, cc);
    }
  }
  // 极区最上/最下几行容易露出背景色:用相邻行的像素盖住
  const pad = Math.min(3, H - 1);
  for (let y = 0; y < pad; y++) px.copyWithin(y * W * 4, pad * W * 4, (pad + 1) * W * 4);
  for (let y = 0; y < pad; y++) px.copyWithin((H - 1 - y) * W * 4, (H - 2 - pad) * W * 4, (H - 1 - pad) * W * 4);
  return { width: W, height: H, rgba: px };
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

  const kingCount = s.monarch
    ? pickMonarchIds(civ, year, (s.monarch.config as unknown as { polities: 'all' | number | number[] }).polities)
        .length
    : 0;

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
    memory: s.memory ? [...s.memory.values()] : [],
    intel: s.intel ?? {},
    pendingPlan: !!s.pendingPlan,
    // 开局定制(角色卡/起始疆域);没定制 = null
    customStart: s.customStart ? { ...s.customStart, warnings: [...s.customStart.warnings] } : null,
  };
}

/* ------------------------------------------------------------------ *
 * 会话表 / 缓存
 * ------------------------------------------------------------------ */

const baseCache = new Map<string, Buffer>();
/** 瓦片像素的渲染版本:terrain.ts 改了底图 / 瓦片的上色、河网等算法时 +1 */
const TILE_RENDER_VER = 11;
/** 高清瓦片:key = worldId | 画法 | 渲染版本 | LOD | 球面展开坐标上的块号 */
const tileCache = new Map<string, Buffer>();
/** 每块瓦片自己的海岸 / 湖岸线(按该块的倍率追的,和这块地形严丝合缝) */
const tileLines = new Map<string, { sea: number[][]; lake: number[][] }>();
const TILE_CACHE_MAX = 192;
/** 矢量层(海岸线 / 波纹 / 符号):按世界缓存一份 JSON */
const vectorCache = new Map<string, string>();
const ownerCache = new Map<string, { fingerprint: string; json: Record<string, unknown> }>();
const chronCache = new Map<string, { fingerprint: string; entries: EventView[]; total: number }>();
/** 场的计算层帧缓存:键 = worldId|kind|seed|scale;同世界同参数只算一次 */
const fieldFrames = new Map<string, FieldFrame>();
/** 场的渲染层缓存:键 = frame.hash|样式 JSON;改样式只重画,不动计算层 */
const fieldPngs = new Map<string, { png: Buffer; legend: unknown }>();
/** 「魔力」动态图层的 PNG 缓存:键 = sessionId|年份 */
const magicPngs = new Map<string, { png: Buffer; legend: unknown; frameYear: number | null }>();
/** 「魔力」高清瓦片缓存:键 = sessionId|年份|S|x|y|size(每块只算一次) */
const magicTilePngs = new Map<string, Buffer>();
/** 疆域高清瓦片缓存:键 = sessionId|状态指纹|S|x|y|size(和整张疆域图同时失效) */
const ownerTilePngs = new Map<string, Buffer>();
/** 标签层缓存:键 = sessionId|年份(世界 / 文明状态不变时只生成一次) */
const labelsCache = new Map<string, string>();
const dialogueCache = new Map<string, string>();
const veinCache = new Map<string, string>();

/** 会话状态变了:整张疆域图和它的疆域瓦片都作废(瓦片按 session 前缀清) */
function invalidateOwnerCache(sid: string): void {
  ownerCache.delete(sid);
  const prefix = `${sid}|`;
  for (const key of ownerTilePngs.keys()) if (key.startsWith(prefix)) ownerTilePngs.delete(key);
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
  if (fieldFrames.size > 32) fieldFrames.clear();
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

/** 缓存按 LRU 简单封顶,免得反复放大把内存吃光 */
function cacheTile(key: string, png: Buffer, lines?: { sea: number[][]; lake: number[][] }): void {
  tileCache.set(key, png);
  if (lines) tileLines.set(key, lines);
  if (tileCache.size > TILE_CACHE_MAX) {
    const oldest = tileCache.keys().next().value;
    if (oldest !== undefined) {
      tileCache.delete(oldest);
      tileLines.delete(oldest);
    }
  }
}

// ---- 预渲染:启动时把 S=2/4/8 的瓦片算好落盘,前端按进度条等到全部就绪 ----
const PREWARM_LEVELS = [2, 4, 8] as const;
const PREWARM_SIZE = 512;
const TILE_DISK_ROOT = resolve('.runs', 'tiles');

interface PrewarmState { state: 'running' | 'done' | 'failed'; done: number; total: number; startedAt: number; style: TerrainStyle }
const prewarmState = new Map<string, PrewarmState>();

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
  const hit = ownerCache.get(s.id);
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
  ownerCache.set(s.id, { fingerprint, json });
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
  const hit = chronCache.get(s.id);
  const fingerprint = String(stateGet(s, { chronicle: false }).fingerprint ?? '');
  if (hit && hit.fingerprint === fingerprint) return hit;
  const chron = chronicleGet(s, { limit: 500 });
  const v = { fingerprint, entries: chron.entries, total: chron.total };
  chronCache.set(s.id, v);
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

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
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

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, viewer: 'civ-atlas-mcp-viewer', staticDir: STATIC_DIR });
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
    const key = `${s.id}|${year}`;
    let json = labelsCache.get(key);
    if (!json) {
      json = JSON.stringify(buildLabels(s.world, s.civ, { year }));
      labelsCache.set(key, json);
      if (labelsCache.size > 8) labelsCache.clear();
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
    const key = `${sid}|${fingerprint}|${S}|${x}|${y}|${size}`;
    const hit = ownerTilePngs.get(key);
    if (hit) { sendPng(res, hit); return true; }
    const civ = ownerCivData(s.civ);
    const map =
      (await renderViaPool(worldIdOf(s.worldParams), s.world, { kind: 'owner', S, x, y, size, civ })) ??
      renderOwnerTilePixels(s.world, civ, S, x, y, size);
    const png = encodePng(map.width, map.height, map.rgba);
    if (ownerTilePngs.size > 512) ownerTilePngs.clear();
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

  // DM 对话 / Jev 裁决:从会话日志里整理出“每回合说了什么、裁了什么”,日志页签直接渲染
  if (method === 'GET' && pathname === '/api/dialogue') {
    const q = url.searchParams;
    const sid = q.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    const s = getSession(sid);
    const rawLimit = q.get('limit');
    const limit = rawLimit === null || rawLimit === '' ? 80 : Number(rawLimit);
    if (!Number.isFinite(limit)) { fail(res, 400, 'limit 必须是数字'); return true; }
    const kindRaw = q.get('kind');
    const kind = kindRaw === 'dm' || kindRaw === 'jev' || kindRaw === 'monarch' ? kindRaw : undefined;
    const fingerprint = String(stateGet(s, { chronicle: false }).fingerprint ?? '');
    const key = `${s.id}|${fingerprint}|${limit}|${kind ?? ''}`;
    let json = dialogueCache.get(key);
    if (!json) {
      json = JSON.stringify(dialogueView(s, { limit, kind }));
      dialogueCache.set(key, json);
      if (dialogueCache.size > 16) dialogueCache.clear();
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
    if (fieldPngs.size > 48) fieldPngs.clear();
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
    const year = asked === undefined ? s.play.year : Math.min(s.play.year, Math.max(lo, asked));
    const key = `${s.id}|${year}|${colorKey}`;
    const hit = magicPngs.get(key);
    if (hit) { sendPng(res, hit.png); return true; }
    const style = colors ? { ...DEFAULT_MAGIC_STYLE, colors } : DEFAULT_MAGIC_STYLE;
    const out = renderMagicMap(s.world, s.civ, year, style);
    if (!out) { fail(res, 404, '没有魔力图层'); return true; }
    if (magicPngs.size > 24) magicPngs.clear();
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
    const year = asked === undefined ? s.play.year : Math.min(s.play.year, Math.max(layer.years[0], asked));
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
    const year = asked === undefined ? s.play.year : Math.min(s.play.year, Math.max(layer.years[0], asked));
    const colors = parseMagicColors(q.get('colors'));
    const colorKey = colors ? colors.join(',') : '';
    const key = `${s.id}|${year}|${S}|${x}|${y}|${size}|${colorKey}`;
    const hit = magicTilePngs.get(key);
    if (hit) { sendPng(res, hit); return true; }
    const style = colors ? { ...DEFAULT_MAGIC_STYLE, colors } : DEFAULT_MAGIC_STYLE;
    const out = renderMagicTile(s.world, s.civ, year, S, x, y, size, style);
    if (!out) { fail(res, 404, '没有魔力图层'); return true; }
    if (magicTilePngs.size > 512) magicTilePngs.clear();
    magicTilePngs.set(key, out.png);
    sendPng(res, out.png);
    return true;
  }

  if (method === 'GET' && pathname === '/api/start/nations') {
    const sid = url.searchParams.get('sessionId') ?? '';
    if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
    const s = getSession(sid);
    sendJson(res, 200, { nations: listStartNations(s) });
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
    const args = (await readBody(req)) as Args;

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
      const { session, summary } = openSession({
        worldId,
        startYear,
        stepYears,
        maxRounds,
        mode: 'monarch',
        features,
        review: args.review === true,
        ...(dmPreset ? { dmPreset: true } : {}),
        ...(magicField !== undefined ? { magicField } : {}),
      });
      invalidateOwnerCache(session.id);
      chronCache.delete(session.id);
      sendJson(res, 200, { session: summary, state: stateView(session) });
      return true;
    }

    // 开局定制:君主角色卡 + 起始疆域大小/位置(只允许第一回合前)
    if (pathname === '/api/session/custom-start') {
      const sid = String(args.sessionId ?? '');
      if (!sid) { fail(res, 400, '缺 sessionId'); return true; }
      const s = getSession(sid);
      const atRaw = args.at as Record<string, unknown> | undefined;
      const input: Record<string, unknown> = {};
      if (args.polityId !== undefined && args.polityId !== null && args.polityId !== '') input.polityId = Number(args.polityId);
      if (atRaw && typeof atRaw === 'object' && Number.isFinite(Number(atRaw.x)) && Number.isFinite(Number(atRaw.y))) {
        input.at = { x: Number(atRaw.x), y: Number(atRaw.y) };
      }
      if (args.size !== undefined && args.size !== null && args.size !== '') input.size = Number(args.size);
      if (args.card && typeof args.card === 'object') input.card = args.card as Record<string, unknown>;
      if (args.autoCard === true) input.autoCard = true;
      const result = applyCustomStart(s, input);
      invalidateOwnerCache(s.id);
      chronCache.delete(s.id);
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
      const round = await monarchCommit(s, reject ? { reject } : {});
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
      sendJson(res, 200, { export: exportSession(s) });
      return true;
    }
  }

  return false;
}

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.replace(/^\/+/, ''));
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

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
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
