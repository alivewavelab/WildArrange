// =============================================================================
// 文件名称：cli-smoke.test.mjs
// 所属模块：test
// 作用说明：
//   CLI 冒烟：bin 可加载、init 创建 runtime、status/doctor 可运行、
//   Codex Hook 绑定 control root 与 config digest、worktree 会话路径。
//   不测：完整任务交付或并行 agent 大规模场景。
//
// 【运行原理速读】
//   在临时项目目录 spawn CLI 子进程，检查退出码、stderr 协议与
//   .wildarrange 目录及 adapter hook 安装产物。
// =============================================================================

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.join(process.cwd(), "bin", "wildarrange.mjs");

async function withTempProjectDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-cli-smoke-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runCli(args, cwd, options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...(options.env || {}) },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? String(error),
    };
  }
}

test("cli smoke: attached external governance keeps init out of the project repository", async () => {
  await withTempProjectDir(async (dir) => {
    const governanceRoot = path.join(path.dirname(dir), `${path.basename(dir)}-governance`);
    const stateHome = path.join(path.dirname(dir), `${path.basename(dir)}-state`);
    const env = { WILDARRANGE_STATE_HOME: stateHome };
    await mkdir(path.join(governanceRoot, "policy"), { recursive: true });
    await writeFile(path.join(governanceRoot, "policy", "AGENTS.md"), "# External governance\n\nCLI_EXTERNAL_POLICY_PROBE\n");
    await writeFile(path.join(governanceRoot, "wildarrange-governance.json"), JSON.stringify({
      schemaVersion: 1,
      project: { repository: "https://example.test/product.git", defaultBranch: "main" },
      policyRoot: "policy",
      verificationRegistry: "verification/registry.json",
    }, null, 2));
    try {
      const attached = await runCli(["project", "attach", "--governance-root", governanceRoot], dir, { env });
      assert.equal(attached.code, 0, attached.stderr);
      const connection = JSON.parse(attached.stdout);
      assert.equal(connection.mode, "external");
      assert.equal(connection.projectRoot, dir);
      assert.equal(connection.governanceRoot, governanceRoot);
      assert.equal(existsSync(path.join(dir, ".wildarrange")), false);

      const init = await runCli(["init"], dir, { env });
      assert.equal(init.code, 0, init.stderr);
      const initialized = JSON.parse(init.stdout);
      assert.equal(initialized.workspaceMode, "external");
      assert.equal(initialized.runtime, connection.runtimeRoot);
      assert.equal(existsSync(path.join(connection.runtimeRoot, "work.json")), true);
      assert.equal(existsSync(path.join(dir, ".wildarrange")), false);

      const rules = await runCli(["rules", "collect"], dir, { env });
      assert.equal(rules.code, 0, rules.stderr);
      const ruleResult = JSON.parse(rules.stdout);
      assert.equal(ruleResult.governancePolicyRules, 1);
      assert.ok(ruleResult.rules.some((rule) => rule.source === "governance_policy" && rule.content.includes("CLI_EXTERNAL_POLICY_PROBE")));
      assert.equal(existsSync(path.join(dir, "AGENTS.md")), false);

      const shown = await runCli(["project", "show"], dir, { env });
      assert.equal(shown.code, 0, shown.stderr);
      assert.equal(JSON.parse(shown.stdout).runtimeRoot, connection.runtimeRoot);

      const doctor = await runCli(["doctor"], dir, { env });
      assert.equal(doctor.code, 2, doctor.stderr);
      const doctorReport = JSON.parse(doctor.stdout);
      assert.equal(doctorReport.sections.adapters.mode, "external");
      assert.ok(doctorReport.findings.some((finding) => finding.code === "external_adapter_not_prepared"));

      const adapter = await runCli(["adapter", "install", "--target", "codex"], dir, { env });
      assert.equal(adapter.code, 0, adapter.stderr);
      const adapterReport = JSON.parse(adapter.stdout);
      assert.equal(adapterReport.targets.codex.status, "bundle_generated");
      assert.equal(existsSync(adapterReport.targets.codex.pluginRoot), true);
      assert.equal(existsSync(path.join(dir, ".codex")), false);

      const waiting = await runCli(["doctor"], dir, { env });
      assert.equal(waiting.code, 2, waiting.stderr);
      assert.ok(JSON.parse(waiting.stdout).findings.some((finding) => finding.code === "external_adapter_activation_unverified"));
    } finally {
      await rm(governanceRoot, { recursive: true, force: true });
      await rm(stateHome, { recursive: true, force: true });
    }
  });
});

