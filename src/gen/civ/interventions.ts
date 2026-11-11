/**
 * 干预(阶段 4):作者在某一年给历史下的"命令" —— 不许灭、结盟、宣战、禁止分裂、划州、立国、迁都、不许扩张
 * (种类、字段、年份语义见 gen/edits.ts 文件头)。推演时在这里执行;挂在同一个推演引擎(sim.ts)上,改归属照旧走 setOwner,
 * 这里只定规则、下命令。
 *
 * 做法:**带着干预从第 0 年整段重推**(推演确定、便宜:文明部分一两百毫秒)。
 *   - 干预年份之前和不干预时逐字节一致:规则只在"年份 ≥ from"时生效;每条干预在 from 那一刻有一个事件(Ev.Intervene),
 *     在所有别的事件之前预约(scheduleInterventions:同一刻里只排在地形大事和看王朝、新君即位、迁都后重看边地后面,
 *     见 sim.ts 的 earlyOrder),别的事件之间的先后不变;
 *     随机数照旧 keyed(和处理顺序无关),干预前的随机数一个都不变。
 *   - 干预年份之后按新规则展开,受波及的地方才变。
 *
 * 国家用稳定键(`polity:c4567#0`,见 edits.ts):要用时才解析成编号。键只由"立国时国都在哪州 + 这州第几个立国"定
 *   (州按地块找:包含地块 4567 的那一州;旧格式 `polity:r123#0` 直接是州号),国家一立国键就定了,
 *   所以按立国先后增量建一张"州号#第几个 → 编号"表即可(和 edits.ts 的 resolveKey 一致,有单测)。
 *   城键(`settlement:c4567#1`,迁都用)同理:按建城先后增量建。州键(`region:c4567`)= 包含这个地块的州。
 *   键指不到(新历史里没有这个国家、或者还没立国;改地形后那块地方成了水)= 这条干预此刻不生效,不报错。
 *
 * 各机制在做决定的地方查一下(WarModel.iv、PolityModel.iv;没有干预时为空,只多一次判空,推演不变慢):
 *   不许灭 protect   wars.ts 挑要打的州时跳过它的国都所在州,只剩几州时一州都不打(国都攻不下 → 不会亡国,也不会因丢了国都残部被并);
 *                   politics.ts 的合并不会把它并掉。国土照样会丢(可以缩小),照样会分裂、改朝换代。
 *                   有 until 的:until 那一刻起不再护着(都是做决定时现查,不用另外预约事件),之后照常会被攻灭、被并
 *   结盟   ally      wars.ts 看邻国时不对盟国宣战;结盟那一刻两国若在交战,当即议和;
 *                   一方被第三国宣战时,另一方(和攻方接壤)多半援盟参战(见 wars.ts 的 ALLY_JOIN;史事 war 的 settlement 列记盟国)
 *   宣战   declare   from 那一刻强制开战(不管停战冷却、歇战、同时在打几场);两国不接壤 / 已在交战 / 有一方已亡 = 打不成
 *   禁止分裂 unity   politics.ts 的分裂不会发生;它的国土里不会有遗民起兵复国
 *   保住王室 keep    dynasty.ts 看王朝时本该改朝换代(豪强起兵、国都权臣篡位)的那一回挡下,regency.ts 掌实权的人到期篡位的那一回改成
 *                   名臣、大臣伏诛 / 叔父还政;挡下的都记一条史事 keep(未遂)。随机数照旧掷,只是不换。有人掌实权、争储、亡国、分裂照旧。
 *                   即位带 keep 的:作者的人物在位的那些年同样保住(那一刻在位的是他才算,见 keeps)。有 until 的到那一刻止(做决定时现查)。
 *                   和作者下令"让他掌权"到期篡位撞上:后下的为准(和灭国撞上不许灭一样)
 *   划州   cede      from 那一刻州归 a(setOwner,原因 Ev.Cede;州里没人住 / a 已亡 = 划不成)。原主国照常:划走的是它的国都就迁都到
 *                   剩下的城里人口最多的(和战争里国都失守一样挑),剩下的州里一座城都没有就连同余州归 a、亡国;只有这一州的就亡了。
 *                   带"永久"的:这州还在 a 手里时 —— wars.ts 攻不下、议和不割让,a 丢了国都也不会被并掉残部;
 *                   politics.ts 分裂、复国不带走它(被切断就这次不分),a 是小国也不会被合并掉(locked / holdsLock)
 *   立国   found     from 那一刻以这州的城为国都立一个新国家(polities.ts 的 addPolity;州里没城就先建城 —— 故城遗址上的算重建;
 *                   民族 = 当地民族;州里还没人住(住得了人)= 那一刻一支新民族来这里落脚(定民族时备好的,cultures.ts 的 planPioneers),民族就是它;变化日志原因记 Ev.PolityFound,和自然立国一样:之后按正常规则扩张、打仗、看内政……)。
 *                   州原来有主的,新国从原主分出来(Polity.parent:站稳期里别国不来打,配色和原主错开);原主照"划州"那样迁都 / 亡国。
 *                   国名:给了就用(namePolities 不再另起),不给按常规起
 *   迁都   move      from 那一刻迁都到这座城(polities.ts 的 moveCapital;城要在 a 的国土里、没被毁,否则不迁)
 *   不许扩张 halt    polities.ts 的"国家到达"不去(不进无主的州);wars.ts 看邻国时不宣战、不援盟;politics.ts 不合并别国;
 *                   from 那一刻它挑起的(它是攻方的)战争当即议和。被打时照常防守、反攻夺回自己的州(守方的反攻本来就只打丢掉的州)。
 *                   有 until 的:until 那一刻(Ev.HaltEnd,同一刻里比干预事件还早)从现有国土重新预约扩张(polities.ts 的 respread)
 *   坚持打 press     from 那一刻起这一仗不许引擎自己议和(wars.ts 的厌战、僵持、国用不足、受降罢兵都不算数);
 *                   b 给了就只管跟 b 打的仗,不给管 a 参与的所有仗(不含讨伐民变)。a 那时已亡 = 不生效。
 *                   君主自己下的 ally / halt / destroy、以及一方亡国等强制结束照旧(那些不走这条判定)。
 *                   有 until 的到那一刻止(议和判定时现查,不用预约结束事件)
 *   即位   crown     from 那一刻作者的人物成为 a 的君主:a 那时已亡 / 他还没出生 = 不生效(史事照记,b 列写原因);
 *                   生效了在位表跟着改(polities.ts 的 crownRuler、rulers.ts):此刻在位的那一位让位,他从下一刻起按自己的倾向
 *                   扩张、打仗、议和,在位到 until(不给 = 寻常君主的在位年数)、改朝换代或亡国,之后照常继位。
 *                   他在位时 a 的强制宣战由他亲征(people.ts 排统帅时)
 *   方针   policy    from 那一刻 a 定方针(polities.ts 的 setPolicy;a 那时已亡 = 不生效,b 列 −3,生效了 −1),下一刻起照方针和君主的倾向一起算,
 *                   直到 a 的下一条方针(什么都没定的 = 罢方针)。怎么加减、亲仇和发展重点管什么见 policy.ts
 *   即位带 after     from 那一刻登记(b 列 −6),此刻在位的那位到期下台、被作者让他去世时作者的人物继位(rulers.ts;那一刻 polities.ts 另记一条 b = −1)
 *   灭国   destroy   from 那一刻 a 亡:国土一并归 b(b 那时已亡 / 指不到 / 没给 = 散成无主,接壤各国照规矩预约扩进去,polities.ts 的 reopen),
 *                   它打着的仗全部结束(和划州里亡国一样记 fall)。a 那时已亡 = 不生效(b 列 −3)。和"不许灭"撞上:后下的为准 ——
 *                   那一刻护着 a 的"不许灭"里有排在这条灭国后面(后下)的 = 不生效(b 列 −7,IV_PROTECTED);都是先下的 = 照灭
 *   让人物去世 death  君主:from 那一刻在位的是他(按人物键里的生年认;作者立的君主不算)才生效,在位表跟着改(rulers.ts:他到此刻为止,
 *                   下一位从下一刻起照常继位);将领、名臣:推演里只记一笔(b 列 −5),人物那边按卒年换人(people.ts、officials.ts)
 *   改君主倾向 temper from 那一刻在位的是他才生效(同一刻已被让他去世、已让位的不算),下一刻起照新的倾向,到他下台为止(rulers.ts 的 moods);
 *                   门槛放低了的,下一刻从现有国土往外重新看一遍(和定方针一样)
 *   任将任臣 appoint 推演里只在 from 那一刻记一笔史事(b 列见 appoint.ts 的 IV_REIGNING 那几样),历史一字不变;
 *                   他在任的年份、挂帅哪几仗由 appoint.ts 按史事推出来,人物、编年史照它排。
 *                   将领带了能力(良将 / 名将)的例外:他挂帅的仗本方兵力加成(接口 war.led,见下面的 authorLed)
 *   天灾   disaster  瘟疫、饥荒、地震水旱:受灾的城人口掉一截,国内更动荡,不改地形(disaster.ts)
 *   推一把发展 boost  快几倍:那些州发展度的"自己长""向邻居学"乘上去,管到 until;直接进:那一刻拉到国都的下一个时代开头(boost.ts)
 *   立约   treaty    from 那一刻几国立约(treaties.ts 的 decree;两两之间正在交战的当即议和),之后照立约的规矩续约、背约、约满;
 *                   期限、种类、不许背约、居间、同时划的中立地照作者填的。演一国时下的(ask)对方照推演的规矩定肯不肯
 *   划中立地 neutral  from 那一刻这州成了几国共建的中立地(treaties.ts 的 decree):几国已同在一份还没设中立地的约里就依它设,
 *                   不然同时立一个互不侵犯之约;不送人去、一直留着、到某一年撤照作者填的
 *   多看一眼 照大纲顺着引的方针带 look:look.years 每年的年中(Ev.Look,装各层时预约,同一刻里排在干预事件后面)替 a 多看一眼
 *                   邻国(wars.ts)/ 内政(politics.ts:大崩解、分裂)/ 王朝(dynasty.ts),和寻常那一次一样定,只是不接着预约下一次;
 *                   那时 a 照的已经不是这条方针(被作者的、别的方针换掉了)= 不看
 *
 * 每条干预在 from 那一刻记一条史事 intervene(字段见 types.ts 的 AnnalKind;A 的键指不到就不记),编年史写"【干预】……"。
 * 紧跟着记它引起的事:宣战的 war(盟国、宗藩之间开战,war 前面先记盟约 / 宗藩之分断了的 unally / defect,见 diplomacy.ts)、结盟 / 不许扩张引起的 peace、立国的 found、迁都的 capital、原主国迁都的 capital / 亡国的 fall。
 *
 * **不存内存状态**:Civ + 干预列表就能接着推(resumeCiv(world, civ, 干预列表)):规则本来就只看列表和当时的归属,
 *   还没到 from / until 的事件由 scheduleInterventions 按"比现在晚"补上;已经过去的"不许扩张到期"那一刻预约的扩张,
 *   由 resumePolities 按日志重放补上(haltEndsUpTo);已经生效的即位、方针由 resumePolities 按史事 intervene 推出来(rulers.ts 的 crownsFrom、policy.ts 的 policiesFrom)。
 *   逐年推演(play.ts)停在第 T 年年初的前一刻,在列表后面接上 from = T 的新命令:比现在晚,和别的还没到的干预一样补上事件,
 *   同一刻里照样排在别的事件前面、按列表先后 —— 所以停下来下命令接着推,和带着同样的命令一口气推完一样。纯计算,不碰 DOM。
 */
