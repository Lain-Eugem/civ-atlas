/**
 * MCP 工具定义与分发。
 *
 * 每个工具都是「无头引擎」的一层薄包装:参数进来 → 调 engine.ts → 返回 JSON 文本。
 * 工具名统一用 civ_ 前缀,避免和其他 MCP Server 撞名。
 */
import {
  catalog,
  chronicleGet,
  createWorld,
  exportSession,
  getSession,
  openSession,
  stateGet,
  submitOrders,
  turnStep,
  worldIdOf,
} from './engine';
import { compileMonarchOrders, MONARCH_MAX_ORDERS } from '../src/gen/civ/monarch';
import { dmPresetInfo } from '../src/gen/civ/dm';
import { monarchBriefList, monarchRound, monarchStatus, setupMonarch, verifySession } from './monarch';
import { dmRound, dmSetup, dmStatus } from './dm';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

const SESSION_ID = { type: 'string', description: '会话 id(civ_session_open 返回的 sessionId)' } as const;

export const TOOLS: ToolDef[] = [
  {
    name: 'civ_world_create',
    description:
      '生成一颗新的星球(纯计算,不联网)。返回 worldId 和参数摘要,之后用 worldId 开会话。seed 相同、参数相同则世界逐位一致。',
    inputSchema: {
      type: 'object',
      properties: {
        seed: { type: 'integer', description: '世界种子(必填)' },
        params: {
          type: 'object',
          description:
            '可选:覆盖默认生成参数。常用:cells(地块数,1000–200000,越大越细越慢)、landFraction(陆地比例 0–1)、plates、mountains、temperature、rainfall、continents、gather、rugged、hardness、north。',
          additionalProperties: true,
        },
      },
      required: ['seed'],
    },
  },
  {
    name: 'civ_session_open',
    description:
      '打开一个推演会话:把世界推到 startYear 年初并停在那里。之后每回合先 civ_state_get 看局势、civ_orders_submit 交命令、civ_turn_step 推 stepYears 年。会话只存在于当前 MCP 进程内存里。',
    inputSchema: {
      type: 'object',
      properties: {
        worldId: { type: 'string', description: 'civ_world_create 返回的 worldId' },
        startYear: { type: 'integer', description: '起始年(必填,1–60000)' },
        stepYears: { type: 'integer', description: '一个回合推几年(默认 1,1–1000)', minimum: 1, maximum: 1000 },
        maxRounds: { type: 'integer', description: '最多几个回合(默认 1,1–200)', minimum: 1, maximum: 200 },
        endYear: { type: 'integer', description: '可选:推到这一年就停(必须 > startYear)' },
        dmPreset: { type: 'boolean', description: '可选:true = 打开 DM 规则预设(把引擎自动战争/议和/结盟/分裂压低,给外部君主留操作空间)。默认 false = 官方规则,与改造前逐字节一致。单项覆盖见 dmRules 或 civ_dm_preset。' },
        dmRules: {
          type: 'object',
          additionalProperties: true,
          description: '可选:DM 预设的单项覆盖(键名见 civ_dm_preset 返回的 items,如 {"war.odds":0.25});只有 dmPreset=true 时有效。',
        },
        mode: { type: 'string', enum: ['auto', 'monarch'], description: '推演模式。auto=内置规则自动推演;monarch=先开好会话,再用 civ_monarch_setup 把国家交给外部君主。两种模式不改变引擎确定性。' },
        civParams: {
          type: 'object',
          description:
            '可选:传给引擎的 CivParams 覆盖项,例如 tempo、regionArea、names、knobs(每个世界一套旋钮)。interventions 可放起始年之前的历史命令。',
          additionalProperties: true,
        },
      },
      required: ['worldId', 'startYear'],
    },
  },
  {
    name: 'civ_state_get',
    description:
      '读当前回合的完整状态:年份、在世国家(编号/国名/州数/国都/君主与倾向/稳定键)、已下命令、指纹(用于确定性对账)。可选带最近编年史。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        chronicle: { type: 'boolean', description: '是否附带最近编年史(默认 false)' },
        limit: { type: 'integer', description: '附带编年史条数(默认 40)' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'civ_orders_catalog',
    description: '列出引擎认的全部命令种类(24 种)、字段格式与稳定键写法。下命令前先看它。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'civ_orders_submit',
    description:
      '提交本回合的命令(0–N 条,引擎只收下在"现在"这一刻的命令,from 省略时自动填当前年份)。命令不会立刻生效,要再调 civ_turn_step。返回被拒收的命令及原因。若给 polityId,则 orders 可以写成"以该国为主语"的君主命令(不带 a/from,目标国家用编号 b)。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        orders: {
          type: 'array',
          description: '命令数组。原始格式:{"kind":"policy","a":"polity:c32577#0","preset":"expand"};君主格式:{"kind":"declare","b":6}',
          items: { type: 'object', additionalProperties: true },
        },
        polityId: { type: 'integer', description: '可选:按"这个国家的君主"口吻编译命令(自动补 a/from,校验目标国家)' },
      },
      required: ['sessionId', 'orders'],
    },
  },
  {
    name: 'civ_turn_step',
    description:
      '把已提交的命令交给引擎,再推 stepYears 年(或指定 years 年)。返回年份变化、各国州数增减、本回合大事、引擎拒收的命令。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        years: { type: 'integer', description: '可选:本回合推几年(默认用会话的 stepYears)', minimum: 1, maximum: 1000 },
        orders: {
          type: 'array',
          description: '可选:本次临时附加的命令(等价于先 civ_orders_submit 再 step)',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'civ_chronicle_get',
    description: '读编年史(可按年份区间和类型过滤),给模型作"上一回合大事记"用。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        from: { type: 'integer', description: '起始年(含)' },
        to: { type: 'integer', description: '结束年(含)' },
        kind: { type: 'string', description: '类型过滤,如 war / fall / split / dynasty / plague / collapse' },
        limit: { type: 'integer', description: '最多返回几条(默认 50,最多 5000)' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'civ_session_export',
    description: '把会话导出成 JSON 文件(含会话参数、世界参数、命令历史、状态、编年史),便于复盘/对账。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        path: { type: 'string', description: '可选:输出路径(默认写到会话日志目录的 export.json)' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'civ_brief_get',
    description:
      '只读君主简报:返回本回合每个在世国家的完整中文简报(不调 LLM、不推演)。可以用于自己编排外部君主(让 MCP 客户端模型直接看简报、用 civ_orders_submit 带 polityId 交命令),或检查提示词质量。',
    inputSchema: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
  },
  {
    name: 'civ_monarch_setup',
    description:
      '配置君主模式:选哪些国家由外部 LLM 接管,以及服务商/模型/Key/每回合最多命令数。Key 只存在当前进程内存,不写日志、不写导出;mock=true 时不联网,用确定性规则模拟君主。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        polities: {
          description: '可选:"all"=全部在世国家;数字=前 N 个大国;数组=指定国家编号(如 [6,2,7])。默认 "all"。',
        },
        maxOrders: { type: 'integer', minimum: 1, maximum: MONARCH_MAX_ORDERS, description: `每个国家每回合最多几条命令(默认 ${MONARCH_MAX_ORDERS})` },
        mock: { type: 'boolean', description: '不联网,用确定性 mock 君主(默认 false)' },
        provider: { type: 'string', enum: ['deepseek', 'bailian', 'custom'], description: '服务商;默认 deepseek' },
        baseUrl: { type: 'string', description: 'OpenAI 兼容服务地址;provider=custom 时必填,其他 provider 有默认值' },
        model: { type: 'string', description: '模型名;默认 deepseek-chat / qwen-plus' },
        apiKey: { type: 'string', description: 'API Key;也可以设置环境变量 DEEPSEEK_API_KEY / DASHSCOPE_API_KEY' },
        temperature: { type: 'number', minimum: 0, maximum: 2 },
        timeoutMs: { type: 'integer', description: '单次 LLM 请求超时毫秒(默认 120000,5000–600000)' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'civ_monarch_round',
    description:
      '跑一个君主回合:给每个被接管国家发简报 → 并发调用外部 LLM(或 mock)→ 把决策编译成引擎命令 → 统一推演 stepYears 年。返回每个君主的理由/命令/被拒原因、各国州数变化和本回合大事。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        years: { type: 'integer', minimum: 1, maximum: 1000, description: '可选:本回合推几年(默认用会话的 stepYears)' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'civ_monarch_status',
    description: '查看当前会话的君主模式配置(不含 Key)和已跑回合数。',
    inputSchema: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
  },
  {
    name: 'civ_session_verify',
    description:
      '确定性回放对账:用会话自己的世界参数和命令历史从第 0 年重推,比较 civ 指纹与年份。ok=true 说明君主回合只是把同一串命令分批交给引擎,没有改变引擎结果。',
    inputSchema: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
  },
  {
    name: 'civ_dm_preset',
    description:
      '查看/预览 DM 规则预设。预设把引擎自动战争、议和、结盟、分裂的劲头压低,给外部君主留操作空间;换算成每个世界的旋钮后随世界保存,不改变确定性。打开方式:civ_session_open 传 dmPreset:true(可再用 dmRules 覆盖单项)。不打开 = 官方规则,与改造前逐字节一致。',
    inputSchema: {
      type: 'object',
      properties: {
        overrides: {
          type: 'object',
          additionalProperties: true,
          description: '可选:覆盖预设里的单项(键名见返回的 items,如 {"war.odds":0.25})',
        },
      },
    },
  },
  {
    name: 'civ_dm_oracle_setup',
    description:
      '配置 DM 小决策 oracle:给"另一个设备上的本地模型"留的接口,只决定天灾、小贸易这类小事。任何 OpenAI 兼容的 /chat/completions 服务都行(OpenJEV、Ollama、LM Studio、vLLM、llama.cpp server 等),填 baseUrl + model 即可;Key 可选且只存当前进程内存。天灾会编译成引擎 disaster 命令(真改人口/发展,可回放对账),小贸易只记叙事。mock:true 不联网。也可以设置环境变量 CIV_DM_BASE_URL / CIV_DM_MODEL / CIV_DM_API_KEY。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        mock: { type: 'boolean', description: '不联网,用确定性 mock 小决策(默认 false)' },
        provider: { type: 'string', enum: ['custom', 'deepseek', 'bailian'], description: '本地模型用 custom;deepseek/bailian 用它们的默认地址' },
        baseUrl: { type: 'string', description: 'OpenAI 兼容地址,如 http://192.168.1.20:8000/v1;也可用环境变量 CIV_DM_BASE_URL' },
        model: { type: 'string', description: '模型名,如 openjev;也可用环境变量 CIV_DM_MODEL' },
        apiKey: { type: 'string', description: '可选 Bearer Key;也可用环境变量 CIV_DM_API_KEY' },
        temperature: { type: 'number', minimum: 0, maximum: 2 },
        timeoutMs: { type: 'integer', minimum: 5000, maximum: 600000, description: '单次请求超时毫秒(默认 120000)' },
        maxDecisions: { type: 'integer', minimum: 1, maximum: 5, description: '每回合最多几条小决策(默认 2)' },
        probe: { type: 'boolean', description: '配置完发一个最小请求测连通(默认 false)' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'civ_dm_oracle_status',
    description: '查看当前会话的 DM 小决策配置(不含 Key)和已跑回合数。',
    inputSchema: { type: 'object', properties: { sessionId: SESSION_ID }, required: ['sessionId'] },
  },
  {
    name: 'civ_dm_round',
    description:
      '跑一个 DM 小决策回合:问 oracle(或用手动 decisions 跳过模型)→ 编译成天灾/贸易叙事 → 交命令 → 推演 stepYears 年 → 写 dm-round 日志。若同时配置了君主模式,下一次 civ_monarch_round 也会自动把 DM 小决策并进同一回合。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: SESSION_ID,
        years: { type: 'integer', minimum: 1, maximum: 1000, description: '可选:本回合推几年(默认用会话的 stepYears)' },
        decisions: {
          type: 'array',
          description: '可选:手动指定小决策(绕过模型),格式同 oracle 返回的 decisions 数组',
          items: { type: 'object', additionalProperties: true },
        },
      },
      required: ['sessionId'],
    },
  },
];

