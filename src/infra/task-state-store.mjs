// =============================================================================
// 文件名称：task-state-store.mjs
// 所属模块：infra
// 作用说明：
//   plan 级 task-state.json 读写与任务列表 CRUD。
//
// 【运行原理速读】
//   loadTaskState → transact 写 → 版本与 planId 校验。
// =============================================================================
/**
 * `runtime:team/tasks.json` is the single project-wide task ledger. Runtime
 * consumers still need an active-plan projection, so this infra owner exposes
 * both views without making capabilities depend on orchestration.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

import {
  STATE_VERSION,
  readJson,
  resolveTaskAcceptancePath,
  resolveTaskCheckpointPath,
  resolveWildArrangePath,
} from "./runtime-store.mjs";
import { normalizeAgentKey } from "./agent-registry.mjs";
import { readVerifiedLedgerEntries } from "./ledger.mjs";

/**
 * loadTaskLedger：本模块对外异步 API。
 */
export async function loadTaskLedger(rootDir) {
  const raw = await readJson(resolveWildArrangePath(rootDir, "team", "tasks.json"), null);
  if (!raw) return null;
  return normalizeTaskLedger(raw);
}

/**
 * loadTaskState：本模块对外异步 API。
 */
export async function loadTaskState(rootDir, options = {}) {
  return taskStateFromLedger(await loadTaskLedger(rootDir), options);
}

/**
 * 从已加载的总账投影出指定（默认 active）计划的 taskState；调用方已持有总账时避免重复读盘。
 */
export function taskStateFromLedger(ledger, options = {}) {
  if (!ledger) return null;
  const planId = options.planId || ledger.activePlanId || ledger.planId || null;
  if (!planId) return null;
  const plan = ledger.plans.find((candidate) => candidate.id === planId) || null;
  return {
    version: ledger.version,
    planId,
    governance_binding: plan?.governance_binding || null,
    tasks: ledger.tasks.filter((task) => task.planId === planId),
    updatedAt: ledger.updatedAt,
  };
}

/**
 * 用 tasks 替换总账中某个计划的全部任务，并同步该计划的索引条目（总账是任务状态唯一可写处）。
 * 索引条目在已有条目上覆盖 title/objective/governance_binding（plan 中显式给出时）与 taskIds；
 * activate 为 true 时把该计划设为 active。返回新总账，不写盘。
 */
export function replacePlanTasks(ledger, plan, tasks, { at, activate = false } = {}) {
  const previous = (ledger?.plans || []).find((candidate) => candidate.id === plan.id) || null;
  const entry = {
    ...previous,
    id: plan.id,
    title: plan.title ?? previous?.title,
    objective: plan.objective ?? previous?.objective,
    governance_binding: Object.hasOwn(plan, "governance_binding")
      ? plan.governance_binding
      : previous?.governance_binding ?? null,
    taskIds: tasks.map((task) => task.id),
    createdAt: previous?.createdAt || plan.createdAt || at,
    updatedAt: at,
  };
  const activePlanId = activate ? plan.id : ledger?.activePlanId || plan.id;
  return {
    version: STATE_VERSION,
    kind: "task_ledger",
    planId: activePlanId,
    activePlanId,
    plans: [...(ledger?.plans || []).filter((candidate) => candidate.id !== plan.id), entry],
    tasks: [...(ledger?.tasks || []).filter((task) => task.planId !== plan.id), ...tasks],
    createdAt: ledger?.createdAt || at,
    updatedAt: at,
  };
}

/**
 * Read-only technical integrity check for tasks already marked completed.
 * It reports evidence facts; callers decide how those facts affect workflow or UI.
 */
