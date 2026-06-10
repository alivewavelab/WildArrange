import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  appendLedger,
  ensureHelixDirs,
  initRuntime,
  nowIso,
  readJson,
  resolveHelixPath,
  withTaskStateLock,
  writeJsonAtomic,
  writeSnapshot,
} from "./helix-foundation.mjs";
import { installAdapter, uninstallAdapter } from "./helix-adapters.mjs";
import { routeRequest } from "./helix-routing.mjs";
import { runReviewGate, runWorker } from "./helix-review.mjs";
import { statusReport, writeWorkflowSummary } from "./helix-status.mjs";
import {
  importPlan,
  loadTaskState,
  normalizeStringArray,
  normalizeSuccessCriteria,
  normalizeTask,
  validatePlanGraph,
} from "./helix-plan.mjs";
import {
  applyVerifierEvidenceToCriteria,
  claimTeamTask,
  createTeamTask,
  criteriaStatus,
  findRunnableTask,
  getTeamTask,
  listTeamMessages,
  listTeamTasks,
  persistTaskState,
  recordTaskEvidence,
  sendTeamMessage,
  writeOutbox,
} from "./helix-team.mjs";
import {
  appendWisdom,
  changedPathsIntroducedByTask,
  collectGitChangedPaths,
  collectGitDiff,
  listChangeRequests,
  renderChangeRequestMarkdown,
  runVerifier,
  scopeGuard,
  writeChangeRequest,
  writeCheckpoint,
  writeFailureReport,
  writeOpenChangesIndex,
  writeReviewReport,
} from "./helix-gates.mjs";

export {
  DEFAULT_HELIX_CONFIG,
  DEFAULT_PROMPT_PACK_DIR,
  HELIX_CONFIG_FILE,
  HELIX_DIR,
  STATE_VERSION,
  TASK_STATUSES,
  appendLedger,
  createWorkId,
  ensureHelixDirs,
  hashContent,
  initRuntime,
  installPromptPack,
  listPromptPack,
  loadPromptPackEntries,
  loadHelixConfig,
  nowIso,
  readJson,
  renderPromptPackEntry,
  resolveHelixPath,
  withTaskStateLock,
  writeDefaultHelixConfig,
  writeJsonAtomic,
  writeSnapshot,
} from "./helix-foundation.mjs";
export { installAdapter, uninstallAdapter } from "./helix-adapters.mjs";
export { loadRoutesConfig, resolveRouteDecision, routeRequest } from "./helix-routing.mjs";
export { scanProjectRules } from "./helix-rules.mjs";
export { runReviewGate, runWorker } from "./helix-review.mjs";
export { buildAgentContext, continuationDirective, recordRuntimeSession, resumeReport, writeContextSnapshot } from "./helix-context.mjs";
export { preToolUseGuard, runInjectionHook } from "./helix-hooks.mjs";
export { resolveInjectionPoint } from "./helix-injection.mjs";
export { dashboardData, statusReport, writeWorkflowSummary } from "./helix-status.mjs";
export {
  enrichPlanWithRoutes,
  enrichTaskWithRouteDecision,
  importPlan,
  loadTaskState,
  normalizePlan,
  normalizeStringArray,
  normalizeSuccessCriteria,
  normalizeTask,
  validatePlanGraph,
  validateStatus,
  writeTasksMarkdown,
} from "./helix-plan.mjs";
export {
  applyVerifierEvidenceToCriteria,
  claimTeamTask,
  createTeamTask,
  criteriaStatus,
  findRunnableTask,
  getTeamTask,
  listTeamMessages,
  listTeamTasks,
  normalizeAgentName,
  persistTaskState,
  recordTaskEvidence,
  sendTeamMessage,
  writeOutbox,
} from "./helix-team.mjs";
export {
  appendWisdom,
  changedPathsIntroducedByTask,
  collectGitChangedPaths,
  collectGitDiff,
  listChangeRequests,
  pathAllowed,
  pathMatchesPattern,
  runCommand,
  runVerifier,
  scopeGuard,
  writeChangeRequest,
  writeCheckpoint,
  writeFailureReport,
  writeReviewReport,
} from "./helix-gates.mjs";
export async function steerWorkflow(rootDir, proposal = {}) {
  return withTaskStateLock(rootDir, `steer:${proposal.kind || "unknown"}`, async () => {
    await ensureHelixDirs(rootDir);
    const taskState = await loadTaskState(rootDir);
    if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
    const audit = validateSteeringProposal(taskState, proposal);
    if (!audit.invariant.accepted) {
      await appendLedger(rootDir, { type: "steering_rejected", kind: audit.kind, reasons: audit.invariant.rejectedReasons });
      return { accepted: false, audit, taskState };
    }
    const before = structuredClone(taskState);
    const result = applySteeringProposal(taskState, proposal);
    validatePlanGraph({ tasks: taskState.tasks });
    validateTaskAcceptanceInvariants(taskState.tasks);
    await persistTaskState(rootDir, taskState);
    audit.before = summarizeSteeringState(before);
    audit.after = summarizeSteeringState(taskState);
    await appendLedger(rootDir, { type: "steering_applied", kind: audit.kind, targetTaskIds: audit.targetTaskIds, evidence: audit.evidence });
    await writeSnapshot(rootDir, "steering_applied", { kind: audit.kind, targetTaskIds: audit.targetTaskIds });
    return { accepted: true, audit, result, taskState };
  });
}

