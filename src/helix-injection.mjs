import { readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LEAD_AGENT, loadHelixConfig, normalizeAgentKey, readJson, resolveHelixPath } from "./helix-foundation.mjs";

export async function resolveInjectionPoint(rootDir, name, variables = {}) {
  const { config, sourcePath } = await loadHelixConfig(rootDir);
  const point = config.injectionPoints?.[name] || { enabled: false, tools: [], markdown: [], skills: [] };
  const markdown = [];
  for (const rawPath of point.markdown || []) {
    const resolved = expandTemplate(rawPath, variables);
    const loaded = await loadMarkdownAttachment(rootDir, resolved);
    if (loaded) markdown.push(loaded);
  }
  const skills = [];
  for (const skill of point.skills || []) {
    const loaded = await loadSkillAttachment(rootDir, skill);
    if (loaded) skills.push(loaded);
  }
  return {
    name,
    enabled: point.enabled !== false,
    configPath: sourcePath,
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

async function loadMarkdownAttachment(rootDir, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("..")) return null;
  const filePath = path.join(rootDir, relativePath);
  const content = await readFile(filePath, "utf8").catch(() => null);
  if (content === null) return null;
  return {
    path: normalizeRelativePath(relativePath),
    chars: content.length,
    content: truncateForSummary(content.trim(), 6000),
  };
}

async function loadSkillAttachment(rootDir, skillName) {
  const registry = await readJson(resolveHelixPath(rootDir, "prompt-pack.json"), null);
  const entry = registry?.skills?.[skillName];
  if (!entry) return null;
  const content = await readFile(path.join(registry.packDir, entry.path), "utf8").catch(() => null);
  if (content === null) return null;
  return {
    name: skillName,
    path: entry.path,
    chars: content.length,
    content: truncateForSummary(content.trim(), 6000),
  };
}

function normalizeRelativePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function truncateForSummary(value, limit = 500) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 15)}...[truncated]`;
}
