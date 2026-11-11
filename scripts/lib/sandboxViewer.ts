/**
 * 把 MCP 沙盒监视台接进主站的开发服务器:pnpm dev 之后,同一个 5188 端口下多一个 /sandbox/。
 *
 * 只做开发期的事(apply: 'serve'),生产构建一个字节都不受影响:
 *   - 第一次用的时候替用户跑一遍 mcp/build.ps1 里的两步(tsc + 写 .build/package.json);
 *   - 起一个只监听 127.0.0.1 的监视台进程(随机空闲端口,不占 5190);
 *   - 把 /sandbox/* 与 /api/* 转给这个进程,页面里的 ./style.css、/api/xxx 都照常可用;
 *   - 在首页右下角挂一个「多 Agent 沙盒」小胶囊,点进去就是监视台。
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { join } from 'node:path';
import type { Plugin } from 'vite';

const SANDBOX_PATH = '/sandbox/';
const READY_TIMEOUT = 25_000;

/** 找一个空闲端口给监视台用(只在本机监听) */
function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createTcpServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? ok(port) : fail(new Error('拿不到空闲端口'))));
    });
  });
}

/** 产物比源码旧(或新增的服务端模块还没编出来)就要重新构建一次 */
function needsBuild(mcpDir: string, viewerJs: string): boolean {
  if (!existsSync(viewerJs)) return true;
  if (!existsSync(join(mcpDir, '.build', 'mcp', 'terrain.js'))) return true;
  const built = statSync(viewerJs).mtimeMs;
  for (const name of readdirSync(mcpDir)) {
    if (!name.endsWith('.ts')) continue;
    if (statSync(join(mcpDir, name)).mtimeMs > built + 1000) return true;
  }
  return false;
}

/** mcp/.build 缺了或旧了就先构建一次(和 mcp/build.ps1 等价,不依赖 PowerShell) */
function ensureViewerBuild(root: string): string {
  const mcpDir = join(root, 'mcp');
  const viewerJs = join(mcpDir, '.build', 'mcp', 'viewer.js');
  if (needsBuild(mcpDir, viewerJs)) {
    const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!existsSync(tsc)) throw new Error('没找到 typescript:先在仓库根目录跑 pnpm install');
    console.log('\n[沙盒] 第一次打开监视台,先构建 MCP 层(等价于 mcp/build.ps1)…');
    // 主站 src/render/labels/fonts.ts 里有一句 Vite 专属的 import.meta.env,在 CommonJS 的
    // 编译目标下 tsc 会报两条 TS1343/TS2339。产物照样完整生成(noEmitOnError:false),
    // 构建后由 build-compat.cjs 补掉,所以这里只看产物在不在,不把那两条当失败。
    let out = '';
    try {
      execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: mcpDir, stdio: 'pipe' });
    } catch (e) {
      out = String((e as { stdout?: Buffer }).stdout ?? '') + String((e as { stderr?: Buffer }).stderr ?? '');
    }
    if (!existsSync(join(mcpDir, '.build', 'mcp', 'terrain.js'))) {
      console.error(out);
      throw new Error('MCP 层编译失败,看上面的 tsc 报错');
    }
    writeFileSync(join(mcpDir, '.build', 'package.json'), '{"type":"commonjs"}');
    if (!existsSync(viewerJs)) throw new Error('构建完了但没有 mcp/.build/mcp/viewer.js,看上面的 tsc 报错');
  }
  // 每次启动都跑一遍(幂等、毫秒级):老构建里主站渲染模块的 import.meta.env 也要补上,
  // 否则 Node 加载 render/fantasy.ts 时会直接语法错误。细节见 mcp/build-compat.cjs
  const compat = join(mcpDir, 'build-compat.cjs');
  if (existsSync(compat)) execFileSync(process.execPath, [compat], { cwd: mcpDir, stdio: 'inherit' });
  return viewerJs;
}

