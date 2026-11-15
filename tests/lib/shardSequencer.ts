/**
 * 单测排队、分份的办法(vite.config.ts 的 test.sequence.sequencer)。
 *
 * PR 上的检查把单测分成几份,在几台机器上同时跑(vitest run --shard=第几份/共几份)。vitest 自带的分法
 * 按文件名的散列平均分文件个数,不管快慢:几个几分钟的慢文件扎堆分到一起时,最慢的一份要比最快的一份慢一倍多。
 * 这里按每个文件大概要跑多久分:从慢到快,一个个放进眼下最轻的那一份,几份的耗时就差不多。
 * 几台机器各算各的,文件和表一样,分出来就一样,不会漏跑、重跑。
 *
 * 每一份里(不分份时就是全部)也从慢到快排着跑,慢文件早早开跑,不会在最后单独拖长整份。
 * 只改先后和分份,不改跑哪些测试:本地 pnpm test 照样一次跑全。
 */
import { relative } from 'node:path';
import type { TestSequencer, Vitest, WorkspaceSpec } from 'vitest/node';

/**
 * 各测试文件(tests/ 下、去掉 .test.ts)在 GitHub 的机器上大概要跑几秒,大致准就行。
 *
 * 取自检查日志里 vitest 每个文件那行的毫秒数(最近几轮 main 上的检查,取各文件的中位数)。
 * GitHub 的机器快慢不一,同一个文件这一轮比那一轮慢一半也常见,表里是折算到中等快的机器上的数。
 * 一份里 3 个文件同时跑,一份的用时 ≈ 这份各文件秒数加起来 ÷ 2.8。
 * 全部加起来七千两百来秒,分 8 份每份约 5 分钟;分到慢机器的那份要多两三成。
 * 一份至少要等它里面最慢的那个文件跑完:一个文件跑得快赶上一份的用时了,就按内容拆成几个文件
 * (civ-interventions*、civ-resume-fuzz* 就是这样拆开的),每个文件各推各的世界,好分到几份里去。
 */
const SECONDS: Record<string, number> = {
  'civ-more-interventions': 262,
  stepwise: 237,
  'outline-guide': 209,
  'civ-base-cache': 199,
  'civ-policy': 195,
  'stepwise-run-2024': 191,
  outline: 179,
  'civ-crown': 162,
  'raster-edit': 152,
  'civ-resume-fuzz-upheaval-15': 148,
  'civ-interventions-land': 142,
  'civ-resume-fuzz': 142,
  'civ-sim': 141,
  'civ-upheaval': 140,
  'civ-keep': 132,
  'civ-frontier': 131,
  'civ-labels': 131,
  'civ-interventions': 128,
  'civ-resume-fuzz-upheaval': 126,
  'names-stable': 123,
  'civ-council': 120,
  'stepwise-run-7': 116,
  'civ-politics': 114,
  'civ-resume': 111,
  'civ-cities': 108,
  'civ-pandemic': 103,
  'name-mix': 101,
  'civ-interventions-land-resume': 98,
  'civ-assimilation': 95,
  'civ-interventions-war': 95,
  'civ-wars': 94,
  'civ-extend': 93,
  'civ-routes': 88,
  'civ-diplomacy': 86,
  'civ-dynasty': 81,
  'ai-assistant': 71,
  'stepwise-rewind': 70,
  'civ-polities': 69,
  'civ-play': 68,
  'civ-regions': 68,
  'civ-treaties': 62,
  'ai-agent': 60,
  'civ-control': 59,
  'edit-repaint': 59,
  'civ-people-page': 50,
  'ai-lookup': 49,
  'civ-unrest': 45,
  'civ-boost': 44,
  'stepwise-ui': 41,
  'chronicle-handoff': 40,
  'chronicle-tokens': 30,
  contours: 39,
  'civ-development': 38,
  'civ-fiscal-book': 37,
  'civ-plague': 37,
  'civ-seed': 37,
  'regency-iv': 37,
  'treaty-iv': 34,
  'civ-rulers': 32,
  'civ-sea-lanes': 32,
  'civ-tempo': 32,
  'crown-ui': 31,
  'new-iv-ui': 31,
  'sphere-labels': 31,
  edits: 30,
  'civ-chronicle': 29,
  'sphere-raster': 28,
  'civ-exile': 27,
  'civ-officials': 26,
  'keep-ui': 26,
  'policy-ui': 26,
  'share-moment': 26,
  marks: 25,
  'places-labels': 23,
  finder: 22,
  'stepwise-branches-run-11': 22,
  portrait: 21,
  'thumb-prep': 21,
  'relation-graph': 21,
  'labels-charset': 20,
  savefile: 20,
  'stepwise-branches-run-2024': 19,
  'stepwise-branches-run-7': 19,
  'civ-regency': 18,
  'ai-realwords': 17,
  export: 17,
  'outline-move': 17,
  'ai-history': 16,
  characters: 16,
  'civ-pass-sites': 16,
  'civ-warfare': 16,
  'civ-lineage-view': 15,
  'civ-people': 15,
  'globe-cpu-pool': 15,
  sketch: 15,
  'ai-rewrite': 14,
  determinism: 14,
  follow: 14,
  'globe-labels': 14,
  'ui-overview-tables': 12,
  'civ-vassals': 11,
  flags: 11,
  names: 11,
  'projection-labels': 11,
  'selection-outline': 11,
  'ui-panels': 11,
  'zoom-detail': 11,
  'ai-names': 10,
  'civ-religion': 10,
  'civ-swap-prep': 10,
  'court-ui': 10,
  'polity-form': 10,
  'pixel-drain': 10,
  'rules-world': 10,
  snapshot: 10,
  'civ-royals': 9,
  'terrain-edits': 9,
  'civ-detail': 8,
  'regency-ui': 8,
  'finder-ui': 7,
  seaice: 7,
  world: 7,
  plates: 6,
  'person-rename': 5,
  'stepwise-branches': 3,
  'story-strip': 3,
};

