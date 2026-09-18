// =============================================================================
// 文件名称：runtime-snapshot.mjs
// 所属模块：infra
// 作用说明：
//   运行时 state 快照 export/import 与 list/restore 备份。
//
// 【运行原理速读】
//   captureSnapshot → tar 清单 → restoreSnapshot 原子替换。
// =============================================================================
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendLedger, readVerifiedLedgerEntries, verifyLedger } from "./ledger.mjs";
import { normalizeRelativePath } from "./path-match.mjs";
import {
  STATE_VERSION,
  createWorkId,
  ensureWildArrangeDirs,
  nowIso,
  readJson,
  resolveWildArrangePath,
  resolveTaskPacketPath,
  writeJsonAtomic,
  writeTextAtomic,
} from "./runtime-store.mjs";
import { inspectCompletedTaskEvidence, loadTaskState } from "./task-state-store.mjs";

/**
 * writeSnapshot：本模块对外异步 API。
 */
export async function writeSnapshot(rootDir, stage, payload = {}) {
  await ensureWildArrangeDirs(rootDir);
  const snapshot = {
    version: STATE_VERSION,
    id: createWorkId("snap"),
    stage,
    at: nowIso(),
    work: await readJson(resolveWildArrangePath(rootDir, "work.json"), null),
    taskState: await readJson(resolveWildArrangePath(rootDir, "team", "tasks.json"), null),
    payload,
  };
  const fileName = `${snapshot.at.replaceAll(":", "-")}-${stage}.json`;
  const snapshotPath = resolveWildArrangePath(rootDir, "snapshots", fileName);
  await writeJsonAtomic(snapshotPath, snapshot);
  await writeJsonAtomic(resolveWildArrangePath(rootDir, "snapshots", "latest.json"), snapshot);
  await writeRuntimeContextSnapshot(rootDir, { reason: `snapshot:${stage}`, latestSnapshot: snapshot });
  await appendLedger(rootDir, { type: "snapshot_written", stage, snapshotPath: normalizeRelativePath(path.relative(rootDir, snapshotPath)) });
  return snapshot;
}

// --- 任务包 ---
// A frozen start-of-work projection and navigation only. tasks.json remains the live task authority.
/**
 * ensureTaskPacket：本模块对外异步 API。
 */