export async function inspectCompletedTaskEvidence(rootDir, taskState, options = {}) {
  if (!taskState) return { checked: 0, invalid: [] };
  const gitProject = options.gitProject ?? await pathExists(path.join(rootDir, ".git"));
  const ledgerEntries = options.ledgerEntries || await readVerifiedLedgerEntries(rootDir);
  const completionEvents = new Set(ledgerEntries
    .filter((entry) => ["task_verified", "node_checkpoint_completed", "parallel_agent_admission_completed"].includes(entry.type))
    .filter((entry) => entry.planId && entry.taskId)
    .map((entry) => `${entry.planId}:${entry.taskId}`));
  const completedTasks = (taskState.tasks || []).filter((task) => task.status === "completed");
  const invalid = [];
  for (const task of completedTasks) {
    const planId = task.planId || taskState.planId || taskState.activePlanId;
    const ref = `${planId}:${task.id}`;
    const proof = await readTaskEvidenceJson(rootDir, "acceptance", planId, task.id);
    const checkpoint = await readTaskEvidenceJson(rootDir, "checkpoint", planId, task.id);
    const failures = [];
    if (proof?.kind !== "acceptance_proof" || proof.pass !== true || proof.planId !== planId || proof.taskId !== task.id) failures.push("acceptance_proof");
    if (checkpoint?.planId !== planId || checkpoint?.taskId !== task.id) failures.push("checkpoint_identity");
    if (checkpoint?.verifyResult?.pass !== true) failures.push("verifier");
    if (checkpoint?.scopeResult?.status !== "pass") failures.push("scope");
    if (checkpoint?.reviewResult?.pass !== true) failures.push("review");
    if (!completionEvents.has(ref)) failures.push("ledger_event");
    const proofDelivery = proof?.evidenceRefs?.deliveryBaseline || null;
    const checkpointDelivery = checkpoint?.deliveryBaseline || null;
    const deliveryCandidates = [
      rawDeliveryCommitSha(proofDelivery),
      rawDeliveryCommitSha(checkpointDelivery),
      rawDeliveryCommitSha(task.delivery),
      rawDeliveryCommitSha(task.delivery_workspace),
    ].filter(Boolean);
    if (deliveryCandidates.some((sha) => !isGitCommitSha(sha))) failures.push("delivery_commit_invalid");
    const proofSha = deliveryCommitSha(proofDelivery);
    const checkpointSha = deliveryCommitSha(checkpointDelivery);
    const taskDeliverySha = deliveryCommitSha(task.delivery) || deliveryCommitSha(task.delivery_workspace);
    const requiresDeliverySha = gitProject
      || hasGitDeliveryEvidence(task.delivery)
      || hasGitDeliveryEvidence(task.delivery_workspace)
      || hasGitDeliveryEvidence(proofDelivery)
      || hasGitDeliveryEvidence(checkpointDelivery);
    if (requiresDeliverySha && (!proofSha || !checkpointSha)) failures.push("delivery_commit_missing");
    const deliveryMismatch = (proofSha && checkpointSha && proofSha !== checkpointSha)
      || (taskDeliverySha && (proofSha !== taskDeliverySha || checkpointSha !== taskDeliverySha));
    if (deliveryMismatch) failures.push("delivery_commit_mismatch");
    if (failures.length > 0) invalid.push({
      taskId: task.id,
      taskRef: ref,
      planId,
      failures,
      proofPresent: Boolean(proof),
      checkpointPresent: Boolean(checkpoint),
      proofSha,
      checkpointSha,
      taskDeliverySha,
    });
  }
  return { checked: completedTasks.length, invalid };
}

/**
 * pathExists 内部辅助。
 */
async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * 读取 TaskEvidenceJson 并返回结构化结果。
 */
async function readTaskEvidenceJson(rootDir, kind, planId, taskId) {
  const canonicalPath = kind === "checkpoint"
    ? resolveTaskCheckpointPath(rootDir, planId, taskId)
    : resolveTaskAcceptancePath(rootDir, planId, taskId, "json");
  return readJson(canonicalPath, null);
}

/**
 * deliveryCommitSha 内部辅助。
 */
