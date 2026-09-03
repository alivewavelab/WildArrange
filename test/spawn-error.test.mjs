/**
 * spawn error 处理：runCommand 的 spawn 级失败不再击穿进程；
 * runOneAgent 的未预期异常只产生该任务的 fail 结果，不拖垮整个批次。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { runCommand } from "../src/infra/command-runner.mjs";
import { runParallelAgents } from "../src/orchestration/parallel-runtime.mjs";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { resolveWildArrangePath } from "../src/infra/runtime-store.mjs";

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-spawn-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("runCommand resolves a 127 result when the spawn itself fails (bad cwd)", async () => {
  const missing = path.join(process.cwd(), ".tmp", `no-such-dir-${Date.now()}`);
  const result = await runCommand("echo hello", missing, 5_000);
  assert.equal(result.exitCode, 127);
  assert.equal(result.spawnError, true);
  assert.match(result.stderr, /failed to spawn/i);
});

test("a crashing runner fails only its own task; the rest of the batch still lands", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    const planPath = resolveWildArrangePath(dir, "artifacts", "spawn-error-plan.json");
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, JSON.stringify({
      planId: "spawn-error-plan",
      title: "spawn error isolation",
      objective: "one task crashes mid-run, the other must still land",
      tasks: [
        {
          id: "T001",
          title: "healthy task",
          owner: "ZhuRong",
          writable_paths: ["src/**"],
          verify_commands: ["node -e \"process.exit(0)\""],
        },
        {
          id: "T002",
          title: "sabotaged task",
          owner: "ZhuRong",
          writable_paths: ["src/**"],
          verify_commands: ["node -e \"process.exit(0)\""],
        },
      ],
    }, null, 2));
    await importPlan(dir, planPath);

    // T002 的 runner 在自己的工作目录里造出一个与 agent-result.json 同名的
    // 目录，让结果读取/落盘必然抛错——模拟 runner 中途崩溃的未预期异常。
    const sabotage = "node -e \"require('node:fs').mkdirSync('agent-result.json')\"";
    const batch = await runParallelAgents(dir, {
      command: "node -e \"process.exit(0)\"",
      taskIds: ["T001"],
      maxAgents: 1,
    });
    assert.equal(batch.results.length, 1);
    assert.equal(batch.results[0].status, "pass");

    const crashed = await runParallelAgents(dir, {
      command: sabotage,
      taskIds: ["T002"],
      maxAgents: 1,
    });
    assert.equal(crashed.results.length, 1);
    assert.equal(crashed.results[0].status, "fail", "the crashed runner becomes a fail result, not a rejected batch");
    assert.equal(crashed.results[0].pass, false);
    assert.ok(crashed.results[0].error, "the underlying error message must be preserved for diagnosis");

    const persisted = JSON.parse(await readFile(
      resolveWildArrangePath(dir, "agent-runs", crashed.runId, "T002", "result.json"),
      "utf8",
    ));
    assert.equal(persisted.status, "fail", "the fail result must be persisted for status/adoption");
  });
});
