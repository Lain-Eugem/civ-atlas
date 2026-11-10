# civ-atlas MCP 工具层

把《文明与地图》(civ-atlas) 的推演引擎做成一个**独立进程的 MCP Server**,让 Claude Code、Cursor、其他 MCP 客户端直接驱动:

- 生成世界(纯计算,不联网)
- 把世界推到任意起始年并停住
- 读当前回合的完整状态(国家、君主、州数、国都、编年史)
- 提交外部命令(26 种干预:宣战/结盟/国策/迁都/天灾/立约/坚持打/小事件/故事事件……)
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

# DM 小决策自检(天灾/贸易编译、mock 回合、日志、回放对账)
node mcp/.build/mcp/selftest-dm-oracle.js

# 小事件裁决层核心自检(估算 token、预算打包、串行队列、超时/熔断、Jev 客户端)
node mcp/.build/mcp/selftest-petty-core.js

# 小事件裁决层端到端自检(v2 引擎效果、mock 回合、君主合流、降级、回放)
node mcp/.build/mcp/selftest-petty-oracle.js

# 自定义场自检(确定性 hash、统计、PNG 逐字节一致、改样式不改数值、数值解码、坏帧)
node mcp/.build/mcp/selftest-field.js

# 魔力动态层自检(逐年演化 + 影响 city.capacity;强度 0 = 官方指纹;同配置可复现)
node mcp/.build/mcp/selftest-magic.js

# 可配置场自检(玩家自设影响口/强度;强度 0 = 官方指纹;同 spec 可复现;MCP 工具)
node mcp/.build/mcp/selftest-field-plugin.js

# 官方 .civplugin 加载器自检(QuickJS 直装/源码目录/非推演插件拒绝/MCP 开会话/回放)
node mcp/.build/mcp/selftest-plugin-loader.js

# 地块级场自检(按 mesh 地块逐年演化 + 落盘 cell 层往返;强度 0 = 官方指纹)
node mcp/.build/mcp/selftest-tile-field.js
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

Windows 下路径用正斜杠或双反斜杠都行。启动后客户端应该能看到 21 个 `civ_*` 工具。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `civ_world_create` | 生成世界:`seed`(必填)+ `params`(可选:cells/landFraction/plates/…) |
| `civ_session_open` | 开会话:`worldId` + `startYear`(必填)+ `stepYears`/`maxRounds`/`endYear`/`mode`(`auto`\|`monarch`)/`civParams`/`dmPreset`/`dmRules`/`magicField`/`fields`(最多 4 份自定义场,可带 `unit: "tile"` 按地块记)/`plugins`(最多 4 个官方 .civplugin 路径) |
| `civ_state_get` | 读当前状态:年份、在世国家(编号/国名/州数/国都/君主/稳定键)、已下命令、指纹、`fields` 与 `layers`(含按地块图层) |
| `civ_orders_catalog` | 列出 26 种命令的字段与稳定键写法 |
| `civ_field_catalog` | 列出自定义场能接的影响口(按州/按政治体)、强度档位与一份示例 spec(含按地块场的写法) |
| `civ_orders_submit` | 提交本回合命令(`from` 省略即填当前年;给 `polityId` 时按该国君主口吻编译),返回被拒收的命令及原因 |
| `civ_turn_step` | 推 `stepYears` 年(或指定 `years`),返回年份、各国增减、事件、拒收 |
| `civ_chronicle_get` | 按年份/类型读编年史 |
| `civ_session_export` | 导出会话 JSON(参数、世界参数、命令史、状态、编年史) |
| `civ_brief_get` | 读本回合各君主的简报(不调 LLM、不推演;未配置君主模式时按全部在世国家出) |
| `civ_monarch_setup` | 配置君主模式:哪些国家由外部君主接管(`polities`:all / 前 N 大国 / 编号数组)、每国每回合最多几条命令、`mock`、服务商/模型/Key/温度/超时 |
| `civ_monarch_round` | 跑一个君主回合:简报 → 并发 LLM/mock → 编译命令 → 统一推演 → 写日志 |
| `civ_monarch_status` | 看君主模式配置与已跑回合数(不含 Key) |
| `civ_dm_preset` | 看 DM 规则预设的默认值(7 项)、换算后的旋钮、每项说明;可传 `overrides` 预览自定义 |
| `civ_dm_oracle_setup` | 配置 DM 小决策:离线 `mock`,或 `baseUrl` + `model`(OpenAI 兼容)+ 可选 Key/温度/超时/每回合上限;可 `probe` 测连通 |
| `civ_dm_oracle_status` | 看 DM 小决策状态(模式/上限/已跑回合/最近一回合;不含 Key) |
| `civ_dm_round` | 单独跑一个 DM 回合(只做天灾/小贸易),或传 `decisions` 手动指定 |
| `civ_petty_setup` | 配置小事件裁决层:离线 `mock`,或官方 Jev(`apiKey` 或环境变量)+ `profile`(L1/L2/L3)/`maxQuestions`/token 预算/队列参数;可 `probe` 测连通 |
| `civ_petty_status` | 看小事件裁决层状态(模式/画像/预算/队列健康/已跑回合;不含 Key) |
| `civ_petty_round` | 单独跑一个小事件回合:扫描 → 估算+打包 → 串行请求 → 确定性抽样 → v2 引擎生效 → 推演,返回决策与摘要 |
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

