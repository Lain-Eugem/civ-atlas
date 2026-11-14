# 验收：多 seed 州界线错误修复（m05340 反馈）

## 用户反馈

m05340：「我只是换了一个种子结果就发现"州界线"渲染出错…这个洲界线只与第一个种子有关…你是不是有点太懒了，测试的时候为什么不想着换一个种子?」
截图：新种子 `w-15-16a957dd19`，海面上出现大量灰色虚线网格（本应是陆地州界），且这些线是**上一个种子的州界线**。

## 根因

**客户端跨世界残留状态**，不是服务端几何错误。

- `/api/map/owners` 同时下发 `borders`（国界）和 `regions`（州界线）；app.js 在 `loadOwners()` 里写入 `S.regionLines`。
- `createWorld()` 切换世界时清空了 `S.ownersImg/ownerBorders/labels/baseCache/vecCache/vec/veins/atlas` 等，但**漏清 `S.regionLines` 与对话数据**。
- 而 `draw()` 画州界线的门禁只有 `if (S.regionLines && S.regionLines.length …)`——只要旧值还在，即使当前没有任何会话，也会把**上一个种子的州界坐标**画在新世界底图上（海陆完全对不上），于是看起来像随机网格/飞线。
- 这也解释了「只与第一个种子有关」：第一次种子的州界线一直留在 `S.regionLines` 里，后续换种子都不会被替换（直到新种子开始会话触发 `loadOwners`）。

服务端数据本身正常（`/api/map/owners` 抽样）：seed 7 → 1613 条/5581 点、seed 15 → 1648 条/5677 点、seed 42 → 1790 条/5939 点；坐标均在合法范围（跨 180° 的点略有越界，靠前端 shift 补画）。

## 修复（`mcp/viewer/app.js`）

1. `createWorld()` 重置块：清 `S.regionLines = null`、`CivRegions.setLines([])`、`S.dialogue = null`、`S.dialogueSession = null`。
2. `draw()` 州界线门禁加 `S.sessionId &&`：**没有会话时绝不画州界线**（作为二次防线，防止任何未来路径把旧线带过来）。

## 验证（本次特意换成多 seed）

- 单页内先建 seed15 世界 → 开会话 → 画面州界线来自 seed15（截图 03）；
- 再切到 seed7 世界、**未开会话**：画面上没有任何州界线（截图 04，修复前这里就是用户看到的网格）；
- seed7 开会话后：州界线来自 seed7（截图 05）；
- Playwright 全程 `errors []`；三颗种子 API 数据见上。
- 门禁：root `tsc --noEmit` 0；`selftest` 31/31；`selftest-coast` 18/18；`selftest-tile-field` 30/30（本次只改 app.js 静态文件，未动服务端）。

## 教训 / 以后的验收约定

- 之前多轮验收都只在 seed 7 上做，这次暴露"跨世界状态残留"类 bug。今后每轮 UI 验收至少覆盖 **2–3 个种子 × 至少一次"换世界"流程**（建 A→会话→换 B→看 B 预会话/会话），并保留截图。

## 截图

| 文件 | 说明 |
|---|---|
| 01-问题现场-旧种子州界线泄到新世界.png | 用户截图放大：海面出现上一颗种子的州界虚线网格 |
| 02-种子15-预会话-正常.png | seed15 新世界预会话（无任何州界线） |
| 03-种子15-会话后-州界线正确.png | seed15 开会话后州界线落在陆地上 |
| 04-切换回种子7-预会话-无残留州界线.png | 从 seed15 切到 seed7 未开会话：干净，无残留 |
| 05-种子7-会话后-州界线正确.png | seed7 开会话后州界线正确 |