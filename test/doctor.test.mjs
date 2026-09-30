// =============================================================================
// 文件名称：doctor.test.mjs
// 所属模块：test
// 作用说明：
//   验证 doctor 诊断：单检查崩溃不拖垮报告、只读不写 ledger、
//   暴露 unarmed gates/缺失 adapter、adoption 后 runner 黄灯、
//   Codex activation 证据绑定当前 hook config。
//   不测：doctor 自动修复或任务执行。
//
// 【运行原理速读】
//   构造损坏/未武装/已 adoption 的 runtime 状态，运行 runDoctor，
//   断言 findings 含预期 code 且 ledger 行数不变。
// =============================================================================

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDoctor } from "../src/interface/doctor.mjs";
import { appendLedger } from "../src/infra/ledger.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { hashContent, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { generateVerificationArtifacts } from "../src/capabilities/verification-governance.mjs";
import { runInjectionHook } from "../src/ai/hooks.mjs";
import { withExternalProject, declare } from "./helpers/external-fixture.mjs";

test("doctor keeps reporting when one check crashes on corrupted state", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    // 人为损坏 tasks.json：completionAudit 检查会抛错，其余检查必须照常。
    const tasksPath = resolveWildArrangePath(dir, "team", "tasks.json");
    await writeFile(tasksPath, "{corrupted json", "utf8");

    const report = await runDoctor(dir);
    assert.equal(report.sections.completionAudit.status, "check_failed");
    assert.ok(report.findings.some((finding) => finding.checkFailed === true && finding.section === "completionAudit"));
    assert.equal(report.ok, false);

    // 其余分项仍然产出真实结果，而不是被拖崩。
    assert.notEqual(report.sections.config.status, "check_failed");
    assert.ok(report.sections.config.sourcePath);
    assert.notEqual(report.sections.ledger.status, "check_failed");
    assert.notEqual(report.sections.runtimeState.status, "check_failed");
    assert.ok(report.sections.registryFreshness);
    assert.notEqual(report.sections.registryFreshness.status, "check_failed");

    const markdown = await readFile(resolveWildArrangePath(dir, "reports", "doctor.md"), "utf8");
    assert.match(markdown, /CHECK FAILED/);
    assert.match(markdown, /Config source:/);
  });
});

test("doctor is diagnostic-only and never appends to the hash-chained ledger", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const ledgerPath = resolveWildArrangePath(dir, "ledger.jsonl");
    const before = existsSync(ledgerPath) ? await readFile(ledgerPath, "utf8") : "";

    await runDoctor(dir);

    const after = existsSync(ledgerPath) ? await readFile(ledgerPath, "utf8") : "";
    assert.equal(after, before);
  });
});

test("doctor surfaces unarmed gates and an unprepared external adapter instead of burying them", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    // 夹具写的是默认配置：质量门全关、外置 adapter 尚未生成。
    const report = await runDoctor(dir);

    assert.equal(report.sections.gateArming.armed, false);
    assert.ok(report.findings.some((finding) => finding.section === "gate_arming" && finding.code === "quality_gates_not_required"));

    assert.equal(report.sections.adapters.status, "error");
    assert.equal(report.ok, false);
    assert.ok(report.findings.some((finding) => finding.section === "adapters" && finding.code === "external_adapter_not_prepared"));

    const markdown = await readFile(resolveWildArrangePath(dir, "reports", "doctor.md"), "utf8");
    assert.match(markdown, /Gate arming: NOT ARMED/);
  });
});

