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
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { validatePlanGraph } from "../src/orchestration/task-normalize.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { withExternalProject, declare } from "./helpers/external-fixture.mjs";

/** 夹具任务可能改动的文件：职责声明覆盖本文件用例写入的全部路径。 */
const DOC_PRODUCT_RESPONSIBILITY = declare("doc/product/app.js");
/** 夹具任务可能改动的文件：职责声明覆盖本文件用例写入的全部路径。 */
const SRC_RESPONSIBILITY = declare("src/app.js");

/** 夹具任务可能改动的文件：职责声明覆盖本文件用例写入的全部路径。 */
const INDEX_HTML_SRC_TEST_RESPONSIBILITY = declare("index.html");

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
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "unsafe-skill-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Unsafe Skill",
      objective: "Reject traversal",
      tasks: [{
        id: "T001",
        subject: "Unsafe binding",
        skills: ["../escape"],
        writable_paths: ["receipt.txt"],
        responsibilityChanges: declare("receipt.txt"),
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
      }],
    }, null, 2));

    await assert.rejects(importPlan(projectRoot, planPath), /invalid skill name/);
    assert.equal(await readJson(resolveWildArrangePath(projectRoot, "team", "tasks.json"), null), null);
  });
});

test("plan import rejects unknown blockedBy before writing task state", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "bad-dependency-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Bad dependency",
      tasks: [{
        id: "T001",
        subject: "Blocked by missing task",
        writable_paths: ["src/app.js"], responsibilityChanges: declare("src/app.js"),
        blockedBy: ["T999"],
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));

    await assert.rejects(() => importPlan(projectRoot, planPath), /unknown task/);
    const state = await readJson(resolveWildArrangePath(projectRoot, "team", "tasks.json"), null);
    assert.equal(state, null);
  });
});

test("plan import rejects an executable task without responsibilityChanges before writing state", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "undeclared-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Undeclared",
      tasks: [{ id: "T001", subject: "No declaration", writable_paths: ["src/app.js"], verify_commands: ["node -e \"if(!process.version)process.exit(1)\""] }],
    }));
    await assert.rejects(() => importPlan(projectRoot, planPath), /requires responsibilityChanges; a task without them can only stay draft/);
    assert.equal(await readJson(resolveWildArrangePath(projectRoot, "team", "tasks.json"), null), null);
  });
});

test("an empty declaration is only accepted for a task that cannot write files", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "empty-declaration-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Empty declaration",
      tasks: [{ id: "T001", subject: "Writes but declares nothing", writable_paths: ["src/app.js"], responsibilityChanges: [], verify_commands: ["node -e \"if(!process.version)process.exit(1)\""] }],
    }));
    await assert.rejects(() => importPlan(projectRoot, planPath), /must be a non-empty array when the task has writable_paths/);
  });
});

test("the fullstack starter example plan imports as documented", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const plan = await importPlan(projectRoot, path.resolve("examples", "fullstack-starter", "plan.example.json"));
    assert.equal(plan.tasks.length, 2);
    assert.ok(plan.tasks.every((task) => task.responsibilityChanges?.length === 1));
  });
});

test("plan import never persists a requested completed status", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "forged-completion-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Forged completion",
      objective: "A plan file claiming its work is already done",
      tasks: [{
        id: "T001",
        subject: "Pretends to be done without any verification",
        status: "completed",
        writable_paths: ["receipt.txt"],
        responsibilityChanges: declare("receipt.txt"),
        verify_commands: ["true"],
      }],
    }, null, 2));

    const plan = await importPlan(projectRoot, planPath);
    assert.equal(plan.tasks[0].status, "needs_user_decision");
    const ledger = await readJson(resolveWildArrangePath(projectRoot, "team", "tasks.json"));
    assert.equal(ledger.tasks.length, 1);
    assert.equal(ledger.tasks[0].status, "needs_user_decision");
    assert.equal(ledger.tasks[0].history.at(-1).status, "needs_user_decision");
    // plans/<id>.json 只是不含 tasks 的导入快照；任务状态唯一在 team/tasks.json。
    const persistedPlan = await readJson(resolveWildArrangePath(projectRoot, "plans", `${plan.id}.json`));
    assert.equal(persistedPlan.tasks, undefined);
    assert.equal(persistedPlan.title, "Forged completion");
    assert.deepEqual(ledger.plans.find((entry) => entry.id === plan.id).taskIds, ["T001"]);
  });
});

