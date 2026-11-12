/**
 * 原生版「魔力」推演插件:公式照 examples/plugins/magic,但表按「地块」记,
 * 每个地块各自有魔力浓度,而不是整州一个值 —— 这样放大地图时能看到魔力在地块之间流动。
 *
 *   - 灵脉(vein):一开始约 1/16 的地块底下有,强 40–100;
 *   - 魔力(magic):从灵脉渗出、向相邻地块扩散、自己会淡掉,另外按固定速率衰减(没有人口表可接);
 *   - 每 50 年存一份地块图层(内存按地块、进世界文件记成 cell);
 *   - 每 5 年出手一次:把地块魔力按州求平均,换成影响口 city.capacity 的倍数
 *     (魔力满 100 时城上限 = 1 + strength 倍)。影响口本身只能按州交,所以聚合在 act 里做。
 *
 * 只影响用它新推的世界;不装插件时引擎的数值与原来逐字节一致。
 */
import type { SimLayerSpec } from './engine/pluginLayers';
import type { PluginReply, PluginTurn, SimPlugin } from './engine/plugin';
import type { TableCard } from './engine/tables/cards';
import type { SimRead } from './simRead';

/** 插件编号(世界文件里的 by) */
export const MAGIC_PLUGIN_ID = 'magic';

/** 滑条的取值范围(和 examples/plugins/magic/plugin.json 一致) */
export const MAGIC_STRENGTH_MIN = 0;
export const MAGIC_STRENGTH_MAX = 3;
export const MAGIC_STRENGTH_STEP = 0.5;
export const MAGIC_STRENGTH_DEFAULT = 1;

/** 灵脉表:只在第 0 年撒一次点,之后不变(rule 就是自己,等于不再改) */
const veinCard: TableCard = {
  id: 'vein',
  name: '灵脉',
  unit: 'tile',
  every: 1000,
  min: 0,
  max: 100,
  off: 0,
  init: 'if(rand() < 0.06, 40 + 60 * rand(1), 0)',
  rule: 'vein',
};

/** 魔力浓度:每 5 年算一步;地块之间用 nbmean 取相邻地块均值扩散 */
const magicCard: TableCard = {
  id: 'magic',
  name: '魔力',
  unit: 'tile',
  every: 5,
  min: 0,
  max: 100,
  off: 0,
  init: 0,
  consts: { spread: 0.05, seep: 0.02, fade: 0.002, drain: 0.01 },
  // drain 现在是「额外的自然消退」:地块表没有乡村人口可接(人口只在州上)
  rate: 'spread * (nbmean(nb.magic) - magic) + max(seep * (vein - magic), 0) - fade * magic - drain * magic',
};

/** 魔力浓度的图层:每 50 年存一份,色带照官方示例 */
const magicLayer: SimLayerSpec = {
  id: 'magic',
  table: 'magic',
  title: '魔力浓度',
  ramp: { colors: ['#1b1036', '#5b2a9e', '#a46cff', '#f2e6ff'], min: 0, max: 60 },
  legend: '魔力（0–100）',
  keep: 100,
};

/** 图层编号、标题与单位(查看器/状态读用) */
export const MAGIC_LAYER = { id: 'magic', title: '魔力浓度', keep: 100, unit: 'tile', legend: '魔力（0–100）' } as const;

/** 把任意输入夹到滑条范围内并按 0.5 对齐;不给 = 默认 1 */
export function magicStrengthOf(value: number | undefined): number {
  const n = value === undefined ? MAGIC_STRENGTH_DEFAULT : Number(value);
  if (!Number.isFinite(n)) return MAGIC_STRENGTH_DEFAULT;
  const clamped = Math.max(MAGIC_STRENGTH_MIN, Math.min(MAGIC_STRENGTH_MAX, n));
  return Math.round(clamped / MAGIC_STRENGTH_STEP) * MAGIC_STRENGTH_STEP;
}

/** 地块表才有的运行时地块信息(turn.tiles 不可枚举,给原生插件用) */
interface TurnTiles {
  readonly count: number;
  readonly of: Int32Array;
}

/** 地块 → 州:跳过水地块,交给影响口的是每个州的平均魔力(没有陆地地块的州按 0) */
function regionMeanOfTile(magic: Float64Array, tiles: TurnTiles, regions: number): Float64Array {
  const sum = new Float64Array(regions);
  const cnt = new Int32Array(regions);
  const n = Math.min(magic.length, tiles.count);
  for (let c = 0; c < n; c++) {
    const r = tiles.of[c]!;
    if (r < 0 || r >= regions) continue;
    sum[r] += magic[c]!;
    cnt[r]!++;
  }
  const out = new Float64Array(regions);
  for (let r = 0; r < regions; r++) out[r] = cnt[r]! > 0 ? sum[r]! / cnt[r]! : 0;
  return out;
}

/**
 * 造一个「魔力」推演插件(地块级)。
 * @param strength 新建世界时拨的滑条:0 = 魔力不影响城;1 = 魔力满 100 时城上限翻一倍;3 = 四倍。
 */
export function magicPlugin(strength: number = MAGIC_STRENGTH_DEFAULT): SimPlugin<SimRead> {
  const k = magicStrengthOf(strength);
  return {
    id: MAGIC_PLUGIN_ID,
    every: 5,
    tables: [veinCard, magicCard],
    layers: [magicLayer],
    influences: ['city.capacity'],
    act(turn: PluginTurn<SimRead>): PluginReply {
      const magic = turn.table('magic');
      const cap = turn.influence('city.capacity');
      const tiles = (turn as unknown as { readonly tiles?: TurnTiles }).tiles;
      if (!tiles) throw new Error('魔力场要按地块记数,这套规则没给地块');
      const mean = regionMeanOfTile(magic, tiles, cap.length);
      const next = new Float64Array(cap.length);
      for (let r = 0; r < next.length; r++) next[r] = 1 + (k * mean[r]!) / 100;
      return { influences: { 'city.capacity': next } };
    },
  };
}
