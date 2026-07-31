import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";

import { startDashboardServer } from "../src/helix-dashboard.mjs";
import {
  appendLedger,
  admitParallelAgentResult,
  approvePlan,
  buildAgentContext,
  compileCommandSafetyPatterns,
  evaluateCommandSafety,
  loadPlanApproval,
  writeDefaultHelixConfig,
  buildArchivistPacket,
  closeParallelAgentRun,
  cleanupParallelAgentRun,
  continuationDirective,
  createSamplePlan,
  createTeamTask,
  claimTeamTask,
  classifyManifestPathChanges,
  dashboardData,
  getTeamTask,
  hashLine,
  importPlan,
  installAdapter,
  initRuntime,
  listArchivistRouteSuggestions,
  listParallelAgentRuns,
  loadHelixConfig,
  listTeamMessages,
  listTeamTasks,
  attentionReport,
  listChangeRequests,
  listPromptPack,
  listRuntimeStateBackups,
  restoreRuntimeStateBackup,
  runDoctor,
  pathAllowed,
  parallelAgentStatus,
  preToolUseGuard,
  readJson,
  recordReviewBlocker,
  recordTaskEvidence,
  renderPromptPackEntry,
  resolvePromptVariant,
  resolveChangeRequest,
  resolveArchivistRouteSuggestion,
  resolveInjectionPoint,
  resumeReport,
  reviewChangeRequest,
  runArchivistRouter,
  resolveAgentProvider,
  resolveHelixPath,
  routeRequest,
  runInjectionHook,
  runParallelAgents,
  runCommand,
  runWorkflowNode,
  runNextTask,
  runWorkflow,
  sendTeamMessage,
  scanProjectRules,
  scopeGuard,
  statusReport,
  steerWorkflow,
  uninstallAdapter,
  restoreAdapterBackup,
  matchSkills,
  validatePlanGraph,
  verifyConfigBaseline,
  verifyLedger,
  verifyRuntimeState,
  writeConfigBaseline,
  writeRuntimeStateBackup,
  writeWorkflowSummary,
} from "../src/helix-core.mjs";

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-linear-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeMinimalPromptPack(rootDir, skills = {}) {
  const packDir = path.join(rootDir, "prompt-pack");
  await mkdir(path.join(packDir, "skills"), { recursive: true });
  await mkdir(path.join(packDir, "tools"), { recursive: true });
  const skillManifest = {};
  for (const [name, content] of Object.entries(skills)) {
    const skillPath = `skills/${name}.md`;
    skillManifest[name] = skillPath;
    await writeFile(path.join(packDir, skillPath), content);
  }
  await writeFile(path.join(packDir, "tools", "tool-contract.json"), JSON.stringify({ tools: [] }, null, 2));
  await writeFile(path.join(packDir, "manifest.json"), JSON.stringify({
    version: 1,
    name: "test-pack",
    description: "Test prompt pack",
    source: { project: "WildArrange test" },
    agents: {},
    skills: skillManifest,
    tools: "tools/tool-contract.json",
  }, null, 2));
  return packDir;
}

async function withDashboard(dir, fn, options = {}) {
  const server = await startDashboardServer(dir, { host: "127.0.0.1", port: 0, token: options.token });
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    assert.ok(port);
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

async function withLlmServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : null;
    assert.ok(port);
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}

async function postJson(url, body, options = {}) {
  return fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    body: JSON.stringify(body || {}),
  });
}

function nodeEval(source) {
  return `node -e ${JSON.stringify(source.replace(/\s*\n\s*/g, " ").trim())}`;
}

test("init creates durable runtime state", async () => {
  await withTempDir(async (dir) => {
    const work = await initRuntime(dir);
    assert.equal(work.stage, "initialized");
    assert.ok(await readJson(resolveHelixPath(dir, "agents.json")));
    assert.ok(await readJson(resolveHelixPath(dir, "categories.json")));
  });
});

test("init installs wildarrange-linear prompt, skill, and tool contracts", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const pack = await listPromptPack(dir);
    assert.equal(pack.name, "wildarrange-linear");
    assert.deepEqual(
      pack.agents.sort(),
      [
        "ZhuRong",
        "BaiZe",
        "DiJiang",
        "Router",
        "Jiuwei",
        "LuWu",
      ].sort(),
    );
    assert.ok(pack.skills.includes("review-work"));
    assert.equal(pack.tools, "tools/tool-contract.json");
    assert.equal(pack.routes, "routes.json");
    assert.ok(pack.skills.includes("wildarrange-injection-runtime"));

    const jiuweiPrompt = await renderPromptPackEntry(dir, { agent: "Jiuwei" });
    assert.match(jiuweiPrompt, /verifier/);

    const reviewSkill = await renderPromptPackEntry(dir, { skill: "review-work" });
    assert.match(reviewSkill, /目标验证器/);

    const toolContract = JSON.parse(await renderPromptPackEntry(dir, { tools: true }));
    assert.equal(toolContract.runtime, "wildarrange-linear");
    assert.ok(toolContract.tools.some((tool) => tool.name === "helix_run_next"));
    assert.ok(toolContract.tools.some((tool) => tool.name === "scope_guard"));
    assert.ok(toolContract.tools.some((tool) => tool.name === "ast_grep_search"));
    assert.ok(toolContract.tools.some((tool) => tool.name === "team_send_message"));
    assert.ok(toolContract.tools.some((tool) => tool.name === "repository_governance_audit"));

    const routeTable = JSON.parse(await renderPromptPackEntry(dir, { routes: true }));
    assert.equal(routeTable.version, 1);
    assert.ok(routeTable.intents.some((intent) => intent.name === "execute"));
    assert.ok(routeTable.planSkillBundles.some((skill) => skill.name === "review-product-intent"));
  });
});

test("route decision loads product planning skills on demand", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const route = await routeRequest(dir, {
      text: "做一个网页版提醒事项 App，一期 MVP 要有清单流程、空状态、验收标准和失败恢复。",
    });

    assert.equal(route.domain, "visual");
    assert.equal(route.category, "visual-engineering");
    assert.ok(route.planSkills.some((skill) => skill.name === "review-product-intent"));
    assert.ok(route.planSkills.some((skill) => skill.name === "map-user-journey"));
    assert.ok(route.planSkills.some((skill) => skill.name === "design-acceptance"));
    assert.ok(route.planSkills.some((skill) => skill.name === "review-ux-interaction"));
    assert.ok(route.planSkills.some((skill) => skill.name === "review-scope-tradeoff"));
    assert.match(route.reason, /验收/);
  });
});

test("skill matcher and prompt variants provide explainable loading hints", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);

    const matched = await matchSkills(dir, {
      text: "做一个网页版提醒事项 App，需要空状态、视觉验收和实现计划。",
      stage: "design",
      agent: "Jiuwei",
      limit: 20,
    });
    assert.ok(matched.matched.some((skill) => skill.name === "frontend-ui-ux"));
    assert.ok(matched.matched.some((skill) => skill.name === "visual-qa"));
    assert.ok(matched.matched.every((skill) => skill.score > 0));
    assert.ok(matched.matched.some((skill) => skill.reasons.some((reason) => reason.startsWith("stage:"))));

    const gptVariant = await resolvePromptVariant(dir, { agent: "Jiuwei", model: "gpt-5.5" });
    assert.equal(gptVariant.variant, "gpt");
    assert.match(gptVariant.content, /验收标准/);

    const kimiVariant = await resolvePromptVariant(dir, { provider: "kimi", model: "kimi-2.6" });
    assert.equal(kimiVariant.variant, "kimi");
    assert.match(kimiVariant.content, /长上下文写作/);
  });
});

test("config controls models and injection point mounts", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      agents: {
        BaiZe: { provider: "host", model: "host-default", reasoning: "xhigh" },
      },
      injectionPoints: {
        before_review: {
          enabled: true,
          tools: ["review_gate", "helix_evidence_record"],
          markdown: ["CLAUDE.md"],
          skills: ["review-work", "wildarrange-injection-runtime"],
          rules: { mode: "dynamic" },
        },
      },
    }, null, 2));
    await writeFile(path.join(dir, "CLAUDE.md"), "# Local Rules\n\nUse real verification.\n");
    await initRuntime(dir);

    const loaded = await loadHelixConfig(dir);
    assert.equal(loaded.sourcePath, "helix.config.json");
    assert.equal(loaded.config.agents.BaiZe.reasoning, "xhigh");

    const injection = await resolveInjectionPoint(dir, "before_review", { agent: "BaiZe", taskId: "T001" });
    assert.deepEqual(injection.tools, ["review_gate", "helix_evidence_record"]);
    assert.equal(injection.markdown[0].path, "CLAUDE.md");
    assert.ok(injection.markdown[0].content.includes("Use real verification"));
    assert.ok(injection.skills.some((skill) => skill.name === "review-work"));
    assert.ok(injection.skills.some((skill) => skill.name === "wildarrange-injection-runtime"));
  });
});

test("LuWu governance injection mounts the declared read-only tools and Skills", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const injection = await resolveInjectionPoint(dir, "repository_governance", { agent: "LuWu" });
    assert.deepEqual(injection.tools, [
      "repository_governance_audit",
      "helix_rules_collect",
      "comment_check",
      "config_verify",
    ]);
    for (const skill of ["repository-governance", "init-deep", "pre-publish-review", "remove-ai-slops"]) {
      assert.ok(injection.skills.some((entry) => entry.name === skill), skill);
    }
  });
});

test("injection budgets load activated skills beyond legacy six thousand chars", async () => {
  await withTempDir(async (dir) => {
    const skillBody = `# 重型 Skill\n\n${"长流程内容。".repeat(1_200)}\n\n末尾校验：完整加载\n`;
    const packDir = await writeMinimalPromptPack(dir, { "heavy-flow": skillBody });
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      injectionPoints: {
        before_execute: {
          enabled: true,
          tools: [],
          markdown: [],
          skills: ["heavy-flow"],
          rules: { mode: "dynamic" },
        },
      },
    }, null, 2));
    await initRuntime(dir, { promptPackDir: packDir });

    const injection = await resolveInjectionPoint(dir, "before_execute", { taskId: "T001" });
    const skill = injection.skills[0];
    assert.ok(skill.chars > 6_000);
    assert.equal(skill.truncated, false);
    assert.equal(skill.budgetChars, 80_000);
    assert.match(skill.content, /末尾校验：完整加载/);
  });
});

test("injection budgets expose explicit truncation metadata", async () => {
  await withTempDir(async (dir) => {
    const skillBody = `# 超重工作流\n\n${"需要按阶段执行的长步骤。".repeat(2_000)}\n\n末尾不应进入注入\n`;
    const packDir = await writeMinimalPromptPack(dir, { "heavy-flow": skillBody });
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      contextBudgets: {
        points: {
          before_execute: { skillMaxChars: 3_000 },
        },
      },
      injectionPoints: {
        before_execute: {
          enabled: true,
          tools: [],
          markdown: [],
          skills: ["heavy-flow"],
          rules: { mode: "dynamic" },
        },
      },
    }, null, 2));
    await initRuntime(dir, { promptPackDir: packDir });

    const injection = await resolveInjectionPoint(dir, "before_execute", { taskId: "T001" });
    const skill = injection.skills[0];
    assert.equal(skill.truncated, true);
    assert.equal(skill.budgetChars, 3_000);
    assert.ok(skill.content.length <= 3_000);
    assert.match(skill.content, /上下文已截断/);
    assert.doesNotMatch(skill.content, /末尾不应进入注入/);
  });
});

test("default GPT-family agents are delegated to the host provider", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const { config } = await loadHelixConfig(dir);
    assert.equal(config.modelProviders.host.type, "host");
    assert.equal(config.agents.Jiuwei.provider, "host");
    assert.equal(config.agents.BaiZe.provider, "host");
    assert.equal(config.modelProviders.openai, undefined);
    assert.deepEqual(config.review.llm.agents, ["BaiZe"]);

    const resolved = resolveAgentProvider(config, "BaiZe");
    assert.equal(resolved.available, false);
    assert.equal(resolved.hostManaged, true);
    assert.match(resolved.reason, /managed by the host adapter/);
  });
});

test("legacy agent names resolve to WildArrange agent keys", async () => {
  await withTempDir(async (dir) => {
    const legacyExecutor = ["At", "las"].join("");
    const legacyReviewer = ["Mo", "mus"].join("");
    const legacyLead = ["Sisy", "phus"].join("");
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      agents: {
        [legacyExecutor]: { provider: "host", model: "legacy-executor" },
        [legacyReviewer]: { provider: "host", model: "legacy-reviewer" },
      },
      review: {
        llm: { enabled: false, agents: [legacyReviewer] },
      },
    }, null, 2));
    await initRuntime(dir);

    const { config } = await loadHelixConfig(dir);
    assert.equal(config.agents.Jiuwei.model, "legacy-executor");
    assert.equal(config.agents.BaiZe.model, "legacy-reviewer");
    assert.deepEqual(config.review.llm.agents, ["BaiZe"]);

    const message = await sendTeamMessage(dir, { from: legacyLead, to: legacyExecutor, body: "legacy route" });
    assert.equal(message.from, "Jiuwei");
    assert.equal(message.to, "Jiuwei");

    const legacyPrompt = await renderPromptPackEntry(dir, { agent: legacyExecutor });
    assert.match(legacyPrompt, /Jiuwei/);
  });
});

test("hook adapter emits WildArrange runtime injection for user prompt", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "AGENTS.md"), "# Project Rules\n\nAlways verify behavior.\n");
    await initRuntime(dir);

    const result = await runInjectionHook(dir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      cwd: dir,
      prompt: "做一个网页版 TODO 工具，支持删除任务",
    });

    assert.equal(result.event, "UserPromptSubmit");
    assert.equal(result.pointName, "user_prompt_submit");
    assert.match(result.output, /<wildarrange-injection event="UserPromptSubmit" point="user_prompt_submit">/);
    assert.match(result.output, /## 路由决策/);
    assert.match(result.output, /类别：visual-engineering/);
    assert.match(result.output, /计划 Skill 组合/);
    assert.match(result.output, /review-ux-interaction/);
    assert.match(result.output, /项目规则/);
    assert.match(result.output, /Always verify behavior/);

    const hookRecord = await readJson(resolveHelixPath(dir, "sessions", "hooks", "session-1-UserPromptSubmit.json"));
    assert.equal(hookRecord.event, "UserPromptSubmit");
    assert.ok(hookRecord.output.length > 0);
  });
});

test("hook adapter triggers ArchivistRouter without blocking user prompt injection", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      modelProviders: {
        deepseek: { type: "openai-compatible", apiKeyEnv: "HELIX_TEST_MISSING_DEEPSEEK_KEY", defaultBaseUrl: "https://api.deepseek.com" },
      },
      archivistRouter: { enabled: true },
    }, null, 2));
    await initRuntime(dir);

    const result = await runInjectionHook(dir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-archivist",
      cwd: dir,
      prompt: "做一个网页版 TODO 工具，先计划再实现。",
      turns: [
        { role: "assistant", content: "结论：先确认 MVP。\n```js\nconsole.log('drop me')\n```" },
        { role: "user", content: "要支持完成和删除。" },
      ],
    });

    assert.equal(result.event, "UserPromptSubmit");
    assert.ok(result.output.length > 0);
    assert.match(result.output, /## 档案路由/);
    assert.match(result.output, /状态：fallback/);
    const archivist = await readJson(resolveHelixPath(dir, "memory", "last-archivist-result.json"));
    assert.equal(archivist.llmStatus, "fallback");
    assert.equal(archivist.packet.stage, "plan");
    assert.doesNotMatch(JSON.stringify(archivist.packet), /console\.log/);
    assert.match(await readFile(resolveHelixPath(dir, "memory", "events.jsonl"), "utf8"), /archivist_fallback/);
  });
});

test("hook adapter injects dynamic rules after tool use target paths", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, ".cursor", "rules"), { recursive: true });
    await writeFile(path.join(dir, ".cursor", "rules", "ui.md"), [
      "---",
      "description: UI files need browser verification",
      "globs: [src/**]",
      "---",
      "Run browser verification after UI changes.",
      "",
    ].join("\n"));
    await initRuntime(dir);

    const result = await runInjectionHook(dir, {
      hook_event_name: "PostToolUse",
      session_id: "session-2",
      cwd: dir,
      tool_name: "apply_patch",
      tool_input: { file_path: "src/app.js" },
      tool_response: { ok: true },
    });

    assert.equal(result.pointName, "post_tool_use");
    assert.deepEqual(result.targetPaths, ["src/app.js"]);
    assert.match(result.output, /动态目标/);
    assert.match(result.output, /src\/app\.js/);
    assert.match(result.output, /工具结果门/);
    assert.match(result.output, /决策：pass/);
    assert.match(result.output, /UI files need browser verification/);
    assert.match(result.output, /Run browser verification after UI changes/);
  });
});

