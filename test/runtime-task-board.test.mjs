// =============================================================================
// 文件名称：runtime-task-board.test.mjs
// 所属模块：test
// 作用说明：
//   任务看板：团队收件箱、追加任务、跨计划任务台账、任务 intake 与 claim。
// =============================================================================

import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { runNextTask, runWorkflowNode } from "../src/orchestration/linear-runtime.mjs";
import { claimTeamTask, createTeamTask, getTeamTask, listTeamMessages, listTeamTasks, readyTeamTask, sendTeamMessage } from "../src/orchestration/task-board.mjs";
import { statusReport } from "../src/orchestration/status.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { withTempDir, nodeEval } from "./helpers/runtime-fixtures.mjs";

test("team-lite sends and lists durable inbox messages", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const message = await sendTeamMessage(dir, {
      from: "Jiuwei",
      to: "Jiuwei",
      body: "Continue T001 after verifier passes.",
      summary: "continue T001",
    });
    assert.equal(message.from, "Jiuwei");
    assert.equal(message.to, "Jiuwei");
    assert.equal(message.status, "unread");
    assert.match(message.inboxPath, /^\.wildarrange\/team\/inbox\/Jiuwei\/msg_.+\.json$/);

    const jiuweiInbox = await listTeamMessages(dir, { agent: "Jiuwei" });
    assert.equal(jiuweiInbox.length, 1);
    assert.equal(jiuweiInbox[0].id, message.id);
    assert.equal(jiuweiInbox[0].body, "Continue T001 after verifier passes.");

    const allInbox = await listTeamMessages(dir);
    assert.equal(allInbox.length, 1);
    assert.match(await readFile(resolveWildArrangePath(dir, "team", "messages.md"), "utf8"), /Jiuwei -> Jiuwei: continue T001/);
    assert.match(await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8"), /team_message_sent/);
  });
});

test("team task create appends a routed task and preserves dependency gates", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "append-task-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Append task",
      defaults: {
        verify_commands: [nodeEval("const fs=require('fs');if(!fs.readFileSync('src/task-output.txt','utf8').includes('task'))process.exit(1)")],
        review_commands: [nodeEval("const fs=require('fs');const value=fs.readFileSync('src/task-output.txt','utf8');if(value.trim().split(/\\s+/).length!==2)process.exit(1)")],
        standards_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        writable_paths: ["src/**"],
      },
      tasks: [{
        id: "T001",
        subject: "First task",
        worker_command: nodeEval("const fs=require('fs');fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/task-output.txt','first task')"),
      }],
    }));
    await importPlan(dir, planPath);

    const created = await createTeamTask(dir, {
      id: "T002",
      subject: "实现追加任务按钮",
      description: "新增一个 UI 按钮任务",
      blockedBy: ["T001"],
      worker_command: nodeEval("const fs=require('fs');fs.writeFileSync('src/task-output.txt','second task')"),
    });
    assert.equal(created.task.id, "T002");
    assert.equal(created.task.category, "visual-engineering");
    assert.deepEqual(created.task.verify_commands, [nodeEval("const fs=require('fs');if(!fs.readFileSync('src/task-output.txt','utf8').includes('task'))process.exit(1)")]);
    assert.deepEqual(created.task.standards_commands, ["node -e \"if(!process.version)process.exit(1)\""]);

    const listed = await listTeamTasks(dir, { status: "pending" });
    assert.deepEqual(listed.tasks.map((task) => task.id), ["T001", "T002"]);
    assert.match(await readFile(resolveWildArrangePath(dir, "team", "tasks.md"), "utf8"), /T002\. 实现追加任务按钮/);
    assert.match(await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8"), /team_task_created/);

    const first = await runNextTask(dir);
    assert.equal(first.task.id, "T001");
    const second = await runNextTask(dir);
    assert.equal(second.task.id, "T002");
    const status = await statusReport(dir);
    assert.equal(status.completed, 2);
  });
});

