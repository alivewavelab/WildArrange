import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  loadHelixConfig,
  normalizeAgentKey,
  readJson,
  resolveHelixPath,
} from "./helix-foundation.mjs";

const DEFAULT_LIMIT = 6;

export async function matchSkills(rootDir, options = {}) {
  const { config } = await loadHelixConfig(rootDir);
  const registry = await readJson(resolveHelixPath(rootDir, "prompt-pack.json"), null);
  if (!registry) throw new Error("prompt pack is not installed; run helix init");
  const routes = registry.routes
    ? await readJson(path.join(registry.packDir, registry.routes.path), null)
    : null;
  const text = normalizeText(options.text || options.query || "");
  const stage = normalizeText(options.stage || "");
  const category = normalizeText(options.category || "");
  const agent = normalizeAgentKey(options.agent || "") || "";
  const explicitSkills = normalizeStringArray(options.skills || []);
  const limit = normalizeLimit(options.limit || config.skillMatcher?.defaultLimit);
  const entries = await loadSkillSummaries(registry);
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

export async function resolvePromptVariant(rootDir, options = {}) {
  const { config } = await loadHelixConfig(rootDir);
  const agent = normalizeAgentKey(options.agent || "") || "";
  const agentConfig = agent ? config.agents?.[agent] : null;
  const provider = normalizeText(options.provider || agentConfig?.provider || "host");
  const model = normalizeText(options.model || agentConfig?.model || "");
  const variantKey = normalizeVariantKey(options.variant || provider, model);
  const variants = config.promptVariants || {};
  const variantText = variants[variantKey] || variants[provider] || variants.host || "";
  return {
    kind: "prompt_variant",
    agent: agent || null,
    provider,
    model: model || null,
    variant: variantKey,
    content: variantText,
  };
}

async function loadSkillSummaries(registry) {
  const entries = [];
  for (const [name, entry] of Object.entries(registry.skills || {})) {
    const content = await readFile(path.join(registry.packDir, entry.path), "utf8");
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
  return signals;
}

function inferAgentSkillBoosts(agent) {
  if (!agent) return [];
  if (agent === "Jiuwei") return ["start-work", "wa-plan", "review-work"];
  if (agent === "YingLong" || agent === "ZhuRong") return ["programming", "debugging", "refactor", "wa-work"];
  if (agent === "BaiZe" || agent === "LuanNiao" || agent === "QiongQi") return ["review-work", "wa-review", "wa-test"];
  if (agent === "Kui" || agent === "Taotie") return ["ultraresearch", "init-deep"];
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

function normalizeVariantKey(value, model) {
  const raw = normalizeText(value || "");
  if (raw === "openai" || raw.startsWith("gpt") || model.startsWith("gpt")) return "gpt";
  if (raw.startsWith("gemini") || model.startsWith("gemini")) return "gemini";
  if (raw.startsWith("kimi") || model.startsWith("kimi")) return "kimi";
  if (raw.startsWith("deepseek") || model.startsWith("deepseek")) return "deepseek";
  return raw || "host";
}

function normalizeText(value) {
  return String(value || "").toLowerCase().trim();
}
