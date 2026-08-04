import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { LONG_LIVED_AGENTS } from "./agent-registry.mjs";
import { loadHelixConfig } from "./runtime-config.mjs";
import { normalizeRelativePath, pathMatchesPattern } from "./path-match.mjs";

const DEFAULT_IGNORED = new Set([".git", ".helix", "node_modules", "coverage"]);
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const execFileAsync = promisify(execFile);

export async function inspectRepositoryGovernance(rootDir, policy = {}, options = {}) {
  if (policy.enabled !== true && options.force !== true) {
    return {
      kind: "repository_governance",
      status: "skipped",
      pass: true,
      findings: [],
      proposedChanges: [],
      unresolved: [],
      reason: "repositoryGovernance.enabled is not true",
    };
  }

  const findings = [];
  const ignored = new Set([...(policy.ignoredPaths || []), ...DEFAULT_IGNORED]);
  const governedRoots = normalizeList(policy.governedRoots);
  const changedPaths = normalizeList(options.changedPaths);
  const changedOnly = options.changedOnly === true;
  const candidateFiles = changedOnly
    ? changedPaths.filter((filePath) => existsSync(path.join(rootDir, filePath)))
    : await collectGovernedFiles(rootDir, governedRoots, ignored);

  const boundaries = changedOnly
    ? normalizeList(policy.requiredAgentBoundaries).filter((boundary) => changedPaths.some((filePath) => pathIsWithin(filePath, boundary)))
    : policy.requiredAgentBoundaries;
  const documentationPairs = changedOnly
    ? (Array.isArray(policy.documentationPairs) ? policy.documentationPairs : []).filter((pair) => Array.isArray(pair) && pair.some((filePath) => changedPaths.includes(normalizeRelativePath(filePath))))
    : policy.documentationPairs;
  const cliDocumentationPairs = changedOnly && changedPaths.includes("bin/helix.mjs")
    ? policy.documentationPairs
    : documentationPairs;
  const documentationRequirements = changedOnly
    ? (Array.isArray(policy.documentationRequirements) ? policy.documentationRequirements : []).filter((requirement) => changedPaths.includes(normalizeRelativePath(requirement.path || "")))
    : policy.documentationRequirements;
  const promptPackTouched = !changedOnly || changedPaths.some((filePath) => pathIsWithin(filePath, "packs/wildarrange-linear"));
  const architectureTouched = !changedOnly
    || changedPaths.some((filePath) => pathIsWithin(filePath, "src/interface")
      || pathIsWithin(filePath, "src/orchestration")
      || pathIsWithin(filePath, "src/ai")
      || pathIsWithin(filePath, "src/capabilities")
      || pathIsWithin(filePath, "src/infra")
      || normalizeList(policy.architectureLedgers).includes(filePath));

  await checkAgentBoundaries(rootDir, boundaries, findings);
  await checkDocumentationPairs(rootDir, documentationPairs, findings);
  await checkDocumentationRequirements(rootDir, documentationRequirements, findings);
  await checkDocumentedCliCommands(rootDir, cliDocumentationPairs, findings);
  if (promptPackTouched) await checkPromptPackManifest(rootDir, findings);
  if (changedOnly) {
    await checkChangedPathNaming(rootDir, changedPaths, governedRoots, policy.naming || {}, findings);
  } else {
    await checkNaming(rootDir, governedRoots, policy.naming || {}, ignored, findings);
  }
  if (architectureTouched) await checkArchitectureLedgers(rootDir, policy.architectureLedgers, findings);
  await checkCommentRules(rootDir, candidateFiles, policy.commentRules || [], findings);

  const normalizedFindings = findings
    .map((finding) => ({
      ...finding,
      id: stableFindingId(finding),
    }))
    .sort((left, right) => left.severity.localeCompare(right.severity) || left.path.localeCompare(right.path) || (left.line || 0) - (right.line || 0));
  const blocking = normalizedFindings.filter((finding) => finding.severity === "P0" || finding.severity === "P1");
  return {
    kind: "repository_governance",
    status: blocking.length > 0 ? "fail" : normalizedFindings.length > 0 ? "warn" : "pass",
    pass: blocking.length === 0,
    mode: changedOnly ? "changed-only" : "full",
    governedRoots,
    changedPathCount: changedOnly ? changedPaths.length : null,
    candidateFileCount: candidateFiles.length,
    findings: normalizedFindings,
    proposedChanges: normalizedFindings.map((findingValue) => ({
      findingId: findingValue.id,
      path: findingValue.path,
      reason: findingValue.evidence,
      requiredFix: findingValue.requiredFix,
      verification: "node ./bin/helix.mjs governance audit",
    })),
    unresolved: [],
  };
}

