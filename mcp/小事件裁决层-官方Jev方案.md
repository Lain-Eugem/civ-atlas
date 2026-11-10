# 小事件裁决层（Petty Event Resolver）· 官方 Jev 1.14.0 版

> 2026-11-10 用户确认：改用官方 Jev，新增 v2（引擎侧真效果），其余按推荐默认值。
> 旧稿（本地 OpenJev `/v1/systemone`）保留在 `小事件裁决层-方案.md`，本文件为当前实施依据。

## 1. 需要配置什么

只差三样东西，全部从环境变量或 MCP 工具参数给，不写进代码、不写进日志：

| 配置 | 默认 | 说明 |
|---|---|---|
| API Key | 无（必需） | defapi.org 的 Key，`Authorization: Bearer <key>` |
| Base URL | `https://api.defapi.org` | 网关地址；请求路径固定 `/api/v1/decisions` |
| Model | `typesafe/jev-1.14.0` | 官方文档给的决策模型 |

环境变量（MCP 进程启动前设置）：

```powershell
$env:JEV_API_KEY   = "dk-..."          # 必需
$env:JEV_BASE_URL  = "https://api.defapi.org"   # 可选
$env:JEV_MODEL     = "typesafe/jev-1.14.0"      # 可选
```

等价的手工请求（先验证 Key 通不通）：

```powershell
$body = @{
  model = "typesafe/jev-1.14.0"
  state = "第 2510 年，明河国东部连月少雨，秋收前粮价上涨。"
  questions = @{
    drought = @{
      type = "noul"
      instructions = "判断今年这一带是否发生旱灾。"
    }
  }
} | ConvertTo-Json -Depth 8
Invoke-RestMethod -UseBasicParsing -Method Post `
  -Uri "https://api.defapi.org/api/v1/decisions" `
  -Headers @{ Authorization = "Bearer $env:JEV_API_KEY"; "Content-Type" = "application/json" } `
  -Body $body
```

之后在沙盒里通过 MCP 工具接（实现完成后）：

- `civ_petty_setup`：`{ sessionId, baseUrl?, model?, apiKey?, timeoutMs?, budget? }`
- `civ_petty_status`：看连接、已跑回合、预算/队列统计
- `civ_petty_round`：跑一回合小事件裁决（可与君主回合合并）

Key 只存在 MCP 进程内存；查看器同样只在内存里填，不落盘。

## 2. 官方 API 与旧本地 OpenJev 的差异（会改变实现）

| 项 | 旧本地 OpenJev | 官方 Jev 1.14.0 | 处理 |
|---|---|---|---|
| 端点 | `POST {base}/v1/systemone` | `POST https://api.defapi.org/api/v1/decisions` | 换 |
| 鉴权 | 无 | `Authorization: Bearer <key>` | 加 |
| 问题 | 同 System One 形状 | `questions` 对象，key 原样回显；`noul` 的 criteria 可选 true/false；`choice` 必须有 criteria 对象（选项→说明）；`score` 必须有 2–10 条有序 criteria 数组 | 适配三种原语 |
| 响应 | 概率分布 | `answers[q]`：noul→`{noul:0..1}`；choice→`{choice, probabilities, confidence}`；score→`{score, legend, probabilities, confidence}`；另有 `usage{input_tokens,output_tokens,cost}`、`task_id`、`consumed`、`model` | 解析；input_tokens 用来校准估算 |
| 温度/top_p | 请求里可带（任务六要求客户端 1.0/1.0） | **请求 schema 没有 temperature/top_p 字段** | 客户端不再设置；复现性不依赖模型，改由“结果落盘 + 引擎抽样”保证；日志记 model/task_id/usage |
| token 上限 | 4250 硬上限 | 文档未给硬上限（另有图片与 32MiB 限制） | 保留 4250 硬 / 4000 目标（可配置），因为账单与延迟仍要控；后续按 usage 校准 |
| 计费 | 本地免费 | input $0.084 / 1M tokens，output $0（文档价目） | 每回合记 input_tokens 与估算费用 |
| 图片 assets | 无 | jev-1.14.0 支持，280–1568px | v1 不用；接口预留 |

**结论：** 任务六改写成“固定模型 + 记录 usage/task_id + 结果落盘”，不再声称模型服务端温度可固定；确定性由引擎侧抽样保证（见 §4）。

## 3. 结构（沿用旧方案，改动处标注 ★）

