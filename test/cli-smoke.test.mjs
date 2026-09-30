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
//   项目内零写入与 adapter hook 安装产物。
// =============================================================================

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { withExternalProject } from "./helpers/external-fixture.mjs";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.join(process.cwd(), "bin", "wildarrange.mjs");

/** 隔离的临时项目目录（位于仓库 .tmp 下）。 */
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

test("cli smoke: an unconnected project fails with a setup hint, writes nothing, and keeps read-only commands working", async () => {
  await withTempProjectDir(async (dir) => {
    const env = { WILDARRANGE_STATE_HOME: `${dir}-state` };
    for (const args of [["status"], ["init"], ["doctor"], ["config", "init"], ["adapter", "install"]]) {
      const result = await runCli(args, dir, { env });
      assert.notEqual(result.code, 0, args.join(" "));
      assert.match(result.stderr, /project_not_connected/);
      assert.match(result.stderr, /wildarrange setup --governance-root/);
    }
    assert.equal(existsSync(path.join(dir, ".wildarrange")), false, "no runtime is created inside the project");
    const shown = await runCli(["project", "show"], dir, { env });
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).attached, false);
    const help = await runCli(["--help"], dir, { env });
    assert.equal(help.code, 0, help.stderr);
    const hook = await runCliWithInput(["hook", "run", "--format", "json"], dir, { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Write", tool_input: { file_path: "a.js" } }, env);
    assert.equal(hook.code, 0, hook.stderr);
    assert.equal(JSON.parse(hook.stdout).inactive, true);
  });
});

test("cli smoke: the legacy --control-root option no longer selects a project", async () => {
  await withTempProjectDir(async (dir) => {
    const result = await runCli(["status", "--control-root", dir], dir, { env: { WILDARRANGE_STATE_HOME: `${dir}-state` } });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /project_not_connected/);
  });
});

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
      assert.equal(connection.projectRoot, dir);
      assert.equal(connection.governanceRoot, governanceRoot);
      assert.equal(existsSync(path.join(dir, ".wildarrange")), false);

      const init = await runCli(["init"], dir, { env });
      assert.equal(init.code, 0, init.stderr);
      const initialized = JSON.parse(init.stdout);
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

async function runCliWithInput(args, cwd, input, env = {}) {
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, ...env },
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

test("cli smoke: status runs against an initialized project", async () => {
  await withExternalProject(async ({ projectRoot: dir, stateHome }) => {
    const result = await runCli(["status"], dir, { env: { WILDARRANGE_STATE_HOME: stateHome } });
    assert.equal(result.code, 0, `status failed.\nstderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(typeof parsed.total, "number");
  });
});

test("cli smoke: governance audit writes a deterministic report", async () => {
  await withExternalProject(async ({ projectRoot: dir, stateHome }) => {
    const result = await runCli(["governance", "audit", "--force"], dir, { env: { WILDARRANGE_STATE_HOME: stateHome } });
    assert.equal(result.code, 0, `governance audit failed.\nstderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.kind, "repository_governance");
    assert.ok(parsed.reportJsonPath);
  });
});

test("cli smoke: adoption start auto-provisions a usable Dashboard token", async () => {
  await withExternalProject(async ({ projectRoot: dir, stateHome }) => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "legacy", scripts: { test: "node --version" } }, null, 2));
    await mkdir(path.join(dir, "test"), { recursive: true });
    await writeFile(path.join(dir, "test", "smoke.test.mjs"), "export const ok = true;\n");

    const child = spawn(process.execPath, [CLI_PATH, "adoption", "start", "--port", "0"], {
      cwd: dir,
      env: { ...process.env, WILDARRANGE_STATE_HOME: stateHome },
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
