/**
 * Product-neutral copy / path / digest / manifest / restore primitives.
 * Archive and adoption keep their own persistent schemas; this module only
 * supplies the shared mechanical operations.
 */
import { existsSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { normalizeRelativePath } from "./path-match.mjs";
import {
  hashContent,
  nowIso,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "./runtime-store.mjs";

export const ADOPTION_RECOVERY_KIND = "adoption_change_recovery";
export const ARCHIVE_RECOVERY_KIND = "task_archive_recovery";

export function assertSafeId(value, label = "id") {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a safe single-segment identifier`);
  }
}

export function resolveInboundPath(rootDir, candidate, options = {}) {
  if (typeof candidate !== "string" || !candidate) throw new Error("recovery path must be a non-empty string");
  const sourcePath = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(rootDir, candidate);
  const rootPath = path.resolve(rootDir);
  if (sourcePath !== rootPath && !sourcePath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`recovery path escapes project root: ${candidate}`);
  }
  for (const deny of options.denyPrefixes || []) {
    const denyPath = path.isAbsolute(deny) ? path.resolve(deny) : path.resolve(rootDir, deny);
    if (sourcePath === denyPath || sourcePath.startsWith(`${denyPath}${path.sep}`)) {
      throw new Error(`recovery path is denied: ${candidate}`);
    }
  }
  return sourcePath;
}

export function resolveRelativeInside(parentDir, relativePath, label) {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be relative`);
  }
  const targetPath = path.resolve(parentDir, relativePath);
  const parentPath = path.resolve(parentDir);
  if (targetPath !== parentPath && !targetPath.startsWith(`${parentPath}${path.sep}`)) {
    throw new Error(`${label} escapes its root: ${relativePath}`);
  }
  return targetPath;
}

