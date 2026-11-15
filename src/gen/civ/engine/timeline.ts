/**
 * 时间轴查询:任意年份各州归属谁(最近的检查点 + 往后补变化日志)。900 个州,不到 1 毫秒。
 *
 * 约定:某一年的归属 = 日志里年份 ≤ 这一年的变化全部生效之后的样子。
 * 检查点 year = Y 存的也是这个状态(Y 年及以前的变化都已生效)。
 */
import { Layer, type ChangeLog, type Civ, type OwnersAt, type Year } from '../types';

export interface Owners {
  culture: Int16Array;
  polity: Int16Array;
}

/** 日志里第一条年份 > year 的下标(日志按年份排好序) */
export function logIndexAfter(log: ChangeLog, year: Year): number {
  let lo = 0;
  let hi = log.size;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (log.year[mid] <= year) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 任意年份的归属。out 可复用,避免每帧分配 */
export const ownersAt: OwnersAt = (civ: Civ, year: Year, out?: Owners): Owners => {
  const R = civ.regions.count;
  if (!out || out.culture.length !== R || out.polity.length !== R) {
    out = { culture: new Int16Array(R), polity: new Int16Array(R) };
  }
  // 最近的、不晚于 year 的检查点(检查点按年份递增)
  const cps = civ.checkpoints;
  let lo = 0;
  let hi = cps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cps[mid].year <= year) lo = mid + 1;
    else hi = mid;
  }
  const cp = lo > 0 ? cps[lo - 1] : null;
  let from = 0;
  if (cp) {
    // 地形大事以前那一段的州比检查点少(大事里新划出的州排在后面,那时还不存在):只取前面这些。
    // 检查点没盖到的尾部州先清成无主(-1),和 ownersFromScratch 逐位一致:否则新建 out 的全 0、
    // 或复用 out 时上一次查询留下的旧值,会被当成"这一州有主/有文化",尾部归属就错了
    out.culture.fill(-1);
    out.polity.fill(-1);
    out.culture.set(cp.culture.length > R ? cp.culture.subarray(0, R) : cp.culture);
    out.polity.set(cp.polity.length > R ? cp.polity.subarray(0, R) : cp.polity);
    from = logIndexAfter(civ.log, cp.year);
  } else {
    out.culture.fill(-1);
    out.polity.fill(-1);
  }
  applyLog(civ.log, from, year, out);
  return out;
};

/** 从头翻日志(不用检查点)。测试用来核对 ownersAt */
export function ownersFromScratch(civ: Civ, year: Year): Owners {
  const R = civ.regions.count;
  const out = { culture: new Int16Array(R).fill(-1), polity: new Int16Array(R).fill(-1) };
  applyLog(civ.log, 0, year, out);
  return out;
}

function applyLog(log: ChangeLog, from: number, year: Year, out: Owners) {
  const { region, layer, value } = log;
  for (let i = from; i < log.size && log.year[i] <= year; i++) {
    if (layer[i] === Layer.Culture) out.culture[region[i]] = value[i];
    else out.polity[region[i]] = value[i];
  }
}

/**
 * 最近 span 年里(year − span, year] 某一层归属变过的州:写入 out[州] = 变化的年份,其余为 −Infinity。
 * 回放时给新占的州做颜色渐入用。
 */
export function recentChanges(civ: Civ, layer: Layer, year: Year, span: number, out: Float32Array): Float32Array {
  out.fill(-Infinity);
  const log = civ.log;
  const end = logIndexAfter(log, year);
  for (let i = logIndexAfter(log, year - span); i < end; i++) {
    if (log.layer[i] === layer) out[log.region[i]] = log.year[i];
  }
  return out;
}
