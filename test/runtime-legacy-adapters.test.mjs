// =============================================================================
// 文件名称：runtime-legacy-adapters.test.mjs
// 所属模块：test
// 作用说明：
//   legacy 单根模式专属用例：项目内 adapter 安装/备份恢复及其 CLI 事实、workflow --sample（样例计划把产物写进项目内 .wildarrange/）、doctor 健康路径（外置 worktree 被误判漂移，见回报）。外置化后随 legacy 删除或改写。
// =============================================================================

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installAdapter, restoreAdapterBackup, uninstallAdapter } from "../src/interface/adapters.mjs";
import { runDoctor } from "../src/interface/doctor.mjs";
import { runWorkflow } from "../src/orchestration/workflow.mjs";
import { resumeReport } from "../src/ai/context.mjs";
import { runCommand } from "../src/infra/command-runner.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { hashContent, readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";
import { writeRuntimeStateBackup } from "../src/infra/security.mjs";
import { runInjectionHook } from "./helpers/runtime-fixtures.mjs";

// legacy 单根模式：项目即运行态根，不连接任何治理仓；本文件随 legacy 一并删除。
async function withTempDir(fn) {
  const baseDir = path.join(os.tmpdir(), "wildarrange-tests");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-linear-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("adapter install writes slash commands for cursor and codex", async () => {
  await withTempDir(async (dir) => {
    const report = await installAdapter(dir, { target: "all", mode: "npx", packageName: "wildarrange" });

    const cursorDoctor = report.outputs.find((output) => output.path === ".cursor/commands/wildarrange-doctor.md" && output.enforcement === "slash-command");
    assert.ok(cursorDoctor, "cursor doctor command should be generated");
    const codexDoctor = report.outputs.find((output) => output.path === ".agents/skills/wildarrange-doctor/SKILL.md" && output.enforcement === "slash-command");
    assert.ok(codexDoctor, "codex doctor skill should be generated");

    const cursorConfig = await readFile(path.join(dir, ".cursor", "commands", "wildarrange-config.md"), "utf8");
    assert.match(cursorConfig, /config init --root/);
    assert.match(cursorConfig, /npx -y wildarrange/);
    assert.doesNotMatch(cursorConfig, /^name:/m);

    const codexSkill = await readFile(path.join(dir, ".agents", "skills", "wildarrange-doctor", "SKILL.md"), "utf8");
    assert.match(codexSkill, /^name: wildarrange-doctor$/m);
    assert.match(codexSkill, /^description: /m);
    assert.match(codexSkill, /ledger verify/);

    const runCommand = await readFile(path.join(dir, ".agents", "skills", "wildarrange-run", "SKILL.md"), "utf8");
    assert.match(runCommand, /context build --point before_execute/);
    assert.ok(runCommand.indexOf("context build --point before_execute") < runCommand.indexOf("wildarrange run"));
    assert.match(runCommand, /injectionPoint\.skills/);

    const planCommand = await readFile(path.join(dir, ".agents", "skills", "wildarrange-plan", "SKILL.md"), "utf8");
    assert.match(planCommand, /\.wildarrange\/plan-drafts\/<session>-plan\.json/);
    assert.match(planCommand, /generated_by: "host_semantic"/);
    assert.match(planCommand, /task\.owner/);
    assert.match(planCommand, /`worker_command`/);
    assert.match(planCommand, /隔离任务 worktree/);
    assert.match(planCommand, /node --version.*process\.exit\(0\).*占位/);
    assert.match(planCommand, /只要求生成草稿.*不得执行下面的导入命令/);
    assert.match(planCommand, /Jiuwei 或 ZhuRong/);
    assert.match(planCommand, /不能成为 command worker/);
    assert.match(planCommand, /`verify_commands` 必须是非空的命令字符串数组/);
    assert.match(planCommand, /从 0 开始的命令索引数组/);
    assert.match(planCommand, /clarify-feature-design/);
    assert.match(planCommand, /直接在当前对话中按编号澄清/);
    assert.match(planCommand, /不要创建 MD\/HTML 文件/);
    assert.ok(planCommand.indexOf("明确回复“确认”") < planCommand.indexOf("生成 `.wildarrange/plan-drafts/<session>-plan.json`"));

    const uninstall = await uninstallAdapter(dir, { target: "all" });
    assert.ok(uninstall.outputs.some((output) => output.path === ".cursor/commands/wildarrange-run.md" && output.status === "removed"));
    assert.ok(uninstall.outputs.some((output) => output.path === ".agents/skills/wildarrange-run/SKILL.md" && output.status === "removed"));
    await assert.rejects(readFile(path.join(dir, ".cursor", "commands", "wildarrange-run.md"), "utf8"), /ENOENT/);
  });
});

test("adapter install writes codex hooks and cursor rules", async () => {
  await withTempDir(async (dir) => {
    const report = await installAdapter(dir, { target: "all", mode: "npx", packageName: "wildarrange" });
    assert.equal(report.mode, "npx");
    assert.equal(report.result, "files_generated");
    assert.equal(report.activationVerified, false);
    assert.ok(report.outputs.some((output) => output.path === ".codex/hooks.json" && output.enforcement === "hard-after-trust"));
    assert.ok(report.outputs.some((output) => output.path === ".wildarrange/adapters/codex/hooks.json"));
    assert.ok(report.outputs.some((output) => output.path === ".cursor/rules/wildarrange.mdc"));

    const codexHooks = await readJson(path.join(dir, ".codex", "hooks.json"));
    assert.equal(codexHooks.hooks.PostToolUse?.[0]?.matcher, undefined, "Codex PostToolUse 应覆盖全部工具活动");
    assert.ok(codexHooks.hooks.PreToolUse);
    assert.match(codexHooks.hooks.PreToolUse[0].matcher, /Bash/);
    assert.match(codexHooks.hooks.PreToolUse[0].matcher, /apply_patch/);
    assert.match(codexHooks.hooks.PreToolUse[0].matcher, /functions\\\.apply_patch/);
    assert.match(codexHooks.hooks.SessionStart[0].hooks[0].command, /npx -y wildarrange hook run/);
    assert.match(codexHooks.hooks.SessionStart[0].hooks[0].command, /--adapter-mode npx/);
    assert.match(codexHooks.hooks.SessionStart[0].hooks[0].command, /--adapter-package "wildarrange"/);
    assert.match(codexHooks.hooks.SessionStart[0].hooks[0].command, /--host codex$/);
    const cursorBridge = await readFile(path.join(dir, ".cursor", "hooks", "wildarrange-hook-bridge.mjs"), "utf8");
    assert.match(cursorBridge, /"--adapter-mode", cliSpec\.kind/);
    assert.match(cursorBridge, /"--adapter-package", cliSpec\.packageName/);
    assert.match(await readFile(resolveWildArrangePath(dir, "adapters", "install-report.md"), "utf8"), /host activation not yet verified/);
    assert.match(await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8"), /adapter_files_generated/);
    assert.doesNotMatch(await readFile(resolveWildArrangePath(dir, "ledger.jsonl"), "utf8"), /adapter_installed/);

    const cursorRule = await readFile(path.join(dir, ".cursor", "rules", "wildarrange.mdc"), "utf8");
    assert.match(cursorRule, /alwaysApply: true/);
    assert.match(cursorRule, /WildArrange Governance Runtime/);

    const cursorRulePath = path.join(dir, ".cursor", "rules", "wildarrange.mdc");
    await writeFile(cursorRulePath, "existing user rule\n");
    const reinstall = await installAdapter(dir, { target: "cursor", mode: "local" });
    const ruleOutput = reinstall.outputs.find((output) => output.path === ".cursor/rules/wildarrange.mdc");
    assert.ok(ruleOutput.backup);
    assert.equal(await readFile(path.join(dir, ruleOutput.backup), "utf8"), "existing user rule\n");

    const uninstall = await uninstallAdapter(dir, { target: "all" });
    const removedCodex = uninstall.outputs.find((output) => output.path === ".codex/hooks.json" && output.status === "removed");
    assert.ok(removedCodex?.backup);
    const removedRule = uninstall.outputs.find((output) => output.path === ".cursor/rules/wildarrange.mdc" && output.status === "removed");
    assert.ok(removedRule?.backup);
    await assert.rejects(readFile(cursorRulePath, "utf8"), /ENOENT/);
    assert.match(await readFile(resolveWildArrangePath(dir, "adapters", "uninstall-report.md"), "utf8"), /Adapter Uninstall Report/);

    const backupId = removedRule.backup.split("/")[3];
    const restored = await restoreAdapterBackup(dir, { backupId });
    assert.ok(restored.outputs.some((output) => output.path === ".cursor/rules/wildarrange.mdc" && output.status === "restored"));
    assert.match(await readFile(cursorRulePath, "utf8"), /WildArrange Governance Runtime/);
    assert.match(await readFile(resolveWildArrangePath(dir, "adapters", "restore-report.md"), "utf8"), /Adapter Restore Report/);
  });
});

test("adapter reinstall backup restores hooks, install facts, and runtime command context together", async () => {
  await withTempDir(async (dir) => {
    const oldInstall = await installAdapter(dir, { target: "codex", mode: "local" });
    const oldHooksText = await readFile(path.join(dir, ".codex", "hooks.json"), "utf8");
    const oldHooks = JSON.parse(oldHooksText);
    assert.ok(oldHooks.hooks.SessionStart[0].hooks[0].command.includes(`${oldInstall.cliPrefix} hook run`));

    const newInstall = await installAdapter(dir, {
      target: "codex",
      mode: "npx",
      packageName: "@example/wildarrange-fork",
    });
    assert.ok(newInstall.previousInstallReportBackup);
    assert.ok(newInstall.previousInstallReportMdBackup);
    assert.equal(newInstall.outputs.some((output) => output.path === ".wildarrange/adapters/install-report.json"), false);
    assert.equal(newInstall.outputs.some((output) => output.path === ".wildarrange/adapters/install-report.md"), false);
    const backedInstall = await readJson(path.join(dir, newInstall.previousInstallReportBackup));
    assert.equal(backedInstall.cliPrefix, oldInstall.cliPrefix);
    assert.equal((await readJson(resolveWildArrangePath(dir, "snapshots", "context.json"))).cliCommandPrefix, newInstall.cliPrefix);

    const restored = await restoreAdapterBackup(dir, { backupId: newInstall.backupId });
    assert.ok(restored.outputs.some((output) => output.path === ".wildarrange/adapters/install-report.json"));
    assert.equal(await readFile(path.join(dir, ".codex", "hooks.json"), "utf8"), oldHooksText);
    const restoredInstall = await readJson(resolveWildArrangePath(dir, "adapters", "install-report.json"));
    assert.equal(restoredInstall.mode, "local");
    assert.equal(restoredInstall.cliPrefix, oldInstall.cliPrefix);
    const restoredInstallMd = await readFile(resolveWildArrangePath(dir, "adapters", "install-report.md"), "utf8");
    assert.match(restoredInstallMd, /^Mode: local$/m);
    assert.match(restoredInstallMd, /^Package: @alivewavelab\/wildarrange$/m);
    assert.ok(restoredInstallMd.includes(`CLI prefix: ${oldInstall.cliPrefix}`));
    assert.doesNotMatch(restoredInstallMd, /@example\/wildarrange-fork/);
    const restoredContext = await readJson(resolveWildArrangePath(dir, "snapshots", "context.json"));
    assert.equal(restoredContext.cliCommandPrefix, oldInstall.cliPrefix);
    assert.match(await readFile(resolveWildArrangePath(dir, "snapshots", "context.md"), "utf8"), /adapter_restore/);
    assert.ok((await readFile(resolveWildArrangePath(dir, "snapshots", "context.md"), "utf8")).includes(`${oldInstall.cliPrefix} resume`));
  });
});

test("legacy and uninstall backups recover CLI context from restored hook facts", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const legacyHookPath = resolveWildArrangePath(dir, "adapters", "backups", "legacy-hook", ".codex", "hooks.json");
    await mkdir(path.dirname(legacyHookPath), { recursive: true });
    await writeFile(legacyHookPath, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ command: "node \"C:\\npm-cache\\_npx\\abc\\node_modules\\@alivewavelab\\wildarrange\\bin\\wildarrange.mjs\" hook run" }] }],
      },
    }, null, 2));
    await restoreAdapterBackup(dir, { backupId: "legacy-hook" });
    let context = await readJson(resolveWildArrangePath(dir, "snapshots", "context.json"));
    assert.equal(context.cliCommandPrefix, "npx -y @alivewavelab/wildarrange");
    let contextMd = await readFile(resolveWildArrangePath(dir, "snapshots", "context.md"), "utf8");
    assert.match(contextMd, /npx -y @alivewavelab\/wildarrange resume/);
    assert.doesNotMatch(contextMd, /node \.\/bin\/wildarrange\.mjs/);

    const installed = await installAdapter(dir, { target: "codex", mode: "npx", packageName: "@example/wildarrange-fork" });
    const uninstalled = await uninstallAdapter(dir, { target: "codex" });
    await rm(resolveWildArrangePath(dir, "adapters", "install-report.json"), { force: true });
    await rm(resolveWildArrangePath(dir, "adapters", "install-report.md"), { force: true });
    await restoreAdapterBackup(dir, { backupId: uninstalled.backupId });
    context = await readJson(resolveWildArrangePath(dir, "snapshots", "context.json"));
    assert.equal(context.cliCommandPrefix, installed.cliPrefix);
    contextMd = await readFile(resolveWildArrangePath(dir, "snapshots", "context.md"), "utf8");
    assert.ok(contextMd.includes(`${installed.cliPrefix} resume`));
    assert.doesNotMatch(contextMd, /node \.\/bin\/wildarrange\.mjs/);
  });
});

