// =============================================================================
// 文件名称：runtime-simulation.test.mjs
// 所属模块：test
// 作用说明：
//   端到端模拟：从零新项目与已有项目大功能，串联路由、计划、门禁与摘要。
// =============================================================================

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runNextTask } from "../src/orchestration/linear-runtime.mjs";
import { statusReport, writeWorkflowSummary } from "../src/orchestration/status.mjs";
import { resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { withExternalProject, declare, importApprovedPlan } from "./helpers/external-fixture.mjs";
import { nodeEval, routeRequest } from "./helpers/runtime-fixtures.mjs";

/** 夹具任务可能改动的文件：职责声明覆盖本文件用例写入的全部路径。 */
const DOC_PRODUCT_DOC_PLANS_RESPONSIBILITY = declare("doc/plans/reminder-groups/tasks.md", "doc/plans/reminders/tasks.md", "doc/product/reminders/brief.md", "doc/product/reminders/design.md");
/** 夹具任务可能改动的文件：职责声明覆盖本文件用例写入的全部路径。 */
const INDEX_HTML_PACKAGE_JSON_SRC_RESPONSIBILITY = declare("index.html", "package.json", "src/app.cjs", "src/app.js", "src/app.test.js");
/** 夹具任务可能改动的文件：职责声明覆盖本文件用例写入的全部路径。 */
const ARTIFACTS_RESPONSIBILITY = declare("artifacts/reminder-groups-qa.md", "artifacts/reminders-qa.md");
/** 夹具任务可能改动的文件：职责声明覆盖本文件用例写入的全部路径。 */
const DOC_REPORTS_RESPONSIBILITY = declare("doc/reports/reminder-groups-summary.md", "doc/reports/reminders-summary.md");
/** 夹具任务可能改动的文件：职责声明覆盖本文件用例写入的全部路径。 */
const DOC_PLANS_RESPONSIBILITY = declare("doc/plans/reminder-groups/tasks.md", "doc/plans/reminders/tasks.md");
/** 夹具任务可能改动的文件：职责声明覆盖本文件用例写入的全部路径。 */
const SRC_TEST_RESPONSIBILITY = declare("src/app.cjs", "src/app.js", "src/app.test.js", "test/app.test.cjs");

test("simulation greenfield project runs from product planning to completed web app", async () => {
  await withExternalProject(async ({ projectRoot, root, governanceRoot }) => {

    const route = await routeRequest(projectRoot, {
      text: "从零做一个网页版提醒事项 App，一期 MVP 要有清单流程、空状态、验收标准和失败恢复。",
    });
    assert.equal(route.route, "plan");
    assert.ok(route.planSkills.some((skill) => skill.name === "review-product-intent"));
    assert.ok(route.planSkills.some((skill) => skill.name === "map-user-journey"));
    assert.ok(route.planSkills.some((skill) => skill.name === "design-acceptance"));
    assert.ok(route.planSkills.some((skill) => skill.name === "review-ux-interaction"));

    const planPath = path.join(root, "greenfield-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Greenfield reminders web app",
      objective: "从产品澄清到可验证 Web 提醒事项 App 完成闭环。",
      tasks: [
        {
          id: "T001",
          subject: "产出提醒事项产品 brief、设计和计划",
          description: "澄清目标、用户旅程、空状态、失败恢复和验收口径。",
          writable_paths: ["doc/product/**", "doc/plans/**"], responsibilityChanges: DOC_PRODUCT_DOC_PLANS_RESPONSIBILITY,
          worker_command: nodeEval(`
            const fs = require("fs");
            fs.mkdirSync("doc/product/reminders", { recursive: true });
            fs.mkdirSync("doc/plans/reminders", { recursive: true });
            fs.writeFileSync("doc/product/reminders/brief.md", [
              "# Reminders Brief",
              "REQ-REMINDER-001 SHALL let users add reminders.",
              "REQ-REMINDER-002 MUST show an empty state before any reminder exists.",
              "Given an empty list When the page opens Then empty guidance is visible.",
              "Given invalid text When adding Then the app keeps the user in flow."
            ].join("\\n"));
            fs.writeFileSync("doc/product/reminders/design.md", [
              "# Reminders Design",
              "Slots: header, input, add button, list, empty state, error feedback.",
              "States: loading, empty, success, error, repeated-use."
            ].join("\\n"));
            fs.writeFileSync("doc/plans/reminders/tasks.md", [
              "# Reminders Tasks",
              "T002 implements the app with verifier evidence."
            ].join("\\n"));
          `),
          verify_commands: [
            nodeEval(`
              const fs = require("fs");
              const brief = fs.readFileSync("doc/product/reminders/brief.md", "utf8");
              const design = fs.readFileSync("doc/product/reminders/design.md", "utf8");
              if (!brief.includes("REQ-REMINDER-001") || !brief.includes("Given an empty list")) process.exit(1);
              if (!design.includes("empty state") || !design.includes("error feedback")) process.exit(1);
            `),
          ],
          review_commands: [nodeEval("const fs=require('fs');const brief=fs.readFileSync('doc/product/reminders/brief.md','utf8');const tasks=fs.readFileSync('doc/plans/reminders/tasks.md','utf8');if(!brief.includes('MUST show an empty state')||!tasks.includes('T002 implements'))process.exit(1)")],
        },
        {
          id: "T002",
          subject: "实现网页版提醒事项 App",
          description: "根据 T001 的 brief/design 生成可打开的 HTML 与 JS。",
          blockedBy: ["T001"],
          writable_paths: ["index.html", "package.json", "src/**"], responsibilityChanges: INDEX_HTML_PACKAGE_JSON_SRC_RESPONSIBILITY,
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
          review_commands: [nodeEval("const fs=require('fs');const html=fs.readFileSync('index.html','utf8');const app=fs.readFileSync('src/app.js','utf8');if(!html.includes('id=\\\"empty\\\"')||!app.includes('module.exports = { addReminder }'))process.exit(1)")],
        },
        {
          id: "T003",
          subject: "验收提醒事项 App 的核心体验",
          description: "验证空状态、添加流程、错误反馈和测试证据都存在。",
          blockedBy: ["T002"],
          writable_paths: ["artifacts/**"], responsibilityChanges: ARTIFACTS_RESPONSIBILITY,
          worker_command: nodeEval(`
            const fs = require("fs");
            fs.mkdirSync("artifacts", { recursive: true });
            const html = fs.readFileSync("index.html", "utf8");
            const app = fs.readFileSync("src/app.js", "utf8");
            const test = fs.readFileSync("src/app.test.js", "utf8");
            const report = [
              "# QA Report",
              html.includes("还没有提醒事项") ? "PASS empty state" : "FAIL empty state",
              app.includes("请输入提醒事项") ? "PASS error feedback" : "FAIL error feedback",
              test.includes("交付方案") ? "PASS add flow" : "FAIL add flow"
            ].join("\\n");
            fs.writeFileSync("artifacts/reminders-qa.md", report);
          `),
          verify_commands: [
            nodeEval(`
              const fs = require("fs");
              const report = fs.readFileSync("artifacts/reminders-qa.md", "utf8");
              if (report.includes("FAIL") || !report.includes("PASS empty state")) process.exit(1);
            `),
          ],
          review_commands: [nodeEval("const fs=require('fs');const lines=fs.readFileSync('artifacts/reminders-qa.md','utf8').split(/\\r?\\n/);if(lines.filter((line)=>line.startsWith('PASS ')).length!==3||lines.some((line)=>line.startsWith('FAIL ')))process.exit(1)")],
        },
        {
          id: "T004",
          subject: "复核提醒事项 App 完成证据",
          description: "生成最终完成摘要，证明计划、实现和验收链路闭合。",
          blockedBy: ["T003"],
          writable_paths: ["doc/reports/**"], responsibilityChanges: DOC_REPORTS_RESPONSIBILITY,
          worker_command: nodeEval(`
            const fs = require("fs");
            fs.mkdirSync("doc/reports", { recursive: true });
            fs.writeFileSync("doc/reports/reminders-summary.md", [
              "# Reminders Completion Summary",
              "Brief, implementation, tests, and QA report are complete.",
              "No direct coding happened before plan import."
            ].join("\\n"));
          `),
          verify_commands: [
            nodeEval(`
              const fs = require("fs");
              const summary = fs.readFileSync("doc/reports/reminders-summary.md", "utf8");
              if (!summary.includes("Brief") || !summary.includes("QA report")) process.exit(1);
            `),
          ],
          review_commands: [nodeEval("const fs=require('fs');const summary=fs.readFileSync('doc/reports/reminders-summary.md','utf8');if(!summary.includes('No direct coding')||!fs.existsSync('artifacts/reminders-qa.md'))process.exit(1)")],
        },
      ],
    }, null, 2));

    await importApprovedPlan(projectRoot, planPath);
    const first = await runNextTask(projectRoot);
    assert.equal(first.status, "completed");
    const second = await runNextTask(projectRoot);
    assert.equal(second.status, "completed", JSON.stringify(second.task?.last_failure?.observed || second.readiness?.issues || second.status));
    const third = await runNextTask(projectRoot);
    assert.equal(third.status, "completed");
    const fourth = await runNextTask(projectRoot);
    assert.equal(fourth.status, "completed");

    const status = await statusReport(projectRoot);
    assert.equal(status.total, 4);
    assert.equal(status.completed, 4);
    assert.match(await readFile(path.join(fourth.task.delivery_workspace.workDir, "index.html"), "utf8"), /提醒事项/);
    assert.match(await readFile(resolveWildArrangePath(projectRoot, "reports", "workflow-summary.md"), "utf8"), /Status: PASS/);
  }, { projectFiles: { "AGENTS.md": "# Project Rules\n\nUser-visible web work needs verifier evidence.\n" } });
});