## DM 小决策(接另一台设备的本地模型)

给 DM(推演主持人)留的外部模型接口:让它决定引擎里没有的小事——**天灾、小贸易结果**。天灾会编译成引擎的 `disaster` 干预(真改历史);小贸易只写进 DM 日志(引擎没有贸易原语,不产生命令)。

另一台设备上跑 OpenJEV / Ollama / LM Studio / vLLM 都行,只要它提供 OpenAI 兼容的 `/v1/chat/completions`:

- `civ_dm_oracle_setup`:`{ "sessionId": "...", "baseUrl": "http://192.168.1.20:8000/v1", "model": "openjev", "maxDecisions": 2 }`。
- 也可以不传参数,改用环境变量 `CIV_DM_BASE_URL`、`CIV_DM_MODEL`、`CIV_DM_API_KEY`(本地模型通常不需要 Key)。
- `mock: true` 用离线确定性 mock,不联网,适合演示/自检。
- `civ_dm_oracle_status`:看是否连上、模式、每回合上限、已跑回合(返回值不含 Key)。
- `civ_dm_round`:单独跑一个 DM 回合(只做小决策);配置好 DM 后,君主回合会自动把 DM 决策合并进同一批命令,通常不用单独调。
- 能决定的只有 `disaster`(plague / famine / quake / pandemic,需要城/州/国家目标)、`trade`(a/b 两个国家、货物、赚/赔/平,仅叙事)与 `story`(故事事件,见下);其它决策会被拒收。
- 天灾的 `from` 必须是当前回合年,所以 DM 只能在整个推演"当下"制造灾祸;所有命令都会写进命令日志和 `dm-round-*.jsonl`,回放对账仍然逐位一致。

### DM 故事事件(story)

除了白名单里的天灾/贸易,DM 还能**根据当前故事自己写一件小事**,并让它真的影响推演。命令会长成:

```json
{
  "kind": "story",
  "from": 2510,
  "title": "河谷决堤",          // ≤40 字,必填
  "text": "连日暴雨冲垮了河堤,城外的田被淹。",   // ≤160 字,可选
  "a": "polity:c1234#0",       // 可选:事件主角国家
  "effects": [                 // ≤3 条
    { "type": "sack", "city": "settlement:c1234#0", "loss": 2 },
    { "type": "capacity", "city": "settlement:c1234#0", "delta": -15 },
    { "type": "dev", "years": 3 },
    { "type": "note", "text": "民间传为凶兆" }
  ]
}
```

四类效果都落到引擎真实状态:

- `sack`:城市折损(1 最轻 / 3 最重),写进 `Settlement.sacks`,人口下滑后按引擎原有节奏恢复。
- `capacity`:改城市人口上限(−20%…+20%)。写进 `Settlement.reshaped` 的时间线:**降当即生效,升 60 年线性涨**,事件之前的历史人口上限不变。
- `dev`:委托引擎 `boost`(发展速度 ×3,管 1–5 年),需要 `a`。
- `note`:纯叙事,只进日志/DM 摘要。

限制:不能改国界、战争/结盟、灭国、换君主、地形(这些仍是君主命令或引擎规则的事);每条事件最多 3 条效果;未知效果/坏键会被拒收并写进 rejected。命令进日志、回放逐位一致;不启用 DM 时官方世界完全不受影响。

使用:真模型时 DM 只要在 JSON 里返回 `{"kind":"story", ...}` 即可;`mock: true` 不会自动编故事(保持自检的确定性)。查看器的 AI 决策页会把这类命令标成「故事事件」。

浏览器查看器里也有对应面板:展开「DM 小决策」→ 勾选「本局启用 DM」→(假模型就勾 mock;真模型填地址/模型)→ 点「连接 / 测试 DM」;之后「跑一回合」时 DM 小决策会随君主命令一起提交,AI 决策页会显示每条天灾/贸易。

小事件裁决层也有独立面板:「小事件裁决层」→ 勾选「本局启用小事件」→ mock 演示或填官方 Jev 的 API Key(也可预先设 `JEV_API_KEY` 环境变量)→ 点「连接 / 测试 Jev」;之后跑回合时会先结算小事,再让君主/DM 决策,AI 决策页会多出「小事件裁决」块。

## 小事件裁决层(官方 Jev)

把「不涉及君主战略、选项有限、结果可以用概率表达」的微观判定从 DM 手里拆出来,单独交给 Jev 裁决;DM 只看结算后的既定事实,不再花 token 决定这些小事。每回合顺序:**扫描待裁决事件 → 估算 token + 打包 → 串行队列请求 Jev → 概率转确定性抽样 → v2 引擎效果落地 → 君主/DM 决策 → 一次推演**。