test("legacy npx cache hooks preserve custom scoped and unscoped package identity", async () => {
  for (const fixture of [
    {
      packageName: "@example/wildarrange-fork",
      cliPath: "C:\\npm-cache\\_npx\\scoped\\node_modules\\@example\\wildarrange-fork\\bin\\wildarrange.mjs",
    },
    {
      packageName: "wildarrange-fork",
      cliPath: "C:\\npm-cache\\_npx\\unscoped\\node_modules\\wildarrange-fork\\bin\\wildarrange.mjs",
    },
  ]) {
    await withTempDir(async (dir) => {
      await initRuntime(dir);
      const hookPath = resolveWildArrangePath(dir, "adapters", "backups", "legacy-custom-npx", ".codex", "hooks.json");
      await mkdir(path.dirname(hookPath), { recursive: true });
      await writeFile(hookPath, JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ command: `node "${fixture.cliPath}" hook run` }] }],
        },
      }, null, 2));

      await restoreAdapterBackup(dir, { backupId: "legacy-custom-npx" });
      const context = await readJson(resolveWildArrangePath(dir, "snapshots", "context.json"));
      assert.equal(context.cliCommandPrefix, `npx -y ${fixture.packageName}`);
      const contextMd = await readFile(resolveWildArrangePath(dir, "snapshots", "context.md"), "utf8");
      assert.ok(contextMd.includes(`npx -y ${fixture.packageName} resume`));
      assert.doesNotMatch(contextMd, /@alivewavelab\/wildarrange/);
    });
  }
});

