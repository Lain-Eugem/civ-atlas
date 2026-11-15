/**
 * 时间轴的轨道:1px 基线、每 100 年一格刻度(500、1000 年加长)、0 / 1000 / 2000 / 3000 年的字(推得更久的世界放大格子;
 * 设了纪年对准元年写"前2000""元年",见 timelineLayout.ts 的 rulerOf)、
 * 事件菱形(颜色按事件类型)、干预的红线加"令"字、地形大事的红线加"变"字、进度和播放头(按父元素的 CSS 变量 --p 画)。
 * 怎么排、太密怎么合并见 timelineLayout.ts。
 *
 * - 拖动 / 点空处:时间轴跳到那一年(暂停)。点菱形或"令""变":和在编年史里点那一条一样(civView.ts 的 pickChronicleEntry:
 *   跳到那一年、地图上闪出事发地、必要时平移地图)。
 * - 悬停菱形出提示(类型、年份、纪事);挤在一起合并成的菱形,提示里列出每一件(不限件数,太长了提示里往下滚),点哪一行就跳到哪一件;
 *   大崩解那一条底下一国一行列出分出来的国家。单独一件地形大事的"变":提示是两行(第一行"1600 年 · 地形大事",第二行纪事)。
 *   宽屏上用手指点一下:跳过去,同时弹出提示,约三秒后收起。
 * - 手机(small):点一下不跳年份,胶囊上面升起一张卡片列出这一处的每一件(能往下滑);点卡片里的一行才跳到那一年、地图上闪出事发地;
 *   点 ×、点地图(这一下不再当成地图上的单击)、拖时间轴收起。
 * - 合并进来的几件里有新国家立起来(立国、自立、复国、大崩解分出来的、饥民起事立的),点本身的颜色又不是立国的:上面叠一颗小绿点。
 * - 选中了国家(life):从它立国到亡(还在 = 到头)铺一道它的国色,立国那头一颗绿点;宽屏写"2391 立国""2837 亡";
 *   改制改了国号的那几年一颗蓝点,宽屏写"2794 改称共和国"(和立国、亡的字挤着就不写;悬停、点它就是底下那颗事件的点);和它无关的圆点变淡,
 *   这时不叠小绿点(它的立国已经有一颗大绿点,别的点里叠的是别国的立国)。
 * - 键盘:← → 前后 10 年(按住 Shift 100 年),Home / End 到头 / 到尾。
 * - 只在换世界 / 换筛选 / 轨道宽度变了时重排。
 * - 大纲的情节(OutlineMap.tsx 的 PlotTicks):基线上每条一颗小菱形,颜色按批改的章;悬停出小卡,点一下 = 在大纲里点那一条。
 * - 全球大疫(pandemics):起疫那一条的点画成深色大点,宽屏底下写"克尔顿大疫";疫后凋敝那几十年基线底下一道灰褐短条。
 * - 再推 N 年(ExtendYears.tsx):推的时候(grow)轨道按推完的长度排,新的一段推好了的浅蓝、没推到的虚线,上面一行字;
 *   这时只能拖到推之前的结束年份(limit)。推完以后刚推的那段(fresh)底下垫一道浅蓝、起点一条细线。
 */
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { entryInvolves, type ChronicleEntry } from '../gen/civ/story/chronicle';
import { eraText, yearAt, yearFull, yearShort, yearSpanAt, type Era } from '../gen/era';
import { useMonthNames, useMonths } from './editsStore';
import { getCivTime, pickChronicleEntry, setCivTime, stepYear } from './civView';
import {
  LIFE_FONT,
  LIFE_PAD,
  evLabel,
  evText,
  evType,
  evYears,
  hidesFounding,
  hitDiamonds,
  layoutDiamonds,
  lifeLabels,
  rulerLabel,
  rulerOf,
  textWidth,
  timeScale,
  type Diamond,
} from './timelineLayout';
import { openOverview } from './overviewStore';
import { noteDismiss } from './dismissClick';
import { Icon } from './icons';
import { PlotTicks, type PlotTick } from './OutlineMap';

/** 提示最高多少(像素,约 8 行;再多在提示里往下滚) */
const TIP_MAX_H = 300;
/** 手机卡片里列表最高多少(像素;胶囊上面放不下时再矮一些,至少 LIST_MIN_H) */
const LIST_MAX_H = 352;
const LIST_MIN_H = 120;
/** 手机卡片离胶囊、离屏幕两边多远(像素) */
const CARD_GAP = 5;
const CARD_SIDE = 8;
/** 指针在这条线以上(像素,轨道里)按下才算点菱形 / "令";以下是拖动年份 */
const MARK_ROW = 22;
/** 按下后移动超过这么多(像素)算拖动 */
const DRAG_SLOP = 3;

