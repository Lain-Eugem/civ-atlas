/**
 * 「我的世界」:浏览器里存着的世界,一个一张卡片(缩略图、名字、种子和现存几国、最近打开的时间),最近的在前。
 * 有存档的人进站先到这一页;世界卡片顶上"‹ 我的世界"回到这里。样子照常见的文稿列表(浅灰底、缩略图网格、名字和日期在图下面)。
 *
 *   右上     作品墙(服务器开了作品墙才有,见 Gallery.tsx)、使用教程(新标签页打开 public/guide.html;一个世界都没有时也在)、打开存档文件(也可以把文件拖进页面)、新建世界;
 *            有网站服务器时再加账号按钮(没登录是「登录」,登录了是名字;手机在左上,这时有作品墙的话使用教程只留图标)
 *   卡片     点一下打开;"没建完"的(还在新建)点开接着建
 *            右上"···"(电脑悬停时出现;手机长按卡片)= 改名、复制一份、存成文件(右边写多大)、删除(点两下确认)。没建完的只有改名、删除
 *   底部     源代码、隐私政策、用户协议、联系我们(配了交流群才有,见 ContactLink.tsx)、版本号(手机上不放,在世界卡片的"更多"里)
 * 手机:两列卡片,使用教程、新建世界在右上(一个都没有时使用教程在标题右边),打开存档文件在列表下面。
 * 一个都没有(第一次来)时:中间一颗慢慢自转的星球、一段话说清能做什么、「新建世界」大按钮,下面"或者打开存档文件",
 * 最下面一行小字说不用登录、做出来的世界归自己(和用户协议「你创作的东西归你」同一个说法)。
 * 作品墙上有本月精选时,这一块往上收(星球小一圈),下面一排四张精选(手机两列,那段话换成三行的短说法、不放小字)。
 *
 * 标题下那句话:没登录的说清楚世界只存在这个浏览器里、清理浏览器数据会一起删掉;后面跟蓝字「全部存成文件」
 * (所有世界存成一个文件,「打开存档文件」选它全部放回来,见 worldFileFlow.ts;一个世界都没有、也没有只在页面里的时不出现)。
 * 登录了的:标题下那句话说传到账号的有几个(服务器开了才有);卡片时间前面有小云的是传过的;
 * 账号窗里点「最近删除」,这一页换成最近删除(30 天内能找回,点一张卡片找回)。
 *
 * 两个页签(分段控件,默认「地图」;回到这一页还是上次看的那个;调规则的入口开着时多一个「规则」,见 rules/flag.ts。
 * 一个世界都没有时:本机「我的规则」里有规则(或者正看着「规则」)才有这一排,不然还是原来那一页空的星球):
 *   地图     一张地图一张卡片(实景、没有国界和地名的地图缩略图,名字"种子 7",下面写这张地图上有几个文明;分组见 mapGroups.ts)。
 *            点一张选中(描蓝边),它那一行下面展开:这张地图上的文明(点一个打开)和「打造新文明」;
 *            还没有文明的(新建时只保存了地图)展开里是「打造文明」「投到作品墙…」(登录了、服务器开着投稿才有)「删除这张地图」。再点一下收起
 *   文明     一个文明一张卡片(就是原来的我的世界);"···"菜单里多一项「在这张地图上打造新文明」
 *   规则     官方规则和本机「我的规则」里的几套,点一套打开调规则的大卡(rules/RulesList.tsx;代码和样式点到这一页才下载)
 * 手机上页签铺满一行,地图两列,展开的那块里文明一行一个,底下一个大的「打造新文明」。
 *
 * 刚打开网站、地图程序还没下完时点了打开(opening,见 HomeShell.tsx):点的那张卡片蒙一层浅白、正中一个下载进度圈,
 * 下面那行字换成"正在打开,地图程序已下载 62%"(手机卡片窄,省掉"地图程序");点的是「打造新文明」按钮的,按钮转圈 +「准备中」。
 *
 * 存、读、列都在 saveStore.ts;打开一个世界(生成 + 套上修改)由 App 做。一个都没有时也停在这一页
 * (刚才那个世界存不进浏览器、只在页面里的,标题下有「全部存成文件」)。
 */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { lookForLostWorlds } from './lostWorlds';
import { holdWorld } from './worldHolds';
import { currentUnsaved, deleteWorld, duplicateWorld, listWorlds, loadWorld, notify, persistent, renameWorld, restoreWorld, storageFullWhy, useSavesVersion, type StoredWorld } from './saveStore';
import { isCoarse } from './device';
import { withFileFlow } from './worldFileLazy';
import { closeTrash, openAccount, openLogin, openSubmitDialog, useAccountPanelOpen, useTrashView } from './AccountDialogs';
import { askPhone, phoneRequired, useSubmitBan, useSubmitOn } from './submitView';
import { accountServer } from '../account/server';
import { displayName, useSession } from '../account/session';
import { listTrash, restoreTrash, type TrashEntry } from '../account/cloud';
import { REFUSAL_NOTE, askFull, fullDay, fullJob, fullOverview, fullStatusOf, pairText, refusalOf, useFullJob, useFullOverview, useFullPull } from './fullWorldView';
import { homeAccountLine } from './syncWords';
import { copyNotes } from '../ai/library';
import { copyResults } from './resultStore';
import { Icon } from './icons';
import { SpaceBar, SpaceEntry, loadSpaceDialog, useSpace } from './SpaceBar';
import { spaceChanged } from './spaceFacts';
import { TitleInput, playedTo, when } from './worldParts';
import { GUIDE_URL, PRIVACY_URL, SOURCE_URL, TERMS_URL } from './links';
import { ContactLink } from './ContactLink';
import { VersionText } from './VersionNews';
import { BeianLinks } from './BeianLinks';
import { BEIAN } from './beian';
import { HomeGlobe } from './studio/HomeGlobe';
import { OldSiteBadge } from './OldSiteBadge';
import { BETA_SITE, OLD_SITE } from './oldSite';
import { civName, mapBrief, mapGroups, mapLine, mapName, type MapGroup } from './mapGroups';
import { GENERATOR_VERSION } from '../gen/edits';
import { loadGallery, useGallery, type GalleryWork } from '../account/gallery';
import { GalleryFeatured } from './Gallery';
import { rulesUiOn } from './rules/flag';
import { RulesTabHost } from './rules/RulesHost';
import { openRulesText } from './rules/sheetStore';
import { useMyRulesCount } from './rulesCount';
import './worlds.css';

