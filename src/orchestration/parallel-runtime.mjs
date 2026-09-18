// =============================================================================
// 文件名称：parallel-runtime.mjs
// 所属模块：orchestration
// 作用说明：
//   并行 agent 运行：spawn worktree、收集结果、索引 run 生命周期；
//   admission 事务在 admission.mjs，此处 re-export 保持单一入口。
//
// 【运行原理速读】
//   可以把它想成「批量派出隔离子 agent 并登记成果」：
//
//   · 何时执行？
//     parallel run/list/status/retry/close/cleanup CLI。
//
//   · 做了什么？
//     选 runnable 任务 → worktree → spawn → 写 result → awaiting_user_acceptance。
//
//   · 约束？
//     只读长期身份 DiJiang/BaiZe/LuWu 禁止；admission 见 admission.mjs。
// =============================================================================
import { invokeCapability } from "../capabilities/gateway.mjs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LEAD_AGENT,
  assertCommandWorkerAgent,
  normalizeAgentKey,
} from "../infra/agent-registry.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import {
  createWorkId,
  ensureWildArrangeDirs,
  nowIso,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { withTaskStateLock } from "../infra/task-state-lock.mjs";
import { ensureTaskPacket, writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { resolveAgentSpawn } from "../infra/agent-spawn.mjs";
import { collectAgentWorktreePatch, prepareAgentWorktree } from "../infra/git-worktree.mjs";
import { inspectGitCoordination } from "../infra/git-coordination.mjs";
import { runCommand } from "../infra/command-runner.mjs";
import { normalizeProposedFilesOrEmpty } from "./admission.mjs";
import { loadPlanApproval, loadTaskState } from "./plan-state.mjs";
import {
  findRunnableTask,
  isTaskRunnable,
  persistTaskState,
  sendTeamMessage,
  unresolvedTaskBlockers,
} from "./task-board.mjs";
import { assertCurrentTaskOwnership, coordinateTaskClaim } from "./remote-ownership.mjs";
import {
  appendRunIndex,
  listParallelAgentRuns,
  registerRunIndexEntry,
} from "./parallel-run-index.mjs";
import { clearParallelRunClaims } from "./parallel-run-lifecycle.mjs";

export { listParallelAgentRuns };
export { parallelAgentStatus, closeParallelAgentRun, cleanupParallelAgentRun } from "./parallel-run-lifecycle.mjs";

/** admission 主事务 re-export，保持 parallel 模块单一入口。 */
export { admitParallelAgentResult } from "./admission.mjs";

/** 并行子 agent 默认超时（毫秒）；可被 CLI/config 覆盖。 */
const DEFAULT_PARALLEL_TIMEOUT_MS = 120_000;

// --- 运行与 spawn ---

/** 对可并行任务 spawn 子 agent，创建 run 目录与 index 条目。 */
export async function runParallelAgents(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");
  const approval = await loadPlanApproval(rootDir);
  if (approval.required && approval.status !== "approved" && approval.planId === taskState.planId) {
    return { status: "awaiting_plan_approval", runId: null, tasks: [], planId: taskState.planId };
  }
  const { config } = await loadWildArrangeConfig(rootDir);

  const tasks = selectParallelTasks(taskState.tasks, options);
  if (tasks.length === 0) {
    await appendLedger(rootDir, { type: "parallel_agents_idle", reason: "no runnable tasks" });
    return { status: "idle", runId: null, tasks: [] };
  }
  tasks.forEach((task, index) => {
    assertCommandWorkerAgent(options.agent || task.owner || `Agent${index + 1}`);
  });

  const executionContexts = {};
  for (const [index, task] of tasks.entries()) {
    const agent = options.agent || task.owner || `Agent${index + 1}`;
    // Resolve the same adapter as execution; preview paths are never executed.
    const previewDir = resolveWildArrangePath(rootDir, "agent-runs", "readiness", task.id);
    const spawn = resolveAgentSpawn(rootDir, config, task, {
      rootDir, runDir: previewDir, workDir: previewDir, task, agent,
      taskPacketPath: path.join(previewDir, "task.json"), resultPath: path.join(previewDir, "agent-result.json"),
    }, options);
    const envelope = await invokeCapability("execution-readiness", { rootDir, task: { ...task, owner: agent }, options: { workerCommand: spawn.command || "" } });
    if (envelope.status !== "pass") {
      if (envelope.evidence?.commandRecovery) {
        task.status = "needs_user_decision";
        task.last_readiness_result = envelope.evidence;
        await persistTaskState(rootDir, taskState);
      }
      return { status: envelope.evidence?.commandRecovery ? "recovery_required" : "readiness_blocked", runId: null, tasks: [], readiness: envelope.evidence, error: envelope.error };
    }
    executionContexts[task.id] = envelope.evidence?.contextPath;
  }
  const runId = createWorkId("agent_run");
  const runDir = resolveWildArrangePath(rootDir, "agent-runs", runId);
  await mkdir(runDir, { recursive: true });
  const startedAt = nowIso();
  await appendLedger(rootDir, { type: "parallel_agents_started", runId, taskIds: tasks.map((task) => task.id) });
  await registerRunIndexEntry(rootDir, runId);
  const batchPath = resolveWildArrangePath(rootDir, "agent-runs", `${runId}.json`);
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
    for (const task of tasks) await ensureTaskPacket(rootDir, taskState.planId, task);

    const results = await Promise.all(tasks.map((task, index) => runOneAgent(rootDir, runDir, runId, task, {
      ...options,
      config,
      defaultIsolation,
      executionContextPath: executionContexts[task.id],
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

/** 返回 parallel run 详细状态，供 status/dashboard 使用。 */
/**
 * partial 重试：对一个中断/部分失败的 run，只重跑"没有通过结果"的任务。
 * 已通过的任务绝不重跑；已完成/进行中的任务跳过并说明。重跑是一个新 run
 * （复用原批次的 command/agent/isolation），不改写原 run 的任何证据。
 */
// --- 重试与清理 ---

/** 对失败或中断的 parallel run 重试 spawn/collect。 */
export async function retryParallelAgentRun(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  if (!options.runId) throw new Error("parallel retry requires --run <runId>");
  const batch = await readJson(resolveWildArrangePath(rootDir, "agent-runs", `${options.runId}.json`), null);
  if (!batch) throw new Error(`parallel run not found: ${options.runId}`);
  const taskIds = Array.isArray(batch.taskIds) ? batch.taskIds : [];
  if (taskIds.length === 0) {
    throw new Error(`parallel run ${options.runId} has no recorded taskIds (batch predates retry support); retry manually with --task`);
  }

  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");
  const eligible = [];
  const skipped = [];
  for (const taskId of taskIds) {
    const result = await readJson(resolveWildArrangePath(rootDir, "agent-runs", options.runId, taskId, "result.json"), null);
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

/** 关闭 run：标记 lifecycle 为 closed，保留结果供审计。 */
/** 清理 run worktree 与临时文件（需 run 已 closed 且无 pending admission）。 */
/** 按 options 从 tasks 中筛选可并行执行的候选任务。 */
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
    const config = options.config || (await loadWildArrangeConfig(rootDir)).config;
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

/** spawn 单个子 agent 并收集 result.json 与生命周期。 */
async function runOneAgentInner(rootDir, runDir, runId, task, options) {
  const agent = normalizeAgentKey(options.agent || task.owner || `Agent${options.index + 1}`) || `Agent${options.index + 1}`;
  const taskRunDir = path.join(runDir, task.id);
  await mkdir(taskRunDir, { recursive: true });
  const config = options.config || (await loadWildArrangeConfig(rootDir)).config;
  const isolation = options.defaultIsolation || options.isolation || task.isolation || config.parallelAgents?.isolation || "run-dir";
  const worktree = await prepareAgentWorktree(rootDir, taskRunDir, {
    isolation,
    branchName: task.coordination?.branch || null,
    startPoint: task.coordination?.remoteHeadSha || "HEAD",
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
      ? await runCommand(command, worktree.workDir, normalizeTimeout(options.timeoutMs || config.parallelAgents?.timeoutMs), { env: options.executionContextPath ? { WILDARRANGE_EXECUTION_CONTEXT: options.executionContextPath } : {} })
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

/** 解析 parallel run 的 isolation 模式（worktree/run-dir）。 */
function resolveParallelIsolation(config, gitCoordination, options) {
  const requested = options.isolation || config.parallelAgents?.isolation || "run-dir";
  const coordination = config.gitCoordination || {};
  const enforceWorktree = ["guarded", "strict"].includes(coordination.mode)
    && coordination.requireWorktreeForParallelWrites !== false
    && (gitCoordination.active || gitCoordination.localGitAvailable === true);
  if (enforceWorktree && options.isolation && options.isolation !== "git-worktree") {
    // §3.4：可写 parallel 在 guarded/strict 模式下必须 worktree 隔离，禁止 run-dir 直写主 checkout。
    throw new Error("parallel writable agents require git-worktree isolation; weaken gitCoordination.requireWorktreeForParallelWrites in config to opt out");
  }
  return enforceWorktree ? "git-worktree" : requested;
}

/** 为选中任务写入 parallel_run_claim 并持久化。 */
async function claimParallelRunTasks(rootDir, planId, selectedTasks, options) {
  return withTaskStateLock(rootDir, `parallel-run-claim:${options.runId}`, async () => {
    const taskState = await loadTaskState(rootDir);
    if (!taskState || taskState.planId !== planId) {
      // §3.4：spawn 与 claim 分锁；plan 漂移时拒绝写入 parallel_run_claim。
      throw new Error(`active plan changed before parallel run ${options.runId}`);
    }
    for (const selected of selectedTasks) {
      const task = taskState.tasks.find((candidate) => candidate.id === selected.id);
      if (!task || task.status !== "pending") {
        // §3.4：仅 pending 可 claim；状态变化后 refuse run，防双写。
        throw new Error(`task ${selected.id} is no longer pending; refusing parallel run ${options.runId}`);
      }
      // §3.4：同一任务同时只能有一个 parallel_run_claim，防止双写 owner/worktree。
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

/** run 失败时释放仍持有的 parallel_run_claim。 */
async function releaseFailedParallelRunClaims(rootDir, runId, results) {
  const failedIds = results.filter((result) => result.pass !== true).map((result) => result.taskId);
  if (failedIds.length === 0) return;
  await clearParallelRunClaims(rootDir, runId, failedIds);
}

/** 清除指定 run 在任务上的 parallel_run_claim。 */
/** 从 results 汇总本 run 使用的 isolation 类型集合。 */
function uniqueIsolation(results) {
  const values = [...new Set(results.map((result) => result.isolation).filter(Boolean))];
  return values.length === 1 ? values[0] : values.length === 0 ? null : "mixed";
}

/** 组装 spawn 子 agent 用的任务上下文 packet。 */
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

/** 根据 pass/config 构造 agent lifecycle 初始状态。 */
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

/** 汇总 run 内各 task lifecycle 为 run 级摘要。 */
/** 构造 parallel 完成后的 team 消息正文。 */
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

/** 归一化 maxAgents CLI 参数为安全整数。 */
function normalizeMaxAgents(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return 2;
  return Math.min(parsed, 8);
}

/** 归一化 timeout CLI 参数为毫秒。 */
function normalizeTimeout(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_PARALLEL_TIMEOUT_MS;
  return parsed;
}

/** 截断字符串到指定长度并加省略号。 */
function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit - 20)}\n...[truncated]`;
}
