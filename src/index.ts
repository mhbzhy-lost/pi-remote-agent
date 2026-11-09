/**
 * pi-remote-agent 网关入口。
 *
 * 启动流程：加载映射 → 起 HTTP/SSE 服务 → 空闲宿主回收。
 * 优雅停机：SIGTERM/SIGINT → 停止接收新请求 → 回收全部 RPC 宿主。
 */
import { config } from "./config.ts";
import { SessionManager } from "./session/manager.ts";
import { createGatewayServer } from "./http/server.ts";
import { ensureSessionDir } from "./rpc/host.ts";

async function main(): Promise<void> {
  if (!config.token) {
    console.error("[gateway] PI_REMOTE_AGENT_TOKEN 未配置，仅真实 loopback 对端且未携带 Authorization 的请求可访问");
  }
  await ensureSessionDir();
  const manager = new SessionManager();
  await manager.load();
  manager.startSweeper();

  const server = createGatewayServer(manager);
  server.listen(config.port, config.host, () => {
    console.log(`[gateway] listening on http://${config.host}:${config.port}/v1/responses`);
    console.log(`[gateway] pi cli: ${config.piCli}`);
    console.log(`[gateway] pi agent dir: ${config.piAgentDir}`);
    console.log(`[gateway] session dir: ${config.sessionDir}`);
    console.log(`[gateway] workspace dir: ${config.workspaceDir}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[gateway] received ${signal}, shutting down…`);
    server.close(() => {
      console.log("[gateway] http server closed");
    });
    void manager.shutdown().then(() => {
      console.log("[gateway] rpc hosts closed");
      process.exit(0);
    });
    // 强制兜底
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

void main();
