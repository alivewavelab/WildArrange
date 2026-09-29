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
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { buildAgentContext } from "../src/ai/context.mjs";
import { scanProjectRules } from "../src/infra/rule-scanner.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { withTempDir } from "./helpers/runtime-fixtures.mjs";

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
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));
    await importPlan(dir, planPath);

    const rules = await scanProjectRules(dir, { targetPaths: ["src/app.js"] });
    assert.equal(rules.total, 3);
    assert.equal(rules.matched, 3);
    assert.ok(rules.rules.some((rule) => rule.path === "AGENTS.md"));
    assert.ok(rules.rules.some((rule) => rule.path === "src/AGENTS.md" && rule.source === "directory_agents"));
    assert.ok(rules.rules.some((rule) => rule.path === ".cursor/rules/frontend.md"));
    assert.match(await readFile(resolveWildArrangePath(dir, "rules", "context.md"), "utf8"), /UI 变更必须浏览器验收/);

    const context = await buildAgentContext(dir, { agent: "BaiZe", taskId: "T001" });
    assert.equal(context.agent, "BaiZe");
    assert.equal(context.task.id, "T001");
    assert.equal(context.projectRules.matched, 3);
    assert.match(await readFile(resolveWildArrangePath(dir, "context-agents", "BaiZe-T001.md"), "utf8"), /WildArrange Agent Context/);
  });
});

test("project rules parse CRLF frontmatter", async () => {
  await withTempDir(async (dir) => {
    await mkdir(path.join(dir, ".cursor", "rules"), { recursive: true });
    await writeFile(
      path.join(dir, ".cursor", "rules", "windows.md"),
      "---\r\ndescription: CRLF rule\r\nglobs: [\"src/**\"]\r\nalwaysApply: false\r\n---\r\nCRLF 正文规则。\r\n",
    );
    await initRuntime(dir);

    const rules = await scanProjectRules(dir, { targetPaths: ["src/app.js"] });
    const rule = rules.rules.find((entry) => entry.path === ".cursor/rules/windows.md");
    assert.ok(rule);
    assert.equal(rule.description, "CRLF rule");
    assert.deepEqual(rule.globs, ["src/**"]);
    assert.equal(rule.alwaysApply, false);
    assert.match(rule.content, /CRLF 正文规则/);
    assert.doesNotMatch(rule.content, /description: CRLF rule/);
  });
});

test("project rules read a task worktree but persist runtime facts to the control root", async () => {
  await withTempDir(async (dir) => {
    const controlRoot = path.join(dir, "control");
    const executionRoot = path.join(dir, "task-worktree");
    await mkdir(controlRoot, { recursive: true });
    await mkdir(path.join(executionRoot, "src"), { recursive: true });
    await writeFile(path.join(executionRoot, "AGENTS.md"), "# Task worktree rules\n\nRun the real verifier.\n");
    await initRuntime(controlRoot);

    const rules = await scanProjectRules(executionRoot, {
      controlRoot,
      targetPaths: ["src/app.js"],
    });
    assert.equal(rules.matched, 1);
    assert.equal(rules.rules[0].path, "AGENTS.md");
    assert.match(await readFile(resolveWildArrangePath(controlRoot, "rules", "context.md"), "utf8"), /Run the real verifier/);
    await assert.rejects(stat(path.join(executionRoot, ".wildarrange")), /ENOENT/);
  });
});
