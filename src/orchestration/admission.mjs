// =============================================================================
// 文件名称：admission.mjs
// 所属模块：orchestration
// 作用说明：
//   并行 agent admission 事务：claim → pre-image → apply → gates →
//   delivery commit/push 或 rollback → checkpoint → release。自 parallel-runtime 拆分。
//
// 【运行原理速读】
//   可以把它想成「子 agent 成果入主工作区的海关」：
//
//   · 何时执行？
//     parallel admit 命令或 awaiting_user_acceptance 后人类触发。
//
//   · 做了什么？
//     任务锁内 claim → 写回滚计划 → apply → runDeliveryPipeline → 完成或 recovery。
//
//   · 约束？
//     与 linear run 共用 tasks.lock；apply 前必须完成 claim；push 成功后禁止回滚释放。
// =============================================================================
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import {
  ensureWildArrangeDirs,
  nowIso,
  readJson,
  resolveWildArrangePath,
} from "../infra/runtime-store.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { transactWithLedger, withTaskStateLock } from "../infra/task-state-lock.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import {
  captureIntegrationGuard,
  commitIsAncestor,
} from "../infra/git-coordination.mjs";
import { buildFailureSummary } from "../infra/failure-analysis.mjs";
import { writeFailureReport, writeReviewReport } from "../infra/task-reports.mjs";
import { applyAgentPatch, extractPatchPaths } from "../infra/git-worktree.mjs";
import { assertPathInsideRoot, pathAllowed } from "../infra/path-match.mjs";
import {
  commitTaskCompletionState,
  runDeliveryPipeline,
  runPostCompletionSideEffects,
  shouldFailDeliveryAttempt,
} from "./delivery-pipeline.mjs";
import {
  createFileRollbackPlan,
  loadPersistedRollbackPlan,
  patchAlreadyApplied,
  persistAdmissionRevalidation,
  persistRollbackPlan,
  persistPostIntegrationRecovery,
  removePersistedRollbackPlan,
  rollbackAdmissionChanges,
  recordApplyFailureWithinLock,
} from "./admission-recovery.mjs";
import {
  advanceClaimPhaseWithinLock,
  emitAdmissionDecision,
  persistRollbackFailureRecovery,
  updateAgentRunLifecycle,
} from "./admission-projection.mjs";
import {
  collectIntegrationCandidatePaths,
  readIntegrationIntent,
  verifyAdmissionFences,
} from "./integration.mjs";
import { loadTaskState } from "./plan-state.mjs";
import { persistTaskState } from "./task-board.mjs";
import { claimAdmission } from "./admission-claim.mjs";
import {
  collectActualAdmissionPaths,
  normalizePatchPaths,
  normalizeProposedFiles,
  normalizeProposedFilesOrEmpty,
  readParallelAgentResult,
} from "./admission-inputs.mjs";

export {
  collectActualAdmissionPaths,
  normalizeProposedFiles,
  normalizeProposedFilesOrEmpty,
  readParallelAgentResult,
};

/**
 * 并行 agent 结果 admission 主事务：claim → apply → gates → commit/rollback。
 * @returns {Promise<object>} completed | recovery_required | revalidation_required 等
 */
