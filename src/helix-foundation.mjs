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
export const PROJECT_DIR = path.dirname(MODULE_DIR);
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
    taskState: await readJson(resolveHelixPath(rootDir, "team", "tasks.json"), null),
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

async function writeContextSnapshot(rootDir, options = {}) {
  const latestSnapshot = options.latestSnapshot || await readJson(resolveHelixPath(rootDir, "snapshots", "latest.json"), null);
  const work = await readJson(resolveHelixPath(rootDir, "work.json"), null);
  const taskState = await readJson(resolveHelixPath(rootDir, "team", "tasks.json"), null);
  const changes = await readChangeRequests(rootDir);
  const status = buildStatusReport(work, taskState, changes);
  const nextTask = taskState ? findRunnableTaskForContext(taskState.tasks || []) : null;
  const context = {
    kind: "helix_context_snapshot",
    version: STATE_VERSION,
    at: nowIso(),
    reason: options.reason || "manual",
    latestSnapshot: latestSnapshot ? { id: latestSnapshot.id, stage: latestSnapshot.stage, at: latestSnapshot.at } : null,
    status,
    nextAction: nextTask ? `run task ${nextTask.id}: ${nextTask.subject}` : status.failed > 0 ? "inspect failed task" : "no runnable task",
    nextTask: nextTask ? summarizeTaskForContext(nextTask) : null,
    activeTasks: (taskState?.tasks || [])
      .filter((task) => task.status === "verifying" || task.status === "in_progress")
      .map(summarizeTaskForContext),
    failedTasks: (taskState?.tasks || [])
      .filter((task) => task.status === "failed")
      .map(summarizeTaskForContext),
    openChanges: changes.filter((change) => change.status === "open").map(summarizeChangeForContext),
    sessions: await readSessionLineage(rootDir),
    ledgerTail: await readLedgerTail(rootDir, 12),
  };
  const jsonPath = resolveHelixPath(rootDir, "snapshots", "context.json");
  const mdPath = resolveHelixPath(rootDir, "snapshots", "context.md");
  context.reportJsonPath = path.relative(rootDir, jsonPath);
  context.reportMdPath = path.relative(rootDir, mdPath);
  await writeJsonAtomic(jsonPath, context);
  await writeFile(mdPath, renderContextMarkdown(context), "utf8");
  return context;
}

function buildStatusReport(work, taskState, changes) {
  const openChanges = changes.filter((change) => change.status === "open").length;
  if (!taskState) return { work, planId: null, total: 0, completed: 0, pending: 0, failed: 0, openChanges };
  const counts = (taskState.tasks || []).reduce((acc, task) => {
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

function findRunnableTaskForContext(tasks) {
  const completed = new Set(tasks.filter((task) => task.status === "completed").map((task) => task.id));
  return tasks.find((task) => task.status === "pending" && (task.blockedBy || []).every((id) => completed.has(id))) || null;
}

async function readChangeRequests(rootDir) {
  const dirPath = resolveHelixPath(rootDir, "changes");
  let entries;
  try {
    entries = await readdir(dirPath);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const changes = [];
  for (const fileName of entries) {
    if (!fileName.endsWith(".json")) continue;
    const change = await readJson(path.join(dirPath, fileName), null);
    if (change) changes.push(change);
  }
  return changes.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
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

async function readSessionLineage(rootDir) {
  return readJson(resolveHelixPath(rootDir, "sessions", "lineage.json"), {
    version: STATE_VERSION,
    currentSessionId: null,
    sessionIds: [],
    sessions: [],
  });
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
      failedLanes: (task.last_review_result.lanes || [])
        .filter((lane) => lane.status === "fail")
        .map((lane) => lane.name),
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
  if (context.nextTask) appendTaskContext(lines, context.nextTask);
  else lines.push("- None.");
  lines.push("", "## Active Tasks", "");
  if (context.activeTasks.length === 0) lines.push("- None.");
  else for (const task of context.activeTasks) appendTaskContext(lines, task);
  lines.push("", "## Failed Tasks", "");
  if (context.failedTasks.length === 0) lines.push("- None.");
  else for (const task of context.failedTasks) appendTaskContext(lines, task);
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
  if (context.ledgerTail.length === 0) lines.push("- None.");
  else {
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
