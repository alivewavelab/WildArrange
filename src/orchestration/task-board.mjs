import { appendFile, readdir } from "node:fs/promises";
import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import {
  STATE_VERSION,
  createWorkId,
  ensureHelixDirs,
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import {
  loadTaskLedger,
  withTaskIdentity,
} from "../infra/task-state-store.mjs";
import {
  DEFAULT_EXECUTOR_AGENT,
  DEFAULT_LEAD_AGENT,
  normalizeAgentKey,
} from "../infra/agent-registry.mjs";
import { withTaskStateLock } from "../infra/task-state-lock.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { loadRoutesConfig } from "../infra/route-table.mjs";
import {
  enrichTaskWithRouteDecision,
  loadTaskState,
  normalizeTask,
  validateTaskReady,
  validatePlanGraph,
  writeTasksMarkdown,
} from "./plan-state.mjs";
import { coordinateTaskClaim } from "./remote-ownership.mjs";
export { applyVerifierEvidenceToCriteria, criteriaStatus } from "../infra/success-criteria.mjs";

export async function listTeamTasks(rootDir, options = {}) {
  const ledger = await loadTaskLedger(rootDir);
  if (!ledger) return { planId: null, activePlanId: null, plans: [], total: 0, tasks: [] };
  const sourceTasks = options.all === true
    ? ledger.tasks
    : ledger.tasks.filter((task) => task.planId === ledger.activePlanId);
  const search = typeof options.search === "string" ? options.search.trim().toLowerCase() : "";
  const tasks = sourceTasks.filter((task) => {
    if (options.status && task.status !== options.status) return false;
    if (options.owner && task.owner !== options.owner) return false;
    if (options.workType && task.workType !== options.workType) return false;
    if (options.priority && task.priority !== options.priority) return false;
    if (options.planId && task.planId !== options.planId) return false;
    if (search && !`${task.id}\n${task.subject}\n${task.description}\n${task.request?.summary || ""}`.toLowerCase().includes(search)) return false;
    return true;
  });
  await appendLedger(rootDir, {
    type: "team_tasks_listed",
    planId: options.planId || ledger.activePlanId,
    all: options.all === true,
    status: options.status || null,
    owner: options.owner || null,
    count: tasks.length,
  });
  return {
    planId: options.planId || ledger.activePlanId,
    activePlanId: ledger.activePlanId,
    plans: ledger.plans,
    total: tasks.length,
    tasks,
  };
}

export async function getTeamTask(rootDir, taskId, options = {}) {
  const ledger = await loadTaskLedger(rootDir);
  if (!ledger) throw new Error("no task ledger found; create or import a task first");
  const task = resolveLedgerTask(ledger, taskId, options.planId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  await appendLedger(rootDir, { type: "team_task_read", planId: task.planId, taskId: task.id, taskRef: task.ref });
  return { planId: task.planId, task };
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

  const owner = normalizeAgentName(options.owner || task.owner || DEFAULT_EXECUTOR_AGENT);
  const coordination = await coordinateTaskClaim(rootDir, {
    planId: taskState.planId,
    task,
    owner,
    force: options.forceCoordination === true,
  });
  task.status = "in_progress";
  task.owner = owner;
  task.coordination = coordination;
  task.claimedAt = nowIso();
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: "team_task_claimed",
    planId: taskState.planId,
    taskId: task.id,
    owner: task.owner,
    coordinationStatus: coordination.status,
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
  const taskState = await ensureTaskCreationState(rootDir);
  const planPath = resolveHelixPath(rootDir, "plans", `${taskState.planId}.json`);
  const plan = await readJson(planPath);
  const normalizedTask = withTaskIdentity(normalizeTask(rawTask, taskState.tasks.length, plan.defaults || {}, {
    defaultDraftWhenIncomplete: true,
    defaultSource: "user",
  }), taskState.planId);
  if (normalizedTask.status !== "draft" && normalizedTask.workType === "acceptance_correction" && !normalizedTask.parentTaskRef) {
    throw new Error(`task ${normalizedTask.id} acceptance_correction requires parentTaskRef`);
  }
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
    taskRef: normalizedTask.ref,
    subject: normalizedTask.subject,
    workType: normalizedTask.workType,
    source: normalizedTask.source,
    priority: normalizedTask.priority,
    blockedBy: normalizedTask.blockedBy,
  });
  await writeSnapshot(rootDir, "team_task_created", { planId: taskState.planId, taskId: normalizedTask.id });
  return { planId: taskState.planId, task: normalizedTask };
}

