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
import { readGitHead } from "../infra/git-diff.mjs";
import { buildFailureSummary } from "../infra/failure-analysis.mjs";
import {
  commitTaskCompletionState,
  runDeliveryPipeline,
} from "./delivery-pipeline.mjs";
import {
  removePersistedRollbackPlan,
  rollbackAdmissionChanges,
} from "./admission-recovery.mjs";
import {
  collectIntegrationCandidatePaths,
  readIntegrationIntent,
} from "./integration.mjs";
import { loadTaskState } from "./plan-state.mjs";
import { DEFAULT_RECOVERY_HINTS, applyPipelineOutcome, persistRevalidation, persistTaskFailure, recordGateEvidence } from "./task-recovery.mjs";

/** 并行 admission 各 pipeline 分支的 ledger 事件类型；completed 由本文件的完成流程自行落账。 */
const ADMISSION_EVENTS = {
  awaiting: "parallel_agent_admission_awaiting_user_decision",
  revalidation: "parallel_admission_revalidation_required",
  rejected: "parallel_agent_admission_rejected",
  proofFailed: "parallel_agent_admission_rejected",
  commandRecovery: "parallel_agent_command_recovery_required",
};

const ADMISSION_HINTS = {
  ...DEFAULT_RECOVERY_HINTS,
  resume: "重新 admit",
  commandRecovery: "确认残留进程已经终止后，用同一 run 重新 admit；保留 owner、worktree 与 rollback plan。",
};

/** 当前共享 checkout 的 HEAD；读取失败时回退任务记录的基线。 */
async function currentHeadSha(rootDir, task) {
  const head = await readGitHead(rootDir);
  return head.available ? head.sha : task.coordination?.baseSha;
}

/**
 * Phase 3：经 delivery-pipeline 跑 gate 并完成或回滚；在调用方锁内运行，禁止二次加锁。
 * 非 completed 时须先回滚工作区再释放 claim，避免后继 run 被旧 rollback 覆盖。
 */
