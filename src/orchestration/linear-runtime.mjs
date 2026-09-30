// =============================================================================
// 文件名称：linear-runtime.mjs
// 所属模块：orchestration
// 作用说明：
//   线性任务运行时：连续 runNextTask 的任务选择、worker 执行与交付流水线。
//   分步 workflow node（execute/checkpoint/retry）由 linear-workflow.mjs 持有。
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
import { readChangeRequest } from "./change-governance.mjs";
import { routeRequest } from "../ai/routing.mjs";
import { buildChangedPathDiffEvidence, changedPathsIntroducedByTask, collectGitChangedPaths } from "../infra/git-diff.mjs";
import { invokeCapability } from "../capabilities/gateway.mjs";
import { runDeliveryPipeline } from "./delivery-pipeline.mjs";
import { writeWorkflowSummary } from "./status.mjs";
import { loadPlanApproval, loadTaskState } from "./plan-state.mjs";
import { persistTaskState, writeOutbox } from "./task-board.mjs";
import { findRunnableTask } from "../infra/task-predicates.mjs";
import { resolveTaskBranchTarget } from "./task-branch.mjs";
import { assertCommandWorkerAgent } from "../infra/agent-registry.mjs";
import { assertContractWorkspaceAvailable } from "./integration.mjs";
import { ensureLinearDeliveryWorkspace, recordPreExecuteSnapshot } from "./linear-delivery.mjs";
import { DEFAULT_RECOVERY_HINTS, applyPipelineOutcome, persistCommandRecovery, recordGateEvidence } from "./task-recovery.mjs";
import {
  runLinearWorkflowNode,
  executeTaskNode,
  checkpointTaskNode,
  checkpointTaskNodeWithinLock,
  retryTaskNode,
} from "./linear-workflow.mjs";

export {
  executeTaskNode,
  checkpointTaskNode,
  retryTaskNode,
};

/** 线性 run 各 pipeline 分支的 ledger 事件类型。 */
const LINEAR_EVENTS = {
  awaiting: "task_awaiting_user_decision",
  revalidation: "task_completion_revalidation_required",
  completed: "task_verified",
  rejected: "task_rejected",
  proofFailed: "acceptance_proof_failed",
  commandRecovery: "command_recovery_required",
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
  task.coordination = await resolveTaskBranchTarget(rootDir, {
    planId: taskState.planId,
    task,
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
    return persistCommandRecovery(rootDir, taskState, task, workerResult, {
      event: { type: LINEAR_EVENTS.commandRecovery },
      retryHint: DEFAULT_RECOVERY_HINTS.commandRecovery,
    });
  }

  // Shared delivery pipeline owns gate order (verify -> scope -> review ->
  // acceptance-proof -> checkpoint); see src/orchestration/delivery-pipeline.mjs.
  // pipeline 结果到任务状态/失败报告/ledger 的分支统一由 applyPipelineOutcome 维护。
  const pipelineResult = await runDeliveryPipeline(rootDir, taskState.planId, task, {
    initialEvidence: { workerResult },
    changedPaths: deliveryWorkspace ? afterChanged.paths : changedPathsIntroducedByTask(beforeChanged, afterChanged),
    unavailableReason: beforeChanged.available ? afterChanged.reason : beforeChanged.reason,
    executionRoot,
    runId: deliveryWorkspace?.runId,
  });
  const { verifyResult, reviewResult } = pipelineResult.evidence;
  await recordGateEvidence(rootDir, taskState.planId, task, pipelineResult);
  if (pipelineResult.evidence.integrationCommit) task.delivery = pipelineResult.evidence.integrationCommit;

  await writeSnapshot(rootDir, "verified", { planId: taskState.planId, taskId: task.id, pass: verifyResult.pass });
  if (pipelineResult.criterionEvidenceRecorded.length > 0) {
    await appendLedger(rootDir, { type: "criterion_evidence_auto_recorded", planId: taskState.planId, taskId: task.id, count: pipelineResult.criterionEvidenceRecorded.length });
  }
  await appendLedger(rootDir, { type: "review_gate_completed", planId: taskState.planId, taskId: task.id, pass: reviewResult.pass, failedLaneCount: reviewResult.lanes.filter((lane) => lane.status === "fail").length });
  await writeSnapshot(rootDir, "reviewed", { planId: taskState.planId, taskId: task.id, pass: reviewResult.pass });

  return applyPipelineOutcome(rootDir, taskState, task, pipelineResult, {
    workerResult,
    events: LINEAR_EVENTS,
    hints: DEFAULT_RECOVERY_HINTS,
    changeRequestSource: "scope_guard",
    afterCompleted: async () => {
      await writeSnapshot(rootDir, "checkpointed", { planId: taskState.planId, taskId: task.id, scopeStatus: pipelineResult.evidence.scopeResult.status });
      if (taskState.tasks.every((candidate) => candidate.status === "completed")) {
        await writeWorkflowSummary(rootDir, { reason: "all_tasks_completed" });
      }
    },
  });
}
