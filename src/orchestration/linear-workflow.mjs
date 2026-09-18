// =============================================================================
// 文件名称：linear-workflow.mjs
// 所属模块：orchestration
// 作用说明：
//   分步 workflow node：execute、verify、scope、review、checkpoint、retry。
//   只负责显式节点的状态推进；连续 run 的任务选择与 worker 全周期在 linear-runtime.mjs。
// =============================================================================
import { appendLedger } from "../infra/ledger.mjs";
import { ensureWildArrangeDirs, nowIso } from "../infra/runtime-store.mjs";
import { transactWithLedger, withTaskStateLock } from "../infra/task-state-lock.mjs";
import { ensureTaskPacket, writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { readChangeRequest, writeChangeRequest } from "./change-governance.mjs";
import { prepareContractReview } from "./contract-governance.mjs";
import { buildFailureSummary } from "../infra/failure-analysis.mjs";
import { writeFailureReport, writeReviewReport } from "../infra/task-reports.mjs";
import { buildChangedPathDiffEvidence, changedPathsIntroducedByTask, collectGitChangedPaths } from "../infra/git-diff.mjs";
import { applyVerifierEvidenceToCriteria, criteriaStatus } from "../infra/success-criteria.mjs";
import { invokeCapability } from "../capabilities/gateway.mjs";
import { normalizeRelativePath } from "../infra/path-match.mjs";
import {
  commitTaskCompletionState,
  runDeliveryPipeline,
  runPostCompletionSideEffects,
  shouldFailDeliveryAttempt,
  collectGateEvidenceFromTask,
} from "./delivery-pipeline.mjs";
import { loadPlanApproval, loadTaskState } from "./plan-state.mjs";
import { findRunnableTask, persistTaskState, writeOutbox } from "./task-board.mjs";
import { assertCurrentTaskOwnership, coordinateTaskClaim } from "./remote-ownership.mjs";
import { assertCommandWorkerAgent } from "../infra/agent-registry.mjs";
import { assertTaskOrDeliveredOwnership, assertContractWorkspaceAvailable } from "./integration.mjs";
import { ensureLinearDeliveryWorkspace } from "./linear-delivery.mjs";
import {
  persistAcceptanceProofFailure,
  persistCheckpointWriteFailure,
  persistCommandRecoveryRequired,
  persistRevalidationRequired,
  taskOwnershipGate,
} from "./linear-recovery.mjs";
import { recordPreExecuteSnapshot } from "./linear-task-support.mjs";

// --- 分步 workflow node ---

/** 分步 workflow 入口：execute/verify/scope/review/checkpoint/retry。 */
export async function runLinearWorkflowNode(rootDir, nodeName, options = {}) {
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
    task.coordination = await coordinateTaskClaim(rootDir, {
      planId: taskState.planId,
      task,
      owner: task.owner,
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
  } else {
    await assertCurrentTaskOwnership(rootDir, task);
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
    return persistCommandRecoveryRequired(rootDir, taskState, task, workerResult);
  }
  return { status: "executed", task, workerResult };
}

/** 仅运行 verify gate（verify node）。 */
export async function verifyTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-verify:${options.taskId || "next"}`, () => verifyTaskNodeUnlocked(rootDir, options));
}

/** 锁内单独运行 verify gate 节点。 */
async function verifyTaskNodeUnlocked(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress"]);
  await assertCurrentTaskOwnership(rootDir, task);
  const deliveryWorkspace = await ensureLinearDeliveryWorkspace(rootDir, taskState.planId, task, taskState.tasks);

  task.status = "verifying";
  const verifyEnvelope = await invokeCapability("verify", { rootDir, task, options: { executionRoot: deliveryWorkspace?.workDir || rootDir } });
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
  if (!verifyResult.pass) {
    await writeFailureReport(rootDir, taskState.planId, task);
  }
  await transactWithLedger(rootDir, {
    type: "node_verify_completed",
    planId: taskState.planId,
    taskId: task.id,
    pass: verifyResult.pass,
    criterionEvidenceCount: criterionEvidence.length,
  }, () => persistTaskState(rootDir, taskState));
  if (!verifyResult.pass) {
    await appendLedger(rootDir, { type: "node_verify_failed", planId: taskState.planId, taskId: task.id, reason: task.last_failure.reason });
  }
  await writeSnapshot(rootDir, "node_verify_completed", { planId: taskState.planId, taskId: task.id, pass: verifyResult.pass });
  return { status: verifyResult.pass ? "verified" : task.status === "failed" ? "failed" : "verify_failed", task, verifyResult };
}

/** 仅运行 scope gate（scope node）。 */
export async function scopeTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-scope:${options.taskId || "next"}`, () => scopeTaskNodeUnlocked(rootDir, options));
}