function validateSteeringProposal(taskState, proposal) {
  const reasons = [];
  if (!proposal || typeof proposal !== "object") reasons.push("proposal must be an object");
  const kind = proposal?.kind;
  const allowedKinds = ["add_task", "split_task", "reorder_pending", "revise_acceptance", "mark_blocked"];
  if (!allowedKinds.includes(kind)) reasons.push(`invalid kind: ${String(kind)}`);
  const evidence = typeof proposal?.evidence === "string" ? proposal.evidence.trim() : "";
  const rationale = typeof proposal?.rationale === "string" ? proposal.rationale.trim() : "";
  if (!evidence) reasons.push("missing evidence");
  if (!rationale) reasons.push("missing rationale");
  const proposalText = JSON.stringify(proposal || {});
  if (hasWeakeningLanguage(proposalText)) reasons.push("weakened completion");
  if (proposalText.match(/completedAt|completionStatus|autoComplete|mark complete/i)) reasons.push("protected completion payload");
  const targetTaskIds = proposal?.targetTaskIds || (proposal?.targetTaskId ? [proposal.targetTaskId] : proposal?.taskId ? [proposal.taskId] : []);
  if ((kind === "split_task" || kind === "revise_acceptance" || kind === "mark_blocked") && targetTaskIds.length === 0) reasons.push(`${kind} requires targetTaskId`);
  const targets = targetTaskIds.map((id) => taskState.tasks.find((task) => task.id === id));
  if (targets.some((task) => !task)) reasons.push("unknown target task");
  if ((kind === "split_task" || kind === "revise_acceptance") && targets.some((task) => task && task.status !== "pending")) reasons.push(`${kind} only applies to pending tasks`);
  if (kind === "add_task" && (!proposal.task || typeof proposal.task !== "object")) reasons.push("add_task requires task object");
  if (kind === "split_task" && (!Array.isArray(proposal.tasks) || proposal.tasks.length === 0)) reasons.push("split_task requires tasks array");
  if (kind === "revise_acceptance") {
    for (const target of targets.filter(Boolean)) {
      reasons.push(...validateAcceptanceRevisionStrength(target, proposal));
    }
  }
  if (kind === "reorder_pending") {
    const pendingOrder = Array.isArray(proposal.pendingOrder) ? proposal.pendingOrder : [];
    const pendingIds = taskState.tasks.filter((task) => task.status === "pending").map((task) => task.id);
    if (pendingOrder.length === 0) reasons.push("reorder_pending requires pendingOrder");
    if (new Set(pendingOrder).size !== pendingOrder.length) reasons.push("duplicate pending id");
    if (pendingOrder.some((id) => !pendingIds.includes(id))) reasons.push("unknown pending id");
  }
  return {
    kind: allowedKinds.includes(kind) ? kind : "invalid",
    at: nowIso(),
    source: proposal.source || "cli",
    evidence,
    rationale,
    targetTaskIds,
    invariant: {
      accepted: reasons.length === 0,
      evidenceBackedNecessity: evidence.length > 0 && rationale.length > 0,
      noWeakenedCompletion: !hasWeakeningLanguage(proposalText),
      structuralInvariantAccepted: reasons.length === 0,
      rejectedReasons: reasons,
    },
  };
}

function validateAcceptanceRevisionStrength(target, proposal) {
  const reasons = [];
  for (const [field, label] of [
    ["verify_commands", "verify_commands"],
    ["review_commands", "review_commands"],
    ["standards_commands", "standards_commands"],
  ]) {
    if (!Array.isArray(proposal[field])) continue;
    const next = normalizeStringArray(proposal[field], `task ${target.id} ${label}`);
    if (field === "verify_commands" && next.length === 0) {
      reasons.push("verify_commands cannot be empty");
    }
    const removed = (target[field] || []).filter((command) => !next.includes(command));
    if (removed.length > 0) {
      reasons.push(`${label} cannot remove existing gate command(s): ${removed.join(", ")}`);
    }
  }

  if (Array.isArray(proposal.successCriteria)) {
    const nextCriteria = normalizeSuccessCriteria(proposal.successCriteria, target.id, target.subject, target.verify_commands);
    const nextIds = new Set(nextCriteria.map((criterion) => criterion.id));
    const removedCriteria = (target.successCriteria || []).filter((criterion) => !nextIds.has(criterion.id));
    if (removedCriteria.length > 0) {
      reasons.push(`successCriteria cannot remove existing criterion id(s): ${removedCriteria.map((criterion) => criterion.id).join(", ")}`);
    }
  }
  return reasons;
}

function validateTaskAcceptanceInvariants(tasks) {
  for (const task of tasks) {
    if (!Array.isArray(task.verify_commands) || task.verify_commands.length === 0) {
      throw new Error(`task ${task.id} requires at least one verify command`);
    }
  }
}

function applySteeringProposal(taskState, proposal) {
  const planDefaults = {};
  if (proposal.kind === "add_task") {
    const task = normalizeTask(proposal.task, taskState.tasks.length, planDefaults);
    task.steering = steeringStamp(proposal);
    taskState.tasks.push(task);
    return { task };
  }
  if (proposal.kind === "split_task") {
    const target = taskState.tasks.find((task) => task.id === (proposal.targetTaskId || proposal.taskId));
    target.status = "review_blocked";
    target.steeringStatus = "superseded";
    target.steering = steeringStamp(proposal);
    const created = proposal.tasks.map((rawTask, index) => {
      const task = normalizeTask({ blockedBy: [], ...rawTask }, taskState.tasks.length + index, planDefaults);
      task.supersedes = [target.id];
      task.steering = steeringStamp(proposal);
      return task;
    });
    target.supersededBy = created.map((task) => task.id);
    taskState.tasks.splice(taskState.tasks.indexOf(target) + 1, 0, ...created);
    return { blockedTask: target, created };
  }
  if (proposal.kind === "reorder_pending") {
    const order = proposal.pendingOrder;
    const ordered = order.map((id) => taskState.tasks.find((task) => task.id === id)).filter(Boolean);
    const rest = taskState.tasks.filter((task) => !order.includes(task.id));
    taskState.tasks = [...ordered, ...rest];
    return { order };
  }
  if (proposal.kind === "revise_acceptance") {
    const target = taskState.tasks.find((task) => task.id === (proposal.targetTaskId || proposal.taskId));
    if (Array.isArray(proposal.verify_commands)) target.verify_commands = normalizeStringArray(proposal.verify_commands, `task ${target.id} verify_commands`);
    if (Array.isArray(proposal.review_commands)) target.review_commands = normalizeStringArray(proposal.review_commands, `task ${target.id} review_commands`);
    if (Array.isArray(proposal.standards_commands)) target.standards_commands = normalizeStringArray(proposal.standards_commands, `task ${target.id} standards_commands`);
    if (Array.isArray(proposal.successCriteria)) target.successCriteria = normalizeSuccessCriteria(proposal.successCriteria, target.id, target.subject, target.verify_commands);
    target.steering = steeringStamp(proposal);
    target.updatedAt = nowIso();
    return { task: target };
  }
  if (proposal.kind === "mark_blocked") {
    const target = taskState.tasks.find((task) => task.id === (proposal.targetTaskId || proposal.taskId));
    target.status = "needs_user_decision";
    target.blockedReason = proposal.blockedReason || proposal.rationale;
    target.steering = steeringStamp(proposal);
    target.updatedAt = nowIso();
    return { task: target };
  }
  return {};
}

