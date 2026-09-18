// =============================================================================
// 文件名称：parallel-run-lifecycle.mjs
// 所属模块：orchestration
// 作用说明：并行 run 的状态查询、关闭、清理与任务 claim 释放。
// 执行与 spawn 仍由 parallel-runtime.mjs 持有，避免重试路径形成循环依赖。
// =============================================================================
import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import {
  ensureWildArrangeDirs,
  nowIso,
  readJson,
  resolveWildArrangePath,
} from "../infra/runtime-store.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { loadTaskLedger } from "../infra/task-state-store.mjs";
import { loadTaskState } from "./plan-state.mjs";
import { persistTaskState } from "./task-board.mjs";
import { withTaskStateLock } from "../infra/task-state-lock.mjs";
import { updateAgentRunLifecycle } from "./admission-projection.mjs";
import { listParallelAgentRuns } from "./parallel-run-index.mjs";
import { inspectGitCoordination, commitIsAncestor } from "../infra/git-coordination.mjs";
import { readGitHead } from "../infra/git-diff.mjs";
import { runCommandFile } from "../infra/command-runner.mjs";
import { assertPathInsideRoot } from "../infra/path-match.mjs";

export async function parallelAgentStatus(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const index = await listParallelAgentRuns(rootDir);
  const selectedRuns = options.runId
    ? (index.runs || []).filter((run) => run.runId === options.runId)
    : (index.runs || []);
  const runs = [];
  for (const run of selectedRuns) {
    const results = [];
    for (const entry of run.results || []) {
      const resultPath = resolveWildArrangePath(rootDir, "agent-runs", run.runId, entry.taskId, "result.json");
      const result = await readJson(resultPath, null);
      results.push({
        taskId: entry.taskId,
        agent: entry.agent,
        pass: entry.pass,
        runDir: entry.runDir,
        lifecycle: result?.lifecycle || entry.lifecycle || null,
        adapter: result?.adapter || null,
        isolation: result?.isolation || null,
        workDir: result?.workDir || null,
        worktreeAvailable: result?.worktreeAvailable === true,
        command: result?.command || null,
        resultPath: path.relative(rootDir, resultPath),
      });
    }
    // 中断对账：batch 文件记录了本次跑了哪些任务；与结果集对比得出
    // "有头无尾"的任务清单（进程被杀、runner 崩溃未落盘），供人和
    // `parallel retry` 直接看到缺口。
    const batch = await readJson(resolveWildArrangePath(rootDir, "agent-runs", `${run.runId}.json`), null);
    const passedTaskIds = new Set((run.results || []).filter((entry) => entry.pass === true).map((entry) => entry.taskId));
    const incompleteTasks = (batch?.taskIds || []).filter((taskId) => !passedTaskIds.has(taskId));
    runs.push({
      runId: run.runId,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      batchStatus: batch?.status || null,
      command: batch?.command || null,
      incompleteTasks,
      summary: summarizeRunLifecycle(results),
      results,
    });
  }
  return {
    kind: "parallel_agent_status",
    runId: options.runId || null,
    runCount: runs.length,
    runs,
  };
}


export async function closeParallelAgentRun(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  if (!options.runId) throw new Error("parallel close requires --run <runId>");
  const index = await listParallelAgentRuns(rootDir);
  const run = (index.runs || []).find((candidate) => candidate.runId === options.runId);
  if (!run) throw new Error(`parallel run not found: ${options.runId}`);
  const closed = [];
  for (const entry of run.results || []) {
    if (options.taskId && entry.taskId !== options.taskId) continue;
    const status = options.status || "closed";
    await updateAgentRunLifecycle(rootDir, options.runId, entry.taskId, status, {
      closedAt: nowIso(),
      closeReason: options.reason || "user_closed",
    });
    closed.push(entry.taskId);
  }
  const taskState = await loadTaskState(rootDir);
  const orphanClaims = (taskState?.tasks || [])
    .filter((task) => task.parallel_run_claim?.runId === options.runId
      && (!options.taskId || task.id === options.taskId))
    .map((task) => task.id);
  const releasable = [...new Set([...closed, ...orphanClaims])];
  await clearParallelRunClaims(rootDir, options.runId, releasable);
  await appendLedger(rootDir, { type: "parallel_agent_run_closed", runId: options.runId, taskIds: releasable, reason: options.reason || "user_closed" });
  return {
    kind: "parallel_agent_close",
    runId: options.runId,
    closed: releasable,
  };
}