test("doctor yellow-lights a changed runner after adoption artifacts exist", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const locator = {
      registryPath: "docs/verification-registry.json",
      bootstrapPath: "docs/verification-bootstrap.json",
      inventoryPath: "docs/verification-inventory.json",
    };
    await mkdir(path.join(dir, "docs"), { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({
      name: "legacy",
      scripts: { test: "node --version" },
    }, null, 2));
    const cards = [{
      id: "card_001_loc",
      action: "adopt",
      asset: "config_locator",
      path: "wildarrange.config.json",
      status: "approved",
      patch: { kind: "json_merge", path: "wildarrange.config.json", value: { verificationGovernance: locator } },
    }];
    await generateVerificationArtifacts(dir, { cards, locator, phase: "registry", writeLocator: true });
    await generateVerificationArtifacts(dir, {
      cards,
      locator,
      phase: "handoff",
      baselineRef: "abc123",
      universeFingerprint: "uni",
    });
    const fresh = await runDoctor(dir);
    assert.equal(fresh.sections.registryFreshness.stale, false);
    const pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    pkg.scripts.test = "node --test";
    await writeFile(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    const drifted = await runDoctor(dir);
    assert.equal(drifted.sections.registryFreshness.stale, true);
    assert.equal(drifted.sections.registryFreshness.status, "declared_input_drift");
    assert.ok(drifted.findings.some((finding) => finding.section === "registry_freshness"));
  });
});

test("config init --armed writes an armed config that passes the gate arming floor", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const { writeDefaultWildArrangeConfig } = await import("../src/infra/runtime-config.mjs");
    const { evaluateGateArming } = await import("../src/infra/gate-arming.mjs");
    const written = await writeDefaultWildArrangeConfig(dir, { root: true, force: true, armed: true });
    assert.equal(written.created, true);
    assert.equal(written.config.qualityGates.commentChecker.blockOnFindings, true);
    const arming = evaluateGateArming({ config: written.config, tasks: [] });
    assert.equal(arming.issues.some((issue) => issue.code === "quality_gates_not_required"), false);
  });
});

test("doctor scopes completion evidence by plan when two plans reuse T001", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    await writeTwoPlanSameTaskLedger(dir);
    await appendLedger(dir, {
      type: "node_checkpoint_completed",
      planId: "plan-a",
      taskId: "T001",
    });

    const report = await runDoctor(dir);
    const missingEvents = report.findings.filter((finding) =>
      finding.section === "completion_audit"
        && finding.message.includes("ledger has no completion event"));

    assert.equal(report.sections.completionAudit.checkedCompleted, 2);
    assert.equal(report.sections.completionAudit.planCount, 2);
    assert.deepEqual(missingEvents.map((finding) => finding.taskRef), ["plan-b:T001"]);
  });
});

test("doctor never counts an unscoped completion event as proof for either same-id task", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    await writeTwoPlanSameTaskLedger(dir);
    await appendLedger(dir, {
      type: "node_checkpoint_completed",
      taskId: "T001",
    });

    const report = await runDoctor(dir);
    const missingEvents = report.findings.filter((finding) =>
      finding.section === "completion_audit"
        && finding.message.includes("ledger has no completion event"));

    assert.deepEqual(missingEvents.map((finding) => finding.taskRef).sort(), ["plan-a:T001", "plan-b:T001"]);
  });
});

test("doctor never assigns an archived Plan's unscoped completion event to a new same-id task", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const task = {
      id: "T001",
      planId: "plan-new",
      ref: "plan-new:T001",
      subject: "New task reusing an old id",
      status: "completed",
      verify_commands: ["node --version"],
      review_commands: ["node --version"],
      writable_paths: ["src/**"],
      evidence: [],
      history: [{ at: "2026-08-25T00:00:00.000Z", event: "completed", status: "completed" }],
    };
    await appendLedger(dir, { type: "node_checkpoint_completed", taskId: "T001" });
    await writeFile(resolveWildArrangePath(dir, "team", "tasks.json"), JSON.stringify({
      version: 1,
      kind: "task_ledger",
      activePlanId: "plan-new",
      plans: [{ id: "plan-new", taskIds: ["T001"] }],
      tasks: [task],
    }, null, 2), "utf8");
    await mkdir(resolveWildArrangePath(dir, "checkpoints", "plan-new"), { recursive: true });
    await mkdir(resolveWildArrangePath(dir, "reports", "acceptance", "plan-new"), { recursive: true });
    await writeFile(resolveWildArrangePath(dir, "checkpoints", "plan-new", "T001.json"), JSON.stringify({ planId: "plan-new", taskId: "T001" }), "utf8");
    await writeFile(resolveWildArrangePath(dir, "reports", "acceptance", "plan-new", "T001.json"), JSON.stringify({ planId: "plan-new", taskId: "T001" }), "utf8");

    const report = await runDoctor(dir);
    assert.equal(report.ok, false);
    assert.ok(report.findings.some((finding) =>
      finding.taskRef === "plan-new:T001"
      && finding.message.includes("ledger has no completion event")));
  });
});

