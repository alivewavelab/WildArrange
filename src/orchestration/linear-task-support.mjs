// =============================================================================
// 文件名称：linear-task-support.mjs
// 所属模块：orchestration
// 作用说明：
//   线性任务执行共用的事实采集：worker 前工作区快照。
//   不推进任务状态，也不运行 worker 或质量门。
// =============================================================================
import { appendLedger } from "../infra/ledger.mjs";
import { nowIso } from "../infra/runtime-store.mjs";
import { captureWorkspaceSnapshot } from "../infra/git-worktree.mjs";

/** worker 执行前用 git stash 记录工作区 preimage。 */
export async function recordPreExecuteSnapshot(rootDir, planId, task, executionRoot = rootDir) {
  try {
    const snapshot = await captureWorkspaceSnapshot(executionRoot, { label: `pre-execute ${task.id} attempt ${task.attempts}` });
    const entry = { ...snapshot, at: nowIso(), taskId: task.id };
    await appendLedger(rootDir, {
      type: snapshot.available ? "pre_execute_snapshot" : "pre_execute_snapshot_unavailable",
      planId,
      taskId: task.id,
      headCommit: snapshot.headCommit || null,
      stashCommit: snapshot.stashCommit || null,
      reason: snapshot.reason || null,
    });
    return entry;
  } catch (error) {
    // 快照是兜底手段，不能因为快照失败阻断任务执行本身
    return {
      kind: "workspace_snapshot",
      at: nowIso(),
      taskId: task.id,
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
