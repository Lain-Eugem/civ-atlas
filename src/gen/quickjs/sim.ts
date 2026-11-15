/**
 * 推演插件关进 QuickJS 跑:插件代码(源码)在 QuickJS 里,推演照旧在推演线程里同步推;每到插件那一刻,
 * 把这一回合递进去、调插件的 act、把回话拿回来交给引擎(引擎照旧核对)。
 * 这个文件连同 QuickJS 只经 import() 取,世界没用推演插件就不下载。
 */
import type { QuickJSHandle, QuickJSRuntime } from 'quickjs-emscripten-core';
import { PLUGIN_TIME, PluginError, type PluginReply, type PluginTurn, type SimPlugin } from '../civ/engine/plugin';
import { keyed, keyed4, subSeed } from '../civ/engine/rand';
import type { SimRead } from '../civ/simRead';
import { Box, LOG_MAX, logText, newRuntime, type QuickJSLimits } from './box';
import { SIM_SHIM } from './shim';
import { toWire, type Wire } from './wire';

export type { QuickJSLimits } from './box';

/** 清单 sim 段给的设定(和 SimPlugin 一一对上) */
export type SimSetup = Pick<SimPlugin, 'every' | 'tables' | 'inputs' | 'listen' | 'layers' | 'influences'>;

export interface QuickJSPluginSpec {
  id: string;
  /** 插件代码(普通脚本,里面调 civAtlas.sim({ act }) 登记) */
  code: string;
  setup?: SimSetup;
  /** 滑条拨到几(插件里是只读的 civAtlas.params) */
  params?: Readonly<Record<string, number>>;
  /** 文明种子(和推演用的同一个:turn.rand 照它在 QuickJS 里算) */
  seed: number;
  limits?: Partial<QuickJSLimits>;
  /** 插件里 console.log 这几样交到这里(year = 那一回合的年份,装插件时 = null);不给 = 什么都不做。不影响推出来的历史 */
  log?: (method: string, text: string, year: number | null) => void;
}

export const QUICKJS_LIMITS: QuickJSLimits = { memory: 64 * 1024 * 1024, moment: PLUGIN_TIME.moment, stack: 64 * 1024 };

export interface QuickJSPlugin extends SimPlugin<SimRead> {
  /** 放掉 QuickJS(用完一段推演就放) */
  dispose(): void;
}

/**
 * 装好一个插件。一个插件一份 QuickJS(各自的 wasm 内存,用到上限就报「内存用完」,出了事只坏它自己);
 * 往回推(这一回合的年份比上一回合早:地形大事以后那一段从头接着推)换一个新环境、重跑插件代码,插件的全局变量不带过去
 */
export async function quickjsPlugin(wasm: WebAssembly.Module, spec: QuickJSPluginSpec): Promise<QuickJSPlugin> {
  const limits = { ...QUICKJS_LIMITS, ...spec.limits };
  const box = new SimBox(spec, limits, await newRuntime(wasm, limits));
  try {
    box.open();
  } catch (e) {
    box.dispose();
    throw e;
  }
  const { id } = spec;
  return {
    id,
    ...spec.setup,
    act: (turn) => box.act(turn),
    dispose: () => box.dispose(),
  };
}

/** 一个推演插件的 QuickJS:运行时一直用这一个,环境(全局变量)按段换 */
class SimBox extends Box {
  private readonly id: string;
  private readonly base: number;
  private actFn: QuickJSHandle | null = null;
  private lastYear = -Infinity;
  private checked = false;
  /** 这一回合(只在 act 里有) */
  private cur: PluginTurn<SimRead> | null = null;
  /** 这一回合里读过的(同样的读口、同样的参数只算一次) */
  private readonly cache = new Map<string, Wire>();

  constructor(
    private readonly spec: QuickJSPluginSpec,
    limits: QuickJSLimits,
    rt: QuickJSRuntime,
  ) {
    super(limits, rt, '推演线程');
    this.id = spec.id;
    this.base = subSeed(spec.seed, `plugin:${spec.id}`);
  }

  protected fail(what: string): PluginError {
    return new PluginError(this.id, what);
  }

  protected ours(e: unknown): boolean {
    return e instanceof PluginError;
  }

