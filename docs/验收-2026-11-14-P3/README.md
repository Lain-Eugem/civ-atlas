# 验收记录：P3 角色卡（生平→性格 + 种族占位）

对应 plan.md §P3；实现提交随 `feat(viewer): 角色卡支持生平推断性格与种族/寿命占位`。

## 做了什么

1) 角色卡数据（`src/gen/civ/monarchCard.ts`，仅新增可选字段，不改原有 determinism）：
   - `MonarchCard.biography?`（≤600 字）、`race?`（自由文本）、`raceSystem?`、`lifespan`（默认 90）。
   - `cleanCardInput()`：篇幅截断、`raceSystem=false` 时 lifespan 恒 90，开启时 clamp 20–200。
   - `cardSystemText()` 追加种族/寿命行。
2) 生平推断（`mcp/monarch-start.ts`）：
   - `inferCardRules(text)`：关键词 + 程度词（极/非常/很/颇/略/稍）+ 否定（不好战/厌恶战争）规则表，映射
     `traits{caution,ambition,honor,greed}`（0–100）、`preferences{war,economy,diplomacy}`、`competence{war,economy,intrigue,admin}`（0|1|2）。
   - `inferCardFromBiography(text)`：当会话开启了 LLM 且 DM provider 非 mock 时先走 DM 严格 JSON（`{traits,preferences,competence}`），
     校验失败重试 1 次，再失败回落规则；mock/无 LLM 环境恒定可用。空生平报错。
   - `applyCustomStart` 写回 `Session.monarch.lifespan`。
3) 服务端：`POST /api/start/infer-card {sessionId,biography,llm?}` → `{ok,result:{traits,preferences,competence,biography,source:'rules'|'llm',warnings[]}}`；
   custom-start 的 `card` 透传新字段；`/api/state` 新增 `monarchLifespan`（默认 90）。
4) UI（`mcp/viewer/start-custom.js`）：君主定制段新增
   - 生平 textarea（≤600，可留空）、种族输入（自由文本）、「启用种族系统」开关、寿命输入；
   - 「从生平推断性格」按钮 → 调 infer-card 后回填滑杆/下拉（仍可手改）；
   - 种族为空且启用种族系统时提示「未填写种族，将按默认寿命 90 岁」；
   - 自动生成角色卡勾选时整块禁用；应用后面板按 state 回填。

## 验证

- 单测：规则+卡清洗+apply **50/50**；LLM 路径 **16/16**（本地假 OpenAI：成功、坏 JSON 重试 1 次、两次失败回落、`llm:false` 不发请求）。
- 回归：`mcp/build.ps1` exit 0；root `tsc --noEmit` 0；`selftest` 31/31；`selftest-coast` 18/18；`selftest-tile-field` 30/30；`selftest-monarch` 29/29；`selftest-monarch-sandbox` 45/45；`node --check` 0。
- Playwright（seed=7 / cells=34043，5191 新 build）：
  - 默认面板：自动生成勾选时卡区禁用；
  - 战争狂样例 → 谨慎 19 / 野心 100 / 军事 高 / 战争偏好 主动求战（source=rules）；
  - 填种族「精灵」+ 启用种族系统 + 寿命 150 → 应用 200，新国 P60 卡片 `race/raceSystem/lifespan=150`，`/api/state.monarchLifespan=150`，面板回填；
  - 三条样例 live API：谨慎守成（谨慎 94 / 野心 14 / 避战 / 重信义）、商贸贪婪（贪婪 72 / 重商 / 讲实利）都合理。
- 截图：本目录 6 张（默认面板 / 推断后 / 完整界面 / 种族寿命 / 应用后回填 / state JSON）。

## 已知限制

1) LLM 真 key 未在本环境实测，只用本地假 OpenAI 服务验证了成功/重试/回落三种路径；mock 勾选时恒走规则。
2) 角色卡与寿命仍在**会话内存**（沿用既有 `Session.cards` 语义），viewer 重启即丢失；如需持久化要在存档层加字段。
3) `stateView` 只新增了 `monarchLifespan`，未并入 `monarchStatus`（UI 用顶层字段即可，后续按需统一）。
4) 规则表是中文关键词启发式，英文/混合语言生平推断会退化到中性默认值（先按 plan 的规则兜底语义实现）。

## 待拍板

- infer-card 路由与 lifespan 语义是否补充进 MCP 工具层文档（目前只在 viewer HTTP 层）。
- 临时单测是否落成 `mcp/selftest-p3.ts` 进入常驻回归（当前未加，避免影响既有 selftest 列表）。