### 配置官方 Jev

- 在 defapi 控制台拿 API Key,然后三样配置:
  - `baseUrl`:`https://api.defapi.org`(默认)
  - `model`:`typesafe/jev-1.14.0`(默认)
  - API Key:环境变量 `JEV_API_KEY`(也认 `DEFAPI_API_KEY`),或调用 `civ_petty_setup` 时直接传 `apiKey`;Key 只在本次进程内存里,不写日志。
- 也可以用环境变量 `JEV_BASE_URL`、`JEV_MODEL` 覆盖前两项。
- 第一次配好先 `probe: true` 测连通:`civ_petty_setup { "sessionId": "...", "probe": true }`。
- 官方请求体没有 `temperature` / `top_p` 字段,温度由服务端固定;确定性靠「记录每回合概率与抽样结果 + 命令进日志 + 回放对账」保证,不靠固定客户端参数。
- 成本按官方计价:输入 $0.084 / 百万 token(以官方文档为准);离线演示用 `mock: true`。

### 真实 API 实测(2026-11-10)

用官方 Key(环境变量 `JEV_API_KEY`)跑过一轮真实小事件回合,参数:seed 7 / 12,000 地块 / 第 1,200 年 / 每回合 5 年 / 画像 L2 / 每批最多 8 问:

- 扫描 19 件小事 → 打包 2 批(P0 8 问、P1 8 问)→ **串行 2 次请求,合计约 1.2 秒** → 16 条决定 → 6 条引擎命令 → 0 条降级;`civ_session_verify` 回放一致。
- 实际用量:**input 2,912 / output 450 tokens,cost `$0.000244608`**(输出计费为 0);客户端估算 2,625 tokens,比实际少约 11%,仍在 4,250 预算内。
- 响应里 `model` 回显为 `typesafe/jev-1.14-20261014`(请求写 `typesafe/jev-1.14.0` 也接受),`provider` 为 `TypeSafe`;单次请求约 1.2 秒。
- 君主回合(petty 真 Jev + DM/君主 mock)也跑通:`petty.source='jev'`、6 条 petty 命令 + 1 条 DM 命令、回放一致。
- 实测注意:
  - `noul` 问题的 `criteria` 如果给,必须是对象 `{ true: "...", false: "..." }`;传字符串会 400(客户端已提前拦截)。内置 20 个模式都不带 criteria,不受影响。
  - 请求没有 `temperature` / `top_p`,不要试图在客户端固定温度;复现性靠记录概率+抽样结果+命令回放。
  - Key 只从环境变量或工具参数进内存,不写盘、不进日志;不要把 Key 写进 README、配置或仓库文件。

PowerShell 里临时设 Key(只对当前窗口生效):

```powershell
# 临时（只对当前 PowerShell 窗口生效）
$env:JEV_API_KEY = (Get-Content -Raw C:\path\to\jev-key.txt).Trim()

# 持久（写入当前 Windows 用户的环境变量，新开窗口生效）
[Environment]::SetEnvironmentVariable('JEV_API_KEY', (Get-Content -Raw C:\path\to\jev-key.txt).Trim(), 'User')
```


### 用法

```
1. civ_world_create      { "seed": 7, "params": { "cells": 12000 } }
2. civ_session_open      { "worldId": "...", "startYear": 2500, "stepYears": 5, "mode": "monarch" }
3. civ_petty_setup       { "sessionId": "...", "mock": false, "profile": "L2", "maxQuestions": 8, "probe": true }
4. civ_monarch_setup     { "sessionId": "...", "polities": "all", "mock": true }   # 或接真模型
5. civ_monarch_round     { "sessionId": "...", "years": 5 }    # 自动先结算小事,再跑君主回合
```

只跑小事件层、不跑君主:`civ_petty_round { "sessionId": "...", "years": 5 }`。
`civ_petty_status` 看模式、画像、预算、队列健康(排队/超时/熔断/平均等待)、已跑回合,返回值不含 Key。

### 行为与边界

- **画像**:`L1` 只开 P0(灾害/战争小事)、`L2` 再加 P1(经济/社会)、`L3` 全开(含基建);默认 L2。
- **20 个模式**:经济 4、环境 4、军事 4、社会 4、基建 4;每个模式只出 2–4 个预定义选项,模型只在这些选项里给概率。
- **token 预算**:默认硬上限 4250、目标 4000、环境描述约 45%、每批最多 8 个问题;超预算先丢 P1/P2,永不裁 P0;每回合日志记录估算 token、实际 usage、每级占用。
- **严格串行**:同一时刻只有一个 Jev 请求在途;优先级 P0 > P1 > P2,同级 FIFO;P0 超时 60s、其它 30s;回合总等待 120s;排队 >40 时 P2 直接降级;连续失败 5 次熔断,下一回合开头探活一次。
- **降级**:服务不可达/超时/格式异常时,该批小事回退引擎确定性规则,日志标 `engine-rule` 与原因,回合不会卡死。
- **v2 引擎效果**:小事不是纯叙事——`petty` 干预会把「折损」写进城市 `sacks`(人口下滑,之后自然恢复),或「发展」委托给引擎 `boost`;道路类(修路/断路)目前只记叙事(道路是推演结束统一算的,途中没有逐条增删入口)。
- **确定性**:概率→抽样用引擎统一随机流,种子 `petty:<事件ID>:<年份>:<国家ID>`;同一串决策重放结果逐位一致。DM 只会看到「某国某城折损一级」这类已结算摘要,看不到概率/选项/置信度/队列。

