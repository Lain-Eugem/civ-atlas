# 2026-11-14 第二轮:标签层 / 写实岸线 / classic / 疆域高清 / 国界线 / 河流影响地块

来源:用户 m02167 的七条要求(标签层、写实系岸线墨线、classic 修正、小溪体积不再压、疆域按屏幕分辨率现画、国界线细虚线、"河流影响地块"=人口/商路/国界等),另确认预渲染 3 分钟可接受。

## 交付清单

| # | 需求 | 落地 | 状态 |
|---|------|------|------|
| 1 | 标签层(地名/河名/湖名/内海名) | 新 `mcp/labels.ts`(586 行)+ 新 `mcp/viewer/labels.js`(446 行)+ `GET /api/labels` + app.js 接线 | 完成 |
| 2 | 写实系海岸/湖岸墨线 | `mcp/terrain.ts` 输出 `coastReal`/`lakeReal`;`mcp/viewer/vec-draw.js` 写实分支按主站 `MATERIALS.geo.coast` 画 1.5px 蓝墨;瓦片自带墨线时用瓦片线 | 完成 |
| 3 | classic 修正 | `LOOK` 加 classic 走主站写实流水线;`mcp/viewer.ts` 放开 classic 的底图/瓦片/预热门;app.js 放开 LOD、矢量层、岸线墨色;`MAP_VER 5→6` | 完成 |
| 4 | 小溪体积 | 未再压缩(用户确认保持) | 不变 |
| 5 | 疆域按屏幕分辨率现画 | `mcp/owner-map.ts` 新增 `renderOwnerTilePixels`(PAD=72)+ `mcp/map-worker.ts` 的 `kind:'owner'` + `GET /api/map/owner-tile` + app.js owner 瓦片客户端(LOD 2/4/8,整层到齐才从整张 PNG 切换) | 完成 |
| 6 | 国界线细虚线 | app.js `ownerBorderStyle()`:1px 墨色虚线 `rgba(58,32,20,.85)` dash[4,3] + 1px 极淡奶白底线(`baseStroke:null` 可关) | 完成 |
| 7 | "河流影响地块"=人口/商路/国界等 | 新 `mcp/rivers-data.ts`(纯函数):`riverCellsByCell`/`riverCellsByRegion`/`riverAdjacency`/`riverSummary`/`riverReport`;`mcp/engine.ts` 的 `sessionSummary.rivers` 与 `stateGet.rivers` 透出;引擎既有 RIVER_BANK/MAJOR_RIVER/RIVER_SILT/RIVER_ALONG/RIVER_CROSS/RIVER_STEPS/RIVER_BORDER_FRAC 不动 | 完成 |

## 数字(seed=7 / cells=34043 / world w-7-c7db021219 / 会话第 2500 年)

- `/api/map/vectors`: **2,743,627 B**(17 个字段;riverNet 279 段、riverNetCreek 1,415 段、forest 3,250 块、coastReal 309 条、lakeReal 45 条);进程内二次请求 18ms。
- `/api/labels`: **781 条 / 71,829 B / 28 ms**(polity 17、capital 17、bigcity 24、city 179、town 246、village 236、ocean 3、sea 11、mountains 18、river 6、lake 6、island 14、desert 4)。
- `/api/map/base?style=classic`: 2,775,915 B(已缓存 4ms;冷启走 worker 池)。
- `/api/map/owner-tile`:单块 PNG 1–55 KB(大部分是水的块 ~1 KB);命中缓存 2–35 ms;冷块 0.1–2.8 s(含 worker 冷启动)。S=8 大块 vs 两块 512 逐字节一致、跨极奇偶层 0 像素差错(子代理验证)。
- 河流影响:河 267 条、河道地块 912(大河 125)、总长 126,849.7 km;州 820、有河州 302(36.8%)、治所临河 133、有河州承载力占比 49.9%;以河为界州对 238(12%)、跨国 6 对;商路 955 条踩河 7.9%。`stateGet.rivers` 约 3.4 KB / 3 ms。

## 验证

