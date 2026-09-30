// =============================================================================
// 文件名称：git-coordination.mjs
// 所属模块：infra
// 作用说明：
//   单机 Git 交付原语：任务 worktree 基线检查、delivery commit（隔离 index、
//   只含本任务路径）、普通非强制 push 到任务独占 task branch、分支命名。
//
// 【运行原理速读】
//   inspectTaskWorktreeBaseline → createTaskDeliveryCommit → pushTaskDeliveryCommit。
//   不做多设备/远端 ownership；同一分支被占用由 git worktree 拒绝并由调用方报错。
// =============================================================================
import { randomUUID } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCommandFile } from "./command-runner.mjs";
import { readGitHead, readGitTopLevel } from "./git-diff.mjs";

/** 默认本地 git 子命令超时（毫秒）；push/fetch 等长操作单独覆盖。 */
const GIT_TIMEOUT_MS = 30_000;

/**
 * inspectGitDelivery：探测项目根的 Git 交付环境（本地基线、可选远端与主线分支名）。
 * 未配置远端时仍可本地交付；远端只用于 task branch 的普通 push。
 */
export async function inspectGitDelivery(rootDir, config = {}) {
  const topLevelResult = await readGitTopLevel(rootDir);
  if (!topLevelResult.available) {
    return unavailable("project is not a Git repository");
  }
  const topLevel = await canonicalPath(topLevelResult.topLevel);
  // 项目根必须等于 toplevel realpath，避免在嵌套 worktree 内误交付。
  if (topLevel !== await canonicalPath(rootDir)) {
    return unavailable("project root is not the Git toplevel");
  }
  const headResult = await readGitHead(rootDir);
  if (!headResult.available) {
    return unavailable("Git repository has no baseline commit", { topLevel });
  }
  const remote = config.remote || "origin";
  const remoteResult = await runGit(rootDir, ["remote", "get-url", remote]);
  const remoteConfigured = remoteResult.ok;
  return {
    available: true,
    localGitAvailable: true,
    topLevel,
    remote: remoteConfigured ? remote : null,
    remoteConfigured,
    integrationBranch: remoteConfigured
      ? await resolveIntegrationBranch(rootDir, remote, config.integrationBranch || "auto")
      : (config.integrationBranch && config.integrationBranch !== "auto" ? config.integrationBranch : "main"),
    headSha: headResult.sha,
    reason: null,
  };
}

/**
 * gitHead：本模块对外异步 API。
 */
// --- Git 只读探测 ---
export async function gitHead(rootDir) {
  const head = await readGitHead(rootDir);
  if (!head.available) throw new Error(`cannot resolve Git HEAD: ${head.reason}`);
  return head.sha;
}

/**
 * inspectTaskWorktreeBaseline：本模块对外异步 API。
 */
