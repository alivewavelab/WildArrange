import http from "node:http";
import {
  claimTeamTask,
  createTeamTask,
  dashboardData,
  getTeamTask,
  listTeamMessages,
  listTeamTasks,
  runNextTask,
  runWorkflowNode,
  sendTeamMessage,
  writeWorkflowSummary,
} from "./helix-core.mjs";

export function startDashboardServer(rootDir, options = {}) {
  const host = options.host || "127.0.0.1";
  const port = Number.isInteger(options.port) ? options.port : 8765;
  const token = typeof options.token === "string" && options.token.length > 0 ? options.token : process.env.HELIX_DASHBOARD_TOKEN || "";
  const requireAuth = !isLoopbackHost(host) || token.length > 0;
  if (!isLoopbackHost(host) && token.length === 0) {
    throw new Error("helix dashboard requires --token or HELIX_DASHBOARD_TOKEN when binding to a non-loopback host");
  }
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${host}:${port}`);
      if (requireAuth && url.pathname.startsWith("/api/") && !isAuthorized(request, token)) {
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
        const taskId = decodeURIComponent(url.pathname.slice("/api/tasks/".length));
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
        const nodeName = url.pathname.slice("/api/node/".length);
        if (!["execute", "verify", "scope", "review", "checkpoint", "retry"].includes(nodeName)) {
          sendJson(response, 400, { ok: false, error: `unsupported node: ${nodeName}` });
          return;
        }
        const body = await readJsonBody(request);
        const result = await runWorkflowNode(rootDir, nodeName, { taskId: body.taskId });
        sendJson(response, 200, { ok: true, result });
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        sendHtml(response, 200, renderDashboardHtml());
        return;
      }
      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
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

function isAuthorized(request, token) {
  if (!token) return false;
  const auth = request.headers.authorization || "";
  if (auth === `Bearer ${token}`) return true;
  return request.headers["x-helix-token"] === token;
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

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HelixFlow Runtime</title>
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
    .failure-box pre {
      background: transparent;
      padding: 0;
      max-height: 160px;
      font-size: 12px;
    }
    @media (max-width: 860px) {
      .metrics, .two { grid-template-columns: 1fr; }
      header { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>HelixFlow Runtime</h1>
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
    <section>
      <h2>Operations</h2>
      <div class="grid ops">
        <div class="op-block">
          <h3>Task Claim</h3>
          <div class="form-row">
            <input id="claimTaskId" placeholder="T001 或留空认领下一个">
            <input id="claimOwner" placeholder="Atlas" value="Atlas">
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
            <input id="msgFrom" placeholder="Sisyphus" value="Sisyphus">
            <input id="msgTo" placeholder="Atlas" value="Atlas">
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
  </main>
  <script>
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
      renderChanges(data.changes || []);
      el("snapshot").textContent = JSON.stringify(data.latestSnapshot || {}, null, 2);
      el("summary").textContent = JSON.stringify(data.summary || { status: "No summary generated" }, null, 2);
      el("ledger").textContent = JSON.stringify(data.ledger || [], null, 2);
    }
    function renderInbox(messages) {
      el("inbox").textContent = JSON.stringify(messages || [], null, 2);
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
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
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
      const owner = el("claimOwner").value.trim() || "Atlas";
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
        from: el("msgFrom").value.trim() || "Sisyphus",
        to: el("msgTo").value.trim() || "Atlas",
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
    loadState();
  </script>
</body>
</html>`;
}
