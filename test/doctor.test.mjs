import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDoctor } from "../src/interface/doctor.mjs";
import { appendLedger } from "../src/infra/ledger.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { generateVerificationArtifacts } from "../src/capabilities/verification-governance.mjs";

test("doctor keeps reporting when one check crashes on corrupted state", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
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
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const ledgerPath = resolveWildArrangePath(dir, "ledger.jsonl");
    const before = existsSync(ledgerPath) ? await readFile(ledgerPath, "utf8") : "";

    await runDoctor(dir);

    const after = existsSync(ledgerPath) ? await readFile(ledgerPath, "utf8") : "";
    assert.equal(after, before);
  });
});

test("doctor surfaces unarmed gates and missing adapter hooks instead of burying them", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    // initRuntime 写的是默认配置：质量门全关、adapter 启用但未安装。
    const report = await runDoctor(dir);

    assert.equal(report.sections.gateArming.armed, false);
    assert.ok(report.findings.some((finding) => finding.section === "gate_arming" && finding.code === "quality_gates_not_required"));

    const cursor = report.sections.adapters.targets.find((target) => target.target === "cursor");
    assert.equal(cursor.installed, false);
    assert.ok(report.findings.some((finding) => finding.section === "adapters" && finding.message.includes(".cursor/hooks.json")));

    const markdown = await readFile(resolveWildArrangePath(dir, "reports", "doctor.md"), "utf8");
    assert.match(markdown, /Gate arming: NOT ARMED/);
    assert.match(markdown, /cursor:MISSING/);
  });
});

test("doctor yellow-lights a changed runner after adoption artifacts exist", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
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
    await writeFile(path.join(dir, "wildarrange.config.json"), JSON.stringify({
      verificationGovernance: locator,
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

test("doctor adapter check passes once hooks are installed and flags stale rule paths", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(dir, ".cursor", "hooks"), { recursive: true });
    await writeFile(path.join(dir, ".cursor", "hooks.json"), JSON.stringify({
      hooks: { preToolUse: [{ command: "node .cursor/hooks/wildarrange-hook-bridge.mjs", failClosed: true }] },
    }), "utf8");
    await writeFile(path.join(dir, ".cursor", "hooks", "wildarrange-hook-bridge.mjs"), "// bridge\n", "utf8");
    await mkdir(path.join(dir, ".codex"), { recursive: true });
    await writeFile(path.join(dir, ".codex", "hooks.json"), "{}", "utf8");
    await mkdir(resolveWildArrangePath(dir, "adapters", "kimi", "plugin", "hooks"), { recursive: true });
    await writeFile(resolveWildArrangePath(dir, "adapters", "kimi", "plugin", "hooks", "wildarrange-hook-bridge.mjs"), "// bridge\n", "utf8");
    // 换机残留：规则里指向不存在绝对路径的命令会静默失效。
    await mkdir(path.join(dir, ".cursor", "rules"), { recursive: true });
    await writeFile(path.join(dir, ".cursor", "rules", "stale.mdc"), "run `node \"/Users/ghost/nonexistent/bin/wildarrange.mjs\" hook run`\n", "utf8");
    await writeFile(path.join(dir, ".cursor", "rules", ["wildarrange", "flow.mdc"].join("")), "alwaysApply: true\n", "utf8");

    const report = await runDoctor(dir);
    const cursor = report.sections.adapters.targets.find((target) => target.target === "cursor");
    assert.equal(cursor.installed, true);
    assert.equal(report.sections.adapters.staleRules.length, 1);
    assert.deepEqual(report.sections.adapters.legacyManagedRules, [{ path: ".cursor/rules/wildarrangeflow.mdc" }]);
    assert.ok(report.findings.some((finding) => finding.message.includes("/Users/ghost/nonexistent")));
    assert.ok(report.findings.some((finding) => finding.message.includes("legacy managed Cursor rule")));
  });
});

test("config init --armed writes an armed config that passes the gate arming floor", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
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
  await withTempDir(async (dir) => {
    await initRuntime(dir);
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

test("doctor rejects an unscoped legacy completion event when T001 belongs to two plans", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await writeTwoPlanSameTaskLedger(dir);
    await appendLedger(dir, {
      type: "node_checkpoint_completed",
      taskId: "T001",
    });

    const report = await runDoctor(dir);
    const ambiguous = report.findings.find((finding) => finding.code === "ambiguous_legacy_completion_event");
    const missingEvents = report.findings.filter((finding) =>
      finding.section === "completion_audit"
        && finding.message.includes("ledger has no completion event"));

    assert.ok(ambiguous);
    assert.deepEqual(ambiguous.planIds, ["plan-a", "plan-b"]);
    assert.equal(report.sections.completionAudit.ambiguousLegacyCompletionEvents, 1);
    assert.deepEqual(missingEvents.map((finding) => finding.taskRef).sort(), ["plan-a:T001", "plan-b:T001"]);
  });
});

test("doctor never assigns an archived Plan's unscoped completion event to a new same-id task", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
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
    const unscoped = report.findings.find((finding) => finding.code === "ambiguous_legacy_completion_event");
    assert.deepEqual(unscoped?.planIds, ["plan-new"]);
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

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-doctor-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
