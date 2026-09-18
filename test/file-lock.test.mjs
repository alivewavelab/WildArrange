// =============================================================================
// 文件名称：file-lock.test.mjs
// 所属模块：test
// 作用说明：
//   验证 file-lock 原语：ledger 锁 dead-pid/旧格式 stale 回收、
//   锁超时错误含 owner/pid/存活诊断。
//   不测：跨机器分布式锁或 NFS 语义。
//
// 【运行原理速读】
//   预写损坏/过期 lock 文件后调用 appendLedger/withFileLock，
//   断言成功写入或抛出可诊断超时而非永久阻塞。
// =============================================================================

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { withFileLock } from "../src/infra/file-lock.mjs";
import { appendLedger } from "../src/infra/ledger.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { resolveWildArrangePath } from "../src/infra/runtime-store.mjs";

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
    const lockPath = resolveWildArrangePath(dir, "ledger.lock");
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
    const lockPath = resolveWildArrangePath(dir, "ledger.lock");
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
    const lockPath = resolveWildArrangePath(dir, "team", "tasks.lock");
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
    const lockPath = resolveWildArrangePath(dir, "team", "tasks.lock");
    await writeFile(lockPath, "", "utf8"); // 空锁、mtime 新鲜：宽限期内不可回收

    await assert.rejects(
      withFileLock(dir, lockPath, "task state lock", "probe", async () => {}, { waitTimeoutMs: 300, retryMs: 50 }),
      /unparsable.*stale cleanup/s,
    );
  });
});

test("release does not delete a lock that was reclaimed and re-acquired by another owner", async () => {
  await withTempDir(async (dir) => {
    const lockPath = path.join(dir, "race.lock");
    // 持锁期间锁被 stale 回收并被他人重新获取：内容已换，释放时必须放弃删除。
    const intruderContent = `other-owner\n999999\n${Date.now()}\n`;
    await withFileLock(dir, lockPath, "race lock", "first-owner", async () => {
      await writeFile(lockPath, intruderContent, "utf8");
    });
    assert.equal(await readFile(lockPath, "utf8"), intruderContent, "new owner's lock must survive the first owner's release");
  });
});

test("release rechecks the mtime fingerprint even when the content is unchanged", async () => {
  await withTempDir(async (dir) => {
    const lockPath = path.join(dir, "race-mtime.lock");
    let heldContent;
    await withFileLock(dir, lockPath, "race lock", "first-owner", async () => {
      heldContent = await readFile(lockPath, "utf8");
      // 内容逐字节相同但 mtime 已变：仍是他人重建的锁，不得删除。
      await writeFile(lockPath, heldContent, "utf8");
      const later = new Date(Date.now() + 5000);
      await utimes(lockPath, later, later);
    });
    assert.equal(await readFile(lockPath, "utf8"), heldContent, "re-created lock with identical bytes must still survive");
  });
});

test("a normal release still removes its own lock", async () => {
  await withTempDir(async (dir) => {
    const lockPath = path.join(dir, "normal.lock");
    await withFileLock(dir, lockPath, "normal lock", "owner", async () => {});
    await assert.rejects(readFile(lockPath, "utf8"), /ENOENT/, "own lock must be released");
  });
});

