# civ-atlas 多 Agent 沙盒改造计划

> 状态：**只做了只读调研，还没有改任何代码**。等你确认下面第十节的几个取舍后，我再按阶段开工。
> 仓库基线：`main` @ `4a1267b`（v1.6.0），工作区干净，`ai-ruler/` 已被 `.git/info/exclude` 排除。

## 一、结论先行

1. **可行，而且地基比预想的好。** 三块关键能力项目里都已经有了：
   - **停住→下命令→接着推**：`src/gen/civ/play.ts` 就是官方的逐年推演 API，`playStop / playCiv / playTo / playTurn`，官方文档明确保证「分几段推和一口气推结果逐字节一样」。
   - **浏览器线程里的回合协议**：`src/worker.ts:215` 已有 `type:'turn'` 请求，`src/ui/sim/useSimRunners.ts:130-171` 已有「逐步演绎」UI 在用它。也就是说「暂停自动推演、下一批命令、再推」这套消息在项目里本来就有。
   - **外部命令覆盖自动规则**：`Intervention`（干预）本来就是「作者命令优先于引擎自动行为」的官方通道，23 种命令覆盖宣战/结盟/停战/改方针/划州/灭国等；规则权重也有 70 个对外可调项（`src/gen/civ/tuning.ts`）。
2. **不需要改引擎事件堆，也不需要重写推演。** 任务二用「纯函数会话层 + 官方 play API」实现，任务一用独立的 Node MCP 进程复用引擎，任务三用「规则预设 + 一个可选的新干预命令」实现。这样对确定性的风险最小。
3. **要区分两种「可复现」**：
   - 引擎确定性：同一 seed + 同一参数 + **同一串指令** → 逐字节一致（这是必须守住的）。
   - LLM 决策：天然不可复现。做法是把每轮君主输入/输出、编译后的指令、被拒原因全部落盘（JSONL），提供 replay 模式，用同一份指令重算来验证引擎逐字节一致。
4. **改造只在 `mcp/` 新目录和一个纯函数模块里进行**，不动 `src/ai`（内置助手保持原样），网页版本的构建产物与首页体积不变。

## 二、关键文件与函数定位（路径 + 行号）

### A. 世界生成与推演入口
| 用途 | 位置 | 说明 |
|---|---|---|
| 一次性生成文明 | `src/gen/civ/index.ts:44` | `generateCiv(world, params={}, progress=()=>{})`，等同于 `runPack(OFFICIAL_PACK)` |
| 分段推演 | `src/gen/civ/index.ts:49` | `startCiv(...): Stepper` |
| 接着推 | `src/gen/civ/index.ts:65` | `continueCiv(world, civ, params, progress)`；接不上会整段重推 |
| 从某刻续推 | `src/gen/civ/index.ts:85` | `startContinue(...): Continuation \| null` |
| Stepper 协议 | `src/gen/civ/run.ts:264-273` | `{to, year, advance(untilYear), finish(): Civ}`；:269 注释保证「分几段推 = 一口气推」 |
| 官方规则包 | `src/gen/civ/modules.ts:133` | `OFFICIAL_PACK`；`engine/pack.ts:18-32` 是 `RulePack` 接口，:46-61 是装/续/收尾 |

### B. 回合 / 逐年推演
| 用途 | 位置 | 说明 |
|---|---|---|
| 停在哪一刻 | `src/gen/civ/play.ts:51` | `playStop(year, tick=0)` |
| 从零推到某一刻 | `src/gen/civ/play.ts:56` | `playCiv(world, params, play)` |
| 停→命令→接着推 | `src/gen/civ/play.ts:67` | `playTo(world,civ,params,play,commands,at,cont)` → `{civ, play, rejected}` |
| 按年推 | `src/gen/civ/play.ts:90` | `playTurn(world,civ,params,play,commands,years)` |
| 回合状态 | `src/gen/edits.ts:1092` | `PlayState{year,tick?,commands}`；`YEAR_TICKS=256` :1102 |
| 命令入口 | `src/gen/edits.ts:2427` | `issueCommands(play, commands)`，只收 `from === 当前时刻` 的命令 |
| 浏览器 turn 协议 | `src/worker.ts:215` | `{type:'turn', id, play, commands, years, ticks?, interventions?}` |
| turn 处理 | `src/worker.ts:1721-1748` | `heldCiv` 对齐进度 → `playTicks` 或 `playTurn` → 回包带 `rejected` |
| UI 逐步演绎 | `src/ui/sim/useSimRunners.ts:130-171` | 已把 `turn/start/saveBack` 接起来 |

