import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
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

async function runCli(args, cwd) {
  try {
    const result = await execFileAsync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      encoding: "utf8",
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
    assert.match(hooks.hooks.UserPromptSubmit[0].hooks[0].command, /--host codex$/);

    const hook = await runCliWithInput(["hook", "run", "--host", "codex", "--format", "json"], dir, {
      hook_event_name: "UserPromptSubmit",
      session_id: "cli-codex-host-proof",
      cwd: dir,
      prompt: "验证 Codex 宿主回执",
    });
    assert.equal(hook.code, 0, hook.stderr);
    const hookResult = JSON.parse(hook.stdout);
    assert.equal(hookResult.hostAdapter, "codex");
    assert.match(hookResult.hookConfigDigest, /^[a-f0-9]{64}$/);

    const doctor = await runCli(["doctor"], dir);
    assert.equal(doctor.code, 0, doctor.stderr);
    const report = JSON.parse(doctor.stdout);
    const codex = report.sections.adapters.targets.find((target) => target.target === "codex");
    assert.equal(codex.activation, "execution_observed");
    assert.equal(codex.sessionId, "cli-codex-host-proof");
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
      assert.equal(dashboardUrl.hash.startsWith("#adoption?token="), true);
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
