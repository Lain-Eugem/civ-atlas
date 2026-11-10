/**
 * 战争与攻占:国家之间宣战、攻城略地、议和;国土被占光的国家灭亡,国都失守的国家迁都。
 * 挂在同一个推演引擎(sim.ts)上,改归属一律走 setOwner(原因 = Ev.Conquer),发生了什么记进史事(sim.record)。
 *
 * 流程(index.ts 在 installPolities 之后调用 installWars):
 *
 *   看邻国(Ev.WarCheck)每个国家立国 CHECK_FIRST 年后,每 CHECK_EVERY 年看一眼(每段里随机一个时刻)。
 *     自己没在打仗(帝国级的大国可以两线作战)、上次议和过了 REST 年,就在接壤的邻国里挑一个最"值得打"的:
 *       赔率 = WAR_ODDS × 扩张性 × 边境胜算^LOCAL_EXP × 异族 FOREIGN × 收复失地 × 小国 PREY_ODDS × 边界长短
 *       挑好了打谁,开不开战再乘此刻在位君主的好战倍数(rulers.ts:越好战越容易开战)
 *       国家方针(policy.ts):倍数是君主倾向加上方针的;亲国不打,仇国的赔率 × FOE_ODDS(先打它)
 *       动荡(unrest.ts):邻国大乱的格外招人(趁虚而入),自己国内乱也更想对外开战(转移矛盾;动荡到 DIVERT_U 再上调一档)
 *       钱粮(control.ts):国用不足(窘迫 0–1)的赔率 × (1 − BROKE_CUT × 窘迫),国库没攒满的再打折(PURSE_0)
 *       开战看内政(趁虚而入,见 weakness):邻国有割据(control.ts)、疫后凋敝(近年染疫的州多,unrest.ts)、幼主在位或权臣当政(regents.ts),
 *       赔率各乘一截;国库空竭、钱粮这一截压到 PLUNDER_FLOOR 以下的,边境对面有富州(一州的收入是本国每州平均的 RICH 倍以上)
 *       就按 PLUNDER_FLOOR 算(为掠夺而战)。由头见 causeOf
 *       物产(development.ts 挂上):本国缺盐、缺牲畜(马),认得金银、铁以后缺金银、铁,快到下一个时代门口缺那道门槛要的矿,
 *       边境对面的州正好有,赔率 × (1 + RES_WANT × 缺的样数,最多算 RES_MAX 样);开战的由头写"欲夺某州之铁"
 *       (收复故土、乘乱的照旧写那两样)
 *       边境胜算 = 对方边境上各州的胜率(和打仗时一样按局部国力算)的平均,换成"胜率 ÷ 败率":
 *       强国的边远处照样可能打不过近处的小国 —— 被夺去的州过些年又被夺回来,前线有来有回
 *     同一对国家议和后 TRUCE 年内不再开战;对方已经同时在打 MAX_WARS 场仗的不去凑;
 *     分裂 / 复国出来的国家(politics.ts)立国 NEWBORN 年内没人对它宣战(站稳期)。
 *     议和了还会再打:一场仗议和时净丢了州的一方记恨赢它的那一国,GRUDGE_YEARS 年内看邻国时对它的赔率 × GRUDGE;
 *       停战期满后再过 REVENGE_LOOK 里随机的几年,替输的一方多看一眼邻国(复仇之战;随机数按 REVENGE_K + 战争编号取,不接着预约)。
 *       讨伐民变、宗室争位的内战不记恨。
 *     连续吞并:一场仗议和时净得了 CHAIN_MIN 州以上的一方(大胜)不歇(打完歇 REST 年那条对它不算),
 *       再过 CHAIN_LOOK 里随机的几年替它多看一眼邻国(随机数按 CHAIN_K + 战争编号取,不接着预约);
 *       这一眼只挑弱得多的邻国(国力不到本国的 1 / CRUSH):接着吞小国,不去碰硬(碰硬的大国一场接一场打,国祚反而短)。
 *     国力 = 本国城镇人口之和(growth.ts 的 populationAt;城的人口上限随生产能力变)× 军力系数(PolityModel.military,
 *     发展度按国都所在州的动员能力定,有上下限);照大纲顺着引的方针再乘它的国力倍数(policy.ts 的 powerScale)。
 *     挂了政局数表(control.ts)时读表里每年年初算的国力;这一年里才立的国家照这里现算。
 *   宣战 → 每隔 GAP 年打一仗(Ev.Campaign):
 *     攻方挑一个**和自己国土接壤**的敌州打(国土保持成片):被自己围得越多的州越先打(前线齐整,不打出飞地),
 *       其次是离敌国国都近的(直取国都)、好走的(翻山、跨河难打)、有本国缺的物产的(RES_TARGET);打下来会把敌国切出一大块(> MAX_CUT 州)的先不打。
 *     打不打得下看局部国力:双方国力各按"离本国国都的路程"打折(远征越远越弱;军力系数高的打折少,强国能越打越远),
 *       守方再乘过界难度(翻山 / 跨河 / 渡海)、守国都、守本族的加成;胜率 = 攻² ÷ (攻² + 守²)。
 *       作者的良将 / 名将(干预任将带能力)挂帅的仗,他那一方再乘他的倍数(攻守都算;谁领哪场见 appoint.ts,接口 war.led)。
 *     打下来了还能乘胜:接着挑下一州,机会 = BREAK × 那一州的胜率,最多再连下 BREAK_MAX 州(打下国都、一方亡国就停)。
 *     打不下来,守方有 COUNTER 的机会反攻,夺回被攻方占去的州(这场战争里丢的、以前丢的;同样按局部国力)。
 *     没打下来的这一仗(攻方的、守方反攻的)记一条史事 battle(从哪种边打过去记在 via),不改归属,编年史写成"某某之战"。
 *     据险断后:一方败退、另一方追来(攻方乘胜连下的下一州、守方反攻要夺回的那州,本来能打下来),
 *       追兵只能从关隘打进那州,或者败兵只能经关隘退回本国(刚丢的那州、攻过来的那州和本国之间,能走的边里没有不带关隘的平地、渡河;
 *       关隘 = 交界的山脊上又低又窄的口子,在地块一级找,见 passes.ts):
 *       败退的一方有 STAND 的机会留一支兵守住关隘、挡住追兵,掩护大军退保关隘后面那州 —— 追兵本来能打下的那一州就此打不下来,
 *       乘胜追击到此为止(仗照常往下打)。记一条史事 stand(关隘在哪州、大军退保哪州、守了几日、守将的结局见 STAND_DAYS、STAND_SLAIN),
 *       编年史写成"某某以数百人守某州之隘,拒敌三日,力战而死";守将是谁由人物(people.ts)按它排。讨伐民变的仗不算。
 *     一州易手后 HOLD 年内不会再易手:前线有来有回,但不会闪烁。
 *     出兵避冬:轮到下一仗时,攻方要打的那州正在冬天里(月温低于 WINTER_T,年内气温是估算,见 gen/seasons.ts)就不打,
 *       顿兵到那州开春后几天再打这一仗(常年冰封的地方照旧打);记一条史事 winter(要打的那州、开春再打的时刻记在 until),
 *       编年史写成"冬,某军顿兵某州,待春复攻"。顿兵期间照常能议和(作者下令的、另一场仗里亡国的)。
 *   攻占 → 州归攻方(民族不变,只换国家;城可能被洗劫、被毁,见 cities.ts)。丢的是国都:还有别的州就迁都到剩下人口最多的城
 *     (剩下的国土被切成几块时,在人口最多的那一块里挑),新国都 CAPITAL_GRACE 年内攻不下;
 *     只剩不到 MIN_STATE 州的撑不下去,残部归攻方、亡国;
 *     破都纳降:攻方国力是守方 SURRENDER_POWER 倍以上、守方余下的州不超过攻方国土的 SURRENDER_SHARE,余下的州一并归降攻方、亡国
 *     (史事 fall 的 cause = surrender;讨伐民变、宗室争位的内战、阶段 4 干预不许灭的国家不算;更大的照旧迁都接着撑);
 *     一州不剩就灭亡(Polity.ended),它的所有战争随之结束。
 *   议和:打满这场战争的年限(厌战,LENGTH 里随机)、连着 STALL 年没打下一州(僵持)、
 *     攻方达成战争目标(拿下 GOAL 里随机的几州)、拿下国都、或守方丢了过半国土、攻方国用不足(窘迫到 BROKE_PEACE,仗已打过年限的 BROKE_LENGTH)→ 议和,占领的州归攻方;
 *     年限、目标看攻方此刻在位的君主(rulers.ts):越好战打得越久、想多拿几州,好战低的早早罢兵;
 *     罢兵割地:战役里议和(厌战、僵持、达成目标都算;讨伐民变的不算)时攻方这场仗净得了州,守方再割边上 CEDE 州(不割国都,
 *     割完至少还剩 MIN_STATE + 1 州;挑哪州和打仗时一样);
 *     议和时两国各自被切出去、挨着对方的飞地割给对方(划清边界;割让的州数 —— 连同罢兵割的 —— 记在史事 peace 的 region 列,
 *     罢兵割的几州排在最前面,有几州记在 n 列)。
 *     攻方国力是守方 CRUSH 倍以上时是灭国之战:拿下国都、对方丢了过半国土、达成战争目标都不停,直到厌战、僵持或对方亡国。
 *
 * 同一年里的先后:宣战 → 战役(没打下来的那一仗)/ 攻占 → 灭亡 / 迁都 → 议和(史事按这个顺序记)。
 *
 * 阶段 4 干预(interventions.ts,挂在 WarModel.iv 上;没有干预时为空,只多一次判空):
 *   不许灭的国家,国都和紧挨着国都的州(京畿)攻不下,只剩 PROTECT_KEEP 州以下时一州都攻不下(pickTarget 跳过,看邻国也不挑它),
 *   守得也格外牢(PROTECT_DEF);结盟的两国不互相宣战;
 *   一国被宣战时,它的盟国(和攻方接壤)有 ALLY_JOIN 的机会向攻方宣战(援盟,史事 war 的 settlement 列记盟国;援盟不再连锁);
 *   强制宣战、结盟时当即议和走 接口 war.declare / makePeace。
 *   永久划给某国的州(干预"划州"带"永久",还在那国手里时)攻不下、议和时不割让;手里有这种州的国家丢了国都也不会被并掉残部
 *   (迁都到剩下的城,那一块里没城就到别的块里挑;一座城都没有才照旧被并 —— 极少见);
 *   不许扩张的国家不主动宣战、不援盟(被打时照常防守、反攻夺回自己的州)。
 *
 * **不存内存状态**:进行中的战争、厌战、停战冷却都能由 Civ 重建(resumeWars,resumeCiv 调用)——
 *   战争 = 史事里的 war(没有对应 peace 的就还在打);每场战争攻占了哪些州 = 带战争编号的 conquer;
 *   冷却 = 最近一次 peace 的年份;记恨 = 每场 peace 时这场战争里谁净丢了州(攻占都在史事里);一州多久没易手 = 变化日志;
 *   连续吞并 = 每场 peace 时这场战争里赢家净得了几州(它的冷却作废、多看的那一眼照样补);
 *   看邻国、打仗、复仇 / 连续吞并多看的那一眼的时刻都是由"国家 / 战争 + 第几次"算出来的;顿兵过冬挪到哪一刻记在史事 winter 里。
 *
 * 随机数:keyed(subSeed(seed, 'civ-war'), 国家…, 第几次, 用途);一场战争里的随机数按"攻方 + 守方 + 宣战时刻 + 第几仗"取,
 * 和处理顺序、战争编号都无关。国家、州一律用位置锚(PolityModel.ptag、治所地块;见 rand.ts),不用编号。纯计算,不碰 DOM。
 */
