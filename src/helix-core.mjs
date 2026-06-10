import path from "node:path";
import {
  appendLedger,
  ensureHelixDirs,
  initRuntime,
  nowIso,
  resolveHelixPath,
  withTaskStateLock,
  writeJsonAtomic,
  writeSnapshot,
} from "./helix-foundation.mjs";
import { installAdapter, uninstallAdapter } from "./helix-adapters.mjs";
import { readChangeRequest, recordReviewBlocker, resolveChangeRequest, reviewChangeRequest, steerWorkflow } from "./helix-change.mjs";
import { routeRequest } from "./helix-routing.mjs";
import { runReviewGate, runWorker } from "./helix-review.mjs";
import { statusReport, writeWorkflowSummary } from "./helix-status.mjs";
import {
  importPlan,
  loadTaskState,
} from "./helix-plan.mjs";
import {
  applyVerifierEvidenceToCriteria,
  claimTeamTask,
  createTeamTask,
  criteriaStatus,
  findRunnableTask,
  getTeamTask,
  listTeamTasks,
  persistTaskState,
  recordTaskEvidence,
  sendTeamMessage,
  writeOutbox,
} from "./helix-team.mjs";
import {
  appendWisdom,
  changedPathsIntroducedByTask,
  collectGitChangedPaths,
  collectGitDiff,
  listChangeRequests,
  runVerifier,
  scopeGuard,
  writeChangeRequest,
  writeCheckpoint,
  writeFailureReport,
  writeReviewReport,
} from "./helix-gates.mjs";

export {
  DEFAULT_HELIX_CONFIG,
  DEFAULT_PROMPT_PACK_DIR,
  HELIX_CONFIG_FILE,
  HELIX_DIR,
  STATE_VERSION,
  TASK_STATUSES,
  appendLedger,
  createWorkId,
  ensureHelixDirs,
  hashContent,
  initRuntime,
  installPromptPack,
  listPromptPack,
  loadPromptPackEntries,
  loadHelixConfig,
  nowIso,
  readJson,
  renderPromptPackEntry,
  resolveHelixPath,
  withTaskStateLock,
  writeDefaultHelixConfig,
  writeJsonAtomic,
  writeSnapshot,
} from "./helix-foundation.mjs";
export { installAdapter, uninstallAdapter } from "./helix-adapters.mjs";
export { recordReviewBlocker, resolveChangeRequest, reviewChangeRequest, steerWorkflow } from "./helix-change.mjs";
export { loadRoutesConfig, resolveRouteDecision, routeRequest } from "./helix-routing.mjs";
export { scanProjectRules } from "./helix-rules.mjs";
export { runReviewGate, runWorker } from "./helix-review.mjs";
export { buildAgentContext, continuationDirective, recordRuntimeSession, resumeReport, writeContextSnapshot } from "./helix-context.mjs";
export { preToolUseGuard, runInjectionHook } from "./helix-hooks.mjs";
export { resolveInjectionPoint } from "./helix-injection.mjs";
export { dashboardData, statusReport, writeWorkflowSummary } from "./helix-status.mjs";
export {
  enrichPlanWithRoutes,
  enrichTaskWithRouteDecision,
  importPlan,
  loadTaskState,
  normalizePlan,
  normalizeStringArray,
  normalizeSuccessCriteria,
  normalizeTask,
  validatePlanGraph,
  validateStatus,
  writeTasksMarkdown,
} from "./helix-plan.mjs";
export {
  applyVerifierEvidenceToCriteria,
  claimTeamTask,
  createTeamTask,
  criteriaStatus,
  findRunnableTask,
  getTeamTask,
  listTeamMessages,
  listTeamTasks,
  normalizeAgentName,
  persistTaskState,
  recordTaskEvidence,
  sendTeamMessage,
  writeOutbox,
} from "./helix-team.mjs";
export {
  appendWisdom,
  changedPathsIntroducedByTask,
  collectGitChangedPaths,
  collectGitDiff,
  listChangeRequests,
  pathAllowed,
  pathMatchesPattern,
  runCommand,
  runVerifier,
  scopeGuard,
  writeChangeRequest,
  writeCheckpoint,
  writeFailureReport,
  writeReviewReport,
} from "./helix-gates.mjs";
export async function runNextTask(rootDir, options = {}) {
  return withTaskStateLock(rootDir, "run-next-task", () => runNextTaskUnlocked(rootDir, options));
}

