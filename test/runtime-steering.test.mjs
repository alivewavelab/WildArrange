// =============================================================================
// 文件名称：runtime-steering.test.mjs
// 所属模块：test
// 作用说明：
//   成功标准证据、steering 提案、review blocker 与 attention 报告。
// =============================================================================

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runNextTask, runWorkflowNode } from "../src/orchestration/linear-runtime.mjs";
import { approvePlan } from "../src/orchestration/plan-state.mjs";
import { recordTaskEvidence } from "../src/orchestration/task-board.mjs";
import { recordReviewBlocker, resolveReviewBlocker } from "../src/orchestration/review-blocker.mjs";
import { steerWorkflow } from "../src/orchestration/plan-steering.mjs";
import { attentionReport, dashboardData, statusReport } from "../src/orchestration/status.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { withExternalProject, declare, importApprovedPlan } from "./helpers/external-fixture.mjs";
import { nodeEval } from "./helpers/runtime-fixtures.mjs";

/** 夹具任务可能改动的文件：职责声明覆盖本文件用例写入的全部路径。 */
const SRC_RESPONSIBILITY = declare("src/blocker-resolution.txt", "src/bound-criteria.txt", "src/manual-criteria.txt", "src/mark-blocked.txt");

test("success criteria evidence is recorded and required by checkpoint", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "criteria-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Criteria evidence",
      tasks: [{
        id: "T001",
        subject: "Require manual criteria",
        writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
        worker_command: nodeEval("const fs=require('fs');fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/manual-criteria.txt','manual proof captured\\n')"),
        verify_commands: [nodeEval("const fs=require('fs');if(fs.readFileSync('src/manual-criteria.txt','utf8').trim()!=='manual proof captured')process.exit(1)")],
        review_commands: [nodeEval("const fs=require('fs');const lines=fs.readFileSync('src/manual-criteria.txt','utf8').trim().split(/\\r?\\n/);if(lines.length!==1||!lines[0].startsWith('manual proof'))process.exit(1)")],
        successCriteria: [
          { id: "C001", title: "Manual criterion", status: "pending", expectedEvidence: "manual proof" },
        ],
      }],
    }));
    await importApprovedPlan(projectRoot, planPath);

    const recorded = await recordTaskEvidence(projectRoot, {
      taskId: "T001",
      criterionId: "C001",
      status: "pass",
      evidence: "Manual proof captured before execution.",
    });
    assert.equal(recorded.criterion.status, "pass");

    const result = await runNextTask(projectRoot);
    assert.equal(result.status, "completed", JSON.stringify(result, null, 2));
    assert.equal(result.task.successCriteria[0].status, "pass");
  });
});

test("unbound success criteria are not auto-passed by verifier", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "criteria-unbound-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Unbound criteria evidence",
      tasks: [{
        id: "T001",
        subject: "Do not auto-pass manual criterion",
        writable_paths: ["src/app.js"], responsibilityChanges: declare("src/app.js"),
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
        successCriteria: [
          { id: "C001", title: "Manual criterion", status: "pending", expectedEvidence: "manual proof" },
        ],
      }],
    }));
    await importApprovedPlan(projectRoot, planPath);

    const result = await runNextTask(projectRoot);
    assert.equal(result.status, "failed");
    assert.equal(result.task.successCriteria[0].status, "pending");
    assert.equal(result.task.last_failure.reason, "criteria_failed");
  });
});

test("success criteria can be auto-passed only with explicit verifier command refs", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const verifyCommand = nodeEval("const fs=require('fs');if(fs.readFileSync('src/bound-criteria.txt','utf8')!=='bound criterion')process.exit(1)");
    const planPath = path.join(root, "criteria-bound-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Bound criteria evidence",
      tasks: [{
        id: "T001",
        subject: "Auto-pass bound criterion",
        writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
        worker_command: nodeEval("const fs=require('fs');fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/bound-criteria.txt','bound criterion')"),
        verify_commands: [verifyCommand],
        review_commands: [nodeEval("const fs=require('fs');const stat=fs.statSync('src/bound-criteria.txt');if(!stat.isFile()||stat.size!==15)process.exit(1)")],
        successCriteria: [
          { id: "C001", title: "Bound criterion", status: "pending", verifierCommandRefs: [0] },
        ],
      }],
    }));
    await importApprovedPlan(projectRoot, planPath);

    const result = await runNextTask(projectRoot);
    assert.equal(result.status, "completed");
    assert.equal(result.task.successCriteria[0].status, "pass");
    assert.match(result.task.successCriteria[0].evidence[0].evidence, /explicitly bound/);
  });
});

