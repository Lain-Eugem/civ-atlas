# 验收：P4 推演中 DM 对话框（玩家硬命令）

对应 plan.md §P4（用户 m04171 第 ⑦ 项"DM 的对话与 Jev 的决策需要有展示的地方"之后新增的硬命令能力，用户 m04210 决策②允许玩家直接下硬命令）。

## 做了什么

### 服务端
- 新文件 `mcp/player-commands.ts`（10,144 B）：规则解析器 + 待执行队列。
  - `parsePlayerCommand(text, ctx)`：支持 对/向/跟 X 宣战|开战、宣战 X、与 X 结盟、灭掉/征服/吞并 X、渗透/刺探 X、停战|议和|休战|停火、扩张、防守|停止扩张|休养生息、通商|贸易、发展|繁荣、坚持打、禁止分裂、保住王室、中立；国名支持 `P<编号>` 与模糊名（去后缀匹配）。
  - `queuePlayerCommand` / `cancelPlayerCommand` / `drainPlayerCommands(max=5)`（每回合最多执行 5 条）/ `playerCommandView`。
  - 与引擎命令目录（`mcp/orders.ts` 的 `cleanOrders`）二次校验，非法命令直接拒绝并给出可用示例。
- `mcp/engine.ts`：`Session.playerPolityId` / `playerCommands`；`turnStep` 在推演前把待执行命令并入本回合命令队列。
- `mcp/viewer.ts`：
  - `POST /api/dm/chat { sessionId, text }` → `{ reply, state }`；
  - `POST /api/dm/chat/cancel { sessionId, id }` → `{ cancelled, state }`；
  - `stateView` 增加 `playerPolityId / playerPolityName / playerCommands`；
  - 开局设置（custom-start）成功后记录 `playerPolityId`。

### 客户端
- 新文件 `mcp/viewer/dm-chat.js`（17,964 B，IIFE `globalThis.CivDmChat`）：DM 页签内的对话框（输入框 + 待执行列表 + 撤销 + 最近记录 + 状态徽标 + 示例折叠 + 暗色模式 + HTML 转义），自注入 CSS（class 前缀 `dmc-`）。
- `mcp/viewer/app.js`：DM 页签在对话记录下方挂载对话框，send/cancel 分别调用上述 API 并用返回 state 刷新全界面；`mcp/viewer/index.html` 在 app.js 前加载 `dm-chat.js`。

## 验证（seed=7 / cells=34043）

冒烟（浏览器内：自定义开局选「渠支皇朝」8 州 → DM 页签发命令）：

| 步骤 | 结果 |
| --- | --- |
| 发送「发展」 | 解析为「推一把发展」，进入待执行 #1 |
| 发送「停止扩张」 | 解析为「转为守成姿态」，进入待执行 #2 |
| 点击 #1 撤销 | 待执行剩 1，最近出现「已拒绝 / 玩家撤销」 |
| 跑一回合（2500→2505） | 待执行清空，最近「已执行 停止扩张 / 第 1 回合执行(第 2500 年)」 |

另在服务端脚本里验证：乱码命令被拒绝并返回可用示例；连发 6 条只有 5 条在本回合执行（`PLAYER_CMD_PER_ROUND=5`）；待执行上限 10 条。控制台无报错。

回归：root `tsc --noEmit` exit 0；`selftest` 31/31；`selftest-coast` 18/18；`selftest-tile-field` 30/30。

## 已知限制

1. 解析是**规则匹配**（不依赖 LLM），支持上表句式；更自由的表达（如"我要和西边的国家做生意"）暂不支持，会返回示例提示。
2. 命令只进本回合队列，**不会**跳过推演直接生效；DM/Jev 的 LLM 回合仍由原有按钮触发。
3. 撤销只对"待执行"命令有效，已执行的不提供回滚。
4. 每回合 5 条、待执行上限 10 条为 plan 默认值（可在 `mcp/player-commands.ts` 常量调整）。

## 截图

- `01-DM对话框-空态.png`：DM 页签 + 对话框（每回合最多 5 条 · 下一回合开始时执行）
- `02-DM对话框-待执行两条.png`：待执行 #1/#2 + 解析摘要 + 撤销按钮 + toast
- `03-DM对话框-回合后历史.png`：跑一回合后 → 已执行 / 已拒绝（玩家撤销）