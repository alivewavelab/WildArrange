// =============================================================================
// 文件名称：admission-claim.mjs
// 所属模块：orchestration
// 作用说明：
//   并行 admission 的第一阶段：状态裁决、ownership 检查、claim 持久化与启动账本。
//   不触碰业务文件，不执行 verifier/review，也不负责 delivery/rollback。
//
// 【运行原理速读】
//   admission 输入 → 本模块确认谁能写、任务处于哪一阶段；
//   claim 与 ledger 落盘后，后续事务才允许 apply 工作区。
// =============================================================================
import { appendLedger, readVerifiedLedgerEntries } from "../infra/ledger.mjs";
import { nowIso } from "../infra/runtime-store.mjs";
import { assertContractWorkspaceAvailable } from "./integration.mjs";
import { loadTaskState } from "./plan-state.mjs";
import { readChangeRequest } from "./change-governance.mjs";
import { persistTaskState } from "./task-board.mjs";
import { assertCurrentTaskOwnership } from "./remote-ownership.mjs";
import { pathAllowed } from "../infra/path-match.mjs";

/**
 * Phase 1：在任务锁内完成 status 裁决、writable_paths 预检、claim 持久化与 started 账本。
 * @returns {Promise<object>} kind 为 claimed | reclaimed | resume | awaiting_user_decision
 */
export async function claimAdmission(rootDir, options, { result, files, proposedPaths }) {
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");
  const task = taskState.tasks.find((candidate) => candidate.id === options.taskId);
  if (!task) throw new Error(`unknown task: ${options.taskId}`);

  assertContractWorkspaceAvailable(taskState.tasks, options);

  if (task.status === "completed") {
    // A completed task is either an idempotent resume (THIS run completed
    // it through the gates, only the lifecycle release was interrupted) or
    // a hard refusal. "This run completed it" requires a chain-verified
    // completed ledger event for this exact run — the admission-started
    // evidence entry alone is not enough, because a run whose admission
    // failed and rolled back also left one behind (cross-review P1,
    // round 5, 2026-07-21).
    const completedByThisRun = await hasVerifiedRunCompletionEvent(rootDir, options.runId, taskState.planId, options.taskId);
    if (!completedByThisRun) {
      // §3.4：已完成任务仅允许 hash 链 verified 的本 run 幂等 resume，禁止跨 run 重复 apply。
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
  if (task.pendingContractChange && task.last_failure?.reason !== "admission_rollback_failed") {
    // §3.4：并发 admission 须 fail-closed；非本 run 不得改写等待契约决议的任务。
    if (task.admission_claim?.runId && task.admission_claim.runId !== options.runId) throw new Error("another admission owns this waiting task");
    return { kind: "awaiting_user_decision", task, changeRequest: await readChangeRequest(rootDir, task.pendingContractChange) };
  }
  if (task.admission_claim?.runId && task.status === "verifying") {
    if (task.admission_claim.runId !== options.runId) {
      // §3.4：持久 claim 是事务权威；非 owner run 拒绝进入，崩溃须原 run 续跑。
      throw new Error(`task ${options.taskId} is currently claimed by parallel admission run ${task.admission_claim.runId} (phase: ${task.admission_claim.phase}); refusing run ${options.runId}. 若那次 admission 已崩溃，用原 run 重新 admit 即可续跑`);
    }
    // A finalizing run may already have pushed its integration commit. Let
    // the same run reach the durable intent reconciliation path even when
    // task ownership changed; that path never rolls back a known push.
    // An applying run has not reached that safety point and must still own
    // the task before it may touch files again.
    if (task.admission_claim.phase !== "finalizing") {
      await assertCurrentTaskOwnership(rootDir, task);
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
  await assertCurrentTaskOwnership(rootDir, task);
  if (!["pending", "in_progress", "verifying"].includes(task.status)) {
    // §3.4：非法 status 不得进入 apply，避免在终态任务上留下半写 evidence。
    throw new Error(`task ${options.taskId} status ${task.status} cannot admit parallel result`);
  }
  if (task.parallel_run_claim?.runId && task.parallel_run_claim.runId !== options.runId) {
    // §3.4：parallel_run_claim 与 admission_claim 互斥，防止双 run 同时写工作区。
    throw new Error(`task ${options.taskId} is claimed by parallel admission run ${task.parallel_run_claim.runId}; refusing run ${options.runId}`);
  }
  const denied = proposedPaths.filter((filePath) => !pathAllowed(filePath, task.writable_paths || []));
  if (denied.length > 0) {
    // §3.4：apply 前路径越界须 fail-closed，不得 touch 工作区后再由 scope 补救。
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
  task.parallel_run_claim = null;
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

/**
 * 仅当 hash 链账本存在本 run+task 的 completed admission 事件时为 true。
 * resume 分支专用：失败回滚也会留下 evidence，不能单靠 evidence 证明完成。
 */
async function hasVerifiedRunCompletionEvent(rootDir, runId, planId, taskId) {
  const entries = await readVerifiedLedgerEntries(rootDir);
  return entries.some(
    (entry) => entry.type === "parallel_agent_admission_completed"
      && entry.runId === runId
      && entry.taskId === taskId
      && entry.planId === planId
      && entry.status === "completed",
  );
}
