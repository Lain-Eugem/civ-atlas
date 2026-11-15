/**
 * 世界卡片头部的"存档"菜单:只管正在看的这一个世界(打开别的世界、从文件打开在"我的世界"那一页,见 MyWorlds.tsx) ——
 *
 *   当前世界:缩略图、名字、种子、地形改过几处、"已自动存在这个浏览器里"(打开的链接还没动过 = 还没存)
 *   存成文件:整个世界存成 .civworld(worldFileFlow.ts;小字写多大,要打包才知道的不写);没有内容可存的存 .json
 *   复制配方链接:整份存档压缩进网址的 # 后面(gen/savefile.ts 的 encodeShare),复制到剪贴板;
 *     没有修改 = 普通网址(只带种子、参数);剪贴板用不了:菜单留着,里面多一行选中了链接的输入框,让用户自己复制。
 *     下面一行勾选「停在这一刻」(shareMoment.tsx):勾着就带上时间轴那一年、选中的国家或州、地图的位置和大小,
 *     对方打开停在那里(不自动播放);默认勾着,记住上次的选择
 *   从文件打开进来的:当前世界那一行多一句「来自文件」和哪天打开的(只在这台设备上记)
 *   登录了网站账号:"复制配方链接"换成"分享…"(短链接,随时能停,AccountPanels.tsx 的分享窗)
 *   传到账号:服务器开了才有(fullWorldView.ts),点了才传;传过的换成「已传到账号」「再传一次」,分享那一项跟着说对方看到什么
 *   投到作品墙…:登录了、服务器开着投世界才有(submitView.ts);账号停了投稿时它和「分享…」都灰着,点了说原因
 *   看原样:旧版本建的世界(留着原来那一份,saveStore 的 currentOriginal)到那一版的旧网站里打开,新页面(oldSite.ts)
 *   按新版另存一份:照原样打开的旧世界(没有重新生成,FrozenWorld.tsx)另存一份按新版推演;这时不放「看原样」(看到的就是原样)。
 *                   存的内容读不出、先按新版算了一遍的世界也放:那一份不自动存,要留着看到的样子只能另存(「看原样」照放)
 *
 * 存、读、列都在 saveStore.ts。存储满了之类的提示(saveStore 的 notify)显示在顶部的提示条上。
 * ⌘S 打开这个菜单(openSaveMenu;世界本来就自动存着,菜单上写着存没存好)。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SHARE_WARN_LENGTH } from '../gen/savefile';
import { useEdits } from './editsStore';
import { currentOriginal, currentWorld, keptFrom, loadWorld, persistent, storageFullWhy, storageIsFull, useSavesVersion } from './saveStore';
import { appleDevice, askPersisted, fileRecords, fileStatus, onSpaceChange, saveMark, vaultFullSeen } from './spaceFacts';
import { withFileFlow } from './worldFileLazy';
import { OLD_SITE, oldSiteFor, openOriginal } from './oldSite';
import { openFailed } from './openTrouble';
import { Icon } from './icons';
import { noteDismiss } from './dismissClick';
import { openAccount, openShareAsk, openShareDialog, openSubmitDialog } from './AccountDialogs';
import { askFull, fullStatusOf, refusalOf, useFullJob, useFullOverview, type FullStatus } from './fullWorldView';
import { menuItem, shareItem } from './fullWorldWords';
import { showToast } from './toastStore';
import { useSession } from '../account/session';
import { saveAsNew } from './FrozenWorld';
import { LONG_HINT, MomentCheck, copyShareLink, momentNow, shareCopiedToast, useMomentOn } from './shareMoment';
import { contentTrouble, pendingOf, simWaitOf } from './worldStore';
import { SHARE_BANNED, SUBMIT_WORLD_MAX, askPhone, phoneRequired, submitMenuItem, useSubmitBan, useSubmitWorldOn, type SubmitWork } from './submitView';
import { RemoveDataItem, pluginNames, usePluginData } from './plugins/saveItems';
import { useNarrow } from './device';
import { SIM_NO_LINK, simWaitText, useSimLinkOff } from './world/simAsk';
import { MAP_NO_LINK, useMapLinkOff } from './world/mapAsk';
import { pluginsUiOn } from './plugins/flag';

export interface SaveMenuProps {
  /** 世界生成完了(能存) */
  ready: boolean;
  /** 按钮上文字前面的小图标 */
  icon?: ReactNode;
}

/** 当前世界存成文件(菜单里的"存成文件"、存储满了时提示条上的"存成文件") */
function saveCurrentFile() {
  withFileFlow('没能存成文件', (m) => m.saveCurrentToFile());
}

