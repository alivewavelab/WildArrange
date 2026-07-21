import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LEAD_AGENT,
  appendLedger,
  createWorkId,
  ensureHelixDirs,
  loadHelixConfig,
  normalizeAgentKey,
  nowIso,
  readJson,
  resolveHelixPath,
  withTaskStateLock,
  writeJsonAtomic,
  writeSnapshot,
} from "../infra/foundation.mjs";
import { buildFailureSummary } from "../infra/failure-analysis.mjs";
import { appendWisdom, writeFailureReport, writeReviewReport } from "../infra/task-reports.mjs";
import { writeMemoryDigest } from "../infra/memory-digest.mjs";
import { resolveAgentSpawn } from "../infra/agent-spawn.mjs";
import { applyAgentPatch, collectAgentWorktreePatch, extractPatchPaths, prepareAgentWorktree } from "../infra/git-worktree.mjs";
import { runCommand } from "../infra/command-runner.mjs";
import { pathAllowed } from "../infra/path-match.mjs";
import { runDeliveryPipeline } from "./delivery-pipeline.mjs";
import { loadTaskState } from "./plan-state.mjs";
import { findRunnableTask, persistTaskState, sendTeamMessage } from "./task-board.mjs";

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

  const runId = createWorkId("agent_run");
  const runDir = resolveHelixPath(rootDir, "agent-runs", runId);
  await mkdir(runDir, { recursive: true });
  const startedAt = nowIso();
  await appendLedger(rootDir, { type: "parallel_agents_started", runId, taskIds: tasks.map((task) => task.id) });
  await writeSnapshot(rootDir, "parallel_agents_started", { runId, taskIds: tasks.map((task) => task.id) });

  const results = await Promise.all(tasks.map((task, index) => runOneAgent(rootDir, runDir, runId, task, {
    ...options,
    config,
    index,
  })));
  await appendRunIndex(rootDir, runId, results);
  const skipped = results.length > 0 && results.every((result) => result.status === "skipped");
  const pass = results.every((result) => result.pass === true);
  const batch = {
    kind: "parallel_agent_batch",
    runId,
    at: nowIso(),
    startedAt,
    status: skipped ? "skipped" : pass ? "completed" : "failed",
    isolation: "run-dir",
    planId: taskState.planId,
    taskCount: results.length,
    results,
  };
  await writeJsonAtomic(resolveHelixPath(rootDir, "agent-runs", `${runId}.json`), batch);
  await appendLedger(rootDir, { type: "parallel_agents_completed", runId, status: batch.status, taskCount: results.length });
  await writeSnapshot(rootDir, "parallel_agents_completed", { runId, status: batch.status, taskCount: results.length });
  return batch;
}