function steeringStamp(proposal) {
  return {
    kind: proposal.kind,
    source: proposal.source || "cli",
    evidence: proposal.evidence,
    rationale: proposal.rationale,
    at: nowIso(),
  };
}

function summarizeSteeringState(taskState) {
  return {
    planId: taskState.planId,
    tasks: taskState.tasks.map((task) => ({ id: task.id, status: task.status, subject: task.subject, blockedBy: task.blockedBy || [] })),
  };
}

export async function recordReviewBlocker(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `review-blocker:${options.taskId || "unknown"}`, async () => {
    await ensureHelixDirs(rootDir);
    const taskState = await loadTaskState(rootDir);
    if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
    const task = taskState.tasks.find((candidate) => candidate.id === options.taskId);
    if (!task) throw new Error(`unknown task: ${options.taskId}`);
    if (!["verifying", "failed", "in_progress"].includes(task.status)) throw new Error(`task ${task.id} is ${task.status}; cannot record review blocker`);
    const evidence = typeof options.evidence === "string" ? options.evidence.trim() : "";
    const rationale = typeof options.rationale === "string" ? options.rationale.trim() : "";
    if (!evidence) throw new Error("review blocker evidence is required");
    if (!rationale) throw new Error("review blocker rationale is required");
    if (hasWeakeningLanguage(`${evidence}\n${rationale}`)) throw new Error("review blocker appears to weaken verification");
    const blockerTask = normalizeTask({
      id: options.newTaskId || nextTaskId(taskState.tasks),
      subject: options.title || `Resolve review blocker for ${task.id}`,
      description: options.objective || rationale,
      worker_command: options.worker_command || "node -e \"process.exit(0)\"",
      verify_commands: options.verify_commands || task.verify_commands,
      review_commands: options.review_commands || task.review_commands || [],
      standards_commands: options.standards_commands || task.standards_commands || [],
      writable_paths: options.writable_paths || task.writable_paths || [],
    }, taskState.tasks.length, {});
    blockerTask.reviewBlockerFor = task.id;
    blockerTask.steering = { kind: "review_blocker_resolution", evidence, rationale, at: nowIso() };
    task.status = "review_blocked";
    task.reviewBlockedAt = nowIso();
    task.reviewBlocker = { evidence, rationale, resolutionTaskId: blockerTask.id };
    task.updatedAt = nowIso();
    taskState.tasks.push(blockerTask);
    validatePlanGraph({ tasks: taskState.tasks });
    await persistTaskState(rootDir, taskState);
    await appendLedger(rootDir, { type: "review_blocker_recorded", planId: taskState.planId, taskId: task.id, resolutionTaskId: blockerTask.id, evidence });
    await writeSnapshot(rootDir, "review_blocker_recorded", { planId: taskState.planId, taskId: task.id, resolutionTaskId: blockerTask.id });
    return { planId: taskState.planId, blockedTask: task, resolutionTask: blockerTask };
  });
}

function nextTaskId(tasks) {
  const max = tasks.reduce((current, task) => {
    const match = /^T(\d+)$/.exec(task.id);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `T${String(max + 1).padStart(3, "0")}`;
}

export async function runNextTask(rootDir, options = {}) {
  return withTaskStateLock(rootDir, "run-next-task", () => runNextTaskUnlocked(rootDir, options));
}

async function runNextTaskUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");

  const task = findRunnableTask(taskState.tasks);
  if (!task) {
    const unfinished = taskState.tasks.filter((candidate) => candidate.status !== "completed");
    const status = unfinished.length === 0 ? "complete" : "blocked";
    await appendLedger(rootDir, { type: "run_idle", status });
    return { status, task: null };
  }

  task.status = "in_progress";
  task.attempts += 1;
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, { type: "task_started", planId: taskState.planId, taskId: task.id, attempt: task.attempts });
  await writeSnapshot(rootDir, "task_started", { planId: taskState.planId, taskId: task.id, attempt: task.attempts });

  const beforeDiff = await collectGitDiff(rootDir);
  const beforeChanged = await collectGitChangedPaths(rootDir);
  const workerResult = await runWorker(rootDir, task, options);
  const afterDiff = await collectGitDiff(rootDir);
  const afterChanged = await collectGitChangedPaths(rootDir);

  task.status = "verifying";
  task.evidence.push(workerResult);
  task.evidence.push({
    kind: "diff",
    at: nowIso(),
    beforeBytes: beforeDiff.length,
    afterBytes: afterDiff.length,
    changed: beforeDiff !== afterDiff,
  });
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await writeOutbox(rootDir, task, workerResult);
  await appendLedger(rootDir, { type: "worker_done_claim", planId: taskState.planId, taskId: task.id, exitCode: workerResult.exitCode });
  await writeSnapshot(rootDir, "worker_done", { planId: taskState.planId, taskId: task.id, exitCode: workerResult.exitCode });

  const verifyResult = await runVerifier(rootDir, task);
  task.evidence.push(verifyResult);
  task.last_verify_result = verifyResult;
  const criterionEvidence = applyVerifierEvidenceToCriteria(task, verifyResult);
  await persistTaskState(rootDir, taskState);
  await writeSnapshot(rootDir, "verified", { planId: taskState.planId, taskId: task.id, pass: verifyResult.pass });
  if (criterionEvidence.length > 0) {
    await appendLedger(rootDir, { type: "criterion_evidence_auto_recorded", planId: taskState.planId, taskId: task.id, count: criterionEvidence.length });
  }

  const scopeResult = await scopeGuard(rootDir, {
    taskId: task.id,
    changedPaths: changedPathsIntroducedByTask(beforeChanged, afterChanged),
    unavailableReason: beforeChanged.available ? afterChanged.reason : beforeChanged.reason,
  });
  task.evidence.push({ kind: "scope_guard", at: nowIso(), ...scopeResult });
  task.last_scope_result = scopeResult;
  if (scopeResult.status === "fail") {
    task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "scope_guard");
  }
  await persistTaskState(rootDir, taskState);

  const reviewResult = await runReviewGate(rootDir, task, { workerResult, verifyResult, scopeResult });
  task.evidence.push(reviewResult);
  task.last_review_result = reviewResult;
  await writeReviewReport(rootDir, taskState.planId, task, reviewResult);
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, { type: "review_gate_completed", planId: taskState.planId, taskId: task.id, pass: reviewResult.pass, failedLaneCount: reviewResult.lanes.filter((lane) => lane.status === "fail").length });
  await writeSnapshot(rootDir, "reviewed", { planId: taskState.planId, taskId: task.id, pass: reviewResult.pass });

  const criteria = criteriaStatus(task);
  if (workerResult.exitCode === 0 && verifyResult.pass && criteria.pass && scopeResult.status === "pass" && reviewResult.pass) {
    task.status = "completed";
    task.updatedAt = nowIso();
    await persistTaskState(rootDir, taskState);
    await writeCheckpoint(rootDir, taskState.planId, task, verifyResult, scopeResult, reviewResult);
    await appendLedger(rootDir, { type: "task_verified", planId: taskState.planId, taskId: task.id, scopeStatus: scopeResult.status, reviewStatus: "pass" });
    await appendWisdom(rootDir, task, verifyResult);
    await writeSnapshot(rootDir, "checkpointed", { planId: taskState.planId, taskId: task.id, scopeStatus: scopeResult.status });
    if (taskState.tasks.every((candidate) => candidate.status === "completed")) {
      await writeWorkflowSummary(rootDir, { reason: "all_tasks_completed" });
    }
    return { status: "completed", task, workerResult, verifyResult, scopeResult, reviewResult };
  }

  task.status = shouldFailTask(task, verifyResult, scopeResult, reviewResult) ? "failed" : "pending";
  if (scopeResult?.status === "fail" && !task.last_change_request) {
    task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "scope_guard");
  }
  task.last_failure = buildFailureSummary(task, {
    workerResult,
    verifyResult,
    scopeResult,
    reviewResult,
    criteriaResult: criteria,
    nextStatus: task.status,
  });
  task.updatedAt = nowIso();
  await writeFailureReport(rootDir, taskState.planId, task);
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: "task_rejected",
    planId: taskState.planId,
    taskId: task.id,
    nextStatus: task.status,
    attempt: task.attempts,
    reason: task.last_failure.reason,
    retryHint: task.last_failure.retryHint,
  });
  await writeSnapshot(rootDir, "task_rejected", { planId: taskState.planId, taskId: task.id, nextStatus: task.status });
  return { status: task.status === "failed" ? "failed" : "retry", task, workerResult, verifyResult, scopeResult, reviewResult };
}

