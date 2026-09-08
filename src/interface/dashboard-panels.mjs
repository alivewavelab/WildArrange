/**
 * Dashboard 路由复盘、决策面板与运维面板的 ViewModel 与渲染片段。
 *
 * 读取侧均为派生视图（decisions/annotations/locks/runs/gateArming）；唯一
 * 写入是路由人工复盘标注，复用 annotation-log，绝不改 routes/config/gate。
 * 独立成模块是为了守住 dashboard.mjs 的 1000 行拆分线。
 */
import { stat } from "node:fs/promises";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { evaluateGateArming } from "../infra/gate-arming.mjs";
import { readJson, resolveWildArrangePath } from "../infra/runtime-store.mjs";
import { inspectFileLock } from "../infra/file-lock.mjs";
import { evaluateRegistryFreshness } from "../infra/verification-registry.mjs";
import { loadTaskState } from "../orchestration/plan-state.mjs";
import { parallelAgentStatus } from "../orchestration/parallel-runtime.mjs";
import { projectDecisions, projectDecisionStats } from "./decisions.mjs";
import { readDecisions } from "../infra/decision-log.mjs";
import { appendAnnotation, readAnnotations } from "../infra/annotation-log.mjs";

const ROUTE_REVIEW_CATEGORIES = ["confirmed", "rule_wrong", "case_wrong"];

export async function buildRouteReviewPanelViewModel(rootDir, { date = localDate(), limit = 100 } = {}) {
  const [{ records, skippedLines }, annotations, dailyReport] = await Promise.all([
    readDecisions(rootDir, { filter: (record) => typeof record.ts === "string" && localDate(record.ts) === date }),
    readAnnotations(rootDir),
    readJson(resolveWildArrangePath(rootDir, "reports", "routing", `${date}.json`), null),
  ]);
  const latestAnnotation = new Map();
  for (const annotation of annotations.records) latestAnnotation.set(annotation.decisionId, annotation);

  const routes = [];
  const activeRouteBySession = new Map();
  for (const record of records) {
    if (record.gate === "routing") {
      const review = latestAnnotation.get(record.id) || null;
      const route = {
        id: record.id,
        ts: record.ts,
        sessionId: record.sessionId || null,
        inputText: record.inputText || record.summary || "",
        result: record.routeResult || {
          route: record.decision || null,
          reason: record.reason || null,
        },
        review,
        tools: [],
      };
      routes.push(route);
      if (route.sessionId) activeRouteBySession.set(route.sessionId, route);
      continue;
    }
    if (!["pre_tool_use", "post_tool_use"].includes(record.gate) || !record.sessionId) continue;
    const route = activeRouteBySession.get(record.sessionId);
    if (!route) continue;
    route.tools.push({
      id: record.id,
      ts: record.ts,
      stage: record.gate,
      decision: record.decision,
      code: record.code || null,
      reason: record.reason || null,
      toolName: record.toolName || null,
      targetPaths: record.targetPaths || [],
      input: record.toolInputSummary || null,
      evidencePath: record.evidencePath || null,
    });
  }
  const selected = routes.slice(-limit).reverse();
  const reviewed = selected.filter((route) => route.review);
  return {
    kind: "wildarrange_dashboard_route_review_panel",
    date,
    total: selected.length,
    reviewed: reviewed.length,
    confirmed: reviewed.filter((route) => route.review.category === "confirmed").length,
    issues: reviewed.filter((route) => ["rule_wrong", "case_wrong"].includes(route.review.category)).length,
    dailyReport: dailyReport?.kind === "wildarrange_daily_routing_review" ? {
      generatedAt: dailyReport.generatedAt,
      summary: dailyReport.summary,
      patterns: dailyReport.patterns || [],
      path: `.wildarrange/reports/routing/${date}.md`,
    } : null,
    skippedLines,
    routes: selected,
  };
}

export async function annotateRouteDecision(rootDir, { decisionId, category, reason } = {}) {
  if (!ROUTE_REVIEW_CATEGORIES.includes(category)) {
    throw new Error(`route review category must be ${ROUTE_REVIEW_CATEGORIES.join("|")}`);
  }
  const { records } = await readDecisions(rootDir, {});
  const decision = records.find((record) => record.id === decisionId);
  if (!decision || decision.gate !== "routing") throw new Error("route review requires a real routing decision id");
  return appendAnnotation(rootDir, { decisionId, category, reason, author: "dashboard" });
}

