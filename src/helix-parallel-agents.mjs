import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LEAD_AGENT,
  appendLedger,
  createWorkId,
  ensureHelixDirs,
  normalizeAgentKey,
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
  writeSnapshot,
} from "./helix-foundation.mjs";
import { runCommand } from "./helix-gates.mjs";
import { loadTaskState } from "./helix-plan.mjs";
import { findRunnableTask, sendTeamMessage } from "./helix-team.mjs";

const DEFAULT_PARALLEL_TIMEOUT_MS = 120_000;

export async function runParallelAgents(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");

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

async function runOneAgent(rootDir, runDir, runId, task, options) {
  const agent = normalizeAgentKey(options.agent || task.owner || `Agent${options.index + 1}`) || `Agent${options.index + 1}`;
  const taskRunDir = path.join(runDir, task.id);
  await mkdir(taskRunDir, { recursive: true });
  const taskPacketPath = path.join(taskRunDir, "task.json");
  const resultPath = path.join(taskRunDir, "agent-result.json");
  await writeJsonAtomic(taskPacketPath, buildTaskPacket(task, { runId, agent }));

  const command = renderRunnerCommand(options.command || options.runnerCommand, {
    rootDir,
    runDir: taskRunDir,
    task,
    agent,
    taskPacketPath,
    resultPath,
  });
  const startedAt = nowIso();
  const commandResult = command
    ? await runCommand(command, taskRunDir, normalizeTimeout(options.timeoutMs))
    : { exitCode: 0, stdout: "", stderr: "no runner command configured; task packet prepared only" };
  const structuredResult = await readJson(resultPath, null);
  const result = {
    kind: "parallel_agent_result",
    runId,
    taskId: task.id,
    agent,
    at: nowIso(),
    startedAt,
    command: command || null,
    exitCode: commandResult.exitCode,
    pass: commandResult.exitCode === 0,
    stdout: truncate(commandResult.stdout || "", 4000),
    stderr: truncate(commandResult.stderr || "", 4000),
    result: structuredResult,
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
      "Write optional structured output to agent-result.json.",
      "Do not claim the main task is complete; mainline verifier/review gates decide completion.",
    ],
  };
}

function renderRunnerCommand(command, context) {
  if (!command || command === true) return null;
  return String(command)
    .replaceAll("{rootDir}", shellEscape(context.rootDir))
    .replaceAll("{runDir}", shellEscape(context.runDir))
    .replaceAll("{taskId}", shellEscape(context.task.id))
    .replaceAll("{agent}", shellEscape(context.agent))
    .replaceAll("{taskJson}", shellEscape(context.taskPacketPath))
    .replaceAll("{outputJson}", shellEscape(context.resultPath));
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

function truncate(value, limit) {
  return value.length <= limit ? value : `${value.slice(0, limit - 20)}\n...[truncated]`;
}

function shellEscape(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