export async function assertRealpathInsideRoot(rootDir, absolutePath, displayPath) {
  const rootPath = path.resolve(rootDir);
  const targetPath = path.resolve(absolutePath);
  if (targetPath !== rootPath && !targetPath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`path escapes project root: ${displayPath}`);
  }
  let rootReal = rootPath;
  try {
    rootReal = await realpath(rootPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const assertResolved = async (candidatePath) => {
    const candidateReal = await realpath(candidatePath);
    if (candidateReal !== rootReal && !candidateReal.startsWith(`${rootReal}${path.sep}`)) {
      throw new Error(`path escapes project root: ${displayPath}`);
    }
  };

  try {
    await assertResolved(targetPath);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  let ancestor = path.dirname(targetPath);
  for (;;) {
    try {
      await assertResolved(ancestor);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (ancestor === rootPath) return;
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return;
    ancestor = parent;
  }
}

export async function copyEntry(sourcePath, destParent, relativePath) {
  let sourceStat;
  try {
    sourceStat = await lstat(sourcePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { path: relativePath, status: "missing" };
    throw error;
  }
  const targetPath = resolveRelativeInside(destParent, relativePath, "backup target");
  await mkdir(path.dirname(targetPath), { recursive: true });
  if (sourceStat.isDirectory()) {
    await rm(targetPath, { recursive: true, force: true });
    await cp(sourcePath, targetPath, { recursive: true, force: true, verbatimSymlinks: true });
    return { path: relativePath, status: "copied", type: "directory" };
  }
  if (sourceStat.isSymbolicLink()) {
    await rm(targetPath, { recursive: true, force: true });
    await cp(sourcePath, targetPath, { force: true, verbatimSymlinks: true });
    return { path: relativePath, status: "copied", type: "symlink" };
  }
  await copyFile(sourcePath, targetPath);
  return { path: relativePath, status: "copied", type: "file", bytes: sourceStat.size };
}

export async function digestPath(absolutePath) {
  try {
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      const { readlink } = await import("node:fs/promises");
      return hashContent(`symlink:${await readlink(absolutePath)}`);
    }
    if (info.isDirectory()) {
      const names = (await readdir(absolutePath)).sort();
      return hashContent(`dir:${names.join("\n")}`);
    }
    return hashContent(await readFile(absolutePath));
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

export async function capturePreimages(rootDir, relativePaths, stagingDir, options = {}) {
  await mkdir(stagingDir, { recursive: true });
  const entries = [];
  for (const relativePath of uniqueSorted(relativePaths)) {
    const sourcePath = resolveInboundPath(rootDir, relativePath, options);
    await assertRealpathInsideRoot(rootDir, sourcePath, relativePath);
    const copied = await copyEntry(sourcePath, stagingDir, relativePath);
    entries.push({
      ...copied,
      digest: await digestPath(sourcePath),
    });
  }
  return entries;
}

export async function restorePreimages(rootDir, stagingDir, entries, options = {}) {
  const restored = [];
  for (const entry of entries || []) {
    const relativePath = entry.path;
    const targetPath = resolveInboundPath(rootDir, relativePath, options);
    await assertRealpathInsideRoot(rootDir, targetPath, relativePath);
    if (entry.status === "missing") {
      await rm(targetPath, { recursive: true, force: true });
      restored.push({ path: relativePath, action: "removed" });
      continue;
    }
    const sourcePath = resolveRelativeInside(stagingDir, relativePath, "preimage source");
    await mkdir(path.dirname(targetPath), { recursive: true });
    let sourceStat;
    try {
      sourceStat = await lstat(sourcePath);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`preimage missing for ${relativePath}`);
      throw error;
    }
    const actualType = sourceStat.isSymbolicLink() ? "symlink" : sourceStat.isDirectory() ? "directory" : "file";
    if (entry.type && entry.type !== actualType) {
      throw new Error(`preimage type changed: ${relativePath}; expected ${entry.type}, got ${actualType}`);
    }
    await rm(targetPath, { recursive: true, force: true });
    if (actualType === "file") await copyFile(sourcePath, targetPath);
    else await cp(sourcePath, targetPath, { recursive: actualType === "directory", force: true, verbatimSymlinks: true });
    restored.push({ path: relativePath, action: "restored", type: actualType });
  }
  return restored;
}

export function createAdoptionRecoveryManifest({
  transactionId,
  sessionId,
  cardId,
  paths,
  preimage,
}) {
  return {
    kind: ADOPTION_RECOVERY_KIND,
    schemaVersion: 1,
    transactionId,
    sessionId,
    cardId,
    status: "prepared",
    preparedAt: nowIso(),
    paths: [...new Set(paths || [])],
    preimage: preimage || [],
    postimage: [],
    diagnostic: null,
  };
}

export async function writeRecoveryManifest(manifestPath, manifest) {
  await writeJsonAtomic(manifestPath, manifest);
  return manifest;
}

export async function readRecoveryManifest(manifestPath) {
  return readJson(manifestPath, null);
}

export function adoptionSessionDir(rootDir, sessionId) {
  assertSafeId(sessionId, "adoption session id");
  return resolveWildArrangePath(rootDir, "adoption", sessionId);
}

export function adoptionTransactionDir(rootDir, sessionId, cardId) {
  assertSafeId(cardId, "adoption card id");
  return path.join(adoptionSessionDir(rootDir, sessionId), "transactions", cardId);
}

export async function writeMaintenanceMarker(rootDir, payload) {
  const markerPath = resolveWildArrangePath(rootDir, "adoption", "maintenance.json");
  const marker = {
    kind: "adoption_maintenance",
    at: nowIso(),
    ...payload,
  };
  await writeJsonAtomic(markerPath, marker);
  return marker;
}

export async function readMaintenanceMarker(rootDir) {
  return readJson(resolveWildArrangePath(rootDir, "adoption", "maintenance.json"), null);
}

export async function clearMaintenanceMarker(rootDir) {
  const markerPath = resolveWildArrangePath(rootDir, "adoption", "maintenance.json");
  if (!existsSync(markerPath)) return false;
  await rm(markerPath, { force: true });
  return true;
}

function uniqueSorted(values) {
  return [...new Set((values || []).filter(Boolean))].sort();
}
