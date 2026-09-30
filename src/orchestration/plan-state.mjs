// =============================================================================
// 文件名称：plan-state.mjs
// 所属模块：orchestration
// 作用说明：
//   计划导入与批准：计划规范化、导入事务、批准、路由 enrichment、work.json
//   计划状态唯一写入口与 tasks.md 派生。任务字段规范化在 task-normalize；
//   权威 taskState（team/tasks.json）的读取在 infra/task-state-store。
//
// 【运行原理速读】
//   可以把它想成「计划 JSON 的编译器与入库员」：
//
//   · 何时执行？
//     plan import/approve、任务 ready、编排层读 loadTaskState 时。
//
//   · 做了什么？
//     normalize → validate → 写 ledger → persist → 可选写 Markdown 镜像。
// =============================================================================
import { responsibilityDigest, renderResponsibilityChanges } from "../infra/responsibility-contract.mjs";
import { writeFile } from "node:fs/promises";
import { COMMAND_WORKER_AGENTS } from "../infra/agent-registry.mjs";
import {
  STATE_VERSION,
  createWorkId,
  hashContent,
  ensureWildArrangeDirs,
  nowIso,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import {
  loadTaskLedger,
  loadTaskState,
  replacePlanTasks,
  withTaskIdentity,
} from "../infra/task-state-store.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { transactWithLedger, withTaskStateLock } from "../infra/task-state-lock.mjs";
import { uniqueStrings } from "../infra/text-utils.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { assertFeatureDesignPlanBinding, bindFeatureDesignPlan } from "./feature-design.mjs";
import { loadRoutesConfig, resolveRouteDecision } from "../infra/route-table.mjs";
import { isTrivialCommand } from "../infra/task-predicates.mjs";
import { loadGovernanceVerificationDefaults } from "../infra/workspace-context.mjs";
import {
  enrichTaskWithRouteDecision,
  normalizeOptionalText,
  normalizeSkillArray,
  normalizeStringArray,
  normalizeTask,
  validatePlanGraph,
} from "./task-normalize.mjs";

// --- 规范化 ---

/** 规范化计划对象：title、tasks、defaults 等必填与结构约束。 */
function normalizePlan(rawPlan) {
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
    generated_by: normalizeOptionalText(rawPlan.generated_by, "plan.generated_by"),
    feature_design_ref: normalizeOptionalText(rawPlan.feature_design_ref, "plan.feature_design_ref"),
    request_summary: normalizeOptionalText(rawPlan.request_summary, "plan.request_summary"),
    defaults,
    createdAt: rawPlan.createdAt || nowIso(),
    updatedAt: nowIso(),
    tasks: rawPlan.tasks.map((task, index) => normalizeTask(task, index, defaults)),
  };
  validatePlanGraph(plan);
  return plan;
}

/** 归一化计划 defaults 段（skills、verify 等）。 */
function normalizePlanDefaults(rawPlan) {
  const rawDefaults = rawPlan.defaults && typeof rawPlan.defaults === "object" ? rawPlan.defaults : {};
  const defaults = {
    verify_commands: normalizeStringArray(rawDefaults.verify_commands ?? rawPlan.verify_commands ?? [], "defaults.verify_commands"),
    review_commands: normalizeStringArray(rawDefaults.review_commands ?? rawPlan.review_commands ?? [], "defaults.review_commands"),
    standards_commands: normalizeStringArray(rawDefaults.standards_commands ?? rawPlan.standards_commands ?? [], "defaults.standards_commands"),
    writable_paths: normalizeStringArray(rawDefaults.writable_paths ?? rawPlan.writable_paths ?? [], "defaults.writable_paths"),
    skills: normalizeSkillArray(rawDefaults.skills ?? rawPlan.skills ?? [], "defaults.skills"),
  };
  return defaults;
}

// --- 导入与批准 ---

/** 从 JSON 文件导入计划：规范化、校验、写 taskState 与 ledger。 */
export async function importPlan(rootDir, planPath, options = {}) {
  return withTaskStateLock(rootDir, "import-plan", () => importPlanUnlocked(rootDir, planPath, options));
}

