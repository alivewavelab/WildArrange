/**
 * Generic git/file-manifest change probes. These only *read* what changed;
 * they make no scope/pass-fail decision (that is capabilities/scope-guard.mjs).
 * Used by capabilities (scope-guard), orchestration (linear/parallel runtime,
 * context/resume reporting) alike, so this stays infra-level.
 */
import { existsSync } from "node:fs";
import { lstat, readFile, readlink, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
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

  const [unstaged, staged, untracked] = await Promise.all([
    runCommandFile("git", ["-C", rootDir, "diff", "--name-only", "-z", "--", ".", ":!.wildarrange"], rootDir, 30_000),
    runCommandFile("git", ["-C", rootDir, "diff", "--name-only", "-z", "--cached", "--", ".", ":!.wildarrange"], rootDir, 30_000),
    runCommandFile("git", ["-C", rootDir, "ls-files", "--others", "--exclude-standard", "-z", "--", ".", ":!.wildarrange"], rootDir, 30_000),
  ]);
  if ([staged, unstaged, untracked].some(gitProbeFailed)) {
    return {
      available: false,
      reason: [staged, unstaged, untracked].map(gitProbeFailureReason).filter(Boolean).join("\n") || "git changed path collection failed",
      paths: [],
    };
  }

  const paths = [...new Set([
    ...splitNullPaths(staged.stdout),
    ...splitNullPaths(unstaged.stdout),
    ...splitNullPaths(untracked.stdout),
  ])].sort();
  let indexFingerprints;
  try {
    indexFingerprints = await collectIndexFingerprints(rootDir, paths);
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error), paths: [] };
  }
  const fingerprints = {};
  for (const filePath of paths) {
    const workspace = await fingerprintWorkspacePath(rootDir, filePath);
    const index = indexFingerprints.get(normalizeRelativePath(filePath)) || "absent";
    fingerprints[normalizeRelativePath(filePath)] = `index:${index}|worktree:${workspace}`;
  }
  return {
    available: true,
    source: "git",
    paths,
    fingerprints,
  };
}

async function collectIndexFingerprints(rootDir, paths) {
  const metadataByPath = new Map();
  for (const batch of batchIndexPaths(paths)) {
    const result = await runCommandFile("git", ["--literal-pathspecs", "-C", rootDir, "ls-files", "-s", "-z", "--", ...batch], rootDir, 30_000, { maxOutputChars: 200_000 });
    if (gitProbeFailed(result)) throw new Error(gitProbeFailureReason(result) || "git index fingerprint collection failed");
    for (const record of splitNullPaths(result.stdout)) {
      const separator = record.indexOf("\t");
      if (separator < 0) throw new Error("git index fingerprint record is malformed");
      const filePath = normalizeRelativePath(record.slice(separator + 1));
      const metadata = record.slice(0, separator);
      const entries = metadataByPath.get(filePath) || [];
      entries.push(metadata);
      metadataByPath.set(filePath, entries);
    }
  }
  return new Map([...metadataByPath].map(([filePath, entries]) => [filePath, entries.sort().join(";")]));
}

function batchIndexPaths(paths) {
  const batches = [];
  let batch = [];
  let argvChars = 0;
  let expectedOutputChars = 0;
  for (const filePath of paths) {
    const pathChars = String(filePath).length;
    if (batch.length > 0 && (argvChars + pathChars + 3 > 20_000 || expectedOutputChars + pathChars + 64 > 150_000)) {
      batches.push(batch);
      batch = [];
      argvChars = 0;
      expectedOutputChars = 0;
    }
    batch.push(filePath);
    argvChars += pathChars + 3;
    expectedOutputChars += pathChars + 64;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function gitProbeFailed(result) {
  return result.exitCode !== 0 || result.outputTruncated?.stdout === true;
}

function gitProbeFailureReason(result) {
  if (result.outputTruncated?.stdout === true) return "git changed path output was truncated";
  return result.stderr || (result.exitCode !== 0 ? `git probe failed with exit ${result.exitCode}` : "");
}

async function fingerprintWorkspacePath(rootDir, filePath) {
  try {
    const absolutePath = path.join(rootDir, filePath);
    const entry = await lstat(absolutePath);
    if (entry.isSymbolicLink()) {
      return `symlink:${createHash("sha256").update(await readlink(absolutePath)).digest("hex")}`;
    }
    if (!entry.isFile()) return `special:${entry.mode}:${entry.size}`;
    const content = await readFile(absolutePath);
    return `file:${createHash("sha256").update(content).digest("hex")}`;
  } catch (error) {
    if (error?.code === "ENOENT") return "deleted";
    throw error;
  }
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

function splitNullPaths(value) {
  return String(value || "").split("\0").filter((entry) => entry.length > 0);
}
