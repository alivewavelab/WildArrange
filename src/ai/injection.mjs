import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LEAD_AGENT, loadHelixConfig, normalizeAgentKey, readJson, resolveHelixPath } from "../infra/foundation.mjs";
import { matchSkills } from "./skill-matcher.mjs";

const DEFAULT_DYNAMIC_ALWAYS_MOUNT = ["wildarrange-injection-runtime"];
const DEFAULT_DYNAMIC_MAX_SKILLS = 4;

export async function resolveInjectionPoint(rootDir, name, variables = {}, options = {}) {
  const { config, sourcePath } = await loadHelixConfig(rootDir);
  const point = config.injectionPoints?.[name] || { enabled: false, tools: [], markdown: [], skills: [] };
  const budgets = resolvePointBudgets(config.contextBudgets, name, point.contextBudgets);
  const markdown = [];
  for (const rawPath of point.markdown || []) {
    const resolved = expandTemplate(rawPath, variables);
    const loaded = await loadMarkdownAttachment(rootDir, resolved, budgets.markdownMaxChars);
    if (loaded) markdown.push(loaded);
  }
  const selection = await selectPointSkills(rootDir, config, point, {
    text: typeof options.text === "string" ? options.text : "",
    stage: typeof options.stage === "string" ? options.stage : "",
    agent: variables.agent || "",
  });
  const skills = [];
  for (const skill of selection.mounted) {
    const loaded = await loadSkillAttachment(rootDir, skill, budgets.skillMaxChars);
    if (loaded) skills.push(loaded);
  }
  return {
    name,
    enabled: point.enabled !== false,
    configPath: sourcePath,
    budgets,
    tools: point.tools || [],
    markdown,
    skills,
    skillSelection: selection.report,
    rules: point.rules || {},
  };
}

// 按需挂载只做"减法"：静态清单是上限，动态匹配决定哪些真正带全文进入上下文，
// 未命中的降级为路径引用；绝不因为文本命中关键词就注入清单之外的技能全文。
async function selectPointSkills(rootDir, config, point, context) {
  const configured = (point.skills || []).filter((skill) => typeof skill === "string" && skill.length > 0);
  const dynamicConfig = config.skillMatcher?.dynamicInjection || {};
  const enabled = dynamicConfig.enabled !== false && config.skillMatcher?.enabled !== false;
  const staticReport = {
    mode: "static",
    mounted: configured,
    referenced: [],
    reason: null,
  };
  if (!enabled) return { mounted: configured, report: { ...staticReport, reason: "dynamic_injection_disabled" } };
  if (!context.text || context.text.trim().length === 0) {
    return { mounted: configured, report: { ...staticReport, reason: "no_request_text" } };
  }

  let match;
  try {
    match = await matchSkills(rootDir, {
      text: context.text,
      stage: context.stage,
      agent: context.agent,
      limit: 20,
    });
  } catch (error) {
    return { mounted: configured, report: { ...staticReport, reason: `matcher_unavailable: ${error instanceof Error ? error.message : String(error)}` } };
  }

  const alwaysMount = normalizeStringList(dynamicConfig.alwaysMount, DEFAULT_DYNAMIC_ALWAYS_MOUNT);
  const maxSkills = normalizeMaxSkills(dynamicConfig.maxSkills, DEFAULT_DYNAMIC_MAX_SKILLS);
  // 只认与请求内容相关的信号（关键词/路由/阶段/名称命中）；
  // agent 身份加分对每次请求都恒定，等于回到静态挂载，不能作为按需依据。
  const scores = new Map(
    match.matched
      .filter((entry) => (entry.reasons || []).some((reason) => !reason.startsWith("agent:")))
      .map((entry) => [entry.name, entry.score]),
  );

  const mounted = [];
  const referenced = [];
  for (const skill of configured) {
    if (alwaysMount.includes(skill)) {
      mounted.push(skill);
      continue;
    }
    if ((scores.get(skill) || 0) > 0) {
      mounted.push(skill);
    } else {
      referenced.push({ name: skill, reason: "not_matched" });
    }
  }

  // maxSkills 约束动态部分：保底技能之外，最多保留得分最高的 maxSkills 个
  const baseline = mounted.filter((skill) => alwaysMount.includes(skill));
  const dynamic = mounted
    .filter((skill) => !alwaysMount.includes(skill))
    .sort((left, right) => (scores.get(right) || 0) - (scores.get(left) || 0));
  for (const skill of dynamic.slice(maxSkills)) {
    referenced.push({ name: skill, reason: "over_max_skills" });
  }
  const finalMounted = [...baseline, ...dynamic.slice(0, maxSkills)];

  // 清单之外的高分技能只给引用，不注入全文
  const suggestions = match.matched
    .filter((entry) => !configured.includes(entry.name))
    .slice(0, 5)
    .map((entry) => ({ name: entry.name, score: entry.score, path: entry.path, reason: "matched_outside_point" }));

  return {
    mounted: finalMounted,
    report: {
      mode: "dynamic",
      textChars: context.text.length,
      stage: context.stage || null,
      mounted: finalMounted,
      referenced,
      suggestions,
      reason: null,
    },
  };
}

