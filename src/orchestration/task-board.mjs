import { externalDependenciesDigest } from "../infra/cross-project-evidence.mjs";
// =============================================================================
// 文件名称：task-board.mjs
// 所属模块：orchestration
// 作用说明：
//   团队任务板：任务查询/创建/ready/claim、证据记录与 persistTaskState
//   （team/tasks.json 唯一可写入口）。归档在 task-archive，团队消息在 team-messages。
//
// 【运行原理速读】
//   可以把它想成「任务看板的唯一写后端」：
//
//   · 何时执行？
//     task CLI、linear/parallel runtime、admission 持久化时。
//
//   · 做了什么？
//     读改 taskState → transactWithLedger → 写 tasks.md 派生视图 → 最后写 team/tasks.json。
// =============================================================================
import { responsibilityDigest } from "../infra/responsibility-contract.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import {
  STATE_VERSION,
  ensureWildArrangeDirs,
  nowIso,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import {
  loadTaskLedger,
  replacePlanTasks,
  resolveLedgerTask,
  withTaskIdentity,
} from "../infra/task-state-store.mjs";
import { DEFAULT_EXECUTOR_AGENT, normalizeAgentKey } from "../infra/agent-registry.mjs";
import { transactWithLedger, withTaskStateLock } from "../infra/task-state-lock.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { findRunnableTask, unresolvedTaskBlockers } from "../infra/task-predicates.mjs";
import { loadRoutesConfig } from "../infra/route-table.mjs";
import {
  loadTaskState,
  updateWorkState,
  writeTasksMarkdown,
} from "./plan-state.mjs";
import {
  enrichTaskWithRouteDecision,
  normalizeTask,
  validatePlanGraph,
  validateTaskReady,
  hasUnboundDefaultCriteria,
} from "./task-normalize.mjs";
import { resolveTaskBranchTarget } from "./task-branch.mjs";

// --- 查询 ---

/** 列出团队任务（当前计划或 --all 跨计划 ledger 视图）。 */
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

/** 按 taskId 获取单条任务详情。 */
export async function getTeamTask(rootDir, taskId, options = {}) {
  const ledger = await loadTaskLedger(rootDir);
  if (!ledger) throw new Error("no task ledger found; create or import a task first");
  const task = resolveLedgerTask(ledger, taskId, options.planId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  await appendLedger(rootDir, { type: "team_task_read", planId: task.planId, taskId: task.id, taskRef: task.ref });
  return { planId: task.planId, task };
}

/** 向任务 evidence 轨迹追加一条 gate/worker 证据条目。 */
export async function recordTaskEvidence(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `evidence-record:${options.taskId || "unknown"}`, async () => {
    await ensureWildArrangeDirs(rootDir);
    const taskState = await loadTaskState(rootDir);
    if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");
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
    await transactWithLedger(rootDir, {
      type: "criterion_evidence_recorded",
      planId: taskState.planId,
      taskId: task.id,
      criterionId: criterion.id,
      status,
    }, () => persistTaskState(rootDir, taskState));
    return { planId: taskState.planId, task, criterion, evidence: entry };
  });
}

// --- claim 与创建 ---

/** claim 任务供 worker 执行，含 task branch 目标解析与 blockedBy 检查。 */
export async function claimTeamTask(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `team-task-claim:${options.taskId || "next"}`, () => claimTeamTaskUnlocked(rootDir, options));
}

