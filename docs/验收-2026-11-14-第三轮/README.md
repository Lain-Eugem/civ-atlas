# 2026-11-14 第三轮验收：地区线 / 地区悬停 / 开局君主定制 / DM·Jev 展示

需求来源：用户 2026-11-14 的 4 条要求（原文：增加除国界线之外的地区线、悬停展示地区状态、开局定制 AI 君主角色卡或自动生成并指定初始疆域大小与位置、DM 对话与 Jev 决策要有独立展示处）。

## 1. 地区线（州界）

- 服务端 `mcp/owner-map.ts`：新增 `regionBorderLines(world, raster, civ)`
  - `regionChains` + 按州身份做 `mergeChains`（每条州界都是界线）+ Chaikin 1 轮平滑 + 自写 RDP（`REGION_SIMPLIFY_TOL = 0.9`）；按 `civ.regions` WeakMap 缓存。
  - 结果随 `/api/map/owners` 的 `regions` 字段下发（与既有 `borders` 并列，整张 PNG 仍 319,440 chars）。
  - seed=7 / cells=34043：**1613 条线 / 5581 点 / JSON 83,417B**（跨 180° 12 条，前端在另一侧补画一份）。
- 前端 `mcp/viewer/regions.js`：`drawRegionLines(g, opts)`，坐标换算与 `strokeLines` 一致、支持 odd 跨极镜像、按 bbox 做跨 180° 平移、一次 stroke。
  - 样式：手绘 `rgba(90,70,48,0.30)`；地理图/卫星 `rgba(118,134,150,0.34)`；白模/经典 `rgba(90,82,70,0.22)`；均为 0.7px 虚线 `[2,3]`，绘制在国界线（`drawOwnerBorders`）之前，不会盖住国界。

## 2. 地区悬停标签

- 服务端 `mcp/region-info.ts`：`regionInfoAt(world, civ, x, y)`，按 World 缓存 `raster`、按 `civ.regions` 缓存 `pixelRegions` → 世界主图像素 → 州 id。
  - 返回 `RegionInfo`：`region/name/polity{id,name,color}/biome/biomeName/area/capacity/elevation/seatCell/seatName/seatTier/cells/river{cells,majorCells,lengthKm,maxFlux}`；海/湖/图外返回 `null`。
  - 性能：缓存后 1000 次调用 0.46ms。
- 路由：`GET /api/map/region-info?sessionId=&x=&y=`（x/y 必须为数字）。
- 前端：`CivRegions.initHover` 自绑 canvas `pointermove/pointerleave`，120ms 节流 + 120ms 悬停延迟；`#regionTip`（`mcp/viewer/index.html`，`style.css` 里的 `.region-tip*`）展示州名/州号、所属国（带国色）、群落、面积/人口上限、海拔、河流、治所、地块数。

## 3. 开局君主定制（角色卡 / 自动生成 / 初始疆域大小与位置）

- 服务端 `mcp/monarch-start.ts`：
  - `listStartNations(s)` → 可选国家列表（polityId/name/color/capital/regions/seatName/cultureName）。
  - `applyCustomStart(s, { polityId?, at?{x,y}, size? 3..40（默认 8）, card?, autoCard? })`
    - `mode: 'existing'`：缩/扩指定国家到 size 个州（多余的变无主，警告列出数量）；
    - `mode: 'new'`：在 `at` 附近新建国家（无城时自动把最近一座城连同其州划过来当国都），`autoCard` 或自定义 `card` 生成君主卡；
    - 只允许第一回合前（`rounds > 0` 抛错）；`monarch.ts` 的 `pinnedCard` 保证自定义卡不会被下一轮 `monarchPlan` 覆盖。
  - engine：`CustomStartState` / `Session.customStart` / `stateGet` / `sessionSummary` 记录生效信息；`stateView` 返回 `customStart`。