### C. 外部命令（干预）通道
| 用途 | 位置 | 说明 |
|---|---|---|
| 命令联合类型 | `src/gen/edits.ts:847-882` | `Intervention` 23 种 |
| 命令种类清单 | `src/gen/edits.ts:1967` | `INTERVENTION_KINDS` |
| 清理/校验 | `src/gen/edits.ts:2259` / `:2272` / `:2289` | `cleanInterventions` / `cleanIntervention` / `tidyIntervention`；**:2294 对不认识的 kind 返回 null，列表里会被丢掉**（旧版本打开新存档不会崩） |
| 命令语义文档 | `src/gen/civ/interventions.ts:1-78` | 每条命令的覆盖语义；:76-77 说明「停在第 T 年年初接 from=T 的新命令 = 一口气推」 |
| 命令模型 | `src/gen/civ/interventions.ts:117` | `InterventionModel`；:418 `scheduleInterventions`、:459 `issueCommands(sim,seed,list)`、:481 `installInterventions`、:864 `resumeInterventions` |

### D. 规则权重与规则套
| 用途 | 位置 | 说明 |
|---|---|---|
| 底层旋钮 | `src/gen/civ/engine/knobs.ts:26/47/70/75` | 每个世界一套 `KnobPatch`，缺省 = 官方 |
| 官方旋钮总目录 | `src/gen/civ/knobs.ts` | 30 张表（wars/diplomacy/polities/...） |
| 对外 70 个规则项 | `src/gen/civ/tuning.ts:41-61` | `TuningValues`；7 组；`TUNING_CALC=4` :52 |
| 战争相关规则项 | `tuning.ts:149-168` | `war.odds`(mult)、`war.truce`(num, 官方5)、`war.length`(range [5,18])、`war.rest`(4)、`war.fronts`、`war.capital`… |
| 分裂/外交规则项 | `tuning.ts:175-211` | `split.odds/restore/collapse/revolt/dynasty…`、`diplo.pact/betray/join…` |
| 规则项→旋钮 | `src/gen/civ/tuningPatch.ts:335` | `tuningPatch(values, calc): KnobPatch \| undefined` |
| 规则套 | `src/gen/civ/ruleSet.ts:45-60` | `RuleSet{id?,name,version,values:TuningValues,biomes?,calc?}`；一套规则随世界存 |
| 文明参数 | `src/gen/civ/types.ts:1248-1308` | `CivParams`；`interventions?` :1260、`knobs?` :1308（不给 = 官方，逐字节同现在） |

### E. 战争与议和判定（任务三的「继续打」覆盖点）
| 用途 | 位置 | 说明 |
|---|---|---|
| 战争旋钮 | `src/gen/civ/wars.ts:109` 起 | `WARS_KNOBS`：CHECK_FIRST/CHECK_EVERY/TRUCE/MAX_WARS/LENGTH/STALL/BREAK/CRUSH… |
| 议和条件 | `src/gen/civ/wars.ts:58-65` | 打满年限、僵持、达成目标、破都/过半、国库窘迫等 |
| 议和实现 | `src/gen/civ/wars.ts:615` | `makePeace(w,t,extra)` |
| 自动议和调用 | `src/gen/civ/wars.ts:682`、`:1146-1147` | 前者是亡国连锁结束战争，后者是胜负结算 |
| 干预挂钩 | `src/gen/civ/wars.ts:776-777`、`:853` | 已有 allied/halted/protects 查询，可照这个模式加 `pressing` |
| 方针 | `src/gen/civ/policy.ts:43/89/98/119` | `POLICY_KNOBS`、`withPolicy`、`policyEffect`、`segAt` |

