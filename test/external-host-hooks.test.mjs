// =============================================================================
// 文件名称：external-host-hooks.test.mjs
// 所属模块：test
// 作用说明：验证外置宿主 Hook 侧对等能力：cwd 归一化、Kimi Stop 续跑、matcher、
//   bridge 鲁棒性、配置 digest、uninstall/restore 与用户级指针规则。
//   全部使用临时 --user-root / stateHome，绝不触碰真实 ~/.cursor、~/.codex、~/.kimi-code。
// =============================================================================
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCommandFile } from "../src/infra/command-runner.mjs";
import { resolveWorkspaceContext } from "../src/infra/workspace-context.mjs";
import { runDoctor } from "../src/interface/doctor.mjs";
import {
  activateCodexAdapter,
  activateCursorAdapter,
  installAdapters,
  restoreAdapterBackup,
  uninstallAdapters,
} from "../src/interface/adapters.mjs";
import { CURSOR_BRIDGE_NAME } from "../src/interface/adapter-bundles.mjs";

import { withExternalProject, declare, importApprovedPlan } from "./helpers/external-fixture.mjs";

const CLI_PATH = path.join(process.cwd(), "bin", "wildarrange.mjs");

/** 装好三宿主 bundle 并导入一个只允许写 src/result.js 的计划。 */
async function prepareScopedProject({ projectRoot, stateHome }, { importTask = true } = {}) {
  const workspace = await resolveWorkspaceContext(projectRoot, { stateHome });
  const report = await installAdapters(projectRoot, workspace, { target: "all", mode: "local", localCliPath: CLI_PATH });
  if (importTask) {
    const planPath = path.join(stateHome, "plan.json");
    await writeFile(planPath, JSON.stringify({
      id: "cwd-plan",
      title: "cwd normalization",
      tasks: [{
        id: "T001",
        subject: "Write result",
        owner: "ZhuRong",
        writable_paths: ["src/result.js"],
        responsibilityChanges: declare("src/result.js"),
        worker_command: "node -e \"1\"",
        verify_commands: ["node -e \"1\""],
      }],
    }));
    await importApprovedPlan(projectRoot, planPath);
  }
  return { workspace, report };
}

