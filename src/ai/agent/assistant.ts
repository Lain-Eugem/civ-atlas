/**
 * 助手:作者用一句话问这个世界的事、或者说想怎么改它,AI 自己查资料、在后台试推演、看了结果再调,
 * 最后把要改的列成一张确认单(作者点了执行才生效)。这里是给 AI 的工具、提示词和一次完整的对话;
 * 循环本身在 ./loop.ts,结果对照在 ./trial.ts。纯逻辑,不碰 DOM(试推演由调用方给 simulate:界面里交给 worker)。
 *
 * 工具:
 * - country:一个国家的来龙去脉(国号、国都、国土消长、结局、相关大事)
 * - chronicle:编年史(按年份、国家筛)
 * - situation:某一年的格局(在世的国家、国土、邻国、正在打的仗)
 * - people:人物(作者的人物和推演里的君主、将领、名臣;按名字找、按国家 + 年份列,见 ./lookup.ts)
 * - land:一片地方的地块数据汇总(海拔、气温、降水、地形、人口、物产;见 ./lookup.ts)
 * - try_edits:按一批修改在后台重推一遍,和现在比(不动作者的世界;次数有限)
 * - propose_edits:把修改列给作者确认(和改写同一套核对;能试推演的顺带附上和现在比的结果)
 *
 * 修改的写法、核对、合进 WorldEdits 都和「用一句话改写世界」共用(../prompts/rewrite.ts):
 * 编号(P3、C12……)是现在这份历史里的,地形修改不能试推演(整个世界要重新生成)。
 */
import type { World } from '../../gen/world';
import type { Civ } from '../../gen/civ/types';
import { buildChronicle, entryInvolves, entryYearLabel, MAJOR, type ChronicleEntry } from '../../gen/civ/story/chronicle';
import { capitalAt, polityAlive, ownersAt } from '../../gen/readers/openQuery';
import { polityRoots, polityTitleChain } from '../../gen/civ/growth';
import { DISASTER_LEVEL_NAMES, DISASTER_NAMES, applyNames, cleanIntervention, resolveKey, type Intervention, type WorldEdits } from '../../gen/edits';
import {
  REWRITE_OPS,
  REWRITE_TIPS,
  bordersAt,
  cleanWish,
  endText,
  lastYear,
  mergeRewrite,
  nameAt,
  parseRewrite,
  plainIds,
  rewriteMaterial,
  type RewriteChange,
  type RewriteContext,
  type RewriteItem,
  type RewriteLock,
} from '../prompts/rewrite';
import type { AiMessage, AiRequest, AiToolCall, AiUsage } from '../types';
import { looksUnfinished, runAgent, type AgentEvent, type AgentStep, type AgentTool } from './loop';
import { landLabel, lookupLand, lookupPeople, peopleLabel, polityOf, yearArg } from './lookup';
import { regionLabel, regionNamed } from '../../gen/civ/story/display';
import { compareTrial, noteDeclares, sameFate, trialText, trialUnchanged, type Fate, type FateChange, type TrialDiff, type TrialEvent } from './trial';

/** 调用记录里的功能名 */
export const ASSISTANT_FEATURE = '助手';
/** 一次对话里最多试推演几次(propose_edits 顺带的那一次不算) */
export const TRIAL_MAX = 6;
/** 连着几次试推演都和现在一样,就提醒 AI:多半用命令做不到,别再换着法子试 */
export const TRIAL_SAME_MAX = 3;
/** 收尾的话像没说完时,在后面补的一句(给作者看) */
export const UNFINISHED_NOTE = '（助手没想完就停下了。可以说「继续」，或者换个问法再问一次。）';
/** 带上前面几轮 */
const HISTORY_TURNS = 6;

/** 话里说列了 / 要列确认单("现在为您列出确认单：""propose_edits 列出这一条");说了不列的("没有列确认单")不算 */
export function saysListed(text: string): boolean {
  if (!/propose_edits|确认单/.test(text)) return false;
  return /propose_edits|列/.test(text) && !/(不|没有?|无法|不能|不必|不用)(再|必要)?列/.test(text);
}

/** 说要列确认单却没调 propose_edits 时补的一句(下一轮只给 propose_edits) */
const LIST_NUDGE = {
  key: 'list',
  say:
    '你刚才说要列确认单,但没有调用 propose_edits,作者那边看不到确认单。要列就现在调用 propose_edits;' +
    '不打算列,就直接用一两句话回答,不要再提确认单。',
  tools: ['propose_edits'],
};

/** 话里说要挪了落点、重新列("挪到开阔的海面，重新列出确认单");只说"列了确认单"的不算(连着陆地的山脉本来就该连着) */
export function saysRelisted(text: string): boolean {
  return saysListed(text) && /重新|再次|再列|改列|挪/.test(text);
}

/** 列过的确认单要改了再列(落点贴着陆地),它说要重新列却没再调 propose_edits 时补的一句 */
const RELIST_NUDGE = {
  key: 'relist',
  say:
    '你说要重新列确认单,但没有再调用 propose_edits,作者看到的还是上一张(落点贴着陆地的那张)。要换就现在调用 propose_edits;' +
    '不换就直接用一两句话回答,不要说重新列了。',
  tools: ['propose_edits'],
};

export interface AssistantContext {
  world: World;
  /** 套上了改名的这份历史(界面上看到的名字) */
  civ: Civ;
  /** 时间轴的年份 */
  year: number;
  /** 现在的修改 */
  edits: WorldEdits;
  /** 锁住了哪一样(见 RewriteLock) */
  lock?: RewriteLock;
  /**
   * 按这份修改在后台把历史重推一遍(不动作者的世界),返回套上改名的历史。
   * 只会给出干预和改名变了的修改(地形不变);不给 = 不能试推演
   */
  simulate?: (edits: WorldEdits, signal?: AbortSignal) => Promise<Civ>;
}

/** 一次试推演 */
export interface AssistantTrial {
  /** 第几次(从 1 数;propose_edits 顺带的 = 0) */
  n: number;
  items: RewriteItem[];
  /** 试推演用的整份修改(现在的 + 这一批) */
  edits: WorldEdits;
  /** 试推演出来的历史(界面"先在地图上看看"用) */
  civ: Civ;
  diff: TrialDiff;
}

/** 列给作者的确认单 */
export interface AssistantProposal {
  items: RewriteItem[];
  cannot: string[];
  /** 这批修改试推演的结果(有地形修改、或者不能试推演时没有) */
  trial?: AssistantTrial;
}

/** 之前的一轮(给 AI 看前情) */
export interface AssistantTurn {
  ask: string;
  /** 助手当时回的话 */
  reply?: string;
  /** 当时列的修改(一句一条) */
  items?: string[];
  /** 作者执行了没有 */
  applied?: boolean;
}

export interface AssistantResult {
  text: string;
  steps: AgentStep[];
  proposal: AssistantProposal | null;
  trials: AssistantTrial[];
  end: 'done' | 'rounds';
  usage: AiUsage;
}

// ---------------------------------------------------------------------------
// 提示词

