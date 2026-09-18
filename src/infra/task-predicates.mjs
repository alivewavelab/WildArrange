// =============================================================================
// 文件名称：task-predicates.mjs
// 所属模块：infra
// 作用说明：
//   纯函数任务形态谓词（无 I/O），判断任务是否可能为 no-op 或命令是否 trivial。
//   供 acceptance-proof 拦截空转任务，doctor 标记可疑 trivial 完成。
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
 * 对外暴露的 trivial 命令判定（与内部 trivialCommand 一致）。
 * @param {unknown} command shell 命令字符串
 * @returns {boolean}
 */
export function isTrivialCommand(command) {
  return trivialCommand(command);
}

function trivialCommand(command) {
  const normalized = String(command || "").replace(/\s+/g, " ").trim();
  if (normalized === "" || /^(?:true|echo(?:\s+.*)?)$/i.test(normalized)) return true;
  if (/^(?:node|node\.exe)(?:\s+--(?:version|help)|\s+-v)$/i.test(normalized)) return true;
  // 整条命令只是空转退出才算 trivial；夹带任何真实逻辑（哪怕以
  // process.exit(0) 收尾）都是有效验证，不误伤。
  return /^node -e ["']process\.exit\(0\);?["']$/.test(normalized);
}