async function runBridge(bridgePath, payload, stateHome, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath], {
      cwd: payload.cwd,
      env: { ...process.env, WILDARRANGE_STATE_HOME: stateHome, ...extra },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

/** 解析 Codex 风格 PreToolUse 输出：返回是否 deny 与附加上下文。 */
function parseDecision(stdout) {
  const parsed = stdout.trim() ? JSON.parse(stdout) : {};
  const specific = parsed.hookSpecificOutput || {};
  return { denied: specific.permissionDecision === "deny", context: String(specific.additionalContext || ""), reason: String(specific.permissionDecisionReason || "") };
}

test("external hook from a project subdirectory resolves the project root and computes paths from the Git toplevel", async () => {
  await withExternalProject(async (roots) => {
    const { projectRoot, stateHome } = roots;
    const { report } = await prepareScopedProject(roots);
    const nested = path.join(projectRoot, "src");
    await mkdir(nested, { recursive: true });
    const allowed = await runBridge(report.targets.codex.bridgePath, {
      hook_event_name: "PreToolUse", session_id: "sub", cwd: nested,
      tool_name: "Write", tool_input: { file_path: "result.js", content: "x" },
    }, stateHome);
    assert.equal(allowed.exitCode, 0, allowed.stderr);
    assert.equal(parseDecision(allowed.stdout).denied, false, "legitimate write from src/ must be allowed");
    assert.match(parseDecision(allowed.stdout).context, /src\/result\.js/);
    const denied = await runBridge(report.targets.codex.bridgePath, {
      hook_event_name: "PreToolUse", session_id: "sub", cwd: nested,
      tool_name: "Write", tool_input: { file_path: "other.js", content: "x" },
    }, stateHome);
    assert.equal(parseDecision(denied.stdout).denied, true);
    const session = await runBridge(report.targets.codex.bridgePath, {
      hook_event_name: "SessionStart", session_id: "sub-start", cwd: nested,
    }, stateHome);
    assert.equal(session.exitCode, 0, session.stderr);
    assert.match(session.stdout, /ROOTRULE/, "root AGENTS.md must be read when started from a subdirectory");
  }, { projectFiles: { "AGENTS.md": "# ROOTRULE\n\nRoot rule text.\n", "src/keep.js": "1\n" } });
});

test("external hook inside a task worktree under runtimeRoot maps to the registered project", async () => {
  await withExternalProject(async (roots) => {
    const { projectRoot, stateHome } = roots;
    const { report, workspace } = await prepareScopedProject(roots);
    const worktree = path.join(workspace.runtimeRoot, "linear-runs", "cwd-plan", "T001", "worktree");
    await mkdir(path.dirname(worktree), { recursive: true });
    const added = await runCommandFile("git", ["worktree", "add", "-q", "-b", "wildarrange/task/cwd-plan/T001", worktree], projectRoot);
    assert.equal(added.exitCode, 0, added.stderr);
    const allowed = await runBridge(report.targets.codex.bridgePath, {
      hook_event_name: "PreToolUse", session_id: "wt", cwd: path.join(worktree, "src"),
      tool_name: "Write", tool_input: { file_path: path.join(worktree, "src", "result.js"), content: "x" },
    }, stateHome);
    assert.equal(allowed.exitCode, 0, allowed.stderr);
    assert.doesNotMatch(allowed.stderr, /must be separate/);
    assert.equal(parseDecision(allowed.stdout).denied, false);
    assert.match(parseDecision(allowed.stdout).context, /src\/result\.js/);
    const denied = await runBridge(report.targets.codex.bridgePath, {
      hook_event_name: "PreToolUse", session_id: "wt", cwd: worktree,
      tool_name: "Write", tool_input: { file_path: path.join(worktree, "src", "elsewhere.js"), content: "x" },
    }, stateHome);
    assert.equal(parseDecision(denied.stdout).denied, true);
  }, { projectFiles: { "src/keep.js": "1\n" } });
});

test("external hook from an unregistered directory stays silent", async () => {
  await withExternalProject(async (roots) => {
    const { report } = await prepareScopedProject(roots, { importTask: false });
    const unrelated = await mkdtemp(path.join(os.tmpdir(), "wildarrange-unregistered-"));
    try {
      const result = await runBridge(report.targets.codex.bridgePath, {
        hook_event_name: "PreToolUse", session_id: "u", cwd: unrelated,
        tool_name: "Write", tool_input: { file_path: "a.js", content: "x" },
      }, roots.stateHome);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(existsSync(path.join(unrelated, ".wildarrange")), false);
    } finally {
      await rm(unrelated, { recursive: true, force: true });
    }
  });
});

test("external Kimi Stop hook pulls unfinished work back into the session", async () => {
  await withExternalProject(async (roots) => {
    const { projectRoot, stateHome } = roots;
    const { report } = await prepareScopedProject(roots);
    const result = await runBridge(report.targets.kimi.bridgePath, {
      hook_event_name: "Stop", session_id: "kimi-stop", cwd: projectRoot,
    }, stateHome);
    assert.equal(result.exitCode, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /continue/i);
  });
});

test("external Codex PreToolUse matcher covers create_goal", async () => {
  await withExternalProject(async (roots) => {
    const { report } = await prepareScopedProject(roots, { importTask: false });
    const hooks = JSON.parse(await readFile(report.targets.codex.hooksPath, "utf8"));
    const matcher = new RegExp(hooks.hooks.PreToolUse[0].matcher);
    assert.equal(matcher.test("create_goal"), true);
    assert.equal(matcher.test("functions.create_goal"), true);
    assert.equal(matcher.test("Write"), true);
  });
});

test("external bridge lets unconnected projects through when the WildArrange CLI is broken, but keeps connected Cursor fail-closed", async () => {
  await withExternalProject(async (roots) => {
    const { projectRoot, stateHome } = roots;
    const workspace = await resolveWorkspaceContext(projectRoot, { stateHome });
    const report = await installAdapters(projectRoot, workspace, {
      target: "cursor", mode: "local", localCliPath: path.join(stateHome, "missing-cli.mjs"),
    });
    const write = (cwd) => ({ hook_event_name: "preToolUse", conversation_id: "broken", cwd, tool_name: "Write", tool_input: { file_path: "a.js" } });
    const unrelated = await mkdtemp(path.join(os.tmpdir(), "wildarrange-broken-cli-"));
    try {
      const open = await runBridge(report.targets.cursor.bridgePath, write(unrelated), stateHome);
      assert.equal(open.exitCode, 0, open.stderr);
      assert.equal(open.stdout, "", "unconnected project must not be blocked by a broken installation");
    } finally {
      await rm(unrelated, { recursive: true, force: true });
    }
    const closed = await runBridge(report.targets.cursor.bridgePath, write(projectRoot), stateHome);
    assert.equal(closed.exitCode, 0);
    const parsed = JSON.parse(closed.stdout);
    assert.equal(parsed.permission, "deny");
    assert.ok(parsed.agent_message.length < 500, "deny message stays a short summary");
  });
});

test("external Cursor deny carries only the reason summary, not the whole hook JSON", async () => {
  await withExternalProject(async (roots) => {
    const { projectRoot, stateHome } = roots;
    const { report } = await prepareScopedProject(roots);
    const result = await runBridge(report.targets.cursor.bridgePath, {
      hook_event_name: "preToolUse", conversation_id: "deny", cwd: projectRoot,
      tool_name: "Write", tool_input: { file_path: "outside.js" },
    }, stateHome);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.permission, "deny");
    assert.match(parsed.agent_message, /planned scope violation/);
    assert.doesNotMatch(parsed.agent_message, /wildarrange-injection|hookSpecificOutput/);
  });
});

