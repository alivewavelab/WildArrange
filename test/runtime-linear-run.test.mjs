// =============================================================================
// 文件名称：runtime-linear-run.test.mjs
// 所属模块：test
// 作用说明：
//   线性执行闭环：worker、verifier、checkpoint、依赖顺序、重试与 no-op 验收拒绝。
// =============================================================================

import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { installAdapter } from "../src/interface/adapters.mjs";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { runNextTask, runWorkflowNode } from "../src/orchestration/linear-runtime.mjs";
import { createSamplePlan } from "../src/orchestration/workflow.mjs";
import { statusReport } from "../src/orchestration/status.mjs";
import { continuationDirective } from "../src/ai/context.mjs";
import { runCommand } from "../src/infra/command-runner.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { withTempDir, nodeEval } from "./helpers/runtime-fixtures.mjs";

test("continuation directive reports runnable work across sessions", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const adapter = await installAdapter(dir, { target: "codex", mode: "npx", packageName: "wildarrange" });
    const samplePath = await createSamplePlan(dir);
    await importPlan(dir, samplePath);
    const directive = await continuationDirective(dir, { sessionId: "codex-a", source: "test" });
    assert.equal(directive.shouldContinue, true);
    assert.equal(directive.reason, "runnable_task");
    assert.equal(directive.nextCommand, `${adapter.cliPrefix} run`);
    assert.match(await readFile(resolveWildArrangePath(dir, "sessions", "continuation.md"), "utf8"), /Should continue: yes/);
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

    const artifact = await readFile(path.join(dir, ".wildarrange", "artifacts", "linear-smoke.txt"), "utf8");
    assert.equal(artifact.trim(), "ok");

    const checkpoint = await readJson(resolveWildArrangePath(dir, "checkpoints", plan.id, "T001.json"));
    assert.equal(checkpoint.taskId, "T001");
    assert.equal(checkpoint.scopeResult.status, "pass");
    assert.equal(checkpoint.reviewResult.pass, true);

    const acceptanceProof = await readJson(resolveWildArrangePath(dir, "reports", "acceptance", plan.id, "T001.json"));
    assert.equal(acceptanceProof.pass, true);
    assert.ok(acceptanceProof.checks.every((check) => check.status === "pass"));

    const reviewReport = await readJson(resolveWildArrangePath(dir, "reports", "reviews", plan.id, "T001.json"));
    assert.equal(reviewReport.status, "pass");
    assert.ok(reviewReport.lanes.some((lane) => lane.name === "goal_compliance"));

    const ledger = await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8");
    assert.match(ledger, /task_verified/);
    assert.match(ledger, /review_gate_completed/);
    assert.match(ledger, /snapshot_written/);
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
          worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('.wildarrange/artifacts',{recursive:true}); fs.writeFileSync('.wildarrange/artifacts/first.txt','first')\"",
          verify_commands: ["node -e \"const fs=require('fs'); if(fs.readFileSync('.wildarrange/artifacts/first.txt','utf8')!=='first') process.exit(1)\""],
          review_commands: [nodeEval("const fs=require('fs');const stat=fs.statSync('.wildarrange/artifacts/first.txt');if(!stat.isFile()||stat.size!==5)process.exit(1)")],
        },
        {
          id: "T002",
          subject: "Write second artifact after first",
          blockedBy: ["T001"],
          worker_command: "node -e \"const fs=require('fs'); fs.writeFileSync('.wildarrange/artifacts/second.txt',fs.readFileSync('.wildarrange/artifacts/first.txt','utf8')+'+second')\"",
          verify_commands: ["node -e \"const fs=require('fs'); if(fs.readFileSync('.wildarrange/artifacts/second.txt','utf8')!=='first+second') process.exit(1)\""],
          review_commands: [nodeEval("const fs=require('fs');const value=fs.readFileSync('.wildarrange/artifacts/second.txt','utf8');if(!value.startsWith('first+')||value.split('+').length!==2)process.exit(1)")],
        },
      ],
    }));
    await importPlan(dir, planPath);

    const first = await runNextTask(dir);
    assert.equal(first.status, "completed");
    assert.equal(first.task.id, "T001");
    let state = await readJson(resolveWildArrangePath(dir, "team", "tasks.json"));
    assert.equal(state.tasks[1].status, "pending");

    const second = await runNextTask(dir);
    assert.equal(second.status, "completed");
    assert.equal(second.task.id, "T002");
    state = await readJson(resolveWildArrangePath(dir, "team", "tasks.json"));
    assert.equal(state.tasks[0].status, "completed");
    assert.equal(state.tasks[1].status, "completed");
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
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"process.exit(2)\""],
        review_commands: ["node --version"],
        maxAttempts: 2,
      }],
    }));
    await importPlan(dir, planPath);

    const first = await runNextTask(dir);
    assert.equal(first.status, "retry");
    let state = await readJson(resolveWildArrangePath(dir, "team", "tasks.json"));
    assert.equal(state.tasks[0].status, "pending");

    const second = await runNextTask(dir);
    assert.equal(second.status, "failed");
    state = await readJson(resolveWildArrangePath(dir, "team", "tasks.json"));
    assert.equal(state.tasks[0].status, "failed");
    assert.equal(state.tasks[0].last_failure.reason, "verifier_failed");
    assert.match(state.tasks[0].last_failure.retryHint, /FAILED:/);
    assert.match(state.tasks[0].last_failure.retryHint, /DO NOT: 不要降低或删除 verify_commands/);

    const reportMd = await readFile(resolveWildArrangePath(dir, "reports", "failures", state.planId, "T001.md"), "utf8");
    assert.match(reportMd, /# Task Failure/);
    assert.match(reportMd, /verifier_failed/);

    const retry = await runWorkflowNode(dir, "retry", { taskId: "T001" });
    assert.equal(retry.status, "pending");
    state = await readJson(resolveWildArrangePath(dir, "team", "tasks.json"));
    assert.equal(state.tasks[0].status, "pending");
    assert.equal(state.tasks[0].manual_retry_count, 1);
    assert.equal(state.tasks[0].maxAttempts, 3);
  });
});

