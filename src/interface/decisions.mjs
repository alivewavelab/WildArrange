/**
 * helix decisions — decisions.jsonl 的只读投影。
 *
 * 每条决策渲染三行：发生了什么 → 命中哪条规则 → 证据在哪。
 * 投影是纯派生：只读 decisions.jsonl，绝不二次写入任何状态。
 * 读侧是尾部流式：--limit 约束真实内存占用，大文件只扫描尾部窗口。
 */
import { readDecisions } from "../infra/decision-log.mjs";
import { annotationStats } from "../infra/annotation-log.mjs";

const KNOWN_GATES = [
  "verify",
  "scope",
  "review",
  "acceptance-proof",
  "checkpoint",
  "pipeline",
  "pre_tool_use",
  "post_tool_use",
  "admission",
  "routing",
];

export async function projectDecisions(rootDir, { limit = 50, taskId, gate, since, annotatable, format } = {}) {
  const hasFilter = Boolean(taskId || gate || since || annotatable);
  const filter = hasFilter
    ? (record) => (!taskId || record.taskId === taskId)
      && (!gate || record.gate === gate)
      && (!since || (typeof record.ts === "string" && record.ts >= since))
      && (!annotatable || record.annotatable === true)
    : undefined;
  const { records, skippedLines, total, truncated } = await readDecisions(rootDir, { limit, filter });
  const projection = {
    kind: "helix_decisions_projection",
    total,
    matched: records.length,
    shown: records.length,
    skippedLines,
    truncated,
    records,
  };
  if (format === "json") return projection;
  return { ...projection, text: renderDecisionsText(records, { skippedLines, total, truncated, gate }) };
}

function renderDecisionsText(records, { skippedLines, total, truncated, gate }) {
  const lines = [];
  lines.push(`决策记录：显示 ${records.length} 条（本次扫描 ${total} 条${truncated ? "，仅文件尾部窗口，更早记录未加载" : ""}）`);
  if (skippedLines > 0) {
    lines.push(`警告：跳过 ${skippedLines} 行无法解析的记录（decisions.jsonl 可能被截断或半写，不影响其余记录）`);
  }
  if (records.length === 0) {
    lines.push("(无决策记录)");
    if (gate) lines.push(`可用 gate：${KNOWN_GATES.join(" / ")}`);
    return lines.join("\n");
  }
  for (const record of records) {
    lines.push("");
    lines.push(renderRecordHeader(record));
    lines.push(`  发生了什么: ${record.summary || "(无摘要)"}`);
    lines.push(`  命中规则: ${renderRuleLine(record)}`);
    lines.push(`  证据: ${record.evidencePath || "(无证据路径)"}`);
  }
  return lines.join("\n");
}

function renderRecordHeader(record) {
  const parts = [`[${record.ts || "?"}]`, record.gate || "unknown", String(record.decision || "?").toUpperCase()];
  if (record.taskId) parts.push(`task=${record.taskId}`);
  if (record.runId) parts.push(`run=${record.runId}`);
  if (record.id) parts.push(`id=${record.id}`);
  if (record.annotatable === true) parts.push("可标注");
  return parts.join("  ");
}

function renderRuleLine(record) {
  const code = record.code ? `${record.code}` : null;
  const reason = record.reason || null;
  if (code && reason) return `${code} — ${reason}`;
  return code || reason || "(未记录)";
}

/**
 * 确定性统计审查（helix decisions stats）：纯代码、可重跑、可复核。
 * 回答三个问题：每个门触发过多少次（按决策/规则细分）、哪些门从未触发
 * （门形同虚设的直接信号）、哪些规则被标注过。LLM 判断不在这里——
 * 这里只出计数，冷启动期不出率。
 */
export async function projectDecisionStats(rootDir) {
  const { records, skippedLines, total } = await readDecisions(rootDir, {});
  const annotations = await annotationStats(rootDir);

  const gates = new Map();
  for (const record of records) {
    const gate = record.gate || "unknown";
    if (!gates.has(gate)) {
      gates.set(gate, { gate, total: 0, decisions: {}, codes: {}, annotatable: 0 });
    }
    const bucket = gates.get(gate);
    bucket.total += 1;
    const decision = String(record.decision || "unknown");
    bucket.decisions[decision] = (bucket.decisions[decision] || 0) + 1;
    if (record.code) bucket.codes[record.code] = (bucket.codes[record.code] || 0) + 1;
    if (record.annotatable === true) bucket.annotatable += 1;
  }
  const gateList = [...gates.values()].sort((a, b) => b.total - a.total);
  for (const gate of gateList) {
    // 按 gate 归属关联标注，兼容 annotationStats 的 gate:code 与 gate:decision 两种键。
    gate.annotatedRules = annotations.rules
      .filter((rule) => rule.gate === gate.gate)
      .map((rule) => ({ code: rule.code, total: rule.total, rule_wrong: rule.rule_wrong, case_wrong: rule.case_wrong, mislabeled: rule.mislabeled }));
  }
  const observed = new Set(gates.keys());
  return {
    kind: "helix_decision_stats",
    total,
    skippedLines,
    timeRange: {
      first: records[0]?.ts || null,
      last: records.at(-1)?.ts || null,
    },
    gates: gateList,
    neverFiredGates: KNOWN_GATES.filter((gate) => !observed.has(gate)),
    annotations: {
      total: annotations.total,
      rules: annotations.rules,
      unmatchedCount: annotations.unmatchedCount,
    },
  };
}