test("cli smoke: legacy state migrates transactionally and remains recoverable outside the project", async () => {
  await withTempProjectDir(async (dir) => {
    const governanceRoot = path.join(path.dirname(dir), `${path.basename(dir)}-migration-governance`);
    const stateHome = path.join(path.dirname(dir), `${path.basename(dir)}-migration-state`);
    const env = { WILDARRANGE_STATE_HOME: stateHome };
    await mkdir(path.join(governanceRoot, "policy"), { recursive: true });
    await writeFile(path.join(governanceRoot, "wildarrange-governance.json"), JSON.stringify({
      schemaVersion: 1,
      project: { repository: "https://example.test/legacy-product.git" },
      policyRoot: "policy",
      verificationRegistry: "verification/registry.json",
    }, null, 2));
    try {
      const initialized = await runCli(["init"], dir, { env });
      assert.equal(initialized.code, 0, initialized.stderr);
      const legacyWork = await readFile(path.join(dir, ".wildarrange", "work.json"), "utf8");

      const directAttach = await runCli(["project", "attach", "--governance-root", governanceRoot], dir, { env });
      assert.equal(directAttach.code, 1);
      assert.match(directAttach.stderr, /state migrate --to external/);

      const preview = await runCli(["state", "migrate", "--to", "external", "--governance-root", governanceRoot, "--dry-run"], dir, { env });
      assert.equal(preview.code, 0, preview.stderr);
      assert.equal(JSON.parse(preview.stdout).status, "planned");
      assert.equal(existsSync(path.join(stateHome, "registry.json")), false);

      const migration = await runCli(["state", "migrate", "--to", "external", "--governance-root", governanceRoot], dir, { env });
      assert.equal(migration.code, 0, migration.stderr);
      const migrated = JSON.parse(migration.stdout);
      assert.equal(migrated.status, "migrated");
      assert.equal(await readFile(path.join(migrated.context.runtimeRoot, "work.json"), "utf8"), legacyWork);
      assert.equal(await readFile(path.join(dir, ".wildarrange", "work.json"), "utf8"), legacyWork);

      const verified = await runCli(["state", "verify"], dir, { env });
      assert.equal(verified.code, 0, verified.stderr);
      assert.equal(JSON.parse(verified.stdout).ok, true);
      const backup = await runCli(["state", "backup", "--reason", "external-smoke"], dir, { env });
      assert.equal(backup.code, 0, backup.stderr);
      assert.ok(JSON.parse(backup.stdout).files.some((file) => file.path === ".wildarrange/work.json" && file.status === "copied"));
      assert.equal(existsSync(path.join(dir, ".wildarrange", "backups")), false);
    } finally {
      await rm(governanceRoot, { recursive: true, force: true });
      await rm(stateHome, { recursive: true, force: true });
    }
  });
});

async function runCliWithInput(args, cwd, input) {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(input));
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}

