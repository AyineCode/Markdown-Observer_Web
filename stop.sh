#!/usr/bin/env sh
# ─────────────────────────────────────────────────────────────
# 停掉由 start.sh 起的那个 Markdown Observer服务。用法： ./stop.sh
# ─────────────────────────────────────────────────────────────
DIR=$(cd "$(dirname "$0")" && pwd)
PID_FILE="$DIR/.markdown-observer.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "没有记录到正在运行的服务（.markdown-observer.pid 不存在）。"
  echo "若确实有一个在跑，用 ps aux | grep serve.mjs 找出来再 kill。"
  exit 0
fi

PID=$(cut -d' ' -f1 "$PID_FILE" 2>/dev/null || true)
PORT=$(cut -d' ' -f2 "$PID_FILE" 2>/dev/null || true)
ROOT=$(cut -d' ' -f3- "$PID_FILE" 2>/dev/null || true)

if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  echo "记录里的服务（PID ${PID:-未知}）已经不在运行了，清掉记录。"
  rm -f "$PID_FILE"
  exit 0
fi

kill "$PID" 2>/dev/null || true
i=0
while [ $i -lt 30 ]; do
  kill -0 "$PID" 2>/dev/null || break
  i=$((i + 1))
  sleep 0.1
done
if kill -0 "$PID" 2>/dev/null; then kill -9 "$PID" 2>/dev/null || true; fi
rm -f "$PID_FILE"
echo "已停止：PID $PID（端口 ${PORT:-?}，目录 ${ROOT:-?}）"
