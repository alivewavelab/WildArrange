// =============================================================================
// 文件名称：runtime-prompt-pack.test.mjs
// 所属模块：test
// 作用说明：
//   init 持久化、Prompt Pack 安装与完整性、config 模型/注入点挂载、注入预算截断。
// =============================================================================

import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { COMMAND_REGISTRY } from "../src/interface/cli-help.mjs";
import { buildAgentContext } from "../src/ai/context.mjs";
import { matchSkills } from "../src/ai/skill-matcher.mjs";
import { resolveInjectionPoint } from "../src/ai/injection.mjs";
import { resolveAgentProvider } from "../src/infra/llm-provider.mjs";
import { listPromptPack, renderPromptPackEntry } from "../src/infra/prompt-pack.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { loadWildArrangeConfig } from "../src/infra/runtime-config.mjs";
import { hashContent, readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { withExternalProject } from "./helpers/external-fixture.mjs";
import { writeMinimalPromptPack, writePolicyConfig } from "./helpers/runtime-fixtures.mjs";

test("init creates durable runtime state", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const work = await initRuntime(projectRoot);
    assert.equal(work.stage, "initialized");
    assert.equal(await readJson(resolveWildArrangePath(projectRoot, "agents.json"), null), null);
    assert.equal(await readJson(resolveWildArrangePath(projectRoot, "categories.json"), null), null);
  });
});

test("init installs wildarrange-linear prompt, skill, and tool contracts", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const pack = await listPromptPack(projectRoot);
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
    assert.ok(pack.skills.every((skill) => !skill.startsWith("wa-")));
    assert.ok(pack.skills.every((skill) => !skill.startsWith("lcx-")));
    assert.equal(pack.tools, "tools/tool-contract.json");
    assert.equal(pack.routes, "routes.json");
    assert.ok(pack.skills.includes("wildarrange-injection-runtime"));

    const jiuweiPrompt = await renderPromptPackEntry(projectRoot, { agent: "Jiuwei" });
    assert.match(jiuweiPrompt, /verifier/);

    const reviewSkill = await renderPromptPackEntry(projectRoot, { skill: "review-work" });
    assert.match(reviewSkill, /目标验证器/);

    const toolContract = JSON.parse(await renderPromptPackEntry(projectRoot, { tools: true }));
    assert.equal(toolContract.runtime, "wildarrange-linear");
    // 合同由命令注册表生成：每条真实 CLI 命令恰好对应一个工具，不再有手写的虚构工具名。
    assert.deepEqual(toolContract.tools.map((tool) => tool.command), COMMAND_REGISTRY.map((entry) => `wildarrange ${entry.usage}`));
    assert.ok(toolContract.tools.some((tool) => tool.name === "wildarrange_run"));

    const routeTable = JSON.parse(await renderPromptPackEntry(projectRoot, { routes: true }));
    assert.equal(routeTable.version, 1);
    assert.ok(routeTable.intents.some((intent) => intent.name === "execute"));
    assert.ok(routeTable.planSkillBundles.some((skill) => skill.name === "review-product-intent"));
    assert.doesNotMatch(JSON.stringify(routeTable), /wa-[a-z-]+/);
  });
});

test("config controls models and injection point mounts", async () => {
  await withExternalProject(async ({ projectRoot, governanceRoot }) => {
    await writePolicyConfig(governanceRoot, JSON.stringify({
      agents: {
        BaiZe: { provider: "host", model: "host-default", reasoning: "xhigh" },
      },
      injectionPoints: {
        before_review: {
          enabled: true,
          tools: ["review_gate", "wildarrange_evidence_record"],
          markdown: ["CLAUDE.md"],
          skills: ["review-work", "wildarrange-injection-runtime"],
          rules: { mode: "dynamic" },
        },
      },
    }, null, 2));
    await writeFile(path.join(projectRoot, "CLAUDE.md"), "# Local Rules\n\nUse real verification.\n");
    await initRuntime(projectRoot);

    const loaded = await loadWildArrangeConfig(projectRoot);
    assert.equal(path.resolve(projectRoot, loaded.sourcePath), path.join(governanceRoot, "policy", "wildarrange.config.json"));
    assert.equal(loaded.config.agents.BaiZe.reasoning, "xhigh");

    const injection = await resolveInjectionPoint(projectRoot, "before_review", { agent: "BaiZe", taskId: "T001" });
    assert.deepEqual(injection.tools, ["review_gate", "wildarrange_evidence_record"]);
    assert.equal(injection.markdown[0].path, "CLAUDE.md");
    assert.ok(injection.markdown[0].content.includes("Use real verification"));
    assert.ok(injection.skills.some((skill) => skill.name === "review-work"));
    assert.ok(injection.skills.some((skill) => skill.name === "wildarrange-injection-runtime"));
  }, { init: false });
});

