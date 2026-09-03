import http from "node:http";
import { timingSafeEqual } from "node:crypto";
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
  const token = typeof options.token === "string" && options.token.length > 0 ? options.token : process.env.WILDARRANGE_DASHBOARD_TOKEN || "";
  if (!isLoopbackHost(host) && token.length === 0) {
    throw new Error("wildarrange dashboard requires --token or WILDARRANGE_DASHBOARD_TOKEN when binding to a non-loopback host");
  }
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
        sendHtml(response, 200, renderDashboardHtml());
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
  return safeTokenEquals(request.headers["x-wildarrange-token"], token);
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

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
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
    .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 42px; }
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
    .pipeline { display: grid; grid-template-columns: repeat(6,1fr); gap: 7px; padding: 18px 20px; margin-bottom: 22px; border-radius: var(--radius); color: #fff; background: var(--forest); box-shadow: var(--shadow); }
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
    .ops { grid-template-columns:repeat(3,minmax(220px,1fr)); }
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
    .ledger-toolbar { display:grid; grid-template-columns:minmax(180px,1.6fr) repeat(3,minmax(120px,.7fr)); gap:8px; margin-bottom:14px; }
    .ledger-list { display:grid; gap:10px; }
    .ledger-card { padding:16px 18px; border:1px solid var(--line); border-radius:15px; background:#fffdf7; cursor:pointer; }
    .ledger-card-head { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px; align-items:start; }
    .ledger-card h3 { margin:3px 0 6px; font-size:15px; }
    .ledger-card .task-detail { grid-column:auto; padding-top:14px; }
    .ledger-card.expanded .task-detail { display:block; }
    .ticket-meta { display:flex; flex-wrap:wrap; gap:6px 10px; color:var(--muted); font-size:11px; }
    .ticket-type { color:var(--forest); font-weight:800; }
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
    @media (max-width: 980px) { .app{grid-template-columns:76px minmax(0,1fr)} .rail{padding-inline:17px}.brand-text,.nav span,.nav-label,.rail-foot{display:none}.nav button{justify-content:center;padding:12px 0}.hero,.dashboard-grid{grid-template-columns:1fr}.hero-stamp{justify-self:stretch;width:100%}.ops,.two{grid-template-columns:1fr}.ledger-toolbar{grid-template-columns:1fr 1fr} }
    @media (max-width: 640px) { .app{display:block}.rail{position:static;width:100%;height:auto;padding:14px 18px}.rail::after{display:none}.brand{margin:0}.nav,.nav-label,.rail-foot{display:none}.topbar{padding:18px 16px 0}.status-pill,.top-actions .notice{display:none}main{padding:24px 16px 44px}h1{font-size:39px}.pipeline{grid-template-columns:repeat(3,minmax(0,1fr));overflow:hidden}.step:nth-child(3)::after{display:none}.step small{display:block;overflow:hidden;text-overflow:ellipsis}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.task-card{grid-template-columns:44px minmax(0,1fr)}.task-card>.status-badge{display:none}.panel-head{align-items:flex-start}.panel-head .primary{padding-inline:9px;font-size:12px}.route-review-head,.route-review-actions{align-items:flex-start;flex-direction:column} }
  </style>
</head>
<body>
  <div class="app">
    <aside class="rail">
      <div class="brand"><div class="mark">W</div><div class="brand-text"><strong>WildArrange</strong><small>本地智能驾驭系统</small></div></div>
      <div class="nav-label">驾驶舱</div>
      <nav class="nav" aria-label="主导航">
        <button class="active" data-view="overview" data-label="总览"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></svg><span>总览</span></button>
        <button data-view="workitems" data-label="工单总账"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg><span>工单总账</span></button>
        <button data-view="operations" data-label="任务操作"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg><span>任务操作</span></button>
        <button data-view="review" data-label="决策复盘"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 3v18h18"/><path d="M7 16l4-5 4 3 5-7"/></svg><span>决策复盘</span></button>
        <button data-view="logs" data-label="运行与日志"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg><span>运行与日志</span></button>
        ${ADOPTION_NAV_BUTTON}
      </nav>
      <div class="rail-foot"><i></i>本地服务正常 · 127.0.0.1</div>
    </aside>

    <div class="shell">
      <header class="topbar">
        <div class="crumb">项目 / <b>${PRODUCT_NAME}</b> / <span id="viewLabel">总览</span></div>
        <div class="top-actions"><span class="notice" id="notice"></span><input id="dashboardToken" type="password" autocomplete="off" placeholder="API Token（仅当前标签页）"><button id="saveDashboardToken">连接</button><span class="status-pill"><i class="server-dot"></i><span id="gateStatus">正在读取质量门</span></span><button id="refresh">刷新</button></div>
      </header>

      <main>
        <div class="view active" data-view-panel="overview">
          <section class="hero" style="padding:0;border:0;background:transparent;box-shadow:none">
            <div><div class="eyebrow">当前运行状态 · <span id="generatedAt">—</span></div><h1 id="heroTitle">正在读取任务状态。</h1><p id="heroText">正在连接本地 WildArrange 运行时，请稍候。</p></div>
            <div class="hero-stamp"><div class="eyebrow">当前计划</div><strong id="planProgress">0 / 0</strong><small id="subtitle">正在加载</small></div>
          </section>
          <div class="pipeline" id="pipeline">
            <div class="step" data-gate="worker"><div class="step-head"><i class="dot"></i><b>实现</b></div><small>WORKER</small></div>
            <div class="step" data-gate="verify"><div class="step-head"><i class="dot"></i><b>验证</b></div><small>VERIFIER</small></div>
            <div class="step" data-gate="scope"><div class="step-head"><i class="dot"></i><b>范围</b></div><small>SCOPE</small></div>
            <div class="step" data-gate="review"><div class="step-head"><i class="dot"></i><b>复核</b></div><small>REVIEW</small></div>
            <div class="step" data-gate="proof"><div class="step-head"><i class="dot"></i><b>验收</b></div><small>PROOF</small></div>
            <div class="step" data-gate="checkpoint"><div class="step-head"><i class="dot"></i><b>归档</b></div><small>CHECKPOINT</small></div>
          </div>
          <div class="dashboard-grid">
            <div class="stack">
              <section><div class="panel-head"><h2>当前任务</h2><button id="runNext" class="primary">运行下一任务</button></div><div class="task-list" id="tasks"></div></section>
              <div class="metrics" id="metrics"></div>
            </div>
            <div class="stack">
              <section class="attention-panel" id="attentionSection"><div class="eyebrow">需要你处理</div><h2 id="attentionTitle">当前没有异常</h2><div id="attention"></div><button data-jump="operations">查看任务操作</button></section>
              <section><div class="panel-head"><h2>系统健康</h2><button data-jump="logs">查看详情</button></div><div id="healthSummary" class="muted">正在检查</div></section>
            </div>
          </div>
        </div>

        <div class="view" data-view-panel="workitems">
          <h1 class="section-title">工单总账</h1><p class="section-intro">所有 Plan 的新功能、Bug、验收纠错和维护任务都从同一份 <code>.wildarrange/team/tasks.json</code> 读取。</p>
          <div class="metrics" id="ledgerMetrics"></div>
          <section>
            <div class="ledger-toolbar">
              <input id="ledgerSearch" placeholder="搜索编号、标题或原始诉求">
              <select id="ledgerType"><option value="">全部类型</option><option value="feature">新功能</option><option value="bug">Bug</option><option value="acceptance_correction">验收纠错</option><option value="maintenance">维护</option></select>
              <select id="ledgerStatus"><option value="">全部状态</option><option value="draft">待补齐</option><option value="pending">待执行</option><option value="in_progress">执行中</option><option value="verifying">验证中</option><option value="failed">失败</option><option value="completed">已完成</option></select>
              <select id="ledgerPlan"><option value="">全部 Plan</option></select>
            </div>
            <div class="ledger-list" id="ledgerTasks"></div>
          </section>
        </div>

        <div class="view" data-view-panel="operations">
          <h1 class="section-title">任务操作</h1><p class="section-intro">创建、认领和推进任务；复杂操作集中在这里，避免干扰总览。</p>
          <section><div class="grid ops">
            <div class="op-block"><h3>认领任务</h3><div class="form-row"><input id="claimTaskId" placeholder="T001 或留空认领下一个"><input id="claimOwner" placeholder="${DEFAULT_EXECUTOR_AGENT}" value="${DEFAULT_EXECUTOR_AGENT}"></div><button id="claimTask">确认认领</button></div>
            <div class="op-block"><h3>创建工单</h3><input id="taskSubject" placeholder="一句话说明要做什么"><div class="form-row" style="margin-top:8px"><select id="taskWorkType"><option value="feature">新功能</option><option value="bug">Bug</option><option value="acceptance_correction">验收纠错</option><option value="maintenance">维护</option></select><select id="taskPriority"><option value="P0">P0 紧急</option><option value="P1" selected>P1 正常</option><option value="P2">P2 稍后</option></select></div><textarea id="taskDescription" placeholder="原始诉求、复现方式或验收意见"></textarea><input id="taskParent" placeholder="关联原任务，例如 plan_xxx:T001"><input id="taskWritable" placeholder="可写路径，逗号分隔，例如 src/**,test/**" style="margin-top:8px"><textarea id="taskVerify" placeholder="验证命令，每行一条；留空则先保存为 draft"></textarea><textarea id="taskReview" placeholder="独立复核命令，每行一条"></textarea><button id="createTask">创建工单</button></div>
            <div class="op-block"><h3>发送团队消息</h3><div class="form-row"><input id="msgFrom" placeholder="${DEFAULT_LEAD_AGENT}" value="${DEFAULT_LEAD_AGENT}"><input id="msgTo" placeholder="${DEFAULT_EXECUTOR_AGENT}" value="${DEFAULT_EXECUTOR_AGENT}"></div><textarea id="msgBody">继续推进当前任务，完成后等待 verifier 与 review gate。</textarea><div class="form-row"><button id="sendMessage">发送</button><button id="refreshInbox">查看收件箱</button></div></div>
          </div></section>
          <div class="grid two" style="margin-top:22px"><section><div class="panel-head"><h2>变更请求</h2></div><div id="changes"></div></section><section><div class="panel-head"><h2>团队收件箱</h2></div><pre id="inbox"></pre></section></div>
        </div>

        <div class="view" data-view-panel="review">
          <h1 class="section-title">决策复盘</h1><p class="section-intro">检查 Router 为什么这么判断，并用人工标注修正系统认知。</p>
          <div class="stack">${renderPanelsHtml()}</div>
        </div>

        <div class="view" data-view-panel="logs">
          <h1 class="section-title">运行与日志</h1><p class="section-intro">这里保留完整技术证据；日常使用无需逐条阅读。</p>
          <div class="grid two"><section><div class="panel-head"><h2>最新快照</h2></div><pre id="snapshot"></pre></section><section><div class="panel-head"><h2>工作流摘要</h2><button id="generateSummary">重新生成</button></div><pre id="summary"></pre></section></div>
          <section style="margin-top:22px"><div class="panel-head"><h2>可信账本</h2></div><pre id="ledger"></pre></section>
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
    const workTypeLabel = (type) => ({ feature:"新功能",bug:"Bug",acceptance_correction:"验收纠错",maintenance:"维护" })[type] || type || "维护";
    let latestTaskLedger = { tasks: [], plans: [], counts: {}, typeCounts: {} };
    function switchView(name) {
      document.querySelectorAll("[data-view-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === name));
      document.querySelectorAll(".nav [data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
      const source = document.querySelector('.nav [data-view="' + name + '"]');
      el("viewLabel").textContent = source ? source.dataset.label : "总览";
    }
    function updatePipeline(task) {
      const evidence = Array.isArray(task?.evidence) ? task.evidence : [];
      const kinds = new Set(evidence.map((item) => item.kind));
      const complete = task?.status === "completed";
      const done = {
        worker: complete || kinds.has("worker"),
        verify: complete || task?.last_verify_result?.pass === true || evidence.some((item) => item.kind === "verifier" && item.pass),
        scope: complete || kinds.has("scope_guard") || Boolean(task?.last_scope_result),
        review: complete || task?.last_review_result?.pass === true,
        proof: complete || Boolean(task?.acceptance_proof),
        checkpoint: complete || Boolean(task?.checkpointPath || task?.checkpoint_path),
      };
      let activeAssigned = false;
      document.querySelectorAll("#pipeline .step").forEach((step) => {
        const isDone = done[step.dataset.gate] === true;
        step.classList.toggle("done", isDone);
        const active = !isDone && !activeAssigned && Boolean(task);
        step.classList.toggle("active", active);
        if (active) activeAssigned = true;
      });
    }
    async function loadState() {
      const response = await dashboardFetch("/api/state", { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 401 ? "请输入 Dashboard API Token 后连接" : "Dashboard state failed");
      const data = await response.json();
      const status = data.status || {};
      const work = status.work || {};
      const tasks = data.tasks || [];
      const focusTask = tasks.find((task) => task.status !== "completed") || tasks[tasks.length - 1] || null;
      const failed = (status.failed || 0) + (status.review_blocked || 0);
      const waiting = (status.pending || 0) + (status.in_progress || 0) + (status.verifying || 0);
      el("generatedAt").textContent = data.generatedAt ? new Date(data.generatedAt).toLocaleString("zh-CN", { hour12:false }) : "—";
      el("planProgress").textContent = (status.completed ?? 0) + " / " + (status.total ?? 0);
      el("subtitle").textContent = status.total ? "任务完成 · " + (data.attention?.total || 0) + " 项待处理" : "尚未导入计划";
      el("gateStatus").textContent = status.gateArming?.armed ? "所有质量门已武装" : "质量门需要检查";
      if (failed > 0) {
        el("heroTitle").textContent = "任务遇到问题，需要你处理。";
        el("heroText").textContent = "系统已停止继续放行。请查看待处理事项，修复后再重新运行。";
      } else if (waiting > 0) {
        el("heroTitle").textContent = "任务正在推进，一切有据可查。";
        el("heroText").textContent = focusTask ? "当前正在处理：" + focusTask.subject + "。系统会依次经过实现、验证、范围检查和独立复核。" : "当前计划正在推进。";
      } else if ((status.total || 0) > 0) {
        el("heroTitle").textContent = "任务已完成，系统运行正常。";
        el("heroText").textContent = "当前没有需要你处理的异常。最近一次任务已通过验证、范围检查与独立复核，可以安全进入下一项工作。";
      } else {
        el("heroTitle").textContent = "驾驶舱已就绪，等待第一项任务。";
        el("heroText").textContent = "从 IDE 提出需求并导入计划后，这里会显示每一步进展和判断证据。";
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
        return '<article class="task-card"><div class="task-id">' + esc(task.id) + '</div><div><div class="task-title">' + esc(task.subject) + '</div><div class="task-meta">' + esc(workTypeLabel(task.workType)) + ' · ' + esc(task.priority || "P1") + ' · ' + esc(route) + ' · ' + (task.verify_commands || []).length + ' 条验证命令 · 已尝试 ' + esc(task.attempts || 0) + ' 次</div></div><span class="status-badge ' + esc(task.status) + '">' + esc(statusLabel(task.status)) + '</span><div class="task-detail"><div class="grid two"><div><div class="label">验证与复核</div>' + reviewBox(task) + '</div><div><div class="label">失败与操作</div>' + failureBox(task) + actionButtons(task) + '</div></div></div></article>';
      }).join("");
      renderTaskLedger(data.taskLedger || null);
      renderAttention(data.attention || null);
      renderChanges(data.changes || []);
      el("healthSummary").innerHTML = '<div class="health-row"><span>配置基线</span><b>' + (status.gateArming?.armed ? "正常" : "需检查") + '</b></div><div class="health-row"><span>可信账本</span><b>已连接</b></div><div class="health-row"><span>IDE 适配器</span><b>查看体检</b></div>';
      el("snapshot").textContent = JSON.stringify(data.latestSnapshot || {}, null, 2);
      el("summary").textContent = JSON.stringify(data.summary || { status: "No summary generated" }, null, 2);
      el("ledger").textContent = JSON.stringify(data.ledger || [], null, 2);
      loadPanels();
    }
    function renderTaskLedger(ledger) {
      latestTaskLedger = ledger || { tasks: [], plans: [], counts: {}, typeCounts: {} };
      const counts = latestTaskLedger.counts || {};
      const open = (latestTaskLedger.total || 0) - (counts.completed || 0);
      const metrics = [
        ["全部工单", latestTaskLedger.total || 0, ""],
        ["尚未关闭", open, "pending"],
        ["Bug", latestTaskLedger.typeCounts?.bug || 0, "failed"],
        ["验收纠错", latestTaskLedger.typeCounts?.acceptance_correction || 0, "pending"],
      ];
      el("ledgerMetrics").innerHTML = metrics.map(([label, value, cls]) => '<div class="metric"><div class="label">' + label + '</div><div class="value ' + cls + '">' + value + '</div></div>').join("");
      const selectedPlan = el("ledgerPlan").value;
      el("ledgerPlan").innerHTML = '<option value="">全部 Plan</option>' + (latestTaskLedger.plans || []).map((plan) => '<option value="' + esc(plan.id) + '">' + esc(plan.title || plan.id) + '</option>').join("");
      el("ledgerPlan").value = selectedPlan;
      applyTaskLedgerFilters();
    }
    function applyTaskLedgerFilters() {
      const search = el("ledgerSearch").value.trim().toLowerCase();
      const type = el("ledgerType").value;
      const status = el("ledgerStatus").value;
      const planId = el("ledgerPlan").value;
      const plans = new Map((latestTaskLedger.plans || []).map((plan) => [plan.id, plan.title || plan.id]));
      const tasks = (latestTaskLedger.tasks || []).filter((task) => {
        if (type && task.workType !== type) return false;
        if (status && task.status !== status) return false;
        if (planId && task.planId !== planId) return false;
        if (search && !(String(task.id) + "\\n" + String(task.subject) + "\\n" + String(task.description || "") + "\\n" + String(task.request?.summary || "")).toLowerCase().includes(search)) return false;
        return true;
      });
      el("ledgerTasks").innerHTML = tasks.length === 0 ? '<div class="muted">没有符合筛选条件的工单</div>' : tasks.map((task) => renderLedgerTask(task, plans)).join("");
    }
    function renderLedgerTask(task, plans) {
      const history = (task.history || []).slice(-10).reverse();
      const historyHtml = history.length === 0 ? '<div class="muted">尚无历史</div>' : '<div class="history">' + history.map((item) => '<div class="history-row"><span>' + esc(item.at ? new Date(item.at).toLocaleString("zh-CN", { hour12:false }) : "—") + '</span><strong>' + esc(item.event || "event") + '</strong><span>' + esc(historySummary(item)) + '</span></div>').join("") + '</div>';
      const parent = task.parentTaskRef ? '<div><span class="label">关联原任务</span><br><code>' + esc(task.parentTaskRef) + '</code></div>' : '';
      return '<article class="ledger-card"><div class="ledger-card-head"><div><div class="ticket-meta"><span class="ticket-type">' + esc(workTypeLabel(task.workType)) + '</span><span>' + esc(task.priority || "P1") + '</span><span>' + esc(plans.get(task.planId) || task.planId) + '</span><code>' + esc(task.ref || task.id) + '</code></div><h3>' + esc(task.subject) + '</h3><div class="muted">' + esc(task.request?.summary || task.description || "") + '</div></div><span class="status-badge ' + esc(task.status) + '">' + esc(statusLabel(task.status)) + '</span></div><div class="task-detail"><div class="grid two"><div><div class="label">工单信息</div><p>' + esc(task.description || task.subject) + '</p><div class="ticket-meta"><span>来源：' + esc(task.source || "imported") + '</span><span>负责人：' + esc(task.owner || "—") + '</span><span>尝试：' + esc(task.attempts || 0) + '</span></div>' + parent + '</div><div><div class="label">最近历史</div>' + historyHtml + '</div></div></div></article>';
    }
    function historySummary(item) {
      if (item.event === "status_changed") return String(item.from || "") + " → " + String(item.to || "");
      if (item.event === "attempt_changed") return "尝试次数 " + String(item.from || 0) + " → " + String(item.to || 0);
      if (item.event === "owner_changed") return String(item.from || "未分配") + " → " + String(item.to || "未分配");
      if (item.event === "evidence_added") return "新增 " + String(item.count || 0) + " 条证据";
      return item.status ? "状态 " + item.status : "已记录";
    }
    function renderInbox(messages) {
      el("inbox").textContent = JSON.stringify(messages || [], null, 2);
    }
    function renderAttention(attention) {
      if (!attention || attention.total === 0) {
        el("attentionTitle").textContent = "当前没有异常";
        el("attention").innerHTML = '<div class="muted">所有任务都在计划内运行，你现在不需要做任何处理。</div>';
        return;
      }
      el("attentionTitle").innerHTML = "有 " + esc(attention.total) + " 项需要决定";
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
    el("dashboardToken").value = sessionStorage.getItem(DASHBOARD_TOKEN_KEY) || "";
    el("saveDashboardToken").addEventListener("click", async () => {
      const token = el("dashboardToken").value.trim();
      if (token) sessionStorage.setItem(DASHBOARD_TOKEN_KEY, token);
      else sessionStorage.removeItem(DASHBOARD_TOKEN_KEY);
      el("notice").textContent = token ? "Token 已保存在当前标签页" : "Token 已清除";
      try { await loadState(); } catch (error) { el("notice").textContent = error instanceof Error ? error.message : String(error); }
    });
    el("refresh").addEventListener("click", loadState);
    el("runNext").addEventListener("click", () => runAction("运行下一任务", () => postJson("/api/run-next", {})));
    el("claimTask").addEventListener("click", () => {
      const taskId = el("claimTaskId").value.trim();
      const owner = el("claimOwner").value.trim() || "${DEFAULT_EXECUTOR_AGENT}";
      runQuiet("Claim task", () => postJson("/api/tasks/claim", { taskId: taskId || undefined, owner }));
    });
    el("createTask").addEventListener("click", () => {
      const subject = el("taskSubject").value.trim();
      if (!subject) {
        el("notice").textContent = "请先填写工单标题";
        return;
      }
      const splitLines = (value) => value.split(/\\r?\\n/).map((item) => item.trim()).filter(Boolean);
      const task = {
        subject,
        description: el("taskDescription").value.trim() || subject,
        workType: el("taskWorkType").value,
        priority: el("taskPriority").value,
        source: "user",
        parentTaskRef: el("taskParent").value.trim() || null,
        writable_paths: el("taskWritable").value.split(",").map((item) => item.trim()).filter(Boolean),
        verify_commands: splitLines(el("taskVerify").value),
        review_commands: splitLines(el("taskReview").value),
      };
      runQuiet("Create task", () => postJson("/api/tasks/create", task));
    });
    el("sendMessage").addEventListener("click", async () => {
      const payload = await runQuiet("Send message", () => postJson("/api/team/send", {
        from: el("msgFrom").value.trim() || "${DEFAULT_LEAD_AGENT}",
        to: el("msgTo").value.trim() || "${DEFAULT_EXECUTOR_AGENT}",
        body: el("msgBody").value,
      }));
      if (payload && payload.result) {
        await loadInbox(payload.result.to);
      }
    });
    el("refreshInbox").addEventListener("click", () => loadInbox(el("msgTo").value.trim()));
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
    ["ledgerSearch", "ledgerType", "ledgerStatus", "ledgerPlan"].forEach((id) => {
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
