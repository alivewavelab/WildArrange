// =============================================================================
// 文件名称：git-coordination.test.mjs
// 所属模块：test
// 作用说明：
//   验证单机 Git 交付：task branch 独占（同一分支不得被两个可写任务占用）、
//   delivery commit 只含本任务路径、普通 push 不移动 main、脏基线与越界文件拒绝、
//   parallel/linear worktree、memory digest。不测：GitHub PR 集成。
//
// 【运行原理速读】
//   在临时 git 仓库初始化 runtime，执行 claim/worktree/admission 序列，
//   断言 HEAD、changed paths 与 task.coordination 状态一致。
// =============================================================================

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { admitParallelAgentResult, closeParallelAgentRun, runParallelAgents } from "../src/orchestration/parallel-runtime.mjs";
import { runNextTask } from "../src/orchestration/linear-runtime.mjs";
import { importPlan, loadTaskState } from "../src/orchestration/plan-state.mjs";
import { claimTeamTask, persistTaskState } from "../src/orchestration/task-board.mjs";
import { ensureLinearDeliveryWorkspace } from "../src/orchestration/linear-delivery.mjs";
import { resolveTaskBranchTarget } from "../src/orchestration/task-branch.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { runDoctor } from "../src/interface/doctor.mjs";
import { collectGitChangedPaths, readGitHead, readGitTopLevel } from "../src/infra/git-diff.mjs";
import { uniqueStrings } from "../src/infra/text-utils.mjs";
import { prepareAgentWorktree } from "../src/infra/git-worktree.mjs";
import { loadWildArrangeConfig } from "../src/infra/runtime-config.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { withExternalProject } from "./helpers/external-fixture.mjs";
import {
  createTaskDeliveryCommit,
  inspectTaskWorktreeBaseline,
  pushTaskDeliveryCommit,
  pushCommit,
  synchronizeTaskWorktreeToDelivery,
} from "../src/infra/git-coordination.mjs";
import {
  integrateAdmissionCommit,
  readIntegrationIntent,
} from "../src/orchestration/integration.mjs";

const execFileAsync = promisify(execFile);

test("task delivery uses one branch-bound worktree, commits atomically, and pushes without moving main", async () => {
  await withRemoteClones(async ({ dir, remote, cloneA }) => {
    const mainBefore = (await git(cloneA, ["rev-parse", "origin/main"])).trim();
    const taskRunDir = path.join(dir, "task-run");
    const branch = "wildarrange/task/P-GIT/T001";
    const worktree = await prepareAgentWorktree(cloneA, taskRunDir, {
      isolation: "git-worktree",
      branchName: branch,
      startPoint: mainBefore,
    });
    assert.equal(worktree.available, true);
    assert.equal(worktree.branch, branch);

    const baseline = await inspectTaskWorktreeBaseline(worktree.workDir);
    assert.equal(baseline.clean, true);
    assert.equal(baseline.headSha, mainBefore);
    assert.equal(baseline.branch, branch);

    await mkdir(path.join(worktree.workDir, "src"), { recursive: true });
    await writeFile(path.join(worktree.workDir, "src", "feature.mjs"), "export const ready = true;\n", "utf8");
    const delivery = await createTaskDeliveryCommit(worktree.workDir, {
      expectedHead: mainBefore,
      expectedBranch: branch,
      changedPaths: ["src/feature.mjs"],
      message: "feat(T001): deliver feature",
    });
    assert.equal(delivery.pass, true);
    assert.equal(delivery.status, "committed");
    assert.equal(delivery.worktreeClean, true);
    assert.notEqual(delivery.commitSha, mainBefore);

    const pushed = await pushTaskDeliveryCommit(worktree.workDir, {
      remote,
      branch,
      commitSha: delivery.commitSha,
    });
    assert.equal(pushed.pass, true);
    assert.equal((await git(cloneA, ["ls-remote", "--heads", remote, "refs/heads/main"])).trim().split(/\s+/)[0], mainBefore);
    assert.equal((await git(cloneA, ["ls-remote", "--heads", remote, `refs/heads/${branch}`])).trim().split(/\s+/)[0], delivery.commitSha);
  });
});

test("task delivery refuses unattributed dirty files and does not create a commit", async () => {
  await withRemoteClones(async ({ dir, cloneA }) => {
    const head = (await git(cloneA, ["rev-parse", "HEAD"])).trim();
    const worktree = await prepareAgentWorktree(cloneA, path.join(dir, "dirty-task"), {
      isolation: "git-worktree",
      branchName: "wildarrange/task/P-GIT/T-DIRTY",
      startPoint: head,
    });
    await writeFile(path.join(worktree.workDir, "unexpected.txt"), "other owner\n", "utf8");
    const baseline = await inspectTaskWorktreeBaseline(worktree.workDir);
    assert.equal(baseline.clean, false);
    assert.deepEqual(baseline.changedPaths, ["unexpected.txt"]);
    const result = await createTaskDeliveryCommit(worktree.workDir, {
      expectedHead: head,
      expectedBranch: "wildarrange/task/P-GIT/T-DIRTY",
      changedPaths: [],
    });
    assert.equal(result.pass, false);
    assert.equal(result.reason, "unattributed_worktree_changes");
    assert.equal((await git(worktree.workDir, ["rev-parse", "HEAD"])).trim(), head);
  });
});

