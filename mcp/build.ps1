# MCP 层构建脚本:把 mcp/*.ts 和它用到的 src/gen 纯计算模块编成 CommonJS,产出 mcp/.build/mcp/server.js
# 用法(在任意目录):pwsh mcp/build.ps1  或  powershell -ExecutionPolicy Bypass -File mcp/build.ps1

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$repo = Split-Path -Parent $PSScriptRoot
$tsc = Join-Path $repo 'node_modules\typescript\bin\tsc'

Write-Host '==> tsc -p mcp/tsconfig.build.json'
# 主站 src/render/labels/fonts.ts 有一句 Vite 专属的 import.meta.env;CommonJS 编译目标下
# tsc 会报两条 TS1343/TS2339,但产物仍会完整生成(noEmitOnError:false),随后由 build-compat.cjs 补掉。
# 因此这里不以 tsc 的退出码判成败,也不把那两条吓人的提示打出来,改看关键产物在不在。
$prevPref = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$tscOut = & node $tsc -p tsconfig.build.json 2>&1
$ErrorActionPreference = $prevPref

# 主站渲染模块是给浏览器写的,CommonJS 产物里的 import.meta.env 要补一下(详见 build-compat.cjs)
node (Join-Path $PSScriptRoot 'build-compat.cjs')
if ($LASTEXITCODE -ne 0) { throw '构建产物兼容补丁失败' }

$server = Join-Path $PSScriptRoot '.build\mcp\server.js'
$terrain = Join-Path $PSScriptRoot '.build\mcp\terrain.js'
if (!(Test-Path $server) -or !(Test-Path $terrain)) {
    $tscOut | Write-Host
    throw "构建失败:没有生成 $server / $terrain(看上面的 tsc 报错)"
}
Write-Host '==> tsc 完成(主站 fonts.ts 的两条 import.meta 提示已由兼容补丁处理)'

# .build 在仓库里的父级 package.json 是 "type": "module",CommonJS 产物要单独声明
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot '.build\package.json'), '{"type":"commonjs"}')

Write-Host "构建完成: $server"
Write-Host '自检:  node mcp/.build/mcp/selftest.js'
Write-Host '协议自检: node mcp/.build/mcp/selftest-protocol.js'
Write-Host '启动:  node mcp/.build/mcp/server.js  (MCP 客户端通过 stdio 连接)'
