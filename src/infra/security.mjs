import { existsSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, readFile, readdir, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { HELIX_CONFIG_FILE } from "./runtime-config.mjs";
import { appendLedger } from "./ledger.mjs";
import {
  createWorkId,
  ensureHelixDirs,
  hashContent,
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
} from "./runtime-store.mjs";

const CONFIG_BASELINE_PATH = ["security", "config-baseline.json"];
const BACKUP_STATE_FILES = [
  [".helix", "ledger.jsonl"],
  // 尾 hash 缓存必须与 ledger 同进同出，否则恢复后缓存尺寸对不上会被
  // fail-closed 当成截断。
  [".helix", "ledger-tail.json"],
  [".helix", "work.json"],
  [".helix", "team", "tasks.json"],
  [".helix", "snapshots", "context.json"],
  [".helix", "snapshots", "context.md"],
  [".helix", "security", "config-baseline.json"],
  [HELIX_CONFIG_FILE],
  [".helix", "config.json"],
];
const REQUIRED_STATE_FILES = [
  [".helix", "ledger.jsonl"],
  [".helix", "work.json"],
];

export async function writeConfigBaseline(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const baseline = {
    kind: "config_baseline",
    at: nowIso(),
    reason: options.reason || "manual",
    files: await collectConfigFingerprints(rootDir),
  };
  const baselinePath = resolveHelixPath(rootDir, ...CONFIG_BASELINE_PATH);
  await writeJsonAtomic(baselinePath, baseline);
  await appendLedger(rootDir, {
    type: "config_baseline_written",
    reason: baseline.reason,
    fileCount: baseline.files.length,
    baselinePath: path.relative(rootDir, baselinePath),
  });
  return baseline;
}

export async function verifyConfigBaseline(rootDir) {
  await ensureHelixDirs(rootDir);
  const baselinePath = resolveHelixPath(rootDir, ...CONFIG_BASELINE_PATH);
  const baseline = await readJson(baselinePath, null);
  const currentFiles = await collectConfigFingerprints(rootDir);
  if (!baseline) {
    return {
      kind: "config_integrity",
      ok: false,
      status: "missing_baseline",
      message: "No config baseline found. Run `node ./bin/helix.mjs config baseline` after reviewing config.",
      files: currentFiles,
      failures: [],
    };
  }

  const expected = new Map((baseline.files || []).map((file) => [file.path, file]));
  const current = new Map(currentFiles.map((file) => [file.path, file]));
  const failures = [];
  for (const [filePath, expectedFile] of expected.entries()) {
    const currentFile = current.get(filePath);
    if (!currentFile) {
      failures.push({ path: filePath, reason: "missing_now" });
      continue;
    }
    if (expectedFile.hash !== currentFile.hash) {
      failures.push({ path: filePath, reason: "hash_mismatch", expected: expectedFile.hash, actual: currentFile.hash });
    }
  }
  for (const [filePath] of current.entries()) {
    if (!expected.has(filePath)) failures.push({ path: filePath, reason: "new_config_file" });
  }

  return {
    kind: "config_integrity",
    ok: failures.length === 0,
    status: failures.length === 0 ? "pass" : "fail",
    baselineAt: baseline.at,
    baselineReason: baseline.reason,
    files: currentFiles,
    failures,
  };
}

export async function writeRuntimeStateBackup(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const backupId = createWorkId("backup");
  const backupDir = resolveHelixPath(rootDir, "backups", backupId);
  await mkdir(backupDir, { recursive: true });
  const files = [];
  for (const segments of BACKUP_STATE_FILES) {
    const sourcePath = path.join(rootDir, ...segments);
    const relativePath = path.relative(rootDir, sourcePath);
    if (!existsSync(sourcePath)) {
      files.push({ path: relativePath, status: "missing" });
      continue;
    }
    const targetPath = path.join(backupDir, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    const fileStat = await stat(sourcePath);
    files.push({ path: relativePath, status: "copied", bytes: fileStat.size });
  }
  const manifest = {
    kind: "runtime_state_backup",
    backupId,
    at: nowIso(),
    reason: options.reason || "manual",
    files,
  };
  await writeJsonAtomic(path.join(backupDir, "manifest.json"), manifest);
  await appendLedger(rootDir, {
    type: "runtime_state_backup_written",
    backupId,
    copiedCount: files.filter((file) => file.status === "copied").length,
    reason: manifest.reason,
  });
  return manifest;
}

export async function prepareArchiveRecoveryPackage(rootDir, options = {}) {
  let backupId = options.backupId;
  if (!backupId) {
    const backup = await writeRuntimeStateBackup(rootDir, {
      reason: options.reason || `pre-task-archive:${options.taskRef || "unknown"}`,
    });
    backupId = backup.backupId;
  }
  assertSafeBackupId(backupId);
  const transactionId = options.transactionId || createWorkId("archive");
  assertSafeBackupId(transactionId, "archive transaction id");
  const backupDir = resolveHelixPath(rootDir, "backups", backupId);
  const manifestPath = path.join(backupDir, "manifest.json");
  const manifest = await readJson(manifestPath, null);
  if (!manifest || manifest.kind !== "runtime_state_backup") {
    throw new Error(`unknown state backup: ${backupId}`);
  }

  const entriesByPath = new Map((manifest.files || []).map((entry) => [entry.path, entry]));
  const recoveryPaths = [];
  for (const candidate of [...new Set(options.paths || [])]) {
    const sourcePath = resolveBackupSourcePath(rootDir, candidate);
    const relativePath = path.relative(rootDir, sourcePath);
    recoveryPaths.push(relativePath);
    const existing = entriesByPath.get(relativePath);
    if (existing?.status === "copied") continue;
    entriesByPath.set(relativePath, await copyBackupEntry(sourcePath, backupDir, relativePath));
  }

  const archivePackage = {
    kind: "task_archive_recovery",
    transactionId,
    taskRef: options.taskRef || null,
    status: "prepared",
    preparedAt: nowIso(),
    stagingPath: path.join(".helix", "archive-staging", transactionId),
    paths: recoveryPaths,
  };
  const archivePackages = (manifest.archivePackages || [])
    .filter((entry) => entry.transactionId !== transactionId);
  archivePackages.push(archivePackage);
  await writeJsonAtomic(manifestPath, {
    ...manifest,
    files: [...entriesByPath.values()],
    archivePackages,
  });
  return { backupId, transactionId, archivePackage };
}

export async function updateArchiveRecoveryPackage(rootDir, options = {}) {
  assertSafeBackupId(options.backupId);
  assertSafeBackupId(options.transactionId, "archive transaction id");
  if (!["committed", "rolled_back", "recovery_required"].includes(options.status)) {
    throw new Error(`invalid archive recovery status: ${options.status}`);
  }
  const manifestPath = resolveHelixPath(rootDir, "backups", options.backupId, "manifest.json");
  const manifest = await readJson(manifestPath, null);
  if (!manifest || manifest.kind !== "runtime_state_backup") {
    throw new Error(`unknown state backup: ${options.backupId}`);
  }
  let found = false;
  const archivePackages = (manifest.archivePackages || []).map((entry) => {
    if (entry.transactionId !== options.transactionId) return entry;
    found = true;
    return {
      ...entry,
      status: options.status,
      statusAt: nowIso(),
      diagnostic: options.diagnostic || null,
    };
  });
  if (!found) throw new Error(`unknown archive recovery transaction: ${options.transactionId}`);
  await writeJsonAtomic(manifestPath, { ...manifest, archivePackages });
  return archivePackages.find((entry) => entry.transactionId === options.transactionId);
}

export async function listRuntimeStateBackups(rootDir) {
  const backupsDir = resolveHelixPath(rootDir, "backups");
  let entries = [];
  try {
    entries = await readdir(backupsDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const backups = [];
  for (const entry of entries) {
    const manifest = await readJson(path.join(backupsDir, entry, "manifest.json"), null);
    if (manifest?.kind === "runtime_state_backup") {
      backups.push({
        backupId: manifest.backupId,
        at: manifest.at,
        reason: manifest.reason,
        copiedCount: (manifest.files || []).filter((file) => file.status === "copied").length,
        archivePackages: (manifest.archivePackages || []).map((archivePackage) => ({
          transactionId: archivePackage.transactionId,
          taskRef: archivePackage.taskRef,
          status: archivePackage.status,
          stagingPath: archivePackage.stagingPath,
        })),
      });
    }
  }
  return backups.sort((left, right) => String(left.at).localeCompare(String(right.at)));
}

export async function restoreRuntimeStateBackup(rootDir, options = {}) {
  const backupId = options.backupId;
  if (!backupId || typeof backupId !== "string") {
    throw new Error("state restore requires --backup <backupId>");
  }
  assertSafeBackupId(backupId);
  const backupDir = resolveHelixPath(rootDir, "backups", backupId);
  const manifest = await readJson(path.join(backupDir, "manifest.json"), null);
  if (!manifest || manifest.kind !== "runtime_state_backup") {
    throw new Error(`unknown state backup: ${backupId}`);
  }
  // Validate the complete manifest before creating the pre-restore backup or
  // touching live state. A damaged manifest must fail without side effects.
  for (const file of manifest.files || []) {
    resolveManifestRelativePath(backupDir, file.path, "backup source");
    resolveManifestRelativePath(rootDir, file.path, "restore target");
  }

  // 恢复前先给当前状态留底，恢复错了还能再退回来
  const preRestore = await writeRuntimeStateBackup(rootDir, { reason: `pre-restore:${backupId}` });

  const restored = [];
  const skipped = [];
  for (const file of manifest.files || []) {
    if (file.status !== "copied") {
      skipped.push({ path: file.path, reason: "not_in_backup" });
      continue;
    }
    const sourcePath = resolveManifestRelativePath(backupDir, file.path, "backup source");
    const targetPath = resolveManifestRelativePath(rootDir, file.path, "restore target");
    let sourceStat;
    try {
      sourceStat = await lstat(sourcePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        skipped.push({ path: file.path, reason: "backup_file_missing" });
        continue;
      }
      throw error;
    }
    const actualType = sourceStat.isSymbolicLink()
      ? "symlink"
      : sourceStat.isDirectory()
        ? "directory"
        : "file";
    if (file.type && file.type !== actualType) {
      throw new Error(`backup entry type changed: ${file.path}; expected ${file.type}, got ${actualType}`);
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    if (actualType === "directory") {
      await rm(targetPath, { recursive: true, force: true });
      await cp(sourcePath, targetPath, { recursive: true, force: true, verbatimSymlinks: true });
    } else if (actualType === "symlink") {
      await rm(targetPath, { recursive: true, force: true });
      await cp(sourcePath, targetPath, { force: true, verbatimSymlinks: true });
    } else {
      await copyFile(sourcePath, targetPath);
    }
    restored.push(file.path);
  }

  // 旧备份没有尾 hash 缓存：ledger 被恢复而缓存未恢复时，删掉现场缓存，
  // 让下一次追加回退到全量扫描，而不是误判 ledger_truncated。
  if (restored.includes(".helix/ledger.jsonl") && !restored.includes(".helix/ledger-tail.json")) {
    await unlink(resolveHelixPath(rootDir, "ledger-tail.json")).catch(() => undefined);
  }

  await appendLedger(rootDir, {
    type: "runtime_state_restored",
    backupId,
    preRestoreBackupId: preRestore.backupId,
    restoredCount: restored.length,
    skippedCount: skipped.length,
  });

  return {
    kind: "runtime_state_restore",
    at: nowIso(),
    backupId,
    backupAt: manifest.at,
    preRestoreBackupId: preRestore.backupId,
    restored,
    skipped,
    archivePackages: manifest.archivePackages || [],
  };
}

function assertSafeBackupId(value, label = "backup id") {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a safe single-segment identifier`);
  }
}

function resolveBackupSourcePath(rootDir, candidate) {
  if (typeof candidate !== "string" || !candidate) throw new Error("archive recovery path must be a non-empty string");
  const sourcePath = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(rootDir, candidate);
  const rootPath = path.resolve(rootDir);
  if (sourcePath !== rootPath && !sourcePath.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error(`archive recovery path escapes project root: ${candidate}`);
  }
  const backupsPath = resolveHelixPath(rootDir, "backups");
  if (sourcePath === backupsPath || sourcePath.startsWith(`${backupsPath}${path.sep}`)) {
    throw new Error(`archive recovery path cannot include backups: ${candidate}`);
  }
  return sourcePath;
}

function resolveManifestRelativePath(parentDir, relativePath, label) {
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

async function copyBackupEntry(sourcePath, backupDir, relativePath) {
  let sourceStat;
  try {
    sourceStat = await lstat(sourcePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { path: relativePath, status: "missing" };
    throw error;
  }
  const targetPath = resolveManifestRelativePath(backupDir, relativePath, "backup target");
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

export async function verifyRuntimeState(rootDir) {
  const files = [];
  for (const segments of REQUIRED_STATE_FILES) {
    const filePath = path.join(rootDir, ...segments);
    const relativePath = path.relative(rootDir, filePath);
    if (!existsSync(filePath)) {
      files.push({ path: relativePath, status: "missing" });
      continue;
    }
    const fileStat = await stat(filePath);
    files.push({ path: relativePath, status: "present", bytes: fileStat.size });
  }
  const work = await readJson(resolveHelixPath(rootDir, "work.json"), null);
  const tasksPath = path.join(rootDir, ".helix", "team", "tasks.json");
  if (work?.activePlanId) {
    if (!existsSync(tasksPath)) {
      files.push({ path: ".helix/team/tasks.json", status: "missing" });
    } else {
      const fileStat = await stat(tasksPath);
      files.push({ path: ".helix/team/tasks.json", status: "present", bytes: fileStat.size });
    }
  } else {
    files.push({
      path: ".helix/team/tasks.json",
      status: existsSync(tasksPath) ? "present" : "not_required",
      reason: "no active plan",
    });
  }
  const failures = files.filter((file) => file.status === "missing").map((file) => ({
    path: file.path,
    reason: file.status,
  }));
  return {
    kind: "runtime_state_integrity",
    ok: failures.length === 0,
    status: failures.length === 0 ? "pass" : "fail",
    files,
    failures,
  };
}

async function collectConfigFingerprints(rootDir) {
  const candidates = [
    path.join(rootDir, HELIX_CONFIG_FILE),
    resolveHelixPath(rootDir, "config.json"),
  ];
  const files = [];
  for (const filePath of candidates) {
    if (!existsSync(filePath)) continue;
    const content = await readFile(filePath, "utf8");
    files.push({
      path: path.relative(rootDir, filePath),
      hash: hashContent(content),
      bytes: Buffer.byteLength(content),
    });
  }
  return files;
}
