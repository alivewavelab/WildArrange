// =============================================================================
// 文件名称：git-worktree.mjs
// 所属模块：infra
// 作用说明：
//   并行 Agent git worktree 隔离、patch 收集与 admission 应用。
//
// 【运行原理速读】
//   prepareAgentWorktree → collectAgentWorktreePatch → applyAgentPatch 预检后 apply。
// =============================================================================
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCommandFile } from "./command-runner.mjs";
import { readGitHead, readGitTopLevel } from "./git-diff.mjs";
import { resolveWildArrangePath } from "./runtime-store.mjs";
import { uniqueStrings } from "./text-utils.mjs";

/**
 * prepareAgentWorktree：本模块对外异步 API。
 */
export async function prepareAgentWorktree(rootDir, taskRunDir, options = {}) {
  if (options.isolation !== "git-worktree") {
    return {
      isolation: "run-dir",
      workDir: taskRunDir,
      available: false,
      reason: "git-worktree isolation is not requested",
    };
  }

  const git = await gitAvailable(rootDir);
  if (!git.available) {
    return {
      isolation: "git-worktree",
      workDir: taskRunDir,
      available: false,
      reason: git.reason,
    };
  }

  const worktreeDir = path.join(taskRunDir, "worktree");
  await mkdir(taskRunDir, { recursive: true });
  const branchName = String(options.branchName || "").trim();
  const startPoint = String(options.startPoint || "HEAD").trim();
  const existing = await inspectExistingWorktree(worktreeDir, branchName);
  if (existing?.available === true) {
    return {
      isolation: "git-worktree",
      workDir: worktreeDir,
      available: true,
      branch: existing.branch,
      startPoint: existing.headSha,
      reused: true,
      reason: null,
    };
  }
  if (existing?.error) {
    return {
      isolation: "git-worktree",
      workDir: taskRunDir,
      available: false,
      reason: existing.error,
    };
  }
  if (branchName) {
    // 一个 task branch 只能属于一个可写任务：已被任何 worktree 检出或已存在时拒绝启动。
    const occupied = await inspectTaskBranchOccupation(rootDir, branchName);
    if (occupied) {
      return {
        isolation: "git-worktree",
        workDir: taskRunDir,
        available: false,
        occupied: true,
        reason: occupied.worktree
          ? `task branch ${branchName} is already checked out by another worktree (${occupied.worktree}); two writable tasks cannot share one branch`
          : `task branch ${branchName} already exists and belongs to an earlier task run; two writable tasks cannot share one branch`,
      };
    }
  }
  const addArgs = branchName
    ? ["-C", rootDir, "worktree", "add", "-b", branchName, worktreeDir, startPoint]
    : ["-C", rootDir, "worktree", "add", "--detach", worktreeDir, startPoint];
  const add = await runCommandFile("git", addArgs, rootDir, options.timeoutMs);
  if (add.exitCode !== 0) {
    return {
      isolation: "git-worktree",
      workDir: taskRunDir,
      available: false,
      reason: `git worktree add failed: ${add.stderr || add.stdout}`,
    };
  }
  return {
    isolation: "git-worktree",
    workDir: worktreeDir,
    available: true,
    branch: branchName || null,
    startPoint,
    reason: null,
  };
}

/**
 * 释放一个 run worktree 对任务分支的占用：移除 worktree 并删除分支。
 * 仅当分支相对 startPoint 没有任何提交时才执行（分支上有提交即交付产物，绝不删除）；
 * worktree 内未提交的改动已在 run 结束时收集成 patch/result 证据。调用方负责判定该 run 已可丢弃。
 * @returns {Promise<{released: boolean, reason?: string}>}
 */
export async function releaseAgentWorktree(rootDir, { workDir, branch, startPoint }) {
  if (!workDir || !branch || !startPoint) return { released: false, reason: "worktree_identity_unknown" };
  const ahead = await runCommandFile("git", ["-C", rootDir, "rev-list", "--count", `${startPoint}..refs/heads/${branch}`], rootDir, 30_000);
  if (ahead.exitCode !== 0 || ahead.stdout.trim() !== "0") return { released: false, reason: "branch_has_commits" };
  const remove = await runCommandFile("git", ["-C", rootDir, "worktree", "remove", "--force", workDir], rootDir, 30_000);
  if (remove.exitCode !== 0 && !/is not a working tree|No such file/i.test(remove.stderr || remove.stdout || "")) {
    return { released: false, reason: `worktree_remove_failed: ${remove.stderr || remove.stdout}` };
  }
  await runCommandFile("git", ["-C", rootDir, "worktree", "prune"], rootDir, 30_000);
  const drop = await runCommandFile("git", ["-C", rootDir, "branch", "-D", branch], rootDir, 30_000);
  if (drop.exitCode !== 0) return { released: false, reason: `branch_delete_failed: ${drop.stderr || drop.stdout}` };
  return { released: true };
}

