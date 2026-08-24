/**
 * 中断对账 + partial 重试：batch 持久化 taskIds/command/agent；
 * status 暴露 incompleteTasks；parallel retry 只重跑未通过的任务。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

import {
  parallelAgentStatus,
  retryParallelAgentRun,
  runParallelAgents,
} from "../src/orchestration/parallel-runtime.mjs";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { resolveHelixPath } from "../src/infra/runtime-store.mjs";

const CLI_PATH = path.resolve(process.cwd(), "bin", "helix.mjs");

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-retry-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function importTwoTaskPlan(dir) {
  const planPath = resolveHelixPath(dir, "artifacts", "retry-plan.json");
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify({
    planId: "retry-plan",
    title: "partial retry",
    objective: "only the failed task is retried",
    tasks: ["T001", "T002"].map((id) => ({
      id,
      title: `task ${id}`,
      owner: "ZhuRong",
      writable_paths: ["src/**"],
      verify_commands: ["node -e \"process.exit(0)\""],
    })),
  }, null, 2));
  await importPlan(dir, planPath);
}

test("status reconciles incomplete tasks and retry re-runs only the failed one", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importTwoTaskPlan(dir);

    // 同一命令按工作目录区分成败：T002 失败、T001 通过。
    const batch = await runParallelAgents(dir, {
      command: "node -e \"process.exit(process.cwd().includes('T002') ? 1 : 0)\"",
      taskIds: ["T001", "T002"],
      maxAgents: 2,
    });
    assert.equal(batch.status, "failed");

    const status = await parallelAgentStatus(dir, { runId: batch.runId });
    assert.equal(status.runs[0].batchStatus, "failed");
    assert.deepEqual(status.runs[0].incompleteTasks, ["T002"], "对账必须指出有头无尾的任务");
    assert.ok(status.runs[0].command.includes("T002"), "status 必须带回原命令供诊断");

    // partial 重试：只重跑 T002，并用修复后的命令覆盖原命令。
    const retry = await retryParallelAgentRun(dir, {
      runId: batch.runId,
      command: "node -e \"process.exit(0)\"",
    });
    assert.equal(retry.status, "requeued");
    assert.deepEqual(retry.retried, ["T002"]);
    assert.deepEqual(retry.skipped, [{ taskId: "T001", reason: "already passed in this run" }]);
    assert.ok(retry.newRunId && retry.newRunId !== batch.runId, "重试是新 run，不改写原 run 证据");

    const retryStatus = await parallelAgentStatus(dir, { runId: retry.newRunId });
    assert.equal(retryStatus.runs[0].batchStatus, "completed");
    assert.deepEqual(retryStatus.runs[0].incompleteTasks, []);

    // 全部通过后再 retry：明确无事可做，不空跑新 run。
    const again = await retryParallelAgentRun(dir, { runId: batch.runId });
    assert.equal(again.status, "nothing_to_retry");
    assert.equal(again.retried.length, 0);
  });
});

test("parallel retry CLI requeues the incomplete tasks of a run", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importTwoTaskPlan(dir);
    const batch = await runParallelAgents(dir, {
      command: "node -e \"process.exit(process.cwd().includes('T002') ? 1 : 0)\"",
      taskIds: ["T001", "T002"],
      maxAgents: 2,
    });

    const run = spawnSync(process.execPath, [
      CLI_PATH, "parallel", "retry",
      "--root", dir,
      "--run", batch.runId,
      "--command", "node -e \"process.exit(0)\"",
    ], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.kind, "parallel_agent_retry");
    assert.deepEqual(parsed.retried, ["T002"]);
  });
});
