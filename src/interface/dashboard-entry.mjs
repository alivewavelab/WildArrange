// =============================================================================
// 文件名称：dashboard-entry.mjs
// 所属模块：interface
// 作用说明：
//   `serve` 与 `adoption start/resume` 共用的 Dashboard 启动参数解析与 URL 拼装。
//   bin 只把命令行取值传进来并在成功后保持进程存活。
// =============================================================================
import { randomBytes } from "node:crypto";
import { startDashboardServer } from "./dashboard.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8765;

/**
 * 解析 Dashboard 监听参数。
 * @param {{ host?: string, port?: string, token?: string }} input CLI 原始取值
 * @param {{ autoToken?: boolean }} [options] autoToken 时 token 缺省取环境变量，再退化为随机 24 字节 base64url
 * @returns {{ host: string, port: number, token: string|undefined }}
 */
export function resolveDashboardOptions({ host, port, token } = {}, { autoToken = false } = {}) {
  return {
    host: host || DEFAULT_HOST,
    port: port ? Number(port) : DEFAULT_PORT,
    token: token || (autoToken ? process.env.WILDARRANGE_DASHBOARD_TOKEN || randomBytes(24).toString("base64url") : undefined),
  };
}

/**
 * 生成 adoption 用的 startServer：启动 Dashboard 并返回带 token 的 approvals 深链。
 * @param {string} rootDir 项目根目录
 * @param {{ host: string, port: number, token?: string }} defaults 未被调用方覆盖时的监听参数
 * @returns {(options?: { host?: string, port?: number, token?: string }) => Promise<{ server: import("node:http").Server, url: string }>}
 */
export function createAdoptionServerStarter(rootDir, defaults) {
  return async (options = {}) => {
    const server = await startDashboardServer(rootDir, options);
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : options.port || DEFAULT_PORT;
    return {
      server,
      url: `http://${options.host || defaults.host}:${actualPort}/#approvals?token=${encodeURIComponent(options.token || defaults.token)}`,
    };
  };
}

/** 启动只读 Dashboard（`serve` 命令）；返回对外展示的 URL。 */
export async function serveDashboard(rootDir, options) {
  await startDashboardServer(rootDir, options);
  return { ok: true, url: `http://${options.host}:${options.port}/` };
}