test("cli smoke: bin/wildarrange.mjs loads without module resolution errors", async () => {
  // Regression guard: bin/wildarrange.mjs previously had duplicate named imports
  // (e.g. approvePlan, loadPlanApproval declared twice), which is an ESM
  // SyntaxError that crashes the process before any command runs. Every
  // unit tests that import zoned owners directly are blind to this because
  // they never load bin/wildarrange.mjs itself.
  const result = await runCli(["--help"], process.cwd());
  assert.equal(result.code, 0, `CLI failed to start.\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /WildArrange linear runtime/);
  assert.doesNotMatch(result.stderr, /SyntaxError/);
});

test("cli smoke: init creates a runtime in a fresh project directory", async () => {
  await withTempProjectDir(async (dir) => {
    const result = await runCli(["init"], dir);
    assert.equal(result.code, 0, `init failed.\nstderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, true);
  });
});

test("cli smoke: status runs against an initialized project", async () => {
  await withTempProjectDir(async (dir) => {
    const init = await runCli(["init"], dir);
    assert.equal(init.code, 0, `init failed.\nstderr: ${init.stderr}`);

    const result = await runCli(["status"], dir);
    assert.equal(result.code, 0, `status failed.\nstderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(typeof parsed.total, "number");
  });
});

test("cli smoke: doctor rejects an initialized project whose Codex Hook is not configured", async () => {
  await withTempProjectDir(async (dir) => {
    const init = await runCli(["init"], dir);
    assert.equal(init.code, 0, `init failed.\nstderr: ${init.stderr}`);

    const result = await runCli(["doctor"], dir);
    assert.equal(result.code, 2, `doctor should fail until Codex Hook activation is evidenced.\nstderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.reportJsonPath);
    assert.ok(parsed.findings.some((finding) => finding.code === "codex_hook_not_configured"));
  });
});

test("cli smoke: Codex hook execution binds host and current config digest before doctor passes it", async () => {
  await withTempProjectDir(async (dir) => {
    assert.equal((await runCli(["init"], dir)).code, 0);
    assert.equal((await runCli(["adapter", "install", "--target", "codex", "--mode", "local"], dir)).code, 0);
    const hooks = JSON.parse(await readFile(path.join(dir, ".codex", "hooks.json"), "utf8"));
    assert.ok(hooks.hooks.UserPromptSubmit[0].hooks[0].command.includes(`node "${CLI_PATH}" hook run`));
    assert.match(hooks.hooks.UserPromptSubmit[0].hooks[0].command, /--adapter-mode local/);
    assert.ok(hooks.hooks.UserPromptSubmit[0].hooks[0].command.includes(`--control-root "${dir}"`));
    assert.match(hooks.hooks.UserPromptSubmit[0].hooks[0].command, /--host codex$/);

    const hook = await runCliWithInput(["hook", "run", "--host", "codex", "--format", "json"], dir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "cli-codex-host-proof",
      cwd: dir,
      prompt: "修复 broken login bug",
      cli_command_prefix: "untrusted-prefix",
    });
    assert.equal(hook.code, 0, hook.stderr);
    const hookResult = JSON.parse(hook.stdout);
    assert.equal(hookResult.hostAdapter, "codex");
    assert.match(hookResult.hookConfigDigest, /^[a-f0-9]{64}$/);
    assert.ok(hookResult.output.includes(`node "${CLI_PATH}" plan --from .wildarrange/plan-drafts/cli-codex-host-proof-plan.json`));
    assert.ok(hookResult.output.includes(`node "${CLI_PATH}" prompts show --skill`));
    assert.doesNotMatch(hookResult.output, /node \.\/bin\/wildarrange\.mjs|untrusted-prefix/);

    const doctor = await runCli(["doctor"], dir);
    assert.equal(doctor.code, 0, doctor.stderr);
    const report = JSON.parse(doctor.stdout);
    const codex = report.sections.adapters.targets.find((target) => target.target === "codex");
    assert.equal(codex.activation, "execution_observed");
    assert.equal(codex.sessionId, "cli-codex-host-proof");
  });
});

