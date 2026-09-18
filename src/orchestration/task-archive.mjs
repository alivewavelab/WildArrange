/**
 * Task archive orchestration: every archive must first write a runtime state
 * backup (reason `pre-task-archive:<taskId>`) so the exact deletion set stays
 * recoverable via `state restore`, then hand the archive + delete to the task
 * board with that backupId. CLI and any future caller share this one order.
 */
import { writeRuntimeStateBackup } from "../infra/security.mjs";
import { archiveAndDeleteTeamTask } from "./task-board.mjs";

export async function archiveTeamTaskWithBackup(rootDir, options = {}) {
  const backup = await writeRuntimeStateBackup(rootDir, { reason: `pre-task-archive:${options.taskId}` });
  return archiveAndDeleteTeamTask(rootDir, {
    taskId: options.taskId,
    planId: options.planId,
    reason: options.reason,
    backupId: backup.backupId,
  });
}
