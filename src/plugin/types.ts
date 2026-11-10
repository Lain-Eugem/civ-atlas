/**
 * 插件接口第 1 版的样子:插件在线程里拿到的全局对象 civAtlas,和网站递进来、收回去的数据。
 * 给写插件的人看,网站这边的实现也照它的类型写。
 *
 * 每个函数只收一个参数对象,以后加可选的字段、加函数不算改版。
 * 网站递进来的都是复制或转交的一份,插件改了不影响世界。编号(id)只在这一次打开的世界里有效;
 * 键(key)是稳定键,改名、下干预、钉标记都用它。
 */

/** 能力(清单 requires / optional 里写的「名字@大版本」;这一版网站有的见 pluginCaps.ts) */
export type CapRef =
  | 'world.read@1'
  | 'history.read@1'
  | 'author.read@1'
  | 'author.write@1'
  | 'view.read@1'
  | 'input.pick@1'
  | 'ui.panel@1'
  | 'layer.cells@1'
  | 'layer.regions@1'
  | 'layer.marks@1'
  | 'store.local@1'
  | 'store.world@1';

/**
 * 出错时 Error 上的 code:
 * no-permission 清单里没要这样能力;unknown-call 没有这个调用;bad-args 参数不对;limit 超过上限;
 * unavailable 现在拿不到(比如还没有历史、网站这边没开这个功能);busy 正忙(取数太快、上一次点选还没完);
 * blocked 网站这时不让改;cancelled 用的人取消了;failed 网站这边出错
 */
export type PluginErrorCode = 'no-permission' | 'unknown-call' | 'bad-args' | 'limit' | 'unavailable' | 'busy' | 'blocked' | 'cancelled' | 'failed';

export interface PluginError extends Error {
  code: PluginErrorCode;
}

export interface HostInfo {
  /** 接口大版本 */
  api: number;
  app: string;
  /** 给了这个插件的能力 */
  caps: CapRef[];
  /** 地块数;没开世界 = 0 */
  cells: number;
}

// ---------------------------------------------------------------------------
// 地图(world.read)

export interface WorldInfo {
  title: string;
  seed: number;
  cells: number;
  /** 主图的宽高(世界坐标):x ∈ [0, width) 对应经度 −180°…180°,y ∈ [0, height] 对应纬度 90°…−90° */
  width: number;
  height: number;
  /** 一个世界单位约多少公里(赤道处) */
  kmPerUnit: number;
}

/** 每个地块一个数的几种数据 */
export interface CellArrays {
  x: Float32Array;
  y: Float32Array;
  /** 度 */
  lon: Float32Array;
  lat: Float32Array;
  /** 平方公里 */
  area: Float32Array;
  /** 米,海洋为负 */
  elevation: Float32Array;
  /** 0 陆地 / 1 海洋 / 2 湖泊 */
  water: Uint8Array;
  /** 年均温,°C */
  temperature: Float32Array;
  /** 年降水,毫米 */
  precipitation: Float32Array;
  /** 生物群落编号,名字用 world.legend({ kind: 'biome' }) 查 */
  biome: Uint8Array;
  /** 径流量(累计) */
  flux: Float32Array;
  /** 海冰 0–1 */
  seaIce: Float32Array;
}
export type CellField = keyof CellArrays;

/** 相邻表:地块 i 的邻居是 list[start[i] .. start[i + 1]) */
export interface Neighbors {
  start: Int32Array;
  list: Int32Array;
}

export interface RiverInfo {
  /** 从源头到入海 / 入湖处经过的地块 */
  cells: Int32Array;
}

export interface LegendEntry {
  value: number;
  name: string;
}

// ---------------------------------------------------------------------------
// 历史(history.read)

export interface HistorySpan {
  from: number;
  to: number;
}

/** 某一年每个地块的归属,−1 = 没有(水上、没人住) */
export interface CellOwners {
  polity: Int16Array;
  culture: Int16Array;
  faith: Int16Array;
  /** 所在的州 */
  region: Int32Array;
}
export type OwnerField = keyof CellOwners;

/** 颜色一律写成 #rrggbb */
export type Hex = string;

export interface PolityInfo {
  id: number;
  key: string;
  /** 那一年的全称(没给年份 = 最后一年的) */
  name: string;
  /** 国名词根 */
  root: string;
  color: Hex;
  founded: number;
  ended?: number;
  /** 那一年的国都(城的编号) */
  capital: number;
  culture: number;
  /** 从哪国分出来的 */
  parent?: number;
}

