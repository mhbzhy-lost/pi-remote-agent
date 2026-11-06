#!/bin/zsh
# 安装/卸载 launchd 开机自启（用户级 LaunchAgent）。
# 用法：
#   launchd-install.sh install    安装并启动（幂等）
#   launchd-install.sh uninstall  停止并移除
#   launchd-install.sh status     查看运行状态
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
PLIST="$HOME/Library/LaunchAgents/com.pi-remote-agent.gateway.plist"
LABEL="com.pi-remote-agent.gateway"
ACTION="${1:-}"

case "$ACTION" in
  install)
    # 若 nohup 手动实例在跑，先优雅停掉，交由 launchd 托管
    "$ROOT/scripts/stop.sh" >/dev/null 2>&1 || true
    # 端口被旧实例占用时兜底清理
    if command lsof >/dev/null 2>&1; then
      OLD_PIDS=$(lsof -ti tcp:8787 -sTCP:LISTEN 2>/dev/null || true)
      for pid in ${(f)OLD_PIDS}; do kill "$pid" 2>/dev/null || true; done
    fi
    mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/var"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${ROOT}/src/index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PI_REMOTE_AGENT_TOKEN</key>
    <string>$(cat "$ROOT/var/gateway-token")</string>
    <key>PI_REMOTE_AGENT_HOST</key>
    <string>0.0.0.0</string>
    <key>PI_REMOTE_AGENT_PORT</key>
    <string>8787</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${ROOT}/var/gateway.log</string>
  <key>StandardErrorPath</key>
  <string>${ROOT}/var/gateway.log</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST
    launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    launchctl enable "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
    sleep 2
    launchctl print "gui/$(id -u)/$LABEL" | grep -E 'state|pid' | head -4
    echo "[launchd] installed: $PLIST"
    ;;
  uninstall)
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "[launchd] uninstalled"
    ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E 'state|pid' | head -4 || echo "[launchd] not loaded"
    ;;
  *)
    echo "用法：$0 install|uninstall|status" >&2
    exit 2
    ;;
esac
