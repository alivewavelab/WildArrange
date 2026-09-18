/**
 * Admission outcome projection: once the admission transaction
 * (./admission.mjs) has adjudicated a result, these helpers project it onto
 * the persisted surfaces — the task state (claim phase progress and
 * rollback-failure recovery), the agent-run lifecycle files (per-task
 * result.json, batch JSON, index.json) and the decisions.jsonl seam.
 *
 * Extracted from admission.mjs (architecture phase 4 split, ARC-002) — that
 * file mixed the claim -> apply -> gates transaction with this write-back
 * segment, two distinct reasons to change.
 *
 * The *WithinLock helpers run inside the caller's task-state lock hold and
 * MUST NOT acquire the task-state lock themselves.
 */
import { appendLedger } from "../infra/ledger.mjs";
import { emitDecision } from "../infra/decision-log.mjs";
import {
  nowIso,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { buildFailureSummary } from "../infra/failure-analysis.mjs";
import { writeFailureReport } from "../infra/task-reports.mjs";
import { loadTaskState } from "./plan-state.mjs";
import { persistTaskState } from "./task-board.mjs";

/** 决策投影：admission 是四个决策缝之一，结果（含回滚原因）进 decisions.jsonl。 */
export async function emitAdmissionDecision(rootDir, options, finalized) {
  const rollback = finalized.rollback || null;
  await emitDecision(rootDir, {
    gate: "admission",
    decision: finalized.status,
    code: rollback?.status === "rollback_failed" ? "rollback_failed" : finalized.status === "completed" ? null : finalized.status,
    reason: finalized.note || rollback?.error || (rollback ? `rollback: ${rollback.status}` : null),
    summary: `admit run ${options.runId} task ${options.taskId} -> ${finalized.status}${finalized.appliedPaths?.length ? ` (${finalized.appliedPaths.length} paths)` : ""}`,
    evidencePath: finalized.acceptanceProof?.reportMdPath || finalized.acceptanceProof?.reportJsonPath || null,
    taskId: options.taskId,
    runId: options.runId,
    // admission 是归属决策（非确定性放行）且失败即拦截：全部进标注队列。
    annotatable: true,
  });
}

/**
 * Shared "rollback did not complete" persistence: the task stays verifying,
 * ownership/claim and the rollback plan are retained, the failure is recorded
 * on the task, and the admission reports recovery_required instead of
 * releasing a dirty workspace. Runs inside the caller's lock hold; MUST NOT
 * acquire the task-state lock.
 */
export async function persistRollbackFailureRecovery(rootDir, taskState, task, {
  rollback,
  reason,
  summary,
  retryHint,
  failureContext = null,
  gateResults = {},
  integrationCommit,
}) {
  task.status = "verifying";
  task.last_failure = failureContext
    ? buildFailureSummary(task, { ...failureContext, nextStatus: task.status })
    : { at: nowIso() };
  task.last_failure.reason = reason;
  task.last_failure.summary = summary;
  task.last_failure.retryHint = retryHint;
  task.updatedAt = nowIso();
  await writeFailureReport(rootDir, taskState.planId, task);
  await persistTaskState(rootDir, taskState);
  const result = {
    status: "recovery_required",
    planId: taskState.planId,
    task,
    acceptanceProof: gateResults.acceptanceProof || null,
    verifyResult: gateResults.verifyResult || null,
    scopeResult: gateResults.scopeResult || null,
    reviewResult: gateResults.reviewResult || null,
  };
  if (integrationCommit !== undefined) result.integrationCommit = integrationCommit;
  result.rollback = rollback;
  return result;
}

/**
 * Advances the persisted claim phase (applying -> finalizing) once the
 * child's files are on disk. Runs inside the caller's lock hold; MUST NOT
 * acquire the task-state lock.
 */
export async function advanceClaimPhaseWithinLock(rootDir, taskId, runId, phase, appliedPaths) {
  const taskState = await loadTaskState(rootDir);
  const task = taskState?.tasks.find((candidate) => candidate.id === taskId);
  if (!task || task.admission_claim?.runId !== runId) return;
  task.admission_claim.phase = phase;
  task.admission_claim.workspaceRestored = false;
  task.admission_claim.appliedPaths = appliedPaths;
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
}

export async function updateAgentRunLifecycle(rootDir, runId, taskId, status, details = {}) {
  const resultPath = resolveWildArrangePath(rootDir, "agent-runs", runId, taskId, "result.json");
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

  const batchPath = resolveWildArrangePath(rootDir, "agent-runs", `${runId}.json`);
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

  const indexPath = resolveWildArrangePath(rootDir, "agent-runs", "index.json");
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
