// =============================================================================
// 文件名称：task-board.mjs
// 所属模块：orchestration
// 作用说明：
//   团队任务板：任务 CRUD、claim、证据记录、persistTaskState、
//   outbox/消息、归档删除与 ledger 迁移。权威 taskState 写入入口之一。
//
// 【运行原理速读】
//   可以把它想成「任务看板的唯一写后端」：
//
//   · 何时执行？
//     task CLI、linear/parallel runtime、admission 持久化时。
//
//   · 做了什么？
//     读改 taskState → transactWithLedger → 写 JSON → 可选 tasks.md 镜像。
// =============================================================================
import { responsibilityDigest } from "../infra/responsibility-contract.mjs";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import { normalizeRelativePath } from "../infra/path-match.mjs";
import {
  STATE_VERSION,
  createWorkId,
  ensureWildArrangeDirs,
  legacyTaskEvidenceStem,
  nowIso,
  readJson,
  resolveLegacyTaskAcceptancePath,
  resolveLegacyTaskCheckpointPath,
  resolveWildArrangePath,
  resolveTaskAcceptancePath,
  resolveTaskCheckpointPath,
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
import { transactWithLedger, withTaskStateLock } from "../infra/task-state-lock.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import {
  prepareArchiveRecoveryPackage,
  updateArchiveRecoveryPackage,
} from "../infra/security.mjs";
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
export { migrateTaskLedgerState } from "./task-migration.mjs";

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

/** claim 任务供 worker 执行，含 coordination claim 与 blockedBy 检查。 */
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