import type { World } from '../world';
import { coldShare, coldSpellEnd, yearClimate } from '../seasons';
import { AdjKind, Layer, type Annal, type AnnalCause, type Civ, type Polity, type Year } from './types';
import { fexp, flog, fpow, keyed, keyed4, round24, subSeed } from './engine/rand';
import { bookChain, LOOK_K, quantize, type CivSim } from './engine/sim';
import { befriends, canCross, coreOf, effOf, endPolity, moveCapital, picks, policyAt, polityModelOf, powerScaleOf, regentOf, rulerOf, type PolityModel } from './polities';
import { reignBorn } from './rulers';
import { REGENTS_KNOBS } from './regents';
import { POLICY_KNOBS } from './policy';
import { capitalAt, populationAt } from './growth';
import { regionPasses } from './passes';
import type { InterventionModel } from './interventions';
import type { DiplomacyModel } from './diplomacy';
import { royalAt } from './regime';
import type { CivModule } from './modules';
import { Ev } from './events';
import { civApi } from './api';
import { defineKnobs } from './engine/knobs';
import { mulOf } from './influence';

// ---- 调参(以截图和统计数为准,见 scripts/gen-stats.ts) ----
/** 这一段的旋钮(名字、官方的值;推演照这个世界的那套数算,见 engine/knobs.ts) */
export const WARS_KNOBS = defineKnobs('wars', {
  /** 立国后多少年开始看邻国;之后每隔多少年看一次(每段里 20%–80% 处随机一个时刻) */
  CHECK_FIRST: 40,
  CHECK_EVERY: 15,
  /** 宣战赔率的底数(国家之间常隔着部落、接壤的不多,底数取得高些);边境胜算(胜率 ÷ 败率)的指数;对异族 */
  WAR_ODDS: 0.3,
  LOCAL_EXP: 0.65,
  FOREIGN: 1.6,
  /** 边界不到这么多段(州与州相邻的对数)时,赔率按比例打折 */
  BORDER_FULL: 4,
  /** 打完仗至少歇多少年才会再主动宣战;同一对国家议和后多少年内不再开战 */
  REST: 4,
  TRUCE: 5,
  /** 一国最多同时打几场仗(被别国趁火打劫算在内);国土到这么多州(帝国一档)的大国可以同时主动开两场仗 */
  MAX_WARS: 2,
  TWO_FRONTS: 70,
  /** 两仗之间隔几年(随机) */
  GAP: [0.7, 2] as [number, number],
  /** 厌战:一场战争最多打多少年(随机) */
  LENGTH: [5, 18] as [number, number],
  /** 僵持:连着这么多年没攻下一州就议和 */
  STALL: 6,
  /** 小国:不超过这么多州的邻国,宣战赔率 × PREY_ODDS */
  PREY: 4,
  PREY_ODDS: 2.5,
  /** 分裂 / 复国出来的国家(Polity.parent),这么多年内别国不对它宣战(站稳期;原先 60 年,缩短以后强国吞并得快些) */
  NEWBORN: 30,
  /** 迁都后这么多年内新国都攻不下(不会几年里一迁再迁) */
  CAPITAL_GRACE: 20,
  /** 丢了国都后剩下不到这么多州的国家撑不下去,残部归攻方、亡国 */
  MIN_STATE: 4,
  /**
   * 破都纳降:攻下国都时攻方国力是守方 SURRENDER_POWER 倍以上、守方余下的州不超过攻方国土(连同刚打下的国都)的 SURRENDER_SHARE,
   * 守方余下的国土一并归降攻方、亡国(更大的照旧迁都接着撑:不会一仗吞掉一个大国)
   */
  SURRENDER_POWER: 2.5,
  SURRENDER_SHARE: 0.5,
  /** 打下一州会把守方的国土切出去超过这么多州(和守方国都不再连成一片)的,先不打(不打出大块飞地) */
  MAX_CUT: 2,
  /** 一州换了国家以后,这么多年内不会再在战争里易手(前线不闪烁) */
  HOLD: 6,
  /** 远征打折:国力 × e^(−离本国国都的路程 / PROJECT)(路程以"标准路程"计,见 polities.ts 的 capDist) */
  PROJECT: 18,
  /** 守方的过界加成(按 AdjKind:平地、跨河、翻山、海峡、航线):攻方从最好打的那条边打进来 */
  DEFENSE: [1, 1.35, 1.9, 1.6, 2.2],
  /** 守国都;守本族的州;攻方打同族的州 */
  CAPITAL_DEF: 1.8,
  HOME_DEF: 1.25,
  KIN_ATTACK: 1.15,
  /** 胜率的上下限(再强也有失手,再弱也有侥幸) */
  P_MIN: 0.04,
  P_MAX: 0.9,
  /** 攻方没打下来时,守方反攻(夺回被攻方占去的州)的机会 */
  COUNTER: 0.85,
  /** 乘胜:一仗打下一州后,接着再打下一州的机会 = BREAK × 那一州的胜率,最多再连下 BREAK_MAX 州(一仗最多拿下 1 + BREAK_MAX 州,势如破竹) */
  BREAK: 0.9,
  BREAK_MAX: 6,
  /** 战争目标:这场战争想拿下几州(随机,含两头);拿到就议和 */
  GOAL: [3, 20] as [number, number],
  /** 灭国之战:攻方国力是守方的这么多倍(原先 3 倍);战争目标翻几倍(Infinity = 不设目标) */
  CRUSH: 2.5,
  CRUSH_GOAL: Infinity,
  /** 收复失地:邻国手里每有一州原是本国的,宣战赔率 × (1 + REVANCHE)(最多算 4 州);打仗时先打这些州 */
  REVANCHE: 0.8,
  REGAIN: 2.5,
  /** 阶段 4 结盟:盟国被第三国宣战时,另一方(和攻方接壤)援盟参战的机会 */
  ALLY_JOIN: 0.8,
  /** 阶段 4 不许灭:国都攻不下;国土只剩这么多州(含)以下时,一州都攻不下(保住国都一带的几州,不至于缩成孤城) */
  PROTECT_KEEP: 3,
  /** 阶段 4 不许灭:守方国力 × 这么多(天命所归,守得格外牢:国土会缩,但不至于一路缩到只剩国都) */
  PROTECT_DEF: 1.6,
  /** 开战的由头"乘乱":对方正和别国交兵,或这么多年内丢了国都 / 迁都、改朝换代 */
  CHAOS_YEARS: 20,
  /**
   * 动荡(unrest.ts):邻国动荡超过 PREY_CALM 的部分每一点,开战的赔率 × (1 + PREY_UNREST)(趁虚而入);
   * 自己动荡每一点 × (1 + DIVERT)(对外开战转移矛盾)
   */
  PREY_CALM: 1,
  /**
   * 钱粮(control.ts):国用不足(0–1)时宣战的赔率 × (1 − BROKE_CUT × 窘迫);攻方窘迫到 BROKE_PEACE 以上、仗打过了年限的 BROKE_LENGTH 就罢兵(讨伐民变除外);
   * 国库没攒满的,赔率再 × (PURSE_0 + (1 − PURSE_0) × 国库攒到几成)(刚因没钱罢兵的不会转头又开战)
   */
  BROKE_CUT: 1,
  BROKE_PEACE: 0.8,
  BROKE_LENGTH: 0.5,
  PURSE_0: 0.4,
  /** 讨伐民变的战争最多打几倍的年限(见 接口 war.revolt):打不完就议和,起事的一方割据一方 */
  REVOLT_LENGTH: 1.5,
  PREY_UNREST: 0.35,
  DIVERT: 0.15,
  /** 转移矛盾:自己动荡到这么高,开战的赔率再 × (1 + DIVERT_STEP)(上调一档),由头写"国中多事,欲以外战安内" */
  DIVERT_U: 1.5,
  DIVERT_STEP: 0.25,
  /**
   * 趁虚而入:邻国动荡到 PREY_HIGH 以上,由头写"乘某国内乱"(赔率照上面的 PREY_UNREST);
   * 有割据的每处 × (1 + LORD_PREY)(最多算 LORD_PREY_MAX 处;割据的州不出兵,国力本就弱了,这里只算"内乱招人");
   * 疫后凋敝(unrest.ts 的 blight:近年染疫的州占国土几成)到 BLIGHT_MIN 以上 × (1 + BLIGHT_PREY × 几成 ÷ BLIGHT_FULL,最多加满);
   * 幼主在位(不满 ADULT 岁)、权臣当政(regents.ts 的宗室摄政、名臣辅政、大臣专权、大将专权)× (1 + WEAK_PREY)
   */
  PREY_HIGH: 2,
  LORD_PREY: 0.25,
  LORD_PREY_MAX: 2,
  BLIGHT_MIN: 0.15,
  BLIGHT_FULL: 0.5,
  BLIGHT_PREY: 0.6,
  WEAK_PREY: 0.4,
  /**
   * 为掠夺而战:钱粮那一截(窘迫、国库没攒满的打折乘起来)不到 PLUNDER_FLOOR、边境对面有富州(收入是本国每州平均的 RICH 倍以上)的,
   * 对这个邻国按 PLUNDER_FLOOR 算(打不起,但抢得到);由头写"府库空竭,欲掠某国某州"
   */
  PLUNDER_FLOOR: 0.3,
  RICH: 2,
  /** 物产:边境对面有本国缺的物产,每样开战的赔率 × (1 + RES_WANT),最多算 RES_MAX 样;攻方挑州时有本国缺的物产的州加 RES_TARGET 分 */
  RES_WANT: 1.5,
  RES_MAX: 2,
  RES_TARGET: 1.5,
  /**
   * 据险断后:追兵只能从关隘打进那州、或者败兵只能经关隘退回时,败退的一方守住关隘的机会;
   * 守了几日(随机挑一个);守将力战而死、力竭被擒的机会(其余全师而退)
   */
  STAND: 0.35,
  STAND_DAYS: [2, 2, 3, 3, 3, 4, 4, 5, 6, 7],
  STAND_SLAIN: 0.6,
  STAND_TAKEN: 0.15,
  /**
   * 议和了还会再打:净丢了州的一方记恨赢它的那一国,这么多年内对它开战的赔率 × GRUDGE;
   * 停战期满(TRUCE)后再过这么多年(随机)替输的一方多看一眼邻国
   */
  GRUDGE: 2,
  GRUDGE_YEARS: 80,
  REVENGE_LOOK: [2, 8] as [number, number],
  /** 罢兵割地:攻方这场仗净得了州,议和时守方再割这么多州 */
  CEDE: 1,
  /** 罢兵割地挑州时 pickTarget 的"第几仗"(取随机数用;一场仗打不到这么多仗) */
  CEDE_I: 1000,
  /**
   * 连续吞并:一场仗议和时净得了 CHAIN_MIN 州以上的一方(大胜)不歇(打完歇 REST 年那条对它不算),
   * 再过 CHAIN_LOOK 里随机的几年替它多看一眼邻国,只挑国力不到本国 1 / CRUSH 的
   */
  CHAIN_MIN: 3,
  CHAIN_LOOK: [2, 6] as [number, number],
  /**
   * 出兵避冬:轮到下一仗时要打的那州正在冬天里(月温低于 WINTER_T °C,年内气温估算见 gen/seasons.ts),这一仗顺延到那州开春,
   * 再隔 0–WINTER_JITTER 年(约三周,随机)才打;一年里 WINTER_ALWAYS 以上的日子都这么冷的地方(常年冰封)照旧打
   */
  WINTER_T: 3,
  WINTER_JITTER: 0.06,
  WINTER_ALWAYS: 0.9,
});
/** 这张表的值(一套数里取出来的) */
export type WarsKnobs = typeof WARS_KNOBS.values;
/** 复仇多看的那一眼的"第几次"从这里往上数(+ 战争编号;和照大纲多看的一眼 LOOK_K 往上那一段分开) */
const REVENGE_K = 1 << 28;
/** 连续吞并多看的那一眼的"第几次"从这里往上数(+ 战争编号;和复仇之眼 REVENGE_K 往上那一段分开) */
const CHAIN_K = REVENGE_K + (1 << 27);

