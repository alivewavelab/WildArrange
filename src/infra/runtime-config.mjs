import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { normalizeAgentKey } from "./agent-registry.mjs";
import { appendLedger } from "./ledger.mjs";
import {
  ensureWildArrangeDirs,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "./runtime-store.mjs";

export const WILDARRANGE_CONFIG_FILE = "wildarrange.config.json";
export const PRODUCT_NAME = "WildArrange";
export const DEFAULT_PACKAGE_NAME = "@alivewavelab/wildarrange";
export const DEFAULT_RUNTIME_NAME = "wildarrange-linear";
export const DEFAULT_CLI_COMMAND = "wildarrange";

export const DEFAULT_WILDARRANGE_CONFIG = {
  version: 1,
  runtime: DEFAULT_RUNTIME_NAME,
  adapters: {
    codex: { enabled: true, hookMode: "cli-adapter" },
    cursor: { enabled: true, hookMode: "cli-adapter" },
    kimi: { enabled: true, hookMode: "plugin-adapter" },
  },
  modelProviders: {
    host: { type: "host", adapter: "auto" },
    deepseek: { type: "openai-compatible", apiKeyEnv: "DEEPSEEK_API_KEY", baseUrlEnv: "DEEPSEEK_BASE_URL", defaultBaseUrl: "https://api.deepseek.com" },
    kimi: { type: "openai-compatible", apiKeyEnv: "KIMI_API_KEY", baseUrlEnv: "KIMI_BASE_URL", defaultBaseUrl: "https://api.moonshot.cn/v1" },
    qwen: { type: "openai-compatible", apiKeyEnv: "QWEN_API_KEY", baseUrlEnv: "QWEN_BASE_URL", defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    gemini: { type: "openai-compatible", apiKeyEnv: "GEMINI_API_KEY", baseUrlEnv: "GEMINI_BASE_URL" },
  },
  agents: {
    Jiuwei: { role: "workflow_orchestrator", provider: "host", model: "host-default", reasoning: "high", skills: [] },
    DiJiang: { role: "planner", provider: "host", model: "host-default", reasoning: "high", skills: [] },
    ZhuRong: { role: "implementation_worker", provider: "host", model: "host-default", reasoning: "medium", skills: [] },
    BaiZe: { role: "independent_reviewer", provider: "host", model: "host-default", reasoning: "xhigh", skills: [] },
    LuWu: { role: "repository_steward", provider: "host", model: "host-default", reasoning: "high", skills: [] },
  },
  archivistRouter: {
    enabled: false,
    agent: "CangJie",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    triggers: {
      sessionStart: true,
      gitHeadChanged: true,
      lowConfidenceRoute: true,
      everyUserPrompts: {
        default: 10,
        ideate: 5,
        plan: 5,
        clarify: 5,
        execute: 15,
        verify: 15,
        review: 15,
        min: 5,
        max: 20,
      },
      workflowCheckpoint: true,
    },
    memory: {
      backend: "structured-files",
      root: ".wildarrange/memory",
      captureMode: "conclusions-only",
      includeCodeBlocks: false,
      maxRecentTurns: 10,
      recentTurnWindows: {
        default: 10,
        ideate: 5,
        plan: 5,
        clarify: 5,
        execute: 15,
        verify: 15,
        review: 15,
        max: 20,
      },
      maxRoutingPacketChars: 12000,
      injectFields: ["progress", "decisions", "artifacts", "implementationNotes", "researchNotes", "pitfalls", "openQuestions"],
    },
    keywordEvolution: {
      suggestOnly: true,
      autoApplyConfidence: 0.85,
      minEvidenceCount: 2,
      protectedTargets: ["askGate", "intents.review", "intents.release_git", "intents.change_request"],
    },
  },
  routeGovernance: {
    dailyReview: {
      enabled: true,
      trigger: "stop",
      maxItems: 20,
    },
    semanticShadow: {
      enabled: true,
      agent: "CangJie",
      timeoutMs: 30000,
      lowConfidenceThreshold: 0.5,
      conflictRoute: "plan",
      enforceLowConfidence: true,
    },
  },
  gitCoordination: {
    mode: "guarded",
    remote: "origin",
    integrationBranch: "auto",
    taskBranchPrefix: "wildarrange/task",
    requireWorktreeForParallelWrites: true,
    requireVerificationBeforeHandoff: false,
    requireCleanHandoff: true,
    requireTakeoverReason: true,
  },
  parallelAgents: {
    enabled: true,
    defaultMaxAgents: 2,
    isolation: "run-dir",
    timeoutMs: 120000,
    retainUntilUserAcceptance: true,
    defaultAdapter: null,
    spawnAdapters: {
      codex: {
        command: "",
        note: "Set a Codex CLI command template here. Variables: {rootDir}, {runDir}, {workDir}, {taskJson}, {outputJson}, {taskId}, {agent}.",
      },
      cursor: {
        command: "",
        note: "Set a Cursor agent command template here. Variables: {rootDir}, {runDir}, {workDir}, {taskJson}, {outputJson}, {taskId}, {agent}.",
      },
    },
  },
  skillMatcher: {
    enabled: true,
    defaultLimit: 6,
    dynamicInjection: {
      enabled: true,
      maxSkills: 4,
      alwaysMount: ["wildarrange-injection-runtime"],
    },
    stageBoosts: {
      ideate: ["review-product-intent", "map-user-journey", "research-domain-benchmark", "ultraresearch"],
      clarify: ["review-product-intent", "design-acceptance", "start-work"],
      plan: ["init-deep", "review-plan-risk", "review-plan-readiness", "review-scope-tradeoff", "design-acceptance"],
      design: ["frontend-ui-ux", "review-ux-interaction", "visual-qa"],
      execute: ["programming", "debugging", "refactor", "run-linear-delivery"],
      verify: ["review-work", "design-acceptance", "visual-qa"],
      review: ["review-work", "review-plan-risk", "review-plan-readiness", "remove-ai-slops"],
      deploy: ["publish", "pre-publish-review"],
      recall: ["get-unpublished-changes"],
    },
  },
  contextBudgets: {
    prompt: { maxChars: 12_000 },
    markdown: { maxChars: 12_000 },
    skill: { maxChars: 80_000 },
    points: {
      session_start: { markdownMaxChars: 12_000, skillMaxChars: 60_000 },
      user_prompt_submit: { markdownMaxChars: 12_000, skillMaxChars: 60_000 },
      pre_tool_use: { markdownMaxChars: 8_000, skillMaxChars: 16_000 },
      post_tool_use: { markdownMaxChars: 8_000, skillMaxChars: 12_000 },
      post_compact: { markdownMaxChars: 16_000, skillMaxChars: 60_000 },
      before_execute: { markdownMaxChars: 20_000, skillMaxChars: 80_000 },
      before_review: { markdownMaxChars: 24_000, skillMaxChars: 80_000 },
      before_checkpoint: { markdownMaxChars: 24_000, skillMaxChars: 60_000 },
      repository_governance: { markdownMaxChars: 20_000, skillMaxChars: 40_000 },
      stop: { markdownMaxChars: 12_000, skillMaxChars: 24_000 },
    },
  },
  review: {
    llm: {
      enabled: false,
      required: false,
      agents: ["BaiZe"],
      temperature: 0,
      timeoutMs: 45000,
      maxEvidenceChars: 12000,
    },
  },
  commandSafety: {
    extraPatterns: [],
  },
  // 汇报分级：verbose = 每次 run 结束输出一次门决策汇总（框架初期默认，
  // 让人能审判每一条门决策）；随信任建立可降 normal（一行）/ quiet（只 JSON）。
  reporting: {
    verbosity: "verbose",
  },
  planApproval: {
    required: false,
  },
  verificationGovernance: {
    registryPath: "",
    bootstrapPath: "",
    inventoryPath: "",
    archiveRoot: "",
  },
  qualityGates: {
    lspDiagnostics: {
      enabled: false,
      required: false,
      commands: [],
      timeoutMs: 120000,
    },
    astStructure: {
      enabled: false,
      required: false,
      commands: [],
      timeoutMs: 120000,
    },
    hashlineAnchors: {
      enabled: false,
      required: false,
      anchors: [],
    },
    commentChecker: {
      enabled: true,
      blockOnFindings: false,
      maxFileBytes: 500000,
      patterns: [
        { name: "ai_attribution", pattern: "\\b(as an ai|generated by ai|ai generated|chatgpt|claude generated)\\b" },
        { name: "placeholder_comment", pattern: "\\b(todo|fixme|hack|xxx)\\b" },
        { name: "lorem_ipsum", pattern: "lorem ipsum" },
      ],
    },
  },
  ruleInjection: {
    mode: "both",
    maxRuleChars: 12000,
    maxResultChars: 40000,
    dynamicMaxRuleChars: 4000,
    dynamicMaxResultChars: 10000,
    projectSingleFiles: ["AGENTS.md", "CLAUDE.md", "CONTEXT.md", ".github/copilot-instructions.md"],
    projectRuleDirs: [".claude/rules", ".cursor/rules", ".github/instructions"],
  },
  repositoryGovernance: {
    enabled: false,
    governedRoots: [],
    requiredAgentBoundaries: [],
    documentationPairs: [],
    documentationRequirements: [],
    architectureLedgers: [],
    ignoredPaths: [".git", ".wildarrange", "node_modules", "coverage"],
    naming: {
      directories: "kebab-case",
      sourceFiles: "kebab-case.mjs",
      exceptions: ["README.md", "README.en.md", "AGENTS.md"],
    },
    commentRules: [],
  },
  injectionPoints: {
    session_start: {
      enabled: true,
      tools: ["wildarrange_resume", "wildarrange_rules_collect", "wildarrange_context_build"],
      markdown: [".wildarrange/snapshots/context.md", ".wildarrange/rules/context.md"],
      skills: ["wildarrange-injection-runtime", "start-work"],
      rules: { mode: "static" },
    },
    user_prompt_submit: {
      enabled: true,
      tools: ["wildarrange_route", "wildarrange_rules_collect"],
      markdown: [".wildarrange/snapshots/context.md", ".wildarrange/rules/context.md"],
      skills: [
        "wildarrange-injection-runtime",
        "review-work",
        "review-product-intent",
        "clarify-feature-design",
        "contract-governance",
        "map-user-journey",
        "design-acceptance",
        "review-ux-interaction",
        "review-scope-tradeoff",
        "research-domain-benchmark",
        "inspect-codebase",
        "research-external-docs"
      ],
      rules: { mode: "static" },
    },
    pre_tool_use: {
      enabled: true,
      tools: ["scope_guard", "wildarrange_rules_collect"],
      markdown: [".wildarrange/rules/context.md"],
      skills: ["wildarrange-injection-runtime"],
      rules: { mode: "dynamic_blocker" },
    },
    post_tool_use: {
      enabled: true,
      tools: ["wildarrange_rules_collect", "scope_guard"],
      markdown: [".wildarrange/rules/context.md"],
      skills: [],
      rules: { mode: "dynamic" },
    },
    post_compact: {
      enabled: true,
      tools: ["wildarrange_resume", "wildarrange_rules_collect"],
      markdown: [".wildarrange/snapshots/context.md", ".wildarrange/rules/context.md"],
      skills: ["wildarrange-injection-runtime"],
      rules: { mode: "recovery_marker" },
    },
    before_execute: {
      enabled: true,
      tools: ["wildarrange_context_build", "wildarrange_node", "scope_guard"],
      markdown: [".wildarrange/context-agents/Jiuwei-{taskId}.md", ".wildarrange/rules/context.md"],
      skills: ["wildarrange-injection-runtime", "run-linear-delivery", "programming", "debugging", "refactor"],
      rules: { mode: "dynamic" },
    },
    before_review: {
      enabled: true,
      tools: ["wildarrange_context_build", "wildarrange_evidence_record", "review_gate"],
      markdown: [".wildarrange/context-agents/BaiZe-{taskId}.md", ".wildarrange/rules/context.md"],
      skills: ["wildarrange-injection-runtime", "review-work", "review-plan-risk", "review-plan-readiness", "review-scope-tradeoff", "visual-qa"],
      rules: { mode: "dynamic" },
    },
    repository_governance: {
      enabled: true,
      tools: ["repository_governance_audit", "wildarrange_rules_collect", "comment_check", "config_verify"],
      markdown: [".wildarrange/reports/governance/latest.md", ".wildarrange/rules/context.md"],
      skills: ["wildarrange-injection-runtime", "repository-governance", "init-deep", "pre-publish-review", "remove-ai-slops"],
      rules: { mode: "dynamic" },
    },
    before_checkpoint: {
      enabled: true,
      tools: ["wildarrange_evidence_record", "review_gate", "wildarrange_summary"],
      markdown: [".wildarrange/reports/reviews/{planId}/{taskId}.md", ".wildarrange/rules/context.md"],
      skills: ["wildarrange-injection-runtime", "review-work", "design-acceptance"],
      rules: { mode: "dynamic" },
    },
    stop: {
      enabled: true,
      tools: ["wildarrange_continuation_check", "wildarrange_resume"],
      markdown: [".wildarrange/sessions/continuation.md", ".wildarrange/snapshots/context.md", ".wildarrange/reports/routing/latest.md"],
      skills: ["wildarrange-injection-runtime", "start-work", "review-routing-decisions"],
      rules: { mode: "static" },
    },
  },
};

export async function loadWildArrangeConfig(rootDir) {
  const rootConfigPath = path.join(rootDir, WILDARRANGE_CONFIG_FILE);
  const runtimeConfigPath = resolveWildArrangePath(rootDir, "config.json");
  const rootConfig = await readJson(rootConfigPath, null);
  const runtimeConfig = await readJson(runtimeConfigPath, null);
  const sourcePath = rootConfig ? rootConfigPath : runtimeConfig ? runtimeConfigPath : null;
  // A checked-in root config is authoritative. The runtime copy used to be
  // treated as a hidden lower layer, which allowed removed legacy keys to
  // reappear whenever the root stopped overriding them.
  const selectedConfig = rootConfig || runtimeConfig || {};
  return {
    config: normalizeRuntimeConfig(deepMerge(DEFAULT_WILDARRANGE_CONFIG, selectedConfig)),
    sourcePath: sourcePath ? path.relative(rootDir, sourcePath) : "default",
  };
}

export async function migrateRuntimeConfigState(rootDir) {
  await ensureWildArrangeDirs(rootDir);
  const rootConfigPath = path.join(rootDir, WILDARRANGE_CONFIG_FILE);
  const runtimeConfigPath = resolveWildArrangePath(rootDir, "config.json");
  const rootConfig = await readJson(rootConfigPath, null);
  const runtimeConfig = await readJson(runtimeConfigPath, null);
  const source = rootConfig || runtimeConfig || {};
  const config = normalizeRuntimeConfig(deepMerge(DEFAULT_WILDARRANGE_CONFIG, source));
  await writeJsonAtomic(runtimeConfigPath, config);
  const removedProjections = [];
  for (const name of ["agents.json", "categories.json"]) {
    try {
      await unlink(resolveWildArrangePath(rootDir, name));
      removedProjections.push(`.wildarrange/${name}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return {
    kind: "runtime_config_migration",
    sourcePath: rootConfig ? WILDARRANGE_CONFIG_FILE : runtimeConfig ? ".wildarrange/config.json" : "default",
    runtimeConfigPath: path.relative(rootDir, runtimeConfigPath),
    removedProjections,
  };
}

export async function writeDefaultWildArrangeConfig(rootDir, options = {}) {
  await ensureWildArrangeDirs(rootDir);
  const targetPath = options.root === true ? path.join(rootDir, WILDARRANGE_CONFIG_FILE) : resolveWildArrangePath(rootDir, "config.json");
  if (!options.force && existsSync(targetPath)) {
    return { path: path.relative(rootDir, targetPath), created: false, config: await readJson(targetPath) };
  }
  const config = options.armed === true ? buildArmedConfig() : DEFAULT_WILDARRANGE_CONFIG;
  await writeJsonAtomic(targetPath, config);
  await appendLedger(rootDir, { type: "config_written", configPath: path.relative(rootDir, targetPath), root: options.root === true, armed: options.armed === true });
  return { path: path.relative(rootDir, targetPath), created: true, config };
}

/**
 * `config init --armed`：写出一份「门已武装」的配置——commentChecker 阻断发现
 * （无需任何外部工具即可构成独立复核信号与 required 质量门），lspDiagnostics
 * 留好命令位等用户填项目真实的 typecheck/test 命令。默认配置故意不武装
 * （黄灯提醒），--armed 是给「我知道自己在做什么」的显式入口。
 */
function buildArmedConfig() {
  return {
    ...DEFAULT_WILDARRANGE_CONFIG,
    qualityGates: {
      ...DEFAULT_WILDARRANGE_CONFIG.qualityGates,
      lspDiagnostics: {
        ...DEFAULT_WILDARRANGE_CONFIG.qualityGates?.lspDiagnostics,
        enabled: true,
        required: true,
        commands: ["node --test"],
      },
      commentChecker: {
        ...DEFAULT_WILDARRANGE_CONFIG.qualityGates?.commentChecker,
        enabled: true,
        blockOnFindings: true,
      },
    },
  };
}

function normalizeRuntimeConfig(config) {
  if (!isPlainObject(config)) return config;
  const normalized = { ...config };
  delete normalized.dynamicAgents;
  delete normalized.promptVariants;
  if (normalized.runtime === ["wildarrange", "linear"].join("-")) normalized.runtime = DEFAULT_RUNTIME_NAME;
  normalized.agents = normalizeAgentMap(normalized.agents);
  normalized.gitCoordination = normalizeGitCoordination(normalized.gitCoordination);
  if (Array.isArray(normalized.review?.llm?.agents)) {
    normalized.review = {
      ...normalized.review,
      llm: {
        ...normalized.review.llm,
        agents: normalized.review.llm.agents.map(normalizeAgentKey).filter(Boolean),
      },
    };
  }
  const verbosity = String(normalized.reporting?.verbosity || "verbose").trim().toLowerCase();
  if (!["verbose", "normal", "quiet"].includes(verbosity)) {
    throw new Error(`reporting.verbosity must be verbose, normal, or quiet; received ${normalized.reporting?.verbosity}`);
  }
  normalized.reporting = { ...normalized.reporting, verbosity };
  return normalized;
}

function normalizeGitCoordination(value) {
  const input = isPlainObject(value) ? value : {};
  const mode = String(input.mode || "guarded").trim().toLowerCase();
  if (!["off", "manual", "guarded", "strict"].includes(mode)) {
    throw new Error(`gitCoordination.mode must be off, manual, guarded, or strict; received ${input.mode}`);
  }
  const normalized = {
    ...input,
    mode,
    remote: nonEmptyConfigString(input.remote, "origin"),
    integrationBranch: nonEmptyConfigString(input.integrationBranch, "auto"),
    taskBranchPrefix: nonEmptyConfigString(input.taskBranchPrefix, "wildarrange/task").replace(/^\/+|\/+$/g, ""),
    requireWorktreeForParallelWrites: input.requireWorktreeForParallelWrites !== false,
    requireVerificationBeforeHandoff: input.requireVerificationBeforeHandoff === true,
    requireCleanHandoff: input.requireCleanHandoff !== false,
    // Takeover evidence is an immutable floor whenever this config exists;
    // keep the explicit field visible, but never normalize it to false.
    requireTakeoverReason: true,
  };
  // strict is a profile, not a collection of individually weakenable flags.
  if (mode === "strict") {
    normalized.requireWorktreeForParallelWrites = true;
    normalized.requireVerificationBeforeHandoff = true;
    normalized.requireCleanHandoff = true;
    normalized.requireTakeoverReason = true;
  }
  return normalized;
}

function nonEmptyConfigString(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeAgentMap(agents) {
  if (!isPlainObject(agents)) return agents;
  const normalized = {};
  for (const [name, value] of Object.entries(agents)) {
    const key = normalizeAgentKey(name);
    if (!key) continue;
    normalized[key] = isPlainObject(value) && isPlainObject(normalized[key])
      ? deepMerge(normalized[key], value)
      : value;
  }
  for (const [name, value] of Object.entries(normalized)) {
    if (!isPlainObject(value)) continue;
    normalized[name] = {
      ...value,
      skills: normalizeAgentSkills(value.skills, name),
    };
  }
  return normalized;
}

function normalizeAgentSkills(value, agentName) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`agents.${agentName}.skills must be an array`);
  const skills = [];
  for (const item of value) {
    if (typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(item.trim())) {
      throw new Error(`agents.${agentName}.skills contains an invalid skill name: ${String(item)}`);
    }
    const name = item.trim();
    if (!skills.includes(name)) skills.push(name);
  }
  return skills;
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