test("task worktree cleanliness includes untracked WildArrange runtime files", async () => {
  await withRemoteClones(async ({ dir, cloneA }) => {
    const head = (await git(cloneA, ["rev-parse", "HEAD"])).trim();
    const branch = "wildarrange/task/P-GIT/T-RUNTIME-DIRTY";
    const worktree = await prepareAgentWorktree(cloneA, path.join(dir, "runtime-dirty-task"), {
      isolation: "git-worktree",
      branchName: branch,
      startPoint: head,
    });
    await mkdir(path.join(worktree.workDir, ".wildarrange", "rules"), { recursive: true });
    await writeFile(path.join(worktree.workDir, ".wildarrange", "rules", "context.json"), "{}\n", "utf8");

    const baseline = await inspectTaskWorktreeBaseline(worktree.workDir);
    assert.equal(baseline.clean, false);
    assert.deepEqual(baseline.changedPaths, [".wildarrange/rules/context.json"]);
    const sync = await synchronizeTaskWorktreeToDelivery(worktree.workDir, {
      expectedHead: head,
      expectedBranch: branch,
      commitSha: head,
    });
    assert.equal(sync.pass, false);
    assert.equal(sync.status, "recovery_required");
    assert.equal(sync.reason, "task_worktree_changed_after_delivery");
    assert.deepEqual(sync.changedPaths, [".wildarrange/rules/context.json"]);
  });
});

test("task delivery records no_change without manufacturing an empty commit", async () => {
  await withRemoteClones(async ({ dir, cloneA }) => {
    const head = (await git(cloneA, ["rev-parse", "HEAD"])).trim();
    const branch = "wildarrange/task/P-GIT/T-NOCHANGE";
    const worktree = await prepareAgentWorktree(cloneA, path.join(dir, "no-change-task"), {
      isolation: "git-worktree",
      branchName: branch,
      startPoint: head,
    });
    const result = await createTaskDeliveryCommit(worktree.workDir, {
      expectedHead: head,
      expectedBranch: branch,
      changedPaths: [],
    });
    assert.equal(result.pass, true);
    assert.equal(result.status, "no_change");
    assert.equal(result.commitSha, head);
    assert.equal((await git(worktree.workDir, ["rev-list", "--count", "HEAD"])).trim(), "1");
  });
});

test("git changed-path probe uses argv safely and excludes .wildarrange", async () => {
  await withTempDir(async (dir) => {
    const repo = path.join(dir, "repo with spaces");
    await mkdir(repo, { recursive: true });
    await git(repo, ["init", "--initial-branch=main"]);
    await writeFile(path.join(repo, "tracked.txt"), "baseline\n", "utf8");
    await git(repo, ["add", "tracked.txt"]);
    await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
    await writeFile(path.join(repo, "tracked.txt"), "changed\n", "utf8");
    await writeFile(path.join(repo, "new file.txt"), "new\n", "utf8");
    await mkdir(path.join(repo, ".wildarrange"), { recursive: true });
    await writeFile(path.join(repo, ".wildarrange", "runtime.json"), "{}\n", "utf8");

    const changed = await collectGitChangedPaths(repo);
    assert.equal(changed.available, true);
    assert.deepEqual(changed.paths, ["new file.txt", "tracked.txt"]);
  });
});

