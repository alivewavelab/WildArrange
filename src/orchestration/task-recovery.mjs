// =============================================================================
// 文件名称：task-recovery.mjs
// 所属模块：orchestration
// 作用说明：
//   任务失败与恢复状态的唯一落盘处：persistTaskFailure 是全区唯一的
//   「写 last_failure → 失败报告 → ledger → 权威任务状态」落盘器；
//   applyPipelineOutcome 是「pipeline 结果 → 任务状态/失败报告/ledger」的唯一分支阶梯，
//   线性 run、单步 checkpoint node、并行 admission 都调用它，差异经参数传入。
//   不调度 worker，不决定 gate 顺序，也不直接实现 capability。
//
// 【运行原理速读】
//   gate/worker 发现异常 → 本模块生成失败事实 → ledger → task state；
//   下次 run 或 checkpoint 根据这些事实继续恢复，不重复执行未知 worker。
// =============================================================================
import { nowIso } from "../infra/runtime-store.mjs";
import { transactWithLedger } from "../infra/task-state-lock.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { buildFailureSummary } from "../infra/failure-analysis.mjs";
import { writeFailureReport, writeReviewReport } from "../infra/task-reports.mjs";
import { writeChangeRequest } from "./change-governance.mjs";
import {
  commitTaskCompletionState,
  runPostCompletionSideEffects,
  shouldFailDeliveryAttempt,
} from "./delivery-pipeline.mjs";
import { persistTaskState } from "./task-board.mjs";

/** 线性 run 与单步 node 共用的恢复文案（并行 admission 用「重新 admit」版本）。 */
export const DEFAULT_RECOVERY_HINTS = {
  resume: "重跑",
  commandRecovery: "确认残留进程已经终止后，再从同一 task worktree 和 delivery intent 恢复；不要重新执行 worker。",
  revalidation: "确认 task branch 基线与工作区归属后，重新运行全部质量门",
};

/**
 * 唯一的失败/恢复落盘器：设置状态与 last_failure，写失败报告，审计先入 ledger 后提交权威状态。
 * 在调用方任务锁内运行，禁止自行加锁。
 * @param {object} spec status 目标状态；failure last_failure 字段；event ledger 事件（含 type）；
 *   snapshot 可选快照名；report 为 false 时不写失败报告
 */
export async function persistTaskFailure(rootDir, taskState, task, { status, failure, event, snapshot = null, report = true }) {
  task.status = status;
  task.last_failure = { at: nowIso(), ...failure };
  task.updatedAt = nowIso();
  if (report) await writeFailureReport(rootDir, taskState.planId, task);
  await transactWithLedger(rootDir, { ...event, planId: taskState.planId, taskId: task.id }, () => persistTaskState(rootDir, taskState));
  if (snapshot) await writeSnapshot(rootDir, snapshot, { planId: taskState.planId, taskId: task.id, nextStatus: task.status });
}

/** 命令终止未确认：任务保持 verifying 并保留恢复权，禁止重新执行 worker。 */
export async function persistCommandRecovery(rootDir, taskState, task, commandEvidence, { event, retryHint }) {
  await persistTaskFailure(rootDir, taskState, task, {
    status: "verifying",
    failure: {
      reason: "command_termination_failed",
      summary: `command timed out and its process could not be confirmed stopped${commandEvidence?.pid ? ` (pid ${commandEvidence.pid})` : ""}`,
      retryHint,
      commandEvidence,
    },
    event: { ...event, pid: commandEvidence?.pid || null },
  });
  return { status: "recovery_required", task };
}

/** task branch 基线变化或存在无归属改动：任务回 pending，等待重新应用并重跑质量门。 */
export async function persistRevalidation(rootDir, taskState, task, fence, { event, retryHint }) {
  const reason = fence?.reason || "task_branch_revalidation_required";
  const expectedSha = fence?.expectedSha || fence?.expectedHead || null;
  const actualSha = fence?.actualSha || fence?.actualHead || null;
  await persistTaskFailure(rootDir, taskState, task, {
    status: "pending",
    failure: {
      reason,
      summary: reason === "workspace_contains_unattributed_changes"
        ? `workspace contains changes not attributed to this run: ${(fence.unattributedPaths || []).join(", ")}`
        : fence?.error || `task branch delivery needs revalidation: ${reason} (expected ${expectedSha || "unknown"}, actual ${actualSha || "unknown"})`,
      retryHint,
    },
    event: { ...event, expectedSha, actualSha, reason },
  });
}

