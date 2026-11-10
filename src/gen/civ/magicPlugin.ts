/**
 * 原生版「魔力」推演插件:把官方示例 examples/plugins/magic 的表、影响口、图层照搬过来,
 * 但不走 QuickJS,直接是一个同步的 SimPlugin 对象 —— 这样 mcp 的 CommonJS 无头进程也能用。
 *
 * 每州一个魔力浓度(region 表):
 *   - 灵脉(vein):一开始约 1/16 的州底下有,强 40–100;
 *   - 魔力(magic):从灵脉渗出、向邻州扩散、自己会淡掉;人多的地方被耗得快(接官方乡村人口表);
 *   - 每 50 年存一份图层,看得出它怎么涨落;
 *   - 每 5 年出手一次,把魔力浓度换成影响口 city.capacity 的倍数:魔力满 100 时城上限 = 1 + strength 倍。
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
  unit: 'region',
  every: 1000,
  min: 0,
  max: 100,
  off: 0,
  init: 'if(rand() < 0.06, 40 + 60 * rand(1), 0)',
  rule: 'vein',
};

/** 官方乡村人口(千人)的输入表:魔力被人口耗散 */
const ruralCard: TableCard = {
  id: 'rural',
  name: '乡村人口',
  unit: 'region',
  input: true,
  min: 0,
  max: 1000000000,
  off: 0,
};

/** 魔力浓度:每 5 年算一步,rate 公式照官方示例 */
const magicCard: TableCard = {
  id: 'magic',
  name: '魔力',
  unit: 'region',
  every: 5,
  min: 0,
  max: 100,
  off: 0,
  init: 0,
  consts: { spread: 0.05, seep: 0.02, fade: 0.002, drain: 0.01, crowd: 100 },
  rate: 'spread * (nbmean(nb.magic) - magic) + max(seep * (vein - magic), 0) - fade * magic - drain * magic * min(rural / crowd, 1)',
};

/** 魔力浓度的图层:每 50 年存一份,色带照官方示例 */
const magicLayer: SimLayerSpec = {
  id: 'magic',
  table: 'magic',
  title: '魔力浓度',
  ramp: { colors: ['#1b1036', '#5b2a9e', '#a46cff', '#f2e6ff'], min: 0, max: 60 },
  legend: '魔力（0–100）',
  keep: 50,
};

/** 图层编号与标题(查看器/状态读用) */
export const MAGIC_LAYER = { id: 'magic', title: '魔力浓度', keep: 50, legend: '魔力（0–100）' } as const;

/** 把任意输入夹到滑条范围内并按 0.5 对齐;不给 = 默认 1 */
export function magicStrengthOf(value: number | undefined): number {
  const n = value === undefined ? MAGIC_STRENGTH_DEFAULT : Number(value);
  if (!Number.isFinite(n)) return MAGIC_STRENGTH_DEFAULT;
  const clamped = Math.max(MAGIC_STRENGTH_MIN, Math.min(MAGIC_STRENGTH_MAX, n));
  return Math.round(clamped / MAGIC_STRENGTH_STEP) * MAGIC_STRENGTH_STEP;
}

/**
 * 造一个「魔力」推演插件。
 * @param strength 新建世界时拨的滑条:0 = 魔力不影响城;1 = 魔力满 100 时城上限翻一倍;3 = 四倍。
 */
export function magicPlugin(strength: number = MAGIC_STRENGTH_DEFAULT): SimPlugin<SimRead> {
  const k = magicStrengthOf(strength);
  return {
    id: MAGIC_PLUGIN_ID,
    every: 5,
    tables: [veinCard, ruralCard, magicCard],
    inputs: { rural: 'rural' },
    layers: [magicLayer],
    influences: ['city.capacity'],
    act(turn: PluginTurn<SimRead>): PluginReply {
      const magic = turn.table('magic');
      const cap = turn.influence('city.capacity');
      const n = Math.min(magic.length, cap.length);
      const next = new Float64Array(n);
      for (let r = 0; r < n; r++) next[r] = 1 + (k * magic[r]) / 100;
      return { influences: { 'city.capacity': next } };
    },
  };
}