test("writable parallel agents get a worktree and one local run claim per task", async () => {
  await withRemoteClones(async ({ cloneA }) => {
    await initializeTaskRuntime(cloneA);
    const command = resultCommand("src/task.txt", "ok\n");
    const outcomes = await Promise.allSettled([
      runParallelAgents(cloneA, { taskIds: ["T001"], agent: "ZhuRong", command }),
      runParallelAgents(cloneA, { taskIds: ["T001"], agent: "ZhuRong", command }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    const batch = outcomes.find((outcome) => outcome.status === "fulfilled").value;
    assert.equal(batch.results[0].isolation, "git-worktree");
    assert.equal(batch.results[0].worktreeAvailable, true);
    assert.match(
      outcomes.find((outcome) => outcome.status === "rejected").reason.message,
      /already has writable parallel run|already claimed|claim lost/i,
    );
  });
});

test("without a remote, delivery still commits to a clean local task branch worktree", async () => {
  await withExternalProject(async ({ projectRoot: repo }) => {
    const mainBefore = (await git(repo, ["rev-parse", "main"])).trim();
    await initializeTaskRuntime(repo);

    const batch = await runParallelAgents(repo, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command: resultCommand("src/local-only.txt", "local delivery\n"),
    });
    assert.equal(batch.results[0].isolation, "git-worktree");
    assert.equal(batch.results[0].worktreeAvailable, true);

    const admitted = await admitParallelAgentResult(repo, { runId: batch.runId, taskId: "T001" });
    assert.equal(admitted.status, "completed", JSON.stringify(admitted, null, 2));
    assert.equal(admitted.integrationCommit.local, true);
    assert.equal(admitted.integrationCommit.pushed, false);
    assert.equal(admitted.integrationCommit.status, "committed_local");
    assert.equal(admitted.rollback.status, "rolled_back");
    assert.equal((await git(repo, ["rev-parse", "main"])).trim(), mainBefore);
    assert.equal((await git(repo, ["status", "--short"])).trim(), "");
    await assert.rejects(readFile(path.join(repo, "src", "local-only.txt"), "utf8"), /ENOENT/);

    const state = await loadTaskState(repo);
    const task = state.tasks[0];
    assert.equal(task.coordination.status, "local");
    assert.equal(task.coordination.localGit, true);
    assert.equal(task.coordination.branch, "wildarrange/task/P-GIT/T001");
    const localTaskHead = (await git(repo, ["rev-parse", task.coordination.branch])).trim();
    assert.equal(localTaskHead, admitted.integrationCommit.integrationSha);
    assert.equal(await git(repo, ["show", `${localTaskHead}:src/local-only.txt`]), "local delivery\n");
    const taskWorktree = await inspectTaskWorktreeBaseline(path.resolve(repo, batch.results[0].workDir));
    assert.equal(taskWorktree.clean, true);
    assert.equal(taskWorktree.branch, task.coordination.branch);
    assert.equal(taskWorktree.headSha, localTaskHead);
    assert.equal(task.delivery_workspace.kind, "parallel_task_worktree");
    assert.equal(task.delivery_workspace.runId, batch.runId);
    assert.equal(task.delivery_workspace.workDir, path.resolve(repo, batch.results[0].workDir));
    assert.equal(task.delivery_workspace.branch, task.coordination.branch);
    assert.equal(task.delivery_workspace.baseSha, mainBefore);
    assert.equal(task.delivery_workspace.deliverySha, localTaskHead);
    const proof = await readJson(resolveWildArrangePath(repo, "reports", "acceptance", "P-GIT", "T001.json"));
    const checkpoint = await readJson(resolveWildArrangePath(repo, "checkpoints", "P-GIT", "T001.json"));
    assert.equal(proof.evidenceRefs.deliveryBaseline.commitSha, localTaskHead);
    assert.equal(proof.evidenceRefs.deliveryBaseline.pushed, false);
    assert.equal(checkpoint.deliveryBaseline.integrationSha, localTaskHead);

  });
});

test("local task delivery resumes the same commit after checkpoint failure", async () => {
  await withExternalProject(async ({ projectRoot: repo }) => {
    const mainBefore = (await git(repo, ["rev-parse", "main"])).trim();
    await initializeTaskRuntime(repo);
    const batch = await runParallelAgents(repo, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command: resultCommand("src/local-recovery.txt", "recover locally\n"),
    });
    const checkpointPlanDir = resolveWildArrangePath(repo, "checkpoints", "P-GIT");
    await replaceDirectoryWithBlockingFile(checkpointPlanDir);
    let first;
    try {
      first = await admitParallelAgentResult(repo, { runId: batch.runId, taskId: "T001" });
    } finally {
      await restoreBlockedDirectory(checkpointPlanDir);
    }
    assert.equal(first.status, "recovery_required");
    assert.equal(first.rollback.reason, "local_delivery_already_committed");
    const firstIntent = await readIntegrationIntent(repo, batch.runId, "T001");
    assert.equal(firstIntent.status, "committed_local");

    const resumed = await admitParallelAgentResult(repo, { runId: batch.runId, taskId: "T001" });
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.integrationCommit.integrationSha, firstIntent.integrationSha);
    assert.equal((await git(repo, ["rev-parse", "main"])).trim(), mainBefore);
    await assert.rejects(readFile(path.join(repo, "src", "local-recovery.txt"), "utf8"), /ENOENT/);
    assert.equal((await git(repo, ["rev-list", "--count", "wildarrange/task/P-GIT/T001"])).trim(), "2");
  });
});

test("missing task branch metadata degrades explicitly for a non-Git task", async () => {
  await withExternalProject(async ({ projectRoot: rootDir }) => {
    const result = await integrateAdmissionCommit(rootDir, {
      planId: "P-LOCAL",
      taskId: "T001",
      task: { id: "T001" },
      runId: "agent_run_missing_coordination",
      changedPaths: [],
    });
    assert.equal(result.pass, true);
    assert.equal(result.status, "local_degraded");
    assert.equal(result.reason, "task branch metadata is unavailable");
  });
});

