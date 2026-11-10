# civ-atlas MCP 工具层

把《文明与地图》(civ-atlas) 的推演引擎做成一个**独立进程的 MCP Server**,让 Claude Code、Cursor、其他 MCP 客户端直接驱动:

- 生成世界(纯计算,不联网)
- 把世界推到任意起始年并停住
- 读当前回合的完整状态(国家、君主、州数、国都、编年史)
- 提交外部命令(23 种干预:宣战/结盟/国策/迁都/天灾/立约……)
- 单步或多年推演,返回各国增减与本回合大事
- 导出会话 JSON 供复盘/对账

这一层**不修改**网页、不改现有内置 AI 助手、不改引擎源码;它只是复用 `src/gen` 下的纯计算模块。

## 前置条件

- Node 22+(仓库本身要求)
- 已经 `pnpm install`(需要仓库里的 `typescript` 与 `node_modules`)

## 构建与自检

```powershell
# 在仓库根目录
pwsh mcp/build.ps1

# 引擎自检(直接调门面,不经过协议)
node mcp/.build/mcp/selftest.js

# 协议自检(真的 spawn 一个 server 走 JSON-RPC)
node mcp/.build/mcp/selftest-protocol.js
```

构建产物在 `mcp/.build/`(已加进 `.git/info/exclude`,不进版本库)。

## 接到 MCP 客户端

Claude Code(`.mcp.json` 或用户级配置)、Cursor(`mcp.json`)都类似:

```json
{
  "mcpServers": {
    "civ-atlas": {
      "command": "node",
      "args": ["D:/Eugem's projects/civ-atlas/mcp/.build/mcp/server.js"],
      "env": {}
    }
  }
}
```

Windows 下路径用正斜杠或双反斜杠都行。启动后客户端应该能看到 8 个 `civ_*` 工具。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `civ_world_create` | 生成世界:`seed`(必填)+ `params`(可选:cells/landFraction/plates/…) |
| `civ_session_open` | 开会话:`worldId` + `startYear`(必填)+ `stepYears`/`maxRounds`/`endYear`/`civParams` |
| `civ_state_get` | 读当前状态:年份、在世国家(编号/国名/州数/国都/君主/稳定键)、已下命令、指纹 |
| `civ_orders_catalog` | 列出 23 种命令的字段与稳定键写法 |
| `civ_orders_submit` | 提交本回合命令(`from` 省略即填当前年),返回被拒收的命令及原因 |
| `civ_turn_step` | 推 `stepYears` 年(或指定 `years`),返回年份、各国增减、事件、拒收 |
| `civ_chronicle_get` | 按年份/类型读编年史 |
| `civ_session_export` | 导出会话 JSON(参数、世界参数、命令史、状态、编年史) |

## 一次完整会话(工具调用顺序)

```
1. civ_world_create       { "seed": 7, "params": { "cells": 12000 } }
   → worldId
2. civ_session_open       { "worldId": "...", "startYear": 1200, "stepYears": 5, "maxRounds": 12 }
   → sessionId、year=1200、当前国家列表
3. civ_state_get          { "sessionId": "...", "chronicle": true }
   → 找最大国家的 polities[0].key(如 "polity:c32577#0")
4. civ_orders_catalog     {}                       // 需要时查字段
5. civ_orders_submit      { "sessionId": "...", "orders": [
                             { "kind": "policy", "a": "polity:c32577#0", "preset": "expand" },
                             { "kind": "declare", "a": "...", "b": "polity:c999#1" } ] }
6. civ_turn_step          { "sessionId": "..." }
   → fromYear/toYear、polities[].delta、events、fingerprint
7. 重复 3–6 直到 finished=true
8. civ_session_export     { "sessionId": "..." }
```

## 参数全部可自定义

没有写死的「默认对局」:世界生成参数、起始年、每回合年数、回合数、结束年、引擎参数(`civParams`)都由调用方给。想固定一套配置,就由调用方每次传同样的值,或者自己包一层脚本/MCP 客户端配置。

`civParams` 可传引擎的 `CivParams` 覆盖项,例如 `tempo`、`regionArea`、`names`、`knobs`(每个世界一套旋钮)。`interventions` 可以放"起始年之前的历史命令"。

## 确定性

- 同一 `seed` + 同生成参数 → 逐位一致的世界(引擎本身保证)。
- 同一世界 + 同起始年 + 同一串命令 + 同推演年数 → `fingerprint` 一致(`civ_state_get`、`civ_turn_step` 都会返回 16 位指纹)。
- 会话只把命令交给引擎,不引入随机;外部模型决策的不可复现性只体现在"下了什么命令",不在引擎内部。把每轮命令按顺序重放,结果可精确复现。
- 每轮日志写在 `mcp/.runs/<sessionId>/round-XXXX.json`,`rounds.jsonl` 是精简流水。

## 当前阶段

- **本阶段(任务一)**:`mode="auto"` 的引擎工具层。所有工具可用,但没有「君主决策阶段」。
- 下一阶段(任务二):君主回合循环 —— 每回合暂停、按国家生成简报、并发调用外部 LLM、收集结构化命令、再推演;会话日志增加 AI 原文与回放。
- 再下一阶段(任务三):DM 规则预设(`tuningPatch` 写 `CivParams.knobs`)+ 新增 `press` 干预(引擎自动议和 vs 君主坚持打)。

## 目录

```
mcp/
  engine.ts          无头引擎门面(世界/会话/状态/推演/编年史/导出)
  orders.ts          原始命令清洗与目录
  tools.ts           8 个 MCP 工具定义与分发
  server.ts          JSON-RPC 2.0 over stdio
  selftest.ts        引擎自检
  selftest-protocol.ts  协议自检
  tsconfig.build.json / build.ps1
  .build/            产物(不提交)
  .runs/             会话日志(不提交)
```