/** 我的世界看的是哪个页签、「地图」里选中了哪张(组的编号);回到这一页照旧 */
type WorldsTab = 'maps' | 'civs' | 'rules';
let view: { tab: WorldsTab; pick: string | null } = { tab: 'maps', pick: null };
const viewSubs = new Set<() => void>();
function setView(v: Partial<typeof view>) {
  view = { ...view, ...v };
  for (const f of viewSubs) f();
}
function useView() {
  return useSyncExternalStore(
    (f) => (viewSubs.add(f), () => viewSubs.delete(f)),
    () => view,
    () => view,
  );
}
/** 回到我的世界时看「地图」页签、选中这张地图(刚保存的地图) */
export function showMapInWorlds(key: string) {
  setView({ tab: 'maps', pick: key });
}
/** 回到我的世界时看「规则」页签(加进了别人分享的规则) */
export function showRulesInWorlds() {
  setView({ tab: 'rules' });
}

export interface MyWorldsProps {
  phone: boolean;
  /** 打开一个存着的世界 */
  onOpen: (id: string) => void;
  /** 新建世界 */
  onNew: () => void;
  /** 从文件打开:文件内容(App 解析、存进我的世界、打开) */
  onOpenText: (text: string, fileName?: string) => void;
  /** 在这个世界(或只存了地图的那一份)的地图上打造新文明 */
  onNewCiv: (id: string) => void;
  /** 点了打开(或打造新文明)、地图程序还没下完:哪一个、下了百分之几(null = 不知道) */
  opening?: { id: string; pct: number | null } | null;
  /** 去作品墙那一页(不给 = 不放入口) */
  onGallery?: () => void;
  /** 点开空页面上的一张精选 */
  onOpenWork?: (w: GalleryWork) => void;
}

/** 正在等地图程序的那一处:下了百分之几(null = 不知道);line = 那行字换成这句(正在从账号取) */
type Wait = { pct: number | null; line?: string };
/** 点的是卡片(打开、菜单里打造新文明)还是展开那块里的「打造新文明」按钮 */
type WaitAt = 'card' | 'btn';
type WaitOf = (id: string, at: WaitAt) => Wait | undefined;

/** 卡片上那行字:正在打开、地图程序下了多少(手机卡片窄,省掉"地图程序") */
function openLine(pct: number | null, phone: boolean): string {
  if (pct === null) return phone ? '正在打开，还在下载' : '正在打开，地图程序还在下载';
  return phone ? `正在打开，已下载 ${pct}%` : `正在打开，地图程序已下载 ${pct}%`;
}

/** 缩略图正中的下载进度圈(像应用商店下载时的圈);不知道下了多少时转圈 */
function OpenRing({ pct }: { pct: number | null }) {
  const len = 2 * Math.PI * 13;
  return (
    <span className={`mw-ring${pct === null ? ' busy' : ''}`} role="progressbar" aria-label="正在打开" aria-valuenow={pct ?? undefined}>
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <circle className="bg" cx="16" cy="16" r="13" />
        <circle className="fg" cx="16" cy="16" r="13" strokeDasharray={len} strokeDashoffset={len * (1 - (pct ?? 25) / 100)} />
      </svg>
    </span>
  );
}

/** 「打造新文明」按钮等地图程序时:转圈 +「准备中」 */
function WaitLabel() {
  return (
    <>
      <i className="spin mw-spin" aria-hidden="true" />
      准备中
    </>
  );
}

/**
 * 打开文件的选择框限制哪些文件。手机和 Safari 上不限:.civworld 系统不认识,写了可能灰掉不让选(错的文件打开时会说不是存档)
 */
function pickAccept(): string | undefined {
  const ua = navigator.userAgent;
  if (isCoarse() || /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (/Safari/i.test(ua) && !/Chrome|Chromium|Edg/i.test(ua))) return undefined;
  return '.civworld,.json,application/json';
}

/** 卡片第二行:"种子 7，现存 13 国" / "种子 1009，还在新建" / 逐年推演的 "种子 7，演绎到第 2675 年" */
function worldLine(w: StoredWorld): string {
  const seed = `种子 ${w.save.seed}`;
  if (w.draft) return `${seed}，还在新建`;
  const played = playedTo(w.save.edits);
  if (played) return `${seed}，${played}`;
  if (w.alive === undefined) return seed;
  return w.alive ? `${seed}，现存 ${w.alive} 国` : `${seed}，没有文明`;
}

