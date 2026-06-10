import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const HELIX_DIR = ".helix";
export const STATE_VERSION = 1;
export const TASK_STATUSES = new Set(["pending", "in_progress", "verifying", "completed", "failed", "review_blocked", "needs_user_decision"]);
export const HELIX_CONFIG_FILE = "helix.config.json";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.dirname(MODULE_DIR);
export const DEFAULT_PROMPT_PACK_DIR = path.join(PROJECT_DIR, "packs", "omo-linear");
const LOCK_RETRY_MS = 50;
const LOCK_WAIT_TIMEOUT_MS = 15_000;
const LOCK_STALE_AFTER_MS = 300_000;

export const DEFAULT_HELIX_CONFIG = {
  version: 1,
  runtime: "helix-linear",
  adapters: {
    codex: { enabled: true, hookMode: "cli-adapter" },
    cursor: { enabled: true, hookMode: "cli-adapter" },
  },
  modelProviders: {
    openai: { apiKeyEnv: "OPENAI_API_KEY", baseUrlEnv: "OPENAI_BASE_URL" },
    deepseek: { apiKeyEnv: "DEEPSEEK_API_KEY", baseUrlEnv: "DEEPSEEK_BASE_URL" },
    gemini: { apiKeyEnv: "GEMINI_API_KEY", baseUrlEnv: "GEMINI_BASE_URL" },
    kimi: { apiKeyEnv: "KIMI_API_KEY", baseUrlEnv: "KIMI_BASE_URL" },
  },
  agents: {
    Sisyphus: { role: "lead_orchestrator", provider: "openai", model: "gpt-5.5", reasoning: "high" },
    Atlas: { role: "linear_executor", provider: "openai", model: "gpt-5.5", reasoning: "medium" },
    Hephaestus: { role: "implementation_worker", provider: "openai", model: "gpt-5.5", reasoning: "medium" },
    Oracle: { role: "goal_verifier", provider: "openai", model: "gpt-5.5", reasoning: "high" },
    Librarian: { role: "external_research", provider: "deepseek", model: "deepseek-v4-pro" },
    Explore: { role: "fast_explorer", provider: "deepseek", model: "deepseek-v4-flash" },
    Metis: { role: "risk_reviewer", provider: "openai", model: "gpt-5.5", reasoning: "medium" },
    Momus: { role: "skeptical_reviewer", provider: "openai", model: "gpt-5.5", reasoning: "xhigh" },
  },
  dynamicAgents: {
    "visual-engineering": { provider: "gemini", model: "gemini-3.1-pro" },
    ultrabrain: { provider: "openai", model: "gpt-5.5", reasoning: "xhigh" },
    artistry: { provider: "gemini", model: "gemini-3.1-pro" },
    quick: { provider: "deepseek", model: "deepseek-v4-flash" },
    deep: { provider: "openai", model: "gpt-5.5", reasoning: "medium" },
    writing: { provider: "kimi", model: "kimi-2.6" },
    git: { provider: "deepseek", model: "deepseek-v4-flash" },
  },
  ruleInjection: {
    mode: "both",
    maxRuleChars: 12000,
    maxResultChars: 40000,
    dynamicMaxRuleChars: 4000,
    dynamicMaxResultChars: 10000,
    projectSingleFiles: ["AGENTS.md", "CLAUDE.md", "CONTEXT.md", ".github/copilot-instructions.md"],
    projectRuleDirs: [".omo/rules", ".claude/rules", ".cursor/rules", ".github/instructions"],
  },
  injectionPoints: {
    session_start: {
      enabled: true,
      tools: ["helix_resume", "helix_rules_collect", "helix_context_build"],
      markdown: [".helix/snapshots/context.md", ".helix/rules/context.md"],
      skills: ["omo-injection-runtime", "start-work", "hf-recall"],
      rules: { mode: "static" },
    },
    user_prompt_submit: {
      enabled: true,
      tools: ["helix_route", "helix_rules_collect"],
      markdown: [".helix/snapshots/context.md", ".helix/rules/context.md"],
      skills: ["omo-injection-runtime", "hf-ideate", "hf-plan", "review-work"],
      rules: { mode: "static" },
    },
    pre_tool_use: {
      enabled: true,
      tools: ["scope_guard", "helix_rules_collect"],
      markdown: [".helix/rules/context.md"],
      skills: ["omo-injection-runtime"],
      rules: { mode: "dynamic_blocker" },
    },
    post_tool_use: {
      enabled: true,
      tools: ["helix_rules_collect", "scope_guard"],
      markdown: [".helix/rules/context.md"],
      skills: [],
      rules: { mode: "dynamic" },
    },
    post_compact: {
      enabled: true,
      tools: ["helix_resume", "helix_rules_collect"],
      markdown: [".helix/snapshots/context.md", ".helix/rules/context.md"],
      skills: ["omo-injection-runtime", "hf-recall"],
      rules: { mode: "recovery_marker" },
    },
    before_execute: {
      enabled: true,
      tools: ["helix_context_build", "helix_node", "scope_guard"],
      markdown: [".helix/context-agents/Atlas-{taskId}.md", ".helix/rules/context.md"],
      skills: ["omo-injection-runtime", "programming", "debugging", "refactor"],
      rules: { mode: "dynamic" },
    },
    before_review: {
      enabled: true,
      tools: ["helix_context_build", "helix_evidence_record", "review_gate"],
      markdown: [".helix/context-agents/Oracle-{taskId}.md", ".helix/context-agents/Momus-{taskId}.md", ".helix/context-agents/Metis-{taskId}.md", ".helix/rules/context.md"],
      skills: ["omo-injection-runtime", "review-work", "hf-review", "visual-qa"],
      rules: { mode: "dynamic" },
    },
    before_checkpoint: {
      enabled: true,
      tools: ["helix_evidence_record", "review_gate", "helix_summary"],
      markdown: [".helix/reports/reviews/{planId}-{taskId}.md", ".helix/rules/context.md"],
      skills: ["omo-injection-runtime", "hf-test", "review-work"],
      rules: { mode: "dynamic" },
    },
    stop: {
      enabled: true,
      tools: ["helix_continuation_check", "helix_resume"],
      markdown: [".helix/sessions/continuation.md", ".helix/snapshots/context.md"],
      skills: ["omo-injection-runtime", "start-work"],
      rules: { mode: "static" },
    },
  },
};

export function nowIso() {
  return new Date().toISOString();
}

export function createWorkId(prefix = "work") {
  return `${prefix}_${randomUUID()}`;
}

export function resolveHelixPath(rootDir, ...segments) {
  return path.join(rootDir, HELIX_DIR, ...segments);
}

export async function ensureHelixDirs(rootDir) {
  const dirs = [
    [],
    ["plans"],
    ["team"],
    ["team", "inbox"],
    ["team", "outbox"],
    ["sessions"],
    ["snapshots"],
    ["artifacts"],
    ["adapters"],
    ["adapters", "codex"],
    ["adapters", "cursor"],
    ["checkpoints"],
    ["reports"],
    ["reports", "failures"],
    ["reports", "reviews"],
    ["rules"],
    ["wisdom"],
    ["changes"],
    ["context-agents"],
  ];

  for (const dir of dirs) {
    await mkdir(resolveHelixPath(rootDir, ...dir), { recursive: true });
  }
}

export async function readJson(filePath, fallback = undefined) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (fallback !== undefined && error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function loadHelixConfig(rootDir) {
  const rootConfigPath = path.join(rootDir, HELIX_CONFIG_FILE);
  const runtimeConfigPath = resolveHelixPath(rootDir, "config.json");
  const rootConfig = await readJson(rootConfigPath, null);
  const runtimeConfig = await readJson(runtimeConfigPath, null);
  const sourcePath = rootConfig ? rootConfigPath : runtimeConfig ? runtimeConfigPath : null;
  const config = deepMerge(DEFAULT_HELIX_CONFIG, runtimeConfig || {});
  return {
    config: deepMerge(config, rootConfig || {}),
    sourcePath: sourcePath ? path.relative(rootDir, sourcePath) : "default",
  };
}

export async function writeDefaultHelixConfig(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const targetPath = options.root === true ? path.join(rootDir, HELIX_CONFIG_FILE) : resolveHelixPath(rootDir, "config.json");
  if (!options.force && existsSync(targetPath)) {
    return { path: path.relative(rootDir, targetPath), created: false, config: await readJson(targetPath) };
  }
  await writeJsonAtomic(targetPath, DEFAULT_HELIX_CONFIG);
  await appendLedger(rootDir, { type: "config_written", configPath: path.relative(rootDir, targetPath), root: options.root === true });
  return { path: path.relative(rootDir, targetPath), created: true, config: DEFAULT_HELIX_CONFIG };
}

export async function installAdapter(rootDir, options = {}) {
  await initRuntime(rootDir);
  const target = options.target || "all";
  const mode = options.mode || "local";
  const packageName = options.packageName || options.package || "helixflow";
  const hookCommand = adapterHookCommand({ mode, packageName });
  const outputs = [];
  const backupId = createAdapterBackupId("install");

  if (target === "all" || target === "codex") {
    const codexHooks = buildCodexHooksConfig(hookCommand);
    const codexPath = resolveHelixPath(rootDir, "adapters", "codex", "hooks.json");
    const backup = await backupExistingAdapterFile(rootDir, codexPath, backupId);
    await writeJsonAtomic(codexPath, codexHooks);
    outputs.push({ target: "codex", path: path.relative(rootDir, codexPath), status: "generated", backup });
  }

  if (target === "all" || target === "cursor") {
    const cursorDir = path.join(rootDir, ".cursor", "rules");
    await mkdir(cursorDir, { recursive: true });
    const cursorRulePath = path.join(cursorDir, "helixflow.mdc");
    const cursorRuleBackup = await backupExistingAdapterFile(rootDir, cursorRulePath, backupId);
    await writeFile(cursorRulePath, renderCursorRule({ hookCommand }), "utf8");
    const cursorReadmePath = resolveHelixPath(rootDir, "adapters", "cursor", "README.md");
    const cursorReadmeBackup = await backupExistingAdapterFile(rootDir, cursorReadmePath, backupId);
    await writeFile(cursorReadmePath, renderCursorAdapterReadme({ hookCommand }), "utf8");
    outputs.push({ target: "cursor", path: path.relative(rootDir, cursorRulePath), status: "generated", backup: cursorRuleBackup });
    outputs.push({ target: "cursor", path: path.relative(rootDir, cursorReadmePath), status: "generated", backup: cursorReadmeBackup });
  }

  if (!["all", "codex", "cursor"].includes(target)) {
    throw new Error("adapter target must be all, codex, or cursor");
  }

  const report = {
    kind: "helix_adapter_install",
    version: STATE_VERSION,
    at: nowIso(),
    target,
    mode,
    packageName,
    hookCommand,
    backupId,
    outputs,
  };
  const reportJsonPath = resolveHelixPath(rootDir, "adapters", "install-report.json");
  const reportMdPath = resolveHelixPath(rootDir, "adapters", "install-report.md");
  report.reportJsonPath = path.relative(rootDir, reportJsonPath);
  report.reportMdPath = path.relative(rootDir, reportMdPath);
  await writeJsonAtomic(reportJsonPath, report);
  await writeFile(reportMdPath, renderAdapterInstallReport(report), "utf8");
  await appendLedger(rootDir, { type: "adapter_installed", target, mode, packageName, outputCount: outputs.length });
  return report;
}

export async function uninstallAdapter(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const target = options.target || "all";
  if (!["all", "codex", "cursor"].includes(target)) {
    throw new Error("adapter target must be all, codex, or cursor");
  }

  const backupId = createAdapterBackupId("uninstall");
  const outputs = [];
  const candidates = [];
  if (target === "all" || target === "codex") {
    candidates.push({ target: "codex", path: resolveHelixPath(rootDir, "adapters", "codex", "hooks.json") });
  }
  if (target === "all" || target === "cursor") {
    candidates.push({ target: "cursor", path: path.join(rootDir, ".cursor", "rules", "helixflow.mdc") });
    candidates.push({ target: "cursor", path: resolveHelixPath(rootDir, "adapters", "cursor", "README.md") });
  }

  for (const candidate of candidates) {
    const relativePath = path.relative(rootDir, candidate.path);
    if (!existsSync(candidate.path)) {
      outputs.push({ target: candidate.target, path: relativePath, status: "missing" });
      continue;
    }
    const backup = await backupExistingAdapterFile(rootDir, candidate.path, backupId);
    await unlink(candidate.path);
    outputs.push({ target: candidate.target, path: relativePath, status: "removed", backup });
  }

  const report = {
    kind: "helix_adapter_uninstall",
    version: STATE_VERSION,
    at: nowIso(),
    target,
    backupId,
    outputs,
  };
  const reportJsonPath = resolveHelixPath(rootDir, "adapters", "uninstall-report.json");
  const reportMdPath = resolveHelixPath(rootDir, "adapters", "uninstall-report.md");
  report.reportJsonPath = path.relative(rootDir, reportJsonPath);
  report.reportMdPath = path.relative(rootDir, reportMdPath);
  await writeJsonAtomic(reportJsonPath, report);
  await writeFile(reportMdPath, renderAdapterUninstallReport(report), "utf8");
  await appendLedger(rootDir, { type: "adapter_uninstalled", target, outputCount: outputs.length });
  return report;
}

function createAdapterBackupId(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function backupExistingAdapterFile(rootDir, filePath, backupId) {
  if (!existsSync(filePath)) return null;
  const relativePath = path.relative(rootDir, filePath);
  const backupPath = resolveHelixPath(rootDir, "adapters", "backups", backupId, relativePath);
  await mkdir(path.dirname(backupPath), { recursive: true });
  await copyFile(filePath, backupPath);
  return path.relative(rootDir, backupPath);
}

function adapterHookCommand({ mode, packageName }) {
  if (mode === "npx") return `npx -y ${packageName} hook run`;
  if (mode !== "local") throw new Error("adapter mode must be local or npx");
  return `node "${path.join(PROJECT_DIR, "bin", "helix.mjs")}" hook run`;
}

function buildCodexHooksConfig(command) {
  const hook = (timeout, statusMessage) => ({ type: "command", command, timeout, statusMessage });
  return {
    hooks: {
      SessionStart: [{ hooks: [hook(10, "HelixFlow: Loading governance context")] }],
      UserPromptSubmit: [{ hooks: [hook(10, "HelixFlow: Routing and loading governance context")] }],
      PreToolUse: [{
        matcher: "^(apply_patch|write|Write|edit|Edit|multi_edit|multiedit|MultiEdit|create_goal)$",
        hooks: [hook(10, "HelixFlow: Checking planned scope before tool use")],
      }],
      PostToolUse: [{
        matcher: "^(apply_patch|write|Write|edit|Edit|multi_edit|multiedit|MultiEdit)$",
        hooks: [hook(10, "HelixFlow: Matching project rules after tool use")],
      }],
      PostCompact: [{
        matcher: "manual|auto",
        hooks: [hook(10, "HelixFlow: Rehydrating governance context after compaction")],
      }],
      Stop: [{ hooks: [hook(10, "HelixFlow: Checking continuation state")] }],
      SubagentStop: [{ hooks: [hook(10, "HelixFlow: Checking continuation state")] }],
    },
  };
}

function renderCursorRule({ hookCommand }) {
  return `---
alwaysApply: true
---
# HelixFlow Governance Runtime

This project uses HelixFlow for local agent governance.

Required behavior:

- Before planning or implementing, run \`${hookCommand}\` with a \`UserPromptSubmit\` payload when available.
- Before editing files for a HelixFlow task, verify task scope with \`node ./bin/helix.mjs guard scope --task <taskId>\` or \`node ./bin/helix.mjs hook run\` using a \`PreToolUse\` payload.
- Treat worker completion as a claim only. Completion requires verifier, scope guard, review gate, success criteria evidence, and checkpoint.
- Do not weaken \`verify_commands\`, \`review_commands\`, \`standards_commands\`, project rules, or \`successCriteria\` to manufacture PASS.
- If Cursor cannot execute lifecycle hooks automatically, run \`node ./bin/helix.mjs continuation check\` before stopping a task.
`;
}

function renderCursorAdapterReadme({ hookCommand }) {
  return `# HelixFlow Cursor Adapter

Cursor does not provide the same Codex plugin hook lifecycle in this runtime, so this adapter installs a persistent Cursor rule at \`.cursor/rules/helixflow.mdc\`.

Hook command for manual or future adapter use:

\`\`\`bash
${hookCommand}
\`\`\`

This gives Cursor the same governance contract, but hard blocking depends on Cursor exposing a lifecycle hook API. Codex can use the generated hooks JSON under \`.helix/adapters/codex/hooks.json\`.
`;
}

function renderAdapterInstallReport(report) {
  const lines = [
    "# HelixFlow Adapter Install Report",
    "",
    `Generated: ${report.at}`,
    `Target: ${report.target}`,
    `Mode: ${report.mode}`,
    `Package: ${report.packageName}`,
    "",
    "## Hook Command",
    "",
    "```bash",
    report.hookCommand,
    "```",
    "",
    "## Outputs",
    "",
  ];
  for (const output of report.outputs) {
    lines.push(`- ${output.target}: ${output.path} (${output.status}${output.backup ? `, backup: ${output.backup}` : ""})`);
  }
  lines.push("");
  lines.push("## Install Model");
  lines.push("");
  lines.push("- Recommended user entry: `npx helixflow@latest init` or `npx helixflow@latest adapter install`.");
  lines.push("- Recommended persistent project setup after publish: add `helixflow` as a devDependency so hook commands do not require network access.");
  return `${lines.join("\n")}\n`;
}

function renderAdapterUninstallReport(report) {
  const lines = [
    "# HelixFlow Adapter Uninstall Report",
    "",
    `Generated: ${report.at}`,
    `Target: ${report.target}`,
    `Backup ID: ${report.backupId}`,
    "",
    "## Outputs",
    "",
  ];
  for (const output of report.outputs) {
    lines.push(`- ${output.target}: ${output.path} (${output.status}${output.backup ? `, backup: ${output.backup}` : ""})`);
  }
  lines.push("");
  lines.push("Removed files were copied under `.helix/adapters/backups/` before deletion when they existed.");
  return `${lines.join("\n")}\n`;
}

function deepMerge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(value) && isPlainObject(result[key]) ? deepMerge(result[key], value) : value;
  }
  return result;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function lockOwnerContent(ownerTag) {
  return `${ownerTag}\n${process.pid}\n${Date.now()}\n`;
}

function parseLockOwner(content) {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 3) return null;
  const ownerPid = Number.parseInt(lines[1], 10);
  const acquiredAt = Number.parseInt(lines[2], 10);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) return null;
  if (!Number.isInteger(acquiredAt) || acquiredAt <= 0) return null;
  return { ownerPid, acquiredAt };
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isStaleLock(lockPath) {
  try {
    const content = await readFile(lockPath, "utf8");
    const owner = parseLockOwner(content);
    if (!owner) return false;
    if (isPidAlive(owner.ownerPid)) return false;
    return Date.now() - owner.acquiredAt > LOCK_STALE_AFTER_MS;
  } catch {
    return false;
  }
}

async function removeLock(lockPath) {
  await unlink(lockPath).catch(() => undefined);
}

export async function withTaskStateLock(rootDir, ownerTag, fn) {
  await ensureHelixDirs(rootDir);
  const lockPath = resolveHelixPath(rootDir, "team", "tasks.lock");
  const startedAt = Date.now();

  for (;;) {
    if (Date.now() - startedAt > LOCK_WAIT_TIMEOUT_MS) {
      throw new Error(`timed out acquiring task state lock: ${path.relative(rootDir, lockPath)}`);
    }

    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(lockOwnerContent(ownerTag));
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await isStaleLock(lockPath)) {
        await removeLock(lockPath);
        continue;
      }
      await delay(LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await removeLock(lockPath);
  }
}

