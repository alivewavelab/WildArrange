import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LEAD_AGENT,
  assertCommandWorkerAgent,
  normalizeAgentKey,
} from "../infra/agent-registry.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import {
  createWorkId,
  ensureHelixDirs,
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { loadHelixConfig } from "../infra/runtime-config.mjs";
import { withTaskStateLock } from "../infra/task-state-lock.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { resolveAgentSpawn } from "../infra/agent-spawn.mjs";
import { collectAgentWorktreePatch, prepareAgentWorktree } from "../infra/git-worktree.mjs";
import { inspectGitCoordination } from "../infra/git-coordination.mjs";
import { runCommand, runCommandFile } from "../infra/command-runner.mjs";
import { normalizeProposedFilesOrEmpty, updateAgentRunLifecycle } from "./admission.mjs";
import { loadTaskState } from "./plan-state.mjs";
import {
  findRunnableTask,
  isTaskRunnable,
  persistTaskState,
  sendTeamMessage,
  unresolvedTaskBlockers,
} from "./task-board.mjs";
import { assertCurrentTaskOwnership, coordinateTaskClaim } from "./remote-ownership.mjs";

// The admission transaction (claim -> apply -> gates -> commit/rollback)
// lives in ./admission.mjs; re-exported here so existing callers of the
// parallel runtime keep one entry point (five-zone round 7 split).
export { admitParallelAgentResult } from "./admission.mjs";

const DEFAULT_PARALLEL_TIMEOUT_MS = 120_000;

