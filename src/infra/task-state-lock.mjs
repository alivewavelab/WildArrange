import { open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { ensureHelixDirs, resolveHelixPath } from "./runtime-store.mjs";

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
  return { ownerPid, acquiredAt };
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

async function isStaleLock(lockPath) {
  try {
    const [content, lockStat] = await Promise.all([
      readFile(lockPath, "utf8"),
      stat(lockPath),
    ]);
    const owner = parseLockOwner(content);
    if (!owner) return Date.now() - lockStat.mtimeMs > LOCK_UNPARSEABLE_STALE_AFTER_MS;
    if (isPidAlive(owner.ownerPid)) return false;
    return true;
  } catch {
    return false;
  }
}

async function removeLock(lockPath) {
  await unlink(lockPath).catch(() => undefined);
}

export async function withTaskStateLock(rootDir, ownerTag, fn) {
  await ensureHelixDirs(rootDir);
  const lockPath = resolveHelixPath(rootDir, "team", "tasks.lock");
  const startedAt = Date.now();

  for (;;) {
    if (Date.now() - startedAt > LOCK_WAIT_TIMEOUT_MS) {
      throw new Error(`timed out acquiring task state lock: ${path.relative(rootDir, lockPath)}`);
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
      await delay(LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await removeLock(lockPath);
  }
}
