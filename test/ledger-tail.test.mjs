import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendLedger, readLedgerTailHash, verifyLedger } from "../src/infra/ledger.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { readJson, resolveHelixPath } from "../src/infra/runtime-store.mjs";

test("appendLedger is fail-closed when the ledger tail line is corrupted", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await appendLedger(dir, { type: "healthy_event" });
    await appendFile(resolveHelixPath(dir, "ledger.jsonl"), "{broken json\n", "utf8");

    await assert.rejects(
      appendLedger(dir, { type: "should_not_land" }),
      (error) => {
        assert.equal(error.protocol.code, "ledger_tail_corrupt");
        assert.match(error.message, /\[HELIX-ledger_tail_corrupt\]/);
        return true;
      },
    );
    await assert.rejects(readLedgerTailHash(dir), /ledger_tail_corrupt/);
  });
});

test("appendLedger refuses to extend a chain that has unhashed tail lines", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await appendLedger(dir, { type: "healthy_event" });
    await appendFile(
      resolveHelixPath(dir, "ledger.jsonl"),
      `${JSON.stringify({ id: "evt-manual", type: "hand_written" })}\n`,
      "utf8",
    );

    await assert.rejects(
      appendLedger(dir, { type: "should_not_land" }),
      (error) => {
        assert.equal(error.protocol.code, "ledger_tail_unhashed");
        return true;
      },
    );
  });
});

test("tail hash cache makes repeat appends O(1) and detects truncation", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await appendLedger(dir, { type: "event_one" });
    await appendLedger(dir, { type: "event_two" });

    const ledgerPath = resolveHelixPath(dir, "ledger.jsonl");
    const cache = await readJson(resolveHelixPath(dir, "ledger-tail.json"), null);
    assert.ok(cache, "tail cache should exist after append");
    assert.equal(cache.size, (await stat(ledgerPath)).size);
    const tailHash = await readLedgerTailHash(dir);
    assert.equal(cache.hash, tailHash);

    // 缓存未更新但文件变大（如崩溃恢复）→ 回退全量扫描，链保持合法。
    await writeFile(resolveHelixPath(dir, "ledger-tail.json"), JSON.stringify({ version: 1, hash: "stale", size: 1 }), "utf8");
    await appendLedger(dir, { type: "event_three" });
    assert.equal((await verifyLedger(dir)).ok, true);

    // 文件被截断到小于缓存尺寸 → 拒绝追加。
    await truncate(ledgerPath, 10);
    await assert.rejects(
      appendLedger(dir, { type: "should_not_land" }),
      (error) => {
        assert.equal(error.protocol.code, "ledger_truncated");
        return true;
      },
    );
  });
});

test("legacy ledgers without any hash chain still accept appends", async () => {
  await withTempDir(async (dir) => {
    // 不调 initRuntime：它自己会追加一条带 hash 的 runtime_initialized，
    // 这里要模拟的是 hash 链启用前的纯 legacy 账本。
    const ledgerPath = resolveHelixPath(dir, "ledger.jsonl");
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(ledgerPath, `${JSON.stringify({ id: "evt-legacy", type: "legacy_event" })}\n`, "utf8");

    const entry = await appendLedger(dir, { type: "new_event" });
    assert.equal(entry.prevHash, null);
    const content = await readFile(ledgerPath, "utf8");
    assert.match(content, /legacy_event/);
    assert.match(content, /new_event/);
  });
});

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-ledger-tail-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