/** 传到账号的代码用到才下载;下载不下来顶上说一句 */
function withFullFlow(f: (m: typeof import('./fullWorldFlow')) => unknown) {
  import('./fullWorldFlow').then(f, () => showToast({ id: 'world-full', kind: 'error', text: '没传成，世界在本机没事', more: ['网络断了，或者网站刚更新过，重新加载试试'], action: { label: '重新加载', act: 'world-file-reload', onClick: () => location.reload() } }));
}

const RECIPE_HINT = '对方打开时重新长一遍，可能和你看到的不一样';
const NO_LINK = '地图带不进链接，对方打不开。要发给别人，请存成文件';
const PLUGIN_DATA_SHARE = '带着插件的附加数据，不能公开分享。可以存成文件发给对方';

/** 菜单上写的:来自文件，11 月 4 日打开(不是今年的带上年) */
function fromFileLine(iso: string): string {
  const d = new Date(iso);
  const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()} 年 `;
  return `来自文件，${year}${d.getMonth() + 1} 月 ${d.getDate()} 日打开`;
}

/** 剪贴板用不了:菜单里一行"没能自动复制",下面是选中了链接的输入框(不另开窗口) */
function ManualCopy({ url }: { url: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [url]);
  return (
    <div className="save-manual" data-testid="share-manual">
      <span>{url.length > SHARE_WARN_LENGTH ? `没能自动复制，请手动复制。${LONG_HINT}` : '没能自动复制，请手动复制'}</span>
      <input ref={ref} readOnly value={url} spellCheck={false} aria-label="配方链接" onFocus={(e) => e.currentTarget.select()} />
    </div>
  );
}

function Thumb({ src }: { src: string | null }) {
  return src ? <img className="save-thumb" src={src} alt="" draggable={false} /> : <div className="save-thumb empty" />;
}

/** 页面上的存档菜单(宽屏侧栏顶上一个;手机在世界卡片里):⌘S 打开看得见的那一个 */
const openers = new Set<{ root: () => HTMLElement | null; open: () => void }>();

/** ⌘S:打开看得见的那个存档菜单(已经开着就留着);没有看得见的 = false */
export function openSaveMenu(): boolean {
  for (const o of openers) {
    const el = o.root();
    if (!el || !el.getClientRects().length || el.closest('[inert]')) continue;
    o.open();
    return true;
  }
  return false;
}

export function SaveMenu({ ready, icon }: SaveMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const o = { root: () => rootRef.current, open: () => setOpen(true) };
    openers.add(o);
    return () => {
      openers.delete(o);
    };
  }, []);
  const v = useSavesVersion();
  const edits = useEdits();
  const cur = ready ? currentWorld() : null;
  const curStored = useMemo(() => (open && cur ? loadWorld(cur.id) : null), [open, cur, v]);
  const keep = persistent();
  const [, spaceTick] = useState(0);
  useEffect(() => onSpaceChange(() => spaceTick((n) => n + 1)), []);
  const full = storageIsFull() || vaultFullSeen();
  const session = useSession();
  const curId = cur?.id;
  const simOff = useSimLinkOff();
  // 用了地图插件:配方里没有插件,和地图留着的世界一样不给配方链接
  const mapOff = useMapLinkOff();
  const oldRecipe = cur?.oldRecipe !== undefined;
  const kept = keptFrom(edits);
  const [failedId, setFailedId] = useState<string | null>(null);
  const checkFailed = open && !!curId && !!curStored && !curStored.draft && !curStored.map && !oldRecipe && !kept;
  useEffect(() => {
    if (!checkFailed || !curId) return;
    let live = true;
    void contentTrouble(curId).then((t) => {
      if (live) setFailedId(t === 'failed' ? curId : null);
    });
    return () => {
      live = false;
    };
  }, [checkFailed, curId, v]);
  const failed = checkFailed && failedId === curId;
  // 用了推演插件、本机没有同一版:内容先照原样留着,等装上再存
  const [simWait, setSimWait] = useState<{ id: string; ids: string[] } | null>(null);
  useEffect(() => {
    if (!open || !curId || !pluginsUiOn()) return;
    let live = true;
    void simWaitOf(curId).then((ids) => live && setSimWait(ids.length ? { id: curId, ids } : null));
    return () => {
      live = false;
    };
  }, [open, curId, v]);
  const recipeOnly = oldRecipe || failed;
  // 存成文件有多大:菜单开着才算;存储满了时写不准(页面里的比存着的新),不写
  const [size, setSize] = useState<{ id: string; note: string; bytes: number } | null>(null);
  const hasFile = !!curStored && !curStored.draft && !curStored.map && !full && !recipeOnly;
  useEffect(() => {
    if (!open || !curId || !hasFile) return;
    let live = true;
    import('./worldFileFlow')
      .then((m) => m.fileSizeOf(curId))
      .then((got) => {
        if (live && got) setSize({ id: curId, ...got });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, curId, hasFile]);
  const sizeNote = size && hasFile && size.id === curId ? `，${size.note}` : '';
  // 传到账号:服务器开了才有。菜单开着才问用了多少,问不到就不灰,点了听服务器的
  const fo = useFullOverview();
  const fullJob = useFullJob();
  const fullOn = !!session && !!fo;
  useEffect(() => {
    if (open && session) void askFull();
  }, [open, !!session]);
  // 投到作品墙:只投有历史的世界(新建中、只有地图的、只剩配方的不露;地图在我的世界「地图」里投)
  const submitOn = useSubmitWorldOn(open) && !!cur && cur.kind !== 'draft' && !curStored?.draft && !curStored?.map && !recipeOnly;
  const banned = useSubmitBan();
  const [pendingId, setPendingId] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !curId || !(fullOn || submitOn)) return;
    let live = true;
    void pendingOf(curId).then((p) => {
      if (live) setPendingId(p === 'none' ? null : curId);
    });
    return () => {
      live = false;
    };
  }, [open, curId, fullOn, submitOn, v]);
  const [extras, setExtras] = useState<{ id: string; parts: string[] } | null>(null);
  useEffect(() => {
    if (!open || !curId || !submitOn || !hasFile) return;
    let live = true;
    import('./worldFileFlow')
      .then((m) => m.extraPartsOf(curId))
      .then((parts) => live && setExtras({ id: curId, parts }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, curId, submitOn, hasFile, v]);
  // 插件存了自己数据的世界:不能公开分享(网站看不到里面),能存成文件、能去掉那些数据
  const plgData = usePluginData(open && hasFile, curId, v);
  const plgNames = pluginNames(plgData);
  const narrow = useNarrow();
  const fullStatus: FullStatus = fo && curId ? fullStatusOf(fo, curId, curStored?.save) : { kind: 'never' };
  const fullBytes = size && hasFile && size.id === curId ? size.bytes : null;
  const fullItem = open && fo && fullOn && curId ? menuItem({ id: curId, status: fullStatus, refusal: refusalOf(fo, curId, fullBytes), job: fullJob, bytes: fullBytes, overview: fo, recipeOnly: oldRecipe || !!curStored?.draft || !!curStored?.map, failed, pending: pendingId === curId, kept: !!kept }) : null;
  const shareFull = fullOn ? shareItem(fullStatus, !!kept || mapOff) : null;
  const shareOff = banned ? true : plgData.length ? true : shareFull ? shareFull.off : !!kept || mapOff;
  const submitItem =
    open && submitOn && curId
      ? submitMenuItem({ ban: banned, pending: pendingId === curId, extras: extras?.id === curId ? extras.parts : [], bytes: fullBytes, maxBytes: fo?.limits.worldBytes ?? SUBMIT_WORLD_MAX })
      : null;
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(() => {
    if (!open || !appleDevice()) return;
    let live = true;
    void askPersisted().then((p) => live && setPersisted(p));
    return () => {
      live = false;
    };
  }, [open]);
  const mayLose = useMemo(() => {
    if (!open || !curStored || !appleDevice()) return false;
    return persisted === false && fileStatus(fileRecords()[curStored.id], saveMark(curStored.save)).kind !== 'same';
  }, [open, curStored, persisted]);

  // 点菜单外面就收起(在捕获阶段听:地图上的按钮条拦了冒泡,点旁边的按钮照样收起)
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
      noteDismiss(e);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const saveFile = () => {
    setOpen(false);
    if (recipeOnly && curId) withFileFlow('没能存成文件', (m) => m.saveWorldRecipe(curId));
    else saveCurrentFile();
  };
  const saveAgain = () => {
    setOpen(false);
    if (curId) withFileFlow('没能存下来', (m) => m.saveAgain(curId));
  };

  // 「停在这一刻」:勾着就带上时间轴那一年、选中的国家或州、地图的位置和大小(默认勾着,记住上次的选择)
  const [momentOn, setMomentOn] = useMomentOn();
  const at = open && ready ? momentNow() : null;
  // 复制配方链接:网址(种子 + 参数 + 画风……)+ #share=整份存档(带上这一刻);没有修改、也不带这一刻就是普通网址。
  // 剪贴板用不了:菜单留着,里面多一行选中了链接的输入框(不另开窗口)
  const [manual, setManual] = useState<string | null>(null);
  const shareLink = async () => {
    const m = momentOn ? momentNow() : null;
    const r = await copyShareLink(m?.moment ?? null);
    if (!r) return setOpen(false);
    if (!r.copied) return setManual(r.url);
    setOpen(false);
    shareCopiedToast(r, m);
  };
  useEffect(() => {
    if (!open) setManual(null);
  }, [open]);

  const title = cur?.title;
  const nTerrain = edits.terrain.length;
  // 存没存住:浏览器不让存 / 存不下 / 已经在"我的世界"里 / 打开的链接还没动过
  const status: { cls: string; text: string; icon?: 'cloudok' | 'cloudup' | 'cloudoff' } = !keep
    ? { cls: 'warn', text: '浏览器不让网页存数据，关掉前请存成文件' }
    : full
      ? { cls: 'warn', text: `${storageFullWhy()}，没能自动存` }
      : oldRecipe
        ? { cls: 'warn', text: '只存了配方，看到的是按新版算的' }
        : failed
          ? { cls: 'warn', text: '内容没能存下来，现在看到的不受影响' }
        : curStored
          ? { cls: 'ok', text: mayLose ? '已自动存在这个浏览器里，7 天没打开可能被清掉' : '已自动存在这个浏览器里' }
          : { cls: '', text: '还没存进我的世界；改了名字或历史就会自动存' };
  // 旧版本建的世界:能到那一版的旧网站里看原样(菜单开着才找)
  const frozen = cur?.frozen !== undefined;
  const orig = open && cur && !frozen ? currentOriginal() : null;
  const site = orig ? oldSiteFor(orig.generator) : null;
  const noSite = !!orig && !site && OLD_SITE === null;
  const seeOriginal = () => {
    if (!orig || !site) return;
    setOpen(false);
    void openOriginal(orig).then((ok) => ok || openFailed(site.href, orig));
  };
  const share = () => {
    if (!cur) return;
    setOpen(false);
    if (banned) return openSubmitDialog({ kind: 'world', worldId: cur.id, title: title ?? '' }, 'ban-share');
    const go = () => (shareFull?.ask && !plgData.length ? openShareAsk(cur.id, title ?? '') : openShareDialog(cur.id, title ?? ''));
    if (phoneRequired()) askPhone({ for: 'share', then: go });
    else go();
  };
  const submitClick = () => {
    if (!submitItem || !cur || submitItem.act === 'none') return;
    setOpen(false);
    const work: SubmitWork = { kind: 'world', worldId: cur.id, title: title ?? '' };
    if (submitItem.act === 'ban') return openSubmitDialog(work, 'ban');
    const go = () => openSubmitDialog(work);
    if (phoneRequired()) askPhone({ for: 'submit', then: go });
    else go();
  };
  const fullClick = () => {
    if (!fullItem || !curId) return;
    const { act } = fullItem;
    if (act === 'none') return;
    setOpen(false);
    if (act === 'account') return openAccount();
    withFullFlow((m) => {
      if (act === 'upload' || act === 'reveal') return m.uploadWorld(curId);
      const r = fo && refusalOf(fo, curId, fullBytes);
      if (r) return m.refuseUpload(curId, r);
    });
  };
  return (
    <div className="save" ref={rootRef}>
      <button className={`save-btn${open ? ' on' : ''}`} onClick={() => setOpen((o) => !o)} data-tip="存档" data-tip-key="save">
        {icon}
        存档
      </button>
      {open && (
        <div className="save-menu" role="menu">
          {cur ? (
            <div className="save-cur">
              <Thumb src={curStored?.thumb ?? null} />
              <div className="save-info">
                <b className="save-cur-name">{title || '未命名世界'}</b>
                <small>
                  种子 {cur.params.seed}
                  {nTerrain ? `，地形改过 ${nTerrain} 处` : ''}
                </small>
                {kept && <small data-testid="save-map-from">{kept.title !== undefined ? `地图留自「${kept.title}」，历史按新版重推` : '地图留自旧世界，历史按新版重推'}</small>}
                <small className={`save-status ${status.cls}`} data-testid="save-status">
                  {status.icon && <Icon name={status.icon} size={14} />}
                  {status.text}
                </small>
                {curStored?.fromFile && <small data-testid="save-from-file">{fromFileLine(curStored.fromFile)}</small>}
              </div>
            </div>
          ) : (
            <div className="save-empty">正在生成世界</div>
          )}
          <button className="save-it" data-act="save-file" disabled={!cur} onClick={saveFile}>
            <Icon name="save" size={17} />
            <span>
              <b>{recipeOnly ? '存配方文件（.json）' : '存成文件'}</b>
              <small>{recipeOnly ? `只有几 KB。${RECIPE_HINT}` : `存下整个世界${plgData.length ? `，连同插件${plgNames}存的数据` : sizeNote}。换台设备、发给别人，看到的都一模一样`}</small>
            </span>
          </button>
          {fullItem && (
            <button className={`save-it${fullItem.off ? ' off' : ''}`} data-act="full-upload" aria-disabled={fullItem.off ? true : undefined} onClick={fullClick}>
              <Icon name={fullItem.icon} size={17} />
              <span>
                <b>{fullItem.title}</b>
                <small>{fullItem.small}</small>
              </span>
            </button>
          )}
          {session ? (
            <button className={`save-it${shareOff ? ' off' : ''}`} data-act="share" aria-disabled={shareOff ? true : undefined} disabled={!cur} onClick={shareOff && !banned ? undefined : share}>
              <Icon name="link" size={17} />
              <span>
                <b>分享…</b>
                <small className={plgData.length && !banned ? 'plg-off' : undefined}>
                  {banned ? SHARE_BANNED : plgData.length ? PLUGIN_DATA_SHARE : shareFull ? shareFull.small : kept || mapOff ? NO_LINK : '生成一个链接，别人打开就能看；随时能停止'}
                </small>
              </span>
            </button>
          ) : (
            <>
              <button className={`save-it${kept || mapOff || plgData.length || simOff ? ' off' : ''}`} data-act="share-link" data-tip="复制配方链接" data-tip-key="layer5" aria-disabled={kept || mapOff || plgData.length || simOff ? true : undefined} disabled={!cur} onClick={kept || mapOff || plgData.length || simOff ? undefined : shareLink}>
                <Icon name="link" size={17} />
                <span>
                  <b>复制配方链接</b>
                  {plgData.length ? <small className="plg-off">这个世界里有插件{plgNames}存的数据，不能公开分享。要发给别人，请存成文件</small> : <small>{simOff ? SIM_NO_LINK : mapOff && !kept ? MAP_NO_LINK : kept ? NO_LINK : RECIPE_HINT}</small>}
                </span>
              </button>
              {at && !kept && !mapOff && !plgData.length && !simOff && <MomentCheck at={at} on={momentOn} onChange={setMomentOn} />}
            </>
          )}
          {submitItem && (
            <button className={`save-it${submitItem.off ? ' off' : ''}`} data-act="submit" aria-disabled={submitItem.off ? true : undefined} onClick={submitClick}>
              <Icon name="image" size={17} />
              <span>
                <b>投到作品墙…</b>
                <small>{submitItem.small}</small>
              </span>
            </button>
          )}
          {plgData.length > 0 && curId && <RemoveDataItem worldId={curId} list={plgData} phone={narrow} onDone={() => setOpen(false)} />}
          {simWait && simWait.id === curId && (
            <div className="save-it off" data-act="sim-wait">
              <Icon name="warn" size={17} />
              <span>
                <b>还没存好</b>
                <small>{simWaitText(simWait.ids)}</small>
              </span>
            </div>
          )}
          {failed && (
            <button className="save-it" data-act="save-again" onClick={saveAgain}>
              <Icon name="save" size={17} />
              <span>
                <b>再存一次</b>
                <small>上次没存成，世界本身没事。存下来以后，网站更新也不会变</small>
              </span>
            </button>
          )}
          {(frozen || cur?.readonly || oldRecipe) && (
            <button
              className="save-it"
              data-act="save-new"
              onClick={() => {
                setOpen(false);
                saveAsNew();
              }}
            >
              <Icon name="copy" size={17} />
              <span>
                <b>按新版另存一份</b>
                <small>{oldRecipe ? '地图和历史都按新版长一份副本，以后不再变。这一份的配方留着' : '地图不变，历史按现在的规则重推。这一份照原样留着'}</small>
              </span>
            </button>
          )}
          {site && (
            <button className="save-it" data-act="see-original" onClick={seeOriginal}>
              <Icon name="history" size={17} />
              <span>
                <b>看原样</b>
                <small>在新页面里用建它的那一版网站打开</small>
              </span>
            </button>
          )}
          {noSite && (
            <button className="save-it off" data-act="see-original-none" aria-disabled="true">
              <Icon name="history" size={17} />
              <span>
                <b>看原样</b>
                <small>建它的那一版没留旧版网站，原样看不到了</small>
              </span>
            </button>
          )}
          {manual !== null && <ManualCopy url={manual} />}
        </div>
      )}
    </div>
  );
}
