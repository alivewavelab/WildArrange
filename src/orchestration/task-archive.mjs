// =============================================================================
// 文件名称：task-archive.mjs
// 所属模块：orchestration
// 作用说明：
//   团队任务归档编排：在删除前强制写入运行时状态备份，再委托 task-board
//   执行归档与删除。CLI 与未来调用方共享同一顺序，保证可经 state restore 恢复。
//
// 【运行原理速读】
//   可以把它想成「删任务前的保险快照」：
//
//   · 何时执行？
//     CLI 或编排层调用 archiveTeamTaskWithBackup 归档某 taskId 时。
//
//   · 做了什么？
//     ① 写 pre-task-archive 备份 ② 携带 backupId 调用 task-board 归档删除。
//
//   · 缺了它会怎样？
//     归档后无法精确恢复被删状态与证据目录。
// =============================================================================
import { writeRuntimeStateBackup } from "../infra/security.mjs";
import { archiveAndDeleteTeamTask } from "./task-board.mjs";

/**
 * 归档团队任务：先写运行时备份，再执行归档删除。
 * @param {string} rootDir 项目根目录
 * @param {object} [options] taskId、planId、reason 等
 * @returns {Promise<object>} task-board 归档结果
 */
export async function archiveTeamTaskWithBackup(rootDir, options = {}) {
  const backup = await writeRuntimeStateBackup(rootDir, { reason: `pre-task-archive:${options.taskId}` });
  return archiveAndDeleteTeamTask(rootDir, {
    taskId: options.taskId,
    planId: options.planId,
    reason: options.reason,
    backupId: backup.backupId,
  });
}