### F. 只读查询与导出
| 用途 | 位置 |
|---|---|
| 国名/国都/存活 | `src/gen/civ/growth.ts:694` `polityName`、`:724` `capitalAt`、`:753` `polityAlive` |
| 君主 | `src/gen/civ/story/peopleInfo.ts:95` `rulerAt(civ,polity,year)` |
| 编年史 | `src/gen/civ/story/chronicle.ts:4440` `buildChronicle`、`:4874` `chronicleText` |
| 子系统接口 | `src/gen/civ/api.ts:202` `civApi(sim)`（WarApi/PolityApi/DiplomacyApi…） |
| 存档 | `src/gen/savefile.ts:142` `SAVE_FORMAT=5`、`:172` `SaveFile` |
| 世界文件 | `src/gen/worldFile.ts:270` `PackedWorld`、`:363` `openStoredParts` |
| 重算世界 | `src/worldConvert.ts:153`（用 generateCiv / civOrStuck） |

### G. 确定性与测试工具（现成的）
| 用途 | 位置 |
|---|---|
| 逐位一致性测试 | `tests/determinism.test.ts:1-9`（规则说明）、`:19-48`（指纹算法）、`:51-53`（seed 2024） |
| 改造前后对账 | `scripts/fingerprint.ts:101-123`（21 组，含 seed 2024 `:103`）、`:140-157`（world/civ/raster/chronicle/frames 全字段） |
| 极端参数 | `scripts/stress.ts` |
| 无头跑推演先例 | `scripts/sim-plugin-try.ts`、`scripts/lib/fakeWorldFile.ts` |
| 开发约定 | `docs/development.md:26-43`（命令）、`:57-100`（结构）、`:102-109`（确定性/性能约定） |

## 三、总体架构

```
Harness（Claude Code / Cursor / 任何 MCP 客户端）
        │  MCP over stdio（JSON-RPC 2.0，按行分隔）
        ▼
mcp/server.ts ── tools/call ──► mcp/engine.ts（无头引擎门面）
        │                          │  generateWorld / playCiv / playTurn / continueCiv
        │                          ▼
        │                     src/gen/civ/monarch.ts（纯函数回合编排）
        │                          │
        │                          ├─ 当前 civ + play → 君主简报
        │                          ├─ 指令编译成 Intervention[]（from = 当前年）
        │                          └─ playTurn(step) → 新 civ/play/rejected
        ▼
mcp/llm.ts（OpenAI 兼容 HTTP；DeepSeek/百炼/Ollama；超时/重试/mock）
```

**为什么这么分：**
- 引擎必须留在纯计算层（可在 Node 跑，不碰 DOM），MCP 只是「换了个宿主」。
- `monarch.ts` 放在 `src/gen/civ/` 里是为了：被 `tsc --noEmit` 检查、能被 vitest 直接测、以后浏览器 UI 也能复用；它不 import 网络/DOM。
- LLM 请求放在 `mcp/llm.ts`（Node 进程里），永远不在推演 Worker 里；将来做浏览器版时，网络请求放主线程或独立 Worker，推演 Worker 只负责 `turn`，满足「不阻塞」约束。
- 不新增任何运行时依赖；MCP 协议手写（也可换官方 SDK，见第十节）。

## 四、任务一：MCP 工具层

### 4.1 目录与文件
```
mcp/
  server.ts        JSON-RPC 2.0 over stdio；initialize / notifications/initialized / tools/list / tools/call / ping
  engine.ts        无头引擎门面：createWorld、openSession、snapshot、applyOrders、step、export
  session.ts       回合状态机 + 指令队列 + 落盘（mcp/.runs/<sessionId>/）
  orders.ts        君主 JSON 指令 schema、校验、编译成 Intervention[]
  prompt.ts        简报与君主提示词（中文；含输出 JSON 契约）
  llm.ts           OpenAI 兼容调用（baseUrl/model/apiKey/temperature/超时/重试/mock）
  replay.ts        从 JSONL 复算并与当时的 civ 指纹对账
  presets/dm.json  DM 规则预设（TuningValues）
  README.md        安装/配置/工具签名/示例
  tsconfig.build.json + build.ps1
```
构建：`tsc -p mcp/tsconfig.build.json` → `mcp/.build`（放 `{"type":"commonjs"}` 的 package.json，做法与已验证的 `ai-ruler/` 相同）；运行 `node mcp/.build/server.js`，或开发时 `npx tsx mcp/server.ts`。

