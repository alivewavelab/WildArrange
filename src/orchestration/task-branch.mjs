// =============================================================================
// 文件名称：task-branch.mjs
// 所属模块：orchestration
// 作用说明：
//   任务启动时确定 task branch 交付目标：分支名、基线 SHA、可选 push 远端。
//   只读本机 Git 状态并返回 task.coordination 记录，不写远端、不登记设备。
//
// 【运行原理速读】
//   可以把它想成「给任务分配一条专属分支的登记表」：
//
//   · 何时执行？
//     任务 claim / 线性 run 首次启动 / 并行 run claim。
//
//   · 做了什么？
//     读 HEAD → 生成 wildarrange/task/<plan>/<task> 分支名 → 返回 local 记录。
//
//   · 约束？
//     同一分支被两个可写 worktree 占用由 git worktree 拒绝（见 git-worktree.mjs）；
//     本模块不做多设备或远端 ownership 协调。
// =============================================================================
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { inspectGitDelivery, taskBranchName } from "../infra/git-coordination.mjs";
import { resolveTaskRepositoryRoot } from "../infra/workspace-context.mjs";
import { readGitHead } from "../infra/git-diff.mjs";

/**
 * 解析任务的 task branch 交付目标；已有 local 记录直接复用。
 * @returns {Promise<object>} status local（有 Git 基线）或 degraded（非 Git 项目）
 */
export async function resolveTaskBranchTarget(rootDir, options) {
  const existing = options.task?.coordination;
  if (existing?.status === "local" && existing.branch && existing.baseSha) return existing;
  const { config } = await loadWildArrangeConfig(rootDir);
  const branch = () => taskBranchName(config.gitDelivery, options.planId, options.task.id);
  if (options.task?.repositoryTarget === "governance") {
    const governanceRoot = resolveTaskRepositoryRoot(rootDir, options.task);
    const head = await readGitHead(governanceRoot);
    if (!head.available || !head.sha) {
      throw new Error("governance repository task requires a Git repository with an initial commit");
    }
    // 治理仓库只走自己的本地 task branch，不复用项目远端。
    return { status: "local", localGit: true, remote: null, branch: branch(), baseSha: head.sha, repositoryTarget: "governance" };
  }
  const context = await inspectGitDelivery(rootDir, config.gitDelivery);
  if (!context.available) {
    return { status: "degraded", localGit: false, reason: context.reason, branch: null, baseSha: null };
  }
  return { status: "local", localGit: true, remote: context.remote, branch: branch(), baseSha: context.headSha };
}