test("steering safely adds tasks and rejects weakening proposals", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "steer-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Steer workflow",
      tasks: [{
        id: "T001",
        subject: "Original task",
        writable_paths: ["src/app.js"], responsibilityChanges: declare("src/app.js"),
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));
    await importApprovedPlan(projectRoot, planPath);

    const rejected = await steerWorkflow(projectRoot, {
      kind: "revise_acceptance",
      targetTaskId: "T001",
      evidence: "skip tests to complete faster",
      rationale: "remove verification",
      verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
      review_commands: ["node --version"],
    });
    assert.equal(rejected.accepted, false);
    assert.ok(rejected.audit.invariant.rejectedReasons.includes("weakened completion"));

    const emptyVerifier = await steerWorkflow(projectRoot, {
      kind: "revise_acceptance",
      targetTaskId: "T001",
      evidence: "Verifier removal was proposed by mistake.",
      rationale: "This should be rejected because empty verification is not evidence.",
      verify_commands: [],
      review_commands: ["node --version"],
    });
    assert.equal(emptyVerifier.accepted, false);
    assert.ok(emptyVerifier.audit.invariant.rejectedReasons.includes("verify_commands cannot be empty"));

    const removedVerifier = await steerWorkflow(projectRoot, {
      kind: "revise_acceptance",
      targetTaskId: "T001",
      evidence: "Use a different command instead.",
      rationale: "This should be rejected because it removes the existing gate.",
      verify_commands: ["node -e \"console.log('new weaker gate')\""],
      review_commands: ["node --version"],
    });
    assert.equal(removedVerifier.accepted, false);
    assert.ok(removedVerifier.audit.invariant.rejectedReasons.some((reason) => reason.includes("verify_commands cannot remove existing gate command")));

    const accepted = await steerWorkflow(projectRoot, {
      kind: "add_task",
      source: "test",
      evidence: "User added a follow-up task with explicit verifier.",
      rationale: "The follow-up is independent and keeps gates intact.",
      task: {
        id: "T002",
        subject: "Follow-up task",
        writable_paths: ["src/app.js"], responsibilityChanges: declare("src/app.js"),
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      },
    });
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.taskState.tasks.length, 2);
    // 加单改变了职责声明：计划回到待批准
    assert.equal((await runNextTask(projectRoot)).status, "awaiting_plan_approval");

    await assert.rejects(() => steerWorkflow(projectRoot, {
      kind: "add_task",
      source: "test",
      evidence: "User added a follow-up task without declaring responsibilities.",
      rationale: "Undeclared tasks must not become executable.",
      task: {
        id: "T003",
        subject: "Undeclared follow-up",
        writable_paths: ["src/app.js"],
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
      },
    }), /T003 requires responsibilityChanges/);

    const incompleteReorder = await steerWorkflow(projectRoot, {
      kind: "reorder_pending",
      source: "test",
      evidence: "Only moving one pending task should be rejected.",
      rationale: "Pending order must be an exact permutation, not a partial list.",
      pendingOrder: ["T002"],
    });
    assert.equal(incompleteReorder.accepted, false);
    assert.ok(incompleteReorder.audit.invariant.rejectedReasons.some((reason) => reason.includes("must include every pending task exactly once")));
    assert.match(await readFile(resolveWildArrangePath(projectRoot, "ledger.jsonl"), "utf8"), /steering_applied/);
  });
});

test("empty verifier commands cannot complete even if task state is corrupted", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "empty-verifier-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Empty verifier guard",
      tasks: [{
        id: "T001",
        subject: "Corrupted task should not pass",
        writable_paths: ["src/app.js"], responsibilityChanges: declare("src/app.js"),
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));
    await importApprovedPlan(projectRoot, planPath);

    const taskStatePath = resolveWildArrangePath(projectRoot, "team", "tasks.json");
    const taskState = await readJson(taskStatePath);
    taskState.tasks[0].verify_commands = [];
    await writeFile(taskStatePath, JSON.stringify(taskState, null, 2));

    const result = await runNextTask(projectRoot);
    assert.equal(result.status, "retry");
    assert.equal(result.verifyResult.pass, false);
    assert.match(result.verifyResult.results[0].stderr, /verify_commands must contain at least one command/);
    assert.equal(result.task.last_failure.reason, "verifier_failed");
    assert.equal(result.task.status, "pending");
  });
});

