/**
 * 详情面板的公共零件:国家(CountryPanel)、城(CityPanel)、地理实体(PlacePanel)、州(RegionPanel)、信仰(FaithPanel)几种面板共用,
 * 保证它们看起来是同一套东西(样式都在 countryPanel.css)。
 *
 *   PanelHead    顶部:颜色块(或别的小图标)、名字、一行关键信息("国家，1446 年立国")、右上角圆形的关闭
 *   Acts / Act   名字下面一排图标按钮(第一个是主操作,蓝底);MoreAct = 最后一个"更多",点开一列菜单
 *   CenterAct    "设为中心"按钮:把地图的中央经线转到选中的东西
 *   Link         面板里可以点的名字(选中那个国家 / 城 / 州)
 *   Stats        "概况":一组圆角的行,左边名目、右边数值;children = 接在后面的行(Row)
 *   SegBar       分段色条(历任归属):按时长分段,点一段跳到它开始的那年;OwnerBar = 历任归属(城、州)
 *   Spark        小柱图(疆域、兴衰)
 *   EventList    大事(最近几条,点了跳到那一年、地图上闪出事发地;正文里的人名是蓝字,点了看这个人)
 *   EntryText    纪事正文,写到的人名变成能点的蓝字(编年史、大事、最近大事、人物卡片共用)
 *   Foot         底部按钮(干预页、立国 / 划给的表单页:返回、确定)
 *   YearStepper  生效年份:−100 −10 [年份] +10,下面一句"该年之前的历史不变,之后重新推演。"
 *   useRevealAi  名字由来 / AI 起名:内容在面板最下面,点了滚过去让它露出来
 */
import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode, type RefObject } from 'react';
import type { Civ } from '../gen/civ/types';
import type { Raster } from '../gen/raster';
import type { World } from '../gen/world';
import { nameAt } from './Interventions';
import type { OwnerSpan } from './panelData';
import type { ChronicleEntry } from '../gen/civ/story/chronicle';
import { clearSelection, pickChronicleEntry, setCivTime, setSelection, type MapSelection } from './civView';
import { useAiName, type AiName, type AiNameProps } from './AiNamePanel';
import { selectionLon } from './ProjectionPanel';
import { requestMapCenter } from './mapWrap';
import { evLabel, evText, evType } from './timelineLayout';
import { personMentions } from '../gen/civ/story/peopleInfo';
import { closeOverview } from './overviewStore';
import { Icon, type IconName } from './icons';
import { MenuItem, PopMenu } from './PopMenu';
import { useAiOn } from '../ai/client';
import { useEra } from './editsStore';
import { eraText, eraYear, worldYear, yearShort, yearSpan, type Era } from '../gen/era';
import './countryPanel.css';

/** 四种面板共同的参数 */
export interface DetailProps {
  /** 套上改名的 Civ(界面上显示的那一份) */
  civ: Civ;
  /** 没套改名的 Civ(恢复默认、AI 起名用) */
  raw: Civ;
  raster: Raster | null;
  world: World;
  id: number;
  /** 时间轴当前那一年(取整) */
  year: number;
  names: Record<string, string>;
}

/** 复制文字统一走 clipboard.ts(剪贴板接口不行时退回老办法,还会把焦点还回去) */
export { copyText } from './clipboard';

/** 时间轴跳到某一年(暂停) */
export const jumpTo = (y: number) => setCivTime({ year: y, playing: false, scrubbing: false, story: false });

export const rgb = (c: readonly number[]) => `rgb(${c.join(',')})`;
export const rgba = (c: readonly number[], a: number) => `rgba(${c.join(',')},${a})`;

