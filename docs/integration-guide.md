# pi-remote-agent 接入文档（调用方）

本文面向网关的调用方（钉钉机器人、脚本、其他自动化来源），描述如何通过 HTTP/SSE 与远程 pi agent 交互。

交互模型一句话：**按 OpenAI Responses API 的链式语义使用——每次请求携带上一轮的 `response.id`（作为 `previous_response_id`）即可续聊；不带则开启新会话。** 会话历史由服务端持久化，调用方无需携带历史消息。

---

## 基础信息

- **Base URL**：`http://<host>:<port>/v1`（下文以 `http://localhost:8787/v1` 示例）
- **鉴权**：所有请求必须携带

  ```
  Authorization: Bearer <PI_REMOTE_AGENT_TOKEN>
  ```

  token 由服务端部署时配置，未配置则服务拒绝所有请求。

- **协议**：OpenAI Responses API（官方规范子集，兼容 OpenAI SDK 的事件解析）。仅两个端点：`POST /v1/responses`、`POST /v1/responses/compact`。

## 与官方规范的差异清单

实现的是官方规范的子集 + 少量网关自有约束。差异按性质分三类：**能力收窄**（官方能做我们不做）、**语义偏移**（字段同名但行为不同，最需要留意）、**网关新增**（官方没有的行为）。

### 能力收窄（子集）

| 项 | 官方 | 本网关 |
|---|---|---|
| `input` 类型 | string 或 item 数组 | **仅 string**。不支持用 input 数组预置历史「播种」会话（机器人迁移等场景需从新会话开始） |
| `stream` | 默认 `false` | **必须显式传 `true`**，不支持非流式 |
| `model` | 必填，决定所用模型 | 必填（形状一致），**值被忽略**——模型由服务端固定 |
| `instructions` / `tools` 等参数 | 可选，请求级覆盖 | **不支持**——system prompt 与工具集由服务端环境固化 |

### 语义偏移（字段同名、行为不同，重点阅读）

| 项 | 官方 | 本网关 |
|---|---|---|
| `previous_response_id` 的含义 | 每个响应是对话树节点，引用**任意**历史响应 id 可**分叉（fork）**回该时点状态 | 是**会话指针**，不是状态快照：同一条链的所有响应 id 都指向该会话的**当前状态**，引用老 id 不会时光倒流，**无 fork 语义**（线性会话场景无感） |
| compact 生效方式 | 无状态纯函数：全量 input 进、新窗口出，靠客户端回放新窗口生效，原会话不动 | **服务端原地替换、即生效、不可撤销**；返回的 `output` 只是收据，无需解析/存储/回传 |
| 响应保存 | 默认 30 天 TTL，过期 id 不可引用 | **永久**（服务端 pi 会话落盘，无 TTL）。若有数据留存合规要求，需调用方自行做逻辑删除（暂无删除端点） |

### 网关新增（官方没有）

| 项 | 说明 |
|---|---|
| 并发约束 | **一会话同时只接受一个进行中请求**，再请求返回 409 |
| SSE 心跳 | 空闲期发送注释行 `: keepalive`（非官方事件，SDK 自动忽略） |
| `pi.tool_execution` 事件 | 工具执行进度扩展事件（status/summary），可忽略 |
| 404 语义略宽 | 除「id 不存在」外，服务端内部映射异常恢复失败时也可能 404（目标态下接近于零） |
| 每会话独立工作区 | agent 的文件操作（读写/终端）发生在该会话专属的沙盒目录中，**会话之间文件互不可见**；同一会话跨请求、跨压缩、跨服务重启始终使用同一目录。需要跨会话共享文件时由调用方在会话内自行中转（如作为 `input` 文本粘贴） |

---

## 1. 发起对话（新会话 / 续聊共用一个端点）

```
POST /v1/responses
Content-Type: application/json
Accept: text/event-stream
```