export interface SettlementInfo {
  id: number;
  key: string;
  name: string;
  cell: number;
  region: number;
  founded: number;
  ended?: number;
  /** 是不是港口(给了年份 = 那一年的;地形大事能改) */
  port: boolean;
  /** 那一年的人口(千人);只有给了年份才有 */
  population?: number;
  /** 那一年的等级 0 村 / 1 镇 / 2 城 / 3 大城;只有给了年份才有 */
  rank?: number;
}

export interface RouteInfo {
  kind: 'road' | 'trail' | 'sea';
  cells: Int32Array;
  built: number;
  abandoned?: number;
}

export interface PlaceInfo {
  id: number;
  key: string;
  kind: 'sea' | 'mountains' | 'river' | 'lake' | 'island' | 'desert' | 'pass';
  name: string;
  cell?: number;
  rank: number;
}

export interface CultureInfo {
  id: number;
  key: string;
  name: string;
  kind: string;
  /** 发源的州 */
  hearth: number;
  born: number;
  ended?: number;
  color: Hex;
  parent?: number;
}

export interface FaithInfo {
  id: number;
  key: string;
  name: string;
  kind: string;
  form?: string;
  culture?: number;
  parent?: number;
  founded?: number;
  /** 圣城(城的编号) */
  holy?: number;
  color: Hex;
}

/** 给了年份 = 那一年那一段地形的州(地形大事前后州的编号、键不变,治所、面积可能变) */
export interface RegionInfo {
  id: number;
  key: string;
  /** 没人住过的州是空串 */
  name: string;
  /** 治所地块 */
  seat: number;
  /** 平方公里 */
  area: number;
  /** 那一年的人口(千人);只有给了年份才有 */
  population?: number;
}

export interface PersonInfo {
  id: number;
  key: string;
  name: string;
  role: 'ruler' | 'general' | 'prince' | 'minister' | 'consort';
  polity: number;
  born: number;
  died?: number;
  /** 君主:即位;名臣:入仕 */
  from?: number;
  until?: number;
  title?: string;
  female?: true;
}

export interface EventInfo {
  id: number;
  year: number;
  end: number;
  /** 一个字的标签(立、战、亡……) */
  tag: string;
  text: string;
  /** 1–3,3 是大事 */
  importance: number;
  polities: number[];
  regions: number[];
  /** 相关的城;没有 = −1 */
  settlement: number;
  people?: number[];
}

/** 分页取的结果:next 是下一页的 offset,取完了 = null */
export interface Page<T> {
  items: T[];
  total: number;
  next: number | null;
}

// ---------------------------------------------------------------------------
// 你写的东西(author.read / author.write)

/** 你的标记的颜色:六种,或 none(不画图钉、不铺色,名字像地图上的地名) */
export type AuthorMarkColor = 'red' | 'orange' | 'green' | 'blue' | 'purple' | 'teal' | 'none';

export interface AuthorMarkInfo {
  id: number;
  /** 最长 40 字;空的叫「新标记」 */
  title: string;
  /** 可以分行,最长 2000 字 */
  note?: string;
  color: AuthorMarkColor;
  /** 名字的字号:小 / 大 / 特大;不给 = 中 */
  size?: 's' | 'l' | 'xl';
  /** 时间轴在 [from, to] 这些年里(两头都算)地图上才画它;整数年,to 不给 = 一直在 */
  from: number;
  to?: number;
  /** 一个点(世界坐标);和 regions 只给一个 */
  at?: [number, number];
  /** 几个州的键,最多 500 个 */
  regions?: string[];
}

export interface AuthorNoteInfo {
  key: string;
  kind: string;
  title: string;
  text: string;
  createdAt: string;
}

/** 君主、掌权的人的倾向:开拓、好战、发展、重商,各 0–100 的整数 */
export interface Leanings {
  expand: number;
  war: number;
  develop: number;
  trade: number;
}

/**
 * 一条命令(干预),和世界文件里的一个格式;每种的意思见 src/gen/edits.ts 开头「干预」那一节的表。
 * a、b、ps、foes、friends、by 是国家键,region、regions、zone、to 是州键,city 是城键,person 是人物键,folk 是民族键;
 * char、lead、author 是用的人放进世界的人物的编号;from、until、born、died 是整数年份。
 * fromTick:在 from 那一年的第几格(1–255,一年 256 格;不给 = 年初)。
 * plot、guide 和方针的 power、unrest、look 是照大纲推演自己记的(author.interventions 读得到),plugin 是推演插件在推演里下的(插件编号):
 * author.apply 交上来的这几样会去掉;别的字段网站不替插件改,不合规矩回 bad-args
 */