test("review blockers create a resolution task without completing the blocked task", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "blocker-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Review blocker",
      tasks: [{
        id: "T001",
        subject: "Task needing final review",
        writable_paths: ["src/app.js"], responsibilityChanges: declare("src/app.js"),
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));
    await importApprovedPlan(projectRoot, planPath);
    await runWorkflowNode(projectRoot, "execute", { taskId: "T001" });

    const blocker = {
      taskId: "T001",
      title: "Resolve missing browser verification",
      objective: "Run browser-level evidence before final checkpoint.",
      evidence: "BaiZe final review found missing browser evidence.",
      rationale: "The blocker must be resolved as a separate task.",
      worker_command: "node -e \"if(!process.version)process.exit(1)\"",
      verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
      review_commands: ["node --version"],
      writable_paths: ["src/app.js"],
    };
    // 整改单和其他任务一样必须带职责声明
    await assert.rejects(() => recordReviewBlocker(projectRoot, blocker), /requires responsibilityChanges for the resolution task/);
    const blocked = await recordReviewBlocker(projectRoot, { ...blocker, responsibilityChanges: declare("src/app.js") });
    assert.equal(blocked.blockedTask.status, "review_blocked");
    assert.equal(blocked.resolutionTask.reviewBlockerFor, "T001");
    const status = await statusReport(projectRoot);
    assert.equal(status.review_blocked, 1);
    assert.match(await readFile(resolveWildArrangePath(projectRoot, "ledger.jsonl"), "utf8"), /review_blocker_recorded/);
  });
});

