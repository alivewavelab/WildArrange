// =============================================================================
// 文件名称：task-cleanup.test.mjs
// 所属模块：test
// 作用说明：
//   合并后现场清理：线性任务 worktree/本地 branch 在 squash 与普通合并后被清理，
//   未合并或 worktree 脏时保留，远端 branch 只列清单不删除。
// =============================================================================

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runNextTask } from "../src/orchestration/linear-runtime.mjs";
import { cleanupMergedTasks } from "../src/orchestration/task-cleanup.mjs";
import { attentionReport } from "../src/orchestration/status.mjs";
import { runCommandFile } from "../src/infra/command-runner.mjs";
import { withExternalProject, importApprovedPlan } from "./helpers/external-fixture.mjs";
import { createSmokePlan } from "./helpers/runtime-fixtures.mjs";

async function git(cwd, args) {
  const result = await runCommandFile("git", ["-C", cwd, ...args], cwd, 60_000);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/** 外置项目 + 本地 bare origin，跑完一张线性任务；回调拿到任务与一份可推主线的独立 clone。 */
async function withCompletedTask(fn) {
  await withExternalProject(async ({ root, projectRoot }) => {
    const remote = path.join(root, "origin.git");
    await git(root, ["init", "--bare", "--initial-branch=main", remote]);
    await git(projectRoot, ["remote", "add", "origin", remote]);
    await git(projectRoot, ["push", "-q", "-u", "origin", "main"]);
    await importApprovedPlan(projectRoot, await createSmokePlan(root));
    const result = await runNextTask(projectRoot);
    assert.equal(result.status, "completed");
    const reviewer = path.join(root, "reviewer-clone");
    await git(root, ["clone", "-q", remote, reviewer]);
    await git(reviewer, ["config", "user.name", "Reviewer"]);
    await git(reviewer, ["config", "user.email", "reviewer@example.invalid"]);
    await fn({ projectRoot, reviewer, task: result.task, branch: result.task.delivery_workspace.branch });
  });
}

test("cleanup removes worktree and local branch after a squash merge and lists the remote branch for a human", async () => {
  await withCompletedTask(async ({ projectRoot, reviewer, task, branch }) => {
    await git(reviewer, ["fetch", "-q", "origin", branch]);
    await git(reviewer, ["merge", "--squash", "FETCH_HEAD"]);
    await git(reviewer, ["commit", "-q", "-m", "Squash task"]);
    await git(reviewer, ["push", "-q", "origin", "main"]);

    const before = await attentionReport(projectRoot);
    assert.deepEqual(before.pendingCleanup.map((item) => item.id), ["T001"]);

    const preview = await cleanupMergedTasks(projectRoot, { dryRun: true });
    assert.equal(preview.tasks[0].status, "would_clean");
    assert.equal(preview.tasks[0].mergedBy, "patch_equivalent");
    assert.ok(existsSync(task.delivery_workspace.workDir), "dry run must not touch the worktree");

    const result = await cleanupMergedTasks(projectRoot);
    assert.equal(result.tasks[0].status, "cleaned");
    assert.equal(result.tasks[0].branchDeleted, true);
    assert.equal(existsSync(task.delivery_workspace.workDir), false);
    const local = await runCommandFile("git", ["-C", projectRoot, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], projectRoot);
    assert.notEqual(local.exitCode, 0);
    assert.deepEqual(result.remoteBranches.map((item) => item.branch), [branch]);
    assert.match(result.remoteBranches[0].command, /^git push origin --delete /);
    assert.match(await git(reviewer, ["ls-remote", "--heads", "origin", branch]), new RegExp(branch), "remote branch stays until a human deletes it");

    assert.deepEqual((await attentionReport(projectRoot)).pendingCleanup, []);
    const again = await cleanupMergedTasks(projectRoot);
    assert.equal(again.tasks[0].status, "already_clean");
  });
});

test("cleanup recognizes a regular merge through ancestry", async () => {
  await withCompletedTask(async ({ projectRoot, reviewer, branch }) => {
    await git(reviewer, ["fetch", "-q", "origin", branch]);
    await git(reviewer, ["merge", "-q", "--no-ff", "-m", "Merge task", "FETCH_HEAD"]);
    await git(reviewer, ["push", "-q", "origin", "main"]);
    const result = await cleanupMergedTasks(projectRoot);
    assert.equal(result.tasks[0].status, "cleaned");
    assert.equal(result.tasks[0].mergedBy, "ancestor");
  });
});

test("cleanup retains unmerged and dirty task worktrees", async () => {
  await withCompletedTask(async ({ projectRoot, reviewer, task, branch }) => {
    const unmerged = await cleanupMergedTasks(projectRoot);
    assert.equal(unmerged.tasks[0].status, "retained");
    assert.equal(unmerged.tasks[0].reason, "not_merged");
    assert.ok(existsSync(task.delivery_workspace.workDir));

    await git(reviewer, ["fetch", "-q", "origin", branch]);
    await git(reviewer, ["merge", "--squash", "FETCH_HEAD"]);
    await git(reviewer, ["commit", "-q", "-m", "Squash task"]);
    await git(reviewer, ["push", "-q", "origin", "main"]);
    await writeFile(path.join(task.delivery_workspace.workDir, "scratch.txt"), "unsaved\n", "utf8");
    const dirty = await cleanupMergedTasks(projectRoot);
    assert.equal(dirty.tasks[0].status, "retained");
    assert.equal(dirty.tasks[0].reason, "worktree_dirty");
    assert.ok(existsSync(task.delivery_workspace.workDir));
  });
});
