/**
 * 无头引擎门面自检(不经过 MCP 协议,直接调 engine.ts)。
 * 运行: node mcp/.build/mcp/selftest.js
 */
import { existsSync, statSync } from 'node:fs';
import {
  catalog,
  chronicleGet,
  civHash,
  createWorld,
  exportSession,
  listSessions,
  openSession,
  stateGet,
  submitOrders,
  turnStep,
} from './engine';

let pass = 0;
let fail = 0;

function ok(cond: boolean, name: string, detail?: unknown): void {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  实际:${JSON.stringify(detail)}`}`);
  }
}

interface PolityShape {
  id: number;
  key: string;
  name: string;
  size: number;
  capitalName: string;
  ruler: { name: string; born: number } | null;
}

interface StateShape {
  year: number;
  rounds: number;
  finished: boolean;
  polities: PolityShape[];
  commands: unknown[];
  fingerprint: string;
  chronicle?: { entries: { kind: string; text: string }[] };
}

interface CatalogShape {
  kinds: { kind: string }[];
  keyHelp: string;
}

function main(): void {
  console.log('== civ-atlas MCP 引擎自检 ==');
  const t0 = Date.now();

  // --- 世界 ---
  const w1 = createWorld({ seed: 7, params: { cells: 12000 } });
  const w2 = createWorld({ seed: 7, params: { cells: 12000 } });
  ok(w1.id === w2.id, '同一 seed+参数 → 同一 worldId', { a: w1.id, b: w2.id });
  ok(w1.params.cells === 12000, 'cells 覆盖生效');
  ok(w1.params.seed === 7, 'seed 覆盖生效');
  ok(w1.world.elevation.length > 1000, '世界生成成功');

  // --- 会话 ---
  const opened = openSession({ worldId: w1.id, startYear: 1200, stepYears: 3, maxRounds: 2 });
  const s = opened.session;
  ok(opened.summary.year === 1200, '会话停在起始年', opened.summary.year);
  ok(opened.summary.fingerprint === civHash(s.civ), '会话摘要指纹等于引擎指纹');

  const st = stateGet(s, { chronicle: true }) as unknown as StateShape;
  ok(st.year === 1200, '状态年份正确', st.year);
  ok(Array.isArray(st.polities) && st.polities.length > 0, '状态里有在世国家', st.polities.length);
  const top: PolityShape | undefined = st.polities[0];
  ok(!!top && top.key.startsWith('polity:'), '最大的国家有稳定键', top?.key);
  ok(!!top && typeof top.capitalName === 'string' && top.capitalName.length > 0, '国都有名字', top?.capitalName);
  ok(!!st.chronicle && st.chronicle.entries.length > 0, '附带编年史非空', st.chronicle?.entries.length);

  // --- 命令目录 ---
  const cat = catalog() as unknown as CatalogShape;
  ok(cat.kinds.length === 24, '命令目录列出 24 种干预', cat.kinds.length);
  ok(cat.keyHelp.includes('polity:'), '键格式说明可读');

  // --- 交命令 ---
  if (!top) throw new Error('没有在世国家,无法继续自检');
  const sub = submitOrders(s, [{ kind: 'policy', a: top.key, preset: 'expand' }]);
  ok(sub.commands.length === 1 && sub.rejected.length === 0, '合法命令被接收', sub);

  const badFrom = submitOrders(s, [{ kind: 'policy', a: top.key, from: 999, preset: 'expand' }]);
  ok(badFrom.rejected.length === 1 && String(badFrom.rejected[0].reason).includes('from'), 'from 不是当前年份 → 拒收');

  const badKind = submitOrders(s, [{ kind: 'nonsense' }]);
  ok(badKind.rejected.length === 1, '不认识的 kind → 拒收');

  const badType = submitOrders(s, ['not-an-object'] as unknown[]);
  ok(badType.rejected.length === 1, '非对象命令 → 拒收');

  // --- 单步推演 ---
  const turn = turnStep(s);
  ok(turn.round === 1, '回合数 +1', turn.round);
  ok(turn.fromYear === 1200 && turn.toYear === 1203, '推了 3 年', { from: turn.fromYear, to: turn.toYear });
  ok(turn.orders === 1, '本回合有 1 条命令', turn.orders);
  ok(typeof turn.fingerprint === 'string' && turn.fingerprint.length === 16, '推演后有状态指纹', turn.fingerprint);
  ok(Array.isArray(turn.events), '本回合大事是可读数组');

  const st2 = stateGet(s) as unknown as StateShape;
  ok(st2.year === 1203, '状态年份推进', st2.year);
  ok(st2.commands.length === 1, '命令历史累计 1 条', st2.commands.length);

  const chr = chronicleGet(s, { limit: 10 });
  ok(chr.total > 0 && chr.entries.length > 0, '编年史可读', { total: chr.total, got: chr.entries.length });

  // --- 确定性:同世界 += 同起始年 += 同命令 → 同指纹 ---
  const opened2 = openSession({ worldId: w1.id, startYear: 1200, stepYears: 3, maxRounds: 2 });
  const s2 = opened2.session;
  const stB = stateGet(s2) as unknown as StateShape;
  const top2 = stB.polities[0];
  const sub2 = submitOrders(s2, [{ kind: 'policy', a: top2 ? top2.key : '', preset: 'expand' }]);
  ok(sub2.rejected.length === 0, '重开会话后同一命令被接收');
  const turn2 = turnStep(s2);
  ok(turn2.fingerprint === turn.fingerprint, '同世界+同命令 → 逐位一致的状态指纹', { a: turn.fingerprint, b: turn2.fingerprint });

  // --- 回合上限 ---
  const turn3 = turnStep(s);
  ok(turn3.round === 2 && turn3.finished === true, '达到 maxRounds → finished', turn3);
  let threw = false;
  try {
    turnStep(s);
  } catch {
    threw = true;
  }
  ok(threw, '结束后再推 → 报错');

  // --- 导出 ---
  const exported = exportSession(s);
  ok(existsSync(exported.path) && statSync(exported.path).size > 1000, '会话导出文件可写', exported);

  // --- 会话表 ---
  ok(listSessions().length >= 2, '会话注册表里有多个会话', listSessions().length);

  console.log(`\n通过 ${pass} 项,失败 ${fail} 项,用时 ${Date.now() - t0} ms`);
  if (fail > 0) process.exitCode = 1;
}

main();
