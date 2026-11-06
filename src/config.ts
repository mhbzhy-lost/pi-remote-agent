/**
 * 网关配置：全部来自环境变量，未配置的给出缺省值。
 *
 * - PI_REMOTE_AGENT_TOKEN  鉴权 token（必配，未配置则拒绝所有请求）
 * - PI_REMOTE_AGENT_PORT   HTTP 端口（默认 8787）
 * - PI_REMOTE_AGENT_HOST   HTTP 监听地址（默认 127.0.0.1，仅本机）
 * - PI_REMOTE_AGENT_ROOT   本仓库根目录（默认取当前工作目录）
 * - PI_REMOTE_AGENT_WORKSPACE_DIR  pi 宿主进程的兜底 cwd（默认本仓库根；每会话工作区启用后仅作回退）
 * - PI_REMOTE_AGENT_SESSION_WORKSPACES_DIR  每会话独立工作区根目录（默认 <root>/var/session-workspaces）
 * - PI_REMOTE_AGENT_SESSION_DIR    pi 会话落盘目录（默认 <root>/var/sessions）
 * - PI_REMOTE_AGENT_IDLE_MS        RPC 宿主空闲回收阈值（默认 10 分钟）
 */
import { join, resolve } from "node:path";

const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed > 0 === false) return fallback;
  return parsed;
};

export const config = {
  token: process.env.PI_REMOTE_AGENT_TOKEN ?? "",
  port: num("PI_REMOTE_AGENT_PORT", 8787),
  host: process.env.PI_REMOTE_AGENT_HOST ?? "127.0.0.1",
  root: resolve(process.env.PI_REMOTE_AGENT_ROOT ?? process.cwd()),
  get piConfigDir(): string {
    return join(config.root, "pi-config");
  },
  get piCli(): string {
    return join(config.piConfigDir, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  },
  /** pi 的 agent 目录：auth.json / settings.json / models.json / agents / extensions */
  get piAgentDir(): string {
    return process.env.PI_REMOTE_AGENT_PI_DIR ?? join(config.piConfigDir, "pi");
  },
  get workspaceDir(): string {
    return resolve(process.env.PI_REMOTE_AGENT_WORKSPACE_DIR ?? config.root);
  },
  /** 每会话独立工作区根目录（pi 宿主 cwd 按会话隔离） */
  get sessionWorkspacesDir(): string {
    return resolve(
      process.env.PI_REMOTE_AGENT_SESSION_WORKSPACES_DIR ?? join(config.root, "var/session-workspaces"),
    );
  },
  /** pi 会话落盘目录 */
  get sessionDir(): string {
    return resolve(process.env.PI_REMOTE_AGENT_SESSION_DIR ?? join(config.root, "var/sessions"));
  },
  /** pi-subagents 扩展的托管工作区目录（须为已存在的规范化绝对路径） */
  get workspacesDir(): string {
    return resolve(process.env.PI_REMOTE_AGENT_WORKSPACES_DIR ?? join(config.root, "var/workspaces"));
  },
  /** 网关自身运行时数据目录（response→session 映射等） */
  get dataDir(): string {
    return resolve(process.env.PI_REMOTE_AGENT_DATA_DIR ?? join(config.root, "var/gateway"));
  },
  idleMs: num("PI_REMOTE_AGENT_IDLE_MS", 10 * 60 * 1000),
  /** compact 是长操作，回执等待上限 */
  compactTimeoutMs: num("PI_REMOTE_AGENT_COMPACT_TIMEOUT_MS", 10 * 60 * 1000),
  /** SSE 心跳间隔 */
  keepaliveMs: num("PI_REMOTE_AGENT_KEEPALIVE_MS", 15 * 1000),
};

export type Config = typeof config;
