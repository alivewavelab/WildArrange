import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { normalizeAgentKey } from "../infra/agent-registry.mjs";
import { renderPromptPackEntry } from "../infra/prompt-pack.mjs";
import {
  readJson,
  resolveWildArrangePath,
} from "../infra/runtime-store.mjs";

const DEFAULT_LIMIT = 6;

export async function matchSkills(rootDir, options = {}) {
  const { config } = await loadWildArrangeConfig(rootDir);
  const registry = await readJson(resolveWildArrangePath(rootDir, "prompt-pack.json"), null);
  if (!registry) throw new Error("prompt pack is not installed; run wildarrange init");
  const routes = registry.routes
    ? JSON.parse(await renderPromptPackEntry(rootDir, { routes: true }))
    : null;
  const text = normalizeText(options.text || options.query || "");
  const stage = normalizeText(options.stage || "");
  const category = normalizeText(options.category || "");
  const agent = normalizeAgentKey(options.agent || "") || "";
  const explicitSkills = normalizeStringArray(options.skills || []);
  const limit = normalizeLimit(options.limit || config.skillMatcher?.defaultLimit);
  const entries = await loadSkillSummaries(rootDir, registry);
  const routeSignals = collectRouteSignals(routes, text);
  const stageBoosts = normalizeStageBoosts(config.skillMatcher?.stageBoosts?.[stage]);
  const agentBoosts = inferAgentSkillBoosts(agent);

  const scored = entries.map((entry) => {
    const reasons = [];
    let score = 0;
    if (explicitSkills.includes(entry.name)) {
      score += 100;
      reasons.push("explicit");
    }
    if (stageBoosts.includes(entry.name)) {
      score += 35;
      reasons.push(`stage:${stage}`);
    }
    if (agentBoosts.includes(entry.name)) {
      score += 22;
      reasons.push(`agent:${agent}`);
    }
    if (routeSignals.skills.includes(entry.name)) {
      score += 45;
      reasons.push("route-signal");
    }
    if (category && entry.haystack.includes(category)) {
      score += 12;
      reasons.push(`category:${category}`);
    }
    const keywordHits = scoreKeywordHits(text, entry);
    if (keywordHits > 0) {
      score += keywordHits * 8;
      reasons.push(`keyword:${keywordHits}`);
    }
    const nameParts = entry.name.split(/[-_]/).filter(Boolean);
    const nameHits = nameParts.filter((part) => text.includes(part)).length;
    if (nameHits > 0) {
      score += nameHits * 10;
      reasons.push(`name:${nameHits}`);
    }
    return {
      name: entry.name,
      score,
      reasons,
      path: entry.path,
      excerpt: entry.excerpt,
    };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);

  return {
    kind: "skill_match",
    stage: stage || null,
    category: category || null,
    agent: agent || null,
    inputChars: text.length,
    matched: scored,
    routeSignals,
  };
}

async function loadSkillSummaries(rootDir, registry) {
  const entries = [];
  for (const [name, entry] of Object.entries(registry.skills || {})) {
    const content = await renderPromptPackEntry(rootDir, { skill: name });
    const excerpt = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 5)
      .join(" ")
      .slice(0, 260);
    entries.push({
      name,
      path: entry.path,
      excerpt,
      haystack: normalizeText(`${name} ${entry.path} ${excerpt} ${content.slice(0, 1200)}`),
    });
  }
  return entries;
}

function collectRouteSignals(routes, text) {
  const signals = { intents: [], skills: [] };
  for (const intent of routes?.intents || []) {
    const keywords = [...(intent.signals || []), ...(intent.keywords || []), ...(intent.mustInclude || [])].map(normalizeText).filter(Boolean);
    const hit = keywords.some((keyword) => keyword && text.includes(keyword));
    if (!hit) continue;
    signals.intents.push(intent.name);
    for (const skill of intent.skills || []) {
      if (!signals.skills.includes(skill)) signals.skills.push(skill);
    }
  }
  for (const bundle of routes?.planSkillBundles || routes?.planAgentBundles || []) {
    const keywords = [...(bundle.signals || [])].map(normalizeText).filter(Boolean);
    if (!keywords.some((keyword) => keyword && text.includes(keyword))) continue;
    if (!signals.skills.includes(bundle.name)) signals.skills.push(bundle.name);
  }
  return signals;
}

function inferAgentSkillBoosts(agent) {
  if (!agent) return [];
  if (agent === "Jiuwei") return ["start-work", "run-linear-delivery", "review-work"];
  if (agent === "ZhuRong") return ["programming", "debugging", "refactor"];
  if (agent === "BaiZe") return ["review-work", "review-plan-risk", "review-plan-readiness", "design-acceptance"];
  if (agent === "DiJiang") return ["clarify-feature-design", "inspect-codebase", "research-external-docs", "review-product-intent", "design-acceptance", "review-plan-readiness"];
  if (agent === "LuWu") return ["repository-governance", "init-deep", "pre-publish-review", "remove-ai-slops"];
  return [];
}

function scoreKeywordHits(text, entry) {
  if (!text) return 0;
  const tokens = text
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((token) => normalizeText(token))
    .filter((token) => token.length >= 2);
  let hits = 0;
  for (const token of new Set(tokens)) {
    if (entry.haystack.includes(token)) hits += 1;
  }
  return Math.min(hits, 8);
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function normalizeStageBoosts(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function normalizeLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, 20);
}

function normalizeText(value) {
  return String(value || "").toLowerCase().trim();
}
