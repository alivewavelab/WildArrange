/**
 * helix timeline — 统一时间线投影。
 *
 * 把三个日志源合并成一条倒序时间线，回答"这个仓库最近发生了什么"：
 * - ledger（hash 链，只取通过校验的条目）：权威事件；
 * - decisions（派生）：每一次拦截/放行的决策；
 * - annotations（派生）：人/审查者对决策的标注。
 *
 * 只读派生投影，不二次写入任何状态。
 */
import { readVerifiedLedgerEntries } from "../infra/ledger.mjs";
import { readDecisions } from "../infra/decision-log.mjs";
import { readAnnotations } from "../infra/annotation-log.mjs";

const KNOWN_SOURCES = ["ledger", "decision", "annotation"];

function ledgerEntryToRow(entry) {
  const parts = [entry.type || "event"];
  if (entry.taskId) parts.push(`task=${entry.taskId}`);
  if (entry.runId) parts.push(`run=${entry.runId}`);
  if (entry.status) parts.push(`-> ${entry.status}`);
  return {
    ts: entry.at || null,
    source: "ledger",
    kind: entry.type || "event",
    summary: parts.join(" "),
    taskId: entry.taskId || null,
  };
}

function decisionToRow(record) {
  return {
    ts: record.ts || null,
    source: "decision",
    kind: record.gate || "unknown",
    summary: `${record.gate || "?"} ${String(record.decision || "?").toUpperCase()}${record.code ? ` [${record.code}]` : ""} ${record.summary || ""}`.trim(),
    taskId: record.taskId || null,
    ref: record.id || null,
  };
}

function annotationToRow(record) {
  return {
    ts: record.ts || null,
    source: "annotation",
    kind: record.category || "unknown",
    summary: `标注 ${record.category || "?"} -> ${record.decisionId || "?"}${record.reason ? `：${record.reason}` : ""}`,
    taskId: null,
    ref: record.decisionId || null,
  };
}

export async function projectTimeline(rootDir, { limit = 50, taskId, source, format } = {}) {
  const wantSources = source && KNOWN_SOURCES.includes(source) ? [source] : KNOWN_SOURCES;
  const rows = [];
  let ledgerChecked = 0;
  let decisionSkipped = 0;
  let annotationSkipped = 0;

  if (wantSources.includes("ledger")) {
    const entries = await readVerifiedLedgerEntries(rootDir);
    ledgerChecked = entries.length;
    for (const entry of entries) rows.push(ledgerEntryToRow(entry));
  }
  if (wantSources.includes("decision")) {
    const { records, skippedLines } = await readDecisions(rootDir, {});
    decisionSkipped = skippedLines;
    for (const record of records) rows.push(decisionToRow(record));
  }
  if (wantSources.includes("annotation")) {
    const { records, skippedLines } = await readAnnotations(rootDir);
    annotationSkipped = skippedLines;
    for (const record of records) rows.push(annotationToRow(record));
  }

  // --task 过滤时保留指向该任务决策的标注（annotation 自身不带 taskId，
  // 通过 ref -> decisionId 归属）。
  const taskDecisionIds = taskId
    ? new Set(rows.filter((row) => row.source === "decision" && row.taskId === taskId).map((row) => row.ref))
    : null;
  const filtered = rows.filter((row) => {
    if (!row.ts) return false;
    if (!taskId) return true;
    if (row.taskId === taskId) return true;
    return row.source === "annotation" && row.ref !== null && taskDecisionIds.has(row.ref);
  });
  // 倒序（最新在前）；ts 相同保持来源稳定序 ledger < decision < annotation。
  filtered.sort((a, b) => b.ts.localeCompare(a.ts) || KNOWN_SOURCES.indexOf(a.source) - KNOWN_SOURCES.indexOf(b.source));
  const limited = Number.isInteger(limit) && limit > 0 ? filtered.slice(0, limit) : filtered;
  const projection = {
    kind: "helix_timeline",
    total: filtered.length,
    shown: limited.length,
    sources: {
      ledger: wantSources.includes("ledger") ? ledgerChecked : null,
      decisionSkippedLines: decisionSkipped,
      annotationSkippedLines: annotationSkipped,
    },
    records: limited,
  };
  if (format === "json") return projection;
  return { ...projection, text: renderTimelineText(limited, projection) };
}

function renderTimelineText(records, projection) {
  const lines = [];
  lines.push(`时间线：共 ${projection.total} 条，显示 ${records.length} 条（ledger 已校验 ${projection.sources.ledger ?? 0} 条）`);
  if (projection.sources.decisionSkippedLines > 0 || projection.sources.annotationSkippedLines > 0) {
    lines.push(`警告：跳过坏行 decision=${projection.sources.decisionSkippedLines} annotation=${projection.sources.annotationSkippedLines}`);
  }
  if (records.length === 0) {
    lines.push("(无记录)");
    return lines.join("\n");
  }
  for (const row of records) {
    lines.push(`[${row.ts}] ${row.source.padEnd(10)} ${row.summary}`);
  }
  return lines.join("\n");
}
