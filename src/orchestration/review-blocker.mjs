// =============================================================================
// 文件名称：review-blocker.mjs
// 所属模块：orchestration
// 作用说明：
//   review 阻塞项登记与解决：把 blocker 转成后续任务或关闭，禁止弱化措辞。
// =============================================================================
import { ensureWildArrangeDirs, nowIso } from "../infra/runtime-store.mjs";
import { transactWithLedger, withTaskStateLock } from "../infra/task-state-lock.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { loadTaskState, normalizeTask, validatePlanGraph } from "./plan-state.mjs";
import { persistTaskState } from "./task-board.mjs";
import { hasWeakeningLanguage } from "./change-governance.mjs";


/** 记录 review gate 阻塞并可选写入 ChangeRequest。 */
export async function recordReviewBlocker(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `review-blocker:${options.taskId || "unknown"}`, async () => {
    await ensureWildArrangeDirs(rootDir);
    const taskState = await loadTaskState(rootDir);
    if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");
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
    await transactWithLedger(rootDir, {
      type: "review_blocker_recorded",
      planId: taskState.planId,
      taskId: task.id,
      resolutionTaskId: blockerTask.id,
      evidence,
    }, () => persistTaskState(rootDir, taskState));
    await writeSnapshot(rootDir, "review_blocker_recorded", { planId: taskState.planId, taskId: task.id, resolutionTaskId: blockerTask.id });
    return { planId: taskState.planId, blockedTask: task, resolutionTask: blockerTask };
  });
}

/** 解析 review blocker，恢复任务 gate 流程。 */
export async function resolveReviewBlocker(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `review-blocker-resolve:${options.taskId || "unknown"}`, async () => {
    await ensureWildArrangeDirs(rootDir);
    const taskState = await loadTaskState(rootDir);
    if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");
    const task = taskState.tasks.find((candidate) => candidate.id === options.taskId);
    if (!task) throw new Error(`unknown task: ${options.taskId}`);
    if (task.status !== "review_blocked") throw new Error(`task ${task.id} is ${task.status}; cannot resolve review blocker`);
    const evidence = typeof options.evidence === "string" ? options.evidence.trim() : "";
    const rationale = typeof options.rationale === "string" ? options.rationale.trim() : "";
    if (!evidence) throw new Error("review blocker resolution evidence is required");
    if (!rationale) throw new Error("review blocker resolution rationale is required");
    if (hasWeakeningLanguage(`${evidence}\n${rationale}`)) throw new Error("review blocker resolution appears to weaken verification");
    const resolutionTaskId = task.reviewBlocker?.resolutionTaskId;
    const resolutionTask = resolutionTaskId
      ? taskState.tasks.find((candidate) => candidate.id === resolutionTaskId)
      : null;
    if (!resolutionTask) throw new Error(`task ${task.id} has no recorded review blocker resolution task`);
    if (resolutionTask.status !== "completed") throw new Error(`resolution task ${resolutionTask.id} is ${resolutionTask.status}; complete it before unblocking ${task.id}`);
    task.status = "pending";
    task.reviewBlocker = { ...task.reviewBlocker, resolvedAt: nowIso(), resolutionEvidence: evidence, resolutionRationale: rationale };
    task.updatedAt = nowIso();
    await transactWithLedger(rootDir, {
      type: "review_blocker_resolved",
      planId: taskState.planId,
      taskId: task.id,
      resolutionTaskId,
      evidence,
    }, () => persistTaskState(rootDir, taskState));
    await writeSnapshot(rootDir, "review_blocker_resolved", { planId: taskState.planId, taskId: task.id, resolutionTaskId });
    return { planId: taskState.planId, unblockedTask: task, resolutionTask };
  });
}

/** 在现有 tasks 中生成下一个可用 Txxx 编号。 */
function nextTaskId(tasks) {
  const max = tasks.reduce((current, task) => {
    const match = /^T(\d+)$/.exec(task.id);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `T${String(max + 1).padStart(3, "0")}`;
}
