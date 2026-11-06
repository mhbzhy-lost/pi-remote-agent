#!/usr/bin/env bash
# 部署启动脚本：nohup 拉起网关，pid 落盘（launchd 模式见 launchd-install.sh）。
# 环境变量优先：PI_REMOTE_AGENT_TOKEN（缺省读 var/gateway-token）
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
TOKEN="${PI_REMOTE_AGENT_TOKEN:-$(cat "$ROOT/var/gateway-token" 2>/dev/null || true)}"
[[ -n "$TOKEN" ]] || { echo "[start] 缺少 token：设置 PI_REMOTE_AGENT_TOKEN 或写 var/gateway-token" >&2; exit 1; }

PID_FILE="$ROOT/var/gateway.pid"
LOG_FILE="$ROOT/var/gateway.log"
mkdir -p "$ROOT/var"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "[start] 已在运行 pid=$(cat "$PID_FILE")"
  exit 0
fi

cd "$ROOT"
PI_REMOTE_AGENT_TOKEN="$TOKEN" \
PI_REMOTE_AGENT_HOST=0.0.0.0 \
PI_REMOTE_AGENT_PORT="${PI_REMOTE_AGENT_PORT:-8787}" \
  nohup "$NODE_BIN" src/index.ts >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
echo "[start] gateway pid=$(cat "$PID_FILE") port=${PI_REMOTE_AGENT_PORT:-8787}"
