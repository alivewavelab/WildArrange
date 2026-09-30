// =============================================================================
// 文件名称：runtime-integrity.test.mjs
// 所属模块：test
// 作用说明：
//   完整性：ledger 哈希链、命令安全、配置基线、状态备份恢复、doctor 与完成伪造对抗。
// =============================================================================

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runDoctor } from "../src/interface/doctor.mjs";

import { runNextTask } from "../src/orchestration/linear-runtime.mjs";
import { compileCommandSafetyPatterns, evaluateCommandSafety } from "../src/infra/command-safety.mjs";
import { runCommand, runCommandFile } from "../src/infra/command-runner.mjs";
import { appendLedger, verifyLedger } from "../src/infra/ledger.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { listRuntimeStateBackups, restoreRuntimeStateBackup, writeRuntimeStateBackup } from "../src/infra/state-backup.mjs";
import { verifyConfigBaseline, writeConfigBaseline } from "../src/infra/config-baseline.mjs";
import { verifyRuntimeState } from "../src/infra/runtime-integrity.mjs";
import { withExternalProject, importApprovedPlan, declare } from "./helpers/external-fixture.mjs";
import { createSmokePlan, nodeEval, writePolicyConfig } from "./helpers/runtime-fixtures.mjs";

/** 夹具任务可能改动的文件：职责声明覆盖本文件用例写入的全部路径。 */
const SRC_RESPONSIBILITY = declare("src/app.js");

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

test("ledger verification detects tampered hash chain entries", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    let verification = await verifyLedger(projectRoot);
    assert.equal(verification.ok, true);

    const ledgerPath = resolveWildArrangePath(projectRoot, "ledger.jsonl");
    const lines = (await readFile(ledgerPath, "utf8")).trim().split(/\r?\n/);
    const first = JSON.parse(lines[0]);
    first.type = "tampered_event";
    lines[0] = JSON.stringify(first);
    await writeFile(ledgerPath, `${lines.join("\n")}\n`);

    verification = await verifyLedger(projectRoot);
    assert.equal(verification.ok, false);
    assert.ok(verification.failures.some((failure) => failure.reason === "hash_mismatch"));
  });
});

test("ledger appends are serialized under concurrent writers", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    await Promise.all(Array.from({ length: 20 }, (_, index) => appendLedger(projectRoot, {
      type: "concurrent_test_event",
      index,
    })));

    const verification = await verifyLedger(projectRoot);
    assert.equal(verification.ok, true);
    const ledger = await readFile(resolveWildArrangePath(projectRoot, "ledger.jsonl"), "utf8");
    const events = ledger.split(/\r?\n/).filter((line) => line.includes("concurrent_test_event"));
    assert.equal(events.length, 20);
  });
});

test("command safety blocks destructive shell commands before execution", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const result = await runCommand("rm -rf .wildarrange", projectRoot);
    assert.equal(result.exitCode, 126);
    assert.match(result.stderr, /Command blocked by WildArrange command safety/);
    assert.equal(result.safety.allowed, false);

    const ledger = await readFile(resolveWildArrangePath(projectRoot, "ledger.jsonl"), "utf8");
    assert.match(ledger, /runtime_initialized/);
  });
});

test("runCommand caps command output and reports timeout metadata", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const noisy = await runCommand(nodeEval(`
      process.stdout.write("x".repeat(50));
      process.stderr.write("y".repeat(50));
    `), projectRoot, 120_000, { maxOutputChars: 10 });
    assert.equal(noisy.exitCode, 0);
    assert.equal(noisy.stdout.length, 10);
    assert.equal(noisy.stderr.length, 10);
    assert.equal(noisy.outputTruncated.stdout, true);
    assert.equal(noisy.outputTruncated.stderr, true);

    const timeoutPidPath = path.join(projectRoot, "timeout-child.pid");
    const timedOut = await runCommand(nodeEval(`
      require("fs").writeFileSync(${JSON.stringify(timeoutPidPath)}, String(process.pid));
      setInterval(() => {}, 1000);
    `), projectRoot, 200);
    assert.equal(timedOut.exitCode, 124);
    assert.equal(timedOut.timedOut, true);
    assert.match(timedOut.stderr, /Command timed out after 200ms/);
    const timedOutPid = Number(await readFile(timeoutPidPath, "utf8"));
    assert.equal(processIsAlive(timedOutPid), false, "timed-out commands must not leave child processes behind");
  });
});

