import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConst, gzip } from 'node:zlib';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fakeAiMiddleware } from './scripts/lib/fakeAiServer';
import { inlineIconsPlugin } from './scripts/lib/inlineIcons';
import { beianPagesPlugin } from './scripts/lib/beian';
import { loadScreenPlugin } from './scripts/lib/loadScreen';
import { checkPagePlugin } from './scripts/lib/sandboxCheckPage';
import { sandboxViewerPlugin } from './scripts/lib/sandboxViewer';
import { readWhatsNew } from './scripts/lib/whatsNew';
import { beianRecords } from './src/ui/beian';
import { SOURCE_URL } from './src/ui/links';
import { ShardSequencer } from './tests/lib/shardSequencer';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string; license: string };

/** 构建时的代码提交号(短);不在 git 仓库里构建时取 GITHUB_SHA,都没有就空着 */
function buildCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return process.env.GITHUB_SHA?.slice(0, 7) ?? '';
  }
}

/** 构建那天(北京时间,2026-10-11):测试网站多出来的功能预计哪天更新到正式网站,从这天算(src/ui/betaNews.ts) */
const BUILD_DAY = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/**
 * 网站备案号:环境变量 ICP_BEIAN(网站的发布流程从仓库变量传进来)。没设 = 哪里都不挂(src/ui/beian.ts):
 * 页面上的那几处、加载画面、public/ 下的隐私政策、用户协议、使用教程
 */
const ICP_BEIAN = process.env.ICP_BEIAN?.trim() ?? '';
const BEIAN = beianRecords(ICP_BEIAN);

/**
 * 打包出来的每个 JS 文件开头的署名:作品名、版本、版权、许可证、源代码地址(`/*!` 开头的注释压缩时会保留)。
 * 主程序另带代码提交号,对得上是哪一版;后台计算的几个文件、用到时才下载的小文件(二维码)不带,
 * 不然每次发布它们的文件名都会变,浏览器得重新下载没改过的代码
 */
function banner(commit = ''): string {
  return `/*! 文明与地图 v${pkg.version}${commit ? ` (${commit})` : ''} | Copyright (C) 2026 guaner-334 | ${pkg.license} | ${SOURCE_URL} */`;
}

/** 预先压好的文件:这几种文本文件和 wasm(.html 不压:发布流程最后才换页面本身,压好的那份要跟着它一起换) */
const PACK_EXT = /\.(js|mjs|css|json|svg|txt|md|wasm)$/;

/**
 * 构建完把文本文件各压一份最高等级的 .gz 和 .br 放在旁边(gzip 9 级、brotli 11 级),
 * 网站服务器打开"有压好的就直接发"(nginx 的 gzip_static / brotli_static)后不用每次现压,下载的也更少。
 * 每个都压,再小、压了不见小的也压:发布时不删服务器上的旧文件,名字不变的文件(guide.md、whats-new.json……)
 * 这次不压的话,服务器上还留着上次压的那份旧内容,会被发出去
 */
function precompress(): Plugin {
  let outDir = '';
  const gz = promisify(gzip);
  const br = promisify(brotliCompress);
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(p)));
      else if (PACK_EXT.test(e.name)) out.push(p);
    }
    return out;
  };
  return {
    name: 'precompress',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    async closeBundle() {
      const files = await walk(outDir);
      await Promise.all(
        files.map(async (f) => {
          const src = await readFile(f);
          const [g, b] = await Promise.all([
            gz(src, { level: 9 }),
            br(src, { params: { [zlibConst.BROTLI_PARAM_QUALITY]: 11, [zlibConst.BROTLI_PARAM_MODE]: zlibConst.BROTLI_MODE_TEXT, [zlibConst.BROTLI_PARAM_SIZE_HINT]: src.length } }),
          ]);
          await Promise.all([writeFile(`${f}.gz`, g), writeFile(`${f}.br`, b)]);
        }),
      );
    },
  };
}

/**
 * 署名放在每个文件的最开头:压缩时 import 和几个小函数会被挪到署名前面(主程序 import 首页那一份的名字很长,署名就落到了几千字以后)
 */
function bannerFirst(): Plugin {
  return {
    name: 'banner-first',
    apply: 'build',
    enforce: 'post',
    // vite 自己的 generateBundle 会把点开才下载的文件清单(__vite__mapDeps)加到最前面:要排在它后面再挪
    generateBundle: {
      order: 'post',
      handler(_o, bundle) {
        for (const c of Object.values(bundle)) {
          if (c.type !== 'chunk') continue;
          const m = /\/\*! 文明与地图 [^*]*\*\//.exec(c.code);
          if (m && m.index > 0) c.code = m[0] + c.code.slice(0, m.index) + c.code.slice(m.index + m[0].length);
        }
      },
    },
  };
}