async function checkAgentBoundaries(rootDir, boundaries, findings) {
  for (const boundary of normalizeList(boundaries)) {
    const boundaryPath = path.join(rootDir, boundary);
    const agentsPath = path.join(boundaryPath, "AGENTS.md");
    if (!existsSync(boundaryPath)) {
      findings.push(finding("required_boundary_missing", "P1", boundary, null, "required governance boundary does not exist", "创建目录或从 repositoryGovernance.requiredAgentBoundaries 移除已废弃边界。"));
      continue;
    }
    if (!existsSync(agentsPath)) {
      findings.push(finding("agents_file_missing", "P1", normalizeRelativePath(path.join(boundary, "AGENTS.md")), null, "required responsibility boundary has no AGENTS.md", "补充继承根规则的精简 AGENTS.md，写明范围、约定和验证要求。"));
      continue;
    }
    const content = await readFile(agentsPath, "utf8").catch(() => "");
    if (!/^#\s+\S+/m.test(content) || content.trim().length < 40) {
      findings.push(finding("agents_file_incomplete", "P1", normalizeRelativePath(path.join(boundary, "AGENTS.md")), 1, "AGENTS.md is empty or lacks a top-level heading", "补充真实、可执行的目录级规则，避免空壳文档。"));
    }
  }
}

async function checkDocumentationPairs(rootDir, pairs, findings) {
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [left, right] = pair.map(normalizeRelativePath);
    const leftPath = path.join(rootDir, left);
    const rightPath = path.join(rootDir, right);
    if (!existsSync(leftPath) || !existsSync(rightPath)) {
      const missing = !existsSync(leftPath) ? left : right;
      findings.push(finding("documentation_pair_missing", "P1", missing, null, `${left} and ${right} must both exist`, "补齐成对用户文档。"));
      continue;
    }
    const leftCommands = extractCliFingerprints(await readFile(leftPath, "utf8"));
    const rightCommands = extractCliFingerprints(await readFile(rightPath, "utf8"));
    const missingRight = [...leftCommands].filter((command) => !rightCommands.has(command));
    const missingLeft = [...rightCommands].filter((command) => !leftCommands.has(command));
    if (missingRight.length > 0 || missingLeft.length > 0) {
      findings.push(finding(
        "documentation_command_drift",
        "P1",
        `${left} ↔ ${right}`,
        null,
        `CLI command fingerprints differ; missing in ${right}: ${missingRight.join(", ") || "none"}; missing in ${left}: ${missingLeft.join(", ") || "none"}`,
        "同步两份 README 的用户可执行命令；语言可不同，命令事实必须一致。",
      ));
    }
  }
}

async function checkDocumentationRequirements(rootDir, requirements, findings) {
  for (const requirement of Array.isArray(requirements) ? requirements : []) {
    const relativePath = normalizeRelativePath(requirement.path || "");
    if (!relativePath) continue;
    const absolutePath = path.join(rootDir, relativePath);
    if (!existsSync(absolutePath)) {
      findings.push(finding("documentation_required_file_missing", "P1", relativePath, null, "required documentation file does not exist", "恢复必需文档并补齐关键安全说明。"));
      continue;
    }
    const content = await readFile(absolutePath, "utf8");
    for (const pattern of stringList(requirement.requiredPatterns)) {
      if (safeRegex(pattern).test(content)) continue;
      findings.push(finding("documentation_required_marker_missing", "P1", relativePath, null, `required documentation marker is missing: ${pattern}`, "恢复用户必须看到的安装、升级或安全说明，并保持中英文对应。"));
    }
  }
}

