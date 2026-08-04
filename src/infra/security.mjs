import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
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
  const backupDir = resolveHelixPath(rootDir, "backups", backupId);
  const manifest = await readJson(path.join(backupDir, "manifest.json"), null);
  if (!manifest || manifest.kind !== "runtime_state_backup") {
    throw new Error(`unknown state backup: ${backupId}`);
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
    const sourcePath = path.join(backupDir, file.path);
    const targetPath = path.join(rootDir, file.path);
    if (!existsSync(sourcePath)) {
      skipped.push({ path: file.path, reason: "backup_file_missing" });
      continue;
    }
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
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
  };
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