test("cli smoke: Codex hook uses its installed control root from a task worktree", async () => {
  await withTempProjectDir(async (controlRoot) => {
    assert.equal((await runCli(["init"], controlRoot)).code, 0);
    assert.equal((await runCli(["adapter", "install", "--target", "codex", "--mode", "local"], controlRoot)).code, 0);
    const executionRoot = path.join(controlRoot, "task-worktree");
    await mkdir(executionRoot, { recursive: true });
    await writeFile(path.join(executionRoot, "wildarrange.config.json"), "{}\n");
    await writeFile(path.join(executionRoot, "AGENTS.md"), "# Task Worktree\n\nCODEX_WORKTREE_RULE_PROBE\n");

    const hook = await runCliWithInput([
      "hook", "run", "--host", "codex", "--format", "json", "--control-root", controlRoot,
    ], executionRoot, {
      hook_event_name: "SessionStart",
      session_id: "cli-codex-task-worktree",
      cwd: executionRoot,
    });

    assert.equal(hook.code, 0, hook.stderr);
    const result = JSON.parse(hook.stdout);
    assert.match(result.output, /CODEX_WORKTREE_RULE_PROBE/);
    assert.equal(existsSync(path.join(executionRoot, ".wildarrange")), false);
    assert.equal(existsSync(path.join(controlRoot, ".wildarrange", "sessions", "hooks", "cli-codex-task-worktree-SessionStart.json")), true);
  });
});

test("cli smoke: npx adapter metadata keeps injected commands on the npx package prefix", async () => {
  await withTempProjectDir(async (dir) => {
    assert.equal((await runCli(["init"], dir)).code, 0);
    const hook = await runCliWithInput([
      "hook", "run", "--format", "json",
      "--adapter-mode", "npx",
      "--adapter-package", "wildarrange",
    ], dir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "cli-npx-prefix",
      cwd: dir,
      prompt: "修复 broken login bug",
    });
    assert.equal(hook.code, 0, hook.stderr);
    const result = JSON.parse(hook.stdout);
    assert.match(result.output, /npx -y wildarrange plan --from \.wildarrange\/plan-drafts\/cli-npx-prefix-plan\.json/);
    assert.match(result.output, /npx -y wildarrange prompts show --skill/);
    assert.doesNotMatch(result.output, /node \.\/bin\/wildarrange\.mjs/);

    assert.equal((await runCli(["adapter", "install", "--target", "codex", "--mode", "npx", "--package", "wildarrange"], dir)).code, 0);
    const legacyHook = await runCliWithInput(["hook", "run", "--format", "json"], dir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "cli-legacy-npx-prefix",
      cwd: dir,
      prompt: "修复 another bug",
      cli_command_prefix: "node attacker.js",
    });
    assert.equal(legacyHook.code, 0, legacyHook.stderr);
    const legacyResult = JSON.parse(legacyHook.stdout);
    assert.match(legacyResult.output, /npx -y wildarrange plan --from \.wildarrange\/plan-drafts\/cli-legacy-npx-prefix-plan\.json/);
    assert.doesNotMatch(legacyResult.output, /attacker|node \.\/bin\/wildarrange\.mjs/);
  });
});

test("cli smoke: custom npx adapter metadata authorizes its exact read-only command", async () => {
  await withTempProjectDir(async (dir) => {
    const packageName = "@example/wildarrange-fork";
    const installed = await runCli(["adapter", "install", "--target", "codex", "--mode", "npx", "--package", packageName], dir);
    assert.equal(installed.code, 0, installed.stderr);
    const hooks = JSON.parse(await readFile(path.join(dir, ".codex", "hooks.json"), "utf8"));
    assert.match(hooks.hooks.PreToolUse[0].hooks[0].command, /npx -y @example\/wildarrange-fork hook run/);
    const hook = await runCliWithInput([
      "hook", "run", "--format", "json",
      "--adapter-mode", "npx",
      "--adapter-package", packageName,
    ], dir, {
      hook_event_name: "PreToolUse",
      session_id: "cli-custom-npx-pretool",
      cwd: dir,
      tool_name: "Bash",
      tool_input: { command: `npx -y ${packageName} status` },
      cli_command_prefix: "npx -y attacker-package",
    });
    assert.equal(hook.code, 0, hook.stderr);
    const result = JSON.parse(hook.stdout);
    assert.equal(result.decision, "allow");
    assert.equal(JSON.parse(result.output).hookSpecificOutput.hookEventName, "PreToolUse");
  });
});