export const ASSISTANT_SYSTEM = [
  '你是「文明与地图」里的助手。这是一颗虚构的星球:地形由板块、侵蚀、气候生成,历史从第 0 年按规则推演到最后一年。',
  '作者会问这个世界的事,或者说想怎么改它。你可以用工具查资料(country、chronicle、situation、people、land)、在后台试推演(try_edits)、把修改列给作者确认(propose_edits);' +
    '有的地方还给了写史书、起名、在地图上打开这些工具,照工具说明用。',
  '',
  '## 怎么做',
  '1. 作者在提问:先用工具查清楚再答,不要凭印象编;答得具体(哪一年、谁、几州)。资料里查不到的就直说没有,不要推测"很可能""或许"。',
  '2. 作者要改世界:先查清楚来龙去脉,再用 try_edits 试一种改法,看结果是不是作者要的;不理想就换一种再试(最多试 4 次),挑最好的一种用 propose_edits 列给作者。',
  '   试推演不会动作者的世界;只有作者在确认单上点了执行才生效。',
  '3. 只做作者要的,不要额外加作者没提的事;能用历史命令做到的,不要动地形。地形修改不能试推演,直接列给作者,说明历史会整个重来。',
  '4. 命令只能定下条件(保护、结盟、宣战……),不能直接规定谁打赢、哪年发生什么,后果由推演展开。试了几次都做不到时照实说,列出最接近的一种。',
  '   说做不到的理由,只写查到的资料、试推演和核对里真出现过的结果;没试过的办法不要说试过,也不要说"所有办法都试过",可以说还有哪几种没试。' +
    '作者说了不要用的办法,不要再列进确认单。',
  '5. 说完一件事就停:列了确认单以后,用两三句话说结论,照试推演的数字说:作者关心的国家结果怎样;别的国家里变化最大的一两个(副作用,比如谁变小了、谁没亡、谁亡得更早);' +
    '确认单上不合格的条目执行不了,要说出来,不要说成可行;做不到的部分说一句。确认单要作者点了执行才生效:说"会""打算",不要说"已经改了""已放置"。不要再问作者要不要执行。',
  '   要列确认单就调用 propose_edits,不要只在话里写"列出确认单"。',
  '6. 回给作者的话说名字,不说编号(P3、C12、L0 这些只在工具里用),也不说 protect、found 这些英文种类名和 country、chronicle、situation、people、land 这些工具名;' +
    '全部用中文,简短,不用 Markdown 标题和表格。',
  '   直接称作者为"你",不要说"作者"。做不到的部分只说真做不到的;列进确认单的修改不要再说成做不到。',
  '',
  '## 查人物、查地块(只读,不改世界)',
  '- people:人物。作者的人物(人物卡上的生卒、身份、性格、经历、亲友、即位)和推演里的君主、将领、名臣(在位 / 生卒年、所属国家、倾向)。' +
    '按名字找(name);按国家列历代君主(country,role 换成名臣、将领);country 加 year 看那一年谁在位、在位第几年、谁在朝、谁领兵;只给 year 看那年各国的君主。',
  '- land:一片地方的地块数据汇总:海拔、年均气温、年降水、地形占比、人口、城、归属、物产。一片可以是一州(region,也可以给城)、一国某年的国土(country + year)、' +
    '一块陆地(landmass)、经纬度一点(at;加 radius 公里 = 周围一圈)、经纬度一框(box),什么都不给 = 整个世界;给的是平均、最低最高、占比。',
  '- 作者问到人物(谁在位、在位多少年、某人的生平性格),或者某地多高、多冷、多雨、什么地形、多少人、出什么物产,先用这两个查,数字照查到的说。',
  '',
  '## 编号',
  '材料和工具结果里的 P3(国家)、C12(城)、R45(州)、E2(民族)、M7(山河湖海)、L0(陆块)是现在这份历史里的编号,修改里只能用这些编号。',
  '作者说的名字对不上任何一个,就说找不到,不要编。材料里没列出来的州不要编 R 编号:要在某一带立国(比如"北方的冰原")就用 at 给经纬度。试推演里新出现的国家没有编号,不能对它下命令。',
  '试推演、确认单的结果里每条立国都写了那一州在哪、多大、什么地貌:和作者说的地方对不上(纬度不对、只是一座小岛、住不了人)就换一处再试,实在没有就照实说。',
  '',
  '## 修改的写法(try_edits、propose_edits 的 edits,一条一个对象,op 是种类)',
  '',
  REWRITE_OPS,
  '每条修改带 why:一句话(25 字以内)说为什么这样改,给作者看。',
  'from 是整数年份,要在那个国家存在的年份里(立国次年到亡国前一年;写成立国那年的会挪到次年),而且早于历史的最后一年;until 最晚是历史的最后一年。',
  '例:{"op":"protect","country":"P3","from":2400,"until":2750,"why":"…"}、{"op":"ally","country":"P3","other":"P5","from":2400,"why":"…"}、' +
    '{"op":"rename","target":"C12","name":"…","why":"…"}、{"op":"range","path":[[10,40],[14,46]],"size":"大","why":"…"}',
  '',
  '## 常见说法',
  REWRITE_TIPS,
].join('\n');

/** 一条修改的参数(JSON Schema;核对在 parseRewrite 里做,这里只给模型看个大概) */
const EDIT_SCHEMA = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['protect', 'unity', 'halt', 'ally', 'declare', 'move', 'cede', 'found', 'rename', 'volcano', 'lake', 'range', 'raise', 'sink'] },
    country: { type: 'string', description: '国家编号,如 P3' },
    other: { type: 'string', description: '另一个国家的编号(ally、declare)' },
    city: { type: 'string', description: '城的编号,如 C12' },
    region: { type: 'string', description: '州的编号,如 R45' },
    target: { type: 'string', description: 'rename 的对象:P / C / R / E / M 编号' },
    name: { type: 'string' },
    from: { type: 'integer', description: '从哪一年起' },
    until: { type: 'integer', description: '到哪一年为止(可不给)' },
    permanent: { type: 'boolean' },
    at: { type: 'array', items: { type: 'number' }, description: '[经度, 纬度]' },
    path: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '[[经度, 纬度], …]' },
    size: { type: 'string', enum: ['小', '中', '大'] },
    why: { type: 'string' },
  },
  required: ['op'],
};

/** 这一次对话发给 AI 的开头:提示词 + 材料 + 前几轮 + 作者这次说的话 */
export function assistantMessages(ctx: AssistantContext, history: readonly AssistantTurn[], ask: string): AiMessage[] {
  const w = cleanWish(ask);
  const prev = history.slice(-HISTORY_TURNS);
  const mat = rewriteMaterial(ctx.world, ctx.civ, ctx.year, ctx.edits, [...prev.map((t) => t.ask), w], ctx.lock);
  const parts = [mat.text];
  if (prev.length) {
    parts.push('', '# 之前的对话(世界已经按执行过的修改更新,上面的材料是现在的样子)');
    for (const t of prev) {
      parts.push(`作者:${cleanWish(t.ask)}`);
      if (t.reply || t.items?.length)
        parts.push(`你:${t.reply ?? ''}${t.items?.length ? `(列的修改:${t.items.join(';')}${t.applied ? '—— 作者执行了' : '—— 作者没有执行'})` : ''}`);
    }
  }
  parts.push('', '# 作者这次说', w);
  return [
    { role: 'system', content: ASSISTANT_SYSTEM },
    { role: 'user', content: parts.join('\n') },
  ];
}

// ---------------------------------------------------------------------------
// 查资料的小工具

// "P3" / 国名 → 国家编号(和查人物、查地块共用,写在 ./lookup.ts)
export { polityOf };

/** 第 y 年各国几州 */
function sizesAt(civ: Civ, y: number): Map<number, number> {
  const own = y >= civ.endYear ? civ.polity : ownersAt(civ, y).polity;
  const m = new Map<number, number>();
  for (let r = 0; r < own.length; r++) if (own[r] >= 0) m.set(own[r], (m.get(own[r]) ?? 0) + 1);
  return m;
}

/** 编年史一条(给 AI 看):"第 1200—1215 年 正文〔P3、P5〕" */
function entryLine(e: ChronicleEntry): string {
  return `${entryYearLabel(e)} ${e.text}${e.polities.length ? `〔${e.polities.slice(0, 4).map((p) => `P${p}`).join('、')}〕` : ''}`;
}

/** 已下的干预里和国家 id 有关的(一句一条) */
function ivsOf(civ: Civ, edits: WorldEdits, id: number): string[] {
  const out: string[] = [];
  const pid = (k: string) => {
    const r = resolveKey(civ, k);
    return r && r.kind === 'polity' ? r.id : -1;
  };
  for (const raw of edits.interventions) {
    const v = cleanIntervention(raw);
    if (!v) continue;
    const a = 'a' in v && v.a ? pid(v.a) : -1;
    const b = v.kind === 'ally' || v.kind === 'declare' || (v.kind === 'destroy' && v.b) ? pid(v.b!) : -1;
    if (a !== id && b !== id) continue;
    out.push(`第 ${v.from} 年起 ${ivWord(civ, v, a, b)}`);
  }
  return out;
}

const IV_WORD: Record<Intervention['kind'], string> = {
  protect: '保护',
  unity: '禁止分裂',
  halt: '禁止扩张',
  press: '坚持打',
  petty: '小事件',
  story: '故事事件',
  ally: '结盟',
  declare: '宣战',
  move: '迁都',
  cede: '划州',
  found: '立国',
  crown: '立作者的人物为君主',
  policy: '定方针',
  destroy: '灭国',
  death: '让人物去世',
  temper: '改君主倾向',
  disaster: '降天灾',
  treaty: '立约',
  neutral: '划中立地',
  regent: '让人物掌权',
  marry: '为人物联姻',
  keep: '保住王室',
  boost: '推一把发展',
  trek: '大迁徙',
  stay: '不许迁',
  appoint: '任作者的人物为将 / 为臣',
};