test("unrecognized legacy npx cache hook does not guess a package identity", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const hookPath = resolveWildArrangePath(dir, "adapters", "backups", "legacy-unknown-npx", ".codex", "hooks.json");
    await mkdir(path.dirname(hookPath), { recursive: true });
    await writeFile(hookPath, JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ command: "node \"C:\\npm-cache\\_npx\\unknown\\wildarrange.mjs\" hook run" }] }],
      },
    }, null, 2));

    await restoreAdapterBackup(dir, { backupId: "legacy-unknown-npx" });
    const context = await readJson(resolveWildArrangePath(dir, "snapshots", "context.json"));
    assert.equal(context.cliCommandPrefix, null);
    assert.equal(context.nextActionDetails.command, null);
    const contextMd = await readFile(resolveWildArrangePath(dir, "snapshots", "context.md"), "utf8");
    assert.match(contextMd, /Unavailable: reinstall the WildArrange adapter/);
    assert.doesNotMatch(contextMd, /@alivewavelab\/wildarrange|node \.\/bin\/wildarrange\.mjs/);
  });
});

test("restore without an executable CLI fact leaves context commands unavailable", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const legacyRulePath = resolveWildArrangePath(dir, "adapters", "backups", "legacy-rule-only", ".cursor", "rules", "wildarrange.mdc");
    await mkdir(path.dirname(legacyRulePath), { recursive: true });
    await writeFile(legacyRulePath, "legacy rule\n");
    await restoreAdapterBackup(dir, { backupId: "legacy-rule-only" });
    const context = await readJson(resolveWildArrangePath(dir, "snapshots", "context.json"));
    assert.equal(context.cliCommandPrefix, null);
    assert.equal(context.nextActionDetails.command, null);
    const contextMd = await readFile(resolveWildArrangePath(dir, "snapshots", "context.md"), "utf8");
    assert.match(contextMd, /Unavailable: reinstall the WildArrange adapter/);
    assert.doesNotMatch(contextMd, /node \.\/bin\/wildarrange\.mjs/);
  });
});

