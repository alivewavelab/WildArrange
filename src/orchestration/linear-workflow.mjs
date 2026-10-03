// =============================================================================
// 文件名称：linear-workflow.mjs
// 所属模块：orchestration
// 作用说明：
//   分步 workflow node：execute、checkpoint、retry（verify/scope/review 只经完整 pipeline 运行）。
//   只负责显式节点的状态推进；连续 run 的任务选择与 worker 全周期在 linear-runtime.mjs。
// =============================================================================
import { appendLedger } from "../infra/ledger.mjs";
import { ensureWildArrangeDirs, nowIso } from "../infra/runtime-store.mjs";
import { transactWithLedger, withTaskStateLock } from "../infra/task-state-lock.mjs";
import { ensureTaskPacket, writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { readChangeRequest, writeChangeRequest } from "./change-governance.mjs";
import { buildFailureSummary } from "../infra/failure-analysis.mjs";
import { buildChangedPathDiffEvidence, changedPathsIntroducedByTask, collectGitChangedPaths } from "../infra/git-diff.mjs";
import { criteriaStatus } from "../infra/success-criteria.mjs";
import { invokeCapability } from "../capabilities/gateway.mjs";
import { normalizeRelativePath } from "../infra/path-match.mjs";
import { runDeliveryPipeline, shouldFailDeliveryAttempt } from "./delivery-pipeline.mjs";
import { loadPlanApproval, loadTaskState } from "./plan-state.mjs";
import { persistTaskState, writeOutbox } from "./task-board.mjs";
import { findRunnableTask } from "../infra/task-predicates.mjs";
import { resolveTaskBranchTarget } from "./task-branch.mjs";
import { assertCommandWorkerAgent } from "../infra/agent-registry.mjs";
import { assertAdmissionWorkspaceAvailable } from "./integration.mjs";
import { ensureLinearDeliveryWorkspace, recordPreExecuteSnapshot } from "./linear-delivery.mjs";
import { DEFAULT_RECOVERY_HINTS, applyPipelineOutcome, persistCommandRecovery, persistTaskFailure, recordGateEvidence } from "./task-recovery.mjs";

// --- 分步 workflow node ---

/** 分步 workflow 入口：execute/checkpoint/retry。 */
export async function runLinearWorkflowNode(rootDir, nodeName, options = {}) {
  if (nodeName === "execute") {
    return executeTaskNode(rootDir, options);
  }
  if (nodeName === "checkpoint") {
    return checkpointTaskNode(rootDir, options);
  }
  if (nodeName === "retry") {
    return retryTaskNode(rootDir, options);
  }
  throw new Error(`unknown workflow node: ${nodeName}`);
}

/** 仅执行 worker 阶段（execute node）。 */
export async function executeTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-execute:${options.taskId || "next"}`, () => executeTaskNodeUnlocked(rootDir, options));
}

/** 锁内执行 worker 节点并更新 verifying 状态。 */
async function executeTaskNodeUnlocked(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");

  const approval = await loadPlanApproval(rootDir);
  if (approval.required && approval.status !== "approved" && approval.planId === taskState.planId) {
    return { status: "awaiting_plan_approval", task: null, planId: taskState.planId };
  }

  const task = resolveNodeTask(taskState.tasks, options.taskId, ["pending", "in_progress"]);
  const readinessEnvelope = await invokeCapability("execution-readiness", { rootDir, task, options });
  const readiness = readinessEnvelope.evidence;
  if (readinessEnvelope.status !== "pass") {
    if (readiness?.commandRecovery) {
      task.status = "needs_user_decision";
      task.last_readiness_result = readiness;
      await transactWithLedger(rootDir, {
        type: "node_readiness_recovery_required",
        planId: taskState.planId,
        taskId: task.id,
      }, () => persistTaskState(rootDir, taskState));
    }
    return { status: readiness?.commandRecovery ? "recovery_required" : "readiness_blocked", task, readiness, error: readinessEnvelope.error };
  }
  await ensureTaskPacket(rootDir, taskState.planId, task);
  options = { ...options, executionContextPath: readiness?.contextPath };
  task.owner = assertCommandWorkerAgent(task.owner || "Jiuwei");
  if (task.status === "pending") {
    task.coordination = await resolveTaskBranchTarget(rootDir, {
      planId: taskState.planId,
      task,
    });
    task.status = "in_progress";
    task.attempts += 1;
    task.updatedAt = nowIso();
    await transactWithLedger(rootDir, {
      type: "node_execute_started",
      planId: taskState.planId,
      taskId: task.id,
      attempt: task.attempts,
    }, () => persistTaskState(rootDir, taskState));
    await writeSnapshot(rootDir, "node_execute_started", { planId: taskState.planId, taskId: task.id });
  }

  const deliveryWorkspace = await ensureLinearDeliveryWorkspace(rootDir, taskState.planId, task, taskState.tasks);
  await transactWithLedger(rootDir, {
    type: "node_execute_workspace_prepared",
    planId: taskState.planId,
    taskId: task.id,
    worktree: deliveryWorkspace?.workDir || null,
  }, () => persistTaskState(rootDir, taskState));
  const executionRoot = deliveryWorkspace?.workDir || rootDir;
  const workspaceSnapshot = await recordPreExecuteSnapshot(rootDir, taskState.planId, task, executionRoot);
  const beforeChanged = await collectGitChangedPaths(executionRoot);
  const workerEnvelope = await invokeCapability("worker", { rootDir, task, options: { ...options, executionRoot } });
  const workerResult = workerEnvelope.evidence;
  const afterChanged = await collectGitChangedPaths(executionRoot);

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
  task.evidence.push(buildChangedPathDiffEvidence(beforeChanged, afterChanged, { at: nowIso() }));
  task.evidence.push({
    kind: "execution_paths",
    at: nowIso(),
    beforeAvailable: beforeChanged.available,
    afterAvailable: afterChanged.available,
    beforePaths: beforeChanged.paths || [],
    afterPaths: afterChanged.paths || [],
    introducedPaths: deliveryWorkspace ? afterChanged.paths || [] : changedPathsIntroducedByTask(beforeChanged, afterChanged) || [],
    unavailableReason: beforeChanged.available ? afterChanged.reason : beforeChanged.reason,
  });
  task.updatedAt = nowIso();
  await transactWithLedger(rootDir, {
    type: "node_execute_completed",
    planId: taskState.planId,
    taskId: task.id,
    exitCode: workerResult.exitCode,
  }, () => persistTaskState(rootDir, taskState));
  await writeOutbox(rootDir, task, workerResult);
  await writeSnapshot(rootDir, "node_execute_completed", { planId: taskState.planId, taskId: task.id, exitCode: workerResult.exitCode });
  if (workerResult?.recoveryRequired === true || workerResult?.terminationFailed === true) {
    return persistCommandRecovery(rootDir, taskState, task, workerResult, {
      event: { type: NODE_EVENTS.commandRecovery },
      retryHint: DEFAULT_RECOVERY_HINTS.commandRecovery,
    });
  }
  return { status: "executed", task, workerResult };
}

/** 运行 completion 段：完整 delivery pipeline + acceptance-proof + checkpoint（checkpoint node）。 */
export async function checkpointTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-checkpoint:${options.taskId || "next"}`, () => checkpointTaskNodeWithinLock(rootDir, options));
}

