/**
 * 并发回归：run index.json 的 read-modify-write 必须串行化。
 * 两个并行 run 同时 register/append、并发 status 触发 reconcile 收养
 * 孤儿 run 目录时，index.json 不得丢失任何 run 或 task 条目。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { listParallelAgentRuns, runParallelAgents } from "../src/orchestration/parallel-runtime.mjs";
import { importPlan } from "../src/orchestration/plan-state.mjs";
import { initRuntime } from "../src/infra/runtime-bootstrap.mjs";
import { readJson, resolveWildArrangePath } from "../src/infra/runtime-store.mjs";

async function withTempDir(fn) {
  const baseDir = path.join(process.cwd(), ".tmp");
  await mkdir(baseDir, { recursive: true });
  const dir = await mkdtemp(path.join(baseDir, "wildarrange-index-lock-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function importFourTaskPlan(dir) {
  const planPath = resolveWildArrangePath(dir, "artifacts", "index-lock-plan.json");
  await mkdir(path.dirname(planPath), { recursive: true });
  await writeFile(planPath, JSON.stringify({
    planId: "index-lock-plan",
    title: "run index concurrency",
    objective: "concurrent runs must not lose index entries",
    tasks: ["T001", "T002", "T003", "T004"].map((id) => ({
      id,
      title: `task ${id}`,
      owner: "ZhuRong",
      writable_paths: ["src/**"],
      verify_commands: ["node -e \"process.exit(0)\""],
    })),
  }, null, 2));
  await importPlan(dir, planPath);
}

test("concurrent parallel runs keep both run entries and all results in index.json", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);
    await importFourTaskPlan(dir);

    const command = "node -e \"process.exit(0)\"";
    const [batchA, batchB] = await Promise.all([
      runParallelAgents(dir, { command, taskIds: ["T001", "T002"], maxAgents: 2, agent: "ZhuRong" }),
      runParallelAgents(dir, { command, taskIds: ["T003", "T004"], maxAgents: 2, agent: "ZhuRong" }),
    ]);
    assert.equal(batchA.status, "completed");
    assert.equal(batchB.status, "completed");

    // 断言持久化的 index.json 本身，而不是内存返回值。
    const index = await readJson(resolveWildArrangePath(dir, "agent-runs", "index.json"), { runs: [] });
    const byRunId = new Map((index.runs || []).map((run) => [run.runId, run]));
    assert.ok(byRunId.has(batchA.runId), "并发 register/append 不得丢失第一个 run 的索引条目");
    assert.ok(byRunId.has(batchB.runId), "并发 register/append 不得丢失第二个 run 的索引条目");
    assert.deepEqual(
      byRunId.get(batchA.runId).results.map((entry) => entry.taskId).sort(),
      ["T001", "T002"],
      "并发写入不得丢失第一个 run 的 task 结果",
    );
    assert.deepEqual(
      byRunId.get(batchB.runId).results.map((entry) => entry.taskId).sort(),
      ["T003", "T004"],
      "并发写入不得丢失第二个 run 的 task 结果",
    );
  });
});

test("concurrent index reads adopt every orphan run dir exactly once", async () => {
  await withTempDir(async (dir) => {
    await initRuntime(dir);

    const orphanCount = 12;
    for (let i = 0; i < orphanCount; i += 1) {
      const taskDir = resolveWildArrangePath(dir, "agent-runs", `orphan-run-${i}`, "T900");
      await mkdir(taskDir, { recursive: true });
      await writeFile(path.join(taskDir, "result.json"), JSON.stringify({
        taskId: "T900",
        agent: "ZhuRong",
        pass: true,
      }));
    }

    // 多路并发读同时触发 reconcile 收养：无锁时各自读到同一旧 index，
    // 后写覆盖先写，收养的 run 条目互丢。
    const listings = await Promise.all(
      Array.from({ length: 4 }, () => listParallelAgentRuns(dir)),
    );
    for (const listing of listings) {
      assert.equal(
        (listing.runs || []).filter((run) => run.runId.startsWith("orphan-run-")).length,
        orphanCount,
        "每次 reconcile 都必须看到全部已收养的孤儿 run",
      );
    }

    const index = await readJson(resolveWildArrangePath(dir, "agent-runs", "index.json"), { runs: [] });
    const adopted = (index.runs || []).filter((run) => run.runId.startsWith("orphan-run-"));
    assert.equal(adopted.length, orphanCount, "持久化的 index.json 必须收养全部孤儿 run，不得丢条目");
    assert.ok(
      adopted.every((run) => run.recovered === true && run.results.length === 1),
      "收养的条目必须带 recovered 标记和重建的 results",
    );
  });
});
