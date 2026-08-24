import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { invokeCapability, listRegisteredCapabilities } from "../src/capabilities/gateway.mjs";
import { runDeliveryPipeline } from "../src/orchestration/delivery-pipeline.mjs";
import { importPlan, loadTaskState } from "../src/orchestration/plan-state.mjs";
import { runCommand } from "../src/infra/command-runner.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { readJson, resolveHelixPath } from "../src/infra/runtime-store.mjs";

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-gateway-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function nodeEval(source) {
  return `node -e ${JSON.stringify(source.replace(/\s*\n\s*/g, " ").trim())}`;
}

async function importSingleTaskPlan(dir, { verifyCommand, writablePaths = ["src/**"] }) {
  // Written under .helix/artifacts/ (not the project root) so it is excluded
  // from the scope guard's git diff pathspec (`git diff -- . ':!.helix'`);
  // otherwise the plan file itself would show up as an "out of scope" change.
  const planPath = resolveHelixPath(dir, "artifacts", "pipeline-plan.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    planPath,
    JSON.stringify({
      title: "Delivery pipeline smoke",
      tasks: [
        {
          id: "T001",
          subject: "Exercise the shared delivery pipeline",
          verify_commands: [verifyCommand],
          review_commands: ["node --version"],
          writable_paths: writablePaths,
        },
      ],
    }, null, 2),
  );
  return importPlan(dir, planPath);
}

test("gateway: invokeCapability rejects unknown capability names", async () => {
  await assert.rejects(() => invokeCapability("does-not-exist", {}), /Unknown capability/);
});

test("gateway: listRegisteredCapabilities exposes the static registry", () => {
  const names = listRegisteredCapabilities();
  for (const expected of ["worker", "verify", "scope", "review", "acceptance-proof", "checkpoint", "command", "command-safety", "repository-governance"]) {
    assert.ok(names.includes(expected), `expected ${expected} to be registered, got: ${names.join(", ")}`);
  }
});

test("gateway: command capability returns a unified envelope with duration", async () => {
  const envelope = await invokeCapability("command", {
    rootDir: process.cwd(),
    options: { command: nodeEval("process.exit(0)") },
  });
  assert.equal(envelope.capability, "command");
  assert.equal(envelope.status, "pass");
  assert.equal(typeof envelope.duration_ms, "number");
  assert.equal(envelope.sideEffect, "none");
  assert.equal(envelope.error, null);
});

test("gateway: command-safety capability blocks a destructive command", async () => {
  const envelope = await invokeCapability("command-safety", {
    options: { command: "git clean -fd" },
  });
  assert.equal(envelope.status, "fail");
  assert.equal(envelope.evidence.allowed, false);
});

test("gateway: a throwing capability is caught and reported as a fail envelope, not an unhandled rejection", async () => {
  await withTempDir(async (dir) => {
    // scopeGuard() reads task state from disk itself; with no imported plan
    // it throws synchronously instead of returning a fail result, so this
    // exercises invokeCapability's own try/catch around the adapter call.
    const envelope = await invokeCapability("scope", {
      rootDir: dir,
      task: { id: "T001" },
    });
    assert.equal(envelope.capability, "scope");
    assert.equal(envelope.status, "fail");
    assert.ok(envelope.error, "expected error details to be populated");
    assert.match(envelope.error.message, /no imported plan found/);
  });
});

test("delivery pipeline: runs verify -> scope -> review -> acceptance-proof -> checkpoint and completes", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    const plan = await importSingleTaskPlan(dir, { verifyCommand: nodeEval("if(!process.version)process.exit(1)") });
    const taskState = await loadTaskState(dir);
    const task = taskState.tasks.find((candidate) => candidate.id === "T001");

    const result = await runDeliveryPipeline(dir, plan.id, task, {
      initialEvidence: {
        workerResult: { kind: "worker", command: null, exitCode: 0, stdout: "", stderr: "" },
      },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.steps.length, 5);
    assert.deepEqual(result.steps.map((step) => step.capability), ["verify", "scope", "review", "acceptance-proof", "checkpoint"]);
    assert.ok(result.steps.every((step) => step.status === "pass"), JSON.stringify(result.steps.map((s) => [s.capability, s.status])));
    assert.equal(typeof result.totalDurationMs, "number");
    assert.match(result.summary, /验证/);
    assert.match(result.summary, /存档/);
    assert.match(result.summary, /总耗时/);

    const checkpoint = await readJson(resolveHelixPath(dir, "checkpoints", `${plan.id}-T001.json`));
    assert.equal(checkpoint.taskId, "T001");
  });
});

test("delivery pipeline: stops before acceptance-proof/checkpoint when verify fails, and reports which gates failed", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    assert.equal((await runCommand("git init", dir)).exitCode, 0);
    const plan = await importSingleTaskPlan(dir, { verifyCommand: nodeEval("process.exit(1)") });
    const taskState = await loadTaskState(dir);
    const task = taskState.tasks.find((candidate) => candidate.id === "T001");

    const result = await runDeliveryPipeline(dir, plan.id, task, {
      initialEvidence: {
        workerResult: { kind: "worker", command: null, exitCode: 0, stdout: "", stderr: "" },
      },
    });

    assert.equal(result.status, "blocked");
    // verify/scope/review always all run (matches existing node-runtime semantics),
    // but acceptance-proof and checkpoint must never be attempted once a gate fails.
    assert.deepEqual(result.steps.map((step) => step.capability), ["verify", "scope", "review"]);
    const verifyStep = result.steps.find((step) => step.capability === "verify");
    assert.equal(verifyStep.status, "fail");

    const checkpointPath = resolveHelixPath(dir, "checkpoints", `${plan.id}-T001.json`);
    await assert.rejects(() => readJson(checkpointPath));
  });
});
