import { appendLedger } from "../infra/ledger.mjs";
import {
  ensureHelixDirs,
  nowIso,
} from "../infra/runtime-store.mjs";
import { withTaskStateLock } from "../infra/task-state-lock.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { readChangeRequest, writeChangeRequest } from "./change-governance.mjs";
import { buildFailureSummary } from "../infra/failure-analysis.mjs";
import { writeFailureReport, writeReviewReport } from "../infra/task-reports.mjs";
import { routeRequest } from "../ai/routing.mjs";
import { captureWorkspaceSnapshot } from "../infra/git-worktree.mjs";
import { changedPathsIntroducedByTask, collectGitChangedPaths, collectGitDiff } from "../infra/git-diff.mjs";
import { applyVerifierEvidenceToCriteria, criteriaStatus } from "../infra/success-criteria.mjs";
import { invokeCapability } from "../capabilities/gateway.mjs";
import { normalizeRelativePath } from "../infra/path-match.mjs";
import {
  collectGateEvidenceFromTask,
  commitTaskCompletionState,
  runCompletionSegment,
  runDeliveryPipeline,
  runPostCompletionSideEffects,
  shouldFailDeliveryAttempt,
} from "./delivery-pipeline.mjs";
import { writeWorkflowSummary } from "./status.mjs";
import { loadPlanApproval, loadTaskState } from "./plan-state.mjs";
import { findRunnableTask, persistTaskState, writeOutbox } from "./task-board.mjs";
import { assertCurrentTaskOwnership, coordinateTaskClaim } from "./remote-ownership.mjs";

export async function runNextTask(rootDir, options = {}) {
  return withTaskStateLock(rootDir, "run-next-task", () => runNextTaskUnlocked(rootDir, options));
}

