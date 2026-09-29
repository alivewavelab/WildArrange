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
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { listTeamMessages } from "../src/orchestration/task-board.mjs";
import { dashboardData } from "../src/orchestration/status.mjs";
import { runCommand } from "../src/infra/command-runner.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { withTempDir, nodeEval } from "./helpers/runtime-fixtures.mjs";

test("parallel agents run task packets concurrently and publish results", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "parallel-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel smoke",
      tasks: [
        {
          id: "T001",
          subject: "Parallel research one",
          verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
          review_commands: ["node --version"],
          writable_paths: [".wildarrange/artifacts/one.txt"],
        },
        {
          id: "T002",
          subject: "Parallel research two",
          verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
          review_commands: ["node --version"],
          writable_paths: [".wildarrange/artifacts/two.txt"],
        },
      ],
    }, null, 2));
    await importPlan(dir, planPath);

    const command = "node -e \"const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'parallel done'}));\" {outputJson}";
    const batch = await runParallelAgents(dir, {
      maxAgents: 2,
      agent: "ZhuRong",
      command,
    });

    assert.equal(batch.status, "completed");
    assert.equal(batch.taskCount, 2);
    assert.ok(batch.results.every((result) => result.agent === "ZhuRong" && result.pass));
    assert.ok(batch.results.every((result) => result.lifecycle.status === "awaiting_user_acceptance"));
    assert.ok(batch.results.every((result) => result.result.summary === "parallel done"));

    const messages = await listTeamMessages(dir, { agent: "Jiuwei" });
    assert.equal(messages.length, 2);
    assert.ok(messages.every((message) => message.summary.includes("parallel result")));

    const runs = await listParallelAgentRuns(dir);
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0].results.length, 2);

    const status = await parallelAgentStatus(dir, { runId: batch.runId });
    assert.equal(status.runCount, 1);
    assert.equal(status.runs[0].summary.awaiting_user_acceptance, 2);
    assert.ok(status.runs[0].results.every((result) => result.lifecycle.status === "awaiting_user_acceptance"));

    const closed = await closeParallelAgentRun(dir, { runId: batch.runId, taskId: "T001", reason: "user_accepted" });
    assert.deepEqual(closed.closed, ["T001"]);
    const afterClose = await parallelAgentStatus(dir, { runId: batch.runId });
    const closedTask = afterClose.runs[0].results.find((result) => result.taskId === "T001");
    assert.equal(closedTask.lifecycle.status, "closed");
    assert.equal(closedTask.lifecycle.closeReason, "user_accepted");
    assert.match(await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8"), /parallel_agents_completed/);
    assert.match(await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8"), /parallel_agent_run_closed/);
  });
});

test("read-only long-lived Agents cannot enter the parallel command worker", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "parallel-readonly-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Read-only Agent boundary",
      tasks: [{
        id: "T001",
        subject: "Must not execute",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
        writable_paths: [],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    for (const agent of ["DiJiang", "BaiZe", "LuWu"]) {
      const markerPath = path.join(dir, `${agent}.wrote`);
      const command = nodeEval(`require("fs").writeFileSync(${JSON.stringify(markerPath)}, "forbidden")`);
      await assert.rejects(
        runParallelAgents(dir, { taskIds: ["T001"], agent, command }),
        new RegExp(`agent ${agent} is read-only`),
      );
      await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);
    }
    const ledger = await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8");
    assert.doesNotMatch(ledger, /parallel_agents_started/);
  });
});

test("parallel explicit task selection cannot bypass blockedBy", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "parallel-blocked-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel dependency boundary",
      tasks: [
        {
          id: "T001",
          subject: "Finish prerequisite",
          verify_commands: ["node --version"],
          review_commands: ["node --version"],
          writable_paths: ["src/one.js"],
        },
        {
          id: "T002",
          subject: "Must wait for prerequisite",
          blockedBy: ["T001"],
          verify_commands: ["node --version"],
          review_commands: ["node --version"],
          writable_paths: ["src/two.js"],
        },
      ],
    }, null, 2));
    await importPlan(dir, planPath);

    const markerPath = path.join(dir, "blocked-task-ran.txt");
    const command = nodeEval(`require("fs").writeFileSync(${JSON.stringify(markerPath)}, "should not run")`);
    await assert.rejects(
      runParallelAgents(dir, { taskIds: ["T002"], agent: "ZhuRong", command }),
      /task T002 blocked by T001/,
    );
    await assert.rejects(readFile(markerPath, "utf8"), /ENOENT/);
    const runs = await listParallelAgentRuns(dir);
    assert.equal(runs.runs.length, 0);
  });
});

