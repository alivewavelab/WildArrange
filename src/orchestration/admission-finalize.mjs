// =============================================================================
// 文件名称：admission-finalize.mjs
// 所属模块：orchestration
// 作用说明：
//   并行 admission 的完成阶段：运行共享门禁、生成交付、处理回滚与完成落账。
//   不负责 claim，也不直接应用子 Agent 文件；调用方已持有任务锁。
//
// 【运行原理速读】
//   已完成 apply 的工作区 → 复核交付围栏 → gates → delivery/checkpoint；
//   失败先回滚或保留恢复权，成功按 ledger-first 顺序完成任务状态。
// =============================================================================
import { nowIso } from "../infra/runtime-store.mjs";
import { transactWithLedger } from "../infra/task-state-lock.mjs";
import { commitIsAncestor } from "../infra/git-coordination.mjs";
import { buildFailureSummary } from "../infra/failure-analysis.mjs";
import { writeFailureReport, writeReviewReport } from "../infra/task-reports.mjs";
import {
  commitTaskCompletionState,
  runDeliveryPipeline,
  shouldFailDeliveryAttempt,
} from "./delivery-pipeline.mjs";
import {
  persistAdmissionRevalidation,
  persistPostIntegrationRecovery,
  removePersistedRollbackPlan,
  rollbackAdmissionChanges,
} from "./admission-recovery.mjs";
import { persistRollbackFailureRecovery } from "./admission-projection.mjs";
import {
  collectIntegrationCandidatePaths,
  readIntegrationIntent,
  verifyAdmissionFences,
} from "./integration.mjs";
import { loadTaskState } from "./plan-state.mjs";
import { persistTaskState } from "./task-board.mjs";

/**
 * Phase 3：经 delivery-pipeline 跑 gate 并完成或回滚；在调用方锁内运行，禁止二次加锁。
 * 非 completed 时须先回滚工作区再释放 claim，避免后继 run 被旧 rollback 覆盖。
 */
