/**
 * 编年史(阶段 3):把 civ.annals(史事)写成一条条中文纪事,给界面上的"编年史"面板和"复制全文"用。
 * 纯函数,主线程用;只引 growth.ts / display.ts / types.ts,不引起名器和推演代码。
 *
 * - 一律按史事的字段读(各种类的字段含义见 types.ts 的 AnnalKind),不去翻变化日志推断。
 * - 国名用事发当年的国号(growth.ts 的 polityName),州名用 display.ts 的 regionLabel,城名用 settlements[i].name。
 * - **折叠**:同一个战争编号的宣战、攻占、被迫迁都(国都失守,capital 带战争编号)、灭亡、议和折叠成一条"战争"
 *   (起止年份、交战双方、结果),子条目是每一件事;标题写结果:"得瑞州等五州"、"昌国国都汾城陷落"(一场战争里
 *   迁了两次以上写"昌国连迁三都")、"昌国亡"。攻方先得后失写"得瑞州等三州而失雪西"(只有攻方的得失不带主语,
 *   国都失守不写"失国都",免得两个"失"说的不是同一方)。
 *   不是打下来的攻占各合成一条子条目,不写"攻取":议和时划清边界割让的(史事 peace 的 region = 紧挨在它前面的几条)
 *   写"议定疆界,乌绝原等三州划归大渭,雪西划归昌国"(标签"割");丢了国都撑不下去、残部一并归攻方的
 *   (亡国前同一刻连着的几条攻占)写"余下瑞州等三州尽归大渭"。
 *   不在战争里、收服部落地带的攻占,同一国前后相隔不到 TRIBAL_GAP 年的也折叠成一条(一条最长 TRIBAL_SPAN 年)。
 *   灭亡除了在战争的子条目里,也单独列一条(按国家筛选时要看得到;"大事"里由战争那一条说,不重复)。
 * - **分合**(阶段 3):分裂写"瑞州叛大渭自立,号瑞国,都于瑞城";复国(新国家有 Polity.restores)写
 *   "故昌遗民据瑞州起兵,脱大渭复国,号后昌国,都于瑞城"(标签"复");合并写"梅利斯国并入梅西亚王国"。
 *   攻占以前占有过的州(被夺走、议和割让、分裂出去之后又打回来)写"夺回"。
 * - **王朝更替**(阶段 3):东方写"大昌享国 312 年而亡,景氏起于青州代之,国号大景,定都青阳"(权臣篡位:"权臣景氏篡位,国号大景";
 *   入主旧都:"景氏起于青州,入主昌京,国号大景");西幻写"索拉特王国王室更迭,塞伦纳王朝享国 312 年而终,卡诺王朝兴,迁都卡诺"
 *   (汗国写"汗位易主")。标签"朝"。"享国 N 年"一律按当朝算(灭亡时也是),复国写"故景遗民"(亡国时那一朝的国号)。
 * - **城市兴衰**(阶段 3):洗劫写"大渭纵兵大掠汾城"(标签"掠"),折进那场战争;毁城写"大渭破昌国国都汾城,屠其民"
 *   (标签"毁"),折进战争,也单独列一条(和亡国一样);重建写"汾城重建"(换了民族另起新名:"汾城故址上筑起新城瑞城",标签"建");
 *   旧都衰落写"大昌旧都汾城渐衰"(亡了的国写"故都",标签"衰")。洗劫、毁城在史事里记在攻占前面,战争的子条目里排回攻占后面;
 *   战争标题里写毁了哪几座城("毁汾城")。
 * - **重要度**(界面上的"大事" = 重要度 3,一个世界 3000 年三四十条,一页读完,能当"世界简史"读:几个大国怎么兴起、
 *   打了哪几场改变格局的仗、怎么改朝换代、谁亡了;"全部"里什么都有):
 *   3 = 大国(到过第 2 档)立国、升格到一生最高的第 2 档以上(称王 / 称帝)、分出来的(复国的)国家日后长成大国、
 *       并掉的是大国、大国土崩瓦解、东方改朝换代(当时第 DYNASTY_TIER 档以上)、帝国级(第 CAPITAL_TIER 档)主动迁都、
 *       改变格局的战争:灭了大国、吞并一个像样的国家(亡的是"国"、易手 ≥ FALL_WAR 州;小国分出去又被原主收回的不算)、
 *       打下国都、余下的州一并归降(破都纳降,亡的是"国";小国分出去又被原主收回的不算)、易手 ≥ BIG_WAR 州、攻下大国做了 ≥ OLD_CAPITAL 年的国都、两个第 3 档的帝国交兵且易手 ≥ TITAN_WAR 州、
 *       毁了大城(或做国都的城);
 *   2 = 小国立国、小国分裂 / 复国 / 并入大国、小国的改朝换代、降格、其余有得失的战争、战争里的每一件事(亡国、毁城那一条
 *       也单列,"大事"里由战争说)、夺别国的州、部落亡了、西幻的王室更迭(国名不变,地图上看不出来)、洗劫、城被毁、
 *       城(以上)重建、旧都衰落;
 *   1 = 部 → 国、只扩土不改国号、无功而还的战争、收服部落、村镇被毁、村镇重建。
 * - **大事合写**(combine):同一国家短时间(COMBINE_GAP 年)里连着的大事,后一件写进前一件,"大事"里不再单占一行
 *   ("全部"里照旧单列):改朝换代后不久有州叛离("…,国号大辰;七年后喀勒川叛大辰王朝自立,号库兹汗国");
 *   亡国之后逃难的迁徙写进那场战争("…,艾莱斯国亡,艾莱斯族南迁,入阿拉斯等五州")。
 * - **来历**(introduce):只看大事时,某国第一次出现、它的立国 / 分裂 / 复国不在大事里的,名字后面带一句来历:
 *   "艾莱斯国(第 2341 年立国)"、"塔提特汗国(第 2082 年叛哈尔提亚王国自立)"、"新塔提特汗国(第 2455 年脱哈尔提亚帝国复国)";
 *   改朝换代换了国号、那次改朝换代不在大事里的:"伊罗汗国(原居兰汗国)"。
 * - **同化与迁徙**(阶段 3,史事的 a、b 是民族):一波迁徙(同一刻、同一民族、同一起因)折成一条
 *   "居兰族避大渭兵锋西迁,入疏勒原等五州" / "乌耐族随乌耐汗国南下,徙居瑞州等三州"(方位读 Culture.migrations);
 *   逐州的同化按"新民族 + 原民族 + 统治的国家"折叠,相隔不到 ASSIM_GAP 年的算一段(一段最长 ASSIM_SPAN 年):
 *   "大渭治下,瑞州等五州的居兰人渐为渭人";统治民族反被同化写"大渭的居兰人渐染渭俗,…渐为渭人";
 *   部落地带的孤地(没有国家)写"瑞州的居兰人渐为渭人"。民族消亡单列一条"乌耐族亡"(大事)。
 *   迁入 ≥ MIGRATE_MAJOR 州的迁徙、同化 ≥ ASSIM_MAJOR 州的一段、民族消亡是大事。
 *   大迁徙(migration.ts,史事 trek)一次一条大事(种类记成 migrate,标签"徙";写法见 trekEntry),展开看经过;
 *   到了以后那一仗照旧单列一条战争,打进大国国都引起的大崩解写成"萨热汗国破星邑,百尾皇朝大崩解,……";
 *   迁来立的国的统治民族渐为当地多数所化写"萨热汗国境内的克拉尔人渐为桑人,瑶渊之野等五州皆说桑语"(≥ TREK_ASSIM_MAJOR 州是大事)。
 * - **干预**(阶段 4,史事 intervene;哪一条干预见 Civ.interventions[e.war]):"【干预】大昌与索拉特结盟"
 *   "【干预】大昌自此不亡"(有截止年份的加",至第 2750 年")"【干预】大昌向索拉特宣战"(没打成的写原因:"…,然两国不接壤,未能成行");
 *   划州"【干预】瑞州自大渭划归大昌,永为大昌之土";立国"【干预】瑞州脱大渭自立,号瑞国,都于瑞城"(紧跟着的 found 并进这一条);
 *   迁都"【干预】大昌自汾城迁都瑞城"(紧跟着的 capital 并进这一条);不许扩张"【干预】大昌自此止戈息兵,不再开疆拓土"。
 *   没生效的写原因("…,然其地无人居住""…,然瑞城属大渭");界面上的干预列表也用它(interventionOutcome)。标签"干",一律是大事。
 *   照大纲硬改出来的(干预带 plot,gen/edits.ts 文件头"大纲")前面标【照大纲】,别的写法一样:"【照大纲】大昌向索拉特宣战";
 *   同一条情节同一刻划给同一国的几州并成一条:"【照大纲】瑞州、汾州、雪西三州划归大昌"。
 *   记在作者人物名下的国家的事(干预带 author)后面写"(林小满之议)":"【干预】大昌与索拉特结盟(林小满之议)"。
 *   援盟参战的战争(史事 war 的 settlement 列 = 盟国)写"索拉特应大昌之约伐某国"。
 * - **作者的将领、名臣**(干预"任将 / 任臣",Person.author;appoint.ts):他挂帅的仗统帅写他、推演原来派的那位写成副将 ——
 *   "大定以林小满为将、司玄为副,起兵伐奥利亚""奥利亚以林小满为将、司玄为副拒之",后面几仗的统帅也写他("…,副将司玄战死");
 *   那一刻君主亲征的,君主为帅、他随驾("大定太宗亲征奥利亚,林小满随驾")。作者的名臣在朝时议和、劝进写上他(写在推演里经手的那位后面:
 *   "大定遣礼部尚书百里青、侍郎林小满与奥利亚议和"),议事后面加一句"…,丞相林小满与议"(西幻"参与其议")。
 *   【干预】:"以林小满为大定将""以林小满为大定侍郎"(入朝拜的官);从本国将领任上入朝的"大定将林小满入朝为侍郎,副将司玄代领其军"
 *   (手上正领着的那场仗由推演原来派的那位接着领);宣战点了谁挂帅的"大定向奥利亚宣战,以林小满为帅"。
 * - **名臣**(Person.deeds):经手的事写上他(官职按那一年):议和"大景王朝遣礼部尚书百里青与萨尔斯坦帝国议和"
 *   (对方的使臣写在对方国名后面);称王称帝"…,丞相某某劝进"(西幻"…,首相某某力主其事");幼主即位"…,时年 11 岁,丞相某某辅政"
 *   (西幻"摄政");先君遇弑"…;丞相某某迎立其兄柳清瑶,是为睿宗"(西幻、汗国"拥立")。
 * - **灾异**(动荡、饥荒、民变、大崩解,unrest.ts):饥荒写"大渭瑞州等三州大饥,死者十之二"(标签"饥",只在"全部"里);
 *   民变连同讨伐它的那场战争折成一条"瑞州大饥,饥民奉李昭为主,据瑞城起事,号瑞国,叛大渭,…"再写结局
 *   ("旋为大渭所平""攻破汾城,大渭亡""得汾州,与大渭议和,割据一方";标签"起",攻破都城、亡了原来国家的是大事);
 *   民变被讨平的那条灭亡写"大渭讨平瑞国"(标签"平");大崩解写"大渭大乱,瑞州、汾州各自立国,大渭仅保汾城一隅"
 *   (地方崩加"诸州残破",散回部落"…土崩瓦解,二十三州散为部落…";标签"崩",一律是大事),紧跟着自立的几块是它的子条目。
 *   瘟疫(plague.ts)同一场折成一条"大疫起于维罗拉,传至特罗纳、哈尔兰,5 年间诸国死者十之二"(大瘟疫"大疫,起于…";标签"疫";
 *   大瘟疫、传到三国以上、死者十之二以上的是大事),子条目是逐年传到哪。
 *   全球大疫(pandemic.ts)写"克尔顿大疫:起于克尔顿,循航线传遍四洲,至五百六十一州,9 年乃息。城中死者十之四五,天下人口十去其二"
 *   ("天下"只给全球大疫);疫后荒废的城一国一条"某国疫后城邑荒废:甲、乙、丙等十三处,道路断绝"(子条目是每一处);
 *   凋敝结束一条"疫后凋敝三十年,至是始复。天下城邑荒废者六十余处,道路断绝近半"。这三样标签"疠"(界面上叫"大疫",颜色同瘟疫);
 *   逐年传到哪的子条目照旧是"疫"。
 * - **掌实权**(regents.ts,史事 regent,见 regentEntry):帝国的引兵入朝、大臣大将专权,王国以上的叔父篡位是大事;太子监国、还政、伏诛、卒在"全部"里;
 *   标签按哪一步:掌权"权"、还政"还"、伏诛"诛"、叔父篡位"篡"、掌权的人卒"亲"(亲政)。
 *   幼主的叔父摄政、名臣辅政写在即位那一条("…,时年 9 岁,叔父某某摄政"),名臣、大臣篡位写在改朝换代那一条("…,丞相某某废幼主某某,自立为君";
 *   这一条的标签是"篡",别的改朝换代是"朝")。
 * - **结亲**(marriages.ts,史事 marry,标签"姻",见 marryEntry):"南漓、大澜结亲:大澜德宗以女风氏妻南漓懿公胡炜";互嫁并成一条;议和时"是为和亲";
 *   两个帝国议和时的和亲是大事。结亲以后两国结盟(KIN_FADE 年内、那以后没开过战,regentInfo.ts 的 kinAt)的那一条后面写"(两国本为姻亲)"。
 * - 年份写法和时间轴一致:"第 N 年"(N = 年份取整)。州数等计数用中文数字("得瑞州等五州"),年数用阿拉伯数字。
 *
 * buildChronicle 按 civ 缓存(同一个 civ 只算一次)。
 */
import type { Annal, AnnalCause, AnnalKind, Civ, Culture, MigrationDir, Person, PersonRegency, PersonSpouse, Polity, Year } from '../types';
import { IV_GONE, IV_HELD, IV_NO_THRONE, REGENCY_KINDS, RG_DIED, RG_PURGE, RG_RETURN, RG_START, RG_USURP } from '../regents';
import { MARRIAGES_KNOBS } from '../marriages';
import { knobsOf } from '../knobs';
import { holderAt, kinAt, strongHeld } from './regentInfo';
import {
  TIER_REGIONS,
  annexedRemnants,
  dynastyIndexAt,
  dynastyTitle,
  polityAlive,
  polityName,
  polityRootAt,
  polityShortTitle,
  polityTierAt,
  polityTitles,
  populationAt,
  regionPopulationAt,
  settlementRank,
} from '../growth';
import { pandemicsOf } from './pandemicInfo';
import { HABITABLE_SUIT, cultureLabel, regionLabel, standPassName } from './display';
import { ownersAt } from '../engine/timeline';
import { plagueSpans } from './plagueSpans';
import { Issue, REFORM_COUP, REFORM_REVOLUTION, councilBefore, isReformIssue, rulesAt } from '../councilRules';
import { reformedSeg, royalSeg } from '../regime';
import { IV_REIGNING, authorPostsFrom } from '../appoint';
import { practicesAt } from './practiceInfo';
import { Practice, hasPractice } from '../practices';
import { ageAt, coreRoot, dowagerSpans, dowagerWordOf, generalRef, kinOf, leaderName, ministerRole, princeRef, princeTitle, reigningAt, rulerBare, rulerRef, rulerShort, rulerTitle, splitSurname } from './peopleText';
import { bySex, childWord, heOrShe, heirWord, isFemale, khanWord, kinWord, rivalsWord, westRank, type Sexed } from './gender';
import { eraText, monthTail, type Era } from '../../era';
import { biomeHas } from '../../biomes';
import { TREK_DIR_NAMES, keyCells, parsePersonKey, regionOfKey, resolveKey, resolvePersonKey, type Intervention } from '../../edits';
import { isNameToken, nameIf, nameToken, rootShapeOf } from '../nameToken';
import { IV_NO_WAY } from '../trekRoute';
import { emptyPolicy, policyName, type PolicyIv } from '../policy';
import { IV_NOT_HIM, IV_PEOPLE, IV_PROTECTED, IV_WAIT, KEEP_COURT, KEEP_REGENT } from '../rulers';
import { personNamers } from '../naming';

import { IV_TOLL, PLAGUE_IV, SLUMP_DEFAULT, quakeWord } from '../calamity';
import { foesAt } from '../fiscalBook';
import { IV_NOBODY, IV_NO_ZONE, IV_REFUSED, OPT_LASTING, envoyOf, treatyBook, treatyCallName, treatyLine } from './treatyInfo';
import { BOOST_N, IV_TOP_ERA } from '../boost';
import { ERAS } from '../development';

/** 重要度:3 最重要 */
export type Importance = 1 | 2 | 3;
/** "大事"的门槛:重要度 3 */
export const MAJOR: Importance = 3;
/** 收服部落:同一国前后两次相隔不到这么多年,算同一轮,折叠成一条 */
export const TRIBAL_GAP = 30;
/** 收服部落:一轮最长这么多年(国家一直在扩张时,每一百年左右记一条,不会一条跨上千年) */
export const TRIBAL_SPAN = 100;
/**
 * 易手这么多州以上的战争改变格局(大事)。这个和下面大国交兵的门槛在 GENERATOR_VERSION 43(仗打得密,一场仗平均多拿两成州)
 * 跟着调高了两成(15 → 18、8 → 10)
 */
export const BIG_WAR = 18;
/** 攻下做了这么多年以上的国都(故都陷落)的战争是大事 */
export const OLD_CAPITAL = 300;
/** 到过这一档(王国 / 二十五州)以上的是大国:立国算大事 */
export const GREAT_TIER = 2;
/** 双方开战时都在这一档(帝国 / 七十州)以上:大国交兵,有得失就算大事 */
export const TITAN_TIER = 3;
/** 大国交兵:易手这么多州以上才算大事 */
export const TITAN_WAR = 10;
/** 灭国之战:亡的是大国,或者易手这么多州以上(吞并一个像样的国家),才算大事;小国(残部)被收拾掉的只在"全部"里 */
export const FALL_WAR = 6;
/** 改朝换代(东方)、主动迁都:当时在这一档(帝国 / 七十州)以上的是大事;小一些的国家只在"全部"里 */
export const DYNASTY_TIER = 2;
export const CAPITAL_TIER = 3;
/** 同化:同一国治下、同一对民族,前后相隔不到这么多年的算一段,折叠成一条;一段最长这么多年 */
export const ASSIM_GAP = 120;
export const ASSIM_SPAN = 300;
/** 一段同化改换了这么多州以上是大事;不到 ASSIM_MINOR 州的只在"全部"里算小事(重要度 1) */
export const ASSIM_MAJOR = 10;
export const ASSIM_MINOR = 3;
/** 一波迁徙迁入这么多州以上是大事 */
export const MIGRATE_MAJOR = 5;
/** 大迁徙迁来立的国,统治民族一段里被同化了这么多州以上是大事 */
export const TREK_ASSIM_MAJOR = 5;

/**
 * 纪事的种类:史事的种类,加上按人物排出来的君主继位(reign,不是史事,见 reignEntries)、
 * 信仰的大事(faith,不是史事,见 religionText.ts 的 faithEntries)、时代和物产的大事(era,见 developmentText.ts 的 developmentEntries)
 */
/** 纪事的种类(见上);改制里动了兵的革命、政变单列(时间轴上归战争那一类的红色) */
export type EntryKind = AnnalKind | 'reign' | 'faith' | 'era' | 'thought' | 'revolution' | 'coup' | 'plugin';

export interface ChronicleEntry {
  /** 这一条(第一条)史事在 civ.annals 里的下标;列表里唯一,当 key 用(君主继位 = civ.annals.length + 新君的 Person.id) */
  id: number;
  kind: EntryKind;
  /** 发生的年份(引擎精度的原值,1/256 年;显示取整)。折叠的条目 = 第一件事的年份 */
  year: Year;
  /** 截止年份:折叠的条目 = 最后一件事的年份(战争到结束年份还没打完 = civ.endYear);其余 = year */
  end: Year;
  /** 纪事正文(不带年份) */
  text: string;
  /** 一个字的标签(界面上的小印章):立 升 降 战 占 征 和 割 亡 迁 分 复 合 朝 徙 化 湮 掠 毁 建 衰 干 役 变 没 嗣 饥 起 崩 平 疫 权 姻;立约:约 续 满 违 中 逐 奔;信仰:创 皈 传 派 圣;时代:代;商道:商;思潮:思 */
  tag: string;
  importance: Importance;
  /** 相关国家(按国家筛选、地图高亮用;先主后次,不含 −1) */
  polities: number[];
  /** 事发的州(地图高亮用;升格、宣战、合并这类没有具体州的为空,界面高亮相关国家的国土) */
  regions: number[];
  /** 相关的城(立国 / 迁都的国都、攻占的城);没有 = −1 */
  settlement: number;
  /** 折叠进来的每一件事(按先后) */
  children?: ChronicleEntry[];
  /** 战争到结束年份还没打完 */
  ongoing?: boolean;
  /** 战争那一条的开头(由头和出兵,不含得失):回放视频里战争还没打完时只写这一句 */
  head?: string;
  /** 正文里写到的人物(Person.id;没有 = 不给) */
  people?: number[];
  /** 信仰的大事:哪种信仰(civ.religion.faiths 的下标;教派分立 = 新的教派) */
  faith?: number;
  /** 商道的大事:哪几条商道(civ.trade.routes 的下标;见 tradeText.ts) */
  trade?: number[];
  /** 思潮的大事:哪一说(始倡、盛于的那说,渐衰里代兴的那说;THOUGHTS 的下标,见 ideologyText.ts) */
  thought?: number;
  /** 推演插件写的(kind = 'plugin'):哪个插件 */
  plugin?: string;
}

// ---------------------------------------------------------------------------
// 小工具

const CN_DIGITS = '零一二三四五六七八九';
const CN_UNITS = ['', '十', '百', '千'];

/** 计数用的中文数字(0–9999):5 → 五,12 → 十二,25 → 二十五,105 → 一百零五 */
export function cnNumber(n: number): string {
  const v = Math.floor(n);
  if (!(v >= 0) || v >= 10000) return String(Number.isFinite(v) ? v : 0);
  if (v < 10) return CN_DIGITS[v];
  const ds = String(v).split('').map(Number);
  let out = '';
  let zero = false;
  for (let i = 0; i < ds.length; i++) {
    const d = ds[i];
    const u = CN_UNITS[ds.length - 1 - i];
    if (d === 0) {
      zero = true;
      continue;
    }
    if (zero && out) out += '零';
    zero = false;
    out += (d === 1 && u === '十' && i === 0 ? '' : CN_DIGITS[d]) + u;
  }
  return out;
}

/** "第 N 年"(和时间轴一致:年份取整) */
export function yearText(y: Year): string {
  return `第 ${Math.floor(y)} 年`;
}

/** 条目的年份:"第 1240 年";跨年的折叠条目 "第 1240—1256 年" */
export function entryYearLabel(e: ChronicleEntry): string {
  const a = Math.floor(e.year);
  const b = Math.floor(e.end);
  return b > a ? `第 ${a}—${b} 年` : `第 ${a} 年`;
}

/**
 * 条目的年份带月(一年 months 个月;0 = 只写年):"第 1240 年 3 月";月份起了名字的 "第 1240 年端月"(names 见 era.ts 的 MonthNames);
 * 跨年的折叠条目照旧 "第 1240—1256 年"(每一件事各自写月)
 */
export function entryYearMonthLabel(e: ChronicleEntry, months: number, names?: readonly string[] | null): string {
  return Math.floor(e.end) > Math.floor(e.year) ? entryYearLabel(e) : `${yearText(e.year)}${monthTail(e.year, months, names)}`;
}

function polityOf(civ: Civ, id: number): Polity | null {
  return id >= 0 && id < civ.polities.length ? civ.polities[id] : null;
}

/** 某年的国名(当年的国号);编号无效 = "某国" */
function pn(civ: Civ, id: number, year: Year): string {
  const p = polityOf(civ, id);
  return p ? polityName(p, year) || p.name || '某国' : '某国';
}

/** 城名;编号无效 / 没名字 = 空串 */
function cityName(civ: Civ, s: number): string {
  return s >= 0 && s < civ.settlements.length ? civ.settlements[s].name || '' : '';
}

/** 州名;编号无效 = 空串 */
function regionName(civ: Civ, r: number): string {
  return r >= 0 && r < civ.regions.count ? regionLabel(civ, r) : '';
}

/** 一串州:"瑞州"、"瑞州、青州"、"瑞州等五州"(人口上限大的写在前面) */
export function regionList(civ: Civ, rs: readonly number[]): string {
  const ok = rs.filter((r) => r >= 0 && r < civ.regions.count);
  if (!ok.length) return '';
  const cap = civ.regions.capacity;
  const sorted = [...ok].sort((a, b) => cap[b] - cap[a] || a - b);
  if (sorted.length === 1) return regionName(civ, sorted[0]);
  if (sorted.length === 2) return `${regionName(civ, sorted[0])}、${regionName(civ, sorted[1])}`;
  return `${regionName(civ, sorted[0])}等${cnNumber(sorted.length)}州`;
}

/**
 * 议和割让的州,一一写出:"瑞州"、"瑞州、汾州两州"、"瑞州、汾州、雪西三州";多于 CEDE_NAMES 州的写前几州:
 * "瑞州、汾州、雪西、乌绝原、梅川等十二州"(按人口上限从大到小)
 */
const CEDE_NAMES = 5;
function regionNames(civ: Civ, rs: readonly number[]): string {
  const ok = rs.filter((r) => r >= 0 && r < civ.regions.count);
  if (!ok.length) return '';
  const cap = civ.regions.capacity;
  const sorted = [...ok].sort((a, b) => cap[b] - cap[a] || a - b);
  if (sorted.length === 1) return regionName(civ, sorted[0]);
  const n = sorted.length;
  const names = sorted.slice(0, CEDE_NAMES).map((r) => regionName(civ, r));
  return n <= CEDE_NAMES ? `${names.join('、')}${n === 2 ? '两' : cnNumber(n)}州` : `${names.join('、')}等${cnNumber(n)}州`;
}

function cultureOf(civ: Civ, id: number): Culture | null {
  return id >= 0 && id < civ.cultures.length ? civ.cultures[id] : null;
}

/** 族名:"居兰族";编号无效 = "某族" */
function cn(civ: Civ, id: number): string {
  const c = cultureOf(civ, id);
  return c && c.name ? cultureLabel(c) : '某族';
}

/** 族人:"居兰人";编号无效 = "异族人" */
function folk(civ: Civ, id: number): string {
  const c = cultureOf(civ, id);
  return c && c.name ? `${c.name}人` : '异族人';
}

/** 某年之前(不含这一年这一刻)的国都 */
function capitalBefore(p: Polity, year: Year): number {
  const c = p.capitals;
  if (!c || !c.length) return p.capital;
  let s = c[0].settlement;
  for (let i = 1; i < c.length && c[i].year < year; i++) s = c[i].settlement;
  return s;
}

/** 某年之前(不含这一刻)的国都做了多少年国都 */
function capitalHeld(p: Polity, year: Year): number {
  const c = p.capitals;
  if (!c || !c.length) return year - p.founded;
  let since = c[0].year;
  for (let i = 1; i < c.length && c[i].year < year; i++) since = c[i].year;
  return year - since;
}

/** 到过的最高档位(没有 titles = 0) */
function peakTier(p: Polity): number {
  let t = 0;
  for (const x of p.titles ?? []) if (x.tier > t) t = x.tier;
  return t;
}

/** 大国:到过第 GREAT_TIER 档(王国 / 二十五州)以上 */
function isGreat(p: Polity | null): boolean {
  return !!p && peakTier(p) >= GREAT_TIER;
}

/** 是个"国":到过第 1 档,或是分裂 / 复国出来的。一直是"X部"的部落亡了不算灭国 */
function isState(p: Polity | null): boolean {
  return !!p && (peakTier(p) >= 1 || p.parent !== undefined || p.restores !== undefined);
}

const uniq = (xs: number[]) => xs.filter((x, i) => x >= 0 && xs.indexOf(x) === i);

// ---------------------------------------------------------------------------
// 人物(Civ.people;没有人物的 civ 照旧不写人名)

interface Command {
  side: number;
  /** 经手的第一件、最后一件事(史事下标,见 PersonCommand) */
  first: number;
  last: number;
  /** 卸下这一任的那一刻(见 PersonCommand) */
  until: Year;
  person: Person;
}

/** 人物索引:每国的君主(按即位先后)、每场战争两边的统帅任期、名臣经手的事 */
interface PeopleIndex {
  rulers: Person[][];
  commands: Map<number, Command[]>;
  /** 史事下标 → 经手的名臣(议和、劝进) */
  envoys: Map<number, Person[]>;
  /** 新君(Person.id)→ 辅政 / 迎立他的名臣 */
  regent: Map<number, Person>;
  enthrone: Map<number, Person>;
  /** 人物编号 → 儿子(按出生先后;争储写"三子某某"用) */
  kids: Map<number, Person[]>;
  /** 据险断后(史事 stand 的下标)→ 守关隘的守将(不算统帅,不在 commands 里) */
  rear: Map<number, Person>;
  /** 史事下标(掌实权的掌权、还政、伏诛、篡位、卒那一条)→ 掌权的人、那一段(Person.regencies) */
  power: Map<number, { x: Person; g: PersonRegency }>;
  /** 幼主(Person.id)→ 摄政的叔父 / 临朝的太后 */
  uncle: Map<number, Person>;
  dowager: Map<number, Person>;
  /** 史事下标(结亲那一条)→ 娶亲的人、那一门亲(Person.spouses) */
  wed: Map<number, { x: Person; s: PersonSpouse }>;
  /** 国家 → 作者的名臣(任臣、掌权的作者人物;Person.author);没有 = 不在里面 */
  court: Map<number, Person[]>;
  /** 史事(统帅按史事位置找那一刻的年份) */
  annals: readonly Annal[];
}

const peopleCache = new WeakMap<object, PeopleIndex>();

function peopleOf(civ: Civ): PeopleIndex | null {
  const list = civ.people;
  if (!list || !list.length) return null;
  let ix = peopleCache.get(list);
  if (ix) return ix;
  ix = {
    rulers: civ.polities.map(() => []),
    commands: new Map(),
    envoys: new Map(),
    regent: new Map(),
    enthrone: new Map(),
    kids: new Map(),
    rear: new Map(),
    power: new Map(),
    uncle: new Map(),
    dowager: new Map(),
    wed: new Map(),
    court: new Map(),
    annals: civ.annals,
  };
  for (const x of list) {
    if (x.parent !== undefined) {
      const ks = ix.kids.get(x.parent);
      if (ks) ks.push(x);
      else ix.kids.set(x.parent, [x]);
    }
    if (x.role === 'ruler' && x.polity >= 0 && x.polity < ix.rulers.length) ix.rulers[x.polity].push(x);
    for (const g of x.regencies ?? []) {
      ix.power.set(g.annal, { x, g });
      if (g.endAnnal !== undefined) ix.power.set(g.endAnnal, { x, g });
      // 幼主即位那一刻起摄政的叔父(写在即位那一条);作者下令、后来才摄政的不算(那一条 regent 自己写)
      if (g.kind === 'uncle' && civ.annals[g.annal]?.foe === undefined) ix.uncle.set(g.ruler, x);
      if (g.kind === 'dowager') ix.dowager.set(g.ruler, x);
    }
    for (const s of x.spouses ?? []) ix.wed.set(s.annal, { x, s });
    if (x.author !== undefined && x.role === 'minister') {
      const cs = ix.court.get(x.polity);
      if (cs) cs.push(x);
      else ix.court.set(x.polity, [x]);
    }
    // 名臣经手的事(篡位做了新朝第一位的名臣,做名臣时经手的事也在他身上)
    for (const d of x.role === 'minister' || x.role === 'ruler' ? (x.deeds ?? []) : []) {
      if ((d.kind === 'peace' || d.kind === 'rank') && d.annal !== undefined) {
        const m = ix.envoys.get(d.annal);
        if (m) m.push(x);
        else ix.envoys.set(d.annal, [x]);
      } else if ((d.kind === 'regent' || d.kind === 'enthrone') && d.person !== undefined && !ix[d.kind].has(d.person)) ix[d.kind].set(d.person, x);
    }
    for (const c of x.commands ?? []) {
      if (c.rear) {
        ix.rear.set(c.first, x);
        continue;
      }
      let m = ix.commands.get(c.war);
      if (!m) ix.commands.set(c.war, (m = []));
      m.push({ side: c.side, first: c.first, last: c.last, until: c.until, person: x });
    }
  }
  for (const rs of ix.rulers) rs.sort((a, b) => (a.from ?? 0) - (b.from ?? 0) || a.id - b.id);
  for (const ks of ix.kids.values()) ks.sort((a, b) => a.born - b.born || a.id - b.id);
  for (const m of ix.commands.values()) m.sort((a, b) => a.first - b.first || a.person.id - b.person.id);
  peopleCache.set(list, ix);
  return ix;
}

/** 名臣带官职:"丞相百里青""首相弗拉文斯"(官职按那一年) */
function ministerRef(x: Person, y: Year): string {
  let title = '';
  for (const p of x.posts ?? []) if (p.from <= y + 1e-6) title = p.title;
  return `${title}${x.name}`;
}

/** 东方中式的写法(汗国、西幻、共和国平实些) */
const classical = (p: Polity | null | undefined) => !!p?.eastern && p.lineage !== 'khanate';

/** 议和的开头:"甲遣礼部尚书某某与乙议和"(乙方的使臣:"甲与乙首相某某议和");people = 写到的名臣 */
function peaceHead(civ: Civ, ix: PeopleIndex | null, e: Annal, i: number, y: Year): { text: string; people: Person[] } {
  const ms = ix?.envoys.get(i) ?? [];
  const ma = envoysOf(ms, e.a);
  const mb = envoysOf(ms, e.b);
  const refs = (xs: Person[]) => xs.map((m) => ministerRef(m, y)).join('、');
  const text = `${pn(civ, e.a, y)}${ma.length ? `遣${refs(ma)}` : ''}与${pn(civ, e.b, y)}${refs(mb)}议和`;
  return { text, people: [...ma, ...mb] };
}

/** 经手这件事的一国的名臣:推演里经手的那一位在前,再加作者的名臣(任臣) */
function envoysOf(ms: readonly Person[], p: number): Person[] {
  const own = ms.find((m) => m.polity === p && m.author === undefined);
  const out = ms.filter((m) => m.polity === p && m.author !== undefined);
  return own ? [own, ...out] : out;
}

/** 某一刻在位的君主(即位那一刻起算) */
function reigning(ix: PeopleIndex | null, p: number, t: Year): Person | null {
  const rs = ix?.rulers[p];
  if (!rs) return null;
  for (let i = rs.length - 1; i >= 0; i--) {
    const r = rs[i];
    if ((r.from ?? Infinity) <= t) return r.until === undefined || t < r.until ? r : null;
  }
  return null;
}

/** 在 t 这一刻失去君位的那一位(亡国、改朝换代的末代) */
function endedAt(ix: PeopleIndex | null, p: number, t: Year): Person | null {
  const rs = ix?.rulers[p];
  if (!rs) return null;
  for (let i = rs.length - 1; i >= 0; i--) if (rs[i].until === t) return rs[i];
  return null;
}

/**
 * 某场战争某一方(0 = 攻方,1 = 守方)打第 i 条史事(宣战、战役、攻占)的统帅。作者的将领(任将)挂帅的那几段是他
 * (推演原来派的那位是副将,见 deputyOf);那一刻推演派的是亲征的君主的,君主为帅(作者的将领随驾,见 escortOf)
 */
function commander(ix: PeopleIndex | null, war: number, side: number, i: number): Person | null {
  const { lead, own } = leadersAt(ix, war, side, i);
  return lead && !(own && reigningAt(own, ix!.annals[i]?.year ?? -Infinity)) ? lead : own;
}

/** 作者的将领(任将;作者立的君主亲征不算,他占的是推演派统帅的那个位置) */
const authorGeneral = (x: Person | null | undefined): boolean => !!x && x.author !== undefined && x.role === 'general';

/** 这一方第 i 条史事那一刻:推演派的统帅(own)、挂帅的作者将领(lead,没有 = null) */
function leadersAt(ix: PeopleIndex | null, war: number, side: number, i: number): { own: Person | null; lead: Person | null } {
  let own: Person | null = null;
  let lead: Person | null = null;
  const m = ix?.commands.get(war);
  if (!m || side < 0) return { own, lead };
  for (const c of m) {
    if (c.side !== side || c.first > i || i > c.last) continue;
    if (authorGeneral(c.person)) lead ??= c.person;
    else own ??= c.person;
  }
  return { own, lead };
}

/** 作者的将领挂帅时推演原来派的那位(副将);不是作者的将领挂帅 = null */
function deputyOf(ix: PeopleIndex | null, war: number, side: number, i: number): Person | null {
  const { lead, own } = leadersAt(ix, war, side, i);
  return lead && commander(ix, war, side, i) === lead ? own : null;
}

/** 君主亲征时随驾的作者将领;没有 = null */
function escortOf(ix: PeopleIndex | null, war: number, side: number, i: number): Person | null {
  const { lead } = leadersAt(ix, war, side, i);
  return lead && commander(ix, war, side, i) !== lead ? lead : null;
}

/** 在第 i 条史事(战役、攻占)里战死的那一方统帅 */
function fallenAt(ix: PeopleIndex | null, war: number, side: number, i: number): Person | null {
  for (const c of ix?.commands.get(war) ?? []) if (c.side === side && c.last === i && c.person.fate === 'battle') return c.person;
  return null;
}

/** 某国第 i 朝的第一位君主 */
function founderOf(ix: PeopleIndex | null, p: number, i: number): Person | null {
  return ix?.rulers[p]?.find((x) => (x.dynasty ?? 0) === i) ?? null;
}

/** 给纪事记上写到的人物 */
function withPeople(x: ChronicleEntry, ...ps: (Person | null | undefined)[]): ChronicleEntry {
  const ids = ps.filter((p): p is Person => !!p).map((p) => p.id);
  if (ids.length) x.people = uniq([...(x.people ?? []), ...ids]);
  return x;
}

// ---------------------------------------------------------------------------
// 单条史事 → 纪事

/** 国号变化:第几条 rank 史事对应 titles 里的哪一条(同一年有两条时按先后对上) */
interface Ctx {
  civ: Civ;
  /** 国家 → 已经用掉的 titles 下标 */
  titleUsed: Map<number, number>;
  /** 是"夺回"的攻占(史事下标):攻方以前占有过这一州(被夺走、议和割让、分裂出去之后又打回来) */
  retake: Set<number>;
  /** 分裂 / 复国出来的国家 → 它是从哪国分出去的(split 史事的 b) */
  splitFrom: Map<number, number>;
  /** 逃难的一波迁徙(条目 id)→ 不带起因的短句"艾莱斯族南迁,入阿拉斯等五州"(合写进战争那一条用,见 combine) */
  flight: Map<number, string>;
  /** 人物索引(没有人物 = null,照旧不写人名) */
  ix: PeopleIndex | null;
  /** 讨伐民变、据地争位的宗室的战争(war 的 cause = quell / heir)→ 起事的国家 */
  quell: Map<number, number>;
}