import { GUIDE_LOOK_MAX, YEAR_TICKS, cleanInterventions, commandAt, isCommand, keyByRegion, parsePersonKey, regionOfKey, simInterventions, type Intervention } from '../edits';
import { Layer, type Culture, type Polity } from './types';
import { subSeed } from './engine/rand';
import { LOOK_K, quantize, type CivSim } from './engine/sim';
import { addPolity, bookOf, endPolity, foundCity, moveCapital, polityModelOf, reopen, respread, rulerAct, rulerOf, setPolicy, type PolityModel } from './polities';
import { IV_NOT_HIM, IV_PEOPLE, IV_PROTECTED, IV_WAIT, crownOf, reignBorn } from './rulers';
import { strikeDisaster } from './disaster';
import { strikePetty, type PettyIv } from './pettyEngine';
import { strikeStory, type StoryIv } from './storyEngine';
import { segAt } from './policy';
import { bestCapital, polityBorders, warModelOf, type War } from './wars';
import { politicsModelOf } from './politics';
import { dynastyModelOf } from './dynasty';
import { capitalAt } from './growth';
import { CITIES_KNOBS } from './cities';
import { pioneerArrives } from './cultures';
import { treatyModelOf } from './treaties';
import { regencyModelOf } from './regency';
import { marriageModelOf } from './marriage';
import { installBoosts, strikeBoost } from './boost';
import { trekModelOf } from './migration';
import { assimModelOf } from './assimilation';
import { APPOINT_AGE, IV_REIGNING, appointEnd, authorLeadsNow, skillPower, type AppointInput, type AppointIv, type AuthorLead } from './appoint';
import { IV_GONE, authorRegentEnd, regentAt } from './regents';
import type { CivModule } from './modules';
import { Ev } from './events';
import { civApi } from './api';

