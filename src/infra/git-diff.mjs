/**
 * Generic git/file-manifest change probes. These only *read* what changed;
 * they make no scope/pass-fail decision (that is capabilities/scope-guard.mjs).
 * Used by capabilities (scope-guard), orchestration (linear/parallel runtime,
 * context/resume reporting) alike, so this stays infra-level.
 */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { runCommandFile } from "./command-runner.mjs";
import { normalizeRelativePath } from "./path-match.mjs";

export async function collectGitDiff(rootDir) {
  const gitDir = path.join(rootDir, ".git");
  if (!existsSync(gitDir)) return "";
  const result = await runCommandFile("git", ["-C", rootDir, "diff", "--", ".", ":!.wildarrange"], rootDir, 30_000);
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

  const diff = await runCommandFile("git", ["-C", rootDir, "diff", "--name-only", "--", ".", ":!.wildarrange"], rootDir, 30_000);
  const untracked = await runCommandFile("git", ["-C", rootDir, "ls-files", "--others", "--exclude-standard", "--", ".", ":!.wildarrange"], rootDir, 30_000);
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

const FILE_MANIFEST_SKIP_DIRS = new Set([".git", ".wildarrange", "node_modules"]);

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
