/**
 * AI-side routing: the full routeRequest flow (deterministic table match plus
 * optional semantic shadow via an LLM) and semantic route governance. The
 * deterministic table itself lives in src/infra/route-table.mjs so
 * orchestration can read it without depending on this zone.
 */
import { DEFAULT_LEAD_AGENT } from "../infra/agent-registry.mjs";
import { writeFile } from "node:fs/promises";
import { appendLedger } from "../infra/ledger.mjs";
import { emitDecision, readDecisions } from "../infra/decision-log.mjs";
import { readAnnotations } from "../infra/annotation-log.mjs";
import { initRuntime } from "../infra/runtime-bootstrap.mjs";
import { loadHelixConfig } from "../infra/runtime-config.mjs";
import { nowIso, resolveHelixPath, writeJsonAtomic } from "../infra/runtime-store.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { loadRoutesConfig, resolveRouteDecision, uniqueStrings } from "../infra/route-table.mjs";
import { callOpenAICompatible, resolveAgentProvider } from "../infra/llm-provider.mjs";

export { loadRoutesConfig, resolveRouteDecision } from "../infra/route-table.mjs";

export async function routeRequest(rootDir, input) {
  await initRuntime(rootDir);
  const text = typeof input === "string" ? input : input?.text;
  if (!text || typeof text !== "string") {
    throw new Error("route text is required");
  }

  const routes = await loadRoutesConfig(rootDir);
  const deterministic = resolveRouteDecision(routes, text);
  const result = await applySemanticRouteGovernance(rootDir, text, deterministic, input || {});
  await appendLedger(rootDir, {
    type: "route_decided",
    route: result.route,
    intent: result.intent,
    domain: result.domain,
    category: result.category,
    confidence: result.confidence,
    semanticStatus: result.semanticShadow?.status || null,
    routeAdjusted: result.routeAdjusted || false,
  });
  await writeSnapshot(rootDir, "route_decided", { route: result });
  // 决策投影：路由是四个决策缝之一。best-effort，不反噬路由主流程。
  await emitDecision(rootDir, {
    gate: "routing",
    decision: result.route,
    code: result.category || null,
    reason: `intent=${result.intent} domain=${result.domain} confidence=${result.confidence}`
      + ` semantic=${result.semanticShadow?.status || "off"} adjusted=${result.routeAdjusted === true}`,
    summary: text.length > 120 ? `${text.slice(0, 120)}…` : text,
    inputText: text,
    sessionId: input?.sessionId || input?.session_id || null,
    routeResult: {
      intent: result.intent,
      route: result.route,
      domain: result.domain,
      complexity: result.complexity,
      category: result.category,
      primaryAgent: result.primaryAgent,
      supportAgents: result.supportAgents,
      skills: result.skills,
      risk: result.risk,
      confidence: result.confidence,
      matchedSignals: result.matchedSignals,
      needsPlan: result.needsPlan,
      needsUserInput: result.needsUserInput,
      reason: result.reason,
      routeAdjusted: result.routeAdjusted === true,
      adjustmentReason: result.adjustmentReason || null,
      semanticShadow: result.semanticShadow || null,
    },
    // 纯确定性路由（shadow skipped）只进流水；shadow 真正给出第二意见
    // （含 warn 降级）或调整了路由的，属于非确定性放行，进标注队列。
    annotatable: result.routeAdjusted === true
      || (result.semanticShadow?.status !== undefined && result.semanticShadow?.status !== "skipped"),
  });
  return result;
}