/**
 * 哪些攻占是"夺回":按史事从头翻,记下每一州先后归过哪些国家(攻占的原主、分裂出去的原主国),
 * 攻方以前占有过的就是夺回。只看史事(扩张得来、后来丢掉的州,丢的那条攻占里原主就是它)
 */
function retakes(A: readonly Annal[]): Set<number> {
  const had = new Map<number, Set<number>>();
  const out = new Set<number>();
  const add = (r: number, p: number) => {
    if (r < 0 || p < 0) return;
    let s = had.get(r);
    if (!s) had.set(r, (s = new Set()));
    s.add(p);
  };
  A.forEach((e, i) => {
    if (e.kind === 'conquer') {
      if (e.a >= 0 && had.get(e.region)?.has(e.a)) out.add(i);
      add(e.region, e.b);
      add(e.region, e.a);
    } else if (e.kind === 'split') {
      add(e.region, e.b);
      add(e.region, e.a);
    }
  });
  return out;
}

/** 升格 / 降格:[之前的档位, 之后的档位] */
function rankTiers(ctx: Ctx, e: Annal, p: Polity): [number, number] {
  const t = p.titles ?? [];
  const used = ctx.titleUsed.get(p.id) ?? 0;
  for (let j = Math.max(1, used); j < t.length; j++) {
    if (t[j].year === e.year) {
      ctx.titleUsed.set(p.id, j + 1);
      return [t[j - 1].tier, t[j].tier];
    }
  }
  // 数据对不上(titles 没记这一次):按年份现查
  let before = 0;
  let after = 0;
  for (const x of t) {
    if (x.year < e.year) before = x.tier;
    if (x.year <= e.year) after = x.tier;
  }
  return [before, after];
}

function rankEntry(ctx: Ctx, e: Annal, id: number): ChronicleEntry {
  const { civ } = ctx;
  const p = polityOf(civ, e.a);
  let text: string;
  let importance: Importance = 1;
  let tag = '升';
  if (!p) text = '某国更定国号';
  else {
    const titles = polityTitles(p, e.year);
    const [b, a] = rankTiers(ctx, e, p);
    const advisers = envoysOf(ctx.ix?.envoys.get(id) ?? [], p.id);
    const oldName = titles[Math.min(3, Math.max(0, b))];
    const newName = titles[Math.min(3, Math.max(0, a))];
    if (a > b) {
      if (newName === oldName) {
        text = `${newName}拓地至${cnNumber(TIER_REGIONS[Math.min(3, a)])}州`;
        importance = a >= GREAT_TIER ? 2 : 1;
      } else if (newName.endsWith('帝国') && !oldName.endsWith('帝国')) {
        text = `${oldName}称帝,改号${newName}`;
        importance = 3;
      } else {
        text = `${oldName}升格为${newName}`;
        // 升到第 2 档以上(称王 / 称帝)是大事;后来还会再升一档的,"大事"里只留最高的那一次
        // (帝国的一生读起来是"立国 → 称帝",不再夹一条"称王");部 → 国是小事
        importance = a >= GREAT_TIER ? (a >= peakTier(p) ? 3 : 2) : 1;
      }
      if (advisers.length && newName !== oldName) {
        text += `,${advisers.map((m) => ministerRef(m, e.year)).join('、')}${classical(p) ? '劝进' : '力主其事'}`;
        return withPeople(base(e, id, text, importance, [e.a], [], tag), ...advisers);
      }
    } else if (a < b) {
      tag = '降';
      text = newName === oldName ? `${newName}国势衰微` : `${oldName}国势衰微,降为${newName}`;
      importance = newName === oldName ? 1 : 2;
    } else text = `${newName}更定国号`;
  }
  return base(e, id, text, importance, [e.a], [], tag);
}

/** 各种类的一字标签(降格另写"降";收服部落写"征") */
const TAG: Record<AnnalKind, string> = {
  found: '立',
  rank: '升',
  war: '战',
  conquer: '占',
  peace: '和',
  fall: '亡',
  capital: '迁',
  split: '分',
  merge: '合',
  dynasty: '朝',
  migrate: '徙',
  assimilate: '化',
  vanish: '湮',
  sack: '掠',
  ruin: '毁',
  rebuild: '建',
  decline: '衰',
  intervene: '干',
  battle: '役',
  upheaval: '变',
  sunk: '没',
  alliance: '盟',
  unally: '盟',
  submit: '臣',
  defect: '叛',
  diverge: '衍',
  famine: '饥',
  revolt: '起',
  collapse: '崩',
  plague: '疫',
  warlord: '据',
  reclaim: '收',
  defy: '抗',
  fiscal: '匮',
  council: '议',
  stand: '役',
  regent: '权',
  marry: '姻',
  pandemic: '疠',
  desolate: '疠',
  treaty: '约',
  breach: '违',
  expire: '满',
  neutral: '中',
  exile: '逐',
  keep: '保',
  trek: '徙',
  winter: '冬',
  reform: '制',
};

function base(
  e: Annal,
  id: number,
  text: string,
  importance: Importance,
  polities: number[],
  regions: number[],
  tag = e.kind === 'conquer' && e.b < 0 ? '征' : TAG[e.kind] ?? '事',
): ChronicleEntry {
  return {
    id,
    kind: e.kind,
    year: e.year,
    end: e.year,
    text,
    tag,
    importance,
    polities: uniq(polities),
    regions: uniq(regions),
    settlement: e.settlement >= 0 ? e.settlement : -1,
  };
}

/**
 * 攻占一州:"大渭攻取瑞州,国都汾城陷落";war = 所在战争的双方(写子条目时守方是谁不用再说);
 * retake = 这一州开战前本来就是攻方的(战争中被夺走又打回来):"昌国夺回柳州,收复柳城";
 * who = 换掉开头的国名(写统帅:"大渭将李牧攻取瑞州")
 */
function conquerText(civ: Civ, e: Annal, war?: [number, number], retake = false, who?: string): string {
  const A = who ?? pn(civ, e.a, e.year);
  const r = regionName(civ, e.region) || '一州';
  if (e.b < 0) return `${A}征服${r}诸部`;
  const B = pn(civ, e.b, e.year);
  const implied = war && (e.b === war[0] || e.b === war[1]);
  const city = cityName(civ, e.settlement);
  if (retake) return `${A}${implied ? '' : `自${B}手中`}夺回${r}${city ? `,收复${city}` : ''}`;
  let t = implied ? `${A}攻取${r}` : `${A}攻取${B}之${r}`;
  if (city) {
    const owner = polityOf(civ, e.b);
    const wasCapital = owner && capitalBefore(owner, e.year) === e.settlement && owner.founded <= e.year;
    t += wasCapital ? `,国都${city}陷落` : `,${city}陷落`;
  }
  return t;
}

/** 亡国之君的下场 */
const LAST_FATE: Partial<Record<NonNullable<Person['fate']>, string>> = { fell: '殉国', surrendered: '出降', fled: '出奔' };

/** 灭亡:"大昌亡于大渭,享国 312 年";有人物的加上末代君主的下场:",哀帝殉国"(土崩瓦解、亡于天灾的出奔写"不知所终") */
function fallText(civ: Civ, e: Annal, last: Person | null = null): string {
  const A = pn(civ, e.a, e.year);
  let t = e.b >= 0 ? `${A}亡于${pn(civ, e.b, e.year)}` : e.b === -2 ? `${A}亡于天灾` : `${A}土崩瓦解`;
  const p = polityOf(civ, e.a);
  if (p && Number.isFinite(p.founded)) {
    // 享国按当朝算(改朝换代过的,从新朝那年起)
    const n = Math.floor(e.year) - Math.floor(reignStart(p, e.year));
    if (n >= 1) t += `,享国 ${n} 年`;
  }
  const how = last?.fate === 'fled' && e.b < 0 ? '不知所终' : last?.fate ? LAST_FATE[last.fate] : undefined;
  if (last && how) t += `,${rulerBare(civ, last, e.year)}${how}`;
  return t;
}

/** 复国时还提故国末代之君出奔去的国家:亡国以后这么多年以内 */
const EXILE_RECALL = 100;

/** 国家 fallen 的末代之君出奔去的邻国(史事 exile,exile.ts),那国到 year 还在、亡国不到 EXILE_RECALL 年;不然 −1 */
export function exiledTo(civ: Civ, fallen: number, year: Year): number {
  const e = civ.annals.find((a) => a.kind === 'exile' && a.cause === 'fled' && a.war < 0 && a.a === fallen && a.b >= 0);
  const H = e ? polityOf(civ, e.b) : null;
  return e && H && year - e.year <= EXILE_RECALL && polityAlive(H, year) ? e.b : -1;
}

/** 某年那一朝从哪年起(没改朝换代过 = 立国那年) */
function reignStart(p: Polity, year: Year): Year {
  const d = p.dynasties;
  return d && d.length ? d[dynastyIndexAt(p, year)].year : p.founded;
}

/**
 * 编年史里称呼某一朝(year 年时的国号档位):东方 = 那一朝的国号简称("大昌""昌国";汗国写全称"乌耐汗国"),
 * 西幻 = "塞伦纳王朝"
 */
function reignName(civ: Civ, p: Polity, i: number, year: Year): string {
  if (!p.eastern) return dynastyTitle(p, i) || '旧王室';
  const d = p.dynasties?.[i];
  if (!d) return pn(civ, p.id, year);
  const tier = Math.max(0, polityTierAt(p, year));
  return p.lineage === 'khanate' ? polityTitles(p, d.year)[tier] : polityShortTitle(p, tier, d.year);
}

/**
 * 改朝换代 / 王室更迭:
 * 东方 "大昌享国 312 年而亡,景氏起于青州代之,国号大景,定都青阳"(根据地就是国都 = 权臣篡位;没迁都 = 入主旧都);
 * 西幻 "索拉特王国王室更迭,塞伦纳王朝享国 312 年而终,卡诺王朝兴,迁都卡诺"(汗国"汗位易主")。
 * 有人物的写人:"…而亡,景元起于青州代之""…而亡,权臣赵高废少帝自立""…,卡诺王朝兴,阿尔德里克三世即位"
 */
function dynastyText(civ: Civ, e: Annal, ix: PeopleIndex | null = null, usurped = false): string {
  const p = polityOf(civ, e.a);
  if (!p) return '某国改朝换代';
  const y = e.year;
  const i = Math.max(1, dynastyIndexAt(p, y));
  const d = p.dynasties ?? [];
  const n = d.length > i ? Math.floor(y) - Math.floor(d[i - 1].year) : 0;
  const lasted = n >= 1 ? `享国 ${n} 年` : '';
  const oldCap = capitalBefore(p, y);
  const moved = e.settlement >= 0 && e.settlement !== oldCap;
  const city = cityName(civ, e.settlement);
  const oldName = reignName(civ, p, i - 1, y);
  // 有人物:新朝的第一位、被废(被推翻)的末代
  const nu = founderOf(ix, p.id, i);
  const old = endedAt(ix, p.id, y);
  if (p.eastern) {
    const oldRoot = polityRootAt(p, y - 1 / 512);
    const newRoot = polityRootAt(p, y);
    const newName = reignName(civ, p, i, y);
    const house = nameIf('same', newRoot, oldRoot, '新朝', `${newRoot}氏`);
    const r = regionName(civ, e.region);
    const coup = e.region >= 0 && oldCap >= 0 && oldCap < civ.settlements.length && civ.settlements[oldCap].region === e.region;
    let t = `${oldName}${lasted ? `${lasted}而亡` : '亡'}`;
    // 被废的末代:"权臣赵高废少帝自立"(称号本身带"废"字的写名字)
    const ousted = old ? (old.title && !old.title.startsWith('废') ? rulerTitle(civ, old) : old.name) : '';
    // 掌实权的名臣、大臣篡位:"丞相契鸾废幼主季工,自立为君"(带他做名臣时的官职;末代未成年写"幼主")
    if (usurped && nu && dowagerSpans(nu).length) {
      // 临朝的太后废了幼主(她的儿子)自立:"太后燕晚歌废其子厉公,自立为君"
      const son = old && old.mom === nu.id ? '其子' : old && ageAt(old, y) < 18 ? '幼主' : '';
      t += `,${dowagerWordOf(civ, nu, y - 1 / 512)}${nu.name}${ousted ? `废${son}${ousted}` : ''},自立为君`;
    } else if (usurped && nu) {
      const young = old && ageAt(old, y) < 18 ? '幼主' : '';
      t += `,${nu.posts?.length ? ministerRef(nu, y - 1 / 512) : `权臣${nu.name}`}${ousted ? `废${young}${ousted}` : ''},自立为君`;
    } else if (coup || !r) t += nu ? `,权臣${nu.name}${ousted ? `废${ousted}` : ''}自立` : `,权臣${house}篡位`;
    else if (moved) t += `,${nu ? nu.name : house}起于${r}代之`;
    else t += `,${nu ? nu.name : house}起于${r}${cityName(civ, oldCap) ? `,入主${cityName(civ, oldCap)}` : '代之'}`;
    t += `,国号${newName}`;
    if (moved && city) t += `,定都${city}`;
    return t;
  }
  const realm = pn(civ, p.id, y);
  const what = p.lineage === 'khanate' ? '汗位易主' : '王室更迭';
  let t = `${realm}${what},${oldName}${lasted ? `${lasted}而终` : '绝嗣'},${reignName(civ, p, i, y)}兴`;
  if (usurped && nu && dowagerSpans(nu).length) {
    // 皇太后废黜她的儿子,自立为女皇 / 女王
    const son = old && old.mom === nu.id ? '其子' : '';
    t += `,${dowagerWordOf(civ, nu, y - 1 / 512)}${nu.name}${old ? `废黜${son}${old.name}` : ''},自立为${westRank(nu, p.lineage, Math.max(1, polityTierAt(p, y)))}`;
  } else if (usurped && nu) t += `,${nu.posts?.length ? ministerRef(nu, y - 1 / 512) : `权臣${nu.name}`}${old ? `废黜${old.name}` : ''},自立为${bySex(nu, '王', '女王')}`;
  else if (nu) t += `,${rulerShort(civ, nu)}即位`;
  if (moved && city) t += `,迁都${city}`;
  return t;
}

/** 城 sid 在 year 这一刻之前的级别(0 村 … 3 大城;被毁的城看被毁前一刻) */
function rankBefore(civ: Civ, sid: number, year: Year): number {
  const s = sid >= 0 && sid < civ.settlements.length ? civ.settlements[sid] : null;
  return s ? settlementRank(populationAt(s, year - 1 / 512)) : 0;
}

/** 攻城那一刻被攻下的城:是守方的国都就写"昌国国都汾城",不是写"汾城" */
function besieged(civ: Civ, e: Annal): { city: string; capital: boolean } {
  const city = cityName(civ, e.settlement) || '一城';
  const owner = polityOf(civ, e.b);
  const capital = !!owner && owner.founded <= e.year && capitalBefore(owner, e.year) === e.settlement;
  return { city: capital ? `${pn(civ, e.b, e.year)}国都${city}` : city, capital };
}

/**
 * 毁城:城以上"大渭破昌国国都汾城,屠其民" / "…焚毁汾城,城遂成废墟" / "…破汾城,夷为平地";
 * 村镇轻一些:"柳镇毁于大渭兵火" / "大渭焚毁柳镇" / "大渭破柳镇,夷为平地"。
 * 三种说法按城、年份轮换,和攻方是哪种国家无关
 */
function ruinText(civ: Civ, e: Annal): string {
  const A = pn(civ, e.a, e.year);
  const { city } = besieged(civ, e);
  const v = (Math.max(0, e.settlement) * 7 + Math.floor(e.year)) % 3;
  if (rankBefore(civ, e.settlement, e.year) >= 2) {
    if (v === 0) return `${A}破${city},屠其民`;
    if (v === 1) return `${A}焚毁${city},城遂成废墟`;
    return `${A}破${city},夷为平地`;
  }
  if (v === 0) return `${city}毁于${A}兵火`;
  if (v === 1) return `${A}焚毁${city}`;
  return `${A}破${city},夷为平地`;
}

/** 毁城的重要度:大城(或做国都的城)被毁 3,城 2,村镇 1 */
function ruinImportance(civ: Civ, e: Annal): Importance {
  const rank = rankBefore(civ, e.settlement, e.year);
  return rank >= 3 || (rank >= 2 && besieged(civ, e).capital) ? 3 : rank >= 2 ? 2 : 1;
}

/** 洗劫:"大渭洗劫汾城";折损五成五以上写"纵兵大掠",七成以上再加"十室九空" */
function sackText(civ: Civ, e: Annal): string {
  const A = pn(civ, e.a, e.year);
  const { city } = besieged(civ, e);
  const s = e.settlement >= 0 ? civ.settlements[e.settlement] : undefined;
  const loss = s?.sacks?.find((k) => !k.cause && k.year === e.year)?.loss ?? 0;
  if (loss >= 0.7) return `${A}纵兵大掠${city},十室九空`;
  if (loss >= 0.55) return `${A}纵兵大掠${city}`;
  return `${A}洗劫${city}`;
}

/** 重建:"汾城重建"(荒废一百年以上写"荒废 230 年的汾城重建");换了民族另起新名:"汾城故址上筑起新城瑞城" */
function rebuildText(civ: Civ, e: Annal): string {
  const s = e.settlement >= 0 ? civ.settlements[e.settlement] : undefined;
  const city = cityName(civ, e.settlement) || '新城';
  const old = s?.rebuilds !== undefined ? civ.settlements[s.rebuilds] : undefined;
  if (!old) return `${city}建城`;
  const gap = old.ended !== undefined ? Math.floor(e.year) - Math.floor(old.ended) : 0;
  const again = gap >= 100 ? `荒废 ${gap} 年的${city}重建` : `${city}重建`;
  return old.name ? nameIf('same', old.name, s!.name, again, `${old.name}故址上筑起新城${city}`) : again;
}

/** 旧都衰落:"大昌旧都汾城渐衰";国家已经亡了(被并)的写"故都"(国名用亡国时的):"昌国故都汾城渐衰" */
function declineText(civ: Civ, e: Annal): string {
  const city = cityName(civ, e.settlement) || '旧都';
  const p = polityOf(civ, e.a);
  if (!p) return `旧都${city}渐衰`;
  if (p.ended !== undefined && p.ended <= e.year) return `${pn(civ, p.id, p.ended - 1 / 512)}故都${city}渐衰`;
  return `${pn(civ, p.id, e.year)}旧都${city}渐衰`;
}

/** 此刻(第 id 条史事之前)两国正在交战 */
function atWarBefore(civ: Civ, a: number, b: number, id: number): boolean {
  const open = new Set<number>();
  const A = civ.annals;
  for (let i = 0; i < id && i < A.length; i++) {
    const e = A[i];
    if (e.kind === 'war' && ((e.a === a && e.b === b) || (e.a === b && e.b === a))) open.add(e.war);
    else if (e.kind === 'peace') open.delete(e.war);
  }
  return open.size > 0;
}

/** 干预(阶段 4)的说法和结果:text = 编年史正文;ok = 生效了;why = 没生效的原因(短句,界面上的干预列表用) */
interface IvStory {
  text: string;
  ok: boolean;
  why?: string;
}

/** 干预(阶段 4):"【干预】大昌与索拉特结盟";没生效的写原因 */
/** 州键指不到州(改地形后那块地方成了水,或者格式不对) */
const NO_REGION = '这个世界没有这个州(改地形后那块地方可能成了水)';

function interveneStory(civ: Civ, e: Annal, id: number): IvStory {
  const v = civ.interventions?.[e.war];
  const y = e.year;
  const A = e.a >= 0 ? pn(civ, e.a, y) : '';
  const B = e.b >= 0 ? pn(civ, e.b, y) : '';
  const dead = (p: number) => {
    const q = polityOf(civ, p);
    return !!q && q.ended !== undefined && q.ended <= y;
  };
  // 照大纲硬改出来的(gen/edits.ts 文件头"大纲")标【照大纲】
  const tag = v?.plot !== undefined ? '【照大纲】' : '【干预】';
  // 记在作者人物名下的国家的事:后面写"(林小满之议)"
  const by = authorBy(civ, v);
  const fail = (text: string, why: string): IvStory => ({ text: `${tag}${text}${by}`, ok: false, why });
  const done = (text: string): IvStory => ({ text: `${tag}${text}${by}`, ok: true });
  /** 紧跟在这条干预后面(同一刻)的史事 */
  const next = (k = 1) => {
    const n = civ.annals[id + k];
    return n && n.year === y ? n : undefined;
  };
  if (!v) return done(A);
  const R = regionName(civ, e.region) || '其州';
  switch (v.kind) {
    case 'protect': {
      const until = v.until !== undefined ? `,至第 ${v.until} 年` : '';
      return dead(e.a) ? fail(`欲保${A}不亡,然${A}已亡`, `那一年${A}已亡`) : done(`${A}自此不亡${until}`);
    }
    case 'unity':
      return dead(e.a) ? fail(`欲令${A}四境无叛,然${A}已亡`, `那一年${A}已亡`) : done(`${A}自此四境无叛,再无州郡自立`);
    case 'keep': {
      const until = v.until !== undefined ? `,至第 ${v.until} 年` : '';
      return dead(e.a) ? fail(`欲保${A}宗社,然${A}已亡`, `那一年${A}已亡`) : done(`${A}自此宗社不移${until}`);
    }
    case 'halt': {
      if (dead(e.a)) return fail(`欲令${A}止戈,然${A}已亡`, `那一年${A}已亡`);
      const until = v.until !== undefined ? `,至第 ${v.until} 年` : '';
      const peace = next()?.kind === 'peace' && next()!.a === e.a ? ',所起之兵尽罢' : '';
      return done(`${A}自此止戈息兵,不再开疆拓土${until}${peace}`);
    }
    case 'ally': {
      const until = v.until !== undefined ? `,约至第 ${v.until} 年` : '';
      if (!B) return fail(`${A}欲与他国结盟,然其国不存`, '对方在新历史里没有(或那一年还没立国)');
      const gone = dead(e.a) ? A : dead(e.b) ? B : '';
      return gone ? fail(`${A}欲与${B}结盟,然${gone}已亡`, `那一年${gone}已亡`) : done(`${A}与${B}结盟${until}`);
    }
    case 'declare': {
      if (!B) return fail(`${A}欲伐他国,然其国不存`, '对方在新历史里没有(或那一年还没立国)');
      // 盟国、宗藩、同一宗主的藩属之间:宣战前先记了盟约断了(unally)/ 一方不再称臣(defect),战争记在它后面
      const cut = next();
      const tie =
        !!cut &&
        ((cut.kind === 'unally' && ((cut.a === e.a && cut.b === e.b) || (cut.a === e.b && cut.b === e.a))) ||
          (cut.kind === 'defect' && (cut.a === e.a || cut.a === e.b)));
      const n = tie ? next(2) : cut;
      if (n && n.kind === 'war' && n.a === e.a && n.b === e.b) return done(`${A}向${B}宣战${v.lead !== undefined ? leadTail(civ, v.lead, A, n.war, id + (tie ? 2 : 1)) : ''}`);
      if (dead(e.a)) return fail(`欲令${A}伐${B},然${A}已亡`, `那一年${A}已亡`);
      if (dead(e.b)) return fail(`${A}欲伐${B},然${B}已亡`, `那一年${B}已亡`);
      if (atWarBefore(civ, e.a, e.b, id)) return fail(`${A}欲伐${B},然两国已在交战`, '两国那时已在交战');
      return fail(`${A}欲伐${B},然两国不接壤,未能成行`, '两国那时不接壤');
    }
    case 'cede': {
      if (e.region < 0) return fail(`欲以某州划归${A},然无此州`, NO_REGION);
      if (e.b === -2) return fail(`欲以${R}划归${A},然其地无人居住`, `那一年${R}没人住`);
      if (dead(e.a)) return fail(`欲以${R}划归${A},然${A}已亡`, `那一年${A}已亡`);
      const forever = v.permanent ? `,永为${A}之土` : '';
      if (e.b === e.a) return done(`${R}本属${A}${v.permanent ? `,自此永为${A}之土` : ''}`);
      return done(`${R}${e.b >= 0 ? `自${B}` : ''}划归${A}${forever}`);
    }
    case 'found': {
      if (e.a < 0 && e.region < 0) return fail('欲于某州立国,然无此州', NO_REGION);
      if (e.a < 0) {
        // 住不了人的州(海边冰原、大片荒漠……)立不成;住得了人的没人住时会有新民族来落脚,只有那州沉了这类意外才立不成
        const seat = civ.regions.seat[e.region];
        if (seat !== undefined && civ.habitat.suitability[seat] < HABITABLE_SUIT) return fail(`欲于${R}立国,然其地不可居`, `${R}住不了人`);
        return fail(`欲于${R}立国,然其地无人居住`, `那一年${R}没人住`);
      }
      const city = cityName(civ, e.settlement);
      const built = civ.settlements[e.settlement]?.founded === y;
      const seat = city ? (built ? `,筑${city}为都` : `,都于${city}`) : '';
      // 州里本来没人住:备好的新民族这一刻来落脚(cultures.ts 的 pioneerArrives)
      const cu = civ.cultures[civ.polities[e.a]?.culture ?? -1];
      if (cu && cu.pioneer === e.war && cu.hearth === e.region && cu.born === y) return done(`${R}本无人居,${cu.name}人徙居于此,立国,号${A}${seat}`);
      return done(e.b >= 0 ? `${R}脱${B}自立,号${A}${seat}` : `${R}立国,号${A}${seat}`);
    }
    case 'crown': {
      const who = authorName(civ, v.char);
      if (e.b === -3) return fail(`欲立${who}为${A}之主,然${A}已亡`, `那一年${A}已亡`);
      if (e.b === -2) return fail(`欲立${who}为${A}之主,然其人尚未出生`, `${heOrShe(authorSex(civ, v.char))}第 ${v.born} 年才出生`);
      // 等在位的那位下台再即位:登记的这一条(真即位另记一条 b = −1,interventionOutcome 先找它)
      if (e.b === IV_WAIT) return waitStory(civ, e, who, A, fail, done);
      // 同一刻后面又给这国立了作者的人物(哪怕是同一个人):后立的顶替先立的(rulers.ts),先立的那条算没即位
      for (let k = id + 1; k < civ.annals.length && civ.annals[k].year === y; k++) {
        const n = civ.annals[k];
        if (n.kind === 'intervene' && n.a === e.a && n.b === -1 && civ.interventions?.[n.war]?.kind === 'crown') return fail(`欲立${who}为${A}之主,然同时又另立他人`, '同一年又给这国立了别的人物');
      }
      return done(`${who}即${A}君位${v.keep ? ',在位期间保住王室' : ''}`);
    }
    case 'policy': {
      if (e.b === -3) return fail(`欲定${A}方针,然${A}已亡`, `那一年${A}已亡`);
      if (emptyPolicy(v)) return done(`${A}罢方针,凡事听君主`);
      return done(`${A}${hadPolicy(civ, e, id) ? '改定' : '定'}方针${policyTail(civ, v, y)}`);
    }
    case 'destroy': {
      if (e.b === -3) return fail(`欲灭${A},然${A}已亡`, `那一年${A}已亡`);
      if (e.b === IV_PROTECTED) return fail(`欲灭${A},然又有令保${A}不亡`, `那一年${A}受后下的「保护」护着`);
      const n = e.n ? `${cnNumber(e.n)}州` : '其地';
      return done(e.b >= 0 ? `${A}亡,${n}并入${B}` : `${A}亡,${n}散为无主之地`);
    }
    case 'death':
    case 'temper':
      return personStory(civ, e, v, A, fail, done);
    case 'regent':
      return regentStory(civ, e, id, v, A, fail, done);
    case 'appoint':
      return appointStory(civ, e, id, v, A, fail, done);
    case 'marry':
      return marryStory(civ, e, v, A, fail, done);
    case 'disaster':
      return disasterStory(civ, e, v, A, R, fail, done);
    case 'trek':
    case 'stay':
      return trekStory(civ, e, v, next()?.kind === 'trek' ? next() : undefined, fail, done);
    case 'move': {
      const city = cityName(civ, e.settlement);
      if (!city) return fail(`${A}欲迁都,然其城尚未建起`, '那一年还没有这座城');
      if (dead(e.a)) return fail(`欲令${A}迁都${city},然${A}已亡`, `那一年${A}已亡`);
      if (e.b === -2) return fail(`${A}欲迁都${city},然${city}已毁`, `那一年${city}已毁`);
      if (e.b !== e.a) {
        return e.b >= 0
          ? fail(`${A}欲迁都${city},然${city}属${B}`, `${city}那时属${B},不在本国国土里`)
          : fail(`${A}欲迁都${city},然${city}不在${A}境内`, `${city}那时不在本国国土里`);
      }
      const n = next();
      if (!(n && n.kind === 'capital' && n.a === e.a && n.war < 0)) return done(`${city}本为${A}国都`);
      const p = polityOf(civ, e.a);
      const old = p ? cityName(civ, capitalBefore(p, y)) : '';
      return done(`${A}${old && old !== city ? `自${old}` : ''}迁都${city}`);
    }
    case 'treaty':
    case 'neutral':
      return decreeStory(civ, e, id, v, A, R, fail, done);
    case 'boost':
      return boostStory(civ, e, v, A, R, fail, done);
    case 'story': {
      // DM 故事事件:正文就是作者写的短标题和叙事;真实效果(sack / capacity / dev)只落在引擎状态上,编年史不逐条列
      const head = v.title || A || '故事';
      return done(v.text ? `${head},${v.text}` : head);
    }
    case 'petty': {
      // 小事件裁决层:dev 委托推发展 / sack 记折损。b = -1 是委托 boost 记的(生效),b > 0 是 sack 生效,
      // b = 0 是没生效(城 / 州指不到)。把折损写进正文,别让小事件只剩一个国名
      if (v.effect.type === 'dev') return done(`${A}百业日兴`);
      const city = cityName(civ, e.settlement);
      const where = city || R;
      const loss = ['轻', '中', '重'][v.effect.loss - 1] ?? '';
      return e.b > 0 ? done(`${where}遭${loss}折损`) : fail(`欲令${where}遭折损,然其地无城`, '那一刻没有这座城');
    }
    case 'intel': {
      // 渗透他国:只记一笔(谁派人探谁的底),不改引擎数值
      return B ? done(`${A}遣人探${B}虚实`) : fail(`${A}欲探他国,然其国不存`, '对方在新历史里没有(或那一年还没立国)');
    }
    default:
      return done(A);
  }
}

/**
 * 推一把发展:"【干预】大澜王朝励精图治,百业日新,至第 1550 年""【干预】青月坞一带九州百业日新,至第 1550 年"(快几倍);
 * "【干预】大澜王朝变法图强,诸州一时并进"(直接进;之后照常记的"始入铁器时代"另有一条);没生效的写原因
 */
function boostStory(civ: Civ, e: Annal, v: Extract<Intervention, { kind: 'boost' }>, A: string, R: string, fail: Say, done: Done): IvStory {
  const jump = v.mul === undefined;
  if (e.b === -3) return fail(`欲令${A}${jump ? '变法图强' : '励精图治'},然${A}已亡`, `那一年${A}已亡`);
  if (e.b === IV_TOP_ERA) {
    const top = ERAS[ERAS.length - 1];
    return fail(`欲令${A}更进一步,然${A}已在${top}时代`, `${A}已在${top}时代,没有下一个了`);
  }
  const n = Math.floor((e.n ?? 0) / BOOST_N);
  const place = cityName(civ, e.settlement) || R;
  const where = n > 1 ? `${place}一带${cnNumber(n)}州` : place;
  if (jump) return done(v.regions ? `${where}变法图强,一时并进` : `${A}变法图强,诸州一时并进`);
  const until = v.until !== undefined ? `,至第 ${v.until} 年` : '';
  return done(v.regions ? `${where}百业日新${until}` : `${A}励精图治,百业日新${until}`);
}

type Say = (text: string, why: string) => IvStory;

/**
 * 作者下令立约 / 划中立地(干预 treaty、neutral):"【干预】渭国与大羽王朝、后乾衍国立约""【干预】渭国与大羽王朝以星河域为中立地";
 * 没生效的写原因(对方不在了、不肯、那州划不成)。生效了的,编年史那一条另把并进来的约、中立地写全(decreeText)
 */
function decreeStory(
  civ: Civ,
  e: Annal,
  id: number,
  v: Extract<Intervention, { kind: 'treaty' | 'neutral' }>,
  A: string,
  R: string,
  fail: Say,
  done: Done,
): IvStory {
  const y = e.year;
  const what = v.kind === 'treaty' ? '立约' : '划中立地';
  if (e.b === -3) return fail(`欲令${A}${what},然${A}已亡`, `那一年${A}已亡`);
  if (e.b === -2) return fail(`${A}欲以某州为中立地,然无此州`, NO_REGION);
  // 对方:按国家键在这份历史里找(那一年还在的写名字)
  const names = v.ps
    .map((k) => {
      const r = resolveKey(civ, k);
      return r && r.kind === 'polity' ? pn(civ, r.id, y) : '';
    })
    .filter(Boolean);
  const them = names.join('、') || '他国';
  if (e.b === IV_NOBODY) return fail(`${A}欲与他国${what},然其国不存`, '对方在新历史里没有(或那一年已亡、还没立国)');
  if (e.b === IV_REFUSED) return fail(`${A}欲与${them}${what},${them}不肯`, '对方不肯');
  if (e.b === IV_NO_ZONE) return fail(`${A}欲以${R}为中立地,然其地划不成`, `那一年${R}划不成中立地(没人住、已是中立地、是国都,或不属共建的几国)`);
  const got = decreeParts(civ, id).map((k) => civ.annals[k]);
  const ps = (got[0]?.ps ?? []).filter((p) => p !== e.a).map((p) => pn(civ, p, y));
  if (v.kind === 'treaty') return done(`${A}与${ps.join('、') || them}立约`);
  const z = got.find((n) => n.kind === 'neutral');
  return done(`${A}与${ps.join('、') || them}以${z ? regionName(civ, z.region) : R}为中立地`);
}

/**
 * 作者下令立约 / 划中立地生效了的那一条:并进来的约、中立地照它们自己的说法写全 ——
 * "【干预】渭国与大羽王朝、后乾衍国会于丹枫关,立约互不侵犯,各守今疆,以三十年为期;拉文海姆王国居间;
 * 渭国、大羽王朝、后乾衍国以星河域为中立地,渭国让出丹枫关,三国皆不驻兵";演一国时下的,不肯的写"某国不肯"
 */
function decreeEntry(ctx: Ctx, e: Annal, id: number, v: Extract<Intervention, { kind: 'treaty' | 'neutral' }>): ChronicleEntry {
  const { civ } = ctx;
  const y = e.year;
  const tag = v.plot !== undefined ? '【照大纲】' : '【干预】';
  const parts = decreeParts(civ, id);
  const subs = parts.map((k) => treatyEntry(ctx, [k]));
  const ps = new Set<number>([e.a]);
  const regions: number[] = [];
  for (const k of parts) {
    const n = civ.annals[k];
    for (const p of n.ps ?? []) ps.add(p);
    if (n.kind === 'neutral' && n.region >= 0) regions.push(n.region);
  }
  const no: string[] = [];
  if (v.ask)
    for (const k of v.ps) {
      const r = resolveKey(civ, k);
      if (r && r.kind === 'polity' && !ps.has(r.id)) no.push(pn(civ, r.id, y));
    }
  const text = `${tag}${subs.map((s) => s.text).join(';')}${no.length ? `;${no.join('、')}不肯` : ''}${authorBy(civ, v)}`;
  const out = base(e, id, text, 3, [...ps], regions.length ? regions : e.region >= 0 ? [e.region] : []);
  const people = [...new Set(subs.flatMap((s) => s.people ?? []))];
  if (people.length) out.people = people;
  return out;
}

/** 第 id 条史事(作者下令立约 / 划中立地的 intervene)紧跟着记的约、中立地(cause = decree;同一刻、挨着记的;史事下标) */
function decreeParts(civ: Civ, id: number): number[] {
  const A = civ.annals;
  const out: number[] = [];
  for (let k = id + 1; k < A.length && A[k].year === A[id].year && (A[k].kind === 'treaty' || A[k].kind === 'neutral') && A[k].cause === 'decree'; k++) out.push(k);
  return out;
}

/** 作者下令立的约、划的中立地(cause = decree):并进紧挨在前面的那条干预(编年史不另列) */
function foldedIntoDecree(civ: Civ, i: number): boolean {
  const A = civ.annals;
  let j = i - 1;
  while (j >= 0 && A[j].year === A[i].year && (A[j].kind === 'treaty' || A[j].kind === 'neutral') && A[j].cause === 'decree') j--;
  const d = A[j];
  const k = d && d.kind === 'intervene' && d.year === A[i].year ? civ.interventions?.[d.war]?.kind : undefined;
  return k === 'treaty' || k === 'neutral';
}
type Done = (text: string) => IvStory;

/** 作者让他去世 / 改过倾向的那个人(人物里按 killed、moods 记着第几条干预) */
function personOfIv(civ: Civ, iv: number, kind: 'death' | 'temper'): Person | undefined {
  return civ.people?.find((x) => (kind === 'death' ? x.killed === iv : x.moods?.some((m) => m.iv === iv)));
}

/** 被作者让他去世的君主"卒"怎么写:"暴崩""暴薨""暴卒""猝然驾崩"(同君主继位那一条的崩 / 薨 / 卒 / 驾崩) */
function suddenDeath(civ: Civ, x: Person, y: Year): string {
  const p = polityOf(civ, x.polity);
  if (!p) return '暴卒';
  const [died] = deathWord(p, Math.max(0, polityTierAt(p, y - 1 / 512)));
  return died.length > 1 ? `猝然${died}` : `暴${died}`;
}

/** 改过的倾向里变得最多的那一样(差 10 以上):",自此厌兵"",自此好开边"……;都没怎么变 = 空串 */
function temperWord(from: Person['leanings'], to: NonNullable<Person['leanings']>): string {
  if (!from) return '';
  const words = { war: ['厌兵', '喜兵'], expand: ['安于守土', '好开边'], trade: ['轻商贾', '重商贾'], develop: ['怠于政事', '勤于政事'] } as const;
  let best: keyof typeof words | null = null;
  let most = 9;
  for (const k of ['war', 'expand', 'trade', 'develop'] as const) {
    const d = Math.abs(to[k] - from[k]);
    if (d > most) {
      most = d;
      best = k;
    }
  }
  return best ? `,自此${words[best][to[best] > from[best] ? 1 : 0]}` : '';
}

/**
 * 让人物去世 / 改君主倾向:"【干预】大澜皇帝燕溟暴崩,在位十一年""【干预】大澜将燕鸾澈卒""【干预】有桑丞相鸿丘卒"
 * "【干预】大澜皇帝燕溟性情大变,自此厌兵";没生效的写原因
 */
