import { ensureWildArrangeDirs, resolveWildArrangePath } from "./runtime-store.mjs";
import { withFileLock } from "./file-lock.mjs";
import { readMaintenanceMarker } from "./recovery-transaction.mjs";

// 锁获取/stale 恢复/超时诊断的实现在 file-lock.mjs（与 ledger 锁共用）；
// 本模块只保留任务状态锁的路径与默认参数。owner 内容三行格式
// `ownerTag\npid\nacquiredAt` 由对抗测试钉死，不得更改。
function throwIfForeignMaintenance(ownerTag, marker) {
  if (String(ownerTag).startsWith("adoption")) return;
  if (marker?.kind !== "adoption_maintenance") return;
  const error = new Error(`接管维护中: session=${marker.sessionId || "unknown"}`);
  error.code = "adoption_maintenance";
  error.nextAction = "等待 adoption 结束，或运行 wildarrange adoption status / resume";
  throw error;
}

export async function withTaskStateLock(rootDir, ownerTag, fn) {
  await ensureWildArrangeDirs(rootDir);
  throwIfForeignMaintenance(ownerTag, await readMaintenanceMarker(rootDir));
  const lockPath = resolveWildArrangePath(rootDir, "team", "tasks.lock");
  return withFileLock(rootDir, lockPath, "task state lock", ownerTag, async () => {
    throwIfForeignMaintenance(ownerTag, await readMaintenanceMarker(rootDir));
    return fn();
  });
}