async function runNextTaskUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");

  const approval = await loadPlanApproval(rootDir);
  if (approval.required && approval.status !== "approved" && approval.planId === taskState.planId) {
    await appendLedger(rootDir, { type: "run_blocked_awaiting_plan_approval", planId: taskState.planId });
    return {
      status: "awaiting_plan_approval",
      task: null,
      planId: taskState.planId,
      approveHint: "开发者确认计划后放行：node ./bin/helix.mjs plan approve（或在编辑器里用 /helix-approve）",
    };
  }

  const task = findRunnableTask(taskState.tasks);
  if (!task) {
    // Recoverable-transaction protocol (cross-review P1, round 4,
    // 2026-07-21): a task stuck in "verifying" means a completion was
    // interrupted mid-transaction (e.g. the completion ledger event exists
    // but the canonical persist failed). Instead of reporting "blocked",
    // adjudicate it with the same logic as the single-step checkpoint node:
    // fresh all-pass gate evidence -> complete idempotently (checkpoint and
    // ledger writes are re-appliable); anything else -> back to pending for
    // a clean re-run. Tasks in "in_progress" are deliberately NOT touched:
    // they may be legitimately claimed and being worked on right now.
    // Likewise a verifying task holding an admission_claim is a parallel
    // admission in flight (or crashed and resumable by re-admitting the same
    // run) — adjudicating it here would hijack that transaction and send the
    // task back to pending under the admitter's feet (cross-review P1,
    // round 6, 2026-07-21).
    const claimed = taskState.tasks.find((candidate) => candidate.status === "verifying" && candidate.admission_claim?.runId);
    if (claimed) {
      await appendLedger(rootDir, { type: "run_blocked_by_admission_claim", planId: taskState.planId, taskId: claimed.id, runId: claimed.admission_claim.runId });
      return {
        status: "blocked",
        task: null,
        blockedBy: {
          taskId: claimed.id,
          reason: "parallel_admission_in_flight",
          runId: claimed.admission_claim.runId,
          hint: `任务 ${claimed.id} 正被并行 admission（run ${claimed.admission_claim.runId}）认领。若那次 admission 已崩溃，用同一 run 重新 admit 即可续跑`,
        },
      };
    }
    const interrupted = taskState.tasks.find((candidate) => candidate.status === "verifying");
    if (interrupted) {
      await appendLedger(rootDir, { type: "run_resumed_verifying_task", planId: taskState.planId, taskId: interrupted.id });
      const adjudicated = await checkpointTaskNodeUnlocked(rootDir, { taskId: interrupted.id });
      return { ...adjudicated, resumed: "verifying_task_adjudicated" };
    }
    const unfinished = taskState.tasks.filter((candidate) => candidate.status !== "completed");
    const status = unfinished.length === 0 ? "complete" : "blocked";
    await appendLedger(rootDir, { type: "run_idle", status });
    return { status, task: null };
  }

  task.owner = task.owner || "Jiuwei";
  task.coordination = await coordinateTaskClaim(rootDir, {
    planId: taskState.planId,
    task,
    owner: task.owner,
  });
  task.status = "in_progress";
  task.attempts += 1;
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, { type: "task_started", planId: taskState.planId, taskId: task.id, attempt: task.attempts });
  await writeSnapshot(rootDir, "task_started", { planId: taskState.planId, taskId: task.id, attempt: task.attempts });

  const workspaceSnapshot = await recordPreExecuteSnapshot(rootDir, taskState.planId, task);
  const beforeDiff = await collectGitDiff(rootDir);
  const beforeChanged = await collectGitChangedPaths(rootDir);
  const workerEnvelope = await invokeCapability("worker", { rootDir, task, options });
  const workerResult = workerEnvelope.evidence;
  const afterDiff = await collectGitDiff(rootDir);
  const afterChanged = await collectGitChangedPaths(rootDir);

  task.status = "verifying";
  // New worker round: stale gate results from previous rounds must not
  // survive (see the same clearing in executeTaskNodeUnlocked). The pipeline
  // below re-runs every gate anyway; this keeps persisted state honest if
  // the process dies between worker and pipeline.
  task.last_verify_result = null;
  task.last_scope_result = null;
  task.last_review_result = null;
  if (workspaceSnapshot) task.evidence.push(workspaceSnapshot);
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

  // Shared delivery pipeline owns gate order (verify -> scope -> review ->
  // acceptance-proof -> checkpoint); see src/orchestration/delivery-pipeline.mjs.
  // This function still owns every reporting/ledger side effect itself so
  // observable behavior (files written, ledger entries, evidence shape)
  // stays identical to before the pipeline existed.
  const pipelineResult = await runDeliveryPipeline(rootDir, taskState.planId, task, {
    initialEvidence: { workerResult },
    changedPaths: changedPathsIntroducedByTask(beforeChanged, afterChanged),
    unavailableReason: beforeChanged.available ? afterChanged.reason : beforeChanged.reason,
    preCompletionGate: () => taskOwnershipGate(rootDir, task.id),
  });
  const verifyResult = pipelineResult.evidence.verifyResult;
  const scopeResult = pipelineResult.evidence.scopeResult;
  const reviewResult = pipelineResult.evidence.reviewResult;
  const acceptanceProof = pipelineResult.evidence.acceptanceProof || null;
  const criteria = pipelineResult.criteria;

  task.evidence.push(verifyResult);
  task.last_verify_result = verifyResult;
  await writeSnapshot(rootDir, "verified", { planId: taskState.planId, taskId: task.id, pass: verifyResult.pass });
  if (pipelineResult.criterionEvidenceRecorded.length > 0) {
    await appendLedger(rootDir, { type: "criterion_evidence_auto_recorded", planId: taskState.planId, taskId: task.id, count: pipelineResult.criterionEvidenceRecorded.length });
  }

  task.evidence.push({ kind: "scope_guard", at: nowIso(), ...scopeResult });
  task.last_scope_result = scopeResult;
  if (scopeResult.status === "fail") {
    task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "scope_guard");
  }

  task.evidence.push(reviewResult);
  task.last_review_result = reviewResult;
  await writeReviewReport(rootDir, taskState.planId, task, reviewResult);
  await appendLedger(rootDir, { type: "review_gate_completed", planId: taskState.planId, taskId: task.id, pass: reviewResult.pass, failedLaneCount: reviewResult.lanes.filter((lane) => lane.status === "fail").length });
  await writeSnapshot(rootDir, "reviewed", { planId: taskState.planId, taskId: task.id, pass: reviewResult.pass });

  if (pipelineResult.status === "revalidation_required") {
    task.status = "pending";
    task.coordination = {
      ...task.coordination,
      status: "stale",
      staleReason: pipelineResult.evidence.integrationGuard?.reason || "task_ownership_changed",
    };
    task.last_failure = {
      at: nowIso(),
      reason: "task_ownership_changed",
      summary: pipelineResult.evidence.integrationGuard?.error || "remote task ownership changed before completion",
      retryHint: "旧设备必须停止写入；由当前远端 owner 继续任务并重新运行全部质量门",
    };
    task.updatedAt = nowIso();
    await writeFailureReport(rootDir, taskState.planId, task);
    await persistTaskState(rootDir, taskState);
    await appendLedger(rootDir, {
      type: "task_completion_revalidation_required",
      planId: taskState.planId,
      taskId: task.id,
      reason: task.last_failure.reason,
    });
    return { status: "revalidation_required", task, workerResult, verifyResult, scopeResult, reviewResult, acceptanceProof };
  }

  if (pipelineResult.status === "completed") {
    // Completion ledger event BEFORE the canonical state write: tasks.json is
    // the commit point every consumer reads, so a ledger outage must leave
    // the task re-runnable (not completed-without-evidence). The reverse
    // ordering produced completed state with no completion ledger event
    // (cross-review P0, round 3, 2026-07-21). If the persist below fails
    // instead, the ledger is one event ahead of state, which the append-only
    // journal tolerates: the rerun appends a fresh event.
    // Wisdom and digest sit INSIDE the completion transaction (before the
    // canonical persist): a failure here leaves the task in verifying, which
    // the recovery adjudication re-runs — so a completed task can never
    // permanently miss its wisdom/digest (cross-review P1, round 5,
    // 2026-07-21). Snapshot and workflow summary are post-commit
    // conveniences; their failure must not un-complete the task, so they are
    // best-effort with a ledger warning instead.
    await commitTaskCompletionState(rootDir, {
      taskState,
      task,
      verifyResult,
      ledgerEvent: { type: "task_verified", planId: taskState.planId, taskId: task.id, scopeStatus: scopeResult.status, reviewStatus: "pass" },
      digestReason: "task_completed",
    });
    const sideEffectWarnings = await runPostCompletionSideEffects(rootDir, taskState.planId, task, async () => {
      await writeSnapshot(rootDir, "checkpointed", { planId: taskState.planId, taskId: task.id, scopeStatus: scopeResult.status });
      if (taskState.tasks.every((candidate) => candidate.status === "completed")) {
        await writeWorkflowSummary(rootDir, { reason: "all_tasks_completed" });
      }
    });
    return { status: "completed", task, workerResult, verifyResult, scopeResult, reviewResult, acceptanceProof, sideEffectWarnings };
  }

  if (pipelineResult.status === "checkpoint_failed") {
    // Every gate and the acceptance proof passed, but the checkpoint write
    // itself failed (e.g. checkpoints dir unwritable). Completion requires a
    // durable checkpoint, so the task goes back to pending for retry instead
    // of being silently marked completed.
    task.status = "pending";
    task.last_failure = buildFailureSummary(task, {
      workerResult,
      verifyResult,
      scopeResult,
      reviewResult,
      criteriaResult: criteria,
      nextStatus: task.status,
    });
    task.last_failure.reason = "checkpoint_failed";
    task.last_failure.summary = `checkpoint write failed: ${pipelineResult.evidence.checkpointError?.message || "unknown error"}`;
    task.last_failure.retryHint = "checkpoint 写入失败（检查 .helix/checkpoints 目录是否可写），修复后重跑即可，所有质量门已通过";
    task.updatedAt = nowIso();
    await writeFailureReport(rootDir, taskState.planId, task);
    await persistTaskState(rootDir, taskState);
    await appendLedger(rootDir, { type: "checkpoint_write_failed", planId: taskState.planId, taskId: task.id, error: pipelineResult.evidence.checkpointError?.message || null });
    await writeSnapshot(rootDir, "checkpoint_write_failed", { planId: taskState.planId, taskId: task.id });
    return { status: "retry", task, workerResult, verifyResult, scopeResult, reviewResult, acceptanceProof };
  }

  if (acceptanceProof) {
    // Every upstream gate passed, but acceptance-proof itself found a gap.
    task.status = shouldFailDeliveryAttempt(task, verifyResult, scopeResult, reviewResult) ? "failed" : "pending";
    task.last_failure = buildFailureSummary(task, {
      workerResult,
      verifyResult,
      scopeResult,
      reviewResult,
      criteriaResult: criteria,
      nextStatus: task.status,
    });
    task.last_failure.reason = "acceptance_proof_failed";
    task.last_failure.summary = `acceptance proof failed: ${acceptanceProof.checks.filter((check) => check.status === "fail").map((check) => check.name).join(", ")}`;
    task.updatedAt = nowIso();
    await writeFailureReport(rootDir, taskState.planId, task);
    await persistTaskState(rootDir, taskState);
    return { status: task.status === "failed" ? "failed" : "retry", task, workerResult, verifyResult, scopeResult, reviewResult, acceptanceProof };
  }

  task.status = shouldFailDeliveryAttempt(task, verifyResult, scopeResult, reviewResult) ? "failed" : "pending";
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
    task.owner = task.owner || "Jiuwei";
    task.coordination = await coordinateTaskClaim(rootDir, {
      planId: taskState.planId,
      task,
      owner: task.owner,
    });
    task.status = "in_progress";
    task.attempts += 1;
    task.updatedAt = nowIso();
    await persistTaskState(rootDir, taskState);
    await appendLedger(rootDir, { type: "node_execute_started", planId: taskState.planId, taskId: task.id, attempt: task.attempts });
    await writeSnapshot(rootDir, "node_execute_started", { planId: taskState.planId, taskId: task.id });
  } else {
    await assertCurrentTaskOwnership(rootDir, task);
  }

  const workspaceSnapshot = await recordPreExecuteSnapshot(rootDir, taskState.planId, task);
  const beforeDiff = await collectGitDiff(rootDir);
  const beforeChanged = await collectGitChangedPaths(rootDir);
  const workerEnvelope = await invokeCapability("worker", { rootDir, task, options });
  const workerResult = workerEnvelope.evidence;
  const afterDiff = await collectGitDiff(rootDir);
  const afterChanged = await collectGitChangedPaths(rootDir);

  task.status = "verifying";
  // A new worker round invalidates every gate result from previous rounds:
  // without this, a round whose checkpoint failed could leave passing
  // verify/scope/review evidence behind and let a later, unverified round
  // complete against it (cross-review P0, 2026-07-21).
  task.last_verify_result = null;
  task.last_scope_result = null;
  task.last_review_result = null;
  if (workspaceSnapshot) task.evidence.push(workspaceSnapshot);
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
  await assertCurrentTaskOwnership(rootDir, task);

  task.status = "verifying";
  const verifyEnvelope = await invokeCapability("verify", { rootDir, task });
  const verifyResult = verifyEnvelope.evidence;
  task.evidence.push(verifyResult);
  task.last_verify_result = verifyResult;
  const criterionEvidence = applyVerifierEvidenceToCriteria(task, verifyResult);
  if (!verifyResult.pass) {
    task.status = shouldFailDeliveryAttempt(task, verifyResult) ? "failed" : "pending";
    task.last_failure = buildFailureSummary(task, {
      workerResult: [...task.evidence].reverse().find((entry) => entry.kind === "worker") || { exitCode: 0 },
      verifyResult,
      scopeResult: task.last_scope_result || { status: "inconclusive" },
      nextStatus: task.status,
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
  return { status: verifyResult.pass ? "verified" : task.status === "failed" ? "failed" : "verify_failed", task, verifyResult };
}

export async function scopeTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-scope:${options.taskId || "next"}`, () => scopeTaskNodeUnlocked(rootDir, options));
}

async function scopeTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress", "pending"]);
  await assertCurrentTaskOwnership(rootDir, task);
  const executionPaths = [...task.evidence].reverse().find((entry) => entry.kind === "execution_paths");
  const scopeEnvelope = await invokeCapability("scope", {
    rootDir,
    task,
    options: {
      changedPaths: executionPaths?.afterAvailable === true ? executionPaths.introducedPaths : undefined,
      unavailableReason: executionPaths?.unavailableReason,
    },
  });
  const scopeResult = scopeEnvelope.evidence;
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
  await assertCurrentTaskOwnership(rootDir, task);
  const workerResult = [...task.evidence].reverse().find((entry) => entry.kind === "worker");
  const verifyResult = task.last_verify_result || [...task.evidence].reverse().find((entry) => entry.kind === "verifier");
  const scopeResult = task.last_scope_result || [...task.evidence].reverse().find((entry) => entry.kind === "scope_guard");
  const reviewEnvelope = await invokeCapability("review", { rootDir, task, evidence: { workerResult, verifyResult, scopeResult } });
  const reviewResult = reviewEnvelope.evidence;

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
  await assertCurrentTaskOwnership(rootDir, task);
  // A verifying task holding an admission_claim belongs to an in-flight (or
  // crash-resumable) parallel admission; the single-step checkpoint must not
  // complete it on that run's behalf (cross-review P1, round 6, 2026-07-21).
  if (task.admission_claim?.runId) {
    throw new Error(`task ${task.id} is claimed by parallel admission run ${task.admission_claim.runId}; 用同一 run 重新 admit 续跑，单步 checkpoint 不接管进行中的 admission`);
  }
  const workerResult = [...task.evidence].reverse().find((entry) => entry.kind === "worker");
  // Gate outcomes are read back via the pipeline's own step list, so the
  // single-step workflow cannot complete a task while skipping a gate that
  // the shared delivery pipeline would have run.
  const { evidence: gateEvidence, failedSteps } = collectGateEvidenceFromTask(task);
  const { verifyResult, scopeResult, reviewResult } = gateEvidence;
  const criteria = criteriaStatus(task);

  if (workerResult?.exitCode === 0 && criteria.pass && failedSteps.length === 0) {
    const completion = await runCompletionSegment(rootDir, taskState.planId, task, {
      workerResult,
      ...gateEvidence,
    }, {
      beforeCheckpointGate: () => taskOwnershipGate(rootDir, task.id),
    });
    const acceptanceProof = completion.proofEnvelope.evidence;
    if (completion.status === "proof_failed") {
      task.status = shouldFailDeliveryAttempt(task, verifyResult, scopeResult, reviewResult) ? "failed" : "pending";
      task.last_failure = buildFailureSummary(task, {
        workerResult,
        verifyResult,
        scopeResult,
        reviewResult,
        criteriaResult: criteria,
        nextStatus: task.status,
      });
      task.last_failure.reason = "acceptance_proof_failed";
      // acceptanceProof can be null when the proof capability threw (the
      // gateway converts throws into fail envelopes with null evidence).
      const failedChecks = (acceptanceProof?.checks || []).filter((check) => check.status === "fail").map((check) => check.name).join(", ");
      task.last_failure.summary = `acceptance proof failed: ${failedChecks || completion.proofEnvelope.error?.message || "acceptance proof capability failed"}`;
      task.updatedAt = nowIso();
      await writeFailureReport(rootDir, taskState.planId, task);
      await persistTaskState(rootDir, taskState);
      return { status: task.status === "failed" ? "failed" : "retry", task, verifyResult, scopeResult, reviewResult, acceptanceProof };
    }
    if (completion.status === "checkpoint_failed") {
      task.status = "pending";
      task.last_failure = buildFailureSummary(task, {
        workerResult,
        verifyResult,
        scopeResult,
        reviewResult,
        criteriaResult: criteria,
        nextStatus: task.status,
      });
      task.last_failure.reason = "checkpoint_failed";
      task.last_failure.summary = `checkpoint write failed: ${completion.checkpointEnvelope.error?.message || "unknown error"}`;
      task.last_failure.retryHint = "checkpoint 写入失败（检查 .helix/checkpoints 目录是否可写），修复后重跑即可，所有质量门已通过";
      task.updatedAt = nowIso();
      await writeFailureReport(rootDir, taskState.planId, task);
      await persistTaskState(rootDir, taskState);
      await appendLedger(rootDir, { type: "checkpoint_write_failed", planId: taskState.planId, taskId: task.id, error: completion.checkpointEnvelope.error?.message || null });
      await writeSnapshot(rootDir, "checkpoint_write_failed", { planId: taskState.planId, taskId: task.id });
      return { status: "retry", task, verifyResult, scopeResult, reviewResult, acceptanceProof };
    }
    if (completion.status === "revalidation_required") {
      task.status = "pending";
      task.coordination = {
        ...task.coordination,
        status: "stale",
        staleReason: completion.integrationGate?.reason || "task_ownership_changed",
      };
      task.last_failure = {
        at: nowIso(),
        reason: "task_ownership_changed",
        summary: completion.integrationGate?.error || "remote task ownership changed before checkpoint",
        retryHint: "旧设备必须停止写入；由当前远端 owner 重新运行质量门与 checkpoint",
      };
      task.updatedAt = nowIso();
      await writeFailureReport(rootDir, taskState.planId, task);
      await persistTaskState(rootDir, taskState);
      await appendLedger(rootDir, {
        type: "node_checkpoint_revalidation_required",
        planId: taskState.planId,
        taskId: task.id,
      });
      return { status: "revalidation_required", task, verifyResult, scopeResult, reviewResult, acceptanceProof };
    }
    // Checkpoint durably written — only now may the task become completed.
    // Ledger event first, then wisdom/digest (inside the transaction: a
    // failure leaves the task in verifying for recovery re-adjudication),
    // canonical tasks.json last (commit point); snapshot is post-commit and
    // best-effort. See the same ordering rationale in runNextTaskUnlocked.
    await commitTaskCompletionState(rootDir, {
      taskState,
      task,
      verifyResult,
      ledgerEvent: { type: "node_checkpoint_completed", planId: taskState.planId, taskId: task.id, scopeStatus: scopeResult?.status || "missing", reviewStatus: "pass" },
      digestReason: "task_completed",
    });
    const sideEffectWarnings = await runPostCompletionSideEffects(rootDir, taskState.planId, task, async () => {
      await writeSnapshot(rootDir, "node_checkpoint_completed", { planId: taskState.planId, taskId: task.id });
    });
    return { status: "completed", task, verifyResult, scopeResult, reviewResult, acceptanceProof, sideEffectWarnings };
  }

  task.status = shouldFailDeliveryAttempt(task, verifyResult, scopeResult, reviewResult) ? "failed" : "pending";
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
    const currentScopeEnvelope = await invokeCapability("scope", {
      rootDir,
      task,
      options: { changedPaths: stillChangedDeniedPaths, unavailableReason: currentChanged.reason },
    });
    const currentScope = currentScopeEnvelope.evidence;
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

async function recordPreExecuteSnapshot(rootDir, planId, task) {
  try {
    const snapshot = await captureWorkspaceSnapshot(rootDir, { label: `pre-execute ${task.id} attempt ${task.attempts}` });
    const entry = { ...snapshot, at: nowIso(), taskId: task.id };
    await appendLedger(rootDir, {
      type: snapshot.available ? "pre_execute_snapshot" : "pre_execute_snapshot_unavailable",
      planId,
      taskId: task.id,
      headCommit: snapshot.headCommit || null,
      stashCommit: snapshot.stashCommit || null,
      reason: snapshot.reason || null,
    });
    return entry;
  } catch (error) {
    // 快照是兜底手段，不能因为快照失败阻断任务执行本身
    return {
      kind: "workspace_snapshot",
      at: nowIso(),
      taskId: task.id,
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
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

async function taskOwnershipGate(rootDir, taskId) {
  const state = await loadTaskState(rootDir);
  const task = state?.tasks.find((candidate) => candidate.id === taskId);
  try {
    const ownership = await assertCurrentTaskOwnership(rootDir, task);
    return { pass: true, ownership };
  } catch (error) {
    return {
      pass: false,
      reason: "task_ownership_changed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