export async function listParallelAgentRuns(rootDir) {
  await ensureHelixDirs(rootDir);
  const index = await readJson(resolveHelixPath(rootDir, "agent-runs", "index.json"), { runs: [] });
  return index;
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
    runs.push({
      runId: run.runId,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
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
  await appendLedger(rootDir, { type: "parallel_agent_run_closed", runId: options.runId, taskIds: closed, reason: options.reason || "user_closed" });
  return {
    kind: "parallel_agent_close",
    runId: options.runId,
    closed,
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
      const remove = await runCommand(`git -C ${shellEscape(rootDir)} worktree remove --force ${shellEscape(worktreeDir)}`, rootDir, 30_000);
      if (remove.exitCode !== 0 && !/is not a working tree|No such file/i.test(remove.stderr || remove.stdout || "")) {
        cleaned.push({ taskId: entry.taskId, status: "failed", path: result.workDir, error: remove.stderr || remove.stdout });
        continue;
      }
      await runCommand(`git -C ${shellEscape(rootDir)} worktree prune`, rootDir, 30_000);
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

  const prepared = await prepareAdmission(rootDir, options.taskId, result, files);
  const finalized = await finalizeAdmission(rootDir, options.taskId, {
    workerResult: prepared.workerResult,
    changedPaths: prepared.appliedPaths,
  });
  const { verifyResult, scopeResult, reviewResult } = finalized;
  let rollback = null;
  if (finalized.status !== "completed") {
    rollback = await rollbackAdmissionChanges(rootDir, prepared.rollbackPlan);
  }
  await updateAgentRunLifecycle(rootDir, options.runId, options.taskId, finalized.status === "completed" ? "released" : "awaiting_revision", {
    admissionStatus: finalized.status,
    releasedAt: finalized.status === "completed" ? nowIso() : null,
    rollback,
  });
  await appendLedger(rootDir, {
    type: "parallel_agent_admission_completed",
    runId: options.runId,
    taskId: options.taskId,
    status: finalized.status,
    appliedPaths: prepared.appliedPaths,
    rollback,
  });
  await writeSnapshot(rootDir, "parallel_agent_admission_completed", {
    runId: options.runId,
    taskId: options.taskId,
    status: finalized.status,
    appliedPaths: prepared.appliedPaths,
    rollback,
  });
  return {
    kind: "parallel_agent_admission",
    runId: options.runId,
    taskId: options.taskId,
    status: finalized.status,
    appliedPaths: prepared.appliedPaths,
    verifyResult,
    scopeResult,
    reviewResult,
    acceptanceProof: finalized.acceptanceProof || null,
    rollback,
    task: finalized.task,
  };
}

function selectParallelTasks(tasks, options) {
  if (Array.isArray(options.taskIds) && options.taskIds.length > 0) {
    const selected = options.taskIds.map((taskId) => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`unknown task: ${taskId}`);
      if (task.status !== "pending") throw new Error(`task ${taskId} is ${task.status}; only pending tasks can run in parallel`);
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

async function readParallelAgentResult(rootDir, runId, taskId) {
  const directPath = resolveHelixPath(rootDir, "agent-runs", runId, taskId, "result.json");
  const result = await readJson(directPath, null);
  if (!result) throw new Error(`parallel result not found: ${path.relative(rootDir, directPath)}`);
  return result;
}

async function prepareAdmission(rootDir, taskId, result, files) {
  const current = await getAdmissionTask(rootDir, taskId);
  const proposedPaths = files.length > 0 ? files.map((file) => file.path) : normalizePatchPaths(result.result?.patchPaths || result.result?.changedPaths || extractPatchPaths(result.result?.patch || ""));
  const denied = proposedPaths.filter((filePath) => !pathAllowed(filePath, current.task.writable_paths || []));
  if (denied.length > 0) {
    throw new Error(`parallel admission denied by writable_paths: ${denied.join(", ")}`);
  }

  let rollbackPlan = { mode: "none", paths: [] };
  if (files.length > 0) {
    rollbackPlan = await createFileRollbackPlan(rootDir, files);
    for (const file of files) {
      const absolutePath = path.join(rootDir, file.path);
      assertInsideRoot(rootDir, absolutePath, file.path);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, file.content, "utf8");
    }
  } else if (typeof result.result?.patch === "string") {
    rollbackPlan = { mode: "patch", patch: result.result.patch, paths: proposedPaths };
    await applyAgentPatch(rootDir, result.result.patch);
    const actualPaths = await collectActualAdmissionPaths(rootDir, proposedPaths);
    const actualDenied = actualPaths.filter((filePath) => !pathAllowed(filePath, current.task.writable_paths || []));
    if (actualDenied.length > 0) {
      const rollback = await rollbackAdmissionChanges(rootDir, rollbackPlan);
      throw new Error(`parallel admission denied by actual written paths: ${actualDenied.join(", ")}; rollback=${rollback.status}`);
    }
    rollbackPlan.paths = actualPaths;
    proposedPaths.splice(0, proposedPaths.length, ...actualPaths);
  } else {
    throw new Error("parallel result has no result.files or result.patch to admit");
  }

  const workerResult = {
    kind: "worker",
    at: nowIso(),
    command: `parallel_admit:${result.runId}:${taskId}`,
    exitCode: 0,
    stdout: files.length > 0
      ? `Admitted ${files.length} file(s) from ${result.agent}`
      : `Admitted patch with ${proposedPaths.length} path(s) from ${result.agent}`,
    stderr: "",
    source: "parallel_agent_admission",
    runId: result.runId,
    agent: result.agent,
    resultPath: result.runDir ? `${result.runDir}/result.json` : null,
  };
  const task = await updateAdmissionTask(rootDir, taskId, (candidate) => {
    if (!["pending", "in_progress", "verifying"].includes(candidate.status)) {
      throw new Error(`task ${candidate.id} status ${candidate.status} cannot admit parallel result`);
    }
    if (candidate.status === "pending") {
      candidate.attempts += 1;
    }
    candidate.status = "verifying";
    candidate.evidence.push(workerResult);
    candidate.evidence.push({
      kind: "parallel_agent_admission",
      at: nowIso(),
      runId: result.runId,
      agent: result.agent,
      appliedPaths: proposedPaths,
      admissionMode: files.length > 0 ? "files" : "patch",
      summary: result.result?.summary || "",
    });
    candidate.updatedAt = nowIso();
    return candidate;
  });
  await appendLedger(rootDir, {
    type: "parallel_agent_admission_started",
    runId: result.runId,
    taskId,
    agent: result.agent,
    appliedPaths: proposedPaths,
  });
  return { task, workerResult, appliedPaths: proposedPaths, rollbackPlan };
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

async function finalizeAdmission(rootDir, taskId, { workerResult, changedPaths }) {
  return withTaskStateLock(rootDir, `parallel-admit-finalize:${taskId}`, async () => {
    const taskState = await loadTaskState(rootDir);
    if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
    const task = taskState.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);

    // Same shared pipeline as the linear runtime: gate order lives in
    // delivery-pipeline.mjs only. This function keeps owning the evidence
    // shape, reports, and task status transitions.
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
      task.updatedAt = nowIso();
      await persistTaskState(rootDir, taskState);
      await appendWisdom(rootDir, task, verifyResult);
      await writeMemoryDigest(rootDir, { reason: "parallel_admission_completed", stage: "checkpoint", task, taskId });
      return { status: "completed", planId: taskState.planId, task, acceptanceProof, verifyResult, scopeResult, reviewResult };
    }

    task.status = shouldFailAdmission(task, verifyResult, scopeResult, reviewResult) ? "failed" : "pending";
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
    return { status: task.status === "failed" ? "failed" : "retry", planId: taskState.planId, task, acceptanceProof, verifyResult, scopeResult, reviewResult };
  });
}

async function updateAdmissionTask(rootDir, taskId, mutate) {
  return withTaskStateLock(rootDir, `parallel-admit:${taskId}`, async () => {
    const taskState = await loadTaskState(rootDir);
    if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
    const task = taskState.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    const updated = mutate(task);
    await persistTaskState(rootDir, taskState);
    return updated;
  });
}

async function getAdmissionTask(rootDir, taskId) {
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = taskState.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  return { planId: taskState.planId, task };
}

async function runOneAgent(rootDir, runDir, runId, task, options) {
  const agent = normalizeAgentKey(options.agent || task.owner || `Agent${options.index + 1}`) || `Agent${options.index + 1}`;
  const taskRunDir = path.join(runDir, task.id);
  await mkdir(taskRunDir, { recursive: true });
  const config = options.config || (await loadHelixConfig(rootDir)).config;
  const isolation = options.isolation || task.isolation || config.parallelAgents?.isolation || "run-dir";
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

async function updateAgentRunLifecycle(rootDir, runId, taskId, status, details = {}) {
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

function normalizeProposedFiles(files) {
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

function normalizeProposedFilesOrEmpty(files) {
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

function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit - 20)}\n...[truncated]`;
}

function shellEscape(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
