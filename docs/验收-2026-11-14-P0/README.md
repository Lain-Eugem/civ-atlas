# P0 验收：统一地图浮窗 + 悬停流畅化

日期：2026-11-14 · 对应 plan.md §P0

## 需求（用户 m04171 第 1、2 条）

1. 魔力浓度浮窗与地块浮窗重叠 → 合并成一个浮窗分节显示。
2. 地块浮窗跟随鼠标一卡一卡 → 查明原因并修顺。

## 做法

- **服务端** `mcp/region-info.ts`：`regionMeta(world,civ,region)` 拆出；`regionAtlas(world,civ,scale=2)` 生成 1024×512 的州号栅格（每 2×2 源像素取多数州，全水=0xFFFF），按 World → regions → scale 三级 WeakMap 缓存；数据与水陆图同一份 `pixelRegions`，所以和地图完全对齐。
- **服务端** `mcp/viewer.ts`：新增 `GET /api/map/region-atlas?sessionId=&scale=`，返回 `{w,h,scale,regions,dataGzB64}`；gzip(level 6)+base64；缓存 key=`sessionId|fingerprint|scale`（>6 个清空），世界/会话状态变更时随 owners 缓存一起失效。
- **客户端** 新增 `mcp/viewer/region-atlas.js`：`fetch → atob → DecompressionStream('gzip') → Uint16Array`，`lookup(mx,my,mapW,mapH)` 用 3×3 多数派（中心优先）避免边缘噪点。
- **客户端** 新增 `mcp/viewer/tooltip.js`：单例浮窗，`pointermove` 只记坐标、每帧最多算一次内容；内容字符串不变不重写 `innerHTML`；`transform: translate` 定位（不触发布局）；右侧侧栏避让/上下翻转/clamp；`pointerdown→pointerup` 及 `pointerleave/cancel` 隐藏；`document` 级 `pointerup` 兜底。
- **客户端** `mcp/viewer/app.js`：`#fieldTip`/`#regionTip` 与旧 `showFieldTip`、`CivRegions.initHover` 全部移除，改为 `CivTooltip.init({ getHtml: mapTooltipHtml })`；`mapTooltipHtml` 在本地拼三节：地区（州名/#号/所属国/群落/面积+人口上限/海拔/河流/治所/地块/经纬度）、地块场（启用时）、魔力浓度（启用时），用分隔线连接，任一为空则不显示。会话状态变化后 `loadRegionAtlas(state)` 拉一次栅格（key=sessionId|fingerprint）。
- **样式** `mcp/viewer/style.css`：`.map-tip-card` + `.mt-*`（白底 0.96、11px、max-width 300、圆角 9、暗色模式适配）。

## 验收数据（seed=7 / cells=34043，w-7-c7db021219）

| 项 | 结果 |
| --- | --- |
| `/api/map/region-atlas` | 200，JSON **247,756 B**（gzip+base64），1024×512，Uint16 524,288 格，水 319,892，820 个州全部有名字 |
| 首次构建 / 二次命中 | **1,698 ms** / **5 ms**（进程内缓存） |
| 悬停期间网络请求 | **0**（栅格只拉一次；旧实现每次悬停一个 `/api/map/region-info`） |
| 悬停帧间隔（连续移动 40 次，224 帧） | p50 **8.3 ms**、p95 **8.4 ms**、max **8.5 ms**（≈120fps，无长帧） |
| 拖动时浮窗 | `#mapTip` 立即 `hidden`，松开后需再次移动才出现 |
| 控制台 | `errors []` |

## 证据

- `01-统一浮窗-地区+魔力-100.png`：同一张浮窗里"多伦沃尔德 #157"地区节 + 分隔线 + "魔力浓度 0.7225"节。
- `02-统一浮窗-659.png`：659% 下同样是单张浮窗。
- `03-拖动时浮窗隐藏.png`：拖动中浮窗收起，地图无遮挡。

## 已知限制

- 地块场一节只在开启"地块级逐年演化场"时出现（与魔力浓度同层，属可选叠加数据）。
- 栅格按 2×2 降采样：海陆边界 1 个栅格内可能出现邻近州号（3×3 多数派已缓解）；需要更精确时可用 `/api/map/region-info` 单点回退。
- 会话状态变更（回合推进）后指纹变化会重新拉一次栅格（~250 KB），走本地缓存不再重复构建。