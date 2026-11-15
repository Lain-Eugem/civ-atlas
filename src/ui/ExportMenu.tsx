/**
 * 世界概览头部的"导出"菜单(阶段 4):把世界带出这个网页。
 *
 *   地图图片(PNG / JPEG):整张地图(不是当前视口),当前画风、当前时间轴年份的文明层(和屏幕上开着的一样),
 *                  文字按整图排版;1× = 2048×1024,2× = 4096×2048(重新铺两倍像素,文字按两倍密度重画,不是放大);
 *                  JPEG 质量 0.9,文件小好几倍(手绘 2× PNG 约 16 MB → JPEG 约 1.9 MB),方便贴帖子;
 *                  按屏幕上当前的投影和中央经线画(罗宾森、摩尔威德……外框是投影的外轮廓),经纬网开着也带上
 *   高度图(PNG):16 位(游戏引擎)/ 8 位(Azgaar);海平面在哪个灰度写在菜单里,导出后还能下载同名 .txt 说明
 *   编年史:Markdown / 纯文本(按时代分节,大事在前、全部附后)
 *   图例(PNG):国家 / 民族 + 颜色、城镇符号、道路,配地图用
 *   地球仪这一面(PNG,只在地球仪开着时有):现在看到的样子,见 Globe.tsx 的 exportGlobeView
 *   立体这一面(PNG,只在地区模式看着立体时有):现在看到的样子(看得见的那一块,不带按钮),见 terrain3d/View.tsx
 *
 * 重活在后台线程(src/exportWorker.ts,每次导出临时开一个)里做,界面不卡;主线程只画文字(要用页面里加载好的字体)、编码 PNG。
 * 用的是 App 当前显示的 civ(套过改名等修改的那份),不重新生成。
 * 手机布局下选了 4096×2048:清晰度下面多一行橙字,说大图要多占三四百 MB 内存、手机上可能闪退,建议在电脑上导出(照样能导)。
 * 世界里有从 AI 起名里挑的名字时,清晰度下面多一行"AI 起的名字:带上 / 换回原名":换回原名 = 地图、图例、编年史用 App 给的 plain
 * (AI 起的名字换回挑之前的,见 gen/edits.ts 的 namesWithoutAi)。
 * 有作者标记时再多一行"作者标记:带上 / 不带"(默认带上):地图图片、地球仪这一面画上那一年有的标记(都写名字,见 render/marks.ts)。
 * 正选着一个作者的人物时,地图图片、地球仪这一面带上他的足迹(和地图上看到的一样,见 render/trail.ts)。
 * 地区图:点了进「地区」框一块(ui/terrain3d/),框好看那一页时导出。
 * 文件名带世界名(没起名 = 种子)、年份、画风:文明与地图-九州大陆-第3000年-手绘.png、文明与地图-种子7-第3000年-手绘.png(JPEG 是 .jpg)
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { DEFAULT_PARAMS, type World, type WorldParams } from '../gen/world';
import { rasterize, type Raster } from '../gen/raster';
import { olderTerrain } from '../gen/readers/older';
import type { Civ } from '../gen/civ/types';
import { chronicleDocument } from '../gen/civ/story/chronicle';
import { fullChronicle } from '../gen/civ/story/religionText';
import { chronicleInSlices } from './chronicleHandoff';
import { AZGAAR_SEA_GRAY, heightmapNote, type HeightmapBits } from '../gen/heightmap';
import { isGradientLegend } from '../render/dataLegend';
import { LAYERS, type LayerId } from '../render/layers';
import type { CivShow, CivStyle } from '../render/civ/overlay';
import type { ResourceLook } from '../render/civ/resources';
import { IMAGE_FORMATS, drawExportContours, drawExportMarks, drawExportPluginMarks, drawExportTrail, drawLegend, drawMapBase, drawMapLabels, drawMapLegend, mapLegendCanvasBoxes, drawMapOverlay, drawMapTerrain, type ExportScale, type ImageFormat } from '../render/export';
import { canvasMeasure, drawMarks, layoutMarks, markStyle, placedTextBoxes, type MarkItem } from '../render/marks';
import type { CellPaint } from '../render/pluginLayer';
import type { MarkLayer } from '../plugin/check';
import { pluginExport } from './plugins/layerState';
import { drawTrail, layoutTrail, type TrailInput } from '../render/trail';
import { getEdits, useEdits } from './editsStore';
import { northText } from './WorldOverviewGenesis';
import { cleanEndYear } from '../gen/edits';
import { monthNamesInUse, monthsOf, yearFull } from '../gen/era';
import { markItemsAt, plainMarkChars } from './markInfo';
import { ensureFonts, fantasyFontUrl } from '../render/labels/fonts';
import { characterTrail } from './characterInfo';
import { diagDoing, recordWorkerError } from '../diag/watch';
import type { ExportRequest, ExportResponse } from '../exportWorker';
import { getCivShow, getCivTime, getResourceView, getSelection, useCivTime } from './civView';
import { getMapCenter, xOfLon } from './mapWrap';
import { flatProjection, getContourKind, getGraticuleLines, getProjection } from './projection';
import { contoursOf } from './ContourLayer';
import { LOOK_NAMES, MAP_LAYERS } from './mapLayers';
import type { SurfaceLook } from '../render/surface';
import type { ProjectionId } from '../render/projection';
import { wrapOf } from '../render/common';
import { clearToast, showToast } from './toastStore';
import { exportGlobeView, useGlobeOn } from './Globe';
import { noteDismiss } from './dismissClick';
import { fileBaseName, type ContourKind } from '../gen/savefile';
import { currentWorld } from './saveStore';
import { openFilm } from './filmStore';
import { exportReliefView, openReliefPick, useRelief } from './terrain3dStore';
import { useNarrow } from './device';
import { Icon } from './icons';

type Job = 'map' | 'mapjpg' | 'height16' | 'height8' | 'md' | 'txt' | 'legend' | 'globe' | 'relief';


interface Status {
  kind: 'busy' | 'ok' | 'error';
  text: string;
  /** 提示条的第二行小字(尺寸、大小、海平面灰度、出错原因) */
  more?: string;
  /** 高度图的 .txt 说明:导出后点一下再下载(一次点击连下两个文件,浏览器会拦) */
  note?: { name: string; text: string };
  /** 出错时:提示条上的「重试」再导一次这一趟 */
  retry?: () => void;
}

