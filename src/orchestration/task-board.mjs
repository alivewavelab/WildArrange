import { appendFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  appendLedger,
  createWorkId,
  DEFAULT_EXECUTOR_AGENT,
  DEFAULT_LEAD_AGENT,
  ensureHelixDirs,
  normalizeAgentKey,
  nowIso,
  readJson,
  resolveHelixPath,
  withTaskStateLock,
  writeJsonAtomic,
  writeSnapshot,
} from "../infra/foundation.mjs";
import { loadRoutesConfig } from "../infra/route-table.mjs";
import {
  enrichTaskWithRouteDecision,
  loadTaskState,
  normalizeTask,
  validatePlanGraph,
  writeTasksMarkdown,
} from "./plan-state.mjs";
export { applyVerifierEvidenceToCriteria, criteriaStatus } from "../infra/success-criteria.mjs";

export async function listTeamTasks(rootDir, options = {}) {
  const taskState = await loadTaskState(rootDir);
  if (!taskState) return { planId: null, tasks: [] };
  const tasks = taskState.tasks.filter((task) => {
    if (options.status && task.status !== options.status) return false;
    if (options.owner && task.owner !== options.owner) return false;
    return true;
  });
  await appendLedger(rootDir, {
    type: "team_tasks_listed",
    planId: taskState.planId,
    status: options.status || null,
    owner: options.owner || null,
    count: tasks.length,
  });
  return { planId: taskState.planId, tasks };
}

export async function getTeamTask(rootDir, taskId) {
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = taskState.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  await appendLedger(rootDir, { type: "team_task_read", planId: taskState.planId, taskId });
  return { planId: taskState.planId, task };
}

export async function recordTaskEvidence(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `evidence-record:${options.taskId || "unknown"}`, async () => {
    await ensureHelixDirs(rootDir);
    const taskState = await loadTaskState(rootDir);
    if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
    const task = taskState.tasks.find((candidate) => candidate.id === options.taskId);
    if (!task) throw new Error(`unknown task: ${options.taskId}`);
    const criterion = (task.successCriteria || []).find((candidate) => candidate.id === options.criterionId);
    if (!criterion) throw new Error(`unknown criterion for ${task.id}: ${options.criterionId}`);
    const status = options.status || "pass";
    if (!["pass", "fail", "pending"].includes(status)) throw new Error("evidence status must be pass, fail, or pending");
    const evidence = typeof options.evidence === "string" ? options.evidence.trim() : "";
    if (!evidence) throw new Error("evidence text is required");
    const entry = {
      kind: "criterion_evidence",
      at: nowIso(),
      taskId: task.id,
      criterionId: criterion.id,
      status,
      source: options.source || "manual",
      evidence,
    };
    criterion.status = status;
    criterion.evidence = [...(criterion.evidence || []), entry];
    criterion.lastUpdatedAt = entry.at;
    task.evidence.push(entry);
    task.updatedAt = nowIso();
    await persistTaskState(rootDir, taskState);
    await appendLedger(rootDir, { type: "criterion_evidence_recorded", planId: taskState.planId, taskId: task.id, criterionId: criterion.id, status });
    return { planId: taskState.planId, task, criterion, evidence: entry };
  });
}

export async function claimTeamTask(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `team-task-claim:${options.taskId || "next"}`, () => claimTeamTaskUnlocked(rootDir, options));
}

async function claimTeamTaskUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = options.taskId
    ? taskState.tasks.find((candidate) => candidate.id === options.taskId)
    : findRunnableTask(taskState.tasks);
  if (!task) throw new Error(options.taskId ? `unknown task: ${options.taskId}` : "no runnable task available to claim");
  if (task.status !== "pending") throw new Error(`task ${task.id} is ${task.status}; only pending tasks can be claimed`);
  const blockers = unresolvedBlockers(task, taskState.tasks);
  if (blockers.length > 0) throw new Error(`task ${task.id} blocked by ${blockers.join(",")}`);

  task.status = "in_progress";
  task.owner = normalizeAgentName(options.owner || task.owner || DEFAULT_EXECUTOR_AGENT);
  task.claimedAt = nowIso();
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: "team_task_claimed",
    planId: taskState.planId,
    taskId: task.id,
    owner: task.owner,
  });
  await writeSnapshot(rootDir, "team_task_claimed", { planId: taskState.planId, taskId: task.id, owner: task.owner });
  return { planId: taskState.planId, task };
}

function unresolvedBlockers(task, tasks) {
  return (task.blockedBy || []).filter((blockerId) => {
    const blocker = tasks.find((candidate) => candidate.id === blockerId);
    return blocker && blocker.status !== "completed";
  });
}

export async function createTeamTask(rootDir, rawTask) {
  return withTaskStateLock(rootDir, "team-task-create", () => createTeamTaskUnlocked(rootDir, rawTask));
}