test("post-tool-use result gate blocks failed tool evidence", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);

    const result = await runInjectionHook(dir, {
      hook_event_name: "PostToolUse",
      session_id: "session-failed-tool",
      cwd: dir,
      tool_name: "exec_command",
      tool_response: {
        exitCode: 127,
        stderr: "zsh: command not found: pnpmx",
      },
    });

    assert.equal(result.decision, "block");
    assert.match(result.output, /工具结果门/);
    assert.match(result.output, /决策：block/);
    assert.match(result.output, /nonzero_exit_code/);
    assert.match(result.output, /command_not_found/);

    const ledger = await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8");
    assert.match(ledger, /hook_result_gate/);
  });
});

test("pre-tool-use guard denies out-of-scope file writes before they land", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Scoped edit",
      objective: "Only src/app.js can change.",
      tasks: [{
        id: "T001",
        subject: "Edit app",
        writable_paths: ["src/app.js"],
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    const guard = await preToolUseGuard(dir, {
      hook_event_name: "PreToolUse",
      session_id: "session-scope",
      cwd: dir,
      taskId: "T001",
      tool_name: "apply_patch",
      tool_input: { file_path: "src/other.js" },
    });

    assert.equal(guard.decision, "deny");
    assert.deepEqual(guard.deniedPaths, ["src/other.js"]);

    const hook = await runInjectionHook(dir, {
      hook_event_name: "PreToolUse",
      session_id: "session-scope",
      cwd: dir,
      taskId: "T001",
      tool_name: "apply_patch",
      tool_input: { file_path: "src/other.js" },
    });
    const output = JSON.parse(hook.output);
    assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /planned scope violation/);
  });
});

test("pre-tool-use guard denies file writes when no task exists", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);

    const hook = await runInjectionHook(dir, {
      hook_event_name: "PreToolUse",
      session_id: "session-no-task",
      cwd: dir,
      tool_name: "functions.apply_patch",
      tool_input: { file_path: "index.html" },
    });
    const output = JSON.parse(hook.output);
    assert.equal(hook.decision, "deny");
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /no active WildArrange task/);
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /no_active_task/);
  });
});

test("adapter install writes slash commands for cursor and codex", async () => {
  await withTempDir(async (dir) => {
    const report = await installAdapter(dir, { target: "all", mode: "npx", packageName: "wildarrange" });

    const cursorDoctor = report.outputs.find((output) => output.path === ".cursor/commands/helix-doctor.md" && output.enforcement === "slash-command");
    assert.ok(cursorDoctor, "cursor doctor command should be generated");
    const codexDoctor = report.outputs.find((output) => output.path === ".agents/skills/helix-doctor/SKILL.md" && output.enforcement === "slash-command");
    assert.ok(codexDoctor, "codex doctor skill should be generated");

    const cursorConfig = await readFile(path.join(dir, ".cursor", "commands", "helix-config.md"), "utf8");
    assert.match(cursorConfig, /config init --root/);
    assert.match(cursorConfig, /npx -y wildarrange/);
    assert.doesNotMatch(cursorConfig, /^name:/m);

    const codexSkill = await readFile(path.join(dir, ".agents", "skills", "helix-doctor", "SKILL.md"), "utf8");
    assert.match(codexSkill, /^name: helix-doctor$/m);
    assert.match(codexSkill, /^description: /m);
    assert.match(codexSkill, /ledger verify/);

    const uninstall = await uninstallAdapter(dir, { target: "all" });
    assert.ok(uninstall.outputs.some((output) => output.path === ".cursor/commands/helix-run.md" && output.status === "removed"));
    assert.ok(uninstall.outputs.some((output) => output.path === ".agents/skills/helix-run/SKILL.md" && output.status === "removed"));
    await assert.rejects(readFile(path.join(dir, ".cursor", "commands", "helix-run.md"), "utf8"), /ENOENT/);
  });
});

test("adapter install writes codex hooks and cursor rules", async () => {
  await withTempDir(async (dir) => {
    const report = await installAdapter(dir, { target: "all", mode: "npx", packageName: "wildarrange" });
    assert.equal(report.mode, "npx");
    assert.ok(report.outputs.some((output) => output.path === ".codex/hooks.json" && output.enforcement === "hard-after-trust"));
    assert.ok(report.outputs.some((output) => output.path === ".helix/adapters/codex/hooks.json"));
    assert.ok(report.outputs.some((output) => output.path === ".cursor/rules/wildarrange.mdc"));

    const codexHooks = await readJson(path.join(dir, ".codex", "hooks.json"));
    assert.ok(codexHooks.hooks.PreToolUse);
    assert.match(codexHooks.hooks.PreToolUse[0].matcher, /Bash/);
    assert.match(codexHooks.hooks.PreToolUse[0].matcher, /apply_patch/);
    assert.match(codexHooks.hooks.PreToolUse[0].matcher, /functions\\\.apply_patch/);
    assert.match(codexHooks.hooks.SessionStart[0].hooks[0].command, /npx -y wildarrange hook run/);
    assert.match(await readFile(resolveHelixPath(dir, "adapters", "install-report.md"), "utf8"), /hard-after-trust/);

    const cursorRule = await readFile(path.join(dir, ".cursor", "rules", "wildarrange.mdc"), "utf8");
    assert.match(cursorRule, /alwaysApply: true/);
    assert.match(cursorRule, /WildArrange Governance Runtime/);

    const cursorRulePath = path.join(dir, ".cursor", "rules", "wildarrange.mdc");
    await writeFile(cursorRulePath, "existing user rule\n");
    const reinstall = await installAdapter(dir, { target: "cursor", mode: "local" });
    const ruleOutput = reinstall.outputs.find((output) => output.path === ".cursor/rules/wildarrange.mdc");
    assert.ok(ruleOutput.backup);
    assert.equal(await readFile(path.join(dir, ruleOutput.backup), "utf8"), "existing user rule\n");

    const uninstall = await uninstallAdapter(dir, { target: "all" });
    const removedCodex = uninstall.outputs.find((output) => output.path === ".codex/hooks.json" && output.status === "removed");
    assert.ok(removedCodex?.backup);
    const removedRule = uninstall.outputs.find((output) => output.path === ".cursor/rules/wildarrange.mdc" && output.status === "removed");
    assert.ok(removedRule?.backup);
    await assert.rejects(readFile(cursorRulePath, "utf8"), /ENOENT/);
    assert.match(await readFile(resolveHelixPath(dir, "adapters", "uninstall-report.md"), "utf8"), /Adapter Uninstall Report/);

    const backupId = removedRule.backup.split("/")[3];
    const restored = await restoreAdapterBackup(dir, { backupId });
    assert.ok(restored.outputs.some((output) => output.path === ".cursor/rules/wildarrange.mdc" && output.status === "restored"));
    assert.match(await readFile(cursorRulePath, "utf8"), /WildArrange Governance Runtime/);
    assert.match(await readFile(resolveHelixPath(dir, "adapters", "restore-report.md"), "utf8"), /Adapter Restore Report/);
  });
});

test("team-lite sends and lists durable inbox messages", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const message = await sendTeamMessage(dir, {
      from: "Jiuwei",
      to: "YingLong",
      body: "Continue T001 after verifier passes.",
      summary: "continue T001",
    });
    assert.equal(message.from, "Jiuwei");
    assert.equal(message.to, "Jiuwei");
    assert.equal(message.status, "unread");
    assert.match(message.inboxPath, /^\.helix\/team\/inbox\/Jiuwei\/msg_.+\.json$/);

    const jiuweiInbox = await listTeamMessages(dir, { agent: "YingLong" });
    assert.equal(jiuweiInbox.length, 1);
    assert.equal(jiuweiInbox[0].id, message.id);
    assert.equal(jiuweiInbox[0].body, "Continue T001 after verifier passes.");

    const allInbox = await listTeamMessages(dir);
    assert.equal(allInbox.length, 1);
    assert.match(await readFile(resolveHelixPath(dir, "team", "messages.md"), "utf8"), /Jiuwei -> Jiuwei: continue T001/);
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /team_message_sent/);
  });
});

test("parallel agents run task packets concurrently and publish results", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "parallel-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel smoke",
      tasks: [
        {
          id: "T001",
          subject: "Parallel research one",
          verify_commands: ["node -e \"process.exit(0)\""],
          writable_paths: [".helix/artifacts/one.txt"],
        },
        {
          id: "T002",
          subject: "Parallel research two",
          verify_commands: ["node -e \"process.exit(0)\""],
          writable_paths: [".helix/artifacts/two.txt"],
        },
      ],
    }, null, 2));
    await importPlan(dir, planPath);

    const command = "node -e \"const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'parallel done'}));\" {outputJson}";
    const batch = await runParallelAgents(dir, {
      maxAgents: 2,
      agent: "ZhuRong",
      command,
    });

    assert.equal(batch.status, "completed");
    assert.equal(batch.taskCount, 2);
    assert.ok(batch.results.every((result) => result.agent === "ZhuRong" && result.pass));
    assert.ok(batch.results.every((result) => result.lifecycle.status === "awaiting_user_acceptance"));
    assert.ok(batch.results.every((result) => result.result.summary === "parallel done"));

    const messages = await listTeamMessages(dir, { agent: "Jiuwei" });
    assert.equal(messages.length, 2);
    assert.ok(messages.every((message) => message.summary.includes("parallel result")));

    const runs = await listParallelAgentRuns(dir);
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0].results.length, 2);

    const status = await parallelAgentStatus(dir, { runId: batch.runId });
    assert.equal(status.runCount, 1);
    assert.equal(status.runs[0].summary.awaiting_user_acceptance, 2);
    assert.ok(status.runs[0].results.every((result) => result.lifecycle.status === "awaiting_user_acceptance"));

    const closed = await closeParallelAgentRun(dir, { runId: batch.runId, taskId: "T001", reason: "user_accepted" });
    assert.deepEqual(closed.closed, ["T001"]);
    const afterClose = await parallelAgentStatus(dir, { runId: batch.runId });
    const closedTask = afterClose.runs[0].results.find((result) => result.taskId === "T001");
    assert.equal(closedTask.lifecycle.status, "closed");
    assert.equal(closedTask.lifecycle.closeReason, "user_accepted");
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /parallel_agents_completed/);
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /parallel_agent_run_closed/);
  });
});

test("read-only long-lived Agents cannot enter the parallel command worker", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "parallel-readonly-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Read-only Agent boundary",
      tasks: [{
        id: "T001",
        subject: "Must not execute",
        verify_commands: ["node -e \"process.exit(0)\""],
        writable_paths: [],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    for (const agent of ["DiJiang", "BaiZe", "LuWu"]) {
      const markerPath = path.join(dir, `${agent}.wrote`);
      const command = nodeEval(`require("fs").writeFileSync(${JSON.stringify(markerPath)}, "forbidden")`);
      await assert.rejects(
        runParallelAgents(dir, { taskIds: ["T001"], agent, command }),
        new RegExp(`agent ${agent} is read-only`),
      );
      await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);
    }
    const ledger = await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8");
    assert.doesNotMatch(ledger, /parallel_agents_started/);
  });
});

test("parallel agents without a runner command are marked skipped", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "parallel-skipped-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel skipped",
      tasks: [{
        id: "T001",
        subject: "Prepare packet only",
        verify_commands: ["node -e \"process.exit(0)\""],
        writable_paths: [".helix/artifacts/one.txt"],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    const batch = await runParallelAgents(dir, { maxAgents: 1 });
    assert.equal(batch.status, "skipped");
    assert.equal(batch.results[0].status, "skipped");
    assert.equal(batch.results[0].pass, false);
    assert.equal(batch.results[0].lifecycle.status, "skipped");
  });
});

test("parallel agents can use configured adapter command templates", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      parallelAgents: {
        spawnAdapters: {
          codex: {
            command: "node -e \"const fs=require('fs'); const packet=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); fs.writeFileSync(process.argv[2], JSON.stringify({summary:'adapter '+packet.agent, files:[{path:'.helix/artifacts/adapter.txt', content:packet.task.id}]}));\" {taskJson} {outputJson}",
          },
        },
      },
    }, null, 2));
    await initRuntime(dir);
    const planPath = path.join(dir, "adapter-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Adapter spawn",
      tasks: [{
        id: "T001",
        subject: "Use adapter command",
        verify_commands: ["node -e \"process.exit(0)\""],
        writable_paths: [".helix/artifacts/adapter.txt"],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    const batch = await runParallelAgents(dir, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      adapter: "codex",
    });

    assert.equal(batch.status, "completed");
    assert.equal(batch.results[0].adapter, "codex");
    assert.equal(batch.results[0].spawnSource, "adapter");
    assert.equal(batch.results[0].result.files[0].path, ".helix/artifacts/adapter.txt");
  });
});

test("parallel admission applies child artifacts only after gates pass", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "parallel-admit-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel admission",
      tasks: [
        {
          id: "T001",
          subject: "Admit child artifact",
          verify_commands: [nodeEval("const fs=require('fs'); if(fs.readFileSync('src/parallel.txt','utf8').trim()!=='ok') process.exit(1);")],
          writable_paths: ["src/**"],
        },
      ],
    }, null, 2));
    const plan = await importPlan(dir, planPath);

    const command = [
      "node -e",
      JSON.stringify("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'artifact ready', files:[{path:'src/parallel.txt', content:'ok\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(dir, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command,
    });
    const admitted = await admitParallelAgentResult(dir, {
      runId: batch.runId,
      taskId: "T001",
    });

    assert.equal(admitted.status, "completed");
    assert.equal(admitted.acceptanceProof.pass, true);
    assert.deepEqual(admitted.appliedPaths, ["src/parallel.txt"]);
    assert.equal(await readFile(path.join(dir, "src", "parallel.txt"), "utf8"), "ok\n");
    const releasedResult = await readJson(resolveHelixPath(dir, "agent-runs", batch.runId, "T001", "result.json"));
    assert.equal(releasedResult.lifecycle.status, "released");
    const checkpoint = await readJson(resolveHelixPath(dir, "checkpoints", `${plan.id}-T001.json`));
    assert.equal(checkpoint.taskId, "T001");
    assert.equal(checkpoint.verifyResult.pass, true);
    assert.equal(checkpoint.scopeResult.status, "pass");
    assert.equal(checkpoint.reviewResult.pass, true);
  });
});

test("parallel admission rolls back child artifacts when gates fail", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "parallel-rollback-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel admission rollback",
      tasks: [{
        id: "T001",
        subject: "Reject bad child artifact",
        verify_commands: [nodeEval("const fs=require('fs'); if(fs.readFileSync('src/parallel.txt','utf8').trim()!=='ok') process.exit(1);")],
        writable_paths: ["src/**"],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    const command = [
      "node -e",
      JSON.stringify("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'bad artifact', files:[{path:'src/parallel.txt', content:'bad\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(dir, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command,
    });
    const admitted = await admitParallelAgentResult(dir, {
      runId: batch.runId,
      taskId: "T001",
    });

    assert.equal(admitted.status, "retry");
    assert.equal(admitted.rollback.status, "rolled_back");
    await assert.rejects(readFile(path.join(dir, "src", "parallel.txt"), "utf8"), /ENOENT/);
    const result = await readJson(resolveHelixPath(dir, "agent-runs", batch.runId, "T001", "result.json"));
    assert.equal(result.lifecycle.status, "awaiting_revision");
    assert.equal(result.lifecycle.rollback.status, "rolled_back");
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /parallel_agent_admission_rolled_back/);
  });
});

test("parallel agents can isolate edits in git worktrees and admit patches", async () => {
  await withTempDir(async (dir) => {
    await runCommand("git init", dir);
    await runCommand("git config user.email test@example.com", dir);
    await runCommand("git config user.name 'WildArrange Test'", dir);
    await writeFile(path.join(dir, "README.md"), "root\n");
    await runCommand("git add README.md", dir);
    await runCommand("git commit -m initial", dir);

    await initRuntime(dir);
    const planPath = path.join(dir, "worktree-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Worktree admission",
      tasks: [{
        id: "T001",
        subject: "Admit worktree patch",
        verify_commands: [nodeEval("const fs=require('fs'); if(fs.readFileSync('src/worktree.txt','utf8').trim()!=='ok') process.exit(1);")],
        writable_paths: ["src/**"],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    const command = [
      "node -e",
      JSON.stringify("const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/worktree.txt','ok\\n'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'worktree patch ready'}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(dir, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      isolation: "git-worktree",
      command,
    });

    assert.equal(batch.status, "completed");
    assert.equal(batch.results[0].isolation, "git-worktree");
    assert.equal(batch.results[0].worktreeAvailable, true);
    assert.deepEqual(batch.results[0].patch.changedPaths, ["src/worktree.txt"]);

    const admitted = await admitParallelAgentResult(dir, {
      runId: batch.runId,
      taskId: "T001",
    });

    assert.equal(admitted.status, "completed");
    assert.deepEqual(admitted.appliedPaths, ["src/worktree.txt"]);
    assert.equal(await readFile(path.join(dir, "src", "worktree.txt"), "utf8"), "ok\n");
  });
});

test("parallel admission rejects artifacts outside writable paths", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "parallel-admit-deny-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel admission deny",
      tasks: [
        {
          id: "T001",
          subject: "Reject leaked artifact",
          verify_commands: ["node -e \"process.exit(0)\""],
          writable_paths: ["src/**"],
        },
      ],
    }, null, 2));
    await importPlan(dir, planPath);

    const command = [
      "node -e",
      JSON.stringify("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'bad artifact', files:[{path:'docs/leak.md', content:'nope\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(dir, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command,
    });

    await assert.rejects(
      admitParallelAgentResult(dir, { runId: batch.runId, taskId: "T001" }),
      /parallel admission denied/,
    );
    await assert.rejects(readFile(path.join(dir, "docs", "leak.md"), "utf8"), /ENOENT/);
  });
});

