import {
  appendLedger,
  initRuntime,
  renderPromptPackEntry,
  writeSnapshot,
} from "./helix-foundation.mjs";

export async function routeRequest(rootDir, input) {
  await initRuntime(rootDir);
  const text = typeof input === "string" ? input : input?.text;
  if (!text || typeof text !== "string") {
    throw new Error("route text is required");
  }

  const routes = await loadRoutesConfig(rootDir);
  const result = resolveRouteDecision(routes, text);
  await appendLedger(rootDir, { type: "route_decided", route: result.route, intent: result.intent, domain: result.domain, category: result.category });
  await writeSnapshot(rootDir, "route_decided", { route: result });
  return result;
}

export async function loadRoutesConfig(rootDir) {
  return JSON.parse(await renderPromptPackEntry(rootDir, { routes: true }));
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
      primaryAgent: askGate.primaryAgent || "Sisyphus",
      supportAgents: [],
      category: null,
      skills: [],
      needsPlan: false,
      needsUserInput: true,
      risk: askGate.risk || "high",
    }, null, null, askMatches);
  }

  const intent = bestMatch(routes.intents || [], lowerText) || routes.defaults;
  const domain = bestMatch(routes.domains || [], lowerText);
  const complexity = bestMatch(routes.complexity || [], lowerText);
  const merged = mergeRoute(routes.defaults, intent, domain, complexity);
  return buildRouteResult(routes, text, merged, domain, complexity, [
    ...(intent?.matchedSignals || []),
    ...(domain?.matchedSignals || []),
    ...(complexity?.matchedSignals || []),
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

function signalMatches(lowerText, signal) {
  if (!signal) return false;
  if (!/^[a-z0-9][a-z0-9\s_-]*$/i.test(signal)) {
    return lowerText.includes(signal);
  }
  const escaped = signal.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(lowerText);
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
    merged.primaryAgent = "Prometheus";
    merged.supportAgents = uniqueStrings(["Explore", "Librarian", "Metis", "Momus", "Oracle", ...(merged.supportAgents || [])]);
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
    merged.primaryAgent = "Oracle";
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
  const reasonParts = [
    `intent=${intentName}`,
    `domain=${route.domain || domain?.name || routes.defaults.domain}`,
    `complexity=${route.complexity || complexity?.name || routes.defaults.complexity}`,
  ];
  if (matchedSignals.length > 0) {
    reasonParts.push(`matched=${uniqueStrings(matchedSignals).join(",")}`);
  }
  return {
    intent: intentName,
    complexity: route.complexity || complexity?.name || routes.defaults.complexity,
    domain: route.domain || domain?.name || routes.defaults.domain,
    route: route.route || routes.defaults.route,
    primaryAgent: route.primaryAgent || routes.defaults.primaryAgent,
    supportAgents: uniqueStrings(route.supportAgents || []),
    category: route.category ?? null,
    skills: uniqueStrings(route.skills || []),
    nextCommand: route.nextCommand || routes.defaults.nextCommand,
    needsPlan: Boolean(route.needsPlan),
    needsUserInput: Boolean(route.needsUserInput),
    reason: reasonParts.join("; "),
    risk: route.risk || routes.defaults.risk,
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
