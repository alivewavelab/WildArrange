import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { helixError } from "./error-protocol.mjs";
import { withFileLock } from "./file-lock.mjs";
import { createWorkId, hashContent, nowIso, readJson, resolveHelixPath, writeJsonAtomic } from "./runtime-store.mjs";

const LEDGER_LOCK_RETRY_MS = 20;
const LEDGER_LOCK_WAIT_TIMEOUT_MS = 10_000;
const LEDGER_TAIL_CACHE_VERSION = 1;

export async function appendLedger(rootDir, event) {
  const ledgerPath = resolveHelixPath(rootDir, "ledger.jsonl");
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  return withLedgerLock(rootDir, async () => {
    const tail = await resolveTailHashForAppend(rootDir, ledgerPath);
    const entry = {
      id: createWorkId("evt"),
      at: nowIso(),
      prevHash: tail.hash,
      ...event,
    };
    entry.hash = hashLedgerEntry(entry);
    const line = `${JSON.stringify(entry)}\n`;
    await appendFile(ledgerPath, line, "utf8");
    // 缓存只是追加路径的 O(1) 提示；verifyLedger 全量走查仍是唯一权威。
    await writeJsonAtomic(tailCachePath(rootDir), {
      version: LEDGER_TAIL_CACHE_VERSION,
      hash: entry.hash,
      size: tail.size + Buffer.byteLength(line, "utf8"),
    });
    return entry;
  });
}

export async function verifyLedger(rootDir) {
  const walk = await walkLedger(rootDir);
  return {
    kind: "ledger_verification",
    ok: walk.failures.length === 0,
    checked: walk.checked,
    legacy: walk.legacy,
    failures: walk.failures,
  };
}

// 只返回通过 hash 链校验的条目；doctor 等对账逻辑必须基于它，
// 避免把手工追加的伪造事件当成完成证据。
export async function readVerifiedLedgerEntries(rootDir) {
  const walk = await walkLedger(rootDir);
  return walk.entries.filter((item) => item.verified).map((item) => item.entry);
}

async function walkLedger(rootDir) {
  const ledgerPath = resolveHelixPath(rootDir, "ledger.jsonl");
  let content = "";
  try {
    content = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { checked: 0, legacy: 0, failures: [], entries: [] };
    }
    throw error;
  }
  const failures = [];
  const entries = [];
  let previousHash = null;
  let chainStarted = false;
  let checked = 0;
  let legacy = 0;
  const lines = content.split(/\r?\n/).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      failures.push({ line: lineNumber, reason: "invalid_json" });
      previousHash = null;
      continue;
    }
    if (!entry.hash) {
      // 兼容 hash 链启用前的历史条目；一旦链已开始，后续无 hash 行视为篡改
      if (chainStarted) {
        failures.push({ line: lineNumber, reason: "unhashed_entry_after_chain_start" });
        entries.push({ entry, line: lineNumber, verified: false });
        continue;
      }
      legacy += 1;
      previousHash = entry.prevHash || null;
      entries.push({ entry, line: lineNumber, verified: false });
      continue;
    }
    chainStarted = true;
    checked += 1;
    let verified = true;
    if ((entry.prevHash || null) !== previousHash) {
      failures.push({ line: lineNumber, reason: "prev_hash_mismatch", expected: previousHash, actual: entry.prevHash || null });
      verified = false;
    }
    const expectedHash = hashLedgerEntry(entry);
    if (entry.hash !== expectedHash) {
      failures.push({ line: lineNumber, reason: "hash_mismatch", expected: expectedHash, actual: entry.hash });
      verified = false;
    }
    entries.push({ entry, line: lineNumber, verified });
    previousHash = entry.hash;
  }
  return { checked, legacy, failures, entries };
}

export async function readLedgerTailHash(rootDir) {
  return readLedgerLastHash(resolveHelixPath(rootDir, "ledger.jsonl"));
}

function tailCachePath(rootDir) {
  return resolveHelixPath(rootDir, "ledger-tail.json");
}

// 追加路径的尾 hash 解析：缓存命中（文件尺寸未变）时 O(1)；尺寸变大
// （正常追加后缓存未更新、或崩溃恢复）时回退到 fail-closed 全量扫描；
// 尺寸变小说明 ledger 被截断/重写，拒绝追加。
async function resolveTailHashForAppend(rootDir, ledgerPath) {
  let size;
  try {
    size = (await stat(ledgerPath)).size;
  } catch (error) {
    if (error?.code === "ENOENT") return { hash: null, size: 0 };
    throw error;
  }
  const cache = await readJson(tailCachePath(rootDir), null);
  if (cache && cache.version === LEDGER_TAIL_CACHE_VERSION && Number.isInteger(cache.size)) {
    if (size < cache.size) {
      throw helixError({
        code: "ledger_truncated",
        module: "infra/ledger.mjs",
        message: `ledger.jsonl shrank from ${cache.size} to ${size} bytes; the ledger may have been truncated or rewritten`,
        nextAction: "运行 node ./bin/helix.mjs ledger verify 与 doctor；必要时用 state list/restore 恢复备份",
      });
    }
    if (size === cache.size) return { hash: cache.hash || null, size };
  }
  return { hash: await readLedgerLastHash(ledgerPath), size };
}

// fail-closed 尾行扫描：尾部坏行不再静默返回 null（那会让下一次追加
// 以 prevHash=null 悄悄分叉链），而是拒绝追加并指向修复动作。
async function readLedgerLastHash(ledgerPath) {
  let content;
  try {
    content = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const lines = content.split(/\r?\n/).filter(Boolean);
  let lastHash = null;
  let lastHashIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      throw helixError({
        code: "ledger_tail_corrupt",
        module: "infra/ledger.mjs",
        message: `ledger.jsonl line ${index + 1} is not valid JSON; refusing to append onto a corrupted chain`,
        nextAction: "运行 node ./bin/helix.mjs ledger verify 定位坏行；修复或用 state restore 恢复后再继续",
      });
    }
    if (entry.hash) {
      lastHash = entry.hash;
      lastHashIndex = index;
    }
  }
  if (lastHashIndex >= 0 && lastHashIndex < lines.length - 1) {
    throw helixError({
      code: "ledger_tail_unhashed",
      module: "infra/ledger.mjs",
      message: `ledger.jsonl has ${lines.length - 1 - lastHashIndex} unhashed line(s) after the hash chain started; refusing to append`,
      nextAction: "运行 node ./bin/helix.mjs ledger verify 确认篡改范围；恢复备份后再继续",
    });
  }
  return lastHash;
}

function hashLedgerEntry(entry) {
  const { hash, ...unsigned } = entry || {};
  return hashContent(JSON.stringify(unsigned));
}

// ledger 锁与任务状态锁共用 file-lock.mjs：stale 恢复（死 pid 立即、
// 不可解析按 mtime 宽限）与可诊断超时（错误带 owner/pid/存活状态）。
// 旧的二行 `pid\nts` 锁格式不可解析，崩溃残留会在宽限期后自动回收。
async function withLedgerLock(rootDir, fn) {
  const lockPath = resolveHelixPath(rootDir, "ledger.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  return withFileLock(rootDir, lockPath, "ledger lock", "ledger-append", fn, {
    waitTimeoutMs: LEDGER_LOCK_WAIT_TIMEOUT_MS,
    retryMs: LEDGER_LOCK_RETRY_MS,
  });
}