function personStory(civ: Civ, e: Annal, v: Extract<Intervention, { kind: 'death' | 'temper' }>, A: string, fail: Say, done: Done): IvStory {
  const y = e.year;
  const die = v.kind === 'death';
  const verb = die ? '令其卒' : '改其性情';
  const want = parsePersonKey(v.person)?.name || '其人';
  if (e.b === -3) return fail(`欲${verb},然${A}已亡`, `那一年${A}已亡`);
  const x = personOfIv(civ, e.war, v.kind);
  if (x && (e.b === -1 || e.b === IV_PEOPLE)) {
    if (!die) return done(`${rulerRef(civ, x, y)}性情大变${temperWord(x.leanings, v.leanings)}`);
    if (x.role === 'ruler') {
      const years = Math.floor(y) - Math.floor(x.from ?? y);
      return done(`${rulerRef(civ, x, y)}${suddenDeath(civ, x, y)}${years >= 1 ? `,在位${cnNumber(years)}年` : ',即位当年'}`);
    }
    return done(`${x.role === 'general' ? generalRef(civ, x, y) : `${ministerRole(civ, x)}${x.name}`}卒`);
  }
  // 没生效:按人物键找回这个人,说他那时在不在
  const id = resolvePersonKey(civ, v.person);
  const who = id >= 0 ? civ.people![id] : undefined;
  if (!who) return fail(`欲${verb}于${want},然新史无此人`, '新历史里没有这个人');
  const he = heOrShe(who);
  if (who.died !== undefined && who.died <= y) return fail(`欲${verb}于${who.name},然其人已卒`, `第 ${Math.floor(who.died)} 年${he}已卒`);
  if (who.role === 'ruler' || e.b === IV_NOT_HIM) {
    if ((who.from ?? Infinity) > y) return fail(`欲${verb}于${who.name},然其人尚未即位`, who.from !== undefined ? `${he}第 ${Math.floor(who.from)} 年才即位` : `${he}没有即位`);
    if (who.until !== undefined && who.until <= y) return fail(`欲${verb}于${who.name},然其人已不在位`, `第 ${Math.floor(who.until)} 年${he}已不在位`);
    return fail(`欲${verb}于${who.name},然其时在位者非其人`, `那一年在位的不是${he}`);
  }
  const from = who.role === 'general' ? who.commands?.[0]?.from : who.from;
  const step = who.role === 'general' ? '领兵' : '入仕';
  if (who.role === 'minister' && who.until !== undefined && who.until <= y) return fail(`欲${verb}于${who.name},然其人已去职`, `第 ${Math.floor(who.until)} 年${he}已去职`);
  if (from === undefined || from >= y) return fail(`欲${verb}于${who.name},然其人尚未出仕`, from !== undefined ? `${he}第 ${Math.floor(from)} 年才${step}` : `${he}那时还没${step}`);
  return fail(`欲${verb}于${who.name},未成`, '没有生效');
}

/**
 * 让他掌权:"【干预】令彭继桓掌大承国政"(掌权的经过紧跟着那一条 regent 写);没生效的写原因
 * (这国已亡、共和国 / 作者立的君主、已有人掌着权、他不是太子 / 叔伯 / 不在世;作者的人物:还没出生、已去世、不满 16 岁)
 */
function regentStory(civ: Civ, e: Annal, id: number, v: Extract<Intervention, { kind: 'regent' }>, A: string, fail: Say, done: Done): IvStory {
  const holder = civ.people?.find((x) => x.regencies?.some((g) => g.annal === id + 1));
  const want = holder?.name || (v.char !== undefined ? authorName(civ, v.char) : parsePersonKey(v.person)?.name) || '其人';
  const verb = `欲令${want}掌${A}国政`;
  if (e.b === -3) return fail(`${verb},然${A}已亡`, `那一年${A}已亡`);
  if (v.char !== undefined && e.b !== -1) {
    // 作者的人物:先看他自己,再看这国(同 regency.ts 查的先后)
    const he = heOrShe(holder ?? authorSex(civ, v.char));
    if (e.b === -2) return fail(`${verb},然其人尚未出生`, `${he}第 ${v.born} 年才出生`);
    if (e.b === IV_GONE) return fail(`${verb},然其人已卒`, `第 ${v.died ?? Math.floor(e.year)} 年${he}已去世`);
    if (e.b === IV_NOT_HIM) return fail(`${verb},然其人尚幼`, `${he}那一年不满 16 岁`);
  }
  if (e.b === IV_NO_THRONE) return fail(`${verb},然${A}无君可架空`, `${A}那一年是共和国,或在位的是作者立的君主`);
  if (e.b === IV_HELD) return fail(`${verb},然其时已有人秉政`, '那一年已经有人掌着实权');
  if (e.b !== -1) {
    const he = heOrShe(holder ?? (v.char !== undefined ? authorSex(civ, v.char) : civ.people?.[resolvePersonKey(civ, v.person)]));
    const why =
      v.how === 'march' || v.how === 'heir'
        ? `${he}那一年不是在位君主的预定继承人(或不满 16 岁)`
        : v.how === 'uncle'
          ? `${he}那一年不是君主的兄弟叔伯,或已不在世、不满 16 岁`
          : `${he}那一年不满 16 岁`;
    return fail(`${verb},未成`, why);
  }
  return done(`令${want}掌${A}国政`);
}

/**
 * 任将 / 任臣:"【干预】以林小满为大定将""【干预】以林小满为大定侍郎";从本国将领任上入朝的"【干预】大定将林小满入朝为侍郎,副将司玄代领其军"。
 * 没生效的写原因(先看他自己,再看这国;同 interventions.ts 查的先后)。
 * 史事记着生效了、同一刻他又任了别的 / 又即了位的(appoint.ts 的 skip),这一条算没生效
 */
function appointStory(civ: Civ, e: Annal, id: number, v: Extract<Intervention, { kind: 'appoint' }>, A: string, fail: Say, done: Done): IvStory {
  const who = authorName(civ, v.char);
  const he = heOrShe(authorSex(civ, v.char));
  const general = v.role === 'general';
  const verb = general ? `欲拜${who}为${A}之将` : `欲令${who}入仕${A}`;
  if (e.b === -3) return fail(`${verb},然${A}已亡`, `那一年${A}已亡`);
  if (e.b === -2) return fail(`${verb},然其人尚未出生`, `${he}第 ${v.born} 年才出生`);
  if (e.b === IV_GONE) return fail(`${verb},然其人已卒`, `第 ${v.died ?? Math.floor(e.year)} 年${he}已去世`);
  if (e.b === IV_NOT_HIM) return fail(`${verb},然其人尚幼`, `${he}那一年不满 16 岁`);
  if (e.b === IV_REIGNING) return fail(`${verb},然${he}方为人君`, `${he}那一年正是在位的君主`);
  const skip = authorPostsFrom(civ).find((p) => p.annal === id)?.skip;
  if (skip === 'replaced') return fail(`${verb},然同时又另有任命`, `同一年又给${he}任了别的`);
  if (skip === 'crowned') return fail(`${verb},然同时${he}即位`, `同一年${he}又即了位`);
  if (general) return done(`以${who}为${A}将`);
  // 名臣:写入朝拜的官;刚从本国将领任上下来的写"大定将林小满入朝为侍郎",手上那场仗由推演原来派的那位接着领
  const y = e.year;
  const { me, was, deputy } = appointPeople(civ, e, v);
  const title = me?.posts?.[0]?.title ?? '';
  if (!was) return done(`以${who}为${A}${title || '臣'}`);
  return done(`${generalRef(civ, was, y)}入朝${title ? `为${title}` : ''}${deputy ? `,副将${leaderName(civ, deputy, y)}代领其军` : ''}`);
}

/**
 * 任将任臣那一条写到的人:me = 这一任的他(作者的人物);was = 刚卸任的本国将领那一任(从将领任上入朝的;没有 = null);
 * deputy = 他手上那场仗接着领兵的推演将领(副将;没有 = null)
 */
function appointPeople(civ: Civ, e: Annal, v: Extract<Intervention, { kind: 'appoint' }>): { me: Person | null; was: Person | null; deputy: Person | null } {
  const y = e.year;
  const mine = (civ.people ?? []).filter((x) => x.author === v.char && x.polity === e.a);
  const me = mine.find((x) => x.role === v.role && x.from === y) ?? null;
  const was = v.role === 'minister' ? (mine.find((x) => x.role === 'general' && x.until === y) ?? null) : null;
  const c = was?.commands?.at(-1);
  const ix = peopleOf(civ);
  const deputy =
    c && c.until === y
      ? (ix?.commands.get(c.war)?.find((m) => m.side === c.side && !authorGeneral(m.person) && (ix.annals[m.first]?.year ?? Infinity) <= y && m.until >= y && !reigningAt(m.person, y))?.person ?? null)
      : null;
  return { me, was, deputy };
}

/**
 * 宣战点了谁挂帅(declare 带 lead):",以林小满为帅";那一刻君主亲征 ",林小满随驾";他那时不是这国的将领(没任将、已卸任)
 * ";欲以林小满为帅,然其时他非大定之将"(仗照打,统帅照推演派)。war = 打起来的那场,i = 宣战那一条的位置
 */
function leadTail(civ: Civ, char: number, A: string, war: number, i: number): string {
  const ix = peopleOf(civ);
  const who = authorName(civ, char);
  const c = commander(ix, war, 0, i);
  if (c?.author === char) return `,以${who}为帅`;
  if (escortOf(ix, war, 0, i)?.author === char) return `,${who}随驾`;
  return `;欲以${who}为帅,然其时${heOrShe(authorSex(civ, char))}非${A}之将`;
}

/** 为他联姻:"【干预】令胡炜与大澜王朝结亲"(结亲的经过紧跟着那一条 marry 写);没生效的写原因 */
function marryStory(civ: Civ, e: Annal, v: Extract<Intervention, { kind: 'marry' }>, A: string, fail: Say, done: Done): IvStory {
  const y = e.year;
  const want = parsePersonKey(v.person)?.name || '其人';
  const k = resolveKey(civ, v.b);
  const B = e.b >= 0 ? pn(civ, e.b, y) : k?.kind === 'polity' && civ.polities[k.id] ? pn(civ, k.id, y) : '他国';
  const verb = `欲为${want}与${B}结亲`;
  // 没生效的原因编号、嫁女的君主至少几岁:按这个世界的那套数
  const { IV_NO_PARTNER, IV_AT_WAR, IV_NO_BRIDE, IV_NO_GROOM, BRIDE_FATHER } = knobsOf(civ).get(MARRIAGES_KNOBS);
  switch (e.b) {
    case -3:
      return fail(`欲为${want}结亲,然${A}已亡`, `那一年${A}已亡`);
    case IV_NO_PARTNER:
      return fail(`${verb},然其国不存`, '对方那一年没有或已亡');
    case IV_NO_THRONE:
      return fail(`${verb},然无王室可结亲`, '两国有一国是共和国,没有王室');
    case IV_AT_WAR:
      return fail(`${verb},然两国方交兵`, '两国那一年正在交战');
    case IV_NOT_HIM:
      return fail(`${verb},然其人非宗室`, `${heOrShe(civ.people?.[resolvePersonKey(civ, v.person)])}那一年不是在位的君主,也不是在世、成年的宗室`);
    case IV_NO_BRIDE:
      return fail(`${verb},然无女可嫁`, `嫁女那一国的君主那一年不到 ${BRIDE_FATHER} 岁,没有成年的女儿`);
    case IV_NO_GROOM:
      return fail(`${verb},然${B}无人可娶`, `${B}那一年没有能娶亲的宗室`);
  }
  return done(`令${want}与${B}结亲`);
}

/** 即位(等在位的那位下台)登记的那一条:还在等 = 照登记写;落空(没等到他下台就改朝换代、亡国、另立了别人)= 写原因 */
function waitStory(civ: Civ, e: Annal, who: string, A: string, fail: Say, done: Done): IvStory {
  const y = e.year;
  const cur = civ.people?.find((x) => x.role === 'ruler' && x.polity === e.a && (x.from ?? Infinity) <= y && (x.until === undefined || x.until > y));
  const curName = cur ? rulerShort(civ, cur) : '在位之君';
  if (!cur || cur.until === undefined) return done(`${who}待${curName}之后即${A}君位`);
  const p = polityOf(civ, e.a);
  if (p?.ended !== undefined && p.ended <= cur.until) return fail(`欲立${who}继${curName}为${A}之主,然${A}已亡`, `那一年${A}已亡`);
  const how = cur.fate === 'deposed' || cur.fate === 'overthrown' ? '被废(改朝换代)' : cur.fate === 'yielded' ? '让位' : '下台';
  return fail(`欲立${who}继${curName}为${A}之主,然${curName}${how},未及即位`, `${curName} ${Math.floor(cur.until)} 年${how},没等到${heOrShe(cur)}下台`);
}

/**
 * 大迁徙:"【干预】克拉尔族一支举族西徙,往瑶渊之野"(经过、结局另有大迁徙那一条大事);走不成的"欲令克拉尔族徙往瑶渊之野,然陆路不通"。
 * 不许迁:"【干预】克拉尔族自此安居故土,不复远徙,至第 2100 年"。民族在 Annal.n;动身紧跟着记 trek n = 0(go)
 */
function trekStory(civ: Civ, e: Annal, v: Extract<Intervention, { kind: 'trek' | 'stay' }>, go: Annal | undefined, fail: Say, done: Done): IvStory {
  const F = e.n !== undefined && e.n >= 0 ? cn(civ, e.n) : '其族';
  if (v.kind === 'stay') {
    if (e.b === -3) return fail(`欲令${F}安居故土,然${F}已不在`, `那一年${F}已消亡`);
    const until = v.until !== undefined ? `,至第 ${v.until} 年` : '';
    return done(`${F}自此安居故土,不复远徙${until}`);
  }
  const to = v.to !== undefined ? regionName(civ, regionOfKey(v.to, keyCells(civ.regions))) : '';
  if (e.b === -3) return fail(`欲令${F}远徙,然${F}已不在`, `那一年${F}已消亡`);
  if (e.b === IV_NO_WAY) {
    if (to) return fail(`欲令${F}徙往${to},然陆路不通`, `陆路走不到${to}`);
    if (v.dir) {
      const d = TREK_DIR_NAMES[v.dir];
      return fail(`欲令${F}${d}徙,然${d}向无地可往`, `往${d}走得到的地方里没有能去的(有城、不是本族的州)`);
    }
    return fail(`欲令${F}远徙,然无地可往`, '走得到的地方里没有能去的(有城、不是本族的州)');
  }
  const M = go ? civ.migrations?.[go.war] : undefined;
  const dest = regionName(civ, e.region) || to;
  return done(`${F}一支举族${M ? `${M.dir}徙` : '远徙'}${dest ? `,往${dest}` : ''}`);
}

/** 天灾:"【干预】星邑大疫,死者十之五""【干预】有桑皇朝大饥,民多饿死,死者十之三""【干预】翼门之野一带地震,城郭多圮,死者十之三" */
function disasterStory(civ: Civ, e: Annal, v: Extract<Intervention, { kind: 'disaster' }>, A: string, R: string, fail: Say, done: Done): IvStory {
  const toll = IV_TOLL[v.level];
  if (v.type === 'pandemic') {
    // 全球大疫:传到哪、死多少另有一条(pandemicEntries)
    const city = cityName(civ, e.settlement) || R;
    if (e.b <= 0) return fail(`欲令${city}起大疫,然其城已不在`, `那一年${city}已毁`);
    return done(`${A}${city}起大疫,疫后无人收拾${cnNumber(v.slump ?? SLUMP_DEFAULT)}年`);
  }
  if (v.type === 'plague') {
    const city = cityName(civ, e.settlement) || R;
    if (e.b <= 0) return fail(`欲降疫于${city},然其城已不在`, `那一年${city}已毁`);
    if (e.b === 2) return done(`${city}疫势转烈,死者${toll}`);
    return done(`${A}${city}大疫,死者${toll}`);
  }
  if (v.type === 'famine') {
    if (e.b <= 0) return v.a && A ? fail(`欲令${A}大饥,然${A}已亡`, `那一年${A}已亡`) : fail('欲降饥荒,然其地无人居住', '那一带那年没人住');
    if (v.a) return done(`${A}大饥,民多饿死,死者${toll}`);
    const where = e.b > 1 ? `${R}等${cnNumber(e.b)}州` : R;
    return done(`${where}大饥,民多饿死,死者${toll}`);
  }
  const word = e.region >= 0 ? quakeWord(civ.regions, e.region) : '地震';
  const what = word === '大水' ? '大水,漂没城郭' : word === '大旱' ? '大旱,赤地千里' : '地震,城郭多圮';
  if (e.b <= 0) return fail(`欲令${R}一带${word},然其地无人居住`, '那一带那年没人住');
  return done(`${R}一带${what}${e.b > 1 ? `,${cnNumber(e.b)}州受灾` : ''},死者${toll}`);
}

/** 这条方针之前这国已经照着别的方针(生效了、不是罢方针的):编年史写"改定方针" */
function hadPolicy(civ: Civ, e: Annal, id: number): boolean {
  for (let k = id - 1; k >= 0; k--) {
    const n = civ.annals[k];
    if (n.kind !== 'intervene' || n.a !== e.a || n.b !== -1) continue;
    const v = civ.interventions?.[n.war];
    if (v?.kind === 'policy') return !emptyPolicy(v);
  }
  return false;
}

/** 方针在编年史里的后半句:":扩张(细调过),仇莱尼多尔王国,亲温兹汗国"(没定名字、只挑了亲仇的不写名字;旋钮的数不写) */
function policyTail(civ: Civ, v: PolicyIv, y: Year): string {
  const name = policyName(v);
  const who = (keys: readonly string[] | undefined) =>
    (keys ?? [])
      .map((k) => {
        const r = resolveKey(civ, k);
        return r?.kind === 'polity' ? pn(civ, r.id, y) : '';
      })
      .filter(Boolean)
      .join('、');
  const parts = [name, who(v.foes) && `仇${who(v.foes)}`, who(v.friends) && `亲${who(v.friends)}`].filter(Boolean);
  return parts.length ? `:${parts.join(',')}` : '';
}

/**
 * 作者的人物叫什么:套过人物卡的历史(gen/characters.ts 的 applyCharacters)里有名字(Civ.authorNames,或他即位后的人物);
 * 没套过 = "作者的人物"
 */
export function authorName(civ: Civ, char: number): string {
  return civ.authorNames?.[char] || civ.people?.find((x) => x.author === char && x.name)?.name || '作者的人物';
}

/** 国家的事记在作者人物名下(干预带 author):"(林小满之议)";没带 = '' */
function authorBy(civ: Civ, v: Intervention | undefined): string {
  return v?.author !== undefined ? `(${authorName(civ, v.author)}之议)` : '';
}

/** 作者的人物是男是女:套过人物卡的历史里记着(Civ.authorFemale);没套过 = 男 */
function authorSex(civ: Civ, char: number): Sexed {
  return civ.authorFemale?.includes(char) ? { female: true } : null;
}

/** 干预"即位"立的那位君主(作者的人物;第 e 条史事那一刻在国家 e.a 即位的) */
function crownedAt(ix: PeopleIndex | null, e: Annal, char: number): Person | null {
  // 前一位被作者让他去世、等着的作者人物接位的:即位那一刻的下一刻才记史事
  return ix?.rulers[e.a]?.find((x) => x.author === char && x.from !== undefined && e.year - x.from >= 0 && e.year - x.from <= 1 / 256) ?? null;
}

/** 第 i 条史事是照大纲硬改的划州、生效了:同一条情节、同一刻、划给同一国的并成一条用的键(不是 = '') */
function plotCedeKey(civ: Civ, i: number): string {
  const e = civ.annals[i];
  if (!e || e.kind !== 'intervene') return '';
  const v = civ.interventions?.[e.war];
  if (v?.kind !== 'cede' || v.plot === undefined || !interveneStory(civ, e, i).ok) return '';
  return `${v.plot}|${e.a}|${e.year}`;
}

/** 从第 i 条起接连几条照大纲划给同一国的州(第 i 条不是 = []) */
function plotCedeRun(civ: Civ, i: number): number[] {
  const k = plotCedeKey(civ, i);
  if (!k) return [];
  const out = [i];
  while (plotCedeKey(civ, out[out.length - 1] + 1) === k) out.push(out[out.length - 1] + 1);
  return out;
}

/**
 * 这条史事(立国的 found、迁都的 capital、灭国的 fall、天灾引起的饥荒 famine)是紧跟在干预后面、由它引起的:
 * 编年史并进干预那一条,不另列(天灾的饥荒一国一条,接连几条都算)
 */
function foldedIntoIntervene(civ: Civ, i: number): boolean {
  const e = civ.annals[i];
  let j = i - 1;
  if (e.kind === 'famine') while (j >= 0 && civ.annals[j].kind === 'famine' && civ.annals[j].year === e.year) j--;
  const d = civ.annals[j];
  if (!d || d.kind !== 'intervene' || d.year !== e.year) return false;
  const v = civ.interventions?.[d.war];
  if (e.kind === 'famine') return v?.kind === 'disaster' && v.type !== 'plague';
  if (d.a !== e.a) return false;
  const kind = v?.kind;
  return (e.kind === 'found' && kind === 'found') || (e.kind === 'capital' && e.war < 0 && kind === 'move') || (e.kind === 'fall' && kind === 'destroy');
}

/**
 * 第 i 条干预(Civ.interventions 的下标)在这份历史里的结果(界面上的干预列表用):
 * annal = 它那条史事 intervene 的下标(没记 = −1:国家键指不到,原因由调用方按键说);ok = 生效了;why = 没生效的原因
 */
export function interventionOutcome(civ: Civ, i: number): { annal: number; ok: boolean; why?: string } {
  const A = civ.annals;
  for (let k = 0; k < A.length; k++) {
    if (A[k].kind !== 'intervene' || A[k].war !== i) continue;
    // 等在位的那位下台再即位:真即位了看即位那一条(同一条干预后记的 b = −1)
    if (A[k].b === IV_WAIT) {
      for (let j = k + 1; j < A.length; j++) if (A[j].kind === 'intervene' && A[j].war === i && A[j].b === -1) return { annal: j, ok: true };
    }
    const r = interveneStory(civ, A[k], k);
    return { annal: k, ok: r.ok, why: r.why };
  }
  return { annal: -1, ok: false };
}

/**
 * 宣战:"大渭起兵伐昌国"(援盟:"索拉特应大昌之约,起兵伐某国");有人物的写双方统帅:
 * "大渭以李牧为将,起兵伐昌国;昌国遣王翦拒之" / "大渭太宗亲征昌国;昌庄王亲自领兵拒之"
 */
/**
 * 战争那一条的开头(写开战的由头):"大渭欲复故土,伐昌国""大渭乘昌国与索拉特交兵,伐之""大渭欲并昌国,举兵伐之"
 * "大渭与昌国争边,起兵伐之""大渭背盟伐昌国""大渭兴兵讨昌国"(讨伐自立的藩属)"大渭应大昌之约伐昌国""大渭救其藩属瑞国,伐昌国";
 * 开战看内政(woeText):"大渭国中多事,欲以外战安内,伐昌国""大渭乘昌国瑞州守将拥兵自重,伐之""大渭府库空竭,欲掠昌国瑞州,起兵伐之";
 * 有统帅的写"遣李牧伐之""遣李牧讨昌国"。没记由头的(干预的强制宣战)写"大渭伐昌国"
 */
function warHead(civ: Civ, e: Annal, id: number, general: string): string {
  const y = e.year;
  const A = pn(civ, e.a, y);
  const B = pn(civ, e.b, y);
  const ally = e.settlement >= 0 ? pn(civ, e.settlement, y) : '';
  const go = (who: string) => (general ? `遣${general}伐${who}` : `伐${who}`);
  switch (e.cause) {
    case 'claim':
      return `${A}${claimText(civ, e, id)},${go(B)}`;
    case 'chaos': {
      const why = troubleOf(civ, e.b, id, e.a);
      return `${A}乘${B}${why || '之乱'},${go('之')}`;
    }
    case 'resource':
      return `${A}${covetText(civ, e)},${general ? `遣${general}伐之` : '起兵伐之'}`;
    case 'unrest':
    case 'plagued':
    case 'minor':
    case 'regent':
      return `${A}${woeText(civ, e)},${go('之')}`;
    case 'plunder':
      return `${A}${woeText(civ, e)},${general ? `遣${general}伐之` : '起兵伐之'}`;
    case 'divert':
      return `${A}${woeText(civ, e)},${go(B)}`;
    case 'prey':
      return `${A}欲并${B},${general ? `遣${general}伐之` : '举兵伐之'}`;
    case 'expand':
      return `${A}与${B}争边,${general ? `遣${general}伐之` : '起兵伐之'}`;
    case 'betray':
      return general ? `${A}背盟,遣${general}伐${B}` : `${A}背盟伐${B}`;
    case 'breach':
      return treatyWord(civ, breachOf(civ, e, id), (name) => `${A}背${name},${go(B)}`, `${A}背与${B}之约,${general ? `遣${general}伐之` : '举兵伐之'}`);
    case 'punish':
      return `${A}以${B}绝贡,${general ? `遣${general}讨之` : '兴兵讨之'}`;
    case 'quell':
    case 'heir':
      return general ? `${A}遣${general}讨${B}` : `${A}发兵讨${B}`;
    case 'trek':
      return general ? `${A}甫立,遣${general}伐${B}` : `${A}甫立,即伐${B}`;
    case 'rescue':
      return ally ? `${A}救其藩属${ally},${go(B)}` : `${A}${go(B)}`;
    default:
      if (ally) return general ? `${A}应${ally}之约,遣${general}伐${B}` : `${A}应${ally}之约伐${B}`;
      return general ? `${A}遣${general}伐${B}` : `${A}伐${B}`;
  }
}

/**
 * 宣战的由头(史事 war 的 cause),写在"起兵伐某国"前面:"欲复故土,""乘昌国与索拉特交兵,""欲并昌国,""与昌国争边,"
 * "背盟,""应大昌之约,""救其藩属昌国,";开战看内政的"国中多事,欲以外战安内,""乘昌国大疫之后,"等(见 woeText);
 * 讨伐自立的藩属不写由头,动词换成"讨"(见 warVerb)。干预的强制宣战、没记由头的 = 空串
 */
function warReason(civ: Civ, e: Annal, id: number): string {
  const y = e.year;
  const B = pn(civ, e.b, y);
  const ally = e.settlement >= 0 ? pn(civ, e.settlement, y) : '';
  switch (e.cause) {
    case 'claim':
      return `${claimText(civ, e, id)},`;
    case 'punish':
      return `以${pn(civ, e.b, e.year)}绝贡,`;
    case 'chaos': {
      const why = troubleOf(civ, e.b, id, e.a);
      return why ? `乘${B}${why},` : `乘${B}之乱,`;
    }
    case 'resource':
      return `${covetText(civ, e)},`;
    case 'divert':
    case 'unrest':
    case 'plagued':
    case 'minor':
    case 'regent':
    case 'plunder':
      return `${woeText(civ, e)},`;
    case 'prey':
      return `欲并${B},`;
    case 'expand':
      return `与${B}争边,`;
    case 'betray':
      return '背盟,';
    case 'breach':
      return treatyWord(civ, breachOf(civ, e, id), (name) => `背${name},`, '背约,');
    case 'rescue':
      return ally ? `救其藩属${ally},` : '';
    default:
      // 援盟(自然结成的盟约、阶段 4 干预的结盟):settlement 列是盟国,不是城
      return ally ? `应${ally}之约,` : '';
  }
}

/**
 * 史事数组的索引:"第 id 条史事之前"的几种查询(收复故土想夺回哪几州、某国此刻在和谁交战)不用每次从头翻一遍史事。
 * 从头翻的话,历史越长、要查的战争越多,两样一乘,几万年的历史要算好几秒。
 * 按史事数组记(套改名、沿用州出来的新对象共用同一个数组);数组长度变了就重建
 */
interface AnnalIndex {
  n: number;
  /** 有州的攻占(conquer):史事的 a(拿去的一方)→ b(丢掉的一方)→ 下标(从小到大) */
  conquer: Map<number, Map<number, number[]>>;
  /** 有州的攻占:下标 → 同一州下一次攻占的下标(没有 = Infinity) */
  nextConquer: Map<number, number>;
  /** 每国(含 −1)相关的开战、议和,按下标从小到大:[下标, 战争编号, 对手(议和 = NaN)] 三个一组 */
  wars: Map<number, number[]>;
}

const annalIndexCache = new WeakMap<readonly Annal[], AnnalIndex>();

function annalIndex(A: readonly Annal[]): AnnalIndex {
  const hit = annalIndexCache.get(A);
  if (hit && hit.n === A.length) return hit;
  const conquer = new Map<number, Map<number, number[]>>();
  const nextConquer = new Map<number, number>();
  const lastAt = new Map<number, number>();
  const wars = new Map<number, number[]>();
  /** 战争编号 → 打过这场仗的国(到这一条为止) */
  const sides = new Map<number, number[]>();
  const push = (p: number, i: number, war: number, foe: number) => {
    let l = wars.get(p);
    if (!l) wars.set(p, (l = []));
    l.push(i, war, foe);
  };
  for (let i = 0; i < A.length; i++) {
    const e = A[i];
    if (e.kind === 'conquer' && e.region >= 0) {
      let byB = conquer.get(e.a);
      if (!byB) conquer.set(e.a, (byB = new Map()));
      let l = byB.get(e.b);
      if (!l) byB.set(e.b, (l = []));
      l.push(i);
      const prev = lastAt.get(e.region);
      if (prev !== undefined) nextConquer.set(prev, i);
      nextConquer.set(i, Infinity);
      lastAt.set(e.region, i);
    } else if (e.kind === 'war') {
      push(e.a, i, e.war, e.b);
      if (e.b !== e.a) push(e.b, i, e.war, e.a);
      let s = sides.get(e.war);
      if (!s) sides.set(e.war, (s = []));
      if (!s.includes(e.a)) s.push(e.a);
      if (!s.includes(e.b)) s.push(e.b);
    } else if (e.kind === 'peace') {
      for (const p of sides.get(e.war) ?? []) push(p, i, e.war, NaN);
    }
  }
  const ix = { n: A.length, conquer, nextConquer, wars };
  annalIndexCache.set(A, ix);
  return ix;
}

/**
 * 收复故土的战争想夺回哪几州:开战前(第 id 条史事之前)最近一次易手是"守方从攻方手里拿去"的州
 * (攻占、议和割让都记成 conquer),开战那一年还在守方手里(后来分裂、被并、划走的不算),按人口上限从大到小。导出给测试核对索引
 */
export function claimsOf(civ: Civ, atk: number, def: number, id: number, year: Year): number[] {
  const A = civ.annals;
  const ix = annalIndex(A);
  const end = Math.min(id, A.length);
  const out: number[] = [];
  // 守方从攻方手里拿去的那几次里,是那一州在开战前最后一次易手的
  const list = ix.conquer.get(def)?.get(atk);
  if (list) {
    let own: Int16Array | null = null;
    for (const i of list) {
      if (i >= end) break;
      if (ix.nextConquer.get(i)! < end) continue;
      own ??= ownersAt(civ, year).polity;
      if (own[A[i].region] === def) out.push(A[i].region);
    }
  }
  const cap = civ.regions.capacity;
  return out.sort((a, b) => cap[b] - cap[a] || a - b);
}

/** 复仇之战:攻方上一次和守方交兵、在这么多年内议和,那一场净丢了州 */
const REVENGE_YEARS = 40;

/**
 * 攻方 atk 上一次和守方 def 交兵(第 id 条史事以前、REVENGE_YEARS 年内议和的那一场)净丢了州:那一场里丢给 def 的州;
 * 不是(没交过兵、太久以前、没吃亏)= null
 */
function lostLastWar(civ: Civ, atk: number, def: number, id: number, year: Year): Set<number> | null {
  const A = civ.annals;
  let p = -1;
  for (let j = Math.min(id, A.length) - 1; j >= 0 && A[j].year >= year - REVENGE_YEARS; j--) {
    const e = A[j];
    if (e.kind === 'peace' && ((e.a === atk && e.b === def) || (e.a === def && e.b === atk))) {
      p = j;
      break;
    }
  }
  if (p < 0) return null;
  const war = A[p].war;
  let net = 0;
  const lost = new Set<number>();
  for (let j = p - 1; j >= 0; j--) {
    const e = A[j];
    if (e.war !== war) continue;
    if (e.kind === 'war') break;
    if (e.kind !== 'conquer') continue;
    if (e.a === atk) net++;
    else if (e.b === atk) {
      net--;
      lost.add(e.region);
    }
  }
  return net < 0 ? lost : null;
}

/**
 * 收复故土:"欲夺回瑞州" / "欲复瑞州等故地";从史事里找不到是哪几州的写"欲复故土"。
 * 复仇之战(上一次交兵吃了亏,见 lostLastWar)换着写"欲雪瑞州之耻""欲报瑞州之役"(州挑那一场丢的、还在对方手里的)
 */
function claimText(civ: Civ, e: Annal, id: number): string {
  const rs = claimsOf(civ, e.a, e.b, id, e.year);
  const r = rs.length ? regionName(civ, rs[0]) : '';
  if (!r) return '欲复故土';
  const plain = rs.length === 1 ? `欲夺回${r}` : `欲复${r}等故地`;
  const lost = lostLastWar(civ, e.a, e.b, id, e.year);
  if (lost) {
    const v = (Math.imul(id + 1, 0x9e3779b1) >>> 0) % 3;
    // 州名里已经带"之"的("羊涂之野")不再叠一个"之",照常写
    const q = regionName(civ, rs.find((x) => lost.has(x)) ?? rs[0]);
    if (q && v < 2) return nameIf('has', q, '之', plain, v === 0 ? `欲雪${q}之耻` : `欲报${q}之役`);
  }
  return plain;
}

/** 宣战的动词:讨伐自立的藩属、起事的饥民写"讨",别的写"伐" */
const warVerb = (e: Annal) => (e.cause === 'punish' || e.cause === 'quell' || e.cause === 'heir' ? '讨' : '伐');

/** 由头里点了守方的名("以昌国绝贡,"、"乘昌国与索拉特交兵,"、"欲并昌国,"、"与昌国争边,"),后面写"伐之" */
const NAMES_FOE: ReadonlySet<AnnalCause> = new Set<AnnalCause>(['punish', 'chaos', 'prey', 'expand', 'resource', 'unrest', 'plagued', 'minor', 'regent', 'plunder']);

/**
 * 开战看内政的由头(wars.ts):转移矛盾"国中多事,欲以外战安内";乘内乱"乘昌国瑞州守将拥兵自重"(有割据,region 列 = 那州)/ "乘昌国内乱";
 * 疫后"乘昌国大疫之后";幼主"乘昌国主少国疑"(西幻"乘昌国幼主在位");权臣"乘昌国丞相某某专权"(人物里查不到 = "乘昌国权臣当国");
 * 掠夺"府库空竭,欲掠昌国瑞州"(region 列 = 边境上最富的那州;查不到 = "府库空竭,欲掠昌国之财")
 */
function woeText(civ: Civ, e: Annal): string {
  const y = e.year;
  const B = pn(civ, e.b, y);
  switch (e.cause) {
    case 'divert':
      return '国中多事,欲以外战安内';
    case 'unrest': {
      const r = regionName(civ, e.region);
      return r ? `乘${B}${r}${polityOf(civ, e.b)?.eastern ? '守将' : '领主'}拥兵自重` : `乘${B}内乱`;
    }
    case 'plagued':
      return `乘${B}大疫之后`;
    case 'minor':
      return classical(polityOf(civ, e.b)) ? `乘${B}主少国疑` : `乘${B}幼主在位`;
    case 'regent': {
      const s = holderAt(civ, e.b, y);
      return s && strongHeld(s.g) ? `乘${B}${holderRef(civ, s.x, s.g.kind, y)}专权` : `乘${B}权臣当国`;
    }
    case 'plunder': {
      const r = regionName(civ, e.region);
      return r ? `府库空竭,欲掠${B}${r}` : `府库空竭,欲掠${B}之财`;
    }
    default:
      return '';
  }
}

/** 为夺物产开战时写的字(下标同 development.ts 的 RESOURCES:粮、牲畜、铜锡、铁、煤、木材、盐、渔获、石油、稀有矿、金银),先后照这里 */
const COVET_WORD = ['粮', '马', '铜', '铁', '煤', '木', '盐', '渔', '油', '矿', '金'];
const COVET_ORDER = [6, 3, 2, 1, 4, 8, 9, 10, 0, 5, 7];

/** 为夺物产的由头:"欲夺昌国瑞州之铁""欲夺昌国瑞州之盐铁""欲夺昌国瑞州之铜与马";州名查不到写"欲得昌国之铁" */
function covetText(civ: Civ, e: Annal): string {
  const B = pn(civ, e.b, e.year);
  const ks = COVET_ORDER.filter((k) => (e.n ?? 0) & (1 << k));
  const what = ks.length === 2 && ks[0] === 6 && ks[1] === 3 ? '盐铁' : ks.length ? ks.map((k) => COVET_WORD[k]).join('与') : '地';
  const r = regionName(civ, e.region);
  return r ? `欲夺${B}${r}之${what}` : `欲得${B}之${what}`;
}

function declareEntry(ctx: Ctx, e: Annal, id: number): ChronicleEntry {
  const { civ, ix } = ctx;
  const y = e.year;
  const A = pn(civ, e.a, y);
  const B = pn(civ, e.b, y);
  // 援盟、救藩:settlement 列是援的那一国,不是城
  const ally = e.settlement >= 0 ? e.settlement : -1;
  const pact = warReason(civ, e, id);
  const v = warVerb(e);
  const ca = commander(ix, e.war, 0, id);
  const cd = commander(ix, e.war, 1, id);
  // 作者的将领挂帅:推演原来派的那位是副将;君主亲征:作者的将领随驾
  const [da, dd] = [deputyOf(ix, e.war, 0, id), deputyOf(ix, e.war, 1, id)];
  const [ea, ed] = [escortOf(ix, e.war, 0, id), escortOf(ix, e.war, 1, id)];
  const vice = (d: Person | null) => (d ? `、${leaderName(civ, d, y)}为副` : '');
  const escort = (x: Person | null) => (x ? `,${leaderName(civ, x, y)}随驾` : '');
  const to = e.cause && NAMES_FOE.has(e.cause) ? '之' : B;
  let t: string;
  if (ca && reigningAt(ca, y)) t = `${rulerRef(civ, ca, y)}${pact}亲征${to}${escort(ea)}`;
  else if (ca && authorGeneral(ca)) t = `${A}${pact}以${leaderName(civ, ca, y)}为将${vice(da)},起兵${v}${to}`;
  else if (ca) t = `${A}${pact}以${leaderName(civ, ca, y)}为将,起兵${v}${to}`;
  else t = `${A}${pact}起兵${v}${to}`;
  if (cd && reigningAt(cd, y)) t += `;${rulerRef(civ, cd, y)}亲自领兵拒之${escort(ed)}`;
  else if (cd && authorGeneral(cd)) t += `;${B}以${leaderName(civ, cd, y)}为将${vice(dd)}拒之`;
  else if (cd) t += `;${B}遣${leaderName(civ, cd, y)}拒之`;
  const x = base(e, id, t, 2, ally >= 0 ? [e.a, e.b, ally] : [e.a, e.b], []);
  if (ally >= 0) x.settlement = -1;
  return withPeople(x, ca, cd, da, dd, ea, ed);
}