type Ally = Extract<Intervention, { kind: 'ally' }>;
type Halt = Extract<Intervention, { kind: 'halt' }>;
type Press = Extract<Intervention, { kind: 'press' }>;
type Petty = PettyIv;
type Cede = Extract<Intervention, { kind: 'cede' }>;
type Found = Extract<Intervention, { kind: 'found' }>;
type Move = Extract<Intervention, { kind: 'move' }>;
type CrownIv = Extract<Intervention, { kind: 'crown' }>;
type PolicyIv = Extract<Intervention, { kind: 'policy' }>;
type DestroyIv = Extract<Intervention, { kind: 'destroy' }>;
type PersonIv = Extract<Intervention, { kind: 'death' | 'temper' }>;
type Stay = Extract<Intervention, { kind: 'stay' }>;

/** 推演里的干预:清理过的列表 + 键 → 编号的解析 + 各机制查询用的规则 */
export class InterventionModel {
  private _list: readonly Intervention[];
  private _stored: readonly Intervention[];
  /** 推演插件下了命令以后列表换成自己的一份(传进来的可能是别人的数组,不能改) */
  private copied = false;
  /** 推演插件下的命令:生效那一刻(1/256 年为单位)→ 列表里的下标(按列表先后) */
  private readonly commands = new Map<number, number[]>();
  /** 已经预约了 Ev.Command 的那几刻 */
  readonly booked = new Set<number>();
  /** keyed 随机数的根(援盟) */
  readonly base: number;
  /** 城镇 / 国家模型(installInterventions 时挂上;解析键要用) */
  pm: PolityModel | null = null;
  /** 国家层的归属(installInterventions 时挂上;永久划州要看州此刻在谁手里) */
  owner: Int16Array | null = null;
  private readonly protectRules: Extract<Intervention, { kind: 'protect' }>[] = [];
  private readonly unityRules: Extract<Intervention, { kind: 'unity' }>[] = [];
  private readonly allyRules: Ally[] = [];
  private readonly haltRules: Halt[] = [];
  private readonly pressRules: Press[] = [];
  private readonly stayRules: Stay[] = [];
  /** 保住王室:开关(keep)的下标;即位带 keep 的有没有 */
  private readonly keepRules: number[] = [];
  private crownKeeps = false;
  /** 永久划州:州号、得到它的国家(键)、年份(州键要按地块找州:挂上国家模型时才解析,见 bindRegions) */
  private lockRules: { region: number; a: string; from: number }[] = [];
  /** 有永久划州的州(先查它,别的州不用扫规则) */
  private readonly lockRegions = new Set<number>();
  /** 稳定键 → 按州定位的内部键(`polity:123#0`;解析一次记下;null = 格式不对 / 那块地方是水) */
  private readonly refs = new Map<string, string | null>();
  /** 内部键 `polity:123#0` → 国家编号(按立国先后增量建);known = 已经登记到第几个国家 */
  private readonly ids = new Map<string, number>();
  private readonly perRegion = new Map<number, number>();
  private known = 0;
  /** 内部键 `settlement:123#0` → 城编号(按建城先后增量建) */
  private readonly cityIds = new Map<string, number>();
  private readonly cityPerRegion = new Map<number, number>();
  private knownCities = 0;

  constructor(list: readonly Intervention[], seed: number, stored: readonly Intervention[] = list) {
    this._list = list;
    this._stored = stored;
    this.base = subSeed(seed, 'civ-intervene');
    list.forEach((v, i) => this.rule(v, i));
  }

  /** 推演用的干预(edits.ts 的 simInterventions:年中的 from 就是那一刻) */
  get list(): readonly Intervention[] {
    return this._list;
  }

  /** 清理过的原样(年中的照旧是 from + fromTick;Civ.interventions 存这一份) */
  get stored(): readonly Intervention[] {
    return this._stored;
  }

  /** 列表里有推演插件下的命令 */
  get commanded(): boolean {
    return this.commands.size > 0;
  }

  /** 第 i 条(推演用的那一份)登记进各机制查的规则 */
  private rule(v: Intervention, i: number): void {
    if (isCommand(v)) {
      const t = Math.round(v.from * YEAR_TICKS);
      const at = this.commands.get(t);
      if (at) at.push(i);
      else this.commands.set(t, [i]);
    }
    if (v.kind === 'protect') this.protectRules.push(v);
    else if (v.kind === 'unity') this.unityRules.push(v);
    else if (v.kind === 'ally') this.allyRules.push(v);
    else if (v.kind === 'halt') this.haltRules.push(v);
    else if (v.kind === 'press') this.pressRules.push(v);
    else if (v.kind === 'stay') this.stayRules.push(v);
    else if (v.kind === 'keep') this.keepRules.push(i);
    else if (v.kind === 'crown' && v.keep === true) this.crownKeeps = true;
  }

  /** 接上一条推演插件下的命令(清理过、带 plugin 的原样);返回它在列表里的下标 */
  add(v: Intervention): number {
    if (!this.copied) {
      this._list = this._list.slice();
      this._stored = this._stored.slice();
      this.copied = true;
    }
    const sim = simInterventions([v])[0];
    (this._stored as Intervention[]).push(v);
    (this._list as Intervention[]).push(sim);
    const i = this._list.length - 1;
    this.rule(sim, i);
    if (sim.kind === 'cede' && sim.permanent && this.pm) this.bindRegions();
    return i;
  }

  /** t 那一刻生效的推演插件命令(列表里的下标) */
  commandsAt(t: number): readonly number[] {
    return this.commands.get(Math.round(t * YEAR_TICKS)) ?? [];
  }

  /** 推演插件的命令生效的那几刻(1/256 年为单位) */
  commandTicks(): IterableIterator<number> {
    return this.commands.keys();
  }

  /** 地块 → 州(国家模型挂上以后才有;按地块定位的键靠它找州;地形大事以后按每块地最早属于的州,见 Regions.keyOf) */
  get of(): ArrayLike<number> {
    const r = this.pm?.terrain.regions;
    return r ? (r.keyOf ?? r.of) : [];
  }

  /** 挂上国家模型以后(installInterventions):解析永久划州的州键 */
  bindRegions(): void {
    const of = this.of;
    this.lockRules = this.list
      .filter((v): v is Cede => v.kind === 'cede' && v.permanent === true)
      .map((v) => ({ region: regionOfKey(v.region, of), a: v.a, from: v.from }))
      .filter((x) => x.region >= 0);
    this.lockRegions.clear();
    for (const x of this.lockRules) this.lockRegions.add(x.region);
  }

  /** 稳定键 → 按州定位的内部键(见 edits.ts 的 keyByRegion) */
  private ref(key: string): string | null {
    let r = this.refs.get(key);
    if (r === undefined) {
      r = keyByRegion(key, this.of);
      if (this.pm) this.refs.set(key, r);
    }
    return r;
  }

