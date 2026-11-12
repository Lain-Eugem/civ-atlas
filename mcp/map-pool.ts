/**
 * 地图渲染池:每个世界懒创建 2 个 worker_threads(把世界 clone 进去一次),
 * base 与瓦片渲染在池里跑,主线程只做 PNG 编码/回包。池坏了就整体回退单进程渲染。
 *
 * 世界对象约 6MB(v8.serialize 实测),spawn 时 structuredClone 一次,之后零拷贝;
 * 2 个线程是为了把「同时 6 块瓦片」摊开,同时尽量少抢本机 CPU(拖动/打字时让路)。
 */
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { World } from '../src/gen/world';
import type { MapWorkerReply, MapWorkerRequest } from './map-worker';

export interface MapRenderResult {
  width: number;
  height: number;
  rgba: Uint8Array;
  sea?: number[][];
  lake?: number[][];
  ms: number;
  via: 'worker';
}

type PoolJob = {
  req: Omit<MapWorkerRequest, 'seq'>;
  resolve: (r: MapRenderResult) => void;
  reject: (e: Error) => void;
  seq: number;
};

const POOL_SIZE = 2;
const JOB_TIMEOUT_MS = 10_000;
const MAX_POOLS = 2;

class WorldPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private busy = new Map<number, { job: PoolJob; worker: Worker; timer: NodeJS.Timeout }>();
  private queue: PoolJob[] = [];
  private seq = 0;
  private disposed = false;
  broken = false;

  constructor(private readonly world: World) {
    for (let i = 0; i < POOL_SIZE; i++) this.spawn();
  }

  private spawn(): void {
    if (this.disposed || this.broken) return;
    try {
      const worker = new Worker(join(__dirname, 'map-worker.js'), { workerData: { world: this.world } });
      worker.on('message', (m: MapWorkerReply) => this.onMessage(worker, m));
      worker.on('error', (e: Error) => this.onFailure(e));
      worker.on('exit', (code) => {
        if (!this.disposed && !this.broken && code !== 0) this.onFailure(new Error(`渲染 worker 退出 ${String(code)}`));
      });
      this.workers.push(worker);
      this.idle.push(worker);
    } catch (e) {
      this.onFailure(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private onMessage(worker: Worker, m: MapWorkerReply): void {
    const slot = this.busy.get(m.seq);
    if (!slot) return;
    clearTimeout(slot.timer);
    this.busy.delete(m.seq);
    if (m.ok) {
      this.idle.push(worker);
      slot.job.resolve({
        width: m.width ?? 0,
        height: m.height ?? 0,
        rgba: new Uint8Array(m.rgba ?? new ArrayBuffer(0)),
        sea: m.sea,
        lake: m.lake,
        ms: m.ms ?? 0,
        via: 'worker',
      });
    } else {
      this.idle.push(worker);
      slot.job.reject(new Error(m.error ?? 'worker 渲染失败'));
    }
    this.pump();
  }

  private onFailure(e: Error): void {
    if (this.broken) return;
    this.broken = true;
    process.stderr.write(`[map-pool] ${e.message};回退主线程渲染\n`);
    for (const [seq, slot] of [...this.busy]) {
      clearTimeout(slot.timer);
      slot.job.reject(e);
      this.busy.delete(seq);
    }
    for (const job of this.queue) job.reject(e);
    this.queue.length = 0;
    this.dispose();
  }

  private pump(): void {
    while (!this.broken && !this.disposed && this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const job = this.queue.shift()!;
      job.seq = ++this.seq;
      const timer = setTimeout(() => {
        this.busy.delete(job.seq);
        this.idle = this.idle.filter((w) => w !== worker);
        worker.terminate().catch(() => undefined);
        job.reject(new Error('渲染超时'));
        this.spawn();
        this.pump();
      }, JOB_TIMEOUT_MS);
      this.busy.set(job.seq, { job, worker, timer });
      worker.postMessage({ ...job.req, seq: job.seq });
    }
  }

  run(req: Omit<MapWorkerRequest, 'seq'>): Promise<MapRenderResult> {
    if (this.broken || this.disposed) return Promise.reject(new Error('渲染池已停用'));
    return new Promise<MapRenderResult>((resolve, reject) => {
      const job: PoolJob = { req, resolve, reject, seq: 0 };
      this.queue.push(job);
      this.pump();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const worker of this.workers) worker.terminate().catch(() => undefined);
    this.workers.length = 0;
    this.idle.length = 0;
  }
}

const pools = new Map<string, WorldPool>();

function poolFor(worldId: string, world: World): WorldPool | null {
  const hit = pools.get(worldId);
  if (hit && !hit.broken) return hit;
  if (pools.size >= MAX_POOLS) {
    const oldest = pools.keys().next().value;
    if (oldest !== undefined) {
      pools.get(oldest)?.dispose();
      pools.delete(oldest);
    }
  }
  try {
    const pool = new WorldPool(world);
    pools.set(worldId, pool);
    process.stderr.write(`[map-pool] 世界 ${worldId} 的渲染池已启动(${POOL_SIZE} 个线程)\n`);
    return pool;
  } catch (e) {
    process.stderr.write(`[map-pool] 创建失败:${e instanceof Error ? e.message : String(e)}\n`);
    return null;
  }
}

/** 优先用 worker 池渲染;池不可用或超时返回 null,由调用方回退主线程渲染。 */
export async function renderViaPool(
  worldId: string,
  world: World,
  req: Omit<MapWorkerRequest, 'seq'>,
): Promise<MapRenderResult | null> {
  const pool = poolFor(worldId, world);
  if (!pool) return null;
  try {
    return await pool.run(req);
  } catch (e) {
    process.stderr.write(`[map-pool] ${e instanceof Error ? e.message : String(e)};本次回退主线程\n`);
    return null;
  }
}

export function disposeMapPools(): void {
  for (const pool of pools.values()) pool.dispose();
  pools.clear();
}