export function MyWorlds({ phone, onOpen: openWorld, onNew, onOpenText, onNewCiv: newCiv, opening, onGallery, onOpenWork }: MyWorldsProps) {
  const v = useSavesVersion();
  const list = useMemo(() => listWorlds(), [v]);
  const groups = useMemo(() => mapGroups(list), [list]);
  const civs = useMemo(() => list.filter((w) => !w.map), [list]);
  const oldIds = useOldWorlds(civs);
  const { tab: tab0, pick } = useView();
  const rulesOn = rulesUiOn();
  /** 本机「我的规则」里有几套(一个世界都没有时,有规则才露出分段控件) */
  const myRulesN = useMyRulesCount();
  const tab = tab0 === 'rules' && !rulesOn ? 'maps' : tab0;
  /** 看的是「规则」页签(一个世界都没有时也能看:规则和世界各存各的) */
  const rulesTab = rulesOn && tab === 'rules';
  const fileRef = useRef<HTMLInputElement>(null);
  /** 菜单开在哪张卡片上 */
  const [menu, setMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const keep = persistent();
  /** 最近点的是哪一个、点在哪(等地图程序时在那里显示下了多少) */
  const [clicked, setClicked] = useState<{ id: string; at: WaitAt } | null>(null);
  const pull = useFullPull();
  /** 第几次点:取回来的时候用的人已经点了别的,或者离开了这一页,就不打开这个 */
  const clickSeq = useRef(0);
  useEffect(
    () => () => {
      clickSeq.current++;
    },
    [],
  );
  const onOpen = (id: string) => {
    setClicked({ id, at: 'card' });
    const seq = ++clickSeq.current;
    // 传过整个世界的、这台设备上没有:先从账号取回来再打开
    if (!session || !fullOverview()?.worlds.some((w) => w.id === id)) return openWorld(id);
    const open = () => {
      if (seq === clickSeq.current) openWorld(id);
    };
    const go = () => void import('./fullWorldPull').then((m) => m.pullBeforeOpen(id, go)).then((ok) => ok && open(), open);
    go();
  };
  const onNewCiv = (id: string, at: WaitAt = 'card') => {
    clickSeq.current++;
    setClicked({ id, at });
    newCiv(id);
  };
  const waitOf: WaitOf = (id, at) =>
    pull?.id === id && at === 'card'
      ? { pct: pull.total ? Math.round((pull.done / pull.total) * 100) : null, line: `正在从账号取，${pull.total ? pairText(pull.done, pull.total) : ''}` }
      : opening && opening.id === id && clicked?.id === id && clicked.at === at
        ? { pct: opening.pct }
        : undefined;

  const pickFile = () => fileRef.current?.click();
  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = '';
    if (!files.length) return;
    withFileFlow(`打不开 ${files[0].name}`, (m) =>
      m.openPickedFiles(files, (text, name) => {
        // 一套规则的文件:打开调规则的大卡(只能看),不当世界的存档
        if (!openRulesText(text, name)) onOpenText(text, name);
      }),
    );
  };
  const session = useSession();
  const server = accountServer() !== null;
  const fo = useFullOverview();
  useEffect(() => {
    if (session) void askFull();
  }, [!!session]);
  const trash = useTrashView();
  const n = list.length;
  const empty = n === 0;
  // 作品墙:服务器开了才有入口(取到过列表);空页面上有本月精选时放一排
  const gallery = useGallery();
  const wallOk = !!onGallery;
  useEffect(() => {
    if (wallOk) loadGallery();
  }, [wallOk]);
  useEffect(lookForLostWorlds, []);
  const wall = onGallery ? gallery.list : null;
  const feOn = !!wall && empty && !!onOpenWork && wall.featured.some((f) => wall.works.some((w) => w.id === f.id));
  // 没登录:世界只在这个浏览器里,清理浏览器数据就没了 —— 直说,后面跟「全部存成文件」;登录了存在账号里,不再提醒。
  // 旧网站、测试网站(oldSite.ts):这里的世界和最新版 / 正式版的各存各的,说清楚(顶上还有「旧版」「测试版」标记)
  const sub = !keep
    ? '浏览器不让网页存数据，关掉页面前请把世界存成文件。'
    : session && fo
      ? homeAccountLine(n, fo.account.filter((w) => list.some((x) => x.id === w.id)).length, phone)
      : empty
        ? BETA_SITE
          ? '测试版的世界和正式版的分开放。正式版的世界存成文件，就能拿到这里打开。'
          : server && !session
            ? '建好的世界存在这个浏览器里。登录以后，换电脑、换手机都能接着改。'
            : '建好的世界存在这个浏览器里；换电脑请用存档文件。'
        : OLD_SITE !== null
          ? `${n} 个世界，存在旧版里，和最新版的分开放。`
          : BETA_SITE
            ? `${n} 个世界，存在测试版里，和正式版的分开放。`
            : phone
              ? `${n} 个世界只存在这个浏览器里，清理浏览器数据会删掉。`
              : server && !session
                ? `${n} 个世界，只存在这个浏览器里，清理浏览器数据会一起删掉。登录以后，换电脑、换手机都能接着改。`
                : `${n} 个世界，只存在这个浏览器里，清理浏览器数据会把它们一起删掉。`;
  // 正在看的世界存不进浏览器(存储满了)、一个都没存下时,也能把它存成文件
  const saveAll = (n > 0 || currentUnsaved()) && (
    <button className="mw-link" data-act="save-all" onClick={() => withFileFlow('没能存成文件', (m) => m.saveAllToFile())}>
      <Icon name="save" size={phone ? 13 : 14} />
      全部存成文件
    </button>
  );
  // 世界不会自动进账号,登录了一样可能丢
  const space = useSpace(list, false, keep);
  const barOn = !!space.bar && !empty;
  const [SpaceWin, setSpaceWin] = useState<typeof import('./SpaceDialog').SpaceDialog | null>(null);
  const openSpace = () => {
    void loadSpaceDialog().then(
      (m) => setSpaceWin(() => m.SpaceDialog),
      () => {},
    );
  };
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const acctOpen = useAccountPanelOpen();
  const acctBtn = server && (
    <button className={`mw-acct${acctOpen ? ' on' : ''}`} data-act={session ? 'account' : 'login'} onClick={() => (session ? openAccount() : openLogin())} title={session ? session.user.account : '登录网站账号'}>
      <Icon name="personc" size={18} />
      <span>{session ? displayName(session.user) : '登录'}</span>
    </button>
  );
  if (trash && session) return <TrashPage phone={phone} />;
  // 使用教程:新标签页打开一页文字说明(public/guide.html),地图这边不动
  // 手机上同时有账号按钮和作品墙时一排放不下:使用教程只留图标
  const guideIc = phone && !!wall && !!acctBtn;
  const guideBtn = (
    <a
      className={`mw-btn${phone ? ' round' : ''}${guideIc ? ' ic' : ''}`}
      href={GUIDE_URL}
      target="_blank"
      rel="noreferrer"
      data-link="guide"
      aria-label={guideIc ? '使用教程' : undefined}
      title={guideIc ? '使用教程' : undefined}
    >
      <Icon name="book" size={16} />
      {!guideIc && '使用教程'}
    </a>
  );
  const wallBtn = !!wall && (
    <button className={`mw-btn${phone ? ' round' : ''}`} data-act="gallery" onClick={onGallery}>
      <Icon name="image" size={16} />
      作品墙
    </button>
  );

  return (
    <div className={`mw${phone ? ' mw-phone' : ''}`} role="main" aria-label="我的世界" onPointerDown={stop} onClick={stop} onDoubleClick={stop} onWheel={stop}>
      <input ref={fileRef} type="file" accept={pickAccept()} multiple hidden onChange={onFile} data-testid="save-file-input" />
      <header className="mw-top">
        {phone && (
          <div className={`mw-bar${server ? ' has-acct' : ''}${empty && !acctBtn && !wallBtn ? ' solo' : ''}`}>
            {acctBtn}
            {wallBtn}
            {guideBtn}
            {!empty && (
              <button className="mw-btn blue round" data-act="new-world" onClick={onNew}>
                <Icon name="plus" size={16} />
                新建世界
              </button>
            )}
          </div>
        )}
        <div className="mw-heading">
          <OldSiteBadge />
          <h1>我的世界</h1>
          <p>
            {sub}
            {!barOn && phone && saveAll && <br />}
            {!barOn && saveAll}
          </p>
        </div>
        {/* 一个都没有时,打开存档、新建在中间的大按钮那里;右上只剩使用教程和账号 */}
        {!phone && (
          <div className="mw-acts">
            {wallBtn}
            {guideBtn}
            {!empty && (
              <>
                <button className="mw-btn" data-act="open-file" onClick={pickFile}>
                  <Icon name="file" size={16} />
                  打开存档文件
                </button>
                <button className="mw-btn blue" data-act="new-world" onClick={onNew}>
                  <Icon name="plus" size={16} />
                  新建世界
                </button>
              </>
            )}
            {acctBtn && (
              <>
                <span className="mw-sep" aria-hidden="true" />
                {acctBtn}
              </>
            )}
          </div>
        )}
      </header>
      {barOn && <SpaceBar state={space.bar!} phone={phone} onClose={space.closeBar} onLook={openSpace} />}
      {/* 页签:有世界时才有;一个世界都没有、「我的规则」里有规则时也有(规则不跟着世界走;正看着「规则」时删光了也留着) */}
      {(!empty || (rulesOn && (myRulesN > 0 || tab === 'rules'))) && (
        <div className="mw-seg" role="tablist" aria-label="看地图还是文明">
          <button role="tab" aria-selected={tab === 'maps'} className={tab === 'maps' ? 'on' : ''} data-tab="maps" onClick={() => setView({ tab: 'maps' })}>
            地图<i>{groups.length}</i>
          </button>
          <button role="tab" aria-selected={tab === 'civs'} className={tab === 'civs' ? 'on' : ''} data-tab="civs" onClick={() => setView({ tab: 'civs' })}>
            文明<i>{civs.length}</i>
          </button>
          {rulesOn && (
            <button role="tab" aria-selected={tab === 'rules'} className={tab === 'rules' ? 'on' : ''} data-tab="rules" onClick={() => setView({ tab: 'rules' })}>
              规则
            </button>
          )}
        </div>
      )}
      {rulesTab && <RulesTabHost phone={phone} fileBtn={!empty} />}
      {empty && !rulesTab && (
        <div className={`mw-empty${feOn ? ' with-fe' : ''}`}>
          <HomeGlobe size={feOn ? (phone ? 104 : 150) : phone ? 150 : 188} />
          <h2>还没有世界</h2>
          {feOn && phone ? (
            <p>
              <span>打造一颗独属于你的星球，</span>
              <span>有大陆、海洋、气候，还有城市、文明、种族，</span>
              <span>以及在你引导下推演出来的历史。</span>
            </p>
          ) : (
            <p>
              <span>打造一颗独属于你的星球，</span>
              <span>它有大陆、海洋、气候、洋流……</span>
              <span>还有城市、文明、种族……</span>
              <span>以及在你引导下推演出来的历史。</span>
            </p>
          )}
          <button className="mw-btn blue big" data-act="new-world" onClick={onNew}>
            <Icon name="plus" size={18} />
            新建世界
          </button>
          <button className="mw-or" data-act="open-file" onClick={pickFile}>
            或者打开存档文件
          </button>
          {!(feOn && phone) && (
            <p className="mw-note">
              <span>无需登录。</span>
              <span>做出来的世界归你，我们不主张任何权利。</span>
            </p>
          )}
        </div>
      )}
      {feOn && !rulesTab && <GalleryFeatured phone={phone} onOpen={onOpenWork!} onGallery={onGallery!} />}
      {!empty && tab === 'maps' && <MapGrid groups={groups} phone={phone} pick={pick} onPick={(k) => setView({ pick: k })} onOpen={onOpen} onNewCiv={onNewCiv} waitOf={waitOf} />}
      {!empty && tab === 'civs' && !civs.length && <p className="mw-none">还没有文明。到「地图」里选一张地图打造文明，或者新建世界。</p>}
      {!empty && tab === 'civs' && civs.length > 0 && (
        <div className="mw-grid" role="list">
          {civs.map((w) => (
            <WorldCard
              key={w.id}
              w={w}
              phone={phone}
              old={oldIds.has(w.id)}
              menuOpen={menu === w.id}
              onMenu={(o) => setMenu(o ? w.id : null)}
              renaming={renaming === w.id}
              onRename={(o) => setRenaming(o ? w.id : null)}
              onOpen={() => onOpen(w.id)}
              onNewCiv={() => onNewCiv(w.id)}
              wait={waitOf(w.id, 'card')}
            />
          ))}
        </div>
      )}
      {phone && !empty && (
        <div className="mw-open-file sb-group">
          <button className="sb-row" data-act="open-file" onClick={pickFile}>
            <Icon name="file" size={18} className="sb-ico" />
            <span className="sb-row-main">
              <b>打开存档文件</b>
            </span>
            <Icon name="chevron" size={14} className="sb-chev" />
          </button>
        </div>
      )}
      {phone && !empty && space.used !== null && <SpaceEntry used={space.used} phone onClick={openSpace} />}
      {!phone && (
        <footer className="mw-foot">
          <a href={SOURCE_URL} target="_blank" rel="noreferrer" data-link="source">
            源代码
          </a>
          <a href={PRIVACY_URL} target="_blank" rel="noreferrer" data-link="privacy">
            隐私政策
          </a>
          <a href={TERMS_URL} target="_blank" rel="noreferrer" data-link="terms">
            用户协议
          </a>
          <ContactLink />
          <BeianLinks className="mw-beian" />
          {!empty && space.used !== null && <SpaceEntry used={space.used} phone={false} onClick={openSpace} />}
          <VersionText className="mw-ver" />
        </footer>
      )}
      {phone && BEIAN.length > 0 && (
        <footer className="mw-foot solo">
          <BeianLinks className="mw-beian" />
        </footer>
      )}
      {SpaceWin && <SpaceWin phone={phone} onClose={() => setSpaceWin(null)} onDelete={(id, name) => removeWorld(id, name)} />}
    </div>
  );
}

