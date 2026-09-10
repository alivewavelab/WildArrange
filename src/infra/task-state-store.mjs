/**
 * `.wildarrange/team/tasks.json` is the single project-wide task ledger. Runtime
 * consumers still need an active-plan projection, so this infra owner exposes
 * both views without making capabilities depend on orchestration.
 *
 * Legacy files used `{ planId, tasks }`. They are normalized in memory and are
 * migrated the next time orchestration persists/imports a plan.
 */
import { stat } from "node:fs/promises";
import path from "node:path";

import {
  STATE_VERSION,
  readJson,
  resolveLegacyTaskAcceptancePath,
  resolveLegacyTaskCheckpointPath,
  resolveTaskAcceptancePath,
  resolveTaskCheckpointPath,
  resolveWildArrangePath,
} from "./runtime-store.mjs";
import { normalizeAgentKey } from "./agent-registry.mjs";
import { readVerifiedLedgerEntries } from "./ledger.mjs";

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

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readTaskEvidenceJson(rootDir, kind, planId, taskId) {
  const canonicalPath = kind === "checkpoint"
    ? resolveTaskCheckpointPath(rootDir, planId, taskId)
    : resolveTaskAcceptancePath(rootDir, planId, taskId, "json");
  const canonical = await readJson(canonicalPath, null);
  if (canonical) return canonical;
  const legacyPath = kind === "checkpoint"
    ? resolveLegacyTaskCheckpointPath(rootDir, planId, taskId)
    : resolveLegacyTaskAcceptancePath(rootDir, planId, taskId, "json");
  const legacy = await readJson(legacyPath, null);
  return legacy?.planId === planId && legacy?.taskId === taskId ? legacy : null;
}

function deliveryCommitSha(delivery) {
  const sha = rawDeliveryCommitSha(delivery);
  return isGitCommitSha(sha) ? sha.toLowerCase() : null;
}

function rawDeliveryCommitSha(delivery) {
  return delivery?.commitSha || delivery?.integrationSha || delivery?.actualSha || null;
}

function isGitCommitSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function hasGitDeliveryEvidence(delivery) {
  if (!delivery) return false;
  return Boolean(deliveryCommitSha(delivery))
    || delivery.active === true
    || delivery.noChange === true
    || ["no_change", "committed_local", "pushed"].includes(delivery.status);
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
