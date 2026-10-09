import { normalizeExternalDependencies } from "../infra/cross-project-evidence.mjs";
// =============================================================================
// 文件名称：task-normalize.mjs
// 所属模块：orchestration
// 作用说明：
//   任务规范化与校验：normalizeTask、successCriteria、contractChanges、
//   计划任务图校验（validatePlanGraph）与单任务路由 enrichment。纯函数，无 I/O。
//
// 【运行原理速读】
//   可以把它想成「任务字段的编译器」：
//
//   · 何时执行？
//     plan 导入、task create/ready、契约/变更治理改写任务时。
//
//   · 做了什么？
//     原始任务对象 → 补默认值 → 校验枚举/命令/路径 → 产出可持久化的 task。
// =============================================================================
import { normalizeResponsibilityChanges } from "../infra/responsibility-contract.mjs";
import {
  DEFAULT_EXECUTOR_AGENT,
  normalizeAgentKey,
} from "../infra/agent-registry.mjs";
import {
  TASK_PRIORITIES,
  TASK_SOURCES,
  TASK_STATUSES,
  TASK_WORK_TYPES,
  nowIso,
} from "../infra/runtime-store.mjs";
import { resolveRouteDecision } from "../infra/route-table.mjs";
import { isPossibleNoopTask } from "../infra/task-predicates.mjs";
import { uniqueStrings } from "../infra/text-utils.mjs";

/** 规范化字符串数组字段，非法项抛错。 */
export function normalizeStringArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return uniqueStrings(value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) throw new Error(`${label} must contain non-empty strings`);
    return item.trim();
  }));
}

/** 校验并归一化 Skill 名数组为安全单段标识符。 */
export function normalizeSkillArray(value, label) {
  const skills = normalizeStringArray(value, label);
  for (const skill of skills) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(skill)) {
      throw new Error(`${label} contains an invalid skill name: ${skill}`);
    }
  }
  return skills;
}

