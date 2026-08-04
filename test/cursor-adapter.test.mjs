import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  installAdapter,
  uninstallAdapter,
} from "../src/interface/adapters.mjs";
import { renderCursorHookBridge } from "../src/interface/cursor-adapter.mjs";
import { importPlan } from "../src/orchestration/plan-state.mjs";

const BRIDGE_RELATIVE_PATH = path.join(".cursor", "hooks", "wildarrange-hook-bridge.mjs");

test("Cursor adapter generates project hooks.json with fail-closed preToolUse", async () => {
  await withTempDir(async (dir) => {
    const report = await installAdapter(dir, { target: "cursor", mode: "local" });

    const hooksPath = path.join(dir, ".cursor", "hooks.json");
    const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
    assert.equal(hooks.version, 1);
    const preToolUse = hooks.hooks.preToolUse?.[0];
    assert.ok(preToolUse, "preToolUse hook missing");
    assert.equal(preToolUse.failClosed, true);
    assert.match(preToolUse.matcher, /Write/);
    assert.match(preToolUse.matcher, /Shell/);
    assert.match(preToolUse.command, /wildarrange-hook-bridge\.mjs/);
    const beforeShell = hooks.hooks.beforeShellExecution?.[0];
    assert.ok(beforeShell, "beforeShellExecution hook missing");
    assert.equal(beforeShell.failClosed, true);
    assert.ok(hooks.hooks.sessionStart?.[0]);
    assert.ok(hooks.hooks.stop?.[0]);
    assert.ok(hooks.hooks.subagentStop?.[0]);

    const bridgePath = path.join(dir, BRIDGE_RELATIVE_PATH);
    assert.equal(existsSync(bridgePath), true);
    assert.match(await readFile(bridgePath, "utf8"), /HELIX_HOST_ADAPTER: "cursor"/);

    const hooksOutput = report.outputs.find((output) => output.path === ".cursor/hooks.json");
    assert.equal(hooksOutput.enforcement, "hard-in-trusted-workspace");
    assert.match(hooksOutput.trustAction, /受信任工作区/);
  });
});

