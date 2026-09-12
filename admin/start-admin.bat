@echo off
chcp 65001 >nul
title 微信桥 · 管理台
rem ---------------------------------------------------------------------------
rem 独立管理台：自己的进程、自己的端口，不是 DSH 插件行。
rem 用桌面应用自带的 node（v24）直接跑 TS（Node 的类型擦除），无需构建步骤。
rem ---------------------------------------------------------------------------
set "DSH_HOME=%APPDATA%\dsh-desktop\harness"
set "NODE=D:\Program Files (x86)\DSH Desktop\resources\app\node_modules\node\bin\node.exe"
if not exist "%NODE%" (
  echo [x] 找不到桌面应用的 node：%NODE%
  echo     请编辑本文件里的 NODE 变量指向任意 node 22+ 。
  pause
  exit /b 1
)
echo 启动管理台（Ctrl+C 停止）...
"%NODE%" "%~dp0server.ts" --profile web --port 8790 %*
pause
