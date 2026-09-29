// =============================================================================
// 文件名称：runtime-plan-import.test.mjs
// 所属模块：test
// 作用说明：
//   计划导入：依赖图校验、Skill 名安全、路由决策落盘、默认门禁与 no-op 警告。
// =============================================================================

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importPlan, validatePlanGraph } from "../src/orchestration/plan-state.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { withTempDir } from "./helpers/runtime-fixtures.mjs";

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

  assert.throws(() => validatePlanGraph({
    tasks: [
      { id: "T001", repositoryTarget: "governance", blockedBy: [] },
      { id: "T002", repositoryTarget: "project", blockedBy: ["T001"] },
    ],
  }), /another repository.*integration accept/);
});

test("plan import rejects unsafe task Skill names before persisting", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "unsafe-skill-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Unsafe Skill",
      objective: "Reject traversal",
      tasks: [{
        id: "T001",
        subject: "Unsafe binding",
        skills: ["../escape"],
        writable_paths: ["receipt.txt"],
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }, null, 2));

    await assert.rejects(importPlan(dir, planPath), /invalid skill name/);
    assert.equal(await readJson(resolveWildArrangePath(dir, "team", "tasks.json"), null), null);
  });
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
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));

    await assert.rejects(() => importPlan(dir, planPath), /unknown task/);
    const state = await readJson(resolveWildArrangePath(dir, "team", "tasks.json"), null);
    assert.equal(state, null);
  });
});

test("plan import never persists a requested completed status", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "forged-completion-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Forged completion",
      objective: "A plan file claiming its work is already done",
      tasks: [{
        id: "T001",
        subject: "Pretends to be done without any verification",
        status: "completed",
        writable_paths: ["receipt.txt"],
        verify_commands: ["true"],
      }],
    }, null, 2));

    const plan = await importPlan(dir, planPath);
    assert.equal(plan.tasks[0].status, "needs_user_decision");
    const ledger = await readJson(resolveWildArrangePath(dir, "team", "tasks.json"));
    assert.equal(ledger.tasks.length, 1);
    assert.equal(ledger.tasks[0].status, "needs_user_decision");
    assert.equal(ledger.tasks[0].history.at(-1).status, "needs_user_decision");
    const persistedPlan = await readJson(resolveWildArrangePath(dir, "plans", `${plan.id}.json`));
    assert.equal(persistedPlan.tasks[0].status, "needs_user_decision");
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
          writable_paths: ["doc/product/**"],
          worker_command: "node -e \"if(!process.version)process.exit(1)\"",
          verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
          review_commands: ["node --version"],
        },
        {
          id: "T002",
          subject: "实现静态 MVP",
          description: "实现页面和转换逻辑。",
          blockedBy: ["T001"],
          writable_paths: ["index.html", "src/**", "test/**"],
          worker_command: "node -e \"if(!process.version)process.exit(1)\"",
          verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
          review_commands: ["node --version"],
        },
      ],
    }, null, 2));

    await assert.rejects(() => importPlan(dir, planPath), /requires at least 4 tasks/);
    const state = await readJson(resolveWildArrangePath(dir, "team", "tasks.json"), null);
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
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));

    await importPlan(dir, planPath);
    const state = await readJson(resolveWildArrangePath(dir, "team", "tasks.json"));
    const task = state.tasks[0];

    assert.equal(task.category, "visual-engineering");
    assert.equal(task.category_source, "route");
    assert.equal(task.route_decision.domain, "visual");
    assert.ok(task.skills.includes("frontend-ui-ux"));
    assert.ok(task.skills.includes("visual-qa"));

    const ledger = await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8");
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
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));

    await importPlan(dir, planPath);
    const state = await readJson(resolveWildArrangePath(dir, "team", "tasks.json"));
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
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        standards_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        writable_paths: ["src/**"],
        skills: ["project-standard"],
      },
      tasks: [{
        id: "T001",
        subject: "Use inherited gates",
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
      }],
    }));

    await importPlan(dir, planPath);
    const state = await readJson(resolveWildArrangePath(dir, "team", "tasks.json"));
    const task = state.tasks[0];
    assert.deepEqual(task.verify_commands, ["node -e \"if(!process.version)process.exit(1)\""]);
    assert.deepEqual(task.review_commands, ["node -e \"if(!process.version)process.exit(1)\""]);
    assert.deepEqual(task.standards_commands, ["node -e \"if(!process.version)process.exit(1)\""]);
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
        review_commands: ["node --version"],
      }],
    }));

    await importPlan(dir, planPath);
    const state = await readJson(resolveWildArrangePath(dir, "team", "tasks.json"));
    assert.equal(state.tasks[0].governanceWarnings[0].code, "possible_noop_task");
  });
});
