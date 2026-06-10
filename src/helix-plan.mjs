import { writeFile } from "node:fs/promises";
import {
  STATE_VERSION,
  TASK_STATUSES,
  appendLedger,
  createWorkId,
  ensureHelixDirs,
  nowIso,
  readJson,
  resolveHelixPath,
  withTaskStateLock,
  writeJsonAtomic,
  writeSnapshot,
} from "./helix-foundation.mjs";
import { loadRoutesConfig, resolveRouteDecision } from "./helix-routing.mjs";

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
    skills: normalizeStringArray(rawDefaults.skills ?? rawPlan.skills ?? [], "defaults.skills"),
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

export function normalizeTask(task, index, defaults = {}) {
  if (!task || typeof task !== "object") {
    throw new Error(`task ${index + 1} must be an object`);
  }
  const id = task.id || `T${String(index + 1).padStart(3, "0")}`;
  const subject = task.subject || task.title;
  if (!subject) throw new Error(`task ${id} subject is required`);

  const taskVerifyCommands = normalizeStringArray(task.verify_commands ?? task.verifyCommands ?? [], `task ${id} verify_commands`);
  const verifyCommands = uniqueStrings([...(defaults.verify_commands || []), ...taskVerifyCommands]);
  if (verifyCommands.length === 0) {
    throw new Error(`task ${id} requires at least one verify command`);
  }
  const taskReviewCommands = normalizeStringArray(task.review_commands ?? task.reviewCommands ?? [], `task ${id} review_commands`);
  const reviewCommands = uniqueStrings([...(defaults.review_commands || []), ...taskReviewCommands]);
  const taskStandardsCommands = normalizeStringArray(task.standards_commands ?? task.standardsCommands ?? [], `task ${id} standards_commands`);
  const standardsCommands = uniqueStrings([...(defaults.standards_commands || []), ...taskStandardsCommands]);
  const taskWritablePaths = normalizeStringArray(task.writable_paths ?? task.writablePaths ?? [], `task ${id} writable_paths`);
  const writablePaths = uniqueStrings([...(defaults.writable_paths || []), ...taskWritablePaths]);
  const taskSkills = normalizeStringArray(task.skills ?? [], `task ${id} skills`);
  const skills = uniqueStrings([...(defaults.skills || []), ...taskSkills]);
  const successCriteria = normalizeSuccessCriteria(task.successCriteria ?? task.success_criteria, id, subject, verifyCommands);

  return {
    id,
    subject,
    description: task.description || subject,
    category: task.category || null,
    category_source: task.category ? "explicit" : "unresolved",
    status: validateStatus(task.status || "pending"),
    owner: task.owner || "Atlas",
    attempts: Number.isInteger(task.attempts) ? task.attempts : 0,
    maxAttempts: Number.isInteger(task.maxAttempts) ? task.maxAttempts : 3,
    blockedBy: normalizeStringArray(task.blockedBy ?? [], `task ${id} blockedBy`),
    writable_paths: writablePaths,
    worker_command: task.worker_command || task.workerCommand || null,
    verify_commands: verifyCommands,
    review_commands: reviewCommands,
    standards_commands: standardsCommands,
    successCriteria,
    skills,
    route_decision: task.route_decision || null,
    evidence: Array.isArray(task.evidence) ? task.evidence : [],
    createdAt: task.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

function normalizeSuccessCriteria(value, taskId, subject, verifyCommands) {
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
      lastUpdatedAt: criterion.lastUpdatedAt || null,
    };
  });
}

function seedDefaultSuccessCriteria(taskId, subject, verifyCommands) {
  const verifierText = verifyCommands.join(" && ");
  return [
    {
      id: "C001",
      title: "happy path passes",
      scenario: `${subject} 的主路径行为符合目标。`,
      expectedEvidence: verifierText || "主路径 verifier evidence",
      status: "pending",
      evidence: [],
      lastUpdatedAt: null,
    },
    {
      id: "C002",
      title: "edge conditions considered",
      scenario: `${subject} 的关键边界条件没有被跳过。`,
      expectedEvidence: verifierText || "边界条件 verifier evidence",
      status: "pending",
      evidence: [],
      lastUpdatedAt: null,
    },
    {
      id: "C003",
      title: "regression guard passes",
      scenario: `${subject} 不破坏既有关键行为。`,
      expectedEvidence: verifierText || "回归保护 verifier evidence",
      status: "pending",
      evidence: [],
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
  await ensureHelixDirs(rootDir);
  const rawPlan = await readJson(planPath);
  const plan = normalizePlan(rawPlan);
  await enrichPlanWithRoutes(rootDir, plan);
  const targetPath = resolveHelixPath(rootDir, "plans", `${plan.id}.json`);
  await writeJsonAtomic(targetPath, plan);
  await writeJsonAtomic(resolveHelixPath(rootDir, "team", "tasks.json"), {
    version: STATE_VERSION,
    planId: plan.id,
    tasks: plan.tasks,
    updatedAt: nowIso(),
  });
  await writeTasksMarkdown(rootDir, plan);

  const work = await readJson(resolveHelixPath(rootDir, "work.json"), {
    version: STATE_VERSION,
    workId: createWorkId(),
    createdAt: nowIso(),
  });
  await writeJsonAtomic(resolveHelixPath(rootDir, "work.json"), {
    ...work,
    stage: "planned",
    activePlanId: plan.id,
    status: "ready",
    updatedAt: nowIso(),
  });

  await appendLedger(rootDir, { type: "plan_imported", planId: plan.id, taskCount: plan.tasks.length });
  await writeSnapshot(rootDir, "planned", { planId: plan.id });
  return plan;
}

export async function enrichPlanWithRoutes(rootDir, plan) {
  const routes = await loadRoutesConfig(rootDir);
  for (const task of plan.tasks) {
    enrichTaskWithRouteDecision(task, routes);
  }
  await appendLedger(rootDir, {
    type: "plan_routed",
    planId: plan.id,
    routes: plan.tasks.map((task) => ({
      taskId: task.id,
      category: task.category,
      primaryAgent: task.route_decision?.primaryAgent,
      skills: task.skills,
    })),
  });
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

  await writeFile(resolveHelixPath(rootDir, "team", "tasks.md"), `${lines.join("\n")}\n`, "utf8");
}

export async function loadTaskState(rootDir) {
  return readJson(resolveHelixPath(rootDir, "team", "tasks.json"), null);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}
