import { writeFile } from "node:fs/promises";
import {
  COMMAND_WORKER_AGENTS,
  DEFAULT_EXECUTOR_AGENT,
  normalizeAgentKey,
} from "../infra/agent-registry.mjs";
import {
  STATE_VERSION,
  TASK_PRIORITIES,
  TASK_SOURCES,
  TASK_STATUSES,
  TASK_WORK_TYPES,
  createWorkId,
  ensureWildArrangeDirs,
  nowIso,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import {
  loadTaskLedger,
  loadTaskState,
  withTaskIdentity,
} from "../infra/task-state-store.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { withTaskStateLock } from "../infra/task-state-lock.mjs";
import {
  assertFeatureDesignPlanBinding,
  bindFeatureDesignPlan,
  writeSnapshot,
} from "../infra/runtime-snapshot.mjs";
import { loadRoutesConfig, resolveRouteDecision } from "../infra/route-table.mjs";
import { isPossibleNoopTask, isTrivialCommand } from "../infra/task-predicates.mjs";

export function normalizePlan(rawPlan) {
  if (!rawPlan || typeof rawPlan !== "object") {
    throw new Error("plan must be a JSON object");
  }
  if (!rawPlan.title || typeof rawPlan.title !== "string") {
    throw new Error("plan.title is required");
  }
  if (!Array.isArray(rawPlan.tasks) || rawPlan.tasks.length === 0) {
    throw new Error("plan.tasks must contain at least one task");
  }

  const defaults = normalizePlanDefaults(rawPlan);
  const plan = {
    id: rawPlan.id || createWorkId("plan"),
    title: rawPlan.title,
    objective: rawPlan.objective || rawPlan.title,
    generated_by: normalizeOptionalText(rawPlan.generated_by ?? rawPlan.generatedBy, "plan.generated_by"),
    feature_design_ref: normalizeOptionalText(rawPlan.feature_design_ref ?? rawPlan.featureDesignRef, "plan.feature_design_ref"),
    request_summary: normalizeOptionalText(rawPlan.request_summary ?? rawPlan.requestSummary, "plan.request_summary"),
    defaults,
    createdAt: rawPlan.createdAt || nowIso(),
    updatedAt: nowIso(),
    tasks: rawPlan.tasks.map((task, index) => normalizeTask(task, index, defaults)),
  };
  validatePlanGraph(plan);
  return plan;
}

function normalizePlanDefaults(rawPlan) {
  const rawDefaults = rawPlan.defaults && typeof rawPlan.defaults === "object" ? rawPlan.defaults : {};
  const defaults = {
    verify_commands: normalizeStringArray(rawDefaults.verify_commands ?? rawDefaults.verifyCommands ?? rawPlan.verify_commands ?? rawPlan.verifyCommands ?? [], "defaults.verify_commands"),
    review_commands: normalizeStringArray(rawDefaults.review_commands ?? rawDefaults.reviewCommands ?? rawPlan.review_commands ?? rawPlan.reviewCommands ?? [], "defaults.review_commands"),
    standards_commands: normalizeStringArray(rawDefaults.standards_commands ?? rawDefaults.standardsCommands ?? rawPlan.standards_commands ?? rawPlan.standardsCommands ?? [], "defaults.standards_commands"),
    writable_paths: normalizeStringArray(rawDefaults.writable_paths ?? rawDefaults.writablePaths ?? rawPlan.writable_paths ?? rawPlan.writablePaths ?? [], "defaults.writable_paths"),
    skills: normalizeSkillArray(rawDefaults.skills ?? rawPlan.skills ?? [], "defaults.skills"),
  };
  return defaults;
}

export function normalizeStringArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return uniqueStrings(value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) throw new Error(`${label} must contain non-empty strings`);
    return item.trim();
  }));
}

function normalizeSkillArray(value, label) {
  const skills = normalizeStringArray(value, label);
  for (const skill of skills) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(skill)) {
      throw new Error(`${label} contains an invalid skill name: ${skill}`);
    }
  }
  return skills;
}

