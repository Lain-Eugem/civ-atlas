/**
 * 官方 `.civplugin` 加载器自检(阶段B)。
 *
 * 验的是:
 * 1) 能在 mcp 的 CommonJS 产物里装上官方推演插件(QuickJS wasm,离线);
 * 2) 插件清单/表/图层/记录都被正确读出来;
 * 3) MCP `civ_session_open` 传 `plugins` 路径能开会话,summary 里带插件 id;
 * 4) 插件真的进了引擎(civ 指纹与不带插件不同;同配置两次逐位一致;回放一致);
 * 5) 装目录(源码形式)与装 .civplugin 都行;
 * 6) 非推演插件、路径不存在、同 id 重复都有清楚的中文报错。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { civHash, createWorld, getSession, stateGet } from './engine';
import { verifySession } from './monarch';
import { callTool } from './tools';
import { loadSimPlugins } from './plugin-loader';
import type { LayerView } from './engine';

let pass = 0;
let fail = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}`);
  }
}
function eq(a: unknown, b: unknown, msg: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg}(实际 ${JSON.stringify(a)},期望 ${JSON.stringify(b)})`);
}
async function throws(p: Promise<unknown>, part: string, msg: string): Promise<void> {
  try {
    await p;
    ok(false, `${msg}(没有抛错)`);
  } catch (e) {
    const s = e instanceof Error ? e.message : String(e);
    ok(s.includes(part), `${msg}(错误:${s})`);
  }
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const magic = join('examples', 'plugins', 'magic', 'magic.civplugin');
  const koppen = join('examples', 'plugins', 'koppen', 'koppen.civplugin');
  ok(existsSync(magic), `示例插件存在:${magic}`);
  console.log(`\n== 官方 .civplugin 加载器 ==`);

  // 1) 直接装一个 .civplugin
  const one = await loadSimPlugins([magic], 7);
  try {
    eq(one.ids, ['magic'], '装上 1 个推演插件:magic');
    eq(one.records.length, 1, '世界清单记录 1 条');
    eq(one.records[0]?.id, 'magic', '记录 id = magic');
    ok(/^[0-9a-f]{8,}$/.test(one.records[0]?.sum ?? ''), '记录带 sum 指纹');
    eq(one.plugins.length, 1, '拿到 1 个 SimPlugin');
    eq(one.plugins[0]?.id, 'magic', 'SimPlugin.id = magic');
    eq((one.plugins[0]?.tables as unknown[] | undefined)?.length, 3, 'magic 有 3 张表(vein/rural/magic)');
    const layers = one.plugins[0]?.layers as { id: string; keep?: number }[] | undefined;
    eq(layers?.length, 1, 'magic 有 1 个图层');
    eq(layers?.[0]?.id, 'magic', '图层 id = magic');
    eq(layers?.[0]?.keep, 50, '图层 keep = 50');
  } finally {
    one.dispose();
  }

  // 2) 装源码目录(现场打包)
  const fromDir = await loadSimPlugins([join('examples', 'plugins', 'weariness')], 7);
  try {
    eq(fromDir.ids, ['weariness'], '从源码目录也能装(weariness)');
    ok(
      ((fromDir.plugins[0]?.influences as unknown[] | undefined) ?? []).some((i) => i === 'war.odds'),
      'weariness 带影响口(war.odds)',
    );
  } finally {
    fromDir.dispose();
  }

  // 3) 坏路径 / 非推演插件 / 重复
  await throws(loadSimPlugins(['examples/plugins/nope.civplugin'], 7), '插件路径不存在', '不存在的路径报错');
  await throws(loadSimPlugins([koppen], 7), '不是推演插件', '地图插件被拒(只装推演插件)');
  await throws(loadSimPlugins([magic, magic], 7), '给了两次', '同一个插件给两次被拒');

  // 4) 会话:不带插件 vs 带插件
  const rec = createWorld({ seed: 7, params: { cells: 12000 } });
  const base = { worldId: rec.id, startYear: 1200, stepYears: 50, maxRounds: 4, mode: 'auto' as const };
  const plainOut = await callTool('civ_session_open', base);
  const plain = JSON.parse(plainOut.content[0].text) as { sessionId: string };
  const plainSession = getSession(plain.sessionId);
  const plainHash = civHash(plainSession.civ);

  const pluginOut = await callTool('civ_session_open', { ...base, plugins: [magic] });
  ok(!pluginOut.isError, 'MCP civ_session_open 能带 plugins 开会话');
  const plug = JSON.parse(pluginOut.content[0].text) as { sessionId: string; plugins?: string[] };
  eq(plug.plugins, ['magic'], '会话 summary 带 plugins = [magic]');
  const plugSession = getSession(plug.sessionId);
  ok(civHash(plugSession.civ) !== plainHash, '装了 magic 插件后 civ 指纹与官方不同(真影响引擎)');
  const st = stateGet(plugSession) as { layers?: LayerView[] };
  ok((st.layers ?? []).some((l) => l.id === 'magic' && l.unit === 'region'), 'stateGet.layers 里有 magic 图层');

  const plugin2Out = await callTool('civ_session_open', { ...base, plugins: [magic] });
  const plug2 = JSON.parse(plugin2Out.content[0].text) as { sessionId: string };
  eq(civHash(getSession(plug2.sessionId).civ), civHash(plugSession.civ), '同插件同配置两次会话逐位一致');
  const verify = verifySession(plugSession);
  ok(verify.ok, `装插件的会话回放一致(${verify.note ?? ''})`);

  console.log(`\n共 ${pass + fail} 项:${pass} 通过,${fail} 失败,总耗时 ${Date.now() - t0}ms`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
