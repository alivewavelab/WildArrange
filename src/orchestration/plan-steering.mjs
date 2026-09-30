// =============================================================================
// 文件名称：plan-steering.mjs
// 所属模块：orchestration
// 作用说明：
//   主 Agent 对当前计划的结构化 steering：校验提案、验收不可弱化、应用并写快照。
// =============================================================================
import { normalizeResponsibilityChanges } from "../infra/responsibility-contract.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import { ensureWildArrangeDirs, nowIso } from "../infra/runtime-store.mjs";
import { transactWithLedger, withTaskStateLock } from "../infra/task-state-lock.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { loadTaskState } from "./plan-state.mjs";
import { normalizeStringArray, normalizeSuccessCriteria, normalizeTask, validatePlanGraph } from "./task-normalize.mjs";
import { persistTaskState } from "./task-board.mjs";
import { hasWeakeningLanguage } from "./change-governance.mjs";


/** 主 Agent 对当前计划的结构化 steering 提案（增删任务、改验收等）。 */
export async function steerWorkflow(rootDir, proposal = {}) {
  return withTaskStateLock(rootDir, `steer:${proposal.kind || "unknown"}`, async () => {
    await ensureWildArrangeDirs(rootDir);
    const taskState = await loadTaskState(rootDir);
    if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");
    const audit = validateSteeringProposal(taskState, proposal);
    if (!audit.invariant.accepted) {
      await appendLedger(rootDir, { type: "steering_rejected", kind: audit.kind, reasons: audit.invariant.rejectedReasons });
      return { accepted: false, audit, taskState };
    }
    const before = structuredClone(taskState);
    const result = applySteeringProposal(taskState, proposal);
    validatePlanGraph({ tasks: taskState.tasks });
    validateTaskAcceptanceInvariants(taskState.tasks);
    audit.before = summarizeSteeringState(before);
    audit.after = summarizeSteeringState(taskState);
    await transactWithLedger(rootDir, {
      type: "steering_applied",
      kind: audit.kind,
      targetTaskIds: audit.targetTaskIds,
      evidence: audit.evidence,
    }, () => persistTaskState(rootDir, taskState));
    await writeSnapshot(rootDir, "steering_applied", { kind: audit.kind, targetTaskIds: audit.targetTaskIds });
    return { accepted: true, audit, result, taskState };
  });
}

/** 校验转向提案字段完整性与任务引用合法。 */
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
  if (kind === "mark_blocked" && targets.some((task) => task && ["completed", "verifying"].includes(task.status))) reasons.push("mark_blocked cannot target completed or verifying tasks");
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

/** 校验验收修订不得弱化 successCriteria/verify。 */
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

/** 批量校验任务 acceptance 不变量。 */
function validateTaskAcceptanceInvariants(tasks) {
  for (const task of tasks) {
    if (!Array.isArray(task.verify_commands) || task.verify_commands.length === 0) {
      throw new Error(`task ${task.id} requires at least one verify command`);
    }
  }
}

/** 将已批准转向提案合并进 taskState。 */
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
    if (proposal.responsibilityChanges !== undefined) {
      const changes = normalizeResponsibilityChanges(proposal.responsibilityChanges, target.writable_paths);
      if (!changes) throw new Error("responsibilityChanges cannot be removed");
      target.responsibilityChanges = changes;
    }
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

/** 生成 steering 决策的时间戳与 actor 标记。 */
function steeringStamp(proposal) {
  return {
    kind: proposal.kind,
    source: proposal.source || "cli",
    evidence: proposal.evidence,
    rationale: proposal.rationale,
    at: nowIso(),
  };
}

/** 汇总 taskState 上 steering 相关字段供报告使用。 */
function summarizeSteeringState(taskState) {
  return {
    planId: taskState.planId,
    tasks: taskState.tasks.map((task) => ({ id: task.id, status: task.status, subject: task.subject, blockedBy: task.blockedBy || [] })),
  };
}