export function normalizeTask(task, index, defaults = {}, options = {}) {
  if (!task || typeof task !== "object") {
    throw new Error(`task ${index + 1} must be an object`);
  }
  const id = task.id || `T${String(index + 1).padStart(3, "0")}`;
  const subject = task.subject || task.title;
  if (!subject) throw new Error(`task ${id} subject is required`);

  const taskVerifyCommands = normalizeStringArray(task.verify_commands ?? task.verifyCommands ?? [], `task ${id} verify_commands`);
  const verifyCommands = uniqueStrings([...(defaults.verify_commands || []), ...taskVerifyCommands]);
  const requestedStatus = task.status || (options.defaultDraftWhenIncomplete === true && verifyCommands.length === 0 ? "draft" : "pending");
  if (verifyCommands.length === 0 && requestedStatus !== "draft") {
    throw new Error(`task ${id} requires at least one verify command`);
  }
  const taskReviewCommands = normalizeStringArray(task.review_commands ?? task.reviewCommands ?? [], `task ${id} review_commands`);
  const reviewCommands = uniqueStrings([...(defaults.review_commands || []), ...taskReviewCommands]);
  const taskStandardsCommands = normalizeStringArray(task.standards_commands ?? task.standardsCommands ?? [], `task ${id} standards_commands`);
  const standardsCommands = uniqueStrings([...(defaults.standards_commands || []), ...taskStandardsCommands]);
  const taskWritablePaths = normalizeStringArray(task.writable_paths ?? task.writablePaths ?? [], `task ${id} writable_paths`);
  const writablePaths = uniqueStrings([...(defaults.writable_paths || []), ...taskWritablePaths]);
  const taskSkills = normalizeSkillArray(task.skills ?? [], `task ${id} skills`);
  const skills = uniqueStrings([...(defaults.skills || []), ...taskSkills]);
  const successCriteria = normalizeSuccessCriteria(task.successCriteria ?? task.success_criteria, id, subject, verifyCommands);
  const governanceWarnings = detectTaskGovernanceWarnings({ workerCommand: task.worker_command || task.workerCommand || null, verifyCommands, writablePaths });
  const workType = normalizeWorkType(task.workType ?? task.work_type ?? inferWorkType(`${subject}\n${task.description || ""}`));
  const source = normalizeTaskSource(task.source || options.defaultSource || "imported");
  const priority = normalizeTaskPriority(task.priority || "P1");
  const parentTaskRef = normalizeOptionalText(task.parentTaskRef ?? task.parent_task_ref, `task ${id} parentTaskRef`);
  const request = normalizeTaskRequest(task.request, subject, source);
  const createdAt = task.createdAt || nowIso();
  const explicitOwner = normalizeOptionalText(task.owner, `task ${id} owner`);
  const owner = normalizeTaskOwner(explicitOwner || DEFAULT_EXECUTOR_AGENT, id);

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
    status: validateStatus(requestedStatus),
    owner,
    owner_source: explicitOwner ? "explicit" : "default",
    attempts: Number.isInteger(task.attempts) ? task.attempts : 0,
    maxAttempts: Number.isInteger(task.maxAttempts) ? task.maxAttempts : 3,
    blockedBy: normalizeStringArray(task.blockedBy ?? [], `task ${id} blockedBy`),
    writable_paths: writablePaths,
    worker_command: task.worker_command || task.workerCommand || null,
    verify_commands: verifyCommands,
    review_commands: reviewCommands,
    standards_commands: standardsCommands,
    successCriteria,
    governanceWarnings,
    skills,
    route_decision: task.route_decision || null,
    evidence: Array.isArray(task.evidence) ? task.evidence : [],
    history: Array.isArray(task.history) ? task.history : [{ at: createdAt, event: "created", status: validateStatus(requestedStatus), source }],
    createdAt,
    updatedAt: nowIso(),
  };
}

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

export function normalizeWorkType(value) {
  if (typeof value !== "string" || !TASK_WORK_TYPES.has(value)) {
    throw new Error(`invalid task workType: ${value}`);
  }
  return value;
}

export function normalizeTaskSource(value) {
  if (typeof value !== "string" || !TASK_SOURCES.has(value)) {
    throw new Error(`invalid task source: ${value}`);
  }
  return value;
}

