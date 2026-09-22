#!/usr/bin/env bash
# stop-servers.sh —— 兜底：把正在跑的 Markdown Observer 服务全停掉。
#
# 正常情况轮不到它：`node tools/win/status.mjs --stop` 会走 /api/quit（干净、跨平台）。
# 但如果服务是旧版本（还没有 /api/quit）、或者卡住了，就用这个：
# 它靠 pkill 干活，而 pkill 只能看见"和自己同一个 PID 命名空间"的进程——
# 所以必须通过 wsl.exe 起（那样跑在 WSL 真正的命名空间里），别在沙箱/容器里跑。
#
# 跑法：
#   wsl.exe -d Ubuntu -u <你的用户名> -e /bin/bash <这个脚本的路径>
pkill -f 'serve[.]mjs' && echo "已发出停止信号。" || echo "没有正在跑的服务。"
