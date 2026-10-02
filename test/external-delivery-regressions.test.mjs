// =============================================================================
// 文件名称：external-delivery-regressions.test.mjs
// 所属模块：test
// 作用说明：
//   外置治理（projectRoot / governanceRoot / runtimeRoot 三根）下的交付回归：
//   doctor 对 runtimeRoot 下任务 worktree 的漂移判定、admission finalize 崩溃恢复、
//   并行 run 失败/关闭后的分支释放、workflow --sample、相对计划草稿导入放行、扫描故障注入。
// =============================================================================

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { routeRequest as classifyRoute } from "../src/ai/routing.mjs";
import { runHostRoute } from "../src/orchestration/host-runtime.mjs";
import { preToolUseGuard } from "../src/ai/pre-tool-guard.mjs";
import { runCommandFile } from "../src/infra/command-runner.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { runDoctor } from "../src/interface/doctor.mjs";
import { runWorkflow } from "../src/orchestration/workflow.mjs";
import { runNextTask, runWorkflowNode } from "../src/orchestration/linear-runtime.mjs";
import { admitParallelAgentResult, closeParallelAgentRun, retryParallelAgentRun, runParallelAgents } from "../src/orchestration/parallel-runtime.mjs";
import { loadTaskState } from "../src/orchestration/plan-state.mjs";
import { persistTaskState } from "../src/orchestration/task-board.mjs";
import { withExternalProject, declare, importApprovedPlan } from "./helpers/external-fixture.mjs";
import { createSmokePlan } from "./helpers/runtime-fixtures.mjs";

/** 夹具任务可能改动的文件：职责声明覆盖本文件用例写入的全部路径。 */
const SRC_RESPONSIBILITY = declare("src/a.txt", "src/artifact.txt", "src/feature.js", "src/linear.txt", "src/one.txt", "src/parallel.txt", "src/retry.txt", "src/two.txt");

function routeRequest(root, input) { return runHostRoute(root, input, classifyRoute); }

const NODE_OK = "node -e \"if(!process.version)process.exit(1)\"";
const REVIEW_SRC = "node -e \"const fs=require('node:fs');if(!fs.existsSync('src')||fs.readdirSync('src').length===0)process.exit(1)\"";

/** 生成写 result.json 的并行 worker 命令。 */
function resultCommand(filePath, content) {
  const encodedPath = Buffer.from(filePath, "utf8").toString("base64");
  const encodedContent = Buffer.from(content, "utf8").toString("base64");
  return [
    "node -e",
    JSON.stringify(`const fs=require('fs');const d=(v)=>Buffer.from(v,'base64').toString('utf8');fs.writeFileSync(process.argv[1],JSON.stringify({summary:'ready',files:[{path:d('${encodedPath}'),content:d('${encodedContent}')}]}));`),
    "{outputJson}",
  ].join(" ");
}

async function git(cwd, args) {
  const result = await runCommandFile("git", args, cwd);
  assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

/** 导入 src/** 可写的多任务计划。 */
async function importSrcPlan(projectRoot, taskIds = ["T001"], planId = "P-EXT") {
  const planPath = resolveWildArrangePath(projectRoot, "artifacts", `${planId}.json`);
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify({
    id: planId,
    title: "External delivery regression",
    objective: "external delivery regression",
    tasks: taskIds.map((id) => ({
      id,
      subject: `Task ${id}`,
      writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
      verify_commands: [NODE_OK],
      review_commands: [REVIEW_SRC],
    })),
  }, null, 2), "utf8");
  await importApprovedPlan(projectRoot, planPath);
}

