/**
 * Pure task-shape predicates (no I/O). Used by acceptance-proof (capabilities)
 * to block no-op tasks, and by doctor (orchestration) to flag suspiciously
 * trivial completed tasks.
 */

export function isPossibleNoopTask(task) {
  const workerCommand = task?.worker_command || null;
  const verifyCommands = Array.isArray(task?.verify_commands) ? task.verify_commands : [];
  const writablePaths = Array.isArray(task?.writable_paths) ? task.writable_paths : [];
  const emptyWorker = !workerCommand || isTrivialCommand(workerCommand);
  const trivialVerify = verifyCommands.length > 0 && verifyCommands.every(isTrivialCommand);
  return emptyWorker && trivialVerify && writablePaths.length === 0;
}

export function isTrivialCommand(command) {
  return trivialCommand(command);
}

function trivialCommand(command) {
  const normalized = String(command || "").replace(/\s+/g, " ").trim();
  if (normalized === "" || /^true$/.test(normalized)) return true;
  // 整条命令只是空转退出才算 trivial；夹带任何真实逻辑（哪怕以
  // process.exit(0) 收尾）都是有效验证，不误伤。
  return /^node -e ["']process\.exit\(0\);?["']$/.test(normalized);
}