/** 长按多久算长按(毫秒;手机上开卡片的菜单) */
const LONG_PRESS = 480;

/** 卡片时间前面的小云:传过整个世界的才有。没再改的带勾,改过的带向上箭头 */
function FullMark({ w }: { w: StoredWorld }) {
  const fo = useFullOverview();
  useSavesVersion();
  const kind = fo ? fullStatusOf(fo, w.id, w.save).kind : 'never';
  if (kind === 'never') return null;
  const same = kind === 'same';
  return (
    <span className="mw-full" data-full={kind} title={same ? '整个世界已传到账号' : '传到账号以后又改过'}>
      <Icon name={same ? 'cloudok' : 'cloudup'} size={14} />
    </span>
  );
}

/** 没有比现在旧的世界就不读:首页不该为它下载世界仓库 */
function useOldWorlds(worlds: readonly StoredWorld[]): ReadonlySet<string> {
  const v = useSavesVersion();
  const ids = worlds.filter((w) => !w.draft && !w.map && w.save.generator < GENERATOR_VERSION).map((w) => w.id);
  const key = ids.join();
  const [olds, setOlds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!key) return setOlds((s) => (s.size ? new Set() : s));
    let live = true;
    void import('./worldStore')
      .then((m) => Promise.all(key.split(',').map(async (id) => ((await m.contentTrouble(id)) === 'old' ? id : ''))))
      .then((r) => {
        if (live) setOlds(new Set(r.filter(Boolean)));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, v]);
  return olds;
}