export async function finalizeAdmissionWithinLock(rootDir, taskId, { workerResult, changedPaths, runId, rollbackPlan, deliveryWorktreeDir, deliveryFromWorktree }) {
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
  const planId = taskState.planId;
  const admissionResult = (status, gates = {}, extra = {}) => ({
    status,
    planId,
    task,
    acceptanceProof: gates.acceptanceProof || null,
    verifyResult: gates.verifyResult || null,
    scopeResult: gates.scopeResult || null,
    reviewResult: gates.reviewResult || null,
    ...extra,
  });
  /** rollback 失败：任务保持 verifying，保留 ownership/claim 与 rollback plan，禁止释放脏工作区。 */
  const rollbackFailureRecovery = async (rollback, { reason, summary, retryHint, failureContext = null, gates = {}, integrationCommit }) => {
    await persistTaskFailure(rootDir, taskState, task, {
      status: "verifying",
      failure: {
        ...(failureContext ? buildFailureSummary(task, { ...failureContext, nextStatus: "verifying" }) : {}),
        reason,
        summary,
        retryHint,
      },
      event: { type: "parallel_agent_admission_recovery_required", reason, rollbackStatus: rollback?.status || null },
    });
    return admissionResult("recovery_required", gates, integrationCommit === undefined ? { rollback } : { integrationCommit, rollback });
  };

  const integrationIntent = await readIntegrationIntent(rootDir, runId, taskId);
  const gitDelivery = task.coordination?.localGit === true;
  // 已有 durable intent 时沿用其路径清单（工作区可能已回滚）；否则以当前 HEAD 为基线，
  // 收集共享 checkout 中尚未提交的变更，主线自身的前进不算本 run 的改动。
  const deliveryChangedPaths = integrationIntent
    ? integrationIntent.changedPaths || changedPaths
    : gitDelivery
      ? await collectIntegrationCandidatePaths(rootDir, await currentHeadSha(rootDir, task))
      : changedPaths;
  const authoritativePaths = new Set(changedPaths || []);
  const unattributedPaths = gitDelivery
    ? deliveryChangedPaths.filter((filePath) => !authoritativePaths.has(filePath))
    : [];
  if (unattributedPaths.length > 0) {
    const rollback = await rollbackAdmissionChanges(rootDir, rollbackPlan);
    if (rollback.status !== "rolled_back") {
      // §3.4：unattributed 变更回滚失败同样 retain claim，禁止后继 run 覆盖 preimage。
      return rollbackFailureRecovery(rollback, {
        reason: "admission_rollback_failed",
        summary: `unattributed workspace changes were found and rollback failed: ${unattributedPaths.join(", ")}`,
        retryHint: `任务 claim 和 rollback plan 已保留；修复工作区后，用同一 run ${runId} 重新 admit`,
      });
    }
    task.admission_claim = null;
    await persistRevalidation(rootDir, taskState, task, { reason: "workspace_contains_unattributed_changes", unattributedPaths }, {
      event: { type: ADMISSION_EVENTS.revalidation, runId },
      retryHint: ADMISSION_HINTS.revalidation,
    });
    await removePersistedRollbackPlan(rootDir, runId, taskId);
    return admissionResult("revalidation_required", {}, { rollback });
  }

  // Same shared pipeline as the linear runtime: gate order lives in
  // delivery-pipeline.mjs only.
  const pipelineResult = await runDeliveryPipeline(rootDir, planId, task, {
    initialEvidence: { workerResult },
    changedPaths: deliveryChangedPaths,
    runId,
    // 已有 durable intent 说明交付提交已落在任务分支、共享 checkout 已回滚：
    // 成果只存在于任务 delivery worktree，gate 必须在那里重跑，否则 verify 读不到产物。
    executionRoot: integrationIntent && deliveryWorktreeDir ? deliveryWorktreeDir : undefined,
    delivery: {
      runId,
      deliveryWorktreeDir,
      deliveryFromWorktree,
    },
  });
  await recordGateEvidence(rootDir, planId, task, pipelineResult);
  const { verifyResult, scopeResult, reviewResult } = pipelineResult.evidence;
  const acceptanceProof = pipelineResult.evidence.acceptanceProof || null;
  const criteria = pipelineResult.criteria;
  const gates = { acceptanceProof, verifyResult, scopeResult, reviewResult };
  const outcomeContext = (rollback) => ({
    workerResult,
    events: ADMISSION_EVENTS,
    hints: ADMISSION_HINTS,
    eventExtra: { runId },
    snapshots: false,
    resultExtras: { planId, rollback },
    settle: {
      // 释放 claim；人类等待须保留 owner，批准后须新 preimage 重 apply（旧 preimage 不能抹掉其他任务）。
      before(target, kind) {
        if (kind === "awaiting_user_decision") {
          target.status = "needs_user_decision";
          target.admission_claim = { ...target.admission_claim, phase: "applying", appliedPaths: [], workspaceRestored: true };
          target.last_failure = null;
        } else {
          target.admission_claim = null;
        }
      },
      after: () => removePersistedRollbackPlan(rootDir, runId, taskId),
    },
  });

  if (pipelineResult.status === "recovery_required") {
    // §3.4：gate 命令终止未确认时保持 verifying 与 claim，禁止释放 owner/worktree。
    return applyPipelineOutcome(rootDir, taskState, task, pipelineResult, outcomeContext({ status: "not_attempted", reason: "command_process_state_unknown" }));
  }

  const delivery = pipelineResult.evidence.integrationCommit;
  if (pipelineResult.status === "completed") {
    // The admitted files were evaluated in the protected shared checkout only
    // long enough to build and verify the task-branch delivery commit. Once
    // that commit is durable locally (and pushed when a remote exists), restore
    // the shared checkout before releasing ownership. The task branch/worktree
    // remains the delivery artifact; main must not retain an uncommitted copy.
    const durableDeliveryCompleted = delivery?.active === true
      && (delivery.pushed === true || (delivery.local === true && delivery.status === "committed_local"));
    const deliveryRollback = durableDeliveryCompleted
      ? await rollbackAdmissionChanges(rootDir, rollbackPlan)
      : { status: "not_attempted", reason: "local_degraded_delivery_retained" };
    if (durableDeliveryCompleted && deliveryRollback.status !== "rolled_back") {
      // §3.4：task branch 已 durable 时 cleanup 失败只 retain delivery 与 claim，禁止反完成。
      return rollbackFailureRecovery(deliveryRollback, {
        reason: "delivery_cleanup_failed",
        summary: `task branch delivery succeeded but shared checkout cleanup failed: ${deliveryRollback.error || deliveryRollback.reason || "unknown error"}`,
        retryHint: `delivery commit 已在任务分支；保留 owner 与 rollback plan，修复工作区后用同一 run 恢复。涉及路径：${(deliveryRollback.paths || []).join(", ") || "unknown"}`,
        failureContext: { workerResult, verifyResult, scopeResult, reviewResult, criteriaResult: criteria },
        gates,
        integrationCommit: delivery || null,
      });
    }
    task.delivery = delivery || null;
    if (deliveryWorktreeDir) {
      task.delivery_workspace = {
        kind: "parallel_task_worktree",
        runId,
        workDir: deliveryWorktreeDir,
        branch: task.delivery?.branch || task.delivery?.worktreeSync?.branch || task.coordination?.branch || null,
        baseSha: task.delivery?.expectedSha || task.coordination?.baseSha || null,
        deliverySha: task.delivery?.integrationSha || task.delivery?.commitSha || task.delivery?.actualSha || null,
      };
    }
    task.admission_claim = null;
    // Ledger first, canonical tasks.json last (commit point); wisdom/digest
    // are INSIDE the completion transaction, see commitTaskCompletionState.
    await commitTaskCompletionState(rootDir, {
      taskState,
      task,
      verifyResult,
      ledgerEvent: {
        type: "parallel_agent_admission_completed",
        planId,
        runId: runId || null,
        taskId,
        status: "completed",
        appliedPaths: deliveryChangedPaths || [],
        rollback: deliveryRollback,
      },
    });
    await removePersistedRollbackPlan(rootDir, runId, taskId);
    return admissionResult("completed", gates, { integrationCommit: delivery || null, rollback: deliveryRollback });
  }

  if (delivery?.pushed === true || delivery?.status === "committed_local") {
    // §3.4：push/commit 后 checkpoint 或 fence 失败走 post-integration recovery，禁止回滚已 push 成果。
    const checkpointFailed = pipelineResult.status === "checkpoint_failed";
    const localDelivery = delivery.local === true || delivery.status === "committed_local";
    const error = pipelineResult.evidence.checkpointError?.message || delivery.reason || null;
    await persistTaskFailure(rootDir, taskState, task, {
      status: "verifying",
      failure: {
        reason: checkpointFailed ? "checkpoint_failed_after_integration" : "post_integration_recovery_required",
        summary: checkpointFailed
          ? `delivery commit ${delivery.integrationSha} succeeded, but checkpoint failed: ${pipelineResult.evidence.checkpointError?.message || "unknown error"}`
          : `integration ${delivery.integrationSha} was already pushed, but remote recovery validation failed: ${delivery.reason || pipelineResult.status}`,
        retryHint: localDelivery
          ? `本地任务分支已经生成 delivery commit；禁止释放或换 run。确认本地任务 worktree 后，用同一 run ${runId} 恢复`
          : `远端代码已经集成或曾经集成；禁止回滚、释放或换 run。确认远端历史后，用同一 run ${runId} 恢复`,
      },
      // 审计先行：recovery 事件入账本后才提交 recovery_required 状态（ARC-003）。
      event: {
        type: checkpointFailed ? "checkpoint_write_failed_after_integration" : "post_integration_recovery_required",
        runId,
        integrationSha: delivery.integrationSha || null,
        error,
      },
    });
    return admissionResult("recovery_required", gates, {
      rollback: { status: "not_attempted", reason: localDelivery ? "local_delivery_already_committed" : "remote_integration_already_pushed" },
    });
  }

  // §3.4：gate 未 completed 时先回滚共享 checkout，再释放 claim，避免后继 run 与旧 rollback 竞态。
  const rollback = await rollbackAdmissionChanges(rootDir, rollbackPlan);
  if (rollback.status !== "rolled_back") {
    // §3.4：rollback 失败 retain owner 与 plan；禁止释放 claim 让后继 run 踩脏工作区。
    return rollbackFailureRecovery(rollback, {
      reason: "admission_rollback_failed",
      summary: `parallel admission rollback failed: ${rollback.error || rollback.reason || "unknown error"}`,
      retryHint: `任务所有权和 rollback plan 已保留；修复文件系统问题后，用同一 run 重新 admit。涉及路径：${(rollback.paths || []).join(", ") || "unknown"}`,
      failureContext: { workerResult, verifyResult, scopeResult, reviewResult, criteriaResult: criteria },
      gates,
    });
  }
  return applyPipelineOutcome(rootDir, taskState, task, pipelineResult, outcomeContext(rollback));
}
