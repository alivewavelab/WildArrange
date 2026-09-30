// =============================================================================
// 文件名称：runtime-parallel.test.mjs
// 所属模块：test
// 作用说明：
//   并行 Agent：任务包并发、只读 Agent 边界、依赖、adapter 模板、admit/回滚与 worktree 隔离。
// =============================================================================

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { admitParallelAgentResult, closeParallelAgentRun, listParallelAgentRuns, parallelAgentStatus, runParallelAgents } from "../src/orchestration/parallel-runtime.mjs";

import { listTeamMessages } from "../src/orchestration/team-messages.mjs";
import { dashboardData } from "../src/orchestration/status.mjs";
import { runCommand } from "../src/infra/command-runner.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { withExternalProject, declare, importApprovedPlan } from "./helpers/external-fixture.mjs";
import { nodeEval, writePolicyConfig } from "./helpers/runtime-fixtures.mjs";

/** 夹具任务可能改动的文件：职责声明覆盖本文件用例写入的全部路径。 */
const SRC_RESPONSIBILITY = declare("src/one.js", "src/parallel.txt", "src/two.js", "src/worktree.txt");

test("parallel agents run task packets concurrently and publish results", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "parallel-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel smoke",
      tasks: [
        {
          id: "T001",
          subject: "Parallel research one",
          verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
          review_commands: ["node --version"],
          writable_paths: ["artifacts/one.txt"],
          responsibilityChanges: declare("artifacts/one.txt"),
        },
        {
          id: "T002",
          subject: "Parallel research two",
          verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
          review_commands: ["node --version"],
          writable_paths: ["artifacts/two.txt"],
          responsibilityChanges: declare("artifacts/two.txt"),
        },
      ],
    }, null, 2));
    await importApprovedPlan(projectRoot, planPath);

    const command = "node -e \"const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'parallel done'}));\" {outputJson}";
    const batch = await runParallelAgents(projectRoot, {
      maxAgents: 2,
      agent: "ZhuRong",
      command,
    });

    assert.equal(batch.status, "completed");
    assert.equal(batch.taskCount, 2);
    assert.ok(batch.results.every((result) => result.agent === "ZhuRong" && result.pass));
    assert.ok(batch.results.every((result) => result.lifecycle.status === "awaiting_user_acceptance"));
    assert.ok(batch.results.every((result) => result.result.summary === "parallel done"));

    const messages = await listTeamMessages(projectRoot, { agent: "Jiuwei" });
    assert.equal(messages.length, 2);
    assert.ok(messages.every((message) => message.summary.includes("parallel result")));

    const runs = await listParallelAgentRuns(projectRoot);
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0].results.length, 2);

    const status = await parallelAgentStatus(projectRoot, { runId: batch.runId });
    assert.equal(status.runCount, 1);
    assert.equal(status.runs[0].summary.awaiting_user_acceptance, 2);
    assert.ok(status.runs[0].results.every((result) => result.lifecycle.status === "awaiting_user_acceptance"));

    const closed = await closeParallelAgentRun(projectRoot, { runId: batch.runId, taskId: "T001", reason: "user_accepted" });
    assert.deepEqual(closed.closed, ["T001"]);
    const afterClose = await parallelAgentStatus(projectRoot, { runId: batch.runId });
    const closedTask = afterClose.runs[0].results.find((result) => result.taskId === "T001");
    assert.equal(closedTask.lifecycle.status, "closed");
    assert.equal(closedTask.lifecycle.closeReason, "user_accepted");
    assert.match(await readFile(resolveWildArrangePath(projectRoot, "ledger.jsonl"), "utf8"), /parallel_agents_completed/);
    assert.match(await readFile(resolveWildArrangePath(projectRoot, "ledger.jsonl"), "utf8"), /parallel_agent_run_closed/);
  });
});