test("simulation existing project handles large feature addition through planning and gates", async () => {
  await withExternalProject(async ({ projectRoot, root, governanceRoot }) => {

    const route = await routeRequest(projectRoot, {
      text: "已有项目新增一个提醒分组大功能，要处理权限、状态流程、回归验收和范围取舍。",
    });
    assert.equal(route.route, "plan");
    assert.ok(route.planSkills.some((skill) => skill.name === "map-user-journey"));
    assert.ok(route.planSkills.some((skill) => skill.name === "design-acceptance"));
    assert.ok(route.planSkills.some((skill) => skill.name === "review-scope-tradeoff"));

    const planPath = path.join(root, "existing-feature-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Existing project reminder groups",
      objective: "在已有项目里新增提醒分组能力，并保留既有列表行为。",
      tasks: [
        {
          id: "T001",
          subject: "补充分组功能计划证据",
          description: "记录用户旅程、范围取舍和验收标准。",
          writable_paths: ["doc/plans/**"], responsibilityChanges: DOC_PLANS_RESPONSIBILITY,
          worker_command: nodeEval(`
            const fs = require("fs");
            fs.mkdirSync("doc/plans/reminder-groups", { recursive: true });
            fs.writeFileSync("doc/plans/reminder-groups/tasks.md", [
              "# Reminder Groups Plan",
              "IN: create group, assign reminder, preserve existing listItems behavior.",
              "OUT: sharing permissions and cloud sync are deferred.",
              "Acceptance: regression test listItems and new group behavior."
            ].join("\\n"));
          `),
          verify_commands: [
            nodeEval(`
              const fs = require("fs");
              const plan = fs.readFileSync("doc/plans/reminder-groups/tasks.md", "utf8");
              if (!plan.includes("OUT: sharing permissions") || !plan.includes("regression test")) process.exit(1);
            `),
          ],
          review_commands: [nodeEval("const fs=require('fs');const plan=fs.readFileSync('doc/plans/reminder-groups/tasks.md','utf8');if(!plan.includes('IN: create group')||!plan.includes('OUT: sharing permissions'))process.exit(1)")],
        },
        {
          id: "T002",
          subject: "实现提醒分组并保留回归行为",
          description: "新增 groupReminder，同时保持 listItems 不变。",
          blockedBy: ["T001"],
          writable_paths: ["src/**", "test/**"], responsibilityChanges: SRC_TEST_RESPONSIBILITY,
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
          review_commands: [nodeEval("const fs=require('fs');const source=fs.readFileSync('src/app.cjs','utf8');const tests=fs.readFileSync('test/app.test.cjs','utf8');if(!source.includes('function groupReminder')||!tests.includes('listItems'))process.exit(1)")],
        },
        {
          id: "T003",
          subject: "验收提醒分组的回归和边界证据",
          description: "验证既有 listItems 回归、新增 groupReminder happy path 和错误路径。",
          blockedBy: ["T002"],
          writable_paths: ["artifacts/**"], responsibilityChanges: ARTIFACTS_RESPONSIBILITY,
          worker_command: nodeEval(`
            const fs = require("fs");
            fs.mkdirSync("artifacts", { recursive: true });
            const source = fs.readFileSync("src/app.cjs", "utf8");
            const tests = fs.readFileSync("test/app.test.cjs", "utf8");
            fs.writeFileSync("artifacts/reminder-groups-qa.md", [
              "# Reminder Groups QA",
              source.includes("listItems") ? "PASS existing behavior" : "FAIL existing behavior",
              source.includes("groupReminder") ? "PASS new behavior" : "FAIL new behavior",
              tests.includes("invalid.error") ? "PASS error path" : "FAIL error path"
            ].join("\\n"));
          `),
          verify_commands: [
            nodeEval(`
              const fs = require("fs");
              const report = fs.readFileSync("artifacts/reminder-groups-qa.md", "utf8");
              if (report.includes("FAIL") || !report.includes("PASS existing behavior")) process.exit(1);
            `),
          ],
          review_commands: [nodeEval("const fs=require('fs');const report=fs.readFileSync('artifacts/reminder-groups-qa.md','utf8');if((report.match(/PASS /g)||[]).length!==3||report.includes('FAIL '))process.exit(1)")],
        },
        {
          id: "T004",
          subject: "复核提醒分组范围取舍和交付摘要",
          description: "记录范围取舍、回归证据和交付状态。",
          blockedBy: ["T003"],
          writable_paths: ["doc/reports/**"], responsibilityChanges: DOC_REPORTS_RESPONSIBILITY,
          worker_command: nodeEval(`
            const fs = require("fs");
            fs.mkdirSync("doc/reports", { recursive: true });
            fs.writeFileSync("doc/reports/reminder-groups-summary.md", [
              "# Reminder Groups Completion Summary",
              "IN scope group creation and assignment are complete.",
              "Existing listItems regression evidence is preserved.",
              "OUT scope sharing permissions and cloud sync remain deferred."
            ].join("\\n"));
          `),
          verify_commands: [
            nodeEval(`
              const fs = require("fs");
              const summary = fs.readFileSync("doc/reports/reminder-groups-summary.md", "utf8");
              if (!summary.includes("regression evidence") || !summary.includes("OUT scope")) process.exit(1);
            `),
          ],
          review_commands: [nodeEval("const fs=require('fs');const summary=fs.readFileSync('doc/reports/reminder-groups-summary.md','utf8');if(!summary.includes('IN scope')||!summary.includes('OUT scope'))process.exit(1)")],
        },
      ],
    }, null, 2));

    await importApprovedPlan(projectRoot, planPath);
    assert.equal((await runNextTask(projectRoot)).status, "completed");
    const implemented = await runNextTask(projectRoot);
    assert.equal(implemented.status, "completed");
    assert.equal(implemented.scopeResult.status, "pass");
    assert.equal(implemented.reviewResult.pass, true);
    assert.equal((await runNextTask(projectRoot)).status, "completed");
    assert.equal((await runNextTask(projectRoot)).status, "completed");

    await writeWorkflowSummary(projectRoot, { reason: "existing_feature_simulation" });
    const status = await statusReport(projectRoot);
    assert.equal(status.completed, 4);
    assert.match(await readFile(path.join(implemented.task.delivery_workspace.workDir, "src", "app.cjs"), "utf8"), /groupReminder/);
    assert.match(await readFile(resolveWildArrangePath(projectRoot, "reports", "workflow-summary.md"), "utf8"), /Status: PASS/);
  }, {
    projectFiles: {
      "AGENTS.md": "# Existing Project Rules\n\nLarge features require scope and regression evidence.\n",
      "src/app.cjs": "function listItems(items) { return items; }\nmodule.exports = { listItems };\n",
      "test/app.test.cjs": "const { listItems } = require('../src/app.cjs');\nif (listItems([1]).length !== 1) process.exit(1);\n",
    },
  });
});
