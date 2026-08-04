/**
 * AI-side routing: the full routeRequest flow (deterministic table match plus
 * optional semantic shadow via an LLM) and semantic route governance. The
 * deterministic table itself lives in src/infra/route-table.mjs so
 * orchestration can read it without depending on this zone.
 */
import { DEFAULT_LEAD_AGENT } from "../infra/agent-registry.mjs";
import { appendLedger } from "../infra/ledger.mjs";
import { initRuntime } from "../infra/runtime-bootstrap.mjs";
import { loadHelixConfig } from "../infra/runtime-config.mjs";
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
  return result;
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