export async function inspectTaskWorktreeBaseline(rootDir) {
  const topLevel = await readGitTopLevel(rootDir);
  if (!topLevel.available) {
    return { available: false, clean: false, reason: "project is not a Git repository", changedPaths: [] };
  }
  const canonicalRoot = await canonicalPath(rootDir);
  const canonicalTopLevel = await canonicalPath(topLevel.topLevel);
  if (canonicalRoot !== canonicalTopLevel) {
    return { available: false, clean: false, reason: "project root is not the Git toplevel", changedPaths: [] };
  }
  const head = await readGitHead(rootDir);
  if (!head.available) {
    return { available: false, clean: false, reason: "Git repository has no baseline commit", changedPaths: [] };
  }
  const branch = await runGit(rootDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const changedPaths = await listWorkingTreeChanges(rootDir, { includeRuntimePaths: true });
  return {
    available: true,
    clean: changedPaths.length === 0,
    headSha: head.sha,
    branch: branch.ok ? branch.stdout.trim() : null,
    detached: !branch.ok,
    changedPaths,
    reason: changedPaths.length === 0 ? null : "working tree contains changes outside a completed task delivery",
  };
}

/**
 * createTaskDeliveryCommit：本模块对外异步 API。
 */
// --- 任务交付 commit ---
export async function createTaskDeliveryCommit(rootDir, options = {}) {
  const baseline = await inspectTaskWorktreeBaseline(rootDir);
  if (!baseline.available) {
    return { pass: false, status: "unavailable", reason: baseline.reason, changedPaths: [] };
  }
  const expectedHead = String(options.expectedHead || "").trim();
  if (!expectedHead || baseline.headSha !== expectedHead) {
    return {
      pass: false,
      status: "revalidation_required",
      reason: "task_branch_head_changed",
      expectedHead: expectedHead || null,
      actualHead: baseline.headSha,
      changedPaths: baseline.changedPaths,
    };
  }
  if (options.expectedBranch && baseline.branch !== options.expectedBranch) {
    return {
      pass: false,
      status: "revalidation_required",
      reason: "task_branch_changed",
      expectedBranch: options.expectedBranch,
      actualBranch: baseline.branch,
      changedPaths: baseline.changedPaths,
    };
  }

  const requestedPaths = uniqueGitPaths(options.changedPaths || []);
  const actualPaths = uniqueGitPaths(baseline.changedPaths);
  const requested = new Set(requestedPaths);
  const unownedPaths = actualPaths.filter((filePath) => !requested.has(filePath));
  // §3.4 归属校验：工作区有变更但未列入任务 changedPaths 时拒绝 commit
  if (unownedPaths.length > 0) {
    return {
      pass: false,
      status: "revalidation_required",
      reason: "unattributed_worktree_changes",
      expectedHead,
      actualHead: baseline.headSha,
      changedPaths: actualPaths,
      unownedPaths,
    };
  }
  if (actualPaths.length === 0) {
    return {
      pass: true,
      status: "no_change",
      baseSha: expectedHead,
      commitSha: expectedHead,
      branch: baseline.branch,
      changedPaths: [],
      worktreeClean: true,
      pushed: false,
    };
  }

  const indexPath = path.join(os.tmpdir(), `wildarrange-delivery-index-${process.pid}-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    const readTree = await runGit(rootDir, ["read-tree", expectedHead], { env });
    if (!readTree.ok) throw new Error(`cannot prepare delivery index: ${readTree.stderr || readTree.stdout}`);
    const add = await runGit(rootDir, ["add", "-A", "--", ...actualPaths], { env });
    if (!add.ok) throw new Error(`cannot stage delivery paths: ${add.stderr || add.stdout}`);
    const tree = await runGit(rootDir, ["write-tree"], { env });
    if (!tree.ok) throw new Error(`cannot write delivery tree: ${tree.stderr || tree.stdout}`);
    const commitSha = await commitTree(
      rootDir,
      tree.stdout.trim(),
      expectedHead,
      options.message || "wildarrange: task delivery",
    );
    // §3.4 Git 乐观锁：update-ref 带 expectedHead，并发改分支时拒绝移动 HEAD。
    const update = await runGit(rootDir, ["update-ref", "HEAD", commitSha, expectedHead]);
    if (!update.ok) {
      return {
        pass: false,
        status: "revalidation_required",
        reason: "task_branch_head_changed",
        expectedHead,
        actualHead: await gitHead(rootDir).catch(() => null),
        preparedCommitSha: commitSha,
        changedPaths: actualPaths,
      };
    }
    // The commit was built with an isolated index so the task worktree's
    // staging area was never used. Once HEAD moves, refresh that worktree's
    // real index to the committed tree; otherwise Git would report the old
    // index as staged deletions even though the files on disk are correct.
    const refreshIndex = await runGit(rootDir, ["read-tree", commitSha]);
    if (!refreshIndex.ok) {
      return {
        pass: false,
        status: "recovery_required",
        reason: "delivery_index_refresh_failed",
        baseSha: expectedHead,
        commitSha,
        branch: baseline.branch,
        changedPaths: actualPaths,
        worktreeClean: false,
        error: refreshIndex.stderr || refreshIndex.stdout,
      };
    }
    const after = await inspectTaskWorktreeBaseline(rootDir);
    return {
      pass: after.available && after.clean && after.headSha === commitSha,
      status: after.available && after.clean && after.headSha === commitSha ? "committed" : "recovery_required",
      reason: after.available && after.clean && after.headSha === commitSha ? null : "delivery_commit_left_dirty_worktree",
      baseSha: expectedHead,
      commitSha,
      branch: after.branch,
      changedPaths: actualPaths,
      worktreeClean: after.clean === true,
      pushed: false,
    };
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined);
  }
}

/**
 * pushTaskDeliveryCommit：本模块对外异步 API。
 */
export async function pushTaskDeliveryCommit(rootDir, options = {}) {
  const branch = String(options.branch || "").trim();
  const commitSha = String(options.commitSha || "").trim();
  const prefix = String(options.taskBranchPrefix || "wildarrange/task").replace(/^\/+|\/+$/g, "");
  // §3.4 安全：只允许 push 到 task branch 前缀，禁止自动写入 main 或共享分支。
  if (!branch || !branch.startsWith(`${prefix}/`)) {
    throw new Error(`refusing automatic push outside task branch prefix ${prefix}/: ${branch || "missing"}`);
  }
  if (!/^[0-9a-f]{40,64}$/i.test(commitSha)) throw new Error("valid delivery commit SHA is required");
  const pushed = await pushCommit(rootDir, { remote: options.remote || "origin", branch, commitSha });
  return {
    pass: pushed.ok,
    status: pushed.ok ? "pushed" : "push_failed",
    remote: options.remote || "origin",
    branch,
    commitSha,
    pushed: pushed.ok,
    error: pushed.ok ? null : pushed.stderr || pushed.stdout,
  };
}

/**
 * synchronizeTaskWorktreeToDelivery：本模块对外异步 API。
 */
export async function synchronizeTaskWorktreeToDelivery(rootDir, options = {}) {
  const baseline = await inspectTaskWorktreeBaseline(rootDir);
  const expectedHead = String(options.expectedHead || "").trim();
  const commitSha = String(options.commitSha || "").trim();
  if (!baseline.available || !baseline.clean) {
    return {
      pass: false,
      status: "recovery_required",
      reason: baseline.available ? "task_worktree_changed_after_delivery" : baseline.reason,
      changedPaths: baseline.changedPaths || [],
    };
  }
  if (options.expectedBranch && baseline.branch !== options.expectedBranch) {
    return { pass: false, status: "recovery_required", reason: "task_branch_changed", expectedBranch: options.expectedBranch, actualBranch: baseline.branch };
  }
  if (baseline.headSha === commitSha) {
    return { pass: true, status: "clean", branch: baseline.branch, commitSha, worktreeClean: true };
  }
  if (!expectedHead || baseline.headSha !== expectedHead) {
    return { pass: false, status: "recovery_required", reason: "task_branch_head_changed", expectedHead, actualHead: baseline.headSha };
  }
  const update = await runGit(rootDir, ["update-ref", "HEAD", commitSha, expectedHead]);
  if (!update.ok) {
    return { pass: false, status: "recovery_required", reason: "task_branch_head_changed", expectedHead, actualHead: await gitHead(rootDir).catch(() => null) };
  }
  const checkout = await runGit(rootDir, ["read-tree", "--reset", "-u", commitSha]);
  if (!checkout.ok) {
    return { pass: false, status: "recovery_required", reason: "task_worktree_sync_failed", commitSha, error: checkout.stderr || checkout.stdout };
  }
  const after = await inspectTaskWorktreeBaseline(rootDir);
  return {
    pass: after.available && after.clean && after.headSha === commitSha,
    status: after.available && after.clean && after.headSha === commitSha ? "clean" : "recovery_required",
    reason: after.available && after.clean && after.headSha === commitSha ? null : "task_worktree_sync_incomplete",
    branch: after.branch,
    commitSha,
    worktreeClean: after.clean === true,
    changedPaths: after.changedPaths,
  };
}

/**
 * remoteBranchHead：本模块对外异步 API。
 */
// --- 远端读取与 push ---
export async function remoteBranchHead(rootDir, remote, branch) {
  const result = await runGit(rootDir, ["ls-remote", "--heads", remote, `refs/heads/${branch}`], { timeoutMs: 60_000 });
  if (!result.ok) throw new Error(`cannot read ${remote}/${branch}: ${result.stderr || result.stdout}`);
  const first = result.stdout.trim().split(/\s+/)[0];
  return /^[0-9a-f]{40,64}$/i.test(first || "") ? first : null;
}

/**
 * createTaskCheckpointCommit：本模块对外异步 API。
 */
export async function createTaskCheckpointCommit(rootDir, options) {
  const indexPath = path.join(os.tmpdir(), `wildarrange-checkpoint-index-${process.pid}-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    const readTree = await runGit(rootDir, ["read-tree", options.parentSha], { env });
    if (!readTree.ok) throw new Error(`cannot prepare checkpoint index: ${readTree.stderr || readTree.stdout}`);
    if (options.changedPaths.length > 0) {
      const add = await runGit(rootDir, ["add", "-A", "--", ...options.changedPaths], { env });
      if (!add.ok) throw new Error(`cannot stage task paths in temporary index: ${add.stderr || add.stdout}`);
    }
    const tree = await runGit(rootDir, ["write-tree"], { env });
    if (!tree.ok) throw new Error(`cannot write checkpoint tree: ${tree.stderr || tree.stdout}`);
    return commitTree(rootDir, tree.stdout.trim(), options.parentSha, options.message);
  } finally {
    await rm(indexPath, { force: true }).catch(() => undefined);
  }
}

/**
 * pushCommit：本模块对外异步 API。
 */
export async function pushCommit(rootDir, options) {
  return runGit(rootDir, [
    "push",
    options.remote,
    `${options.commitSha}:refs/heads/${options.branch}`,
  ], { timeoutMs: 120_000 });
}

/**
 * fetchRemoteBranch：本模块对外异步 API。
 */
export async function fetchRemoteBranch(rootDir, remote, branch) {
  const result = await runGit(rootDir, ["fetch", "--no-tags", remote, `refs/heads/${branch}`], { timeoutMs: 120_000 });
  if (!result.ok) throw new Error(`cannot fetch ${remote}/${branch}: ${result.stderr || result.stdout}`);
  return gitHeadForRef(rootDir, "FETCH_HEAD");
}

/**
 * commitIsAncestor：本模块对外异步 API。
 */
export async function commitIsAncestor(rootDir, ancestorSha, descendantRef = "HEAD") {
  if (!ancestorSha) return false;
  const result = await runGit(rootDir, ["merge-base", "--is-ancestor", ancestorSha, descendantRef]);
  return result.ok;
}

/**
 * listWorkingTreeChanges：本模块对外异步 API。
 */
export async function listWorkingTreeChanges(rootDir, options = {}) {
  const groups = await Promise.all([
    runGit(rootDir, ["diff", "--name-only", "-z", "--"]),
    runGit(rootDir, ["diff", "--cached", "--name-only", "-z", "--"]),
    runGit(rootDir, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  for (const result of groups) {
    if (!result.ok) throw new Error(`cannot inspect Git working tree: ${result.stderr || result.stdout}`);
  }
  const paths = [...new Set(groups.flatMap((result) => result.stdout.split("\0").filter(Boolean)))].sort();
  return options.includeRuntimePaths === true
    ? paths
    : paths.filter((filePath) => filePath !== ".wildarrange" && !filePath.startsWith(".wildarrange/"));
}

/**
 * listTreeChanges：本模块对外异步 API。
 */
export async function listTreeChanges(rootDir, fromSha, toRef = "HEAD") {
  const result = await runGit(rootDir, ["diff", "--name-only", "-z", fromSha, toRef, "--"]);
  if (!result.ok) throw new Error(`cannot inspect Git tree changes ${fromSha}..${toRef}: ${result.stderr || result.stdout}`);
  return [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
}

/**
 * taskBranchName：本模块对外API。
 */
export function taskBranchName(config, planId, taskId) {
  const prefix = String(config.taskBranchPrefix || "wildarrange/task").replace(/^\/+|\/+$/g, "");
  return [prefix, safeRefSegment(planId), safeRefSegment(taskId)].join("/");
}

// --- 内部 Git 辅助 ---
/**
 * 解析远端集成基线分支名；auto 时依次尝试 ls-remote HEAD 与 remote/HEAD。
 */
async function resolveIntegrationBranch(rootDir, remote, configured) {
  if (configured && configured !== "auto") return configured;
  const advertisedHead = await runGit(rootDir, ["ls-remote", "--symref", remote, "HEAD"], { timeoutMs: 60_000 });
  if (advertisedHead.ok) {
    const match = advertisedHead.stdout.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m);
    if (match) return match[1];
  }
  const remoteHead = await runGit(rootDir, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
  if (remoteHead.ok && remoteHead.stdout.trim().startsWith(`${remote}/`)) {
    return remoteHead.stdout.trim().slice(remote.length + 1);
  }
  return "main";
}

/**
 * 解析 Git ref 为 commit SHA。
 */
async function gitHeadForRef(rootDir, ref) {
  const result = await runGit(rootDir, ["rev-parse", ref]);
  if (!result.ok) throw new Error(`cannot resolve ${ref}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/**
 * 用 commit-tree 创建协调 commit，固定 author/committer 身份。
 */
async function commitTree(rootDir, treeSha, parentSha, message) {
  const result = await runGit(rootDir, ["commit-tree", treeSha, "-p", parentSha, "-m", message], {
    env: {
      GIT_AUTHOR_NAME: "WildArrange",
      GIT_AUTHOR_EMAIL: "wildarrange@local.invalid",
      GIT_COMMITTER_NAME: "WildArrange",
      GIT_COMMITTER_EMAIL: "wildarrange@local.invalid",
    },
  });
  if (!result.ok) throw new Error(`cannot create coordination commit: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/**
 * 以 argv 数组调用 git -C，禁止 shell 拼接用户输入。
 */
async function runGit(rootDir, args, options = {}) {
  const result = await runCommandFile("git", ["-C", rootDir, ...args], rootDir, options.timeoutMs || GIT_TIMEOUT_MS, {
    env: options.env,
    maxOutputChars: 2_000_000,
  });
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

/**
 * Git 不可用时的结构化返回。
 */
function unavailable(reason, extra = {}) {
  return { available: false, localGitAvailable: false, reason, ...extra };
}

/**
 * 将 planId/taskId 归一化为安全 Git ref 段，非法值抛错。
 */
function safeRefSegment(value) {
  const normalized = String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized === "." || normalized === "..") throw new Error(`invalid Git task branch segment: ${value}`);
  return normalized;
}

/**
 * 去重并排序 Git 路径，排除 .wildarrange 运行时目录。
 */
function uniqueGitPaths(values) {
  return [...new Set(values
    .map((value) => String(value || "").replaceAll("\\", "/").replace(/^\.\//, ""))
    .filter((value) => value && value !== ".wildarrange" && !value.startsWith(".wildarrange/")))]
    .sort();
}

/**
 * realpath 解析路径；ENOENT 时回退 resolve。
 */
async function canonicalPath(value) {
  try {
    return await realpath(value);
  } catch {
    return path.resolve(value);
  }
}

