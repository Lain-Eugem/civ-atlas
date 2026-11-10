/**
 * 原始指令(JSON)的清洗与校验。
 *
 * 这一层只做「把外部发来的 JSON 变成引擎认识的 Intervention」,不替调用方猜语义;
 * 语义由 src/gen/civ/interventions.ts 的引擎内部定义决定。
 * 关键约束:引擎只收「下在现在这一刻」的命令,所以 from 一律填成 play.year。
 */
import { cleanIntervention, type Intervention, type PlayState } from '../src/gen/edits';

export interface RejectedOrder {
  order: unknown;
  reason: string;
}

export interface CleanedOrders {
  /** 当前回合的年份(命令都下在这一年) */
  atYear: number;
  commands: Intervention[];
  rejected: RejectedOrder[];
}

/**
 * 把一批原始命令清洗成引擎能收的 Intervention。
 * - 每条必须是 JSON 对象,且有字符串 kind
 * - from 可以省略(自动填成当前回合年份);写了就必须等于当前回合年份
 * - 字段不合法 / 这个版本不认识的 kind 会被拒绝,不会让整批失败
 */
export function cleanOrders(play: PlayState, raw: readonly unknown[]): CleanedOrders {
  const commands: Intervention[] = [];
  const rejected: RejectedOrder[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      rejected.push({ order: item, reason: '命令必须是 JSON 对象' });
      continue;
    }
    const o = item as Record<string, unknown>;
    if (typeof o.kind !== 'string') {
      rejected.push({ order: item, reason: '缺少 kind 字段(必须是小写字符串)' });
      continue;
    }
    if (o.from !== undefined && o.from !== play.year) {
      rejected.push({
        order: item,
        reason: `from 必须等于当前回合年份 ${play.year}(引擎只收下在"现在"的命令;省略 from 会自动填)`,
      });
      continue;
    }
    const v = cleanIntervention({ ...o, from: play.year });
    if (!v) {
      rejected.push({ order: item, reason: `这条 ${String(o.kind)} 命令的字段不合法,或这个版本不认识` });
      continue;
    }
    commands.push(v);
  }
  return { atYear: play.year, commands, rejected };
}

/** 目前引擎认的全部命令种类(用于给外部模型/工具调用者看的目录) */
export const ORDER_KINDS: { kind: string; fields: string; note: string }[] = [
  { kind: 'policy', fields: 'a(国键), preset?: expand|hold|trade|peace, war?/expand?/coast?/peace?(-50..50), focus?, foes?[≤3], friends?[≤3]', note: '定国策,直到下一条国策换掉;不写 preset 就按君主性格' },
  { kind: 'declare', fields: 'a, b(两国国键), lead?', note: '强制开战;不接壤/已在交战/一方已亡时打不成' },
  { kind: 'ally', fields: 'a, b, until?', note: '结盟,从起年互不宣战;正在交战会当即议和' },
  { kind: 'halt', fields: 'a, until?', note: '停止扩张、不主动宣战、不援盟;自己挑起的战争当即议和' },
  { kind: 'protect', fields: 'a, until?', note: '受保护,不许被灭/被并' },
  { kind: 'boost', fields: 'a, mul?: 3|10, until?, regions?', note: '推一把发展;不给 mul = 直接进下一个时代' },
  { kind: 'treaty', fields: 'a, ps?[1..3], term?, keep?, by?, zone?, ask?', note: '强制立约' },
  { kind: 'cede', fields: 'a, region(州键), permanent?', note: '把某州割让出去' },
  { kind: 'found', fields: 'region, name?', note: '在无主州立国' },
  { kind: 'move', fields: 'a, city', note: '迁都' },
  { kind: 'unity', fields: 'a', note: '禁止分裂' },
  { kind: 'keep', fields: 'a, until?', note: '保住王室,不许改朝换代' },
  { kind: 'destroy', fields: 'a, b?', note: '灭国' },
  { kind: 'temper', fields: 'a, person, leanings', note: '改某人的性格倾向' },
  { kind: 'disaster', fields: 'type: plague|famine|quake|pandemic, level: 1|2|3, city?/a?/region?/regions?', note: '天灾' },
  { kind: 'neutral', fields: 'a', note: '中立地' },
  { kind: 'crown', fields: 'a, char, born, leanings?, until?, ...', note: '立君(需要作者人物字段)' },
  { kind: 'regent', fields: 'a, char, ...', note: '设摄政(需要作者人物字段)' },
  { kind: 'marry', fields: 'a, person, ...', note: '联姻(需要作者人物字段)' },
  { kind: 'appoint', fields: 'a, person, ...', note: '任命(需要作者人物字段)' },
  { kind: 'death', fields: 'a, person', note: '人物死亡' },
  { kind: 'trek', fields: 'culture, region, ...', note: '民族迁徙' },
  { kind: 'stay', fields: 'culture, region', note: '民族定居' },
];

/** 稳定键的格式说明(外部模型需要用它指向国家/州/城等) */
export const KEY_HELP = `稳定键(引擎内部用,跨存档/跨年份不变):
- 国家: polity:c<地块>#<立国次序>   例 polity:c32577#0
- 州:   region:c<地块>             例 region:c123
- 城:   settlement:c<地块>#<次序>   例 settlement:c4567#1
- 民族: culture:c<地块>#<次序>
- 王朝: dynasty:c<地块>#<次序>/<档位>
只要拿到国家编号 P{id},用 civ_state_get 返回的 polities[].key 即可;不要自己拼。`;