test("task ledger keeps tasks across plans in one canonical file", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    for (const [id, title, subject] of [
      ["plan_alpha", "Alpha", "实现搜索功能"],
      ["plan_beta", "Beta", "修复登录 Bug"],
    ]) {
      const planPath = path.join(dir, `${id}.json`);
      await writeFile(planPath, JSON.stringify({
        id,
        title,
        tasks: [{
          id: "T001",
          subject,
          writable_paths: ["src/**"],
          worker_command: "node -e \"if(!process.version)process.exit(1)\"",
          verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
          review_commands: ["node --version"],
        }],
      }));
      await importPlan(dir, planPath);
    }

    const canonical = await readJson(resolveWildArrangePath(dir, "team", "tasks.json"));
    assert.equal(canonical.kind, "task_ledger");
    assert.equal(canonical.activePlanId, "plan_beta");
    assert.equal(canonical.tasks.length, 2);
    assert.deepEqual(canonical.tasks.map((task) => task.ref).sort(), ["plan_alpha:T001", "plan_beta:T001"]);

    const all = await listTeamTasks(dir, { all: true });
    assert.equal(all.total, 2);
    assert.deepEqual(all.tasks.map((task) => task.workType).sort(), ["bug", "feature"]);
    const active = await listTeamTasks(dir);
    assert.deepEqual(active.tasks.map((task) => task.ref), ["plan_beta:T001"]);
    const bugs = await listTeamTasks(dir, { all: true, workType: "bug" });
    assert.deepEqual(bugs.tasks.map((task) => task.ref), ["plan_beta:T001"]);
  });
});

test("task intake creates a traceable draft before any plan and readies it after validation details", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const created = await createTeamTask(dir, {
      subject: "用户验收后要求修正文案",
      workType: "acceptance_correction",
      priority: "P0",
      source: "user",
      parentTaskRef: "plan_release:T009",
      description: "验收反馈：按钮文案不清楚",
    });
    assert.equal(created.planId, "plan_inbox");
    assert.equal(created.task.status, "draft");
    assert.equal(created.task.ref, "plan_inbox:T001");
    assert.equal(created.task.history[0].event, "created");
    assert.equal((await runNextTask(dir)).status, "blocked");

    await assert.rejects(() => readyTeamTask(dir, {
      taskId: "T001",
      patch: { verify_commands: ["node --version"] },
    }), /writable_paths/);

    const readied = await readyTeamTask(dir, {
      taskId: "T001",
      patch: {
        writable_paths: ["src/**"],
        verify_commands: ["node --version"],
        review_commands: ["node --version"],
      },
    });
    assert.equal(readied.task.status, "pending");
    const canonical = await readJson(resolveWildArrangePath(dir, "team", "tasks.json"));
    const task = canonical.tasks[0];
    assert.equal(task.parentTaskRef, "plan_release:T009");
    assert.ok(task.history.some((entry) => entry.event === "status_changed" && entry.from === "draft" && entry.to === "pending"));
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
          worker_command: nodeEval("const fs=require('fs');fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/claimed.txt','claimed by owner')"),
          verify_commands: [nodeEval("const fs=require('fs');if(fs.readFileSync('src/claimed.txt','utf8')!=='claimed by owner')process.exit(1)")],
          review_commands: [nodeEval("const fs=require('fs');const stat=fs.statSync('src/claimed.txt');if(!stat.isFile()||stat.size!==16)process.exit(1)")],
        },
        {
          id: "T002",
          subject: "Blocked task",
          blockedBy: ["T001"],
          worker_command: "node -e \"if(!process.version)process.exit(1)\"",
          verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
          review_commands: ["node --version"],
        },
      ],
    }));
    await importPlan(dir, planPath);

    await assert.rejects(() => claimTeamTask(dir, { taskId: "T002", owner: "Jiuwei" }), /blocked by T001/);

    const claimed = await claimTeamTask(dir, { taskId: "T001", owner: "Jiuwei" });
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

    const secondClaim = await claimTeamTask(dir, { taskId: "T002", owner: "Jiuwei" });
    assert.equal(secondClaim.task.status, "in_progress");
    assert.match(await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8"), /team_task_claimed/);
  });
});