function simpleEntry(ctx: Ctx, e: Annal, id: number): ChronicleEntry {
  const { civ } = ctx;
  const y = e.year;
  switch (e.kind) {
    case 'found': {
      const city = cityName(civ, e.settlement);
      const where = city || regionName(civ, e.region);
      // 大国立国是大事;后来没长成大国的(小国、部落)只在"全部"里
      const imp = isGreat(polityOf(civ, e.a)) ? 3 : 2;
      // 有人物的写开国之君:"李昭建大昌,都于汾城"
      const who = founderOf(ctx.ix, e.a, 0);
      let head = who?.rise === 'found' ? `${who.name}建${pn(civ, e.a, y)}` : `${pn(civ, e.a, y)}立国`;
      // 边缘立国:受邻近强国影响提早立的国("受大昌影响,李昭建平国")
      const mentor = e.b >= 0 && polityOf(civ, e.a)?.mentor === e.b ? e.b : -1;
      if (mentor >= 0) head = `受${pn(civ, mentor, y)}影响,${head}`;
      return withPeople(base(e, id, `${head}${where ? `,都于${where}` : ''}`, imp, mentor >= 0 ? [e.a, mentor] : [e.a], [e.region]), who?.rise === 'found' ? who : null);
    }
    case 'rank':
      return rankEntry(ctx, e, id);
    case 'war':
      return declareEntry(ctx, e, id);
    case 'conquer':
      return base(e, id, conquerText(civ, e, undefined, ctx.retake.has(id)), e.b >= 0 ? 2 : 1, [e.a, e.b], [e.region]);
    case 'peace': {
      const head = peaceHead(civ, ctx.ix, e, id, y);
      return withPeople(base(e, id, head.text, 2, [e.a, e.b], []), ...head.people);
    }
    case 'fall':
      // 民变被讨平:"大渭讨平瑞国"(标签"平")
      if (e.war >= 0 && ctx.quell.get(e.war) === e.a && e.b >= 0) return base(e, id, `${pn(civ, e.b, y)}讨平${pn(civ, e.a, y)}`, 2, [e.a, e.b], [e.region], '平');
      // 亡于战争的,"大事"里由那场战争说("…,昌国亡");不在战争里土崩瓦解的,大国是大事,小国、部落是小事
      const last = endedAt(ctx.ix, e.a, y);
      return withPeople(base(e, id, fallText(civ, e, last), e.war < 0 && isGreat(polityOf(civ, e.a)) ? 3 : 2, [e.a, e.b], [e.region]), last);
    case 'capital': {
      // 主动迁都(被迫迁都折进战争,见 warEntry):帝国级的是大事
      const p = polityOf(civ, e.a);
      const old = p ? cityName(civ, capitalBefore(p, y)) : '';
      const now = cityName(civ, e.settlement) || regionName(civ, e.region);
      const text = now
        ? `${pn(civ, e.a, y)}${old && old !== now ? `自${old}` : ''}迁都${now}`
        : `${pn(civ, e.a, y)}迁都`;
      return base(e, id, text, p && polityTierAt(p, y) >= CAPITAL_TIER ? 3 : 2, [e.a], [e.region]);
    }
    case 'reform':
      return reformEntry(ctx, e, id);
    case 'split': {
      // 革命据地自立
      if (e.cause === 'revolution') return revolutionSplitEntry(ctx, e, id);
      const A = pn(civ, e.a, y);
      const r = regionName(civ, e.region);
      const P = polityOf(civ, e.a);
      const fallen = polityOf(civ, P?.restores ?? -1);
      // 有人物的写起事的人:叛离自立的守将(西幻:领主)、复国的故国宗室(西幻:王室之后;故国是共和国的:旧臣)
      const lead = founderOf(ctx.ix, e.a, 0);
      const who = lead && (lead.rise === 'rebel' || lead.rise === 'restore') ? lead : null;
      let t: string;
      const X = e.cause === 'heir' && who?.claim?.how === 'secede' ? civ.people?.[who.claim.rivals[0]] : undefined;
      if (e.cause === 'heir') {
        // 宗室争位、据地自立:"大昌先君之子李昭不服其弟李恒即位,据瑞州起兵自立,号昭国"(先君的儿子没对上的:"大昌宗室李昭不服新君李恒即位,…")
        const kin = who && X && who.parent !== undefined ? kinOf(civ, who, X) : '';
        const head = who ? `${pn(civ, e.b, y)}${who.parent !== undefined ? `先君之${childWord(who)}` : '宗室'}${who.name}` : `${pn(civ, e.b, y)}宗室`;
        const rival = X ? `${kin ? `其${kin}` : '新君'}${X.name}` : '新君';
        t = `${head}不服${rival}即位,${r ? `据${r}` : ''}起兵自立,号${A}`;
      } else if (fallen) {
        // 复国:"故昌遗民据瑞州起兵,脱大渭复国,号后昌国"("故昌宗室李昭据瑞州起兵,…")
        // 故国改朝换代过的,称它亡国时那一朝的国号("故景遗民")
        const folk = who ? `${fallen.lineage === 'republic' ? '旧臣' : P?.eastern ? '宗室' : '王室之后'}${who.name}` : '遗民';
        // 故国末代之君出奔了邻国、那国还在、亡国以后不太久:起事的人写"自那国还"("故昌宗室李昭自大渭还,据瑞州起兵,…")
        const host = who ? exiledTo(civ, fallen.id, y) : -1;
        const back = host >= 0 && host !== e.b ? `自${pn(civ, host, y)}还,` : '';
        const head = `故${(fallen.name && polityRootAt(fallen, fallen.ended ?? y)) || '国'}${folk}${back}${r ? `据${r}` : ''}`;
        t = e.b >= 0 ? `${head}起兵,脱${pn(civ, e.b, y)}复国,号${A}` : `${head}复国,号${A}`;
      } else {
        // "瑞州守将李昭叛大渭自立,号瑞国";割据多年以后自立的(control.ts):"割据瑞州的守将李昭叛大渭自立"
        const title = P?.eastern ? '守将' : '领主';
        const lord =
          e.cause === 'warlord' && r ? `割据${r}的${title}${who?.name ?? ''}` : who && r ? `${r}${title}${who.name}` : r;
        if (e.b >= 0) t = r ? `${lord}叛${pn(civ, e.b, y)}自立,号${A}` : `${A}脱离${pn(civ, e.b, y)}自立`;
        else t = r ? `${lord}自立,号${A}` : `${A}自立`;
      }
      const city = cityName(civ, e.settlement);
      if (city) t += `,都于${city}`;
      // 分出来(复国)以后长成大国的、复的是大国的是大事;小国分分合合只在"全部"里
      // (日后在"大事"里出现时,名字后面带一句来历,见 introduce)
      const imp = isGreat(polityOf(civ, e.a)) ? 3 : 2;
      return withPeople(base(e, id, t, imp, [e.a, e.b], [e.region], fallen ? '复' : '分'), r || fallen || e.cause === 'heir' ? who : null, X ?? null);
    }
    case 'famine':
      return base(e, id, famineText(civ, e), 2, [e.a], [e.region]);
    case 'warlord':
    case 'reclaim':
    case 'defy':
      return base(e, id, lordText(civ, e), 2, e.kind === 'defy' ? [e.a, e.b] : [e.a], [e.region]);
    case 'fiscal': {
      const foes = foesAt(civ, e.a, y);
      // 说法里点了名的交战国才算这条也和它有关
      return base(e, id, fiscalText(civ, e, foes), 2, e.war !== 0 && foes.length ? [e.a, foes[0]] : [e.a], [e.region]);
    }
    case 'council': {
      // 大国办成的改制是大事;搁置、谈崩(后面紧跟着割据、自立那一条)和小国的只在"全部"里。
      // 第二批里只有脱离转投(国土易手)算大事;改军制、改官制、分镇只在"全部"里(大国一个种子十来次,放进大事时间轴就挤了)
      const who = reigning(ctx.ix, e.a, y);
      const imp = e.n === 0 && (e.war <= 4 || e.war === 10) && isGreat(polityOf(civ, e.a)) ? 3 : 2;
      // 改制的议题办成了(立宪、废君立共和、还政):单列一种(立宪、改制,蓝色)
      if (e.n === 0 && (e.war === Issue.Charter || e.war === Issue.Abolish || e.war === Issue.Return)) return reformDoneEntry(ctx, e, id);
      let t = councilText(civ, e, id, who, ctx.ix);
      // 搁置的几种写法不写君主
      const named = who && (t.includes(who.name) || (!!who.title && t.includes(rulerTitle(civ, who))));
      // 作者的名臣这时在朝(任臣、掌权的作者人物):"…,丞相林小满与议"(西幻"参与其议")
      const court = (ctx.ix?.court.get(e.a) ?? []).filter((x) => (x.from ?? Infinity) <= y && (x.until === undefined || x.until > y));
      if (court.length) t += `,${court.map((x) => ministerRef(x, y)).join('、')}${classical(polityOf(civ, e.a)) ? '与议' : '参与其议'}`;
      // 脱离:b = 想转投的邻国
      return withPeople(base(e, id, t, imp, e.b >= 0 ? [e.a, e.b] : [e.a], [e.region]), named ? who : null, ...court);
    }
    case 'merge': {
      // 并掉的是大国才是大事
      // 藩属纳土归附宗主(diplomacy.ts)
      const t = e.b < 0 ? `${pn(civ, e.a, y)}并吞邻邦` : e.cause === 'vassal' ? `${pn(civ, e.b, y)}纳土归附${pn(civ, e.a, y)}` : `${pn(civ, e.b, y)}并入${pn(civ, e.a, y)}`;
      return base(e, id, t, isGreat(polityOf(civ, e.b)) ? 3 : 2, [e.a, e.b], []);
    }
    case 'dynasty': {
      // 东方帝国级的国家改朝换代(换国号,地图上的国名跟着变)是大事;西幻的王室更迭国名不变,小一些的国家的也不算
      // (换了的国号日后在"大事"里出现时带一句"原某国",见 introduce)
      const p = polityOf(civ, e.a);
      // 掌实权的名臣、大臣篡位(紧挨在前面的那条 regent,n = 3):写成篡位,是大事
      const pre = civ.annals[id - 1];
      const usurped = !!pre && pre.kind === 'regent' && pre.n === RG_USURP && pre.a === e.a && pre.year === e.year;
      const imp = p && p.eastern && polityTierAt(p, y) >= DYNASTY_TIER ? 3 : 2;
      const i = p ? Math.max(1, dynastyIndexAt(p, y)) : 1;
      const text = dynastyText(civ, e, ctx.ix, usurped);
      // 末代只在权臣篡位时写到("废少帝自立")
      const old = endedAt(ctx.ix, e.a, y);
      const ousted = !!old && /废(幼主|黜)?/.test(text) && (text.includes(old.name) || (!!old.title && text.includes(`废${rulerTitle(civ, old)}`)));
      // 掌实权的人篡位开的这一朝:标签"篡"(类型名"篡位")
      return withPeople(base(e, id, text, imp, [e.a], [e.region], usurped ? '篡' : '朝'), ousted ? old : null, founderOf(ctx.ix, e.a, i));
    }
    case 'sack':
      return base(e, id, sackText(civ, e), 2, [e.a, e.b], [e.region]);
    case 'ruin': {
      // 大城(或国都)被毁是大事,"大事"里由那场战争说("…,毁汾城",和亡国一样不重复);城被毁在"全部"里;村镇被毁是小事
      const imp = ruinImportance(civ, e);
      return base(e, id, ruinText(civ, e), e.war >= 0 ? (Math.min(imp, 2) as Importance) : imp, [e.a, e.b], [e.region]);
    }
    case 'rebuild': {
      const old = civ.settlements[e.settlement]?.rebuilds;
      const imp = old !== undefined && civ.settlements[old]?.ended !== undefined && rankBefore(civ, old, civ.settlements[old].ended!) >= 2 ? 2 : 1;
      return base(e, id, rebuildText(civ, e), imp, [e.a], [e.region]);
    }
    case 'decline':
      return base(e, id, declineText(civ, e), 2, [e.a], [e.region]);
    case 'vanish': {
      // 民族消亡:"乌耐族亡,最后的瑞州亦为渭人"
      const r = regionName(civ, e.region);
      const t = e.b >= 0 && r ? `${cn(civ, e.a)}亡,最后的${r}亦为${folk(civ, e.b)}` : `${cn(civ, e.a)}亡`;
      return { ...base(e, id, t, 3, [], [e.region]), settlement: -1 };
    }
    case 'diverge': {
      // 民族分化:"居兰族的一支在瑞州一带渐成一族,称北居兰族" / "大昌治下的居兰人与本族日渐疏远,自成北居兰族"
      const r = regionName(civ, e.region);
      const t =
        e.war >= 0
          ? `${pn(civ, e.war, y)}治下的${folk(civ, e.b)}与本族日渐疏远,自成${cn(civ, e.a)}`
          : `${cn(civ, e.b)}的一支${r ? `在${r}一带` : ''}渐成一族,称${cn(civ, e.a)}`;
      return { ...base(e, id, t, 2, e.war >= 0 ? [e.war] : [], [e.region]), settlement: -1 };
    }
    case 'assimilate':
      return assimChild(civ, e, id);
    case 'migrate':
      return migrateChild(civ, e, id, false);
    case 'upheaval':
      return upheavalEntry(ctx, [id]);
    case 'sunk':
      return base(e, id, sunkText(civ, e, true), 2, [e.a], [e.region]);
    case 'alliance':
    case 'unally':
    case 'submit':
    case 'defect':
      return diplomacyEntry(ctx, e, id);
    case 'treaty':
    case 'breach':
    case 'expire':
    case 'neutral':
    case 'exile':
      return treatyEntry(ctx, [id]);
    case 'intervene': {
      // 照大纲同一刻划给同一国的几州:并成一条
      const run = plotCedeRun(civ, id);
      if (run.length > 1) {
        const rs = run.map((j) => civ.annals[j].region);
        return base(e, id, `【照大纲】${regionNames(civ, rs)}划归${pn(civ, e.a, y)}`, 3, [e.a, ...run.map((j) => civ.annals[j].b)], rs);
      }
      const story = interveneStory(civ, e, id);
      const v0 = civ.interventions?.[e.war];
      // 作者下令立约 / 划中立地生效了:并进来的约、中立地照它们自己的说法写全
      if (story.ok && (v0?.kind === 'treaty' || v0?.kind === 'neutral')) return decreeEntry(ctx, e, id, v0);
      const x = base(e, id, story.text, 3, [e.a, e.b], [e.region]);
      // 干预立的国:立国那条并进了这一条,开国之君也写在这里
      const v = civ.interventions?.[e.war];
      const who = story.ok && v?.kind === 'found' && e.a >= 0 ? founderOf(ctx.ix, e.a, 0) : null;
      // 同一刻接着立了作者的人物为君的,开国之君就是他(写在即位那一条)
      if (who && who.author === undefined) x.text += `,奉${who.name}为主`;
      // 即位:记上作者立的那位君主
      const crowned = story.ok && v?.kind === 'crown' ? crownedAt(ctx.ix, e, v.char) : null;
      // 任将任臣:记上这一任的他(编年史里点他的名字开作者的人物卡)、代领其军的副将
      const ap = story.ok && v?.kind === 'appoint' ? appointPeople(civ, e, v) : null;
      return withPeople(x, who && who.author === undefined ? who : null, crowned, ap?.me, ap?.deputy);
    }
    case 'regent':
      return regentEntry(ctx, id) ?? base(e, id, `${pn(civ, e.a, y)}权臣秉政`, 1, [e.a], [e.region]);
    case 'marry':
      return marryEntry(ctx, id);
    default:
      return base(e, id, `${pn(civ, e.a, y)}有事`, 1, [e.a], []);
  }
}

// ---------------------------------------------------------------------------
// 邦交(diplomacy.ts):结盟、盟约断了、称臣、藩属自立

/** 第 id 条史事之前,a、b 最近一次结盟的那一条(没有 = undefined) */
function pactBefore(civ: Civ, a: number, b: number, id: number): Annal | undefined {
  for (let i = Math.min(id, civ.annals.length) - 1; i >= 0; i--) {
    const e = civ.annals[i];
    if (e.kind === 'alliance' && ((e.a === a && e.b === b) || (e.a === b && e.b === a))) return e;
  }
  return undefined;
}

/** 第 id 条史事之前,p 最近一次称臣的那一条(没有 = undefined) */
function submitBefore(civ: Civ, p: number, id: number): Annal | undefined {
  for (let i = Math.min(id, civ.annals.length) - 1; i >= 0; i--) {
    const e = civ.annals[i];
    if (e.kind === 'submit' && e.a === p) return e;
  }
  return undefined;
}

/** 两国中较弱的一方当年的国号档位(邦交大事看两国是不是都有分量) */
function minTier(civ: Civ, a: number, b: number, y: Year): number {
  const A = polityOf(civ, a);
  const B = polityOf(civ, b);
  return A && B ? Math.min(polityTierAt(A, y), polityTierAt(B, y)) : -1;
}

/**
 * 第 id 条史事之前,p 打过的仗里还没议和的那几场的对手,按开战先后(同一场仗又记了一次开战的,对手换成后来那个、次序不变)。
 * 只翻这国相关的开战、议和(annalIndex)。导出给测试核对索引
 */
export function openFoes(civ: Civ, p: number, id: number): number[] {
  const open = new Map<number, number>();
  const list = annalIndex(civ.annals).wars.get(p) ?? [];
  for (let k = 0; k < list.length && list[k] < id; k += 3) {
    if (Number.isNaN(list[k + 2])) open.delete(list[k + 1]);
    else open.set(list[k + 1], list[k + 2]);
  }
  return [...open.values()];
}

/** 某国此刻(第 id 条史事之前)的乱象:"与索拉特交兵" / "易代之乱" / "新失国都";没有 = 空串 */
function troubleOf(civ: Civ, p: number, id: number, except = -1): string {
  const A = civ.annals;
  const y = id < A.length ? A[id].year : civ.endYear;
  const foes = openFoes(civ, p, id).filter((q) => q !== except);
  if (foes.length) return `与${pn(civ, foes[foes.length - 1], y)}交兵`;
  const P = polityOf(civ, p);
  const d = P?.dynasties;
  if (d && d.length > 1 && d.some((x, i) => i > 0 && x.year <= y && y - x.year < 30)) return '易代之乱';
  const c = P?.capitals;
  if (c && c.some((x, i) => i > 0 && x.year <= y && y - x.year < 30)) return '新迁国都';
  return '';
}

/** 太子的叫法(东方按国号档位:帝国太子、王国世子、国公子,女的皇太女、王太女、公女;西幻王储) */
function heirOf(p: Polity | null, y: Year, x: Person): string {
  if (!classical(p)) return '王储';
  return heirWord(x, polityTierAt(p!, y));
}

/** 掌实权的人怎么称呼:太子 / 世子某某、叔父(叔祖……)某某、丞相某某(带当年的官职;没有官职的写"权臣某某");N = 名义君主 */
function holderRef(civ: Civ, x: Person, kind: PersonRegency['kind'], y: Year, N?: Person): string {
  const p = polityOf(civ, x.polity);
  const east = classical(p);
  if (kind === 'march' || kind === 'heir') return `${heirOf(p, y, x)}${x.name}`;
  // 临朝的太后:"太后江晚萦""皇太后维斯佩丽娜"
  if (kind === 'dowager') return `${dowagerWordOf(civ, x, y)}${x.name}`;
  if (kind === 'uncle') {
    if (!east) return `摄政${x.name}`;
    // 兄终弟及时幼主和先君同辈:"其兄某某"
    const kin = (N && kinOf(civ, N, x)) || kinWord(x, '叔父');
    return `${kin.length === 1 ? '其' : ''}${kin}${x.name}`;
  }
  return x.posts?.length ? ministerRef(x, y) : `${east ? '权臣' : '权臣'}${x.name}`;
}

/**
 * 掌实权(史事 regent,regents.ts;n:0 掌权、1 还政、2 伏诛、3 篡位、4 卒),标签"权":
 *   引兵入朝 "大承太子彭继桓自前线引兵还朝,杀其兄彭晖曦,尽易宫中宿卫;怀王虽在位,政出于彭继桓"(大事);
 *   太子监国 "大承怀王老病,太子彭继桓监国";
 *   大臣专权 "大承国势衰微,丞相某某总揽朝政;自是政出于某某,怀王拱手而已"(大事);
 *   大将专权 "大承大将军某某屡破南定,威震朝野;自是政出于某某,怀王拱手而已"(大事);
 *   还政 "南漓懿公胡炜年十八,丞相孙嵩曜还政";伏诛 "南漓懿公胡炜亲政,以谋逆诛丞相孙嵩曜";
 *   叔父篡位 "南漓摄政胡某废幼主胡炜,自立为君"(大事);卒 "丞相孙嵩曜卒,懿公胡炜始亲政"。
 * 宗室摄政、名臣辅政的掌权写在幼主即位那一条里(reignEntries),名臣、大臣篡位写在改朝换代那一条里(dynastyText):这里不另列(null)。
 * 西幻同样意思换说法("王储""摄政""大权已归某某")
 */
function regentEntry(ctx: Ctx, i: number): ChronicleEntry | null {
  const { civ } = ctx;
  const e = civ.annals[i];
  const hit = ctx.ix?.power.get(i);
  const x = hit?.x;
  const g = hit?.g;
  /** 推演里定的那一种(大将专权没有合适的将领、由大臣顶上的,人物上记成大臣专权) */
  const why = REGENCY_KINDS[e.b] ?? 'chancellor';
  const kind = g?.kind ?? why;
  const n = e.n ?? RG_START;
  // 作者下令"让他掌权"来的(掌权那一条 foe 列记着第几条干预):摄政不在幼主即位那一条里,这里写;太子到期篡位也在这里写
  const byIv = (n === RG_START ? e : g ? civ.annals[g.annal] : undefined)?.foe !== undefined;
  if (n === RG_START && (kind === 'uncle' || kind === 'minister' || kind === 'dowager') && !byIv) return null;
  if (n === RG_USURP && kind !== 'uncle' && !(byIv && (kind === 'march' || kind === 'heir'))) return null;
  const y = e.year;
  // 名义君主:掌权那一刻在位的那位;大臣、大将专权跨了几位君主的,了结那一条写那时在位的
  const strong = kind === 'chancellor' || kind === 'general';
  const N = (n !== RG_START && strong ? reigning(ctx.ix, e.a, y) : null) ?? (g ? civ.people?.[g.ruler] : undefined);
  const p = polityOf(civ, e.a);
  const east = classical(p);
  const P = pn(civ, e.a, y);
  const ruler = N ? rulerRef(civ, N, y) : P;
  const bare = N ? rulerBare(civ, N, y) : east ? '国君' : '国王';
  const who = x && g ? holderRef(civ, x, g.kind, y, N) : '权臣';
  const name = x?.name ?? '';
  let text = '';
  let imp: Importance = 2;
  // 大事:帝国(CAPITAL_TIER)的引兵入朝、大臣大将专权,王国以上(DYNASTY_TIER)的叔父篡位;小一些的国家只在"全部"里
  const tier = p ? polityTierAt(p, y) : 0;
  const rivals: Person[] = [];
  if (n === RG_START) {
    if (kind === 'march') {
      if (tier >= CAPITAL_TIER) imp = 3;
      // 杀掉的兄弟(人物里排的,royals.ts 的 march)
      if (x?.claim?.how === 'march') for (const id of x.claim.rivals) if (civ.people?.[id]) rivals.push(civ.people[id]);
      const kins = rivals.map((r, k) => `${k ? '' : '其'}${(x && kinOf(civ, x, r)) || kinWord(r, '兄')}${r.name}`).join('、');
      const front = !!x?.commands?.some((c) => c.from < y && c.until >= y - 20);
      text = east
        ? `${P}${who}${front ? '自前线' : ''}引兵还朝,${kins ? `杀${kins},` : ''}尽易宫中宿卫;${bare}虽在位,政出于${name}`
        : `${P}${who}${front ? '自前线' : ''}率军回到都城,${kins ? `处死${kins.replace(/^其/, '')},` : ''}撤换王宫卫队;${bare}虽仍在位,大权已归${name}`;
      // 那时还在外领兵的兄弟:粮饷为他所制(推演里那场仗本国国力打折,regents.ts 的 MARCH_SUPPLY)
      const sibs = x && x.parent !== undefined ? (ctx.ix?.kids.get(x.parent) ?? []) : [];
      const away = sibs.find((o) => o !== x && o.role === 'prince' && !rivals.includes(o) && o.commands?.some((c) => c.from <= y && c.until > y));
      if (away) {
        rivals.push(away);
        text += east ? `;其${kinOf(civ, x!, away) || kinWord(away, '弟')}${away.name}在外领兵,粮饷为${name}所制,无功而还` : `;${away.name}在外领兵,粮饷被${name}卡住,无功而返`;
      }
    } else if (kind === 'heir') {
      // 作者下令的监国不一定是先君老病
      if (byIv) text = east ? `${ruler}命${who}监国` : `${ruler}命${who}代为理政`;
      else text = east ? `${ruler}老病,${who}监国` : `${ruler}年老多病,${who}代为理政`;
    }
    else if (kind === 'general') {
      if (tier >= CAPITAL_TIER) imp = 3;
      // 屡破的是他最近一次领兵打的那一国
      const c = x?.commands?.filter((v) => v.from < y).pop();
      const w = c ? civ.annals[c.first] : undefined;
      const foe = w && c ? (c.side === 0 ? w.b : w.a) : -1;
      const beat = foe >= 0 ? pn(civ, foe, y) : '强敌';
      text = east ? `${P}${who}屡破${beat},威震朝野;自是政出于${name},${bare}拱手而已` : `${P}${who}屡败${beat},威名远播,从此独揽大权,${bare}形同虚设`;
    } else if (kind === 'uncle') {
      // 作者下令的摄政(推演里自己出的写在幼主即位那一条)
      text = east ? `${P}${bare}在位,${who}摄政;自是政出于${name}` : `${P}${who}摄政,${bare}虽仍在位,大权已归${name}`;
    } else {
      if (tier >= CAPITAL_TIER) imp = 3;
      // 这些年战败失地、丢了国都(推演里大臣专权的由头);接连开疆却没有合适的将领(大将专权由大臣顶上);作者下令的不写由头
      const lead = byIv ? '' : why === 'general' ? (east ? '连年开疆,' : '连年征战,') : '国势衰微,';
      text = east ? `${P}${lead}${who}总揽朝政;自是政出于${name},${bare}拱手而已` : `${P}${lead}${who}独揽朝政,${bare}形同虚设`;
    }
  } else if (n === RG_RETURN) {
    const age = N ? ageAt(N, y) : 18;
    // 幼主成年还政;作者下令掌权的太子、大臣大将到期还政于君主
    if (kind === 'uncle' || kind === 'minister' || kind === 'dowager') text = east ? `${ruler}年${cnNumber(age)},${who}还政` : `${ruler}年满 ${age} 岁,${who}交还大权`;
    else text = east ? `${P}${who}还政于${bare}` : `${P}${who}将大权交还${bare}`;
  } else if (n === RG_PURGE) {
    const child = kind === 'uncle' || kind === 'minister';
    // 太后被亲政的幼主废黜、幽禁至死
    if (kind === 'dowager') text = east ? `${ruler}亲政,废${who},幽死` : `${ruler}亲政,废黜${who},将她幽禁至死`;
    else text = child
      ? east
        ? `${ruler}亲政,以谋逆诛${who}`
        : `${ruler}亲政,以谋逆罪处死${who}`
      : east
        ? `${ruler}密谋诛${who},收其权柄`
        : `${ruler}设计处死${who},收回大权`;
  } else if (n === RG_USURP) {
    if (tier >= DYNASTY_TIER) imp = 3;
    if (kind === 'march' || kind === 'heir') {
      // 作者下令掌权的太子到期篡位:逼父亲退位,自己接着在位
      text = east ? `${P}${who}逼${bare}退位,自立为君` : `${P}${who}逼${bare}退位,自立为${bySex(x, '王', '女王')}`;
    } else {
      // 废的是幼主(推演里自己出的都是);作者下令摄政的,君主已成年的写他的称呼
      const young = !N ? '幼主' : byIv && ageAt(N, y) >= 18 ? bare : `幼主${N.name}`;
      text = east ? `${P}摄政${name}废${young},自立为君` : `${P}摄政${name}废黜${young},自立为${bySex(x, '王', '女王')}`;
    }
  } else if (n === RG_DIED) text = east ? `${P}${kind === 'uncle' ? `摄政${name}` : who}卒,${bare}始亲政` : `${P}${kind === 'uncle' ? `摄政${name}` : who}去世,${bare}开始亲政`;
  else return null;
  return withPeople(base(e, i, text, imp, [e.a], [e.region], REGENT_TAG[n] ?? '权'), x, N, ...rivals);
}

/**
 * 保住王室挡下的一回(史事 keep,dynasty.ts、regency.ts),标签"保"(类型名"王朝"),只在"全部"里,历史照旧:
 *   豪强起兵 "大澜王朝国势危殆,中漠豪强谋起兵代燕氏,未成"(本朝君主没有姓的写"代之";西幻 "卢纳维亚帝国瓦莱拉斯家族谋夺王位,未成");
 *   国都权臣篡位 "大澜王朝权臣谋篡,事泄伏诛"(西幻 "…权臣图谋篡位,事泄被处死");
 *   掌实权的人篡位(ids[1] = 紧跟着的那条结局):"大澜王朝丞相某某谋篡,事泄伏诛" / 叔父 "大澜王朝叔父某某谋废幼主某某,未成,遂还政"。
 * 国势危殆 = 那时动荡(n = 1)
 */
function keepEntry(ctx: Ctx, ids: number[]): ChronicleEntry {
  const { civ } = ctx;
  const e = civ.annals[ids[0]];
  const y = e.year;
  const p = polityOf(civ, e.a);
  const east = !!p?.eastern;
  const A = pn(civ, e.a, y);
  const dire = e.n === 1 ? (east ? '国势危殆,' : '国势危急,') : '';
  const N = reigning(ctx.ix, e.a, y);
  const people: (Person | null | undefined)[] = [];
  let text: string;
  if (e.b === KEEP_REGENT) {
    const j = ids[1];
    const hit = j !== undefined ? ctx.ix?.power.get(j) : undefined;
    const who = hit ? holderRef(civ, hit.x, hit.g.kind, y, N ?? undefined) : east ? '权臣' : '权臣';
    people.push(hit?.x, N);
    if (j !== undefined && civ.annals[j].n === RG_RETURN) {
      // 叔父废幼主;作者下令掌权的太子、引兵入朝的王子到期要篡位的写"谋夺君位"
      const young = REGENCY_KINDS[civ.annals[j].b] === 'uncle' ? (N ? `幼主${N.name}` : '幼主') : '';
      text = young
        ? east
          ? `${A}${who}谋废${young},未成,遂还政`
          : `${A}${who}图谋废黜${young},未成,交还大权`
        : east
          ? `${A}${who}谋夺君位,未成,遂还政`
          : `${A}${who}图谋夺位,未成,交还大权`;
    } else text = east ? `${A}${who}谋篡,事泄伏诛` : `${A}${who}图谋篡位,事泄被处死`;
  } else if (e.b === KEEP_COURT) {
    text = east ? `${A}${dire}权臣谋篡,事泄伏诛` : `${A}${dire}权臣图谋篡位,事泄被处死`;
  } else if (east) {
    const r = regionName(civ, e.region);
    // 本朝的姓:中式起名的国家、君主是中式名字(作者的人物也可能起别的名字)
    const surnamed = !!p && !!N && personNamers(civ.seed)(civ.cultures[p.culture]?.style || 'kingdom').surnamed;
    const house = surnamed ? nameIf('han', N!.name, '', `${splitSurname(N!.name)}氏`, '之') : '之';
    text = `${A}${dire}${r}豪强谋起兵代${house},未成`;
  } else {
    const city = cityName(civ, e.settlement);
    const r = regionName(civ, e.region);
    const who = city ? `${city}家族` : r ? `${r}领主` : '一方豪族';
    text = `${A}${dire}${who}谋夺${p?.lineage === 'khanate' ? '汗位' : '王位'},未成`;
  }
  return withPeople(base(e, ids[0], text, 2, [e.a], [e.region]), ...people);
}

/** 掌实权那几步的标签(类型名见 timelineLayout.ts):掌权、还政、伏诛、篡位、(掌权的人卒)亲政 */
const REGENT_TAG: Readonly<Record<number, string>> = { [RG_START]: '权', [RG_RETURN]: '还', [RG_PURGE]: '诛', [RG_USURP]: '篡', [RG_DIED]: '亲' };

/**
 * 结亲(史事 marry,marriages.ts),标签"姻":"南漓、大澜结亲:大澜德宗以女风氏妻南漓懿公胡炜"(互嫁的紧跟着那一条并进来:
 * ";南漓懿公亦以女胡氏妻大澜太子风某,两国互为婚姻");议和时 "南漓、大澜议和,大澜德宗以宗室女风氏妻南漓懿公胡炜,是为和亲"。
 * 这一方是女的:"南漓女君胡某嫁大澜德宗之子"(西幻"…嫁给了大澜国王某某的儿子")。
 * 两个大国之间的算大事。西幻 "南漓与大澜联姻:大澜国王某某将女儿嫁给南漓国王某某"
 */
function marryEntry(ctx: Ctx, i: number): ChronicleEntry {
  const { civ } = ctx;
  const A = civ.annals;
  const e = A[i];
  const y = e.year;
  const east = classical(polityOf(civ, e.a));
  const next = A[i + 1];
  const mutual = next && next.kind === 'marry' && next.year === y && next.a === e.b && next.b === e.a && next.war < 0 && e.war < 0;
  const people: Person[] = [];
  /** 一门亲的半句:"大澜德宗以女风氏妻南漓懿公胡炜" */
  const half = (j: number, also: boolean): string => {
    const f = A[j];
    const w = ctx.ix?.wed.get(j);
    const groom = w?.x;
    const F = w && w.s.father >= 0 ? civ.people?.[w.s.father] : undefined;
    if (groom) people.push(groom);
    if (F) people.push(F);
    const fa = F ? rulerRef(civ, F, y) : `${pn(civ, f.b, y)}${east ? '国君' : '国王'}`;
    // 在位的君主:东方有庙号的称呼不带名字("南漓懿公"),补上名字;西幻、汗国的称呼里已经有名字("奥利亚国王佩尔梅内斯二世"),不再补
    const ref = groom && reigningAt(groom, y) ? rulerRef(civ, groom, y) : '';
    const gr = !groom ? pn(civ, f.a, y) : ref ? (ref.includes(groom.name) ? ref : ref + groom.name) : princeRef(civ, groom, y);
    // 女的那一方:她嫁过去,配偶是对方君主的儿子
    if (groom && isFemale(groom)) return east ? `${gr}${also ? '亦' : ''}嫁${fa}之子` : `${gr}${also ? '也' : ''}嫁给了${fa}的儿子`;
    // 嫁来的宗室女是人物的写她的名字(能点)
    const B = w && w.s.person !== undefined ? civ.people?.[w.s.person] : undefined;
    if (B) people.push(B);
    const her = B?.name ?? w?.s.name ?? '';
    if (!east) return `${fa}${also ? '也' : ''}将女儿${her}嫁给${gr}`;
    return `${fa}${also ? '亦' : ''}以${f.war >= 0 ? '宗室女' : '女'}${her}妻${gr}`;
  };
  const head = east ? `${pn(civ, e.a, y)}、${pn(civ, e.b, y)}${e.war >= 0 ? '议和,' : '结亲:'}` : `${pn(civ, e.a, y)}与${pn(civ, e.b, y)}${e.war >= 0 ? '议和,' : '联姻:'}`;
  let text = head + half(i, false);
  if (e.war >= 0) text += east ? ',是为和亲' : ',以示和好';
  if (mutual) text += `;${half(i + 1, true)}${east ? ',两国互为婚姻' : ',两国结为姻亲'}`;
  // 两个帝国(当时都在 TITAN_TIER)议和时和亲才是大事(寻常结亲常有,只在"全部"里)
  const A0 = polityOf(civ, e.a);
  const B0 = polityOf(civ, e.b);
  const imp: Importance = e.war >= 0 && A0 && B0 && polityTierAt(A0, y) >= TITAN_TIER && polityTierAt(B0, y) >= TITAN_TIER ? 3 : 2;
  return withPeople(base(e, i, text, imp, [e.a, e.b], [e.region]), ...people);
}

/** 第 i 条结亲是不是紧跟在前一条后面的互嫁(并进前一条) */
function mutualTail(A: readonly Annal[], i: number): boolean {
  const e = A[i];
  const prev = A[i - 1];
  return !!prev && prev.kind === 'marry' && prev.year === e.year && prev.a === e.b && prev.b === e.a && e.war < 0 && prev.war < 0;
}

/**
 * 结盟 "大渭与昌国结盟,共御索拉特";盟约渐废 "索拉特既亡,大渭与昌国之盟遂废" / "大渭与昌国之盟渐废";
 * 坐视不救 "索拉特伐昌国,大渭坐视不救,两国之盟遂绝";背盟 "大渭背弃与昌国之盟"(折进那场战争,标题写"背盟伐");
 * 一方称臣 "昌国既称臣于大渭,与索拉特之盟遂废";
 * 畏强邻称臣 "昌国畏大渭之强,遣使称臣,岁岁纳贡"(战败称臣折进那场战争的议和);
 * 藩属自立 "昌国乘大渭与索拉特交兵,绝其朝贡,不复称臣"。
 * 称臣、自立的一方当时在第 2 档(王国)以上是大事;结盟要两国都在第 3 档(帝国)以上才算大事(结盟常有,大多后来渐废)
 */