## 自定义场(原型:计算层 / 渲染层分开)

这个原型回答一个具体问题:能不能给地图加「自己带生成公式、能影响数值」的场(魔脉浓度、矿产、辐射)?当前版本先把**计算和显示彻底分开**:

- **计算层** `src/gen/field.ts`:纯函数,产出一个 `FieldFrame{ kind, cells, seed, values: Float32Array, stats, hash }`,每个地块一个精确数(0–1 相对浓度)。同 world+kind+seed+scale+version **逐字节一致**;`hash` 是 FNV-1a,只覆盖数值,和渲染样式无关。三种场:魔脉(灵脉状)、矿产(团簇状)、辐射(热点状)。
- **渲染层** `mcp/field-render.ts`:只读 `values`,自己决定色带/拉伸/等高线/辉光/浮雕/透明度;绝不回写数值,改样式只重画 PNG,不重算、不重跑推演。显示平滑只影响 PNG,hover/导出仍是原始值。
- **接口**:`GET /api/field/meta|base|data|legend`;`base` 是 1024×512 透明底 PNG(叠在底图上),`data` 返回 base64 原始 Float32 值 + hover 索引网格 + `hash` + 图例。查询参数:`kind=magic|ore|radiation`、`seed`、`scale`、`ramp=ember|viridis|magma|ice`、`stretch=p1p99|minmax`、`opacity`、`contour=0|2..16`、`glow`、`hillshade`、`smooth`。
- **查看器**:展开「自定义场 · 原型」→ 勾「显示场叠加层」→ 选场/色带/拉伸 →「生成 / 刷新场」;地图上出现半透明热力层,鼠标悬停显示该地块原始值与 `hash`;「导出数值 JSON」导出全部地块的计算层原值(8 位小数)。
- **范围**:目前是生成期静态场(跟世界走,不随历史年份变化)。按州逐年演化(表卡 + 影响口)和地块级逐年演化还没接进引擎,是下一步。
- **自检**:`node mcp/.build/mcp/selftest-field.js`(43 项:同参数 hash 相同、换样式 PNG 变但数值/hash 不变、统计与数值一致、PNG 逐字节可复现、hover 网格抽样一致、坏帧校验)。

## 魔力动态层(原型:引擎逐年演化 + 真影响数值)

静态场只能看;这一层把「魔脉」做成**跟着历史逐年变化、并且真的影响推演**的场,思路来自引擎自带的官方示例插件 `examples/plugins/magic/`(表卡 + 影响口 + 图层,不依赖 QuickJS,内联成原生 `SimPlugin`,见 `src/gen/civ/magicPlugin.ts`):

- **引擎侧**:三张按州记的表——`vein`(灵脉,约 1/16 的州有,一次生成后不变)、`rural`(接官方乡村人口表)、`magic`(每 5 年按 `spread/seep/fade/drain` 扩散、渗出、衰减、被人口耗散);`influences: ['city.capacity']` 把浓度换算成城人口上限倍率(强度 1 时 0–100 浓度≈1–2 倍)。图层每 50 年存一帧(`keep=50`),跟着 `Civ.simLayers` 一起存档/回放。
- **开关**:`civ_session_open` 加 `magicField: true`(默认强度 1)或 `magicField: number`(0–3,0.5 一档);`civ_state_get` 返回 `magic`(强度 + 图层元数据/统计)。**不给 `magicField` 时,引擎行为和官方规则逐字节一致**;`magicField: 0` 只记图层、不改数值,也拿来做确定性对账。
- **渲染层** `mcp/magic-render.ts`:只读 `simLayers` 的 `magic` 层,按当前回合选帧(取不晚于该年的最后一帧),两帧之间可线性插值;`GET /api/magic/meta|base|data`(PNG 叠在底图上,`data` 给 hover 网格/图例/统计)。
- **查看器**:顶部勾「魔力场」→ 强度(0–3);「本局动态层 · 魔力」面板可选图层年份、回到本回合,图例显示真实刻度(0–100);hover 同时显示地块静态场与州魔力浓度。
- **自检**:`node mcp/.build/mcp/selftest-magic.js`(34 项:强度 0 = 官方指纹、强度 1.5 不同、同配置两次逐位一致、图层元数据/帧数、≥60% 共有城人口更高、回合后出现新帧、回放对账、工具开关、强度归一化)。