export async function finalizeAdmissionWithinLock(rootDir, taskId, { workerResult, changedPaths, runId, rollbackPlan, integrationGuard, deliveryWorktreeDir, deliveryFromWorktree }) {
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");
  const task = taskState.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  // Ownership gate: finalize may only commit on behalf of the run that
  // holds the persisted claim (cross-review P0, round 6, 2026-07-21).
  if (task.admission_claim?.runId !== runId) {
    // §3.4：仅 claim holder 可 finalize；防止 hijack 进行中的 admission 事务。
    throw new Error(`task ${taskId} admission claim is ${task.admission_claim ? `held by run ${task.admission_claim.runId}` : "no longer held"}; refusing to finalize on behalf of run ${runId}`);
  }
  const integrationIntent = await readIntegrationIntent(rootDir, runId, taskId);
  const initialFence = await verifyAdmissionFences(rootDir, taskId, integrationGuard, integrationIntent);
  const durableDeliveryExists = ["pushed", "push_outcome_unknown", "committed_local"].includes(integrationIntent?.status)
    || Boolean(integrationIntent?.integrationSha
      && integrationGuard?.expectedSha
      && await commitIsAncestor(rootDir, integrationIntent.integrationSha, integrationGuard.expectedSha));
  if (!initialFence.pass) {
    // §3.4：delivery 已 durable 时围栏失败走 post-integration recovery，禁止回滚已 push 成果。
    if (durableDeliveryExists) {
      return persistPostIntegrationRecovery(rootDir, taskState, task, {
        runId,
        integrationCommit: {
          ...integrationIntent,
          pushed: true,
          reason: integrationIntent?.status === "push_outcome_unknown"
            ? "integration_push_outcome_unknown"
            : initialFence.reason,
          fenceReason: initialFence.reason,
        },
        summary: `integration ${integrationIntent.integrationSha} was already pushed, but recovery fence failed: ${initialFence.reason}`,
        verifyResult: task.last_verify_result || null,
        scopeResult: task.last_scope_result || null,
        reviewResult: task.last_review_result || null,
        acceptanceProof: null,
      });
    }
    const rollback = await rollbackAdmissionChanges(rootDir, rollbackPlan);
    if (rollback.status !== "rolled_back") {
      // §3.4：revalidation 回滚失败须 retain owner 与 rollback plan，禁止释放脏 checkout。
      return persistRollbackFailureRecovery(rootDir, taskState, task, {
        rollback,
        reason: "admission_rollback_failed",
        summary: `parallel admission revalidation failed and workspace rollback did not complete: ${rollback.error || rollback.reason || "unknown error"}`,
        retryHint: `任务所有权和 rollback plan 已保留；修复文件系统问题后，用同一 run ${runId} 重新 admit`,
      });
    }
    return persistAdmissionRevalidation(rootDir, taskState, task, {
      fence: initialFence,
      runId,
      rollback,
      acceptanceProof: null,
      verifyResult: null,
      scopeResult: null,
      reviewResult: null,
      removeRollbackPlan: () => removePersistedRollbackPlan(rootDir, runId, taskId),
    });
  }
  const localGitDelivery = task.coordination?.localGit === true;
  const deliveryChangedPaths = integrationIntent && initialFence.remoteContainsPriorIntegration
    ? integrationIntent.changedPaths || changedPaths
    : integrationGuard?.active || localGitDelivery
      ? await collectIntegrationCandidatePaths(
          rootDir,
          integrationGuard?.expectedSha || task.coordination?.remoteHeadSha,
        )
    : changedPaths;
  const authoritativePaths = new Set([
    ...(changedPaths || []),
    ...(task.coordination?.handoffChangedPaths || []),
  ]);
  const unattributedPaths = integrationGuard?.active || localGitDelivery
    ? deliveryChangedPaths.filter((filePath) => !authoritativePaths.has(filePath))
    : [];
  if (unattributedPaths.length > 0) {
    const rollback = await rollbackAdmissionChanges(rootDir, rollbackPlan);
    if (rollback.status !== "rolled_back") {
      // §3.4：unattributed 变更回滚失败同样 retain claim，禁止后继 run 覆盖 preimage。
      return persistRollbackFailureRecovery(rootDir, taskState, task, {
        rollback,
        reason: "admission_rollback_failed",
        summary: `unattributed workspace changes were found and rollback failed: ${unattributedPaths.join(", ")}`,
        retryHint: `任务所有权和 rollback plan 已保留；修复工作区后，用同一 run ${runId} 重新 admit`,
      });
    }
    return persistAdmissionRevalidation(rootDir, taskState, task, {
      fence: {
        pass: false,
        reason: "workspace_contains_unattributed_changes",
        expectedSha: integrationGuard.expectedSha,
        actualSha: integrationGuard.expectedSha,
        unattributedPaths,
      },
      runId,
      rollback,
      acceptanceProof: null,
      verifyResult: null,
      scopeResult: null,
      reviewResult: null,
      removeRollbackPlan: () => removePersistedRollbackPlan(rootDir, runId, taskId),
    });
  }

  // Same shared pipeline as the linear runtime: gate order lives in
  // delivery-pipeline.mjs only.
  const pipelineResult = await runDeliveryPipeline(rootDir, taskState.planId, task, {
    initialEvidence: { workerResult },
    changedPaths: deliveryChangedPaths,
    runId,
    preCompletionGate: () => verifyAdmissionFences(rootDir, taskId, integrationGuard, integrationIntent),
    delivery: {
      runId,
      integrationGuard,
      deliveryWorktreeDir,
      deliveryFromWorktree,
    },
  });
  const verifyResult = pipelineResult.evidence.verifyResult;
  const scopeResult = pipelineResult.evidence.scopeResult;
  const reviewResult = pipelineResult.evidence.reviewResult;
  const acceptanceProof = pipelineResult.evidence.acceptanceProof || null;
  const criteria = pipelineResult.criteria;

  task.evidence.push(verifyResult);
  task.last_verify_result = verifyResult;
  task.evidence.push({ kind: "scope_guard", at: nowIso(), ...scopeResult });
  task.last_scope_result = scopeResult;
  task.evidence.push(reviewResult);
  task.last_review_result = reviewResult;
  await writeReviewReport(rootDir, taskState.planId, task, reviewResult);

  if (pipelineResult.status === "recovery_required") {
    // §3.4：gate 命令终止未确认时保持 verifying 与 claim，禁止释放 owner/worktree。
    task.status = "verifying";
    task.last_failure = buildFailureSummary(task, {
      workerResult,
      verifyResult,
      scopeResult,
      reviewResult,
      criteriaResult: criteria,
      nextStatus: task.status,
    });
    task.last_failure.reason = "command_termination_failed";
    task.last_failure.summary = `a gate command timed out and process termination could not be confirmed${pipelineResult.evidence.commandRecovery?.pid ? ` (pid ${pipelineResult.evidence.commandRecovery.pid})` : ""}`;
    task.last_failure.retryHint = "确认残留进程已经终止后，用同一 run 重新 admit；保留 owner、worktree 与 rollback plan。";
    task.last_failure.commandEvidence = pipelineResult.evidence.commandRecovery;
    task.updatedAt = nowIso();
    await writeFailureReport(rootDir, taskState.planId, task);
    await transactWithLedger(rootDir, {
      type: "parallel_agent_command_recovery_required",
      planId: taskState.planId,
      taskId: task.id,
      runId,
      pid: pipelineResult.evidence.commandRecovery?.pid || null,
    }, () => persistTaskState(rootDir, taskState));
    return { status: "recovery_required", planId: taskState.planId, task, acceptanceProof, verifyResult, scopeResult, reviewResult, rollback: { status: "not_attempted", reason: "command_process_state_unknown" } };
  }

  if (pipelineResult.status === "completed") {
    // The admitted files were evaluated in the protected shared checkout only
    // long enough to build and verify the task-branch delivery commit. Once
    // that commit is durable locally (and pushed when a remote exists), restore
    // the shared checkout before releasing ownership. The task branch/worktree
    // remains the delivery artifact; main must not retain an uncommitted copy.
    const delivery = pipelineResult.evidence.integrationCommit;
    const durableDeliveryCompleted = delivery?.active === true
      && (delivery.pushed === true || (delivery.local === true && delivery.status === "committed_local"));
    const deliveryRollback = durableDeliveryCompleted
      ? await rollbackAdmissionChanges(rootDir, rollbackPlan)
      : { status: "not_attempted", reason: "local_degraded_delivery_retained" };
    if (durableDeliveryCompleted && deliveryRollback.status !== "rolled_back") {
      // §3.4：task branch 已 durable 时 cleanup 失败只 retain delivery 与 claim，禁止反完成。
      return persistRollbackFailureRecovery(rootDir, taskState, task, {
        rollback: deliveryRollback,
        reason: "delivery_cleanup_failed",
        summary: `task branch delivery succeeded but shared checkout cleanup failed: ${deliveryRollback.error || deliveryRollback.reason || "unknown error"}`,
        retryHint: `delivery commit 已在任务分支；保留 owner 与 rollback plan，修复工作区后用同一 run 恢复。涉及路径：${(deliveryRollback.paths || []).join(", ") || "unknown"}`,
        failureContext: { workerResult, verifyResult, scopeResult, reviewResult, criteriaResult: criteria },
        gateResults: { acceptanceProof, verifyResult, scopeResult, reviewResult },
        integrationCommit: pipelineResult.evidence.integrationCommit || null,
      });
    }
    task.delivery = pipelineResult.evidence.integrationCommit || null;
    if (deliveryWorktreeDir) {
      task.delivery_workspace = {
        kind: "parallel_task_worktree",
        runId,
        workDir: deliveryWorktreeDir,
        branch: task.delivery?.branch || task.delivery?.worktreeSync?.branch || task.coordination?.branch || null,
        baseSha: task.delivery?.expectedSha || integrationGuard?.expectedSha || null,
        deliverySha: task.delivery?.integrationSha || task.delivery?.commitSha || task.delivery?.actualSha || null,
      };
    }
    task.admission_claim = null;
    // Ledger first, canonical tasks.json last (commit point): a ledger
    // outage must never leave a completed/released admission without its
    // completion ledger event (cross-review P0, round 3, 2026-07-21).
    // Wisdom and digest are INSIDE the completion transaction (before the
    // canonical persist): if either write fails, the task stays verifying
    // and the recovery re-runs the whole completion (cross-review P1,
    // round 5, 2026-07-21).
    await commitTaskCompletionState(rootDir, {
      taskState,
      task,
      verifyResult,
      ledgerEvent: {
        type: "parallel_agent_admission_completed",
        planId: taskState.planId,
        runId: runId || null,
        taskId,
        status: "completed",
        appliedPaths: deliveryChangedPaths || [],
        rollback: deliveryRollback,
      },
      digestReason: "parallel_admission_completed",
    });
    await removePersistedRollbackPlan(rootDir, runId, taskId);
    return {
      status: "completed",
      planId: taskState.planId,
      task,
      acceptanceProof,
      verifyResult,
      scopeResult,
      reviewResult,
      integrationCommit: pipelineResult.evidence.integrationCommit || null,
      rollback: deliveryRollback,
    };
  }

  if (pipelineResult.status !== "completed"
    && (pipelineResult.evidence.integrationCommit?.pushed === true
      || pipelineResult.evidence.integrationCommit?.status === "committed_local")) {
    // §3.4：push/commit 后 checkpoint 或 fence 失败走 post-integration recovery，禁止回滚已 push 成果。
    return persistPostIntegrationRecovery(rootDir, taskState, task, {
      runId,
      integrationCommit: pipelineResult.evidence.integrationCommit,
      summary: pipelineResult.status === "checkpoint_failed"
        ? `delivery commit ${pipelineResult.evidence.integrationCommit.integrationSha} succeeded, but checkpoint failed: ${pipelineResult.evidence.checkpointError?.message || "unknown error"}`
        : `integration ${pipelineResult.evidence.integrationCommit.integrationSha} was already pushed, but remote recovery validation failed: ${pipelineResult.evidence.integrationCommit.reason || pipelineResult.status}`,
      error: pipelineResult.evidence.checkpointError?.message
        || pipelineResult.evidence.integrationCommit.reason
        || null,
      checkpointFailed: pipelineResult.status === "checkpoint_failed",
      acceptanceProof,
      verifyResult,
      scopeResult,
      reviewResult,
    });
  }

  // §3.4：gate 未 completed 时先回滚共享 checkout，再释放 claim，避免后继 run 与旧 rollback 竞态。
  const rollback = await rollbackAdmissionChanges(rootDir, rollbackPlan);

  if (rollback.status !== "rolled_back") {
    // §3.4：rollback 失败 retain owner 与 plan；禁止释放 claim 让后继 run 踩脏工作区。
    return persistRollbackFailureRecovery(rootDir, taskState, task, {
      rollback,
      reason: "admission_rollback_failed",
      summary: `parallel admission rollback failed: ${rollback.error || rollback.reason || "unknown error"}`,
      retryHint: `任务所有权和 rollback plan 已保留；修复文件系统问题后，用同一 run 重新 admit。涉及路径：${(rollback.paths || []).join(", ") || "unknown"}`,
      failureContext: { workerResult, verifyResult, scopeResult, reviewResult, criteriaResult: criteria },
      gateResults: { acceptanceProof, verifyResult, scopeResult, reviewResult },
    });
  }

  if (pipelineResult.status === "awaiting_user_decision") {
    // §3.4：人类等待须清空共享 checkout 但 retain owner；批准后须新 preimage 重 apply。
    // A human wait must never retain temporary files in the shared checkout.
    // Keep the task/run owner, but replay the child result against a NEW
    // preimage after approval; the old preimage cannot erase another task.
    task.status = "needs_user_decision";
    task.admission_claim = { ...task.admission_claim, phase: "applying", appliedPaths: [], workspaceRestored: true };
    task.last_failure = null;
    await transactWithLedger(rootDir, {
      type: "parallel_agent_admission_awaiting_user_decision",
      planId: taskState.planId,
      taskId: task.id,
      runId,
    }, () => persistTaskState(rootDir, taskState));
    await removePersistedRollbackPlan(rootDir, runId, taskId);
    return { status: "awaiting_user_decision", planId: taskState.planId, task, changeRequest: pipelineResult.changeRequest,
      verifyResult, scopeResult, reviewResult, rollback };
  }
  if (pipelineResult.status === "checkpoint_failed") {
    // §3.4：checkpoint 失败不得标记 completed；释放 claim 前须确认 evidence 可重跑 checkpoint。
    task.status = "pending";
    task.admission_claim = null;
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
    task.last_failure.retryHint = "checkpoint 写入失败（检查 .wildarrange/checkpoints 目录是否可写），修复后重新 admit 即可，所有质量门已通过";
    task.updatedAt = nowIso();
    await writeFailureReport(rootDir, taskState.planId, task);
    await transactWithLedger(rootDir, {
      type: "checkpoint_write_failed",
      planId: taskState.planId,
      taskId: task.id,
      runId,
      error: pipelineResult.evidence.checkpointError?.message || null,
    }, () => persistTaskState(rootDir, taskState));
    await removePersistedRollbackPlan(rootDir, runId, taskId);
    return { status: "retry", planId: taskState.planId, task, acceptanceProof, verifyResult, scopeResult, reviewResult, rollback };
  }

  if (pipelineResult.status === "revalidation_required") {
    const fence = pipelineResult.evidence.integrationCommit?.pass === false
      ? pipelineResult.evidence.integrationCommit
      : pipelineResult.evidence.integrationGuard || {};
    return persistAdmissionRevalidation(rootDir, taskState, task, {
      fence,
      runId,
      rollback,
      acceptanceProof,
      verifyResult,
      scopeResult,
      reviewResult,
      removeRollbackPlan: () => removePersistedRollbackPlan(rootDir, runId, taskId),
    });
  }

  task.status = shouldFailDeliveryAttempt(task, verifyResult, scopeResult, reviewResult) ? "failed" : "pending";
  task.admission_claim = null;
  task.last_failure = buildFailureSummary(task, {
    workerResult,
    verifyResult,
    scopeResult,
    reviewResult,
    criteriaResult: criteria,
    nextStatus: task.status,
  });
  if (acceptanceProof && !acceptanceProof.pass) {
    task.last_failure.reason = "acceptance_proof_failed";
    task.last_failure.summary = `acceptance proof failed: ${acceptanceProof.checks.filter((check) => check.status === "fail").map((check) => check.name).join(", ")}`;
  }
  task.updatedAt = nowIso();
  await writeFailureReport(rootDir, taskState.planId, task);
  await transactWithLedger(rootDir, {
    type: "parallel_agent_admission_rejected",
    planId: taskState.planId,
    taskId: task.id,
    runId,
    nextStatus: task.status,
    reason: task.last_failure.reason,
  }, () => persistTaskState(rootDir, taskState));
  await removePersistedRollbackPlan(rootDir, runId, taskId);
  return { status: task.status === "failed" ? "failed" : "retry", planId: taskState.planId, task, acceptanceProof, verifyResult, scopeResult, reviewResult, rollback };
}
