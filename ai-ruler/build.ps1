# 编译 ai-ruler(生成 .build\ai-ruler\run.js),可重复运行
# 用法:在仓库根目录 powershell -ExecutionPolicy Bypass -File ai-ruler\build.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

Write-Host '编译 ai-ruler ...'
node node_modules\typescript\bin\tsc -p ai-ruler\tsconfig.build.json

# tsc 会顺带报 src/ui 里 import.meta 的类型错误——那些是浏览器专用文件,和 demo 无关,
# tsc 默认 noEmitOnError=false,产物照样生成。这里只检查产物在不在。
if (-not (Test-Path 'ai-ruler\.build\ai-ruler\run.js')) {
  throw '编译失败:没有生成 ai-ruler\.build\ai-ruler\run.js'
}
Set-Content -Path 'ai-ruler\.build\package.json' -Value '{"type":"commonjs"}' -Encoding ascii
Write-Host '完成。运行:node ai-ruler\.build\ai-ruler\run.js'