// 随机数用途编号
const U_CHECK_T = 1;
const U_DECLARE = 2;
const U_GAP = 3;
const U_LENGTH = 4;
const U_ATTACK = 5;
const U_COUNTER = 6;
const U_RETAKE = 7;
const U_TARGET = 8;
const U_GOAL = 9;
const U_ALLY = 10;
const U_BREAK = 11;
const U_STAND = 12;
const U_STAND_DAYS = 13;
const U_STAND_END = 14;
const U_REVENGE = 15;
const U_THAW = 16;
const U_CHAIN = 17;

// ---------------------------------------------------------------------------
// 模型

/** 一场战争(由史事就能重建) */
export interface War {
  /** 战争编号(0 起,按宣战先后) = 史事里的 war */
  id: number;
  /** 攻方、守方 */
  a: number;
  b: number;
  /** 宣战的年份 */
  start: Year;
  /** 议和的年份(还在打 = undefined) */
  end?: Year;
  /** 这场战争里攻占的州(按先后):by = 攻占它的一方 */
  takes: { year: Year; region: number; by: number }[];
}

export interface WarModel {
  /** 这次推演的那套数里战争这张表 */
  k: WarsKnobs;
  pm: PolityModel;
  base: number;
  wars: War[];
  /** 还在打的仗(按编号) */
  active: War[];
  /** 州 → 最近一次换国家的年份(从来没归过国家 = −Infinity) */
  since: Float64Array;
  /** 州 → 换到现在这个国家之前属于哪国(−1 = 部落地带 / 没换过):收复失地用 */
  prev: Int16Array;
  /** 国家 → 最近一次议和的年份 */
  rest: Map<number, Year>;
  /** 两国最近一次议和的年份(键见 pairKey) */
  truce: Map<number, Year>;
  /** 记恨:净丢了州的一方 × 32768 + 赢它的那一国 → 那场仗议和的年份(见 grudgeOf) */
  grudge: Map<number, Year>;
  /** 阶段 4 干预(interventions.ts 挂上;没有干预 = 不给):不许灭、结盟在这里查 */
  iv?: InterventionModel;
  /** 邦交(diplomacy.ts 挂上):结着的盟、宗藩之分在这里查 */
  dm?: DiplomacyModel;
  // 别的子系统挂给战争、战争提供给别人的回调(攻城、立约、钱粮、动荡……)不在这里,在具名接口表 civ/api.ts 的 war 那一组
}

/** 邻国的内忧(看邻国时算,见 installWars 里的 weakness):赔率倍数、够得上写由头的那一样、割据的那州(没有 = −1) */
interface Woe {
  odds: number;
  cause?: AnnalCause;
  region: number;
}
const NO_WOE: Woe = { odds: 1, region: -1 };

/** 按位数 */
function bits(x: number): number {
  let n = 0;
  for (; x; x &= x - 1) n++;
  return n;
}

const pairKey = (a: number, b: number) => Math.min(a, b) * 32768 + Math.max(a, b);

/** 国家 p 第 k 次看邻国的时刻 */
function checkTime(wm: WarModel, p: number, k: number): number {
  const P = wm.pm.polities[p];
  const { CHECK_FIRST, CHECK_EVERY } = wm.k;
  return P.founded + CHECK_FIRST + CHECK_EVERY * (k + 0.2 + 0.6 * keyed(wm.base, wm.pm.ptag[p], k, U_CHECK_T));
}

/** 一场战争里的随机数:按"攻方 + 守方(位置锚)+ 宣战时刻 + x + 用途"取 */
function warRand(wm: WarModel, w: War, x: number, use: number): number {
  const b = (wm.base ^ Math.imul(Math.round(w.start * 256), 0x27d4eb2d)) >>> 0;
  return keyed4(b, wm.pm.ptag[w.a], wm.pm.ptag[w.b], x, use);
}

/** 第 i 仗之前隔几年 */
function gapOf(wm: WarModel, w: War, i: number): number {
  const { GAP } = wm.k;
  return GAP[0] + (GAP[1] - GAP[0]) * warRand(wm, w, i, U_GAP);
}

/** 这场战争想拿下几州(战争目标;达成就议和,灭国之战除外) */
function goalOf(wm: WarModel, w: War): number {
  const { GOAL } = wm.k;
  return GOAL[0] + Math.floor((GOAL[1] - GOAL[0] + 1) * warRand(wm, w, 0, U_GOAL));
}

/** 这场战争最多打几年 */
function lengthOf(wm: WarModel, w: War): number {
  const { LENGTH } = wm.k;
  return LENGTH[0] + (LENGTH[1] - LENGTH[0]) * warRand(wm, w, 0, U_LENGTH);
}

function newModel(pm: PolityModel): WarModel {
  return {
    k: pm.knobs.get(WARS_KNOBS),
    pm,
    base: subSeed(pm.seed, 'civ-war'),
    wars: [],
    active: [],
    since: new Float64Array(pm.terrain.R).fill(-Infinity),
    prev: new Int16Array(pm.terrain.R).fill(-1),
    rest: new Map(),
    truce: new Map(),
    grudge: new Map(),
  };
}

/**
 * 议和时谁记恨谁:这场战争里净丢了州的一方(攻占、割让都算;一来一回的抵掉)记恨净得了的一方,n = 净得了几州。
 * 讨伐民变、宗室争位的内战(civil)不记恨;两边一样 = null
 */
function grudgeOf(w: War, civil: boolean): { lose: number; win: number; n: number } | null {
  if (civil) return null;
  let gA = 0;
  for (const e of w.takes) gA += e.by === w.a ? 1 : -1;
  if (gA === 0) return null;
  return gA > 0 ? { lose: w.b, win: w.a, n: gA } : { lose: w.a, win: w.b, n: -gA };
}

/** 战争 w 议和(t 那一刻)后,替输的一方多看一眼邻国的时刻:停战期满后再过 REVENGE_LOOK 里随机的几年 */
function revengeTime(wm: WarModel, w: War, t: Year): number {
  const { TRUCE, REVENGE_LOOK } = wm.k;
  return t + TRUCE + REVENGE_LOOK[0] + (REVENGE_LOOK[1] - REVENGE_LOOK[0]) * warRand(wm, w, 0, U_REVENGE);
}

/** 连续吞并:这场仗议和时赢家净得的州够多(大胜),它不歇、几年后再看一眼邻国 */
function chains(wm: WarModel, g: { n: number } | null): boolean {
  return !!g && g.n >= wm.k.CHAIN_MIN;
}

/** 战争 w 议和(t 那一刻)后,替大胜的一方多看一眼邻国的时刻:再过 CHAIN_LOOK 里随机的几年 */
function chainTime(wm: WarModel, w: War, t: Year): number {
  const { CHAIN_LOOK } = wm.k;
  return t + CHAIN_LOOK[0] + (CHAIN_LOOK[1] - CHAIN_LOOK[0]) * warRand(wm, w, 0, U_CHAIN);
}

/** 国家 p 此刻各州离它国都的路程(远征远近;和国家扩张共用 polities.ts 的那一份,迁都时换成新国都的) */
function reachOf(wm: WarModel, p: number): Float32Array {
  return wm.pm.capDist[p];
}

const models = new WeakMap<CivSim, WarModel>();

/** 推演引擎上挂着的战争模型(测试、统计用) */
export function warModelOf(sim: CivSim): WarModel | undefined {
  return models.get(sim);
}

// ---------------------------------------------------------------------------
// 挂到推演引擎上

