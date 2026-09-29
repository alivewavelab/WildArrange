// =============================================================================
// 文件名称：runtime-workflow.test.mjs
// 所属模块：test
// 作用说明：
//   workflow 端到端与节点：样例计划、失败摘要、resume 快照、节点独立执行与任务锁。
// =============================================================================

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { runNextTask, runWorkflowNode } from "../src/orchestration/linear-runtime.mjs";
import { runWorkflow } from "../src/orchestration/workflow.mjs";
import { dashboardData, writeWorkflowSummary } from "../src/orchestration/status.mjs";
import { resumeReport } from "../src/ai/context.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { withExternalProject } from "./helpers/external-fixture.mjs";
import { nodeEval, createSmokePlan } from "./helpers/runtime-fixtures.mjs";

test("workflow summary records failed runs with failure evidence", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "summary-fail-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Summary failure",
      tasks: [{
        id: "T001",
        subject: "Fail verifier for summary",
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"process.exit(9)\""],
        review_commands: ["node --version"],
        maxAttempts: 1,
      }],
    }));

    // Preserve the legacy-plan failure-summary regression; public imports now require responsibility approval.
    await importPlan(projectRoot, planPath);
    const result = await runWorkflow(projectRoot);
    assert.equal(result.ok, false);
    assert.equal(path.resolve(projectRoot, result.summaryPath), resolveWildArrangePath(projectRoot, "reports", "workflow-summary.md"));

    const summary = await writeWorkflowSummary(projectRoot, { reason: "test-refresh" });
    assert.equal(summary.ok, false);
    assert.equal(summary.tasks[0].status, "failed");
    const failureReportPath = path.resolve(projectRoot, summary.tasks[0].failureReportPath);
    assert.equal(path.dirname(path.dirname(failureReportPath)), resolveWildArrangePath(projectRoot, "reports", "failures"));
    assert.match(path.basename(path.dirname(failureReportPath)), /^plan_.+/);
    assert.equal(path.basename(failureReportPath), "T001.md");
    const summaryMd = await readFile(resolveWildArrangePath(projectRoot, "reports", "workflow-summary.md"), "utf8");
    assert.match(summaryMd, /ATTENTION_REQUIRED/);
    assert.match(summaryMd, /Failure report:/);
  });
});

test("resume writes durable context snapshot and session lineage", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const samplePath = await createSmokePlan(root);
    await importPlan(projectRoot, samplePath);

    const firstResume = await resumeReport(projectRoot, { sessionId: "codex-session-a", source: "test" });
    assert.equal(firstResume.session.currentSessionId, "codex-session-a");
    assert.equal(path.resolve(projectRoot, firstResume.contextPath), resolveWildArrangePath(projectRoot, "snapshots", "context.md"));
    assert.match(firstResume.nextAction, /run task T001/);

    let contextMd = await readFile(resolveWildArrangePath(projectRoot, "snapshots", "context.md"), "utf8");
    assert.match(contextMd, /WildArrange Resume Context/);
    assert.match(contextMd, /codex-session-a/);
    assert.match(contextMd, /run task T001/);
    assert.match(contextMd, /Checkpoint requires verifier PASS/);

    await runNextTask(projectRoot);
    const secondResume = await resumeReport(projectRoot, { sessionId: "cursor-session-b", source: "test" });
    assert.deepEqual(secondResume.session.sessionIds, ["codex-session-a", "cursor-session-b"]);
    assert.equal(secondResume.nextAction, "no runnable task");

    const lineage = await readJson(resolveWildArrangePath(projectRoot, "sessions", "lineage.json"));
    assert.equal(lineage.currentSessionId, "cursor-session-b");
    assert.deepEqual(lineage.sessionIds, ["codex-session-a", "cursor-session-b"]);

    contextMd = await readFile(resolveWildArrangePath(projectRoot, "snapshots", "context.md"), "utf8");
    assert.match(contextMd, /cursor-session-b/);
    assert.match(contextMd, /no runnable task/);
    assert.match(await readFile(resolveWildArrangePath(projectRoot, "ledger.jsonl"), "utf8"), /session_recorded/);
    assert.match(await readFile(resolveWildArrangePath(projectRoot, "ledger.jsonl"), "utf8"), /resume_reported/);
  });
});

