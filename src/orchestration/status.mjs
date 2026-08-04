import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  STATE_VERSION,
  ensureHelixDirs,
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import { listChangeRequests } from "./change-governance.mjs";
import { parallelAgentStatus } from "./parallel-runtime.mjs";
import { loadPlanApproval, loadTaskState } from "./plan-state.mjs";

export async function writeWorkflowSummary(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const status = await statusReport(rootDir);
  const taskState = await loadTaskState(rootDir);
  const changes = await listChangeRequests(rootDir);
  const latestSnapshot = await readJson(resolveHelixPath(rootDir, "snapshots", "latest.json"), null);
  const wisdom = await readTextFile(resolveHelixPath(rootDir, "wisdom", "verification.md"), "");
  const tasks = (taskState?.tasks || []).map((task) => ({
    id: task.id,
    subject: task.subject,
    status: task.status,
    attempts: task.attempts,
    category: task.category,
    verifyCommands: task.verify_commands || [],
    reviewCommands: task.review_commands || [],
    standardsCommands: task.standards_commands || [],
    checkpointPath: task.status === "completed" && taskState?.planId ? `.helix/checkpoints/${taskState.planId}-${task.id}.json` : null,
    reviewReportPath: task.last_review_result?.reportMdPath || null,
    failureReportPath: task.last_failure?.reportMdPath || null,
    changeRequestPath: task.last_change_request?.reportMdPath || null,
  }));
  const summary = {
    kind: "workflow_summary",
    version: STATE_VERSION,
    at: nowIso(),
    reason: options.reason || "manual",
    ok: status.total > 0 && status.completed === status.total && status.failed === 0 && status.pending === 0 && status.in_progress === 0 && status.verifying === 0 && status.openChanges === 0,
    planId: status.planId,
    status,
    latestSnapshot: latestSnapshot ? { id: latestSnapshot.id, stage: latestSnapshot.stage, at: latestSnapshot.at } : null,
    tasks,
    changes: changes.map(summarizeChangeForSummary),
    wisdom: wisdom.trim().split(/\r?\n/).filter(Boolean).slice(-20),
  };
  const jsonPath = resolveHelixPath(rootDir, "reports", "workflow-summary.json");
  const mdPath = resolveHelixPath(rootDir, "reports", "workflow-summary.md");
  summary.reportJsonPath = path.relative(rootDir, jsonPath);
  summary.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, summary);
  await writeFile(mdPath, renderWorkflowSummaryMarkdown(summary), "utf8");
  await appendLedger(rootDir, {
    type: "workflow_summary_written",
    planId: summary.planId,
    ok: summary.ok,
    reportPath: summary.reportMdPath,
    reason: summary.reason,
  });
  return summary;
}

export async function statusReport(rootDir) {
  const work = await readJson(resolveHelixPath(rootDir, "work.json"), null);
  const taskState = await loadTaskState(rootDir);
  const changes = await listChangeRequests(rootDir);
  const openChanges = changes.filter((change) => change.status === "open").length;
  if (!taskState) return { work, planId: null, total: 0, completed: 0, pending: 0, failed: 0, openChanges };
  const counts = taskState.tasks.reduce((acc, task) => {
    acc[task.status] = (acc[task.status] || 0) + 1;
    return acc;
  }, {});
  return {
    work,
    planId: taskState.planId,
    total: taskState.tasks.length,
    completed: counts.completed || 0,
    pending: counts.pending || 0,
    in_progress: counts.in_progress || 0,
    verifying: counts.verifying || 0,
    failed: counts.failed || 0,
    review_blocked: counts.review_blocked || 0,
    needs_user_decision: counts.needs_user_decision || 0,
    openChanges,
  };
}

export async function dashboardData(rootDir) {
  const status = await statusReport(rootDir);
  const taskState = await loadTaskState(rootDir);
  const latestSnapshot = await readJson(resolveHelixPath(rootDir, "snapshots", "latest.json"), null);
  const summary = await readJson(resolveHelixPath(rootDir, "reports", "workflow-summary.json"), null);
  const ledger = await readLedgerTail(rootDir, 80);
  const changes = await listChangeRequests(rootDir);
  const attention = await attentionReport(rootDir, { taskState, changes });
  return {
    generatedAt: nowIso(),
    status,
    tasks: taskState?.tasks || [],
    changes,
    attention,
    summary,
    latestSnapshot: latestSnapshot ? {
      id: latestSnapshot.id,
      stage: latestSnapshot.stage,
      at: latestSnapshot.at,
      payload: latestSnapshot.payload,
    } : null,
    ledger,
  };
}