export async function admitParallelAgentResult(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  if (!options.runId) throw new Error("parallel admit requires runId");
  if (!options.taskId) throw new Error("parallel admit requires taskId");
  const result = await readParallelAgentResult(rootDir, options.runId, options.taskId);
  if (!result.pass) throw new Error(`parallel result for ${options.taskId} did not pass`);
  const files = normalizeProposedFiles(result.result?.files);
  if (files.length === 0 && typeof result.result?.patch !== "string") {
    throw new Error("parallel result has no result.files or result.patch to admit");
  }
  const proposedPaths = files.length > 0
    ? files.map((file) => file.path)
    : normalizePatchPaths(result.result?.patchPaths || result.result?.changedPaths || extractPatchPaths(result.result?.patch || ""));
  const { config } = await loadWildArrangeConfig(rootDir);
  const guardTaskState = await loadTaskState(rootDir);
  const guardTask = guardTaskState?.tasks.find((candidate) => candidate.id === options.taskId);
  const integrationGuard = await captureIntegrationGuard(rootDir, config.gitCoordination, {
    force: ["claimed", "accepted"].includes(guardTask?.coordination?.status),
  });

  // --- claim 阶段 ---
  // Phase 1 — claim. Status adjudication, writable-paths precheck, the task
  // claim (verifying + admission evidence) and the started ledger event all
  // happen under one task-state lock, BEFORE any workspace file is touched
  // (cross-review P0, round 5, 2026-07-21). This both closes the
  // check-then-write race and guarantees that every workspace mutation has
  // an established transaction (started ledger + claimed task) behind it.
  const claim = await withTaskStateLock(rootDir, `parallel-admit:${options.taskId}`, () =>
    claimAdmission(rootDir, options, { result, files, proposedPaths }));

  if (claim.kind === "awaiting_user_decision") return { status: claim.kind, task: claim.task, changeRequest: claim.changeRequest };

  if (claim.kind === "resume") {
    await updateAgentRunLifecycle(rootDir, options.runId, options.taskId, "released", {
      admissionStatus: "completed",
      releasedAt: nowIso(),
      rollback: null,
      resumed: true,
    });
    await writeSnapshot(rootDir, "parallel_agent_admission_completed", {
      planId: claim.task.planId || null,
      runId: options.runId,
      taskId: options.taskId,
      status: "completed",
      appliedPaths: claim.appliedPaths,
      resumed: true,
    });
    await emitAdmissionDecision(rootDir, options, {
      status: "completed",
      appliedPaths: claim.appliedPaths,
      rollback: null,
      acceptanceProof: null,
      note: "resumed after a previously interrupted admission",
    });
    return {
      kind: "parallel_agent_admission",
      runId: options.runId,
      taskId: options.taskId,
      planId: claim.task.planId || null,
      status: "completed",
      resumed: true,
      appliedPaths: claim.appliedPaths,
      verifyResult: claim.task.last_verify_result || null,
      scopeResult: claim.task.last_scope_result || null,
      reviewResult: claim.task.last_review_result || null,
      acceptanceProof: null,
      rollback: null,
      task: claim.task,
    };
  }

  // Phases 2+3 — apply files AND run the gates under ONE continuous hold of
  // the global task-state lock. The workspace mutation and the gates that
  // judge it are a single critical section: without this, another task's
  // admission (or a linear run) could overwrite an overlapping path between
  // this task's apply and its verify, and a failing admission's rollback
  // could race a successor's freshly-completed files (cross-review P0 x2,
  // round 7, 2026-07-21).
  const finalized = await withTaskStateLock(rootDir, `parallel-admit-txn:${options.taskId}`, () =>
    runAdmissionTransaction(rootDir, options, { claim, result, files, proposedPaths, integrationGuard }));

  // For the completed outcome the admission ledger event was already written
  // inside the transaction, BEFORE the canonical completed persist (ledger
  // first, state last). Only non-completed outcomes are logged here, with
  // rollback info (the rollback itself already happened inside the lock,
  // BEFORE the claim was released).
  if (finalized.status !== "completed") {
    await appendLedger(rootDir, {
      type: "parallel_agent_admission_completed",
      planId: finalized.planId || finalized.task?.planId || null,
      runId: options.runId,
      taskId: options.taskId,
      status: finalized.status,
      appliedPaths: finalized.appliedPaths,
      rollback: finalized.rollback,
    });
  }
  await updateAgentRunLifecycle(rootDir, options.runId, options.taskId, finalized.status === "completed" ? "released" : "awaiting_revision", {
    admissionStatus: finalized.status,
    releasedAt: finalized.status === "completed" ? nowIso() : null,
    rollback: finalized.rollback,
  });
  // Post-commit convenience: a snapshot failure after the completion has
  // been persisted must not fail the admission, only leave a ledger trace.
  const sideEffectWarnings = await runPostCompletionSideEffects(rootDir, finalized.planId, finalized.task, async () => {
    await writeSnapshot(rootDir, "parallel_agent_admission_completed", {
      planId: finalized.planId || finalized.task?.planId || null,
      runId: options.runId,
      taskId: options.taskId,
      status: finalized.status,
      appliedPaths: finalized.appliedPaths,
      rollback: finalized.rollback,
    });
  });
  await emitAdmissionDecision(rootDir, options, finalized);
  return {
    kind: "parallel_agent_admission",
    runId: options.runId,
    taskId: options.taskId,
    planId: finalized.planId || finalized.task?.planId || null,
    status: finalized.status,
    changeRequest: finalized.changeRequest || null,
    appliedPaths: finalized.appliedPaths,
    verifyResult: finalized.verifyResult,
    scopeResult: finalized.scopeResult,
    reviewResult: finalized.reviewResult,
    acceptanceProof: finalized.acceptanceProof || null,
    integrationCommit: finalized.integrationCommit || null,
    rollback: finalized.rollback,
    sideEffectWarnings,
    task: finalized.task,
  };
}

