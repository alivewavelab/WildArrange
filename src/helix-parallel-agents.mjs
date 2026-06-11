import { mkdir, writeFile } from "node:fs/promises";
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
} from "./helix-foundation.mjs";
import { writeAcceptanceProof } from "./helix-acceptance-proof.mjs";
import { buildFailureSummary } from "./helix-failure.mjs";
import { writeMemoryDigest } from "./helix-memory-digest.mjs";
import { resolveAgentSpawn } from "./helix-agent-spawn.mjs";
import { applyAgentPatch, collectAgentWorktreePatch, extractPatchPaths, prepareAgentWorktree } from "./helix-git-worktree.mjs";
import {
  appendWisdom,
  pathAllowed,
  runCommand,
  runVerifier,
  scopeGuard,
  writeCheckpoint,
  writeFailureReport,
  writeReviewReport,
} from "./helix-gates.mjs";
import { loadTaskState } from "./helix-plan.mjs";
import { runReviewGate } from "./helix-review.mjs";
import {
  applyVerifierEvidenceToCriteria,
  criteriaStatus,
  findRunnableTask,
  persistTaskState,
  sendTeamMessage,
} from "./helix-team.mjs";

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
  const pass = results.every((result) => result.exitCode === 0);
  const batch = {
    kind: "parallel_agent_batch",
    runId,
    at: nowIso(),
    startedAt,
    status: pass ? "completed" : "failed",
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
  const verifyResult = await runVerifier(rootDir, prepared.task);
  await updateAdmissionTask(rootDir, options.taskId, (task) => {
    task.evidence.push(verifyResult);
    task.last_verify_result = verifyResult;
    applyVerifierEvidenceToCriteria(task, verifyResult);
    task.updatedAt = nowIso();
    return task;
  });

  const scopeResult = await scopeGuard(rootDir, {
    taskId: options.taskId,
    changedPaths: prepared.appliedPaths,
  });
  await updateAdmissionTask(rootDir, options.taskId, (task) => {
    task.evidence.push({ kind: "scope_guard", at: nowIso(), ...scopeResult });
    task.last_scope_result = scopeResult;
    task.updatedAt = nowIso();
    return task;
  });

  const reviewTask = await getAdmissionTask(rootDir, options.taskId);
  const reviewResult = await runReviewGate(rootDir, reviewTask.task, {
    workerResult: prepared.workerResult,
    verifyResult,
    scopeResult,
  });
  await writeReviewReport(rootDir, reviewTask.planId, reviewTask.task, reviewResult);
  const finalized = await finalizeAdmission(rootDir, options.taskId, {
    workerResult: prepared.workerResult,
    verifyResult,
    scopeResult,
    reviewResult,
  });
  await updateAgentRunLifecycle(rootDir, options.runId, options.taskId, finalized.status === "completed" ? "released" : "awaiting_revision", {
    admissionStatus: finalized.status,
    releasedAt: finalized.status === "completed" ? nowIso() : null,
  });
  await appendLedger(rootDir, {
    type: "parallel_agent_admission_completed",
    runId: options.runId,
    taskId: options.taskId,
    status: finalized.status,
    appliedPaths: prepared.appliedPaths,
  });
  await writeSnapshot(rootDir, "parallel_agent_admission_completed", {
    runId: options.runId,
    taskId: options.taskId,
    status: finalized.status,
    appliedPaths: prepared.appliedPaths,
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

  if (files.length > 0) {
    for (const file of files) {
      const absolutePath = path.join(rootDir, file.path);
      assertInsideRoot(rootDir, absolutePath, file.path);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, file.content, "utf8");
    }
  } else if (typeof result.result?.patch === "string") {
    await applyAgentPatch(rootDir, result.result.patch);
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
  return { task, workerResult, appliedPaths: proposedPaths };
}

async function finalizeAdmission(rootDir, taskId, evidence) {
  return withTaskStateLock(rootDir, `parallel-admit-finalize:${taskId}`, async () => {
    const taskState = await loadTaskState(rootDir);
    if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
    const task = taskState.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    task.evidence.push(evidence.reviewResult);
    task.last_review_result = evidence.reviewResult;
    const criteria = criteriaStatus(task);
    if (
      evidence.workerResult.exitCode === 0
      && evidence.verifyResult.pass
      && criteria.pass
      && evidence.scopeResult.status === "pass"
      && evidence.reviewResult.pass
    ) {
      const acceptanceProof = await writeAcceptanceProof(rootDir, taskState.planId, task, evidence);
      if (!acceptanceProof.pass) {
        task.status = shouldFailAdmission(task, evidence.verifyResult, evidence.scopeResult, evidence.reviewResult) ? "failed" : "pending";
        task.last_failure = buildFailureSummary(task, {
          workerResult: evidence.workerResult,
          verifyResult: evidence.verifyResult,
          scopeResult: evidence.scopeResult,
          reviewResult: evidence.reviewResult,
          criteriaResult: criteria,
          nextStatus: task.status,
        });
        task.last_failure.reason = "acceptance_proof_failed";
        task.last_failure.summary = `acceptance proof failed: ${acceptanceProof.checks.filter((check) => check.status === "fail").map((check) => check.name).join(", ")}`;
        task.updatedAt = nowIso();
        await writeFailureReport(rootDir, taskState.planId, task);
        await persistTaskState(rootDir, taskState);
        return { status: task.status === "failed" ? "failed" : "retry", planId: taskState.planId, task, acceptanceProof };
      }
      task.status = "completed";
      task.updatedAt = nowIso();
      await persistTaskState(rootDir, taskState);
      await writeCheckpoint(rootDir, taskState.planId, task, evidence.verifyResult, evidence.scopeResult, evidence.reviewResult);
      await appendWisdom(rootDir, task, evidence.verifyResult);
      await writeMemoryDigest(rootDir, { reason: "parallel_admission_completed", stage: "checkpoint", task, taskId });
      return { status: "completed", planId: taskState.planId, task, acceptanceProof };
    }

    task.status = shouldFailAdmission(task, evidence.verifyResult, evidence.scopeResult, evidence.reviewResult) ? "failed" : "pending";
    task.last_failure = buildFailureSummary(task, {
      workerResult: evidence.workerResult,
      verifyResult: evidence.verifyResult,
      scopeResult: evidence.scopeResult,
      reviewResult: evidence.reviewResult,
      criteriaResult: criteria,
      nextStatus: task.status,
    });
    task.updatedAt = nowIso();
    await writeFailureReport(rootDir, taskState.planId, task);
    await persistTaskState(rootDir, taskState);
    return { status: task.status === "failed" ? "failed" : "retry", planId: taskState.planId, task };
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
  const startedAt = nowIso();
  const commandResult = worktree.isolation === "git-worktree" && worktree.available !== true
    ? { exitCode: 1, stdout: "", stderr: worktree.reason || "git-worktree isolation unavailable" }
    : command
      ? await runCommand(command, worktree.workDir, normalizeTimeout(options.timeoutMs || config.parallelAgents?.timeoutMs))
      : { exitCode: 0, stdout: "", stderr: "no runner command configured; task packet prepared only" };
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
    pass: commandResult.exitCode === 0,
    stdout: truncate(commandResult.stdout || "", 4000),
    stderr: truncate(commandResult.stderr || "", 4000),
    result: structuredResult,
    lifecycle: buildAgentLifecycle(commandResult.exitCode === 0, config),
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
    summary: `${task.id} parallel result: ${result.pass ? "pass" : "fail"}`,
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

function buildAgentLifecycle(pass, config) {
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

function buildMessageBody(task, result) {
  const lines = [
    `Task: ${task.id} ${task.subject}`,
    `Agent: ${result.agent}`,
    `Status: ${result.pass ? "pass" : "fail"}`,
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