- 根 `node node_modules\typescript\bin\tsc --noEmit` exit 0
- `mcp/build.ps1` exit 0(检查 242 文件,修补 1 个)
- `node mcp\.build\mcp\selftest.js` 31/31(2741ms);`selftest-coast.js` 18/18(13290ms);`selftest-tile-field.js` 30/30(6421ms)
- Playwright(系统 Chrome,1600x900 dsf=1):截 100%/400%/659%/1200% 各画法,`Console errors: []`

## 证据图

- `02-fantasy-100-labels.png`:手绘 100%,标签层 + 水彩疆域 + 细虚线国界
- `05-geo-100.png`:地理图 100%,标签 + 岸线墨线 + 河网
- `06-satellite-659.png`:卫星写实 659%
- `08-classic-100.png` / `09b-classic-400.png`:classic 修正后(100% 底图 / 400% 高清瓦片)
- `10-fantasy-400-territory.png` / `11-fantasy-1200-territory.png`:疆域按屏幕分辨率现画(400%/1200%)
- `13-geo-400-closeup.png`:地理图 400%,标签/岸线/河网特写
- `c1-geo-closeup-main-vs-viewer.png` / `c2-geo-fit-main-vs-viewer.png`:与主站同世界对照(主站在左/上)

## 已知差距

1. classic 画法不画标签层(`labels.js` 对 classic 返回 0),也没有主站对照(主站没有这个画法)。
2. classic 的魔力层瓦片仍走旧门(`app.js` 里 magic 调度对 classic 直接 return),需要时可放开。
3. 写实系的岸线墨线在 `tileFull` 时用瓦片自带的 `/api/map/coast` 追线,不叠全局墨线(避免双线,和手绘同一机制)。
4. 标签层河名只有 6 条(上游 findPlaces 有干流长度门槛);湖名/内海名来自 `civ.places.kind='lake'/'sea'`,world 本身没有 lakes 字段。
5. 标签字号分级用 `relK`(缩放倍数)近似主站 `view.k`,未逐档与主站比对。
6. 疆域瓦片冷块首屏 0.1–2.8 s(worker 冷启动),缓存后 2–35 ms。

## 2026-11-14 补丁：卫星画风的细沟（vein）描线

需求（用户 m02632）：卫星底图上能看出的沟，就要有对应的线——"所见即所画"。

**为什么底图有沟、却没有河线**：底图的沟影来自 `src/gen/pixelDrain.ts` 的逐像素汇流细沟（`Raster.vein` + `veinLines`，材质 `realistic.ts MATERIALS.detail.veinK=0.6`），而河/溪矢量线来自地块级的 flux 门槛（`world.riverThreshold`=8.92、creeks 门槛 1.78）。实测 1 倍世界：陆地像素 798,707 里有细沟的 249,380（31%），其中距离河/溪矢量线 >3px 的占 61.9%，这些细沟像素所属地块 96% 的 flux < 1.78（连小溪门槛都不到）——两套数据不同源、不同门槛，所以"底图有沟、无河线"是正常现象。主站原版也是同一套流水线。

**做法**：
- 服务端 `mcp/terrain.ts` 新增 `renderVeinOverlay(world)`：`rasterize(world,1,true)`（带 gully，约 2.5s，每世界缓存）→ 按主站同一套可见性曲线 `vn=(log(a)-log(VEIN_A0))/(log(VEIN_A1)-log(VEIN_A0))`、`fade=1-smoothstep(VEIN_E0,VEIN_E1,elev)`、`st=smoothstep(VEIN_C0,VEIN_C1,vn)*fade` 逐点算强度 → 丢掉整条最强处 <0.06 的线 → RDP tol 0.3 抽稀 + 坐标 1 位/强度 2 位；输出 `VeinOverlay{lines:[{p:[x,y,s,…]}]}`。
- 服务端 `mcp/viewer.ts` 新增 `GET /api/map/veins?worldId=`（`veinCache` 按世界缓存）。
- 前端 `mcp/viewer/vec-draw.js` 新增 `drawVeinLines()`：仅 `style==='satellite' && relK>=2.5`；按强度分桶，两遍画（宽淡谷影 + 窄沟心），`globalCompositeOperation='multiply'` 压暗底图（和底图的"阴影"观感同一种）；跨 180° 按 bbox 复制、odd 层 y 镜像、视口外裁剪。
- 前端 `mcp/viewer/app.js`：`S.veins`，切到卫星画风 / 建世界时 `loadVeins()` 拉一次，`draw()` 里河网之后调用。