async function runNextTaskUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");

  const task = findRunnableTask(taskState.tasks);
  if (!task) {
    const unfinished = taskState.tasks.filter((candidate) => candidate.status !== "completed");
    const status = unfinished.length === 0 ? "complete" : "blocked";
    await appendLedger(rootDir, { type: "run_idle", status });
    return { status, task: null };
  }

  task.status = "in_progress";
  task.attempts += 1;
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, { type: "task_started", planId: taskState.planId, taskId: task.id, attempt: task.attempts });
  await writeSnapshot(rootDir, "task_started", { planId: taskState.planId, taskId: task.id, attempt: task.attempts });

  const beforeDiff = await collectGitDiff(rootDir);
  const beforeChanged = await collectGitChangedPaths(rootDir);
  const workerResult = await runWorker(rootDir, task, options);
  const afterDiff = await collectGitDiff(rootDir);
  const afterChanged = await collectGitChangedPaths(rootDir);

  task.status = "verifying";
  task.evidence.push(workerResult);
  task.evidence.push({
    kind: "diff",
    at: nowIso(),
    beforeBytes: beforeDiff.length,
    afterBytes: afterDiff.length,
    changed: beforeDiff !== afterDiff,
  });
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await writeOutbox(rootDir, task, workerResult);
  await appendLedger(rootDir, { type: "worker_done_claim", planId: taskState.planId, taskId: task.id, exitCode: workerResult.exitCode });
  await writeSnapshot(rootDir, "worker_done", { planId: taskState.planId, taskId: task.id, exitCode: workerResult.exitCode });

  const verifyResult = await runVerifier(rootDir, task);
  task.evidence.push(verifyResult);
  task.last_verify_result = verifyResult;
  const criterionEvidence = applyVerifierEvidenceToCriteria(task, verifyResult);
  await persistTaskState(rootDir, taskState);
  await writeSnapshot(rootDir, "verified", { planId: taskState.planId, taskId: task.id, pass: verifyResult.pass });
  if (criterionEvidence.length > 0) {
    await appendLedger(rootDir, { type: "criterion_evidence_auto_recorded", planId: taskState.planId, taskId: task.id, count: criterionEvidence.length });
  }

  const scopeResult = await scopeGuard(rootDir, {
    taskId: task.id,
    changedPaths: changedPathsIntroducedByTask(beforeChanged, afterChanged),
    unavailableReason: beforeChanged.available ? afterChanged.reason : beforeChanged.reason,
  });
  task.evidence.push({ kind: "scope_guard", at: nowIso(), ...scopeResult });
  task.last_scope_result = scopeResult;
  if (scopeResult.status === "fail") {
    task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "scope_guard");
  }
  await persistTaskState(rootDir, taskState);

  const reviewResult = await runReviewGate(rootDir, task, { workerResult, verifyResult, scopeResult });
  task.evidence.push(reviewResult);
  task.last_review_result = reviewResult;
  await writeReviewReport(rootDir, taskState.planId, task, reviewResult);
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, { type: "review_gate_completed", planId: taskState.planId, taskId: task.id, pass: reviewResult.pass, failedLaneCount: reviewResult.lanes.filter((lane) => lane.status === "fail").length });
  await writeSnapshot(rootDir, "reviewed", { planId: taskState.planId, taskId: task.id, pass: reviewResult.pass });

  const criteria = criteriaStatus(task);
  if (workerResult.exitCode === 0 && verifyResult.pass && criteria.pass && scopeResult.status === "pass" && reviewResult.pass) {
    task.status = "completed";
    task.updatedAt = nowIso();
    await persistTaskState(rootDir, taskState);
    await writeCheckpoint(rootDir, taskState.planId, task, verifyResult, scopeResult, reviewResult);
    await appendLedger(rootDir, { type: "task_verified", planId: taskState.planId, taskId: task.id, scopeStatus: scopeResult.status, reviewStatus: "pass" });
    await appendWisdom(rootDir, task, verifyResult);
    await writeSnapshot(rootDir, "checkpointed", { planId: taskState.planId, taskId: task.id, scopeStatus: scopeResult.status });
    if (taskState.tasks.every((candidate) => candidate.status === "completed")) {
      await writeWorkflowSummary(rootDir, { reason: "all_tasks_completed" });
    }
    return { status: "completed", task, workerResult, verifyResult, scopeResult, reviewResult };
  }

  task.status = shouldFailTask(task, verifyResult, scopeResult, reviewResult) ? "failed" : "pending";
  if (scopeResult?.status === "fail" && !task.last_change_request) {
    task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "scope_guard");
  }
  task.last_failure = buildFailureSummary(task, {
    workerResult,
    verifyResult,
    scopeResult,
    reviewResult,
    criteriaResult: criteria,
    nextStatus: task.status,
  });
  task.updatedAt = nowIso();
  await writeFailureReport(rootDir, taskState.planId, task);
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: "task_rejected",
    planId: taskState.planId,
    taskId: task.id,
    nextStatus: task.status,
    attempt: task.attempts,
    reason: task.last_failure.reason,
    retryHint: task.last_failure.retryHint,
  });
  await writeSnapshot(rootDir, "task_rejected", { planId: taskState.planId, taskId: task.id, nextStatus: task.status });
  return { status: task.status === "failed" ? "failed" : "retry", task, workerResult, verifyResult, scopeResult, reviewResult };
}