export async function appendLedger(rootDir, event) {
  const entry = {
    id: createWorkId("evt"),
    at: nowIso(),
    ...event,
  };
  await appendFile(resolveHelixPath(rootDir, "ledger.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export async function writeSnapshot(rootDir, stage, payload = {}) {
  await ensureHelixDirs(rootDir);
  const snapshot = {
    version: STATE_VERSION,
    id: createWorkId("snap"),
    stage,
    at: nowIso(),
    work: await readJson(resolveHelixPath(rootDir, "work.json"), null),
    taskState: await loadTaskState(rootDir),
    payload,
  };
  const fileName = `${snapshot.at.replaceAll(":", "-")}-${stage}.json`;
  const snapshotPath = resolveHelixPath(rootDir, "snapshots", fileName);
  await writeJsonAtomic(snapshotPath, snapshot);
  await writeJsonAtomic(resolveHelixPath(rootDir, "snapshots", "latest.json"), snapshot);
  await writeContextSnapshot(rootDir, { reason: `snapshot:${stage}`, latestSnapshot: snapshot });
  await appendLedger(rootDir, { type: "snapshot_written", stage, snapshotPath: path.relative(rootDir, snapshotPath) });
  return snapshot;
}

export async function initRuntime(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const configResult = await writeDefaultHelixConfig(rootDir, { force: options.force });
  const { config } = await loadHelixConfig(rootDir);

  const agentsPath = resolveHelixPath(rootDir, "agents.json");
  if (!existsSync(agentsPath) || options.force) {
    await writeJsonAtomic(agentsPath, {
      version: STATE_VERSION,
      agents: config.agents,
    });
  }

  const categoriesPath = resolveHelixPath(rootDir, "categories.json");
  if (!existsSync(categoriesPath) || options.force) {
    await writeJsonAtomic(categoriesPath, {
      version: STATE_VERSION,
      categories: {
        quick: { ...(config.dynamicAgents?.quick || {}), purpose: "small low-risk tasks" },
        deep: { ...(config.dynamicAgents?.deep || {}), purpose: "multi-file implementation" },
        ultrabrain: { ...(config.dynamicAgents?.ultrabrain || {}), purpose: "hard reasoning" },
        "visual-engineering": { ...(config.dynamicAgents?.["visual-engineering"] || {}), purpose: "ui and visual verification" },
      },
    });
  }

  const workPath = resolveHelixPath(rootDir, "work.json");
  if (!existsSync(workPath) || options.force) {
    await writeJsonAtomic(workPath, {
      version: STATE_VERSION,
      workId: createWorkId(),
      stage: "initialized",
      activePlanId: null,
      status: "idle",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  }

  await installPromptPack(rootDir, options.promptPackDir || DEFAULT_PROMPT_PACK_DIR);
  await appendLedger(rootDir, { type: "runtime_initialized", configPath: configResult.path });
  await writeSnapshot(rootDir, "initialized");
  return readJson(workPath);
}

export async function installPromptPack(rootDir, packDir = DEFAULT_PROMPT_PACK_DIR) {
  const manifest = await readJson(path.join(packDir, "manifest.json"));
  const entries = await loadPromptPackEntries(packDir, manifest);
  const registry = {
    version: STATE_VERSION,
    installedAt: nowIso(),
    name: manifest.name,
    description: manifest.description,
    source: manifest.source,
    packDir,
    agents: Object.fromEntries(entries.agents.map((entry) => [entry.name, registryEntry(entry)])),
    skills: Object.fromEntries(entries.skills.map((entry) => [entry.name, registryEntry(entry)])),
    tools: registryEntry(entries.tools),
    routes: entries.routes ? registryEntry(entries.routes) : null,
  };
  await writeJsonAtomic(resolveHelixPath(rootDir, "prompt-pack.json"), registry);
  return registry;
}

function registryEntry(entry) {
  return {
    path: entry.relativePath,
    bytes: entry.content.length,
    sha256: hashContent(entry.content),
  };
}

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

export async function loadPromptPackEntries(packDir = DEFAULT_PROMPT_PACK_DIR, manifest = null) {
  const packManifest = manifest || await readJson(path.join(packDir, "manifest.json"));
  const agents = [];
  for (const [name, relativePath] of Object.entries(packManifest.agents || {})) {
    agents.push(await loadPackTextEntry(packDir, name, relativePath, "agent"));
  }
  const skills = [];
  for (const [name, relativePath] of Object.entries(packManifest.skills || {})) {
    skills.push(await loadPackTextEntry(packDir, name, relativePath, "skill"));
  }
  const tools = await loadPackTextEntry(packDir, "tools", packManifest.tools, "tools");
  const routes = packManifest.routes ? await loadPackTextEntry(packDir, "routes", packManifest.routes, "routes") : null;
  return { manifest: packManifest, agents, skills, tools, routes };
}

async function loadPackTextEntry(packDir, name, relativePath, kind) {
  if (!relativePath || relativePath.includes("..") || path.isAbsolute(relativePath)) {
    throw new Error(`invalid ${kind} path for ${name}: ${relativePath}`);
  }
  const content = await readFile(path.join(packDir, relativePath), "utf8");
  return { name, kind, relativePath, content, sha256: hashContent(content) };
}

export function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function listPromptPack(rootDir) {
  const registry = await readJson(resolveHelixPath(rootDir, "prompt-pack.json"), null);
  if (!registry) return null;
  return {
    name: registry.name,
    description: registry.description,
    agents: Object.keys(registry.agents || {}),
    skills: Object.keys(registry.skills || {}),
    tools: registry.tools ? "tools/tool-contract.json" : null,
    routes: registry.routes ? "routes.json" : null,
  };
}

export async function renderPromptPackEntry(rootDir, selector) {
  const registry = await readJson(resolveHelixPath(rootDir, "prompt-pack.json"), null);
  if (!registry) throw new Error("prompt pack is not installed; run helix init");

  let entry;
  let label;
  if (selector.agent) {
    entry = registry.agents?.[selector.agent];
    label = `agent ${selector.agent}`;
  } else if (selector.skill) {
    entry = registry.skills?.[selector.skill];
    label = `skill ${selector.skill}`;
  } else if (selector.tools) {
    entry = registry.tools;
    label = "tools";
  } else if (selector.routes) {
    entry = registry.routes;
    label = "routes";
  } else {
    throw new Error("choose --agent <name>, --skill <name>, --tools, or --routes");
  }
  if (!entry) throw new Error(`unknown prompt-pack entry: ${label}`);

  const content = await readFile(path.join(registry.packDir, entry.path), "utf8");
  const actualHash = hashContent(content);
  if (actualHash !== entry.sha256) {
    throw new Error(`prompt-pack entry changed after install: ${label}`);
  }
  return content;
}

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

async function loadRoutesConfig(rootDir) {
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

export function normalizePlan(rawPlan) {
  if (!rawPlan || typeof rawPlan !== "object") {
    throw new Error("plan must be a JSON object");
  }
  if (!rawPlan.title || typeof rawPlan.title !== "string") {
    throw new Error("plan.title is required");
  }
  if (!Array.isArray(rawPlan.tasks) || rawPlan.tasks.length === 0) {
    throw new Error("plan.tasks must contain at least one task");
  }

  const defaults = normalizePlanDefaults(rawPlan);
  const plan = {
    id: rawPlan.id || createWorkId("plan"),
    title: rawPlan.title,
    objective: rawPlan.objective || rawPlan.title,
    defaults,
    createdAt: rawPlan.createdAt || nowIso(),
    updatedAt: nowIso(),
    tasks: rawPlan.tasks.map((task, index) => normalizeTask(task, index, defaults)),
  };
  validatePlanGraph(plan);
  return plan;
}

function normalizePlanDefaults(rawPlan) {
  const rawDefaults = rawPlan.defaults && typeof rawPlan.defaults === "object" ? rawPlan.defaults : {};
  const defaults = {
    verify_commands: normalizeStringArray(rawDefaults.verify_commands ?? rawDefaults.verifyCommands ?? rawPlan.verify_commands ?? rawPlan.verifyCommands ?? [], "defaults.verify_commands"),
    review_commands: normalizeStringArray(rawDefaults.review_commands ?? rawDefaults.reviewCommands ?? rawPlan.review_commands ?? rawPlan.reviewCommands ?? [], "defaults.review_commands"),
    standards_commands: normalizeStringArray(rawDefaults.standards_commands ?? rawDefaults.standardsCommands ?? rawPlan.standards_commands ?? rawPlan.standardsCommands ?? [], "defaults.standards_commands"),
    writable_paths: normalizeStringArray(rawDefaults.writable_paths ?? rawDefaults.writablePaths ?? rawPlan.writable_paths ?? rawPlan.writablePaths ?? [], "defaults.writable_paths"),
    skills: normalizeStringArray(rawDefaults.skills ?? rawPlan.skills ?? [], "defaults.skills"),
  };
  return defaults;
}

function normalizeStringArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return uniqueStrings(value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) throw new Error(`${label} must contain non-empty strings`);
    return item.trim();
  }));
}

export function normalizeTask(task, index, defaults = {}) {
  if (!task || typeof task !== "object") {
    throw new Error(`task ${index + 1} must be an object`);
  }
  const id = task.id || `T${String(index + 1).padStart(3, "0")}`;
  const subject = task.subject || task.title;
  if (!subject) throw new Error(`task ${id} subject is required`);

  const taskVerifyCommands = normalizeStringArray(task.verify_commands ?? task.verifyCommands ?? [], `task ${id} verify_commands`);
  const verifyCommands = uniqueStrings([...(defaults.verify_commands || []), ...taskVerifyCommands]);
  if (verifyCommands.length === 0) {
    throw new Error(`task ${id} requires at least one verify command`);
  }
  const taskReviewCommands = normalizeStringArray(task.review_commands ?? task.reviewCommands ?? [], `task ${id} review_commands`);
  const reviewCommands = uniqueStrings([...(defaults.review_commands || []), ...taskReviewCommands]);
  const taskStandardsCommands = normalizeStringArray(task.standards_commands ?? task.standardsCommands ?? [], `task ${id} standards_commands`);
  const standardsCommands = uniqueStrings([...(defaults.standards_commands || []), ...taskStandardsCommands]);
  const taskWritablePaths = normalizeStringArray(task.writable_paths ?? task.writablePaths ?? [], `task ${id} writable_paths`);
  const writablePaths = uniqueStrings([...(defaults.writable_paths || []), ...taskWritablePaths]);
  const taskSkills = normalizeStringArray(task.skills ?? [], `task ${id} skills`);
  const skills = uniqueStrings([...(defaults.skills || []), ...taskSkills]);
  const successCriteria = normalizeSuccessCriteria(task.successCriteria ?? task.success_criteria, id, subject, verifyCommands);

  return {
    id,
    subject,
    description: task.description || subject,
    category: task.category || null,
    category_source: task.category ? "explicit" : "unresolved",
    status: validateStatus(task.status || "pending"),
    owner: task.owner || "Atlas",
    attempts: Number.isInteger(task.attempts) ? task.attempts : 0,
    maxAttempts: Number.isInteger(task.maxAttempts) ? task.maxAttempts : 3,
    blockedBy: normalizeStringArray(task.blockedBy ?? [], `task ${id} blockedBy`),
    writable_paths: writablePaths,
    worker_command: task.worker_command || task.workerCommand || null,
    verify_commands: verifyCommands,
    review_commands: reviewCommands,
    standards_commands: standardsCommands,
    successCriteria,
    skills,
    route_decision: task.route_decision || null,
    evidence: Array.isArray(task.evidence) ? task.evidence : [],
    createdAt: task.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

function normalizeSuccessCriteria(value, taskId, subject, verifyCommands) {
  if (value === undefined) return seedDefaultSuccessCriteria(taskId, subject, verifyCommands);
  if (!Array.isArray(value)) throw new Error(`task ${taskId} successCriteria must be an array`);
  if (value.length === 0) return seedDefaultSuccessCriteria(taskId, subject, verifyCommands);
  return value.map((criterion, index) => {
    if (!criterion || typeof criterion !== "object") throw new Error(`task ${taskId} successCriteria[${index}] must be an object`);
    const id = criterion.id || `C${String(index + 1).padStart(3, "0")}`;
    const title = criterion.title || criterion.scenario || `${subject} criterion ${index + 1}`;
    if (typeof title !== "string" || title.trim().length === 0) throw new Error(`task ${taskId} criterion ${id} title is required`);
    const status = criterion.status || "pending";
    if (!["pending", "pass", "fail"].includes(status)) throw new Error(`task ${taskId} criterion ${id} status must be pending, pass, or fail`);
    return {
      id,
      title: title.trim(),
      scenario: typeof criterion.scenario === "string" && criterion.scenario.trim() ? criterion.scenario.trim() : title.trim(),
      expectedEvidence: typeof criterion.expectedEvidence === "string" && criterion.expectedEvidence.trim()
        ? criterion.expectedEvidence.trim()
        : "verifier/review evidence proves this criterion",
      status,
      evidence: Array.isArray(criterion.evidence) ? criterion.evidence : [],
      lastUpdatedAt: criterion.lastUpdatedAt || null,
    };
  });
}

function seedDefaultSuccessCriteria(taskId, subject, verifyCommands) {
  const verifierText = verifyCommands.join(" && ");
  return [
    {
      id: "C001",
      title: "happy path passes",
      scenario: `${subject} 的主路径行为符合目标。`,
      expectedEvidence: verifierText || "主路径 verifier evidence",
      status: "pending",
      evidence: [],
      lastUpdatedAt: null,
    },
    {
      id: "C002",
      title: "edge conditions considered",
      scenario: `${subject} 的关键边界条件没有被跳过。`,
      expectedEvidence: verifierText || "边界条件 verifier evidence",
      status: "pending",
      evidence: [],
      lastUpdatedAt: null,
    },
    {
      id: "C003",
      title: "regression guard passes",
      scenario: `${subject} 不破坏既有关键行为。`,
      expectedEvidence: verifierText || "回归保护 verifier evidence",
      status: "pending",
      evidence: [],
      lastUpdatedAt: null,
    },
  ];
}

export function validateStatus(status) {
  if (!TASK_STATUSES.has(status)) {
    throw new Error(`invalid task status: ${status}`);
  }
  return status;
}

export function validatePlanGraph(plan) {
  const ids = new Set();
  for (const task of plan.tasks) {
    if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (!Array.isArray(task.blockedBy)) throw new Error(`task ${task.id} blockedBy must be an array`);
    const blockers = new Set();
    for (const blocker of task.blockedBy) {
      if (typeof blocker !== "string" || blocker.trim().length === 0) {
        throw new Error(`task ${task.id} blockedBy must contain task ids`);
      }
      if (blocker === task.id) throw new Error(`task ${task.id} cannot block itself`);
      if (blockers.has(blocker)) throw new Error(`task ${task.id} has duplicate blocker: ${blocker}`);
      blockers.add(blocker);
    }
  }

  for (const task of plan.tasks) {
    for (const blocker of task.blockedBy) {
      if (!ids.has(blocker)) throw new Error(`task ${task.id} blockedBy references unknown task: ${blocker}`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const tasksById = new Map(plan.tasks.map((task) => [task.id, task]));
  const stack = [];

  function visit(taskId) {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      const cycleStart = stack.indexOf(taskId);
      const cycle = [...stack.slice(cycleStart), taskId].join(" -> ");
      throw new Error(`task dependency cycle detected: ${cycle}`);
    }
    visiting.add(taskId);
    stack.push(taskId);
    const task = tasksById.get(taskId);
    for (const blocker of task.blockedBy) visit(blocker);
    stack.pop();
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const task of plan.tasks) visit(task.id);
  return plan;
}

export async function importPlan(rootDir, planPath) {
  return withTaskStateLock(rootDir, "import-plan", () => importPlanUnlocked(rootDir, planPath));
}

async function importPlanUnlocked(rootDir, planPath) {
  await ensureHelixDirs(rootDir);
  const rawPlan = await readJson(planPath);
  const plan = normalizePlan(rawPlan);
  await enrichPlanWithRoutes(rootDir, plan);
  const targetPath = resolveHelixPath(rootDir, "plans", `${plan.id}.json`);
  await writeJsonAtomic(targetPath, plan);
  await writeJsonAtomic(resolveHelixPath(rootDir, "team", "tasks.json"), {
    version: STATE_VERSION,
    planId: plan.id,
    tasks: plan.tasks,
    updatedAt: nowIso(),
  });
  await writeTasksMarkdown(rootDir, plan);

  const work = await readJson(resolveHelixPath(rootDir, "work.json"), {
    version: STATE_VERSION,
    workId: createWorkId(),
    createdAt: nowIso(),
  });
  await writeJsonAtomic(resolveHelixPath(rootDir, "work.json"), {
    ...work,
    stage: "planned",
    activePlanId: plan.id,
    status: "ready",
    updatedAt: nowIso(),
  });

  await appendLedger(rootDir, { type: "plan_imported", planId: plan.id, taskCount: plan.tasks.length });
  await writeSnapshot(rootDir, "planned", { planId: plan.id });
  return plan;
}

export async function enrichPlanWithRoutes(rootDir, plan) {
  const routes = await loadRoutesConfig(rootDir);
  for (const task of plan.tasks) {
    enrichTaskWithRouteDecision(task, routes);
  }
  await appendLedger(rootDir, {
    type: "plan_routed",
    planId: plan.id,
    routes: plan.tasks.map((task) => ({
      taskId: task.id,
      category: task.category,
      primaryAgent: task.route_decision?.primaryAgent,
      skills: task.skills,
    })),
  });
  return plan;
}

function enrichTaskWithRouteDecision(task, routes) {
  const routeDecision = resolveRouteDecision(routes, `${task.subject}\n${task.description}`);
  task.route_decision = routeDecision;
  if (task.category_source !== "explicit") {
    task.category = routeDecision.category || "deep";
    task.category_source = "route";
  }
  task.skills = uniqueStrings([...(task.skills || []), ...(routeDecision.skills || [])]);
  return task;
}

export async function writeTasksMarkdown(rootDir, plan) {
  const lines = [
    `# ${plan.title}`,
    "",
    `Objective: ${plan.objective}`,
    "",
    "## TODOs",
    "",
  ];

  for (const task of plan.tasks) {
    const checkbox = task.status === "completed" ? "[x]" : "[ ]";
    lines.push(`- ${checkbox} ${task.id}. ${task.subject}`);
    lines.push(`  - Status: ${task.status}`);
    lines.push(`  - Category: ${task.category || "unresolved"} (${task.category_source || "unknown"})`);
    if (Array.isArray(task.skills) && task.skills.length > 0) {
      lines.push(`  - Skills: ${task.skills.join(", ")}`);
    }
    if (task.route_decision) {
      lines.push(`  - Route: ${task.route_decision.route} -> ${task.route_decision.primaryAgent}`);
    }
    lines.push(`  - Verify: ${task.verify_commands.join(" && ")}`);
    if ((task.review_commands || []).length > 0) {
      lines.push(`  - Review: ${task.review_commands.join(" && ")}`);
    }
    if ((task.standards_commands || []).length > 0) {
      lines.push(`  - Standards: ${task.standards_commands.join(" && ")}`);
    }
    if (task.last_review_result) {
      lines.push(`  - Review Gate: ${task.last_review_result.pass ? "PASS" : "FAIL"} (${task.last_review_result.reportMdPath || "no report"})`);
    }
    if (task.last_change_request) {
      lines.push(`  - ChangeRequest: ${task.last_change_request.id} (${task.last_change_request.reportMdPath})`);
    }
    if (task.last_failure) {
      lines.push(`  - Last Failure: ${task.last_failure.reason}`);
      lines.push(`  - Retry Hint: ${task.last_failure.retryHint.replace(/\n/g, " / ")}`);
    }
  }

  await writeFile(resolveHelixPath(rootDir, "team", "tasks.md"), `${lines.join("\n")}\n`, "utf8");
}

export async function loadTaskState(rootDir) {
  return readJson(resolveHelixPath(rootDir, "team", "tasks.json"), null);
}

export async function listTeamTasks(rootDir, options = {}) {
  const taskState = await loadTaskState(rootDir);
  if (!taskState) return { planId: null, tasks: [] };
  const tasks = taskState.tasks.filter((task) => {
    if (options.status && task.status !== options.status) return false;
    if (options.owner && task.owner !== options.owner) return false;
    return true;
  });
  await appendLedger(rootDir, {
    type: "team_tasks_listed",
    planId: taskState.planId,
    status: options.status || null,
    owner: options.owner || null,
    count: tasks.length,
  });
  return { planId: taskState.planId, tasks };
}

export async function getTeamTask(rootDir, taskId) {
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = taskState.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  await appendLedger(rootDir, { type: "team_task_read", planId: taskState.planId, taskId });
  return { planId: taskState.planId, task };
}

export async function recordTaskEvidence(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `evidence-record:${options.taskId || "unknown"}`, async () => {
    await ensureHelixDirs(rootDir);
    const taskState = await loadTaskState(rootDir);
    if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
    const task = taskState.tasks.find((candidate) => candidate.id === options.taskId);
    if (!task) throw new Error(`unknown task: ${options.taskId}`);
    const criterion = (task.successCriteria || []).find((candidate) => candidate.id === options.criterionId);
    if (!criterion) throw new Error(`unknown criterion for ${task.id}: ${options.criterionId}`);
    const status = options.status || "pass";
    if (!["pass", "fail", "pending"].includes(status)) throw new Error("evidence status must be pass, fail, or pending");
    const evidence = typeof options.evidence === "string" ? options.evidence.trim() : "";
    if (!evidence) throw new Error("evidence text is required");
    const entry = {
      kind: "criterion_evidence",
      at: nowIso(),
      taskId: task.id,
      criterionId: criterion.id,
      status,
      source: options.source || "manual",
      evidence,
    };
    criterion.status = status;
    criterion.evidence = [...(criterion.evidence || []), entry];
    criterion.lastUpdatedAt = entry.at;
    task.evidence.push(entry);
    task.updatedAt = nowIso();
    await persistTaskState(rootDir, taskState);
    await appendLedger(rootDir, { type: "criterion_evidence_recorded", planId: taskState.planId, taskId: task.id, criterionId: criterion.id, status });
    return { planId: taskState.planId, task, criterion, evidence: entry };
  });
}

export async function claimTeamTask(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `team-task-claim:${options.taskId || "next"}`, () => claimTeamTaskUnlocked(rootDir, options));
}

async function claimTeamTaskUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = options.taskId
    ? taskState.tasks.find((candidate) => candidate.id === options.taskId)
    : findRunnableTask(taskState.tasks);
  if (!task) throw new Error(options.taskId ? `unknown task: ${options.taskId}` : "no runnable task available to claim");
  if (task.status !== "pending") throw new Error(`task ${task.id} is ${task.status}; only pending tasks can be claimed`);
  const blockers = unresolvedBlockers(task, taskState.tasks);
  if (blockers.length > 0) throw new Error(`task ${task.id} blocked by ${blockers.join(",")}`);

  task.status = "in_progress";
  task.owner = options.owner || task.owner || "Atlas";
  task.claimedAt = nowIso();
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: "team_task_claimed",
    planId: taskState.planId,
    taskId: task.id,
    owner: task.owner,
  });
  await writeSnapshot(rootDir, "team_task_claimed", { planId: taskState.planId, taskId: task.id, owner: task.owner });
  return { planId: taskState.planId, task };
}