/** 单步 checkpoint 各 pipeline 分支的 ledger 事件类型。 */
const NODE_EVENTS = {
  awaiting: "node_checkpoint_awaiting_user_decision",
  revalidation: "node_checkpoint_revalidation_required",
  completed: "node_checkpoint_completed",
  rejected: "node_checkpoint_rejected",
  proofFailed: "acceptance_proof_failed",
  commandRecovery: "command_recovery_required",
};

/**
 * 锁内对 worker 已成功的任务重跑完整 delivery pipeline 并落盘结果。
 * gate 证据总是由 pipeline 现场重新产生，不复用任何旧一轮的 verify/scope/review 结果。
 */
export async function checkpointTaskNodeWithinLock(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress"]);
  if (task.last_failure?.reason === "command_termination_failed" && options.force !== true) {
    return { status: "recovery_required", task, commandEvidence: task.last_failure.commandEvidence || null };
  }
  // A verifying task holding an admission_claim belongs to an in-flight (or
  // crash-resumable) parallel admission; the single-step checkpoint must not
  // complete it on that run's behalf (cross-review P1, round 6, 2026-07-21).
  if (task.admission_claim?.runId) {
    throw new Error(`task ${task.id} is claimed by parallel admission run ${task.admission_claim.runId}; 用同一 run 重新 admit 续跑，单步 checkpoint 不接管进行中的 admission`);
  }
  // 先拒绝再建 worktree：claim 期间任务分支被 admission 的 run worktree 占用，此处不得有任何 worktree 副作用。
  const deliveryWorkspace = await ensureLinearDeliveryWorkspace(rootDir, taskState.planId, task, taskState.tasks);
  const workerResult = [...task.evidence].reverse().find((entry) => entry.kind === "worker");

  if (workerResult?.exitCode === 0) {
    const executionPaths = [...task.evidence].reverse().find((entry) => entry.kind === "execution_paths");
    const current = deliveryWorkspace ? await collectGitChangedPaths(deliveryWorkspace.workDir) : { available: false, reason: "not_git" };
    const pipeline = await runDeliveryPipeline(rootDir, taskState.planId, task, {
      initialEvidence: { workerResult },
      changedPaths: current.available ? current.paths : (executionPaths?.afterAvailable === true ? executionPaths.introducedPaths : undefined),
      unavailableReason: current.reason,
      executionRoot: deliveryWorkspace?.workDir || rootDir,
      runId: deliveryWorkspace?.runId,
    });
    await recordGateEvidence(rootDir, taskState.planId, task, pipeline);
    if (pipeline.evidence.integrationCommit) task.delivery = pipeline.evidence.integrationCommit;
    return applyPipelineOutcome(rootDir, taskState, task, pipeline, {
      workerResult,
      events: NODE_EVENTS,
      hints: DEFAULT_RECOVERY_HINTS,
      changeRequestSource: "checkpoint",
      keepCommittedDelivery: true,
      afterCompleted: () => writeSnapshot(rootDir, "node_checkpoint_completed", { planId: taskState.planId, taskId: task.id }),
    });
  }

  // worker 缺失或失败：不进入 gates，按 worker_failed 记失败。
  const nextStatus = shouldFailDeliveryAttempt(task, task.last_verify_result, task.last_scope_result, task.last_review_result) ? "failed" : "pending";
  const failure = buildFailureSummary(task, {
    workerResult: workerResult || { exitCode: 1 },
    verifyResult: task.last_verify_result || { pass: false },
    scopeResult: task.last_scope_result || { status: "inconclusive" },
    reviewResult: task.last_review_result || { pass: false, lanes: [{ name: "review_gate", status: "fail", summary: "review gate has not passed" }] },
    criteriaResult: criteriaStatus(task),
    nextStatus,
  });
  await persistTaskFailure(rootDir, taskState, task, {
    status: nextStatus,
    failure,
    event: { type: NODE_EVENTS.rejected, nextStatus, reason: failure.reason, retryHint: failure.retryHint },
    snapshot: NODE_EVENTS.rejected,
  });
  return { status: task.status === "failed" ? "failed" : "retry", task };
}