export async function runWorkflowNode(rootDir, nodeName, options = {}) {
  if (nodeName === "route") {
    return routeRequest(rootDir, { text: options.text });
  }
  if (nodeName === "execute") {
    return executeTaskNode(rootDir, options);
  }
  if (nodeName === "verify") {
    return verifyTaskNode(rootDir, options);
  }
  if (nodeName === "scope") {
    return scopeTaskNode(rootDir, options);
  }
  if (nodeName === "review") {
    return reviewTaskNode(rootDir, options);
  }
  if (nodeName === "checkpoint") {
    return checkpointTaskNode(rootDir, options);
  }
  if (nodeName === "retry") {
    return retryTaskNode(rootDir, options);
  }
  throw new Error(`unknown workflow node: ${nodeName}`);
}

export async function executeTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-execute:${options.taskId || "next"}`, () => executeTaskNodeUnlocked(rootDir, options));
}

async function executeTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");

  const task = resolveNodeTask(taskState.tasks, options.taskId, ["pending", "in_progress"]);
  if (task.status === "pending") {
    task.status = "in_progress";
    task.attempts += 1;
    task.updatedAt = nowIso();
    await persistTaskState(rootDir, taskState);
    await appendLedger(rootDir, { type: "node_execute_started", planId: taskState.planId, taskId: task.id, attempt: task.attempts });
    await writeSnapshot(rootDir, "node_execute_started", { planId: taskState.planId, taskId: task.id });
  }

  const beforeDiff = await collectGitDiff(rootDir);
  const beforeChanged = await collectGitChangedPaths(rootDir);
  const workerResult = await runWorker(rootDir, task, options);
  const afterDiff = await collectGitDiff(rootDir);
  const afterChanged = await collectGitChangedPaths(rootDir);

  task.status = "verifying";
  task.evidence.push(workerResult);
  task.evidence.push({
    kind: "diff",
    at: nowIso(),
    beforeBytes: beforeDiff.length,
    afterBytes: afterDiff.length,
    changed: beforeDiff !== afterDiff,
  });
  task.evidence.push({
    kind: "execution_paths",
    at: nowIso(),
    beforeAvailable: beforeChanged.available,
    afterAvailable: afterChanged.available,
    beforePaths: beforeChanged.paths || [],
    afterPaths: afterChanged.paths || [],
    introducedPaths: changedPathsIntroducedByTask(beforeChanged, afterChanged) || [],
    unavailableReason: beforeChanged.available ? afterChanged.reason : beforeChanged.reason,
  });
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await writeOutbox(rootDir, task, workerResult);
  await appendLedger(rootDir, { type: "node_execute_completed", planId: taskState.planId, taskId: task.id, exitCode: workerResult.exitCode });
  await writeSnapshot(rootDir, "node_execute_completed", { planId: taskState.planId, taskId: task.id, exitCode: workerResult.exitCode });
  return { status: "executed", task, workerResult };
}

export async function verifyTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-verify:${options.taskId || "next"}`, () => verifyTaskNodeUnlocked(rootDir, options));
}

