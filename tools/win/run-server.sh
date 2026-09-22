#!/usr/bin/env bash
# run-server.sh —— 【本机开发用】Windows 启动器在 WSL 这边调用的入口。
#
# 它只做一件事：找到 node，然后把参数原样交给 serve.mjs。
#
# 为什么不直接在启动器里写 node 的绝对路径：
#   ① wsl.exe -e 起的是"非登录 shell"，nvm 装出来的 node 不在 PATH 里；
#   ② nvm 的路径带版本号（.../v24.21.0/bin/node），升级一次 node 就失效了。
# 在这里每次现找，两个问题一起解决。
#
# 注意：这个脚本只服务于"阅读器源码放在 WSL 里"的这台机器。
# 要发给别人的那份不带它——别人的电脑上没有 WSL，用的是打包好的 node。
set -eu

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  # nvm 的 node 不在非登录 shell 的 PATH 里：从已有的版本里挑最新的一个
  NEWEST="$(ls -1d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "${NEWEST}" ]; then PATH="${NEWEST}:$PATH"; fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node not found in WSL. Install it (https://nodejs.org or nvm) and try again." >&2
  exit 127
fi

exec node "$APP_DIR/serve.mjs" "$@"