/** 锁内单独运行 scope gate 节点。 */
async function scopeTaskNodeUnlocked(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress", "pending"]);
  await assertCurrentTaskOwnership(rootDir, task);
  const deliveryWorkspace = await ensureLinearDeliveryWorkspace(rootDir, taskState.planId, task, taskState.tasks);
  const executionPaths = [...task.evidence].reverse().find((entry) => entry.kind === "execution_paths");
  const scopeEnvelope = await invokeCapability("scope", {
    rootDir,
    task,
    options: {
      changedPaths: executionPaths?.afterAvailable === true ? executionPaths.introducedPaths : undefined,
      unavailableReason: executionPaths?.unavailableReason,
      executionRoot: deliveryWorkspace?.workDir || rootDir,
    },
  });
  const scopeResult = scopeEnvelope.evidence;
  task.evidence.push({ kind: "scope_guard", at: nowIso(), ...scopeResult });
  task.last_scope_result = scopeResult;
  if (scopeResult.status === "fail") {
    task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "node_scope");
  }
  task.updatedAt = nowIso();
  await transactWithLedger(rootDir, {
    type: "node_scope_completed",
    planId: taskState.planId,
    taskId: task.id,
    status: scopeResult.status,
  }, () => persistTaskState(rootDir, taskState));
  await writeSnapshot(rootDir, "node_scope_completed", { planId: taskState.planId, taskId: task.id, scopeStatus: scopeResult.status });
  return { status: scopeResult.status, task, scopeResult };
}

/** 仅运行 review gate（review node）。 */
export async function reviewTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-review:${options.taskId || "next"}`, () => reviewTaskNodeUnlocked(rootDir, options));
}

/** 锁内单独运行 review gate 节点。 */
async function reviewTaskNodeUnlocked(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress"]);
  await assertCurrentTaskOwnership(rootDir, task);
  const deliveryWorkspace = await ensureLinearDeliveryWorkspace(rootDir, taskState.planId, task, taskState.tasks);
  const workerResult = [...task.evidence].reverse().find((entry) => entry.kind === "worker");
  const verifyResult = task.last_verify_result || [...task.evidence].reverse().find((entry) => entry.kind === "verifier");
  const scopeResult = task.last_scope_result || [...task.evidence].reverse().find((entry) => entry.kind === "scope_guard");
  const contractGovernance = await prepareContractReview(rootDir, taskState.planId, task, deliveryWorkspace?.workDir || rootDir, { workerResult, verifyResult, scopeResult });
  const reviewEnvelope = await invokeCapability("review", {
    rootDir,
    task,
    evidence: { workerResult, verifyResult, scopeResult, contractGovernance },
    options: { executionRoot: deliveryWorkspace?.workDir || rootDir },
  });
  const reviewResult = reviewEnvelope.evidence;

  task.status = "verifying";
  task.evidence.push(reviewResult);
  task.last_review_result = reviewResult;
  task.updatedAt = nowIso();
  await writeReviewReport(rootDir, taskState.planId, task, reviewResult);

  if (contractGovernance.changeRequest) {
    task.status = "needs_user_decision";
    await transactWithLedger(rootDir, {
      type: "node_review_awaiting_user_decision",
      planId: taskState.planId,
      taskId: task.id,
      changeRequestId: contractGovernance.changeRequest.id || null,
    }, () => persistTaskState(rootDir, taskState));
    return { status: "awaiting_user_decision", task, changeRequest: contractGovernance.changeRequest, reviewResult };
  }
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

  await transactWithLedger(rootDir, {
    type: reviewResult.pass ? "node_review_passed" : "node_review_failed",
    planId: taskState.planId,
    taskId: task.id,
    failedLaneCount: reviewResult.lanes.filter((lane) => lane.status === "fail").length,
  }, () => persistTaskState(rootDir, taskState));
  await writeSnapshot(rootDir, "node_review_completed", { planId: taskState.planId, taskId: task.id, pass: reviewResult.pass });
  return { status: reviewResult.pass ? "reviewed" : "review_failed", task, reviewResult };
}

/** 运行 completion 段：acceptance-proof + checkpoint（checkpoint node）。 */
export async function checkpointTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-checkpoint:${options.taskId || "next"}`, () => checkpointTaskNodeWithinLock(rootDir, options));
}