function ivWord(civ: Civ, v: Intervention, a: number, b: number): string {
  const n = (id: number) => (id >= 0 ? `P${id} ${nameAt(civ.polities[id], v.from)}` : '(找不到的国家)');
  const until = 'until' in v && v.until !== undefined ? `,至第 ${v.until} 年` : '';
  if (v.kind === 'found') return `在一州立国${v.name ? `「${v.name}」` : ''}`;
  if (v.kind === 'ally') return `${n(a)} 与 ${n(b)} 结盟${until}`;
  if (v.kind === 'declare') return `${n(a)} 向 ${n(b)} 宣战`;
  if (v.kind === 'destroy') return `${n(a)} 灭国,${v.b ? `国土并入 ${n(b)}` : '国土散成无主'}`;
  if (v.kind === 'disaster') return `${v.a ? `${n(a)} ` : ''}降${DISASTER_NAMES[v.type]}(${DISASTER_LEVEL_NAMES[v.level]})`;
  if (v.kind === 'treaty') return `${n(a)} 与另 ${v.ps.length} 国立约`;
  if (v.kind === 'neutral') return `${n(a)} 与另 ${v.ps.length} 国划一州为中立地`;
  if (v.kind === 'boost') return `${n(a)} 推一把发展:${v.mul ? `快 ${v.mul} 倍` : '直接进下一个时代'}${v.regions ? `(${v.regions.length} 州)` : ''}${until}`;
  return `${n(a)} ${IV_WORD[v.kind]}${until}`;
}

/** 一条修改的简短说法(步骤的一行用;不核对):"保护特拉维亚共和国" */
function editWord(civ: Civ, x: unknown): string {
  if (!x || typeof x !== 'object') return '';
  const o = x as Record<string, unknown>;
  const op = String(o.op ?? '');
  const p = (v: unknown) => {
    const id = polityOf(civ, v);
    return id >= 0 ? nameAt(civ.polities[id], typeof o.from === 'number' ? o.from : civ.endYear) : '';
  };
  switch (op) {
    case 'protect':
    case 'unity':
    case 'halt':
      return `${IV_WORD[op]}${p(o.country)}`;
    case 'ally':
      return `${p(o.country)}与${p(o.other)}结盟`;
    case 'declare':
      return `${p(o.country)}向${p(o.other)}宣战`;
    case 'move':
      return `${p(o.country)}迁都`;
    case 'cede':
      return `划一州给${p(o.country)}`;
    case 'found':
      return '立一个新国家';
    case 'rename':
      return `改名为${typeof o.name === 'string' ? o.name : ''}`;
    case 'volcano':
      return '放一座火山';
    case 'lake':
      return '挖一个湖';
    case 'range':
      return '拉一道山脉';
    case 'raise':
      return '抬起陆地';
    case 'sink':
      return '沉成海';
    default:
      return op;
  }
}

/**
 * 一批修改的简短说法(试推演那一行):一条 = "第 2850 年起保护特拉维亚共和国";
 * 几条 = "保护特拉维亚共和国，再和有梧王朝结盟"(后面几条是同一个国家的,不再重复国名;最多说三条)。
 * omit = 刚查过的那个国家:说的都是它时国名也省掉("第 2850 年起保护""保护，再和有梧王朝结盟")
 */
function editsWord(civ: Civ, edits: unknown, omit = -1): string {
  if (!Array.isArray(edits) || !edits.length) return '';
  const first = edits[0] as Record<string, unknown> | null;
  const who = first && typeof first === 'object' ? polityOf(civ, first.country) : -1;
  /** 不带主语的说法(主语是 who 的几种命令);别的 = 空 */
  const bare = (o: Record<string, unknown> | null): string => {
    if (!o || typeof o !== 'object' || who < 0 || polityOf(civ, o.country) !== who) return '';
    const other = polityOf(civ, o.other);
    const n = other >= 0 ? nameAt(civ.polities[other], typeof o.from === 'number' ? o.from : civ.endYear) : '';
    if (o.op === 'ally') return `和${n}结盟`;
    if (o.op === 'declare') return `向${n}宣战`;
    if (o.op === 'protect' || o.op === 'unity' || o.op === 'halt') return IV_WORD[o.op];
    return '';
  };
  const drop = who >= 0 && who === omit && edits.slice(0, 3).every((x) => bare(x as Record<string, unknown> | null));
  if (edits.length === 1) {
    const w = drop ? bare(first) : editWord(civ, first);
    return w && first && typeof first.from === 'number' ? `第 ${Math.floor(first.from)} 年起${w}` : w;
  }
  const words = edits.slice(0, 3).map((x, i) => ((i > 0 || drop) && bare(x as Record<string, unknown> | null)) || editWord(civ, x));
  return words.filter(Boolean).join('，再');
}

/** 两批修改是不是同一批(比能执行的那几条;顺序也要一样:同一年的两条修改按先后执行,换个顺序结果可能不同) */
const changeSig = (cs: readonly RewriteChange[]) => cs.map((c) => JSON.stringify(c)).join('\n');

/** 核对结果写成文字(交回 AI) */
function itemsText(items: readonly RewriteItem[]): string {
  return items
    .map((it) => `- ${it.text}${it.year !== undefined ? `(第 ${it.year} 年起)` : ''}${it.problem ? ` —— 不合格:${it.problem}` : ''}${it.where ? `\n  (${it.where})` : ''}`)
    .join('\n');
}

/** 国家怎么亡的(给作者看,写名字):"第 2881 年被大澜王朝所灭""第 2450 年并入某国""第 2450 年瓦解" */
function endWords(civ: Civ, p: Civ['polities'][number]): string {
  if (p.ended === undefined) return '到最后仍在';
  const y = Math.floor(p.ended);
  const n = (id: number) => nameAt(civ.polities[id], p.ended!);
  const merge = civ.annals.find((e) => e.kind === 'merge' && e.b === p.id);
  if (merge && merge.a >= 0) return `第 ${y} 年并入${n(merge.a)}`;
  const fall = civ.annals.find((e) => e.kind === 'fall' && e.a === p.id);
  if (fall && fall.b >= 0) return `第 ${y} 年被${n(fall.b)}所灭`;
  return `第 ${y} 年瓦解`;
}

/** 结局的短说法(给作者看):"2881 年亡""存续，5 州" */
export function fateShort(f: Fate | null): string {
  if (!f) return '没有这个国家';
  return f.end === undefined ? `存续，${f.size} 州` : `${f.end} 年亡`;
}

/** 一次试推演的一句话(步骤下面的小字):先说关注的第一个国家,没有就说大事增减;它是刚查过的国家(omit)就不写国名 */
export function trialSummary(d: TrialDiff, omit = -1): string {
  const f = d.focus[0];
  const ev = d.addedCount || d.removedCount ? `大事少了 ${d.removedCount} 件，多了 ${d.addedCount} 件` : '大事没有变化';
  if (!f) return ev;
  const who = omit >= 0 && f.who.id === omit ? '' : f.who.name;
  const b = f.before;
  const a = f.after;
  if (!a) return `${who || '它'}在试推演里没有了`;
  if (b && sameFate(b, a)) return `${who || '它'}的结局没有变化${d.addedCount || d.removedCount ? `，${ev}` : ''}`;
  if (a.end === undefined) return b && b.end !== undefined ? `${who}撑到了第 ${d.endYear} 年，最后 ${a.size} 州` : `${who}最后 ${b?.size ?? 0} 州 → ${a.size} 州`;
  const was = b && b.end !== undefined ? (b.end === a.end ? (howEnd(b) !== howEnd(a) ? `（原本${howEnd(b)}）` : '') : `（原本第 ${b.end} 年）`) : '';
  return `${who}第 ${a.end} 年${howEnd(a)}${was}`;
}

/** 试推演结果里的一行(给作者看):国名、现在 → 试推演;note = 下面的小字 */
export interface TrialRow {
  /** 现在这份历史里的编号(只在试推演里有 = −1) */
  id: number;
  name: string;
  /** 现在的("2881 年亡""108 州");只在试推演里有的国家没有 */
  was?: string;
  now: string;
  note?: string;
}

/** 确认单下面"试推演的结果"那一块(能存进浏览器:不带历史本身) */
export interface TrialView {
  from: number;
  endYear: number;
  /** rows 里前几行是关注的国家 */
  focus: number;
  /** 关注的国家 + 别的变化最大的几个(合起来最多 rows 行) */
  rows: TrialRow[];
  /** 别的国家一句话(手机上收起时的小字):"大澜王朝、提布里亚帝国变小,多了维利西亚共和国" */
  others: string;
  /** 不在 rows 里的(手机上点开"别的国家和大事"才看) */
  rest: TrialRow[];
  added: TrialEvent[];
  removed: TrialEvent[];
  addedCount: number;
  removedCount: number;
}

/** 一个国家现在 / 试推演的说法:两边都到最后仍在 = 只比州数 */
function rowOf(c: FateChange): TrialRow {
  const b = c.before;
  const a = c.after;
  const alive = !!b && !!a && b.end === undefined && a.end === undefined;
  // 结局一样:不写"2884 年亡 → 2884 年亡",只写一次
  if (b && a && sameFate(b, a)) return { id: c.who.id, name: c.who.name, now: alive ? `${a.size} 州` : fateShort(a), note: '试推演里没有变化' };
  // 同一年亡、短说法一样(被谁灭、怎么亡、亡国前几州不同):写长一点才看得出差别
  const long = !!b && !!a && b.end !== undefined && b.end === a.end;
  const say = (f: Fate) => (alive ? `${f.size} 州` : long ? fateLong(f, b!, a!) : fateShort(f));
  return { id: c.who.id, name: c.who.name, ...(b ? { was: say(b) } : {}), now: a ? say(a) : '没有了', ...(c.born && !b ? { note: '试推演里新出现的国家' } : {}) };
}

