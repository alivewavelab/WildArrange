import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { runCommand } from "../src/infra/command-runner.mjs";
import { runCommandFile } from "../src/infra/command-runner.mjs";
import { importPlan, loadTaskState } from "../src/orchestration/plan-state.mjs";
import { runNextTask } from "../src/orchestration/linear-runtime.mjs";
import { persistTaskState } from "../src/orchestration/task-board.mjs";
import { collectGitChangedPaths, changedPathsIntroducedByTask } from "../src/infra/git-diff.mjs";
import { readJson, resolveTaskAcceptancePath, resolveTaskCheckpointPath, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";

async function withGitFixture(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wa-delivery-regression-"));
  try {
    for (const args of [["init", "-b", "main"], ["config", "user.name", "Delivery Test"], ["config", "user.email", "delivery@example.invalid"]]) {
      const result = await runCommandFile("git", args, root);
      assert.equal(result.exitCode, 0, result.stderr);
    }
    await writeFile(path.join(root, ".gitignore"), ".wildarrange/\n");
    await writeFile(path.join(root, "worker.cjs"), "const fs=require('fs');const p='result.txt';const n=fs.existsSync(p)?Number(fs.readFileSync(p,'utf8'))+1:1;fs.writeFileSync(p,String(n));");
    await writeFile(path.join(root, "check.cjs"), "require('node:assert/strict').equal(require('node:fs').readFileSync('result.txt','utf8'),'1');");
    await writeFile(path.join(root, "review.cjs"), "const fs=require('node:fs');const assert=require('node:assert/strict');assert.equal(fs.statSync('result.txt').size,1);assert(!fs.existsSync('unexpected.txt'));\n");
    await writeFile(path.join(root, "wildarrange.config.json"), JSON.stringify({ gitCoordination: { mode: "guarded" } }));
    await runCommand("git add .", root);
    const commit = await runCommand("git commit -m baseline", root);
    assert.equal(commit.exitCode, 0, commit.stderr);
    await initRuntime(root);
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writePlan(root, tasks) {
  const planPath = path.join(root, "plan.json");
  await writeFile(planPath, JSON.stringify({ id: "delivery-regression", title: "Delivery regression", tasks }));
  return importPlan(root, planPath);
}

function realTask(overrides = {}) {
  return {
    id: "T001",
    subject: "produce reviewed result",
    owner: "ZhuRong",
    worker_command: "node worker.cjs",
    verify_commands: ["node check.cjs"],
    review_commands: ["node review.cjs"],
    writable_paths: ["result.txt"],
    ...overrides,
  };
}

test("linear checkpoint failure resumes the same delivery commit without rerunning worker", async () => {
  await withGitFixture(async (root) => {
    const plan = await writePlan(root, [realTask()]);
    const blockedCheckpointDir = resolveWildArrangePath(root, "checkpoints", plan.id);
    await writeFile(blockedCheckpointDir, "occupied\n");

    const blocked = await runNextTask(root);
    assert.equal(blocked.status, "recovery_required");
    assert.equal(blocked.task.status, "verifying");
    const deliverySha = blocked.task.delivery.integrationSha;
    assert.match(deliverySha, /^[0-9a-f]{40}$/);
    assert.equal(await readFile(path.join(blocked.task.delivery_workspace.workDir, "result.txt"), "utf8"), "1");

    await rm(blockedCheckpointDir, { force: true });
    await mkdir(blockedCheckpointDir, { recursive: true });
    const completed = await runNextTask(root);
    assert.equal(completed.status, "completed");
    assert.equal(await readFile(path.join(completed.task.delivery_workspace.workDir, "result.txt"), "utf8"), "1", "worker must not run again during checkpoint recovery");
    const proof = await readJson(resolveTaskAcceptancePath(root, plan.id, "T001"));
    const checkpoint = await readJson(resolveTaskCheckpointPath(root, plan.id, "T001"));
    assert.equal(proof.evidenceRefs.deliveryBaseline.commitSha, deliverySha);
    assert.equal(checkpoint.deliveryBaseline.integrationSha || checkpoint.deliveryBaseline.commitSha, deliverySha);
  });
});

test("checkpoint recovery cannot complete when freshly rerun gates fail", async () => {
  await withGitFixture(async (root) => {
    const plan = await writePlan(root, [realTask()]);
    const blockedCheckpointDir = resolveWildArrangePath(root, "checkpoints", plan.id);
    await writeFile(blockedCheckpointDir, "occupied\n");
    const blocked = await runNextTask(root);
    assert.equal(blocked.status, "recovery_required");
    await rm(blockedCheckpointDir, { force: true });
    await mkdir(blockedCheckpointDir, { recursive: true });
    await writeFile(path.join(blocked.task.delivery_workspace.workDir, "review.cjs"), "process.exit(1);\n");

    const rejected = await runNextTask(root);
    assert.equal(rejected.status, "recovery_required");
    assert.equal(rejected.task.status, "verifying");
    await assert.rejects(readJson(resolveTaskCheckpointPath(root, plan.id, "T001")), /ENOENT/);
  });
});

test("unconfirmed command termination remains recovery_required across automatic runs", async () => {
  await withGitFixture(async (root) => {
    await writePlan(root, [realTask()]);
    const state = await loadTaskState(root);
    const task = state.tasks[0];
    task.status = "verifying";
    task.owner = "ZhuRong";
    task.last_failure = {
      reason: "command_termination_failed",
      summary: "process state unknown",
      retryHint: "confirm process termination before recovery",
      commandEvidence: { pid: 4242, terminationFailed: true, recoveryRequired: true },
    };
    await persistTaskState(root, state);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await runNextTask(root);
      assert.equal(result.status, "recovery_required");
      const persisted = (await loadTaskState(root)).tasks[0];
      assert.equal(persisted.status, "verifying");
      assert.equal(persisted.owner, "ZhuRong");
      assert.equal(persisted.last_failure.commandEvidence.pid, 4242);
    }
  });
});

test("linear no-change delivery binds the dependency SHA without creating an empty commit", async () => {
  await withGitFixture(async (root) => {
    const plan = await writePlan(root, [
      realTask(),
      realTask({ id: "T002", blockedBy: ["T001"], subject: "inspect dependency", worker_command: "node check.cjs", writable_paths: [] }),
    ]);
    const first = await runNextTask(root);
    assert.equal(first.status, "completed");
    const firstSha = first.task.delivery.integrationSha;
    const second = await runNextTask(root);
    assert.equal(second.status, "completed");
    assert.equal(second.task.delivery.status, "no_change");
    assert.equal(second.task.delivery.integrationSha, firstSha);
    const proof = await readJson(resolveTaskAcceptancePath(root, plan.id, "T002"));
    assert.equal(proof.evidenceRefs.deliveryBaseline.commitSha, firstSha);
    assert.equal(proof.evidenceRefs.deliveryBaseline.noChange, true);
  });
});

test("Git change collection detects staged and same-path content changes", async () => {
  await withGitFixture(async (root) => {
    await writeFile(path.join(root, "index-only.txt"), "base");
    assert.equal((await runCommand("git add index-only.txt", root)).exitCode, 0);
    assert.equal((await runCommand("git commit -m index-baseline", root)).exitCode, 0);
    const clean = await collectGitChangedPaths(root);
    await writeFile(path.join(root, "index-only.txt"), "staged");
    assert.equal((await runCommand("git add index-only.txt", root)).exitCode, 0);
    await writeFile(path.join(root, "index-only.txt"), "base");
    const indexOnly = await collectGitChangedPaths(root);
    assert.deepEqual(indexOnly.paths, ["index-only.txt"]);
    assert.deepEqual(changedPathsIntroducedByTask(clean, indexOnly), ["index-only.txt"], "index blob changes remain visible when worktree bytes equal HEAD");

    assert.equal((await runCommandFile("git", ["restore", "--staged", "index-only.txt"], root)).exitCode, 0);
    await writeFile(path.join(root, "outside.txt"), "first");
    const before = await collectGitChangedPaths(root);
    await writeFile(path.join(root, "outside.txt"), "second");
    const after = await collectGitChangedPaths(root);
    assert.deepEqual(changedPathsIntroducedByTask(before, after), ["outside.txt"]);
    await runCommand("git add outside.txt", root);
    assert.deepEqual((await collectGitChangedPaths(root)).paths, ["outside.txt"]);

    const quotedPath = " 中文 spaced name.txt";
    await writeFile(path.join(root, quotedPath), "path evidence");
    assert.ok((await collectGitChangedPaths(root)).paths.includes(quotedPath), "NUL-delimited Git output preserves Unicode and leading spaces in paths");
  });
});

test("trivial review command cannot create proof or checkpoint", async () => {
  await withGitFixture(async (root) => {
    const plan = await writePlan(root, [realTask({ review_commands: ["echo reviewed"] })]);
    const result = await runNextTask(root);
    assert.notEqual(result.status, "completed");
    assert.notEqual((await loadTaskState(root)).tasks[0].status, "completed");
    await assert.rejects(readJson(resolveTaskCheckpointPath(root, plan.id, "T001")), /ENOENT/);
  });
});