export function normalizeTaskPriority(value) {
  const normalized = typeof value === "string" ? value.toUpperCase() : value;
  if (!TASK_PRIORITIES.has(normalized)) throw new Error(`invalid task priority: ${value}`);
  return normalized;
}

function inferWorkType(text) {
  if (/(验收.{0,8}(纠错|打回|修正)|acceptance.{0,8}(correction|rework))/i.test(text)) return "acceptance_correction";
  if (/(bug|缺陷|故障|报错|崩溃|修复)/i.test(text)) return "bug";
  if (/(新增|新功能|功能|feature|实现)/i.test(text)) return "feature";
  return "maintenance";
}

function normalizeOptionalText(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function normalizeTaskRequest(value, subject, source) {
  if (value === undefined || value === null) return { summary: subject, source, evidenceRefs: [] };
  if (typeof value === "string") return { summary: value.trim() || subject, source, evidenceRefs: [] };
  if (typeof value !== "object") throw new Error("task request must be a string or object");
  return {
    summary: typeof value.summary === "string" && value.summary.trim() ? value.summary.trim() : subject,
    source: normalizeTaskSource(value.source || source),
    evidenceRefs: normalizeStringArray(value.evidenceRefs ?? value.evidence_refs ?? [], "task request evidenceRefs"),
  };
}

function normalizeTaskOwner(value, taskId) {
  const normalized = normalizeAgentKey(value);
  if (!normalized) throw new Error(`task ${taskId} owner must be a non-empty agent name`);
  return normalized;
}

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

export { isPossibleNoopTask, isTrivialCommand } from "../infra/task-predicates.mjs";

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
      verifierCommandRefs: normalizeVerifierCommandRefs(criterion.verifierCommandRefs ?? criterion.verifier_command_refs, verifyCommands, `task ${taskId} criterion ${id}`),
      lastUpdatedAt: criterion.lastUpdatedAt || null,
    };
  });
}

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