test("successful admission pushes a delivery commit to the task branch and leaves main unchanged", async () => {
  await withRemoteClones(async ({ remote, cloneA }) => {
    await initializeTaskRuntime(cloneA);
    const before = (await git(remote, ["rev-parse", "main"])).trim();
    const batch = await runParallelAgents(cloneA, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command: worktreeEditCommand("src/integrated.txt", "integrated\n"),
    });
    const admitted = await admitParallelAgentResult(cloneA, { runId: batch.runId, taskId: "T001" });
    assert.equal(admitted.status, "completed");
    const after = (await git(remote, ["rev-parse", "main"])).trim();
    assert.equal(after, before);
    await assert.rejects(readFile(path.join(cloneA, "src", "integrated.txt"), "utf8"), /ENOENT/);
    const intent = await readJson(
      resolveWildArrangePath(cloneA, "agent-runs", batch.runId, "T001.integration.json"),
      null,
    );
    assert.equal(intent.status, "pushed");
    const taskBranchHead = (await git(remote, ["rev-parse", intent.branch])).trim();
    assert.equal(await git(remote, ["show", `${taskBranchHead}:src/integrated.txt`]), "integrated\n");
    const taskWorktree = await inspectTaskWorktreeBaseline(path.join(cloneA, batch.results[0].workDir));
    assert.equal(taskWorktree.clean, true);
    assert.equal(taskWorktree.branch, intent.branch);
    assert.equal(taskWorktree.headSha, taskBranchHead);
    assert.equal(intent.integrationSha, taskBranchHead);
    assert.equal(intent.actualSha, taskBranchHead);
    assert.equal(admitted.integrationCommit.actualSha, taskBranchHead);
    const proof = await readJson(resolveWildArrangePath(cloneA, "reports", "acceptance", "P-GIT", "T001.json"));
    const checkpoint = await readJson(resolveWildArrangePath(cloneA, "checkpoints", "P-GIT", "T001.json"));
    assert.equal(proof.evidenceRefs.deliveryBaseline.commitSha, taskBranchHead);
    assert.equal(checkpoint.deliveryBaseline.integrationSha, taskBranchHead);
  });
});

test("lost task-branch push response reconciles when the remote task branch advanced to a descendant", async () => {
  await withRemoteClones(async ({ remote, cloneA, cloneB }) => {
    await initializeTaskRuntime(cloneA);
    const claimed = await claimTeamTask(cloneA, { taskId: "T001", owner: "ZhuRong" });
    await mkdir(path.join(cloneA, "src"), { recursive: true });
    await writeFile(path.join(cloneA, "src", "lost-response.txt"), "integrated\n", "utf8");

    let integrationSha;
    let descendantSha;
    const result = await integrateAdmissionCommit(cloneA, {
      planId: "P-GIT",
      taskId: "T001",
      task: claimed.task,
      runId: "agent_run_lost_push_response",
      changedPaths: ["src/lost-response.txt"],
      pushCommitFn: async (rootDir, pushOptions) => {
        const pushed = await pushCommit(rootDir, pushOptions);
        assert.equal(pushed.ok, true);
        integrationSha = pushOptions.commitSha;
        await git(cloneB, ["fetch", "origin", `refs/heads/${pushOptions.branch}`]);
        await git(cloneB, ["switch", "-C", "delivery-descendant", "FETCH_HEAD"]);
        await writeFile(path.join(cloneB, "after-lost-response.txt"), "descendant\n", "utf8");
        await git(cloneB, ["add", "after-lost-response.txt"]);
        await git(cloneB, ["-c", "user.name=Device B", "-c", "user.email=b@example.invalid", "commit", "-m", "advance after accepted push"]);
        await git(cloneB, ["push", "origin", `HEAD:refs/heads/${pushOptions.branch}`]);
        descendantSha = (await git(remote, ["rev-parse", pushOptions.branch])).trim();
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "simulated response loss after remote accepted push",
        };
      },
    });

    assert.equal(result.pass, true);
    assert.equal(result.pushed, true);
    assert.equal(result.reconciled, true);
    assert.equal(result.integrationSha, integrationSha);
    assert.equal(result.actualSha, descendantSha);
    await git(remote, ["merge-base", "--is-ancestor", integrationSha, descendantSha]);
  });
});

test("unknown integration push outcome stays durable and forbids rollback across an offline retry", async () => {
  await withRemoteClones(async ({ dir, remote, cloneA }) => {
    await initializeTaskRuntime(cloneA);
    const claimed = await claimTeamTask(cloneA, { taskId: "T001", owner: "ZhuRong" });
    await mkdir(path.join(cloneA, "src"), { recursive: true });
    await writeFile(path.join(cloneA, "src", "unknown-push.txt"), "keep until resolved\n", "utf8");
    const runId = "agent_run_unknown_push";
    const options = {
      planId: "P-GIT",
      taskId: "T001",
      task: claimed.task,
      runId,
      changedPaths: ["src/unknown-push.txt"],
    };
    const unreachableRemote = path.join(dir, "temporarily-unreachable.git");

    const first = await integrateAdmissionCommit(cloneA, {
      ...options,
      pushCommitFn: async () => {
        await git(cloneA, ["remote", "set-url", "origin", unreachableRemote]);
        return {
          ok: false,
          exitCode: 1,
          stdout: "",
          stderr: "simulated response loss with unavailable read-back",
        };
      },
    });
    assert.equal(first.reason, "integration_push_outcome_unknown");
    assert.equal(first.pushed, true);
    const intent = await readIntegrationIntent(cloneA, runId, "T001");
    assert.equal(intent.status, "push_outcome_unknown");
    assert.equal(intent.pushOutcome, "unknown");

    const second = await integrateAdmissionCommit(cloneA, {
      ...options,
      pushCommitFn: async () => {
        assert.fail("an unresolved push must not be retried while the remote is unreachable");
      },
    });
    assert.equal(second.reason, "integration_push_outcome_unknown");
    assert.equal(second.pushed, true);
    assert.equal((await readIntegrationIntent(cloneA, runId, "T001")).status, "push_outcome_unknown");
    assert.equal(await readFile(path.join(cloneA, "src", "unknown-push.txt"), "utf8"), "keep until resolved\n");
    await git(cloneA, ["remote", "set-url", "origin", remote]);
  });
});