/** 把 pipeline 产出的 verify/scope/review 结果写入任务证据与 review 报告（调用方在 applyPipelineOutcome 之前调用）。 */
export async function recordGateEvidence(rootDir, planId, task, pipeline) {
  const { verifyResult, scopeResult, reviewResult } = pipeline.evidence;
  task.evidence.push(verifyResult, { kind: "scope_guard", at: nowIso(), ...scopeResult }, reviewResult);
  task.last_verify_result = verifyResult;
  task.last_scope_result = scopeResult;
  task.last_review_result = reviewResult;
  await writeReviewReport(rootDir, planId, task, reviewResult);
}

/**
 * pipeline 结果 → 任务状态/失败报告/ledger 的唯一分支阶梯。
 * awaiting_user_decision / recovery_required / revalidation_required / completed /
 * checkpoint_failed / acceptance proof 失败 / 普通失败，各写一次。
 * @param {object} pipeline runDeliveryPipeline 的返回
 * @param {object} ctx workerResult；events 各分支 ledger 事件类型
 *   （awaiting、revalidation、completed、rejected、proofFailed、commandRecovery）；
 *   hints 恢复文案（resume 「重跑」/「重新 admit」、commandRecovery、revalidation）；
 *   eventExtra 并入每条 ledger 事件；changeRequestSource scope 失败时写变更请求；
 *   keepCommittedDelivery 已有 delivery commit 时普通失败保持 verifying；
 *   settle { before(task, kind) 落盘前改任务（如释放 claim）, after() 落盘后清理 }；
 *   snapshots 为 false 时不写交接快照；
 *   afterCompleted 完成后的便利副作用；resultExtras 并入返回值
 */
