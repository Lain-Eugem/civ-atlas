/**
 * P5 君主机制数值(行动点 / 亲征 / 安抚):集中放这里,方便调参与回放对账。
 *
 * 两个「不碰引擎」的近似(Lead 拍板,2026-11-14):
 *
 * 1. lead-army(御驾亲征)的 +20% 战力:
 *    引擎目前唯一的战力乘数是 `api.war.led`,只有 appoint 名将干预会注入它
 *    (src/gen/civ/interventions.ts,APPOINT_SKILL_POWER = 1.15 / 1.3)。
 *    mcp 层拿不到正在推演的 sim,也没有别的干预能改它,所以 LEAD_ARMY_BONUS
 *    只是一个记账/叙事常量,P5 阶段【不真正改战斗结果】;等以后引擎加
 *    「亲征乘数」钩子(civ.warBonus 之类)时,从这里接上再删掉 TODO。
 *    被俘/阵亡则用确定性 hash 掷骰,并走继位流程(见 mcp/monarch.ts)。
 *
 * 2. pacify-region(安抚地方)的稳定度加成:
 *    引擎没有可写的「稳定度」字段,所以落地成对本国的一次 boost 发展干预
 *    (regions 只指目标州,BOOST_YEARS_DEFAULT 年),叙事上记成「安抚某地」。
 *
 * AP 的科技等级 / 经济指数也没有现成标量:
 * - 科技 = 该国各州的时代数值(eraLevel,production/transport/information/administration
 *   的加权调和平均)的平均,0–8 左右;
 * - 经济 = 该国各州生产/运输/行政能力(0–9 档)平均 × 20,夹到 0–200;
 * - 没有 development 数据(极早期/损坏存档)时退化成 tech=0、economy=min(200, 州数*2)。
 */
import type { Civ } from '../src/gen/civ/types';
import { developmentAt, eraLevel } from '../src/gen/civ/development';

/** 一个回合折算多少个月(以后 P6 按月推演时这里直接吃真实月份) */
export function stepMonthsOf(stepYears: number): number {
  const years = Number.isFinite(stepYears) && stepYears > 0 ? stepYears : 1;
  return Math.max(1, Math.round(years * 12));
}

/** 回合跨度 → AP 倍率:1 月 0.4 / 3 月 0.65 / 6 月 0.8 / 12 月以上 1.0(7–11 月按 1.0,朝 12 月看齐) */
export function stepFactorOf(stepMonths: number): number {
  const m = Number.isFinite(stepMonths) && stepMonths > 0 ? stepMonths : 1;
  if (m <= 1) return 0.4;
  if (m <= 3) return 0.65;
  if (m <= 6) return 0.8;
  return 1;
}

/** AP 公式的基础值(还没有科技/经济加成时的底) */
export const AP_BASE = 4;
/** 每回合 AP 下限/上限(上限只是防呆,不是设计目标) */
export const AP_MIN = 1;
export const AP_MAX = 30;

/**
 * 君主一回合的行动点总量:
 * `round((4 + floor(科技等级 / 2) + floor(经济指数 / 40)) × 回合倍率)`,最小 1。
 */
export function monarchApTotal(tech: number, economy: number, stepMonths: number): number {
  const t = Number.isFinite(tech) ? Math.max(0, tech) : 0;
  const e = Number.isFinite(economy) ? Math.max(0, economy) : 0;
  const raw = (AP_BASE + Math.floor(t / 2) + Math.floor(e / 40)) * stepFactorOf(stepMonths);
  return Math.max(AP_MIN, Math.min(AP_MAX, Math.round(raw)));
}

/** 动作大小(小 1 / 中 2 / 大 3);具体命令的映射见 ENGINE_COMMAND_AP */
export const ACTION_COSTS = { minor: 1, medium: 2, major: 3 } as const;
/** 培养后代:大动作,而且占掉本回合主行动(不能同时亲征/派兵) */
export const CULTIVATE_HEIR_AP = 3;

/** 君主能下的引擎命令各自的 AP 成本(和 src/gen/civ/monarch.ts 的 MONARCH_KINDS 对齐) */
export const ENGINE_COMMAND_AP: Record<string, number> = {
  policy: ACTION_COSTS.medium,
  declare: 4,
  ally: ACTION_COSTS.medium,
  halt: ACTION_COSTS.minor,
  boost: ACTION_COSTS.major,
  protect: ACTION_COSTS.minor,
  press: 4,
  intel: ACTION_COSTS.medium,
};

/** 战争类命令(宣战/整场战争)成本:按目标国力 4/5/6 */
export function warApCost(targetSize: number): number {
  const n = Number.isFinite(targetSize) ? Math.max(0, targetSize) : 0;
  if (n >= 80) return 6;
  if (n >= 30) return 5;
  return 4;
}

/** 一条引擎命令的 AP 成本(declare/press 用 warApCost,其余查表) */
export function engineCommandAp(kind: string, targetSize = 0): number {
  if (kind === 'declare' || kind === 'press') return warApCost(targetSize);
  return ENGINE_COMMAND_AP[kind] ?? ACTION_COSTS.medium;
}

/** 四个君主特殊动作(P5 新增,不是引擎命令) */
export const SPECIAL_ACTIONS = ['cultivate-heir', 'lead-army', 'dispatch-army', 'pacify-region'] as const;
export type SpecialActionKind = (typeof SPECIAL_ACTIONS)[number];

