/**
 * 君主角色卡:把"一个国家"换成"一个有寿命、有情绪、信息有限的人"。
 *
 * 纯计算,不碰 DOM、不联网。卡的数值部分由引擎的君主(rulerAt 的倾向)确定性映射,
 * 同一个世界 + 同一位君主永远得到同一张卡;persona 文案由模板拼成,不依赖模型,
 * 所以离线 mock、回放对账、换一台机器都一致。玩家/DM 可以用 cleanCardInput 改文案与档位。
 *
 * 卡只影响提示词与"合理性审核"(mcp/monarch-audit.ts),不进引擎、不改数值。
 * 君主死亡/改朝换代(rulerAt 换人)时调用方重建卡,旧记忆归档。
 */
import type { Civ, RulerLeanings } from './types';
import { polityKey } from '../edits';
import { rulerAt } from './story/peopleInfo';

/** 性格:谨慎 / 野心 / 荣誉感 / 贪欲,各 0–100 */
export interface MonarchTraits {
  caution: number;
  ambition: number;
  honor: number;
  greed: number;
}

/** 能力档位:0 = 想不到、1 = 寻常、2 = 老练;决定"这个角色能想到什么" */
export interface MonarchCompetence {
  war: 0 | 1 | 2;
  economy: 0 | 1 | 2;
  intrigue: 0 | 1 | 2;
  admin: 0 | 1 | 2;
}

export interface MonarchPreferences {
  war: 'avoid' | 'opportunist' | 'seek';
  economy: 'develop' | 'trade';
  diplomacy: 'honor' | 'pragmatic';
}

export interface MonarchCard {
  polityId: number;
  /** 国家稳定键(换君主不变) */
  key: string;
  /** 君主名与出生年(换人即重建卡的依据) */
  name: string;
  born: number;
  title?: string;
  /** 性格说明(40–200 字):必须把他写成一个自然生物,不是国家意识体 */
  persona: string;
  traits: MonarchTraits;
  preferences: MonarchPreferences;
  competence: MonarchCompetence;
  /** 君主生平(玩家填的自由文本,≤600 字;从生平推断性格的原始材料) */
  biography?: string;
  /** 种族(自由文本占位;启用种族系统时才与寿命联动) */
  race?: string;
  /** 是否启用种族系统(关闭时寿命一律 90) */
  raceSystem?: boolean;
  /** 寿命(岁,20–200;默认 90) */
  lifespan: number;
  /** 建卡时的年份 */
  createdAt: number;
}

/** 默认寿命(岁):不启用种族系统 / 没填种族时一律按它 */
export const CARD_LIFESPAN_DEFAULT = 90;
/** 寿命合法区间(岁) */
export const CARD_LIFESPAN_MIN = 20;
export const CARD_LIFESPAN_MAX = 200;
/** 生平 / 种族文本上限(与查看器面板一致) */
export const CARD_BIOGRAPHY_MAX = 600;
export const CARD_RACE_MAX = 40;

const clamp100 = (v: number): number => Math.max(0, Math.min(100, Math.round(v)));

/** 稳定的字符串散列(只用于把"这个人"的性格补齐;不用 Math.random) */
function hashOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const tier = (v: number): 0 | 1 | 2 => (v >= 65 ? 2 : v >= 35 ? 1 : 0);

/** 从引擎君主的倾向映射出角色卡(确定性) */
export function monarchCard(civ: Civ, polityId: number, year: number): MonarchCard | null {
  const p = civ.polities[polityId];
  if (!p) return null;
  const ruler = rulerAt(civ, polityId, year);
  const l: Partial<RulerLeanings> = ruler?.leanings ?? {};
  const expand = l.expand ?? 50;
  const war = l.war ?? 50;
  const develop = l.develop ?? 50;
  const trade = l.trade ?? 50;
  const name = ruler?.name ?? `${polityId} 号君主`;
  const born = Math.floor(ruler?.born ?? year - 40);
  const h = hashOf(`${polityKey(civ, polityId)}|${name}|${born}`);

  const traits: MonarchTraits = {
    caution: clamp100(100 - war * 0.7 + (develop - 50) * 0.2),
    ambition: clamp100(expand),
    honor: clamp100(50 + (trade - war) * 0.4 + ((h >>> 3) % 21) - 10),
    greed: clamp100(50 + (trade - develop) * 0.3 + ((h >>> 9) % 21) - 10),
  };
  const competence: MonarchCompetence = {
    war: tier(war),
    economy: tier((develop + trade) / 2),
    // 密谋不靠国家大小,靠这个人本身:1–2 档为主,特别正直的(荣誉 ≥80)才是 0
    intrigue: traits.honor >= 80 ? 0 : ((h >>> 5) % 2 === 0 ? 1 : 2),
    admin: tier(develop),
  };
  const preferences: MonarchPreferences = {
    war: war >= 60 ? 'seek' : war >= 40 ? 'opportunist' : 'avoid',
    economy: develop >= trade ? 'develop' : 'trade',
    diplomacy: traits.honor >= 60 ? 'honor' : 'pragmatic',
  };
  const card: MonarchCard = {
    polityId,
    key: polityKey(civ, polityId),
    name,
    born,
    ...(ruler?.title ? { title: ruler.title } : {}),
    persona: '',
    traits,
    preferences,
    competence,
    lifespan: CARD_LIFESPAN_DEFAULT,
    createdAt: Math.floor(year),
  };
  card.persona = personaOf(card);
  return card;
}