export async function runWorkflowNode(rootDir, nodeName, options = {}) {
  if (nodeName === "route") {
    return routeRequest(rootDir, { text: options.text });
  }
  if (nodeName === "execute") {
    return executeTaskNode(rootDir, options);
  }
  if (nodeName === "verify") {
    return verifyTaskNode(rootDir, options);
  }
  if (nodeName === "scope") {
    return scopeTaskNode(rootDir, options);
  }
  if (nodeName === "review") {
    return reviewTaskNode(rootDir, options);
  }
  if (nodeName === "checkpoint") {
    return checkpointTaskNode(rootDir, options);
  }
  if (nodeName === "retry") {
    return retryTaskNode(rootDir, options);
  }
  throw new Error(`unknown workflow node: ${nodeName}`);
}

export async function executeTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-execute:${options.taskId || "next"}`, () => executeTaskNodeUnlocked(rootDir, options));
}

async function executeTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");

  const task = resolveNodeTask(taskState.tasks, options.taskId, ["pending", "in_progress"]);
  if (task.status === "pending") {
    task.status = "in_progress";
    task.attempts += 1;
    task.updatedAt = nowIso();
    await persistTaskState(rootDir, taskState);
    await appendLedger(rootDir, { type: "node_execute_started", planId: taskState.planId, taskId: task.id, attempt: task.attempts });
    await writeSnapshot(rootDir, "node_execute_started", { planId: taskState.planId, taskId: task.id });
  }

  const beforeDiff = await collectGitDiff(rootDir);
  const beforeChanged = await collectGitChangedPaths(rootDir);
  const workerResult = await runWorker(rootDir, task, options);
  const afterDiff = await collectGitDiff(rootDir);
  const afterChanged = await collectGitChangedPaths(rootDir);

  task.status = "verifying";
  task.evidence.push(workerResult);
  task.evidence.push({
    kind: "diff",
    at: nowIso(),
    beforeBytes: beforeDiff.length,
    afterBytes: afterDiff.length,
    changed: beforeDiff !== afterDiff,
  });
  task.evidence.push({
    kind: "execution_paths",
    at: nowIso(),
    beforeAvailable: beforeChanged.available,
    afterAvailable: afterChanged.available,
    beforePaths: beforeChanged.paths || [],
    afterPaths: afterChanged.paths || [],
    introducedPaths: changedPathsIntroducedByTask(beforeChanged, afterChanged) || [],
    unavailableReason: beforeChanged.available ? afterChanged.reason : beforeChanged.reason,
  });
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await writeOutbox(rootDir, task, workerResult);
  await appendLedger(rootDir, { type: "node_execute_completed", planId: taskState.planId, taskId: task.id, exitCode: workerResult.exitCode });
  await writeSnapshot(rootDir, "node_execute_completed", { planId: taskState.planId, taskId: task.id, exitCode: workerResult.exitCode });
  return { status: "executed", task, workerResult };
}

export async function verifyTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-verify:${options.taskId || "next"}`, () => verifyTaskNodeUnlocked(rootDir, options));
}

async function verifyTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress"]);

  task.status = "verifying";
  const verifyResult = await runVerifier(rootDir, task);
  task.evidence.push(verifyResult);
  task.last_verify_result = verifyResult;
  const criterionEvidence = applyVerifierEvidenceToCriteria(task, verifyResult);
  if (!verifyResult.pass) {
    task.last_failure = buildFailureSummary(task, {
      workerResult: [...task.evidence].reverse().find((entry) => entry.kind === "worker") || { exitCode: 0 },
      verifyResult,
      scopeResult: task.last_scope_result || { status: "inconclusive" },
      nextStatus: "verifying",
    });
  }
  task.updatedAt = nowIso();
  await appendLedger(rootDir, { type: "node_verify_completed", planId: taskState.planId, taskId: task.id, pass: verifyResult.pass, criterionEvidenceCount: criterionEvidence.length });
  if (!verifyResult.pass) {
    await writeFailureReport(rootDir, taskState.planId, task);
    await persistTaskState(rootDir, taskState);
    await appendLedger(rootDir, { type: "node_verify_failed", planId: taskState.planId, taskId: task.id, reason: task.last_failure.reason });
  } else {
    await persistTaskState(rootDir, taskState);
  }
  await writeSnapshot(rootDir, "node_verify_completed", { planId: taskState.planId, taskId: task.id, pass: verifyResult.pass });
  return { status: verifyResult.pass ? "verified" : "verify_failed", task, verifyResult };
}