/** 锁内 claim 团队任务并更新 owner/in_progress。 */
async function claimTeamTaskUnlocked(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");
  const task = options.taskId
    ? taskState.tasks.find((candidate) => candidate.id === options.taskId)
    : findRunnableTask(taskState.tasks);
  if (!task) throw new Error(options.taskId ? `unknown task: ${options.taskId}` : "no runnable task available to claim");
  if (task.status !== "pending") throw new Error(`task ${task.id} is ${task.status}; only pending tasks can be claimed`);
  const blockers = unresolvedTaskBlockers(task, taskState.tasks);
  if (blockers.length > 0) throw new Error(`task ${task.id} blocked by ${blockers.join(",")}`);

  const owner = normalizeAgentKey(options.owner || task.owner || DEFAULT_EXECUTOR_AGENT);
  const coordination = await resolveTaskBranchTarget(rootDir, {
    planId: taskState.planId,
    task,
  });
  task.status = "in_progress";
  task.owner = owner;
  task.coordination = coordination;
  task.claimedAt = nowIso();
  task.updatedAt = nowIso();
  // 审计先行：team_task_claimed 入账本后才提交 in_progress 状态（ARC-003）。
  await transactWithLedger(rootDir, {
    type: "team_task_claimed",
    planId: taskState.planId,
    taskId: task.id,
    owner: task.owner,
    coordinationStatus: coordination.status,
  }, () => persistTaskState(rootDir, taskState));
  await writeSnapshot(rootDir, "team_task_claimed", { planId: taskState.planId, taskId: task.id, owner: task.owner });
  return { planId: taskState.planId, task };
}


/** 创建 draft 团队任务并写入 taskState。 */
export async function createTeamTask(rootDir, rawTask) {
  return withTaskStateLock(rootDir, "team-task-create", () => createTeamTaskUnlocked(rootDir, rawTask));
}

/** 锁内创建 draft 团队任务并写入 ledger。 */
async function createTeamTaskUnlocked(rootDir, rawTask) {
  await ensureWildArrangeDirs(rootDir);
  const taskState = await ensureTaskCreationState(rootDir);
  const planPath = resolveWildArrangePath(rootDir, "plans", `${taskState.planId}.json`);
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
  await transactWithLedger(rootDir, {
    type: "team_task_created",
    planId: taskState.planId,
    taskId: normalizedTask.id,
    taskRef: normalizedTask.ref,
    subject: normalizedTask.subject,
    workType: normalizedTask.workType,
    source: normalizedTask.source,
    priority: normalizedTask.priority,
    blockedBy: normalizedTask.blockedBy,
  }, () => persistTaskState(rootDir, taskState));
  await writeSnapshot(rootDir, "team_task_created", { planId: taskState.planId, taskId: normalizedTask.id });
  return { planId: taskState.planId, task: normalizedTask };
}

/** 将 draft 任务 ready：合并详情 JSON 并校验 validateTaskReady。 */
export async function readyTeamTask(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `team-task-ready:${options.taskId || "unknown"}`, async () => {
    const ledger = await loadTaskLedger(rootDir);
    if (!ledger) throw new Error("no task ledger found; create or import a task first");
    const existing = resolveLedgerTask(ledger, options.taskId, options.planId);
    if (!existing) throw new Error(`unknown task: ${options.taskId}`);
    if (existing.status !== "draft") throw new Error(`task ${existing.id} is ${existing.status}; only draft tasks can become pending`);
    const taskState = await loadTaskState(rootDir, { planId: existing.planId });
    const plan = await readJson(resolveWildArrangePath(rootDir, "plans", `${existing.planId}.json`));
    const patch = options.patch && typeof options.patch === "object" ? options.patch : {};
    // 建单时没有 verify 命令的默认标准：交给 normalizeTask 按本次补齐的命令重新生成
    const successCriteria = patch.successCriteria ?? (hasUnboundDefaultCriteria(existing) ? undefined : existing.successCriteria);
    const nextTask = withTaskIdentity(normalizeTask({
      ...existing,
      ...patch,
      successCriteria,
      id: existing.id,
      status: "pending",
      createdAt: existing.createdAt,
      history: existing.history,
    }, taskState.tasks.findIndex((task) => task.id === existing.id), plan.defaults || {}), existing.planId);
    validateTaskReady(nextTask);
    const routes = await loadRoutesConfig(rootDir);
    enrichTaskWithRouteDecision(nextTask, routes);
    taskState.tasks = taskState.tasks.map((task) => task.id === existing.id ? nextTask : task);
    await transactWithLedger(rootDir, {
      type: "team_task_readied",
      planId: existing.planId,
      taskId: existing.id,
      taskRef: existing.ref,
    }, () => persistTaskState(rootDir, taskState));
    await writeSnapshot(rootDir, "team_task_readied", { planId: existing.planId, taskId: existing.id });
    return { planId: existing.planId, task: nextTask };
  });
}


