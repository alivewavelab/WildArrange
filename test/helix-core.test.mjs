import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";

import { startDashboardServer } from "../src/helix-dashboard.mjs";
import {
  admitParallelAgentResult,
  buildAgentContext,
  buildArchivistPacket,
  continuationDirective,
  createSamplePlan,
  createTeamTask,
  claimTeamTask,
  classifyManifestPathChanges,
  dashboardData,
  getTeamTask,
  importPlan,
  installAdapter,
  initRuntime,
  listParallelAgentRuns,
  loadHelixConfig,
  listTeamMessages,
  listTeamTasks,
  listChangeRequests,
  listPromptPack,
  pathAllowed,
  preToolUseGuard,
  readJson,
  recordReviewBlocker,
  recordTaskEvidence,
  renderPromptPackEntry,
  resolveChangeRequest,
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
  validatePlanGraph,
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

async function withDashboard(dir, fn) {
  const server = await startDashboardServer(dir, { host: "127.0.0.1", port: 0 });
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

async function postJson(url, body) {
  return fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
        "YingLong",
        "Kui",
        "ZhuRong",
        "Taotie",
        "LuanNiao",
        "QiongQi",
        "BaiZe",
        "DiJiang",
        "Router",
        "Jiuwei",
        "ProductIntentReviewer",
        "UserJourneyMapper",
        "AcceptanceDesigner",
        "UXInteractionReviewer",
        "ScopeTradeoffReviewer",
        "DomainBenchmarkResearcher",
      ].sort(),
    );
    assert.ok(pack.skills.includes("review-work"));
    assert.equal(pack.tools, "tools/tool-contract.json");
    assert.equal(pack.routes, "routes.json");
    assert.ok(pack.skills.includes("wildarrange-injection-runtime"));

    const yingLongPrompt = await renderPromptPackEntry(dir, { agent: "YingLong" });
    assert.match(yingLongPrompt, /必须 verifier PASS/);

    const reviewSkill = await renderPromptPackEntry(dir, { skill: "review-work" });
    assert.match(reviewSkill, /目标验证器/);

    const toolContract = JSON.parse(await renderPromptPackEntry(dir, { tools: true }));
    assert.equal(toolContract.runtime, "wildarrange-linear");
    assert.ok(toolContract.tools.some((tool) => tool.name === "helix_run_next"));
    assert.ok(toolContract.tools.some((tool) => tool.name === "scope_guard"));
    assert.ok(toolContract.tools.some((tool) => tool.name === "ast_grep_search"));
    assert.ok(toolContract.tools.some((tool) => tool.name === "team_send_message"));

    const routeTable = JSON.parse(await renderPromptPackEntry(dir, { routes: true }));
    assert.equal(routeTable.version, 1);
    assert.ok(routeTable.intents.some((intent) => intent.name === "execute"));
    assert.ok(routeTable.planAgentBundles.some((agent) => agent.name === "ProductIntentReviewer"));
  });
});

test("route decision loads product planning agent bundle on demand", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const route = await routeRequest(dir, {
      text: "做一个网页版提醒事项 App，一期 MVP 要有清单流程、空状态、验收标准和失败恢复。",
    });

    assert.equal(route.domain, "visual");
    assert.equal(route.category, "visual-engineering");
    assert.ok(route.planAgents.some((agent) => agent.name === "ProductIntentReviewer"));
    assert.ok(route.planAgents.some((agent) => agent.name === "UserJourneyMapper"));
    assert.ok(route.planAgents.some((agent) => agent.name === "AcceptanceDesigner"));
    assert.ok(route.planAgents.some((agent) => agent.name === "UXInteractionReviewer"));
    assert.ok(route.planAgents.some((agent) => agent.name === "ScopeTradeoffReviewer"));
    assert.match(route.reason, /验收/);
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

test("default GPT-family agents are delegated to the host provider", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const { config } = await loadHelixConfig(dir);
    assert.equal(config.modelProviders.host.type, "host");
    assert.equal(config.agents.YingLong.provider, "host");
    assert.equal(config.agents.QiongQi.provider, "host");
    assert.equal(config.modelProviders.openai, undefined);

    const resolved = resolveAgentProvider(config, "QiongQi");
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
    assert.equal(config.agents.YingLong.model, "legacy-executor");
    assert.equal(config.agents.QiongQi.model, "legacy-reviewer");
    assert.deepEqual(config.review.llm.agents, ["QiongQi"]);

    const message = await sendTeamMessage(dir, { from: legacyLead, to: legacyExecutor, body: "legacy route" });
    assert.equal(message.from, "Jiuwei");
    assert.equal(message.to, "YingLong");

    const legacyPrompt = await renderPromptPackEntry(dir, { agent: legacyExecutor });
    assert.match(legacyPrompt, /YingLong/);
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
    assert.match(result.output, /## Route Decision/);
    assert.match(result.output, /Category: visual-engineering/);
    assert.match(result.output, /Plan Agent Bundle/);
    assert.match(result.output, /UXInteractionReviewer/);
    assert.match(result.output, /Project Rules/);
    assert.match(result.output, /Always verify behavior/);

    const hookRecord = await readJson(resolveHelixPath(dir, "sessions", "hooks", "session-1-UserPromptSubmit.json"));
    assert.equal(hookRecord.event, "UserPromptSubmit");
    assert.ok(hookRecord.output.length > 0);
  });
});

