/**
 * 干预(阶段 4)的数据与界面零件:"在地图上选目标"的状态、干预的说法、州的干预区。
 *
 * - 国家的命令(保护、禁止分裂、禁止扩张、结盟、宣战、迁都)在国家面板的干预页(CommandPage.tsx),这里只给它用的小工具
 *   (某年的邻国、城还在不在、默认生效年份……)。
 * - 在地图上选目标(PolityPick):干预页 / 州的"划给…"发起;地图压暗、可选的对象浮出名牌(TargetPlates.tsx),
 *   单击地图或名牌 = accept(编号);悬停卡片写"点击选择 / 不可选 / 本国"(hoverInfo.ts)。
 * - 州的干预(州面板 RegionPanel.tsx 的"在这里立国""划给…")用这里的 regionOrders / MineList 列出这一州的干预(可撤销)。
 * - 所有干预的列表在概览的"我的干预"页(WorldOverviewInterventions.tsx,用这里的 interventionText;年份写成"第 N 年",显示时按纪年换写法:gen/era.ts 的 eraText);
 *   推完一条干预顶部的提示用 interventionDoneText(写用户点的那个国名,那一年名字不一样再补一行)。
 * - 下了 / 删了干预,editsStore 里的干预列表一变,App 就在后台从第 0 年重推文明(见 App.tsx)。
 *
 * 国家、州、城一律按稳定键记(gen/edits.ts);显示的名字按当前这份历史解析。
 */
import { useSyncExternalStore } from 'react';
import type { ToastAction } from './toastStore';
import type { Civ, Polity } from '../gen/civ/types';
import { canCross } from '../gen/civ/polities';
import { polityAlive, polityName, ownersAt, rulerAt } from '../gen/readers/openQuery';
import { cultureLabel, regionLabel } from '../gen/civ/story/display';
import { type Owners } from '../gen/civ/engine/timeline';
import {
  AUTHOR_REGENT_AGE_END,
  DISASTER_LEVEL_NAMES,
  DISASTER_NAMES,
  TREK_DIR_NAMES,
  cleanIntervention,
  keyCells,
  parsePersonKey,
  polityKey,
  regionKey,
  regionOfKey,
  resolveKey,
  resolvePersonKey,
  type Intervention,
  type RegentEnd,
  type RegentHow,
} from '../gen/edits';
import { SLUMP_DEFAULT, quakeWord } from '../gen/civ/calamity';
import { cnNumber } from '../gen/civ/story/chronicle';
import { foesAt } from '../gen/civ/fiscalBook';
import { leaningsChange, personName } from '../gen/civ/story/peopleText';
import { heOrShe, heirWord, mateWord, wedVerb, type Sexed } from '../gen/civ/story/gender';
import { getEdits, removeIntervention, useEra } from './editsStore';
import { crownLine } from './crownInfo';
import { postLine } from './authorIvInfo';
import { POLICY_PRESET_NAMES, emptyPolicy, policyName, type PolicyIv } from '../gen/civ/policy';
import { policyKnobsText } from './policyInfo';
import { boostText } from './boostInfo';
import { KEEP_CROWN } from './keepInfo';
import { TREK_REACH_NAMES } from './trekInfo';
import { eraText, spaced, yearAt, yearShort } from '../gen/era';

// ---------------------------------------------------------------------------
// 在地图上选目标

