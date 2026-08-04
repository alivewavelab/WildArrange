/**
 * annotations.jsonl — 决策标注回写。
 *
 * 人/审查 Agent 用 `helix annotate` 指认某条决策记录（decision id）判错了。
 * 硬约束（由 test/annotation.test.mjs 钉死）：
 *
 * - 标注只写 annotations.jsonl，绝不写 config / verify_commands / 任何门开关——
 *   标注永远不能自动改门，调门只能由人显式改配置；
 * - 标注强制分类（rule_wrong 规则错 / case_wrong 个案错 / mislabeled 误标），
 *   理由可选；
 * - 统计以「规则 × 标注」为单位，单条标注不绑架整条规则；
 * - 与 decisions.jsonl 一样是派生日志：可丢、可截断、坏行跳过。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createWorkId, nowIso, resolveHelixPath } from "./runtime-store.mjs";
import { readDecisions } from "./decision-log.mjs";

export const ANNOTATION_CATEGORIES = ["rule_wrong", "case_wrong", "mislabeled"];

export function annotationsLogPath(rootDir) {
  return resolveHelixPath(rootDir, "annotations.jsonl");
}

export async function appendAnnotation(rootDir, { decisionId, category, reason, author } = {}) {
  if (!decisionId || typeof decisionId !== "string") {
    throw new Error("annotate requires --decision <decisionId>");
  }
  if (!ANNOTATION_CATEGORIES.includes(category)) {
    throw new Error(`annotate requires --category <${ANNOTATION_CATEGORIES.join("|")}>（规则错/个案错/误标，强制分类）`);
  }
  // 决策 id 必须真实存在于 decisions.jsonl——防止手滑的标注污染统计。
  // decisions.jsonl 被外部清空时无法校验，放行（证据已随截断消失）。
  const { records } = await readDecisions(rootDir, {});
  if (records.length > 0 && !records.some((record) => record.id === decisionId)) {
    throw new Error(`unknown decision id: ${decisionId}（用 helix decisions 查看可标注的决策 id）`);
  }
  const entry = {
    ts: nowIso(),
    id: createWorkId("ann"),
    decisionId,
    category,
    reason: reason || null,
    author: author || null,
  };
  const filePath = annotationsLogPath(rootDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export async function readAnnotations(rootDir) {
  let raw = "";
  try {
    raw = await readFile(annotationsLogPath(rootDir), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { records: [], skippedLines: 0 };
    throw error;
  }
  const records = [];
  let skippedLines = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) records.push(parsed);
      else skippedLines += 1;
    } catch {
      skippedLines += 1;
    }
  }
  return { records, skippedLines };
}

/**
 * 统计以「规则 × 标注」为单位：key 是决策的 gate + code（命中哪条规则），
 * value 是三类标注的计数。单条标注只是计数 +1，不绑架整条规则。
 * 决策日志已被截断的标注进 unmatched，不丢。
 */
export async function annotationStats(rootDir) {
  const [annotations, decisions] = await Promise.all([readAnnotations(rootDir), readDecisions(rootDir, {})]);
  const decisionById = new Map(decisions.records.map((record) => [record.id, record]));
  const byRule = {};
  const unmatched = [];
  for (const annotation of annotations.records) {
    const decision = decisionById.get(annotation.decisionId);
    if (!decision) {
      unmatched.push(annotation);
      continue;
    }
    const ruleKey = `${decision.gate || "unknown"}:${decision.code || decision.decision || "unknown"}`;
    byRule[ruleKey] ||= { rule: ruleKey, gate: decision.gate || null, code: decision.code || null, total: 0, rule_wrong: 0, case_wrong: 0, mislabeled: 0 };
    byRule[ruleKey].total += 1;
    byRule[ruleKey][annotation.category] = (byRule[ruleKey][annotation.category] || 0) + 1;
  }
  return {
    kind: "helix_annotation_stats",
    total: annotations.records.length,
    skippedLines: annotations.skippedLines,
    rules: Object.values(byRule).sort((a, b) => b.total - a.total),
    unmatchedCount: unmatched.length,
    unmatched,
  };
}