/** 调试 / 冒烟测试用:最近一次导出的结果 */
interface ExportDebug {
  job: Job;
  name: string;
  bytes: number;
  w?: number;
  h?: number;
  ms: number;
  detail?: Record<string, number>;
  seaLevel?: number;
}

function styleName(style: CivStyle, layer: LayerId, look: SurfaceLook): string {
  if (style === 'realistic') return LOOK_NAMES[look];
  if (style === 'fantasy') return '手绘';
  return LAYERS.find((l) => l.id === layer)?.name ?? '数据图层';
}

/** 和默认值不同的世界参数(和推演年数),写进编年史 / 高度图说明(同一种子 + 参数 = 同一个世界) */
function paramsText(p: WorldParams, endYear?: number, civSeed?: number): string | undefined {
  const d = DEFAULT_PARAMS;
  const out: string[] = [];
  if (p.landFraction !== d.landFraction) out.push(`陆地比例 ${Math.round(p.landFraction * 100)}%`);
  if (p.plates !== d.plates) out.push(`板块数量 ${p.plates}`);
  if (p.mountains !== d.mountains) out.push(`造山强度 ${p.mountains.toFixed(2)}×`);
  if (p.continents !== d.continents) out.push(`大陆 ${p.continents} 块`);
  if (p.gather !== d.gather) out.push(`大陆聚拢 ${Math.round(p.gather * 100)}`);
  if (p.rugged !== d.rugged) out.push(`破碎度 ${p.rugged.toFixed(2)}×`);
  if (p.hardness !== d.hardness) out.push(`板块硬度 ${p.hardness.toFixed(2)}×`);
  if (p.north !== d.north) out.push(`南北偏向 ${northText(p.north)}`);
  if (p.temperature !== d.temperature) out.push(`气温 ${p.temperature > 0 ? '+' : ''}${p.temperature}°C`);
  if (p.rainfall !== d.rainfall) out.push(`降水 ${p.rainfall.toFixed(2)}×`);
  if (p.cells !== d.cells) out.push(`精细度 ${Math.round(p.cells / 1000)}k 地块`);
  // 同一张地图上另起的一段历史:写上文明种子,照着能推出同一段历史
  if (civSeed !== undefined && civSeed !== p.seed) out.push(`文明种子 ${civSeed}`);
  const years = cleanEndYear(endYear);
  if (years) out.push(`推演到 ${years} 年`);
  return out.length ? out.join('、') : undefined;
}

