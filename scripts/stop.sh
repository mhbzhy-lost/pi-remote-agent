#!/usr/bin/env bash
# 停止网关（优雅停机会回收 RPC 宿主进程）。
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
PID_FILE="$ROOT/var/gateway.pid"
if [[ ! -f "$PID_FILE" ]]; then echo "[stop] 未运行"; exit 0; fi
PID="$(cat "$PID_FILE")"
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$PID" 2>/dev/null && kill -9 "$PID" || true
  echo "[stop] stopped pid=$PID"
else
  echo "[stop] stale pid file"
fi
rm -f "$PID_FILE"