test("legacy bridge-only backup restores its generated npx CLI fact", async () => {
  await withTempDir(async (dir) => {
    const installed = await installAdapter(dir, {
      target: "cursor",
      mode: "npx",
      packageName: "@example/wildarrange-fork",
    });
    const liveBridgePath = path.join(dir, ".cursor", "hooks", "wildarrange-hook-bridge.mjs");
    const bridgeSource = await readFile(liveBridgePath, "utf8");
    const backupBridgePath = resolveWildArrangePath(dir, "adapters", "backups", "legacy-bridge-only", ".cursor", "hooks", "wildarrange-hook-bridge.mjs");
    await mkdir(path.dirname(backupBridgePath), { recursive: true });
    await writeFile(backupBridgePath, bridgeSource);
    await rm(liveBridgePath, { force: true });
    await rm(resolveWildArrangePath(dir, "adapters", "install-report.json"), { force: true });
    await rm(resolveWildArrangePath(dir, "adapters", "install-report.md"), { force: true });

    await restoreAdapterBackup(dir, { backupId: "legacy-bridge-only" });
    const context = await readJson(resolveWildArrangePath(dir, "snapshots", "context.json"));
    assert.equal(context.cliCommandPrefix, installed.cliPrefix);
    const contextMd = await readFile(resolveWildArrangePath(dir, "snapshots", "context.md"), "utf8");
    assert.ok(contextMd.includes(`${installed.cliPrefix} resume`));
    assert.doesNotMatch(contextMd, /node \.\/bin\/wildarrange\.mjs/);
  });
});