test("workflow nodes execute, verify, scope, review, and checkpoint independently", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "node-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Node workflow",
      tasks: [{
        id: "T001",
        subject: "实现一个简单 CLI 输出",
        description: "在 src/app.js 写入可执行的 hello 输出逻辑",
        writable_paths: ["src/**"],
        worker_command: nodeEval("const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/app.js','console.log(\\\"hello\\\")\\n')"),
        verify_commands: [nodeEval("const fs=require('fs'); if(!fs.readFileSync('src/app.js','utf8').includes('hello')) process.exit(1)")],
        review_commands: [nodeEval("const fs=require('fs');const source=fs.readFileSync('src/app.js','utf8').trim();if(source!=='console.log(\\\"hello\\\")')process.exit(1)")],
      }],
    }));
    await importPlan(projectRoot, planPath);

    const executed = await runWorkflowNode(projectRoot, "execute", { taskId: "T001" });
    assert.equal(executed.status, "executed");
    assert.equal(executed.task.status, "verifying");

    const verified = await runWorkflowNode(projectRoot, "verify", { taskId: "T001" });
    assert.equal(verified.status, "verified");

    const scoped = await runWorkflowNode(projectRoot, "scope", { taskId: "T001" });
    assert.equal(scoped.status, "pass");

    const reviewed = await runWorkflowNode(projectRoot, "review", { taskId: "T001" });
    assert.equal(reviewed.status, "reviewed");
    assert.equal(reviewed.reviewResult.pass, true);

    const checkpointed = await runWorkflowNode(projectRoot, "checkpoint", { taskId: "T001" });
    assert.equal(checkpointed.status, "completed");

    const state = await readJson(resolveWildArrangePath(projectRoot, "team", "tasks.json"));
    assert.equal(state.tasks[0].status, "completed");
    assert.equal(state.tasks[0].route_decision.route, "execute");
    assert.equal((await dashboardData(projectRoot)).status.completed, 1);
  });
});

test("workflow verify node returns failed verification to pending for retry", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "node-verify-fail-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Node verify fail",
      tasks: [{
        id: "T001",
        subject: "Run a verifier that fails once",
        writable_paths: ["src/**"],
        worker_command: nodeEval("process.exit(0);"),
        verify_commands: [nodeEval("process.exit(1);")],
        review_commands: ["node --version"],
      }],
    }));
    await importPlan(projectRoot, planPath);

    await runWorkflowNode(projectRoot, "execute", { taskId: "T001" });
    const verified = await runWorkflowNode(projectRoot, "verify", { taskId: "T001" });
    assert.equal(verified.status, "verify_failed");
    assert.equal(verified.task.status, "pending");
    assert.equal(verified.task.last_failure.nextStatus, "pending");

    const state = await readJson(resolveWildArrangePath(projectRoot, "team", "tasks.json"));
    assert.equal(state.tasks[0].status, "pending");
  });
});

test("workflow node state updates are serialized under the task lock", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "locked-node-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Locked node workflow",
      tasks: [{
        id: "T001",
        subject: "实现一个可验证文件",
        writable_paths: ["src/**"],
        worker_command: nodeEval("const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/app.js','console.log(\\\"locked\\\")\\n')"),
        verify_commands: [nodeEval("const fs=require('fs'); if(!fs.readFileSync('src/app.js','utf8').includes('locked')) process.exit(1)")],
        review_commands: [nodeEval("const fs=require('fs');const source=fs.readFileSync('src/app.js','utf8');if(!source.startsWith('console.log')||!source.includes('locked'))process.exit(1)")],
      }],
    }));
    await importPlan(projectRoot, planPath);

    await runWorkflowNode(projectRoot, "execute", { taskId: "T001" });
    await Promise.all([
      runWorkflowNode(projectRoot, "verify", { taskId: "T001" }),
      runWorkflowNode(projectRoot, "scope", { taskId: "T001" }),
    ]);

    const state = await readJson(resolveWildArrangePath(projectRoot, "team", "tasks.json"));
    const task = state.tasks[0];
    assert.equal(task.status, "verifying");
    assert.equal(task.last_verify_result.pass, true);
    assert.equal(task.last_scope_result.status, "pass");
    assert.ok(task.evidence.some((entry) => entry.kind === "verifier"));
    assert.ok(task.evidence.some((entry) => entry.kind === "scope_guard"));

    const reviewed = await runWorkflowNode(projectRoot, "review", { taskId: "T001" });
    assert.equal(reviewed.status, "reviewed");
    assert.equal(reviewed.reviewResult.pass, true);

    const checkpointed = await runWorkflowNode(projectRoot, "checkpoint", { taskId: "T001" });
    assert.equal(checkpointed.status, "completed");
  });
});
