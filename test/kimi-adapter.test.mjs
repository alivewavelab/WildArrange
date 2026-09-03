import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  installAdapter,
  restoreAdapterBackup,
  uninstallAdapter,
} from "../src/interface/adapters.mjs";
import { importPlan } from "../src/orchestration/plan-state.mjs";

test("Kimi adapter generates a native plugin and shared project Skills", async () => {
  await withTempDir(async (dir) => {
    const report = await installAdapter(dir, {
      target: "kimi",
      mode: "local",
    });

    const pluginRoot = path.join(dir, ".wildarrange", "adapters", "kimi", "plugin");
    const manifestPath = path.join(pluginRoot, "kimi.plugin.json");
    const bridgePath = path.join(pluginRoot, "hooks", "wildarrange-hook-bridge.mjs");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    assert.equal(manifest.name, "wildarrange-adapter");
    assert.ok(manifest.hooks.some((hook) => hook.event === "PreToolUse" && hook.matcher === "^(Bash|Write|Edit)$"));
    assert.ok(manifest.hooks.some((hook) => hook.event === "UserPromptSubmit"));
    assert.ok(manifest.hooks.some((hook) => hook.event === "PostToolUse" && hook.matcher === undefined));
    assert.ok(manifest.hooks.some((hook) => hook.event === "PostToolUseFailure" && hook.matcher === undefined));
    assert.ok(manifest.hooks.some((hook) => hook.event === "Stop"));
    assert.match(await readFile(bridgePath, "utf8"), /WILDARRANGE_HOST_ADAPTER: "kimi"/);

    const doctorSkill = await readFile(path.join(dir, ".agents", "skills", "wildarrange-doctor", "SKILL.md"), "utf8");
    assert.match(doctorSkill, /^name: wildarrange-doctor$/m);
    assert.match(doctorSkill, /^description: /m);

    const manifestOutput = report.outputs.find((output) => output.path.endsWith("kimi.plugin.json"));
    assert.equal(manifestOutput.enforcement, "pending-user-install");
    assert.match(manifestOutput.trustAction, /\/plugins install \.wildarrange\/adapters\/kimi\/plugin/);
    assert.doesNotMatch(manifestOutput.trustAction, /["']/);
    assert.match(manifestOutput.trustAction, /\/reload/);
  });
});

test("invalid adapter targets fail before creating runtime state", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      installAdapter(dir, { target: "unknown-host" }),
      /codex, cursor, or kimi/,
    );
    assert.equal(existsSync(path.join(dir, ".wildarrange")), false);
  });
});