test("Cursor Hook bridge ignores unrelated projects without creating .helix", async () => {
  await withTempDir(async (wildArrangeDir) => {
    await installAdapter(wildArrangeDir, { target: "cursor", mode: "local" });
    const bridgePath = path.join(wildArrangeDir, BRIDGE_RELATIVE_PATH);

    await withTempDir(async (unrelatedDir) => {
      const result = await runBridge(bridgePath, {
        hook_event_name: "preToolUse",
        conversation_id: "cursor-unrelated",
        cwd: unrelatedDir,
        tool_name: "Write",
        tool_input: { path: "src/app.js" },
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "");
      assert.equal(existsSync(path.join(unrelatedDir, ".helix")), false);
    });
  });
});

test("Cursor Hook bridge maps preToolUse deny/allow to the Cursor permission protocol", async () => {
  await withTempDir(async (dir) => {
    await installAdapter(dir, { target: "cursor", mode: "local" });
    const bridgePath = path.join(dir, BRIDGE_RELATIVE_PATH);
    await writeTestPlan(dir);

    const allowed = await runBridge(bridgePath, {
      hook_event_name: "preToolUse",
      conversation_id: "cursor-allow",
      cwd: dir,
      task_id: "T001",
      tool_name: "Write",
      tool_input: { path: "src/app.js", content: "ok" },
    });
    assert.equal(allowed.exitCode, 0);
    assert.deepEqual(JSON.parse(allowed.stdout), { permission: "allow" });

    const denied = await runBridge(bridgePath, {
      hook_event_name: "preToolUse",
      conversation_id: "cursor-deny",
      cwd: dir,
      task_id: "T001",
      tool_name: "Write",
      tool_input: { path: "src/other.js", content: "no" },
    });
    assert.equal(denied.exitCode, 0);
    const deniedOutput = JSON.parse(denied.stdout);
    assert.equal(deniedOutput.permission, "deny");
    assert.match(deniedOutput.user_message, /planned scope violation/);
    assert.match(deniedOutput.agent_message, /writable_paths/);

    const dangerousShell = await runBridge(bridgePath, {
      hook_event_name: "preToolUse",
      conversation_id: "cursor-shell",
      cwd: dir,
      task_id: "T001",
      tool_name: "Shell",
      tool_input: { command: "rm -rf src" },
    });
    const shellOutput = JSON.parse(dangerousShell.stdout);
    assert.equal(shellOutput.permission, "deny");
    assert.match(shellOutput.user_message, /high-risk shell command blocked/);

    const deniedDelete = await runBridge(bridgePath, {
      hook_event_name: "preToolUse",
      conversation_id: "cursor-delete",
      cwd: dir,
      task_id: "T001",
      tool_name: "Delete",
      tool_input: { path: "src/other.js" },
    });
    assert.equal(JSON.parse(deniedDelete.stdout).permission, "deny");
  });
});

test("Cursor beforeShellExecution gates integrated terminal commands like Bash", async () => {
  await withTempDir(async (dir) => {
    await installAdapter(dir, { target: "cursor", mode: "local" });
    const bridgePath = path.join(dir, BRIDGE_RELATIVE_PATH);
    await writeTestPlan(dir);

    const dangerous = await runBridge(bridgePath, {
      hook_event_name: "beforeShellExecution",
      conversation_id: "cursor-terminal-deny",
      cwd: dir,
      task_id: "T001",
      command: "rm -rf src",
    });
    assert.equal(dangerous.exitCode, 0);
    const dangerousOutput = JSON.parse(dangerous.stdout);
    assert.equal(dangerousOutput.permission, "deny");
    assert.match(dangerousOutput.user_message, /high-risk shell command blocked/);

    const safe = await runBridge(bridgePath, {
      hook_event_name: "beforeShellExecution",
      conversation_id: "cursor-terminal-allow",
      cwd: dir,
      task_id: "T001",
      command: "node ./bin/helix.mjs doctor",
    });
    assert.deepEqual(JSON.parse(safe.stdout), { permission: "allow" });
  });
});

test("Cursor bridge is fail-closed when the governance CLI fails or answers garbage", async () => {
  await withTempDir(async (dir) => {
    await installAdapter(dir, { target: "cursor", mode: "local" });

    const missingCliBridge = path.join(dir, "missing-cli-bridge.mjs");
    await writeFile(missingCliBridge, renderCursorHookBridge({
      mode: "local",
      localCliPath: path.join(dir, "no-such-helix.mjs"),
    }), "utf8");
    const missing = await runBridge(missingCliBridge, {
      hook_event_name: "preToolUse",
      conversation_id: "cursor-cli-missing",
      cwd: dir,
      tool_name: "Write",
      tool_input: { path: "src/app.js" },
    });
    assert.equal(missing.exitCode, 0);
    const missingOutput = JSON.parse(missing.stdout);
    assert.equal(missingOutput.permission, "deny");
    assert.match(missingOutput.user_message, /fail-closed/);

    const garbageCli = path.join(dir, "fake-helix.mjs");
    await writeFile(garbageCli, "console.log('not json');\n", "utf8");
    const garbageBridge = path.join(dir, "garbage-bridge.mjs");
    await writeFile(garbageBridge, renderCursorHookBridge({
      mode: "local",
      localCliPath: garbageCli,
    }), "utf8");
    const garbage = await runBridge(garbageBridge, {
      hook_event_name: "preToolUse",
      conversation_id: "cursor-cli-garbage",
      cwd: dir,
      tool_name: "Write",
      tool_input: { path: "src/app.js" },
    });
    assert.equal(JSON.parse(garbage.stdout).permission, "deny");

    const undecidedCli = path.join(dir, "undecided-helix.mjs");
    await writeFile(undecidedCli, "console.log(JSON.stringify({ decision: null, output: '' }));\n", "utf8");
    const undecidedBridge = path.join(dir, "undecided-bridge.mjs");
    await writeFile(undecidedBridge, renderCursorHookBridge({
      mode: "local",
      localCliPath: undecidedCli,
    }), "utf8");
    const undecided = await runBridge(undecidedBridge, {
      hook_event_name: "preToolUse",
      conversation_id: "cursor-cli-undecided",
      cwd: dir,
      tool_name: "Write",
      tool_input: { path: "src/app.js" },
    });
    const undecidedOutput = JSON.parse(undecided.stdout);
    assert.equal(undecidedOutput.permission, "deny");
    assert.match(undecidedOutput.agent_message, /no explicit allow/);
  });
});

test("Cursor subagentStop also converts unfinished work into a followup_message", async () => {
  await withTempDir(async (dir) => {
    await installAdapter(dir, { target: "cursor", mode: "local" });
    const bridgePath = path.join(dir, BRIDGE_RELATIVE_PATH);
    await writeTestPlan(dir);

    const stopped = await runBridge(bridgePath, {
      hook_event_name: "subagentStop",
      conversation_id: "cursor-subagent-stop",
      cwd: dir,
    });
    assert.equal(stopped.exitCode, 0);
    const output = JSON.parse(stopped.stdout);
    assert.match(output.followup_message, /requires this task to continue/);
  });
});

test("Cursor Hook bridge injects sessionStart context via additional_context", async () => {
  await withTempDir(async (dir) => {
    await installAdapter(dir, { target: "cursor", mode: "local" });
    const bridgePath = path.join(dir, BRIDGE_RELATIVE_PATH);

    const started = await runBridge(bridgePath, {
      hook_event_name: "sessionStart",
      conversation_id: "cursor-session",
      cwd: dir,
      workspace_roots: [dir],
    });
    assert.equal(started.exitCode, 0);
    const output = JSON.parse(started.stdout);
    assert.match(output.additional_context, /<wildarrange-injection event="SessionStart"/);
  });
});

test("Cursor stop Hook converts unfinished work into a followup_message", async () => {
  await withTempDir(async (dir) => {
    await installAdapter(dir, { target: "cursor", mode: "local" });
    const bridgePath = path.join(dir, BRIDGE_RELATIVE_PATH);
    await writeTestPlan(dir);

    const stopped = await runBridge(bridgePath, {
      hook_event_name: "stop",
      conversation_id: "cursor-stop",
      cwd: dir,
      status: "completed",
    });
    assert.equal(stopped.exitCode, 0);
    const output = JSON.parse(stopped.stdout);
    assert.match(output.followup_message, /requires this task to continue/);
    assert.match(output.followup_message, /node \.\/bin\/helix\.mjs run/);
  });
});

test("Cursor Hook bridge reports malformed payloads as hook errors", async () => {
  await withTempDir(async (dir) => {
    await installAdapter(dir, { target: "cursor", mode: "local" });
    const bridgePath = path.join(dir, BRIDGE_RELATIVE_PATH);
    const result = await runBridgeRaw(bridgePath, "{not-json");
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /malformed hook JSON/);
  });
});

