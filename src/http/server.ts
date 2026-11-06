/**
 * HTTP/SSE 服务层：两个端点，全部 OpenAI Responses 规范本体。
 *
 * - POST /v1/responses        自然语言输入 → SSE 流式输出（不带 previous_response_id = 新会话）
 * - POST /v1/responses/compact 压缩会话 → CompactResource
 *
 * 鉴权：Authorization: Bearer <PI_REMOTE_AGENT_TOKEN>。
 * 错误响应体：官方 ErrorResponse 形状 {"error":{message,type,...}}。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { config } from "../config.ts";
import { SessionManager, newResponseId, newCompactionId, type HostEntry } from "../session/manager.ts";
import {
  SessionNotFoundError,
  SessionBusyError,
} from "../session/manager.ts";
import { RpcCommandError, RpcTimeoutError, RpcExitError, type RpcRecord } from "../rpc/host.ts";
import { ResponseStreamMapper, type SseSink } from "../events/mapper.ts";

const MAX_BODY_BYTES = 10 * 1024 * 1024;

interface ErrorShape {
  message: string;
  type: string;
  param?: string;
  code?: string | null;
}

function errorBody(res: ServerResponse, status: number, message: string, type: string, code: string | null = null): void {
  const payload: { error: ErrorShape } = {
    error: { message, type, code },
  };
  sendJson(res, status, payload);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function createGatewayServer(manager: SessionManager): ReturnType<typeof createServer> {
  return createServer((req, res) => {
    void handle(req, res, manager).catch((error) => {
      if (!res.headersSent) {
        errorBody(res, 500, `internal error: ${error instanceof Error ? error.message : String(error)}`, "server_error");
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, manager: SessionManager): Promise<void> {
  // ---- 鉴权 ----
  if (!config.token) {
    errorBody(res, 503, "server token not configured (PI_REMOTE_AGENT_TOKEN)", "server_error");
    return;
  }
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${config.token}`) {
    errorBody(res, 401, "invalid or missing bearer token", "authentication_error");
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method !== "POST" || !(url.pathname === "/v1/responses" || url.pathname === "/v1/responses/compact")) {
    errorBody(res, 404, `no such endpoint: ${req.method} ${url.pathname}`, "invalid_request_error");
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    errorBody(res, 400, `invalid request body: ${error instanceof Error ? error.message : String(error)}`, "invalid_request_error");
    return;
  }

  if (url.pathname === "/v1/responses") {
    await handleResponses(res, manager, body);
  } else {
    await handleCompact(res, manager, body);
  }
}

// ---------------------------------------------------------------- /v1/responses

interface PromptRequest {
  model: string;
  input: string;
  stream: true;
  previousResponseId: string | null;
}

function parsePromptRequest(body: Record<string, unknown>): PromptRequest {
  if (typeof body.model !== "string" || body.model.length === 0) {
    throw new BadRequestError("`model` is required (string; value is ignored by this gateway)");
  }
  if (typeof body.input !== "string" || body.input.length === 0) {
    throw new BadRequestError("`input` is required and must be a non-empty string (array input is not supported)");
  }
  if (body.stream !== true) {
    throw new BadRequestError("`stream` must be explicitly set to true (non-streaming is not supported)");
  }
  const prev = body.previous_response_id;
  if (prev !== undefined && prev !== null && typeof prev !== "string") {
    throw new BadRequestError("`previous_response_id` must be a string or null");
  }
  return { model: body.model, input: body.input, stream: true, previousResponseId: prev ?? null };
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

async function handleResponses(res: ServerResponse, manager: SessionManager, body: Record<string, unknown>): Promise<void> {
  let request: PromptRequest;
  try {
    request = parsePromptRequest(body);
  } catch (error) {
    errorBody(res, 400, error instanceof Error ? error.message : String(error), "invalid_request_error");
    return;
  }

  // ---- 路由：previous_response_id → 既有会话；缺省 → 新会话 ----
  let entry: HostEntry;
  try {
    if (request.previousResponseId === null) {
      entry = await manager.acquire({ createNew: true });
    } else {
      const session = manager.resolve(request.previousResponseId);
      entry = await manager.acquire({
        sessionFile: session.sessionFile,
        createNew: false,
        workspaceId: session.workspaceId,
      });
    }
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      errorBody(res, 404, error.message, "invalid_request_error", "response_not_found");
      return;
    }
    if (error instanceof SessionBusyError) {
      errorBody(res, 409, error.message, "invalid_request_error");
      return;
    }
    throw error;
  }

  const responseId = newResponseId();
  await manager.registerResponse(responseId, {
    sessionId: entry.state.sessionId,
    sessionFile: entry.state.sessionFile,
    workspaceId: entry.workspaceId,
  });

  // ---- SSE 头 ----
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const model = entry.state.model ? `${entry.state.model.provider}/${entry.state.model.id}` : "pi-agent";
  const sink: SseSink = {
    write: (eventName, data) => {
      if (res.writableEnded || res.destroyed) return;
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    },
  };
  const mapper = new ResponseStreamMapper(sink, { responseId, model, previousResponseId: request.previousResponseId });
  mapper.start();

  // ---- 心跳 ----
  const keepalive = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(": keepalive\n\n");
  }, config.keepaliveMs);

  const onRecord = (record: RpcRecord): void => {
    mapper.feed(record);
  };
  entry.host.events.on("record", onRecord);
  const onExit = (): void => {
    if (!mapper.done) mapper.fail("pi host process exited unexpectedly");
  };
  entry.host.events.on("exit", onExit);

  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    clearInterval(keepalive);
    entry.host.events.off("record", onRecord);
    entry.host.events.off("exit", onExit);
    manager.release(entry);
    if (!res.writableEnded && !res.destroyed) res.end();
  };

  // 客户端断开：SSE 写入自动失效；pi 本轮继续跑完并落盘（会话以服务端为权威），
  // 锁保持到 agent_settled，下一轮仍可续聊。
  res.on("close", () => {
    if (finished) return;
    // 不 abort：上下文完整性优先于连接存活
  });

  try {
    await entry.host.send("prompt", { message: request.input }, 30_000);
  } catch (error) {
    // prompt 提交失败（非流内失败）：走官方 response.failed 语义收尾
    const message = error instanceof Error ? error.message : String(error);
    mapper.fail(`failed to submit prompt: ${message}`);
    finish();
    return;
  }

  // 等待流终结（agent_settled / failed）。宿主空闲轮询兜底（防事件丢失）。
  const deadline = Date.now() + 24 * 60 * 60 * 1000;
  while (!mapper.done && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 200));
  }
  if (!mapper.done) {
    mapper.fail("response stream timed out (24h)");
  }
  finish();
}

// ---------------------------------------------------------------- /v1/responses/compact

async function handleCompact(res: ServerResponse, manager: SessionManager, body: Record<string, unknown>): Promise<void> {
  if (typeof body.model !== "string" || body.model.length === 0) {
    errorBody(res, 400, "`model` is required (string; value is ignored by this gateway)", "invalid_request_error");
    return;
  }
  const prev = body.previous_response_id;
  if (typeof prev !== "string" || prev.length === 0) {
    errorBody(res, 400, "`previous_response_id` is required (routes to the conversation to compact)", "invalid_request_error");
    return;
  }
  const instructions = body.instructions;
  if (instructions !== undefined && instructions !== null && typeof instructions !== "string") {
    errorBody(res, 400, "`instructions` must be a string or null", "invalid_request_error");
    return;
  }

  let session;
  try {
    session = manager.resolve(prev);
  } catch {
    errorBody(res, 404, `previous_response_id not found: ${prev}`, "invalid_request_error", "response_not_found");
    return;
  }

  let entry: HostEntry;
  try {
    entry = await manager.acquire({
      sessionFile: session.sessionFile,
      createNew: false,
      workspaceId: session.workspaceId,
    });
  } catch (error) {
    if (error instanceof SessionBusyError) {
      errorBody(res, 409, error.message, "invalid_request_error");
      return;
    }
    if (error instanceof SessionNotFoundError) {
      errorBody(res, 404, "conversation session file is missing", "invalid_request_error", "response_not_found");
      return;
    }
    throw error;
  }

  try {
    // 双保险：确认宿主空闲（可能有自动压缩等内部活动）
    const state = await entry.host.send("get_state", {}, 10_000);
    if (state.isStreaming || state.isCompacting || state.pendingMessageCount > 0) {
      errorBody(res, 409, "conversation already has an in-flight request", "invalid_request_error");
      return;
    }
    const result = await entry.host.send(
      "compact",
      instructions ? { customInstructions: instructions } : {},
      config.compactTimeoutMs,
    );
    sendJson(res, 200, buildCompactResource(result));
  } catch (error) {
    if (error instanceof RpcCommandError) {
      errorBody(res, 400, `compaction failed: ${error.message}`, "invalid_request_error");
      return;
    }
    if (error instanceof RpcTimeoutError) {
      errorBody(res, 504, `compaction timed out: ${error.message}`, "server_error");
      return;
    }
    if (error instanceof RpcExitError) {
      errorBody(res, 503, `pi host exited during compaction: ${error.stderr.slice(-400)}`, "server_error");
      return;
    }
    throw error;
  } finally {
    manager.release(entry);
  }
}

function buildCompactResource(result: any): Record<string, unknown> {
  const compactionId = newCompactionId();
  const summary = typeof result?.summary === "string" ? result.summary : "";
  const tokensBefore = Number(result?.tokensBefore ?? 0);
  const usage = result?.usage;
  const outputTokens = Number(usage?.output ?? 0);
  const reasoningTokens = Number(usage?.reasoning ?? 0);
  return {
    id: compactionId,
    object: "response.compaction",
    created_at: Math.floor(Date.now() / 1000),
    output: [
      {
        type: "compaction",
        id: compactionId,
        // pi 压缩摘要原文；对调用方为不透明内容，无需解析或回传
        encrypted_content: summary,
      },
    ],
    usage: {
      input_tokens: tokensBefore,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: outputTokens,
      output_tokens_details: { reasoning_tokens: reasoningTokens },
      total_tokens: tokensBefore + outputTokens,
    },
  };
}
