# MCP 层构建脚本:把 mcp/*.ts 和它用到的 src/gen 纯计算模块编成 CommonJS,产出 mcp/.build/mcp/server.js
# 用法(在任意目录):pwsh mcp/build.ps1  或  powershell -ExecutionPolicy Bypass -File mcp/build.ps1

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$repo = Split-Path -Parent $PSScriptRoot
$tsc = Join-Path $repo 'node_modules\typescript\bin\tsc'

Write-Host '==> tsc -p mcp/tsconfig.build.json'
node $tsc -p tsconfig.build.json

$server = Join-Path $PSScriptRoot '.build\mcp\server.js'
if (!(Test-Path $server)) {
    throw "构建失败:没有生成 $server(看上面的 tsc 报错)"
}

# .build 在仓库里的父级 package.json 是 "type": "module",CommonJS 产物要单独声明
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot '.build\package.json'), '{"type":"commonjs"}')

Write-Host "构建完成: $server"
Write-Host '自检:  node mcp/.build/mcp/selftest.js'
Write-Host '协议自检: node mcp/.build/mcp/selftest-protocol.js'
Write-Host '启动:  node mcp/.build/mcp/server.js  (MCP 客户端通过 stdio 连接)'