## 可配置场(阶段A:玩家自己造「铲子」)

魔力层是内置的**一个**设定;这一层把同一套机制做成工厂:玩家自己填一份 `FieldSpec`,`civ_session_open` 最多带 4 份,每份都会在引擎里生成一张逐年演化的州级表、挂一个图层、并接到玩家选的影响口上。**影响哪些数值不做预设,由玩家在 `influences` 里写。**

```jsonc
// civ_session_open 的 fields 里可以放这样的对象(或直接用 civ_field_catalog 的 example)
{
  "id": "mana", "name": "魔脉浓度",
  "density": 0.06,                 // 有多少比例的州有灵脉(0–1)
  "sourceMin": 40, "sourceMax": 100,
  "spread": 0.05, "seep": 0.02, "fade": 0.002, "drain": 0.01, "crowd": 100,
  "max": 100, "every": 5,          // every 只能取 0.5/1/5/10/20/100/1000
  "strength": 1,                   // 0–3(0.5 一档);0 = 只记图层、不影响数值
  "influences": [                  // 1–6 条,端口来自 civ_field_catalog
    { "target": "city.capacity", "perPoint": 0.01 },
    { "target": "war.odds", "perPoint": -0.02 },
    { "target": "unrest.add", "perPoint": 0.03 }
  ],
  "layer": { "title": "魔脉浓度", "keep": 50 }
}
```

- **能接哪些口**:`civ_field_catalog` 返回全部单栏影响口(`city.capacity`、`rural.capacity`、`war.odds`、`war.power`、`split.odds`、`unrest.add`、`assim.rate`、`control.reach`、`plague.odds`、`plague.loss` 等,按州或按政治体)。`region` 口逐州乘/加;`polity` 口按该政治体治下州的平均值换算。
- **校验**:`fieldSpecProblems` / `cleanFieldSpec` 做中文校验与默认值补全(坏的 id、保留名 `vein`/`rural`、缺 `density`、未知端口、超过 6 条影响口、坏颜色/`keep` 都会被拒);`civ_session_open` 会逐份报 `fields[i]:…`。
- **不乱改默认**:不带 `fields`、或每份 `strength: 0` 时,引擎指纹与官方逐字节一致;同 spec 两个会话逐位一致。
- **工具**:`civ_field_catalog` 列端口 + 一份可直接抄的示例;`civ_state_get` 返回 `fields`(id/name/spec)与 `layers`(by/id/unit/年份/帧数/统计),图层可以拿这个做显示。
- **自检**:`node mcp/.build/mcp/selftest-field-plugin.js`(46 项:spec 校验、强度 0 = 官方指纹、强度 1 影响人口、同 spec 复现、多影响口、图层元数据、回合新帧、回放对账、MCP 工具)。

## 官方推演插件(阶段B:直接装 `.civplugin`)

网页里那套官方格式的推演插件(`examples/plugins/` 下的 `.civplugin` 文件,或 `plugin.json + main.js` 的源码目录),现在也能直接装进 MCP 会话——玩家不用改引擎代码,把插件路径给 `civ_session_open` 就行:

```jsonc
{
  "worldId": "w-…", "startYear": 1200, "stepYears": 50,
  "plugins": ["examples/plugins/magic/magic.civplugin"]   // 最多 4 个;相对 MCP 进程工作目录或绝对路径
}
```

- **怎么跑**:`mcp/plugin-loader.ts` 用 QuickJS 离线装(`quickjsPlugin` / `openPluginFileFully` / `simPluginsOn`,和网页同一套运行时);mcp 产物是 CommonJS,wasm 用 `createRequire(__filename)` 解析后 `new WebAssembly.Module` 只编译一次,不碰 `import.meta`。
- **装什么**:只装 `role: "sim"` 的推演插件(插件清单里的表卡/图层/影响口/命令照旧);地图/工具插件会被拒并说明原因。同一 id 不能给两次;给目录时现场打包成 `.civplugin` 字节。
- **进引擎**:插件与内置魔力场、自定义场走同一个 `CivParams.plugins` 通道,一局一份 QuickJS 实例;`civ_session_open` 的 summary 与 `session.json` 记 `plugins` id;`civ_state_get.layers` 能看到插件图层,插件命令进命令史,回放对账照旧。
- **确定性**:同一 world seed + 同一插件文件 + 同一串命令 → 逐位一致;换了插件文件(sum 变)结果当然不同。
- **错误**:路径不存在、不是推演插件、重复 id、超过 4 个、插件表公式有问题,都以中文错误返回,不会把半装好的插件带进引擎。
- **自检**:`node mcp/.build/mcp/selftest-plugin-loader.js`(22 项:直装 `.civplugin`/装源码目录/坏路径/非推演插件拒绝/重复拒绝/MCP 开会话/指纹变化/两次一致/回放对账)。

## 地块级场(阶段C:场在每块地上逐年长)