test("ArchivistRouter builds conclusions-only packets and fallback memory", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      modelProviders: {
        deepseek: { type: "openai-compatible", apiKeyEnv: "HELIX_TEST_MISSING_DEEPSEEK_KEY", defaultBaseUrl: "https://api.deepseek.com" },
      },
    }, null, 2));
    await initRuntime(dir);
    const packet = await buildArchivistPacket(dir, {
      stage: "plan",
      text: "做一个网页版 TODO 工具，先确认 MVP 和验收。",
      turns: [
        { role: "assistant", content: "结论：先做清单。\n```js\nconsole.log('secret')\n```\n+ leaked diff line" },
        { role: "user", content: "补充删除和完成状态。" },
      ],
    });

    assert.equal(packet.stage, "plan");
    assert.equal(packet.turns.length, 2);
    assert.doesNotMatch(JSON.stringify(packet), /console\.log/);
    assert.match(JSON.stringify(packet), /code block removed/);

    const result = await runArchivistRouter(dir, {
      force: true,
      stage: "plan",
      text: "做一个网页版 TODO 工具，支持新增、完成、删除。",
      turns: packet.turns,
    });

    assert.equal(result.kind, "archivist_router_result");
    assert.equal(result.llmStatus, "fallback");
    assert.equal(result.decision.routeDecision.domain, "visual");
    assert.equal(result.decision.memoryUpdates[0].kind, "archivist_fallback");

    const memoryIndex = await readJson(resolveHelixPath(dir, "memory", "index.json"));
    assert.ok(memoryIndex.keywords.fallback >= 1);
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /archivist_router_completed/);
  });
});

test("ArchivistRouter route suggestions require review before affecting routing", async () => {
  await withTempDir(async (dir) => {
    await withLlmServer((request, response) => {
      assert.equal(request.url, "/chat/completions");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "learned a local routing keyword",
              routeDecision: { route: "execute", confidence: 0.9 },
              memoryUpdates: [],
              contextInjection: { progress: ["route keyword learned"] },
              keywordSuggestions: [{
                target: "domains.visual",
                signals: ["画布测试词"],
                evidence: "User used this phrase for visual canvas work.",
                confidence: 0.91,
              }],
            }),
          },
        }],
      }));
    }, async (baseUrl) => {
      await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
        modelProviders: {
          local: { apiKeyEnv: "HELIX_TEST_ARCHIVIST_KEY", baseUrl },
        },
        agents: {
          CangJie: { provider: "local", model: "archivist-test" },
        },
        archivistRouter: { enabled: true, agent: "CangJie" },
      }, null, 2));
      process.env.HELIX_TEST_ARCHIVIST_KEY = "test-key";
      await initRuntime(dir);

      const before = await routeRequest(dir, { text: "处理画布测试词" });
      assert.notEqual(before.domain, "visual");

      const result = await runArchivistRouter(dir, {
        force: true,
        stage: "plan",
        text: "画布测试词在本项目里表示视觉画布类工作。",
      });
      assert.equal(result.llmStatus, "called");

      const suggestions = await listArchivistRouteSuggestions(dir);
      assert.equal(suggestions.length, 1);
      assert.equal(suggestions[0].status, "pending_review");

      const pending = await routeRequest(dir, { text: "处理画布测试词" });
      assert.notEqual(pending.domain, "visual");

      const resolved = await resolveArchivistRouteSuggestion(dir, {
        id: suggestions[0].id,
        decision: "accept",
        evidence: "Test reviewer accepted the local visual synonym.",
        rationale: "The phrase is project-specific and low risk.",
      });
      assert.equal(resolved.status, "accepted");

      const after = await routeRequest(dir, { text: "处理画布测试词" });
      assert.equal(after.domain, "visual");
      assert.equal(after.category, "visual-engineering");
      assert.match(await readFile(resolveHelixPath(dir, "routing", "routes-overrides.json"), "utf8"), /画布测试词/);
    });
  });
});

test("routeRequest maps high-risk domains to the right agents and categories", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      routeGovernance: {
        semanticShadow: { enabled: false },
      },
    }, null, 2));
    await initRuntime(dir);
    const visual = await routeRequest(dir, "优化这个页面 CSS 布局和按钮动效");
    assert.equal(visual.domain, "visual");
    assert.equal(visual.category, "visual-engineering");
    assert.equal(visual.route, "execute");
    assert.ok(visual.skills.includes("frontend-ui-ux"));

    const webTodo = await routeRequest(dir, "做一个网页版 TODO 工具，支持删除任务");
    assert.equal(webTodo.domain, "visual");
    assert.equal(webTodo.route, "plan");
    assert.equal(webTodo.category, "visual-engineering");
    assert.equal(webTodo.needsUserInput, false);
    assert.equal(webTodo.routeAdjusted, true);
    assert.match(webTodo.adjustmentReason, /require planning/);

    const normalAdd = await routeRequest(dir, "新增一个网页按钮");
    assert.equal(normalAdd.intent, "execute");
    assert.equal(normalAdd.route, "execute");
    assert.equal(normalAdd.category, "visual-engineering");

    const plannedFeature = await routeRequest(dir, "实现计划筛选和已完成筛选");
    assert.equal(plannedFeature.intent, "execute");
    assert.equal(plannedFeature.route, "execute");

    const scopeChange = await routeRequest(dir, "计划外新增一个支付功能");
    assert.equal(scopeChange.intent, "change_request");
    assert.equal(scopeChange.route, "change_request");

    const dangerousDelete = await routeRequest(dir, "删除数据库里的生产数据");
    assert.equal(dangerousDelete.intent, "ask");
    assert.equal(dangerousDelete.route, "ask");
    assert.equal(dangerousDelete.needsUserInput, true);

    const governance = await routeRequest(dir, "检查仓库目录规范和 README 同步");
    assert.equal(governance.primaryAgent, "LuWu");
    assert.equal(governance.route, "verify");
    assert.ok(governance.skills.includes("repository-governance"));
    for (const request of ["检查 README 是否同步", "检查README是否同步", "检查代码注释是否合规"]) {
      const naturalGovernance = await routeRequest(dir, request);
      assert.equal(naturalGovernance.intent, "repository_governance", request);
      assert.equal(naturalGovernance.primaryAgent, "LuWu", request);
      assert.equal(naturalGovernance.route, "verify", request);
    }

    const review = await routeRequest(dir, "帮我 review 这次代码是否满足目标");
    assert.equal(review.intent, "review");
    assert.equal(review.primaryAgent, "BaiZe");
    assert.equal(review.category, null);
    assert.ok(review.skills.includes("review-work"));

    const reviewableArtifact = await routeRequest(dir, "write a reviewable artifact");
    assert.equal(reviewableArtifact.intent, "execute");
    assert.equal(reviewableArtifact.route, "execute");
    assert.ok(reviewableArtifact.confidence >= 0.5);

    const vagueExecute = await routeRequest(dir, "随便弄一下");
    assert.equal(vagueExecute.route, "plan");
    assert.equal(vagueExecute.routeAdjusted, true);
    assert.match(vagueExecute.adjustmentReason, /low route confidence/);

    const resume = await routeRequest(dir, "继续上次的工作，从断点恢复");
    assert.equal(resume.intent, "resume");
    assert.equal(resume.route, "recover");
    assert.equal(resume.nextCommand, "node ./bin/helix.mjs resume");

    const architecture = await routeRequest(dir, "优化 Agent 路由和编排状态机，跑通完整 workflow");
    assert.equal(architecture.domain, "logic");
    assert.equal(architecture.route, "plan");
    assert.equal(architecture.primaryAgent, "DiJiang");
    assert.equal(architecture.category, "ultrabrain");
  });
});

test("plan graph validation rejects invalid task dependencies", () => {
  assert.doesNotThrow(() => validatePlanGraph({
    tasks: [
      { id: "T001", blockedBy: [] },
      { id: "T002", blockedBy: ["T001"] },
      { id: "T003", blockedBy: ["T001", "T002"] },
    ],
  }));

  assert.throws(() => validatePlanGraph({
    tasks: [
      { id: "T001", blockedBy: [] },
      { id: "T001", blockedBy: [] },
    ],
  }), /duplicate task id/);

  assert.throws(() => validatePlanGraph({
    tasks: [
      { id: "T001", blockedBy: ["T999"] },
    ],
  }), /unknown task/);

  assert.throws(() => validatePlanGraph({
    tasks: [
      { id: "T001", blockedBy: ["T001"] },
    ],
  }), /cannot block itself/);

  assert.throws(() => validatePlanGraph({
    tasks: [
      { id: "T001", blockedBy: ["T002"] },
      { id: "T002", blockedBy: ["T003"] },
      { id: "T003", blockedBy: ["T001"] },
    ],
  }), /dependency cycle/);
});

test("plan import rejects unknown blockedBy before writing task state", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "bad-dependency-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Bad dependency",
      tasks: [{
        id: "T001",
        subject: "Blocked by missing task",
        blockedBy: ["T999"],
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }));

    await assert.rejects(() => importPlan(dir, planPath), /unknown task/);
    const state = await readJson(resolveHelixPath(dir, "team", "tasks.json"), null);
    assert.equal(state, null);
  });
});

test("plan import rejects high-risk product plans that are under-split", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "lazy-product-plan.json");
    await writeFile(planPath, JSON.stringify({
      id: "plan_content_to_interactive_tools",
      title: "内容转互动工具产品 MVP",
      objective: "用户上传 PDF、TXT、视频后，系统拆结构件、匹配前端工具，并生成带数据的互动工具实例。",
      tasks: [
        {
          id: "T001",
          subject: "写产品 brief 和流程",
          description: "明确产品目标、流程、结构件和互动体验。",
          writable_paths: [".workflow/**"],
          worker_command: "node -e \"process.exit(0)\"",
          verify_commands: ["node -e \"process.exit(0)\""],
        },
        {
          id: "T002",
          subject: "实现静态 MVP",
          description: "实现页面和转换逻辑。",
          blockedBy: ["T001"],
          writable_paths: ["index.html", "src/**", "test/**"],
          worker_command: "node -e \"process.exit(0)\"",
          verify_commands: ["node -e \"process.exit(0)\""],
        },
      ],
    }, null, 2));

    await assert.rejects(() => importPlan(dir, planPath), /requires at least 4 tasks/);
    const state = await readJson(resolveHelixPath(dir, "team", "tasks.json"), null);
    assert.equal(state, null);
  });
});

test("plan import persists route decisions and fills missing task category and skills", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "route-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Visual work",
      tasks: [{
        id: "T001",
        subject: "优化页面 CSS 布局",
        description: "调整按钮样式和页面布局",
        writable_paths: ["src/**"],
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }));

    await importPlan(dir, planPath);
    const state = await readJson(resolveHelixPath(dir, "team", "tasks.json"));
    const task = state.tasks[0];

    assert.equal(task.category, "visual-engineering");
    assert.equal(task.category_source, "route");
    assert.equal(task.route_decision.domain, "visual");
    assert.ok(task.skills.includes("frontend-ui-ux"));
    assert.ok(task.skills.includes("visual-qa"));

    const ledger = await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8");
    assert.match(ledger, /plan_routed/);
  });
});

test("plan import preserves explicit category while recording route decision", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "explicit-category-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Explicit quick work",
      tasks: [{
        id: "T001",
        subject: "单文件小改 README 文案",
        category: "quick",
        writable_paths: ["README.md"],
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }));

    await importPlan(dir, planPath);
    const state = await readJson(resolveHelixPath(dir, "team", "tasks.json"));
    const task = state.tasks[0];

    assert.equal(task.category, "quick");
    assert.equal(task.category_source, "explicit");
    assert.equal(task.route_decision.domain, "writing");
    assert.ok(task.skills.includes("remove-ai-slops"));
  });
});

test("plan import applies default gates and scope to every task", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "defaults-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Default gates",
      defaults: {
        verify_commands: ["node -e \"process.exit(0)\""],
        review_commands: ["node -e \"process.exit(0)\""],
        standards_commands: ["node -e \"process.exit(0)\""],
        writable_paths: ["src/**"],
        skills: ["project-standard"],
      },
      tasks: [{
        id: "T001",
        subject: "Use inherited gates",
        worker_command: "node -e \"process.exit(0)\"",
      }],
    }));

    await importPlan(dir, planPath);
    const state = await readJson(resolveHelixPath(dir, "team", "tasks.json"));
    const task = state.tasks[0];
    assert.deepEqual(task.verify_commands, ["node -e \"process.exit(0)\""]);
    assert.deepEqual(task.review_commands, ["node -e \"process.exit(0)\""]);
    assert.deepEqual(task.standards_commands, ["node -e \"process.exit(0)\""]);
    assert.deepEqual(task.writable_paths, ["src/**"]);
    assert.ok(task.skills.includes("project-standard"));
  });
});

test("plan import warns about possible no-op tasks", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "noop-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "No-op warning",
      tasks: [{
        id: "T001",
        subject: "Suspicious task",
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }));

    await importPlan(dir, planPath);
    const state = await readJson(resolveHelixPath(dir, "team", "tasks.json"));
    assert.equal(state.tasks[0].governanceWarnings[0].code, "possible_noop_task");
  });
});

test("project rules and agent context collect matching local governance", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "AGENTS.md"), "# AGENTS\n\n必须运行真实测试。\n");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "AGENTS.md"), "# Source Rules\n\nsrc 内修改必须遵守本目录职责。\n");
    await mkdir(path.join(dir, ".cursor", "rules"), { recursive: true });
    await writeFile(path.join(dir, ".cursor", "rules", "frontend.md"), [
      "---",
      "description: Frontend rule",
      "globs: [\"src/**\"]",
      "alwaysApply: false",
      "---",
      "UI 变更必须浏览器验收。",
      "",
    ].join("\n"));
    await initRuntime(dir);
    const planPath = path.join(dir, "rules-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Rules context",
      tasks: [{
        id: "T001",
        subject: "Implement src app",
        writable_paths: ["src/**"],
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }));
    await importPlan(dir, planPath);

    const rules = await scanProjectRules(dir, { targetPaths: ["src/app.js"] });
    assert.equal(rules.total, 3);
    assert.equal(rules.matched, 3);
    assert.ok(rules.rules.some((rule) => rule.path === "AGENTS.md"));
    assert.ok(rules.rules.some((rule) => rule.path === "src/AGENTS.md" && rule.source === "directory_agents"));
    assert.ok(rules.rules.some((rule) => rule.path === ".cursor/rules/frontend.md"));
    assert.match(await readFile(resolveHelixPath(dir, "rules", "context.md"), "utf8"), /UI 变更必须浏览器验收/);

    const context = await buildAgentContext(dir, { agent: "QiongQi", taskId: "T001" });
    assert.equal(context.agent, "BaiZe");
    assert.equal(context.task.id, "T001");
    assert.equal(context.projectRules.matched, 3);
    assert.match(await readFile(resolveHelixPath(dir, "context-agents", "BaiZe-T001.md"), "utf8"), /WildArrange Agent Context/);
  });
});

test("success criteria evidence is recorded and required by checkpoint", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "criteria-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Criteria evidence",
      tasks: [{
        id: "T001",
        subject: "Require manual criteria",
        writable_paths: ["src/**"],
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
        successCriteria: [
          { id: "C001", title: "Manual criterion", status: "pending", expectedEvidence: "manual proof" },
        ],
      }],
    }));
    await importPlan(dir, planPath);

    const recorded = await recordTaskEvidence(dir, {
      taskId: "T001",
      criterionId: "C001",
      status: "pass",
      evidence: "Manual proof captured before execution.",
    });
    assert.equal(recorded.criterion.status, "pass");

    const result = await runNextTask(dir);
    assert.equal(result.status, "completed");
    assert.equal(result.task.successCriteria[0].status, "pass");
  });
});