/** 规范化单条任务：命令、路径、successCriteria、contractChanges 等。 */
export function normalizeTask(task, index, defaults = {}, options = {}) {
  if (!task || typeof task !== "object") {
    throw new Error(`task ${index + 1} must be an object`);
  }
  const id = task.id || `T${String(index + 1).padStart(3, "0")}`;
  const subject = task.subject || task.title;
  if (!subject) throw new Error(`task ${id} subject is required`);

  const taskVerifyCommands = normalizeStringArray(task.verify_commands ?? [], `task ${id} verify_commands`);
  const verifyCommands = uniqueStrings([...(defaults.verify_commands || []), ...taskVerifyCommands]);
  const taskWritablePaths = normalizeStringArray(task.writable_paths ?? [], `task ${id} writable_paths`);
  const writablePaths = uniqueStrings([...(defaults.writable_paths || []), ...taskWritablePaths]);
  const responsibilityChanges = normalizeResponsibilityChanges(task.responsibilityChanges, writablePaths);
  const incomplete = verifyCommands.length === 0 || !responsibilityChanges;
  const requestedStatus = task.status || (options.defaultDraftWhenIncomplete === true && incomplete ? "draft" : "pending");
  if (verifyCommands.length === 0 && requestedStatus !== "draft") {
    throw new Error(`task ${id} requires at least one verify command`);
  }
  // 职责声明是每张可执行任务的准入条件：没有声明只能留在 draft，补齐后经人批准才能执行
  if (!responsibilityChanges && requestedStatus !== "draft") {
    throw new Error(`task ${id} requires responsibilityChanges; a task without them can only stay draft`);
  }
  // Imported/requested "completed" is never trusted: only the delivery pipeline
  // may persist a terminal completed state after the proof chain passes.
  const status = requestedStatus === "completed" ? "needs_user_decision" : validateStatus(requestedStatus);
  const taskReviewCommands = normalizeStringArray(task.review_commands ?? [], `task ${id} review_commands`);
  const reviewCommands = uniqueStrings([...(defaults.review_commands || []), ...taskReviewCommands]);
  const taskStandardsCommands = normalizeStringArray(task.standards_commands ?? [], `task ${id} standards_commands`);
  const standardsCommands = uniqueStrings([...(defaults.standards_commands || []), ...taskStandardsCommands]);
  const taskSkills = normalizeSkillArray(task.skills ?? [], `task ${id} skills`);
  const successCriteria = normalizeSuccessCriteria(task.successCriteria, id, subject, verifyCommands);
  const governanceWarnings = detectTaskGovernanceWarnings({ workerCommand: task.worker_command || null, verifyCommands, writablePaths });
  const workType = normalizeWorkType(task.workType ?? inferWorkType(`${subject}\n${task.description || ""}`));
  const source = normalizeTaskSource(task.source || options.defaultSource || "imported");
  const priority = normalizeTaskPriority(task.priority || "P1");
  const parentTaskRef = normalizeOptionalText(task.parentTaskRef, `task ${id} parentTaskRef`);
  const request = normalizeTaskRequest(task.request, subject, source);
  const createdAt = task.createdAt || nowIso();
  const explicitOwner = normalizeOptionalText(task.owner, `task ${id} owner`);
  const owner = normalizeTaskOwner(explicitOwner || DEFAULT_EXECUTOR_AGENT, id);
  const repositoryTarget = normalizeRepositoryTarget(task.repositoryTarget ?? "project", id);
  const contractChanges = normalizeContractChanges(task.contractChanges, id, owner);
  const skills = uniqueStrings([
    ...(defaults.skills || []),
    ...taskSkills,
    ...(contractChanges.declared ? ["contract-governance"] : []),
  ]);

  return {
    id,
    subject,
    description: task.description || subject,
    category: task.category || null,
    category_source: task.category ? "explicit" : "unresolved",
    workType,
    source,
    priority,
    parentTaskRef,
    request,
    status,
    owner,
    repositoryTarget,
    externalDependencies: normalizeExternalDependencies(task.externalDependencies),
    owner_source: explicitOwner ? "explicit" : "default",
    attempts: Number.isInteger(task.attempts) ? task.attempts : 0,
    maxAttempts: Number.isInteger(task.maxAttempts) ? task.maxAttempts : 3,
    blockedBy: normalizeStringArray(task.blockedBy ?? [], `task ${id} blockedBy`),
    writable_paths: writablePaths,
    worker_command: task.worker_command || null,
    verify_commands: verifyCommands,
    review_commands: reviewCommands,
    standards_commands: standardsCommands,
    successCriteria,
    governanceWarnings,
    skills,
    route_decision: task.route_decision || null,
    contractChanges,
    responsibilityChanges,
    evidence: Array.isArray(task.evidence) ? task.evidence : [],
    history: Array.isArray(task.history) ? task.history : [{ at: createdAt, event: "created", status, source }],
    createdAt,
    updatedAt: nowIso(),
  };
}

// --- 校验 ---

/** 校验 draft 任务 ready 前必填字段是否齐全。 */
export function validateTaskReady(task) {
  if (!task || typeof task !== "object") throw new Error("task is required");
  if (!Array.isArray(task.verify_commands) || task.verify_commands.length === 0) {
    throw new Error(`task ${task.id} cannot become pending without verify_commands`);
  }
  if (!Array.isArray(task.writable_paths) || task.writable_paths.length === 0) {
    throw new Error(`task ${task.id} cannot become pending without writable_paths`);
  }
  if (!Array.isArray(task.successCriteria) || task.successCriteria.length === 0) {
    throw new Error(`task ${task.id} cannot become pending without successCriteria`);
  }
  if (task.workType === "acceptance_correction" && !task.parentTaskRef) {
    throw new Error(`task ${task.id} acceptance_correction requires parentTaskRef`);
  }
  return task;
}

/** 单个可写任务只能选择项目仓或治理仓；跨仓修改必须拆成两个任务。 */
function normalizeRepositoryTarget(value, taskId = "task") {
  if (!["project", "governance"].includes(value)) {
    throw new Error(`task ${taskId} repositoryTarget must be project or governance; split cross-repository work into separate tasks`);
  }
  return value;
}