function unresolvedBlockers(task, tasks) {
  return (task.blockedBy || []).filter((blockerId) => {
    const blocker = tasks.find((candidate) => candidate.id === blockerId);
    return blocker && blocker.status !== "completed";
  });
}

function applyVerifierEvidenceToCriteria(task, verifyResult) {
  if (!verifyResult?.pass) return [];
  const recorded = [];
  for (const criterion of task.successCriteria || []) {
    if (criterion.status === "pass") continue;
    const entry = {
      kind: "criterion_evidence",
      at: nowIso(),
      taskId: task.id,
      criterionId: criterion.id,
      status: "pass",
      source: "verifier",
      evidence: `Verifier passed ${verifyResult.results.length}/${task.verify_commands.length} command(s): ${task.verify_commands.join(" && ")}`,
    };
    criterion.status = "pass";
    criterion.evidence = [...(criterion.evidence || []), entry];
    criterion.lastUpdatedAt = entry.at;
    task.evidence.push(entry);
    recorded.push(entry);
  }
  return recorded;
}

function criteriaStatus(task) {
  const criteria = task.successCriteria || [];
  if (criteria.length === 0) return { total: 0, passed: 0, failed: 0, pending: 0, pass: true };
  const passed = criteria.filter((criterion) => criterion.status === "pass").length;
  const failed = criteria.filter((criterion) => criterion.status === "fail").length;
  const pending = criteria.filter((criterion) => criterion.status === "pending").length;
  return { total: criteria.length, passed, failed, pending, pass: failed === 0 && pending === 0 && passed === criteria.length };
}

export async function createTeamTask(rootDir, rawTask) {
  return withTaskStateLock(rootDir, "team-task-create", () => createTeamTaskUnlocked(rootDir, rawTask));
}

async function createTeamTaskUnlocked(rootDir, rawTask) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const planPath = resolveHelixPath(rootDir, "plans", `${taskState.planId}.json`);
  const plan = await readJson(planPath);
  const normalizedTask = normalizeTask(rawTask, taskState.tasks.length, plan.defaults || {});
  if (taskState.tasks.some((task) => task.id === normalizedTask.id)) {
    throw new Error(`duplicate task id: ${normalizedTask.id}`);
  }
  const routes = await loadRoutesConfig(rootDir);
  enrichTaskWithRouteDecision(normalizedTask, routes);
  const nextTasks = [...taskState.tasks, normalizedTask];
  validatePlanGraph({ ...plan, tasks: nextTasks });
  taskState.tasks = nextTasks;
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: "team_task_created",
    planId: taskState.planId,
    taskId: normalizedTask.id,
    subject: normalizedTask.subject,
    blockedBy: normalizedTask.blockedBy,
  });
  await writeSnapshot(rootDir, "team_task_created", { planId: taskState.planId, taskId: normalizedTask.id });
  return { planId: taskState.planId, task: normalizedTask };
}

export async function steerWorkflow(rootDir, proposal = {}) {
  return withTaskStateLock(rootDir, `steer:${proposal.kind || "unknown"}`, async () => {
    await ensureHelixDirs(rootDir);
    const taskState = await loadTaskState(rootDir);
    if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
    const audit = validateSteeringProposal(taskState, proposal);
    if (!audit.invariant.accepted) {
      await appendLedger(rootDir, { type: "steering_rejected", kind: audit.kind, reasons: audit.invariant.rejectedReasons });
      return { accepted: false, audit, taskState };
    }
    const before = structuredClone(taskState);
    const result = applySteeringProposal(taskState, proposal);
    validatePlanGraph({ tasks: taskState.tasks });
    validateTaskAcceptanceInvariants(taskState.tasks);
    await persistTaskState(rootDir, taskState);
    audit.before = summarizeSteeringState(before);
    audit.after = summarizeSteeringState(taskState);
    await appendLedger(rootDir, { type: "steering_applied", kind: audit.kind, targetTaskIds: audit.targetTaskIds, evidence: audit.evidence });
    await writeSnapshot(rootDir, "steering_applied", { kind: audit.kind, targetTaskIds: audit.targetTaskIds });
    return { accepted: true, audit, result, taskState };
  });
}

function validateSteeringProposal(taskState, proposal) {
  const reasons = [];
  if (!proposal || typeof proposal !== "object") reasons.push("proposal must be an object");
  const kind = proposal?.kind;
  const allowedKinds = ["add_task", "split_task", "reorder_pending", "revise_acceptance", "mark_blocked"];
  if (!allowedKinds.includes(kind)) reasons.push(`invalid kind: ${String(kind)}`);
  const evidence = typeof proposal?.evidence === "string" ? proposal.evidence.trim() : "";
  const rationale = typeof proposal?.rationale === "string" ? proposal.rationale.trim() : "";
  if (!evidence) reasons.push("missing evidence");
  if (!rationale) reasons.push("missing rationale");
  const proposalText = JSON.stringify(proposal || {});
  if (hasWeakeningLanguage(proposalText)) reasons.push("weakened completion");
  if (proposalText.match(/completedAt|completionStatus|autoComplete|mark complete/i)) reasons.push("protected completion payload");
  const targetTaskIds = proposal?.targetTaskIds || (proposal?.targetTaskId ? [proposal.targetTaskId] : proposal?.taskId ? [proposal.taskId] : []);
  if ((kind === "split_task" || kind === "revise_acceptance" || kind === "mark_blocked") && targetTaskIds.length === 0) reasons.push(`${kind} requires targetTaskId`);
  const targets = targetTaskIds.map((id) => taskState.tasks.find((task) => task.id === id));
  if (targets.some((task) => !task)) reasons.push("unknown target task");
  if ((kind === "split_task" || kind === "revise_acceptance") && targets.some((task) => task && task.status !== "pending")) reasons.push(`${kind} only applies to pending tasks`);
  if (kind === "add_task" && (!proposal.task || typeof proposal.task !== "object")) reasons.push("add_task requires task object");
  if (kind === "split_task" && (!Array.isArray(proposal.tasks) || proposal.tasks.length === 0)) reasons.push("split_task requires tasks array");
  if (kind === "revise_acceptance") {
    for (const target of targets.filter(Boolean)) {
      reasons.push(...validateAcceptanceRevisionStrength(target, proposal));
    }
  }
  if (kind === "reorder_pending") {
    const pendingOrder = Array.isArray(proposal.pendingOrder) ? proposal.pendingOrder : [];
    const pendingIds = taskState.tasks.filter((task) => task.status === "pending").map((task) => task.id);
    if (pendingOrder.length === 0) reasons.push("reorder_pending requires pendingOrder");
    if (new Set(pendingOrder).size !== pendingOrder.length) reasons.push("duplicate pending id");
    if (pendingOrder.some((id) => !pendingIds.includes(id))) reasons.push("unknown pending id");
  }
  return {
    kind: allowedKinds.includes(kind) ? kind : "invalid",
    at: nowIso(),
    source: proposal.source || "cli",
    evidence,
    rationale,
    targetTaskIds,
    invariant: {
      accepted: reasons.length === 0,
      evidenceBackedNecessity: evidence.length > 0 && rationale.length > 0,
      noWeakenedCompletion: !hasWeakeningLanguage(proposalText),
      structuralInvariantAccepted: reasons.length === 0,
      rejectedReasons: reasons,
    },
  };
}

function validateAcceptanceRevisionStrength(target, proposal) {
  const reasons = [];
  for (const [field, label] of [
    ["verify_commands", "verify_commands"],
    ["review_commands", "review_commands"],
    ["standards_commands", "standards_commands"],
  ]) {
    if (!Array.isArray(proposal[field])) continue;
    const next = normalizeStringArray(proposal[field], `task ${target.id} ${label}`);
    if (field === "verify_commands" && next.length === 0) {
      reasons.push("verify_commands cannot be empty");
    }
    const removed = (target[field] || []).filter((command) => !next.includes(command));
    if (removed.length > 0) {
      reasons.push(`${label} cannot remove existing gate command(s): ${removed.join(", ")}`);
    }
  }

  if (Array.isArray(proposal.successCriteria)) {
    const nextCriteria = normalizeSuccessCriteria(proposal.successCriteria, target.id, target.subject, target.verify_commands);
    const nextIds = new Set(nextCriteria.map((criterion) => criterion.id));
    const removedCriteria = (target.successCriteria || []).filter((criterion) => !nextIds.has(criterion.id));
    if (removedCriteria.length > 0) {
      reasons.push(`successCriteria cannot remove existing criterion id(s): ${removedCriteria.map((criterion) => criterion.id).join(", ")}`);
    }
  }
  return reasons;
}

function validateTaskAcceptanceInvariants(tasks) {
  for (const task of tasks) {
    if (!Array.isArray(task.verify_commands) || task.verify_commands.length === 0) {
      throw new Error(`task ${task.id} requires at least one verify command`);
    }
  }
}

function applySteeringProposal(taskState, proposal) {
  const planDefaults = {};
  if (proposal.kind === "add_task") {
    const task = normalizeTask(proposal.task, taskState.tasks.length, planDefaults);
    task.steering = steeringStamp(proposal);
    taskState.tasks.push(task);
    return { task };
  }
  if (proposal.kind === "split_task") {
    const target = taskState.tasks.find((task) => task.id === (proposal.targetTaskId || proposal.taskId));
    target.status = "review_blocked";
    target.steeringStatus = "superseded";
    target.steering = steeringStamp(proposal);
    const created = proposal.tasks.map((rawTask, index) => {
      const task = normalizeTask({ blockedBy: [], ...rawTask }, taskState.tasks.length + index, planDefaults);
      task.supersedes = [target.id];
      task.steering = steeringStamp(proposal);
      return task;
    });
    target.supersededBy = created.map((task) => task.id);
    taskState.tasks.splice(taskState.tasks.indexOf(target) + 1, 0, ...created);
    return { blockedTask: target, created };
  }
  if (proposal.kind === "reorder_pending") {
    const order = proposal.pendingOrder;
    const ordered = order.map((id) => taskState.tasks.find((task) => task.id === id)).filter(Boolean);
    const rest = taskState.tasks.filter((task) => !order.includes(task.id));
    taskState.tasks = [...ordered, ...rest];
    return { order };
  }
  if (proposal.kind === "revise_acceptance") {
    const target = taskState.tasks.find((task) => task.id === (proposal.targetTaskId || proposal.taskId));
    if (Array.isArray(proposal.verify_commands)) target.verify_commands = normalizeStringArray(proposal.verify_commands, `task ${target.id} verify_commands`);
    if (Array.isArray(proposal.review_commands)) target.review_commands = normalizeStringArray(proposal.review_commands, `task ${target.id} review_commands`);
    if (Array.isArray(proposal.standards_commands)) target.standards_commands = normalizeStringArray(proposal.standards_commands, `task ${target.id} standards_commands`);
    if (Array.isArray(proposal.successCriteria)) target.successCriteria = normalizeSuccessCriteria(proposal.successCriteria, target.id, target.subject, target.verify_commands);
    target.steering = steeringStamp(proposal);
    target.updatedAt = nowIso();
    return { task: target };
  }
  if (proposal.kind === "mark_blocked") {
    const target = taskState.tasks.find((task) => task.id === (proposal.targetTaskId || proposal.taskId));
    target.status = "needs_user_decision";
    target.blockedReason = proposal.blockedReason || proposal.rationale;
    target.steering = steeringStamp(proposal);
    target.updatedAt = nowIso();
    return { task: target };
  }
  return {};
}

function steeringStamp(proposal) {
  return {
    kind: proposal.kind,
    source: proposal.source || "cli",
    evidence: proposal.evidence,
    rationale: proposal.rationale,
    at: nowIso(),
  };
}

function summarizeSteeringState(taskState) {
  return {
    planId: taskState.planId,
    tasks: taskState.tasks.map((task) => ({ id: task.id, status: task.status, subject: task.subject, blockedBy: task.blockedBy || [] })),
  };
}

export async function recordReviewBlocker(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `review-blocker:${options.taskId || "unknown"}`, async () => {
    await ensureHelixDirs(rootDir);
    const taskState = await loadTaskState(rootDir);
    if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
    const task = taskState.tasks.find((candidate) => candidate.id === options.taskId);
    if (!task) throw new Error(`unknown task: ${options.taskId}`);
    if (!["verifying", "failed", "in_progress"].includes(task.status)) throw new Error(`task ${task.id} is ${task.status}; cannot record review blocker`);
    const evidence = typeof options.evidence === "string" ? options.evidence.trim() : "";
    const rationale = typeof options.rationale === "string" ? options.rationale.trim() : "";
    if (!evidence) throw new Error("review blocker evidence is required");
    if (!rationale) throw new Error("review blocker rationale is required");
    if (hasWeakeningLanguage(`${evidence}\n${rationale}`)) throw new Error("review blocker appears to weaken verification");
    const blockerTask = normalizeTask({
      id: options.newTaskId || nextTaskId(taskState.tasks),
      subject: options.title || `Resolve review blocker for ${task.id}`,
      description: options.objective || rationale,
      worker_command: options.worker_command || "node -e \"process.exit(0)\"",
      verify_commands: options.verify_commands || task.verify_commands,
      review_commands: options.review_commands || task.review_commands || [],
      standards_commands: options.standards_commands || task.standards_commands || [],
      writable_paths: options.writable_paths || task.writable_paths || [],
    }, taskState.tasks.length, {});
    blockerTask.reviewBlockerFor = task.id;
    blockerTask.steering = { kind: "review_blocker_resolution", evidence, rationale, at: nowIso() };
    task.status = "review_blocked";
    task.reviewBlockedAt = nowIso();
    task.reviewBlocker = { evidence, rationale, resolutionTaskId: blockerTask.id };
    task.updatedAt = nowIso();
    taskState.tasks.push(blockerTask);
    validatePlanGraph({ tasks: taskState.tasks });
    await persistTaskState(rootDir, taskState);
    await appendLedger(rootDir, { type: "review_blocker_recorded", planId: taskState.planId, taskId: task.id, resolutionTaskId: blockerTask.id, evidence });
    await writeSnapshot(rootDir, "review_blocker_recorded", { planId: taskState.planId, taskId: task.id, resolutionTaskId: blockerTask.id });
    return { planId: taskState.planId, blockedTask: task, resolutionTask: blockerTask };
  });
}

function nextTaskId(tasks) {
  const max = tasks.reduce((current, task) => {
    const match = /^T(\d+)$/.exec(task.id);
    return match ? Math.max(current, Number(match[1])) : current;
  }, 0);
  return `T${String(max + 1).padStart(3, "0")}`;
}

export function findRunnableTask(tasks) {
  const completed = new Set(tasks.filter((task) => task.status === "completed").map((task) => task.id));
  return tasks.find((task) => {
    if (task.status !== "pending") return false;
    return task.blockedBy.every((blockedBy) => completed.has(blockedBy));
  }) || null;
}

export async function runNextTask(rootDir, options = {}) {
  return withTaskStateLock(rootDir, "run-next-task", () => runNextTaskUnlocked(rootDir, options));
}

