/**
 * Parallel-agent admission transaction: claiming a task on behalf of a run,
 * applying the child's files/patch into the shared workspace, running the
 * shared delivery pipeline, and rolling back / releasing on failure.
 *
 * Extracted from parallel-runtime.mjs (cross-review P2, round 7,
 * 2026-07-21) — that file kept growing past the 1000-line budget while
 * mixing spawn/collect/index concerns with this transaction.
 *
 * Concurrency model (cross-review P0, round 7, 2026-07-21): every
 * `withTaskStateLock` call in the codebase serializes on ONE lock file
 * (`.helix/team/tasks.lock`), and the linear `helix run` holds it for its
 * whole worker+gates cycle. Admission therefore holds that same lock for
 * the entire apply -> gates -> commit/rollback critical section, so two
 * admissions (same or different tasks, overlapping paths or not) and a
 * concurrent linear run can never interleave their workspace writes with
 * each other's gate runs.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  appendLedger,
  ensureHelixDirs,
  nowIso,
  readJson,
  resolveHelixPath,
  withTaskStateLock,
  writeJsonAtomic,
  writeSnapshot,
} from "../infra/foundation.mjs";
import { readVerifiedLedgerEntries } from "../infra/ledger.mjs";
import { buildFailureSummary } from "../infra/failure-analysis.mjs";
import { appendWisdom, writeFailureReport, writeReviewReport } from "../infra/task-reports.mjs";
import { writeMemoryDigest } from "../infra/memory-digest.mjs";
import { applyAgentPatch, extractPatchPaths } from "../infra/git-worktree.mjs";
import { runCommand } from "../infra/command-runner.mjs";
import { pathAllowed } from "../infra/path-match.mjs";
import { runDeliveryPipeline, runPostCompletionSideEffects } from "./delivery-pipeline.mjs";
import { loadTaskState } from "./plan-state.mjs";
import { persistTaskState } from "./task-board.mjs";

export async function admitParallelAgentResult(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
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

  // Phase 1 — claim. Status adjudication, writable-paths precheck, the task
  // claim (verifying + admission evidence) and the started ledger event all
  // happen under one task-state lock, BEFORE any workspace file is touched
  // (cross-review P0, round 5, 2026-07-21). This both closes the
  // check-then-write race and guarantees that every workspace mutation has
  // an established transaction (started ledger + claimed task) behind it.
  const claim = await withTaskStateLock(rootDir, `parallel-admit:${options.taskId}`, () =>
    claimAdmission(rootDir, options, { result, files, proposedPaths }));

  if (claim.kind === "resume") {
    await updateAgentRunLifecycle(rootDir, options.runId, options.taskId, "released", {
      admissionStatus: "completed",
      releasedAt: nowIso(),
      rollback: null,
      resumed: true,
    });
    await writeSnapshot(rootDir, "parallel_agent_admission_completed", {
      runId: options.runId,
      taskId: options.taskId,
      status: "completed",
      appliedPaths: claim.appliedPaths,
      resumed: true,
    });
    return {
      kind: "parallel_agent_admission",
      runId: options.runId,
      taskId: options.taskId,
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
    runAdmissionTransaction(rootDir, options, { claim, result, files, proposedPaths }));

  // For the completed outcome the admission ledger event was already written
  // inside the transaction, BEFORE the canonical completed persist (ledger
  // first, state last). Only non-completed outcomes are logged here, with
  // rollback info (the rollback itself already happened inside the lock,
  // BEFORE the claim was released).
  if (finalized.status !== "completed") {
    await appendLedger(rootDir, {
      type: "parallel_agent_admission_completed",
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
      runId: options.runId,
      taskId: options.taskId,
      status: finalized.status,
      appliedPaths: finalized.appliedPaths,
      rollback: finalized.rollback,
    });
  });
  return {
    kind: "parallel_agent_admission",
    runId: options.runId,
    taskId: options.taskId,
    status: finalized.status,
    appliedPaths: finalized.appliedPaths,
    verifyResult: finalized.verifyResult,
    scopeResult: finalized.scopeResult,
    reviewResult: finalized.reviewResult,
    acceptanceProof: finalized.acceptanceProof || null,
    rollback: finalized.rollback,
    sideEffectWarnings,
    task: finalized.task,
  };
}

/** Phase 1 body — runs under the task-state lock. */
async function claimAdmission(rootDir, options, { result, files, proposedPaths }) {
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = taskState.tasks.find((candidate) => candidate.id === options.taskId);
  if (!task) throw new Error(`unknown task: ${options.taskId}`);

  if (task.status === "completed") {
    // A completed task is either an idempotent resume (THIS run completed
    // it through the gates, only the lifecycle release was interrupted) or
    // a hard refusal. "This run completed it" requires a chain-verified
    // completed ledger event for this exact run — the admission-started
    // evidence entry alone is not enough, because a run whose admission
    // failed and rolled back also left one behind (cross-review P1,
    // round 5, 2026-07-21).
    const completedByThisRun = await hasVerifiedRunCompletionEvent(rootDir, options.runId, options.taskId);
    if (!completedByThisRun) {
      throw new Error(`task ${options.taskId} is already completed; refusing to apply parallel result from run ${options.runId}`);
    }
    const admissionEvidence = [...(task.evidence || [])].reverse().find(
      (entry) => entry?.kind === "parallel_agent_admission" && entry.runId === options.runId,
    );
    return { kind: "resume", task, appliedPaths: admissionEvidence?.appliedPaths || [] };
  }
  // Ownership: an active admission claim is persisted on the task, so a
  // "verifying" task can tell apart "another run is admitting right now"
  // (refuse — otherwise two runs can both complete the same task, cross-
  // review P0, round 6, 2026-07-21) from "MY admission crashed mid-flight"
  // (reclaim and continue from the recorded phase, without re-running the
  // parts that already happened).
  if (task.admission_claim?.runId && task.status === "verifying") {
    if (task.admission_claim.runId !== options.runId) {
      throw new Error(`task ${options.taskId} is currently claimed by parallel admission run ${task.admission_claim.runId} (phase: ${task.admission_claim.phase}); refusing run ${options.runId}. 若那次 admission 已崩溃，用原 run 重新 admit 即可续跑`);
    }
    const priorWorker = [...(task.evidence || [])].reverse().find(
      (entry) => entry?.kind === "worker" && entry.source === "parallel_agent_admission" && entry.runId === options.runId,
    );
    await appendLedger(rootDir, {
      type: "parallel_agent_admission_reclaimed",
      runId: options.runId,
      taskId: options.taskId,
      phase: task.admission_claim.phase,
    });
    return {
      kind: "reclaimed",
      workerResult: priorWorker || {
        kind: "worker",
        at: nowIso(),
        command: `parallel_admit:${options.runId}:${options.taskId}`,
        exitCode: 0,
        stdout: "reclaimed admission (original worker evidence missing)",
        stderr: "",
        source: "parallel_agent_admission",
        runId: options.runId,
        agent: result.agent,
      },
      writablePaths: task.writable_paths || [],
    };
  }
  if (!["pending", "in_progress", "verifying"].includes(task.status)) {
    throw new Error(`task ${options.taskId} status ${task.status} cannot admit parallel result`);
  }
  const denied = proposedPaths.filter((filePath) => !pathAllowed(filePath, task.writable_paths || []));
  if (denied.length > 0) {
    throw new Error(`parallel admission denied by writable_paths: ${denied.join(", ")}`);
  }

  const workerResult = {
    kind: "worker",
    at: nowIso(),
    command: `parallel_admit:${options.runId}:${options.taskId}`,
    exitCode: 0,
    stdout: files.length > 0
      ? `Admitted ${files.length} file(s) from ${result.agent}`
      : `Admitted patch with ${proposedPaths.length} path(s) from ${result.agent}`,
    stderr: "",
    source: "parallel_agent_admission",
    runId: options.runId,
    agent: result.agent,
    resultPath: result.runDir ? `${result.runDir}/result.json` : null,
  };
  if (task.status === "pending") task.attempts += 1;
  task.status = "verifying";
  // The claim carries the owner and the phase, so concurrent admissions
  // are refused above and a crashed admission can resume deterministically.
  task.admission_claim = {
    runId: options.runId,
    agent: result.agent,
    claimedAt: nowIso(),
    phase: "applying",
    appliedPaths: proposedPaths,
  };
  // New admission round invalidates gate results from previous rounds
  // (same rule as the linear runtime's new-worker-round clearing).
  task.last_verify_result = null;
  task.last_scope_result = null;
  task.last_review_result = null;
  task.evidence.push(workerResult);
  task.evidence.push({
    kind: "parallel_agent_admission",
    at: nowIso(),
    runId: options.runId,
    agent: result.agent,
    appliedPaths: proposedPaths,
    admissionMode: files.length > 0 ? "files" : "patch",
    summary: result.result?.summary || "",
  });
  task.updatedAt = nowIso();
  await appendLedger(rootDir, {
    type: "parallel_agent_admission_started",
    runId: options.runId,
    taskId: options.taskId,
    agent: result.agent,
    appliedPaths: proposedPaths,
  });
  await persistTaskState(rootDir, taskState);
  return { kind: "claimed", workerResult, writablePaths: task.writable_paths || [] };
}

