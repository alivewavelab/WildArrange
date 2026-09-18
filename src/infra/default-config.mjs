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
  version: 1, // 配置 schema 版本；与 runtime-store STATE_VERSION 独立
  runtime: DEFAULT_RUNTIME_NAME, // 使用的 Prompt Pack / 编排 runtime 名
  // 宿主 adapter 开关与 hook 接入模式（cli-adapter / plugin-adapter）
  adapters: {
    codex: { enabled: true, hookMode: "cli-adapter" },
    cursor: { enabled: true, hookMode: "cli-adapter" },
    kimi: { enabled: true, hookMode: "plugin-adapter" },
  },
  // LLM 提供商端点与 API key 环境变量名；host 表示走 IDE 内置模型
  modelProviders: {
    host: { type: "host", adapter: "auto" },
    deepseek: { type: "openai-compatible", apiKeyEnv: "DEEPSEEK_API_KEY", baseUrlEnv: "DEEPSEEK_BASE_URL", defaultBaseUrl: "https://api.deepseek.com" },
    kimi: { type: "openai-compatible", apiKeyEnv: "KIMI_API_KEY", baseUrlEnv: "KIMI_BASE_URL", defaultBaseUrl: "https://api.moonshot.cn/v1" },
    qwen: { type: "openai-compatible", apiKeyEnv: "QWEN_API_KEY", baseUrlEnv: "QWEN_BASE_URL", defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    gemini: { type: "openai-compatible", apiKeyEnv: "GEMINI_API_KEY", baseUrlEnv: "GEMINI_BASE_URL" },
  },
  // 长期 Agent 角色、provider、推理档位与挂载 skill 列表
  agents: {
    Jiuwei: { role: "workflow_orchestrator", provider: "host", model: "host-default", reasoning: "high", skills: [] },
    DiJiang: { role: "planner", provider: "host", model: "host-default", reasoning: "high", skills: [] },
    ZhuRong: { role: "implementation_worker", provider: "host", model: "host-default", reasoning: "medium", skills: [] },
    BaiZe: { role: "independent_reviewer", provider: "host", model: "host-default", reasoning: "xhigh", skills: [] },
    LuWu: { role: "repository_steward", provider: "host", model: "host-default", reasoning: "high", skills: [] },
  },
  // 可选「仓颉」路由/记忆子系统；默认关闭，启用后按 trigger 写入结构化记忆
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
  // 路由决策的日终审查与语义 shadow 低置信度兜底
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
  // Git 多 Agent 写协调：mode off|manual|guarded|strict；strict 不可单独削弱子开关
  gitCoordination: {
    mode: "guarded", // off=禁用；manual=仅显式请求；guarded=有 guard；strict=最严
    remote: "origin", // 远端名，用于 fetch/push 与 integration guard
    integrationBranch: "auto", // auto 时解析 remote HEAD；否则固定分支名
    taskBranchPrefix: "wildarrange/task", // 自动 push 仅允许此前缀下的任务分支
    requireWorktreeForParallelWrites: true, // 并行写必须隔离 worktree
    requireVerificationBeforeHandoff: false, // true 时 handoff 前须 verify PASS
    requireCleanHandoff: true, // handoff 前工作区须干净（不含 .wildarrange 运行时）
    requireTakeoverReason: true, // 接管任务须留 immutable 原因（normalize 不可关）
  },
  // 并行 spawn 子 Agent：隔离目录、超时与 adapter 命令模板占位
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
  // Hook 注入 skill 的动态匹配：阶段加权与 alwaysMount 底线 skill
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
  // 各 injection point 的 markdown/skill 字符预算上限
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
  // 执行前 worker/research 探测命令；null 表示不探测
  executionReadiness: { workerProbe: null, researchProbe: null, researchSkills: [], timeoutMs: 30000 },
  // 审查 lane 步骤、职责命令与可选 LLM 审查配置
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
  // 在 command-safety 内置模式之上追加项目自定义高风险正则（只增不减）
  commandSafety: {
    extraPatterns: [],
  },
  // 汇报分级：verbose = 每次 run 结束输出一次门决策汇总（框架初期默认，
  // 让人能审判每一条门决策）；随信任建立可降 normal（一行）/ quiet（只 JSON）。
  reporting: {
    verbosity: "verbose",
  },
  planApproval: {
    required: false, // true 时计划须人类批准后才能 execute
  },
  // 验证制品 registry/bootstrap/inventory 路径；空串表示用默认推导路径
  verificationGovernance: {
    registryPath: "",
    bootstrapPath: "",
    inventoryPath: "",
    archiveRoot: "",
  },
  // 质量门：lsp/ast/hashline/commentChecker；required=true 时失败阻断交付
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
  // AGENTS/rules 静态与动态注入预算及扫描路径
  ruleInjection: {
    mode: "both",
    maxRuleChars: 12000,
    maxResultChars: 40000,
    dynamicMaxRuleChars: 4000,
    dynamicMaxResultChars: 10000,
    projectSingleFiles: ["AGENTS.md", "CLAUDE.md", "CONTEXT.md", ".github/copilot-instructions.md"],
    projectRuleDirs: [".claude/rules", ".cursor/rules", ".github/instructions"],
  },
  // 仓库布局/命名/文档对治理；默认关闭，启用后 audit 违规写报告
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
  // 各 Hook 点的 tools/markdown/skills/rules 注入清单（与 ai/injection 对齐）
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
