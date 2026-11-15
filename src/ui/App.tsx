import './theme.css';
import { Component, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { endLoadWatch, reportOpenCrash } from './openGuard';
import { createPortal, flushSync } from 'react-dom';
import type { World, WorldParams } from '../gen/world';
import type { Raster } from '../gen/raster';
import { realisticRiverSteps, renderRealistic } from '../render/realistic';
import { renderFantasy } from '../render/fantasy';
import { DETAIL_K } from '../render/detail';
import { TerrainDetail } from './TerrainDetail';
import { MapDecor } from './MapDecor';
import { GratLabels } from './GratLabels';
import type { GratSpec } from './graticuleLabels';
import { ContourLayer } from './ContourLayer';
import { contourInk } from '../render/contours';
import { dropPreparedRivers } from '../render/common';
import {
  getMapCenter,
  mirrorCanvas,
  publishMapCenter,
  useMapCenter,
  viewCentredAt,
  worldToStage,
  windowSpan,
  xOfLon,
  type StageBox,
} from './mapWrap';
import { projectWorld, unprojectWorld, wrapLon, type MapProj } from '../render/projection';
import {
  ProjLayer,
  curvedProj,
  getProjection,
  isCurved,
  isGraticuleStep,
  pageColor,
  presentTerrain,
  terrainRefining,
  setContourKind,
  setGraticule,
  setGraticuleStep,
  setProjection,
  useContourKind,
  useGraticuleLines,
  useMapMoving,
  useProjection,
} from './projection';
import { renderLayer, type LayerId } from '../render/layers';
import { Legend } from './Legend';
import { ThoughtLegend } from './ThoughtParts';
import type { MapFailedKind, WorkerRequest } from '../worker';
import type { MapSpent, MapStage } from '../gen/mapHooks';
import type { Civ } from '../gen/civ/types';
import { CivLayer, civOpenSteps } from './CivLayer';
import { CivTimeline } from './CivTimeline';
import { ExtendDock, ExtendPop, ExtendSheet } from './ExtendYears';
import { extendProgress, extendStart, setExtendBusy, setExtendOpen } from './extendStore';
import { EventPins, type WorldToClient } from './EventPins';
import { DirectorCaption, DirectorEngine, DirectorPanels, DirectorPin } from './Director';
import { directorHandBack, setDirectorMode, useDirectorOn } from './directorStore';
import { StepDock, StepPins, StepReviewSheet, StepTimeline, StepwiseEngine, useStepCard, useStepReplay, useStepStrip } from './Stepwise';
import { StepRewindDialog, StepSaveDialog, StepStartDialog } from './StepwiseDialogs';
import {
  enterStepwise,
  getStepwise,
  leaveStepwise,
  setStepGesture,
  stepLost,
  stepStuck,
  stepWheel,
  branchSwitching,
  subscribeStepwise,
  useStepwiseOn,
  useStepwiseStopped,
} from './stepwiseStore';
import { switchBranch } from '../gen/stepwise';
import { StepBranchDeleteDialog } from './StepBranches';
import { HistoryBook } from './HistoryBook';
import { AiSettingsHost } from './AiSettings';
import { AccountHost } from './AccountDialogs';
import { ShareGone, ShareReportHost, SharedHint } from './ShareNotes';
import { useShareReportEntry } from './shareReport';
import {
  clearSelection,
  getCivShow,
  getCivTime,
  useCivStory,
  getSelection,
  pausePlayback,
  prepareCivReplay,
  sameSelection,
  startAutoplay,
  setCivTime,
  setCivShow,
  setSelection,
  setSelectionRedirect,
  startCivReplay,
  useChronicle,
  useChroniclePick,
  useCivShow,
  useSelection,
  type MapSelection,
} from './civView';
import {
  EMPTY_EDITS,
  YEAR_TICKS,
  applyNames,
  aiNameKeys,
  cleanPlay,
  namesWithoutAi,
  playAt,
  playFromOf,
  polityKey,
  regionKey,
  resolveKey,
  type Intervention,
  type PlayState,
  type TerrainOp,
  type Upheaval,
  type WorldEdits,
} from '../gen/edits';
import { type NameMix } from '../gen/names/mix';
import type { RasterPatch } from '../gen/rasterPatch';
import { cancelTerrainPatch, type PatchView, type PreProjected } from './terrainPatch';
import { later, thumbPrepSteps } from './thumbPrep';
import { cancelDetailJob, submitDetailJob, type WorkStep } from './detailJobs';
import { civAtEra, eraData, peekEraData, eraIndex, eraReady, eraShown, useEraIndex, withHistory, type EraMaps } from './eras';
import { namedHistory, useNamedHistory } from './chronicleHandoff';
import { type SketchEdit } from '../gen/sketch';
import { getEdits, putEditsQuiet, setEditGate, useEdits } from './editsStore';
import { yearFull } from '../gen/era';
import { ShortcutsHost } from './ShortcutsDialog';
import { DiagHost } from './DiagDialog';
import { TipLayer } from './Tips';
import { replayStart } from './timelineLayout';
import {
  resolveMoment,
  worldKey,
  type SaveCamera,
  type SaveMoment,
} from '../gen/savefile';
import {
  currentWorld,
  loadWorld,
} from './saveStore';
import { setWorldStoreSim } from './worldStore';
import { getStage, setStage, useStage } from './stageStore';
import { polityName, ownersAt, faithAt } from '../gen/readers/openQuery';
import { finishPick, getPolityPick, setPickHover, setPolityPick, usePolityPick } from './Interventions';
import { RoleBar } from './RoleBar';
import { Inspector } from './Inspector';
import { TargetLayer } from './TargetPlates';
import { TrekPlanLayer } from './TrekPlanLayer';
import { freeArea, selectionKey, shownYearOf, sideRoom } from './flyTo';
import { setMomentSource, type MomentNow } from './shareMoment';
import { decodePresetHash } from './presetLink';
import { MarkLayer, markHitAt, markPinAt, markPinTip, type MarkApi } from './MarkLayer';
import { getMarkUi, newMarkDraft, patchDraft, resetMarkUi, setMarkDragging, stopPlacing, toggleDraftRegion, useMarkUi } from './markStore';
import { markHover, markSpot, ownerName } from './markInfo';
import { CharacterLayer, characterPinAt, characterPinTip } from './CharacterLayer';
import { getCharUi, parseYear as parseCharYear, pickPlace, resetCharacterUi, stopPicking, useCharUi } from './characterStore';
import { characterHover, placeOf, whereOfCity, whereOfRegion } from './characterInfo';
import type { Where } from '../gen/characters';
import { regionLabel } from '../gen/civ/story/display';
import { setSideHold, useSide } from './sideStore';
import { setSheet, setWorldSheet, usePanel } from './panelStore';
import { useOverview } from './overviewStore';
import { setOutlineRun, startOutline } from './outlineStore';
import { OutlineRunAsk } from './OutlineRunAsk';
import { FinderPage } from './FinderPage';
import { FinderOverlay, FinderPins } from './FinderMap';
import { useFinder } from './finderStore';
import { STUDIO_STYLES, Studio } from './studio/Studio';
import { setFlatGeomSource, useStudioFlat } from './studio/studioStore';
import { MyWorlds } from './MyWorlds';
import { RulesHost } from './rules/RulesHost';
import { pluginsUiOn } from './plugins/flag';
import { PluginsHost, ToolsHost } from './plugins/entry';
import { toolCard, toolCellPick } from './plugins/toolsState';
import { PluginDevMapSlot, PluginDevSlot, useDevMapOn } from './plugins/devSlot';
import { PluginAskSlot, PluginCellSlot, PluginLegendSlot, PluginMarksSlot, PluginSavedSlot, usePluginLegendOn } from './plugins/layerSlots';
import { GalleryPage, WorkGone } from './Gallery';
import { MapWorkView, WorkBar } from './GalleryWork';
import type { GalleryItem } from '../account/gallery';
import { mapBriefOf } from './mapGroups';
import { useCoarse, useNarrow } from './device';
import { useMapView } from './map/useMapView';
import { useMapGestures } from './map/useMapGestures';
import { useMapFly } from './map/useMapFly';
import { useAppShortcuts } from './useAppShortcuts';
import { mapTextBoxes, passAt, pickLabelAt } from './mapPick';
import { setTradeHover, tradeAtClient, tradeHoverInfo } from './tradePick';
import { type RewriteNote } from './rewriteStore';
import { AssistantPanel, PreviewBanner } from './Assistant';
import { astRoom, closeAssistant, useAstOpen } from './astPanel';
import { PREVIEW_EDIT_BLOCK, exitPreview, getAssistant, sameInBoth, stopAsk, syncAssistantWorld, useAssistantPreview } from './assistantStore';
import { closeBookReader, closeHistoryBook, stopBook, useBookReader } from './bookStore';
import { navLayer, navReplace, navSettled, type NavHooks } from './nav';
import { layerNow } from './navView';
import { useAiOn } from '../ai/client';
import { Globe, getGlobeOn, setGlobeOn, useGlobeOn, type GlobeApi } from './Globe';
import { setupAi } from '../ai/setup';
import { ToastBar, clearToast, showToast } from './Toast';
import { FirstHint, HoverCard, MapBar, MapControls, OldSiteBadge, PhoneButtons, hintSeen, markHintSeen } from './Corners';
import { closeRelief, openAreaLink, urlHasArea, useRelief } from './terrain3dStore';
import { FrozenAsk } from './FrozenWorld';
import { SameWorldHost } from './sameWorldAsk';
import { BETA_SITE, OLD_SITE } from './oldSite';
import { Sidebar } from './Sidebar';
import { PhoneSheet } from './PhoneSheet';
import { useLayerThumbs } from './LayerPopover';
import { WorldOverview } from './WorldOverview';
import { RelationBack, RelationGraph, useRelationBack } from './RelationGraph';
import { getRelation } from './relationStore';
import { hoverInfo, probeLines, type HoverInfo } from './hoverInfo';
import {
  baseDark,
  baseLook,
  baseName,
  baseOf,
  baseThumb,
  fillOf,
  fillShow,
  layerOf,
  layerParts,
  paintLook,
  type BaseId,
  type FillId,
  type MapLayer,
  type MapView as BaseFill,
  type SatLook,
  type Style,
  type ThumbId,
} from './mapLayers';
import type { SurfaceLook } from '../render/surface';
import {
  TerrainOverlay,
  getTerrainTool,
  pageOf,
  setTerrainTool,
  setTerrainWrap,
  setTerrainProbe,
  terrainClick,
  terrainMove,
  useTerrainTool,
  type TerrainStatus,
} from './TerrainTools';
import { SourceLayer, useImportOn, useSourceView } from './ImportImage';
import { NewWorldDialog } from './NewWorldDialog';
import { randomSeedValue, type HomeStart } from './homeStart';
import { WORKER_URL } from './workerUrl';
import { noteCrash as noteCrashNow, resetStuck, simFailOpt } from './stuckStore';
import { StuckCard } from './StuckCard';
import { SimClient } from './sim/simClient';
import { useSimResults, type ExtendJob, type ExtendUndo, type OutlineJob, type RenameCheck, type ResimInfo, type SwitchNote } from './sim/useSimResults';
import { useExtendOutlineRunners, useSimRunners } from './sim/useSimRunners';
import { closeUpheaval, getUpUi, upClick, upMove, useUpUi } from './upheavalStore';
import { UpheavalHint, UpheavalOverlay } from './UpheavalPanel';
import { PendingTray } from './PendingTray';
import { restorePending } from './pendingStore';
import { tookDismissClick } from './dismissClick';
import { makeFlagView, setFlagView, storedFlagsOf, useFlagPreview } from './flagStore';
import { setFilmSource } from './filmSource';
import { closeFilm, getFilm, useFilm } from './filmStore';
import { FilmPanel } from './FilmPanel';
import { FilmStage } from './FilmStage';
import { LongPanel } from './LongPanel';
import { LongStage } from './LongStage';
import { cancelTimeout, holdMark } from './holdMark';
import { pickSharedPreset } from './presetStore';
import { setDiagContext } from '../diag/watch';
import { worldMessages } from './world/worldMessages';
import { useWorldLoad } from './world/useWorldLoad';
import { useWorldPages } from './world/useWorldPages';
import { useEditRecompute } from './world/useEditRecompute';
import { useFileDrop } from './world/useFileDrop';
import { useStoryFinder } from './world/useStoryFinder';
import { firstRoute, readUrl, writeViewUrl } from './world/pageUrl';
import { useRouteNav, useViewUrl } from './world/useRouteNav';
import { useAutoSave, useSaveThumbs } from './world/useWorldSave';
import { useOpenRefs, type CivRefs, type GenProgress, type GenRefs, type MapFirst, type MapRefs, type RegenJob, type ResimRefs, type WorldViewRefs } from './world/worldRefs';
import {
  draftModeOf,
  mapsOpt,
  presetDialog,
  writeGalleryUrl,
  type CivSetup,
  type Landing,
  type NewDlg,
  type SharedFor,
  type Target,
  type WallView,
  type WorkFor,
} from './world/worldTarget';
import { simsOf } from './world/simNow';
import { getMapNow, mapFilesOf } from './world/mapNow';
import { setMapFail, type MapFail } from './world/mapFail';
import { undoLastEdit } from './undo';
import { MAP_STAGE_TEXT } from './plugins/mapText';
import { SimAskHost } from './world/SimAskHost';
import { MapAskHost } from './world/MapAskHost';
import { askMaps } from './world/mapAsk';

type Replay = { w: number; h: number; frames: Uint8ClampedArray[]; mya: number[]; idx: number };

/** 底图在缓存里的键:手绘 / 写实(经典 = realistic,其余 realistic:画法)/ data:数据图层 */
export function baseKeyOf(style: Style, layer: LayerId, look: SurfaceLook): string {
  if (style === 'data') return `data:${layer}`;
  if (style === 'realistic') return look === 'classic' ? 'realistic' : `realistic:${look}`;
  return style;
}

/** 新建时能看的样式(不用历史的那几种) */
const STUDIO_LAYERS: MapLayer[] = STUDIO_STYLES.map((x) => x.id);

/** 新建时能看这组底图和填色(填色要有历史;新建界面的样式里没有地理图、白模和几种数据底图) */
function studioView(v: { base: BaseId; fill: FillId }): boolean {
  if (v.fill !== 'none') return false;
  return v.base === 'satellite' || v.base === 'fantasy' || STUDIO_LAYERS.includes(v.base as MapLayer);
}

/** 同一个世界画好的整张图留几张(地形大事前后各一张;见下面的 mapsOf) */
const MAP_KEEP = 2;
/** 时间轴换段前在后台备那一段的地图的活名(detailJobs.ts) */
const ERA_WARM_JOB = 'era-warm';

/** 切支线的时候,修改里已经是切到的那一支,地图、面板上还是原来那支:先不许下令、改名(用的键可能指到那一支里别的东西) */
const SWITCH_EDIT_BLOCK = '正在切到别的一支，切完再改';

// 地区(框一块地方单独看:地区图、立体):点「地区」时才下载(ui/terrain3d/)
const ReliefPick = lazy(() => import('./terrain3d/relief3d').then((m) => ({ default: m.ReliefPick })));
const AreaView = lazy(() => import('./terrain3d/relief3d').then((m) => ({ default: m.AreaView })));
const ReliefGhost = lazy(() => import('./terrain3d/relief3d').then((m) => ({ default: m.ReliefGhost })));

// 帮手模式(作品墙的后台在看不见的框里打开网站画封面、列名字):和主程序同一份下载,用到的地图、推演代码不另下(Boot.tsx 叫)
export { startGalleryHelper } from './galleryHelper';

/** fromHome:打开网站时先出来的首页(HomeShell.tsx)上点了要离开首页的事,挂上以后接着做(见 Boot.tsx) */
/**
 * 界面渲染时抛错:开着的世界是新路读的,记下来、刷新页面重开,这次走旧的路(openGuard.ts);
 * 别的错不在这里兜着,冒到最外面那层通用回退页(main.tsx 的 AppErrorBoundary),给人重新加载 / 回我的世界 / 复制出错信息三条路。
 */
class OpenCrashGuard extends Component<{ children: ReactNode }> {
  componentDidCatch() {
    if (reportOpenCrash()) location.reload();
  }
  render() {
    return this.props.children;
  }
}

export function App(props: { fromHome?: HomeStart } = {}) {
  return (
    <OpenCrashGuard>
      <AppBody {...props} />
    </OpenCrashGuard>
  );
}

function AppBody({ fromHome }: { fromHome?: HomeStart }) {
  const init = useMemo(readUrl, []);
  /** 打开网页时去哪:我的世界 / 新建 / 某个世界(见 firstRoute) */
  const route = useMemo(() => firstRoute(init), [init]);
  /** 进新建时换掉的底图和填色(填色要有历史);建好 / 打开别的世界时换回来 */
  const draftViewRef = useRef<{ base: BaseId; fill: FillId } | null>(null);
  // 网址里的投影、中央经线、经纬网:第一次渲染之前放进 store(等距圆柱的视图在世界出来以后再转过去,见 pendingLon)
  const start = useState(() => {
    setProjection(init.proj);
    if (init.lon !== null) publishMapCenter(init.lon);
    setGraticule(init.grat > 0);
    if (isGraticuleStep(init.grat)) setGraticuleStep(init.grat);
    setContourKind(init.iso);
    setStage(route.stage, route.target?.base ?? null);
    // 网址里给的(或默认的)底图和填色:国家 / 民族 / 信仰开不开跟着填色;新建时只看地形
    let mv: BaseFill | null = init.mapView;
    let { style, layer, surface } = init;
    // 新建:网址里给的是新建时能看的样式就照它,否则用卫星(填色要有历史;建好以后换回来)
    if (route.stage === 'draft') {
      const now = mv ?? { base: baseOf(style, layer, surface), fill: fillOf(getCivShow()) };
      draftViewRef.current = { base: now.base, fill: now.fill };
      if (!studioView(now)) {
        mv = { base: 'satellite', fill: 'none' };
        style = 'realistic';
        surface = init.sat;
        writeViewUrl({ ...mv, sat: init.sat });
      }
    }
    if (mv) setCivShow(mv.resources ? { ...fillShow(mv.fill), resources: true } : fillShow(mv.fill));
    return { style, layer, surface, sat: init.sat };
  })[0];
  const graticule = useGraticuleLines();
  const contourKind = useContourKind();
  const projection = useProjection();
  const curved = isCurved(projection);
  const mapCenter = useMapCenter();
  const projMoving = useMapMoving() && curved;
  const [params, setParams] = useState<WorldParams>(route.target?.params ?? init.params);
  const [style, setStyle] = useState<Style>(start.style);
  const [layer, setLayer] = useState<LayerId>(start.layer);
  /** 写实底图的画法(经典卫星 / 卫星 / 地理图 / 白模;不是写实底图时不用) */
  const [surface, setSurface] = useState<SurfaceLook>(start.surface);
  /** 卫星记着的画法(经典 / 细节):换到别的底图再换回卫星还是它 */
  const [satLook, setSatLook] = useState<SatLook>(start.sat);
  // 填色(不填 / 国家 / 民族 / 信仰 / 时代 = 文明层的开关)
  const civShow = useCivShow();
  /** 写实底图实际铺的那一份:地理图上叠了填色时是褪色的那一份(paintLook);缓存的键、画图都按它 */
  const paintedLook = paintLook(surface, fillOf(civShow));
  const { stage, base: stageBase } = useStage();
  const draft = stage === 'draft';
  const home = stage === 'home';
  /** 新建界面(Studio)创建以后还没走完:1 = 星球展开成平常的地图,2 = 新建界面淡出(底下平常的地图露出来) */
  const [studioOut, setStudioOut] = useState<0 | 1 | 2>(0);
  /** 照故事找世界那一页开着(新建中,FinderPage.tsx):新建界面先收起,平常的地图露出来 */
  const finder = useFinder();
  const finderOn = draft && finder.open;
  /** 新建界面盖着整页:深色、太空底,平常的地图藏起来(摊平改地形时铺在中间那块) */
  const studioOn = (draft && !finderOn) || studioOut === 1;
  const studioFlat = useStudioFlat();
  // 宽屏左边的卡片收起了(sideStore.ts):新建世界那一步左边是新建世界的卡片,不算收起(sideRoom 照常让出它)
  const sideUi = useSide();
  // 在 layout effect 里设(变了要通知订阅者,不在渲染途中通知);换上以后、画出来之前跟着重画一遍
  useLayoutEffect(() => setSideHold(stage !== 'world'), [stage]);
  /** 正在打开 / 已经打开的世界(生成完按它套上修改、交给自动存) */
  const targetRef = useRef<Target | null>(route.target);
  /**
   * 新建中、照平常的规矩推历史(先推 3000 年、拓荒起源天灾按默认):照故事找世界选中的结果不算(它按自己的推演年数、拓荒、起源、天灾推,
   * 和搜的时候一样,见 Target.fullCiv)
   */
  const plainDraft = () => getStage().stage === 'draft' && !targetRef.current?.fullCiv;
  /** 新建中的名字(卡片上的输入框;打开没建完的世界时是它存的名字) */
  const [draftTitle, setDraftTitle] = useState(route.target?.kind === 'draft' ? (route.target.title ?? '') : '');
  /** 「新建世界」弹窗:开着没有、从哪一步开始(刷新了照手绘图还没长出星球的新建:停在它选图那一步) */
  /** 打开网页时的朋友的预设链接(#preset=…):解开的结果(没有 = null) */
  const presetLink = useState(() => {
    const r = init.preset ? decodePresetHash(init.preset) : null;
    if (r?.ok) pickSharedPreset(r.preset);
    return r;
  })[0];
  const [newDlg, setNewDlg] = useState<NewDlg | null>(() =>
    route.dialog ? { init: route.dialog } : presetLink?.ok && route.stage === 'home' ? presetDialog(presetLink.preset) : null,
  );
  /** 生成出来的世界和主图(地形大事以前的;地图上画的是 data:时间轴那一段的) */
  const [baseData, setData] = useState<{ world: World; raster: Raster } | null>(null);
  /** 地形大事以后各段的世界(后台线程交来的;没有大事 = null)、各段主图的补丁(后台慢慢铺好交来;eras.ts) */
  const [eraMaps, setEraMaps] = useState<EraMaps | null>(null);
  const eraPatches = useRef(new Map<string, RasterPatch | null>());
  const [patchVer, setPatchVer] = useState(0);
  // 生成出来的文明("原始 civ")+ 用户的改名(editsStore)= 界面用的 civ。改名只重算这一步,不发给后台线程
  const [rawCiv, setRawCiv] = useState<Civ | null>(null);
  const edits = useEdits();
  // 助手的"先在地图上看看":地图、卡片、时间轴换成试推演的历史(州和宜居度和现在共用;作者的世界没动,rawCiv 还是原来的)
  const astOpen = useAstOpen();
  const preview = useAssistantPreview();
  const previewRaw = preview?.raw ?? null;
  /** 时间轴现在在第几段(地形大事以后,地图、州、地名、道路跟着换;eras.ts) */
  const eraWant = useEraIndex(previewRaw ?? rawCiv);
  /** 地图该画的那一段:那一段的主图还在后台铺时,先是前面铺好了的那一段(历史、世界、主图三样对得上) */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- patchVer:后台交来新的补丁时重算
  const eraNext = useMemo(() => eraShown(eraMaps, eraPatches.current, eraWant), [eraMaps, patchVer, eraWant]);
  /** 地图上画着的是哪个世界(原主图那一份)、哪份各段世界的第几段 */
  const eraAt = useRef<{ maps: EraMaps | null; base: object | null; k: number } | null>(null);
  /** 换段前在后台备好了的那一段(世界和主图那一份)、按哪种底图备的 */
  const eraWarm = useRef<{ data: object; key: string } | null>(null);
  /** 地图缓存里有没有这一段的这种底图(渲染那里填上;有就直接换,不用备) */
  const eraCached = useRef<(d: object, key: string) => boolean>(() => false);
  const [warmVer, setWarmVer] = useState(0);
  const warmKey = baseKeyOf(style, layer, paintedLook);
  /**
   * 地图上实际画的那一段:换段(补丁刚到、拖时间轴跨过大事)时,那一段的整张底图、河、文明层先在后台分小步备好再换过去
   * (见下面的 ERA_WARM_JOB),不在换上那一下整张画;备的时候照旧画原来那一段(历史、世界、主图三样对得上)
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- patchVer:后台交来新的补丁时重算;warmVer:备好了
  const eraK = useMemo(() => {
    const at = eraAt.current;
    const prev = at && at.maps === eraMaps && at.base === baseData ? at.k : null;
    if (prev === null || prev === eraNext || !baseData) return eraNext;
    // 那一段的主图还没拼:没备好(拼也在后台备的那几步里)
    const d = peekEraData(baseData, eraMaps, eraPatches.current, eraNext);
    const w = eraWarm.current;
    return d && ((w && w.data === d && w.key === warmKey) || eraCached.current(d, warmKey)) ? eraNext : prev;
  }, [eraMaps, patchVer, eraNext, baseData, warmVer, warmKey]);
  useLayoutEffect(() => {
    eraAt.current = { maps: eraMaps, base: baseData, k: eraK };
  }, [eraMaps, baseData, eraK]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- patchVer:后台交来新的补丁时重拼
  const data = useMemo(() => (baseData ? eraData(baseData, eraMaps, eraPatches.current, eraK) : null), [baseData, eraMaps, patchVer, eraK]);
  /**
   * 整段历史(最后一段的州、地名,套上改名):编年史这类按它算(见 Civ.history);后台线程按同样的改名算好了编年史的直接用。
   * 改了名、编年史还在分小块算的时候,先照旧显示改名以前的样子,算好再换上(chronicleHandoff.ts);realNames = 现在套着的那份改名
   */
  // 作者立的君主(干预"即位")套上人物卡上的名字
  const realNamed = useNamedHistory(rawCiv, edits.names, edits.characters);
  const realFull = realNamed?.full ?? null;
  const realNames = realNamed?.names ?? edits.names;
  // 试推演的编年史在换上之前已经分小块算好了(assistantStore.ts 的 showPreview)
  const previewFull = useMemo(() => (previewRaw ? namedHistory(previewRaw, preview!.names, getEdits().characters) : null), [previewRaw, preview?.names]);
  /** 地图上那一段的历史:那一段的州、地名、道路,套上改名;更早一段时挂上整段历史 */
  const eraView = (raw: Civ, full: Civ, names: Record<string, string>) => {
    const e = civAtEra(raw, eraK);
    return e === raw ? full : withHistory(applyNames(e, names), full);
  };
  /** 现在这个世界的历史(时间轴那一段的) */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- eraView 只用到 eraK
  const realCiv = useMemo(() => (rawCiv && realFull ? eraView(rawCiv, realFull, realNames) : null), [rawCiv, realFull, eraK, realNames]);
  const shownRaw = useMemo(() => {
    const r = previewRaw ?? rawCiv;
    return r ? civAtEra(r, eraK) : null;
  }, [previewRaw, rawCiv, eraK]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- eraView 只用到 eraK
  const civ = useMemo(() => (previewRaw && previewFull ? eraView(previewRaw, previewFull, preview!.names) : realCiv), [previewRaw, previewFull, eraK, preview?.names, realCiv]);
  /** 照大纲推演的提示条上写名字用(套上改名的那一份) */
  const realCivRef = useRef(realCiv);
  realCivRef.current = realCiv;
  // 推演里作者的人物当的君主(编年史、世系图、国家卡片里点他的名字):打开作者的人物卡;人物卡删掉了照旧开推演人物卡
  const civForRedirect = useRef(civ);
  civForRedirect.current = civ;
  useLayoutEffect(() => {
    setSelectionRedirect((sel) => {
      if (sel.kind !== 'person') return sel;
      const a = civForRedirect.current?.people?.[sel.id]?.author;
      return a !== undefined && getEdits().characters?.some((c) => c.id === a) ? { kind: 'character', id: a } : sel;
    });
    return () => setSelectionRedirect(null);
  }, []);
  // 国旗(flagStore.ts):所有国家历代的旗,套上作者改过的和「换一面」「自己改」正在预览的那一面;历史和世界对不上(正在重新生成)时先不算。
  // 有地形大事的按第一件以前的地形配(拖时间轴跨过大事旗不跟着变,那以前的旗和没有大事时一样)
  const flagPreview = useFlagPreview();
  const flagGeo = useMemo(() => {
    const r = previewRaw ?? rawCiv;
    if (!r?.eras?.length || !baseData) return undefined;
    return { world: baseData.world, civ: applyNames(civAtEra(r, 0), previewRaw ? preview!.names : realNames) };
  }, [previewRaw, rawCiv, baseData, preview?.names, realNames]);
  const flagView = useMemo(
    () =>
      data && civ && civ.viable && civ.habitat.suitability.length === data.world.mesh.n ? makeFlagView(data.world, civ, edits.flags, flagPreview, flagGeo, previewRaw ? undefined : storedFlagsOf(rawCiv)) : null,
    [data, civ, edits.flags, flagPreview, flagGeo, previewRaw, rawCiv],
  );
  useLayoutEffect(() => setFlagView(flagView), [flagView]);
  // 导出回放视频 / 故事长图:左边面板(手机:底部卡片)换成导出的选项
  const filmUi = useFilm();
  // 回放导出(视频、故事长图)按年份取那一段的世界、主图、历史(filmSource.ts);和地图上一样,那一段的主图还没铺好先用前一段
  // (预览这样凑合;导出等 ready 了再拍)
  useLayoutEffect(() => {
    const raw = previewRaw ?? rawCiv;
    const full = previewFull ?? realFull;
    if (!baseData || !raw || !full) return setFilmSource(null);
    const names = previewRaw ? preview!.names : realNames;
    const civs = new Map<number, Civ>();
    const lastK = eraIndex(raw, full.endYear);
    setFilmSource({
      full,
      ready: lastK === 0 || (!!eraMaps && eraReady(eraMaps, eraPatches.current, lastK)),
      at(year) {
        const k = eraShown(eraMaps, eraPatches.current, eraIndex(raw, year));
        const { world, raster } = eraData(baseData, eraMaps, eraPatches.current, k);
        const geo = civAtEra(raw, k);
        let civ = civs.get(k);
        if (!civ) civs.set(k, (civ = geo === raw ? full : withHistory(applyNames(geo, names), full)));
        return { k, world, raster, civ, geo };
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- patchVer:后台交来新的补丁时换一份(各段的主图跟着补上)
  }, [baseData, eraMaps, patchVer, previewRaw, rawCiv, previewFull, realFull, realNames, preview?.names]);
  // 导出时"换回原名"用的:AI 起的名字换回原来的(没有 AI 起的名字、助手"先看看"时 = null,导出菜单不问)
  const plainCiv = useMemo(
    () => (rawCiv && !previewRaw && aiNameKeys(edits).length ? applyNames(civAtEra(rawCiv, eraK), namesWithoutAi(edits)) : null),
    [rawCiv, eraK, previewRaw, edits],
  );
  /** 右侧详情面板开着(右下角的地球仪 / 缩放按钮让开它) */
  const selState = useSelection();
  // 右侧面板开着(选目标、下了令正在推演时面板藏起来,右下按钮回到原位)
  const panelUi = usePanel();
  const pickNow = usePolityPick();
  /** 地形大事的卡片开着(UpheavalPanel.tsx;和选中的东西的卡片在同一处) */
  const upOn = useUpUi().on;
  /** 插件卡开着(没选东西时在卡片的位置) */
  const toolCardOn = toolCard.use();
  const panelOpen = (!!selState.sel || upOn || toolCardOn) && !!civ && !pickNow && !panelUi.run;
  /** 窄屏(手机):底部的世界 / 详情卡片、时间轴胶囊、右上竖排按钮(phone.css);触屏:没有悬停卡片、右下不放 + −(用双指捏合) */
  const narrow = useNarrow();
  const coarse = useCoarse();
  /** 人物关系图收起着、左边还是那张图中心那位的卡片:地图左上「回到关系图」(RelationGraph.tsx) */
  const relBack = useRelationBack(civ) && !narrow;
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;
  /** 生成进度(提示条"正在生成世界"):regen = 按新地形重新生成;seed = 正在生成的种子 */
  const [progress, setProgress] = useState<GenProgress | null>(null);
  /** 悬停小卡片:内容 + 鼠标位置(视口坐标) */
  const [hover, setHoverState] = useState<{ info: HoverInfo; x: number; y: number; place?: 'above' | 'left' } | null>(null);
  // 选目标时鼠标下的可选对象:名牌反色(TargetPlates)
  const setHover = (h: { info: HoverInfo; x: number; y: number; place?: 'above' | 'left' } | null) => {
    setPickHover(h?.info.pick ?? -1);
    setHoverState(h);
  };
  // ---- 底图(手绘 / 卫星 / 地理图 / 白模 / 数据底图)× 填色(不填 / 国家 / 民族 / 信仰 = 文明层的开关) ----
  const mapBase = baseOf(style, layer, surface);
  const mapFill = fillOf(civShow);
  /** 旧的图层名(新建界面的样式、新建时的默认用) */
  const mapLayer = layerOf(style, layer, civShow);
  /** 地形画在写实底图上时用哪种画法(别的画风不看它) */
  const terrainLook: SurfaceLook = style === 'realistic' ? paintedLook : 'classic';
  const devLook = { style, look: terrainLook, layer };
  // 开发者模式「放到地图上看」盖着试生成的那张:地名是这张地图的,藏起来
  const devMapOn = useDevMapOn();
  const mapViewRef = useRef({ base: mapBase, fill: mapFill, sat: satLook });
  mapViewRef.current = { base: mapBase, fill: mapFill, sat: satLook };
  const theme = studioOn || baseDark(mapBase) ? 'dark' : 'light';
  // 挂在 body 下的弹窗(AI 设置、史书)也跟着换主题;画第一帧之前就换好(首次打开深色图层时不先闪一下浅色底)
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  /** 换底图 / 填色 / 卫星画法(没给的照旧) */
  const applyMapView = useCallback((patch: Partial<{ base: BaseId; fill: FillId; sat: SatLook }>) => {
    const v = { ...mapViewRef.current, ...patch };
    const b = baseLook(v.base, v.sat);
    setStyle(b.style);
    if (b.data) setLayer(b.data);
    if (b.look) setSurface(b.look);
    setSatLook(v.sat);
    setCivShow(fillShow(v.fill));
    mapViewRef.current = v;
    writeViewUrl(v);
  }, []);
  /** 按旧的图层名换(新建界面的样式;实景 = 卫星,用记着的画法) */
  const applyLayer = useCallback(
    (id: MapLayer) => {
      const { base, fill, resources } = layerParts(id);
      applyMapView({ base, fill });
      if (resources) setCivShow({ resources: true });
    },
    [applyMapView],
  );
  /** 第一次打开的操作提示(第一次拖动 / 缩放 / 点击之后不再出现) */
  const [hintOn, setHintOn] = useState(() => !hintSeen());
  /** 分享短链接:正在取 / 停了 / 打不开(取到了 = null) */
  const [landing, setLanding] = useState<Landing>(route.stage === 'home' && init.shortShare !== null && !init.share ? 'loading' : null);
  /** 作品墙那一页 / 正在打开的作品 / 地图作品(见 WallView;不在作品墙 = null) */
  const [wall, setWall] = useState<WallView | null>(() =>
    route.stage !== 'home' || init.gallery === null || landing ? null : init.gallery ? { kind: 'work', id: init.gallery, state: 'loading' } : { kind: 'list' },
  );
  /** 换了画面就作废还在取的作品(取回来时对一下) */
  const wallSeq = useRef(0);
  /** 这一页里打开过的世界作品:世界编号 → 作品(按后退 / 前进回到它时,左上那一条照旧) */
  const workItems = useRef(new Map<string, GalleryItem>());
  /** 正在看的世界是从作品墙打开的世界作品:那个世界的编号和作品(地图左上那一条;回作品墙、换了世界就不放) */
  const [workFor, setWorkFor] = useState<WorkFor | null>(null);
  /**
   * 打开别人分享的世界:地图下那条说明(这个世界的编号;点了"知道了"、改了存进我的世界以后不再显示)。
   * at = 链接带着"这一刻"、打开停在了那里:说明开头说清停在哪一年、选中的哪国(点了「从头放」就不再说)
   */
  const [sharedFor, setSharedFor] = useState<SharedFor | null>(null);
  const touchRef = useRef(() => {});
  touchRef.current = () => {
    if (getStage().stage !== 'world') return;
    if (!hintOn) return;
    setHintOn(false);
    markHintSeen();
  };
  /** 鼠标最近在哪(视口坐标;地球仪的悬停只给像素,卡片位置用它) */
  const mouseAt = useRef<[number, number]>([0, 0]);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [replayOn, setReplayOn] = useState(false);
  /** 最上面的屏幕层(文字层放在这里,见 CivLayer 的 labelsHost) */
  const [labelsHost, setLabelsHost] = useState<HTMLDivElement | null>(null);
  /** 放大后的文明细节层放在这一层屏幕层里(见 CivLayer 的 detailHost) */
  const [civDetailHost, setCivDetailHost] = useState<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  /** 地形图、回放帧在右边接的那一份(左右无限拖动,见 mapWrap.ts) */
  const canvasCopyRef = useRef<HTMLCanvasElement>(null);
  const overlayCopyRef = useRef<HTMLCanvasElement>(null);

  const layerRef = useRef(layer);
  layerRef.current = layer;
  // 问题记录:出错、意外关闭时带上线程在忙什么、在看哪一年、哪个世界、哪个图层
  useEffect(() => {
    setDiagContext(() => ({
      doing: sim.label ?? undefined,
      year: getCivTime().year ?? undefined,
      world: genParams.current ? worldKey(genParams.current) : undefined,
      layer: layerRef.current,
    }));
    return () => setDiagContext(() => ({}));
  }, []);
  const reqId = useRef(0);
  // 改了名告诉后台线程(不排队、没有回音):正在推的那一次推完,编年史按现在的改名算,换上时不用再算一遍
  useEffect(() => {
    sim.tell({ type: 'renames', id: reqId.current, names: edits.names } satisfies WorkerRequest);
  }, [edits.names]);
  /** 只有打开世界的代码用的(照原样打开的旧世界、等原件时要发的生成请求、刚另存的新版、打不开的分享链接、世界生成完的处理;见 ./world/worldRefs.ts) */
  const openRefs = useOpenRefs();
  /**
   * 打开世界时还没核对的改名:地图上先出来的历史还没带上存档里的干预等(要在后台重推),改名的人物这时还没长出来,
   * 等重推完按推好的历史再核对(applyResim);对不上的用 show 补进打开时那条提示。terrain = 打开时的地形(改了地形就作废)
   */
  const renameCheck = useRef<RenameCheck | null>(null);
  // ---- 阶段 4 干预:带着干预在后台重推文明 ----
  /** 最近一次请求的文明是带着哪些干预推的(生成新世界时 = 没有) */
  const civEdits = useRef<readonly Intervention[]>(EMPTY_EDITS.interventions);
  /**
   * 地形大事:最近一次请求的文明带着哪些(civUps)、最近一次生成新世界时带着哪些(genUps)、地图上现在这份历史带着哪些(rawUps)。
   * 重推回来的和现在这份带着一样的大事,州才能沿用(地理没变)
   */
  const civUps = useRef<readonly Upheaval[] | undefined>(undefined);
  const genUps = useRef<readonly Upheaval[] | undefined>(undefined);
  /** 最近一次请求的文明是按哪种地名风格起名的(自动 = undefined) */
  const civNames = useRef<NameMix | undefined>(undefined);
  /** 最近一次请求的文明推到第几年(3000 = undefined) */
  const civYears = useRef<number | undefined>(undefined);
  /**
   * 再推 N 年(ExtendYears.tsx):正在推的这一次(第几次、从第 from 年推到第 to 年;没在推 = null)、第几次了;
   * 推完以后提示条上「撤销」要换回去的那一份(推之前的历史 before、推好的 after;提示条收起就放掉)
   */
  const extendRef = useRef<ExtendJob | null>(null);
  const extendSeq = useRef(0);
  /**
   * 照大纲推演(概览「大纲」页、侧栏「大纲」一组):正在推的这一次(第几次、推的那一份大纲、作者自己的干预;没在推 = null)、第几次了。
   * 推的时候改了大纲(界面先叫停)、下了别的干预(线程看到重推请求就不推了):推好的不换上
   */
  const outlineRef = useRef<OutlineJob | null>(null);
  const outlineSeq = useRef(0);
  /** 照大纲推演收起(推完、停下、被顶掉):进度和提示条一起收 */
  const endOutline = () => {
    outlineRef.current = null;
    setOutlineRun(null);
    clearToast('outline');
  };
  const extendUndo = useRef<ExtendUndo | null>(null);
  /** 地图上正看着助手的"先看看"(还没执行的历史):这时不再推(推的是底下真的那个世界) */
  const previewOn = useRef(false);
  previewOn.current = !!previewRaw;
  /** 最近一次请求的文明带的拓荒、起源(默认 = undefined) */
  const civSetup = useRef<CivSetup | undefined>(undefined);
  /**
   * 逐年推演:地图上这份历史(或正在推的那一份)推到的进度(没在逐年推演 = undefined)。一步走完换成新的进度时
   * 修改里的进度跟着换,对得上就不重推
   */
  const civPlay = useRef<PlayState | undefined>(undefined);
  /** 逐年推演的世界推好以后要不要马上往下走(刚点了「开始演绎」= true;从我的世界打开的停在"现在") */
  const stepAuto = useRef(false);
  /**
   * 刚从某一年重新演绎、正按新的进度推到那一年(界面已经换成停在那一年):推好以后不再从头进逐年推演(停着等「接着演绎」,
   * 推的时候点了播放的接着走),顶上提示"已回到第 N 年"
   */
  const rewindNote = useRef<{ year: number } | null>(null);
  /**
   * 正在切到别的一支(按那一支的进度从第 0 年重推):推好以后照常进逐年推演、停在那一支的"现在",
   * 顶上提示"已切到某一支"带「切回」原来那支。from = 原来那支的编号,year = 切到的那一支走到的那年
   */
  const switchNote = useRef<SwitchNote | null>(null);
  /** 下一次重推时顶上提示条换成这一句(切支线时写切到哪一支);用一次就清掉 */
  const resimText = useRef<string | null>(null);
  /** 刚创建的世界要接着往后推:推完再从第 0 年放一遍历史(true = 要放) */
  const storyAfterYears = useRef<boolean | null>(null);
  const rawUps = useRef<readonly Upheaval[] | undefined>(undefined);
  /** 读档 / 自动恢复套上的地形大事(按它重推完不提示) */
  const restoredUps = useRef<readonly Upheaval[] | undefined | null>(null);
  /** 第几次重推(只认最新的一次);这次重推从哪一年起变、什么时候发出去的 */
  const resimSeq = useRef(0);
  /** 读档 / 自动恢复套上的干预列表(按它重推完不提示"已生效"、不打断自动播放) */
  const restoredIv = useRef<readonly Intervention[] | null>(null);
  /** 正在重推的这一次:第几次、从哪一年起变,推完怎么说(见 ResimInfo);没在重推 = null */
  const resimInfo = useRef<ResimInfo | null>(null);
  /** 正在重推:从哪一年起变、推到哪一年(进度提示条上写) */
  const [resim, setResim] = useState<{ year: number; end?: number; text?: string } | null>(null);
  /** 正在按新的干预重推历史(缩略图等推完再截) */
  const resimRef = useRef(false);
  resimRef.current = !!resim;
  const rawRef = useRef<Civ | null>(null);
  rawRef.current = rawCiv;
  /** 当前这个世界(编号 reqId.current)的参数;回放时带给线程,线程重开过也能按参数重算 */
  const genParams = useRef<WorldParams | null>(null);
  // ---- 阶段 4 改地形:世界 = 参数 + 地形修改 ----
  /** 最近一次请求的世界带着哪些地形修改(回放、重推时带给线程) */
  const genTerrain = useRef<readonly TerrainOp[]>(EMPTY_EDITS.terrain);
  /** 最近一次请求的世界照着哪张草图(没画 = undefined;回放、重推时带给线程) */
  const genSketch = useRef<SketchEdit | undefined>(undefined);
  /** 换了新世界、还没套上它的修改(自动恢复 / 读档)之前:这时的修改不属于这个世界,不按它重新生成 */
  const fresh = useRef(false);
  /** 正在进行的"按新地形重新生成"(编号 = 那次生成的请求编号);t0 = 发出去的时刻 */
  const regenRef = useRef<RegenJob | null>(null);
  /** 地图插件长不下去的那件活(线程随后照 lost 收起它,那时不算线程出错) */
  const mapFailReq = useRef<WorkerRequest | null>(null);
  /**
   * 地图插件长不下去:新建中整张长不出来,星球上放一张卡(world/mapFail.ts);改地形涂的一笔长不出来,顶上一条、能撤销这一笔;
   * 别的(回放形成、地形大事预览……)顶上说一声。地图都还是原来那份
   */
  const mapFailedRef = useRef<(m: { plugin: string; stage: MapStage | null; why: string; kind?: MapFailedKind; spent?: MapSpent[] }, req: WorkerRequest) => void>(() => {});
  mapFailedRef.current = (m, req) => {
    const list = getMapNow()?.list ?? [];
    const rec = list.find((x) => x.id === m.plugin);
    const name = rec?.name ?? m.plugin;
    const stage = m.stage ? `「${MAP_STAGE_TEXT[m.stage]}」那一步` : '';
    const names = new Map(list.map((x) => [x.id, x.name ?? x.id]));
    const failOf = (): MapFail => ({
      worldId: targetRef.current?.id ?? '',
      plugin: m.plugin,
      name,
      ...(rec ? { version: rec.version, sum: rec.sum, ...(rec.params ? { params: Object.fromEntries(Object.entries(rec.params).filter((e): e is [string, number] => typeof e[1] === 'number')) } : {}) } : {}),
      stage: m.stage,
      why: m.why,
      kind: m.kind ?? 'throw',
      ...(m.spent ? { spent: m.spent.map((x) => ({ ...x, name: names.get(x.id) ?? x.id })) } : {}),
      seed: genParams.current?.seed ?? 0,
    });
    if (req.type === 'generate' && req.skipCiv) {
      regenRef.current = null;
      setTerrainStatus((s) => ({ ...s, busy: false }));
      setProgress(null);
      // 这一笔还在修改里,地图是上一笔的:撤销或重新长以前不能存、不能建
      setMapFail({ ...failOf(), quiet: true });
      showToast({
        id: 'map-fail',
        kind: 'warn',
        text: '这一笔没长成',
        more: [`地图插件「${name}」在${stage || '长地图时'}出错了，地图还是这一笔之前的样子`],
        actions: [
          { label: '撤销这一笔', act: 'map-fail-undo', onClick: () => void undoLastEdit() },
          { label: '看看', act: 'map-fail-look', onClick: () => setMapFail(failOf()) },
        ],
        dismissible: true,
        ttl: 0,
      });
      return;
    }
    if (req.type === 'generate') {
      setProgress(null);
      if (targetRef.current?.kind === 'draft' && getStage().stage === 'draft') return setMapFail(failOf());
    }
    // 地形大事看「会怎么样」要照插件重新长:本机对不上(没装、别的版本、停用了)先问
    const now = getMapNow();
    const cur = currentWorld();
    if (req.type === 'upPreview' && now && cur && now.id === cur.id && !now.ready) {
      closeUpheaval();
      return askMaps({ title: cur.title || '未命名世界', checks: now.checks, now: getEdits(), next: getEdits(), what: '地形大事' });
    }
    showToast({ id: 'map-fail', kind: 'warn', text: `地图插件「${name}」出错了`, more: [`${stage ? `在${stage}：` : ''}${m.why}`], dismissible: true, ttl: 0 });
  };
  /** 地图上那张整图(baseRef)是哪个世界的(线程的 baseKey;编辑地形时线程按它判断能不能只交回变了的那块) */
  const baseKeyRef = useRef<string | null>(null);
  /** 最近一次发出去的生成请求(按块重铺对不上时按整张重新要) */
  const genSent = useRef<WorkerRequest | null>(null);
  /** 编辑地形后在后台按投影画好的整张地形图(弯边投影时换上地图直接贴它,见 ui/terrainPatch.ts) */
  const preProj = useRef<PreProjected | null>(null);
  /** 正在进行的"按新地形重新生成"是一次 AI 改写 / 撤销改写(生成完说"已按你说的改写",带撤销) */
  const regenNote = useRef<RewriteNote | null>(null);
  /**
   * 编辑地形时不起名:新建世界里编辑地形(照手绘图新建是第 2 步「用笔修改」),涂了第一笔起到收起编辑地形(点「完成」「保存地图」「打造文明 ›」,
   * 照手绘图的去第 3 步、点「创建世界」)为止,按新地形重新生成只换地形、不推历史(线程的 skipCiv),地图上不标地名;
   * 收起时补推一次历史、起地名(civOnly,和一起推的逐字节一样)。null = 不在这一段里;tip = 这一段里提示过"地名等点「完成」以后再起"了
   */
  const namesHold = useRef<{ tip: boolean } | null>(null);
  /** 同 namesHold(画面用:这一段里地图上不标地名) */
  const [namesHeld, setNamesHeld] = useState(false);
  /** 地图上这个世界还没推历史(编辑地形时生成的,rawCiv = null),要补推 */
  const civLater = useRef(false);
  /** 正在补推历史、起地名:nid = 第几次补推(线程交回的只认这一次)、t0 = 发出去的时刻 */
  const naming = useRef<{ nid: number; t0: number } | null>(null);
  const namingSeq = useRef(0);
  /** 补推的进度(提示条"正在起地名"的进度条;null = 没在补推) */
  const [namingPct, setNamingPct] = useState<number | null>(null);
  /** 上一次推历史用了多久(毫秒;估补推的进度用) */
  const civMsLast = useRef<number | null>(null);
  /**
   * 地图先交的生成(新建中的世界,mapFirst):先到的世界、地图换上了没有、地图换上之前先到了的历史(done)。
   * mapEarly = 地图换上了、历史还在推(新建界面的星球这时就换上新的一颗;按钮照旧等历史)
   */
  const mapFirst = useRef<MapFirst | null>(null);
  const [mapEarly, setMapEarly] = useState(false);
  /** 补推完、地名刚换上(那一次的编号;淡入完 = 0):地图上的字淡入 */
  const [namesIn, setNamesIn] = useState(0);
  /** 这次"已按新地形重新生成"多写一行"地名等点「完成」以后再起"(每段编辑只在第一笔换上后写) */
  const holdTip = useRef(false);
  /** 编辑地形时不起名的这一段、要补推的历史、正在补推的都不算了(换了世界) */
  const endNamesHold = () => {
    namesHold.current = null;
    setNamesHeld(false);
    civLater.current = false;
    naming.current = null;
    setNamingPct(null);
  };
  /** 地图上现在这个世界带着的地形修改(覆盖层据此标出还在生成的那几处) */
  const [shownTerrain, setShownTerrain] = useState<readonly TerrainOp[]>(EMPTY_EDITS.terrain);
  const [shownSketch, setShownSketch] = useState<SketchEdit | undefined>(undefined);
  const [terrainStatus, setTerrainStatus] = useState<TerrainStatus>({ busy: false });
  const terrainTool = useTerrainTool();
  // 导入图片时地图上只看图(地名先藏起来)
  const importing = useImportOn();
  const sourceView = useSourceView();
  // 手机:改地形、回放世界形成都要看地图 —— 拉到顶的世界卡片先收起来(两样都是从卡片里的"地形"那一组点开的)
  useEffect(() => {
    if (terrainTool.on || replayOn) setWorldSheet('peek');
  }, [terrainTool.on, replayOn]);
  // 点了一条大事(卡片里的"最近大事"、编年史):时间轴跳过去、地图上标出来 —— 世界卡片也先收起
  const chronPick = useChroniclePick();
  useEffect(() => {
    if (chronPick.entry) setWorldSheet('peek');
  }, [chronPick]);
  // 3D 地球仪(网址 proj=globe,旧链接的 view=globe 也认 / 地图右下角的按钮):主图藏起来,同一套时间轴、详情面板、选中逻辑
  const globeOn = useGlobeOn();
  /** 地球仪第一帧画好了(打开时它先在后台备贴图,这之前平面地图照旧显示着) */
  const [globeShown, setGlobeShown] = useState(false);
  if (!globeOn && globeShown) setGlobeShown(false);
  /** 等值线画不画:新建世界时、地球仪上不画 */
  const contourOn = !!contourKind && !draft && !globeOn;
  /** 地理图:左上角放海拔色标(地球仪上不放) */
  const atlasOn = mapBase === 'geo' && !globeOn;
  /** 思潮填色:左上角放看的哪一说、五档色标 */
  const ideoLegend = mapFill === 'ideology' && !!civ?.ideology && civ.viable;
  // 等值线、经纬网的墨色:白模、地理图是浅底,和数据底图一样用深色线
  const contourStyle = mapBase === 'blank' || mapBase === 'geo' ? 'data' : style;
  const contourInkNow = contourKind ? contourInk(contourKind, contourStyle, baseDark(mapBase)).line : undefined;
  const globeApi = useRef<GlobeApi | null>(null);
  /** 世界坐标 → 屏幕坐标(地图上的事件标签、截图脚本用;下面 __wfWorldToClient 那里定义) */
  const worldToClient = useRef<WorldToClient | null>(null);
  /** 地球仪上的世界坐标 → 屏幕坐标(转到背面 = null),地球仪打开时给事件标签用 */
  const globeToClient = useRef<WorldToClient>((wx, wy) => globeApi.current?.worldToClient(wx, wy) ?? null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  /** 最近生成完的世界(打开的世界就是正在看的这一个时,不用重新生成) */
  const lastReady = useRef<{ world: World; civ: Civ } | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  /** 生成出来的世界(地形大事以前的;线程回调里用) */
  const baseRef = useRef(baseData);
  /** 最近一次编辑地形(按新地形重新生成)换上的那一份(就是 baseRef 那个对象;之后换了别的世界 = null):样式缩略图先留着旧的 */
  const editedRef = useRef<object | null>(null);
  const eraMapsRef = useRef(eraMaps);
  eraMapsRef.current = eraMaps;
  /** 弯边投影:当前投影 + 中心放进地图平面(等距圆柱 = null,照原来的办法画) */
  const mp = useMemo(() => (data ? curvedProj(projection, mapCenter, data.world.width, data.world.height) : null), [data, projection, mapCenter]);
  const mpRef = useRef<MapProj | null>(mp);
  mpRef.current = mp;
  /** 地图现在怎么画(编辑地形按块换上时,线程回调里看这一份决定重画哪种像素层) */
  const drawView = useRef<PatchView>({ style, look: paintedLook, mp });
  drawView.current = { style, look: paintedLook, mp };
  /** 地图现在这种底图在缓存里的键(baseKeyOf):整张交回来的新主图换上之前,先在后台把这一张备好 */
  const drawKey = useRef(baseKeyOf(style, layer, paintedLook));
  drawKey.current = baseKeyOf(style, layer, paintedLook);
  // 换段:要换过去的那一段的整张底图(这种底图)、写实 / 卫星画风整张图上的河、文明层第一次要画的,在后台分小步备好,
  // 备好了 eraK 再换过去(和换上那一下一口气整张画逐像素相同)。又要换到别的段(接着拖时间轴、又到了补丁)就顶掉重备
  useEffect(() => {
    if (!baseData || eraK === eraNext) return;
    const k = eraNext;
    const raw = previewRaw ?? rawCiv;
    const view = drawView.current;
    const key = warmKey;
    let d: { world: World; raster: Raster } | null = null;
    const steps: WorkStep[] = [
      // 拼那一段的主图(补丁贴到原主图的复制品上)
      () => void (d = eraData(baseData, eraMaps, eraPatches.current, k)),
      later(() => [
        ...thumbPrepSteps(key, d!.world, d!.raster),
        ...(view.style === 'realistic' ? realisticRiverSteps(d!.world, d!.raster, view.look) : []),
        ...(raw ? civOpenSteps({ world: d!.world, raster: d!.raster, civ: civAtEra(raw, k), style: view.style as Style, mp: view.mp }) : []),
      ]),
    ];
    // 备料出了错:不再等,换过去(换上时照常当场画),错误照常报出去
    let failed = false;
    const guarded = steps.map((s): WorkStep => (deadline) => {
      if (failed) return;
      try {
        return s(deadline);
      } catch (e) {
        failed = true;
        setTimeout(() => {
          throw e;
        });
      }
    });
    submitDetailJob(
      ERA_WARM_JOB,
      guarded,
      () => {
        eraWarm.current = { data: d ?? eraData(baseData, eraMaps, eraPatches.current, k), key };
        setWarmVer((n) => n + 1);
      },
      { alone: true },
    );
    return () => cancelDetailJob(ERA_WARM_JOB);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- patchVer:补丁变了要换的那一段的主图跟着变;previewRaw / rawCiv 只在换段时取
  }, [baseData, eraMaps, patchVer, eraK, eraNext, warmKey]);

  // 生成、打开世界的代码(线程交回的生成、打开那几种消息,./world/useWorldLoad.ts)要读要改的状态,按块收拢(见 ./world/worldRefs.ts)
  const genRefs: GenRefs = { reqId, targetRef, genParams, genTerrain, genSketch, fresh, regenRef, genSent, baseKeyRef, preProj, mapFirst, setMapEarly, lastReady, rawRef, setParams, setProgress };
  const civRefs: CivRefs = { civEdits, civUps, genUps, rawUps, civNames, civYears, civSetup, civPlay, civMsLast, civLater, setRawCiv };
  const mapRefs: MapRefs = { baseRef, setData, editedRef, eraPatches, setPatchVer, eraMapsRef, setEraMaps, eraAt, eraWarm, drawView, drawKey };

  // ---- 后台线程 ----
  // 开线程、关线程、发请求、记账、收消息先做的公共几步都在 ./sim/simClient.ts(为什么忙时换世界要关掉线程重开,也见那里);
  // 这里接收到的各种消息。回调在第一次渲染时定下、之后不换(和这些回调要用的 ref 一样),要用每次渲染新的函数时经 xxxRef.current 调
  const [sim] = useState(() => {
    const client = new SimClient({
      spawn: () => new Worker(WORKER_URL, { type: 'module' }),
      currentId: () => reqId.current,
      ...simFailOpt(),
      mapFailed: (m, req) => {
        mapFailReq.current = req;
        mapFailedRef.current(m, req);
      },
      on: {
        // 生成、打开世界那几种(世界和地图、进度、原件读不出来、原件、主图补丁、地形大事预览):见 ./world/worldMessages.ts
        ...worldMessages({
          gen: genRefs,
          civ: civRefs,
          map: mapRefs,
          open: openRefs,
          send: (req) => sendRef.current(req),
          tell: (req) => client.tell(req),
          terrainDone: (world, rc, ms) => terrainDoneRef.current(world, rc, ms),
        }),
        history: (m) => setReplay({ w: m.w, h: m.h, frames: m.frames, mya: m.mya, idx: 0 }),
        civ: (m) => {
          if (m.seq !== resimSeq.current) return; // 又下了新的干预,等最新的那一次
          applyResimRef.current(m.civ, m.ms, m.eras, m.baseKey);
        },
        civOnly: (m) => namesDoneRef.current(m.nid, m.civ, m.civMs),
        turn: (m) => applyTurnRef.current(m.civ, m.play, m.rejected, m.eras, m.baseKey),
        extendProgress: (m) => {
          if (extendRef.current?.xid === m.xid) extendProgress(m.xid, m.year, m.pct);
        },
        extended: (m) => applyExtendedRef.current(m.xid, m.civ, m.to, m.ms, m.eras, m.baseKey),
        extendStopped: (m) => {
          if (extendRef.current?.xid === m.xid) {
            extendRef.current = null;
            setExtendBusy(null);
          }
        },
        outlineProgress: (m) => outlineProgressRef.current(m.oid, m.done, m.total, m.review, m.at),
        outlined: (m) => applyOutlinedRef.current(m.oid, m.civ, m.interventions, m.review, m.ms, m.eras, m.baseKey),
        outlineStopped: (m) => {
          if (outlineRef.current?.oid === m.oid) endOutline();
        },
      },
      // 线程出错、重发过一次又出错的活(见 ./sim/simClient.ts 文件头「线程出错」):不再算它,界面上收起,地图上还是原来那份。
      // 生成世界、重推、再推没推成的弹「后台算不动了」那张卡(多半是内存不够),能再推一次;读档退回旧的路,回放帧、地形大事预览再点一次就是新的一件活
      lost: (req) => {
        // 地图插件长不下去(mapFailed 已经说过了):不算线程出错,不弹「后台算不动了」
        const quiet = mapFailReq.current === req;
        if (quiet) mapFailReq.current = null;
        const noteCrash = quiet ? () => {} : noteCrashNow;
        // 打开世界的那件重发过又出错了:退回旧的路
        if (req.type === 'load') {
          endLoadWatch();
          const back = openRefs.loadBack.current;
          openRefs.loadBack.current = null;
          back?.('broken');
        } else if (req.type === 'generate') {
          if (req.skipCiv) return;
          setProgress(null);
          noteCrash(() => sendRef.current(req));
        } else if (req.type === 'resim') {
          if (req.seq !== resimSeq.current) return;
          const info = resimInfo.current;
          resimInfo.current = null;
          setResim(null);
          if (!getStepwise().switching)
            noteCrash(() => {
              if (req.seq !== resimSeq.current) return;
              resimInfo.current = info && { ...info, t0: performance.now() };
              setResim({ year: info?.year ?? 0 });
              sendRef.current(req);
            });
          // 这次重推推完要说的、要做的,不留给下一次
          rewindNote.current = switchNote.current = null;
          storyAfterYears.current = null;
          // 正在切到别的一支(照那一支从第 0 年重推)没推成:回到原来那一支(地图上还是它的历史),停在它的"现在"
          const sw = getStepwise().switching;
          const back = sw ? switchBranch(getEdits(), sw.from, sw.last) : null;
          if (back?.play) {
            civPlay.current = back.play;
            putEditsQuiet(back);
            enterStepwise(playFromOf(back), playAt(back.play) / YEAR_TICKS);
            const stuck = rawRef.current?.stuck;
            if (stuck) stepStuck(playAt(back.play) / YEAR_TICKS, stuck.at);
            setCivTime({ year: playAt(back.play) / YEAR_TICKS, playing: false, scrubbing: false, story: false });
          } else if (sw) branchSwitching(null);
        } else if (req.type === 'turn') {
          // 这一步没算成:随它交出去的干预先放回单子,再收起这一步(等着这一步算完的切支线、重新演绎照单子里的算,不丢);
          // 停下播放,不然播放头一走到"现在"又交一步,一直重算
          const items = getStepwise().busy?.items;
          if (items) restorePending(items);
          stepLost();
          setCivTime({ playing: false });
          if (getStepwise().on) noteCrash(() => getStepwise().on && setCivTime({ year: getStepwise().now, playing: true, scrubbing: false, story: false }));
        } else if (req.type === 'extend') {
          if (extendRef.current?.xid === req.xid) {
            extendRef.current = null;
            setExtendBusy(null);
            noteCrash(() => {
              const from = rawRef.current?.endYear;
              if (from !== undefined && req.to > from) extendStart(req.to - from);
            });
          }
        } else if (req.type === 'outline') {
          if (outlineRef.current?.oid === req.oid) {
            endOutline();
            noteCrash(() => startOutline(req.tries ?? 0));
          }
        } else if (req.type === 'civOnly' && naming.current?.nid === req.nid) {
          naming.current = null;
          setNamingPct(null);
        }
      },
    });
    (window as unknown as { __wfSimFail?: (year?: number) => void }).__wfSimFail = (year) => client.setSimFail(year);
    return client;
  });
  const send = useCallback(
    (req: WorkerRequest) => {
      // 换了世界、读档、重推、逐年推演走一步:正在再推的那一次线程会自己停下(推了一半的不要),界面上跟着收起
      if (extendRef.current && (req.type === 'generate' || req.type === 'load' || req.type === 'resim' || req.type === 'turn')) {
        extendRef.current = null;
        setExtendBusy(null);
      }
      // 照大纲推演同样:线程看到排着的新请求就不推了(交回 outlineStopped),界面上先收起
      if (outlineRef.current && (req.type === 'generate' || req.type === 'load' || req.type === 'resim' || req.type === 'turn' || req.type === 'extend')) endOutline();
      if (req.type === 'generate') genSent.current = req;
      // 又要了一个新世界:还在后台备着换上的那一次已经过时了(线程交回的旧结果本来也不认)
      if (req.type === 'generate' || req.type === 'load') {
        cancelTerrainPatch();
        dropPreparedRivers();
        resetStuck();
        // 又要长了:上一次地图插件长不出来的卡、提示收起
        setMapFail(null);
        clearToast('map-fail');
      }
      // 交回历史的请求带上现在的改名:线程先交套上它的编年史(打开世界时那两种自己带着存档里的改名;试推演不换上,不用)
      const named =
        (req.type === 'generate' || req.type === 'civOnly' || req.type === 'resim' || req.type === 'turn' || req.type === 'extend') && !req.renames
          ? { ...req, renames: getEdits().names, characters: getEdits().characters }
          : req.type === 'outline'
            ? { ...req, characters: getEdits().characters }
            : req;
      // 生成、读档先关掉还在忙的线程;记账、带上扩张节拍
      sim.send(named);
    },
    [sim],
  );
  const sendRef = useRef(send);
  sendRef.current = send;
  // 助手的试推演、逐年推演(算一步、从某一年开始、存回推演模式、重新演绎、切支线)、地形大事的"会怎么样":接到后台线程上,见 ./sim/useSimRunners.ts
  useSimRunners({
    sim,
    send,
    gen: genRefs,
    civ: civRefs,
    resim: { resimInfo, resimText, switchNote, stepAuto, rewindNote },
    later: { openStored: (id) => openStoredRef.current(id) },
  });

  // 线程交回的推演结果换上界面(重推、逐年推演一步、再推、照大纲推演;历史换了一份时选中的东西跟着换),见 ./sim/useSimResults.ts
  const { remapSelection, applyResimRef, applyTurnRef, applyExtendedRef, extendDone, dropExtendUndo, outlineProgress, outlineProgressRef, applyOutlinedRef, stopOutlineRun } = useSimResults({
    sim,
    reqId,
    rawRef,
    setRawCiv,
    rawUps,
    civUps,
    civEdits,
    civPlay,
    civYears,
    genTerrain,
    baseRef,
    eraMapsRef,
    setEraMaps,
    resimInfo,
    setResim,
    renameCheck,
    rewindNote,
    stepAuto,
    switchNote,
    storyAfterYears,
    extendRef,
    extendUndo,
    outlineRef,
    endOutline,
    realCiv,
    realCivRef,
    narrowRef,
    shownRaw,
  });
  // 「再推」「照大纲推演」:接到后台线程上(ExtendYears.tsx 调 extendStart / extendStop;大纲页、侧栏调 startOutline / stopOutline),见 ./sim/useSimRunners.ts
  useExtendOutlineRunners({
    sim,
    send,
    gen: genRefs,
    civ: civRefs,
    map: mapRefs,
    resim: { resimInfo, extendRef, dropExtendUndo },
    runs: { previewOn, extendSeq, outlineRef, outlineSeq, outlineProgress, stopOutlineRun },
  });

  // ---- 生成、打开世界(./world/useWorldLoad.ts):生成新世界、生成完套上修改,打开网页时、打开存档 / 文件 / 分享链接,换到新建 / 世界 / 我的世界 ----
  // 下面几样在后面才定义(回我的世界、作品墙在 ./world/useWorldPages.ts,浏览器的后退前进),经 ref 调;定义的地方填 .current
  const showHomeRef = useRef<() => void>(() => {});
  const wallRef = useRef<{ open: (id: string) => void; list: () => void }>({ open: () => {}, list: () => {} });
  const navRef = useRef<NavHooks>(null as unknown as NavHooks);
  const resimRefs: ResimRefs = { resimSeq, resimInfo, setResim, resimText, switchNote, storyAfterYears, stepAuto, restoredIv, restoredUps, renameCheck, extendRef, extendDone, dropExtendUndo };
  const viewRefs: WorldViewRefs = { mapViewRef, draftViewRef, drawKey, applyMapView, applyLayer, setHover };
  const { generate, enterStage, openTarget, openStored, openText, openShortShare } = useWorldLoad({
    gen: genRefs,
    civ: civRefs,
    open: openRefs,
    resim: resimRefs,
    terrain: { endNamesHold, setTerrainStatus, setShownTerrain, setShownSketch },
    view: viewRefs,
    page: { init, route, wall, landing, presetLink, setLanding, setNewDlg, setSharedFor, setDraftTitle, setReplay, setReplayOn },
    send,
    later: {
      showHome: () => showHome(),
      openWork: (id) => openWork(id),
      holdMoment: (id, moment) => {
        pendingMoment.current = { id, moment };
        // 打开的就是正在看的这张图(地址栏里又贴了一个分享链接):画面不会再变一次,也要停过去
        setMomentTick((n) => n + 1);
      },
      showHomeRef,
      wallRef,
      navRef,
    },
  });
  // 页面卸下时关掉后台线程(排着的试推演一起作废)。放在 useWorldLoad 后面:卸下时先收它「打开网页时打开世界」那个 effect(不再记前进后退、不再听地址栏的 #),再关线程
  useEffect(() => () => sim.dispose(), []);

  // ---- 改了地形、干预以后在后台重算(./world/useEditRecompute.ts):地形修改、草图一变就带着新地形重新生成世界;编辑地形时不起名,收起以后补推历史、起地名;
  // 干预、地形大事、地名风格、推演年数、拓荒起源、逐年推演的进度一变就带着新的重推文明 ----
  const { releaseNames, namesDoneRef, terrainDoneRef } = useEditRecompute({
    send,
    gen: genRefs,
    civ: civRefs,
    map: mapRefs,
    resim: resimRefs,
    terrain: { namesHold, setNamesHeld, naming, namingSeq, setNamingPct, setNamesIn, holdTip, regenNote, setShownTerrain, setShownSketch, setTerrainStatus },
    now: { edits, draft, plainDraft, baseData, data, rawCiv, terrainTool },
    page: { setReplay, setReplayOn },
  });

  // ---- 存档(阶段 4):自动存、自动恢复、读档;建好的世界推完以后把结果(原件)存进浏览器(./world/useWorldSave.ts) ----
  useAutoSave();
  // 世界仓库(./worldStore.ts)要知道用的人是不是在推演(转存旧世界时让路),要关页面时叫线程把等着的内容打好
  useEffect(() => setWorldStoreSim({ busy: () => sim.busy > 0, packNow: () => sim.tell({ type: 'packNow', id: reqId.current }), packParts: (ask) => sim.packParts({ ...ask, id: reqId.current }), sims: () => simsOf(currentWorld()?.id), maps: () => mapFilesOf(currentWorld()?.id) }), []);
  // AI(阶段 5):登记服务商、恢复设置、调用记录存本地
  useEffect(() => setupAi(), []);
  // 「使用 AI 功能」关了:助手停下、回到现在、收起;正在写的史书停下(写到一半的不存),写史书的窗口、阅读页关上
  const aiOn = useAiOn();
  useEffect(() => {
    if (aiOn) return;
    stopAsk();
    exitPreview();
    closeAssistant();
    stopBook();
    closeHistoryBook();
    closeBookReader();
  }, [aiOn]);
  // 缩略图("我的世界"的卡片、存档菜单、地图缩略图)交给 saveStore 来要;推演完记下结束那一年现存几国(./world/useWorldSave.ts)。
  // 画缩略图用的底图缓存(mapsOf、baseCanvas)在后面「渲染」那一段才定义,经 later 调
  useSaveThumbs({
    gen: genRefs,
    civ: civRefs,
    map: mapRefs,
    dataRef,
    resimRef,
    rawCiv,
    later: { mapsOf: (d) => mapsOf(d), baseCanvas: (key, d) => baseCanvas(key, d) },
  });
  // 投影 / 中心 / 经纬网停下来约半秒:写进网址(刷新、复制网址都还在),已经存着的世界跟着重存一次(./world/useRouteNav.ts)
  useViewUrl({ projection, mapCenter, graticule, contourKind });
  // ---- 作品墙、新建世界(以底稿新建、在地图上打造新文明)、回我的世界、按新版另存一份(./world/useWorldPages.ts) ----
  const {
    showGallery,
    openWork,
    keepWork,
    takePresetWork,
    startDraft,
    cancelDialog,
    startFromDialog,
    draftNow,
    draftState,
    draftSeed,
    draftParams,
    draftMaps,
    draftRename,
    createWorld,
    draftFromCurrent,
    saveMap,
    startNewCiv,
    newCivOnWork,
    derivedUntouched,
    showHome,
    goHome,
    openStoredRef,
    v,
    draftBack,
  } = useWorldPages({
    gen: genRefs,
    civ: civRefs,
    open: openRefs,
    resim: resimRefs,
    view: viewRefs,
    load: { generate, enterStage, openTarget, openStored, openText },
    page: { init, fromHome, draft, stageBase, newDlg, setNewDlg, setDraftTitle, setLanding, setSharedFor, setWall, wallSeq, workItems, workFor, setWorkFor, resim, replayOn, setReplayOn },
    releaseNames,
    sim,
    later: { showHomeRef, wallRef },
  });
  // ---- 照故事找世界(FinderPage.tsx;条件、结果在 finderStore.ts;./world/useStoryFinder.ts) ----
  const { finderBack, outlineSrc, openFinderPage, exitFinder, finderPreviewData, finderFly, takeFinderPick, moveFoundOutline, foundCreated, foundNow } = useStoryFinder({
    gen: genRefs,
    view: viewRefs,
    load: { generate, openTarget, openStored },
    pages: { draftNow, draftState },
    world: { data, rawCiv, realCiv, realCivRef, progress },
    page: { draft, finder, finderOn, studioOut, params, edits, narrowRef },
    later: { flyToPoints: (pts, where, zoom) => flyToPoints(pts, where, zoom) },
  });
  // ---- 浏览器的后退、前进(nav.ts):换到记着的那一步;只是看看的、新建中的世界存下了改写网址(./world/useRouteNav.ts) ----
  useRouteNav({
    gen: genRefs,
    civ: civRefs,
    resim: resimRefs,
    load: { enterStage, openTarget, openStored, openShortShare },
    pages: { showHome, showGallery, openWork, derivedUntouched, draftNow, draftSeed, v },
    page: { home, setLanding, setNewDlg, setWall, wallSeq, workItems, setWorkFor, setReplayOn },
    shownRaw,
    navRef,
  });
  // 把文件拖进页面 = 从文件打开;照手绘图新建时拖进来的图片 = 换成这张重新认(./world/useFileDrop.ts)
  const { dropping, onDragOver, onDragLeave, onDrop } = useFileDrop({ targetRef, openText });

  // ---- 渲染 ----
  // 画好的整张图按「画风 / 图层」各存一份(离屏画布),同一个世界里切回去直接贴上;
  // 地形大事前后是两张图,各存一份(最近的 MAP_KEEP 张;来回拖时间轴不用重画),世界一换就清空。
  // 用画布对画布复制而不是 getImageData,不从显卡读回像素,
  // 免得浏览器把主画布降级成软件渲染(那样河流、墨线的抗锯齿会变样)。
  // 用 useLayoutEffect:地形先于文明层(CivLayer 里的 useEffect)画好 —— 手绘风的文明层要借地形的符号层给水彩"让位"。
  const cacheRef = useRef<{ data: { raster: Raster }; base: unknown; maps: Map<string, HTMLCanvasElement> }[]>([]);
  /**
   * d 这一张图的缓存(用到的挪到最前);同一个世界(同一张生成出来的主图、地块索引是同一份)留最近 MAP_KEEP 张,别的释放。
   * 编辑地形涂一笔以后主图换了一张(地块索引还是那一份):旧主图的几张也放掉,不再当成同一个世界的另一段留着
   */
  const mapsOf = (d: { raster: Raster }): Map<string, HTMLCanvasElement> => {
    const list = cacheRef.current;
    const hit = list.find((e) => e.data === d);
    if (hit) {
      cacheRef.current = [hit, ...list.filter((e) => e !== hit)];
      return hit.maps;
    }
    const base = baseRef.current?.raster;
    const keep = list.filter((e) => e.base === base && e.data.raster.cell === d.raster.cell).slice(0, MAP_KEEP - 1);
    for (const e of list) if (!keep.includes(e)) for (const c of e.maps.values()) c.width = c.height = 0; // 尽快释放显存
    const maps = new Map<string, HTMLCanvasElement>();
    cacheRef.current = [{ data: d, base, maps }, ...keep];
    return maps;
  };
  eraCached.current = (d, key) => !!cacheRef.current.find((e) => e.data === d)?.maps.has(key);
  /** 弯边投影:地形图(缓存里的等距圆柱原图)按投影铺到屏幕上 */
  const terrainProj = useRef(new ProjLayer());
  /** 上次画的是哪个世界、哪种画风 / 图层(弯边投影下只改中心时只重铺,不算"画了新的一张") */
  const drawnKey = useRef<{ data: unknown; key: string } | null>(null);
  /** 地图视图:缩放倍数、平移(缩放 / 平移见 ./map/useMapView.ts) */
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  /**
   * 弯边投影、放大到细节层盖住整个视口(TerrainDetail 按投影重画了看得见的那一块):底下这张整图看不见,
   * 不用按投影精画(整图精画一次几百毫秒),整图重铺就够了(露边时也对得上);缩小到细节层以下再精画
   */
  const terrainCovered = curved && view.k > DETAIL_K && (style === 'fantasy' || style === 'realistic');
  /** 按新地形重新生成的世界画到地形图上了:记下下一帧(地图在屏幕上换上)的时刻(冒烟检查、测速用) */
  const noteShown = () => {
    const rg = regenRef.current;
    if (!rg || rg.arrived === undefined || rg.shown !== undefined) return;
    rg.shown = -1;
    requestAnimationFrame(() => (rg.shown = performance.now() - rg.t0));
  };
  useLayoutEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !data) return;
    const { world, raster } = data;
    const maps = mapsOf(data);
    const key = baseKeyOf(style, layer, paintedLook);
    const render = (ctx: CanvasRenderingContext2D) => {
      if (style === 'realistic') renderRealistic(ctx, world, raster, paintedLook);
      else if (style === 'fantasy') renderFantasy(ctx, world, raster);
      else renderLayer(ctx, world, raster, layer);
    };
    const t0 = performance.now();
    const hit = maps.get(key);
    const fresh = drawnKey.current?.data !== data || drawnKey.current.key !== key;
    drawnKey.current = { data, key };
    if (mp) {
      // 弯边投影:原图画在离屏画布上(和等距圆柱共用缓存),按投影铺到屏幕上;不接右边那一份
      let src = hit;
      if (!src) {
        src = document.createElement('canvas');
        src.width = raster.w;
        src.height = raster.h;
        render(src.getContext('2d')!);
        maps.set(key, src);
      }
      const t1 = performance.now();
      const proj = terrainProj.current;
      // 编辑地形后在后台按投影画好的那一版(同一张图、同一个投影和中心、同一种画风和画法)
      const p = preProj.current;
      const pre = p && p.raster === raster && p.key === mp.key && p.style === style && (style !== 'realistic' || p.look === paintedLook) ? p.canvas : null;
      preProj.current = null;
      presentTerrain(cv, mp, { world, raster, style, look: terrainLook, src, layer: proj, moving: projMoving || terrainCovered, pre, swap: !fresh });
      if (p) p.canvas.width = p.canvas.height = 0;
      mirrorCanvas(canvasCopyRef.current, null, false);
      const w = window as unknown as { __wf: unknown; __wfProj: unknown };
      w.__wfProj = { proj: mp.def.id, lon: mp.lon0, ms: performance.now() - t1, pending: terrainRefining() };
      if (fresh) w.__wf = { ready: !mapFirst.current?.shown, renderMs: performance.now() - t0, style, layer, proj: mp.def.id };
      noteShown();
      dropPreparedRivers(raster.water);
      return;
    }
    terrainProj.current.release();
    cv.width = raster.w;
    cv.height = raster.h;
    const ctx = cv.getContext('2d')!;
    if (hit) ctx.drawImage(hit, 0, 0);
    else render(ctx);
    const renderMs = performance.now() - t0;
    if (!hit) {
      const copy = document.createElement('canvas');
      copy.width = raster.w;
      copy.height = raster.h;
      copy.getContext('2d')!.drawImage(cv, 0, 0);
      maps.set(key, copy);
    }
    // 右边再接一份(左右无限拖动)
    mirrorCanvas(canvasCopyRef.current, cv, true);
    // 检查脚本用:画好了(mark 没了);ready = 世界齐了(地图先换上的新建世界,历史到了才算,见 takeCiv)
    (window as unknown as { __wf: unknown }).__wf = { ready: !mapFirst.current?.shown, renderMs, style, layer };
    noteShown();
    // 给这张图后台描好的河没用上(换上前换了画风、缓存里本来就有):放掉
    dropPreparedRivers(raster.water);
  }, [data, style, layer, paintedLook, terrainLook, mp, projMoving, terrainCovered]);

  /**
   * 某画风的整张底图(等距圆柱,和 raster 一样大):缓存里有就直接给,没有就画一张放进缓存(图层缩略图用;之后切过去也不用再画)。
   * 默认画地图上这一段的;d = 别的段的世界和主图(存档缩略图画结束那一年的)
   */
  const baseCanvas = useCallback((key: string, d0?: { world: World; raster: Raster }): HTMLCanvasElement | null => {
    const d = d0 ?? dataRef.current;
    if (!d) return null;
    const maps = mapsOf(d);
    let c = maps.get(key);
    if (!c) {
      c = document.createElement('canvas');
      c.width = d.raster.w;
      c.height = d.raster.h;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      if (key === 'realistic') renderRealistic(ctx, d.world, d.raster);
      else if (key.startsWith('realistic:')) renderRealistic(ctx, d.world, d.raster, key.slice(10) as SurfaceLook);
      else if (key === 'fantasy') renderFantasy(ctx, d.world, d.raster);
      else renderLayer(ctx, d.world, d.raster, key.slice(5) as LayerId);
      maps.set(key, c);
    }
    return c;
  }, []);
  // 缩略图和地图画同一段:时间轴在地形大事以前时,底图是那一段的,州也要用那一段的(shownRaw)
  // 编辑地形换上的新地形:缩略图先留着涂之前的,停笔一会儿再重画;正在按新地形重新生成时先不画
  const { thumbs, request: requestThumbs } = useLayerThumbs(
    { data, civ: shownRaw, baseCanvas, edited: editedRef.current, busy: !!progress?.regen },
    baseThumb(mapBase, satLook),
  );
  /** 正在画的底图(缩略图上转圈;画好之前地图先留着原来的) */
  const [pendingBase, setPendingBase] = useState<{ base: BaseId; sat: SatLook } | null>(null);
  const pickTok = useRef(0);
  /**
   * 点了一种底图(或卫星画法):缓存里有就直接换;没有就先在缩略图上转圈、让界面画一帧,画好整张再换过去;
   * 没画出来就留在原来的底图,顶上提示带「重试」
   */
  const pickBase = useCallback(
    (base: BaseId, sat: SatLook = mapViewRef.current.sat) => {
      const d = dataRef.current;
      const b = baseLook(base, sat);
      const key = baseKeyOf(b.style, b.data ?? layer, paintLook(b.look ?? surface, mapViewRef.current.fill));
      clearToast('base-fail');
      if (!d || mapsOf(d).has(key)) {
        pickTok.current++;
        setPendingBase(null);
        return applyMapView({ base, sat });
      }
      const tok = ++pickTok.current;
      const was = mapViewRef.current;
      setPendingBase({ base, sat });
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (tok !== pickTok.current) return;
          let ok = false;
          try {
            ok = !!baseCanvas(key, d);
          } catch (e) {
            console.error('底图没画出来', e);
          }
          setPendingBase(null);
          if (dataRef.current !== d) return;
          if (ok) return applyMapView({ base, sat });
          showToast({
            id: 'base-fail',
            kind: 'error',
            text: `${baseName(base, sat)}没画出来，地图还是${baseName(was.base, was.sat)}`,
            more: ['年份、位置、选中的都没动'],
            action: { label: '重试', act: 'base-retry', onClick: () => pickBase(base, sat) },
          });
        }),
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyMapView, baseCanvas, layer, surface],
  );

  // ---- 回放:看世界长出来 ----
  const startReplay = () => {
    if (!data || !genParams.current) return;
    setTerrainTool({ on: false });
    closeUpheaval();
    prepareCivReplay(); // 文明层先退回第 0 年,等地质放完再接着放文明
    setReplayOn(true);
    if (replay) setReplay({ ...replay, idx: 0 });
    else send({ type: 'history', id: reqId.current, params: genParams.current, terrain: [...genTerrain.current], sketch: genSketch.current, ...mapsOpt(civSetup.current) });
  };
  /** 弯边投影:回放帧先放在离屏的等距圆柱原图上,再按投影铺到屏幕上 */
  const overlayProj = useRef(new ProjLayer());
  useEffect(() => {
    if (!replayOn || !replay) return;
    const cv = overlayRef.current;
    if (!cv) return;
    const frame = new ImageData(new Uint8ClampedArray(replay.frames[replay.idx]), replay.w, replay.h);
    const m = mpRef.current;
    if (m) {
      overlayProj.current.source(replay.w, replay.h).getContext('2d')!.putImageData(frame, 0, 0);
      overlayProj.current.present(cv, m, pageColor(style));
      mirrorCanvas(overlayCopyRef.current, null, false);
    } else {
      cv.width = replay.w;
      cv.height = replay.h;
      cv.getContext('2d')!.putImageData(frame, 0, 0);
      mirrorCanvas(overlayCopyRef.current, cv, !!data);
    }
    const last = replay.idx >= replay.frames.length - 1;
    const t = setTimeout(
      () => (last ? (setReplayOn(false), getStage().stage === 'world' && startCivReplay()) : setReplay((r) => (r ? { ...r, idx: r.idx + 1 } : r))),
      last ? 1400 : replay.idx === 0 ? 900 : 260,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayOn, replay]);
  // 回放时改了投影 / 中心:这一帧按新的重铺(不打断回放的节奏)
  useEffect(() => {
    const cv = overlayRef.current;
    if (!cv || !replayOn || !replay) return;
    if (mp && overlayProj.current.has()) overlayProj.current.present(cv, mp, pageColor(style));
    else if (!mp) overlayProj.current.release();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mp]);

  /** 某一点的完整读数(群落、海拔、国家、最近城市……;冒烟检查经 window.__wfProbe 读,下面悬停那里填) */
  const probeRef = useRef<(cx: number, cy: number) => string[] | null>(() => null);
  // 舞台和地图框的大小、平移范围、中心经度、滚轮和按钮缩放、双击复位,见 ./map/useMapView.ts
  const { box, stageSize, drag, pinch, wrapW, geo, curvedRef, clampRef, sb, viewRef, centerFrame, scheduleCenter, flyRaf, stopFly, zoomRef, zoomButton, resetView, zoomToCluster } = useMapView({
    view,
    setView,
    stageRef,
    data,
    dataRef,
    narrow,
    panelOpen,
    projection,
    curved,
    init,
    globeApi,
    mp,
    mpRef,
    drawView,
    worldToClient,
    probeRef,
    hover,
    setHover,
    touchRef,
  });
  setTerrainWrap(wrapW);
  // 编辑地形的高度笔按地图上现在这个世界读海拔
  setTerrainProbe(data);

  const chron = useChronicle();
  // 世界里开着的(选中、概览、史书)变了:画好以后报给 nav.ts(多打开一张算一步);世界好了再打开退回来的那一步记着的
  const ovNow = useOverview();
  const readerNow = useBookReader();
  useEffect(() => {
    if (stage !== 'world' || !shownRaw) return;
    const l = layerNow(shownRaw);
    if (l) navLayer(l);
  }, [stage, shownRaw, selState.sel, ovNow.open, ovNow.tab, chron.polity, readerNow.open, readerNow.key]);
  useEffect(() => {
    navSettled(navRef.current.settled());
  }, [stage, rawCiv, resim, edits, shownRaw]);
  const picking = usePolityPick();
  // 新建界面摊平改地形:舞台挪到中间那块(正好 2:1,地图框正好铺满),视图放回 1 倍、转到刚摊平时正中的经线
  // (等舞台换成那块的大小再转;同一次摊平只转一次)
  const flatSeq = useRef(0);
  useEffect(() => {
    const f = studioFlat;
    if (!studioOn || !f || f.lon === undefined || f.seq === flatSeq.current || !wrapW || !sb.bw) return;
    if (Math.abs(sb.sw - f.rect.w) > 1 || Math.abs(sb.sh - f.rect.h) > 1) return;
    flatSeq.current = f.seq;
    stopFly();
    // 整像素:主图和右边接的那一份正好对齐,接缝处不透出一道暗线
    const v0 = viewCentredAt({ k: 1, x: 0, y: 0 }, sb, wrapW, xOfLon(f.lon, wrapW));
    const v = { ...v0, x: Math.round(v0.x) };
    viewRef.current = v;
    setView(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studioFlat, studioOn, sb.sw, sb.sh, sb.bw, wrapW]);
  // 新建界面收起平面地图时从平常的地图现在的样子变回星球:正中的经线、1 弧度多少像素、正中和赤道在视口里的位置
  useEffect(() => {
    setFlatGeomSource(() => {
      const el = stageRef.current;
      const g = geo.current;
      const v = viewRef.current;
      if (!el || !g.bw || !g.wrap || getProjection() !== 'equirect') return null;
      const r = el.getBoundingClientRect();
      return { lon: getMapCenter(), kpx: (v.k * g.bw) / (2 * Math.PI), cx: r.left + r.width / 2, cy: r.top + v.y + (v.k * r.height) / 2 };
    });
    return () => setFlatGeomSource(null);
  }, []);
  // 飞到某处(选中、导播、分享链接的镜头、照故事找世界)和编年史跳转时的平移,见 ./map/useMapFly.ts
  const { flyRef, flyCamera, flyCameraRef, flyToPoints, cameraNow } = useMapFly({
    data,
    dataRef,
    civ,
    box,
    replayOn,
    narrow,
    panelOpen,
    stageRef,
    globeApi,
    worldToClient,
    mpRef,
    viewRef,
    geo,
    clampRef,
    setView,
    flyRaf,
    stopFly,
  });
  const directorOnPref = useDirectorOn();
  const civStory = useCivStory();
  /** 打开带"这一刻"的分享链接:要停到的那一刻(画面出来、历史重推完以后用掉) */
  const pendingMoment = useRef<{ id: string; moment: SaveMoment } | null>(null);
  const [momentTick, setMomentTick] = useState(0);
  /** 照"这一刻"选中时,选中以后镜头飞到这里(不按选中的国家另飞) */
  const momentCam = useRef<SaveCamera | null>(null);
  useEffect(() => {
    const pm = pendingMoment.current;
    // 带着干预、逐年推演的进度的世界:生成完还要重推一次(resimInfo),推完再停(逐年推演的推完会把时间轴放到"现在")
    // 正在回放世界形成:放完再停(放完会接着放文明,停的那一年要在它后面设)
    if (!pm || !data || !rawCiv || !box.w || !stageSize.w || resimInfo.current || replayOn) return;
    pendingMoment.current = null;
    if (currentWorld()?.id !== pm.id) return;
    // 对到这个世界上:年份超出这段历史、国家或州找不到(生成器换了版本)的那一样不管;有地形大事的按那一年那一段的州认
    const y = pm.moment.year;
    const rm = resolveMoment(y !== undefined && rawCiv.eras?.length ? civAtEra(rawCiv, eraIndex(rawCiv, Math.min(y, rawCiv.endYear))) : rawCiv, pm.moment);
    setSharedFor((s) => (s && s.id === pm.id ? { ...s, at: rm.year !== undefined ? { year: rm.year, sel: rm.selected ?? null } : null } : s));
    if (rm.year !== undefined) setCivTime({ year: rm.year, playing: false, scrubbing: false, story: false });
    const sel: MapSelection | null = rm.selected ?? null;
    if (sel && !sameSelection(sel, getSelection().sel)) {
      momentCam.current = rm.camera ?? null;
      setSelection(sel);
      return;
    }
    // 分享的人那时没选中东西(或者对不上):这边原来选着的也收起来(地址栏里又贴了一个链接、还是这张图时会留着)
    if (!sel) clearSelection();
    if (rm.camera) flyCamera(rm.camera);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, rawCiv, box.w, stageSize.w, resim, momentTick, replayOn]);
  /** 复制分享链接时的"这一刻":时间轴那一年、选中的国家或州(withSelection)、镜头 */
  const momentRef = useRef<(withSelection: boolean) => MomentNow | null>(() => null);
  momentRef.current = (withSelection) => {
    const c = civ;
    // 助手"先在地图上看看"时,地图上是试推演的历史,存档里还是原来的;正在重推历史时,地图上还是旧的那份:都不带这一刻(年份、国家对不上)
    if (!c || !c.viable || !shownRaw || previewRaw || resimInfo.current || !dataRef.current || getStage().stage !== 'world') return null;
    const year = Math.min(c.endYear, Math.max(0, getCivTime().year ?? c.endYear));
    const moment: SaveMoment = { year };
    let name: string | null = null;
    const sel = withSelection ? getSelection().sel : null;
    if (sel && (sel.kind === 'polity' || sel.kind === 'region')) {
      const key = selectionKey(shownRaw, sel);
      const p = sel.kind === 'polity' ? c.polities[sel.id] : null;
      if (key) {
        moment.selected = key;
        name = p ? polityName(p, shownYearOf(p, year, c.endYear)) : regionLabel(c, sel.id);
      }
    }
    const camera = cameraNow();
    if (camera) moment.camera = camera;
    return { moment, year: yearFull(year, getEdits().era), name };
  };
  useEffect(() => {
    setMomentSource((withSelection) => momentRef.current(withSelection));
    return () => setMomentSource(null);
  }, []);
  // 按稳定键认"选中的是不是换了":重推历史后编号变了、还是同一个东西,不再飞
  const selStable = shownRaw && selState.sel ? selectionKey(shownRaw, selState.sel) : '';
  useEffect(() => {
    if (!selStable) return;
    pausePlayback();
    // 打开带"这一刻"的分享链接时的选中:镜头照分享的人的,不按选中的国家另飞
    const cam = momentCam.current;
    momentCam.current = null;
    if (cam) return flyCameraRef.current(cam);
    // 人物关系图开着(盖住了地图;图上换中心、左边卡片跟着换):不飞,「在地图上看」时再飞
    if (!getRelation().open) flyRef.current('sel');
  }, [selStable]);
  const flyReq = panelUi.fly;
  useEffect(() => {
    if (flyReq) flyRef.current(flyReq.to);
  }, [flyReq]);

  /**
   * 屏幕坐标 → 主图上的像素(不在地图上 = null)。
   * 视窗外面(宽屏两边的空白)不算;主图右边接的那一份、跨过 180° 经线的地方按列取模 —— 接缝两边点到的是同一块地
   */
  const pixelAt = (cx: number, cy: number): [number, number] | null => {
    if (getGlobeOn()) return data ? (globeApi.current?.pixelAt(cx, cy) ?? null) : null;
    if (!data || !canvasRef.current) return null;
    if (mp) {
      // 弯边投影:屏幕 → 地图平面 → 反投影回世界坐标(外轮廓外面 = 不在地图上)
      const w = worldAt(cx, cy);
      if (!w) return null;
      const s = data.raster.scale;
      return [Math.min(data.raster.w - 1, Math.floor(w[0] * s)), Math.min(data.raster.h - 1, Math.floor(w[1] * s))];
    }
    const cr = canvasRef.current.getBoundingClientRect();
    let px = Math.floor(((cx - cr.left) / cr.width) * data.raster.w);
    const py = Math.floor(((cy - cr.top) / cr.height) * data.raster.h);
    if (!inWindow(cx)) return null;
    px = ((px % data.raster.w) + data.raster.w) % data.raster.w;
    if (px < 0 || py < 0 || px >= data.raster.w || py >= data.raster.h) return null;
    return [px, py];
  };
  /** 屏幕上这一点在不在视窗(外框 ∩ 舞台)里 */
  const inWindow = (cx: number): boolean => {
    const el = stageRef.current;
    if (!el || !box.w) return false;
    const r = el.getBoundingClientRect();
    const [wl, wr] = windowSpan(view.k, { sw: r.width, sh: r.height, bw: box.w, bh: box.h });
    return cx - r.left >= wl && cx - r.left <= wr;
  };
  /** 屏幕坐标 → 地块(不在地图上 = −1) */
  const cellAt = (cx: number, cy: number): number => {
    const p = pixelAt(cx, cy);
    return p && data ? data.raster.cell[p[1] * data.raster.w + p[0]] : -1;
  };
  /**
   * 屏幕坐标 → 世界坐标(地图原图的像素坐标;不在地图上 = null)。
   * x 取模到 [0, 宽)(改地形画线时由 TerrainTools 按上一个点展开,跨接缝的线是连着的一笔)
   */
  const worldAt = (cx: number, cy: number): [number, number] | null => {
    if (!data || !canvasRef.current) return null;
    const cr = canvasRef.current.getBoundingClientRect();
    let u = (cx - cr.left) / cr.width;
    const v = (cy - cr.top) / cr.height;
    if (!inWindow(cx)) return null;
    if (mp) {
      if (!(u >= 0 && v >= 0 && u <= 1 && v <= 1)) return null;
      return unprojectWorld(mp, u * data.world.width, v * data.world.height);
    }
    u -= Math.floor(u);
    if (!(u >= 0 && v >= 0 && u <= 1 && v <= 1)) return null;
    return [u * data.world.width, v * data.world.height];
  };
  // ---- 作者标记(MarkLayer.tsx 画、markStore.ts 管放标记和正在填的那一份) ----
  /** 屏幕坐标 → 世界坐标(地球仪按球上的像素;不在地图上 = null) */
  const markWorldAt = (cx: number, cy: number): [number, number] | null => {
    if (!data) return null;
    if (getGlobeOn()) {
      const p = globeApi.current?.pixelAt(cx, cy);
      const sc = data.raster.scale;
      return p ? [(p[0] + 0.5) / sc, (p[1] + 0.5) / sc] : null;
    }
    return worldAt(cx, cy);
  };
  /** 屏幕坐标 → 州号(海上、地图外 = −1) */
  const regionAtClient = (cx: number, cy: number): number => {
    const c = cellAt(cx, cy);
    return civ && c >= 0 && c < civ.regions.of.length ? civ.regions.of[c] : -1;
  };
  const markApi = useRef<MarkApi | null>(null);
  markApi.current = {
    // 世界坐标 → 舞台坐标:平面主图(左右相连,按视窗裁)、弯边投影、地球仪
    frame: () => {
      const el = stageRef.current;
      const g = geo.current;
      if (!el || !g.bw) return null;
      const r = el.getBoundingClientRect();
      const at = `${r.left},${r.top},${r.width},${r.height}`;
      const base = { left: r.left, top: r.top, w: r.width, h: r.height };
      if (getGlobeOn()) {
        const ga = globeApi.current;
        const gv = ga?.viewSig();
        if (!ga || !gv) return null;
        const pt = (wx: number, wy: number): [number, number] | null => {
          const p = ga.worldToClient(wx, wy);
          return p ? [p[0] - r.left, p[1] - r.top] : null;
        };
        return { ...base, pt, period: 0, win: [0, r.width], k: gv.k, cut: 0, sig: `g|${gv.sig}|${at}` };
      }
      const b = { sw: r.width, sh: r.height, bw: g.bw, bh: g.bh };
      const v = viewRef.current;
      const m = mpRef.current;
      const sig = `${m?.key ?? 'f'}|${v.k},${v.x},${v.y}|${at}|${g.bw},${g.bh}`;
      if (m) {
        const pt = (wx: number, wy: number): [number, number] => {
          const [x, y] = projectWorld(m, wx, wy);
          return worldToStage(x, y, v, b, g.W, g.H);
        };
        return { ...base, pt, period: 0, win: [0, r.width], k: v.k, mapCss: g.bw, cut: 0.4 * g.bw * v.k, sig };
      }
      const pt = (wx: number, wy: number) => worldToStage(wx, wy, v, b, g.W, g.H);
      return { ...base, pt, period: g.wrap ? (g.wrap / g.W) * g.bw * v.k : 0, win: g.wrap ? windowSpan(v.k, b) : [0, r.width], k: v.k, mapCss: g.bw, cut: 0, sig };
    },
    regionAt: regionAtClient,
    onMap: (cx, cy) => !!pixelAt(cx, cy),
    // 地球仪上的字另画,不躲
    textBoxes: () => (getGlobeOn() ? { ver: -1, list: [] } : mapTextBoxes()),
  };
  /** 这一年(时间轴当前那年,取整) */
  const markYear = () => (civ ? Math.floor(Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear))) : 0);
  /**
   * 悬停时标记要说的:放标记、圈州时写鼠标下是哪(海上也行);正在填一个点的标记时图钉上是"能拖"的光标;
   * 停在地图上的标记上 = 它的名字和年份(停在图钉、名字上时 tip = 图钉尖,小卡片放在它左上方;圈州时小卡片放在鼠标左边)。
   * info 不给 = 照常的悬停小卡片;整个不归标记管 = null
   */
  const markHoverAt = (cx: number, cy: number): { info?: HoverInfo | null; cursor: string; tip?: [number, number] | null; left?: boolean } | null => {
    if (!civ || !data) return null;
    const mk = getMarkUi();
    const year = markYear();
    const owner = (r: number) => ownerName(civ, ownersAt(civ, year).polity[r], year);
    if (mk.placing || mk.draft?.scope === 'regions') {
      const w = markWorldAt(cx, cy);
      if (!w) return { info: null, cursor: '' };
      const r = regionAtClient(cx, cy);
      if (mk.placing) {
        const name = r >= 0 ? regionLabel(civ, r) : (markSpot(civ, data.world, data.raster, w, year).sea ?? '海上');
        return { info: { name, sub: r >= 0 ? owner(r) : undefined, extra: '点一下，在这里放标记' }, cursor: 'none' };
      }
      if (r < 0) return { info: null, cursor: '' };
      const on = mk.draft!.regions.includes(regionKey(civ, r));
      return { info: { name: regionLabel(civ, r), sub: owner(r), extra: on ? '再点一下去掉' : '点一下加进来' }, cursor: 'pointer', left: true };
    }
    if (mk.draft) return markPinAt(cx, cy, mk.draft.id) ? { info: null, cursor: 'grab' } : { cursor: 'crosshair' };
    const hit = markHitAt(cx, cy);
    if (!hit) return null;
    if (hit.kind === 'cluster') return { info: null, cursor: 'zoom-in' };
    const m = getEdits().marks?.find((x) => x.id === hit.ids[0]);
    return m ? { info: markHover(m), cursor: 'pointer', tip: hit.kind === 'pill' ? null : markPinTip(m.id) } : null;
  };
  /** 挑地方时点地图得到的地方:城镇符号、城名 = 那座城;陆地 = 那一州;海上 = 那一点 */
  const whereAtClient = (cx: number, cy: number): Where | null => {
    if (!civ) return null;
    const hit = labelAt(cx, cy);
    if (hit?.kind === 'settlement' && civ.settlements[hit.id]) return whereOfCity(civ, hit.id);
    const r = regionAtClient(cx, cy);
    if (r >= 0) return whereOfRegion(civ, r);
    return markWorldAt(cx, cy);
  };
  /**
   * 悬停时作者的人物要说的:挑地方时写鼠标下是哪(那一年归谁);停在地图上的头像上 = 名字、那年多大、在哪。
   * 不归人物管 = null(再看标记的)
   */
  const charHoverAt = (cx: number, cy: number): { info?: HoverInfo | null; cursor: string; tip?: [number, number] | null; left?: boolean } | null => {
    if (!civ || !data) return null;
    const cu = getCharUi();
    if (cu.picking && cu.draft) {
      const w = whereAtClient(cx, cy);
      if (!w) return { info: null, cursor: '' };
      const t = cu.picking === 'birth' ? cu.draft.bornText : cu.draft.sub?.kind === 'life' ? cu.draft.sub.d.yearText : '';
      const ty = parseCharYear(t);
      const year = ty === null || Number.isNaN(ty) ? markYear() : ty;
      const pl = placeOf(civ, data.world, data.raster, w, year);
      const sub = pl.region !== undefined ? ownerName(civ, ownersAt(civ, Math.min(civ.endYear, year)).polity[pl.region], year) : undefined;
      return { info: { name: pl.name, sub, extra: '点一下，选这里' }, cursor: 'none' };
    }
    const id = characterPinAt(cx, cy);
    if (id === null) return null;
    const c = getEdits().characters?.find((x) => x.id === id);
    return c ? { info: characterHover(civ, data.world, data.raster, c, markYear()), cursor: 'pointer', tip: characterPinTip() } : { info: null, cursor: 'pointer' };
  };
  /** 标记说的悬停小卡片(有图钉尖就放在图钉左上方,圈州时放在鼠标左边) */
  const markHoverCard = (mh: { info?: HoverInfo | null; tip?: [number, number] | null; left?: boolean }, x: number, y: number) =>
    setHover(mh.info ? (mh.tip ? { info: mh.info, x: mh.tip[0], y: mh.tip[1], place: 'above' } : { info: mh.info, x, y, place: mh.left ? 'left' : undefined }) : null);
  /** 正在拖的图钉(按下的那根手指 / 鼠标);松手的时刻(紧跟着的 click 不算点地图) */
  const pinDrag = useRef<number | null>(null);
  const pinDragEnd = useRef(-1e9);
  // 按在正在填的标记的图钉上:拖图钉(捕获阶段:地图、地球仪都不拖)
  const onMarkDownCapture = (e: React.PointerEvent) => {
    const d = getMarkUi().draft;
    if (!d || d.scope !== 'point' || !d.at || replayOn || (e.pointerType === 'mouse' && e.button !== 0) || touches.current.size > 1) return;
    if (!markPinAt(e.clientX, e.clientY, d.id)) return;
    e.stopPropagation();
    stopFly();
    pinDrag.current = e.pointerId;
    setMarkDragging(true);
    setHover(null);
    if (stageRef.current) stageRef.current.style.cursor = 'grabbing';
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMarkMoveCapture = (e: React.PointerEvent): boolean => {
    if (pinDrag.current !== e.pointerId) return false;
    e.stopPropagation();
    const w = markWorldAt(e.clientX, e.clientY);
    if (w) patchDraft({ at: w });
    return true;
  };
  const onMarkUpCapture = (e: React.PointerEvent) => {
    if (pinDrag.current !== e.pointerId) return;
    e.stopPropagation();
    pinDrag.current = null;
    pinDragEnd.current = performance.now();
    setMarkDragging(false);
    if (stageRef.current) stageRef.current.style.cursor = '';
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const el = stageRef.current;
    if (!el || getGlobeOn()) return;
    // 双指捏合:等下一帧一起算
    if (pinch.current) {
      if (e.pointerType === 'touch') schedulePinch();
      return;
    }
    const rect = el.getBoundingClientRect();
    if (terrainPointer.current === null || e.pointerId === terrainPointer.current) {
      terrainMove(worldAt(e.clientX, e.clientY));
      upMove(worldAt(e.clientX, e.clientY));
    }
    let label: ReturnType<typeof pickLabelAt> = null;
    let mh: ReturnType<typeof markHoverAt> = null;
    let trade: number | null = null;
    if (drag.current) {
      dragMove(e, drag.current, rect);
    } else {
      // 鼠标停在能点的字 / 城镇符号上:手指光标(改地形时不管字);作者标记上 / 放标记 / 圈州时按标记的
      const tool = getTerrainTool().on || getUpUi().on;
      label = tool || draft ? null : pickLabelAt(e.clientX, e.clientY);
      mh = tool || draft || replayOn ? null : (charHoverAt(e.clientX, e.clientY) ?? markHoverAt(e.clientX, e.clientY));
      // 商道的线(字、标记底下):那条亮一圈,出商道的悬停小卡
      trade = tool || draft || replayOn || label || mh ? null : tradeAtClient(e.clientX, e.clientY);
      el.style.cursor = toolCellPick.get() ? 'crosshair' : mh ? mh.cursor : label || trade !== null ? 'pointer' : '';
    }
    setTradeHover(drag.current && moved.current ? null : trade);
    // 悬停小卡片:拖动、改地形、回放、新建时不显示;手指没有"悬停"(点了直接出面板)
    if (!data || (drag.current && moved.current) || getTerrainTool().on || getUpUi().on || replayOn || draft || e.pointerType === 'touch') return setHover(null);
    if (mh && mh.info !== undefined) return markHoverCard(mh, e.clientX, e.clientY);
    if (trade !== null && civ) {
      const info = tradeHoverInfo(civ, trade, Math.floor(Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear))), getEdits().era ?? null);
      return setHover(info ? { info, x: e.clientX, y: e.clientY } : null);
    }
    const p = pixelAt(e.clientX, e.clientY);
    if (!p) return setHover(null);
    showHover(p, label, e.clientX, e.clientY);
  };
  probeRef.current = (cx, cy) => {
    const p = pixelAt(cx, cy);
    return p && data ? probeLines(data.world, data.raster, civ, p[0], p[1]) : null;
  };
  const showHover = (p: [number, number], label: ReturnType<typeof pickLabelAt>, x: number, y: number) => {
    if (!data) return;
    const info = hoverInfo({ world: data.world, raster: data.raster, civ, px: p[0], py: p[1], layer: { style, data: layer, ...fillShow(mapFill) }, label, year: getCivTime().year });
    setHover(info ? { info, x, y } : null);
  };
  // 改地形只在等距圆柱主图上改:地球仪、弯边投影里打开改地形就先切回等距圆柱(中心不变,地球仪的接上它正对着的经度);
  // 改地形时换成别的投影 = 收起改地形
  useEffect(() => {
    if (terrainTool.on && getProjection() !== 'equirect') setProjection('equirect');
  }, [terrainTool.on]);
  useEffect(() => {
    if (projection !== 'equirect' && getTerrainTool().on) setTerrainTool({ on: false });
    if (projection !== 'equirect' && getUpUi().on) closeUpheaval();
  }, [projection]);
  // 地形大事同样只在等距圆柱主图上放、涂:打开时先切回等距圆柱;打开时详情、选目标、放标记、改地形一起收起
  useEffect(() => {
    if (!upOn) return;
    if (getProjection() !== 'equirect') setProjection('equirect');
    setSheet('half');
    clearSelection();
    setPolityPick(null);
    stopPlacing();
    setTerrainTool({ on: false });
    setHover(null);
  }, [upOn]);
  // 选中了别的东西(搜索、编年史):卡片让给它;改地形打开:收起
  useEffect(() => {
    if (selState.sel && getUpUi().on) closeUpheaval();
  }, [selState.sel]);
  useEffect(() => {
    if (terrainTool.on) closeUpheaval();
  }, [terrainTool.on]);
  // 编辑地形的「板块」页:地图换成板块配色(看得见边界和漂移箭头);离开这一页、收起编辑地形时换回原来的(其间作者自己换过就不动)
  const platePage = terrainTool.on && pageOf(terrainTool.tool) === 'plates';
  const beforePlates = useRef<{ base: BaseId; fill: FillId; sat: SatLook } | null>(null);
  useEffect(() => {
    if (platePage) {
      if (mapLayer !== 'plates') {
        // 记下整套底图 + 填色 + 卫星画法(旧的图层名合不下"高程底图上填国家"这类搭配)
        beforePlates.current = { ...mapViewRef.current };
        applyLayer('plates');
      }
    } else if (beforePlates.current) {
      if (mapLayer === 'plates') applyMapView(beforePlates.current);
      beforePlates.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在进出板块页时换
  }, [platePage]);

  // ---- 点选(阶段 4):单击(不是拖动)选中 城镇符号 / 城名 → 城,国名 → 国家,地名 → 地理实体;
  // 都没点到:"国家"开着时点到国土 → 国家,否则 → 州;点到海上 / 地图外 = 取消。双击(复位视图)不改选中 ----
  /** 双击的第一下之前选中的是什么(第二下时恢复) */
  const beforeClick = useRef<MapSelection | null>(null);
  const onStageClick = (e: React.MouseEvent) => {
    // 只管点在地图(或地图外的空白)上的:时间轴、按钮、图例上的点击冒泡上来不算
    const t = e.target as HTMLElement;
    if (t !== e.currentTarget && !t.closest('.canvas-wrap, .globe')) return;
    // 点地图收起菜单的那一下只收起菜单(dismissClick.ts)
    if (tookDismissClick()) return;
    // 地球仪还在备贴图:屏幕上还是平面图,点了不按看不见的球去选
    if (getGlobeOn() && !globeApi.current?.ready()) return;
    if ((getGlobeOn() ? globeApi.current?.dragged() : moved.current) || replayOn) return;
    // 导出回放视频时:地图只用来挪、缩放(框住要拍的地方),点了不选东西
    if (getFilm().mode) return;
    // 改地形:单击放火山 / 挖湖,不看详情(双击的第二下不再放)
    if (getTerrainTool().on) {
      if (e.detail < 2) terrainClick(worldAt(e.clientX, e.clientY));
      return;
    }
    // 地形大事:单击放火山,不看详情
    if (getUpUi().on) {
      if (e.detail < 2) upClick(worldAt(e.clientX, e.clientY));
      return;
    }
    // 新建时还没有历史,点了不看详情
    if (draft) return;
    // 插件请用的人点一处:点到的地块交给它(不选别的)
    const tp = toolCellPick.get();
    if (tp) {
      const c = e.detail < 2 ? cellAt(e.clientX, e.clientY) : -1;
      if (c >= 0) tp.done(c);
      return;
    }
    // 作者的人物:正在填的时候点地图不选别的;挑地方时 = 选好那一处(城 / 州 / 海上那一点)
    const cu = getCharUi();
    if (civ && cu.draft) {
      if (e.detail >= 2 || !cu.picking) return;
      const w = whereAtClient(e.clientX, e.clientY);
      if (w) {
        pickPlace(w);
        setHover(null);
      }
      return;
    }
    // 作者标记:放标记 = 在点到的地方新建一个;正在填的标记:一个点 = 图钉挪到点到的地方,几个州 = 点到的州加进来 / 去掉(都不选别的)
    const mk = getMarkUi();
    if (civ && (mk.placing || mk.draft)) {
      if (e.detail >= 2 || performance.now() - pinDragEnd.current < 400) return;
      if (mk.draft?.scope === 'regions') {
        const r = regionAtClient(e.clientX, e.clientY);
        if (r >= 0) toggleDraftRegion(regionKey(civ, r));
        return;
      }
      const w0 = markWorldAt(e.clientX, e.clientY);
      if (!w0) return;
      // 点在关口符号(或关名)上:图钉吸到关口正中(钉在关上);拖图钉不吸,拖开就是普通的一个点
      const pass = passAt(e.clientX, e.clientY);
      const cell = pass >= 0 && civ.places[pass]?.kind === 'pass' ? civ.places[pass].cell : undefined;
      const w: [number, number] = cell !== undefined && data ? [data.world.mesh.x[cell], data.world.mesh.y[cell]] : w0;
      if (mk.placing) {
        newMarkDraft({ at: w, year: markYear() });
        setHover(null);
      } else patchDraft({ at: w });
      return;
    }
    // 双击的第二下(手指点两下时浏览器不一定数成 detail = 2):恢复第一下之前的选中
    if (e.detail >= 2 || performance.now() - dblTapAt.current < 600) {
      setSelection(beforeClick.current);
      return;
    }
    // 干预选对象国 / 迁都选城(阶段 4):点到的国家 / 城交给干预区,不改选中
    const pk = getPolityPick();
    if (pk) {
      const city = pk.target === 'settlement';
      const region = pk.target === 'region';
      const id = city ? settlementAtClick(e.clientX, e.clientY) : region ? regionAtClient(e.clientX, e.clientY) : polityAtClick(e.clientX, e.clientY);
      const err = id >= 0 ? pk.accept(id) : city ? '这里没有城,点一座城的符号或城名' : region ? '这里不是陆地,点一个州' : '这里没有国家,点一个国家的国土或国名';
      finishPick(pk, err);
      return;
    }
    beforeClick.current = getSelection().sel;
    const el = stageRef.current;
    const rect = el?.getBoundingClientRect();
    const side = rect && e.clientX - rect.left > rect.width * 0.55 ? 'left' : 'right';
    // 作者的人物的头像(画在最上面,先看它)
    const ch = characterPinAt(e.clientX, e.clientY);
    if (ch !== null) return setSelection({ kind: 'character', id: ch }, side);
    // 作者标记(画在地名上面,先看它):图钉、名字、名字牌 = 选中它;合并的圆 = 在那里放大
    const mh = markHitAt(e.clientX, e.clientY);
    if (mh) {
      if (mh.kind === 'cluster') return zoomToCluster(e.clientX, e.clientY);
      return setSelection({ kind: 'mark', id: mh.ids[0] }, side);
    }
    const hit = labelAt(e.clientX, e.clientY);
    if (hit) return setSelection(hit, side);
    // 商道的线(开着「道路」时画在文字层上;地球仪上画在球面那层上):商道卡片
    const tr = tradeAtClient(e.clientX, e.clientY, getGlobeOn() ? 'globe' : 'map');
    if (tr !== null) return setSelection({ kind: 'trade', id: tr }, side);
    const c = cellAt(e.clientX, e.clientY);
    const r = civ && c >= 0 && c < civ.regions.of.length ? civ.regions.of[c] : -1;
    if (!civ || r < 0) return clearSelection();
    // 信仰图层:点陆地 = 那里信的那个教(国名、城名照旧打开国家、城)
    if (getCivShow().faiths && civ.religion) {
      const y = Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear));
      const f = faithAt(civ, y)[r];
      if (f >= 0) return setSelection({ kind: 'faith', id: f }, side);
    }
    // 思潮填色:点陆地 = 那一州(州卡片里列这州各说几成)
    if (getCivShow().ideology && civ.ideology) return setSelection({ kind: 'region', id: r }, side);
    // 民族填色:点陆地 = 那里住的民族(和信仰一样)
    if (fillOf(getCivShow()) === 'cultures') {
      const c = ownersAt(civ, Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear))).culture[r];
      if (c >= 0) return setSelection({ kind: 'culture', id: c }, side);
    }
    if (getCivShow().polities && civ.polities.length) {
      const y = Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear));
      const po = ownersAt(civ, y).polity[r];
      if (po >= 0) return setSelection({ kind: 'polity', id: po }, side);
    }
    setSelection({ kind: 'region', id: r }, side);
  };
  /** 点到的城镇符号 / 城名 / 国名 / 地名(主图:文字层;地球仪:球上的符号文字层) */
  const labelAt = (x: number, y: number) => (getGlobeOn() ? (globeApi.current?.labelAt(x, y) ?? null) : pickLabelAt(x, y));
  /** 单击处的国家(时间轴当前那一年;点到国名也算;没有 = −1) */
  const polityAtClick = (x: number, y: number): number => {
    if (!civ) return -1;
    const hit = labelAt(x, y);
    if (hit?.kind === 'polity') return hit.id;
    const c = cellAt(x, y);
    const r = c >= 0 && c < civ.regions.of.length ? civ.regions.of[c] : -1;
    if (r < 0) return -1;
    const yr = Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear));
    return ownersAt(civ, yr).polity[r];
  };

  // 打开改地形:单击不再看详情,已经打开的详情面板、"在地图上点一个国家"一起收起
  useEffect(() => {
    if (!terrainTool.on) return;
    clearSelection();
    setPolityPick(null);
    stopPlacing();
  }, [terrainTool.on]);
  // 作者标记:放标记时顶部一条提示(取消 = Esc);换了世界、回到我的世界、回放世界形成时放标记、正在填的一律作废。
  // 开始放标记时,"在地图上点一个国家"(干预选目标)收起,免得两件事抢同一下点击
  const markPlacing = useMarkUi().placing;
  useEffect(() => {
    if (markPlacing) setPolityPick(null);
  }, [markPlacing]);
  useEffect(() => {
    if (markPlacing) showToast({ id: 'mk', kind: 'info', text: '点地图放标记', more: ['陆地、海上都可以'], action: { label: coarse ? '取消' : '取消 · Esc', act: 'mark-cancel', onClick: stopPlacing } });
    else clearToast('mk');
  }, [markPlacing, coarse]);
  // 作者的人物:挑地方时顶部一条提示(取消 = Esc);开始挑时"在地图上点一个国家"收起
  const charPicking = useCharUi().picking;
  useEffect(() => {
    if (charPicking) {
      setPolityPick(null);
      showToast({
        id: 'oc-pick',
        kind: 'info',
        text: charPicking === 'birth' ? '点地图选出生地' : '点地图选这段经历在哪',
        more: ['城、州、海上都可以'],
        action: { label: coarse ? '取消' : '取消 · Esc', act: 'character-pick-cancel', onClick: stopPicking },
      });
    } else clearToast('oc-pick');
  }, [charPicking, coarse]);
  /** 能放标记:建好的世界、有历史(新建、回放世界形成时不行) */
  const markable = !!data && stage === 'world' && !!civ && !replayOn;
  const markWorld = data?.world;
  useEffect(() => {
    resetMarkUi();
    resetCharacterUi();
  }, [markWorld, home, replayOn, draft]);

  /** 单击处的城(点到城镇符号 / 城名;否则点到的州里时间轴当前那一年还在的城;没有 = −1) */
  const settlementAtClick = (x: number, y: number): number => {
    if (!civ) return -1;
    const hit = labelAt(x, y);
    if (hit?.kind === 'settlement') return hit.id;
    const c = cellAt(x, y);
    const r = c >= 0 && c < civ.regions.of.length ? civ.regions.of[c] : -1;
    if (r < 0) return -1;
    const yr = Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear));
    const s = civ.settlements.find((q) => q.region === r && q.founded <= yr && (q.ended === undefined || q.ended > yr));
    return s ? s.id : -1;
  };
  // 鼠标和手指:拖动、捏合、点一下 / 点两下,Safari 的捏合;见 ./map/useMapGestures.ts
  const { moved, touches, terrainPointer, dblTapAt, schedulePinch, dragMove, onTouchDownCapture, onTouchMoveCapture, onTouchUpCapture, onPointerDown, onPointerUp } = useMapGestures({
    view,
    setView,
    viewRef,
    stageRef,
    globeApi,
    mp,
    mpRef,
    box,
    geo,
    curvedRef,
    clampRef,
    drag,
    pinch,
    centerFrame,
    scheduleCenter,
    zoomRef,
    stopFly,
    resetView,
    touchRef,
    mouseAt,
    setHover,
    worldAt,
  });
  // Esc 和键盘快捷键,见 ./useAppShortcuts.ts
  useAppShortcuts({ home, draft, stage, data, civ, replayOn, narrow, zoomButton, applyLayer, applyMapView });

  /** 平面主图 ⇄ 地球仪:两边的中心经度接上(地球仪从主图当前的中心转起;切回主图时转到地球仪正对着的经度) */
  const toggleGlobe = () => {
    setHover(null);
    if (!getGlobeOn()) return setGlobeOn(true);
    // 切回上一个平面投影(中心接上地球仪正对着的经度,见 ./map/useMapView.ts 里换投影那一段)
    setGlobeOn(false);
  };
  // 地球仪:回放帧、地形画布什么时候重画过(换世界 / 画风 / 图层)
  const globeReplay = useMemo(
    () => (replayOn && replay ? { w: replay.w, h: replay.h, frame: replay.frames[replay.idx] } : null),
    [replayOn, replay],
  );
  const terrainKey = useMemo(() => ({ data, style, layer, look: terrainLook }), [data, style, layer, terrainLook]);
  const onGlobeHover = (p: [number, number] | null) => {
    if (!p || !data || replayOn) {
      setTradeHover(null);
      return setHover(null);
    }
    const [x, y] = mouseAt.current;
    const mh = draft ? null : (charHoverAt(x, y) ?? markHoverAt(x, y));
    const label = globeApi.current?.labelAt(x, y) ?? null;
    // 商道的线(字、标记底下):那条亮一圈,出商道的悬停小卡(和平面地图一样)
    const trade = draft || mh || label ? null : tradeAtClient(x, y, 'globe');
    setTradeHover(trade);
    if (stageRef.current) stageRef.current.style.cursor = mh ? mh.cursor : '';
    if (mh && mh.info !== undefined) return markHoverCard(mh, x, y);
    if (trade !== null && civ) {
      const info = tradeHoverInfo(civ, trade, Math.floor(Math.min(civ.endYear, Math.max(0, getCivTime().year ?? civ.endYear))), getEdits().era ?? null);
      return setHover(info ? { info, x, y } : null);
    }
    showHover(p, label, x, y);
  };
  // ---- 顶部提示条:生成进度、重推历史、选目标、改地形的结果(同一时间只显示最近的一条) ----
  // 生成世界(首次打开、换种子、调参数、读档)/ 按新地形重新生成:一行"正在…",小字是种子和这一步在做什么
  useEffect(() => {
    // 照故事找世界打开一个结果:地图顶上那一条写着"正在打开",不另出提示条
    // 地图先换上了、地图插件还在补图层
    const backfill = mapEarly && progress?.stage.startsWith('地图插件');
    if (progress && !finderOn)
      showToast({
        id: 'progress',
        kind: 'progress',
        text: backfill ? '地图长好了，正在补插件的图层' : progress.regen ? '正在按新地形重新生成' : '正在生成世界',
        // 手机上地图插件那一句放不下种子
        more: [progress.seed !== undefined && !progress.regen && !backfill && !(narrow && progress.stage.startsWith('地图插件')) ? `种子 ${progress.seed}，${progress.stage}` : progress.stage],
        progress: progress.pct,
      });
    else clearToast('progress');
  }, [progress, finderOn, narrow, mapEarly]);
  // 回放世界形成:后台算各个年代的地形那一两秒(算好以后是地图上的字幕)
  const replayWait = replayOn && !replay;
  useEffect(() => {
    if (replayWait) showToast({ id: 'replay', kind: 'progress', text: '正在准备回放' });
    else clearToast('replay');
  }, [replayWait]);
  // 重推历史的进度、选目标的提示在 TargetPlates.tsx(和名牌、压暗一起)
  const terrainLast = terrainStatus.last;
  useEffect(() => {
    if (!terrainLast) return;
    // 对不上的改名先留着(撤销地形修改就会回来),没生效的干预概览里写了原因
    const lost = [
      terrainLast.lostNames ? `${terrainLast.lostNames} 处改名` : '',
      terrainLast.lostInterventions ? `${terrainLast.lostInterventions} 条干预` : '',
    ].filter(Boolean);
    const more = lost.length ? [`${lost.join('、')}暂未生效`] : undefined;
    const n = regenNote.current;
    regenNote.current = null;
    // 新建界面里助手执行、撤销以后不放提示条(撤销在助手那一行和左边「地形」里)
    if (n && getStage().stage === 'draft') return;
    if (n) {
      showToast({
        id: 'terrain',
        kind: lost.length ? 'warn' : 'ok',
        text: n.kind === 'apply' ? '已按你说的改写 · 按新地形重新生成' : '已撤销改写 · 按原来的地形重新生成',
        more,
        action:
          n.kind === 'apply' && n.undo
            ? {
                label: '撤销',
                act: 'rw-undo',
                onClick: () => {
                  n.undo?.();
                  clearToast('terrain');
                },
              }
            : undefined,
      });
      return;
    }
    const tip = holdTip.current;
    holdTip.current = false;
    // 补推历史、起地名已经开始了(还没换上就收起了编辑地形):不再说重新生成好了,看"正在起地名"
    if (naming.current) return;
    showToast({ id: 'terrain', kind: lost.length ? 'warn' : 'ok', text: '已按新地形重新生成', more: tip ? [...(more ?? []), '地名等点「完成」以后再起'] : more });
  }, [terrainLast]);
  // 编辑地形以后补推历史、起地名:顶上"正在起地名",进度条按上一次推历史用的时间估;起好收起
  const namingOn = namingPct !== null;
  useEffect(() => {
    if (!namingOn) return;
    const cells = genParams.current?.cells ?? 36000;
    const est = Math.max(200, civMsLast.current ?? 500 * Math.pow(Math.max(1, cells / 36000), 0.6));
    const t = setInterval(() => {
      const n = naming.current;
      if (n) setNamingPct(Math.min(0.95, (performance.now() - n.t0) / (est * 1.15)));
    }, 100);
    return () => clearInterval(t);
  }, [namingOn]);
  useEffect(() => {
    if (namingPct === null) return clearToast('names');
    clearToast('terrain');
    showToast({ id: 'names', kind: 'progress', text: '正在起地名', more: ['按新地形起山河湖海的名字'], progress: namingPct });
  }, [namingPct]);
  // 地名刚起好:地图上的字淡入(见 app.css 的 .screen-layer.names-in;星球上的等卷成星球、停稳才排,多留一会儿),淡完摘掉
  useEffect(() => {
    if (!namesIn) return;
    return cancelTimeout(setTimeout(() => setNamesIn(0), 1200));
  }, [namesIn]);

  // 推演出来没有文明(宜居的陆地太少):建好的世界说一句(新建时卡片上写,可以换一颗)
  const noCiv = !!rawCiv && !rawCiv.viable;
  const noCivToast = noCiv && stage === 'world';
  useEffect(() => {
    if (!noCivToast) return clearToast('world');
    showToast({ id: 'world', kind: 'warn', text: '这个世界没有文明', more: ['宜居的陆地太少'] });
  }, [noCivToast]);

  /** 正在重推 / 按新地形重新生成 / 生成新世界:助手这时发不了话、确认单也不能执行 */
  const worldBusy = !!resim || terrainStatus.busy || !!progress || namingPct !== null;
  // 助手:换了世界、世界建好了,对话跟着换;离开建好的世界(回我的世界、新建)不再看试推演。
  // 打开另一个参数、地形、名字都一样的存档时历史原样复用,所以还要跟着世界的 id(存档一变 App 就重新渲染)
  const worldId = currentWorld()?.id ?? null;
  useEffect(() => syncAssistantWorld(draft ? 'history' : 'terrain'), [rawCiv, draft, data, worldId]);
  useEffect(() => {
    if (stage !== 'world') exitPreview();
  }, [stage]);
  // 在地图上看试推演:面板里是试推演的历史,只许改两份历史里是同一个的国家、城(改名、下令用它的键)
  useEffect(() => {
    const real = rawCiv;
    const sim = previewRaw;
    if (!real || !sim) return;
    setEditGate((keys) => (keys.every((k) => sameInBoth(real, sim, k)) ? null : PREVIEW_EDIT_BLOCK));
    return () => setEditGate(null);
  }, [rawCiv, previewRaw]);
  // 逐年推演切支线的时候:面板里还是原来那支的历史,先不许下令、改名(逐年推演里不试推演,和上面那个不会同时挂着)
  useEffect(() => {
    let on = false;
    const sync = () => {
      const want = !!getStepwise().switching;
      if (want === on) return;
      on = want;
      setEditGate(want ? () => SWITCH_EDIT_BLOCK : null);
    };
    sync();
    const off = subscribeStepwise(sync);
    return () => {
      off();
      if (on) setEditGate(null);
    };
  }, []);
  // 在地图上看试推演 / 回到现在:选中的东西按稳定键换到另一份历史里;刚开始看时没选东西,选上关注的那个国家
  const prevPreview = useRef<Civ | null>(null);
  useLayoutEffect(() => {
    const was = prevPreview.current;
    prevPreview.current = previewRaw;
    const real = rawRef.current;
    const from = was ?? real;
    const to = previewRaw ?? real;
    if (was === previewRaw || !from || !to || from === to) return;
    remapSelection(from, to);
    if (!previewRaw || was || getSelection().sel || !real) return;
    const p = getAssistant().preview;
    const v = p ? getAssistant().turns.find((t) => t.id === p.turn)?.proposal?.trial : undefined;
    const id = v && v.focus > 0 ? v.rows[0].id : -1;
    if (id < 0 || !real.polities[id]) return;
    const r = resolveKey(previewRaw, polityKey(real, id));
    if (r && r.kind === 'polity') setSelection({ kind: 'polity', id: r.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewRaw]);
  // 详情面板只挂一份:挂进一个自己建的容器,窄屏把容器放在底部卡片的位置,宽屏放进侧栏(放哪儿由那边的空位 ref 决定)。
  // 窗口跨过窄屏断点(比如手机横过来)时面板不重新挂,正在干预的那几步、填了一半的年份和名字都留着
  const inspectorHost = useMemo(() => {
    const el = document.createElement('div');
    el.className = 'inspector-host';
    return el;
  }, []);
  const inspectorSlot = useCallback(
    (slot: HTMLElement | null) => {
      if (slot && inspectorHost.parentNode !== slot) slot.appendChild(inspectorHost);
    },
    [inspectorHost],
  );
  /** 建好的世界(不是新建中、不在我的世界):时间轴、详情、概览、事件标签这些才有 */
  const world = stage === 'world';
  const filmOn = !!filmUi.mode && !!data && world && !draft && !home;
  // 地区(地区图、立体):建好的世界上能用(回放世界形成、导出视频 / 长图时不能);不能用了就收起
  const relief = useRelief();
  const reliefable = !!data && world && !replayOn && !filmOn;
  const reliefView = reliefable && relief.phase === 'view';
  /** 插件的工具:建好的世界上能用(回放世界形成、导出视频 / 长图、地区图里不能);不能用了插件停下 */
  const toolable = pluginsUiOn() && !!data && world && !home && !draft && !replayOn && !filmOn && !reliefView;
  const plgLegend = usePluginLegendOn() && !draft && !home;
  useEffect(() => {
    if (!reliefable) closeRelief();
  }, [reliefable, relief.phase]);
  // 网址里带着地区模式(area=…:分享链接、刷新):这次打开网页第一次显示世界、历史推完(带着"这一刻"的先停到那一年)以后进那一块的那一面;
  // 那包代码打开网页时就先下载起来(生成世界的同时),慢网上也不多等
  const areaTried = useRef(false);
  useEffect(() => {
    if (urlHasArea()) void import('./terrain3d/relief3d');
  }, []);
  useEffect(() => {
    if (areaTried.current || !reliefable || !data || !rawCiv || !box.w || resimInfo.current || pendingMoment.current) return;
    areaTried.current = true;
    openAreaLink(data.world.height);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reliefable, rawCiv, box.w, stageSize.w, resim, momentTick]);
  /** 导播停用:还没有历史、新建、回放世界形成、导出视频 / 长图时(这时时间轴照平常放) */
  const directorOff = !markable || filmOn || !civ?.viable || !civ.cultures.length;
  // 接着回放世界形成放文明时导播不管(事件小卡照旧)
  const directing = directorOnPref && !directorOff && !civStory;
  // 逐年推演(Stepwise.tsx):打开的世界在逐年推演(修改里有进度)。导播换成逐年推演那一份开关(默认开);
  // 时间轴只放这一段,时间轴上面换成单子 / 这一段的大事;停一下时手机上拉起卡片
  const stepWorld = world && !draft && !!cleanPlay(edits.play);
  const stepWas = useRef(stepWorld);
  /** 按在地图上的手指 / 鼠标(都松开了逐年推演接着走;松开的地方不一定在地图上,在整个页面上听) */
  const stepPointers = useRef(new Set<number>());
  useEffect(() => {
    const up = (e: PointerEvent) => {
      stepPointers.current.delete(e.pointerId);
      if (!stepPointers.current.size) setStepGesture(false);
    };
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  }, []);
  useEffect(() => {
    setDirectorMode(stepWorld);
    if (!stepWorld) leaveStepwise();
    // 进出逐年推演(开始演绎、存回推演模式打开了那一个):干预页、选目标是另一种样子,选中的东西收起
    if (stepWas.current !== stepWorld) {
      setPolityPick(null);
      clearSelection();
    }
    stepWas.current = stepWorld;
  }, [stepWorld]);
  const stepOn = useStepwiseOn() && stepWorld;
  const stepStopped = useStepwiseStopped() && stepOn;
  // 停一下的卡片、编号点:停着、没在往回看 / 重放(手机上卡片没收起);往回看、刚重新演绎停着时时间轴上面那一条占着字幕条的地方
  const stepCard = useStepCard() && stepOn;
  const stepStrip = useStepStrip() && stepOn;
  const stepReplay = useStepReplay();
  const stepQuiet = (stepStopped && !stepReplay) || stepStrip;
  /** 时间轴上有「再推」:推演模式里有文明时(逐年推演、导出视频、回放世界形成、新建时没有;藏起来时弹层跟着收起) */
  const extendShown = !!(data && world && !draft && !home && !stepOn && !replayOn && !filmOn && !previewRaw && civ?.viable && civ.cultures.length);
  useEffect(() => {
    if (!extendShown) setExtendOpen(false);
  }, [extendShown]);
  const curWorld = currentWorld();
  // 离开这个世界(回首页、去新建、浏览器前进后退换了一个世界),或者助手"先看看"的历史进来、退出(预览条上的"回到现在"):
  // 导出面板关掉,正在导出的视频取消(不然会接着拍已经不在屏幕上的那一份历史)
  const filmWorld = world && !draft && !home ? (curWorld?.id ?? '') : null;
  useEffect(() => {
    if (getFilm().mode) closeFilm();
  }, [filmWorld, previewRaw]);
  const shareReport = useShareReportEntry();
  /** 打开别人分享的世界、还没改过:地图下那条说明代替第一次打开的操作提示 */
  const sharedOn = world && !!data && !!sharedFor && curWorld?.id === sharedFor.id && curWorld.kind === 'visit' && !terrainTool.on;
  /** 从作品墙打开的世界作品:地图左上那一条(改了自动另存以后也还在;回作品墙、换了世界就不放),侧栏左上的返回换成「‹ 作品墙」 */
  const workOn = world && !draft && !!workFor && curWorld?.id === workFor.id && !filmOn;
  const workBar = workOn && workFor && <WorkBar phone={narrow} work={workFor.work} onSaveCopy={keepWork} onNewCiv={() => newCivOnWork(workFor.work)} />;
  // 停在那一刻的说法:"第 1500 年，有桑皇朝"(国名、州名按那一年的;设了纪年的按纪年)
  const sharedAt = (() => {
    const a = sharedFor?.at;
    if (!a || !civ) return null;
    const sel = a.sel;
    const p = sel?.kind === 'polity' ? civ.polities[sel.id] : null;
    const name = p ? polityName(p, shownYearOf(p, a.year, civ.endYear)) : sel?.kind === 'region' && sel.id < civ.regions.count ? regionLabel(civ, sel.id) : null;
    return `${yearFull(a.year, edits.era)}${name ? `，${name}` : ''}`;
  })();
  /** 「从头放」:不停在这一刻了,和不带这一刻的链接打开时一样 —— 不选中、地图回到整张,从结束前一段起自动播放 */
  const replayShared = () => {
    setSharedFor((s) => (s ? { ...s, at: null } : s));
    clearSelection();
    if (getGlobeOn()) globeApi.current?.reset();
    else flyRef.current('home');
    if (civ) startAutoplay(replayStart(civ.endYear));
  };
  const layerProps = {
    base: mapBase,
    fill: mapFill,
    sat: satLook,
    civ,
    onBase: pickBase,
    onFill: (fill: FillId) => applyMapView({ fill }),
    onSat: (sat: SatLook) => pickBase('satellite', sat),
    pending: pendingBase,
    thumbs,
    requestThumbs,
    disabled: !data,
  };
  /** 新建界面确认创建:建好了就让平常的地图从星球展开时正中的经线接着看(放回 1 倍) */
  const studioCreate = (title: string, lon: number, how?: 'step' | 'outline'): boolean => {
    // 先立刻标上"新建界面正在退场"再清掉草稿:不然新建界面会被拆掉又重装一次,重装时照手绘图的笔又被打开
    flushSync(() => setStudioOut(1));
    const f = foundNow;
    if (!createWorld(title, how, how === 'step' ? undefined : f?.year)) {
      setStudioOut(0);
      return false;
    }
    if (f && how !== 'step') foundCreated(f);
    // 选了「演绎」:不停在开场那年、不加标记,大纲照样搬过去
    else if (f && how === 'step') moveFoundOutline(f);
    stopFly();
    publishMapCenter(wrapLon(lon));
    const el = stageRef.current;
    const g = geo.current;
    if (getProjection() === 'equirect' && el && g.bw && g.wrap) {
      const b = { sw: el.clientWidth, sh: el.clientHeight, bw: g.bw, bh: g.bh, padB: g.padB };
      const v0 = viewCentredAt({ k: 1, x: 0, y: 0 }, b, g.wrap, xOfLon(lon, g.wrap));
      const v = { ...v0, x: Math.round(v0.x) };
      viewRef.current = v;
      setView(v);
    }
    return true;
  };
  // 新建界面的「实景」是卫星(用记着的画法)
  const satThumb = baseThumb('satellite', satLook);
  const studioThumbs = { ...thumbs, realistic: thumbs[satThumb] };
  const studioRequest = (ids: MapLayer[]) => requestThumbs(ids.map((id): ThumbId => (id === 'realistic' ? satThumb : id)));
  const studioBase = (key: string) => baseCanvas(key === 'realistic' ? baseKeyOf('realistic', layer, satLook) : key);
  // 在一张地图上打造文明:用的是哪个世界的地图(它的名字;只存了地图的、那个世界已经删掉了 = null)
  // (看要打开的那一个:还在生成时套着的修改还是上一个世界的)
  const draftMap = draft ? targetRef.current?.edits.map : undefined;
  const draftMapFrom = useMemo(() => {
    if (!draftMap) return undefined;
    const w = draftMap.from ? loadWorld(draftMap.from) : null;
    const t = targetRef.current!;
    return { title: (w && !w.map && w.save.title) || null, brief: `种子 ${t.params.seed}，${mapBriefOf(t.params, t.edits)}` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftMap, v]);
  const studio = ((draft && !finderOn) || studioOut > 0) && (
    <Studio
      onFinder={() => openFinderPage()}
      found={foundNow}
      onFoundBack={() => openFinderPage(true)}
      phone={narrow}
      mode={draftModeOf(targetRef.current)}
      params={params}
      title={draftTitle}
      base={stageBase}
      back={draftBack}
      onSeed={draftSeed}
      onRandomSeed={() => draftSeed(randomSeedValue())}
      onParams={draftParams}
      onMaps={draftMaps}
      onTitle={draftRename}
      onCreate={studioCreate}
      onSaveMap={saveMap}
      mapFrom={draftMapFrom}
      // 以它为底稿新建、调过参数:带过来的干预要等重推完(不然创建时截的缩略图、放的历史是没干预的)
      busy={!!progress || !!resim}
      naming={namingPct !== null}
      later={namesHeld || namingPct !== null}
      namesIn={!!namesIn}
      onLeaveTerrain={releaseNames}
      ready={!!data && !progress}
      mapReady={!!data && (!progress || mapEarly)}
      noCiv={noCiv}
      data={data}
      baseWorld={baseData?.world ?? null}
      civ={realCiv}
      raw={rawCiv}
      worldBusy={worldBusy}
      layer={mapLayer}
      onLayer={applyLayer}
      baseCanvas={studioBase}
      thumbs={studioThumbs}
      requestThumbs={studioRequest}
      onFade={() => setStudioOut(2)}
      onGone={() => setStudioOut(0)}
    />
  );
  // 摊平改地形时舞台摆在新建界面中间那块
  const fr = studioOn ? studioFlat?.rect : undefined;
  // 经纬网的度数写在哪(地球仪、回放、导出预览、首页时不写;新建世界只在摊平改地形时写)
  const gratSpec: GratSpec | null = (() => {
    if (!graticule || globeOn || home || filmOn || (replayOn && replay)) return null;
    const fs = narrow ? 10 : 11;
    if (fr) {
      if (curved) return null;
      // 框外的字不出窗口
      const outX: [number, number] = [-fr.x, window.innerWidth - fr.x];
      if (narrow) return { fs, outX, lon: [{ side: 'bottom', out: true }], lat: [{ side: 'left', out: false }] };
      // 照手绘图新建:框上边紧挨切换条,经度只写下边
      const top = draftModeOf(targetRef.current) === 'image' ? [] : [{ side: 'top' as const, out: true }];
      return { fs, outX, lon: [...top, { side: 'bottom', out: true }], lat: [{ side: 'left', out: true }, { side: 'right', out: true }] };
    }
    if (studioOn) return null;
    const [, top, right, bottom] = freeArea(sb, panelOpen);
    // 电脑:纬度贴着侧栏卡片右边写(卡片收起了贴着屏幕左边),经度让开右下角那一列按钮
    const left = narrow ? 0 : Math.max(0, sideRoom(sb.sw) - 14);
    return { fs, area: [left, top, right, bottom], lonInRight: narrow ? undefined : right - 96, lon: [{ side: 'bottom', out: false }], lat: [{ side: 'left', out: false }] };
  })();
  const stagePos: CSSProperties | undefined = fr && { left: fr.x, top: fr.y, width: fr.w, height: fr.h, right: 'auto', bottom: 'auto' };
  // 两层放大的地图框共用一个变换、按视窗裁;两层屏幕层按同一个视窗裁(见下面的 JSX)
  const wrapStyle: CSSProperties = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})`, clipPath: wrapClip(view, sb, wrapW), display: globeOn && globeShown ? 'none' : undefined };
  const screenStyle: CSSProperties = { clipPath: screenClip(view, sb, wrapW), display: globeOn && globeShown ? 'none' : undefined };
  // 装着地图各层的容器:换了世界、历史就换个记号,免得容器记着的旧 props 拉住旧世界(见 holdMark.ts)
  const hold = holdMark(data, civ, shownRaw);
  return (
    <div
      className={`app${narrow ? ' phone' : ' has-side'}${chron.open ? ' chron-open' : ''}${panelOpen ? ' panel-open' : ''}${narrow && panelOpen && panelUi.sheet === 'full' ? ' sheet-full' : ''}${narrow && !selState.sel && !upOn && !toolCardOn && !filmOn && panelUi.world === 'full' ? ' world-full' : ''}${narrow && panelUi.drag ? ' sheet-drag' : ''}${narrow && selState.sel && !panelOpen ? ' sheet-away' : ''}${!narrow && world && sideUi.collapsed && !sideUi.peek ? ' side-collapsed' : ''}${picking ? ' picking' : ''}${globeOn ? ' globe-on' : ''}${data ? '' : ' booting'}${home ? ' home' : ''}${draft ? ' draft' : ''}${studioOn ? ' studio-on' : ''}${fr ? ' studio-flat' : ''}${astOpen && !narrow && !home && !draft ? ' ast-open' : ''}${preview ? ' ast-preview' : ''}${filmOn ? ' film-on' : ''}${filmOn && filmUi.mode === 'long' ? ' film-long' : ''}${stepOn ? ' step-on' : ''}${stepCard && !selState.sel ? ' step-stop' : ''}${reliefView ? ' relief-on' : ''}${reliefable && relief.phase === 'pick' ? ' relief-pick' : ''}`}
      data-theme={theme}
      data-layer={mapLayer}
      data-base={mapBase}
      data-fill={mapFill}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* 地图铺满全屏(地形画布是页面上第一张 canvas:画面回归检查、截图脚本按它取图) */}
      <main
        ref={stageRef}
        className={`stage${terrainTool.on ? ' terrain-on' : ''}${upOn ? ' up-on' : ''}`}
        style={stagePos}
        onPointerDown={onPointerDown}
        onPointerDownCapture={(e) => {
          // 导播放着:一按地图(拖、点、捏合;地球仪上也算)镜头就交还,导播停在这件事上等着
          directorHandBack();
          // 逐年推演:按着地图的时候世界先不往下走(手指、鼠标都松开了接着走)。导播开着时上面那句已经停下了,
          // 和推演模式一样等用的人点「回到导播」或播放键
          stepPointers.current.add(e.pointerId);
          setStepGesture(true);
          onTouchDownCapture(e);
          onMarkDownCapture(e);
        }}
        onWheelCapture={() => {
          directorHandBack();
          stepWheel();
        }}
        onPointerMove={onPointerMove}
        onPointerMoveCapture={(e) => {
          mouseAt.current = [e.clientX, e.clientY];
          onTouchMoveCapture(e);
          onMarkMoveCapture(e);
        }}
        onPointerUp={onPointerUp}
        onPointerUpCapture={(e) => {
          onTouchUpCapture(e);
          onMarkUpCapture(e);
        }}
        onPointerCancel={onPointerUp}
        onPointerCancelCapture={(e) => {
          onTouchUpCapture(e);
          onMarkUpCapture(e);
        }}
        onClick={onStageClick}
        onPointerLeave={() => {
          setHover(null);
          setTradeHover(null);
          terrainMove(null);
          upMove(null);
        }}
        onDoubleClick={resetView}
      >
        {/* 地图分四层叠(见 mapWrap.ts 的"屏幕层"):和世界一样大的画布放在被 CSS 放大的地图框里,
            按屏幕像素画的(细节层、视窗装饰、文字层)放在不缩放的屏幕层里 */}
        <div className="canvas-wrap" style={wrapStyle}>
          <div className="map-box" data-wrap={curved ? undefined : '1'} data-proj={projection} style={{ width: box.w, height: box.h }}>
            <canvas ref={canvasRef} />
            {/* 右边接的那一份(左右无限拖动,见 mapWrap.ts;弯边投影时不用) */}
            <canvas ref={canvasCopyRef} className="wrap-copy" />
          </div>
        </div>
        <div className="screen-layer" data-hold={hold} style={screenStyle}>
          {/* 放大后的地形细节(弯边投影:按投影一行一行铺) */}
          {data && <TerrainDetail world={data.world} raster={data.raster} style={style} look={terrainLook} view={view} mp={mp} />}
          {data && contourOn && <ContourLayer world={data.world} raster={data.raster} kind={contourKind!} style={contourStyle} dark={baseDark(mapBase)} view={view} mp={mp} />}
          {data && <MapDecor world={data.world} style={style} ink={contourStyle} view={view} mp={mp} />}
        </div>
        {/* 放大后的文明细节层(CivLayer 放进来):盖住下面的地形,在文明底图那一层地图框之下 */}
        <div className={`screen-layer${namesIn ? ' names-in' : ''}`} ref={setCivDetailHost} style={screenStyle} />
        <div className="canvas-wrap-upper" data-hold={hold} style={wrapStyle}>
          <div className="map-box-upper" data-hold={hold} style={{ width: box.w, height: box.h }}>
            {data && (
              <CivLayer world={data.world} raster={data.raster} civ={namesHeld ? null : civ} geo={namesHeld ? null : shownRaw} style={style} view={view} mp={mp} labelsHost={labelsHost} detailHost={civDetailHost} flags={flagView} bright={mapBase === 'satellite'} />
            )}
            {data && pluginsUiOn() && <PluginCellSlot world={data.world} raster={data.raster} mp={mp} />}
            {data && pluginsUiOn() && <PluginDevMapSlot mp={mp} />}
            <canvas ref={overlayRef} className={`overlay ${replayOn && replay ? 'show' : ''}`} />
            <canvas ref={overlayCopyRef} className={`overlay wrap-copy ${replayOn && replay ? 'show' : ''}`} />
            {/* 照手绘图新建:原图 / 认出来的 / 叠上原图(在改地形覆盖层底下,笔画在它上面) */}
            {data && !curved && draft && <SourceLayer width={data.world.width} height={data.world.height} wrap={wrapW} />}
            {data && !curved && (
              <TerrainOverlay width={data.world.width} height={data.world.height} shown={shownTerrain} shownSketch={shownSketch} wrap={wrapW} scale={(box.w / data.world.width) * view.k} />
            )}
          </div>
        </div>
        {/* 文字层(CivLayer 放进来);回放世界形成时、认图时、照手绘图新建看原图或认出来的时藏起来(回放画面盖住文明层,字也不露出来;认图时只看图) */}
        <div className={`screen-layer${namesIn ? ' names-in' : ''}`} ref={setLabelsHost} style={(replayOn && replay) || devMapOn || importing || (draft && sourceView.show !== 'grown') ? { ...screenStyle, display: 'none' } : screenStyle} />
        {/* 地形大事:涂的地方、会变的地块、会没了的城盖在地名上面(和地图一起缩放) */}
        {data && !curved && upOn && (
          <div className="canvas-wrap-upper" data-hold={hold} style={wrapStyle}>
            <div className="map-box-upper" data-hold={hold} style={{ width: box.w, height: box.h }}>
              <UpheavalOverlay civ={civ} world={data.world} wrap={wrapW} scale={(box.w / data.world.width) * view.k} />
            </div>
          </div>
        )}
        {/* 地图上钉在事发地的事件标签;导播开着时播放经过的大事换成导播的圆环 + 名牌(Director.tsx),点编年史跳过去的照旧 */}
        {data && world && <EventPins civ={civ} world={data.world} toClient={globeOn ? globeToClient : worldToClient} hidden={replayOn || filmOn} quiet={directing} />}
        {/* 照故事找世界:选中的那个世界上故事里各国、隘口、交界的小牌子 */}
        {finderOn && <FinderPins ui={finder} phone={narrow} preview={finderPreviewData} toClient={globeOn ? globeToClient : worldToClient} />}
        {data && world && <DirectorPin toClient={globeOn ? globeToClient : worldToClient} hidden={directorOff || stepQuiet} />}
        {/* 逐年推演停一下:地图上按先后标出这一段的大事 */}
        {data && world && stepCard && <StepPins toClient={globeOn ? globeToClient : worldToClient} phone={narrow} />}
        {data && globeOn && (
          <Globe
            world={data.world}
            raster={data.raster}
            civ={civ}
            geo={shownRaw}
            style={style}
            layer={layer}
            look={terrainLook}
            terrain={canvasRef.current}
            terrainKey={terrainKey}
            replay={globeReplay}
            startLon={getMapCenter()}
            apiRef={globeApi}
            onHover={onGlobeHover}
            onOpened={() => setGlobeShown(true)}
            leftRoom={sideRoom(stageSize.w)}
            rightRoom={astOpen ? astRoom(stageSize.w) : 0}
          />
        )}
        {/* 插件交来的标注(路线、框、点;地球仪上也画):在作者标记下面 */}
        {data && world && pluginsUiOn() && <PluginMarksSlot world={data.world} api={markApi} />}
        {/* 作者标记(图钉、圈的州;地球仪上也画):在地名、地球仪上面 */}
        {data && world && <MarkLayer civ={civ} world={data.world} api={markApi} hidden={replayOn || draft || home} style={style} />}
        {/* 作者的人物一生的足迹(选中一个人物时;地球仪上也画):在标记上面 */}
        {data && world && <CharacterLayer civ={civ} world={data.world} raster={data.raster} api={markApi} hidden={replayOn || draft || home} />}
        {/* 地区:在地图上框一块;回到地图时刚才的框淡淡留一会儿 */}
        {data && reliefable && relief.phase === 'pick' && (
          <Suspense fallback={null}>
            <ReliefPick world={data.world} raster={data.raster} api={markApi} phone={narrow} />
          </Suspense>
        )}
        {data && reliefable && relief.phase === 'off' && relief.ghost && (
          <Suspense fallback={null}>
            <ReliefGhost api={markApi} />
          </Suspense>
        )}
      </main>
      {/* 地区模式:框好的一块画成地区图 / 立起来(盖住地图那一块;手机占满整屏) */}
      {data && reliefView && (
        <Suspense fallback={null}>
          <AreaView world={data.world} raster={data.raster} civ={civ} style={style} look={terrainLook} layer={layer} phone={narrow} />
        </Suspense>
      )}
      {/* 经纬网的度数:新建世界摊平改地形时写在框外,平常的世界页写在地图里贴着左边、下边(GratLabels.tsx) */}
      {data && gratSpec && (
        <GratLabels W={data.world.width} H={data.world.height} view={view} sb={sb} mp={mp} step={graticule} spec={gratSpec} ink={contourStyle} pos={fr} />
      )}
      {/* 导出回放视频:地图压暗、中间的预览,或者地图上的框(FilmStage.tsx) */}
      {filmOn && filmUi.mode === 'video' && <FilmStage phone={narrow} style={style} layer={layer} look={terrainLook} />}
      {/* 故事长图:地图压暗、中间的长图预览和右边一条全貌(手机整屏是预览;LongStage.tsx) */}
      {filmOn && filmUi.mode === 'long' && <LongStage phone={narrow} style={style} layer={layer} look={terrainLook} />}
      {/* 选干预目标 / 推演中:压暗地图、浮出名牌;选中国家:国都的圆环(TargetPlates.tsx) */}
      {data && world && <TargetLayer civ={civ} world={data.world} toClient={globeOn ? globeToClient : worldToClient} resim={resim} generating={!!progress} labelAt={labelAt} />}
      {/* 下令大迁徙、指定一州时:预估的虚线和目的地(TrekPlanLayer.tsx) */}
      {data && world && <TrekPlanLayer civ={civ} world={data.world} toClient={globeOn ? globeToClient : worldToClient} style={style} />}

      {replayOn && replay && !home && (
        <div className="caption">
          <div className="big">{replay.idx === replay.frames.length - 1 ? '今天' : `约 ${replay.mya[replay.idx]} 百万年前`}</div>
          <div className="small">板块碰撞抬起山脉,河流一点点把它切开</div>
          <div className="track">
            <div style={{ width: `${((replay.idx + 1) / replay.frames.length) * 100}%` }} />
          </div>
        </div>
      )}

      {home ? (
        /* 我的世界:盖住整个页面(地图留在底下,回到刚才的世界不用重新生成) */
        landing ? (
          <ShareGone
            phone={narrow}
            state={landing}
            onHome={() => {
              setLanding(null);
              goHome();
            }}
            onNew={() => {
              setLanding(null);
              startDraft();
            }}
          />
        ) : wall?.kind === 'list' ? (
          <GalleryPage
            phone={narrow}
            onHome={goHome}
            onOpen={(w) => openWork(w.id)}
            onPreset={takePresetWork}
            shown={wall.shown}
            onShown={(id) => {
              // 开着的新建参数 / 规则作品写进网址(刷新、复制网址还是它);不算一步
              navReplace({ page: 'gallery', ...(id ? { id } : {}) });
              writeGalleryUrl(id ?? '');
            }}
          />
        ) : wall?.kind === 'map' ? (
          <MapWorkView phone={narrow} work={wall.work} onBack={showGallery} onNewCiv={() => newCivOnWork(wall.work)} />
        ) : wall?.kind === 'work' ? (
          <WorkGone phone={narrow} state={wall.state} onHome={goHome} onGallery={showGallery} onRetry={() => openWork(wall.id)} />
        ) : (
          <MyWorlds phone={narrow} onOpen={openStored} onNew={startDraft} onOpenText={openText} onNewCiv={startNewCiv} onGallery={showGallery} onOpenWork={(w) => openWork(w.id)} />
        )
      ) : narrow ? (
        <>
          {/* 手机:底部的世界卡片(没选东西时;选中了东西换成详情卡片)、右上竖排的毛玻璃按钮(图层、地球);数据图层的图例、旧网站的「旧版」(测试网站的「测试版」)标记在左上。
              界面都在卡片和毛玻璃按钮上,地图上不再压字、不用渐变遮罩;最近大事在世界卡片拉到顶时的列表里。
              新建时这些都不放(新建界面自己一套) */}
          {filmOn ? (
            filmUi.mode === 'long' ? <LongPanel phone style={style} baseName={baseName(mapBase, satLook)} /> : <FilmPanel phone style={style} layer={layer} look={terrainLook} />
          ) : !draft && !selState.sel && !upOn && !toolCardOn && (
              <PhoneSheet
                data={data}
                civ={civ}
                raw={shownRaw}
                params={params}
                generating={!!progress}
                replay={{ on: replayOn, ready: !!replay }}
                onReplay={startReplay}
                onHome={workOn ? showGallery : goHome}
                homeLabel={workOn ? '作品墙' : undefined}
                exp={{ data, civ, plain: plainCiv, style, layer, look: terrainLook }}
              />
          )}
          {!draft && !filmOn && <PhoneButtons layers={layerProps} globeOn={globeOn} onToggleGlobe={toggleGlobe} marking={markable ? markPlacing : undefined} director={!directorOff} relief={reliefable ? relief.phase === 'pick' : undefined} tools={toolable} />}
          {!draft && (OLD_SITE !== null || BETA_SITE || style === 'data' || atlasOn || contourOn || workOn || ideoLegend || plgLegend) && (
            <div className="corner-tl">
              {workBar}
              <OldSiteBadge />
              {(style === 'data' || atlasOn || contourOn) && <Legend layer={style === 'data' ? layer : atlasOn ? 'atlas' : null} contours={contourOn ? contourKind : null} ink={contourInkNow} zoom={view.k} phone />}
              {plgLegend && <PluginLegendSlot phone />}
              {ideoLegend && <ThoughtLegend civ={civ!} phone />}
            </div>
          )}
        </>
      ) : (
        <>
          {/* 宽屏:左边侧栏(世界 / 选中的东西的详情、搜索、存档);右上图层、导出、编年史;数据图层的图例、旧网站的「旧版」(测试网站的「测试版」)标记在地图左上。新建时都不放(新建界面自己一套) */}
          {filmOn ? (
            filmUi.mode === 'long' ? <LongPanel phone={false} style={style} baseName={baseName(mapBase, satLook)} /> : <FilmPanel phone={false} style={style} layer={layer} look={terrainLook} />
          ) : !draft && (
            <Sidebar
              data={data}
              civ={civ}
              raw={shownRaw}
              params={params}
              generating={!!progress}
              replay={{ on: replayOn, ready: !!replay }}
              onReplay={startReplay}
              onHome={workOn ? showGallery : goHome}
              homeLabel={workOn ? '作品墙' : undefined}
              inspectorSlot={inspectorSlot}
            />
          )}
          {!draft && <MapBar civ={civ} layers={layerProps} exp={{ data, civ, plain: plainCiv, style, layer, look: terrainLook }} />}
          {!draft && (OLD_SITE !== null || BETA_SITE || workOn || relBack || ((style === 'data' || atlasOn || contourOn || ideoLegend || plgLegend) && !terrainTool.on)) && (
            <div className="corner-tl">
              {relBack && civ && <RelationBack civ={civ} />}
              {workBar}
              <OldSiteBadge />
              {(style === 'data' || atlasOn || contourOn) && !terrainTool.on && <Legend layer={style === 'data' ? layer : atlasOn ? 'atlas' : null} contours={contourOn ? contourKind : null} ink={contourInkNow} zoom={view.k} />}
              {plgLegend && !terrainTool.on && <PluginLegendSlot phone={false} />}
              {ideoLegend && !terrainTool.on && <ThoughtLegend civ={civ!} />}
            </div>
          )}
        </>
      )}
      {/* 新建世界:和平常页面分开的一套深色界面,盖在地图上面(创建以后展开成平常的地图、淡出) */}
      {studio}
      {/* 照故事找世界:新建界面收起,左边找世界的卡片(手机:整页 / 底部卡片),地图上顶上一条、条件页淡着 */}
      {finderOn && (
        <>
          <FinderOverlay ui={finder} phone={narrow} preview={finderPreviewData} loading={!!progress} onUse={takeFinderPick} />
          <FinderPage
            phone={narrow}
            seed={finderBack.current?.target.params.seed ?? params.seed}
            preview={finderPreviewData}
            onExit={exitFinder}
            back={outlineSrc ? '大纲' : undefined}
            onUse={takeFinderPick}
            onFly={finderFly}
          />
        </>
      )}
      {/* 助手面板(宽屏右边一张卡片,手机是拉到顶的底部卡片;窗口跨过窄屏断点时不重新挂,没发出去的话留着)、在地图上看试推演时的提示条 */}
      {astOpen && aiOn && !home && !studioOn && data && realCiv && rawCiv && (
        <AssistantPanel phone={narrow} world={data.world} raster={data.raster} civ={realCiv} raw={rawCiv} lock={draft ? 'history' : 'terrain'} busy={worldBusy} />
      )}
      {world && <PreviewBanner busy={worldBusy} phone={narrow} />}
      {/* 顶部居中:提示条(同一时间只有一条) */}
      <ToastBar />
      {/* 「照大纲推演」先问多认真地试 */}
      <OutlineRunAsk />
      {/* 逐年推演里演一国:顶上常驻的方针条(提示条出来时让开) */}
      {data && world && civ && <RoleBar civ={civ} phone={narrow} />}
      {/* 右下(时间轴上方):地球 / 平面、放大、缩小。触屏不放 + −(用双指捏合);窄屏整个不放(地球在右上竖排的按钮里) */}
      <MapControls
        globeOn={globeOn}
        onToggleGlobe={toggleGlobe}
        onZoom={zoomButton}
        shifted={false}
        hidden={!data || narrow || home || draft || reliefView}
        zoom={!coarse}
        marking={markable ? markPlacing : undefined}
        director={!directorOff}
        relief={reliefable ? relief.phase === 'pick' : undefined}
        tools={toolable}
      />
      {sharedOn ? (
        <SharedHint phone={narrow} short={sharedFor.short} by={sharedFor.by} own={sharedFor.own} at={sharedAt} report={sharedFor.short ? shareReport : null} onReplay={replayShared} onOk={() => setSharedFor(null)} />
      ) : (
        <FirstHint show={hintOn && !!data && world && !terrainTool.on && !upOn} touch={coarse} />
      )}
      <ShareReportHost phone={narrow} />
      {world && !narrow && <UpheavalHint />}
      {/* 推不下去:地图盖浅白、中间一张卡(盖住上面的操作提示,不盖浮在地图上的按钮和时间轴);新建时只弹后台算不动的那张 */}
      {(world || draft) && <StuckCard civ={world && data ? civ : null} phone={narrow} busy={worldBusy} over={!world} />}
      {/* 底部:时间轴(宽屏是卡片右边那一块底下的胶囊;手机是浮在底部卡片上面的胶囊);新建时还没有历史,不放 */}
      <div className="bottom-row">
        <div className="bottom-tl">
          {data && world && (stepOn ? <StepTimeline civ={civ} phone={narrow} hidden={replayOn} /> : <CivTimeline civ={civ} hidden={replayOn} dock="inline" directorOff={directorOff} extendOff={!extendShown} />)}
        </div>
        {/* 待推演的单子:浮在时间轴上面(逐年推演里换成「下一步生效的干预」、停着的提示、这一段的大事) */}
        {data && world && !stepOn && <PendingTray phone={narrow} hidden={replayOn || draft} />}
        {data && world && stepOn && <StepDock phone={narrow} />}
        {/* 导播的字幕条:浮在时间轴上面 */}
        {data && world && <DirectorCaption phone={narrow} civ={civ} hidden={directorOff || stepQuiet} />}
        {/* 开发者模式载入的插件:左边一块小卡(重新载入、日志) */}
        {pluginsUiOn() && data && world && <PluginDevSlot phone={narrow} world={data.world} root={baseData?.world ?? data.world} civ={realCiv} raw={shownRaw} api={markApi} look={devLook} />}
        {pluginsUiOn() && data && world && <PluginSavedSlot worldId={worldId} cells={data.world.mesh.n} civ={shownRaw} real={previewRaw ? null : rawCiv} mesh={data.world.mesh} />}
        {/* 再推 N 年:电脑是「再推」上面的弹层,手机推的时候胶囊上面一张小卡片 */}
        {data && world && civ && !narrow && <ExtendPop end={civ.endYear} hidden={!extendShown} />}
        {data && world && narrow && <ExtendDock hidden={!extendShown} />}
      </div>
      {/* 导播:推进时间轴(不画东西;逐年推演时由 StepwiseEngine 推)、右上「导播略过的」(手机是拉起的卡片)、手机的导播设置 */}
      {data && world && <DirectorEngine world={data.world} civ={civ} off={directorOff} stepwise={stepWorld} />}
      {data && world && <DirectorPanels phone={narrow} civ={civ} hidden={directorOff} />}
      {data && world && civ && narrow && <ExtendSheet end={civ.endYear} hidden={!extendShown} />}
      {/* 逐年推演:往下走(不画东西)、手机停一下时的卡片、开始之前 / 推进设置 / 存回推演模式的窗口 */}
      {data && world && stepWorld && <StepwiseEngine world={data.world} civ={civ} />}
      {data && world && narrow && stepCard && <StepReviewSheet />}
      {data && world && <StepStartDialog phone={narrow} civ={civ} />}
      {data && world && stepOn && <StepSaveDialog phone={narrow} />}
      {data && world && stepOn && <StepRewindDialog phone={narrow} civ={civ} />}
      {data && world && stepOn && <StepBranchDeleteDialog phone={narrow} civ={civ} />}
      {/* 详情面板:窄屏是从屏幕底升起的卡片(在这儿的空位里),宽屏在侧栏里(见上面的 inspectorHost) */}
      {data && world && createPortal(<Inspector civ={civ} raw={shownRaw} raster={data.raster} world={data.world} />, inspectorHost)}
      {narrow && world && <div className="inspector-slot" ref={inspectorSlot} />}
      {hover && world && <HoverCard info={hover.info} x={hover.x} y={hover.y} place={hover.place} />}
      {/* 世界概览(点左上角的世界名打开):国家 / 编年史 / 我的干预 / 世界设定 */}
      {world && (
        <WorldOverview
          params={params}
          data={data}
          baseWorld={baseData?.world ?? null}
          civ={civ}
          generating={!!progress}
          resimBusy={!!resim}
          replay={{ on: replayOn, ready: !!replay }}
          onReplay={startReplay}
          onDraftFrom={draftFromCurrent}
        />
      )}
      {/* 人物关系图(人物卡「更多 → 关系图」):电脑右边铺开、手机铺满整屏 */}
      {data && world && civ && <RelationGraph civ={civ} world={data.world} raster={data.raster} phone={narrow} />}
      {realCiv && <HistoryBook civ={realCiv} land={data?.world ?? null} raster={data?.raster ?? null} />}
      <RulesHost />
      <AiSettingsHost />
      <AccountHost phone={narrow} />
      {pluginsUiOn() && <PluginsHost phone={narrow} />}
      <SimAskHost phone={narrow} />
      <MapAskHost phone={narrow} />
      {pluginsUiOn() && <PluginAskSlot phone={narrow} />}
      {pluginsUiOn() && data && world && <ToolsHost phone={narrow} world={data.world} root={baseData?.world ?? data.world} civ={civ} raw={shownRaw} api={markApi} stage={stageRef} active={toolable} />}
      <FrozenAsk phone={narrow} />
      <SameWorldHost phone={narrow} />
      <ShortcutsHost />
      <DiagHost />
      <TipLayer />
      {newDlg && home && <NewWorldDialog key={newDlg.stamp ?? 0} phone={narrow} init={newDlg.init} shared={newDlg.shared} rules={newDlg.rules} randomSeed={randomSeedValue} onCancel={cancelDialog} onStart={startFromDialog} />}
      {dropping && (
        <div className="drop-hint">
          <div>{dropping === 'image' ? '松手导入这张图' : '松手打开存档'}</div>
        </div>
      )}
    </div>
  );
}

/**
 * 只露出视窗(外框 ∩ 舞台)里的那一段 —— 主图和右边接的那一份在视窗外的部分裁掉,同一个地方不会出现两次。
 * clip-path 在地图层自己的坐标里(缩放、平移之前)。还没有世界时不裁
 */
function wrapClip(v: { k: number; x: number; y: number }, b: StageBox, wrap: number): string | undefined {
  if (!wrap || !b.sw || !b.bw) return undefined;
  const [wl, wr] = windowSpan(v.k, b);
  const l = (wl - v.x) / v.k;
  const r = b.sw - (wr - v.x) / v.k;
  return `inset(-100000px ${r}px -100000px ${l}px)`;
}

/** 屏幕层(不缩放,铺满舞台)按同一个视窗裁:舞台坐标 */
function screenClip(v: { k: number }, b: StageBox, wrap: number): string | undefined {
  if (!wrap || !b.sw || !b.bw) return undefined;
  const [wl, wr] = windowSpan(v.k, b);
  return `inset(0px ${b.sw - wr}px 0px ${wl}px)`;
}