async function verifyTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress"]);

  task.status = "verifying";
  const verifyResult = await runVerifier(rootDir, task);
  task.evidence.push(verifyResult);
  task.last_verify_result = verifyResult;
  const criterionEvidence = applyVerifierEvidenceToCriteria(task, verifyResult);
  if (!verifyResult.pass) {
    task.last_failure = buildFailureSummary(task, {
      workerResult: [...task.evidence].reverse().find((entry) => entry.kind === "worker") || { exitCode: 0 },
      verifyResult,
      scopeResult: task.last_scope_result || { status: "inconclusive" },
      nextStatus: "verifying",
    });
  }
  task.updatedAt = nowIso();
  await appendLedger(rootDir, { type: "node_verify_completed", planId: taskState.planId, taskId: task.id, pass: verifyResult.pass, criterionEvidenceCount: criterionEvidence.length });
  if (!verifyResult.pass) {
    await writeFailureReport(rootDir, taskState.planId, task);
    await persistTaskState(rootDir, taskState);
    await appendLedger(rootDir, { type: "node_verify_failed", planId: taskState.planId, taskId: task.id, reason: task.last_failure.reason });
  } else {
    await persistTaskState(rootDir, taskState);
  }
  await writeSnapshot(rootDir, "node_verify_completed", { planId: taskState.planId, taskId: task.id, pass: verifyResult.pass });
  return { status: verifyResult.pass ? "verified" : "verify_failed", task, verifyResult };
}

export async function scopeTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-scope:${options.taskId || "next"}`, () => scopeTaskNodeUnlocked(rootDir, options));
}

async function scopeTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress", "pending"]);
  const executionPaths = [...task.evidence].reverse().find((entry) => entry.kind === "execution_paths");
  const scopeResult = await scopeGuard(rootDir, {
    taskId: task.id,
    changedPaths: executionPaths?.afterAvailable === true ? executionPaths.introducedPaths : undefined,
    unavailableReason: executionPaths?.unavailableReason,
  });
  task.evidence.push({ kind: "scope_guard", at: nowIso(), ...scopeResult });
  task.last_scope_result = scopeResult;
  if (scopeResult.status === "fail") {
    task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "node_scope");
  }
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await writeSnapshot(rootDir, "node_scope_completed", { planId: taskState.planId, taskId: task.id, scopeStatus: scopeResult.status });
  return { status: scopeResult.status, task, scopeResult };
}

export async function reviewTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-review:${options.taskId || "next"}`, () => reviewTaskNodeUnlocked(rootDir, options));
}

async function reviewTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress"]);
  const workerResult = [...task.evidence].reverse().find((entry) => entry.kind === "worker");
  const verifyResult = task.last_verify_result || [...task.evidence].reverse().find((entry) => entry.kind === "verifier");
  const scopeResult = task.last_scope_result || [...task.evidence].reverse().find((entry) => entry.kind === "scope_guard");
  const reviewResult = await runReviewGate(rootDir, task, { workerResult, verifyResult, scopeResult });

  task.status = "verifying";
  task.evidence.push(reviewResult);
  task.last_review_result = reviewResult;
  task.updatedAt = nowIso();
  await writeReviewReport(rootDir, taskState.planId, task, reviewResult);

  if (!reviewResult.pass) {
    task.status = "failed";
    task.last_failure = buildFailureSummary(task, {
      workerResult: workerResult || { exitCode: 1 },
      verifyResult: verifyResult || { pass: false },
      scopeResult: scopeResult || { status: "inconclusive" },
      reviewResult,
      nextStatus: task.status,
    });
    await writeFailureReport(rootDir, taskState.planId, task);
  }

  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: reviewResult.pass ? "node_review_passed" : "node_review_failed",
    planId: taskState.planId,
    taskId: task.id,
    failedLaneCount: reviewResult.lanes.filter((lane) => lane.status === "fail").length,
  });
  await writeSnapshot(rootDir, "node_review_completed", { planId: taskState.planId, taskId: task.id, pass: reviewResult.pass });
  return { status: reviewResult.pass ? "reviewed" : "review_failed", task, reviewResult };
}

