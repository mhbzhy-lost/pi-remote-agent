/**
 * pi RPC 宿主进程封装。
 *
 * 宿主 = pi coding agent CLI 的 `--mode rpc` 子进程：
 * stdin 收 JSON 行命令（{id, type, ...data}），stdout 流出 JSON 行事件与命令回执
 * （回执形如 {type:'response', id, success, data}）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { config } from "../config.ts";

/** RPC stdout 上的一条 JSON 记录（事件或命令回执）。 */
export type RpcRecord = Record<string, any>;

export class RpcTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcTimeoutError";
  }
}
export class RpcCommandError extends Error {
  readonly command: string;
  constructor(command: string, message: string) {
    super(message);
    this.name = "RpcCommandError";
    this.command = command;
  }
}
export class RpcExitError extends Error {
  readonly code: number | null;
  readonly stderr: string;
  constructor(code: number | null, stderr: string) {
    super(`RPC host exited (code=${code})`);
    this.name = "RpcExitError";
    this.code = code;
    this.stderr = stderr;
  }
}

interface Pending {
  resolve: (data: any) => void;
  reject: (error: Error) => void;
  command: string;
}

export class PiRpcHost {
  readonly child: ChildProcessWithoutNullStreams;
  /** 每条 stdout JSON 记录都会触发，参数为解析后的对象。 */
  readonly events = new EventEmitter();
  private buffer = "";
  private stderrText = "";
  private pending = new Map<string, Pending>();
  private ordinal = 0;
  readonly closed: Promise<number | null>;
  /** 宿主异常退出时（仍有 pending 命令或被复用）对外抛出的错误。 */
  exitError: RpcExitError | null = null;
  private waitReadyPromise: Promise<RpcSessionState> | null = null;

  constructor(options: { sessionFile?: string; cwd?: string } = {}) {
    const args = [
      config.piCli,
      "--mode",
      "rpc",
      "--approve",
    ];
    if (options.sessionFile) args.push("--session", options.sessionFile);
    this.child = spawn(
      process.execPath,
      args,
      {
        cwd: options.cwd ?? config.workspaceDir,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: config.piAgentDir,
          PI_CODING_AGENT_SESSION_DIR: config.sessionDir,
          PI_CODING_WORKSPACE_DIR: config.workspacesDir,
          PI_SKIP_VERSION_CHECK: "1",
          PI_TELEMETRY: "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as ChildProcessWithoutNullStreams;
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrText += chunk.toString("utf8");
      // stderr 只保留最近 16KB 用于诊断
      if (this.stderrText.length > 16384) this.stderrText = this.stderrText.slice(-16384);
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let end: number;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!line.trim()) continue;
        let record: RpcRecord;
        try {
          record = JSON.parse(line);
        } catch {
          continue; // 启动横幅等非 JSON 行
        }
        this.handleRecord(record);
      }
    });
    this.closed = new Promise((done) => this.child.once("close", (code) => done(code)));
    this.child.once("close", (code) => {
      this.exitError = new RpcExitError(code, this.stderrText);
      for (const pending of this.pending.values()) {
        pending.reject(this.exitError);
      }
      this.pending.clear();
      this.events.emit("exit", this.exitError);
    });
  }

  private handleRecord(record: RpcRecord): void {
    if (record.type === "response" && typeof record.id === "string") {
      const pending = this.pending.get(record.id);
      if (pending) {
        this.pending.delete(record.id);
        if (record.success) pending.resolve(record.data);
        else pending.reject(new RpcCommandError(String(pending.command), String(record.error ?? "command failed")));
        return;
      }
    }
    this.events.emit("record", record);
  }

  /** 发送命令并等待其回执。 */
  async send(command: string, data: Record<string, any> = {}, timeoutMs = 60_000): Promise<any> {
    if (this.child.exitCode !== null) {
      throw this.exitError ?? new RpcExitError(this.child.exitCode, this.stderrText);
    }
    const id = `gw-${++this.ordinal}-${randomUUID().slice(0, 8)}`;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(`RPC command "${command}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        command,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.child.stdin.write(JSON.stringify({ id, type: command, ...data }) + "\n");
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 等宿主就绪（能应答 get_state），返回会话状态。 */
  async ready(timeoutMs = 60_000): Promise<RpcSessionState> {
    if (!this.waitReadyPromise) {
      const probe = async (): Promise<RpcSessionState> => {
        // 宿主启动后需要一点时间加载扩展/模型，用 get_state 探活
        const deadline = Date.now() + timeoutMs;
        let lastError: unknown;
        while (Date.now() < deadline) {
          try {
            return await this.send("get_state", {}, 10_000);
          } catch (error) {
            if (this.child.exitCode !== null) throw this.exitError;
            lastError = error;
            await new Promise((done) => setTimeout(done, 200));
          }
        }
        throw lastError instanceof Error ? lastError : new Error("RPC host not ready");
      };
      this.waitReadyPromise = probe();
    }
    return await this.waitReadyPromise;
  }

  /** 是否已无进行中的流（host 空闲）。 */
  async settled(): Promise<boolean> {
    const state = await this.send("get_state", {}, 10_000);
    return !state.isStreaming && !state.isCompacting && state.pendingMessageCount === 0;
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    const exited = await Promise.race([
      this.closed.then(() => true),
      new Promise<boolean>((done) => setTimeout(() => done(false), 3000)),
    ]);
    if (!exited) {
      this.child.kill("SIGTERM");
      await Promise.race([
        this.closed.then(() => true),
        new Promise<boolean>((done) => setTimeout(() => done(false), 3000)),
      ]) || this.child.kill("SIGKILL");
    }
  }

  get stderr(): string {
    return this.stderrText;
  }
}

export interface RpcSessionState {
  sessionId: string;
  sessionFile?: string;
  isStreaming: boolean;
  isCompacting: boolean;
  messageCount: number;
  model?: { provider: string; id: string };
  [key: string]: any;
}

/** 确保运行时目录存在。 */
export async function ensureSessionDir(): Promise<void> {
  await mkdir(config.sessionDir, { recursive: true });
  await mkdir(config.workspacesDir, { recursive: true });
  await mkdir(config.sessionWorkspacesDir, { recursive: true });
}