test("admission rejects unrelated dirty files even when they are inside writable_paths", async () => {
  await withRemoteClones(async ({ remote, cloneA }) => {
    await initializeTaskRuntime(cloneA);
    await mkdir(path.join(cloneA, "src"), { recursive: true });
    await writeFile(path.join(cloneA, "src", "unrelated.txt"), "do not publish\n", "utf8");
    const before = (await git(remote, ["rev-parse", "main"])).trim();
    const batch = await runParallelAgents(cloneA, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command: resultCommand("src/task.txt", "task\n"),
    });
    const admitted = await admitParallelAgentResult(cloneA, { runId: batch.runId, taskId: "T001" });
    assert.equal(admitted.status, "revalidation_required");
    assert.equal(admitted.task.last_failure.reason, "workspace_contains_unattributed_changes");
    assert.match(admitted.task.last_failure.summary, /src\/unrelated\.txt/);
    assert.equal((await git(remote, ["rev-parse", "main"])).trim(), before);
    assert.equal(await readFile(path.join(cloneA, "src", "unrelated.txt"), "utf8"), "do not publish\n");
    await assert.rejects(readFile(path.join(cloneA, "src", "task.txt"), "utf8"), /ENOENT/);
  });
});

test("checkpoint failure after task-branch delivery keeps the claim and resumes without a second push", async () => {
  await withRemoteClones(async ({ remote, cloneA, cloneB }) => {
    await initializeTaskRuntime(cloneA);
    const batch = await runParallelAgents(cloneA, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command: resultCommand("src/recover.txt", "recover\n"),
    });
    const checkpointPlanDir = resolveWildArrangePath(cloneA, "checkpoints", "P-GIT");
    await replaceDirectoryWithBlockingFile(checkpointPlanDir);
    let first;
    try {
      first = await admitParallelAgentResult(cloneA, { runId: batch.runId, taskId: "T001" });
    } finally {
      await restoreBlockedDirectory(checkpointPlanDir);
    }
    assert.equal(first.status, "recovery_required");
    assert.equal(first.rollback.reason, "remote_integration_already_pushed");
    const intent = await readIntegrationIntent(cloneA, batch.runId, "T001");
    const integratedSha = (await git(remote, ["rev-parse", intent.branch])).trim();
    assert.equal(integratedSha, intent.integrationSha);
    assert.equal(await git(remote, ["show", `${integratedSha}:src/recover.txt`]), "recover\n");
    await git(cloneB, ["pull", "--ff-only", "origin", "main"]);
    await writeFile(path.join(cloneB, "after-integration.txt"), "later\n", "utf8");
    await git(cloneB, ["add", "after-integration.txt"]);
    await git(cloneB, ["-c", "user.name=Device B", "-c", "user.email=b@example.invalid", "commit", "-m", "advance after integration"]);
    await git(cloneB, ["push", "origin", "main"]);
    const advancedSha = (await git(remote, ["rev-parse", "main"])).trim();
    assert.notEqual(advancedSha, integratedSha);

    const resumed = await admitParallelAgentResult(cloneA, { runId: batch.runId, taskId: "T001" });
    assert.equal(resumed.status, "completed");
    assert.equal((await git(remote, ["rev-parse", "main"])).trim(), advancedSha);
  });
});

