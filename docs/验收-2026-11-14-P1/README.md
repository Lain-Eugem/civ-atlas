# 验收 · P1 国家数量 / 控制方式 / 开局增删（2026-11-14）

需求来源：用户 m04171 第③项「国家生成数量可自定义、可指定哪些国家 AI 操控哪些程序操控、可自由增删国家」；删国规则按用户 m04210 决策④。

## 实现
- `mcp/engine.ts`：`openSession({ setup })`（count / nations / remove / removeRegions / controls / force）；`Session.nationControl: Map<polityId, 'ai'|'program'>`、`startSetup/pendingStartSetup`；`sessionSummary`/`stateGet`/`stateView` 暴露控制方式与开局状态；开局设置待应用时 `turnStep` 拒绝推演。
- `mcp/monarch-start.ts`：`StartSetupInput/State/Result`、`canSetupStart`、`startConfigStatus`、`applyStartSetup`。
  - 删国：该国州全部转无主（`civ.polity=-1`）；首都州被删→按哈希随机迁都（`capitals` 追加、记录 `movedCapitals`）；删到最后一州→抛错并带 `err.needConfirm`（前端展示「该国家只有最后一个州，删除将移除整个国家，是否继续？」），`force` 后整国删除（`polity.ended = 开局年`），并结束相关战争/条约、清君主卡/情报/控制方式/玩家国/customStart。
  - 数量调整：多则删州数最少国家（自动迁都）；少则新建国家（默认 6 州，可先点地图选落点），无空地时 warning。
- `mcp/monarch.ts`：`monarchPlan`/`monarchBriefList` 只处理 `control='ai'` 的国家；0 个 AI 国也合法（整回合程序推演）。
- `mcp/viewer.ts`：`GET /api/start/config`、`POST /api/session/start-setup`（最后一州未确认返回 **409 + needConfirm**）、`POST /api/session` 接受 `setup`；顺带修 `labelsCache` 未随会话失效导致同一年删国后地图残留旧国名（`invalidateOwnerCache` 清 labelsCache）。
- `mcp/viewer/start-custom.js`：两段式面板 ①国家名单（数量滑杆 3–30、每国「AI 君主/程序自动」下拉、✕ 删国、＋新增国家+地图落点+州数）②君主定制（原 P3 之前字段）；本地预览、一次「应用开局」提交。

## 验证
- Node 单测 **56/56**（14 组：删普通国、删首都迁都、最后一州 force 前后、战争/条约/卡/控制/玩家/定制清理、新增国、AI 过滤(mock)、全程序跑回合、数量裁剪与增长、summary/stateGet 暴露、重复应用拒绝、推演后拒绝、与 applyCustomStart 兼容）。
- `mcp/build.ps1` exit 0；root `tsc --noEmit` exit 0；`selftest` 31/31、`selftest-coast` 18/18、`selftest-tile-field` 30/30；`node --check` 通过。
- Playwright（seed7/cells34043/2500 年）：15 国 → 数量 12（自动删 3 个最小国，含迁都 3 次）；3 国切程序；删只剩 1 州的「伦戴尔部」（确认文案命中）→ 应用后 **12 国 / 9 AI / 3 程序**；跑 1 回合 decisions 仅 9 个 AI 国。

## 已知限制
1. “国家数量”不重掷历史：多则删最小国、少则新建国家；无空地时可能达不到目标数并给 warning。
2. 新建国国名/颜色在第一回合结算时会被引擎按全图规则重算（州数与卡不受影响）。
3. 控制方式存于内存 `Session`（viewer 重启即失效，与会话/推演状态同寿命）；`mode='auto'` 会话默认 program。
4. 旧 `GET /api/start/nations` 保留兼容。

## 截图
- 01-开局设置-国家名单与数量.png
- 02-控制方式-AI君主或程序.png
- 03-删国确认-最后一州.png
- 04-应用后-12国9AI3程序.png
- 05-回合后-仅AI国出决策.png