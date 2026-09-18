// =============================================================================
// 文件名称：file-lock.mjs
// 所属模块：infra
// 作用说明：
//   统一 .wildarrange 文件锁：task-state 与 ledger 共用 stale 恢复与可诊断超时。
//
// 【运行原理速读】
//   open wx 独占 → 死 pid 或不可解析 mtime 宽限后回收 → withFileLock 包裹回调。
// =============================================================================
/**
 * 统一的 .wildarrange 文件锁原语：task-state 锁与 ledger 锁共用。
 *
 * - 获取：open("wx") 独占创建，内容三行 `ownerTag\npid\nacquiredAt`；
 * - stale 恢复：owner 不可解析（创建后崩溃）按 mtime 宽限期判 stale；
 *   owner pid 已死立即判 stale；stale 锁删除后重试；
 * - 超时可诊断：抛错前读取当前锁内容，错误消息带 owner/pid/获取时间/
 *   pid 是否存活/已等待时长——低代码维护者把这条错误贴给 AI 即可定位
 *   是谁持锁不放，而不是只看到一个干巴巴的超时。
 */
import { open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

const LOCK_RETRY_MS = 50;
const LOCK_WAIT_TIMEOUT_MS = 15_000;
// Grace for a lock file whose owner line was never written (the acquiring
// process died between creating the file and writing the content). A live
// writer completes the two steps within milliseconds.
const LOCK_UNPARSEABLE_STALE_AFTER_MS = 10_000;

/**
 * 延迟指定毫秒后 resolve 的 Promise。
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 生成锁文件三行内容：ownerTag、pid、acquiredAt。
 */
function lockOwnerContent(ownerTag) {
  return `${ownerTag}\n${process.pid}\n${Date.now()}\n`;
}

/**
 * 解析锁文件内容为 owner 对象；格式不符返回 null。
 */
function parseLockOwner(content) {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 3) return null;
  const ownerPid = Number.parseInt(lines[1], 10);
  const acquiredAt = Number.parseInt(lines[2], 10);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return null;
  if (!Number.isInteger(acquiredAt) || acquiredAt <= 0) return null;
  return { ownerTag: lines[0], ownerPid, acquiredAt };
}

/**
 * 用 kill(pid,0) 探测进程是否存活；EPERM 视为存活。
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user — alive.
    return error?.code === "EPERM";
  }
}

/**
 * 读取锁文件内容与 stat，供诊断与 stale 判定。
 */
async function readLockState(lockPath) {
  try {
    const [content, lockStat] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    const owner = parseLockOwner(content);
    return { exists: true, owner, mtimeMs: lockStat.mtimeMs };
  } catch {
    return { exists: false, owner: null, mtimeMs: null };
  }
}

/**
 * 判断锁文件是否 stale：不可解析内容按 mtime 宽限，否则看 owner pid 是否已死。
 */
async function isStaleLock(lockPath) {
  const state = await readLockState(lockPath);
  if (!state.exists) return false;
  // §3.4 锁顺序：wx 创建与写入非原子；崩溃留空壳锁，仅靠 mtime 宽限回收，避免误删活 writer。
  if (!state.owner) return Date.now() - state.mtimeMs > LOCK_UNPARSEABLE_STALE_AFTER_MS;
  return !isPidAlive(state.owner.ownerPid);
}

/**
 * 无条件删除锁文件（stale 回收路径）。
 */
async function removeLock(lockPath) {
  await unlink(lockPath).catch(() => undefined);
}

// 持锁方释放路径：删除前复核锁文件仍是自己写入的那份（内容与 mtime 均未变）。
// 否则说明锁已被 stale 回收并被他人重新获取，放弃删除，避免误删新 owner 的锁。
/**
 * 持锁方释放：仅当内容与 mtime 未变时才删除，避免误删新 owner。
 */
