// =============================================================================
// 文件名称：adapters.test.mjs
// 所属模块：test
// 作用说明：验证外置 Adapter 包、Cursor 用户级显式激活、全局 Hook 项目筛选与回执。
// =============================================================================
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  attachGovernanceRepository,
  initializeGovernanceRepository,
} from "../src/infra/workspace-context.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import {
  activateCursorAdapter,
  installAdapters,
} from "../src/interface/adapters.mjs";
import { CURSOR_BRIDGE_NAME } from "../src/interface/adapter-bundles.mjs";
import { runDoctor } from "../src/interface/doctor.mjs";
import { importPlan } from "../src/orchestration/plan-state.mjs";

test("external adapters generate all host bundles without writing customer repository files", async () => {
  await withExternalWorkspace(async ({ projectRoot, runtimeRoot, workspace }) => {
    const before = await tree(projectRoot);
    const report = await installAdapters(projectRoot, workspace, {
      target: "all",
      mode: "local",
      localCliPath: path.join(process.cwd(), "bin", "wildarrange.mjs"),
    });
    assert.deepEqual(await tree(projectRoot), before);
    assert.equal(existsSync(path.join(projectRoot, ".wildarrange")), false);
    assert.equal(report.activationVerified, false);
    assert.equal(existsSync(report.targets.codex.marketplacePath), true);
    assert.equal(
      report.targets.codex.marketplacePath,
      path.join(runtimeRoot, "adapters", "external", "codex-marketplace", ".agents", "plugins", "marketplace.json"),
    );
    assert.equal(existsSync(report.targets.codex.bridgePath), true);
    assert.equal(existsSync(report.targets.cursor.bridgePath), true);
    assert.equal(existsSync(report.targets.kimi.manifestPath), true);
    const manifest = JSON.parse(await readFile(path.join(report.targets.codex.pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.name, "wildarrange-governance");
    assert.equal(manifest.hooks, undefined, "Codex uses default hooks/hooks.json discovery");
    assert.equal(Array.isArray(manifest.interface.defaultPrompt), true);
    assert.equal(existsSync(path.join(runtimeRoot, "adapters", "external", "install-report.json")), true);
    const anotherProject = await installAdapters(projectRoot, { ...workspace, projectId: "another-attached-project" }, {
      target: "codex",
      mode: "local",
      localCliPath: path.join(process.cwd(), "bin", "wildarrange.mjs"),
    });
    assert.equal(anotherProject.targets.codex.activationId, report.targets.codex.activationId, "one user-level plugin can serve every attached project using the same bridge build");
  });
});

test("external Cursor activation preserves existing user hooks, backs them up, and is idempotent", async () => {
  await withExternalWorkspace(async ({ projectRoot, workspace, userRoot }) => {
    const cursorRoot = path.join(userRoot, ".cursor");
    await mkdir(cursorRoot, { recursive: true });
    await writeFile(path.join(cursorRoot, "hooks.json"), JSON.stringify({
      version: 1,
      hooks: { sessionStart: [{ command: "node existing-hook.mjs" }] },
    }));
    await installAdapters(projectRoot, workspace, {
      target: "cursor",
      localCliPath: path.join(process.cwd(), "bin", "wildarrange.mjs"),
    });
    const first = await activateCursorAdapter(projectRoot, workspace, { userRoot });
    const second = await activateCursorAdapter(projectRoot, workspace, { userRoot });
    const hooks = JSON.parse(await readFile(first.hooksPath, "utf8"));
    assert.ok(hooks.hooks.sessionStart.some((entry) => entry.command === "node existing-hook.mjs"));
    assert.equal(hooks.hooks.sessionStart.filter((entry) => entry.command.includes(CURSOR_BRIDGE_NAME)).length, 1);
    assert.equal(existsSync(first.backupPath), true);
    assert.equal(existsSync(second.backupPath), true);
    assert.equal(existsSync(first.bridgePath), true);
    assert.equal(existsSync(path.join(projectRoot, ".cursor")), false);
  });
});

test("external host bridges ignore unrelated projects and record lifecycle receipts for attached project", async () => {
  await withExternalWorkspace(async ({ projectRoot, stateHome, workspace }) => {
    await initRuntime(projectRoot);
    const report = await installAdapters(projectRoot, workspace, {
      target: "all",
      mode: "local",
      localCliPath: path.join(process.cwd(), "bin", "wildarrange.mjs"),
    });
    const unrelated = await mkdtemp(path.join(os.tmpdir(), "wildarrange-external-unrelated-"));
    try {
      const inactive = await runBridge(report.targets.cursor.bridgePath, {
        hook_event_name: "sessionStart",
        conversation_id: "unrelated",
        cwd: unrelated,
      }, stateHome);
      assert.equal(inactive.exitCode, 0, inactive.stderr);
      assert.equal(inactive.stdout, "");
      assert.equal(existsSync(path.join(unrelated, ".wildarrange")), false);
    } finally {
      await rm(unrelated, { recursive: true, force: true });
    }

    const nested = path.join(projectRoot, "src", "nested");
    await mkdir(nested, { recursive: true });
    const cases = [
      ["cursor", report.targets.cursor.bridgePath, { hook_event_name: "sessionStart", conversation_id: "cursor-external", cwd: nested }],
      ["codex", report.targets.codex.bridgePath, { hook_event_name: "SessionStart", session_id: "codex-external", cwd: nested }],
      ["kimi", report.targets.kimi.bridgePath, { hook_event_name: "SessionStart", session_id: "kimi-external", cwd: nested }],
    ];
    for (const [host, bridgePath, payload] of cases) {
      const result = await runBridge(bridgePath, payload, stateHome);
      assert.equal(result.exitCode, 0, `${host}: ${result.stderr}`);
    }
    const doctor = await runDoctor(projectRoot);
    const targets = doctor.sections.adapters.targets;
    for (const host of ["cursor", "codex", "kimi"]) {
      assert.equal(targets.find((entry) => entry.target === host)?.activation, "execution_observed");
    }
    assert.equal(existsSync(path.join(projectRoot, ".wildarrange")), false);
  });
});

test("external Codex Stop hooks return JSON and continue unfinished work", async () => {
  await withExternalWorkspace(async ({ projectRoot, runtimeRoot, stateHome, workspace }) => {
    await initRuntime(projectRoot);
    const report = await installAdapters(projectRoot, workspace, {
      target: "codex",
      mode: "local",
      localCliPath: path.join(process.cwd(), "bin", "wildarrange.mjs"),
    });
    const bridgePath = report.targets.codex.bridgePath;
    const idle = await runBridge(bridgePath, {
      hook_event_name: "Stop", session_id: "codex-idle", cwd: projectRoot,
    }, stateHome);
    assert.equal(idle.exitCode, 0, idle.stderr);
    assert.deepEqual(JSON.parse(idle.stdout), {});

    const planPath = path.join(projectRoot, "plan.json");
    await writeFile(planPath, JSON.stringify({
      id: "codex-stop-plan",
      title: "Codex Stop continuation",
      tasks: [{
        id: "T001",
        subject: "Create result",
        owner: "ZhuRong",
        writable_paths: ["result.txt"],
        worker_command: "node -e \"require('fs').writeFileSync('result.txt','done')\"",
        verify_commands: ["node -e \"if(!require('fs').existsSync('result.txt')) process.exit(1)\""],
      }],
    }));
    await importPlan(projectRoot, planPath);

    for (const event of ["Stop", "SubagentStop"]) {
      const sessionId = `codex-${event.toLowerCase()}`;
      const unfinished = await runBridge(bridgePath, {
        hook_event_name: event, session_id: sessionId, cwd: projectRoot,
      }, stateHome);
      assert.equal(unfinished.exitCode, 0, unfinished.stderr);
      const output = JSON.parse(unfinished.stdout);
      assert.equal(output.decision, "block");
      assert.match(output.reason, /wildarrange\.mjs.*run/);
      const evidence = JSON.parse(await readFile(path.join(runtimeRoot, "sessions", "hooks", `${sessionId}-Stop.json`), "utf8"));
      assert.equal(evidence.continuation.required, true);
    }
    const continuation = JSON.parse(await readFile(path.join(runtimeRoot, "sessions", "continuation.json"), "utf8"));
    assert.equal(continuation.shouldContinue, true);
  });
});

async function withExternalWorkspace(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "wildarrange-external-adapter-"));
  const projectRoot = path.join(root, "project");
  const governanceRoot = path.join(root, "governance");
  const stateHome = path.join(root, "state");
  const runtimeRoot = path.join(stateHome, "runtime");
  const userRoot = path.join(root, "user");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(governanceRoot, { recursive: true });
  await mkdir(userRoot, { recursive: true });
  try {
    await initializeGovernanceRepository(projectRoot, {
      governanceRoot,
      repository: "https://example.test/customer/project.git",
      initGit: true,
    });
    const workspace = await attachGovernanceRepository(projectRoot, {
      governanceRoot,
      runtimeRoot,
      stateHome,
    });
    await callback({ root, projectRoot, governanceRoot, stateHome, runtimeRoot, userRoot, workspace });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function runBridge(bridgePath, payload, stateHome) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath], {
      cwd: payload.cwd,
      env: { ...process.env, WILDARRANGE_STATE_HOME: stateHome },
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

async function tree(rootDir) {
  const { readdir } = await import("node:fs/promises");
  async function walk(current, relative = "") {
    const entries = await readdir(current, { withFileTypes: true });
    const values = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const item = path.posix.join(relative, entry.name);
      values.push(item);
      if (entry.isDirectory()) values.push(...await walk(path.join(current, entry.name), item));
    }
    return values;
  }
  return walk(rootDir);
}