test("read-only long-lived Agents cannot enter the parallel command worker", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "parallel-readonly-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Read-only Agent boundary",
      tasks: [{
        id: "T001",
        subject: "Must not execute",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
        writable_paths: [],
        responsibilityChanges: declare(),
      }],
    }, null, 2));
    await importApprovedPlan(projectRoot, planPath);

    for (const agent of ["DiJiang", "BaiZe", "LuWu"]) {
      const markerPath = path.join(projectRoot, `${agent}.wrote`);
      const command = nodeEval(`require("fs").writeFileSync(${JSON.stringify(markerPath)}, "forbidden")`);
      await assert.rejects(
        runParallelAgents(projectRoot, { taskIds: ["T001"], agent, command }),
        new RegExp(`agent ${agent} is read-only`),
      );
      await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);
    }
    const ledger = await readFile(resolveWildArrangePath(projectRoot, "ledger.jsonl"), "utf8");
    assert.doesNotMatch(ledger, /parallel_agents_started/);
  });
});

test("parallel explicit task selection cannot bypass blockedBy", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "parallel-blocked-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel dependency boundary",
      tasks: [
        {
          id: "T001",
          subject: "Finish prerequisite",
          verify_commands: ["node --version"],
          review_commands: ["node --version"],
          writable_paths: ["src/one.js"],
          responsibilityChanges: declare("src/one.js"),
        },
        {
          id: "T002",
          subject: "Must wait for prerequisite",
          blockedBy: ["T001"],
          verify_commands: ["node --version"],
          review_commands: ["node --version"],
          writable_paths: ["src/two.js"],
          responsibilityChanges: declare("src/two.js"),
        },
      ],
    }, null, 2));
    await importApprovedPlan(projectRoot, planPath);

    const markerPath = path.join(projectRoot, "blocked-task-ran.txt");
    const command = nodeEval(`require("fs").writeFileSync(${JSON.stringify(markerPath)}, "should not run")`);
    await assert.rejects(
      runParallelAgents(projectRoot, { taskIds: ["T002"], agent: "ZhuRong", command }),
      /task T002 blocked by T001/,
    );
    await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);
    const runs = await listParallelAgentRuns(projectRoot);
    assert.equal(runs.runs.length, 0);
  });
});

test("parallel agents without a runner command are blocked before any run starts", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "parallel-skipped-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel skipped",
      tasks: [{
        id: "T001",
        subject: "Prepare packet only",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
        writable_paths: ["artifacts/one.txt"],
        responsibilityChanges: declare("artifacts/one.txt"),
      }],
    }, null, 2));
    await importApprovedPlan(projectRoot, planPath);

    const batch = await runParallelAgents(projectRoot, { maxAgents: 1 });
    assert.equal(batch.status, "readiness_blocked");
    assert.equal(batch.runId, null);
    assert.ok(batch.readiness.issues.some((issue) => /real worker_command/.test(issue)), JSON.stringify(batch.readiness.issues));
  });
});

test("parallel agents can use configured adapter command templates", async () => {
  await withExternalProject(async ({ projectRoot, root, governanceRoot }) => {
    await writePolicyConfig(governanceRoot, JSON.stringify({
      parallelAgents: {
        spawnAdapters: {
          codex: {
            command: "node -e \"const fs=require('fs'); const packet=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); fs.writeFileSync(process.argv[2], JSON.stringify({summary:'adapter '+packet.agent, files:[{path:'artifacts/adapter.txt', content:packet.task.id}]}));\" {taskJson} {outputJson}",
          },
        },
      },
    }, null, 2));
    await initRuntime(projectRoot);
    const planPath = path.join(root, "adapter-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Adapter spawn",
      tasks: [{
        id: "T001",
        subject: "Use adapter command",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
        writable_paths: ["artifacts/adapter.txt"],
        responsibilityChanges: declare("artifacts/adapter.txt"),
      }],
    }, null, 2));
    await importApprovedPlan(projectRoot, planPath);

    const batch = await runParallelAgents(projectRoot, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      adapter: "codex",
    });

    assert.equal(batch.status, "completed");
    assert.equal(batch.results[0].adapter, "codex");
    assert.equal(batch.results[0].spawnSource, "adapter");
    assert.equal(batch.results[0].result.files[0].path, "artifacts/adapter.txt");
  }, { init: false });
});

