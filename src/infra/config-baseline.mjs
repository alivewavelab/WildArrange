// =============================================================================
// 文件名称：config-baseline.mjs
// 所属模块：infra
// 作用说明：
//   配置完整性基线：登记治理配置指纹，之后任何变化（含新增配置文件）都会被 verify 报告。
// =============================================================================
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runCommandFile } from "./command-runner.mjs";
import { appendLedger } from "./ledger.mjs";
import { normalizeRelativePath } from "./path-match.mjs";
import {
  ensureWildArrangeDirs,
  hashContent,
  nowIso,
  readJson,
  resolveWildArrangePath,
  resolveGovernancePaths,
  writeJsonAtomic,
} from "./runtime-store.mjs";

/** 配置完整性基线文件在运行态目录下的相对路径段。 */
const CONFIG_BASELINE_PATH = ["security", "config-baseline.json"];

/**
 * writeConfigBaseline：本模块对外异步 API。
 */
export async function writeConfigBaseline(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const baseline = {
    kind: "config_baseline",
    at: nowIso(),
    reason: options.reason || "manual",
    files: await collectConfigFingerprints(rootDir),
    governance: await inspectGovernanceRepository(rootDir),
  };
  const baselinePath = resolveWildArrangePath(rootDir, ...CONFIG_BASELINE_PATH);
  await writeJsonAtomic(baselinePath, baseline);
  await appendLedger(rootDir, {
    type: "config_baseline_written",
    reason: baseline.reason,
    fileCount: baseline.files.length,
    baselinePath: normalizeRelativePath(path.relative(rootDir, baselinePath)),
  });
  return baseline;
}

/**
 * verifyConfigBaseline：本模块对外异步 API。
 */
export async function verifyConfigBaseline(rootDir) {
  await ensureWildArrangeDirs(rootDir);
  const baselinePath = resolveWildArrangePath(rootDir, ...CONFIG_BASELINE_PATH);
  const baseline = await readJson(baselinePath, null);
  const currentFiles = await collectConfigFingerprints(rootDir);
  if (!baseline) {
    return {
      kind: "config_integrity",
      ok: false,
      status: "missing_baseline",
      message: "No config baseline found. Run `node ./bin/wildarrange.mjs config baseline` after reviewing config.",
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
    // 基线未登记的新配置文件也视为完整性失败（防静默扩面）
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
    governance: await inspectGovernanceRepository(rootDir),
    baselineGovernance: baseline.governance || null,
  };
}

/**
 * 收集治理配置的 SHA256 指纹。
 */
async function collectConfigFingerprints(rootDir) {
  const governanceConfig = describeGovernanceConfig(rootDir);
  const candidates = [
    { path: governanceConfig.absolutePath, logicalPath: governanceConfig.logicalPath },
  ];
  const files = [];
  for (const candidate of candidates) {
    const filePath = candidate.path;
    if (!existsSync(filePath)) continue;
    const content = await readFile(filePath, "utf8");
    files.push({
      path: candidate.logicalPath,
      hash: hashContent(content),
      bytes: Buffer.byteLength(content),
    });
  }
  return files;
}

/**
 * 定位治理配置的真实文件：治理仓 policy/wildarrange.config.json。
 */
export function describeGovernanceConfig(rootDir) {
  const governance = resolveGovernancePaths(rootDir);
  const relativePath = normalizeRelativePath(governance.configPath);
  return {
    absolutePath: path.resolve(governance.rootDir, governance.configPath),
    logicalPath: `governance:${relativePath}`,
    backupPath: `governance/${relativePath}`,
  };
}

/**
 * 读取治理仓的 HEAD 与工作区是否干净。
 * 治理仓工作树里未提交的配置改动会被 Hook 立即采用，必须能被体检看到。
 */
export async function inspectGovernanceRepository(rootDir) {
  const governance = resolveGovernancePaths(rootDir);
  const head = await runCommandFile("git", ["-C", governance.rootDir, "rev-parse", "HEAD"], governance.rootDir, 15_000);
  const status = await runCommandFile("git", ["-C", governance.rootDir, "status", "--porcelain"], governance.rootDir, 15_000);
  return {
    root: governance.rootDir,
    head: head.exitCode === 0 ? head.stdout.trim() : null,
    clean: status.exitCode === 0 ? status.stdout.trim().length === 0 : null,
  };
}