test("hook adapter triggers ArchivistRouter without blocking user prompt injection", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
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
    const archivist = await readJson(resolveHelixPath(dir, "memory", "last-archivist-result.json"));
    assert.equal(archivist.llmStatus, "fallback");
    assert.equal(archivist.packet.stage, "execute");
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
    assert.match(result.output, /Dynamic Targets/);
    assert.match(result.output, /src\/app\.js/);
    assert.match(result.output, /Tool Result Gate/);
    assert.match(result.output, /Decision: pass/);
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
    assert.match(result.output, /Tool Result Gate/);
    assert.match(result.output, /Decision: block/);
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

test("adapter install writes codex hooks and cursor rules", async () => {
  await withTempDir(async (dir) => {
    const report = await installAdapter(dir, { target: "all", mode: "npx", packageName: "wildarrange" });
    assert.equal(report.mode, "npx");
    assert.ok(report.outputs.some((output) => output.path === ".helix/adapters/codex/hooks.json"));
    assert.ok(report.outputs.some((output) => output.path === ".cursor/rules/wildarrange.mdc"));

    const codexHooks = await readJson(resolveHelixPath(dir, "adapters", "codex", "hooks.json"));
    assert.ok(codexHooks.hooks.PreToolUse);
    assert.match(codexHooks.hooks.PreToolUse[0].matcher, /apply_patch/);
    assert.match(codexHooks.hooks.SessionStart[0].hooks[0].command, /npx -y wildarrange hook run/);

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
    assert.ok(uninstall.outputs.some((output) => output.path === ".cursor/rules/wildarrange.mdc" && output.status === "removed" && output.backup));
    await assert.rejects(readFile(cursorRulePath, "utf8"), /ENOENT/);
    assert.match(await readFile(resolveHelixPath(dir, "adapters", "uninstall-report.md"), "utf8"), /Adapter Uninstall Report/);
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
    assert.equal(message.to, "YingLong");
    assert.equal(message.status, "unread");
    assert.match(message.inboxPath, /^\.helix\/team\/inbox\/YingLong\/msg_.+\.json$/);

    const yingLongInbox = await listTeamMessages(dir, { agent: "YingLong" });
    assert.equal(yingLongInbox.length, 1);
    assert.equal(yingLongInbox[0].id, message.id);
    assert.equal(yingLongInbox[0].body, "Continue T001 after verifier passes.");

    const allInbox = await listTeamMessages(dir);
    assert.equal(allInbox.length, 1);
    assert.match(await readFile(resolveHelixPath(dir, "team", "messages.md"), "utf8"), /Jiuwei -> YingLong: continue T001/);
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
      agent: "Kui",
      command,
    });

    assert.equal(batch.status, "completed");
    assert.equal(batch.taskCount, 2);
    assert.ok(batch.results.every((result) => result.agent === "Kui" && result.pass));
    assert.ok(batch.results.every((result) => result.result.summary === "parallel done"));

    const messages = await listTeamMessages(dir, { agent: "Jiuwei" });
    assert.equal(messages.length, 2);
    assert.ok(messages.every((message) => message.summary.includes("parallel result")));

    const runs = await listParallelAgentRuns(dir);
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0].results.length, 2);
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /parallel_agents_completed/);
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
      agent: "Kui",
      command,
    });
    const admitted = await admitParallelAgentResult(dir, {
      runId: batch.runId,
      taskId: "T001",
    });

    assert.equal(admitted.status, "completed");
    assert.deepEqual(admitted.appliedPaths, ["src/parallel.txt"]);
    assert.equal(await readFile(path.join(dir, "src", "parallel.txt"), "utf8"), "ok\n");
    const checkpoint = await readJson(resolveHelixPath(dir, "checkpoints", `${plan.id}-T001.json`));
    assert.equal(checkpoint.taskId, "T001");
    assert.equal(checkpoint.verifyResult.pass, true);
    assert.equal(checkpoint.scopeResult.status, "pass");
    assert.equal(checkpoint.reviewResult.pass, true);
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
      agent: "Kui",
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