阶段A 的场按州记(每州一个值);阶段C 让场直接按**地块**记:每块地一个值,每几年扩散/衰减,画出来是逐格变化的热力图,同时还能聚合成州值去影响官方数值。

- **怎么用**:`civ_session_open` 的 `fields` 里给带 `unit: "tile"` 的 spec(不写 = `"region"`,和阶段A 一样);示例 spec 是 `src/gen/civ/fieldPlugin.ts` 的 `EXAMPLE_TILE_FIELD_SPEC`(id `ley`),`civ_field_catalog` 会连端口和示例一起列出来。
- **地块表怎么建**:表按世界**全部**地块记(`count = mesh.n`,邻接用 `mesh.adjStart/adj`),不是只算宜居地;地块场里没有「人口」这张表,`drain` 当作额外的固定衰减(免得以为和按州场一样有人口耗散)。
- **影响口**:每次出手先把地块值按 `regions.of` 聚合成州均值(跳过海/湖),再按 `influences` 交给按州/按政治体的官方影响口;强度 0 时场照算、图层照存,只是不影响引擎——官方指纹逐字节不变。
- **图层**:`civ_state_get.layers` 里 `unit: "tile"`、`cells = mesh.n`、`years`/`frameYear`/`frameCount`/`stats` 与按州层一致;存进世界时按文件格式写成 `cell` 层(读回来仍是 tile 层),`validateSimLayers` 接受 tile。
- **上限**:一层 6,000,000 字节(帧数 × 地块数 × 4),34,043 地块最多 44 帧——地块场示例把 `layer.keep` 设成 100,长局请按地块数调小 keep 或加大 `every`。
- **和官方 QuickJS 插件的关系**:只有原生插件(阶段A/C 的场、内置魔力场)能按地块记;官方 `.civplugin` 的表仍按州,已发布的接口第 1 版没变(插件作者写的类型不受影响)。
- **自检**:`node mcp/.build/mcp/selftest-tile-field.js`(30 项:spec/unit 校验、强度 0 = 官方指纹、layer 元数据、按地块帧数、同 spec 复现、回合新帧、回放对账、MCP 开会话、落盘 cell 层往返)。



没有写死的「默认对局」:世界生成参数、起始年、每回合年数、回合数、结束年、引擎参数(`civParams`)、接管的君主数量、每国命令上限、模型/温度/超时都由调用方给。想固定一套配置,就由调用方每次传同样的值,或者自己包一层脚本/MCP 客户端配置。

`civParams` 可传引擎的 `CivParams` 覆盖项,例如 `tempo`、`regionArea`、`names`、`knobs`(每个世界一套旋钮)。`interventions` 可以放"起始年之前的历史命令"。

## 确定性

- 同一 `seed` + 同生成参数 → 逐位一致的世界(引擎本身保证)。
- 同一世界 + 同起始年 + 同一串命令 + 同推演年数 → `fingerprint` 一致(`civ_state_get`、`civ_turn_step`、`civ_monarch_round` 都会返回 16 位指纹)。
- 会话只把命令交给引擎,不引入随机;外部模型决策的不可复现性只体现在"下了什么命令",不在引擎内部。把每轮命令按顺序重放,结果可精确复现(`civ_session_verify` 就是干这个的)。
- 小事件裁决层的概率→抽样用引擎统一随机流(`petty:<事件ID>:<年份>:<国家ID>`),原始概率/选项/抽样结果/`engine-rule` 降级都写进 `petty-round-XXXX.json`;命令同样进命令史,回放一致。
- 每轮日志写在 `mcp/.runs/<sessionId>/round-XXXX.json`、`monarch-round-XXXX.json` 与 `petty-round-XXXX.json`,`rounds.jsonl`、`monarch-rounds.jsonl`、`petty-rounds.jsonl` 是精简流水。

## 浏览器查看器(阶段 4)

不想配 MCP 客户端时,可以直接用浏览器看多 Agent 对局:

```powershell
# 先构建,再启动(仓库根目录)
powershell -NoProfile -ExecutionPolicy Bypass -File mcp/build.ps1
node mcp/.build/mcp/viewer.js --port 5190
# 浏览器打开 http://127.0.0.1:5190
```

查看器是**独立进程**(零新依赖,只监听 127.0.0.1),内置前端在 `mcp/viewer/`:

- 参数栏:种子、地块数、起始年、每回合年数、回合数、君主范围(`全部` 或前 N 国)、DM 规则预设、mock 决策、**魔力场与强度**;真模型设置(provider / baseUrl / model / Key)可折叠,Key 只存在服务端内存。
- 地图:基础地形(海拔 + 雪线 + 光照)与各国疆域两层叠加,滚轮缩放、拖动平移、点击选国、国都标注。
- 右侧:国家列表(色块 / 州数 / 君主)与选中详情(君主倾向、邻国、进行中的战争)。
- 底部标签页:AI 决策(每回合每君主看到什么、为什么下命令、命令/拒收/耗时)、编年史(按类型着色)、回合日志(领土变化 / 指纹)。
- 按钮:创建世界、开始会话、跑一回合、自动播放、回放对账、导出会话。
- 接口:`/api/world`、`/api/session`、`/api/monarch/setup`、`/api/monarch/round`、`/api/dm/setup`、`/api/dm/round`、`/api/petty/setup`、`/api/petty/round`、`/api/field/meta|base|data|legend`、`/api/magic/meta|base|data`、`/api/state`、`/api/map/base`(PNG)、`/api/map/owners`、`/api/chronicle`、`/api/verify`、`/api/export`、`/api/health`。