test("unbound success criteria are not auto-passed by verifier", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "criteria-unbound-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Unbound criteria evidence",
      tasks: [{
        id: "T001",
        subject: "Do not auto-pass manual criterion",
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
        successCriteria: [
          { id: "C001", title: "Manual criterion", status: "pending", expectedEvidence: "manual proof" },
        ],
      }],
    }));
    await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "failed");
    assert.equal(result.task.successCriteria[0].status, "pending");
    assert.equal(result.task.last_failure.reason, "criteria_failed");
  });
});

test("success criteria can be auto-passed only with explicit verifier command refs", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const verifyCommand = "node -e \"process.exit(0)\"";
    const planPath = path.join(dir, "criteria-bound-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Bound criteria evidence",
      tasks: [{
        id: "T001",
        subject: "Auto-pass bound criterion",
        writable_paths: ["src/**"],
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: [verifyCommand],
        successCriteria: [
          { id: "C001", title: "Bound criterion", status: "pending", verifierCommandRefs: [0] },
        ],
      }],
    }));
    await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "completed");
    assert.equal(result.task.successCriteria[0].status, "pass");
    assert.match(result.task.successCriteria[0].evidence[0].evidence, /explicitly bound/);
  });
});

test("steering safely adds tasks and rejects weakening proposals", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "steer-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Steer workflow",
      tasks: [{
        id: "T001",
        subject: "Original task",
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }));
    await importPlan(dir, planPath);

    const rejected = await steerWorkflow(dir, {
      kind: "revise_acceptance",
      targetTaskId: "T001",
      evidence: "skip tests to complete faster",
      rationale: "remove verification",
      verify_commands: ["node -e \"process.exit(0)\""],
    });
    assert.equal(rejected.accepted, false);
    assert.ok(rejected.audit.invariant.rejectedReasons.includes("weakened completion"));

    const emptyVerifier = await steerWorkflow(dir, {
      kind: "revise_acceptance",
      targetTaskId: "T001",
      evidence: "Verifier removal was proposed by mistake.",
      rationale: "This should be rejected because empty verification is not evidence.",
      verify_commands: [],
    });
    assert.equal(emptyVerifier.accepted, false);
    assert.ok(emptyVerifier.audit.invariant.rejectedReasons.includes("verify_commands cannot be empty"));

    const removedVerifier = await steerWorkflow(dir, {
      kind: "revise_acceptance",
      targetTaskId: "T001",
      evidence: "Use a different command instead.",
      rationale: "This should be rejected because it removes the existing gate.",
      verify_commands: ["node -e \"console.log('new weaker gate')\""],
    });
    assert.equal(removedVerifier.accepted, false);
    assert.ok(removedVerifier.audit.invariant.rejectedReasons.some((reason) => reason.includes("verify_commands cannot remove existing gate command")));

    const accepted = await steerWorkflow(dir, {
      kind: "add_task",
      source: "test",
      evidence: "User added a follow-up task with explicit verifier.",
      rationale: "The follow-up is independent and keeps gates intact.",
      task: {
        id: "T002",
        subject: "Follow-up task",
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      },
    });
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.taskState.tasks.length, 2);

    const incompleteReorder = await steerWorkflow(dir, {
      kind: "reorder_pending",
      source: "test",
      evidence: "Only moving one pending task should be rejected.",
      rationale: "Pending order must be an exact permutation, not a partial list.",
      pendingOrder: ["T002"],
    });
    assert.equal(incompleteReorder.accepted, false);
    assert.ok(incompleteReorder.audit.invariant.rejectedReasons.some((reason) => reason.includes("must include every pending task exactly once")));
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /steering_applied/);
  });
});

test("empty verifier commands cannot complete even if task state is corrupted", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "empty-verifier-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Empty verifier guard",
      tasks: [{
        id: "T001",
        subject: "Corrupted task should not pass",
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }));
    await importPlan(dir, planPath);

    const taskStatePath = resolveHelixPath(dir, "team", "tasks.json");
    const taskState = await readJson(taskStatePath);
    taskState.tasks[0].verify_commands = [];
    await writeFile(taskStatePath, JSON.stringify(taskState, null, 2));

    const result = await runNextTask(dir);
    assert.equal(result.status, "retry");
    assert.equal(result.verifyResult.pass, false);
    assert.match(result.verifyResult.results[0].stderr, /verify_commands must contain at least one command/);
    assert.equal(result.task.last_failure.reason, "verifier_failed");
    assert.equal(result.task.status, "pending");
  });
});

test("review blockers create a resolution task without completing the blocked task", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "blocker-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Review blocker",
      tasks: [{
        id: "T001",
        subject: "Task needing final review",
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }));
    await importPlan(dir, planPath);
    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    await runWorkflowNode(dir, "verify", { taskId: "T001" });

    const blocked = await recordReviewBlocker(dir, {
      taskId: "T001",
      title: "Resolve missing browser verification",
      objective: "Run browser-level evidence before final checkpoint.",
      evidence: "BaiZe final review found missing browser evidence.",
      rationale: "The blocker must be resolved as a separate task.",
      worker_command: "node -e \"process.exit(0)\"",
      verify_commands: ["node -e \"process.exit(0)\""],
    });
    assert.equal(blocked.blockedTask.status, "review_blocked");
    assert.equal(blocked.resolutionTask.reviewBlockerFor, "T001");
    const status = await statusReport(dir);
    assert.equal(status.review_blocked, 1);
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /review_blocker_recorded/);
  });
});

test("continuation directive reports runnable work across sessions", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const samplePath = await createSamplePlan(dir);
    await importPlan(dir, samplePath);
    const directive = await continuationDirective(dir, { sessionId: "codex-a", source: "test" });
    assert.equal(directive.shouldContinue, true);
    assert.equal(directive.reason, "runnable_task");
    assert.equal(directive.nextCommand, "node ./bin/helix.mjs run");
    assert.match(await readFile(resolveHelixPath(dir, "sessions", "continuation.md"), "utf8"), /Should continue: yes/);
  });
});

test("linear loop runs worker, verifies, checkpoints, and records ledger", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const samplePath = await createSamplePlan(dir);
    const plan = await importPlan(dir, samplePath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "completed");
    assert.equal(result.task.id, "T001");

    const report = await statusReport(dir);
    assert.equal(report.planId, plan.id);
    assert.equal(report.completed, 1);
    assert.equal(report.pending, 0);

    const artifact = await readFile(path.join(dir, ".helix", "artifacts", "linear-smoke.txt"), "utf8");
    assert.equal(artifact.trim(), "ok");

    const checkpoint = await readJson(resolveHelixPath(dir, "checkpoints", `${plan.id}-T001.json`));
    assert.equal(checkpoint.taskId, "T001");
    assert.equal(checkpoint.scopeResult.status, "pass");
    assert.equal(checkpoint.reviewResult.pass, true);

    const acceptanceProof = await readJson(resolveHelixPath(dir, "reports", "acceptance", `${plan.id}-T001.json`));
    assert.equal(acceptanceProof.pass, true);
    assert.ok(acceptanceProof.checks.every((check) => check.status === "pass"));
    const digest = await readJson(resolveHelixPath(dir, "memory", "last-digest.json"));
    assert.equal(digest.reason, "task_completed");
    assert.equal(digest.task.id, "T001");

    const reviewReport = await readJson(resolveHelixPath(dir, "reports", "reviews", `${plan.id}-T001.json`));
    assert.equal(reviewReport.status, "pass");
    assert.ok(reviewReport.lanes.some((lane) => lane.name === "goal_compliance"));

    const ledger = await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8");
    assert.match(ledger, /task_verified/);
    assert.match(ledger, /review_gate_completed/);
    assert.match(ledger, /snapshot_written/);
  });
});

test("ledger verification detects tampered hash chain entries", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    let verification = await verifyLedger(dir);
    assert.equal(verification.ok, true);

    const ledgerPath = resolveHelixPath(dir, "ledger.jsonl");
    const lines = (await readFile(ledgerPath, "utf8")).trim().split(/\r?\n/);
    const first = JSON.parse(lines[0]);
    first.type = "tampered_event";
    lines[0] = JSON.stringify(first);
    await writeFile(ledgerPath, `${lines.join("\n")}\n`);

    verification = await verifyLedger(dir);
    assert.equal(verification.ok, false);
    assert.ok(verification.failures.some((failure) => failure.reason === "hash_mismatch"));
  });
});

test("ledger appends are serialized under concurrent writers", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await Promise.all(Array.from({ length: 20 }, (_, index) => appendLedger(dir, {
      type: "concurrent_test_event",
      index,
    })));

    const verification = await verifyLedger(dir);
    assert.equal(verification.ok, true);
    const ledger = await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8");
    const events = ledger.split(/\r?\n/).filter((line) => line.includes("concurrent_test_event"));
    assert.equal(events.length, 20);
  });
});

test("command safety blocks destructive shell commands before execution", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const result = await runCommand("rm -rf .helix", dir);
    assert.equal(result.exitCode, 126);
    assert.match(result.stderr, /Command blocked by WildArrange command safety/);
    assert.equal(result.safety.allowed, false);

    const ledger = await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8");
    assert.match(ledger, /runtime_initialized/);
  });
});

test("runCommand caps command output and reports timeout metadata", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const noisy = await runCommand(nodeEval(`
      process.stdout.write("x".repeat(50));
      process.stderr.write("y".repeat(50));
    `), dir, 120_000, { maxOutputChars: 10 });
    assert.equal(noisy.exitCode, 0);
    assert.equal(noisy.stdout.length, 10);
    assert.equal(noisy.stderr.length, 10);
    assert.equal(noisy.outputTruncated.stdout, true);
    assert.equal(noisy.outputTruncated.stderr, true);

    const timedOut = await runCommand(nodeEval("setInterval(() => {}, 1000);"), dir, 10);
    assert.equal(timedOut.exitCode, 124);
    assert.equal(timedOut.timedOut, true);
    assert.match(timedOut.stderr, /Command timed out after 10ms/);
  });
});

test("config baseline detects quality gate configuration changes", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const rootConfigPath = path.join(dir, "helix.config.json");
    await writeFile(rootConfigPath, `${JSON.stringify({ qualityGates: { commentChecker: { enabled: true, blockOnFindings: true } } }, null, 2)}\n`);

    const baseline = await writeConfigBaseline(dir, { reason: "reviewed" });
    assert.equal(baseline.kind, "config_baseline");
    assert.ok(baseline.files.some((file) => file.path === "helix.config.json"));

    let verification = await verifyConfigBaseline(dir);
    assert.equal(verification.ok, true);

    await writeFile(rootConfigPath, `${JSON.stringify({ qualityGates: { commentChecker: { enabled: false, blockOnFindings: false } } }, null, 2)}\n`);
    verification = await verifyConfigBaseline(dir);
    assert.equal(verification.ok, false);
    assert.ok(verification.failures.some((failure) => failure.path === "helix.config.json" && failure.reason === "hash_mismatch"));
  });
});

test("runtime state backup preserves critical files and verify reports missing state", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const samplePath = await createSamplePlan(dir);
    await importPlan(dir, samplePath);
    let verification = await verifyRuntimeState(dir);
    assert.equal(verification.ok, true);

    const backup = await writeRuntimeStateBackup(dir, { reason: "before-risky-agent" });
    assert.equal(backup.kind, "runtime_state_backup");
    assert.ok(backup.files.some((file) => file.path === ".helix/ledger.jsonl" && file.status === "copied"));

    await rm(resolveHelixPath(dir, "team", "tasks.json"), { force: true });
    verification = await verifyRuntimeState(dir);
    assert.equal(verification.ok, false);
    assert.ok(verification.failures.some((failure) => failure.path === ".helix/team/tasks.json"));

    const manifest = await readJson(resolveHelixPath(dir, "backups", backup.backupId, "manifest.json"));
    assert.equal(manifest.backupId, backup.backupId);
  });
});

test("session hooks inject memory digest summaries", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const samplePath = await createSamplePlan(dir);
    await importPlan(dir, samplePath);
    await runNextTask(dir);

    const hook = await runInjectionHook(dir, {
      hook_event_name: "SessionStart",
      session_id: "session-memory",
      cwd: dir,
    });

    assert.match(hook.output, /## 记忆摘要/);
    assert.match(hook.output, /原因：session_start/);
    assert.match(hook.output, /## 档案路由/);
  });
});

test("LLM review gate uses OpenAI-compatible provider when configured", async () => {
  await withTempDir(async (dir) => {
    await withLlmServer((request, response) => {
      assert.equal(request.url, "/chat/completions");
      assert.equal(request.method, "POST");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              decision: "PASS",
              summary: "evidence is sufficient",
              findings: [],
            }),
          },
        }],
        usage: { total_tokens: 42 },
      }));
    }, async (baseUrl) => {
      await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
        modelProviders: {
          local: { apiKeyEnv: "HELIX_TEST_LLM_KEY", baseUrl },
        },
        agents: {
          BaiZe: { provider: "local", model: "test-reviewer" },
        },
        review: {
          llm: { enabled: true, required: true, agents: ["BaiZe"] },
        },
      }, null, 2));
      process.env.HELIX_TEST_LLM_KEY = "test-key";
      await initRuntime(dir);
      const planPath = path.join(dir, "llm-review-plan.json");
      await writeFile(planPath, JSON.stringify({
        title: "LLM review",
        tasks: [{
          id: "T001",
          subject: "Write reviewed artifact",
          writable_paths: [".helix/artifacts/llm.txt"],
          worker_command: "node -e \"const fs=require('fs'); fs.writeFileSync('.helix/artifacts/llm.txt','ok')\"",
          verify_commands: ["node -e \"const fs=require('fs'); if(fs.readFileSync('.helix/artifacts/llm.txt','utf8')!=='ok') process.exit(1)\""],
        }],
      }));
      const plan = await importPlan(dir, planPath);

      const result = await runNextTask(dir);
      assert.equal(result.status, "completed");
      assert.ok(result.reviewResult.lanes.some((lane) => lane.name === "llm_BaiZe" && lane.status === "pass"));
      assert.equal(result.reviewResult.llmReviews[0].model, "test-reviewer");

      const reviewReport = await readJson(resolveHelixPath(dir, "reports", "reviews", `${plan.id}-T001.json`));
      assert.equal(reviewReport.llmReviews[0].summary, "evidence is sufficient");
    });
  });
});

test("comment checker can block checkpoint when configured", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      qualityGates: {
        commentChecker: {
          enabled: true,
          blockOnFindings: true,
          patterns: [{ name: "todo", pattern: "\\bTODO\\b" }],
        },
      },
    }, null, 2));
    await initRuntime(dir);
    await mkdir(path.join(dir, "src"), { recursive: true });
    const planPath = path.join(dir, "comment-gate-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Comment gate",
      tasks: [{
        id: "T001",
        subject: "Write source without placeholder comments",
        writable_paths: ["src/app.js"],
        worker_command: "node -e \"const fs=require('fs'); fs.writeFileSync('src/app.js','// TODO remove placeholder\\nexport const ok = true;\\n')\"",
        verify_commands: ["node -e \"const fs=require('fs'); if(!fs.readFileSync('src/app.js','utf8').includes('ok')) process.exit(1)\""],
        maxAttempts: 2,
      }],
    }));
    const plan = await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "failed");
    assert.equal(result.task.last_failure.reason, "review_gate_failed");
    assert.ok(result.reviewResult.lanes.some((lane) => lane.name === "comment_checker" && lane.status === "fail"));
    assert.ok(result.reviewResult.findings.some((finding) => finding.source === "comment_checker" && finding.validator.status === "validated"));

    const reviewReport = await readFile(resolveHelixPath(dir, "reports", "reviews", `${plan.id}-T001.md`), "utf8");
    assert.match(reviewReport, /src\/app\.js:1 todo/);
    assert.match(reviewReport, /## Structured Findings/);
    assert.match(reviewReport, /Validator: validated/);

    const reviewJson = await readJson(resolveHelixPath(dir, "reports", "reviews", `${plan.id}-T001.json`));
    assert.ok(reviewJson.findings.some((finding) => finding.source === "comment_checker"));
    assert.ok(Array.isArray(reviewJson.testingGaps));
    assert.ok(Array.isArray(reviewJson.residualRisks));
  });
});

test("comment checker object patterns default to case-insensitive matching", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      qualityGates: {
        commentChecker: {
          enabled: true,
          blockOnFindings: true,
          patterns: [{ name: "todo", pattern: "\\btodo\\b" }],
        },
      },
    }, null, 2));
    await initRuntime(dir);
    await mkdir(path.join(dir, "src"), { recursive: true });
    const planPath = path.join(dir, "comment-case-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Comment case gate",
      tasks: [{
        id: "T001",
        subject: "Block uppercase placeholder comments",
        writable_paths: ["src/app.js"],
        worker_command: "node -e \"const fs=require('fs'); fs.writeFileSync('src/app.js','// TODO uppercase placeholder\\nexport const ok = true;\\n')\"",
        verify_commands: ["node -e \"const fs=require('fs'); if(!fs.readFileSync('src/app.js','utf8').includes('ok')) process.exit(1)\""],
      }],
    }));
    await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "failed");
    assert.ok(result.reviewResult.lanes.some((lane) => lane.name === "comment_checker" && lane.status === "fail"));
  });
});

