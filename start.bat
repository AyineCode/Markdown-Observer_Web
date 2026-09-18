@echo off
chcp 65001 >nul
rem ─────────────────────────────────────────────────────────────
rem  Markdown 阅读器 · Windows 启动脚本
rem  双击即可：起本地服务 + 打开浏览器。
rem  想指定文档目录：把文件夹拖到本文件上，或在命令行里 start.bat D:\notes
rem ─────────────────────────────────────────────────────────────
setlocal
set "DIR=%~dp0"
set "PORT=4321"
set "ROOT=%~1"
if "%ROOT%"=="" set "ROOT=%USERPROFILE%\Documents"
if not exist "%ROOT%" set "ROOT=%USERPROFILE%"

where node >nul 2>nul
if errorlevel 1 (
  echo 需要先安装 Node.js: https://nodejs.org
  echo 装完之后再双击本文件。
  pause
  exit /b 1
)

start "Markdown 阅读器（关掉这个窗口即停止服务）" /min node "%DIR%serve.mjs" "%ROOT%" --port %PORT%
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:%PORT%/
endlocal
