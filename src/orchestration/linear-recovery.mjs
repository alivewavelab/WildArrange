// =============================================================================
// 文件名称：linear-recovery.mjs
// 所属模块：orchestration
// 作用说明：
//   线性任务的失败状态、恢复状态与 ownership 二次验权。
//   只负责把既定结果写入 ledger-first 的任务状态；不调度 worker，
//   不决定 gate 顺序，也不直接实现 capability。
//
// 【运行原理速读】
//   gate/worker 发现异常 → 本模块生成失败事实 → ledger → task state；
//   下次 run 或 checkpoint 根据这些事实继续恢复，不重复执行未知 worker。
// =============================================================================
import { nowIso } from "../infra/runtime-store.mjs";
import { transactWithLedger } from "../infra/task-state-lock.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { buildFailureSummary } from "../infra/failure-analysis.mjs";
import { writeFailureReport } from "../infra/task-reports.mjs";
import { shouldFailDeliveryAttempt } from "./delivery-pipeline.mjs";
import { persistTaskState } from "./task-board.mjs";
import { loadTaskState } from "./plan-state.mjs";
import { assertTaskOrDeliveredOwnership } from "./integration.mjs";

/** 命令终止未确认时持久化 recovery_required 状态。 */
export async function persistCommandRecoveryRequired(rootDir, taskState, task, commandEvidence, result = {}) {
  task.status = "verifying";
  task.last_failure = {
    at: nowIso(),
    reason: "command_termination_failed",
    summary: `command timed out and its process could not be confirmed stopped${commandEvidence?.pid ? ` (pid ${commandEvidence.pid})` : ""}`,
    retryHint: "确认残留进程已经终止后，再从同一 task worktree 和 delivery intent 恢复；不要重新执行 worker。",
    commandEvidence,
  };
  task.updatedAt = nowIso();
  await writeFailureReport(rootDir, taskState.planId, task);
  await transactWithLedger(rootDir, {
    type: "command_recovery_required",
    planId: taskState.planId,
    taskId: task.id,
    pid: commandEvidence?.pid || null,
  }, () => persistTaskState(rootDir, taskState));
  return { status: "recovery_required", task, ...result };
}

/** 集成基线变化时持久化 revalidation_required。 */
export async function persistRevalidationRequired(rootDir, taskState, task, { integrationGuard, summaryFallback, retryHint, ledgerEvent }) {
  task.status = "pending";
  task.coordination = {
    ...task.coordination,
    status: "stale",
    staleReason: integrationGuard?.reason || "task_ownership_changed",
  };
  task.last_failure = {
    at: nowIso(),
    reason: "task_ownership_changed",
    summary: integrationGuard?.error || summaryFallback,
    retryHint,
  };
  task.updatedAt = nowIso();
  await writeFailureReport(rootDir, taskState.planId, task);
  await transactWithLedger(rootDir, ledgerEvent, () => persistTaskState(rootDir, taskState));
}

/** checkpoint 写入失败时将任务回 pending 并记账。 */
export async function persistCheckpointWriteFailure(rootDir, taskState, task, { workerResult, verifyResult, scopeResult, reviewResult, criteria, checkpointError }) {
  task.status = task.delivery?.integrationSha || task.delivery?.commitSha ? "verifying" : "pending";
  task.last_failure = buildFailureSummary(task, {
    workerResult,
    verifyResult,
    scopeResult,
    reviewResult,
    criteriaResult: criteria,
    nextStatus: task.status,
  });
  task.last_failure.reason = "checkpoint_failed";
  task.last_failure.summary = `checkpoint write failed: ${checkpointError || "unknown error"}`;
  task.last_failure.retryHint = "checkpoint 写入失败（检查 .wildarrange/checkpoints 目录是否可写），修复后重跑即可，所有质量门已通过";
  task.updatedAt = nowIso();
  await writeFailureReport(rootDir, taskState.planId, task);
  await transactWithLedger(rootDir, {
    type: "checkpoint_write_failed",
    planId: taskState.planId,
    taskId: task.id,
    error: checkpointError || null,
  }, () => persistTaskState(rootDir, taskState));
  await writeSnapshot(rootDir, "checkpoint_write_failed", { planId: taskState.planId, taskId: task.id });
}

/** acceptance proof 失败时持久化 blocked 摘要。 */
export async function persistAcceptanceProofFailure(rootDir, taskState, task, { workerResult, verifyResult, scopeResult, reviewResult, criteria, failureSummary }) {
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
  task.last_failure.summary = failureSummary;
  task.updatedAt = nowIso();
  await writeFailureReport(rootDir, taskState.planId, task);
  await transactWithLedger(rootDir, {
    type: "acceptance_proof_failed",
    planId: taskState.planId,
    taskId: task.id,
    nextStatus: task.status,
    reason: task.last_failure.reason,
  }, () => persistTaskState(rootDir, taskState));
}

/** Git 协调开启时校验当前设备仍持有任务写 ownership。 */
export async function taskOwnershipGate(rootDir, taskId) {
  const state = await loadTaskState(rootDir);
  const task = state?.tasks.find((candidate) => candidate.id === taskId);
  try {
    const ownership = await assertTaskOrDeliveredOwnership(rootDir, state?.planId, task);
    return { pass: true, ownership };
  } catch (error) {
    return {
      pass: false,
      reason: "task_ownership_changed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}