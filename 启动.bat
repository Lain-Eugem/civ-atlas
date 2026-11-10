@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title 文明与地图 · 本地版
echo.
echo   ============================================
echo    文明与地图 (civ-atlas) 本地版
echo    浏览器会自动打开 http://localhost:5188
echo    关闭这个窗口就会停止服务
echo   ============================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo   [错误] 没找到 Node.js。请先安装 Node 22 或更高版本：
  echo          https://nodejs.org/
  echo.
  pause
  exit /b 1
)
if not exist "node_modules\vite\bin\vite.js" (
  echo   [提示] 还没装依赖，正在安装（需要联网，可能要几分钟）...
  call pnpm install --config.node-linker=hoisted --config.manage-package-manager-versions=false
  if errorlevel 1 (
    echo   [错误] 依赖安装失败。请检查网络，或在本目录手动运行：
    echo          pnpm install --config.node-linker=hoisted --config.manage-package-manager-versions=false
    echo.
    pause
    exit /b 1
  )
)
echo   正在启动，第一次打开会多等几秒...
echo.
node "node_modules\vite\bin\vite.js" --open
echo.
echo   服务已停止。按任意键关闭窗口。
pause >nul