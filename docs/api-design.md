# pi-remote-agent 网关交互定义（定稿）

网关是 pi coding agent（`--mode rpc`，JSONL 行协议）的 HTTP/SSE 门面，供钉钉机器人等远程来源调用。
所有智能能力由 pi 宿主进程提供，网关只做会话路由与协议翻译，不引入自己的 agent 逻辑。

接口面收敛为 **两个端点，全部 OpenAI Responses 规范本体，零自造字段**：

| 动作 | 规范出处 | 官方语义 |
|---|---|---|
| 新会话 + 自然语言输入 → SSE 流式输出 | `POST /v1/responses` | 不带 `previous_response_id` 即发起新链（官方 chain 第一拍） |
| 后续对话 | `POST /v1/responses` | 带 `previous_response_id`（上一轮 `response.id`）链式续聊 |
| compact | `POST /v1/responses/compact` | 带 `previous_response_id` 路由，返回 `CompactResource` |

不引入 Conversations API，不自定义 `POST /v1/sessions`——「创建新会话」就是一次不带 `previous_response_id` 的 `/v1/responses` 调用，由客户端建链（与 Codex 客户端同款用法）。

## 背景事实（来自 pi-coding-agent 1.5.0 RPC 协议）

RPC 模式下，宿主进程 stdin 接收 JSON 行命令、stdout 流式输出 JSON 行事件：

| 网关动作 | pi RPC 命令 | 说明 |
|---|---|---|
| 自然语言输入→流式输出 | `{"type":"prompt","message":...}` | stdout 持续流出 `agent_start` / `message_start` / `message_update` / `tool_execution_*` / `message_end` / `agent_settled` 等事件 |
| compact | `{"type":"compact","customInstructions"?}` | 同步回执 `CompactionResult` |
| 会话恢复 | 拉起 RPC 进程加 `--session <path|id>` | 会话落盘在 session dir，上下文不丢 |

关键事实（已核实源码）：

- **pi 的 compact 是就地替换，不换 session**：`AgentSession.compact()` 调 `sessionManager.appendCompaction(...)` 往**同一 session 文件**追加 compaction 条目并刷新内存态，无 newSession/fork/文件切换。因此链式 id 在 compact 前后稳定，网关零映射补偿。
- 流式事件中，`message_update` 携带增量 assistant 内容（文本 delta、toolcall_start/end），`message_end` 是权威完整消息，`agent_settled` 表示本轮收敛。
- pi 有 `session_before_compact` 扩展钩子（可在压缩前介入/取消），后续定制入口。

## 官方规范要点（OpenAPI 2.3.0 + developers.openai.com，2026-11 调研）

**`POST /v1/responses`（CreateResponse）**：
- `model`：必填（官方语义；网关接受但忽略，模型服务端固定）。
- `input`：string 或 input item 数组（`InputParam`）。我们仅实现 string 子集。
- `stream`：官方默认 `false`；我们仅实现 `stream: true`，调用方必须显式传。
- `previous_response_id`：可选（`anyOf: [string, null]`）。不带 = 新链（官方 chain 第一拍）；带 = 续上一轮。官方 `store: true` 时响应保存 30 天可引用；我们等价于永久（pi session 落盘，无 TTL）——行为差异，非协议差异。

**SSE wire 格式**（严格按官方）：
- 每个事件两行：`event: <type>` + `data: {...}`；每个事件必带 `sequence_number`。
- `response.created` / `response.in_progress` / `response.completed` / `response.failed` 的 `data` 携带完整 Response 对象（id、object、status、model、output、usage、metadata 等）。
- 文本流：`response.output_item.added`（item 生命周期开始）→ `response.content_part.added` → `response.output_text.delta`（必带 `item_id`/`output_index`/`content_index`）→ `response.output_text.done` → `response.content_part.done` → `response.output_item.done`（权威全文）。
- 工具调用：`item.type: "function_call"`，走 `response.output_item.added` / `response.output_item.done` + `response.function_call_arguments.delta` / `.done`。
- `response.completed` 为本轮收敛（含 usage 汇总）。

**`POST /v1/responses/compact`（standalone endpoint）**：
- 请求体 `CompactResponseMethodPublicBody`：`model` 必填（网关接受但忽略）；`previous_response_id`、`instructions`、`input` 可选。官方无 `conversation` 字段（已核实）。
- 返回 `CompactResource`（五字段必填）：`id`、`object: "response.compaction"`、`output`（新规范上下文窗口：保留的旧 item + `type: "compaction"` item 带 `encrypted_content`）、`created_at`、`usage`。
- 官方语义为无状态（input 全量进、新窗口出）；我们网关为有会话状态（`previous_response_id` 路由到 pi 落盘会话，服务端藏住完整窗口）。对调用方而言 compact 是幂等上下文替换：链式续聊不受影响，无需解析/存储/回传 `output`。