test("parallel agents without a runner command are marked skipped", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "parallel-skipped-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel skipped",
      tasks: [{
        id: "T001",
        subject: "Prepare packet only",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
        writable_paths: [".wildarrange/artifacts/one.txt"],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    const batch = await runParallelAgents(dir, { maxAgents: 1 });
    assert.equal(batch.status, "skipped");
    assert.equal(batch.results[0].status, "skipped");
    assert.equal(batch.results[0].pass, false);
    assert.equal(batch.results[0].lifecycle.status, "skipped");
  });
});

test("parallel agents can use configured adapter command templates", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "wildarrange.config.json"), JSON.stringify({
      parallelAgents: {
        spawnAdapters: {
          codex: {
            command: "node -e \"const fs=require('fs'); const packet=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); fs.writeFileSync(process.argv[2], JSON.stringify({summary:'adapter '+packet.agent, files:[{path:'.wildarrange/artifacts/adapter.txt', content:packet.task.id}]}));\" {taskJson} {outputJson}",
          },
        },
      },
    }, null, 2));
    await initRuntime(dir);
    const planPath = path.join(dir, "adapter-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Adapter spawn",
      tasks: [{
        id: "T001",
        subject: "Use adapter command",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
        writable_paths: [".wildarrange/artifacts/adapter.txt"],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    const batch = await runParallelAgents(dir, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      adapter: "codex",
    });

    assert.equal(batch.status, "completed");
    assert.equal(batch.results[0].adapter, "codex");
    assert.equal(batch.results[0].spawnSource, "adapter");
    assert.equal(batch.results[0].result.files[0].path, ".wildarrange/artifacts/adapter.txt");
  });
});

test("parallel admission applies child artifacts only after gates pass", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "parallel-admit-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel admission",
      tasks: [
        {
          id: "T001",
          subject: "Admit child artifact",
          verify_commands: [nodeEval("const fs=require('fs'); if(fs.readFileSync('src/parallel.txt','utf8').trim()!=='ok') process.exit(1);")],
          review_commands: [nodeEval("const fs=require('fs');const value=fs.readFileSync('src/parallel.txt','utf8');if(value.split(/\\r?\\n/).filter(Boolean).length!==1||value.trim()!=='ok')process.exit(1)")],
          writable_paths: ["src/**"],
        },
      ],
    }, null, 2));
    const plan = await importPlan(dir, planPath);

    const command = [
      nodeEval("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'artifact ready', files:[{path:'src/parallel.txt', content:'ok\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(dir, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command,
    });
    const admitted = await admitParallelAgentResult(dir, {
      runId: batch.runId,
      taskId: "T001",
    });

    assert.equal(admitted.status, "completed", JSON.stringify(admitted, null, 2));
    assert.equal(admitted.acceptanceProof.pass, true);
    assert.deepEqual(admitted.appliedPaths, ["src/parallel.txt"]);
    assert.equal(await readFile(path.join(dir, "src", "parallel.txt"), "utf8"), "ok\n");
    const releasedResult = await readJson(resolveWildArrangePath(dir, "agent-runs", batch.runId, "T001", "result.json"));
    assert.equal(releasedResult.lifecycle.status, "released");
    const checkpoint = await readJson(resolveWildArrangePath(dir, "checkpoints", plan.id, "T001.json"));
    assert.equal(checkpoint.taskId, "T001");
    assert.equal(checkpoint.verifyResult.pass, true);
    assert.equal(checkpoint.scopeResult.status, "pass");
    assert.equal(checkpoint.reviewResult.pass, true);
  });
});