test("Kimi Hook bridge ignores unrelated projects without creating .wildarrange", async () => {
  await withTempDir(async (wildArrangeDir) => {
    await installAdapter(wildArrangeDir, { target: "kimi", mode: "local" });
    const bridgePath = path.join(wildArrangeDir, ".wildarrange", "adapters", "kimi", "plugin", "hooks", "wildarrange-hook-bridge.mjs");

    await withTempDir(async (unrelatedDir) => {
      await mkdir(path.join(unrelatedDir, ".wildarrange", "config.json"), { recursive: true });
      const result = await runBridge(bridgePath, {
        hook_event_name: "UserPromptSubmit",
        session_id: "kimi-unrelated",
        cwd: unrelatedDir,
        prompt: "do not initialize this project",
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.equal(existsSync(path.join(unrelatedDir, ".wildarrange", "ledger.jsonl")), false);
    });
  });
});

test("Kimi Hook bridge injects prompts and enforces scoped Edit calls", async () => {
  await withTempDir(async (dir) => {
    await installAdapter(dir, { target: "kimi", mode: "local" });
    const bridgePath = path.join(dir, ".wildarrange", "adapters", "kimi", "plugin", "hooks", "wildarrange-hook-bridge.mjs");
    const planPath = path.join(dir, "plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Kimi scoped edit",
      tasks: [{
        id: "T001",
        subject: "Edit one file",
        writable_paths: ["src/app.js", "src/link/**"],
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
      }],
    }, null, 2));
    await importPlan(dir, planPath);
    const nestedDir = path.join(dir, "src", "nested");
    await mkdir(nestedDir, { recursive: true });

    const prompt = await runBridge(bridgePath, {
      hook_event_name: "UserPromptSubmit",
      session_id: "kimi-prompt",
      cwd: nestedDir,
      prompt: "继续 T001",
    });
    assert.equal(prompt.exitCode, 0);
    assert.match(prompt.stdout, /<wildarrange-injection event="UserPromptSubmit"/);
    assert.equal(existsSync(path.join(nestedDir, ".wildarrange")), false);

    const allowed = await runBridge(bridgePath, {
      hook_event_name: "PreToolUse",
      session_id: "kimi-allow",
      cwd: dir,
      task_id: "T001",
      tool_name: "Edit",
      tool_input: { file_path: "src/app.js" },
    });
    assert.equal(allowed.exitCode, 0);
    const allowedOutput = JSON.parse(allowed.stdout);
    assert.equal(allowedOutput.hookSpecificOutput.permissionDecision, undefined);
    assert.match(allowedOutput.hookSpecificOutput.additionalContext, /src\/app\.js/);

    const allowedDoctorCommand = await runBridge(bridgePath, {
      hook_event_name: "PreToolUse",
      session_id: "kimi-doctor-command",
      cwd: dir,
      task_id: "T001",
      tool_name: "Bash",
      tool_input: { command: "node ./bin/wildarrange.mjs doctor" },
    });
    const allowedDoctorOutput = JSON.parse(allowedDoctorCommand.stdout);
    assert.equal(allowedDoctorOutput.hookSpecificOutput.permissionDecision, undefined);
    assert.doesNotMatch(allowedDoctorOutput.hookSpecificOutput.additionalContext, /node \.\/bin\/wildarrange\.mjs doctor/);

    const allowedPathLikeContent = await runBridge(bridgePath, {
      hook_event_name: "PreToolUse",
      session_id: "kimi-path-like-content",
      cwd: dir,
      task_id: "T001",
      tool_name: "Edit",
      tool_input: {
        path: "src/app.js",
        old_string: "const value = 1;",
        new_string: "import value from './shared/value.js';",
      },
    });
    const allowedPathLikeContentOutput = JSON.parse(allowedPathLikeContent.stdout);
    assert.equal(allowedPathLikeContentOutput.hookSpecificOutput.permissionDecision, undefined);
    assert.doesNotMatch(allowedPathLikeContentOutput.hookSpecificOutput.additionalContext, /shared\/value\.js/);

    const denied = await runBridge(bridgePath, {
      hook_event_name: "PreToolUse",
      session_id: "kimi-deny",
      cwd: dir,
      task_id: "T001",
      tool_name: "Edit",
      tool_input: { file_path: "src/other.js" },
    });
    assert.equal(denied.exitCode, 0);
    const deniedOutput = JSON.parse(denied.stdout);
    assert.equal(deniedOutput.hookSpecificOutput.permissionDecision, "deny");
    assert.match(deniedOutput.hookSpecificOutput.permissionDecisionReason, /planned scope violation/);

    const absoluteAllowed = await runBridge(bridgePath, {
      hook_event_name: "PreToolUse",
      session_id: "kimi-absolute-allow",
      cwd: dir,
      task_id: "T001",
      tool_name: "Edit",
      tool_input: { path: path.join(dir, "src", "app.js") },
    });
    assert.equal(JSON.parse(absoluteAllowed.stdout).hookSpecificOutput.permissionDecision, undefined);

    const absoluteDenied = await runBridge(bridgePath, {
      hook_event_name: "PreToolUse",
      session_id: "kimi-absolute-deny",
      cwd: dir,
      task_id: "T001",
      tool_name: "Write",
      tool_input: { path: path.join(os.tmpdir(), "outside-wildarrange.txt"), content: "no" },
    });
    const absoluteDeniedOutput = JSON.parse(absoluteDenied.stdout);
    assert.equal(absoluteDeniedOutput.hookSpecificOutput.permissionDecision, "deny");
    assert.match(absoluteDeniedOutput.hookSpecificOutput.permissionDecisionReason, /outside-wildarrange\.txt/);

    const extensionlessDenied = await runBridge(bridgePath, {
      hook_event_name: "PreToolUse",
      session_id: "kimi-extensionless-deny",
      cwd: dir,
      task_id: "T001",
      tool_name: "Write",
      tool_input: { path: "Makefile", content: "no" },
    });
    assert.equal(JSON.parse(extensionlessDenied.stdout).hookSpecificOutput.permissionDecision, "deny");

    const outsideSymlinkDir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-kimi-symlink-"));
    try {
      await mkdir(path.join(dir, "src"), { recursive: true });
      await symlink(outsideSymlinkDir, path.join(dir, "src", "link"), "dir");
      const symlinkEscape = await runBridge(bridgePath, {
        hook_event_name: "PreToolUse",
        session_id: "kimi-symlink-escape",
        cwd: dir,
        task_id: "T001",
        tool_name: "Write",
        tool_input: { path: "src/link/escape.txt", content: "no" },
      });
      const symlinkEscapeOutput = JSON.parse(symlinkEscape.stdout);
      assert.equal(symlinkEscapeOutput.hookSpecificOutput.permissionDecision, "deny");
      assert.match(symlinkEscapeOutput.hookSpecificOutput.permissionDecisionReason, /escape\.txt/);
    } finally {
      await rm(outsideSymlinkDir, { recursive: true, force: true });
    }

    const dangerousBash = await runBridge(bridgePath, {
      hook_event_name: "PreToolUse",
      session_id: "kimi-dangerous-bash",
      cwd: dir,
      task_id: "T001",
      tool_name: "Bash",
      tool_input: { command: "rm -rf src" },
    });
    assert.equal(dangerousBash.exitCode, 0);
    const dangerousOutput = JSON.parse(dangerousBash.stdout);
    assert.equal(dangerousOutput.hookSpecificOutput.permissionDecision, "deny");
    assert.match(dangerousOutput.hookSpecificOutput.permissionDecisionReason, /high-risk shell command blocked/);

    const failedTool = await runBridge(bridgePath, {
      hook_event_name: "PostToolUseFailure",
      session_id: "kimi-tool-failure",
      cwd: dir,
      tool_name: "Bash",
      tool_input: { command: "missing-command" },
      error: { message: "command not found", code: "ENOENT" },
    });
    assert.equal(failedTool.exitCode, 0);
    assert.match(failedTool.stdout, /决策：block/);
  });
});

