import { existsSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { appendLedger, ensureHelixDirs } from "../helix-foundation.mjs";
import { loadTaskState } from "../helix-plan.mjs";
import { runCommand } from "./command-runner.mjs";

export async function collectGitDiff(rootDir) {
  const gitDir = path.join(rootDir, ".git");
  if (!existsSync(gitDir)) return "";
  const result = await runCommand("git diff -- . ':!.helix'", rootDir, 30_000);
  return result.exitCode === 0 ? result.stdout : "";
}

export async function collectGitChangedPaths(rootDir) {
  const gitDir = path.join(rootDir, ".git");
  if (!existsSync(gitDir)) {
    try {
      const manifest = await collectFileManifest(rootDir);
      return { available: true, source: "file_manifest", paths: Object.keys(manifest).sort(), fingerprints: manifest };
    } catch (error) {
      return { available: false, reason: `git repository not found and file manifest failed: ${error instanceof Error ? error.message : String(error)}`, paths: [] };
    }
  }

  const diff = await runCommand("git diff --name-only -- . ':!.helix'", rootDir, 30_000);
  const untracked = await runCommand("git ls-files --others --exclude-standard -- . ':!.helix'", rootDir, 30_000);
  if (diff.exitCode !== 0 || untracked.exitCode !== 0) {
    return {
      available: false,
      reason: [diff.stderr, untracked.stderr].filter(Boolean).join("\n") || "git changed path collection failed",
      paths: [],
    };
  }

  return {
    available: true,
    source: "git",
    paths: [...new Set([...splitPathLines(diff.stdout), ...splitPathLines(untracked.stdout)])].sort(),
  };
}

export function changedPathsIntroducedByTask(beforeChanged, afterChanged) {
  if (!beforeChanged.available || !afterChanged.available) {
    return undefined;
  }
  if (beforeChanged.fingerprints && afterChanged.fingerprints) {
    return classifyManifestPathChanges(beforeChanged.fingerprints, afterChanged.fingerprints)
      .map((change) => change.path);
  }
  const before = new Set(beforeChanged.paths.map(normalizeRelativePath));
  return afterChanged.paths.map(normalizeRelativePath).filter((filePath) => !before.has(filePath));
}

export function classifyManifestPathChanges(beforeFingerprints = {}, afterFingerprints = {}) {
  const allPaths = new Set([
    ...Object.keys(beforeFingerprints).map(normalizeRelativePath),
    ...Object.keys(afterFingerprints).map(normalizeRelativePath),
  ]);
  return [...allPaths]
    .map((filePath) => {
      const beforeHas = Object.hasOwn(beforeFingerprints, filePath);
      const afterHas = Object.hasOwn(afterFingerprints, filePath);
      if (!beforeHas && afterHas) return { path: filePath, status: "added" };
      if (beforeHas && !afterHas) return { path: filePath, status: "deleted" };
      if (beforeFingerprints[filePath] !== afterFingerprints[filePath]) return { path: filePath, status: "modified" };
      return null;
    })
    .filter(Boolean)
    .sort((left, right) => left.path.localeCompare(right.path));
}

const FILE_MANIFEST_SKIP_DIRS = new Set([".git", ".helix", "node_modules"]);

async function collectFileManifest(rootDir, relativeDir = "") {
  const absoluteDir = path.join(rootDir, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const manifest = {};
  for (const entry of entries) {
    const relativePath = normalizeRelativePath(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      if (FILE_MANIFEST_SKIP_DIRS.has(entry.name)) continue;
      Object.assign(manifest, await collectFileManifest(rootDir, relativePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const fileStat = await stat(path.join(rootDir, relativePath));
    manifest[relativePath] = `${fileStat.size}:${fileStat.mtimeMs}`;
  }
  return manifest;
}

function splitPathLines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function scopeGuard(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");

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

function normalizeRelativePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

export function pathAllowed(filePath, writablePaths) {
  if (writablePaths.length === 0) return false;
  const normalizedFile = normalizeRelativePath(filePath);
  return writablePaths.some((pattern) => pathMatchesPattern(normalizedFile, pattern));
}

export function pathMatchesPattern(filePath, pattern) {
  const normalizedPattern = normalizeRelativePath(pattern);
  if (normalizedPattern === filePath) return true;
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  }
  if (!normalizedPattern.includes("*")) {
    const literalPattern = normalizedPattern.replace(/\/$/, "");
    return filePath === literalPattern || filePath.startsWith(`${literalPattern}/`);
  }

  const escaped = normalizedPattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(filePath);
}