test("linear remote delivery resumes the pushed commit after checkpoint failure without rerunning worker", async () => {
  await withRemoteClones(async ({ remote, cloneA }) => {
    const planId = "P-LINEAR-REMOTE";
    await importPlanDefinition(cloneA, {
      id: planId,
      title: "Linear remote delivery recovery",
      objective: "One pushed delivery commit is bound to proof and checkpoint.",
      tasks: [{
        id: "T001",
        subject: "Push and recover one linear delivery",
        worker_command: "node -e \"const fs=require('node:fs');fs.mkdirSync('src',{recursive:true});const p='src/linear-remote.txt';const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8'))+1:1;fs.writeFileSync(p,String(n))\"",
        verify_commands: ["node -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('src/linear-remote.txt','utf8'),'1')\""],
        review_commands: ["node -e \"const fs=require('node:fs');const assert=require('node:assert/strict');assert.equal(fs.statSync('src/linear-remote.txt').size,1);assert.deepEqual(fs.readdirSync('src'),['linear-remote.txt'])\""],
        writable_paths: ["src/**"],
      }],
    });
    const mainBefore = (await git(remote, ["rev-parse", "main"])).trim();
    const checkpointPlanDir = resolveWildArrangePath(cloneA, "checkpoints", planId);
    await replaceDirectoryWithBlockingFile(checkpointPlanDir);
    let first;
    try {
      first = await runNextTask(cloneA);
    } finally {
      await restoreBlockedDirectory(checkpointPlanDir);
    }
    assert.equal(first.status, "recovery_required");
    assert.equal(first.task.status, "verifying");
    const deliverySha = first.task.delivery.integrationSha;
    const taskBranch = first.task.coordination.branch;
    assert.equal((await git(remote, ["rev-parse", taskBranch])).trim(), deliverySha);
    assert.equal((await git(remote, ["rev-parse", "main"])).trim(), mainBefore);
    assert.equal(await git(remote, ["show", `${deliverySha}:src/linear-remote.txt`]), "1");

    const intent = await readIntegrationIntent(cloneA, first.task.delivery_workspace.runId, "T001");
    assert.equal(intent.status, "pushed");
    assert.equal(intent.integrationSha, deliverySha);
    const resumed = await runNextTask(cloneA);
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.task.delivery.integrationSha, deliverySha);
    assert.equal((await git(remote, ["rev-parse", taskBranch])).trim(), deliverySha, "recovery must not push another commit");
    assert.equal((await git(remote, ["rev-parse", "main"])).trim(), mainBefore);
    assert.equal(await readFile(path.join(resumed.task.delivery_workspace.workDir, "src", "linear-remote.txt"), "utf8"), "1", "worker must not rerun");

    const proof = await readJson(resolveWildArrangePath(cloneA, "reports", "acceptance", planId, "T001.json"));
    const checkpoint = await readJson(resolveWildArrangePath(cloneA, "checkpoints", planId, "T001.json"));
    assert.equal(proof.evidenceRefs.deliveryBaseline.commitSha, deliverySha);
    assert.equal(checkpoint.deliveryBaseline.integrationSha || checkpoint.deliveryBaseline.commitSha, deliverySha);
  });
});

test("pushed task delivery is never silently re-pushed or rolled back after task-branch history rewrite", async () => {
  await withRemoteClones(async ({ remote, cloneA, cloneB }) => {
    await initializeTaskRuntime(cloneA);
    const before = (await git(remote, ["rev-parse", "main"])).trim();
    const { batch, integratedSha } = await createCheckpointFailureAfterIntegration(cloneA, "src/rewrite-recovery.txt");
    const intent = await readIntegrationIntent(cloneA, batch.runId, "T001");
    assert.notEqual(integratedSha, intent.expectedSha);
    await git(cloneB, ["fetch", "origin", `refs/heads/${intent.branch}`]);
    await git(cloneB, ["push", "--force", "origin", `${intent.expectedSha}:refs/heads/${intent.branch}`]);

    const retried = await admitParallelAgentResult(cloneA, { runId: batch.runId, taskId: "T001" });
    assert.equal(retried.status, "recovery_required");
    assert.equal(retried.rollback.status, "not_attempted");
    assert.equal((await git(remote, ["rev-parse", "main"])).trim(), before);
    assert.equal((await git(remote, ["rev-parse", intent.branch])).trim(), intent.expectedSha);
    assert.equal(await readFile(path.join(cloneA, "src", "rewrite-recovery.txt"), "utf8"), "recover\n");
  });
});

test("parallel close releases a crash-orphaned claim even when the run has no results", async () => {
  await withRemoteClones(async ({ cloneA }) => {
    await initializeTaskRuntime(cloneA);
    const state = await loadTaskState(cloneA);
    state.tasks[0].parallel_run_claim = {
      runId: "agent_run_crashed",
      owner: "ZhuRong",
      claimedAt: new Date().toISOString(),
    };
    await persistTaskState(cloneA, state);
    await writeFile(
      resolveWildArrangePath(cloneA, "agent-runs", "index.json"),
      JSON.stringify({
        runs: [{
          runId: "agent_run_crashed",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          results: [],
        }],
      }),
      "utf8",
    );
    const closed = await closeParallelAgentRun(cloneA, {
      runId: "agent_run_crashed",
      reason: "confirmed process terminated",
    });
    assert.deepEqual(closed.closed, ["T001"]);
    const recovered = await loadTaskState(cloneA);
    assert.equal(recovered.tasks[0].parallel_run_claim, null);
  });
});

async function initializeTaskRuntime(rootDir, taskIds = ["T001"]) {
  const planPath = resolveWildArrangePath(rootDir, "artifacts", "coordination-plan.json");
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify({
    id: "P-GIT",
    title: "Git delivery",
    objective: "One writable task owns one task branch and delivers it durably.",
    tasks: taskIds.map((taskId) => ({
      id: taskId,
      subject: `Coordinate task ${taskId}`,
      writable_paths: ["src/**"],
      verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
      review_commands: ["node -e \"const fs=require('node:fs');if(!fs.existsSync('src')||fs.readdirSync('src').length===0)process.exit(1)\""],
    })),
  }, null, 2), "utf8");
  await importPlan(rootDir, planPath);
}

