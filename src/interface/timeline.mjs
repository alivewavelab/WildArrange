// =============================================================================
// 文件名称：timeline.mjs
// 所属模块：interface
// 作用说明：
//   合并 ledger、decisions、annotations 为统一倒序时间线 CLI 投影。
//   只读派生视图，回答「仓库最近发生了什么」。
//
// 【运行原理速读】
//   可以把它想成「三类日志的合并时间轴」：
//
//   · 谁调用？
//     wildarrange timeline（--task / --source / --format json）。
//
//   · 它做了什么？
//     ① 分别读取三源 ② 可选按 taskId 过滤（标注经 decisionId 归属）
//     ③ 按 ts 倒序、同源稳定序后 limit 截断。
//
//   · 数据源权威级？
//     ledger 仅 hash 链校验通过的条目；decisions/annotations 跳过坏行并计数。
// =============================================================================
import { readVerifiedLedgerEntries } from "../infra/ledger.mjs";
import { readDecisions } from "../infra/decision-log.mjs";
import { readAnnotations } from "../infra/annotation-log.mjs";

/** timeline CLI --source 过滤允许的源名。 */
const KNOWN_SOURCES = ["ledger", "decision", "annotation"];

/** 将 ledger 条目投影为时间线行（source=ledger）。 */
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

/** 将 decision-log 记录投影为时间线行（source=decision）。 */
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

/** 将 annotation-log 记录投影为时间线行（source=annotation，taskId 经 ref 间接归属）。 */
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

/**
 * 构建统一时间线投影。
 * @param {string} rootDir
 * @param {{ limit?: number, taskId?: string, source?: string, format?: string }} [options]
 */
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
    kind: "wildarrange_timeline",
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

/** 将时间线投影渲染为 CLI 可读的多行文本。 */
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