export function validateStatus(status) {
  if (!TASK_STATUSES.has(status)) {
    throw new Error(`invalid task status: ${status}`);
  }
  return status;
}

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

  for (const task of plan.tasks) {
    for (const blocker of task.blockedBy) {
      if (!ids.has(blocker)) throw new Error(`task ${task.id} blockedBy references unknown task: ${blocker}`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const tasksById = new Map(plan.tasks.map((task) => [task.id, task]));
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

export async function importPlan(rootDir, planPath) {
  return withTaskStateLock(rootDir, "import-plan", () => importPlanUnlocked(rootDir, planPath));
}

async function importPlanUnlocked(rootDir, planPath) {
  await ensureWildArrangeDirs(rootDir);
  const rawPlan = await readJson(planPath);
  const plan = normalizePlan(rawPlan);
  await enrichPlanWithRoutes(rootDir, plan);
  validateSemanticGeneratedPlan(plan);
  validatePlanImportQuality(plan);
  const featureDesignGate = await assertFeatureDesignPlanBinding(rootDir, plan);
  const existingLedger = await loadTaskLedger(rootDir);
  const taskLedger = mergePlanIntoTaskLedger(existingLedger, plan);
  const targetPath = resolveWildArrangePath(rootDir, "plans", `${plan.id}.json`);
  await writeJsonAtomic(targetPath, plan);
  await writeTasksMarkdown(rootDir, plan);
  await writeJsonAtomic(resolveWildArrangePath(rootDir, "team", "tasks.json"), taskLedger);

  const { config } = await loadWildArrangeConfig(rootDir);
  const approvalRequired = plan.generated_by === "host_semantic" || config?.planApproval?.required === true;
  const work = await readJson(resolveWildArrangePath(rootDir, "work.json"), {
    version: STATE_VERSION,
    workId: createWorkId(),
    createdAt: nowIso(),
  });
  await writeJsonAtomic(resolveWildArrangePath(rootDir, "work.json"), {
    ...work,
    stage: "planned",
    activePlanId: plan.id,
    status: approvalRequired ? "awaiting_plan_approval" : "ready",
    planApproval: {
      required: approvalRequired,
      status: approvalRequired ? "pending" : "approved",
      planId: plan.id,
      updatedAt: nowIso(),
    },
    updatedAt: nowIso(),
  });
  await appendLedger(rootDir, {
    type: "plan_imported",
    planId: plan.id,
    taskCount: plan.tasks.length,
    generatedBy: plan.generated_by,
    approvalRequired,
  });
  await bindFeatureDesignPlan(rootDir, featureDesignGate, plan.id);
  await writeSnapshot(rootDir, "planned", { planId: plan.id });
  return plan;
}

export function validateSemanticGeneratedPlan(plan) {
  if (plan.generated_by !== "host_semantic") return plan;
  const invalidOwners = plan.tasks
    .filter((task) => task.owner_source !== "explicit" || !COMMAND_WORKER_AGENTS.includes(task.owner))
    .map((task) => task.id);
  if (invalidOwners.length > 0) {
    throw new Error(
      `semantic generated plan ${plan.id} requires explicit command-worker task.owner from ${COMMAND_WORKER_AGENTS.join(", ")} for: ${invalidOwners.join(", ")}`,
    );
  }
  return plan;
}

function mergePlanIntoTaskLedger(existingLedger, plan) {
  const at = nowIso();
  const previousTasks = new Map((existingLedger?.tasks || [])
    .filter((task) => task.planId === plan.id)
    .map((task) => [task.id, task]));
  plan.tasks = plan.tasks.map((task) => {
    const identified = withTaskIdentity(task, plan.id);
    const previous = previousTasks.get(task.id);
    if (!previous) return identified;
    return {
      ...identified,
      createdAt: previous.createdAt || identified.createdAt,
      history: [
        ...(previous.history || []),
        { at, event: "plan_reimported", status: identified.status, source: "imported" },
      ],
    };
  });
  const tasks = [
    ...(existingLedger?.tasks || []).filter((task) => task.planId !== plan.id),
    ...plan.tasks,
  ];
  const planEntry = {
    id: plan.id,
    title: plan.title,
    objective: plan.objective,
    taskIds: plan.tasks.map((task) => task.id),
    createdAt: (existingLedger?.plans || []).find((candidate) => candidate.id === plan.id)?.createdAt || plan.createdAt,
    updatedAt: at,
  };
  return {
    version: STATE_VERSION,
    kind: "task_ledger",
    planId: plan.id,
    activePlanId: plan.id,
    plans: [
      ...(existingLedger?.plans || []).filter((candidate) => candidate.id !== plan.id),
      planEntry,
    ],
    tasks,
    createdAt: existingLedger?.createdAt || at,
    updatedAt: at,
  };
}

export async function loadPlanApproval(rootDir) {
  const work = await readJson(resolveWildArrangePath(rootDir, "work.json"), null);
  const approval = work?.planApproval;
  if (!approval || approval.required !== true) {
    return { required: false, status: "approved", planId: approval?.planId || work?.activePlanId || null };
  }
  return {
    required: true,
    status: approval.status === "approved" ? "approved" : "pending",
    planId: approval.planId || work?.activePlanId || null,
  };
}

export async function approvePlan(rootDir, options = {}) {
  return withTaskStateLock(rootDir, "approve-plan", async () => {
    const workPath = resolveWildArrangePath(rootDir, "work.json");
    const work = await readJson(workPath, null);
    if (!work || !work.activePlanId) throw new Error("no imported plan found; run wildarrange plan --from <file>");
    if (options.planId && options.planId !== work.activePlanId) {
      throw new Error(`plan ${options.planId} is not the active plan (${work.activePlanId})`);
    }
    const nextApproval = {
      required: work.planApproval?.required === true,
      status: "approved",
      planId: work.activePlanId,
      approvedBy: options.approver || "user",
      approvedAt: nowIso(),
      note: options.note || "",
    };
    await writeJsonAtomic(workPath, {
      ...work,
      status: "ready",
      planApproval: nextApproval,
      updatedAt: nowIso(),
    });
    await appendLedger(rootDir, { type: "plan_approved", planId: work.activePlanId, approver: nextApproval.approvedBy });
    return { planId: work.activePlanId, status: "approved", approval: nextApproval };
  });
}

export async function enrichPlanWithRoutes(rootDir, plan) {
  const routes = await loadRoutesConfig(rootDir);
  const planRouteDecision = resolveRouteDecision(routes, `${plan.title}\n${plan.objective}`);
  plan.route_decision = planRouteDecision;
  for (const task of plan.tasks) {
    enrichTaskWithRouteDecision(task, routes);
  }
  await appendLedger(rootDir, {
    type: "plan_routed",
    planId: plan.id,
    planRoute: {
      route: planRouteDecision.route,
      intent: planRouteDecision.intent,
      risk: planRouteDecision.risk,
      planSkills: planRouteDecision.planSkills?.map((skill) => skill.name) || [],
    },
    routes: plan.tasks.map((task) => ({
      taskId: task.id,
      category: task.category,
      primaryAgent: task.route_decision?.primaryAgent,
      skills: task.skills,
    })),
  });
  return plan;
}

export function validatePlanImportQuality(plan) {
  const route = plan.route_decision;
  const planText = `${plan.title}\n${plan.objective}\n${plan.tasks.map((task) => `${task.subject}\n${task.description}`).join("\n")}`;
  const productLike = /(产品|用户|体验|页面|网页|工具|上传|视频|pdf|txt|互动|游戏|mvp|流程|多步骤|权限|协作|可视化)/i.test(planText);
  const highRiskPlanning = route?.route === "plan" && (route.risk === "high" || (route.planSkills || []).length >= 2);
  if (!productLike || !highRiskPlanning) return plan;

  if (plan.tasks.length < 4) {
    throw new Error(`high-risk product plan ${plan.id} requires at least 4 tasks: requirements/design, implementation, verification, and review/release`);
  }

  const hasVerificationTask = plan.tasks.some((task) => /(验收|测试|验证|复核|review|qa|acceptance)/i.test(`${task.subject}\n${task.description}`));
  if (!hasVerificationTask) {
    throw new Error(`high-risk product plan ${plan.id} requires an explicit verification/review task`);
  }
  return plan;
}

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

export async function writeTasksMarkdown(rootDir, plan) {
  const lines = [
    `# ${plan.title}`,
    "",
    `Objective: ${plan.objective}`,
    "",
    "## TODOs",
    "",
  ];

  for (const task of plan.tasks) {
    const checkbox = task.status === "completed" ? "[x]" : "[ ]";
    lines.push(`- ${checkbox} ${task.id}. ${task.subject}`);
    lines.push(`  - Status: ${task.status}`);
    lines.push(`  - Category: ${task.category || "unresolved"} (${task.category_source || "unknown"})`);
    if (Array.isArray(task.skills) && task.skills.length > 0) {
      lines.push(`  - Skills: ${task.skills.join(", ")}`);
    }
    if (task.route_decision) {
      lines.push(`  - Route: ${task.route_decision.route} -> ${task.route_decision.primaryAgent}`);
    }
    lines.push(`  - Verify: ${task.verify_commands.join(" && ")}`);
    if ((task.review_commands || []).length > 0) {
      lines.push(`  - Review: ${task.review_commands.join(" && ")}`);
    }
    if ((task.standards_commands || []).length > 0) {
      lines.push(`  - Standards: ${task.standards_commands.join(" && ")}`);
    }
    if (task.last_review_result) {
      lines.push(`  - Review Gate: ${task.last_review_result.pass ? "PASS" : "FAIL"} (${task.last_review_result.reportMdPath || "no report"})`);
    }
    if (task.last_change_request) {
      lines.push(`  - ChangeRequest: ${task.last_change_request.id} (${task.last_change_request.reportMdPath})`);
    }
    if (task.last_failure) {
      lines.push(`  - Last Failure: ${task.last_failure.reason}`);
      lines.push(`  - Retry Hint: ${task.last_failure.retryHint.replace(/\n/g, " / ")}`);
    }
  }

  await writeFile(resolveWildArrangePath(rootDir, "team", "tasks.md"), `${lines.join("\n")}\n`, "utf8");
}

export { loadTaskState };

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}
