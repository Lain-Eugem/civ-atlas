# MCP 层构建脚本:把 mcp/*.ts 和它用到的 src/gen 纯计算模块编成 CommonJS,产出 mcp/.build/mcp/server.js
# 用法(在任意目录):pwsh mcp/build.ps1  或  powershell -ExecutionPolicy Bypass -File mcp/build.ps1

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$repo = Split-Path -Parent $PSScriptRoot
$tsc = Join-Path $repo 'node_modules\typescript\bin\tsc'

Write-Host '==> tsc -p mcp/tsconfig.build.json'
# CommonJS 目标下 tsc 会报 6 条既有诊断,产物仍会完整生成(noEmitOnError:false):
#   - src/render/labels/fonts.ts(48) 两条 TS1343/TS2339:浏览器专属的 import.meta.env,随后由 build-compat.cjs 补掉;
#   - mcp/selftest-monarch-sandbox.ts(118/132/142/168) 四条 TS2345:selftest 断言的类型,不影响产物。
# 只有这 6 条是「可容忍」的。不能像以前那样只看产物在不在就当成功:那样会把新引入的
# 类型错误一起吞掉(noEmitOnError:false 时产物照样生成)。下面把诊断逐条对照白名单,
# 出现预期之外的 error TS、或 tsc 自己崩了(非零退出码却一条诊断都没有),就打印全文并失败。
$prevPref = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$tscOut = & node $tsc -p tsconfig.build.json 2>&1
$tscExit = $LASTEXITCODE
$ErrorActionPreference = $prevPref
$tscLines = @($tscOut | ForEach-Object { "$_" })

# 上面 6 条的匹配式。tsc 诊断里的路径相对它运行时的 cwd:脚本在 mcp/ 下跑时是
# 「selftest-monarch-sandbox.ts」和「../src/render/labels/fonts.ts」,从仓库根目录跑时又带 mcp/、src/ 前缀,
# 所以按「文件名 + 错误码」认,不写死前缀(分隔符 / 和 \ 都认)。
$tolerable = '(?:^|[/\\])selftest-monarch-sandbox\.ts\(\d+,\d+\): error TS2345:|(?:^|[/\\])fonts\.ts\(\d+,\d+\): error TS(1343|2339):'
$diagnostics = @($tscLines | Where-Object { $_ -match 'error TS\d+:' })
$unexpected = @($diagnostics | Where-Object { $_ -notmatch $tolerable })
if ($unexpected.Count -gt 0 -or ($tscExit -ne 0 -and $diagnostics.Count -eq 0)) {
    $tscLines | Write-Host
    throw "构建失败:tsc 有 $($unexpected.Count) 条预期之外的错误(退出码 $tscExit)。可容忍的只有 selftest-monarch-sandbox.ts 的 4 条 TS2345 与 fonts.ts 的 TS1343/TS2339,见上面的输出"
}

# 主站渲染模块是给浏览器写的,CommonJS 产物里的 import.meta.env 要补一下(详见 build-compat.cjs)
node (Join-Path $PSScriptRoot 'build-compat.cjs')
if ($LASTEXITCODE -ne 0) { throw '构建产物兼容补丁失败' }

$server = Join-Path $PSScriptRoot '.build\mcp\server.js'
$terrain = Join-Path $PSScriptRoot '.build\mcp\terrain.js'
if (!(Test-Path $server) -or !(Test-Path $terrain)) {
    $tscLines | Write-Host
    throw "构建失败:没有生成 $server / $terrain(看上面的 tsc 报错)"
}
Write-Host "==> tsc 完成($($diagnostics.Count) 条既有诊断已核对为可容忍,预期外 0 条;fonts.ts 的 import.meta 已由兼容补丁处理)"

# .build 在仓库里的父级 package.json 是 "type": "module",CommonJS 产物要单独声明
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot '.build\package.json'), '{"type":"commonjs"}')

Write-Host "构建完成: $server"
Write-Host '自检:  node mcp/.build/mcp/selftest.js'
Write-Host '协议自检: node mcp/.build/mcp/selftest-protocol.js'
Write-Host '启动:  node mcp/.build/mcp/server.js  (MCP 客户端通过 stdio 连接)'