请求体：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | ✅ | 任意字符串，服务端忽略（如传 `"pi-agent"`） |
| `input` | string | ✅ | 用户自然语言输入；本轮会归档进会话，下轮无需重复历史 |
| `stream` | boolean | ✅ | 必须为 `true` |
| `previous_response_id` | string | — | **缺省或 null = 开启新会话**；传上一轮 `response.id` = 续聊 |

**新会话**（第一次调用，不带 previous_response_id）：

```bash
curl -N http://localhost:8787/v1/responses \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pi-agent",
    "input": "帮我看下这个仓库的测试怎么跑",
    "stream": true
  }'
```

**续聊**（后续每轮，带上上一轮 response id）：

```bash
curl -N http://localhost:8787/v1/responses \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pi-agent",
    "input": "那测试失败的原因是什么",
    "stream": true,
    "previous_response_id": "resp_0192a7f3c1d2e3f4a5b6c7d8"
  }'
```

> 调用方只需持久化一个值：**最近一次的 `response.id`**（在 `response.created` 及所有事件的 `response.id` 中均可拿到）。它就是会话句柄，等价于「会话里最新的一条消息」。

### SSE 流格式（官方 wire 格式）

每个事件两行：`event: <类型>` + `data: <JSON>`；每个事件携带 `sequence_number`。一轮典型流：

```
event: response.created
data: {"type":"response.created","response":{"id":"resp_...","object":"response","status":"in_progress","model":"pi-agent","output":[],...},"sequence_number":0}

event: response.in_progress
data: {"type":"response.in_progress","response":{...},"sequence_number":1}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_...","type":"message","status":"in_progress","role":"assistant","content":[]},"sequence_number":2}

event: response.content_part.added
data: {"type":"response.content_part.added","item_id":"msg_...","output_index":0,"content_index":0,"part":{"type":"output_text","text":""},"sequence_number":3}

event: response.output_text.delta
data: {"type":"response.output_text.delta","item_id":"msg_...","output_index":0,"content_index":0,"delta":"我先看一下目录结构…","sequence_number":4}

: keepalive

event: pi.tool_execution
data: {"type":"pi.tool_execution","tool":"bash","status":"start","summary":"ls -la","sequence_number":5}

event: response.output_text.done
data: {"type":"response.output_text.done","item_id":"msg_...","output_index":0,"content_index":0,"text":"…该消息完整文本…","sequence_number":8}

event: response.content_part.done
data: {"type":"response.content_part.done","item_id":"msg_...","output_index":0,"content_index":0,"part":{"type":"output_text","text":"…完整文本…"},"sequence_number":9}

event: response.output_item.done
data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_...","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":"…"}]},"sequence_number":10}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_...","status":"completed","output":[...],"usage":{"input_tokens":1200,"output_tokens":300,"total_tokens":1500},...},"sequence_number":11}
```

### 事件说明

| 事件 | 含义 | 调用方建议处理 |
|---|---|---|
| `response.created` / `response.in_progress` | 服务端已受理，data 含完整 Response 对象 | **记录 `response.id`**（会话句柄） |
| `response.output_item.added` | 一条新输出项开始（消息或 function_call 工具调用） | 工具项可展示「正在执行 xxx」 |
| `response.content_part.added` | 消息内容块开始 | 一般可忽略 |
| `response.output_text.delta` | 增量文本（`delta` 字段） | 累加渲染（钉钉场景可攒批发送或打字机效果） |
| `pi.tool_execution` | 工具执行进度（`status: start/end`，带 `summary`） | 网关扩展事件，可忽略；展示则更直观 |
| `response.output_text.done` | 该内容块全文定稿 | 用它覆盖此前累加的 delta |
| `response.content_part.done` / `response.output_item.done` | 内容块 / 输出项完成 | `output_item.done` 含权威全文 |
| `response.completed` | 本轮收敛，data 含完整 Response 对象 + usage | 结束本轮，**更新会话句柄为该 `response.id`**，落 usage |
| `response.failed` | 出错，data 含完整 Response 对象 + error | 结束本轮，报错；句柄仍用上一轮的 |