async function checkPromptPackManifest(rootDir, findings) {
  const packDir = path.join(rootDir, "packs", "wildarrange-linear");
  const manifestPath = path.join(packDir, "manifest.json");
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const [kind, entries] of [["agents", manifest.agents], ["skills", manifest.skills]]) {
    for (const [name, relativePath] of Object.entries(entries || {})) {
      if (!existsSync(path.join(packDir, relativePath))) {
        findings.push(finding("prompt_manifest_target_missing", "P1", `packs/wildarrange-linear/${relativePath}`, null, `${kind}.${name} points to a missing file`, "修复 manifest 路径或恢复对应 Prompt/Skill 文件。"));
      }
    }
  }
  for (const [kind, relativePath] of [["tools", manifest.tools], ["routes", manifest.routes]]) {
    if (relativePath && !existsSync(path.join(packDir, relativePath))) {
      findings.push(finding("prompt_manifest_target_missing", "P1", `packs/wildarrange-linear/${relativePath}`, null, `${kind} points to a missing file`, "修复 manifest 路径或恢复对应文件。"));
    }
  }
  for (const [directory, entries] of [["agents", manifest.agents], ["skills", manifest.skills]]) {
    const registered = new Set(Object.values(entries || {}).map(normalizeRelativePath));
    const files = await readdir(path.join(packDir, directory), { withFileTypes: true }).catch(() => []);
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "README.md") continue;
      const relativePath = `${directory}/${entry.name}`;
      if (!registered.has(relativePath)) {
        findings.push(finding("prompt_file_unregistered", "P1", `packs/wildarrange-linear/${relativePath}`, null, `${relativePath} is not registered in manifest.json`, "登记文件或删除已废弃的 Prompt/Skill。"));
      }
    }
  }

  const routesPath = path.join(packDir, manifest.routes || "routes.json");
  if (!existsSync(routesPath)) return;
  const routes = JSON.parse(await readFile(routesPath, "utf8"));
  const registeredAgents = new Set(Object.keys(manifest.agents || {}));
  const registeredSkills = new Set(Object.keys(manifest.skills || {}));
  const expectedManifestAgents = new Set(["Router", ...LONG_LIVED_AGENTS]);
  for (const agent of expectedManifestAgents) {
    if (!registeredAgents.has(agent)) {
      findings.push(finding("fixed_agent_missing", "P1", "packs/wildarrange-linear/manifest.json", null, `fixed Agent/system node ${agent} is missing from manifest`, "恢复固定五 Agent 与 Router 系统节点；窄职责只能注册为 Skill。"));
    }
  }
  for (const agent of registeredAgents) {
    if (!expectedManifestAgents.has(agent)) {
      findings.push(finding("fixed_agent_extra", "P1", "packs/wildarrange-linear/manifest.json", null, `unexpected long-lived Agent ${agent} is registered`, "从 Agent 清单移除额外角色，并把窄职责收敛为固定 Agent 的 Skill。"));
    }
  }
  const routeEntries = [routes.defaults, routes.askGate, ...(routes.intents || []), ...(routes.domains || [])].filter(Boolean);
  const referencedAgents = new Set();
  const referencedSkills = new Set();
  for (const entry of routeEntries) {
    if (entry.primaryAgent) referencedAgents.add(entry.primaryAgent);
    for (const agent of entry.supportAgents || []) referencedAgents.add(agent);
    for (const skill of entry.skills || []) referencedSkills.add(skill);
  }
  for (const bundle of routes.planSkillBundles || routes.planAgentBundles || []) {
    if (bundle.name) referencedSkills.add(bundle.name);
  }
  for (const agent of referencedAgents) {
    if (!registeredAgents.has(agent)) {
      findings.push(finding("route_agent_unregistered", "P1", "packs/wildarrange-linear/routes.json", null, `route references unregistered Agent ${agent}`, "在 manifest 登记 Agent，或修正 routes 中的旧角色名。"));
    }
  }
  for (const agent of registeredAgents) {
    if (agent !== "Router" && !referencedAgents.has(agent)) {
      findings.push(finding("manifest_agent_unrouted", "P1", "packs/wildarrange-linear/manifest.json", null, `registered Agent ${agent} is absent from routes.json`, "为长期 Agent 补充明确路由，或将窄职责收敛为 Skill。"));
    }
  }
  for (const skill of referencedSkills) {
    if (!registeredSkills.has(skill)) {
      findings.push(finding("route_skill_unregistered", "P1", "packs/wildarrange-linear/routes.json", null, `route references unregistered Skill ${skill}`, "在 manifest 登记 Skill，或修正 routes 中的旧 Skill 名。"));
    }
  }

  const { config: effectiveConfig } = await loadHelixConfig(rootDir);
  const configuredAgents = new Set(Object.keys(effectiveConfig.agents || {}));
  for (const agent of configuredAgents) {
    if (!registeredAgents.has(agent)) {
      findings.push(finding("configured_agent_unregistered", "P1", "helix.config.json", null, `configured Agent ${agent} is absent from prompt-pack manifest`, "同步 Agent Prompt 与 manifest，或从长期 agents 配置移除该角色。"));
    }
    if (!LONG_LIVED_AGENTS.includes(agent)) {
      findings.push(finding("configured_agent_not_fixed", "P1", "helix.config.json", null, `configured Agent ${agent} is outside the fixed five-Agent set`, "只保留 Jiuwei、DiJiang、ZhuRong、BaiZe、LuWu；内部 profile 和临时子 Agent 不得进入长期 agents。"));
    }
  }
  for (const agent of LONG_LIVED_AGENTS) {
    if (!configuredAgents.has(agent) || !effectiveConfig.agents?.[agent] || typeof effectiveConfig.agents[agent] !== "object") {
      findings.push(finding("configured_fixed_agent_missing", "P1", "helix.config.json", null, `fixed Agent ${agent} is missing from root configuration`, "补齐固定五 Agent 的静态 provider/model/role 配置。"));
    }
  }
}

