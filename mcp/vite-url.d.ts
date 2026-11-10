/**
 * 让 mcp 的 CommonJS 构建认得 Vite 的 `?url` 导入。
 *
 * `src/simPluginRun.ts` 的 `quickjsBox` 里有 `await import('./gen/quickjs')`,而
 * `src/gen/quickjs/index.ts` 又导出 `quickjsWasm`(`src/gen/quickjs/wasm.ts` 里是
 * `import wasmUrl from '@jitl/quickjs-wasmfile-release-sync/wasm?url'`)。
 * mcp 走 `mcp/plugin-loader.ts` 那条路(自己用 WebAssembly.Module 装 wasm),
 * 永不调用 quickjsBox,所以这里只需给类型一个声明,让 tsc 不展开时也通过;
 * 产物里这段只在 quickjsBox 里,不会被 mcp 执行。
 */
declare module '*?url' {
  const url: string;
  export default url;
}
