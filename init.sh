#!/usr/bin/env bash
# pi-remote-agent 初始化：网关 + pi-config submodule 一次性就绪。
#
# 用法：./init.sh
# 可选环境变量：
#   NPM_REGISTRY  npm registry（默认 https://registry.npmjs.org）
#
# 职责：
#   1. 校验 node ≥ 22.19（pi 宿主与 .ts 直跑要求）
#   2. 拉起/更新 git submodule（pi-config，本地路径需要 file protocol 放行）
#   3. pi-config 内安装依赖（与 pi-config/init-pi.sh 同款：--ignore-scripts）
#   4. 网关根安装依赖（typescript、@types/node）
#   5. 创建运行时目录 var/sessions、var/gateway
#   6. 自检 pi cli、鉴权文件，输出启动指引
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org}"
PI_HOST_ROOT="$SCRIPT_DIR/pi-config/node_modules/@earendil-works/pi-coding-agent"

log() { printf '[init] %s\n' "$*"; }
fail() { printf '[init] 失败：%s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. Node 版本
command -v node >/dev/null 2>&1 || fail "缺少 node 命令"
node_version="$(node -p 'process.versions.node')"
IFS=. read -r node_major node_minor _node_patch <<<"$node_version"
if ((node_major < 22 || (node_major == 22 && node_minor < 19))); then
  fail "Node.js ≥ 22.19.0 required; found $node_version"
fi
log "Node 版本满足：$node_version"

# ---------------------------------------------------------------- 2. submodule
if [[ ! -f "$SCRIPT_DIR/.gitmodules" ]]; then
  fail "缺少 .gitmodules（应在仓库根执行本脚本）"
fi
log "同步 submodule pi-config …"
git -C "$SCRIPT_DIR" -c protocol.file.allow=always submodule update --init --recursive
[[ -f "$SCRIPT_DIR/pi-config/package.json" ]] || fail "submodule pi-config 未就位"

# ---------------------------------------------------------------- 3. pi-config 依赖
if [[ ! -f "$PI_HOST_ROOT/dist/cli.js" ]]; then
  log "安装 pi-config 依赖（npm ci --ignore-scripts，与 init-pi.sh 同款）…"
  (
    cd "$SCRIPT_DIR/pi-config"
    NPM_CONFIG_REGISTRY="$NPM_REGISTRY" npm_config_cache="$SCRIPT_DIR/pi-config/var/tmp/npm-cache" \
      npm ci --ignore-scripts --no-audit --no-fund
  )
fi
[[ -f "$PI_HOST_ROOT/dist/cli.js" ]] || fail "pi cli 缺失：$PI_HOST_ROOT/dist/cli.js"
log "pi cli 就绪：$PI_HOST_ROOT/dist/cli.js"

# ---------------------------------------------------------------- 4. pi 扩展运行时依赖
# 源仓库的扩展依赖树（pi-subagents-enhanced/node_modules、pi/npm）是 gitignore 的，
# 由官方脚本统一安装（与 pi-config 的 npm run setup:subagent-runtime 同款）。
if [[ ! -d "$SCRIPT_DIR/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents" ]]; then
  log "安装 pi 扩展运行时依赖（setup-subagent-runtime-deps）…"
  (
    cd "$SCRIPT_DIR/pi-config"
    NPM_CONFIG_REGISTRY="$NPM_REGISTRY" npm_config_cache="$SCRIPT_DIR/pi-config/var/tmp/npm-cache" \
      node scripts/setup-subagent-runtime-deps.ts
  )
  log "pi 扩展运行时依赖就绪"
else
  log "pi 扩展运行时依赖已存在，跳过"
fi

# ---------------------------------------------------------------- 5. 网关依赖
if [[ ! -d "$SCRIPT_DIR/node_modules/typescript" ]]; then
  log "安装网关依赖 …"
  (
    cd "$SCRIPT_DIR"
    NPM_CONFIG_REGISTRY="$NPM_REGISTRY" npm ci --ignore-scripts --no-audit --no-fund \
      || NPM_CONFIG_REGISTRY="$NPM_REGISTRY" npm install --ignore-scripts --no-audit --no-fund
  )
fi
log "网关依赖就绪"

# ---------------------------------------------------------------- 5. 运行时目录
mkdir -p "$SCRIPT_DIR/var/sessions" "$SCRIPT_DIR/var/gateway"
log "运行时目录就绪：var/sessions、var/gateway"

# ---------------------------------------------------------------- 6. 私有运行时文件
# submodule 只含已提交文件；凭据与本地模型配置（auth.json / models.json 等）是 gitignore
# 的私有小文件，不在仓库中。若 .gitmodules url 恰好是本机路径（开发机布局），自动同步；
# 否则提示使用者自行放置（或用 PI_REMOTE_AGENT_PI_DIR 指向已配置好的 pi agent 目录）。
sub_url="$(git -C "$SCRIPT_DIR" config --file "$SCRIPT_DIR/.gitmodules" --get submodule.pi-config.url || true)"
if [[ -n "$sub_url" && -d "$sub_url/pi" ]]; then
  log "从源仓库同步 pi 私有运行时文件：$sub_url/pi"
  for name in auth.json models.json settings.json trust.json models-store.json; do
    if [[ -f "$sub_url/pi/$name" ]]; then
      cp "$sub_url/pi/$name" "$SCRIPT_DIR/pi-config/pi/$name"
      log "  已同步 pi/$name"
    fi
  done
  if [[ -d "$sub_url/pi/node_modules" ]]; then
    rm -rf "$SCRIPT_DIR/pi-config/pi/node_modules"
    cp -R "$sub_url/pi/node_modules" "$SCRIPT_DIR/pi-config/pi/node_modules"
    log "  已同步 pi/node_modules"
  fi
else
  log "提示：.gitmodules url 非本机路径，私有文件需自行放置到 pi-config/pi/："
  log "  auth.json（模型凭据）、settings.json（默认模型等）、models.json / models-store.json、trust.json"
  log "  （或将 PI_REMOTE_AGENT_PI_DIR 指向一份已配置好的 pi agent 目录）"
fi
[[ -f "$SCRIPT_DIR/pi-config/pi/settings.json" ]] \
  && log "settings.json 就绪" \
  || log "警告：pi-config/pi/settings.json 缺失，pi 将用默认设置"

# ---------------------------------------------------------------- 7. 自检与指引
[[ -f "$SCRIPT_DIR/pi-config/pi/auth.json" ]] \
  && log "模型凭据就绪：pi-config/pi/auth.json" \
  || log "警告：pi-config/pi/auth.json 不存在，pi 宿主可能无法调用模型"
if [[ -z "${PI_REMOTE_AGENT_TOKEN:-}" ]]; then
  log "提示：启动前需设置 PI_REMOTE_AGENT_TOKEN（网关鉴权 token）"
fi

log "初始化完成。启动方式："
cat <<'EOF'
  PI_REMOTE_AGENT_TOKEN=<token> npm start
  # 可选：PI_REMOTE_AGENT_PORT（默认 8787）、PI_REMOTE_AGENT_HOST（默认 127.0.0.1）
  # 端点：POST /v1/responses、POST /v1/responses/compact（见 docs/integration-guide.md）
  # 类型检查：npm run typecheck
EOF