test("Cursor uninstall removes project hooks and bridge", async () => {
  await withTempDir(async (dir) => {
    await installAdapter(dir, { target: "cursor", mode: "local" });
    assert.equal(existsSync(path.join(dir, ".cursor", "hooks.json")), true);

    const uninstall = await uninstallAdapter(dir, { target: "cursor" });
    const hooksOutput = uninstall.outputs.find((output) => output.path === ".cursor/hooks.json");
    assert.equal(hooksOutput.status, "removed");
    assert.equal(existsSync(path.join(dir, ".cursor", "hooks.json")), false);
    assert.equal(existsSync(path.join(dir, BRIDGE_RELATIVE_PATH)), false);
    assert.equal(existsSync(path.join(dir, ".cursor", "rules", "wildarrange.mdc")), false);
  });
});

async function writeTestPlan(dir) {
  const planPath = path.join(dir, "plan.json");
  await writeFile(planPath, JSON.stringify({
    title: "Cursor scoped edit",
    tasks: [{
      id: "T001",
      subject: "Edit one file",
      writable_paths: ["src/app.js"],
      worker_command: "node -e \"if(!process.version)process.exit(1)\"",
      verify_commands: ["node -e \"if(!process.version)process.exit(1)\""],
    }],
  }, null, 2));
  await importPlan(dir, planPath);
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-cursor-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runBridge(bridgePath, payload, timeoutMs = 30_000) {
  return runBridgeRaw(bridgePath, JSON.stringify(payload), timeoutMs);
}

function runBridgeRaw(bridgePath, input, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Cursor bridge timed out after ${timeoutMs}ms`));
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