/** 监视台进程起来没有 */
function ping(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: 900 }, (res) => {
      res.resume();
      ok(res.statusCode === 200);
    });
    req.on('error', () => ok(false));
    req.on('timeout', () => {
      req.destroy();
      ok(false);
    });
    req.end();
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function page(title: string, detail: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:light}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f2ed;color:#1d1d1f;
font:13px/1.7 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}
.card{max-width:520px;padding:26px 30px;border-radius:16px;background:rgba(252,252,253,.9);
box-shadow:0 0 0 .5px rgba(28,25,18,.1),0 18px 52px rgba(28,25,18,.14)}
h1{margin:0 0 8px;font-size:16px;font-weight:600}
p{margin:0 0 10px;color:#6e6e73}
code{padding:1px 6px;border-radius:5px;background:rgba(118,118,128,.14);font-size:12px}
a{color:#007aff;text-decoration:none}
</style>
<div class="card"><h1>${title}</h1><p>${detail}</p><p><a href="/">← 回到地图</a></p></div></html>`;
}

/** 把请求转给监视台进程 */
function forward(port: number, req: IncomingMessage, res: ServerResponse, path: string, isApi: boolean): void {
  const upstream = httpRequest(
    {
      host: '127.0.0.1',
      port,
      path,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    },
    (upRes) => {
      if (res.headersSent) return;
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.setTimeout(180_000, () => upstream.destroy(new Error('监视台响应超时')));
  upstream.on('error', () => {
    if (isApi) sendJson(res, 502, { error: '沙盒监视台还没就绪,稍等几秒再试' });
    else if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page('沙盒监视台暂时不可用', '监视台进程没有响应。看开发服务器窗口里 [沙盒] 开头的日志,或者直接跑 <code>pnpm mcp:build</code> 再试。'));
    } else res.end();
  });
  req.pipe(upstream);
}

/** 首页右下角的入口胶囊(只在开发时注入) */
const ENTRY_CSS = `
.sandbox-entry{position:fixed;left:28px;bottom:96px;z-index:40;display:inline-flex;align-items:center;gap:7px;
height:30px;padding:0 13px;border-radius:999px;background:rgba(255,255,255,.84);color:#1d1d1f;
font:12px/1 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;text-decoration:none;
box-shadow:0 0 0 .5px rgba(28,25,18,.14),0 8px 24px rgba(28,25,18,.16);backdrop-filter:blur(16px) saturate(1.6);}
.sandbox-entry::before{content:'';width:6px;height:6px;border-radius:50%;background:#007aff;box-shadow:0 0 0 3px rgba(0,122,255,.14);}
.sandbox-entry:hover{background:#fff}
@media (prefers-color-scheme:dark){.sandbox-entry{background:rgba(30,30,33,.86);color:#f5f5f7;box-shadow:0 0 0 .5px rgba(255,255,255,.16),0 8px 24px rgba(0,0,0,.5)}
.sandbox-entry:hover{background:#2c2c2e}}
`;

export function sandboxViewerPlugin(): Plugin {
  let root = '';
  let port = 0;
  let child: ChildProcess | null = null;
  let ready: Promise<void> | null = null;
  let stopping = false;

  async function start(): Promise<void> {
    const viewerJs = ensureViewerBuild(root);
    port = await freePort();
    child = spawn(process.execPath, [viewerJs, '--port', String(port)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(`[沙盒] ${d.toString()}`));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[沙盒] ${d.toString()}`));
    child.on('exit', (code) => {
      child = null;
      if (stopping) return;
      // 下次再打开 /sandbox/ 时重新起一个,而不是一直转给一个已经没有的端口
      ready = null;
      console.log(`\n[沙盒] 监视台进程已退出(code ${code ?? '?'});再打开 /sandbox/ 会重新起一个。`);
    });

    const t0 = Date.now();
    while (Date.now() - t0 < READY_TIMEOUT) {
      if (await ping(port)) {
        const sitePort = process.env.CIV_DEV_PORT || '5188';
        console.log(`[沙盒] 监视台已就绪 → http://127.0.0.1:${sitePort}${SANDBOX_PATH}  (内部端口 ${port})`);
        return;
      }
      if (!child) throw new Error('监视台进程启动后立刻退出了,看上面的 [沙盒] 日志');
      await new Promise((r) => setTimeout(r, 160));
    }
    throw new Error('监视台 25 秒内没有就绪');
  }

  function ensure(): Promise<void> {
    if (!ready) {
      ready = start().catch((e: unknown) => {
        ready = null;
        throw e;
      });
    }
    return ready;
  }

  function stop(): void {
    stopping = true;
    if (child) {
      child.kill();
      child = null;
    }
  }

  return {
    name: 'civ-sandbox-viewer',
    apply: 'serve',
    configResolved(c) {
      root = c.root;
      if (c.server.port) process.env.CIV_DEV_PORT = String(c.server.port);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '/';
        if (url === '/sandbox' || url.startsWith('/sandbox?')) {
          res.writeHead(302, { location: url.replace('/sandbox', SANDBOX_PATH) });
          res.end();
          return;
        }
        const isPage = url.startsWith(SANDBOX_PATH);
        const isApi = !isPage && (url === '/api' || url.startsWith('/api/'));
        if (!isPage && !isApi) return next();

        const target = isPage ? url.slice('/sandbox'.length) : url;
        ensure()
          .then(() => forward(port, req, res, target, isApi))
          .catch((e: unknown) => {
            const detail = e instanceof Error ? e.message : String(e);
            if (isApi) return sendJson(res, 503, { error: `沙盒监视台没起来:${detail}` });
            res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
            res.end(page('沙盒监视台没起来', `启动时出错:<code>${detail}</code>。可以先跑 <code>pnpm mcp:build</code> 看具体报错。`));
          });
      });

      // Vite 已经在监听了再起监视台:不让首次构建卡住首页打开
      if (server.httpServer && server.httpServer.listening) setTimeout(() => void ensure().catch(() => {}), 0);
      else server.httpServer?.once('listening', () => void ensure().catch(() => {}));

      server.httpServer?.once('close', stop);
      process.once('exit', stop);
    },
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          { tag: 'style', children: ENTRY_CSS, injectTo: 'head' },
          {
            tag: 'a',
            attrs: { href: SANDBOX_PATH, class: 'sandbox-entry', title: '打开多 Agent 沙盒监视台(本地进程)' },
            children: '多 Agent 沙盒',
            injectTo: 'body',
          },
        ],
      };
    },
  };
}