async function runNextTaskUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");

  const task = findRunnableTask(taskState.tasks);
  if (!task) {
    const unfinished = taskState.tasks.filter((candidate) => candidate.status !== "completed");
    const status = unfinished.length === 0 ? "complete" : "blocked";
    await appendLedger(rootDir, { type: "run_idle", status });
    return { status, task: null };
  }

  task.status = "in_progress";
  task.attempts += 1;
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, { type: "task_started", planId: taskState.planId, taskId: task.id, attempt: task.attempts });
  await writeSnapshot(rootDir, "task_started", { planId: taskState.planId, taskId: task.id, attempt: task.attempts });

  const beforeDiff = await collectGitDiff(rootDir);
  const beforeChanged = await collectGitChangedPaths(rootDir);
  const workerResult = await runWorker(rootDir, task, options);
  const afterDiff = await collectGitDiff(rootDir);
  const afterChanged = await collectGitChangedPaths(rootDir);

  task.status = "verifying";
  task.evidence.push(workerResult);
  task.evidence.push({
    kind: "diff",
    at: nowIso(),
    beforeBytes: beforeDiff.length,
    afterBytes: afterDiff.length,
    changed: beforeDiff !== afterDiff,
  });
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await writeOutbox(rootDir, task, workerResult);
  await appendLedger(rootDir, { type: "worker_done_claim", planId: taskState.planId, taskId: task.id, exitCode: workerResult.exitCode });
  await writeSnapshot(rootDir, "worker_done", { planId: taskState.planId, taskId: task.id, exitCode: workerResult.exitCode });

  const verifyResult = await runVerifier(rootDir, task);
  task.evidence.push(verifyResult);
  task.last_verify_result = verifyResult;
  const criterionEvidence = applyVerifierEvidenceToCriteria(task, verifyResult);
  await persistTaskState(rootDir, taskState);
  await writeSnapshot(rootDir, "verified", { planId: taskState.planId, taskId: task.id, pass: verifyResult.pass });
  if (criterionEvidence.length > 0) {
    await appendLedger(rootDir, { type: "criterion_evidence_auto_recorded", planId: taskState.planId, taskId: task.id, count: criterionEvidence.length });
  }

  const scopeResult = await scopeGuard(rootDir, {
    taskId: task.id,
    changedPaths: changedPathsIntroducedByTask(beforeChanged, afterChanged),
    unavailableReason: beforeChanged.available ? afterChanged.reason : beforeChanged.reason,
  });
  task.evidence.push({ kind: "scope_guard", at: nowIso(), ...scopeResult });
  task.last_scope_result = scopeResult;
  if (scopeResult.status === "fail") {
    task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "scope_guard");
  }
  await persistTaskState(rootDir, taskState);

  const reviewResult = await runReviewGate(rootDir, task, { workerResult, verifyResult, scopeResult });
  task.evidence.push(reviewResult);
  task.last_review_result = reviewResult;
  await writeReviewReport(rootDir, taskState.planId, task, reviewResult);
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, { type: "review_gate_completed", planId: taskState.planId, taskId: task.id, pass: reviewResult.pass, failedLaneCount: reviewResult.lanes.filter((lane) => lane.status === "fail").length });
  await writeSnapshot(rootDir, "reviewed", { planId: taskState.planId, taskId: task.id, pass: reviewResult.pass });

  const criteria = criteriaStatus(task);
  if (workerResult.exitCode === 0 && verifyResult.pass && criteria.pass && scopeResult.status === "pass" && reviewResult.pass) {
    task.status = "completed";
    task.updatedAt = nowIso();
    await persistTaskState(rootDir, taskState);
    await writeCheckpoint(rootDir, taskState.planId, task, verifyResult, scopeResult, reviewResult);
    await appendLedger(rootDir, { type: "task_verified", planId: taskState.planId, taskId: task.id, scopeStatus: scopeResult.status, reviewStatus: "pass" });
    await appendWisdom(rootDir, task, verifyResult);
    await writeSnapshot(rootDir, "checkpointed", { planId: taskState.planId, taskId: task.id, scopeStatus: scopeResult.status });
    if (taskState.tasks.every((candidate) => candidate.status === "completed")) {
      await writeWorkflowSummary(rootDir, { reason: "all_tasks_completed" });
    }
    return { status: "completed", task, workerResult, verifyResult, scopeResult, reviewResult };
  }

  task.status = shouldFailTask(task, verifyResult, scopeResult, reviewResult) ? "failed" : "pending";
  if (scopeResult?.status === "fail" && !task.last_change_request) {
    task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "scope_guard");
  }
  task.last_failure = buildFailureSummary(task, {
    workerResult,
    verifyResult,
    scopeResult,
    reviewResult,
    criteriaResult: criteria,
    nextStatus: task.status,
  });
  task.updatedAt = nowIso();
  await writeFailureReport(rootDir, taskState.planId, task);
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: "task_rejected",
    planId: taskState.planId,
    taskId: task.id,
    nextStatus: task.status,
    attempt: task.attempts,
    reason: task.last_failure.reason,
    retryHint: task.last_failure.retryHint,
  });
  await writeSnapshot(rootDir, "task_rejected", { planId: taskState.planId, taskId: task.id, nextStatus: task.status });
  return { status: task.status === "failed" ? "failed" : "retry", task, workerResult, verifyResult, scopeResult, reviewResult };
}

export async function runWorkflowNode(rootDir, nodeName, options = {}) {
  if (nodeName === "route") {
    return routeRequest(rootDir, { text: options.text });
  }
  if (nodeName === "execute") {
    return executeTaskNode(rootDir, options);
  }
  if (nodeName === "verify") {
    return verifyTaskNode(rootDir, options);
  }
  if (nodeName === "scope") {
    return scopeTaskNode(rootDir, options);
  }
  if (nodeName === "review") {
    return reviewTaskNode(rootDir, options);
  }
  if (nodeName === "checkpoint") {
    return checkpointTaskNode(rootDir, options);
  }
  if (nodeName === "retry") {
    return retryTaskNode(rootDir, options);
  }
  throw new Error(`unknown workflow node: ${nodeName}`);
}

export async function executeTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-execute:${options.taskId || "next"}`, () => executeTaskNodeUnlocked(rootDir, options));
}

async function executeTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");

  const task = resolveNodeTask(taskState.tasks, options.taskId, ["pending", "in_progress"]);
  if (task.status === "pending") {
    task.status = "in_progress";
    task.attempts += 1;
    task.updatedAt = nowIso();
    await persistTaskState(rootDir, taskState);
    await appendLedger(rootDir, { type: "node_execute_started", planId: taskState.planId, taskId: task.id, attempt: task.attempts });
    await writeSnapshot(rootDir, "node_execute_started", { planId: taskState.planId, taskId: task.id });
  }

  const beforeDiff = await collectGitDiff(rootDir);
  const beforeChanged = await collectGitChangedPaths(rootDir);
  const workerResult = await runWorker(rootDir, task, options);
  const afterDiff = await collectGitDiff(rootDir);
  const afterChanged = await collectGitChangedPaths(rootDir);

  task.status = "verifying";
  task.evidence.push(workerResult);
  task.evidence.push({
    kind: "diff",
    at: nowIso(),
    beforeBytes: beforeDiff.length,
    afterBytes: afterDiff.length,
    changed: beforeDiff !== afterDiff,
  });
  task.evidence.push({
    kind: "execution_paths",
    at: nowIso(),
    beforeAvailable: beforeChanged.available,
    afterAvailable: afterChanged.available,
    beforePaths: beforeChanged.paths || [],
    afterPaths: afterChanged.paths || [],
    introducedPaths: changedPathsIntroducedByTask(beforeChanged, afterChanged) || [],
    unavailableReason: beforeChanged.available ? afterChanged.reason : beforeChanged.reason,
  });
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await writeOutbox(rootDir, task, workerResult);
  await appendLedger(rootDir, { type: "node_execute_completed", planId: taskState.planId, taskId: task.id, exitCode: workerResult.exitCode });
  await writeSnapshot(rootDir, "node_execute_completed", { planId: taskState.planId, taskId: task.id, exitCode: workerResult.exitCode });
  return { status: "executed", task, workerResult };
}

export async function verifyTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-verify:${options.taskId || "next"}`, () => verifyTaskNodeUnlocked(rootDir, options));
}

async function verifyTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress"]);

  task.status = "verifying";
  const verifyResult = await runVerifier(rootDir, task);
  task.evidence.push(verifyResult);
  task.last_verify_result = verifyResult;
  const criterionEvidence = applyVerifierEvidenceToCriteria(task, verifyResult);
  if (!verifyResult.pass) {
    task.last_failure = buildFailureSummary(task, {
      workerResult: [...task.evidence].reverse().find((entry) => entry.kind === "worker") || { exitCode: 0 },
      verifyResult,
      scopeResult: task.last_scope_result || { status: "inconclusive" },
      nextStatus: "verifying",
    });
  }
  task.updatedAt = nowIso();
  await appendLedger(rootDir, { type: "node_verify_completed", planId: taskState.planId, taskId: task.id, pass: verifyResult.pass, criterionEvidenceCount: criterionEvidence.length });
  if (!verifyResult.pass) {
    await writeFailureReport(rootDir, taskState.planId, task);
    await persistTaskState(rootDir, taskState);
    await appendLedger(rootDir, { type: "node_verify_failed", planId: taskState.planId, taskId: task.id, reason: task.last_failure.reason });
  } else {
    await persistTaskState(rootDir, taskState);
  }
  await writeSnapshot(rootDir, "node_verify_completed", { planId: taskState.planId, taskId: task.id, pass: verifyResult.pass });
  return { status: verifyResult.pass ? "verified" : "verify_failed", task, verifyResult };
}

export async function scopeTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-scope:${options.taskId || "next"}`, () => scopeTaskNodeUnlocked(rootDir, options));
}

async function scopeTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress", "pending"]);
  const executionPaths = [...task.evidence].reverse().find((entry) => entry.kind === "execution_paths");
  const scopeResult = await scopeGuard(rootDir, {
    taskId: task.id,
    changedPaths: executionPaths?.afterAvailable === true ? executionPaths.introducedPaths : undefined,
    unavailableReason: executionPaths?.unavailableReason,
  });
  task.evidence.push({ kind: "scope_guard", at: nowIso(), ...scopeResult });
  task.last_scope_result = scopeResult;
  if (scopeResult.status === "fail") {
    task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "node_scope");
  }
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await writeSnapshot(rootDir, "node_scope_completed", { planId: taskState.planId, taskId: task.id, scopeStatus: scopeResult.status });
  return { status: scopeResult.status, task, scopeResult };
}

export async function reviewTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-review:${options.taskId || "next"}`, () => reviewTaskNodeUnlocked(rootDir, options));
}

async function reviewTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress"]);
  const workerResult = [...task.evidence].reverse().find((entry) => entry.kind === "worker");
  const verifyResult = task.last_verify_result || [...task.evidence].reverse().find((entry) => entry.kind === "verifier");
  const scopeResult = task.last_scope_result || [...task.evidence].reverse().find((entry) => entry.kind === "scope_guard");
  const reviewResult = await runReviewGate(rootDir, task, { workerResult, verifyResult, scopeResult });

  task.status = "verifying";
  task.evidence.push(reviewResult);
  task.last_review_result = reviewResult;
  task.updatedAt = nowIso();
  await writeReviewReport(rootDir, taskState.planId, task, reviewResult);

  if (!reviewResult.pass) {
    task.status = "failed";
    task.last_failure = buildFailureSummary(task, {
      workerResult: workerResult || { exitCode: 1 },
      verifyResult: verifyResult || { pass: false },
      scopeResult: scopeResult || { status: "inconclusive" },
      reviewResult,
      nextStatus: task.status,
    });
    await writeFailureReport(rootDir, taskState.planId, task);
  }

  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: reviewResult.pass ? "node_review_passed" : "node_review_failed",
    planId: taskState.planId,
    taskId: task.id,
    failedLaneCount: reviewResult.lanes.filter((lane) => lane.status === "fail").length,
  });
  await writeSnapshot(rootDir, "node_review_completed", { planId: taskState.planId, taskId: task.id, pass: reviewResult.pass });
  return { status: reviewResult.pass ? "reviewed" : "review_failed", task, reviewResult };
}

