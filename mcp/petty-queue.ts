/**
 * 小事件裁决层 · OpenJevQueue（串行优先队列）。
 *
 * 官方 Jev 虽然可以是并发的，但任务书硬约束 B 要求“所有请求串行、单在途”，
 * 这样速率可控、账单可解释、降级顺序确定。这里实现：
 *   - 严格单在途：同一时刻最多一个任务在执行；
 *   - 优先级：P0=10（战争/灾害）> P1=20（经济/社会）> P2=30（基建/闲事），同级 FIFO；
 *   - 超时：默认 30s，P0 60s；超时 abort 并 reject（kind=timeout）；
 *   - 背压：挂起 ≥ maxPending（默认 40）时拒绝 P2 并标 throttled；P0/P1 照收；
 *   - 回合计时：从 beginRound() 起超过 roundWaitMs（默认 120s），剩余任务全降级（kind=degraded）；
 *   - 熔断：连续失败 ≥ failuresToTrip（默认 5）后 tripped=true，后续直接 reject（kind=circuit-open）；
 *     下回合开头调 probe() 成功一次后 reset()，恢复放行。
 *
 * 没有依赖；单测见 mcp/selftest-petty-queue.ts。
 */

export type PettyPriority = 0 | 1 | 2;

export type PettyQueueErrorKind = 'timeout' | 'throttled' | 'circuit-open' | 'degraded' | 'closed';

export class PettyQueueError extends Error {
  readonly kind: PettyQueueErrorKind;
  readonly priority?: PettyPriority;
  readonly label?: string;

  constructor(kind: PettyQueueErrorKind, message: string, extra: { priority?: PettyPriority; label?: string } = {}) {
    super(message);
    this.name = 'PettyQueueError';
    this.kind = kind;
    if (extra.priority !== undefined) this.priority = extra.priority;
    if (extra.label !== undefined) this.label = extra.label;
  }
}

export interface PettyQueueOptions {
  /** 挂起上限，默认 40；超过后只拒 P2 */
  maxPending?: number;
  /** 单回合等待上限，默认 120000ms；超时后剩余任务全部降级 */
  roundWaitMs?: number;
  /** 连续失败多少次熔断，默认 5 */
  failuresToTrip?: number;
  /** 测试注入时钟 */
  now?: () => number;
}

export interface PettyEnqueueOptions {
  priority: PettyPriority;
  /** 覆盖超时；默认 P0=60s，其它=30s */
  timeoutMs?: number;
  batchId?: string;
  label?: string;
}

export interface PettyQueueStats {
  /** 本轮入队数 */
  enqueued: number;
  /** 本轮完成数 */
  completed: number;
  /** 本轮失败数（不含超时） */
  failed: number;
  /** 本轮超时数 */
  timedOut: number;
  /** 本轮因背压被拒的 P2 数 */
  throttled: number;
  /** 本轮因回合超时被降级数 */
  degraded: number;
  /** 本轮最大等待（从入队到开始执行） */
  maxWaitMs: number;
  /** 本轮平均等待 */
  avgWaitMs: number;
  /** 本轮从 beginRound 到现在的毫秒数 */
  elapsedMs: number;
  /** 当前挂起（含正在执行） */
  pending: number;
  /** 当前在途数（0/1） */
  running: number;
  /** 熔断中 */
  tripped: boolean;
  /** 连续失败次数 */
  consecutiveFailures: number;
}

