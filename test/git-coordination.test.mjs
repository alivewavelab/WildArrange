import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  acceptTaskHandoff,
  admitParallelAgentResult,
  assertCurrentTaskOwnership,
  claimTeamTask,
  closeParallelAgentRun,
  coordinateTaskClaim,
  coordinationStatus,
  importPlan,
  initRuntime,
  loadHelixConfig,
  loadTaskState,
  persistTaskState,
  readJson,
  prepareTaskHandoff,
  pushTaskHandoff,
  registerCoordinationDevice,
  runParallelAgents,
  runNextTask,
  runWorkflowNode,
  takeoverTaskOwnership,
} from "../src/helix-core.mjs";
import {
  captureIntegrationGuard,
  pushCommit,
  verifyIntegrationGuard,
} from "../src/infra/git-coordination.mjs";
import {
  integrateAdmissionCommit,
  readIntegrationIntent,
} from "../src/orchestration/integration.mjs";

const execFileAsync = promisify(execFile);

test("git coordination defaults to guarded and strict mode restores mandatory safety flags", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const defaults = await loadHelixConfig(dir);
    assert.equal(defaults.config.gitCoordination.mode, "guarded");
    assert.equal(defaults.config.gitCoordination.requireWorktreeForParallelWrites, true);

    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      gitCoordination: { mode: "guarded", requireTakeoverReason: false },
    }), "utf8");
    const guarded = await loadHelixConfig(dir);
    assert.equal(guarded.config.gitCoordination.requireTakeoverReason, true);

    await writeFile(path.join(dir, "helix.config.json"), JSON.stringify({
      gitCoordination: {
        mode: "strict",
        requireWorktreeForParallelWrites: false,
        requireVerificationBeforeHandoff: false,
        requireCleanHandoff: false,
        requireTakeoverReason: false,
      },
    }), "utf8");
    const strict = await loadHelixConfig(dir);
    assert.equal(strict.config.gitCoordination.mode, "strict");
    assert.equal(strict.config.gitCoordination.requireWorktreeForParallelWrites, true);
    assert.equal(strict.config.gitCoordination.requireVerificationBeforeHandoff, true);
    assert.equal(strict.config.gitCoordination.requireCleanHandoff, true);
    assert.equal(strict.config.gitCoordination.requireTakeoverReason, true);
  });
});

test("off and manual modes do not claim remotely unless manual is explicitly forced", async () => {
  await withRemoteClones(async ({ cloneA }) => {
    await initializeTaskRuntime(cloneA, "device-a");
    const state = await loadTaskState(cloneA);
    const task = state.tasks[0];

    await writeFile(path.join(cloneA, "helix.config.json"), JSON.stringify({
      gitCoordination: { mode: "off" },
    }), "utf8");
    const disabled = await coordinateTaskClaim(cloneA, {
      planId: state.planId,
      task,
      owner: "ZhuRong",
    });
    assert.equal(disabled.status, "disabled");

    await writeFile(path.join(cloneA, "helix.config.json"), JSON.stringify({
      gitCoordination: { mode: "manual" },
    }), "utf8");
    const manual = await coordinateTaskClaim(cloneA, {
      planId: state.planId,
      task,
      owner: "ZhuRong",
    });
    assert.equal(manual.status, "manual");
    const forced = await coordinateTaskClaim(cloneA, {
      planId: state.planId,
      task,
      owner: "ZhuRong",
      force: true,
    });
    assert.equal(forced.status, "claimed");
  });
});