export async function checkpointTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-checkpoint:${options.taskId || "next"}`, () => checkpointTaskNodeUnlocked(rootDir, options));
}

async function checkpointTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = resolveNodeTask(taskState.tasks, options.taskId, ["verifying", "in_progress"]);
  const workerResult = [...task.evidence].reverse().find((entry) => entry.kind === "worker");
  const verifyResult = task.last_verify_result || [...task.evidence].reverse().find((entry) => entry.kind === "verifier");
  const scopeResult = task.last_scope_result || [...task.evidence].reverse().find((entry) => entry.kind === "scope_guard");
  const reviewResult = task.last_review_result || [...task.evidence].reverse().find((entry) => entry.kind === "review_gate");
  const criteria = criteriaStatus(task);

  if (workerResult?.exitCode === 0 && verifyResult?.pass === true && criteria.pass && scopeResult?.status === "pass" && reviewResult?.pass === true) {
    task.status = "completed";
    task.updatedAt = nowIso();
    await persistTaskState(rootDir, taskState);
    await writeCheckpoint(rootDir, taskState.planId, task, verifyResult, scopeResult, reviewResult);
    await appendLedger(rootDir, { type: "node_checkpoint_completed", planId: taskState.planId, taskId: task.id, scopeStatus: scopeResult?.status || "missing", reviewStatus: "pass" });
    await appendWisdom(rootDir, task, verifyResult);
    await writeSnapshot(rootDir, "node_checkpoint_completed", { planId: taskState.planId, taskId: task.id });
    return { status: "completed", task, verifyResult, scopeResult, reviewResult };
  }

  task.status = shouldFailTask(task, verifyResult, scopeResult, reviewResult) ? "failed" : "pending";
  if (scopeResult?.status === "fail" && !task.last_change_request) {
    task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "checkpoint");
  }
  task.last_failure = buildFailureSummary(task, {
    workerResult: workerResult || { exitCode: 1 },
    verifyResult: verifyResult || { pass: false },
    scopeResult: scopeResult || { status: "inconclusive" },
    reviewResult: reviewResult || { pass: false, lanes: [{ name: "review_gate", status: "fail", summary: "review gate has not passed" }] },
    criteriaResult: criteria,
    nextStatus: task.status,
  });
  task.updatedAt = nowIso();
  await writeFailureReport(rootDir, taskState.planId, task);
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: "node_checkpoint_rejected",
    planId: taskState.planId,
    taskId: task.id,
    nextStatus: task.status,
    reason: task.last_failure.reason,
    retryHint: task.last_failure.retryHint,
  });
  await writeSnapshot(rootDir, "node_checkpoint_rejected", { planId: taskState.planId, taskId: task.id, nextStatus: task.status });
  return { status: task.status === "failed" ? "failed" : "retry", task, verifyResult, scopeResult, reviewResult };
}

export async function retryTaskNode(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `node-retry:${options.taskId || "next"}`, () => retryTaskNodeUnlocked(rootDir, options));
}

async function retryTaskNodeUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");
  const task = resolveRetryTask(taskState.tasks, options.taskId);
  const failure = task.last_failure;

  if (failure?.reason === "scope_guard_failed" && options.force !== true) {
    const scopeResult = task.last_scope_result || [...task.evidence].reverse().find((entry) => entry.kind === "scope_guard");
    if (!task.last_change_request && scopeResult?.status === "fail") {
      task.last_change_request = await writeChangeRequest(rootDir, taskState.planId, task, scopeResult, "retry_block");
      await persistTaskState(rootDir, taskState);
    }
    const changeRequest = task.last_change_request?.id ? await readChangeRequest(rootDir, task.last_change_request.id) : task.last_change_request;
    if (!changeRequest || changeRequest.status === "open") {
      await appendLedger(rootDir, {
        type: "node_retry_blocked",
        planId: taskState.planId,
        taskId: task.id,
        reason: "scope_guard_failed",
        nextAction: "review_change_request",
        changeRequestId: task.last_change_request?.id,
      });
      return { status: "change_request_required", task, failure, changeRequest: task.last_change_request || null };
    }

    const currentChanged = await collectGitChangedPaths(rootDir);
    const stillChangedDeniedPaths = currentChanged.available
      ? (changeRequest.deniedPaths || []).filter((filePath) => currentChanged.paths.map(normalizeRelativePath).includes(normalizeRelativePath(filePath)))
      : undefined;
    const currentScope = await scopeGuard(rootDir, {
      taskId: task.id,
      changedPaths: stillChangedDeniedPaths,
      unavailableReason: currentChanged.reason,
    });
    if (currentScope.status === "fail") {
      await appendLedger(rootDir, {
        type: "node_retry_blocked",
        planId: taskState.planId,
        taskId: task.id,
        reason: "scope_cleanup_required",
        nextAction: changeRequest.status === "accepted" ? "apply_scope_or_remove_denied_paths" : "remove_denied_paths",
        changeRequestId: changeRequest.id,
        deniedPaths: currentScope.deniedPaths,
      });
      return { status: "scope_cleanup_required", task, failure, changeRequest, scopeResult: currentScope };
    }
    task.last_scope_result = currentScope;
    task.evidence.push({ kind: "scope_guard", at: nowIso(), ...currentScope });
  }

  task.status = "pending";
  task.manual_retry_count = (task.manual_retry_count || 0) + 1;
  task.maxAttempts = Math.max(task.maxAttempts || 1, task.attempts + 1);
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: "node_retry_reopened",
    planId: taskState.planId,
    taskId: task.id,
    manualRetryCount: task.manual_retry_count,
    previousReason: failure?.reason || "unknown",
  });
  await writeSnapshot(rootDir, "node_retry_reopened", { planId: taskState.planId, taskId: task.id });
  return { status: "pending", task, failure };
}

function hasWeakeningLanguage(value) {
  return /\b(skip|bypass|weaken|remove|omit|auto[-\s]?complete|mark complete|complete faster)\b/i.test(value)
    && /\b(test|tests|verification|review|quality gate|complete|completion)\b/i.test(value);
}

export async function reviewChangeRequest(rootDir, id) {
  const changeRequest = await readChangeRequest(rootDir, id);
  const reasons = [];
  if (changeRequest.kind !== "change_request") reasons.push("invalid kind");
  if (changeRequest.status !== "open") reasons.push(`change request is ${changeRequest.status}`);
  if (!changeRequest.evidence || !changeRequest.rationale) reasons.push("missing evidence or rationale");
  if (changeRequest.invariants?.autoApply !== false) reasons.push("autoApply invariant must be false");
  if (changeRequest.invariants?.requiresSisyphusReview !== true) reasons.push("requiresSisyphusReview invariant must be true");
  if (changeRequest.invariants?.mustNotWeakenVerification !== true) reasons.push("mustNotWeakenVerification invariant must be true");
  if (hasWeakeningLanguage(`${changeRequest.evidence}\n${changeRequest.rationale}`)) reasons.push("proposal appears to weaken verification");

  const audit = {
    kind: "change_request_review",
    at: nowIso(),
    id: changeRequest.id,
    status: reasons.length === 0 ? "reviewable" : "blocked",
    reviewer: "Sisyphus",
    reasons,
    allowedDecisions: reasons.length === 0 ? ["accept", "reject"] : [],
    invariant: {
      accepted: reasons.length === 0,
      evidenceBackedNecessity: Boolean(changeRequest.evidence && changeRequest.rationale),
      noAutomaticScopeExpansion: changeRequest.invariants?.autoApply === false,
      noWeakenedVerification: !hasWeakeningLanguage(`${changeRequest.evidence}\n${changeRequest.rationale}`),
    },
    changeRequest,
  };
  await appendLedger(rootDir, {
    type: "change_request_reviewed",
    changeRequestId: changeRequest.id,
    status: audit.status,
    reasons,
  });
  return audit;
}

export async function resolveChangeRequest(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `change-resolve:${options.id || "unknown"}`, () => resolveChangeRequestUnlocked(rootDir, options));
}

async function resolveChangeRequestUnlocked(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const id = options.id;
  if (!id || typeof id !== "string") throw new Error("change request id is required");
  const decision = normalizeDecision(options.decision);
  if (!decision) throw new Error("decision must be accept or reject");
  const evidence = typeof options.evidence === "string" ? options.evidence.trim() : "";
  const rationale = typeof options.rationale === "string" ? options.rationale.trim() : "";
  if (!evidence) throw new Error("decision evidence is required");
  if (!rationale) throw new Error("decision rationale is required");
  if (hasWeakeningLanguage(`${evidence}\n${rationale}`)) {
    throw new Error("decision appears to weaken verification; keep verification/review gates intact");
  }

  const changeRequest = await readChangeRequest(rootDir, id);
  if (changeRequest.status !== "open") throw new Error(`change request ${id} is already ${changeRequest.status}`);
  const taskState = await loadTaskState(rootDir);
  const task = taskState?.planId === changeRequest.planId
    ? taskState.tasks.find((candidate) => candidate.id === changeRequest.taskId)
    : null;
  const now = nowIso();

  changeRequest.status = decision === "accept" ? "accepted" : "rejected";
  changeRequest.decision = decision;
  changeRequest.reviewedAt = now;
  changeRequest.updatedAt = now;
  changeRequest.reviewer = options.reviewer || "Sisyphus";
  changeRequest.decisionEvidence = evidence;
  changeRequest.decisionRationale = rationale;
  changeRequest.appliedScope = false;
  changeRequest.decisionInvariant = {
    accepted: true,
    explicitDecisionOnly: true,
    noAutomaticScopeExpansion: true,
    mustNotWeakenVerification: true,
  };

  if (task) {
    task.change_resolution = {
      id,
      decision,
      appliedScope: false,
      at: now,
      evidence,
      rationale,
    };
    if (task.last_failure) task.last_failure.resolvedBy = id;
  }

  if (decision === "accept" && options.applyScope === true) {
    if (!task) throw new Error(`task ${changeRequest.taskId} not found for change request ${id}`);
    task.writable_paths = uniqueStrings([...(task.writable_paths || []), ...(changeRequest.deniedPaths || [])]);
    task.change_resolution.appliedScope = true;
    task.last_scope_result = null;
    changeRequest.appliedScope = true;
    changeRequest.appliedWritablePaths = task.writable_paths;
  }

  if (taskState && task) await persistTaskState(rootDir, taskState);

  const jsonPath = resolveHelixPath(rootDir, "changes", `${id}.json`);
  const mdPath = resolveHelixPath(rootDir, "changes", `${id}.md`);
  changeRequest.reportJsonPath = path.relative(rootDir, jsonPath);
  changeRequest.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, changeRequest);
  await writeFile(mdPath, renderChangeRequestMarkdown(changeRequest), "utf8");
  await writeOpenChangesIndex(rootDir);
  await appendLedger(rootDir, {
    type: "change_request_resolved",
    planId: changeRequest.planId,
    taskId: changeRequest.taskId,
    changeRequestId: id,
    decision,
    appliedScope: changeRequest.appliedScope,
  });
  await writeSnapshot(rootDir, "change_request_resolved", { changeRequestId: id, decision, appliedScope: changeRequest.appliedScope });
  return { status: changeRequest.status, changeRequest, task: task || null };
}

function normalizeDecision(decision) {
  if (decision === "accept" || decision === "accepted") return "accept";
  if (decision === "reject" || decision === "rejected") return "reject";
  return null;
}

async function readChangeRequest(rootDir, id) {
  if (!/^CR-[a-z0-9]+$/i.test(id || "")) throw new Error(`invalid change request id: ${id}`);
  const changeRequest = await readJson(resolveHelixPath(rootDir, "changes", `${id}.json`), null);
  if (!changeRequest) throw new Error(`unknown change request: ${id}`);
  return changeRequest;
}

function resolveNodeTask(tasks, taskId, allowedStatuses) {
  const task = taskId ? tasks.find((candidate) => candidate.id === taskId) : findRunnableTask(tasks) || tasks.find((candidate) => allowedStatuses.includes(candidate.status));
  if (!task) throw new Error(taskId ? `unknown task: ${taskId}` : "no task available for node");
  if (!allowedStatuses.includes(task.status)) {
    throw new Error(`task ${task.id} status ${task.status} cannot run this node`);
  }
  return task;
}

function resolveRetryTask(tasks, taskId) {
  const task = taskId
    ? tasks.find((candidate) => candidate.id === taskId)
    : tasks.find((candidate) => candidate.status === "failed") || findRunnableTask(tasks);
  if (!task) throw new Error(taskId ? `unknown task: ${taskId}` : "no failed or pending task available for retry");
  if (!["failed", "pending"].includes(task.status)) {
    throw new Error(`task ${task.id} status ${task.status} cannot run retry`);
  }
  return task;
}

function shouldFailTask(task, verifyResult, scopeResult, reviewResult) {
  if (scopeResult?.status === "fail") return true;
  if (scopeResult && scopeResult.status !== "pass") return true;
  if (verifyResult?.pass === true && reviewResult?.kind === "review_gate" && reviewResult.pass === false) return true;
  return task.attempts >= task.maxAttempts;
}

function rejectionReason(workerResult, verifyResult, scopeResult) {
  if (workerResult.exitCode !== 0) return "worker_failed";
  if (!verifyResult.pass) return "verifier_failed";
  if (scopeResult.status === "fail") return "scope_guard_failed";
  if (scopeResult.status !== "pass") return "scope_guard_inconclusive";
  return "unknown";
}

function gateRejectionReason(workerResult, verifyResult, scopeResult, reviewResult, criteriaResult) {
  const base = rejectionReason(workerResult, verifyResult, scopeResult);
  if (base !== "unknown") return base;
  if (criteriaResult && criteriaResult.pass === false) return "criteria_failed";
  if (reviewResult?.pass === false) return "review_gate_failed";
  return "unknown";
}

function buildFailureSummary(task, { workerResult, verifyResult, scopeResult, reviewResult, criteriaResult, nextStatus }) {
  const reason = gateRejectionReason(workerResult, verifyResult, scopeResult, reviewResult, criteriaResult);
  const failed = failureTarget(reason, workerResult, verifyResult, scopeResult, criteriaResult);
  const observed = failureObserved(reason, workerResult, verifyResult, scopeResult, reviewResult, criteriaResult);
  const fixBy = failureFixBy(reason, task, scopeResult, reviewResult, criteriaResult);
  const doNot = failureDoNot(reason);
  return {
    kind: "failure_summary",
    at: nowIso(),
    taskId: task.id,
    reason,
    nextStatus,
    failed,
    observed,
    fixBy,
    doNot,
    changeRequest: task.last_change_request || null,
    retryHint: [
      `FAILED: ${failed}`,
      `OBSERVED: ${observed}`,
      `FIX BY: ${fixBy}`,
      `DO NOT: ${doNot}`,
    ].join("\n"),
  };
}

function failureTarget(reason, workerResult, verifyResult, scopeResult, criteriaResult) {
  if (reason === "worker_failed") return workerResult.command || "worker command";
  if (reason === "verifier_failed") {
    const failedCommand = verifyResult.results?.find((result) => result.exitCode !== 0);
    return failedCommand?.command || "verifier command";
  }
  if (reason === "scope_guard_failed") return `scope guard denied ${scopeResult.deniedPaths?.join(", ") || "changed paths"}`;
  if (reason === "scope_guard_inconclusive") return "scope guard did not produce passing changed-path evidence";
  if (reason === "criteria_failed") return `success criteria (${criteriaResult?.passed || 0}/${criteriaResult?.total || 0} pass)`;
  if (reason === "review_gate_failed") return "review gate";
  return "checkpoint gate";
}

function failureObserved(reason, workerResult, verifyResult, scopeResult, reviewResult, criteriaResult) {
  if (reason === "worker_failed") return commandObservation(workerResult);
  if (reason === "verifier_failed") {
    const failedCommand = verifyResult.results?.find((result) => result.exitCode !== 0);
    return commandObservation(failedCommand || { exitCode: 1 });
  }
  if (reason === "scope_guard_failed") {
    return `changed=${(scopeResult.changedPaths || []).join(", ") || "none"}; denied=${(scopeResult.deniedPaths || []).join(", ") || "none"}`;
  }
  if (reason === "scope_guard_inconclusive") {
    return `scopeStatus=${scopeResult.status || "missing"}; reason=${scopeResult.reason || "missing changed-path evidence"}`;
  }
  if (reason === "criteria_failed") {
    return `criteria pass=${criteriaResult?.passed || 0}, pending=${criteriaResult?.pending || 0}, fail=${criteriaResult?.failed || 0}`;
  }
  if (reason === "review_gate_failed") {
    const failedLanes = (reviewResult?.lanes || []).filter((lane) => lane.status === "fail");
    return failedLanes.map((lane) => `${lane.name}: ${lane.summary}`).join("; ") || "review gate failed without lane details";
  }
  return "missing or inconclusive gate evidence";
}

function commandObservation(result) {
  const stdout = truncateForSummary((result.stdout || "").trim());
  const stderr = truncateForSummary((result.stderr || "").trim());
  return [`exitCode=${result.exitCode ?? 1}`, stdout ? `stdout=${stdout}` : null, stderr ? `stderr=${stderr}` : null].filter(Boolean).join("; ");
}

function failureFixBy(reason, task, scopeResult, reviewResult, criteriaResult) {
  if (reason === "worker_failed") return "修复 worker_command 或交给 Hephaestus 重新实现同一任务，然后重跑 execute。";
  if (reason === "verifier_failed") return "按失败命令输出修正实现，不改验收标准；修完后重跑 verify 和 checkpoint。";
  if (reason === "scope_guard_failed") {
    return `移除计划外改动或创建 ChangeRequest 扩展 writable_paths。当前允许范围：${task.writable_paths.join(", ") || "(none)"}；被拒绝：${(scopeResult.deniedPaths || []).join(", ") || "(unknown)"}`;
  }
  if (reason === "scope_guard_inconclusive") {
    return "恢复可审计的改动证据后重跑 scope/checkpoint；非 Git 项目应使用文件清单 fallback，或初始化 Git 以获得可靠 changed paths。";
  }
  if (reason === "criteria_failed") {
    return `补齐 successCriteria 证据后重跑 review/checkpoint。当前 pass=${criteriaResult?.passed || 0}, pending=${criteriaResult?.pending || 0}, fail=${criteriaResult?.failed || 0}。`;
  }
  if (reason === "review_gate_failed") {
    const failedLanes = (reviewResult?.lanes || []).filter((lane) => lane.status === "fail");
    return failedLanes.map((lane) => lane.fixBy).filter(Boolean).join("；") || "修复 review gate 指出的阻塞项，然后重跑 review 和 checkpoint。";
  }
  return "补齐缺失证据后重新进入 verify/checkpoint。";
}

function failureDoNot(reason) {
  if (reason === "scope_guard_failed") return "不要直接重试同一 worker；先处理范围漂移。";
  if (reason === "scope_guard_inconclusive") return "不要把“看不到改动”当作“没有越界”。";
  if (reason === "verifier_failed") return "不要降低或删除 verify_commands 来制造 PASS。";
  if (reason === "worker_failed") return "不要跳过 worker 失败直接 checkpoint。";
  if (reason === "review_gate_failed") return "不要绕过 review gate 或删除 review_commands 来制造 PASS。";
  if (reason === "criteria_failed") return "不要删除 successCriteria 或伪造 criterion evidence 来制造 PASS。";
  return "不要在证据不完整时 checkpoint。";
}

function truncateForSummary(value, limit = 500) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 15)}...[truncated]`;
}

export async function persistTaskState(rootDir, taskState) {
  taskState.updatedAt = nowIso();
  await writeJsonAtomic(resolveHelixPath(rootDir, "team", "tasks.json"), taskState);
  const plan = await readJson(resolveHelixPath(rootDir, "plans", `${taskState.planId}.json`));
  plan.tasks = taskState.tasks;
  plan.updatedAt = nowIso();
  await writeJsonAtomic(resolveHelixPath(rootDir, "plans", `${taskState.planId}.json`), plan);
  await writeTasksMarkdown(rootDir, plan);
}

export async function runWorker(rootDir, task, options = {}) {
  const command = options.workerCommand || task.worker_command;
  if (!command) {
    return {
      kind: "worker",
      at: nowIso(),
      command: null,
      exitCode: 0,
      stdout: "No worker_command configured; treating implementation as externally completed.",
      stderr: "",
    };
  }
  const result = await runCommand(command, rootDir, options.timeoutMs);
  return { kind: "worker", at: nowIso(), command, ...result };
}

export async function runVerifier(rootDir, task) {
  if (!Array.isArray(task.verify_commands) || task.verify_commands.length === 0) {
    return {
      kind: "verifier",
      at: nowIso(),
      pass: false,
      results: [{
        command: null,
        exitCode: 1,
        stdout: "",
        stderr: "verify_commands must contain at least one command",
      }],
    };
  }

  const results = [];
  for (const command of task.verify_commands) {
    const result = await runCommand(command, rootDir);
    results.push({ command, ...result });
    if (result.exitCode !== 0) break;
  }

  return {
    kind: "verifier",
    at: nowIso(),
    pass: results.every((result) => result.exitCode === 0),
    results,
  };
}

export async function runReviewGate(rootDir, task, evidence = {}) {
  const workerResult = evidence.workerResult || [...task.evidence].reverse().find((entry) => entry.kind === "worker");
  const verifyResult = evidence.verifyResult || task.last_verify_result || [...task.evidence].reverse().find((entry) => entry.kind === "verifier");
  const scopeResult = evidence.scopeResult || task.last_scope_result || [...task.evidence].reverse().find((entry) => entry.kind === "scope_guard");
  const criteria = criteriaStatus(task);
  const rulesContext = await scanProjectRules(rootDir, {
    targetPaths: uniqueStrings([...(task.writable_paths || []), ...((scopeResult?.changedPaths) || [])]),
  });
  const reviewCommandResults = [];
  const standardsCommandResults = [];

  for (const command of task.review_commands || []) {
    const result = await runCommand(command, rootDir);
    reviewCommandResults.push({ command, ...result });
    if (result.exitCode !== 0) break;
  }

  for (const command of task.standards_commands || []) {
    const result = await runCommand(command, rootDir);
    standardsCommandResults.push({ command, ...result });
    if (result.exitCode !== 0) break;
  }

  const lanes = [
    reviewLane("goal_compliance", "Oracle", workerResult?.exitCode === 0 && verifyResult?.pass === true, {
      summary: workerResult?.exitCode === 0 && verifyResult?.pass === true
        ? "worker completed and verifier passed against task acceptance commands"
        : "worker or verifier evidence does not prove the task goal",
      fixBy: "修复实现或验收失败后，重新运行 execute/verify。",
    }),
    reviewLane("scope_fidelity", "Momus", scopeResult?.status === "pass", {
      statusOverride: scopeResult?.status === "inconclusive" && (task.writable_paths || []).length === 0 ? "warn" : undefined,
      summary: scopeResult?.status === "fail"
        ? `out-of-scope paths: ${(scopeResult.deniedPaths || []).join(", ") || "unknown"}`
        : scopeResult?.status === "inconclusive"
          ? `scope guard inconclusive: ${scopeResult.reason || "no changed-path evidence"}`
          : "changed paths stay within writable_paths",
      fixBy: "移除范围外改动，或走 ChangeRequest 扩展任务边界。",
    }),
    reviewLane("evidence_quality", "Metis", verifierEvidenceComplete(task, verifyResult), {
      summary: verifierEvidenceComplete(task, verifyResult)
        ? "all verifier commands produced passing evidence"
        : "verifier evidence is missing, partial, or failing",
      fixBy: "补齐并运行覆盖真实行为的 verify_commands。",
    }),
    reviewLane("success_criteria", "Oracle", criteria.pass, {
      summary: criteria.pass
        ? `${criteria.passed}/${criteria.total} success criteria passed`
        : `criteria not satisfied: pass=${criteria.passed}, pending=${criteria.pending}, fail=${criteria.failed}`,
      fixBy: "补齐 criterion evidence，或修复实现后重新运行 verifier；不要删除 successCriteria。",
    }),
    reviewLane("project_rules_context", "Momus", rulesContext.matched > 0, {
      statusOverride: rulesContext.matched > 0 ? undefined : "warn",
      summary: rulesContext.matched > 0
        ? `${rulesContext.matched}/${rulesContext.total} project rule(s) injected from ${rulesContext.reportMdPath}`
        : "no project rules matched; review relies on prompt pack and commands",
      fixBy: "补充 CLAUDE.md/AGENTS.md/.cursor/rules/.github/instructions，或确认本任务无需项目规则。",
    }),
    reviewLane("explicit_review_commands", "Oracle", reviewCommandResults.every((result) => result.exitCode === 0), {
      statusOverride: reviewCommandResults.length === 0 ? "warn" : undefined,
      summary: reviewCommandResults.length === 0
        ? "no review_commands configured; deterministic review lanes only"
        : reviewCommandResults.every((result) => result.exitCode === 0)
          ? `${reviewCommandResults.length} review command(s) passed`
          : commandObservation(reviewCommandResults.find((result) => result.exitCode !== 0) || { exitCode: 1 }),
      fixBy: "按 review_commands 的失败输出修复，不要删除 review_commands 绕过复核。",
    }),
    reviewLane("project_standards", "Momus", standardsCommandResults.every((result) => result.exitCode === 0), {
      statusOverride: standardsCommandResults.length === 0 ? "warn" : undefined,
      summary: standardsCommandResults.length === 0
        ? "no standards_commands configured; relying on project instructions and explicit review lanes"
        : standardsCommandResults.every((result) => result.exitCode === 0)
          ? `${standardsCommandResults.length} standards command(s) passed`
          : commandObservation(standardsCommandResults.find((result) => result.exitCode !== 0) || { exitCode: 1 }),
      fixBy: "按 standards_commands 的失败输出修复项目规范问题，不要删除规范门来制造 PASS。",
    }),
  ];

  return {
    kind: "review_gate",
    at: nowIso(),
    pass: lanes.every((lane) => lane.status !== "fail"),
    reviewerAgents: ["Oracle", "Momus", "Metis"],
    lanes,
    reviewCommandResults,
    standardsCommandResults,
    successCriteria: criteria,
    rulesContextPath: rulesContext.reportMdPath,
  };
}

function reviewLane(name, agent, condition, options) {
  const status = options.statusOverride || (condition ? "pass" : "fail");
  return {
    name,
    agent,
    status,
    summary: options.summary,
    fixBy: options.fixBy,
  };
}

function verifierEvidenceComplete(task, verifyResult) {
  if (!verifyResult || verifyResult.kind !== "verifier") return false;
  if (verifyResult.pass !== true) return false;
  return Array.isArray(verifyResult.results) && verifyResult.results.length > 0 && verifyResult.results.length === task.verify_commands.length;
}

