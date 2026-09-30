// =============================================================================
// 文件名称：admission-recovery.mjs
// 所属模块：orchestration
// 作用说明：
//   并行 admission 失败与恢复：回滚计划持久化、工作区还原与 apply 失败记账。
//   均在 admission 任务锁内调用，不二次加锁；失败状态统一经 task-recovery.mjs 落盘。
//
// 【运行原理速读】
//   可以把它想成「admission 出事后的急救箱」：
//
//   · 何时执行？
//     apply 失败、回滚失败、集成基线变化或 checkpoint 后故障时。
//
//   · 做了什么？
//     记录失败 → 回滚文件/patch → 审计入账本后提交 recovery/revalidation 状态。
//
//   · 约束？
//     回滚失败保留 owner 与 rollback plan，禁止释放脏工作区。
// =============================================================================
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import { runCommandFile } from "../infra/command-runner.mjs";
import { assertPathInsideRoot } from "../infra/path-match.mjs";
import {
  nowIso,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { loadTaskState } from "./plan-state.mjs";
import { persistTaskFailure } from "./task-recovery.mjs";

/**
 * 在 admission 任务锁内记录 apply 失败：按回滚结果更新任务状态与账本。
 * 恢复持久化决定是否可释放 claim；禁止在此再获取第二把任务锁。
 */
export async function recordApplyFailureWithinLock(rootDir, taskId, { runId, error, rollback }) {
  const taskState = await loadTaskState(rootDir);
  if (!taskState) return;
  const task = taskState.tasks.find((candidate) => candidate.id === taskId);
  if (!task || task.status !== "verifying") return;
  const rolledBack = rollback?.status === "rolled_back";
  if (rolledBack) task.admission_claim = null;
  await persistTaskFailure(rootDir, taskState, task, {
    status: rolledBack ? "pending" : "verifying",
    failure: {
      reason: rolledBack ? "admission_apply_failed" : "admission_rollback_failed",
      summary: rolledBack
        ? `parallel admission failed while applying files: ${error.message}`
        : `parallel admission apply failed and workspace rollback did not complete: ${rollback?.error || error.message}`,
      retryHint: rolledBack
        ? "工作区已回滚到 admission 前的内容，修复失败原因后重新 admit 即可"
        : `工作区回滚失败；任务所有权和 rollback plan 已保留。修复文件系统问题后，用同一 run 重新 admit。涉及路径：${(rollback?.paths || []).join(", ") || "unknown"}`,
    },
    event: {
      type: "parallel_agent_admission_apply_failed",
      runId: runId || null,
      error: error.message,
      rollback: rollback?.status || null,
      rollbackPaths: rollback?.paths || [],
    },
    report: false,
  });
}

/** 返回 agent-runs 下某 run/task 持久化回滚计划的 JSON 路径。 */
function rollbackPlanPath(rootDir, runId, taskId) {
  return resolveWildArrangePath(rootDir, "agent-runs", runId, `${taskId}.rollback-plan.json`);
}

/** 持久化 admission 前快照回滚计划，供 apply 失败后还原工作区。 */
export async function persistRollbackPlan(rootDir, runId, taskId, rollbackPlan) {
  await writeJsonAtomic(rollbackPlanPath(rootDir, runId, taskId), {
    runId,
    taskId,
    persistedAt: nowIso(),
    plan: rollbackPlan,
  });
}

/** 读取已持久化的回滚计划。 */
export async function loadPersistedRollbackPlan(rootDir, runId, taskId) {
  const stored = await readJson(rollbackPlanPath(rootDir, runId, taskId), null);
  return stored?.plan || null;
}

/** 删除已完成的回滚计划文件。 */
export async function removePersistedRollbackPlan(rootDir, runId, taskId) {
  await rm(rollbackPlanPath(rootDir, runId, taskId), { force: true }).catch(() => {});
}

/** 检测 patch 是否已在工作区应用过（git apply --reverse --check）。 */
export async function patchAlreadyApplied(rootDir, patch) {
  const patchPath = resolveWildArrangePath(rootDir, "agent-runs", `recheck-${Date.now()}-${process.pid}.patch`);
  await mkdir(path.dirname(patchPath), { recursive: true });
  await writeFile(patchPath, patch, "utf8");
  try {
    const reverseCheck = await runCommandFile("git", ["-C", rootDir, "apply", "--reverse", "--check", "--whitespace=nowarn", patchPath], rootDir, 30_000);
    return reverseCheck.exitCode === 0;
  } finally {
    await rm(patchPath, { force: true });
  }
}

/** 为即将写入的文件列表创建 files 模式回滚计划（保存原内容或 existed=false）。 */
export async function createFileRollbackPlan(rootDir, files) {
  const entries = [];
  for (const file of files) {
    const absolutePath = path.join(rootDir, file.path);
    assertPathInsideRoot(rootDir, absolutePath, file.path);
    try {
      entries.push({
        path: file.path,
        existed: true,
        content: await readFile(absolutePath, "utf8"),
      });
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
      entries.push({ path: file.path, existed: false, content: "" });
    }
  }
  return { mode: "files", paths: files.map((file) => file.path), entries };
}

/** 按回滚计划还原工作区（files 或 patch 模式），结果写入账本。 */
export async function rollbackAdmissionChanges(rootDir, rollbackPlan) {
  if (!rollbackPlan || rollbackPlan.mode === "none") {
    return { status: "skipped", reason: "no rollback plan" };
  }
  try {
    if (rollbackPlan.mode === "files") {
      for (const entry of rollbackPlan.entries || []) {
        const absolutePath = path.join(rootDir, entry.path);
        assertPathInsideRoot(rootDir, absolutePath, entry.path);
        if (entry.existed) {
          await mkdir(path.dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, entry.content, "utf8");
        } else {
          await rm(absolutePath, { force: true }).catch((error) => {
            if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
          });
        }
      }
    } else if (rollbackPlan.mode === "patch") {
      const patchPath = resolveWildArrangePath(rootDir, "agent-runs", `rollback-${Date.now()}-${process.pid}.patch`);
      await mkdir(path.dirname(patchPath), { recursive: true });
      await writeFile(patchPath, rollbackPlan.patch, "utf8");
      try {
        const reverse = await runCommandFile("git", ["-C", rootDir, "apply", "--reverse", "--whitespace=nowarn", patchPath], rootDir, 30_000);
        if (reverse.exitCode !== 0) {
          throw new Error(reverse.stderr || reverse.stdout || "git apply --reverse failed");
        }
      } finally {
        await rm(patchPath, { force: true });
      }
    }
    await appendLedger(rootDir, { type: "parallel_agent_admission_rolled_back", mode: rollbackPlan.mode, paths: rollbackPlan.paths || [] });
    return { status: "rolled_back", mode: rollbackPlan.mode, paths: rollbackPlan.paths || [] };
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    await appendLedger(rootDir, { type: "parallel_agent_admission_rollback_failed", mode: rollbackPlan.mode, paths: rollbackPlan.paths || [], error: summary });
    return { status: "rollback_failed", mode: rollbackPlan.mode, paths: rollbackPlan.paths || [], error: summary };
  }
}