/** 登记战争的事件处理和监听(installPolities 之后调用) */
export function installWars(sim: CivSim, pm: PolityModel, world: World, wm: WarModel = newModel(pm)): WarModel {
  const { PROJECT, KIN_ATTACK, HOME_DEF, CAPITAL_DEF, PROTECT_DEF, P_MAX, P_MIN, CAPITAL_GRACE, PROTECT_KEEP, HOLD, DEFENSE, REGAIN, RES_TARGET, MAX_CUT, MIN_STATE, CEDE_I, SURRENDER_SHARE, SURRENDER_POWER, ALLY_JOIN, TWO_FRONTS, REST, BROKE_CUT, PURSE_0, PLUNDER_FLOOR, TRUCE, NEWBORN, MAX_WARS, CRUSH, WAR_ODDS, LOCAL_EXP, BORDER_FULL, FOREIGN, REVANCHE, PREY, PREY_ODDS, GRUDGE_YEARS, GRUDGE, RES_WANT, RES_MAX, RICH, DIVERT, DIVERT_U, DIVERT_STEP, CHAOS_YEARS, PREY_UNREST, PREY_CALM, PREY_HIGH, WEAK_PREY, BLIGHT_MIN, BLIGHT_PREY, BLIGHT_FULL, LORD_PREY, LORD_PREY_MAX, STAND, STAND_DAYS, STAND_SLAIN, STAND_TAKEN, WINTER_T, WINTER_ALWAYS, WINTER_JITTER, BREAK_MAX, BREAK, COUNTER, STALL, BROKE_LENGTH, BROKE_PEACE, REVOLT_LENGTH, CRUSH_GOAL, CEDE } = wm.k;
  const { FOE_ODDS, FRIEND_JOIN } = pm.knobs.get(POLICY_KNOBS);
  const { ADULT } = pm.knobs.get(REGENTS_KNOBS);
  const api = civApi(sim);
  models.set(sim, wm);
  const T = pm.terrain;
  const reg = T.regions;
  // 州与州之间的关隘(据险断后在这些地方):只看地形,按州的邻接边
  const gate = regionPasses(world, reg);
  // 年内气温(估算;出兵避冬按它):同一个世界只算一次
  const yc = yearClimate(world);
  const R = T.R;
  const culture = sim.owners[Layer.Culture];
  const owner = sim.owners[Layer.Polity];

  // 州换了国家:记下年份;新立的国家(立国、分裂 / 复国出来的,拿到第一州时)预约第一次看邻国
  sim.onChange(Layer.Polity, (r, v, prev, cause) => {
    wm.since[r] = sim.now;
    wm.prev[r] = prev;
    if (v >= 0 && (cause === Ev.PolityFound || cause === Ev.Split) && pm.size[v] === 1) sim.schedule(checkTime(wm, v, 0), Ev.WarCheck, 0, v);
  });

  /**
   * 这几国此刻的国力(城镇人口之和,按州号顺序加,千人;至少 1;再乘军力系数)。只算要用的几国(别的国家留 0),
   * 只扫它们自己的国土(pm.lands):国家多了以后每次都把全世界的城算一遍太慢
   */
  const popAt = populationAt; // 热循环里用本地引用(tsx 下每次读导入的函数都要过一层 getter)
  const powers = (t: number, who: readonly number[]): Float64Array => {
    const pow = new Float64Array(pm.polities.length);
    for (const p of who) {
      if (pow[p] > 0) continue; // 重复的
      const tab = api.war.power ? api.war.power(p) : -1;
      if (tab >= 0) {
        pow[p] = tab;
        continue;
      }
      let sum = 0;
      // 管不到的州出兵打折、割据的州不出兵(control.ts;没挂 = 都出)
      const lv = api.war.levy?.(p, t);
      for (const r of pm.lands[p]) {
        const c = pm.cityOf[r];
        if (c >= 0) sum += lv ? popAt(pm.settlements[c], t) * lv(r) : popAt(pm.settlements[c], t);
      }
      // 军力系数(发展度按国都所在州的动员能力定,见 development.ts;没有 = 1)
      pow[p] = Math.max(1, sum) * (pm.military?.[p] ?? 1);
      // 顺着引的国力加减(policy.ts;没有 = 不乘)
      const k = powerScaleOf(pm, p, t);
      if (k !== 1) pow[p] *= k;
    }
    return pow;
  };

  const warsOf = (p: number) => wm.active.filter((w) => w.a === p || w.b === p);

  /** x 攻打 y 的州 r(r 挨着 x 的国土,def = 攻方最好打的那条边的过界难度):胜率 */
  const chance = (x: number, y: number, r: number, def: number, t: number, pow: Float64Array, w?: War): number => {
    const X = pm.polities[x];
    const Y = pm.polities[y];
    // 军力系数高(动员能力强、走得远)的国家远征打折少:强国越打越远,能滚雪球
    let sx = pow[x] * fexp(-reachOf(wm, x)[r] / (PROJECT * (pm.military?.[x] ?? 1)));
    let sy = pow[y] * fexp(-reachOf(wm, y)[r] / (PROJECT * (pm.military?.[y] ?? 1))) * def;
    // 士气(讨伐民变:见 接口 war.morale)
    if (w && api.war.morale) {
      sx *= api.war.morale(w, x, t);
      sy *= api.war.morale(w, y, t);
    }
    // 粮饷为掌权的人所制(引兵入朝那一刻正在打的仗;regency.ts)
    if (w && api.war.supply) {
      sx *= api.war.supply(w, x, t);
      sy *= api.war.supply(w, y, t);
    }
    // 作者的良将 / 名将挂帅(见 接口 war.led):本方兵力乘上去
    if (w && api.war.led) {
      const kx = api.war.led(w, x, t);
      if (kx !== 1) sx = round24(sx * kx);
      const ky = api.war.led(w, y, t);
      if (ky !== 1) sy = round24(sy * ky);
    }
    if (culture[r] === X.culture) sx *= KIN_ATTACK;
    if (culture[r] === Y.culture) sy *= HOME_DEF;
    if (pm.settlements[capitalAt(Y, t)].region === r) sy *= CAPITAL_DEF;
    if (wm.iv?.protects(y, t)) sy *= PROTECT_DEF; // 阶段 4 干预"不许灭":守得格外牢
    const a2 = sx * sx;
    const d2 = sy * sy;
    const p = a2 + d2 > 0 ? a2 / (a2 + d2) : 0.5;
    return Math.min(P_MAX, Math.max(P_MIN, p));
  };

  /**
   * x 在这场战争的第 i 仗里打 y 的哪一州:和 x 的国土接壤、HOLD 年内没易过手;
   * retake = 只打被 y 占去的州(守方反攻:这场战争里丢的,或者以前被 y 夺去的)。返回 [州, 过界难度];没有可打的 = [−1, 0]
   */
  const pickTarget = (w: War, i: number, x: number, y: number, t: number, retake: boolean): [number, number] => {
    const X = pm.polities[x];
    const dy = reachOf(wm, y);
    let lost: Set<number> | null = null;
    if (retake) lost = new Set(w.takes.filter((e) => e.by === y).map((e) => e.region));
    const cand: [number, number, number][] = [];
    // 刚迁都的国家,新国都 CAPITAL_GRACE 年内攻不下(残兵收拢、新都严防):不会几年里一迁再迁
    // 讨伐民变不等(见 接口 war.revolt)
    const free = !!api.war.revolt?.(w);
    const graceR = !free && t - pm.capMoved[y] < CAPITAL_GRACE ? pm.settlements[capitalAt(pm.polities[y], t)].region : -1;
    // 阶段 4 干预"不许灭":国都和紧挨着国都的州(京畿)攻不下(不会亡国、不会因丢了国都被并掉残部);只剩几州时一州都攻不下
    let guardR = -1;
    if (wm.iv?.protects(y, t)) {
      if (pm.size[y] <= PROTECT_KEEP) return [-1, 0];
      guardR = pm.settlements[capitalAt(pm.polities[y], t)].region;
    }
    const Y = pm.polities[y];
    const hold = free ? 0 : HOLD;
    // 物产:攻方先打有本国缺的物产的州(不论这场仗为什么打;守方反攻只管夺回失地)
    const want = !retake && x === w.a && api.war.wantOf && api.war.resOf ? api.war.wantOf(x).want : 0;
    for (const r of pm.lands[y]) {
      if (t - wm.since[r] < hold || r === graceR || r === guardR) continue;
      if (wm.iv?.locked(r, t)) continue; // 阶段 4 干预:永久划给它的州攻不下
      if (guardR >= 0 && nextTo(r, guardR, Y, t)) continue;
      if (lost && !lost.has(r) && wm.prev[r] !== x) continue;
      let att = 0;
      let tot = 0;
      let def = Infinity;
      for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
        const kind = reg.adjKind[k];
        if (kind !== AdjKind.SeaRoute) tot += reg.adjBorder[k];
        if (owner[reg.adj[k]] === x && canCross(pm, X, kind, t)) {
          att += reg.adjBorder[k];
          if (DEFENSE[kind] < def) def = DEFENSE[kind];
        }
      }
      if (def === Infinity) continue;
      const frac = tot > 0 ? att / tot : 0.5;
      const toward = dy[r] < Infinity ? fexp(-dy[r] / PROJECT) : 0;
      const score =
        3 * frac + 0.6 * toward - 0.8 * flog(def) + (wm.prev[r] === x ? REGAIN : 0) + (want && api.war.resOf!(r) & want ? RES_TARGET : 0) + 0.5 * warRand(wm, w, reg.seat[r] * 1024 + (i & 1023), U_TARGET);
      cand.push([r, def, score]);
    }
    // 分数从高往低,挑第一个"打下来不会把 y 的国土切出一大块飞地"的
    cand.sort((u, v) => v[2] - u[2] || reg.seat[u[0]] - reg.seat[v[0]]);
    const capR = pm.settlements[capitalAt(pm.polities[y], t)].region;
    let n0 = -1;
    for (const [r, def] of cand) {
      if (r !== capR) {
        if (n0 < 0) n0 = reachable(y, capR, -1, t);
        if (n0 - 1 - reachable(y, capR, r, t) > MAX_CUT) continue;
      }
      return [r, def];
    }
    return [-1, 0];
  };

  /** 州 r 和州 c 相邻(国家 P 能走的边) */
  const nextTo = (r: number, c: number, P: Polity, t: Year): boolean => {
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) if (reg.adj[k] === c && canCross(pm, P, reg.adjKind[k], t)) return true;
    return false;
  };

  /** 从州 from 出发、经 y 的国土(y 能走的边)能走到几州;skip = 当作已经丢了的州 */
  const seen = new Int32Array(R);
  let stamp = 0;
  const queue = new Int32Array(R);
  const reachable = (y: number, from: number, skip: number, t: Year): number => {
    const Y = pm.polities[y];
    if (owner[from] !== y || from === skip) return 0;
    stamp++;
    let qt = 0;
    queue[qt++] = from;
    seen[from] = stamp;
    for (let h = 0; h < qt; h++) {
      const r = queue[h];
      for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
        const j = reg.adj[k];
        if (seen[j] === stamp || j === skip || owner[j] !== y || !canCross(pm, Y, reg.adjKind[k], t)) continue;
        seen[j] = stamp;
        queue[qt++] = j;
      }
    }
    return qt;
  };

  /** 议和。extra = 罢兵割地:守方再割几州给攻方(见 CEDE;只有战役里议和时给) */
  const makePeace = (w: War, t: number, extra = 0) => {
    if (w.end !== undefined) return;
    let ceded = 0;
    // 罢兵割地:守方割边上几州(挑法和打仗时一样;不割国都,割完至少还剩 MIN_STATE + 1 州)
    let yielded = 0;
    if (extra > 0 && pm.polities[w.a].ended === undefined && pm.polities[w.b].ended === undefined) {
      const capR = pm.settlements[capitalAt(pm.polities[w.b], t)].region;
      for (let j = 0; j < extra && pm.size[w.b] > MIN_STATE + 1; j++) {
        const [r] = pickTarget(w, CEDE_I + j, w.a, w.b, t, false);
        if (r < 0 || r === capR) break;
        take(w, w.a, w.b, r, t);
        yielded++;
      }
      ceded += yielded;
    }
    // 议和时划清边界:两国各自和国都不连成一片的飞地,挨着对方的割给对方(一州易手后 HOLD 年内不动的照旧)
    if (pm.polities[w.a].ended === undefined && pm.polities[w.b].ended === undefined) {
      for (const [x, y] of [
        [w.a, w.b],
        [w.b, w.a],
      ]) {
        const X = pm.polities[x];
        const Y = pm.polities[y];
        for (let changed = true; changed; ) {
          changed = false;
          const { seen: core, stamp: cs } = coreOf(pm, owner, x, t);
          const give: number[] = [];
          for (let r = 0; r < R; r++) {
            if (owner[r] !== x || core[r] === cs || t - wm.since[r] < HOLD || wm.iv?.locked(r, t)) continue;
            for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
              if (owner[reg.adj[k]] === y && canCross(pm, Y, reg.adjKind[k], t)) {
                give.push(r);
                break;
              }
            }
          }
          for (const r of give) take(w, y, x, r, t);
          ceded += give.length;
          changed = give.length > 0 && X.ended === undefined;
        }
      }
    }
    w.end = t;
    wm.active.splice(wm.active.indexOf(w), 1);
    wm.rest.set(w.a, t);
    wm.rest.set(w.b, t);
    wm.truce.set(pairKey(w.a, w.b), t);
    // region 列记割让了几州(紧挨在这条议和前面的那么多条攻占是割让的,编年史写"划归""割某州求和"而不写"攻取");没割让 = −1。
    // n 列记其中最前面几条是罢兵割地
    sim.record('peace', { a: w.a, b: w.b, war: w.id, region: ceded > 0 ? ceded : -1, ...(yielded > 0 ? { n: yielded } : {}) });
    // 记恨赢了自己的那一国;停战期满后几年替输的一方多看一眼邻国(复仇之战)
    const g = grudgeOf(w, !!api.war.revolt?.(w));
    if (g) {
      wm.grudge.set(g.lose * 32768 + g.win, t);
      if (pm.polities[g.lose].ended === undefined) sim.schedule(revengeTime(wm, w, t), Ev.WarCheck, REVENGE_K + w.id, g.lose);
    }
    // 连续吞并:大胜的一方不歇,几年后再看一眼邻国
    if (chains(wm, g) && pm.polities[g!.win].ended === undefined) {
      wm.rest.delete(g!.win);
      sim.schedule(chainTime(wm, w, t), Ev.WarCheck, CHAIN_K + w.id, g!.win);
    }
  };

  /** y 亡国(最后一州 r 被 x 攻占;surrender = 破都纳降,史事 fall 记 cause = 'surrender'):记灭亡,它打着的仗全部结束 */
  const fall = (w: War, x: number, y: number, r: number, t: number, surrender = false) => {
    endPolity(pm, y, t);
    sim.record('fall', { a: y, b: x, region: r, war: w.id, ...(surrender ? { cause: 'surrender' as const } : {}) });
    for (const v of warsOf(y)) makePeace(v, t);
    api.war.onFall?.(w, x, y, t);
  };

  /**
   * x 攻占 y 的州 r。返回 true = 拿下的是 y 的国都。
   * assault = 战役里打下来的(阶段 3 城市兴衰:城可能被洗劫、被毁,见 接口 war.onAssault;议和时割让的不算)
   */
  const take = (w: War, x: number, y: number, r: number, t: number, assault = false): boolean => {
    const Y = pm.polities[y];
    const capital = pm.settlements[capitalAt(Y, t)].region === r;
    const city = pm.cityOf[r];
    sim.setOwner(Layer.Polity, r, x, Ev.Conquer);
    if (assault && city >= 0) api.war.onAssault?.(w, x, y, r, city, t, capital);
    sim.record('conquer', { a: x, b: y, region: r, settlement: city, war: w.id });
    w.takes.push({ year: t, region: r, by: x });
    if (!capital) return false;
    if (pm.size[y] <= 0) {
      fall(w, x, y, r, t);
      return true;
    }
    // 起事的饥民攻破都城:余下的州一并归它,亡国(unrest.ts)
    // 朝廷还守着永久割让的州时不能整个吞掉,照常迁都(下面 keep 那条)
    if (api.war.overthrow?.(w, x, y, t) && !wm.iv?.holdsLock(y, t)) return annex(w, x, y, r, t);
    // 迁来的一支打进大国国都(migration.ts):占着国都一带,那国迁都、大崩解
    if (api.war.storm?.(w, x, y, r, t)) return true;
    // 丢了国都只剩不到 MIN_STATE 州(而且都不是刚易手的):撑不下去,残部一并归攻方,亡国
    let left = 0;
    let settled = true;
    for (let q = 0; q < R; q++) {
      if (owner[q] !== y) continue;
      left++;
      if (t - wm.since[q] < HOLD && !api.war.revolt?.(w)) settled = false;
    }
    // 阶段 4 干预:手里有永久划给它的州的,不被并掉残部(迁都到剩下的城,那一块里没城就到别的块里挑)
    const keep = !!wm.iv?.holdsLock(y, t);
    if (left < MIN_STATE && settled && !keep) return annex(w, x, y, r, t);
    // 破都纳降:攻方国力是守方 SURRENDER_POWER 倍以上、守方余下的州不超过攻方的 SURRENDER_SHARE,余下的国土一并归降,亡国
    // (讨伐民变、宗室争位的内战不算;阶段 4 干预不许灭的国家不降)
    if (!keep && left <= SURRENDER_SHARE * pm.size[x] && !api.war.revolt?.(w) && !wm.iv?.protects(y, t)) {
      const pw = powers(t, [x, y]);
      if (pw[x] >= SURRENDER_POWER * pw[y]) return annex(w, x, y, r, t, true);
    }
    const sid = bestCapital(pm, owner, y, t, keep);
    if (sid >= 0) {
      moveCapital(pm, y, sid, t);
      sim.record('capital', { a: y, region: pm.settlements[sid].region, settlement: sid, war: w.id });
      return true;
    }
    // 剩下的州里一座城都还没建起来(极少见):同样亡国
    return annex(w, x, y, r, t);
  };

  /** y 丢了国都 r、撑不下去(surrender = 破都纳降):余下的州一并归 x,亡国 */
  const annex = (w: War, x: number, y: number, r: number, t: number, surrender = false): boolean => {
    const X = pm.polities[x];
    let last = r;
    // 由近及远:先并挨着 x 国土的州,一圈圈往外(隔海的残部最后一并归 x)
    for (let any = true; pm.size[y] > 0; ) {
      const touch = any;
      any = false;
      for (let q = 0; q < R; q++) {
        if (owner[q] !== y) continue;
        if (touch) {
          let adj = false;
          for (let k = reg.adjStart[q]; k < reg.adjStart[q + 1] && !adj; k++) adj = owner[reg.adj[k]] === x && canCross(pm, X, reg.adjKind[k], t);
          if (!adj) continue;
        }
        sim.setOwner(Layer.Polity, q, x, Ev.Conquer);
        sim.record('conquer', { a: x, b: y, region: q, settlement: pm.cityOf[q], war: w.id });
        w.takes.push({ year: t, region: q, by: x });
        last = q;
        any = true;
      }
    }
    fall(w, x, y, last, t, surrender);
    return true;
  };

  /** x、y 的国土接壤(x 能走过去的边) */
  const borders = (x: number, y: number): boolean => polityBorders(pm, owner, x, y, sim.now);

  const declare = (x: number, y: number, t: number, ally = -1, cause?: AnnalCause, res?: { region: number; want: number }): War => {
    const w: War = { id: wm.wars.length, a: x, b: y, start: t, takes: [] };
    // 邦交:作者下令盟国、宗藩之间开战,盟约、宗藩之分先断了(diplomacy.ts)
    api.diplomacy.sever?.(x, y, t, w.id);
    wm.wars.push(w);
    wm.active.push(w);
    // 为夺物产:region 列记由头里那一州,n 列记想要的物产(按位);乘内乱、为掠夺而战:region 列记割据的那州、要掠的富州
    sim.record('war', { a: x, b: y, war: w.id, ...(ally >= 0 ? { settlement: ally } : {}), ...(cause ? { cause } : {}), ...(res ? { region: res.region, ...(res.want ? { n: res.want } : {}) } : {}) });
    sim.schedule(t + gapOf(wm, w, 0), Ev.Campaign, 0, w.id);
    // 阶段 4 干预的结盟:y 被宣战,它的盟国(和 x 接壤、没和 x 结盟、和 x 没有宗藩之分、没在和 x 打)有 ALLY_JOIN 的机会援盟
    const iv = wm.iv;
    if (iv && ally < 0) {
      for (const z of iv.alliesOf(y, t)) {
        if (z === x || pm.polities[z].ended !== undefined || iv.allied(z, x, t) || wm.dm?.friendly(z, x) || iv.halted(z, t) || befriends(pm, z, x, t)) continue;
        if (wm.active.some((v) => (v.a === z && v.b === x) || (v.a === x && v.b === z)) || !borders(z, x)) continue;
        // 国家方针:z 把 y 当亲国的更肯出兵(policy.ts)
        if (keyed4(iv.base, pm.ptag[z], pm.ptag[x], Math.round(t * 256), U_ALLY) >= (befriends(pm, z, y, t) ? Math.max(ALLY_JOIN, FRIEND_JOIN) : ALLY_JOIN)) continue;
        declare(z, x, t, y, 'ally');
      }
    }
    // 邦交:y 的盟国援盟 / 坐视不救,y 的宗主来救(diplomacy.ts)
    if (ally < 0) api.war.onDeclare?.(w, x, y, t);
    return w;
  };
  api.war.declare = declare;
  api.war.makePeace = (w, t) => makePeace(w, t);

  /**
   * 第 k 次看邻国;k ≥ LOOK_K = 照大纲顺着引时多看的一眼(不接着预约下一次,见 interventions.ts 的 Ev.Look);
   * k ≥ REVENGE_K = 议和后替输的一方多看的一眼(复仇之战,同样不接着预约);k ≥ CHAIN_K = 大胜的一方多看的一眼(连续吞并,同上)
   */
  const warCheck = (k: number, p: number, t: number): void => {
    const P = pm.polities[p];
    if (!P || P.ended !== undefined) return;
    if (k < LOOK_K) sim.schedule(checkTime(wm, p, k + 1), Ev.WarCheck, k + 1, p);
    // 阶段 4 干预"不许扩张":不主动宣战
    if (wm.iv?.halted(p, t)) return;
    // 正在打仗的不再开新仗(帝国级的大国可以两线作战,一国同时打的仗不超过 MAX_WARS);刚议和的歇几年
    if (warsOf(p).length >= Math.min(MAX_WARS, pm.size[p] >= TWO_FRONTS ? 2 : 1) || t - (wm.rest.get(p) ?? -Infinity) < REST) return;
    // 接壤的邻国:边界长短(州与州相邻的对数)、边境上对方的州(和最好打的那条边);邻国手里有几州是从本国夺去的(收复失地)
    const border = new Map<number, number>();
    const front = new Map<number, Map<number, number>>();
    /** 邻国 q 手里有几州是从本国夺去的(收复失地;只扫 q 的国土) */
    const claims = (q: number) => {
      let n = 0;
      for (const r of pm.lands[q]) if (wm.prev[r] === p) n++;
      return n;
    };
    for (const r of pm.lands[p]) {
      for (let e = reg.adjStart[r]; e < reg.adjStart[r + 1]; e++) {
        const j = reg.adj[e];
        const q = owner[j];
        const kind = reg.adjKind[e];
        if (q < 0 || q === p || !canCross(pm, P, kind, t)) continue;
        border.set(q, (border.get(q) ?? 0) + 1);
        let f = front.get(q);
        if (!f) front.set(q, (f = new Map()));
        f.set(j, Math.min(f.get(j) ?? Infinity, DEFENSE[kind]));
      }
    }
    if (!border.size) return;
    const pow = powers(t, [p, ...border.keys()]);
    const dm = wm.dm;
    // 国家方针(policy.ts):亲国不打,仇国先打(没有方针 = null)
    const pol = pm.policies.size ? policyAt(pm, p, t) : null;
    // 物产:本国缺、又想要的(没挂发展度 = 都不缺)
    const lack = api.war.wantOf && api.war.resOf ? api.war.wantOf(p) : null;
    // 钱粮:国用不足、国库没攒满的打折(国库空竭的,对边境对面有富州的邻国按 PLUNDER_FLOOR 算:为掠夺而战)
    let money = 1;
    if (api.war.broke) money *= 1 - BROKE_CUT * api.war.broke(p, t);
    if (api.war.purse) money *= PURSE_0 + (1 - PURSE_0) * api.war.purse(p, t);
    const needy = money < PLUNDER_FLOOR && !!api.war.rich;
    let target = -1;
    let odds = 0;
    let traitor = false;
    let breaker = false;
    /** 挑中的那一国:边境上有本国缺的哪几样物产 */
    let covet = 0;
    /** 挑中的那一国:内忧(趁虚而入的由头、割据的那州)、要掠的富州(不是为掠夺 = −1) */
    let woe: Woe = NO_WOE;
    let loot = -1;
    for (const [q, n] of [...border].sort((u, v) => u[0] - v[0])) {
      const Q = pm.polities[q];
      if (Q.ended !== undefined || t - (wm.truce.get(pairKey(p, q)) ?? -Infinity) < TRUCE) continue;
      // 分裂 / 复国出来的国家有 NEWBORN 年的站稳期:不会一出生就被吞掉
      if (Q.parent !== undefined && t - Q.founded < NEWBORN) continue;
      const qw = warsOf(q);
      if (qw.length >= MAX_WARS || qw.some((v) => v.a === p || v.b === p)) continue;
      // 阶段 4 干预:不打盟国;不许灭的国家只剩几州时没什么可打的
      if (wm.iv && (wm.iv.allied(p, q, t) || (pm.size[q] <= PROTECT_KEEP && wm.iv.protects(q, t)))) continue;
      if (pol && picks(pm, pol.friends, q)) continue;
      // 照大纲顺着引时多看的一眼:只看方针里的仇国(引的就是"打它")
      if (k >= LOOK_K && k < REVENGE_K && pol?.foes?.length && !picks(pm, pol.foes, q)) continue;
      // 连续吞并多看的那一眼:只挑弱得多的邻国(国力不到本国的 1 / CRUSH,打起来就是灭国之战)
      if (k >= CHAIN_K && pow[p] < CRUSH * pow[q]) continue;
      // 邦交:不打宗主、藩属、同一个宗主的藩属;盟国只在结盟够久、共御的强邻已不足为患时才可能背盟去打
      let betray = false;
      if (dm) {
        const x = dm.pactOf(p, q);
        if (x) {
          if (!dm.betrayable(x, p, t, (f) => (f === p ? pow[p] : powers(t, [f])[f]))) continue;
          betray = true;
        } else if (dm.vassalTie(p, q)) continue;
      }
      // 立约(treaties.ts):约期内不打立约国;立约满几年、有由头的才可能背约去打
      const oath = api.war.treaty ? api.war.treaty(p, q, t, pow) : -1;
      if (oath === 0) continue;
      // 边境上的胜算(和打仗时一样按局部国力算,远征打折):强国的边远处打得过,就会有弱国来收复失地
      let sum = 0;
      for (const [y, def] of front.get(q)!) sum += chance(p, q, y, def, t, pow);
      const pbar = sum / front.get(q)!.size;
      let o = WAR_ODDS * P.expansionism * fpow(pbar / (1 - pbar), LOCAL_EXP) * Math.sqrt(Math.min(1, n / BORDER_FULL));
      if (Q.culture !== P.culture) o *= FOREIGN;
      o *= 1 + REVANCHE * Math.min(4, claims(q));
      // 小国(一场仗就能吞下)格外招人
      if (pm.size[q] <= PREY) o *= PREY_ODDS;
      if (betray) o *= dm!.betrayOdds * (api.war.kinBetray?.(p, q, t) ?? 1);
      if (oath > 0) o *= oath;
      // 联姻(marriage.ts):两国结着亲少开战,在位的君主不打舅家
      if (api.war.kin) o *= api.war.kin(p, q, t);
      // 邻国内忧(大乱、割据、疫后凋敝、幼主权臣):趁虚而入
      const wq = weakness(q, t);
      o *= wq.odds;
      // 记恨:近年在战场上输给它、丢了州
      if (t - (wm.grudge.get(p * 32768 + q) ?? -Infinity) < GRUDGE_YEARS) o *= GRUDGE;
      if (pol && picks(pm, pol.foes, q)) o *= FOE_ODDS;
      // 边境对面有本国缺的物产:盯上它(门槛要的那样算两样)
      let got = 0;
      if (lack && lack.want) {
        for (const y of front.get(q)!.keys()) got |= api.war.resOf!(y);
        got &= lack.want;
        if (got) o *= 1 + RES_WANT * Math.min(RES_MAX, bits(got) + (got & lack.gate ? 1 : 0));
      }
      // 国用不足:没钱打仗;国库空竭的,边境对面有富州就去抢(一样富的取治所地块小的)
      let rich = -1;
      if (needy) {
        let most = RICH;
        for (const y of front.get(q)!.keys()) {
          const v = api.war.rich!(p, y);
          if (v > most || (v === most && rich >= 0 && reg.seat[y] < reg.seat[rich])) {
            most = v;
            rich = y;
          }
        }
      }
      o *= rich >= 0 ? PLUNDER_FLOOR : money;
      if (o > odds) {
        odds = o;
        target = q;
        traitor = betray;
        breaker = oath > 0;
        covet = got;
        woe = wq;
        loot = rich;
      }
    }
    if (target < 0) return;
    // 越好战的君主越容易开战(加上方针的打仗胆量);国内越乱越想对外开战转移矛盾(乱到 DIVERT_U 再上调一档)
    odds *= effOf(pm, p, t).declare;
    const up = api.war.unrest ? api.war.unrest(p, t) : 0;
    odds *= 1 + DIVERT * up + (up >= DIVERT_U ? DIVERT_STEP : 0);
    const oddsIn = sim.influence?.get('war.odds');
    if (oddsIn) odds *= mulOf(oddsIn, p);
    if (keyed(wm.base, pm.ptag[p], k, U_DECLARE) >= odds / (1 + odds)) return;
    if (traitor) {
      // 背盟:先记盟约断了(war 列 = 紧跟着的这场战争),再宣战
      api.diplomacy.note!('unally', { a: p, b: target, war: wm.wars.length, cause: 'betray' });
      declare(p, target, t, -1, 'betray');
      return;
    }
    // 背约(treaties.ts;背约那一条在宣战时记,见 接口 diplomacy.sever)
    if (breaker) {
      declare(p, target, t, -1, 'breach');
      return;
    }
    const cause = causeOf(p, target, t, claims(target), covet, woe, loot, up);
    // 乘内乱(有割据的写割据的那州)、为掠夺而战(写要掠的富州):region 列记那一州
    if (cause === 'unrest' || cause === 'plunder') {
      declare(p, target, t, -1, cause, { region: cause === 'plunder' ? loot : woe.region, want: 0 });
      return;
    }
    if (cause !== 'resource') {
      declare(p, target, t, -1, cause);
      return;
    }
    // 为夺物产:由头里写边境上物产最全的那一州(一样多的取治所地块小的);这场战争想要的就是那一州有的几样
    let best = -1;
    let most = 0;
    for (const y of front.get(target)!.keys()) {
      const n = bits(api.war.resOf!(y) & covet);
      if (n > most || (n === most && n > 0 && reg.seat[y] < reg.seat[best])) {
        most = n;
        best = y;
      }
    }
    declare(p, target, t, -1, cause, { region: best, want: api.war.resOf!(best) & covet });
  };
  sim.on(Ev.WarCheck, warCheck);
  api.war.look = (p, k, t) => warCheck(k, p, t);

  /**
   * p 向 q 开战的由头:收复故土 > 乘乱(q 正和别国交兵、刚丢了国都 / 迁都、刚改朝换代)> 乘 q 的内忧(内乱 / 大疫之后 / 幼主 / 权臣,见 weakness)
   * > 为掠夺而战(loot = 要掠的富州)> 夺物产 > 转移矛盾(p 的动荡 up 到 DIVERT_U)> 吞并小国 > 争边地
   */
  const causeOf = (p: number, q: number, t: number, claimed: number, covet: number, woe: Woe, loot: number, up: number): AnnalCause => {
    if (claimed > 0) return 'claim';
    const Q = pm.polities[q];
    const d = Q.dynasties;
    // 改制开的一段(共和、军政府、迎回旧王室)不算改朝换代之乱
    const dl = d && d.length > 1 ? d[d.length - 1] : undefined;
    if (warsOf(q).some((v) => v.a !== p && v.b !== p) || t - pm.capMoved[q] < CHAOS_YEARS || (dl && !dl.regime && dl.house === undefined && t - dl.year < CHAOS_YEARS)) return 'chaos';
    if (woe.cause) return woe.cause;
    if (loot >= 0) return 'plunder';
    if (covet) return 'resource';
    if (up >= DIVERT_U) return 'divert';
    if (pm.size[q] <= PREY) return 'prey';
    return 'expand';
  };

  /**
   * 邻国 q 此刻的内忧(看邻国时趁虚而入):赔率倍数;够得上写由头的那一样,按先后:有割据(unrest,记最早起的那处在哪州)>
   * 疫后凋敝(plagued)> 幼主在位(minor)/ 权臣当政(regent)> 动荡到 PREY_HIGH(unrest,不记州)
   */
  const weakness = (q: number, t: number): Woe => {
    const u = api.war.unrest ? api.war.unrest(q, t) : 0;
    let odds = 1 + PREY_UNREST * Math.max(0, u - PREY_CALM);
    let cause: AnnalCause | undefined = u >= PREY_HIGH ? 'unrest' : undefined;
    let region = -1;
    const k = weakRule(q, t);
    if (k) {
      odds *= 1 + WEAK_PREY;
      cause = k;
    }
    const b = api.war.blight ? api.war.blight(q, t) : 0;
    if (b >= BLIGHT_MIN) {
      odds *= 1 + BLIGHT_PREY * Math.min(1, b / BLIGHT_FULL);
      cause = 'plagued';
    }
    const L = api.war.lords ? api.war.lords(q, t) : null;
    if (L && L.n) {
      odds *= 1 + LORD_PREY * Math.min(LORD_PREY_MAX, L.n);
      cause = 'unrest';
      region = L.region;
    }
    return cause || odds !== 1 ? { odds, cause, region } : NO_WOE;
  };

  /** 国家 q 此刻是幼主在位(minor:不满 ADULT 岁,或宗室摄政、名臣辅政)还是权臣当政(regent:大臣、大将专权);都不是 = undefined。共和国不算 */
  const weakRule = (q: number, t: number): 'minor' | 'regent' | undefined => {
    const Q = pm.polities[q];
    if (!royalAt(Q, t)) return undefined;
    const r = rulerOf(pm, q, t);
    const g = regentOf(pm, q, t, r);
    if (g) return g.kind === 'chancellor' || g.kind === 'general' ? 'regent' : g.kind === 'uncle' || g.kind === 'minister' ? 'minor' : undefined;
    return t - reignBorn(r) < ADULT ? 'minor' : undefined;
  };

  /**
   * 州 r 和 x 的国土之间只有关隘可走(x 能走的边里没有不带关隘的平地、渡河,至少有一条带关隘的边):
   * 返回那条带关隘的边(Regions.adj 的下标;几条里取共享边界最长的,一样长取对面治所地块小的);不是 = −1。
   * 追兵 y 要打的州 q 只能从关隘进去 = gateOf(q, y);败兵 x 从州 r 退回本国只能走关隘 = gateOf(r, x)
   */
  const gateOf = (r: number, x: number, t: number): number => {
    const X = pm.polities[x];
    let best = -1;
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      const j = reg.adj[k];
      const kind = reg.adjKind[k];
      if (owner[j] !== x || !canCross(pm, X, kind, t)) continue;
      if (gate[k] < 0) {
        if (kind === AdjKind.Flat || kind === AdjKind.River) return -1;
        continue;
      }
      if (best < 0 || reg.adjBorder[k] > reg.adjBorder[best] || (reg.adjBorder[k] === reg.adjBorder[best] && reg.seat[j] < reg.seat[reg.adj[best]])) best = k;
    }
    return best;
  };

  /**
   * 据险断后:x 的兵从州 from 败退(−1 = 不是败退下来的),追兵 y 本来能再打下 x 的州 q。
   * 追兵只能从关隘打进 q(守在 q),或者败兵从 from 只能经关隘退回(守在关隘后面那州):
   * x 有 STAND 的机会守住关隘,追兵到此为止(记一条 stand)。返回 true = 守住了。u = 这一仗里的第几下(取随机数用)
   */
  const holdPass = (w: War, x: number, y: number, q: number, from: number, u: number, t: number): boolean => {
    if (from < 0 || api.war.revolt?.(w)) return false;
    let k = gateOf(q, y, t);
    let hold = q;
    if (k < 0) {
      k = gateOf(from, x, t);
      if (k < 0) return false;
      hold = reg.adj[k];
    }
    if (warRand(wm, w, u, U_STAND) >= STAND) return false;
    const days = STAND_DAYS[Math.floor(STAND_DAYS.length * warRand(wm, w, u, U_STAND_DAYS))];
    const v = warRand(wm, w, u, U_STAND_END);
    const cause: AnnalCause = v < STAND_SLAIN ? 'slain' : v < STAND_SLAIN + STAND_TAKEN ? 'captured' : 'withdrew';
    sim.record('stand', { a: x, b: y, region: reg.of[gate[k]], foe: hold, war: w.id, n: days, cause });
    return true;
  };

  /**
   * 出兵避冬:战争 w 的第 i 仗此刻要打州 r,r 正在冬天里 = 顺延到的时刻(那州开春后再隔几天,已取整);不用顺延 = t
   */
  const thawOf = (w: War, i: number, r: number, t: Year): Year => {
    const c = reg.seat[r];
    const share = coldShare(yc, c, WINTER_T);
    if (share <= 0 || share >= WINTER_ALWAYS) return t;
    const end = coldSpellEnd(yc, c, t, WINTER_T, share);
    return end > t ? quantize(end + WINTER_JITTER * warRand(wm, w, i, U_THAW)) : t;
  };

  sim.on(Ev.Campaign, (i, id, t) => {
    const w = wm.wars[id];
    if (!w || w.end !== undefined) return;
    // 出兵避冬:要打的那州正在冬天里,顿兵到那州开春再打(同一仗重新预约;记一条 winter,until = 开春再打的时刻,接着推时按它重建)
    const [r0] = pickTarget(w, i, w.a, w.b, t, false);
    if (r0 >= 0) {
      const until = thawOf(w, i, r0, t);
      if (until > t) {
        sim.record('winter', { a: w.a, b: w.b, region: r0, war: w.id, until });
        sim.schedule(until, Ev.Campaign, i, id);
        return;
      }
    }
    if (i === 0) api.war.onMuster?.(w, t);
    const pow = powers(t, [w.a, w.b]);
    let capitalFell = false;
    /** 丢了国都的是守方(攻方打下的) */
    let defCapital = false;
    const [r, def] = pickTarget(w, i, w.a, w.b, t, false);
    if (r >= 0 && warRand(wm, w, i, U_ATTACK) < chance(w.a, w.b, r, def, t, pow, w)) {
      capitalFell = defCapital = take(w, w.a, w.b, r, t, true);
      // 乘胜连下几州(打下国都、一方亡国就停)。追兵只能从关隘打进下一州、或者守方败兵从刚丢的那州只能经关隘退回:
      // 守方可能据险断后,追到这里为止
      let lost = r;
      for (let j = 1; j <= BREAK_MAX && !capitalFell && w.end === undefined; j++) {
        const [q, qdef] = pickTarget(w, i * 8 + j, w.a, w.b, t, false);
        if (q < 0 || warRand(wm, w, i * 8 + j, U_BREAK) >= BREAK * chance(w.a, w.b, q, qdef, t, pow, w)) break;
        if (holdPass(w, w.b, w.a, q, lost, i * 8 + j, t)) break;
        capitalFell = defCapital = take(w, w.a, w.b, q, t, true);
        lost = q;
      }
    } else {
      // 没打下来:记一条战役(不改归属;编年史写成"某某之战")
      if (r >= 0) sim.record('battle', { a: w.a, b: w.b, region: r, settlement: pm.cityOf[r], war: w.id, via: DEFENSE.indexOf(def) });
      if (warRand(wm, w, i, U_COUNTER) < COUNTER) {
        // 守方反攻:夺回被攻方占去的州。守方只能从关隘打进那州、或者攻方是经关隘打过来的(败兵只能经关隘退回):
        // 败退的攻方可能据险断后,夺不回
        const [q, qdef] = pickTarget(w, i, w.b, w.a, t, !api.war.revolt?.(w));
        if (q >= 0) {
          if (warRand(wm, w, i, U_RETAKE) < chance(w.b, w.a, q, qdef, t, pow, w)) {
            if (!holdPass(w, w.a, w.b, q, r, i * 8, t)) capitalFell = take(w, w.b, w.a, q, t, true);
          } else sim.record('battle', { a: w.b, b: w.a, region: q, settlement: pm.cityOf[q], war: w.id, via: DEFENSE.indexOf(qdef) });
        }
      }
    }
    if (w.end !== undefined) return; // 有一方亡国,已经议和
    // 君主下了"坚持打"(press):这一仗不许引擎自己议和 —— 受降罢兵、厌战、僵持、国用不足、达成目标都不算数
    // (讨伐民变不算:那是内乱,不吃对外命令)
    const pressed =
      !api.war.revolt?.(w) && ((wm.iv?.pressing(w.a, t, w.b) ?? false) || (wm.iv?.pressing(w.b, t, w.a) ?? false));
    // 邦交:守方打得很惨时可能奉表称臣、攻方受降罢兵(diplomacy.ts;成了就已经议和)
    if (!pressed && api.war.sue?.(w, i, t, pow, defCapital)) return;
    // 议和?
    const last = w.takes.length ? w.takes[w.takes.length - 1].year : w.start;
    // 攻方此刻在位的君主:越好战越不轻易罢兵、想多拿几州,好战低的打不了多久就想议和(rulers.ts;加上方针的胆量、和谈底线)
    const eff = effOf(pm, w.a, t);
    const length = lengthOf(wm, w) * eff.war;
    // 攻方国用不足到 BROKE_PEACE 以上、仗打过了年限的 BROKE_LENGTH:罢兵
    let peace = t - w.start >= length || t - last >= STALL || (t - w.start >= BROKE_LENGTH * length && (api.war.broke?.(w.a, t) ?? 0) >= BROKE_PEACE);
    /** 厌战、僵持、国用不足罢兵(攻方没达成目标):议和后两国可能顺带立约(treaties.ts) */
    let weary = peace;
    // 讨伐民变:不到厌战(REVOLT_LENGTH 倍的年限)不罢兵,直到一方亡(讨平,或攻破都城)
    if (api.war.revolt?.(w)) {
      peace = t - w.start >= REVOLT_LENGTH * length;
      weary = false;
    } else if (!peace) {
      let held = 0;
      for (const e of w.takes) if (e.by === w.a && owner[e.region] === w.a) held++;
      // 灭国之战:拿下国都、对方丢了过半国土都不停(不设目标,见 CRUSH_GOAL;君主的倾向只管打多久,算在上面的年限里)
      if (pow[w.a] >= CRUSH * pow[w.b]) peace = held >= CRUSH_GOAL * goalOf(wm, w);
      else peace = capitalFell || held >= pm.size[w.b] || held >= Math.max(1, goalOf(wm, w) + eff.goal);
    }
    // 君主下了"坚持打":引擎的议和理由全部不算数;强制结束(结盟、不许扩张、灭国、一方亡国)照旧走别处
    if (pressed) {
      peace = false;
      weary = false;
    }
    if (peace) {
      // 罢兵割地:攻方这场仗净得了州(讨伐民变的不算),守方再割 CEDE 州
      const g = grudgeOf(w, !!api.war.revolt?.(w));
      makePeace(w, t, g && g.win === w.a ? CEDE : 0);
      api.war.onPeace?.(w, t);
      if (weary) api.war.onTruce?.(w, t);
    } else sim.schedule(t + gapOf(wm, w, i + 1), Ev.Campaign, i + 1, id);
  });

  return wm;
}