/** 提示 / 手机卡片里能点的一行:也让键盘 Tab 到得了、能用回车 / 空格点(时间轴上的东西不能只认鼠标) */
function rowKey() {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        // 走元素自己的 onClick:和鼠标点同一条路,不用再写一遍
        (e.currentTarget as HTMLElement).click();
      }
    },
  };
}

/** 导出回放视频时:时间轴上选的一段(两头的把手拖着改) */
export interface TimelineRange {
  from: number;
  to: number;
  onRange: (from: number, to: number) => void;
  /** 把手底下写起止年份(手机上:刻度字不写,只写这两个) */
  labels?: boolean;
  /** 正在导出:不能拖 */
  locked?: boolean;
}

/** 选的那一段的框比两头的年份各宽出这么多(把手的宽度) */
const RANGE_PAD = 11;
const RANGE_PAD_SMALL = 8;
/** 拖把手时一段至少这么多年 */
const RANGE_MIN = 10;

export interface TimelineMarksProps {
  /** 要画的纪事(按年份排好;已经按"大事"和国家筛过) */
  entries: readonly ChronicleEntry[];
  end: number;
  /** 时间轴在地图底部(提示朝上弹)还是顶部(提示朝下弹) */
  dock: 'top' | 'bottom' | 'inline';
  /** 当前年份(取整;读屏用) */
  year: number;
  /** 纪年(没设 = 按第几年写) */
  era?: Era;
  /** 导出回放视频时选的一段 */
  range?: TimelineRange;
  /** 手机上的小号:把手窄一点;点圆点先列出卡片、不跳年份;选中国家时两头不写字 */
  small?: boolean;
  /** 最多拖到哪一年(再推的时候 = 推之前的结束年份;不给 = end) */
  limit?: number;
  /** 正在再推:新的一段从第 from 年起,推演推到第 at 年(还没回报 = null);note = 上面那行字(不给 = 不写) */
  grow?: { from: number; at: number | null; note?: ReactNode };
  /** 刚推的那段从第几年起(垫一道浅蓝、起点一条细线;不给 = 不标) */
  fresh?: number;
  /** 推不下去,历史停在这一年:以后的轨道灰着、这一年一道红线(不给 = 推完了) */
  stuck?: number;
  /** 选中的国家:标出它的一生(不给 = 没选国家) */
  life?: TimelineLife;
  /** 大纲的情节:压在基线上的记号(不给 = 没有大纲) */
  plots?: readonly PlotTick[];
  /** 起过的全球大疫:起疫那年的点画成深色大点,底下写名字;凋敝的那几十年基线底下一道灰褐短条(不给 = 没有) */
  pandemics?: readonly TimelinePandemic[];
}

/** 一场全球大疫:哪年起、凋敝到哪年、叫什么("克尔顿大疫") */
export interface TimelinePandemic {
  year: number;
  end: number;
  name: string;
}

/** 全球大疫名字的字号(像素);离刻度的字至少这么远(像素)才写 */
const PAN_FONT = 11;
const PAN_GAP = 6;

/** 选中的国家:哪一国、哪年立国、哪年亡(还在 = null)、国色;改制改了国号的那几年(废君、革命改共和,复辟复称旧国号)和一句 */
export interface TimelineLife {
  polity: number;
  founded: number;
  ended: number | null;
  color: readonly [number, number, number];
  renames?: readonly { year: number; text: string }[];
}

/** 改国号那几年的字离别的字至少这么远(像素) */
const RENAME_GAP = 6;

/** 一行字(x 处、靠左 / 居中 / 靠右)占的横向范围 */
function spanOf(x: number, align: 'start' | 'mid' | 'end', w: number): [number, number] {
  return align === 'start' ? [x, x + w] : align === 'end' ? [x - w, x] : [x - w / 2, x + w / 2];
}

/** 正在再推那段上面的字:离轨道两头至少这么远(像素) */
const NOTE_PAD = 2;

type Tip = Diamond & { pinned?: boolean };