export interface PolityPick {
  /** 顶部提示条上的话:"选择与大昌结盟的国家" */
  prompt: string;
  /** 提示条上的小字:"2649 年起生效" */
  sub?: string;
  /** 从哪里发起(`polity:3` / `region:12`;面板换了对象时据此收起) */
  source: string;
  /** 要点的是国家(默认)、城还是州(州:地图上不浮名牌,点到哪州算哪州) */
  target?: 'polity' | 'settlement' | 'region';
  /** 点到了国家 / 城 id:合格 = 下令、返回 null;不合格 = 返回原因(如"两国不接壤,无法宣战") */
  accept: (id: number) => string | null;
  /** 上一次点的不合格的原因 */
  msg?: string;
  /** 本国(名牌、悬停写"本国") */
  self?: number;
  /** 本国名牌上的小字(默认"本国";让作者的人物即位时写"他的国家") */
  selfNote?: string;
  /** 本国也能点(让作者的人物即位:他自己的国家也能选) */
  selfPick?: boolean;
  /** 可选的对象(国家 / 城的编号):地图上浮出它们的名牌,悬停写"点击选择" */
  eligible?: ReadonlySet<number>;
  /** 相邻的国家(名牌上写"相邻") */
  near?: ReadonlySet<number>;
  /** 按哪一年的国土摆名牌 */
  year?: number;
  /**
   * 一次点好几个(方针的亲、仇):点了合格的不收起,接着点(accept 自己换上新的一份 pick:提示、已选的);
   * 收起要点「取消」/ Esc
   */
  keep?: boolean;
  /** 已经选上的(名牌反色) */
  on?: ReadonlySet<number>;
  /** 名牌后面多一个小字("仇 ✓""亲") */
  marks?: ReadonlyMap<number, string>;
  /** 提示条上「取消」前面另加的按钮(大纲圈州:「存成作者标记」「好了」) */
  actions?: ToastAction[];
}

let pick: PolityPick | null = null;
const pickSubs = new Set<() => void>();

export function getPolityPick(): PolityPick | null {
  return pick;
}

export function setPolityPick(p: PolityPick | null) {
  if (p === pick) return;
  pick = p;
  if (!p) setPickHover(-1);
  for (const f of pickSubs) f();
}

export function usePolityPick(): PolityPick | null {
  return useSyncExternalStore(
    (f) => {
      pickSubs.add(f);
      return () => pickSubs.delete(f);
    },
    getPolityPick,
    getPolityPick,
  );
}

/**
 * 点了一个对象以后(名牌、地图上):不合格 = 提示条换成原因;合格 = 收起(keep 的不收起,accept 已经换上了新的一份)。
 * pk = 点的时候的那一份,err = accept 的结果
 */
export function finishPick(pk: PolityPick, err: string | null) {
  if (err) setPolityPick({ ...(getPolityPick() ?? pk), msg: err });
  else if (!pk.keep) setPolityPick(null);
}

/** 选目标时鼠标下的对象对不对:'ok' 可选 / 'self' 本国 / 'no' 不可选 */
export function pickVerdict(p: PolityPick, id: number): 'ok' | 'self' | 'no' {
  if (id >= 0 && p.self === id && (p.target ?? 'polity') === 'polity') return p.selfPick ? 'ok' : 'self';
  if (id >= 0 && p.eligible?.has(id)) return 'ok';
  return 'no';
}

/** 选目标时"悬停卡片"的小字 */
export const VERDICT_TEXT = { ok: '点击选择', self: '本国', no: '不可选' } as const;

// 选目标时鼠标停在哪个对象上(名牌反色);−1 = 没有
let hovered = -1;
const hoverSubs = new Set<() => void>();

export function setPickHover(id: number) {
  if (id === hovered) return;
  hovered = id;
  for (const f of hoverSubs) f();
}

export function usePickHover(): number {
  return useSyncExternalStore(
    (f) => {
      hoverSubs.add(f);
      return () => hoverSubs.delete(f);
    },
    () => hovered,
    () => hovered,
  );
}

// ---------------------------------------------------------------------------
// 小工具

/** 稳定键 → 这份历史里的国家编号(−1 = 没有) */
export function polityIdOf(civ: Civ, key: string): number {
  const r = resolveKey(civ, key);
  return r && r.kind === 'polity' ? r.id : -1;
}

/** 城的稳定键 → 这份历史里的城编号(−1 = 没有) */
function cityIdOf(civ: Civ, key: string): number {
  const r = resolveKey(civ, key);
  return r && r.kind === 'settlement' ? r.id : -1;
}

/** 某年的国名(那一年还没立国 / 已亡:立国时 / 亡国前的国号) */
export function nameAt(p: Polity, year: number): string {
  const y = year < p.founded ? p.founded : p.ended !== undefined && year >= p.ended ? p.ended - 1 / 512 : year;
  return polityName(p, y) || p.name || '某国';
}

const keyName = (civ: Civ, key: string, year: number): string => {
  const id = polityIdOf(civ, key);
  return id >= 0 ? nameAt(civ.polities[id], year) : '(新历史里没有的国家)';
};