  /** 开一个新环境:我们那一层 → 插件代码 → 查登记了没有 */
  open(): void {
    this.close();
    this.guard(() => {
      const vm = this.newContext();
      const host = vm.newFunction('host', (...args) => this.host(args));
      const base = vm.newNumber(this.base);
      const params = vm.newString(JSON.stringify(this.spec.params ?? {}));
      const shim = vm.unwrapResult(vm.evalCode(SIM_SHIM, 'civ-atlas-shim.js'));
      const made = vm.callFunction(shim, vm.undefined, host, base, params, this.spec.log ? vm.true : vm.false);
      [shim, host, base, params].forEach((h) => h.dispose());
      const pair = vm.unwrapResult(made);
      this.actFn = vm.getProp(pair, 0);
      const ready = vm.getProp(pair, 1);
      pair.dispose();
      try {
        const ran = this.timed(() => vm.evalCode(this.spec.code, 'main.js', { type: 'global' }));
        if (ran.error) throw this.escaped(ran.error, '插件代码');
        ran.value.dispose();
        const ok = this.timed(() => vm.callFunction(ready, vm.undefined));
        if (ok.error) throw this.escaped(ok.error, '插件代码');
        ok.value.dispose();
      } finally {
        ready.dispose();
      }
    });
  }

  protected close(): void {
    if (!this.dead) {
      this.actFn?.dispose();
      this.actFn = null;
    }
    super.close();
  }

  /** 插件在 QuickJS 里调读口、turn.table / turn.influence */
  private host(args: QuickJSHandle[]): QuickJSHandle {
    const vm = this.vm!;
    const kind = vm.getNumber(args[0]);
    const name = vm.getString(args[1]);
    const rest = args.slice(2).map((h) => vm.dump(h) as unknown);
    if (kind === 2) {
      this.spec.log?.(name, rest.map(logText).join(' ').slice(0, LOG_MAX), this.cur ? this.cur.year : null);
      return vm.undefined;
    }
    let w: Wire;
    try {
      const t = this.cur;
      if (!t) throw new Error('这时候没有回合');
      const self = (kind === 0 ? t.read : t) as unknown as Record<string, unknown>;
      const fn = Object.prototype.hasOwnProperty.call(self, name) ? self[name] : undefined;
      if (typeof fn !== 'function' || name === 'rand') throw new Error(`没有 ${name}`);
      // 参数照递数据的写法记:-0、±Infinity、NaN、undefined 各是各的
      const args = toWire(rest);
      // 类型化数组的内容只在 bufs 里,text/patches 光记它的位置和类型:拿 text/patches 当缓存键,
      // 内容不同、类型长度却一样的两块数组会撞成同一个键、读到别人那一次的结果。按内容区分代价太高,
      // 带字节的参数干脆不进这一回合的缓存,每次照实参现算(既有读口参数都是标量,这一支平时不走)
      const cacheable = args.bufs.length === 0;
      const key = `${kind}:${name}:${args.text}:${args.patches}`;
      let hit = cacheable ? this.cache.get(key) : undefined;
      if (!hit) {
        hit = toWire(Reflect.apply(fn, self, rest));
        if (cacheable) this.cache.set(key, hit);
      }
      w = hit;
    } catch (e) {
      return this.hostError(e);
    }
    return this.put(w);
  }

  /** 这一回合递进去的:回合里的数据、方法名、读口的键;rand 在 QuickJS 里算 */
  private header(turn: PluginTurn<SimRead>): Wire {
    const t = turn as unknown as Record<string, unknown>;
    const read = turn.read as unknown as Record<string, unknown>;
    const split = (o: Record<string, unknown>, skip: readonly string[]) => {
      const d: Record<string, unknown> = {};
      const f: string[] = [];
      for (const k of Object.keys(o)) {
        if (skip.includes(k)) continue;
        const v = o[k];
        if (typeof v === 'function') f.push(k);
        else d[k] = v;
      }
      return { d, f };
    };
    const own = split(t, ['read', 'rand']);
    const r = split(read, []);
    return toWire({ k: Object.keys(t), d: own.d, f: own.f, rk: Object.keys(read), rd: r.d, rf: r.f });
  }

  act(turn: PluginTurn<SimRead>): PluginReply | undefined {
    if (this.dead) throw this.dead;
    if (turn.year < this.lastYear) this.open();
    this.lastYear = turn.year;
    if (!this.checked) {
      if (turn.rand(3, 5, 7) !== keyed(this.base, 3, 5, 7) || turn.rand(3, 5, 7, 11) !== keyed4(this.base, 3, 5, 7, 11)) throw this.fail('随机数的种子和推演的对不上');
      this.checked = true;
    }
    this.cur = turn;
    this.cache.clear();
    this.thrown.length = 0;
    try {
      const out = this.guard(() => {
        const vm = this.vm!;
        const w = this.header(turn);
        return this.invoke(this.actFn!, [vm.newString(w.text), vm.newString(w.patches), ...w.bufs.map((b) => vm.newArrayBuffer(b))], `第 ${turn.year} 年这一刻`);
      });
      if ('rethrow' in out) throw out.rethrow;
      return out.reply as PluginReply | undefined;
    } finally {
      this.cur = null;
      this.thrown.length = 0;
    }
  }
}