**数字**（seed=7/cells=34043）：`/api/map/veins` = **365,743 B**、4,061 条线 / 20,749 点；首次 2.66s（1 倍栅格带 gully），进程内缓存 8ms。只在卫星画风高倍时请求，其它画风不拉。

**验收**：`snaps/vein/` 同视角关/开对比（`cmp-944-v6.png`、`cmp-1200-v6.png`）——底图上可见的沟都补上了极淡的细线，未出现大片凭空多出来的线；944%/1200% 均无 console 报错；root `tsc --noEmit` 0 错、`selftest` 31/31。

**已知限制**：只做卫星画风（geo/classic/blank 的 `veinK=0`，底图本来没画沟）；`relK<2.5` 不画（低倍时沟本身只有 1px 上下，强行画会糊成一片）；没有开关，若觉得多余可以先去掉 `app.js` 里那段调用。

## 2026-11-14 性能修复：羊皮纸（手绘）画风拖动卡顿

**现象**：316% 缩放下拖动手绘地图约 10fps（rAF 间隔 p50 100ms / p90 133ms），其它四种画风都是 120fps（p50 8.3ms）。

**根因（两处叠在一起）**

1. `mcp/viewer/app.js` `buildVecCache()` 把矢量层离屏缓存放到了 `(oxAbs - pad, oyAbs - pad)`。`oxAbs/oyAbs` 是“主图原点在屏幕上的绝对坐标”，放大后是很大的负数（316% 时约 -2047），于是缓存画布被放到视口左边几千像素外，缓存覆盖判断 `right >= S.cw - mx` 永远不成立 —— **放大视角下矢量缓存从建好起就没被复用一次**。
2. 每次重绘都退回主线程同步描线。JS 侧描线只要 1–3.4ms，但 canvas 要把 3000+ 林块、3000+ 符号等上千个子路径交给 GPU 重新光栅化，实测 75–100ms/帧。

**修法**

- 缓存画布固定放在 `(-pad, -pad)`（视口四周各留 pad 的世界锚定位图），复用公式不变：`dx = oxAbs + s*(c.x0 - c.ox)`，同一视图得 `-pad`，平移 Δ 得 `Δ-pad`。
- 交互中 / 缓存没盖满新视口时，直接平移贴旧缓存（按世界坐标平移，内容仍然对），重烘交给 worker 在后台做：拖动中 400ms 一次、停手 120ms 一次；只有“没有缓存 / 换了画法 / 换了世界 / worker 坏了”才回退同步描线。

**结果**

| 画风 | 拖动 p50（修前→修后） | p90 | max | >50ms 帧 |
| --- | --- | --- | --- | --- |
| fantasy（羊皮纸） | 100ms → **8.3ms** | 133.4 → 8.5 | 166.6 → 366.6（偶发一次，换画法后首批瓦片） | 42/43 → 10/150 |
| geo（地理图） | 8.3 → 8.3 | 8.5 → 8.4 | 24.9 → 16.7 | 0 → 0 |
| satellite / white / classic | 8.3–8.4（本就流畅） | — | — | — |

**证据图**：`17-手绘拖动修复后-矢量层正常.png`（停手 0.65s，林块 / 墨线 / 河网都在）。

**已知限制**：换画法后第一次拖动可能有一次几百毫秒的卡顿（首批瓦片 + 第一次重烘），属预热；拖动中若一直拖着不停手，视口边缘超出缓存留白的区域会暂时空缺（旧缓存平移后覆盖不到），停手 0.1–0.3s 内补全。