/** 规范化 workType 枚举值。 */
function normalizeWorkType(value) {
  if (typeof value !== "string" || !TASK_WORK_TYPES.has(value)) {
    throw new Error(`invalid task workType: ${value}`);
  }
  return value;
}

/** 规范化 task source 枚举值。 */
function normalizeTaskSource(value) {
  if (typeof value !== "string" || !TASK_SOURCES.has(value)) {
    throw new Error(`invalid task source: ${value}`);
  }
  return value;
}

/** 规范化 task priority 枚举值。 */
function normalizeTaskPriority(value) {
  const normalized = typeof value === "string" ? value.toUpperCase() : value;
  if (!TASK_PRIORITIES.has(normalized)) throw new Error(`invalid task priority: ${value}`);
  return normalized;
}

/** 从 subject/description 推断 workType 分类。 */
function inferWorkType(text) {
  if (/(验收.{0,8}(纠错|打回|修正)|acceptance.{0,8}(correction|rework))/i.test(text)) return "acceptance_correction";
  if (/(bug|缺陷|故障|报错|崩溃|修复)/i.test(text)) return "bug";
  if (/(新增|新功能|功能|feature|实现)/i.test(text)) return "feature";
  return "maintenance";
}

/** 归一化可选文本字段并校验长度。 */
export function normalizeOptionalText(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

/** 归一化 task 上的 request 对象结构。 */
function normalizeTaskRequest(value, subject, source) {
  if (value === undefined || value === null) return { summary: subject, source, evidenceRefs: [] };
  if (typeof value === "string") return { summary: value.trim() || subject, source, evidenceRefs: [] };
  if (typeof value !== "object") throw new Error("task request must be a string or object");
  return {
    summary: typeof value.summary === "string" && value.summary.trim() ? value.summary.trim() : subject,
    source: normalizeTaskSource(value.source || source),
    evidenceRefs: normalizeStringArray(value.evidenceRefs ?? [], "task request evidenceRefs"),
  };
}

/** 规范化任务契约变更声明列表。 */
function normalizeContractChanges(value, taskId, owner) {
  if (value === undefined || value === null) return { declared: false, items: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`task ${taskId} contractChanges must be an object`);
  }
  const rawItems = value.items ?? [];
  if (!Array.isArray(rawItems)) throw new Error(`task ${taskId} contractChanges.items must be an array`);
  const items = rawItems.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`task ${taskId} contractChanges.items[${index}] must be an object`);
    }
    const action = String(item.action || "").trim().toLowerCase();
    if (!new Set(["add", "modify", "deprecate", "remove"]).has(action)) {
      throw new Error(`task ${taskId} contractChanges.items[${index}].action is invalid`);
    }
    const contractId = String(item.contractId ?? item.id ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/.test(contractId)) {
      throw new Error(`task ${taskId} contractChanges.items[${index}].contractId is invalid`);
    }
    const summary = String(item.summary || "").trim();
    if (!summary) throw new Error(`task ${taskId} contractChanges.items[${index}].summary is required`);
    return {
      contractId,
      kind: String(item.kind || "manual").trim(),
      action,
      summary,
      expected: item.expected && typeof item.expected === "object" && !Array.isArray(item.expected) ? JSON.parse(JSON.stringify(item.expected)) : null,
      compatibility: String(item.compatibility || "").trim(),
      migration: String(item.migration || "").trim(),
      rollback: String(item.rollback || "").trim(),
      approvalRef: String(item.approvalRef || "").trim(),
      moduleRef: item.moduleRef ? String(item.moduleRef).trim() : null,
      ownerRef: item.ownerRef ? String(item.ownerRef).trim() : owner,
      verificationRefs: normalizeStringArray(item.verificationRefs ?? [], `task ${taskId} contractChanges.items[${index}].verificationRefs`),
      sourcePaths: normalizeStringArray(item.sourcePaths ?? [], `task ${taskId} contractChanges.items[${index}].sourcePaths`),
    };
  });
  const declared = value.declared === true || items.length > 0;
  return { declared, items };
}