export async function ensureTaskPacket(rootDir, planId, task) {
  const dir = resolveTaskPacketPath(rootDir, planId, task.id);
  const components = [resolveWildArrangePath(rootDir), resolveWildArrangePath(rootDir, "task-packets"),
    resolveWildArrangePath(rootDir, "task-packets", planId), dir];
  for (const component of components) await assertPacketComponentNotSymlink(component);
  await mkdir(dir, { recursive: true });
  for (const component of components) await assertPacketComponentNotSymlink(component);
  const baselinePath = resolveTaskPacketPath(rootDir, planId, task.id, "baseline.json");
  for (const name of ["baseline.json", "README.md", "research.md"]) {
    await assertPacketComponentNotSymlink(resolveTaskPacketPath(rootDir, planId, task.id, name));
  }
  const existing = await readJson(baselinePath, null);
  if (existing && (existing.planId !== planId || existing.taskId !== task.id || existing.kind !== "task_start_baseline")) {
    throw new Error("task packet baseline identity mismatch");
  }
  if (!existing) {
    const work = await readJson(resolveWildArrangePath(rootDir, "work.json"), null);
    await writeJsonAtomic(baselinePath, {
      kind: "task_start_baseline", planId, taskId: task.id, at: nowIso(),
      note: "Historical start snapshot only; live task state is team/tasks.json.",
      task: Object.fromEntries(["subject", "owner", "category", "writable_paths", "success_criteria", "verify_commands", "responsibilityChanges", "contractChanges", "request"]
        .filter(key => task[key] !== undefined).map(key => [key, task[key]])),
      approval: work?.activePlanId === planId ? work.planApproval || null : null,
    });
  }
  const indexPath = resolveTaskPacketPath(rootDir, planId, task.id, "README.md");
  const researchPath = resolveTaskPacketPath(rootDir, planId, task.id, "research.md");
  const index = `# Task evidence packet ${planId}/${task.id}\n\n` +
    `This folder is historical evidence and navigation. Current task state: ../../../team/tasks.json.\n\n` +
    `- Start baseline: ./baseline.json (frozen at first start)\n` +
    `- Research index: ./research.md (initial links only; research artifacts require an approved writable path)\n` +
    `- Readiness: ../../../reports/readiness/${planId}/${task.id}.json\n` +
    `- Review: ../../../reports/reviews/${planId}/${task.id}.json\n` +
    `- Failure: ../../../reports/failures/${planId}/${task.id}.json\n` +
    `- Acceptance: ../../../reports/acceptance/${planId}/${task.id}.json\n` +
    `- Checkpoint: ../../../checkpoints/${planId}/${task.id}.json\n\n` +
    `A listed future report is not evidence until its file exists. Do not copy its current status here.\n`;
  const sourceRefs = task.request?.evidenceRefs || [];
  const researchIndex = `# Research index ${planId}/${task.id}\n\n` +
    `This is a frozen input index, not a claim that research has been completed. New research artifacts require a task-approved writable path and must be cited in task/review evidence.\n\n` +
    `## Source references at start\n\n` +
    (sourceRefs.length ? sourceRefs.map(ref => `- ${JSON.stringify(ref)}`).join("\n") : "- None declared.") + "\n";
  for (const [file, content] of [[indexPath, index], [researchPath, researchIndex]]) {
    const exists = await readFile(file, "utf8").then(() => true, error => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
    if (!exists) await writeTextAtomic(file, content);
  }
  return { directory: dir, baselinePath, indexPath, researchPath };
}

async function assertPacketComponentNotSymlink(file) {
  try {
    if ((await lstat(file)).isSymbolicLink()) throw new Error(`task packet path is a symlink: ${file}`);
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

/**
 * writeRuntimeContextSnapshot：本模块对外异步 API。
 */
export async function writeRuntimeContextSnapshot(rootDir, options = {}) {
  const latestSnapshot = options.latestSnapshot || await readJson(resolveWildArrangePath(rootDir, "snapshots", "latest.json"), null);
  const work = await readJson(resolveWildArrangePath(rootDir, "work.json"), null);
  const taskState = await loadTaskState(rootDir);
  const changes = await readChangeRequests(rootDir);
  const verifiedLedgerEntries = await readVerifiedLedgerEntries(rootDir);
  const completionIntegrity = await inspectCompletedTaskEvidence(rootDir, taskState, { ledgerEntries: verifiedLedgerEntries });
  const status = buildStatusReport(work, taskState, changes, completionIntegrity);
  const ledgerIntegrity = await verifyLedger(rootDir);
  const awaitingPlanApproval = isCurrentPlanAwaitingApproval(work, taskState);
  const nextTask = taskState && !awaitingPlanApproval ? findRunnableTaskForContext(taskState.tasks || []) : null;
  const cliCommandPrefix = await resolveRuntimeCliCommandPrefix(rootDir, {
    preferredPrefix: options.cliCommandPrefix,
    fallbackCliPath: options.fallbackCliPath,
  });
  const nextAction = describeNextAction(taskState?.tasks || [], nextTask, cliCommandPrefix, {
    awaitingPlanApproval,
    planId: work?.activePlanId || taskState?.planId || null,
  });
  const context = {
    kind: "wildarrange_context_snapshot",
    version: STATE_VERSION,
    at: nowIso(),
    reason: options.reason || "manual",
    cliCommandPrefix,
    latestSnapshot: latestSnapshot ? { id: latestSnapshot.id, stage: latestSnapshot.stage, at: latestSnapshot.at } : null,
    status,
    nextAction: nextAction.text,
    nextActionDetails: nextAction,
    nextTask: nextTask ? summarizeTaskForContext(nextTask) : null,
    activeTasks: (taskState?.tasks || [])
      .filter((task) => task.status === "verifying" || task.status === "in_progress")
      .map(summarizeTaskForContext),
    failedTasks: (taskState?.tasks || [])
      .filter((task) => task.status === "failed")
      .map(summarizeTaskForContext),
    openChanges: changes.filter((change) => change.status === "open").map(summarizeChangeForContext),
    sessions: await readSessionLineage(rootDir),
    ledgerIntegrity,
    ledgerTail: verifiedLedgerEntries.slice(-12),
  };
  const jsonPath = resolveWildArrangePath(rootDir, "snapshots", "context.json");
  const mdPath = resolveWildArrangePath(rootDir, "snapshots", "context.md");
  context.reportJsonPath = normalizeRelativePath(path.relative(rootDir, jsonPath));
  context.reportMdPath = normalizeRelativePath(path.relative(rootDir, mdPath));
  await writeJsonAtomic(jsonPath, context);
  await writeFile(mdPath, renderContextMarkdown(context), "utf8");
  return context;
}

function buildStatusReport(work, taskState, changes, completionIntegrity) {
  const openChanges = changes.filter((change) => change.status === "open").length;
  if (!taskState) return { work, planId: null, total: 0, completed: 0, invalidCompleted: 0, completionIntegrity, draft: 0, pending: 0, failed: 0, openChanges };
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
    invalidCompleted: completionIntegrity.invalid.length,
    completionIntegrity,
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

function isCurrentPlanAwaitingApproval(work, taskState) {
  const activePlanId = work?.activePlanId || null;
  const taskPlanId = taskState?.planId || taskState?.activePlanId || null;
  const approval = work?.planApproval;
  return Boolean(activePlanId)
    && (!taskPlanId || taskPlanId === activePlanId)
    && approval?.required === true
    && approval.status !== "approved"
    && (!approval.planId || approval.planId === activePlanId);
}

// A read-only description of current state, shared by resume and Stop output.
// Executing any suggested command still goes through the runtime's own gates.
function describeNextAction(tasks, runnable, cliCommandPrefix, options = {}) {
  const recovery = tasks.find((task) => task.pendingContractChange && task.admission_claim
    && task.admission_claim.workspaceRestored !== true);
  const active = tasks.find((task) => !task.pendingContractChange && ["in_progress", "verifying"].includes(task.status));
  const failed = tasks.find((task) => !task.pendingContractChange && ["failed", "review_blocked", "needs_user_decision"].includes(task.status));
  const waiting = tasks.find((task) => task.pendingContractChange);
  const awaitingPlanApproval = options.awaitingPlanApproval === true && !recovery;
  const task = recovery || (awaitingPlanApproval ? null : runnable || active || failed || waiting);
  const reason = recovery ? "admission_recovery" : awaitingPlanApproval ? "awaiting_plan_approval" : runnable ? "runnable_task" : active ? "active_task" : failed ? "blocked_or_failed_task" : waiting ? "awaiting_user_decision" : "no_unfinished_work";
  const command = recovery || (task === active && active?.admission_claim)
    ? renderCliCommand(cliCommandPrefix, `parallel admit --run ${task.admission_claim.runId} --task ${task.id}`)
    : runnable ? renderCliCommand(cliCommandPrefix, "run") : active ? renderCliCommand(cliCommandPrefix, `node verify --task ${task.id}`) : failed ? renderCliCommand(cliCommandPrefix, "status") : null;
  const text = recovery ? command ? `recover shared workspace: ${command}` : "reinstall the adapter before shared-workspace recovery"
    : awaitingPlanApproval ? `await user approval for plan ${options.planId}`
    : runnable ? `run task ${task.id}: ${task.subject}` : active ? command ? `resume task ${task.id}: ${command}` : `reinstall the adapter before resuming task ${task.id}`
    : failed ? "inspect failed task" : waiting ? `await user direction for contract change ${task.pendingContractChange}` : "no runnable task";
  return { reason, taskId: task?.id || null, planId: awaitingPlanApproval ? options.planId : null, command, text };
}

/**
 * resolveRuntimeCliCommandPrefix：本模块对外异步 API。
 */
export async function resolveRuntimeCliCommandPrefix(rootDir, options = {}) {
  const preferred = normalizeRuntimeCliCommandPrefix(rootDir, options.preferredPrefix);
  if (preferred) return preferred;
  const artifactPrefix = await readInstalledHookCliCommandPrefix(rootDir);
  if (artifactPrefix) return artifactPrefix;
  const report = await readJson(resolveWildArrangePath(rootDir, "adapters", "install-report.json"), null);
  const reportPrefix = normalizeRuntimeCliCommandPrefix(rootDir, report?.cliPrefix);
  if (reportPrefix) return reportPrefix;
  if (options.fallbackCliPath) {
    const fallbackPrefix = normalizeRuntimeCliCommandPrefix(rootDir, `node "${path.resolve(options.fallbackCliPath)}"`);
    if (fallbackPrefix) return fallbackPrefix;
  }
  return existsSync(path.join(rootDir, "bin", "wildarrange.mjs")) ? "node ./bin/wildarrange.mjs" : null;
}

async function readInstalledHookCliCommandPrefix(rootDir) {
  for (const hookPath of [
    path.join(rootDir, ".codex", "hooks.json"),
    resolveWildArrangePath(rootDir, "adapters", "codex", "hooks.json"),
  ]) {
    const hooks = await readJson(hookPath, null);
    for (const command of collectHookCommands(hooks)) {
      const marker = command.indexOf(" hook run");
      if (marker < 0) continue;
      const prefix = normalizeRuntimeCliCommandPrefix(rootDir, command.slice(0, marker));
      if (prefix) return prefix;
    }
  }
  for (const bridgePath of [
    path.join(rootDir, ".cursor", "hooks", "wildarrange-hook-bridge.mjs"),
    resolveWildArrangePath(rootDir, "adapters", "kimi", "plugin", "hooks", "wildarrange-hook-bridge.mjs"),
  ]) {
    const source = await readFile(bridgePath, "utf8").catch(() => "");
    const cliSpecJson = source.match(/^const cliSpec = (\{[^\r\n]+\});$/m)?.[1];
    if (!cliSpecJson) continue;
    try {
      const cliSpec = JSON.parse(cliSpecJson);
      const candidate = cliSpec.kind === "npx"
        ? `npx -y ${cliSpec.packageName}`
        : cliSpec.kind === "local" ? `node "${cliSpec.cliPath}"` : "";
      const prefix = normalizeRuntimeCliCommandPrefix(rootDir, candidate);
      if (prefix) return prefix;
    } catch {
      // A malformed restored bridge is not an executable CLI fact.
    }
  }
  return null;
}

function collectHookCommands(value, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectHookCommands(item, output);
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (key === "command" && typeof nested === "string") output.push(nested);
      else collectHookCommands(nested, output);
    }
  }
  return output;
}

function normalizeRuntimeCliCommandPrefix(rootDir, value) {
  if (typeof value !== "string") return null;
  const prefix = value.trim();
  if (!prefix || prefix.length > 2_000 || /[\r\n\0]/.test(prefix)) return null;
  const npx = prefix.match(/^npx(?:\.cmd)?\s+(?:-y\s+)?((?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*)$/i);
  if (npx) return `npx -y ${npx[1]}`;
  const node = prefix.match(/^node(?:\.exe)?\s+(?:"([^"\r\n]+[\\/]wildarrange\.mjs)"|'([^'\r\n]+[\\/]wildarrange\.mjs)'|(\S+[\\/]wildarrange\.mjs))$/i);
  const cliPath = node?.[1] || node?.[2] || node?.[3];
  if (!cliPath) return null;
  if (/[\\/]_npx[\\/]/i.test(cliPath)) {
    const packageName = extractNpxPackageNameFromCliPath(cliPath);
    return packageName ? `npx -y ${packageName}` : null;
  }
  const absoluteCliPath = path.isAbsolute(cliPath) ? path.resolve(cliPath) : path.resolve(rootDir, cliPath);
  if (!existsSync(absoluteCliPath)) return null;
  if (!path.isAbsolute(cliPath)) return "node ./bin/wildarrange.mjs";
  return `node "${absoluteCliPath}"`;
}

function extractNpxPackageNameFromCliPath(cliPath) {
  const normalized = cliPath.replaceAll("\\", "/");
  return normalized.match(/\/node_modules\/((?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*)\/bin\/wildarrange\.mjs$/i)?.[1] || null;
}

function renderCliCommand(cliCommandPrefix, args) {
  return cliCommandPrefix ? `${cliCommandPrefix} ${args}` : null;
}

async function readChangeRequests(rootDir) {
  const dirPath = resolveWildArrangePath(rootDir, "changes");
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

async function readSessionLineage(rootDir) {
  return readJson(resolveWildArrangePath(rootDir, "sessions", "lineage.json"), {
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
    responsibilityChanges: task.responsibilityChanges || null,
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
    `- Counts: total=${status.total || 0}, completed=${status.completed || 0}, invalidCompleted=${status.invalidCompleted || 0}, pending=${status.pending || 0}, verifying=${status.verifying || 0}, failed=${status.failed || 0}, openChanges=${status.openChanges || 0}`,
    `- Ledger integrity: ${context.ledgerIntegrity?.ok === true ? "verified" : `failed (${context.ledgerIntegrity?.failures?.length || 0} finding(s))`}`,
    `- Next action: ${context.nextAction}`,
    ...(context.nextActionDetails?.command ? [`- Next command: \`${context.nextActionDetails.command}\``] : []),
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
  if (context.cliCommandPrefix) {
    lines.push(`- Inspect: \`${renderCliCommand(context.cliCommandPrefix, "status")}\``);
    lines.push(`- Refresh context: \`${renderCliCommand(context.cliCommandPrefix, "resume")}\``);
    if (context.nextActionDetails.reason === "awaiting_plan_approval") {
      lines.push(`- Approve after user confirmation: \`${renderCliCommand(context.cliCommandPrefix, `plan approve --plan ${context.nextActionDetails.planId}`)}\``);
    } else {
      lines.push(`- Run next task: \`${renderCliCommand(context.cliCommandPrefix, "run")}\``);
      lines.push(`- Node loop: \`${renderCliCommand(context.cliCommandPrefix, "node execute|verify|scope|review|checkpoint|retry --task <taskId>")}\``);
    }
    lines.push(`- Open changes: \`${renderCliCommand(context.cliCommandPrefix, "changes list")}\``);
  } else {
    lines.push("- Unavailable: reinstall the WildArrange adapter to record an executable CLI command.");
  }
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