export const TimelineMarks = memo(function TimelineMarks({ entries, end, dock, year, era, range, small, limit, grow, fresh, stuck, life, plots, pandemics }: TimelineMarksProps) {
  const ref = useRef<HTMLDivElement>(null);
  const months = useMonths();
  const monthNames = useMonthNames();
  const tipRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [tip, setTip] = useState<Tip | null>(null);
  // 手机:点开的那一处(卡片)、卡片里点过的那一行
  const [card, setCard] = useState<Diamond | null>(null);
  const [picked, setPicked] = useState<ChronicleEntry | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [listMore, setListMore] = useState(false);
  const [listEnd, setListEnd] = useState(false);
  const hideTimer = useRef(0);
  const press = useRef<{ x: number; id: number; hit: Diamond | null; drag: boolean; touch: boolean; handle?: 'from' | 'to' } | null>(null);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const pad = small ? RANGE_PAD_SMALL : RANGE_PAD;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = useMemo(() => layoutDiamonds(entries, end, width), [entries, end, width]);

  // 换世界 / 换筛选:收起提示、卡片
  useEffect(() => {
    setTip(null);
    setCard(null);
  }, [layout]);
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  // 提示放在时间轴外面(底部时朝上、顶部时朝下),左右不出地图;件数多了不高过 TIP_MAX_H,也不出地图(在提示里往下滚)
  useLayoutEffect(() => {
    const el = tipRef.current;
    const track = ref.current;
    if (!el || !track || !tip) return;
    const bar = (track.closest('.timebar') ?? track).getBoundingClientRect();
    const stage = (track.closest('.stage') ?? document.body).getBoundingClientRect();
    const L = track.getBoundingClientRect();
    if (el.classList.contains('tb-tip')) {
      const room = dock === 'top' ? stage.bottom - 8 - bar.bottom - 6 : bar.top - 6 - stage.top - 8;
      el.style.maxHeight = `${Math.max(120, Math.min(TIP_MAX_H, room))}px`;
      el.scrollTop = 0;
    }
    const r = el.getBoundingClientRect();
    // 地形大事的小提示贴着「变」字:从它左边一点起,紧挨在它上面(顶部时在下面)
    const mark = el.classList.contains('up-tip') ? track.querySelector('.up-mark.on')?.getBoundingClientRect() : undefined;
    const left = Math.max(stage.left + 8, Math.min(stage.right - 8 - r.width, mark ? mark.left - 20 : L.left + tip.x - r.width / 2));
    const top = mark ? (dock === 'top' ? mark.bottom + 10 : mark.top - 10 - r.height) : dock === 'top' ? bar.bottom + 6 : bar.top - 6 - r.height;
    el.style.left = `${left - L.left}px`;
    el.style.top = `${top - L.top}px`;
    el.style.visibility = 'visible';
  }, [tip, dock]);

  // 手机卡片:比胶囊左右各宽一点,底边贴着胶囊上沿;列表最高 LIST_MAX_H,往上不超过右上角那一列按钮的顶(没有就离屏幕顶 12 像素)
  useLayoutEffect(() => {
    const el = cardRef.current;
    const list = listRef.current;
    const track = ref.current;
    if (!el || !list || !track || !card) return;
    const place = () => {
      const bar = (track.closest('.timebar') ?? track).getBoundingClientRect();
      const app = track.closest('.app');
      const btns = app?.querySelector('.phone-btns')?.getBoundingClientRect();
      const top0 = btns && btns.height > 0 ? btns.top : (app ?? document.body).getBoundingClientRect().top + 12;
      const L = track.getBoundingClientRect();
      list.style.maxHeight = '';
      const rest = el.offsetHeight - list.offsetHeight;
      list.style.maxHeight = `${Math.max(LIST_MIN_H, Math.min(LIST_MAX_H, bar.top - CARD_GAP - top0 - rest))}px`;
      el.style.left = `${bar.left - (CARD_SIDE - 4) - L.left}px`;
      el.style.width = `${bar.width + (CARD_SIDE - 4) * 2}px`;
      el.style.top = `${bar.top - CARD_GAP - el.offsetHeight - L.top}px`;
      el.style.visibility = 'visible';
      setListMore(list.scrollHeight > list.clientHeight + 1);
    };
    list.scrollTop = 0;
    setListEnd(false);
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [card]);

  // 手机卡片开着:点卡片和时间轴以外的地方(地图、别的按钮)收起;按在地图上的这一下只收起卡片,不再当成地图上的单击
  useEffect(() => {
    if (!card) return;
    const down = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      noteDismiss(e);
      setCard(null);
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [card]);

  const keep = () => clearTimeout(hideTimer.current);
  const hideSoon = (ms: number) => {
    clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setTip(null), ms);
  };
  const localX = (cx: number) => cx - ref.current!.getBoundingClientRect().left;
  const yearAt = (cx: number) => Math.round(Math.min(1, Math.max(0, localX(cx) / Math.max(1, width))) * end);
  // 导出回放视频时只在选的那一段里拖;再推的时候拖到推之前的结束年份为止(新的一段推好以前进不去)
  const top = limit ?? end;
  const clampYear = (y: number) => (range ? Math.min(range.to, Math.max(range.from, y)) : Math.min(top, y));
  const scrub = (cx: number) => setCivTime({ year: clampYear(yearAt(cx)), playing: false, story: false, scrubbing: true });
  /** 按在哪个把手上(框两头各 pad 宽,左右各多认几像素) */
  const handleAt = (lx: number): 'from' | 'to' | undefined => {
    if (!range || range.locked || !width) return undefined;
    const xf = (range.from / end) * width - pad / 2;
    const xt = (range.to / end) * width + pad / 2;
    const df = Math.abs(lx - xf);
    const dt = Math.abs(lx - xt);
    const near = pad / 2 + 6;
    if (df <= near && (df <= dt || dt > near)) return 'from';
    if (dt <= near) return 'to';
    return undefined;
  };
  const dragHandle = (h: 'from' | 'to', cx: number) => {
    const r = rangeRef.current;
    if (!r) return;
    const y = yearAt(cx);
    const min = Math.min(RANGE_MIN, Math.max(1, Math.floor(end / 10)));
    if (h === 'from') r.onRange(Math.max(0, Math.min(y, r.to - min)), r.to);
    else r.onRange(r.from, Math.min(end, Math.max(y, r.from + min)));
  };
  const inTip = (e: React.SyntheticEvent) => !!tipRef.current?.contains(e.target as Node) || !!cardRef.current?.contains(e.target as Node);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || inTip(e) || range?.locked) return;
    // 大纲情节的记号:点它自己(OutlineMap.tsx),不拖年份
    if ((e.target as Element).closest?.('.ol-tick')) return;
    const r = ref.current!.getBoundingClientRect();
    const handle = handleAt(e.clientX - r.left);
    const hit = !handle && !range && e.clientY - r.top < MARK_ROW ? hitDiamonds(layout, e.clientX - r.left) : null;
    press.current = { x: e.clientX, id: e.pointerId, hit, drag: false, touch: e.pointerType === 'touch', handle };
    // 拖出轨道也接着认(合成的指针事件没有真的指针,捕获会报错,不要紧)
    try {
      ref.current!.setPointerCapture(e.pointerId);
    } catch {
      /* 没有这个指针 */
    }
    if (handle) setTip(null);
    else if (!hit) {
      setCard(null);
      scrub(e.clientX);
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const pr = press.current;
    if (pr && pr.id === e.pointerId) {
      if (!pr.drag && Math.abs(e.clientX - pr.x) > DRAG_SLOP) pr.drag = true;
      if (pr.handle) {
        if (pr.drag) dragHandle(pr.handle, e.clientX);
        return;
      }
      if (pr.drag || !pr.hit) {
        setTip(null);
        setCard(null);
        scrub(e.clientX);
      }
      return;
    }
    if (inTip(e)) return keep();
    // 指着大纲情节的记号:它自己出小卡,纪事的提示收起
    if ((e.target as Element).closest?.('.ol-tick')) {
      if (tip && !tip.pinned) setTip(null);
      return;
    }
    // 手机上不悬停(点了出卡片)
    if (e.pointerType === 'touch' || range || small) return;
    const h = hitDiamonds(layout, localX(e.clientX));
    if (h) {
      keep();
      setTip((t) => (t && t.lead === h.lead && t.x === h.x ? t : h));
    } else if (tip && !tip.pinned) hideSoon(180);
  };
  const onUp = (e: React.PointerEvent) => {
    const pr = press.current;
    if (!pr || pr.id !== e.pointerId) return;
    press.current = null;
    setCivTime({ scrubbing: false });
    if (pr.hit && !pr.drag) {
      // 手机:先在卡片里列出这一处的每一件,不跳年份(点卡片里的一行才跳)
      if (small) {
        setTip(null);
        setPicked(null);
        setCard(pr.hit);
        return;
      }
      pickChronicleEntry(pr.hit.lead);
      // 宽屏上用手指点:没有悬停,点一下同时弹出提示,三秒后收起
      setTip({ ...pr.hit, pinned: pr.touch });
      if (pr.touch) hideSoon(3000);
    }
  };
  /** 卡片里点一行:跳到那一年、地图上闪出事发地;卡片留着,这一行标成选中 */
  const goRow = (e: ChronicleEntry) => {
    pickChronicleEntry(e);
    setPicked(e);
  };
  const onKey = (e: React.KeyboardEvent) => {
    // 一次走 10 年(按住 Shift 100 年);推得更久的世界按比例放大。导出视频时只在选的那一段里走,导出中不动
    if (range?.locked) return;
    const step = Math.round((e.shiftKey ? 100 : 10) * timeScale(end));
    const lo = range ? range.from : 0;
    const hi = range ? range.to : top;
    const go = (dy: number) => {
      if (!range) return stepYear(top, dy);
      const cur = Math.floor(Math.min(hi, Math.max(lo, getCivTime().year ?? hi)));
      setCivTime({ year: Math.min(hi, Math.max(lo, cur + dy)), playing: false, story: false });
    };
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') go(-step);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') go(step);
    else if (e.key === 'Home' || e.key === 'End') setCivTime({ year: e.key === 'Home' ? lo : hi, playing: false, story: false });
    else if (e.key === 'Escape' && (tip || card)) {
      setTip(null);
      setCard(null);
    } else return;
    e.preventDefault();
  };

  // 刻度、字、菱形、"令":只在排版变了时重新生成(播放时每年重新渲染一次,只改读屏用的年份)
  const hot = (tip ?? card)?.lead;
  const growFrom = grow ? Math.min(end, Math.max(0, grow.from)) : null;
  const stuckAt = growFrom === null && stuck !== undefined && stuck < end ? Math.max(0, stuck) : null;
  const static_ = useMemo(() => {
    const ticks: ReactElement[] = [];
    const { major, minor, mid, origin, labels } = rulerOf(end, era, width);
    if (end > 0) {
      // 格子从 origin(元年;没设纪年 = 第 0 年)数起
      const first = origin - Math.floor(origin / minor) * minor;
      for (let y = first; y <= end; y += minor) {
        const d = y - origin;
        const cls = d % major === 0 ? ' k' : d % mid === 0 ? ' h' : '';
        ticks.push(<i key={y} className={`tb-tick${cls}`} style={{ left: `${(y / end) * 100}%` }} />);
      }
    }
    // 正在再推:新的那一段先不画底线(画推好的浅蓝、没推到的虚线),结尾的字变淡(还没推到)。推不下去:停住那年以后灰着、字变淡
    const cut = growFrom ?? stuckAt;
    const pct = (y: number) => `${(y / Math.max(1, end)) * 100}%`;
    return (
      <>
        <i className="tb-base" style={cut !== null ? { right: 'auto', width: pct(cut) } : undefined} />
        {stuckAt !== null && <i className="tb-stuck-rest" style={{ left: pct(stuckAt), right: 0 }} />}
        {ticks}
        {labels.map((y, i) => (
          <span
            key={y}
            className={`tb-label${i === 0 ? ' first' : y === end ? ' last' : ''}${(growFrom !== null && y === end && i > 0) || (stuckAt !== null && y > stuckAt) ? ' dim' : ''}`}
            style={{ left: pct(y) }}
          >
            {rulerLabel(y, era)}
          </span>
        ))}
        {stuckAt !== null && <i className="tb-stuck-line" style={{ left: pct(stuckAt) }} />}
      </>
    );
  }, [end, era, width, growFrom, stuckAt]);
  // 再推那段上面的字:居中在新的那一段上,不出轨道两头(量了字宽再摆);比新的那一段宽(压到原来那段的圆点上)时垫一层底色
  const noteRef = useRef<HTMLSpanElement>(null);
  const noteText = grow?.note;
  useLayoutEffect(() => {
    const el = noteRef.current;
    if (!el || growFrom === null || !width) return;
    const a = (growFrom / Math.max(1, end)) * width;
    el.classList.remove('over');
    if (el.offsetWidth > width - a + NOTE_PAD * 2) el.classList.add('over');
    const w = el.offsetWidth;
    el.style.left = `${Math.max(NOTE_PAD, Math.min(width - NOTE_PAD - w, (a + width) / 2 - w / 2))}px`;
    el.style.visibility = 'visible';
  }, [noteText, growFrom, width, end]);
  // 选中的国家:一道国色(基线底下,播放头以下)、立国那头的绿点和两头的字(圆点上面)
  const lifeEls = useMemo(() => {
    if (!life || range || !(width > 0) || !(end > 0)) return null;
    const X = (y: number) => (Math.min(end, Math.max(0, y)) / end) * width;
    const a = X(life.founded);
    const b = X(life.ended ?? top);
    const [r, g, bl] = life.color;
    const band = (
      <i
        className="tb-life"
        data-polity={life.polity}
        style={{ left: a, width: Math.max(3, b - a), background: `rgba(${r}, ${g}, ${bl}, 0.55)`, boxShadow: `inset 0 0 0 1px rgba(${r}, ${g}, ${bl}, 0.9)` }}
      />
    );
    let labs: ReactNode = null;
    if (!small) {
      const fa = `${rulerLabel(life.founded, era)} 立国`;
      const fb = life.ended !== null ? `${rulerLabel(life.ended, era)} 亡` : '';
      const L = lifeLabels(a, life.ended !== null ? b : null, textWidth(fa, LIFE_FONT, LIFE_PAD), textWidth(fb, LIFE_FONT, LIFE_PAD), width);
      // 改国号那几年的字:和立国、亡的字(还有前一个改国号的字)挤着就不写
      const taken: [number, number][] = [spanOf(L.found.x, L.found.align, textWidth(fa, LIFE_FONT, LIFE_PAD))];
      if (L.end) taken.push(spanOf(L.end.x, L.end.align, textWidth(fb, LIFE_FONT, LIFE_PAD)));
      const renameLabs = (life.renames ?? []).flatMap((n) => {
        const t = `${rulerLabel(n.year, era)} ${n.text}`;
        const w = textWidth(t, LIFE_FONT, LIFE_PAD);
        const x = X(n.year);
        const align = x - w / 2 < 0 ? 'start' : x + w / 2 > width ? 'end' : 'mid';
        const sp = spanOf(x, align, w);
        if (taken.some(([l, r]) => sp[0] < r + RENAME_GAP && sp[1] > l - RENAME_GAP)) return [];
        taken.push(sp);
        return [
          <span key={n.year} className={`tb-life-lab rename ${align}`} style={{ left: x }}>
            {t}
          </span>,
        ];
      });
      labs = (
        <>
          <span className={`tb-life-lab ${L.found.align}`} style={{ left: L.found.x }}>
            {fa}
          </span>
          {L.end && (
            <span className={`tb-life-lab gone ${L.end.align}`} style={{ left: L.end.x }}>
              {fb}
            </span>
          )}
          {renameLabs}
        </>
      );
    }
    return {
      band,
      top: (
        <>
          <i className="tb-life-found" style={{ left: a }} />
          {(life.renames ?? []).map((n) => (
            <i key={n.year} className="tb-life-rename" data-year={Math.floor(n.year)} style={{ left: X(n.year) }} />
          ))}
          {labs}
        </>
      ),
    };
  }, [life, range, width, end, top, small, era]);

  // 全球大疫:凋敝那几十年基线底下一道灰褐短条(太短的至少 6 像素),宽屏在起疫那年底下写名字(和刻度的字、前一场的名字挤着就不写)
  const panEls = useMemo(() => {
    if (!pandemics?.length || range || !(width > 0) || !(end > 0)) return null;
    const X = (y: number) => (Math.min(end, Math.max(0, y)) / end) * width;
    const rulers = small ? [] : rulerOf(end, era, width).labels.map((y) => ({ x: X(y), w: rulerLabel(y, era).length * 6.2 }));
    let last = -Infinity;
    return pandemics.map((p, i) => {
      const a = X(p.year);
      const b = X(p.end);
      const w = textWidth(p.name, PAN_FONT);
      const free = !small && a - w / 2 > last + PAN_GAP && rulers.every((r) => Math.abs(r.x - a) > (r.w + w) / 2 + PAN_GAP);
      if (free) last = a + w / 2;
      return (
        <Fragment key={`p${i}`}>
          <i className="tb-slump" data-year={Math.floor(p.year)} style={{ left: a, width: Math.max(6, b - a) }} />
          {free && (
            <span className="tb-pan-lab" style={{ left: a }}>
              {p.name}
            </span>
          )}
        </Fragment>
      );
    });
  }, [pandemics, range, width, end, small, era]);
  /** 起疫那一刻(大点:编年史里那一条标签"疠"、年份对得上) */
  const panStarts = useMemo(() => new Set((pandemics ?? []).map((p) => p.year)), [pandemics]);

  const lifeId = life && !range ? life.polity : null;
  const marks = useMemo(
    () => (
      <>
        {layout.marks.map((d) => {
          const dim = lifeId !== null && !d.items.some((e) => entryInvolves(e, lifeId));
          const state = `${hot === d.lead ? ' on' : ''}${range && (d.lead.year < range.from || d.lead.year > range.to + 1) ? ' out' : ''}${dim ? ' dim' : ''}`;
          // 里面有新国家立起来、颜色又不是立国的:上面叠一颗绿点(选中了国家时不叠:它的立国另有一颗大绿点,别的点里叠的是别国的立国)
          const up = lifeId === null && hidesFounding(d);
          // 里面有全球大疫起疫的那一条:深色大点
          const pan = panStarts.size > 0 && d.items.some((e) => e.tag === '疠' && panStarts.has(e.year));
          return (
            <Fragment key={`m${d.lead.id}`}>
              <i className={`tb-mark${d.items.length > 1 ? ' many' : ''}${pan ? ' pan' : ''}${state}`} data-ev={evType(d.lead)} data-year={Math.floor(d.lead.year)} data-n={d.items.length} style={{ left: d.x }} />
              {up && <i className={`tb-mark-up${state}`} data-ev="found" data-year={Math.floor(d.lead.year)} style={{ left: d.x }} />}
            </Fragment>
          );
        })}
        {layout.orders.map((d) => (
          <i
            key={`o${d.lead.id}`}
            className={`tb-order${hot === d.lead ? ' on' : ''}${d.x > width - 18 ? ' end' : ''}`}
            data-year={Math.floor(d.lead.year)}
            data-n={d.items.length}
            style={{ left: d.x }}
          >
            <b>令</b>
          </i>
        ))}
        {layout.shifts.map((d) => (
          <i
            key={`s${d.lead.id}`}
            className={`tb-order up-mark${hot === d.lead ? ' on' : ''}${d.x > width - 18 ? ' end' : ''}`}
            data-year={Math.floor(d.lead.year)}
            data-n={d.items.length}
            style={{ left: d.x }}
          >
            <b>变</b>
          </i>
        ))}
      </>
    ),
    [layout, hot, width, range?.from, range?.to, lifeId, panStarts],
  );

  /** 提示、卡片里一条纪事底下列的:大崩解分出来的每一国(编年史里那一条展开的几行) */
  const subRows = (e: ChronicleEntry) => (e.kind === 'collapse' ? (e.children ?? []) : []);
  const cardCur = card ? (picked ?? card.lead) : null;
  return (
    <div
      ref={ref}
      className={`tb-track${tip ? ' hot' : ''}${range ? ' film' : ''}${range?.locked ? ' locked' : ''}`}
      role="slider"
      tabIndex={0}
      aria-orientation="horizontal"
      aria-label="年份"
      aria-valuemin={range ? range.from : 0}
      aria-valuemax={range ? range.to : top}
      aria-valuenow={year}
      aria-valuetext={yearFull(year, era)}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={() => tip && !tip.pinned && hideSoon(220)}
      onKeyDown={onKey}
    >
      {static_}
      {fresh !== undefined && growFrom === null && width > 0 && fresh > 0 && fresh < end && (
        <>
          <i className="tb-fresh" style={{ left: (fresh / end) * width - 2, width: ((Math.max(fresh, stuckAt ?? end) - fresh) / end) * width + 4 }} />
          <i className="tb-seam" style={{ left: (fresh / end) * width }} />
        </>
      )}
      {growFrom !== null && width > 0 && <GrowTrack from={growFrom} at={grow!.at} end={end} width={width} />}
      <i className="tb-prog" />
      {plots && growFrom === null && <PlotTicks ticks={plots} end={end} width={width} below={dock === 'top'} />}
      {panEls}
      {lifeEls?.band}
      {marks}
      {lifeEls?.top}
      {/* 写在圆点上面(字宽的时候垫着底色,盖住底下的圆点),播放头下面 */}
      {growFrom !== null && grow!.note && (
        <span ref={noteRef} className="tb-grow-note" style={{ visibility: 'hidden' }}>
          {grow!.note}
        </span>
      )}
      {range && width > 0 && (
        <>
          <i
            className="tb-range"
            style={{ left: (range.from / end) * width - pad, width: ((range.to - range.from) / end) * width + 2 * pad }}
            data-from={range.from}
            data-to={range.to}
          />
          {range.labels && (
            <>
              <span className="tb-range-lab" style={{ left: (range.from / end) * width }}>
                {yearShort(range.from, era)}
              </span>
              <span className="tb-range-lab" style={{ left: (range.to / end) * width }}>
                {yearShort(range.to, era)}
              </span>
            </>
          )}
        </>
      )}
      <i className={range ? 'tb-ph' : 'tb-head'} />
      {tip && tip.items.length === 1 && tip.lead.kind === 'upheaval' ? (
        <div
          ref={tipRef}
          className="up-tip"
          style={{ visibility: 'hidden' }}
          {...rowKey()}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerEnter={keep}
          onPointerLeave={() => !tip.pinned && hideSoon(220)}
          onClick={() => pickChronicleEntry(tip.lead)}
        >
          <b>
            {evYears(tip.lead, era)} · {evLabel(tip.lead)}
          </b>
          <small>{eraText(evText(tip.lead), era)}</small>
        </div>
      ) : tip && (
        <div
          ref={tipRef}
          className="tb-tip"
          style={{ visibility: 'hidden' }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerEnter={keep}
          onPointerLeave={() => !tip.pinned && hideSoon(220)}
        >
          {tip.items.map((e) => (
            <Fragment key={e.id}>
              <div
                className={`tb-tip-row${e === tip.lead ? ' lead' : ''}`}
                data-ev={evType(e)}
                {...rowKey()}
                onClick={() => {
                  pickChronicleEntry(e);
                  setTip({ ...tip, lead: e });
                }}
              >
                <b className="tb-ev">{evLabel(e)}</b>
                <span className="tb-tip-year">{evYears(e, era, months, monthNames)}</span>
                <span className="tb-tip-text">{eraText(evText(e), era)}</span>
              </div>
              {subRows(e).map((c) => (
                <div
                  key={`c${c.id}`}
                  className={`tb-tip-row sub${c === tip.lead ? ' lead' : ''}`}
                  data-ev={evType(c)}
                  {...rowKey()}
                  onClick={() => {
                    pickChronicleEntry(c);
                    setTip({ ...tip, lead: c });
                  }}
                >
                  <b className="tb-ev">{evLabel(c)}</b>
                  <span className="tb-tip-text">{eraText(evText(c), era)}</span>
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      )}
      {card && (
        <div ref={cardRef} className="tb-card" role="dialog" aria-label={`${cardTitle(card, era)},${card.items.length} 件`} style={{ visibility: 'hidden' }} onPointerDown={(e) => e.stopPropagation()}>
          <div className="tb-card-head">
            <b>{cardTitle(card, era)}</b>
            <em>{card.items.length} 件</em>
            <span className="tb-card-sp" />
            <button className="tb-card-x" aria-label="收起" data-act="timeline-card-close" onClick={() => setCard(null)}>
              <Icon name="close" size={15} />
            </button>
          </div>
          <div className={`tb-card-body${listMore && !listEnd ? ' more' : ''}`}>
            <div
              ref={listRef}
              className="tb-card-list"
              onScroll={(e) => {
                const el = e.currentTarget;
                setListEnd(el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
              }}
            >
              {card.items.map((e) => (
                <Fragment key={e.id}>
                  <div {...rowKey()} className={`tb-card-row${e === cardCur ? ' cur' : ''}`} data-ev={evType(e)} data-year={Math.floor(e.year)} onClick={() => goRow(e)}>
                    <span className="tb-card-y">{yearShort(e.year, era)}</span>
                    <b className="tb-ev">{evLabel(e)}</b>
                    <span className="tb-card-x2">{eraText(evText(e), era)}</span>
                  </div>
                  {subRows(e).map((c) => (
                    <div {...rowKey()} key={`c${c.id}`} className={`tb-card-row sub${c === cardCur ? ' cur' : ''}`} data-ev={evType(c)} onClick={() => goRow(c)}>
                      <b className="tb-ev">{evLabel(c)}</b>
                      <span className="tb-card-x2">{eraText(evText(c), era)}</span>
                    </div>
                  ))}
                </Fragment>
              ))}
            </div>
          </div>
          <div className="tb-card-foot">
            <span>{listMore ? `往下滑看全部 ${card.items.length} 件` : ''}</span>
            <button
              className="tb-card-link"
              data-act="timeline-card-chronicle"
              onClick={() => {
                openOverview('chronicle', { at: (cardCur ?? card.lead).year });
                setCard(null);
              }}
            >
              <Icon name="book" size={15} />
              编年史
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

/** 手机卡片的标题:"2759–2980 年"(只有一件、或都在同一年:"2759 年") */
function cardTitle(d: Diamond, era?: Era): string {
  const a = d.items[0].year;
  const b = d.items[d.items.length - 1].year;
  return Math.floor(b) > Math.floor(a) ? yearSpanAt(a, b, era) : yearAt(a, era);
}

/** 正在再推的那一段:推好了的浅蓝(像播放条上"已缓冲"的那截,跟着推到哪年长),还没推到的虚线 */
function GrowTrack({ from, at, end, width }: { from: number; at: number | null; end: number; width: number }) {
  const a = (from / end) * width;
  const b = at === null ? a : (Math.min(end, Math.max(from, at)) / end) * width;
  return (
    <>
      <i className="tb-grow-done" style={{ left: a, width: b - a }} />
      <i className="tb-grow-todo" style={{ left: b + 3, width: Math.max(0, width - b - 3) }} />
    </>
  );
}