/** 锁内执行计划导入、合并 ledger 与 route enrichment。 */
async function importPlanUnlocked(rootDir, planPath, options) {
  await ensureWildArrangeDirs(rootDir);
  const rawPlan = await readJson(planPath);
  const governanceBinding = await loadGovernanceVerificationDefaults(rootDir);
  const plan = normalizePlan(applyGovernanceDefaults(rawPlan, governanceBinding));
  const governanceTasks = plan.tasks.filter((task) => task.repositoryTarget === "governance");
  if (governanceTasks.length > 0 && !governanceBinding) {
    throw new Error(`governance repository tasks require an attached external governance workspace: ${governanceTasks.map((task) => task.id).join(", ")}`);
  }
  if (governanceBinding) {
    plan.governance_binding = {
      registryPath: governanceBinding.registryRelativePath,
      registryDigest: governanceBinding.registryDigest,
      projectRevision: governanceBinding.projectRevision,
      governanceRevision: governanceBinding.governanceRevision,
      boundAt: nowIso(),
    };
    plan.tasks = plan.tasks.map((task) => ({ ...task, governance_binding: plan.governance_binding }));
  }
  validateSemanticGeneratedPlan(plan);
  if (options.requireResponsibility === true || plan.generated_by === "host_semantic") {
    for (const task of plan.tasks) {
      if (!task.responsibilityChanges) throw new Error(`task ${task.id} requires responsibilityChanges before plan approval`);
    }
  }
  await enrichPlanWithRoutes(rootDir, plan);
  validatePlanImportQuality(plan);
  const featureDesignGate = await assertFeatureDesignPlanBinding(rootDir, plan);
  const existingLedger = await loadTaskLedger(rootDir);
  assertPlanImportDoesNotReplaceActiveWork(existingLedger, plan);
  const taskLedger = mergePlanIntoTaskLedger(existingLedger, plan);
  const targetPath = resolveWildArrangePath(rootDir, "plans", `${plan.id}.json`);
  // plans/<id>.json 只是导入时的只读快照（计划元数据 + defaults，不含 tasks）；
  // 任务状态只存在于 team/tasks.json。
  const { tasks: _tasks, ...planSnapshot } = plan;

  const { config } = await loadWildArrangeConfig(rootDir);
  const approvalRequired = plan.generated_by === "host_semantic" || plan.tasks.some((task) => task.responsibilityChanges) || config?.planApproval?.required === true;
  // 审计先行：plan_imported 入账本后才提交 plan/tasks.json/work.json 等实际
  // 状态，与完成路径 commitTaskCompletionState 同一方向（ARC-003）。
  await transactWithLedger(rootDir, {
    responsibilityAuditRequired: plan.generated_by === "host_semantic" || plan.tasks.some((task) => task.responsibilityChanges),
    type: "plan_imported",
    planId: plan.id,
    taskCount: plan.tasks.length,
    generatedBy: plan.generated_by,
    approvalRequired,
  }, async () => {
    await writeJsonAtomic(targetPath, planSnapshot);
    await writeTasksMarkdown(rootDir, plan);
    await writeJsonAtomic(resolveWildArrangePath(rootDir, "team", "tasks.json"), taskLedger);
    await updateWorkState(rootDir, (work) => ({
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
    }));
  });
  await bindFeatureDesignPlan(rootDir, featureDesignGate, plan.id);
  await writeSnapshot(rootDir, "planned", { planId: plan.id });
  return plan;
}

/** 外置治理命令只做加法，项目计划不能覆盖或删减强制默认项。 */
function applyGovernanceDefaults(rawPlan, governanceBinding) {
  if (!governanceBinding) return rawPlan;
  const rawDefaults = rawPlan.defaults && typeof rawPlan.defaults === "object" ? rawPlan.defaults : {};
  const defaults = { ...rawDefaults };
  for (const field of ["verify_commands", "standards_commands", "review_commands"]) {
    const projectValues = rawDefaults[field] ?? [];
    if (!Array.isArray(projectValues)) throw new Error(`defaults.${field} must be an array`);
    defaults[field] = uniqueStrings([...governanceBinding.planDefaults[field], ...projectValues]);
  }
  return { ...rawPlan, defaults };
}

