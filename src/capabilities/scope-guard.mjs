// =============================================================================
// 文件名称：scope-guard.mjs
// 所属模块：capabilities
// 作用说明：
//   校验 git 变更路径是否落在 task.writable_paths 内，并检测符号链接/
//   realpath 逃逸。结果写入 ledger，不修改工作区文件。
//
// 【运行原理速读】
//   · 何时执行？PreToolUse、交付前 review，或 gateway scope 能力调用。
//   · 做了什么？收集 changedPaths → 与 writable_paths 匹配 → realpath 防逃逸
//     → 返回 pass/fail/inconclusive 与 deniedPaths。
//   · 缺了它会怎样？Agent 可越界改文件而仍被当作合法完成。
// =============================================================================

import { realpath } from "node:fs/promises";
import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import { ensureWildArrangeDirs } from "../infra/runtime-store.mjs";
import { collectGitChangedPaths } from "../infra/git-diff.mjs";
import { normalizeRelativePath, pathAllowed } from "../infra/path-match.mjs";
import { loadTaskState } from "../infra/task-state-store.mjs";

/**
 * 对指定任务执行范围守卫，比对变更路径与 writable_paths。
 * @param {string} rootDir 控制根（ledger 写入位置）
 * @param {object} [options] taskId、changedPaths、executionRoot、unavailableReason
 * @returns {Promise<object>} status 为 pass|fail|inconclusive
 */
export async function scopeGuard(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");

  const task = resolveGuardTask(taskState.tasks, options.taskId);
  const collected = Array.isArray(options.changedPaths)
    ? { available: true, paths: options.changedPaths }
    : await collectGitChangedPaths(options.executionRoot || rootDir);

  if (!collected.available) {
    const guarded = (task.writable_paths || []).length > 0;
    // §3.4：有 writable_paths 但拿不到 diff 时 fail-closed；无边界则 inconclusive。
    const result = {
      status: guarded ? "fail" : "inconclusive",
      taskId: task.id,
      reason: options.unavailableReason || collected.reason,
      changedPaths: [],
      writablePaths: task.writable_paths,
      deniedPaths: [],
    };
    await appendLedger(rootDir, { type: guarded ? "scope_guard_failed" : "scope_guard_inconclusive", planId: taskState.planId, taskId: task.id, reason: result.reason });
    return result;
  }

  const changedPaths = collected.paths.map(normalizeRelativePath);
  const writablePaths = task.writable_paths.map(normalizeRelativePath);
  const realpathFindings = await resolveChangedPathRealpaths(options.executionRoot || rootDir, changedPaths);
  const deniedPaths = [
    ...changedPaths.filter((filePath) => !pathAllowed(filePath, writablePaths)),
    ...realpathFindings
      .filter((finding) => finding.escapesRoot || (finding.realRelativePath && !pathAllowed(finding.realRelativePath, writablePaths)))
      .map((finding) => finding.displayPath),
  ];
  const status = deniedPaths.length === 0 ? "pass" : "fail";
  const result = {
    status,
    taskId: task.id,
    changedPaths,
    writablePaths,
    deniedPaths: [...new Set(deniedPaths)],
    realpathFindings,
  };

  await appendLedger(rootDir, {
    type: status === "pass" ? "scope_guard_passed" : "scope_guard_failed",
    planId: taskState.planId,
    taskId: task.id,
    changedPathCount: changedPaths.length,
    deniedPaths: result.deniedPaths,
  });
  return result;
}

/** 解析变更路径 realpath，检测符号链接逃逸与路径别名。 */
async function resolveChangedPathRealpaths(rootDir, changedPaths) {
  const rootReal = await realpath(rootDir).catch(() => rootDir);
  const findings = [];
  for (const filePath of changedPaths) {
    const absolutePath = path.join(rootDir, filePath);
    const actual = await realpath(absolutePath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!actual) continue;
    const realRelative = normalizeRelativePath(path.relative(rootReal, actual));
    const escapesRoot = realRelative === ".." || realRelative.startsWith("../") || path.isAbsolute(realRelative);
    // §3.4：realpath 与声明路径不一致或逃出 root 时计入 deniedPaths。
    if (escapesRoot || realRelative !== filePath) {
      findings.push({
        path: filePath,
        realRelativePath: escapesRoot ? null : realRelative,
        escapesRoot,
        displayPath: escapesRoot ? `${filePath} -> ${actual}` : `${filePath} -> ${realRelative}`,
      });
    }
  }
  return findings;
}

/** 按 taskId 或首个 in_progress/verifying/pending 任务解析守卫目标。 */
function resolveGuardTask(tasks, taskId) {
  const task = taskId
    ? tasks.find((candidate) => candidate.id === taskId)
    : tasks.find((candidate) => ["in_progress", "verifying", "pending"].includes(candidate.status));
  if (!task) {
    throw new Error(taskId ? `unknown task: ${taskId}` : "no active or pending task found");
  }
  return task;
}
