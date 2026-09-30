// =============================================================================
// 文件名称：runtime-store.mjs
// 所属模块：infra
// 作用说明：
//   运行态路径解析、原子 JSON 写入、ID/哈希与时间戳原语。
//
// 【运行原理速读】
//   resolveWildArrangePath → writeJsonAtomic rename → hashContent/createWorkId。
// =============================================================================
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { wildarrangeError } from "./error-protocol.mjs";

/**
 * 项目根到运行态根的进程内绑定（外置治理：runtimeRoot 在客户项目之外）。
 * 未绑定的项目没有运行态，访问时报错并引导 `wildarrange setup`。
 */
const RUNTIME_ROOTS = new Map();

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
  return path.join(resolveWildArrangeRoot(rootDir), ...segments);
}

/** 运行态逻辑路径前缀：配置、报告与决策里指代运行态文件，不是项目内路径。 */
export const RUNTIME_LOGICAL_PREFIX = "runtime:";

/** 生成运行态逻辑路径，如 `runtime:team/tasks.json`。 */
export function runtimeLogicalPath(...segments) {
  return RUNTIME_LOGICAL_PREFIX + path.posix.join(...segments.map((segment) => String(segment).replaceAll("\\", "/")));
}

/** 运行态逻辑路径 → 运行态根内的相对段；不是逻辑路径时返回 null。 */
export function parseRuntimeLogicalPath(value) {
  if (typeof value !== "string" || !value.startsWith(RUNTIME_LOGICAL_PREFIX)) return null;
  return value.slice(RUNTIME_LOGICAL_PREFIX.length).replaceAll("\\", "/");
}

/**
 * 返回项目当前绑定的运行态根；项目未连接外置治理时抛出可行动错误。
 */
export function resolveWildArrangeRoot(rootDir) {
  return requireRuntimeBinding(rootDir).runtimeRoot;
}

/** 取得项目的运行态绑定；未连接时引导用户运行 setup，而不是在项目内自动建目录。 */
function requireRuntimeBinding(rootDir) {
  const binding = RUNTIME_ROOTS.get(runtimeRootKey(rootDir));
  if (!binding) throw projectNotConnectedError(rootDir);
  return binding;
}

/** 项目未连接治理仓时的统一错误：明确告知原因并引导 setup，不自动创建任何内容。 */
export function projectNotConnectedError(rootDir) {
  return wildarrangeError({
    code: "project_not_connected",
    module: "infra/runtime-store",
    message: `project is not connected to WildArrange governance: ${path.resolve(rootDir)}`,
    nextAction: "wildarrange setup --governance-root <path> [--repository <git-url>]（连接治理仓并生成运行态；不会写入客户项目）",
  });
}

/**
 * 为当前进程绑定外置运行态根。调用方必须先完成 realpath/边界验证。
 */
export function bindWildArrangeRuntimeRoot(projectRoot, runtimeRoot, governance = null) {
  const project = runtimeRootKey(projectRoot);
  const runtime = path.resolve(runtimeRoot);
  RUNTIME_ROOTS.set(project, { runtimeRoot: runtime, governance });
  return runtime;
}

/**
 * 清除项目运行态根绑定，主要供隔离测试与长寿命宿主切换项目。
 */
export function clearWildArrangeRuntimeRoot(projectRoot) {
  return RUNTIME_ROOTS.delete(runtimeRootKey(projectRoot));
}

/** 返回已验证的治理路径投影（治理仓根、policy 配置与验证注册表相对路径）。 */
export function resolveGovernancePaths(rootDir) {
  return requireRuntimeBinding(rootDir).governance;
}

function runtimeRootKey(rootDir) {
  const absolute = path.resolve(rootDir);
  try {
    const canonical = realpathSync.native(absolute);
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
  } catch {
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  }
}

// §3.4 证据路径：planId 与 taskId 均允许连字符，必须用目录分段而非单 `-` 拼接，
// 否则 stem 碰撞。
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
 * resolveTaskAcceptancePath：本模块对外API。
 */
export function resolveTaskAcceptancePath(rootDir, planId, taskId, extension = "json") {
  assertEvidenceSegment(planId, "planId");
  assertEvidenceSegment(taskId, "taskId");
  assertEvidenceExtension(extension);
  return resolveWildArrangePath(rootDir, "reports", "acceptance", planId, `${taskId}.${extension}`);
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
  try {
    await renameWithRetry(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 在 Windows 文件仍被短暂占用时，对原子替换做有限重试。
 * 只重试可恢复的共享/占用错误；其他错误立即向上抛出。
 */
export async function renameWithRetry(sourcePath, targetPath, options = {}) {
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : 5;
  const delayMs = Number.isInteger(options.delayMs) && options.delayMs >= 0 ? options.delayMs : 25;
  const renameImpl = typeof options.renameImpl === "function" ? options.renameImpl : rename;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await renameImpl(sourcePath, targetPath);
      return;
    } catch (error) {
      const retryable = ["EPERM", "EACCES", "EBUSY"].includes(error?.code);
      if (!retryable || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

/**
 * hashContent：本模块对外API。
 */
export function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * 断言 planId/taskId 为安全证据路径段。
 */
function assertEvidenceSegment(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a safe evidence path segment`);
  }
}

/**
 * 断言证据文件扩展名仅为 json 或 md。
 */
function assertEvidenceExtension(value) {
  if (!new Set(["json", "md"]).has(value)) {
    throw new Error(`unsupported evidence extension: ${value}`);
  }
}
