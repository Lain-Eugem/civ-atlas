# 多画风统一河网（2026-11-14）

## 需求

用户 m01690：主站手绘风的河流有问题、地理图的河流很逼真；我们只做了手绘的河，没有其他画风的河。
建议把主站地理图的河流方案复制到所有画风里，"既保证了河流的走向也减少了计算量"。

## 做法

- 服务端 `mcp/terrain.ts`：每个世界只算一次河网几何 `riverNet`，实现直接复用上游 `src/gen/riverGeometry`
  （与主站地理图同一个函数：并干流 / 拉普拉斯平滑 / Catmull-Rom 加密 / 源头收细 / 河口 flare），
  然后裁到陆地（按 `raster.water` 二分插岸点，穿湖切段），再用 RDP（tol=0.02 世界像素）抽稀，
  坐标 / 流量 / 宽度系数统一 round 到 0.01，随 `/api/map/vectors` 下发。
- 前端 `mcp/viewer/vec-draw.js`：所有画风共用同一份 `riverNet` 几何（WeakMap 每世界缓存一次），
  只按画风换颜色 / 线宽 / 河岸层：
  - 手绘 fantasy：照主站 `fantasyRiverStyle`（maxW = 0.5 + 1.5·kk^-0.2、minFlux = threshold·riverLod(kk)、宽度指数 0.5）；
  - 地理图 geo / 卫星 satellite / 白模 white：照主站 `realisticRiverStyle`（宽度指数 0.65、riverFlux 系数、satellite 有河岸层）。
  绘制顺序仍是「海岸墨线 → 林块 → 河网 → 符号」，河网在所有 rect（含跨极镜像）上画。
- `mcp/viewer/app.js`：`vecStyleOn()` 放开 geo / satellite / white 的矢量层；classic 保持原样（纯栅格）。

## 数字（seed=7, cells=34043, worldId w-7-c7db021219）

| 项 | 值 |
| --- | --- |
| 河网几何计算 | 20–23 ms（每世界一次，之后缓存） |
| 加密后点数 | 28,403（267 条河） |
| 裁陆 + RDP 后 | 279 段 / 11,425 点 / 276,733 B |
| `/api/map/vectors` | 1,634,851 B → 1,835,598 B（+12.3%；旧 `rivers` 字段 75,988 B 已删） |
| renderVectors | 首算 3.32 s，进程内二次 0 ms |
| 河点落水违规 | 50 个"湿点"全部距岸 1 px（round2 取整，水面内部 0） |
| 主站对照对齐 | RGB-SSD 最佳平移 (0,0)（100% 与 659% 同一视野） |
| 659% 河色掩膜 | viewer 相对主站 ±1px 覆盖 82.6%；主站多 3.2× 像素，多出的基本是 creeks 小溪（我们没做） |

## 验收

- 根 `tsc --noEmit` exit 0；`selftest` 31/31；`selftest-coast` 18/18；`selftest-tile-field` 30/30。
- 独立复验（verify 子代理，task-8）：**PASS**，详细报告在 `snaps/verify-geo/报告.md`（不入 git）。
- 证据图：`01/02` 地理图河网 100% 与 659% 主站 vs 查看器；`03` 河网掩膜叠色；`04` 手绘 659% 主站 vs 查看器。

## 已知差距（都不在本次范围）

1. ~~不做 creeks 小溪~~ 已在 2026-11-14 补上（见下节）；主站 k>1 时的这层小溪现在查看器也有。
2. `classic` 画风仍是旧三角形栅格，没有高清瓦片 / 矢量层。
3. geo / satellite 目前只画河网，没有海岸 / 湖岸墨线（主站写实画风的墨线在别的层）。
4. 查看器没有地名 / 河名标签。
5. geo 首次进世界要预渲染 672 块瓦片（约 90 s，之后磁盘缓存 1.2 s）。
6. 手绘 fit（100%）只显示大河，与主站同公式、同表现。

## 其它

- `vite.config.ts` 的 dev server 加了 `server.watch.ignored: ['**/.runs/**', '**/snaps/**']`：
  预渲染瓦片 / 截图目录动辄几百 MB，而且脚本写临时文件时被 Windows 锁住会让 watcher 抛 EBUSY 把 dev server 弄崩
  （本任务中真的崩过一次）。

## 2026-11-14 补丁：小溪（creeks）

- 上游对照：主站写实系（geo / satellite / white）在 `k > 1` 时用 `render/realistic.ts` 的 `riversOf(world, k)`
  把 `src/gen/creeks.ts` 的小溪并进河网**一起**跑 `riverGeometry`（所以溪流汇入干流处不会断口）；
  手绘风主站不画小溪，所以查看器也只在非手绘、`relK > 1.2`（主站 `DETAIL_K`）时画。
- 服务端 `mcp/terrain.ts`：把 `riverNetOf` 拆成 `riverNetOf` / `riverNetCreekOf` / `buildRiverNet(world, ctx, rivers, tol)`；
  `TerrainCtx` 缓存第二份 `riverNetCreek`，用 `[...world.rivers, ...creeksOf(world)]` 走同一个 `riverGeometry`，
  裁陆后 RDP 容差放宽到 **0.03** 世界像素（1200% 时约 0.4 屏幕像素），`VectorData.riverNetCreek` 随 `/api/map/vectors` 下发。
- 前端 `mcp/viewer/vec-draw.js`：`riverNetCache` 改成每个 `vec` 缓存 `{ base, creek }` 两份几何（`riverNetGeoOf(v, W, which)`）；
  `drawVectorsInto` 里 `const useCreek = !fantasy && relK > 1.2;`，取不到小溪那份时回退到 `base`。

### 数字（同一世界 seed=7 / cells=34043）

| 项 | 值 |
| --- | --- |
| 小溪条数 / 原始点 | 1,381 条 / 5,982 点（`creeksOf`） |
| 河道+小溪 合并几何 | 1,403 段 / 115,940 加密点 / 45 ms |
| 裁陆 + RDP(0.03) 后 | 1,415 段 / 37,026 点 |
| `/api/map/vectors` | 1,835,598 B → **2,676,008 B**（+840,410 B，+45.8%） |
| renderVectors 首算 | 3.32 s → 4.50 s（进程内二次 0 ms） |
| 河网段落 | `riverNet` 279 段 / 11,425 点保持不变（手绘与低倍仍用它） |

### 验收

- 659% 下查看器地理图 / 白模都能看到细小溪网络；与主站地理图同视角做 50% 叠色，海岸线与溪流走向重合（无重影）。
- 证据图：`05` 查看器地理图 659%、`06` 主站地理图 659%、`07` 两者 50% 叠色放大、`08` 查看器白模 659%。
- 回归：根 `tsc --noEmit` exit 0；`selftest` 31/31；`selftest-coast` 18/18；`selftest-tile-field` 30/30。

### 已知限制

- 小溪只在放大后显示（`relK > 1.2`），fit 下与主站一致只显示大河。
- 下发体积 +0.84 MB、首算 +1.2 s；后续要压可以再调 RDP 容差或按缩放分档下发。
