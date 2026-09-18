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
//     任务锁内 claim → 写回滚计划 → apply → finalize 模块 → 完成或 recovery。
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
import { withTaskStateLock } from "../infra/task-state-lock.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { captureIntegrationGuard } from "../infra/git-coordination.mjs";
import { applyAgentPatch, extractPatchPaths } from "../infra/git-worktree.mjs";
import { assertPathInsideRoot, pathAllowed } from "../infra/path-match.mjs";
import { runPostCompletionSideEffects } from "./delivery-pipeline.mjs";
import {
  createFileRollbackPlan,
  loadPersistedRollbackPlan,
  patchAlreadyApplied,
  persistRollbackPlan,
  removePersistedRollbackPlan,
  rollbackAdmissionChanges,
  recordApplyFailureWithinLock,
} from "./admission-recovery.mjs";
import {
  advanceClaimPhaseWithinLock,
  emitAdmissionDecision,
  updateAgentRunLifecycle,
} from "./admission-projection.mjs";
import { loadTaskState } from "./plan-state.mjs";
import { claimAdmission } from "./admission-claim.mjs";
import { finalizeAdmissionWithinLock } from "./admission-finalize.mjs";
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
