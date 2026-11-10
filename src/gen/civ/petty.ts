/**
 * 小事件(Petty Event)注册表。
 *
 * 这里只放"决定论 + 数据"：每条小事件模式说明它问 Jev 什么、选项长什么样、
 * 以及选项对应到引擎里能执行的效果(disaster/sack/dev/note)。真正的 HTTP 调用、
 * token 预算、串行队列、抽样与落盘都在 mcp/petty*.ts 里，引擎侧只负责在
 * `intervene()` 里执行 `petty` 干预(sack/dev)。
 *
 * 设计来源：m02301 任务书 + m02336 官方 Jev 1.14.0 适配。
 * 约束：
 *   - 只做选项有限、不改战略方向、可用概率表达的小事；
 *   - 绝不替君主决定宣战/议和/结盟/迁都/税率/继承/外交；
 *   - 抽样必须用引擎统一随机流(keyed)，这里只给"抽签函数"，随机数由调用方给。
 */

import { keyed } from '../util';

/** 小事件领域。 */
export type PettyDomain = 'economy' | 'environment' | 'military' | 'society' | 'infrastructure';

/** 队列优先级代号(P0 最高)。 */
export type PettyPriorityCode = 'P0' | 'P1' | 'P2';

/** 问题原语，与官方 Jev 的 noul/choice/score 一一对应。 */
export type PettyQuestionType = 'noul' | 'choice' | 'score';

/** 画像等级：L1 只带 P0；L2 带 P0/P1；L3 全带。 */
export type PettyProfile = 'L1' | 'L2' | 'L3';

export type PettyDisasterType = 'plague' | 'famine' | 'quake' | 'pandemic';

/** 一个选项落地后对引擎说的话。 */
export interface PettyEffect {
  /** 直接落成 disaster 干预(真人口折损/史事)。 */
  disaster?: { type: PettyDisasterType; level?: 1 | 2 | 3; target: 'region' | 'city' };
  /** 落成 petty 干预的 sack：城市记折损。 */
  sack?: { loss: 1 | 2 | 3; target: 'city' };
  /** 落成 petty 干预的 dev：委托引擎 boost。 */
  dev?: { years: number };
  /** 只写回合日志/编年摘要，不改引擎状态。 */
  note?: string;
}

export interface PettyOption {
  /** 与 Jev criteria 的 key 一致(score 用 '0'…'n-1')。 */
  key: string;
  /** 中文短名。 */
  label: string;
  /** 该选项抽中后的效果；null = 什么都不发生。 */
  effect: PettyEffect | null;
}

export interface PettyMode {
  id: PettyModeId;
  domain: PettyDomain;
  label: string;
  priority: PettyPriorityCode;
  profile: PettyProfile;
  /** 触发条件的一句话说明(给人看的，不参与机器判定)。 */
  trigger: string;
  question: {
    type: PettyQuestionType;
    instructions: string;
    /** choice: 选项 key → 说明；score: 2–10 条有序档位；noul 可省略。 */
    criteria?: Record<string, string> | readonly string[];
  };
  options: readonly PettyOption[];
}

export const PETTY_DOMAINS: readonly PettyDomain[] = ['economy', 'environment', 'military', 'society', 'infrastructure'];

export const PETTY_PRIORITY_NUM: Record<PettyPriorityCode, 0 | 1 | 2> = { P0: 0, P1: 1, P2: 2 };

export const PETTY_DOMAIN_LABEL: Record<PettyDomain, string> = {
  economy: '经济贸易',
  environment: '环境灾害',
  military: '军事非战略',
  society: '社会人口',
  infrastructure: '基础设施',
};

const opt = (key: string, label: string, effect: PettyEffect | null): PettyOption => ({ key, label, effect });

const disaster = (type: PettyDisasterType, level: 1 | 2 | 3, target: 'region' | 'city'): PettyEffect => ({
  disaster: { type, level, target },
});

