# pi-remote-agent 工程须知

本目录是 pi 远程 agent 网关：pi-config（submodule，agent 环境）+ HTTP 网关（OpenAI Responses 规范子集）。任何 agent 在此工作前先读本文件。

## 架构一句话

网关无 agent 逻辑，只做会话路由（`response.id → pi session` 映射，落盘 `var/gateway/map.json`）与协议翻译（pi RPC JSONL ↔ 官方 SSE）。所有智能能力由 pi 宿主子进程提供（`--mode rpc`）。

## 目录

- `pi-config/` submodule（分支 main，远程 https://github.com/mhbzhy-lost/pi-config.git）。其 `pi/` 下 `auth.json`/`settings.json`/`models.json`/`trust.json`/`models-store.json` 为**私有运行时文件，submodule 内 gitignored**——每台部署机单独维护，改默认模型等要逐机改，不进 git
- `var/sessions/` pi 会话落盘（上下文权威，跨重启不丢）
- `var/session-workspaces/<ws_*>` **每会话独立工作区**（宿主 cwd），agent 文件/终端操作隔离于此，随映射落盘保持稳定
- `var/workspaces/` pi-subagents 扩展状态根（`PI_CODING_WORKSPACE_DIR`），非 agent cwd
- `var/gateway/` 网关映射；`var/gateway-token` 鉴权 token（gitignored，不提交不外传）

## 已踩运维坑（必读）

1. **launchd 重启别用 kill**：SIGTERM 优雅退出 exit 0，不触发 `KeepAlive.Crashed`，launchd 不会拉起。正确姿势 `launchctl kickstart -k gui/$(id -u)/com.pi-remote-agent.gateway`
2. **原生模块跨机不能搬 node_modules**：fs-ext 等原生模块按 Node ABI 编译，换机器（Node 版本不同）必须重跑 `cd pi-config/packages/pi-subagents-enhanced && npm run setup:runtime`
3. **package-lock 的 resolved 曾指向企业内部源**：本仓库发布到公网，任何 `npm install` 前设 `NPM_CONFIG_REGISTRY=https://registry.npmjs.org`，装完抽查 lock 的 resolved 无内部源残留
4. **submodule 走 https 免鉴权拉取**：远程机 checkout 用 `git submodule update --init`（url 已是 https 公开仓）；本地曾用本地路径 submodule（`protocol.file.allow=always`），公开化后已改 https
5. **tar 整机部署的 .git 是空壳**：此前远程机用 tar 搬运导致无 commit 历史，pull 报 "branch does not have any commits"。已规整为 `git remote add origin <https> + checkout -f -B main origin/main`。**部署统一走 push & pull，不再 rsync/tar**
6. **`PI_CODING_WORKSPACE_DIR` 必须是已存在的规范化绝对路径**（扩展校验 isAbsolute），网关已 `ensureSessionDir` 兜底创建；同理每会话工作区目录由网关先 `mkdir` 再 spawn 宿主
7. **pi trust 按祖先目录匹配**：会话工作区子目录天然继承 `<home>` 的信任条目，无需逐目录加 trust.json
8. **非交互 SSH 的 PATH 无 node**：远程机上网关由 launchd 启动无碍，但手工跑命令要用绝对路径（如 `/opt/homebrew/bin/node`）
9. **compact 小会话报 "Nothing to compact (session too small)"**：pi 阈值约 keepRecentTokens 20000，属正常 400，网关透传，冒烟时别拿小会话测 compact
10. **CC Safety Net 拦截 `git checkout --` / `git restore`**：丢弃未提交改动用 `git stash` 代替

## Git 规范（本仓库）

- git 工具优先用 `git1`（薄包装：设 `GIT_SSH_COMMAND=ssh1-launcher` 强制 SSH 走 ssh1-launcher，远程 URL 不变），不可用时回退 `git`。本环境 plain `git` 的 SSH 推送报「无法读取远程仓库」，须用 `git1`
- commit：`type(scope): 中文祈使句`，无 AI 署名；author 用 mhbzhy-lost（GitHub noreply），**不要**用企业身份（全局 gitsync 钩子已通过仓库级 `core.hooksPath` 置空屏蔽）
- 提交前敏感复扫：对将提交内容 grep 常见内部环境标识（内部 registry 域名、内网 IP 段、工位机主机名、企业邮箱后缀、员工花名）零命中

## 验证基线

改动后最低验证：`npx tsc --noEmit`；端到端冒烟：起本地网关（`PI_REMOTE_AGENT_TOKEN=t node src/index.ts`）→ 新会话 `pwd` 验 cwd 落 `var/session-workspaces/ws_*` → 续聊验同一 ws → 检查模型。部署到远程机后同样远程打一轮。

## 修改默认模型

`pi-config/pi/settings.json` 的 `defaultProvider`/`defaultModel`，逐部署机改（gitignored 不随仓库走）。当前：`qoder-pool/Qwen3.8-Max`。
