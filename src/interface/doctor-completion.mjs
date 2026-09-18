// =============================================================================
// 文件名称：doctor-completion.mjs
// 所属模块：interface
// 作用说明：
//   doctor 的「完成态完整性」分项：校验已完成任务的证据链、账本一致性与派生视图分叉。
//   只追加 findings，不修改任务或 ledger。
//
// 【运行原理速读】
//   可以把它想成「完成声称的审计员」：
//
//   · 谁调用？
//     doctor.mjs 的 completionAudit 检查项。
//
//   · 它做了什么？
//     ① 校验 checkpoint/acceptance_proof/ledger 完成事件 ② 检测孤儿完成事件
//     ③ 对比 plan JSON、tasks.md 与 canonical tasks.json ④ 检查 delivery worktree 漂移。
//
//   · 缺了它会怎样？
//     「标记 completed 但无证据」或账本/镜像分叉无法在一键体检中被发现。
// =============================================================================
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  readJson,
  resolveWildArrangePath,
} from "../infra/runtime-store.mjs";
import { readVerifiedLedgerEntries } from "../infra/ledger.mjs";
import { isPossibleNoopTask, isTrivialCommand } from "../infra/task-predicates.mjs";
import { inspectCompletedTaskEvidence, loadTaskLedger, taskRef } from "../infra/task-state-store.mjs";
import { normalizeRelativePath } from "../infra/path-match.mjs";
import { inspectTaskWorktreeBaseline } from "../infra/git-coordination.mjs";

/** 视为「任务完成」的 ledger 事件类型，用于孤儿完成事件与证据链对账。 */
const COMPLETION_LEDGER_EVENT_TYPES = new Set([
  "task_verified",
  "node_checkpoint_completed",
  "parallel_agent_admission_completed",
]);

/** 向 doctor findings 数组追加一条分项结论（severity/section/message）。 */
function addFinding(findings, severity, section, message, extra = {}) {
  findings.push({ severity, section, message, ...extra });
}

/**
 * 审计已完成与待重验任务的证据链；发现写入 findings 数组。
 * @param {string} rootDir
 * @param {Array<{ severity: string, section: string, message: string }>} findings
 * @returns {Promise<Record<string, unknown>>} 分项摘要计数
 */