/** 锁内收集 gate 证据并运行 completion 段。 */
export async function checkpointTaskNodeWithinLock(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress"]);
  await assertTaskOrDeliveredOwnership(rootDir, taskState.planId, task);
  if (task.last_failure?.reason === "command_termination_failed" && options.force !== true) {
    return { status: "recovery_required", task, commandEvidence: task.last_failure.commandEvidence || null };
  }
  const deliveryWorkspace = await ensureLinearDeliveryWorkspace(rootDir, taskState.planId, task, taskState.tasks);
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
  let { verifyResult, scopeResult, reviewResult } = gateEvidence;
  let criteria = criteriaStatus(task);

  if (workerResult?.exitCode === 0 && ((criteria.pass && failedSteps.length === 0) || task.contractDecisionRef)) {
    let completion;
    {
      const current = deliveryWorkspace ? await collectGitChangedPaths(deliveryWorkspace.workDir) : { available: false, reason: "not_git" };
      const pipeline = await runDeliveryPipeline(rootDir, taskState.planId, task, {
        initialEvidence: { workerResult },
        changedPaths: current.available ? current.paths : task.last_scope_result?.changedPaths,
        unavailableReason: current.reason,
        executionRoot: deliveryWorkspace?.workDir || rootDir,
        runId: deliveryWorkspace?.runId,
        preCompletionGate: () => taskOwnershipGate(rootDir, task.id),
      });
      verifyResult = pipeline.evidence.verifyResult;
      scopeResult = pipeline.evidence.scopeResult;
      reviewResult = pipeline.evidence.reviewResult;
      criteria = pipeline.criteria;
      if (pipeline.evidence.integrationCommit) task.delivery = pipeline.evidence.integrationCommit;
      task.evidence.push(verifyResult, { kind: "scope_guard", at: nowIso(), ...scopeResult }, reviewResult);
      task.last_verify_result = verifyResult;
      task.last_scope_result = scopeResult;
      task.last_review_result = reviewResult;
      completion = {
        status: pipeline.status,
        proofEnvelope: { evidence: pipeline.evidence.acceptanceProof },
        checkpointEnvelope: pipeline.steps.find((step) => step.capability === "checkpoint") || null,
        integrationGate: pipeline.evidence.integrationCommit,
      };
      if (pipeline.status === "awaiting_user_decision") {
        await transactWithLedger(rootDir, {
          type: "node_checkpoint_awaiting_user_decision",
          planId: taskState.planId,
          taskId: task.id,
          changeRequestId: pipeline.changeRequest?.id || null,
        }, () => persistTaskState(rootDir, taskState));
        return { status: "awaiting_user_decision", task, changeRequest: pipeline.changeRequest, verifyResult, scopeResult, reviewResult };
      }
      if (pipeline.status === "recovery_required") {
        return persistCommandRecoveryRequired(rootDir, taskState, task, pipeline.evidence.commandRecovery, {
          workerResult, verifyResult, scopeResult, reviewResult,
        });
      }
    }
    const acceptanceProof = completion.proofEnvelope.evidence;
    if (completion.status === "proof_failed") {
      // acceptanceProof can be null when the proof capability threw (the
      // gateway converts throws into fail envelopes with null evidence).
      const failedChecks = (acceptanceProof?.checks || []).filter((check) => check.status === "fail").map((check) => check.name).join(", ");
      await persistAcceptanceProofFailure(rootDir, taskState, task, {
        workerResult,
        verifyResult,
        scopeResult,
        reviewResult,
        criteria,
        failureSummary: `acceptance proof failed: ${failedChecks || completion.proofEnvelope.error?.message || "acceptance proof capability failed"}`,
      });
      return { status: task.status === "failed" ? "failed" : "retry", task, verifyResult, scopeResult, reviewResult, acceptanceProof };
    }
    if (completion.status === "checkpoint_failed") {
      await persistCheckpointWriteFailure(rootDir, taskState, task, {
        workerResult,
        verifyResult,
        scopeResult,
        reviewResult,
        criteria,
        checkpointError: completion.checkpointEnvelope?.error?.message,
      });
      return { status: task.status === "verifying" ? "recovery_required" : "retry", task, verifyResult, scopeResult, reviewResult, acceptanceProof };
    }
    if (completion.status === "revalidation_required") {
      await persistRevalidationRequired(rootDir, taskState, task, {
        integrationGuard: completion.integrationGate,
        summaryFallback: "remote task ownership changed before checkpoint",
        retryHint: "旧设备必须停止写入；由当前远端 owner 重新运行质量门与 checkpoint",
        ledgerEvent: { type: "node_checkpoint_revalidation_required", planId: taskState.planId, taskId: task.id },
      });
      return { status: "revalidation_required", task, verifyResult, scopeResult, reviewResult, acceptanceProof };
    }
    if (completion.status !== "completed") {
      task.status = task.delivery?.integrationSha || task.delivery?.commitSha ? "verifying" : (shouldFailDeliveryAttempt(task, verifyResult, scopeResult, reviewResult) ? "failed" : "pending");
      task.last_failure = buildFailureSummary(task, { workerResult, verifyResult, scopeResult, reviewResult, criteriaResult: criteria, nextStatus: task.status });
      if (task.status === "verifying") {
        task.last_failure.reason = "delivery_revalidation_failed";
        task.last_failure.retryHint = "保留同一 delivery commit 与 owner；修复 gate 后显式重跑 checkpoint，不重新执行 worker。";
      }
      task.updatedAt = nowIso();
      await writeFailureReport(rootDir, taskState.planId, task);
      await transactWithLedger(rootDir, {
        type: "node_checkpoint_rejected",
        planId: taskState.planId,
        taskId: task.id,
        nextStatus: task.status,
        reason: task.last_failure.reason,
      }, () => persistTaskState(rootDir, taskState));
      return { status: task.status === "verifying" ? "recovery_required" : task.status === "failed" ? "failed" : "retry", task, verifyResult, scopeResult, reviewResult, acceptanceProof };
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
  await transactWithLedger(rootDir, {
    type: "node_checkpoint_rejected",
    planId: taskState.planId,
    taskId: task.id,
    nextStatus: task.status,
    reason: task.last_failure.reason,
    retryHint: task.last_failure.retryHint,
  }, () => persistTaskState(rootDir, taskState));
  await writeSnapshot(rootDir, "node_checkpoint_rejected", { planId: taskState.planId, taskId: task.id, nextStatus: task.status });
  return { status: task.status === "failed" ? "failed" : "retry", task, verifyResult, scopeResult, reviewResult };
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
  assertContractWorkspaceAvailable(tasks);
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
