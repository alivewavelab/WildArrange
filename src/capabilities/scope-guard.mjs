import { realpath } from "node:fs/promises";
import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import { ensureWildArrangeDirs } from "../infra/runtime-store.mjs";
import { collectGitChangedPaths } from "../infra/git-diff.mjs";
import { normalizeRelativePath, pathAllowed } from "../infra/path-match.mjs";
import { loadTaskState } from "../infra/task-state-store.mjs";

export { collectGitDiff, collectGitChangedPaths, changedPathsIntroducedByTask, classifyManifestPathChanges } from "../infra/git-diff.mjs";
export { pathAllowed, pathMatchesPattern } from "../infra/path-match.mjs";

export async function scopeGuard(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");

  const task = resolveGuardTask(taskState.tasks, options.taskId);
  const collected = Array.isArray(options.changedPaths)
    ? { available: true, paths: options.changedPaths }
    : await collectGitChangedPaths(rootDir);

  if (!collected.available) {
    const guarded = (task.writable_paths || []).length > 0;
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
  const realpathFindings = await resolveChangedPathRealpaths(rootDir, changedPaths);
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

function resolveGuardTask(tasks, taskId) {
  const task = taskId
    ? tasks.find((candidate) => candidate.id === taskId)
    : tasks.find((candidate) => ["in_progress", "verifying", "pending"].includes(candidate.status));
  if (!task) {
    throw new Error(taskId ? `unknown task: ${taskId}` : "no active or pending task found");
  }
  return task;
}