const regionKeyName = (civ: Civ, key: string): string => {
  const r = regionOfKey(key, keyCells(civ.regions));
  return r >= 0 && r < civ.regions.count ? regionLabel(civ, r) : '(没有的州)';
};

/** 民族的稳定键 → "克拉尔族"(这份历史里没有 = 写明) */
export const cultureKeyName = (civ: Civ, key: string): string => {
  const r = resolveKey(civ, key);
  const c = r && r.kind === 'culture' ? civ.cultures[r.id] : undefined;
  return c ? cultureLabel(c) : '(新历史里没有的民族)';
};

const cityKeyName = (civ: Civ, key: string): string => {
  const id = cityIdOf(civ, key);
  return id >= 0 ? civ.settlements[id].name || '某城' : '(新历史里没有的城)';
};

/** 人物键 → 这份历史里的人物(没有 = undefined) */
const personOfKey = (civ: Civ, key: string) => {
  const id = resolvePersonKey(civ, key);
  return id >= 0 ? civ.people?.[id] : undefined;
};

/** 人物键 → 名字(这份历史里没有这个人 = 键里记的名字) */
const personKeyName = (civ: Civ, key: string): string => {
  const x = personOfKey(civ, key);
  return x ? personName(civ, x) : parsePersonKey(key)?.name || '(新历史里没有的人物)';
};

/** 第 i 条干预在这份历史里的史事 intervene(没有 = undefined) */
const ivAnnal = (civ: Civ, i: number) => (i >= 0 ? civ.annals.find((x) => x.kind === 'intervene' && x.war === i) : undefined);

/**
 * 天灾的说法:"星邑:瘟疫（重）""克尔顿:全球大疫（中），疫后无人收拾 30 年""有桑皇朝:饥荒（轻）""翼门之野等 4 州:饥荒（轻）"
 * "翼门之野一带:地震（中），8 州受灾"(地震写大水 / 大旱看那一处的地形)
 */
function disasterText(civ: Civ, v: Extract<Intervention, { kind: 'disaster' }>, i: number, a?: string): string {
  const lv = `（${DISASTER_LEVEL_NAMES[v.level]}）`;
  if (v.type === 'plague') return `${cityKeyName(civ, v.city ?? '')}:${DISASTER_NAMES.plague}${lv}`;
  if (v.type === 'pandemic') return `${cityKeyName(civ, v.city ?? '')}:${DISASTER_NAMES.pandemic}${lv}，疫后无人收拾 ${v.slump ?? SLUMP_DEFAULT} 年`;
  if (v.type === 'famine') {
    if (v.a) return `${a ?? keyName(civ, v.a, v.from)}:${DISASTER_NAMES.famine}${lv}`;
    const rs = v.regions ?? [];
    return `${rs.length ? regionKeyName(civ, rs[0]) : '(没有的州)'}${rs.length > 1 ? `等 ${rs.length} 州` : ''}:${DISASTER_NAMES.famine}${lv}`;
  }
  const r = regionOfKey(v.region ?? '', keyCells(civ.regions));
  const e = ivAnnal(civ, i);
  const word = r >= 0 && r < civ.regions.count ? quakeWord(civ.regions, r) : '地震';
  return `${regionKeyName(civ, v.region ?? '')}一带:${word}${lv}${e && e.b > 0 ? `，${e.b} 州受灾` : ''}`;
}

/**
 * 大迁徙、不许迁的说法:"克拉尔族:大迁徙，从诺敏塔拉往瑶渊之野""克拉尔族:大迁徙，去处推演挑（远）""克拉尔族:大迁徙，往南，去处推演挑"
 * "克拉尔族:不许迁(至第 2100 年)"
 */
function trekText(civ: Civ, v: Extract<Intervention, { kind: 'trek' | 'stay' }>): string {
  const F = cultureKeyName(civ, v.folk);
  if (v.kind === 'stay') return `${F}:不许迁${v.until !== undefined ? `(至第 ${v.until} 年)` : ''}`;
  const from = v.region ? `从${regionKeyName(civ, v.region)}` : '';
  if (v.to) return `${F}:大迁徙，${from}往${regionKeyName(civ, v.to)}`;
  // 照大纲下的往某个方位的令:远近照推演依次放宽,不写哪一档
  if (v.dir) return `${F}:大迁徙，${from ? `${from}出发，` : ''}往${TREK_DIR_NAMES[v.dir]}，去处推演挑`;
  return `${F}:大迁徙，${from ? `${from}出发，` : ''}去处推演挑（${TREK_REACH_NAMES[v.reach ?? 'mid']}）`;
}