test("config baseline detects quality gate configuration changes", async () => {
  await withExternalProject(async ({ projectRoot, governanceRoot }) => {
    // 外置模式的质量门配置在治理仓 policy/ 下，基线路径带 governance: 前缀。
    const configFingerprint = "governance:policy/wildarrange.config.json";
    await writePolicyConfig(governanceRoot, `${JSON.stringify({ qualityGates: { commentChecker: { enabled: true, blockOnFindings: true } } }, null, 2)}\n`);

    const baseline = await writeConfigBaseline(projectRoot, { reason: "reviewed" });
    assert.equal(baseline.kind, "config_baseline");
    assert.ok(baseline.files.some((file) => file.path === configFingerprint));

    let verification = await verifyConfigBaseline(projectRoot);
    assert.equal(verification.ok, true);

    await writePolicyConfig(governanceRoot, `${JSON.stringify({ qualityGates: { commentChecker: { enabled: false, blockOnFindings: false } } }, null, 2)}\n`);
    verification = await verifyConfigBaseline(projectRoot);
    assert.equal(verification.ok, false);
    assert.ok(verification.failures.some((failure) => failure.path === configFingerprint && failure.reason === "hash_mismatch"));
  });
});

test("runtime state backup preserves critical files and verify reports missing state", async () => {
  await withExternalProject(async ({ root, projectRoot }) => {
    const samplePath = await createSmokePlan(root);
    await importApprovedPlan(projectRoot, samplePath);
    let verification = await verifyRuntimeState(projectRoot);
    assert.equal(verification.ok, true);

    const backup = await writeRuntimeStateBackup(projectRoot, { reason: "before-risky-agent" });
    assert.equal(backup.kind, "runtime_state_backup");
    assert.ok(backup.files.some((file) => file.path === "runtime/ledger.jsonl" && file.status === "copied"));

    await rm(resolveWildArrangePath(projectRoot, "team", "tasks.json"), { force: true });
    verification = await verifyRuntimeState(projectRoot);
    assert.equal(verification.ok, false);
    assert.ok(verification.failures.some((failure) => failure.path === "runtime:team/tasks.json"));

    const manifest = await readJson(resolveWildArrangePath(projectRoot, "backups", backup.backupId, "manifest.json"));
    assert.equal(manifest.backupId, backup.backupId);
  });
});

test("command safety blocks recursive deletion of project source directories", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const blockedShell = await runCommand("rm -rf src", projectRoot);
    assert.notEqual(blockedShell.exitCode, 0);
    assert.match(blockedShell.stderr, /Command blocked by WildArrange command safety/);

    const blockedNested = await runCommand("echo prep && rm -rf ./test/unit", projectRoot);
    assert.notEqual(blockedNested.exitCode, 0);
    assert.match(blockedNested.stderr, /project source, test, or doc directories/);

    const allowed = evaluateCommandSafety("rm -rf .tmp-scratch node_modules_cache");
    assert.equal(allowed.allowed, true);
  });
});

test("argv command safety still blocks destructive Git subcommands after -C", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    const blocked = await runCommandFile("git", ["-C", projectRoot, "clean", "-fd"], projectRoot);
    assert.equal(blocked.exitCode, 126);
    assert.match(blocked.stderr, /git_history_destroy/);
  });
});