### 4.2 工具清单（v1，8 个）
| 工具 | 作用 | 关键参数 | 返回 |
|---|---|---|---|
| `world_create` | 造世界（同 seed 同参数逐位一致） | `seed`、可选 `cells`/`params`、`ruleset:'official'\|'dm'` | `worldId`、地块数、起始年可选 |
| `session_open` | 建君主会话并推到起始年 | `worldId`、`startYear`、`stepYears`、`maxRounds`、`aiPolities` | `sessionId`、当年存活国列表 |
| `state_get` | 取某年/某国的状态快照与简报 | `sessionId`、可选 `polityId`、`includeBriefing` | 年份、回合、各国摘要/简报文本、上轮拒绝原因 |
| `orders_catalog` | 列出可下命令及 JSON Schema | 无 | 命令说明 + 示例（policy/declare/ally/halt/boost/treaty/protect/cede/press） |
| `orders_submit` | 提交某国本轮指令（可多次） | `sessionId`、`polityId`、`orders[]` | `accepted`、`rejected[{index,reason}]` |
| `turn_step` | 全部君主交完后推进一步 | `sessionId`、可选 `stepYears` | 新年份、各国州数变化、编年史增量、被拒命令、状态 |
| `chronicle_get` | 读某段编年史 | `sessionId`、`from`/`to`、`limit` | 编年史条目（含涉及国家） |
| `session_export` | 导出回放包/存档（可选阶段 2） | `sessionId`、`format:'jsonl'\|'civ'` | 文件路径 |

工具定义包含 `name` / `description` / `inputSchema`（JSON Schema，draft-07 子集：object/string/number/integer/boolean/array/enum/required）。

### 4.3 协议与错误
- stdio：**每行一条 JSON-RPC 2.0 消息**（MCP stdio 传输，不嵌换行）；stdout 只写协议，日志一律 stderr。
- 握手：`initialize`（回 `protocolVersion`、`capabilities.tools={listChanged:false}`、`serverInfo`）→ 客户端 `notifications/initialized` → `tools/list` → `tools/call`。
- 错误：未知方法 `-32601`；参数不合法 `-32602`；工具业务错误用 `isError:true` 的 content 返回（便于模型自我修正），不进程退出。
- 幂等：`orders_submit` 同 key 重放返回旧结果；`turn_step` 在指令未交齐时返回业务错误 `awaiting_orders`（不是协议错误）。

### 4.4 向后兼容
- 不动 `src/ai/*`，内置助手与官方 AI 照旧。
- `mcp/` 不在根 `tsconfig.json` 的 include 里 → 现有 `pnpm typecheck`/`pnpm build` 不受影响；另加 `pnpm mcp:check`（`tsc -p mcp/tsconfig.build.json --noEmit` + MCP 自检）。
- 不新增依赖；不新增网页入口。

### 4.5 风险
| 风险 | 影响 | 对策 |
|---|---|---|
| 手写协议漏边界（并发请求、超长行、错误码） | 工具调用失败 | 冒烟测试覆盖 initialize/list/call/错误路径；请求按 id 并发处理、单行长度上限 |
| MCP 协议版本差异 | 客户端拒绝握手 | 支持 `2024-11-05` 与 `2025-03-26` 的 initialize 字段兼容；README 写明测试过的客户端 |
| 起始年推演耗时（2500 年约几秒） | 客户端超时 | 一次调用只做一段；默认 startYear 2500（实测 3–6 秒）；README 建议把超时调大 |
| 平台路径/编码（Windows） | stdio 乱码 | 全程 UTF-8；Windows 下用 `chcp 65001` 或避免中文文件路径 |

## 五、任务二：君主回合循环