/**
 * Phase 2+3：在同一把任务锁内连续 apply 与 gates；崩溃时 claim 保留在 finalizing。
 * @returns {Promise<object>} completed | recovery_required | revalidation_required 等
 */
async function runAdmissionTransaction(rootDir, options, { claim, result, files, proposedPaths, integrationGuard }) {
  // Phase 1 and this transaction use separate lock holds. A duplicate call
  // from the same run may have captured an older phase while waiting, so the
  // persisted claim is the authority immediately before any workspace I/O.
  const liveTaskState = await loadTaskState(rootDir);
  const liveTask = liveTaskState?.tasks.find((candidate) => candidate.id === options.taskId);
  if (liveTask?.status !== "verifying" || liveTask.admission_claim?.runId !== options.runId) {
    // §3.4：Phase1/2 分锁间隙以持久 claim 为准；stale transaction 拒绝 apply。
    throw new Error(`task ${options.taskId} admission ownership changed before apply; refusing stale transaction from run ${options.runId}`);
  }
  const livePhase = liveTask.admission_claim.phase;
  if (!["applying", "finalizing"].includes(livePhase)) {
    // §3.4：未知 phase 保留 claim 供人工恢复，禁止静默释放或换 run。
    throw new Error(`task ${options.taskId} has unsupported admission phase ${livePhase || "missing"}; claim kept for manual recovery`);
  }
  const resumeFinalizing = livePhase === "finalizing";
  const resumeApplying = claim.kind === "reclaimed" && livePhase === "applying" && liveTask.admission_claim.workspaceRestored !== true;
  let rollbackPlan = { mode: "none", paths: [] };
  let appliedPaths = resumeFinalizing ? liveTask.admission_claim.appliedPaths : proposedPaths;

  if (resumeFinalizing) {
    // Files are already on disk from the interrupted attempt: re-applying
    // (and above all re-planning a rollback against the already-mutated
    // workspace) would be wrong. The pre-image plan persisted before the
    // first write is the rollback authority (cross-review P0, round 7,
    // 2026-07-21).
    rollbackPlan = await loadPersistedRollbackPlan(rootDir, options.runId, options.taskId)
      || (typeof result.result?.patch === "string" && files.length === 0
        ? { mode: "patch", patch: result.result.patch, paths: appliedPaths }
        : null);
    if (!rollbackPlan) {
      // §3.4：finalizing 续跑须用中断前 preimage；无 plan 禁止 re-apply 已变异工作区。
      throw new Error(`parallel admission cannot resume ${options.taskId}: persisted rollback plan is missing; claim kept for manual recovery`);
    }
  } else {
    // --- apply 阶段 ---
    // Phase 2 — apply the child's changes. ANY failure in here rolls the
    // workspace back to its pre-admission content before releasing the
    // claim. If rollback itself fails, ownership is intentionally retained
    // so no successor can build on a dirty workspace.
    try {
      if (files.length > 0) {
        // On an "applying"-phase crash resume the workspace may already be
        // mutated: the pre-image plan persisted by the interrupted attempt
        // is the only trustworthy source of the original contents
        // (cross-review P0, round 7, 2026-07-21).
        rollbackPlan = resumeApplying
          ? await loadPersistedRollbackPlan(rootDir, options.runId, options.taskId)
          : await createFileRollbackPlan(rootDir, files);
        if (!rollbackPlan) {
          // §3.4：applying 续跑须用中断前 preimage；无 plan 禁止对已变异工作区重 apply。
          throw new Error(`parallel admission cannot resume ${options.taskId}: persisted rollback plan is missing; claim kept for manual recovery`);
        }
        // A new admission persists its pre-images BEFORE the first write.
        // A resumed admission must never overwrite that authority with a
        // snapshot of the already-mutated workspace.
        if (!resumeApplying) {
          await persistRollbackPlan(rootDir, options.runId, options.taskId, rollbackPlan);
        }
        await advanceClaimPhaseWithinLock(rootDir, options.taskId, options.runId, "applying", proposedPaths);
        for (const file of files) {
          const absolutePath = path.join(rootDir, file.path);
          assertPathInsideRoot(rootDir, absolutePath, file.path);
          await mkdir(path.dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, file.content, "utf8");
        }
      } else {
        rollbackPlan = { mode: "patch", patch: result.result.patch, paths: proposedPaths };
        await persistRollbackPlan(rootDir, options.runId, options.taskId, rollbackPlan);
        await advanceClaimPhaseWithinLock(rootDir, options.taskId, options.runId, "applying", proposedPaths);
        const alreadyApplied = resumeApplying && (await patchAlreadyApplied(rootDir, result.result.patch));
        if (!alreadyApplied) await applyAgentPatch(rootDir, result.result.patch);
        const actualPaths = await collectActualAdmissionPaths(rootDir, proposedPaths);
        const actualDenied = actualPaths.filter((filePath) => !pathAllowed(filePath, claim.writablePaths));
        if (actualDenied.length > 0) {
          // §3.4：实际写入路径二次校验；越界触发同 claim 回滚，不得带着脏文件进 gate。
          throw new Error(`parallel admission denied by actual written paths: ${actualDenied.join(", ")}`);
        }
        rollbackPlan.paths = actualPaths;
        appliedPaths = actualPaths;
      }
    } catch (error) {
      const applyError = error instanceof Error ? error : new Error(String(error));
      // §3.4：apply 失败须在同 claim 下回滚；rollback 失败保留 owner 与 plan，禁止释放脏工作区。
      const rollback = applyError.code === "patch_precheck_failed" && !resumeApplying
        ? { status: "rolled_back", reason: "patch_not_applied", paths: [] }
        : await rollbackAdmissionChanges(rootDir, rollbackPlan);
      await recordApplyFailureWithinLock(rootDir, options.taskId, {
        runId: options.runId,
        error: applyError,
        rollback,
      });
      if (rollback.status === "rolled_back") {
        await removePersistedRollbackPlan(rootDir, options.runId, options.taskId);
      }
      await updateAgentRunLifecycle(rootDir, options.runId, options.taskId, "awaiting_revision", {
        admissionStatus: rollback.status === "rolled_back" ? "apply_failed" : "recovery_required",
        rollback,
      }).catch(() => {});
      throw new Error(`parallel admission failed while applying files (workspace rollback: ${rollback.status}): ${applyError.message}`);
    }
    // Files are on disk: advance the persisted claim phase so a crash from
    // here on resumes into finalize instead of re-applying.
    await advanceClaimPhaseWithinLock(rootDir, options.taskId, options.runId, "finalizing", appliedPaths);
  }

  // --- gates 与完成 ---
  // Phase 3 — gates through the shared delivery pipeline. A crash anywhere
  // in here (review report, completion ledger, wisdom, digest, canonical
  // persist) must NOT roll the workspace back: the artifact may be good and
  // parts of the completion transaction may already be on the ledger. The
  // claim stays persisted at phase "finalizing" (and the pre-image plan
  // stays on disk), which is exactly the resumable state — re-admitting the
  // same run skips the apply and re-runs the gates.
  try {
    const deliveryWorktreeDir = result.isolation === "git-worktree" && result.worktreeAvailable === true && result.workDir
      ? path.resolve(rootDir, result.workDir)
      : null;
    if (deliveryWorktreeDir) assertPathInsideRoot(rootDir, deliveryWorktreeDir, result.workDir);
    const finalized = await finalizeAdmissionWithinLock(rootDir, options.taskId, {
      workerResult: claim.workerResult,
      changedPaths: appliedPaths,
      runId: options.runId,
      rollbackPlan,
      integrationGuard,
      deliveryWorktreeDir,
      deliveryFromWorktree: deliveryWorktreeDir && files.length === 0 && typeof result.result?.patch === "string",
    });
    return { ...finalized, appliedPaths };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // §3.4：finalize 崩溃保留 finalizing claim 与磁盘变更，禁止回滚；同 run 续跑 gate。
    await appendLedger(rootDir, {
      type: "parallel_agent_admission_finalize_interrupted",
      runId: options.runId,
      taskId: options.taskId,
      error: message,
    }).catch(() => {});
    throw new Error(`parallel admission was interrupted while finalizing (workspace changes kept, claim held by run ${options.runId}): ${message}。修复故障后用同一 run 重新 admit 即可从中断处续跑`);
  }
}

/**
 * Phase 3：经 delivery-pipeline 跑 gate 并完成或回滚；在调用方锁内运行，禁止二次加锁。
 * 非 completed 时须先回滚工作区再释放 claim，避免后继 run 被旧 rollback 覆盖。
 */
async function finalizeAdmissionWithinLock(rootDir, taskId, { workerResult, changedPaths, runId, rollbackPlan, integrationGuard, deliveryWorktreeDir, deliveryFromWorktree }) {
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