async function createTeamTaskUnlocked(rootDir, rawTask) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const planPath = resolveHelixPath(rootDir, "plans", `${taskState.planId}.json`);
  const plan = await readJson(planPath);
  const normalizedTask = normalizeTask(rawTask, taskState.tasks.length, plan.defaults || {});
  if (taskState.tasks.some((task) => task.id === normalizedTask.id)) {
    throw new Error(`duplicate task id: ${normalizedTask.id}`);
  }
  const routes = await loadRoutesConfig(rootDir);
  enrichTaskWithRouteDecision(normalizedTask, routes);
  const nextTasks = [...taskState.tasks, normalizedTask];
  validatePlanGraph({ ...plan, tasks: nextTasks });
  taskState.tasks = nextTasks;
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: "team_task_created",
    planId: taskState.planId,
    taskId: normalizedTask.id,
    subject: normalizedTask.subject,
    blockedBy: normalizedTask.blockedBy,
  });
  await writeSnapshot(rootDir, "team_task_created", { planId: taskState.planId, taskId: normalizedTask.id });
  return { planId: taskState.planId, task: normalizedTask };
}

export function findRunnableTask(tasks) {
  const completed = new Set(tasks.filter((task) => task.status === "completed").map((task) => task.id));
  return tasks.find((task) => {
    if (task.status !== "pending") return false;
    return task.blockedBy.every((blockedBy) => completed.has(blockedBy));
  }) || null;
}

export async function persistTaskState(rootDir, taskState) {
  taskState.updatedAt = nowIso();
  await writeJsonAtomic(resolveHelixPath(rootDir, "team", "tasks.json"), taskState);
  const plan = await readJson(resolveHelixPath(rootDir, "plans", `${taskState.planId}.json`));
  plan.tasks = taskState.tasks;
  plan.updatedAt = nowIso();
  await writeJsonAtomic(resolveHelixPath(rootDir, "plans", `${taskState.planId}.json`), plan);
  await writeTasksMarkdown(rootDir, plan);
}

export async function writeOutbox(rootDir, task, workerResult) {
  const outboxPath = resolveHelixPath(rootDir, "team", "outbox", `${task.id}-${Date.now()}.json`);
  await writeJsonAtomic(outboxPath, {
    to: DEFAULT_EXECUTOR_AGENT,
    from: task.owner || "worker",
    summary: `${task.id} done-claim`,
    taskId: task.id,
    at: nowIso(),
    workerResult,
  });
}

export async function sendTeamMessage(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const to = normalizeAgentName(options.to);
  const from = normalizeAgentName(options.from || DEFAULT_LEAD_AGENT);
  const body = typeof options.body === "string" ? options.body.trim() : "";
  if (!to) throw new Error("message recipient is required");
  if (!body) throw new Error("message body is required");
  const id = createWorkId("msg");
  const message = {
    id,
    kind: "team_message",
    at: nowIso(),
    from,
    to,
    summary: options.summary || body.slice(0, 120),
    body,
    status: "unread",
  };
  const inboxPath = resolveHelixPath(rootDir, "team", "inbox", to, `${id}.json`);
  const outboxPath = resolveHelixPath(rootDir, "team", "outbox", from, `${id}.json`);
  await writeJsonAtomic(inboxPath, message);
  await writeJsonAtomic(outboxPath, message);
  await appendTeamMessageIndex(rootDir, message);
  await appendLedger(rootDir, { type: "team_message_sent", messageId: id, from, to, summary: message.summary });
  return {
    ...message,
    inboxPath: path.relative(rootDir, inboxPath),
    outboxPath: path.relative(rootDir, outboxPath),
  };
}

export function normalizeAgentName(value) {
  return normalizeAgentKey(value);
}

async function appendTeamMessageIndex(rootDir, message) {
  const line = `- ${message.at} ${message.from} -> ${message.to}: ${message.summary} (${message.id})\n`;
  await appendFile(resolveHelixPath(rootDir, "team", "messages.md"), line, "utf8");
}

export async function listTeamMessages(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const agent = normalizeAgentName(options.agent || options.to);
  const baseDir = agent ? resolveHelixPath(rootDir, "team", "inbox", agent) : resolveHelixPath(rootDir, "team", "inbox");
  const messages = [];
  if (agent) {
    for (const fileName of await safeReadDir(baseDir)) {
      if (/^msg_.+\.json$/.test(fileName)) {
        messages.push(await readJson(path.join(baseDir, fileName)));
      }
    }
  } else {
    for (const agentDir of await safeReadDir(baseDir)) {
      const dirPath = path.join(baseDir, agentDir);
      for (const fileName of await safeReadDir(dirPath)) {
        if (/^msg_.+\.json$/.test(fileName)) {
          messages.push(await readJson(path.join(dirPath, fileName)));
        }
      }
    }
  }
  messages.sort((left, right) => String(left.at).localeCompare(String(right.at)));
  await appendLedger(rootDir, { type: "team_messages_listed", agent: agent || "all", count: messages.length });
  return messages;
}

async function safeReadDir(dirPath, options = undefined) {
  try {
    return await readdir(dirPath, options);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
