import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, unlink } from "node:fs/promises";
import path from "node:path";

const HELIX_DIR = ".helix";
const LEDGER_LOCK_RETRY_MS = 20;
const LEDGER_LOCK_WAIT_TIMEOUT_MS = 10_000;

export async function appendLedger(rootDir, event) {
  const ledgerPath = resolveHelixPath(rootDir, "ledger.jsonl");
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  return withLedgerLock(rootDir, async () => {
    const previousHash = await readLedgerLastHash(ledgerPath);
    const entry = {
      id: createWorkId("evt"),
      at: nowIso(),
      prevHash: previousHash,
      ...event,
    };
    entry.hash = hashLedgerEntry(entry);
    await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
    return entry;
  });
}

export async function verifyLedger(rootDir) {
  const ledgerPath = resolveHelixPath(rootDir, "ledger.jsonl");
  let content = "";
  try {
    content = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { kind: "ledger_verification", ok: true, checked: 0, legacy: 0, failures: [] };
    }
    throw error;
  }
  const failures = [];
  let previousHash = null;
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
      legacy += 1;
      previousHash = entry.prevHash || null;
      continue;
    }
    checked += 1;
    if ((entry.prevHash || null) !== previousHash) {
      failures.push({ line: lineNumber, reason: "prev_hash_mismatch", expected: previousHash, actual: entry.prevHash || null });
    }
    const expectedHash = hashLedgerEntry(entry);
    if (entry.hash !== expectedHash) {
      failures.push({ line: lineNumber, reason: "hash_mismatch", expected: expectedHash, actual: entry.hash });
    }
    previousHash = entry.hash;
  }
  return { kind: "ledger_verification", ok: failures.length === 0, checked, legacy, failures };
}

async function readLedgerLastHash(ledgerPath) {
  try {
    const content = await readFile(ledgerPath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const entry = JSON.parse(lines[index]);
        if (entry.hash) return entry.hash;
      } catch {
        return null;
      }
    }
    return null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function hashLedgerEntry(entry) {
  const { hash, ...unsigned } = entry || {};
  return hashContent(JSON.stringify(unsigned));
}

function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

function createWorkId(prefix = "work") {
  return `${prefix}_${randomUUID()}`;
}

function nowIso() {
  return new Date().toISOString();
}

function resolveHelixPath(rootDir, ...segments) {
  return path.join(rootDir, HELIX_DIR, ...segments);
}

async function withLedgerLock(rootDir, fn) {
  const lockPath = resolveHelixPath(rootDir, "ledger.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > LEDGER_LOCK_WAIT_TIMEOUT_MS) {
      throw new Error(`timed out acquiring ledger lock: ${path.relative(rootDir, lockPath)}`);
    }
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}\n${Date.now()}\n`);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await delay(LEDGER_LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
