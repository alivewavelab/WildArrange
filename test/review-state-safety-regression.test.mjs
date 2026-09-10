import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { runCommand } from "../src/infra/command-runner.mjs";
import {
  applyContractCardDecision,
  persistContractScan,
  readContractRegistry,
  scanContractGovernanceUniverse,
} from "../src/infra/contract-governance.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { cleanupParallelAgentRun, runParallelAgents } from "../src/orchestration/parallel-runtime.mjs";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { claimTeamTask, getTeamTask } from "../src/orchestration/task-board.mjs";

const execFileAsync = promisify(execFile);

test("plan reimport refuses to replace an active task claim", async () => {
  await withTempDir(async (rootDir) => {
    await initRuntime(rootDir);
    const planPath = await writePlan(rootDir);
    await importPlan(rootDir, planPath);
    await claimTeamTask(rootDir, { taskId: "T001", owner: "ZhuRong" });
    const before = await getTeamTask(rootDir, "T001");
    await writePlan(rootDir, "T002");

    await assert.rejects(
      importPlan(rootDir, planPath),
      /active task ownership must be preserved/,
    );

    const after = await getTeamTask(rootDir, "T001");
    assert.equal(after.status, before.status);
    assert.deepEqual(after.coordination, before.coordination);
  });
});

test("parallel cleanup retains an awaiting-acceptance dirty worktree", async () => {
  await withTempDir(async (rootDir) => {
    await writeFile(path.join(rootDir, ".gitignore"), ".wildarrange/\n", "utf8");
    await git(rootDir, "init", "-b", "main");
    await git(rootDir, "config", "user.name", "State Safety Test");
    await git(rootDir, "config", "user.email", "state-safety@example.invalid");
    const planPath = await writePlan(rootDir);
    await git(rootDir, "add", ".");
    await git(rootDir, "commit", "-m", "fixture baseline");
    await initRuntime(rootDir);
    await importPlan(rootDir, planPath);

    const run = await runParallelAgents(rootDir, {
      taskIds: ["T001"],
      isolation: "git-worktree",
      maxAgents: 1,
      command: "node -e \"require('node:fs').writeFileSync(process.argv[1], JSON.stringify({summary:'done'}))\" {outputJson}",
    });
    const worktreeDir = path.resolve(rootDir, run.results[0].workDir);
    const notePath = path.join(worktreeDir, "unaccepted-user-note.txt");
    await writeFile(notePath, "keep me", "utf8");

    const cleanup = await cleanupParallelAgentRun(rootDir, { runId: run.runId });

    assert.equal(await readFile(notePath, "utf8"), "keep me");
    assert.equal(cleanup.cleaned[0].status, "retained");
    assert.equal(cleanup.cleaned[0].reason, "lifecycle_requires_retention");
  });
});

test("concurrent contract approvals retain both independent cards", async () => {
  await withTempDir(async (rootDir) => {
    const sourceDir = path.join(rootDir, "client", "src-tauri", "src");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "lib.rs"), [
      "#[tauri::command]",
      "fn first() {}",
      "#[tauri::command]",
      "fn second() {}",
      "fn main() { tauri::generate_handler![first, second]; }",
    ].join("\n"), "utf8");
    const scan = await scanContractGovernanceUniverse(rootDir);
    await persistContractScan(rootDir, scan);

    await Promise.all(scan.cards.map((card) => applyContractCardDecision(rootDir, {
      cardId: card.id,
      decision: "approve",
      reason: "concurrency regression",
      expectedFingerprint: card.fingerprint,
    })));

    assert.deepEqual(
      (await readContractRegistry(rootDir)).contracts.map((contract) => contract.id).sort(),
      ["tauri:first", "tauri:second"],
    );
  });
});

test("Windows timeout reports recovery required when tree termination fails", {
  skip: process.platform !== "win32",
}, async () => {
  await withTempDir(async (rootDir) => {
    const startedAt = Date.now();
    const result = await runCommand(
      "node -e \"setTimeout(() => process.exit(0), 500)\"",
      rootDir,
      20,
      {
        windowsTreeKiller: async (child) => ({
          ok: false,
          method: "taskkill_tree",
          pid: child.pid,
          exitCode: 5,
          error: "Access is denied",
        }),
      },
    );

    assert.ok(Date.now() - startedAt < 400);
    assert.equal(result.exitCode, 125);
    assert.equal(result.timedOut, true);
    assert.equal(result.terminationFailed, true);
    assert.equal(result.recoveryRequired, true);
    assert.equal(result.termination.confirmed, false);
    assert.equal(result.termination.exitCode, 5);
    assert.match(result.stderr, /Access is denied/);
    await new Promise((resolve) => setTimeout(resolve, 550));
  });
});

async function writePlan(rootDir, taskId = "T001") {
  const planPath = path.join(rootDir, "plan.json");
  await writeFile(planPath, JSON.stringify({
    id: "state-safety-plan",
    title: "State safety regression",
    tasks: [{
      id: taskId,
      subject: "Preserve owned work",
      owner: "ZhuRong",
      worker_command: "node --version",
      verify_commands: ["node --version"],
      review_commands: ["node --version"],
      writable_paths: ["result.txt"],
    }],
  }, null, 2), "utf8");
  return planPath;
}

async function git(rootDir, ...args) {
  return execFileAsync("git", ["-C", rootDir, ...args]);
}

async function withTempDir(fn) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "wildarrange-state-safety-"));
  try {
    await fn(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}