/**
 * 由 Civ 重建战争的推演状态(resumeCiv 调用,在 resumePolities 之后):
 * 战争、每场战争攻占的州、议和(冷却)都从史事里读;一州多久没易手从变化日志里读;
 * 再按"国家 + 第几次""战争 + 第几仗"算出还没到的看邻国、下一仗,补进引擎。
 */
export function resumeWars(sim: CivSim, world: World, civ: Civ): void {
  const pm = polityModelOf(sim);
  if (!pm) return;
  const wm = newModel(pm);
  const log = civ.log;
  {
    const cur = new Int16Array(civ.regions.count).fill(-1);
    for (let i = 0; i < log.size; i++) {
      if (log.layer[i] !== Layer.Polity) continue;
      const r = log.region[i];
      wm.since[r] = log.year[i];
      wm.prev[r] = cur[r];
      cur[r] = log.value[i];
    }
  }
  /** 讨伐民变、宗室争位的内战、迁来的一支到了以后开的仗(和 unrest.ts、migration.ts 的 接口 war.revolt 一样按宣战的由头认):不记恨 */
  const civil = new Set<number>();
  /** 议和后替输的一方(复仇)、大胜的一方(连续吞并)多看一眼邻国:[战争, 哪一国, 议和的年份, 是连续吞并],按议和时预约的先后 */
  const looks: [War, number, Year, boolean][] = [];
  for (const e of civ.annals) {
    if (e.kind === 'war') {
      wm.wars[e.war] = { id: e.war, a: e.a, b: e.b, start: e.year, takes: [] };
      if (e.cause === 'quell' || e.cause === 'heir' || e.cause === 'trek') civil.add(e.war);
    } else if (e.kind === 'conquer' && e.war >= 0) wm.wars[e.war]?.takes.push({ year: e.year, region: e.region, by: e.a });
    else if (e.kind === 'peace') {
      const w = wm.wars[e.war];
      if (w) w.end = e.year;
      wm.rest.set(e.a, e.year);
      wm.rest.set(e.b, e.year);
      wm.truce.set(pairKey(e.a, e.b), e.year);
      const g = w ? grudgeOf(w, civil.has(w.id)) : null;
      if (g) {
        wm.grudge.set(g.lose * 32768 + g.win, e.year);
        looks.push([w!, g.lose, e.year, false]);
      }
      // 连续吞并:大胜的一方(议和那一刻还在)不歇
      const W = g ? pm.polities[g.win] : undefined;
      if (chains(wm, g) && W && (W.ended === undefined || W.ended > e.year)) {
        wm.rest.delete(g!.win);
        looks.push([w!, g!.win, e.year, true]);
      }
    }
  }
  for (const w of wm.wars) if (w && w.end === undefined) wm.active.push(w);
  installWars(sim, pm, world, wm);

  const now = sim.now;
  // 议和那一刻预约的、还没到的复仇之眼、连续吞并的那一眼(那一国此刻已亡的不用补:到时候也是什么都不做)
  for (const [w, p, t, chain] of looks) {
    const at = chain ? chainTime(wm, w, t) : revengeTime(wm, w, t);
    if (quantize(at) > now && pm.polities[p].ended === undefined) sim.schedule(at, Ev.WarCheck, (chain ? CHAIN_K : REVENGE_K) + w.id, p, t);
  }
  // 在世的国家:下一次看邻国(上一次看的那一刻预约的;第一次是立国那一刻)
  for (const p of pm.polities) {
    if (p.ended !== undefined) continue;
    let k = 0;
    while (quantize(checkTime(wm, p.id, k)) <= now) k++;
    sim.schedule(checkTime(wm, p.id, k), Ev.WarCheck, k, p.id, bookChain(k, (j) => checkTime(wm, p.id, j), p.founded), k > 0 ? 0 : p.id);
  }
  // 还在打的仗:下一仗(和推演时一样逐仗累加、逐仗取整;上一仗那一刻预约的,第一仗是宣战那一刻)。
  // 顿兵过冬(史事 winter)的那一刻:同一仗挪到开春(until),是那一刻预约的
  const winters = new Map<number, Annal[]>();
  for (const e of civ.annals) {
    if (e.kind !== 'winter' || e.until === undefined) continue;
    let l = winters.get(e.war);
    if (!l) winters.set(e.war, (l = []));
    l.push(e);
  }
  for (const w of wm.active) {
    const ws = winters.get(w.id);
    let h = 0;
    let i = 0;
    const times = [w.start];
    let t = quantize(w.start + gapOf(wm, w, 0));
    while (t <= now) {
      times.push(t);
      while (ws && h < ws.length && ws[h].year < t) h++;
      if (ws && h < ws.length && ws[h].year === t) {
        t = ws[h++].until!;
        continue;
      }
      i++;
      t = quantize(t + gapOf(wm, w, i));
    }
    sim.schedule(t, Ev.Campaign, i, w.id, times.slice(-3).reverse());
  }
}

