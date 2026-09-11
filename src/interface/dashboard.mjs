import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_EXECUTOR_AGENT,
  DEFAULT_LEAD_AGENT,
} from "../infra/agent-registry.mjs";
import {
  claimTeamTask,
  createTeamTask,
  getTeamTask,
  listTeamMessages,
  listTeamTasks,
  readyTeamTask,
  sendTeamMessage,
} from "../orchestration/task-board.mjs";
import { dashboardData, writeWorkflowSummary } from "../orchestration/status.mjs";
import { runNextTask, runWorkflowNode } from "../orchestration/linear-runtime.mjs";
import {
  annotateRouteDecision,
  buildDecisionsPanelViewModel,
  buildOpsPanelViewModel,
  buildRouteReviewPanelViewModel,
} from "./dashboard-panels.mjs";
import { tryHandleAdoptionApi } from "./adoption-panel.mjs";
import { renderDashboardHtml } from "./dashboard-view.mjs";

class DashboardBadRequest extends Error {}
class DashboardPayloadTooLarge extends Error {}

export function startDashboardServer(rootDir, options = {}) {
  const host = options.host || "127.0.0.1";
  const port = Number.isInteger(options.port) ? options.port : 8765;
  const configuredToken = typeof options.token === "string" && options.token.length > 0 ? options.token : process.env.WILDARRANGE_DASHBOARD_TOKEN || "";
  if (!isLoopbackHost(host) && configuredToken.length === 0) {
    throw new Error("wildarrange dashboard requires --token or WILDARRANGE_DASHBOARD_TOKEN when binding to a non-loopback host");
  }
  // 本机页面不要求用户理解或填写安全口令。服务启动时生成一次性会话
  // token，并通过 HttpOnly + SameSite cookie 交给同源页面；API 层仍保留
  // token、Host 与 Origin 三道写操作防护。非本机绑定继续要求显式 token。
  const token = configuredToken || randomBytes(32).toString("base64url");
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${host}:${port}`);
      if (url.pathname.startsWith("/api/") && !isAllowedHost(request, host)) {
        sendJson(response, 403, { ok: false, error: "forbidden_host" });
        return;
      }
      if (url.pathname.startsWith("/api/") && isUnsafeMethod(request.method) && !isSameSiteRequest(request, host)) {
        sendJson(response, 403, { ok: false, error: "forbidden_origin" });
        return;
      }
      if (url.pathname.startsWith("/api/") && requiresApiAuth(request, host) && !isAuthorized(request, token)) {
        sendJson(response, 401, { ok: false, error: "unauthorized" });
        return;
      }
      if (url.pathname === "/api/state") {
        const data = await dashboardData(rootDir);
        sendJson(response, 200, data);
        return;
      }
      if (request.method === "GET" && url.pathname === "/dashboard-assets/wordmark.png") {
        const asset = await readFile(new URL("../../docs/product/assets/wildarrange-wordmark-dark-v1.png", import.meta.url));
        response.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=3600" });
        response.end(asset);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/run-next") {
        const result = await runNextTask(rootDir);
        sendJson(response, 200, { ok: true, result });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/tasks") {
        const result = await listTeamTasks(rootDir, {
          all: url.searchParams.get("all") === "true",
          status: url.searchParams.get("status") || undefined,
          owner: url.searchParams.get("owner") || undefined,
          workType: url.searchParams.get("type") || undefined,
          priority: url.searchParams.get("priority") || undefined,
          planId: url.searchParams.get("plan") || undefined,
          search: url.searchParams.get("search") || undefined,
        });
        sendJson(response, 200, { ok: true, result });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/tasks/")) {
        const taskId = safeDecodeSegment(url.pathname.slice("/api/tasks/".length), "taskId");
        validateDashboardId(taskId, "taskId");
        const result = await getTeamTask(rootDir, taskId);
        sendJson(response, 200, { ok: true, result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/tasks/create") {
        const body = await readJsonBody(request);
        const result = await createTeamTask(rootDir, body);
        sendJson(response, 200, { ok: true, result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/tasks/ready") {
        const body = await readJsonBody(request);
        validateDashboardId(body.taskId, "taskId");
        validateOptionalDashboardId(body.planId, "planId");
        const result = await readyTeamTask(rootDir, {
          taskId: body.taskId,
          planId: body.planId,
          patch: body.patch,
        });
        sendJson(response, 200, { ok: true, result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/tasks/claim") {
        const body = await readJsonBody(request);
        validateDashboardId(body.taskId, "taskId");
        const result = await claimTeamTask(rootDir, { taskId: body.taskId, owner: body.owner });
        sendJson(response, 200, { ok: true, result });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/team/inbox") {
        const result = await listTeamMessages(rootDir, {
          agent: url.searchParams.get("agent") || undefined,
        });
        sendJson(response, 200, { ok: true, result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/team/send") {
        const body = await readJsonBody(request);
        const result = await sendTeamMessage(rootDir, body);
        sendJson(response, 200, { ok: true, result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/summary") {
        const result = await writeWorkflowSummary(rootDir, { reason: "dashboard" });
        sendJson(response, 200, { ok: true, result });
        return;
      }
      if (request.method === "POST" && url.pathname.startsWith("/api/node/")) {
        const nodeName = safeDecodeSegment(url.pathname.slice("/api/node/".length), "node");
        validateNodeName(nodeName);
        if (!["execute", "verify", "scope", "review", "checkpoint", "retry"].includes(nodeName)) {
          sendJson(response, 400, { ok: false, error: `unsupported node: ${nodeName}` });
          return;
        }
        const body = await readJsonBody(request);
        validateOptionalDashboardId(body.taskId, "taskId");
        const result = await runWorkflowNode(rootDir, nodeName, { taskId: body.taskId });
        sendJson(response, 200, { ok: true, result });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/panels/decisions") {
        sendJson(response, 200, await buildDecisionsPanelViewModel(rootDir));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/panels/routes") {
        const date = url.searchParams.get("date") || undefined;
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new DashboardBadRequest("invalid route review date");
        sendJson(response, 200, await buildRouteReviewPanelViewModel(rootDir, { date }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/panels/routes/annotate") {
        const body = await readJsonBody(request);
        validateDashboardId(body.decisionId, "decisionId");
        const result = await annotateRouteDecision(rootDir, body);
        sendJson(response, 200, { ok: true, result });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/panels/ops") {
        sendJson(response, 200, await buildOpsPanelViewModel(rootDir));
        return;
      }
      if (await tryHandleAdoptionApi(request, response, url, rootDir)) {
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const headers = isLoopbackHost(host)
          ? { "set-cookie": renderDashboardSessionCookie(token) }
          : {};
        sendHtml(response, 200, renderDashboardHtml(), headers);
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof DashboardBadRequest) {
        sendJson(response, 400, { ok: false, error: error.message });
        return;
      }
      if (error instanceof DashboardPayloadTooLarge) {
        sendJson(response, 413, { ok: false, error: error.message });
        return;
      }
      sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

function isLoopbackHost(host) {
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isUnsafeMethod(method) {
  return !["GET", "HEAD", "OPTIONS"].includes(String(method || "GET").toUpperCase());
}

function requiresApiAuth(request, host) {
  return isUnsafeMethod(request.method) || !isLoopbackHost(host);
}

function isAuthorized(request, token) {
  if (!token) return false;
  const auth = request.headers.authorization || "";
  if (safeTokenEquals(auth, `Bearer ${token}`)) return true;
  if (safeTokenEquals(request.headers["x-wildarrange-token"], token)) return true;
  return safeTokenEquals(readCookie(request, "wildarrange_dashboard"), token);
}

function readCookie(request, name) {
  const cookies = String(request.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

function renderDashboardSessionCookie(token) {
  return `wildarrange_dashboard=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`;
}

function safeTokenEquals(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function isAllowedHost(request, configuredHost) {
  const header = request.headers.host;
  if (!header || typeof header !== "string") return false;
  const hostName = parseHostName(header);
  if (!hostName) return false;
  if (isLoopbackHost(configuredHost)) return isLoopbackHost(hostName);
  return hostName === configuredHost;
}

function isSameSiteRequest(request, configuredHost) {
  const fetchSite = String(request.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite === "cross-site") return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const originHost = new URL(origin).hostname;
    if (isLoopbackHost(configuredHost)) return isLoopbackHost(originHost);
    return originHost === configuredHost;
  } catch {
    return false;
  }
}

function parseHostName(header) {
  const value = header.trim();
  if (!value) return "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(1, end) : "";
  }
  return value.split(":")[0];
}

function safeDecodeSegment(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new DashboardBadRequest(`invalid ${label} encoding`);
  }
}

function validateOptionalDashboardId(value, label) {
  if (value === undefined || value === null || value === "") return;
  validateDashboardId(value, label);
}

function validateDashboardId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new DashboardBadRequest(`invalid ${label}`);
  }
}

function validateNodeName(value) {
  if (typeof value !== "string" || !/^[a-z][a-z-]{0,31}$/.test(value)) {
    throw new DashboardBadRequest("invalid node");
  }
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bodyBytes = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      bodyBytes += chunk.length;
      if (bodyBytes > 64_000) {
        settled = true;
        reject(new DashboardPayloadTooLarge("request body too large"));
        return;
      }
      body += chunk.toString();
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function sendHtml(response, statusCode, html, headers = {}) {
  response.writeHead(statusCode, { "content-type": "text/html; charset=utf-8", ...headers });
  response.end(html);
}