export async function scopeTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-scope:${options.taskId || "next"}`, () => scopeTaskNodeUnlocked(rootDir, options));
}

async function scopeTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress", "pending"]);
  const executionPaths = [...task.evidence].reverse().find((entry) => entry.kind === "execution_paths");
  const scopeResult = await scopeGuard(rootDir, {
    taskId: task.id,
    changedPaths: executionPaths?.afterAvailable === true ? executionPaths.introducedPaths : undefined,
    unavailableReason: executionPaths?.unavailableReason,
  });
  task.evidence.push({ kind: "scope_guard", at: nowIso(), ...scopeResult });
  task.last_scope_result = scopeResult;
  if (scopeResult.status === "fail") {
    task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "node_scope");
  }
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await writeSnapshot(rootDir, "node_scope_completed", { planId: taskState.planId, taskId: task.id, scopeStatus: scopeResult.status });
  return { status: scopeResult.status, task, scopeResult };
}

export async function reviewTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-review:${options.taskId || "next"}`, () => reviewTaskNodeUnlocked(rootDir, options));
}

async function reviewTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress"]);
  const workerResult = [...task.evidence].reverse().find((entry) => entry.kind === "worker");
  const verifyResult = task.last_verify_result || [...task.evidence].reverse().find((entry) => entry.kind === "verifier");
  const scopeResult = task.last_scope_result || [...task.evidence].reverse().find((entry) => entry.kind === "scope_guard");
  const reviewResult = await runReviewGate(rootDir, task, { workerResult, verifyResult, scopeResult });

  task.status = "verifying";
  task.evidence.push(reviewResult);
  task.last_review_result = reviewResult;
  task.updatedAt = nowIso();
  await writeReviewReport(rootDir, taskState.planId, task, reviewResult);

  if (!reviewResult.pass) {
    task.status = "failed";
    task.last_failure = buildFailureSummary(task, {
      workerResult: workerResult || { exitCode: 1 },
      verifyResult: verifyResult || { pass: false },
      scopeResult: scopeResult || { status: "inconclusive" },
      reviewResult,
      nextStatus: task.status,
    });
    await writeFailureReport(rootDir, taskState.planId, task);
  }

  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: reviewResult.pass ? "node_review_passed" : "node_review_failed",
    planId: taskState.planId,
    taskId: task.id,
    failedLaneCount: reviewResult.lanes.filter((lane) => lane.status === "fail").length,
  });
  await writeSnapshot(rootDir, "node_review_completed", { planId: taskState.planId, taskId: task.id, pass: reviewResult.pass });
  return { status: reviewResult.pass ? "reviewed" : "review_failed", task, reviewResult };
}

export async function checkpointTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-checkpoint:${options.taskId || "next"}`, () => checkpointTaskNodeUnlocked(rootDir, options));
}

async function checkpointTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress"]);
  const workerResult = [...task.evidence].reverse().find((entry) => entry.kind === "worker");
  const verifyResult = task.last_verify_result || [...task.evidence].reverse().find((entry) => entry.kind === "verifier");
  const scopeResult = task.last_scope_result || [...task.evidence].reverse().find((entry) => entry.kind === "scope_guard");
  const reviewResult = task.last_review_result || [...task.evidence].reverse().find((entry) => entry.kind === "review_gate");
  const criteria = criteriaStatus(task);

  if (workerResult?.exitCode === 0 && verifyResult?.pass === true && criteria.pass && scopeResult?.status === "pass" && reviewResult?.pass === true) {
    task.status = "completed";
    task.updatedAt = nowIso();
    await persistTaskState(rootDir, taskState);
    await writeCheckpoint(rootDir, taskState.planId, task, verifyResult, scopeResult, reviewResult);
    await appendLedger(rootDir, { type: "node_checkpoint_completed", planId: taskState.planId, taskId: task.id, scopeStatus: scopeResult?.status || "missing", reviewStatus: "pass" });
    await appendWisdom(rootDir, task, verifyResult);
    await writeSnapshot(rootDir, "node_checkpoint_completed", { planId: taskState.planId, taskId: task.id });
    return { status: "completed", task, verifyResult, scopeResult, reviewResult };
  }

  task.status = shouldFailTask(task, verifyResult, scopeResult, reviewResult) ? "failed" : "pending";
  if (scopeResult?.status === "fail" && !task.last_change_request) {
    task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "checkpoint");
  }
  task.last_failure = buildFailureSummary(task, {
    workerResult: workerResult || { exitCode: 1 },
    verifyResult: verifyResult || { pass: false },
    scopeResult: scopeResult || { status: "inconclusive" },
    reviewResult: reviewResult || { pass: false, lanes: [{ name: "review_gate", status: "fail", summary: "review gate has not passed" }] },
    criteriaResult: criteria,
    nextStatus: task.status,
  });
  task.updatedAt = nowIso();
  await writeFailureReport(rootDir, taskState.planId, task);
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: "node_checkpoint_rejected",
    planId: taskState.planId,
    taskId: task.id,
    nextStatus: task.status,
    reason: task.last_failure.reason,
    retryHint: task.last_failure.retryHint,
  });
  await writeSnapshot(rootDir, "node_checkpoint_rejected", { planId: taskState.planId, taskId: task.id, nextStatus: task.status });
  return { status: task.status === "failed" ? "failed" : "retry", task, verifyResult, scopeResult, reviewResult };
}

export async function retryTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-retry:${options.taskId || "next"}`, () => retryTaskNodeUnlocked(rootDir, options));
}