test("code intelligence gates block stale hashline and AST findings", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      qualityGates: {
        astStructure: {
          enabled: true,
          required: true,
          commands: [nodeEval("const fs=require('fs'); if(!fs.readFileSync('src/app.js','utf8').includes('export const ok')) process.exit(1);")],
        },
        hashlineAnchors: {
          enabled: true,
          required: true,
        },
        commentChecker: { enabled: false },
      },
    }, null, 2));
    await initRuntime(dir);
    await mkdir(path.join(dir, "src"), { recursive: true });
    const expectedLine = "export const ok = true;";
    const planPath = path.join(dir, "code-intel-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Code intelligence gate",
      tasks: [{
        id: "T001",
        subject: "Reject stale anchored edit",
        writable_paths: ["src/app.js"],
        worker_command: "node -e \"const fs=require('fs'); fs.writeFileSync('src/app.js','export const ok = false;\\n')\"",
        verify_commands: ["node -e \"const fs=require('fs'); if(!fs.readFileSync('src/app.js','utf8').includes('export const ok')) process.exit(1)\""],
        hashline_anchors: [{ file: "src/app.js", line: 1, sha256: hashLine(expectedLine), note: "expected stable export line" }],
      }],
    }));
    await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "failed");
    assert.equal(result.task.last_failure.reason, "review_gate_failed");
    assert.ok(result.reviewResult.lanes.some((lane) => lane.name === "ast_structure" && lane.status === "pass"));
    assert.ok(result.reviewResult.lanes.some((lane) => lane.name === "hashline_anchors" && lane.status === "fail"));
    assert.ok(result.reviewResult.findings.some((finding) => finding.lane === "hashline_anchors" && finding.validator.status === "validated"));
  });
});

test("simulation greenfield project runs from product planning to completed web app", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "AGENTS.md"), "# Project Rules\n\nUser-visible web work needs verifier evidence.\n");
    await initRuntime(dir);

    const route = await routeRequest(dir, {
      text: "从零做一个网页版提醒事项 App，一期 MVP 要有清单流程、空状态、验收标准和失败恢复。",
    });
    assert.equal(route.route, "plan");
    assert.ok(route.planSkills.some((skill) => skill.name === "review-product-intent"));
    assert.ok(route.planSkills.some((skill) => skill.name === "map-user-journey"));
    assert.ok(route.planSkills.some((skill) => skill.name === "design-acceptance"));
    assert.ok(route.planSkills.some((skill) => skill.name === "review-ux-interaction"));

    const planPath = path.join(dir, "greenfield-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Greenfield reminders web app",
      objective: "从产品澄清到可验证 Web 提醒事项 App 完成闭环。",
      tasks: [
        {
          id: "T001",
          subject: "产出提醒事项产品 brief、设计和计划",
          description: "澄清目标、用户旅程、空状态、失败恢复和验收口径。",
          writable_paths: [".workflow/**"],
          worker_command: nodeEval(`
            const fs = require("fs");
            fs.mkdirSync(".workflow/specs/reminders", { recursive: true });
            fs.mkdirSync(".workflow/designs/reminders", { recursive: true });
            fs.mkdirSync(".workflow/plans/reminders", { recursive: true });
            fs.writeFileSync(".workflow/specs/reminders/brief.md", [
              "# Reminders Brief",
              "REQ-REMINDER-001 SHALL let users add reminders.",
              "REQ-REMINDER-002 MUST show an empty state before any reminder exists.",
              "Given an empty list When the page opens Then empty guidance is visible.",
              "Given invalid text When adding Then the app keeps the user in flow."
            ].join("\\n"));
            fs.writeFileSync(".workflow/designs/reminders/spec.md", [
              "# Reminders Design",
              "Slots: header, input, add button, list, empty state, error feedback.",
              "States: loading, empty, success, error, repeated-use."
            ].join("\\n"));
            fs.writeFileSync(".workflow/plans/reminders/tasks.md", [
              "# Reminders Tasks",
              "T002 implements the app with verifier evidence."
            ].join("\\n"));
          `),
          verify_commands: [
            nodeEval(`
              const fs = require("fs");
              const brief = fs.readFileSync(".workflow/specs/reminders/brief.md", "utf8");
              const design = fs.readFileSync(".workflow/designs/reminders/spec.md", "utf8");
              if (!brief.includes("REQ-REMINDER-001") || !brief.includes("Given an empty list")) process.exit(1);
              if (!design.includes("empty state") || !design.includes("error feedback")) process.exit(1);
            `),
          ],
        },
        {
          id: "T002",
          subject: "实现网页版提醒事项 App",
          description: "根据 T001 的 brief/design 生成可打开的 HTML 与 JS。",
          blockedBy: ["T001"],
          writable_paths: ["index.html", "package.json", "src/**"],
          worker_command: nodeEval(`
            const fs = require("fs");
            fs.mkdirSync("src", { recursive: true });
            fs.writeFileSync("package.json", JSON.stringify({ scripts: { test: "node src/app.test.js" } }, null, 2));
            fs.writeFileSync("index.html", [
              "<!doctype html>",
              "<html><head><meta charset=\\"utf-8\\"><title>提醒事项</title></head>",
              "<body><main><h1>提醒事项</h1><input id=\\"new-item\\"><button id=\\"add\\">添加</button><p id=\\"empty\\">还没有提醒事项</p><ul id=\\"list\\"></ul></main><script src=\\"src/app.js\\"></script></body></html>"
            ].join("\\n"));
            fs.writeFileSync("src/app.js", [
              "function addReminder(items, title) {",
              "  const text = String(title || '').trim();",
              "  if (!text) return { items, error: '请输入提醒事项' };",
              "  return { items: [...items, { id: items.length + 1, title: text, done: false }], error: '' };",
              "}",
              "if (typeof module !== 'undefined') module.exports = { addReminder };"
            ].join("\\n"));
            fs.writeFileSync("src/app.test.js", [
              "const { addReminder } = require('./app.js');",
              "const added = addReminder([], '交付方案');",
              "if (added.items.length !== 1 || added.error) process.exit(1);",
              "const empty = addReminder([], '   ');",
              "if (!empty.error || empty.items.length !== 0) process.exit(1);"
            ].join("\\n"));
          `),
          verify_commands: ["npm test"],
        },
        {
          id: "T003",
          subject: "验收提醒事项 App 的核心体验",
          description: "验证空状态、添加流程、错误反馈和测试证据都存在。",
          blockedBy: ["T002"],
          writable_paths: [".helix/artifacts/**"],
          worker_command: nodeEval(`
            const fs = require("fs");
            fs.mkdirSync(".helix/artifacts", { recursive: true });
            const html = fs.readFileSync("index.html", "utf8");
            const app = fs.readFileSync("src/app.js", "utf8");
            const test = fs.readFileSync("src/app.test.js", "utf8");
            const report = [
              "# QA Report",
              html.includes("还没有提醒事项") ? "PASS empty state" : "FAIL empty state",
              app.includes("请输入提醒事项") ? "PASS error feedback" : "FAIL error feedback",
              test.includes("交付方案") ? "PASS add flow" : "FAIL add flow"
            ].join("\\n");
            fs.writeFileSync(".helix/artifacts/reminders-qa.md", report);
          `),
          verify_commands: [
            nodeEval(`
              const fs = require("fs");
              const report = fs.readFileSync(".helix/artifacts/reminders-qa.md", "utf8");
              if (report.includes("FAIL") || !report.includes("PASS empty state")) process.exit(1);
            `),
          ],
        },
        {
          id: "T004",
          subject: "复核提醒事项 App 完成证据",
          description: "生成最终完成摘要，证明计划、实现和验收链路闭合。",
          blockedBy: ["T003"],
          writable_paths: [".workflow/reports/**"],
          worker_command: nodeEval(`
            const fs = require("fs");
            fs.mkdirSync(".workflow/reports", { recursive: true });
            fs.writeFileSync(".workflow/reports/reminders-summary.md", [
              "# Reminders Completion Summary",
              "Brief, implementation, tests, and QA report are complete.",
              "No direct coding happened before plan import."
            ].join("\\n"));
          `),
          verify_commands: [
            nodeEval(`
              const fs = require("fs");
              const summary = fs.readFileSync(".workflow/reports/reminders-summary.md", "utf8");
              if (!summary.includes("Brief") || !summary.includes("QA report")) process.exit(1);
            `),
          ],
        },
      ],
    }, null, 2));

    await importPlan(dir, planPath);
    const first = await runNextTask(dir);
    assert.equal(first.status, "completed");
    const second = await runNextTask(dir);
    assert.equal(second.status, "completed");
    const third = await runNextTask(dir);
    assert.equal(third.status, "completed");
    const fourth = await runNextTask(dir);
    assert.equal(fourth.status, "completed");

    const status = await statusReport(dir);
    assert.equal(status.total, 4);
    assert.equal(status.completed, 4);
    assert.match(await readFile(path.join(dir, "index.html"), "utf8"), /提醒事项/);
    assert.match(await readFile(resolveHelixPath(dir, "reports", "workflow-summary.md"), "utf8"), /Status: PASS/);
  });
});

test("simulation existing project handles large feature addition through planning and gates", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, "src"), { recursive: true });
    await mkdir(path.join(dir, "test"), { recursive: true });
    await writeFile(path.join(dir, "AGENTS.md"), "# Existing Project Rules\n\nLarge features require scope and regression evidence.\n");
    await writeFile(path.join(dir, "src", "app.cjs"), "function listItems(items) { return items; }\nmodule.exports = { listItems };\n");
    await writeFile(path.join(dir, "test", "app.test.cjs"), "const { listItems } = require('../src/app.cjs');\nif (listItems([1]).length !== 1) process.exit(1);\n");
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    assert.equal((await runCommand("git add AGENTS.md src/app.cjs test/app.test.cjs", dir)).exitCode, 0);
    await initRuntime(dir);

    const route = await routeRequest(dir, {
      text: "已有项目新增一个提醒分组大功能，要处理权限、状态流程、回归验收和范围取舍。",
    });
    assert.equal(route.route, "plan");
    assert.ok(route.planSkills.some((skill) => skill.name === "map-user-journey"));
    assert.ok(route.planSkills.some((skill) => skill.name === "design-acceptance"));
    assert.ok(route.planSkills.some((skill) => skill.name === "review-scope-tradeoff"));

    const planPath = path.join(dir, "existing-feature-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Existing project reminder groups",
      objective: "在已有项目里新增提醒分组能力，并保留既有列表行为。",
      tasks: [
        {
          id: "T001",
          subject: "补充分组功能计划证据",
          description: "记录用户旅程、范围取舍和验收标准。",
          writable_paths: [".workflow/**"],
          worker_command: nodeEval(`
            const fs = require("fs");
            fs.mkdirSync(".workflow/plans/reminder-groups", { recursive: true });
            fs.writeFileSync(".workflow/plans/reminder-groups/tasks.md", [
              "# Reminder Groups Plan",
              "IN: create group, assign reminder, preserve existing listItems behavior.",
              "OUT: sharing permissions and cloud sync are deferred.",
              "Acceptance: regression test listItems and new group behavior."
            ].join("\\n"));
          `),
          verify_commands: [
            nodeEval(`
              const fs = require("fs");
              const plan = fs.readFileSync(".workflow/plans/reminder-groups/tasks.md", "utf8");
              if (!plan.includes("OUT: sharing permissions") || !plan.includes("regression test")) process.exit(1);
            `),
          ],
        },
        {
          id: "T002",
          subject: "实现提醒分组并保留回归行为",
          description: "新增 groupReminder，同时保持 listItems 不变。",
          blockedBy: ["T001"],
          writable_paths: ["src/**", "test/**"],
          worker_command: nodeEval(`
            const fs = require("fs");
            fs.writeFileSync("src/app.cjs", [
              "function listItems(items) { return items; }",
              "function groupReminder(groups, groupName, reminderTitle) {",
              "  const key = String(groupName || '').trim();",
              "  const title = String(reminderTitle || '').trim();",
              "  if (!key || !title) return { groups, error: '分组和提醒不能为空' };",
              "  const next = { ...groups, [key]: [...(groups[key] || []), title] };",
              "  return { groups: next, error: '' };",
              "}",
              "module.exports = { listItems, groupReminder };"
            ].join("\\n"));
            fs.writeFileSync("test/app.test.cjs", [
              "const { listItems, groupReminder } = require('../src/app.cjs');",
              "if (listItems([1]).length !== 1) process.exit(1);",
              "const grouped = groupReminder({}, '工作', '提交方案');",
              "if (grouped.error || grouped.groups['工作'][0] !== '提交方案') process.exit(1);",
              "const invalid = groupReminder({}, '', '提交方案');",
              "if (!invalid.error) process.exit(1);"
            ].join("\\n"));
          `),
          verify_commands: ["node test/app.test.cjs"],
        },
        {
          id: "T003",
          subject: "验收提醒分组的回归和边界证据",
          description: "验证既有 listItems 回归、新增 groupReminder happy path 和错误路径。",
          blockedBy: ["T002"],
          writable_paths: [".helix/artifacts/**"],
          worker_command: nodeEval(`
            const fs = require("fs");
            fs.mkdirSync(".helix/artifacts", { recursive: true });
            const source = fs.readFileSync("src/app.cjs", "utf8");
            const tests = fs.readFileSync("test/app.test.cjs", "utf8");
            fs.writeFileSync(".helix/artifacts/reminder-groups-qa.md", [
              "# Reminder Groups QA",
              source.includes("listItems") ? "PASS existing behavior" : "FAIL existing behavior",
              source.includes("groupReminder") ? "PASS new behavior" : "FAIL new behavior",
              tests.includes("invalid.error") ? "PASS error path" : "FAIL error path"
            ].join("\\n"));
          `),
          verify_commands: [
            nodeEval(`
              const fs = require("fs");
              const report = fs.readFileSync(".helix/artifacts/reminder-groups-qa.md", "utf8");
              if (report.includes("FAIL") || !report.includes("PASS existing behavior")) process.exit(1);
            `),
          ],
        },
        {
          id: "T004",
          subject: "复核提醒分组范围取舍和交付摘要",
          description: "记录范围取舍、回归证据和交付状态。",
          blockedBy: ["T003"],
          writable_paths: [".workflow/reports/**"],
          worker_command: nodeEval(`
            const fs = require("fs");
            fs.mkdirSync(".workflow/reports", { recursive: true });
            fs.writeFileSync(".workflow/reports/reminder-groups-summary.md", [
              "# Reminder Groups Completion Summary",
              "IN scope group creation and assignment are complete.",
              "Existing listItems regression evidence is preserved.",
              "OUT scope sharing permissions and cloud sync remain deferred."
            ].join("\\n"));
          `),
          verify_commands: [
            nodeEval(`
              const fs = require("fs");
              const summary = fs.readFileSync(".workflow/reports/reminder-groups-summary.md", "utf8");
              if (!summary.includes("regression evidence") || !summary.includes("OUT scope")) process.exit(1);
            `),
          ],
        },
      ],
    }, null, 2));

    await importPlan(dir, planPath);
    assert.equal((await runNextTask(dir)).status, "completed");
    const implemented = await runNextTask(dir);
    assert.equal(implemented.status, "completed");
    assert.equal(implemented.scopeResult.status, "pass");
    assert.equal(implemented.reviewResult.pass, true);
    assert.equal((await runNextTask(dir)).status, "completed");
    assert.equal((await runNextTask(dir)).status, "completed");

    await writeWorkflowSummary(dir, { reason: "existing_feature_simulation" });
    const status = await statusReport(dir);
    assert.equal(status.completed, 4);
    assert.match(await readFile(path.join(dir, "src", "app.cjs"), "utf8"), /groupReminder/);
    assert.match(await readFile(resolveHelixPath(dir, "reports", "workflow-summary.md"), "utf8"), /Status: PASS/);
  });
});