function deliveryCommitSha(delivery) {
  const sha = rawDeliveryCommitSha(delivery);
  return isGitCommitSha(sha) ? sha.toLowerCase() : null;
}

/**
 * rawDeliveryCommitSha 内部辅助。
 */
function rawDeliveryCommitSha(delivery) {
  return delivery?.commitSha || delivery?.deliverySha || delivery?.integrationSha || delivery?.actualSha || null;
}

/**
 * 判断 isGitCommitSha 条件。
 */
function isGitCommitSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

/**
 * 判断 hasGitDeliveryEvidence 条件。
 */
function hasGitDeliveryEvidence(delivery) {
  if (!delivery) return false;
  return Boolean(deliveryCommitSha(delivery))
    || delivery.active === true
    || delivery.noChange === true
    || ["no_change", "committed_local", "pushed"].includes(delivery.status);
}

/**
 * normalizeTaskLedger：本模块对外API。
 */
export function normalizeTaskLedger(raw) {
  assertSupportedTaskLedger(raw);
  const activePlanId = raw.activePlanId || null;
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.map((task) => normalizeStoredTask(task, activePlanId))
    : [];
  const plans = Array.isArray(raw.plans) ? raw.plans.map((plan) => ({ ...plan })) : [];
  return {
    version: STATE_VERSION,
    kind: "task_ledger",
    planId: activePlanId,
    activePlanId,
    plans,
    tasks,
    createdAt: raw.createdAt || raw.updatedAt || null,
    updatedAt: raw.updatedAt || null,
  };
}

/**
 * 断言 SupportedTaskLedger 条件，不满足则抛错。
 */
function assertSupportedTaskLedger(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("task ledger must be a JSON object");
  }
  const version = raw.version === undefined ? STATE_VERSION : Number(raw.version);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`invalid task ledger version: ${raw.version}`);
  }
  if (version > STATE_VERSION) {
    throw new Error(`task ledger version ${version} is newer than supported version ${STATE_VERSION}; upgrade WildArrange before reading it`);
  }
  if (raw.kind !== undefined && raw.kind !== "task_ledger") {
    throw new Error(`unsupported task ledger kind: ${raw.kind}`);
  }
  if (raw.tasks !== undefined && !Array.isArray(raw.tasks)) {
    throw new Error("task ledger tasks must be an array");
  }
}

/**
 * 归一化 StoredTask 输入为稳定形态。
 */
function normalizeStoredTask(task, activePlanId) {
  const planId = task.planId || activePlanId;
  const normalized = withTaskIdentity(task, planId);
  const owner = normalizeAgentKey(normalized.owner);
  return owner ? { ...normalized, owner } : normalized;
}

/**
 * taskRef：本模块对外API。
 */
export function taskRef(planId, taskId) {
  return `${planId}:${taskId}`;
}

/**
 * withTaskIdentity：本模块对外API。
 */
export function withTaskIdentity(task, planId) {
  if (!planId) return { ...task };
  return {
    ...task,
    planId,
    ref: task.ref || taskRef(planId, task.id),
  };
}

/** 在总账中按 taskId（或 ref）/planId 解析唯一任务；有歧义返回 null。 */
export function resolveLedgerTask(ledger, taskId, planId) {
  if (!taskId) return null;
  if (planId) {
    const matches = ledger.tasks.filter((task) =>
      task.planId === planId && (task.id === taskId || task.ref === taskId));
    return matches.length === 1 ? matches[0] : null;
  }
  const byRef = ledger.tasks.find((task) => task.ref === taskId);
  if (byRef) return byRef;
  const activeMatch = ledger.tasks.find((task) => task.planId === ledger.activePlanId && task.id === taskId);
  if (activeMatch) return activeMatch;
  const matches = ledger.tasks.filter((task) => task.id === taskId);
  return matches.length === 1 ? matches[0] : null;
}