test("external bridge kills a hung CLI subprocess and applies the host failure policy", async () => {
  await withExternalProject(async (roots) => {
    const { projectRoot, stateHome } = roots;
    const hangingCli = path.join(stateHome, "hanging-cli.mjs");
    await writeFile(hangingCli, "setInterval(() => {}, 1000);\n", "utf8");
    const workspace = await resolveWorkspaceContext(projectRoot, { stateHome });
    const report = await installAdapters(projectRoot, workspace, {
      target: "cursor", mode: "local", localCliPath: hangingCli, hookTimeoutMs: 500,
    });
    const started = Date.now();
    const result = await runBridge(report.targets.cursor.bridgePath, {
      hook_event_name: "preToolUse", conversation_id: "hang", cwd: projectRoot,
      tool_name: "Write", tool_input: { file_path: "a.js" },
    }, stateHome);
    assert.ok(Date.now() - started < 10_000);
    assert.equal(JSON.parse(result.stdout).permission, "deny");
  });
});

const POINTER_BEGIN = "<!-- wildarrange:begin -->";
const POINTER_END = "<!-- wildarrange:end -->";

/** 在临时 userRoot 下预置一份用户自己的 Cursor Hook 与 Codex AGENTS.md。 */
async function seedUserRoot(root) {
  const userRoot = path.join(root, "user-home");
  await mkdir(path.join(userRoot, ".cursor"), { recursive: true });
  await mkdir(path.join(userRoot, ".codex"), { recursive: true });
  const hooks = JSON.stringify({ version: 1, hooks: { sessionStart: [{ command: "node existing-hook.mjs" }] } });
  await writeFile(path.join(userRoot, ".cursor", "hooks.json"), hooks);
  await writeFile(path.join(userRoot, ".codex", "AGENTS.md"), "# My global Codex rules\n\n- be nice\n");
  return { userRoot, hooks };
}