test("linear loop honors blockedBy dependencies in order", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "dependency-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Dependency order",
      tasks: [
        {
          id: "T001",
          subject: "Write first artifact",
          worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('.helix/artifacts',{recursive:true}); fs.writeFileSync('.helix/artifacts/first.txt','first')\"",
          verify_commands: ["node -e \"const fs=require('fs'); if(fs.readFileSync('.helix/artifacts/first.txt','utf8')!=='first') process.exit(1)\""],
        },
        {
          id: "T002",
          subject: "Write second artifact after first",
          blockedBy: ["T001"],
          worker_command: "node -e \"const fs=require('fs'); fs.writeFileSync('.helix/artifacts/second.txt',fs.readFileSync('.helix/artifacts/first.txt','utf8')+'+second')\"",
          verify_commands: ["node -e \"const fs=require('fs'); if(fs.readFileSync('.helix/artifacts/second.txt','utf8')!=='first+second') process.exit(1)\""],
        },
      ],
    }));
    await importPlan(dir, planPath);

    const first = await runNextTask(dir);
    assert.equal(first.status, "completed");
    assert.equal(first.task.id, "T001");
    let state = await readJson(resolveHelixPath(dir, "team", "tasks.json"));
    assert.equal(state.tasks[1].status, "pending");

    const second = await runNextTask(dir);
    assert.equal(second.status, "completed");
    assert.equal(second.task.id, "T002");
    state = await readJson(resolveHelixPath(dir, "team", "tasks.json"));
    assert.equal(state.tasks[0].status, "completed");
    assert.equal(state.tasks[1].status, "completed");
  });
});

test("team task create appends a routed task and preserves dependency gates", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "append-task-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Append task",
      defaults: {
        verify_commands: ["node -e \"process.exit(0)\""],
        standards_commands: ["node -e \"process.exit(0)\""],
        writable_paths: ["src/**"],
      },
      tasks: [{
        id: "T001",
        subject: "First task",
        worker_command: "node -e \"process.exit(0)\"",
      }],
    }));
    await importPlan(dir, planPath);

    const created = await createTeamTask(dir, {
      id: "T002",
      subject: "实现追加任务按钮",
      description: "新增一个 UI 按钮任务",
      blockedBy: ["T001"],
      worker_command: "node -e \"process.exit(0)\"",
    });
    assert.equal(created.task.id, "T002");
    assert.equal(created.task.category, "visual-engineering");
    assert.deepEqual(created.task.verify_commands, ["node -e \"process.exit(0)\""]);
    assert.deepEqual(created.task.standards_commands, ["node -e \"process.exit(0)\""]);

    const listed = await listTeamTasks(dir, { status: "pending" });
    assert.deepEqual(listed.tasks.map((task) => task.id), ["T001", "T002"]);
    assert.match(await readFile(resolveHelixPath(dir, "team", "tasks.md"), "utf8"), /T002\. 实现追加任务按钮/);
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /team_task_created/);

    const first = await runNextTask(dir);
    assert.equal(first.task.id, "T001");
    const second = await runNextTask(dir);
    assert.equal(second.task.id, "T002");
    const status = await statusReport(dir);
    assert.equal(status.completed, 2);
  });
});

test("team task claim respects blockers and does not bypass execution gates", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "claim-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Claim tasks",
      defaults: {
        writable_paths: ["src/**"],
      },
      tasks: [
        {
          id: "T001",
          subject: "Claimable task",
          worker_command: "node -e \"process.exit(0)\"",
          verify_commands: ["node -e \"process.exit(0)\""],
        },
        {
          id: "T002",
          subject: "Blocked task",
          blockedBy: ["T001"],
          worker_command: "node -e \"process.exit(0)\"",
          verify_commands: ["node -e \"process.exit(0)\""],
        },
      ],
    }));
    await importPlan(dir, planPath);

    await assert.rejects(() => claimTeamTask(dir, { taskId: "T002", owner: "YingLong" }), /blocked by T001/);

    const claimed = await claimTeamTask(dir, { taskId: "T001", owner: "YingLong" });
    assert.equal(claimed.task.status, "in_progress");
    assert.equal(claimed.task.owner, "Jiuwei");
    assert.ok(claimed.task.claimedAt);

    const readBack = await getTeamTask(dir, "T001");
    assert.equal(readBack.task.status, "in_progress");

    const executed = await runWorkflowNode(dir, "execute", { taskId: "T001" });
    assert.equal(executed.status, "executed");
    assert.equal(executed.task.status, "verifying");
    await runWorkflowNode(dir, "verify", { taskId: "T001" });
    await runWorkflowNode(dir, "scope", { taskId: "T001" });
    await runWorkflowNode(dir, "review", { taskId: "T001" });
    const checkpointed = await runWorkflowNode(dir, "checkpoint", { taskId: "T001" });
    assert.equal(checkpointed.status, "completed");

    const secondClaim = await claimTeamTask(dir, { taskId: "T002", owner: "YingLong" });
    assert.equal(secondClaim.task.status, "in_progress");
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /team_task_claimed/);
  });
});

test("verifier failure returns task to pending until max attempts", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "bad-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Fail once",
      tasks: [{
        id: "T001",
        subject: "Bad verification",
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(2)\""],
        maxAttempts: 2,
      }],
    }));
    await importPlan(dir, planPath);

    const first = await runNextTask(dir);
    assert.equal(first.status, "retry");
    let state = await readJson(resolveHelixPath(dir, "team", "tasks.json"));
    assert.equal(state.tasks[0].status, "pending");

    const second = await runNextTask(dir);
    assert.equal(second.status, "failed");
    state = await readJson(resolveHelixPath(dir, "team", "tasks.json"));
    assert.equal(state.tasks[0].status, "failed");
    assert.equal(state.tasks[0].last_failure.reason, "verifier_failed");
    assert.match(state.tasks[0].last_failure.retryHint, /FAILED:/);
    assert.match(state.tasks[0].last_failure.retryHint, /DO NOT: 不要降低或删除 verify_commands/);

    const reportMd = await readFile(resolveHelixPath(dir, "reports", "failures", `${state.planId}-T001.md`), "utf8");
    assert.match(reportMd, /# Task Failure/);
    assert.match(reportMd, /verifier_failed/);

    const retry = await runWorkflowNode(dir, "retry", { taskId: "T001" });
    assert.equal(retry.status, "pending");
    state = await readJson(resolveHelixPath(dir, "team", "tasks.json"));
    assert.equal(state.tasks[0].status, "pending");
    assert.equal(state.tasks[0].manual_retry_count, 1);
    assert.equal(state.tasks[0].maxAttempts, 3);
  });
});

test("runNextTask fails when automatic scope guard finds out-of-scope worker changes", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const gitInit = await runCommand("git init", dir);
    assert.equal(gitInit.exitCode, 0);

    const planPath = resolveHelixPath(dir, "artifacts", "out-of-scope-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Out of scope work",
      tasks: [{
        id: "T001",
        subject: "Only src allowed",
        writable_paths: ["src/**"],
        worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('docs',{recursive:true}); fs.writeFileSync('docs/leak.md','bad')\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }));
    await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "failed");
    assert.equal(result.scopeResult.status, "fail");
    assert.deepEqual(result.scopeResult.deniedPaths, ["docs/leak.md"]);

    const state = await readJson(resolveHelixPath(dir, "team", "tasks.json"));
    assert.equal(state.tasks[0].status, "failed");
    assert.equal(state.tasks[0].last_failure.reason, "scope_guard_failed");
    assert.match(state.tasks[0].last_failure.retryHint, /ChangeRequest/);
    assert.ok(state.tasks[0].last_change_request.id.startsWith("CR-"));
    assert.deepEqual(state.tasks[0].last_change_request.deniedPaths, ["docs/leak.md"]);

    const changes = await listChangeRequests(dir);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].id, state.tasks[0].last_change_request.id);
    assert.equal(changes[0].status, "open");
    assert.equal(changes[0].invariants.autoApply, false);
    assert.match(await readFile(resolveHelixPath(dir, "changes", "open.md"), "utf8"), /docs\/leak\.md/);

    const retry = await runWorkflowNode(dir, "retry", { taskId: "T001" });
    assert.equal(retry.status, "change_request_required");
    assert.equal(retry.changeRequest.id, state.tasks[0].last_change_request.id);
    const afterRetry = await readJson(resolveHelixPath(dir, "team", "tasks.json"));
    assert.equal(afterRetry.tasks[0].status, "failed");
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /scope_guard_failed/);
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /node_retry_blocked/);
    assert.match(await readFile(resolveHelixPath(dir, "reports", "failures", `${state.planId}-T001.md`), "utf8"), /ChangeRequest/);
  });
});

test("non-git projects use file manifest scope fallback before checkpoint", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);

    const planPath = resolveHelixPath(dir, "artifacts", "non-git-scope-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Non git scope",
      tasks: [{
        id: "T001",
        subject: "Only src allowed without git",
        writable_paths: ["src/**"],
        worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('docs',{recursive:true}); fs.writeFileSync('docs/leak.md','bad')\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }));
    await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "failed");
    assert.equal(result.scopeResult.status, "fail");
    assert.deepEqual(result.scopeResult.deniedPaths, ["docs/leak.md"]);
    assert.equal(result.task.last_failure.reason, "scope_guard_failed");
  });
});

test("accepted change request can explicitly apply scope and reopen retry", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const gitInit = await runCommand("git init", dir);
    assert.equal(gitInit.exitCode, 0);

    const planPath = resolveHelixPath(dir, "artifacts", "accepted-change-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Accepted scope change",
      tasks: [{
        id: "T001",
        subject: "Allow docs only after review",
        writable_paths: ["src/**"],
        worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('docs',{recursive:true}); fs.writeFileSync('docs/leak.md','accepted')\"",
        verify_commands: ["node -e \"const fs=require('fs'); if(fs.readFileSync('docs/leak.md','utf8')!=='accepted') process.exit(1)\""],
      }],
    }));
    await importPlan(dir, planPath);

    const failed = await runNextTask(dir);
    assert.equal(failed.status, "failed");
    const changeRequestId = failed.task.last_change_request.id;

    const review = await reviewChangeRequest(dir, changeRequestId);
    assert.equal(review.status, "reviewable");
    assert.deepEqual(review.allowedDecisions, ["accept", "reject"]);

    const resolved = await resolveChangeRequest(dir, {
      id: changeRequestId,
      decision: "accept",
      evidence: "docs/leak.md is part of the accepted task output after Jiuwei review",
      rationale: "The task objective needs this artifact and verification remains unchanged",
      applyScope: true,
    });
    assert.equal(resolved.status, "accepted");
    assert.equal(resolved.changeRequest.appliedScope, true);
    assert.ok(resolved.task.writable_paths.includes("docs/leak.md"));

    const retry = await runWorkflowNode(dir, "retry", { taskId: "T001" });
    assert.equal(retry.status, "pending");

    const completed = await runNextTask(dir);
    assert.equal(completed.status, "completed");
    assert.equal(completed.scopeResult.status, "pass");

    const changes = await listChangeRequests(dir);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].status, "accepted");
    assert.equal((await statusReport(dir)).openChanges, 0);
    assert.match(await readFile(resolveHelixPath(dir, "changes", `${changeRequestId}.md`), "utf8"), /Decision/);
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /change_request_resolved/);
  });
});

test("review gate failure blocks checkpoint and writes actionable failure report", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "review-fail-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Review fail",
      tasks: [{
        id: "T001",
        subject: "Pass verifier but fail review command",
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
        review_commands: ["node -e \"console.error('review says no'); process.exit(4)\""],
        maxAttempts: 2,
      }],
    }));
    const plan = await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "failed");
    assert.equal(result.reviewResult.pass, false);
    assert.equal(result.task.last_failure.reason, "review_gate_failed");
    assert.match(result.task.last_failure.retryHint, /review says no/);

    const reviewReport = await readJson(resolveHelixPath(dir, "reports", "reviews", `${plan.id}-T001.json`));
    assert.equal(reviewReport.status, "fail");
    assert.ok(reviewReport.lanes.some((lane) => lane.name === "explicit_review_commands" && lane.status === "fail"));

    const failureReport = await readFile(resolveHelixPath(dir, "reports", "failures", `${plan.id}-T001.md`), "utf8");
    assert.match(failureReport, /review_gate_failed/);
  });
});

test("review gate fails when verifier evidence is missing", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "review-missing-evidence-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Missing evidence review",
      tasks: [{
        id: "T001",
        subject: "Do not review without verifier evidence",
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }));
    const plan = await importPlan(dir, planPath);

    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    const reviewed = await runWorkflowNode(dir, "review", { taskId: "T001" });
    assert.equal(reviewed.status, "review_failed");
    assert.ok(reviewed.reviewResult.lanes.some((lane) => lane.name === "evidence_integrity" && lane.status === "fail"));

    const reviewReport = await readJson(resolveHelixPath(dir, "reports", "reviews", `${plan.id}-T001.json`));
    assert.equal(reviewReport.status, "fail");
    assert.ok(reviewReport.lanes.some((lane) => lane.name === "evidence_integrity" && /verifyResult/.test(lane.summary)));
  });
});

test("standards command failure blocks checkpoint through review gate", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "standards-fail-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Standards fail",
      defaults: {
        standards_commands: ["node -e \"console.error('standards says no'); process.exit(6)\""],
      },
      tasks: [{
        id: "T001",
        subject: "Pass verifier but fail standards",
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
        maxAttempts: 2,
      }],
    }));
    const plan = await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "failed");
    assert.equal(result.reviewResult.pass, false);
    assert.equal(result.task.last_failure.reason, "review_gate_failed");
    assert.ok(result.reviewResult.lanes.some((lane) => lane.name === "project_standards" && lane.status === "fail"));

    const reviewReport = await readFile(resolveHelixPath(dir, "reports", "reviews", `${plan.id}-T001.md`), "utf8");
    assert.match(reviewReport, /standards says no/);
    const failureReport = await readFile(resolveHelixPath(dir, "reports", "failures", `${plan.id}-T001.md`), "utf8");
    assert.match(failureReport, /project_standards/);
  });
});

test("checkpoint node rejects tasks before review gate passes", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "missing-review-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Missing review",
      tasks: [{
        id: "T001",
        subject: "Need review before checkpoint",
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }));
    await importPlan(dir, planPath);

    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    await runWorkflowNode(dir, "verify", { taskId: "T001" });
    await runWorkflowNode(dir, "scope", { taskId: "T001" });

    const checkpointed = await runWorkflowNode(dir, "checkpoint", { taskId: "T001" });
    assert.equal(checkpointed.status, "retry");
    assert.equal(checkpointed.task.status, "pending");
    assert.equal(checkpointed.task.last_failure.reason, "review_gate_failed");
  });
});

test("scope guard checks git changed paths against task writable paths", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = resolveHelixPath(dir, "artifacts", "scope-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Scoped work",
      tasks: [{
        id: "T001",
        subject: "Only touch src",
        writable_paths: ["src/**"],
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }));
    await importPlan(dir, planPath);

    const gitInit = await runCommand("git init", dir);
    assert.equal(gitInit.exitCode, 0);

    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "ok.js"), "export const ok = true;\n");

    const pass = await scopeGuard(dir, { taskId: "T001" });
    assert.equal(pass.status, "pass");
    assert.deepEqual(pass.deniedPaths, []);

    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "docs", "plan.md"), "# out of scope\n");

    const fail = await scopeGuard(dir, { taskId: "T001" });
    assert.equal(fail.status, "fail");
    assert.deepEqual(fail.deniedPaths, ["docs/plan.md"]);

    const ledger = await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8");
    assert.match(ledger, /scope_guard_passed/);
    assert.match(ledger, /scope_guard_failed/);
  });
});

test("scope guard rejects symlink realpaths that escape the project", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const outsidePath = path.join(path.dirname(dir), "outside-scope.txt");
    await writeFile(outsidePath, "secret\n");
    await symlink(outsidePath, path.join(dir, "allowed-link.txt"));
    const planPath = path.join(dir, "symlink-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Symlink scope",
      tasks: [{
        id: "T001",
        subject: "Reject symlink escape",
        writable_paths: ["allowed-link.txt"],
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }));
    await importPlan(dir, planPath);

    const result = await scopeGuard(dir, { taskId: "T001", changedPaths: ["allowed-link.txt"] });
    assert.equal(result.status, "fail");
    assert.match(result.deniedPaths[0], /allowed-link\.txt -> /);
    await rm(outsidePath, { force: true });
  });
});

test("pathAllowed supports exact paths, directories, globs, and empty scopes", () => {
  assert.equal(pathAllowed("src/index.js", ["src/**"]), true);
  assert.equal(pathAllowed("src/index.js", ["src"]), true);
  assert.equal(pathAllowed("README.md", ["README.md"]), true);
  assert.equal(pathAllowed("test/core.test.mjs", ["test/*.mjs"]), true);
  assert.equal(pathAllowed("src/example.mjs", ["src/**/*.mjs"]), true);
  assert.equal(pathAllowed("src/infra/example.mjs", ["src/**/*.mjs"]), true);
  assert.equal(pathAllowed("src/index.js.map", ["src/index.js"]), false);
  assert.equal(pathAllowed("docs/plan.md", ["src/**"]), false);
  assert.equal(pathAllowed("src/index.js", []), false);
});