function WorldCard({
  w,
  phone,
  menuOpen,
  onMenu,
  renaming,
  onRename,
  onOpen,
  onNewCiv,
  wait,
  old,
}: {
  w: StoredWorld;
  phone: boolean;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  renaming: boolean;
  onRename: (on: boolean) => void;
  onOpen: () => void;
  onNewCiv: () => void;
  /** 点了打开、地图程序还没下完 */
  wait?: Wait;
  old?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  /** 长按:按下的计时器;长按开了菜单以后,松手那一下的点击不算打开 */
  const press = useRef<{ t: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const longFired = useRef(false);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) onMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onMenu(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [menuOpen, onMenu]);
  useEffect(
    () => () => {
      if (press.current) clearTimeout(press.current.t);
    },
    [],
  );

  // 存成文件有多大:菜单开着才算
  const [sizeNote, setSizeNote] = useState<string | null>(null);
  const [sizeBytes, setSizeBytes] = useState<number | null>(null);
  const hasFile = !w.draft && !w.map && !old;
  useEffect(() => {
    if (!menuOpen || !hasFile) return;
    let live = true;
    import('./worldFileFlow')
      .then((m) => m.fileSizeOf(w.id))
      .then((got) => {
        if (!live) return;
        setSizeNote(got?.note ?? null);
        setSizeBytes(got?.bytes ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [menuOpen, hasFile, w.id]);
  const name = w.save.title || '未命名世界';
  const act = (f: () => void) => () => {
    onMenu(false);
    f();
  };
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.t);
    press.current = null;
  };
  return (
    <div ref={root} className={`mw-card${w.draft ? ' draft' : ''}${menuOpen ? ' menu-on' : ''}`} role="listitem" data-id={w.id}>
      <button
        className="mw-open"
        data-act="open-world"
        onClick={() => {
          if (longFired.current) {
            longFired.current = false;
            return;
          }
          if (!renaming) onOpen();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu(true);
        }}
        onPointerDown={(e) => {
          if (e.pointerType !== 'touch') return;
          longFired.current = false;
          cancelPress();
          press.current = {
            x: e.clientX,
            y: e.clientY,
            t: setTimeout(() => {
              press.current = null;
              longFired.current = true;
              onMenu(true);
            }, LONG_PRESS),
          };
        }}
        onPointerMove={(e) => {
          const p = press.current;
          if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) cancelPress();
        }}
        onPointerUp={cancelPress}
        onPointerCancel={cancelPress}
        title={w.draft ? '接着建这个世界' : old ? '打开这个世界（只存了配方，打开时按新版算）' : '打开这个世界'}
      >
        <span className={`mw-thumb${wait ? ' wait' : ''}`} style={w.thumb ? { backgroundImage: `url(${w.thumb})` } : undefined}>
          {w.draft && <span className="mw-tag">没建完</span>}
          {old ? <span className="mw-tag" title="打开这个世界（只存了配方，打开时按新版算）">按新版算</span> : !w.draft && w.save.edits.play && <span className="mw-tag">逐年推演</span>}
          {wait && <OpenRing pct={wait.pct} />}
        </span>
        {phone ? (
          <span className="mw-meta">
            {!renaming && <b className="mw-name">{name}</b>}
            <span className="mw-line">{wait ? (wait.line ?? openLine(wait.pct, true)) : worldLine(w)}</span>
            <span className="mw-time">
              <FullMark w={w} />
              {when(w.at)}
            </span>
          </span>
        ) : (
          <span className="mw-meta">
            <span className="mw-row1">
              {!renaming && <b className="mw-name">{name}</b>}
              <span className="mw-time">
                <FullMark w={w} />
                {when(w.at)}
              </span>
            </span>
            <span className="mw-line">{wait ? (wait.line ?? openLine(wait.pct, false)) : worldLine(w)}</span>
          </span>
        )}
      </button>
      {renaming && (
        <div className="mw-rename">
          <TitleInput
            className="mw-title-input"
            initial={w.save.title ?? ''}
            onDone={(v) => {
              onRename(false);
              if (v !== null) renameWorld(w.id, v);
            }}
          />
        </div>
      )}
      {!phone && (
        <button className={`mw-dots${menuOpen ? ' on' : ''}`} data-act="world-menu" aria-label="更多" title="更多" onClick={() => onMenu(!menuOpen)}>
          <Icon name="more" size={18} />
        </button>
      )}
      {menuOpen && (
        <div className="pm-menu mw-menu" role="menu">
          <button className="pm-item" data-act="world-rename" onClick={act(() => onRename(true))}>
            <Icon name="rename" size={16} />
            <span className="pm-text">改名</span>
          </button>
          {w.draft && <FullCardItem id={w.id} w={w} recipe sizeNote="几 KB" bytes={null} onDone={() => onMenu(false)} />}
          {!w.draft && (
            <>
              <button
                className="pm-item"
                data-act="world-copy"
                onClick={act(() => {
                  const id = duplicateWorld(w.id);
                  if (!id) return notify({ kind: 'error', text: '没能复制', more: [storageFullWhy()] });
                  const more = [`新的叫「${loadWorld(id)?.save.title ?? ''}」`];
                  // AI 写的史书、名字由来跟着复制;存不下就说一声(这一页里还看得到,刷新以后没有)
                  if (!copyNotes(w.id, id)) more.push('AI 写的史书、名字由来没能一起存下（浏览器存储已满）');
                  void copyResults(w.id, id);
                  void import('./worldStore')
                    .then((m) => m.copyWorldPlugins(w.id, id))
                    .catch(() => ({ status: 'failed' } as const))
                    .then((r) => {
                      const pluginTrouble: Partial<Record<typeof r.status, string>> = {
                        conflict: '用到的插件没能一起存下：副本已经被后台转存抢先写下了第一份内容。删掉这一份、重新复制一次通常就好（不是存储满了）',
                        unreadable: '用到的插件没能一起存下：源世界的插件内容读不出来（可能已经损坏），这一份副本打开后可能和原来不一样',
                        full: '用到的插件没能一起存下（浏览器存储已满）',
                        unavailable: '用到的插件没能一起存下（浏览器不让用本地存储）',
                        failed: '用到的插件没能一起存下（原因不明，可以再试一次）',
                      };
                      const trouble = pluginTrouble[r.status];
                      if (trouble) more.push(trouble);
                      notify({ kind: trouble || more.length > 1 ? 'warn' : 'ok', text: `已复制一份「${name}」`, more });
                    });
                })}
              >
                <Icon name="copy" size={16} />
                <span className="pm-text">复制一份</span>
              </button>
              <button className="pm-item" data-act="world-new-civ" onClick={act(onNewCiv)}>
                <Icon name="map" size={16} />
                <span className="pm-text">在这张地图上打造新文明</span>
              </button>
              <button
                className="pm-item"
                data-act="world-file"
                onClick={act(() => {
                  // 别的页面里可能删了
                  if (!loadWorld(w.id)) return notify({ kind: 'error', text: '打不开这个存档', more: ['可能已在别的页面里删掉了'] });
                  withFileFlow('没能存成文件', (m) => (old ? m.saveWorldRecipe(w.id) : m.saveWorldToFile(w.id)));
                })}
              >
                <Icon name="save" size={16} />
                <span className="pm-text">{old ? '存配方文件' : '存成文件'}</span>
                {old ? <small className="pm-note">几 KB</small> : sizeNote && <small className="pm-note">{sizeNote}</small>}
              </button>
              <FullCardItem id={w.id} w={w} recipe={!!old} sizeNote={old ? '几 KB' : sizeNote} bytes={old ? null : sizeBytes} onDone={() => onMenu(false)} />
            </>
          )}
          <hr className="pm-sep" />
          <button
            className="pm-item red"
            data-act="world-delete"
            onClick={act(() => removeWorld(w.id, name))}
          >
            <Icon name="trash" size={16} />
            <span className="pm-text">删除</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** 卡片菜单里「传到账号」那一项:服务器开了才有 */
function FullCardItem({ id, w, recipe, sizeNote, bytes, onDone }: { id: string; w: StoredWorld; /** 只有配方的世界:传的也是配方,限额管不着 */ recipe?: boolean; sizeNote: string | null; bytes: number | null; onDone: () => void }) {
  const fo = useFullOverview();
  const job = useFullJob();
  if (!fo) return null;
  const st = fullStatusOf(fo, id, w.save);
  const refusal = recipe ? null : refusalOf(fo, id, bytes);
  const label = job?.id === id ? '正在传到账号' : st.kind === 'same' ? '已传到账号' : (st.kind === 'changed' || (st.kind === 'recipe' && recipe)) && !refusal ? '再传一次' : '传到账号';
  const note = job ? (job.id === id ? '' : '等一下') : st.kind === 'same' ? fullDay(st.entry.uploadedAt) : refusal ? REFUSAL_NOTE[refusal] : st.kind === 'changed' ? '改过了' : sizeNote;
  const click = () => {
    onDone();
    if (st.kind === 'same' && !job) return openAccount();
    void import('./fullWorldFlow').then((m) => (fullJob() || recipe ? m.uploadWorld(id) : m.uploadFromCard(id)));
  };
  return (
    <button className="pm-item" data-act="world-full" onClick={click}>
      <Icon name={st.kind === 'same' ? 'cloudok' : 'cloudup'} size={16} />
      <span className="pm-text">{label}</span>
      {note && <small className="pm-note">{note}</small>}
    </button>
  );
}

/** 删掉一个世界(或只存了地图的那一份):点一下就删,不再问;提示条上的"撤销"兜底(提示条还在的时候点,放回原处)。账号里那份不动,要在账号窗里删 */
function removeWorld(id: string, name: string) {
  const inAccount = !!fullOverview()?.account.some((w) => w.id === id);
  const gone = deleteWorld(id);
  // 别的页面里已经删掉了(这一页的列表还没跟上):没有可撤销的
  if (!gone) return notify({ kind: 'ok', text: `「${name}」已在别的页面里删掉了` });
  // 提示条还在、还能撤销的这段时间,内容绝不清;收起以后存储紧张就马上腾地方(那段代码不在首页那一份里,用到才下)。撤销了又没放回去的,这次打开先不清
  const free = holdWorld(id);
  let undoFailed = false;
  notify({
    kind: 'ok',
    text: `已删除「${name}」`,
    ...(inAccount ? { more: ['账号里那份还在，要删到账号窗里删'] } : {}),
    action: {
      label: '撤销',
      act: 'world-undelete',
      onClick: () => {
        if (restoreWorld(gone)) return notify(null);
        undoFailed = true;
        notify({ kind: 'error', text: '没能放回去', more: ['浏览器存储已满'] });
      },
    },
    onGone: () => {
      if (undoFailed) return;
      free();
      spaceChanged();
      void import('./worldStore').then((m) => m.trashFreed(id)).catch(() => {});
    },
  });
}

/** 展开那块里一个文明的第二行:"现存 15 国" */
function civLine(w: StoredWorld): string {
  if (w.draft) return '还在新建';
  if (w.alive === undefined) return `种子 ${w.save.seed}`;
  return w.alive ? `现存 ${w.alive} 国` : '没长出国家';
}

/**
 * 「地图」页签:一张地图一张卡片;选中的那张所在的那一行下面展开它上面的文明(网格里插一块占满一行的)。
 * 展开那块上面的小尖角对着选中的卡片
 */
function MapGrid({
  groups,
  phone,
  pick,
  onPick,
  onOpen,
  onNewCiv,
  waitOf,
}: {
  groups: MapGroup[];
  phone: boolean;
  pick: string | null;
  onPick: (key: string | null) => void;
  onOpen: (id: string) => void;
  onNewCiv: (id: string, at?: WaitAt) => void;
  waitOf: WaitOf;
}) {
  const grid = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(phone ? 2 : 4);
  useLayoutEffect(() => {
    const el = grid.current;
    if (!el) return;
    const count = () => setCols(Math.max(1, getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length));
    count();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(count);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phone]);
  const sel = groups.findIndex((g) => g.key === pick);
  // 选中的那张没了(删掉了):不展开
  const at = sel < 0 ? -1 : Math.min(groups.length - 1, Math.floor(sel / cols) * cols + cols - 1);
  return (
    <div ref={grid} className="mw-grid mw-maps" role="list">
      {groups.map((g, i) => (
        <Fragment key={g.key}>
          <div className={`mw-card mw-map${i === sel ? ' on' : ''}`} role="listitem" data-map={g.key}>
            <button className="mw-open" data-act="pick-map" aria-expanded={i === sel} onClick={() => onPick(i === sel ? null : g.key)}>
              <span className="mw-thumb" style={g.thumb ? { backgroundImage: `url(${g.thumb})` } : undefined} />
              <span className="mw-meta">
                <span className="mw-row1">
                  <b className="mw-name">{mapName(g.head)}</b>
                </span>
                <span className="mw-line">{mapLine(g, phone)}</span>
              </span>
            </button>
          </div>
          {i === at && <MapPanel g={groups[sel]} col={sel % cols} cols={cols} phone={phone} onOpen={onOpen} onNewCiv={onNewCiv} waitOf={waitOf} />}
        </Fragment>
      ))}
    </div>
  );
}

/** 选中的地图下面展开的那块 */
function MapPanel({
  g,
  col,
  cols,
  phone,
  onOpen,
  onNewCiv,
  waitOf,
}: {
  g: MapGroup;
  col: number;
  cols: number;
  phone: boolean;
  onOpen: (id: string) => void;
  onNewCiv: (id: string, at?: WaitAt) => void;
  waitOf: WaitOf;
}) {
  const n = g.civs.length;
  const submitOn = useSubmitOn(true);
  const banned = useSubmitBan();
  // 在哪个世界的地图上打造:地图那一份 / 最早那个世界 / 最近的一个建好的文明(都是同一张地图;没建完的不算)
  const from = g.head.id;
  const src = (g.map ?? (g.head.draft ? g.civs.find((w) => !w.draft) : g.head))?.id;
  const style = { '--col': col, '--cols': cols } as React.CSSProperties;
  if (!n) {
    return (
      <div className="mw-panel empty" role="group" aria-label="这张地图上还没有文明" style={style}>
        <i className="mw-caret" aria-hidden="true" />
        <div className="mw-panel-hd">
          <b>这张地图上还没有文明</b>
          {!phone && <span>{mapBrief(g.head)}</span>}
        </div>
        <p className="mw-panel-txt">打造文明会在这张地图上从第 0 年推演：民族、国家、城都从头长出来。地图本身不再变。</p>
        <div className="mw-panel-acts">
          <button className={`mw-btn blue${phone ? ' wide' : ''}${waitOf(from, 'btn') ? ' wait' : ''}`} data-act="map-new-civ" onClick={() => onNewCiv(from, 'btn')}>
            {waitOf(from, 'btn') ? (
              <WaitLabel />
            ) : (
              <>
                <Icon name="plus" size={16} />
                打造文明
              </>
            )}
          </button>
          {submitOn && g.head.map && (
            <button
              className={`mw-btn${phone ? ' wide' : ''}${banned ? ' off' : ''}`}
              data-act="map-submit"
              aria-disabled={banned ? true : undefined}
              onClick={() => {
                const go = () => openSubmitDialog({ kind: 'map', worldId: from, title: mapName(g.head) }, banned ? 'ban' : undefined);
                if (!banned && phoneRequired()) askPhone({ for: 'submit', then: go });
                else go();
              }}
            >
              <Icon name="image" size={16} />
              <span>投到作品墙…</span>
            </button>
          )}
          <button className={`mw-btn${phone ? ' wide' : ''}`} data-act="map-delete" onClick={() => removeWorld(from, mapName(g.head))}>
            删除这张地图
          </button>
        </div>
      </div>
    );
  }
  const add = src && (
    <button className={`mw-btn blue${phone ? ' wide' : ''}${waitOf(src, 'btn') ? ' wait' : ''}`} data-act="map-new-civ" onClick={() => onNewCiv(src, 'btn')}>
      {waitOf(src, 'btn') ? (
        <WaitLabel />
      ) : (
        <>
          <Icon name="plus" size={16} />
          打造新文明
        </>
      )}
    </button>
  );
  return (
    <div className="mw-panel" role="group" aria-label={`这张地图上的 ${n} 个文明`} style={style}>
      <i className="mw-caret" aria-hidden="true" />
      <div className="mw-panel-hd">
        <b>这张地图上的 {n} 个文明</b>
        {!phone && <span>{mapBrief(g.head)}</span>}
        {!phone && add}
      </div>
      {phone ? (
        <div className="mw-panel-list" role="list">
          {g.civs.map((w) => {
            const wait = waitOf(w.id, 'card');
            return (
              <button key={w.id} className="mw-civ-row" role="listitem" data-id={w.id} data-act="open-world" onClick={() => onOpen(w.id)}>
                <span className={`mw-civ-th${wait ? ' wait' : ''}`} style={w.thumb ? { backgroundImage: `url(${w.thumb})` } : undefined}>
                  {wait && <OpenRing pct={wait.pct} />}
                </span>
                <span className="mw-civ-meta">
                  <b>{civName(w)}</b>
                  <span>{wait ? openLine(wait.pct, true) : civLine(w)}</span>
                </span>
                <Icon name="chevron" size={14} className="mw-civ-chev" />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="mw-panel-grid" role="list">
          {g.civs.map((w) => {
            const wait = waitOf(w.id, 'card');
            return (
              <div key={w.id} className={`mw-card${w.draft ? ' draft' : ''}`} role="listitem" data-id={w.id}>
                <button className="mw-open" data-act="open-world" onClick={() => onOpen(w.id)} title={w.draft ? '接着建这个文明' : '打开这个文明'}>
                  <span className={`mw-thumb${wait ? ' wait' : ''}`} style={w.thumb ? { backgroundImage: `url(${w.thumb})` } : undefined}>
                    {w.draft && <span className="mw-tag">没建完</span>}
                    {wait && <OpenRing pct={wait.pct} />}
                  </span>
                  <span className="mw-meta">
                    <span className="mw-row1">
                      <b className="mw-name">{civName(w)}</b>
                      <span className="mw-time">{when(w.at)}</span>
                    </span>
                    <span className="mw-line">{wait ? openLine(wait.pct, false) : civLine(w)}</span>
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}
      {phone && add}
    </div>
  );
}

/** 还剩几天清除 */
function purgeIn(iso: string): string {
  const days = Math.ceil((Date.parse(iso) - Date.now()) / 86400e3);
  return Number.isFinite(days) ? (days <= 1 ? '明天清除' : `${days} 天后清除`) : '';
}

/** 最近删除:照「我的世界」的卡片,点一张找回 */
function TrashPage({ phone }: { phone: boolean }) {
  const [list, setList] = useState<TrashEntry[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    listTrash()
      .then((l) => live && setList(l))
      .catch((e) => live && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);
  const restore = async (t: TrashEntry) => {
    if (busy) return;
    setBusy(t.id);
    try {
      const r = await restoreTrash(t.id);
      setList((l) => (l ?? []).filter((x) => x.id !== t.id));
      const lost = r.full === 'no-room' ? '账号里放不下它的整个世界，只找回了配方。腾出地方后再传' : r.full === 'gone' ? '它的整个世界已经清掉了，只找回了配方' : null;
      notify({ kind: 'ok', text: `已找回「${t.title || '未命名世界'}」`, more: [lost ?? '回到账号里了。这台设备上没有的话，到账号窗点「取回」'] });
      void askFull();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  const back = (
    <button className={`mw-btn${phone ? ' round' : ''}`} data-act="trash-back" onClick={() => closeTrash()}>
      <Icon name="back" size={16} />
      我的世界
    </button>
  );
  return (
    <div className={`mw${phone ? ' mw-phone' : ''}`} role="main" aria-label="最近删除" onPointerDown={stop} onClick={stop} onDoubleClick={stop} onWheel={stop}>
      <header className="mw-top">
        {phone && <div className="mw-bar has-acct">{back}</div>}
        <div className="mw-heading">
          <h1>最近删除</h1>
          <p>删掉的世界在这里留 30 天，点一下就能找回。</p>
        </div>
        {!phone && <div className="mw-acts">{back}</div>}
      </header>
      {list && list.length > 0 && (
        <div className="mw-grid" role="list">
          {list.map((t) => {
            const alive = typeof t.meta?.alive === 'number' ? (t.meta.alive as number) : undefined;
            const line = `种子 ${t.seed ?? '?'}${alive === undefined ? '' : alive ? `，现存 ${alive} 国` : '，没有文明'}`;
            return (
              <div className="mw-card" role="listitem" key={t.id} data-id={t.id}>
                <button className="mw-open" data-act="restore-world" disabled={!!busy} onClick={() => void restore(t)} title="找回这个世界">
                  <span className="mw-thumb" style={t.thumb ? { backgroundImage: `url(${t.thumb})` } : undefined} />
                  {phone ? (
                    <span className="mw-meta">
                      <b className="mw-name">{t.title || '未命名世界'}</b>
                      <span className="mw-line">{line}</span>
                      <span className="mw-time">{busy === t.id ? '正在找回' : purgeIn(t.purgeAt)}</span>
                    </span>
                  ) : (
                    <span className="mw-meta">
                      <span className="mw-row1">
                        <b className="mw-name">{t.title || '未命名世界'}</b>
                        <span className="mw-time">{busy === t.id ? '正在找回' : purgeIn(t.purgeAt)}</span>
                      </span>
                      <span className="mw-line">{line}</span>
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {list && !list.length && <p className="mw-empty">最近删除里没有世界</p>}
      {err && <p className="mw-empty">{err}</p>}
    </div>
  );
}