test("cli smoke: restored live adapter remains the CLI fact across resume and hook execution", async () => {
  await withTempProjectDir(async (dir) => {
    const packageA = "@example/wildarrange-a";
    const packageB = "@example/wildarrange-b";
    assert.equal((await runCli(["init"], dir)).code, 0);
    const installA = await runCli(["adapter", "install", "--target", "codex", "--mode", "npx", "--package", packageA], dir);
    assert.equal(installA.code, 0, installA.stderr);
    const prefixA = JSON.parse(installA.stdout).cliPrefix;
    const uninstallA = await runCli(["adapter", "uninstall", "--target", "codex"], dir);
    assert.equal(uninstallA.code, 0, uninstallA.stderr);
    const backupId = JSON.parse(uninstallA.stdout).backupId;
    const installB = await runCli(["adapter", "install", "--target", "codex", "--mode", "npx", "--package", packageB], dir);
    assert.equal(installB.code, 0, installB.stderr);
    const prefixB = JSON.parse(installB.stdout).cliPrefix;

    const restored = await runCli(["adapter", "restore", "--backup", backupId], dir);
    assert.equal(restored.code, 0, restored.stderr);
    const staleReport = JSON.parse(await readFile(path.join(dir, ".wildarrange", "adapters", "install-report.json"), "utf8"));
    assert.equal(staleReport.cliPrefix, prefixB, "the lifecycle intentionally leaves B metadata behind");
    let context = JSON.parse(await readFile(path.join(dir, ".wildarrange", "snapshots", "context.json"), "utf8"));
    assert.equal(context.cliCommandPrefix, prefixA);

    const resumed = await runCli(["resume"], dir);
    assert.equal(resumed.code, 0, resumed.stderr);
    context = JSON.parse(await readFile(path.join(dir, ".wildarrange", "snapshots", "context.json"), "utf8"));
    assert.equal(context.cliCommandPrefix, prefixA);
    const hooks = JSON.parse(await readFile(path.join(dir, ".codex", "hooks.json"), "utf8"));
    assert.match(hooks.hooks.UserPromptSubmit[0].hooks[0].command, new RegExp(packageA.replace("/", "\\/")));
    assert.doesNotMatch(hooks.hooks.UserPromptSubmit[0].hooks[0].command, new RegExp(packageB.replace("/", "\\/")));

    const hook = await runCliWithInput(["hook", "run", "--format", "json"], dir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "cli-restored-adapter-prefix",
      cwd: dir,
      prompt: "修复 broken login bug",
    });
    assert.equal(hook.code, 0, hook.stderr);
    const hookResult = JSON.parse(hook.stdout);
    assert.ok(hookResult.output.includes(`${prefixA} plan --from`));
    assert.doesNotMatch(hookResult.output, new RegExp(packageB.replace("/", "\\/")));
  });
});

