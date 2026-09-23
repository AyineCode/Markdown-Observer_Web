@echo off
chcp 65001 >nul
rem 停掉 Markdown Observer 的本地服务（按端口找进程；端口固定 47821）
setlocal enabledelayedexpansion
set "PORT=47821"
if not "%~1"=="" set "PORT=%~1"
set FOUND=
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT%" ^| findstr LISTENING') do (
  set FOUND=1
  echo 结束进程 PID %%P（端口 %PORT%）
  taskkill /PID %%P /F >nul 2>nul
)
if not defined FOUND echo 端口 %PORT% 上没有正在监听的服务。
endlocal
