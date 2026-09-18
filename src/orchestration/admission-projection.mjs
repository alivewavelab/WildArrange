// =============================================================================
// 文件名称：admission-projection.mjs
// 所属模块：orchestration
// 作用说明：
//   Admission 结果投影：事务裁决完成后，将 claim 阶段、回滚失败恢复、
//   agent-run 生命周期与 decisions.jsonl 写回持久化面。自 admission.mjs 拆分（ARC-002）。
//
// 【运行原理速读】
//   可以把它想成「admission 判完案后的文书工作」：
//
//   · 何时执行？
//     admission.mjs 在 apply/gates 各阶段完成后调用 WithinLock 助手。
//
//   · 做了什么？
//     决策缝写入、claim phase 推进、run result/batch/index 生命周期更新。
//
//   · 约束？
//     WithinLock 助手禁止自行获取任务锁，必须在调用方锁持有期间运行。
// =============================================================================
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
 * 回滚未完成时的共享持久化：任务保持 verifying，保留 ownership/claim 与 rollback plan，
 * 返回 recovery_required 而非释放脏工作区。在调用方锁内运行，禁止自行加锁。
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
 * 子 agent 文件落盘后推进持久化 claim 阶段（applying → finalizing）。
 * 在调用方锁内运行，禁止自行加锁。
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

/** 更新 agent-run 的 result.json、batch JSON 与 index.json 中的 lifecycle 状态。 */
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