export async function readyTeamTask(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `team-task-ready:${options.taskId || "unknown"}`, async () => {
    const ledger = await loadTaskLedger(rootDir);
    if (!ledger) throw new Error("no task ledger found; create or import a task first");
    const existing = resolveLedgerTask(ledger, options.taskId, options.planId);
    if (!existing) throw new Error(`unknown task: ${options.taskId}`);
    if (existing.status !== "draft") throw new Error(`task ${existing.id} is ${existing.status}; only draft tasks can become pending`);
    const taskState = await loadTaskState(rootDir, { planId: existing.planId });
    const plan = await readJson(resolveHelixPath(rootDir, "plans", `${existing.planId}.json`));
    const patch = options.patch && typeof options.patch === "object" ? options.patch : {};
    const nextTask = withTaskIdentity(normalizeTask({
      ...existing,
      ...patch,
      id: existing.id,
      status: "pending",
      createdAt: existing.createdAt,
      history: existing.history,
    }, taskState.tasks.findIndex((task) => task.id === existing.id), plan.defaults || {}), existing.planId);
    validateTaskReady(nextTask);
    const routes = await loadRoutesConfig(rootDir);
    enrichTaskWithRouteDecision(nextTask, routes);
    taskState.tasks = taskState.tasks.map((task) => task.id === existing.id ? nextTask : task);
    await persistTaskState(rootDir, taskState);
    await appendLedger(rootDir, {
      type: "team_task_readied",
      planId: existing.planId,
      taskId: existing.id,
      taskRef: existing.ref,
    });
    await writeSnapshot(rootDir, "team_task_readied", { planId: existing.planId, taskId: existing.id });
    return { planId: existing.planId, task: nextTask };
  });
}

export function findRunnableTask(tasks) {
  const completed = new Set(tasks.filter((task) => task.status === "completed").map((task) => task.id));
  return tasks.find((task) => {
    if (task.status !== "pending") return false;
    return task.blockedBy.every((blockedBy) => completed.has(blockedBy));
  }) || null;
}

export async function persistTaskState(rootDir, taskState) {
  const at = nowIso();
  taskState.updatedAt = at;
  const ledger = await loadTaskLedger(rootDir);
  const plan = await readJson(resolveHelixPath(rootDir, "plans", `${taskState.planId}.json`));
  const previousTasks = new Map((ledger?.tasks || [])
    .filter((task) => task.planId === taskState.planId)
    .map((task) => [task.id, task]));
  for (const task of taskState.tasks) {
    const persisted = appendTaskHistory(
      withTaskIdentity(task, taskState.planId),
      previousTasks.get(task.id),
      at,
    );
    // Keep object identity stable: the linear/admission transaction holds a
    // task reference across several persists in one run.
    Object.assign(task, persisted);
  }
  plan.tasks = taskState.tasks;
  plan.updatedAt = at;
  const planEntry = {
    id: plan.id,
    title: plan.title,
    objective: plan.objective,
    taskIds: taskState.tasks.map((task) => task.id),
    createdAt: (ledger?.plans || []).find((candidate) => candidate.id === plan.id)?.createdAt || plan.createdAt || at,
    updatedAt: at,
  };
  const nextLedger = {
    version: STATE_VERSION,
    kind: "task_ledger",
    planId: ledger?.activePlanId || taskState.planId,
    activePlanId: ledger?.activePlanId || taskState.planId,
    plans: [
      ...(ledger?.plans || []).filter((candidate) => candidate.id !== taskState.planId),
      planEntry,
    ],
    tasks: [
      ...(ledger?.tasks || []).filter((task) => task.planId !== taskState.planId),
      ...taskState.tasks,
    ],
    createdAt: ledger?.createdAt || at,
    updatedAt: at,
  };
  // Write order = derived artifacts first, canonical state last. tasks.json
  // is the single load source (loadTaskState), so it acts as the commit
  // point: if the markdown or plan mirror fails to write, the canonical
  // state stays at its previous value and the caller's throw leaves a
  // re-runnable (not half-completed) task instead of a completed task with
  // missing ledger/markdown trail (cross-review P1, 2026-07-21).
  await writeTasksMarkdown(rootDir, plan);
  await writeJsonAtomic(resolveHelixPath(rootDir, "plans", `${taskState.planId}.json`), plan);
  await writeJsonAtomic(resolveHelixPath(rootDir, "team", "tasks.json"), nextLedger);
}

