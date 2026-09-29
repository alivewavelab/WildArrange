// =============================================================================
// 文件名称：routing.mjs
// 所属模块：ai
// 作用说明：
//   用户请求路由：确定性路由表匹配 + 低置信 execute 降级 + 功能设计门。
//   确定性路由表本体在 infra/route-table.mjs，本文件负责 AI 侧完整 routeRequest 流程。
//
// 【运行原理速读】
//   · 何时触发？ UserPromptSubmit Hook、CLI route 命令。
//   · 做了什么？ ① resolveRouteDecision ② 低置信 execute 降级为 plan
//     ③ enforceFeatureDesignGate ④ emitDecision。
//   · 与谁协作？ route-table、feature-design、decision-log。
// =============================================================================

import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import { emitDecision } from "../infra/decision-log.mjs";
import { initRuntime } from "../infra/runtime-bootstrap.mjs";
import { writeSnapshot } from "../infra/runtime-snapshot.mjs";
import { loadActiveFeatureDesignGate } from "../orchestration/feature-design.mjs";
import { loadRoutesConfig, resolveRouteDecision, uniqueStrings } from "../infra/route-table.mjs";

/** 低于该置信度的 execute 路由降级为 plan，避免模糊请求直接动手。 */
const LOW_CONFIDENCE_THRESHOLD = 0.5;

// --- 计划草稿指令 ---

/**
 * 当路由判定需要 Plan 时，生成宿主侧写 plan-draft JSON 的指令块；草稿-only 时不给 plan --from。
 * @param {object|null} routeResult routeRequest 返回值
 * @param {object} options sessionId、prompt、controlRoot、executionRoot
 * @returns {object|null} planDraft 指令或 null
 */
export function buildPlanDraftDirective(routeResult, options = {}) {
  if (!routeResult || (routeResult.route !== "plan" && routeResult.needsPlan !== true)) return null;
  if (routeResult.featureDesign?.status === "awaiting_feature_confirmation") return null;
  const sessionId = sanitizeDraftSegment(options.sessionId || "session");
  const prompt = typeof options.prompt === "string" ? options.prompt.trim().slice(0, 4000) : "";
  const draftOnly = isDraftOnlyPlanRequest(prompt);
  const controlRoot = typeof options.controlRoot === "string" ? path.resolve(options.controlRoot) : null;
  const executionRoot = typeof options.executionRoot === "string" ? path.resolve(options.executionRoot) : controlRoot;
  const crossRoot = Boolean(controlRoot && executionRoot && controlRoot !== executionRoot);
  const draftPath = crossRoot
    ? path.join(controlRoot, ".wildarrange", "plan-drafts", `${sessionId}-plan.json`)
    : `.wildarrange/plan-drafts/${sessionId}-plan.json`;
  return {
    status: "host_generation_required",
    generatedBy: "host_semantic",
    draftPath,
    request: prompt,
    approvalRequired: true,
    draftOnly,
    ownerPolicy: "every executable task must declare task.owner as Jiuwei or ZhuRong",
    featureDesignRef: routeResult.featureDesign?.status === "awaiting_plan_import"
      ? routeResult.featureDesign.id
      : null,
    nextCommand: draftOnly ? null : crossRoot
      ? `node ./bin/wildarrange.mjs plan --from "${draftPath}" --control-root "${controlRoot}"`
      : "node ./bin/wildarrange.mjs plan --from <draftPath>",
  };
}

/** 检测用户是否明确要求只写计划草稿、不执行 plan --from 导入。 */
function isDraftOnlyPlanRequest(prompt) {
  return /(?:只|仅)(?:生成|创建|写|要).{0,12}(?:计划)?草稿(?=$|[\s，。！？；、,:：.!?;])|(?:先|暂时)?不(?:要|用|必)?(?:导入|登记)(?:(?:这|该|这个|本)?(?:份)?(?:正式)?(?:计划|草稿)(?=$|[\s，。！？；、,:：.!?;])|(?=\s*(?:$|[，。！？；,;])))|不要执行\s*plan\s+--from\b|\bdraft[ -]?only\b|\b(?:do not|don't) import(?:(?:\s+(?:the|this))?\s+(?:plan|draft)\b|(?=\s*(?:$|[,.!?;])))|\b(?:do not|don't) run\s+(?:the\s+)?plan\s+--from\b/i.test(prompt);
}