interface Entry {
  seq: number;
  priority: PettyPriority;
  batchId?: string;
  label?: string;
  timeoutMs: number;
  enqueuedAt: number;
  task: (signal: AbortSignal) => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const DEFAULT_TIMEOUT = 30_000;
const P0_TIMEOUT = 60_000;

const clampInt = (v: unknown, lo: number, hi: number, name: string): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} 必须是数字`);
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

export class PettyQueue {
  private readonly maxPending: number;
  private readonly roundWaitMs: number;
  private readonly failuresToTrip: number;
  private readonly now: () => number;

  private readonly buckets: Entry[][] = [[], [], []];
  private seq = 0;
  private running = 0;
  private pending = 0;
  private tripped = false;
  private consecutiveFailures = 0;
  private roundStart: number;

  private enqueued = 0;
  private completed = 0;
  private failed = 0;
  private timedOut = 0;
  private throttled = 0;
  private degraded = 0;
  private waitSumMs = 0;
  private maxWaitMs = 0;
  private closed = false;

  constructor(opts: PettyQueueOptions = {}) {
    this.maxPending = clampInt(opts.maxPending ?? 40, 1, 10_000, 'maxPending');
    this.roundWaitMs = clampInt(opts.roundWaitMs ?? 120_000, 100, 3_600_000, 'roundWaitMs');
    this.failuresToTrip = clampInt(opts.failuresToTrip ?? 5, 1, 1_000, 'failuresToTrip');
    this.now = opts.now ?? (() => Date.now());
    this.roundStart = this.now();
  }

  /** 新回合开始：清本轮统计与回合计时（熔断状态保留，等 probe/reset） */
  beginRound(): void {
    this.roundStart = this.now();
    this.enqueued = 0;
    this.completed = 0;
    this.failed = 0;
    this.timedOut = 0;
    this.throttled = 0;
    this.degraded = 0;
    this.waitSumMs = 0;
    this.maxWaitMs = 0;
  }

  /** 熔断后探活成功：清熔断与连续失败计数 */
  reset(): void {
    this.tripped = false;
    this.consecutiveFailures = 0;
  }

  /** 立即熔断（供外部探活失败时调用） */
  trip(): void {
    this.tripped = true;
  }

  get isTripped(): boolean {
    return this.tripped;
  }

  get stats(): PettyQueueStats {
    return {
      enqueued: this.enqueued,
      completed: this.completed,
      failed: this.failed,
      timedOut: this.timedOut,
      throttled: this.throttled,
      degraded: this.degraded,
      maxWaitMs: this.maxWaitMs,
      avgWaitMs: this.completed ? Math.round(this.waitSumMs / this.completed) : 0,
      elapsedMs: this.now() - this.roundStart,
      pending: this.pending,
      running: this.running,
      tripped: this.tripped,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /**
   * 入队一个任务。返回的 Promise 在任务完成时 resolve；
   * 被拒（超时/背压/熔断/回合超时/关闭）时 reject：PettyQueueError（任务自身的错原样 reject）。
   */
  enqueue<T>(task: (signal: AbortSignal) => Promise<T>, opts: PettyEnqueueOptions): Promise<T> {
    if (this.closed) {
      return Promise.reject(new PettyQueueError('closed', '队列已关闭', { priority: opts.priority, label: opts.label }));
    }
    if (this.tripped) {
      return Promise.reject(
        new PettyQueueError('circuit-open', '连续失败已熔断；下回合探活成功前全部走引擎降级', {
          priority: opts.priority,
          label: opts.label,
        }),
      );
    }
    if (this.now() - this.roundStart > this.roundWaitMs) {
      this.degraded++;
      return Promise.reject(
        new PettyQueueError('degraded', `本回合已等待超过 ${this.roundWaitMs}ms，剩余小事件走引擎规则`, {
          priority: opts.priority,
          label: opts.label,
        }),
      );
    }
    if (this.pending >= this.maxPending && opts.priority === 2) {
      this.throttled++;
      return Promise.reject(
        new PettyQueueError('throttled', `挂起 ${this.pending} 条（上限 ${this.maxPending}），P2 暂停入队`, {
          priority: opts.priority,
          label: opts.label,
        }),
      );
    }

    this.enqueued++;
    const entry: Entry = {
      seq: this.seq++,
      priority: opts.priority,
      timeoutMs: opts.timeoutMs ?? (opts.priority === 0 ? P0_TIMEOUT : DEFAULT_TIMEOUT),
      enqueuedAt: this.now(),
      task,
      resolve: () => undefined,
      reject: () => undefined,
    };
    if (opts.batchId !== undefined) entry.batchId = opts.batchId;
    if (opts.label !== undefined) entry.label = opts.label;
    const proc = new Promise<T>((resolve, reject) => {
      entry.resolve = resolve as (v: unknown) => void;
      entry.reject = reject;
    });
    this.buckets[opts.priority].push(entry);
    this.pending++;
    void this.pump();
    return proc;
  }

  /** 关闭队列：挂起的任务全部以 closed 拒绝（正在执行的不打断） */
  close(): void {
    this.closed = true;
    for (const bucket of this.buckets) {
      for (const e of bucket.splice(0)) {
        this.pending--;
        e.reject(new PettyQueueError('closed', '队列已关闭', { priority: e.priority, label: e.label }));
      }
    }
  }

  private next(): Entry | null {
    for (const priority of [0, 1, 2] as const) {
      const bucket = this.buckets[priority];
      if (bucket.length) {
        return bucket.shift()!;
      }
    }
    return null;
  }

  private async pump(): Promise<void> {
    if (this.running || this.closed) return;
    this.running = 1;
    try {
      for (;;) {
        if (this.closed) break;
        // 回合等待超时：剩余全部降级
        if (this.now() - this.roundStart > this.roundWaitMs) {
          let e = this.next();
          while (e) {
            this.degraded++;
            this.pending--;
            e.reject(new PettyQueueError('degraded', `本回合已等待超过 ${this.roundWaitMs}ms，剩余小事件走引擎规则`, { priority: e.priority, label: e.label }));
            e = this.next();
          }
          break;
        }
        // 熔断：停止执行，剩余拒绝
        if (this.tripped) {
          let e = this.next();
          while (e) {
            this.pending--;
            e.reject(new PettyQueueError('circuit-open', '连续失败已熔断；剩余小事件走引擎降级', { priority: e.priority, label: e.label }));
            e = this.next();
          }
          break;
        }
        const e = this.next();
        if (!e) break;
        const wait = this.now() - e.enqueuedAt;
        this.waitSumMs += wait;
        if (wait > this.maxWaitMs) this.maxWaitMs = wait;

        const ctrl = new AbortController();
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await new Promise<unknown>((resolve, reject) => {
            const done = (ok: boolean, v: unknown) => {
              if (settled) return;
              settled = true;
              if (timer !== undefined) clearTimeout(timer);
              ok ? resolve(v) : reject(v);
            };
            timer = setTimeout(() => {
              ctrl.abort();
              done(false, new PettyQueueError('timeout', `小事件请求超时（${e.timeoutMs}ms）`, { priority: e.priority, label: e.label }));
            }, e.timeoutMs);
            e.task(ctrl.signal).then(
              (v) => done(true, v),
              (err) => done(false, err),
            );
          });
          this.completed++;
          this.consecutiveFailures = 0;
          e.resolve(result);
        } catch (err) {
          if (err instanceof PettyQueueError && err.kind === 'timeout') this.timedOut++;
          else this.failed++;
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= this.failuresToTrip) this.tripped = true;
          e.reject(err);
        } finally {
          this.pending--;
          if (timer !== undefined) clearTimeout(timer);
        }
      }
    } finally {
      this.running = 0;
    }
  }
}