/** 第 i 条干预(Civ.interventions 的下标)是"立国"、在这份历史里立成了:立出来的国家(没有 = −1) */
function foundedBy(civ: Civ, i: number): number {
  if (i < 0 || civ.interventions?.[i]?.kind !== 'found') return -1;
  const e = civ.annals.find((x) => x.kind === 'intervene' && x.war === i);
  return e && e.a >= 0 ? e.a : -1;
}

/**
 * editsStore 里的干预列表(可能夹着认不出的)→ 每一条在这份历史的 Civ.interventions 里是第几条(−1 = 认不出 / 对不上:
 * 这份历史还不是按现在的列表推出来的,比如正在重推)
 */
export function civIndexes(civ: Civ, list: readonly unknown[]): number[] {
  const done = civ.interventions ?? [];
  let c = 0;
  return list.map((x) => {
    const v = cleanIntervention(x);
    if (!v) return -1;
    if (c < done.length && JSON.stringify(done[c]) === JSON.stringify(v)) return c++;
    return -1;
  });
}

/**
 * 一条干预的说法:"大昌:保护""大昌:保护(至第 2300 年)""大昌与索拉特结盟(至第 2000 年)""大昌向索拉特宣战""大昌:禁止分裂"
 * "瑞州划给大昌(永久)""在瑞州立国(号饕餮)""大昌迁都瑞城""大昌:禁止扩张(至第 1800 年)"。
 * i = 它在这份历史的 Civ.interventions 里是第几条(给了、立国立成了,就写出立出来的国名);
 * a = 下令的国家怎么称呼(不给 = 生效那年的名字)。记在作者人物名下的(干预带 author)后面加"（林小满之议）"
 */
export function interventionText(civ: Civ, v: Intervention, i = -1, a?: string): string {
  const t = ivText(civ, v, i, a);
  // 记在作者人物名下的国家的事:"大昌与索拉特结盟（林小满之议）"
  return v.author !== undefined ? `${t}（${authorName(civ, v.author)}之议）` : t;
}