/** 20 条模式。id 就是日志/存档里的稳定键，不要改。 */
export const PETTY_MODES: readonly PettyMode[] = [
  // ---------- 经济贸易(P1) ----------
  {
    id: 'trade_raid',
    domain: 'economy',
    label: '商队被劫',
    priority: 'P1',
    profile: 'L2',
    trigger: '有陆上商路穿过不太平的边疆时',
    question: {
      type: 'choice',
      instructions: '这支商队在经过边境时遭遇了什么？',
      criteria: { none: '平安通过', minor: '被抢走一部分货', major: '整队货被劫走' },
    },
    options: [
      opt('none', '平安通过', null),
      opt('minor', '被抢一部分', { note: '商队损失了一小部分货物' }),
      opt('major', '整队被劫', { sack: { loss: 1, target: 'city' } }),
    ],
  },
  {
    id: 'trade_profit',
    domain: 'economy',
    label: '一笔生意',
    priority: 'P1',
    profile: 'L2',
    trigger: '两国之间出现新的商机时',
    question: {
      type: 'score',
      instructions: '这趟买卖的结果如何？',
      criteria: ['亏本', '保本', '小赚', '大赚'],
    },
    options: [
      opt('0', '亏本', { note: '商人亏本，行会颇有怨言' }),
      opt('1', '保本', null),
      opt('2', '小赚', { note: '商人小赚一笔' }),
      opt('3', '大赚', { dev: { years: 1 } }),
    ],
  },
  {
    id: 'market_shortage',
    domain: 'economy',
    label: '市场缺货',
    priority: 'P1',
    profile: 'L2',
    trigger: '某地粮食库存偏低时',
    question: { type: 'noul', instructions: '当地市场会不会出现明显缺货？' },
    options: [opt('yes', '会缺货', disaster('famine', 1, 'region')), opt('no', '不会', null)],
  },
  {
    id: 'new_route',
    domain: 'economy',
    label: '新商路',
    priority: 'P1',
    profile: 'L2',
    trigger: '相邻两国关系缓和、地图上出现可通行缺口时',
    question: { type: 'noul', instructions: '会不会有人走通一条新的商路？' },
    options: [opt('yes', '走通了', { note: '商人们走通了一条新路' }), opt('no', '没走通', null)],
  },

  // ---------- 环境灾害(P0/P1) ----------
  {
    id: 'drought',
    domain: 'environment',
    label: '旱情',
    priority: 'P0',
    profile: 'L1',
    trigger: '某州降水低于均值且入夏时',
    question: { type: 'noul', instructions: '这一带会不会发生足以影响收成的旱灾？' },
    options: [opt('yes', '旱灾', disaster('famine', 1, 'region')), opt('no', '无旱灾', null)],
  },
  {
    id: 'flood',
    domain: 'environment',
    label: '水患',
    priority: 'P0',
    profile: 'L1',
    trigger: '某州临河且出现持续强降水时',
    question: { type: 'score', instructions: '这次水患的损失大概有多大？', criteria: ['基本没事', '淹了一些田', '冲毁村镇'] },
    options: [
      opt('0', '基本没事', null),
      opt('1', '淹了一些田', disaster('famine', 1, 'region')),
      opt('2', '冲毁村镇', disaster('famine', 2, 'region')),
    ],
  },
  {
    id: 'plague_seed',
    domain: 'environment',
    label: '疫病苗头',
    priority: 'P0',
    profile: 'L1',
    trigger: '某座城人口密集且与疫区有商路时',
    question: { type: 'noul', instructions: '这座城会不会爆发一场小规模疫病？' },
    options: [opt('yes', '爆发', disaster('plague', 1, 'city')), opt('no', '没有', null)],
  },
  {
    id: 'quake_damage',
    domain: 'environment',
    label: '地震损失',
    priority: 'P0',
    profile: 'L1',
    trigger: '某州位于断层附近且当年有地动时',
    question: { type: 'score', instructions: '这次地动造成的破坏有多大？', criteria: ['轻微', '损毁房屋', '城垣崩塌'] },
    options: [
      opt('0', '轻微', null),
      opt('1', '损毁房屋', disaster('quake', 1, 'region')),
      opt('2', '城垣崩塌', disaster('quake', 2, 'region')),
    ],
  },

  // ---------- 军事非战略(P0) ----------
  {
    id: 'border_clash',
    domain: 'military',
    label: '边境摩擦',
    priority: 'P0',
    profile: 'L1',
    trigger: '两国接壤且没有正式战争时',
    question: {
      type: 'choice',
      instructions: '边境上会不会出事？',
      criteria: { none: '无事', skirmish: '小规模冲突', raid: '越境劫掠' },
    },
    options: [
      opt('none', '无事', null),
      opt('skirmish', '小规模冲突', { note: '边境发生小规模冲突' }),
      opt('raid', '越境劫掠', { sack: { loss: 1, target: 'city' } }),
    ],
  },
  {
    id: 'ambush',
    domain: 'military',
    label: '行军遇伏',
    priority: 'P0',
    profile: 'L1',
    trigger: '军队穿过敌国山地或密林时',
    question: { type: 'noul', instructions: '这支军队会不会在途中遭到伏击？' },
    options: [opt('yes', '遇伏', { sack: { loss: 1, target: 'city' } }), opt('no', '无伏击', null)],
  },
  {
    id: 'siege_morale',
    domain: 'military',
    label: '围城士气',
    priority: 'P0',
    profile: 'L1',
    trigger: '某座城正被围困且围城已持续数月时',
    question: { type: 'score', instructions: '守城军民的士气如何？', criteria: ['崩溃', '动摇', '稳定'] },
    options: [
      opt('0', '崩溃', { sack: { loss: 2, target: 'city' } }),
      opt('1', '动摇', { sack: { loss: 1, target: 'city' } }),
      opt('2', '稳定', null),
    ],
  },
  {
    id: 'mercenary_contract',
    domain: 'military',
    label: '雇佣兵合同',
    priority: 'P0',
    profile: 'L1',
    trigger: '国家战时缺兵且邻国有多余佣兵时',
    question: { type: 'noul', instructions: '会不会有一支雇佣兵愿意接这单？' },
    options: [opt('yes', '谈成', { note: '一支雇佣兵接了单' }), opt('no', '没谈成', null)],
  },

  // ---------- 社会人口(P1) ----------
  {
    id: 'riot',
    domain: 'society',
    label: '民变苗头',
    priority: 'P1',
    profile: 'L2',
    trigger: '某城民怨(unrest)偏高时',
    question: { type: 'noul', instructions: '这座城会不会爆发一场小规模骚乱？' },
    options: [opt('yes', '骚乱', { sack: { loss: 1, target: 'city' } }), opt('no', '平息', null)],
  },
  {
    id: 'migration',
    domain: 'society',
    label: '迁徙潮',
    priority: 'P1',
    profile: 'L2',
    trigger: '某州战乱或灾荒后人口外流时',
    question: { type: 'score', instructions: '这场迁徙的规模有多大？', criteria: ['零星', '成批', '举州'] },
    options: [
      opt('0', '零星', null),
      opt('1', '成批', { note: '一批人迁往邻州' }),
      opt('2', '举州', { note: '大批人口外迁，州里空了不少' }),
    ],
  },
  {
    id: 'public_works',
    domain: 'society',
    label: '公共工程',
    priority: 'P1',
    profile: 'L2',
    trigger: '某国国库充裕且和平多年时',
    question: { type: 'noul', instructions: '当地会不会修成一处像样的公共工程？' },
    options: [opt('yes', '修成', { dev: { years: 1 } }), opt('no', '没修成', null)],
  },
  {
    id: 'talent',
    domain: 'society',
    label: '人才出现',
    priority: 'P1',
    profile: 'L2',
    trigger: '某国文化繁荣、学宫较多时',
    question: { type: 'noul', instructions: '这一年会不会冒出一个值得一提的人才？' },
    options: [opt('yes', '出了', { note: '一位小有名气的人才崭露头角' }), opt('no', '没有', null)],
  },

  // ---------- 基础设施(P2) ----------
  {
    id: 'build_quality',
    domain: 'infrastructure',
    label: '工程质量',
    priority: 'P2',
    profile: 'L3',
    trigger: '某国正在兴修工程时',
    question: { type: 'score', instructions: '这次工程修得怎么样？', criteria: ['偷工减料', '中规中矩', '超出预期'] },
    options: [
      opt('0', '偷工减料', { note: '工程偷工减料，日后要返修' }),
      opt('1', '中规中矩', null),
      opt('2', '超出预期', { dev: { years: 1 } }),
    ],
  },
  {
    id: 'road_damage',
    domain: 'infrastructure',
    label: '道路损坏',
    priority: 'P2',
    profile: 'L3',
    trigger: '某州的陆路在雨季/战后受损时',
    question: { type: 'noul', instructions: '这一段路会不会坏到需要封路？' },
    options: [opt('yes', '要封路', { note: '道路损坏，商旅绕行' }), opt('no', '还能走', null)],
  },
  {
    id: 'waterworks_fail',
    domain: 'infrastructure',
    label: '水利失修',
    priority: 'P2',
    profile: 'L3',
    trigger: '某州依赖灌溉且工程年久失修时',
    question: { type: 'noul', instructions: '这处水利工程会不会在关键时候出问题？' },
    options: [opt('yes', '出问题', disaster('famine', 1, 'region')), opt('no', '没事', null)],
  },
  {
    id: 'route_blocked',
    domain: 'infrastructure',
    label: '商路阻断',
    priority: 'P2',
    profile: 'L3',
    trigger: '某条商路经过山区或正在打仗的边境时',
    question: { type: 'noul', instructions: '这条商路会不会被彻底堵死一段时间？' },
    options: [opt('yes', '堵了', { note: '商路被堵死了一段时间' }), opt('no', '没堵', null)],
  },
];