async function importPlanDefinition(rootDir, plan) {
  const planPath = resolveWildArrangePath(rootDir, "artifacts", `${plan.id}.json`);
  await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
  await importPlan(rootDir, planPath);
}

async function createCheckpointFailureAfterIntegration(rootDir, filePath) {
  const batch = await runParallelAgents(rootDir, {
    taskIds: ["T001"],
    agent: "ZhuRong",
    command: resultCommand(filePath, "recover\n"),
  });
  const checkpointPlanDir = resolveWildArrangePath(rootDir, "checkpoints", "P-GIT");
  await replaceDirectoryWithBlockingFile(checkpointPlanDir);
  let result;
  try {
    result = await admitParallelAgentResult(rootDir, { runId: batch.runId, taskId: "T001" });
  } finally {
    await restoreBlockedDirectory(checkpointPlanDir);
  }
  assert.equal(result.status, "recovery_required");
  const intent = await readJson(
    resolveWildArrangePath(rootDir, "agent-runs", batch.runId, "T001.integration.json"),
    null,
  );
  assert.equal(intent.status, "pushed");
  return { batch, result, integratedSha: intent.integrationSha };
}

async function replaceDirectoryWithBlockingFile(dirPath) {
  await rm(dirPath, { recursive: true, force: true });
  await writeFile(dirPath, "blocks checkpoint child paths\n", "utf8");
}

async function restoreBlockedDirectory(dirPath) {
  await rm(dirPath, { force: true });
  await mkdir(dirPath, { recursive: true });
}

function resultCommand(filePath, content) {
  const encodedPath = Buffer.from(filePath, "utf8").toString("base64");
  const encodedContent = Buffer.from(content, "utf8").toString("base64");
  return [
    "node -e",
    JSON.stringify(`const fs=require('fs');const decode=(value)=>Buffer.from(value,'base64').toString('utf8');fs.writeFileSync(process.argv[1],JSON.stringify({summary:'ready',files:[{path:decode('${encodedPath}'),content:decode('${encodedContent}')}] }));`),
    "{outputJson}",
  ].join(" ");
}

function worktreeEditCommand(filePath, content) {
  const encodedPath = Buffer.from(filePath, "utf8").toString("base64");
  const encodedContent = Buffer.from(content, "utf8").toString("base64");
  return [
    "node -e",
    JSON.stringify(`const fs=require('fs');const path=require('path');const decode=(value)=>Buffer.from(value,'base64').toString('utf8');const target=decode('${encodedPath}');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,decode('${encodedContent}'));fs.writeFileSync(process.argv[1],JSON.stringify({summary:'worktree delivery ready'}));`),
    "{outputJson}",
  ].join(" ");
}

async function readLedger(rootDir) {
  const raw = await readFile(resolveWildArrangePath(rootDir, "ledger.jsonl"), "utf8");
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

test("git read primitives resolve HEAD/toplevel from one owner", async () => {
  await withTempDir(async (dir) => {
    const repo = path.join(dir, "repo");
    await mkdir(repo, { recursive: true });
    const missingHead = await readGitHead(repo);
    assert.deepEqual(missingHead, { available: false, sha: null, reason: missingHead.reason });
    assert.equal(typeof missingHead.reason, "string");
    const missingTopLevel = await readGitTopLevel(repo);
    assert.equal(missingTopLevel.available, false);
    assert.equal(missingTopLevel.topLevel, null);

    await git(dir, ["init", "--initial-branch=main", repo]);
    await writeFile(path.join(repo, "README.md"), "seed\n", "utf8");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "commit", "-m", "initial"]);
    const expectedHead = (await git(repo, ["rev-parse", "HEAD"])).trim();

    const head = await readGitHead(repo);
    assert.deepEqual(head, { available: true, sha: expectedHead });
    const topLevel = await readGitTopLevel(repo);
    assert.equal(topLevel.available, true);
    assert.equal(await realpath(topLevel.topLevel), await realpath(repo));
  });
});

test("text-utils uniqueStrings is the single dedupe owner", () => {
  assert.deepEqual(uniqueStrings(["a", "b", "a", "", "b", "c"]), ["a", "b", "c"]);
  assert.deepEqual(uniqueStrings(["x", null, 7, "x", " y "]), ["x", " y "]);
  assert.deepEqual(uniqueStrings([]), []);
});

/** 外置三根夹具：projectRoot 即 device A；再补一个裸远端与 device B 克隆。 */
async function withRemoteClones(fn) {
  await withExternalProject(async ({ root, projectRoot }) => {
    const remote = path.join(root, "origin.git");
    const cloneB = path.join(root, "device-b");
    await git(root, ["init", "--bare", "--initial-branch=main", remote]);
    await git(projectRoot, ["remote", "add", "origin", remote]);
    await git(projectRoot, ["push", "-u", "origin", "main"]);
    await git(root, ["clone", remote, cloneB]);
    await fn({ dir: root, remote, cloneA: projectRoot, cloneB });
  });
}