/** 怎么亡的(给作者看):"并入某国""被某国所灭""瓦解" */
const howEnd = (f: Fate) => (f.way === 'merge' && f.by ? `并入${f.by.name}` : f.way === 'fall' && f.by ? `被${f.by.name}所灭` : '瓦解');

/** 同一年亡的两个结局:怎么亡的不一样就写怎么亡的,一样就写亡国前几州 */
function fateLong(f: Fate, b: Fate, a: Fate): string {
  return howEnd(b) !== howEnd(a) ? `${f.end} 年${howEnd(f)}` : `${f.end} 年亡，亡前 ${f.size} 州`;
}

/** 别的国家变成什么样(一句话) */
function othersLine(cs: readonly FateChange[]): string {
  const groups = new Map<string, string[]>();
  const add = (k: string, n: string) => groups.set(k, [...(groups.get(k) ?? []), n]);
  for (const c of cs) {
    const b = c.before;
    const a = c.after;
    if (!b) add('多了', c.who.name);
    else if (!a) add('没了', c.who.name);
    else if (b.end === undefined && a.end !== undefined) add('亡了', c.who.name);
    else if (b.end !== undefined && a.end === undefined) add('撑到了最后', c.who.name);
    else if (b.end === undefined && a.end === undefined) add(a.size < b.size ? '变小' : '变大', c.who.name);
    else add('亡国的年份变了', c.who.name);
  }
  // 原有国家的变化在前,"多了谁"放最后
  return [...groups]
    .sort(([a], [b]) => Number(a === '多了') - Number(b === '多了'))
    .map(([k, ns]) => {
      const n = ns.length > 3 ? `${ns.slice(0, 3).join('、')}等 ${ns.length} 国` : ns.join('、');
      return k === '多了' ? `多了${n}` : `${n}${k}`;
    })
    .join('，');
}

/** 试推演的结果整理成确认单下面那几行(关注的国家在前;试推演里新分出来的国家写在母国那一行的小字里) */
export function trialView(d: TrialDiff, max = 3): TrialView {
  // 关注的国家里没变的(比如拉来结盟、结果一样的那一方)不占一行;第一个(主角)照样列
  const same = (c: FateChange) => JSON.stringify(c.before) === JSON.stringify(c.after);
  const focus = d.focus.filter((c, i) => i === 0 || !same(c));
  const listed = new Set([...focus, ...d.others].filter((c) => c.who.id >= 0).map((c) => c.who.id));
  const attached = (c: FateChange) => !!c.born && !c.before && c.born.from !== undefined && listed.has(c.born.from.id);
  const toRow = (c: FateChange): TrialRow => {
    const r = rowOf(c);
    const kids = r.id >= 0 ? d.others.filter((k) => attached(k) && k.born!.from!.id === r.id) : [];
    return kids.length ? { ...r, note: kids.map((k) => `${k.born!.year} 年${k.who.name}从它那里自立`).join(';') } : r;
  };
  const list = [...focus, ...d.others.filter((c) => !attached(c))].map(toRow);
  const n = Math.max(max, focus.length);
  const ev = d.addedCount || d.removedCount ? `大事少了 ${d.removedCount} 件，多了 ${d.addedCount} 件` : '';
  return {
    from: d.from,
    endYear: d.endYear,
    focus: focus.length,
    rows: list.slice(0, n),
    others: othersLine(d.others) || ev || '别的国家和大事没有变化',
    rest: list.slice(n),
    added: d.added,
    removed: d.removed,
    addedCount: d.addedCount,
    removedCount: d.removedCount,
  };
}

/** 查了什么(一步) */
function queryWords(s: Pick<AgentStep, 'tool' | 'label'>): string {
  const m = /^查(?:国家|编年史)：([^，]+)/.exec(s.label);
  if (s.tool === 'country' && m) return `查了${m[1]}`;
  if (s.tool === 'chronicle') return m ? `查了${m[1]}的编年史` : '查了编年史';
  if (s.tool === 'situation') return s.label.replace(/^查/, '查了');
  // "查人物：李昭" → "查了李昭";"查第 1200 年各国的君主" → "查了第 1200 年各国的君主"
  if (s.tool === 'people') return s.label.startsWith('查人物：') ? `查了${s.label.slice(4)}` : s.label.replace(/^查/, '查了');
  // "查地块：某州" → "查了某州的地形气候"
  if (s.tool === 'land') return s.label.startsWith('查地块：') ? `查了${s.label.slice(4)}的地形气候` : '查了地形气候';
  return '查了 1 次';
}

/** 查资料的工具(做完以后那一行算作"查了几次") */
const QUERY_TOOLS = new Set(['country', 'chronicle', 'situation', 'people', 'land']);

/** 做过的几步收成一句话(做完以后那一行):"查了 2 次，试推演 3 次" */
export function stepsSummary(steps: readonly Pick<AgentStep, 'tool' | 'state' | 'label' | 'summary'>[]): string {
  const queries = steps.filter((s) => QUERY_TOOLS.has(s.tool));
  const query = queries.length;
  const tries = steps.filter((s) => s.tool === 'try_edits' && s.state === 'ok').length;
  /** 查过的国家(后面说到它就叫"它") */
  const who = /^查国家：(.+)$/.exec(queries.find((s) => s.tool === 'country')?.label ?? '')?.[1];
  const parts: string[] = [];
  const chron = queries.find((s) => s.tool === 'chronicle');
  // 只查了一次:说查了什么("查了利松德""查了第 1200 年的格局");查了一国又查它的编年史:"查了大澜王朝和它的 26 件大事"
  if (query === 1) parts.push(queryWords(queries[0]));
  else if (query === 2 && who && chron?.summary && chron.label.startsWith(`查编年史：${who}`)) parts.push(`查了${who}和它的 ${chron.summary}`);
  else if (query) parts.push(`查了 ${query} 次`);
  if (tries) parts.push(`试推演 ${tries} 次`);
  for (const st of steps) {
    if (QUERY_TOOLS.has(st.tool) || st.tool === 'try_edits' || st.tool === 'propose_edits' || st.state !== 'ok') continue;
    const w = st.summary ?? st.label;
    // "在地图上打开了奈雷亚国(，时间轴拨到第 N 年)" → "在地图上打开了它…"
    const opened = `在地图上打开了${who}`;
    const rest = w.slice(opened.length);
    parts.push(who && st.tool === 'show' && w.startsWith(opened) && (!rest || rest.startsWith('，')) ? `在地图上打开了它${rest}` : w);
  }
  return parts.join('，') || `做了 ${steps.length} 步`;
}

// ---------------------------------------------------------------------------
// 一次对话

export interface AssistantOptions {
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  maxRounds?: number;
  /** 另外给的工具(写史书、起名、在地图上打开这些要碰界面的,由界面给) */
  extraTools?: AgentTool[];
  /** 确认单列好了(之后最后那句话没说完、出错或停下,界面照样能把确认单留下) */
  onProposal?: (p: AssistantProposal) => void;
}

/** 这次对话的试推演和确认单 */
export interface AssistantState {
  trials: AssistantTrial[];
  proposal: AssistantProposal | null;
  onProposal?: (p: AssistantProposal) => void;
  /** 列的确认单要它改了再列(加岛的落点贴着陆地) */
  relist?: boolean;
}

/** 有地形修改的落点贴着现有的陆地(抬出来会连成一片) */
const attached = (items: readonly RewriteItem[]) => items.some((it) => it.change?.kind === 'terrain' && it.where?.includes('连在一起'));