test("parallel admission applies child artifacts only after gates pass", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "parallel-admit-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel admission",
      tasks: [
        {
          id: "T001",
          subject: "Admit child artifact",
          verify_commands: [nodeEval("const fs=require('fs'); if(fs.readFileSync('src/parallel.txt','utf8').trim()!=='ok') process.exit(1);")],
          review_commands: [nodeEval("const fs=require('fs');const value=fs.readFileSync('src/parallel.txt','utf8');if(value.split(/\\r?\\n/).filter(Boolean).length!==1||value.trim()!=='ok')process.exit(1)")],
          writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
        },
      ],
    }, null, 2));
    const plan = await importApprovedPlan(projectRoot, planPath);

    const command = [
      nodeEval("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'artifact ready', files:[{path:'src/parallel.txt', content:'ok\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(projectRoot, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command,
    });
    const admitted = await admitParallelAgentResult(projectRoot, {
      runId: batch.runId,
      taskId: "T001",
    });

    assert.equal(admitted.status, "completed", JSON.stringify(admitted, null, 2));
    assert.equal(admitted.acceptanceProof.pass, true);
    assert.deepEqual(admitted.appliedPaths, ["src/parallel.txt"]);
    // 外置模式下项目是 Git 仓：产物落在任务 worktree，主工作区保持不动。
    assert.equal(await readFile(path.join(admitted.task.delivery_workspace.workDir, "src", "parallel.txt"), "utf8"), "ok\n");
    await assert.rejects(readFile(path.join(projectRoot, "src", "parallel.txt"), "utf8"), /ENOENT/);
    const releasedResult = await readJson(resolveWildArrangePath(projectRoot, "agent-runs", batch.runId, "T001", "result.json"));
    assert.equal(releasedResult.lifecycle.status, "released");
    const checkpoint = await readJson(resolveWildArrangePath(projectRoot, "checkpoints", plan.id, "T001.json"));
    assert.equal(checkpoint.taskId, "T001");
    assert.equal(checkpoint.verifyResult.pass, true);
    assert.equal(checkpoint.scopeResult.status, "pass");
    assert.equal(checkpoint.reviewResult.pass, true);
  });
});

test("parallel admission rolls back child artifacts when gates fail", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "parallel-rollback-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel admission rollback",
      tasks: [{
        id: "T001",
        subject: "Reject bad child artifact",
        verify_commands: [nodeEval("const fs=require('fs'); if(fs.readFileSync('src/parallel.txt','utf8').trim()!=='ok') process.exit(1);")],
        review_commands: ["node --version"],
        writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
      }],
    }, null, 2));
    await importApprovedPlan(projectRoot, planPath);

    const command = [
      nodeEval("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'bad artifact', files:[{path:'src/parallel.txt', content:'bad\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(projectRoot, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command,
    });
    const admitted = await admitParallelAgentResult(projectRoot, {
      runId: batch.runId,
      taskId: "T001",
    });

    assert.equal(admitted.status, "retry");
    assert.equal(admitted.rollback.status, "rolled_back");
    await assert.rejects(readFile(path.join(projectRoot, "src", "parallel.txt"), "utf8"), /ENOENT/);
    // 回滚必须同时清掉任务 worktree 里的子产物。
    assert.ok(batch.results[0].workDir, "the run must expose the task worktree");
    await assert.rejects(readFile(path.join(path.resolve(projectRoot, batch.results[0].workDir), "src", "parallel.txt"), "utf8"), /ENOENT/);
    const result = await readJson(resolveWildArrangePath(projectRoot, "agent-runs", batch.runId, "T001", "result.json"));
    assert.equal(result.lifecycle.status, "awaiting_revision");
    assert.equal(result.lifecycle.rollback.status, "rolled_back");
    assert.match(await readFile(resolveWildArrangePath(projectRoot, "ledger.jsonl"), "utf8"), /parallel_agent_admission_rolled_back/);
  });
});