test("workflow runs sample plan end to end and writes resumable state", async () => {
  await withTempDir(async (dir) => {
    const result = await runWorkflow(dir, { sample: true });
    assert.equal(result.ok, true);
    assert.equal(result.summaryPath, ".wildarrange/reports/workflow-summary.md");
    assert.equal(result.status.completed, 1);
    assert.equal(result.status.pending, 0);

    const resume = await resumeReport(dir);
    assert.equal(resume.latestSnapshot.stage, "workflow_finished");
    assert.equal(resume.nextAction, "no runnable task");

    const summary = await readJson(resolveWildArrangePath(dir, "reports", "workflow-summary.json"));
    assert.equal(summary.ok, true);
    assert.equal(summary.tasks[0].status, "completed");
    assert.match(await readFile(resolveWildArrangePath(dir, "reports", "workflow-summary.md"), "utf8"), /Status: PASS/);
    assert.match(await readFile(resolveWildArrangePath(dir, "reports", "workflow-summary.md"), "utf8"), /Task Breakdown/);
  });
});

test("doctor passes on a healthy runtime and flags hand-edited completion", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const workflow = await runWorkflow(dir, { sample: true });
    assert.equal(workflow.ok, true);
    await installAdapter(dir, { target: "codex", mode: "local" });
    await runInjectionHook(dir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "doctor-healthy-session",
      cwd: dir,
      prompt: "检查当前健康状态",
      host_adapter: "codex",
      hook_config_digest: hashContent(await readFile(path.join(dir, ".codex", "hooks.json"), "utf8")),
    });
    await writeRuntimeStateBackup(dir, { reason: "doctor-baseline" });

    const healthy = await runDoctor(dir);
    assert.equal(healthy.ok, true, JSON.stringify(healthy.findings, null, 2));
    assert.equal(healthy.errorCount, 0);
    assert.ok(healthy.sections.completionAudit.checkedCompleted >= 1);
    assert.equal(healthy.sections.ledgerBackupCrossCheck.prefixIntact, true);

    const tasksPath = resolveWildArrangePath(dir, "team", "tasks.json");
    const state = await readJson(tasksPath);
    state.tasks.push({
      id: "T999",
      subject: "手改的假完成任务",
      status: "completed",
      attempts: 0,
      maxAttempts: 3,
      blockedBy: [],
      writable_paths: [],
      worker_command: null,
      verify_commands: ["true"],
      review_commands: ["node --version"],
      evidence: [],
    });
    await writeFile(tasksPath, JSON.stringify(state, null, 2), "utf8");

    const flagged = await runDoctor(dir);
    assert.equal(flagged.ok, false);
    const messages = flagged.findings.map((finding) => finding.message).join("\n");
    assert.match(messages, /T999 is completed but has no checkpoint file/);
  });
});
