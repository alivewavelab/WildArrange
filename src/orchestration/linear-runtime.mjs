// =============================================================================
// 文件名称：linear-runtime.mjs
// 所属模块：orchestration
// 作用说明：
//   线性任务运行时：连续 runNextTask 的任务选择、worker 执行与交付流水线。
//   分步 workflow node 由 linear-workflow.mjs 持有。
//
// 【运行原理速读】
//   可以把它想成「一次只推进一个任务的流水线司机」：
//
//   · 何时执行？
//     wildarrange run、workflow 循环或分步 node CLI。
//
//   · 做了什么？
//     找 runnable → claim → worker → delivery-pipeline → completed 或失败/重试。
//
//   · 约束？
//     runNextTask().status 是下一步动作；持久 status 以 task.status 为准。
// =============================================================================
import { runHostRoute } from "./host-runtime.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import {
  ensureWildArrangeDirs,
  nowIso,
} from "../infra/runtime-store.mjs";
import { transactWithLedger, withTaskStateLock } from "../infra/task-state-lock.mjs";
import { ensureTaskPacket, writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { readChangeRequest, writeChangeRequest } from "./change-governance.mjs";
import { buildFailureSummary } from "../infra/failure-analysis.mjs";
import { writeFailureReport, writeReviewReport } from "../infra/task-reports.mjs";
import { routeRequest } from "../ai/routing.mjs";
import { buildChangedPathDiffEvidence, changedPathsIntroducedByTask, collectGitChangedPaths } from "../infra/git-diff.mjs";
import { invokeCapability } from "../capabilities/gateway.mjs";
import {
  commitTaskCompletionState,
  runDeliveryPipeline,
  runPostCompletionSideEffects,
  shouldFailDeliveryAttempt,
} from "./delivery-pipeline.mjs";
import { writeWorkflowSummary } from "./status.mjs";
import { loadPlanApproval, loadTaskState } from "./plan-state.mjs";
import { findRunnableTask, persistTaskState, writeOutbox } from "./task-board.mjs";
import { coordinateTaskClaim } from "./remote-ownership.mjs";
import { assertCommandWorkerAgent } from "../infra/agent-registry.mjs";
import { assertContractWorkspaceAvailable } from "./integration.mjs";
import { ensureLinearDeliveryWorkspace } from "./linear-delivery.mjs";
import {
  persistAcceptanceProofFailure,
  persistCheckpointWriteFailure,
  persistCommandRecoveryRequired,
  persistRevalidationRequired,
  taskOwnershipGate,
} from "./linear-recovery.mjs";
import { recordPreExecuteSnapshot } from "./linear-task-support.mjs";
import { checkpointTaskNodeWithinLock } from "./linear-workflow.mjs";
import {
  runLinearWorkflowNode,
  executeTaskNode,
  verifyTaskNode,
  scopeTaskNode,
  reviewTaskNode,
  checkpointTaskNode,
  retryTaskNode,
} from "./linear-workflow.mjs";

export {
  executeTaskNode,
  verifyTaskNode,
  scopeTaskNode,
  reviewTaskNode,
  checkpointTaskNode,
  retryTaskNode,
};

/** 分步 workflow 入口；route 保留在 linear-runtime 以维持唯一的 orchestration → ai 边界。 */
export async function runWorkflowNode(rootDir, nodeName, options = {}) {
  if (nodeName === "route") return runHostRoute(rootDir, { text: options.text }, routeRequest);
  return runLinearWorkflowNode(rootDir, nodeName, options);
}

// --- 主循环 ---

/** 在 tasks.lock 下推进下一个 runnable 任务（worker + gates 全周期）。 */
export async function runNextTask(rootDir, options = {}) {
  return withTaskStateLock(rootDir, "run-next-task", () => runNextTaskUnlocked(rootDir, options));
}

/** 锁内选取并推进下一个可运行线性任务节点。 */
async function runNextTaskUnlocked(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");

  const approval = await loadPlanApproval(rootDir);
  if (approval.required && approval.status !== "approved" && approval.planId === taskState.planId) {
    await appendLedger(rootDir, { type: "run_blocked_awaiting_plan_approval", planId: taskState.planId });
    return {
      status: "awaiting_plan_approval",
      task: null,
      planId: taskState.planId,
      approveHint: "开发者确认计划后放行：node ./bin/wildarrange.mjs plan approve（或在编辑器里用 /wildarrange-approve）",
    };
  }

  assertContractWorkspaceAvailable(taskState.tasks);
  const task = findRunnableTask(taskState.tasks);
  if (!task) {
    const waiting = taskState.tasks.find((candidate) => candidate.pendingContractChange);
    if (waiting) return { status: "awaiting_user_decision", task: waiting, changeRequest: await readChangeRequest(rootDir, waiting.pendingContractChange) };
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
    // §3.4：持有 admission_claim 的 verifying 任务禁止 linear run 劫持，须由原 run 续跑 admission。
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
      const adjudicated = await checkpointTaskNodeWithinLock(rootDir, { taskId: interrupted.id });
      return { ...adjudicated, resumed: "verifying_task_adjudicated" };
    }
    const unfinished = taskState.tasks.filter((candidate) => candidate.status !== "completed");
    const status = unfinished.length === 0 ? "complete" : "blocked";
    await appendLedger(rootDir, { type: "run_idle", status });
    return { status, task: null };
  }

  const readinessEnvelope = await invokeCapability("execution-readiness", { rootDir, task, options });
  const readiness = readinessEnvelope.evidence;
  if (readinessEnvelope.status !== "pass") {
    if (readiness?.commandRecovery) {
      task.status = "needs_user_decision";
      task.last_readiness_result = readiness;
      await transactWithLedger(rootDir, {
        type: "task_readiness_recovery_required",
        planId: taskState.planId,
        taskId: task.id,
      }, () => persistTaskState(rootDir, taskState));
    }
    return { status: readiness?.commandRecovery ? "recovery_required" : "readiness_blocked", task, readiness, error: readinessEnvelope.error };
  }
  await ensureTaskPacket(rootDir, taskState.planId, task);
  options = { ...options, executionContextPath: readiness?.contextPath };
  task.owner = assertCommandWorkerAgent(task.owner || "Jiuwei");
  task.coordination = await coordinateTaskClaim(rootDir, {
    planId: taskState.planId,
    task,
    owner: task.owner,
  });
  const deliveryWorkspace = await ensureLinearDeliveryWorkspace(rootDir, taskState.planId, task, taskState.tasks);
  task.status = "in_progress";
  task.attempts += 1;
  task.updatedAt = nowIso();
  await transactWithLedger(rootDir, {
    type: "task_started",
    planId: taskState.planId,
    taskId: task.id,
    attempt: task.attempts,
  }, () => persistTaskState(rootDir, taskState));
  await writeSnapshot(rootDir, "task_started", { planId: taskState.planId, taskId: task.id, attempt: task.attempts });

  const executionRoot = deliveryWorkspace?.workDir || rootDir;
  const workspaceSnapshot = await recordPreExecuteSnapshot(rootDir, taskState.planId, task, executionRoot);
  const beforeChanged = await collectGitChangedPaths(executionRoot);
  const workerEnvelope = await invokeCapability("worker", { rootDir, task, options: { ...options, executionRoot } });
  const workerResult = workerEnvelope.evidence;
  const afterChanged = await collectGitChangedPaths(executionRoot);

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
  task.evidence.push(buildChangedPathDiffEvidence(beforeChanged, afterChanged, { at: nowIso() }));
  task.updatedAt = nowIso();
  await transactWithLedger(rootDir, {
    type: "worker_done_claim",
    planId: taskState.planId,
    taskId: task.id,
    exitCode: workerResult.exitCode,
  }, () => persistTaskState(rootDir, taskState));
  await writeOutbox(rootDir, task, workerResult);
  await writeSnapshot(rootDir, "worker_done", { planId: taskState.planId, taskId: task.id, exitCode: workerResult.exitCode });

  if (workerResult?.recoveryRequired === true || workerResult?.terminationFailed === true) {
    return persistCommandRecoveryRequired(rootDir, taskState, task, workerResult);
  }

  // Shared delivery pipeline owns gate order (verify -> scope -> review ->
  // acceptance-proof -> checkpoint); see src/orchestration/delivery-pipeline.mjs.
  // This function still owns every reporting/ledger side effect itself so
  // observable behavior (files written, ledger entries, evidence shape)
  // stays identical to before the pipeline existed.
  const pipelineResult = await runDeliveryPipeline(rootDir, taskState.planId, task, {
    initialEvidence: { workerResult },
    changedPaths: deliveryWorkspace ? afterChanged.paths : changedPathsIntroducedByTask(beforeChanged, afterChanged),
    unavailableReason: beforeChanged.available ? afterChanged.reason : beforeChanged.reason,
    executionRoot,
    runId: deliveryWorkspace?.runId,
    preCompletionGate: () => taskOwnershipGate(rootDir, task.id),
  });
  const verifyResult = pipelineResult.evidence.verifyResult;
  const scopeResult = pipelineResult.evidence.scopeResult;
  const reviewResult = pipelineResult.evidence.reviewResult;
  const acceptanceProof = pipelineResult.evidence.acceptanceProof || null;
  const criteria = pipelineResult.criteria;
  if (pipelineResult.evidence.integrationCommit) task.delivery = pipelineResult.evidence.integrationCommit;

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

  if (pipelineResult.status === "awaiting_user_decision") {
    await transactWithLedger(rootDir, {
      type: "task_awaiting_user_decision",
      planId: taskState.planId,
      taskId: task.id,
      changeRequestId: pipelineResult.changeRequest?.id || null,
    }, () => persistTaskState(rootDir, taskState));
    return { status: "awaiting_user_decision", task, changeRequest: pipelineResult.changeRequest, verifyResult, scopeResult, reviewResult };
  }
  if (pipelineResult.status === "recovery_required") {
    return persistCommandRecoveryRequired(rootDir, taskState, task, pipelineResult.evidence.commandRecovery, {
      workerResult, verifyResult, scopeResult, reviewResult,
    });
  }

  if (pipelineResult.status === "revalidation_required") {
    await persistRevalidationRequired(rootDir, taskState, task, {
      integrationGuard: pipelineResult.evidence.integrationGuard,
      summaryFallback: "remote task ownership changed before completion",
      retryHint: "旧设备必须停止写入；由当前远端 owner 继续任务并重新运行全部质量门",
      ledgerEvent: { type: "task_completion_revalidation_required", planId: taskState.planId, taskId: task.id, reason: "task_ownership_changed" },
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
    await persistCheckpointWriteFailure(rootDir, taskState, task, {
      workerResult,
      verifyResult,
      scopeResult,
      reviewResult,
      criteria,
      checkpointError: pipelineResult.evidence.checkpointError?.message,
    });
    return { status: task.status === "verifying" ? "recovery_required" : "retry", task, workerResult, verifyResult, scopeResult, reviewResult, acceptanceProof };
  }

  if (acceptanceProof) {
    // Every upstream gate passed, but acceptance-proof itself found a gap.
    await persistAcceptanceProofFailure(rootDir, taskState, task, {
      workerResult,
      verifyResult,
      scopeResult,
      reviewResult,
      criteria,
      failureSummary: `acceptance proof failed: ${acceptanceProof.checks.filter((check) => check.status === "fail").map((check) => check.name).join(", ")}`,
    });
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
  await transactWithLedger(rootDir, {
    type: "task_rejected",
    planId: taskState.planId,
    taskId: task.id,
    nextStatus: task.status,
    attempt: task.attempts,
    reason: task.last_failure.reason,
    retryHint: task.last_failure.retryHint,
  }, () => persistTaskState(rootDir, taskState));
  await writeSnapshot(rootDir, "task_rejected", { planId: taskState.planId, taskId: task.id, nextStatus: task.status });
  return { status: task.status === "failed" ? "failed" : "retry", task, workerResult, verifyResult, scopeResult, reviewResult };
}