test("parallel agents can isolate edits in git worktrees and admit patches", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    await runCommand("git init", projectRoot);
    await runCommand("git config user.email test@example.com", projectRoot);
    await runCommand("git config user.name 'WildArrange Test'", projectRoot);
    await writeFile(path.join(projectRoot, "README.md"), "root\n");
    await runCommand("git add README.md", projectRoot);
    await runCommand("git commit -m initial", projectRoot);
    const mainBefore = (await runCommand("git rev-parse HEAD", projectRoot)).stdout.trim();

    const planPath = resolveWildArrangePath(projectRoot, "artifacts", "worktree-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Worktree admission",
      tasks: [{
        id: "T001",
        subject: "Admit worktree patch",
        verify_commands: [nodeEval("const fs=require('fs'); if(fs.readFileSync('src/worktree.txt','utf8').trim()!=='ok') process.exit(1);")],
        review_commands: [nodeEval("const fs=require('fs');const value=fs.readFileSync('src/worktree.txt','utf8');if(value.includes('\\0')||value.trim()!=='ok')process.exit(1)")],
        writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
      }],
    }, null, 2));
    await importApprovedPlan(projectRoot, planPath);

    const command = [
      nodeEval("const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/worktree.txt','ok\\n'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'worktree patch ready'}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(projectRoot, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      isolation: "git-worktree",
      command,
    });

    assert.equal(batch.status, "completed");
    assert.equal(batch.results[0].isolation, "git-worktree");
    assert.equal(batch.results[0].worktreeAvailable, true);
    assert.deepEqual(batch.results[0].patch.changedPaths, ["src/worktree.txt"]);
    const dashboard = await dashboardData(projectRoot);
    assert.equal(dashboard.activeWorkspaces.length, 1);
    assert.equal(dashboard.activeWorkspaces[0].taskId, "T001");
    assert.equal(dashboard.activeWorkspaces[0].workDir, batch.results[0].workDir);
    assert.match(dashboard.activeWorkspaces[0].branch, /^wildarrange\/task\/.+\/T001$/);

    const admitted = await admitParallelAgentResult(projectRoot, {
      runId: batch.runId,
      taskId: "T001",
    });

    assert.equal(admitted.status, "completed", JSON.stringify(admitted, null, 2));
    assert.deepEqual(admitted.appliedPaths, ["src/worktree.txt"]);
    await assert.rejects(readFile(path.join(projectRoot, "src", "worktree.txt"), "utf8"), /ENOENT/);
    assert.equal((await runCommand("git rev-parse HEAD", projectRoot)).stdout.trim(), mainBefore);
    const taskWorktree = path.resolve(projectRoot, batch.results[0].workDir);
    assert.equal((await readFile(path.join(taskWorktree, "src", "worktree.txt"), "utf8")).replaceAll("\r\n", "\n"), "ok\n");
    assert.equal((await runCommand("git status --short", taskWorktree)).stdout.trim(), "");
  });
});

test("parallel admission rejects artifacts outside writable paths", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "parallel-admit-deny-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel admission deny",
      tasks: [
        {
          id: "T001",
          subject: "Reject leaked artifact",
          verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
          review_commands: ["node --version"],
          writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
        },
      ],
    }, null, 2));
    await importApprovedPlan(projectRoot, planPath);

    const command = [
      nodeEval("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'bad artifact', files:[{path:'docs/leak.md', content:'nope\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(projectRoot, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command,
    });

    await assert.rejects(
      admitParallelAgentResult(projectRoot, { runId: batch.runId, taskId: "T001" }),
      /parallel admission denied/,
    );
    await assert.rejects(readFile(path.join(projectRoot, "docs", "leak.md"), "utf8"), /ENOENT/);
  });
});