async function checkDocumentedCliCommands(rootDir, pairs, findings) {
  const binPath = path.join(rootDir, "bin", "helix.mjs");
  if (!existsSync(binPath)) return;
  let helpText = "";
  try {
    const result = await execFileAsync(process.execPath, [binPath, "--help"], {
      cwd: rootDir,
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
      encoding: "utf8",
    });
    helpText = `${result.stdout || ""}\n${result.stderr || ""}`;
  } catch (error) {
    findings.push(finding("cli_help_unavailable", "P1", "bin/helix.mjs", null, `failed to read real CLI help: ${error instanceof Error ? error.message : String(error)}`, "确保 `node ./bin/helix.mjs --help` 可在项目根无副作用运行并返回命令清单。"));
    return;
  }
  const implemented = extractCliFingerprints(helpText);
  const documentationPaths = new Set((Array.isArray(pairs) ? pairs : []).flat().map(normalizeRelativePath));
  for (const documentationPath of documentationPaths) {
    const absolutePath = path.join(rootDir, documentationPath);
    if (!existsSync(absolutePath)) continue;
    const documented = extractCliFingerprints(await readFile(absolutePath, "utf8"));
    for (const command of documented) {
      if (implemented.has(command)) continue;
      findings.push(finding("documented_cli_unknown", "P1", documentationPath, null, `documented CLI command is absent from bin/helix.mjs --help: ${command}`, "修正文档命令，或先在 CLI 实现并登记该命令。"));
    }
  }
}

async function checkArchitectureLedgers(rootDir, ledgerPaths, findings) {
  const paths = normalizeList(ledgerPaths);
  if (paths.length === 0) return;
  const contents = [];
  for (const ledgerPath of paths) {
    const absolutePath = path.join(rootDir, ledgerPath);
    if (!existsSync(absolutePath)) {
      findings.push(finding("architecture_ledger_missing", "P1", ledgerPath, null, "configured architecture ledger does not exist", "恢复台账文档，或从 architectureLedgers 移除已废弃路径。"));
      continue;
    }
    contents.push(await readFile(absolutePath, "utf8"));
  }
  const combined = contents.join("\n");
  const sourceFiles = await collectGovernedFiles(rootDir, ["src/interface", "src/orchestration", "src/ai", "src/capabilities", "src/infra"], DEFAULT_IGNORED);
  for (const sourcePath of sourceFiles.filter((filePath) => filePath.endsWith(".mjs"))) {
    if (!combined.includes(sourcePath)) {
      findings.push(finding("architecture_module_unlisted", "P1", sourcePath, null, "runtime module is absent from configured architecture ledgers", "在 AGENTS.md 或 project-architecture.md 登记模块职责。"));
    }
  }
  for (const match of combined.matchAll(/`(src\/(?:interface|orchestration|ai|capabilities|infra)\/[a-z0-9./-]+\.mjs)`/g)) {
    if (!existsSync(path.join(rootDir, match[1]))) {
      findings.push(finding("architecture_module_missing", "P1", match[1], null, "architecture ledger references a missing runtime module", "修正过期路径，或恢复台账声明的模块。"));
    }
  }
}

