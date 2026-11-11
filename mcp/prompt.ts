/**
 * 君主提示词:分层投递,稳定内容前置、易变内容后置。
 *
 * system = 身份与硬约束(L0)+ 角色卡(L1,换君主才变)+ 世界口径(L2)+ 命令契约与输出格式(稳定段)
 * user   = 记忆库(L3,缓慢变化)+ 本年局势(L5,易变段)+ 逐州属性表(L6)+ 他国情报(L7)
 *
 * 稳定段里绝不出现年份、随机 id、回合号,否则前缀缓存必被打断;
 * 年份只在 user 的易变段里。命中率从 LLM 响应的 usage(cached tokens)读,写进回合日志。
 */
import type { MonarchBrief } from '../src/gen/civ/monarch';
import { cardSystemText, type MonarchCard } from '../src/gen/civ/monarchCard';
import { memoryText, type MemoryBook } from '../src/gen/civ/monarchMemory';
import { formatForeignIntel, formatRegionTable, type ForeignIntel, type RegionTable } from '../src/gen/civ/monarchIntel';
import type { LlmMessage } from './llm';

export const MONARCH_SYSTEM_PROMPT = `你在《文明与地图》的世界里扮演一个国家的君主。你会收到一份今年的局势简报,你要像那个国家、那位君主一样做决定。

要求:
1. 只输出一个 JSON 对象,不要解释、不要 markdown 代码块:{"reason":"一句话说明今年为什么这么决定","commands":[...]}
2. commands 每回合 0–3 条;不要写 from,不要写 a(程序会填成今年、你的国家)。
3. 只能从简报「你能下的命令」里选;目标国家写编号 b(如 6),不能写国名。
4. 宣战必须先接壤;结盟/宣战的目标必须今年在世。
5. 要符合君主性格(简报里有倾向数值)和当前处境(战争、邻国大小、本国州数)。
6. 今年没有值得做的事就输出空数组,不要硬凑命令。
7. 你扮演的是一个自然生物(有生老病死、有情绪、有私心的人),不是"国家意志"或全知的国家意识体:
   只用你看到的情报做判断,不知道的事不要编;超出这个角色能力的事不要下命令。
8. 高影响命令(宣战 declare、坚持打 press)会交给裁决层做合理性审核;不像"这个人"会做的事会被退回或降级。`;

/** 世界口径(稳定层):数字怎么读,哪些是估算 */
const WORLD_CONSTANTS = `## 数字口径(固定)
- 人口单位是"千";州 = 一国治下的一块地区。
- 标"估"的数(产粮能力、逐州税收、稳定度)是推算,不是精确账目;稳定度 0–100,越高越稳。
- 他国情报只能靠派人渗透获得;没探到的字段写"未知",不要猜。
- 你记得的事会影响你的判断,但记忆不是事实:与今年简报冲突时以简报为准。`;

export function monarchUserPrompt(brief: MonarchBrief): string {
  return brief.text;
}

export interface MonarchPromptParts {
  brief: MonarchBrief;
  card?: MonarchCard | null;
  memory?: MemoryBook;
  regions?: RegionTable;
  intel?: ForeignIntel[];
}

/** 组一回合的两条消息;不给卡/记忆/区域表 = 退回到改造前的单段简报(稳定段仍在 system) */
export function monarchMessages(parts: MonarchPromptParts): LlmMessage[] {
  const { brief } = parts;
  const system = [
    MONARCH_SYSTEM_PROMPT,
    '',
    ...(parts.card ? [cardSystemText(parts.card), ''] : []),
    WORLD_CONSTANTS,
    '',
    brief.textStable,
  ].join('\n');
  const user: string[] = [];
  const mem = memoryText(parts.memory);
  if (mem) user.push(mem, '');
  user.push(brief.textVolatile);
  if (parts.regions && parts.regions.total.count > 0) user.push('', formatRegionTable(parts.regions));
  if (parts.intel?.length) user.push('', '## 他国情报(渗透所得)', ...parts.intel.map(formatForeignIntel));
  return [
    { role: 'system', content: system },
    { role: 'user', content: user.join('\n') },
  ];
}