/** 归一化 task owner 字符串。 */
function normalizeTaskOwner(value, taskId) {
  const normalized = normalizeAgentKey(value);
  if (!normalized) throw new Error(`task ${taskId} owner must be a non-empty agent name`);
  return normalized;
}

/** 检测 worker/verify/writable_paths 治理黄灯。 */
function detectTaskGovernanceWarnings({ workerCommand, verifyCommands, writablePaths }) {
  const warnings = [];
  if (isPossibleNoopTask({ worker_command: workerCommand, verify_commands: verifyCommands, writable_paths: writablePaths })) {
    warnings.push({
      code: "possible_noop_task",
      severity: "warn",
      message: "worker_command is empty/trivial, verify_commands are trivial, and writable_paths is empty; this task may pass without testing a real change.",
    });
  }
  return warnings;
}

/** 规范化 successCriteria 并与 verify_commands 索引对齐。 */
export function normalizeSuccessCriteria(value, taskId, subject, verifyCommands) {
  if (value === undefined) return seedDefaultSuccessCriteria(taskId, subject, verifyCommands);
  if (!Array.isArray(value)) throw new Error(`task ${taskId} successCriteria must be an array`);
  if (value.length === 0) return seedDefaultSuccessCriteria(taskId, subject, verifyCommands);
  return value.map((criterion, index) => {
    if (!criterion || typeof criterion !== "object") throw new Error(`task ${taskId} successCriteria[${index}] must be an object`);
    const id = criterion.id || `C${String(index + 1).padStart(3, "0")}`;
    const title = criterion.title || criterion.scenario || `${subject} criterion ${index + 1}`;
    if (typeof title !== "string" || title.trim().length === 0) throw new Error(`task ${taskId} criterion ${id} title is required`);
    const status = criterion.status || "pending";
    if (!["pending", "pass", "fail"].includes(status)) throw new Error(`task ${taskId} criterion ${id} status must be pending, pass, or fail`);
    return {
      id,
      title: title.trim(),
      scenario: typeof criterion.scenario === "string" && criterion.scenario.trim() ? criterion.scenario.trim() : title.trim(),
      expectedEvidence: typeof criterion.expectedEvidence === "string" && criterion.expectedEvidence.trim()
        ? criterion.expectedEvidence.trim()
        : "verifier/review evidence proves this criterion",
      status,
      evidence: Array.isArray(criterion.evidence) ? criterion.evidence : [],
      verifierCommandRefs: normalizeVerifierCommandRefs(criterion.verifierCommandRefs, verifyCommands, `task ${taskId} criterion ${id}`),
      lastUpdatedAt: criterion.lastUpdatedAt || null,
    };
  });
}