export function runCommand(command, cwd, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HELIX_RUNTIME: "1" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      settled = true;
      resolve({ exitCode: 124, stdout, stderr: `${stderr}\nCommand timed out after ${timeoutMs}ms`.trim() });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

export async function collectGitDiff(rootDir) {
  const gitDir = path.join(rootDir, ".git");
  if (!existsSync(gitDir)) return "";
  const result = await runCommand("git diff -- . ':!.helix'", rootDir, 30_000);
  return result.exitCode === 0 ? result.stdout : "";
}

export async function collectGitChangedPaths(rootDir) {
  const gitDir = path.join(rootDir, ".git");
  if (!existsSync(gitDir)) {
    try {
      const manifest = await collectFileManifest(rootDir);
      return { available: true, source: "file_manifest", paths: Object.keys(manifest).sort(), fingerprints: manifest };
    } catch (error) {
      return { available: false, reason: `git repository not found and file manifest failed: ${error instanceof Error ? error.message : String(error)}`, paths: [] };
    }
  }

  const diff = await runCommand("git diff --name-only -- . ':!.helix'", rootDir, 30_000);
  const untracked = await runCommand("git ls-files --others --exclude-standard -- . ':!.helix'", rootDir, 30_000);
  if (diff.exitCode !== 0 || untracked.exitCode !== 0) {
    return {
      available: false,
      reason: [diff.stderr, untracked.stderr].filter(Boolean).join("\n") || "git changed path collection failed",
      paths: [],
    };
  }

  return {
    available: true,
    source: "git",
    paths: [...new Set([...splitPathLines(diff.stdout), ...splitPathLines(untracked.stdout)])].sort(),
  };
}

function changedPathsIntroducedByTask(beforeChanged, afterChanged) {
  if (!beforeChanged.available || !afterChanged.available) {
    return undefined;
  }
  if (beforeChanged.fingerprints && afterChanged.fingerprints) {
    const before = beforeChanged.fingerprints;
    const after = afterChanged.fingerprints;
    return Object.keys(after)
      .filter((filePath) => before[filePath] !== after[filePath])
      .map(normalizeRelativePath)
      .sort();
  }
  const before = new Set(beforeChanged.paths.map(normalizeRelativePath));
  return afterChanged.paths.map(normalizeRelativePath).filter((filePath) => !before.has(filePath));
}

const FILE_MANIFEST_SKIP_DIRS = new Set([".git", ".helix", "node_modules"]);

async function collectFileManifest(rootDir, relativeDir = "") {
  const absoluteDir = path.join(rootDir, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const manifest = {};
  for (const entry of entries) {
    const relativePath = normalizeRelativePath(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      if (FILE_MANIFEST_SKIP_DIRS.has(entry.name)) continue;
      Object.assign(manifest, await collectFileManifest(rootDir, relativePath));
      continue;
    }
    if (!entry.isFile()) continue;
    const fileStat = await stat(path.join(rootDir, relativePath));
    manifest[relativePath] = `${fileStat.size}:${fileStat.mtimeMs}`;
  }
  return manifest;
}

function splitPathLines(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export async function scopeGuard(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run helix plan --from <file>");

  const task = resolveGuardTask(taskState.tasks, options.taskId);
  const collected = Array.isArray(options.changedPaths)
    ? { available: true, paths: options.changedPaths }
    : await collectGitChangedPaths(rootDir);

  if (!collected.available) {
    const guarded = (task.writable_paths || []).length > 0;
    const result = {
      status: guarded ? "fail" : "inconclusive",
      taskId: task.id,
      reason: options.unavailableReason || collected.reason,
      changedPaths: [],
      writablePaths: task.writable_paths,
      deniedPaths: [],
    };
    await appendLedger(rootDir, { type: guarded ? "scope_guard_failed" : "scope_guard_inconclusive", planId: taskState.planId, taskId: task.id, reason: result.reason });
    return result;
  }

  const changedPaths = collected.paths.map(normalizeRelativePath);
  const writablePaths = task.writable_paths.map(normalizeRelativePath);
  const deniedPaths = changedPaths.filter((filePath) => !pathAllowed(filePath, writablePaths));
  const status = deniedPaths.length === 0 ? "pass" : "fail";
  const result = {
    status,
    taskId: task.id,
    changedPaths,
    writablePaths,
    deniedPaths,
  };

  await appendLedger(rootDir, {
    type: status === "pass" ? "scope_guard_passed" : "scope_guard_failed",
    planId: taskState.planId,
    taskId: task.id,
    changedPathCount: changedPaths.length,
    deniedPaths,
  });
  return result;
}

function resolveGuardTask(tasks, taskId) {
  const task = taskId
    ? tasks.find((candidate) => candidate.id === taskId)
    : tasks.find((candidate) => ["in_progress", "verifying", "pending"].includes(candidate.status));
  if (!task) {
    throw new Error(taskId ? `unknown task: ${taskId}` : "no active or pending task found");
  }
  return task;
}

function normalizeRelativePath(filePath) {
  return filePath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

export function pathAllowed(filePath, writablePaths) {
  if (writablePaths.length === 0) return false;
  const normalizedFile = normalizeRelativePath(filePath);
  return writablePaths.some((pattern) => pathMatchesPattern(normalizedFile, pattern));
}

export function pathMatchesPattern(filePath, pattern) {
  const normalizedPattern = normalizeRelativePath(pattern);
  if (normalizedPattern === filePath) return true;
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return filePath === prefix || filePath.startsWith(`${prefix}/`);
  }
  if (!normalizedPattern.includes("*")) {
    return filePath.startsWith(`${normalizedPattern.replace(/\/$/, "")}/`);
  }

  const escaped = normalizedPattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(filePath);
}

export async function writeOutbox(rootDir, task, workerResult) {
  const outboxPath = resolveHelixPath(rootDir, "team", "outbox", `${task.id}-${Date.now()}.json`);
  await writeJsonAtomic(outboxPath, {
    to: "Atlas",
    from: task.owner || "worker",
    summary: `${task.id} done-claim`,
    taskId: task.id,
    at: nowIso(),
    workerResult,
  });
}

export async function sendTeamMessage(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const to = normalizeAgentName(options.to);
  const from = normalizeAgentName(options.from || "Sisyphus");
  const body = typeof options.body === "string" ? options.body.trim() : "";
  if (!to) throw new Error("message recipient is required");
  if (!body) throw new Error("message body is required");
  const id = createWorkId("msg");
  const message = {
    id,
    kind: "team_message",
    at: nowIso(),
    from,
    to,
    summary: options.summary || body.slice(0, 120),
    body,
    status: "unread",
  };
  const inboxPath = resolveHelixPath(rootDir, "team", "inbox", to, `${id}.json`);
  const outboxPath = resolveHelixPath(rootDir, "team", "outbox", from, `${id}.json`);
  await writeJsonAtomic(inboxPath, message);
  await writeJsonAtomic(outboxPath, message);
  await appendTeamMessageIndex(rootDir, message);
  await appendLedger(rootDir, { type: "team_message_sent", messageId: id, from, to, summary: message.summary });
  return {
    ...message,
    inboxPath: path.relative(rootDir, inboxPath),
    outboxPath: path.relative(rootDir, outboxPath),
  };
}

function normalizeAgentName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/[^\w.-]/g, "_");
}

async function appendTeamMessageIndex(rootDir, message) {
  const line = `- ${message.at} ${message.from} -> ${message.to}: ${message.summary} (${message.id})\n`;
  await appendFile(resolveHelixPath(rootDir, "team", "messages.md"), line, "utf8");
}

export async function listTeamMessages(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const agent = normalizeAgentName(options.agent || options.to);
  const baseDir = agent ? resolveHelixPath(rootDir, "team", "inbox", agent) : resolveHelixPath(rootDir, "team", "inbox");
  const messages = [];
  if (agent) {
    for (const fileName of await safeReadDir(baseDir)) {
      if (/^msg_.+\.json$/.test(fileName)) {
        messages.push(await readJson(path.join(baseDir, fileName)));
      }
    }
  } else {
    for (const agentDir of await safeReadDir(baseDir)) {
      const dirPath = path.join(baseDir, agentDir);
      for (const fileName of await safeReadDir(dirPath)) {
        if (/^msg_.+\.json$/.test(fileName)) {
          messages.push(await readJson(path.join(dirPath, fileName)));
        }
      }
    }
  }
  messages.sort((left, right) => String(left.at).localeCompare(String(right.at)));
  await appendLedger(rootDir, { type: "team_messages_listed", agent: agent || "all", count: messages.length });
  return messages;
}

async function safeReadDir(dirPath, options = undefined) {
  try {
    return await readdir(dirPath, options);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function writeCheckpoint(rootDir, planId, task, verifyResult, scopeResult = null, reviewResult = null) {
  const checkpointPath = resolveHelixPath(rootDir, "checkpoints", `${planId}-${task.id}.json`);
  await writeJsonAtomic(checkpointPath, {
    planId,
    taskId: task.id,
    subject: task.subject,
    verifiedAt: nowIso(),
    verifyResult,
    scopeResult,
    reviewResult,
  });
}

export async function writeChangeRequest(rootDir, planId, task, scopeResult, source = "scope_guard") {
  await ensureHelixDirs(rootDir);
  const signature = hashContent(JSON.stringify({
    planId,
    taskId: task.id,
    deniedPaths: scopeResult.deniedPaths || [],
    writablePaths: scopeResult.writablePaths || task.writable_paths || [],
  })).slice(0, 12);
  const id = `CR-${signature}`;
  const jsonPath = resolveHelixPath(rootDir, "changes", `${id}.json`);
  const mdPath = resolveHelixPath(rootDir, "changes", `${id}.md`);
  const existing = await readJson(jsonPath, null);
  const changeRequest = existing || {
    id,
    kind: "change_request",
    status: "open",
    source,
    planId,
    taskId: task.id,
    subject: task.subject,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    evidence: `scope guard denied paths: ${(scopeResult.deniedPaths || []).join(", ") || "unknown"}`,
    rationale: "Worker changed files outside task.writable_paths; Sisyphus/Prometheus must decide whether to revise scope or reject the change.",
    deniedPaths: scopeResult.deniedPaths || [],
    changedPaths: scopeResult.changedPaths || [],
    writablePaths: scopeResult.writablePaths || task.writable_paths || [],
    proposedActions: [
      "revert_or_move_out_of_scope_changes",
      "revise_plan_writable_paths_after_review",
      "split_into_new_task",
    ],
    invariants: {
      autoApply: false,
      requiresSisyphusReview: true,
      mustNotWeakenVerification: true,
    },
  };
  if (existing) {
    changeRequest.updatedAt = nowIso();
    changeRequest.lastSeenSource = source;
  }
  changeRequest.reportJsonPath = path.relative(rootDir, jsonPath);
  changeRequest.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, changeRequest);
  await writeFile(mdPath, renderChangeRequestMarkdown(changeRequest), "utf8");
  await writeOpenChangesIndex(rootDir);
  await appendLedger(rootDir, {
    type: existing ? "change_request_reused" : "change_request_created",
    planId,
    taskId: task.id,
    changeRequestId: id,
    deniedPaths: changeRequest.deniedPaths,
    reportPath: changeRequest.reportMdPath,
  });
  return changeRequest;
}

function renderChangeRequestMarkdown(changeRequest) {
  return `# ChangeRequest ${changeRequest.id}

| Field | Value |
| --- | --- |
| Status | \`${changeRequest.status}\` |
| Source | \`${changeRequest.source}\` |
| Plan | \`${changeRequest.planId}\` |
| Task | \`${changeRequest.taskId}\` |
| Subject | ${changeRequest.subject} |

## Evidence

${changeRequest.evidence}

## Rationale

${changeRequest.rationale}

${changeRequest.decision ? `## Decision

- Reviewer: ${changeRequest.reviewer || "Sisyphus"}
- Decision: \`${changeRequest.decision}\`
- Reviewed at: ${changeRequest.reviewedAt}
- Applied scope: ${Boolean(changeRequest.appliedScope)}

### Decision Evidence

${changeRequest.decisionEvidence}

### Decision Rationale

${changeRequest.decisionRationale}
` : ""}

## Paths

- Writable: ${changeRequest.writablePaths.join(", ") || "(none)"}
- Changed: ${changeRequest.changedPaths.join(", ") || "(none)"}
- Denied: ${changeRequest.deniedPaths.join(", ") || "(none)"}
${changeRequest.appliedWritablePaths ? `- Applied writable paths: ${changeRequest.appliedWritablePaths.join(", ") || "(none)"}` : ""}

## Allowed Resolutions

${changeRequest.proposedActions.map((action) => `- ${action}`).join("\n")}

## Invariants

- autoApply: ${changeRequest.invariants.autoApply}
- requiresSisyphusReview: ${changeRequest.invariants.requiresSisyphusReview}
- mustNotWeakenVerification: ${changeRequest.invariants.mustNotWeakenVerification}
`;
}

async function writeOpenChangesIndex(rootDir) {
  const changes = await listChangeRequests(rootDir);
  const openChanges = changes.filter((change) => change.status === "open");
  const lines = ["# Open ChangeRequests", ""];
  if (openChanges.length === 0) {
    lines.push("No open change requests.");
  } else {
    for (const change of openChanges) {
      lines.push(`- ${change.id}: ${change.subject}`);
      lines.push(`  - Task: ${change.taskId}`);
      lines.push(`  - Denied: ${(change.deniedPaths || []).join(", ") || "(none)"}`);
      lines.push(`  - Report: ${change.reportMdPath}`);
    }
  }
  await writeFile(resolveHelixPath(rootDir, "changes", "open.md"), `${lines.join("\n")}\n`, "utf8");
}

export async function listChangeRequests(rootDir) {
  await ensureHelixDirs(rootDir);
  let entries = [];
  try {
    entries = await readdir(resolveHelixPath(rootDir, "changes"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const changes = [];
  for (const entry of entries.filter((name) => /^CR-.+\.json$/.test(name)).sort()) {
    changes.push(await readJson(resolveHelixPath(rootDir, "changes", entry)));
  }
  return changes;
}

export async function writeReviewReport(rootDir, planId, task, reviewResult) {
  await ensureHelixDirs(rootDir);
  const basePath = resolveHelixPath(rootDir, "reports", "reviews", `${planId}-${task.id}`);
  const jsonPath = `${basePath}.json`;
  const mdPath = `${basePath}.md`;
  reviewResult.reportJsonPath = path.relative(rootDir, jsonPath);
  reviewResult.reportMdPath = path.relative(rootDir, mdPath);
  const report = {
    planId,
    taskId: task.id,
    subject: task.subject,
    status: reviewResult.pass ? "pass" : "fail",
    reviewerAgents: reviewResult.reviewerAgents,
    lanes: reviewResult.lanes,
    reviewCommandResults: reviewResult.reviewCommandResults,
    standardsCommandResults: reviewResult.standardsCommandResults || [],
    at: reviewResult.at,
  };
  await writeJsonAtomic(jsonPath, report);
  await writeFile(mdPath, renderReviewMarkdown(report), "utf8");
  await appendLedger(rootDir, {
    type: "review_report_written",
    planId,
    taskId: task.id,
    pass: reviewResult.pass,
    reportPath: reviewResult.reportMdPath,
  });
  return report;
}

function renderReviewMarkdown(report) {
  const lanes = report.lanes.map((lane) => `| ${lane.name} | ${lane.agent} | ${lane.status} | ${lane.summary} |`).join("\n");
  const failed = report.lanes
    .filter((lane) => lane.status === "fail")
    .map((lane) => `- ${lane.name}: ${lane.fixBy}`)
    .join("\n");
  const standards = (report.standardsCommandResults || [])
    .map((result) => `| \`${result.command}\` | ${result.exitCode} |`)
    .join("\n");
  return `# Review Gate

| Field | Value |
| --- | --- |
| Plan | \`${report.planId}\` |
| Task | \`${report.taskId}\` |
| Subject | ${report.subject} |
| Status | \`${report.status}\` |
| Agents | ${report.reviewerAgents.join(", ")} |

## Lanes

| Lane | Agent | Status | Summary |
| --- | --- | --- | --- |
${lanes}

## Blocking Fixes

${failed || "- None"}

## Standards Commands

${standards ? `| Command | Exit Code |
| --- | --- |
${standards}` : "- None"}
`;
}

export async function writeFailureReport(rootDir, planId, task) {
  if (!task.last_failure) return null;
  await ensureHelixDirs(rootDir);
  const basePath = resolveHelixPath(rootDir, "reports", "failures", `${planId}-${task.id}`);
  const jsonPath = `${basePath}.json`;
  const mdPath = `${basePath}.md`;
  task.last_failure.reportJsonPath = path.relative(rootDir, jsonPath);
  task.last_failure.reportMdPath = path.relative(rootDir, mdPath);
  const report = {
    planId,
    taskId: task.id,
    subject: task.subject,
    status: task.status,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    failure: task.last_failure,
  };
  await writeJsonAtomic(jsonPath, report);
  await writeFile(mdPath, renderFailureMarkdown(report), "utf8");
  await appendLedger(rootDir, {
    type: "failure_report_written",
    planId,
    taskId: task.id,
    reason: task.last_failure.reason,
    reportPath: task.last_failure.reportMdPath,
  });
  return report;
}