// --- 路由主流程 ---

/**
 * 对用户文本做完整路由决策（确定性 + 低置信降级 + 功能设计门），写 ledger 与 decisions。
 * @param {string} rootDir 项目根目录
 * @param {string|object} input 纯文本或 { text, sessionId }
 * @returns {Promise<object>} 路由结果（intent、route、primaryAgent、skills 等）
 */
export async function routeRequest(rootDir, input) {
  await initRuntime(rootDir);
  const text = typeof input === "string" ? input : input?.text;
  if (!text || typeof text !== "string") {
    throw new Error("route text is required");
  }

  const routes = await loadRoutesConfig(rootDir);
  const deterministic = resolveRouteDecision(routes, text);
  let result = applyLowConfidenceGate(deterministic);
  const sessionId = typeof input === "object" ? input?.sessionId || input?.session_id || "session" : "session";
  const activeFeatureGate = await loadActiveFeatureDesignGate(rootDir, sessionId);
  // §3.4：活跃功能设计门覆盖确定性路由，强制收敛到 plan/clarify 直至确认并导入 Plan。
  if (["awaiting_feature_confirmation", "awaiting_plan_import"].includes(activeFeatureGate?.status)) {
    result = enforceFeatureDesignGate(result, activeFeatureGate);
  }
  await appendLedger(rootDir, {
    type: "route_decided",
    route: result.route,
    intent: result.intent,
    domain: result.domain,
    category: result.category,
    confidence: result.confidence,
    routeAdjusted: result.routeAdjusted || false,
  });
  await writeSnapshot(rootDir, "route_decided", { route: result });
  // 决策投影：路由是四个决策缝之一。best-effort，不反噬路由主流程。
  await emitDecision(rootDir, {
    gate: "routing",
    decision: result.route,
    code: result.category || null,
    reason: `intent=${result.intent} domain=${result.domain} confidence=${result.confidence}`
      + ` adjusted=${result.routeAdjusted === true}`,
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
    },
    // 纯确定性命中只进流水；被降级/调整的路由进标注队列。
    annotatable: result.routeAdjusted === true,
  });
  return result;
}

// --- 功能设计门 ---

/** 活跃功能设计门强制将路由收敛到 plan/clarify，并注入 clarify-feature-design Skill。 */
function enforceFeatureDesignGate(result, gate) {
  const skill = {
    name: "clarify-feature-design",
    stage: "clarify",
    risk: "high",
    purpose: "新增功能必须先完成对话确认，再生成并导入完整计划。",
  };
  return {
    ...result,
    intent: "plan",
    route: "plan",
    primaryAgent: "DiJiang",
    supportAgents: uniqueStrings(["BaiZe", ...(result.supportAgents || [])]),
    skills: uniqueStrings(["clarify-feature-design", ...(result.skills || [])]),
    planSkills: [skill, ...(result.planSkills || []).filter((entry) => entry.name !== skill.name)],
    needsPlan: false,
    needsUserInput: gate.status === "awaiting_feature_confirmation",
    risk: "high",
    featureDesign: {
      id: gate.id,
      status: gate.status,
      confirmedAt: gate.confirmedAt || null,
    },
    reason: `${result.reason || ""}; feature design gate=${gate.status}`,
  };
}

/** 将 sessionId 等片段规范为 plan-drafts 文件名安全段。 */
function sanitizeDraftSegment(value) {
  return String(value || "session").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "session";
}

// --- 低置信降级 ---

/** 确定性路由置信度低于阈值的 execute 降级为 plan，需要先补计划。 */
function applyLowConfidenceGate(deterministic) {
  const confidence = deterministic.confidence ?? 0.5;
  if (deterministic.route !== "execute" || confidence >= LOW_CONFIDENCE_THRESHOLD) return deterministic;
  return {
    ...deterministic,
    route: "plan",
    intent: "plan",
    primaryAgent: "DiJiang",
    supportAgents: uniqueStrings(["BaiZe", ...(deterministic.supportAgents || [])]),
    needsPlan: true,
    needsUserInput: false,
    routeAdjusted: true,
    adjustmentReason: `low route confidence ${confidence} < ${LOW_CONFIDENCE_THRESHOLD}`,
  };
}
