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
