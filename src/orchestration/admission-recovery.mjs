import { appendLedger, nowIso } from "../infra/foundation.mjs";
import { writeFailureReport } from "../infra/task-reports.mjs";
import { persistTaskState } from "./task-board.mjs";

export async function persistAdmissionRevalidation(rootDir, taskState, task, options) {
  const fence = options.fence || {};
  task.status = "pending";
  task.admission_claim = null;
  task.last_failure = {
    at: nowIso(),
    reason: fence.reason || "integration_head_changed",
    summary: fence.reason === "task_ownership_changed"
      ? `remote task ownership changed: ${fence.ownership?.error || "unknown owner fence failure"}`
      : fence.reason === "integration_base_not_present_in_workspace"
        ? `current workspace does not contain guarded integration base ${fence.expectedSha || "missing"}`
        : fence.reason === "workspace_contains_unattributed_changes"
          ? `workspace contains changes not attributed to this run: ${(fence.unattributedPaths || []).join(", ")}`
          : `remote integration branch changed from ${fence.expectedSha || "missing"} to ${fence.actualSha || "missing"}`,
    retryHint: fence.reason === "task_ownership_changed"
      ? "停止旧设备写入；只能由当前远端 owner 重新生成结果并执行 admission"
      : "先获取远端集成分支，把任务成果重新应用到最新主线，再从 verify 开始重跑全部 gates",
  };
  task.updatedAt = nowIso();
  await writeFailureReport(rootDir, taskState.planId, task);
  await appendLedger(rootDir, {
    type: "parallel_admission_revalidation_required",
    planId: taskState.planId,
    taskId: task.id,
    runId: options.runId,
    expectedSha: fence.expectedSha || null,
    actualSha: fence.actualSha || null,
    reason: fence.reason || null,
  });
  await persistTaskState(rootDir, taskState);
  if (typeof options.removeRollbackPlan === "function") {
    await options.removeRollbackPlan();
  }
  return {
    status: "revalidation_required",
    planId: taskState.planId,
    task,
    acceptanceProof: options.acceptanceProof,
    verifyResult: options.verifyResult,
    scopeResult: options.scopeResult,
    reviewResult: options.reviewResult,
    rollback: options.rollback,
  };
}

export async function persistPostIntegrationRecovery(rootDir, taskState, task, options) {
  task.status = "verifying";
  task.last_failure = {
    at: nowIso(),
    reason: options.checkpointFailed
      ? "checkpoint_failed_after_integration"
      : "post_integration_recovery_required",
    summary: options.summary,
    retryHint: `远端代码已经集成或曾经集成；禁止回滚、释放或换 run。确认远端历史后，用同一 run ${options.runId} 恢复`,
  };
  task.updatedAt = nowIso();
  await writeFailureReport(rootDir, taskState.planId, task);
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: options.checkpointFailed
      ? "checkpoint_write_failed_after_integration"
      : "post_integration_recovery_required",
    planId: taskState.planId,
    taskId: task.id,
    runId: options.runId,
    integrationSha: options.integrationCommit?.integrationSha || null,
    error: options.error || options.integrationCommit?.reason || null,
  });
  return {
    status: "recovery_required",
    planId: taskState.planId,
    task,
    acceptanceProof: options.acceptanceProof,
    verifyResult: options.verifyResult,
    scopeResult: options.scopeResult,
    reviewResult: options.reviewResult,
    rollback: { status: "not_attempted", reason: "remote_integration_already_pushed" },
  };
}
