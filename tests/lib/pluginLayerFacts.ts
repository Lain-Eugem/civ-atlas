/**
 * 插件图层格式第 1 版的样本(tests/fixtures/plugin-layers/)读出来是什么样:scripts/plugin-layer-samples.ts 拿它写 v1.json,
 * tests/plugin-layer-format-v1.test.ts 拿它和 v1.json 比。只用网站的代码读样本、照网站的画法解出每一份每一格的数和颜色,一律不重新生成。
 * 每一份存 SHA-256 判定变没变,再抽几格写明数和颜色(看差在哪)。
 */
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { READER_VERSIONS } from '../../src/gen/readers/versions';
import { partBytes, unpackValue, type SnapshotPart } from '../../src/gen/snapshot';
import { openWorldFile, readWorldContent, type OpenedWorldFile, type WorldContent } from '../../src/gen/worldFile';
import { PLUGIN_LAYER_MAX_BYTES, pluginLayerOf, pluginLayerPart, type PluginLayerValue } from '../../src/gen/worldFormat';
import { validatePluginLayer } from '../../src/gen/worldValidate';
import { cellColors, frameAt, framePaint, rampRange } from '../../src/render/pluginLayer';

export const LAYER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'plugin-layers');
/** 各个样本该读出来的样子 */
export const FACTS_FILE = join(LAYER_DIR, 'v1.json');

/** 一个样本里的一个图层 */
export interface SampleLayer {
  /** 存在哪:块名,或者历史那一块里 simLayers 的第几项 */
  at: string;
  by: string;
  id: string;
  /** 跟着历史走的(推演插件的) */
  history: boolean;
  value: PluginLayerValue;
}

export interface OpenedSample {
  opened: OpenedWorldFile;
  content: WorldContent;
  layers: SampleLayer[];
}

/** 打开一个样本(和网站打开别人给的文件同一条路:逐项核对),列出全部图层:工具插件的块按文件里的先后,再是跟着历史的 */
export async function openSample(file: Uint8Array): Promise<OpenedSample> {
  const opened = await openWorldFile(file, { readers: READER_VERSIONS });
  const content = await readWorldContent(opened);
  const history = content.civ.simLayers ?? [];
  const names = new Set(opened.manifest.parts.map((p) => p.name));
  const historyBlocks = new Set(history.map((l) => pluginLayerPart(l.by, l.id)).filter((n) => names.has(n)));
  const layers: SampleLayer[] = [];
  for (const p of opened.manifest.parts) {
    const ids = pluginLayerOf(p.name);
    if (!ids || historyBlocks.has(p.name)) continue;
    const raw = await partBytes(p as Pick<SnapshotPart, 'name' | 'bytes' | 'sum' | 'zip'>, opened.bytes.get(p.name)!, PLUGIN_LAYER_MAX_BYTES);
    const value = unpackValue(raw);
    validatePluginLayer(value, { cells: content.map.mesh.n, regions: content.civ.regions.count }, p.name);
    layers.push({ at: p.name, by: ids[0], id: ids[1], history: false, value });
  }
  history.forEach(({ by, id, ...value }, i) => {
    const block = pluginLayerPart(by, id);
    // 和 worldFile 落盘一样:按地块的层在文件里写 unit 'cell'
    const stored: PluginLayerValue = { ...value, unit: value.unit === 'tile' ? 'cell' : 'region' };
    layers.push({ at: historyBlocks.has(block) ? block : `civ.simLayers[${i}]`, by, id, history: true, value: stored });
  });
  return { opened, content, layers };
}

/** 一格:格号、数(NaN = null)、RGBA */
export type CellSample = [number, number | null, number[]];

export interface FrameFacts {
  /** 这一份是哪一年的;没有 years = null */
  year: number | null;
  /** 这一份的数(Float32 的字节)、颜色(每格 RGBA 四个字节)的 SHA-256 */
  values: string;
  colors: string;
  /** 涂了颜色的格数 */
  drawn: number;
  /** 抽的几格(只在第一份、正中间那份、最后一份抽) */
  samples?: CellSample[];
}