export type InterventionInfo = (
  | { kind: 'protect'; a: string; from: number; until?: number }
  | { kind: 'ally'; a: string; b: string; from: number; until?: number }
  | { kind: 'declare'; a: string; b: string; from: number; lead?: number }
  | { kind: 'unity'; a: string; from: number }
  | { kind: 'cede'; a: string; region: string; from: number; permanent?: true }
  | { kind: 'found'; region: string; from: number; name?: string }
  | { kind: 'move'; a: string; city: string; from: number }
  | { kind: 'halt'; a: string; from: number; until?: number }
  | { kind: 'press'; a: string; b?: string; from: number; until?: number }
  | { kind: 'crown'; a: string; char: number; from: number; born: number; until?: number; abdicate?: true; after?: true; keep?: true; leanings: Leanings }
  | { kind: 'keep'; a: string; from: number; until?: number }
  | { kind: 'destroy'; a: string; from: number; b?: string }
  | { kind: 'death'; a: string; person: string; from: number }
  | { kind: 'temper'; a: string; person: string; from: number; leanings: Leanings }
  | {
      kind: 'disaster';
      type: 'plague' | 'famine' | 'quake' | 'pandemic';
      level: 1 | 2 | 3;
      from: number;
      city?: string;
      a?: string;
      regions?: string[];
      region?: string;
      slump?: number;
    }
  | { kind: 'treaty'; a: string; ps: string[]; from: number; term?: number; limited?: true; keep?: true; by?: string; zone?: string; ask?: true }
  | { kind: 'neutral'; a: string; region: string; ps: string[]; from: number; quiet?: true; lasting?: true; until?: number; ask?: true }
  | {
      kind: 'regent';
      a: string;
      person: string;
      char?: undefined;
      from: number;
      how: 'march' | 'heir' | 'uncle' | 'chancellor' | 'general';
      end: 'succeed' | 'return' | 'usurp';
      years?: number;
      leanings?: Leanings;
    }
  | { kind: 'regent'; a: string; person?: undefined; char: number; born: number; died?: number; from: number; how: 'chancellor' | 'general'; end: 'return'; years?: number; leanings: Leanings }
  | { kind: 'marry'; a: string; person: string; b: string; from: number; how?: 'give' | 'mutual' }
  | { kind: 'appoint'; a: string; char: number; role: 'general' | 'minister'; born: number; died?: number; from: number; until?: number; skill?: 'good' | 'great' }
  | { kind: 'boost'; a: string; from: number; mul?: 3 | 10; until?: number; regions?: string[] }
  | { kind: 'trek'; folk: string; from: number; region?: string; to?: string; reach?: 'near' | 'far'; dir?: 'east' | 'south' | 'west' | 'north' }
  | { kind: 'stay'; folk: string; from: number; until?: number }
  | {
      kind: 'policy';
      a: string;
      from: number;
      preset?: 'expand' | 'hold' | 'trade' | 'peace';
      /** 打仗胆量、开拓、沿海、和谈底线:各 −50…50 的整数 */
      war?: number;
      expand?: number;
      coast?: number;
      peace?: number;
      /** 各最多 3 国 */
      foes?: string[];
      friends?: string[];
      focus?: 'production' | 'transport' | 'information' | 'administration' | 'mobilization';
      power?: number;
      unrest?: number;
      look?: { kind: 'war' | 'politics' | 'dynasty'; years: number[] };
    }
) & { fromTick?: number; author?: number; plot?: number; guide?: true; plugin?: string };

/**
 * 改你写的东西(author.write)的一条:
 * name 改名(null 或空的 = 恢复原名;国名末尾的「国」「王朝」这类先去掉,剩下的最长 16 字);
 * mark 加一个标记(不用给 id);intervention 下一条命令
 */
export type AuthorChange =
  | { kind: 'name'; key: string; name: string | null }
  | { kind: 'mark'; mark: Omit<AuthorMarkInfo, 'id'> }
  | { kind: 'intervention'; v: InterventionInfo };

/** applied 照办了几条;skipped 本来就是这样、没变的几条;marks 新标记的编号 */
export interface ApplyResult {
  applied: number;
  skipped: number;
  marks: number[];
}

