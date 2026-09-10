/**
 * 汇报分级测试：reporting.verbosity 控制 wildarrange run 结束时的门决策汇总。
 * verbose（默认）= stderr 输出逐门投影；normal = 一行；quiet = 只 JSON。
 * stdout 的 JSON 契约在任何级别下都不得改变。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importPlan } from "../src/orchestration/plan-state.mjs";
import { runCommand } from "../src/infra/command-runner.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { resolveWildArrangePath } from "../src/infra/runtime-store.mjs";

const CLI_PATH = path.resolve(process.cwd(), "bin", "wildarrange.mjs");

async function withTempDir(fn) {
  const baseDir = path.join(os.tmpdir(), "wildarrange-tests");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-verbosity-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function passingTask(id) {
  return {
    id,
    subject: `task ${id}`,
    worker_command: "node -e \"require('node:fs').mkdirSync('src',{recursive:true});require('node:fs').writeFileSync('src/result.txt','ok')\"",
    verify_commands: ["node -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('src/result.txt','utf8'),'ok')\""],
    review_commands: ["node -e \"const fs=require('node:fs');require('node:assert/strict').equal(fs.statSync('src/result.txt').size,2);if(fs.existsSync('unexpected.txt'))process.exit(1)\""],
    writable_paths: ["src/**"],
  };
}

async function importPlanWith(dir, fileName, title, tasks) {
  const planPath = resolveWildArrangePath(dir, "artifacts", fileName);
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify({ title, tasks }, null, 2));
  await importPlan(dir, planPath);
}

async function commitInitialGitBaseline(dir) {
  await writeFile(path.join(dir, ".gitignore"), ".wildarrange/\n");
  for (const command of ["git config user.email test@example.com", "git config user.name WildArrange-Test", "git add .gitignore", "git commit -m initial"]) {
    const result = await runCommand(command, dir);
    assert.equal(result.exitCode, 0, result.stderr);
  }
}

function runCli(dir) {
  return spawnSync(process.execPath, [CLI_PATH, "run", "--root", dir], { cwd: dir, encoding: "utf8" });
}

test("default verbose prints the per-gate decision summary on stderr, JSON on stdout", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await runCommand("git init", dir);
    await commitInitialGitBaseline(dir);
    await importPlanWith(dir, "verbosity-plan.json", "Verbosity", [passingTask("T001")]);

    const run = runCli(dir);
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.status, "completed");
    assert.match(run.stderr, /门决策汇总/);
    assert.match(run.stderr, /verify/);
    assert.match(run.stderr, /checkpoint/);
  });
});

test("quiet prints no gate summary; normal prints exactly one line", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await runCommand("git init", dir);
    await commitInitialGitBaseline(dir);
    await importPlanWith(dir, "verbosity-plan.json", "Verbosity", [passingTask("T001")]);

    await writeFile(path.join(dir, "wildarrange.config.json"), JSON.stringify({ reporting: { verbosity: "quiet" } }, null, 2));
    const quiet = runCli(dir);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(JSON.parse(quiet.stdout).status, "completed");
    assert.ok(!quiet.stderr.includes("门决策汇总"), "quiet 不得输出门汇总");

    await importPlanWith(dir, "verbosity-plan-2.json", "Verbosity 2", [passingTask("T002")]);
    await writeFile(path.join(dir, "wildarrange.config.json"), JSON.stringify({ reporting: { verbosity: "normal" } }, null, 2));
    const normal = runCli(dir);
    assert.equal(normal.status, 0, normal.stderr);
    assert.match(normal.stderr, /\[run\] T002 -> completed/);
    assert.ok(!normal.stderr.includes("门决策汇总"), "normal 只输出一行");
  });
});

test("invalid reporting.verbosity is rejected with a clear error", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await runCommand("git init", dir);
    await importPlanWith(dir, "verbosity-plan.json", "Verbosity", [passingTask("T001")]);
    await writeFile(path.join(dir, "wildarrange.config.json"), JSON.stringify({ reporting: { verbosity: "chatty" } }, null, 2));
    const run = runCli(dir);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /reporting\.verbosity must be verbose, normal, or quiet/);
  });
});
