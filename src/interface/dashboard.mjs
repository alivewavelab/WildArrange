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

class DashboardBadRequest extends Error {}

export function startDashboardServer(rootDir, options = {}) {
  const host = options.host || "127.0.0.1";
  const port = Number.isInteger(options.port) ? options.port : 8765;
  const token = typeof options.token === "string" && options.token.length > 0 ? options.token : process.env.HELIX_DASHBOARD_TOKEN || "";
  if (!isLoopbackHost(host) && token.length === 0) {
    throw new Error("helix dashboard requires --token or HELIX_DASHBOARD_TOKEN when binding to a non-loopback host");
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
          status: url.searchParams.get("status") || undefined,
          owner: url.searchParams.get("owner") || undefined,
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
      if (url.pathname === "/" || url.pathname === "/index.html") {
        sendHtml(response, 200, renderDashboardHtml({ token }));
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error instanceof DashboardBadRequest) {
        sendJson(response, 400, { ok: false, error: error.message });
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
  return safeTokenEquals(request.headers["x-helix-token"], token);
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
    request.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 64_000) {
        reject(new Error("request body too large"));
      }
    });
    request.on("end", () => {
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
    request.on("error", reject);
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

function renderDashboardHtml(options = {}) {
  const dashboardToken = typeof options.token === "string" ? options.token : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${PRODUCT_NAME} Runtime</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --ink: #1d2430;
      --muted: #667085;
      --line: #d9dee7;
      --good: #0f8a5f;
      --bad: #b42318;
      --warn: #b54708;
      --accent: #1457d9;
      --soft: #eef4ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      padding: 18px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    h1 { font-size: 18px; margin: 0; }
    main { padding: 20px 24px 28px; max-width: 1280px; margin: 0 auto; }
    .grid { display: grid; gap: 14px; }
    .metrics { grid-template-columns: repeat(8, minmax(120px, 1fr)); }
    .two { grid-template-columns: minmax(0, 1.35fr) minmax(360px, 0.65fr); align-items: start; }
    section, .metric {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    section { padding: 14px; }
    .metric { padding: 12px; min-height: 70px; }
    .label { color: var(--muted); font-size: 12px; }
    .value { font-size: 24px; font-weight: 650; margin-top: 4px; }
    h2 { font-size: 14px; margin: 0 0 12px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 9px 8px; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; font-size: 12px; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 2px 8px; background: #eef2ff; color: var(--accent); font-size: 12px; }
    .completed { color: var(--good); }
    .failed { color: var(--bad); }
    .pending, .verifying, .in_progress, .review_blocked, .needs_user_decision { color: var(--warn); }
    .muted { color: var(--muted); }
    pre {
      margin: 0;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      background: #f1f3f7;
      border-radius: 6px;
      padding: 10px;
      max-height: 460px;
    }
    .toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .notice { min-height: 20px; color: var(--muted); font-size: 12px; }
    .ops { grid-template-columns: repeat(3, minmax(220px, 1fr)); }
    .op-block {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fbfcfe;
      min-width: 0;
    }
    .op-block h3 { margin: 0 0 10px; font-size: 13px; }
    .form-row { display: flex; gap: 8px; margin-bottom: 8px; }
    input, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 7px 9px;
      background: #fff;
      color: var(--ink);
      font: inherit;
      min-width: 0;
    }
    textarea { min-height: 92px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    button {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      border-radius: 6px;
      padding: 7px 10px;
      cursor: pointer;
    }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button:disabled { cursor: not-allowed; opacity: 0.45; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; min-width: 180px; }
    .actions button { padding: 5px 8px; font-size: 12px; }
    .failure-box {
      margin-top: 6px;
      padding: 8px;
      border-left: 3px solid var(--bad);
      background: #fff4f2;
      border-radius: 4px;
      max-width: 360px;
    }
    .review-box {
      margin-top: 6px;
      padding: 8px;
      border-left: 3px solid var(--accent);
      background: var(--soft);
      border-radius: 4px;
      max-width: 360px;
      font-size: 12px;
    }
    .review-box ul { margin: 6px 0 0 18px; padding: 0; }
    .route-review-shell {
      position: relative;
      overflow: hidden;
      color: #edf4ff;
      border: 1px solid #2c4263;
      background: radial-gradient(circle at 88% -20%, #244f7d 0, transparent 42%), #101827;
      box-shadow: 0 18px 55px rgba(16, 24, 39, 0.18);
    }
    .route-review-shell::before { content: ""; position: absolute; inset: 0; pointer-events: none; opacity: .13; background-image: linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px); background-size: 28px 28px; }
    .route-review-shell > * { position: relative; }
    .route-review-head { display: flex; justify-content: space-between; gap: 18px; align-items: end; margin-bottom: 16px; }
    .route-review-head h2 { font-size: 22px; margin: 2px 0 3px; letter-spacing: -.02em; }
    .route-review-head .muted { color: #9fb0c8; }
    .route-review-head input { color-scheme: dark; background: #17243a; color: #edf4ff; border-color: #3d526f; }
    .route-review-head button { background: #d7ff53; border-color: #d7ff53; color: #142012; font-weight: 700; }
    .eyebrow { color: #d7ff53; letter-spacing: .14em; font: 700 10px/1.2 ui-monospace, monospace; }
    .route-review-stats { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
    .route-review-stats span { padding: 6px 10px; border: 1px solid #354963; border-radius: 999px; background: rgba(13, 23, 38, .75); }
    .route-review-list { display: grid; gap: 10px; max-height: 760px; overflow: auto; padding-right: 4px; }
    .route-review-card { border: 1px solid #30435d; border-left: 4px solid #6685ac; border-radius: 8px; padding: 13px; background: rgba(13, 23, 38, .92); }
    .route-review-card.route-ok { border-left-color: #51d6a6; }
    .route-review-card.route-issue { border-left-color: #ff806c; }
    .route-review-meta { display: flex; gap: 10px; flex-wrap: wrap; color: #8fa3bf; font-size: 11px; }
    .route-request { margin: 10px 0; font-size: 16px; font-weight: 650; color: #fff; white-space: pre-wrap; }
    .route-result { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
    .route-result strong { padding: 4px 9px; border-radius: 5px; color: #142012; background: #d7ff53; text-transform: uppercase; }
    .route-result span, .signal-chip { padding: 3px 7px; border: 1px solid #405675; border-radius: 5px; color: #c5d3e7; font-size: 12px; }
    .route-reason, .route-semantic { margin-top: 8px; color: #aebed4; font-size: 12px; }
    .signal-row { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-left: 6px; }
    .signal-chip { border-color: #596b2f; color: #d7ff53; }
    .route-tools { margin-top: 10px; border-top: 1px solid #293b55; padding-top: 9px; }
    .route-tools summary { cursor: pointer; color: #c8d6e8; }
    .route-tool { margin-top: 7px; padding: 8px; border-radius: 5px; background: #16243a; font-size: 12px; }
    .route-tool-stage { color: #73b5ff; margin-right: 7px; }
    .route-tool pre { margin-top: 7px; background: #0d1726; color: #dce8f8; max-height: 180px; }
    .route-review-actions { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 12px; }
    .route-review-actions button { margin-left: 5px; background: transparent; border-color: #425976; color: #dbe7f7; font-size: 12px; }
    .route-review-actions button:hover { border-color: #d7ff53; color: #d7ff53; }
    .review-state { color: #9fb0c8; font-size: 12px; }
    .route-empty { padding: 28px; text-align: center; border: 1px dashed #405675; color: #9fb0c8; }
    .failure-box pre {
      background: transparent;
      padding: 0;
      max-height: 160px;
      font-size: 12px;
    }
    @media (max-width: 860px) {
      .metrics, .two { grid-template-columns: 1fr; }
      header { align-items: flex-start; flex-direction: column; }
      .route-review-head, .route-review-actions { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${PRODUCT_NAME} Runtime</h1>
      <div class="muted" id="subtitle">loading</div>
    </div>
    <div class="toolbar">
      <span class="notice" id="notice"></span>
      <button class="primary" id="runNext">Run next</button>
      <button id="refresh">Refresh</button>
    </div>
  </header>
  <main class="grid">
    <div class="grid metrics" id="metrics"></div>
    <section id="attentionSection">
      <h2>Needs Attention / 待你处理</h2>
      <div id="attention"></div>
    </section>
    <section>
      <h2>Operations</h2>
      <div class="grid ops">
        <div class="op-block">
          <h3>Task Claim</h3>
          <div class="form-row">
            <input id="claimTaskId" placeholder="T001 或留空认领下一个">
            <input id="claimOwner" placeholder="${DEFAULT_EXECUTOR_AGENT}" value="${DEFAULT_EXECUTOR_AGENT}">
          </div>
          <button id="claimTask">Claim</button>
        </div>
        <div class="op-block">
          <h3>Task Create</h3>
          <textarea id="taskJson">{"id":"T002","subject":"新增一个可验证任务","description":"追加计划内任务","blockedBy":["T001"],"worker_command":"node -e \\"process.exit(0)\\"","verify_commands":["node -e \\"process.exit(0)\\""]}</textarea>
          <button id="createTask">Create</button>
        </div>
        <div class="op-block">
          <h3>Team Message</h3>
          <div class="form-row">
            <input id="msgFrom" placeholder="${DEFAULT_LEAD_AGENT}" value="${DEFAULT_LEAD_AGENT}">
            <input id="msgTo" placeholder="${DEFAULT_EXECUTOR_AGENT}" value="${DEFAULT_EXECUTOR_AGENT}">
          </div>
          <textarea id="msgBody">继续推进当前任务，完成后等待 verifier 与 review gate。</textarea>
          <div class="form-row">
            <button id="sendMessage">Send</button>
            <button id="refreshInbox">Inbox</button>
          </div>
        </div>
      </div>
    </section>
    <div class="grid two">
      <section>
        <h2>Tasks</h2>
        <div id="tasks"></div>
      </section>
      <section>
        <h2>Latest Snapshot</h2>
        <pre id="snapshot"></pre>
      </section>
    </div>
    <section>
      <h2>ChangeRequests</h2>
      <div id="changes"></div>
    </section>
    <section>
      <h2>Team Inbox</h2>
      <pre id="inbox"></pre>
    </section>
    <section>
      <div class="toolbar" style="justify-content: space-between; margin-bottom: 10px;">
        <h2 style="margin: 0;">Workflow Summary</h2>
        <button id="generateSummary">Generate</button>
      </div>
      <pre id="summary"></pre>
    </section>
    <section>
      <h2>Ledger</h2>
      <pre id="ledger"></pre>
    </section>
    ${renderPanelsHtml()}
  </main>
  <script>
    const DASHBOARD_TOKEN = ${JSON.stringify(dashboardToken)};
    const el = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    async function loadState() {
      const response = await fetch("/api/state", { cache: "no-store" });
      const data = await response.json();
      const status = data.status || {};
      const work = status.work || {};
      el("subtitle").textContent = [work.workId, status.planId, data.generatedAt].filter(Boolean).join(" | ");
      const metrics = [
        ["Total", status.total ?? 0, ""],
        ["Completed", status.completed ?? 0, "completed"],
        ["Pending", status.pending ?? 0, "pending"],
        ["Verifying", status.verifying ?? 0, "verifying"],
        ["Failed", status.failed ?? 0, "failed"],
        ["Review Blocked", status.review_blocked ?? 0, "pending"],
        ["Needs User", status.needs_user_decision ?? 0, "pending"],
        ["Open Changes", status.openChanges ?? 0, "failed"],
      ];
      el("metrics").innerHTML = metrics.map(([label, value, cls]) => '<div class="metric"><div class="label">' + label + '</div><div class="value ' + cls + '">' + value + '</div></div>').join("");
      const tasks = data.tasks || [];
      el("tasks").innerHTML = tasks.length === 0 ? '<div class="muted">No tasks</div>' : '<table><thead><tr><th>ID</th><th>Status</th><th>Route</th><th>Category</th><th>Skills</th><th>Verify</th><th>Review</th><th>Failure</th><th>Controls</th></tr></thead><tbody>' + tasks.map((task) => {
        const route = task.route_decision ? esc(task.route_decision.route + " -> " + task.route_decision.primaryAgent) : "";
        const skills = Array.isArray(task.skills) ? task.skills.map((skill) => '<span class="pill">' + esc(skill) + '</span>').join(" ") : "";
        return '<tr><td><strong>' + esc(task.id) + '</strong><br><span class="muted">' + esc(task.subject) + '</span></td><td class="' + esc(task.status) + '">' + esc(task.status) + '</td><td>' + route + '</td><td>' + esc(task.category) + '<br><span class="muted">' + esc(task.category_source) + '</span></td><td>' + skills + '</td><td><code>' + esc((task.verify_commands || []).join(" && ")) + '</code></td><td>' + reviewBox(task) + '</td><td>' + failureBox(task) + '</td><td>' + actionButtons(task) + '</td></tr>';
      }).join("") + '</tbody></table>';
      renderAttention(data.attention || null);
      renderChanges(data.changes || []);
      el("snapshot").textContent = JSON.stringify(data.latestSnapshot || {}, null, 2);
      el("summary").textContent = JSON.stringify(data.summary || { status: "No summary generated" }, null, 2);
      el("ledger").textContent = JSON.stringify(data.ledger || [], null, 2);
      loadPanels();
    }
    function renderInbox(messages) {
      el("inbox").textContent = JSON.stringify(messages || [], null, 2);
    }
    function renderAttention(attention) {
      if (!attention || attention.total === 0) {
        el("attention").innerHTML = '<div class="muted">没有等待你处理的事项 / Nothing is waiting on you.</div>';
        return;
      }
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
      for (const item of attention.awaitingAcceptance || []) {
        blocks.push('<div class="review-box"><strong>子 Agent 待验收</strong> · 任务 ' + esc(item.taskId) + ' · ' + esc(item.agent || "") +
          '<div class="muted">' + esc(item.resultPath || "") + '</div>' +
          '<pre>' + esc(item.admitHint || "") + '</pre></div>');
      }
      el("attention").innerHTML = blocks.join("");
    }
    function renderChanges(changes) {
      const openChanges = changes.filter((change) => change.status === "open");
      el("changes").innerHTML = openChanges.length === 0 ? '<div class="muted">No open change requests</div>' : '<table><thead><tr><th>ID</th><th>Task</th><th>Denied Paths</th><th>Report</th></tr></thead><tbody>' + openChanges.map((change) => {
        return '<tr><td><strong>' + esc(change.id) + '</strong></td><td>' + esc(change.taskId) + '<br><span class="muted">' + esc(change.subject) + '</span></td><td>' + esc((change.deniedPaths || []).join(", ")) + '</td><td><span class="muted">' + esc(change.reportMdPath || "") + '</span></td></tr>';
      }).join("") + '</tbody></table>';
    }
    function actionButtons(task) {
      if (task.status === "completed") return '<span class="muted">Done</span>';
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
      if (!task.last_failure) return '<span class="muted">None</span>';
      const report = task.last_failure.reportMdPath ? '<div class="muted">' + esc(task.last_failure.reportMdPath) + '</div>' : "";
      return '<div class="failure-box"><pre>' + esc(task.last_failure.retryHint || task.last_failure.reason) + '</pre>' + report + '</div>';
    }
    function reviewBox(task) {
      const review = task.last_review_result;
      if (!review) return '<span class="muted">Not run</span>';
      const lanes = (review.lanes || []).map((lane) => '<li><strong>' + esc(lane.status) + '</strong> ' + esc(lane.name) + ' · ' + esc(lane.agent) + '</li>').join("");
      const report = review.reportMdPath ? '<div class="muted">' + esc(review.reportMdPath) + '</div>' : "";
      return '<div class="review-box"><strong>' + (review.pass ? 'PASS' : 'FAIL') + '</strong><ul>' + lanes + '</ul>' + report + '</div>';
    }
    async function postJson(url, body) {
      const headers = { "content-type": "application/json" };
      if (DASHBOARD_TOKEN) headers.authorization = "Bearer " + DASHBOARD_TOKEN;
      const response = await fetch(url, {
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
    el("refresh").addEventListener("click", loadState);
    el("runNext").addEventListener("click", () => runAction("Run next", () => postJson("/api/run-next", {})));
    el("claimTask").addEventListener("click", () => {
      const taskId = el("claimTaskId").value.trim();
      const owner = el("claimOwner").value.trim() || "${DEFAULT_EXECUTOR_AGENT}";
      runQuiet("Claim task", () => postJson("/api/tasks/claim", { taskId: taskId || undefined, owner }));
    });
    el("createTask").addEventListener("click", () => {
      let task;
      try {
        task = JSON.parse(el("taskJson").value);
      } catch {
        el("notice").textContent = "Task JSON is invalid";
        return;
      }
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
      if (!button) return;
      const node = button.dataset.node;
      const taskId = button.dataset.task;
      runAction(node + " " + taskId, () => postJson("/api/node/" + encodeURIComponent(node), { taskId }));
    });
    async function loadInbox(agent) {
      const query = agent ? "?agent=" + encodeURIComponent(agent) : "";
      const response = await fetch("/api/team/inbox" + query, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || "Inbox failed");
      }
      renderInbox(payload.result);
      return payload;
    }
    ${PANELS_SCRIPT}
    loadState();
  </script>
</body>
</html>`;
}
