// =============================================================================
// 文件名称：linear-delivery.mjs
// 所属模块：orchestration
// 作用说明：
//   线性任务 Git 交付工作区：为单任务准备或复用隔离 worktree、分支与基线 SHA；
//   处理依赖交付 SHA 与 task branch 起点的对齐。
//
// 【运行原理速读】
//   可以把它想成「给线性 worker 一块专属施工场地」：
//
//   · 何时执行？
//     linear-runtime 在 worker 执行前调用 ensureLinearDeliveryWorkspace。
//
//   · 做了什么？
//     复用已有 worktree 或 capture 基线 → 解析依赖 SHA → prepareAgentWorktree。
//
//   · 缺了它会怎样？
//     无法在独占的 task branch 上提交 delivery commit。
// =============================================================================
import { lstat } from "node:fs/promises";
import path from "node:path";
import { resolveWildArrangePath } from "../infra/runtime-store.mjs";
import { captureWorkspaceSnapshot, prepareAgentWorktree } from "../infra/git-worktree.mjs";
import { releaseSupersededRunWorktree } from "./parallel-run-lifecycle.mjs";
import { commitIsAncestor, inspectTaskWorktreeBaseline, taskBranchName } from "../infra/git-coordination.mjs";
import { readIntegrationIntent } from "./integration.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { resolveTaskRepositoryRoot } from "../infra/workspace-context.mjs";

/**
 * 确保线性任务具备可用的 Git 交付 worktree（创建或校验复用）。
 * @returns {Promise<object|null>} delivery_workspace 描述，非 Git 项目可能为 null
 */
export async function ensureLinearDeliveryWorkspace(rootDir, planId, task, tasks = []) {
  if (task.delivery_workspace?.workDir && task.delivery_workspace?.branch && task.delivery_workspace?.baseSha) {
    const existing = await inspectTaskWorktreeBaseline(task.delivery_workspace.workDir);
    const expectedHead = task.delivery_workspace.deliverySha || task.delivery_workspace.baseSha;
    if (!existing.available || existing.branch !== task.delivery_workspace.branch || existing.headSha !== expectedHead) {
      const intent = await readIntegrationIntent(rootDir, task.delivery_workspace.runId, task.id);
      const persistedDeliverySha = task.delivery?.integrationSha || task.delivery?.commitSha || task.delivery?.actualSha || null;
      const intentOwnsCurrentHead = intent
        && intent.planId === planId
        && intent.taskId === task.id
        && intent.runId === task.delivery_workspace.runId
        && intent.branch === task.delivery_workspace.branch
        && intent.expectedSha === task.delivery_workspace.baseSha
        && intent.integrationSha === existing.headSha
        && (!persistedDeliverySha || persistedDeliverySha === intent.integrationSha)
        && ["prepared", "prepared_local", "committed_local", "pushed", "push_outcome_unknown"].includes(intent.status);
      if (!existing.available || existing.branch !== task.delivery_workspace.branch || !intentOwnsCurrentHead) {
        throw new Error(`persisted linear task worktree changed: expected ${task.delivery_workspace.branch}@${expectedHead}, got ${existing.branch || "unknown"}@${existing.headSha || "unknown"}`);
      }
      // Only the pre-checkpoint durable intent can reconcile a stale task-state SHA.
      task.delivery_workspace.deliverySha = intent.integrationSha;
    }
    return task.delivery_workspace;
  }

  const repositoryRoot = resolveTaskRepositoryRoot(rootDir, task);
  const baseline = await captureWorkspaceSnapshot(repositoryRoot, { label: `linear-delivery-${planId}-${task.id}` });
  if (baseline.available !== true) {
    const hasGitMarker = await lstat(path.join(repositoryRoot, ".git")).then(() => true).catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
    if (!hasGitMarker && ["project is not a Git repository", "project root is not the git toplevel"].includes(baseline.reason)) return null;
    throw new Error(`cannot establish linear Git delivery baseline: ${baseline.reason || "unknown Git error"}`);
  }
  if (!baseline.headCommit) throw new Error("cannot establish linear Git delivery baseline: Git repository has no initial commit");

  const dependencySha = await resolveDependencyDeliverySha(repositoryRoot, task, tasks);
  const startPoint = dependencySha || task.coordination?.baseSha || baseline.headCommit;
  const { config } = await loadWildArrangeConfig(rootDir);
  const branch = task.coordination?.branch || taskBranchName(config.gitDelivery, planId, task.id);
  task.coordination = {
    ...task.coordination,
    status: "local",
    localGit: true,
    branch,
    baseSha: startPoint,
  };
  const safePlan = String(planId).replace(/[^A-Za-z0-9._-]/g, "_");
  const safeTask = String(task.id).replace(/[^A-Za-z0-9._-]/g, "_");
  const runId = `linear-${safePlan}-${safeTask}`;
  const runDir = resolveWildArrangePath(rootDir, "linear-runs", safePlan, safeTask);
  await releaseSupersededRunWorktree(rootDir, task);
  const prepared = await prepareAgentWorktree(repositoryRoot, runDir, {
    isolation: "git-worktree",
    branchName: branch,
    startPoint,
  });
  if (prepared.available !== true) throw new Error(`linear task worktree is required for Git delivery: ${prepared.reason}`);
  task.delivery_workspace = {
    kind: "linear_task_worktree",
    runId,
    workDir: path.resolve(prepared.workDir),
    branch,
    baseSha: startPoint,
    repositoryTarget: task.repositoryTarget || "project",
    repositoryRoot,
  };
  return task.delivery_workspace;
}

/**
 * 从 blockedBy 依赖任务解析线性 worktree 起始 SHA；多分支无共同祖先时抛错。
 * @param {string} rootDir 项目根
 * @param {object} task 当前任务（含 blockedBy）
 * @param {object[]} tasks 计划内全部任务
 * @returns {Promise<string|null>} 单一依赖 delivery SHA，或无依赖时为 null
 */
async function resolveDependencyDeliverySha(rootDir, task, tasks) {
  const dependencyShas = [];
  for (const taskId of task.blockedBy || []) {
    const dependency = tasks.find((candidate) => candidate.id === taskId);
    if (dependency && (dependency.repositoryTarget || "project") !== (task.repositoryTarget || "project")) {
      throw new Error(`task ${task.id} depends on ${taskId} from another repository; complete both deliveries and bind them with an integration acceptance receipt`);
    }
    const deliverySha = dependency?.delivery?.integrationSha || dependency?.delivery?.commitSha || dependency?.delivery?.actualSha || dependency?.delivery_workspace?.deliverySha;
    if (!deliverySha) throw new Error(`task ${task.id} dependency ${taskId} has no bound delivery commit`);
    if (!dependencyShas.includes(deliverySha)) dependencyShas.push(deliverySha);
  }
  if (dependencyShas.length < 2) return dependencyShas[0] || null;
  for (const candidate of [...dependencyShas].reverse()) {
    const containsAll = await Promise.all(dependencyShas.map((sha) => commitIsAncestor(rootDir, sha, candidate)));
    if (containsAll.every(Boolean)) return candidate;
  }
  throw new Error(`task ${task.id} dependencies are on unrelated delivery branches; create an integration task first`);
}
