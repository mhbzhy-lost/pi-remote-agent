# pi-remote-agent

pi coding agent 的远程网关：接受外部远程交互调用（钉钉机器人或其他来源），把 OpenAI Responses API 形状的请求翻译为 pi 宿主进程（`--mode rpc`）的 JSONL 协议。

## 形态

```
调用方（钉钉机器人等）          网关（本工程）                pi 宿主（pi-config submodule 提供）
POST /v1/responses      ──►  HTTP/SSE + 事件映射  ──►  cli.js --mode rpc（JSONL stdin/stdout）
POST /v1/responses/compact
```

三个基本动作，全部对齐 OpenAI Responses 官方规范（零自造字段）：

| 动作 | 用法 |
|---|---|
| 新会话 + 流式对话 | `POST /v1/responses`：不带 `previous_response_id` = 新链；带 = 续聊 |
| compact | `POST /v1/responses/compact`：`previous_response_id` 路由，返回 `CompactResource` |

- 接口定义（实现视角）：[docs/api-design.md](docs/api-design.md)
- 接入文档（调用方视角，含与官方规范差异清单）：[docs/integration-guide.md](docs/integration-guide.md)

## 初始化

```bash
./init.sh
```

负责：Node 版本校验（≥22.19）、git submodule 同步（pi-config）、pi-config 依赖安装（npm ci + 扩展运行时依赖）、pi 私有运行时文件同步（auth/models/settings/trust，来自 submodule 源路径）、网关依赖安装、运行时目录创建。

## 启动

```bash
PI_REMOTE_AGENT_TOKEN=<token> npm start
```

可选环境变量：`PI_REMOTE_AGENT_PORT`（默认 8787）、`PI_REMOTE_AGENT_HOST`（默认 127.0.0.1）、`PI_REMOTE_AGENT_SESSION_WORKSPACES_DIR`（每会话独立工作区根目录，默认 `var/session-workspaces`；每个会话的 pi 宿主 cwd 为其下的 `<workspaceId>` 子目录，会话间文件互不可见）、`PI_REMOTE_AGENT_WORKSPACE_DIR`（兜底 cwd，默认本仓库根，正常不会用到）、`PI_REMOTE_AGENT_SESSION_DIR`（默认 `var/sessions`）、`PI_REMOTE_AGENT_IDLE_MS`（空闲宿主回收，默认 10 分钟）。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm run dev         # node --watch
```

## 部署（macOS）

部署形态：整机同步（含两侧 node_modules 与 pi 私有运行时文件）到目标机，远程不重新拼装；原生模块（fs-ext）与 Node ABI 绑定，需在目标机 Node 版本下重建一次。

```bash
# 首次部署（在本仓库根执行；用任意方式把代码同步到目标机，如 tar/rsync）
tar czf /tmp/pi-remote-agent-deploy.tar.gz --exclude ./.opencode --exclude ./.DS_Store --exclude ./var .
# 解包到目标机 ~/pi-remote-agent 后，在目标机上：
#   1. cd pi-config/packages/pi-subagents-enhanced && npm run setup:runtime   # 重建 fs-ext（目标机 Node ABI）
#   2. 写 var/gateway-token（鉴权 token）
#   3. scripts/launchd-install.sh install

# 日常运维（目标机上）
zsh ~/pi-remote-agent/scripts/launchd-install.sh status     # 状态
zsh ~/pi-remote-agent/scripts/launchd-install.sh uninstall  # 停止并移除自启
launchctl kickstart -k gui/$(id -u)/com.pi-remote-agent.gateway   # 强制重启
tail -f ~/pi-remote-agent/var/gateway.log
```

自启与自愈：launchd LaunchAgent（`~/Library/LaunchAgents/com.pi-remote-agent.gateway.plist`）开机自启、崩溃 10 秒内自动拉起（KeepAlive.Crashed）；`scripts/start.sh`/`stop.sh` 保留为 nohup 手动模式备用。

更新部署：改本地代码 → 重新 tar/上传解包 → `launchctl kickstart -k gui/$(id -u)/com.pi-remote-agent.gateway`（会话在 `var/sessions`，不受重启影响）。

## 技术栈

Node.js（≥22.19，.ts 直跑）+ TypeScript strict，零运行时依赖（HTTP 用 node:http，SSE 手写，子进程用 node:child_process）。

## 目录

```
src/
  index.ts            入口：加载映射 → HTTP 服务 → 空闲回收 → 优雅停机
  config.ts           环境变量配置
  http/server.ts      两个端点 + 鉴权 + ErrorResponse 形状
  rpc/host.ts         pi RPC 宿主进程封装（JSONL 命令/回执/事件）
  session/manager.ts  response.id→pi session 映射（落盘可恢复）+ 进程池（lazy 拉起/互斥/回收）
  events/mapper.ts    pi 事件 → Responses 官方 SSE 事件（含 sequence_number、完整事件链）
docs/
  api-design.md       网关实现计划（定稿）
  integration-guide.md 调用方接入文档（定稿）
pi-config/            pi agent 自定义环境（git submodule）
var/                  运行时数据（sessions / gateway 映射，gitignore）
```