export async function runParallelAgents(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const { config } = await loadHelixConfig(rootDir);

  const tasks = selectParallelTasks(taskState.tasks, options);
  if (tasks.length === 0) {
    await appendLedger(rootDir, { type: "parallel_agents_idle", reason: "no runnable tasks" });
    return { status: "idle", runId: null, tasks: [] };
  }
  tasks.forEach((task, index) => {
    assertCommandWorkerAgent(options.agent || task.owner || `Agent${index + 1}`);
  });

  const runId = createWorkId("agent_run");
  const runDir = resolveHelixPath(rootDir, "agent-runs", runId);
  await mkdir(runDir, { recursive: true });
  const startedAt = nowIso();
  await appendLedger(rootDir, { type: "parallel_agents_started", runId, taskIds: tasks.map((task) => task.id) });
  await registerRunIndexEntry(rootDir, runId);
  const batchPath = resolveHelixPath(rootDir, "agent-runs", `${runId}.json`);
  // taskIds/command/agent/isolation 必须随批次持久化：中断对账与
  // `parallel retry` 依赖它们重建"这次跑了哪些任务、用什么命令"。
  const batchSeed = {
    taskIds: tasks.map((task) => task.id),
    command: options.command || null,
    agent: options.agent || null,
  };
  await writeJsonAtomic(batchPath, {
    kind: "parallel_agent_batch",
    runId,
    at: startedAt,
    startedAt,
    status: "claiming",
    planId: taskState.planId,
    taskCount: tasks.length,
    ...batchSeed,
    results: [],
  });
  const gitCoordination = await inspectGitCoordination(rootDir, config.gitCoordination);
  const defaultIsolation = resolveParallelIsolation(config, gitCoordination, options);
  try {
    await claimParallelRunTasks(rootDir, taskState.planId, tasks, {
      runId,
      agent: options.agent,
      forceCoordination: config.gitCoordination.mode === "manual" && options.coordinate === true,
    });
  } catch (error) {
    await clearParallelRunClaims(rootDir, runId, tasks.map((task) => task.id));
    await writeJsonAtomic(batchPath, {
      kind: "parallel_agent_batch",
      runId,
      at: nowIso(),
      startedAt,
      status: "claim_failed",
      planId: taskState.planId,
      taskCount: tasks.length,
      ...batchSeed,
      results: [],
      error: error instanceof Error ? error.message : String(error),
    });
    await appendLedger(rootDir, {
      type: "parallel_agents_claim_failed",
      runId,
      taskIds: tasks.map((task) => task.id),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  try {
    await writeJsonAtomic(batchPath, {
      kind: "parallel_agent_batch",
      runId,
      at: startedAt,
      startedAt,
      status: "running",
      planId: taskState.planId,
      taskCount: tasks.length,
      ...batchSeed,
      results: [],
    });
    await writeSnapshot(rootDir, "parallel_agents_started", { runId, taskIds: tasks.map((task) => task.id) });

    const results = await Promise.all(tasks.map((task, index) => runOneAgent(rootDir, runDir, runId, task, {
      ...options,
      config,
      defaultIsolation,
      index,
    })));
    await releaseFailedParallelRunClaims(rootDir, runId, results);
    await appendRunIndex(rootDir, runId, results);
    const skipped = results.length > 0 && results.every((result) => result.status === "skipped");
    const pass = results.every((result) => result.pass === true);
    const batch = {
      kind: "parallel_agent_batch",
      runId,
      at: nowIso(),
      startedAt,
      status: skipped ? "skipped" : pass ? "completed" : "failed",
      isolation: uniqueIsolation(results),
      planId: taskState.planId,
      taskCount: results.length,
      ...batchSeed,
      results,
    };
    await writeJsonAtomic(batchPath, batch);
    await appendLedger(rootDir, { type: "parallel_agents_completed", runId, status: batch.status, taskCount: results.length });
    await writeSnapshot(rootDir, "parallel_agents_completed", { runId, status: batch.status, taskCount: results.length });
    return batch;
  } catch (error) {
    await clearParallelRunClaims(rootDir, runId, tasks.map((task) => task.id)).catch(() => {});
    await writeJsonAtomic(batchPath, {
      kind: "parallel_agent_batch",
      runId,
      at: nowIso(),
      startedAt,
      status: "interrupted",
      planId: taskState.planId,
      taskCount: tasks.length,
      ...batchSeed,
      results: [],
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    await appendLedger(rootDir, {
      type: "parallel_agents_interrupted",
      runId,
      taskIds: tasks.map((task) => task.id),
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw error;
  }
}

export async function listParallelAgentRuns(rootDir) {
  await ensureHelixDirs(rootDir);
  const index = await readJson(resolveHelixPath(rootDir, "agent-runs", "index.json"), { runs: [] });
  return reconcileRunIndex(rootDir, index);
}

/**
 * Self-healing for the run index: a run whose per-task result.json files
 * exist on disk but which never made it into index.json (index write failed
 * or the process died mid-run) used to be permanently invisible to
 * `parallel status` (cross-review P1, round 5, 2026-07-21). Every index read
 * scans the agent-runs directory and adopts orphan run dirs back into the
 * index, rebuilding their entries from the result.json files.
 */
async function reconcileRunIndex(rootDir, index) {
  const runsDir = resolveHelixPath(rootDir, "agent-runs");
  let dirEntries = [];
  try {
    dirEntries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return index;
  }
  const known = new Set((index.runs || []).map((run) => run.runId));
  const adopted = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory() || known.has(entry.name)) continue;
    const runDir = path.join(runsDir, entry.name);
    const results = [];
    for (const taskEntry of await readdir(runDir, { withFileTypes: true }).catch(() => [])) {
      if (!taskEntry.isDirectory()) continue;
      const result = await readJson(path.join(runDir, taskEntry.name, "result.json"), null);
      if (!result) continue;
      results.push({
        taskId: result.taskId || taskEntry.name,
        agent: result.agent || null,
        pass: result.pass ?? null,
        runDir: result.runDir || path.relative(rootDir, path.join(runDir, taskEntry.name)),
        lifecycle: result.lifecycle || null,
      });
    }
    if (results.length === 0) continue;
    index.runs = index.runs || [];
    index.runs.push({
      runId: entry.name,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      recovered: true,
      results,
    });
    adopted.push(entry.name);
  }
  if (adopted.length > 0) {
    await writeJsonAtomic(resolveHelixPath(rootDir, "agent-runs", "index.json"), index);
    await appendLedger(rootDir, { type: "parallel_run_index_reconciled", adoptedRunIds: adopted }).catch(() => {});
  }
  return index;
}

async function registerRunIndexEntry(rootDir, runId) {
  const indexPath = resolveHelixPath(rootDir, "agent-runs", "index.json");
  const index = await readJson(indexPath, { runs: [] });
  if (!index.runs.some((run) => run.runId === runId)) {
    index.runs.push({ runId, createdAt: nowIso(), updatedAt: nowIso(), results: [] });
    await writeJsonAtomic(indexPath, index);
  }
}

export async function parallelAgentStatus(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const index = await listParallelAgentRuns(rootDir);
  const selectedRuns = options.runId
    ? (index.runs || []).filter((run) => run.runId === options.runId)
    : (index.runs || []);
  const runs = [];
  for (const run of selectedRuns) {
    const results = [];
    for (const entry of run.results || []) {
      const resultPath = resolveHelixPath(rootDir, "agent-runs", run.runId, entry.taskId, "result.json");
      const result = await readJson(resultPath, null);
      results.push({
        taskId: entry.taskId,
        agent: entry.agent,
        pass: entry.pass,
        runDir: entry.runDir,
        lifecycle: result?.lifecycle || entry.lifecycle || null,
        adapter: result?.adapter || null,
        isolation: result?.isolation || null,
        command: result?.command || null,
        resultPath: path.relative(rootDir, resultPath),
      });
    }
    // 中断对账：batch 文件记录了本次跑了哪些任务；与结果集对比得出
    // "有头无尾"的任务清单（进程被杀、runner 崩溃未落盘），供人和
    // `parallel retry` 直接看到缺口。
    const batch = await readJson(resolveHelixPath(rootDir, "agent-runs", `${run.runId}.json`), null);
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

/**
 * partial 重试：对一个中断/部分失败的 run，只重跑"没有通过结果"的任务。
 * 已通过的任务绝不重跑；已完成/进行中的任务跳过并说明。重跑是一个新 run
 * （复用原批次的 command/agent/isolation），不改写原 run 的任何证据。
 */
export async function retryParallelAgentRun(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  if (!options.runId) throw new Error("parallel retry requires --run <runId>");
  const batch = await readJson(resolveHelixPath(rootDir, "agent-runs", `${options.runId}.json`), null);
  if (!batch) throw new Error(`parallel run not found: ${options.runId}`);
  const taskIds = Array.isArray(batch.taskIds) ? batch.taskIds : [];
  if (taskIds.length === 0) {
    throw new Error(`parallel run ${options.runId} has no recorded taskIds (batch predates retry support); retry manually with --task`);
  }

  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const eligible = [];
  const skipped = [];
  for (const taskId of taskIds) {
    const result = await readJson(resolveHelixPath(rootDir, "agent-runs", options.runId, taskId, "result.json"), null);
    if (result?.pass === true) {
      skipped.push({ taskId, reason: "already passed in this run" });
      continue;
    }
    const task = (taskState.tasks || []).find((candidate) => candidate.id === taskId);
    if (!task) {
      skipped.push({ taskId, reason: "task no longer exists in the active plan" });
      continue;
    }
    if (task.status !== "pending") {
      skipped.push({ taskId, reason: `task is ${task.status}, not pending` });
      continue;
    }
    // 任务可能已在别的 run 里通过并 awaiting_user_acceptance（本 run 的
    // 旧失败结果不代表当前状态）；活 claim 的任务绝不重跑。
    if (task.parallel_run_claim?.runId) {
      skipped.push({ taskId, reason: `claimed by run ${task.parallel_run_claim.runId} (awaiting acceptance)` });
      continue;
    }
    eligible.push(taskId);
  }

  if (eligible.length === 0) {
    return {
      kind: "parallel_agent_retry",
      retryOf: options.runId,
      status: "nothing_to_retry",
      retried: [],
      skipped,
    };
  }
  const batch2 = await runParallelAgents(rootDir, {
    command: options.command || batch.command || undefined,
    agent: options.agent || batch.agent || undefined,
    isolation: options.isolation || batch.isolation || undefined,
    taskIds: eligible,
    maxAgents: options.maxAgents,
    timeoutMs: options.timeoutMs,
  });
  await appendLedger(rootDir, {
    type: "parallel_agent_run_retried",
    retryOf: options.runId,
    newRunId: batch2.runId,
    taskIds: eligible,
  });
  return {
    kind: "parallel_agent_retry",
    retryOf: options.runId,
    status: "requeued",
    newRunId: batch2.runId,
    retried: eligible,
    skipped,
  };
}

export async function closeParallelAgentRun(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
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
  await ensureHelixDirs(rootDir);
  if (!options.runId) throw new Error("parallel cleanup requires --run <runId>");
  const status = await parallelAgentStatus(rootDir, { runId: options.runId });
  const cleaned = [];
  for (const run of status.runs || []) {
    for (const entry of run.results || []) {
      const resultPath = resolveHelixPath(rootDir, "agent-runs", run.runId, entry.taskId, "result.json");
      const result = await readJson(resultPath, null);
      if (!result || result.isolation !== "git-worktree" || result.worktreeAvailable !== true) continue;
      const worktreeDir = path.join(rootDir, result.workDir || "");
      const remove = await runCommandFile("git", ["-C", rootDir, "worktree", "remove", "--force", worktreeDir], rootDir, 30_000);
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

function selectParallelTasks(tasks, options) {
  if (Array.isArray(options.taskIds) && options.taskIds.length > 0) {
    const selected = options.taskIds.map((taskId) => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`unknown task: ${taskId}`);
      if (task.status !== "pending") throw new Error(`task ${taskId} is ${task.status}; only pending tasks can run in parallel`);
      if (!isTaskRunnable(task, tasks)) {
        throw new Error(`task ${taskId} blocked by ${unresolvedTaskBlockers(task, tasks).join(",")}`);
      }
      return task;
    });
    return selected.slice(0, normalizeMaxAgents(options.maxAgents));
  }

  const selected = [];
  const remaining = [...tasks];
  const maxAgents = normalizeMaxAgents(options.maxAgents);
  while (selected.length < maxAgents) {
    const next = findRunnableTask(remaining);
    if (!next) break;
    selected.push(next);
    next.status = "selected";
  }
  for (const task of selected) task.status = "pending";
  return selected;
}

/**
 * 逐任务容错：一个任务的 runner 崩溃（worktree 失败、磁盘写失败等未预期
 * 异常）只产生该任务的 fail 结果，绝不拒绝整个批次的 Promise.all——其他
 * 任务的结果与磁盘证据必须照常入账（中断对账依赖这一点）。
 */
async function runOneAgent(rootDir, runDir, runId, task, options) {
  try {
    return await runOneAgentInner(rootDir, runDir, runId, task, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const agent = normalizeAgentKey(options.agent || task.owner || `Agent${options.index + 1}`) || `Agent${options.index + 1}`;
    const config = options.config || (await loadHelixConfig(rootDir)).config;
    const result = {
      kind: "parallel_agent_result",
      runId,
      taskId: task.id,
      agent,
      at: nowIso(),
      startedAt: nowIso(),
      command: null,
      adapter: null,
      spawnSource: null,
      isolation: options.defaultIsolation || options.isolation || "run-dir",
      workDir: null,
      worktreeAvailable: false,
      worktreeReason: null,
      exitCode: null,
      status: "fail",
      pass: false,
      stdout: "",
      stderr: `runner crashed before producing a result: ${message}`,
      error: message,
      result: {},
      lifecycle: buildAgentLifecycle(false, config, null),
      patch: null,
      runDir: path.relative(rootDir, path.join(runDir, task.id)),
    };
    await writeJsonAtomic(path.join(runDir, task.id, "result.json"), result).catch(() => {});
    await appendLedger(rootDir, { type: "parallel_agent_result", runId, taskId: task.id, agent, pass: false, runnerError: message }).catch(() => {});
    return result;
  }
}

async function runOneAgentInner(rootDir, runDir, runId, task, options) {
  const agent = normalizeAgentKey(options.agent || task.owner || `Agent${options.index + 1}`) || `Agent${options.index + 1}`;
  const taskRunDir = path.join(runDir, task.id);
  await mkdir(taskRunDir, { recursive: true });
  const config = options.config || (await loadHelixConfig(rootDir)).config;
  const isolation = options.defaultIsolation || options.isolation || task.isolation || config.parallelAgents?.isolation || "run-dir";
  const worktree = await prepareAgentWorktree(rootDir, taskRunDir, {
    isolation,
    timeoutMs: normalizeTimeout(options.timeoutMs || config.parallelAgents?.timeoutMs),
  });
  const taskPacketPath = path.join(taskRunDir, "task.json");
  const resultPath = path.join(taskRunDir, "agent-result.json");
  await writeJsonAtomic(taskPacketPath, buildTaskPacket(task, { runId, agent, worktree }));

  const spawn = resolveAgentSpawn(rootDir, config, task, {
    rootDir,
    runDir: taskRunDir,
    workDir: worktree.workDir,
    task,
    agent,
    taskPacketPath,
    resultPath,
  }, options);
  const command = spawn.command;
  const commandConfigured = Boolean(command);
  const startedAt = nowIso();
  const commandResult = worktree.isolation === "git-worktree" && worktree.available !== true
    ? { exitCode: 1, stdout: "", stderr: worktree.reason || "git-worktree isolation unavailable" }
    : command
      ? await runCommand(command, worktree.workDir, normalizeTimeout(options.timeoutMs || config.parallelAgents?.timeoutMs))
      : { exitCode: 78, stdout: "", stderr: "no runner command configured; task packet prepared only" };
  const structuredResult = await readJson(resultPath, null) || {};
  const patchResult = await collectAgentWorktreePatch(rootDir, worktree, {
    timeoutMs: normalizeTimeout(options.timeoutMs || config.parallelAgents?.timeoutMs),
  });
  if (patchResult?.patch && !structuredResult.patch && normalizeProposedFilesOrEmpty(structuredResult.files).length === 0) {
    structuredResult.patch = patchResult.patch;
    structuredResult.patchPaths = patchResult.changedPaths;
    structuredResult.patchPath = patchResult.patchPath;
    structuredResult.summary = structuredResult.summary || `patch with ${patchResult.changedPaths.length} changed path(s)`;
    await writeJsonAtomic(resultPath, structuredResult);
  }
  const result = {
    kind: "parallel_agent_result",
    runId,
    taskId: task.id,
    agent,
    at: nowIso(),
    startedAt,
    command: command || null,
    adapter: spawn.adapter,
    spawnSource: spawn.source,
    isolation: worktree.isolation,
    workDir: path.relative(rootDir, worktree.workDir),
    worktreeAvailable: worktree.available,
    worktreeReason: worktree.reason,
    exitCode: commandResult.exitCode,
    status: commandConfigured ? (commandResult.exitCode === 0 ? "pass" : "fail") : "skipped",
    pass: commandConfigured && commandResult.exitCode === 0,
    stdout: truncate(commandResult.stdout || "", 4000),
    stderr: truncate(commandResult.stderr || "", 4000),
    result: structuredResult,
    lifecycle: buildAgentLifecycle(commandConfigured && commandResult.exitCode === 0, config, commandConfigured ? null : "skipped"),
    patch: patchResult ? {
      patchPath: patchResult.patchPath,
      changedPaths: patchResult.changedPaths,
      status: patchResult.status,
      exitCode: patchResult.exitCode,
    } : null,
    runDir: path.relative(rootDir, taskRunDir),
  };
  await writeJsonAtomic(path.join(taskRunDir, "result.json"), result);
  await sendTeamMessage(rootDir, {
    from: agent,
    to: DEFAULT_LEAD_AGENT,
    summary: `${task.id} parallel result: ${result.status || (result.pass ? "pass" : "fail")}`,
    body: buildMessageBody(task, result),
  });
  await appendLedger(rootDir, { type: "parallel_agent_result", runId, taskId: task.id, agent, pass: result.pass });
  return result;
}

function resolveParallelIsolation(config, gitCoordination, options) {
  const requested = options.isolation || config.parallelAgents?.isolation || "run-dir";
  const coordination = config.gitCoordination || {};
  const enforceWorktree = ["guarded", "strict"].includes(coordination.mode)
    && coordination.requireWorktreeForParallelWrites !== false
    && gitCoordination.active;
  if (enforceWorktree && options.isolation && options.isolation !== "git-worktree") {
    throw new Error("parallel writable agents require git-worktree isolation; weaken gitCoordination.requireWorktreeForParallelWrites in config to opt out");
  }
  return enforceWorktree ? "git-worktree" : requested;
}

async function claimParallelRunTasks(rootDir, planId, selectedTasks, options) {
  return withTaskStateLock(rootDir, `parallel-run-claim:${options.runId}`, async () => {
    const taskState = await loadTaskState(rootDir);
    if (!taskState || taskState.planId !== planId) throw new Error(`active plan changed before parallel run ${options.runId}`);
    for (const selected of selectedTasks) {
      const task = taskState.tasks.find((candidate) => candidate.id === selected.id);
      if (!task || task.status !== "pending") {
        throw new Error(`task ${selected.id} is no longer pending; refusing parallel run ${options.runId}`);
      }
      if (task.parallel_run_claim?.runId) {
        throw new Error(`task ${task.id} already has writable parallel run ${task.parallel_run_claim.runId}`);
      }
      const owner = normalizeAgentKey(options.agent || task.owner || "ZhuRong") || "ZhuRong";
      if (task.coordination && ["claimed", "accepted"].includes(task.coordination.status)) {
        await assertCurrentTaskOwnership(rootDir, task);
      } else {
        task.coordination = await coordinateTaskClaim(rootDir, {
          planId,
          task,
          owner,
          force: options.forceCoordination,
        });
      }
      task.parallel_run_claim = { runId: options.runId, owner, claimedAt: nowIso() };
      task.owner = owner;
      task.updatedAt = nowIso();
      Object.assign(selected, task);
      await persistTaskState(rootDir, taskState);
    }
  });
}

async function releaseFailedParallelRunClaims(rootDir, runId, results) {
  const failedIds = results.filter((result) => result.pass !== true).map((result) => result.taskId);
  if (failedIds.length === 0) return;
  await clearParallelRunClaims(rootDir, runId, failedIds);
}

async function clearParallelRunClaims(rootDir, runId, taskIds) {
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

function uniqueIsolation(results) {
  const values = [...new Set(results.map((result) => result.isolation).filter(Boolean))];
  return values.length === 1 ? values[0] : values.length === 0 ? null : "mixed";
}

function buildTaskPacket(task, context) {
  return {
    kind: "parallel_agent_task_packet",
    at: nowIso(),
    runId: context.runId,
    agent: context.agent,
    worktree: context.worktree ? {
      isolation: context.worktree.isolation,
      workDir: context.worktree.workDir,
      available: context.worktree.available,
      reason: context.worktree.reason,
    } : null,
    task: {
      id: task.id,
      subject: task.subject,
      description: task.description,
      category: task.category,
      writable_paths: task.writable_paths,
      verify_commands: task.verify_commands,
      successCriteria: task.successCriteria,
      skills: task.skills,
      route_decision: task.route_decision,
    },
    instruction: [
      "Work only inside this run directory unless a host adapter explicitly grants a separate workspace.",
      "If worktree.available is true, edit inside worktree.workDir and let WildArrange collect the patch.",
      "Write optional structured output to agent-result.json.",
      "To propose mainline changes, write agent-result.json with files: [{\"path\":\"relative/path\",\"content\":\"utf8 text\"}].",
      "For Git worktree mode, changed files may be admitted as a generated patch after mainline gates pass.",
      "Do not claim the main task is complete; mainline verifier/review gates decide completion.",
    ],
  };
}

async function appendRunIndex(rootDir, runId, results) {
  const indexPath = resolveHelixPath(rootDir, "agent-runs", "index.json");
  const index = await readJson(indexPath, { runs: [] });
  const existing = index.runs.find((run) => run.runId === runId);
  const entries = results.map((result) => ({
    taskId: result.taskId,
    agent: result.agent,
    pass: result.pass,
    runDir: result.runDir,
    lifecycle: result.lifecycle || null,
  }));
  if (existing) {
    existing.updatedAt = nowIso();
    existing.results.push(...entries);
  } else {
    index.runs.push({
      runId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      results: entries,
    });
  }
  await writeJsonAtomic(indexPath, index);
}

function buildAgentLifecycle(pass, config, statusOverride = null) {
  if (statusOverride === "skipped") {
    return {
      status: "skipped",
      retainUntil: null,
      updatedAt: nowIso(),
    };
  }
  if (!pass) {
    return {
      status: "failed",
      retainUntil: null,
      updatedAt: nowIso(),
    };
  }
  if (config.parallelAgents?.retainUntilUserAcceptance === false) {
    return {
      status: "closed",
      retainUntil: null,
      updatedAt: nowIso(),
    };
  }
  return {
    status: "awaiting_user_acceptance",
    retainUntil: "parallel_admission_completed",
    updatedAt: nowIso(),
  };
}

function summarizeRunLifecycle(results) {
  const counts = {};
  for (const result of results) {
    const status = result.lifecycle?.status || (result.pass ? "completed" : "failed");
    counts[status] = (counts[status] || 0) + 1;
  }
  return counts;
}

function buildMessageBody(task, result) {
  const lines = [
    `Task: ${task.id} ${task.subject}`,
    `Agent: ${result.agent}`,
    `Status: ${result.status || (result.pass ? "pass" : "fail")}`,
    `Run dir: ${result.runDir}`,
  ];
  if (result.result?.summary) lines.push(`Summary: ${result.result.summary}`);
  if (result.stderr) lines.push(`Stderr: ${result.stderr.slice(0, 800)}`);
  if (result.stdout) lines.push(`Stdout: ${result.stdout.slice(0, 800)}`);
  return lines.join("\n");
}

function normalizeMaxAgents(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return 2;
  return Math.min(parsed, 8);
}

function normalizeTimeout(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_PARALLEL_TIMEOUT_MS;
  return parsed;
}

function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit - 20)}\n...[truncated]`;
}