export async function writeDailyRoutingReview(rootDir, options = {}) {
  await initRuntime(rootDir);
  const { config } = await loadHelixConfig(rootDir);
  const reviewConfig = config.routeGovernance?.dailyReview || {};
  const date = options.date || localDate(new Date());
  if (reviewConfig.enabled === false) {
    return { status: "skipped", date, reason: "routeGovernance.dailyReview.enabled is false" };
  }

  const [{ records, skippedLines }, annotations] = await Promise.all([
    readDecisions(rootDir, {}),
    readAnnotations(rootDir),
  ]);
  const latestAnnotation = new Map();
  for (const annotation of annotations.records) latestAnnotation.set(annotation.decisionId, annotation);

  const routes = [];
  const activeRouteBySession = new Map();
  for (const record of records) {
    if (!record.ts || localDateFromTimestamp(record.ts) !== date) continue;
    if (record.gate === "routing") {
      const result = record.routeResult || {};
      const item = {
        id: record.id,
        ts: record.ts,
        sessionId: record.sessionId || null,
        inputText: record.inputText || record.summary || "",
        route: result.route || record.decision || null,
        intent: result.intent || null,
        domain: result.domain || null,
        primaryAgent: result.primaryAgent || null,
        confidence: result.confidence ?? null,
        matchedSignals: result.matchedSignals || [],
        semanticStatus: result.semanticShadow?.status || null,
        routeAdjusted: result.routeAdjusted === true,
        review: latestAnnotation.get(record.id) || null,
        tools: [],
      };
      routes.push(item);
      if (item.sessionId) activeRouteBySession.set(item.sessionId, item);
      continue;
    }
    if (record.gate === "post_tool_use" && record.sessionId) {
      const active = activeRouteBySession.get(record.sessionId);
      if (active) {
        active.tools.push({
          ts: record.ts,
          toolName: record.toolName || "unknown",
          decision: record.decision || null,
          reason: record.reason || null,
          targetPaths: record.targetPaths || [],
          input: record.toolInputSummary || null,
        });
      }
    }
  }

  const confirmed = routes.filter((item) => item.review?.category === "confirmed");
  const issues = routes.filter((item) => ["rule_wrong", "case_wrong"].includes(item.review?.category));
  const unreviewed = routes.filter((item) => !item.review);
  const routeDistribution = Object.entries(routes.reduce((counts, item) => {
    const key = item.route || "unknown";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {})).map(([route, count]) => ({ route, count })).sort((left, right) => right.count - left.count);
  const patterns = routingIssuePatterns(issues);
  const maxItems = Math.max(5, Math.min(Number(reviewConfig.maxItems) || 20, 100));
  const report = {
    kind: "helix_daily_routing_review",
    status: "generated",
    date,
    generatedAt: nowIso(),
    trigger: options.trigger || "manual",
    sessionId: options.sessionId || null,
    summary: {
      total: routes.length,
      reviewed: routes.length - unreviewed.length,
      confirmed: confirmed.length,
      issues: issues.length,
      unreviewed: unreviewed.length,
      toolCalls: routes.reduce((total, item) => total + item.tools.length, 0),
    },
    routeDistribution,
    decisions: routes,
    issues,
    unreviewed: unreviewed.slice(0, maxItems),
    unreviewedOverflow: Math.max(0, unreviewed.length - maxItems),
    patterns,
    skippedDecisionLines: skippedLines,
    skippedAnnotationLines: annotations.skippedLines,
  };
  const jsonPath = resolveHelixPath(rootDir, "reports", "routing", `${date}.json`);
  const mdPath = resolveHelixPath(rootDir, "reports", "routing", `${date}.md`);
  const latestJsonPath = resolveHelixPath(rootDir, "reports", "routing", "latest.json");
  const latestMdPath = resolveHelixPath(rootDir, "reports", "routing", "latest.md");
  await writeJsonAtomic(jsonPath, report);
  await writeFile(mdPath, renderDailyRoutingReview(report), "utf8");
  await writeJsonAtomic(latestJsonPath, report);
  await writeFile(latestMdPath, renderDailyRoutingReview(report), "utf8");
  return {
    ...report,
    reportJsonPath: `.helix/reports/routing/${date}.json`,
    reportMdPath: `.helix/reports/routing/${date}.md`,
    latestMdPath: ".helix/reports/routing/latest.md",
  };
}

function routingIssuePatterns(issues) {
  const groups = new Map();
  for (const issue of issues) {
    const signals = issue.matchedSignals.length > 0 ? issue.matchedSignals : ["无明确信号"];
    for (const signal of signals) {
      const key = `${issue.route || "unknown"}:${signal}`;
      const current = groups.get(key) || { route: issue.route || "unknown", signal, count: 0, decisionIds: [] };
      current.count += 1;
      current.decisionIds.push(issue.id);
      groups.set(key, current);
    }
  }
  return [...groups.values()].sort((left, right) => right.count - left.count);
}

function renderDailyRoutingReview(report) {
  const lines = [
    `# Helix 路由每日复盘｜${report.date}`,
    "",
    "> 由 IDE Stop Hook 自动生成。它只整理证据和提示改进点，不会自动修改 routes.json。",
    "",
    "## 一眼结论",
    "",
    `- 今日判断：${report.summary.total} 次`,
    `- 已人工复盘：${report.summary.reviewed} 次`,
    `- 确认正确：${report.summary.confirmed} 次`,
    `- 已发现问题：${report.summary.issues} 次`,
    `- 等待人工复盘：${report.summary.unreviewed} 次`,
    `- 已关联工具调用：${report.summary.toolCalls} 次`,
    "",
  ];
  if (report.summary.issues > 0) {
    lines.push(`**今天有 ${report.summary.issues} 条已确认问题，优先检查下面的“问题判断”。**`, "");
  } else if (report.summary.unreviewed > 0) {
    lines.push(`**暂未确认误判，但还有 ${report.summary.unreviewed} 条等待人工复盘。**`, "");
  } else {
    lines.push("**今天的路由记录均已复盘，未发现问题。**", "");
  }

  lines.push("## 问题判断", "");
  if (report.issues.length === 0) lines.push("- 暂无已确认问题。", "");
  for (const [index, item] of report.issues.entries()) {
    lines.push(`### ${index + 1}. ${reviewLabel(item.review?.category)}｜${compactText(item.inputText)}`, "");
    lines.push(`- 实际判断：${item.route || "unknown"} → ${item.primaryAgent || "unknown"}`);
    lines.push(`- 命中信号：${item.matchedSignals.join("、") || "无"}`);
    lines.push(`- 人工说明：${item.review?.reason || "未填写"}`);
    lines.push(`- 决策 ID：${item.id}`, "");
  }

  lines.push("## 等待人工复盘", "");
  if (report.unreviewed.length === 0) lines.push("- 没有待复盘项。", "");
  for (const item of report.unreviewed) {
    lines.push(`- [ ] ${compactText(item.inputText)} → **${item.route || "unknown"}**（${item.id}）`);
  }
  if (report.unreviewed.length > 0) lines.push("");
  if (report.unreviewedOverflow > 0) {
    lines.push(`- 另有 ${report.unreviewedOverflow} 条待复盘项，请在 Dashboard 按日期查看。`, "");
  }

  lines.push("## 重复误判与改进观察", "");
  if (report.patterns.length === 0) {
    lines.push("- 暂无已确认的重复误判。", "");
  } else {
    for (const pattern of report.patterns) {
      const action = pattern.count >= 2 ? "建议人工审查对应 routes.json 信号" : "先观察，不建议因单个案例修改通用规则";
      lines.push(`- 路线 **${pattern.route}** + 信号 **${pattern.signal}**：${pattern.count} 次问题；${action}。`);
    }
    lines.push("");
  }

  lines.push("## 路由分布", "");
  if (report.routeDistribution.length === 0) lines.push("- 今日无路由记录。");
  for (const item of report.routeDistribution) lines.push(`- ${item.route}：${item.count} 次`);

  lines.push("", "## 全部判断明细", "");
  if (report.decisions.length === 0) lines.push("- 今日无路由判断。", "");
  for (const [index, item] of report.decisions.entries()) {
    lines.push(`### ${index + 1}. ${compactText(item.inputText)}`, "");
    lines.push(`- 时间：${item.ts}`);
    lines.push(`- 路由结果：${item.route || "unknown"} → ${item.primaryAgent || "unknown"}`);
    lines.push(`- 意图 / 领域：${item.intent || "unknown"} / ${item.domain || "unknown"}`);
    lines.push(`- 置信度：${item.confidence ?? "未记录"}`);
    lines.push(`- 命中信号：${item.matchedSignals.join("、") || "无"}`);
    lines.push(`- 语义第二意见：${item.semanticStatus || "未启用"}`);
    lines.push(`- 人工复盘：${item.review ? reviewLabel(item.review.category) : "待复盘"}${item.review?.reason ? `；${item.review.reason}` : ""}`);
    lines.push(`- 决策 ID：${item.id}`);
    if (item.tools.length === 0) {
      lines.push("- 后续工具：无关联记录");
    } else {
      lines.push("- 后续工具：");
      for (const tool of item.tools) {
        const targets = tool.targetPaths.length > 0 ? `；目标 ${tool.targetPaths.join("、")}` : "";
        const input = compactToolInput(tool.input);
        lines.push(`  - ${tool.toolName} → ${tool.decision || "unknown"}${targets}${input ? `；参数 ${input}` : ""}`);
      }
    }
    lines.push("");
  }
  lines.push("", `生成时间：${report.generatedAt}`, "");
  return lines.join("\n");
}

function reviewLabel(category) {
  if (category === "confirmed") return "确认正确";
  if (category === "rule_wrong") return "规则错误";
  if (category === "case_wrong") return "个案错误";
  return "待确认";
}

function compactText(value) {
  const text = String(value || "(无原文)").replace(/\s+/g, " ").trim();
  return text.length > 160 ? `${text.slice(0, 160)}…` : text;
}

function compactToolInput(value) {
  if (!value) return "";
  const text = JSON.stringify(value).replace(/\s+/g, " ");
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function localDate(value) {
  return new Intl.DateTimeFormat("en-CA").format(value);
}

function localDateFromTimestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return localDate(parsed);
}

export async function semanticRouteShadow(rootDir, text, deterministicRoute, options = {}) {
  const { config } = options.config ? { config: options.config } : await loadHelixConfig(rootDir);
  const shadowConfig = config.routeGovernance?.semanticShadow || {};
  if (shadowConfig.enabled !== true) {
    return { status: "skipped", reason: "routeGovernance.semanticShadow.enabled is not true" };
  }
  const agentName = shadowConfig.agent || "CangJie";
  const resolved = resolveAgentProvider(config, agentName);
  if (!resolved.available) {
    return { status: "skipped", reason: resolved.reason, hostManaged: resolved.hostManaged === true };
  }

  try {
    const response = await callOpenAICompatible({
      ...resolved,
      messages: [
        {
          role: "system",
          content: "You are a strict task router. Return only compact JSON.",
        },
        {
          role: "user",
          content: JSON.stringify({
            instruction: "Classify the user request. Return JSON: {\"intent\":\"resume|change_request|review|debug|plan|investigate|release_git|execute|answer|ask\",\"route\":\"recover|change_request|verify|execute|plan|explore|answer|ask\",\"domain\":\"visual|logic|writing|git|debug|research|review|recovery|default\",\"category\":\"quick|deep|ultrabrain|visual-engineering|research|writing|git|null\",\"confidence\":0.0-1.0,\"reason\":\"...\"}. Prefer plan/ask over execute when ambiguous.",
            text,
            deterministicRoute,
          }),
        },
      ],
      temperature: 0,
      timeoutMs: Number(shadowConfig.timeoutMs) || 30_000,
    });
    return normalizeSemanticRoute(parseSemanticJson(response.content), response.usage);
  } catch (error) {
    return { status: "warn", reason: error instanceof Error ? error.message : String(error) };
  }
}

async function applySemanticRouteGovernance(rootDir, text, deterministic, input) {
  const { config } = await loadHelixConfig(rootDir);
  const shadowConfig = config.routeGovernance?.semanticShadow || {};
  const semantic = await semanticRouteShadow(rootDir, text, deterministic, { config });
  const result = { ...deterministic, semanticShadow: semantic };
  const threshold = Number(shadowConfig.lowConfidenceThreshold ?? 0.5);
  const semanticConfidence = Number.isFinite(Number(semantic.confidence)) ? Number(semantic.confidence) : null;
  const effectiveConfidence = Math.min(
    deterministic.confidence ?? 0.5,
    semanticConfidence ?? deterministic.confidence ?? 0.5,
  );
  result.confidence = effectiveConfidence;

  const semanticRoute = semantic.status === "pass" ? semantic.route : null;
  const semanticConflict = semanticRoute && semanticRoute !== deterministic.route;
  result.semanticConflict = Boolean(semanticConflict);
  if (semantic.status === "pass") {
    result.semanticDecision = {
      intent: semantic.intent,
      route: semantic.route,
      domain: semantic.domain,
      category: semantic.category,
      confidence: semantic.confidence,
      reason: semantic.reason,
    };
  }

  if (
    input?.allowLowConfidenceExecute !== true
    && shadowConfig.enforceLowConfidence !== false
    && deterministic.route === "execute"
    && (effectiveConfidence < threshold || semanticConflict)
  ) {
    const route = semanticRoute === "ask" ? "ask" : shadowConfig.conflictRoute || "plan";
    return {
      ...result,
      route,
      intent: route === "ask" ? "ask" : "plan",
      primaryAgent: route === "ask" ? DEFAULT_LEAD_AGENT : "DiJiang",
      supportAgents: uniqueStrings(["BaiZe", ...(result.supportAgents || [])]),
      needsPlan: route !== "ask",
      needsUserInput: route === "ask",
      routeAdjusted: true,
      adjustmentReason: effectiveConfidence < threshold
        ? `low route confidence ${effectiveConfidence} < ${threshold}`
        : `semantic route conflict: deterministic=${deterministic.route}, semantic=${semanticRoute}`,
    };
  }
  return result;
}

function normalizeSemanticRoute(raw, usage) {
  const confidence = Number(raw.confidence);
  return {
    status: "pass",
    intent: typeof raw.intent === "string" ? raw.intent : null,
    route: typeof raw.route === "string" ? raw.route : null,
    domain: typeof raw.domain === "string" ? raw.domain : null,
    category: raw.category === "null" ? null : typeof raw.category === "string" ? raw.category : null,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    usage: usage || null,
  };
}

function parseSemanticJson(content) {
  try {
    return JSON.parse(content);
  } catch {
    const match = String(content || "").match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}