// ---------------------------------------------------------------------------
// 插件自己的数据(store.local / store.world)

/** value 只能是 null、true / false、有限的数、字、数组、普通对象和数值数组(TypedArray),最多套 32 层 */
export interface StoredData {
  /** 插件自己的结构版本,正整数 */
  schema: number;
  value: unknown;
}

// ---------------------------------------------------------------------------
// 你在干什么(view.read)

export interface ViewInfo {
  year: number;
  /** 选中的东西;没选 = null */
  selected: { kind: string; key?: string; id?: number; cell?: number } | null;
  /** 看得见的范围(世界坐标);不知道 = null */
  visible: { x0: number; y0: number; x1: number; y1: number } | null;
  /** 现在的填色或数据图层 */
  layer: string | null;
}

// ---------------------------------------------------------------------------
// 点选(input.pick)

export interface BoxPick {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cells: Int32Array;
}

// ---------------------------------------------------------------------------
// 插件面板(ui.panel):插件只说放什么,长什么样由网站画

/** 按钮、下拉、滑块、开关的 id:字母数字、- 和 _,最长 32 */
export type PanelNode =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string }
  | { type: 'number'; label: string; value: number; unit?: string }
  | { type: 'table'; columns: string[]; rows: (string | number)[][] }
  | { type: 'list'; items: string[] }
  | { type: 'button'; id: string; label: string; disabled?: boolean }
  | { type: 'select'; id: string; label: string; options: { value: string; label: string }[]; value?: string }
  | { type: 'slider'; id: string; label: string; min: number; max: number; step?: number; value: number }
  | { type: 'toggle'; id: string; label: string; value: boolean }
  | { type: 'legend'; items: { color: Hex; label: string }[] }
  | { type: 'divider' }
  /** value 0–1 */
  | { type: 'progress'; value: number; label?: string }
  | { type: 'group'; title?: string; children: PanelNode[] };

/** 用的人动了面板上的东西:按钮没有 value */
export interface PanelAction {
  id: string;
  value?: string | number | boolean;
}

// ---------------------------------------------------------------------------
// 图层(layer.cells / layer.regions / layer.marks):插件交数据,网站来画

/** 图层 id:字母数字、- 和 _,最长 32 */
export interface CellLayerSpec {
  id: string;
  title: string;
  /** 每个地块一个数,个数等于地块数;NaN = 这块不画 */
  values: ArrayLike<number>;
  /** 渐变:2–16 个颜色,从 min 到 max(不给 = 按数据的最小最大) */
  ramp?: { colors: Hex[]; min?: number; max?: number };
  /** 分类:值等于 value 的地块涂这种颜色,1–32 类 */
  classes?: { value: number; color: Hex; label: string }[];
  /** 图例的单位或说明 */
  legend?: string;
  /** 0–1,不给 = 网站定 */
  opacity?: number;
}

/** 按州按年份的图层:样子同 CellLayerSpec */
export interface RegionLayerSpec extends Omit<CellLayerSpec, 'values'> {
  /** 每一份是哪一年的:整数,从小到大、不重复,在 0 到 history.span() 的 to 之间 */
  years: ArrayLike<number>;
  /** 份数 × 州数(州数 = history.regions() 的个数),第 k 份接在第 k − 1 份后面;NaN = 这个州不画 */
  values: ArrayLike<number>;
}

/** 标注图层的颜色(和你的标记的颜色不是一套) */
export type LayerMarkColor = 'red' | 'orange' | 'green' | 'blue' | 'purple' | 'teal' | 'black' | 'white';

export interface MarkStyle {
  color?: LayerMarkColor;
  line?: 'solid' | 'dashed';
  size?: 's' | 'm' | 'l';
}

/**
 * 一项标注:point 一个点;label 一个点加文字;line 一条线(按先后连);area 圈出几个地块。
 * 位置给 cells(地块编号)或 points(世界坐标 x0, y0, x1, y1, …),area 只认 cells
 */
export interface MarkItem {
  kind: 'point' | 'label' | 'line' | 'area';
  cells?: ArrayLike<number>;
  points?: ArrayLike<number>;
  /** 最长 40 字;label 必须有 */
  text?: string;
  style?: MarkStyle;
}

export interface MarkLayerSpec {
  id: string;
  title: string;
  items: MarkItem[];
}

// ---------------------------------------------------------------------------
// civAtlas