function resolveLedgerTask(ledger, taskId, planId) {
  if (!taskId) return null;
  const byRef = ledger.tasks.find((task) => task.ref === taskId);
  if (byRef) return byRef;
  const targetPlanId = planId || ledger.activePlanId;
  const activeMatch = ledger.tasks.find((task) => task.planId === targetPlanId && task.id === taskId);
  if (activeMatch) return activeMatch;
  const matches = ledger.tasks.filter((task) => task.id === taskId);
  return matches.length === 1 ? matches[0] : null;
}

function appendTaskHistory(task, previous, at) {
  if (!previous) return task;
  const history = [...(task.history || previous.history || [])];
  if (previous.status !== task.status) {
    history.push({ at, event: "status_changed", from: previous.status, to: task.status, attempt: task.attempts });
  }
  if (previous.attempts !== task.attempts) {
    history.push({ at, event: "attempt_changed", from: previous.attempts, to: task.attempts });
  }
  if (previous.owner !== task.owner) {
    history.push({ at, event: "owner_changed", from: previous.owner || null, to: task.owner || null });
  }
  const previousEvidence = Array.isArray(previous.evidence) ? previous.evidence.length : 0;
  const nextEvidence = Array.isArray(task.evidence) ? task.evidence.length : 0;
  if (nextEvidence > previousEvidence) {
    history.push({ at, event: "evidence_added", count: nextEvidence - previousEvidence });
  }
  return { ...task, history };
}

async function ensureTaskCreationState(rootDir) {
  const current = await loadTaskState(rootDir);
  if (current) return current;
  const at = nowIso();
  const planId = "plan_inbox";
  const plan = {
    id: planId,
    title: "WildArrange Inbox",
    objective: "Capture work before execution details are complete.",
    defaults: { verify_commands: [], review_commands: [], standards_commands: [], writable_paths: [], skills: [] },
    createdAt: at,
    updatedAt: at,
    tasks: [],
  };
  await writeJsonAtomic(resolveHelixPath(rootDir, "plans", `${planId}.json`), plan);
  await writeJsonAtomic(resolveHelixPath(rootDir, "team", "tasks.json"), {
    version: STATE_VERSION,
    kind: "task_ledger",
    planId,
    activePlanId: planId,
    plans: [{ id: planId, title: plan.title, objective: plan.objective, taskIds: [], createdAt: at, updatedAt: at }],
    tasks: [],
    createdAt: at,
    updatedAt: at,
  });
  const workPath = resolveHelixPath(rootDir, "work.json");
  const work = await readJson(workPath, { version: STATE_VERSION, workId: createWorkId(), createdAt: at });
  await writeJsonAtomic(workPath, {
    ...work,
    stage: "planned",
    activePlanId: planId,
    status: "ready",
    updatedAt: at,
  });
  await writeTasksMarkdown(rootDir, plan);
  await appendLedger(rootDir, { type: "inbox_plan_created", planId });
  return { version: STATE_VERSION, planId, tasks: [], updatedAt: at };
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
