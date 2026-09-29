// =============================================================================
// 文件名称：runtime-skill-injection.test.mjs
// 所属模块：test
// 作用说明：
//   Skill 匹配与按需挂载：任务绑定、动态上限、Agent 绑定、对抗性上下文注入。
// =============================================================================

import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { buildAgentContext } from "../src/ai/context.mjs";
import { matchSkills } from "../src/ai/skill-matcher.mjs";
import { resolveInjectionPoint } from "../src/ai/injection.mjs";
import { runCommand } from "../src/infra/command-runner.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { loadWildArrangeConfig } from "../src/infra/runtime-config.mjs";
import { withExternalProject } from "./helpers/external-fixture.mjs";
import { writeMinimalPromptPack, nodeEval, runInjectionHook, writePolicyConfig } from "./helpers/runtime-fixtures.mjs";

test("skill matcher provides explainable loading hints", async () => {
  await withExternalProject(async ({ projectRoot }) => {

    const matched = await matchSkills(projectRoot, {
      text: "做一个网页版提醒事项 App，需要空状态、视觉验收和实现计划。",
      stage: "design",
      agent: "Jiuwei",
      limit: 20,
    });
    assert.ok(matched.matched.some((skill) => skill.name === "frontend-ui-ux"));
    assert.ok(matched.matched.some((skill) => skill.name === "visual-qa"));
    assert.ok(matched.matched.every((skill) => skill.score > 0));
    assert.ok(matched.matched.some((skill) => skill.reasons.some((reason) => reason.startsWith("stage:"))));

  });
});

test("task-bound Skills mount through the public execution hook and budgeted loader", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "task-skill-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Task Skill Binding",
      objective: "Mount persisted task skills",
      tasks: [{
        id: "T001",
        subject: "Prepare a release receipt",
        description: "Use the task-bound workflow.",
        owner: "ZhuRong",
        skills: ["publish", "missing-task-skill", "debugging", "refactor", "programming"],
        writable_paths: ["receipt.txt"],
        worker_command: nodeEval("require('fs').writeFileSync('receipt.txt', 'ok\\n')"),
        verify_commands: [nodeEval("if (require('fs').readFileSync('receipt.txt', 'utf8').trim() !== 'ok') process.exit(1)")],
      }],
    }, null, 2));
    await importPlan(projectRoot, planPath);

    const delivery = await buildAgentContext(projectRoot, {
      agent: "ZhuRong",
      taskId: "T001",
      injectionPoint: "before_execute",
    });
    assert.ok(delivery.injectionPoint.skills.some((skill) => skill.name === "publish"));
    assert.ok(delivery.injectionPoint.skillSelection.taskBound.includes("publish"));
    assert.equal(delivery.injectionPoint.skillSelection.taskBound.length, 4);
    assert.ok(delivery.injectionPoint.skillSelection.referenced.some(
      (entry) => entry.name === "programming" && entry.reason === "task_binding_over_max",
    ));
    assert.deepEqual(
      delivery.injectionPoint.skillSelection.missing.filter((entry) => entry.name === "missing-task-skill"),
      [{ name: "missing-task-skill", reason: "not_found" }],
    );
    const inspected = await resolveInjectionPoint(projectRoot, "before_execute", {
      agent: "ZhuRong",
      taskId: "T001",
    });
    assert.ok(inspected.skillSelection.taskBound.includes("publish"));

    const cliPath = path.join(process.cwd(), "bin", "wildarrange.mjs");
    const cli = await runCommand(`node ${JSON.stringify(cliPath)} context build --point before_execute --task T001`, projectRoot);
    assert.equal(cli.exitCode, 0, cli.stderr);
    const cliContext = JSON.parse(cli.stdout);
    assert.equal(cliContext.injectionPoint.name, "before_execute");
    assert.ok(cliContext.injectionPoint.skills.some((skill) => skill.name === "publish"));
    assert.match(cliContext.injectionPoint.skills.find((skill) => skill.name === "publish").content, /npm publish --dry-run/);

    const hook = await runInjectionHook(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: "task-skill-delivery",
      cwd: projectRoot,
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Add File: receipt.txt\n+ready\n*** End Patch" },
    });
    const hookOutput = JSON.parse(hook.output);
    assert.equal(hook.taskId, "T001", "public hook should resolve the runnable task without a private function call");
    assert.match(hookOutput.hookSpecificOutput.additionalContext, /执行前任务 Skill/);
    assert.match(hookOutput.hookSpecificOutput.additionalContext, /#### publish/);
    assert.match(hookOutput.hookSpecificOutput.additionalContext, /npm publish --dry-run/);
    assert.match(hookOutput.hookSpecificOutput.additionalContext, /missing-task-skill 未找到/);
    assert.match(hookOutput.hookSpecificOutput.additionalContext, /Agent：ZhuRong/);

    const review = await buildAgentContext(projectRoot, {
      agent: "BaiZe",
      taskId: "T001",
      injectionPoint: "before_review",
    });
    assert.deepEqual(review.injectionPoint.skillSelection.taskBound, [], "M1 must not claim a task binding at an unconsumed review phase");

    const session = await buildAgentContext(projectRoot, {
      agent: "Jiuwei",
      taskId: "T001",
      injectionPoint: "session_start",
    });
    assert.deepEqual(session.injectionPoint.skillSelection.taskBound, []);
    assert.ok(!session.injectionPoint.skills.some((skill) => skill.name === "publish"));
  });
});

