#!/usr/bin/env bash
# Stronghold-Luck 启动脚本（macOS / Linux）。Windows 用同目录下的 start.cmd。
#
#   ./start.sh                     自动找游戏目录；找不到会在终端里问
#   ./start.sh --game <目录>       指定游戏目录
#   ./start.sh --host 0.0.0.0      让同一网络里的手机 / 别的电脑连进来
#
# 全部参数原样转给 src/launcher.mjs（位置见下）。
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 node。这份外挂要 Node.js 22 或更高：https://nodejs.org" >&2
  exit 1
fi

exec node src/launcher.mjs "$@"