/** 给 AI 的工具(带着这次对话的试推演和确认单) */
export function assistantTools(
  ctx: AssistantContext,
  state: AssistantState,
): AgentTool[] {
  const { civ } = ctx;
  const rctx: RewriteContext = { world: ctx.world, civ, year: ctx.year, edits: ctx.edits, lock: ctx.lock };
  const noCiv = '这颗星球没有长出文明:没有国家和历史。';
  const end = Math.floor(civ.endYear);
  /** 这一轮刚查过的国家(试推演那一行说的都是它时不再写国名) */
  let subject = -1;

  const parse = (args: Record<string, unknown>, cannot?: unknown) => {
    const p = parseRewrite(JSON.stringify({ reply: '', edits: args.edits ?? [], ...(cannot !== undefined ? { cannot } : {}) }), rctx);
    if (!p.ok) throw new Error('edits 里没有修改');
    return p;
  };

  /** 能试推演的那几条:干预、改名(地形不行) */
  const trialable = (items: readonly RewriteItem[]) => items.filter((it) => it.change && it.change.kind !== 'terrain').map((it) => it.change!);

  /** 按这几条修改试推演一次 */
  const trial = async (items: RewriteItem[], changes: RewriteChange[], n: number, watch: number[], signal?: AbortSignal): Promise<AssistantTrial> => {
    const edits = mergeRewrite(ctx.edits, changes);
    const after = await ctx.simulate!(edits, signal);
    const focus = new Set(watch);
    let from = end;
    for (const c of changes) {
      if (c.kind !== 'intervention') continue;
      from = Math.min(from, c.v.from);
      for (const k of ['a' in c.v ? c.v.a : undefined, 'b' in c.v ? c.v.b : undefined]) {
        if (!k) continue;
        const r = resolveKey(civ, k);
        if (r && r.kind === 'polity') focus.add(r.id);
      }
    }
    // 同一批里有改名:试推演的历史套了新名字,现在这份也套上再比(按名字写成的大事才对得上,不会把没变的大事算成少一件、多一件)
    const base = changes.some((c) => c.kind === 'name') ? applyNames(civ, edits.names) : civ;
    const diff = compareTrial(base, after, [...focus], from);
    noteDeclares(
      diff,
      base,
      after,
      changes.flatMap((c) => (c.kind === 'intervention' && c.v.kind === 'declare' ? [c.v] : [])),
    );
    return { n, items, edits, civ: after, diff };
  };

  const country: AgentTool = {
    def: {
      name: 'country',
      description: '查一个国家的来龙去脉:国号先后、存在的年份、国都变迁、国土消长、邻国、结局、已下的命令、和它有关的大事。',
      parameters: { type: 'object', properties: { country: { type: 'string', description: '国家编号(如 P3),或国名' } }, required: ['country'] },
    },
    label: (a) => {
      const id = polityOf(civ, a.country);
      return id >= 0 ? `查国家：${nameAt(civ.polities[id], ctx.year)}` : '查国家';
    },
    run: (a) => {
      if (!civ.viable) return noCiv;
      const id = polityOf(civ, a.country);
      if (id < 0) return `找不到国家「${String(a.country ?? '')}」;请用材料里的编号(P3 这样)`;
      subject = id;
      const p = civ.polities[id];
      const S = civ.settlements;
      const out: string[] = [];
      const cu = civ.cultures[p.culture];
      const last = lastYear(civ, p);
      out.push(
        `P${id} ${nameAt(p, ctx.year)} · 第 ${Math.floor(p.founded)}—${p.ended !== undefined ? `${Math.floor(p.ended)} 年` : `${end} 年(到最后仍在)`}` +
          (polityTitleChain(p).includes('→') ? ` · 国号先后:${polityTitleChain(p)}` : '') +
          (cu ? ` · 民族 E${cu.id}(${cu.name}族)` : ''),
      );
      const caps = p.capitals?.length ? p.capitals : [{ year: p.founded, settlement: p.capital }];
      out.push(`国都:${caps.map((c) => `第 ${Math.floor(c.year)} 年起 C${c.settlement} ${S[c.settlement]?.name ?? ''}`).join(' → ')}`);
      // 国土消长:立国到最后,取八九个年份
      const span = Math.max(1, Math.floor(last) - Math.floor(p.founded));
      const step = Math.max(10, Math.round(span / 8 / 10) * 10);
      const samples: string[] = [];
      let peak = { y: Math.floor(p.founded), n: 0 };
      // 立国那一年州还没划过来(常常是 0 州),从第二年数起
      for (let y = Math.min(Math.floor(last), Math.floor(p.founded) + 1); y < Math.floor(last); y += step) {
        const n = sizesAt(civ, y).get(id) ?? 0;
        samples.push(`第 ${y} 年 ${n} 州`);
        if (n > peak.n) peak = { y, n };
      }
      const nLast = sizesAt(civ, Math.floor(last)).get(id) ?? 0;
      if (nLast > peak.n) peak = { y: Math.floor(last), n: nLast };
      samples.push(`第 ${Math.floor(last)} 年 ${nLast} 州`);
      out.push(`国土:${samples.join(' / ')};最盛约第 ${peak.y} 年 ${peak.n} 州`);
      const Y = Math.floor(Math.min(ctx.year, end));
      if (polityAlive(p, Y)) {
        const own = Y >= civ.endYear ? civ.polity : ownersAt(civ, Y).polity;
        const near = [...bordersAt(civ, own, id, Y)].sort((x, y) => x - y);
        out.push(
          `第 ${Y} 年(时间轴):${sizesAt(civ, Y).get(id) ?? 0} 州,国都 C${capitalAt(p, Y)} ${S[capitalAt(p, Y)]?.name ?? ''},` +
            (near.length ? `邻国 ${near.map((q) => `P${q} ${nameAt(civ.polities[q], Y)}`).join('、')}` : '没有接壤的国家'),
        );
      }
      // endText 只写编号:补上国名(亡国那年的叫法)
      const fate = endText(civ, p).replace(/P(\d+)/, (m, d: string) => `${m} ${nameAt(civ.polities[Number(d)], p.ended ?? civ.endYear)}`);
      out.push(`结局:${fate || '到最后仍在'}`);
      const ivs = ivsOf(civ, ctx.edits, id);
      if (ivs.length) out.push(`已下的命令:${ivs.join(';')}`);
      const all = buildChronicle(civ).filter((e) => entryInvolves(e, id));
      const major = all.filter((e) => e.importance >= MAJOR);
      const list = (major.length >= 6 ? major : all).slice(-24);
      out.push(`和它有关的大事(共 ${all.length} 条,列${list.length < all.length ? '最近的' : ''} ${list.length} 条;更多用 chronicle 查):`);
      for (const e of list) out.push(`- ${entryLine(e)}`);
      const ending = p.ended === undefined ? `到最后仍在，${nLast} 州` : endWords(civ, p);
      // 分出来的国家没有立国史事,说"自立"
      return { result: out.join('\n'), summary: `第 ${Math.floor(p.founded)} 年${p.parent !== undefined ? '自立' : '立国'}；${ending}` };
    },
  };

  const chronicle: AgentTool = {
    def: {
      name: 'chronicle',
      description: '查编年史:按年份范围、国家筛选。默认只列大事;all = true 列全部。一次最多 60 条,太多就缩小年份范围。',
      parameters: {
        type: 'object',
        properties: {
          year: { type: 'integer', description: '只看这一年(和 from、to 二选一)' },
          from: { type: 'integer', description: '从哪一年(含)' },
          to: { type: 'integer', description: '到哪一年(含)' },
          country: { type: 'string', description: '只看和这个国家有关的(编号如 P3)' },
          all: { type: 'boolean', description: 'true = 不只大事' },
          limit: { type: 'integer', description: '最多几条,默认 30' },
        },
      },
    },
    label: (a) => {
      const id = a.country !== undefined ? polityOf(civ, a.country) : -1;
      const range =
        a.year !== undefined && a.from === undefined && a.to === undefined
          ? `第 ${a.year} 年`
          : a.from !== undefined || a.to !== undefined
            ? `第 ${a.from ?? 0}—${a.to ?? end} 年`
            : '';
      return `查编年史${id >= 0 ? `：${nameAt(civ.polities[id], ctx.year)}` : ''}${range ? `${id >= 0 ? '，' : '：'}${range}` : ''}`;
    },
    run: (a) => {
      if (!civ.viable) return noCiv;
      const one = a.year !== undefined && a.from === undefined && a.to === undefined;
      const from = yearArg(civ, one ? a.year : a.from, 0);
      const to = one ? from : yearArg(civ, a.to, end);
      const id = a.country !== undefined && a.country !== '' ? polityOf(civ, a.country) : -1;
      if (a.country !== undefined && a.country !== '' && id < 0) return `找不到国家「${String(a.country)}」`;
      const limit = Math.max(1, Math.min(60, Math.floor(Number(a.limit) || 30)));
      const list = buildChronicle(civ).filter(
        (e) => Math.floor(e.end) >= from && Math.floor(e.year) <= to && (a.all === true || e.importance >= MAJOR) && (id < 0 || entryInvolves(e, id)),
      );
      const span = from === to ? `第 ${from} 年` : `第 ${from}—${to} 年`;
      if (!list.length) return `${span}${id >= 0 ? `和 P${id} 有关的` : ''}没有${a.all === true ? '' : '大'}事。`;
      const shown = list.slice(0, limit);
      return {
        result: [
          `${span}${id >= 0 ? `和 P${id} ${nameAt(civ.polities[id], to)} 有关的` : '的'}${a.all === true ? '史事' : '大事'}:共 ${list.length} 条${shown.length < list.length ? `,列前 ${shown.length} 条(缩小年份范围看后面的)` : ''}`,
          ...shown.map((e) => `- ${entryLine(e)}`),
        ].join('\n'),
        // 给作者看的都叫"大事"(和左边卡片的"大事 全部 N 件"一个叫法)
        summary: `${list.length} 件大事`,
      };
    },
  };

  const situation: AgentTool = {
    def: {
      name: 'situation',
      description: '查某一年的格局:那年在世的国家(按国土大小)、国都、邻国,和正在打的仗。',
      parameters: { type: 'object', properties: { year: { type: 'integer' } }, required: ['year'] },
    },
    label: (a) => `查第 ${yearArg(civ, a.year, ctx.year)} 年的格局`,
    run: (a) => {
      if (!civ.viable) return noCiv;
      const Y = yearArg(civ, a.year, ctx.year);
      const own = Y >= civ.endYear ? civ.polity : ownersAt(civ, Y).polity;
      const size = sizesAt(civ, Y);
      const alive = civ.polities.filter((p) => polityAlive(p, Y) && (size.get(p.id) ?? 0) > 0).sort((x, y) => (size.get(y.id) ?? 0) - (size.get(x.id) ?? 0) || x.id - y.id);
      const S = civ.settlements;
      const out = [`第 ${Y} 年在世的国家 ${alive.length} 个${alive.length > 40 ? '(列最大的 40 个)' : ''}:`];
      for (const p of alive.slice(0, 40)) {
        const cap = capitalAt(p, Y);
        const near = [...bordersAt(civ, own, p.id, Y)].sort((x, y) => x - y);
        out.push(`- P${p.id} ${nameAt(p, Y)} · ${size.get(p.id)} 州 · 国都 C${cap} ${S[cap]?.name ?? ''}${near.length ? ` · 邻国 ${near.map((q) => `P${q}`).join('、')}` : ''}`);
      }
      const allWars = buildChronicle(civ).filter((e) => e.kind === 'war');
      const wars = allWars.filter((e) => Math.floor(e.year) <= Y && Math.floor(e.end) >= Y);
      if (wars.length) out.push(`这一年正在打的仗:`, ...wars.slice(0, 12).map((e) => `- ${entryLine(e)}`));
      else {
        // 没有仗就明说(不然 AI 容易猜"很可能在打仗"),再给前后最近的一场
        // 编年史按开战年份排:之前最近的一场按结束年份挑(早开打的长仗可能比后开打的短仗结束得晚)
        const prev = allWars.filter((e) => Math.floor(e.end) < Y).reduce<ChronicleEntry | undefined>((m, e) => (!m || e.end > m.end ? e : m), undefined);
        const next = allWars.find((e) => Math.floor(e.year) > Y);
        out.push(
          '这一年没有正在打的仗。',
          ...(prev ? [`之前最近的一场:${entryLine(prev)}`] : []),
          ...(next ? [`之后最近的一场:${entryLine(next)}`] : []),
        );
      }
      // 刚查过的国家那一年还在:小字说它(紧跟在查它那一行下面,不再写国名:"剩 9 州，和有梧王朝、提布里亚帝国接壤"),否则说整个天下
      const me = subject >= 0 && size.get(subject) ? subject : -1;
      const near = me >= 0 ? [...bordersAt(civ, own, me, Y)].sort((x, y) => (size.get(y) ?? 0) - (size.get(x) ?? 0) || x - y) : [];
      // 那年的国号和现在(左边卡片上)不一样的,补一句后来叫什么
      const names = near.slice(0, 3).map((q) => {
        const then = nameAt(civ.polities[q], Y);
        const now = nameAt(civ.polities[q], civ.endYear);
        return now !== then && civ.polities[q].ended === undefined ? `${then}（后来的${now}）` : then;
      });
      const summary =
        me >= 0
          ? `剩 ${size.get(me)} 州${names.length ? `，和${names.join('、')}${near.length > 3 ? `等 ${near.length} 国` : ''}接壤` : ''}`
          : `${alive.length} 个国家在世${wars.length ? `，${wars.length} 场仗在打` : ''}`;
      return { result: out.join('\n'), summary };
    },
  };

  const lctx = { world: ctx.world, civ, year: ctx.year, edits: ctx.edits };

  const people: AgentTool = {
    def: {
      name: 'people',
      description:
        '查人物:作者的人物(人物卡上的生卒、身份、性格、经历、亲友、即位)和推演里的君主、将领、名臣、宗室(在位 / 生卒年、所属国家、倾向)。' +
        '给 name 按名字找;给 country 列这国的历代君主(role 换成名臣、将领),加 year 看那一年谁在位、谁在朝、谁领兵;只给 year 看那年各国的君主;' +
        '什么都不给 = 作者的人物和推演里的名人。只读,不改世界。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '名字(本名、称号、字都行,可以只写几个字)' },
          country: { type: 'string', description: '国家编号(如 P3),或国名' },
          year: { type: 'integer', description: '哪一年' },
          from: { type: 'integer', description: '列历代时从哪一年(含)' },
          to: { type: 'integer', description: '列历代时到哪一年(含)' },
          role: { type: 'string', enum: ['ruler', 'general', 'minister', 'prince', 'author'], description: '只看君主 / 将领 / 名臣 / 宗室 / 作者的人物' },
          limit: { type: 'integer', description: '最多列几个,默认 30' },
        },
      },
    },
    label: (a) => peopleLabel(lctx, a),
    run: (a) => lookupPeople(lctx, a),
  };

  const land: AgentTool = {
    def: {
      name: 'land',
      description:
        '查一片地方的地块数据汇总:海拔、年均气温、年降水、地形(群落)占比、人口、城、归属、物产,给平均、最低最高、占比。' +
        '一片可以是:一州(region)、一国某年的国土(country,可加 year)、一块陆地(landmass)、经纬度一点(at;加 radius 公里 = 周围一圈)、' +
        '经纬度一框(box);什么都不给 = 整个世界。只给一种。只读,不改世界。',
      parameters: {
        type: 'object',
        properties: {
          region: { type: 'string', description: '州的编号(如 R45)、州名;也可以给城(C12 或城名),查城所在的州' },
          country: { type: 'string', description: '国家编号(如 P3)或国名:这国在 year 那一年的全部国土' },
          landmass: { type: 'string', description: '陆块编号,如 L0' },
          at: { type: 'array', items: { type: 'number' }, description: '[经度, 纬度]' },
          radius: { type: 'number', description: '和 at 一起:周围多少公里(不给 = 只看离那一点最近的一块地)' },
          box: { type: 'array', items: { type: 'number' }, description: '[西边的经度, 南边的纬度, 东边的经度, 北边的纬度]' },
          year: { type: 'integer', description: '人口、归属、物产按哪一年(默认时间轴的年份)' },
        },
      },
    },
    label: (a) => landLabel(lctx, a),
    run: (a) => lookupLand(lctx, a),
  };

  const tryEdits: AgentTool = {
    def: {
      name: 'try_edits',
      description:
        `按一批修改在后台把历史重推一遍,告诉你结果和现在比有什么不同(关注的国家结局、变化最大的国家、多了少了哪些大事)。不会动作者的世界。` +
        `一次对话最多 ${TRIAL_MAX} 次;地形修改不能试推演。`,
      parameters: {
        type: 'object',
        properties: {
          edits: { type: 'array', items: EDIT_SCHEMA, description: '要试的修改' },
          watch: { type: 'array', items: { type: 'string' }, description: '另外想看结局的国家编号(修改里点到的会自动看)' },
        },
        required: ['edits'],
      },
    },
    label: (a) => {
      const w = editsWord(civ, a.edits, subject);
      return w ? `试推演：${w}` : '试推演';
    },
    run: async (a, signal) => {
      if (!ctx.simulate) throw new Error('这里不能试推演,直接用 propose_edits 列给作者');
      const done = state.trials.filter((t) => t.n > 0).length;
      if (done >= TRIAL_MAX) throw new Error(`试推演已经用了 ${TRIAL_MAX} 次,请挑最好的一种用 propose_edits 列给作者`);
      const p = parse(a);
      const changes = trialable(p.items);
      const notes: string[] = [];
      if (p.items.some((it) => it.change?.kind === 'terrain')) notes.push('地形修改不能试推演(整个世界要重新生成),这次没算进去。');
      if (!changes.length) return [`没有能试推演的修改:`, itemsText(p.items), ...notes].join('\n');
      if (!changes.some((c) => c.kind === 'intervention')) return [`只有改名,历史不会变,不用试推演:`, itemsText(p.items)].join('\n');
      const watch = (Array.isArray(a.watch) ? a.watch : []).map((x) => polityOf(civ, x)).filter((id) => id >= 0);
      const t = await trial(p.items, changes, done + 1, watch, signal);
      state.trials.push(t);
      // 连着几次都和现在一样:提醒它别再换着法子试("让某一仗打赢"这类,命令本来就做不到)
      let same = 0;
      for (let i = state.trials.length - 1; i >= 0 && trialUnchanged(state.trials[i].diff); i--) same++;
      const stuck =
        same >= TRIAL_SAME_MAX
          ? [
              `已经连着 ${same} 次试推演,历史都和现在一样。作者要的结果还没出现的话,这件事多半用命令做不到:` +
                '不要再换着法子试,直接告诉作者做不到、为什么;有接近的做法可以提一句。',
            ]
          : [];
      return {
        result: [`第 ${t.n} 次试推演(没有执行),修改:`, itemsText(p.items), ...notes, trialText(t.diff), ...stuck].join('\n'),
        summary: trialSummary(t.diff, subject),
      };
    },
  };

  const propose: AgentTool = {
    def: {
      name: 'propose_edits',
      description:
        '把修改列给作者确认(作者点了执行才生效)。一次对话只列一张,再调会换掉上一张。列之前最好先用 try_edits 试过;' +
        '没试过的会顺带试推演一次。做不到的部分写进 cannot,一条一句话。',
      parameters: {
        type: 'object',
        properties: {
          edits: { type: 'array', items: EDIT_SCHEMA },
          cannot: { type: 'array', items: { type: 'string' }, description: '做不到的部分,一条一句话' },
        },
        required: ['edits'],
      },
    },
    label: (a) => `列出要改的 ${Array.isArray(a.edits) ? a.edits.length : 0} 条`,
    run: async (a, signal) => {
      const p = parse(a, a.cannot);
      const ok = p.items.filter((it) => it.change);
      const changes = trialable(p.items);
      let t: AssistantTrial | undefined;
      // 有地形修改的不附结果(历史会整个重来,和现在没法比)
      if (changes.length === ok.length && changes.some((c) => c.kind === 'intervention')) {
        const sig = changeSig(changes);
        t = state.trials.find((x) => changeSig(trialable(x.items)) === sig);
        if (!t && ctx.simulate) t = await trial(p.items, changes, 0, [], signal);
      }
      const replaced = !!state.proposal;
      state.proposal = { items: p.items, cannot: p.cannot, ...(t ? { trial: t } : {}) };
      state.relist = attached(p.items);
      state.onProposal?.(state.proposal);
      const out = [
        `${replaced ? '已换掉上一张,' : ''}列给作者 ${p.items.length} 条${ok.length < p.items.length ? `(其中 ${p.items.length - ok.length} 条不合格,作者执行不了)` : ''}:`,
        itemsText(p.items),
      ];
      if (p.cannot.length) out.push(`做不到的:${p.cannot.join(';')}`);
      if (t) out.push(t.n > 0 ? `这批修改就是第 ${t.n} 次试推演的那一批。` : '这批修改顺带试推演了一次:', ...(t.n > 0 ? [] : [trialText(t.diff)]));
      out.push(...closing(p.items, p.cannot.length > 0, t?.diff));
      return { result: out.join('\n'), summary: `${ok.length} 条能执行${ok.length < p.items.length ? `，${p.items.length - ok.length} 条不合格` : ''}` };
    },
  };

  // 还在新建:只能改地形,地形不能试推演(给了试推演,模型会先绕一圈再忘了列单)
  return [country, chronicle, situation, people, land, ...(ctx.lock === 'history' ? [] : [tryEdits]), propose];
}