function download(blob: Blob, name: string) {
  if (cancelled) return;
  lastResult = { blob, name };
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 开一个导出线程做一件事,做完就关 */
function runWorker(req: ExportRequest): Promise<ExportResponse> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../exportWorker.ts', import.meta.url), { type: 'module' });
    activeWorker = w;
    const idle = diagDoing('导出图片');
    const done = () => {
      idle();
      w.terminate();
      if (activeWorker === w) activeWorker = null;
    };
    w.onmessage = (e: MessageEvent<ExportResponse>) => {
      done();
      resolve(e.data);
    };
    w.onerror = (e) => {
      done();
      recordWorkerError(e, '导出图片的线程');
      reject(new Error(e.message || '后台线程出错'));
    };
    w.onmessageerror = () => {
      done();
      reject(new Error('后台线程传回的数据读不了'));
    };
    w.postMessage(req);
  });
}

function toBlob(cv: HTMLCanvasElement, format: ImageFormat = 'png'): Promise<Blob> {
  const f = IMAGE_FORMATS[format];
  return new Promise((resolve, reject) =>
    cv.toBlob((b) => (b ? resolve(b) : reject(new Error('图片太大,浏览器编码不了'))), f.mime, f.quality),
  );
}

/**
 * 导出的进度和结果放在这里,不放在菜单组件里:窗口跨过窄屏 / 宽屏时换成另一处的菜单(右上角工具条 ↔ 世界概览),
 * 正在导出的进度、做完的提示、"正在导出时不能再点"都接得上。进度、结果显示在顶部的提示条上(菜单收起了也看得到)
 */
let status: Status | null = null;
const statusSubs = new Set<() => void>();
let okTimer: ReturnType<typeof setTimeout> | undefined;
/** 这一趟被取消了:迟到的成功 / 失败提示都别再弹,文件也别下 */
let cancelled = false;
/** 这趟开的后台线程(取消时直接关掉) */
let activeWorker: Worker | null = null;
/** 最近一次导出的文件:提示条上的「再次下载」用 */
let lastResult: { blob: Blob; name: string } | null = null;

/** 「取消」:关掉线程、收起提示,这一趟的结果就不算了 */
function cancelExport() {
  cancelled = true;
  activeWorker?.terminate();
  activeWorker = null;
  setStatus(null);
}

function setStatus(next: Status | null) {
  // 取消以后这一趟迟到的结果(成功 / 失败)都别再弹,也别盖住收起后的提示条
  if (cancelled && next) return;
  status = next;
  clearTimeout(okTimer);
  // 成功的提示过一会儿自己消失(带"下载说明"的留着,等用户点)
  if (next?.kind === 'ok' && !next.note) okTimer = setTimeout(() => setStatus(null), 7000);
  if (!next) clearToast('export');
  else {
    // 进度条给「取消」、出错给「重试」、做完给「再次下载」;高度图还有「下载说明」
    const acts: { label: string; act?: string; onClick: () => void }[] = [];
    if (next.kind === 'busy') acts.push({ label: '取消', act: 'export-cancel', onClick: cancelExport });
    else if (next.kind === 'error' && next.retry) acts.push({ label: '重试', act: 'export-retry', onClick: next.retry });
    else if (next.kind === 'ok' && lastResult) {
      acts.push({ label: '再次下载', act: 'export-again', onClick: () => lastResult && download(lastResult.blob, lastResult.name) });
    }
    const note = next.note;
    if (note) acts.push({ label: '下载说明', act: 'export-note', onClick: () => download(new Blob([note.text], { type: 'text/plain;charset=utf-8' }), note.name) });
    showToast({
      id: 'export',
      kind: next.kind === 'busy' ? 'progress' : next.kind,
      text: next.text,
      more: next.more ? [next.more] : undefined,
      actions: acts.length ? acts : undefined,
      ttl: next.kind === 'ok' && !note ? 7000 : 0,
      dismissible: next.kind !== 'busy',
    });
  }
  for (const f of statusSubs) f();
}

function subscribeStatus(f: () => void) {
  statusSubs.add(f);
  return () => statusSubs.delete(f);
}

const useExportStatus = () => useSyncExternalStore(subscribeStatus, () => status);

/** 让"正在导出…"先显示出来,再开始干活 */
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

/** 错误说明翻成中文;内存不够的提示换 1× */
function explain(e: unknown, scale: ExportScale): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/memory|allocation|too large|太大|内存/i.test(msg)) return scale === 2 ? `${msg};换 1× 试试` : msg;
  return /[一-鿿]/.test(msg) ? msg : `出错了(${msg})`;
}