/** 性格说明:模板拼装(确定性),玩家/DM 之后可改 */
export function personaOf(card: MonarchCard): string {
  const t = card.traits;
  const temper =
    t.caution >= 65 ? '做事谨慎,没有把握的仗不肯打' : t.ambition >= 65 ? '野心大,看见弱的邻国就想伸手' : '不好也不坏,多数时候随处境走';
  const honor = t.honor >= 60 ? '看重承诺,背盟会让他寝食难安' : '务实,盟约在他眼里是可以权衡的东西';
  const like =
    card.preferences.economy === 'trade' ? '喜欢商路与市税带来的实打实进项' : '更愿意把人力投在田亩与城池上';
  return (
    `${card.name}是一个会老、会怕、会记仇的人,不是"国家意志"。${temper};${honor};${like}。` +
    `他只知道自己能探听到的事,不知道的事不会凭空想到;活不到的事,他不会当成自己的功劳。`
  );
}

/** 这张卡还是不是现在的君主(死亡、改朝换代 → false,调用方重建) */
export function cardIsCurrent(civ: Civ, card: MonarchCard, year: number): boolean {
  const ruler = rulerAt(civ, card.polityId, year);
  if (!ruler) return false;
  return ruler.name === card.name && Math.floor(ruler.born) === card.born;
}

const COMPETENCE_KEYS = ['war', 'economy', 'intrigue', 'admin'] as const;

/** 玩家/DM 改卡:只接受文案、性格、偏好、能力、生平/种族/寿命;数值夹回合法区间 */
export function cleanCardInput(raw: unknown, base: MonarchCard): MonarchCard {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: MonarchCard = { ...base, traits: { ...base.traits }, preferences: { ...base.preferences }, competence: { ...base.competence } };
  if (typeof o.persona === 'string' && o.persona.trim()) out.persona = o.persona.trim().slice(0, 200);
  if (typeof o.biography === 'string') {
    const biography = o.biography.trim().slice(0, CARD_BIOGRAPHY_MAX);
    if (biography) out.biography = biography;
    else delete out.biography;
  }
  if (typeof o.race === 'string') {
    const race = o.race.trim().slice(0, CARD_RACE_MAX);
    if (race) out.race = race;
    else delete out.race;
  }
  if (typeof o.raceSystem === 'boolean') out.raceSystem = o.raceSystem;
  const lifeRaw = typeof o.lifespan === 'number' && Number.isFinite(o.lifespan) ? Math.round(o.lifespan) : out.lifespan;
  // 种族系统关掉时寿命固定 90;开着才允许 20–200 的自定义寿命
  out.lifespan = out.raceSystem
    ? Math.max(CARD_LIFESPAN_MIN, Math.min(CARD_LIFESPAN_MAX, lifeRaw))
    : CARD_LIFESPAN_DEFAULT;
  const t = (o.traits ?? {}) as Record<string, unknown>;
  for (const k of ['caution', 'ambition', 'honor', 'greed'] as const) {
    const v = t[k];
    if (typeof v === 'number' && Number.isFinite(v)) out.traits[k] = clamp100(v);
  }
  const p = (o.preferences ?? {}) as Record<string, unknown>;
  if (p.war === 'avoid' || p.war === 'opportunist' || p.war === 'seek') out.preferences.war = p.war;
  if (p.economy === 'develop' || p.economy === 'trade') out.preferences.economy = p.economy;
  if (p.diplomacy === 'honor' || p.diplomacy === 'pragmatic') out.preferences.diplomacy = p.diplomacy;
  const c = (o.competence ?? {}) as Record<string, unknown>;
  for (const k of COMPETENCE_KEYS) {
    const v = c[k];
    if (typeof v === 'number' && Number.isFinite(v)) out.competence[k] = Math.max(0, Math.min(2, Math.round(v))) as 0 | 1 | 2;
  }
  return out;
}

const WAR_TEXT = { avoid: '能不打就不打', opportunist: '有机会才打', seek: '主动寻找开战的机会' } as const;
const COMPETENCE_TEXT = ['想不到这一层', '寻常水准', '老练'] as const;

/**
 * 角色卡的提示词段(稳定层:换君主才变,不含年份,保证前缀缓存可命中)。
 * "能力"在这里写成"他能想到什么",供 mcp/monarch-audit.ts 的 Jev 审核引用同一份口径。
 */
export function cardSystemText(card: MonarchCard): string {
  const t = card.traits;
  const c = card.competence;
  return [
    `## 你是谁(角色卡)`,
    `你扮演 ${card.name}${card.title ? `(${card.title})` : ''},第 ${card.born} 年生。`,
    card.persona,
    `- 性格:谨慎 ${t.caution}、野心 ${t.ambition}、荣誉感 ${t.honor}、贪欲 ${t.greed}(0–100)。`,
    `- 策略偏好:战争 = ${WAR_TEXT[card.preferences.war]};经济 = ${card.preferences.economy === 'trade' ? '重商' : '重农与建设'};外交 = ${card.preferences.diplomacy === 'honor' ? '守信' : '务实'}。`,
    `- 能力:用兵${COMPETENCE_TEXT[c.war]},理财${COMPETENCE_TEXT[c.economy]},密谋${COMPETENCE_TEXT[c.intrigue]},理政${COMPETENCE_TEXT[c.admin]}。`,
    ...(card.race ? [`- 种族:${card.race}${card.raceSystem ? `(这个种族自然寿命约 ${card.lifespan} 岁)` : ''}。`] : []),
    `- 寿命:你按凡人的寿命活着,预计能活到 ${card.lifespan} 岁左右。`,
    `- 你是一个人,不是国家本身:只能做"这个人想得到、办得到"的决定;超出能力的事不要写进命令。`,
  ].join('\n');
}