test("acceptance proof rejects no-op tasks with trivial worker and verifier", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "noop-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Noop guard",
      tasks: [{
        id: "T001",
        subject: "看似完成实则什么都没做",
        worker_command: "node -e \"process.exit(0)\"",
        verify_commands: ["node -e \"process.exit(0)\""],
        review_commands: [nodeEval("const fs=require('fs');const state=JSON.parse(fs.readFileSync('.wildarrange/team/tasks.json','utf8'));const task=state.tasks.find((entry)=>entry.id==='T001');if(fs.existsSync('src')||!task||!task.worker_command.includes('process.exit(0)'))process.exit(1)")],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.notEqual(result.task.status, "completed");
    assert.equal(result.task.last_failure.reason, "acceptance_proof_failed");
    assert.ok(result.acceptanceProof.checks.some((check) => check.name === "not_noop_task" && check.status === "fail"));
  });
});

test("worker execution records a pre-execute workspace snapshot in a git repo", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    for (const command of [
      "git init",
      "git config user.email wildarrange@test.local",
      "git config user.name wildarrange-test",
      "git add -A",
      "git commit -m init --no-gpg-sign",
    ]) {
      const result = await runCommand(command, dir);
      assert.equal(result.exitCode, 0, `${command}: ${result.stderr}`);
    }

    const planPath = path.join(dir, "snapshot-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Snapshot before execute",
      tasks: [{
        id: "T001",
        subject: "写一个工件文件",
        writable_paths: [".wildarrange/artifacts/**", "src/**"],
        worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/out.txt','snapshot')\"",
        verify_commands: ["node -e \"const fs=require('fs'); process.exit(fs.readFileSync('src/out.txt','utf8')==='snapshot'?0:1)\""],
        review_commands: [nodeEval("const fs=require('fs');const stat=fs.statSync('src/out.txt');if(!stat.isFile()||stat.size!==8)process.exit(1)")],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    const result = await runNextTask(dir);
    assert.equal(result.status, "completed");
    const snapshotEvidence = result.task.evidence.find((entry) => entry.kind === "workspace_snapshot");
    assert.ok(snapshotEvidence);
    assert.equal(snapshotEvidence.available, true);
    assert.ok(snapshotEvidence.headCommit);
    assert.match(await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8"), /pre_execute_snapshot/);
  });
});

test("linear command workers reject read-only long-lived task owners", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "read-only-worker-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Read-only owner must not execute",
      tasks: [{
        id: "T001",
        subject: "Do not run this command",
        owner: "BaiZe",
        writable_paths: ["src/forbidden.js"],
        worker_command: "node -e \"const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/forbidden.js','x')\"",
        verify_commands: ["node --version"],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    await assert.rejects(() => runNextTask(dir), /agent BaiZe is read-only and cannot enter a command worker/);
    await assert.rejects(() => runWorkflowNode(dir, "execute", { taskId: "T001" }), /agent BaiZe is read-only and cannot enter a command worker/);
    await assert.rejects(readFile(path.join(dir, "src", "forbidden.js"), "utf8"), /ENOENT/);
  });
});