/**
 * 国家 y 丢了国都以后挑新国都(战争里国都失守、阶段 4 干预把国都所在州划走 / 在那里立国):
 * 剩下的国土被切成几块时,先挑城镇人口最多的那一块(不把国都迁进一小块飞地),再挑块里人口最多的城。
 * 那一块里一座城都没有 = −1;anyPiece = 那时到别的块里挑人口最多的城。skip = 当作已经不归 y 的州(立国干预:国都所在州要分出去)
 */
export function bestCapital(pm: PolityModel, owner: Int16Array, y: number, t: Year, anyPiece = false, skip = -1): number {
  const reg = pm.terrain.regions;
  const R = pm.terrain.R;
  const Y = pm.polities[y];
  const piece = new Int32Array(R).fill(-1);
  const piecePop: number[] = [];
  for (let q = 0; q < R; q++) {
    if (owner[q] !== y || piece[q] >= 0 || q === skip) continue;
    const id = piecePop.length;
    let sum = 0;
    const stack = [q];
    piece[q] = id;
    while (stack.length) {
      const u = stack.pop()!;
      if (pm.cityOf[u] >= 0) sum += populationAt(pm.settlements[pm.cityOf[u]], t);
      for (let k = reg.adjStart[u]; k < reg.adjStart[u + 1]; k++) {
        const j = reg.adj[k];
        if (piece[j] < 0 && owner[j] === y && j !== skip && canCross(pm, Y, reg.adjKind[k], t)) {
          piece[j] = id;
          stack.push(j);
        }
      }
    }
    piecePop.push(sum);
  }
  let main = 0;
  for (let i = 1; i < piecePop.length; i++) if (piecePop[i] > piecePop[main]) main = i;
  let sid = -1;
  let best = -1;
  for (let pass = 0; pass < (anyPiece ? 2 : 1) && sid < 0; pass++) {
    for (let q = 0; q < R; q++) {
      if (owner[q] !== y || q === skip || pm.cityOf[q] < 0 || (pass === 0 && piece[q] !== main)) continue;
      const pop = populationAt(pm.settlements[pm.cityOf[q]], t);
      if (pop > best) {
        best = pop;
        sid = pm.cityOf[q];
      }
    }
  }
  return sid;
}