/** 不到 3 秒的文件,按 QUICK_SECONDS 算 */
const QUICK = new Set(
  `
  account-sync ai-calllog ai-client ai-providers ai-switch announcement band-labels-step beian beta-news
  civ-control-layer civ-parts civ-passes civ-state-tables civ-tables civ-wash clouds coast-chunks contact
  data-legend detail-jobs diag director-plan director-store end-year era extend-years file-name-case
  film-plan frozen-world gallery gallery-helper gen-speed geometry globe globe-lines globe-redraw
  grat-labels home-start ice-edge inland-sea inline-icons labels-layout labels-polity load-screen
  long-plan map-groups map-wrap multiset-diff nav old-site outline-store play-quality preset-link presets
  projection projection-redraw realistic-shores result-store river-shape role-store rule-set rules-store sea-lines share
  sketch-image step-branches-ui studio-planet styles-list tectonics terrain-full terrain-tools
  timeline-layout treaty-ui ui-book-search ui-mobile ui-outline-map ui-pending ui-shell ui-shortcuts
  ui-wheel ui-worlds upheaval-ui
`
    .split(/\s+/)
    .filter(Boolean),
);
const QUICK_SECONDS = 1;

/**
 * 上面两处都没有的(多半是新加的文件)按几秒算。近来新加的测试文件快的一两秒、慢的三四分钟,
 * 中间的多是二三十秒;按 30 秒算比按一两秒算离实际近。
 * 新加的文件要跑一分钟以上的,检查跑过一轮后照日志补进 SECONDS;不到 3 秒的补进 QUICK。
 */
const NEW_FILE_SECONDS = 30;
/** 每个文件另有载入代码的开销(秒) */
const LOAD_SECONDS = 1;

export class ShardSequencer implements TestSequencer {
  constructor(private readonly ctx: Vitest) {}

  /** 表里的名字:tests/ 下的路径、去掉 .test.ts */
  private name(spec: WorkspaceSpec): string {
    return relative(this.ctx.config.root, spec.moduleId)
      .replace(/\\/g, '/')
      .replace(/^tests\//, '')
      .replace(/\.test\.ts$/, '');
  }

  private seconds(spec: WorkspaceSpec): number {
    const name = this.name(spec);
    const s = SECONDS[name] ?? (QUICK.has(name) ? QUICK_SECONDS : NEW_FILE_SECONDS);
    return s + LOAD_SECONDS;
  }

  /** 从慢到快;一样慢的按名字排,哪台机器上排出来都一样 */
  private slowFirst(files: WorkspaceSpec[]): WorkspaceSpec[] {
    const keyed = files.map((spec) => ({ spec, s: this.seconds(spec), n: this.name(spec) }));
    keyed.sort((a, b) => b.s - a.s || (a.n < b.n ? -1 : a.n > b.n ? 1 : 0));
    return keyed.map((k) => k.spec);
  }

  shard(files: WorkspaceSpec[]): WorkspaceSpec[] {
    // 不分片跑时 vitest 的 resolved.shard 是 undefined(只有传 --shard 才赋值),
    // 给个 1/1 兜底:既不会解构 undefined 抛错,也保证全部文件仍归这一份。
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
    const load = new Array<number>(count).fill(0);
    const mine: WorkspaceSpec[] = [];
    for (const spec of this.slowFirst(files)) {
      let k = 0;
      for (let i = 1; i < count; i++) if (load[i] < load[k]) k = i;
      load[k] += this.seconds(spec);
      if (k === index - 1) mine.push(spec);
    }
    return mine;
  }

  sort(files: WorkspaceSpec[]): WorkspaceSpec[] {
    return this.slowFirst(files);
  }
}
