/**
 * file-lock 原语测试：ledger 锁的 stale 恢复（死 pid / 旧格式不可解析）
 * 与锁超时的可诊断错误（owner/pid/存活状态）。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { withFileLock } from "../src/infra/file-lock.mjs";
import { appendLedger, initRuntime, resolveHelixPath } from "../src/helix-core.mjs";

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-lock-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("ledger append recovers from a dead-pid lock instead of timing out", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const lockPath = resolveHelixPath(dir, "ledger.lock");
    // 三行 owner 格式，pid 999999 已死：必须立即判 stale 回收。
    await writeFile(lockPath, `crashed-writer\n999999\n${Date.now()}\n`, "utf8");

    const entry = await appendLedger(dir, { type: "lock_recovery_probe" });
    assert.equal(entry.type, "lock_recovery_probe");
    await assert.rejects(readFile(lockPath, "utf8"), /ENOENT/, "lock must be released after the append");
  });
});

test("ledger append recovers from a legacy two-line lock after the mtime grace", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const lockPath = resolveHelixPath(dir, "ledger.lock");
    // 旧格式 `pid\nts` 不可解析；mtime 超过宽限期后按 stale 回收。
    await writeFile(lockPath, `12345\n${Date.now()}\n`, "utf8");
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    const entry = await appendLedger(dir, { type: "legacy_lock_probe" });
    assert.equal(entry.type, "legacy_lock_probe");
  });
});

test("lock timeout error names the owner, pid, liveness and wait budget", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const lockPath = resolveHelixPath(dir, "team", "tasks.lock");
    // 持锁者是当前进程（pid 存活）：不可判 stale，必须超时且报错带诊断。
    await writeFile(lockPath, `parallel-admit:T001\n${process.pid}\n${Date.now()}\n`, "utf8");

    const startedAt = Date.now();
    await assert.rejects(
      withFileLock(dir, lockPath, "task state lock", "probe", async () => {}, { waitTimeoutMs: 300, retryMs: 50 }),
      (error) => {
        assert.match(error.message, /timed out acquiring task state lock after \d+ms/);
        assert.match(error.message, /tag=parallel-admit:T001/);
        assert.match(error.message, new RegExp(`pid=${process.pid}`));
        assert.match(error.message, /pidAlive=true/);
        assert.match(error.message, /acquiredAt=/);
        return true;
      },
    );
    assert.ok(Date.now() - startedAt >= 300, "must actually wait the budget before failing");
  });
});

test("lock timeout on an unparsable fresh lock explains the stale grace", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const lockPath = resolveHelixPath(dir, "team", "tasks.lock");
    await writeFile(lockPath, "", "utf8"); // 空锁、mtime 新鲜：宽限期内不可回收

    await assert.rejects(
      withFileLock(dir, lockPath, "task state lock", "probe", async () => {}, { waitTimeoutMs: 300, retryMs: 50 }),
      /unparsable.*stale cleanup/s,
    );
  });
});
