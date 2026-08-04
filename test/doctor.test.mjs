import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDoctor } from "../src/interface/doctor.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { resolveHelixPath } from "../src/infra/runtime-store.mjs";

test("doctor keeps reporting when one check crashes on corrupted state", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    // 人为损坏 tasks.json：completionAudit 检查会抛错，其余检查必须照常。
    const tasksPath = resolveHelixPath(dir, "team", "tasks.json");
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

    const markdown = await readFile(resolveHelixPath(dir, "reports", "doctor.md"), "utf8");
    assert.match(markdown, /CHECK FAILED/);
    assert.match(markdown, /Config source:/);
  });
});

test("doctor is diagnostic-only and never appends to the hash-chained ledger", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const ledgerPath = resolveHelixPath(dir, "ledger.jsonl");
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

    const markdown = await readFile(resolveHelixPath(dir, "reports", "doctor.md"), "utf8");
    assert.match(markdown, /Gate arming: NOT ARMED/);
    assert.match(markdown, /cursor:MISSING/);
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
    await mkdir(resolveHelixPath(dir, "adapters", "kimi", "plugin", "hooks"), { recursive: true });
    await writeFile(resolveHelixPath(dir, "adapters", "kimi", "plugin", "hooks", "wildarrange-hook-bridge.mjs"), "// bridge\n", "utf8");
    // 换机残留：规则里指向不存在绝对路径的命令会静默失效。
    await mkdir(path.join(dir, ".cursor", "rules"), { recursive: true });
    await writeFile(path.join(dir, ".cursor", "rules", "stale.mdc"), "run `node \"/Users/ghost/nonexistent/bin/helix.mjs\" hook run`\n", "utf8");

    const report = await runDoctor(dir);
    const cursor = report.sections.adapters.targets.find((target) => target.target === "cursor");
    assert.equal(cursor.installed, true);
    assert.equal(report.sections.adapters.staleRules.length, 1);
    assert.ok(report.findings.some((finding) => finding.message.includes("/Users/ghost/nonexistent")));
  });
});

test("config init --armed writes an armed config that passes the gate arming floor", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const { writeDefaultHelixConfig } = await import("../src/infra/runtime-config.mjs");
    const { evaluateGateArming } = await import("../src/infra/gate-arming.mjs");
    const written = await writeDefaultHelixConfig(dir, { root: true, force: true, armed: true });
    assert.equal(written.created, true);
    assert.equal(written.config.qualityGates.commentChecker.blockOnFindings, true);
    const arming = evaluateGateArming({ config: written.config, tasks: [] });
    assert.equal(arming.issues.some((issue) => issue.code === "quality_gates_not_required"), false);
  });
});

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-doctor-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