function localDate(value = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA").format(parsed);
}

export async function buildDecisionsPanelViewModel(rootDir, { limit = 20 } = {}) {
  const [recent, stats] = await Promise.all([
    projectDecisions(rootDir, { limit }),
    projectDecisionStats(rootDir),
  ]);
  return {
    kind: "wildarrange_dashboard_decisions_panel",
    recent: recent.records,
    skippedLines: recent.skippedLines,
    gates: stats.gates,
    neverFiredGates: stats.neverFiredGates,
    annotations: stats.annotations,
  };
}

export async function buildOpsPanelViewModel(rootDir) {
  const { config } = await loadWildArrangeConfig(rootDir);
  const taskState = await loadTaskState(rootDir);
  const gateArming = evaluateGateArming({ config, tasks: taskState?.tasks || [] });
  const [tasksLock, ledgerLock, runs, registryFreshness] = await Promise.all([
    inspectFileLock(rootDir, resolveWildArrangePath(rootDir, "team", "tasks.lock")),
    inspectFileLock(rootDir, resolveWildArrangePath(rootDir, "ledger.lock")),
    parallelAgentStatus(rootDir).catch(() => null),
    evaluateRegistryFreshness(rootDir, { config }).catch((error) => ({
      status: "check_failed",
      stale: false,
      reason: error instanceof Error ? error.message : String(error),
    })),
  ]);
  const files = [];
  for (const name of ["ledger.jsonl", "decisions.jsonl", "annotations.jsonl"]) {
    const size = await stat(resolveWildArrangePath(rootDir, name)).then((info) => info.size).catch(() => null);
    files.push({ path: `.wildarrange/${name}`, sizeBytes: size });
  }
  return {
    kind: "wildarrange_dashboard_ops_panel",
    gateArming,
    locks: [tasksLock, ledgerLock],
    parallelRuns: runs
      ? {
        runCount: runs.runCount,
        runs: runs.runs.map((run) => ({
          runId: run.runId,
          batchStatus: run.batchStatus,
          incompleteTasks: run.incompleteTasks,
        })),
      }
      : null,
    registryFreshness,
    files,
  };
}

/**
 * 面板 HTML 片段。注意：dashboard.mjs 的页面是模板字符串，这里的 JS
 * 不能含反引号与 ${}，一律用字符串拼接。
 */
export function renderPanelsHtml() {
  return `
    <section>
      <div class="panel-head"><div><h2>决策列表</h2><div class="muted">每条记录说明发生了什么、为什么这样判断。</div></div></div>
      <div class="decision-filters" id="decisionFilters">
        <button class="active" data-decision-category="all">全部</button>
        <button data-decision-category="routing">路由</button>
        <button data-decision-category="hook">Hook</button>
        <button data-decision-category="quality">质量门</button>
        <button data-decision-category="admission">成果合入</button>
      </div>
      <div id="decisionStats" class="muted">正在读取</div>
      <div id="decisions"></div>
    </section>`;
}