/** 列完确认单以后交代 AI 怎么收尾:回答要和作者看到的确认单对得上(说主角的结果,也说副作用和执行不了的) */
function closing(items: readonly RewriteItem[], cannot: boolean, d?: TrialDiff): string[] {
  const out: string[] = [];
  const bad = items.filter((it) => !it.change).length;
  // 加岛的落点贴着陆地:先挪了再列(作者执行了才看得到地形,那时已经连成一片)
  if (attached(items))
    out.push('有地形修改的落点贴着现有的陆地(见上面括号里的核对),抬出来会连成一片。作者要的是海上单独的岛,就挪到开阔的海面上,再用 propose_edits 列一次;作者要的就是连着的,照常回答。');
  const v = d ? trialView(d) : null;
  if (v) {
    out.push(
      '作者在确认单下面看到的试推演结果:',
      ...v.rows.map((r) => `- ${r.name}:${r.was ? `${r.was} → ` : ''}${r.now}${r.note ? `(${r.note})` : ''}`),
      `- 别的国家:${v.others}`,
    );
    for (const x of d!.declared ?? []) out.push(`- ${x.text}:${x.war ? `打起来了(${x.war.text})` : '试推演里没打起来'}`);
    // 撑到了历史的最后一年:作者要"多撑 300 年"而历史只剩几十年时,得说实际多撑了几年(截止写成最后一年时代码看不出超了)
    for (const c of d!.focus) {
      const b = c.before?.end;
      if (b === undefined || !c.after || c.after.end !== undefined) continue;
      out.push(
        `- ${c.who.name}原本第 ${b} 年亡,试推演里撑到了历史的最后一年(第 ${d!.endYear} 年),多撑了 ${d!.endYear - b} 年。` +
          `作者要多撑的年数比这多时,要说历史只推演到第 ${d!.endYear} 年、实际多撑了 ${d!.endYear - b} 年。`,
      );
    }
  }
  const say = [
    v ? '作者问的那个国家会怎样(和上面的结果一致,不要说和它对不上的话)' : '打算怎么改',
    ...(v && v.others !== '别的国家和大事没有变化' ? ['别的国家最大的一两处变化(上面"别的国家"那一行)'] : []),
    ...(bad ? [`有 ${bad} 条不合格,作者执行不了:说是哪条、为什么`] : []),
    ...(cannot ? ['做不到的部分(理由只写查到的、试出来的,没试过的不要说试过)'] : []),
  ];
  // 不给编号(给了"①②"模型会照抄进回答)
  out.push(
    `现在用两三句话回答,要说到这几样:${say.join(';')}。直接称作者为"你",不要分条编号。` +
      '作者还没执行,说"会""打算",不要说"已经改了""已放置"。',
  );
  return out;
}