  /** 国家的稳定键 → 此刻的国家编号(还没立国 / 新历史里没有 = −1) */
  resolve(key: string): number {
    const pm = this.pm;
    if (!pm) return -1;
    const P = pm.polities;
    for (; this.known < P.length; this.known++) {
      // 和 edits.ts 的 polityKey 同一个算法:立国时的国都所在州 + 这州第几个立国(国家按立国先后编号)
      const r = pm.settlements[P[this.known].capital]?.region ?? -1;
      const n = this.perRegion.get(r) ?? 0;
      this.perRegion.set(r, n + 1);
      this.ids.set(`polity:${r}#${n}`, this.known);
    }
    const k = this.ref(key);
    return k === null ? -1 : (this.ids.get(k) ?? -1);
  }

  /** 国家的稳定键 → t 那一刻之前(不含这一刻)已经立国的国家编号(接着推时重放过去的某一刻用) */
  resolveBefore(key: string, t: number): number {
    const id = this.resolve(key);
    return id >= 0 && this.pm!.polities[id].founded < t ? id : -1;
  }

  /** 城的稳定键 → 此刻的城编号(还没建 / 新历史里没有 = −1;和 edits.ts 的 settlementKey 同一个算法) */
  resolveCity(key: string): number {
    const pm = this.pm;
    if (!pm) return -1;
    const S = pm.settlements;
    for (; this.knownCities < S.length; this.knownCities++) {
      const r = S[this.knownCities].region;
      const n = this.cityPerRegion.get(r) ?? 0;
      this.cityPerRegion.set(r, n + 1);
      this.cityIds.set(`settlement:${r}#${n}`, this.knownCities);
    }
    const k = this.ref(key);
    return k === null ? -1 : (this.cityIds.get(k) ?? -1);
  }

  /** 国家 p 此刻"不许灭" */
  protects(p: number, t: number): boolean {
    for (const v of this.protectRules) if (t >= v.from && (v.until === undefined || t < v.until) && this.resolve(v.a) === p) return true;
    return false;
  }

  /** 时刻 t 护着国家 p 的"不许灭"里,有没有排在第 i 条干预后面的(灭国撞上"不许灭":后下的为准) */
  protectedAfter(p: number, t: number, i: number): boolean {
    for (let k = i + 1; k < this.list.length; k++) {
      const v = this.list[k];
      if (v.kind === 'protect' && t >= v.from && (v.until === undefined || t < v.until) && this.resolve(v.a) === p) return true;
    }
    return false;
  }

  /**
   * 民族的稳定键 → 此刻的民族编号(还没分化出来 / 新历史里没有 = −1;和 edits.ts 的 cultureKey 同一个算法:
   * 发源州 + 这州发源的第几个(按出现先后))。cultures = 推演里此刻的民族表
   */
  resolveCulture(key: string, cultures: readonly Culture[]): number {
    const k = this.ref(key);
    const m = k ? /^culture:(-?\d+)#(\d+)$/.exec(k) : null;
    if (!m) return -1;
    const r = Number(m[1]);
    const n = Number(m[2]);
    const same: number[] = [];
    for (let i = 0; i < cultures.length; i++) if (cultures[i].hearth === r) same.push(i);
    same.sort((i, j) => cultures[i].born - cultures[j].born || i - j);
    return same[n] ?? -1;
  }

  /** 民族 c 此刻"不许迁"(cultures = 推演里此刻的民族表) */
  stays(c: number, t: number, cultures: readonly Culture[]): boolean {
    for (const v of this.stayRules) if (t >= v.from && (v.until === undefined || t < v.until) && this.resolveCulture(v.folk, cultures) === c) return true;
    return false;
  }

  /** 国家 p 此刻"禁止分裂" */
  unites(p: number, t: number): boolean {
    for (const v of this.unityRules) if (t >= v.from && this.resolve(v.a) === p) return true;
    return false;
  }

  /**
   * 国家 p 此刻"保住王室":护着它的那一条干预的下标(开关 keep 在生效期里;即位带 keep 的,此刻在位的是那位作者的人物);
   * 有几条时取列表里靠前的;没有 = −1。after = 只算排在第 after 条后面(后下)的(作者下令的篡位撞上保住王室:后下的为准)
   */
  keeps(p: number, t: number, after = -1): number {
    let best = -1;
    for (const i of this.keepRules) {
      const v = this.list[i] as Extract<Intervention, { kind: 'keep' }>;
      if (i > after && t >= v.from && (v.until === undefined || t < v.until) && this.resolve(v.a) === p) {
        best = i;
        break;
      }
    }
    if (this.crownKeeps && this.pm) {
      const c = rulerOf(this.pm, p, t).crown;
      const v = c ? this.list[c.iv] : undefined;
      if (c && c.iv > after && v?.kind === 'crown' && v.keep === true && (best < 0 || c.iv < best)) best = c.iv;
    }
    return best;
  }

  /** 国家 p 此刻"不许扩张" */
  halted(p: number, t: number): boolean {
    for (const v of this.haltRules) if (haltActive(v, t) && this.resolve(v.a) === p) return true;
    return false;
  }

  /** 国家 p 此刻"坚持打"这一仗:q 是交战的另一国(b 没给的命令管它所有的仗) */
  pressing(p: number, t: number, q: number): boolean {
    for (const v of this.pressRules) {
      if (!pressActive(v, t) || this.resolve(v.a) !== p) continue;
      if (v.b === undefined || this.resolve(v.b) === q) return true;
    }
    return false;
  }

  /** 州 r 此刻是"永久划给"它现在的主人的(战争、分裂、复国、议和割地都拿不走) */
  locked(r: number, t: number): boolean {
    if (!this.lockRegions.has(r)) return false;
    const o = this.owner ? this.owner[r] : -1;
    if (o < 0) return false;
    for (const v of this.lockRules) if (v.region === r && t >= v.from && this.resolve(v.a) === o) return true;
    return false;
  }

  /** 国家 p 此刻手里有永久划给它的州 */
  holdsLock(p: number, t: number): boolean {
    if (!this.lockRules.length || !this.owner) return false;
    for (const v of this.lockRules) if (t >= v.from && this.owner[v.region] === p && this.resolve(v.a) === p) return true;
    return false;
  }

  /** 两国此刻结着盟(author = 只算作者下的) */
  allied(p: number, q: number, t: number, author = false): boolean {
    for (const v of this.allyRules) {
      if (!allyActive(v, t) || (author && isCommand(v))) continue;
      const a = this.resolve(v.a);
      const b = this.resolve(v.b);
      if ((a === p && b === q) || (a === q && b === p)) return true;
    }
    return false;
  }

