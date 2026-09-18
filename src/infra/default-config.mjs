// =============================================================================
// 文件名称：default-config.mjs
// 所属模块：infra
// 作用说明：
//   wildarrange.config.json 内置默认值与 DEFAULT_RUNTIME_NAME。
//
// 【运行原理速读】
//   DEFAULT_WILDARRANGE_CONFIG 深拷贝合并 → 新项目 init 起点。
// =============================================================================
/**
 * 默认 Prompt Pack / runtime 名称。
 */
export const DEFAULT_RUNTIME_NAME = "wildarrange-linear";

/**
 * wildarrange.config.json 完整默认配置对象。
 */
// --- 默认配置对象 ---
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
      verify: ["review-work", "design-acceptance", "visual-qa", "configure-project-review", "project-onboarding", "review-architecture-design"],
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
  executionReadiness: { workerProbe: null, researchProbe: null, researchSkills: [], timeoutMs: 30000 },
  review: {
    steps: [],
    responsibility: { command: null, timeoutMs: 120000, maxEvidenceChars: 500000 },
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