function renderFailureMarkdown(report) {
  const failure = report.failure;
  return `# Task Failure

| Field | Value |
| --- | --- |
| Plan | \`${report.planId}\` |
| Task | \`${report.taskId}\` |
| Subject | ${report.subject} |
| Status | \`${report.status}\` |
| Attempts | ${report.attempts}/${report.maxAttempts} |
| Reason | \`${failure.reason}\` |

## Retry Hint

\`\`\`text
${failure.retryHint}
\`\`\`

${failure.changeRequest ? `## ChangeRequest

- ID: \`${failure.changeRequest.id}\`
- Report: ${failure.changeRequest.reportMdPath}
- Denied paths: ${(failure.changeRequest.deniedPaths || []).join(", ") || "(none)"}
` : ""}
`;
}

export async function appendWisdom(rootDir, task, verifyResult) {
  const line = `- ${nowIso()} ${task.id}: ${task.subject} verified by ${verifyResult.results.length} command(s).\n`;
  await appendFile(resolveHelixPath(rootDir, "wisdom", "verification.md"), line, "utf8");
}

export async function writeWorkflowSummary(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const status = await statusReport(rootDir);
  const taskState = await loadTaskState(rootDir);
  const changes = await listChangeRequests(rootDir);
  const latestSnapshot = await readJson(resolveHelixPath(rootDir, "snapshots", "latest.json"), null);
  const wisdom = await readTextFile(resolveHelixPath(rootDir, "wisdom", "verification.md"), "");
  const tasks = (taskState?.tasks || []).map((task) => ({
    id: task.id,
    subject: task.subject,
    status: task.status,
    attempts: task.attempts,
    category: task.category,
    verifyCommands: task.verify_commands || [],
    reviewCommands: task.review_commands || [],
    standardsCommands: task.standards_commands || [],
    checkpointPath: task.status === "completed" && taskState?.planId ? `.helix/checkpoints/${taskState.planId}-${task.id}.json` : null,
    reviewReportPath: task.last_review_result?.reportMdPath || null,
    failureReportPath: task.last_failure?.reportMdPath || null,
    changeRequestPath: task.last_change_request?.reportMdPath || null,
  }));
  const summary = {
    kind: "workflow_summary",
    version: STATE_VERSION,
    at: nowIso(),
    reason: options.reason || "manual",
    ok: status.total > 0 && status.completed === status.total && status.failed === 0 && status.pending === 0 && status.in_progress === 0 && status.verifying === 0 && status.openChanges === 0,
    planId: status.planId,
    status,
    latestSnapshot: latestSnapshot ? { id: latestSnapshot.id, stage: latestSnapshot.stage, at: latestSnapshot.at } : null,
    tasks,
    changes: changes.map(summarizeChangeForContext),
    wisdom: wisdom.trim().split(/\r?\n/).filter(Boolean).slice(-20),
  };
  const jsonPath = resolveHelixPath(rootDir, "reports", "workflow-summary.json");
  const mdPath = resolveHelixPath(rootDir, "reports", "workflow-summary.md");
  summary.reportJsonPath = path.relative(rootDir, jsonPath);
  summary.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, summary);
  await writeFile(mdPath, renderWorkflowSummaryMarkdown(summary), "utf8");
  await appendLedger(rootDir, {
    type: "workflow_summary_written",
    planId: summary.planId,
    ok: summary.ok,
    reportPath: summary.reportMdPath,
    reason: summary.reason,
  });
  return summary;
}

async function readTextFile(filePath, fallback = "") {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function renderWorkflowSummaryMarkdown(summary) {
  const status = summary.status || {};
  const lines = [
    "# HelixFlow Workflow Summary",
    "",
    `Generated: ${summary.at}`,
    `Reason: ${summary.reason}`,
    `Status: ${summary.ok ? "PASS" : "ATTENTION_REQUIRED"}`,
    "",
    "## Run State",
    "",
    `- Plan: ${summary.planId || "(none)"}`,
    `- Counts: total=${status.total || 0}, completed=${status.completed || 0}, pending=${status.pending || 0}, verifying=${status.verifying || 0}, failed=${status.failed || 0}, openChanges=${status.openChanges || 0}`,
    `- Latest snapshot: ${summary.latestSnapshot ? `${summary.latestSnapshot.stage} @ ${summary.latestSnapshot.at}` : "none"}`,
    "",
    "## Task Breakdown",
    "",
  ];
  if (summary.tasks.length === 0) {
    lines.push("- No tasks.");
  } else {
    for (const task of summary.tasks) {
      lines.push(`- ${task.id}: ${task.subject}`);
      lines.push(`  - Status: ${task.status}; category=${task.category || "unresolved"}; attempts=${task.attempts}`);
      lines.push(`  - Verify: ${task.verifyCommands.join(" && ") || "(none)"}`);
      if (task.reviewCommands.length > 0) lines.push(`  - Review: ${task.reviewCommands.join(" && ")}`);
      if (task.standardsCommands.length > 0) lines.push(`  - Standards: ${task.standardsCommands.join(" && ")}`);
      if (task.checkpointPath) lines.push(`  - Checkpoint: ${task.checkpointPath}`);
      if (task.reviewReportPath) lines.push(`  - Review report: ${task.reviewReportPath}`);
      if (task.failureReportPath) lines.push(`  - Failure report: ${task.failureReportPath}`);
      if (task.changeRequestPath) lines.push(`  - ChangeRequest: ${task.changeRequestPath}`);
    }
  }
  lines.push("", "## ChangeRequests", "");
  if (summary.changes.length === 0) {
    lines.push("- None.");
  } else {
    for (const change of summary.changes) {
      lines.push(`- ${change.id}: ${change.status}; task=${change.taskId}; denied=${change.deniedPaths.join(", ") || "(none)"}`);
    }
  }
  lines.push("", "## Wisdom", "");
  if (summary.wisdom.length === 0) {
    lines.push("- None.");
  } else {
    lines.push(...summary.wisdom);
  }
  lines.push("", "## Gate Invariants", "");
  lines.push("- Every completed task has verifier evidence.");
  lines.push("- Completed tasks passed scope guard and review gate before checkpoint.");
  lines.push("- Open ChangeRequests must be resolved before final PASS.");
  return `${lines.join("\n")}\n`;
}

export async function statusReport(rootDir) {
  const work = await readJson(resolveHelixPath(rootDir, "work.json"), null);
  const taskState = await loadTaskState(rootDir);
  const changes = await listChangeRequests(rootDir);
  const openChanges = changes.filter((change) => change.status === "open").length;
  if (!taskState) return { work, planId: null, total: 0, completed: 0, pending: 0, failed: 0, openChanges };
  const counts = taskState.tasks.reduce((acc, task) => {
    acc[task.status] = (acc[task.status] || 0) + 1;
    return acc;
  }, {});
  return {
    work,
    planId: taskState.planId,
    total: taskState.tasks.length,
    completed: counts.completed || 0,
    pending: counts.pending || 0,
    in_progress: counts.in_progress || 0,
    verifying: counts.verifying || 0,
    failed: counts.failed || 0,
    review_blocked: counts.review_blocked || 0,
    needs_user_decision: counts.needs_user_decision || 0,
    openChanges,
  };
}

export async function dashboardData(rootDir) {
  const status = await statusReport(rootDir);
  const taskState = await loadTaskState(rootDir);
  const latestSnapshot = await readJson(resolveHelixPath(rootDir, "snapshots", "latest.json"), null);
  const summary = await readJson(resolveHelixPath(rootDir, "reports", "workflow-summary.json"), null);
  const ledger = await readLedgerTail(rootDir, 80);
  const changes = await listChangeRequests(rootDir);
  return {
    generatedAt: nowIso(),
    status,
    tasks: taskState?.tasks || [],
    changes,
    summary,
    latestSnapshot: latestSnapshot ? {
      id: latestSnapshot.id,
      stage: latestSnapshot.stage,
      at: latestSnapshot.at,
      payload: latestSnapshot.payload,
    } : null,
    ledger,
  };
}

export async function buildAgentContext(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const { config, sourcePath } = await loadHelixConfig(rootDir);
  const taskState = await loadTaskState(rootDir);
  const task = resolveContextTask(taskState?.tasks || [], options.taskId);
  const changed = await collectGitChangedPaths(rootDir);
  const targetPaths = uniqueStrings([
    ...(task?.writable_paths || []),
    ...(changed.available ? changed.paths : []),
  ].map(normalizeRelativePath));
  const rules = await scanProjectRules(rootDir, { targetPaths });
  const resumeContext = await writeContextSnapshot(rootDir, { reason: `agent-context:${options.agent || "Atlas"}` });
  const agent = normalizeAgentName(options.agent || task?.owner || "Atlas") || "Atlas";
  const role = options.role || roleForAgent(agent);
  const injectionPointName = options.injectionPoint || defaultInjectionPointForAgent(agent);
  const injectionPoint = await resolveInjectionPoint(rootDir, injectionPointName, {
    agent,
    taskId: task?.id || "",
    planId: taskState?.planId || "",
  });
  const modelConfig = config.agents?.[agent] || config.dynamicAgents?.[agent] || null;
  const context = {
    kind: "helix_agent_context",
    version: STATE_VERSION,
    at: nowIso(),
    configPath: sourcePath,
    agent,
    role,
    model: modelConfig,
    injectionPoint,
    task: task ? summarizeTaskForContext(task) : null,
    status: resumeContext.status,
    nextAction: resumeContext.nextAction,
    projectRules: {
      matched: rules.matched,
      total: rules.total,
      reportMdPath: rules.reportMdPath,
      rules: rules.rules.map((rule) => ({
        path: rule.path,
        description: rule.description,
        alwaysApply: rule.alwaysApply,
        globs: rule.globs,
      })),
    },
    changedPaths: changed.available ? changed.paths : [],
    changedPathStatus: changed.available ? "available" : "unavailable",
    changedPathReason: changed.available ? null : changed.reason,
    invariants: [
      "Worker done-claim is not completion.",
      "Checkpoint requires verifier PASS, scope guard non-fail, and review gate PASS.",
      "Scope drift requires ChangeRequest review before retry.",
      "Do not weaken verify_commands, review_commands, standards_commands, or project rules to manufacture PASS.",
    ],
    resumeContextPath: resumeContext.reportMdPath,
    rulesContextPath: rules.reportMdPath,
  };
  const suffix = task ? `${agent}-${task.id}` : `${agent}-general`;
  const jsonPath = resolveHelixPath(rootDir, "context-agents", `${suffix}.json`);
  const mdPath = resolveHelixPath(rootDir, "context-agents", `${suffix}.md`);
  context.reportJsonPath = path.relative(rootDir, jsonPath);
  context.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, context);
  await writeFile(mdPath, renderAgentContextMarkdown(context), "utf8");
  await appendLedger(rootDir, { type: "agent_context_built", agent, role, taskId: task?.id || null, rulesMatched: rules.matched, contextPath: context.reportMdPath });
  return context;
}

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

export async function runInjectionHook(rootDir, input = {}) {
  const hookRootDir = input.cwd && typeof input.cwd === "string" ? input.cwd : rootDir;
  await initRuntime(hookRootDir);
  const event = normalizeHookEvent(input.hook_event_name || input.event || input.name);
  const pointName = injectionPointForHookEvent(event);
  const sessionId = normalizeHookSessionId(input);
  const taskId = normalizeHookTaskId(input);
  const targetPaths = event === "PostToolUse" || event === "PreToolUse" ? extractHookTargetPaths(input) : [];
  const facts = {};

  if (event === "SessionStart") {
    facts.resume = await resumeReport(hookRootDir, { sessionId, source: "hook:session_start" });
    facts.rules = await scanProjectRules(hookRootDir);
    facts.agentContext = await buildAgentContext(hookRootDir, {
      agent: "Sisyphus",
      taskId,
      injectionPoint: pointName,
    }).catch((error) => ({ error: error.message }));
  } else if (event === "UserPromptSubmit") {
    facts.route = input.prompt ? await routeRequest(hookRootDir, { text: input.prompt }) : null;
    facts.rules = await scanProjectRules(hookRootDir);
  } else if (event === "PreToolUse") {
    facts.targetPaths = targetPaths;
    facts.rules = await scanProjectRules(hookRootDir, { targetPaths });
    facts.preflight = await preToolUseGuard(hookRootDir, input);
  } else if (event === "PostToolUse") {
    facts.targetPaths = targetPaths;
    facts.rules = await scanProjectRules(hookRootDir, { targetPaths });
    if (taskId) {
      facts.scope = await scopeGuard(hookRootDir, { taskId }).catch((error) => ({ status: "inconclusive", reason: error.message }));
    }
  } else if (event === "PostCompact") {
    facts.resume = await resumeReport(hookRootDir, { sessionId, source: "hook:post_compact" });
    facts.rules = await scanProjectRules(hookRootDir);
  } else if (event === "Stop") {
    facts.continuation = await continuationDirective(hookRootDir, { sessionId, source: "hook:stop" });
  }

  const variables = {
    agent: input.agent || defaultAgentForHookEvent(event),
    taskId,
    planId: await currentPlanId(hookRootDir),
  };
  const injectionPoint = await resolveInjectionPoint(hookRootDir, pointName, variables);
  const contextMarkdown = injectionPoint.enabled ? renderHookInjectionMarkdown({ event, pointName, sessionId, taskId, targetPaths, facts, injectionPoint }) : "";
  const output = event === "PreToolUse" && injectionPoint.enabled
    ? renderPreToolUseHookOutput(facts.preflight, contextMarkdown)
    : contextMarkdown;
  const result = {
    kind: "helix_hook_injection",
    version: STATE_VERSION,
    at: nowIso(),
    event,
    pointName,
    sessionId,
    taskId: taskId || null,
    targetPaths,
    enabled: injectionPoint.enabled,
    decision: facts.preflight?.decision || null,
    output,
  };
  const safeSessionId = sanitizeFileSegment(sessionId || "session");
  const safeEvent = sanitizeFileSegment(event);
  const outputPath = resolveHelixPath(hookRootDir, "sessions", "hooks", `${safeSessionId}-${safeEvent}.json`);
  result.reportJsonPath = path.relative(hookRootDir, outputPath);
  await writeJsonAtomic(outputPath, result);
  await appendLedger(hookRootDir, {
    type: "hook_injection_run",
    event,
    pointName,
    sessionId,
    taskId: taskId || null,
    decision: result.decision,
    outputChars: output.length,
  });
  return result;
}

export async function preToolUseGuard(rootDir, input = {}) {
  await ensureHelixDirs(rootDir);
  const event = normalizeHookEvent(input.hook_event_name || input.event || input.name);
  if (event !== "PreToolUse") throw new Error("preToolUseGuard requires PreToolUse input");
  const toolName = String(input.tool_name || input.toolName || "");
  const targetPaths = extractHookTargetPaths(input);

  if (toolName === "create_goal" && hasInvalidCreateGoalPayload(input.tool_input || input.toolInput)) {
    return {
      kind: "pre_tool_use_guard",
      at: nowIso(),
      decision: "deny",
      reason: "Use create_goal with objective only. Put lifecycle status changes on update_goal.",
      toolName,
      taskId: null,
      targetPaths,
      deniedPaths: [],
    };
  }

  const taskState = await loadTaskState(rootDir);
  const taskId = normalizeHookTaskId(input);
  const task = taskState
    ? taskId
      ? taskState.tasks.find((candidate) => candidate.id === taskId)
      : taskState.tasks.find((candidate) => ["in_progress", "verifying"].includes(candidate.status)) || findRunnableTask(taskState.tasks)
    : null;

  if (targetPaths.length === 0) {
    return {
      kind: "pre_tool_use_guard",
      at: nowIso(),
      decision: "allow",
      reason: "no project file target detected",
      toolName,
      taskId: task?.id || taskId || null,
      targetPaths,
      deniedPaths: [],
    };
  }
  if (!task) {
    return {
      kind: "pre_tool_use_guard",
      at: nowIso(),
      decision: "warn",
      reason: "file target detected but no active HelixFlow task was found",
      toolName,
      taskId: taskId || null,
      targetPaths,
      deniedPaths: [],
    };
  }

  const writablePaths = (task.writable_paths || []).map(normalizeRelativePath);
  const deniedPaths = targetPaths.filter((filePath) => !pathAllowed(filePath, writablePaths));
  const decision = deniedPaths.length > 0 ? "deny" : "allow";
  const reason = deniedPaths.length > 0
    ? `planned scope violation for task ${task.id}: ${deniedPaths.join(", ")}`
    : `targets are inside writable_paths for task ${task.id}`;
  await appendLedger(rootDir, {
    type: decision === "deny" ? "pre_tool_use_denied" : "pre_tool_use_allowed",
    planId: taskState.planId,
    taskId: task.id,
    toolName,
    targetPaths,
    deniedPaths,
  });
  return {
    kind: "pre_tool_use_guard",
    at: nowIso(),
    decision,
    reason,
    toolName,
    taskId: task.id,
    targetPaths,
    writablePaths,
    deniedPaths,
  };
}

function hasInvalidCreateGoalPayload(value) {
  return isPlainObject(value) && Object.keys(value).some((key) => key !== "objective");
}

function renderPreToolUseHookOutput(preflight, contextMarkdown) {
  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: contextMarkdown,
    },
  };
  if (preflight?.decision === "deny") {
    output.hookSpecificOutput.permissionDecision = "deny";
    output.hookSpecificOutput.permissionDecisionReason = preflight.reason || "HelixFlow pre-tool-use guard denied this tool call.";
  }
  return `${JSON.stringify(output)}\n`;
}

function normalizeHookEvent(value) {
  const raw = String(value || "").trim();
  const aliases = {
    session_start: "SessionStart",
    SessionStart: "SessionStart",
    user_prompt_submit: "UserPromptSubmit",
    UserPromptSubmit: "UserPromptSubmit",
    pre_tool_use: "PreToolUse",
    PreToolUse: "PreToolUse",
    post_tool_use: "PostToolUse",
    PostToolUse: "PostToolUse",
    post_compact: "PostCompact",
    PostCompact: "PostCompact",
    stop: "Stop",
    Stop: "Stop",
    subagent_stop: "Stop",
    SubagentStop: "Stop",
  };
  const event = aliases[raw];
  if (!event) throw new Error(`unsupported hook event: ${raw || "(empty)"}`);
  return event;
}

function injectionPointForHookEvent(event) {
  if (event === "SessionStart") return "session_start";
  if (event === "UserPromptSubmit") return "user_prompt_submit";
  if (event === "PreToolUse") return "pre_tool_use";
  if (event === "PostToolUse") return "post_tool_use";
  if (event === "PostCompact") return "post_compact";
  if (event === "Stop") return "stop";
  throw new Error(`unsupported hook event: ${event}`);
}

function defaultAgentForHookEvent(event) {
  if (event === "SessionStart" || event === "UserPromptSubmit" || event === "Stop" || event === "PostCompact") return "Sisyphus";
  return "Atlas";
}

function normalizeHookSessionId(input) {
  return String(input.session_id || input.sessionId || process.env.HELIX_SESSION_ID || process.env.CODEX_SESSION_ID || process.env.CURSOR_SESSION_ID || createWorkId("session"));
}

function normalizeHookTaskId(input) {
  const direct = input.taskId || input.task_id || process.env.HELIX_TASK_ID;
  if (direct && typeof direct === "string") return direct;
  const toolInput = input.tool_input || input.toolInput;
  if (toolInput && typeof toolInput === "object") {
    const nested = toolInput.taskId || toolInput.task_id;
    if (nested && typeof nested === "string") return nested;
  }
  return "";
}

async function currentPlanId(rootDir) {
  const taskState = await loadTaskState(rootDir);
  return taskState?.planId || "";
}

function extractHookTargetPaths(input) {
  const values = [];
  collectPathLikeValues(input.tool_input || input.toolInput, values);
  collectPathLikeValues(input.tool_response || input.toolResponse, values);
  collectPathLikeValues(input.paths || input.targetPaths, values);
  return uniqueStrings(values.map(normalizeRelativePath).filter((value) => value && !value.startsWith("..")));
}

function collectPathLikeValues(value, output) {
  if (typeof value === "string") {
    if (looksLikeProjectPath(value)) output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPathLikeValues(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (/^(path|file|file_path|filepath|target|target_path|relative_path)$/i.test(key) && typeof nested === "string") {
      if (looksLikeProjectPath(nested)) output.push(nested);
      continue;
    }
    collectPathLikeValues(nested, output);
  }
}

function looksLikeProjectPath(value) {
  if (!value || value.includes("\n") || value.includes("\0")) return false;
  if (/^(https?:|data:|mailto:)/i.test(value)) return false;
  if (path.isAbsolute(value)) return false;
  return value.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(value);
}

function sanitizeFileSegment(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 80) || "unknown";
}

function renderHookInjectionMarkdown({ event, pointName, sessionId, taskId, targetPaths, facts, injectionPoint }) {
  const lines = [
    `<helixflow-injection event="${event}" point="${pointName}">`,
    "",
    "# HelixFlow Runtime Injection",
    "",
    `- Event: ${event}`,
    `- Injection point: ${pointName}`,
    `- Session: ${sessionId}`,
    `- Task: ${taskId || "(none)"}`,
    `- Config: ${injectionPoint.configPath}`,
    "",
    "## Required Behavior",
    "",
    "- Treat this block as live runtime context, not optional documentation.",
    "- Worker done-claim is not completion; completion requires verifier, scope, review, and checkpoint gates.",
    "- Project rules and success criteria cannot be weakened or deleted to manufacture PASS.",
    "- If injected evidence is insufficient, return INCONCLUSIVE or request the required gate instead of guessing.",
    "",
    "## Tools",
    "",
    injectionPoint.tools.length > 0 ? `- ${injectionPoint.tools.join("\n- ")}` : "- (none)",
    "",
  ];

  if (targetPaths.length > 0) {
    lines.push("## Dynamic Targets", "", ...targetPaths.map((targetPath) => `- ${targetPath}`), "");
  }
  appendHookFacts(lines, facts);
  appendInjectionAttachments(lines, injectionPoint);
  lines.push("</helixflow-injection>", "");
  return lines.join("\n");
}

function appendHookFacts(lines, facts) {
  if (facts.route) {
    lines.push("## Route Decision", "");
    lines.push(`- Intent: ${facts.route.intent}`);
    lines.push(`- Route: ${facts.route.route}`);
    lines.push(`- Primary agent: ${facts.route.primaryAgent}`);
    lines.push(`- Category: ${facts.route.category || "(none)"}`);
    lines.push(`- Risk: ${facts.route.risk || "(unknown)"}`);
    lines.push("");
  }
  if (facts.resume) {
    lines.push("## Resume", "");
    lines.push(`- Context: ${facts.resume.contextPath}`);
    lines.push(`- Next action: ${facts.resume.nextAction}`);
    lines.push("");
  }
  if (facts.continuation) {
    lines.push("## Continuation", "");
    lines.push(`- Should continue: ${facts.continuation.shouldContinue ? "yes" : "no"}`);
    lines.push(`- Reason: ${facts.continuation.reason}`);
    lines.push(`- Next command: ${facts.continuation.nextCommand || "(none)"}`);
    lines.push(`- Report: ${facts.continuation.reportMdPath}`);
    lines.push("");
  }
  if (facts.scope) {
    lines.push("## Scope Guard", "");
    lines.push(`- Status: ${facts.scope.status}`);
    lines.push(`- Reason: ${facts.scope.reason || "(none)"}`);
    lines.push("");
  }
  if (facts.rules) {
    lines.push("## Project Rules", "");
    lines.push(`- Matched: ${facts.rules.matched}/${facts.rules.total}`);
    lines.push(`- Report: ${facts.rules.reportMdPath}`);
    for (const rule of facts.rules.rules || []) {
      lines.push(`- ${rule.path}: ${rule.description}`);
      if (rule.content) {
        lines.push("");
        lines.push("```markdown");
        lines.push(rule.content);
        lines.push("```");
      }
    }
    lines.push("");
  }
  if (facts.agentContext) {
    lines.push("## Agent Context", "");
    if (facts.agentContext.error) {
      lines.push(`- Error: ${facts.agentContext.error}`);
    } else {
      lines.push(`- Report: ${facts.agentContext.reportMdPath}`);
      lines.push(`- Agent: ${facts.agentContext.agent}`);
      lines.push(`- Role: ${facts.agentContext.role}`);
    }
    lines.push("");
  }
}

