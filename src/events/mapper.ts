/**
 * pi RPC 事件 → OpenAI Responses 官方 SSE 事件映射。
 *
 * 官方 wire 规则（OpenAPI 2.3.0）：
 * - 事件两行成对：`event: <type>` + `data: <JSON>`，每个事件必带 `sequence_number`
 * - response.created / in_progress / completed / failed / incomplete 的 data 含完整 Response 对象
 * - 文本链：output_item.added → content_part.added → output_text.delta* → output_text.done
 *           → content_part.done → output_item.done
 * - 工具调用：function_call item + response.function_call_arguments.delta/.done
 * - pi 侧扩展：pi.tool_execution（工具执行进度，官方无对应）
 */
import type { RpcRecord } from "../rpc/host.ts";

export interface SseSink {
  /** 写一条 SSE 事件（event 行 + data 行）。 */
  write(eventName: string, data: Record<string, unknown>): void;
}

interface OfficialItem {
  id: string;
  type: "message" | "function_call" | "reasoning";
  status?: "in_progress" | "completed";
  role?: string;
  content?: Array<Record<string, unknown>>;
  name?: string;
  arguments?: string;
  summary?: unknown[];
}

interface ContentBlockMap {
  kind: "text" | "thinking" | "toolCall";
  itemIndex: number;
  closed: boolean;
}

export interface MapperResult {
  ok: boolean;
  failedMessage: string | null;
  aborted: boolean;
}