export type PettyModeId =
  | 'trade_raid' | 'trade_profit' | 'market_shortage' | 'new_route'
  | 'drought' | 'flood' | 'plague_seed' | 'quake_damage'
  | 'border_clash' | 'ambush' | 'siege_morale' | 'mercenary_contract'
  | 'riot' | 'migration' | 'public_works' | 'talent'
  | 'build_quality' | 'road_damage' | 'waterworks_fail' | 'route_blocked';

export const PETTY_MODE_IDS: readonly PettyModeId[] = PETTY_MODES.map((m) => m.id);

const BY_ID = new Map<PettyModeId, PettyMode>(PETTY_MODES.map((m) => [m.id, m]));

export function pettyMode(id: PettyModeId): PettyMode {
  const mode = BY_ID.get(id);
  if (!mode) throw new Error(`不认识的小事件模式：${String(id)}`);
  return mode;
}

/** 按画像等级过滤要打包的模式(L1 只带 P0，L2 带 P0/P1，L3 全带)。 */
export function pettyModesForProfile(profile: PettyProfile): readonly PettyMode[] {
  if (profile === 'L1') return PETTY_MODES.filter((m) => m.priority === 'P0');
  if (profile === 'L2') return PETTY_MODES.filter((m) => m.priority !== 'P2');
  return PETTY_MODES;
}