async function git(cwd, args) {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 1_000_000,
  });
  return result.stdout;
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-git-delivery-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("one task branch cannot be checked out by two writable worktrees", async () => {
  await withRemoteClones(async ({ dir, cloneA }) => {
    const head = (await git(cloneA, ["rev-parse", "HEAD"])).trim();
    const branch = "wildarrange/task/P-GIT/T001";
    const first = await prepareAgentWorktree(cloneA, path.join(dir, "first-run"), {
      isolation: "git-worktree",
      branchName: branch,
      startPoint: head,
    });
    assert.equal(first.available, true);

    const second = await prepareAgentWorktree(cloneA, path.join(dir, "second-run"), {
      isolation: "git-worktree",
      branchName: branch,
      startPoint: head,
    });
    assert.equal(second.available, false);
    assert.equal(second.occupied, true);
    assert.match(second.reason, /already checked out by another worktree/);
    assert.match(second.reason, /two writable tasks cannot share one branch/);
    await assert.rejects(readFile(path.join(dir, "second-run", "worktree", "README.md"), "utf8"), /ENOENT/);

    // 分支仍存在但 worktree 已移走时，同样拒绝复用，避免接手别的任务留下的分支。
    await git(cloneA, ["worktree", "remove", "--force", first.workDir]);
    const third = await prepareAgentWorktree(cloneA, path.join(dir, "third-run"), {
      isolation: "git-worktree",
      branchName: branch,
      startPoint: head,
    });
    assert.equal(third.available, false);
    assert.equal(third.occupied, true);
    assert.match(third.reason, /already exists/);
  });
});

test("a parallel run refuses to start when a linear worktree already holds the task branch", async () => {
  await withRemoteClones(async ({ cloneA }) => {
    await initializeTaskRuntime(cloneA);
    const state = await loadTaskState(cloneA);
    const task = state.tasks[0];
    task.coordination = await resolveTaskBranchTarget(cloneA, { planId: state.planId, task });
    const workspace = await ensureLinearDeliveryWorkspace(cloneA, state.planId, task, state.tasks);
    assert.equal(workspace.branch, "wildarrange/task/P-GIT/T001");
    await persistTaskState(cloneA, state);

    const batch = await runParallelAgents(cloneA, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command: resultCommand("src/second-writer.txt", "second writer\n"),
    });
    assert.equal(batch.results[0].pass, false);
    assert.equal(batch.results[0].worktreeAvailable, false);
    assert.match(batch.results[0].worktreeReason, /already checked out by another worktree/);
    assert.match(batch.results[0].stderr, /two writable tasks cannot share one branch/);
    await assert.rejects(readFile(path.join(cloneA, "src", "second-writer.txt"), "utf8"), /ENOENT/);
  });
});

test("task branch push is ordinary: never outside the task prefix and never over a diverged branch", async () => {
  await withRemoteClones(async ({ dir, remote, cloneA, cloneB }) => {
    const head = (await git(cloneA, ["rev-parse", "HEAD"])).trim();
    const branch = "wildarrange/task/P-GIT/T001";
    const worktree = await prepareAgentWorktree(cloneA, path.join(dir, "push-run"), {
      isolation: "git-worktree",
      branchName: branch,
      startPoint: head,
    });
    await writeFile(path.join(worktree.workDir, "mine.txt"), "mine\n", "utf8");
    const delivery = await createTaskDeliveryCommit(worktree.workDir, {
      expectedHead: head,
      expectedBranch: branch,
      changedPaths: ["mine.txt"],
    });
    await assert.rejects(
      () => pushTaskDeliveryCommit(worktree.workDir, { remote, branch: "main", commitSha: delivery.commitSha }),
      /refusing automatic push outside task branch prefix/,
    );

    // 别处已在同名分支上写入不同历史：普通 push 必须被 Git 拒绝，远端保持原样。
    await writeFile(path.join(cloneB, "theirs.txt"), "theirs\n", "utf8");
    await git(cloneB, ["add", "theirs.txt"]);
    await git(cloneB, ["-c", "user.name=Other", "-c", "user.email=o@example.invalid", "commit", "-m", "other history"]);
    await git(cloneB, ["push", "origin", `HEAD:refs/heads/${branch}`]);
    const theirs = (await git(remote, ["rev-parse", branch])).trim();
    const rejected = await pushTaskDeliveryCommit(worktree.workDir, { remote, branch, commitSha: delivery.commitSha });
    assert.equal(rejected.pass, false);
    assert.equal(rejected.status, "push_failed");
    assert.equal((await git(remote, ["rev-parse", branch])).trim(), theirs);
    assert.equal((await git(remote, ["rev-parse", "main"])).trim(), head);
  });
});

test("removed multi-device commands are no longer part of the CLI", async () => {
  await withRemoteClones(async ({ cloneA }) => {
    const binPath = path.resolve("bin/wildarrange.mjs");
    for (const args of [["device", "status"], ["coordination", "status"], ["handoff", "prepare"]]) {
      await assert.rejects(
        () => execFileAsync(process.execPath, [binPath, ...args], { cwd: cloneA, encoding: "utf8" }),
        (error) => error.code !== 0,
        args.join(" "),
      );
    }
  });
});
