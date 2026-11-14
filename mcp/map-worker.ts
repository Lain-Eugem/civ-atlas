/**
 * 地图渲染 worker:viewer 主进程把世界对象一次性 clone 进来,之后只按消息渲染。
 * 世界里只有普通对象与 TypedArray,不碰 HTTP/文件,适合丢进 worker_threads。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { renderTile, renderWhole, type TerrainStyle } from './terrain';
import { renderOwnerTilePixels, type OwnerCivData } from './owner-map';
import type { World } from '../src/gen/world';

export interface MapWorkerRequest {
  seq: number;
  kind: 'whole' | 'tile' | 'owner';
  /** kind = 'owner' 时不用画法(疆域只有手绘风一套) */
  style?: TerrainStyle;
  S?: number;
  x?: number;
  y?: number;
  size?: number;
  /** kind = 'owner' 时要带的疆域数据(三个 TypedArray,结构化克隆约 50KB) */
  civ?: OwnerCivData;
}

export interface MapWorkerReply {
  seq: number;
  ok: boolean;
  width?: number;
  height?: number;
  rgba?: ArrayBuffer;
  sea?: number[][];
  lake?: number[][];
  ms?: number;
  error?: string;
}

const world = (workerData as { world?: World } | undefined)?.world;

parentPort?.on('message', (req: MapWorkerRequest) => {
  const t0 = Date.now();
  try {
    if (!world) throw new Error('worker 没有拿到世界');
    if (req.kind === 'whole') {
      const map = renderWhole(world, req.style ?? 'fantasy');
      parentPort!.postMessage(
        { seq: req.seq, ok: true, width: map.width, height: map.height, ms: Date.now() - t0, rgba: map.rgba.buffer },
        [map.rgba.buffer],
      );
      return;
    }
    if (req.kind === 'owner') {
      if (!req.civ) throw new Error('疆域瓦片缺 civ 数据');
      const map = renderOwnerTilePixels(world, req.civ, req.S ?? 1, req.x ?? 0, req.y ?? 0, req.size ?? 512);
      parentPort!.postMessage(
        { seq: req.seq, ok: true, width: map.width, height: map.height, ms: Date.now() - t0, rgba: map.rgba.buffer },
        [map.rgba.buffer],
      );
      return;
    }
    const map = renderTile(world, req.style ?? 'fantasy', req.S ?? 1, req.x ?? 0, req.y ?? 0, req.size ?? 512);
    parentPort!.postMessage(
      {
        seq: req.seq,
        ok: true,
        width: map.width,
        height: map.height,
        sea: map.sea,
        lake: map.lake,
        ms: Date.now() - t0,
        rgba: map.rgba.buffer,
      },
      [map.rgba.buffer],
    );
  } catch (e) {
    parentPort?.postMessage({ seq: req.seq, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
