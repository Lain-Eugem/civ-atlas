# 验收：P2 疆域连续点选（2026-11-14）

对应 plan.md §P2。目标：开局时在地图上连续点选疆域（点国家→高亮全部州并就近飞首都；点州增删；退出/ESC 清空），提交 `regionIds`。

## 实现
- 服务端 `mcp/monarch-start.ts`：`applyCustomStart` 支持 `regionIds`（优先于 size/at，严格校验非数组/非整数/越界/空数组并带州号，重复去重）。
  - 已有国：精确集合——未选州转无主；首都州被删→随机迁都；被拿空的国家 `endNation` 清理战争/条约/卡/控制。
  - 新建国：按所选州建国，无主+有主混合合法，预验证国都、接管 warning。
  - `StartNationSpec.regionIds` 让 `/api/session/start-setup` 的 nations[] 也支持；`/api/session/custom-start` 透传。
- `mcp/viewer.ts`：`/api/map/region-atlas` 响应增加 `owner:number[]`（州→国 id，-1 无主）。
- `mcp/viewer/region-atlas.js`：解析 owner，暴露 `ownerOf/regionsOf/snapshot`。
- 新增 `mcp/viewer/region-picker.js`：独立 canvas 覆盖层（不改 app.js 渲染）；点国家→高亮全部州 + `CivMap.flyTo` 首都居中（跨 180° 就近镜像）；点州青色选中/取消；ESC/「退出选疆域」清空；capture 阶段吃掉点击避免触发地图选国，并用 `pointercancel` 清理 app.js 拖动状态。
- `mcp/viewer/app.js`（Lead 加）：`window.CivMap = {flyTo,stop,view,worldToScreen,screenToWorld}` 平滑飞行（smoothstep，k 夹 [fit,12×fit]，t clamp）。
- `mcp/viewer/start-custom.js`：② 改为「在地图上选疆域」，已选 N 州 chips（单删/清空）、国家下拉与地图点选双向同步、`collect()` 有选中时发 `regionIds`（不再发 size/at）。
- `mcp/viewer/index.html`：app.js 前挂 region-picker.js。

## 验证
- Node 单测 48/48（优先、非法输入、混合无主/有主、受害国灭亡清理、start-setup nations.regionIds、listStartNations+stateGet 一致）。
- `mcp/build.ps1` exit 0；root `tsc --noEmit` 0；`selftest` 31/31、`selftest-coast` 18/18、`selftest-tile-field` 30/30；`node --check` 3 个 js 0。
- Playwright（5191 新 build，session s-mwga4xa8-j，seed7/cells34043）：高亮渠支皇朝 150 州 → 选 3 州 `[221,345,492]` → 应用 200 `{polityId:44, regions:3}`，首都州被删→迁都赤峡堡；state fingerprint `c05b403c41b5e21e`。
- 跨 180°：镜头放缝线另一侧（与首都平面距离 1800 世界像素），实际飞 248 世界像素近路，落点 mirrorDist=0，t0/t1 两帧同区域不横穿。

## 已知限制
1. region-picker 依赖 capture 阶段先于 app.js bubble，并用 stopPropagation+pointercancel 兜底；若改 app.js 拖动/pointercancel 需同步检查。
2. `regionIds` 只在第一回合前可应用，重复应用报错（沿用 P1）。
3. 单测为临时 esbuild 脚本（已删），未落 selftest 文件；需要持久化回归可再补。