/**
 * decisions.jsonl — 统一决策记录。
 *
 * 只在四个缝发射：delivery-pipeline（五门）、ai/hooks（pre/post tool use）、
 * admission、routing。用途是给人类与异步审查 Agent 一个"每个拦截/通过
 * 为什么发生"的投影来源；它是可丢、可截断、可重建的派生日志：
 *
 * - 不进 hash 链（权威审计链仍是 ledger.jsonl）；
 * - 不持全局锁（appendFile 单行写入，POSIX O_APPEND 对短行原子）；
 * - 写失败绝不反噬主流程（emitDecision 吞错）；
 * - 半写/坏行由读侧跳过并计数（readDecisions）；
 * - 读侧从文件尾部按块倒读，--limit 约束真实内存占用，不把整文件读进堆。
 */
import { appendFile, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { createWorkId, nowIso, resolveHelixPath } from "./runtime-store.mjs";

const DECISION_FIELDS = [
  "gate",
  "decision",
  "code",
  "reason",
  "summary",
  "evidencePath",
  "taskId",
  "runId",
  "planId",
  "sessionId",
  "annotatable",
  "inputText",
  "routeResult",
  "toolName",
  "targetPaths",
  "toolInputSummary",
];

const READ_CHUNK_BYTES = 64 * 1024;
const ensuredDirs = new Set();

export function decisionsLogPath(rootDir) {
  return resolveHelixPath(rootDir, "decisions.jsonl");
}

export async function appendDecision(rootDir, record) {
  // id 是标注回写的锚点：人/审查 Agent 用 `helix annotate --decision <id>`
  // 指认某条决策。annotatable 标记该决策是否进标注队列（拦截与非确定性
  // 放行才进，确定性 PASS 只进流水）。
  const entry = { ts: nowIso(), id: record?.id || createWorkId("dec") };
  for (const field of DECISION_FIELDS) {
    if (record?.[field] !== undefined && record?.[field] !== null) entry[field] = record[field];
  }
  const filePath = decisionsLogPath(rootDir);
  const dir = path.dirname(filePath);
  if (!ensuredDirs.has(dir)) {
    await mkdir(dir, { recursive: true });
    ensuredDirs.add(dir);
  }
  // 外部截断若停在半行（truncate -s 100 之类），直接 append 会把新记录
  // 拼到残行上变成必然坏行；非空且末字节非换行时先补一个换行。
  let prefix = "";
  let handle = null;
  try {
    handle = await open(filePath, "r");
    const { size } = await handle.stat();
    if (size > 0) {
      const tail = Buffer.alloc(1);
      await handle.read(tail, 0, 1, size - 1);
      if (tail[0] !== 0x0a) prefix = "\n";
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  await appendFile(filePath, `${prefix}${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

/**
 * Best-effort 发射：决策日志是派生物，任何写入故障（权限、磁盘、并发）
 * 都不得让 gate / hook / admission / routing 主流程失败。
 */
export async function emitDecision(rootDir, record) {
  try {
    return await appendDecision(rootDir, record);
  } catch {
    return null;
  }
}

function parseDecisionLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return { kind: "empty" };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { kind: "record", record: parsed };
    }
    return { kind: "bad" };
  } catch {
    return { kind: "bad" };
  }
}

/**
 * 读取决策日志，从文件尾部按块倒读：拿到 limit 条匹配记录即停，
 * 内存占用与 limit 成正比而不是与文件大小成正比。坏行（半写、截断、
 * 手改）跳过并计数，绝不抛错——这个文件允许被外部截断清理。
 *
 * 返回 { records, skippedLines, total, truncated }：
 * - records 按时间升序（文件顺序）；
 * - total 是本次扫描到的有效记录数（不是全文件总数，除非 truncated=false）；
 * - truncated=true 表示只扫描了文件尾部，更早的记录未加载。
 */
export async function readDecisions(rootDir, { limit, filter } = {}) {
  const filePath = decisionsLogPath(rootDir);
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return { records: [], skippedLines: 0, total: 0, truncated: false };
    throw error;
  }
  try {
    if (limit === 0) return { records: [], skippedLines: 0, total: 0, truncated: false };
    const { size } = await handle.stat();
    const matches = typeof filter === "function" ? filter : () => true;
    const collected = []; // 新→旧
    let skippedLines = 0;
    let scanned = 0;
    let position = size;
    let carry = "";
    let done = false;

    const consume = (line) => {
      const parsed = parseDecisionLine(line);
      if (parsed.kind === "bad") {
        skippedLines += 1;
        return;
      }
      if (parsed.kind === "empty") return;
      scanned += 1;
      if (matches(parsed.record)) {
        collected.push(parsed.record);
        if (Number.isInteger(limit) && limit > 0 && collected.length >= limit) done = true;
      }
    };

    while (position > 0 && !done) {
      const chunkSize = Math.min(READ_CHUNK_BYTES, position);
      position -= chunkSize;
      const buffer = Buffer.alloc(chunkSize);
      await handle.read(buffer, 0, chunkSize, position);
      const text = buffer.toString("utf8") + carry;
      const lines = text.split("\n");
      // 未到文件起点时，首行可能被块边界截断，留给下一轮拼上 carry。
      carry = position > 0 ? lines.shift() : "";
      for (let index = lines.length - 1; index >= 0 && !done; index -= 1) {
        consume(lines[index]);
      }
    }
    collected.reverse();
    return { records: collected, skippedLines, total: scanned, truncated: position > 0 };
  } finally {
    await handle.close();
  }
}