test("doctor rejects a completed task whose acceptance proof says false", async () => {
  await withExternalProject(async ({ projectRoot: dir }) => {
    const task = {
      id: "T001",
      planId: "proof-plan",
      ref: "proof-plan:T001",
      subject: "False proof must stay visible",
      status: "completed",
      verify_commands: ["node verify.cjs"],
      review_commands: ["node review.cjs"],
      writable_paths: ["result.txt"],
      responsibilityChanges: declare("result.txt"),
      evidence: [],
      history: [],
    };
    await writeFile(resolveWildArrangePath(dir, "team", "tasks.json"), JSON.stringify({
      version: 1,
      kind: "task_ledger",
      activePlanId: "proof-plan",
      plans: [{ id: "proof-plan", taskIds: ["T001"] }],
      tasks: [task],
    }, null, 2), "utf8");
    await mkdir(resolveWildArrangePath(dir, "checkpoints", "proof-plan"), { recursive: true });
    await mkdir(resolveWildArrangePath(dir, "reports", "acceptance", "proof-plan"), { recursive: true });
    await writeFile(resolveWildArrangePath(dir, "checkpoints", "proof-plan", "T001.json"), JSON.stringify({
      planId: "proof-plan",
      taskId: "T001",
      verifyResult: { pass: true },
      scopeResult: { status: "pass" },
      reviewResult: { pass: true },
    }), "utf8");
    await writeFile(resolveWildArrangePath(dir, "reports", "acceptance", "proof-plan", "T001.json"), JSON.stringify({
      kind: "acceptance_proof",
      planId: "proof-plan",
      taskId: "T001",
      pass: false,
    }), "utf8");
    await appendLedger(dir, { type: "node_checkpoint_completed", planId: "proof-plan", taskId: "T001" });

    const report = await runDoctor(dir);
    const finding = report.findings.find((item) => item.section === "completion_audit" && item.taskId === "T001");
    assert.ok(finding?.failures.includes("acceptance_proof"));
  });
});

async function writeTwoPlanSameTaskLedger(dir) {
  const task = (planId) => ({
    id: "T001",
    planId,
    ref: `${planId}:T001`,
    subject: `Completed task in ${planId}`,
    status: "completed",
    verify_commands: ["node --version"],
    review_commands: ["node --version"],
    writable_paths: ["src/**"],
    evidence: [],
    history: [{ at: "2026-08-24T00:00:00.000Z", event: "completed", status: "completed" }],
  });
  await writeFile(resolveWildArrangePath(dir, "team", "tasks.json"), JSON.stringify({
    version: 1,
    kind: "task_ledger",
    activePlanId: "plan-b",
    plans: [
      { id: "plan-a", taskIds: ["T001"] },
      { id: "plan-b", taskIds: ["T001"] },
    ],
    tasks: [task("plan-a"), task("plan-b")],
  }, null, 2), "utf8");
  for (const planId of ["plan-a", "plan-b"]) {
    await mkdir(resolveWildArrangePath(dir, "checkpoints", planId), { recursive: true });
    await mkdir(resolveWildArrangePath(dir, "reports", "acceptance", planId), { recursive: true });
    await writeFile(resolveWildArrangePath(dir, "checkpoints", planId, "T001.json"), JSON.stringify({ planId, taskId: "T001" }), "utf8");
    await writeFile(resolveWildArrangePath(dir, "reports", "acceptance", planId, "T001.json"), JSON.stringify({ planId, taskId: "T001" }), "utf8");
  }
}

