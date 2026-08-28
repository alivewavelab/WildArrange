import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendLedger } from "./ledger.mjs";
import {
  STATE_VERSION,
  createWorkId,
  ensureHelixDirs,
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
} from "./runtime-store.mjs";
import { loadTaskState } from "./task-state-store.mjs";

export async function writeSnapshot(rootDir, stage, payload = {}) {
  await ensureHelixDirs(rootDir);
  const snapshot = {
    version: STATE_VERSION,
    id: createWorkId("snap"),
    stage,
    at: nowIso(),
    work: await readJson(resolveHelixPath(rootDir, "work.json"), null),
    taskState: await readJson(resolveHelixPath(rootDir, "team", "tasks.json"), null),
    payload,
  };
  const fileName = `${snapshot.at.replaceAll(":", "-")}-${stage}.json`;
  const snapshotPath = resolveHelixPath(rootDir, "snapshots", fileName);
  await writeJsonAtomic(snapshotPath, snapshot);
  await writeJsonAtomic(resolveHelixPath(rootDir, "snapshots", "latest.json"), snapshot);
  await writeRuntimeContextSnapshot(rootDir, { reason: `snapshot:${stage}`, latestSnapshot: snapshot });
  await appendLedger(rootDir, { type: "snapshot_written", stage, snapshotPath: path.relative(rootDir, snapshotPath) });
  return snapshot;
}

export async function writeRuntimeContextSnapshot(rootDir, options = {}) {
  const latestSnapshot = options.latestSnapshot || await readJson(resolveHelixPath(rootDir, "snapshots", "latest.json"), null);
  const work = await readJson(resolveHelixPath(rootDir, "work.json"), null);
  const taskState = await loadTaskState(rootDir);
  const changes = await readChangeRequests(rootDir);
  const status = buildStatusReport(work, taskState, changes);
  const nextTask = taskState ? findRunnableTaskForContext(taskState.tasks || []) : null;
  const context = {
    kind: "helix_context_snapshot",
    version: STATE_VERSION,
    at: nowIso(),
    reason: options.reason || "manual",
    latestSnapshot: latestSnapshot ? { id: latestSnapshot.id, stage: latestSnapshot.stage, at: latestSnapshot.at } : null,
    status,
    nextAction: nextTask ? `run task ${nextTask.id}: ${nextTask.subject}` : status.failed > 0 ? "inspect failed task" : "no runnable task",
    nextTask: nextTask ? summarizeTaskForContext(nextTask) : null,
    activeTasks: (taskState?.tasks || [])
      .filter((task) => task.status === "verifying" || task.status === "in_progress")
      .map(summarizeTaskForContext),
    failedTasks: (taskState?.tasks || [])
      .filter((task) => task.status === "failed")
      .map(summarizeTaskForContext),
    openChanges: changes.filter((change) => change.status === "open").map(summarizeChangeForContext),
    sessions: await readSessionLineage(rootDir),
    ledgerTail: await readLedgerTail(rootDir, 12),
  };
  const jsonPath = resolveHelixPath(rootDir, "snapshots", "context.json");
  const mdPath = resolveHelixPath(rootDir, "snapshots", "context.md");
  context.reportJsonPath = path.relative(rootDir, jsonPath);
  context.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, context);
  await writeFile(mdPath, renderContextMarkdown(context), "utf8");
  return context;
}