export async function cleanupParallelAgentRun(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  if (!options.runId) throw new Error("parallel cleanup requires --run <runId>");
  const status = await parallelAgentStatus(rootDir, { runId: options.runId });
  const taskLedger = await loadTaskLedger(rootDir);
  const { config } = await loadWildArrangeConfig(rootDir);
  const gitContext = await inspectGitCoordination(rootDir, config.gitCoordination || {}).catch(() => null);
  const cleaned = [];
  for (const run of status.runs || []) {
    const batch = await readJson(resolveWildArrangePath(rootDir, "agent-runs", `${run.runId}.json`), null);
    const runPlanId = batch?.planId || null;
    for (const entry of run.results || []) {
      const resultPath = resolveWildArrangePath(rootDir, "agent-runs", run.runId, entry.taskId, "result.json");
      const result = await readJson(resultPath, null);
      if (!result || result.isolation !== "git-worktree" || result.worktreeAvailable !== true) continue;
      const worktreeDir = path.resolve(rootDir, result.workDir || "");
      assertPathInsideRoot(rootDir, worktreeDir, result.workDir, "parallel worktree");
      const task = (taskLedger?.tasks || []).find((candidate) => candidate.planId === runPlanId && candidate.id === entry.taskId) || null;
      const cleanupFence = await inspectParallelCleanupFence(worktreeDir, entry, task, gitContext, runPlanId);
      if (!cleanupFence.pass) {
        cleaned.push({ taskId: entry.taskId, status: "retained", path: result.workDir, reason: cleanupFence.reason, details: cleanupFence.details || null });
        continue;
      }
      const remove = await runCommandFile("git", ["-C", rootDir, "worktree", "remove", worktreeDir], rootDir, 30_000);
      if (remove.exitCode !== 0 && !/is not a working tree|No such file/i.test(remove.stderr || remove.stdout || "")) {
        cleaned.push({ taskId: entry.taskId, status: "failed", path: result.workDir, error: remove.stderr || remove.stdout });
        continue;
      }
      await runCommandFile("git", ["-C", rootDir, "worktree", "prune"], rootDir, 30_000);
      await updateAgentRunLifecycle(rootDir, run.runId, entry.taskId, "cleaned", {
        cleanedAt: nowIso(),
        cleanedPath: result.workDir,
      });
      cleaned.push({ taskId: entry.taskId, status: "cleaned", path: result.workDir });
    }
  }
  await appendLedger(rootDir, { type: "parallel_agent_worktree_cleanup", runId: options.runId, cleanedCount: cleaned.filter((item) => item.status === "cleaned").length });
  return {
    kind: "parallel_agent_cleanup",
    runId: options.runId,
    cleaned,
  };
}


/** 检查 worktree 是否满足 cleanup 围栏（无残留改动）。 */
async function inspectParallelCleanupFence(worktreeDir, entry, task, gitContext, runPlanId) {
  const lifecycle = entry.lifecycle?.status || null;
  const cleanableLifecycle = new Set(["closed", "failed", "skipped", "released"]);
  if (!cleanableLifecycle.has(lifecycle)) {
    return { pass: false, reason: "lifecycle_requires_retention", details: { lifecycle } };
  }
  if (!runPlanId || !task) {
    return { pass: false, reason: "task_identity_unavailable", details: { planId: runPlanId, taskId: entry.taskId } };
  }
  if (["in_progress", "verifying", "recovery_required"].includes(task.status)
    || task.parallel_run_claim
    || (task.status !== "completed" && ["claimed", "accepted"].includes(task.coordination?.status))) {
    return {
      pass: false,
      reason: "task_ownership_requires_retention",
      details: { taskStatus: task.status, parallelRunClaim: task.parallel_run_claim || null, coordination: task.coordination || null },
    };
  }
  const worktreeStatus = await runCommandFile("git", ["-C", worktreeDir, "status", "--porcelain"], worktreeDir, 30_000);
  if (worktreeStatus.exitCode !== 0) {
    return { pass: false, reason: "worktree_cleanliness_unknown", details: { error: worktreeStatus.stderr || worktreeStatus.stdout } };
  }
  if (worktreeStatus.stdout.trim()) {
    return { pass: false, reason: "worktree_dirty", details: { changes: worktreeStatus.stdout.trim().split(/\r?\n/) } };
  }
  const mainRef = gitContext?.integrationBranch || "main";
  const worktreeHead = await readGitHead(worktreeDir);
  if (!worktreeHead.available) {
    return { pass: false, reason: "worktree_head_unknown", details: { error: worktreeHead.reason } };
  }
  if (!await commitIsAncestor(worktreeDir, worktreeHead.sha, mainRef).catch(() => false)) {
    return { pass: false, reason: "worktree_head_not_in_main", details: { worktreeHead: worktreeHead.sha, mainRef } };
  }
  if (lifecycle !== "released") return { pass: true };
  if (task.status !== "completed") {
    return { pass: false, reason: "released_task_not_completed", details: { taskStatus: task.status } };
  }
  const delivery = task?.delivery;
  if (delivery?.status === "no_change") return { pass: true };
  if (!delivery?.integrationSha) {
    return { pass: false, reason: "delivery_commit_not_recorded", details: { lifecycle, taskStatus: task?.status || null } };
  }
  const contained = await commitIsAncestor(worktreeDir, delivery.integrationSha, mainRef).catch(() => false);
  if (!contained) {
    return { pass: false, reason: "delivery_not_in_main", details: { deliveryCommit: delivery.integrationSha, mainRef } };
  }
  return { pass: true };
}


export async function clearParallelRunClaims(rootDir, runId, taskIds) {
  await withTaskStateLock(rootDir, `parallel-run-release:${runId}`, async () => {
    const taskState = await loadTaskState(rootDir);
    if (!taskState) return;
    let changed = false;
    for (const task of taskState.tasks) {
      if (taskIds.includes(task.id) && task.parallel_run_claim?.runId === runId) {
        task.parallel_run_claim = null;
        task.updatedAt = nowIso();
        changed = true;
      }
    }
    if (changed) await persistTaskState(rootDir, taskState);
  });
}


function summarizeRunLifecycle(results) {
  const counts = {};
  for (const result of results) {
    const status = result.lifecycle?.status || (result.pass ? "completed" : "failed");
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