async function checkNaming(rootDir, governedRoots, naming, ignored, findings) {
  if (!naming.directories && !naming.sourceFiles) return;
  const exceptions = new Set(naming.exceptions || []);
  for (const governedRoot of governedRoots) {
    await walk(rootDir, governedRoot, ignored, async (relativePath, entry) => {
      if (exceptions.has(entry.name)) return;
      if (entry.isDirectory() && naming.directories === "kebab-case" && !isKebabCase(entry.name)) {
        findings.push(finding("directory_naming", "P2", relativePath, null, "directory name is not kebab-case", "按项目命名政策重命名，或把合法例外加入 naming.exceptions。"));
      }
      if (entry.isFile() && naming.sourceFiles === "kebab-case.mjs" && entry.name.endsWith(".mjs")) {
        const stem = entry.name.slice(0, -4);
        if (!isKebabSourceStem(stem)) {
          findings.push(finding("source_file_naming", "P2", relativePath, null, "source file name is not kebab-case.mjs", "按项目命名政策重命名并更新引用，或登记合法例外。"));
        }
      }
    });
  }
}

async function checkChangedPathNaming(rootDir, changedPaths, governedRoots, naming, findings) {
  if (!naming.directories && !naming.sourceFiles) return;
  const exceptions = new Set(naming.exceptions || []);
  for (const filePath of changedPaths) {
    if (!existsSync(path.join(rootDir, filePath))) continue;
    const governedRoot = governedRoots.find((candidate) => pathIsWithin(filePath, candidate));
    if (!governedRoot) continue;
    const relativeToRoot = path.relative(governedRoot, filePath);
    const segments = normalizeRelativePath(relativeToRoot).split("/").filter(Boolean);
    for (let index = 0; index < segments.length - 1; index += 1) {
      const directoryName = segments[index];
      if (exceptions.has(directoryName)) continue;
      if (naming.directories === "kebab-case" && !isKebabCase(directoryName)) {
        const directoryPath = normalizeRelativePath(path.join(governedRoot, ...segments.slice(0, index + 1)));
        findings.push(finding("directory_naming", "P2", directoryPath, null, "directory name is not kebab-case", "按项目命名政策重命名，或把合法例外加入 naming.exceptions。"));
      }
    }
    const fileName = segments.at(-1) || "";
    if (!exceptions.has(fileName) && naming.sourceFiles === "kebab-case.mjs" && fileName.endsWith(".mjs")) {
      const stem = fileName.slice(0, -4);
      if (!isKebabSourceStem(stem)) {
        findings.push(finding("source_file_naming", "P2", filePath, null, "source file name is not kebab-case.mjs", "按项目命名政策重命名并更新引用，或登记合法例外。"));
      }
    }
  }
}

async function checkCommentRules(rootDir, candidateFiles, rules, findings) {
  for (const filePath of candidateFiles) {
    const matchedRules = rules.filter((rule) => normalizeList(rule.globs).some((glob) => pathMatchesPattern(filePath, glob)));
    if (matchedRules.length === 0 || !existsSync(path.join(rootDir, filePath))) continue;
    const content = await readFile(path.join(rootDir, filePath), "utf8").catch(() => null);
    if (content === null) continue;
    const comments = extractComments(filePath, content);
    for (const rule of matchedRules) {
      for (const pattern of stringList(rule.blockedPatterns)) {
        const regex = safeRegex(pattern);
        for (const comment of comments.filter((item) => regex.test(item.text))) {
          findings.push(finding("comment_pattern_blocked", "P1", filePath, comment.line, `comment matches blocked pattern ${pattern}: ${comment.text.trim().slice(0, 180)}`, "删除占位/署名注释，或把真实待办转成可追踪任务。"));
        }
      }
      for (const pattern of stringList(rule.requiredPatterns)) {
        const regex = safeRegex(pattern);
        if (!comments.some((comment) => regex.test(comment.text))) {
          findings.push(finding("comment_pattern_required", "P1", filePath, 1, `matching files require a comment containing ${pattern}`, "补充机器政策要求的维护注释，或修正规则 glob。"));
        }
      }
    }
  }
}

