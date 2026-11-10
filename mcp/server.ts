/**
 * MCP Server:零依赖的 JSON-RPC 2.0 over stdio 实现。
 *
 * 传输:标准输入逐行读 JSON-RPC 消息,标准输出逐行写响应(换行分隔)。
 * stdout 只允许出现协议消息;所有日志写 stderr。
 *
 * 用法: node mcp/.build/mcp/server.js
 */
import { createInterface } from 'node:readline';
import { TOOLS, callTool } from './tools';

const PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const SERVER_INFO = { name: 'civ-atlas-mcp', version: '0.1.0' };

type JsonRpcId = number | string | null;

interface RpcRequest {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id: JsonRpcId, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: JsonRpcId, code: number, message: string, data?: unknown): void {
  send({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } });
}

function log(...args: unknown[]): void {
  process.stderr.write(['[civ-atlas-mcp]', ...args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))].join(' ') + '\n');
}

/** 处理一条已解析的 JSON-RPC 消息(导出给测试用) */
export function handleMessage(msg: unknown): void {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    replyError(null, -32600, 'Invalid Request: 顶层必须是对象');
    return;
  }
  const req = msg as RpcRequest;
  const id = req.id ?? null;
  const method = req.method;
  if (typeof method !== 'string') {
    replyError(id, -32600, 'Invalid Request: 缺少 method');
    return;
  }

  // 通知(没有 id):不需要响应
  const isNotification = req.id === undefined;
  if (method.startsWith('notifications/')) {
    log('notification', method);
    return;
  }
  if (isNotification) {
    log('unhandled notification', method);
    return;
  }

  switch (method) {
    case 'initialize': {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      const protocolVersion = SUPPORTED_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION;
      reply(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          '这是《文明与地图》(civ-atlas)的无头推演引擎。流程: civ_world_create → civ_session_open → 每回合 { civ_state_get → civ_orders_submit → civ_turn_step }。所有参数(seed/起始年/回合年数/回合数/生成参数/引擎参数)都由调用方给定,没有写死的对局。',
      });
      return;
    }
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const name = params.name;
      if (typeof name !== 'string') {
        replyError(id, -32602, 'Invalid params: 缺少工具名 name');
        return;
      }
      const args = params.arguments;
      const argv: Record<string, unknown> = typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
      try {
        const result = callTool(name, argv);
        reply(id, result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const raw = e as { code?: unknown };
        const code = typeof raw.code === 'number' ? raw.code : undefined;
        if (code === -32602) {
          replyError(id, -32602, message);
          return;
        }
        // 工具执行失败:按 MCP 约定放进 result.isError,让模型能看到原因并自己纠正
        reply(id, { content: [{ type: 'text', text: `错误:${message}` }], isError: true });
      }
      return;
    }
    case 'resources/list':
      reply(id, { resources: [] });
      return;
    case 'resources/templates/list':
      reply(id, { resourceTemplates: [] });
      return;
    case 'prompts/list':
      reply(id, { prompts: [] });
      return;
    case 'logging/setLevel':
      reply(id, {});
      return;
    default:
      replyError(id, -32601, `Method not found: ${method}`);
      return;
  }
}

function main(): void {
  log('server started (stdio JSON-RPC 2.0)');
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      replyError(null, -32700, 'Parse error: 不是合法 JSON');
      return;
    }
    try {
      handleMessage(msg);
    } catch (e) {
      log('unhandled', e instanceof Error ? e.stack ?? e.message : String(e));
      replyError(null, -32603, 'Internal error');
    }
  });
  rl.on('close', () => {
    log('stdin closed, exiting');
    process.exit(0);
  });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

if (require.main === module) main();