/** 面板顶部:颜色块(或换成别的小图标 icon:国家卡片放国旗、作者标记放图钉)、名字(children 里的 NameEdit)和一行小字(SubLine),右上角圆形的关闭 */
export function PanelHead({ color, icon, children }: { color?: string; icon?: ReactNode; children?: ReactNode }) {
  return (
    <div className="cp-head">
      {icon ?? (color && <i className="cp-sw" style={{ background: color }} />)}
      <div className="cp-title">{children}</div>
      <button className="cp-x ins-close" onClick={clearSelection} title="关闭(Esc)" aria-label="关闭">
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}

/** 名字下面一排图标按钮 */
export function Acts({ children }: { children: ReactNode }) {
  return <div className="cp-acts">{children}</div>;
}

/** 一个图标按钮:图标在上、字在下;primary = 主操作(蓝底) */
export function Act({
  icon,
  children,
  primary,
  act,
  ain,
  disabled,
  pressed,
  title,
  onClick,
}: {
  icon: IconName;
  children: ReactNode;
  primary?: boolean;
  act?: string;
  /** 名字由来 / AI 起名的按钮(data-ain) */
  ain?: string;
  disabled?: boolean;
  /** 开关一类的按钮:按下了(人物卡的「关注他 / 不关注」);不给 = 不是开关 */
  pressed?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button className={`cp-act${primary ? ' primary' : ''}${pressed ? ' on' : ''}`} data-act={act} data-ain={ain} disabled={disabled} aria-pressed={pressed} title={title} onClick={onClick}>
      <Icon name={icon} size={19} />
      <span>{children}</span>
    </button>
  );
}

/** 最后一个按钮"更多":点开一列菜单(MenuItem) */
export function MoreAct({ children }: { children: ReactNode }) {
  return (
    <PopMenu className="cp-act" icon={<Icon name="more" size={19} />} label={<span>更多</span>} act="more" align="right" side title="更多操作">
      {children}
    </PopMenu>
  );
}

/** 面板里可以点的名字:选中那个国家 / 城 / 州 */
export function Link({ to, children }: { to: MapSelection; children: ReactNode }) {
  return (
    <button className="ins-link" onClick={() => setSelection(to)}>
      {children}
    </button>
  );
}

/** "设为中心"按钮:把地图的中央经线转到选中的东西(算不出位置时按钮不可点) */
export function CenterAct({ world, civ, sel, year }: { world: World; civ: Civ; sel: MapSelection; year: number }) {
  const lon = selectionLon(world, civ, sel, year);
  return (
    <Act icon="center" act="set-center" disabled={lon === null} title="把地图转到以它为中心" onClick={() => lon !== null && requestMapCenter(lon)}>
      设为中心
    </Act>
  );
}

/** "更多"菜单里的"设为中心"(按钮放不下时用) */
export function CenterItem({ world, civ, sel, year }: { world: World; civ: Civ; sel: MapSelection; year: number }) {
  const lon = selectionLon(world, civ, sel, year);
  return (
    <MenuItem icon={<Icon name="center" size={16} />} act="set-center" disabled={lon === null} onClick={() => lon !== null && requestMapCenter(lon)}>
      设为中心
    </MenuItem>
  );
}

/** 一行关键信息:几段用"，"连起来(空的段不写) */
export function SubLine({ parts, className }: { parts: ReactNode[]; className?: string }) {
  const shown = parts.filter((x) => x !== null && x !== undefined && x !== false && x !== '');
  return (
    <div className={`cp-sub${className ? ` ${className}` : ''}`}>
      {shown.map((x, i) => (
        <span key={i}>
          {i > 0 && '，'}
          {x}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 概况

export interface Stat {
  k: string;
  v: ReactNode;
  /** 数字后面的小字("富饶") */
  note?: ReactNode;
  title?: string;
}

/** 一组圆角的行:左边名目、右边数值;title = 上面的小标题;more = 小标题右边的链接;lead = 排在最前面的行(Row);children = 接在后面的行(Row) */
export function Stats({ items, title = '概况', more, lead, children }: { items: Stat[]; title?: string; more?: ReactNode; lead?: ReactNode; children?: ReactNode }) {
  return (
    <section className="cp-sec">
      {title && !more && <div className="cp-sec-head">{title}</div>}
      {title && more && (
        <div className="cp-sec-head cp-events-head">
          <span>{title}</span>
          {more}
        </div>
      )}
      <div className="cp-grid cp-stats">
        {lead}
        {items.map((s, i) => (
          <Row key={i} k={s.k} stat title={s.title}>
            {s.v}
            {s.note && <em className="cp-num-note">{s.note}</em>}
          </Row>
        ))}
        {children}
      </div>
    </section>
  );
}

/** 概况里的一行(两格:名目、数值;放在 .cp-grid 里) */
export function Row({ k, children, className, stat, title }: { k: string; children: ReactNode; className?: string; stat?: boolean; title?: string }) {
  return (
    <>
      <span className="cp-k">{k}</span>
      <span className={`cp-v${stat ? ' cp-stat' : ''}${className ? ` ${className}` : ''}`} data-stat={stat ? k : undefined} title={title}>
        {children}
      </span>
    </>
  );
}

// ---------------------------------------------------------------------------
// 分段色条

export interface Seg {
  name: string;
  /** 占整条的比例(0..1) */
  frac: number;
  background: string;
  on: boolean;
  title: string;
  /** 没人的一段(无主):不写字、不可点 */
  blank?: boolean;
  /** 中立地的一段:几国颜色的细横纹(background),淡一点 */
  zone?: boolean;
  onClick?: () => void;
}

/** 分段色条(朝代、历任归属):上面一行小字标题,下面两头的年份 */
export function SegBar({ label, segs, years, className }: { label: string; segs: Seg[]; years: [number, number]; className?: string }) {
  const era = useEra();
  return (
    <div className={`cp-dyn${className ? ` ${className}` : ''}`}>
      <span className="cp-sec-head">{label}</span>
      <div className="cp-dyn-bar">
        {segs.map((s, i) => (
          <button
            key={i}
            className={`cp-seg${s.on ? ' on' : ''}${s.blank ? ' blank' : ''}${s.zone ? ' zone' : ''}`}
            style={{ width: `${s.frac * 100}%`, background: s.background }}
            title={s.title}
            disabled={s.blank}
            onClick={s.onClick}
          >
            {s.blank ? '' : s.name}
          </button>
        ))}
      </div>
      <div className="cp-dyn-years">
        <span>{yearShort(years[0], era)}</span>
        <span>{yearShort(years[1], era)}</span>
      </div>
    </div>
  );
}

/** 色条大约多宽(面板 340 减去两边的内边距) */
const OWNER_BAR_W = 300;

/** 历任归属里中立地的那几年:几国颜色的细横纹(background) */
export interface ZoneSpan {
  from: number;
  to: number;
  background: string;
}

/** 无主的几段按中立地的年份切开:中立地那几年单独一段(zone) */
function splitZones(spans: readonly OwnerSpan[], zones: readonly ZoneSpan[]): (OwnerSpan & { zone?: ZoneSpan })[] {
  if (!zones.length) return spans.slice();
  const out: (OwnerSpan & { zone?: ZoneSpan })[] = [];
  for (const s of spans) {
    if (s.polity >= 0) {
      out.push(s);
      continue;
    }
    let at = s.from;
    for (const z of zones) {
      const a = Math.max(at, z.from);
      const b = Math.min(s.to, z.to);
      if (b <= a) continue;
      if (a > at) out.push({ from: at, to: a, polity: -1 });
      out.push({ from: a, to: b, polity: -1, zone: z });
      at = b;
    }
    if (s.to > at) out.push({ from: at, to: s.to, polity: -1 });
  }
  return out;
}

/** 历任归属(城、州):每段一个国家的颜色,当年那一段实色;无主的一段留空;做过中立地的那几年画几国颜色的细横纹(zones)。spans 空 = 不显示 */
export function OwnerBar({ civ, spans: raw, year, label = '历任归属', zones = [] }: { civ: Civ; spans: readonly OwnerSpan[]; year: number; label?: string; zones?: readonly ZoneSpan[] }) {
  const era = useEra();
  if (!raw.length) return null;
  const spans = splitZones(raw, zones);
  const from = spans[0].from;
  const to = spans[spans.length - 1].to;
  const total = Math.max(1e-6, to - from);
  const segs: Seg[] = spans.map((s, i) => {
    const frac = (s.to - s.from) / total;
    const P = civ.polities[s.polity];
    const years = yearSpan(s.from, s.to, era);
    if (s.zone)
      return {
        name: '',
        frac,
        background: s.zone.background,
        on: year >= s.from && year < s.to,
        title: `中立地 · ${years}`,
        zone: true,
        onClick: () => jumpTo(Math.ceil(s.from)),
      };
    if (!P) return { name: '', frac, background: 'var(--btn)', on: false, title: `无主 · ${years}`, blank: true };
    const on = year >= s.from && (year < s.to || (i === spans.length - 1 && year >= to));
    const name = nameAt(P, Math.max(s.from, Math.min(year, s.to - 1 / 512)));
    // 放不下整个国名的一段不写字(悬停提示里有)
    const fits = frac * OWNER_BAR_W >= name.length * 12 + 10;
    return {
      name: fits ? name : '',
      frac,
      background: on ? rgb(P.color) : rgba(P.color, 0.4),
      on,
      title: `${name} · ${years}`,
      onClick: () => jumpTo(Math.ceil(s.from)),
    };
  });
  return <SegBar label={label} segs={segs} years={[from, to]} className="cp-owners" />;
}

// ---------------------------------------------------------------------------
// 小柱图

export interface Bar {
  /** 高度(像素) */
  h: number;
  background: string;
  opacity: number;
  title?: string;
  onClick?: () => void;
}

/** 小柱图:fill = 柱子按宽度均分(兴衰);不给 = 每根 10 像素(疆域) */
export function Spark({ bars, title, fill }: { bars: Bar[]; title?: string; fill?: boolean }) {
  return (
    <span className={`cp-spark${fill ? ' fill' : ''}`} title={title}>
      {bars.map((b, i) =>
        b.onClick ? (
          <button key={i} className="cp-bar" title={b.title} onClick={b.onClick}>
            <i style={{ height: `${b.h}px`, background: b.background, opacity: b.opacity }} />
          </button>
        ) : (
          <i key={i} style={{ height: `${b.h}px`, background: b.background, opacity: b.opacity }} />
        ),
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 相关事件

/** 选中一个人(人物卡片);世界概览开着就收起 */
export function selectPerson(id: number) {
  closeOverview();
  setSelection({ kind: 'person', id });
}

/**
 * 纪事正文:写到的人名变成蓝字,点了看这个人(不触发整行的点击:整行还是跳到那一年);self = 不变蓝的那个人(他自己的卡片里)。
 * 一行本身是按钮,蓝字不能再是按钮:用 span + 点击。still = 只变蓝、不能单独点(点了算点整行)
 */
export function EntryText({ civ, e, self = -1, still }: { civ?: Civ; e: Pick<ChronicleEntry, 'text' | 'people' | 'year'>; self?: number; still?: boolean }) {
  const text = eraText(evText(e), useEra());
  if (!civ || !e.people?.length) return <>{text}</>;
  return (
    <>
      {personMentions(civ, text, e.people, self, e.year).map((m, i) =>
        m.person === undefined ? (
          m.text
        ) : still ? (
          <span key={i} className="pp-name">
            {m.text}
          </span>
        ) : (
          <span
            key={i}
            className="pp-name"
            data-person={m.person}
            title="看这个人"
            onClick={(ev) => {
              ev.stopPropagation();
              selectPerson(m.person!);
            }}
          >
            {m.text}
          </span>
        ),
      )}
    </>
  );
}

/**
 * 大事:upTo = 到当前年份为止的(按年份排好),显示最近 limit 条(默认 5 条,新的在上)。
 * more = 标题右边的"全部 N 件"(不给 = 只写条数);empty = 一条都没有时写的一行(不给 = 整块不显示);
 * civ = 正文里的人名变成蓝字(不给 = 纯文字);title = 标题(默认"大事");limit = 最多列几条;self = 人物卡片里他自己(名字不变蓝)
 */
export function EventList({
  upTo,
  more,
  empty,
  civ,
  title = '大事',
  limit = 5,
  self,
  keep,
}: {
  upTo: readonly ChronicleEntry[];
  more?: ReactNode;
  empty?: string;
  civ?: Civ;
  title?: string;
  limit?: number;
  self?: number;
  /** 点一条时留着哪种填色(民族卡片:正在民族填色上就不换成国家,见 pickChronicleEntry) */
  keep?: 'cultures';
}) {
  const era = useEra();
  if (!upTo.length && empty === undefined) return null;
  const recent = upTo.slice(-limit).reverse();
  return (
    <section className="cp-sec cp-events">
      <div className="cp-sec-head cp-events-head">
        <span>{title}</span>
        {more || (upTo.length > 0 && <span className="cp-count">{upTo.length} 件</span>)}
      </div>
      <div className="cp-group">
        {recent.map((e: ChronicleEntry) => (
          <button key={`${e.kind}:${e.id}`} className="cp-ev" data-ev={evType(e)} title={evLabel(e)} onClick={() => pickChronicleEntry(e, keep)}>
            <span className={`cp-ev-year${era ? ' era' : ''}`}>{yearShort(e.year, era)}</span>
            <span className="cp-ev-text">
              <EntryText civ={civ} e={e} self={self} />
            </span>
          </button>
        ))}
        {!recent.length && <span className="cp-none">{empty}</span>}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 底部按钮(干预页、表单页)

export function Foot({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) {
  return <div className={`cp-foot ${cols === 3 ? 'cp-grid3' : 'cp-grid2'}`}>{children}</div>;
}

// ---------------------------------------------------------------------------
// 生效年份

/** 输入框里只留数字:第几年最多 5 位;纪年的年数最多 6 位(第 0 年定得很晚时,后面的年份能写到十几万) */
const digits = (s: string, era?: Era) => s.replace(/[^\d]/g, '').slice(0, era ? 6 : 5);

export interface YearInput {
  /** 输入框里的字(设了纪年 = 纪年的年数) */
  text: string;
  /** 设了纪年:输入框前面那个小按钮是不是"名字前" */
  pre: boolean;
  /** 设了纪年 = 那个纪年 */
  era?: Era;
  /** 改输入框(算"改过":清掉上一次的提示) */
  setText: (s: string) => void;
  /** 点输入框前面的"公元前 ⌄":前 / 后换一下,数字不动 */
  flipPre: () => void;
  /** 失焦时整理成合格的年份 */
  tidy: () => void;
  /** 生效年份,第几年(输入不合格时 = 夹到范围里的值) */
  y: number;
  valid: boolean;
  lo: number;
  hi: number;
  nudge: (d: number) => void;
}

/** 第 y 年在输入框里怎么写:设了纪年写纪年的年数和"前"不"前" */
function shownYear(y: number, era: Era | undefined): { text: string; pre: boolean } {
  if (!era) return { text: String(y), pre: false };
  const { pre, n } = eraYear(y, era);
  return { text: String(n), pre };
}

/**
 * 生效年份的输入状态:初值 = 夹到 [lo, hi] 里的 initial;onChange = 改过(清掉上一次的提示)。
 * 设了纪年时填的是纪年的年数(前面的小按钮管"前"不"前"),−100 / −10 / +10 走过元年时小按钮跟着变
 */
export function useYearInput(initial: number, lo: number, hi: number, onChange?: () => void): YearInput {
  const era = useEra();
  const clampY = (v: number) => Math.min(hi, Math.max(lo, Math.round(v)));
  const [st, setSt] = useState(() => ({ era, ...shownYear(clampY(initial), era) }));
  const typed = st.text.trim() === '' ? NaN : Number(st.text);
  // 框里的字按填的时候的纪年算(纪年刚在别处改了,字还是旧的写法);纪年没有 0 年
  const was = st.era;
  const want = !Number.isFinite(typed) ? NaN : was ? (typed < 1 ? NaN : worldYear(st.pre, typed, was)) : typed;
  const valid = Number.isFinite(want) && want >= lo && want <= hi;
  const y = valid ? Math.floor(want) : clampY(Number.isFinite(want) ? want : was ? worldYear(st.pre, 1, was) : lo);
  // 纪年在别处改了:按刚才的年份重写输入框
  if (st.era !== era) setSt({ era, ...shownYear(y, era) });
  const put = (text: string, pre: boolean) => {
    setSt({ era, text, pre });
    onChange?.();
  };
  return {
    text: st.text,
    pre: st.pre,
    era,
    setText: (s) => put(s, st.pre),
    flipPre: () => put(st.text, !st.pre),
    tidy: () => setSt({ era, ...shownYear(y, era) }),
    y,
    valid,
    lo,
    hi,
    nudge: (d) => {
      const v = shownYear(clampY(y + d), era);
      put(v.text, v.pre);
    },
  };
}

/** 生效年份:−100 −10 [年份] +10,下面一句说明;then = 第二行(那一年它叫什么,和现在不一样时才给) */
export function YearStepper({ yi, then }: { yi: YearInput; then?: string }) {
  return (
    <div className="cp-from">
      <span className="cp-k">生效年份</span>
      <YearRow yi={yi} label="生效年份" />
      <span className="cp-note">
        该年之前的历史不变,之后重新推演。
        {then && (
          <>
            <br />
            {then}
          </>
        )}
      </span>
    </div>
  );
}

/** 一行年份步进:−100 −10 [年份] +10(wide 再多一个 +100;short = 不要 −100);label = 输入框的无障碍名;after = 最后接一句小字 */
export function YearRow({ yi, label, wide, short, after }: { yi: YearInput; label: string; wide?: boolean; short?: boolean; after?: ReactNode }) {
  const { text, pre, era, setText, flipPre, tidy, y, lo, hi, nudge } = yi;
  const id = useId();
  return (
    <div className="cp-from-row">
      {!short && (
        <button className="cp-step" onClick={() => nudge(-100)} disabled={y <= lo}>
          −100
        </button>
      )}
      <button className="cp-step" onClick={() => nudge(-10)} disabled={y <= lo}>
        −10
      </button>
      <label className="cp-year" htmlFor={id}>
        {era && <EraPre era={era} pre={pre} onFlip={flipPre} />}
        <input
          id={id}
          value={text}
          inputMode="numeric"
          aria-label={label}
          onChange={(e) => setText(digits(e.target.value, era))}
          onBlur={tidy}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          style={{ width: `${Math.max(2, text.length) + 0.6}ch` }}
        />
        年
      </label>
      <button className="cp-step" onClick={() => nudge(10)} disabled={y >= hi}>
        +10
      </button>
      {wide && (
        <button className="cp-step" onClick={() => nudge(100)} disabled={y >= hi}>
          +100
        </button>
      )}
      {after}
    </div>
  );
}

/** 年份输入框前面的「公元前 ⌄」(设了纪年才有):点了"前"和"后"换一下,数字不动 */
export function EraPre({ era, pre, onFlip }: { era: Era; pre: boolean; onFlip: () => void }) {
  return (
    <button className="era-pre" type="button" data-act="year-pre" title={`换成${pre ? era.name : `${era.name}前`}`} onClick={onFlip}>
      {era.name}
      {pre ? '前' : ''}
      <Icon name="down" size={12} />
    </button>
  );
}

/** 输入框里的字 → 第几年的字:空 = '';纪年没有的 0 年 = 'x'(存不了) */
function worldText(text: string, pre: boolean, era: Era): string {
  if (!text) return '';
  const n = Number(text);
  return n < 1 ? 'x' : String(worldYear(pre, n, era));
}

/**
 * 填年份的一格(人物的生卒、经历,标记的起止):value / onChange 是第几年的字('' = 空着;可能是负数 —— 纪年填到了第 0 年以前)。
 * 没设纪年时就是一个只能填数字的框;设了纪年,框里填纪年的年数,前面一个「公元前 ⌄」。near = 空着时"前"不"前"按哪一年算
 */
export function EraYearInput({
  value,
  onChange,
  near,
  ...rest
}: { value: string; onChange: (text: string) => void; near: number } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'id'>) {
  const era = useEra();
  const id = useId();
  const [st, setSt] = useState<{ v: string; era?: Era; text: string; pre: boolean } | null>(null);
  let cur = st;
  // 第一次、值在别处变了(「用公元前 850 年」)、纪年换了:照值重写框里的字
  if (era && (!cur || cur.v !== value || cur.era !== era)) {
    const w = /^-?\d+$/.test(value.trim()) ? Number(value) : null;
    const { pre, n } = eraYear(w ?? near, era);
    cur = { v: value, era, text: w === null ? (value.trim() ? (cur?.text ?? '') : '') : String(n), pre: w === null && cur ? cur.pre : pre };
  }
  const put = (text: string, pre: boolean) => {
    const v = worldText(text, pre, era!);
    setSt({ v, era, text, pre });
    onChange(v);
  };
  return (
    <label className="cp-year" htmlFor={id}>
      {era && cur && <EraPre era={era} pre={cur.pre} onFlip={() => put(cur!.text, !cur!.pre)} />}
      <input
        {...rest}
        id={id}
        value={era && cur ? cur.text : value}
        inputMode="numeric"
        onChange={(e) => (era && cur ? put(digits(e.target.value, era), cur.pre) : onChange(digits(e.target.value)))}
      />
      年
    </label>
  );
}

// ---------------------------------------------------------------------------
// 名字由来 / AI 起名

/**
 * useAiName + "点了滚过去":底部"名字由来"、改名时的"AI 起名"打开的内容在面板最下面(AiBox),
 * 点了以后滚过去让它露出来
 */
export function useRevealAi(props: AiNameProps): { ai: AiName; aiRef: RefObject<HTMLDivElement> } {
  const ai0 = useAiName(props);
  const aiRef = useRef<HTMLDivElement>(null);
  const [reveal, setReveal] = useState(0);
  useEffect(() => {
    if (reveal) aiRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [reveal]);
  const ai: AiName = {
    ...ai0,
    ask: () => {
      ai0.ask();
      setReveal((n) => n + 1);
    },
    suggest: () => {
      ai0.suggest();
      setReveal((n) => n + 1);
    },
    suggestNow: () => {
      ai0.suggestNow();
      setReveal((n) => n + 1);
    },
  };
  return { ai, aiRef };
}

/** 名字由来 / AI 起名的内容(面板最下面) */
export function AiBox({ ai, aiRef }: { ai: AiName; aiRef: RefObject<HTMLDivElement> }) {
  if (!ai.panel) return null;
  return (
    <div className="cp-ai" ref={aiRef}>
      {ai.panel}
    </div>
  );
}

/** 改名时输入框下面的"AI 起名"(「使用 AI 功能」关着时没有) */
export function AiSuggestLink({ ai }: { ai: AiName }) {
  if (!useAiOn()) return null;
  return (
    <div className="cp-rename-more">
      <button className="ins-link" data-ain="suggest" onMouseDown={(e) => e.preventDefault()} onClick={ai.suggest}>
        AI 起名
      </button>
    </div>
  );
}