interface MapInput {
  world: World;
  raster: Raster;
  civ: Civ | null;
  style: CivStyle;
  layer: LayerId;
  look: SurfaceLook;
  year: number;
  show: CivShow;
  /** 球面世界:图片正中的世界 x(= 屏幕上当前视图的中心) */
  center?: number;
  /** 投影、经纬网(和屏幕上一样) */
  projection?: ProjectionId;
  /** 经纬网每隔几度一条(0 = 不画) */
  graticule?: number;
  /** 等值线(和屏幕上一样;不给 = 不画);contourDark = 底色深,线换浅色 */
  contours?: ContourKind;
  contourDark?: boolean;
  /** 作者标记(那一年有的;不带 = 空) */
  marks?: readonly MarkItem[];
  /** 正选着的作者人物的足迹(没选 = 不给) */
  trail?: TrailInput | null;
  /** 物产图层:只看哪一样、画不画还没发现的 */
  res?: ResourceLook;
  /** 插件的地块图层(正显示的那个)、标注图层(插件界面开着、有的时候) */
  plugin?: CellPaint;
  pluginMarks?: readonly MarkLayer[];
}

/** 地图图片:后台线程画地形和文明底图,主线程叠文字、编码 PNG / JPEG */
async function exportMap(m: MapInput, scale: ExportScale, format: ImageFormat): Promise<{ blob: Blob; w: number; h: number; detail: Record<string, number> }> {
  const t0 = performance.now();
  const req: ExportRequest = {
    job: 'map',
    world: m.world,
    raster: scale === 1 ? m.raster : undefined,
    veins: scale !== 1 && m.style === 'realistic' ? m.raster.veinLines : undefined,
    scale,
    civ: m.civ,
    style: m.style,
    layer: m.layer,
    look: m.look,
    year: m.year,
    show: m.show,
    center: m.center,
    projection: m.projection,
    graticule: m.graticule,
    split: !!m.contours,
    font: m.style === 'fantasy' ? fantasyFontUrl() : undefined,
    plugin: m.plugin,
  };
  const res = await runWorker(req);
  const t1 = performance.now();
  const W = m.world.width * scale;
  const H = m.world.height * scale;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  if (!ctx) throw new Error('开不了这么大的画布(内存不够)');
  const detail: Record<string, number> = {};
  // 带等值线:地形和上面的文明底图、外框分开拿回来,线画在中间(over = 上面那张,画完线再叠)
  let over: CanvasImageSource | null = null;
  if (res.ok && res.job === 'map') {
    ctx.drawImage(res.bitmap, 0, 0);
    res.bitmap.close();
    over = res.over ?? null;
    detail.raster = res.ms.raster;
    detail.draw = res.ms.draw;
  } else if (!res.ok && res.code === 'no-offscreen') {
    // 老浏览器:线程里画不了,只好在主线程画(会卡一下)
    const raster = scale === 1 ? m.raster : (olderTerrain(m.world)?.rasterize ?? rasterize)(m.world, scale, m.style === 'realistic', m.raster.veinLines);
    const make = (w: number, h: number) => Object.assign(document.createElement('canvas'), { width: w, height: h });
    if (m.contours) {
      drawMapTerrain(ctx, { ...m, raster }, make);
      const ov = make(W, H);
      drawMapOverlay(ov.getContext('2d')!, { ...m, raster }, make);
      over = ov;
    } else drawMapBase(ctx, { ...m, raster }, make);
  } else throw new Error(res.ok ? '后台线程回错了东西' : res.error);
  const putOver = () => {
    if (!over) return;
    ctx.drawImage(over, 0, 0);
    if ('close' in over) over.close();
    else (over as HTMLCanvasElement).width = 0;
    over = null;
  };
  detail.worker = t1 - t0;
  const t2 = performance.now();
  const iso = m.contours ? contoursOf(m.world, m.raster, m.contours) : null;
  const n = await drawMapLabels(ctx, { ...m, era: getEdits().era }, scale, {
    beforeDraw: iso
      ? (placed) => {
          drawExportContours(ctx, m, scale, iso, !!m.contourDark, placed ? placedTextBoxes(placed) : []);
          putOver();
        }
      : undefined,
  });
  putOver();
  // 数据图层的色阶压在地名上面、标记和足迹下面:标记的名字、足迹的年份排的时候让开色阶,点本身画在色阶上面,不会被盖住
  await drawMapLegend(ctx, m, scale);
  const legendBoxes = mapLegendCanvasBoxes(m, scale);
  detail.markCount = m.marks?.length ? drawExportMarks(ctx, m, scale, m.marks, n.placed, undefined, legendBoxes) : 0;
  if (m.trail) detail.trailDots = drawExportTrail(ctx, m, scale, m.trail, n.placed, legendBoxes);
  if (m.pluginMarks?.length) detail.pluginMarks = drawExportPluginMarks(ctx, m, scale, m.pluginMarks);
  const t3 = performance.now();
  detail.labels = t3 - t2;
  detail.labelCount = n.labels;
  const blob = await toBlob(cv, format);
  detail.png = performance.now() - t3;
  cv.width = cv.height = 0;
  return { blob, w: W, h: H, detail };
}

