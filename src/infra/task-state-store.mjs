/**
 * `.helix/team/tasks.json` is the single project-wide task ledger. Runtime
 * consumers still need an active-plan projection, so this infra owner exposes
 * both views without making capabilities depend on orchestration.
 *
 * Legacy files used `{ planId, tasks }`. They are normalized in memory and are
 * migrated the next time orchestration persists/imports a plan.
 */
import {
  STATE_VERSION,
  readJson,
  resolveHelixPath,
} from "./runtime-store.mjs";

export async function loadTaskLedger(rootDir) {
  const raw = await readJson(resolveHelixPath(rootDir, "team", "tasks.json"), null);
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
  const activePlanId = raw.activePlanId || raw.planId || null;
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.map((task) => withLegacyTrace(
      withTaskIdentity(task, task.planId || activePlanId),
      raw.updatedAt,
    ))
    : [];
  const plans = Array.isArray(raw.plans) ? raw.plans.map((plan) => ({ ...plan })) : inferPlans(tasks, activePlanId);
  return {
    version: raw.version || STATE_VERSION,
    kind: "task_ledger",
    planId: activePlanId,
    activePlanId,
    plans,
    tasks,
    createdAt: raw.createdAt || raw.updatedAt || null,
    updatedAt: raw.updatedAt || null,
  };
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
