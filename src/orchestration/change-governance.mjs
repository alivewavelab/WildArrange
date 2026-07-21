import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_LEAD_AGENT,
  appendLedger,
  ensureHelixDirs,
  hashContent,
  normalizeAgentKey,
  nowIso,
  readJson,
  resolveHelixPath,
  withTaskStateLock,
  writeJsonAtomic,
  writeSnapshot,
} from "../infra/foundation.mjs";
import {
  loadTaskState,
  normalizeStringArray,
  normalizeSuccessCriteria,
  normalizeTask,
  validatePlanGraph,
} from "./plan-state.mjs";
import { persistTaskState } from "./task-board.mjs";

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

export async function reviewChangeRequest(rootDir, id) {
  const changeRequest = await readChangeRequest(rootDir, id);
  const reasons = [];
  if (changeRequest.kind !== "change_request") reasons.push("invalid kind");
  if (changeRequest.status !== "open") reasons.push(`change request is ${changeRequest.status}`);
  if (!changeRequest.evidence || !changeRequest.rationale) reasons.push("missing evidence or rationale");
  if (changeRequest.invariants?.autoApply !== false) reasons.push("autoApply invariant must be false");
  const legacyLeadReviewKey = ["requires", "Sisy", "phus", "Review"].join("");
  if (changeRequest.invariants?.requiresLeadReview !== true && changeRequest.invariants?.[legacyLeadReviewKey] !== true) {
    reasons.push("requiresLeadReview invariant must be true");
  }
  if (changeRequest.invariants?.mustNotWeakenVerification !== true) reasons.push("mustNotWeakenVerification invariant must be true");
  if (hasWeakeningLanguage(`${changeRequest.evidence}\n${changeRequest.rationale}`)) reasons.push("proposal appears to weaken verification");

  const audit = {
    kind: "change_request_review",
    at: nowIso(),
    id: changeRequest.id,
    status: reasons.length === 0 ? "reviewable" : "blocked",
    reviewer: DEFAULT_LEAD_AGENT,
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

export async function readChangeRequest(rootDir, id) {
  if (!/^CR-[a-z0-9]+$/i.test(id || "")) throw new Error(`invalid change request id: ${id}`);
  const changeRequest = await readJson(resolveHelixPath(rootDir, "changes", `${id}.json`), null);
  if (!changeRequest) throw new Error(`unknown change request: ${id}`);
  return changeRequest;
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
  changeRequest.reviewer = normalizeAgentKey(options.reviewer || DEFAULT_LEAD_AGENT);
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
    const missingPendingIds = pendingIds.filter((id) => !pendingOrder.includes(id));
    if (pendingOrder.length === 0) reasons.push("reorder_pending requires pendingOrder");
    if (new Set(pendingOrder).size !== pendingOrder.length) reasons.push("duplicate pending id");
    if (pendingOrder.some((id) => !pendingIds.includes(id))) reasons.push("unknown pending id");
    if (pendingOrder.length !== pendingIds.length || missingPendingIds.length > 0) {
      reasons.push(`reorder_pending must include every pending task exactly once: missing ${missingPendingIds.join(", ") || "none"}`);
    }
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

function nextTaskId(tasks) {
  const max = tasks.reduce((current, task) => {
    const match = /^T(\d+)$/.exec(task.id);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `T${String(max + 1).padStart(3, "0")}`;
}

function hasWeakeningLanguage(value) {
  return /\b(skip|bypass|weaken|remove|omit|auto[-\s]?complete|mark complete|complete faster)\b/i.test(value)
    && /\b(test|tests|verification|review|quality gate|complete|completion)\b/i.test(value);
}

function normalizeDecision(decision) {
  if (decision === "accept" || decision === "accepted") return "accept";
  if (decision === "reject" || decision === "rejected") return "reject";
  return null;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

export async function writeChangeRequest(rootDir, planId, task, scopeResult, source = "scope_guard") {
  await ensureHelixDirs(rootDir);
  const signature = hashContent(JSON.stringify({
    planId,
    taskId: task.id,
    deniedPaths: scopeResult.deniedPaths || [],
    writablePaths: scopeResult.writablePaths || task.writable_paths || [],
  })).slice(0, 12);
  const id = `CR-${signature}`;
  const jsonPath = resolveHelixPath(rootDir, "changes", `${id}.json`);
  const mdPath = resolveHelixPath(rootDir, "changes", `${id}.md`);
  const existing = await readJson(jsonPath, null);
  const changeRequest = existing || {
    id,
    kind: "change_request",
    status: "open",
    source,
    planId,
    taskId: task.id,
    subject: task.subject,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    evidence: `scope guard denied paths: ${(scopeResult.deniedPaths || []).join(", ") || "unknown"}`,
    rationale: "Worker changed files outside task.writable_paths; Jiuwei/DiJiang must decide whether to revise scope or reject the change.",
    deniedPaths: scopeResult.deniedPaths || [],
    changedPaths: scopeResult.changedPaths || [],
    writablePaths: scopeResult.writablePaths || task.writable_paths || [],
    proposedActions: [
      "revert_or_move_out_of_scope_changes",
      "revise_plan_writable_paths_after_review",
      "split_into_new_task",
    ],
    invariants: {
      autoApply: false,
      requiresLeadReview: true,
      mustNotWeakenVerification: true,
    },
  };
  if (existing) {
    changeRequest.updatedAt = nowIso();
    changeRequest.lastSeenSource = source;
  }
  changeRequest.reportJsonPath = path.relative(rootDir, jsonPath);
  changeRequest.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, changeRequest);
  await writeFile(mdPath, renderChangeRequestMarkdown(changeRequest), "utf8");
  await writeOpenChangesIndex(rootDir);
  await appendLedger(rootDir, {
    type: existing ? "change_request_reused" : "change_request_created",
    planId,
    taskId: task.id,
    changeRequestId: id,
    deniedPaths: changeRequest.deniedPaths,
    reportPath: changeRequest.reportMdPath,
  });
  return changeRequest;
}

export function renderChangeRequestMarkdown(changeRequest) {
  const legacyLeadReviewKey = ["requires", "Sisy", "phus", "Review"].join("");
  return `# ChangeRequest ${changeRequest.id}

| Field | Value |
| --- | --- |
| Status | \`${changeRequest.status}\` |
| Source | \`${changeRequest.source}\` |
| Plan | \`${changeRequest.planId}\` |
| Task | \`${changeRequest.taskId}\` |
| Subject | ${changeRequest.subject} |

## Evidence

${changeRequest.evidence}

## Rationale

${changeRequest.rationale}

${changeRequest.decision ? `## Decision

- Reviewer: ${changeRequest.reviewer || DEFAULT_LEAD_AGENT}
- Decision: \`${changeRequest.decision}\`
- Reviewed at: ${changeRequest.reviewedAt}
- Applied scope: ${Boolean(changeRequest.appliedScope)}

### Decision Evidence

${changeRequest.decisionEvidence}

### Decision Rationale

${changeRequest.decisionRationale}
` : ""}

## Paths

- Writable: ${changeRequest.writablePaths.join(", ") || "(none)"}
- Changed: ${changeRequest.changedPaths.join(", ") || "(none)"}
- Denied: ${changeRequest.deniedPaths.join(", ") || "(none)"}
${changeRequest.appliedWritablePaths ? `- Applied writable paths: ${changeRequest.appliedWritablePaths.join(", ") || "(none)"}` : ""}

## Allowed Resolutions

${changeRequest.proposedActions.map((action) => `- ${action}`).join("\n")}

## Invariants

- autoApply: ${changeRequest.invariants.autoApply}
- requiresLeadReview: ${changeRequest.invariants.requiresLeadReview ?? changeRequest.invariants[legacyLeadReviewKey]}
- mustNotWeakenVerification: ${changeRequest.invariants.mustNotWeakenVerification}
`;
}

export async function writeOpenChangesIndex(rootDir) {
  const changes = await listChangeRequests(rootDir);
  const openChanges = changes.filter((change) => change.status === "open");
  const lines = ["# Open ChangeRequests", ""];
  if (openChanges.length === 0) {
    lines.push("No open change requests.");
  } else {
    for (const change of openChanges) {
      lines.push(`- ${change.id}: ${change.subject}`);
      lines.push(`  - Task: ${change.taskId}`);
      lines.push(`  - Denied: ${(change.deniedPaths || []).join(", ") || "(none)"}`);
      lines.push(`  - Report: ${change.reportMdPath}`);
    }
  }
  await writeFile(resolveHelixPath(rootDir, "changes", "open.md"), `${lines.join("\n")}\n`, "utf8");
}

export async function listChangeRequests(rootDir) {
  await ensureHelixDirs(rootDir);
  let entries = [];
  try {
    entries = await readdir(resolveHelixPath(rootDir, "changes"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const changes = [];
  for (const entry of entries.filter((name) => /^CR-.+\.json$/.test(name)).sort()) {
    changes.push(await readJson(resolveHelixPath(rootDir, "changes", entry)));
  }
  return changes;
}
