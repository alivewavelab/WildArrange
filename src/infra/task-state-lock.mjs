import { ensureHelixDirs, resolveHelixPath } from "./runtime-store.mjs";
import { withFileLock } from "./file-lock.mjs";

// 锁获取/stale 恢复/超时诊断的实现在 file-lock.mjs（与 ledger 锁共用）；
// 本模块只保留任务状态锁的路径与默认参数。owner 内容三行格式
// `ownerTag\npid\nacquiredAt` 由对抗测试钉死，不得更改。
export async function withTaskStateLock(rootDir, ownerTag, fn) {
  await ensureHelixDirs(rootDir);
  const lockPath = resolveHelixPath(rootDir, "team", "tasks.lock");
  return withFileLock(rootDir, lockPath, "task state lock", ownerTag, fn);
}