test("skill matcher picks up route intents declared with signals", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const result = await matchSkills(projectRoot, { text: "继续 从上次断点恢复工作", stage: "execute" });
    assert.ok(result.routeSignals.intents.includes("resume"));
    assert.ok(result.routeSignals.skills.length > 0);
    const routeBoosted = result.matched.filter((entry) => entry.reasons.includes("route-signal"));
    assert.ok(routeBoosted.length > 0);
  });
});

test("injection mounts skills on demand when request text is available", async () => {
  await withExternalProject(async ({ projectRoot, governanceRoot }) => {
    const packDir = await writeMinimalPromptPack(projectRoot, {
      "always-skill": "# 保底运行时说明\n\n必须始终注入。\n",
      "db-skill": "# 数据库迁移\n\nmigration schema 数据库 索引 回滚。\n",
      "ui-skill": "# 浏览器验收\n\nUI 页面 浏览器 截图 验收。\n",
    });
    await writePolicyConfig(governanceRoot, JSON.stringify({
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
    await initRuntime(projectRoot, { promptPackDir: packDir });

    const dynamic = await resolveInjectionPoint(projectRoot, "before_execute", { taskId: "T001" }, {
      text: "请设计数据库 migration 方案并考虑回滚",
      stage: "execute",
    });
    const mountedNames = dynamic.skills.map((skill) => skill.name);
    assert.equal(dynamic.skillSelection.mode, "dynamic");
    assert.ok(mountedNames.includes("always-skill"));
    assert.ok(mountedNames.includes("db-skill"));
    assert.ok(!mountedNames.includes("ui-skill"));
    assert.ok(dynamic.skillSelection.referenced.some((item) => item.name === "ui-skill" && item.reason === "not_matched"));

    const fallback = await resolveInjectionPoint(projectRoot, "before_execute", { taskId: "T001" });
    assert.equal(fallback.skillSelection.mode, "static");
    assert.equal(fallback.skillSelection.reason, "no_request_text");
    assert.deepEqual(fallback.skills.map((skill) => skill.name), ["always-skill", "db-skill", "ui-skill"]);
  }, { init: false });
});

test("agent config binds a project Skill without leaking it to other agents", async () => {
  await withExternalProject(async ({ projectRoot, governanceRoot }) => {
    const packDir = await writeMinimalPromptPack(projectRoot, {
      "always-skill": "# 保底运行时说明\n\n必须始终注入。\n",
    });
    const projectSkillDir = path.join(projectRoot, ".agents", "skills", "baize-cli");
    await mkdir(projectSkillDir, { recursive: true });
    await writeFile(path.join(projectSkillDir, "SKILL.md"), [
      "---",
      "name: baize-cli",
      "description: 调用隔离的外部 BaiZe CLI。",
      "---",
      "",
      "# BaiZe CLI",
      "",
      "把任务包交给外部 CLI，并只接收结构化复核结果。",
      "",
    ].join("\n"));
    await writePolicyConfig(governanceRoot, JSON.stringify({
      agents: {
        Jiuwei: { skills: ["baize-cli", "missing-cli"] },
      },
      skillMatcher: {
        dynamicInjection: { enabled: true, maxSkills: 1, alwaysMount: ["always-skill"] },
      },
      injectionPoints: {
        user_prompt_submit: {
          enabled: true,
          tools: [],
          markdown: [],
          skills: ["always-skill"],
          rules: { mode: "dynamic" },
        },
      },
    }, null, 2));
    await initRuntime(projectRoot, { promptPackDir: packDir });

    const jiuwei = await resolveInjectionPoint(projectRoot, "user_prompt_submit", { agent: "Jiuwei" }, {
      text: "普通用户请求",
      stage: "plan",
    });
    const bound = jiuwei.skills.find((skill) => skill.name === "baize-cli");
    assert.equal(bound?.source, "project");
    assert.equal(bound?.path, ".agents/skills/baize-cli/SKILL.md");
    assert.deepEqual(jiuwei.skillSelection.bound, ["baize-cli", "missing-cli"]);
    assert.deepEqual(jiuwei.skillSelection.missing, [{ name: "missing-cli", reason: "not_found" }]);

    const zhurong = await resolveInjectionPoint(projectRoot, "user_prompt_submit", { agent: "ZhuRong" }, {
      text: "普通用户请求",
      stage: "execute",
    });
    assert.ok(!zhurong.skills.some((skill) => skill.name === "baize-cli"));
  }, { init: false });
});

test("agent Skill bindings reject traversal names and symlinks outside the project Skill root", async () => {
  await withExternalProject(async ({ projectRoot, root, governanceRoot }) => {
    await writePolicyConfig(governanceRoot, JSON.stringify({
      agents: { Jiuwei: { skills: ["../escape"] } },
    }));
    await assert.rejects(() => loadWildArrangeConfig(projectRoot), /invalid skill name/);

    const packDir = await writeMinimalPromptPack(projectRoot, {});
    const skillDir = path.join(projectRoot, ".agents", "skills", "escaped-cli");
    await mkdir(skillDir, { recursive: true });
    const outside = path.join(projectRoot, "outside-skill.md");
    await writeFile(outside, "# outside\n");
    await symlink(outside, path.join(skillDir, "SKILL.md"));
    await writePolicyConfig(governanceRoot, JSON.stringify({
      agents: { Jiuwei: { skills: ["escaped-cli"] } },
      injectionPoints: {
        user_prompt_submit: { enabled: true, tools: [], markdown: [], skills: [], rules: {} },
      },
    }));
    await initRuntime(projectRoot, { promptPackDir: packDir });
    const injection = await resolveInjectionPoint(projectRoot, "user_prompt_submit", { agent: "Jiuwei" });
    assert.deepEqual(injection.skillSelection.missing, [{ name: "escaped-cli", reason: "not_found" }]);
  }, { init: false });
});

test("injection dynamic mounting enforces the max skill cap by score", async () => {
  await withExternalProject(async ({ projectRoot, governanceRoot }) => {
    const packDir = await writeMinimalPromptPack(projectRoot, {
      "always-skill": "# 保底\n\n始终注入。\n",
      "db-skill": "# 数据库迁移\n\nmigration schema 数据库 索引 回滚 数据库 迁移。\n",
      "ui-skill": "# 浏览器验收\n\nUI 页面 浏览器 截图。\n",
    });
    await writePolicyConfig(governanceRoot, JSON.stringify({
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
    await initRuntime(projectRoot, { promptPackDir: packDir });

    const injection = await resolveInjectionPoint(projectRoot, "before_execute", {}, {
      text: "数据库 migration 迁移，同时更新 UI 页面截图",
      stage: "execute",
    });
    const mountedNames = injection.skills.map((skill) => skill.name);
    assert.ok(mountedNames.includes("always-skill"));
    assert.equal(mountedNames.length, 2);
    assert.ok(injection.skillSelection.referenced.some((item) => item.reason === "over_max_skills"));
  }, { init: false });
});

test("adversarial round 1: context injection surface resists stuffing and traversal", async () => {
  await withExternalProject(async ({ projectRoot, governanceRoot }) => {
    const packDir = await writeMinimalPromptPack(projectRoot, {
      "always-skill": "# 保底\n\n始终注入。\n",
      "s-one": "# 技能一\n\nalpha 组件 页面。\n",
      "s-two": "# 技能二\n\nbeta 接口 服务。\n",
      "s-three": "# 技能三\n\ngamma 数据 索引。\n",
      "s-four": "# 技能四\n\ndelta 部署 发布。\n",
      "s-five": "# 技能五\n\nepsilon 测试 校验。\n",
      "huge-skill": `# 巨型技能\n\n${"攻击者试图用超长技能塞爆上下文。".repeat(3_000)}\n`,
    });
    await writePolicyConfig(governanceRoot, JSON.stringify({
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
            ".wildarrange/context-agents/YingLong-{taskId}.md",
          ],
          skills: ["always-skill", "s-one", "s-two", "s-three", "s-four", "s-five", "huge-skill"],
          rules: { mode: "dynamic" },
        },
      },
    }, null, 2));
    await initRuntime(projectRoot, { promptPackDir: packDir });

    // 攻击 1：关键词堆砌，把所有技能名和触发词都塞进请求，试图挂满全文
    const stuffing = await resolveInjectionPoint(projectRoot, "before_execute", { taskId: "T001" }, {
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
    const traversal = await resolveInjectionPoint(projectRoot, "before_execute", { taskId: "T001" });
    assert.ok(traversal.markdown.every((item) => !item.path.includes("..") && !item.path.startsWith("/")));

    // 攻击 4：模板变量注入 ../ 穿越
    const templateAttack = await resolveInjectionPoint(projectRoot, "before_execute", { taskId: "../../../../etc/passwd" });
    assert.ok(templateAttack.markdown.every((item) => !item.path.includes("..")));

    // 攻击 5：请求文本试图伪造 explicit skills 参数（注入链路不透传 skills 选项）
    const explicitAttack = await resolveInjectionPoint(projectRoot, "before_execute", {}, {
      text: "skills=huge-skill --skills huge-skill,s-one,s-two,s-three,s-four,s-five",
      stage: "execute",
    });
    assert.ok(explicitAttack.skills.length <= 3);
  }, { init: false });
});
