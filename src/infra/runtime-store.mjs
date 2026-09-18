// =============================================================================
// 文件名称：runtime-store.mjs
// 所属模块：infra
// 作用说明：
//   .wildarrange 路径解析、原子 JSON 写入、ID/哈希与时间戳原语。
//
// 【运行原理速读】
//   resolveWildArrangePath → writeJsonAtomic rename → hashContent/createWorkId。
// =============================================================================
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 运行时状态目录名（相对项目根）。
 */
export const WILDARRANGE_DIR = ".wildarrange";
/**
 * 运行时 JSON schema 版本号。
 */
export const STATE_VERSION = 1;
/**
 * 合法任务状态集合。
 */
export const TASK_STATUSES = new Set(["draft", "pending", "in_progress", "verifying", "completed", "failed", "review_blocked", "needs_user_decision"]);
/**
 * 合法任务工作类型集合。
 */
export const TASK_WORK_TYPES = new Set(["feature", "bug", "acceptance_correction", "maintenance"]);
/**
 * 任务来源枚举集合。
 */
export const TASK_SOURCES = new Set(["user", "verifier", "review", "incident", "imported"]);
/**
 * 任务优先级集合。
 */
export const TASK_PRIORITIES = new Set(["P0", "P1", "P2"]);

/**
 * 返回当前 UTC ISO 时间字符串。
 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * createWorkId：本模块对外API。
 */
export function createWorkId(prefix = "work") {
  return `${prefix}_${randomUUID()}`;
}

/**
 * resolveWildArrangePath：本模块对外API。
 */
export function resolveWildArrangePath(rootDir, ...segments) {
  return path.join(rootDir, WILDARRANGE_DIR, ...segments);
}

// Evidence identity must remain a one-to-one mapping even though both IDs may
// contain "-". New files therefore use plan/task directory segments; the
// legacy flat helpers exist only for guarded compatibility reads and cleanup.
/**
 * resolveTaskPacketPath：本模块对外API。
 */
export function resolveTaskPacketPath(rootDir, planId, taskId, name = "") {
  assertEvidenceSegment(planId, "planId");
  assertEvidenceSegment(taskId, "taskId");
  if (name && !new Set(["baseline.json", "README.md", "research.md"]).has(name)) throw new Error(`unsupported task packet file: ${name}`);
  return resolveWildArrangePath(rootDir, "task-packets", planId, taskId, ...(name ? [name] : []));
}

/**
 * resolveTaskCheckpointPath：本模块对外API。
 */
export function resolveTaskCheckpointPath(rootDir, planId, taskId) {
  assertEvidenceSegment(planId, "planId");
  assertEvidenceSegment(taskId, "taskId");
  return resolveWildArrangePath(rootDir, "checkpoints", planId, `${taskId}.json`);
}

/**
 * resolveLegacyTaskCheckpointPath：本模块对外API。
 */
export function resolveLegacyTaskCheckpointPath(rootDir, planId, taskId) {
  assertEvidenceSegment(planId, "planId");
  assertEvidenceSegment(taskId, "taskId");
  return resolveWildArrangePath(rootDir, "checkpoints", `${planId}-${taskId}.json`);
}

/**
 * resolveTaskAcceptancePath：本模块对外API。
 */
export function resolveTaskAcceptancePath(rootDir, planId, taskId, extension = "json") {
  assertEvidenceSegment(planId, "planId");
  assertEvidenceSegment(taskId, "taskId");
  assertEvidenceExtension(extension);
  return resolveWildArrangePath(rootDir, "reports", "acceptance", planId, `${taskId}.${extension}`);
}

/**
 * resolveLegacyTaskAcceptancePath：本模块对外API。
 */
export function resolveLegacyTaskAcceptancePath(rootDir, planId, taskId, extension = "json") {
  assertEvidenceSegment(planId, "planId");
  assertEvidenceSegment(taskId, "taskId");
  assertEvidenceExtension(extension);
  return resolveWildArrangePath(rootDir, "reports", "acceptance", `${planId}-${taskId}.${extension}`);
}

/**
 * resolveTaskReportPath：本模块对外API。
 */
export function resolveTaskReportPath(rootDir, reportKind, planId, taskId, extension = "json") {
  if (!new Set(["reviews", "failures", "readiness"]).has(reportKind)) {
    throw new Error(`unsupported task report kind: ${reportKind}`);
  }
  assertEvidenceSegment(planId, "planId");
  assertEvidenceSegment(taskId, "taskId");
  assertEvidenceExtension(extension);
  return resolveWildArrangePath(rootDir, "reports", reportKind, planId, `${taskId}.${extension}`);
}

/**
 * legacyTaskEvidenceStem：本模块对外API。
 */
export function legacyTaskEvidenceStem(planId, taskId) {
  assertEvidenceSegment(planId, "planId");
  assertEvidenceSegment(taskId, "taskId");
  return `${planId}-${taskId}`;
}

/**
 * ensureWildArrangeDirs：本模块对外异步 API。
 */
export async function ensureWildArrangeDirs(rootDir) {
  const dirs = [
    [],
    ["plans"],
    ["plan-drafts"],
    ["team"],
    ["team", "inbox"],
    ["team", "outbox"],
    ["sessions"],
    ["snapshots"],
    ["artifacts"],
    ["adapters"],
    ["adapters", "codex"],
    ["adapters", "cursor"],
    ["checkpoints"],
    ["reports"],
    ["reports", "failures"],
    ["reports", "reviews"],
    ["reports", "acceptance"],
    ["rules"],
    ["wisdom"],
    ["changes"],
    ["context-agents"],
    ["agent-runs"],
    ["memory"],
    ["memory", "digests"],
    ["memory", "stage-summaries"],
    ["routing"],
    ["routing", "suggestions"],
  ];

  for (const dir of dirs) {
    await mkdir(resolveWildArrangePath(rootDir, ...dir), { recursive: true });
  }
}

/**
 * readJson：本模块对外异步 API。
 */
export async function readJson(filePath, fallback = undefined) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (fallback !== undefined && error?.code === "ENOENT") return fallback;
    throw error;
  }
}

/**
 * writeJsonAtomic：本模块对外异步 API。
 */
export async function writeJsonAtomic(filePath, value) {
  return writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * writeTextAtomic：本模块对外异步 API。
 */
export async function writeTextAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(tempPath, String(content), "utf8");
  await rename(tempPath, filePath);
}

/**
 * hashContent：本模块对外API。
 */
export function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

function assertEvidenceSegment(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a safe evidence path segment`);
  }
}

function assertEvidenceExtension(value) {
  if (!new Set(["json", "md"]).has(value)) {
    throw new Error(`unsupported evidence extension: ${value}`);
  }
}
