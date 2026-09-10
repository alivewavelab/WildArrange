import http from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  DEFAULT_EXECUTOR_AGENT,
  DEFAULT_LEAD_AGENT,
} from "../infra/agent-registry.mjs";
import { PRODUCT_NAME } from "../infra/runtime-config.mjs";
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
  PANELS_SCRIPT,
  annotateRouteDecision,
  buildDecisionsPanelViewModel,
  buildOpsPanelViewModel,
  buildRouteReviewPanelViewModel,
  renderPanelsHtml,
} from "./dashboard-panels.mjs";
import {
  ADOPTION_NAV_BUTTON,
  ADOPTION_SCRIPT,
  ADOPTION_VIEW_HTML,
  tryHandleAdoptionApi,
} from "./adoption-panel.mjs";

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

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${PRODUCT_NAME} 驾驶舱</title>
  <style>
    :root {
      --ink: #17211d; --muted: #65706a; --paper: #f4f0e7; --panel: #fffdf7;
      --forest: #173d32; --forest-2: #245647; --mint: #bfe6cf; --signal: #ff6b42;
      --gold: #e8b85c; --line: rgba(23,33,29,.13); --good: #278052; --bad: #b43b2f;
      --warn: #a96c12; --shadow: 0 18px 58px rgba(36,44,38,.1); --radius: 20px;
    }
    * { box-sizing: border-box; }
    html { background: var(--paper); }
    body { margin: 0; min-width: 320px; overflow-x:hidden; color: var(--ink); background: radial-gradient(circle at 74% 9%, rgba(232,184,92,.18), transparent 30rem), var(--paper); font: 14px/1.55 "PingFang SC", "Hiragino Sans GB", sans-serif; -webkit-font-smoothing: antialiased; }
    button, input, textarea { font: inherit; }
    button { color: inherit; }
    .app { display: grid; grid-template-columns: 242px minmax(0,1fr); min-height: 100vh; }
    .rail { position: sticky; top: 0; height: 100vh; padding: 28px 22px; color: #eef7f0; background: linear-gradient(rgba(255,255,255,.026) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.026) 1px,transparent 1px),var(--forest); background-size: 22px 22px; overflow: hidden; }
    .rail::after { content: ""; position: absolute; width: 190px; height: 190px; right: -92px; bottom: 82px; border: 1px solid rgba(191,230,207,.2); border-radius: 50%; box-shadow: 0 0 0 24px rgba(191,230,207,.025),0 0 0 48px rgba(191,230,207,.025); }
    .brand { display: flex; align-items: center; gap: 12px; height:52px; margin-bottom: 34px; overflow:hidden; }
    .brand-wordmark { display:block; width:172px; height:52px; object-fit:cover; object-position:center; }
    .mark { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 13px; color: var(--forest); background: var(--mint); font: 800 20px/1 "Iowan Old Style",Georgia,serif; transform: rotate(-5deg); }
    .brand strong { display: block; font: 700 17px/1.1 "Iowan Old Style",Georgia,serif; }
    .brand small { display: block; margin-top: 4px; color: #a9c6b7; font-size: 10px; letter-spacing: .14em; }
    .nav-label,.eyebrow { color: #91b2a2; font-size: 10px; font-weight: 700; letter-spacing: .17em; text-transform: uppercase; }
    .nav { display: grid; gap: 8px; margin-top: 13px; }
    .nav button { display: flex; align-items: center; gap: 11px; width: 100%; padding: 11px 12px; border: 0; border-radius: 12px; color: #bcd0c6; background: transparent; text-align: left; cursor: pointer; transition: .2s ease; }
    .nav button:hover { color: #fff; background: rgba(255,255,255,.06); transform: translateX(2px); }
    .nav button.active { color: #fff; background: rgba(191,230,207,.13); box-shadow: inset 0 0 0 1px rgba(191,230,207,.12); }
    .nav svg { width: 18px; height: 18px; stroke-width: 1.8; }
    .rail-foot { position: absolute; left: 22px; right: 22px; bottom: 24px; padding-top: 18px; border-top: 1px solid rgba(255,255,255,.1); color: #a9c6b7; font-size: 11px; }
    .rail-foot i,.server-dot { display: inline-block; width: 7px; height: 7px; margin-right: 7px; border-radius: 50%; background: #68d59e; box-shadow: 0 0 0 5px rgba(104,213,158,.1); }
    .shell { min-width: 0; }
    .topbar { display: flex; justify-content: space-between; align-items: center; gap: 18px; padding: 24px clamp(24px,4vw,64px) 0; }
    .crumb { color: var(--muted); font-size: 12px; }
    .crumb b { color: var(--ink); }
    .top-actions { display: flex; align-items: center; gap: 9px; }
    .status-pill { display: flex; align-items: center; padding: 8px 12px; border: 1px solid var(--line); border-radius: 99px; background: rgba(255,253,247,.68); font-size: 11px; }
    main { padding: 30px clamp(24px,4vw,64px) 64px; }
    .view { display: none; }
    .view.active { display: block; animation: rise .38s both; }
    .hero { display: grid; grid-template-columns: minmax(0,1.35fr) minmax(250px,.65fr); gap: 28px; align-items: end; margin-bottom: 30px; }
    h1 { max-width: 780px; margin: 8px 0 12px; font: 700 clamp(34px,4.2vw,62px)/1.04 "Songti SC","STSong",serif; letter-spacing: -.045em; }
    .hero p { max-width: 680px; margin: 0; color: var(--muted); line-height: 1.8; }
    .hero-stamp { justify-self: end; width: min(100%,320px); padding: 20px 22px; border: 1px solid var(--line); border-radius: var(--radius); background: rgba(255,253,247,.68); box-shadow: 0 12px 38px rgba(62,72,65,.06); }
    .hero-stamp strong { display: block; margin: 5px 0 3px; font: 700 31px/1 "Iowan Old Style",Georgia,serif; }
    .hero-stamp small { color: var(--muted); }
    .pipeline { display: grid; grid-template-columns: repeat(4,1fr); gap: 7px; padding: 18px 20px; margin-bottom: 22px; border-radius: var(--radius); color: #fff; background: var(--forest); box-shadow: var(--shadow); }
    .step { position: relative; min-width: 0; padding: 9px 8px 8px; opacity: .48; }
    .step:not(:last-child)::after { content:""; position:absolute; top:18px; right:-7px; width:14px; height:1px; background:rgba(255,255,255,.22); }
    .step-head { display:flex; align-items:center; gap:8px; margin-bottom:9px; }
    .dot { width:9px; height:9px; border:2px solid #6e8d7f; border-radius:50%; }
    .step.done,.step.active { opacity: 1; }
    .step.done .dot { border-color:var(--mint); background:var(--mint); box-shadow:0 0 0 5px rgba(191,230,207,.1); }
    .step.active .dot { border-color:var(--gold); background:var(--gold); box-shadow:0 0 0 5px rgba(232,184,92,.13); }
    .step b { display:block; overflow:hidden; font-size:12px; text-overflow:ellipsis; white-space:nowrap; }
    .step small { color:#9ab7a8; font-size:9px; letter-spacing:.05em; }
    .dashboard-grid { display:grid; grid-template-columns:minmax(0,1.42fr) minmax(280px,.58fr); gap:22px; align-items:start; }
    .stack { display:grid; gap:22px; }
    section,.metric { border:1px solid var(--line); border-radius:var(--radius); background:rgba(255,253,247,.88); box-shadow:0 14px 46px rgba(52,61,55,.06); }
    section { padding:20px 22px; }
    .panel-head { display:flex; align-items:center; justify-content:space-between; gap:14px; margin-bottom:14px; }
    h2 { margin:0; font:700 19px/1.2 "Songti SC","STSong",serif; }
    h3 { margin:0 0 10px; font-size:13px; }
    .label { color:var(--muted); font-size:11px; }
    .value { margin-top:3px; font:700 25px/1 "Iowan Old Style",Georgia,serif; }
    .metrics { display:grid; grid-template-columns:repeat(4,minmax(100px,1fr)); gap:10px; margin-bottom:22px; }
    .metric { padding:14px; box-shadow:none; }
    .task-list { display:grid; gap:1px; margin:0 -22px -20px; }
    .task-card { display:grid; grid-template-columns:52px minmax(0,1fr) auto; gap:15px; align-items:center; padding:18px 22px; border-top:1px solid var(--line); background:transparent; }
    .task-id { display:grid; place-items:center; width:45px; height:45px; border:1px solid var(--line); border-radius:14px; color:var(--forest); background:#eef3ec; font:700 12px/1 "Iowan Old Style",Georgia,serif; }
    .task-title { margin-bottom:5px; font-weight:700; }
    .task-meta { color:var(--muted); font-size:11px; }
    .pill,.status-badge { display:inline-flex; align-items:center; padding:4px 8px; border-radius:99px; color:var(--forest-2); background:#e5f3e9; font-size:10px; font-weight:700; }
    .task-detail { grid-column:2/-1; display:none; padding:12px 0 2px; }
    .task-card.expanded .task-detail { display:block; }
    .workspace-list { display:grid; border-top:1px solid var(--line); }
    .workspace-row { display:grid; grid-template-columns:minmax(130px,.8fr) minmax(180px,1.2fr) minmax(180px,1fr) auto; gap:14px; align-items:center; padding:13px 0; border-bottom:1px solid var(--line); }
    .workspace-row:last-child { border-bottom:0; }
    .workspace-row code { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .workspace-empty { padding:18px 0 4px; color:var(--muted); }
    .workspace-chip { color:var(--signal); font-size:10px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
    .attention-panel { color:#fff; background:var(--signal); border:0; }
    .attention-panel h2 { margin:8px 0 7px; font-size:21px; }
    .attention-panel .muted { color:rgba(255,255,255,.78); }
    .attention-panel .eyebrow { color:rgba(255,255,255,.7); }
    .attention-panel button { width:100%; margin-top:15px; color:var(--signal); background:#fff; border-color:#fff; font-weight:800; }
    .health-row { display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-top:1px solid var(--line); font-size:11px; }
    .health-row:first-child { border-top:0; }
    .health-row b { color:var(--good); }
    .grid { display:grid; gap:14px; }
    .two { grid-template-columns:minmax(0,1.35fr) minmax(300px,.65fr); align-items:start; }
    .ops { grid-template-columns:repeat(2,minmax(220px,1fr)); }
    .op-block { min-width:0; padding:15px; border:1px solid var(--line); border-radius:15px; background:#f8f5ed; }
    .label { color: var(--muted); font-size: 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 9px 8px; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; font-size: 12px; }
    code,pre,textarea { font-family:"SFMono-Regular",Menlo,Consolas,monospace; }
    .completed { color: var(--good); }
    .failed { color: var(--bad); }
    .draft, .pending, .verifying, .in_progress, .review_blocked, .needs_user_decision { color: var(--warn); }
    .muted { color: var(--muted); }
    pre { margin:0; overflow:auto; white-space:pre-wrap; word-break:break-word; padding:12px; max-height:460px; border-radius:12px; background:#eef0ea; }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .notice { min-height: 20px; color: var(--muted); font-size: 12px; }
    .form-row { display: flex; gap: 8px; margin-bottom: 8px; }
    input,textarea,select { width:100%; min-width:0; padding:9px 10px; border:1px solid var(--line); border-radius:10px; color:var(--ink); background:#fff; }
    textarea { min-height:92px; resize:vertical; font-size:12px; }
    button { padding:8px 11px; border:1px solid var(--line); border-radius:10px; color:var(--ink); background:#fff; cursor:pointer; transition:.18s ease; }
    button:hover { transform:translateY(-1px); border-color:rgba(23,61,50,.35); }
    button.primary { color:#fff; background:var(--signal); border-color:var(--signal); font-weight:700; }
    button:disabled { cursor: not-allowed; opacity: 0.45; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; min-width: 180px; }
    .actions button { padding: 5px 8px; font-size: 12px; }
    .failure-box { margin-top:6px; padding:9px; border-left:3px solid var(--bad); border-radius:8px; background:#fff0ec; max-width:420px; }
    .review-box { margin-top:6px; padding:9px; border-left:3px solid var(--forest-2); border-radius:8px; background:#eaf2ed; max-width:420px; font-size:12px; }
    .review-box ul { margin: 6px 0 0 18px; padding: 0; }
    .ledger-toolbar { display:grid; grid-template-columns:minmax(180px,1.6fr) repeat(2,minmax(120px,.7fr)); gap:8px; margin-bottom:14px; }
    .decision-filters { display:flex; gap:8px; flex-wrap:wrap; margin:0 0 14px; }
    .decision-filters button { border-radius:999px; background:var(--surface-soft); }
    .decision-filters button.active { color:white; background:var(--ink); border-color:var(--ink); }
    .governance-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; align-items:stretch; }
    .governance-grid > section { height:480px; min-height:480px; display:flex; flex-direction:column; overflow:hidden; }
    .governance-grid > section > button { margin-top:8px; }
    .governance-file-list { display:grid; flex:1; min-height:0; gap:6px; margin-top:12px; padding-right:4px; overflow:auto; align-content:start; }
    .governance-file { width:100%; display:flex; justify-content:space-between; gap:12px; text-align:left; background:#f8f5ed; }
    .section-kicker { margin:22px 0 10px; color:var(--muted); font-size:12px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; }
    .governance-ledger-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:14px; }
    .governance-ledger-grid > section { min-height:210px; display:flex; flex-direction:column; }
    .ledger-card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
    .ledger-card-head h2 { margin-bottom:0; }
    .ledger-count { display:block; margin-top:auto; padding-top:18px; font-size:22px; }
    .ledger-card-foot { min-height:38px; margin-top:14px; display:flex; align-items:center; }
    .log-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; align-items:stretch; }
    .log-grid > section { min-height:210px; }
    .activity-row { display:grid; grid-template-columns:150px minmax(0,1fr) auto; gap:14px; padding:12px 0; border-top:1px solid var(--line); }
    .activity-row:first-child { border-top:0; }
    .activity-row time,.activity-row small { color:var(--muted); }
    .ledger-board { display:grid; grid-template-columns:repeat(4,minmax(230px,1fr)); gap:12px; align-items:start; overflow-x:auto; padding-bottom:8px; }
    .ledger-column { min-width:230px; padding:12px; border:1px solid var(--line); border-radius:17px; background:rgba(231,227,216,.44); }
    .ledger-column-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:10px; }
    .ledger-column-head h2 { margin:0; font-size:15px; }
    .ledger-column-count { display:inline-grid; place-items:center; min-width:25px; height:25px; padding:0 7px; border-radius:99px; background:var(--paper); color:var(--forest); font-weight:900; font-size:11px; }
    .ledger-column-list { display:grid; gap:9px; }
    .ledger-column-empty { padding:18px 8px; text-align:center; color:var(--muted); font-size:12px; }
    .ledger-card { padding:14px; border:1px solid var(--line); border-radius:13px; background:#fffdf7; cursor:pointer; box-shadow:0 5px 14px rgba(25,57,47,.05); }
    .ledger-card-head { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; align-items:start; }
    .ledger-card h3 { margin:3px 0 6px; font-size:15px; }
    .ledger-card .task-detail { grid-column:auto; padding-top:14px; }
    .ledger-card.expanded .task-detail { display:block; }
    .ticket-meta { display:flex; flex-wrap:wrap; gap:6px 10px; color:var(--muted); font-size:11px; }
    .ticket-type { color:var(--forest); font-weight:800; }
    .attention-chip { display:inline-flex; align-items:center; padding:3px 7px; border-radius:99px; color:#9f2f1c; background:#ffe2da; font-size:10px; font-weight:900; }
    .history { display:grid; gap:7px; margin-top:8px; }
    .history-row { display:grid; grid-template-columns:150px 120px minmax(0,1fr); gap:10px; padding:7px 0; border-top:1px dashed var(--line); font-size:11px; }
    .route-review-shell {
      position: relative;
      overflow: hidden;
      color: #edf7f1;
      border: 0;
      background: radial-gradient(circle at 88% -20%, #2f6956 0, transparent 42%), var(--forest);
      box-shadow: var(--shadow);
    }
    .route-review-shell::before { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .13; background-image: linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px); background-size: 28px 28px; }
    .route-review-shell > * { position: relative; }
    .route-review-head { display: flex; justify-content: space-between; gap: 18px; align-items: end; margin-bottom: 16px; }
    .route-review-head h2 { font-size: 22px; margin: 2px 0 3px; letter-spacing: -.02em; }
    .route-review-head .muted { color: #a9c6b7; }
    .route-review-head input { color-scheme:dark; background:#21483c; color:#edf7f1; border-color:#4a7465; }
    .route-review-head button { color:var(--forest); background:var(--mint); border-color:var(--mint); font-weight:700; }
    .route-review-shell .eyebrow { color:var(--mint); }
    .route-review-stats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
    .route-review-stats span { padding: 6px 10px; border: 1px solid #354963; border-radius: 999px; background: rgba(13, 23, 38, .75); }
    .route-daily-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin: 14px 0 10px; padding: 10px 12px; border: 1px solid #355a69; border-radius: 10px; background: rgba(20, 51, 62, .7); }
    .route-daily-summary code { color: var(--mint); }
    .route-review-list { display: grid; gap: 10px; max-height: 760px; overflow: auto; padding-right: 4px; }
    .route-review-card { border: 1px solid #30435d; border-left: 4px solid #6685ac; border-radius: 8px; padding: 13px; background: rgba(13, 23, 38, .92); }
    .route-review-card.route-ok { border-left-color: #51d6a6; }
    .route-review-card.route-issue { border-left-color: #ff806c; }
    .route-review-meta { display: flex; gap: 10px; flex-wrap: wrap; color: #8fa3bf; font-size: 11px; }
    .route-request { margin: 10px 0; font-size: 16px; font-weight: 650; color: #fff; white-space: pre-wrap; }
    .route-result { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
    .route-result strong { padding:4px 9px; border-radius:5px; color:var(--forest); background:var(--mint); text-transform:uppercase; }
    .route-result span, .signal-chip { padding: 3px 7px; border: 1px solid #405675; border-radius: 5px; color: #c5d3e7; font-size: 12px; }
    .route-reason, .route-semantic { margin-top: 8px; color: #aebed4; font-size: 12px; }
    .signal-row { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-left: 6px; }
    .signal-chip { border-color:#618b64; color:var(--mint); }
    .route-tools { margin-top: 10px; border-top: 1px solid #293b55; padding-top: 9px; }
    .route-tools summary { cursor: pointer; color: #c8d6e8; }
    .route-tool { margin-top: 7px; padding: 8px; border-radius: 5px; background: #16243a; font-size: 12px; }
    .route-tool-stage { color: #73b5ff; margin-right: 7px; }
    .route-tool pre { margin-top: 7px; background: #0d1726; color: #dce8f8; max-height: 180px; }
    .route-review-actions { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 12px; }
    .route-review-actions button { margin-left: 5px; background: transparent; border-color: #425976; color: #dbe7f7; font-size: 12px; }
    .route-review-actions button:hover { border-color:var(--mint); color:var(--mint); }
    .review-state { color: #9fb0c8; font-size: 12px; }
    .route-empty { padding: 28px; text-align: center; border: 1px dashed #405675; color: #9fb0c8; }
    .failure-box pre {
      background: transparent;
      padding: 0;
      max-height: 160px;
      font-size: 12px;
    }
    .section-title { margin:0 0 18px; font:700 30px/1.1 "Songti SC","STSong",serif; }
    .section-intro { margin:-8px 0 22px; color:var(--muted); }
    .danger-count { display:inline-grid; place-items:center; min-width:20px; height:20px; padding:0 6px; margin-left:7px; border-radius:99px; color:#fff; background:var(--signal); font-size:10px; }
    @keyframes rise { from { opacity:0; transform:translateY(12px); } to { opacity:1; transform:translateY(0); } }
    @media (max-width: 980px) { .app{grid-template-columns:76px minmax(0,1fr)} .rail{padding-inline:17px}.brand-text,.nav span,.nav-label,.rail-foot{display:none}.nav button{justify-content:center;padding:12px 0}.hero,.dashboard-grid{grid-template-columns:1fr}.hero-stamp{justify-self:stretch;width:100%}.ops,.two,.log-grid{grid-template-columns:1fr}.governance-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.governance-ledger-grid{grid-template-columns:1fr}.ledger-toolbar{grid-template-columns:1fr 1fr} }
    @media (max-width: 640px) { .governance-grid{grid-template-columns:1fr}.activity-row{grid-template-columns:1fr;gap:4px} }
    /* Grid workbench theme: information hierarchy comes from rules and spacing. */
    :root { --ink:#141412; --muted:#6d6b64; --paper:#f2efe8; --panel:#f8f5ee; --forest:#171715; --forest-2:#262622; --mint:#d3482f; --signal:#d3482f; --gold:#d3482f; --line:#cbc6ba; --good:#24704d; --bad:#bd3528; --warn:#a56519; --shadow:none; --radius:0; }
    body { background:var(--paper); font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif; }
    .app { grid-template-columns:204px minmax(0,1fr); }
    .rail { padding:22px 18px; background:#171715; border-right:1px solid #353531; }
    .rail::after { display:none; }
    .nav button { border-radius:0; border-left:2px solid transparent; }
    .nav button:hover { transform:none; background:#22221f; }
    .nav button.active { color:#fff; background:#242421; border-left-color:var(--signal); box-shadow:none; }
    .topbar { min-height:64px; padding:0 clamp(24px,3vw,48px); border-bottom:1px solid var(--line); }
    main { padding:38px clamp(24px,3vw,48px) 64px; }
    .hero { grid-template-columns:minmax(0,1fr) 240px; align-items:stretch; gap:0; margin-bottom:0; border-top:1px solid var(--ink)!important; border-bottom:1px solid var(--ink)!important; }
    .hero>div:first-child { padding:28px 26px 30px 0; }
    h1 { font-family:Arial,"PingFang SC",sans-serif; font-weight:900; font-size:clamp(40px,5vw,72px); letter-spacing:-.06em; }
    h2,.section-title { font-family:Arial,"PingFang SC",sans-serif; font-weight:800; }
    .hero-stamp { width:auto; padding:25px 22px; border:0; border-left:1px solid var(--ink); background:transparent; box-shadow:none; }
    .hero-stamp strong { font-family:Arial,sans-serif; font-size:38px; }
    .pipeline { gap:0; margin:0 0 22px; padding:0; border-radius:0; color:var(--ink); background:transparent; border-bottom:1px solid var(--ink); box-shadow:none; }
    .step { padding:16px 14px; opacity:.58; border-right:1px solid var(--line); }
    .step:first-child { border-left:1px solid var(--ink); }
    .step:last-child { border-right:1px solid var(--ink); }
    .step:not(:last-child)::after { display:none; }
    .step small { color:var(--muted); }
    .step.done,.step.active { background:#ebe6dc; }
    section,.metric,.op-block { border-radius:0; background:var(--panel); box-shadow:none; }
    .attention-panel { background:var(--signal); }
    .task-id { border-radius:0; color:var(--ink); background:transparent; }
    .pill,.status-badge,.attention-chip { border-radius:0; }
    button,input,textarea,select,pre,.governance-file { border-radius:0; box-shadow:none; }
    button:hover { transform:none; border-color:var(--ink); }
    .ledger-column,.ledger-card { border-radius:0; box-shadow:none; }
    .ledger-board { gap:1px; background:var(--line); }
    .ledger-column { border:0; background:var(--panel); }
    .workspace-row code { font-size:11px; }
    @media (max-width: 900px) { .workspace-row{grid-template-columns:minmax(100px,.7fr) minmax(150px,1.3fr)}.workspace-row code{grid-column:span 1}.dashboard-grid{grid-template-columns:1fr} }
    @media (max-width: 640px) { .app{display:block}.rail{position:static;width:100%;height:auto;padding:10px 16px}.brand{margin:0}.brand-wordmark{width:150px}.nav,.nav-label,.rail-foot{display:none}.topbar{padding:14px 16px}.status-pill,.top-actions .notice{display:none}main{padding:24px 16px 44px}h1{font-size:39px}.hero{grid-template-columns:1fr}.hero-stamp{border-left:0;border-top:1px solid var(--ink)}.pipeline{grid-template-columns:repeat(2,minmax(0,1fr));overflow:hidden}.step small{display:block;overflow:hidden;text-overflow:ellipsis}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.task-card{grid-template-columns:44px minmax(0,1fr)}.task-card>.status-badge{display:none}.panel-head{align-items:flex-start}.panel-head .primary{padding-inline:9px;font-size:12px}.route-review-head,.route-review-actions{align-items:flex-start;flex-direction:column}.workspace-row{grid-template-columns:1fr}.workspace-row code{grid-column:auto} }
  </style>
</head>
<body>
  <div class="app">
    <aside class="rail">
      <div class="brand"><img class="brand-wordmark" src="/dashboard-assets/wordmark.png" alt="WildArrange"></div>
      <div class="nav-label">驾驶舱</div>
      <nav class="nav" aria-label="主导航">
        <button class="active" data-view="overview" data-label="总览"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg><span>总览</span></button>
        <button data-view="workitems" data-label="工单总账"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg><span>工单总账</span></button>
        <button data-view="review" data-label="决策复盘"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 3v18h18"/><path d="M7 16l4-5 4 3 5-7"/></svg><span>决策复盘</span></button>
        <button data-view="logs" data-label="运行与日志"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg><span>运行与日志</span></button>
        ${ADOPTION_NAV_BUTTON}
      </nav>
      <div class="rail-foot"><i></i>本地服务正常 · 127.0.0.1</div>
    </aside>

    <div class="shell">
      <header class="topbar">
        <div class="crumb">项目 / <b>${PRODUCT_NAME}</b> / <span id="viewLabel">总览</span></div>
        <div class="top-actions"><span class="notice" id="notice"></span><span class="status-pill"><i class="server-dot"></i><span id="gateStatus">正在读取质量门</span></span><button id="refresh">刷新</button></div>
      </header>

      <main>
        <div class="view active" data-view-panel="overview">
          <section class="hero" style="padding:0;border:0;background:transparent;box-shadow:none">
            <div><div class="eyebrow">当前运行状态 · <span id="generatedAt">—</span></div><h1 id="heroTitle">${PRODUCT_NAME}</h1><p id="heroText">正在读取项目状态。</p></div>
            <div class="hero-stamp"><div class="eyebrow">当前计划</div><strong id="planProgress">0 / 0</strong><small id="subtitle">正在加载</small></div>
          </section>
          <div class="pipeline" id="pipeline">
            <div class="step" data-stage="not-started"><div class="step-head"><i class="dot"></i><b>未开始</b></div><small>等待推进</small></div>
            <div class="step" data-stage="developing"><div class="step-head"><i class="dot"></i><b>开发中</b></div><small>正在实现</small></div>
            <div class="step" data-stage="accepting"><div class="step-head"><i class="dot"></i><b>验收中</b></div><small>自动检查</small></div>
            <div class="step" data-stage="passed"><div class="step-head"><i class="dot"></i><b>已通过</b></div><small>完成</small></div>
          </div>
          <div class="dashboard-grid">
            <div class="stack">
              <section><div class="panel-head"><h2>当前任务</h2><button id="runNext" class="primary">继续推进</button></div><div class="task-list" id="tasks"></div></section>
              <section><div class="panel-head"><div><h2>活动工作区</h2><div class="muted">每项工作显示自己的分支与目录，不用一个分支代表整个项目。</div></div></div><div id="activeWorkspaces"></div></section>
              <div class="metrics" id="metrics"></div>
            </div>
            <div class="stack">
              <section class="attention-panel" id="attentionSection"><div class="eyebrow">运行提醒</div><h2 id="attentionTitle">当前运行正常</h2><div id="attention"></div></section>
              <section><div class="panel-head"><h2>系统健康</h2><button data-jump="logs">查看详情</button></div><div id="healthSummary" class="muted">正在检查</div></section>
            </div>
          </div>
        </div>

        <div class="view" data-view-panel="workitems">
          <h1 class="section-title">工单总账</h1><p class="section-intro">按推进阶段查看所有 Plan 的工单；点击卡片可展开证据和最近历史。</p>
          <div class="metrics" id="ledgerMetrics"></div>
          <section>
            <div class="ledger-toolbar">
              <input id="ledgerSearch" placeholder="搜索编号、标题或原始诉求">
              <select id="ledgerType"><option value="">全部路线</option><option value="feature">功能开发</option><option value="bug">故障修复</option><option value="acceptance_correction">验收返工</option><option value="maintenance">项目维护</option></select>
              <select id="ledgerPlan"><option value="">全部 Plan</option></select>
            </div>
            <div class="ledger-board" id="ledgerTasks"></div>
          </section>
        </div>

        <div class="view" data-view-panel="review">
          <h1 class="section-title">决策复盘</h1><p class="section-intro">查看系统为什么选择路线、允许操作、通过检查或合入成果。</p>
          <div class="stack">${renderPanelsHtml()}</div>
        </div>

        <div class="view" data-view-panel="logs">
          <h1 class="section-title">运行记录</h1><p class="section-intro">用时间顺序说明系统现在怎样、最近做了什么；技术原始数据按需展开。</p>
          <div class="log-grid"><section><div class="panel-head"><h2>当前运行状态</h2></div><div id="snapshot"></div><details><summary>查看技术快照</summary><pre id="snapshotRaw"></pre></details></section><section><div class="panel-head"><h2>最近一次执行</h2><button id="generateSummary">重新生成</button></div><div id="summary"></div><details><summary>查看技术摘要</summary><pre id="summaryRaw"></pre></details></section></div>
          <section style="margin-top:22px"><div class="panel-head"><div><h2>操作历史</h2><div class="muted">按时间记录系统实际完成的关键动作。</div></div></div><div class="decision-filters" id="runFilters"><button class="active" data-run-category="all">全部</button><button data-run-category="task">任务进展</button><button data-run-category="quality">测试复核</button><button data-run-category="admission">成果合入</button><button data-run-category="recovery">异常恢复</button></div><div id="ledger"></div><details><summary>查看防篡改原始记录</summary><pre id="ledgerRaw"></pre></details></section>
        </div>
${ADOPTION_VIEW_HTML}
      </main>
    </div>
  </div>
  <script>
    const DASHBOARD_TOKEN_KEY = "wildarrange.dashboard.token";
    const el = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    if (location.hash.startsWith("#adoption?")) {
      const token = new URLSearchParams(location.hash.slice(location.hash.indexOf("?") + 1)).get("token") || "";
      if (token) sessionStorage.setItem(DASHBOARD_TOKEN_KEY, token);
      history.replaceState(null, "", location.pathname + location.search + "#adoption");
    }
    function dashboardFetch(url, options = {}) {
      const headers = new Headers(options.headers || {});
      const token = sessionStorage.getItem(DASHBOARD_TOKEN_KEY) || "";
      if (token) headers.set("authorization", "Bearer " + token);
      return fetch(url, { ...options, headers });
    }
    const statusLabel = (status) => ({ draft:"待补齐",completed:"已完成",pending:"待执行",in_progress:"执行中",verifying:"验证中",failed:"失败",review_blocked:"复核阻断",needs_user_decision:"等待决定" })[status] || status || "未知";
    const workTypeLabel = (type) => ({ feature:"功能开发",bug:"故障修复",acceptance_correction:"验收返工",maintenance:"项目维护" })[type] || type || "项目维护";
    const routeWorkType = (task) => {
      const route = task.route_decision || {};
      const text = [route.intent, route.domain, route.route, ...(route.matchedSignals || [])].join(" ").toLowerCase();
      if (/acceptance|验收|correction|rework/.test(text)) return "acceptance_correction";
      if (/debug|bug|故障|报错|修复|error/.test(text)) return "bug";
      if (/feature|新增|功能|implement|plan/.test(text)) return "feature";
      return "maintenance";
    };
    const WORKFLOW_STAGES = [
      { id:"not-started", label:"未开始", statuses:["draft", "pending"] },
      { id:"developing", label:"开发中", statuses:["in_progress"] },
      { id:"accepting", label:"验收中", statuses:["verifying", "review_blocked", "needs_user_decision", "failed"] },
      { id:"passed", label:"已通过", statuses:["completed"] },
    ];
    let latestTaskLedger = { tasks: [], plans: [], counts: {}, typeCounts: {} };
    let activeWorkspacesByTask = new Map();
    let latestRunData = null;
    let runCategory = "all";
    function switchView(name) {
      document.querySelectorAll("[data-view-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === name));
      document.querySelectorAll(".nav [data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
      const source = document.querySelector('.nav [data-view="' + name + '"]');
      el("viewLabel").textContent = source ? source.dataset.label : "总览";
    }
    function updatePipeline(task) {
      const stage = task ? WORKFLOW_STAGES.find((item) => item.statuses.includes(task.status))?.id : null;
      const order = WORKFLOW_STAGES.map((item) => item.id);
      const activeIndex = stage ? order.indexOf(stage) : -1;
      document.querySelectorAll("#pipeline .step").forEach((step) => {
        const index = order.indexOf(step.dataset.stage);
        const isDone = activeIndex >= 0 && index < activeIndex || stage === "passed" && index === activeIndex;
        step.classList.toggle("done", isDone);
        const active = Boolean(task) && index === activeIndex && stage !== "passed";
        step.classList.toggle("active", active);
      });
    }
    async function loadState() {
      const response = await dashboardFetch("/api/state", { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 401 ? "此页面未获得访问权限，请从项目所在设备重新打开 Dashboard" : "Dashboard state failed");
      const data = await response.json();
      const status = data.status || {};
      const work = status.work || {};
      const tasks = data.tasks || [];
      activeWorkspacesByTask = new Map((data.activeWorkspaces || []).map((workspace) => [workspace.taskId, workspace]));
      const focusTask = tasks.find((task) => task.status !== "completed") || tasks[tasks.length - 1] || null;
      const failed = (status.failed || 0) + (status.review_blocked || 0);
      const waiting = (status.pending || 0) + (status.in_progress || 0) + (status.verifying || 0);
      el("generatedAt").textContent = data.generatedAt ? new Date(data.generatedAt).toLocaleString("zh-CN", { hour12:false }) : "—";
      el("planProgress").textContent = (status.completed ?? 0) + " / " + (status.total ?? 0);
      el("subtitle").textContent = status.total ? "任务完成 · " + (data.attention?.total || 0) + " 项待处理" : "尚未导入计划";
      el("gateStatus").textContent = status.gateArming?.armed ? "所有质量门已武装" : "质量门需要检查";
      el("heroTitle").textContent = "${PRODUCT_NAME}";
      if (failed > 0) {
        el("heroText").textContent = "当前有 " + failed + " 项任务遇到阻断。";
      } else if (waiting > 0) {
        el("heroText").textContent = focusTask ? "正在推进：" + focusTask.subject : "当前计划正在推进。";
      } else if ((status.total || 0) > 0) {
        el("heroText").textContent = "当前计划已完成。";
      } else {
        el("heroText").textContent = "当前没有进行中的任务。";
      }
      updatePipeline(focusTask);
      const metrics = [
        ["全部任务", status.total ?? 0, ""],
        ["已经完成", status.completed ?? 0, "completed"],
        ["正在推进", waiting, "pending"],
        ["需要处理", failed + (status.needs_user_decision || 0) + (status.openChanges || 0), "failed"],
      ];
      el("metrics").innerHTML = metrics.map(([label, value, cls]) => '<div class="metric"><div class="label">' + label + '</div><div class="value ' + cls + '">' + value + '</div></div>').join("");
      el("tasks").innerHTML = tasks.length === 0 ? '<div class="muted" style="padding:18px 22px;border-top:1px solid var(--line)">还没有任务</div>' : tasks.map((task) => {
        const route = task.route_decision ? task.route_decision.route + " → " + task.route_decision.primaryAgent : "尚未路由";
        const workspace = activeWorkspacesByTask.get(task.id);
        const workspaceMeta = workspace ? ' · ' + esc(workspace.branch || "独立工作区（detached）") + ' · ' + esc(workspace.workDir || "") : task.coordination?.branch ? ' · ' + esc(task.coordination.branch) : '';
        return '<article class="task-card"><div class="task-id">' + esc(task.id) + '</div><div><div class="task-title">' + esc(task.subject) + '</div><div class="task-meta">' + esc(workTypeLabel(task.workType)) + ' · ' + esc(task.priority || "P1") + ' · ' + esc(route) + workspaceMeta + ' · ' + (task.verify_commands || []).length + ' 条验证命令 · 已尝试 ' + esc(task.attempts || 0) + ' 次</div></div><span class="status-badge ' + esc(task.status) + '">' + esc(statusLabel(task.status)) + '</span><div class="task-detail"><div class="grid two"><div><div class="label">验证与复核</div>' + reviewBox(task) + '</div><div><div class="label">失败与操作</div>' + failureBox(task) + actionButtons(task) + '</div></div></div></article>';
      }).join("");
      renderActiveWorkspaces(data.activeWorkspaces || []);
      renderTaskLedger(data.taskLedger || null);
      renderAttention(data.attention || null);
      renderChanges(data.changes || []);
      const health = data.health || {};
      const healthLabel = (check) => check?.status === "pass" ? "正常" : check?.status === "fail" ? "需处理 · 查看体检" : check?.status === "unchecked" ? "未检查 · 查看体检" : "未知 · 查看体检";
      el("healthSummary").innerHTML = '<div class="health-row"><span>配置基线</span><b>' + healthLabel(health.configBaseline) + '</b></div><div class="health-row"><span>可信账本</span><b>' + healthLabel(health.ledger) + '</b></div><div class="health-row"><span>IDE 适配器</span><b>查看体检</b></div>';
      renderRunHistory(data);
      loadPanels();
    }
    function renderActiveWorkspaces(workspaces) {
      el("activeWorkspaces").innerHTML = workspaces.length === 0
        ? '<div class="workspace-empty">当前没有独立工作区。任务进入并行执行后，会在这里显示各自的目录与分支。</div>'
        : '<div class="workspace-list">' + workspaces.map((workspace) => '<div class="workspace-row"><div><span class="workspace-chip">' + esc(workspace.agent || "Agent") + '</span><strong style="display:block">' + esc(workspace.taskId) + '</strong></div><div><strong>' + esc(workspace.subject) + '</strong></div><code title="' + esc(workspace.branch || "") + '">' + esc(workspace.branch || "独立工作区（detached）") + '</code><code title="' + esc(workspace.workDir || "") + '">' + esc(workspace.workDir || "—") + '</code></div>').join("") + '</div>';
    }
    function renderRunHistory(data) {
      latestRunData = data;
      const status = data.status || {};
      const active = status.work;
      el("snapshot").innerHTML = active
        ? '<h3>' + esc(active.subject || active.taskId || "任务正在运行") + '</h3><p class="muted">当前阶段：' + esc(active.status || "处理中") + '</p>'
        : '<h3>当前没有正在运行的任务</h3><p class="muted">系统处于空闲状态，新任务进入后会在这里显示当前阶段。</p>';
      el("snapshotRaw").textContent = JSON.stringify(data.latestSnapshot || {}, null, 2);
      const summary = data.summary;
      el("summary").innerHTML = summary
        ? '<h3>' + esc(summary.title || summary.reason || "最近一次执行已有总结") + '</h3><p class="muted">' + esc(summary.summary || summary.status || "详细结果可在下方展开查看。") + '</p>'
        : '<h3>还没有执行总结</h3><p class="muted">完成一次任务后，这里会概括做了什么、是否通过以及停在哪里。</p>';
      el("summaryRaw").textContent = JSON.stringify(summary || {}, null, 2);
      const records = (data.ledger || []).slice(-30).reverse().filter((record) => runCategory === "all" || ledgerEventCategory(record.type || record.kind || record.event) === runCategory);
      el("ledger").innerHTML = records.length ? records.map((record) => {
        const when = record.ts || record.at || record.createdAt || "—";
        const what = ledgerEventLabel(record.type || record.kind || record.event);
        const target = record.taskId ? "工单 " + record.taskId : record.planId ? "计划 " + record.planId : "系统";
        return '<div class="activity-row"><time>' + esc(when === "—" ? when : new Date(when).toLocaleString("zh-CN", { hour12:false })) + '</time><div><strong>' + esc(what) + '</strong><div class="muted">' + esc(target) + '</div></div><small>' + esc(record.status || record.decision || "已记录") + '</small></div>';
      }).join("") : '<div class="muted">还没有操作历史。</div>';
      el("ledgerRaw").textContent = JSON.stringify(data.ledger || [], null, 2);
    }
    function ledgerEventLabel(value) {
      const key = String(value || "");
      if (/completed|checkpoint/.test(key)) return "任务完成并入账";
      if (/verify/.test(key)) return "测试与验证";
      if (/review/.test(key)) return "独立复核";
      if (/route/.test(key)) return "选择处理路线";
      if (/admission|integrat/.test(key)) return "成果合入";
      if (/fail|rollback/.test(key)) return "执行失败或回滚";
      if (/plan/.test(key)) return "计划更新";
      return key ? key.replaceAll("_", " ") : "系统操作";
    }
    function ledgerEventCategory(value) {
      const key = String(value || "");
      if (/fail|rollback|recover|error|block/.test(key)) return "recovery";
      if (/admission|integrat|push|commit/.test(key)) return "admission";
      if (/verify|review|scope|acceptance|checkpoint/.test(key)) return "quality";
      return "task";
    }
    function renderTaskLedger(ledger) {
      latestTaskLedger = ledger || { tasks: [], plans: [], counts: {}, typeCounts: {} };
      const tasks = latestTaskLedger.tasks || [];
      const metrics = WORKFLOW_STAGES.map((stage) => [stage.label, tasks.filter((task) => stage.statuses.includes(task.status)).length, stage.id === "passed" ? "completed" : "pending"]);
      el("ledgerMetrics").innerHTML = metrics.map(([label, value, cls]) => '<div class="metric"><div class="label">' + label + '</div><div class="value ' + cls + '">' + value + '</div></div>').join("");
      const selectedPlan = el("ledgerPlan").value;
      el("ledgerPlan").innerHTML = '<option value="">全部 Plan</option>' + (latestTaskLedger.plans || []).map((plan) => '<option value="' + esc(plan.id) + '">' + esc(plan.title || plan.id) + '</option>').join("");
      el("ledgerPlan").value = selectedPlan;
      applyTaskLedgerFilters();
    }
    function applyTaskLedgerFilters() {
      const search = el("ledgerSearch").value.trim().toLowerCase();
      const type = el("ledgerType").value;
      const planId = el("ledgerPlan").value;
      const plans = new Map((latestTaskLedger.plans || []).map((plan) => [plan.id, plan.title || plan.id]));
      const tasks = (latestTaskLedger.tasks || []).filter((task) => {
        if (type && routeWorkType(task) !== type) return false;
        if (planId && task.planId !== planId) return false;
        if (search && !(String(task.id) + "\\n" + String(task.subject) + "\\n" + String(task.description || "") + "\\n" + String(task.request?.summary || "")).toLowerCase().includes(search)) return false;
        return true;
      });
      el("ledgerTasks").innerHTML = WORKFLOW_STAGES.map((stage) => {
        const stageTasks = tasks.filter((task) => stage.statuses.includes(task.status));
        const cards = stageTasks.length === 0
          ? '<div class="ledger-column-empty">暂无工单</div>'
          : stageTasks.map((task) => renderLedgerTask(task, plans)).join("");
        return '<section class="ledger-column" data-stage="' + stage.id + '"><div class="ledger-column-head"><h2>' + stage.label + '</h2><span class="ledger-column-count">' + stageTasks.length + '</span></div><div class="ledger-column-list">' + cards + '</div></section>';
      }).join("");
    }
    function renderLedgerTask(task, plans) {
      const history = (task.history || []).slice(-10).reverse();
      const historyHtml = history.length === 0 ? '<div class="muted">尚无历史</div>' : '<div class="history">' + history.map((item) => '<div class="history-row"><span>' + esc(item.at ? new Date(item.at).toLocaleString("zh-CN", { hour12:false }) : "—") + '</span><strong>' + esc(item.event || "event") + '</strong><span>' + esc(historySummary(item)) + '</span></div>').join("") + '</div>';
      const parent = task.parentTaskRef ? '<div><span class="label">关联原任务</span><br><code>' + esc(task.parentTaskRef) + '</code></div>' : '';
      const needsAttention = ["failed", "review_blocked", "needs_user_decision"].includes(task.status);
      const workspace = activeWorkspacesByTask.get(task.id);
      const workspaceHtml = workspace || task.coordination?.branch ? '<div class="ticket-meta"><span>分支：' + esc(workspace?.branch || task.coordination?.branch || "独立工作区（detached）") + '</span>' + (workspace?.workDir ? '<code>' + esc(workspace.workDir) + '</code>' : '') + '</div>' : '';
      return '<article class="ledger-card"><div class="ledger-card-head"><div><div class="ticket-meta"><span class="ticket-type">' + esc(workTypeLabel(routeWorkType(task))) + '</span><span>' + esc(task.priority || "P1") + '</span><span>' + esc(plans.get(task.planId) || task.planId) + '</span><code>' + esc(task.ref || task.id) + '</code></div><h3>' + esc(task.subject) + '</h3><div class="muted">' + esc(task.request?.summary || task.description || "") + '</div>' + workspaceHtml + '</div><div>' + (needsAttention ? '<span class="attention-chip">需处理</span>' : '') + '<span class="status-badge ' + esc(task.status) + '">' + esc(statusLabel(task.status)) + '</span></div></div><div class="task-detail"><div class="grid two"><div><div class="label">工单信息</div><p>' + esc(task.description || task.subject) + '</p><div class="ticket-meta"><span>来源：' + esc(task.source || "imported") + '</span><span>负责人：' + esc(task.owner || "—") + '</span><span>尝试：' + esc(task.attempts || 0) + '</span></div>' + parent + '</div><div><div class="label">最近历史</div>' + historyHtml + '</div></div></div></article>';
    }
    function historySummary(item) {
      if (item.event === "status_changed") return String(item.from || "") + " → " + String(item.to || "");
      if (item.event === "attempt_changed") return "尝试次数 " + String(item.from || 0) + " → " + String(item.to || 0);
      if (item.event === "owner_changed") return String(item.from || "未分配") + " → " + String(item.to || "未分配");
      if (item.event === "evidence_added") return "新增 " + String(item.count || 0) + " 条证据";
      return item.status ? "状态 " + item.status : "已记录";
    }
    function renderInbox(messages) {
      if (el("inbox")) el("inbox").textContent = JSON.stringify(messages || [], null, 2);
    }
    function renderAttention(attention) {
      if (!attention || attention.total === 0) {
        el("attentionTitle").textContent = "当前运行正常";
        el("attention").innerHTML = '<div class="muted">没有失败、阻断或需要回到 AI 对话处理的事项。</div>';
        return;
      }
      el("attentionTitle").innerHTML = "有 " + esc(attention.total) + " 项运行提醒";
      const blocks = [];
      for (const change of attention.openChanges || []) {
        blocks.push('<div class="failure-box"><strong>越界审批 ' + esc(change.id) + '</strong> · 任务 ' + esc(change.taskId) +
          '<div class="muted">越界文件: ' + esc((change.deniedPaths || []).join(", ") || "(unknown)") + '</div>' +
          '<pre>' + esc(change.resolveHint || "") + '</pre></div>');
      }
      for (const task of attention.failedTasks || []) {
        blocks.push('<div class="failure-box"><strong>失败任务 ' + esc(task.id) + '</strong> · ' + esc(task.subject) +
          '<div class="muted">原因: ' + esc(task.reason) + (task.reportMdPath ? ' · ' + esc(task.reportMdPath) : '') + '</div>' +
          (task.retryHint ? '<pre>' + esc(task.retryHint) + '</pre>' : '') + '</div>');
      }
      for (const task of attention.needsUserDecision || []) {
        blocks.push('<div class="review-box"><strong>等待决策 ' + esc(task.id) + '</strong> · ' + esc(task.subject) +
          '<div class="muted">状态: ' + esc(task.status) + '</div></div>');
      }
      for (const task of attention.draftTasks || []) {
        blocks.push('<div class="review-box"><strong>待补齐工单 ' + esc(task.id) + '</strong> · ' + esc(task.subject) +
          '<div class="muted">' + esc(workTypeLabel(task.workType)) + ' · ' + esc(task.priority || "P1") + '</div>' +
          '<pre>' + esc(task.readyHint || "") + '</pre></div>');
      }
      for (const item of attention.awaitingAcceptance || []) {
        blocks.push('<div class="review-box"><strong>子 Agent 待验收</strong> · 任务 ' + esc(item.taskId) + ' · ' + esc(item.agent || "") +
          '<div class="muted">' + esc(item.resultPath || "") + '</div>' +
          '<pre>' + esc(item.admitHint || "") + '</pre></div>');
      }
      el("attention").innerHTML = blocks.join("");
    }
    function renderChanges(changes) {
      if (!el("changes")) return;
      const openChanges = changes.filter((change) => change.status === "open");
      el("changes").innerHTML = openChanges.length === 0 ? '<div class="muted">没有待处理的变更请求</div>' : '<table><thead><tr><th>编号</th><th>任务</th><th>越界路径</th><th>报告</th></tr></thead><tbody>' + openChanges.map((change) => {
        return '<tr><td><strong>' + esc(change.id) + '</strong></td><td>' + esc(change.taskId) + '<br><span class="muted">' + esc(change.subject) + '</span></td><td>' + esc((change.deniedPaths || []).join(", ")) + '</td><td><span class="muted">' + esc(change.reportMdPath || "") + '</span></td></tr>';
      }).join("") + '</tbody></table>';
    }
    function actionButtons(task) {
      if (task.status === "completed") return '<span class="muted">Done</span>';
      if (task.status === "draft") return '<span class="muted">补齐范围、验证命令和验收标准后才能执行</span>';
      if (task.status === "failed") {
        if (task.last_failure && task.last_failure.reason === "scope_guard_failed") {
          return '<span class="muted">Change request required</span>';
        }
        return '<button data-node="retry" data-task="' + esc(task.id) + '">Retry</button>';
      }
      const buttons = [];
      if (task.status === "pending" || task.status === "in_progress") {
        buttons.push('<button data-node="execute" data-task="' + esc(task.id) + '">Execute</button>');
      }
      if (task.status === "verifying" || task.status === "in_progress") {
        buttons.push('<button data-node="verify" data-task="' + esc(task.id) + '">Verify</button>');
        buttons.push('<button data-node="scope" data-task="' + esc(task.id) + '">Scope</button>');
        buttons.push('<button data-node="review" data-task="' + esc(task.id) + '">Review</button>');
        buttons.push('<button data-node="checkpoint" data-task="' + esc(task.id) + '">Checkpoint</button>');
      }
      return '<div class="actions">' + buttons.join("") + '</div>';
    }
    function failureBox(task) {
      if (!task.last_failure) return '<span class="muted">没有失败记录</span>';
      const report = task.last_failure.reportMdPath ? '<div class="muted">' + esc(task.last_failure.reportMdPath) + '</div>' : "";
      return '<div class="failure-box"><pre>' + esc(task.last_failure.retryHint || task.last_failure.reason) + '</pre>' + report + '</div>';
    }
    function reviewBox(task) {
      const review = task.last_review_result;
      if (!review) return '<span class="muted">尚未运行独立复核</span>';
      const lanes = (review.lanes || []).map((lane) => '<li><strong>' + esc(lane.status) + '</strong> ' + esc(lane.name) + ' · ' + esc(lane.agent) + '</li>').join("");
      const report = review.reportMdPath ? '<div class="muted">' + esc(review.reportMdPath) + '</div>' : "";
      return '<div class="review-box"><strong>' + (review.pass ? 'PASS' : 'FAIL') + '</strong><ul>' + lanes + '</ul>' + report + '</div>';
    }
    async function postJson(url, body) {
      const headers = { "content-type": "application/json" };
      const response = await dashboardFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body || {}),
      });
      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || "Action failed");
      }
      return payload;
    }
    async function runAction(label, fn) {
      if (!confirm(label + "?")) return;
      el("notice").textContent = "Running " + label + "...";
      try {
        await fn();
        el("notice").textContent = label + " completed";
        await loadState();
      } catch (error) {
        el("notice").textContent = error instanceof Error ? error.message : String(error);
      }
    }
    async function runQuiet(label, fn) {
      el("notice").textContent = "Running " + label + "...";
      try {
        const payload = await fn();
        el("notice").textContent = label + " completed";
        await loadState();
        return payload;
      } catch (error) {
        el("notice").textContent = error instanceof Error ? error.message : String(error);
        return null;
      }
    }
    document.querySelectorAll(".nav [data-view], [data-jump]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view || button.dataset.jump)));
    el("runFilters").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-run-category]");
      if (!button) return;
      runCategory = button.dataset.runCategory;
      el("runFilters").querySelectorAll("button").forEach((item) => item.classList.toggle("active", item === button));
      if (latestRunData) renderRunHistory(latestRunData);
    });
    el("refresh").addEventListener("click", loadState);
    el("runNext").addEventListener("click", () => runAction("运行下一任务", () => postJson("/api/run-next", {})));
    el("generateSummary").addEventListener("click", () => runQuiet("Generate summary", () => postJson("/api/summary", {})));
    el("tasks").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-node]");
      if (!button) {
        const card = event.target.closest(".task-card");
        if (card) card.classList.toggle("expanded");
        return;
      }
      const node = button.dataset.node;
      const taskId = button.dataset.task;
      runAction(node + " " + taskId, () => postJson("/api/node/" + encodeURIComponent(node), { taskId }));
    });
    ["ledgerSearch", "ledgerType", "ledgerPlan"].forEach((id) => {
      el(id).addEventListener(id === "ledgerSearch" ? "input" : "change", applyTaskLedgerFilters);
    });
    el("ledgerTasks").addEventListener("click", (event) => {
      const card = event.target.closest(".ledger-card");
      if (card) card.classList.toggle("expanded");
    });
    async function loadInbox(agent) {
      const query = agent ? "?agent=" + encodeURIComponent(agent) : "";
      const response = await dashboardFetch("/api/team/inbox" + query, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || "Inbox failed");
      }
      renderInbox(payload.result);
      return payload;
    }
    ${ADOPTION_SCRIPT}
    ${PANELS_SCRIPT}
    loadState();
  </script>
</body>
</html>`;
}