export function extractComments(filePath, content) {
  const extension = path.extname(filePath).toLowerCase();
  if (SOURCE_EXTENSIONS.has(extension) || extension === ".css" || extension === ".rs") {
    return extractSlashComments(content);
  }
  if ([".py", ".rb", ".sh", ".yaml", ".yml"].includes(extension)) {
    return extractHashComments(content);
  }
  if (extension === ".html" || extension === ".md") {
    return extractDelimitedComments(content, "<!--", "-->");
  }
  return [];
}

function extractSlashComments(content) {
  const comments = [];
  let line = 1;
  let index = 0;
  let state = "code";
  let startLine = 1;
  let buffer = "";
  let regexInClass = false;
  const templateReturnStates = [];
  const templateExpressions = [];
  while (index < content.length) {
    const char = content[index];
    const next = content[index + 1];
    if (state === "line") {
      if (char === "\n") {
        comments.push({ line: startLine, text: buffer });
        buffer = "";
        state = "code";
        line += 1;
      } else {
        buffer += char;
      }
      index += 1;
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        comments.push({ line: startLine, text: buffer });
        buffer = "";
        state = "code";
        index += 2;
      } else {
        buffer += char;
        if (char === "\n") line += 1;
        index += 1;
      }
      continue;
    }
    if (state === "single" || state === "double") {
      const delimiter = state === "single" ? "'" : "\"";
      if (char === "\\") {
        if (next === "\n") line += 1;
        index += 2;
      } else {
        if (char === delimiter) state = "code";
        if (char === "\n") line += 1;
        index += 1;
      }
      continue;
    }
    if (state === "regex") {
      if (char === "\\") {
        index += 2;
      } else if (char === "[" && !regexInClass) {
        regexInClass = true;
        index += 1;
      } else if (char === "]" && regexInClass) {
        regexInClass = false;
        index += 1;
      } else if (char === "/" && !regexInClass) {
        state = "code";
        index += 1;
        while (/[a-z]/i.test(content[index] || "")) index += 1;
      } else {
        if (char === "\n") {
          line += 1;
          state = "code";
          regexInClass = false;
        }
        index += 1;
      }
      continue;
    }
    if (state === "template") {
      if (char === "\\") {
        if (next === "\n") line += 1;
        index += 2;
      } else if (char === "`") {
        state = templateReturnStates.pop() || "code";
        index += 1;
      } else if (char === "$" && next === "{") {
        templateExpressions.push({ braceDepth: 1 });
        state = "code";
        index += 2;
      } else {
        if (char === "\n") line += 1;
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      state = char === "'" ? "single" : "double";
      index += 1;
    } else if (char === "`") {
      templateReturnStates.push("code");
      state = "template";
      index += 1;
    } else if (char === "/" && next === "/") {
      state = "line";
      startLine = line;
      index += 2;
    } else if (char === "/" && next === "*") {
      state = "block";
      startLine = line;
      index += 2;
    } else if (char === "/" && canStartRegex(content, index)) {
      state = "regex";
      regexInClass = false;
      index += 1;
    } else if (templateExpressions.length > 0 && char === "{") {
      templateExpressions.at(-1).braceDepth += 1;
      index += 1;
    } else if (templateExpressions.length > 0 && char === "}") {
      const expression = templateExpressions.at(-1);
      expression.braceDepth -= 1;
      index += 1;
      if (expression.braceDepth === 0) {
        templateExpressions.pop();
        state = "template";
      }
    } else {
      if (char === "\n") line += 1;
      index += 1;
    }
  }
  if (state === "line" && buffer) comments.push({ line: startLine, text: buffer });
  if (state === "block" && buffer) comments.push({ line: startLine, text: buffer });
  return comments;
}