/** 助手的一次对话:问 → 查 / 试 → 列确认单 → 回话 */
export async function runAssistant(ctx: AssistantContext, history: readonly AssistantTurn[], ask: string, opts: AssistantOptions = {}): Promise<AssistantResult> {
  const state: AssistantState = {
    trials: [],
    proposal: null,
    onProposal: opts.onProposal,
  };
  const w = cleanWish(ask);
  // 回给作者的话里漏出来的编号、英文种类名换成名字(边说边换,面板上不会闪过编号);
  // 提示词里管说话的人叫"作者",模型常常照抄("需作者点击执行"),回给人看的换成"你"。
  // 作者自己说到"作者"(改名叫"作者城"、问书的作者)就不换;名字里带"作者"的城、国家、山河照原样
  const kept = w.includes('作者')
    ? null
    : [...ctx.civ.settlements.map((x) => x.name), ...ctx.civ.places.map((x) => x.name), ...ctx.civ.polities.flatMap((p) => polityTitleChain(p).split(' → '))].filter((n) =>
        n.includes('作者'),
      );
  const keep = kept?.length ? new RegExp(`(${kept.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`) : null;
  /** 名字以外的"作者"换成"你"(split 带括号:奇数位是名字本身) */
  const you = (t: string) => (!kept ? t : keep ? t.split(keep).map((x, i) => (i % 2 ? x : x.replace(/作者/g, '你'))).join('') : t.replace(/作者/g, '你'));
  const plain = (t: string) => you(plainIds(t, ctx));
  const onEvent = opts.onEvent;
  const out = await runAgent({
    feature: ASSISTANT_FEATURE,
    title: [...w].length > 24 ? `${[...w].slice(0, 24).join('')}…` : w,
    messages: assistantMessages(ctx, history, w),
    tools: [...assistantTools(ctx, state), ...(opts.extraTools ?? [])],
    maxRounds: opts.maxRounds,
    temperature: 0.3,
    maxTokens: 2000,
    signal: opts.signal,
    onEvent: onEvent && ((e) => onEvent(e.type === 'text' ? { ...e, text: plain(e.text) } : e)),
    followUp: (text, steps) => {
      if (!saysListed(text)) return null;
      if (!steps.some((s) => s.tool === 'propose_edits' && s.state === 'ok')) return LIST_NUDGE;
      // 列过一张,结果让它挪了落点再列:它说了要挪、要重新列却没再调(作者要的就是连着的,照常回答,不补)
      return state.relist && saysRelisted(text) ? RELIST_NUDGE : null;
    },
  });
  // 收尾的话像没说完("让我再查……:"):补一句,作者知道可以让它接着来
  const text = looksUnfinished(out.text) ? `${out.text}\n\n${UNFINISHED_NOTE}` : out.text;
  return { text: plain(text), steps: out.steps, proposal: state.proposal, trials: state.trials, end: out.end, usage: out.usage };
}