function normalizeStringList(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  return value.filter((item) => typeof item === "string" && item.length > 0);
}

function normalizeMaxSkills(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, 20);
}

export function defaultInjectionPointForAgent(agent) {
  const normalized = normalizeAgentKey(agent);
  if (normalized === "BaiZe" || normalized === "QiongQi" || normalized === "LuanNiao") return "before_review";
  if (normalized === DEFAULT_LEAD_AGENT) return "user_prompt_submit";
  return "before_execute";
}

function expandTemplate(value, variables) {
  return String(value).replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => variables[key] || "");
}

async function loadMarkdownAttachment(rootDir, relativePath, maxChars) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("..")) return null;
  const filePath = path.join(rootDir, relativePath);
  const content = await readFile(filePath, "utf8").catch(() => null);
  if (content === null) return null;
  const prepared = prepareAttachmentContent(content.trim(), maxChars, `Markdown ${normalizeRelativePath(relativePath)}`);
  return {
    path: normalizeRelativePath(relativePath),
    chars: content.length,
    loadedChars: prepared.loadedChars,
    budgetChars: prepared.budgetChars,
    truncated: prepared.truncated,
    content: prepared.content,
  };
}

async function loadSkillAttachment(rootDir, skillName, maxChars) {
  const registry = await readJson(resolveHelixPath(rootDir, "prompt-pack.json"), null);
  const entry = registry?.skills?.[skillName];
  if (!entry) return null;
  const content = await readFile(path.join(registry.packDir, entry.path), "utf8").catch(() => null);
  if (content === null) return null;
  const prepared = prepareAttachmentContent(content.trim(), maxChars, `Skill ${skillName}`);
  return {
    name: skillName,
    path: entry.path,
    chars: content.length,
    loadedChars: prepared.loadedChars,
    budgetChars: prepared.budgetChars,
    truncated: prepared.truncated,
    content: prepared.content,
  };
}

function normalizeRelativePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function resolvePointBudgets(contextBudgets = {}, pointName, pointBudgets = {}) {
  const globalMarkdown = contextBudgets.markdown?.maxChars ?? contextBudgets.markdownMaxChars;
  const globalSkill = contextBudgets.skill?.maxChars ?? contextBudgets.skillMaxChars;
  const pointOverride = contextBudgets.points?.[pointName] || {};
  const merged = {
    markdownMaxChars: globalMarkdown,
    skillMaxChars: globalSkill,
    ...pointOverride,
    ...pointBudgets,
  };
  return {
    markdownMaxChars: normalizeMaxChars(merged.markdownMaxChars, 12_000),
    skillMaxChars: normalizeMaxChars(merged.skillMaxChars, 80_000),
  };
}

function normalizeMaxChars(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(500, Math.min(Math.floor(parsed), 500_000));
}

function prepareAttachmentContent(value, maxChars, label) {
  const budgetChars = normalizeMaxChars(maxChars, 12_000);
  if (value.length <= budgetChars) {
    return {
      content: value,
      loadedChars: value.length,
      budgetChars,
      truncated: false,
    };
  }

  // 中文说明是给 Agent 看的：超长 Skill 可以被截断，但绝不能静默失效。
  const marker = `\n\n[上下文已截断：${label} 原始 ${value.length} 字符，当前注入预算 ${budgetChars} 字符。需要完整工作流时，请按路径读取源文件或把重型资料拆到 references 后按需加载。]`;
  const sliceLength = Math.max(0, budgetChars - marker.length);
  const content = `${value.slice(0, sliceLength)}${marker}`;
  return {
    content,
    loadedChars: content.length,
    budgetChars,
    truncated: true,
  };
}