function canStartRegex(content, slashIndex) {
  let cursor = slashIndex - 1;
  while (cursor >= 0 && /\s/.test(content[cursor])) cursor -= 1;
  if (cursor < 0) return true;
  if ("([{=,:;!?&|+-*%^~<>".includes(content[cursor])) return true;
  let end = cursor + 1;
  while (cursor >= 0 && /[A-Za-z0-9_$]/.test(content[cursor])) cursor -= 1;
  const previousWord = content.slice(cursor + 1, end);
  return /^(?:return|case|throw|typeof|instanceof|in|of|yield|await|delete|void|new)$/.test(previousWord);
}

function extractHashComments(content) {
  const comments = [];
  content.split(/\r?\n/).forEach((line, index) => {
    let quote = null;
    for (let cursor = 0; cursor < line.length; cursor += 1) {
      const char = line[cursor];
      if (char === "\\" && quote) {
        cursor += 1;
        continue;
      }
      if ((char === "'" || char === "\"") && (!quote || quote === char)) {
        quote = quote ? null : char;
        continue;
      }
      if (char === "#" && !quote && !(index === 0 && cursor === 0 && line.startsWith("#!"))) {
        comments.push({ line: index + 1, text: line.slice(cursor + 1) });
        break;
      }
    }
  });
  return comments;
}

function extractDelimitedComments(content, open, close) {
  const comments = [];
  let cursor = 0;
  while (cursor < content.length) {
    const start = content.indexOf(open, cursor);
    if (start < 0) break;
    const end = content.indexOf(close, start + open.length);
    const finish = end < 0 ? content.length : end;
    comments.push({
      line: content.slice(0, start).split(/\r?\n/).length,
      text: content.slice(start + open.length, finish),
    });
    cursor = finish + close.length;
  }
  return comments;
}

async function collectGovernedFiles(rootDir, governedRoots, ignored) {
  const files = [];
  for (const governedRoot of governedRoots) {
    await walk(rootDir, governedRoot, ignored, async (relativePath, entry) => {
      if (entry.isFile()) files.push(relativePath);
    });
  }
  return [...new Set(files)].sort();
}

async function walk(rootDir, relativeDir, ignored, visitor) {
  const absoluteDir = path.join(rootDir, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const relativePath = normalizeRelativePath(path.join(relativeDir, entry.name));
    await visitor(relativePath, entry);
    if (entry.isDirectory()) await walk(rootDir, relativePath, ignored, visitor);
  }
}

function extractCliFingerprints(content) {
  const commands = new Set();
  const commandPattern = /(?:node\s+\.\/bin\/helix\.mjs|npx\s+wildarrange|(?<![@/A-Za-z0-9_-])wildarrange)\s+([a-z-]+)(?:[ \t]+(?!-{1,2})([a-z-]+))?/g;
  for (const line of content.split(/\r?\n/)) {
    for (const match of line.matchAll(commandPattern)) {
      commands.add([match[1], match[2]].filter(Boolean).join(" "));
    }
  }
  return commands;
}

function safeRegex(pattern) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

function isKebabCase(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isKebabSourceStem(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.(?:test|spec|config))?$/.test(value);
}

function normalizeList(value) {
  return Array.isArray(value) ? value.map((item) => normalizeRelativePath(String(item))).filter(Boolean) : [];
}

function pathIsWithin(filePath, directoryPath) {
  const normalizedFile = normalizeRelativePath(filePath).replace(/\/$/, "");
  const normalizedDirectory = normalizeRelativePath(directoryPath).replace(/\/$/, "");
  return normalizedFile === normalizedDirectory || normalizedFile.startsWith(`${normalizedDirectory}/`);
}

function stringList(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function finding(ruleId, severity, filePath, line, evidence, requiredFix) {
  return {
    ruleId,
    severity,
    path: normalizeRelativePath(filePath),
    line,
    evidence,
    requiredFix,
  };
}

function stableFindingId(findingValue) {
  const digest = createHash("sha256")
    .update(`${findingValue.ruleId}\0${findingValue.path}\0${findingValue.line || 0}\0${findingValue.evidence}`)
    .digest("hex")
    .slice(0, 12);
  return `RG-${digest}`;
}