```
src/gen/civ/petty.ts        ★ 注册表 + 模式 + 触发扫描 + 预算视图（纯计算，可单独测）
src/gen/civ/pettyEngine.ts  ★ v2：新增 petty 干预在引擎里的落地（真效果）
mcp/petty-client.ts         ★ 官方 Jev 客户端（POST /api/v1/decisions，Bearer，解析三种答案）
mcp/petty-budget.ts         ★ ContextBudgetManager（P0/P1/P2 环境段 + 问题打包 + estimateTokens）
mcp/petty-queue.ts          ★ 串行优先队列（P0=10/P1=20/P2=30，单在途，超时/熔断/背压）
mcp/petty.ts                ★ Resolver + 回合编排（扫描→预算→队列→抽样→落 effects→日志→DM 摘要）
mcp/selftest-petty-*.ts     客户端/预算/队列/Resolver/引擎 v2 自检
```

### 3.1 模式（20 个，5 领域）

每个模式：`{ id, domain, priority, profile, trigger, question(type/instructions/criteria), options: { key → v2 effect }, fallback }`。
画像等级：L1 = 只带 P0；L2 = P0+P1；L3 = P0+P1+P2。

| 领域 | 模式 id | 优先级 | 问题类型 | v2 引擎效果 |
|---|---|---|---|---|
| 经济 | trade_raid | P1 | choice | sack（商队被劫：附近城人口小折损） |
| 经济 | trade_profit | P1 | score | dev（商会繁荣：boost 该国发展 3 年档） |
| 经济 | market_shortage | P1 | noul | sack（粮价上涨：城人口折损小） |
| 经济 | new_route | P1 | noul | dev（新商路：boost） |
| 环境 | drought | P0 | noul | disaster famine（一国/几州） |
| 环境 | flood | P0 | score | disaster famine（水患按饥荒折损） |
| 环境 | plague_seed | P0 | noul | disaster plague（指定城起疫） |
| 环境 | quake_damage | P0 | score | disaster quake（指定州连带一圈） |
| 军事 | border_clash | P0 | choice | sack（边境冲突：两城折损） |
| 军事 | ambush | P0 | noul | sack（伏击：败方城折损） |
| 军事 | siege_morale | P0 | score | note（士气只影响叙事，v2 不改战争规则） |
| 军事 | mercenary_contract | P1 | noul | dev（佣兵开支：boost/叙事） |
| 社会 | riot | P1 | noul | sack（骚乱：城人口折损） |
| 社会 | migration | P1 | score | note（迁徙叙事；引擎无小规模迁徙原语） |
| 社会 | public_works | P2 | noul | dev（公共工程：boost） |
| 社会 | talent | P2 | noul | note（人才叙事） |
| 基建 | build_quality | P2 | score | dev（工程质量：boost） |
| 基建 | road_damage | P1 | noul | note（道路损毁叙事；道路最终态由 routes 每 20 年统一算） |
| 基建 | waterworks_fail | P1 | noul | disaster famine（水利失修：城折损） |
| 基建 | route_blocked | P1 | noul | note（商路受阻叙事） |

说明：天灾类走既有 `disaster` 干预（引擎已支持，真人口折损、瘟疫传播、动荡）；非天灾类走 v2 新增的 `petty` 干预（sack = 给 Settlement.sacks 记一条折损，再由 growth.ts 正常恢复；dev = 委托 boost 机制给该国 +发展）。叙事项只进编年史摘要，不改数值。

### 3.2 v2 新增引擎干预 `petty`

```
{ kind: 'petty', from: Year, a: string /* 国家键 */, effect: PettyEffect }
type PettyEffect =
  | { type: 'sack'; region?: string; city?: string; loss: 1|2|3 }   // 1/2/3 = 3%/8%/15% 人口折损
  | { type: 'dev'; years?: number }                                  // 委托 boost，默认 3 年档
```

`tidyIntervention` 校验：a 必须是国家键；sack 最多给一个 region 或 city；loss 只能 1/2/3；dev years 夹 1–20。
引擎侧：`interventions.ts` 的 `intervene()` 加 `else if (v.kind === 'petty') strikePetty(this, v, i, t)`；`pettyEngine.ts`：
- sack：按 region/city 找到此刻有城的州（没有 → 记 intervene b=0 不生效），算人口，push `Settlement.sacks`（cause 用既有值），记 `intervene` 史事；人口由 growth.ts 的折损恢复。
- dev：构造等价 boost 调用，把国家推进发展的旋钮/表打一拍（复用 boost.ts 的入口）。
兼容性：新增 kind 对旧存档无影响；旧版本读新存档时 `cleanIntervention` 对未知 kind 返回 null（已实测 press 的经验），静默忽略、不崩。