/** 失败任务重试：重置状态并重新进入 execute 流程（retry node）。 */
export async function retryTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-retry:${options.taskId || "next"}`, () => retryTaskNodeUnlocked(rootDir, options));
}

/** 锁内将 failed/pending 任务重置为可重试状态。 */
async function retryTaskNodeUnlocked(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");
  const task = resolveRetryTask(taskState.tasks, options.taskId);
  const failure = task.last_failure;

  if (failure?.reason === "scope_guard_failed" && options.force !== true) {
    const scopeResult = task.last_scope_result || [...task.evidence].reverse().find((entry) => entry.kind === "scope_guard");
    if (!task.last_change_request && scopeResult?.status === "fail") {
      task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "retry_block");
      await transactWithLedger(rootDir, {
        type: "node_retry_change_request_recorded",
        planId: taskState.planId,
        taskId: task.id,
        changeRequestId: task.last_change_request?.id || null,
      }, () => persistTaskState(rootDir, taskState));
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
  await transactWithLedger(rootDir, {
    type: "node_retry_reopened",
    planId: taskState.planId,
    taskId: task.id,
    manualRetryCount: task.manual_retry_count,
    previousReason: failure?.reason || "unknown",
  }, () => persistTaskState(rootDir, taskState));
  await writeSnapshot(rootDir, "node_retry_reopened", { planId: taskState.planId, taskId: task.id });
  return { status: "pending", task, failure };
}

/** 解析单步 node 命令目标任务与允许状态。 */
function resolveNodeTask(tasks, taskId, allowedStatuses) {
  assertAdmissionWorkspaceAvailable(tasks);
  const task = taskId ? tasks.find((candidate) => candidate.id === taskId) : findRunnableTask(tasks) || tasks.find((candidate) => allowedStatuses.includes(candidate.status));
  if (!task) throw new Error(taskId ? `unknown task: ${taskId}` : "no task available for node");
  if (!allowedStatuses.includes(task.status)) {
    throw new Error(`task ${task.id} status ${task.status} cannot run this node`);
  }
  return task;
}

/** 解析 retry 命令目标任务。 */
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