/** Phases 2+3 body — runs under one continuous task-state lock hold. */
async function runAdmissionTransaction(rootDir, options, { claim, result, files, proposedPaths }) {
  // Phase 1 and this transaction use separate lock holds. A duplicate call
  // from the same run may have captured an older phase while waiting, so the
  // persisted claim is the authority immediately before any workspace I/O.
  const liveTaskState = await loadTaskState(rootDir);
  const liveTask = liveTaskState?.tasks.find((candidate) => candidate.id === options.taskId);
  if (liveTask?.status !== "verifying" || liveTask.admission_claim?.runId !== options.runId) {
    throw new Error(`task ${options.taskId} admission ownership changed before apply; refusing stale transaction from run ${options.runId}`);
  }
  const livePhase = liveTask.admission_claim.phase;
  if (!["applying", "finalizing"].includes(livePhase)) {
    throw new Error(`task ${options.taskId} has unsupported admission phase ${livePhase || "missing"}; claim kept for manual recovery`);
  }
  const resumeFinalizing = livePhase === "finalizing";
  const resumeApplying = claim.kind === "reclaimed" && livePhase === "applying";
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
      throw new Error(`parallel admission cannot resume ${options.taskId}: persisted rollback plan is missing; claim kept for manual recovery`);
    }
  } else {
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
          throw new Error(`parallel admission cannot resume ${options.taskId}: persisted rollback plan is missing; claim kept for manual recovery`);
        }
        // A new admission persists its pre-images BEFORE the first write.
        // A resumed admission must never overwrite that authority with a
        // snapshot of the already-mutated workspace.
        if (!resumeApplying) {
          await persistRollbackPlan(rootDir, options.runId, options.taskId, rollbackPlan);
        }
        for (const file of files) {
          const absolutePath = path.join(rootDir, file.path);
          assertInsideRoot(rootDir, absolutePath, file.path);
          await mkdir(path.dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, file.content, "utf8");
        }
      } else {
        rollbackPlan = { mode: "patch", patch: result.result.patch, paths: proposedPaths };
        await persistRollbackPlan(rootDir, options.runId, options.taskId, rollbackPlan);
        const alreadyApplied = claim.kind === "reclaimed" && (await patchAlreadyApplied(rootDir, result.result.patch));
        if (!alreadyApplied) await applyAgentPatch(rootDir, result.result.patch);
        const actualPaths = await collectActualAdmissionPaths(rootDir, proposedPaths);
        const actualDenied = actualPaths.filter((filePath) => !pathAllowed(filePath, claim.writablePaths));
        if (actualDenied.length > 0) {
          throw new Error(`parallel admission denied by actual written paths: ${actualDenied.join(", ")}`);
        }
        rollbackPlan.paths = actualPaths;
        appliedPaths = actualPaths;
      }
    } catch (error) {
      const applyError = error instanceof Error ? error : new Error(String(error));
      const rollback = await rollbackAdmissionChanges(rootDir, rollbackPlan);
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

  // Phase 3 — gates through the shared delivery pipeline. A crash anywhere
  // in here (review report, completion ledger, wisdom, digest, canonical
  // persist) must NOT roll the workspace back: the artifact may be good and
  // parts of the completion transaction may already be on the ledger. The
  // claim stays persisted at phase "finalizing" (and the pre-image plan
  // stays on disk), which is exactly the resumable state — re-admitting the
  // same run skips the apply and re-runs the gates.
  try {
    const finalized = await finalizeAdmissionWithinLock(rootDir, options.taskId, {
      workerResult: claim.workerResult,
      changedPaths: appliedPaths,
      runId: options.runId,
      rollbackPlan,
    });
    return { ...finalized, appliedPaths };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
 * Phase 3 body — gate the applied changes and commit or roll back. Runs
 * inside the caller's lock hold; MUST NOT acquire the task-state lock.
 * On any non-completed outcome the workspace rollback happens FIRST, while
 * this admission still owns the claim — releasing the claim before rolling
 * back opened a window where a successor run could claim, complete, and
 * then be clobbered by the old rollback (cross-review P0, round 7,
 * 2026-07-21).
 */
async function finalizeAdmissionWithinLock(rootDir, taskId, { workerResult, changedPaths, runId, rollbackPlan }) {
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = taskState.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  // Ownership gate: finalize may only commit on behalf of the run that
  // holds the persisted claim (cross-review P0, round 6, 2026-07-21).
  if (task.admission_claim?.runId !== runId) {
    throw new Error(`task ${taskId} admission claim is ${task.admission_claim ? `held by run ${task.admission_claim.runId}` : "no longer held"}; refusing to finalize on behalf of run ${runId}`);
  }

  // Same shared pipeline as the linear runtime: gate order lives in
  // delivery-pipeline.mjs only.
  const pipelineResult = await runDeliveryPipeline(rootDir, taskState.planId, task, {
    initialEvidence: { workerResult },
    changedPaths,
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

  if (pipelineResult.status === "completed") {
    task.status = "completed";
    task.admission_claim = null;
    task.updatedAt = nowIso();
    // Ledger first, canonical tasks.json last (commit point): a ledger
    // outage must never leave a completed/released admission without its
    // completion ledger event (cross-review P0, round 3, 2026-07-21).
    await appendLedger(rootDir, {
      type: "parallel_agent_admission_completed",
      runId: runId || null,
      taskId,
      status: "completed",
      appliedPaths: changedPaths || [],
      rollback: null,
    });
    // Wisdom and digest are INSIDE the completion transaction (before the
    // canonical persist): if either write fails, the task stays verifying
    // and the recovery re-runs the whole completion (cross-review P1,
    // round 5, 2026-07-21).
    await appendWisdom(rootDir, task, verifyResult);
    await writeMemoryDigest(rootDir, { reason: "parallel_admission_completed", stage: "checkpoint", task, taskId });
    await persistTaskState(rootDir, taskState);
    await removePersistedRollbackPlan(rootDir, runId, taskId);
    return { status: "completed", planId: taskState.planId, task, acceptanceProof, verifyResult, scopeResult, reviewResult, rollback: null };
  }

  // Non-completed: restore the workspace BEFORE releasing the claim.
  const rollback = await rollbackAdmissionChanges(rootDir, rollbackPlan);

  if (rollback.status !== "rolled_back") {
    task.status = "verifying";
    task.last_failure = buildFailureSummary(task, {
      workerResult,
      verifyResult,
      scopeResult,
      reviewResult,
      criteriaResult: criteria,
      nextStatus: task.status,
    });
    task.last_failure.reason = "admission_rollback_failed";
    task.last_failure.summary = `parallel admission rollback failed: ${rollback.error || rollback.reason || "unknown error"}`;
    task.last_failure.retryHint = `任务所有权和 rollback plan 已保留；修复文件系统问题后，用同一 run 重新 admit。涉及路径：${(rollback.paths || []).join(", ") || "unknown"}`;
    task.updatedAt = nowIso();
    await writeFailureReport(rootDir, taskState.planId, task);
    await persistTaskState(rootDir, taskState);
    return { status: "recovery_required", planId: taskState.planId, task, acceptanceProof, verifyResult, scopeResult, reviewResult, rollback };
  }

  if (pipelineResult.status === "checkpoint_failed") {
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
    task.last_failure.retryHint = "checkpoint 写入失败（检查 .helix/checkpoints 目录是否可写），修复后重新 admit 即可，所有质量门已通过";
    task.updatedAt = nowIso();
    await writeFailureReport(rootDir, taskState.planId, task);
    await persistTaskState(rootDir, taskState);
    await removePersistedRollbackPlan(rootDir, runId, taskId);
    await appendLedger(rootDir, { type: "checkpoint_write_failed", planId: taskState.planId, taskId: task.id, error: pipelineResult.evidence.checkpointError?.message || null });
    return { status: "retry", planId: taskState.planId, task, acceptanceProof, verifyResult, scopeResult, reviewResult, rollback };
  }

  task.status = shouldFailAdmission(task, verifyResult, scopeResult, reviewResult) ? "failed" : "pending";
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
  await persistTaskState(rootDir, taskState);
  await removePersistedRollbackPlan(rootDir, runId, taskId);
  return { status: task.status === "failed" ? "failed" : "retry", planId: taskState.planId, task, acceptanceProof, verifyResult, scopeResult, reviewResult, rollback };
}

/**
 * Records a failed file application. A successful rollback releases the
 * claim; a failed rollback keeps ownership and the task in verifying so a
 * successor cannot enter a dirty workspace. Runs inside the caller's lock
 * hold; MUST NOT acquire the task-state lock.
 */
async function recordApplyFailureWithinLock(rootDir, taskId, { runId, error, rollback }) {
  const taskState = await loadTaskState(rootDir);
  if (!taskState) return;
  const task = taskState.tasks.find((candidate) => candidate.id === taskId);
  if (!task || task.status !== "verifying") return;
  const rolledBack = rollback?.status === "rolled_back";
  task.status = rolledBack ? "pending" : "verifying";
  if (rolledBack) task.admission_claim = null;
  task.last_failure = {
    at: nowIso(),
    reason: rolledBack ? "admission_apply_failed" : "admission_rollback_failed",
    summary: rolledBack
      ? `parallel admission failed while applying files: ${error.message}`
      : `parallel admission apply failed and workspace rollback did not complete: ${rollback?.error || error.message}`,
    retryHint: rolledBack
      ? "工作区已回滚到 admission 前的内容，修复失败原因后重新 admit 即可"
      : `工作区回滚失败；任务所有权和 rollback plan 已保留。修复文件系统问题后，用同一 run 重新 admit。涉及路径：${(rollback?.paths || []).join(", ") || "unknown"}`,
  };
  task.updatedAt = nowIso();
  await appendLedger(rootDir, {
    type: "parallel_agent_admission_apply_failed",
    runId: runId || null,
    taskId,
    error: error.message,
    rollback: rollback?.status || null,
    rollbackPaths: rollback?.paths || [],
  });
  await persistTaskState(rootDir, taskState);
}

/**
 * Advances the persisted claim phase (applying -> finalizing) once the
 * child's files are on disk. Runs inside the caller's lock hold; MUST NOT
 * acquire the task-state lock.
 */
async function advanceClaimPhaseWithinLock(rootDir, taskId, runId, phase, appliedPaths) {
  const taskState = await loadTaskState(rootDir);
  const task = taskState?.tasks.find((candidate) => candidate.id === taskId);
  if (!task || task.admission_claim?.runId !== runId) return;
  task.admission_claim.phase = phase;
  task.admission_claim.appliedPaths = appliedPaths;
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
}

function rollbackPlanPath(rootDir, runId, taskId) {
  // Lives in the run dir, NOT the per-task dir: the per-task dir belongs to
  // the child's result/lifecycle, and a failure there (e.g. read-only dir)
  // must interrupt the lifecycle release, not the apply phase.
  return resolveHelixPath(rootDir, "agent-runs", runId, `${taskId}.rollback-plan.json`);
}

/**
 * The pre-image rollback plan is persisted to the run directory BEFORE the
 * first workspace write, so a crash mid-apply (or later) never orphans the
 * only copy of the original file contents (cross-review P0, round 7,
 * 2026-07-21). It is removed only after completion or a successful rollback.
 */
async function persistRollbackPlan(rootDir, runId, taskId, rollbackPlan) {
  await writeJsonAtomic(rollbackPlanPath(rootDir, runId, taskId), {
    runId,
    taskId,
    persistedAt: nowIso(),
    plan: rollbackPlan,
  });
}

async function loadPersistedRollbackPlan(rootDir, runId, taskId) {
  const stored = await readJson(rollbackPlanPath(rootDir, runId, taskId), null);
  return stored?.plan || null;
}

async function removePersistedRollbackPlan(rootDir, runId, taskId) {
  await rm(rollbackPlanPath(rootDir, runId, taskId), { force: true }).catch(() => {});
}

/**
 * True when the patch is already present in the workspace (git can apply it
 * in reverse). Used by the crash-resume path of an "applying"-phase claim,
 * where we cannot know whether the interrupted attempt got the patch in.
 */
async function patchAlreadyApplied(rootDir, patch) {
  const patchPath = path.join(rootDir, ".helix", "agent-runs", `recheck-${Date.now()}-${process.pid}.patch`);
  await writeFile(patchPath, patch, "utf8");
  try {
    const reverseCheck = await runCommand(`git -C ${shellEscape(rootDir)} apply --reverse --check --whitespace=nowarn ${shellEscape(patchPath)}`, rootDir, 30_000);
    return reverseCheck.exitCode === 0;
  } finally {
    await rm(patchPath, { force: true });
  }
}

/**
 * True only when the chain-verified ledger contains a completed admission
 * event for this exact run+task. Used by the resume branch: an admission
 * that failed and rolled back also left admission evidence on the task, so
 * evidence alone cannot prove "this run is the one that completed the task".
 */
async function hasVerifiedRunCompletionEvent(rootDir, runId, taskId) {
  const entries = await readVerifiedLedgerEntries(rootDir);
  return entries.some(
    (entry) => entry.type === "parallel_agent_admission_completed"
      && entry.runId === runId
      && entry.taskId === taskId
      && entry.status === "completed",
  );
}

async function collectActualAdmissionPaths(rootDir, fallbackPaths) {
  const result = await runCommand("git diff --name-only -- . ':!.helix'", rootDir, 30_000);
  if (result.exitCode !== 0) return fallbackPaths;
  const paths = result.stdout.split(/\r?\n/).map((line) => normalizeRelativePath(line.trim())).filter(Boolean);
  return paths.length > 0 ? [...new Set(paths)] : fallbackPaths;
}

async function createFileRollbackPlan(rootDir, files) {
  const entries = [];
  for (const file of files) {
    const absolutePath = path.join(rootDir, file.path);
    assertInsideRoot(rootDir, absolutePath, file.path);
    try {
      entries.push({
        path: file.path,
        existed: true,
        content: await readFile(absolutePath, "utf8"),
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      entries.push({ path: file.path, existed: false, content: "" });
    }
  }
  return { mode: "files", paths: files.map((file) => file.path), entries };
}

async function rollbackAdmissionChanges(rootDir, rollbackPlan) {
  if (!rollbackPlan || rollbackPlan.mode === "none") {
    return { status: "skipped", reason: "no rollback plan" };
  }
  try {
    if (rollbackPlan.mode === "files") {
      for (const entry of rollbackPlan.entries || []) {
        const absolutePath = path.join(rootDir, entry.path);
        assertInsideRoot(rootDir, absolutePath, entry.path);
        if (entry.existed) {
          await mkdir(path.dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, entry.content, "utf8");
        } else {
          await rm(absolutePath, { force: true });
        }
      }
    } else if (rollbackPlan.mode === "patch") {
      const patchPath = path.join(rootDir, ".helix", "agent-runs", `rollback-${Date.now()}-${process.pid}.patch`);
      await writeFile(patchPath, rollbackPlan.patch, "utf8");
      const reverse = await runCommand(`git -C ${shellEscape(rootDir)} apply --reverse --whitespace=nowarn ${shellEscape(patchPath)}`, rootDir, 30_000);
      if (reverse.exitCode !== 0) {
        throw new Error(reverse.stderr || reverse.stdout || "git apply --reverse failed");
      }
    }
    await appendLedger(rootDir, { type: "parallel_agent_admission_rolled_back", mode: rollbackPlan.mode, paths: rollbackPlan.paths || [] });
    return { status: "rolled_back", mode: rollbackPlan.mode, paths: rollbackPlan.paths || [] };
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    await appendLedger(rootDir, { type: "parallel_agent_admission_rollback_failed", mode: rollbackPlan.mode, paths: rollbackPlan.paths || [], error: summary });
    return { status: "rollback_failed", mode: rollbackPlan.mode, paths: rollbackPlan.paths || [], error: summary };
  }
}

export async function readParallelAgentResult(rootDir, runId, taskId) {
  const directPath = resolveHelixPath(rootDir, "agent-runs", runId, taskId, "result.json");
  const result = await readJson(directPath, null);
  if (!result) throw new Error(`parallel result not found: ${path.relative(rootDir, directPath)}`);
  return result;
}

export async function updateAgentRunLifecycle(rootDir, runId, taskId, status, details = {}) {
  const resultPath = resolveHelixPath(rootDir, "agent-runs", runId, taskId, "result.json");
  const result = await readJson(resultPath, null);
  if (result) {
    result.lifecycle = {
      ...(result.lifecycle || {}),
      status,
      updatedAt: nowIso(),
      ...details,
    };
    await writeJsonAtomic(resultPath, result);
  }

  const batchPath = resolveHelixPath(rootDir, "agent-runs", `${runId}.json`);
  const batch = await readJson(batchPath, null);
  if (batch) {
    for (const entry of batch.results || []) {
      if (entry.taskId !== taskId) continue;
      entry.lifecycle = {
        ...(entry.lifecycle || {}),
        status,
        updatedAt: nowIso(),
        ...details,
      };
    }
    await writeJsonAtomic(batchPath, batch);
  }

  const indexPath = resolveHelixPath(rootDir, "agent-runs", "index.json");
  const index = await readJson(indexPath, { runs: [] });
  for (const run of index.runs || []) {
    if (run.runId !== runId) continue;
    for (const entry of run.results || []) {
      if (entry.taskId !== taskId) continue;
      entry.lifecycle = {
        ...(entry.lifecycle || {}),
        status,
        updatedAt: nowIso(),
        ...details,
      };
    }
    run.updatedAt = nowIso();
  }
  await writeJsonAtomic(indexPath, index);
  await appendLedger(rootDir, { type: "parallel_agent_lifecycle_updated", runId, taskId, status });
}

export function normalizeProposedFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.map((file, index) => {
    if (!file || typeof file !== "object") throw new Error(`result.files[${index}] must be an object`);
    const filePath = normalizeRelativePath(file.path || file.file);
    if (!filePath) throw new Error(`result.files[${index}].path is required`);
    if (path.isAbsolute(filePath) || filePath.startsWith("../") || filePath.includes("/../")) {
      throw new Error(`result.files[${index}].path must stay inside the project`);
    }
    if (typeof file.content !== "string") throw new Error(`result.files[${index}].content must be a string`);
    return { path: filePath, content: file.content };
  });
}

export function normalizeProposedFilesOrEmpty(files) {
  try {
    return normalizeProposedFiles(files);
  } catch {
    return [];
  }
}

function normalizePatchPaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths.map(normalizeRelativePath).filter((filePath) => filePath && !path.isAbsolute(filePath) && !filePath.startsWith("../") && !filePath.includes("/../"));
}

function assertInsideRoot(rootDir, absolutePath, displayPath) {
  const relative = path.relative(rootDir, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes project root: ${displayPath}`);
  }
}

function shouldFailAdmission(task, verifyResult, scopeResult, reviewResult) {
  if (scopeResult?.status === "fail") return true;
  if (scopeResult && scopeResult.status !== "pass") return true;
  if (verifyResult?.pass === true && reviewResult?.kind === "review_gate" && reviewResult.pass === false) return true;
  return task.attempts >= task.maxAttempts;
}

function normalizeRelativePath(filePath) {
  return String(filePath || "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function shellEscape(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
