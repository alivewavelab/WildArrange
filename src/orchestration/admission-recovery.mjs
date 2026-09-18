// =============================================================================
// 文件名称：admission-recovery.mjs
// 所属模块：orchestration
// 作用说明：
//   并行 admission 失败与恢复：回滚计划持久化、工作区还原、revalidation 与
//   post-integration recovery 状态投影。均在 admission 任务锁内调用，不二次加锁。
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
import { transactWithLedger } from "../infra/task-state-lock.mjs";
import { writeFailureReport } from "../infra/task-reports.mjs";
import { persistTaskState } from "./task-board.mjs";
import { loadTaskState } from "./plan-state.mjs";

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
  task.status = rolledBack ? "pending" : "verifying";
  if (rolledBack) task.admission_claim = null;
  task.last_failure = {
    at: nowIso(),
    reason: rolledBack ? "admission_apply_failed" : "admission_rollback_failed",
    summary: rolledBack
      ? `parallel admission failed while applying files: ${error.message}`
      : `parallel admission apply failed and workspace rollback did not complete: ${rollback?.error || error.message}`,
    retryHint: rolledBack
      ? "工作区已回滚到 admission 前的内容，修复失败原因后重新 admit 即可"
      : `工作区回滚失败；任务所有权和 rollback plan 已保留。修复文件系统问题后，用同一 run 重新 admit。涉及路径：${(rollback?.paths || []).join(", ") || "unknown"}`,
  };
  task.updatedAt = nowIso();
  await appendLedger(rootDir, {
    type: "parallel_agent_admission_apply_failed",
    runId: runId || null,
    taskId,
    error: error.message,
    rollback: rollback?.status || null,
    rollbackPaths: rollback?.paths || [],
  });
  await persistTaskState(rootDir, taskState);
}

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
  const patchPath = path.join(rootDir, ".wildarrange", "agent-runs", `recheck-${Date.now()}-${process.pid}.patch`);
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
      const patchPath = path.join(rootDir, ".wildarrange", "agent-runs", `rollback-${Date.now()}-${process.pid}.patch`);
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

/**
 * 集成基线或 ownership 围栏失败：任务回 pending，审计入账本后持久化 revalidation_required。
 */
export async function persistAdmissionRevalidation(rootDir, taskState, task, options) {
  const fence = options.fence || {};
  task.status = "pending";
  task.admission_claim = null;
  task.last_failure = {
    at: nowIso(),
    reason: fence.reason || "integration_head_changed",
    summary: fence.reason === "task_ownership_changed"
      ? `remote task ownership changed: ${fence.ownership?.error || "unknown owner fence failure"}`
      : fence.reason === "integration_base_not_present_in_workspace"
        ? `current workspace does not contain guarded integration base ${fence.expectedSha || "missing"}`
        : fence.reason === "workspace_contains_unattributed_changes"
          ? `workspace contains changes not attributed to this run: ${(fence.unattributedPaths || []).join(", ")}`
          : `remote integration branch changed from ${fence.expectedSha || "missing"} to ${fence.actualSha || "missing"}`,
    retryHint: fence.reason === "task_ownership_changed"
      ? "停止旧设备写入；只能由当前远端 owner 重新生成结果并执行 admission"
      : "先获取远端集成分支，把任务成果重新应用到最新主线，再从 verify 开始重跑全部 gates",
  };
  task.updatedAt = nowIso();
  await writeFailureReport(rootDir, taskState.planId, task);
  // 审计先行：revalidation 事件入账本后才提交回退状态（ARC-003）。
  await transactWithLedger(rootDir, {
    type: "parallel_admission_revalidation_required",
    planId: taskState.planId,
    taskId: task.id,
    runId: options.runId,
    expectedSha: fence.expectedSha || null,
    actualSha: fence.actualSha || null,
    reason: fence.reason || null,
  }, () => persistTaskState(rootDir, taskState));
  if (typeof options.removeRollbackPlan === "function") {
    await options.removeRollbackPlan();
  }
  return {
    status: "revalidation_required",
    planId: taskState.planId,
    task,
    acceptanceProof: options.acceptanceProof,
    verifyResult: options.verifyResult,
    scopeResult: options.scopeResult,
    reviewResult: options.reviewResult,
    rollback: options.rollback,
  };
}

/**
 * 集成或 checkpoint 后需人工恢复：保持 verifying，禁止回滚已推送/已本地 commit 的交付。
 */
export async function persistPostIntegrationRecovery(rootDir, taskState, task, options) {
  const localDelivery = options.integrationCommit?.local === true
    || options.integrationCommit?.status === "committed_local";
  task.status = "verifying";
  task.last_failure = {
    at: nowIso(),
    reason: options.checkpointFailed
      ? "checkpoint_failed_after_integration"
      : "post_integration_recovery_required",
    summary: options.summary,
    retryHint: localDelivery
      ? `本地任务分支已经生成 delivery commit；禁止释放或换 run。确认本地任务 worktree 后，用同一 run ${options.runId} 恢复`
      : `远端代码已经集成或曾经集成；禁止回滚、释放或换 run。确认远端历史后，用同一 run ${options.runId} 恢复`,
  };
  task.updatedAt = nowIso();
  await writeFailureReport(rootDir, taskState.planId, task);
  // 审计先行：recovery 事件入账本后才提交 recovery_required 状态（ARC-003），
  // 崩溃窗口不再留下无审计的状态变更。
  await transactWithLedger(rootDir, {
    type: options.checkpointFailed
      ? "checkpoint_write_failed_after_integration"
      : "post_integration_recovery_required",
    planId: taskState.planId,
    taskId: task.id,
    runId: options.runId,
    integrationSha: options.integrationCommit?.integrationSha || null,
    error: options.error || options.integrationCommit?.reason || null,
  }, () => persistTaskState(rootDir, taskState));
  return {
    status: "recovery_required",
    planId: taskState.planId,
    task,
    acceptanceProof: options.acceptanceProof,
    verifyResult: options.verifyResult,
    scopeResult: options.scopeResult,
    reviewResult: options.reviewResult,
    rollback: {
      status: "not_attempted",
      reason: localDelivery ? "local_delivery_already_committed" : "remote_integration_already_pushed",
    },
  };
}