function ivText(civ: Civ, v: Intervention, i: number, a: string | undefined): string {
  if (v.kind === 'found') {
    const made = i >= 0 ? foundedBy(civ, i) : -1;
    const shown = made >= 0 ? `,即${nameAt(civ.polities[made], v.from)}` : v.name ? `(号${v.name})` : '';
    return `在${regionKeyName(civ, v.region)}立国${shown}`;
  }
  if (v.kind === 'disaster') return disasterText(civ, v, i, a);
  if (v.kind === 'trek' || v.kind === 'stay') return trekText(civ, v);
  const A = a ?? keyName(civ, v.a, v.from);
  if (v.kind === 'boost') return boostText(civ, v, i, A, getEdits().era);
  switch (v.kind) {
    case 'protect':
      return `${A}:保护${v.until !== undefined ? `(至第 ${v.until} 年)` : ''}`;
    case 'unity':
      return `${A}:禁止分裂`;
    case 'ally':
      return `${A}与${keyName(civ, v.b, v.from)}结盟${v.until !== undefined ? `(至第 ${v.until} 年)` : ''}`;
    case 'declare':
      // 宣战时点了谁挂帅(作者的将领):"大定向奥利亚宣战，林小满挂帅"
      return `${A}向${keyName(civ, v.b, v.from)}宣战${v.lead !== undefined ? `，${authorName(civ, v.lead)}挂帅` : ''}`;
    case 'cede':
      return `${regionKeyName(civ, v.region)}划给${A}${v.permanent ? '(永久)' : ''}`;
    case 'move':
      return `${A}迁都${cityKeyName(civ, v.city)}`;
    case 'halt':
      return `${A}:禁止扩张${v.until !== undefined ? `(至第 ${v.until} 年)` : ''}`;
    case 'press':
      return `${A}:坚持打${v.b !== undefined ? `，只管与${keyName(civ, v.b, v.from)}的仗` : ''}${v.until !== undefined ? `(至第 ${v.until} 年)` : ''}`;
    case 'petty':
      return `${A}:小事件(${v.effect.type === 'dev' ? `发展 ${v.effect.years} 年` : `折损 ${v.effect.loss} 级`})`;
    case 'keep':
      // "大澜王朝保住王室，一直有效" / "……，到 1560 年"
      return `${A}保住王室，${v.until !== undefined ? `到${spaced(yearAt(v.until, getEdits().era))}` : '一直有效'}`;
    case 'crown': {
      // 在位期间保住王室的,后面接一句
      const keep = v.keep ? `；${KEEP_CROWN}` : '';
      if (v.after) {
        // "顾长安即有桑皇朝君位,等高宗鸿喾下台"
        const pid = polityIdOf(civ, v.a);
        const cur = pid >= 0 ? rulerAt(civ, pid, v.from) : null;
        return `${authorName(civ, v.char)}即${A}君位，等${cur ? personName(civ, cur) : '在位的君主'}下台${keep}`;
      }
      // "林小满即有桑皇朝君位，1530 年退位" / "……，到 1541 年卒"(下台年份就是人物卡上的卒年)
      return crownLine(authorName(civ, v.char), A, v, getEdits().characters?.find((c) => c.id === v.char)?.died, getEdits().era) + keep;
    }
    case 'policy': {
      // "大澜王朝:方针「扩张」";细调过 / 自定的带上拧过的几项("「我的干预」里看得到旋钮的数")
      if (emptyPolicy(v)) return `${A}:不再定方针(照君主性格)`;
      const name = policyName(v);
      return `${A}:方针「${name || '只定亲仇'}」${name && tweakedOrCustom(v) ? `（${policyKnobsText(v)}）` : ''}`;
    }
    case 'destroy': {
      if (!v.b) return `${A}:灭国，散成无主`;
      const n = ivAnnal(civ, i)?.n;
      return `${A}:灭国，${n ? `${n} 州` : ''}并入${keyName(civ, v.b, v.from)}`;
    }
    case 'death':
      return `${personKeyName(civ, v.person)}:去世${parsePersonKey(v.person)?.role === 'ruler' ? '' : '（只改人物和编年史）'}`;
    case 'temper': {
      const x = personOfKey(civ, v.person);
      const change = leaningsChange(x?.leanings, v.leanings);
      return `${personKeyName(civ, v.person)}:改倾向${change ? `，${change}` : ''}，到${heOrShe(x)}下台`;
    }
    case 'treaty': {
      // "渭国与大羽王朝、后乾衍国立约(有限竞争，三十年)，以星河域为中立地"
      const ps = v.ps.map((k) => keyName(civ, k, v.from)).join('、');
      const term = v.term ? `${cnNumber(v.term)}年` : '一直';
      return `${A}与${ps}立约（${v.limited ? '有限竞争，' : ''}${term}）${v.zone ? `，以${regionKeyName(civ, v.zone)}为中立地` : ''}`;
    }
    case 'neutral': {
      // "渭国与大羽王朝、后乾衍国以星河域为中立地(至第 2350 年)"
      const ps = v.ps.map((k) => keyName(civ, k, v.from)).join('、');
      const until = v.lasting ? '（一直）' : v.until !== undefined ? `（至第 ${v.until} 年）` : '';
      return `${A}与${ps}以${regionKeyName(civ, v.region)}为中立地${until}`;
    }
    case 'regent':
      // "彭继桓:引兵入朝掌权，到君主去世即位""孙嵩曜:专权，5 年后还政";作者的人物 "苏晚以大臣专权掌大定国政，5 年后还政"(authorIvInfo.ts)
      if (v.char !== undefined) return postLine(authorName(civ, v.char), A, v, getEdits().era);
      return `${personKeyName(civ, v.person)}:${regentHowWord(v.how, personOfKey(civ, v.person))}掌权，${regentEndWord(v.end, v.years)}`;
    case 'appoint':
      // "林小满为大定将，到 1530 年卸任""林小满入大定为臣，到卒年（1561 年）"(authorIvInfo.ts)
      return postLine(authorName(civ, v.char), A, v, getEdits().era);
    case 'marry': {
      // "胡炜:娶大澜王朝宗室女""胡炜:本国宗室女嫁大澜王朝""胡炜:与大澜王朝互嫁"
      const B = keyName(civ, v.b, v.from) || '对方';
      const x = personOfKey(civ, v.person);
      return `${personKeyName(civ, v.person)}:${v.how === 'give' ? `本国宗室女嫁${B}` : v.how === 'mutual' ? `与${B}互嫁` : `${wedVerb(x)}${B}${mateWord(x)}`}`;
    }
  }
}