function appendInjectionAttachments(lines, injectionPoint) {
  lines.push("## Markdown Mounts", "");
  if (injectionPoint.markdown.length === 0) {
    lines.push("- (none)", "");
  } else {
    for (const item of injectionPoint.markdown) {
      lines.push(`### ${item.path}`, "", item.content || "(empty)", "");
    }
  }
  lines.push("## Skill Mounts", "");
  if (injectionPoint.skills.length === 0) {
    lines.push("- (none)", "");
  } else {
    for (const skill of injectionPoint.skills) {
      lines.push(`### ${skill.name}`, "", skill.content || "(empty)", "");
    }
  }
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

function defaultInjectionPointForAgent(agent) {
  if (agent === "Oracle" || agent === "Momus" || agent === "Metis") return "before_review";
  if (agent === "Sisyphus") return "user_prompt_submit";
  return "before_execute";
}

function resolveContextTask(tasks, taskId) {
  if (taskId) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    return task;
  }
  return findRunnableTask(tasks) || tasks.find((task) => task.status === "in_progress" || task.status === "verifying" || task.status === "failed") || null;
}

function roleForAgent(agent) {
  if (agent === "Oracle") return "goal_verifier";
  if (agent === "Momus") return "skeptical_scope_reviewer";
  if (agent === "Metis") return "bug_and_evidence_reviewer";
  if (agent === "Sisyphus") return "lead_orchestrator";
  return "linear_worker";
}

function renderAgentContextMarkdown(context) {
  const lines = [
    "# HelixFlow Agent Context",
    "",
    `Generated: ${context.at}`,
    `Config: ${context.configPath}`,
    `Agent: ${context.agent}`,
    `Role: ${context.role}`,
    `Model: ${context.model ? `${context.model.provider || "unknown"}/${context.model.model || "unknown"}` : "(unconfigured)"}`,
    `Injection point: ${context.injectionPoint.name} (${context.injectionPoint.enabled ? "enabled" : "disabled"})`,
    `Resume context: ${context.resumeContextPath}`,
    `Rules context: ${context.rulesContextPath}`,
    "",
    "## Task",
    "",
  ];
  if (context.task) appendTaskContext(lines, context.task);
  else lines.push("- None.");
  lines.push("", "## Project Rules", "");
  lines.push(`- Matched: ${context.projectRules.matched}/${context.projectRules.total}`);
  if (context.projectRules.rules.length === 0) {
    lines.push("- No matching rules.");
  } else {
    for (const rule of context.projectRules.rules) {
      lines.push(`- ${rule.path}: ${rule.description}`);
    }
  }
  lines.push("", "## Injection Mounts", "");
  lines.push(`- Tools: ${context.injectionPoint.tools.join(", ") || "(none)"}`);
  if (context.injectionPoint.markdown.length === 0) {
    lines.push("- Markdown: none");
  } else {
    for (const item of context.injectionPoint.markdown) lines.push(`- Markdown: ${item.path} (${item.chars} chars)`);
  }
  if (context.injectionPoint.skills.length === 0) {
    lines.push("- Skills: none");
  } else {
    for (const item of context.injectionPoint.skills) lines.push(`- Skill: ${item.name} -> ${item.path} (${item.chars} chars)`);
  }
  lines.push("", "## Changed Paths", "");
  if (context.changedPathStatus !== "available") {
    lines.push(`- Unavailable: ${context.changedPathReason}`);
  } else if (context.changedPaths.length === 0) {
    lines.push("- None.");
  } else {
    for (const filePath of context.changedPaths) lines.push(`- ${filePath}`);
  }
  lines.push("", "## Invariants", "");
  for (const invariant of context.invariants) lines.push(`- ${invariant}`);
  return `${lines.join("\n")}\n`;
}

async function readLedgerTail(rootDir, limit) {
  try {
    const content = await readFile(resolveHelixPath(rootDir, "ledger.jsonl"), "utf8");
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function writeContextSnapshot(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const latestSnapshot = options.latestSnapshot || await readJson(resolveHelixPath(rootDir, "snapshots", "latest.json"), null);
  const report = await statusReport(rootDir);
  const taskState = await loadTaskState(rootDir);
  const changes = await listChangeRequests(rootDir);
  const ledger = await readLedgerTail(rootDir, 12);
  const nextTask = taskState ? findRunnableTask(taskState.tasks) : null;
  const failedTasks = (taskState?.tasks || []).filter((task) => task.status === "failed");
  const verifyingTasks = (taskState?.tasks || []).filter((task) => task.status === "verifying" || task.status === "in_progress");
  const lineage = await readSessionLineage(rootDir);
  const context = {
    kind: "helix_context_snapshot",
    version: STATE_VERSION,
    at: nowIso(),
    reason: options.reason || "manual",
    latestSnapshot: latestSnapshot ? { id: latestSnapshot.id, stage: latestSnapshot.stage, at: latestSnapshot.at } : null,
    status: report,
    nextAction: nextTask ? `run task ${nextTask.id}: ${nextTask.subject}` : report.failed > 0 ? "inspect failed task" : "no runnable task",
    nextTask: nextTask ? summarizeTaskForContext(nextTask) : null,
    activeTasks: verifyingTasks.map(summarizeTaskForContext),
    failedTasks: failedTasks.map(summarizeTaskForContext),
    openChanges: changes.filter((change) => change.status === "open").map(summarizeChangeForContext),
    sessions: lineage,
    ledgerTail: ledger,
  };
  const jsonPath = resolveHelixPath(rootDir, "snapshots", "context.json");
  const mdPath = resolveHelixPath(rootDir, "snapshots", "context.md");
  context.reportJsonPath = path.relative(rootDir, jsonPath);
  context.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, context);
  await writeFile(mdPath, renderContextMarkdown(context), "utf8");
  return context;
}

function summarizeTaskForContext(task) {
  return {
    id: task.id,
    subject: task.subject,
    status: task.status,
    category: task.category,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    writable_paths: task.writable_paths || [],
    verify_commands: task.verify_commands || [],
    review_commands: task.review_commands || [],
    standards_commands: task.standards_commands || [],
    lastFailure: task.last_failure ? {
      reason: task.last_failure.reason,
      retryHint: task.last_failure.retryHint,
      reportMdPath: task.last_failure.reportMdPath,
      resolvedBy: task.last_failure.resolvedBy,
    } : null,
    lastChangeRequest: task.last_change_request ? {
      id: task.last_change_request.id,
      status: task.last_change_request.status,
      reportMdPath: task.last_change_request.reportMdPath,
    } : null,
    lastReview: task.last_review_result ? {
      pass: task.last_review_result.pass,
      reportMdPath: task.last_review_result.reportMdPath,
      failedLanes: (task.last_review_result.lanes || []).filter((lane) => lane.status === "fail").map((lane) => lane.name),
    } : null,
  };
}

function summarizeChangeForContext(change) {
  return {
    id: change.id,
    status: change.status,
    taskId: change.taskId,
    subject: change.subject,
    deniedPaths: change.deniedPaths || [],
    reportMdPath: change.reportMdPath,
  };
}

function renderContextMarkdown(context) {
  const status = context.status || {};
  const lines = [
    "# HelixFlow Resume Context",
    "",
    `Generated: ${context.at}`,
    `Reason: ${context.reason}`,
    `Latest snapshot: ${context.latestSnapshot ? `${context.latestSnapshot.stage} @ ${context.latestSnapshot.at}` : "none"}`,
    "",
    "## Status",
    "",
    `- Work: ${status.work?.workId || "(none)"}`,
    `- Plan: ${status.planId || "(none)"}`,
    `- Counts: total=${status.total || 0}, completed=${status.completed || 0}, pending=${status.pending || 0}, verifying=${status.verifying || 0}, failed=${status.failed || 0}, openChanges=${status.openChanges || 0}`,
    `- Next action: ${context.nextAction}`,
    "",
    "## Session Lineage",
    "",
  ];
  if (!context.sessions?.sessionIds?.length) {
    lines.push("- No recorded sessions yet.");
  } else {
    lines.push(`- Current: ${context.sessions.currentSessionId || "(unknown)"}`);
    lines.push(`- All: ${context.sessions.sessionIds.join(", ")}`);
  }
  lines.push("", "## Next Task", "");
  if (context.nextTask) {
    appendTaskContext(lines, context.nextTask);
  } else {
    lines.push("- None.");
  }
  lines.push("", "## Active Tasks", "");
  if (context.activeTasks.length === 0) {
    lines.push("- None.");
  } else {
    for (const task of context.activeTasks) appendTaskContext(lines, task);
  }
  lines.push("", "## Failed Tasks", "");
  if (context.failedTasks.length === 0) {
    lines.push("- None.");
  } else {
    for (const task of context.failedTasks) appendTaskContext(lines, task);
  }
  lines.push("", "## Open ChangeRequests", "");
  if (context.openChanges.length === 0) {
    lines.push("- None.");
  } else {
    for (const change of context.openChanges) {
      lines.push(`- ${change.id} (${change.status}) task=${change.taskId}`);
      lines.push(`  - Subject: ${change.subject}`);
      lines.push(`  - Denied: ${change.deniedPaths.join(", ") || "(none)"}`);
      lines.push(`  - Report: ${change.reportMdPath || "(none)"}`);
    }
  }
  lines.push("", "## Resume Commands", "");
  lines.push("- Inspect: `node ./bin/helix.mjs status`");
  lines.push("- Refresh context: `node ./bin/helix.mjs resume`");
  lines.push("- Run next task: `node ./bin/helix.mjs run`");
  lines.push("- Node loop: `node ./bin/helix.mjs node execute|verify|scope|review|checkpoint|retry --task <taskId>`");
  lines.push("- Open changes: `node ./bin/helix.mjs changes list`");
  lines.push("", "## Invariants", "");
  lines.push("- Worker done-claim is not completion.");
  lines.push("- Checkpoint requires verifier PASS, scope guard non-fail, and review gate PASS.");
  lines.push("- Scope drift requires ChangeRequest review before retry.");
  lines.push("- Do not weaken `verify_commands` or `review_commands` to manufacture PASS.");
  lines.push("", "## Ledger Tail", "");
  if (context.ledgerTail.length === 0) {
    lines.push("- None.");
  } else {
    for (const entry of context.ledgerTail) {
      lines.push(`- ${entry.at || ""} ${entry.type || entry.kind || "event"} ${entry.taskId ? `task=${entry.taskId}` : ""} ${entry.stage ? `stage=${entry.stage}` : ""}`.trim());
    }
  }
  return `${lines.join("\n")}\n`;
}

function appendTaskContext(lines, task) {
  lines.push(`- ${task.id}: ${task.subject}`);
  lines.push(`  - Status: ${task.status}; category=${task.category || "unresolved"}; attempts=${task.attempts}/${task.maxAttempts}`);
  lines.push(`  - Writable: ${task.writable_paths.join(", ") || "(none)"}`);
  lines.push(`  - Verify: ${task.verify_commands.join(" && ") || "(none)"}`);
  if (task.review_commands.length > 0) lines.push(`  - Review: ${task.review_commands.join(" && ")}`);
  if ((task.standards_commands || []).length > 0) lines.push(`  - Standards: ${task.standards_commands.join(" && ")}`);
  if (task.lastReview) lines.push(`  - Review gate: ${task.lastReview.pass ? "PASS" : `FAIL ${task.lastReview.failedLanes.join(", ")}`} (${task.lastReview.reportMdPath || "no report"})`);
  if (task.lastChangeRequest) lines.push(`  - ChangeRequest: ${task.lastChangeRequest.id} (${task.lastChangeRequest.reportMdPath || "no report"})`);
  if (task.lastFailure) {
    lines.push(`  - Failure: ${task.lastFailure.reason} (${task.lastFailure.reportMdPath || "no report"})`);
    lines.push(`  - Retry hint: ${(task.lastFailure.retryHint || "").replace(/\n/g, " / ")}`);
  }
}

async function readSessionLineage(rootDir) {
  return readJson(resolveHelixPath(rootDir, "sessions", "lineage.json"), {
    version: STATE_VERSION,
    currentSessionId: null,
    sessionIds: [],
    sessions: [],
  });
}

export async function recordRuntimeSession(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const sessionId = options.sessionId || process.env.HELIX_SESSION_ID || process.env.CODEX_SESSION_ID || process.env.CURSOR_SESSION_ID || createWorkId("session");
  const source = options.source || "resume";
  const now = nowIso();
  const lineage = await readSessionLineage(rootDir);
  const existing = lineage.sessions.find((session) => session.id === sessionId);
  if (existing) {
    existing.lastSeenAt = now;
    existing.source = source;
  } else {
    lineage.sessions.push({ id: sessionId, source, firstSeenAt: now, lastSeenAt: now });
  }
  lineage.version = STATE_VERSION;
  lineage.currentSessionId = sessionId;
  lineage.sessionIds = lineage.sessions.map((session) => session.id);
  lineage.updatedAt = now;
  await writeJsonAtomic(resolveHelixPath(rootDir, "sessions", "lineage.json"), lineage);
  await appendLedger(rootDir, { type: "session_recorded", sessionId, source });
  return lineage;
}

export async function resumeReport(rootDir, options = {}) {
  const lineage = await recordRuntimeSession(rootDir, {
    sessionId: options.sessionId,
    source: options.source || "resume",
  });
  const latestSnapshot = await readJson(resolveHelixPath(rootDir, "snapshots", "latest.json"), null);
  const report = await statusReport(rootDir);
  const taskState = await loadTaskState(rootDir);
  const nextTask = taskState ? findRunnableTask(taskState.tasks) : null;
  const context = await writeContextSnapshot(rootDir, { reason: "resume", latestSnapshot });
  const resume = {
    latestSnapshot: latestSnapshot ? {
      id: latestSnapshot.id,
      stage: latestSnapshot.stage,
      at: latestSnapshot.at,
    } : null,
    status: report,
    session: {
      currentSessionId: lineage.currentSessionId,
      sessionIds: lineage.sessionIds,
    },
    contextPath: context.reportMdPath,
    nextAction: nextTask ? `run task ${nextTask.id}: ${nextTask.subject}` : report.failed > 0 ? "inspect failed task" : "no runnable task",
  };
  await appendLedger(rootDir, { type: "resume_reported", nextAction: resume.nextAction, sessionId: lineage.currentSessionId, contextPath: resume.contextPath });
  return resume;
}

export async function continuationDirective(rootDir, options = {}) {
  const resume = await resumeReport(rootDir, {
    sessionId: options.sessionId,
    source: options.source || "continuation",
  });
  const taskState = await loadTaskState(rootDir);
  const runnable = taskState ? findRunnableTask(taskState.tasks) : null;
  const active = (taskState?.tasks || []).find((task) => task.status === "in_progress" || task.status === "verifying");
  const failed = (taskState?.tasks || []).find((task) => task.status === "failed" || task.status === "review_blocked" || task.status === "needs_user_decision");
  const shouldContinue = Boolean(runnable || active || failed);
  const directive = {
    kind: "helix_continuation_directive",
    version: STATE_VERSION,
    at: nowIso(),
    shouldContinue,
    reason: runnable ? "runnable_task" : active ? "active_task" : failed ? "blocked_or_failed_task" : "no_unfinished_work",
    taskId: runnable?.id || active?.id || failed?.id || null,
    nextCommand: runnable ? "node ./bin/helix.mjs run" : active ? `node ./bin/helix.mjs node verify --task ${active.id}` : failed ? "node ./bin/helix.mjs status" : null,
    message: shouldContinue
      ? `HelixFlow 还有未收口工作：${runnable?.id || active?.id || failed?.id}。请继续执行 ${runnable ? "run" : active ? "node loop" : "failure review"}，不要丢失上下文。`
      : "HelixFlow 当前没有可续跑任务。",
    resume,
  };
  const jsonPath = resolveHelixPath(rootDir, "sessions", "continuation.json");
  const mdPath = resolveHelixPath(rootDir, "sessions", "continuation.md");
  directive.reportJsonPath = path.relative(rootDir, jsonPath);
  directive.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, directive);
  await writeFile(mdPath, renderContinuationMarkdown(directive), "utf8");
  await appendLedger(rootDir, { type: "continuation_checked", shouldContinue, reason: directive.reason, taskId: directive.taskId });
  return directive;
}

function renderContinuationMarkdown(directive) {
  return [
    "# HelixFlow Continuation Directive",
    "",
    `Generated: ${directive.at}`,
    `Should continue: ${directive.shouldContinue ? "yes" : "no"}`,
    `Reason: ${directive.reason}`,
    `Task: ${directive.taskId || "(none)"}`,
    `Next command: ${directive.nextCommand || "(none)"}`,
    "",
    directive.message,
    "",
    `Resume context: ${directive.resume.contextPath}`,
    "",
  ].join("\n");
}

export async function runWorkflow(rootDir, options = {}) {
  await initRuntime(rootDir);
  let plan = null;
  if (options.planPath) {
    plan = await importPlan(rootDir, path.resolve(rootDir, options.planPath));
  } else if (options.sample) {
    const samplePath = await createSamplePlan(rootDir);
    plan = await importPlan(rootDir, samplePath);
  }

  const results = [];
  const maxSteps = options.maxSteps || 50;
  for (let step = 0; step < maxSteps; step += 1) {
    const result = await runNextTask(rootDir);
    results.push(result);
    if (["complete", "blocked", "failed"].includes(result.status)) break;
  }

  const report = await statusReport(rootDir);
  await writeSnapshot(rootDir, "workflow_finished", { status: report });
  const summary = await writeWorkflowSummary(rootDir, { reason: "workflow_finished" });
  return { ok: report.failed === 0 && report.pending === 0 && report.in_progress === 0 && report.verifying === 0, planId: plan?.id || report.planId, results, status: report, summaryPath: summary.reportMdPath };
}

export async function createSamplePlan(rootDir, targetPath = resolveHelixPath(rootDir, "plans", "sample-plan.json")) {
  await ensureHelixDirs(rootDir);
  const workerScript = "node -e \"const fs=require('fs'); fs.mkdirSync('.helix/artifacts',{recursive:true}); fs.writeFileSync('.helix/artifacts/linear-smoke.txt','ok\\\\n')\"";
  const verifyScript = "node -e \"const fs=require('fs'); const v=fs.readFileSync('.helix/artifacts/linear-smoke.txt','utf8').trim(); if(v!=='ok') process.exit(1)\"";
  const sample = {
    title: "M1 linear loop smoke",
    objective: "Prove Atlas can run one worker task and verify it before checkpoint.",
    tasks: [
      {
        id: "T001",
        subject: "Write smoke artifact",
        description: "Worker writes a small artifact; verifier checks exact content.",
        category: "quick",
        writable_paths: [".helix/artifacts/linear-smoke.txt"],
        worker_command: workerScript,
        verify_commands: [verifyScript],
      },
    ],
  };
  await writeJsonAtomic(targetPath, sample);
  return targetPath;
}

export async function copyPlanTemplate(rootDir, destinationPath) {
  const samplePath = await createSamplePlan(rootDir);
  await copyFile(samplePath, destinationPath);
  return destinationPath;
}
