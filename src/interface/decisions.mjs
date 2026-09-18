// =============================================================================
// 文件名称：decisions.mjs
// 所属模块：interface
// 作用说明：
//   decisions.jsonl 的只读 CLI 投影与统计（decisions / decisions stats）。
//   每条决策渲染「发生了什么 → 规则 → 证据」；绝不二次写入状态。
//
// 【运行原理速读】
//   可以把它想成「门禁决策的查阅窗口」：
//
//   · 谁调用？
//     wildarrange decisions、dashboard-panels 决策面板、doctor 决策健康分项。
//
//   · 它做了什么？
//     ① projectDecisions 尾部流式读取并过滤 ② 渲染 text 或 json
//     ③ projectDecisionStats 按 gate 聚合计数与 neverFiredGates。
//
//   · 和其他部分的关系？
//     数据源为 infra/decision-log；标注关联来自 annotation-log。
// =============================================================================
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

/**
 * 投影最近决策记录，支持 task/gate/since/annotatable 过滤。
 * @param {string} rootDir
 * @param {{ limit?: number, taskId?: string, gate?: string, since?: string, annotatable?: boolean, format?: string }} [options]
 */
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
    kind: "wildarrange_decisions_projection",
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

/** 将决策记录数组渲染为 CLI 可读的多行文本。 */
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

/** 格式化单条决策的标题行（时间、gate、decision、task/run/id 标记）。 */
function renderRecordHeader(record) {
  const parts = [`[${record.ts || "?"}]`, record.gate || "unknown", String(record.decision || "?").toUpperCase()];
  if (record.taskId) parts.push(`task=${record.taskId}`);
  if (record.runId) parts.push(`run=${record.runId}`);
  if (record.id) parts.push(`id=${record.id}`);
  if (record.annotatable === true) parts.push("可标注");
  return parts.join("  ");
}

/** 拼接决策的 code 与 reason 为「命中规则」一行。 */
function renderRuleLine(record) {
  const code = record.code ? `${record.code}` : null;
  const reason = record.reason || null;
  if (code && reason) return `${code} — ${reason}`;
  return code || reason || "(未记录)";
}

/**
 * 确定性统计审查（wildarrange decisions stats）：纯代码、可重跑、可复核。
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
      .map((rule) => ({ code: rule.code, total: rule.total, confirmed: rule.confirmed, rule_wrong: rule.rule_wrong, case_wrong: rule.case_wrong, mislabeled: rule.mislabeled }));
  }
  const observed = new Set(gates.keys());
  return {
    kind: "wildarrange_decision_stats",
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