/** 返回尚未 completed 的 blockedBy 依赖 taskId 列表。 */
export function unresolvedTaskBlockers(task, tasks) {
  return (task.blockedBy || []).filter((blockerId) => {
    const blocker = tasks.find((candidate) => candidate.id === blockerId);
    return blocker && blocker.status !== "completed";
  });
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

// ---  runnable 与持久化 ---

/** 在任务列表中找第一条 isTaskRunnable 的任务。 */
export function findRunnableTask(tasks) {
  return tasks.find((task) => isTaskRunnable(task, tasks)) || null;
}

/** 判断任务是否 pending 且依赖已 completed。 */
export function isTaskRunnable(task, tasks) {
  // A pending task holding a parallel run or admission claim is owned by that
  // run; both claims are released (set to null) when the run closes or the
  // admission settles, which makes the task runnable again.
  return task?.status === "pending"
    && !task.parallel_run_claim?.runId
    && !task.admission_claim?.runId
    && unresolvedTaskBlockers(task, tasks).length === 0;
}

/** 持久化权威 taskState 并刷新 tasks.md 等派生产物。 */
export async function persistTaskState(rootDir, taskState) {
  const at = nowIso();
  taskState.updatedAt = at;
  const ledger = await loadTaskLedger(rootDir);
  const plan = await readJson(resolveWildArrangePath(rootDir, "plans", `${taskState.planId}.json`));
  const previousTasks = new Map((ledger?.tasks || [])
    .filter((task) => task.planId === taskState.planId)
    .map((task) => [task.id, task]));
  const responsibilityChanged = taskState.tasks.some((task) => {
    const previous = previousTasks.get(task.id);
    return Boolean(task.responsibilityChanges || previous?.responsibilityChanges)
      && responsibilityDigest(task.responsibilityChanges) !== responsibilityDigest(previous?.responsibilityChanges);
  });
  if (responsibilityChanged) {
    const workPath = resolveWildArrangePath(rootDir, "work.json");
    const work = await readJson(workPath, null);
    if (work?.activePlanId === taskState.planId) {
      await writeJsonAtomic(workPath, { ...work, status: "awaiting_plan_approval",
        planApproval: { ...work.planApproval, required: true, status: "pending", planId: taskState.planId } });
    }
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
  await writeJsonAtomic(resolveWildArrangePath(rootDir, "plans", `${taskState.planId}.json`), plan);
  await writeJsonAtomic(resolveWildArrangePath(rootDir, "team", "tasks.json"), nextLedger);
}

// --- 迁移与归档 ---

/** 归档任务证据并删除 taskState 条目（需 backupId）。 */
export async function archiveAndDeleteTeamTask(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `team-task-archive-delete:${options.taskId || "unknown"}`, async () => {
    const ledger = await loadTaskLedger(rootDir);
    if (!ledger) throw new Error("no task ledger found");
    validateLedgerTaskIdentities(ledger);
    if (options.planId) assertSafeStateId(options.planId, "planId");
    let task = resolveLedgerTask(ledger, options.taskId, options.planId);
    let archiveSource = "canonical_task_ledger";
    let legacyPlan = null;
    if (!task && options.planId) {
      const planIsIndexed = ledger.activePlanId === options.planId
        || (ledger.plans || []).some((plan) => plan.id === options.planId)
        || ledger.tasks.some((candidate) => candidate.planId === options.planId);
      if (!planIsIndexed) {
        legacyPlan = await readJson(resolveWildArrangePath(rootDir, "plans", `${options.planId}.json`), null);
        const matches = (legacyPlan?.tasks || []).filter((candidate) => candidate.id === options.taskId);
        if (matches.length === 1) {
          task = {
            ...matches[0],
            planId: options.planId,
            ref: `${options.planId}:${options.taskId}`,
          };
          archiveSource = "unindexed_legacy_plan";
        }
      }
    }
    if (!task) throw new Error(`unknown task: ${options.taskId}`);
    assertSafeStateId(task.planId, "task planId");
    assertSafeStateId(task.id, "task id");
    if (["in_progress", "verifying"].includes(task.status)) {
      throw new Error(`task ${task.ref || task.id} is ${task.status}; active work cannot be archived`);
    }
    const reason = typeof options.reason === "string" && options.reason.trim()
      ? options.reason.trim()
      : "user_archived";
    const at = nowIso();
    const remainingTasks = ledger.tasks.filter((candidate) =>
      candidate.planId !== task.planId || candidate.id !== task.id);
    const remainingLegacyTasks = archiveSource === "unindexed_legacy_plan"
      ? (legacyPlan?.tasks || []).filter((candidate) => candidate.id !== task.id)
      : [];
    const planHasTasks = archiveSource === "unindexed_legacy_plan"
      ? remainingLegacyTasks.length > 0
      : remainingTasks.some((candidate) => candidate.planId === task.planId);
    const remainingPlans = (ledger.plans || [])
      .filter((plan) => plan.id !== task.planId || planHasTasks)
      .map((plan) => plan.id === task.planId
        ? { ...plan, taskIds: remainingTasks.filter((candidate) => candidate.planId === plan.id).map((candidate) => candidate.id), updatedAt: at }
        : plan);
    // Removing the final task from the active Plan must fail closed. Another
    // Plan remains indexed, but only an explicit plan import/selection may
    // activate it and establish a fresh approval state.
    const activePlanId = ledger.activePlanId === task.planId && !planHasTasks
      ? null
      : ledger.activePlanId;
    const nextLedger = {
      ...ledger,
      planId: activePlanId,
      activePlanId,
      plans: remainingPlans,
      tasks: remainingTasks,
      updatedAt: at,
    };
    const workPath = resolveWildArrangePath(rootDir, "work.json");
    const work = await readJson(workPath, null);
    const nextWork = work
      ? {
        ...work,
        activePlanId,
        status: activePlanId ? work.status : "idle",
        stage: activePlanId ? work.stage : "initialized",
        planApproval: !activePlanId || work.planApproval?.planId === task.planId && !planHasTasks
          ? null
          : work.planApproval,
        updatedAt: at,
      }
      : null;

    const purgeCandidates = [
      resolveTaskCheckpointPath(rootDir, task.planId, task.id),
      resolveTaskAcceptancePath(rootDir, task.planId, task.id, "json"),
      resolveTaskAcceptancePath(rootDir, task.planId, task.id, "md"),
    ];
    const evidenceTasks = [
      ...ledger.tasks,
      ...(archiveSource === "unindexed_legacy_plan"
        ? (legacyPlan?.tasks || []).map((candidate) => ({ ...candidate, planId: task.planId }))
        : []),
    ];
    const targetLegacyStem = legacyTaskEvidenceStem(task.planId, task.id);
    const legacyStemCollides = evidenceTasks.some((candidate) =>
      (candidate.planId !== task.planId || candidate.id !== task.id)
      && legacyTaskEvidenceStem(candidate.planId, candidate.id) === targetLegacyStem);
    const legacyCheckpointPath = resolveLegacyTaskCheckpointPath(rootDir, task.planId, task.id);
    const legacyAcceptanceJsonPath = resolveLegacyTaskAcceptancePath(rootDir, task.planId, task.id, "json");
    const legacyAcceptanceMdPath = resolveLegacyTaskAcceptancePath(rootDir, task.planId, task.id, "md");
    const legacyCheckpoint = await readJson(legacyCheckpointPath, null);
    const legacyAcceptance = await readJson(legacyAcceptanceJsonPath, null);
    if (!legacyStemCollides || evidenceBelongsToTask(legacyCheckpoint, task)) {
      purgeCandidates.push(legacyCheckpointPath);
    }
    if (!legacyStemCollides || evidenceBelongsToTask(legacyAcceptance, task)) {
      purgeCandidates.push(legacyAcceptanceJsonPath, legacyAcceptanceMdPath);
    }
    const outboxDir = resolveWildArrangePath(rootDir, "team", "outbox");
    try {
      const outboxEntries = await readdir(outboxDir, { withFileTypes: true });
      const duplicateTaskIdRemains = remainingTasks.some((candidate) => candidate.id === task.id);
      for (const entry of outboxEntries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const claimPath = path.join(outboxDir, entry.name);
        const claim = await readJson(claimPath, null);
        const exactClaim = claim?.taskRef === task.ref;
        const unambiguousLegacyClaim = !claim?.taskRef
          && claim?.taskId === task.id
          && !duplicateTaskIdRemains;
        if (exactClaim || unambiguousLegacyClaim) purgeCandidates.push(claimPath);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!planHasTasks) purgeCandidates.push(resolveWildArrangePath(rootDir, "plans", `${task.planId}.json`));
    const tasksRemainingInSource = archiveSource === "unindexed_legacy_plan"
      ? remainingLegacyTasks
      : remainingTasks;
    for (const writablePath of task.writable_paths || []) {
      if (typeof writablePath !== "string" || /[*?\[\]]/.test(writablePath)) continue;
      const sharedByRemainingTask = tasksRemainingInSource.some((candidate) =>
        (candidate.writable_paths || []).includes(writablePath));
      if (sharedByRemainingTask) continue;
      const absolutePath = path.resolve(rootDir, writablePath);
      const artifactsRoot = `${resolveWildArrangePath(rootDir, "artifacts")}${path.sep}`;
      if (absolutePath.startsWith(artifactsRoot)) purgeCandidates.push(absolutePath);
    }

    const targetPlanPath = resolveWildArrangePath(rootDir, "plans", `${task.planId}.json`);
    const targetPlan = await readJson(targetPlanPath, null);
    const nextTargetPlan = planHasTasks
      ? {
        ...(targetPlan || remainingPlans.find((plan) => plan.id === task.planId) || { id: task.planId }),
        tasks: archiveSource === "unindexed_legacy_plan"
          ? remainingLegacyTasks
          : remainingTasks.filter((candidate) => candidate.planId === task.planId),
        updatedAt: at,
      }
      : null;
    let activePlanForMarkdown = null;
    if (activePlanId) {
      if (activePlanId === task.planId) {
        activePlanForMarkdown = nextTargetPlan;
      } else {
        assertSafeStateId(activePlanId, "active planId");
        const activePlan = await readJson(resolveWildArrangePath(rootDir, "plans", `${activePlanId}.json`), null);
        if (!activePlan) throw new Error(`active plan mirror not found: ${activePlanId}`);
        activePlanForMarkdown = {
          ...activePlan,
          tasks: remainingTasks.filter((candidate) => candidate.planId === activePlanId),
        };
      }
    }

    const canonicalPath = resolveWildArrangePath(rootDir, "team", "tasks.json");
    const tasksMarkdownPath = resolveWildArrangePath(rootDir, "team", "tasks.md");
    const transactionId = createWorkId("archive");
    const recovery = await prepareArchiveRecoveryPackage(rootDir, {
      backupId: options.backupId || null,
      transactionId,
      taskRef: task.ref,
      reason: `pre-task-archive:${task.ref}`,
      paths: [
        canonicalPath,
        tasksMarkdownPath,
        workPath,
        targetPlanPath,
        ...purgeCandidates,
      ],
    });
    const backupId = recovery.backupId;

    await appendLedger(rootDir, {
      type: "team_task_archive_requested",
      planId: task.planId,
      taskId: task.id,
      taskRef: task.ref,
      subject: task.subject,
      previousStatus: task.status,
      reason,
      backupId,
      archiveSource,
    });

    const projectionPaths = [canonicalPath, tasksMarkdownPath];
    if (nextWork) projectionPaths.push(workPath);
    if (nextTargetPlan) projectionPaths.push(targetPlanPath);
    const preimages = new Map();
    for (const projectionPath of projectionPaths) {
      preimages.set(projectionPath, await captureFilePreimage(projectionPath));
    }

    const stagingRoot = resolveWildArrangePath(rootDir, "archive-staging", transactionId);
    const staged = [];
    const deleted = [];
    try {
      await mkdir(stagingRoot, { recursive: true });
      const candidates = collapseNestedPaths(purgeCandidates);
      for (const [index, filePath] of candidates.entries()) {
        const stagedPath = path.join(stagingRoot, `${index}-${path.basename(filePath)}`);
        try {
          await rename(filePath, stagedPath);
          staged.push({ originalPath: filePath, stagedPath });
          deleted.push(normalizeRelativePath(path.relative(rootDir, filePath)));
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }

      if (nextTargetPlan) await writeJsonAtomic(targetPlanPath, nextTargetPlan);
      if (nextWork) await writeJsonAtomic(workPath, nextWork);
      if (activePlanForMarkdown) {
        await writeTasksMarkdown(rootDir, activePlanForMarkdown);
      } else {
        await writeFile(tasksMarkdownPath, "# WildArrange Tasks\n\nNo active tasks.\n", "utf8");
      }
      // Canonical authority is committed last. Any preceding mirror or purge
      // failure therefore leaves the task visible; later audit failure rolls
      // all projections and staged paths back to their captured preimages.
      await writeJsonAtomic(canonicalPath, nextLedger);

      await updateArchiveRecoveryPackage(rootDir, {
        backupId,
        transactionId,
        status: "committed",
      });
      await appendLedger(rootDir, {
        type: "team_task_archived_deleted",
        planId: task.planId,
        taskId: task.id,
        taskRef: task.ref,
        subject: task.subject,
        previousStatus: task.status,
        reason,
        backupId,
        archiveSource,
        deletedPaths: deleted,
      });
    } catch (error) {
      const recoveryErrors = [];
      for (const [projectionPath, preimage] of [...preimages.entries()].reverse()) {
        try {
          await restoreFilePreimage(projectionPath, preimage);
        } catch (recoveryError) {
          recoveryErrors.push(`${path.relative(rootDir, projectionPath)}: ${recoveryError.message}`);
        }
      }
      for (const entry of [...staged].reverse()) {
        try {
          await mkdir(path.dirname(entry.originalPath), { recursive: true });
          await rename(entry.stagedPath, entry.originalPath);
        } catch (recoveryError) {
          recoveryErrors.push(`${path.relative(rootDir, entry.originalPath)}: ${recoveryError.message}`);
        }
      }
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      await updateArchiveRecoveryPackage(rootDir, {
        backupId,
        transactionId,
        status: recoveryErrors.length > 0 ? "recovery_required" : "rolled_back",
        diagnostic: error.message,
      }).catch(() => {});
      if (recoveryErrors.length > 0) {
        throw new Error(`archive transaction failed: ${error.message}; recovery_required: ${recoveryErrors.join("; ")}`);
      }
      throw error;
    }
    // Cleanup happens after the authoritative commit and audit. A cleanup
    // failure leaves only a recoverable internal staging directory and must
    // not turn a successful archive into an ambiguous command failure.
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    return {
      kind: "team_task_archive_delete",
      status: "deleted",
      taskRef: task.ref,
      previousStatus: task.status,
      backupId,
      archiveSource,
      activePlanId,
      deletedPaths: deleted,
    };
  });
}

/** 在 ledger 中按 taskId/planId 解析任务引用。 */
function resolveLedgerTask(ledger, taskId, planId) {
  if (!taskId) return null;
  if (planId) {
    const matches = ledger.tasks.filter((task) =>
      task.planId === planId && (task.id === taskId || task.ref === taskId));
    return matches.length === 1 ? matches[0] : null;
  }
  const byRef = ledger.tasks.find((task) => task.ref === taskId);
  if (byRef) return byRef;
  const targetPlanId = ledger.activePlanId;
  const activeMatch = ledger.tasks.find((task) => task.planId === targetPlanId && task.id === taskId);
  if (activeMatch) return activeMatch;
  const matches = ledger.tasks.filter((task) => task.id === taskId);
  return matches.length === 1 ? matches[0] : null;
}

/** 断言 state ID segment 安全可用于路径。 */
function assertSafeStateId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a safe single-segment identifier`);
  }
}

/** 校验 ledger 内任务 identity 字段完整。 */
function validateLedgerTaskIdentities(ledger) {
  const pairs = new Set();
  const refs = new Set();
  for (const task of ledger.tasks || []) {
    assertSafeStateId(task.planId, "task planId");
    assertSafeStateId(task.id, "task id");
    const expectedRef = `${task.planId}:${task.id}`;
    if (task.ref !== expectedRef) {
      throw new Error(`invalid canonical task identity: expected ${expectedRef}, got ${task.ref || "missing ref"}`);
    }
    if (pairs.has(expectedRef) || refs.has(task.ref)) {
      throw new Error(`duplicate canonical task identity: ${expectedRef}`);
    }
    pairs.add(expectedRef);
    refs.add(task.ref);
  }
}

/** 折叠路径列表中的父子重复项。 */
function collapseNestedPaths(paths) {
  const normalized = [...new Set(paths.map((candidate) => path.resolve(candidate)))]
    .sort((left, right) => left.length - right.length);
  return normalized.filter((candidate, index) => !normalized.slice(0, index).some((parent) =>
    candidate.startsWith(`${parent}${path.sep}`)));
}

/** 判断 evidence 条目是否归属指定 task。 */
function evidenceBelongsToTask(evidence, task) {
  return evidence?.planId === task.planId && evidence?.taskId === task.id;
}

/** 捕获单文件 admission 回滚用 preimage。 */
async function captureFilePreimage(filePath) {
  try {
    return { exists: true, content: await readFile(filePath) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, content: null };
    throw error;
  }
}

/** 按 preimage 还原单文件内容或删除新建文件。 */
async function restoreFilePreimage(filePath, preimage) {
  if (!preimage.exists) {
    await rm(filePath, { recursive: true, force: true });
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, preimage.content);
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
  await writeJsonAtomic(resolveWildArrangePath(rootDir, "plans", `${planId}.json`), plan);
  await writeJsonAtomic(resolveWildArrangePath(rootDir, "team", "tasks.json"), {
    version: STATE_VERSION,
    kind: "task_ledger",
    planId,
    activePlanId: planId,
    plans: [{ id: planId, title: plan.title, objective: plan.objective, taskIds: [], createdAt: at, updatedAt: at }],
    tasks: [],
    createdAt: at,
    updatedAt: at,
  });
  const workPath = resolveWildArrangePath(rootDir, "work.json");
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

// --- 消息与 outbox ---

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

/** 发送团队消息并记入 messages 目录。 */
export async function sendTeamMessage(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
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
  const inboxPath = resolveWildArrangePath(rootDir, "team", "inbox", to, `${id}.json`);
  const outboxPath = resolveWildArrangePath(rootDir, "team", "outbox", from, `${id}.json`);
  await writeJsonAtomic(inboxPath, message);
  await writeJsonAtomic(outboxPath, message);
  await appendTeamMessageIndex(rootDir, message);
  await appendLedger(rootDir, { type: "team_message_sent", messageId: id, from, to, summary: message.summary });
  return {
    ...message,
    inboxPath: normalizeRelativePath(path.relative(rootDir, inboxPath)),
    outboxPath: normalizeRelativePath(path.relative(rootDir, outboxPath)),
  };
}

/** 规范化 agent 显示名为 registry key。 */
export function normalizeAgentName(value) {
  return normalizeAgentKey(value);
}

/** 向 team 消息索引追加一条 outbox 记录。 */
async function appendTeamMessageIndex(rootDir, message) {
  const line = `- ${message.at} ${message.from} -> ${message.to}: ${message.summary} (${message.id})\n`;
  await appendFile(resolveWildArrangePath(rootDir, "team", "messages.md"), line, "utf8");
}

/** 列出团队消息历史。 */
export async function listTeamMessages(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const agent = normalizeAgentName(options.agent || options.to);
  const baseDir = agent ? resolveWildArrangePath(rootDir, "team", "inbox", agent) : resolveWildArrangePath(rootDir, "team", "inbox");
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

/** 读取目录，不存在时返回空数组而非抛错。 */
async function safeReadDir(dirPath, options = undefined) {
  try {
    return await readdir(dirPath, options);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}