### 3.3 官方客户端

- `JevSettings{baseUrl,model,apiKey,timeoutMs}`；默认 baseUrl/env/model 如上；缺 Key 直接报“设置 JEV_API_KEY 或传 apiKey”。
- 请求体：`{model,state,questions,session_id?}`（session_id 用回合批次号，便于排查）。
- 解析：统一成 `Record<questionKey,{type,noul?/choice?/score?,probabilities?,confidence?,legend?}>`，再交给确定性抽样。
- 错误：HTTP 非 2xx 抛 `JevError`，带状态码、`code/message` 与正文；401 提示 Key，400 提示请求格式/模型，5xx 走重试或降级。
- usage 记入回合日志（input_tokens/output_tokens/cost），并与 estimateTokens 的估算对照。

### 3.4 token 预算与队列（沿用旧稿）

- estimateTokens：中文≈1 字 1 token；英文/数字≈4 字符 1 token；JSON 符号 1/个；整体 ×1.1 上取整。
- 环境段占目标 4000 的 40–50%；P0 必含、P1 应含、P2 可裁；超预算先少打包问题，不裁 P0。
- 队列：串行、单在途，P0=10 / P1=20 / P2=30，同级 FIFO；超时默认 30s（P0 60s）；单回合总等待 >120s 剩余降级；积压 >40 时暂停 P2；连续 5 次失败熔断，下回合探活。
- 每回合统计：入队/完成/超时/降级/平均等待/最大等待/总耗时/输入 token。

### 3.5 回合插入点

```
回合开始
 → 引擎扫描待定小事件（petty.ts 的 scanPettyEvents）
 → 预算构造环境 + 打包问题（petty-budget.ts）
 → 串行队列发 Jev（petty-queue.ts + petty-client.ts）
 → 概率 → 确定性抽样（subSeed(`petty:${eventId}:${year}:${polityId}`) + mulberry32）
 → 结果落盘（petty-round-NNNN.json / petty-rounds.jsonl）
 → 编译成干预（petty / disaster）+ 叙事摘要
 → DM 回合（君主命令 + petty 命令一起 submitOrders）
 → turnStep 推演
 → 下回合 DM 简报只看到“已结算”的小事件摘要，不含概率/选项/队列
```

## 4. 确定性与复现

- 引擎只受“已结算结果”影响；抽样用引擎统一随机流派生（`src/gen/util.ts` 的 subSeed + mulberry32），同一 seed + 同一事件列表 → 同一结果。
- 落盘内容：事件、问题、原始概率、抽样值、usage、task_id、进引擎的干预列表。
- 回放：`civ_session_verify` 从 `play.commands` 重推；petty 结果已编译成普通干预，天然可回放。
- 改 model/预算/模式表 = 改行为，需在日志标注版本号（`petty@1`）。

## 5. 分批实施

1. **A**：`petty-client.ts` + `petty-budget.ts` + `petty-queue.ts` + 单测（不需引擎改动）。
2. **B**：`src/gen/civ/petty.ts` 注册表/触发/抽样 + `mcp/petty.ts` Resolver + 回合日志 + mock 自检（效果先只 note，可跑通全流程）。
3. **C**：v2 引擎 `petty` 干预（edits/interventions/pettyEngine + 所有 Record/UI 开关补 case）+ 自检。
4. **D**：接入 MCP 工具（petty_setup/status/round，与君主回合合并）、查看器面板/状态、README、全量自检、确定性对账、提交。

## 6. 验收（按任务书 7 条 + 官方 API 适配）

1. 50 次请求 input_tokens ≤ 预算（默认 4250），P0 完整率 100%；
2. 在途请求始终 ≤1（队列自检 + 日志）；
3. P0 先于 P1/P2 出队（自检）；
4. 同 seed + 同事件 + 同结果日志 → 引擎逐位一致（指纹对账 21/21 不受影响）；
5. 20 回合无“君主级事件进入 petty”与“petty 事件塞给 DM”；
6. 断网/401/超时 → 当回合全部走引擎规则，日志 `fallback: engine-rule`，回合仍完成；
7. 接入前后 DM 输入 token 下降（用 usage 统计对比）；
8. 官方 Key 连通冒烟（真实请求 1 次，验证鉴权/解析/usage）。
