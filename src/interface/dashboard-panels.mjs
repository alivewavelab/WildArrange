/**
 * Dashboard 决策面板 + 运维面板：只读 ViewModel 与渲染片段。
 *
 * 两个面板都是纯派生视图（decisions/annotations/locks/runs/gateArming），
 * 不暴露任何写操作——dashboard 的写接口仍只有原有任务/消息/节点动作。
 * 独立成模块是为了守住 dashboard.mjs 的 1000 行拆分线。
 */
import { stat } from "node:fs/promises";
import { loadHelixConfig } from "../infra/runtime-config.mjs";
import { evaluateGateArming } from "../infra/gate-arming.mjs";
import { resolveHelixPath } from "../infra/runtime-store.mjs";
import { inspectFileLock } from "../infra/file-lock.mjs";
import { loadTaskState } from "../orchestration/plan-state.mjs";
import { parallelAgentStatus } from "../orchestration/parallel-runtime.mjs";
import { projectDecisions, projectDecisionStats } from "./decisions.mjs";

export async function buildDecisionsPanelViewModel(rootDir, { limit = 20 } = {}) {
  const [recent, stats] = await Promise.all([
    projectDecisions(rootDir, { limit }),
    projectDecisionStats(rootDir),
  ]);
  return {
    kind: "helix_dashboard_decisions_panel",
    recent: recent.records,
    skippedLines: recent.skippedLines,
    gates: stats.gates,
    neverFiredGates: stats.neverFiredGates,
    annotations: stats.annotations,
  };
}

export async function buildOpsPanelViewModel(rootDir) {
  const { config } = await loadHelixConfig(rootDir);
  const taskState = await loadTaskState(rootDir);
  const gateArming = evaluateGateArming({ config, tasks: taskState?.tasks || [] });
  const [tasksLock, ledgerLock, runs] = await Promise.all([
    inspectFileLock(rootDir, resolveHelixPath(rootDir, "team", "tasks.lock")),
    inspectFileLock(rootDir, resolveHelixPath(rootDir, "ledger.lock")),
    parallelAgentStatus(rootDir).catch(() => null),
  ]);
  const files = [];
  for (const name of ["ledger.jsonl", "decisions.jsonl", "annotations.jsonl"]) {
    const size = await stat(resolveHelixPath(rootDir, name)).then((info) => info.size).catch(() => null);
    files.push({ path: `.helix/${name}`, sizeBytes: size });
  }
  return {
    kind: "helix_dashboard_ops_panel",
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
    files,
  };
}

/**
 * 面板 HTML 片段。注意：dashboard.mjs 的页面是模板字符串，这里的 JS
 * 不能含反引号与 ${}，一律用字符串拼接。
 */
export function renderPanelsHtml() {
  return `
    <div class="grid two">
      <section>
        <h2>Decision Panel / 决策面板</h2>
        <div id="decisionStats" class="muted">loading</div>
        <div id="decisions"></div>
      </section>
      <section>
        <h2>Ops Panel / 运维面板</h2>
        <div id="ops"></div>
      </section>
    </div>`;
}

export const PANELS_SCRIPT = `
    function renderDecisionRecord(record) {
      const head = "[" + esc(record.ts || "?") + "] " + esc(record.gate || "?") + " " + esc(String(record.decision || "?").toUpperCase());
      const rule = record.code ? esc(record.code) + (record.reason ? " — " + esc(record.reason) : "") : esc(record.reason || "(未记录)");
      const marker = record.annotatable === true ? ' <span class="pill">可标注 ' + esc(record.id || "") + "</span>" : "";
      return '<div class="op-block" style="margin-bottom:8px;"><div><strong>' + head + "</strong>" + marker + "</div>"
        + '<div class="muted">' + esc(record.summary || "(无摘要)") + "</div>"
        + '<div class="muted">规则: ' + rule + "</div>"
        + (record.evidencePath ? '<div class="muted">证据: <code>' + esc(record.evidencePath) + "</code></div>" : "")
        + "</div>";
    }
    function renderDecisionsPanel(payload) {
      const stats = payload.gates.map(function (gate) {
        return esc(gate.gate) + ": " + gate.total + " 次";
      }).join(" · ");
      const never = payload.neverFiredGates.length > 0
        ? '<div style="color:var(--warn);margin:6px 0;">从未触发的门: ' + esc(payload.neverFiredGates.join(", ")) + "</div>"
        : "";
      el("decisionStats").innerHTML = stats + never;
      el("decisions").innerHTML = payload.recent.length === 0
        ? '<span class="muted">(无决策记录)</span>'
        : payload.recent.map(renderDecisionRecord).join("");
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
        const decisionsResponse = await fetch("/api/panels/decisions", { cache: "no-store" });
        if (decisionsResponse.ok) renderDecisionsPanel(await decisionsResponse.json());
        const opsResponse = await fetch("/api/panels/ops", { cache: "no-store" });
        if (opsResponse.ok) renderOpsPanel(await opsResponse.json());
      } catch (error) {
        el("decisionStats").textContent = error instanceof Error ? error.message : String(error);
      }
    }
`;
