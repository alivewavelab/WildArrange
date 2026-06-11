import {
  DEFAULT_EXECUTOR_AGENT,
  DEFAULT_LEAD_AGENT,
  appendLedger,
  initRuntime,
  loadHelixConfig,
  normalizeAgentKey,
  readJson,
  renderPromptPackEntry,
  resolveHelixPath,
  writeSnapshot,
} from "./helix-foundation.mjs";
import { callOpenAICompatible, resolveAgentProvider } from "./helix-llm.mjs";

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

export async function loadRoutesConfig(rootDir) {
  const routes = JSON.parse(await renderPromptPackEntry(rootDir, { routes: true }));
  const overrides = await readJson(resolveHelixPath(rootDir, "routing", "routes-overrides.json"), null);
  return applyRouteOverrides(routes, overrides);
}

export function resolveRouteDecision(routes, text) {
  const lowerText = text.toLowerCase();
  const askGate = routes.askGate || {};
  const askMatches = matchSignals(lowerText, askGate.signals || []);

  if (askMatches.length > 0) {
    return buildRouteResult(routes, text, {
      ...routes.defaults,
      intent: "ask",
      route: askGate.route || "ask",
      primaryAgent: askGate.primaryAgent || DEFAULT_LEAD_AGENT,
      supportAgents: [],
      category: null,
      skills: [],
      needsPlan: false,
      needsUserInput: true,
      risk: askGate.risk || "high",
    }, null, null, askMatches);
  }

  let intent = bestMatch(routes.intents || [], lowerText) || routes.defaults;
  if (intent?.name === "review" && hasPlanningCreationSignal(lowerText)) {
    intent = (routes.intents || []).find((entry) => entry.name === "plan") || intent;
  }
  const domain = bestMatch(routes.domains || [], lowerText);
  const complexity = bestMatch(routes.complexity || [], lowerText);
  const merged = mergeRoute(routes.defaults, intent, domain, complexity);
  merged.planAgents = matchPlanAgentBundles(routes.planAgentBundles || [], lowerText);
  for (const planAgent of merged.planAgents) {
    merged.risk = higherRisk(merged.risk, planAgent.risk);
  }
  return buildRouteResult(routes, text, merged, domain, complexity, [
    ...(intent?.matchedSignals || []),
    ...(domain?.matchedSignals || []),
    ...(complexity?.matchedSignals || []),
    ...merged.planAgents.flatMap((agent) => agent.matchedSignals || []),
  ]);
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

function bestMatch(entries, lowerText) {
  let best = null;
  for (const entry of entries) {
    const matchedSignals = matchSignals(lowerText, entry.signals || []);
    if (matchedSignals.length === 0) continue;
    const candidate = { ...entry, matchedSignals, score: matchedSignals.length };
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best;
}

function matchSignals(lowerText, signals) {
  return signals.filter((signal) => signalMatches(lowerText, String(signal).toLowerCase()));
}

function matchPlanAgentBundles(entries, lowerText) {
  return entries
    .map((entry) => ({ ...entry, matchedSignals: matchSignals(lowerText, entry.signals || []) }))
    .filter((entry) => entry.matchedSignals.length > 0)
    .map((entry) => ({
      name: entry.name,
      stage: entry.stage,
      risk: entry.risk || "medium",
      purpose: entry.purpose || "",
      matchedSignals: entry.matchedSignals,
    }));
}

function signalMatches(lowerText, signal) {
  if (!signal) return false;
  if (!/^[a-z0-9][a-z0-9\s_-]*$/i.test(signal)) {
    return lowerText.includes(signal);
  }
  const escaped = signal.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(lowerText);
}

function hasPlanningCreationSignal(lowerText) {
  return /(新增|新功能|大功能|做一个|实现|开发|设计|计划|方案|mvp|一期|从零)/i.test(lowerText);
}

function mergeRoute(defaults, intent, domain, complexity) {
  const merged = {
    ...defaults,
    ...(intent || {}),
  };
  if (intent?.name) merged.intent = intent.name;
  delete merged.signals;
  delete merged.score;
  delete merged.matchedSignals;

  if (complexity?.routeBias === "plan" && !["review", "resume", "investigate", "answer", "release_git"].includes(merged.intent)) {
    merged.route = "plan";
    merged.primaryAgent = "DiJiang";
    merged.supportAgents = uniqueStrings(["Kui", "Taotie", "LuanNiao", "QiongQi", "BaiZe", ...(merged.supportAgents || [])]);
    merged.needsPlan = false;
  }
  if (complexity?.categoryBias && !domain?.category) {
    merged.category = complexity.categoryBias;
  }

  if (domain) {
    merged.domain = domain.name;
    if (domain.category !== undefined) merged.category = domain.category;
    if (domain.primaryAgent) merged.primaryAgent = domain.primaryAgent;
    merged.supportAgents = uniqueStrings([...(merged.supportAgents || []), ...(domain.supportAgents || [])]);
    merged.skills = uniqueStrings([...(merged.skills || []), ...(domain.skills || [])]);
    merged.risk = higherRisk(merged.risk, domain.risk);
  } else {
    merged.domain = defaults.domain;
  }

  if (domain?.name === "visual") {
    if (!["plan", "answer", "investigate", "review", "resume", "change_request"].includes(merged.intent)) {
      merged.route = "execute";
    }
    merged.category = "visual-engineering";
  }
  if (merged.intent === "review") {
    merged.category = null;
    merged.primaryAgent = "BaiZe";
  }
  if (merged.intent === "resume") {
    merged.nextCommand = "node ./bin/helix.mjs resume";
    merged.needsPlan = false;
  }

  merged.complexity = complexity?.name || defaults.complexity;
  merged.needsUserInput = Boolean(merged.needsUserInput);
  return merged;
}

function buildRouteResult(routes, text, route, domain, complexity, matchedSignals) {
  const intentName = route.intent || routes.defaults.intent;
  const signals = uniqueStrings(matchedSignals);
  const reasonParts = [
    `intent=${intentName}`,
    `domain=${route.domain || domain?.name || routes.defaults.domain}`,
    `complexity=${route.complexity || complexity?.name || routes.defaults.complexity}`,
  ];
  if (signals.length > 0) {
    reasonParts.push(`matched=${signals.join(",")}`);
  }
  return {
    intent: intentName,
    complexity: route.complexity || complexity?.name || routes.defaults.complexity,
    domain: route.domain || domain?.name || routes.defaults.domain,
    route: route.route || routes.defaults.route,
    primaryAgent: normalizeAgentKey(route.primaryAgent || routes.defaults.primaryAgent) || DEFAULT_EXECUTOR_AGENT,
    supportAgents: uniqueStrings(route.supportAgents || []).map(normalizeAgentKey).filter(Boolean),
    planAgents: route.planAgents || [],
    category: route.category ?? null,
    skills: uniqueStrings(route.skills || []),
    nextCommand: route.nextCommand || routes.defaults.nextCommand,
    needsPlan: Boolean(route.needsPlan),
    needsUserInput: Boolean(route.needsUserInput),
    reason: reasonParts.join("; "),
    risk: route.risk || routes.defaults.risk,
    matchedSignals: signals,
    confidence: route.confidence ?? routeConfidence(signals, route.risk || routes.defaults.risk),
    inputPreview: text.slice(0, 160),
  };
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function higherRisk(left = "low", right = "low") {
  const order = { low: 1, medium: 2, high: 3 };
  return (order[right] || 1) > (order[left] || 1) ? right : left;
}

function applyRouteOverrides(routes, overrides) {
  if (!overrides || !Array.isArray(overrides.patches)) return routes;
  const next = structuredClone(routes);
  for (const patch of overrides.patches) {
    const target = String(patch.target || "");
    const signals = uniqueStrings(patch.signals || []);
    if (signals.length === 0) continue;
    const [collectionName, entryName] = target.split(".");
    const collection = next[collectionName];
    if (!Array.isArray(collection) || !entryName) continue;
    const entry = collection.find((candidate) => candidate.name === entryName);
    if (!entry) continue;
    entry.signals = uniqueStrings([...(entry.signals || []), ...signals]);
  }
  return next;
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
      supportAgents: uniqueStrings(["Kui", "Taotie", "BaiZe", ...(result.supportAgents || [])]),
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

function routeConfidence(signals, risk) {
  const base = signals.length === 0 ? 0.48 : Math.min(0.92, 0.55 + signals.length * 0.08);
  if (risk === "high") return Math.max(0.5, base - 0.08);
  if (risk === "low") return Math.min(0.95, base + 0.05);
  return base;
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