async function doctorCodes(projectRoot) {
  const report = await runDoctor(projectRoot);
  return report.findings.map((finding) => finding.code).filter(Boolean);
}

test("activation writes user-level pointers idempotently, never into the customer project", async () => {
  await withExternalProject(async (roots) => {
    const { projectRoot, root } = roots;
    const { workspace } = await prepareScopedProject(roots, { importTask: false });
    const { userRoot } = await seedUserRoot(root);
    const before = await readFile(path.join(userRoot, ".codex", "AGENTS.md"), "utf8");
    await activateCursorAdapter(projectRoot, workspace, { userRoot });
    await activateCursorAdapter(projectRoot, workspace, { userRoot });
    await activateCodexAdapter(projectRoot, workspace, { userRoot });
    await activateCodexAdapter(projectRoot, workspace, { userRoot });
    const rule = await readFile(path.join(userRoot, ".cursor", "rules", "wildarrange.mdc"), "utf8");
    assert.match(rule, /alwaysApply:\s*true/);
    assert.match(rule, /wildarrange status/);
    assert.ok(rule.length < 800, "pointer stays short");
    const agents = await readFile(path.join(userRoot, ".codex", "AGENTS.md"), "utf8");
    assert.ok(agents.startsWith(before), "existing user content is preserved");
    assert.equal(agents.split(POINTER_BEGIN).length - 1, 1);
    assert.equal(agents.split(POINTER_END).length - 1, 1);
    assert.match(agents, /wildarrange status/);
    assert.equal(existsSync(path.join(projectRoot, ".cursor")), false);
    assert.equal(existsSync(path.join(projectRoot, "AGENTS.md")), false);
  });
});

test("uninstall removes user hook entries, pointers and runtime bundles but keeps user-owned content", async () => {
  await withExternalProject(async (roots) => {
    const { projectRoot, root } = roots;
    const { workspace, report } = await prepareScopedProject(roots, { importTask: false });
    const { userRoot, hooks } = await seedUserRoot(root);
    await activateCursorAdapter(projectRoot, workspace, { userRoot });
    await activateCodexAdapter(projectRoot, workspace, { userRoot });
    const result = await uninstallAdapters(projectRoot, workspace, { target: "all" });
    assert.equal(result.kind, "wildarrange_external_adapter_uninstall");
    const userHooks = JSON.parse(await readFile(path.join(userRoot, ".cursor", "hooks.json"), "utf8"));
    assert.deepEqual(userHooks.hooks.sessionStart, JSON.parse(hooks).hooks.sessionStart);
    assert.equal(JSON.stringify(userHooks).includes(CURSOR_BRIDGE_NAME), false);
    assert.equal(existsSync(path.join(userRoot, ".cursor", "hooks", CURSOR_BRIDGE_NAME)), false);
    assert.equal(existsSync(path.join(userRoot, ".cursor", "rules", "wildarrange.mdc")), false);
    const agents = await readFile(path.join(userRoot, ".codex", "AGENTS.md"), "utf8");
    assert.equal(agents.includes(POINTER_BEGIN), false);
    assert.match(agents, /My global Codex rules/);
    for (const target of ["codex", "cursor", "kimi"]) {
      assert.equal(existsSync(path.dirname(report.targets[target].bridgePath)), false, `${target} runtime bundle removed`);
    }
    const remaining = JSON.parse(await readFile(path.join(workspace.runtimeRoot, "adapters", "external", "install-report.json"), "utf8"));
    assert.deepEqual(Object.keys(remaining.targets), []);
  });
});

