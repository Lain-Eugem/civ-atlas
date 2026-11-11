/*
 * 构建产物的兼容补丁(幂等,可以反复跑)。
 *
 * mcp 层用 CommonJS 跑在 Node 里,而主站的渲染模块是给浏览器 / Worker 写的。
 * src/render/labels/fonts.ts 里有一句 Vite 专属的 import.meta.env.BASE_URL ——
 * 它在 CommonJS 产物里是语法错误,会让整条 render/fantasy.ts 依赖链加载失败。
 * 字体只在画矢量标注时用到,Node 端跑的是像素层,把这个 base 固定成 './' 即可。
 *
 * 不修改任何上游 src 文件:只改 .build/ 里的产物。
 * mcp/build.ps1 与 scripts/lib/sandboxViewer.ts 的自动构建都会调用本脚本。
 */
const fs = require('node:fs');
const path = require('node:path');

const buildDir = path.join(__dirname, '.build');
if (!fs.existsSync(buildDir)) {
  console.log('[沙盒] 还没有 .build,跳过兼容补丁');
  process.exit(0);
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(path.join(buildDir, 'src'), []);
let patched = 0;
let leftover = 0;
for (const p of files) {
  let s = fs.readFileSync(p, 'utf8');
  if (!s.includes('import.meta')) continue;
  const before = s;
  s = s.replace(/import\.meta\.env\.BASE_URL\s*\?\?\s*['"]\.\/['"]/g, "'./'");
  s = s.replace(/import\.meta\.env\.BASE_URL/g, "'./'");
  if (s !== before) {
    fs.writeFileSync(p, s);
    patched++;
  }
  if (s.includes('import.meta')) leftover++;
}
console.log(`[沙盒] 渲染模块兼容补丁:检查 ${files.length} 个文件,修补 ${patched} 个,剩余 import.meta ${leftover} 个`);