  /** 此刻和 p 结着盟的国家(编号升序,不重复) */
  alliesOf(p: number, t: number): number[] {
    const out: number[] = [];
    for (const v of this.allyRules) {
      if (!allyActive(v, t)) continue;
      const a = this.resolve(v.a);
      const b = this.resolve(v.b);
      const o = a === p ? b : b === p ? a : -1;
      if (o >= 0 && o !== p && !out.includes(o)) out.push(o);
    }
    return out.sort((x, y) => x - y);
  }

  /** 到 now(含)为止已经到期的"不许扩张"(到期时刻、国家键;按处理先后:时刻先后,同一刻按列表先后) */
  haltEndsUpTo(now: number): { t: number; key: string }[] {
    const out: { t: number; key: string }[] = [];
    for (const v of this.haltRules) if (v.until !== undefined && quantize(v.until) <= now) out.push({ t: quantize(v.until), key: v.a });
    return out.sort((x, y) => x.t - y.t);
  }
}

const allyActive = (v: Ally, t: number) => t >= v.from && (v.until === undefined || t < v.until);
const haltActive = (v: Halt, t: number) => t >= v.from && (v.until === undefined || t < v.until);
const pressActive = (v: Press, t: number) => t >= v.from && (v.until === undefined || t < v.until);

const models = new WeakMap<CivSim, InterventionModel>();

/** 推演引擎上挂着的干预(测试用) */
export function interventionModelOf(sim: CivSim): InterventionModel | undefined {
  return models.get(sim);
}

/**
 * 预约各条干预的事件(在所有别的事件之前调用:同一刻里只有地形大事和看王朝、新君即位、迁都后重看边地排在干预前面;
 * "不许扩张到期"又比干预事件更早)。年中的(带 fromTick)在那一年的那一格生效(edits.ts 的 simInterventions)。
 * generateCiv 里全部预约;resumeCiv 接着推(resume)时只预约比现在晚的(已经到了的在切开之前就处理过了)。
 * 没有(合格的)干预 = null,什么都不做
 */
export function scheduleInterventions(
  sim: CivSim,
  seed: number,
  raw: readonly Intervention[] | undefined,
  resume = false,
): InterventionModel | null {
  const stored = cleanInterventions(raw);
  if (!stored.length) return null;
  const list = simInterventions(stored);
  const iv = new InterventionModel(list, seed, stored);
  list.forEach((v, i) => {
    if (v.kind === 'halt' && v.until !== undefined && (!resume || quantize(v.until) > sim.now)) sim.schedule(v.until, Ev.HaltEnd, i, 0);
  });
  list.forEach((v, i) => {
    if (!isCommand(v) && (!resume || quantize(v.from) > sim.now)) sim.schedule(v.from, Ev.Intervene, i, 0);
  });
  for (const t of iv.commandTicks()) if (!resume || t / YEAR_TICKS > sim.now) bookCommands(sim, iv, t);
  // 照大纲顺着引的方针替那国多看的几眼(年中;同一刻里排在干预事件后面)
  list.forEach((v, i) => {
    if (v.kind !== 'policy' || !v.look) return;
    v.look.years.forEach((y, j) => {
      if (!resume || quantize(y + LOOK_AT) > sim.now) sim.schedule(y + LOOK_AT, Ev.Look, i, j);
    });
  });
  return iv;
}

/** 多看一眼在那一年的什么时候(年中:不和整年份的干预撞在同一刻) */
const LOOK_AT = 0.5;

/** t 那一刻(1/256 年为单位)的推演插件命令预约一件 Ev.Command:一刻只能一件(同一刻同一类的先后分不出) */
function bookCommands(sim: CivSim, iv: InterventionModel, t: number): void {
  if (iv.booked.has(t)) return;
  iv.booked.add(t);
  sim.schedule(t / YEAR_TICKS, Ev.Command, 0, 0);
}

/**
 * 推演插件下的命令(清理过、带 plugin,from / fromTick 是生效的那一刻,要比现在晚)接在干预列表后面,到那一刻照干预办。
 * 这个世界还没有干预的,现在装上(和一开始就装上一样:规则只在 from 以后才查得到)
 */
export function issueCommands(sim: CivSim, seed: number, list: readonly Intervention[]): void {
  let iv = models.get(sim);
  if (!iv) {
    iv = new InterventionModel([], seed, []);
    installInterventions(sim, iv);
    if (models.get(sim) !== iv) throw new Error('这段推演还没有国家,不能下命令');
  }
  const now = Math.round(sim.now * YEAR_TICKS);
  if (list.some((v) => !(commandAt(v) > now))) throw new Error('命令要比现在晚才生效');
  for (const v of list) {
    iv.add(v);
    bookCommands(sim, iv, commandAt(v));
  }
}

/** 推演插件下过命令的:这段推演带着的整份干预(作者的、插件下的,按列表先后);没下过 = undefined */
export function commandedList(sim: CivSim): readonly Intervention[] | undefined {
  const iv = models.get(sim);
  return iv?.commanded ? iv.stored : undefined;
}

