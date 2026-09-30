// =============================================================================
// 文件名称：task-archive.mjs
// 所属模块：orchestration
// 作用说明：
//   团队任务归档：删前强制写入运行时状态备份，再以「暂存 → 写派生产物 →
//   最后提交权威总账 → 失败整体回滚」的事务归档并删除任务。
//   CLI 与未来调用方共享同一顺序，保证可经 state restore 恢复。
//
// 【运行原理速读】
//   可以把它想成「删任务前的保险快照 + 可回滚的搬家」：
//
//   · 何时执行？
//     CLI `task archive --delete` 调用 archiveTeamTaskWithBackup 时。
//
//   · 做了什么？
//     ① 写 pre-task-archive 备份 ② 收集精确删除集并暂存 ③ 更新 work.json /
//     tasks.md ④ 最后写 team/tasks.json 提交；任一步失败按 preimage 回滚。
//
//   · 缺了它会怎样？
//     归档后无法精确恢复被删状态与证据目录。
// =============================================================================
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import { normalizeRelativePath } from "../infra/path-match.mjs";
import {
  createWorkId,
  nowIso,
  readJson,
  resolveTaskAcceptancePath,
  resolveTaskCheckpointPath,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { loadTaskLedger, replacePlanTasks, resolveLedgerTask } from "../infra/task-state-store.mjs";
import { withTaskStateLock } from "../infra/task-state-lock.mjs";
import {
  prepareArchiveRecoveryPackage,
  updateArchiveRecoveryPackage,
  writeRuntimeStateBackup,
} from "../infra/security.mjs";
import { updateWorkState, writeTasksMarkdown } from "./plan-state.mjs";

/**
 * 归档团队任务：先写运行时备份，再执行归档删除。
 * @param {string} rootDir 项目根目录
 * @param {object} [options] taskId、planId、reason 等
 * @returns {Promise<object>} 归档结果
 */
export async function archiveTeamTaskWithBackup(rootDir, options = {}) {
  const backup = await writeRuntimeStateBackup(rootDir, { reason: `pre-task-archive:${options.taskId}` });
  return archiveAndDeleteTeamTask(rootDir, {
    taskId: options.taskId,
    planId: options.planId,
    reason: options.reason,
    backupId: backup.backupId,
  });
}

/** 归档任务证据并删除总账条目（需 backupId）。 */
export async function archiveAndDeleteTeamTask(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `team-task-archive-delete:${options.taskId || "unknown"}`, async () => {
    const ledger = await loadTaskLedger(rootDir);
    if (!ledger) throw new Error("no task ledger found");
    validateLedgerTaskIdentities(ledger);
    if (options.planId) assertSafeStateId(options.planId, "planId");
    const task = resolveLedgerTask(ledger, options.taskId, options.planId);
    if (!task) throw new Error(`unknown task: ${options.taskId}`);
    assertSafeStateId(task.planId, "task planId");
    assertSafeStateId(task.id, "task id");
    if (["in_progress", "verifying"].includes(task.status)) {
      throw new Error(`task ${task.ref || task.id} is ${task.status}; active work cannot be archived`);
    }
    const reason = typeof options.reason === "string" && options.reason.trim()
      ? options.reason.trim()
      : "user_archived";
    const at = nowIso();
    const remainingTasks = ledger.tasks.filter((candidate) =>
      candidate.planId !== task.planId || candidate.id !== task.id);
    const planTasks = remainingTasks.filter((candidate) => candidate.planId === task.planId);
    const planHasTasks = planTasks.length > 0;
    // Removing the final task from the active Plan must fail closed. Another
    // Plan remains indexed, but only an explicit plan import/selection may
    // activate it and establish a fresh approval state.
    const activePlanId = ledger.activePlanId === task.planId && !planHasTasks
      ? null
      : ledger.activePlanId;
    const nextLedger = planHasTasks
      ? replacePlanTasks(ledger, { id: task.planId }, planTasks, { at })
      : { ...ledger, plans: ledger.plans.filter((plan) => plan.id !== task.planId), tasks: remainingTasks, updatedAt: at };
    nextLedger.planId = activePlanId;
    nextLedger.activePlanId = activePlanId;
    const workPath = resolveWildArrangePath(rootDir, "work.json");

    const purgeCandidates = [
      resolveTaskCheckpointPath(rootDir, task.planId, task.id),
      resolveTaskAcceptancePath(rootDir, task.planId, task.id, "json"),
      resolveTaskAcceptancePath(rootDir, task.planId, task.id, "md"),
    ];
    const outboxDir = resolveWildArrangePath(rootDir, "team", "outbox");
    try {
      const outboxEntries = await readdir(outboxDir, { withFileTypes: true });
      for (const entry of outboxEntries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const claimPath = path.join(outboxDir, entry.name);
        const claim = await readJson(claimPath, null);
        if (claim?.taskRef === task.ref) purgeCandidates.push(claimPath);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (!planHasTasks) purgeCandidates.push(resolveWildArrangePath(rootDir, "plans", `${task.planId}.json`));
    for (const writablePath of task.writable_paths || []) {
      if (typeof writablePath !== "string" || /[*?\[\]]/.test(writablePath)) continue;
      const sharedByRemainingTask = remainingTasks.some((candidate) =>
        (candidate.writable_paths || []).includes(writablePath));
      if (sharedByRemainingTask) continue;
      const absolutePath = path.resolve(rootDir, writablePath);
      const artifactsRoot = `${resolveWildArrangePath(rootDir, "artifacts")}${path.sep}`;
      if (absolutePath.startsWith(artifactsRoot)) purgeCandidates.push(absolutePath);
    }

    // tasks.md 是派生视图：按剩余总账内容重新渲染 active 计划。
    const activeEntry = activePlanId ? nextLedger.plans.find((plan) => plan.id === activePlanId) : null;
    const activePlanForMarkdown = activePlanId
      ? {
        title: activeEntry?.title ?? activePlanId,
        objective: activeEntry?.objective ?? "",
        tasks: remainingTasks.filter((candidate) => candidate.planId === activePlanId),
      }
      : null;

    const canonicalPath = resolveWildArrangePath(rootDir, "team", "tasks.json");
    const tasksMarkdownPath = resolveWildArrangePath(rootDir, "team", "tasks.md");
    const transactionId = createWorkId("archive");
    const recovery = await prepareArchiveRecoveryPackage(rootDir, {
      backupId: options.backupId || null,
      transactionId,
      taskRef: task.ref,
      reason: `pre-task-archive:${task.ref}`,
      paths: [
        canonicalPath,
        tasksMarkdownPath,
        workPath,
        ...purgeCandidates,
      ],
    });
    const backupId = recovery.backupId;

    await appendLedger(rootDir, {
      type: "team_task_archive_requested",
      planId: task.planId,
      taskId: task.id,
      taskRef: task.ref,
      subject: task.subject,
      previousStatus: task.status,
      reason,
      backupId,
    });

    const preimages = new Map();
    for (const projectionPath of [canonicalPath, tasksMarkdownPath, workPath]) {
      preimages.set(projectionPath, await captureFilePreimage(projectionPath));
    }

    const stagingRoot = resolveWildArrangePath(rootDir, "archive-staging", transactionId);
    const staged = [];
    const deleted = [];
    try {
      await mkdir(stagingRoot, { recursive: true });
      const candidates = collapseNestedPaths(purgeCandidates);
      for (const [index, filePath] of candidates.entries()) {
        const stagedPath = path.join(stagingRoot, `${index}-${path.basename(filePath)}`);
        try {
          await rename(filePath, stagedPath);
          staged.push({ originalPath: filePath, stagedPath });
          deleted.push(normalizeRelativePath(path.relative(rootDir, filePath)));
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }

      await updateWorkState(rootDir, (work) => ({
        ...work,
        activePlanId,
        status: activePlanId ? work.status : "idle",
        stage: activePlanId ? work.stage : "initialized",
        planApproval: !activePlanId || work.planApproval?.planId === task.planId && !planHasTasks
          ? null
          : work.planApproval,
      }), { createIfMissing: false });
      if (activePlanForMarkdown) {
        await writeTasksMarkdown(rootDir, activePlanForMarkdown);
      } else {
        await writeFile(tasksMarkdownPath, "# WildArrange Tasks\n\nNo active tasks.\n", "utf8");
      }
      // Canonical authority is committed last. Any preceding mirror or purge
      // failure therefore leaves the task visible; later audit failure rolls
      // all projections and staged paths back to their captured preimages.
      await writeJsonAtomic(canonicalPath, nextLedger);

      await updateArchiveRecoveryPackage(rootDir, {
        backupId,
        transactionId,
        status: "committed",
      });
      await appendLedger(rootDir, {
        type: "team_task_archived_deleted",
        planId: task.planId,
        taskId: task.id,
        taskRef: task.ref,
        subject: task.subject,
        previousStatus: task.status,
        reason,
        backupId,
        deletedPaths: deleted,
      });
    } catch (error) {
      const recoveryErrors = [];
      for (const [projectionPath, preimage] of [...preimages.entries()].reverse()) {
        try {
          await restoreFilePreimage(projectionPath, preimage);
        } catch (recoveryError) {
          recoveryErrors.push(`${path.relative(rootDir, projectionPath)}: ${recoveryError.message}`);
        }
      }
      for (const entry of [...staged].reverse()) {
        try {
          await mkdir(path.dirname(entry.originalPath), { recursive: true });
          await rename(entry.stagedPath, entry.originalPath);
        } catch (recoveryError) {
          recoveryErrors.push(`${path.relative(rootDir, entry.originalPath)}: ${recoveryError.message}`);
        }
      }
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      await updateArchiveRecoveryPackage(rootDir, {
        backupId,
        transactionId,
        status: recoveryErrors.length > 0 ? "recovery_required" : "rolled_back",
        diagnostic: error.message,
      }).catch(() => {});
      if (recoveryErrors.length > 0) {
        throw new Error(`archive transaction failed: ${error.message}; recovery_required: ${recoveryErrors.join("; ")}`);
      }
      throw error;
    }
    // Cleanup happens after the authoritative commit and audit. A cleanup
    // failure leaves only a recoverable internal staging directory and must
    // not turn a successful archive into an ambiguous command failure.
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    return {
      kind: "team_task_archive_delete",
      status: "deleted",
      taskRef: task.ref,
      previousStatus: task.status,
      backupId,
      activePlanId,
      deletedPaths: deleted,
    };
  });
}

/** 断言 state ID segment 安全可用于路径。 */
function assertSafeStateId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error(`${label} must be a safe single-segment identifier`);
  }
}

/** 校验 ledger 内任务 identity 字段完整。 */
function validateLedgerTaskIdentities(ledger) {
  const pairs = new Set();
  const refs = new Set();
  for (const task of ledger.tasks || []) {
    assertSafeStateId(task.planId, "task planId");
    assertSafeStateId(task.id, "task id");
    const expectedRef = `${task.planId}:${task.id}`;
    if (task.ref !== expectedRef) {
      throw new Error(`invalid canonical task identity: expected ${expectedRef}, got ${task.ref || "missing ref"}`);
    }
    if (pairs.has(expectedRef) || refs.has(task.ref)) {
      throw new Error(`duplicate canonical task identity: ${expectedRef}`);
    }
    pairs.add(expectedRef);
    refs.add(task.ref);
  }
}

/** 折叠路径列表中的父子重复项。 */
function collapseNestedPaths(paths) {
  const normalized = [...new Set(paths.map((candidate) => path.resolve(candidate)))]
    .sort((left, right) => left.length - right.length);
  return normalized.filter((candidate, index) => !normalized.slice(0, index).some((parent) =>
    candidate.startsWith(`${parent}${path.sep}`)));
}

/** 捕获单文件回滚用 preimage。 */
async function captureFilePreimage(filePath) {
  try {
    return { exists: true, content: await readFile(filePath) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, content: null };
    throw error;
  }
}

/** 按 preimage 还原单文件内容或删除新建文件。 */
async function restoreFilePreimage(filePath, preimage) {
  if (!preimage.exists) {
    await rm(filePath, { recursive: true, force: true });
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, preimage.content);
}
