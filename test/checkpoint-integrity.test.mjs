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
import {
  admitParallelAgentResult,
  importPlan,
  initRuntime,
  loadTaskState,
  readJson,
  resolveHelixPath,
  runCommand,
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
    // Undo any read-only sabotage so cleanup can delete the tree.
    await chmod(resolveHelixPath(dir, "checkpoints"), 0o755).catch(() => {});
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