test("state restore recovers runtime files from a backup and keeps a pre-restore backup", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "restore-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Restore drill",
      tasks: [{
        id: "T001",
        subject: "占位任务",
        writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
        review_commands: ["node --version"],
      }],
    }, null, 2));
    await importApprovedPlan(projectRoot, planPath);

    const backup = await writeRuntimeStateBackup(projectRoot, { reason: "before-corruption" });
    const tasksPath = resolveWildArrangePath(projectRoot, "team", "tasks.json");
    const original = await readFile(tasksPath, "utf8");
    await writeFile(tasksPath, "{ corrupted", "utf8");

    const backups = await listRuntimeStateBackups(projectRoot);
    assert.ok(backups.some((entry) => entry.backupId === backup.backupId));

    const restore = await restoreRuntimeStateBackup(projectRoot, { backupId: backup.backupId });
    assert.ok(restore.restored.includes("runtime/team/tasks.json"));
    assert.ok(restore.preRestoreBackupId);
    assert.notEqual(restore.preRestoreBackupId, backup.backupId);
    assert.equal(await readFile(tasksPath, "utf8"), original);

    await assert.rejects(() => restoreRuntimeStateBackup(projectRoot, { backupId: "backup_missing" }), /unknown state backup/);
  });
});

test("doctor detects ledger truncation against the latest backup", async () => {
  await withExternalProject(async ({ projectRoot }) => {
    await writeRuntimeStateBackup(projectRoot, { reason: "anchor" });
    await appendLedger(projectRoot, { type: "post_backup_event" });

    const intact = await runDoctor(projectRoot);
    assert.equal(intact.sections.ledgerBackupCrossCheck.prefixIntact, true);

    const ledgerPath = resolveWildArrangePath(projectRoot, "ledger.jsonl");
    const lines = (await readFile(ledgerPath, "utf8")).split(/\r?\n/).filter(Boolean);
    await writeFile(ledgerPath, `${lines.slice(-2).join("\n")}\n`, "utf8");

    const flagged = await runDoctor(projectRoot);
    assert.equal(flagged.ok, false);
    assert.equal(flagged.sections.ledgerBackupCrossCheck.prefixIntact, false);
    assert.ok(flagged.findings.some((finding) => finding.section === "ledger_backup" && finding.severity === "error"));
  });
});