// ---------------------------------------------------------------------------
// 1. doctor：runtimeRoot 下的任务 worktree 是合法位置
// ---------------------------------------------------------------------------
test("doctor does not flag a clean task worktree under runtimeRoot, and flags drift with changedPaths", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    await importSrcPlan(projectRoot);
    const batch = await runParallelAgents(projectRoot, { taskIds: ["T001"], agent: "ZhuRong", command: resultCommand("src/a.txt", "a\n") });
    const admitted = await admitParallelAgentResult(projectRoot, { runId: batch.runId, taskId: "T001" });
    assert.equal(admitted.status, "completed", JSON.stringify(admitted, null, 2));
    const task = (await loadTaskState(projectRoot)).tasks[0];
    const workDir = task.delivery_workspace.workDir;

    const clean = await runDoctor(projectRoot);
    assert.equal(clean.findings.some((f) => f.code === "delivery_worktree_state_drift"), false, JSON.stringify(clean.findings, null, 2));

    await writeFile(path.join(workDir, "src", "a.txt"), "drift\n", "utf8");
    const drifted = await runDoctor(projectRoot);
    const finding = drifted.findings.find((f) => f.code === "delivery_worktree_state_drift" && f.taskId === "T001");
    assert.ok(finding, JSON.stringify(drifted.findings, null, 2));
    assert.deepEqual(finding.changedPaths, ["src/a.txt"]);
  });
});

// ---------------------------------------------------------------------------
// 2. admission finalize 崩溃后恢复：gate 必须在任务 delivery worktree 执行
// ---------------------------------------------------------------------------
test("a crash while finalizing keeps the workspace and resumes in the delivery worktree, and nobody else can hijack the claim", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const planPath = resolveWildArrangePath(projectRoot, "artifacts", "finalize-crash-plan.json");
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, JSON.stringify({
      id: "P-FIN",
      title: "Finalize crash resume",
      objective: "resume verifies in the delivery worktree",
      tasks: [{
        id: "T001",
        subject: "Artifact must survive a finalize crash",
        verify_commands: ["node -e \"const fs=require('fs');if(fs.readFileSync('src/artifact.txt','utf8').trim()!=='good')process.exit(1)\""],
        review_commands: [REVIEW_SRC],
        writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
      }],
    }, null, 2), "utf8");
    await importApprovedPlan(projectRoot, planPath);

    const batch = await runParallelAgents(projectRoot, { taskIds: ["T001"], agent: "ZhuRong", command: resultCommand("src/artifact.txt", "good\n") });
    const runB = `${batch.runId}-rival`;
    await cp(resolveWildArrangePath(projectRoot, "agent-runs", batch.runId), resolveWildArrangePath(projectRoot, "agent-runs", runB), { recursive: true });

    // finalize 内崩溃：wisdom 写失败发生在文件已应用、gates 已跑之后。
    const wisdomPath = resolveWildArrangePath(projectRoot, "wisdom", "verification.md");
    await mkdir(path.dirname(wisdomPath), { recursive: true });
    await writeFile(wisdomPath, "", "utf8");
    await chmod(wisdomPath, 0o444);
    try {
      await assert.rejects(() => admitParallelAgentResult(projectRoot, { runId: batch.runId, taskId: "T001" }), /interrupted while finalizing/);
    } finally {
      await chmod(wisdomPath, 0o644);
    }

    const duringClaim = (await loadTaskState(projectRoot)).tasks[0];
    assert.equal(duringClaim.status, "verifying");
    assert.equal(duringClaim.admission_claim?.runId, batch.runId);
    assert.equal(duringClaim.admission_claim?.phase, "finalizing");
    const runResult = await readJson(resolveWildArrangePath(projectRoot, "agent-runs", batch.runId, "T001", "result.json"));
    const workDir = path.resolve(projectRoot, runResult.workDir);
    assert.equal(runResult.isolation, "git-worktree");
    assert.equal((await readFile(path.join(workDir, "src", "artifact.txt"), "utf8")).trim(), "good");

    // 别人不能劫持 claim。
    const hijackRun = await runNextTask(projectRoot);
    assert.equal(hijackRun.status, "blocked");
    assert.equal(hijackRun.blockedBy?.reason, "parallel_admission_in_flight");
    await assert.rejects(() => runWorkflowNode(projectRoot, "checkpoint", { taskId: "T001" }), /claimed by parallel admission/);
    await assert.rejects(() => admitParallelAgentResult(projectRoot, { runId: runB, taskId: "T001" }), /claimed by parallel admission run/);
    assert.equal((await readFile(path.join(workDir, "src", "artifact.txt"), "utf8")).trim(), "good");

    // 同一 run 续跑：跳过 apply、重跑 gates（在 delivery worktree 内）、完成落盘。
    const resumed = await admitParallelAgentResult(projectRoot, { runId: batch.runId, taskId: "T001" });
    assert.equal(resumed.status, "completed", JSON.stringify(resumed, null, 2));
    const finalTask = (await loadTaskState(projectRoot)).tasks[0];
    assert.equal(finalTask.status, "completed");
    assert.equal(finalTask.admission_claim, null);
    assert.match(await readFile(wisdomPath, "utf8"), /T001/);
    assert.match(await readFile(resolveWildArrangePath(projectRoot, "ledger.jsonl"), "utf8"), /parallel_agent_admission_reclaimed/);
    const lifecycle = await readJson(resolveWildArrangePath(projectRoot, "agent-runs", batch.runId, "T001", "result.json"));
    assert.equal(lifecycle.lifecycle?.status, "released");
  });
});