async function retryTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = resolveRetryTask(taskState.tasks, options.taskId);
  const failure = task.last_failure;

  if (failure?.reason === "scope_guard_failed" && options.force !== true) {
    const scopeResult = task.last_scope_result || [...task.evidence].reverse().find((entry) => entry.kind === "scope_guard");
    if (!task.last_change_request && scopeResult?.status === "fail") {
      task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "retry_block");
      await persistTaskState(rootDir, taskState);
    }
    const changeRequest = task.last_change_request?.id ? await readChangeRequest(rootDir, task.last_change_request.id) : task.last_change_request;
    if (!changeRequest || changeRequest.status === "open") {
      await appendLedger(rootDir, {
        type: "node_retry_blocked",
        planId: taskState.planId,
        taskId: task.id,
        reason: "scope_guard_failed",
        nextAction: "review_change_request",
        changeRequestId: task.last_change_request?.id,
      });
      return { status: "change_request_required", task, failure, changeRequest: task.last_change_request || null };
    }

    const currentChanged = await collectGitChangedPaths(rootDir);
    const stillChangedDeniedPaths = currentChanged.available
      ? (changeRequest.deniedPaths || []).filter((filePath) => currentChanged.paths.map(normalizeRelativePath).includes(normalizeRelativePath(filePath)))
      : undefined;
    const currentScope = await scopeGuard(rootDir, {
      taskId: task.id,
      changedPaths: stillChangedDeniedPaths,
      unavailableReason: currentChanged.reason,
    });
    if (currentScope.status === "fail") {
      await appendLedger(rootDir, {
        type: "node_retry_blocked",
        planId: taskState.planId,
        taskId: task.id,
        reason: "scope_cleanup_required",
        nextAction: changeRequest.status === "accepted" ? "apply_scope_or_remove_denied_paths" : "remove_denied_paths",
        changeRequestId: changeRequest.id,
        deniedPaths: currentScope.deniedPaths,
      });
      return { status: "scope_cleanup_required", task, failure, changeRequest, scopeResult: currentScope };
    }
    task.last_scope_result = currentScope;
    task.evidence.push({ kind: "scope_guard", at: nowIso(), ...currentScope });
  }

  task.status = "pending";
  task.manual_retry_count = (task.manual_retry_count || 0) + 1;
  task.maxAttempts = Math.max(task.maxAttempts || 1, task.attempts + 1);
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: "node_retry_reopened",
    planId: taskState.planId,
    taskId: task.id,
    manualRetryCount: task.manual_retry_count,
    previousReason: failure?.reason || "unknown",
  });
  await writeSnapshot(rootDir, "node_retry_reopened", { planId: taskState.planId, taskId: task.id });
  return { status: "pending", task, failure };
}

function hasWeakeningLanguage(value) {
  return /\b(skip|bypass|weaken|remove|omit|auto[-\s]?complete|mark complete|complete faster)\b/i.test(value)
    && /\b(test|tests|verification|review|quality gate|complete|completion)\b/i.test(value);
}

export async function reviewChangeRequest(rootDir, id) {
  const changeRequest = await readChangeRequest(rootDir, id);
  const reasons = [];
  if (changeRequest.kind !== "change_request") reasons.push("invalid kind");
  if (changeRequest.status !== "open") reasons.push(`change request is ${changeRequest.status}`);
  if (!changeRequest.evidence || !changeRequest.rationale) reasons.push("missing evidence or rationale");
  if (changeRequest.invariants?.autoApply !== false) reasons.push("autoApply invariant must be false");
  if (changeRequest.invariants?.requiresSisyphusReview !== true) reasons.push("requiresSisyphusReview invariant must be true");
  if (changeRequest.invariants?.mustNotWeakenVerification !== true) reasons.push("mustNotWeakenVerification invariant must be true");
  if (hasWeakeningLanguage(`${changeRequest.evidence}\n${changeRequest.rationale}`)) reasons.push("proposal appears to weaken verification");

  const audit = {
    kind: "change_request_review",
    at: nowIso(),
    id: changeRequest.id,
    status: reasons.length === 0 ? "reviewable" : "blocked",
    reviewer: "Sisyphus",
    reasons,
    allowedDecisions: reasons.length === 0 ? ["accept", "reject"] : [],
    invariant: {
      accepted: reasons.length === 0,
      evidenceBackedNecessity: Boolean(changeRequest.evidence && changeRequest.rationale),
      noAutomaticScopeExpansion: changeRequest.invariants?.autoApply === false,
      noWeakenedVerification: !hasWeakeningLanguage(`${changeRequest.evidence}\n${changeRequest.rationale}`),
    },
    changeRequest,
  };
  await appendLedger(rootDir, {
    type: "change_request_reviewed",
    changeRequestId: changeRequest.id,
    status: audit.status,
    reasons,
  });
  return audit;
}

export async function resolveChangeRequest(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `change-resolve:${options.id || "unknown"}`, () => resolveChangeRequestUnlocked(rootDir, options));
}