- 路由：`GET /api/start/nations?sessionId=`；`POST /api/session/custom-start`（返回 `{state, result}`，并清 owners/编年史缓存）。
- 前端 `mcp/viewer/start-custom.js`（`window.CivStart`）：左侧新增「✦ 开局设置」按钮；面板含国家下拉、📍 地图点选（走 `S.pickMode` + `mapPointAt`）、初始州数滑杆（3–40）、自动生成角色卡勾选、自定义角色卡（君主名/谨慎·野心·荣誉·贪欲/军事·经济·权谋·治理/战争·经济·外交偏好/人物小传/随机性格）、应用与取消。
- 冒烟（seed=7 / cells=34043）：
  - 已有国缩到 10 州：`{mode:'existing', regions:10, warnings:["缩到 10 州:放掉 69 州(变无主)"]}`；
  - 新建国（at=(1024,512), size=8, 自动卡）：`{mode:'new', polityId:83, name:'塔米亚部', regions:8, card:'纳西姆'}`，`state.customStart.created=true`，polities 18。

## 4. DM 对话 / Jev 决策展示

- 服务端 `mcp/dialogue.ts`：`dialogueView(s, { limit?=80, kind?: 'dm'|'jev'|'monarch' })` → `{ rounds, total:{dm,jev}, warnings }`；
  - 每回合含 prompt/reply 摘要、逐条 decisions（命令、accepted/rejected）、notes、error；
  - 文本预算：单条 ≤2000 字，整体约 280KB 上限，逐级缩到 160 字并丢最早回合（total 保留完整计数）。
  - 路由 `GET /api/dialogue?sessionId=&limit=&kind=`（按 fingerprint 缓存）。
- 前端 `mcp/viewer/dialogue.js`（`window.CivDialogue`）：日志面板新增「DM 对话」「Jev 裁决」两个页签，含数据来源说明、警告块、逐回合卡片（回合号/年份/来源/状态/输入输出摘要/决定列表）；样式自注入（`dlg-*`）。

## 验证

- `node node_modules/typescript/bin/tsc --noEmit` → exit 0。
- `powershell -NoProfile -ExecutionPolicy Bypass -File mcp\build.ps1` → exit 0（检查 242 个文件、补 1 个）。
- `selftest` 31/31；`selftest-coast` 18/18；`selftest-tile-field` 30/30。
- 端到端冒烟：`/api/map/owners` regions 1613 条；`/api/map/region-info` 首都点返回「霜东道 / 康罗皇朝 / 热带季雨林 / 面积 790 / 人口上限 194 / 海拔 1173 / 治所 宁漠堡」；`/api/dialogue` mock 数据 rounds 2（dm 1 / jev 1）JSON ≈5,048B；custom-start 两种模式见上。
- 本次还顺手修了两处：
  - `loadDialogue` 曾被插进 `loadLabels` 括号内（导致 `loadDialogue is not defined`），已修正为平级函数；
  - 场/魔力场图层加载时"先 close 旧图、后 await 新图"会造成 rAF 绘制读到已关闭的 ImageBitmap（`InvalidStateError: image source is detached`），改为"先换入新图、再 close 旧图"。

## 已知限制

- 开局定制只在第一回合前可用；应用后 `verifySession` 回放会因 civ 被改动而失配（属预期）。
- 新建国家的国名/颜色在第一回合结算时会被引擎按全图规则重算（州数与角色卡不受影响）；首回合前该国 `ruler` 可能为 null（引擎在首回合补）。
- 地区线 1613 条在 100% 缩放下略密（可按需再降不透明度或只在 ≥某缩放显示）。
- 悬停标签有 120ms 延迟节流；位于海面/图外时不显示。
- DM/Jev 文本是摘要（原始 prompt 不回落盘），完整内容仅有 reason/decisions/notes。

## 证据图

- `01-regionlines-100.png`：手绘 100%，地区线（州界）与国界线并存。
- `02-regionlines-659.png`：659% 地区线特写。
- `03-region-tooltip-659.png`：悬停地区标签（州名/所属国/群落/面积/海拔/河流/治所）。
- `04-dm-tab.png`：DM 对话页签。
- `05-jev-tab.png`：Jev 裁决页签。
- `06-start-custom.png`：开局设置面板（国家选择/初始州数/角色卡）。