/**
 * Deterministic route table: loading routes.json (+ reviewed overrides) and
 * matching request text against it. Pure table lookup with no LLM calls, so
 * it lives in infra — orchestration (plan import enrichment, task board) can
 * use it without depending on the ai zone. The semantic/LLM routing layers
 * (routeRequest, semanticRouteShadow) stay in src/ai/routing.mjs.
 */
import {
  DEFAULT_EXECUTOR_AGENT,
  DEFAULT_LEAD_AGENT,
  LONG_LIVED_AGENTS,
  normalizeAgentKey,
} from "./agent-registry.mjs";
import {
  readJson,
  resolveHelixPath,
} from "./runtime-store.mjs";
import { renderPromptPackEntry } from "./prompt-pack.mjs";

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
  const merged = mergeRoute(routes.defaults, intent, domain, complexity, lowerText);
  merged.planSkills = matchPlanSkillBundles(routes.planSkillBundles || routes.planAgentBundles || [], lowerText);
  merged.skills = uniqueStrings([...(merged.skills || []), ...merged.planSkills.map((skill) => skill.name)]);
  for (const planSkill of merged.planSkills) {
    merged.risk = higherRisk(merged.risk, planSkill.risk);
  }
  applyPlanningGate(merged, lowerText);
  return buildRouteResult(routes, text, merged, domain, complexity, [
    ...(intent?.matchedSignals || []),
    ...(domain?.matchedSignals || []),
    ...(complexity?.matchedSignals || []),
    ...merged.planSkills.flatMap((skill) => skill.matchedSignals || []),
  ]);
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

function matchPlanSkillBundles(entries, lowerText) {
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

function hasExplicitContinuationSignal(lowerText) {
  return /(继续做|继续执行|按计划|已有计划|下一个任务|run next|next task|继续当前任务)/i.test(lowerText);
}

function hasProductPlanningSignal(lowerText) {
  return /(做一个|从零|mvp|一期|产品|需求|提醒|待办|todo|管理|管事|复杂|工具|小程序)/i.test(lowerText);
}

function mergeRoute(defaults, intent, domain, complexity, lowerText = "") {
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
    merged.supportAgents = uniqueStrings(["BaiZe", ...(merged.supportAgents || [])]);
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

  if (intent?.lockPrimaryAgent === true) {
    merged.route = intent.route;
    merged.primaryAgent = intent.primaryAgent;
    merged.supportAgents = uniqueStrings(intent.supportAgents || []);
    merged.category = intent.category ?? null;
    merged.needsPlan = intent.needsPlan === true;
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

function applyPlanningGate(merged, lowerText) {
  if (
    merged.route !== "execute"
    || merged.needsPlan !== true
    || !Array.isArray(merged.planSkills)
    || merged.planSkills.length === 0
    || !hasProductPlanningSignal(lowerText)
    || hasExplicitContinuationSignal(lowerText)
  ) {
    return;
  }
  merged.intent = "plan";
  merged.route = "plan";
  merged.primaryAgent = "DiJiang";
  merged.supportAgents = uniqueStrings(["BaiZe", ...(merged.supportAgents || [])]);
  merged.needsPlan = false;
  merged.routeAdjusted = true;
  merged.adjustmentReason = "product/design signals require planning before execution";
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
  const primaryAgent = normalizeRoutableAgent(route.primaryAgent || routes.defaults.primaryAgent, "primaryAgent");
  const supportAgents = uniqueStrings(route.supportAgents || [])
    .map((agent) => normalizeRoutableAgent(agent, "supportAgent"));
  return {
    intent: intentName,
    complexity: route.complexity || complexity?.name || routes.defaults.complexity,
    domain: route.domain || domain?.name || routes.defaults.domain,
    route: route.route || routes.defaults.route,
    primaryAgent,
    supportAgents,
    planSkills: route.planSkills || [],
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
    routeAdjusted: route.routeAdjusted === true,
    adjustmentReason: route.adjustmentReason || null,
  };
}

function normalizeRoutableAgent(value, fieldName) {
  const normalized = normalizeAgentKey(value) || DEFAULT_EXECUTOR_AGENT;
  if (!LONG_LIVED_AGENTS.includes(normalized)) {
    throw new Error(`routes ${fieldName} must use one of ${LONG_LIVED_AGENTS.join(", ")}; received ${value || "(missing)"}`);
  }
  return normalized;
}

export function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

export function higherRisk(left = "low", right = "low") {
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

function routeConfidence(signals, risk) {
  const base = signals.length === 0 ? 0.48 : Math.min(0.92, 0.55 + signals.length * 0.08);
  if (risk === "high") return Math.max(0.5, base - 0.08);
  if (risk === "low") return Math.min(0.95, base + 0.05);
  return base;
}