/**
 * 删除已并入主线的本地 task branch：先读分支 SHA，确认它是 mainRef 的祖先（分支上没有主线之外的提交），
 * 再以该 SHA 做乐观锁删除，期间分支被移动则拒绝。只删本地分支，远端分支由人类确认。
 * @returns {Promise<{deleted: boolean, reason?: string}>}
 */
export async function deleteMergedTaskBranch(rootDir, { branch, mainRef }) {
  if (!branch || !mainRef) return { deleted: false, reason: "branch_identity_unknown" };
  const ref = `refs/heads/${branch}`;
  const head = await runCommandFile("git", ["-C", rootDir, "rev-parse", "--verify", "--quiet", ref], rootDir, 30_000);
  if (head.exitCode !== 0) return { deleted: false, reason: "branch_missing" };
  const sha = head.stdout.trim();
  const merged = await runCommandFile("git", ["-C", rootDir, "merge-base", "--is-ancestor", sha, mainRef], rootDir, 30_000);
  if (merged.exitCode !== 0) return { deleted: false, reason: "branch_not_in_main" };
  const drop = await runCommandFile("git", ["-C", rootDir, "update-ref", "-d", ref, sha], rootDir, 30_000);
  if (drop.exitCode !== 0) return { deleted: false, reason: `branch_delete_failed: ${drop.stderr || drop.stdout}` };
  return { deleted: true };
}

/**
 * 检查 task branch 是否已被占用：返回占用它的 worktree 路径、仅分支存在时返回空路径，未占用返回 null。
 */
export async function inspectTaskBranchOccupation(rootDir, branchName) {
  const list = await runCommandFile("git", ["-C", rootDir, "worktree", "list", "--porcelain"], rootDir, 30_000);
  if (list.exitCode === 0) {
    let currentPath = null;
    for (const line of list.stdout.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length);
      else if (line === `branch refs/heads/${branchName}`) return { worktree: currentPath };
    }
  }
  const exists = await runCommandFile("git", ["-C", rootDir, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], rootDir, 30_000);
  return exists.exitCode === 0 ? { worktree: null } : null;
}

/**
 * 账本故障可能发生在 worktree 已创建、任务状态尚未落盘的窗口。
 * 恢复时先复用并核对同一路径，避免再次创建同名分支；不接受无法
 * 证明为 Git worktree 或分支不一致的旧目录。
 */
async function inspectExistingWorktree(worktreeDir, expectedBranch) {
  const marker = await lstat(worktreeDir).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!marker) return null;
  if (marker.isSymbolicLink()) {
    return { error: `existing worktree path is a symlink: ${worktreeDir}` };
  }
  const inside = await runCommandFile("git", ["-C", worktreeDir, "rev-parse", "--is-inside-work-tree"], worktreeDir, 30_000);
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    return { error: `existing worktree path is not a Git worktree: ${worktreeDir}` };
  }
  const branchResult = await runCommandFile("git", ["-C", worktreeDir, "rev-parse", "--abbrev-ref", "HEAD"], worktreeDir, 30_000);
  const headResult = await runCommandFile("git", ["-C", worktreeDir, "rev-parse", "HEAD"], worktreeDir, 30_000);
  if (branchResult.exitCode !== 0 || headResult.exitCode !== 0) {
    return { error: `existing Git worktree identity could not be verified: ${worktreeDir}` };
  }
  const branch = branchResult.stdout.trim();
  const headSha = headResult.stdout.trim();
  if (expectedBranch && branch !== expectedBranch) {
    return { error: `existing Git worktree branch mismatch: expected ${expectedBranch}, got ${branch}` };
  }
  return { available: true, branch: branch === "HEAD" ? null : branch, headSha };
}

/**
 * collectAgentWorktreePatch：本模块对外异步 API。
 */
export async function collectAgentWorktreePatch(rootDir, worktree, options = {}) {
  if (worktree?.isolation !== "git-worktree" || worktree.available !== true) {
    return null;
  }

  await runCommandFile("git", ["-C", worktree.workDir, "add", "-N", "."], worktree.workDir, options.timeoutMs);
  const patchResult = await runCommandFile("git", ["-C", worktree.workDir, "diff", "--binary", "--", "."], worktree.workDir, options.timeoutMs);
  const namesResult = await runCommandFile("git", ["-C", worktree.workDir, "diff", "--name-only", "--", "."], worktree.workDir, options.timeoutMs);
  const statusResult = await runCommandFile("git", ["-C", worktree.workDir, "status", "--short"], worktree.workDir, options.timeoutMs);
  const patch = patchResult.stdout || "";
  const changedPaths = uniqueStrings([
    ...splitLines(namesResult.stdout),
    ...extractPatchPaths(patch),
  ]);
  const patchPath = path.join(path.dirname(worktree.workDir), "agent.patch");
  await writeFile(patchPath, patch, "utf8");

  return {
    kind: "agent_worktree_patch",
    worktreeDir: path.relative(rootDir, worktree.workDir),
    patchPath: path.relative(rootDir, patchPath),
    patch,
    changedPaths,
    status: statusResult.stdout || "",
    exitCode: patchResult.exitCode,
    stderr: patchResult.stderr || "",
  };
}

