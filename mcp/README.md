# civ-atlas MCP 工具层

把《文明与地图》(civ-atlas) 的推演引擎做成一个**独立进程的 MCP Server**,让 Claude Code、Cursor、其他 MCP 客户端直接驱动:

- 生成世界(纯计算,不联网)
- 把世界推到任意起始年并停住
- 读当前回合的完整状态(国家、君主、州数、国都、编年史)
- 提交外部命令(24 种干预:宣战/结盟/国策/迁都/天灾/立约/坚持打……)
- 单步或多年推演,返回各国增减与本回合大事
- **君主模式**:每回合暂停,给每个在世国家发局势简报,并发调用外部 LLM(或 mock)当君主,把决策编译成引擎命令,再统一推演一回合
- **DM 规则预设**(可选):降低引擎自动开战/自动议和/自动分裂的强度,把历史更多交给外部君主
- 导出会话 JSON 供复盘/对账,并提供回放对账工具

这一层**不修改**网页、不改现有内置 AI 助手、不改引擎源码;它只是复用 `src/gen` 下的纯计算模块。

## 前置条件

- Node 22+(仓库本身要求)
- 已经 `pnpm install`(需要仓库里的 `typescript` 与 `node_modules`)

## 构建与自检

```powershell
# 在仓库根目录(本机没有 pwsh 可执行文件,用 powershell 调)
powershell -NoProfile -ExecutionPolicy Bypass -File mcp/build.ps1

# 引擎自检(直接调门面,不经过协议)
node mcp/.build/mcp/selftest.js

# 协议自检(真的 spawn 一个 server 走 JSON-RPC)
node mcp/.build/mcp/selftest-protocol.js

# 君主回合自检(全程 mock,不联网)
node mcp/.build/mcp/selftest-monarch.js

# press 干预自检(引擎自动议和 vs 君主坚持打)
node mcp/.build/mcp/selftest-press.js

# DM 规则预设自检(预设生效、可复现、不改官方世界)
node mcp/.build/mcp/selftest-dm.js
```

构建产物在 `mcp/.build/`(已加进 `.git/info/exclude`,不进版本库)。`.runs/` 里是每次会话的日志。

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

Windows 下路径用正斜杠或双反斜杠都行。启动后客户端应该能看到 14 个 `civ_*` 工具。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `civ_world_create` | 生成世界:`seed`(必填)+ `params`(可选:cells/landFraction/plates/…) |
| `civ_session_open` | 开会话:`worldId` + `startYear`(必填)+ `stepYears`/`maxRounds`/`endYear`/`mode`(`auto`\|`monarch`)/`civParams`/`dmPreset`/`dmRules` |
| `civ_state_get` | 读当前状态:年份、在世国家(编号/国名/州数/国都/君主/稳定键)、已下命令、指纹 |
| `civ_orders_catalog` | 列出 24 种命令的字段与稳定键写法 |
| `civ_orders_submit` | 提交本回合命令(`from` 省略即填当前年;给 `polityId` 时按该国君主口吻编译),返回被拒收的命令及原因 |
| `civ_turn_step` | 推 `stepYears` 年(或指定 `years`),返回年份、各国增减、事件、拒收 |
| `civ_chronicle_get` | 按年份/类型读编年史 |
| `civ_session_export` | 导出会话 JSON(参数、世界参数、命令史、状态、编年史) |
| `civ_brief_get` | 读本回合各君主的简报(不调 LLM、不推演;未配置君主模式时按全部在世国家出) |
| `civ_monarch_setup` | 配置君主模式:哪些国家由外部君主接管(`polities`:all / 前 N 大国 / 编号数组)、每国每回合最多几条命令、`mock`、服务商/模型/Key/温度/超时 |
| `civ_monarch_round` | 跑一个君主回合:简报 → 并发 LLM/mock → 编译命令 → 统一推演 → 写日志 |
| `civ_monarch_status` | 看君主模式配置与已跑回合数(不含 Key) |
| `civ_dm_preset` | 看 DM 规则预设的默认值(7 项)、换算后的旋钮、每项说明;可传 `overrides` 预览自定义 |
| `civ_session_verify` | 回放对账:用同一世界 + 命令史重推,比较 16 位 civ 指纹与年份 |

## 君主模式(任务二)

```
1. civ_world_create     { "seed": 7, "params": { "cells": 12000 } }
      → worldId
2. civ_session_open     { "worldId": "...", "startYear": 2500, "stepYears": 5,
                          "maxRounds": 12, "mode": "monarch" }
      → sessionId、year=2500
3. civ_monarch_setup    { "sessionId": "...", "polities": "all", "mock": true }
   # 或接真模型:
   # { "sessionId": "...", "polities": 8, "provider": "deepseek",
   #   "model": "deepseek-chat", "apiKey": "sk-...", "temperature": 0.7 }
4. civ_brief_get        { "sessionId": "..." }        // 可选:先看每国简报
5. civ_monarch_round    { "sessionId": "..." }        // 每轮一次
      → decisions[](每国:原因/原始命令/编译后命令/拒收/mock|llm|error/耗时)
        changes[](各国州数增减)、events、fingerprint、finished
6. 重复 5 直到 finished=true
7. civ_session_verify   { "sessionId": "..." }        // 回放对账:ok=true
8. civ_session_export   { "sessionId": "..." }
```