export const PANELS_SCRIPT = `
    let decisionPayload = { recent: [], gates: [], neverFiredGates: [] };
    let decisionCategory = "all";
    function decisionCategoryOf(gate) {
      if (gate === "routing") return "routing";
      if (gate === "pre_tool_use" || gate === "post_tool_use") return "hook";
      if (gate === "admission") return "admission";
      return "quality";
    }
    function decisionCategoryLabel(gate) {
      return ({ routing:"路由", hook:"Hook", quality:"质量门", admission:"成果合入" })[decisionCategoryOf(gate)] || "质量门";
    }
    function routeReviewLabel(category) {
      return ({ confirmed: "已确认正确", rule_wrong: "规则错误", case_wrong: "个案错误", mislabeled: "标注有误" })[category] || "未复盘";
    }
    function renderRouteTool(tool) {
      const paths = (tool.targetPaths || []).length ? " · " + esc(tool.targetPaths.join(", ")) : "";
      const detail = tool.input ? '<details><summary>参数摘要</summary><pre>' + esc(JSON.stringify(tool.input, null, 2)) + "</pre></details>" : "";
      return '<div class="route-tool"><span class="route-tool-stage">' + esc(tool.stage) + '</span><strong>' + esc(tool.toolName || "unknown") + '</strong> · ' + esc(tool.decision || "?") + paths + detail + "</div>";
    }
    function renderRouteReview(route) {
      const result = route.result || {};
      const semantic = result.semanticShadow || {};
      const review = route.review;
      const reviewClass = review && review.category === "confirmed" ? "route-ok" : review ? "route-issue" : "";
      const signals = (result.matchedSignals || []).map(function (signal) { return '<span class="signal-chip">' + esc(signal) + "</span>"; }).join("");
      const tools = route.tools.length ? route.tools.map(renderRouteTool).join("") : '<div class="muted">本次请求后尚无可关联的工具记录</div>';
      return '<article class="route-review-card ' + reviewClass + '" data-decision="' + esc(route.id) + '">'
        + '<div class="route-review-meta"><span>' + esc(route.ts) + '</span><code>' + esc(route.id) + '</code><span>' + esc(route.sessionId || "无会话 ID") + '</span></div>'
        + '<div class="route-request">' + esc(route.inputText || "(无原文)") + "</div>"
        + '<div class="route-result"><strong>' + esc(result.route || "?") + '</strong><span>意图 ' + esc(result.intent || "?") + '</span><span>领域 ' + esc(result.domain || "?") + '</span><span>主责 ' + esc(result.primaryAgent || "?") + '</span><span>置信度 ' + esc(result.confidence ?? "?") + "</span></div>"
        + '<div class="route-reason">规则：' + esc(result.reason || "(未记录)") + (signals ? '<div class="signal-row">' + signals + "</div>" : "") + "</div>"
        + '<div class="route-semantic">语义复核：' + esc(semantic.status || "未启用") + (semantic.reason ? " · " + esc(semantic.reason) : "") + "</div>"
        + '<details class="route-tools"><summary>工具活动 ' + route.tools.length + ' 条</summary>' + tools + "</details>"
        + '<div class="route-review-actions"><span class="review-state">' + esc(routeReviewLabel(review && review.category)) + (review && review.reason ? " · " + esc(review.reason) : "") + '</span><div><button data-route-category="confirmed">正确</button><button data-route-category="rule_wrong">规则错</button><button data-route-category="case_wrong">个案错</button></div></div>'
        + "</article>";
    }
    function renderRouteReviews(payload) {
      const daily = payload.dailyReport;
      el("routeReviewDaily").innerHTML = daily
        ? '<strong>今日自动复盘已生成</strong><span>问题 ' + daily.summary.issues + ' · 待人工 ' + daily.summary.unreviewed + ' · 工具 ' + daily.summary.toolCalls + '</span><code>' + esc(daily.path) + '</code>'
        : '<span class="muted">IDE 会话结束时会自动生成当天中文复盘报告</span>';
      el("routeReviewStats").innerHTML = '<span><b>' + payload.total + '</b> 次判断</span><span><b>' + payload.reviewed + '</b> 已复盘</span><span class="completed"><b>' + payload.confirmed + '</b> 正确</span><span class="failed"><b>' + payload.issues + '</b> 有问题</span>';
      el("routeReviews").innerHTML = payload.routes.length ? payload.routes.map(renderRouteReview).join("") : '<div class="route-empty">当天还没有路由判断记录</div>';
    }
    async function loadRouteReviews() {
      const date = el("routeReviewDate").value;
      const query = date ? "?date=" + encodeURIComponent(date) : "";
      const response = await dashboardFetch("/api/panels/routes" + query, { cache: "no-store" });
      if (!response.ok) throw new Error("路由复盘数据加载失败");
      renderRouteReviews(await response.json());
    }
    function renderDecisionRecord(record) {
      const head = decisionCategoryLabel(record.gate) + " · " + esc(String(record.decision || "?").toUpperCase());
      const rule = record.code ? esc(record.code) + (record.reason ? " — " + esc(record.reason) : "") : esc(record.reason || "(未记录)");
      const marker = record.annotatable === true ? ' <span class="pill">可标注 ' + esc(record.id || "") + "</span>" : "";
      return '<div class="op-block" style="margin-bottom:8px;"><div><strong>' + head + "</strong>" + marker + '<span class="muted" style="float:right">' + esc(record.ts ? new Date(record.ts).toLocaleString("zh-CN", { hour12:false }) : "?") + "</span></div>"
        + '<div class="muted">' + esc(record.summary || "(无摘要)") + "</div>"
        + '<div class="muted">规则: ' + rule + "</div>"
        + (record.evidencePath ? '<div class="muted">证据: <code>' + esc(record.evidencePath) + "</code></div>" : "")
        + "</div>";
    }
    function renderDecisionsPanel(payload) {
      decisionPayload = payload;
      const records = payload.recent.filter(function (record) { return decisionCategory === "all" || decisionCategoryOf(record.gate) === decisionCategory; });
      el("decisionStats").textContent = "显示 " + records.length + " 条 · 共读取 " + payload.recent.length + " 条";
      el("decisions").innerHTML = records.length === 0
        ? '<span class="muted">(无决策记录)</span>'
        : records.map(renderDecisionRecord).join("");
    }
    function renderOpsPanel(payload) {
      const blocks = [];
      const arming = payload.gateArming || {};
      const armed = arming.armed === true;
      blocks.push('<div class="op-block"><h3>门武装状态</h3><div class="' + (armed ? "completed" : "failed") + '">'
        + (armed ? "已武装" : "门未武装") + "</div>"
        + (armed ? "" : '<div class="muted">' + esc((arming.issues || []).map(function (issue) { return issue && issue.message ? issue.message : String(issue); }).join("; ")) + "</div>") + "</div>");
      const locks = (payload.locks || []).map(function (lock) {
        if (!lock.locked) return esc(lock.path) + ": 空闲";
        const owner = lock.owner ? esc(lock.owner) + " pid=" + lock.pid + (lock.pidAlive ? " 存活" : " 已死") : "不可解析";
        return esc(lock.path) + ": 持有中 (" + owner + (lock.stale ? ", stale" : "") + ")";
      });
      blocks.push('<div class="op-block"><h3>锁</h3><div class="muted">' + locks.join("<br>") + "</div></div>");
      const files = (payload.files || []).map(function (file) {
        return esc(file.path) + ": " + (file.sizeBytes === null ? "不存在" : Math.round(file.sizeBytes / 1024) + " KB");
      });
      blocks.push('<div class="op-block"><h3>日志体积</h3><div class="muted">' + files.join("<br>") + "</div></div>");
      const runs = payload.parallelRuns && payload.parallelRuns.runs.length > 0
        ? payload.parallelRuns.runs.map(function (run) {
          const incomplete = (run.incompleteTasks || []).length > 0 ? " 缺: " + esc(run.incompleteTasks.join(",")) : "";
          return esc(run.runId) + " " + esc(run.batchStatus || "?") + incomplete;
        }).join("<br>")
        : "(无并行 run)";
      blocks.push('<div class="op-block"><h3>并行 Run 对账</h3><div class="muted">' + runs + "</div></div>");
      el("ops").innerHTML = '<div class="grid" style="gap:10px;">' + blocks.join("") + "</div>";
    }
    async function loadPanels() {
      try {
        const decisionsResponse = await dashboardFetch("/api/panels/decisions", { cache: "no-store" });
        if (decisionsResponse.ok) renderDecisionsPanel(await decisionsResponse.json());
      } catch (error) {
        el("decisionStats").textContent = error instanceof Error ? error.message : String(error);
      }
    }
    el("decisionFilters").addEventListener("click", function (event) {
      const button = event.target.closest("button[data-decision-category]");
      if (!button) return;
      decisionCategory = button.dataset.decisionCategory;
      el("decisionFilters").querySelectorAll("button").forEach(function (item) { item.classList.toggle("active", item === button); });
      renderDecisionsPanel(decisionPayload);
    });
`;