注意:查看器进程内的世界/会话表是内存里的,关掉进程就没了;日志仍写在 `mcp/.runs/`。查看器不改变引擎的确定性,只是把同一套 `mcp/engine.ts` / `mcp/monarch.ts` 搬到 HTTP 后面。

## 当前阶段

- **任务一(已完成)**:`mode="auto"` 的引擎工具层,8 个基础工具。
- **任务二(已完成)**:君主回合循环,新增 5 个君主工具;`mock` 与真 LLM 两条路径;回放对账。
- **任务三(已完成)**:DM 规则预设(`tuningPatch` 写 `CivParams.knobs`,`civ_dm_preset` 查看/覆盖)+ 新增 `press` 干预(引擎自动议和 vs 君主坚持打);官方世界确定性逐位不变(21/21 对账通过)。
- **阶段四(已完成)**:本地浏览器查看器(`mcp/viewer.ts` + `mcp/viewer/` 前端),地图/疆域/君主决策/编年史/回合日志可视化,零新依赖。
- **DM 小决策接口(已完成)**:`mcp/dm.ts` + `civ_dm_oracle_setup/status/round` 三个工具 + 查看器 DM 面板;OpenAI 兼容(OpenJEV / Ollama / LM Studio / vLLM),天灾写成 `disaster` 命令真改历史,小贸易只记叙事;命令照常进日志,回放对账仍一致。
- **小事件裁决层(已完成,官方 Jev + v2)**:`src/gen/civ/petty.ts`(20 个模式 + 确定性抽样)、`mcp/petty-client.ts`(官方 Jev `POST /api/v1/decisions`)、`mcp/petty-budget.ts`(token 估算与 P0/P1/P2 打包)、`mcp/petty-queue.ts`(严格串行优先队列/超时/背压/熔断)、`mcp/petty.ts`(扫描→预算→队列→抽样→落效果→日志/DM 摘要);v2 效果 = 城市折损 `sacks` + 发展 `boost`;**MCP 工具增至 20 个(现在 21)**;查看器已加「小事件裁决层」面板(mock 或官方 Jev,Key 只在服务端内存)。
- **DM 故事事件(已完成,选项 C)**:新增第 26 种干预 `story`(`src/gen/civ/storyEngine.ts` + `mcp/dm.ts` 白名单编译):DM 可以按故事自由写标题/叙事,效果只能落在 4 类引擎效果(城市折损 `sack` / 人口上限 `capacity`(走 `reshaped` 时间线,不改写历史)/ 发展 `dev` / 叙事 `note`)上,≤3 条;命令入日志,回放逐位一致;命令目录 26 种、查看器标成「故事事件」。
- **自定义场原型(已完成)**:`src/gen/field.ts`(计算层,魔脉/矿产/辐射三种、逐字节确定、FNV-1a hash)+ `mcp/field-render.ts`(渲染层,色带/拉伸/等高线/辉光/浮雕/透明度,只读数值)+ `mcp/png.ts` + 查看器「自定义场」面板与 `/api/field/*`;计算与渲染彻底分开,改样式不再重算;自检 43 项。
- **魔力动态层(已完成)**:`src/gen/civ/magicPlugin.ts`(原生 `SimPlugin`,vein/rural/magic 三张表 + `city.capacity` 影响口 + 每 50 年一帧图层)+ `mcp/magic-render.ts`(只读图层,按年份选帧/插值,PNG + 图例)+ `civ_session_open` 的 `magicField/magicStrength` + `civ_state_get.magic` + 查看器「本局动态层 · 魔力」面板与 `/api/magic/*`;强度 0 时引擎指纹与官方逐字节一致;自检 34 项。
- **可配置场(阶段A,已完成)**:`src/gen/civ/fieldPlugin.ts` 把玩家给的 `FieldSpec`(密度/源强/扩散/渗出/衰减/人口耗散/强度/图层 + 1–6 条 `influences`)变成本地 `SimPlugin`;`civ_session_open` 的 `fields`(最多 4 份)、`civ_field_catalog` 列出可接的影响口(`city.capacity`/`war.odds`/`unrest.add` 等)与示例 spec;`civ_state_get` 返回 `fields`/`layers`;玩家自己决定影响哪些数值;不给 `fields` 或强度 0 时官方指纹逐字节不变;自检 46 项。
- **官方 .civplugin 加载器(阶段B,已完成)**:`mcp/plugin-loader.ts` 在 mcp 的 CommonJS 产物里用 QuickJS 直装官方推演插件(文件或源码目录,最多 4 个);`civ_session_open` 加 `plugins` 路径数组,插件与内置魔力场/自定义场同走 `CivParams.plugins`;summary/session.json 记插件 id,`civ_state_get.layers` 能看插件图层;非 sim 插件/坏路径/重复 id/超上限都有中文错误;自检 22 项。
- **地块级场(阶段C,已完成)**:`FieldSpec.unit` 支持 `tile`(按世界全部 mesh 地块逐年演化);插件层 Host 支持 tile 表/图层(内存按地块、落盘按 `cell`),`fieldPlugin` 把地块值聚合成州均值后接影响口;`civ_state_get.layers` 带 `unit: "tile"`;官方 `.civplugin` 接口第 1 版不动;自检 30 项。

