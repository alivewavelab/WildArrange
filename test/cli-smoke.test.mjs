import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.join(process.cwd(), "bin", "helix.mjs");

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

test("cli smoke: bin/helix.mjs loads without module resolution errors", async () => {
  // Regression guard: bin/helix.mjs previously had duplicate named imports
  // (e.g. approvePlan, loadPlanApproval declared twice), which is an ESM
  // SyntaxError that crashes the process before any command runs. Every
  // unit test that imports functions directly from src/helix-core.mjs was
  // blind to this because it never loaded bin/helix.mjs at all.
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

test("cli smoke: doctor runs against an initialized project", async () => {
  await withTempProjectDir(async (dir) => {
    const init = await runCli(["init"], dir);
    assert.equal(init.code, 0, `init failed.\nstderr: ${init.stderr}`);

    const result = await runCli(["doctor"], dir);
    assert.equal(result.code, 0, `doctor failed.\nstderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.reportJsonPath);
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