// ---------------------------------------------------------------------------
// 测试用假 AI(网址 ai=mock):按固定的步骤调工具,好检查界面和流程

/** 离海最远的陆地(按网格一步步往里数;平手取编号小的;不算两极的冰原):[经度, 纬度] */
function farthestInland(world: World): [number, number] {
  const { mesh, water } = world;
  const polar = (i: number) => Math.abs(0.5 - mesh.y[i] / mesh.height) > 0.3;
  const dist = new Int32Array(mesh.n).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < mesh.n; i++)
    if (water[i]) {
      dist[i] = 0;
      queue.push(i);
    }
  let best = -1;
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h];
    if (!polar(i) && (best < 0 || dist[i] > dist[best])) best = i;
    for (let k = mesh.adjStart[i]; k < mesh.adjStart[i + 1]; k++) {
      const j = mesh.adj[k];
      if (dist[j] < 0) {
        dist[j] = dist[i] + 1;
        queue.push(j);
      }
    }
  }
  if (best < 0) best = 0;
  return [(mesh.x[best] / mesh.width) * 360 - 180, 90 - (mesh.y[best] / mesh.height) * 180];
}

/** 假 AI 一轮的回复 */
export interface MockTurn {
  text?: string;
  toolCalls?: AiToolCall[];
}

/** 作者这次说的话(user 消息最后"# 作者这次说"下面那一段) */
function askOf(req: AiRequest): string {
  const u = req.messages.find((m) => m.role === 'user')?.content ?? '';
  const i = u.lastIndexOf('# 作者这次说\n');
  return i >= 0 ? u.slice(i + '# 作者这次说\n'.length).trim() : u;
}

/** 话里点了名的国家(最长的名字优先);没点名 = −1 */
function namedPolity(civ: Civ, ask: string): number {
  let best = -1;
  let len = 0;
  for (const p of civ.polities) {
    for (const n of [...polityTitleChain(p).split(' → '), ...polityRoots(p)]) {
      const l = [...n].length;
      if (l >= 2 && l > len && ask.includes(n)) {
        best = p.id;
        len = l;
      }
    }
  }
  return best;
}

/** 话里点了名的州(最长的名字优先;两个字以上);没点名 = −1 */
function namedRegion(civ: Civ, ask: string): number {
  let best = -1;
  let len = 0;
  for (let r = 0; r < civ.regions.count; r++) {
    if (!regionNamed(civ, r)) continue;
    const n = regionLabel(civ, r);
    const l = [...n].length;
    if (l >= 2 && l > len && ask.includes(n)) {
      best = r;
      len = l;
    }
  }
  return best;
}

/**
 * 假 AI 的固定步骤(不理解话的意思,只看字眼):
 * - 问人物("君主""在位""将领"……):查这国那一年的人物 → 回一句话;问地形气候("海拔""气温""物产"……):查点了名的州或这国的国土 → 回一句话
 * - 问句("？""为什么""怎么"……):查国家 → 在地图上打开它(有这个工具时)→ 回一段话
 * - 说到史书:查国家 → 写史书;说到名字:起名
 * - 其余当作要改:查国家 → 查那一年的格局 → 试推演"保护" → 试推演"保护 + 和邻国结盟" → 列确认单 → 回一句话
 * - 还在新建(只能改地形)、不是问句:在最大那块陆地离海最远的地方挖一个大湖,北边拉一道东西走向的山脉 → 回一句话
 * 话里没点名国家时,挑亡了的国家里国祚最长的那个
 */
export function mockAssistant(ctx: AssistantContext): (req: AiRequest) => MockTurn {
  const { civ } = ctx;
  return (req) => {
    const ask = askOf(req);
    const round = req.messages.filter((m) => m.role === 'assistant' && m.toolCalls?.length).length;
    const tools = new Set((req.tools ?? []).map((t) => t.name));
    const call = (name: string, args: Record<string, unknown>): MockTurn => ({ toolCalls: [{ id: `mock_${round}`, name, args: JSON.stringify(args) }] });
    const say = (text: string): MockTurn => ({ text: `【测试用假 AI】${text}` });
    const question = /[？?]|为什么|怎么|什么|哪/.test(ask);
    if (ctx.lock === 'history' && !question) {
      const [lon, lat] = farthestInland(ctx.world);
      const north = Math.min(80, lat + 7);
      const edits = [
        { op: 'lake', at: [lon, lat], size: '大', why: '离海最远的地方' },
        { op: 'range', path: [[lon - 9, north], [lon, north + 1], [lon + 9, north]], size: '中', why: '湖的北边,东西走向' },
      ];
      if (round === 0) return call('propose_edits', { edits });
      return say('在最大那块陆地离海最远的地方挖湖,北边拉一道山脉;这是固定的示例,不代表真实效果。');
    }
    if (!civ.viable || !civ.polities.length) return say('这颗星球没有长出文明,只能改地形;假 AI 不会改地形。');
    let id = namedPolity(civ, ask);
    if (id < 0) id = civ.polities.filter((p) => p.ended !== undefined).sort((a, b) => b.ended! - b.founded - (a.ended! - a.founded) || a.id - b.id)[0]?.id ?? 0;
    const p = civ.polities[id];
    const P = `P${id}`;
    const Y = Math.floor(Math.min(civ.endYear, Math.max(0, ctx.year)));
    // 问人物:查这国那一年的人物;问地形气候:查点了名的州(没点名就查这国的国土)
    if (question && tools.has('people') && /君主|皇帝|国王|在位|将领|名臣|人物/.test(ask)) {
      if (round === 0) return call('people', { country: P, year: Y });
      return say(`查了${nameAt(p, Y)}第 ${Y} 年的人物。这是一段固定的示例回答,不代表真实效果。`);
    }
    if (question && tools.has('land') && /海拔|气温|降水|物产|气候|多高|多冷|多热/.test(ask)) {
      const r = namedRegion(civ, ask);
      if (round === 0) return call('land', r >= 0 ? { region: `R${r}` } : { country: P, year: Y });
      return say(`查了${r >= 0 ? regionLabel(civ, r) : nameAt(p, Y)}的地形气候。这是一段固定的示例回答,不代表真实效果。`);
    }
    if (question) {
      if (round === 0) return call('country', { country: P });
      if (round === 1 && tools.has('show')) return call('show', { target: P });
      return say(`${nameAt(p, ctx.year)}第 ${Math.floor(p.founded)} 年立国,${endWords(civ, p)}。这是一段固定的示例回答,不代表真实效果。`);
    }
    if (/史/.test(ask) && tools.has('write_book')) {
      if (round === 0) return call('write_book', { scope: 'country', country: P, style: 'biography', length: 'k10' });
      return say('开始写了,写好会放进「成书」。');
    }
    if (/名/.test(ask) && tools.has('suggest_names')) {
      const city = civ.settlements.find((s) => [...s.name].length >= 2 && ask.includes(s.name));
      if (round === 0) return call('suggest_names', { target: city ? `C${city.id}` : P });
      return say('起了几个,挑一个点「就用这个」。');
    }
    // 要改:亡了的国家从亡国前 30 年起保护,再拉一个邻国结盟(分出来的国家先找原来的母国)
    const from = p.ended !== undefined ? Math.max(Math.ceil(p.founded), Math.floor(p.ended) - 30) : Math.max(Math.ceil(p.founded), Math.min(Math.floor(civ.endYear) - 1, Math.floor(ctx.year)));
    const own = ownersAt(civ, from).polity;
    const fall = civ.annals.find((e) => e.kind === 'fall' && e.a === id);
    const near = [...bordersAt(civ, own, id, from)].filter((q) => q !== fall?.b);
    const size = sizesAt(civ, from);
    const friend = p.parent !== undefined && near.includes(p.parent) ? p.parent : near.sort((a, b) => (size.get(b) ?? 0) - (size.get(a) ?? 0))[0];
    const protect = { op: 'protect', country: P, from, why: '国都攻不下,不会被灭' };
    const ally = friend !== undefined ? { op: 'ally', country: P, other: `P${friend}`, from, why: '找个帮手,免得腹背受敌' } : null;
    const steps: MockTurn[] = [
      call('country', { country: P }),
      call('situation', { year: from }),
      call('try_edits', { edits: [protect] }),
      ...(ally ? [call('try_edits', { edits: [protect, ally] })] : []),
      call('propose_edits', { edits: ally ? [protect, ally] : [protect], cannot: ['命令只能定下条件,不能直接规定国土有多大'] }),
    ];
    if (round < steps.length) return steps[round];
    return say('按固定的步骤试了几种改法,列出了最后一种;结果见下面,不代表真实效果。');
  };
}
