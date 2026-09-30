// =============================================================================
// 文件名称：state-backup.mjs
// 所属模块：infra
// 作用说明：
//   运行态状态备份与恢复：一键备份、归档精确恢复包、备份列表、restore 后重验已完成任务。
// =============================================================================
import { existsSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, readdir, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { appendLedger } from "./ledger.mjs";
import { normalizeRelativePath } from "./path-match.mjs";
import { assertSafeId, copyEntry, resolveRelativeInside } from "./recovery-transaction.mjs";
import {
  createWorkId,
  ensureWildArrangeDirs,
  nowIso,
  readJson,
  resolveWildArrangePath,
  resolveGovernancePaths,
  resolveWildArrangeRoot,
  parseRuntimeLogicalPath,
  runtimeLogicalPath,
  writeJsonAtomic,
} from "./runtime-store.mjs";
import { inspectCompletedTaskEvidence, normalizeTaskLedger } from "./task-state-store.mjs";
import { describeGovernanceConfig } from "./config-baseline.mjs";

/** 备份目录内运行态条目的一级目录名。 */
const BACKUP_RUNTIME_DIR = "runtime";

/** state restore 备份清单：须与 ledger 尾 hash 缓存同进同出。 */
const BACKUP_STATE_FILES = [
  { scope: "runtime", segments: ["ledger.jsonl"] },
  // 尾 hash 缓存必须与 ledger 同进同出，否则恢复后缓存尺寸对不上会被
  // fail-closed 当成截断。
  { scope: "runtime", segments: ["ledger-tail.json"] },
  { scope: "runtime", segments: ["work.json"] },
  { scope: "runtime", segments: ["team", "tasks.json"] },
  { scope: "runtime", segments: ["snapshots", "context.json"] },
  { scope: "runtime", segments: ["snapshots", "context.md"] },
  { scope: "runtime", segments: ["security", "config-baseline.json"] },
  // 治理配置在治理仓；真实路径由 resolveGovernancePaths 决定
  { scope: "governance-config" },
];

/**
 * writeRuntimeStateBackup：本模块对外异步 API。
 */
export async function writeRuntimeStateBackup(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const backupId = createWorkId("backup");
  const backupDir = resolveWildArrangePath(rootDir, "backups", backupId);
  await mkdir(backupDir, { recursive: true });
  const files = [];
  for (const descriptor of BACKUP_STATE_FILES) {
    const governanceConfig = descriptor.scope === "governance-config" ? describeGovernanceConfig(rootDir) : null;
    const sourcePath = governanceConfig
      ? governanceConfig.absolutePath
      : resolveWildArrangePath(rootDir, ...descriptor.segments);
    const relativePath = governanceConfig
      ? governanceConfig.backupPath
      : backupRuntimePath(...descriptor.segments);
    const scope = governanceConfig ? { scope: "governance" } : {};
    if (!existsSync(sourcePath)) {
      files.push({ path: relativePath, status: "missing", ...scope });
      continue;
    }
    const targetPath = path.join(backupDir, relativePath);
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    const fileStat = await stat(sourcePath);
    files.push({ path: relativePath, status: "copied", bytes: fileStat.size, ...scope });
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

/**
 * prepareArchiveRecoveryPackage：本模块对外异步 API。
 */
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
  const backupDir = resolveWildArrangePath(rootDir, "backups", backupId);
  const manifestPath = path.join(backupDir, "manifest.json");
  const manifest = await readJson(manifestPath, null);
  if (!manifest || manifest.kind !== "runtime_state_backup") {
    throw new Error(`unknown state backup: ${backupId}`);
  }

  const entriesByPath = new Map((manifest.files || []).map((entry) => [entry.path, entry]));
  const recoveryPaths = [];
  for (const candidate of [...new Set(options.paths || [])]) {
    const sourcePath = resolveBackupSourcePath(rootDir, candidate);
    const relativePath = logicalStatePath(rootDir, sourcePath);
    recoveryPaths.push(relativePath);
    const existing = entriesByPath.get(relativePath);
    // 已在备份 manifest 中且成功复制的路径不必重复 copy
    if (existing?.status === "copied") continue;
    entriesByPath.set(relativePath, await copyBackupEntry(sourcePath, backupDir, relativePath));
  }

  const archivePackage = {
    kind: "task_archive_recovery",
    transactionId,
    taskRef: options.taskRef || null,
    status: "prepared",
    preparedAt: nowIso(),
    stagingPath: runtimeLogicalPath("archive-staging", transactionId),
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

/**
 * updateArchiveRecoveryPackage：本模块对外异步 API。
 */
export async function updateArchiveRecoveryPackage(rootDir, options = {}) {
  assertSafeBackupId(options.backupId);
  assertSafeBackupId(options.transactionId, "archive transaction id");
  if (!["committed", "rolled_back", "recovery_required"].includes(options.status)) {
    throw new Error(`invalid archive recovery status: ${options.status}`);
  }
  const manifestPath = resolveWildArrangePath(rootDir, "backups", options.backupId, "manifest.json");
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

/**
 * listRuntimeStateBackups：本模块对外异步 API。
 */
export async function listRuntimeStateBackups(rootDir) {
  const backupsDir = resolveWildArrangePath(rootDir, "backups");
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

/**
 * restoreRuntimeStateBackup：本模块对外异步 API。
 */
export async function restoreRuntimeStateBackup(rootDir, options = {}) {
  const backupId = options.backupId;
  if (!backupId || typeof backupId !== "string") {
    throw new Error("state restore requires --backup <backupId>");
  }
  assertSafeBackupId(backupId);
  const backupDir = resolveWildArrangePath(rootDir, "backups", backupId);
  const manifest = await readJson(path.join(backupDir, "manifest.json"), null);
  if (!manifest || manifest.kind !== "runtime_state_backup") {
    throw new Error(`unknown state backup: ${backupId}`);
  }
  // §3.4 回滚安全：损坏 manifest 必须在写 pre-restore 备份或动 live state 前 fail-closed。
  for (const file of manifest.files || []) {
    resolveManifestRelativePath(backupDir, file.path, "backup source");
    if (file.scope !== "governance") resolveRestoreTarget(rootDir, file.path);
  }

  // 恢复前先给当前状态留底，恢复错了还能再退回来
  const preRestore = await writeRuntimeStateBackup(rootDir, { reason: `pre-restore:${backupId}` });

  const restored = [];
  const skipped = [];
  for (const file of manifest.files || []) {
    if (file.scope === "governance") {
      // 治理仓是版本化仓库，配置副本仅供取证；恢复走治理仓自己的 Git，不由运行态备份回写
      skipped.push({ path: file.path, reason: "governance_repository_managed" });
      continue;
    }
    if (file.status !== "copied") {
      skipped.push({ path: file.path, reason: "not_in_backup" });
      continue;
    }
    const sourcePath = resolveManifestRelativePath(backupDir, file.path, "backup source");
    const targetPath = resolveRestoreTarget(rootDir, file.path);
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
      // §3.4 回滚安全：备份条目类型与现场不一致时 fail-closed，禁止半恢复
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
  if (restored.includes(backupRuntimePath("ledger.jsonl")) && !restored.includes(backupRuntimePath("ledger-tail.json"))) {
    await unlink(resolveWildArrangePath(rootDir, "ledger-tail.json")).catch(() => undefined);
  }

  // 备份只证明“当时状态长这样”，不证明完成证据仍然成立：恢复回来的
  // completed 必须重新过证据链，不合格的一律降级为 needs_user_decision，
  // 防止伪造备份把没有 verifier/scope/review/acceptance 证据的任务落成终态。
  const downgradedCompleted = await revalidateRestoredCompletedTasks(rootDir);

  await appendLedger(rootDir, {
    type: "runtime_state_restored",
    backupId,
    preRestoreBackupId: preRestore.backupId,
    restoredCount: restored.length,
    skippedCount: skipped.length,
    downgradedCompletedCount: downgradedCompleted.length,
  });

  return {
    kind: "runtime_state_restore",
    at: nowIso(),
    backupId,
    backupAt: manifest.at,
    preRestoreBackupId: preRestore.backupId,
    restored,
    skipped,
    downgradedCompleted,
    archivePackages: manifest.archivePackages || [],
  };
}

/**
 * 恢复备份后重验 completed 任务证据链，不合格降级为 needs_user_decision。
 */
async function revalidateRestoredCompletedTasks(rootDir) {
  const tasksPath = resolveWildArrangePath(rootDir, "team", "tasks.json");
  const raw = await readJson(tasksPath, null);
  if (!raw || !Array.isArray(raw.tasks)) return [];
  const integrity = await inspectCompletedTaskEvidence(rootDir, normalizeTaskLedger(raw));
  if (integrity.invalid.length === 0) return [];
  const invalidByRef = new Map(integrity.invalid.map((entry) => [entry.taskRef, entry]));
  const fallbackPlanId = raw.activePlanId || raw.planId || null;
  const downgraded = [];
  const tasks = raw.tasks.map((task) => {
    const invalid = invalidByRef.get(`${task.planId || fallbackPlanId}:${task.id}`);
    if (!invalid || task.status !== "completed") return task;
    const at = nowIso();
    downgraded.push({ taskId: task.id, taskRef: invalid.taskRef, failures: invalid.failures });
    return {
      ...task,
      status: "needs_user_decision",
      completionRevalidation: {
        required: true,
        reason: "restored_completed_without_valid_proof_chain",
        previousStatus: "completed",
        detectedAt: at,
        failures: invalid.failures,
      },
      history: [
        ...(Array.isArray(task.history) ? task.history : []),
        {
          at,
          event: "restore_completion_requires_revalidation",
          from: "completed",
          to: "needs_user_decision",
        },
      ],
      updatedAt: at,
    };
  });
  await writeJsonAtomic(tasksPath, { ...raw, tasks, updatedAt: nowIso() });
  return downgraded;
}

/**
 * 断言 backupId 为安全单段标识符。
 */
function assertSafeBackupId(value, label = "backup id") {
  assertSafeId(value, label);
}

/**
 * 解析归档恢复源路径，禁止指向 backups 目录。
 */
function resolveBackupSourcePath(rootDir, candidate) {
  if (typeof candidate !== "string" || !candidate) throw new Error("archive recovery path must be a non-empty string");
  const runtimeRoot = resolveWildArrangeRoot(rootDir);
  const runtimeRelative = parseRuntimeLogicalPath(candidate);
  const absolute = runtimeRelative !== null
    ? resolveRelativeInside(runtimeRoot, runtimeRelative || ".", "archive recovery path")
    : path.resolve(candidate);
  // 归档恢复只覆盖运行态：客户项目与治理仓都不由运行态备份回写
  if (!path.isAbsolute(candidate) && runtimeRelative === null) throw new Error(`archive recovery path must be absolute or runtime:<path>: ${candidate}`);
  if (!pathInside(runtimeRoot, absolute)) throw new Error(`archive recovery path escapes runtime root: ${candidate}`);
  if (pathInside(resolveWildArrangePath(rootDir, "backups"), absolute)) throw new Error(`archive recovery path cannot include backups: ${candidate}`);
  return absolute;
}

/**
 * 在 manifest 父目录内解析相对路径，越界抛错。
 */
function resolveManifestRelativePath(parentDir, relativePath, label) {
  return resolveRelativeInside(parentDir, relativePath, label);
}

/** 备份目录内运行态条目的位置：`runtime/<运行态相对路径>`，与 `governance/<...>` 对称。 */
function backupRuntimePath(...segments) {
  return normalizeRelativePath(path.join(BACKUP_RUNTIME_DIR, ...segments));
}

/** manifest 中 `runtime/...` 映射回运行态根；其他条目不属于运行态，拒绝恢复（客户项目零写入）。 */
function resolveRestoreTarget(rootDir, relativePath) {
  const normalized = normalizeRelativePath(String(relativePath));
  if (normalized === BACKUP_RUNTIME_DIR || normalized.startsWith(`${BACKUP_RUNTIME_DIR}/`)) {
    const runtimeRoot = resolveWildArrangeRoot(rootDir);
    return resolveManifestRelativePath(runtimeRoot, normalized.slice(BACKUP_RUNTIME_DIR.length + 1) || ".", "restore target");
  }
  throw new Error(`backup entry is outside the runtime root: ${relativePath}`);
}

/** 把运行态内的绝对路径投影为备份目录内的 `runtime/...` 位置；运行态外的路径拒绝。 */
function logicalStatePath(rootDir, absolutePath) {
  const runtimeRoot = resolveWildArrangeRoot(rootDir);
  if (!pathInside(runtimeRoot, absolutePath)) throw new Error(`archive recovery path escapes runtime root: ${absolutePath}`);
  return backupRuntimePath(path.relative(runtimeRoot, absolutePath));
}

function pathInside(rootDir, candidate) {
  const root = process.platform === "win32" ? path.resolve(rootDir).toLowerCase() : path.resolve(rootDir);
  const target = process.platform === "win32" ? path.resolve(candidate).toLowerCase() : path.resolve(candidate);
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/**
 * 复制单条备份条目到备份目录（委托 copyEntry）。
 */
async function copyBackupEntry(sourcePath, backupDir, relativePath) {
  return copyEntry(sourcePath, backupDir, relativePath);
}