/** 登记干预的事件处理,把规则挂到战争模型、城镇国家模型上(installCities / resumeCities 之后调用) */
export function installInterventions(sim: CivSim, iv: InterventionModel): void {
  const api = civApi(sim);
  const pm = polityModelOf(sim);
  const wm = warModelOf(sim);
  if (!pm || !wm) return;
  models.set(sim, iv);
  iv.pm = pm;
  iv.owner = sim.owners[Layer.Polity];
  iv.bindRegions();
  wm.iv = iv;
  pm.iv = iv;
  const owner = sim.owners[Layer.Polity];
  const culture = sim.owners[Layer.Culture];
  const R = pm.terrain.R;
  const S = pm.settlements;
  const alive = (p: number) => pm.polities[p].ended === undefined;
  const capRegion = (p: number, t: number) => S[capitalAt(pm.polities[p], t)].region;

  /** 国家 o 没了最后一州(被划走 / 在那里另立新国;by = 得到它的国家):亡国,它打着的仗全部结束(和战争里亡国一样记 fall) */
  const fallen = (o: number, r: number, t: number, by: number) => {
    sim.record('fall', { a: o, b: by, region: r });
    for (const w of wm.active.filter((x) => x.a === o || x.b === o)) api.war.makePeace!(w, t);
  };

  /**
   * 国家 o 的国都所在州 r 要归别国:先挑新国都(剩下的国土里,和战争里国都失守时一样挑;那一块里没城就到别的块里挑)。
   * 返回新国都;剩下的州里一座城都没有 = −1(调用方让余州一并归过去、亡国)
   */
  const relocate = (o: number, r: number, t: number): number => {
    const sid = bestCapital(pm, owner, o, t, true, r);
    if (sid >= 0) moveCapital(pm, o, sid, t);
    return sid;
  };

  /** 划州:州 r 归 a */
  const cede = (v: Cede, i: number, a: number, t: number) => {
    const r = regionOfKey(v.region, iv.of);
    if (r < 0 || r >= R) {
      sim.record('intervene', { a, b: -2, war: i });
      return;
    }
    const o = owner[r];
    const peopled = culture[r] >= 0;
    sim.record('intervene', { a, b: peopled ? o : -2, region: r, settlement: pm.cityOf[r], war: i });
    if (!alive(a) || !peopled || o === a) return;
    const wasCap = o >= 0 && capRegion(o, t) === r;
    const sid = wasCap && pm.size[o] > 1 ? relocate(o, r, t) : -1;
    sim.setOwner(Layer.Polity, r, a, Ev.Cede);
    if (o < 0) return;
    if (!wasCap) {
      // 国都所在州总归本国所有,所以不是国都的这一州划走后原主总还有地;万一没了(不该发生),照样算亡国,不留"没有国土的国家"
      if (pm.size[o] <= 0) {
        endPolity(pm, o, t);
        fallen(o, r, t, a);
      }
      return;
    }
    if (sid >= 0) {
      sim.record('capital', { a: o, region: S[sid].region, settlement: sid });
      return;
    }
    // 原主只有这一州,或者剩下的州里一座城都没有(极少见):余州一并归 a,亡国
    for (const q of pm.lands[o].slice()) sim.setOwner(Layer.Polity, q, a, Ev.Cede);
    endPolity(pm, o, t);
    fallen(o, r, t, a);
  };

  /** 立国:以州 r 的城为国都立新国。州里没人住(住得了人的)= 先来一支新民族落脚(cultures.ts 的 pioneerArrives) */
  const found = (v: Found, i: number, t: number) => {
    const r = regionOfKey(v.region, iv.of);
    if (r >= 0 && r < R && culture[r] < 0) pioneerArrives(sim, r, i, t);
    if (r < 0 || r >= R || culture[r] < 0) {
      sim.record('intervene', { region: r < R ? r : -1, war: i });
      return;
    }
    const o = owner[r];
    // 原主的国都在这州:先迁都(国都之位先让出来,新国的国都才记得上),剩下的州里没城 / 只有这一州就亡国
    let moved = -1;
    let dies = false;
    if (o >= 0 && capRegion(o, t) === r) {
      moved = pm.size[o] > 1 ? relocate(o, r, t) : -1;
      if (moved < 0) {
        dies = true;
        endPolity(pm, o, t);
      }
    }
    // 州里没城(还没建起来,或者毁了没重建):先建城(故城遗址上的算重建)
    let sid = pm.cityOf[r];
    if (sid < 0) {
      let ruin = -1;
      for (const s of S) if (s.region === r && s.ended !== undefined) ruin = s.id;
      sid = foundCity(sim, pm, r, t, ruin >= 0 ? { of: ruin, growth: pm.knobs.get(CITIES_KNOBS).REBUILD_GROWTH } : undefined).id;
    }
    const extra: Partial<Polity> = {};
    if (v.name) extra.name = v.name;
    if (o >= 0) extra.parent = o;
    const p = addPolity(pm, sid, culture[r], t, extra);
    sim.record('intervene', { a: p.id, b: o, region: r, settlement: sid, war: i });
    sim.record('found', { a: p.id, region: r, settlement: sid });
    sim.setOwner(Layer.Polity, r, p.id, Ev.PolityFound);
    if (o < 0) return;
    if (moved >= 0) sim.record('capital', { a: o, region: S[moved].region, settlement: moved });
    else if (dies) {
      for (const q of pm.lands[o].slice()) sim.setOwner(Layer.Polity, q, p.id, Ev.Cede);
      fallen(o, r, t, p.id);
    } else if (pm.size[o] <= 0) {
      // 同划州:不该发生,万一原主没地了照样算亡国
      endPolity(pm, o, t);
      fallen(o, r, t, p.id);
    }
  };

  /** 迁都:a 迁都到城 v.city */
  const move = (v: Move, i: number, a: number, t: number) => {
    const sid = iv.resolveCity(v.city);
    const s = sid >= 0 ? S[sid] : undefined;
    // b 列:城所在州此刻的主人(= a 才迁得成;−1 = 部落地带),城已毁 = −2
    const b = !s ? -1 : s.ended !== undefined ? -2 : owner[s.region];
    sim.record('intervene', { a, b, region: s ? s.region : -1, settlement: sid, war: i });
    if (!s || !alive(a) || b !== a || capitalAt(pm.polities[a], t) === sid) return;
    moveCapital(pm, a, sid, t);
    sim.record('capital', { a, region: s.region, settlement: sid });
  };

  /** 即位:作者的人物此刻成为 a 的君主(b 列:−1 即位了 / −2 他还没出生 / −3 a 已亡 / −6 等此刻在位的那位下台再即位,登记了) */
  const crown = (v: CrownIv, i: number, a: number, t: number) => {
    const sid = capitalAt(pm.polities[a], t);
    const b = !alive(a) ? -3 : v.born > t ? -2 : v.after ? IV_WAIT : -1;
    sim.record('intervene', { a, b, region: S[sid]?.region ?? -1, settlement: sid, war: i });
    if (b === -1 || b === IV_WAIT) rulerAct(sim, pm, a, crownOf(v, t, i));
  };

  /** 灭国:a 此刻亡,国土并入 b 或散成无主(b 列:并入的国家 / −1 散成无主 / −3 a 已亡 / −7 后下的"不许灭"护着它) */
  const destroy = (v: DestroyIv, i: number, a: number, t: number) => {
    const sid = capitalAt(pm.polities[a], t);
    const r = S[sid]?.region ?? -1;
    if (!alive(a) || iv.protectedAfter(a, t, i)) {
      sim.record('intervene', { a, b: alive(a) ? IV_PROTECTED : -3, region: r, settlement: sid, war: i });
      return;
    }
    const to = v.b !== undefined ? iv.resolve(v.b) : -1;
    const by = to >= 0 && to !== a && alive(to) ? to : -1;
    const lands = pm.lands[a].slice();
    sim.record('intervene', { a, b: by, region: r, settlement: sid, war: i, n: lands.length });
    for (const q of lands) sim.setOwner(Layer.Polity, q, by, Ev.Cede);
    endPolity(pm, a, t);
    fallen(a, r, t, by);
    if (by < 0) reopen(sim, pm, lands);
  };

  /**
   * 让人物去世 / 改君主倾向(b 列:−1 生效了 / −3 a 已亡 / −4 此刻在位的不是他 / −5 将领、名臣,推演里不管)。
   * 君主按"此刻在位、不是作者立的、生年对得上人物键"认;去世的已经被让他去世过的不算,改倾向的已经下台(同一刻被让他去世、让位)的不算
   */
  const person = (v: PersonIv, i: number, a: number, t: number) => {
    const sid = capitalAt(pm.polities[a], t);
    const at = { a, region: S[sid]?.region ?? -1, settlement: sid, war: i };
    const who = parsePersonKey(v.person);
    if (!who || who.role !== 'ruler') {
      sim.record('intervene', { ...at, b: IV_PEOPLE });
      return;
    }
    if (!alive(a)) {
      sim.record('intervene', { ...at, b: -3 });
      return;
    }
    const r = rulerOf(pm, a, t);
    const him = !r.crown && Math.round(reignBorn(r)) === who.born && (v.kind === 'death' ? !r.death : r.cut === undefined);
    sim.record('intervene', { ...at, b: him ? -1 : IV_NOT_HIM });
    if (!him) return;
    rulerAct(sim, pm, a, v.kind === 'death' ? { kind: 'death', t, iv: i } : { kind: 'temper', t, iv: i, leanings: v.leanings });
  };

  /**
   * 任将任臣:只记一笔史事,历史不变(人物、编年史照它排,见 appoint.ts)。b 列:−1 生效了 / −3 a 已亡 / −2 他还没出生 /
   * IV_GONE 已去世 / IV_NOT_HIM 不满 APPOINT_AGE 岁 / IV_REIGNING 他此刻正是某国在位的君主(作者立的)
   */
  const appoint = (v: AppointIv, i: number, a: number, t: number) => {
    const sid = capitalAt(pm.polities[a], t);
    const reigning = () => {
      for (const [pid, acts] of pm.acts) {
        if (!alive(pid) || !acts.some((c) => c.kind === 'crown' && c.char === v.char)) continue;
        if (rulerOf(pm, pid, t).crown?.char === v.char) return true;
      }
      return false;
    };
    const b = !alive(a) ? -3 : v.born > t ? -2 : v.died !== undefined && v.died <= t ? IV_GONE : t - v.born < APPOINT_AGE ? IV_NOT_HIM : reigning() ? IV_REIGNING : -1;
    sim.record('intervene', { a, b, region: S[sid]?.region ?? -1, settlement: sid, war: i });
  };

  /** 方针:a 此刻定方针(b 列:−1 生效了 / −3 a 已亡) */
  const policy = (v: PolicyIv, i: number, a: number, t: number) => {
    const sid = capitalAt(pm.polities[a], t);
    const ok = alive(a);
    sim.record('intervene', { a, b: ok ? -1 : -3, region: S[sid]?.region ?? -1, settlement: sid, war: i });
    if (ok) setPolicy(sim, pm, a, v, i, t);
  };

  /** 第 i 条干预此刻生效 */
  const intervene = (i: number, t: number) => {
    const v = iv.list[i];
    if (!v) return;
    if (v.kind === 'found') {
      found(v, i, t);
      return;
    }
    if (v.kind === 'disaster') {
      strikeDisaster(sim, iv, v, i, t);
      return;
    }
    if (v.kind === 'trek') {
      // 大迁徙:这一刻分出一支上路(migration.ts;史事 intervene 也在那里记)
      trekModelOf(sim)?.order?.(v, i, t, iv);
      return;
    }
    if (v.kind === 'stay') {
      // 不许迁:看大迁徙时查(InterventionModel.stays),这里只记一笔
      const cultures = assimModelOf(sim)?.cultures ?? pm.cultures;
      const c = iv.resolveCulture(v.folk, cultures);
      if (c >= 0) sim.record('intervene', { a: -1, b: cultures[c].ended !== undefined ? -3 : -1, war: i, n: c });
      return;
    }
    if (v.kind === 'story') {
      // DM 故事事件(v2 故事通道):a 可有可无，效果只落在城镇/发展上(storyEngine.ts)
      const story: StoryIv = v;
      strikeStory(sim, iv, story, i, t);
      return;
    }
    const a = iv.resolve(v.a);
    if (a < 0) return; // 键指不到:这条干预在新历史里没有对象
    if (v.kind === 'cede') {
      cede(v, i, a, t);
      return;
    }
    if (v.kind === 'move') {
      move(v, i, a, t);
      return;
    }
    if (v.kind === 'crown') {
      crown(v, i, a, t);
      return;
    }
    if (v.kind === 'policy') {
      policy(v, i, a, t);
      return;
    }
    if (v.kind === 'appoint') {
      appoint(v, i, a, t);
      return;
    }
    if (v.kind === 'destroy') {
      destroy(v, i, a, t);
      return;
    }
    if (v.kind === 'death' || v.kind === 'temper') {
      person(v, i, a, t);
      return;
    }
    if (v.kind === 'boost') {
      // 推一把发展:快几倍登记(发展度每一步照着乘)/ 直接进下一个时代(boost.ts;史事 intervene 也在那里记)
      strikeBoost(sim, iv, v, i, a, t);
      return;
    }
    if (v.kind === 'petty') {
      // 小事件裁决层(v2):sack 记城市折损 / dev 委托 boost(pettyEngine.ts)
      strikePetty(sim, iv, v, i, a, t);
      return;
    }
    if (v.kind === 'intel') {
      // 渗透他国:只记一笔史事(谁派人摸谁的底),不改归属、不改数值;
      // 拿到哪几样在命令的 result/focus 里(edits.ts),由编排层(Jev 判定 + 确定性抽签)写上,回放逐位一致
      const b = iv.resolve(v.b);
      const sid = capitalAt(pm.polities[a], t);
      sim.record('intervene', { a, b, region: S[sid]?.region ?? -1, settlement: sid, war: i });
      return;
    }
    if (v.kind === 'treaty' || v.kind === 'neutral') {
      // 立约、划中立地:照立约的规矩办(treaties.ts 的 decree;史事 intervene 也在那里记)
      treatyModelOf(sim)?.decree?.(v, i, a, t, iv);
      return;
    }
    if (v.kind === 'regent' || v.kind === 'marry') {
      // 让他掌权、为他联姻:掌实权、联姻的模型先查能不能,记史事 intervene(b 列:掌权 −1 生效了、联姻 = 对方国家;没生效的见那边的 IV_*),再掌权 / 结亲
      const sid = capitalAt(pm.polities[a], t);
      const at = { a, region: S[sid]?.region ?? -1, settlement: sid, war: i };
      const noteIv = (b: number) => sim.record('intervene', { ...at, b });
      if (v.kind === 'regent') {
        const rm = regencyModelOf(sim);
        if (rm?.intervene) rm.intervene(v, i, a, t, noteIv);
        else noteIv(-3);
      } else {
        const mm = marriageModelOf(sim);
        const q = iv.resolve(v.b);
        if (mm?.intervene) mm.intervene(v, i, a, q, t, (b) => noteIv(b === -1 ? q : b));
        else noteIv(-3);
      }
      return;
    }
    const b = v.kind === 'ally' || v.kind === 'declare' ? iv.resolve(v.b) : -1;
    const A = pm.polities[a];
    const sid = capitalAt(A, t);
    sim.record('intervene', { a, b, region: S[sid]?.region ?? -1, settlement: sid, war: i });
    if (v.kind === 'halt') {
      // 不许扩张:它挑起的战争当即议和
      if (alive(a)) for (const w of wm.active.filter((x) => x.a === a)) api.war.makePeace!(w, t);
      return;
    }
    if (b < 0) return;
    const fighting = wm.active.filter((w) => (w.a === a && w.b === b) || (w.a === b && w.b === a));
    if (v.kind === 'ally') {
      // 结盟:正在交战的当即议和
      for (const w of fighting) api.war.makePeace!(w, t);
    } else if (v.kind === 'declare') {
      // 宣战:两国都在、没在交战、接壤,才打得成
      if (!alive(a) || !alive(b) || fighting.length || !polityBorders(pm, owner, a, b, t)) return;
      api.war.declare!(a, b, t);
    }
  };

  sim.on(Ev.Intervene, (i, _b, t) => intervene(i, t));
  sim.on(Ev.Command, (_a, _b, t) => {
    for (const i of iv.commandsAt(t)) intervene(i, t);
  });

  // 不许扩张到期:从现有国土重新预约扩张(禁令期间的"国家到达"都丢掉了)
  // 多看一眼:那一刻替那国(键此刻指得到、还在,照的还是这条方针)看一眼邻国 / 内政 / 王朝;随机数按 LOOK_K 往上的"第几次"取
  sim.on(Ev.Look, (i, j, t) => {
    const v = iv.list[i];
    if (v?.kind !== 'policy' || !v.look) return;
    const p = iv.resolve(v.a);
    if (p < 0 || !alive(p) || segAt(pm.policies.get(p), t)?.iv !== i) return;
    const k = LOOK_K + i * GUIDE_LOOK_MAX + j;
    if (v.look.kind === 'war') api.war.look?.(p, k, t);
    else if (v.look.kind === 'politics') api.politics.look?.(p, k, t);
    else dynastyModelOf(sim)?.look?.(p, k, t);
  });

  sim.on(Ev.HaltEnd, (i) => {
    const v = iv.list[i];
    if (!v || v.kind !== 'halt') return;
    const a = iv.resolve(v.a);
    if (a >= 0 && alive(a)) respread(sim, pm, a);
  });

  // 推一把发展的快几倍:已经生效的按史事推出来,发展度每一步照着乘(没有快几倍的不挂)
  installBoosts(sim, iv);
  // 作者的良将 / 名将挂帅的仗:本方兵力加成(没有带能力的任将不挂 —— 寻常的、没任过作者将领的世界一点不变)
  if (iv.stored.some((v) => v.kind === 'appoint' && v.skill)) api.war.led = authorLed(sim, pm, iv);
}

