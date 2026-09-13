@echo off
chcp 65001 >nul
title 微信桥 · 管理台
rem ---------------------------------------------------------------------------
rem 独立管理台：自己的进程、自己的端口，不是 DSH 插件行。
rem 用任意 Node 22+ 直接跑 TS（Node 的类型擦除），无需构建步骤。
rem
rem 两个可覆盖项（默认不写死任何机器路径）：
rem   DSH_HOME  —— DSH 的 home；不设时 server.ts 自己回退到 %USERPROFILE%\.dsh
rem   NODE      —— node 可执行文件；不设时用 PATH 上的 node
rem 桌面版用户通常这样指定（把路径换成你自己的安装位置）：
rem   set "DSH_HOME=%APPDATA%\dsh-desktop\harness"
rem   set "NODE=<DSH Desktop 安装目录>\resources\app\node_modules\node\bin\node.exe"
rem ---------------------------------------------------------------------------

if not defined NODE set "NODE=node"
where "%NODE%" >nul 2>nul
if errorlevel 1 (
  echo [x] 找不到 node：%NODE%
  echo     请安装 Node 22+，或用 set "NODE=<node 的完整路径>" 指定后再运行本脚本。
  pause
  exit /b 1
)

if defined DSH_HOME (
  echo DSH_HOME = %DSH_HOME%
) else (
  echo DSH_HOME = 未设置，使用默认（%%USERPROFILE%%\.dsh）
  echo   桌面版用户请先： set "DSH_HOME=%%APPDATA%%\dsh-desktop\harness"
)

echo 启动管理台（Ctrl+C 停止）...
"%NODE%" "%~dp0server.ts" --profile web --port 8790 %*
pause
