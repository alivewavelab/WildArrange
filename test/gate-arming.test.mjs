import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAcceptanceProof } from "../src/capabilities/acceptance-proof.mjs";
import { evaluateGateArming } from "../src/infra/gate-arming.mjs";
import { DEFAULT_HELIX_CONFIG } from "../src/infra/runtime-config.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { statusReport } from "../src/orchestration/status.mjs";

const UNARMED_CONFIG = structuredClone(DEFAULT_HELIX_CONFIG);

test("gate arming floor flags tautological review and unrequired quality gates", async () => {
  const result = evaluateGateArming({
    config: UNARMED_CONFIG,
    tasks: [{ id: "T001", status: "pending", verify_commands: ["node --test"] }],
  });
  assert.equal(result.armed, false);
  assert.ok(result.issues.some((issue) => issue.code === "review_tautology"));
  assert.ok(result.issues.some((issue) => issue.code === "quality_gates_not_required"));
});

test("gate arming floor flags missing and trivial verify commands per task", async () => {
  const result = evaluateGateArming({
    config: UNARMED_CONFIG,
    tasks: [
      { id: "T001", status: "pending", verify_commands: [] },
      { id: "T002", status: "pending", verify_commands: ["true"] },
      { id: "T003", status: "completed", verify_commands: [] },
    ],
  });
  assert.ok(result.issues.some((issue) => issue.code === "verify_missing" && issue.taskId === "T001"));
  assert.ok(result.issues.some((issue) => issue.code === "verify_trivial" && issue.taskId === "T002"));
  // completed 任务不再占用黄灯。
  assert.ok(!result.issues.some((issue) => issue.taskId === "T003"));
});

test("gate arming floor goes green once gates are really armed", async () => {
  const config = structuredClone(DEFAULT_HELIX_CONFIG);
  config.qualityGates.lspDiagnostics = { enabled: true, required: true, commands: ["node --check src"], timeoutMs: 1000 };
  const result = evaluateGateArming({
    config,
    tasks: [{ id: "T001", status: "pending", verify_commands: ["node --test"], review_commands: ["node ./scripts/review.mjs"] }],
  });
  assert.deepEqual(result.issues, []);
  assert.equal(result.armed, true);
});

test("acceptance proof fails when every verify command is trivial", async () => {
  const passingEvidence = {
    workerResult: { kind: "worker", exitCode: 0, command: "echo work" },
    verifyResult: { kind: "verifier", pass: true, results: [{ command: "true", exitCode: 0 }] },
    scopeResult: { status: "pass" },
    reviewResult: { kind: "review_gate", pass: true, lanes: [{ name: "evidence_integrity", status: "pass" }] },
  };
  const trivialTask = {
    id: "T001",
    subject: "demo",
    verify_commands: ["true"],
    worker_command: "echo work",
    writable_paths: ["src/app.js"],
    successCriteria: [],
  };
  const trivialProof = buildAcceptanceProof("plan-1", trivialTask, passingEvidence);
  assert.equal(trivialProof.pass, false);
  const trivialCheck = trivialProof.checks.find((check) => check.name === "verify_not_trivial");
  assert.equal(trivialCheck.status, "fail");

  const realTask = { ...trivialTask, verify_commands: ["node --test"] };
  const realProof = buildAcceptanceProof("plan-1", realTask, {
    ...passingEvidence,
    verifyResult: { kind: "verifier", pass: true, results: [{ command: "node --test", exitCode: 0 }] },
  });
  assert.equal(realProof.checks.find((check) => check.name === "verify_not_trivial").status, "pass");
  // 没有任何独立复核信号 lane 时，复核是同义反复，验收证明必须拒绝。
  assert.equal(realProof.checks.find((check) => check.name === "review_not_tautological").status, "fail");
  assert.equal(realProof.pass, false);

  const reviewedTask = { ...realTask, review_commands: ["node --version"] };
  const reviewedProof = buildAcceptanceProof("plan-1", reviewedTask, {
    ...passingEvidence,
    verifyResult: { kind: "verifier", pass: true, results: [{ command: "node --test", exitCode: 0 }] },
  });
  assert.equal(reviewedProof.checks.find((check) => check.name === "review_not_tautological").status, "pass");
  assert.equal(reviewedProof.pass, true);
});

test("status report carries the persistent unarmed-gates yellow lamp", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = path.join(dir, "plan.json");
    await writeFile(planPath, JSON.stringify({
      id: "plan-arming",
      title: "Gate arming demo",
      tasks: [{ id: "T001", subject: "demo", verify_commands: ["node --test"] }],
    }), "utf8");
    await importPlan(dir, planPath);

    const status = await statusReport(dir);
    assert.equal(status.gateArming.armed, false);
    assert.ok(status.gateArming.issues.some((issue) => issue.code === "quality_gates_not_required"));
    assert.ok(status.gateArming.issues.some((issue) => issue.code === "review_tautology"));
  });
});

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-gate-arming-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