// ---------------------------------------------------------------------------
// 3. 并行 run 失败 / close 后释放任务分支占用；不同任务抢同一分支仍被拒
// ---------------------------------------------------------------------------
test("a failed parallel run releases its task branch so the same task can retry in parallel", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    await importSrcPlan(projectRoot);
    const failed = await runParallelAgents(projectRoot, { taskIds: ["T001"], agent: "ZhuRong", command: "node -e \"process.exit(1)\"" });
    assert.equal(failed.status, "failed");
    assert.equal(failed.results[0].worktreeAvailable, true);

    const retry = await retryParallelAgentRun(projectRoot, { runId: failed.runId, command: resultCommand("src/retry.txt", "retry\n") });
    assert.equal(retry.status, "requeued", JSON.stringify(retry, null, 2));
    const retried = await readJson(resolveWildArrangePath(projectRoot, "agent-runs", retry.newRunId, "T001", "result.json"));
    assert.equal(retried.pass, true, JSON.stringify(retried, null, 2));
    assert.equal(retried.worktreeAvailable, true);
    const admitted = await admitParallelAgentResult(projectRoot, { runId: retry.newRunId, taskId: "T001" });
    assert.equal(admitted.status, "completed", JSON.stringify(admitted, null, 2));
  });
});

test("closing a parallel run releases its task branch so a linear run can take the task over", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const planPath = resolveWildArrangePath(projectRoot, "artifacts", "linear-after-close.json");
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, JSON.stringify({
      id: "P-LIN",
      title: "Linear after close",
      objective: "close frees the branch",
      tasks: [{
        id: "T001",
        subject: "linear task",
        worker_command: "node -e \"const fs=require('fs');fs.mkdirSync('src',{recursive:true});fs.writeFileSync('src/linear.txt','ok')\"",
        verify_commands: ["node -e \"require('node:fs').readFileSync('src/linear.txt','utf8')\""],
        review_commands: [REVIEW_SRC],
        writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
      }],
    }, null, 2), "utf8");
    await importApprovedPlan(projectRoot, planPath);
    const batch = await runParallelAgents(projectRoot, { taskIds: ["T001"], agent: "ZhuRong", command: resultCommand("src/parallel.txt", "p\n") });
    assert.equal(batch.results[0].pass, true);
    await closeParallelAgentRun(projectRoot, { runId: batch.runId });

    const linear = await runNextTask(projectRoot);
    assert.equal(linear.status, "completed", JSON.stringify(linear, null, 2));
  });
});

test("two different tasks still cannot hold the same task branch", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    await importSrcPlan(projectRoot, ["T001", "T002"]);
    const first = await runParallelAgents(projectRoot, { taskIds: ["T001"], agent: "ZhuRong", command: resultCommand("src/one.txt", "1\n") });
    assert.equal(first.results[0].pass, true);
    const state = await loadTaskState(projectRoot);
    state.tasks.find((task) => task.id === "T002").coordination = { ...state.tasks.find((task) => task.id === "T001").coordination };
    await persistTaskState(projectRoot, state);

    const second = await runParallelAgents(projectRoot, { taskIds: ["T002"], agent: "ZhuRong", command: resultCommand("src/two.txt", "2\n") });
    assert.equal(second.results[0].pass, false);
    assert.equal(second.results[0].worktreeAvailable, false);
    assert.match(second.results[0].stderr, /two writable tasks cannot share one branch/);
  });
});

