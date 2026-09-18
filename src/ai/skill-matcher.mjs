// =============================================================================
// 文件名称：skill-matcher.mjs
// 所属模块：ai
// 作用说明：
//   根据用户文本、阶段、Agent 与路由信号，对 Prompt Pack 中已注册 Skill 打分排序。
//   只做匹配与评分，不加载 Skill 全文；全文加载由 injection.mjs 负责。
//
// 【运行原理速读】
//   · 何时触发？ injection.mjs 开启动态挂载时，或 CLI/Dashboard 显式查询 Skill。
//   · 做了什么？ ① 读取 prompt-pack 与 routes ② 多信号加权（显式/阶段/Agent/路由/关键词）
//     ③ 过滤零分并截断至 limit。
//   · 与谁协作？ route-table（与 resolveRouteDecision 共用信号匹配）、prompt-pack。
// =============================================================================

import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { normalizeAgentKey } from "../infra/agent-registry.mjs";
import { renderPromptPackEntry } from "../infra/prompt-pack.mjs";
import { matchSignals } from "../infra/route-table.mjs";
import {
  readJson,
  resolveWildArrangePath,
} from "../infra/runtime-store.mjs";

/** matchSkills 默认返回条数上限；config.skillMatcher.defaultLimit 未配置时使用。 */
const DEFAULT_LIMIT = 6;

/**
 * 对注册 Skill 按多信号打分，返回按分数降序的匹配列表。
 * @param {string} rootDir 项目根目录
 * @param {object} options text/query、stage、category、agent、skills、limit
 * @returns {Promise<object>} kind=skill_match，含 matched 数组与 routeSignals
 */
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

/** 加载 Prompt Pack 中各 Skill 的摘要与 haystack，供关键词与名称匹配。 */
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

/**
 * 复用 route-table 的 matchSignals，使 route-signal 加分与 resolveRouteDecision 命中一致。
 */
function collectRouteSignals(routes, text) {
  const signals = { intents: [], skills: [] };
  for (const intent of routes?.intents || []) {
    const keywords = [...(intent.signals || []), ...(intent.keywords || []), ...(intent.mustInclude || [])].map(normalizeText).filter(Boolean);
    if (matchSignals(text, keywords).length === 0) continue;
    signals.intents.push(intent.name);
    for (const skill of intent.skills || []) {
      if (!signals.skills.includes(skill)) signals.skills.push(skill);
    }
  }
  for (const bundle of routes?.planSkillBundles || routes?.planAgentBundles || []) {
    const keywords = [...(bundle.signals || [])].map(normalizeText).filter(Boolean);
    if (matchSignals(text, keywords).length === 0) continue;
    if (!signals.skills.includes(bundle.name)) signals.skills.push(bundle.name);
  }
  return signals;
}

/** 按 Agent 角色推断默认 Skill 加分列表，用于无显式绑定时偏置匹配。 */
function inferAgentSkillBoosts(agent) {
  if (!agent) return [];
  if (agent === "Jiuwei") return ["start-work", "run-linear-delivery", "review-work"];
  if (agent === "ZhuRong") return ["programming", "debugging", "refactor"];
  if (agent === "BaiZe") return ["review-work", "review-plan-risk", "review-plan-readiness", "design-acceptance"];
  if (agent === "DiJiang") return ["inspect-codebase", "research-external-docs", "review-product-intent", "design-acceptance", "review-plan-readiness"];
  if (agent === "LuWu") return ["repository-governance", "init-deep", "pre-publish-review", "remove-ai-slops"];
  return [];
}

/** 统计请求文本 token 在 Skill haystack 中的命中数，上限 8 以抑制噪声。 */
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

/** 将字符串或逗号分隔输入规范为非空字符串数组。 */
function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

/** 规范化 stageBoosts 配置为非空字符串数组。 */
function normalizeStageBoosts(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

/** 解析匹配结果条数上限，非法值回退 DEFAULT_LIMIT 并 clamp 至 20。 */
function normalizeLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, 20);
}

/** 规范化匹配用文本：trim 并折叠空白。 */
function normalizeText(value) {
  return String(value || "").toLowerCase().trim();
}