/** 事件 id：稳定、可读、便于日志和抽样 salt。 */
export function pettyEventId(modeId: PettyModeId, year: number, polityId: number): string {
  return `${modeId}:${year}:${polityId}`;
}

/**
 * 确定性抽签：给 [选项 key, 权重] 与一个 [0,1) 随机数，返回抽中的 key。
 * 权重会被归一；全 0 时返回第一个 key。
 */
export function pickByWeight(options: readonly (readonly [string, number])[], roll: number): string {
  let total = 0;
  for (const [, w] of options) if (Number.isFinite(w) && w > 0) total += w;
  if (!(total > 0)) return options[0]?.[0] ?? '';
  const r = Math.min(0.999999999, Math.max(0, roll)) * total;
  let acc = 0;
  for (const [key, w] of options) {
    if (!(Number.isFinite(w) && w > 0)) continue;
    acc += w;
    if (r < acc) return key;
  }
  return options[options.length - 1][0];
}

/**
 * 用引擎统一的规范随机流派生这次抽签的随机数。
 * 不新建随机源：base 用世界种子，a/b/c 分别给年份、国家、事件用途味。
 */
export function pettyRoll(seed: number, year: number, polityId: number, modeIndex: number): number {
  return keyed(seed >>> 0, year | 0, polityId | 0, modeIndex | 0);
}

/** 选项总数与优先级统计(用于日志和测试)。 */
export function pettyRegistryStats(): { total: number; byPriority: Record<PettyPriorityCode, number>; byDomain: Record<PettyDomain, number> } {
  const byPriority: Record<PettyPriorityCode, number> = { P0: 0, P1: 0, P2: 0 };
  const byDomain: Record<PettyDomain, number> = { economy: 0, environment: 0, military: 0, society: 0, infrastructure: 0 };
  for (const m of PETTY_MODES) {
    byPriority[m.priority]++;
    byDomain[m.domain]++;
  }
  return { total: PETTY_MODES.length, byPriority, byDomain };
}