test("plan import rejects high-risk product plans that are under-split", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "lazy-product-plan.json");
    await writeFile(planPath, JSON.stringify({
      id: "plan_content_to_interactive_tools",
      title: "内容转互动工具产品 MVP",
      objective: "用户上传 PDF、TXT、视频后，系统拆结构件、匹配前端工具，并生成带数据的互动工具实例。",
      tasks: [
        {
          id: "T001",
          subject: "写产品 brief 和流程",
          description: "明确产品目标、流程、结构件和互动体验。",
          writable_paths: ["doc/product/**"], responsibilityChanges: DOC_PRODUCT_RESPONSIBILITY,
          worker_command: "node -e \"if(!process.version)process.exit(1)\"",
          verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
          review_commands: ["node --version"],
        },
        {
          id: "T002",
          subject: "实现静态 MVP",
          description: "实现页面和转换逻辑。",
          blockedBy: ["T001"],
          writable_paths: ["index.html", "src/**", "test/**"], responsibilityChanges: INDEX_HTML_SRC_TEST_RESPONSIBILITY,
          worker_command: "node -e \"if(!process.version)process.exit(1)\"",
          verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
          review_commands: ["node --version"],
        },
      ],
    }, null, 2));

    await assert.rejects(() => importPlan(projectRoot, planPath), /requires at least 4 tasks/);
    const state = await readJson(resolveWildArrangePath(projectRoot, "team", "tasks.json"), null);
    assert.equal(state, null);
  });
});

test("plan import persists route decisions and fills missing task category and skills", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "route-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Visual work",
      tasks: [{
        id: "T001",
        subject: "优化页面 CSS 布局",
        description: "调整按钮样式和页面布局",
        writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));

    await importPlan(projectRoot, planPath);
    const state = await readJson(resolveWildArrangePath(projectRoot, "team", "tasks.json"));
    const task = state.tasks[0];

    assert.equal(task.category, "visual-engineering");
    assert.equal(task.category_source, "route");
    assert.equal(task.route_decision.domain, "visual");
    assert.ok(task.skills.includes("frontend-ui-ux"));
    assert.ok(task.skills.includes("visual-qa"));

    const ledger = await readFile(resolveWildArrangePath(projectRoot, "ledger.jsonl"), "utf8");
    assert.match(ledger, /plan_routed/);
  });
});

test("plan import preserves explicit category while recording route decision", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "explicit-category-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Explicit quick work",
      tasks: [{
        id: "T001",
        subject: "单文件小改 README 文案",
        category: "quick",
        writable_paths: ["README.md"],
        responsibilityChanges: declare("README.md"),
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));

    await importPlan(projectRoot, planPath);
    const state = await readJson(resolveWildArrangePath(projectRoot, "team", "tasks.json"));
    const task = state.tasks[0];

    assert.equal(task.category, "quick");
    assert.equal(task.category_source, "explicit");
    assert.equal(task.route_decision.domain, "writing");
    assert.ok(task.skills.includes("remove-ai-slops"));
  });
});

test("plan import applies default gates and scope to every task", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "defaults-plan.json");
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
        responsibilityChanges: SRC_RESPONSIBILITY,
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
      }],
    }));

    await importPlan(projectRoot, planPath);
    const state = await readJson(resolveWildArrangePath(projectRoot, "team", "tasks.json"));
    const task = state.tasks[0];
    assert.deepEqual(task.verify_commands, ["node -e \"if(!process.version)process.exit(1)\""]);
    assert.deepEqual(task.review_commands, ["node -e \"if(!process.version)process.exit(1)\""]);
    assert.deepEqual(task.standards_commands, ["node -e \"if(!process.version)process.exit(1)\""]);
    assert.deepEqual(task.writable_paths, ["src/**"]);
    assert.ok(task.skills.includes("project-standard"));
  });
});

test("plan import warns about possible no-op tasks", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "noop-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "No-op warning",
      tasks: [{
        id: "T001",
        subject: "Suspicious task",
        responsibilityChanges: declare(),
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
        review_commands: ["node --version"],
      }],
    }));

    await importPlan(projectRoot, planPath);
    const state = await readJson(resolveWildArrangePath(projectRoot, "team", "tasks.json"));
    assert.equal(state.tasks[0].governanceWarnings[0].code, "possible_noop_task");
  });
});
