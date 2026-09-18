// =============================================================================
// 文件名称：suspicion-review.mjs
// 所属模块：ai
// 作用说明：
//   异步 LLM 审查门禁决策是否可疑；只消费脱敏后的决策包，不读代码/diff/命令输出。
//   结论仅写入 reports/suspicion.*，不进完成链、不改配置、不改动任何门开关。
//
// 【运行原理速读】
//   · 何时触发？ CLI 或后台任务显式调用 runSuspicionReview（非 Hook 主路径）。
//   · 做了什么？ ① 读取可标注决策与标注统计 ② 无 LLM 时输出确定性基线
//     ③ 有 LLM 时请求 JSON 可疑清单并校验 decisionId 防幻觉锚定。
//   · 与谁协作？ decision-log、annotation-log、llm-provider（CangJie/archivist Agent）。
//   · 缺了它会怎样？ 不影响任何 gate 放行/拦截，仅少一份人工复盘建议报告。
// =============================================================================

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { ensureWildArrangeDirs, nowIso, writeJsonAtomic, resolveWildArrangePath } from "../infra/runtime-store.mjs";
import { readDecisions } from "../infra/decision-log.mjs";
import { annotationStats } from "../infra/annotation-log.mjs";
import { callOpenAICompatible, resolveAgentProvider } from "../infra/llm-provider.mjs";

const PACKET_LIMIT = 50;

/** 脱敏决策记录供 LLM 审查包使用，截断 reason/summary 防 token 膨胀。 */
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

/** 无 LLM 时的确定性基线：统计 deny 规则分布与人工标注热点。 */
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

/** 从 LLM 回复中提取并解析 suspicious 清单 JSON。 */
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

/**
 * 运行可疑决策异步审查，写入 suspicion.json 与 suspicion.md  advisory 报告。
 * @param {string} rootDir 项目根目录
 * @param {object} options limit 决策包条数上限，默认 50
 * @returns {Promise<object>} 完整报告对象（含 deterministic 基线与 llm 状态）
 */
export async function runSuspicionReview(rootDir, { limit = PACKET_LIMIT } = {}) {
  await ensureWildArrangeDirs(rootDir);
  const { config } = await loadWildArrangeConfig(rootDir);
  const [{ records }, annotations] = await Promise.all([
    readDecisions(rootDir, {}),
    annotationStats(rootDir),
  ]);
  const annotatable = records.filter((record) => record.annotatable === true);
  const packet = annotatable.slice(-limit).map(sanitizeDecision);
  const baseline = buildDeterministicBaseline(records, annotations);

  const report = {
    kind: "wildarrange_suspicion_review",
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
            // 丢弃 LLM 幻觉引用的 decisionId，防止报告锚定到不存在的决策
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

  const jsonPath = resolveWildArrangePath(rootDir, "reports", "suspicion.json");
  const mdPath = resolveWildArrangePath(rootDir, "reports", "suspicion.md");
  report.reportJsonPath = path.relative(rootDir, jsonPath);
  report.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, report);
  await writeFile(mdPath, renderSuspicionMarkdown(report), "utf8");
  return report;
}

/** 将 suspicion 审查报告渲染为 Markdown advisory 文档。 */
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