function text(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** 执行一个工具。业务错误抛出 Error,由 server 转成 isError 结果。 */
export async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'civ_world_create': {
      const seed = args.seed;
      if (typeof seed !== 'number') throw new Error('缺少 seed(整数)');
      const params = args.params;
      const rec = createWorld({ seed, params: isObject(params) ? params : undefined });
      return text({
        worldId: rec.id,
        seed: rec.params.seed,
        cells: rec.params.cells,
        params: rec.params,
        generatedMs: rec.generatedMs,
      });
    }
    case 'civ_session_open': {
      const worldId = String(args.worldId ?? '');
      const startYear = numArg(args.startYear, 'startYear');
      const opened = openSession({
        worldId,
        startYear,
        stepYears: optNum(args.stepYears, 'stepYears'),
        maxRounds: optNum(args.maxRounds, 'maxRounds'),
        endYear: optNum(args.endYear, 'endYear'),
        mode: typeof args.mode === 'string' ? (args.mode as 'auto') : undefined,
        dmPreset: args.dmPreset === true ? (isObject(args.dmRules) ? (args.dmRules as never) : true) : undefined,
        civParams: isObject(args.civParams) ? (args.civParams as never) : undefined,
      });
      return text(opened.summary);
    }
    case 'civ_state_get': {
      const s = getSession(String(args.sessionId ?? ''));
      return text(stateGet(s, { chronicle: !!args.chronicle, limit: optNum(args.limit, 'limit') ?? undefined }));
    }
    case 'civ_orders_catalog':
      return text(catalog());
    case 'civ_dm_preset': {
      const overrides = isObject(args.overrides) ? (args.overrides as never) : undefined;
      return text(dmPresetInfo(overrides));
    }
    case 'civ_dm_oracle_setup': {
      const s = getSession(String(args.sessionId ?? ''));
      return text(
        await dmSetup(s, {
          mock: typeof args.mock === 'boolean' ? args.mock : undefined,
          provider: typeof args.provider === 'string' ? args.provider : undefined,
          baseUrl: typeof args.baseUrl === 'string' ? args.baseUrl : undefined,
          model: typeof args.model === 'string' ? args.model : undefined,
          apiKey: typeof args.apiKey === 'string' ? args.apiKey : undefined,
          temperature: optNum(args.temperature, 'temperature'),
          timeoutMs: optNum(args.timeoutMs, 'timeoutMs'),
          maxDecisions: optNum(args.maxDecisions, 'maxDecisions'),
          probe: args.probe === true,
        }),
      );
    }
    case 'civ_dm_oracle_status': {
      const s = getSession(String(args.sessionId ?? ''));
      return text(dmStatus(s));
    }
    case 'civ_dm_round': {
      const s = getSession(String(args.sessionId ?? ''));
      return text(
        await dmRound(s, {
          years: optNum(args.years, 'years'),
          decisions: Array.isArray(args.decisions) ? args.decisions : undefined,
        }),
      );
    }
    case 'civ_orders_submit': {
      const s = getSession(String(args.sessionId ?? ''));
      const orders = args.orders;
      if (!Array.isArray(orders)) throw new Error('orders 必须是数组');
      const polityId = optNum(args.polityId, 'polityId');
      if (polityId !== undefined) {
        const compiled = compileMonarchOrders(s.civ, s.play.year, Math.round(polityId), orders);
        submitOrders(s, compiled.commands);
        return text({ ...compiled, queued: s.queue.length, note: '君主格式已按国家编号编译;要生效请再调 civ_turn_step' });
      }
      return text(submitOrders(s, orders));
    }
    case 'civ_turn_step': {
      const s = getSession(String(args.sessionId ?? ''));
      const orders = Array.isArray(args.orders) ? args.orders : undefined;
      return text(turnStep(s, { years: optNum(args.years, 'years'), orders }));
    }
    case 'civ_chronicle_get': {
      const s = getSession(String(args.sessionId ?? ''));
      return text(
        chronicleGet(s, {
          from: optNum(args.from, 'from'),
          to: optNum(args.to, 'to'),
          kind: typeof args.kind === 'string' ? args.kind : undefined,
          limit: optNum(args.limit, 'limit'),
        }),
      );
    }
    case 'civ_session_export': {
      const s = getSession(String(args.sessionId ?? ''));
      return text(exportSession(s, typeof args.path === 'string' ? args.path : undefined));
    }
    case 'civ_brief_get': {
      const s = getSession(String(args.sessionId ?? ''));
      return text(monarchBriefList(s));
    }
    case 'civ_monarch_setup': {
      const s = getSession(String(args.sessionId ?? ''));
      return text(
        setupMonarch(s, {
          polities: args.polities as 'all' | number | number[] | undefined,
          maxOrders: optNum(args.maxOrders, 'maxOrders'),
          mock: typeof args.mock === 'boolean' ? args.mock : undefined,
          provider: typeof args.provider === 'string' ? args.provider : undefined,
          baseUrl: typeof args.baseUrl === 'string' ? args.baseUrl : undefined,
          model: typeof args.model === 'string' ? args.model : undefined,
          apiKey: typeof args.apiKey === 'string' ? args.apiKey : undefined,
          temperature: optNum(args.temperature, 'temperature'),
          timeoutMs: optNum(args.timeoutMs, 'timeoutMs'),
        }),
      );
    }
    case 'civ_monarch_round': {
      const s = getSession(String(args.sessionId ?? ''));
      return text(await monarchRound(s, { years: optNum(args.years, 'years') }));
    }
    case 'civ_monarch_status': {
      const s = getSession(String(args.sessionId ?? ''));
      const status = monarchStatus(s);
      return text(status ?? { sessionId: s.id, configured: false, note: '还没有配置君主模式;先调用 civ_monarch_setup' });
    }
    case 'civ_session_verify': {
      const s = getSession(String(args.sessionId ?? ''));
      return text(verifySession(s));
    }
    default:
      throw Object.assign(new Error(`未知工具 ${name}`), { code: -32602 });
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function numArg(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} 必须是数字`);
  return v;
}

function optNum(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  return numArg(v, name);
}

/** 供 selftest 用:世界 id 的纯函数版本 */
export { worldIdOf };