// --- 持久化 ---

/**
 * 持久化任务状态：team/tasks.json 是任务状态唯一可写处（提交点，最后写）；
 * tasks.md 是由它派生的视图。plans/<id>.json 只是导入快照，不在此写入。
 */
export async function persistTaskState(rootDir, taskState) {
  const at = nowIso();
  taskState.updatedAt = at;
  const ledger = await loadTaskLedger(rootDir);
  const plan = ledger?.plans.find((candidate) => candidate.id === taskState.planId)
    || { id: taskState.planId, title: taskState.planId, objective: "" };
  const previousTasks = new Map((ledger?.tasks || [])
    .filter((task) => task.planId === taskState.planId)
    .map((task) => [task.id, task]));
  const responsibilityChanged = taskState.tasks.some((task) => {
    const previous = previousTasks.get(task.id);
    return externalDependenciesDigest(task) !== externalDependenciesDigest(previous || {})
      || (Boolean(task.responsibilityChanges || previous?.responsibilityChanges)
      && responsibilityDigest(task.responsibilityChanges) !== responsibilityDigest(previous?.responsibilityChanges));
  });
  if (responsibilityChanged) {
    await updateWorkState(rootDir, (work) => work.activePlanId === taskState.planId
      ? { ...work, status: "awaiting_plan_approval",
        planApproval: { ...work.planApproval, required: true, status: "pending", planId: taskState.planId } }
      : work, { createIfMissing: false });
  }
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
  const nextLedger = replacePlanTasks(ledger, plan, taskState.tasks, { at });
  // Write order = derived artifacts first, canonical state last. tasks.json
  // is the single load source (loadTaskState), so it acts as the commit
  // point: if the markdown fails to write, the canonical state stays at its
  // previous value and the caller's throw leaves a re-runnable (not
  // half-completed) task instead of a completed task with missing
  // ledger/markdown trail (cross-review P1, 2026-07-21).
  await writeTasksMarkdown(rootDir, { title: plan.title, objective: plan.objective, tasks: taskState.tasks });
  await writeJsonAtomic(resolveWildArrangePath(rootDir, "team", "tasks.json"), nextLedger);
}

/** 追加 task history 记录（status/owner 变更）。 */
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

/** 确保 team task 创建所需的 ledger 结构存在。 */
async function ensureTaskCreationState(rootDir) {
  const current = await loadTaskState(rootDir);
  if (current) return current;
  const at = nowIso();
  const plan = {
    id: "plan_inbox",
    title: "WildArrange Inbox",
    objective: "Capture work before execution details are complete.",
    defaults: { verify_commands: [], review_commands: [], standards_commands: [], writable_paths: [], skills: [] },
    createdAt: at,
    updatedAt: at,
  };
  await writeJsonAtomic(resolveWildArrangePath(rootDir, "plans", `${plan.id}.json`), plan);
  await writeJsonAtomic(resolveWildArrangePath(rootDir, "team", "tasks.json"), replacePlanTasks(null, plan, [], { at, activate: true }));
  await updateWorkState(rootDir, (work) => ({ ...work, stage: "planned", activePlanId: plan.id, status: "ready" }));
  await writeTasksMarkdown(rootDir, { ...plan, tasks: [] });
  await appendLedger(rootDir, { type: "inbox_plan_created", planId: plan.id });
  return { version: STATE_VERSION, planId: plan.id, tasks: [], updatedAt: at };
}

// --- worker outbox ---

/** 将 worker 结果写入任务 outbox 供下游 agent 消费。 */
export async function writeOutbox(rootDir, task, workerResult) {
  const outboxPath = resolveWildArrangePath(rootDir, "team", "outbox", `${task.id}-${Date.now()}.json`);
  await writeJsonAtomic(outboxPath, {
    to: DEFAULT_EXECUTOR_AGENT,
    from: task.owner || "worker",
    summary: `${task.id} done-claim`,
    taskId: task.id,
    taskRef: task.ref || (task.planId ? `${task.planId}:${task.id}` : null),
    planId: task.planId || null,
    at: nowIso(),
    workerResult,
  });
}