function buildStatusReport(work, taskState, changes) {
  const openChanges = changes.filter((change) => change.status === "open").length;
  if (!taskState) return { work, planId: null, total: 0, completed: 0, draft: 0, pending: 0, failed: 0, openChanges };
  const counts = (taskState.tasks || []).reduce((acc, task) => {
    acc[task.status] = (acc[task.status] || 0) + 1;
    return acc;
  }, {});
  return {
    work,
    planId: taskState.planId,
    total: taskState.tasks.length,
    draft: counts.draft || 0,
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

function findRunnableTaskForContext(tasks) {
  const completed = new Set(tasks.filter((task) => task.status === "completed").map((task) => task.id));
  return tasks.find((task) => task.status === "pending" && (task.blockedBy || []).every((id) => completed.has(id))) || null;
}

async function readChangeRequests(rootDir) {
  const dirPath = resolveHelixPath(rootDir, "changes");
  let entries;
  try {
    entries = await readdir(dirPath);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const changes = [];
  for (const fileName of entries) {
    if (!fileName.endsWith(".json")) continue;
    const change = await readJson(path.join(dirPath, fileName), null);
    if (change) changes.push(change);
  }
  return changes.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
}

async function readLedgerTail(rootDir, limit) {
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

async function readSessionLineage(rootDir) {
  return readJson(resolveHelixPath(rootDir, "sessions", "lineage.json"), {
    version: STATE_VERSION,
    currentSessionId: null,
    sessionIds: [],
    sessions: [],
  });
}

function summarizeTaskForContext(task) {
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    category: task.category,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    writable_paths: task.writable_paths || [],
    verify_commands: task.verify_commands || [],
    review_commands: task.review_commands || [],
    standards_commands: task.standards_commands || [],
    lastFailure: task.last_failure ? {
      reason: task.last_failure.reason,
      retryHint: task.last_failure.retryHint,
      reportMdPath: task.last_failure.reportMdPath,
      resolvedBy: task.last_failure.resolvedBy,
    } : null,
    lastChangeRequest: task.last_change_request ? {
      id: task.last_change_request.id,
      status: task.last_change_request.status,
      reportMdPath: task.last_change_request.reportMdPath,
    } : null,
    lastReview: task.last_review_result ? {
      pass: task.last_review_result.pass,
      reportMdPath: task.last_review_result.reportMdPath,
      failedLanes: (task.last_review_result.lanes || [])
        .filter((lane) => lane.status === "fail")
        .map((lane) => lane.name),
    } : null,
  };
}

function summarizeChangeForContext(change) {
  return {
    id: change.id,
    status: change.status,
    taskId: change.taskId,
    subject: change.subject,
    deniedPaths: change.deniedPaths || [],
    reportMdPath: change.reportMdPath,
  };
}

function renderContextMarkdown(context) {
  const status = context.status || {};
  const lines = [
    "# WildArrange Resume Context",
    "",
    `Generated: ${context.at}`,
    `Reason: ${context.reason}`,
    `Latest snapshot: ${context.latestSnapshot ? `${context.latestSnapshot.stage} @ ${context.latestSnapshot.at}` : "none"}`,
    "",
    "## Status",
    "",
    `- Work: ${status.work?.workId || "(none)"}`,
    `- Plan: ${status.planId || "(none)"}`,
    `- Counts: total=${status.total || 0}, completed=${status.completed || 0}, pending=${status.pending || 0}, verifying=${status.verifying || 0}, failed=${status.failed || 0}, openChanges=${status.openChanges || 0}`,
    `- Next action: ${context.nextAction}`,
    "",
    "## Session Lineage",
    "",
  ];
  if (!context.sessions?.sessionIds?.length) {
    lines.push("- No recorded sessions yet.");
  } else {
    lines.push(`- Current: ${context.sessions.currentSessionId || "(unknown)"}`);
    lines.push(`- All: ${context.sessions.sessionIds.join(", ")}`);
  }
  lines.push("", "## Next Task", "");
  if (context.nextTask) appendTaskContext(lines, context.nextTask);
  else lines.push("- None.");
  lines.push("", "## Active Tasks", "");
  if (context.activeTasks.length === 0) lines.push("- None.");
  else for (const task of context.activeTasks) appendTaskContext(lines, task);
  lines.push("", "## Failed Tasks", "");
  if (context.failedTasks.length === 0) lines.push("- None.");
  else for (const task of context.failedTasks) appendTaskContext(lines, task);
  lines.push("", "## Open ChangeRequests", "");
  if (context.openChanges.length === 0) {
    lines.push("- None.");
  } else {
    for (const change of context.openChanges) {
      lines.push(`- ${change.id} (${change.status}) task=${change.taskId}`);
      lines.push(`  - Subject: ${change.subject}`);
      lines.push(`  - Denied: ${change.deniedPaths.join(", ") || "(none)"}`);
      lines.push(`  - Report: ${change.reportMdPath || "(none)"}`);
    }
  }
  lines.push("", "## Resume Commands", "");
  lines.push("- Inspect: `node ./bin/helix.mjs status`");
  lines.push("- Refresh context: `node ./bin/helix.mjs resume`");
  lines.push("- Run next task: `node ./bin/helix.mjs run`");
  lines.push("- Node loop: `node ./bin/helix.mjs node execute|verify|scope|review|checkpoint|retry --task <taskId>`");
  lines.push("- Open changes: `node ./bin/helix.mjs changes list`");
  lines.push("", "## Invariants", "");
  lines.push("- Worker done-claim is not completion.");
  lines.push("- Checkpoint requires verifier PASS, scope guard non-fail, and review gate PASS.");
  lines.push("- Scope drift requires ChangeRequest review before retry.");
  lines.push("- Do not weaken `verify_commands` or `review_commands` to manufacture PASS.");
  lines.push("", "## Ledger Tail", "");
  if (context.ledgerTail.length === 0) lines.push("- None.");
  else {
    for (const entry of context.ledgerTail) {
      lines.push(`- ${entry.at || ""} ${entry.type || entry.kind || "event"} ${entry.taskId ? `task=${entry.taskId}` : ""} ${entry.stage ? `stage=${entry.stage}` : ""}`.trim());
    }
  }
  return `${lines.join("\n")}\n`;
}

function appendTaskContext(lines, task) {
  lines.push(`- ${task.id}: ${task.subject}`);
  lines.push(`  - Status: ${task.status}; category=${task.category || "unresolved"}; attempts=${task.attempts}/${task.maxAttempts}`);
  lines.push(`  - Writable: ${task.writable_paths.join(", ") || "(none)"}`);
  lines.push(`  - Verify: ${task.verify_commands.join(" && ") || "(none)"}`);
  if (task.review_commands.length > 0) lines.push(`  - Review: ${task.review_commands.join(" && ")}`);
  if ((task.standards_commands || []).length > 0) lines.push(`  - Standards: ${task.standards_commands.join(" && ")}`);
  if (task.lastReview) lines.push(`  - Review gate: ${task.lastReview.pass ? "PASS" : `FAIL ${task.lastReview.failedLanes.join(", ")}`} (${task.lastReview.reportMdPath || "no report"})`);
  if (task.lastChangeRequest) lines.push(`  - ChangeRequest: ${task.lastChangeRequest.id} (${task.lastChangeRequest.reportMdPath || "no report"})`);
  if (task.lastFailure) {
    lines.push(`  - Failure: ${task.lastFailure.reason} (${task.lastFailure.reportMdPath || "no report"})`);
    lines.push(`  - Retry hint: ${(task.lastFailure.retryHint || "").replace(/\n/g, " / ")}`);
  }
}