export async function checkpointTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-checkpoint:${options.taskId || "next"}`, () => checkpointTaskNodeUnlocked(rootDir, options));
}

async function checkpointTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress"]);
  const workerResult = [...task.evidence].reverse().find((entry) => entry.kind === "worker");
  const verifyResult = task.last_verify_result || [...task.evidence].reverse().find((entry) => entry.kind === "verifier");
  const scopeResult = task.last_scope_result || [...task.evidence].reverse().find((entry) => entry.kind === "scope_guard");
  const reviewResult = task.last_review_result || [...task.evidence].reverse().find((entry) => entry.kind === "review_gate");
  const criteria = criteriaStatus(task);

  if (workerResult?.exitCode === 0 && verifyResult?.pass === true && criteria.pass && scopeResult?.status === "pass" && reviewResult?.pass === true) {
    task.status = "completed";
    task.updatedAt = nowIso();
    await persistTaskState(rootDir, taskState);
    await writeCheckpoint(rootDir, taskState.planId, task, verifyResult, scopeResult, reviewResult);
    await appendLedger(rootDir, { type: "node_checkpoint_completed", planId: taskState.planId, taskId: task.id, scopeStatus: scopeResult?.status || "missing", reviewStatus: "pass" });
    await appendWisdom(rootDir, task, verifyResult);
    await writeSnapshot(rootDir, "node_checkpoint_completed", { planId: taskState.planId, taskId: task.id });
    return { status: "completed", task, verifyResult, scopeResult, reviewResult };
  }

  task.status = shouldFailTask(task, verifyResult, scopeResult, reviewResult) ? "failed" : "pending";
  if (scopeResult?.status === "fail" && !task.last_change_request) {
    task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "checkpoint");
  }
  task.last_failure = buildFailureSummary(task, {
    workerResult: workerResult || { exitCode: 1 },
    verifyResult: verifyResult || { pass: false },
    scopeResult: scopeResult || { status: "inconclusive" },
    reviewResult: reviewResult || { pass: false, lanes: [{ name: "review_gate", status: "fail", summary: "review gate has not passed" }] },
    criteriaResult: criteria,
    nextStatus: task.status,
  });
  task.updatedAt = nowIso();
  await writeFailureReport(rootDir, taskState.planId, task);
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: "node_checkpoint_rejected",
    planId: taskState.planId,
    taskId: task.id,
    nextStatus: task.status,
    reason: task.last_failure.reason,
    retryHint: task.last_failure.retryHint,
  });
  await writeSnapshot(rootDir, "node_checkpoint_rejected", { planId: taskState.planId, taskId: task.id, nextStatus: task.status });
  return { status: task.status === "failed" ? "failed" : "retry", task, verifyResult, scopeResult, reviewResult };
}

export async function retryTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-retry:${options.taskId || "next"}`, () => retryTaskNodeUnlocked(rootDir, options));
}

