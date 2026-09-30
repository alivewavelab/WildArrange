// =============================================================================
// 文件名称：dashboard-view.mjs
// 所属模块：interface
// 作用说明：
//   生成本地 Dashboard 单页 HTML（布局、内嵌客户端脚本；样式见 dashboard-styles.mjs）。
//   通过 fetch /api/* 与 dashboard.mjs 通信；不持有服务端状态。
//
// 【运行原理速读】
//   可以把它想成「驾驶舱的前端壳」：
//
//   · 谁调用？
//     dashboard.mjs 在 GET / 时 sendHtml(renderDashboardHtml())。
//
//   · 它做了什么？
//     ① 拼接五视图（总览/工单/复盘/日志/治理）② 内嵌 loadState 等客户端逻辑
//     ③ 嵌入 adoption-panel 与 dashboard-panels 的 HTML/JS 片段。
//
//   · 约束？
//     模板字符串内的 JS 不能含反引号与 ${}（除模板插值）；token 存 sessionStorage。
// =============================================================================
import { DASHBOARD_CSS } from "./dashboard-styles.mjs";
import { PRODUCT_NAME } from "../infra/runtime-config.mjs";
import { WORKFLOW_STAGES } from "../infra/task-predicates.mjs";
import {
  PANELS_SCRIPT,
  renderPanelsHtml,
} from "./dashboard-panels.mjs";
import {
  ADOPTION_NAV_BUTTON,
  ADOPTION_SCRIPT,
  ADOPTION_VIEW_HTML,
} from "./adoption-panel-view.mjs";

/**
 * 返回完整 Dashboard 单页 HTML 字符串（含 CSS 与内嵌 script）。
 * @param {string} [projectName] 当前受治理项目的显示名称。
 * @returns {string}
 */
export function renderDashboardHtml(projectName = PRODUCT_NAME) {
  const displayProjectName = typeof projectName === "string" && projectName.trim() ? projectName.trim() : PRODUCT_NAME;
  const projectNameHtml = escapeHtml(displayProjectName);
  const projectNameScriptValue = JSON.stringify(displayProjectName)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  // 状态→阶段映射的唯一来源在 infra/task-predicates；页面脚本只渲染，不自带副本。
  const workflowStagesScriptValue = JSON.stringify(WORKFLOW_STAGES).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${projectNameHtml} · ${PRODUCT_NAME} 驾驶舱</title>
  <style>
${DASHBOARD_CSS}
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
        <div class="crumb">项目 / <b>${projectNameHtml}</b> / <span id="viewLabel">总览</span></div>
        <div class="top-actions"><span class="notice" id="notice"></span><span class="status-pill"><i class="server-dot"></i><span id="gateStatus">正在读取质量门</span></span><button id="refresh">刷新</button></div>
      </header>

      <main>
        <div class="view active" data-view-panel="overview">
          <section class="hero" style="padding:0;border:0;background:transparent;box-shadow:none">
            <div><div class="eyebrow">当前运行状态 · <span id="generatedAt">—</span></div><h1 id="heroTitle">${projectNameHtml}</h1><p id="heroText">正在读取项目状态。</p></div>
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
    // --- 客户端引导：token 与 fetch 封装 ---
    const DASHBOARD_TOKEN_KEY = "wildarrange.dashboard.token";
    const DASHBOARD_PROJECT_NAME = ${projectNameScriptValue};
    const el = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    const dashboardHashMatch = location.hash.match(/^#(adoption|approvals|archives)\?/);
    if (dashboardHashMatch) {
      const token = new URLSearchParams(location.hash.slice(location.hash.indexOf("?") + 1)).get("token") || "";
      if (token) sessionStorage.setItem(DASHBOARD_TOKEN_KEY, token);
      history.replaceState(null, "", location.pathname + location.search + "#" + dashboardHashMatch[1]);
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
    const WORKFLOW_STAGES = ${workflowStagesScriptValue};
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
    // --- 总览状态加载与渲染 ---
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
      el("heroTitle").textContent = DASHBOARD_PROJECT_NAME;
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
        return '<article class="task-card"><div class="task-id">' + esc(task.id) + '</div><div><div class="task-title">' + esc(task.subject) + '</div><div class="task-meta">' + esc(workTypeLabel(task.workType)) + ' · ' + esc(task.priority || "P1") + ' · ' + esc(route) + workspaceMeta + ' · ' + (task.verify_commands || []).length + ' 条验证命令 · 已尝试 ' + esc(task.attempts || 0) + ' 次</div></div><span class="status-badge ' + esc(task.status) + '">' + esc(statusLabel(task.status)) + '</span><div class="task-detail"><div class="grid two"><div><div class="label">验证与复核</div>' + responsibilityBox(task) + reviewBox(task) + '</div><div><div class="label">失败与操作</div>' + failureBox(task) + actionButtons(task) + '</div></div></div></article>';
      }).join("");
      renderActiveWorkspaces(data.activeWorkspaces || []);
      renderTaskLedger(data.taskLedger || null);
      renderAttention(data.attention || null);
      const health = data.health || {};
      const healthLabel = (check) => check?.status === "pass" ? "正常" : check?.status === "fail" ? "需处理 · 查看体检" : check?.status === "unchecked" ? "未检查 · 查看体检" : "未知 · 查看体检";
      el("healthSummary").innerHTML = '<div class="health-row"><span>配置基线</span><b>' + healthLabel(health.configBaseline) + '</b></div><div class="health-row"><span>可信账本</span><b>' + healthLabel(health.ledger) + '</b></div><div class="health-row"><span>IDE 适配器</span><b>查看体检</b></div>';
      renderRunHistory(data);
      loadPanels();
    }
    function responsibilityBox(task) {
      const changes = task.responsibilityChanges || [];
      if (!changes.length) return '<div class="muted">旧任务未声明职责与事实变化</div>';
      return '<details><summary>职责与事实变更</summary>' + changes.map((change) => '<p><strong>' + esc(change.script) + '</strong><br>新增：' + esc(change.additions) + '<br>职责：' + esc(change.responsibilityBefore) + ' → ' + esc(change.responsibilityAfter) + '<br>事实：' + (change.facts || []).map((fact) => esc(fact.name) + '：' + esc(fact.ownerBefore || '无') + ' → ' + esc(fact.ownerAfter || '无') + '；' + esc(fact.access)).join('<br>') + '</p>').join('') + '</details>';
    }
    function renderActiveWorkspaces(workspaces) {
      el("activeWorkspaces").innerHTML = workspaces.length === 0
        ? '<div class="workspace-empty">当前没有独立工作区。任务进入并行执行后，会在这里显示各自的目录与分支。</div>'
        : '<div class="workspace-list">' + workspaces.map((workspace) => '<div class="workspace-row"><div><span class="workspace-chip">' + esc(workspace.agent || "Agent") + '</span><strong style="display:block">' + esc(workspace.taskId) + '</strong></div><div><strong>' + esc(workspace.subject) + '</strong></div><code title="' + esc(workspace.branch || "") + '">' + esc(workspace.branch || "独立工作区（detached）") + '</code><code title="' + esc(workspace.workDir || "") + '">' + esc(workspace.workDir || "—") + '</code></div>').join("") + '</div>';
    }
    // --- 运行日志与操作历史 ---
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
    // --- 工单总账看板 ---
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
    // --- 运行提醒面板 ---
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
    // --- 事件绑定与首屏加载 ---
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
    ${ADOPTION_SCRIPT}
    ${PANELS_SCRIPT}
    loadState();
  </script>
</body>
</html>`;
}

/** 转义服务端插入 HTML 文本节点的项目名。 */
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}
