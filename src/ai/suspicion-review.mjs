/**
 * LLM 可疑判断（异步审查，archivist 不变量）：
 * - 只读清洗后的结论包（id/gate/code/reason/summary + 标注计数），
 *   绝不摄入代码块、raw diff 或完整命令输出；
 * - 无 LLM key / provider 不可用时确定性 fallback，不阻断任何主线；
 * - 结论只进 .helix/reports/suspicion.* 报告，不进完成链、不改配置、
 *   不动任何门开关；
 * - LLM 返回的 decisionId 必须在输入包内，否则丢弃并计数（防幻觉锚定）。
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadHelixConfig } from "../infra/runtime-config.mjs";
import { ensureHelixDirs, nowIso, writeJsonAtomic, resolveHelixPath } from "../infra/runtime-store.mjs";
import { readDecisions } from "../infra/decision-log.mjs";
import { annotationStats } from "../infra/annotation-log.mjs";
import { callOpenAICompatible, resolveAgentProvider } from "../infra/llm-provider.mjs";

const PACKET_LIMIT = 50;

function sanitizeDecision(record) {
  return {
    id: record.id || null,
    ts: record.ts || null,
    gate: record.gate || null,
    decision: record.decision || null,
    code: record.code || null,
    reason: typeof record.reason === "string" ? record.reason.slice(0, 300) : null,
    summary: typeof record.summary === "string" ? record.summary.slice(0, 300) : null,
    taskId: record.taskId || null,
  };
}

function buildDeterministicBaseline(decisions, annotations) {
  const denies = decisions.filter((record) => record.decision !== "allow" && record.decision !== "pass");
  const byRule = {};
  for (const record of denies) {
    const key = `${record.gate || "unknown"}:${record.code || record.decision || "unknown"}`;
    byRule[key] = (byRule[key] || 0) + 1;
  }
  return {
    denyTotal: denies.length,
    topDenyRules: Object.entries(byRule)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([rule, count]) => ({ rule, count })),
    topAnnotatedRules: annotations.rules.slice(0, 10),
  };
}

function parseSuspicionJson(content) {
  if (typeof content !== "string") return null;
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

export async function runSuspicionReview(rootDir, { limit = PACKET_LIMIT } = {}) {
  await ensureHelixDirs(rootDir);
  const { config } = await loadHelixConfig(rootDir);
  const [{ records }, annotations] = await Promise.all([
    readDecisions(rootDir, {}),
    annotationStats(rootDir),
  ]);
  const annotatable = records.filter((record) => record.annotatable === true);
  const packet = annotatable.slice(-limit).map(sanitizeDecision);
  const baseline = buildDeterministicBaseline(records, annotations);

  const report = {
    kind: "helix_suspicion_review",
    at: nowIso(),
    advisory: true,
    deterministic: baseline,
    packetSize: packet.length,
    llm: { status: "skipped", reason: "no annotatable decisions" },
    suspicious: [],
    droppedLlmIds: 0,
  };

  if (packet.length > 0) {
    const archivistAgent = config.archivistRouter?.agent || "CangJie";
    const resolved = resolveAgentProvider(config, archivistAgent);
    if (!resolved.available) {
      report.llm = { status: "skipped", reason: resolved.reason };
    } else {
      try {
        const response = await callOpenAICompatible({
          ...resolved,
          messages: [
            {
              role: "system",
              content: [
                "You are an asynchronous audit reviewer for a governance runtime.",
                "You receive sanitized gate-decision records (no code, no diffs, no command output).",
                "Flag decisions that look suspicious: a deny whose rule does not match its summary,",
                "an allow that relied on subjective judgment with weak reason, or patterns suggesting a misconfigured gate.",
                "Reply with JSON only: {\"suspicious\":[{\"decisionId\":\"...\",\"reason\":\"...\"}],\"notes\":\"...\"}.",
                "Only cite decisionId values present in the input. If nothing is suspicious, return an empty list.",
              ].join(" "),
            },
            {
              role: "user",
              content: JSON.stringify({ decisions: packet, annotationStats: baseline.topAnnotatedRules }),
            },
          ],
          temperature: 0,
          timeoutMs: 45_000,
        });
        const parsed = parseSuspicionJson(response.content);
        const validIds = new Set(packet.map((record) => record.id));
        const suspicious = [];
        let dropped = 0;
        for (const item of Array.isArray(parsed?.suspicious) ? parsed.suspicious : []) {
          if (item && validIds.has(item.decisionId)) {
            suspicious.push({ decisionId: item.decisionId, reason: String(item.reason || "").slice(0, 500) });
          } else {
            dropped += 1;
          }
        }
        report.llm = {
          status: "ok",
          provider: resolved.providerName,
          model: resolved.model,
          notes: typeof parsed?.notes === "string" ? parsed.notes.slice(0, 1000) : null,
        };
        report.suspicious = suspicious;
        report.droppedLlmIds = dropped;
      } catch (error) {
        report.llm = { status: "error", reason: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  const jsonPath = resolveHelixPath(rootDir, "reports", "suspicion.json");
  const mdPath = resolveHelixPath(rootDir, "reports", "suspicion.md");
  report.reportJsonPath = path.relative(rootDir, jsonPath);
  report.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, report);
  await writeFile(mdPath, renderSuspicionMarkdown(report), "utf8");
  return report;
}

function renderSuspicionMarkdown(report) {
  const lines = [
    "# Suspicion Review（异步审查，仅建议）",
    "",
    `- at: ${report.at}`,
    `- packet: ${report.packetSize} 条可标注决策`,
    `- llm: ${report.llm.status}${report.llm.reason ? ` (${report.llm.reason})` : ""}`,
    "",
    "## 确定性基线",
    "",
    `- 拦截总数: ${report.deterministic.denyTotal}`,
    ...report.deterministic.topDenyRules.map((rule) => `- ${rule.rule}: ${rule.count}`),
    "",
    "## LLM 可疑清单",
    "",
  ];
  if (report.suspicious.length === 0) {
    lines.push("(无)");
  } else {
    for (const item of report.suspicious) lines.push(`- ${item.decisionId}: ${item.reason}`);
  }
  if (report.droppedLlmIds > 0) lines.push(`\n> 丢弃 ${report.droppedLlmIds} 条不在输入包内的 decisionId（防幻觉锚定）`);
  if (report.llm.notes) lines.push(`\n> notes: ${report.llm.notes}`);
  lines.push("\n> 本报告仅为建议：不进完成链、不改配置、不动门开关。\n");
  return lines.join("\n");
}