test("parallel admission rolls back child artifacts when gates fail", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "parallel-rollback-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel admission rollback",
      tasks: [{
        id: "T001",
        subject: "Reject bad child artifact",
        verify_commands: [nodeEval("const fs=require('fs'); if(fs.readFileSync('src/parallel.txt','utf8').trim()!=='ok') process.exit(1);")],
        review_commands: ["node --version"],
        writable_paths: ["src/**"],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    const command = [
      nodeEval("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'bad artifact', files:[{path:'src/parallel.txt', content:'bad\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(dir, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command,
    });
    const admitted = await admitParallelAgentResult(dir, {
      runId: batch.runId,
      taskId: "T001",
    });

    assert.equal(admitted.status, "retry");
    assert.equal(admitted.rollback.status, "rolled_back");
    await assert.rejects(readFile(path.join(dir, "src", "parallel.txt"), "utf8"), /ENOENT/);
    const result = await readJson(resolveWildArrangePath(dir, "agent-runs", batch.runId, "T001", "result.json"));
    assert.equal(result.lifecycle.status, "awaiting_revision");
    assert.equal(result.lifecycle.rollback.status, "rolled_back");
    assert.match(await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8"), /parallel_agent_admission_rolled_back/);
  });
});

test("parallel agents can isolate edits in git worktrees and admit patches", async () => {
  await withTempDir(async (dir) => {
    await runCommand("git init", dir);
    await runCommand("git config user.email test@example.com", dir);
    await runCommand("git config user.name 'WildArrange Test'", dir);
    await writeFile(path.join(dir, "README.md"), "root\n");
    await runCommand("git add README.md", dir);
    await runCommand("git commit -m initial", dir);
    const mainBefore = (await runCommand("git rev-parse HEAD", dir)).stdout.trim();

    await initRuntime(dir);
    const planPath = resolveWildArrangePath(dir, "artifacts", "worktree-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Worktree admission",
      tasks: [{
        id: "T001",
        subject: "Admit worktree patch",
        verify_commands: [nodeEval("const fs=require('fs'); if(fs.readFileSync('src/worktree.txt','utf8').trim()!=='ok') process.exit(1);")],
        review_commands: [nodeEval("const fs=require('fs');const value=fs.readFileSync('src/worktree.txt','utf8');if(value.includes('\\0')||value.trim()!=='ok')process.exit(1)")],
        writable_paths: ["src/**"],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    const command = [
      nodeEval("const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/worktree.txt','ok\\n'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'worktree patch ready'}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(dir, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      isolation: "git-worktree",
      command,
    });

    assert.equal(batch.status, "completed");
    assert.equal(batch.results[0].isolation, "git-worktree");
    assert.equal(batch.results[0].worktreeAvailable, true);
    assert.deepEqual(batch.results[0].patch.changedPaths, ["src/worktree.txt"]);
    const dashboard = await dashboardData(dir);
    assert.equal(dashboard.activeWorkspaces.length, 1);
    assert.equal(dashboard.activeWorkspaces[0].taskId, "T001");
    assert.equal(dashboard.activeWorkspaces[0].workDir, batch.results[0].workDir);
    assert.match(dashboard.activeWorkspaces[0].branch, /^wildarrange\/task\/.+\/T001$/);

    const admitted = await admitParallelAgentResult(dir, {
      runId: batch.runId,
      taskId: "T001",
    });

    assert.equal(admitted.status, "completed", JSON.stringify(admitted, null, 2));
    assert.deepEqual(admitted.appliedPaths, ["src/worktree.txt"]);
    await assert.rejects(readFile(path.join(dir, "src", "worktree.txt"), "utf8"), /ENOENT/);
    assert.equal((await runCommand("git rev-parse HEAD", dir)).stdout.trim(), mainBefore);
    const taskWorktree = path.resolve(dir, batch.results[0].workDir);
    assert.equal((await readFile(path.join(taskWorktree, "src", "worktree.txt"), "utf8")).replaceAll("\r\n", "\n"), "ok\n");
    assert.equal((await runCommand("git status --short", taskWorktree)).stdout.trim(), "");
  });
});

test("parallel admission rejects artifacts outside writable paths", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "parallel-admit-deny-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel admission deny",
      tasks: [
        {
          id: "T001",
          subject: "Reject leaked artifact",
          verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
          review_commands: ["node --version"],
          writable_paths: ["src/**"],
        },
      ],
    }, null, 2));
    await importPlan(dir, planPath);

    const command = [
      nodeEval("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'bad artifact', files:[{path:'docs/leak.md', content:'nope\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(dir, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command,
    });

    await assert.rejects(
      admitParallelAgentResult(dir, { runId: batch.runId, taskId: "T001" }),
      /parallel admission denied/,
    );
    await assert.rejects(readFile(path.join(dir, "docs", "leak.md"), "utf8"), /ENOENT/);
  });
});