type Call<A, R> = (args: A) => Promise<R>;
type Call0<R> = (args?: Record<string, never>) => Promise<R>;

export interface CivAtlas {
  readonly protocol: number;
  /** 照名字调用(和下面那些函数一样) */
  request<T = unknown>(call: string, args?: unknown): Promise<T>;
  /** 听网站发来的事件;返回取消的函数 */
  on(event: 'view.year', fn: (d: { year: number }) => void): () => void;
  on(event: 'view.select', fn: (d: ViewInfo['selected']) => void): () => void;
  on(event: 'panel.action', fn: (d: PanelAction) => void): () => void;
  /** 开发者模式的日志 */
  log(...parts: unknown[]): void;
  /** 网站问插件的话(工具模式里用) */
  onCall(fn: ((data: unknown) => unknown) | null): void;
  onMessage(fn: ((data: unknown) => void) | null): void;
  post(data: unknown): void;

  host: { info: Call0<HostInfo> };
  world: {
    info: Call0<WorldInfo>;
    /** 一次最多 16 种 */
    cells<F extends CellField>(args: { fields: F[] }): Promise<Pick<CellArrays, F>>;
    neighbors: Call0<Neighbors>;
    rivers: Call0<RiverInfo[]>;
    legend: Call<{ kind: 'biome' | 'water' }, LegendEntry[]>;
  };
  history: {
    span: Call0<HistorySpan>;
    at<F extends OwnerField>(args: { year: number; fields: F[] }): Promise<Pick<CellOwners, F>>;
    /** 给了年份 = 只列那一年在的 */
    polities: Call<{ year?: number }, PolityInfo[]>;
    settlements: Call<{ year?: number }, SettlementInfo[]>;
    routes: Call<{ year?: number }, RouteInfo[]>;
    places: Call0<PlaceInfo[]>;
    cultures: Call0<CultureInfo[]>;
    faiths: Call0<FaithInfo[]>;
    regions: Call<{ year?: number }, RegionInfo[]>;
    /** 一次最多 2000 个 */
    people: Call<{ offset?: number; limit?: number; polity?: number; role?: PersonInfo['role'] }, Page<PersonInfo>>;
    /** 编年史 [from, to] 年里的条目,字已经换好名字;一次最多 2000 条 */
    events: Call<{ from?: number; to?: number; offset?: number; limit?: number }, Page<EventInfo>>;
  };
  author: {
    marks: Call0<AuthorMarkInfo[]>;
    /** 改过的名字:稳定键 → 名字 */
    names: Call0<Record<string, string>>;
    characters: Call0<unknown[]>;
    interventions: Call0<InterventionInfo[]>;
    /** AI 写的正文;一次最多 100 篇 */
    notes: Call<{ offset?: number; limit?: number }, Page<AuthorNoteInfo>>;
    /** 提一批修改(最多 200 条):有一条不合格整批不改;照办的整批记一步撤销 */
    apply: Call<{ changes: AuthorChange[] }, ApplyResult>;
  };
  view: { get: Call0<ViewInfo> };
  pick: {
    cell: Call<{ hint?: string }, { cell: number }>;
    cells: Call<{ hint?: string; max?: number }, { cells: Int32Array }>;
    box: Call<{ hint?: string }, BoxPick>;
  };
  panel: {
    /** 整个换掉;一个面板最多 2000 个节点、4000 字,表格最多 500 行 */
    set: Call<{ nodes: PanelNode[] }, void>;
    clear: Call0<void>;
  };
  layer: {
    /** 同 id 的换掉;一个插件最多 4 个 */
    cells: Call<CellLayerSpec, void>;
    /** 同 id 的换掉;和地块图层合起来一个插件最多 4 个;份数 × 州数 × 4 字节最多 3.5 MB */
    regions: Call<RegionLayerSpec, void>;
    /** 同 id 的换掉;一个插件最多 4 个,每个最多 5000 项 */
    marks: Call<MarkLayerSpec, void>;
    remove: Call<{ id: string }, void>;
  };
  store: {
    /** 插件自己的设置,不在世界里;最多 64 KB */
    local: { get: Call0<StoredData | null>; set: Call<StoredData, void>; clear: Call0<void> };
    /** 存进这个世界(带了它的世界不能公开分享);最多 1 MB */
    world: { get: Call0<StoredData | null>; set: Call<StoredData, void>; clear: Call0<void> };
  };
}