## 目录

```
mcp/
  engine.ts          无头引擎门面(世界/会话/状态/推演/编年史/导出)
  orders.ts          原始命令清洗与目录
  monarch.ts         君主回合编排(setup/brief/round/status/verify)
  prompt.ts          君主系统提示词
  llm.ts             DeepSeek/百炼/自定义 OpenAI 兼容 + mock 决策
  dm.ts              DM 小决策(OpenAI 兼容 oracle + 天灾/小贸易/故事事件编译 + 日志)
  petty-client.ts    官方 Jev 客户端(POST /api/v1/decisions,鉴权/解析/错误映射)
  petty-budget.ts    token 估算 + P0/P1/P2 预算打包
  petty-queue.ts     严格串行优先队列(超时/背压/熔断/降级)
  petty.ts           小事件裁决层编排(扫描/上下文/请求/抽签/落效果/日志/摘要)
  tools.ts           21 个 MCP 工具定义与分发
  server.ts          JSON-RPC 2.0 over stdio(逐行串行处理)
  selftest.ts        引擎自检(31 项)
  selftest-protocol.ts  协议自检(16 项,21 工具)
  selftest-monarch.ts   君主回合自检(29 项,mock)
  selftest-press.ts     press 干预自检(16 项)
  selftest-dm.ts        DM 规则预设自检(17 项)
  selftest-dm-oracle.ts DM 小决策自检(45 项,mock;含故事事件)
  selftest-petty-core.ts   小事件核心自检(58 项,不联网)
  selftest-petty-oracle.ts 小事件端到端自检(53 项,mock)
  selftest-field.ts        自定义场自检(43 项,确定性/数值/渲染)
  selftest-magic.ts        魔力动态层自检(34 项,引擎影响/图层/回放)
  selftest-field-plugin.ts 可配置场自检(46 项,spec 校验/影响口/确定性)
  selftest-plugin-loader.ts 官方 .civplugin 加载器自检(22 项,QuickJS/会话/回放)
  selftest-tile-field.ts   地块级场自检(30 项,按地块演化/落盘往返/回放)
  plugin-loader.ts   官方 .civplugin 加载器(CJS 里用 QuickJS wasm + simPluginsOn)
  vite-url.d.ts      mcp 构建认 Vite 的 `?url` 导入(只给类型)
  png.ts             纯 Node PNG 编码(渲染层共用)
  field-render.ts    场渲染层(只读数值上色,输出 PNG + 图例)
  magic-render.ts    魔力图层渲染(按年份选帧/插值,PNG + 图例)
  viewer.ts             本地浏览器查看器(HTTP + PNG 地图 + 场叠加)
  viewer/               index.html / style.css / app.js
  tsconfig.build.json / build.ps1
  .build/            产物(不提交)
  .runs/             会话日志(不提交)
```

`src/gen/civ/monarch.ts` 是纯计算的君主模块(简报生成、命令编译、选国),不依赖 DOM/网络,可以被 MCP 层和将来的浏览器层共用。`src/gen/field.ts` 同样是纯计算(每地块一个值,不碰渲染),渲染在 `mcp/field-render.ts`。`src/gen/civ/fieldPlugin.ts` 是「可配置场」工厂:把一份玩家给的 `FieldSpec` 变成表卡 + 影响口 + 图层的原生插件,影响哪些官方数值由 spec 的 `influences` 决定;`unit: "tile"` 时表按世界全部地块记(阶段C),图层内存按地块、落盘按 `cell`,出手前聚合成州值。`mcp/plugin-loader.ts` 是官方 `.civplugin` 加载器:用 QuickJS 装现成插件,再交给同一个 `CivParams.plugins`,和自定义场/内置魔力场并列。`src/gen/civ/magicPlugin.ts` 是原生推演插件(表卡 + 影响口 + 图层),不依赖 QuickJS,可以直接传给 `CivParams.plugins`;`mcp/magic-render.ts` 只读它的图层画图。`src/gen/civ/engine/plugin.ts` 的 Host 现在支持 `tile` 表(要有 `PluginBridge.tiles`);`pluginLayers.ts` 的 `SimLayer.unit` 多了 `'tile'`,世界文件里仍写 `cell`。



