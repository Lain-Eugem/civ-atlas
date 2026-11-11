@echo off
chcp 936 >nul
setlocal
cd /d "%~dp0"
title 文明与地图 · 本地版
echo.
echo   ============================================
echo    文明与地图 (civ-atlas) 本地版
echo    浏览器会自动打开 http://127.0.0.1:5188
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
rem 5188 已被占用时：先分辨是本应用已经在跑，还是别的程序抢了端口
netstat -ano | findstr ":5188" | findstr "LISTENING" >nul
if not errorlevel 1 (
  powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'http://127.0.0.1:5188/api/health' -UseBasicParsing -TimeoutSec 3 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 (
    echo   [提示] 检测到 civ-atlas 已经在运行，直接打开浏览器。
    echo          要重启的话，先把之前那个窗口关掉，再运行本文件。
    echo.
    start "" http://127.0.0.1:5188
    powershell -NoProfile -Command "Start-Sleep -Milliseconds 2500" >nul 2>nul
    exit /b 0
  )
  echo   [错误] 端口 5188 被其他程序占用，本应用起不来。
  echo          先在任务管理器里结束占用它的程序，再运行本文件。查占用：
  echo            netstat -ano ^| findstr ":5188"
  echo.
  pause
  exit /b 1
)
echo   正在启动，第一次打开会多等几秒...
echo.
node "node_modules\vite\bin\vite.js" --open
if errorlevel 1 (
  echo.
  echo   [错误] 启动失败，请看上面的报错信息。
  echo.
  pause
  exit /b 1
)
echo.
echo   服务已停止。按任意键关闭窗口。
pause >nul
