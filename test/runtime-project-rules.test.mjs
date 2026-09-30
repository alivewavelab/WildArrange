// =============================================================================
// 文件名称：runtime-project-rules.test.mjs
// 所属模块：test
// 作用说明：
//   项目规则扫描：AGENTS/Cursor 规则收集、CRLF frontmatter、任务 worktree 与控制根分离。
// =============================================================================

import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildAgentContext } from "../src/ai/context.mjs";
import { scanProjectRules } from "../src/infra/rule-scanner.mjs";
import { resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { withExternalProject, declare, importApprovedPlan } from "./helpers/external-fixture.mjs";

/** 夹具任务可能改动的文件：职责声明覆盖本文件用例写入的全部路径。 */
const SRC_RESPONSIBILITY = declare("src/AGENTS.md", "src/app.js");

test("project rules and agent context collect matching local governance", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    await writeFile(path.join(projectRoot, "AGENTS.md"), "# AGENTS\n\n必须运行真实测试。\n");
    await mkdir(path.join(projectRoot, "src"), { recursive: true });
    await writeFile(path.join(projectRoot, "src", "AGENTS.md"), "# Source Rules\n\nsrc 内修改必须遵守本目录职责。\n");
    await mkdir(path.join(projectRoot, ".cursor", "rules"), { recursive: true });
    await writeFile(path.join(projectRoot, ".cursor", "rules", "frontend.md"), [
      "---",
      "description: Frontend rule",
      "globs: [\"src/**\"]",
      "alwaysApply: false",
      "---",
      "UI 变更必须浏览器验收。",
      "",
    ].join("\n"));
    const planPath = path.join(root, "rules-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Rules context",
      tasks: [{
        id: "T001",
        subject: "Implement src app",
        writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));
    await importApprovedPlan(projectRoot, planPath);

    const rules = await scanProjectRules(projectRoot, { targetPaths: ["src/app.js"] });
    // 3 条项目内规则 + 治理仓 policy/AGENTS.md（外置模式固定存在）。
    assert.equal(rules.total, 4);
    assert.equal(rules.matched, 4);
    assert.equal(rules.governancePolicyRules, 1);
    assert.ok(rules.rules.some((rule) => rule.path === "AGENTS.md"));
    assert.ok(rules.rules.some((rule) => rule.path === "src/AGENTS.md" && rule.source === "directory_agents"));
    assert.ok(rules.rules.some((rule) => rule.path === ".cursor/rules/frontend.md"));
    assert.match(await readFile(resolveWildArrangePath(projectRoot, "rules", "context.md"), "utf8"), /UI 变更必须浏览器验收/);

    const context = await buildAgentContext(projectRoot, { agent: "BaiZe", taskId: "T001" });
    assert.equal(context.agent, "BaiZe");
    assert.equal(context.task.id, "T001");
    assert.equal(context.projectRules.matched, 4);
    assert.match(await readFile(resolveWildArrangePath(projectRoot, "context-agents", "BaiZe-T001.md"), "utf8"), /WildArrange Agent Context/);
  });
});

test("project rules parse CRLF frontmatter", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    await mkdir(path.join(projectRoot, ".cursor", "rules"), { recursive: true });
    await writeFile(
      path.join(projectRoot, ".cursor", "rules", "windows.md"),
      "---\r\ndescription: CRLF rule\r\nglobs: [\"src/**\"]\r\nalwaysApply: false\r\n---\r\nCRLF 正文规则。\r\n",
    );

    const rules = await scanProjectRules(projectRoot, { targetPaths: ["src/app.js"] });
    const rule = rules.rules.find((entry) => entry.path === ".cursor/rules/windows.md");
    assert.ok(rule);
    assert.equal(rule.description, "CRLF rule");
    assert.deepEqual(rule.globs, ["src/**"]);
    assert.equal(rule.alwaysApply, false);
    assert.match(rule.content, /CRLF 正文规则/);
    assert.doesNotMatch(rule.content, /description: CRLF rule/);
  });
});

test("project rules read a task worktree but persist runtime facts to the project's runtime root", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const executionRoot = path.join(projectRoot, "task-worktree");
    await mkdir(path.join(executionRoot, "src"), { recursive: true });
    await writeFile(path.join(executionRoot, "AGENTS.md"), "# Task worktree rules\n\nRun the real verifier.\n");

    const rules = await scanProjectRules(executionRoot, {
      projectRoot,
      targetPaths: ["src/app.js"],
    });
    assert.ok(rules.rules.some((rule) => rule.path === "AGENTS.md" && rule.source !== "governance_policy"));
    assert.match(await readFile(resolveWildArrangePath(projectRoot, "rules", "context.md"), "utf8"), /Run the real verifier/);
    await assert.rejects(stat(path.join(executionRoot, ".wildarrange")), /ENOENT/);
  });
});