async function resolveChangeRequestUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const id = options.id;
  if (!id || typeof id !== "string") throw new Error("change request id is required");
  const decision = normalizeDecision(options.decision);
  if (!decision) throw new Error("decision must be accept or reject");
  const evidence = typeof options.evidence === "string" ? options.evidence.trim() : "";
  const rationale = typeof options.rationale === "string" ? options.rationale.trim() : "";
  if (!evidence) throw new Error("decision evidence is required");
  if (!rationale) throw new Error("decision rationale is required");
  if (hasWeakeningLanguage(`${evidence}\n${rationale}`)) {
    throw new Error("decision appears to weaken verification; keep verification/review gates intact");
  }

  const changeRequest = await readChangeRequest(rootDir, id);
  if (changeRequest.status !== "open") throw new Error(`change request ${id} is already ${changeRequest.status}`);
  const taskState = await loadTaskState(rootDir);
  const task = taskState?.planId === changeRequest.planId
    ? taskState.tasks.find((candidate) => candidate.id === changeRequest.taskId)
    : null;
  const now = nowIso();

  changeRequest.status = decision === "accept" ? "accepted" : "rejected";
  changeRequest.decision = decision;
  changeRequest.reviewedAt = now;
  changeRequest.updatedAt = now;
  changeRequest.reviewer = options.reviewer || "Sisyphus";
  changeRequest.decisionEvidence = evidence;
  changeRequest.decisionRationale = rationale;
  changeRequest.appliedScope = false;
  changeRequest.decisionInvariant = {
    accepted: true,
    explicitDecisionOnly: true,
    noAutomaticScopeExpansion: true,
    mustNotWeakenVerification: true,
  };

  if (task) {
    task.change_resolution = {
      id,
      decision,
      appliedScope: false,
      at: now,
      evidence,
      rationale,
    };
    if (task.last_failure) task.last_failure.resolvedBy = id;
  }

  if (decision === "accept" && options.applyScope === true) {
    if (!task) throw new Error(`task ${changeRequest.taskId} not found for change request ${id}`);
    task.writable_paths = uniqueStrings([...(task.writable_paths || []), ...(changeRequest.deniedPaths || [])]);
    task.change_resolution.appliedScope = true;
    task.last_scope_result = null;
    changeRequest.appliedScope = true;
    changeRequest.appliedWritablePaths = task.writable_paths;
  }

  if (taskState && task) await persistTaskState(rootDir, taskState);

  const jsonPath = resolveHelixPath(rootDir, "changes", `${id}.json`);
  const mdPath = resolveHelixPath(rootDir, "changes", `${id}.md`);
  changeRequest.reportJsonPath = path.relative(rootDir, jsonPath);
  changeRequest.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, changeRequest);
  await writeFile(mdPath, renderChangeRequestMarkdown(changeRequest), "utf8");
  await writeOpenChangesIndex(rootDir);
  await appendLedger(rootDir, {
    type: "change_request_resolved",
    planId: changeRequest.planId,
    taskId: changeRequest.taskId,
    changeRequestId: id,
    decision,
    appliedScope: changeRequest.appliedScope,
  });
  await writeSnapshot(rootDir, "change_request_resolved", { changeRequestId: id, decision, appliedScope: changeRequest.appliedScope });
  return { status: changeRequest.status, changeRequest, task: task || null };
}

function normalizeDecision(decision) {
  if (decision === "accept" || decision === "accepted") return "accept";
  if (decision === "reject" || decision === "rejected") return "reject";
  return null;
}

async function readChangeRequest(rootDir, id) {
  if (!/^CR-[a-z0-9]+$/i.test(id || "")) throw new Error(`invalid change request id: ${id}`);
  const changeRequest = await readJson(resolveHelixPath(rootDir, "changes", `${id}.json`), null);
  if (!changeRequest) throw new Error(`unknown change request: ${id}`);
  return changeRequest;
}

function resolveNodeTask(tasks, taskId, allowedStatuses) {
  const task = taskId ? tasks.find((candidate) => candidate.id === taskId) : findRunnableTask(tasks) || tasks.find((candidate) => allowedStatuses.includes(candidate.status));
  if (!task) throw new Error(taskId ? `unknown task: ${taskId}` : "no task available for node");
  if (!allowedStatuses.includes(task.status)) {
    throw new Error(`task ${task.id} status ${task.status} cannot run this node`);
  }
  return task;
}

function resolveRetryTask(tasks, taskId) {
  const task = taskId
    ? tasks.find((candidate) => candidate.id === taskId)
    : tasks.find((candidate) => candidate.status === "failed") || findRunnableTask(tasks);
  if (!task) throw new Error(taskId ? `unknown task: ${taskId}` : "no failed or pending task available for retry");
  if (!["failed", "pending"].includes(task.status)) {
    throw new Error(`task ${task.id} status ${task.status} cannot run retry`);
  }
  return task;
}

function shouldFailTask(task, verifyResult, scopeResult, reviewResult) {
  if (scopeResult?.status === "fail") return true;
  if (scopeResult && scopeResult.status !== "pass") return true;
  if (verifyResult?.pass === true && reviewResult?.kind === "review_gate" && reviewResult.pass === false) return true;
  return task.attempts >= task.maxAttempts;
}

function rejectionReason(workerResult, verifyResult, scopeResult) {
  if (workerResult.exitCode !== 0) return "worker_failed";
  if (!verifyResult.pass) return "verifier_failed";
  if (scopeResult.status === "fail") return "scope_guard_failed";
  if (scopeResult.status !== "pass") return "scope_guard_inconclusive";
  return "unknown";
}

function gateRejectionReason(workerResult, verifyResult, scopeResult, reviewResult, criteriaResult) {
  const base = rejectionReason(workerResult, verifyResult, scopeResult);
  if (base !== "unknown") return base;
  if (criteriaResult && criteriaResult.pass === false) return "criteria_failed";
  if (reviewResult?.pass === false) return "review_gate_failed";
  return "unknown";
}

function buildFailureSummary(task, { workerResult, verifyResult, scopeResult, reviewResult, criteriaResult, nextStatus }) {
  const reason = gateRejectionReason(workerResult, verifyResult, scopeResult, reviewResult, criteriaResult);
  const failed = failureTarget(reason, workerResult, verifyResult, scopeResult, criteriaResult);
  const observed = failureObserved(reason, workerResult, verifyResult, scopeResult, reviewResult, criteriaResult);
  const fixBy = failureFixBy(reason, task, scopeResult, reviewResult, criteriaResult);
  const doNot = failureDoNot(reason);
  return {
    kind: "failure_summary",
    at: nowIso(),
    taskId: task.id,
    reason,
    nextStatus,
    failed,
    observed,
    fixBy,
    doNot,
    changeRequest: task.last_change_request || null,
    retryHint: [
      `FAILED: ${failed}`,
      `OBSERVED: ${observed}`,
      `FIX BY: ${fixBy}`,
      `DO NOT: ${doNot}`,
    ].join("\n"),
  };
}

function failureTarget(reason, workerResult, verifyResult, scopeResult, criteriaResult) {
  if (reason === "worker_failed") return workerResult.command || "worker command";
  if (reason === "verifier_failed") {
    const failedCommand = verifyResult.results?.find((result) => result.exitCode !== 0);
    return failedCommand?.command || "verifier command";
  }
  if (reason === "scope_guard_failed") return `scope guard denied ${scopeResult.deniedPaths?.join(", ") || "changed paths"}`;
  if (reason === "scope_guard_inconclusive") return "scope guard did not produce passing changed-path evidence";
  if (reason === "criteria_failed") return `success criteria (${criteriaResult?.passed || 0}/${criteriaResult?.total || 0} pass)`;
  if (reason === "review_gate_failed") return "review gate";
  return "checkpoint gate";
}

