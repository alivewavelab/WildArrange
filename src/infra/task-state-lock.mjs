// =============================================================================
// 文件名称：task-state-lock.mjs
// 所属模块：infra
// 作用说明：
//   task-state 专用文件锁包装，委托 file-lock.mjs。
//
// 【运行原理速读】
//   withTaskStateLock → resolve task-state.lock → withFileLock 执行变更。
// =============================================================================
import { ensureWildArrangeDirs, resolveWildArrangePath } from "./runtime-store.mjs";
import { withFileLock } from "./file-lock.mjs";
import { appendLedger } from "./ledger.mjs";
import { readMaintenanceMarker } from "./recovery-transaction.mjs";

// 锁获取/stale 恢复/超时诊断的实现在 file-lock.mjs（与 ledger 锁共用）；
// 本模块只保留任务状态锁的路径与默认参数。owner 内容三行格式
// `ownerTag\npid\nacquiredAt` 由对抗测试钉死，不得更改。
/**
 * 检测到外来 maintenance marker 时抛错，防止并发恢复。
 */
function throwIfForeignMaintenance(ownerTag, marker) {
  if (String(ownerTag).startsWith("adoption")) return;
  if (marker?.kind !== "adoption_maintenance") return;
  const error = new Error(`接管维护中: session=${marker.sessionId || "unknown"}`);
  error.code = "adoption_maintenance";
  error.nextAction = "等待 adoption 结束，或运行 wildarrange adoption status / resume";
  throw error;
}

/**
 * withTaskStateLock：本模块对外异步 API。
 */
export async function withTaskStateLock(rootDir, ownerTag, fn) {
  await ensureWildArrangeDirs(rootDir);
  throwIfForeignMaintenance(ownerTag, await readMaintenanceMarker(rootDir));
  const lockPath = resolveWildArrangePath(rootDir, "team", "tasks.lock");
  return withFileLock(rootDir, lockPath, "task state lock", ownerTag, async () => {
    throwIfForeignMaintenance(ownerTag, await readMaintenanceMarker(rootDir));
    return fn();
  });
}

// 非完成路径的统一事务原语：先写审计账本（appendLedger），再改实际状态
// （persist），与完成路径 commitTaskCompletionState 的顺序一致。账本失败时
// persist 不执行（无账状态不得出现）；persist 失败时账本已留痕（可审计）。
// 锁方向全仓固定为 任务状态锁(外，由调用方持有) → ledger 锁(内，由
// appendLedger 自取)；本函数自身不获取任务状态锁，禁止反向嵌套。
/**
 * transactWithLedger：本模块对外异步 API。
 */
export async function transactWithLedger(rootDir, event, persist) {
  const entry = await appendLedger(rootDir, event);
  await persist(entry);
  return entry;
}

