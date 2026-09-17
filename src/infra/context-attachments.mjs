import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { readJson, resolveWildArrangePath, hashContent } from "./runtime-store.mjs";
import { assertPathInsideRoot } from "./path-match.mjs";
import { renderPromptPackEntry } from "./prompt-pack.mjs";

export async function loadMarkdownAttachment(rootDir, relativePath, maxChars) {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("..")) return null;
  const filePath = path.join(rootDir, relativePath);
  const root = await realpath(rootDir);
  let resolved;
  try { resolved = await realpath(filePath); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  assertPathInsideRoot(root, resolved, relativePath);
  const content = await readFile(resolved, "utf8");
  if (content === null) return null;
  const prepared = prepareAttachmentContent(content.trim(), maxChars, `Markdown ${normalizeRelativePath(relativePath)}`);
  return {
    path: normalizeRelativePath(relativePath),
    sha256: hashContent(content),
    chars: content.length,
    loadedChars: prepared.loadedChars,
    budgetChars: prepared.budgetChars,
    truncated: prepared.truncated,
    content: prepared.content,
  };
}

export async function loadSkillAttachment(rootDir, skillName, maxChars) {
  const registry = await readJson(resolveWildArrangePath(rootDir, "prompt-pack.json"), null);
  const entry = registry?.skills?.[skillName];
  const projectSkill = entry ? null : await resolveProjectSkill(rootDir, skillName);
  if (!entry && !projectSkill) return null;
  // Prompt Pack 的固定运行时根、路径边界与 sha256 必须由 infra 的单一 owner
  // 校验，AI 层不能根据 registry 自行拼读取路径绕开完整性协议。
  const content = entry
    ? await renderPromptPackEntry(rootDir, { skill: skillName })
    : await readFile(projectSkill.filePath, "utf8").catch(() => null);
  if (content === null) return null;
  const prepared = prepareAttachmentContent(content.trim(), maxChars, `Skill ${skillName}`);
  return {
    name: skillName,
    path: entry?.path || projectSkill.relativePath,
    source: entry ? "prompt-pack" : "project",
    sha256: hashContent(content),
    chars: content.length,
    loadedChars: prepared.loadedChars,
    budgetChars: prepared.budgetChars,
    truncated: prepared.truncated,
    content: prepared.content,
  };
}

async function resolveProjectSkill(rootDir, skillName) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(String(skillName))) return null;
  const skillsRoot = path.join(rootDir, ".agents", "skills");
  const candidate = path.join(skillsRoot, skillName, "SKILL.md");
  try {
    const [realProjectRoot, realSkillsRoot, realCandidate] = await Promise.all([
      realpath(rootDir),
      realpath(skillsRoot),
      realpath(candidate),
    ]);
    const skillsRootFromProject = path.relative(realProjectRoot, realSkillsRoot);
    if (!skillsRootFromProject || skillsRootFromProject.startsWith("..") || path.isAbsolute(skillsRootFromProject)) return null;
    const relative = path.relative(realSkillsRoot, realCandidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    return {
      filePath: realCandidate,
      relativePath: normalizeRelativePath(path.relative(rootDir, candidate)),
    };
  } catch {
    return null;
  }
}

function normalizeRelativePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

export function normalizeMaxChars(value, fallback) {
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