function failureObserved(reason, workerResult, verifyResult, scopeResult, reviewResult, criteriaResult) {
  if (reason === "worker_failed") return commandObservation(workerResult);
  if (reason === "verifier_failed") {
    const failedCommand = verifyResult.results?.find((result) => result.exitCode !== 0);
    return commandObservation(failedCommand || { exitCode: 1 });
  }
  if (reason === "scope_guard_failed") {
    return `changed=${(scopeResult.changedPaths || []).join(", ") || "none"}; denied=${(scopeResult.deniedPaths || []).join(", ") || "none"}`;
  }
  if (reason === "scope_guard_inconclusive") {
    return `scopeStatus=${scopeResult.status || "missing"}; reason=${scopeResult.reason || "missing changed-path evidence"}`;
  }
  if (reason === "criteria_failed") {
    return `criteria pass=${criteriaResult?.passed || 0}, pending=${criteriaResult?.pending || 0}, fail=${criteriaResult?.failed || 0}`;
  }
  if (reason === "review_gate_failed") {
    const failedLanes = (reviewResult?.lanes || []).filter((lane) => lane.status === "fail");
    return failedLanes.map((lane) => `${lane.name}: ${lane.summary}`).join("; ") || "review gate failed without lane details";
  }
  return "missing or inconclusive gate evidence";
}

function commandObservation(result) {
  const stdout = truncateForSummary((result.stdout || "").trim());
  const stderr = truncateForSummary((result.stderr || "").trim());
  return [`exitCode=${result.exitCode ?? 1}`, stdout ? `stdout=${stdout}` : null, stderr ? `stderr=${stderr}` : null].filter(Boolean).join("; ");
}

function failureFixBy(reason, task, scopeResult, reviewResult, criteriaResult) {
  if (reason === "worker_failed") return "修复 worker_command 或交给 Hephaestus 重新实现同一任务，然后重跑 execute。";
  if (reason === "verifier_failed") return "按失败命令输出修正实现，不改验收标准；修完后重跑 verify 和 checkpoint。";
  if (reason === "scope_guard_failed") {
    return `移除计划外改动或创建 ChangeRequest 扩展 writable_paths。当前允许范围：${task.writable_paths.join(", ") || "(none)"}；被拒绝：${(scopeResult.deniedPaths || []).join(", ") || "(unknown)"}`;
  }
  if (reason === "scope_guard_inconclusive") {
    return "恢复可审计的改动证据后重跑 scope/checkpoint；非 Git 项目应使用文件清单 fallback，或初始化 Git 以获得可靠 changed paths。";
  }
  if (reason === "criteria_failed") {
    return `补齐 successCriteria 证据后重跑 review/checkpoint。当前 pass=${criteriaResult?.passed || 0}, pending=${criteriaResult?.pending || 0}, fail=${criteriaResult?.failed || 0}。`;
  }
  if (reason === "review_gate_failed") {
    const failedLanes = (reviewResult?.lanes || []).filter((lane) => lane.status === "fail");
    return failedLanes.map((lane) => lane.fixBy).filter(Boolean).join("；") || "修复 review gate 指出的阻塞项，然后重跑 review 和 checkpoint。";
  }
  return "补齐缺失证据后重新进入 verify/checkpoint。";
}

function failureDoNot(reason) {
  if (reason === "scope_guard_failed") return "不要直接重试同一 worker；先处理范围漂移。";
  if (reason === "scope_guard_inconclusive") return "不要把“看不到改动”当作“没有越界”。";
  if (reason === "verifier_failed") return "不要降低或删除 verify_commands 来制造 PASS。";
  if (reason === "worker_failed") return "不要跳过 worker 失败直接 checkpoint。";
  if (reason === "review_gate_failed") return "不要绕过 review gate 或删除 review_commands 来制造 PASS。";
  if (reason === "criteria_failed") return "不要删除 successCriteria 或伪造 criterion evidence 来制造 PASS。";
  return "不要在证据不完整时 checkpoint。";
}

function truncateForSummary(value, limit = 500) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 15)}...[truncated]`;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function normalizeRelativePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

export async function runWorkflow(rootDir, options = {}) {
  await initRuntime(rootDir);
  let plan = null;
  if (options.planPath) {
    plan = await importPlan(rootDir, path.resolve(rootDir, options.planPath));
  } else if (options.sample) {
    const samplePath = await createSamplePlan(rootDir);
    plan = await importPlan(rootDir, samplePath);
  }

  const results = [];
  const maxSteps = options.maxSteps || 50;
  for (let step = 0; step < maxSteps; step += 1) {
    const result = await runNextTask(rootDir);
    results.push(result);
    if (["complete", "blocked", "failed"].includes(result.status)) break;
  }

  const report = await statusReport(rootDir);
  await writeSnapshot(rootDir, "workflow_finished", { status: report });
  const summary = await writeWorkflowSummary(rootDir, { reason: "workflow_finished" });
  return { ok: report.failed === 0 && report.pending === 0 && report.in_progress === 0 && report.verifying === 0, planId: plan?.id || report.planId, results, status: report, summaryPath: summary.reportMdPath };
}

export async function createSamplePlan(rootDir, targetPath = resolveHelixPath(rootDir, "plans", "sample-plan.json")) {
  await ensureHelixDirs(rootDir);
  const workerScript = "node -e \"const fs=require('fs'); fs.mkdirSync('.helix/artifacts',{recursive:true}); fs.writeFileSync('.helix/artifacts/linear-smoke.txt','ok\\\\n')\"";
  const verifyScript = "node -e \"const fs=require('fs'); const v=fs.readFileSync('.helix/artifacts/linear-smoke.txt','utf8').trim(); if(v!=='ok') process.exit(1)\"";
  const sample = {
    title: "M1 linear loop smoke",
    objective: "Prove Atlas can run one worker task and verify it before checkpoint.",
    tasks: [
      {
        id: "T001",
        subject: "Write smoke artifact",
        description: "Worker writes a small artifact; verifier checks exact content.",
        category: "quick",
        writable_paths: [".helix/artifacts/linear-smoke.txt"],
        worker_command: workerScript,
        verify_commands: [verifyScript],
      },
    ],
  };
  await writeJsonAtomic(targetPath, sample);
  return targetPath;
}

export async function copyPlanTemplate(rootDir, destinationPath) {
  const samplePath = await createSamplePlan(rootDir);
  await copyFile(samplePath, destinationPath);
  return destinationPath;
}