/** 界面上显示的版本号(src/ui/version.ts)、构建那天(src/ui/betaNews.ts)、备案号(src/ui/beian.ts) */
const DEFINE = { __APP_VERSION__: JSON.stringify(pkg.version), __APP_COMMIT__: JSON.stringify(buildCommit()), __BUILD_DAY__: JSON.stringify(BUILD_DAY), __ICP_BEIAN__: JSON.stringify(ICP_BEIAN) };

export default defineConfig({
  base: './',
  define: DEFINE,
  plugins: [
    react(),
    // 浏览器标签上的图标写进页面(data: 网址):拖地图、换图层改网址时,浏览器不再一遍遍去要图标(scripts/lib/inlineIcons.ts)
    inlineIconsPlugin(),
    // 新功能清单连同构建那天写成网站上的 whats-new.json:正式网站和测试网站互相读,版本号上列出测试网站多出来的(src/ui/betaNews.ts)
    {
      name: 'whats-new',
      apply: 'build',
      generateBundle() {
        this.emitFile({ type: 'asset', fileName: 'whats-new.json', source: `${JSON.stringify({ built: BUILD_DAY, news: readWhatsNew() })}\n` });
      },
    },
    // 插件隔离自检页只进测试网站(scripts/lib/sandboxCheckPage.ts)
    checkPagePlugin(process.env.VITE_BETA_SITE === '1', { banner: banner(), define: DEFINE, plugins: [bannerFirst()] }),
    precompress(),
    bannerFirst(),
    // 加载画面(scripts/lib/loadScreen.ts):第一次打开时先出网站图标、名字和一条真的进度条,页面的代码、样式表由它数着下好再交给浏览器;
    // 打开的不是首页时主程序也一起下
    loadScreenPlugin(BEIAN),
    // 隐私政策、用户协议、使用教程(public/ 下的静态页)最底下的备案号:构建完写进去(scripts/lib/beian.ts)
    beianPagesPlugin(BEIAN),
    // 开发时的假网站服务器(账号、云同步、分享、我们的 AI;接口约定见 src/ai/providers/official.ts、src/account/cloud.ts 文件头):
    // 网址加 aiServer=fake 使用;正式构建里没有。分享短链接 /s/<码> 照正式网站的做法转到 /?s=<码>(开发时带上 aiServer=fake)
    {
      name: 'fake-ai-server',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use('/__fake-ai', fakeAiMiddleware({ inviteOnly: true }));
        server.middlewares.use((req, res, next) => {
          const m = /^\/s\/([A-Za-z0-9]+)\/?(?:\?.*)?$/.exec(req.url ?? '');
          if (!m) return next();
          res.writeHead(302, { Location: `/?s=${m[1]}&aiServer=fake` });
          res.end();
        });
      },
    },
    // 多 Agent 沙盒监视台:同一个开发服务器(scripts/lib/sandboxViewer.ts),pnpm dev 后打开 /sandbox/ 即可,
    // 不用再单独起 5190;只在开发时挂,生产构建没有这一层
    sandboxViewerPlugin(),
  ],
  build: {
    rollupOptions: {
      output: {
        banner: (chunk) => banner(chunk.isEntry ? buildCommit() : ''),
        // 导出视频时才下载的 MP4 封装库单独一个文件、用自己的名字(它的入口也叫 index,不然和主程序同名)
        manualChunks: { mediabunny: ['mediabunny'] },
      },
    },
  },
  worker: {
    format: 'es',
    plugins: () => [bannerFirst()],
    rollupOptions: {
      output: {
        banner: () => banner(),
        // 用到插件才下载的 QuickJS 那一包用自己的名字(它的入口也叫 index,不然和主程序同名)
        chunkFileNames: (c) => (c.facadeModuleId && /[\\/]gen[\\/]quickjs[\\/]index\.ts$/.test(c.facadeModuleId) ? 'assets/quickjs-[hash].js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  // 显式绑 IPv4 回环:默认的 'localhost' 在 Windows 上会被解析成 ::1,只监听 IPv6,
  // 而浏览器访问 localhost 走的是 127.0.0.1,于是报「拒绝连接」。绑 127.0.0.1 两边都对得上,
  // 也仍然只对本机开放(不设 host: true,免得把带 Key 的沙盒接口暴露到局域网)。
  server: { host: '127.0.0.1', port: 5188, strictPort: true },
  // 只跑 tests/ 下的单测;本地工具目录(.claude/)里的不算。
  // 先后和分份(PR 检查上分几台机器跑)按各文件大概多久排,见 tests/lib/shardSequencer.ts
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '.claude/**'],
    sequence: { sequencer: ShardSequencer },
  },
});