function diplomacyEntry(ctx: Ctx, e: Annal, id: number): ChronicleEntry {
  const { civ } = ctx;
  const y = e.year;
  const A = pn(civ, e.a, y);
  const B = pn(civ, e.b, y);
  switch (e.kind) {
    case 'alliance': {
      const f = e.foe ?? -1;
      const F = polityOf(civ, f);
      // 结亲以后结的盟(两国还结着亲):"(两国本为姻亲)"
      const kin = kinAt(civ, e.a, e.b, y, true) >= 0 ? '(两国本为姻亲)' : '';
      const t = (F ? `${A}与${B}结盟,共御${pn(civ, f, y)}` : `${A}与${B}结盟`) + kin;
      return { ...base(e, id, t, minTier(civ, e.a, e.b, y) >= TITAN_TIER ? 3 : 2, [e.a, e.b, f], []), settlement: -1 };
    }
    case 'unally': {
      if (e.cause === 'abandon') {
        const w = civ.annals.find((x) => x.kind === 'war' && x.war === e.war);
        const head = w ? `${pn(civ, w.a, y)}伐${B},` : `${B}遭兵,`;
        return base(e, id, `${head}${A}坐视不救,两国之盟遂绝`, 2, [e.a, e.b], [], '绝');
      }
      if (e.cause === 'betray') return base(e, id, `${A}背弃与${B}之盟`, 2, [e.a, e.b], [], '背');
      if (e.cause === 'vassal') {
        const s = submitBefore(civ, e.a, id + 1);
        return base(e, id, s ? `${A}既称臣于${pn(civ, s.b, y)},与${B}之盟遂废` : `${A}与${B}之盟遂废`, 1, [e.a, e.b], [], '绝');
      }
      const f = pactBefore(civ, e.a, e.b, id)?.foe ?? -1;
      const F = polityOf(civ, f);
      const gone = !!F && F.ended !== undefined && F.ended <= y;
      const t = gone ? `${pn(civ, f, F!.ended! - 1 / 512)}既亡,${A}与${B}之盟遂废` : F ? `${pn(civ, f, y)}既衰,${A}与${B}之盟渐废` : `${A}与${B}之盟渐废`;
      return base(e, id, t, 1, [e.a, e.b], [], '绝');
    }
    case 'submit': {
      const t = `${A}畏${B}之强,遣使称臣,岁岁纳贡`;
      const P = polityOf(civ, e.a);
      return base(e, id, t, P && polityTierAt(P, y) >= GREAT_TIER ? 3 : 2, [e.a, e.b], [e.region]);
    }
    case 'defect': {
      // 作者下令宗主向藩属开战:宗藩反目
      const why = e.cause === 'betray' ? '' : troubleOf(civ, e.b, id);
      const t = e.cause === 'betray' ? `${B}与藩属${A}反目,${A}不复称臣` : why ? `${A}乘${B}${why},绝其朝贡,不复称臣` : `${A}绝${B}之贡,不复称臣`;
      const P = polityOf(civ, e.a);
      return base(e, id, t, P && polityTierAt(P, y) >= GREAT_TIER ? 3 : 2, [e.a, e.b], [e.region]);
    }
    default:
      return base(e, id, `${A}有事`, 1, [e.a], []);
  }
}

// ---------------------------------------------------------------------------
// 立约与中立地(treaties.ts):立约、续约、背约、约满、中立地、放逐、出奔

/** 几国并列:"大羽王朝、渭国、后乾衍国" */
function polityList(civ: Civ, ps: readonly number[], y: Year): string {
  return ps.map((p) => pn(civ, p, y)).join('、');
}

/** 约的称呼:"丹枫关之约";议和顺带立的、没有会盟的城:"甲与乙之约" */
function treatyRef(civ: Civ, id: number, ps: readonly number[], y: Year): string {
  return treatyWord(civ, id, (name) => name, ps.length >= 2 ? `${pn(civ, ps[0], y)}与${pn(civ, ps[1], y)}之约` : '前约');
}

/**
 * 写到一份约的那句话:约有名字(会盟的城、用的人起的)写 named(约名),没有(议和顺带立的)写 plain。
 * 存占位符时(civ/nameToken.ts):没名字的约用的人起了名才有名字,两种写法都存着;现在的写法放前面,来历(introduce)找国名时找在它里面
 */
function treatyWord(civ: Civ, id: number, named: (name: string) => string, plain: string): string {
  const name = treatyCallName(civ, id);
  if (name) return named(name);
  if (!isNameToken(civ.polities[0]?.name ?? '') || !treatyBook(civ).treaties[id]) return plain;
  return nameIf('empty', nameToken(`o${id}`), '', plain, named(nameToken(`t${id}`)));
}

/** 背约来攻的那场战争(war 的 cause = breach)背的是哪份约(宣战前一刻记的那条 breach;找不到 = −1) */
function breachOf(civ: Civ, e: Annal, id: number): number {
  for (let i = id - 1; i >= 0 && civ.annals[i].year === e.year; i--) {
    const b = civ.annals[i];
    if (b.kind === 'breach' && b.war === e.war) return b.n ?? -1;
  }
  return -1;
}

/** 中立地那一州的名字 */
function zoneName(civ: Civ, e: Annal): string {
  return regionName(civ, e.region) || cityName(civ, e.settlement) || '某地';
}

/** 几国:"两国""三国" */
function nations(n: number): string {
  return `${n === 2 ? '两' : cnNumber(n)}国`;
}

/**
 * 紧跟在背约 / 约满后面、同一刻的中立地撤销、约废(剩不到两国):并进那一条。
 * 议和顺带立的约紧跟着划了缓冲中立地:立约那一条并进中立地那一条(见 treatyEntry)
 */
function treatyTail(e: Annal, head: Annal): boolean {
  if (e.year !== head.year) return false;
  const tid = head.kind === 'breach' ? head.n : head.war;
  if (e.kind === 'neutral' && e.cause === 'lapse' && e.n === tid) return head.kind === 'breach' || head.kind === 'expire';
  return head.kind === 'breach' && e.kind === 'expire' && e.cause === 'lapse' && e.war === tid;
}

/** 中立地撤销那一句:"星河域中立地废,还归渭国" */
function zoneLapseText(civ: Civ, e: Annal): string {
  return `${zoneName(civ, e)}中立地废${e.a >= 0 ? `,还归${pn(civ, e.a, e.year)}` : ''}`;
}

/**
 * 立约 "渭国与大羽王朝、后乾衍国会于丹枫关,立约互不侵犯,各守今疆,以三十年为期;拉文海姆王国首相贡纳瓦尔居间"
 * (两国之约国界上有山河的写"以云隐山为界");议和顺带立约 "大岳王朝与大渭议和,约二十年互不侵犯";
 * 续约 "丹枫关之约满三十年,大羽王朝、大渭续约二十年;后乾衍国不在约中";
 * 背约 "大渭背丹枫关之约,伐后乾衍国,兵出星河域;星河域中立地废"(标签"违");约满 "大岳王朝与大渭之约满二十年,不续;德和郡中立地废,还归大岳王朝";
 * 中立地 "大羽王朝、渭国、后乾衍国以星河域为中立地,渭国让出丹枫关,三国皆不驻兵" / 议和划缓冲 "大岳王朝与大渭议和,以德和郡为缓冲中立地,约二十年互不侵犯";
 * 放逐 "渭桓王疏其弟阎晋显,徙居星河域" / "昌哀帝既废,徙居星河域";出奔 "后乾衍国亡,哀公司霄泠出奔星河域"、出奔邻国 "后乾衍国亡,哀公司霄泠出奔大渭"(标签"奔")。
 * ids[0] = 这一条,后面是并进来的(treatyTail)
 */
function treatyEntry(ctx: Ctx, ids: number[]): ChronicleEntry {
  const { civ, ix } = ctx;
  const A = civ.annals;
  const id = ids[0];
  const e = A[id];
  const y = e.year;
  const book = treatyBook(civ);
  const tails = ids.slice(1).map((i) => A[i]);
  const zoneTail = tails.filter((x) => x.kind === 'neutral').map((x) => `;${zoneLapseText(civ, x)}`).join('');
  const ps = e.ps ?? [e.a, e.b].filter((p) => p >= 0);
  switch (e.kind) {
    case 'treaty': {
      const x = book.treaties[e.war];
      const term = e.n ?? x?.term ?? 20;
      if (e.cause === 'renew') {
        const k = x ? x.renewals.findIndex((r) => r.annal === id) : -1;
        const prev = x ? (k > 0 ? x.renewals[k - 1] : null) : null;
        const before = prev ? prev.parties : (x?.parties ?? ps);
        const was = prev ? prev.term : (x?.term ?? term);
        const gone = before.filter((p) => !ps.includes(p) && !(x?.breaches.some((b) => b.by === p) ?? false) && polityOf(civ, p)?.ended === undefined);
        const same = ps.length === before.length && ps.every((p) => before.includes(p));
        const t = `${treatyRef(civ, e.war, before, y)}满${cnNumber(was)}年,${same ? nations(ps.length) : polityList(civ, ps, y)}续约${cnNumber(term)}年${gone.length ? `;${polityList(civ, gone, y)}不在约中` : ''}`;
        return { ...base(e, id, t, 2, ps, [], '续'), settlement: -1 };
      }
      const by = e.by ?? -1;
      const envoy = by >= 0 ? envoyOf(civ, by, y) : null;
      const mid = by >= 0 ? `;${pn(civ, by, y)}${envoy ? ministerRef(envoy, y) : ''}居间` : '';
      const city = cityName(civ, e.settlement);
      let t: string;
      if (e.cause === 'peace') t = `${pn(civ, ps[0], y)}与${pn(civ, ps[1], y)}议和,约${cnNumber(term)}年互不侵犯${mid}`;
      else if (e.cause === 'decree') {
        // 作者下令立的:种类照作者选的(互不侵犯的不写各守今疆),期限 0 = 不设期限,选了不许背约的写"誓不背约"
        const line = x && ps.length < 3 ? treatyLine(civ, x) : -1;
        const what = x?.kind === 'limited' ? '立约互不侵犯,各守今疆' : line >= 0 ? `立约互不侵犯,以${civ.places[line].name}为界` : '立约互不侵犯';
        const span = term > 0 ? `以${cnNumber(term)}年为期` : '不设期限';
        t = `${pn(civ, ps[0], y)}与${polityList(civ, ps.slice(1), y)}${city ? `会于${city},` : ''}${what},${span}${x?.keep ? ',誓不背约' : ''}${mid}`;
      } else {
        const line = x ? treatyLine(civ, x) : -1;
        const what = ps.length < 3 && line >= 0 ? `立约互不侵犯,以${civ.places[line].name}为界` : '立约互不侵犯,各守今疆';
        t = `${pn(civ, ps[0], y)}与${polityList(civ, ps.slice(1), y)}${city ? `会于${city},` : ''}${what},以${cnNumber(term)}年为期${mid}`;
      }
      // 三国以上的有限竞争之约是大事;两国之约只在"全部"里(一个世界几份到十几份,大多约满就散)
      const out = base(e, id, t, ps.length >= 3 ? 3 : 2, by >= 0 ? [...ps, by] : ps, e.region >= 0 ? [e.region] : [], '约');
      return withPeople(out, envoy);
    }
    case 'breach': {
      // 兵出中立地:背约这一仗头一回打的就是刚撤销的中立地那州
      const zone = tails.find((z) => z.kind === 'neutral');
      let out = '';
      if (zone) {
        for (let i = id + 1; i < A.length; i++) {
          const w = A[i];
          if (w.war !== e.war || (w.kind !== 'conquer' && w.kind !== 'battle')) continue;
          if (w.region === zone.region) out = `,兵出${zoneName(civ, zone)}`;
          break;
        }
      }
      const B = pn(civ, e.b, y);
      const t = `${pn(civ, e.a, y)}${treatyWord(civ, e.n ?? -1, (name) => `背${name},伐${B}`, `背与${B}之约,举兵伐之`)}${out}${zoneTail}`;
      return { ...base(e, id, t, 2, [e.a, e.b], zone ? [zone.region] : [], '违'), settlement: -1 };
    }
    case 'expire': {
      const x = book.treaties[e.war];
      const all = x?.parties ?? ps;
      const ref = treatyRef(civ, e.war, all, y);
      const last = x?.renewals.filter((r) => r.year < y).pop();
      const term = last ? last.term : (x?.term ?? 20);
      const t = e.cause === 'lapse' ? `${ref}遂废${zoneTail}` : `${ref}满${cnNumber(term)}年,不续${zoneTail}`;
      return { ...base(e, id, t, e.cause === 'lapse' ? 1 : 2, all, [], '满'), settlement: -1 };
    }
    case 'neutral': {
      const z = zoneName(civ, e);
      if (e.cause === 'lapse') return base(e, id, zoneLapseText(civ, e), 2, e.a >= 0 ? [e.a] : [], [e.region], '中');
      const fs = e.ps ?? [];
      const x = book.treaties[e.n ?? -1];
      let t: string;
      if (e.cause === 'peace') t = `${pn(civ, fs[0], y)}与${pn(civ, fs[1], y)}议和,以${z}为缓冲中立地,约${cnNumber(x?.term ?? 20)}年互不侵犯`;
      else {
        const city = cityName(civ, e.settlement);
        const give = e.a >= 0 ? `${pn(civ, e.a, y)}让出${city || z},` : '';
        t = `${polityList(civ, fs, y)}以${z}为中立地,${give}${nations(fs.length)}皆不驻兵`;
        // 作者下令划的:一直留着 / 到哪年撤
        if (e.cause === 'decree') {
          const opt = e.opt ?? 0;
          if (opt & OPT_LASTING) t += ',永为中立';
          else if (e.until !== undefined) t += `,至第 ${e.until} 年`;
        }
      }
      return base(e, id, t, fs.length >= 3 ? 3 : 2, fs, [e.region], '中');
    }
    case 'exile': {
      const who = civ.people?.find((p) => p.exile?.annal === id) ?? null;
      const P = pn(civ, e.a, e.cause === 'fled' ? y - 1 / 512 : y);
      if (e.cause === 'fled' && e.war < 0 && e.b >= 0) {
        // 出奔邻国(exile.ts):"塔布斯坦国亡,塔布斯坦国王卡拉尔出奔乌里特国";去的国家也算这一条有关的国家
        const H = pn(civ, e.b, y);
        const t = who ? `${P}亡,${rulerRef(civ, who, y - 1 / 512)}出奔${H}` : `${P}亡,其君出奔${H}`;
        return withPeople(base(e, id, t, 2, [e.a, e.b], [e.region], '奔'), who);
      }
      const z = zoneName(civ, e);
      let t: string;
      let by: Person | null = null;
      if (e.cause === 'fled') t = who ? `${P}亡,${rulerRef(civ, who, y - 1 / 512)}出奔${z}` : `${P}亡,其君出奔${z}`;
      else if (e.cause === 'deposed') t = who ? `${rulerRef(civ, who, y)}既废,徙居${z}` : `${P}废君徙居${z}`;
      else {
        by = who ? (who.exile?.by !== undefined ? (civ.people?.[who.exile.by] ?? null) : reigning(ix, e.a, y)) : null;
        const kin = who && by ? kinOf(civ, by, who) : '';
        if (who && by) t = kin === kinWord(who, '兄') || kin === kinWord(who, '弟') ? `${rulerRef(civ, by, y)}疏其${kin}${who.name},徙居${z}` : `${rulerRef(civ, by, y)}徙宗室${who.name}居${z}`;
        else {
          t = `${P}徙宗室于${z}`;
          by = null;
        }
      }
      return withPeople(base(e, id, t, 2, [e.a], [e.region], e.cause === 'fled' ? '奔' : '逐'), who, by);
    }
    default:
      return base(e, id, `${pn(civ, e.a, y)}有事`, 1, [e.a], []);
  }
}

// ---------------------------------------------------------------------------
// 地形大事:那一刻的后果(城没了、迁都、亡国)折叠成一条

/** 城在地形大事里没了:"揽霞城没于水" / "别尔格勒毁于火山";who = 带上国名("大霄揽霞城没于水") */
function sunkText(civ: Civ, e: Annal, who = false): string {
  const city = cityName(civ, e.settlement) || '一城';
  const head = who && e.a >= 0 ? pn(civ, e.a, e.year) : '';
  return `${head}${city}${e.b === 1 ? '没于水' : '毁于火山'}`;
}

/** 这条史事是地形大事那一刻的后果(紧跟在 upheaval 后面、同一刻的 sunk / 因天灾迁都 / 亡于天灾):编年史并进大事那一条 */
function upheavalTail(e: Annal, head: Annal): boolean {
  if (e.year !== head.year) return false;
  return e.kind === 'sunk' || (e.kind === 'capital' && e.b === -2) || (e.kind === 'fall' && e.b === -2);
}

/**
 * 地形大事:"海水漫入大霄,六州沉入海中,揽霞城等十城没于水,迁都长风城" / "兹拉季纳王国境内火山喷发,国都别尔格勒被毁,
 * 迁都奥斯托斯克" / "萨尔斯坦帝国与库那汗国之间的海峡隆起成陆"。ids = upheaval 那一条和紧跟着的后果(upheavalTail)
 */
function upheavalEntry(ctx: Ctx, ids: number[]): ChronicleEntry {
  const { civ } = ctx;
  const A = civ.annals;
  const e = A[ids[0]];
  const y = e.year;
  const F = civ.upheavals?.[e.a];
  const tail = ids.slice(1).map((i) => A[i]);
  const P = F?.polity ?? -1;
  const where = P >= 0 ? pn(civ, P, y) : '';
  const rn = regionName(civ, e.region);
  const kinds = F?.kinds ?? [];
  let t: string;
  if (kinds.includes('volcano')) {
    if (where) t = `${where}境内火山喷发`;
    else if (F?.added.length) t = '海中火山喷发,隆起新岛';
    else t = `${rn || '荒野之中'}火山喷发`;
  } else if (kinds.includes('sink') && (!kinds.includes('raise') || F!.sunk >= F!.risen)) {
    t = where ? `海水漫入${where}` : rn ? `海水漫入${rn}一带` : '海水漫入';
    const drowned = F ? F.drowned.filter((_, i) => P < 0 || F.drownedBy[i] === P).length : 0;
    if (drowned) t += `,${cnNumber(drowned)}州沉入海中`;
    else if (F?.shrunk.length) t += ',沿岸之地沉入海中';
  } else if (F?.joined && F.joinedBy) {
    const side = (i: number) => (F.joinedBy![i] >= 0 ? pn(civ, F.joinedBy![i], y) : regionName(civ, F.joined![i]) || '荒野');
    t = F.joinedBy[0] >= 0 && F.joinedBy[0] === F.joinedBy[1] ? `${where || side(0)}境内的海峡隆起成陆` : `${side(0)}与${side(1)}之间的海峡隆起成陆`;
  } else if (F?.added.length && !F.grown.length) t = `${where || rn ? `${where || rn}外` : ''}海中隆起新岛`;
  else t = `${where || rn || ''}沿海隆起新陆`;
  // 没了的城:先说毁于火山的,再说没于水的(各自国都在前,史事里已经排好)
  const cities = (list: Annal[], word: string) => {
    if (!list.length) return '';
    const first = list[0];
    const p = polityOf(civ, first.a);
    // 只没了国都一座城时点明是国都("国都别尔格勒被毁");好几座城时只举头一座("揽霞城等十城没于水",后面有迁都)
    const cap = list.length === 1 && !!p && capitalBefore(p, y) === first.settlement && p.founded < y;
    const name = `${cap ? (first.a === P ? '国都' : `${pn(civ, first.a, y)}国都`) : ''}${cityName(civ, first.settlement) || '一城'}`;
    return list.length > 1 ? `,${name}等${cnNumber(list.length)}城${word}` : `,${name}${word}`;
  };
  const sunk = tail.filter((x) => x.kind === 'sunk');
  t += cities(
    sunk.filter((x) => x.b === 0),
    '被毁',
  );
  t += cities(
    sunk.filter((x) => x.b === 1),
    '没于水',
  );
  for (const x of tail) {
    if (x.kind === 'capital') t += `,${x.a === P ? '' : pn(civ, x.a, y)}迁都${cityName(civ, x.settlement) || regionName(civ, x.region)}`;
    else if (x.kind === 'fall') t += `,${pn(civ, x.a, y)}亡`;
  }
  const regions = [e.region, ...(F ? [...F.drowned, ...F.shrunk, ...F.grown, ...F.added] : [])].filter((r) => r >= 0);
  const polities = [P, ...(F?.joinedBy ?? []), ...tail.map((x) => x.a)].filter((p) => p >= 0);
  const x = { ...base(e, ids[0], t, 3, polities, regions), settlement: -1 };
  if (tail.length) {
    x.children = ids.slice(1).map((i) => {
      const c = A[i];
      if (c.kind === 'sunk') return base(c, i, sunkText(civ, c), 2, [c.a], [c.region]);
      return simpleEntry(ctx, c, i);
    });
  }
  return x;
}

// ---------------------------------------------------------------------------
// 战争:折叠成一条

function warEntry(ctx: Ctx, ids: number[]): ChronicleEntry {
  const { civ } = ctx;
  const A = civ.annals;
  const list = ids.map((i) => A[i]);
  const decl = list.find((e) => e.kind === 'war') ?? list[0];
  const atk = decl.a;
  const def = decl.b;
  const start = list[0].year;
  // 净得失:每一州最早的原主、最后是谁打下来的
  const firstOwner = new Map<number, number>();
  const lastBy = new Map<number, number>();
  const fought: number[] = [];
  for (const e of list) {
    if (e.kind !== 'conquer' || e.region < 0) continue;
    if (!firstOwner.has(e.region)) {
      firstOwner.set(e.region, e.b);
      fought.push(e.region);
    }
    lastBy.set(e.region, e.a);
  }
  const gained = (side: number) => fought.filter((r) => lastBy.get(r) === side && firstOwner.get(r) !== side);
  const gainA = gained(atk);
  const gainD = def >= 0 ? gained(def) : [];
  const falls = list.filter((e) => e.kind === 'fall');
  // 被迫迁都(国都失守),按国家分:这场战争里亡了的不再说迁都
  const moves = new Map<number, Annal[]>();
  for (const e of list) {
    if (e.kind !== 'capital' || falls.some((f) => f.a === e.a)) continue;
    let m = moves.get(e.a);
    if (!m) moves.set(e.a, (m = []));
    m.push(e);
  }
  const peace = [...list].reverse().find((e) => e.kind === 'peace');
  // 战败称臣(邦交):紧跟在议和后面,写进议和那一条和标题
  const sworn = list.find((e) => e.kind === 'submit');
  const lastYear = list[list.length - 1].year;
  const over = !!peace || falls.some((f) => f.a === atk || f.a === def);
  const end = over ? (peace ? peace.year : lastYear) : Math.max(lastYear, civ.endYear);

  // 子条目:洗劫、毁城在史事里记在攻占前面(同一刻),这里排回那条攻占后面
  const order: number[] = [];
  let held: number[] = [];
  for (const i of ids) {
    const e = A[i];
    if (e.kind === 'sack' || e.kind === 'ruin') {
      held.push(i);
      continue;
    }
    // 称臣写进议和那一条,背盟写进宣战那一条("背盟,起兵伐某国"),不另列
    if (e.kind === 'submit' || (e.kind === 'unally' && e.cause === 'betray')) continue;
    order.push(i);
    if (e.kind === 'conquer' && held.length) {
      order.push(...held.filter((j) => A[j].region === e.region));
      held = held.filter((j) => A[j].region !== e.region);
    }
  }
  order.push(...held);
  // 不是打下来的攻占:议和时划界割让的(peace 的 region = 紧挨在它前面的几条)、丢了国都撑不下去残部一并归攻方的
  // (亡国前同一刻、打下国都以后连着的几条攻占,见 growth.ts 的 annexedRemnants)。各合成一条子条目,不写"攻取"
  // 议和时罢兵割地的(peace 的 n = 割让的那几条里最前面几条,wars.ts 的 CEDE)单独一条:"昌国割瑞州求和";
  // 破都纳降的(fall 的 cause = surrender)残部写"昌国余下瑞州等十二州皆降于大渭"
  const special = new Map<number, 'cede' | 'annex' | 'yield' | 'surrender'>();
  for (const i of ids) {
    const e = A[i];
    if (e.kind === 'peace' && e.region > 0) {
      for (let j = Math.max(0, i - e.region); j < i; j++) if (A[j].kind === 'conquer' && A[j].war === e.war) special.set(j, j < i - e.region + (e.n ?? 0) ? 'yield' : 'cede');
    } else if (e.kind === 'fall') {
      for (const j of annexedRemnants(civ, i)) special.set(j, e.cause === 'surrender' ? 'surrender' : 'annex');
    }
  }
  // 人物:统帅这场战争里第一次出场写全("大渭将李牧攻取瑞州"),之后攻占只写国名
  const ix = ctx.ix;
  const named = new Set<number>();
  const sideOf = (p: number) => (p === atk ? 0 : p === def ? 1 : -1);
  // 同一处、同一攻方、两边同一对统帅接连没打下来的几仗合成一条("三度攻至城下,…皆不克");中间这一州易手了就另算
  const battles = new Map<number, number[]>();
  const folded = new Set<number>();
  {
    const open = new Map<string, number>();
    for (const i of order) {
      const e = A[i];
      if (e.kind === 'conquer') {
        for (const [key, head] of open) if (A[head].region === e.region) open.delete(key);
        continue;
      }
      if (e.kind !== 'battle') continue;
      const s = sideOf(e.a);
      const ca = s >= 0 ? commander(ix, e.war, s, i) : null;
      const cd = s >= 0 ? commander(ix, e.war, 1 - s, i) : null;
      const key = `${e.region}|${e.a}|${ca?.id ?? -1}|${cd?.id ?? -1}`;
      const head = open.get(key);
      if (head === undefined) {
        open.set(key, i);
        battles.set(i, [i]);
      } else {
        battles.get(head)!.push(i);
        folded.add(i);
      }
    }
  }
  const children: ChronicleEntry[] = [];
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    if (folded.has(i)) continue;
    const sp = special.get(i);
    if (!sp) {
      children.push(childEntry(i));
      continue;
    }
    const group = [i];
    while (k + 1 < order.length && special.get(order[k + 1]) === sp) group.push(order[++k]);
    const e = A[i];
    const rs = uniq(group.map((j) => A[j].region));
    let text: string;
    if (sp === 'cede') {
      // "议定疆界,乌绝原等三州划归大渭,雪西划归昌国"
      const to = uniq(group.map((j) => A[j].a));
      text = `议定疆界,${to.map((p) => `${regionList(civ, group.filter((j) => A[j].a === p).map((j) => A[j].region)) || '一州'}划归${pn(civ, p, e.year)}`).join(',')}`;
    } else if (sp === 'yield') text = `${pn(civ, e.b, e.year)}割${regionList(civ, rs) || '一州'}求和`;
    else if (sp === 'surrender') text = `${pn(civ, e.b, e.year)}余下${regionList(civ, rs) || '诸州'}${rs.length > 1 ? '皆' : '亦'}降于${pn(civ, e.a, e.year)}`;
    else text = rs.length > 1 ? `余下${regionList(civ, rs)}尽归${pn(civ, e.a, e.year)}` : `余下${regionList(civ, rs) || '一州'}亦归${pn(civ, e.a, e.year)}`;
    const kids = group.map((j) => A[j]);
    children.push({ ...base(e, i, text, 2, kids.flatMap((c) => [c.a, c.b]), rs, sp === 'cede' || sp === 'yield' ? '割' : '占'), settlement: -1 });
  }
  function childEntry(i: number): ChronicleEntry {
    const e = A[i];
    if (e.kind === 'war') {
      const x = declareEntry(ctx, e, i);
      for (const id of x.people ?? []) named.add(id);
      return x;
    }
    if (e.kind === 'battle') return battleChild(battles.get(i) ?? [i]);
    if (e.kind === 'stand') return standChild(i);
    if (e.kind === 'winter') return winterChild(i);
    if (e.kind === 'conquer') {
      // 这场战争里被夺走又打回来的,或者以前就是攻方的(议和割让、分裂出去、上一场战争丢掉的)
      const retake = (e.region >= 0 && firstOwner.get(e.region) === e.a) || ctx.retake.has(i);
      const s = sideOf(e.a);
      const c = s >= 0 ? commander(ix, e.war, s, i) : null;
      const fresh = c && !named.has(c.id) ? c : null;
      if (fresh) named.add(fresh.id);
      let t = conquerText(civ, e, [atk, def], retake, fresh ? generalRef(civ, fresh, e.year) : undefined);
      // 守方统帅战死:"…,守将王翦战死"(领兵的宗室:"…,公子胡翔战死")
      const lost = s >= 0 ? fallenAt(ix, e.war, 1 - s, i) : null;
      // 守方由作者的将领挂帅时战死的是副将
      const vice = !!lost && authorGeneral(commander(ix, e.war, 1 - s, i));
      if (lost) t += `,${lost.role === 'prince' ? princeTitle(civ, lost, e.year) : vice ? '副将' : '守将'}${lost.name}战死`;
      return withPeople(base(e, i, t, e.b >= 0 ? 2 : 1, [e.a, e.b], [e.region]), fresh, lost);
    }
    if (e.kind === 'unally') {
      // 坐视不救:"索拉特坐视不救,与昌国之盟遂绝";背盟写在宣战那一条和标题里
      return base(e, i, `${pn(civ, e.a, e.year)}坐视不救,与${pn(civ, e.b, e.year)}之盟遂绝`, 2, [e.a, e.b], [], '绝');
    }
    if (e.kind === 'peace') {
      const y = e.year;
      const fallen = falls.find((f) => f.year <= y && (f.a === atk || f.a === def));
      // 一方在另一场战争里亡国,这场仗随之结束(见 wars.ts:亡国的国家打着的仗都记一条议和)
      const gone = fallen
        ? -1
        : [atk, def].find((s) => {
            const p = polityOf(civ, s);
            return !!p && p.ended !== undefined && p.ended <= y;
          }) ?? -1;
      let t: string;
      let envoys: Person[] = [];
      if (fallen) t = `${pn(civ, fallen.a, fallen.year)}既亡,兵戈遂息`;
      else if (gone >= 0) t = `${pn(civ, gone, y)}既亡,兵戈遂息`;
      else {
        // 议和条款:"大渭遣礼部尚书某某与昌国丞相某某议和:昌国奉表称臣,岁岁纳贡;昌国割瑞州、汾州、雪西三州予大渭"
        const head = peaceHead(civ, ix, e, i, y);
        t = head.text;
        envoys = head.people;
        const terms: string[] = [];
        if (sworn) terms.push(`${pn(civ, sworn.a, y)}奉表称臣,岁岁纳贡`);
        if (gainA.length) terms.push(`${pn(civ, def, y)}割${regionNames(civ, gainA)}予${pn(civ, atk, y)}`);
        if (gainD.length) terms.push(`${pn(civ, atk, y)}割${regionNames(civ, gainD)}予${pn(civ, def, y)}`);
        t += terms.length ? `:${terms.join(';')}` : ',疆界如故';
      }
      return withPeople(base(e, i, t, 2, sworn && sworn.a !== e.a && sworn.a !== e.b ? [e.a, e.b, sworn.a] : [e.a, e.b], [...gainA, ...gainD]), ...envoys);
    }
    if (e.kind === 'capital') {
      // 被迫迁都:紧跟在"国都某城陷落"那一条攻占后面,只说迁到哪
      const now = cityName(civ, e.settlement) || regionName(civ, e.region);
      return base(e, i, `${pn(civ, e.a, e.year)}${now ? `迁都${now}` : '另立国都'}`, 2, [e.a], [e.region]);
    }
    return simpleEntry(ctx, e, i);
  }
  /**
   * 战役(攻方这一仗没打下来):州里有城的是攻城 "汾城之战,大渭将李牧攻至城下,王翦坚守,不克"
   * (三种说法按城、年份轮换;守方的国都:"…围攻昌国国都,…");没有城的是野战 "瑞州之战,大渭将李牧渡河来攻,为昌国将王翦所败";
   * 守方反攻写"反攻";攻方统帅战死加 ",李牧战死"。接连几仗合成一条:"…前后 7 年三度攻至城下,王翦坚守,皆不克"
   */
  function battleChild(ids: number[]): ChronicleEntry {
    const e = A[ids[0]];
    const last = A[ids[ids.length - 1]];
    const y = e.year;
    const n = ids.length;
    const s = sideOf(e.a);
    const counter = s === 1;
    const ca = s >= 0 ? commander(ix, e.war, s, ids[0]) : null;
    const cd = s >= 0 ? commander(ix, e.war, 1 - s, ids[0]) : null;
    const dead = s >= 0 ? fallenAt(ix, e.war, s, ids[n - 1]) : null;
    const who = ca ? generalRef(civ, ca, y) : pn(civ, e.a, y);
    const years = Math.floor(last.year) - Math.floor(y);
    const times = n >= 2 ? `${years >= 2 ? `前后 ${years} 年` : ''}${n === 2 ? '两' : cnNumber(n)}度` : '';
    const all = n >= 2 ? '皆' : '';
    const city = cityName(civ, e.settlement);
    let t: string;
    if (city) {
      const owner = polityOf(civ, e.b);
      const capital = !!owner && owner.founded <= y && capitalBefore(owner, y) === e.settlement;
      const guard = cd ? (named.has(cd.id) && !reigningAt(cd, y) ? cd.name : generalRef(civ, cd, y)) : '';
      const v = n >= 2 || capital ? 0 : (Math.max(0, e.settlement) * 7 + Math.floor(y)) % 3;
      const attack = capital
        ? `${counter ? '反攻' : '围攻'}${pn(civ, e.b, y)}国都`
        : (counter ? ['反攻至城下', '回师围城', '反攻其城'] : ['攻至城下', '围城', '攻城'])[v];
      t = `${city}之战,${who}${times}${attack}`;
      if (v === 0) t += guard ? `,${guard}坚守,${all}不克` : `,${all}不克`;
      else if (v === 1) t += guard ? `,${guard}据城死守,城不下` : ',城坚不下';
      else t += guard ? `,为${guard}所却` : '不下';
    } else {
      const r = regionName(civ, e.region) || '边境';
      t = `${r}之战,${who}${times}${VIA[e.via ?? 0] ?? ''}${counter ? '反攻' : '来攻'},${all}为${cd ? generalRef(civ, cd, y) : `${pn(civ, e.b, y)}守军`}所败`;
    }
    // 作者的将领挂帅时战死的是副将
    if (dead) t += `,${authorGeneral(ca) && dead !== ca ? '副将' : ''}${dead.name}战死`;
    for (const x of [ca, cd]) if (x) named.add(x.id);
    return withPeople({ ...base(e, ids[0], t, 2, [e.a, e.b], [e.region]), end: last.year }, ca, cd);
  }
  /**
   * 据险断后(wars.ts 的 stand):败退的一方留一支兵守住山口,挡住追兵,掩护大军撤走。
   * 东方 "昌国军败退,部将李信以八百人守汾州之隘,拒大渭军三日,力战而死;王翦得以收兵退保汾州";
   * 汗国 "…,李信率八百骑扼守汾州山口,挡住大渭军三日,战死;…";
   * 西幻 "…,李信率八百人扼守汾州的山口,挡住大渭大军三天,力战阵亡;王翦得以率主力撤回汾州"。
   * 守将的结局(Annal.cause):力战而死 / 力竭被擒 / 全师而退;没有人物时不写人名。带多少人按这一条随手挑一个说法
   */
  function standChild(i: number): ChronicleEntry {
    const e = A[i];
    const y = e.year;
    const P = polityOf(civ, e.a);
    const east = classical(P);
    const khan = !!P?.eastern && !east;
    const r = regionName(civ, e.region);
    // 大军退保关隘后面的哪州(Annal.foe;没记 = 关隘所在的州)
    const hold = e.foe ?? e.region;
    const back = regionName(civ, hold);
    // 守的口子画在地图上(名关、打过守关战的口子,Place.pass.stands 记着这一条)= 直接写关名("守银竹关");
    // 没对上的照旧用州名称呼。州名里已经带"之"的("羊涂之野")不再叠一个"之":写"羊涂之野隘口"
    const onMap = standPassName(civ, i);
    const pass = onMap || (r ? (east ? nameIf('has', r, '之', `${r}隘口`, `${r}之隘`) : khan ? `${r}山口` : `${r}的山口`) : east ? '险隘' : '山口');
    const s = sideOf(e.a);
    const rear = ix?.rear.get(i) ?? null;
    // 掩护的是这一方的统帅:这一刻以前就在领兵的才写名字(这一刻才换上来的写"大军")
    let lc = s >= 0 ? (ix?.commands.get(e.war)?.find((c) => c.side === s && c.first < i && i <= c.last && !authorGeneral(c.person)) ?? null) : null;
    // 作者的将领挂帅(那一刻不是君主亲征):掩护的是他
    const al = s >= 0 ? ix?.commands.get(e.war)?.find((c) => c.side === s && c.first < i && i <= c.last && authorGeneral(c.person)) : undefined;
    if (al && !(lc && reigningAt(lc.person, y))) lc = al;
    // 领兵的宗室亲自断后(people.ts 的 princeRear):大军没有别人领着,写"大军""主力"
    if (lc && rear && lc.person === rear) lc = null;
    const lead = lc ? (named.has(lc.person.id) && lc.person.role === 'general' ? lc.person.name : generalRef(civ, lc.person, y)) : '';
    const men = STAND_MEN[((Math.imul(Math.max(0, e.region) + 1, 0x9e3779b1) ^ Math.imul(Math.floor(y) + 7 * Math.max(0, e.war), 0x85ebca6b)) >>> 0) % STAND_MEN.length];
    const days = e.n ?? 3;
    const d = `${days === 2 ? '两' : cnNumber(days)}${east || khan ? '日' : '天'}`;
    const how = e.cause === 'captured' ? 1 : e.cause === 'withdrew' ? 2 : 0;
    // 守将:部将写"部将某某";宗室写"皇子某某亲率"
    const prince = !!rear && rear.role !== 'general';
    let t = `${pn(civ, e.a, y)}军败退,`;
    if (east) t += `${rear ? (prince ? `${leaderName(civ, rear, y)}亲率${men}人` : `部将${rear.name}以${men}人`) : `留${men}人`}守${pass},拒${pn(civ, e.b, y)}军${d}`;
    else t += `${rear ? `${prince ? `${leaderName(civ, rear, y)}亲` : rear.name}率${men}${khan ? '骑' : '人'}` : `留下${men}${khan ? '骑' : '人'}`}扼守${pass},挡住${pn(civ, e.b, y)}${khan ? '军' : '大军'}${d}`;
    const ends = rear
      ? east
        ? ['力战而死', '力竭被执', '全师而还']
        : khan
          ? ['战死', '力竭被擒', '全师而还']
          : ['力战阵亡', '力竭被俘', '随后全身而退']
      : east
        ? ['守者尽殁', '守者力竭被执', '全师而还']
        : ['守军全部战死', '守军力竭被俘', '守军随后全身而退'];
    t += `,${ends[how]}`;
    t += east || khan ? `;${lead ? `${lead}得以收兵` : '大军得以'}退保${back || '后方'}` : `;${lead ? `${lead}得以率主力` : '主力得以'}撤回${back || '后方'}`;
    for (const x of [rear, lc?.person]) if (x) named.add(x.id);
    return withPeople(base(e, i, t, 2, [e.a, e.b], [e.region, hold]), rear, lc?.person);
  }

  /**
   * 顿兵过冬(wars.ts 的出兵避冬):要打的那州正在冬天里,攻方的兵顿在那里,开春再打。
   * 东方 "冬,大渭将李牧顿兵瑞州,待春复攻";汗国 "天寒地冻,大渭军在瑞州一带驻冬,待开春再战";
   * 西幻 "天寒地冻,大渭大军在瑞州一带扎营过冬,待开春再攻"。这一刻有统帅领兵的写统帅
   */
  function winterChild(i: number): ChronicleEntry {
    const e = A[i];
    const y = e.year;
    const P = polityOf(civ, e.a);
    const east = classical(P);
    const khan = !!P?.eastern && !east;
    const r = regionName(civ, e.region) || (east ? '边境' : '边境一带');
    const s = sideOf(e.a);
    // 领兵的统帅:这一方在这一条以前接手的最后一位(那时还在世的)。只看以前的事 —— 统帅的任期"到哪一件为止"要等往后的仗才知道,
    // 不按它找,推到这里和推得更远写的一样
    let c: Person | null = null;
    if (s >= 0) for (const m of ix?.commands.get(e.war) ?? []) if (m.side === s && m.first < i && !authorGeneral(m.person)) c = m.person;
    if (c && c.died !== undefined && c.died < y) c = null;
    // 作者的将领这时挂着帅(那一刻不是君主亲征):顿兵的是他
    const al = s >= 0 ? ix?.commands.get(e.war)?.find((m) => m.side === s && m.first < i && m.until >= y && authorGeneral(m.person)) : undefined;
    if (al && !(c && reigningAt(c, y))) c = al.person;
    const who = c ? generalRef(civ, c, y) : `${pn(civ, e.a, y)}${east || khan ? '军' : '大军'}`;
    const at = nameIf('end', r, '一带', r, `${r}一带`);
    const t = east ? `冬,${who}顿兵${r},待春复攻` : khan ? `天寒地冻,${who}在${at}驻冬,待开春再战` : `天寒地冻,${who}在${at}扎营过冬,待开春再攻`;
    if (c) named.add(c.id);
    return withPeople(base(e, i, t, 1, [e.a, e.b], [e.region]), c);
  }

  // 标题:"大渭伐昌,得瑞州等五州";攻方先得后失:"得瑞州等三州而失雪西"(只有攻方的得失不带主语,别的一律点名)
  const parts: string[] = [];
  const got = gainA.length ? `${over ? '' : '已'}得${regionList(civ, gainA)}` : '';
  if (gainD.length) parts.push(`${got ? `${got}而` : '反'}失${regionList(civ, gainD)}`);
  else if (got) parts.push(got);
  // 国都失守:"昌国国都汾城陷落"(不写"昌国失国都",免得和攻方的"失某州"两个"失"说的不是同一方);迁了两次以上:"昌国连迁三都"
  let oldCapital = false;
  for (const [pid, ms] of moves) {
    const p = polityOf(civ, pid);
    if (isGreat(p) && ms.some((e) => capitalHeld(p!, e.year) >= OLD_CAPITAL)) oldCapital = true;
    const who = pn(civ, pid, start);
    if (ms.length >= 2) parts.push(`${who}连迁${ms.length === 2 ? '两' : cnNumber(ms.length)}都`);
    else {
      const lost = p ? cityName(civ, capitalBefore(p, ms[0].year)) : '';
      parts.push(lost ? `${who}国都${lost}陷落` : `${who}国都陷落`);
    }
  }
  for (const f of falls) {
    if (f.cause !== 'surrender') {
      parts.push(`${pn(civ, f.a, f.year)}亡`);
      continue;
    }
    // 破都纳降(wars.ts):"破汾城,昌国余州皆降";打下国都的不是攻方(守方反攻得手):"昌国破渭京,大渭余州皆降"
    const p = polityOf(civ, f.a);
    const city = p ? cityName(civ, capitalBefore(p, f.year)) : '';
    parts.push(`${f.b === atk ? '' : pn(civ, f.b, f.year)}破${city || `${pn(civ, f.a, f.year)}国都`},${pn(civ, f.a, f.year)}余州皆降`);
  }
  if (sworn) parts.push(`${pn(civ, sworn.a, sworn.year)}称臣`);
  // 攻守方国都没打下来:"围汾城不克"(写在得失后面;别的什么都没有:"围汾城不克而还")
  const D0 = polityOf(civ, def);
  const siege = D0
    ? list.find(
        (e) =>
          e.kind === 'battle' &&
          e.a === atk &&
          e.b === def &&
          e.settlement >= 0 &&
          capitalBefore(D0, e.year) === e.settlement &&
          !list.some((c) => c.kind === 'conquer' && c.settlement === e.settlement && c.year >= e.year),
      )
    : undefined;
  const siegeCity = siege ? cityName(civ, siege.settlement) : '';
  // 毁了哪几座城(村镇不说):"毁汾城、瑞城"
  const razed = list.filter((e) => e.kind === 'ruin' && rankBefore(civ, e.settlement, e.year) >= 2).map((e) => cityName(civ, e.settlement));
  if (razed.some(Boolean)) parts.push(`毁${razed.filter(Boolean).slice(0, 2).join('、')}${razed.length > 2 ? '等城' : ''}`);
  if (siegeCity) {
    if (over && !parts.length) parts.push(`围${siegeCity}不克而还`);
    else parts.splice(got || gainD.length ? 1 : 0, 0, `围${siegeCity}不克`);
  }
  if (!over) parts.push('战事未休');
  else if (!parts.length) parts.push('无功而还');
  // 援盟、救藩(邦交;阶段 4 干预的结盟):settlement 列是援的那一国
  const ally = decl.kind === 'war' && decl.settlement >= 0 ? decl.settlement : -1;
  // 有人物的写开战时攻方的统帅:"大渭遣李牧伐昌国,…";君主亲征:"大渭伐昌国,太宗亲征,…"
  // (君主写在国名后面会把"大事"里国名后的来历隔开,所以放到逗号后面)
  const lead = decl.kind === 'war' ? commander(ix, decl.war, 0, ids[list.indexOf(decl)]) : null;
  if (lead && reigningAt(lead, start)) parts.unshift(`${rulerBare(civ, lead, start)}亲征`);
  const head = warHead(civ, decl, ids[list.indexOf(decl)], lead && !reigningAt(lead, start) ? leaderName(civ, lead, start) : '');
  const text = `${head},${parts.join(',')}`;
  // 改变格局的战争是大事:灭了大国(或吞并一个像样的国家)、易手很多州、攻下做了很久的国都、两个帝国交兵且有得失
  const A0 = polityOf(civ, atk);
  const gains = gainA.length + gainD.length;
  const titans = !!A0 && !!D0 && polityTierAt(A0, start) >= TITAN_TIER && polityTierAt(D0, start) >= TITAN_TIER && gains >= TITAN_WAR;
  const conquest = falls.some((f) => {
    const p = polityOf(civ, f.a);
    // 小国分出去(复国)又被原主收回:分出去那一条只在"全部"里,收回来也不算改变格局(易手很多州的照旧是大事)
    const back = !!p && ctx.splitFrom.get(p.id) === f.b;
    // 破都纳降:一仗打下国都、余下的州一并归降,是改变格局的一仗
    return isGreat(p) || (isState(p) && (gains >= FALL_WAR || f.cause === 'surrender') && !back);
  });
  // 毁了大城 / 国都的战争也是大事(毁城那一条单列,但"大事"里由战争说)
  const razedMajor = list.some((e) => e.kind === 'ruin' && ruinImportance(civ, e) >= MAJOR);
  // 大国(到过第 2 档)战败称臣也是大事
  const bowed = !!sworn && isGreat(polityOf(civ, sworn.a));
  const major = conquest || gains >= BIG_WAR || oldCapital || titans || razedMajor || bowed;
  const importance: Importance = major ? 3 : gains > 0 || moves.size > 0 || falls.length > 0 || !!sworn ? 2 : 1;
  const polities = [atk, def];
  for (const e of list) polities.push(e.a, e.b);
  if (ally >= 0) polities.push(ally);
  // 事发地:打下来的州;一州没打下来的,就是没打下来的那几仗的战场
  const sites = fought.length ? fought : uniq(list.filter((e) => e.kind === 'battle' && e.region >= 0).map((e) => e.region));
  return withPeople(
    {
      id: ids[0],
      kind: 'war',
      year: start,
      end,
      text,
      tag: '战',
      importance,
      polities: uniq(polities),
      regions: sites,
      settlement: -1,
      children,
      ongoing: !over,
      head,
    },
    lead,
  );
}

