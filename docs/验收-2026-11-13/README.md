# 验收 2026-11-13：河流矢量层 + 逐像素疆域/国界

改动（相对交接文档 §5–§7 的问题清单）：

- 河流不再烘进位图：`/api/map/vectors` 直接带 `world.rivers`（314 条 / 1106 顶点 / 阈值 3.165），
  浏览器在 `mcp/viewer/vec-draw.js` 里按屏幕缩放现画（照搬主站 `drawRivers` + `fantasyRiverStyle`），
  100% / 400% / 1200% 走线一致，只有线宽变。瓦片没有烘河，所以高清块上也照画。
- 疆域改成主站同一套画法：新建 `mcp/owner-map.ts`，`pixelRegions()` 逐像素归属（水 −1、海岸细节借邻州）→
  `washPixels()` 水彩罩染（内部 alpha 0.2、贴边浓到 0.7、纸纹）→ `borderLines()` 平滑 + 手绘抖动 + 接岸的国界；
  `renderOwnerMap` 里原来的 stampCells 方块 + 同国三角形 + 整体 alpha 172 已删除。国界以 JSON 随 owners 接口下发。
- 冰缘墨线接线：`mcp/terrain.ts` 里原本没被调用的 `iceInkRuns()` 接进 `renderVectors`，输出 `ice` / `iceFine`。

验证（2026-11-13 23:2x，新 build）：

- `node node_modules\typescript\bin\tsc --noEmit` → 0 错
- `mcp\build.ps1` → exit 0
- `node mcp\.build\mcp\selftest.js` → 31/31；`selftest-coast.js` → 18/18；`selftest-tile-field.js` → 30/30
- `/api/map/vectors` 1,359,264 B（含 314 条河、254 条冰缘线）；`/api/map/owners` PNG 373,168 B(base64)、
  36 条国界 / 3,199 点 / 45,629 B，首绘 180ms、缓存 30ms

截图：01 全图 100%（魔力场关）｜02 河流 476%｜03 河流 1200%｜04 默认参数（魔力场开）100%

已知限制：疆域 PNG 是 2048 宽，放大后是放大的水彩（比主站按屏幕分辨率现画要糊）；1200% 下瓦片拼缝有 1px 细线（旧问题，与本次改动无关）。
## 2026-11-14 补丁：河流层级与缩放参数对齐主站

用户 2026-11-13 深夜反馈"河流没接到入海口、像杂乱的线条"。逐项排查（同一世界 `seed=7&cells=34043`，
主站 `127.0.0.1:5188/?seed=7&cells=34043&style=fantasy` vs 查看器 `w-7-c7db021219`，同一屏幕点 (1300,450) 滚轮到 659%）：

- **生成数据完全一致**：两边 `world.params` 相同（mesh.n 32111 / spacing 5.0876 / rivers 267 / riverThreshold 8.9197）；
  267 条河里 195 条末点在水边，72 条末点在陆地且逐点核对全部与干流顶点**精确重合**（≤0.5px，0 缺口）→ 没有"断开"的河。
- 修了两处渲染偏差（`mcp/viewer/vec-draw.js`）：
  1. 河流块从"冰缘墨线之后、湖海岸墨线之前"移到**湖/海岸墨线之后**（对齐主站 `detail.ts`：像素层 → 海纹 → 冰 → 岸线墨线 → 林块 → 河 → 山符号），
     河口不再被岸线墨线切断；
  2. `fantasyRiverStyle` 的风格 k 由 `opts.k`（= P/mapW = 屏幕像素/世界像素，5.79@659%）改为 `relK`（= 缩放倍数 6.59，
     与主站 `fantasyVectorStyle(v.k)` 同量），世界线宽回到正确档位。
- 验证：`mcp/viewer/vec-draw.js` 用记录型假 ctx 断言绘制顺序（海纹 0 → 冰 1 → 岸线墨线 2 → 河 3 → 山符号 fill/stroke），
  relK 2.0 vs 1.6 线宽比 0.9297（= (1.6/2.0)^0.6），几何与 k/relK 无关。
- A/B（659%）蓝色河掩膜：查看器河像素 **93.9%** 落在主站河像素内（IoU 0.45，差值主要在主站 UI 区）；
  `snaps/fix-pair-river-659.png` 为并排，`snaps/fix-overlay-659.png` 为叠色（绿=重合）。
- 仍存的观感差：主站细节层画**森林树冠 + 中文地名标签**，查看器没有；主站 fit 时还把河流烘进底图符号层，
  放大后是"模糊底影 + 清晰矢量"双层，查看器只有一层清晰矢量（更干净）。