test("review blocker resolution returns the blocked task to pending only after the resolution task completes", async () => {
  await withExternalProject(async ({ projectRoot, root, stateHome }) => {
    const planPath = path.join(root, "blocker-resolve-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Review blocker resolution",
      tasks: [{
        id: "T001",
        subject: "Task needing final review",
        writable_paths: ["src/app.js"], responsibilityChanges: declare("src/app.js"),
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));
    await importApprovedPlan(projectRoot, planPath);
    await runWorkflowNode(projectRoot, "execute", { taskId: "T001" });

    const blocked = await recordReviewBlocker(projectRoot, {
      taskId: "T001",
      evidence: "BaiZe final review found missing browser evidence.",
      rationale: "The blocker must be resolved as a separate task.",
      writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
      worker_command: nodeEval("const fs=require('fs');fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/blocker-resolution.txt','blocker resolved\\n')"),
      verify_commands: [nodeEval("const fs=require('fs');if(fs.readFileSync('src/blocker-resolution.txt','utf8').trim()!=='blocker resolved')process.exit(1)")],
      review_commands: [nodeEval("const fs=require('fs');const lines=fs.readFileSync('src/blocker-resolution.txt','utf8').trim().split(/\\r?\\n/);if(lines.length!==1||!lines[0].startsWith('blocker resolved'))process.exit(1)")],
    });
    assert.equal(blocked.blockedTask.status, "review_blocked");

    const taskStatePath = resolveWildArrangePath(projectRoot, "team", "tasks.json");
    await assert.rejects(
      () => resolveReviewBlocker(projectRoot, {
        taskId: "T001",
        evidence: "Premature unblock attempt without a finished resolution task.",
        rationale: "This must be rejected while the resolution task is still pending.",
      }),
      /complete it before unblocking/,
    );
    let persisted = await readJson(taskStatePath);
    assert.equal(persisted.tasks.find((task) => task.id === "T001").status, "review_blocked");

    // 登记整改单改变了职责声明：计划回到待批准，人确认后整改单才执行
    assert.equal((await runNextTask(projectRoot)).status, "awaiting_plan_approval");
    await approvePlan(projectRoot);
    const completed = await runNextTask(projectRoot);
    assert.equal(completed.status, "completed", JSON.stringify({ status: completed.status, task: completed.task?.id, failure: completed.task?.last_failure }));
    assert.equal(completed.task.id, blocked.resolutionTask.id);

    // 走公开 CLI：review_blocked 必须有用户可达的出口
    const cli = spawnSync(process.execPath, [path.resolve("bin", "wildarrange.mjs"), "review-blockers", "resolve", "--root", projectRoot,
      "--task", "T001",
      "--evidence", `Resolution task ${blocked.resolutionTask.id} finished with a passing verifier.`,
      "--rationale", "The blocked task re-enters the delivery pipeline for a fresh run."], {
      cwd: projectRoot, encoding: "utf8", env: { ...process.env, WILDARRANGE_STATE_HOME: stateHome },
    });
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    const resolved = JSON.parse(cli.stdout);
    assert.equal(resolved.unblockedTask.status, "pending");
    persisted = await readJson(taskStatePath);
    const unblocked = persisted.tasks.find((task) => task.id === "T001");
    assert.equal(unblocked.status, "pending");
    assert.ok(unblocked.reviewBlocker.resolvedAt);
    assert.match(await readFile(resolveWildArrangePath(projectRoot, "ledger.jsonl"), "utf8"), /review_blocker_resolved/);
  });
});

test("steering mark_blocked rejects completed or verifying targets", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "mark-blocked-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Mark blocked guard",
      tasks: [{
        id: "T001",
        subject: "Task that completes",
        writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
        worker_command: nodeEval("const fs=require('fs');fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/mark-blocked.txt','terminal guard\\n')"),
        verify_commands: [nodeEval("const fs=require('fs');if(fs.readFileSync('src/mark-blocked.txt','utf8').trim()!=='terminal guard')process.exit(1)")],
        review_commands: [nodeEval("const fs=require('fs');const lines=fs.readFileSync('src/mark-blocked.txt','utf8').trim().split(/\\r?\\n/);if(lines.length!==1||!lines[0].startsWith('terminal guard'))process.exit(1)")],
      }, {
        id: "T002",
        subject: "Task stuck verifying",
        writable_paths: ["src/app.js"], responsibilityChanges: declare("src/app.js"),
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }));
    await importApprovedPlan(projectRoot, planPath);
    const completed = await runNextTask(projectRoot);
    assert.equal(completed.status, "completed", JSON.stringify({ status: completed.status, task: completed.task?.id, failure: completed.task?.last_failure }));
    assert.equal(completed.task.id, "T001");

    const taskStatePath = resolveWildArrangePath(projectRoot, "team", "tasks.json");
    const taskState = await readJson(taskStatePath);
    taskState.tasks.find((task) => task.id === "T002").status = "verifying";
    await writeFile(taskStatePath, JSON.stringify(taskState, null, 2));

    for (const targetTaskId of ["T001", "T002"]) {
      const result = await steerWorkflow(projectRoot, {
        kind: "mark_blocked",
        targetTaskId,
        evidence: "Worker reported an unresolved dependency.",
        rationale: "The task should wait for a human decision.",
      });
      assert.equal(result.accepted, false);
      assert.ok(result.audit.invariant.rejectedReasons.some((reason) => reason.includes("mark_blocked cannot target completed or verifying")));
    }

    const persisted = await readJson(taskStatePath);
    assert.equal(persisted.tasks.find((task) => task.id === "T001").status, "completed");
    assert.equal(persisted.tasks.find((task) => task.id === "T002").status, "verifying");
  });
});

test("attention report aggregates decisions waiting on the user", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "attention-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Attention drill",
      tasks: [{
        id: "T001",
        subject: "被审阅阻塞的任务",
        writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }, null, 2));
    await importApprovedPlan(projectRoot, planPath);
    await runWorkflowNode(projectRoot, "execute", { taskId: "T001" });
    await recordReviewBlocker(projectRoot, {
      taskId: "T001",
      title: "评审发现证据不足",
      objective: "补齐边界条件证据后再回到主任务。",
      evidence: "verifier evidence does not cover edge cases",
      rationale: "blocker 必须作为独立任务解决。",
      worker_command: "node -e \"if(!process.version)process.exit(1)\"",
      verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
      review_commands: ["node --version"],
      responsibilityChanges: declare("src/app.js"),
    });

    const attention = await attentionReport(projectRoot);
    assert.ok(attention.total >= 1);
    assert.ok(attention.needsUserDecision.some((task) => task.id === "T001" && task.status === "review_blocked"));

    const data = await dashboardData(projectRoot);
    assert.ok(data.attention);
    assert.equal(data.attention.kind, "attention_report");
  });
});