### 5.1 纯函数模块 `src/gen/civ/monarch.ts`
```ts
export interface MonarchOrder { kind: 'policy'|'declare'|'ally'|'halt'|'boost'|'treaty'|'protect'|'press'; ... }
export interface MonarchConfig { startYear: number; stepYears: number; maxRounds: number; aiPolities: number }
export interface MonarchSession { world; params; cfg; civ; play; round; log }
export function monarchOpen(world, params, cfg): MonarchSession      // playCiv 推到 startYear
export function monarchBrief(s: MonarchSession): BriefingPackage   // 每国一份文本 + 可选结构化数据
export function monarchApply(s: MonarchSession, byPolity): { accepted; rejected }  // 只存队列
export function monarchStep(s: MonarchSession): MonarchStep        // playTurn(stepYears)，收集 rejected/事件
```
- `monarchStep` 内部就是 `playTurn(world, civ, params, play, commands, stepYears)`；命令的 `from` 由编译层强制等于 `play.year`。
- 所有随机性仍来自引擎 seed，本模块不引入 Math.random / 时间 / 网络。

### 5.2 一轮流程
1. **起点**：`monarchOpen` 用 `playCiv` 推到 `startYear`，得到 `civ` 与 `play={year,commands:[]}`。
2. **简报**：对每个 AI 君主国生成：国名/州数/国都/君主与倾向（`rulerAt`）、邻国（`bordersAt` 或边界扫描）、在打的仗与年限、最近 8–12 条本国相关编年史、上一轮命令结果与被拒原因、可选国库/人口指标。
3. **发 LLM**：并发请求；每国一份简报；要求严格输出 `{"reason": "...", "orders": [...]}`。超时 120 秒、失败重试 1 次，仍失败则本轮弃权（空命令）。
4. **解析/校验**：容忍 ```json 代码块；`parseDecision` → 逐条校验（国名/编号必须本轮存活、`b` 必须是存活他国、年份/until 夹紧、每国每轮 ≤3 条）→ 编译成 `Intervention[]`（`P{id}` → 稳定键 `polityKey`）。
5. **推进**：`monarchStep` 调 `playTurn`；返回新年份、各国州数变化、当年大事、被拒命令。
6. **记录**：每轮写 `mcp/.runs/<sessionId>/round-XXXX.jsonl`（简报原文、LLM 原文、编译后命令、引擎返回、civ 指纹）。
7. **循环**到 `maxRounds` 或 `endYear`；结束时输出编年史摘要；可 `replay` 用同一份命令重算并比对指纹。

### 5.3 多 Agent 规模与拓扑
- v1 默认 **AI 最多扮演 8 个国家**（按州数取前 N；其余照引擎规则自动走）。可配 `aiPolities:'all'`（大国多时注意成本）。
- 两种驱动模式：
  - **内置模式（默认）**：MCP 进程自己调 LLM API（DeepSeek/百炼/Ollama，OpenAI 兼容），一轮一次 `turn_step` 即可跑完。
  - **Harness 模式（可选）**：`state_get` 返回每国简报，由 Claude Code 的子 Agent 分别扮演君主，再用 `orders_submit` 交回，最后 `turn_step`。工具层对两种模式一视同仁。
- 浏览器路径：`worker.ts` 的 `turn` 消息已经是「一步一停」；将来加 UI 面板时，浏览器只需驱动 `monarchBrief`/`monarchApply`/`monarchStep`，LLM 请求放主线程或独立 Worker。

### 5.4 风险
| 风险 | 影响 | 对策 |
|---|---|---|
| LLM 不按 JSON 输出/乱写国家编号 | 本轮决策无效 | 严格 JSON 契约 + 一次修复重试 + 校验层兜底 + 弃权 |
| 多国指令互相矛盾（A 宣战 B，B 求和） | 结果不符合预期 | 同刻命令按「国家顺序 + 提交顺序」编译，引擎已有「后下的为准」语义；简报里给出本轮他国公开动作 |
| 一轮耗时（8 国 × 2s + 引擎 1–3s） | 客户端超时 | 一轮一调用；并发请求；README 建议超时 120s+ |
| 成本 | Token 费用 | 每国简报 ≤1.5k tokens、每轮 ≤1.2k 输出；默认 8 国、12 轮 |
| 与引擎规则不一致 | 回放对不上 | 所有命令走 `issueCommands` 校验；回放测试验证指纹 |

### 5.5 验收
- mock LLM（确定性规则）跑 12 轮，落盘命令；用 `generateCiv(world,{interventions: 全部命令})` 一口气重推 → 与分轮 civ 的字段指纹一致。
- 关闭君主模式（纯规则）→ 与改造前基线逐字节一致。

## 六、任务三：规则权重与外部指令优先级

### 6.1 先说清现状
项目的「规则」**不是小公式语言**，而是三层：
1. TS 模块 + 事件堆（引擎逻辑，`src/gen/civ/engine/*`、`wars.ts`、`politics.ts`…）；
2. 每个世界一套可调旋钮 `KnobPatch`（`engine/knobs.ts`）；
3. 对外 70 个「规则项」`TuningValues`（`tuning.ts`），经 `tuningPatch()` 换算成旋钮；用户保存的「规则套」`RuleSet` 就是一组规则项（`ruleSet.ts:45-60`）。

所以「外部注入变量」不需要公式语言，走官方的 **KnobPatch / RuleSet** 通道即可，且完全相同输入下仍是确定性的。

### 6.2 降低自动推演强度：DM 规则预设
- 新增 `mcp/presets/dm.json`，内容是一组 `TuningValues`（只写与官方不同的项），经 `tuningPatch(values, TUNING_CALC)` 转 `KnobPatch`，建世界时放进 `CivParams.knobs`。
- 建议初版（数值之后用 `scripts/gen-stats.ts` / `policy-stats.ts` 统计再调）：

| 规则项 | 官方 | DM 预设 | 目的 |
|---|---|---|---|
| `war.odds` | 1× | ¼–½× | 引擎少自动开战，给君主留空间 |
| `war.truce` | 5 年 | 10 年 | 议和后更长的和平期 |
| `war.length` | [5,18] | [10,40] | 战争拖长，君主可中途介入 |
| `war.rest` | 4 年 | 1–2 年 | 打完能更快再动 |
| `war.fronts` | 2 | 1 | 减少多线混战 |
| `diplo.pact` | 1× | ½× 或关 | 减少自动结盟 |
| `diplo.betray` | 1× | 关 | 少背盟，外交更可读 |
| `split.odds` / `split.revolt` | 1× | ½× | 减少君主无法干预的突发事件 |
| `split.collapse` | 1× | ½× | 大国崩解慢一点 |

- 关闭 DM 模式 = 不放 `knobs` → 与现在逐字节一致（`types.ts:1303-1308` 官方约定）。
- 预设同样写进存档的规则套，所以「旧种子/旧存档照常打开」。

### 6.3 外部指令覆盖内置规则
**已有的覆盖（不用改代码）**：`declare` 强制开战、`ally` 强制结盟/当即议和、`halt` 不许扩张与主动宣战、`protect` 不许灭、`policy` 改方针、`treaty` 强制立约、`destroy` 灭国；同一刻冲突按「后下的为准」（`interventions.ts:1-78`）。

**缺口**：引擎按厌战/僵持/目标自动议和（`wars.ts:58-65`、`:615`、`:682`、`:1146`），目前没有「我不许议和、继续打」的命令。两种做法：

- **方案 A（推荐）**：新增第 24 种干预 `press`：
  - 定义：`{kind:'press', from, a, b?, until?}`——a 国在 `until` 之前不许与 b（不给 = 所有敌国）自动议和；`a`/`b` 用现有稳定键。
  - 改动点（全部是加法）：
    - `src/gen/edits.ts`：union :847-882 加成员、`INTERVENTION_KINDS` :1967 加 `'press'`、`tidyIntervention` :2289 的 `else` 分支加清理（复用 `untilOf()`，:2294 的 kind 白名单自动通过）。
    - `src/gen/civ/interventions.ts`：`InterventionModel` 加 Map + `pressing(polity, enemy, t)` 查询（仿 `halted`/`protects` 的写法，:117 起）。
    - `src/gen/civ/wars.ts`：在议和判定/调用 `makePeace` 前加守卫（`:615` 函数内部或 `:682`、`:1146` 调用前）：若该战争任一方有生效中的 `press`，返回不议和；亡国、灭国、割地等更高优先级逻辑照旧。
  - **兼容性已验证**：`tidyIntervention` 对不认识的 kind 返回 `null`（`edits.ts:2294`），`cleanInterventions` 会丢掉（:2259-2269）→ 旧版本打开含 `press` 的新存档会静默忽略这条命令，不会崩；新版本打开旧存档不受影响。
  - 确定性：没有 `press` 命令时这次查询是空 Map，行为不变；有命令才改变结果。
- **方案 B（不新增 kind，保守）**：每回合重新 `declare` 同一对敌国 + 高 `war` 方针，近似「继续打」；不改引擎，但可能有一年空档，且无法阻止引擎在年中议和。作为 A 的备用/降级方案。

**「优先级系数」**：不建议引入全局魔数。外部命令在决策点先查、引擎规则后查，冲突按命令列表顺序（官方「后下为准」语义）即构成优先级；数值系数反而增加不可解释性和测试成本。若你坚持要一个数字，可以只在 `orders` 日志里记 `priority` 字段供排序，不进引擎。

### 6.4 风险
| 风险 | 影响 | 对策 |
|---|---|---|
| 新 kind 影响存档/旧版本 | 旧版忽略命令，玩法降级但不崩 | 已验证忽略行为；`SAVE_FORMAT` 不变、`GENERATOR_VERSION` 不变 |
| 议和守卫破坏亡国/割地链条 | 引擎卡死/状态不一致 | 守卫只在「双方都还活着」的议和路径生效；`fall` 连锁结束战争不受影响；加单测 |
| 规则预设调过头（世界静止） | 演示效果差 | 先用统计脚本对比官方/DM 的战争数、国家数、存续期，再定档 |
| 规则项 id 变更 | 旧存档读不出 | 只用现有 id（编号稳定是官方约定）；预设里不新增 id |

## 七、确定性与存档验证方案（硬性验收）

### 7.1 改造前基线（必须先做）
1. `git switch -c feat/multi-agent-sandbox`（保持 `main` 干净）。
2. 在未改动的 `4a1267b` 上跑：
   ```
   npx tsx scripts/fingerprint.ts --save .baseline/fingerprint-main.json
   ```
   21 组用例，含 `seed 2024`（`fingerprint.ts:103`，frames=true）、`seed 7`、改地形、干预组；输出 world/civ/raster/chronicle/frames 全字段。
3. 把 `.baseline/` 加进 `.git/info/exclude`（不入库），并记下 `git rev-parse HEAD`。
4. 说明：`tsx` 在项目里依赖 esbuild 子进程；在本会话的沙箱里需要权限批准，在你自己的电脑上直接跑没问题。

### 7.2 每个阶段后对账
```
npx tsx scripts/fingerprint.ts --check .baseline/fingerprint-main.json
```
要求 **0 组差异**（字段级，不只是 Civ）。之后再跑：
```
pnpm typecheck
pnpm test
pnpm build
```
以及（任务三）用 `scripts/stress.ts` 确认无 NaN。

### 7.3 新增测试（vitest）
- `tests/monarch.test.ts`：
  1. **逐轮 = 一口气**：同一世界，把每轮命令按年拼成 `interventions`，`generateCiv(world,{endYear,interventions})` 与 `monarch*` 逐轮回放 civ 的字段指纹一致；
  2. **模式关闭不变**：不传 DM 预设/不开君主 → 与基线指纹一致；
  3. **指令编译**：P{id}→`polityKey`、from 强制当年、非法国家/年份被拒；
  4. **press 守卫**：有 press 时不自动议和；无 press 时与今天一致；亡国仍能结束战争。
- `mcp` 自检脚本（不依赖外部客户端）：initialize 握手 → tools/list → world_create → session_open → state_get → orders_submit → turn_step → 错误路径（未知工具、坏参数、未交齐命令）。
- `replay`：从 JSONL 重算最终 civ 指纹，与运行时记录比对。

### 7.4 为什么不会破坏旧种子/存档
- 不碰 `src/gen/civ/engine/*` 的推演逻辑（任务一二只是外层编排）。
- 不改 `GENERATOR_VERSION`（生成算法没动）。
- `SAVE_FORMAT`/`SaveFile` 不动；MCP 会话状态只存在 `mcp/.runs/`，不写进 `.civ` 世界文件。
- 新增字段全部可选且缺省 = 现行行为（`CivParams.knobs` 已是这个样板，`types.ts:1303-1308`）。
- `press` 是加法，旧数据没有它；旧版本读到它会按官方规则丢弃（已验证 `edits.ts:2294`）。

## 八、分阶段提交

| 阶段 | 内容 | Commit 信息（建议） | 验收 |
|---|---|---|---|
| 0 | 基线：建分支 + 跑 fingerprint 存基线 | 无提交（记录 hash） | 基线文件生成、21 组可复现 |
| 1 | 任务一：`mcp/` 目录、引擎门面、MCP server、自检 | `feat(mcp): headless engine facade and MCP stdio server` | `mcp:check` 通过；fingerprint 0 差异；typecheck/test/build 通过 |
| 2 | 任务二：`src/gen/civ/monarch.ts` + session/prompt/llm + 回放 | `feat(monarch): turn-based multi-emperor session` | mock 12 轮回放等价；关闭模式基线一致；新增测试通过 |
| 3 | 任务三：DM 规则预设 +（确认后）`press` 干预 | `feat(monarch): DM ruleset preset and external order override` | DM/官方规则指纹对照；press 单测；stress 无 NaN |
| 4（可选） | 浏览器 UI：`?monarch` 开关、AI 君主面板、存档导出 | `feat(ui): monarch sandbox panel` | 手工验收 + 现有 UI 测试 |

每个阶段提交时附「本阶段测试说明」（命令 + 输出摘要 + fingerprint 对比结果）。

## 九、风险总表
| 风险 | 概率/影响 | 对策 |
|---|---|---|
| 确定性回归（最大风险） | 中/高 | 不改事件堆；fingerprint 字段级对账；回放测试；阶段门禁 |
| MCP 协议不兼容客户端 | 中/中 | 握手兼容两个协议版本；真实客户端冒烟；可切官方 SDK |
| LLM 输出不可控 | 高/中 | 严格 JSON + 一次修复 + 校验兜底 + 弃权 + 落盘 |
| 长耗时/超时 | 中/中 | 一次一轮；并发请求；README 调大超时 |
| 存档前向兼容 | 低/中 | 已验证未知 kind 丢弃；格式不升版；旧存档回归测试 |
| 性能/成本 | 中/中 | AI 国 top-N；简报裁剪；token 预算 |
| 范围膨胀 | 高/中 | 阶段门禁；UI 放最后可选项 |

## 十、需要你确认的 4 个决定

1. **MCP 实现方式**
   - A（推荐）：手写 JSON-RPC 2.0 over stdio，零新依赖，约 250 行，便于仓库保持「无后端依赖」。
   - B：用官方 `@modelcontextprotocol/sdk`，省协议细节，但多一个 devDependency、需要联网安装。
2. **任务三的「继续打」覆盖**
   - A（推荐）：新增第 24 种干预 `press`（改动 3 个文件，加法；旧版本会静默忽略，已验证）。
   - B：不新增 kind，用「每年重新宣战 + 高战争方针」近似（不碰引擎，但可能有一年空档）。
3. **v1 范围**
   - A（推荐）：只做 headless（MCP + 会话层 + 测试/文档），先把 8 国 AI 对战跑通。
   - B：同时做浏览器 UI 面板（`?monarch=on` 开关、简报/命令/时间轴），工作量和风险都更大。
4. **默认对局参数**
   - 建议：seed 7、起始年 2500、每回合 5 年、最多 12 轮、AI 最多 8 国（与你之前 demo 一致；2500 年时 13 国、10 国有接壤）。
   - 若你更想看「从文明早期开始」，可改 1500（但当年只有 10 国、几乎无接壤，外交戏少）。

确认后我按「阶段 0 → 1 → 2 → 3」推进，每个阶段先跑确定性对账再提交。