export async function checkCompletionIntegrity(rootDir, findings) {
  const taskLedger = await loadTaskLedger(rootDir);
  if (!taskLedger) {
    return { checkedCompleted: 0, note: "no imported plan" };
  }
  const tasks = taskLedger.tasks || [];
  const completionEvents = await collectCompletionLedgerEvents(rootDir, tasks);
  for (const ambiguous of completionEvents.ambiguousLegacy) {
    addFinding(
      findings,
      "error",
      "completion_audit",
      `legacy completion event for task ${ambiguous.taskId} has no planId and cannot be assigned to a current Plan; current candidates: ${ambiguous.planIds.join(", ")}`,
      {
        code: "ambiguous_legacy_completion_event",
        taskId: ambiguous.taskId,
        planIds: ambiguous.planIds,
        eventTypes: ambiguous.eventTypes,
      },
    );
  }
  const completedTasks = tasks.filter((task) => task.status === "completed");
  const evidenceIntegrity = await inspectCompletedTaskEvidence(rootDir, taskLedger);
  for (const invalid of evidenceIntegrity.invalid) {
    const evidenceMessages = [];
    if (invalid.failures.includes("checkpoint_identity")) {
      evidenceMessages.push(invalid.checkpointPresent ? "has an invalid checkpoint identity" : "is completed but has no checkpoint file");
    }
    if (invalid.failures.includes("acceptance_proof")) {
      evidenceMessages.push(invalid.proofPresent ? "has an invalid acceptance proof" : "is completed but has no acceptance proof report");
    }
    if (invalid.failures.includes("ledger_event")) evidenceMessages.push("is completed but the ledger has no completion event");
    if (invalid.failures.includes("delivery_commit_missing")) evidenceMessages.push("has no delivery commit bound across proof and checkpoint");
    if (invalid.failures.includes("delivery_commit_mismatch")) evidenceMessages.push("has different delivery commits in proof and checkpoint");
    addFinding(findings, "error", "completion_audit", `task ${invalid.taskRef} ${evidenceMessages.join("; ") || `has invalid completion evidence (${invalid.failures.join(", ")})`}`, {
      planId: invalid.planId,
      taskId: invalid.taskId,
      taskRef: invalid.taskRef,
      failures: invalid.failures,
      proofSha: invalid.proofSha,
      checkpointSha: invalid.checkpointSha,
    });
  }
  let audited = 0;
  let revalidationRequired = 0;
  for (const task of tasks) {
    if (task.completionRevalidation?.required !== true) continue;
    revalidationRequired += 1;
    const migrated = Boolean(task.completionRevalidation.migratedAt);
    addFinding(findings, migrated ? "warn" : "error", "completion_audit", `task ${task.ref || taskRef(task.planId, task.id)} was marked completed by legacy state but lacks the current proof chain; ${migrated ? "migration safely moved it to needs_user_decision" : "run state migrate, then revalidate it through the normal delivery pipeline"}`, {
      planId: task.planId,
      taskId: task.id,
      taskRef: task.ref || taskRef(task.planId, task.id),
      previousStatus: task.completionRevalidation.previousStatus,
      migratedAt: task.completionRevalidation.migratedAt || null,
    });
  }
  for (const task of completedTasks) {
    audited += 1;
    const planId = task.planId || taskLedger.activePlanId;
    const ref = taskRef(planId, task.id);
    if (!Array.isArray(task.verify_commands) || task.verify_commands.length === 0) {
      addFinding(findings, "error", "completion_audit", `task ${ref} is completed with empty verify_commands`, { planId, taskId: task.id, taskRef: ref });
    } else if (task.verify_commands.every(isTrivialCommand)) {
      addFinding(findings, "warn", "completion_audit", `task ${ref} is completed but every verify command is trivial (e.g. \`true\`); the verification proves nothing`, { planId, taskId: task.id, taskRef: ref });
    }
    if (isPossibleNoopTask(task)) {
      addFinding(findings, "warn", "completion_audit", `task ${ref} looks like a no-op task (trivial worker + trivial verifier + no writable paths)`, { planId, taskId: task.id, taskRef: ref });
    }
  }

  let deliveryWorktreesChecked = 0;
  let deliveryWorktreeDrifts = 0;
  const projectRoot = path.resolve(rootDir);
  for (const task of completedTasks) {
    const workDir = task.delivery_workspace?.workDir;
    if (!workDir) continue;
    const absoluteWorkDir = path.resolve(rootDir, workDir);
    if (!existsSync(absoluteWorkDir)) continue;
    deliveryWorktreesChecked += 1;
    const planId = task.planId || taskLedger.activePlanId;
    const ref = taskRef(planId, task.id);
    const relativeWorkDir = path.relative(projectRoot, absoluteWorkDir);
    const outsideProject = relativeWorkDir.startsWith("..") || path.isAbsolute(relativeWorkDir);
    let actual;
    try {
      actual = outsideProject
        ? { available: false, clean: false, reason: "delivery worktree path is outside the project", changedPaths: [] }
        : await inspectTaskWorktreeBaseline(absoluteWorkDir);
    } catch (error) {
      actual = { available: false, clean: false, reason: error instanceof Error ? error.message : String(error), changedPaths: [] };
    }
    const expectedHead = task.delivery?.integrationSha
      || task.delivery?.commitSha
      || task.delivery?.actualSha
      || task.delivery_workspace?.deliverySha
      || null;
    const expectedBranch = task.delivery_workspace?.branch || task.delivery?.branch || null;
    const headMatches = !expectedHead || actual.headSha === expectedHead;
    const branchMatches = !expectedBranch || actual.branch === expectedBranch;
    if (actual.available === true && actual.clean === true && headMatches && branchMatches) continue;
    deliveryWorktreeDrifts += 1;
    addFinding(findings, "error", "completion_audit", `task ${ref} completed delivery worktree no longer matches its recorded clean state`, {
      code: "delivery_worktree_state_drift",
      planId,
      taskId: task.id,
      taskRef: ref,
      workDir: normalizeRelativePath(relativeWorkDir),
      expectedHead,
      actualHead: actual.headSha || null,
      expectedBranch,
      actualBranch: actual.branch || null,
      changedPaths: actual.changedPaths || [],
      reason: actual.reason || (!headMatches ? "delivery worktree HEAD changed" : "delivery worktree branch changed"),
    });
  }

  // 反向不一致（cross-review P2, round 4, 2026-07-21）：
  // 1) 未完成任务却已有账本完成事件 → 完成事务被中断，canonical 落盘失败。
  //    这是可恢复状态：wildarrange run 会自动裁决卡在 verifying 的任务。
  let orphanCompletionEvents = 0;
  for (const task of tasks) {
    if (task.status === "completed") continue;
    const planId = task.planId || taskLedger.activePlanId;
    const ref = taskRef(planId, task.id);
    if (completionEvents.refs.has(ref)) {
      orphanCompletionEvents += 1;
      addFinding(findings, "warn", "completion_audit", `task ${ref} is ${task.status} but the ledger already has a completion event; the completion transaction was interrupted before the canonical state was saved — activate plan ${planId}, then run \`wildarrange run\` (or \`wildarrange node checkpoint --task ${task.id}\`) to adjudicate it`, { planId, taskId: task.id, taskRef: ref, taskStatus: task.status });
    }
  }

  // 2) 完成后置副产物（快照/总结）写失败：完成状态本身不回退，但失败会
  //    以 completion_side_effect_failed 事件入账（round 5, 2026-07-21），
  //    doctor 把它们晒出来，避免"完成了但快照缺失"永远无人知晓。
  let sideEffectFailures = 0;
  for (const entry of await readVerifiedLedgerEntries(rootDir)) {
    if (entry.type !== "completion_side_effect_failed") continue;
    sideEffectFailures += 1;
    addFinding(findings, "warn", "completion_audit", `task ${entry.taskId} completed but a post-completion side effect failed (${entry.error || "unknown error"}); the snapshot/summary for that completion may be missing`, { taskId: entry.taskId });
  }

  // 3) 派生视图（plan JSON / tasks.md）与 canonical tasks.json 的状态分叉。
  const canonicalStatus = new Map(tasks.map((task) => [taskRef(task.planId || taskLedger.activePlanId, task.id), task.status]));
  let derivedDivergences = 0;
  const planIds = [...new Set(tasks.map((task) => task.planId).filter(Boolean))];
  for (const planId of planIds) {
    const planPath = resolveWildArrangePath(rootDir, "plans", `${planId}.json`);
    if (existsSync(planPath)) {
      const plan = await readJson(planPath);
      for (const planTask of plan?.tasks || []) {
        const ref = taskRef(planId, planTask.id);
        const canonical = canonicalStatus.get(ref);
        if (canonical && planTask.status !== canonical) {
          derivedDivergences += 1;
          addFinding(findings, "warn", "completion_audit", `task ${ref} status diverges between canonical tasks.json (${canonical}) and plan JSON (${planTask.status}); tasks.json is authoritative — the plan mirror was written by an interrupted transaction`, { planId, taskId: planTask.id, taskRef: ref, canonical, planStatus: planTask.status });
        }
      }
    }
  }
  const markdownPath = resolveWildArrangePath(rootDir, "team", "tasks.md");
  if (existsSync(markdownPath)) {
    const markdownStatus = parseTasksMarkdownStatuses(await readFile(markdownPath, "utf8"));
    for (const [taskId, mdStatus] of markdownStatus) {
      const ref = taskRef(taskLedger.activePlanId, taskId);
      const canonical = canonicalStatus.get(ref);
      if (canonical && mdStatus !== canonical) {
        derivedDivergences += 1;
        addFinding(findings, "warn", "completion_audit", `task ${ref} status diverges between canonical tasks.json (${canonical}) and tasks.md (${mdStatus}); tasks.json is authoritative`, { planId: taskLedger.activePlanId, taskId, taskRef: ref, canonical, markdownStatus: mdStatus });
      }
    }
  }

  return {
    checkedCompleted: audited,
    totalTasks: tasks.length,
    planCount: planIds.length,
    activePlanId: taskLedger.activePlanId,
    revalidationRequired,
    ambiguousLegacyCompletionEvents: completionEvents.ambiguousLegacy.length,
    orphanCompletionEvents,
    sideEffectFailures,
    derivedDivergences,
    invalidCompleted: evidenceIntegrity.invalid.length,
    deliveryWorktreesChecked,
    deliveryWorktreeDrifts,
  };
}