test("Kimi Hook bridge reports malformed payloads as hook errors", async () => {
  await withTempDir(async (dir) => {
    await installAdapter(dir, { target: "kimi", mode: "local" });
    const bridgePath = path.join(dir, ".wildarrange", "adapters", "kimi", "plugin", "hooks", "wildarrange-hook-bridge.mjs");
    const result = await runBridgeRaw(bridgePath, "{not-json");
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /malformed hook JSON/);
  });
});

test("Kimi Stop Hook converts unfinished work into a continuation block", async () => {
  await withTempDir(async (dir) => {
    await installAdapter(dir, { target: "kimi", mode: "local" });
    const bridgePath = path.join(dir, ".wildarrange", "adapters", "kimi", "plugin", "hooks", "wildarrange-hook-bridge.mjs");
    const planPath = path.join(dir, "plan.json");
    await writeFile(planPath, JSON.stringify({
      title: "Kimi continuation",
      tasks: [{
        id: "T001",
        subject: "Remain pending",
        writable_paths: ["src/app.js"],
        worker_command: "node -e \"if(!process.version)process.exit(1)\"",
        verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
      }],
    }, null, 2));
    await importPlan(dir, planPath);

    const stopped = await runBridge(bridgePath, {
      hook_event_name: "Stop",
      session_id: "kimi-stop",
      cwd: dir,
    });
    assert.equal(stopped.exitCode, 0);
    const output = JSON.parse(stopped.stdout);
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /requires this task to continue/);
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /node \.\/bin\/wildarrange\.mjs run/);
  });
});

test("Kimi uninstall keeps shared Skills while Codex remains and restores plugin backups", async () => {
  await withTempDir(async (dir) => {
    await installAdapter(dir, { target: "all", mode: "local" });
    const uninstall = await uninstallAdapter(dir, { target: "kimi" });
    const skillOutput = uninstall.outputs.find((output) => output.path === ".agents/skills/wildarrange-doctor/SKILL.md");
    assert.equal(skillOutput.status, "retained-shared");
    assert.equal(existsSync(path.join(dir, ".agents", "skills", "wildarrange-doctor", "SKILL.md")), true);
    assert.equal(existsSync(path.join(dir, ".codex", "hooks.json")), true);
    assert.equal(existsSync(path.join(dir, ".wildarrange", "adapters", "kimi", "plugin", "kimi.plugin.json")), false);

    await restoreAdapterBackup(dir, { backupId: uninstall.backupId });
    assert.equal(existsSync(path.join(dir, ".wildarrange", "adapters", "kimi", "plugin", "kimi.plugin.json")), true);
  });
});

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-kimi-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runBridge(bridgePath, payload, timeoutMs = 20_000) {
  return runBridgeRaw(bridgePath, JSON.stringify(payload), timeoutMs);
}

function runBridgeRaw(bridgePath, input, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Kimi bridge timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}
