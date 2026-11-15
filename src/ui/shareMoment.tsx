/**
 * 分享链接带上"这一刻"(打开时停在哪一年、选中哪个国家或州、地图看哪;存档里的写法见 gen/savefile.ts 的 SaveMoment):
 *
 *   momentNow()        现在这一刻(App 登记怎么取:时间轴那一年、选中的国家或州、画面正中和放大倍数);世界还没出来 = null
 *   useMomentOn()      存档菜单、分享窗里「停在这一刻」勾没勾:默认勾着,记住上次的选择(这个浏览器里)
 *   copyShareLink()    做好长链接(整份存档压进 # 后面)并复制:存档菜单的「复制配方链接」、国家卡片「更多」里的「复制配方链接」
 *   shareCopiedToast() 复制好以后顶上提示条怎么说(对方打开停在哪;链接太长时照旧提醒)
 */
import { useSyncExternalStore } from 'react';
import { GEN_KEY, SHARE_WARN_LENGTH, editCount, encodeShare, hasShareData, withMoment, type SaveMoment } from '../gen/savefile';
import { GENERATOR_VERSION, keptMapOf } from '../gen/edits';
import { currentSave, currentWorld, notify } from './saveStore';
import { pluginDataNames } from './plugins/saveItems';
import { usesMaps } from './world/mapNow';
import { copyText } from './clipboard';

/** 现在这一刻,连同说给人听的说法 */
export interface MomentNow {
  moment: SaveMoment;
  /** 年份的说法:"第 1500 年"(设了纪年的按纪年) */
  year: string;
  /** 选中的国家 / 州现在的名字;没选 = null */
  name: string | null;
}

let source: ((withSelection: boolean) => MomentNow | null) | null = null;

/** App 登记:怎么取现在这一刻(withSelection = 连选中的国家或州一起) */
export function setMomentSource(f: ((withSelection: boolean) => MomentNow | null) | null): void {
  source = f;
}

/** 现在这一刻(世界还没出来、没有历史 = null) */
export function momentNow(withSelection = true): MomentNow | null {
  return source?.(withSelection) ?? null;
}

/** "第 1500 年，选中有桑皇朝"(没选 = "第 1500 年") */
export function momentLine(m: MomentNow, verb = '选中'): string {
  return m.name ? `${m.year}，${verb}${m.name}` : m.year;
}

// ---- 「停在这一刻」勾没勾(默认勾着,记在这个浏览器里;浏览器不让存就只管这一次打开的页面) ----

const KEY = 'wenming-ditu:share-moment';
let on: boolean | null = null;
const subs = new Set<() => void>();

function read(): boolean {
  if (on !== null) return on;
  try {
    on = localStorage.getItem(KEY) !== '0';
  } catch {
    on = true;
  }
  return on;
}

export function getMomentOn(): boolean {
  return read();
}

export function setMomentOn(v: boolean): void {
  on = v;
  try {
    localStorage.setItem(KEY, v ? '1' : '0');
  } catch {
    /* 隐私模式:只管这一次 */
  }
  subs.forEach((f) => f());
}

export function useMomentOn(): [boolean, (v: boolean) => void] {
  const v = useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    read,
    read,
  );
  return [v, setMomentOn];
}

/**
 * 「停在这一刻」一行(存档菜单「复制配方链接」下面、分享窗里):勾选 + 写清会停在哪 ——
 * 第几年、选中哪国(没选只写年份),地图的位置和大小照现在看的
 */
export function MomentCheck({ at, on, onChange, className }: { at: MomentNow; on: boolean; onChange: (v: boolean) => void; className?: string }) {
  return (
    <label className={`save-moment${className ? ` ${className}` : ''}`}>
      <input type="checkbox" checked={on} data-act="share-moment" onChange={(e) => onChange(e.target.checked)} />
      <span>
        <b>停在这一刻</b>
        {at.name ? (
          <>
            <small>{momentLine(at)}</small>
            <small>地图的位置和大小照你现在看的</small>
          </>
        ) : (
          <small>{at.year}，地图的位置和大小照你现在看的</small>
        )}
      </span>
    </label>
  );
}

// ---- 长链接 ----

export const LONG_HINT = '链接较长，可能打不开，建议存成文件';

/**
 * 分享链接的网址部分:种子、参数、图层……照当前网址,带上生成器版本;去掉只在这个浏览器里有意义的世界编号、
 * 别人的分享短链接的码(那个分享停了,链接就打不开了)、看哪一年(civYear=;停在哪一年由「停在这一刻」管)。
 * 网址带的版本比这个页面新(页面是旧的,还没刷新)就照留,别人打开还知道是新版本的世界
 */
export function shareBase(): string {
  const q = new URLSearchParams(location.search);
  q.delete('w');
  q.delete('new');
  q.delete('s');
  q.delete('civYear');
  const g = Number(q.get(GEN_KEY));
  if (!(Number.isInteger(g) && g > GENERATOR_VERSION)) q.set(GEN_KEY, String(GENERATOR_VERSION));
  const s = q.toString();
  return location.origin + location.pathname + (s ? `?${s}` : '');
}