async function retryTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = resolveRetryTask(taskState.tasks, options.taskId);
  const failure = task.last_failure;

  if (failure?.reason === "scope_guard_failed" && options.force !== true) {
    const scopeResult = task.last_scope_result || [...task.evidence].reverse().find((entry) => entry.kind === "scope_guard");
    if (!task.last_change_request && scopeResult?.status === "fail") {
      task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "retry_block");
      await persistTaskState(rootDir, taskState);
    }
    const changeRequest = task.last_change_request?.id ? await readChangeRequest(rootDir, task.last_change_request.id) : task.last_change_request;
    if (!changeRequest || changeRequest.status === "open") {
      await appendLedger(rootDir, {
        type: "node_retry_blocked",
        planId: taskState.planId,
        taskId: task.id,
        reason: "scope_guard_failed",
        nextAction: "review_change_request",
        changeRequestId: task.last_change_request?.id,
      });
      return { status: "change_request_required", task, failure, changeRequest: task.last_change_request || null };
    }

    const currentChanged = await collectGitChangedPaths(rootDir);
    const stillChangedDeniedPaths = currentChanged.available
      ? (changeRequest.deniedPaths || []).filter((filePath) => currentChanged.paths.map(normalizeRelativePath).includes(normalizeRelativePath(filePath)))
      : undefined;
    const currentScope = await scopeGuard(rootDir, {
      taskId: task.id,
      changedPaths: stillChangedDeniedPaths,
      unavailableReason: currentChanged.reason,
    });
    if (currentScope.status === "fail") {
      await appendLedger(rootDir, {
        type: "node_retry_blocked",
        planId: taskState.planId,
        taskId: task.id,
        reason: "scope_cleanup_required",
        nextAction: changeRequest.status === "accepted" ? "apply_scope_or_remove_denied_paths" : "remove_denied_paths",
        changeRequestId: changeRequest.id,
        deniedPaths: currentScope.deniedPaths,
      });
      return { status: "scope_cleanup_required", task, failure, changeRequest, scopeResult: currentScope };
    }
    task.last_scope_result = currentScope;
    task.evidence.push({ kind: "scope_guard", at: nowIso(), ...currentScope });
  }

  task.status = "pending";
  task.manual_retry_count = (task.manual_retry_count || 0) + 1;
  task.maxAttempts = Math.max(task.maxAttempts || 1, task.attempts + 1);
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: "node_retry_reopened",
    planId: taskState.planId,
    taskId: task.id,
    manualRetryCount: task.manual_retry_count,
    previousReason: failure?.reason || "unknown",
  });
  await writeSnapshot(rootDir, "node_retry_reopened", { planId: taskState.planId, taskId: task.id });
  return { status: "pending", task, failure };
}

function resolveNodeTask(tasks, taskId, allowedStatuses) {
  const task = taskId ? tasks.find((candidate) => candidate.id === taskId) : findRunnableTask(tasks) || tasks.find((candidate) => allowedStatuses.includes(candidate.status));
  if (!task) throw new Error(taskId ? `unknown task: ${taskId}` : "no task available for node");
  if (!allowedStatuses.includes(task.status)) {
    throw new Error(`task ${task.id} status ${task.status} cannot run this node`);
  }
  return task;
}

function resolveRetryTask(tasks, taskId) {
  const task = taskId
    ? tasks.find((candidate) => candidate.id === taskId)
    : tasks.find((candidate) => candidate.status === "failed") || findRunnableTask(tasks);
  if (!task) throw new Error(taskId ? `unknown task: ${taskId}` : "no failed or pending task available for retry");
  if (!["failed", "pending"].includes(task.status)) {
    throw new Error(`task ${task.id} status ${task.status} cannot run retry`);
  }
  return task;
}

function shouldFailTask(task, verifyResult, scopeResult, reviewResult) {
  if (scopeResult?.status === "fail") return true;
  if (scopeResult && scopeResult.status !== "pass") return true;
  if (verifyResult?.pass === true && reviewResult?.kind === "review_gate" && reviewResult.pass === false) return true;
  return task.attempts >= task.maxAttempts;
}

function rejectionReason(workerResult, verifyResult, scopeResult) {
  if (workerResult.exitCode !== 0) return "worker_failed";
  if (!verifyResult.pass) return "verifier_failed";
  if (scopeResult.status === "fail") return "scope_guard_failed";
  if (scopeResult.status !== "pass") return "scope_guard_inconclusive";
  return "unknown";
}

function gateRejectionReason(workerResult, verifyResult, scopeResult, reviewResult, criteriaResult) {
  const base = rejectionReason(workerResult, verifyResult, scopeResult);
  if (base !== "unknown") return base;
  if (criteriaResult && criteriaResult.pass === false) return "criteria_failed";
  if (reviewResult?.pass === false) return "review_gate_failed";
  return "unknown";
}