/**
 * 作者的良将 / 名将挂帅的仗(接口 war.led):打仗那一刻,按 appoint.ts 的 authorLeadsNow 问此刻谁领着哪场 ——
 * 史事记到此刻为止,和事后排人物是同一份规则。先粗筛:这一方有生效了的带能力任将、此刻还没过他最晚可能卸任的那一刻
 * (到期卸任;让他掌权、掌权比任期长的,到掌权最晚了结),才算一遍;同一刻、史事条数没变的几次问只算一遍。
 * 生效了哪几条按史事 intervene 扫出来(接着推时从头扫一遍),不存别的状态
 */
function authorLed(sim: CivSim, pm: PolityModel, iv: InterventionModel): (w: War, x: number, t: number) => number {
  const stored = iv.stored;
  const skilled = new Set<number>();
  stored.forEach((v, i) => {
    if (v.kind === 'appoint' && v.skill) skilled.add(i);
  });
  /** 让作者的人物掌权的几条:作者人物 → 掌权最晚了结的那一刻 */
  const regentEnd = new Map<number, number>();
  iv.list.forEach((v) => {
    if (v.kind === 'regent' && v.char !== undefined) regentEnd.set(v.char, Math.max(regentEnd.get(v.char) ?? -Infinity, authorRegentEnd(pm.knobs, v, v.from).stop));
  });
  /** 生效了的带能力任将:哪国、上任那一刻、最晚可能卸任的那一刻 */
  const took: { pid: number; from: number; end: number }[] = [];
  let seen = 0;
  let memo: { n: number; t: number; leads: AuthorLead[] } | null = null;
  /** 此刻让作者的人物掌权的那几段(AppointInput.holds;只问此刻在不在任:还掌着的不给了结,已了结的给此刻就够) */
  const holdsAt = (t: number): AppointInput['holds'] => {
    if (!regentEnd.size) return undefined;
    const out: NonNullable<AppointInput['holds']>[number][] = [];
    for (const [pid, list] of pm.regents) {
      for (const g of list) {
        const v = g.iv !== undefined ? stored[g.iv] : undefined;
        if (v?.kind !== 'regent' || v.char === undefined || !(g.start < t)) continue;
        const on = regentAt(pm.polities[pid], list, t, rulerOf(pm, pid, t), bookOf(pm, pid, t)) === g;
        out.push(on ? { char: v.char, polity: pid, start: g.start } : { char: v.char, polity: pid, start: g.start, stop: t });
      }
    }
    return out;
  };
  return (w, x, t) => {
    const A = sim.annalsView;
    for (; seen < A.length; seen++) {
      const e = A[seen];
      if (e.kind !== 'intervene' || e.b !== -1 || !skilled.has(e.war)) continue;
      const v = stored[e.war] as AppointIv;
      took.push({ pid: e.a, from: e.year, end: Math.max(appointEnd(v, e.year).stop, regentEnd.get(v.char) ?? -Infinity) });
    }
    if (!took.some((p) => p.pid === x && p.from <= t && t < p.end)) return 1;
    if (!memo || memo.n !== A.length || memo.t !== t) {
      memo = { n: A.length, t, leads: authorLeadsNow({ annals: A, polities: pm.polities, endYear: t, interventions: stored, holds: holdsAt(t) }, t) };
    }
    return skillPower(stored, memo.leads, x, w.id, w.a === x ? 0 : 1);
  };
}

/** 接着推(resumeCiv 调用,在各层 resume 之后):和 installInterventions 一样 */
export function resumeInterventions(sim: CivSim, iv: InterventionModel): void {
  installInterventions(sim, iv);
}

/** 模块:干预:不许灭、结盟、宣战、禁止分裂……(各规则在决策点查干预模型)(清单和次序见 modules.ts) */
export const interventionsModule: CivModule = {
  id: 'interventions',
  install: (c) => {
    if (c.iv) installInterventions(c.sim, c.iv);
  },
  resume: (c) => {
    if (c.iv) resumeInterventions(c.sim, c.iv);
  },
};