// ---------------------------------------------------------------------------
// 饥荒、民变、大崩解(unrest.ts)

/**
 * 割据、收回、抗命(control.ts):"瑞州守将拥兵自重,割据瑞州等三州,名义上仍奉大渭" /
 * "大渭收回割据二十六年的瑞州" / "大渭与昌国交兵,瑞州守将拥兵不出"(西幻:守将 → 领主)
 */
function lordText(civ: Civ, e: Annal): string {
  const A = pn(civ, e.a, e.year);
  const r = regionName(civ, e.region) || cityName(civ, e.settlement) || '一方';
  const lord = `${r}${polityOf(civ, e.a)?.eastern ? '守将' : '领主'}`;
  if (e.kind === 'warlord') return `${lord}拥兵自重,割据${e.war > 1 ? `${r}等${e.war === 2 ? '两' : cnNumber(e.war)}州` : r},名义上仍奉${A}`;
  if (e.kind === 'reclaim') return e.war >= 1 ? `${A}收回割据${cnNumber(e.war)}年的${r}` : `${A}收回${r}`;
  return `${A}与${pn(civ, e.b, e.year)}交兵,${lord}拥兵不出`;
}

/**
 * 国用不足(control.ts 的钱粮):史事记了主要是因为打仗(war = 0)还是地方拖欠(1);拖欠的那年还在打仗就两样都写。
 * "大霄连年用兵,府库空竭" / "大霄诸州多截留赋税,府库空竭" / "大霄用兵于奥利亚,诸州又多截留赋税,府库空竭"
 */
function fiscalText(civ: Civ, e: Annal, foes: number[]): string {
  const A = pn(civ, e.a, e.year);
  if (e.war === 0) return `${A}连年用兵,府库空竭`;
  if (foes.length) return `${A}用兵于${pn(civ, foes[0], e.year)},诸州又多截留赋税,府库空竭`;
  return `${A}诸州多截留赋税,府库空竭`;
}

/**
 * 议事(council.ts;议题在 war 列,结果在 n 列:0 办成、1 妥协、2 搁置、3 谈崩):写谁推、谁拦、成没成。who = 当时在位的君主(没有人物 = null)。
 * "大渭国用不足,太宗行直征之法,遣官至瑞州等地自收赋税" / "大渭议行直征,瑞州等地豪族力阻,改与地方分成" /
 * "大渭太宗削藩,收回割据四十年的瑞州" / "大渭边地难制,群臣请分封瑞州等边州,太宗不许"(西幻:贵族、领主,写得平实些);
 * 第二批:"大渭太宗收诸将兵权,精兵尽隶禁军" / "大渭议行铨选,瑞州等地豪族力阻,改为铨选、荐举各半" /
 * "大渭太宗分瑞州之镇,守将所领诸州尽归朝廷,只留瑞州一州" / "大渭瑞州守将举所领诸州归附大燕,朝廷不能制"
 * 有了时代做法(practices.ts)以后同一件事换个说法,不另加条目:一国头一回直征、收兵权(禁军)、收任免(铨选)办成,
 * 写"编定户籍,改由官吏按户征税""始置常备之军……不复征发于州郡""始行考选,州县之官由朝廷选授"(推演里这几件要有了户籍、
 * 常备军、文官考选才办得成);国都进了火药时代以后改土归流、罢边镇办成,这国以后再没分封、设边镇的,写"分封之制遂废""边镇之制遂废"
 */
function councilText(civ: Civ, e: Annal, id: number, who: Person | null, ix: PeopleIndex | null = null): string {
  if (isReformIssue(e.war)) return reformCouncilText(civ, e, id, who, ix);
  const y = e.year;
  const A = pn(civ, e.a, y);
  const P = polityOf(civ, e.a);
  const east = !!P?.eastern;
  const r = regionName(civ, e.region) || cityName(civ, e.settlement) || (east ? '边地' : '边境');
  /** "大渭太宗"(没有人物 = 国名)、"太宗"(没有人物 = 空)、"太宗"(没有人物 = "朝廷") */
  const ref = who ? rulerRef(civ, who, y) : A;
  const bare = who ? rulerBare(civ, who, y) : '';
  const court = bare || (east ? '朝廷' : '王室');
  const lord = east ? '守将' : '领主';
  const out = e.n ?? 2;
  switch (e.war) {
    case 0: {
      // 罢直征:原来是直征还是分成(这国上一次办成 / 妥协的直征)
      let half = false;
      for (let i = id - 1; i >= 0; i--) {
        const x = civ.annals[i];
        if (x.kind === 'council' && x.a === e.a && x.war === 2 && (x.n === 0 || x.n === 1)) {
          half = x.n === 1;
          break;
        }
      }
      const old = half ? (east ? '分成之法' : '分成征税') : east ? '直征' : '直接征税';
      if (out === 0) return east ? `${A}${old}所得不抵所费,复由地方代收` : `${A}${old}入不敷出,复由地方代收`;
      return east ? `${A}群臣请罢${old},${court}不许` : `${A}有人请废除${old},${court}不许`;
    }
    case 1: {
      // 削藩:那处割据起了几年(这国在那州最近一次割据)
      let since = NaN;
      for (let i = id - 1; i >= 0; i--) {
        const x = civ.annals[i];
        if (x.kind === 'warlord' && x.a === e.a && x.region === e.region) {
          since = x.year;
          break;
        }
      }
      const n = Math.round(y - since);
      const years = n >= 1 ? `割据${cnNumber(n)}年的` : '';
      if (out === 0) return east ? `${ref}削藩,收回${years}${r}` : `${ref}削夺${r}${lord}之权,收回${years}${r}`;
      if (out === 3) return east ? `${ref}削藩,${r}${lord}不受命` : `${ref}削夺${r}${lord}之权,${lord}举兵抗命`;
      return east ? `${A}议削${r}之藩,恐其生变,事寝` : `${A}议削夺${r}${lord}之权,恐其生变,作罢`;
    }
    case 2: {
      // 直征:国用不足才议的(cause = broke),不然是君主锐意兴革
      const head = e.cause === 'broke' ? `${A}${east ? '国用不足' : '国库空虚'},${bare}` : who ? `${ref}${east ? '锐意兴革,' : '有意革新,'}` : A;
      const foes = `${r}等地${east ? '豪族' : '贵族'}力阻`;
      if (out === 0 && firstDone(civ, id)) return east ? `${head}编定户籍,改由官吏按户征税,遣官至${r}等地` : `${head}编定户籍,改由王室官吏按户征税,派员前往${r}等地`;
      if (out === 0) return east ? `${head}行直征之法,遣官至${r}等地自收赋税` : `${head}改由王室官吏直接征税,派员前往${r}等地`;
      if (out === 1) return east ? `${head}议行直征,${foes},改与地方分成` : `${head}议由王室直接征税,${foes},改为与地方分成`;
      if (out === 3) return east ? `${head}强行直征,${r}${lord}拒不奉诏` : `${head}强推直接征税,${r}${lord}拒不从命`;
      return east ? `${head}议行直征,${foes},事寝` : `${head}议由王室直接征税,${foes},不了了之`;
    }
    case 3: {
      // 改土归流
      if (out === 0 && lastOfKind(civ, id)) return east ? `${ref}改土归流,${r}等边州归朝廷直辖,分封之制遂废` : `${ref}收回边地封授,${r}等地归王室直辖,分封之制就此废止`;
      if (out === 0) return east ? `${ref}改土归流,${r}等边州归朝廷直辖` : `${ref}收回边地封授,${r}等地归王室直辖`;
      if (out === 3) return east ? `${ref}改土归流,${r}${lord}拒不奉诏` : `${ref}收回边地封授,${r}${lord}拒不从命`;
      return east ? `${A}议改土归流,${r}等地土官力阻,事寝` : `${A}议收回边地封授,${r}等地领主力阻,作罢`;
    }
    case 4: {
      // 分封边地
      if (out === 0) return east ? `${A}边地难制,${bare}分封${r}等边州,许其自治,岁纳贡赋` : `${A}边地难治,${bare}将${r}等边地封给当地领主自治,岁纳贡赋`;
      return east ? `${A}边地难制,群臣请分封${r}等边州,${court}不许` : `${A}边地难治,有人请将${r}等边地封给当地领主,${court}不许`;
    }
    case 5: {
      // 收兵权:设了边镇的是罢边镇
      if (before(civ, id).army < 0) {
        if (out === 0 && lastOfKind(civ, id)) return east ? `${ref}罢边镇,${r}等地兵归朝廷,边镇之制遂废` : `${ref}撤销边境军镇,${r}等地兵马重归王室调遣,军镇之制就此废止`;
        if (out === 0) return east ? `${ref}罢边镇,${r}等地兵马归朝廷节制` : `${ref}撤销边境军镇,${r}等地兵马重归王室调遣`;
        if (out === 3) return east ? `${ref}罢边镇,${r}${lord}拥兵不受代` : `${ref}撤销边境军镇,${r}${lord}拥兵抗命`;
        return east ? `${A}议罢边镇,${r}等地边将力阻,事寝` : `${A}议撤销边境军镇,${r}等地将领力阻,作罢`;
      }
      if (out === 0 && firstDone(civ, id)) return east ? `${ref}始置常备之军,收诸将兵权,不复征发于州郡` : `${ref}始置常备之军,收回各地领主的兵权,不复征发于州郡`;
      if (out === 0) return east ? `${ref}收诸将兵权,精兵尽隶禁军` : `${ref}收回各地领主的兵权,组建王室常备军`;
      if (out === 1) return east ? `${A}议收兵权,${r}等地守将力阻,改遣监军` : `${A}议收回各地兵权,${r}等地领主力阻,改为派员监军`;
      if (out === 3) return east ? `${ref}欲收兵权,${r}${lord}拥兵抗命` : `${ref}要收回兵权,${r}${lord}举兵抗命`;
      return east ? `${A}议收兵权,${r}等地守将力阻,事寝` : `${A}议收回各地兵权,${r}等地领主力阻,作罢`;
    }
    case 6: {
      // 放兵权:收着兵权的是罢禁军,不然是设边镇
      if (before(civ, id).army > 0) {
        if (out === 0) return east ? `${A}禁军所费不赀,罢之,复由州郡征发` : `${A}常备军开销太大,就此裁撤,复由各地征兵`;
        return east ? `${A}群臣请罢禁军,${court}不许` : `${A}有人请裁撤常备军,${court}不许`;
      }
      if (out === 0) return east ? `${A}边事日繁,${bare}置边镇于${r}等地,许边将专兵、自筹军饷` : `${A}边境多事,${bare}在${r}等地设立军镇,由边将自行募兵筹饷`;
      return east ? `${A}群臣请置边镇于${r}等地,${court}不许` : `${A}有人请在${r}等地设立军镇,${court}不许`;
    }
    case 7: {
      // 收任免:许了自辟的是收回辟署
      if (before(civ, id).office < 0) {
        if (out === 0) return east ? `${ref}收回州郡辟署之权,${r}等地长吏复由朝廷选派` : `${ref}收回地方自选官员之权,${r}等地官员复由王室任命`;
        if (out === 3) return east ? `${ref}收辟署之权,${r}豪族据城抗命` : `${ref}收回地方自选官员之权,${r}贵族据城抗命`;
        return east ? `${A}议收辟署之权,${r}等地豪族力阻,事寝` : `${A}议收回地方自选官员之权,${r}等地贵族力阻,作罢`;
      }
      if (out === 0 && firstDone(civ, id)) return east ? `${ref}始行考选,州县之官由朝廷选授,${r}等地长吏不复由豪族世守` : `${ref}始行考选,州县之官由王室选授,${r}等地不再由贵族把持`;
      if (out === 0) return east ? `${ref}行铨选之法,${r}等地长吏皆由朝廷选派` : `${ref}改由王室任命各地官员,${r}等地不再由贵族把持`;
      if (out === 1) return east ? `${A}议行铨选,${r}等地豪族力阻,改为铨选、荐举各半` : `${A}议由王室任命各地官员,${r}等地贵族力阻,改为王室和贵族各任一半`;
      if (out === 3) return east ? `${ref}强行铨选,${r}豪族据城抗命` : `${ref}强行任命地方官员,${r}贵族据城抗命`;
      return east ? `${A}议行铨选,${r}等地豪族力阻,事寝` : `${A}议由王室任命各地官员,${r}等地贵族力阻,不了了之`;
    }
    case 8: {
      // 放任免:铨选着的是罢铨选,不然是许自辟
      if (before(civ, id).office > 0) {
        if (out === 0) return east ? `${A}冗官所费不赀,罢铨选之法,复许州郡荐举` : `${A}官员开销太大,不再由王室任命,复由地方推举`;
        return east ? `${A}群臣请罢铨选,${court}不许` : `${A}有人请废除王室任命官员之制,${court}不许`;
      }
      if (out === 0) return east ? `${A}国用不足,地方多事,${bare}许${r}等州郡自辟僚属,豪族世守其地` : `${A}国库空虚,地方不宁,${bare}准许${r}等地贵族自选官员、世袭其职`;
      return east ? `${A}群臣请许州郡自辟僚属,${court}不许` : `${A}有人请准许地方贵族自选官员,${court}不许`;
    }
    case 9: {
      // 改组(分镇)
      if (out === 0) return east ? `${ref}分${r}之镇,${lord}所领诸州尽归朝廷,只留${r}一州` : `${ref}拆分${r}领主的领地,只给他留下${r}一地`;
      if (out === 1) return east ? `${ref}议分${r}之镇,${lord}力争,析其半归朝廷` : `${ref}议拆分${r}领主的领地,领主力争,只收回一半`;
      if (out === 3) return east ? `${ref}议分${r}之镇,${r}${lord}不受命` : `${ref}拆分${r}领主的领地,${lord}举兵抗命`;
      return east ? `${A}议分${r}之镇,恐其生变,事寝` : `${A}议拆分${r}领主的领地,恐其生变,作罢`;
    }
    default: {
      // 脱离:地方提的(b = 想转投的邻国);谈崩的后面紧跟着自立那一条
      const B = pn(civ, e.b, y);
      if (out === 0) return east ? `${A}${r}${lord}举所领诸州归附${B},朝廷不能制` : `${A}的${r}${lord}率领地改投${B},${court}无力阻止`;
      if (out === 3) return east ? `${A}${r}${lord}欲以所领诸州归附${B},${court}不许,遂举兵` : `${A}的${r}${lord}想改投${B},${court}不准,${lord}举兵抗命`;
      return east ? `${A}${r}${lord}欲以所领诸州归附${B},朝廷遣使抚谕,事寝` : `${A}的${r}${lord}想改投${B},王室派人安抚,作罢`;
    }
  }
}

// ---------------------------------------------------------------------------
// 改制(reform.ts):立宪、扩大参与、废君立共和、还政(议事),革命、政变、复辟(史事 reform)

/** 窘境写到几年以前 */
const WOE_YEARS = 30;

/** 某国此刻(第 id 条史事之前 WOE_YEARS 年里)的窘境:"连年兵败,府库空竭""大疫之后国用不足";没有 = 空串 */
function woeOf(civ: Civ, p: number, id: number): string {
  const A = civ.annals;
  const y = A[id]?.year ?? civ.endYear;
  let lost = 0;
  let broke = false;
  let plague = false;
  for (let k = id - 1; k >= 0 && y - A[k].year < WOE_YEARS; k--) {
    const a = A[k];
    if (a.kind === 'conquer' && a.b === p && a.war >= 0) lost++;
    else if (a.kind === 'fiscal' && a.a === p) broke = true;
    else if (a.kind === 'plague' && a.a === p && (a.cause === 'great' || a.cause === 'pandemic')) plague = true;
  }
  const out: string[] = [];
  if (lost >= 2) out.push('连年兵败');
  else if (lost) out.push('兵败失地');
  if (plague) out.push(broke ? '大疫之后国用不足' : '大疫之后');
  else if (broke) out.push('府库空竭');
  return out.join(',');
}

/** 议事的地方:设了议会的东方写"议院"、西幻写"议会",没设的写"议事会"(year 这一刻以后的规矩) */
function bodyOf(civ: Civ, p: number, year: Year): string {
  if (rulesAt(civ.annals, p, year).charter < 2) return '议事会';
  return polityOf(civ, p)?.eastern ? '议院' : '议会';
}

/** 君位的叫法:东方"帝制"(王国"王位"),西幻"王位""帝位",汗国"汗位" */
function throneWord(P: Polity | null, y: Year): string {
  const tier = P ? polityTierAt(P, y) : 2;
  if (P?.lineage === 'khanate') return '汗位';
  if (P?.eastern) return tier >= 3 ? '帝制' : '王位';
  return tier >= 3 ? '帝位' : '王位';
}

/** 不复独断的那位:东方"天子"(王国"国君"),西幻"国王""皇帝",汗国"可汗" */
function sovereignWord(P: Polity | null, y: Year): string {
  const tier = P ? polityTierAt(P, y) : 2;
  if (P?.lineage === 'khanate') return '可汗';
  if (P?.eastern) return tier >= 3 ? '天子' : '国君';
  return tier >= 3 ? '皇帝' : '国王';
}

/** 能议政的人多到哪一档的说法(扩大参与) */
const FRANCHISE_WHO = ['王族贵族', '有产者', '男子', '成年人'];

/** 改制的议事(立宪、扩大参与、废君立共和、还政)正文;办成的立宪、废君、还政单列一条(reformDoneEntry),这里多半写妥协、搁置 */
function reformCouncilText(civ: Civ, e: Annal, id: number, who: Person | null, ix: PeopleIndex | null): string {
  const y = e.year;
  const A = pn(civ, e.a, y);
  const P = polityOf(civ, e.a);
  const east = !!P?.eastern;
  const ref = who ? rulerRef(civ, who, y) : A;
  const out = e.n ?? 2;
  const woe = woeOf(civ, e.a, id);
  const lead = woe ? `${A}${woe},` : A;
  const stop = east ? '守旧之臣力阻,事寝' : '守旧的大臣力阻,作罢';
  switch (e.war) {
    case Issue.Charter:
      if (out === 0) return reformDoneText(civ, e, ix);
      if (out === 1) return east ? `${ref}下诏设议事会,国事先咨议事会,君权照旧` : `${ref}设议事会,大事先咨议事会,王权照旧`;
      return `${lead}群臣请立宪,${stop}`;
    case Issue.Widen: {
      // 海洋城邦共和一系本来就有产者能议政(和政体那三条一样,polityForm.ts 的 formDims)
      const to = rulesAt(civ.annals, e.a, y).franchise + (P?.lineage === 'republic' ? 1 : 0);
      const body = bodyOf(civ, e.a, y);
      const whom = FRANCHISE_WHO[Math.max(1, Math.min(3, out === 0 ? to : to + 1))];
      const verb = whom === '有产者' ? '入' : '皆得推举';
      if (out === 0) return `${A}许${whom}${verb}${body},与闻国事`;
      return `${A}议许${whom}${verb}${body},议不合,${east ? '事寝' : '作罢'}`;
    }
    case Issue.Abolish:
      if (out === 0) return reformDoneText(civ, e, ix);
      if (out === 1) return `${lead}议废${throneWord(P, y)},不成,改设议事会,君权稍减`;
      return `${lead}议废${throneWord(P, y)},${stop}`;
    default:
      // 还政(军政府交还议事会)
      if (out === 0) return reformDoneText(civ, e, ix);
      return `${A}议还政于议事会,${who ? `执政${who.name}` : '将领'}不许,${east ? '事寝' : '作罢'}`;
  }
}

/** 办成的立宪、废君立共和、还政 */
function reformDoneText(civ: Civ, e: Annal, ix: PeopleIndex | null): string {
  const y = e.year;
  const A = pn(civ, e.a, y - 1 / 512);
  const P = polityOf(civ, e.a);
  const east = !!P?.eastern;
  if (e.war === Issue.Charter) {
    const who = reigning(ix, e.a, y);
    const ref = who ? rulerRef(civ, who, y) : A;
    const body = east ? '议院' : '议会';
    return `${ref}${east ? '下诏立宪' : '颁行宪章'},开${body},国事经${body}议定,${sovereignWord(P, y)}不复独断`;
  }
  const body = bodyOf(civ, e.a, y);
  const old = endedAt(ix, e.a, y);
  if (e.war === Issue.Return) return `${A}议还政,议成:${old ? `执政${old.name}去位,` : ''}国事复由${body}议定、推举执政`;
  // 废君立共和:"博戈维纳王国议废王位,议成:国王斯坦波尔克逊位,国事改由议事会议定、推举执政,国号改称博戈维纳共和国"
  const tier = Math.max(1, P ? polityTierAt(P, y - 1 / 512) : 2);
  const king = old ? (east ? rulerBare(civ, old, y) : `${westRank(old, P?.lineage, tier)}${old.name}`) : '';
  return `${A}议废${throneWord(P, y - 1 / 512)},议成:${king ? `${king}逊位,` : ''}国事改由${body}议定、推举执政,国号改称${pn(civ, e.a, y)}`;
}

/** 改制办成的那一条(立宪,改制:废君立共和、还政):蓝色 */
function reformDoneEntry(ctx: Ctx, e: Annal, id: number): ChronicleEntry {
  const { civ } = ctx;
  const y = e.year;
  const imp = isGreat(polityOf(civ, e.a)) ? 3 : 2;
  const text = reformDoneText(civ, e, ctx.ix);
  const who = e.war === Issue.Charter ? reigning(ctx.ix, e.a, y) : endedAt(ctx.ix, e.a, y);
  return withPeople(base(e, id, text, imp, [e.a], [e.region], e.war === Issue.Charter ? '宪' : '制'), who && text.includes(who.name) ? who : null);
}

/** 议立宪 / 废君谈崩、紧跟着起兵(革命、据地自立):议事那一条并进起兵那一条 */
function revolutionAfter(A: readonly Annal[], i: number): boolean {
  const e = A[i];
  const n = A[i + 1];
  if (e.kind !== 'council' || e.n !== 3 || (e.war !== Issue.Charter && e.war !== Issue.Abolish) || !n || n.year !== e.year) return false;
  return (n.kind === 'reform' && n.n === REFORM_REVOLUTION && n.a === e.a) || (n.kind === 'split' && n.cause === 'revolution' && n.b === e.a);
}

/** 议什么不成(起兵那一条的开头):"议废帝制,不成;""议立宪,不成;" */
function failedAsk(civ: Civ, A: readonly Annal[], i: number, p: number): string {
  const c = A[i - 1];
  if (!c || c.kind !== 'council' || c.a !== p || c.year !== A[i].year) return '';
  return c.war === Issue.Charter ? '议立宪,不成;' : `议废${throneWord(polityOf(civ, p), c.year)},不成;`;
}

/** 史事 reform:革命(红)、政变(红)、复辟(蓝) */
function reformEntry(ctx: Ctx, e: Annal, id: number): ChronicleEntry {
  const { civ } = ctx;
  const y = e.year;
  const P = polityOf(civ, e.a);
  const east = !!P?.eastern;
  const before = pn(civ, e.a, y - 1 / 512);
  const after = pn(civ, e.a, y);
  const nu = founderOf(ctx.ix, e.a, P ? dynastyIndexAt(P, y) : 0);
  const old = endedAt(ctx.ix, e.a, y);
  const woe = woeOf(civ, e.a, id);
  const capital = P ? cityName(civ, capitalBefore(P, y)) : '';
  const imp = isGreat(P) ? 3 : 2;
  const entry = (text: string, tag: string, kind: EntryKind, ...ps: (Person | null)[]) => {
    const x = base(e, id, text, imp, [e.a], [e.region], tag);
    x.kind = kind;
    return withPeople(x, ...ps.filter((z) => !!z && text.includes(z.name)));
  };
  if (e.n === REFORM_REVOLUTION) {
    // "大靖王朝兵败失地,议废帝制,不成;田继徽起兵于玉舞之野,入桂陵,废光宗,罢帝号,立共和,国号大靖共和国,自为执政"
    const r = regionName(civ, e.region);
    const king = old ? (east ? rulerBare(civ, old, y) : old.name) : '';
    let t = `${before}${woe ? `${woe},` : ''}${failedAsk(civ, civ.annals, id, e.a)}`;
    t += `${nu ? nu.name : east ? '义军' : '起义者'}起兵${r ? `于${r}` : ''}${capital ? `,入${capital}` : ''}${king ? `,废${king}` : ''}`;
    t += `${east ? `,罢${P && polityTierAt(P, y - 1 / 512) >= 3 ? '帝' : '王'}号` : ''},立共和,国号${after}${nu ? ',自为执政' : ''}`;
    return entry(t, '革', 'revolution', nu, old);
  }
  if (e.n === REFORM_COUP) {
    // "博戈维纳共和国大疫之后国用不足,议事会久议不决;将军米列斯拉娃率兵入莫尔格勒,散议事会,自为执政,国事决于军中"
    const body = bodyOf(civ, e.a, y - 1 / 512);
    const t = `${before}${woe ? `${woe},` : ''}${body}久议不决;将军${nu ? nu.name : ''}率兵入${capital || '国都'},散${body},自为执政,国事决于军中`;
    return entry(t, '政', 'coup', nu, old);
  }
  // 复辟
  const head = woe ? `${before}${woe};` : before;
  if (e.b >= 0) {
    // "大靖共和国连年兵败,府库空竭;宗室、旧臣迎光宗之子蔡安钧即位,罢共和,复称大靖王朝"
    const rs = ctx.ix?.rulers[e.a] ?? [];
    let last: Person | undefined;
    for (let k = rs.length - 1; k >= 0 && !last; k--) if ((rs[k].from ?? Infinity) < y && P && royalSeg(P, rs[k].dynasty ?? 0)) last = rs[k];
    const kin = nu && last ? (nu.parent === last.id ? `之${childWord(nu)}` : '之后') : '';
    const lastRef = last ? (east ? rulerBare(civ, last, y) : last.name) : '';
    const t = `${head}${woe ? '' : ','}${east ? '宗室、旧臣' : '王党'}迎${lastRef ? `${lastRef}${kin}` : '旧王室之后'}${nu ? nu.name : ''}即位,罢共和,复称${after}`;
    return entry(t, '辟', 'reform', nu, last ?? null);
  }
  // 旧王室没人了:执政 / 将军自立为君,当成换了一朝
  const rank = east ? (P && polityTierAt(P, y) >= 3 ? '帝' : '王') : nu ? westRank(nu, P?.lineage, Math.max(1, P ? polityTierAt(P, y) : 2)) : '王';
  const same = !!P && polityRootAt(P, y) === polityRootAt(P, y - 1 / 512);
  const ruler = P && reformedSeg(P, P ? dynastyIndexAt(P, y - 1 / 512) : 0) ? '执政' : '将军';
  const t = `${head}${woe ? '' : ','}${ruler}${nu ? nu.name : ''}废${bodyOf(civ, e.a, y - 1 / 512)},自立为${rank},国号${same ? '复称' : '改称'}${after}`;
  return entry(t, '辟', 'reform', nu);
}

/** 革命起兵打不进国都、据地自立:"大靖王朝议废帝制,不成;田继徽据玉舞之野自立,号玉舞共和国,都于某城" */
function revolutionSplitEntry(ctx: Ctx, e: Annal, id: number): ChronicleEntry {
  const { civ } = ctx;
  const y = e.year;
  const woe = woeOf(civ, e.b, id);
  const lead = founderOf(ctx.ix, e.a, 0);
  const r = regionName(civ, e.region);
  const city = cityName(civ, e.settlement);
  let t = `${pn(civ, e.b, y)}${woe ? `${woe},` : ''}${failedAsk(civ, civ.annals, id, e.b)}${lead ? lead.name : '起事的人'}${r ? `据${r}` : ''}自立,号${pn(civ, e.a, y)}`;
  if (city) t += `,都于${city}`;
  const x = base(e, id, t, isGreat(polityOf(civ, e.a)) || isGreat(polityOf(civ, e.b)) ? 3 : 2, [e.a, e.b], [e.region], '革');
  x.kind = 'revolution';
  return withPeople(x, lead);
}

/**
 * 改制那一条的正文(朝政页「历次改制」用,和编年史里那一条一样):第 id 条史事是议事(立宪、废君、还政、扩大参与)、
 * 改制(革命、政变、复辟)或革命据地自立(split,cause = revolution);别的 = 空串
 */
export function reformText(civ: Civ, id: number): string {
  const e = civ.annals[id];
  if (!e) return '';
  const ctx = { civ, ix: peopleOf(civ) } as Ctx;
  if (e.kind === 'reform') return reformEntry(ctx, e, id).text;
  if (e.kind === 'split' && e.cause === 'revolution') return revolutionSplitEntry(ctx, e, id).text;
  if (e.kind === 'council' && isReformIssue(e.war)) return councilText(civ, e, id, reigning(ctx.ix, e.a, e.year), ctx.ix);
  return '';
}

/** 各条议事议之前那国的军制、官制(council.ts 的 councilBefore;按史事数组缓存,接着推长了就重算) */
const beforeCache = new WeakMap<readonly Annal[], ReturnType<typeof councilBefore>>();
function before(civ: Civ, id: number): { army: number; office: number } {
  let b = beforeCache.get(civ.annals);
  if (!b || b.length !== civ.annals.length) beforeCache.set(civ.annals, (b = councilBefore(civ.annals)));
  return b[id] ?? { army: 0, office: 0 };
}

/**
 * 时代做法换说法要用的(按史事数组缓存,接着推长了就重算):
 * first:一国头一回办成的直征、收兵权(禁军,不算罢边镇)、收任免(铨选,不算收回辟署)那几条议事;
 * last:国都进了火药时代(做法表的"封镇渐废")以后办成的改土归流、罢边镇,这国以后再没分封、设边镇的那几条
 */
const practiceCache = new WeakMap<readonly Annal[], { n: number; first: Set<number>; last: Set<number> }>();
function practiceMarks(civ: Civ): { first: Set<number>; last: Set<number> } {
  const A = civ.annals;
  const hit = practiceCache.get(A);
  if (hit && hit.n === A.length) return hit;
  const first = new Set<number>();
  const last = new Set<number>();
  const seen = new Set<string>();
  /** 罢边镇 / 改土归流办成的那条,等着看这国以后还设不设边镇、分不分封 */
  const open = new Map<string, number>();
  A.forEach((e, i) => {
    if (e.kind !== 'council' || e.n !== 0) return;
    const b = before(civ, i);
    // 直征(2)、收兵权(5,议之前不是边镇)、收任免(7,议之前不是自辟)
    if (e.war === 2 || (e.war === 5 && b.army >= 0) || (e.war === 7 && b.office >= 0)) {
      const key = `${e.a}:${e.war}`;
      if (!seen.has(key)) {
        seen.add(key);
        first.add(i);
      }
    }
    // 改土归流(3)、罢边镇(5,议之前是边镇);以后又分封(4)、设边镇(6,议之前是征发)的,上一条不算废
    if (e.war === 3 || (e.war === 5 && b.army < 0)) {
      if (hasPractice(practicesAt(civ, e.a, e.year) ?? 0, Practice.FiefLess)) open.set(`${e.a}:${e.war}`, i);
    } else if (e.war === 4) open.delete(`${e.a}:3`);
    else if (e.war === 6 && b.army === 0) open.delete(`${e.a}:5`);
  });
  for (const i of open.values()) last.add(i);
  const m = { n: A.length, first, last };
  practiceCache.set(A, m);
  return m;
}
const firstDone = (civ: Civ, id: number) => practiceMarks(civ).first.has(id);
const lastOfKind = (civ: Civ, id: number) => practiceMarks(civ).last.has(id);

/** 一州闹饥荒(地震水旱:cause = quake)时城里的人口折损(Settlement.sacks 里同一种、同一年的那一条;找不到 = 0) */
function famineLoss(civ: Civ, e: Annal): number {
  const s = e.settlement >= 0 ? civ.settlements[e.settlement] : undefined;
  const cause = e.cause === 'quake' ? 'quake' : 'famine';
  return s?.sacks?.find((k) => k.cause === cause && k.year === e.year)?.loss ?? 0;
}

