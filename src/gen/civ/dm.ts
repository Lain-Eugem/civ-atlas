/**
 * DM 规则预设:把引擎自动推演的劲头压低,给外部君主(DM/玩家)留出操作空间。
 *
 * 玩的还是同一套推演,只是把官方对外规则项(tuning.ts 的 TuningValues)改几项:
 * 自动开战少一些、仗打得更久、打完歇得短、自动结盟和背盟少一些、自动分裂少一些;
 * 换算成每个世界的旋钮(CivParams.knobs,tuningPatch)随世界存下,同一个种子仍然逐位一致。
 *
 * 没有打开这套预设 = 不放 KnobPatch = 和官方规则逐字节相同(确定性对账就是这么比的)。
 * 想改哪一项就传 overrides(键名见 tuning.ts 的 TUNING_ITEMS);不认识的键会被 cleanTuning 丢掉并记在 notes 里。
 */
import { cleanTuning, officialValue, TUNING_CALC, tuningItem, type TuningValue, type TuningValues } from './tuning';
import { tuningPatch } from './tuningPatch';
import type { KnobPatch, KnobValue } from './engine/knobs';

export const DM_NAME = 'DM 沙盒';
export const DM_ABOUT =
  '引擎自动宣战、自动议和、自动结盟、自动分裂都收着点,给外部君主留操作空间;其余规则同官方。';

/** 默认改的几项:自动战争减半、议和后冷却 10 年、一场仗最多打 8–30 年、打完歇 2 年、
 *  自动结盟减半、不自动背盟、自动分裂减半。数值须在各项允许的档/范围里(见 tuning.ts)。 */
export const DM_TUNING_VALUES: TuningValues = {
  'war.odds': 0.5,
  'war.truce': 10,
  'war.length': [8, 30],
  'war.rest': 2,
  'diplo.pact': 0.5,
  'diplo.betray': 0,
  'split.odds': 0.5,
};

/** 一条预设项:规则项编号、中文名、预设值、官方值(方便客户端解释) */
export interface DmPresetItem {
  readonly id: string;
  readonly name: string;
  readonly value: TuningValue;
  readonly official: TuningValue;
}

/** 默认预设 + 覆盖项(覆盖项优先) */
export function dmTuningValues(overrides: TuningValues = {}): TuningValues {
  return { ...DM_TUNING_VALUES, ...overrides };
}

/** 预设 → 这个世界的旋钮改动;什么都没改 = undefined(官方规则) */
export function dmKnobs(overrides: TuningValues = {}): KnobPatch | undefined {
  return tuningPatch(dmTuningValues(overrides), TUNING_CALC);
}

/** 逐项列出预设项(覆盖后),给工具/README 解释用 */
export function dmPresetItems(overrides: TuningValues = {}): DmPresetItem[] {
  const values = dmTuningValues(overrides);
  return Object.entries(values).map(([id, value]) => {
    const item = tuningItem(id);
    return { id, name: item?.name ?? id, value, official: item ? officialValue(item) : value };
  });
}

/** 两套旋钮改动合并:同一张表里 top 盖过 base(用户显式给的 civParams.knobs 优先于 DM 预设) */
export function mergeKnobs(base: KnobPatch | undefined, top: KnobPatch | undefined): KnobPatch | undefined {
  if (!base) return top;
  if (!top) return base;
  const out: Record<string, Record<string, KnobValue>> = {};
  for (const [table, values] of Object.entries(base)) out[table] = { ...values };
  for (const [table, values] of Object.entries(top)) out[table] = { ...(out[table] ?? {}), ...values };
  return out;
}

/** 工具的返回值:预设是什么、换算成哪些旋钮、有没有被丢掉的覆盖项 */
export interface DmPresetInfo {
  readonly name: string;
  readonly about: string;
  readonly values: TuningValues;
  readonly knobs: KnobPatch | undefined;
  readonly items: DmPresetItem[];
  readonly notes: string[];
}

export function dmPresetInfo(overrides: TuningValues = {}): DmPresetInfo {
  const values = dmTuningValues(overrides);
  const cleaned = cleanTuning(values);
  return {
    name: DM_NAME,
    about: DM_ABOUT,
    values: cleaned.values,
    knobs: tuningPatch(cleaned.values, TUNING_CALC),
    items: dmPresetItems(overrides),
    notes: cleaned.notes,
  };
}