export class ResponseStreamMapper {
  private seq = 0;
  private items: OfficialItem[] = [];
  /** 当前 assistant 消息的 contentIndex → 输出项映射 */
  private blockMap = new Map<number, ContentBlockMap>();
  private msgCounter = 0;
  private usageTotals = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };
  private failure: string | null = null;
  private settled = false;
  private readonly created = Math.floor(Date.now() / 1000);
  private readonly responseId: string;
  private readonly model: string;
  private readonly previousResponseId: string | null;

  constructor(
    sink: SseSink,
    options: { responseId: string; model: string; previousResponseId: string | null },
  ) {
    this.sink = sink;
    this.responseId = options.responseId;
    this.model = options.model;
    this.previousResponseId = options.previousResponseId;
  }
  private sink: SseSink;

  /** 流开始：response.created + response.in_progress。 */
  start(): void {
    this.emit("response.created", { response: this.responseObject("in_progress") });
    this.emit("response.in_progress", { response: this.responseObject("in_progress") });
  }

  /** 喂入一条 pi RPC stdout 记录。返回 true 表示流已终结。 */
  feed(record: RpcRecord): boolean {
    if (this.settled) return true;
    switch (record.type) {
      case "message_start":
        if (record.message?.role === "assistant") this.blockMap = new Map();
        return false;
      case "message_update":
        this.feedUpdate(record);
        return false;
      case "message_end":
        if (record.message?.role === "assistant") this.finalizeMessage(record.message);
        return false;
      case "tool_execution_start":
        this.emit("pi.tool_execution", {
          toolCallId: record.toolCallId,
          tool: record.toolName,
          status: "start",
          summary: summarizeArgs(record.args),
        });
        return false;
      case "tool_execution_end":
        this.emit("pi.tool_execution", {
          toolCallId: record.toolCallId,
          tool: record.toolName,
          status: "end",
          isError: record.isError === true,
          summary: summarizeResult(record.result),
        });
        return false;
      case "agent_settled":
        this.finish(record.aborted === true);
        return true;
      default:
        return false;
    }
  }

  /** 宿主进程异常退出等场景：强制以 failed 收尾。 */
  fail(message: string): void {
    if (this.settled) return;
    this.failure = message;
    this.finish(false);
  }

  /** 是否已终结。 */
  get done(): boolean {
    return this.settled;
  }

  get result(): MapperResult {
    return { ok: this.failure === null, failedMessage: this.failure, aborted: this.abortedFlag };
  }
  private abortedFlag = false;

  // ---------------------------------------------------------------- 消息内容块

  private feedUpdate(record: RpcRecord): void {
    // 注意：RPC wire 的 message_update 不携带 message 字段（toJsonEvent 剥离），
    // 只带 usage + assistantMessageEvent；且 message_update 只对 assistant 消息发出。
    const event = record.assistantMessageEvent;
    if (!event || typeof event !== "object") return;
    const contentIndex: number = event.contentIndex;
    switch (event.type) {
      case "text_start":
        this.openTextBlock(contentIndex);
        break;
      case "text_delta":
        this.onTextDelta(contentIndex, String(event.delta ?? ""));
        break;
      case "text_end":
        this.onTextEnd(contentIndex, String(event.content ?? ""));
        break;
      case "thinking_start":
        this.openThinkingBlock(contentIndex);
        break;
      case "toolcall_start":
        this.openToolCallBlock(contentIndex, String(event.id ?? ""), String(event.toolName ?? ""));
        break;
      case "toolcall_delta":
        this.onToolCallDelta(contentIndex, String(event.delta ?? ""));
        break;
      case "toolcall_end":
        this.closeToolCallBlock(contentIndex, event.toolCall);
        break;
      default:
        break;
    }
  }

  private block(contentIndex: number, kind: "text" | "thinking" | "toolCall", open: () => number): ContentBlockMap {
    let entry = this.blockMap.get(contentIndex);
    if (!entry) {
      const itemIndex = open();
      entry = { kind, itemIndex, closed: false };
      this.blockMap.set(contentIndex, entry);
    }
    return entry;
  }

  private openTextBlock(contentIndex: number): void {
    this.block(contentIndex, "text", () => {
      const item: OfficialItem = {
        id: `msg_${++this.msgCounter}`,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [{ type: "output_text", text: "", annotations: [] }],
      };
      this.items.push(item);
      const itemIndex = this.items.length - 1;
      this.emit("response.output_item.added", { output_index: itemIndex, item: itemSnapshot(item) });
      this.emit("response.content_part.added", {
        item_id: item.id,
        output_index: itemIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
      return itemIndex;
    });
  }

  private onTextDelta(contentIndex: number, delta: string): void {
    const entry = this.blockMap.get(contentIndex);
    if (!entry || entry.kind !== "text" || entry.closed) return;
    const item = this.items[entry.itemIndex];
    if (!item) return;
    const part = item.content?.[0];
    if (part && typeof part.text === "string") part.text += delta;
    this.emit("response.output_text.delta", {
      item_id: item.id,
      output_index: entry.itemIndex,
      content_index: 0,
      delta,
      logprobs: [],
    });
  }

  private onTextEnd(contentIndex: number, text: string): void {
    const entry = this.blockMap.get(contentIndex);
    if (!entry || entry.kind !== "text" || entry.closed) return;
    entry.closed = true;
    const item = this.items[entry.itemIndex];
    if (!item) return;
    const part = item.content?.[0];
    if (part) part.text = text;
    this.emit("response.output_text.done", {
      item_id: item.id,
      output_index: entry.itemIndex,
      content_index: 0,
      text,
      logprobs: [],
    });
    this.emit("response.content_part.done", {
      item_id: item.id,
      output_index: entry.itemIndex,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    });
  }

  private openThinkingBlock(contentIndex: number): void {
    this.block(contentIndex, "thinking", () => {
      const item: OfficialItem = {
        id: `rs_${++this.msgCounter}`,
        type: "reasoning",
        summary: [],
      };
      this.items.push(item);
      const itemIndex = this.items.length - 1;
      this.emit("response.output_item.added", { output_index: itemIndex, item: itemSnapshot(item) });
      return itemIndex;
    });
  }

  private openToolCallBlock(contentIndex: number, callId: string, toolName: string): void {
    this.block(contentIndex, "toolCall", () => {
      const id = callId || `fc_${++this.msgCounter}`;
      const item: OfficialItem = {
        id,
        type: "function_call",
        status: "in_progress",
        name: toolName,
        arguments: "",
      };
      this.items.push(item);
      const itemIndex = this.items.length - 1;
      this.emit("response.output_item.added", { output_index: itemIndex, item: itemSnapshot(item) });
      return itemIndex;
    });
  }

  private onToolCallDelta(contentIndex: number, delta: string): void {
    const entry = this.blockMap.get(contentIndex);
    if (!entry || entry.kind !== "toolCall" || entry.closed) return;
    const item = this.items[entry.itemIndex];
    if (!item) return;
    item.arguments = (item.arguments ?? "") + delta;
    this.emit("response.function_call_arguments.delta", {
      item_id: item.id,
      output_index: entry.itemIndex,
      delta,
    });
  }

  private closeToolCallBlock(contentIndex: number, toolCall: any): void {
    const entry = this.blockMap.get(contentIndex);
    if (!entry || entry.kind !== "toolCall" || entry.closed) return;
    entry.closed = true;
    const item = this.items[entry.itemIndex];
    if (!item) return;
    item.arguments = toolCall?.arguments !== undefined ? JSON.stringify(toolCall.arguments) : (item.arguments ?? "");
    this.emit("response.function_call_arguments.done", {
      item_id: item.id,
      output_index: entry.itemIndex,
      arguments: item.arguments,
    });
    item.status = "completed";
    this.emit("response.output_item.done", { output_index: entry.itemIndex, item: itemSnapshot(item) });
  }

  /** message_end：权威完整消息 → 收尾所有未闭合块 + usage 累计。 */
  private finalizeMessage(message: any): void {
    const content: any[] = Array.isArray(message.content) ? message.content : [];
    for (const [contentIndex, entry] of [...this.blockMap.entries()].sort((a, b) => a[0] - b[0])) {
      const authoritative = content[contentIndex];
      if (entry.kind === "text") {
        if (!entry.closed) {
          const text = typeof authoritative?.text === "string" ? authoritative.text : "";
          this.onTextEnd(contentIndex, text);
        }
        const item = this.items[entry.itemIndex];
        if (item) {
          item.status = "completed";
          this.emit("response.output_item.done", { output_index: entry.itemIndex, item: itemSnapshot(item) });
        }
      } else if (entry.kind === "thinking") {
        entry.closed = true;
        const item = this.items[entry.itemIndex];
        if (item) this.emit("response.output_item.done", { output_index: entry.itemIndex, item: itemSnapshot(item) });
      } else if (entry.kind === "toolCall") {
        if (!entry.closed) this.closeToolCallBlock(contentIndex, authoritative);
      }
    }
    this.blockMap = new Map();
    const usage = message.usage;
    if (usage && typeof usage === "object") {
      this.usageTotals.input += Number(usage.input ?? 0);
      this.usageTotals.output += Number(usage.output ?? 0);
      this.usageTotals.cacheRead += Number(usage.cacheRead ?? 0);
      this.usageTotals.reasoning += Number(usage.reasoning ?? 0);
    }
    if (message.stopReason === "error") {
      this.failure = String(message.errorMessage ?? "model request failed");
    }
  }

  // ---------------------------------------------------------------- 收尾

  private finish(aborted: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.abortedFlag = aborted;
    if (this.failure !== null) {
      const response = this.responseObject("failed");
      response.error = { message: this.failure, type: "server_error" };
      this.emit("response.failed", { response });
    } else if (aborted) {
      const response = this.responseObject("incomplete");
      response.incomplete_details = { reason: "cancelled" };
      this.emit("response.incomplete", { response });
    } else {
      this.emit("response.completed", { response: this.responseObject("completed") });
    }
  }

  private usageObject(): Record<string, unknown> {
    const { input, output, cacheRead, reasoning } = this.usageTotals;
    return {
      input_tokens: input,
      input_tokens_details: { cached_tokens: cacheRead },
      output_tokens: output,
      output_tokens_details: { reasoning_tokens: reasoning },
      total_tokens: input + output,
    };
  }

  private responseObject(status: string): Record<string, any> {
    return {
      id: this.responseId,
      object: "response",
      created_at: this.created,
      status,
      error: null,
      incomplete_details: null,
      instructions: null,
      model: this.model,
      output: this.items.map(itemSnapshot),
      parallel_tool_calls: true,
      previous_response_id: this.previousResponseId,
      store: true,
      temperature: 1,
      top_p: 1,
      tool_choice: "auto",
      tools: [],
      metadata: {},
      usage: this.settled ? this.usageObject() : null,
    };
  }

  private emit(eventName: string, data: Record<string, unknown>): void {
    const payload = { ...data, sequence_number: this.seq++ };
    this.sink.write(eventName, payload);
  }
}

function itemSnapshot(item: OfficialItem): Record<string, unknown> {
  const copy: Record<string, unknown> = { id: item.id, type: item.type };
  if (item.type === "message") {
    copy.status = item.status ?? "completed";
    copy.role = item.role ?? "assistant";
    copy.content = item.content ?? [];
  } else if (item.type === "function_call") {
    copy.status = item.status ?? "completed";
    copy.name = item.name ?? "";
    copy.arguments = item.arguments ?? "";
  } else if (item.type === "reasoning") {
    copy.summary = item.summary ?? [];
  }
  return copy;
}

function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  try {
    return truncate(JSON.stringify(args));
  } catch {
    return truncate(String(args));
  }
}

function summarizeResult(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "object" && result !== null) {
    const anyResult = result as Record<string, unknown>;
    // pi 工具结果常见形状：{ content / stdout / text / output / isError / details }
    for (const key of ["content", "stdout", "text", "output"]) {
      const value = anyResult[key];
      if (typeof value === "string" && value.trim()) return truncate(value);
    }
    if (typeof anyResult.isError === "boolean" && anyResult.isError) {
      return truncate(String(anyResult.message ?? JSON.stringify(result)));
    }
  }
  try {
    return truncate(JSON.stringify(result));
  } catch {
    return truncate(String(result));
  }
}

function truncate(text: string, max = 200): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}