/** 国家 x、y 在 t 这一刻国土接壤(陆上相邻;x 能出海时隔着海峡、航线也算,和看邻国时一样按 x 能走的边) */
export function polityBorders(pm: PolityModel, owner: Int16Array, x: number, y: number, t: Year): boolean {
  const reg = pm.terrain.regions;
  const X = pm.polities[x];
  for (const r of pm.lands[x]) {
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) if (owner[reg.adj[k]] === y && canCross(pm, X, reg.adjKind[k], t)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 统计(scripts/gen-stats.ts、stress.ts、单测用)

export interface WarStats {
  /** 战争场数、攻占次数、灭亡国家数、迁都次数 */
  wars: number;
  conquests: number;
  falls: number;
  capitalMoves: number;
  /** 结束时在世的国家数 */
  alive: number;
  /** 结束时有人住的州里没有国家(部落地带)的比例 */
  tribalShare: number;
  /** 50 年内换了 3 次以上国家的州(第一次归国家也算一次) */
  flippy: number;
  /** 结束时的飞地州(和本国国都经本国国土陆上不连通;海洋国家可以走海路)个数、占全部有国家的州的比例 */
  exclaves: number;
  exclaveShare: number;
}

/** 某一年的飞地:每州 1 = 飞地(和本国国都经本国国土不连通;能出海的国家(polities.ts 的 sailsOcean)沿航线连着的海外领土不算飞地) */
export function exclaveMask(civ: Civ, owner: Int16Array = civ.polity, year: Year = civ.endYear): Uint8Array {
  const reg = civ.regions;
  const R = reg.count;
  const reached = new Uint8Array(R);
  const q: number[] = [];
  for (const p of civ.polities) {
    if (!(year >= p.founded) || (p.ended !== undefined && year >= p.ended)) continue;
    const c = civ.settlements[capitalAt(p, year)].region;
    if (owner[c] !== p.id) continue;
    q.length = 0;
    q.push(c);
    reached[c] = 1;
    for (let h = 0; h < q.length; h++) {
      const r = q[h];
      for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
        const j = reg.adj[k];
        if (reached[j] || owner[j] !== p.id || !canCross(civ, p, reg.adjKind[k], year)) continue;
        reached[j] = 1;
        q.push(j);
      }
    }
  }
  const out = new Uint8Array(R);
  for (let r = 0; r < R; r++) if (owner[r] >= 0 && !reached[r]) out[r] = 1;
  return out;
}

export function warStats(civ: Civ): WarStats {
  const A = civ.annals;
  const count = (k: string) => A.filter((e) => e.kind === k).length;
  const R = civ.regions.count;
  let occ = 0;
  let tribal = 0;
  let owned = 0;
  for (let r = 0; r < R; r++) {
    if (civ.culture[r] < 0) continue;
    occ++;
    if (civ.polity[r] < 0) tribal++;
    else owned++;
  }
  // 各州国家层的变化年份
  const times: number[][] = Array.from({ length: R }, () => []);
  for (let i = 0; i < civ.log.size; i++) if (civ.log.layer[i] === Layer.Polity) times[civ.log.region[i]].push(civ.log.year[i]);
  let flippy = 0;
  for (const ts of times) {
    for (let i = 2; i < ts.length; i++) {
      if (ts[i] - ts[i - 2] < 50) {
        flippy++;
        break;
      }
    }
  }
  const ex = exclaveMask(civ);
  let exclaves = 0;
  for (let r = 0; r < R; r++) exclaves += ex[r];
  return {
    wars: count('war'),
    conquests: count('conquer'),
    falls: count('fall'),
    capitalMoves: count('capital'),
    alive: civ.polities.filter((p) => p.ended === undefined).length,
    tribalShare: occ ? tribal / occ : 0,
    flippy,
    exclaves,
    exclaveShare: owned ? exclaves / owned : 0,
  };
}

/** 模块:战争与攻占:宣战、攻占、迁都、灭亡、议和(清单和次序见 modules.ts) */
export const warsModule: CivModule = {
  id: 'wars',
  install: (c) => {
    if (c.pm) installWars(c.sim, c.pm, c.world);
  },
  resume: (c) => resumeWars(c.sim, c.world, c.civ),
};
