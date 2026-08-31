import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import { runCommandFile } from "../infra/command-runner.mjs";
import { assertPathInsideRoot } from "../infra/path-match.mjs";
import {
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { writeFailureReport } from "../infra/task-reports.mjs";
import { persistTaskState } from "./task-board.mjs";

function rollbackPlanPath(rootDir, runId, taskId) {
  return resolveHelixPath(rootDir, "agent-runs", runId, `${taskId}.rollback-plan.json`);
}

export async function persistRollbackPlan(rootDir, runId, taskId, rollbackPlan) {
  await writeJsonAtomic(rollbackPlanPath(rootDir, runId, taskId), {
    runId,
    taskId,
    persistedAt: nowIso(),
    plan: rollbackPlan,
  });
}

export async function loadPersistedRollbackPlan(rootDir, runId, taskId) {
  const stored = await readJson(rollbackPlanPath(rootDir, runId, taskId), null);
  return stored?.plan || null;
}

export async function removePersistedRollbackPlan(rootDir, runId, taskId) {
  await rm(rollbackPlanPath(rootDir, runId, taskId), { force: true }).catch(() => {});
}

export async function patchAlreadyApplied(rootDir, patch) {
  const patchPath = path.join(rootDir, ".helix", "agent-runs", `recheck-${Date.now()}-${process.pid}.patch`);
  await writeFile(patchPath, patch, "utf8");
  try {
    const reverseCheck = await runCommandFile("git", ["-C", rootDir, "apply", "--reverse", "--check", "--whitespace=nowarn", patchPath], rootDir, 30_000);
    return reverseCheck.exitCode === 0;
  } finally {
    await rm(patchPath, { force: true });
  }
}

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
      if (error?.code !== "ENOENT") throw error;
      entries.push({ path: file.path, existed: false, content: "" });
    }
  }
  return { mode: "files", paths: files.map((file) => file.path), entries };
}

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
          await rm(absolutePath, { force: true });
        }
      }
    } else if (rollbackPlan.mode === "patch") {
      const patchPath = path.join(rootDir, ".helix", "agent-runs", `rollback-${Date.now()}-${process.pid}.patch`);
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
  await appendLedger(rootDir, {
    type: "parallel_admission_revalidation_required",
    planId: taskState.planId,
    taskId: task.id,
    runId: options.runId,
    expectedSha: fence.expectedSha || null,
    actualSha: fence.actualSha || null,
    reason: fence.reason || null,
  });
  await persistTaskState(rootDir, taskState);
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

export async function persistPostIntegrationRecovery(rootDir, taskState, task, options) {
  task.status = "verifying";
  task.last_failure = {
    at: nowIso(),
    reason: options.checkpointFailed
      ? "checkpoint_failed_after_integration"
      : "post_integration_recovery_required",
    summary: options.summary,
    retryHint: `远端代码已经集成或曾经集成；禁止回滚、释放或换 run。确认远端历史后，用同一 run ${options.runId} 恢复`,
  };
  task.updatedAt = nowIso();
  await writeFailureReport(rootDir, taskState.planId, task);
  await persistTaskState(rootDir, taskState);
  await appendLedger(rootDir, {
    type: options.checkpointFailed
      ? "checkpoint_write_failed_after_integration"
      : "post_integration_recovery_required",
    planId: taskState.planId,
    taskId: task.id,
    runId: options.runId,
    integrationSha: options.integrationCommit?.integrationSha || null,
    error: options.error || options.integrationCommit?.reason || null,
  });
  return {
    status: "recovery_required",
    planId: taskState.planId,
    task,
    acceptanceProof: options.acceptanceProof,
    verifyResult: options.verifyResult,
    scopeResult: options.scopeResult,
    reviewResult: options.reviewResult,
    rollback: { status: "not_attempted", reason: "remote_integration_already_pushed" },
  };
}