/** 归一化 successCriteria 中的 verifierCommandRefs。 */
function normalizeVerifierCommandRefs(value, verifyCommands, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} verifierCommandRefs must be an array`);
  const maxIndex = verifyCommands.length - 1;
  return uniqueStrings(value.map((item) => {
    if (Number.isInteger(item)) {
      if (item < 0 || item > maxIndex) throw new Error(`${label} verifierCommandRefs contains out-of-range index`);
      return String(item);
    }
    if (typeof item !== "string" || item.trim().length === 0) throw new Error(`${label} verifierCommandRefs must contain command strings or indexes`);
    const trimmed = item.trim();
    if (/^\d+$/.test(trimmed)) {
      const index = Number(trimmed);
      if (index < 0 || index > maxIndex) throw new Error(`${label} verifierCommandRefs contains out-of-range index`);
      return trimmed;
    }
    if (!verifyCommands.includes(trimmed)) throw new Error(`${label} verifierCommandRefs references an unknown verify command`);
    return trimmed;
  }));
}

/** 是否仍是建单时无 verify 命令生成、未经编辑的默认标准；这类标准不绑定命令就永远无法通过。 */
export function hasUnboundDefaultCriteria(task) {
  const seeds = seedDefaultSuccessCriteria(task.id, task.subject, []);
  const criteria = task.successCriteria || [];
  return criteria.length === seeds.length && criteria.every((criterion, index) => criterion.id === seeds[index].id
    && criterion.title === seeds[index].title && criterion.scenario === seeds[index].scenario
    && criterion.status === "pending" && !criterion.evidence?.length && !criterion.verifierCommandRefs?.length);
}

/** 为新任务生成默认 successCriteria 条目。 */
function seedDefaultSuccessCriteria(taskId, subject, verifyCommands) {
  const verifierText = verifyCommands.join(" && ");
  const verifierCommandRefs = verifyCommands.map((_, index) => String(index));
  return [
    {
      id: "C001",
      title: "happy path passes",
      scenario: `${subject} 的主路径行为符合目标。`,
      expectedEvidence: verifierText || "主路径 verifier evidence",
      status: "pending",
      evidence: [],
      verifierCommandRefs,
      lastUpdatedAt: null,
    },
    {
      id: "C002",
      title: "edge conditions considered",
      scenario: `${subject} 的关键边界条件没有被跳过。`,
      expectedEvidence: verifierText || "边界条件 verifier evidence",
      status: "pending",
      evidence: [],
      verifierCommandRefs,
      lastUpdatedAt: null,
    },
    {
      id: "C003",
      title: "regression guard passes",
      scenario: `${subject} 不破坏既有关键行为。`,
      expectedEvidence: verifierText || "回归保护 verifier evidence",
      status: "pending",
      evidence: [],
      verifierCommandRefs,
      lastUpdatedAt: null,
    },
  ];
}

/** 校验任务 status 是否为允许枚举值。 */
function validateStatus(status) {
  if (!TASK_STATUSES.has(status)) {
    throw new Error(`invalid task status: ${status}`);
  }
  return status;
}

/** 校验计划任务图：blockedBy 无环、引用存在等。 */
export function validatePlanGraph(plan) {
  const ids = new Set();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (!Array.isArray(task.blockedBy)) throw new Error(`task ${task.id} blockedBy must be an array`);
    const blockers = new Set();
    for (const blocker of task.blockedBy) {
      if (typeof blocker !== "string" || blocker.trim().length === 0) {
        throw new Error(`task ${task.id} blockedBy must contain task ids`);
      }
      if (blocker === task.id) throw new Error(`task ${task.id} cannot block itself`);
      if (blockers.has(blocker)) throw new Error(`task ${task.id} has duplicate blocker: ${blocker}`);
      blockers.add(blocker);
    }
  }

  const tasksById = new Map(plan.tasks.map((task) => [task.id, task]));
  for (const task of plan.tasks) {
    for (const blocker of task.blockedBy) {
      if (!ids.has(blocker)) throw new Error(`task ${task.id} blockedBy references unknown task: ${blocker}`);
      const dependency = tasksById.get(blocker);
      if ((dependency.repositoryTarget || "project") !== (task.repositoryTarget || "project")) {
        throw new Error(`task ${task.id} depends on ${blocker} from another repository; split cross-repository work into separate deliveries and bind their SHAs with integration accept`);
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(taskId) {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      const cycleStart = stack.indexOf(taskId);
      const cycle = [...stack.slice(cycleStart), taskId].join(" -> ");
      throw new Error(`task dependency cycle detected: ${cycle}`);
    }
    visiting.add(taskId);
    stack.push(taskId);
    const task = tasksById.get(taskId);
    for (const blocker of task.blockedBy) visit(blocker);
    stack.pop();
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const task of plan.tasks) visit(task.id);
  return plan;
}

/** 为单任务 enrich route_decision 字段。 */
export function enrichTaskWithRouteDecision(task, routes) {
  const routeDecision = resolveRouteDecision(routes, `${task.subject}\n${task.description}`);
  task.route_decision = routeDecision;
  if (task.category_source !== "explicit") {
    task.category = routeDecision.category || "deep";
    task.category_source = "route";
  }
  task.skills = uniqueStrings([...(task.skills || []), ...(routeDecision.skills || [])]);
  return task;
}