export interface LayerFacts {
  at: string;
  by: string;
  id: string;
  history: boolean;
  unit: 'cell' | 'region';
  /** 样子:标题、渐变或分类、图例、透明度,照存着的原样 */
  look: Record<string, unknown>;
  /** 渐变实际涂的范围(没给的一头按所有份定);分类 = null */
  range: [number, number] | null;
  /** 一份几格 */
  cells: number;
  frames: FrameFacts[];
  /** 看这几年时画第几份(-1 = 不画) */
  pick: [number, number][];
}

const sha = (b: ArrayBufferView) => createHash('sha256').update(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)).digest('hex');
const num = (v: number): number | null => (Number.isNaN(v) ? null : Object.is(v, -0) ? 0 : v);

/** 抽几格:第一格、最后一格、正中间,第一格和最后一格涂了的,第一格没涂的 */
function samplesOf(values: Float32Array, colors: Uint8Array): CellSample[] {
  const n = values.length;
  const drawn: number[] = [];
  let blank = -1;
  for (let i = 0; i < n; i++) {
    if (colors[i * 4 + 3]) drawn.push(i);
    else if (blank < 0) blank = i;
  }
  const at = [...new Set([0, n - 1, n >> 1, drawn[0] ?? -1, drawn.at(-1) ?? -1, blank].filter((i) => i >= 0))].sort((a, b) => a - b);
  return at.map((i) => [i, num(values[i]), [...colors.subarray(i * 4, i * 4 + 4)]]);
}

/** 拿几年试挑哪一份:第一份前一年、第一份那年、头两份中间、正中间那份、最后一份前半年、最后一份那年、往后一千年 */
function picksOf(years: readonly number[] | undefined): [number, number][] {
  if (!years) return [0, 3000].map((y) => [y, frameAt(years, y)]);
  const last = years.at(-1)!;
  const probe = [years[0] - 1, years[0], years[years.length >> 1], last, last + 1000, ...(years.length > 1 ? [(years[0] + years[1]) / 2, last - 0.5] : [])];
  return [...new Set(probe)].sort((a, b) => a - b).map((y) => [y, frameAt(years, y)]);
}

/** 照网站的画法解出一个图层的每一份 */
export function layerFacts(l: SampleLayer): LayerFacts {
  const v = l.value;
  const frames = v.years?.length ?? 1;
  const cells = v.values.length / frames;
  const sampled = new Set([0, frames >> 1, frames - 1]);
  const out: FrameFacts[] = [];
  for (let k = 0; k < frames; k++) {
    const paint = framePaint(v, v.years ? v.years[k] : 0)!;
    const colors = cellColors(paint);
    let drawn = 0;
    for (let i = 0; i < cells; i++) if (colors[i * 4 + 3]) drawn++;
    out.push({ year: v.years ? v.years[k] : null, values: sha(paint.values), colors: sha(colors), drawn, ...(sampled.has(k) ? { samples: samplesOf(paint.values, colors) } : {}) });
  }
  const { values: _values, unit, years: _years, ...look } = v;
  void _values, _years;
  const range = v.ramp ? (rampRange(v).map((x) => num(x)) as [number, number]) : null;
  return { at: l.at, by: l.by, id: l.id, history: l.history, unit, look, range, cells, frames: out, pick: picksOf(v.years) };
}

/** 一个样本文件该读出来的样子 */
export interface SampleFacts {
  sha256: string;
  bytes: number;
  layers: LayerFacts[];
}

export async function sampleFacts(file: Uint8Array): Promise<SampleFacts> {
  const { layers } = await openSample(file);
  return { sha256: sha(file), bytes: file.length, layers: layers.map(layerFacts) };
}