export async function attentionReport(rootDir, options = {}) {
  const taskState = options.taskState !== undefined ? options.taskState : await loadTaskState(rootDir);
  const changes = options.changes !== undefined ? options.changes : await listChangeRequests(rootDir);
  const tasks = taskState?.tasks || [];

  const openChanges = changes
    .filter((change) => change.status === "open")
    .map((change) => ({
      id: change.id,
      taskId: change.taskId,
      subject: change.subject,
      deniedPaths: change.deniedPaths || [],
      reportMdPath: change.reportMdPath || null,
      resolveHint: `node ./bin/helix.mjs changes resolve --id ${change.id} --decision accept|reject --evidence "..." --rationale "..."`,
    }));

  const failedTasks = tasks
    .filter((task) => task.status === "failed")
    .map((task) => ({
      id: task.id,
      subject: task.subject,
      reason: task.last_failure?.reason || "unknown",
      retryHint: task.last_failure?.retryHint || null,
      reportMdPath: task.last_failure?.reportMdPath || null,
    }));

  const needsUserDecision = tasks
    .filter((task) => task.status === "needs_user_decision" || task.status === "review_blocked")
    .map((task) => ({ id: task.id, subject: task.subject, status: task.status }));

  const awaitingAcceptance = [];
  const parallel = await parallelAgentStatus(rootDir).catch(() => null);
  for (const run of parallel?.runs || []) {
    for (const result of run.results || []) {
      if (result.lifecycle?.status !== "awaiting_user_acceptance") continue;
      awaitingAcceptance.push({
        runId: run.runId,
        taskId: result.taskId,
        agent: result.agent,
        resultPath: result.resultPath,
        admitHint: `node ./bin/helix.mjs parallel admit --run ${run.runId} --task ${result.taskId}`,
      });
    }
  }

  const approval = await loadPlanApproval(rootDir).catch(() => ({ required: false, status: "approved" }));
  const awaitingPlanApproval = approval.required && approval.status !== "approved"
    ? [{
        planId: approval.planId,
        approveHint: `node ./bin/helix.mjs plan approve`,
      }]
    : [];

  return {
    kind: "attention_report",
    at: nowIso(),
    total: openChanges.length + failedTasks.length + needsUserDecision.length + awaitingAcceptance.length + awaitingPlanApproval.length,
    openChanges,
    failedTasks,
    needsUserDecision,
    awaitingAcceptance,
    awaitingPlanApproval,
  };
}

export async function readLedgerTail(rootDir, limit) {
  try {
    const content = await readFile(resolveHelixPath(rootDir, "ledger.jsonl"), "utf8");
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readTextFile(filePath, fallback = "") {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function renderWorkflowSummaryMarkdown(summary) {
  const status = summary.status || {};
  const lines = [
    "# WildArrange Workflow Summary",
    "",
    `Generated: ${summary.at}`,
    `Reason: ${summary.reason}`,
    `Status: ${summary.ok ? "PASS" : "ATTENTION_REQUIRED"}`,
    "",
    "## Run State",
    "",
    `- Plan: ${summary.planId || "(none)"}`,
    `- Counts: total=${status.total || 0}, completed=${status.completed || 0}, pending=${status.pending || 0}, verifying=${status.verifying || 0}, failed=${status.failed || 0}, openChanges=${status.openChanges || 0}`,
    `- Latest snapshot: ${summary.latestSnapshot ? `${summary.latestSnapshot.stage} @ ${summary.latestSnapshot.at}` : "none"}`,
    "",
    "## Task Breakdown",
    "",
  ];
  if (summary.tasks.length === 0) {
    lines.push("- No tasks.");
  } else {
    for (const task of summary.tasks) {
      lines.push(`- ${task.id}: ${task.subject}`);
      lines.push(`  - Status: ${task.status}; category=${task.category || "unresolved"}; attempts=${task.attempts}`);
      lines.push(`  - Verify: ${task.verifyCommands.join(" && ") || "(none)"}`);
      if (task.reviewCommands.length > 0) lines.push(`  - Review: ${task.reviewCommands.join(" && ")}`);
      if (task.standardsCommands.length > 0) lines.push(`  - Standards: ${task.standardsCommands.join(" && ")}`);
      if (task.checkpointPath) lines.push(`  - Checkpoint: ${task.checkpointPath}`);
      if (task.reviewReportPath) lines.push(`  - Review report: ${task.reviewReportPath}`);
      if (task.failureReportPath) lines.push(`  - Failure report: ${task.failureReportPath}`);
      if (task.changeRequestPath) lines.push(`  - ChangeRequest: ${task.changeRequestPath}`);
    }
  }
  lines.push("", "## ChangeRequests", "");
  if (summary.changes.length === 0) {
    lines.push("- None.");
  } else {
    for (const change of summary.changes) {
      lines.push(`- ${change.id}: ${change.status}; task=${change.taskId}; denied=${change.deniedPaths.join(", ") || "(none)"}`);
    }
  }
  lines.push("", "## Wisdom", "");
  if (summary.wisdom.length === 0) {
    lines.push("- None.");
  } else {
    lines.push(...summary.wisdom);
  }
  lines.push("", "## Gate Invariants", "");
  lines.push("- Every completed task has verifier evidence.");
  lines.push("- Completed tasks passed scope guard and review gate before checkpoint.");
  lines.push("- Open ChangeRequests must be resolved before final PASS.");
  return `${lines.join("\n")}\n`;
}

function summarizeChangeForSummary(change) {
  return {
    id: change.id,
    status: change.status,
    taskId: change.taskId,
    subject: change.subject,
    deniedPaths: change.deniedPaths || [],
    reportMdPath: change.reportMdPath,
  };
}