注意：
- 流可能持续较久（agent 执行工具、多轮推理），客户端需容忍长时间连接，勿设过短 idle 超时；空闲期间有 `: keepalive` 注释行心跳。
- 流开始后（HTTP 200 已返回）发生的错误不再用状态码表达，走流内 `response.failed`，真实结局以流内事件为准。

### HTTP 错误（响应开始前）

错误响应体为官方 `ErrorResponse` 形状：

```json
{ "error": { "message": "conversation not found", "type": "invalid_request_error" } }
```

| HTTP 状态 | 场景 |
|---|---|
| `400` | 请求体不合法（缺 `model`/`input`，或 `stream` 未显式传 `true`） |
| `401` | token 缺失/错误 |
| `404` | `previous_response_id` 不存在或已失效 |
| `409` | 该会话已有进行中的请求 |

## 2. 压缩会话（compact）

长会话上下文膨胀时，调用 compact 让服务端把会话历史压缩替换为摘要。**压缩后会话句柄不变**——继续用原来的 `previous_response_id` 链式续聊即可，无需任何额外操作。

```
POST /v1/responses/compact
Content-Type: application/json
```

请求体：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | ✅ | 任意字符串，服务端忽略 |
| `previous_response_id` | string | ✅ | 会话句柄（链上最近一轮 response id） |
| `instructions` | string | — | 压缩摘要自定义指令（如「重点保留任务状态」），缺省用服务端默认策略 |

示例：

```bash
curl http://localhost:8787/v1/responses/compact \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pi-agent",
    "previous_response_id": "resp_0192a7f3c1d2e3f4a5b6c7d8"
  }'
```

响应 `200`（官方 `CompactResource`）：

```json
{
  "id": "cmp_0192a7f4...",
  "object": "response.compaction",
  "created_at": 1764968100,
  "output": [
    { "type": "message", "role": "user", "content": [ { "type": "input_text", "text": "..." } ] },
    { "type": "compaction", "id": "cmp_...", "encrypted_content": "gAAAAAB..." }
  ],
  "usage": { "input_tokens": 42897, "output_tokens": 12000, "total_tokens": 54897 }
}
```

说明：
- `output` 是压缩后的上下文窗口，对调用方**不透明**：无需解析、无需存储、无需回传，服务端已原地生效。仅当调用方想自建离线归档时才保存。
- `encrypted_content` 为服务端生成的不透明内容，不要解读或修改。
- 压缩是长操作（可能数十秒），客户端超时建议 ≥120s。
- 会话正在流式输出中时压缩返回 `409`。
- 调用时机建议：定时（如每日）或按会话轮次（如每 50 轮）触发即可；也可不做，后续服务端会提供自动压缩策略。

## 典型接入时序（钉钉机器人示例）

```
用户在群里 @机器人 发消息
  → 机器人查本地映射：群 id → 最近 response id
     （首次没有：直接发 POST /v1/responses，不带 previous_response_id）
  → POST /v1/responses { model, input, stream: true, previous_response_id? }
  → 边收 SSE 边把 delta 攒批发到群里（或等 response.completed 一次发全文）
  → response.completed 后：把 response.id 存回「群 id → 最近 response id」映射

每日定时任务
  → 对活跃会话逐个 POST /v1/responses/compact（用各自最近 response id）
  → compact 不改变会话句柄，映射无需更新
```

## 约定与限制（当前版本）

- 会话句柄 = 最近一次 `response.id`；新会话 = 不带 `previous_response_id` 发起调用。
- 一会话一并发，进行中再请求得 `409`。
- `input` 仅支持 string（纯文本）；多模态（图片等）后续开放。
- 非流式（`stream: false`）不支持。
- 服务端重启不影响会话（状态持久化在服务端存储）。
- 仅有本文所列两个端点，其余（Conversations、response 检索等）暂未开放。
