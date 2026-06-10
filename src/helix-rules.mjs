import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_HELIX_CONFIG,
  STATE_VERSION,
  appendLedger,
  ensureHelixDirs,
  loadHelixConfig,
  nowIso,
  resolveHelixPath,
  writeJsonAtomic,
} from "./helix-foundation.mjs";
import { pathMatchesPattern } from "./helix-gates.mjs";

const PROJECT_RULE_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md",
  ".github/copilot-instructions.md",
];

const PROJECT_RULE_DIRS = [
  ".omo/rules",
  ".claude/rules",
  ".cursor/rules",
  ".github/instructions",
];

export async function scanProjectRules(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const { config, sourcePath } = await loadHelixConfig(rootDir);
  const ruleConfig = config.ruleInjection || DEFAULT_HELIX_CONFIG.ruleInjection;
  const targetPaths = normalizeRuleTargetPaths(options.targetPaths || []);
  const allRules = [];
  for (const filePath of ruleConfig.projectSingleFiles || PROJECT_RULE_FILES) {
    const absolutePath = path.join(rootDir, filePath);
    if (existsSync(absolutePath)) {
      const rule = await readRuleFile(rootDir, absolutePath, "project_file");
      if (rule) allRules.push(rule);
    }
  }
  for (const dirPath of ruleConfig.projectRuleDirs || PROJECT_RULE_DIRS) {
    allRules.push(...await readRuleDir(rootDir, path.join(rootDir, dirPath), dirPath));
  }
  const matchedRules = allRules.filter((rule) => ruleMatchesTargets(rule, targetPaths));
  const budgetedRules = applyRuleBudget(matchedRules, ruleConfig);
  const result = {
    kind: "project_rules_context",
    version: STATE_VERSION,
    at: nowIso(),
    configPath: sourcePath,
    targetPaths,
    total: allRules.length,
    matched: budgetedRules.length,
    rules: budgetedRules,
  };
  const jsonPath = resolveHelixPath(rootDir, "rules", "context.json");
  const mdPath = resolveHelixPath(rootDir, "rules", "context.md");
  result.reportJsonPath = path.relative(rootDir, jsonPath);
  result.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, result);
  await writeFile(mdPath, renderRulesMarkdown(result), "utf8");
  await appendLedger(rootDir, { type: "project_rules_scanned", total: result.total, matched: result.matched, targetPathCount: targetPaths.length });
  return result;
}

function applyRuleBudget(rules, ruleConfig) {
  const maxRuleChars = Number.isInteger(ruleConfig.maxRuleChars) ? ruleConfig.maxRuleChars : DEFAULT_HELIX_CONFIG.ruleInjection.maxRuleChars;
  const maxResultChars = Number.isInteger(ruleConfig.maxResultChars) ? ruleConfig.maxResultChars : DEFAULT_HELIX_CONFIG.ruleInjection.maxResultChars;
  let total = 0;
  const output = [];
  for (const rule of rules) {
    if (total >= maxResultChars) break;
    const available = Math.max(0, Math.min(maxRuleChars, maxResultChars - total));
    if (available < 50) break;
    const content = truncateForSummary(rule.content || "", available);
    output.push({ ...rule, content });
    total += content.length;
  }
  return output;
}

async function readRuleDir(rootDir, dirPath, sourceName) {
  const entries = await safeReadDir(dirPath, { withFileTypes: true });
  const rules = [];
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      rules.push(...await readRuleDir(rootDir, entryPath, sourceName));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const rule = await readRuleFile(rootDir, entryPath, sourceName);
      if (rule) rules.push(rule);
    }
  }
  return rules;
}

async function readRuleFile(rootDir, absolutePath, sourceName) {
  const content = await readFile(absolutePath, "utf8").catch(() => null);
  if (content === null) return null;
  const relativePath = normalizeRelativePath(path.relative(rootDir, absolutePath));
  const parsed = parseRuleMarkdown(content);
  return {
    source: sourceName,
    path: relativePath,
    description: parsed.frontmatter.description || parsed.title || relativePath,
    globs: parsed.frontmatter.globs || [],
    alwaysApply: Boolean(parsed.frontmatter.alwaysApply) || (parsed.frontmatter.alwaysApply === undefined && parsed.frontmatter.globs === undefined),
    chars: parsed.body.length,
    content: truncateForSummary(parsed.body.trim(), 4_000),
  };
}

function parseRuleMarkdown(content) {
  if (!content.startsWith("---\n")) {
    return { frontmatter: {}, body: content, title: firstMarkdownHeading(content) };
  }
  const end = content.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: {}, body: content, title: firstMarkdownHeading(content) };
  const rawFrontmatter = content.slice(4, end).trim();
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  return { frontmatter: parseSimpleFrontmatter(rawFrontmatter), body, title: firstMarkdownHeading(body) };
}

function parseSimpleFrontmatter(raw) {
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (value === "true") result[key] = true;
    else if (value === "false") result[key] = false;
    else if (value.startsWith("[") && value.endsWith("]")) {
      result[key] = value.slice(1, -1).split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
    } else {
      result[key] = value.replace(/^['"]|['"]$/g, "");
    }
  }
  return result;
}

function firstMarkdownHeading(content) {
  return content.split(/\r?\n/).find((line) => line.startsWith("# "))?.slice(2).trim() || null;
}

function normalizeRuleTargetPaths(paths) {
  return uniqueStrings(paths.map(normalizeRelativePath).filter(Boolean));
}

function ruleMatchesTargets(rule, targetPaths) {
  if (rule.alwaysApply || targetPaths.length === 0) return true;
  if (!Array.isArray(rule.globs) || rule.globs.length === 0) return false;
  return targetPaths.some((targetPath) => rule.globs.some((glob) => pathMatchesPattern(targetPath, glob)));
}

function renderRulesMarkdown(result) {
  const lines = [
    "# HelixFlow Project Rules Context",
    "",
    `Generated: ${result.at}`,
    `Targets: ${result.targetPaths.join(", ") || "(all)"}`,
    `Rules: matched=${result.matched}, total=${result.total}`,
    "",
  ];
  for (const rule of result.rules) {
    lines.push(`## ${rule.path}`);
    lines.push("");
    lines.push(`- Source: ${rule.source}`);
    lines.push(`- Description: ${rule.description}`);
    lines.push(`- Always apply: ${rule.alwaysApply ? "yes" : "no"}`);
    if (rule.globs.length > 0) lines.push(`- Globs: ${rule.globs.join(", ")}`);
    lines.push("");
    lines.push(rule.content || "(empty)");
    lines.push("");
  }
  if (result.rules.length === 0) lines.push("- No matching rules.");
  return `${lines.join("\n")}\n`;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

function normalizeRelativePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

async function safeReadDir(dirPath, options = undefined) {
  try {
    return await readdir(dirPath, options);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function truncateForSummary(value, limit = 500) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 15)}...[truncated]`;
}