test("routeRequest maps high-risk domains to the right agents and categories", async () => {
  await withTempDir(async (dir) => {
    const visual = await routeRequest(dir, "优化这个页面 CSS 布局和按钮动效");
    assert.equal(visual.domain, "visual");
    assert.equal(visual.category, "visual-engineering");
    assert.equal(visual.route, "execute");
    assert.ok(visual.skills.includes("frontend-ui-ux"));

    const webTodo = await routeRequest(dir, "做一个网页版 TODO 工具，支持删除任务");
    assert.equal(webTodo.domain, "visual");
    assert.equal(webTodo.route, "execute");
    assert.equal(webTodo.category, "visual-engineering");
    assert.equal(webTodo.needsUserInput, false);

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

    const review = await routeRequest(dir, "帮我 review 这次代码是否满足目标");
    assert.equal(review.intent, "review");
    assert.equal(review.primaryAgent, "BaiZe");
    assert.equal(review.category, null);
    assert.ok(review.skills.includes("review-work"));

    const reviewableArtifact = await routeRequest(dir, "write a reviewable artifact");
    assert.equal(reviewableArtifact.intent, "execute");
    assert.equal(reviewableArtifact.route, "execute");

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

test("project rules and agent context collect matching local governance", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "AGENTS.md"), "# AGENTS\n\n必须运行真实测试。\n");
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
    assert.equal(rules.total, 2);
    assert.equal(rules.matched, 2);
    assert.ok(rules.rules.some((rule) => rule.path === "AGENTS.md"));
    assert.ok(rules.rules.some((rule) => rule.path === ".cursor/rules/frontend.md"));
    assert.match(await readFile(resolveHelixPath(dir, "rules", "context.md"), "utf8"), /UI 变更必须浏览器验收/);

    const context = await buildAgentContext(dir, { agent: "QiongQi", taskId: "T001" });
    assert.equal(context.agent, "QiongQi");
    assert.equal(context.task.id, "T001");
    assert.equal(context.projectRules.matched, 2);
    assert.match(await readFile(resolveHelixPath(dir, "context-agents", "QiongQi-T001.md"), "utf8"), /WildArrange Agent Context/);
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

    const reviewReport = await readJson(resolveHelixPath(dir, "reports", "reviews", `${plan.id}-T001.json`));
    assert.equal(reviewReport.status, "pass");
    assert.ok(reviewReport.lanes.some((lane) => lane.name === "goal_compliance"));

    const ledger = await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8");
    assert.match(ledger, /task_verified/);
    assert.match(ledger, /review_gate_completed/);
    assert.match(ledger, /snapshot_written/);
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
          QiongQi: { provider: "local", model: "test-reviewer" },
        },
        review: {
          llm: { enabled: true, required: true, agents: ["QiongQi"] },
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
      assert.ok(result.reviewResult.lanes.some((lane) => lane.name === "llm_QiongQi" && lane.status === "pass"));
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

test("simulation greenfield project runs from product planning to completed web app", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "AGENTS.md"), "# Project Rules\n\nUser-visible web work needs verifier evidence.\n");
    await initRuntime(dir);

    const route = await routeRequest(dir, {
      text: "从零做一个网页版提醒事项 App，一期 MVP 要有清单流程、空状态、验收标准和失败恢复。",
    });
    assert.equal(route.route, "plan");
    assert.ok(route.planAgents.some((agent) => agent.name === "ProductIntentReviewer"));
    assert.ok(route.planAgents.some((agent) => agent.name === "UserJourneyMapper"));
    assert.ok(route.planAgents.some((agent) => agent.name === "AcceptanceDesigner"));
    assert.ok(route.planAgents.some((agent) => agent.name === "UXInteractionReviewer"));

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
      ],
    }, null, 2));

    await importPlan(dir, planPath);
    const first = await runNextTask(dir);
    assert.equal(first.status, "completed");
    const second = await runNextTask(dir);
    assert.equal(second.status, "completed");

    const status = await statusReport(dir);
    assert.equal(status.total, 2);
    assert.equal(status.completed, 2);
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
    assert.ok(route.planAgents.some((agent) => agent.name === "UserJourneyMapper"));
    assert.ok(route.planAgents.some((agent) => agent.name === "AcceptanceDesigner"));
    assert.ok(route.planAgents.some((agent) => agent.name === "ScopeTradeoffReviewer"));

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
      ],
    }, null, 2));

    await importPlan(dir, planPath);
    assert.equal((await runNextTask(dir)).status, "completed");
    const implemented = await runNextTask(dir);
    assert.equal(implemented.status, "completed");
    assert.equal(implemented.scopeResult.status, "pass");
    assert.equal(implemented.reviewResult.pass, true);

    await writeWorkflowSummary(dir, { reason: "existing_feature_simulation" });
    const status = await statusReport(dir);
    assert.equal(status.completed, 2);
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
    assert.equal(claimed.task.owner, "YingLong");
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