async function removeHeldLock(lockPath, expectedContent, expectedMtimeMs) {
  try {
    const [content, lockStat] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    if (content !== expectedContent || lockStat.mtimeMs !== expectedMtimeMs) return;
  } catch {
    return;
  }
  await unlink(lockPath).catch(() => undefined);
}

/**
 * 构造可诊断的超时错误，附带当前锁 owner 与 pid 存活状态。
 */
async function lockTimeoutError(rootDir, lockPath, lockName, waitedMs) {
  const relative = path.relative(rootDir, lockPath);
  const state = await readLockState(lockPath);
  if (!state.exists) {
    return new Error(`timed out acquiring ${lockName} after ${waitedMs}ms: ${relative} (lock vanished while waiting; retry the command)`);
  }
  if (!state.owner) {
    return new Error(`timed out acquiring ${lockName} after ${waitedMs}ms: ${relative} (lock file unparsable — a crashed writer left it behind; it becomes eligible for automatic stale cleanup ${LOCK_UNPARSEABLE_STALE_AFTER_MS}ms after its mtime)`);
  }
  const alive = isPidAlive(state.owner.ownerPid);
  return new Error(
    `timed out acquiring ${lockName} after ${waitedMs}ms: ${relative} `
    + `(current owner: tag=${state.owner.ownerTag} pid=${state.owner.ownerPid} pidAlive=${alive} acquiredAt=${new Date(state.owner.acquiredAt).toISOString()})`
    + (alive
      ? "; another wildarrange process is actively working — wait for it or investigate that pid"
      : "; the owner process is dead and the lock should have been reclaimed — delete the lock file if this persists"),
  );
}

/**
 * 只读锁检查（运维面板/doctor 用）：当前锁是否存在、owner 是谁、pid 是否
 * 存活、已持有多久。绝不删除或修改锁。
 */
export async function inspectFileLock(rootDir, lockPath) {
  const state = await readLockState(lockPath);
  if (!state.exists) {
    return { path: path.relative(rootDir, lockPath), locked: false };
  }
  if (!state.owner) {
    return {
      path: path.relative(rootDir, lockPath),
      locked: true,
      owner: null,
      ageMs: Date.now() - state.mtimeMs,
      stale: Date.now() - state.mtimeMs > LOCK_UNPARSEABLE_STALE_AFTER_MS,
    };
  }
  return {
    path: path.relative(rootDir, lockPath),
    locked: true,
    owner: state.owner.ownerTag,
    pid: state.owner.ownerPid,
    pidAlive: isPidAlive(state.owner.ownerPid),
    acquiredAt: new Date(state.owner.acquiredAt).toISOString(),
    ageMs: Date.now() - state.owner.acquiredAt,
    stale: !isPidAlive(state.owner.ownerPid),
  };
}

/**
 * withFileLock：本模块对外异步 API。
 */
export async function withFileLock(rootDir, lockPath, lockName, ownerTag, fn, options = {}) {
  const waitTimeoutMs = options.waitTimeoutMs ?? LOCK_WAIT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const startedAt = Date.now();

  let ownerContent;
  let acquiredMtimeMs;
  for (;;) {
    if (Date.now() - startedAt > waitTimeoutMs) {
      throw await lockTimeoutError(rootDir, lockPath, lockName, Date.now() - startedAt);
    }
    try {
      const handle = await open(lockPath, "wx");
      try {
        ownerContent = lockOwnerContent(ownerTag);
        await handle.writeFile(ownerContent);
      } finally {
        await handle.close();
      }
      acquiredMtimeMs = (await stat(lockPath)).mtimeMs;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // §3.4 stale 回收先于重试：dead pid 与不可解析锁均删除后重试 wx，不阻塞其他进程。
      if (await isStaleLock(lockPath)) {
        await removeLock(lockPath);
        continue;
      }
      await delay(retryMs);
    }
  }

  try {
    return await fn();
  } finally {
    await removeHeldLock(lockPath, ownerContent, acquiredMtimeMs);
  }
}

