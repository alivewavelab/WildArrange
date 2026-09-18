// =============================================================================
// 文件名称：ledger.mjs
// 所属模块：infra
// 作用说明：
//   ledger.jsonl 哈希链审计：append/verify/readVerified，tail 缓存 O(1) 追加。
//
// 【运行原理速读】
//   withLedgerLock → prevHash 链 → hashLedgerEntry → verifyLedger 全量走查权威。
// =============================================================================
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { wildarrangeError } from "./error-protocol.mjs";
import { withFileLock } from "./file-lock.mjs";
import { createWorkId, hashContent, nowIso, readJson, resolveWildArrangePath, writeJsonAtomic } from "./runtime-store.mjs";

/** ledger 锁重试间隔（毫秒）；略短于通用 file-lock 默认值。 */
const LEDGER_LOCK_RETRY_MS = 20;
/** ledger 锁等待上限（毫秒）；append 路径应快速失败以便诊断。 */
const LEDGER_LOCK_WAIT_TIMEOUT_MS = 10_000;
/** ledger-tail.json 缓存 schema 版本；尺寸不匹配时 fail-closed 回退全量扫描。 */
const LEDGER_TAIL_CACHE_VERSION = 1;

/**
 * appendLedger：本模块对外异步 API。
 */
export async function appendLedger(rootDir, event) {
  const ledgerPath = resolveWildArrangePath(rootDir, "ledger.jsonl");
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  return withLedgerLock(rootDir, () => appendLedgerLocked(rootDir, ledgerPath, event));
}

// 判重与追加必须在同一把 ledger 锁内完成；否则并发写方可能各自通过
// 判重后双双追加，留下重复审计事件。判重只认通过 hash 链校验的条目，
// 与 readVerifiedLedgerEntries 的证据口径一致。
/**
 * appendLedgerOnce：本模块对外异步 API。
 */
export async function appendLedgerOnce(rootDir, event, isDuplicate) {
  const ledgerPath = resolveWildArrangePath(rootDir, "ledger.jsonl");
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  return withLedgerLock(rootDir, async () => {
    const walk = await walkLedger(rootDir);
    if (walk.entries.some((item) => item.verified && isDuplicate(item.entry))) {
      return { entry: null, skipped: true };
    }
    return { entry: await appendLedgerLocked(rootDir, ledgerPath, event), skipped: false };
  });
}

/**
 * 在已持 ledger 锁下追加 hash 链条目。
 */
async function appendLedgerLocked(rootDir, ledgerPath, event) {
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
}

/**
 * verifyLedger：本模块对外异步 API。
 */
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
/**
 * readVerifiedLedgerEntries：本模块对外异步 API。
 */
export async function readVerifiedLedgerEntries(rootDir) {
  const walk = await walkLedger(rootDir);
  return walk.entries.filter((item) => item.verified).map((item) => item.entry);
}

/**
 * 逐行遍历 ledger 并解析 JSON。
 */
async function walkLedger(rootDir) {
  const ledgerPath = resolveWildArrangePath(rootDir, "ledger.jsonl");
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
  // 一旦出现坏行或校验失败，链的可信度即告破产：后续条目即使自洽
  // （伪造者可以用 prevHash:null 重启一条自洽链）也不得再标 verified。
  let chainBroken = false;
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
      chainBroken = true;
      continue;
    }
    if (!entry.hash) {
      // 兼容 hash 链启用前的历史条目；一旦链已开始，后续无 hash 行视为篡改
      if (chainStarted) {
        failures.push({ line: lineNumber, reason: "unhashed_entry_after_chain_start" });
        entries.push({ entry, line: lineNumber, verified: false });
        chainBroken = true;
        continue;
      }
      legacy += 1;
      previousHash = entry.prevHash || null;
      entries.push({ entry, line: lineNumber, verified: false });
      continue;
    }
    chainStarted = true;
    checked += 1;
    let verified = !chainBroken;
    if ((entry.prevHash || null) !== previousHash) {
      failures.push({ line: lineNumber, reason: "prev_hash_mismatch", expected: previousHash, actual: entry.prevHash || null });
      verified = false;
    }
    const expectedHash = hashLedgerEntry(entry);
    if (entry.hash !== expectedHash) {
      failures.push({ line: lineNumber, reason: "hash_mismatch", expected: expectedHash, actual: entry.hash });
      verified = false;
    }
    if (!verified) chainBroken = true;
    entries.push({ entry, line: lineNumber, verified });
    previousHash = entry.hash;
  }
  return { checked, legacy, failures, entries };
}