test("restore returns user files to their pre-activation state", async () => {
  await withExternalProject(async (roots) => {
    const { projectRoot, root } = roots;
    const { workspace } = await prepareScopedProject(roots, { importTask: false });
    const { userRoot, hooks } = await seedUserRoot(root);
    const agentsBefore = await readFile(path.join(userRoot, ".codex", "AGENTS.md"), "utf8");
    const cursor = await activateCursorAdapter(projectRoot, workspace, { userRoot });
    const codex = await activateCodexAdapter(projectRoot, workspace, { userRoot });
    await restoreAdapterBackup(projectRoot, workspace, { backupId: cursor.backupId });
    await restoreAdapterBackup(projectRoot, workspace, { backupId: codex.backupId });
    assert.equal(await readFile(path.join(userRoot, ".cursor", "hooks.json"), "utf8"), hooks);
    assert.equal(await readFile(path.join(userRoot, ".codex", "AGENTS.md"), "utf8"), agentsBefore);
    assert.equal(existsSync(path.join(userRoot, ".cursor", "rules", "wildarrange.mdc")), false, "file created by activation is removed on restore");
    await assert.rejects(() => restoreAdapterBackup(projectRoot, workspace, { backupId: "no-such-backup" }), /backup/i);
  });
});

test("doctor reports plugin hooks files and user Cursor entries that no longer match the install digest", async () => {
  await withExternalProject(async (roots) => {
    const { projectRoot, root } = roots;
    const { workspace, report } = await prepareScopedProject(roots, { importTask: false });
    const { userRoot } = await seedUserRoot(root);
    await activateCursorAdapter(projectRoot, workspace, { userRoot });
    assert.equal((await doctorCodes(projectRoot)).includes("external_adapter_config_modified"), false);
    await writeFile(report.targets.codex.hooksPath, JSON.stringify({ hooks: {} }));
    assert.equal((await doctorCodes(projectRoot)).includes("external_adapter_config_modified"), true, "tampered Codex plugin hooks");
    await installAdapters(projectRoot, workspace, { target: "codex", mode: "local", localCliPath: CLI_PATH });
    assert.equal((await doctorCodes(projectRoot)).includes("external_adapter_config_modified"), false);
    const hooksPath = path.join(userRoot, ".cursor", "hooks.json");
    const userHooks = JSON.parse(await readFile(hooksPath, "utf8"));
    userHooks.hooks.preToolUse = [];
    await writeFile(hooksPath, JSON.stringify(userHooks));
    assert.equal((await doctorCodes(projectRoot)).includes("external_adapter_config_modified"), true, "deleted user Cursor hook entry");
  });
});

test("adapter activate/uninstall/restore run through the CLI with --user-root", async () => {
  await withExternalProject(async (roots) => {
    const { projectRoot, stateHome, root } = roots;
    await prepareScopedProject(roots, { importTask: false });
    const { userRoot } = await seedUserRoot(root);
    const run = (...args) => runCommandFile(process.execPath, [CLI_PATH, ...args], projectRoot, 60_000, { env: { WILDARRANGE_STATE_HOME: stateHome } });
    const activated = await run("adapter", "activate", "--target", "all", "--user-root", userRoot);
    assert.equal(activated.exitCode, 0, activated.stderr);
    const parsed = JSON.parse(activated.stdout);
    assert.equal(existsSync(path.join(userRoot, ".cursor", "rules", "wildarrange.mdc")), true);
    assert.match(await readFile(path.join(userRoot, ".codex", "AGENTS.md"), "utf8"), /wildarrange:begin/);
    const restored = await run("adapter", "restore", "--backup", parsed.cursor.backupId);
    assert.equal(restored.exitCode, 0, restored.stderr);
    const uninstalled = await run("adapter", "uninstall", "--target", "all");
    assert.equal(uninstalled.exitCode, 0, uninstalled.stderr);
    assert.equal(existsSync(path.join(userRoot, ".codex", "AGENTS.md")), true);
    assert.equal((await readFile(path.join(userRoot, ".codex", "AGENTS.md"), "utf8")).includes("wildarrange:begin"), false);
  });
});
