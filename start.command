#!/bin/sh
# macOS：双击本文件即可启动（.command 会被"终端"执行）。
# 想指定文档目录，就在终端里用： ./start.sh ~/notes
cd "$HOME" || exit 1
exec "$(dirname "$0")/start.sh" "$@"
