/**
 * 官方 `.civplugin`(推演插件)加载器——阶段B。
 *
 * mcp 的产物是 CommonJS,不能复用 `scripts/lib/quickjsNode.ts`(里面用 import.meta),
 * 这里用 `createRequire(__filename)` 解析 wasm,其余直接复用网页那套:
 * `openPluginFileFully` 读清单/代码 → `simPluginsOn` 装成原生 `SimPlugin[]`。
 *
 * 用法:给一个或多个 `.civplugin` 文件路径(或插件目录),装好交给会话。
 * 只在服务端内存里跑,不联网、不写世界文件(世界清单里只记 id/sum)。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { quickjsPlugin } from '../src/gen/quickjs/sim';
import type { SimPlugin } from '../src/gen/civ/engine/plugin';
import type { SimRead } from '../src/gen/civ/simRead';
import { openPluginFileFully } from '../src/plugin/pluginSimTables';
import type { SimPluginFile } from '../src/plugin/pluginWorld';
import { simPluginsOn, type SimBoxer } from '../src/simPluginRun';
import { packPluginDir } from '../scripts/lib/pluginDir';

/** 一次装上的推演插件;dispose 由会话持有,进程退出前调用 */
export interface LoadedSimPlugins {
  ids: string[];
  records: { id: string; sum: string }[];
  plugins: SimPlugin<SimRead>[];
  dispose(): void;
}

const requireHere = createRequire(__filename);
let wasmModule: WebAssembly.Module | null = null;

/** QuickJS wasm 只编译一次(每个插件运行时各自实例化,见 src/gen/quickjs/sim.ts) */
function wasm(): WebAssembly.Module {
  if (!wasmModule) {
    const path = requireHere.resolve('@jitl/quickjs-wasmfile-release-sync/wasm');
    wasmModule = new WebAssembly.Module(readFileSync(path));
  }
  return wasmModule;
}

const box: SimBoxer = (spec) => quickjsPlugin(wasm(), spec);

async function fileOf(path: string, params?: Readonly<Record<string, number>>): Promise<SimPluginFile> {
  if (!existsSync(path)) throw new Error(`插件路径不存在:${path}`);
  const st = statSync(path);
  const bytes = st.isDirectory() ? (await packPluginDir(path)).bytes : new Uint8Array(readFileSync(path));
  const opened = await openPluginFileFully(bytes);
  const manifest = opened.manifest;
  if (manifest.role !== 'sim' || !manifest.sim) {
    throw new Error(`「${manifest.name}」${manifest.id} 不是推演插件(role=${manifest.role});这个会话只装推演插件`);
  }
  return { id: manifest.id, sum: opened.sum, bytes, ...(params ? { params } : {}) };
}

/**
 * 装上 1–4 个官方推演插件。
 * @param paths `.civplugin` 文件或插件目录(相对/绝对都行;相对路径按当前工作目录解析)
 * @param seed 推演种子(世界种子;和网页里一样,同一 seed 同插件逐位一致)
 * @param params 可选:插件清单里声明的参数覆盖(名字→数),没写的用清单默认
 */
export async function loadSimPlugins(
  paths: readonly string[],
  seed: number,
  params?: Readonly<Record<string, number>>,
): Promise<LoadedSimPlugins> {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('plugins 要至少给一个 .civplugin 路径');
  if (paths.length > 4) throw new Error('plugins 最多 4 个(和自定义场加起来别太多)');
  const files: SimPluginFile[] = [];
  const seen = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('plugins 里每一项都要是路径字符串');
    const file = await fileOf(raw.trim(), params);
    if (seen.has(file.id)) throw new Error(`推演插件 ${file.id} 给了两次`);
    seen.add(file.id);
    files.push(file);
  }
  const on = await simPluginsOn(files, seed, box);
  return {
    ids: files.map((f) => f.id),
    records: on.records.map((r) => ({ id: r.id, sum: r.sum })),
    plugins: on.plugins,
    dispose: on.dispose,
  };
}

/** 给 MCP 工具描述用的一行示例 */
export const PLUGIN_PATH_EXAMPLE = join('examples', 'plugins', 'magic', 'magic.civplugin');
