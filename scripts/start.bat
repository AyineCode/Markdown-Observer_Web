@echo off
chcp 65001 >nul
rem ─────────────────────────────────────────────────────────────
rem  Markdown Observer · Windows 启动脚本
rem  双击即可：起本地服务 + 打开浏览器。
rem  想指定文档目录：把文件夹拖到本文件上，或在命令行里 start.bat D:\notes
rem ─────────────────────────────────────────────────────────────
setlocal
set "APP_DIR=%~dp0.."
rem 端口固定 47821：设置、背景图、阅读位置都按"地址含端口"存，换端口等于把它们弄丢
set "PORT=47821"
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

start "Markdown Observer（关掉这个窗口即停止服务）" /min node "%APP_DIR%\serve.mjs" "%ROOT%" --port %PORT%
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:%PORT%/
endlocal