- `polities`: `"all"` = 所有在世国家(上限 12);数字 = 前 N 个大国;数组 = 指定 `[6, 54, 61]`。
- `polities` 里的国家才会被外部君主接管;其余国家仍由引擎规则自动行为。
- 君主命令以「我们国家」为主语:不写 `from`/`a`,目标国写 `b`(编号或 `"P6"`)。支持 `policy` / `declare` / `ally` / `halt` / `boost` / `protect` / `press`,每国每回合默认最多 3 条。
- 命令编译会逐条校验(目标是否在世、宣战是否接壤、参数是否合法),坏的只拒自己,并把中文原因写进 `decisions[].rejected`,方便下一轮喂回模型。
- 同一回合的命令按国家编号升序落地,和模型返回快慢无关;整回合只调一次 `playTurn`,不打断引擎的确定性。
- LLM 请求在会话层异步并发等待,引擎调用是同步且快的;推演线程/进程不在等网络。
- `mock: true` 时不联网,用确定性规则模拟每个君主的决策,适合跑通流程、做回放对账和 CI。
- 真模型 Key 只在本次进程内存里;日志与导出都不含 Key。DeepSeek 默认 `https://api.deepseek.com` + `deepseek-chat`(环境变量 `DEEPSEEK_API_KEY`);百炼默认 `https://dashscope.aliyuncs.com/compatible-mode/v1` + `qwen-plus`(环境变量 `DASHSCOPE_API_KEY`);也可 `provider: "custom"` + `baseUrl` 接本地 Ollama 等 OpenAI 兼容服务。

## DM 规则预设与 press(任务三)

- **DM 规则预设**(`civ_session_open` 的可选参数):
  - `dmPreset: true` 启用默认 7 项:`war.odds` ×½(自动开战减半)、`war.truce` 10 年、`war.length` [8,30]、`war.rest` 2 年(更不容易自动议和)、`diplo.pact` ×½、`diplo.betray` 关、`split.odds` ×½。
  - `dmRules: { "war.odds": 0.25 }` 可只覆盖其中几项;`civ_dm_preset` 工具能看每项的官方值与换算后的旋钮。
  - 预设通过 `tuningPatch()` 换算成 `CivParams.knobs`,随世界保存;不启用 = 不放 `knobs`,与官方世界逐字节一致。
- **press(第 24 种干预)**:外部君主「坚持打」。
  - 从 `from` 那年起,这一仗的引擎自动议和、僵持罢兵、攻方受降都不再生效,直到一方亡国、`until` 到期,或君主自己再下 `ally` / `halt` / `destroy` 等强制结束。
  - `b` 可省略(= 跟谁都继续打);给了 `b` 就只管跟这一国的仗。
  - 讨伐民变的战争不吃 `press`(民变由 `split` 规则管,和对外命令分开)。

## 参数全部可自定义

没有写死的「默认对局」:世界生成参数、起始年、每回合年数、回合数、结束年、引擎参数(`civParams`)、接管的君主数量、每国命令上限、模型/温度/超时都由调用方给。想固定一套配置,就由调用方每次传同样的值,或者自己包一层脚本/MCP 客户端配置。

`civParams` 可传引擎的 `CivParams` 覆盖项,例如 `tempo`、`regionArea`、`names`、`knobs`(每个世界一套旋钮)。`interventions` 可以放"起始年之前的历史命令"。

## 确定性

- 同一 `seed` + 同生成参数 → 逐位一致的世界(引擎本身保证)。
- 同一世界 + 同起始年 + 同一串命令 + 同推演年数 → `fingerprint` 一致(`civ_state_get`、`civ_turn_step`、`civ_monarch_round` 都会返回 16 位指纹)。
- 会话只把命令交给引擎,不引入随机;外部模型决策的不可复现性只体现在"下了什么命令",不在引擎内部。把每轮命令按顺序重放,结果可精确复现(`civ_session_verify` 就是干这个的)。
- 每轮日志写在 `mcp/.runs/<sessionId>/round-XXXX.json` 与 `monarch-round-XXXX.json`,`rounds.jsonl`、`monarch-rounds.jsonl` 是精简流水。

## 当前阶段

- **任务一(已完成)**:`mode="auto"` 的引擎工具层,8 个基础工具。
- **任务二(已完成)**:君主回合循环,新增 5 个君主工具;`mock` 与真 LLM 两条路径;回放对账。
- **任务三(已完成)**:DM 规则预设(`tuningPatch` 写 `CivParams.knobs`,`civ_dm_preset` 查看/覆盖)+ 新增 `press` 干预(引擎自动议和 vs 君主坚持打);官方世界确定性逐位不变(21/21 对账通过)。

## 目录

```
mcp/
  engine.ts          无头引擎门面(世界/会话/状态/推演/编年史/导出)
  orders.ts          原始命令清洗与目录
  monarch.ts         君主回合编排(setup/brief/round/status/verify)
  prompt.ts          君主系统提示词
  llm.ts             DeepSeek/百炼/自定义 OpenAI 兼容 + mock 决策
  tools.ts           14 个 MCP 工具定义与分发
  server.ts          JSON-RPC 2.0 over stdio(逐行串行处理)
  selftest.ts        引擎自检(31 项)
  selftest-protocol.ts  协议自检(16 项)
  selftest-monarch.ts   君主回合自检(29 项,mock)
  selftest-press.ts     press 干预自检(16 项)
  selftest-dm.ts        DM 规则预设自检(17 项)
  tsconfig.build.json / build.ps1
  .build/            产物(不提交)
  .runs/             会话日志(不提交)
```

`src/gen/civ/monarch.ts` 是纯计算的君主模块(简报生成、命令编译、选国),不依赖 DOM/网络,可以被 MCP 层和将来的浏览器层共用。