/** 从 team/tasks.md 解析 taskId → status 映射（供与 canonical tasks.json 对账）。 */
function parseTasksMarkdownStatuses(markdown) {
  const statuses = new Map();
  let currentTaskId = null;
  for (const line of markdown.split("\n")) {
    const checkboxMatch = line.match(/^- \[[x ]\] (\S+)\. /);
    if (checkboxMatch) {
      currentTaskId = checkboxMatch[1];
      continue;
    }
    const statusMatch = line.match(/^ {2}- Status: (\S+)/);
    if (statusMatch && currentTaskId) {
      statuses.set(currentTaskId, statusMatch[1]);
      currentTaskId = null;
    }
  }
  return statuses;
}

/** 从 hash 链校验通过的 ledger 收集完成事件 refs，并标记无 planId 的歧义遗留事件。 */
async function collectCompletionLedgerEvents(rootDir, tasks) {
  const refs = new Set();
  const planIdsByTaskId = new Map();
  for (const task of tasks) {
    if (!task.id || !task.planId) continue;
    if (!planIdsByTaskId.has(task.id)) planIdsByTaskId.set(task.id, new Set());
    planIdsByTaskId.get(task.id).add(task.planId);
  }
  const ambiguousByTaskId = new Map();
  // 只统计通过 hash 链校验的条目，手工追加的伪造完成事件不算证据
  const entries = await readVerifiedLedgerEntries(rootDir);
  for (const entry of entries) {
    if (!COMPLETION_LEDGER_EVENT_TYPES.has(entry.type) || !entry.taskId) continue;
    // 并行 admission 事件对失败结局也会写同名类型并带 status 字段；
    // 只有真正 completed 的结局才算完成证据。
    if (entry.type === "parallel_agent_admission_completed" && entry.status && entry.status !== "completed") continue;
    if (entry.planId) {
      refs.add(taskRef(entry.planId, entry.taskId));
      continue;
    }
    const candidatePlanIds = planIdsByTaskId.get(entry.taskId) || new Set();
    // Unscoped legacy events can never prove a current Plan completion. Even
    // when taskId is currently unique, an archived older Plan may have reused
    // it; inferring from today's ledger would silently transfer old evidence.
    if (candidatePlanIds.size > 0) {
      const current = ambiguousByTaskId.get(entry.taskId) || {
        taskId: entry.taskId,
        planIds: [...candidatePlanIds].sort(),
        eventTypes: new Set(),
      };
      current.eventTypes.add(entry.type);
      ambiguousByTaskId.set(entry.taskId, current);
    }
  }
  return {
    refs,
    ambiguousLegacy: [...ambiguousByTaskId.values()].map((entry) => ({
      ...entry,
      eventTypes: [...entry.eventTypes].sort(),
    })),
  };
}