/**
 * readLedgerTailHash：本模块对外异步 API。
 */
export async function readLedgerTailHash(rootDir) {
  return readLedgerLastHash(resolveWildArrangePath(rootDir, "ledger.jsonl"));
}

/**
 * 返回 ledger 尾 hash 缓存文件路径。
 */
function tailCachePath(rootDir) {
  return resolveWildArrangePath(rootDir, "ledger-tail.json");
}

// 追加路径的尾 hash 解析：缓存命中（文件尺寸未变）时 O(1)；尺寸变大
// （正常追加后缓存未更新、或崩溃恢复）时回退到 fail-closed 全量扫描；
// 尺寸变小说明 ledger 被截断/重写，拒绝追加。
/**
 * 解析追加前应用的 tail hash（缓存或全量扫描）。
 */
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
      // §3.4 追加前 fail-closed：ledger 被截断/重写时拒绝续链，避免 prevHash 分叉
      throw wildarrangeError({
        code: "ledger_truncated",
        module: "infra/ledger.mjs",
        message: `ledger.jsonl shrank from ${cache.size} to ${size} bytes; the ledger may have been truncated or rewritten`,
        nextAction: "运行 node ./bin/wildarrange.mjs ledger verify 与 doctor；必要时用 state list/restore 恢复备份",
      });
    }
    if (size === cache.size) return { hash: cache.hash || null, size };
  }
  // 缓存 miss 或尺寸变大：回退全量尾行扫描（权威路径）
  return { hash: await readLedgerLastHash(ledgerPath), size };
}

// fail-closed 尾行扫描：尾部坏行不再静默返回 null（那会让下一次追加
// 以 prevHash=null 悄悄分叉链），而是拒绝追加并指向修复动作。
/**
 * 读取 ledger 最后一行的 hash 字段。
 */
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
      throw wildarrangeError({
        code: "ledger_tail_corrupt",
        module: "infra/ledger.mjs",
        message: `ledger.jsonl line ${index + 1} is not valid JSON; refusing to append onto a corrupted chain`,
        nextAction: "运行 node ./bin/wildarrange.mjs ledger verify 定位坏行；修复或用 state restore 恢复后再继续",
      });
    }
    if (entry.hash) {
      lastHash = entry.hash;
      lastHashIndex = index;
    }
  }
  if (lastHashIndex >= 0 && lastHashIndex < lines.length - 1) {
    throw wildarrangeError({
      code: "ledger_tail_unhashed",
      module: "infra/ledger.mjs",
      message: `ledger.jsonl has ${lines.length - 1 - lastHashIndex} unhashed line(s) after the hash chain started; refusing to append`,
      nextAction: "运行 node ./bin/wildarrange.mjs ledger verify 确认篡改范围；恢复备份后再继续",
    });
  }
  return lastHash;
}

/**
 * 计算单条 ledger 条目的链式 hash。
 */
function hashLedgerEntry(entry) {
  const { hash, ...unsigned } = entry || {};
  return hashContent(JSON.stringify(unsigned));
}

// ledger 锁与任务状态锁共用 file-lock.mjs：stale 恢复（死 pid 立即、
// 不可解析按 mtime 宽限）与可诊断超时（错误带 owner/pid/存活状态）。
// 旧的二行 `pid\nts` 锁格式不可解析，崩溃残留会在宽限期后自动回收。
/**
 * 在 ledger 文件锁内执行回调。
 */
async function withLedgerLock(rootDir, fn) {
  const lockPath = resolveWildArrangePath(rootDir, "ledger.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  return withFileLock(rootDir, lockPath, "ledger lock", "ledger-append", fn, {
    waitTimeoutMs: LEDGER_LOCK_WAIT_TIMEOUT_MS,
    retryMs: LEDGER_LOCK_RETRY_MS,
  });
}