/** 调试 / 冒烟测试用:最近一次"复制配方链接" */
interface ShareDebug {
  url: string;
  length: number;
  /** 带不带修改(没有修改、也没带这一刻 = 普通网址) */
  withData: boolean;
  count: number;
  copied: boolean;
  /** 带的这一刻 */
  moment?: SaveMoment;
}

export interface ShareCopy {
  url: string;
  /** 带着存档(没有修改、也没带这一刻 = 普通网址,只带种子和参数) */
  withData: boolean;
  copied: boolean;
  /** 链接太长(超过 SHARE_WARN_LENGTH 字) */
  long: boolean;
}

/**
 * 做好长链接并复制:网址(种子 + 参数 + 画风……)+ #share=整份存档(带上这一刻);没有修改、也没带这一刻 = 普通网址。
 * 浏览器太旧做不了 = null(已经提示过);复制不了 copied = false(调用方让用户自己复制)
 */
export async function copyShareLink(moment: SaveMoment | null): Promise<ShareCopy | null> {
  const plain = currentSave();
  if (!plain) return null;
  const save = withMoment(plain, moment);
  const base = shareBase();
  const withData = hasShareData(save);
  let url = base;
  if (withData) {
    try {
      url = base + (await encodeShare(save));
    } catch {
      notify({ kind: 'error', text: '做不了配方链接', more: ['浏览器版本太旧，请改用存成文件'] });
      return null;
    }
  }
  const copied = await copyText(url);
  (window as unknown as { __wfShare?: ShareDebug }).__wfShare = { url, length: url.length, withData, count: editCount(save.edits), copied, ...(save.moment ? { moment: save.moment } : {}) };
  return { url, withData, copied, long: url.length > SHARE_WARN_LENGTH };
}

/** 复制好以后顶上的提示:太长的照旧提醒;带了这一刻说对方打开停在哪;没有修改的说只带种子和参数 */
export function shareCopiedToast(r: ShareCopy, at: MomentNow | null): void {
  const more = r.long ? [`${LONG_HINT}（${r.url.length} 字）`] : at ? [`对方打开停在${momentLine(at)}`] : r.withData ? [] : ['还没有修改，只带种子和参数'];
  notify({ kind: r.long ? 'warn' : 'ok', text: `已复制${r.withData ? '配方' : ''}链接`, more });
}

/**
 * 复制没成时统一的说法:提示条上一个「复制」按钮再试一次,还不行就请到「存档」里手动复制 / 存成文件。
 * 国家卡片、快捷键 5 都走这一套(存档菜单还多给一个能选中链接的输入框),不各写各的出错文案。
 */
function retryLinkToast(r: ShareCopy, at: MomentNow | null): void {
  const again = () =>
    void copyText(r.url).then((ok) =>
      ok ? shareCopiedToast({ ...r, copied: true }, at) : notify({ kind: 'error', text: '这个浏览器不让网页复制', more: ['请到「存档」里手动复制配方链接，或者存成文件发给对方'] }),
    );
  notify({ kind: 'warn', text: '配方链接做好了，还没复制', more: ['点「复制」再试一次，或到「存档」里手动复制'], action: { label: '复制', act: 'share-copy-again', onClick: again } });
}

/**
 * 国家卡片「更多」里的「复制配方链接」:总是带上这一刻(选中的就是这个国家)。
 * 剪贴板用不了(做链接时等久了,有的浏览器就不让复制了):和别的入口一样给一个能再试一次的提示。
 */
export async function copyMomentLink(): Promise<void> {
  const plain = currentSave();
  // 用了地图插件的也一样:配方里没有插件,别人点开长出来是另一张图
  if (plain && keptMapOf(plain.edits)) return notify({ kind: 'warn', text: '这个世界的地图带不进链接', more: ['要发给别人，请到「存档」里存成文件'] });
  if (usesMaps(currentWorld()?.id)) return notify({ kind: 'warn', text: '地图插件带不进链接', more: ['对方长出来的地图不一样。要发给别人，请到「存档」里存成文件'] });
  const names = await pluginDataNames(currentWorld()?.id);
  if (names) return notify({ kind: 'warn', text: `这个世界里有插件${names}存的数据，不能公开分享`, more: ['要发给别人，请到「存档」里存成文件'] });
  const at = momentNow(true);
  const r = await copyShareLink(at?.moment ?? null);
  if (!r) return;
  if (r.copied) return shareCopiedToast(r, at);
  retryLinkToast(r, at);
}

/**
 * 快捷键 5 / 别的统一入口:复制当前世界的配方链接。
 * 和国家卡片「复制配方链接」完全同一套(先看地图带不带得进、再 copyShareLink 生成复制、
 * shareCopiedToast 报成功、retryLinkToast 管失败),不另写一份生成和出错的说法。
 */
export const copyCurrentLink = copyMomentLink;
