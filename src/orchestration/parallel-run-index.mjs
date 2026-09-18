// =============================================================================
// 文件名称：parallel-run-index.mjs
// 所属模块：orchestration
// 作用说明：
//   并行 run 的 index.json 读写、孤儿 run 收编与并发锁。
//   只维护 run 索引事实，不启动 agent、不执行 admission、不推进 task 状态。
//
// 【运行原理速读】
//   run 启动/完成 → 本模块在文件锁内登记摘要；
//   status 读取 → 扫描磁盘并收编未登记的 result.json；
//   其他并行编排只消费这些索引事实。
// =============================================================================
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import { withFileLock } from "../infra/file-lock.mjs";
import {
  ensureWildArrangeDirs,
  nowIso,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";

// index.json 的三处 read-modify-write（reconcile 收养孤儿 run、register、
// append）共用一把文件锁：并发 run 或并发 status 同时读写时，无锁会在
// read 与 write 之间互丢条目。
/** 在 agent-runs/index.json 文件锁内执行 fn。 */
async function withRunIndexLock(rootDir, fn) {
  const lockPath = resolveWildArrangePath(rootDir, "agent-runs", "index.json.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  return withFileLock(rootDir, lockPath, "parallel run index lock", "parallel-run-index", fn);
}

// --- 查询与生命周期 ---

/** 列出 agent-runs 索引中所有 parallel run 及结果摘要。 */
export async function listParallelAgentRuns(rootDir) {
  await ensureWildArrangeDirs(rootDir);
  return withRunIndexLock(rootDir, async () => {
    const index = await readJson(resolveWildArrangePath(rootDir, "agent-runs", "index.json"), { runs: [] });
    return reconcileRunIndex(rootDir, index);
  });
}

/**
 * Self-healing for the run index: a run whose per-task result.json files
 * exist on disk but which never made it into index.json (index write failed
 * or the process died mid-run) used to be permanently invisible to
 * `parallel status` (cross-review P1, round 5, 2026-07-21). Every index read
 * scans the agent-runs directory and adopts orphan run dirs back into the
 * index, rebuilding their entries from the result.json files.
 */
async function reconcileRunIndex(rootDir, index) {
  const runsDir = resolveWildArrangePath(rootDir, "agent-runs");
  let dirEntries = [];
  try {
    dirEntries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return index;
  }
  const known = new Set((index.runs || []).map((run) => run.runId));
  const adopted = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory() || known.has(entry.name)) continue;
    const runDir = path.join(runsDir, entry.name);
    const results = [];
    for (const taskEntry of await readdir(runDir, { withFileTypes: true }).catch(() => [])) {
      if (!taskEntry.isDirectory()) continue;
      const result = await readJson(path.join(runDir, taskEntry.name, "result.json"), null);
      if (!result) continue;
      results.push({
        taskId: result.taskId || taskEntry.name,
        agent: result.agent || null,
        pass: result.pass ?? null,
        runDir: result.runDir || path.relative(rootDir, path.join(runDir, taskEntry.name)),
        lifecycle: result.lifecycle || null,
      });
    }
    if (results.length === 0) continue;
    index.runs = index.runs || [];
    index.runs.push({
      runId: entry.name,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      recovered: true,
      results,
    });
    adopted.push(entry.name);
  }
  if (adopted.length > 0) {
    await writeJsonAtomic(resolveWildArrangePath(rootDir, "agent-runs", "index.json"), index);
    await appendLedger(rootDir, { type: "parallel_run_index_reconciled", adoptedRunIds: adopted }).catch(() => {});
  }
  return index;
}

/** 将 runId 预注册到 index.json 为 running 状态。 */
export async function registerRunIndexEntry(rootDir, runId) {
  const indexPath = resolveWildArrangePath(rootDir, "agent-runs", "index.json");
  return withRunIndexLock(rootDir, async () => {
    const index = await readJson(indexPath, { runs: [] });
    if (!index.runs.some((run) => run.runId === runId)) {
      index.runs.push({ runId, createdAt: nowIso(), updatedAt: nowIso(), results: [] });
      await writeJsonAtomic(indexPath, index);
    }
  });
}



/** 将 run 结果摘要追加/更新到 index.json。 */
export async function appendRunIndex(rootDir, runId, results) {
  const indexPath = resolveWildArrangePath(rootDir, "agent-runs", "index.json");
  return withRunIndexLock(rootDir, async () => {
    const index = await readJson(indexPath, { runs: [] });
    const existing = index.runs.find((run) => run.runId === runId);
    const entries = results.map((result) => ({
      taskId: result.taskId,
      agent: result.agent,
      pass: result.pass,
      runDir: result.runDir,
      lifecycle: result.lifecycle || null,
    }));
    if (existing) {
      existing.updatedAt = nowIso();
      existing.results.push(...entries);
    } else {
      index.runs.push({
        runId,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        results: entries,
      });
    }
    await writeJsonAtomic(indexPath, index);
  });
}