export async function applyPipelineOutcome(rootDir, taskState, task, pipeline, ctx) {
  const { workerResult, events, hints, eventExtra = {}, settle = {}, resultExtras = {} } = ctx;
  const planId = taskState.planId;
  const { verifyResult, scopeResult, reviewResult } = pipeline.evidence;
  const acceptanceProof = pipeline.evidence.acceptanceProof || null;
  const criteria = pipeline.criteria;

  if (scopeResult.status === "fail" && ctx.changeRequestSource) {
    task.last_change_request = await writeChangeRequest(rootDir, planId, task, scopeResult, ctx.changeRequestSource);
  }

  const gates = { workerResult, verifyResult, scopeResult, reviewResult };
  const result = (status, extra = {}) => ({ status, task, ...gates, acceptanceProof, ...resultExtras, ...extra });
  const failureContext = (nextStatus) => ({ ...gates, criteriaResult: criteria, nextStatus });
  const settled = (kind) => settle.before?.(task, kind);
  const cleanup = async () => { await settle.after?.(); };

  if (pipeline.status === "awaiting_user_decision") {
    settled("awaiting_user_decision");
    await transactWithLedger(rootDir, {
      type: events.awaiting,
      planId,
      taskId: task.id,
      ...eventExtra,
      changeRequestId: pipeline.changeRequest?.id || null,
    }, () => persistTaskState(rootDir, taskState));
    await cleanup();
    return result("awaiting_user_decision", { changeRequest: pipeline.changeRequest });
  }

  if (pipeline.status === "recovery_required") {
    await persistCommandRecovery(rootDir, taskState, task, pipeline.evidence.commandRecovery, {
      event: { type: events.commandRecovery, ...eventExtra },
      retryHint: hints.commandRecovery,
    });
    return result("recovery_required");
  }

  if (pipeline.status === "revalidation_required") {
    settled("revalidation_required");
    await persistRevalidation(rootDir, taskState, task, pipeline.evidence.integrationCommit, {
      event: { type: events.revalidation, ...eventExtra },
      retryHint: hints.revalidation,
    });
    await cleanup();
    return result("revalidation_required");
  }

  if (pipeline.status === "completed") {
    // 完成审计先入 ledger，再提交权威 completed 状态；快照与摘要是提交后的便利副作用，
    // 失败只记 ledger 警告，不得反完成（顺序由 commitTaskCompletionState 统一维护）。
    await commitTaskCompletionState(rootDir, {
      taskState,
      task,
      verifyResult,
      ledgerEvent: { type: events.completed, planId, taskId: task.id, ...eventExtra, scopeStatus: scopeResult.status, reviewStatus: "pass" },
    });
    const sideEffectWarnings = await runPostCompletionSideEffects(rootDir, planId, task, () => ctx.afterCompleted?.());
    return result("completed", { sideEffectWarnings });
  }

  if (pipeline.status === "checkpoint_failed") {
    // 已有 delivery commit 时必须保留同一 delivery 与 owner，等待 checkpoint 恢复；否则回 pending 重跑。
    settled("checkpoint_failed");
    const nextStatus = hasCommittedDelivery(task) ? "verifying" : "pending";
    const checkpointError = pipeline.evidence.checkpointError?.message;
    await persistTaskFailure(rootDir, taskState, task, {
      status: nextStatus,
      failure: {
        ...buildFailureSummary(task, failureContext(nextStatus)),
        reason: "checkpoint_failed",
        summary: `checkpoint write failed: ${checkpointError || "unknown error"}`,
        retryHint: `checkpoint 写入失败（检查 .wildarrange/checkpoints 目录是否可写），修复后${hints.resume}即可，所有质量门已通过`,
      },
      event: { type: "checkpoint_write_failed", ...eventExtra, error: checkpointError || null },
      snapshot: ctx.snapshots === false ? null : "checkpoint_write_failed",
    });
    await cleanup();
    return result(task.status === "verifying" ? "recovery_required" : "retry");
  }

  settled("rejected");
  const proofStep = pipeline.steps.find((step) => step.capability === "acceptance-proof");
  if (proofStep && proofStep.status !== "pass") {
    // 上游 gate 全过但 acceptance proof 自身发现缺口；proof 能力抛错时 evidence 为 null，回退到错误信息。
    const failedChecks = (acceptanceProof?.checks || []).filter((check) => check.status === "fail").map((check) => check.name).join(", ");
    const nextStatus = shouldFailDeliveryAttempt(task, verifyResult, scopeResult, reviewResult) ? "failed" : "pending";
    await persistTaskFailure(rootDir, taskState, task, {
      status: nextStatus,
      failure: {
        ...buildFailureSummary(task, failureContext(nextStatus)),
        reason: "acceptance_proof_failed",
        summary: `acceptance proof failed: ${failedChecks || proofStep.error?.message || "acceptance proof capability failed"}`,
      },
      event: { type: events.proofFailed, ...eventExtra, nextStatus, reason: "acceptance_proof_failed" },
    });
    await cleanup();
    return result(task.status === "failed" ? "failed" : "retry");
  }

  const keepDelivery = ctx.keepCommittedDelivery === true && hasCommittedDelivery(task);
  const nextStatus = keepDelivery ? "verifying" : shouldFailDeliveryAttempt(task, verifyResult, scopeResult, reviewResult) ? "failed" : "pending";
  const failure = buildFailureSummary(task, failureContext(nextStatus));
  if (keepDelivery) {
    failure.reason = "delivery_revalidation_failed";
    failure.retryHint = "保留同一 delivery commit 与 owner；修复 gate 后显式重跑 checkpoint，不重新执行 worker。";
  }
  await persistTaskFailure(rootDir, taskState, task, {
    status: nextStatus,
    failure,
    event: { type: events.rejected, ...eventExtra, nextStatus, attempt: task.attempts, reason: failure.reason, retryHint: failure.retryHint },
    snapshot: ctx.snapshots === false ? null : events.rejected,
  });
  await cleanup();
  return result(task.status === "verifying" ? "recovery_required" : task.status === "failed" ? "failed" : "retry");
}

/** 任务是否已持有 delivery commit（此时失败必须保留 owner，不能回 pending 换 run）。 */
function hasCommittedDelivery(task) {
  return Boolean(task.delivery?.integrationSha || task.delivery?.commitSha);
}
