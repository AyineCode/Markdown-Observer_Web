#!/usr/bin/env sh
# ─────────────────────────────────────────────────────────────
# Markdown Observer · 启动脚本（Linux / WSL / macOS 通用）
#
# 用法：
#   ./start.sh                 打开当前目录
#   ./start.sh ~/notes         打开指定目录
#   ./start.sh ~/notes --port 5000
#   ./start.sh --no-open       只起服务，不打开浏览器
#   ./start.sh --help
#
# 干的事：挑一个空闲端口 → 起本地服务 → 自动打开浏览器。
# WSL 下会用 Windows 侧的浏览器打开（wslview / explorer.exe / cmd.exe 依次尝试）。
# ─────────────────────────────────────────────────────────────
set -e

DIR=$(cd "$(dirname "$0")" && pwd)
PORT=""
ROOT=$(pwd)
OPEN=1

while [ $# -gt 0 ]; do
  case "$1" in
    --port|-p) PORT="$2"; shift 2 ;;
    --no-open) OPEN=0; shift ;;
    --help|-h) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "不认识的选项：$1（用 --help 看用法）" >&2; exit 2 ;;
    *) ROOT="$1"; shift ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "需要先安装 Node.js（https://nodejs.org），装完再运行本脚本。" >&2
  exit 1
fi

ROOT=$(cd "$ROOT" && pwd)
# 记录"当前跑着的那一个服务"（PID 端口 目录）：停止脚本与"别起第二个"都靠它
PID_FILE="$DIR/.markdown-observer.pid"

# 没指定端口就自己找一个空闲的（从 4321 往上试）
if [ -z "$PORT" ]; then
  PORT=$(node -e '
    const net = require("net")
    let port = Number(process.env.START_PORT || 4321)
    const probe = () => {
      const server = net.createServer()
      server.once("error", () => { port += 1; probe() })
      server.once("listening", () => server.close(() => console.log(port)))
      server.listen(port, "127.0.0.1")
    }
    probe()
  ')
fi
URL="http://127.0.0.1:$PORT/"

# 已经在跑？同一个目录就直接复用（避免越起越多），不同目录先停掉旧的
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cut -d' ' -f1 "$PID_FILE" 2>/dev/null || true)
  OLD_PORT=$(cut -d' ' -f2 "$PID_FILE" 2>/dev/null || true)
  OLD_ROOT=$(cut -d' ' -f3- "$PID_FILE" 2>/dev/null || true)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    if [ "$OLD_ROOT" = "$ROOT" ]; then
      echo "已经有一个服务在跑：PID $OLD_PID，目录 $OLD_ROOT"
      echo "地址：http://127.0.0.1:$OLD_PORT/"
      if [ "$OPEN" = "1" ]; then open_browser "http://127.0.0.1:$OLD_PORT/" || true; fi
      echo "（想停掉它：./stop.sh）"
      exit 0
    fi
    echo "先停掉旧的服务：PID $OLD_PID，目录 $OLD_ROOT"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$PID_FILE"
fi

# 打开浏览器：按 WSL → Linux → macOS 的顺序找可用的办法
open_browser() {
  target="$1"
  if [ -n "$WSL_DISTRO_NAME" ] || grep -qi microsoft /proc/version 2>/dev/null; then
    if command -v wslview >/dev/null 2>&1; then wslview "$target" >/dev/null 2>&1 && return 0; fi
    if command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$target" >/dev/null 2>&1 && return 0; fi
    if command -v cmd.exe >/dev/null 2>&1; then cmd.exe /c start "" "$target" >/dev/null 2>&1 && return 0; fi
  fi
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$target" >/dev/null 2>&1 && return 0; fi
  if command -v open >/dev/null 2>&1; then open "$target" >/dev/null 2>&1 && return 0; fi
  return 1
}

node "$DIR/serve.mjs" "$ROOT" --port "$PORT" &
SERVER_PID=$!
printf '%s %s %s\n' "$SERVER_PID" "$PORT" "$ROOT" > "$PID_FILE"
trap 'kill "$SERVER_PID" 2>/dev/null || true; rm -f "$PID_FILE"' EXIT INT TERM

# 等服务起来（最多约 3 秒）
i=0
while [ $i -lt 30 ]; do
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null "$URL" 2>/dev/null && break
  else
    sleep 0.3; break
  fi
  i=$((i + 1))
  sleep 0.1
done

echo "Markdown Observer：$URL"
echo "文档目录：$ROOT"
if [ "$OPEN" = "1" ]; then
  open_browser "$URL" || echo "（没能自动打开浏览器，请手动访问上面的地址）"
fi
echo "按 Ctrl-C 结束服务"
wait "$SERVER_PID"
