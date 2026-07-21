/**
 * Adversarial fault injection: a checkpoint write that fails must never be
 * silently absorbed into a "completed" outcome (cross-review P0, 2026-07-21).
 * The gateway converts capability throws into fail envelopes, so every
 * completion path has to check the checkpoint envelope status explicitly.
 *
 * Sabotage technique: chmod the pre-created .helix/checkpoints directory to
 * read-only (0o555). ensureHelixDirs' recursive mkdir tolerates an existing
 * read-only dir, but writeJsonAtomic's temp-file write inside it fails with
 * EACCES — exactly the "disk said no at the last moment" scenario.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runDeliveryPipeline } from "../src/orchestration/delivery-pipeline.mjs";
import { persistTaskState } from "../src/orchestration/task-board.mjs";
import {
  admitParallelAgentResult,
  importPlan,
  initRuntime,
  loadTaskState,
  parallelAgentStatus,
  readJson,
  resolveHelixPath,
  runCommand,
  runDoctor,
  runNextTask,
  runParallelAgents,
  runWorkflowNode,
} from "../src/helix-core.mjs";

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-ckpt-"));
  try {
    await fn(dir);
  } finally {
    // Undo any read-only sabotage (checkpoints/team/agent-run dirs, ledger)
    // so cleanup can delete the tree even when an assertion failed mid-test.
    await runCommand(`chmod -R u+w ${JSON.stringify(dir)}`, dir, 30_000).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

function nodeEval(source) {
  return `node -e ${JSON.stringify(source.replace(/\s*\n\s*/g, " ").trim())}`;
}

async function sabotageCheckpoints(dir) {
  await chmod(resolveHelixPath(dir, "checkpoints"), 0o555);
}

async function repairCheckpoints(dir) {
  await chmod(resolveHelixPath(dir, "checkpoints"), 0o755);
}

async function importPassingPlan(dir, planFileName = "ckpt-plan.json") {
  const planPath = resolveHelixPath(dir, "artifacts", planFileName);
  await writeFile(planPath, JSON.stringify({
    title: "Checkpoint integrity",
    tasks: [
      {
        id: "T001",
        subject: "Task whose gates all pass",
        worker_command: nodeEval("process.exit(0)"),
        verify_commands: [nodeEval("process.exit(0)")],
        writable_paths: ["src/**"],
      },
    ],
  }, null, 2));
  return importPlan(dir, planPath);
}

test("adversarial: delivery pipeline reports checkpoint_failed instead of completed when the checkpoint write fails", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    const plan = await importPassingPlan(dir);
    const taskState = await loadTaskState(dir);
    const task = taskState.tasks.find((candidate) => candidate.id === "T001");

    await sabotageCheckpoints(dir);
    const result = await runDeliveryPipeline(dir, plan.id, task, {
      initialEvidence: {
        workerResult: { kind: "worker", command: null, exitCode: 0, stdout: "", stderr: "" },
      },
    });

    assert.equal(result.status, "checkpoint_failed");
    const checkpointStep = result.steps.find((step) => step.capability === "checkpoint");
    assert.equal(checkpointStep.status, "fail");
    assert.ok(result.evidence.checkpointError, "expected checkpointError evidence");
    assert.match(result.evidence.checkpointError.message, /EACCES|permission denied/i);
    // acceptance-proof itself passed; only the durable write failed
    const proofStep = result.steps.find((step) => step.capability === "acceptance-proof");
    assert.equal(proofStep.status, "pass");
  });
});

test("adversarial: a throwing acceptance-proof capability blocks the pipeline and checkpoint is never attempted", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    const plan = await importPassingPlan(dir);
    const taskState = await loadTaskState(dir);
    const task = taskState.tasks.find((candidate) => candidate.id === "T001");

    // Sabotage the acceptance report directory: writeAcceptanceProof throws,
    // the gateway converts it into a fail envelope with null evidence.
    const acceptanceDir = resolveHelixPath(dir, "reports", "acceptance");
    await mkdir(acceptanceDir, { recursive: true });
    await chmod(acceptanceDir, 0o555);
    try {
      const result = await runDeliveryPipeline(dir, plan.id, task, {
        initialEvidence: {
          workerResult: { kind: "worker", command: null, exitCode: 0, stdout: "", stderr: "" },
        },
      });
      assert.equal(result.status, "blocked");
      assert.ok(!result.steps.some((step) => step.capability === "checkpoint"), "checkpoint must not run after a failed acceptance proof");
      const proofStep = result.steps.find((step) => step.capability === "acceptance-proof");
      assert.equal(proofStep.status, "fail");
      assert.ok(proofStep.error, "expected the throw to surface as envelope error");
    } finally {
      await chmod(acceptanceDir, 0o755);
    }
  });
});

test("adversarial: linear runNextTask puts the task back to pending when the checkpoint write fails, and completes after repair", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    await importPassingPlan(dir);

    await sabotageCheckpoints(dir);
    const blocked = await runNextTask(dir);
    assert.equal(blocked.status, "retry");
    assert.equal(blocked.task.status, "pending");
    assert.equal(blocked.task.last_failure.reason, "checkpoint_failed");

    const stateAfterFailure = await loadTaskState(dir);
    assert.equal(stateAfterFailure.tasks[0].status, "pending", "task must NOT be completed without a durable checkpoint");
    const ledger = await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8");
    assert.match(ledger, /checkpoint_write_failed/);
    assert.ok(!/"type":"task_verified"/.test(ledger), "task_verified must not be recorded when checkpoint failed");

    await repairCheckpoints(dir);
    const completed = await runNextTask(dir);
    assert.equal(completed.status, "completed");
    const stateAfterRepair = await loadTaskState(dir);
    assert.equal(stateAfterRepair.tasks[0].status, "completed");
    const checkpoint = await readJson(resolveHelixPath(dir, "checkpoints", `${stateAfterRepair.planId}-T001.json`));
    assert.equal(checkpoint.taskId, "T001");
  });
});

test("adversarial: single-step node checkpoint refuses to complete the task when the checkpoint write fails", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    await importPassingPlan(dir);

    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    await runWorkflowNode(dir, "verify", { taskId: "T001" });
    await runWorkflowNode(dir, "scope", { taskId: "T001" });
    await runWorkflowNode(dir, "review", { taskId: "T001" });

    await sabotageCheckpoints(dir);
    const blocked = await runWorkflowNode(dir, "checkpoint", { taskId: "T001" });
    assert.equal(blocked.status, "retry");
    assert.equal(blocked.task.status, "pending");
    assert.equal(blocked.task.last_failure.reason, "checkpoint_failed");
    const stateAfterFailure = await loadTaskState(dir);
    assert.equal(stateAfterFailure.tasks[0].status, "pending", "node checkpoint must NOT persist completed without a durable checkpoint");

    // After repair the task re-runs its gates and can then complete normally.
    await repairCheckpoints(dir);
    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    await runWorkflowNode(dir, "verify", { taskId: "T001" });
    await runWorkflowNode(dir, "scope", { taskId: "T001" });
    await runWorkflowNode(dir, "review", { taskId: "T001" });
    const completed = await runWorkflowNode(dir, "checkpoint", { taskId: "T001" });
    assert.equal(completed.status, "completed");
    const stateAfterRepair = await loadTaskState(dir);
    assert.equal(stateAfterRepair.tasks[0].status, "completed");
    const checkpoint = await readJson(resolveHelixPath(dir, "checkpoints", `${stateAfterRepair.planId}-T001.json`));
    assert.equal(checkpoint.taskId, "T001");
  });
});

test("adversarial: a new execute round cannot complete against the previous round's gate evidence", async () => {
  // Exact reproduction of the cross-review P0 (round 2, 2026-07-21):
  // round 1 passes every gate but the checkpoint write fails; round 2
  // produces a BAD artifact and then calls `node checkpoint` directly,
  // skipping verify/scope/review. The stale passing evidence from round 1
  // must not certify round 2's artifact.
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    const ctrlPath = resolveHelixPath(dir, "artifacts", "ctrl.txt");
    await writeFile(ctrlPath, "ok\n");
    const planPath = resolveHelixPath(dir, "artifacts", "stale-evidence-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Stale gate evidence",
      tasks: [
        {
          id: "T001",
          subject: "Artifact must match ctrl content",
          worker_command: nodeEval("const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/out.txt', fs.readFileSync('.helix/artifacts/ctrl.txt','utf8'));"),
          verify_commands: [nodeEval("const fs=require('fs'); if(fs.readFileSync('src/out.txt','utf8').trim()!=='ok') process.exit(1);")],
          writable_paths: ["src/**"],
        },
      ],
    }, null, 2));
    await importPlan(dir, planPath);

    // Round 1: all gates pass, checkpoint write fails, task returns to pending.
    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    await runWorkflowNode(dir, "verify", { taskId: "T001" });
    await runWorkflowNode(dir, "scope", { taskId: "T001" });
    await runWorkflowNode(dir, "review", { taskId: "T001" });
    await sabotageCheckpoints(dir);
    const firstCheckpoint = await runWorkflowNode(dir, "checkpoint", { taskId: "T001" });
    assert.equal(firstCheckpoint.status, "retry");
    // Repair the directory so a completion attempt would now succeed on disk:
    // any block from here on comes from evidence freshness, not the sabotage.
    await repairCheckpoints(dir);

    // Round 2: worker produces a bad artifact, then checkpoint is called
    // directly without re-running verify/scope/review.
    await writeFile(ctrlPath, "bad\n");
    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    const secondCheckpoint = await runWorkflowNode(dir, "checkpoint", { taskId: "T001" });
    assert.notEqual(secondCheckpoint.status, "completed", "round 2 must not complete on round 1's gate evidence");

    const persisted = await loadTaskState(dir);
    assert.notEqual(persisted.tasks[0].status, "completed");
    assert.equal((await readFile(path.join(dir, "src", "out.txt"), "utf8")).trim(), "bad", "sanity: round 2 really produced the bad artifact");
    await assert.rejects(
      () => readJson(resolveHelixPath(dir, "checkpoints", `${persisted.planId}-T001.json`)),
      undefined,
      "no checkpoint may exist for a task that never passed gates in its current round",
    );
  });
});

test("adversarial: persistTaskState keeps canonical tasks.json at the old state when a derived artifact write fails", async () => {
  // Cross-review P1 (round 2, 2026-07-21): completion used to be written to
  // tasks.json first, so a later tasks.md failure left a half-committed
  // "completed" with no ledger/markdown trail. Canonical tasks.json is now
  // the last write (the commit point).
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importPassingPlan(dir);
    const tasksMdPath = resolveHelixPath(dir, "team", "tasks.md");
    await chmod(tasksMdPath, 0o444);
    try {
      const taskState = await loadTaskState(dir);
      taskState.tasks[0].status = "completed";
      await assert.rejects(() => persistTaskState(dir, taskState), /EACCES|permission denied/i);
      const reloaded = await loadTaskState(dir);
      assert.equal(reloaded.tasks[0].status, "pending", "canonical state must not advance when a derived write fails");
    } finally {
      await chmod(tasksMdPath, 0o644);
    }

    // After repair the same persist succeeds and all three artifacts agree.
    const taskState = await loadTaskState(dir);
    taskState.tasks[0].status = "completed";
    await persistTaskState(dir, taskState);
    const reloaded = await loadTaskState(dir);
    assert.equal(reloaded.tasks[0].status, "completed");
    assert.match(await readFile(tasksMdPath, "utf8"), /\[x\] T001/);
  });
});

async function sabotageLedger(dir) {
  await chmod(resolveHelixPath(dir, "ledger.jsonl"), 0o444);
}

async function repairLedger(dir) {
  await chmod(resolveHelixPath(dir, "ledger.jsonl"), 0o644);
}

test("adversarial: node checkpoint does not persist completed when the completion ledger write fails", async () => {
  // Cross-review P0 (round 3, 2026-07-21): completed used to be persisted
  // BEFORE the completion ledger event, so a ledger outage produced
  // completed state with no completion evidence. The ledger event is now
  // written first; canonical tasks.json stays the commit point.
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    await importPassingPlan(dir);

    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    await runWorkflowNode(dir, "verify", { taskId: "T001" });
    await runWorkflowNode(dir, "scope", { taskId: "T001" });
    await runWorkflowNode(dir, "review", { taskId: "T001" });

    await sabotageLedger(dir);
    try {
      await assert.rejects(() => runWorkflowNode(dir, "checkpoint", { taskId: "T001" }), /EACCES|permission denied/i);
    } finally {
      await repairLedger(dir);
    }
    const stateAfterOutage = await loadTaskState(dir);
    assert.notEqual(stateAfterOutage.tasks[0].status, "completed", "ledger outage must never yield a completed task");

    // Same round, gate evidence still fresh: re-running checkpoint completes,
    // and state + ledger completion event now exist together.
    const completed = await runWorkflowNode(dir, "checkpoint", { taskId: "T001" });
    assert.equal(completed.status, "completed");
    const stateAfterRepair = await loadTaskState(dir);
    assert.equal(stateAfterRepair.tasks[0].status, "completed");
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /node_checkpoint_completed/);
  });
});

test("adversarial: parallel admission never reaches completed/released when the ledger is unavailable", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = resolveHelixPath(dir, "artifacts", "parallel-ledger-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel admission ledger integrity",
      tasks: [
        {
          id: "T001",
          subject: "Admit child artifact",
          verify_commands: [nodeEval("const fs=require('fs'); if(fs.readFileSync('src/parallel.txt','utf8').trim()!=='ok') process.exit(1);")],
          writable_paths: ["src/**"],
        },
      ],
    }, null, 2));
    await importPlan(dir, planPath);

    const command = [
      "node -e",
      JSON.stringify("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'artifact ready', files:[{path:'src/parallel.txt', content:'ok\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(dir, { taskIds: ["T001"], agent: "Kui", command });

    await sabotageLedger(dir);
    try {
      await assert.rejects(() => admitParallelAgentResult(dir, { runId: batch.runId, taskId: "T001" }), /EACCES|permission denied/i);
    } finally {
      await repairLedger(dir);
    }
    const stateAfterOutage = await loadTaskState(dir);
    assert.notEqual(stateAfterOutage.tasks[0].status, "completed");
    const lifecycleAfterOutage = await readJson(resolveHelixPath(dir, "agent-runs", batch.runId, "T001", "result.json"));
    assert.notEqual(lifecycleAfterOutage.lifecycle?.status, "released", "child result must not be released during a ledger outage");

    const admitted = await admitParallelAgentResult(dir, { runId: batch.runId, taskId: "T001" });
    assert.equal(admitted.status, "completed");
    const ledger = await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8");
    assert.match(ledger, /"type":"parallel_agent_admission_completed"[^\n]*"status":"completed"/);
    const lifecycleAfterRepair = await readJson(resolveHelixPath(dir, "agent-runs", batch.runId, "T001", "result.json"));
    assert.equal(lifecycleAfterRepair.lifecycle.status, "released");
  });
});

test("adversarial: linear runNextTask never yields completed during a ledger outage", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    await importPassingPlan(dir);

    await sabotageLedger(dir);
    try {
      await assert.rejects(() => runNextTask(dir), /EACCES|permission denied/i);
    } finally {
      await repairLedger(dir);
    }
    const stateAfterOutage = await loadTaskState(dir);
    assert.notEqual(stateAfterOutage.tasks[0].status, "completed");
    assert.ok(!/"type":"task_verified"/.test(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8")), "no completion event may exist for the aborted run");

    // The outage aborted the run right after the task was claimed
    // (in_progress persisted, task_started ledger threw). The single-step
    // workflow accepts in_progress, so recovery completes through it.
    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    await runWorkflowNode(dir, "verify", { taskId: "T001" });
    await runWorkflowNode(dir, "scope", { taskId: "T001" });
    await runWorkflowNode(dir, "review", { taskId: "T001" });
    const completed = await runWorkflowNode(dir, "checkpoint", { taskId: "T001" });
    assert.equal(completed.status, "completed");
    const stateAfterRepair = await loadTaskState(dir);
    assert.equal(stateAfterRepair.tasks[0].status, "completed");
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /node_checkpoint_completed/);
  });
});

test("adversarial: parallel admission does not release the child result when the checkpoint write fails", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = resolveHelixPath(dir, "artifacts", "parallel-ckpt-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel admission checkpoint integrity",
      tasks: [
        {
          id: "T001",
          subject: "Admit child artifact",
          verify_commands: [nodeEval("const fs=require('fs'); if(fs.readFileSync('src/parallel.txt','utf8').trim()!=='ok') process.exit(1);")],
          writable_paths: ["src/**"],
        },
      ],
    }, null, 2));
    await importPlan(dir, planPath);

    const command = [
      "node -e",
      JSON.stringify("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'artifact ready', files:[{path:'src/parallel.txt', content:'ok\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(dir, { taskIds: ["T001"], agent: "Kui", command });

    await sabotageCheckpoints(dir);
    const blocked = await admitParallelAgentResult(dir, { runId: batch.runId, taskId: "T001" });
    assert.equal(blocked.status, "retry");
    assert.equal(blocked.task.status, "pending");
    assert.equal(blocked.task.last_failure.reason, "checkpoint_failed");
    const lifecycleAfterFailure = await readJson(resolveHelixPath(dir, "agent-runs", batch.runId, "T001", "result.json"));
    assert.equal(lifecycleAfterFailure.lifecycle.status, "awaiting_revision", "child result must not be released without a durable checkpoint");

    await repairCheckpoints(dir);
    const admitted = await admitParallelAgentResult(dir, { runId: batch.runId, taskId: "T001" });
    assert.equal(admitted.status, "completed");
    assert.equal(await readFile(path.join(dir, "src", "parallel.txt"), "utf8"), "ok\n");
    const lifecycleAfterRepair = await readJson(resolveHelixPath(dir, "agent-runs", batch.runId, "T001", "result.json"));
    assert.equal(lifecycleAfterRepair.lifecycle.status, "released");
  });
});

test("adversarial: an interrupted completion transaction is visible to doctor and auto-recovered by the next run", async () => {
  // Cross-review P1+P2 (round 4, 2026-07-21): the failure window where the
  // completion ledger event and the derived plan/markdown mirrors were
  // written but the canonical tasks.json save failed. Plain `run` used to
  // report "blocked" forever and doctor was blind to the divergence.
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    await importPassingPlan(dir);

    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    await runWorkflowNode(dir, "verify", { taskId: "T001" });
    await runWorkflowNode(dir, "scope", { taskId: "T001" });
    await runWorkflowNode(dir, "review", { taskId: "T001" });

    // Read-only plans dir: acceptance proof, checkpoint and the completion
    // ledger event all succeed, tasks.md (a derived view) gets rewritten as
    // completed, but the plan-mirror write fails mid-persist — the canonical
    // tasks.json save is never reached. This is the exact divergence window
    // from the round-4 cross-review.
    const plansDir = resolveHelixPath(dir, "plans");
    await chmod(plansDir, 0o555);
    try {
      await assert.rejects(() => runWorkflowNode(dir, "checkpoint", { taskId: "T001" }), /EACCES|permission denied/i);
    } finally {
      await chmod(plansDir, 0o755);
    }

    const interrupted = await loadTaskState(dir);
    assert.equal(interrupted.tasks[0].status, "verifying", "canonical state must stay pre-completion");
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /node_checkpoint_completed/);
    assert.match(await readFile(resolveHelixPath(dir, "team", "tasks.md"), "utf8"), /- Status: completed/, "sanity: the divergence window really exists");

    // doctor must surface both reverse inconsistencies.
    const report = await runDoctor(dir);
    const auditFindings = report.findings.filter((finding) => finding.section === "completion_audit");
    assert.ok(
      auditFindings.some((finding) => finding.taskId === "T001" && /already has a completion event/.test(finding.message)),
      `doctor must flag the orphan completion event, got: ${JSON.stringify(auditFindings)}`,
    );
    assert.ok(
      auditFindings.some((finding) => finding.taskId === "T001" && /diverges/.test(finding.message)),
      `doctor must flag the canonical/derived divergence, got: ${JSON.stringify(auditFindings)}`,
    );

    // Plain `run` adjudicates the stuck task instead of reporting blocked:
    // the gate evidence of the current round passes, so it completes.
    const resumed = await runNextTask(dir);
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.resumed, "verifying_task_adjudicated");
    const recovered = await loadTaskState(dir);
    assert.equal(recovered.tasks[0].status, "completed");
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /run_resumed_verifying_task/);

    const cleanReport = await runDoctor(dir);
    const remaining = cleanReport.findings.filter(
      (finding) => finding.section === "completion_audit" && (finding.message.includes("already has a completion event") || finding.message.includes("diverges")),
    );
    assert.deepEqual(remaining, [], "after recovery doctor must see a consistent state");
  });
});

test("adversarial: an interrupted verifying task with a bad artifact is sent back to pending by the next run, not completed", async () => {
  // The auto-recovery path must adjudicate, not rubber-stamp: a task stuck
  // in verifying whose gate evidence does NOT pass for the current round has
  // to go back to pending (rejected), never straight to completed.
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    await importPassingPlan(dir);

    // Only execute ran; verify/scope/review never happened this round.
    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    const stuck = await loadTaskState(dir);
    assert.equal(stuck.tasks[0].status, "verifying");

    const adjudicated = await runNextTask(dir);
    assert.equal(adjudicated.resumed, "verifying_task_adjudicated");
    assert.notEqual(adjudicated.status, "completed", "missing gate evidence must never auto-complete");
    const persisted = await loadTaskState(dir);
    assert.notEqual(persisted.tasks[0].status, "completed");
    assert.ok(["pending", "failed"].includes(persisted.tasks[0].status), "the stuck task must be released back into the retry loop");
  });
});

test("adversarial: parallel admission resumes idempotently after a lifecycle write failure, without touching workspace files", async () => {
  // Cross-review P1 (round 4, 2026-07-21): task completed + lifecycle save
  // failed used to be unrecoverable — re-admission was refused because the
  // task was already completed, leaving the child stuck in
  // awaiting_user_acceptance forever. The retry must finish ONLY the
  // missing release and must not re-apply files over the workspace.
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = resolveHelixPath(dir, "artifacts", "parallel-resume-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel admission lifecycle recovery",
      tasks: [
        {
          id: "T001",
          subject: "Admit child artifact",
          verify_commands: [nodeEval("const fs=require('fs'); if(fs.readFileSync('src/parallel.txt','utf8').trim()!=='ok') process.exit(1);")],
          writable_paths: ["src/**"],
        },
      ],
    }, null, 2));
    await importPlan(dir, planPath);

    const command = [
      "node -e",
      JSON.stringify("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'artifact ready', files:[{path:'src/parallel.txt', content:'ok\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(dir, { taskIds: ["T001"], agent: "Kui", command });

    // Sabotage the per-task run directory: the admission itself completes
    // (task persisted completed) but updateAgentRunLifecycle cannot write
    // result.json — the exact interruption from the cross-review.
    const runTaskDir = resolveHelixPath(dir, "agent-runs", batch.runId, "T001");
    await chmod(runTaskDir, 0o555);
    try {
      await assert.rejects(() => admitParallelAgentResult(dir, { runId: batch.runId, taskId: "T001" }), /EACCES|permission denied/i);
    } finally {
      await chmod(runTaskDir, 0o755);
    }
    const stateAfterCrash = await loadTaskState(dir);
    assert.equal(stateAfterCrash.tasks[0].status, "completed", "sanity: the interruption happened after the completed persist");
    const lifecycleAfterCrash = await readJson(path.join(runTaskDir, "result.json"));
    assert.notEqual(lifecycleAfterCrash.lifecycle?.status, "released", "sanity: the release is the missing half of the transaction");

    // A user edit between crash and retry must survive the resume: if the
    // retry re-applied the child files it would overwrite this content.
    await writeFile(path.join(dir, "src", "parallel.txt"), "edited after admission\n");

    const resumed = await admitParallelAgentResult(dir, { runId: batch.runId, taskId: "T001" });
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.resumed, true);
    assert.equal(await readFile(path.join(dir, "src", "parallel.txt"), "utf8"), "edited after admission\n", "resume must not re-apply files");
    const lifecycleAfterResume = await readJson(path.join(runTaskDir, "result.json"));
    assert.equal(lifecycleAfterResume.lifecycle.status, "released");
    assert.equal((await loadTaskState(dir)).tasks[0].status, "completed");
  });
});

test("adversarial: a mid-apply failure rolls the workspace back and releases the admission claim", async () => {
  // Cross-review P0 (round 5, 2026-07-21): admission used to apply files
  // first and only then establish the transaction (claim + started ledger),
  // so a failure in between left half-applied files, a task stuck in
  // verifying, and no retryable path. Now the claim comes first and ANY
  // apply failure rolls back the workspace and releases the claim.
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = resolveHelixPath(dir, "artifacts", "parallel-apply-fail-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Admission apply failure",
      tasks: [
        {
          id: "T001",
          subject: "Two files, second one fails to write",
          verify_commands: [nodeEval("const fs=require('fs'); if(fs.readFileSync('src/a.txt','utf8').trim()!=='A'||fs.readFileSync('src/sub/b.txt','utf8').trim()!=='B') process.exit(1);")],
          writable_paths: ["src/**"],
        },
      ],
    }, null, 2));
    await importPlan(dir, planPath);

    const command = [
      "node -e",
      JSON.stringify("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'two files', files:[{path:'src/a.txt', content:'A\\n'},{path:'src/sub/b.txt', content:'B\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(dir, { taskIds: ["T001"], agent: "Kui", command });

    // Read-only src/sub: the first file write succeeds, the second fails.
    await mkdir(path.join(dir, "src", "sub"), { recursive: true });
    await chmod(path.join(dir, "src", "sub"), 0o555);
    try {
      await assert.rejects(
        () => admitParallelAgentResult(dir, { runId: batch.runId, taskId: "T001" }),
        /parallel admission failed while applying files/,
      );
    } finally {
      await chmod(path.join(dir, "src", "sub"), 0o755);
    }

    // Workspace rolled back: the half-applied first file is gone again.
    await assert.rejects(() => readFile(path.join(dir, "src", "a.txt"), "utf8"), /ENOENT/);
    // Claim released: the task is retryable, not stuck in verifying.
    const stateAfterFailure = await loadTaskState(dir);
    assert.equal(stateAfterFailure.tasks[0].status, "pending");
    assert.equal(stateAfterFailure.tasks[0].last_failure.reason, "admission_apply_failed");
    const ledger = await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8");
    assert.match(ledger, /parallel_agent_admission_apply_failed/);
    const lifecycle = await readJson(resolveHelixPath(dir, "agent-runs", batch.runId, "T001", "result.json"));
    assert.equal(lifecycle.lifecycle?.status, "awaiting_revision");

    // After repair the SAME run can be admitted again and completes.
    const admitted = await admitParallelAgentResult(dir, { runId: batch.runId, taskId: "T001" });
    assert.equal(admitted.status, "completed");
    assert.equal((await readFile(path.join(dir, "src", "a.txt"), "utf8")).trim(), "A");
    assert.equal((await readFile(path.join(dir, "src", "sub", "b.txt"), "utf8")).trim(), "B");
  });
});

test("adversarial: a run whose admission failed earlier cannot fake-resume a task completed by other means", async () => {
  // Cross-review P1 (round 5, 2026-07-21): the resume branch used to accept
  // any matching runId in the task evidence — but a FAILED admission also
  // leaves that evidence behind. Resume now requires the chain-verified
  // completed ledger event for that exact run.
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    const planPath = resolveHelixPath(dir, "artifacts", "fake-resume-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Fake resume",
      tasks: [
        {
          id: "T001",
          subject: "Content must be linear",
          worker_command: nodeEval("const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/out.txt','linear\\n');"),
          verify_commands: [nodeEval("const fs=require('fs'); if(fs.readFileSync('src/out.txt','utf8').trim()!=='linear') process.exit(1);")],
          writable_paths: ["src/**"],
        },
      ],
    }, null, 2));
    await importPlan(dir, planPath);

    // Run R proposes content that fails verify: its admission is rejected
    // and rolled back, but it leaves admission evidence with its runId.
    const command = [
      "node -e",
      JSON.stringify("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'bad content', files:[{path:'src/out.txt', content:'from child\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(dir, { taskIds: ["T001"], agent: "Kui", command });
    const failed = await admitParallelAgentResult(dir, { runId: batch.runId, taskId: "T001" });
    assert.notEqual(failed.status, "completed", "sanity: run R's admission must fail its gates");

    // The task is then completed through the linear flow, NOT by run R.
    const completed = await runNextTask(dir);
    assert.equal(completed.status, "completed");
    assert.equal((await readFile(path.join(dir, "src", "out.txt"), "utf8")).trim(), "linear");

    // Re-admitting run R must be refused — not treated as a resume that
    // marks the failed run released.
    await assert.rejects(
      () => admitParallelAgentResult(dir, { runId: batch.runId, taskId: "T001" }),
      /already completed/,
    );
    assert.equal((await readFile(path.join(dir, "src", "out.txt"), "utf8")).trim(), "linear", "the refusal must not touch the workspace");
    const lifecycle = await readJson(resolveHelixPath(dir, "agent-runs", batch.runId, "T001", "result.json"));
    assert.notEqual(lifecycle.lifecycle?.status, "released", "a failed run must never be marked released");
  });
});

test("adversarial: a wisdom write failure keeps the completion recoverable instead of completing without it", async () => {
  // Cross-review P1 (round 5, 2026-07-21): wisdom/digest used to be written
  // AFTER the completed persist, so their failure left a completed task
  // permanently missing them. They now sit inside the completion
  // transaction: a failure keeps the task in verifying, and the run
  // auto-recovery re-runs the whole completion including the missed writes.
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    await importPassingPlan(dir);

    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    await runWorkflowNode(dir, "verify", { taskId: "T001" });
    await runWorkflowNode(dir, "scope", { taskId: "T001" });
    await runWorkflowNode(dir, "review", { taskId: "T001" });

    const wisdomPath = resolveHelixPath(dir, "wisdom", "verification.md");
    await writeFile(wisdomPath, "", "utf8");
    await chmod(wisdomPath, 0o444);
    try {
      await assert.rejects(() => runWorkflowNode(dir, "checkpoint", { taskId: "T001" }), /EACCES|permission denied/i);
    } finally {
      await chmod(wisdomPath, 0o644);
    }
    const interrupted = await loadTaskState(dir);
    assert.equal(interrupted.tasks[0].status, "verifying", "wisdom failure must not commit the completion");

    const recovered = await runNextTask(dir);
    assert.equal(recovered.status, "completed");
    assert.equal((await loadTaskState(dir)).tasks[0].status, "completed");
    assert.match(await readFile(wisdomPath, "utf8"), /T001/, "the recovery re-run must write the wisdom line");
  });
});

test("adversarial: a post-commit snapshot failure does not un-complete the task but stays visible", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    await importPassingPlan(dir);

    await runWorkflowNode(dir, "execute", { taskId: "T001" });
    await runWorkflowNode(dir, "verify", { taskId: "T001" });
    await runWorkflowNode(dir, "scope", { taskId: "T001" });
    await runWorkflowNode(dir, "review", { taskId: "T001" });

    // Sabotage the snapshots dir only for the final post-commit snapshot.
    await chmod(resolveHelixPath(dir, "snapshots"), 0o555);
    let completed;
    try {
      completed = await runWorkflowNode(dir, "checkpoint", { taskId: "T001" });
    } finally {
      await chmod(resolveHelixPath(dir, "snapshots"), 0o755);
    }
    assert.equal(completed.status, "completed", "post-commit snapshot failure must not fail the completion");
    assert.equal(completed.sideEffectWarnings.length, 1);
    assert.equal((await loadTaskState(dir)).tasks[0].status, "completed");
    const ledger = await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8");
    assert.match(ledger, /completion_side_effect_failed/, "the failed side effect must leave a ledger trace");

    const report = await runDoctor(dir);
    assert.ok(
      report.findings.some((finding) => finding.section === "completion_audit" && /post-completion side effect failed/.test(finding.message)),
      "doctor must surface the missing snapshot",
    );
  });
});

test("adversarial: a run missing from index.json is rediscovered instead of staying invisible", async () => {
  // Cross-review P1 (round 5, 2026-07-21): per-task result.json files were
  // written before the index, so an index write failure produced results on
  // disk that `parallel status` could never see again.
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = resolveHelixPath(dir, "artifacts", "orphan-run-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Orphan run discovery",
      tasks: [
        {
          id: "T001",
          subject: "Admit child artifact",
          verify_commands: [nodeEval("const fs=require('fs'); if(fs.readFileSync('src/parallel.txt','utf8').trim()!=='ok') process.exit(1);")],
          writable_paths: ["src/**"],
        },
      ],
    }, null, 2));
    await importPlan(dir, planPath);

    const command = [
      "node -e",
      JSON.stringify("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'artifact ready', files:[{path:'src/parallel.txt', content:'ok\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(dir, { taskIds: ["T001"], agent: "Kui", command });

    // Simulate the lost index (failed write / crash before write).
    await rm(resolveHelixPath(dir, "agent-runs", "index.json"), { force: true });

    const status = await parallelAgentStatus(dir, {});
    const rediscovered = status.runs.find((run) => run.runId === batch.runId);
    assert.ok(rediscovered, "the orphan run must be adopted back into the index");
    assert.equal(rediscovered.results.length, 1);
    assert.match(await readFile(resolveHelixPath(dir, "ledger.jsonl"), "utf8"), /parallel_run_index_reconciled/);

    // And the rediscovered run is still admissible.
    const admitted = await admitParallelAgentResult(dir, { runId: batch.runId, taskId: "T001" });
    assert.equal(admitted.status, "completed");
  });
});

test("adversarial: parallel admission refuses a task completed by other means BEFORE applying any file", async () => {
  // Cross-review P1 (round 4, 2026-07-21): admission used to write the
  // child's files into the workspace first and validate the task status
  // afterwards, so a doomed admission could still clobber the workspace.
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    const planPath = resolveHelixPath(dir, "artifacts", "parallel-precheck-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Parallel admission status precheck",
      tasks: [
        {
          id: "T001",
          subject: "Task completed through the linear flow",
          worker_command: nodeEval("const fs=require('fs'); fs.mkdirSync('src',{recursive:true}); fs.writeFileSync('src/parallel.txt','linear\\n');"),
          verify_commands: [nodeEval("process.exit(0)")],
          writable_paths: ["src/**"],
        },
      ],
    }, null, 2));
    await importPlan(dir, planPath);

    const command = [
      "node -e",
      JSON.stringify("const fs=require('fs'); fs.writeFileSync(process.argv[1], JSON.stringify({summary:'artifact ready', files:[{path:'src/parallel.txt', content:'from child agent\\n'}]}));"),
      "{outputJson}",
    ].join(" ");
    const batch = await runParallelAgents(dir, { taskIds: ["T001"], agent: "Kui", command });

    // Complete the task through the linear flow, NOT through this admission.
    const completed = await runNextTask(dir);
    assert.equal(completed.status, "completed");
    assert.equal(await readFile(path.join(dir, "src", "parallel.txt"), "utf8"), "linear\n");

    await assert.rejects(
      () => admitParallelAgentResult(dir, { runId: batch.runId, taskId: "T001" }),
      /already completed/,
      "an unrelated completed task must be refused, not resumed",
    );
    assert.equal(
      await readFile(path.join(dir, "src", "parallel.txt"), "utf8"),
      "linear\n",
      "the refusal must happen before any child file touches the workspace",
    );
  });
});