test("LuWu governance injection mounts the declared read-only tools and Skills", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const injection = await resolveInjectionPoint(projectRoot, "repository_governance", { agent: "LuWu" });
    assert.deepEqual(injection.tools, [
      "repository_governance_audit",
      "wildarrange_rules_collect",
      "comment_check",
      "config_verify",
    ]);
    for (const skill of ["repository-governance", "init-deep", "pre-publish-review", "remove-ai-slops"]) {
      assert.ok(injection.skills.some((entry) => entry.name === skill), skill);
    }
  });
});

test("injection budgets load activated skills beyond legacy six thousand chars", async () => {
  await withExternalProject(async ({ projectRoot, governanceRoot }) => {
    const skillBody = `# 重型 Skill\n\n${"长流程内容。".repeat(1_200)}\n\n末尾校验：完整加载\n`;
    const packDir = await writeMinimalPromptPack(projectRoot, { "heavy-flow": skillBody });
    await writePolicyConfig(governanceRoot, JSON.stringify({
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
    await initRuntime(projectRoot, { promptPackDir: packDir });

    const injection = await resolveInjectionPoint(projectRoot, "before_execute", { taskId: "T001" });
    const skill = injection.skills[0];
    assert.ok(skill.chars > 6_000);
    assert.equal(skill.truncated, false);
    assert.equal(skill.budgetChars, 80_000);
    assert.match(skill.content, /末尾校验：完整加载/);
  }, { init: false });
});

test("injection budgets expose explicit truncation metadata", async () => {
  await withExternalProject(async ({ projectRoot, governanceRoot }) => {
    const skillBody = `# 超重工作流\n\n${"需要按阶段执行的长步骤。".repeat(2_000)}\n\n末尾不应进入注入\n`;
    const packDir = await writeMinimalPromptPack(projectRoot, { "heavy-flow": skillBody });
    await writePolicyConfig(governanceRoot, JSON.stringify({
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
    await initRuntime(projectRoot, { promptPackDir: packDir });

    const injection = await resolveInjectionPoint(projectRoot, "before_execute", { taskId: "T001" });
    const skill = injection.skills[0];
    assert.equal(skill.truncated, true);
    assert.equal(skill.budgetChars, 3_000);
    assert.ok(skill.content.length <= 3_000);
    assert.match(skill.content, /上下文已截断/);
    assert.doesNotMatch(skill.content, /末尾不应进入注入/);
  }, { init: false });
});

test("Prompt Pack Skill loading rejects realpath escapes and hash tampering", async () => {
  await withExternalProject(async ({ projectRoot, root, governanceRoot }) => {
    const skillBody = "# Bound workflow\n\nDO_NOT_LOAD_FROM_OUTSIDE_PACK\n";
    const packDir = await writeMinimalPromptPack(projectRoot, { "bound-flow": skillBody });
    await writePolicyConfig(governanceRoot, JSON.stringify({
      injectionPoints: {
        before_execute: {
          enabled: true,
          tools: [],
          markdown: [],
          skills: ["bound-flow"],
        },
      },
    }, null, 2));
    await initRuntime(projectRoot, { promptPackDir: packDir });

    const registeredFile = resolveWildArrangePath(projectRoot, "prompt-pack", "installed", "skills", "bound-flow.md");
    const outsideFile = path.join(projectRoot, "outside-pack-skill.md");
    await writeFile(outsideFile, skillBody);
    await rm(registeredFile);
    await symlink(outsideFile, registeredFile);

    const escaped = await resolveInjectionPoint(projectRoot, "before_execute", { taskId: "T001" });
    assert.equal(escaped.skills.some((skill) => skill.name === "bound-flow"), false);
    assert.ok(escaped.skillSelection.missing.some(
      (item) => item.name === "bound-flow" && item.reason === "integrity_failed" && /escapes installed pack root/.test(item.detail),
    ));
    await assert.rejects(renderPromptPackEntry(projectRoot, { skill: "bound-flow" }), /escapes installed pack root/);

    await rm(registeredFile);
    await writeFile(registeredFile, skillBody);
    const registryPath = resolveWildArrangePath(projectRoot, "prompt-pack.json");
    const registry = await readJson(registryPath);
    const originalHash = registry.skills["bound-flow"].sha256;
    registry.skills["bound-flow"].sha256 = "0".repeat(64);
    await writeFile(registryPath, JSON.stringify(registry, null, 2));

    const tampered = await resolveInjectionPoint(projectRoot, "before_execute", { taskId: "T001" });
    assert.equal(tampered.skills.some((skill) => skill.name === "bound-flow"), false);
    assert.ok(tampered.skillSelection.missing.some(
      (item) => item.name === "bound-flow" && item.reason === "integrity_failed" && /changed after install/.test(item.detail),
    ));
    await assert.rejects(renderPromptPackEntry(projectRoot, { skill: "bound-flow" }), /changed after install/);

    const externalPack = path.join(projectRoot, "attacker-pack");
    await mkdir(path.join(externalPack, "skills"), { recursive: true });
    const malicious = "# malicious\n\nREAD_OUTSIDE_RUNTIME_ROOT\n";
    await writeFile(path.join(externalPack, "skills", "bound-flow.md"), malicious);
    registry.packDir = externalPack;
    registry.packRootRealpath = externalPack;
    registry.installedRoot = externalPack;
    registry.skills["bound-flow"].path = "skills/bound-flow.md";
    registry.skills["bound-flow"].sha256 = hashContent(malicious);
    await writeFile(registryPath, JSON.stringify(registry, null, 2));
    await assert.rejects(renderPromptPackEntry(projectRoot, { skill: "bound-flow" }), /changed after install/);
    await assert.rejects(matchSkills(projectRoot, { text: "bound workflow" }), /changed after install/);
    assert.notEqual(originalHash, registry.skills["bound-flow"].sha256);

    const sourceManifestPath = path.join(packDir, "manifest.json");
    const sourceManifest = await readJson(sourceManifestPath);
    sourceManifest.routes = "routes.json";
    await writeFile(path.join(packDir, "routes.json"), JSON.stringify({ intents: [] }));
    await writeFile(sourceManifestPath, JSON.stringify(sourceManifest, null, 2));
    await initRuntime(projectRoot, { promptPackDir: packDir });
    const maliciousRoutes = JSON.stringify({
      intents: [{ name: "attacker", signals: ["bound"], skills: ["bound-flow"] }],
    });
    await writeFile(path.join(externalPack, "routes.json"), maliciousRoutes);
    const routeRegistry = await readJson(registryPath);
    routeRegistry.packDir = externalPack;
    routeRegistry.packRootRealpath = externalPack;
    routeRegistry.installedRoot = externalPack;
    routeRegistry.routes.path = "routes.json";
    routeRegistry.routes.sha256 = hashContent(maliciousRoutes);
    await writeFile(registryPath, JSON.stringify(routeRegistry, null, 2));
    await assert.rejects(matchSkills(projectRoot, { text: "bound workflow" }), /entry changed after install: routes/);
  }, { init: false });
});

test("default GPT-family agents are delegated to the host provider", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const { config } = await loadWildArrangeConfig(projectRoot);
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

test("Jiuwei prompt injection reports explicit truncation at the configured prompt budget", async () => {
  await withExternalProject(async ({ projectRoot, governanceRoot }) => {
    await writePolicyConfig(governanceRoot, JSON.stringify({
      contextBudgets: {
        prompt: { maxChars: 600 },
      },
    }, null, 2));
    await initRuntime(projectRoot);

    const context = await buildAgentContext(projectRoot, {
      agent: "Jiuwei",
      injectionPoint: "session_start",
    });
    assert.equal(context.agentPrompt.truncated, true);
    assert.equal(context.agentPrompt.budgetChars, 600);
    assert.ok(context.agentPrompt.loadedChars <= 600);
    assert.match(context.agentPrompt.content, /Agent Prompt 已截断/);
  }, { init: false });
});
