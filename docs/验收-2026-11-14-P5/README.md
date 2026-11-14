# 验收记录：P5 君主机制（行动点 / 培养后代 / 君主位置）

对应 plan.md §P5。实现提交随 `feat(viewer): 君主行动点、培养后代与君主位置`。

## 做了什么

1) 数值集中（`mcp/tuning.ts`，新）：
   - `stepMonthsOf(stepYears)`、`stepFactorOf(months)`（≤1 月 0.4 / ≤3 月 0.65 / ≤6 月 0.8 / ≥12 月 1.0）；
   - `monarchApTotal(tech, economy, stepMonths) = clamp(round((4 + floor(tech/2) + floor(economy/40)) × stepFactor), 1..30)`；
   - `ENGINE_COMMAND_AP`（policy 2 / declare 4-6 / ally 2 / halt 1 / boost 3 / protect 1 / press 4-6 / intel 2；warApCost 按目标国力 4/5/6）；
   - 特殊动作成本：`CULTIVATE_HEIR_AP=3`、lead-army 4、dispatch-army 2、pacify-region 1；
   - `hashFraction` / `leadArmyRisk`（被俘 6%/年、阵亡 2%/年，确定性 hash）。
   - 科技/经济指标：development 快照的 eraLevel 均值 / 四能力均值×20（无数据时回退 tech=0、economy=min(200, 州数×2)）。
2) AP 账本（`mcp/engine.ts` + `mcp/monarch.ts`）：`MonarchState.byPolity[polityId] = {location, heirs, roundAp, journal, pinned,died,capturedUntil}`；
   每回合开始按本轮 stepMonths 重算 `apTotal`；`monarchPlan` 计划阶段列成本并校验预算、超支决策被拒并记 reason；`monarchCommit` 扣 AP、写 journal；`monarchRound` 返回 AP 使用。
   `stateGet` 暴露 `monarchByPolity` / `monarchLifespan`；`stateView` 暴露 `monarchPanels / monarchAp / monarchLocation / monarchHeirs`。
3) 特殊动作：`cultivate-heir`（3 AP，本回合不能有亲征/派兵；生成或推进 heir 的 birthYear/traits/competence/growth）、`lead-army`（4 AP，确定性被俘/阵亡 + 继位叙事）、`dispatch-army`（2 AP，叙事/记账）、`pacify-region`（1 AP，目标须在君主所在州或相邻州，落地为对本国 boost(mul=3) + journal）。
4) 自然死亡与继位：君主年龄按 lifespan（P3 默认 90）判定；有 heir 优先继位，无则走引擎原有逻辑；`died/capturedUntil` 计入面板。
5) UI（`mcp/viewer/app.js` + `style.css`）：君主页顶部 AP 条（`AP 4/6 · 已用 2`，下方一行「本回合 60 个月（倍率 1）· 科技 2.17 · 经济 44」），君主位置、后代、动作日志；AP 不足时「培养后代(3 AP)」按钮禁用并提示。

## 近似与已知限制（重要）

按 Lead 拍板，P5 走**不碰引擎**的近似路线（`mcp/tuning.ts` 注释里写明，方便以后接引擎钩子）：
1) **lead-army 的 +20% 战力尚未真实生效**：引擎唯一战力乘数 `api.war.led` 只由 appoint 干预注入；`LEAD_ARMY_BONUS=1.2` 目前只是记账/叙事常量（TODO）。被俘/阵亡风险是真实的（确定性 hash）。
2) **dispatch-army** 仅记账/叙事，不改战斗数值。
3) **pacify-region** 引擎没有可写的稳定度字段，落地为对本国一次 `boost(mul=3)` 发展干预 + 叙事；位置合法性（所在/相邻州）是真校验。
4) 特殊动作数据在 `Session.monarch.byPolity`（多国共存），非任务描述里的顶层字段；会话内存，重开/重启服务器会丢（沿用 cards 语义）。
5) LLM 提示词未注入 AP/特殊动作说明（`mcp/prompt.ts` 不在本次写权限内，需后续接线；mock/`decisions` 注入路径已验证）。
6) mock 君主不会主动下特殊动作，所以截图里「后代」显示「无」；heir/继位由单测覆盖（60/60）。
7) 单测为临时 esbuild 脚本（已删），未落 `mcp/selftest-*.ts`。

## 验证

- 门禁：`mcp/build.ps1` exit 0；root `tsc --noEmit` 0；`selftest` 31/31；`selftest-coast` 18/18；`selftest-tile-field` 30/30；`selftest-monarch` 29/29；`selftest-monarch-sandbox` 45/45；`node --check app.js` 0。
- 临时单测 60/60：AP 各档公式、倍率、预算拒绝、cultivate-heir 与亲征互斥/成长、自然死亡继位、lead-army 确定性阵亡/被俘、pacify 位置校验+boost、位置/面板字段。
- Playwright（seed=7 / cells=34043，5191 新 build，PID 16344）：跑 2 回合，君主页 AP 条 `AP 4/6 · 已用 2`（第二回合）、位置「威远府」、后代「无」、动作日志（boost 3AP、ally 2AP）；AP 2/4 时培养按钮显示「培养后代(3 AP) · AP 不够」并禁用。
- 截图：本目录 6 张。

## 待拍板

- 是否后续做 P5.5：在引擎加「亲征/派兵」乘数钩子（约 30 行，需同步改 interventions/编年史/selftest 计数），让 +20% 真实生效。
- LLM 提示词注入 AP 与特殊动作（改 `mcp/prompt.ts`）是否现在做。
- 临时单测是否落成常驻 selftest 文件。