## API 定义（定稿）

基础约定：
- 路由：网关维护 `response.id → pi session` 映射；每轮 prompt 的 response 登记映射。`previous_response_id`（无论出现在 `/responses` 还是 `/responses/compact`）据此解析到对应 pi 宿主进程。
- RPC 进程按 session lazy 拉起（`--session-id` 绑定）；进程退出后可按 id 重开，上下文不丢；网关自身可无状态重启（映射随 response 持久恢复）。
- 鉴权：`Authorization: Bearer <token>`（`PI_REMOTE_AGENT_TOKEN`，未配置则拒绝所有请求）。
- 错误响应体：官方 `ErrorResponse` 形状 `{"error": {"message", "type", ...}}`。

### 1. 自然语言输入 → SSE 流式输出（含新会话语义）

```
POST /v1/responses
Content-Type: application/json
Accept: text/event-stream
{
  "model": "<任意，接受但忽略>",       // 必填（官方语义）
  "input": "自然语言或指令",           // string（Responses 子集；数组形态后续再议）
  "stream": true,                     // 必须显式传（官方默认 false）
  "previous_response_id": "resp_..."   // 可选：缺省/null = 新链；传 = 续上一轮
}
```

事件映射（pi 事件 → Responses 官方事件）：

| pi RPC 事件 | SSE 事件 |
|---|---|
| 收到请求 | `response.created` + `response.in_progress`（完整 Response 对象） |
| `message_update`（文本 delta） | `response.output_item.added` → `response.content_part.added` → `response.output_text.delta`（带 item_id/output_index/content_index） |
| `message_update`（toolcall） | `response.output_item.added`（`function_call`）+ `response.function_call_arguments.delta`/`.done` |
| `tool_execution_start/end` | 扩展事件 `pi.tool_execution`（带 status/summary；官方无对应细粒度事件，标注为网关扩展） |
| `message_end` | `response.output_text.done` → `response.content_part.done` → `response.output_item.done` |
| `agent_settled` | `response.completed`（完整 Response 对象 + usage） |
| 出错 | `response.failed`（完整 Response 对象 + error） |

流内错误后 wire 状态码固化为 200，真实结局以流内事件为准（官方流式语义）。

### 2. compact

```
POST /v1/responses/compact
{
  "model": "<任意，接受但忽略>",          // 必填（官方语义）
  "previous_response_id": "resp_...",     // 路由依据：链上最近一轮 response id
  "instructions": "..."                   // 可选，映射 pi customInstructions
}
→ 200 CompactResource
{
  "id": "cmp_...", "object": "response.compaction", "created_at": ...,
  "output": [ ...保留条目 + {"type":"compaction","id":"...","encrypted_content":"..."} ],
  "usage": { ... }
}
```

实现：`previous_response_id` 解析到 pi session → RPC `{"type":"compact","customInstructions"?}` → 等待回执 → `CompactionResult` 包装成 `CompactResource`（`encrypted_content` 放 pi 压缩摘要文本，对调用方不透明；usage 取自 CompactionResult）。该链正在流式输出中则返回 409。compact 后链式 id 不变（pi 就地替换已核实），调用方继续以原 `previous_response_id` 链式续聊。

工程细节（参考 sub2api）：compact 是长操作，unary 等待期间向客户端发 SSE 注释行心跳，防反向代理掐断长连接。

### 网关自有约束（非官方规范，文档显式标注）

- `input` 仅支持 string 子集。
- `stream` 仅支持 `true`。
- 一链一并发：同一链进行中再请求返回 409（官方无此约束）。
- SSE 注释行心跳（`: keepalive`）为网关工程行为，非官方事件。

## 进程与恢复模型

- 每个 pi session 懒加载一个 RPC 子进程，空闲超时回收；收到新请求时若进程不存在则用 `--session <id>` 重开（pi 会话已落盘，上下文不丢）。
- compact 不换 session（已核实 pi 行为），无映射补偿。
- 网关崩溃不影响会话持久性；`response.id → session` 映射需可重建（pi session 内含完整条目，重放可恢复）。
- 钉钉机器人等具体来源的适配是后续独立模块（webhook 层），不在本定义范围内。

## 技术选型（初定）

- Node.js + TypeScript（与 pi-config 同栈）。
- HTTP 服务用 Node 内置（或 hono，实现计划里定）。
- 子模块 `pi-config` 提供环境与扩展；网关运行时通过 `pi-config/node_modules/@earendil-works/pi-coding-agent` 启动宿主。
