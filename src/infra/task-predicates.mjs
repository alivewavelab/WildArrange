// =============================================================================
// 文件名称：task-predicates.mjs
// 所属模块：infra
// 作用说明：
//   纯函数任务谓词（无 I/O）：任务是否可运行（唯一口径，运行时与上下文快照共用）、
//   是否可能为 no-op、命令是否 trivial。
//
// 【运行原理速读】
//   可以把它想成「任务是否在做真活的体检规则」：
//
//   · 何时执行？
//     验收门禁、门武装评估、doctor 扫描活跃任务时。
//
//   · 它做了什么？
//     ① 检查 worker/verify 是否全为 true/echo 等空转 ② writable_paths 是否为空。
//
//   · 和其他部分的关系？
//     gate-arming 依赖 isTrivialCommand 判断 verify/review 是否形同虚设。
// =============================================================================

/**
 * 判断任务是否可能为无实质工作的 no-op（空 worker + trivial verify + 无可写路径）。
 * @param {object|null|undefined} task 任务对象
 * @returns {boolean}
 */
export function isPossibleNoopTask(task) {
  const workerCommand = task?.worker_command || null;
  const verifyCommands = Array.isArray(task?.verify_commands) ? task.verify_commands : [];
  const writablePaths = Array.isArray(task?.writable_paths) ? task.writable_paths : [];
  const emptyWorker = !workerCommand || isTrivialCommand(workerCommand);
  const trivialVerify = verifyCommands.length > 0 && verifyCommands.every(isTrivialCommand);
  return emptyWorker && trivialVerify && writablePaths.length === 0;
}

/**
 * 判定命令是否 trivial（空转、echo、版本探针）。
 * @param {unknown} command shell 命令字符串
 * @returns {boolean}
 */
export function isTrivialCommand(command) {
  const normalized = String(command || "").replace(/\s+/g, " ").trim();
  if (normalized === "" || /^(?:true|echo(?:\s+.*)?)$/i.test(normalized)) return true;
  if (/^(?:node|node\.exe)(?:\s+--(?:version|help)|\s+-v)$/i.test(normalized)) return true;
  // 整条命令只是空转退出才算 trivial；夹带任何真实逻辑（哪怕以
  // process.exit(0) 收尾）都是有效验证，不误伤。
  return /^node -e ["']process\.exit\(0\);?["']$/.test(normalized);
}


/** 列出尚未 completed 的前置任务 id；台账中不存在的前置视为已解除。 */
export function unresolvedTaskBlockers(task, tasks) {
  return (task.blockedBy || []).filter((blockerId) => {
    const blocker = tasks.find((candidate) => candidate.id === blockerId);
    return blocker && blocker.status !== "completed";
  });
}

/** 在任务列表中找第一条 isTaskRunnable 的任务。 */
export function findRunnableTask(tasks) {
  return tasks.find((task) => isTaskRunnable(task, tasks)) || null;
}

/** 判断任务是否 pending 且依赖已 completed。 */
export function isTaskRunnable(task, tasks) {
  // A pending task holding a parallel run or admission claim is owned by that
  // run; both claims are released (set to null) when the run closes or the
  // admission settles, which makes the task runnable again.
  return task?.status === "pending"
    && !task.parallel_run_claim?.runId
    && !task.admission_claim?.runId
    && unresolvedTaskBlockers(task, tasks).length === 0;
}

/** 按 status 计数（任意状态值均计入）。 */
export function countTasksByStatus(tasks) {
  const counts = {};
  for (const task of tasks || []) counts[task.status] = (counts[task.status] || 0) + 1;
  return counts;
}

/** 状态汇总的唯一投影：total 与各已知状态计数（status / runtime-snapshot 共用）。 */
export function summarizeTaskCounts(tasks) {
  const counts = countTasksByStatus(tasks);
  return {
    total: (tasks || []).length,
    draft: counts.draft || 0,
    completed: counts.completed || 0,
    pending: counts.pending || 0,
    in_progress: counts.in_progress || 0,
    verifying: counts.verifying || 0,
    failed: counts.failed || 0,
    review_blocked: counts.review_blocked || 0,
    needs_user_decision: counts.needs_user_decision || 0,
  };
}

/** Dashboard 看板阶段与任务状态的唯一映射；UI 只渲染，不自带副本。 */
export const WORKFLOW_STAGES = [
  { id: "not-started", label: "未开始", statuses: ["draft", "pending"] },
  { id: "developing", label: "开发中", statuses: ["in_progress"] },
  { id: "accepting", label: "验收中", statuses: ["verifying", "review_blocked", "needs_user_decision", "failed"] },
  { id: "passed", label: "已通过", statuses: ["completed"] },
];