/** "死者十之二"(按灾最重那州城里的折损;一成以下的不写);三成以上的加"人相食" */
function famineToll(loss: number): string {
  const k = Math.round(loss * 10);
  if (k < 1) return '';
  return `${k >= 3 ? ',人相食' : ''},死者十之${cnNumber(k)}`;
}

/**
 * 饥荒:"大渭瑞州等三州大饥,死者十之二"(标签"饥");冬夏分明的地方闹的春荒(cause = spring)前面写"春,"。
 * 「天灾」多 / 很多时自己发生的地震水旱(cause = quake,没有干预那一条可并):"大渭瑞州一带地震,城郭多圮,死者十之二"
 */
function famineText(civ: Civ, e: Annal): string {
  const r = regionName(civ, e.region) || cityName(civ, e.settlement);
  if (e.cause === 'quake') {
    const s = e.settlement >= 0 ? civ.settlements[e.settlement] : undefined;
    const from = s?.sacks?.find((k) => k.cause === 'quake' && k.year === e.year)?.from ?? e.region;
    const word = from >= 0 ? quakeWord(civ.regions, from) : '地震';
    const what = word === '大水' ? '大水,漂没城郭' : word === '大旱' ? '大旱,赤地千里' : '地震,城郭多圮';
    const k = Math.round(famineLoss(civ, e) * 10);
    return `${e.a >= 0 ? pn(civ, e.a, e.year) : ''}${r || '境内'}一带${what}${e.b > 1 ? `,${cnNumber(e.b)}州受灾` : ''}${k >= 1 ? `,死者十之${cnNumber(k)}` : ''}`;
  }
  const where = e.b > 1 ? `${r || '诸州'}等${cnNumber(e.b)}州` : r || '境内';
  return `${e.cause === 'spring' ? '春,' : ''}${e.a >= 0 ? pn(civ, e.a, e.year) : ''}${where}大饥${famineToll(famineLoss(civ, e))}`;
}

/**
 * 民变(史事 revolt + 讨伐它的那场战争)写成一条:"瑞州大饥,饥民奉李昭为主,据瑞城起事,号瑞国,叛大渭"
 * 再写结局:"旋为大渭所平"("十二年后为大渭所平")/ "攻破汾城,大渭亡"(大事)/ "得汾州等三州,与大渭议和,割据一方"/ "战事未休"。
 * 标签"起";子条目是那场战争的每一件事(讨伐、攻占、战役、议和、亡国)。攻破都城、亡了原来国家的是大事
 */
function revoltEntry(ctx: Ctx, ids: number[]): ChronicleEntry {
  const { civ } = ctx;
  const A = civ.annals;
  const e = A[ids[0]];
  const y = e.year;
  const rebel = e.a;
  const court = e.b;
  const war = warEntry(ctx, ids.slice(1));
  const list = ids.map((i) => A[i]);
  const r = regionName(civ, e.region);
  const city = cityName(civ, e.settlement);
  const lead = founderOf(ctx.ix, rebel, 0);
  const who = lead && lead.rise === 'rebel' ? lead : null;
  const t = `${r || city || '境内'}大饥,饥民${who ? `奉${who.name}为主,` : ''}${city ? `据${city}起事` : '起事'},号${pn(civ, rebel, y)},叛${pn(civ, court, y)}`;
  const fallR = list.find((f) => f.kind === 'fall' && f.a === rebel);
  const fallC = list.find((f) => f.kind === 'fall' && f.a === court && f.b === rebel);
  const peace = list.find((f) => f.kind === 'peace');
  let outcome: string;
  if (fallC) {
    const C = polityOf(civ, court);
    const cap = C ? cityName(civ, capitalBefore(C, fallC.year)) : '';
    const n = Math.floor(fallC.year) - Math.floor(y);
    outcome = `${n >= 2 ? `${n} 年后` : ''}攻破${cap || '都城'},${pn(civ, court, fallC.year)}亡`;
  } else if (fallR) {
    const n = Math.floor(fallR.year) - Math.floor(y);
    outcome = `${n >= 2 ? `${n} 年后` : '旋'}为${pn(civ, court, fallR.year)}所平`;
  } else if (peace) {
    // 净得的州:最后是起事的一方打下来的
    const lastBy = new Map<number, number>();
    for (const c of list) if (c.kind === 'conquer' && c.region >= 0) lastBy.set(c.region, c.a);
    const got = [...lastBy].filter(([, by]) => by === rebel).map(([q]) => q);
    outcome = `${got.length ? `得${regionList(civ, got)},` : ''}与${pn(civ, court, peace.year)}议和,割据一方`;
  } else outcome = '战事未休';
  const polities = uniq([rebel, court, ...war.polities]);
  return withPeople(
    {
      ...war,
      id: ids[0],
      kind: 'revolt',
      year: y,
      text: `${t},${outcome}`,
      tag: '起',
      importance: fallC ? 3 : 2,
      polities,
      regions: uniq([e.region, ...war.regions]),
      settlement: e.settlement,
      head: undefined,
      // 只记句子里写到的人(讨伐的统帅写在子条目里)
      people: undefined,
    },
    who,
  );
}

/** 紧跟在大崩解后面、并进那一条的:那几块自立(split,cause = collapse) */
function collapseTail(e: Annal, head: Annal): boolean {
  return e.year === head.year && e.kind === 'split' && e.cause === 'collapse' && e.b === head.a;
}

/**
 * 大崩解:"大渭大乱,瑞州、汾州、雪西各自立国,大渭仅保汾城一隅"(地方崩加"诸州残破";散回部落:"大渭土崩瓦解,
 * 二十三州散为部落,大渭仅保汾城一隅")。标签"崩",一律是大事;子条目是各块自立("瑞州守将李昭叛大渭自立,号瑞国,都于瑞城")
 */
function collapseEntry(ctx: Ctx, ids: number[]): ChronicleEntry {
  const { civ } = ctx;
  const A = civ.annals;
  const e = A[ids[0]];
  const y = e.year;
  const P = pn(civ, e.a, y);
  const city = cityName(civ, e.settlement) || regionName(civ, e.region);
  const keep = city ? `,${P}仅保${city}一隅` : '';
  const pieces = ids.slice(1).map((i) => A[i]);
  const children = ids.slice(1).map((i) => simpleEntry(ctx, A[i], i));
  // 大迁徙迁来的一支打进国都引起的(同一刻、紧挨在前面几条里有 trek n = 3):"萨热汗国破星邑,百尾皇朝大崩解,……各自立国"
  let storm: Annal | undefined;
  for (let i = ids[0] - 1; i >= 0 && A[i].year === y; i--) {
    if (A[i].kind === 'trek' && A[i].n === 3 && A[i].b === e.a) {
      storm = A[i];
      break;
    }
  }
  const civM = storm ? civ.migrations?.[storm.war]?.polity : undefined;
  const lead = storm && civM !== undefined ? `${pn(civ, civM, y)}破${cityName(civ, storm.settlement) || regionName(civ, storm.region) || '其都'},` : '';
  let text: string;
  if (e.b === 2) text = lead ? `${lead}${P}土崩瓦解,${e.war > 0 ? `${cnNumber(e.war)}州` : '诸州'}散为部落${keep}` : `${P}土崩瓦解,${e.war > 0 ? `${cnNumber(e.war)}州` : '诸州'}散为部落${keep}`;
  else {
    const names = uniq(pieces.map((s) => s.region)).map((r) => regionName(civ, r)).filter(Boolean);
    const rose = names.length ? `${names.join('、')}各自立国` : '诸州各自立国';
    text = lead ? `${lead}${P}大崩解,${e.b === 1 ? '诸州残破,' : ''}${rose}${keep}` : `${P}大乱,${e.b === 1 ? '诸州残破,' : ''}${rose}${keep}`;
  }
  return {
    ...base(e, ids[0], text, 3, uniq([...(civM !== undefined ? [e.a, civM] : [e.a]), ...pieces.map((s) => s.a)]), uniq(pieces.map((s) => s.region))),
    ...(children.length ? { children } : {}),
  };
}

/** 大瘟疫染了至少这么多州才写成"天下大疫" */
const GREAT_WRITE = 30;

/** "死者十之二"(大瘟疫"十之三四");不到一成的不写 */
function plagueToll(loss: number, great: boolean): string {
  const k = Math.round(loss * 10);
  if (k < 1) return '';
  return `死者十之${cnNumber(k)}${great && k < 9 ? cnNumber(k + 1) : ''}`;
}

/**
 * 瘟疫(plague.ts;同一场的几条史事 plague 折成一条):"大疫起于维罗拉,传至特罗纳、哈尔兰、碧台等地,5 年间诸国死者十之二"
 * (只在一国:"…,5 年间大渭死者十之一";没传开:"大渭维罗拉大疫,死者十之一";大瘟疫染了 GREAT_WRITE 州以上:"天下大疫,起于维罗拉,
 * 传至…等五国四十州,12 年乃息(起疫那年也算一年),死者十之三四")。死几成按染疫各城的平均。标签"疫";大瘟疫、传到三国以上、死者十之二以上的是大事。
 * 子条目是逐年传到哪("大渭维罗拉起疫""疫传至大渭瑞州等三州")
 */
function plagueEntry(ctx: Ctx, ids: number[]): ChronicleEntry {
  const { civ } = ctx;
  const A = civ.annals;
  const e = A[ids[0]];
  const span = plagueSpans(civ).find((x) => x.id === e.war);
  const hits = span?.hits ?? [];
  // 大瘟疫没传开的(港口孤悬、头几年就止住了)照一般的大疫写
  const great = e.cause === 'great' && hits.length >= GREAT_WRITE;
  const mean = hits.length ? hits.reduce((a, h) => a + h.loss, 0) / hits.length : 0;
  const toll = plagueToll(mean, great);
  const end = Math.max(A[ids[ids.length - 1]].year, span?.end ?? e.year);
  const origin = cityName(civ, e.settlement) || regionName(civ, e.region) || '一城';
  const list = ids.map((i) => A[i]);
  const polities = uniq(list.map((x) => x.a).filter((p) => p >= 0));
  // 传到哪:后来几条各写死得最多的那城(和起疫的不重名),最多三处
  const places: string[] = [];
  for (const x of list.slice(1)) {
    const n = cityName(civ, x.settlement) || regionName(civ, x.region);
    if (n && n !== origin && !places.includes(n)) places.push(n);
  }
  const shown = places.slice(0, 3).join('、');
  const more = places.length > 3 ? '等地' : '';
  // 闹了几个年头(起疫那年、最后染上的那年都算)
  const years = Math.floor(end) - Math.floor(e.year) + 1;
  let text: string;
  if (great) {
    // "天下"留给全球大疫(pandemicEntries):大瘟疫只传一片
    const where = shown ? `,传至${shown}等${polities.length > 1 ? `${cnNumber(polities.length)}国` : ''}${cnNumber(hits.length)}州` : '';
    text = `大疫,起于${origin}${where}${years >= 2 ? `,${years} 年乃息` : ''}${toll ? `,${toll}` : ''}`;
  } else if (!shown) text = `${pn(civ, e.a, e.year)}${origin}大疫${toll ? `,${toll}` : ''}`;
  else {
    const who = polities.length > 1 ? '诸国' : pn(civ, e.a, e.year);
    text = `大疫起于${origin},传至${shown}${more}${toll ? `,${years >= 2 ? `${years} 年间` : ''}${who}${toll}` : ''}`;
  }
  const children =
    ids.length > 1
      ? ids.map((i, n) => {
          const x = A[i];
          const r = regionName(civ, x.region) || cityName(civ, x.settlement) || '一州';
          const where = x.b > 1 ? `${r}等${cnNumber(x.b)}州` : r;
          return base(x, i, n === 0 ? `${pn(civ, x.a, x.year)}${origin}起疫` : `疫传至${pn(civ, x.a, x.year)}${where}`, 1, [x.a], [x.region]);
        })
      : undefined;
  const big = great || polities.length >= 3 || mean >= 0.195;
  return {
    // 点这一条时标出染过疫的每一州(史事一国一年只记死得最多的那州)
    ...base(e, ids[0], text, big ? 3 : 2, polities, uniq([...list.map((x) => x.region), ...hits.map((h) => h.region)])),
    end,
    ...(children ? { children } : {}),
  };
}

/** 全球大疫:一块陆地上有这么多州才算一"洲"(传遍几洲只数这样的) */
const CONTINENT_REGIONS = 12;

/** 第 year 年天下人口(千人;各州的城 + 乡村) */
function worldPopulationAt(civ: Civ, year: Year): number {
  let sum = 0;
  for (let r = 0; r < civ.regions.count; r++) sum += regionPopulationAt(civ, r, year);
  return sum;
}

/** "六十余处"(二十以上按十取整;整十的不写"余")、"十三处" */
function placeCount(n: number): string {
  if (n < 20) return `${cnNumber(n)}处`;
  const tens = Math.floor(n / 10) * 10;
  return `${cnNumber(tens)}${n > tens ? '余' : ''}处`;
}

/**
 * 全球大疫(pandemic.ts;史事 pandemic 和同一场的几条 plague):
 * "克尔顿大疫:起于克尔顿,循航线传遍四洲,至五百六十一州,9 年乃息。城中死者十之四五,天下人口十去其二"(大事,标签"疫";
 * 子条目是逐年传到哪,同瘟疫);凋敝结束(推到了那年)另一条"疫后凋敝三十年,至是始复。天下城邑荒废者六十余处,道路断绝近半"(大事)。
 * 天下人口按起疫时记下的疫前人口(史事 pandemic 的 n)和传完下一年的比
 */
function pandemicEntries(ctx: Ctx, at: number, ids: number[]): ChronicleEntry[] {
  const { civ } = ctx;
  const A = civ.annals;
  const e = A[at];
  const info = pandemicsOf(civ).find((p) => p.annal === at);
  const hits = info?.hits ?? [];
  const origin = cityName(civ, e.settlement) || regionName(civ, e.region) || '一城';
  const list = ids.map((i) => A[i]);
  const polities = uniq(list.map((x) => x.a).filter((p) => p >= 0));
  const last = Math.max(e.year, ...hits.map((h) => h.year), ...list.map((x) => x.year));
  const years = Math.floor(last) - Math.floor(e.year) + 1;
  // 传遍几洲:染了疫的大陆(一块陆地上有 CONTINENT_REGIONS 州以上)
  const lm = civ.regions.landmass;
  const size = new Map<number, number>();
  for (let r = 0; r < civ.regions.count; r++) size.set(lm[r], (size.get(lm[r]) ?? 0) + 1);
  const lands = new Set<number>();
  for (const h of hits) if ((size.get(lm[h.region]) ?? 0) >= CONTINENT_REGIONS) lands.add(lm[h.region]);
  const reach = lands.size >= 2 ? `,循航线传遍${cnNumber(lands.size)}洲` : '';
  const mean = hits.length ? hits.reduce((s, h) => s + h.loss, 0) / hits.length : 0;
  const k = Math.round(mean * 10);
  const cityToll = k >= 1 ? `城中死者十之${cnNumber(k)}${k < 9 ? cnNumber(k + 1) : ''}` : '';
  // 天下人口:疫前(史事里记的)和传完的下一年
  const after = Math.min(civ.endYear, Math.floor(last) + 1);
  const drop = e.n && e.n > 0 ? 1 - worldPopulationAt(civ, after) / e.n : 0;
  const d = Math.round(drop * 10);
  const popToll = d >= 1 ? `天下人口十去其${cnNumber(d)}` : '';
  const tolls = [cityToll, popToll].filter(Boolean).join(',');
  const text = `${origin}大疫:起于${origin}${reach}${hits.length > 1 ? `,至${cnNumber(hits.length)}州` : ''}${years >= 2 ? `,${years} 年乃息` : ''}${tolls ? `。${tolls}` : ''}`;
  const children =
    ids.length > 1
      ? ids.map((i, n) => {
          const x = A[i];
          const r = regionName(civ, x.region) || cityName(civ, x.settlement) || '一州';
          const where = x.b > 1 ? `${r}等${cnNumber(x.b)}州` : r;
          return { ...base(x, i, n === 0 ? `${pn(civ, x.a, x.year)}${origin}起疫` : `疫传至${pn(civ, x.a, x.year)}${where}`, 1, [x.a], [x.region]), kind: 'plague' as const };
        })
      : undefined;
  const out: ChronicleEntry[] = [
    {
      ...base(e, ids[0] ?? at, text, 3, polities.length ? polities : e.a >= 0 ? [e.a] : [], uniq([e.region, ...hits.map((h) => h.region)].filter((r) => r >= 0))),
      kind: 'plague',
      end: last,
      ...(children ? { children } : {}),
    },
  ];
  // 凋敝结束(推到了那年;没传开的不写)
  if (info && ids.length && info.end <= civ.endYear) {
    const parts = [`疫后凋敝${cnNumber(info.slump)}年,至是始复`];
    const n = info.desolated.length;
    const roads = brokenRoads(civ, info.year, info.end);
    const roadText = roads >= 0.4 ? '道路断绝近半' : roads >= 0.2 ? '道路多有断绝' : roads >= 0.05 ? '道路间有断绝' : '';
    const tail = [n ? `天下城邑荒废者${placeCount(n)}` : '', roadText].filter(Boolean).join(',');
    if (tail) parts.push(tail);
    out.push({
      ...base({ ...e, year: info.end }, at, parts.join('。'), 3, [], uniq(hits.map((h) => h.region))),
      kind: 'plague',
    });
  }
  return out;
}

/** 起疫时通着的陆路里,到凋敝结束断了几成(推完以后的路表;荒废的城、失修的路都算) */
function brokenRoads(civ: Civ, from: Year, to: Year): number {
  let all = 0;
  let cut = 0;
  for (const r of civ.routes) {
    if (r.kind === 'sea' || r.built > from || (r.abandoned ?? Infinity) <= from) continue;
    all++;
    if ((r.abandoned ?? Infinity) <= to) cut++;
  }
  return all ? cut / all : 0;
}

/** 疫后城邑荒废(史事 desolate,同一场、同一国折成一条):"埃维里亚帝国疫后城邑荒废:塞尔维尔、伦盖特、阿斯特顿等十三处,道路断绝" */
function desolateEntry(ctx: Ctx, ids: number[]): ChronicleEntry {
  const { civ } = ctx;
  const A = civ.annals;
  const e = A[ids[0]];
  const list = ids.map((i) => A[i]);
  const names = [...new Set(list.map((x) => cityName(civ, x.settlement) || regionName(civ, x.region)).filter(Boolean))];
  const shown = names.slice(0, 3).join('、');
  const who = e.a >= 0 ? pn(civ, e.a, e.year) : '诸部';
  const n = list.length;
  const what = shown ? `:${shown}${n > 3 || names.length < n ? `等${cnNumber(n)}处` : ''}` : `${cnNumber(n)}处`;
  const children = list.map((x, j) => ({ ...base(x, ids[j], `${cityName(civ, x.settlement) || regionName(civ, x.region) || '一城'}荒废`, 1, x.a >= 0 ? [x.a] : [], [x.region]), kind: 'plague' as const }));
  return {
    ...base(e, ids[0], `${who}疫后城邑荒废${what},道路断绝`, n >= 5 ? 3 : 2, e.a >= 0 ? [e.a] : [], uniq(list.map((x) => x.region))),
    kind: 'plague',
    end: list[list.length - 1].year,
    ...(n > 1 ? { children } : {}),
  };
}

/** 战役里攻方从哪种边打过去(AdjKind:平地、跨河、翻山、海峡、航线) */
const VIA = ['', '渡河', '翻山', '渡海', '浮海'];
/** 据险断后的那支兵有多少人(编年史随手挑一个说法) */
const STAND_MEN = ['三百', '五百', '七百', '八百', '数百', '千余'];

// ---------------------------------------------------------------------------
// 同化与迁徙(阶段 3):史事的 a、b 是民族,war 列借来记国家

/** 同化的一州:"瑞州的居兰人渐为渭人" */
function assimChild(civ: Civ, e: Annal, id: number): ChronicleEntry {
  const r = regionName(civ, e.region) || '一州';
  return { ...base(e, id, `${r}的${folk(civ, e.b)}渐为${folk(civ, e.a)}`, 1, [e.war], [e.region]), settlement: -1 };
}

/** 随征服而来的移民(起因的国家是迁徙民族自己的国家) */
function isSettlers(civ: Civ, e: Annal): boolean {
  return polityOf(civ, e.war)?.culture === e.a;
}

/** 迁徙的一州:"居兰人迁入疏勒原(原为乌耐人所居)" */
function migrateChild(civ: Civ, e: Annal, id: number, inWave: boolean): ChronicleEntry {
  const r = regionName(civ, e.region) || '一州';
  const verb = isSettlers(civ, e) ? '徙居' : '迁入';
  const was = e.b >= 0 ? `(原为${folk(civ, e.b)}所居)` : '(原为无人之地)';
  return { ...base(e, id, `${folk(civ, e.a)}${verb}${r}${was}`, inWave ? 2 : 1, [e.war], [e.region]), settlement: -1 };
}

/** 迁徙的方位(Culture.migrations 里同一年的那一波;同一年有几波按先后对上) */
function migrationDir(civ: Civ, e: Annal, used: Map<number, number>): MigrationDir | null {
  const list = cultureOf(civ, e.a)?.migrations ?? [];
  const from = used.get(e.a) ?? 0;
  for (let i = from; i < list.length; i++) {
    if (list[i].year === e.year) {
      used.set(e.a, i + 1);
      return list[i].dir;
    }
  }
  return null;
}

/** 随征服南下 / 北上 / 东进 / 西进 */
const ADVANCE: Record<MigrationDir, string> = { 东: '东进', 西: '西进', 南: '南下', 北: '北上' };

/** 一波迁徙(同一刻、同一民族、同一起因)折成一条 */
function migrationEntry(ctx: Ctx, ids: number[], dirUsed: Map<number, number>): ChronicleEntry {
  const { civ } = ctx;
  const A = civ.annals;
  const e0 = A[ids[0]];
  const dir = migrationDir(civ, e0, dirUsed);
  const regions = uniq(ids.map((i) => A[i].region));
  const where = regionList(civ, regions) || '他处';
  const who = cn(civ, e0.a);
  let text: string;
  if (isSettlers(civ, e0)) text = `${who}随${pn(civ, e0.war, e0.year)}${dir ? ADVANCE[dir] : '而来'},徙居${where}`;
  else if (e0.war >= 0) {
    text = `${who}避${pn(civ, e0.war, e0.year)}兵锋${dir ? `${dir}迁` : '外迁'},入${where}`;
    ctx.flight.set(ids[0], `${who}${dir ? `${dir}迁` : '外迁'},入${where}`);
  }
  else text = `${who}${dir ? `${dir}迁` : '迁徙'},入${where}`;
  const kids = ids.map((i) => migrateChild(civ, A[i], i, true));
  const importance: Importance = regions.length >= MIGRATE_MAJOR ? 3 : 2;
  return {
    id: ids[0],
    kind: 'migrate',
    year: e0.year,
    end: e0.year,
    text,
    tag: '徙',
    importance,
    polities: uniq([e0.war]),
    regions,
    settlement: -1,
    children: kids.length > 1 ? kids : undefined,
  };
}

/** 大迁徙为什么走(Migration.push):灾年(发源在苔原、针叶林这类苦寒之地的"苦寒",别的"苦旱";见地貌表的标签 cold)、老家挤、本族的国散了 */
function trekWhy(civ: Civ, push: string | undefined, c: number): string {
  if (push === 'famine') {
    const cu = cultureOf(civ, c);
    const b = cu && cu.hearth >= 0 && cu.hearth < civ.regions.count ? civ.regions.biome[cu.hearth] : -1;
    return biomeHas(b, 'cold') ? '苦寒' : '苦旱';
  }
  return push === 'crowd' ? '生齿日繁' : push === 'scatter' ? '部落离散' : '';
}

/**
 * 大迁徙(migration.ts;史事 trek 按 war 列 = 第几次大迁徙折成一条,经过见 Civ.migrations):
 * 一句话写谁、为什么、往哪、经过哪、结果:"克拉尔族苦寒,一支举族西徙,过梅尔郡,入百尾皇朝,据瑶渊之野等五州,立萨热汗国";
 * 败了的再写";为大定王朝所败,部众散亡";没立成国的"……,散居瑶渊之野等三州";还在路上的"……,尚在途中"。
 * 年份写起止两头:动身那年到落脚那年(败了的到亡国那年)。标签"徙",种类记成 migrate(时间轴上和别的迁徙同归「同化」一类),一律是大事。
 * 展开看经过:动身("克拉尔族苦寒,分出一支约三成,自诺敏塔拉西去")、路上洗劫("过梅尔郡,掠之")、攻进去("入百尾皇朝,破瑶渊之野、长舞之野")、
 * 立国("据瑶渊之野等五州,立萨热汗国,都青都,与百尾皇朝开战")、打进国都("萨热汗国破星邑,百尾皇朝大崩解";没崩的"……,百尾皇朝迁都某城";
 * 小国"……,某国亡")/ 被打败("为大定王朝所败,焉支汗国亡,部众散亡,余众留居乐和郡")。
 * 到了以后那一仗照旧另记一条战争(war,cause = trek),打进大国国都引起的大崩解也照旧另记一条;立国那条 found(cause = trek)并进这一条的经过
 */
function trekEntry(ctx: Ctx, ids: number[], warIds: number[] | undefined): ChronicleEntry {
  const { civ } = ctx;
  const A = civ.annals;
  const list = ids.map((i) => A[i]);
  const e0 = list[0];
  const M = civ.migrations?.[e0.war];
  const c = e0.a;
  const who = cn(civ, c);
  const dir = M?.dir ?? null;
  const why = trekWhy(civ, M?.push, c);
  const wl = (warIds ?? []).map((i) => ({ e: A[i], i }));
  const kids: ChronicleEntry[] = [];
  /** 子条目(kind、标签照它是哪一种事:迁徙、洗劫、攻占、立国、崩解、灭亡) */
  const kid = (e: Annal, i: number, t: string, ps: number[], rs: number[], kind: EntryKind, tag: string): ChronicleEntry => ({ ...base(e, i, t, 2, ps, rs, tag), kind });
  const raided: string[] = [];
  let settle: { e: Annal; i: number } | undefined;
  let storm: { e: Annal; i: number } | undefined;
  let scatter: { e: Annal; i: number } | undefined;
  ids.forEach((i) => {
    const e = A[i];
    const r = regionName(civ, e.region);
    if (e.n === 0) kids.push(kid(e, i, `${who}${why ? `${why},` : ''}分出一支约三成,自${r || '故地'}${dir ? `${dir}去` : '远去'}`, [], e.region >= 0 ? [e.region] : [], 'migrate', '徙'));
    else if (e.n === 1) {
      if (r && !raided.includes(r)) raided.push(r);
      kids.push(kid(e, i, `过${r || '一州'},掠之`, e.b >= 0 ? [e.b] : [], e.region >= 0 ? [e.region] : [], 'sack', '掠'));
    } else if (e.n === 2) settle = { e, i };
    else if (e.n === 3) storm = { e, i };
    else if (e.n === 4) scatter = { e, i };
  });
  const lands = M?.lands ?? [];
  const where = regionList(civ, lands);
  let text = `${who}${why ? `${why},` : ''}一支举族${dir ? `${dir}徙` : '远徙'}`;
  if (raided.length) text += `,过${raided.slice(0, 2).join('、')}`;
  let end = e0.year;
  let ongoing = false;
  const polities: number[] = [];
  const regions: number[] = [];
  let settlement = -1;
  if (settle) {
    const se = settle.e;
    const y = se.year;
    const p = se.b;
    const P = pn(civ, p, y);
    const city = cityName(civ, se.settlement);
    settlement = se.settlement;
    end = y;
    polities.push(p);
    const decl = wl.find((x) => x.e.kind === 'war');
    const foe = decl ? decl.e.b : -1;
    // 攻进去:立国那一刻从那国手里占下的州
    if (foe >= 0) {
      polities.push(foe);
      const now = ownersAt(civ, y).polity;
      const was = ownersAt(civ, y - 1 / 512).polity;
      const taken: number[] = [];
      for (let r = 0; r < now.length; r++) if (now[r] === p && was[r] === foe) taken.push(r);
      if (taken.length) {
        const names = taken.sort((u, v) => civ.regions.capacity[v] - civ.regions.capacity[u] || u - v).map((r) => regionName(civ, r)).filter(Boolean);
        const shown = names.length > 3 ? `${names.slice(0, 2).join('、')}等${cnNumber(names.length)}州` : names.join('、');
        kids.push(kid(se, settle.i, `入${pn(civ, foe, y)},破${shown}`, [p, foe], taken.slice(), 'conquer', '占'));
      }
    }
    text += `${foe >= 0 ? `,入${pn(civ, foe, y)}` : `,至${regionName(civ, se.region) || '其地'}`},据${where || '其地'},立${P}`;
    // 立国那条记在紧跟着的 found 上(攻进去那条用 trek 本身,两条的 id 不重)
    const fi = A[settle.i + 1]?.kind === 'found' && A[settle.i + 1].cause === 'trek' ? settle.i + 1 : settle.i;
    kids.push(kid(A[fi], fi, `据${where || '其地'},立${P}${city ? `,都${city}` : ''}${foe >= 0 ? `,与${pn(civ, foe, y)}开战` : ''}`, [p], lands.slice(), 'found', '立'));
    regions.push(...lands);
    if (foe >= 0) {
      const fallR = wl.find((x) => x.e.kind === 'fall' && x.e.a === p);
      const fallC = wl.find((x) => x.e.kind === 'fall' && x.e.a === foe && x.e.b === p);
      if (storm) {
        const sy = storm.e.year;
        const cap = cityName(civ, storm.e.settlement) || regionName(civ, storm.e.region) || '国都';
        const F = pn(civ, foe, sy);
        // 那国大崩解(另有一条大事)写"大崩解";没崩的写迁都到哪
        const broke = A.some((x) => x.kind === 'collapse' && x.a === foe && x.year === sy);
        const moved = wl.find((x) => x.e.kind === 'capital' && x.e.a === foe && x.e.year === sy);
        const to = moved ? cityName(civ, moved.e.settlement) : '';
        kids.push(kid(storm.e, storm.i, `${pn(civ, p, sy)}破${cap},${F}${broke ? '大崩解' : `迁都${to}`}`, [p, foe], storm.e.region >= 0 ? [storm.e.region] : [], broke ? 'collapse' : 'conquer', broke ? '崩' : '占'));
        regions.push(storm.e.region);
      } else if (fallC) {
        const C = polityOf(civ, foe);
        const cap = C ? cityName(civ, capitalBefore(C, fallC.e.year)) : '';
        kids.push(kid(fallC.e, fallC.i, `${pn(civ, p, fallC.e.year)}破${cap || '其都'},${pn(civ, foe, fallC.e.year)}亡`, [p, foe], fallC.e.region >= 0 ? [fallC.e.region] : [], 'fall', '亡'));
      } else if (fallR) {
        const fy = fallR.e.year;
        text += `;为${pn(civ, foe, fy)}所败,部众散亡`;
        end = fy;
        kids.push(kid(fallR.e, fallR.i, `为${pn(civ, foe, fy)}所败,${pn(civ, p, fy - 1 / 512)}亡,部众散亡${where ? `,余众留居${where}` : ''}`, [foe, p], lands.slice(), 'fall', '亡'));
      }
    }
  } else if (scatter) {
    end = scatter.e.year;
    text += where ? `,至${regionName(civ, scatter.e.region) || '其地'},散居${where}` : `,至${regionName(civ, scatter.e.region) || '远方'}一带,部众散亡`;
    kids.push(kid(scatter.e, scatter.i, where ? `未能立国,散居${where}` : '部众散亡', [], lands.slice(), 'migrate', '徙'));
    regions.push(...lands);
  } else {
    // 还在路上
    text += ',尚在途中';
    ongoing = true;
    end = civ.endYear;
  }
  const children = kids.sort((a, b) => a.year - b.year || a.id - b.id);
  const rs = uniq(regions.filter((r) => r >= 0));
  return {
    id: ids[0],
    kind: 'migrate',
    year: e0.year,
    end,
    text,
    tag: '徙',
    importance: 3,
    polities: uniq(polities.filter((p) => p >= 0)),
    regions: rs.length ? rs : e0.region >= 0 ? [e0.region] : [],
    settlement,
    children,
    ...(ongoing ? { ongoing: true } : {}),
  };
}

/** 同化:同一国治下、同一对民族,相隔不到 ASSIM_GAP 年的折成一段(一段最长 ASSIM_SPAN 年) */
function assimEntries(ctx: Ctx, groups: Map<string, number[]>, out: ChronicleEntry[]) {
  const { civ } = ctx;
  const A = civ.annals;
  for (const ids of groups.values()) {
    let group: number[] = [];
    const flush = () => {
      if (!group.length) return;
      const first = A[group[0]];
      const last = A[group[group.length - 1]];
      const regions = uniq(group.map((i) => A[i].region));
      const where = regionList(civ, regions) || '一州';
      const P = polityOf(civ, first.war);
      let text: string;
      // 大迁徙迁来立的国(Polity.trek),统治民族渐为当地多数所化:"萨热汗国境内的克拉尔人渐为桑人,瑶渊之野等五州皆说桑语"(五州以上是大事)
      const trek = !!P && P.trek !== undefined && P.culture === first.b;
      if (trek) text = `${pn(civ, first.war, first.year)}境内的${folk(civ, first.b)}渐为${folk(civ, first.a)},${where}皆说${cultureOf(civ, first.a)?.name ?? '当地'}语`;
      else if (P && P.culture === first.b) text = `${pn(civ, first.war, first.year)}的${folk(civ, first.b)}渐染${cultureOf(civ, first.a)?.name ?? '异族'}俗,${where}渐为${folk(civ, first.a)}`;
      else if (P) text = `${pn(civ, first.war, first.year)}治下,${where}的${folk(civ, first.b)}渐为${folk(civ, first.a)}`;
      else text = `${where}的${folk(civ, first.b)}渐为${folk(civ, first.a)}`;
      const importance: Importance = regions.length >= (trek ? TREK_ASSIM_MAJOR : ASSIM_MAJOR) ? 3 : regions.length >= ASSIM_MINOR ? 2 : 1;
      const kids = group.map((i) => assimChild(civ, A[i], i));
      out.push({
        id: group[0],
        kind: 'assimilate',
        year: first.year,
        end: last.year,
        text,
        tag: '化',
        importance,
        polities: uniq([first.war]),
        regions,
        settlement: -1,
        children: kids.length > 1 ? kids : undefined,
      });
      group = [];
    };
    for (const i of ids) {
      if (group.length && (A[i].year - A[group[group.length - 1]].year > ASSIM_GAP || A[i].year - A[group[0]].year > ASSIM_SPAN)) flush();
      group.push(i);
    }
    flush();
  }
}

// ---------------------------------------------------------------------------
// 收服部落:同一国接连几次折叠成一条

function tribalEntries(ctx: Ctx, byPolity: Map<number, number[]>, out: ChronicleEntry[]) {
  const { civ } = ctx;
  const A = civ.annals;
  for (const [pid, ids] of byPolity) {
    let group: number[] = [];
    const flush = () => {
      if (!group.length) return;
      const kids = group.map((i) => simpleEntry(ctx, A[i], i));
      if (kids.length === 1) out.push(kids[0]);
      else {
        const first = A[group[0]];
        const last = A[group[group.length - 1]];
        const regions = uniq(group.map((i) => A[i].region));
        out.push({
          id: group[0],
          kind: 'conquer',
          year: first.year,
          end: last.year,
          text: `${pn(civ, pid, first.year)}征服${regionList(civ, regions)}诸部`,
          tag: '征',
          importance: 1,
          polities: [pid],
          regions,
          settlement: -1,
          children: kids,
        });
      }
      group = [];
    };
    for (const i of ids) {
      if (group.length && (A[i].year - A[group[group.length - 1]].year > TRIBAL_GAP || A[i].year - A[group[0]].year > TRIBAL_SPAN)) {
        flush();
      }
      group.push(i);
    }
    flush();
  }
}

// ---------------------------------------------------------------------------
// "大事"里合写:同一国家短时间里连着的几件大事,后一件写进前一件里,"大事"里不再单占一行("全部"里照旧单列)

/** 前一件事之后这么多年以内的,合写进前一件 */
export const COMBINE_GAP = 10;

/** 合写:返回"哪一条里说了哪几国的来历"(合写进改朝换代那一条的分裂) */
function combine(ctx: Ctx, list: ChronicleEntry[]): Map<ChronicleEntry, number> {
  const told = new Map<ChronicleEntry, number>();
  const { civ } = ctx;
  const A = civ.annals;
  const later = (n: number) => (n >= 1 ? `${cnNumber(n)}年后` : '同年');
  for (let k = 0; k < list.length; k++) {
    const e = list[k];
    if (e.importance < MAJOR) continue;
    // 改朝换代之后不久就有州叛离:"…国号大辰;七年后喀勒川叛大辰王朝自立,号库兹汗国"
    if (e.kind === 'split' && e.polities.length > 1) {
      const from = e.polities[1];
      let d: ChronicleEntry | undefined;
      for (let j = k - 1; j >= 0 && e.year - list[j].year <= COMBINE_GAP; j--) {
        const x = list[j];
        if (x.kind === 'dynasty' && x.importance >= MAJOR && x.polities[0] === from) {
          d = x;
          break;
        }
      }
      if (d) {
        d.text += `;${later(Math.floor(e.year) - Math.floor(d.year))}${e.text}`;
        d.polities = uniq([...d.polities, ...e.polities]);
        d.regions = uniq([...d.regions, ...e.regions]);
        if (e.people?.length) d.people = uniq([...(d.people ?? []), ...e.people]);
        e.importance = 2;
        told.set(d, e.polities[0]);
      }
    }
    // 亡国(失地)之后逃难的一波迁徙:"…,艾莱斯国亡,艾莱斯族南迁,入阿拉斯等五州"
    const short = e.kind === 'migrate' ? ctx.flight.get(e.id) : undefined;
    if (short) {
      const by = A[e.id].war;
      const folk = A[e.id].a;
      let w: ChronicleEntry | undefined;
      for (let j = k - 1; j >= 0; j--) {
        const x = list[j];
        if (x.kind !== 'war' || x.importance < MAJOR || e.year - x.end > COMBINE_GAP || e.year < x.year) continue;
        const [a, b] = x.polities;
        const other = a === by ? b : b === by ? a : -1;
        if (other >= 0 && polityOf(civ, other)?.culture === folk) {
          w = x;
          break;
        }
      }
      if (w) {
        w.text += `,${short}`;
        w.regions = uniq([...w.regions, ...e.regions]);
        e.importance = 2;
      }
    }
  }
  return told;
}

// ---------------------------------------------------------------------------
// "大事"里的来历:只看大事时,第一次出现、来历没说过的国家带一句来历

/**
 * 改了国号的国家,旧国号 root 那一朝最后一刻(改朝换代的前一刻)的全称,和到 year 年为止又改了几次:
 * "原居兰汗国"、"原居兰汗国,两度易代"。找不到 = "原" + root
 */