function buildFailureSummary(task, { workerResult, verifyResult, scopeResult, reviewResult, criteriaResult, nextStatus }) {
  const reason = gateRejectionReason(workerResult, verifyResult, scopeResult, reviewResult, criteriaResult);
  const failed = failureTarget(reason, workerResult, verifyResult, scopeResult, criteriaResult);
  const observed = failureObserved(reason, workerResult, verifyResult, scopeResult, reviewResult, criteriaResult);
  const fixBy = failureFixBy(reason, task, scopeResult, reviewResult, criteriaResult);
  const doNot = failureDoNot(reason);
  return {
    kind: "failure_summary",
    at: nowIso(),
    taskId: task.id,
    reason,
    nextStatus,
    failed,
    observed,
    fixBy,
    doNot,
    changeRequest: task.last_change_request || null,
    retryHint: [
      `FAILED: ${failed}`,
      `OBSERVED: ${observed}`,
      `FIX BY: ${fixBy}`,
      `DO NOT: ${doNot}`,
    ].join("\n"),
  };
}

function failureTarget(reason, workerResult, verifyResult, scopeResult, criteriaResult) {
  if (reason === "worker_failed") return workerResult.command || "worker command";
  if (reason === "verifier_failed") {
    const failedCommand = verifyResult.results?.find((result) => result.exitCode !== 0);
    return failedCommand?.command || "verifier command";
  }
  if (reason === "scope_guard_failed") return `scope guard denied ${scopeResult.deniedPaths?.join(", ") || "changed paths"}`;
  if (reason === "scope_guard_inconclusive") return "scope guard did not produce passing changed-path evidence";
  if (reason === "criteria_failed") return `success criteria (${criteriaResult?.passed || 0}/${criteriaResult?.total || 0} pass)`;
  if (reason === "review_gate_failed") return "review gate";
  return "checkpoint gate";
}

function failureObserved(reason, workerResult, verifyResult, scopeResult, reviewResult, criteriaResult) {
  if (reason === "worker_failed") return commandObservation(workerResult);
  if (reason === "verifier_failed") {
    const failedCommand = verifyResult.results?.find((result) => result.exitCode !== 0);
    return commandObservation(failedCommand || { exitCode: 1 });
  }
  if (reason === "scope_guard_failed") {
    return `changed=${(scopeResult.changedPaths || []).join(", ") || "none"}; denied=${(scopeResult.deniedPaths || []).join(", ") || "none"}`;
  }
  if (reason === "scope_guard_inconclusive") {
    return `scopeStatus=${scopeResult.status || "missing"}; reason=${scopeResult.reason || "missing changed-path evidence"}`;
  }
  if (reason === "criteria_failed") {
    return `criteria pass=${criteriaResult?.passed || 0}, pending=${criteriaResult?.pending || 0}, fail=${criteriaResult?.failed || 0}`;
  }
  if (reason === "review_gate_failed") {
    const failedLanes = (reviewResult?.lanes || []).filter((lane) => lane.status === "fail");
    return failedLanes.map((lane) => `${lane.name}: ${lane.summary}`).join("; ") || "review gate failed without lane details";
  }
  return "missing or inconclusive gate evidence";
}

function commandObservation(result) {
  const stdout = truncateForSummary((result.stdout || "").trim());
  const stderr = truncateForSummary((result.stderr || "").trim());
  return [`exitCode=${result.exitCode ?? 1}`, stdout ? `stdout=${stdout}` : null, stderr ? `stderr=${stderr}` : null].filter(Boolean).join("; ");
}

