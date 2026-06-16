import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LEAD_AGENT, loadHelixConfig, normalizeAgentKey, readJson, resolveHelixPath } from "./helix-foundation.mjs";

export async function resolveInjectionPoint(rootDir, name, variables = {}) {
  const { config, sourcePath } = await loadHelixConfig(rootDir);
  const point = config.injectionPoints?.[name] || { enabled: false, tools: [], markdown: [], skills: [] };
  const budgets = resolvePointBudgets(config.contextBudgets, name, point.contextBudgets);
  const markdown = [];
  for (const rawPath of point.markdown || []) {
    const resolved = expandTemplate(rawPath, variables);
    const loaded = await loadMarkdownAttachment(rootDir, resolved, budgets.markdownMaxChars);
    if (loaded) markdown.push(loaded);
  }
  const skills = [];
  for (const skill of point.skills || []) {
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
    rules: point.rules || {},
  };
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