/**
 * captureWorkspaceSnapshot：本模块对外异步 API。
 */
export async function captureWorkspaceSnapshot(rootDir, options = {}) {
  const label = options.label || "pre-execute";
  const git = await gitAvailable(rootDir);
  if (!git.available) {
    return { kind: "workspace_snapshot", available: false, label, reason: git.reason };
  }
  // 只在项目根就是 git 根时快照，避免嵌套目录误伤外层仓库
  const sameRoot = await pathsEqual(rootDir, git.topLevel);
  if (!sameRoot) {
    return { kind: "workspace_snapshot", available: false, label, reason: "project root is not the git toplevel" };
  }
  const head = await readGitHead(rootDir);
  const headCommit = head.available ? head.sha : null;
  const stash = await runCommandFile("git", ["-C", rootDir, "stash", "create", `wildarrange ${label}`], rootDir, 30_000);
  const stashCommit = stash.exitCode === 0 ? stash.stdout.trim() : null;
  if (stash.exitCode !== 0) {
    return {
      kind: "workspace_snapshot",
      available: false,
      label,
      headCommit,
      reason: `git stash create failed: ${stash.stderr || stash.stdout}`,
    };
  }
  return {
    kind: "workspace_snapshot",
    available: true,
    label,
    headCommit,
    stashCommit: stashCommit || null,
    dirty: Boolean(stashCommit),
    restoreHint: stashCommit
      ? `git stash apply ${stashCommit}`
      : headCommit
        ? `git checkout ${headCommit} -- <path>`
        : null,
  };
}

/**
 * applyAgentPatch：本模块对外异步 API。
 */
export async function applyAgentPatch(rootDir, patch, options = {}) {
  if (!patch || typeof patch !== "string" || patch.trim().length === 0) {
    throw new Error("parallel admission patch is empty");
  }
  // 外置模式下运行态根在项目之外，补丁文件必须走运行态根解析并保证目录存在
  const patchPath = resolveWildArrangePath(rootDir, "agent-runs", `admit-${Date.now()}-${process.pid}.patch`);
  await mkdir(path.dirname(patchPath), { recursive: true });
  await writeFile(patchPath, patch, "utf8");
  const check = await runCommandFile("git", ["-C", rootDir, "apply", "--check", "--whitespace=nowarn", patchPath], rootDir, options.timeoutMs);
  if (check.exitCode !== 0) {
    throw Object.assign(new Error(`parallel admission patch check failed: ${check.stderr || check.stdout}`), { code: "patch_precheck_failed" });
  }
  const apply = await runCommandFile("git", ["-C", rootDir, "apply", "--whitespace=nowarn", patchPath], rootDir, options.timeoutMs);
  if (apply.exitCode !== 0) {
    throw new Error(`parallel admission patch apply failed: ${apply.stderr || apply.stdout}`);
  }
  return {
    patchPath: path.relative(rootDir, patchPath),
    exitCode: apply.exitCode,
  };
}

/**
 * extractPatchPaths：本模块对外API。
 */
export function extractPatchPaths(patch) {
  return uniqueStrings(String(patch || "")
    .split(/\r?\n/)
    .map((line) => line.match(/^diff --git a\/(.+?) b\/(.+)$/))
    .filter(Boolean)
    .flatMap((match) => [normalizePatchPath(match[1]), normalizePatchPath(match[2])])
    .filter(Boolean));
}

/**
 * gitAvailable 内部辅助。
 */
async function gitAvailable(rootDir) {
  const result = await readGitTopLevel(rootDir);
  if (!result.available) {
    return { available: false, reason: "project is not a Git repository" };
  }
  return { available: true, topLevel: result.topLevel };
}

/**
 * pathsEqual 内部辅助。
 */
async function pathsEqual(left, right) {
  if (!left || !right) return false;
  try {
    return await realpath(left) === await realpath(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

/**
 * 归一化 PatchPath 输入为稳定形态。
 */
function normalizePatchPath(filePath) {
  const normalized = String(filePath || "").replaceAll("\\", "/");
  if (!normalized || normalized === "/dev/null") return null;
  if (path.isAbsolute(normalized) || normalized.startsWith("../") || normalized.includes("/../")) return null;
  return normalized;
}

/**
 * splitLines 内部辅助。
 */
function splitLines(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