// ---------------------------------------------------------------------------
// 4. workflow --sample 在外置 Git 交付下必须能完成
// ---------------------------------------------------------------------------
test("workflow completes an approved plan under external Git delivery", async () => {
  await withExternalProject(async ({ root, projectRoot }) => {
    await importApprovedPlan(projectRoot, await createSmokePlan(root));
    const result = await runWorkflow(projectRoot);
    assert.equal(result.ok, true, JSON.stringify(result.results.map((r) => r.status)));
    assert.equal(result.status.completed, 1);
    const task = (await loadTaskState(projectRoot)).tasks[0];
    assert.equal(task.status, "completed");
    const sha = task.delivery.integrationSha || task.delivery.commitSha;
    assert.equal((await git(projectRoot, ["show", `${sha}:artifacts/linear-smoke.txt`])).trim(), "ok");
    assert.equal((await git(projectRoot, ["status", "--short"])).trim(), "", "共享 checkout 不被样例弄脏");
  });
});

// ---------------------------------------------------------------------------
// 5. 相对计划草稿路径的 plan --from 导入：映射到 runtimeRoot 后被识别并放行
// ---------------------------------------------------------------------------
test("feature gate accepts the runtime draft path and a project-relative .wildarrange path is not an alias", async () => {
  const sessionId = "relative-draft-session";
  await withExternalProject(async ({ projectRoot, stateHome }) => {
    await routeRequest(projectRoot, { text: "新增一个从游戏详情页启动游戏的功能，开始做吧", sessionId });
    const confirmed = await routeRequest(projectRoot, { text: "确认", sessionId });
    assert.equal(confirmed.featureDesign.status, "awaiting_plan_import");

    const draftPath = resolveWildArrangePath(projectRoot, "plan-drafts", "relative-plan.json");
    await mkdir(path.dirname(draftPath), { recursive: true });
    await writeFile(draftPath, JSON.stringify({
      generated_by: "host_semantic",
      feature_design_ref: confirmed.featureDesign.id,
      title: "Relative draft",
      objective: "Import through a relative virtual path.",
      tasks: [{
        id: "T001",
        subject: "Implement entry",
        description: "Add the confirmed interaction.",
        owner: "ZhuRong",
        writable_paths: ["src/feature.js"],
        responsibilityChanges: [{ script: "src/feature.js", additions: "Create artifact", responsibilityBefore: "Absent", responsibilityAfter: "Own the artifact", facts: [] }],
        worker_command: NODE_OK,
        verify_commands: [NODE_OK],
        review_commands: [NODE_OK],
        successCriteria: [{ title: "Behavior implemented", expectedEvidence: "Verifier passes.", verifierCommandRefs: [0] }],
      }],
    }, null, 2), "utf8");

    const command = `node ./bin/wildarrange.mjs plan --from "${draftPath}"`;
    const guard = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: { command },
    });
    assert.equal(guard.decision, "allow", JSON.stringify(guard));

    // 旧的项目内相对写法不再映射到运行态：放行的只能是运行态绝对路径。
    const relativeGuard = await preToolUseGuard(projectRoot, {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_name: "Bash",
      tool_input: { command: "node ./bin/wildarrange.mjs plan --from .wildarrange/plan-drafts/relative-plan.json" },
    });
    assert.equal(relativeGuard.decision, "deny", JSON.stringify(relativeGuard));

    const run = spawnSync(process.execPath, [path.resolve(process.cwd(), "bin", "wildarrange.mjs"), "plan", "--root", projectRoot, "--from", draftPath], {
      cwd: projectRoot, encoding: "utf8", env: { ...process.env, WILDARRANGE_STATE_HOME: stateHome },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  });
});
