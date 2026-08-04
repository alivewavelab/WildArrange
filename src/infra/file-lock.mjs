/**
 * 统一的 .helix 文件锁原语：task-state 锁与 ledger 锁共用。
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

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function lockOwnerContent(ownerTag) {
  return `${ownerTag}\n${process.pid}\n${Date.now()}\n`;
}

function parseLockOwner(content) {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 3) return null;
  const ownerPid = Number.parseInt(lines[1], 10);
  const acquiredAt = Number.parseInt(lines[2], 10);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return null;
  if (!Number.isInteger(acquiredAt) || acquiredAt <= 0) return null;
  return { ownerTag: lines[0], ownerPid, acquiredAt };
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user — alive.
    return error?.code === "EPERM";
  }
}

async function readLockState(lockPath) {
  try {
    const [content, lockStat] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
    const owner = parseLockOwner(content);
    return { exists: true, owner, mtimeMs: lockStat.mtimeMs };
  } catch {
    return { exists: false, owner: null, mtimeMs: null };
  }
}

async function isStaleLock(lockPath) {
  const state = await readLockState(lockPath);
  if (!state.exists) return false;
  if (!state.owner) return Date.now() - state.mtimeMs > LOCK_UNPARSEABLE_STALE_AFTER_MS;
  return !isPidAlive(state.owner.ownerPid);
}

async function removeLock(lockPath) {
  await unlink(lockPath).catch(() => undefined);
}

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
      ? "; another helix process is actively working — wait for it or investigate that pid"
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

export async function withFileLock(rootDir, lockPath, lockName, ownerTag, fn, options = {}) {
  const waitTimeoutMs = options.waitTimeoutMs ?? LOCK_WAIT_TIMEOUT_MS;
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const startedAt = Date.now();

  for (;;) {
    if (Date.now() - startedAt > waitTimeoutMs) {
      throw await lockTimeoutError(rootDir, lockPath, lockName, Date.now() - startedAt);
    }
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(lockOwnerContent(ownerTag));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
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
    await removeLock(lockPath);
  }
}
