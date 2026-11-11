/**
 * MCP 协议自检:真的 spawn 一个 server.js,按换行分隔的 JSON-RPC 2.0 往返。
 * 运行: node mcp/.build/mcp/selftest-protocol.js
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

interface RpcMessage {
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

interface CallResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

let pass = 0;
let fail = 0;

function ok(cond: boolean, name: string, detail?: unknown): void {
  if (cond) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail === undefined ? '' : `  实际:${JSON.stringify(detail)}`}`);
  }
}

function main(): void {
  console.log('== civ-atlas MCP 协议自检 ==');
  const serverPath = join(__dirname, 'server.js');
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let childErr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    childErr += chunk.toString('utf8');
  });

  const waiters = new Map<number, (msg: RpcMessage) => void>();
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(trimmed) as RpcMessage;
    } catch {
      console.log('FAIL  收到非 JSON 输出', trimmed.slice(0, 200));
      fail += 1;
      return;
    }
    const id = typeof msg.id === 'number' ? msg.id : undefined;
    if (id !== undefined) {
      const fn = waiters.get(id);
      if (fn) {
        waiters.delete(id);
        fn(msg);
      }
    }
  });

  let seq = 0;
  const request = (method: string, params: unknown): Promise<RpcMessage> => {
    seq += 1;
    const id = seq;
    return new Promise<RpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (waiters.delete(id)) reject(new Error(`请求超时: ${method}`));
      }, 180_000);
      waiters.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  const notify = (method: string, params: unknown): void => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };
  const call = (name: string, args: Record<string, unknown>): Promise<CallResult> => request('tools/call', { name, arguments: args }).then((m) => m.result as CallResult);
  const payload = (r: CallResult): Record<string, unknown> => JSON.parse(r.content[0].text) as Record<string, unknown>;

  void (async () => {
    try {
      const init = await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'civ-atlas-selftest', version: '0.1.0' },
      });
      const initResult = init.result as { protocolVersion?: string; serverInfo?: { name?: string } };
      ok(initResult?.protocolVersion === '2024-11-05', 'initialize 握手成功', initResult);
      ok(initResult?.serverInfo?.name === 'civ-atlas-mcp', 'serverInfo 正确', initResult?.serverInfo);
      notify('notifications/initialized', {});

      const list = await request('tools/list', {});
      const tools = (list.result as { tools: { name: string }[] }).tools;
      ok(tools.length === 21, 'tools/list 返回 21 个工具', tools.length);
      ok(tools.every((t) => typeof t.name === 'string' && t.name.startsWith('civ_')), '工具名统一 civ_ 前缀');

      const world = payload(await call('civ_world_create', { seed: 7, params: { cells: 12000 } }));
      ok(typeof world.worldId === 'string', 'civ_world_create 返回 worldId', world);
      const opened = payload(
        await call('civ_session_open', { worldId: world.worldId, startYear: 1200, stepYears: 2, maxRounds: 1 }),
      );
      ok(typeof opened.sessionId === 'string' && opened.year === 1200, 'civ_session_open 停在起始年', opened);

      const state = payload(await call('civ_state_get', { sessionId: opened.sessionId }));
      const polities = state.polities as { id: number; key: string }[];
      ok(Array.isArray(polities) && polities.length > 0, 'civ_state_get 返回国家列表', polities?.length);

      const cat = payload(await call('civ_orders_catalog', {}));
      ok((cat.kinds as unknown[]).length === 27, 'civ_orders_catalog 返回 27 种命令', (cat.kinds as unknown[])?.length);

      const sub = payload(
        await call('civ_orders_submit', {
          sessionId: opened.sessionId,
          orders: [{ kind: 'policy', a: polities[0].key, preset: 'expand' }],
        }),
      );
      ok((sub.commands as unknown[]).length === 1 && (sub.rejected as unknown[]).length === 0, 'civ_orders_submit 接收合法命令', sub);

      const turn = payload(await call('civ_turn_step', { sessionId: opened.sessionId }));
      ok(turn.fromYear === 1200 && turn.toYear === 1202, 'civ_turn_step 推 2 年', turn);
      ok(typeof turn.fingerprint === 'string' && (turn.fingerprint as string).length === 16, 'turn 返回状态指纹');

      const chronicle = payload(await call('civ_chronicle_get', { sessionId: opened.sessionId, limit: 5 }));
      ok((chronicle.entries as unknown[]).length > 0, 'civ_chronicle_get 返回条目');

      const exported = payload(await call('civ_session_export', { sessionId: opened.sessionId }));
      ok(typeof exported.path === 'string', 'civ_session_export 写文件', exported);

      const unknown = await request('tools/call', { name: 'civ_no_such_tool', arguments: {} });
      ok(unknown.error?.code === -32602, '未知工具 → -32602', unknown.error);

      const badSession = await call('civ_state_get', { sessionId: 'no-such-session' });
      ok(badSession.isError === true, '业务错误 → isError 结果', badSession);

      const missing = await request('no/such/method', {});
      ok(missing.error?.code === -32601, '未知方法 → -32601', missing.error);
    } catch (e) {
      fail += 1;
      console.log('FAIL  协议自检异常:', e instanceof Error ? e.message : e);
    } finally {
      child.stdin.end();
      child.kill();
      rl.close();
      if (fail > 0 && childErr.trim()) console.log('\n--- server stderr ---\n' + childErr.trim());
      console.log(`\n通过 ${pass} 项,失败 ${fail} 项`);
      process.exitCode = fail > 0 ? 1 : 0;
    }
  })();
}

main();
