// =============================================================================
// 文件名称：task-cleanup.mjs
// 所属模块：orchestration
// 作用说明：合并后现场清理的唯一 owner，线性与并行任务共用。
// 运行原理：同步远端主线 → 逐个 completed 任务证明已合并（祖先或补丁等价）且 worktree 干净
//   → 删除 worktree 与本地 branch；远端 branch 只列待人工删除清单。不改写任务台账。
// =============================================================================
import { existsSync } from "node:fs";
import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import { nowIso, resolveWildArrangeRoot } from "../infra/runtime-store.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { loadTaskLedger } from "../infra/task-state-store.mjs";
import { inspectGitDelivery, listRemoteBranches, syncIntegrationRef } from "../infra/git-coordination.mjs";
import { readGitHead } from "../infra/git-diff.mjs";
import { runCommandFile } from "../infra/command-runner.mjs";
import { deleteMergedTaskBranch, isCommitMerged } from "../infra/git-worktree.mjs";
import { assertPathInsideRoot } from "../infra/path-match.mjs";
import { resolveTaskRepositoryRoot } from "../infra/workspace-context.mjs";
import { updateAgentRunLifecycle } from "./admission-projection.mjs";

/**
 * 清理全部已合并任务的 worktree 与本地 branch。
 * @param {string} rootDir 项目根
 * @param {{ dryRun?: boolean }} [options] dryRun 只报告将清理的任务，不动 Git
 * @returns {Promise<object>} kind=task_cleanup，tasks 为逐任务结果，remoteBranches 为待人工删除的远端分支
 */
export async function cleanupMergedTasks(rootDir, options = {}) {
  const dryRun = options.dryRun === true;
  const ledger = await loadTaskLedger(rootDir);
  const { config } = await loadWildArrangeConfig(rootDir);
  const repositories = new Map();
  const tasks = [];
  for (const task of ledger?.tasks || []) {
    const workspace = task.delivery_workspace;
    if (!workspace?.branch) continue;
    const repositoryRoot = resolveTaskRepositoryRoot(rootDir, task);
    if (!repositories.has(repositoryRoot)) repositories.set(repositoryRoot, await inspectRepository(repositoryRoot, config));
    const repository = repositories.get(repositoryRoot);
    const outcome = await cleanupTask(rootDir, task, repositoryRoot, repository, dryRun);
    tasks.push({ planId: task.planId, taskId: task.id, branch: workspace.branch, ...outcome });
    repository.branches.push(...(["cleaned", "would_clean", "already_clean"].includes(outcome.status) ? [workspace.branch] : []));
  }
  const remoteBranches = [];
  for (const [repositoryRoot, repository] of repositories) {
    if (!repository.remote || repository.branches.length === 0) continue;
    const existing = await listRemoteBranches(repositoryRoot, repository.remote, repository.branches);
    for (const branch of existing || []) {
      remoteBranches.push({ repositoryRoot, remote: repository.remote, branch, command: `git push ${repository.remote} --delete ${branch}` });
    }
  }
  const cleaned = tasks.filter((item) => item.status === "cleaned");
  if (!dryRun && cleaned.length > 0) {
    await appendLedger(rootDir, { type: "task_cleanup", tasks: cleaned.map((item) => `${item.planId}:${item.taskId}`), remoteBranchesPending: remoteBranches.map((item) => item.branch) });
  }
  return { kind: "task_cleanup", at: nowIso(), dryRun, tasks, remoteBranches };
}

/** 每个仓库只探测并同步一次主线。 */
async function inspectRepository(repositoryRoot, config) {
  const gitContext = await inspectGitDelivery(repositoryRoot, config.gitDelivery || {}).catch(() => null);
  if (!gitContext?.available) return { available: false, branches: [] };
  const main = await syncIntegrationRef(repositoryRoot, gitContext);
  return { available: true, remote: gitContext.remote, mainRef: main.ref, mainSource: main.source, branches: [] };
}

/** 单个任务的清理围栏与执行；任何一步无法证明都保留现场。 */
async function cleanupTask(rootDir, task, repositoryRoot, repository, dryRun) {
  const workspace = task.delivery_workspace;
  if (task.status !== "completed") return { status: "retained", reason: "task_not_completed" };
  if (!repository.available) return { status: "retained", reason: "git_unavailable" };
  const workDir = workspace.workDir ? path.resolve(workspace.workDir) : null;
  if (workDir) assertPathInsideRoot(resolveWildArrangeRoot(rootDir), workDir, workspace.workDir, "task worktree");
  const worktreeExists = Boolean(workDir && existsSync(workDir));
  const branchHead = await git(repositoryRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${workspace.branch}`]);
  if (!worktreeExists && branchHead.exitCode !== 0) return { status: "already_clean" };
  let headSha = branchHead.exitCode === 0 ? branchHead.stdout.trim() : null;
  if (worktreeExists) {
    const status = await git(workDir, ["status", "--porcelain"]);
    if (status.exitCode !== 0) return { status: "retained", reason: "worktree_cleanliness_unknown" };
    if (status.stdout.trim()) return { status: "retained", reason: "worktree_dirty", changes: status.stdout.trim().split(/\r?\n/) };
    const head = await readGitHead(workDir);
    if (!head.available) return { status: "retained", reason: "worktree_head_unknown" };
    headSha = head.sha;
  }
  const baseSha = workspace.baseSha || task.coordination?.baseSha || null;
  const merged = await isCommitMerged(repositoryRoot, { headSha, baseSha, mainRef: repository.mainRef });
  if (!merged.merged) return { status: "retained", reason: merged.reason === "not_in_main" ? "not_merged" : merged.reason, mainRef: repository.mainRef, mainSource: repository.mainSource };
  if (dryRun) return { status: "would_clean", mergedBy: merged.method, mainRef: repository.mainRef };
  if (worktreeExists) {
    const remove = await git(repositoryRoot, ["worktree", "remove", workDir]);
    if (remove.exitCode !== 0) return { status: "failed", reason: "worktree_remove_failed", error: (remove.stderr || remove.stdout).trim() };
    await git(repositoryRoot, ["worktree", "prune"]);
  }
  const branch = branchHead.exitCode === 0
    ? await deleteMergedTaskBranch(repositoryRoot, { branch: workspace.branch, mainRef: repository.mainRef, baseSha })
    : { deleted: false, reason: "branch_missing" };
  if (workspace.kind === "parallel_task_worktree" && workspace.runId) {
    await updateAgentRunLifecycle(rootDir, workspace.runId, task.id, "cleaned", { cleanedAt: nowIso(), cleanedPath: workDir, cleanedBranch: branch.deleted ? workspace.branch : null }).catch(() => {});
  }
  return { status: "cleaned", mergedBy: merged.method, worktreeRemoved: worktreeExists, branchDeleted: branch.deleted, ...(branch.deleted ? {} : { branchReason: branch.reason }) };
}

/** 参数数组形式调用 git，不经 shell。 */
function git(cwd, args) {
  return runCommandFile("git", ["-C", cwd, ...args], cwd, 30_000);
}