test("adversarial round 1: concurrent device claims produce exactly one remote write owner", async () => {
  await withRemoteClones(async ({ cloneA, cloneB }) => {
    await initializeTaskRuntime(cloneA, "device-a");
    await initializeTaskRuntime(cloneB, "device-b");

    const outcomes = await Promise.allSettled([
      claimTeamTask(cloneA, { taskId: "T001", owner: "ZhuRong" }),
      claimTeamTask(cloneB, { taskId: "T001", owner: "ZhuRong" }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    const winner = outcomes.find((outcome) => outcome.status === "fulfilled").value;
    assert.equal(winner.task.coordination.status, "claimed");
    assert.match(winner.task.coordination.branch, /^wildarrange\/task\/P-GIT\/T001$/);
    assert.match(
      outcomes.find((outcome) => outcome.status === "rejected").reason.message,
      /already claimed|claim lost/i,
    );
  });
});

test("handoff commit transfers the task and makes the previous device fail closed", async () => {
  await withRemoteClones(async ({ cloneA, cloneB }) => {
    await initializeTaskRuntime(cloneA, "device-a");
    const deviceB = await initializeTaskRuntime(cloneB, "device-b");
    const claimed = await claimTeamTask(cloneA, { taskId: "T001", owner: "ZhuRong" });
    await mkdir(path.join(cloneA, "src"), { recursive: true });
    await writeFile(path.join(cloneA, "src", "task.txt"), "handoff payload\n", "utf8");
    await writeFile(path.join(cloneA, ".helix", "tracked-runtime.json"), "{\"local\":true}\n", "utf8");
    await git(cloneA, ["add", "src/task.txt"]);
    await git(cloneA, ["add", "-f", ".helix/tracked-runtime.json"]);
    await git(cloneA, ["-c", "user.name=Device A", "-c", "user.email=a@example.invalid", "commit", "-m", "committed task payload"]);

    const prepared = await prepareTaskHandoff(cloneA, {
      taskId: "T001",
      toDeviceId: deviceB.deviceId,
      toDeviceName: "device-b",
    });
    assert.equal(prepared.status, "prepared");
    assert.deepEqual(prepared.changedPaths, ["src/task.txt"]);
    assert.equal(prepared.omittedPaths.includes(".helix/tracked-runtime.json"), false);
    assert.deepEqual(prepared.runtimePathsExcluded, [".helix/tracked-runtime.json"]);
    await git(cloneA, ["push", "origin", `${prepared.checkpointSha}:refs/heads/${prepared.branch}`]);
    const pushed = await pushTaskHandoff(cloneA, { taskId: "T001" });
    assert.equal(pushed.status, "pushed");
    assert.equal(pushed.reconciled, true);
    const pushedAgain = await pushTaskHandoff(cloneA, { taskId: "T001" });
    assert.equal(pushedAgain.status, "pushed");
    assert.equal(pushedAgain.reconciled, true);
    const pushEvents = (await readLedger(cloneA)).filter(
      (entry) => entry.type === "task_handoff_pushed" && entry.taskId === "T001",
    );
    assert.equal(pushEvents.length, 1);
    await assert.rejects(
      () => assertCurrentTaskOwnership(cloneA, claimed.task),
      /remote ownership changed|not writable/i,
    );

    const accepted = await acceptTaskHandoff(cloneB, { planId: "P-GIT", taskId: "T001" });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.task.coordination.deviceName, "device-b");
    assert.equal(accepted.task.coordination.remoteHeadSha, accepted.acceptSha);
    assert.equal(await readFile(path.join(cloneB, "src", "task.txt"), "utf8"), "handoff payload\n");
    await assert.rejects(
      readFile(path.join(cloneB, ".helix", "tracked-runtime.json"), "utf8"),
      /ENOENT/,
    );

    const stateB = await loadTaskState(cloneB);
    assert.equal(stateB.tasks[0].status, "in_progress");
    assert.equal(stateB.tasks[0].coordination.deviceName, "device-b");
    const resumedAccept = await acceptTaskHandoff(cloneB, { planId: "P-GIT", taskId: "T001" });
    assert.equal(resumedAccept.resumed, true);
    assert.equal(resumedAccept.acceptSha, accepted.acceptSha);
    const handoffRecord = await readJson(path.join(cloneB, ".helix", "coordination", "handoffs", "T001.json"), null);
    assert.equal(handoffRecord.status, "accepted");
    const acceptedEvents = (await readLedger(cloneB)).filter(
      (entry) => entry.type === "task_handoff_accepted" && entry.taskId === "T001",
    );
    assert.equal(acceptedEvents.length, 1);
    await assert.rejects(
      async () => assertCurrentTaskOwnership(cloneA, (await loadTaskState(cloneA)).tasks[0]),
      /not writable|remote ownership changed/i,
    );
    await assert.rejects(
      () => runWorkflowNode(cloneA, "verify", { taskId: "T001" }),
      /not writable|remote ownership changed/i,
    );
    await assert.rejects(
      () => runWorkflowNode(cloneA, "scope", { taskId: "T001" }),
      /not writable|remote ownership changed/i,
    );
    await assert.rejects(
      () => runWorkflowNode(cloneA, "review", { taskId: "T001" }),
      /not writable|remote ownership changed/i,
    );
    await assert.rejects(
      () => runWorkflowNode(cloneA, "checkpoint", { taskId: "T001" }),
      /not writable|remote ownership changed/i,
    );
  });
});

test("old device cannot admit a retained child result after handoff", async () => {
  await withRemoteClones(async ({ cloneA, cloneB }) => {
    await initializeTaskRuntime(cloneA, "device-a");
    const deviceB = await initializeTaskRuntime(cloneB, "device-b");
    const command = resultCommand("src/stale.txt", "stale\n");
    const batch = await runParallelAgents(cloneA, { taskIds: ["T001"], agent: "ZhuRong", command });
    await claimTeamTask(cloneA, { taskId: "T001", owner: "ZhuRong" });
    await prepareTaskHandoff(cloneA, {
      taskId: "T001",
      toDeviceId: deviceB.deviceId,
      toDeviceName: "device-b",
    });
    await pushTaskHandoff(cloneA, { taskId: "T001" });
    await acceptTaskHandoff(cloneB, { planId: "P-GIT", taskId: "T001" });

    await assert.rejects(
      () => admitParallelAgentResult(cloneA, { runId: batch.runId, taskId: "T001" }),
      /not writable|remote ownership changed/i,
    );
    await assert.rejects(readFile(path.join(cloneA, "src", "stale.txt"), "utf8"), /ENOENT/);
  });
});

test("handoff push refuses source changes made after prepare", async () => {
  await withRemoteClones(async ({ cloneA, cloneB }) => {
    await initializeTaskRuntime(cloneA, "device-a");
    const deviceB = await initializeTaskRuntime(cloneB, "device-b");
    await claimTeamTask(cloneA, { taskId: "T001", owner: "ZhuRong" });
    await mkdir(path.join(cloneA, "src"), { recursive: true });
    await writeFile(path.join(cloneA, "src", "task.txt"), "prepared\n", "utf8");
    await prepareTaskHandoff(cloneA, {
      taskId: "T001",
      toDeviceId: deviceB.deviceId,
    });
    await writeFile(path.join(cloneA, "src", "task.txt"), "changed after prepare\n", "utf8");
    await assert.rejects(
      () => pushTaskHandoff(cloneA, { taskId: "T001" }),
      /workspace changed after prepare/i,
    );
  });
});

test("guarded mode gives writable parallel agents a worktree and one local run owner", async () => {
  await withRemoteClones(async ({ cloneA }) => {
    await initializeTaskRuntime(cloneA, "device-a");
    const command = [
      "node -e",
      JSON.stringify("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'ready',files:[{path:'src/task.txt',content:'ok\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
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

test("adversarial round 2: integration guard rejects a stale remote main SHA", async () => {
  await withRemoteClones(async ({ cloneA, cloneB }) => {
    await initRuntime(cloneA);
    const { config } = await loadHelixConfig(cloneA);
    const guard = await captureIntegrationGuard(cloneA, config.gitCoordination);
    assert.equal(guard.active, true);

    await writeFile(path.join(cloneB, "remote-change.txt"), "changed elsewhere\n", "utf8");
    await git(cloneB, ["add", "remote-change.txt"]);
    await git(cloneB, ["-c", "user.name=Device B", "-c", "user.email=b@example.invalid", "commit", "-m", "remote change"]);
    await git(cloneB, ["push", "origin", "main"]);

    const verified = await verifyIntegrationGuard(cloneA, guard);
    assert.equal(verified.pass, false);
    assert.equal(verified.expectedSha, guard.expectedSha);
    assert.notEqual(verified.actualSha, guard.expectedSha);
  });
});

test("adversarial round 2 integration: admission rolls back before checkpoint when remote main changes during gates", async () => {
  await withRemoteClones(async ({ cloneA, cloneB }) => {
    await initRuntime(cloneA);
    await registerCoordinationDevice(cloneA, { name: "device-a", force: true });
    const advanceScript = path.join(cloneA, ".helix", "artifacts", "advance-remote.cjs");
    await mkdir(path.dirname(advanceScript), { recursive: true });
    await writeFile(advanceScript, [
      "const { execFileSync } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const path = require('node:path');",
      `const other = ${JSON.stringify(cloneB)};`,
      "writeFileSync(path.join(other, 'remote-race.txt'), 'race\\n');",
      "execFileSync('git', ['-C', other, 'add', 'remote-race.txt']);",
      "execFileSync('git', ['-C', other, '-c', 'user.name=Device B', '-c', 'user.email=b@example.invalid', 'commit', '-m', 'integration race']);",
      "execFileSync('git', ['-C', other, 'push', 'origin', 'main']);",
    ].join("\n"), "utf8");
    const planPath = path.join(cloneA, ".helix", "artifacts", "admission-race-plan.json");
    await writeFile(planPath, JSON.stringify({
      id: "P-RACE",
      title: "Admission remote race",
      objective: "A stale integration result must never checkpoint.",
      tasks: [{
        id: "T001",
        subject: "Race remote main",
        writable_paths: ["src/**"],
        verify_commands: [`node ${JSON.stringify(advanceScript)}`],
        review_commands: ["node --version"],
      }],
    }, null, 2), "utf8");
    await importPlan(cloneA, planPath);
    const command = [
      "node -e",
      JSON.stringify("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'ready',files:[{path:'src/admit.txt',content:'ok\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(cloneA, { taskIds: ["T001"], agent: "ZhuRong", command });
    const admitted = await admitParallelAgentResult(cloneA, { runId: batch.runId, taskId: "T001" });
    assert.equal(admitted.status, "revalidation_required");
    assert.equal(admitted.rollback.status, "rolled_back");
    await assert.rejects(readFile(path.join(cloneA, "src", "admit.txt"), "utf8"), /ENOENT/);
    await assert.rejects(
      readFile(path.join(cloneA, ".helix", "checkpoints", "P-RACE-T001.json"), "utf8"),
      /ENOENT/,
    );
    const state = await loadTaskState(cloneA);
    assert.equal(state.tasks[0].status, "pending");
    assert.equal(state.tasks[0].last_failure.reason, "integration_head_changed");
  });
});

test("successful admission creates and non-force pushes an integration commit to remote main", async () => {
  await withRemoteClones(async ({ remote, cloneA }) => {
    await initializeTaskRuntime(cloneA, "device-a");
    const before = (await git(remote, ["rev-parse", "main"])).trim();
    const batch = await runParallelAgents(cloneA, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command: resultCommand("src/integrated.txt", "integrated\n"),
    });
    const admitted = await admitParallelAgentResult(cloneA, { runId: batch.runId, taskId: "T001" });
    assert.equal(admitted.status, "completed");
    const after = (await git(remote, ["rev-parse", "main"])).trim();
    assert.notEqual(after, before);
    assert.equal(await git(remote, ["show", `${after}:src/integrated.txt`]), "integrated\n");
    const intent = await readJson(
      path.join(cloneA, ".helix", "agent-runs", batch.runId, "T001.integration.json"),
      null,
    );
    assert.equal(intent.status, "pushed");
    assert.equal(intent.integrationSha, after);
    assert.equal(intent.actualSha, after);
    assert.equal(admitted.integrationCommit.actualSha, after);
  });
});

test("lost integration push response reconciles when remote main already advanced to a descendant", async () => {
  await withRemoteClones(async ({ remote, cloneA, cloneB }) => {
    await initializeTaskRuntime(cloneA, "device-a");
    const claimed = await claimTeamTask(cloneA, { taskId: "T001", owner: "ZhuRong" });
    const { config } = await loadHelixConfig(cloneA);
    const integrationGuard = await captureIntegrationGuard(cloneA, config.gitCoordination, { force: true });
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
      integrationGuard,
      pushCommitFn: async (rootDir, pushOptions) => {
        const pushed = await pushCommit(rootDir, pushOptions);
        assert.equal(pushed.ok, true);
        integrationSha = pushOptions.commitSha;
        await git(cloneB, ["pull", "--ff-only", "origin", "main"]);
        await writeFile(path.join(cloneB, "after-lost-response.txt"), "descendant\n", "utf8");
        await git(cloneB, ["add", "after-lost-response.txt"]);
        await git(cloneB, ["-c", "user.name=Device B", "-c", "user.email=b@example.invalid", "commit", "-m", "advance after accepted push"]);
        await git(cloneB, ["push", "origin", "main"]);
        descendantSha = (await git(remote, ["rev-parse", "main"])).trim();
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
    await initializeTaskRuntime(cloneA, "device-a");
    const claimed = await claimTeamTask(cloneA, { taskId: "T001", owner: "ZhuRong" });
    const { config } = await loadHelixConfig(cloneA);
    const integrationGuard = await captureIntegrationGuard(cloneA, config.gitCoordination, { force: true });
    await mkdir(path.join(cloneA, "src"), { recursive: true });
    await writeFile(path.join(cloneA, "src", "unknown-push.txt"), "keep until resolved\n", "utf8");
    const runId = "agent_run_unknown_push";
    const options = {
      planId: "P-GIT",
      taskId: "T001",
      task: claimed.task,
      runId,
      changedPaths: ["src/unknown-push.txt"],
      integrationGuard,
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
        assert.fail("an unresolved push must not be retried while its fences are unreachable");
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
    await initializeTaskRuntime(cloneA, "device-a");
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

test("checkpoint failure after remote integration keeps ownership and resumes without a second push", async () => {
  await withRemoteClones(async ({ remote, cloneA, cloneB }) => {
    await initializeTaskRuntime(cloneA, "device-a");
    const batch = await runParallelAgents(cloneA, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command: resultCommand("src/recover.txt", "recover\n"),
    });
    const checkpointsDir = path.join(cloneA, ".helix", "checkpoints");
    await chmod(checkpointsDir, 0o555);
    let first;
    try {
      first = await admitParallelAgentResult(cloneA, { runId: batch.runId, taskId: "T001" });
    } finally {
      await chmod(checkpointsDir, 0o755);
    }
    assert.equal(first.status, "recovery_required");
    assert.equal(first.rollback.reason, "remote_integration_already_pushed");
    const integratedSha = (await git(remote, ["rev-parse", "main"])).trim();
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

test("pushed integration is never rolled back when task ownership changes before recovery", async () => {
  await withRemoteClones(async ({ cloneA, cloneB }) => {
    const deviceA = await initializeTaskRuntime(cloneA, "device-a");
    await initializeTaskRuntime(cloneB, "device-b");
    const { batch } = await createCheckpointFailureAfterIntegration(cloneA, "src/owned-recovery.txt");
    await takeoverTaskOwnership(cloneB, {
      planId: "P-GIT",
      taskId: "T001",
      expectedDeviceId: deviceA.deviceId,
      reason: "adversarial transfer after remote integration",
    });
    const retried = await admitParallelAgentResult(cloneA, { runId: batch.runId, taskId: "T001" });
    assert.equal(retried.status, "recovery_required");
    assert.equal(retried.rollback.status, "not_attempted");
    assert.equal(await readFile(path.join(cloneA, "src", "owned-recovery.txt"), "utf8"), "recover\n");
    const state = await loadTaskState(cloneA);
    assert.equal(state.tasks[0].status, "verifying");
    assert.equal(state.tasks[0].admission_claim.runId, batch.runId);
  });
});

test("pushed integration is never silently re-pushed or rolled back after remote history rewrite", async () => {
  await withRemoteClones(async ({ remote, cloneA, cloneB }) => {
    await initializeTaskRuntime(cloneA, "device-a");
    const before = (await git(remote, ["rev-parse", "main"])).trim();
    const { batch, integratedSha } = await createCheckpointFailureAfterIntegration(cloneA, "src/rewrite-recovery.txt");
    assert.notEqual(integratedSha, before);
    await git(cloneB, ["push", "--force", "origin", `${before}:refs/heads/main`]);

    const retried = await admitParallelAgentResult(cloneA, { runId: batch.runId, taskId: "T001" });
    assert.equal(retried.status, "recovery_required");
    assert.equal(retried.rollback.status, "not_attempted");
    assert.equal((await git(remote, ["rev-parse", "main"])).trim(), before);
    assert.equal(await readFile(path.join(cloneA, "src", "rewrite-recovery.txt"), "utf8"), "recover\n");
  });
});

test("admission refuses a stale local base even when remote main was stable during gates", async () => {
  await withRemoteClones(async ({ cloneA, cloneB }) => {
    await initializeTaskRuntime(cloneA, "device-a");
    const batch = await runParallelAgents(cloneA, {
      taskIds: ["T001"],
      agent: "ZhuRong",
      command: resultCommand("src/stale-base.txt", "stale base\n"),
    });
    await writeFile(path.join(cloneB, "advanced-before-admit.txt"), "new main\n", "utf8");
    await git(cloneB, ["add", "advanced-before-admit.txt"]);
    await git(cloneB, ["-c", "user.name=Device B", "-c", "user.email=b@example.invalid", "commit", "-m", "advance before admission"]);
    await git(cloneB, ["push", "origin", "main"]);

    const admitted = await admitParallelAgentResult(cloneA, { runId: batch.runId, taskId: "T001" });
    assert.equal(admitted.status, "revalidation_required");
    assert.equal(admitted.task.last_failure.reason, "integration_base_not_present_in_workspace");
    assert.equal(admitted.rollback.status, "rolled_back");
    await assert.rejects(readFile(path.join(cloneA, "src", "stale-base.txt"), "utf8"), /ENOENT/);
  });
});

test("two devices integrating different tasks race safely: one completes and one revalidates", async () => {
  await withRemoteClones(async ({ cloneA, cloneB }) => {
    await initializeTaskRuntime(cloneA, "device-a", ["T001", "T002"]);
    await initializeTaskRuntime(cloneB, "device-b", ["T001", "T002"]);
    const [batchA, batchB] = await Promise.all([
      runParallelAgents(cloneA, {
        taskIds: ["T001"],
        agent: "ZhuRong",
        command: resultCommand("src/from-a.txt", "a\n"),
      }),
      runParallelAgents(cloneB, {
        taskIds: ["T002"],
        agent: "ZhuRong",
        command: resultCommand("src/from-b.txt", "b\n"),
      }),
    ]);
    const outcomes = await Promise.all([
      admitParallelAgentResult(cloneA, { runId: batchA.runId, taskId: "T001" }),
      admitParallelAgentResult(cloneB, { runId: batchB.runId, taskId: "T002" }),
    ]);
    assert.equal(outcomes.filter((result) => result.status === "completed").length, 1);
    assert.equal(outcomes.filter((result) => result.status === "revalidation_required").length, 1);
  });
});

test("a device with the same display name cannot accept a handoff addressed to another UUID", async () => {
  await withRemoteClones(async ({ dir, remote, cloneA, cloneB }) => {
    await initializeTaskRuntime(cloneA, "device-a");
    const target = await initializeTaskRuntime(cloneB, "shared-name");
    const impostorDir = path.join(dir, "device-impostor");
    await git(dir, ["clone", remote, impostorDir]);
    const impostor = await initializeTaskRuntime(impostorDir, "shared-name");
    assert.notEqual(impostor.deviceId, target.deviceId);

    await claimTeamTask(cloneA, { taskId: "T001", owner: "ZhuRong" });
    await prepareTaskHandoff(cloneA, {
      taskId: "T001",
      toDeviceId: target.deviceId,
      toDeviceName: "shared-name",
    });
    await pushTaskHandoff(cloneA, { taskId: "T001" });
    await assert.rejects(
      () => acceptTaskHandoff(impostorDir, { planId: "P-GIT", taskId: "T001" }),
      /targets deviceId/i,
    );
    const accepted = await acceptTaskHandoff(cloneB, { planId: "P-GIT", taskId: "T001" });
    assert.equal(accepted.device.deviceId, target.deviceId);
  });
});

test("takeover is idempotently recoverable by the same device and old expected UUID", async () => {
  await withRemoteClones(async ({ cloneA, cloneB }) => {
    const deviceA = await initializeTaskRuntime(cloneA, "device-a");
    await initializeTaskRuntime(cloneB, "device-b");
    await claimTeamTask(cloneA, { taskId: "T001", owner: "ZhuRong" });
    const first = await takeoverTaskOwnership(cloneB, {
      planId: "P-GIT",
      taskId: "T001",
      expectedDeviceId: deviceA.deviceId,
      reason: "test confirmed old device stopped",
    });
    assert.equal(first.status, "accepted");
    const resumed = await takeoverTaskOwnership(cloneB, {
      planId: "P-GIT",
      taskId: "T001",
      expectedDeviceId: deviceA.deviceId,
      reason: "test confirmed old device stopped",
    });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.takeoverSha, first.takeoverSha);
    const events = (await readLedger(cloneB)).filter(
      (entry) => entry.type === "task_ownership_taken_over" && entry.taskId === "T001",
    );
    assert.equal(events.length, 1);
  });
});

test("monolithic linear run cannot complete after another device takes ownership mid-worker", async () => {
  await withRemoteClones(async ({ cloneA, cloneB }) => {
    const deviceA = await initializeTaskRuntime(cloneA, "device-a");
    await initializeTaskRuntime(cloneB, "device-b");
    const plan = {
      id: "P-LINEAR-RACE",
      title: "Linear ownership race",
      objective: "Old device must not checkpoint.",
      tasks: [{
        id: "T001",
        subject: "Long worker",
        worker_command: "node -e \"setTimeout(()=>{require('fs').mkdirSync('src',{recursive:true});require('fs').writeFileSync('src/old-linear.txt','old\\\\n')},700)\"",
        writable_paths: ["src/**"],
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    };
    await importPlanDefinition(cloneA, plan);
    await importPlanDefinition(cloneB, plan);

    const running = runNextTask(cloneA);
    await waitForRemoteTaskBranch(cloneB, "wildarrange/task/P-LINEAR-RACE/T001");
    await takeoverTaskOwnership(cloneB, {
      planId: "P-LINEAR-RACE",
      taskId: "T001",
      expectedDeviceId: deviceA.deviceId,
      reason: "adversarial ownership transfer during worker",
    });
    const result = await running;
    assert.equal(result.status, "revalidation_required");
    await assert.rejects(
      readFile(path.join(cloneA, ".helix", "checkpoints", "P-LINEAR-RACE-T001.json"), "utf8"),
      /ENOENT/,
    );
    const stateA = await loadTaskState(cloneA);
    assert.equal(stateA.tasks[0].status, "pending");
    assert.equal(stateA.tasks[0].coordination.status, "stale");
  });
});

test("strict mode rejects a missing configured integration branch", async () => {
  await withRemoteClones(async ({ cloneA }) => {
    await initRuntime(cloneA);
    await writeFile(path.join(cloneA, "helix.config.json"), JSON.stringify({
      gitCoordination: { mode: "strict", integrationBranch: "does-not-exist" },
    }), "utf8");
    const { config } = await loadHelixConfig(cloneA);
    await assert.rejects(
      () => captureIntegrationGuard(cloneA, config.gitCoordination),
      /strict mode.*does not exist/i,
    );
  });
});

test("a remote claim without local task persistence is reconciled by the same device", async () => {
  await withRemoteClones(async ({ cloneA }) => {
    await initializeTaskRuntime(cloneA, "device-a");
    const initialState = await loadTaskState(cloneA);
    const remoteOnly = await coordinateTaskClaim(cloneA, {
      planId: initialState.planId,
      task: initialState.tasks[0],
      owner: "ZhuRong",
    });
    assert.equal(remoteOnly.status, "claimed");

    const claimed = await claimTeamTask(cloneA, { taskId: "T001", owner: "ZhuRong" });
    assert.equal(claimed.task.coordination.reconciled, true);
    assert.equal(claimed.task.coordination.remoteHeadSha, remoteOnly.remoteHeadSha);
  });
});

test("multi-task partial remote claim failure remains visible and locally recoverable", async () => {
  await withRemoteClones(async ({ cloneA, cloneB }) => {
    await initializeTaskRuntime(cloneA, "device-a", ["T001", "T002"]);
    await initializeTaskRuntime(cloneB, "device-b", ["T001", "T002"]);
    await claimTeamTask(cloneB, { taskId: "T002", owner: "ZhuRong" });

    await assert.rejects(
      () => runParallelAgents(cloneA, {
        taskIds: ["T001", "T002"],
        agent: "ZhuRong",
        command: resultCommand("src/{taskId}.txt", "ok\n"),
      }),
      /already claimed|claim lost/i,
    );
    const stateA = await loadTaskState(cloneA);
    const taskA = stateA.tasks.find((task) => task.id === "T001");
    assert.equal(taskA.coordination.status, "claimed");
    assert.equal(taskA.parallel_run_claim, null);
    const batchFiles = (await readdir(path.join(cloneA, ".helix", "agent-runs")))
      .filter((name) => name.endsWith(".json") && name !== "index.json");
    const batches = await Promise.all(batchFiles.map((name) =>
      readJson(path.join(cloneA, ".helix", "agent-runs", name), null)));
    assert.equal(batches.some((batch) => batch?.status === "claim_failed"), true);
    const recovered = await claimTeamTask(cloneA, { taskId: "T001", owner: "ZhuRong" });
    assert.equal(recovered.task.coordination.remoteHeadSha, taskA.coordination.remoteHeadSha);
  });
});

test("parallel close releases a crash-orphaned claim even when the run has no results", async () => {
  await withRemoteClones(async ({ cloneA }) => {
    await initializeTaskRuntime(cloneA, "device-a");
    const state = await loadTaskState(cloneA);
    state.tasks[0].parallel_run_claim = {
      runId: "agent_run_crashed",
      owner: "ZhuRong",
      claimedAt: new Date().toISOString(),
    };
    await persistTaskState(cloneA, state);
    await writeFile(
      path.join(cloneA, ".helix", "agent-runs", "index.json"),
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

test("device and coordination CLI commands expose the stable UUID and active mode", async () => {
  await withRemoteClones(async ({ cloneA }) => {
    await initRuntime(cloneA);
    const binPath = path.resolve("bin/helix.mjs");
    const registered = JSON.parse((await execFileAsync(
      process.execPath,
      [binPath, "device", "register", "--name", "cli-device", "--force"],
      { cwd: cloneA, encoding: "utf8" },
    )).stdout);
    assert.match(registered.deviceId, /^[0-9a-f-]{36}$/i);
    const status = JSON.parse((await execFileAsync(
      process.execPath,
      [binPath, "coordination", "status"],
      { cwd: cloneA, encoding: "utf8" },
    )).stdout);
    assert.equal(status.mode, "guarded");
    assert.equal(status.device.deviceId, registered.deviceId);
    assert.equal(status.git.active, true);
    const direct = await coordinationStatus(cloneA);
    assert.equal(direct.device.deviceId, registered.deviceId);
  });
});

async function initializeTaskRuntime(rootDir, deviceName, taskIds = ["T001"]) {
  await initRuntime(rootDir);
  const device = await registerCoordinationDevice(rootDir, { name: deviceName, force: true });
  const planPath = path.join(rootDir, ".helix", "artifacts", "coordination-plan.json");
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify({
    id: "P-GIT",
    title: "Git coordination",
    objective: "Only one device writes a task and handoff is durable.",
    tasks: taskIds.map((taskId) => ({
      id: taskId,
      subject: `Coordinate task ${taskId}`,
      writable_paths: ["src/**"],
      verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
      review_commands: ["node --version"],
    })),
  }, null, 2), "utf8");
  await importPlan(rootDir, planPath);
  return device;
}

async function importPlanDefinition(rootDir, plan) {
  const planPath = path.join(rootDir, ".helix", "artifacts", `${plan.id}.json`);
  await writeFile(planPath, JSON.stringify(plan, null, 2), "utf8");
  await importPlan(rootDir, planPath);
}

async function createCheckpointFailureAfterIntegration(rootDir, filePath) {
  const batch = await runParallelAgents(rootDir, {
    taskIds: ["T001"],
    agent: "ZhuRong",
    command: resultCommand(filePath, "recover\n"),
  });
  const checkpointsDir = path.join(rootDir, ".helix", "checkpoints");
  await chmod(checkpointsDir, 0o555);
  let result;
  try {
    result = await admitParallelAgentResult(rootDir, { runId: batch.runId, taskId: "T001" });
  } finally {
    await chmod(checkpointsDir, 0o755);
  }
  assert.equal(result.status, "recovery_required");
  const intent = await readJson(
    path.join(rootDir, ".helix", "agent-runs", batch.runId, "T001.integration.json"),
    null,
  );
  assert.equal(intent.status, "pushed");
  return { batch, result, integratedSha: intent.integrationSha };
}

async function waitForRemoteTaskBranch(rootDir, branch) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const output = await git(rootDir, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
    if (output.trim()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for remote task branch ${branch}`);
}

function resultCommand(filePath, content) {
  return [
    "node -e",
    JSON.stringify(`const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'ready',files:[{path:${JSON.stringify(filePath)},content:${JSON.stringify(content)}}]}));`),
    "{outputJson}",
  ].join(" ");
}

async function readLedger(rootDir) {
  const raw = await readFile(path.join(rootDir, ".helix", "ledger.jsonl"), "utf8");
  return raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function withRemoteClones(fn) {
  await withTempDir(async (dir) => {
    const remote = path.join(dir, "origin.git");
    const seed = path.join(dir, "seed");
    const cloneA = path.join(dir, "device-a");
    const cloneB = path.join(dir, "device-b");
    await git(dir, ["init", "--bare", "--initial-branch=main", remote]);
    await git(dir, ["init", "--initial-branch=main", seed]);
    await writeFile(path.join(seed, "README.md"), "seed\n", "utf8");
    await git(seed, ["add", "README.md"]);
    await git(seed, ["-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "commit", "-m", "initial"]);
    await git(seed, ["remote", "add", "origin", remote]);
    await git(seed, ["push", "-u", "origin", "main"]);
    await git(dir, ["clone", remote, cloneA]);
    await git(dir, ["clone", remote, cloneB]);
    await fn({ dir, remote, cloneA, cloneB });
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
  const dir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-git-coordination-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