export const SPECIAL_ACTION_AP: Record<SpecialActionKind, number> = {
  'cultivate-heir': CULTIVATE_HEIR_AP,
  'lead-army': 4,
  'dispatch-army': 2,
  'pacify-region': 1,
};

/** 动作的中文名(报告 / 日志 / UI 用) */
export const SPECIAL_ACTION_NAMES: Record<SpecialActionKind, string> = {
  'cultivate-heir': '培养后代',
  'lead-army': '御驾亲征',
  'dispatch-army': '派兵出征',
  'pacify-region': '安抚地方',
};

/** 亲征的战力加成:TODO 尚未真正接进引擎(见文件头说明 1) */
export const LEAD_ARMY_BONUS = 1.2;
/** 亲征时每年被俘 / 阵亡的概率(确定性 hash 掷,回合跨度线性放大) */
export const LEAD_ARMY_CAPTURE_RATE = 0.06;
export const LEAD_ARMY_DEATH_RATE = 0.02;
/** 亲征加成/风险都按「本回合参与的战争」算 */
export const LEAD_ARMY_MIN_YEARS = 1;

/** 安抚地方的近似:给目标州推一把发展 */
export const PACIFY_BOOST_MUL = 3;
/** 培养后代:已有后代时继续培养的 growth 增量 */
export const CULTIVATE_HEIR_GROWTH = 1;

export interface MonarchMetrics {
  /** 科技等级(时代数值平均,约 0–8) */
  tech: number;
  /** 经济指数(夹到 0–200) */
  economy: number;
  /** 升到几位小数前的原始均值(报告用) */
  era: number;
  /** 'development' | 'fallback' */
  source: 'development' | 'fallback';
  /** 参与统计的州数 */
  regions: number;
}

/**
 * 从 civ.development 派生一个国家的科技/经济替身指标。
 * 没有 development 或该国没有州时走 fallback,保证 AP 仍可算(不会抛)。
 */
export function monarchMetrics(civ: Civ, polityId: number, year: number): MonarchMetrics {
  const owned: number[] = [];
  for (let r = 0; r < civ.polity.length; r++) if (civ.polity[r] === polityId) owned.push(r);
  const dev = civ.development;
  if (!dev || !dev.snaps.length || !owned.length) {
    return { tech: 0, economy: Math.min(200, Math.max(0, owned.length * 2)), era: 0, source: 'fallback', regions: owned.length };
  }
  const lv = developmentAt(dev, year);
  let eraSum = 0;
  let economySum = 0;
  for (const r of owned) {
    eraSum += eraLevel(lv, r);
    // 0=生产 1=运输 2=信息 3=行政(见 src/gen/civ/development.ts 的 Cap)
    economySum += (lv[r * 5]! + lv[r * 5 + 1]! + lv[r * 5 + 2]! + lv[r * 5 + 3]!) / 4;
  }
  const era = eraSum / owned.length;
  const tech = Math.max(0, Math.min(9, era));
  const economy = Math.max(0, Math.min(200, Math.round((economySum / owned.length) * 20)));
  return { tech, economy, era, source: 'development', regions: owned.length };
}

/** 汇总给 UI / 报告:AP 公式的每个输入都摊开,便于解释 */
export interface MonarchApBreakdown {
  stepMonths: number;
  stepFactor: number;
  tech: number;
  economy: number;
  base: number;
  apTotal: number;
}

export function monarchApBreakdown(civ: Civ, polityId: number, year: number, stepYears: number): MonarchApBreakdown {
  const m = monarchMetrics(civ, polityId, year);
  const stepMonths = stepMonthsOf(stepYears);
  return {
    stepMonths,
    stepFactor: stepFactorOf(stepMonths),
    tech: Math.round(m.tech * 100) / 100,
    economy: m.economy,
    base: AP_BASE,
    apTotal: monarchApTotal(m.tech, m.economy, stepMonths),
  };
}

/**
 * 确定性 [0,1) 小数(FNV-1a 带盐):同一世界/年份/国家/用途永远同一个值,回放一致。
 * 培养后代的性格扰动、御驾亲征的风险判定都用它;测试也可以直接拿它复算。
 */
export function hashFraction(...parts: (string | number)[]): number {
  let h = 2166136261 >>> 0;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= 0x3c;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h / 4294967296;
}

export interface LeadArmyRisk {
  roll: number;
  deathRate: number;
  captureRate: number;
  outcome: 'safe' | 'captured' | 'death';
}

/**
 * 御驾亲征的风险:确定性 hash(世界种子, 国家, 年份),按本回合年数放大。
 * 说明:引擎的 war.led 只由 appoint 注入(见 src/gen/civ/interventions.ts),
 * mcp 层拿不到 sim,所以 +20% 战力目前只是 LEAD_ARMY_BONUS 这个常量/TODO;
 * 这里落地的是「被俘/阵亡」风险与叙事,以及继位链。
 */
export function leadArmyRisk(seed: number, polityId: number, year: number, years: number): LeadArmyRisk {
  const span = Math.max(1, Math.round(years));
  const deathRate = Math.min(0.5, LEAD_ARMY_DEATH_RATE * span);
  const captureRate = deathRate + Math.min(0.8, LEAD_ARMY_CAPTURE_RATE * span);
  const roll = hashFraction(seed, 'lead-army', polityId, year);
  const outcome: LeadArmyRisk['outcome'] = roll < deathRate ? 'death' : roll < captureRate ? 'captured' : 'safe';
  return { roll, deathRate, captureRate, outcome };
}