test("pathAllowed supports exact paths, directories, globs, and empty scopes", () => {
  assert.equal(pathAllowed("src/index.js", ["src/**"]), true);
  assert.equal(pathAllowed("src/index.js", ["src"]), true);
  assert.equal(pathAllowed("README.md", ["README.md"]), true);
  assert.equal(pathAllowed("test/core.test.mjs", ["test/*.mjs"]), true);
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
      const state = await fetchJson(`${baseUrl}/api/state`);
      assert.equal(state.response.status, 200);
      assert.equal(state.body.status.pending, 2);
      assert.equal(state.body.summary, null);

      const blockedClaim = await postJson(`${baseUrl}/api/tasks/claim`, { taskId: "T002", owner: "YingLong" });
      assert.equal(blockedClaim.response.status, 500);
      assert.match(blockedClaim.body.error, /blocked by T001/);

      const claimed = await postJson(`${baseUrl}/api/tasks/claim`, { taskId: "T001", owner: "YingLong" });
      assert.equal(claimed.response.status, 200);
      assert.equal(claimed.body.result.task.status, "in_progress");
      assert.equal(claimed.body.result.task.owner, "YingLong");

      const task = await fetchJson(`${baseUrl}/api/tasks/T001`);
      assert.equal(task.response.status, 200);
      assert.equal(task.body.result.task.status, "in_progress");

      const badTaskPath = await fetchJson(`${baseUrl}/api/tasks/%E0%A4%A`);
      assert.equal(badTaskPath.response.status, 400);

      const badClaim = await postJson(`${baseUrl}/api/tasks/claim`, { taskId: "../T001", owner: "YingLong" });
      assert.equal(badClaim.response.status, 400);

      const message = await postJson(`${baseUrl}/api/team/send`, {
        from: "Jiuwei",
        to: "YingLong",
        body: "Continue T001 from dashboard.",
      });
      assert.equal(message.response.status, 200);
      assert.equal(message.body.result.to, "YingLong");

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
      });
      assert.equal(created.response.status, 200);
      assert.equal(created.body.result.task.id, "T003");
      assert.equal(created.body.result.task.status, "pending");

      const summary = await postJson(`${baseUrl}/api/summary`, {});
      assert.equal(summary.response.status, 200);
      assert.equal(summary.body.result.reason, "dashboard");
      assert.equal(summary.body.result.ok, false);

      const badNode = await postJson(`${baseUrl}/api/node/%E0%A4%A`, { taskId: "T001" });
      assert.equal(badNode.response.status, 400);

      const refreshed = await fetchJson(`${baseUrl}/api/state`);
      assert.equal(refreshed.response.status, 200);
      assert.equal(refreshed.body.summary.reason, "dashboard");
      assert.equal(refreshed.body.tasks.length, 3);
    });
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

      const denied = await fetchJson(`${baseUrl}/api/state`);
      assert.equal(denied.response.status, 401);

      const allowed = await fetchJson(`${baseUrl}/api/state`, {
        headers: { authorization: "Bearer secret-token" },
      });
      assert.equal(allowed.response.status, 200);
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