test("adversarial round 2: completion forgery attempts are caught by gates and doctor", async () => {
  await withExternalProject(async ({ projectRoot, root }) => {
    const planPath = path.join(root, "forgery-plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Forgery drill",
      tasks: [
        {
          id: "T001",
          subject: "试图删除源代码目录",
          writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
          worker_command: "rm -rf src",
          verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
          review_commands: ["node --version"],
        },
        {
          id: "T002",
          subject: "试图越界写文件",
          writable_paths: ["src/**"], responsibilityChanges: SRC_RESPONSIBILITY,
          worker_command: "node -e \"const fs=require('fs'); fs.writeFileSync('secrets.txt','leak')\"",
          verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
          review_commands: ["node --version"],
        },
      ],
    }, null, 2));
    await importApprovedPlan(projectRoot, planPath);

    // 攻击 1：worker 命令直接删源代码目录 -> command safety 先拦
    const first = await runNextTask(projectRoot);
    assert.equal(first.task.id, "T001");
    assert.notEqual(first.task.status, "completed");
    const t1 = (await readJson(resolveWildArrangePath(projectRoot, "team", "tasks.json"))).tasks.find((task) => task.id === "T001");
    assert.notEqual(t1.status, "completed");
    assert.ok(t1.evidence.some((entry) => entry.kind === "worker" && /Command blocked by WildArrange command safety/.test(entry.stderr || "")));

    // 攻击 2：worker 越界写 -> scope guard 拦下并生成 ChangeRequest
    const state = await readJson(resolveWildArrangePath(projectRoot, "team", "tasks.json"));
    state.tasks.find((task) => task.id === "T001").status = "completed";
    await writeFile(resolveWildArrangePath(projectRoot, "team", "tasks.json"), JSON.stringify(state, null, 2), "utf8");
    const second = await runNextTask(projectRoot);
    assert.equal(second.task.id, "T002");
    assert.notEqual(second.task.status, "completed");
    assert.equal(second.scopeResult.status, "fail");
    assert.ok(second.task.last_change_request);

    // 攻击 3：伪造 ledger 完成事件（没有合法 hash 链）-> ledger verify 抓出
    const ledgerPath = resolveWildArrangePath(projectRoot, "ledger.jsonl");
    const currentLedger = await readFile(ledgerPath, "utf8");
    await writeFile(ledgerPath, `${currentLedger}${JSON.stringify({ type: "task_verified", taskId: "T002", forged: true })}\n`, "utf8");
    const ledgerCheck = await verifyLedger(projectRoot);
    assert.equal(ledgerCheck.ok, false);
    assert.ok(ledgerCheck.failures.some((failure) => failure.reason === "unhashed_entry"));

    // 攻击 4：手改台账 + 伪造 checkpoint 文件 -> doctor 仍能从 acceptance proof 与 ledger 对账抓出
    const forgedState = await readJson(resolveWildArrangePath(projectRoot, "team", "tasks.json"));
    forgedState.tasks.find((task) => task.id === "T002").status = "completed";
    await writeFile(resolveWildArrangePath(projectRoot, "team", "tasks.json"), JSON.stringify(forgedState, null, 2), "utf8");
    await mkdir(resolveWildArrangePath(projectRoot, "checkpoints", forgedState.planId), { recursive: true });
    await writeFile(resolveWildArrangePath(projectRoot, "checkpoints", forgedState.planId, "T002.json"), JSON.stringify({ forged: true }), "utf8");
    const report = await runDoctor(projectRoot);
    assert.equal(report.ok, false);
    const messages = report.findings.map((finding) => finding.message).join("\n");
    assert.match(messages, /T002 .*no acceptance proof report/);
    assert.match(messages, /T002 .*ledger has no completion event/);
  });
});

test("command safety allows configured extra patterns to block project-specific commands", async () => {
  const config = {
    commandSafety: {
      extraPatterns: [
        { id: "no_prod_deploy", pattern: "deploy\\s+--env\\s+prod", reason: "生产部署必须走人工流程" },
      ],
    },
  };
  const extraPatterns = compileCommandSafetyPatterns(config);
  assert.equal(extraPatterns.length, 1);

  const blocked = evaluateCommandSafety("deploy --env prod", { extraPatterns });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.findings.some((finding) => finding.id === "no_prod_deploy"));

  // built-in floor still enforced even without extras
  const builtin = evaluateCommandSafety("rm -rf /");
  assert.equal(builtin.allowed, false);

  // 环境变量不再是放行后门
  const previous = process.env.WILDARRANGE_ALLOW_UNSAFE_COMMANDS;
  process.env.WILDARRANGE_ALLOW_UNSAFE_COMMANDS = "1";
  try {
    assert.equal(evaluateCommandSafety("rm -rf /").allowed, false);
    assert.equal(evaluateCommandSafety("sudo ls", { allowUnsafe: true }).allowed, false);
  } finally {
    if (previous === undefined) delete process.env.WILDARRANGE_ALLOW_UNSAFE_COMMANDS;
    else process.env.WILDARRANGE_ALLOW_UNSAFE_COMMANDS = previous;
  }

  // unrelated command with the extra pattern loaded stays allowed
  const ok = evaluateCommandSafety("npm run build", { extraPatterns });
  assert.equal(ok.allowed, true);

  // invalid regex entries are skipped, not thrown
  const skipped = compileCommandSafetyPatterns({ commandSafety: { extraPatterns: [{ pattern: "([" }] } });
  assert.equal(skipped.length, 0);
});