test("manifest change classification covers added, deleted, and modified files", () => {
  assert.deepEqual(classifyManifestPathChanges(
    {
      "src/deleted.js": "10:1",
      "src/modified.js": "10:1",
      "src/same.js": "10:1",
    },
    {
      "src/added.js": "10:1",
      "src/modified.js": "12:2",
      "src/same.js": "10:1",
    },
  ), [
    { path: "src/added.js", status: "added" },
    { path: "src/deleted.js", status: "deleted" },
    { path: "src/modified.js", status: "modified" },
  ]);
});

test("workflow runs sample plan end to end and writes resumable state", async () => {
  await withTempDir(async (dir) => {
    const result = await runWorkflow(dir, { sample: true });
    assert.equal(result.ok, true);
    assert.equal(result.summaryPath, ".helix/reports/workflow-summary.md");
    assert.equal(result.status.completed, 1);
    assert.equal(result.status.pending, 0);

    const resume = await resumeReport(dir);
    assert.equal(resume.latestSnapshot.stage, "workflow_finished");
    assert.equal(resume.nextAction, "no runnable task");

    const summary = await readJson(resolveHelixPath(dir, "reports", "workflow-summary.json"));
    assert.equal(summary.ok, true);
    assert.equal(summary.tasks[0].status, "completed");
    assert.match(await readFile(resolveHelixPath(dir, "reports", "workflow-summary.md"), "utf8"), /Status: PASS/);
    assert.match(await readFile(resolveHelixPath(dir, "reports", "workflow-summary.md"), "utf8"), /Task Breakdown/);
  });
});

test("workflow summary records failed runs with failure evidence", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "summary-fail-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Summary failure",
      tasks: [{
        id: "T001",
        subject: "Fail verifier for summary",
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(9)\""],
        maxAttempts: 1,
      }],
    }));

    const result = await runWorkflow(dir, { planPath });
    assert.equal(result.ok, false);
    assert.equal(result.summaryPath, ".helix/reports/workflow-summary.md");

    const summary = await writeWorkflowSummary(dir, { reason: "test-refresh" });
    assert.equal(summary.ok, false);
    assert.equal(summary.tasks[0].status, "failed");
    assert.match(summary.tasks[0].failureReportPath, /^\.helix\/reports\/failures\/plan_.+-T001\.md$/);
    const summaryMd = await readFile(resolveHelixPath(dir, "reports", "workflow-summary.md"), "utf8");
    assert.match(summaryMd, /ATTENTION_REQUIRED/);
    assert.match(summaryMd, /Failure report:/);
  });
});

test("resume writes durable context snapshot and session lineage", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const samplePath = await createSamplePlan(dir);
    await importPlan(dir, samplePath);

    const firstResume = await resumeReport(dir, { sessionId: "codex-session-a", source: "test" });
    assert.equal(firstResume.session.currentSessionId, "codex-session-a");
    assert.equal(firstResume.contextPath, ".helix/snapshots/context.md");
    assert.match(firstResume.nextAction, /run task T001/);

    let contextMd = await readFile(resolveHelixPath(dir, "snapshots", "context.md"), "utf8");
    assert.match(contextMd, /WildArrange Resume Context/);
    assert.match(contextMd, /codex-session-a/);
    assert.match(contextMd, /run task T001/);
    assert.match(contextMd, /Checkpoint requires verifier PASS/);

    await runNextTask(dir);
    const secondResume = await resumeReport(dir, { sessionId: "cursor-session-b", source: "test" });
    assert.deepEqual(secondResume.session.sessionIds, ["codex-session-a", "cursor-session-b"]);
    assert.equal(secondResume.nextAction, "no runnable task");

    const lineage = await readJson(resolveHelixPath(dir, "sessions", "lineage.json"));
    assert.equal(lineage.currentSessionId, "cursor-session-b");
    assert.deepEqual(lineage.sessionIds, ["codex-session-a", "cursor-session-b"]);

    contextMd = await readFile(resolveHelixPath(dir, "snapshots", "context.md"), "utf8");
    assert.match(contextMd, /cursor-session-b/);
    assert.match(contextMd, /no runnable task/);
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /session_recorded/);
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /resume_reported/);
  });
});

test("workflow nodes execute, verify, scope, review, and checkpoint independently", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const gitInit = await runCommand("git init", dir);
    assert.equal(gitInit.exitCode, 0);
    const planPath = path.join(dir, "node-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Node workflow",
      tasks: [{
        id: "T001",
        subject: "实现一个简单 CLI 输出",
        description: "在 src/app.js 写入可执行的 hello 输出逻辑",
        writable_paths: ["src/**"],
        worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/app.js','console.log(\\\\\\\"hello\\\\\\\")\\\\n')\"",
        verify_commands: ["node src/app.js | grep hello"],
      }],
    }));
    await importPlan(dir, planPath);

    const executed = await runWorkflowNode(dir, "execute", { taskId: "T001" });
    assert.equal(executed.status, "executed");
    assert.equal(executed.task.status, "verifying");

    const verified = await runWorkflowNode(dir, "verify", { taskId: "T001" });
    assert.equal(verified.status, "verified");

    const scoped = await runWorkflowNode(dir, "scope", { taskId: "T001" });
    assert.equal(scoped.status, "pass");

    const reviewed = await runWorkflowNode(dir, "review", { taskId: "T001" });
    assert.equal(reviewed.status, "reviewed");
    assert.equal(reviewed.reviewResult.pass, true);

    const checkpointed = await runWorkflowNode(dir, "checkpoint", { taskId: "T001" });
    assert.equal(checkpointed.status, "completed");

    const state = await readJson(resolveHelixPath(dir, "team", "tasks.json"));
    assert.equal(state.tasks[0].status, "completed");
    assert.equal(state.tasks[0].route_decision.route, "execute");
    assert.equal((await dashboardData(dir)).status.completed, 1);
  });
});

test("workflow verify node returns failed verification to pending for retry", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "node-verify-fail-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Node verify fail",
      tasks: [{
        id: "T001",
        subject: "Run a verifier that fails once",
        writable_paths: ["src/**"],
        worker_command: nodeEval("process.exit(0);"),
        verify_commands: [nodeEval("process.exit(1);")],
      }],
    }));
    await importPlan(dir, planPath);

    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    const verified = await runWorkflowNode(dir, "verify", { taskId: "T001" });
    assert.equal(verified.status, "verify_failed");
    assert.equal(verified.task.status, "pending");
    assert.equal(verified.task.last_failure.nextStatus, "pending");

    const state = await readJson(resolveHelixPath(dir, "team", "tasks.json"));
    assert.equal(state.tasks[0].status, "pending");
  });
});

test("dashboard API drives task, inbox, and summary operations without bypassing gates", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "dashboard-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Dashboard workflow",
      tasks: [
        {
          id: "T001",
          subject: "Claim through dashboard",
          worker_command: "node -e \"process.exit(0)\"",
          verify_commands: ["node -e \"process.exit(0)\""],
        },
        {
          id: "T002",
          subject: "Blocked dashboard task",
          blockedBy: ["T001"],
          worker_command: "node -e \"process.exit(0)\"",
          verify_commands: ["node -e \"process.exit(0)\""],
        },
      ],
    }));
    await importPlan(dir, planPath);

    await withDashboard(dir, async (baseUrl) => {
      const authHeaders = { authorization: "Bearer dashboard-token" };
      const state = await fetchJson(`${baseUrl}/api/state`);
      assert.equal(state.response.status, 200);
      assert.equal(state.body.status.pending, 2);
      assert.equal(state.body.summary, null);

      const unauthenticatedRun = await postJson(`${baseUrl}/api/run-next`, {});
      assert.equal(unauthenticatedRun.response.status, 401);

      const crossSite = await postJson(`${baseUrl}/api/summary`, {}, {
        headers: { authorization: "Bearer dashboard-token", origin: "https://example.com" },
      });
      assert.equal(crossSite.response.status, 403);

      const blockedClaim = await postJson(`${baseUrl}/api/tasks/claim`, { taskId: "T002", owner: "YingLong" }, { headers: authHeaders });
      assert.equal(blockedClaim.response.status, 500);
      assert.match(blockedClaim.body.error, /blocked by T001/);

      const claimed = await postJson(`${baseUrl}/api/tasks/claim`, { taskId: "T001", owner: "YingLong" }, { headers: authHeaders });
      assert.equal(claimed.response.status, 200);
      assert.equal(claimed.body.result.task.status, "in_progress");
      assert.equal(claimed.body.result.task.owner, "Jiuwei");

      const task = await fetchJson(`${baseUrl}/api/tasks/T001`);
      assert.equal(task.response.status, 200);
      assert.equal(task.body.result.task.status, "in_progress");

      const badTaskPath = await fetchJson(`${baseUrl}/api/tasks/%E0%A4%A`);
      assert.equal(badTaskPath.response.status, 400);

      const badClaim = await postJson(`${baseUrl}/api/tasks/claim`, { taskId: "../T001", owner: "YingLong" }, { headers: authHeaders });
      assert.equal(badClaim.response.status, 400);

      const message = await postJson(`${baseUrl}/api/team/send`, {
        from: "Jiuwei",
        to: "YingLong",
        body: "Continue T001 from dashboard.",
      }, { headers: authHeaders });
      assert.equal(message.response.status, 200);
      assert.equal(message.body.result.to, "Jiuwei");

      const inbox = await fetchJson(`${baseUrl}/api/team/inbox?agent=YingLong`);
      assert.equal(inbox.response.status, 200);
      assert.equal(inbox.body.result.length, 1);
      assert.equal(inbox.body.result[0].body, "Continue T001 from dashboard.");

      const created = await postJson(`${baseUrl}/api/tasks/create`, {
        id: "T003",
        subject: "Append task from dashboard",
        blockedBy: ["T001"],
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      }, { headers: authHeaders });
      assert.equal(created.response.status, 200);
      assert.equal(created.body.result.task.id, "T003");
      assert.equal(created.body.result.task.status, "pending");

      const summary = await postJson(`${baseUrl}/api/summary`, {}, { headers: authHeaders });
      assert.equal(summary.response.status, 200);
      assert.equal(summary.body.result.reason, "dashboard");
      assert.equal(summary.body.result.ok, false);

      const badNode = await postJson(`${baseUrl}/api/node/%E0%A4%A`, { taskId: "T001" }, { headers: authHeaders });
      assert.equal(badNode.response.status, 400);

      const refreshed = await fetchJson(`${baseUrl}/api/state`);
      assert.equal(refreshed.response.status, 200);
      assert.equal(refreshed.body.summary.reason, "dashboard");
      assert.equal(refreshed.body.tasks.length, 3);
    }, { token: "dashboard-token" });
  });
});

test("dashboard requires a token for non-loopback hosts and enforces API auth", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.throws(
      () => startDashboardServer(dir, { host: "0.0.0.0", port: 0 }),
      /requires --token or HELIX_DASHBOARD_TOKEN/,
    );

    const server = await startDashboardServer(dir, { host: "127.0.0.1", port: 0, token: "secret-token" });
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      assert.ok(port);
      const baseUrl = `http://127.0.0.1:${port}`;

      const readable = await fetchJson(`${baseUrl}/api/state`);
      assert.equal(readable.response.status, 200);

      const denied = await postJson(`${baseUrl}/api/summary`, {});
      assert.equal(denied.response.status, 401);

      const allowed = await fetchJson(`${baseUrl}/api/state`, {
        headers: { authorization: "Bearer secret-token" },
      });
      assert.equal(allowed.response.status, 200);

      const writeAllowed = await postJson(`${baseUrl}/api/summary`, {}, {
        headers: { authorization: "Bearer secret-token" },
      });
      assert.equal(writeAllowed.response.status, 200);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });
});

test("workflow node state updates are serialized under the task lock", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const gitInit = await runCommand("git init", dir);
    assert.equal(gitInit.exitCode, 0);
    const planPath = path.join(dir, "locked-node-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Locked node workflow",
      tasks: [{
        id: "T001",
        subject: "实现一个可验证文件",
        writable_paths: ["src/**"],
        worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/app.js','console.log(\\\\\\\"locked\\\\\\\")\\\\n')\"",
        verify_commands: ["node src/app.js | grep locked"],
      }],
    }));
    await importPlan(dir, planPath);

    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    await Promise.all([
      runWorkflowNode(dir, "verify", { taskId: "T001" }),
      runWorkflowNode(dir, "scope", { taskId: "T001" }),
    ]);

    const state = await readJson(resolveHelixPath(dir, "team", "tasks.json"));
    const task = state.tasks[0];
    assert.equal(task.status, "verifying");
    assert.equal(task.last_verify_result.pass, true);
    assert.equal(task.last_scope_result.status, "pass");
    assert.ok(task.evidence.some((entry) => entry.kind === "verifier"));
    assert.ok(task.evidence.some((entry) => entry.kind === "scope_guard"));

    const reviewed = await runWorkflowNode(dir, "review", { taskId: "T001" });
    assert.equal(reviewed.status, "reviewed");
    assert.equal(reviewed.reviewResult.pass, true);

    const checkpointed = await runWorkflowNode(dir, "checkpoint", { taskId: "T001" });
    assert.equal(checkpointed.status, "completed");
  });
});

test("command safety blocks recursive deletion of project source directories", async () => {
  await withTempDir(async (dir) => {
    const blockedShell = await runCommand("rm -rf src", dir);
    assert.notEqual(blockedShell.exitCode, 0);
    assert.match(blockedShell.stderr, /Command blocked by WildArrange command safety/);

    const blockedNested = await runCommand("echo prep && rm -rf ./test/unit", dir);
    assert.notEqual(blockedNested.exitCode, 0);
    assert.match(blockedNested.stderr, /project source, test, or doc directories/);

    const allowed = await runCommand("rm -rf .tmp-scratch node_modules_cache", dir);
    assert.equal(allowed.exitCode, 0);
  });
});

test("acceptance proof rejects no-op tasks with trivial worker and verifier", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "noop-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Noop guard",
      tasks: [{
        id: "T001",
        subject: "看似完成实则什么都没做",
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["true"],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.notEqual(result.task.status, "completed");
    assert.equal(result.task.last_failure.reason, "acceptance_proof_failed");
    assert.ok(result.acceptanceProof.checks.some((check) => check.name === "not_noop_task" && check.status === "fail"));
  });
});

test("worker execution records a pre-execute workspace snapshot in a git repo", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    for (const command of [
      "git init",
      "git config user.email helix@test.local",
      "git config user.name helix-test",
      "git add -A",
      "git commit -m init --no-gpg-sign",
    ]) {
      const result = await runCommand(command, dir);
      assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
    }

    const planPath = path.join(dir, "snapshot-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Snapshot before execute",
      tasks: [{
        id: "T001",
        subject: "写一个工件文件",
        writable_paths: [".helix/artifacts/**", "src/**"],
        worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/out.txt','snapshot')\"",
        verify_commands: ["node -e \"const fs=require('fs'); process.exit(fs.readFileSync('src/out.txt','utf8')==='snapshot'?0:1)\""],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "completed");
    const snapshotEvidence = result.task.evidence.find((entry) => entry.kind === "workspace_snapshot");
    assert.ok(snapshotEvidence);
    assert.equal(snapshotEvidence.available, true);
    assert.ok(snapshotEvidence.headCommit);
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /pre_execute_snapshot/);
  });
});

test("skill matcher picks up route intents declared with signals", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const result = await matchSkills(dir, { text: "继续 从上次断点恢复工作", stage: "execute" });
    assert.ok(result.routeSignals.intents.includes("resume"));
    assert.ok(result.routeSignals.skills.length > 0);
    const routeBoosted = result.matched.filter((entry) => entry.reasons.includes("route-signal"));
    assert.ok(routeBoosted.length > 0);
  });
});

test("state restore recovers runtime files from a backup and keeps a pre-restore backup", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "restore-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Restore drill",
      tasks: [{
        id: "T001",
        subject: "占位任务",
        writable_paths: ["src/**"],
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    const backup = await writeRuntimeStateBackup(dir, { reason: "before-corruption" });
    const tasksPath = resolveHelixPath(dir, "team", "tasks.json");
    const original = await readFile(tasksPath, "utf8");
    await writeFile(tasksPath, "{ corrupted", "utf8");

    const backups = await listRuntimeStateBackups(dir);
    assert.ok(backups.some((entry) => entry.backupId === backup.backupId));

    const restore = await restoreRuntimeStateBackup(dir, { backupId: backup.backupId });
    assert.ok(restore.restored.includes(".helix/team/tasks.json"));
    assert.ok(restore.preRestoreBackupId);
    assert.notEqual(restore.preRestoreBackupId, backup.backupId);
    assert.equal(await readFile(tasksPath, "utf8"), original);

    await assert.rejects(() => restoreRuntimeStateBackup(dir, { backupId: "backup_missing" }), /unknown state backup/);
  });
});