/** 导入前断言不会覆盖进行中的 active work。 */
function assertPlanImportDoesNotReplaceActiveWork(existingLedger, plan) {
  const protectedTasks = (existingLedger?.tasks || []).filter((task) => {
    const replacedByImport = task.planId === plan.id;
    const switchesAwayFromActivePlan = existingLedger?.activePlanId === task.planId && plan.id !== task.planId;
    if (!replacedByImport && !switchesAwayFromActivePlan) return false;
    if (replacedByImport && task.status === "completed") return true;
    return ["in_progress", "verifying", "recovery_required"].includes(task.status)
      || Boolean(task.parallel_run_claim);
  });
  if (protectedTasks.length === 0) return;
  const details = protectedTasks.map((task) => `${task.id}:${task.status}`).join(", ");
  throw new Error(`cannot import plan ${plan.id} while active task ownership must be preserved: ${details}`);
}

/** 校验语义生成计划的额外质量规则。 */
function validateSemanticGeneratedPlan(plan) {
  if (plan.generated_by !== "host_semantic") return plan;
  const invalidOwners = plan.tasks
    .filter((task) => task.owner_source !== "explicit" || !COMMAND_WORKER_AGENTS.includes(task.owner))
    .map((task) => task.id);
  if (invalidOwners.length > 0) {
    throw new Error(
      `semantic generated plan ${plan.id} requires explicit command-worker task.owner from ${COMMAND_WORKER_AGENTS.join(", ")} for: ${invalidOwners.join(", ")}`,
    );
  }
  const invalidWorkerCommands = plan.tasks
    .filter((task) => typeof task.worker_command !== "string" || isTrivialCommand(task.worker_command))
    .map((task) => task.id);
  if (invalidWorkerCommands.length > 0) {
    throw new Error(
      `semantic generated plan ${plan.id} requires a non-empty, non-trivial worker_command that implements writable_paths for: ${invalidWorkerCommands.join(", ")}; replace placeholders such as node --version or process.exit(0) with the real implementation command, or import an unmarked manual plan after external work is complete`,
    );
  }
  return plan;
}

/** 将新计划任务合并进全项目 task ledger。 */
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
  return replacePlanTasks(existingLedger, { ...plan, governance_binding: plan.governance_binding || null }, plan.tasks, { at, activate: true });
}

/** 读取当前计划是否需人类批准及批准状态。 */
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

/** 人类批准计划：写 plan_approved 账本事件并解除 run 阻塞。 */
export async function approvePlan(rootDir, options = {}) {
  return withTaskStateLock(rootDir, "approve-plan", async () => {
    const work = await readJson(resolveWildArrangePath(rootDir, "work.json"), null);
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
    const state = await loadTaskState(rootDir);
    await transactWithLedger(rootDir, { type: "plan_approved", planId: work.activePlanId, approver: nextApproval.approvedBy,
      responsibilityScopes: Object.fromEntries((state?.tasks || []).map((task) => [task.id, responsibilityDigest(task.responsibilityChanges)])),
      contractScopes: Object.fromEntries((state?.tasks || []).map((task) => [task.id, hashContent(JSON.stringify(task.contractChanges?.items || []))])) },
      () => updateWorkState(rootDir, (current) => ({ ...current, status: "ready", planApproval: nextApproval }), { createIfMissing: false }));
    return { planId: work.activePlanId, status: "approved", approval: nextApproval };
  });
}

/**
 * work.json 计划状态的唯一写入口：读改写并刷新 updatedAt。
 * mutate 收到当前 work（缺失时按 createIfMissing 决定用初始骨架还是跳过写入），返回新 work。
 */
export async function updateWorkState(rootDir, mutate, { createIfMissing = true } = {}) {
  const workPath = resolveWildArrangePath(rootDir, "work.json");
  const existing = await readJson(workPath, null);
  if (!existing && !createIfMissing) return null;
  const current = existing || { version: STATE_VERSION, workId: createWorkId(), createdAt: nowIso() };
  const next = { ...mutate(current), updatedAt: nowIso() };
  await writeJsonAtomic(workPath, next);
  return next;
}

// --- 路由 enrichment ---

/** 为计划各任务解析并写入 route_decision。 */
async function enrichPlanWithRoutes(rootDir, plan) {
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

/** 导入质量门禁：noop/trivial 任务等启发式检查。 */
function validatePlanImportQuality(plan) {
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


/** 将计划任务写入派生 tasks.md 镜像（非权威状态）。 */
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
    lines.push(...renderResponsibilityChanges(task.responsibilityChanges));
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

/** 从权威 store 加载当前 taskState（re-export）。 */
export { loadTaskState };
