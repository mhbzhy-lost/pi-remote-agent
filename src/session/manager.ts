/**
 * 会话管理：
 * - `response.id → pi session` 映射（落盘 var/gateway/map.json，网关重启可恢复）
 * - pi RPC 宿主进程池（lazy 拉起、空闲回收、`--session <file>` 重开）
 * - 每会话互斥锁（一会话一并发，409）
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import { PiRpcHost, type RpcSessionState } from "../rpc/host.ts";

export interface SessionInfo {
  sessionId: string;
  sessionFile?: string;
}

interface HostEntry {
  host: PiRpcHost;
  state: RpcSessionState;
  busy: boolean;
  lastActive: number;
}
export type { HostEntry };

export class SessionNotFoundError extends Error {
  readonly responseId: string;
  constructor(responseId: string) {
    super(`previous_response_id not found: ${responseId}`);
    this.name = "SessionNotFoundError";
    this.responseId = responseId;
  }
}
export class SessionBusyError extends Error {
  constructor() {
    super("conversation already has an in-flight request");
    this.name = "SessionBusyError";
  }
}

export class SessionManager {
  /** responseId → 会话信息 */
  private mapping = new Map<string, SessionInfo>();
  /** sessionId → 宿主进程条目 */
  private hosts = new Map<string, HostEntry>();
  private mapFile = join(config.dataDir, "map.json");
  private loaded = false;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await mkdir(config.dataDir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.mapFile, "utf8")) as Record<string, SessionInfo>;
      for (const [responseId, info] of Object.entries(raw)) {
        if (info && typeof info.sessionId === "string") {
          this.mapping.set(responseId, { sessionId: info.sessionId, sessionFile: info.sessionFile });
        }
      }
    } catch {
      /* 首次启动无映射文件 */
    }
  }

  private async persist(): Promise<void> {
    await mkdir(config.dataDir, { recursive: true });
    const raw: Record<string, SessionInfo> = {};
    for (const [responseId, info] of this.mapping) raw[responseId] = info;
    const tmp = `${this.mapFile}.tmp`;
    await writeFile(tmp, JSON.stringify(raw), "utf8");
    const { rename } = await import("node:fs/promises");
    await rename(tmp, this.mapFile);
  }

  /** 登记一次 response（路由凭据）。 */
  async registerResponse(responseId: string, info: SessionInfo): Promise<void> {
    this.mapping.set(responseId, info);
    await this.persist();
  }

  /** 解析 responseId 对应的会话；不存在则抛 SessionNotFoundError。 */
  resolve(responseId: string): SessionInfo {
    const info = this.mapping.get(responseId);
    if (!info) throw new SessionNotFoundError(responseId);
    return info;
  }

  /**
   * 获取一个可用的宿主条目（会话级互斥）。
   * - 已有进程且空闲 → 复用
   * - 已有进程但忙 → SessionBusyError
   * - 无进程 → 按 sessionFile 重开（新会话则不带 --session，由 pi 新建）
   */
  async acquire(options: { sessionFile?: string; createNew: boolean }): Promise<HostEntry> {
    // 新会话：直接拉起全新宿主
    if (options.createNew) {
      const host = new PiRpcHost();
      const state = await host.ready();
      const entry: HostEntry = { host, state, busy: true, lastActive: Date.now() };
      this.hosts.set(state.sessionId, entry);
      host.events.on("exit", () => {
        if (this.hosts.get(state.sessionId)?.host === host) this.hosts.delete(state.sessionId);
      });
      return entry;
    }
    // 既有会话：定位 sessionId
    if (!options.sessionFile) throw new SessionNotFoundError("(no session file)");
    // 用 sessionFile 反查活跃宿主
    for (const entry of this.hosts.values()) {
      if (entry.state.sessionFile === options.sessionFile) {
        if (entry.busy) throw new SessionBusyError();
        entry.busy = true;
        entry.lastActive = Date.now();
        return entry;
      }
    }
    // 无活跃宿主：重开
    const host = new PiRpcHost({ sessionFile: options.sessionFile });
    const state = await host.ready();
    const entry: HostEntry = { host, state, busy: true, lastActive: Date.now() };
    this.hosts.set(state.sessionId, entry);
    host.events.on("exit", () => {
      if (this.hosts.get(state.sessionId)?.host === host) this.hosts.delete(state.sessionId);
    });
    return entry;
  }

  /** 新会话创建后回填 state（含 sessionFile）。 */
  adopt(entry: HostEntry, state: RpcSessionState): void {
    entry.state = state;
    this.hosts.set(state.sessionId, entry);
  }

  release(entry: HostEntry): void {
    entry.busy = false;
    entry.lastActive = Date.now();
  }

  /** 定期回收空闲宿主进程（会话落盘，进程可随时按需重开）。 */
  startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, entry] of this.hosts) {
        if (!entry.busy && now - entry.lastActive > config.idleMs) {
          this.hosts.delete(sessionId);
          void entry.host.close();
        }
      }
    }, Math.min(config.idleMs, 60_000));
    this.sweeper.unref();
  }

  activeHostCount(): number {
    return this.hosts.size;
  }

  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    await Promise.all([...this.hosts.values()].map((entry) => entry.host.close()));
    this.hosts.clear();
  }
}

/** 生成官方形状的 id。 */
export function newResponseId(): string {
  return `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
export function newCompactionId(): string {
  return `cmp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