export interface ExportMenuProps {
  data: { world: World; raster: Raster } | null;
  /** App 当前显示的文明(套过用户的修改) */
  civ: Civ | null;
  /** 同一份文明,AI 起的名字换回原来的(没有 AI 起的名字 = null / 不给,菜单里不问) */
  plain?: Civ | null;
  style: CivStyle;
  layer: LayerId;
  /** 写实风的画法(不给 = 经典卫星) */
  look?: SurfaceLook;
  /** 按钮上文字前面的小图标 */
  icon?: ReactNode;
}

export function ExportMenu({ data, civ: shown, plain, style, layer, look = 'classic', icon }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState<ExportScale>(1);
  const [usePlain, setUsePlain] = useState(false);
  const [withMarks, setWithMarks] = useState(true);
  const edits = useEdits();
  const marks = edits.marks;
  const civ = usePlain && plain ? plain : shown;
  const busy = useExportStatus()?.kind === 'busy';
  const time = useCivTime();
  const globeOn = useGlobeOn();
  const relief = useRelief();
  const reliefOn = relief.phase === 'view' && relief.face === 'relief';
  const narrow = useNarrow();
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 手机上选了大图、清晰度下面多出一行时卡片定住的高度(多出来的往下滚,不往上顶住上面的按钮);收起菜单就不定了 */
  const [menuH, setMenuH] = useState<number | null>(null);
  useEffect(() => {
    if (!open) setMenuH(null);
  }, [open]);
  const pickScale = (s: ExportScale) => {
    const el = menuRef.current;
    if (narrow && el && s === 2 && scale === 1) setMenuH(el.offsetHeight);
    else if (s === 1) setMenuH(null);
    setScale(s);
  };

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

  const ok = !!data && !!civ && civ.habitat.suitability.length === data.world.mesh.n;
  const endYear = civ ? Math.floor(civ.endYear) : 0;
  const year = Math.max(0, Math.min(endYear, Math.floor(time.year ?? endYear)));
  const W = (data?.world.width ?? 2048) * scale;
  const H = (data?.world.height ?? 1024) * scale;
  const seed = data?.world.params.seed ?? 0;
  const x2 = scale === 2 ? '-2x' : '';

  const run = async (job: Job) => {
    if (!data || status?.kind === 'busy') return;
    // 新的一趟:之前的「取消」作废,结果照常报
    cancelled = false;
    setOpen(false);
    const { world, raster } = data;
    const seedN = world.params.seed;
    const base = fileBaseName({ title: currentWorld()?.title, seed: seedN });
    // 点下去那一刻的年份和开关(导出过程中拖时间轴不影响这一张)
    const t = getCivTime();
    const y = civ ? Math.max(0, Math.min(civ.endYear, t.year ?? civ.endYear)) : 0;
    const yi = Math.floor(y);
    const show = { ...getCivShow() };
    const params = paramsText(world.params, getEdits().endYear, civ?.seed);
    // 文件名、图例、编年史里的年份照作者的纪年写(文件名里不带空格:"第1650年""公元前850年")
    const era = getEdits().era;
    const fileYear = yearFull(yi, era).replace(/ /g, '');
    const markItems = withMarks && civ && ok ? markItemsAt(civ, world, marks, yi) : [];
    // 正选着的作者人物(填写中的不算)
    const sel = getSelection().sel;
    const who = sel?.kind === 'character' ? getEdits().characters?.find((c) => c.id === sel.id) : undefined;
    const trail = who && civ && ok ? characterTrail(civ, world, raster, who, yi, { kind: 'view' }) : null;
    const what: Record<Job, string> = {
      map: `地图图片(${scale}×)`,
      mapjpg: `地图图片 JPEG(${scale}×)`,
      height16: `16 位高度图(${scale}×)`,
      height8: `8 位高度图(${scale}×)`,
      md: '编年史(Markdown)',
      txt: '编年史(纯文本)',
      legend: `图例(${scale}×)`,
      globe: '地球仪这一面',
      relief: '立体这一面',
    };
    setStatus({ kind: 'busy', text: `正在导出${what[job]}` });
    // 无色标记用地图的字体写:画地图、地球仪的先把字体加载好(先显示在导出,等字体时不能再点一次)
    const plain = markItems.length && (job === 'map' || job === 'mapjpg' || job === 'globe') ? plainMarkChars(marks) : '';
    if (plain) await ensureFonts(markStyle(style), plain, 15000);
    await nextFrame();
    const t0 = performance.now();
    try {
      let dbg: ExportDebug;
      if (job === 'relief') {
        const r = await exportReliefView();
        if (!r) throw new Error('立体没有打开');
        download(r.blob, r.name);
        dbg = { job, name: r.name, bytes: r.blob.size, w: r.w, h: r.h, ms: performance.now() - t0 };
        const rmb = r.blob.size >= 1e6 ? `${(r.blob.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(r.blob.size / 1e3))} KB`;
        setStatus({ kind: 'ok', text: `已导出 ${r.name}`, more: `${r.w}×${r.h}，${rmb}，用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒` });
      } else if (job === 'globe') {
        // 地球仪这一面:标记照屏幕上的规矩(缩得小时不写名字、挨得近的合起来)
        const r = await exportGlobeView(
          markItems.length || trail
            ? (ctx, v) => {
                const frame = { pt: v.pt, period: 0, win: [0, v.w] as [number, number], w: v.w, h: v.h, k: v.k, cut: 0 };
                if (markItems.length) drawMarks(ctx, layoutMarks(markItems, frame, { measure: canvasMeasure(ctx), style: markStyle(style) }), v.dpr, markStyle(style));
                if (trail) drawTrail(ctx, layoutTrail(trail, frame, { measure: canvasMeasure(ctx) }));
              }
            : undefined,
        );
        if (!r) throw new Error('地球仪没有打开');
        download(r.blob, r.name);
        dbg = { job, name: r.name, bytes: r.blob.size, w: r.w, h: r.h, ms: performance.now() - t0 };
        const gmb = r.blob.size >= 1e6 ? `${(r.blob.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(r.blob.size / 1e3))} KB`;
        setStatus({ kind: 'ok', text: `已导出 ${r.name}`, more: `${r.w}×${r.h}，${gmb}，用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒` });
      } else if (job === 'map' || job === 'mapjpg') {
        const format: ImageFormat = job === 'map' ? 'png' : 'jpeg';
        const name = `${base}-${fileYear}-${styleName(style, layer, look)}${x2}.${IMAGE_FORMATS[format].ext}`;
        // 球面世界:按当前视图的中心展开(左右边 = 中心 ± 180°);投影、经纬网和屏幕上一样
        const center = wrapOf(world) ? xOfLon(getMapCenter(), world.width) : undefined;
        const projection = flatProjection(getProjection());
        const graticule = getGraticuleLines();
        const contours = getContourKind() ?? undefined;
        const contourDark = style === 'data' && MAP_LAYERS.some((l) => l.data === layer && l.dark);
        const r = await exportMap(
          { world, raster, civ: ok ? civ : null, style, layer, look, year: y, show, center, projection, graticule, contours, contourDark, marks: markItems, trail, res: { ...getResourceView() }, ...pluginExport(y) },
          scale,
          format,
        );
        download(r.blob, name);
        dbg = { job, name, bytes: r.blob.size, w: r.w, h: r.h, ms: performance.now() - t0, detail: r.detail };
        const mb = r.blob.size >= 1e6 ? `${(r.blob.size / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(r.blob.size / 1e3))} KB`;
        setStatus({ kind: 'ok', text: `已导出 ${name}`, more: `${r.w}×${r.h}，${mb}，用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒` });
      } else if (job === 'height16' || job === 'height8') {
        const bits: HeightmapBits = job === 'height16' ? 16 : 8;
        const name = `${base}-高度图-${bits}位${x2}.png`;
        const req: ExportRequest =
          scale === 1
            ? { job: 'heightmap', seed: seedN, scale, bits, raster: { w: raster.w, h: raster.h, elev: raster.elev, water: raster.water } }
            : { job: 'heightmap', seed: seedN, scale, bits, world };
        const res = await runWorker(req);
        if (!res.ok) throw new Error(res.error);
        if (res.job !== 'heightmap') throw new Error('后台线程回错了东西');
        const blob = new Blob([res.png], { type: 'image/png' });
        download(blob, name);
        const noteName = name.replace(/\.png$/, '-说明.txt');
        const noteText = heightmapNote(res.info, { seed: seedN, file: name, params });
        dbg = { job, name, bytes: blob.size, w: res.info.width, h: res.info.height, ms: performance.now() - t0, detail: res.ms, seaLevel: res.info.seaLevel };
        setStatus({
          kind: 'ok',
          text: `已导出 ${name}`,
          more:
            bits === 16
              ? `海平面 = 灰度 ${res.info.seaLevel}(0 = ${Math.round(res.info.lo)} 米,65535 = ${Math.round(res.info.hi)} 米)`
              : `海平面 = 灰度 ${AZGAAR_SEA_GRAY}(Azgaar 的高度 20)`,
          note: { name: noteName, text: noteText },
        });
      } else if (job === 'md' || job === 'txt') {
        if (!civ) throw new Error('文明还没推演完');
        // 换回原名的那份历史还没算过编年史:在主线程上分小块算好(长历史一口气算要好几百毫秒,界面那么久不动)
        await chronicleInSlices(civ);
        const name = `${base}-编年史.${job === 'md' ? 'md' : 'txt'}`;
        const text = chronicleDocument(civ, { format: job, seed: seedN, params, entries: fullChronicle(civ), era, months: monthsOf(getEdits().months), monthNames: monthNamesInUse(getEdits().monthNames) });
        const blob = new Blob([text], { type: job === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' });
        download(blob, name);
        dbg = { job, name, bytes: blob.size, ms: performance.now() - t0 };
        setStatus({ kind: 'ok', text: `已导出 ${name}` });
      } else {
        if (!ok || !civ) throw new Error('文明还没推演完');
        const name = `${base}-${fileYear}-图例${x2}.png`;
        const cv = await drawLegend({ civ, style, year: y, show, seed: seedN, layer, era }, scale);
        const blob = await toBlob(cv);
        download(blob, name);
        dbg = { job, name, bytes: blob.size, w: cv.width, h: cv.height, ms: performance.now() - t0 };
        setStatus({ kind: 'ok', text: `已导出 ${name}` });
      }
      (window as unknown as { __wfExport?: ExportDebug }).__wfExport = dbg;
    } catch (e) {
      if (cancelled) return;
      console.error('导出失败', e);
      setStatus({ kind: 'error', text: '导出失败', more: explain(e, scale), retry: () => void run(job) });
    }
  };

  const items: { job: Job; title: string; sub: string; need?: boolean }[] = [
    ...(globeOn ? [{ job: 'globe' as const, title: '导出地球仪这一面', sub: '现在看到的样子，PNG' }] : []),
    ...(reliefOn ? [{ job: 'relief' as const, title: '导出立体这一面', sub: '现在看到的样子，PNG' }] : []),
    { job: 'map', title: '地图图片(PNG)', sub: `整张地图，${styleName(style, layer, look)}，${yearFull(year, edits.era)}${style !== 'data' ? '' : isGradientLegend(layer) ? '，左上带色阶' : '，色块另在图例图片里'}，${W}×${H}`, need: true },
    { job: 'mapjpg', title: '地图图片(JPEG)', sub: `同上,文件小好几倍(质量 ${Math.round(IMAGE_FORMATS.jpeg.quality! * 100)}%)`, need: true },
    {
      job: 'legend',
      title: '图例(PNG)',
      sub:
        style === 'data'
          ? `${styleName(style, layer, look)}的色阶 / 色块，配地图用`
          : `${yearFull(year, edits.era)}的国家 / 民族 + 颜色、城镇符号、道路`,
      need: true,
    },
    { job: 'height16', title: '高度图(16 位 PNG)', sub: `游戏引擎、World Machine 用，${W}×${H}` },
    { job: 'height8', title: '高度图(8 位 PNG)', sub: `Azgaar 导入用，海平面 = 灰度 ${AZGAAR_SEA_GRAY}(Azgaar 的 20)` },
    { job: 'md', title: '编年史(Markdown)', sub: '按时代分节,大事在前、全部附后', need: true },
    { job: 'txt', title: '编年史(纯文本)', sub: '同上,不带 Markdown 记号', need: true },
  ];

  return (
    <div className="export" ref={rootRef}>
      <button
        className={`export-btn${icon ? ' glass mb-btn' : ''}${open ? ' on' : ''}`}
        disabled={!data}
        onClick={() => setOpen((o) => !o)}
        title="导出地图图片、高度图、编年史、图例"
      >
        {busy ? (
          <>
            <span className="spin" /> <span className="mb-label">正在导出…</span>
          </>
        ) : (
          <>
            {icon}
            <span className="mb-label">导出</span>
          </>
        )}
      </button>
      {open && (
        <div className="export-menu" role="menu" ref={menuRef} style={menuH ? { height: menuH } : undefined}>
          {/* 回放导出:点了左边面板(手机:底部卡片)换成导出的选项 */}
          <button
            className="export-item go"
            role="menuitem"
            data-job="film"
            disabled={busy || !ok}
            onClick={() => {
              setOpen(false);
              openFilm('video', narrow);
            }}
          >
            <b>回放视频(MP4)</b>
            <span>把时间轴放一遍，存成横屏或竖屏的视频</span>
          </button>
          <button
            className="export-item go"
            role="menuitem"
            data-job="long"
            disabled={busy || !ok}
            onClick={() => {
              setOpen(false);
              openFilm('long', narrow);
            }}
          >
            <b>故事长图</b>
            <span>按时代分段：那时的地图和几件大事，拼成长图</span>
          </button>
          {/* 地区图:进「地区」框一块(和右下「地区」同一套),看这一块的那一页上导出 */}
          <button
            className="export-item go"
            role="menuitem"
            data-job="region"
            disabled={busy || !ok}
            onClick={() => {
              setOpen(false);
              openReliefPick();
            }}
          >
            <b>地区图</b>
            <span>在地图上框一块，出一张带标题、比例尺、图例的图</span>
          </button>
          <div className="export-hr" />
          <div className="export-scale">
            <span>清晰度</span>
            <div className="seg">
              {([1, 2] as const).map((s) => (
                <button key={s} className={scale === s ? 'on' : ''} onClick={() => pickScale(s)} title={s === 2 ? '重新铺两倍像素,文字按两倍密度重画;适合打印、放大看' : undefined}>
                  {/* 按钮上只写像素大小;"两倍"的意思在鼠标停上去的说明里 */}
                  {(data?.world.width ?? 2048) * s}×{(data?.world.height ?? 1024) * s}
                </button>
              ))}
            </div>
            {/* 手机上选了大图:后果写在选的地方(照样能导;内存大的手机导得出来) */}
            {narrow && scale === 2 && (
              <p className="export-warn" data-act="export-big-warn">
                <Icon name="warn" size={14} />
                <span>
                  大图要多占三四百 MB 内存，手机上可能闪退。
                  <br />
                  要打印、放大看，建议在电脑上导出。
                </span>
              </p>
            )}
          </div>
          {plain && (
            <div className="export-scale export-ainames">
              <span>AI 起的名字</span>
              <div className="seg">
                <button className={usePlain ? '' : 'on'} onClick={() => setUsePlain(false)}>
                  带上
                </button>
                <button className={usePlain ? 'on' : ''} onClick={() => setUsePlain(true)} title="导出的地图、图例、编年史里用原来的名字">
                  换回原名
                </button>
              </div>
            </div>
          )}
          {!!marks?.length && (
            <div className="export-scale export-marks">
              <span>作者标记</span>
              <div className="seg">
                <button className={withMarks ? 'on' : ''} onClick={() => setWithMarks(true)} title="地图图片、地球仪这一面上画出这一年有的标记">
                  带上
                </button>
                <button className={withMarks ? '' : 'on'} onClick={() => setWithMarks(false)}>
                  不带
                </button>
              </div>
            </div>
          )}
          {items.map((it) => (
            <button key={it.job} className="export-item" role="menuitem" data-job={it.job} disabled={busy || (it.need && !ok)} onClick={() => void run(it.job)}>
              <b>{it.title}</b>
              <span>{it.sub}</span>
            </button>
          ))}
          <div className="export-foot">种子 {seed}:同一种子 + 参数永远得到同一个世界</div>
        </div>
      )}
    </div>
  );
}
