# AI 统治者 demo（在本地 civ-atlas 上让 AI 治国）

让 AI（真的模型，或者不用 Key 的假 AI）扮演一个国家，每回合读一眼局势、下几条命令，再由 civ-atlas 自己的推演引擎把世界接着推进几年。

这是**本地实验**：只在仓库里加了一个 `ai-ruler/` 文件夹，`src/` 一行没改，也不影响网页版和存档。

## 它只用了引擎的公开接口

- `generateWorld` 生成世界 → `playCiv` 推到起始年
- 每回合：`buildBriefing` 读局势 → AI 决定 → `buildCommands` 校验/翻译 → `playTurn` 接着推
- AI 能下的命令只有 5 种：`policy`（定国策）、`declare`（宣战）、`ally`（结盟）、`halt`（停止扩张）、`boost`（推发展）
- 世界怎么走仍由原引擎决定；同一个种子 + 同一串命令，结果仍然是确定的

## 先构建（已经构建过一次；改了代码才需要重来）

```powershell
powershell -ExecutionPolicy Bypass -File ai-ruler\build.ps1
```

构建会生成 `ai-ruler\.build\`，并写入 `.build\package.json`（让 Node 按 CommonJS 跑）。

> tsc 会顺带报 `src/ui` 里 `import.meta` 的类型错误——那些是浏览器专用文件，和 demo 无关；只要 `ai-ruler\.build\ai-ruler\run.js` 生成出来就算成功。build.ps1 已经按这个判断。

## 四种跑法

在 civ-atlas 仓库根目录：

```powershell
# 1) 不用 Key：假 AI（按君主性格出招，验证流程用）
node ai-ruler\.build\ai-ruler\run.js

# 2) 真 AI：DeepSeek
$env:DEEPSEEK_API_KEY="sk-..."
node ai-ruler\.build\ai-ruler\run.js --turns 10

# 3) 真 AI：阿里云百炼
$env:DASHSCOPE_API_KEY="sk-..."
node ai-ruler\.build\ai-ruler\run.js --provider bailian --model qwen-plus

# 4) 本地模型（Ollama 等 OpenAI 兼容接口，不用联网）
node ai-ruler\.build\ai-ruler\run.js --base-url http://127.0.0.1:11434/v1 --model qwen2.5
```

默认：种子 7、第 **2500** 年、**12** 回合、每回合 **5** 年、扮演当年最大的国家（P6 有桂皇朝，150 州）。

只想看 AI 收到的第一份简报（不调 AI、不推演）：

```powershell
node ai-ruler\.build\ai-ruler\run.js --dry-run
```

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--seed` | 7 | 世界种子 |
| `--year` | 2500 | 从第几年开始（太早国家太少） |
| `--turns` | 12 | 回合数 |
| `--step` | 5 | 每回合推进几年（1 年时州数几乎不变） |
| `--polity` | 最大国 | 扮演哪个国家，用 P 后面的编号 |
| `--provider` | deepseek | `deepseek` 或 `bailian` |
| `--model` | deepseek-chat / qwen-plus | 模型名 |
| `--base-url` | 官方地址 | 换成任意 OpenAI 兼容地址 |
| `--key` | 环境变量 | `DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY` |
| `--temperature` | 0.7 | |
| `--mock` | 关 | 强制用假 AI |
| `--dry-run` | 关 | 只打印第一回合简报 |
| `--out` | `ai-ruler/out` | 日志目录 |

## 每回合发生什么

1. **读局势**：把此刻写成中文简报——你的国家（国名、州数、国都、在位君主和性格倾向、邻国、正在打的仗、近年大事）、天下大势、天下最近发生的事、能下的命令、输出格式。
2. **AI 决定**：把简报发给模型，要求它只回 `{"reason":"...","commands":[...]}`。模型不按格式回会报错退出，方便看出是哪一步的问题。
3. **翻译并校验**：把命令里的 P 编号换成引擎的稳定键（`polity:c...`），把数值夹回合法范围，再交给引擎的 `cleanIntervention` 校验；不合法的命令会被拒收并打印原因，不会崩。
4. **接着推**：`playTurn` 从当前这一课接着推 `--step` 年；命令的时刻必须正好是「现在」，早一年晚一年都不收。
5. **记录**：控制台一行，加上 `ai-ruler/out/run-种子-年份-回合x步长-模式.md` 里的详细日志（AI 理由、命令、拒收、州数变化、这几年的大事）。

## 已经验证过什么

- 构建通过；`--mock` 跑通 12 回合 × 5 年（2500 → 2560），用时约 5–6 秒。
- 示例（种子 7，第 2500 年，P6 有桂皇朝）：
  - 2505 年 AI 与最强的邻国 P61 莎善汗国结盟；
  - 2535 年向最弱的邻国 P54 佩罗尼亚共和国宣战，得 15 州（150 → 165）；
  - 2540—2545 年又丢了 8 州（165 → 157），最后剩 157 州。
- 另一次从第 2000 年开始的 mock：2054 年百尾皇朝大乱，云东道、金渊之野各自立国（P6 113 → 40 州）——这是引擎自己推出来的大事，不是 AI 写死的。
- 真 API 的请求通路实际验证过：用一个无效 Key 请求 DeepSeek，返回 HTTP 401，程序把服务商原文（`Authentication Fails, Your api key: ****test is invalid`）原样打了出来，说明请求地址、鉴权头和错误处理都是通的；但本机没有可用 Key，**还没有跑过一次真正的模型决策**。

## 已知限制

- AI 每回合只看一段简报文字，不能自己翻地图/编年史（那是官方内置助手才有的工具循环）。想加深可以照 `src/ai/agent/assistant.ts` 的工具集给它加工具。
- 命令只有 5 种；引擎其实有 23 种干预（割让、立国、迁都、君主婚配、天灾等），要接得补 `run.ts` 里的 `buildCommands`。
- 「逐年」是按回合算的；每回合 1 年时州数往往看不出变化，所以默认 5 年。
- 真模型容易写出不合法命令：程序会拒收并打印原因，这是预期行为。
- 这是本地实验，不会出现在 civ-atlas 的网页界面里；要变成正式功能得改 `src/`，而且会破坏「同种子逐位一致」的确定性。

## 下一步可以做什么

- 让 AI 同时扮演几个国家（每国一个提示词/一个模型），看它们结盟、背刺、打仗。
- 把每回合的 AI 理由并进编年史，最后导出一部「AI 视角的史书」。
- 接入官方内置助手的那套工具（国家/编年史/试推演），让 AI 先查证再决定。
- 用 `--base-url` 接本地小模型，做不用联网的推演。