/** 让他掌权的几种怎么叫(太子监国:掌权的是女的写太女监国) */
export function regentHowWord(how: RegentHow, x?: Sexed): string {
  return how === 'heir' ? `${heirWord(x)}监国` : REGENT_HOW_WORD[how];
}
const REGENT_HOW_WORD: Record<RegentHow, string> = { march: '引兵入朝', heir: '太子监国', uncle: '摄政', chancellor: '专权', general: '专权' };

/** 让他掌权到什么时候:"到君主去世即位""5 年后还政""5 年后篡位" */
export function regentEndWord(end: RegentEnd, years?: number): string {
  return end === 'succeed' ? '到君主去世即位' : `${years ?? 1} 年后${end === 'return' ? '还政' : '篡位'}`;
}

/** 让作者的人物掌权到什么时候:"5 年后还政" / 没填还政年 = "到卒年"(人物卡没写卒年 = "到 70 岁还政") */
export function authorRegentEndWord(v: { years?: number; died?: number }): string {
  return v.years !== undefined ? regentEndWord('return', v.years) : v.died !== undefined ? '到卒年' : `到 ${AUTHOR_REGENT_AGE_END} 岁还政`;
}

/** 方针拧过旋钮(一键选的细调过,或者没从一键选起) */
const tweakedOrCustom = (v: PolicyIv) => policyName(v) !== (v.preset ? POLICY_PRESET_NAMES[v.preset] : '');

/** 作者的人物在这份历史里叫什么(套过 applyCharacters 的历史里有名字,没即位成的也有;还没下过令的照人物卡;都没有 = "作者的人物") */
function authorName(civ: Civ, char: number): string {
  return civ.authorNames?.[char] || civ.people?.find((x) => x.author === char && x.name)?.name || getEdits().characters?.find((c) => c.id === char)?.name || '作者的人物';
}

/**
 * 推完一条干预后顶部提示的说法:"有鹰王朝禁止扩张""保护有鹰王朝(至第 2300 年)""有鹰王朝禁止分裂",
 * 别的同 interventionText("有鹰王朝与索拉特结盟""瑞州划给有鹰王朝""在瑞州立国,即饕餮")。
 * a = 下令的国家怎么称呼:国家面板下的令用面板标题上的名字(用户点的那个),不给 = 生效那年的名字
 */
export function interventionDoneText(civ: Civ, v: Intervention, i = -1, a?: string): string {
  if (v.kind === 'found' || v.kind === 'disaster' || v.kind === 'trek' || v.kind === 'stay') return interventionText(civ, v, i, a);
  const A = a ?? keyName(civ, v.a, v.from);
  switch (v.kind) {
    case 'protect':
      return `保护${A}${v.until !== undefined ? `(至第 ${v.until} 年)` : ''}`;
    case 'unity':
      return `${A}禁止分裂`;
    case 'halt':
      return `${A}禁止扩张${v.until !== undefined ? `(至第 ${v.until} 年)` : ''}`;
    case 'crown':
      // 在位期间保住王室的:"燕昭即大澜王朝君位，在位期间保住王室"(下台年份不再写)
      return v.keep && !v.after ? `${authorName(civ, v.char)}即${A}君位，${KEEP_CROWN}` : interventionText(civ, v, i, A);
    default:
      return interventionText(civ, v, i, A);
  }
}

/** 下令的国家在生效那一年叫什么(立国没有下令的国家 = null) */
export function interventionActorThen(civ: Civ, v: Intervention): string | null {
  return v.kind === 'found' || v.kind === 'trek' || v.kind === 'stay' || !v.a ? null : keyName(civ, v.a, v.from);
}

let owners: Owners | undefined;