function renamedFrom(p: Polity, root: string, year: Year): string {
  const d = p.dynasties ?? [];
  const now = dynastyIndexAt(p, year);
  for (let i = Math.min(now, d.length - 1); i >= 1; i--) {
    if (polityRootAt(p, d[i - 1].year) !== root) continue;
    const n = now - i + 1;
    return `原${polityName(p, d[i].year - 1 / 512)}${n >= 2 ? `,${n === 2 ? '两' : cnNumber(n)}度易代` : ''}`;
  }
  return `原${root}`;
}

/** 这个国家在 year 年可能写进纪事里的名字(四档全称 + 简称;长的在前) */
function namesOf(p: Polity, year: Year): string[] {
  const out = new Set<string>(polityTitles(p, year));
  for (let t = 0; t < 4; t++) out.add(polityShortTitle(p, t, year));
  // 占位符(civ/nameToken.ts):真名字里简称和词根、去掉"大"的写法是同一串字,写到这几种也算写到了
  const root = polityRootAt(p, year);
  const shape = rootShapeOf(root);
  if (shape) out.add(root);
  if (shape === 'long') out.add(coreRoot(root));
  return [...out].filter(Boolean).sort((a, b) => b.length - a.length);
}

/** 往两头看几个字,找这一处是不是别的名字的一部分(名字最多十几个字,推演起的不超过这么长) */
const NAME_REACH = 8;

/**
 * 正文里写得到的、不是国家和人物的名字:民族、州、城、地名、信仰。国名碰巧是它们的一部分时,那一处写的不是这个国家
 * ("西拉瓦尼亚族"里的"拉瓦尼亚")。名字是占位符时用不着:占位符不会碰巧是别的占位符的一部分
 */
function otherNames(civ: Civ): ReadonlySet<string> {
  const out = new Set<string>();
  if (isNameToken(civ.polities[0]?.name ?? '')) return out;
  const add = (s: string | undefined) => void (s && out.add(s));
  for (const c of civ.cultures ?? []) add(c.name);
  for (const s of civ.settlements ?? []) add(s.name);
  for (const p of civ.places ?? []) add(p.name);
  for (const f of civ.religion?.faiths ?? []) add(f.name);
  for (let r = 0; r < civ.regions.count; r++) add(civ.regionNames?.[r] || civ.regions.name?.[r]);
  return out;
}

/** text 的 [at, end) 这一处是不是 known 里某个更长的名字的一部分 */
function insideName(text: string, at: number, end: number, known: ReadonlySet<string>): boolean {
  for (let a = at; a >= Math.max(0, at - NAME_REACH); a--) {
    for (let b = end; b <= Math.min(text.length, end + NAME_REACH); b++) {
      if ((a < at || b > end) && known.has(text.slice(a, b))) return true;
    }
  }
  return false;
}

/** 名字在正文里第一次出现的位置(不算嵌在别国名字里的:"后高弥汗国"里的"高弥汗国";也不算嵌在民族、州、城这些名字里的);没有 = null */
function firstMention(text: string, mine: string[], others: string[], known: ReadonlySet<string>): { at: number; len: number } | null {
  const spans: [number, number][] = [];
  for (const n of others) for (let i = text.indexOf(n); i >= 0; i = text.indexOf(n, i + 1)) spans.push([i, i + n.length]);
  let best: { at: number; len: number } | null = null;
  for (const n of mine) {
    for (let i = text.indexOf(n); i >= 0; i = text.indexOf(n, i + 1)) {
      const end = i + n.length;
      if (spans.some(([s, e]) => s <= i && e >= end && e - s > n.length) || insideName(text, i, end, known)) continue;
      if (!best || i < best.at || (i === best.at && n.length > best.len)) best = { at: i, len: n.length };
      break;
    }
  }
  return best;
}

/**
 * 只看"大事"也读得懂:按先后翻大事,每个国家第一次出现、它的来历(立国 / 分裂 / 复国)不在大事里的,名字后面带一句来历:
 * "艾莱斯国(第 1850 年立国)"、"塔提特汗国(第 2082 年叛哈尔提亚王国自立)"、"新塔提特汗国(第 2455 年脱哈尔提亚帝国复国)";
 * 改朝换代换了国号(东方小一些的国家改朝换代不是大事)、新国号在大事里第一次出现的:"伊罗汗国(原居兰汗国)"。
 * 只改大事的正文(全部里也是这一条,多一句来历不碍事)。分成小步(同 chronicleSteps)
 */
function* introduce(civ: Civ, list: ChronicleEntry[], told: ReadonlyMap<ChronicleEntry, number>): Generator<void, void> {
  const A = civ.annals;
  // 每个国家的来历(立国 / 分裂 / 复国那条史事)
  const origin = new Map<number, Annal>();
  for (const e of A) if ((e.kind === 'found' || e.kind === 'split' || e.kind === 'revolt') && e.a >= 0 && !origin.has(e.a)) origin.set(e.a, e);
  /** 国家 → 大事里最近一次出现时的国号词根 */
  const shown = new Map<number, string>();
  const known = otherNames(civ);
  let n = 0;
  for (const e of list) {
    if (++n % 512 === 0) yield;
    if (e.importance < MAJOR) continue;
    const y = e.year;
    const pids = e.polities.filter((id) => polityOf(civ, id));
    const personNames = (e.people ?? []).map((k) => civ.people?.[k]?.name ?? '').filter(Boolean);
    // 立国、分裂、复国这一条本身就是来历(干预"立国"那一条、大迁徙落脚立国的那一条也是:立的国排在 polities 第一个)
    const founding =
      e.kind === 'found' ||
      e.kind === 'split' ||
      e.kind === 'revolt' ||
      (e.kind === 'intervene' && civ.interventions?.[A[e.id]?.war]?.kind === 'found') ||
      (e.kind === 'migrate' && A[e.id]?.kind === 'trek');
    if (founding && pids.length) shown.set(pids[0], polityRootAt(civ.polities[pids[0]], y));
    const also = told.get(e);
    if (also !== undefined && polityOf(civ, also)) shown.set(also, polityRootAt(civ.polities[also], y));
    const names = new Map<number, string[]>();
    const nameAt = (id: number) => {
      let n = names.get(id);
      if (!n) {
        const p = civ.polities[id];
        // 改朝换代这一条写的是旧朝的国号("大昌享国 312 年而亡")
        n = e.kind === 'dynasty' && id === pids[0] ? namesOf(p, y - 1 / 512) : namesOf(p, y);
        names.set(id, n);
      }
      return n;
    };
    // 位置都按原文找(不在加进去的来历里找),最后从后往前插
    const inserts: { at: number; note: string }[] = [];
    for (const id of pids) {
      const p = civ.polities[id];
      // 只管正文里写到的(战争的子条目里才有的第三国不算出现过);嵌在人名里的不算
      const m = firstMention(e.text, nameAt(id), [...pids.filter((x) => x !== id).flatMap(nameAt), ...personNames], known);
      if (!m) continue;
      // 改朝换代这一条写的是旧朝的国号:按前一刻算
      const at = e.kind === 'dynasty' && id === pids[0] ? y - 1 / 512 : y;
      const root = polityRootAt(p, at);
      const was = shown.get(id);
      let note = '';
      if (was === undefined) {
        const o = origin.get(id);
        if (o) {
          const oy = o.year;
          if (o.kind === 'found') note = `第 ${Math.floor(oy)} 年立国`;
          else if (o.kind === 'revolt') note = o.b >= 0 ? `第 ${Math.floor(oy)} 年饥民起事,叛${pn(civ, o.b, oy)}自立` : `第 ${Math.floor(oy)} 年饥民起事`;
          else if (p.restores !== undefined) note = o.b >= 0 ? `第 ${Math.floor(oy)} 年脱${pn(civ, o.b, oy)}复国` : `第 ${Math.floor(oy)} 年复国`;
          else note = o.b >= 0 ? `第 ${Math.floor(oy)} 年叛${pn(civ, o.b, oy)}自立` : `第 ${Math.floor(oy)} 年自立`;
          const first = polityRootAt(p, oy);
          if (first !== root) note += nameIf('same', first, root, '', `,${renamedFrom(p, first, at)}`);
        }
      }
      if (note) inserts.push({ at: m.at + m.len, note: `(${note})` });
      else if (was !== undefined && was !== root) inserts.push({ at: m.at + m.len, note: nameIf('same', was, root, '', `(${renamedFrom(p, was, at)})`) });
      shown.set(id, e.kind === 'dynasty' && id === pids[0] ? polityRootAt(p, y) : root);
    }
    inserts.sort((a, b) => b.at - a.at);
    for (const { at, note } of inserts) e.text = `${e.text.slice(0, at)}${note}${e.text.slice(at)}`;
  }
}

// ---------------------------------------------------------------------------

const cache = new WeakMap<Civ, ChronicleEntry[]>();

/**
 * 别处已经替这份 civ 算好的编年史(后台线程按同样的历史、同样的改名算的,和 buildChronicle(civ) 逐条一样):记进缓存,不再重算。
 * 已经算过的不换
 */
export function primeChronicle(civ: Civ, entries: ChronicleEntry[]) {
  if (!cache.has(civ)) cache.set(civ, entries);
}

/** 这份 civ 的编年史已经算过(或别处替它算好了) */
export function chronicleCached(civ: Civ): boolean {
  return cache.has(civ);
}

/** 一步一步走完(同步) */
export function runSteps<T>(g: Generator<void, T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** civ.annals → 编年史条目(按年份排好;同一年按发生先后)。按 civ 缓存 */
export function buildChronicle(civ: Civ): ChronicleEntry[] {
  return cache.get(civ) ?? runSteps(chronicleSteps(civ));
}

/**
 * 同 buildChronicle,分成许多小步(每一步不到一毫秒):界面可以一块一块地算,块与块之间让出主线程(src/ui/chronicleHandoff.ts)。
 * 走完和 buildChronicle 的结果逐条一样,记进同一个缓存;走的中途别处已经算好了的,用先算好的那份
 */
export function* chronicleSteps(civ: Civ): Generator<void, ChronicleEntry[]> {
  const hit = cache.get(civ);
  if (hit) return hit;
  const A = civ.annals ?? [];
  const splitFrom = new Map<number, number>();
  for (const e of A) if (e.kind === 'split' && e.a >= 0 && e.b >= 0) splitFrom.set(e.a, e.b);
  const quell = new Map<number, number>();
  for (const e of A) if (e.kind === 'war' && (e.cause === 'quell' || e.cause === 'heir')) quell.set(e.war, e.b);
  const retake = retakes(A);
  yield;
  const ctx: Ctx = { civ, titleUsed: new Map(), retake, splitFrom, flight: new Map(), ix: peopleOf(civ), quell };
  yield;
  const out: ChronicleEntry[] = [];
  const wars = new Map<number, number[]>();
  const plagues = new Map<number, number[]>();
  const tribal = new Map<number, number[]>();
  // 全球大疫(pandemic.ts):起疫那条(第几场 → 下标);疫后荒废的城按"第几场 + 国家"折成一条
  const pandemics = new Map<number, number>();
  const desolate = new Map<string, number[]>();
  // 同化与迁徙:一波迁徙(同一刻、同一民族、同一起因);同一国治下同一对民族的同化
  const waves = new Map<string, number[]>();
  const assim = new Map<string, number[]>();
  // 大迁徙:第几次 → 它的几条史事;到了以后开的那一仗(战争编号 → 第几次:立的国 = trek n = 2 的 b,那一仗 = 它开的 war,cause = trek)
  const treks = new Map<number, number[]>();
  const trekWar = new Map<number, number>();
  {
    const byPolity = new Map<number, number>();
    for (const e of A) {
      if (e.kind === 'trek' && e.n === 2 && e.b >= 0) byPolity.set(e.b, e.war);
      else if (e.kind === 'war' && e.cause === 'trek' && byPolity.has(e.a)) trekWar.set(e.war, byPolity.get(e.a)!);
    }
  }
  // 分裂出来的国家不再记"立国";并入别国的不再记"瓦解"(合并那条已经说了)
  const splitOf = new Set<number>();
  const mergedAt = new Set<string>();
  for (const e of A) {
    if (e.kind === 'split' && e.a >= 0) splitOf.add(e.a);
    if (e.kind === 'merge' && e.b >= 0) mergedAt.add(`${e.b}|${e.year}`);
  }
  yield;
  /** 走了几条:每走一段停一步 */
  let n = 0;
  for (let i = 0; i < A.length; i++) {
    if (++n % 128 === 0) yield;
    const e = A[i];
    // 地形大事:那一刻的后果(城没了、迁都、亡于天灾)并进大事那一条
    if (e.kind === 'upheaval') {
      const ids = [i];
      while (i + 1 < A.length && upheavalTail(A[i + 1], e)) ids.push(++i);
      out.push(upheavalEntry(ctx, ids));
      continue;
    }
    // 大崩解:紧跟着自立的几块并进崩解那一条
    if (e.kind === 'collapse') {
      const ids = [i];
      while (i + 1 < A.length && collapseTail(A[i + 1], e)) ids.push(++i);
      out.push(collapseEntry(ctx, ids));
      continue;
    }
    // 瘟疫:同一场的几条并成一条
    if (e.kind === 'plague') {
      let g = plagues.get(e.war);
      if (!g) plagues.set(e.war, (g = []));
      g.push(i);
      continue;
    }
    if (e.kind === 'pandemic') {
      pandemics.set(e.war, i);
      continue;
    }
    if (e.kind === 'desolate') {
      const key = `${e.war}|${e.a}`;
      let g = desolate.get(key);
      if (!g) desolate.set(key, (g = []));
      g.push(i);
      continue;
    }
    // 民变:并进讨伐它的那场战争(紧跟着记的 war,cause = quell),写成一条民变
    if (e.kind === 'revolt') {
      const w = A[i + 1];
      if (w && w.kind === 'war' && w.cause === 'quell' && w.b === e.a) {
        wars.set(w.war, [i]);
        continue;
      }
    }
    // 立约与中立地:背约、约满后面同一刻的中立地撤销、约废并进那一条;议和顺带立的约紧跟着划了缓冲中立地的,立约那条并进中立地那条
    if (e.kind === 'breach' || e.kind === 'expire') {
      const ids = [i];
      while (i + 1 < A.length && treatyTail(A[i + 1], e)) ids.push(++i);
      out.push(treatyEntry(ctx, ids));
      continue;
    }
    if (e.kind === 'treaty' && e.cause === 'peace' && A[i + 1]?.kind === 'neutral' && A[i + 1].cause === 'peace' && A[i + 1].n === e.war) continue;
    // 保住王室挡下的一回:掌实权的人篡位挡下的,紧跟着记的结局(伏诛、还政)并进来
    if (e.kind === 'keep') {
      const ids = [i];
      const nx = A[i + 1];
      if (e.b === KEEP_REGENT && nx && nx.kind === 'regent' && nx.a === e.a && nx.year === e.year) ids.push(++i);
      out.push(keepEntry(ctx, ids));
      continue;
    }
    // 被迫迁都(capital 带战争编号)、洗劫、毁城(阶段 3 城市兴衰)也折进那场战争
    // 邦交:战败称臣(submit 带战争编号)、背盟来攻、坐视不救(unally 带战争编号)也折进那场战争
    const inWar =
      e.war >= 0 &&
      (e.kind === 'war' ||
        e.kind === 'conquer' ||
        e.kind === 'battle' ||
        e.kind === 'peace' ||
        e.kind === 'fall' ||
        e.kind === 'capital' ||
        e.kind === 'sack' ||
        e.kind === 'ruin' ||
        e.kind === 'submit' ||
        e.kind === 'unally' ||
        e.kind === 'stand' ||
        e.kind === 'winter');
    if (inWar) {
      let g = wars.get(e.war);
      if (!g) wars.set(e.war, (g = []));
      g.push(i);
      // 亡国、毁城另列一条(下面照常处理)
      if (e.kind !== 'fall' && e.kind !== 'ruin') continue;
    }
    if (e.kind === 'found' && splitOf.has(e.a)) continue;
    // 议立宪 / 废君谈崩、紧跟着起兵:并进起兵那一条(革命)
    if (e.kind === 'council' && revolutionAfter(A, i)) continue;
    // 作者下令立的约、划的中立地并进干预那一条
    if ((e.kind === 'treaty' || e.kind === 'neutral') && e.cause === 'decree' && foldedIntoDecree(civ, i)) continue;
    // 干预引起的立国、迁都并进干预那一条
    if ((e.kind === 'found' || e.kind === 'capital' || e.kind === 'fall' || e.kind === 'famine') && foldedIntoIntervene(civ, i)) continue;
    // 照大纲划给同一国的几州并进头一条
    if (e.kind === 'intervene' && i > 0 && plotCedeKey(civ, i) && plotCedeKey(civ, i - 1) === plotCedeKey(civ, i)) continue;
    // 照大纲顺着引的方针(gen/outline.ts)不写进编年史,只在大纲的批改里写
    if (e.kind === 'intervene' && civ.interventions?.[e.war]?.guide) continue;
    // 即位(等在位的那位下台):登记的那一条不列,真即位时另有一条
    if (e.kind === 'intervene' && e.b === IV_WAIT && civ.interventions?.[e.war]?.kind === 'crown') continue;
    // 故事事件的 dev 委托:strikeBoost 记的那一条(b = -1、带 until)只用于接着推重建发展段,
    // 编年史由干预自己的汇总史事写(上面 case 'story'),这一条不另列,免得同一件故事重复上屏。
    // petty 的 dev 委托没有汇总史事、要留着当正文,所以这里只认 war 指向 story 的
    if (e.kind === 'intervene' && e.b === -1 && e.until !== undefined && civ.interventions?.[e.war]?.kind === 'story') continue;
    if (e.kind === 'fall' && e.b < 0 && mergedAt.has(`${e.a}|${e.year}`)) continue;
    if (e.kind === 'conquer' && e.b < 0 && e.a >= 0) {
      let g = tribal.get(e.a);
      if (!g) tribal.set(e.a, (g = []));
      g.push(i);
      continue;
    }
    // 掌实权:幼主的摄政、辅政写在即位那一条,名臣篡位写在改朝换代那一条(regentEntry 给 null)
    if (e.kind === 'regent') {
      const x = regentEntry(ctx, i);
      if (x) out.push(x);
      continue;
    }
    // 结亲:互嫁的第二门并进第一门
    if (e.kind === 'marry') {
      if (!mutualTail(A, i)) out.push(marryEntry(ctx, i));
      continue;
    }
    // 大迁徙:同一次的几条(war 列 = 第几次)折成一条;它立国那条 found 并进来
    if (e.kind === 'trek') {
      let g = treks.get(e.war);
      if (!g) treks.set(e.war, (g = []));
      g.push(i);
      continue;
    }
    if (e.kind === 'found' && e.cause === 'trek') continue;
    if (e.kind === 'migrate' || e.kind === 'assimilate') {
      const map = e.kind === 'migrate' ? waves : assim;
      const key = e.kind === 'migrate' ? `${e.year}|${e.a}|${e.war}` : `${e.a}|${e.b}|${e.war}`;
      let g = map.get(key);
      if (!g) map.set(key, (g = []));
      g.push(i);
      continue;
    }
    out.push(simpleEntry(ctx, e, i));
  }
  // 大迁徙到了以后那一仗照旧单列一条战争;它的几件事(宣战、亡国、迁都)也写进大迁徙的经过
  const trekWars = new Map<number, number[]>();
  for (const [w, ids] of wars) {
    if (++n % 8 === 0) yield;
    const m = trekWar.get(w);
    if (m !== undefined) trekWars.set(m, ids);
    out.push(A[ids[0]].kind === 'revolt' ? revoltEntry(ctx, ids) : warEntry(ctx, ids));
  }
  for (const [m, ids] of treks) {
    if (++n % 8 === 0) yield;
    out.push(trekEntry(ctx, ids, trekWars.get(m)));
  }
  for (const ids of plagues.values()) {
    if (++n % 32 === 0) yield;
    if (pandemics.has(A[ids[0]].war)) continue;
    // 作者下的瘟疫没传开(只有起疫那一条):干预那一条已经写了
    if (ids.length === 1 && A[ids[0]].war >= PLAGUE_IV) continue;
    out.push(plagueEntry(ctx, ids));
  }
  // 全球大疫:一场一条(子条目是逐年传到哪),凋敝结束另一条;疫后荒废的城一国一条
  for (const [k, at] of pandemics) {
    yield;
    out.push(...pandemicEntries(ctx, at, plagues.get(k) ?? []));
  }
  for (const ids of desolate.values()) out.push(desolateEntry(ctx, ids));
  yield;
  tribalEntries(ctx, tribal, out);
  yield;
  const dirUsed = new Map<number, number>();
  for (const ids of waves.values()) {
    if (++n % 32 === 0) yield;
    out.push(migrationEntry(ctx, ids, dirUsed));
  }
  yield;
  assimEntries(ctx, assim, out);
  yield;
  out.sort((a, b) => a.year - b.year || a.id - b.id);
  yield;
  const told = combine(ctx, out);
  yield;
  yield* introduce(civ, out, told);
  const again = cache.get(civ);
  if (again) return again;
  cache.set(civ, out);
  return out;
}

// ---------------------------------------------------------------------------
// 君主继位(按人物排,不是史事)

const reignCache = new WeakMap<Civ, ChronicleEntry[]>();
const polityReignCache = new WeakMap<Civ, Map<number, ChronicleEntry[]>>();

/** 君主去世的说法:[正常去世, 遇弑] */
function deathWord(p: Polity, tier: number): [string, string] {
  if (!p.eastern) return [tier >= 1 ? '驾崩' : '去世', '遇刺身亡'];
  if (p.lineage === 'khanate' || tier <= 0) return ['卒', '遇弑'];
  return [tier >= 3 ? '崩' : '薨', '遇弑'];
}

/**
 * 君主继位:同一朝里一位接一位(一朝的第一位不算,立国、分裂、复国、改朝换代那一条已经写了):
 * 东方 "大昌太宗崩,在位 23 年;太子李昭即位,是为高宗"(王国"世子",年少的加",时年 9 岁");
 * 汗国、部落 "乌耐汗国咄苾可汗卒,在位 12 年;其弟阿史那继为可汗";
 * 西幻 "索拉特国王阿尔德里克二世驾崩,在位 31 年;其子阿尔德里克三世即位";共和国 "提布里亚执政官卡西乌斯任满,马库斯继任"。
 * 新君是先君的什么人按世系说(peopleText.ts 的 kinOf:子、孙、弟、兄、侄、叔父……;连不上的写"宗室")。
 * 名臣迎立、辅政的写上他:"…;丞相某某迎立其兄柳清瑶,是为睿宗""…,时年 11 岁,丞相某某辅政"。
 * 诸子争储(Person.claim,royals.ts):"…;三子李昭以军功即位""…;诸子争立,三子李昭举兵杀其兄李明,即位"
 * "…;诸子争立,三子李昭谮杀其兄李明,即位""…;太子李昭即位,…;其兄李明拥兵争位,兵败被杀""…;其弟李昭杀太子李明,即位"(西幻平实些)。
 * 标签"嗣",重要度 1;id = civ.annals.length + 新君的 Person.id。没有人物 = 空数组。
 * 不在 buildChronicle 里(那里只有史事,AI 材料、地点的纪事都用它);要列继位的地方自己并进去(mergeChronicle)。按 civ 缓存
 */
export function reignEntries(civ: Civ): ChronicleEntry[] {
  const hit = reignCache.get(civ);
  if (hit) return hit;
  const out: ChronicleEntry[] = [];
  const n = peopleOf(civ)?.rulers.length ?? 0;
  for (let q = 0; q < n; q++) for (const e of polityReigns(civ, q)) out.push(e);
  out.sort((a, b) => a.year - b.year || a.id - b.id);
  reignCache.set(civ, out);
  return out;
}

/** 一国的君主继位(= filterChronicle(reignEntries(civ), { polity }),条目是同一批对象);只算这一国,国家面板第一次打开不用算全世界的 */
export function polityReigns(civ: Civ, polity: number): ChronicleEntry[] {
  let byPolity = polityReignCache.get(civ);
  if (!byPolity) polityReignCache.set(civ, (byPolity = new Map()));
  const hit = byPolity.get(polity);
  if (hit) return hit;
  const out: ChronicleEntry[] = [];
  const ix = peopleOf(civ);
  const list = ix?.rulers[polity];
  if (list) pushReigns(civ, ix, list, out);
  out.sort((a, b) => a.year - b.year || a.id - b.id);
  byPolity.set(polity, out);
  return out;
}

/** 一国(ix.rulers 的一项)历代君主的继位条目追加到 out */
function pushReigns(civ: Civ, ix: PeopleIndex | null, list: readonly Person[], out: ChronicleEntry[]) {
  const n0 = civ.annals?.length ?? 0;
  for (let k = 1; k < list.length; k++) {
    const x = list[k];
    const prev = list[k - 1];
    const p = polityOf(civ, x.polity);
    if (!p || x.rise !== 'heir' || (prev.dynasty ?? 0) !== (x.dynasty ?? 0) || x.from === undefined) continue;
    // 摄政的叔父废了幼主自立:掌实权那一条(篡位)已经写了
    if (x.claim?.how === 'seize') continue;
    const y = x.from;
    const tier = Math.max(0, polityTierAt(p, y - 1 / 512));
    const reign = Math.floor(y) - Math.floor(prev.from ?? y);
    const span = reign >= 1 ? `,在位 ${reign} 年` : '';
    const ref = rulerRef(civ, prev, y);
    const minis: Person[] = [];
    let text: string;
    if (!royalSeg(p, x.dynasty ?? 0)) text = `${ref}任满,${x.name}继任`;
    else if (prev.author !== undefined) {
      // 作者立的君主到期退位(生死归人物卡管),继他之位的不连成他的儿子
      const then = p.eastern && (p.lineage === 'khanate' || tier <= 0) ? `${x.name}继为${p.lineage === 'khanate' && tier > 0 ? khanWord(x) : '首领'}` : p.eastern ? `${x.name}即位${x.title ? `,是为${rulerTitle(civ, x)}` : ''}` : `${rulerShort(civ, x)}即位`;
      text = `${ref}退位${span};${then}`;
    } else {
      const [died, killed] = deathWord(p, tier);
      const k = kinOf(civ, prev, x);
      const heir = p.eastern && p.lineage !== 'khanate' && tier >= 2 ? heirWord(x, tier) : '';
      const child = childWord(x);
      let kin = !k ? '宗室' : k !== child ? `其${k}` : heir || `其${child}`;
      const age = ageAt(x, y);
      const young = age < 15 ? `,时年 ${age} 岁` : '';
      const east = classical(p);
      // 诸子争储:换掉"太子某某"那一截(前面加"诸子争立,"、后面接"兵败被杀"的写在最后)
      let fight = '';
      let tail = '';
      // 先君晚年引兵入朝的:杀兄弟写在掌权那一条里,即位这里照寻常写
      const claim = x.claim?.how === 'march' ? undefined : x.claim;
      if (claim && ix) {
        const rivals = claim.rivals.map((id) => civ.people![id]).filter(Boolean);
        // "其兄李明、李晖、弟李曜":和前一个同辈分的不再写
        const kins = rivals.map((r) => kinOf(civ, x, r) || kinWord(r, '兄'));
        const list = rivals.map((r, i) => `${i ? '' : '其'}${i && kins[i] === kins[i - 1] ? '' : kins[i]}${r.name}`).join('、');
        // 第几个儿子 / 女儿(同性别里排):长子、次子、三子……(养子写养子)
        const sons = ix.kids.get(prev.id) ?? [];
        const n = sons.filter((o) => !o.adopted && isFemale(o) === isFemale(x)).indexOf(x);
        const ord = k === kinWord(x, '养子') ? k : k !== child ? kin : n === 0 ? `长${child}` : n === 1 ? `次${child}` : n > 1 ? `${cnNumber(n + 1)}${child}` : kin;
        const fights = `${rivalsWord([x, ...rivals], east)},`;
        if (claim.how === 'merit') kin = `${ord}${x.name}以${east ? '军功' : '战功'}越${list}`;
        else if (claim.how === 'coup') {
          fight = fights;
          kin = `${ord}${x.name}${east ? '举兵' : '起兵入宫,'}杀${list},`;
        } else if (claim.how === 'intrigue') {
          fight = fights;
          kin = east ? `${ord}${x.name}谮杀${list},` : `${ord}${x.name}构陷${list}致死,`;
        } else if (claim.how === 'usurp') {
          const r = rivals[0];
          // 杀的是先君的太子(世子;这一刻名义上的继承人是 r)
          const rHeir = p.eastern && p.lineage !== 'khanate' && tier >= 2 ? heirWord(r, tier) : '';
          kin = `${kin}${x.name}杀${rHeir || `其${(r && kinOf(civ, x, r)) || '族人'}`}${r?.name ?? ''},`;
        } else if (claim.how === 'revolt' && rivals.length) tail = `;${list}${east ? '拥兵争位,兵败被杀' : '起兵争位,兵败被杀'}`;
      }
      // 名臣迎立(先君遇弑)、辅政(幼主);争储的不写迎立
      const by = prev.fate === 'murdered' && !fight && claim?.how !== 'usurp' ? ix?.enthrone.get(x.id) : undefined;
      const regent = ix?.regent.get(x.id);
      const lead = by ? `${ministerRef(by, y)}${east ? '迎立' : '拥立'}` : '';
      let then: string;
      // 争储换掉了"太子某某"那一截的,名字已经在 kin 里
      const nm = (s: string) => (claim && claim.how !== 'revolt' ? '' : s);
      if (p.eastern && p.lineage === 'khanate') then = by ? `${lead}${kin}${x.name}为${tier <= 0 ? '首领' : khanWord(x)}` : `${kin}${nm(x.name)}继为${tier <= 0 ? '首领' : khanWord(x)}`;
      else if (p.eastern && tier <= 0) then = by ? `${lead}${kin}${x.name}为首领` : `${kin}${nm(x.name)}继为首领`;
      else if (p.eastern) then = `${lead}${kin}${nm(x.name)}${by ? '' : '即位'}${x.title ? `,是为${rulerTitle(civ, x)}` : ''}`;
      else then = claim && claim.how !== 'revolt' ? `${kin}即位${x.title ? `,是为${rulerShort(civ, x)}` : ''}` : `${lead}${kin}${rulerShort(civ, x)}即位`;
      then = fight + then;
      // 叔父摄政(regents.ts):"…,时年 9 岁,叔父某某摄政"
      const uncle = ix?.uncle.get(x.id);
      const uk = uncle ? kinOf(civ, x, uncle) || kinWord(uncle, '叔父') : '';
      // 太后临朝(consorts.ts):"…,时年 11 岁,太后江晚萦临朝称制"(西幻"…,皇太后某某摄政")
      const dowager = ix?.dowager.get(x.id);
      const aid = uncle
        ? `,${uk.length === 1 ? '其' : ''}${uk}${uncle.name}摄政`
        : dowager
          ? `,${dowagerWordOf(civ, dowager, y)}${dowager.name}${east ? '临朝称制' : '摄政'}`
          : !regent
            ? ''
            : regent === by
              ? east
                ? ',遂辅政'
                : ',并摄政'
              : `,${ministerRef(regent, y)}${east ? '辅政' : '摄政'}`;
      // 作者让他去世的:那一年的干预那一条已经写了"暴崩,在位几年"
      text = prev.killed !== undefined ? `${ref}既${died};${then}${young}${aid}${tail}` : `${ref}${prev.fate === 'murdered' ? killed : died}${span};${then}${young}${aid}${tail}`;
      if (by) minis.push(by);
      if (regent && regent !== by && !uncle) minis.push(regent);
      if (uncle) minis.push(uncle);
      if (dowager) minis.push(dowager);
    }
    out.push({
      id: n0 + x.id,
      kind: 'reign',
      year: y,
      end: y,
      text,
      tag: '嗣',
      importance: 1,
      polities: [p.id],
      regions: [],
      settlement: -1,
      people: [prev.id, x.id, ...minis.map((m) => m.id), ...(x.claim && x.claim.how !== 'march' ? x.claim.rivals : [])],
    });
  }
}

/** 两串按年份排好的纪事并成一串(同一年按 id;继位的 id 比史事大,同一刻排在史事后面) */
export function mergeChronicle(a: readonly ChronicleEntry[], b: readonly ChronicleEntry[]): ChronicleEntry[] {
  if (!b.length) return a.slice();
  if (!a.length) return b.slice();
  const out: ChronicleEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && (a[i].year < b[j].year || (a[i].year === b[j].year && a[i].id <= b[j].id)))) out.push(a[i++]);
    else out.push(b[j++]);
  }
  return out;
}

/**
 * 只看一国时的"全部":这一国的纪事,按年份并进这一国的历代君主继位。
 * 编年史页按国家看时列的、国家面板"全部 N 件"数的都是这一份(两边条数对得上)
 */
export function polityChronicle(civ: Civ, all: readonly ChronicleEntry[], polity: number): ChronicleEntry[] {
  return mergeChronicle(filterChronicle(all, { polity }), polityReigns(civ, polity));
}

export interface ChronicleFilter {
  /** 只看大事(重要度 ≥ MAJOR) */
  major?: boolean;
  /** 只看和这个国家有关的(null / 不给 = 全部国家) */
  polity?: number | null;
}

/** 这一条和某国有关(折叠条目:它自己或任一子条目) */
export function entryInvolves(e: ChronicleEntry, polity: number): boolean {
  return e.polities.includes(polity) || !!e.children?.some((c) => c.polities.includes(polity));
}

/** 按"大事 / 全部"、国家筛选(保持顺序) */
export function filterChronicle(entries: readonly ChronicleEntry[], f: ChronicleFilter): ChronicleEntry[] {
  const pol = f.polity ?? null;
  return entries.filter((e) => (!f.major || e.importance >= MAJOR) && (pol === null || entryInvolves(e, pol)));
}

/**
 * 纯文本(复制给 OC 作者写设定用):一条一行,折叠条目的子条目缩进列在下面;era = 年份照这个纪年写;months = 一年几个月(0 = 只写年);
 * monthNames = 月份的名字(没有 = 写数字)
 */
export function chronicleText(entries: readonly ChronicleEntry[], title?: string, era?: Era, months = 0, monthNames?: readonly string[] | null): string {
  const lines: string[] = [];
  if (title) lines.push(title, '');
  for (const e of entries) {
    lines.push(eraText(`${entryYearMonthLabel(e, months, monthNames)} ${e.text}`, era));
    for (const c of e.children ?? []) lines.push(eraText(`    ${entryYearMonthLabel(c, months, monthNames)} ${c.text}`, era));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 导出(阶段 4):整本编年史写成 Markdown / 纯文本文件,给 OC 作者拿去写设定

/** 导出时一个时代(一节)多少年:整段历史分成五到八节 */
export function chronicleEraYears(endYear: Year): number {
  const want = Math.max(1, endYear) / 6;
  return [50, 100, 200, 250, 500, 1000, 2000].find((n) => n >= want) ?? 5000;
}

export interface ChronicleDocOptions {
  format: 'md' | 'txt';
  /** 标题里的世界种子 */
  seed: number;
  /** 和默认值不同的世界参数(一句话,可选;同一种子 + 参数 = 同一个世界) */
  params?: string;
  /** 一节多少年;不给按 chronicleEraYears */
  eraYears?: number;
  /** 全部纪事(不给 = buildChronicle 的史事;界面上导出时给史事 + 宗教大事,见 religionText.ts 的 fullChronicle) */
  entries?: readonly ChronicleEntry[];
  /** 年份照这个纪年写(不给 = "第 N 年";分节照样按第几年分) */
  era?: Era;
  /** 一年几个月,纪事写到哪一月(不给 / 0 = 只写年) */
  months?: number;
  /** 月份的名字(第 i 个 = 第 i + 1 月;不给 / 空着 = 写数字) */
  monthNames?: readonly string[];
}

/** Markdown 里有特殊含义的几个符号前面加反斜杠(纪事是中文,一般用不到,防个万一) */
function mdEscape(s: string): string {
  return s.replace(/([\\`*_[\]<>#|])/g, '\\$1');
}

/**
 * 整本编年史:标题带种子和年份范围;先"大事"(一页简史,按时代分节,不列战争里的每一件事),
 * 再"全部纪事"(按时代分节,战争等折叠条目的每一件事缩进列在下面)。同一个 civ 永远得到同样的文字。
 */
export function chronicleDocument(civ: Civ, opt: ChronicleDocOptions): string {
  const md = opt.format === 'md';
  const all = opt.entries ?? buildChronicle(civ);
  const majors = filterChronicle(all, { major: true });
  const end = Math.floor(civ.endYear);
  const span = Math.max(1, Math.floor(opt.eraYears ?? chronicleEraYears(civ.endYear)));
  const era = opt.era;
  const months = opt.months ?? 0;
  const names = opt.monthNames;
  const title = eraText(`编年史 · 种子 ${opt.seed} · 第 0—${end} 年`, era);
  const esc = md ? (s: string) => mdEscape(eraText(s, era)) : (s: string) => eraText(s, era);
  const out: string[] = [];
  out.push(md ? `# ${esc(title)}` : title, '');
  const about = all.length
    ? `「文明与地图」推演生成。大事 ${majors.length} 条(一页简史);全部 ${all.length} 条(每一次攻占、洗劫、同化、迁徙都在)。`
    : '「文明与地图」推演生成。这颗星球上没有文明兴起,编年史是空的。';
  const params = opt.params ? `世界参数:${opt.params}(同一种子 + 参数 = 同一个世界)` : '同一种子 + 默认参数 = 同一个世界。';
  if (md) out.push(`> ${esc(about)}  `, `> ${esc(params)}`, '');
  else out.push(about, params, '');

  // 最后一节包含结束年份(三千年:第 2500—3000 年,不单开一节"第 3000—3000 年")
  const lastEra = Math.max(0, Math.ceil(end / span) - 1);
  const eraOf = (y: Year) => Math.min(Math.floor(Math.max(0, y) / span), lastEra);
  const eraTitle = (i: number) => esc(`第 ${i * span}—${i === lastEra ? end : (i + 1) * span - 1} 年`);
  const section = (name: string, list: readonly ChronicleEntry[], children: boolean) => {
    out.push(md ? `## ${name}` : `════ ${name} ════`, '');
    if (!list.length) out.push('(无)', '');
    let sec = -1;
    for (const e of list) {
      const i = eraOf(e.year);
      if (i !== sec) {
        if (sec >= 0) out.push('');
        sec = i;
        out.push(md ? `### ${eraTitle(i)}` : `【${eraTitle(i)}】`, '');
      }
      const ey = esc(entryYearMonthLabel(e, months, names));
      out.push(md ? `- **${ey}** ${esc(e.text)}` : `${ey} ${esc(e.text)}`);
      if (children)
        for (const c of e.children ?? []) {
          const cy = esc(entryYearMonthLabel(c, months, names));
          out.push(md ? `  - ${cy} ${esc(c.text)}` : `    ${cy} ${esc(c.text)}`);
        }
    }
    out.push('');
  };
  if (all.length) {
    section('大事', majors, false);
    section('全部纪事', all, true);
  }
  return out.join('\n');
}