test("doctor passes on a healthy runtime and flags hand-edited completion", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const workflow = await runWorkflow(dir, { sample: true });
    assert.equal(workflow.ok, true);
    await writeRuntimeStateBackup(dir, { reason: "doctor-baseline" });

    const healthy = await runDoctor(dir);
    assert.equal(healthy.ok, true, JSON.stringify(healthy.findings, null, 2));
    assert.equal(healthy.errorCount, 0);
    assert.ok(healthy.sections.completionAudit.checkedCompleted >= 1);
    assert.equal(healthy.sections.ledgerBackupCrossCheck.prefixIntact, true);

    const tasksPath = resolveHelixPath(dir, "team", "tasks.json");
    const state = await readJson(tasksPath);
    state.tasks.push({
      id: "T999",
      subject: "手改的假完成任务",
      status: "completed",
      attempts: 0,
      maxAttempts: 3,
      blockedBy: [],
      writable_paths: [],
      worker_command: null,
      verify_commands: ["true"],
      evidence: [],
    });
    await writeFile(tasksPath, JSON.stringify(state, null, 2), "utf8");

    const flagged = await runDoctor(dir);
    assert.equal(flagged.ok, false);
    const messages = flagged.findings.map((finding) => finding.message).join("\n");
    assert.match(messages, /T999 is completed but has no checkpoint file/);
    assert.match(messages, /T999 is completed but the ledger has no completion event/);
  });
});

test("doctor detects ledger truncation against the latest backup", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await writeRuntimeStateBackup(dir, { reason: "anchor" });
    await appendLedger(dir, { type: "post_backup_event" });

    const intact = await runDoctor(dir);
    assert.equal(intact.sections.ledgerBackupCrossCheck.prefixIntact, true);

    const ledgerPath = resolveHelixPath(dir, "ledger.jsonl");
    const lines = (await readFile(ledgerPath, "utf8")).split(/\r?\n/).filter(Boolean);
    await writeFile(ledgerPath, `${lines.slice(-2).join("\n")}\n`, "utf8");

    const flagged = await runDoctor(dir);
    assert.equal(flagged.ok, false);
    assert.equal(flagged.sections.ledgerBackupCrossCheck.prefixIntact, false);
    assert.ok(flagged.findings.some((finding) => finding.section === "ledger_backup" && finding.severity === "error"));
  });
});

test("injection mounts skills on demand when request text is available", async () => {
  await withTempDir(async (dir) => {
    const packDir = await writeMinimalPromptPack(dir, {
      "always-skill": "# 保底运行时说明\n\n必须始终注入。\n",
      "db-skill": "# 数据库迁移\n\nmigration schema 数据库 索引 回滚。\n",
      "ui-skill": "# 浏览器验收\n\nUI 页面 浏览器 截图 验收。\n",
    });
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      skillMatcher: {
        dynamicInjection: { enabled: true, maxSkills: 4, alwaysMount: ["always-skill"] },
      },
      injectionPoints: {
        before_execute: {
          enabled: true,
          tools: [],
          markdown: [],
          skills: ["always-skill", "db-skill", "ui-skill"],
          rules: { mode: "dynamic" },
        },
      },
    }, null, 2));
    await initRuntime(dir, { promptPackDir: packDir });

    const dynamic = await resolveInjectionPoint(dir, "before_execute", { taskId: "T001" }, {
      text: "请设计数据库 migration 方案并考虑回滚",
      stage: "execute",
    });
    const mountedNames = dynamic.skills.map((skill) => skill.name);
    assert.equal(dynamic.skillSelection.mode, "dynamic");
    assert.ok(mountedNames.includes("always-skill"));
    assert.ok(mountedNames.includes("db-skill"));
    assert.ok(!mountedNames.includes("ui-skill"));
    assert.ok(dynamic.skillSelection.referenced.some((item) => item.name === "ui-skill" && item.reason === "not_matched"));

    const fallback = await resolveInjectionPoint(dir, "before_execute", { taskId: "T001" });
    assert.equal(fallback.skillSelection.mode, "static");
    assert.equal(fallback.skillSelection.reason, "no_request_text");
    assert.deepEqual(fallback.skills.map((skill) => skill.name), ["always-skill", "db-skill", "ui-skill"]);
  });
});

test("injection dynamic mounting enforces the max skill cap by score", async () => {
  await withTempDir(async (dir) => {
    const packDir = await writeMinimalPromptPack(dir, {
      "always-skill": "# 保底\n\n始终注入。\n",
      "db-skill": "# 数据库迁移\n\nmigration schema 数据库 索引 回滚 数据库 迁移。\n",
      "ui-skill": "# 浏览器验收\n\nUI 页面 浏览器 截图。\n",
    });
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      skillMatcher: {
        dynamicInjection: { enabled: true, maxSkills: 1, alwaysMount: ["always-skill"] },
      },
      injectionPoints: {
        before_execute: {
          enabled: true,
          tools: [],
          markdown: [],
          skills: ["always-skill", "db-skill", "ui-skill"],
          rules: { mode: "dynamic" },
        },
      },
    }, null, 2));
    await initRuntime(dir, { promptPackDir: packDir });

    const injection = await resolveInjectionPoint(dir, "before_execute", {}, {
      text: "数据库 migration 迁移，同时更新 UI 页面截图",
      stage: "execute",
    });
    const mountedNames = injection.skills.map((skill) => skill.name);
    assert.ok(mountedNames.includes("always-skill"));
    assert.equal(mountedNames.length, 2);
    assert.ok(injection.skillSelection.referenced.some((item) => item.reason === "over_max_skills"));
  });
});

test("hook injection demotes unmatched skills to on-demand references", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const result = await runInjectionHook(dir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-ondemand",
      cwd: dir,
      prompt: "zzqq xylophone quux",
    });
    assert.match(result.output, /wildarrange-injection-runtime/);
    assert.match(result.output, /按需可加载 Skill/);
    assert.match(result.output, /prompts show --skill/);
    // 与请求无关的技能必须降级为引用，不注入全文
    assert.doesNotMatch(result.output, /### review-work\n/);
    assert.doesNotMatch(result.output, /### wa-ideate\n/);
    assert.match(result.output, /- review-work（与本次请求未匹配）/);
  });
});

test("adversarial round 1: context injection surface resists stuffing and traversal", async () => {
  await withTempDir(async (dir) => {
    const packDir = await writeMinimalPromptPack(dir, {
      "always-skill": "# 保底\n\n始终注入。\n",
      "s-one": "# 技能一\n\nalpha 组件 页面。\n",
      "s-two": "# 技能二\n\nbeta 接口 服务。\n",
      "s-three": "# 技能三\n\ngamma 数据 索引。\n",
      "s-four": "# 技能四\n\ndelta 部署 发布。\n",
      "s-five": "# 技能五\n\nepsilon 测试 校验。\n",
      "huge-skill": `# 巨型技能\n\n${"攻击者试图用超长技能塞爆上下文。".repeat(3_000)}\n`,
    });
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      skillMatcher: {
        dynamicInjection: { enabled: true, maxSkills: 2, alwaysMount: ["always-skill"] },
      },
      contextBudgets: {
        points: { before_execute: { skillMaxChars: 4_000 } },
      },
      injectionPoints: {
        before_execute: {
          enabled: true,
          tools: [],
          markdown: [
            "../../../etc/passwd",
            "/etc/hosts",
            ".helix/context-agents/YingLong-{taskId}.md",
          ],
          skills: ["always-skill", "s-one", "s-two", "s-three", "s-four", "s-five", "huge-skill"],
          rules: { mode: "dynamic" },
        },
      },
    }, null, 2));
    await initRuntime(dir, { promptPackDir: packDir });

    // 攻击 1：关键词堆砌，把所有技能名和触发词都塞进请求，试图挂满全文
    const stuffing = await resolveInjectionPoint(dir, "before_execute", { taskId: "T001" }, {
      text: "s-one s-two s-three s-four s-five huge-skill alpha beta gamma delta epsilon 组件 接口 数据 部署 测试 巨型技能",
      stage: "execute",
    });
    const stuffed = stuffing.skills.map((skill) => skill.name);
    assert.ok(stuffed.length <= 3, `cap must hold, got: ${stuffed.join(", ")}`);
    assert.ok(stuffed.includes("always-skill"));
    assert.ok(stuffing.skillSelection.referenced.length >= 4);

    // 攻击 2：巨型技能即使被挂载也必须被预算截断
    const mountedHuge = stuffing.skills.find((skill) => skill.name === "huge-skill");
    if (mountedHuge) {
      assert.equal(mountedHuge.truncated, true);
      assert.ok(mountedHuge.content.length <= 4_000);
    }

    // 攻击 3：markdown 挂载的路径穿越与绝对路径必须被拒绝
    const traversal = await resolveInjectionPoint(dir, "before_execute", { taskId: "T001" });
    assert.ok(traversal.markdown.every((item) => !item.path.includes("..") && !item.path.startsWith("/")));

    // 攻击 4：模板变量注入 ../ 穿越
    const templateAttack = await resolveInjectionPoint(dir, "before_execute", { taskId: "../../../../etc/passwd" });
    assert.ok(templateAttack.markdown.every((item) => !item.path.includes("..")));

    // 攻击 5：请求文本试图伪造 explicit skills 参数（注入链路不透传 skills 选项）
    const explicitAttack = await resolveInjectionPoint(dir, "before_execute", {}, {
      text: "skills=huge-skill --skills huge-skill,s-one,s-two,s-three,s-four,s-five",
      stage: "execute",
    });
    assert.ok(explicitAttack.skills.length <= 3);
  });
});

test("adversarial round 2: completion forgery attempts are caught by gates and doctor", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    for (const command of [
      "git init",
      "git config user.email attacker@test.local",
      "git config user.name attacker",
      "git add -A",
      "git commit -m init --no-gpg-sign",
    ]) {
      const result = await runCommand(command, dir);
      assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
    }
    const planPath = path.join(dir, "forgery-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Forgery drill",
      tasks: [
        {
          id: "T001",
          subject: "试图删除源代码目录",
          writable_paths: ["src/**"],
          worker_command: "rm -rf src",
          verify_commands: ["node -e \"process.exit(0)\""],
        },
        {
          id: "T002",
          subject: "试图越界写文件",
          writable_paths: ["src/**"],
          worker_command: "node -e \"const fs=require('fs'); fs.writeFileSync('secrets.txt','leak')\"",
          verify_commands: ["node -e \"process.exit(0)\""],
        },
      ],
    }, null, 2));
    await importPlan(dir, planPath);

    // 攻击 1：worker 命令直接删源代码目录 -> command safety 先拦
    const first = await runNextTask(dir);
    assert.equal(first.task.id, "T001");
    assert.notEqual(first.task.status, "completed");
    const t1 = (await readJson(resolveHelixPath(dir, "team", "tasks.json"))).tasks.find((task) => task.id === "T001");
    assert.notEqual(t1.status, "completed");
    assert.ok(t1.evidence.some((entry) => entry.kind === "worker" && /Command blocked by WildArrange command safety/.test(entry.stderr || "")));

    // 攻击 2：worker 越界写 -> scope guard 拦下并生成 ChangeRequest
    const state = await readJson(resolveHelixPath(dir, "team", "tasks.json"));
    state.tasks.find((task) => task.id === "T001").status = "completed";
    await writeFile(resolveHelixPath(dir, "team", "tasks.json"), JSON.stringify(state, null, 2), "utf8");
    const second = await runNextTask(dir);
    assert.equal(second.task.id, "T002");
    assert.notEqual(second.task.status, "completed");
    assert.equal(second.scopeResult.status, "fail");
    assert.ok(second.task.last_change_request);

    // 攻击 3：伪造 ledger 完成事件（没有合法 hash 链）-> ledger verify 抓出
    const ledgerPath = resolveHelixPath(dir, "ledger.jsonl");
    const currentLedger = await readFile(ledgerPath, "utf8");
    await writeFile(ledgerPath, `${currentLedger}${JSON.stringify({ type: "task_verified", taskId: "T002", forged: true })}\n`, "utf8");
    const ledgerCheck = await verifyLedger(dir);
    assert.equal(ledgerCheck.ok, false);
    assert.ok(ledgerCheck.failures.some((failure) => failure.reason === "unhashed_entry_after_chain_start"));

    // 攻击 4：手改台账 + 伪造 checkpoint 文件 -> doctor 仍能从 acceptance proof 与 ledger 对账抓出
    const forgedState = await readJson(resolveHelixPath(dir, "team", "tasks.json"));
    forgedState.tasks.find((task) => task.id === "T002").status = "completed";
    await writeFile(resolveHelixPath(dir, "team", "tasks.json"), JSON.stringify(forgedState, null, 2), "utf8");
    await writeFile(resolveHelixPath(dir, "checkpoints", `${forgedState.planId}-T002.json`), JSON.stringify({ forged: true }), "utf8");
    const report = await runDoctor(dir);
    assert.equal(report.ok, false);
    const messages = report.findings.map((finding) => finding.message).join("\n");
    assert.match(messages, /T002 is completed but has no acceptance proof report/);
    assert.match(messages, /T002 is completed but the ledger has no completion event/);
  });
});

test("attention report aggregates decisions waiting on the user", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "attention-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Attention drill",
      tasks: [{
        id: "T001",
        subject: "被审阅阻塞的任务",
        writable_paths: ["src/**"],
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }, null, 2));
    await importPlan(dir, planPath);
    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    await runWorkflowNode(dir, "verify", { taskId: "T001" });
    await recordReviewBlocker(dir, {
      taskId: "T001",
      title: "评审发现证据不足",
      objective: "补齐边界条件证据后再回到主任务。",
      evidence: "verifier evidence does not cover edge cases",
      rationale: "blocker 必须作为独立任务解决。",
      worker_command: "node -e \"process.exit(0)\"",
      verify_commands: ["node -e \"process.exit(0)\""],
    });

    const attention = await attentionReport(dir);
    assert.ok(attention.total >= 1);
    assert.ok(attention.needsUserDecision.some((task) => task.id === "T001" && task.status === "review_blocked"));

    const data = await dashboardData(dir);
    assert.ok(data.attention);
    assert.equal(data.attention.kind, "attention_report");
  });
});

test("command safety allows configured extra patterns to block project-specific commands", async () => {
  const config = {
    commandSafety: {
      extraPatterns: [
        { id: "no_prod_deploy", pattern: "deploy\\s+--env\\s+prod", reason: "生产部署必须走人工流程" },
      ],
    },
  };
  const extraPatterns = compileCommandSafetyPatterns(config);
  assert.equal(extraPatterns.length, 1);

  const blocked = evaluateCommandSafety("deploy --env prod", { extraPatterns });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.findings.some((finding) => finding.id === "no_prod_deploy"));

  // built-in floor still enforced even without extras
  const builtin = evaluateCommandSafety("rm -rf /");
  assert.equal(builtin.allowed, false);

  // unrelated command with the extra pattern loaded stays allowed
  const ok = evaluateCommandSafety("npm run build", { extraPatterns });
  assert.equal(ok.allowed, true);

  // invalid regex entries are skipped, not thrown
  const skipped = compileCommandSafetyPatterns({ commandSafety: { extraPatterns: [{ pattern: "([" }] } });
  assert.equal(skipped.length, 0);
});

test("plan approval gate blocks run until developer approves", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await writeDefaultHelixConfig(dir, { root: true, force: true });
    // enable the approval gate in root config
    const configPath = path.join(dir, "helix.config.json");
    const config = await readJson(configPath);
    config.planApproval = { required: true };
    await writeFile(configPath, JSON.stringify(config, null, 2));

    const planPath = path.join(dir, "approval-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Approval drill",
      tasks: [{
        id: "T001",
        subject: "should not run before approval",
        writable_paths: ["src/**"],
        worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/a.js','X\\n')\"",
        verify_commands: ["node -e \"const fs=require('fs'); if(!fs.readFileSync('src/a.js','utf8').includes('X')) process.exit(1)\""],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    const pending = await loadPlanApproval(dir);
    assert.equal(pending.required, true);
    assert.equal(pending.status, "pending");

    const blocked = await runNextTask(dir);
    assert.equal(blocked.status, "awaiting_plan_approval");
    assert.equal(blocked.task, null);

    // attention surfaces the pending approval for the hook/dashboard channel
    const attention = await attentionReport(dir);
    assert.ok(attention.awaitingPlanApproval.length === 1);

    // hook injects the "ask the developer" directive
    const hook = await runInjectionHook(dir, { hook_event_name: "UserPromptSubmit", prompt: "继续" });
    const hookText = JSON.stringify(hook);
    assert.match(hookText, /需要开发者决策/);
    assert.match(hookText, /计划待确认/);

    await approvePlan(dir);
    const approved = await loadPlanApproval(dir);
    assert.equal(approved.status, "approved");

    const ran = await runNextTask(dir);
    assert.equal(ran.status, "completed");
    assert.equal(ran.task.id, "T001");
  });
});