/** y 年各国的州数、和 id 接壤的国家(id 能走过去的边) */
export function neighborsAt(civ: Civ, id: number, y: number): { size: Map<number, number>; near: Set<number> } {
  owners = ownersAt(civ, y, owners);
  const own = owners.polity;
  const reg = civ.regions;
  const size = new Map<number, number>();
  const near = new Set<number>();
  const P = civ.polities[id];
  for (let r = 0; r < reg.count; r++) {
    const o = own[r];
    if (o < 0) continue;
    size.set(o, (size.get(o) ?? 0) + 1);
    if (o !== id || !P) continue;
    for (let k = reg.adjStart[r]; k < reg.adjStart[r + 1]; k++) {
      const q = own[reg.adj[k]];
      if (q >= 0 && q !== id && canCross(civ, P, reg.adjKind[k], y)) near.add(q);
    }
  }
  return { size, near };
}

/**
 * y 年 id 宣战打得成的国家(宣战、派作者的人物出征挑对象用):接壤的 near 里那年没和它在交战的 ——
 * 推演里两国已在交战时宣战那条跳过,下了不生效,点的挂帅也就领不了这一仗。foes = 那年和它在交战的国家
 */
export function declareTargets(civ: Civ, id: number, y: number, near: ReadonlySet<number>): { open: Set<number>; foes: Set<number> } {
  const foes = new Set(foesAt(civ, id, y));
  return { open: new Set([...near].filter((q) => !foes.has(q))), foes };
}

/** 城 s 在 y 年还在(建了、没毁) */
export const cityStands = (civ: Civ, sid: number, y: number) => {
  const s = civ.settlements[sid];
  return !!s && s.founded <= y && (s.ended === undefined || s.ended > y);
};

/** 国家 p 在时间轴停在 year 时,生效年份的默认值:活着 = 这一年;还没立国 = 立国那年;已亡 = 亡国前 30 年 */
export function defaultYear(p: Polity, year: number): number {
  if (polityAlive(p, year)) return Math.floor(year);
  if (year < p.founded) return Math.ceil(p.founded);
  return Math.max(Math.ceil(p.founded), Math.floor(p.ended!) - 30);
}

/**
 * 牵涉国家 id 的干预(它下的令、以它为对象的结盟 / 宣战、立国立出来的就是它):
 * v = 清理过的干预,i = editsStore 里的下标,c = 这份历史里的下标
 */
export function polityOrders(civ: Civ, id: number, list: readonly unknown[]): { v: Intervention; i: number; c: number }[] {
  const key = polityKey(civ, id);
  const ci = civIndexes(civ, list);
  return list
    .map((x, i) => ({ v: cleanIntervention(x), i, c: ci[i] }))
    .filter(
      (e): e is { v: Intervention; i: number; c: number } =>
        !!e.v &&
        (e.v.kind === 'found'
          ? foundedBy(civ, e.c) === id
          : e.v.kind !== 'trek' && e.v.kind !== 'stay' && (e.v.a === key || ((e.v.kind === 'ally' || e.v.kind === 'declare') && e.v.b === key))),
    );
}

/** 这一州的干预(立国、划州):v = 清理过的干预,i = editsStore 里的下标,c = 这份历史里的下标 */
export function regionOrders(civ: Civ, region: number, list: readonly unknown[]): { v: Intervention; i: number; c: number }[] {
  const key = regionKey(civ, region);
  const ci = civIndexes(civ, list);
  return list
    .map((x, i) => ({ v: cleanIntervention(x), i, c: ci[i] }))
    .filter(
      (e): e is { v: Intervention; i: number; c: number } =>
        !!e.v && (((e.v.kind === 'found' || e.v.kind === 'cede') && e.v.region === key) || (e.v.kind === 'trek' && (e.v.region === key || e.v.to === key))),
    );
}

/** 已经下了的几条(可撤销;i = editsStore 里的下标,c = 这份历史里的下标) */
export function MineList({ civ, mine }: { civ: Civ; mine: { v: Intervention; i: number; c: number }[] }) {
  const era = useEra();
  if (!mine.length) return null;
  return (
    <div className="iv-mine">
      {mine.map(({ v, i, c }) => (
        <div key={i} className="iv-item">
          <span className="ins-years">{yearShort(v.from, era)}</span>
          <span className="iv-item-text">{eraText(interventionText(civ, v, c), era)}</span>
          <button className="iv-del" data-act="iv-del" onClick={() => removeIntervention(i)} title="撤销这条干预(之后的历史重新推演)">
            撤销
          </button>
        </div>
      ))}
    </div>
  );
}