function failureFixBy(reason, task, scopeResult, reviewResult, criteriaResult) {
  if (reason === "worker_failed") return "修复 worker_command 或交给 Hephaestus 重新实现同一任务，然后重跑 execute。";
  if (reason === "verifier_failed") return "按失败命令输出修正实现，不改验收标准；修完后重跑 verify 和 checkpoint。";
  if (reason === "scope_guard_failed") {
    return `移除计划外改动或创建 ChangeRequest 扩展 writable_paths。当前允许范围：${task.writable_paths.join(", ") || "(none)"}；被拒绝：${(scopeResult.deniedPaths || []).join(", ") || "(unknown)"}`;
  }
  if (reason === "scope_guard_inconclusive") {
    return "恢复可审计的改动证据后重跑 scope/checkpoint；非 Git 项目应使用文件清单 fallback，或初始化 Git 以获得可靠 changed paths。";
  }
  if (reason === "criteria_failed") {
    return `补齐 successCriteria 证据后重跑 review/checkpoint。当前 pass=${criteriaResult?.passed || 0}, pending=${criteriaResult?.pending || 0}, fail=${criteriaResult?.failed || 0}。`;
  }
  if (reason === "review_gate_failed") {
    const failedLanes = (reviewResult?.lanes || []).filter((lane) => lane.status === "fail");
    return failedLanes.map((lane) => lane.fixBy).filter(Boolean).join("；") || "修复 review gate 指出的阻塞项，然后重跑 review 和 checkpoint。";
  }
  return "补齐缺失证据后重新进入 verify/checkpoint。";
}

function failureDoNot(reason) {
  if (reason === "scope_guard_failed") return "不要直接重试同一 worker；先处理范围漂移。";
  if (reason === "scope_guard_inconclusive") return "不要把“看不到改动”当作“没有越界”。";
  if (reason === "verifier_failed") return "不要降低或删除 verify_commands 来制造 PASS。";
  if (reason === "worker_failed") return "不要跳过 worker 失败直接 checkpoint。";
  if (reason === "review_gate_failed") return "不要绕过 review gate 或删除 review_commands 来制造 PASS。";
  if (reason === "criteria_failed") return "不要删除 successCriteria 或伪造 criterion evidence 来制造 PASS。";
  return "不要在证据不完整时 checkpoint。";
}

function truncateForSummary(value, limit = 500) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 15)}...[truncated]`;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function normalizeRelativePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

export async function runWorkflow(rootDir, options = {}) {
  await initRuntime(rootDir);
  let plan = null;
  if (options.planPath) {
    plan = await importPlan(rootDir, path.resolve(rootDir, options.planPath));
  } else if (options.sample) {
    const samplePath = await createSamplePlan(rootDir);
    plan = await importPlan(rootDir, samplePath);
  }

  const results = [];
  const maxSteps = options.maxSteps || 50;
  for (let step = 0; step < maxSteps; step += 1) {
    const result = await runNextTask(rootDir);
    results.push(result);
    if (["complete", "blocked", "failed"].includes(result.status)) break;
  }

  const report = await statusReport(rootDir);
  await writeSnapshot(rootDir, "workflow_finished", { status: report });
  const summary = await writeWorkflowSummary(rootDir, { reason: "workflow_finished" });
  return { ok: report.failed === 0 && report.pending === 0 && report.in_progress === 0 && report.verifying === 0, planId: plan?.id || report.planId, results, status: report, summaryPath: summary.reportMdPath };
}

export async function createSamplePlan(rootDir, targetPath = resolveHelixPath(rootDir, "plans", "sample-plan.json")) {
  await ensureHelixDirs(rootDir);
  const workerScript = "node -e \"const fs=require('fs'); fs.mkdirSync('.helix/artifacts',{recursive:true}); fs.writeFileSync('.helix/artifacts/linear-smoke.txt','ok\\\\n')\"";
  const verifyScript = "node -e \"const fs=require('fs'); const v=fs.readFileSync('.helix/artifacts/linear-smoke.txt','utf8').trim(); if(v!=='ok') process.exit(1)\"";
  const sample = {
    title: "M1 linear loop smoke",
    objective: "Prove Atlas can run one worker task and verify it before checkpoint.",
    tasks: [
      {
        id: "T001",
        subject: "Write smoke artifact",
        description: "Worker writes a small artifact; verifier checks exact content.",
        category: "quick",
        writable_paths: [".helix/artifacts/linear-smoke.txt"],
        worker_command: workerScript,
        verify_commands: [verifyScript],
      },
    ],
  };
  await writeJsonAtomic(targetPath, sample);
  return targetPath;
}

export async function copyPlanTemplate(rootDir, destinationPath) {
  const samplePath = await createSamplePlan(rootDir);
  await copyFile(samplePath, destinationPath);
  return destinationPath;
}
