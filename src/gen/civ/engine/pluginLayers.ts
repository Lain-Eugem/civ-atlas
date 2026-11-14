/**
 * 推演插件的图层:插件按州记的一张表(的一栏)标成图层,每隔 keep 年存一份,存进历史(Civ.simLayers);
 * 世界文件里各是一块 layer.<插件编号>.<图层编号>(worldFormat.ts 的 PluginLayerValue),看世界不需要插件。
 */
import { colCount, type TableCard } from './tables';

/** 图层编号:和世界文件里图层块名的那一段一样(worldFormat.ts 的 PLUGIN_LAYER_ID) */
export const LAYER_ID = /^[a-z0-9][a-z0-9-]{0,24}$/;

/** 图层的样子(和工具插件交的地块图层同一套写法) */
export interface SimLayerLook {
  title: string;
  ramp?: { colors: string[]; min?: number; max?: number };
  classes?: { value: number; color: string; label: string }[];
  legend?: string;
  opacity?: number;
}

/** 查一个图层的样子,交回网站这边的一份;不合规矩抛 Error(网站给的,引擎不管怎么查) */
export type LayerLookCheck = (spec: SimLayerSpec) => SimLayerLook;

/** 插件清单里标的一个图层 */
export interface SimLayerSpec extends SimLayerLook {
  /** 图层编号(小写字母、数字、连字符,最长 25 个字) */
  id: string;
  /** 哪张表:按州记的、记数的;多栏的表要给栏名 */
  table: string;
  col?: string;
  /** 每隔几年存一份(整数年,从第 0 年起) */
  keep: number;
}

/** 存进历史的一个图层(去掉 by、id 就是世界文件里那一块的内容;写进世界文件时 tile 记成 cell) */
export interface SimLayer extends SimLayerLook {
  /** 哪个插件的 */
  by: string;
  id: string;
  unit: 'region' | 'tile';
  /** 每一份是哪一年的 */
  years: number[];
  /** 份数 × 州数(region)或份数 × 地块数(tile) */
  values: Float32Array;
}

/**
 * 每个插件最多几个图层、keep 最多几年、一个图层存的数最多占多少字节
 * (比世界文件一块的上限 8 MB 留出余量:地形大事以后州会变多,先存的几份补成同样的格数)
 */
export const LAYER_LIMITS = { layers: 4, keep: 1000, bytes: 6e6 } as const;

/** 按地块记的图层格数固定(世界地块数),字节上限可以贴着世界文件一块 8 MB 给 */
export const TILE_LAYER_BYTES = 7.8e6;

/** 一个图层推着推着存下的几份 */
export class LayerRun {
  readonly keep: number;
  /** 表按什么单位记(州/地块),存下来的图层跟着它 */
  readonly unit: 'region' | 'tile';
  private readonly col: number;
  private readonly cols: number;
  private readonly look: SimLayerLook;
  private years: number[] = [];
  private frames: Float32Array[] = [];

  /** ticks = 一年几刻;card = 那张表;不合规矩抛 Error(说哪里不对) */
  constructor(
    readonly spec: SimLayerSpec,
    card: TableCard | undefined,
    ticks: number,
    check: LayerLookCheck,
  ) {
    const s = spec;
    if (typeof s.id !== 'string' || !LAYER_ID.test(s.id)) throw new Error(`图层编号 ${String(s.id)} 只能有小写字母、数字和连字符,最长 25 个字`);
    if (!card) throw new Error(`图层 ${s.id} 的表 ${String(s.table)} 没有`);
    if (card.unit !== 'region' && card.unit !== 'tile') throw new Error(`图层 ${s.id} 的表 ${card.id} 要按州或按地块记`);
    if (card.kind === 'id') throw new Error(`图层 ${s.id} 的表 ${card.id} 要记数(编号表画不出图)`);
    this.unit = card.unit;
    this.cols = colCount(card);
    this.col = s.col === undefined ? (this.cols === 1 ? 0 : -1) : (card.cols ?? []).indexOf(s.col);
    if (this.col < 0) throw new Error(`图层 ${s.id} 要给表 ${card.id} 的一栏`);
    if (!Number.isInteger(s.keep) || s.keep < 1 || s.keep > LAYER_LIMITS.keep) throw new Error(`图层 ${s.id} 的 keep 要是 1 到 ${LAYER_LIMITS.keep} 的整数`);
    this.keep = s.keep * ticks;
    try {
      this.look = check(s);
    } catch (e) {
      throw new Error(`图层 ${s.id}:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 存一份:data = 那张表此刻的值(格 × 栏);超出单精度能存的压到最大最小,不变成无穷大 */
  keepFrame(year: number, data: Float64Array): void {
    const n = data.length / this.cols;
    // 地块图层的格数是固定的,可以用满世界文件一块的上限;州图层留出地形大事后州变多的余量
    const limit = this.unit === 'tile' ? TILE_LAYER_BYTES : LAYER_LIMITS.bytes;
    if ((this.years.length + 1) * n * 4 > limit) throw new Error(`图层 ${this.spec.id} 存的太多(每 ${this.spec.keep} 年一份、${n} 格),把 keep 调大`);
    const f = new Float32Array(n);
    for (let r = 0; r < n; r++) f[r] = Math.max(-F32_MAX, Math.min(F32_MAX, data[r * this.cols + this.col]));
    this.years.push(year);
    this.frames.push(f);
  }

  /** 接上存下的(推到 year;格 count 个):份数、年份要正好是从第 0 年起每 keep 年一份 */
  restore(saved: SimLayer, year: number, count: number, ticks: number): void {
    const s = this.spec;
    const want: number[] = [];
    for (let t = 0; t <= year * ticks; t += this.keep) want.push(t / ticks);
    if (saved.unit !== this.unit || !Array.isArray(saved.years) || saved.years.length !== want.length || saved.years.some((y, i) => y !== want[i])) throw new Error(`存下的图层 ${s.id} 的年份对不上`);
    if (!(saved.values instanceof Float32Array) || saved.values.length !== want.length * count) throw new Error(`存下的图层 ${s.id} 的格数对不上`);
    if (canon(lookOf(saved)) !== canon(this.look)) throw new Error(`存下的图层 ${s.id} 和插件现在的样子对不上`);
    this.years = want;
    this.frames = want.map((_, k) => saved.values.slice(k * count, (k + 1) * count));
  }

  /** 交出去的一份:格数补到 count(地形大事以后州变多,先存的几份多出来的格子不画) */
  snapshot(by: string, count: number): SimLayer {
    const values = new Float32Array(this.years.length * count).fill(NaN);
    this.frames.forEach((f, k) => values.set(f.length > count ? f.subarray(0, count) : f, k * count));
    const { title, ...rest } = this.look;
    return { by, id: this.spec.id, title, unit: this.unit, years: this.years.slice(), values, ...rest };
  }
}

/** 单精度能存的最大的数 */
const F32_MAX = 3.4028234663852886e38;

/** 写成键排好序的 JSON:比两份样子不看键的先后 */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) => (x !== null && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, (x as Record<string, unknown>)[k]])) : x));

/** 一个图层的样子(照查样子交出来的先后) */
function lookOf(v: SimLayerLook): SimLayerLook {
  const out: SimLayerLook = { title: v.title };
  if (v.ramp !== undefined) out.ramp = v.ramp;
  if (v.classes !== undefined) out.classes = v.classes;
  if (v.legend !== undefined) out.legend = v.legend;
  if (v.opacity !== undefined) out.opacity = v.opacity;
  return out;
}
