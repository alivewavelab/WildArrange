/**
 * `.wildarrange/team/tasks.json` is the single project-wide task ledger. Runtime
 * consumers still need an active-plan projection, so this infra owner exposes
 * both views without making capabilities depend on orchestration.
 *
 * Legacy files used `{ planId, tasks }`. They are normalized in memory and are
 * migrated the next time orchestration persists/imports a plan.
 */
import {
  STATE_VERSION,
  readJson,
  resolveWildArrangePath,
} from "./runtime-store.mjs";
import { normalizeAgentKey } from "./agent-registry.mjs";

export async function loadTaskLedger(rootDir) {
  const raw = await readJson(resolveWildArrangePath(rootDir, "team", "tasks.json"), null);
  if (!raw) return null;
  return normalizeTaskLedger(raw);
}

export async function loadTaskState(rootDir, options = {}) {
  const ledger = await loadTaskLedger(rootDir);
  if (!ledger) return null;
  const planId = options.planId || ledger.activePlanId || ledger.planId || null;
  if (!planId) return null;
  return {
    version: ledger.version,
    planId,
    tasks: ledger.tasks.filter((task) => task.planId === planId),
    updatedAt: ledger.updatedAt,
  };
}

export function normalizeTaskLedger(raw) {
  assertSupportedTaskLedger(raw);
  const activePlanId = raw.activePlanId || raw.planId || null;
  const legacyLedger = raw.kind !== "task_ledger" || !raw.activePlanId;
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.map((task) => normalizeStoredTask(task, activePlanId, raw.updatedAt, legacyLedger))
    : [];
  const plans = Array.isArray(raw.plans) ? raw.plans.map((plan) => ({ ...plan })) : inferPlans(tasks, activePlanId);
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

function normalizeStoredTask(task, activePlanId, fallbackAt, legacyLedger) {
  const planId = task.planId || activePlanId;
  const legacyTask = legacyLedger || !task.planId || !task.ref || !Array.isArray(task.history);
  let normalized = withTaskIdentity(task, planId);
  const owner = normalizeAgentKey(normalized.owner);
  if (owner) normalized = { ...normalized, owner };
  normalized = withLegacyTrace(normalized, fallbackAt);
  if (legacyTask && normalized.status === "completed") {
    const at = normalized.updatedAt || fallbackAt || null;
    normalized = {
      ...normalized,
      status: "needs_user_decision",
      completionRevalidation: {
        required: true,
        reason: "legacy_completed_without_current_proof_chain",
        previousStatus: "completed",
        detectedAt: at,
      },
      history: [
        ...(normalized.history || []),
        {
          at,
          event: "legacy_completion_requires_revalidation",
          from: "completed",
          to: "needs_user_decision",
        },
      ],
    };
  }
  return normalized;
}

function withLegacyTrace(task, fallbackAt) {
  if (Array.isArray(task.history) && task.history.length > 0) return task;
  return {
    ...task,
    history: [{
      at: task.createdAt || fallbackAt || null,
      event: "legacy_imported",
      status: task.status || null,
      source: task.source || "imported",
    }],
  };
}

export function taskRef(planId, taskId) {
  return `${planId}:${taskId}`;
}

export function withTaskIdentity(task, planId) {
  if (!planId) return { ...task };
  return {
    ...task,
    planId,
    ref: task.ref || taskRef(planId, task.id),
  };
}

function inferPlans(tasks, activePlanId) {
  const ids = [...new Set(tasks.map((task) => task.planId).filter(Boolean))];
  if (activePlanId && !ids.includes(activePlanId)) ids.push(activePlanId);
  return ids.map((id) => ({
    id,
    title: id,
    objective: "",
    taskIds: tasks.filter((task) => task.planId === id).map((task) => task.id),
  }));
}