test("cli smoke: adapter install rejects unsafe package metadata in every mode before generating files", async () => {
  await withTempProjectDir(async (dir) => {
    for (const [mode, packageName] of [
      ["npx", "safe-package;node-payload"],
      ["local", "safe-package$(node-payload)"],
      ["local", "safe-package`node-payload`"],
    ]) {
      const result = await runCli([
        "adapter", "install", "--target", "codex", "--mode", mode,
        "--package", packageName,
      ], dir);
      assert.equal(result.code, 1, `${mode}: ${packageName}`);
      assert.match(result.stderr, /plain npm package name/);
    }
    await assert.rejects(readFile(path.join(dir, ".codex", "hooks.json"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(path.join(dir, ".wildarrange", "work.json"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(path.join(dir, ".wildarrange", "adapters", "install-report.json"), "utf8"), /ENOENT/);
  });
});

test("cli smoke: a local target without bin imports a string-array verifier plan through the injected absolute prefix", async () => {
  await withTempProjectDir(async (dir) => {
    assert.equal((await runCli(["init"], dir)).code, 0);
    assert.equal((await runCli(["adapter", "install", "--target", "codex", "--mode", "local"], dir)).code, 0);
    await assert.rejects(readFile(path.join(dir, "bin", "wildarrange.mjs"), "utf8"), /ENOENT/);

    const hook = await runCliWithInput(["hook", "run", "--format", "json"], dir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "cli-local-import",
      cwd: dir,
      prompt: "修复 broken login bug",
    });
    assert.equal(hook.code, 0, hook.stderr);
    const absolutePlanCommand = `node "${CLI_PATH}" plan --from .wildarrange/plan-drafts/cli-local-import-plan.json`;
    assert.ok(JSON.parse(hook.stdout).output.includes(absolutePlanCommand));

    const draftPath = path.join(dir, ".wildarrange", "plan-drafts", "cli-local-import-plan.json");
    await mkdir(path.dirname(draftPath), { recursive: true });
    await writeFile(draftPath, JSON.stringify({
      generated_by: "host_semantic",
      title: "Absolute adapter import",
      objective: "Import a valid plan without a target-local CLI file.",
      tasks: [{
        id: "T001",
        subject: "Write receipt",
        description: "Create a small receipt through the governed task.",
        owner: "ZhuRong",
        writable_paths: ["receipt.txt"],
        responsibilityChanges: [{ script: "receipt.txt", additions: "Create accepted artifact", responsibilityBefore: "Absent", responsibilityAfter: "Own the accepted artifact", facts: [] }],
        worker_command: "node -e \"require('fs').writeFileSync('receipt.txt','ok')\"",
        verify_commands: ["node -e \"if(require('fs').readFileSync('receipt.txt','utf8')!=='ok')process.exit(1)\""],
        successCriteria: [{
          title: "receipt contains ok",
          expectedEvidence: "the verifier reads exactly ok",
          verifierCommandRefs: [0],
        }],
      }],
    }, null, 2));

    const imported = await runCli(["plan", "--from", ".wildarrange/plan-drafts/cli-local-import-plan.json"], dir);
    assert.equal(imported.code, 0, imported.stderr);
    const result = JSON.parse(imported.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.approvalStatus, "pending");
    const taskLedger = JSON.parse(await readFile(path.join(dir, ".wildarrange", "team", "tasks.json"), "utf8"));
    const task = taskLedger.tasks.find((candidate) => candidate.id === "T001");
    assert.equal(task.owner, "ZhuRong");
    assert.deepEqual(task.verify_commands, ["node -e \"if(require('fs').readFileSync('receipt.txt','utf8')!=='ok')process.exit(1)\""]);

    const installReport = JSON.parse(await readFile(path.join(dir, ".wildarrange", "adapters", "install-report.json"), "utf8"));
    const absolutePrefix = `node "${CLI_PATH}"`;
    assert.equal(installReport.cliPrefix, absolutePrefix);
    const resumed = await runCli(["resume"], dir);
    assert.equal(resumed.code, 0, resumed.stderr);
    let resume = JSON.parse(resumed.stdout);
    assert.equal(resume.nextActionDetails.reason, "awaiting_plan_approval");
    assert.equal(resume.nextActionDetails.command, null);
    assert.equal((await runCli(["plan", "approve"], dir)).code, 0);
    const approvedResume = await runCli(["resume"], dir);
    assert.equal(approvedResume.code, 0, approvedResume.stderr);
    resume = JSON.parse(approvedResume.stdout);
    assert.equal(resume.nextActionDetails.command, `${absolutePrefix} run`);
    const contextJson = JSON.parse(await readFile(path.join(dir, ".wildarrange", "snapshots", "context.json"), "utf8"));
    assert.equal(contextJson.nextActionDetails.command, `${absolutePrefix} run`);
    const contextMd = await readFile(path.join(dir, ".wildarrange", "snapshots", "context.md"), "utf8");
    assert.ok(contextMd.includes(`${absolutePrefix} resume`));
    assert.doesNotMatch(contextMd, /node \.\/bin\/wildarrange\.mjs/);
  });
});

test("cli smoke: workflow treats a bare --maxSteps flag as the default step budget", async () => {
  await withTempProjectDir(async (dir) => {
    assert.equal((await runCli(["init"], dir)).code, 0);
    // --maxSteps without a value parses to true; Number(true) === 1 would
    // silently shrink the step budget, so the flag must fall back to the
    // default instead of producing NaN or 1.
    for (const extra of [[], ["--maxSteps"], ["--maxSteps", "not-a-number"], ["--maxSteps", "5"]]) {
      const result = await runCli(["workflow", "--sample", ...extra], dir);
      assert.equal(result.code, 0, `workflow --sample ${extra.join(" ")} failed.\nstderr: ${result.stderr}`);
      assert.doesNotMatch(result.stderr + result.stdout, /NaN/);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.results.length, 2);
      assert.equal(parsed.results.at(-1).status, "complete");
    }
  });
});

test("cli smoke: governance audit writes a deterministic report", async () => {
  await withTempProjectDir(async (dir) => {
    const init = await runCli(["init"], dir);
    assert.equal(init.code, 0, `init failed.\nstderr: ${init.stderr}`);

    const result = await runCli(["governance", "audit", "--force"], dir);
    assert.equal(result.code, 0, `governance audit failed.\nstderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.kind, "repository_governance");
    assert.ok(parsed.reportJsonPath);
  });
});

test("cli smoke: adoption start auto-provisions a usable Dashboard token", async () => {
  await withTempProjectDir(async (dir) => {
    const init = await runCli(["init"], dir);
    assert.equal(init.code, 0, `init failed.\nstderr: ${init.stderr}`);
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "legacy", scripts: { test: "node --version" } }, null, 2));
    await mkdir(path.join(dir, "test"), { recursive: true });
    await writeFile(path.join(dir, "test", "smoke.test.mjs"), "export const ok = true;\n");

    const child = spawn(process.execPath, [CLI_PATH, "adoption", "start", "--port", "0"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    try {
      const output = await waitForOutput(child, /"url":\s*"([^"]+)"/);
      const match = output.match(/"url":\s*"([^"]+)"/);
      const dashboardUrl = new URL(match[1]);
      assert.equal(dashboardUrl.hash.startsWith("#approvals?token="), true);
      const token = new URLSearchParams(dashboardUrl.hash.split("?")[1]).get("token");
      assert.ok(token && token.length >= 24);
      const sessionResponse = await fetch(`${dashboardUrl.origin}/api/adoption/session`);
      const session = await sessionResponse.json();
      const card = session.cards[0];
      const decision = await fetch(`${dashboardUrl.origin}/api/adoption/decision`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessionId: session.session.sessionId, cardId: card.id, decision: "deferred", fingerprint: card.fingerprint }),
      });
      assert.equal(decision.status, 200);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await new Promise((resolve) => child.once("close", resolve));
      }
    }
  });
});

function waitForOutput(child, pattern) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for CLI output: ${output}`)), 15_000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (!pattern.test(output)) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve(output);
    };
    child.stdout.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      if (pattern.test(output)) return;
      clearTimeout(timer);
      reject(new Error(`CLI exited before Dashboard URL was printed: ${code}; ${output}`));
    });
  });
}
