// =============================================================================
// 文件名称：integration.mjs
// 所属模块：orchestration
// 作用说明：
//   Git 交付集成：integration intent、候选路径收集与 task branch
//   delivery commit 生成/普通 push。
//
// 【运行原理速读】
//   可以把它想成「把任务成果安全写进 Git 历史」：
//
//   · 何时执行？
//     delivery-pipeline 的 runCompletionSegment 与 admission 前置复核。
//
//   · 做了什么？
//     验基线 → 写 intent → commit/push task branch → 绑定 integrationSha。
//
//   · 约束？
//     push 成功后故障不得回滚；intent 是 checkpoint 前 durable 交付意图来源；只做普通非强制 push。
// =============================================================================
import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import {
  nowIso,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import {
  commitIsAncestor,
  createTaskDeliveryCommit,
  createTaskCheckpointCommit,
  fetchRemoteBranch,
  listTreeChanges,
  listWorkingTreeChanges,
  pushCommit,
  pushTaskDeliveryCommit,
  remoteBranchHead,
  synchronizeTaskWorktreeToDelivery,
} from "../infra/git-coordination.mjs";
import { readVerifiedLedgerEntries } from "../infra/ledger.mjs";

// --- 围栏与 intent ---

/** 断言无其他任务持有未恢复的 admission 工作区（contract 改动或回滚失败），避免新 Worker 与脏工作区并存。 */
export function assertAdmissionWorkspaceAvailable(tasks, resume = {}) {
  const held = tasks.find((task) => task.admission_claim
    && (task.pendingContractChange || task.last_failure?.reason === "admission_rollback_failed")
    && task.admission_claim.workspaceRestored !== true
    && !(task.id === resume.taskId && task.admission_claim.runId === resume.runId));
  // §3.4：contract 改动未恢复或 admission 回滚失败时禁止其它 workspace 写与新 Worker，须先 resume 原 admission run。
  if (held) throw new Error(`recovery_required: task ${held.id} has unrestored admission changes; resume admission run ${held.admission_claim.runId} before other workspace writes`);
}

/** 读取 run/task 的 integration intent 持久化记录。 */
export async function readIntegrationIntent(rootDir, runId, taskId) {
  return readJson(integrationIntentPath(rootDir, runId, taskId), null);
}

/** 收集相对 baseSha 的工作区与已提交变更路径。 */
export async function collectIntegrationCandidatePaths(rootDir, baseSha) {
  const [workingPaths, committedPaths] = await Promise.all([
    listWorkingTreeChanges(rootDir),
    listTreeChanges(rootDir, baseSha, "HEAD"),
  ]);
  return [...new Set([...workingPaths, ...committedPaths])].sort();
}

// --- delivery commit ---

/**
 * 生成 delivery commit；配置了远端时再普通 push 到任务独占 task branch，
 * 无远端时只做本地 commit。
 */
export async function integrateAdmissionCommit(rootDir, options) {
  const coordination = options.task?.coordination;
  const deliveryTarget = coordination?.localGit === true && coordination.branch && coordination.baseSha
    ? {
        remote: coordination.remote || null,
        branch: coordination.branch,
        expectedSha: coordination.baseSha,
      }
    : null;
  if (!deliveryTarget) {
    if (!coordination || coordination.status === "degraded") {
      return {
        pass: true,
        active: false,
        pushed: false,
        status: "local_degraded",
        reason: coordination?.reason || "task branch metadata is unavailable",
        commitSha: null,
        integrationSha: null,
      };
    }
    return {
      pass: false,
      active: false,
      pushed: false,
      reason: "task_branch_delivery_unavailable",
      error: "a task branch with a base commit is required before admission can complete",
    };
  }
  if (!deliveryTarget.remote) {
    return integrateLocalAdmissionCommit(rootDir, options, deliveryTarget);
  }
  const intentPath = integrationIntentPath(rootDir, options.runId, options.taskId);
  let intent = await readJson(intentPath, null);
  if (intent && (intent.runId !== options.runId
    || intent.taskId !== options.taskId)) {
    return {
      pass: false,
      active: true,
      pushed: false,
      reason: "integration_intent_mismatch",
      expectedSha: deliveryTarget.expectedSha,
      actualSha: await remoteBranchHead(rootDir, deliveryTarget.remote, deliveryTarget.branch),
    };
  }
  const durablePushRisk = ["pushed", "push_outcome_unknown"].includes(intent?.status);
  if (!intent) {
    const message = renderDeliveryCommitMessage(options);
    let integrationSha;
    if (options.deliveryWorktreeDir && options.deliveryFromWorktree) {
      const deliveryCommit = await createTaskDeliveryCommit(options.deliveryWorktreeDir, {
        expectedHead: deliveryTarget.expectedSha,
        expectedBranch: deliveryTarget.branch,
        changedPaths: options.changedPaths || [],
        message,
      });
      if (deliveryCommit.pass !== true) {
        return {
          ...deliveryCommit,
          active: true,
          pushed: false,
          remote: deliveryTarget.remote,
        };
      }
      integrationSha = deliveryCommit.commitSha;
    } else {
      integrationSha = await createTaskCheckpointCommit(rootDir, {
        parentSha: deliveryTarget.expectedSha,
        changedPaths: options.changedPaths || [],
        message,
      });
    }
    intent = {
      kind: "task_delivery_intent",
      version: 1,
      status: "prepared",
      planId: options.planId,
      taskId: options.taskId,
      runId: options.runId,
      remote: deliveryTarget.remote,
      branch: deliveryTarget.branch,
      expectedSha: deliveryTarget.expectedSha,
      integrationSha,
      changedPaths: options.changedPaths || [],
      preparedAt: nowIso(),
    };
    await writeJsonAtomic(intentPath, intent);
  }

  if (durablePushRisk) {
    // 已 push（或结果未知）的 intent 必须先读回远端；远端不可达时保留 intent，禁止回滚或重推。
    const readBack = await inspectRemoteCommitContainment(rootDir, intent.remote, intent.branch, intent.integrationSha);
    if (readBack.error) {
      return {
        pass: false,
        active: true,
        pushed: true,
        pushOutcome: intent.pushOutcome || (intent.status === "pushed" ? "confirmed" : null),
        reason: intent.status === "push_outcome_unknown"
          ? "integration_push_outcome_unknown"
          : "delivered_commit_not_on_remote_task_branch",
        expectedSha: intent.expectedSha,
        actualSha: null,
        integrationSha: intent.integrationSha,
        containmentError: readBack.error,
      };
    }
  }

  let actualSha = await remoteBranchHead(rootDir, intent.remote, intent.branch);
  const remoteContainsIntegration = actualSha === intent.integrationSha
    || (actualSha ? await commitIsAncestor(rootDir, intent.integrationSha, actualSha) : false);
  if (durablePushRisk && !remoteContainsIntegration) {
    return {
      pass: false,
      active: true,
      pushed: durablePushRisk,
      pushOutcome: intent.pushOutcome || "confirmed",
      reason: intent.status === "push_outcome_unknown"
        ? "integration_push_outcome_unknown"
        : "integrated_commit_not_on_remote_branch",
      expectedSha: intent.expectedSha,
      actualSha,
      integrationSha: intent.integrationSha,
    };
  }
  // 远端 task branch 尚不存在（首次 push）或仍停在基线是正常起点；
  // 出现其他内容说明该分支已被别的写入占用，拒绝覆盖。
  if (actualSha && actualSha !== intent.expectedSha && !remoteContainsIntegration) {
    return {
      pass: false,
      active: true,
      pushed: durablePushRisk,
      reason: durablePushRisk
        ? "integrated_commit_not_on_remote_branch"
        : "task_branch_remote_occupied",
      expectedSha: intent.expectedSha,
      actualSha,
      integrationSha: intent.integrationSha,
    };
  }
  const reconciled = remoteContainsIntegration;
  let pushReconciled = reconciled;
  if (!reconciled) {
    const pushCommitFn = options.pushCommitFn || (options.deliveryWorktreeDir
      ? async (_rootDir, pushOptions) => {
          const pushed = await pushTaskDeliveryCommit(options.deliveryWorktreeDir, pushOptions);
          return {
            ok: pushed.pass,
            exitCode: pushed.pass ? 0 : 1,
            stdout: "",
            stderr: pushed.error || "",
          };
        }
      : pushCommit);
    const pushed = await pushCommitFn(rootDir, {
      remote: intent.remote,
      branch: intent.branch,
      commitSha: intent.integrationSha,
    });
    if (!pushed.ok) {
      // A transport failure can arrive after the remote accepted the push.
      // Read back before declaring failure; otherwise admission could roll
      // back a change that is already durable on remote main.
      const remoteAfterFailure = await inspectRemoteCommitContainment(
        rootDir,
        intent.remote,
        intent.branch,
        intent.integrationSha,
      );
      if (remoteAfterFailure.contains) {
        pushReconciled = true;
      } else if (remoteAfterFailure.error) {
        const uncertain = {
          ...intent,
          status: "push_outcome_unknown",
          pushed: true,
          pushOutcome: "unknown",
          actualSha: remoteAfterFailure.actualSha,
          pushError: pushed.stderr || pushed.stdout,
          containmentError: remoteAfterFailure.error,
          updatedAt: nowIso(),
        };
        await writeJsonAtomic(intentPath, uncertain);
        const ledgerEntries = await readVerifiedLedgerEntries(rootDir);
        if (!ledgerEntries.some((entry) => entry.type === "task_integration_push_uncertain"
          && entry.runId === options.runId
          && entry.taskId === options.taskId
          && entry.integrationSha === intent.integrationSha)) {
          await appendLedger(rootDir, {
            type: "task_integration_push_uncertain",
            planId: options.planId,
            taskId: options.taskId,
            runId: options.runId,
            expectedSha: intent.expectedSha,
            integrationSha: intent.integrationSha,
            error: uncertain.pushError,
            containmentError: uncertain.containmentError,
          });
        }
        return {
          pass: false,
          active: true,
          // The transport failed after a push attempt and read-back could
          // §3.4：push 结果未知时保留 intent，禁止回滚可能已在远端的 commit。
          pushed: true,
          pushOutcome: "unknown",
          reason: "integration_push_outcome_unknown",
          expectedSha: intent.expectedSha,
          actualSha: remoteAfterFailure.actualSha,
          integrationSha: intent.integrationSha,
          intentPath: path.relative(rootDir, intentPath),
          containmentError: remoteAfterFailure.error,
          error: pushed.stderr || pushed.stdout,
        };
      } else {
        return {
          pass: false,
          active: true,
          pushed: false,
          reason: "integration_push_rejected",
          expectedSha: intent.expectedSha,
          actualSha: remoteAfterFailure.actualSha,
          integrationSha: intent.integrationSha,
          containmentError: remoteAfterFailure.error || null,
          error: pushed.stderr || pushed.stdout,
        };
      }
    }
  }
  // The pre-push fence SHA is no longer the authoritative remote head after a
  // successful push. Read it back so both the durable intent and admission
  // receipt identify the version that is actually visible on the remote.
  const finalRemote = await inspectRemoteCommitContainment(
    rootDir,
    intent.remote,
    intent.branch,
    intent.integrationSha,
  );
  actualSha = finalRemote.actualSha;
  const finalRemoteContainsIntegration = finalRemote.contains;
  let worktreeSync = null;
  if (finalRemoteContainsIntegration && options.deliveryWorktreeDir) {
    worktreeSync = await synchronizeTaskWorktreeToDelivery(options.deliveryWorktreeDir, {
      expectedHead: intent.expectedSha,
      expectedBranch: intent.branch,
      commitSha: intent.integrationSha,
    });
    if (worktreeSync.pass !== true) {
      return {
        pass: false,
        active: true,
        pushed: true,
        reconciled: pushReconciled,
        reason: worktreeSync.reason,
        remote: intent.remote,
        branch: intent.branch,
        expectedSha: intent.expectedSha,
        actualSha,
        integrationSha: intent.integrationSha,
        worktreeSync,
        intentPath: path.relative(rootDir, intentPath),
      };
    }
  }
  const completed = {
    ...intent,
    status: "pushed",
    pushed: true,
    reconciled: pushReconciled,
    actualSha,
    worktreeSync,
    pushedAt: intent.pushedAt || nowIso(),
  };
  await writeJsonAtomic(intentPath, completed);
  const ledgerEntries = await readVerifiedLedgerEntries(rootDir);
  if (!ledgerEntries.some((entry) => entry.type === "task_integration_pushed"
    && entry.runId === options.runId
    && entry.taskId === options.taskId
    && entry.integrationSha === intent.integrationSha)) {
    await appendLedger(rootDir, {
      type: "task_integration_pushed",
      planId: options.planId,
      taskId: options.taskId,
      runId: options.runId,
      expectedSha: intent.expectedSha,
      integrationSha: intent.integrationSha,
      actualSha,
      reconciled: pushReconciled,
    });
  }
  if (!finalRemoteContainsIntegration) {
    return {
      pass: false,
      active: true,
      pushed: true,
      reconciled: pushReconciled,
      reason: "integrated_commit_not_on_remote_branch",
      remote: intent.remote,
      branch: intent.branch,
      expectedSha: intent.expectedSha,
      actualSha,
      integrationSha: intent.integrationSha,
      intentPath: path.relative(rootDir, intentPath),
    };
  }
  return {
    pass: true,
    active: true,
    pushed: true,
    reconciled: pushReconciled,
    remote: intent.remote,
    branch: intent.branch,
    expectedSha: intent.expectedSha,
    actualSha,
    integrationSha: intent.integrationSha,
    worktreeSync,
    intentPath: path.relative(rootDir, intentPath),
  };
}

/** 无 remote 时在本地 task worktree 生成本地 delivery commit。 */
async function integrateLocalAdmissionCommit(rootDir, options, deliveryTarget) {
  if (!options.deliveryWorktreeDir) {
    return {
      pass: false,
      active: true,
      local: true,
      pushed: false,
      reason: "local_task_worktree_unavailable",
      error: "a branch-bound task worktree is required for local Git delivery",
    };
  }

  const intentPath = integrationIntentPath(rootDir, options.runId, options.taskId);
  let intent = await readJson(intentPath, null);
  if (intent && (intent.runId !== options.runId
    || intent.taskId !== options.taskId
    || intent.branch !== deliveryTarget.branch
    || intent.expectedSha !== deliveryTarget.expectedSha)) {
    return {
      pass: false,
      active: true,
      local: true,
      pushed: false,
      reason: "integration_intent_mismatch",
      expectedSha: deliveryTarget.expectedSha,
      actualSha: intent.integrationSha || null,
    };
  }

  if (!intent) {
    const message = renderDeliveryCommitMessage(options);
    let integrationSha;
    if (options.deliveryFromWorktree) {
      const deliveryCommit = await createTaskDeliveryCommit(options.deliveryWorktreeDir, {
        expectedHead: deliveryTarget.expectedSha,
        expectedBranch: deliveryTarget.branch,
        changedPaths: options.changedPaths || [],
        message,
      });
      if (deliveryCommit.pass !== true) {
        return {
          ...deliveryCommit,
          active: true,
          local: true,
          pushed: false,
        };
      }
      integrationSha = deliveryCommit.commitSha;
    } else {
      integrationSha = await createTaskCheckpointCommit(rootDir, {
        parentSha: deliveryTarget.expectedSha,
        changedPaths: options.changedPaths || [],
        message,
      });
    }
    intent = {
      kind: "task_delivery_intent",
      version: 1,
      status: "prepared_local",
      planId: options.planId,
      taskId: options.taskId,
      runId: options.runId,
      remote: null,
      branch: deliveryTarget.branch,
      expectedSha: deliveryTarget.expectedSha,
      integrationSha,
      changedPaths: options.changedPaths || [],
      preparedAt: nowIso(),
    };
    await writeJsonAtomic(intentPath, intent);
  }

  const worktreeSync = await synchronizeTaskWorktreeToDelivery(options.deliveryWorktreeDir, {
    expectedHead: intent.expectedSha,
    expectedBranch: intent.branch,
    commitSha: intent.integrationSha,
  });
  if (worktreeSync.pass !== true) {
    return {
      pass: false,
      active: true,
      local: true,
      pushed: false,
      status: "recovery_required",
      reason: worktreeSync.reason,
      branch: intent.branch,
      expectedSha: intent.expectedSha,
      actualSha: worktreeSync.commitSha || null,
      integrationSha: intent.integrationSha,
      worktreeSync,
      intentPath: path.relative(rootDir, intentPath),
    };
  }

  const completed = {
    ...intent,
    status: "committed_local",
    local: true,
    pushed: false,
    actualSha: intent.integrationSha,
    worktreeSync,
    committedAt: intent.committedAt || nowIso(),
    noChange: (intent.changedPaths || []).length === 0,
  };
  await writeJsonAtomic(intentPath, completed);
  const ledgerEntries = await readVerifiedLedgerEntries(rootDir);
  if (!ledgerEntries.some((entry) => entry.type === "task_delivery_committed_local"
    && entry.runId === options.runId
    && entry.taskId === options.taskId
    && entry.integrationSha === intent.integrationSha)) {
    await appendLedger(rootDir, {
      type: "task_delivery_committed_local",
      planId: options.planId,
      taskId: options.taskId,
      runId: options.runId,
      expectedSha: intent.expectedSha,
      integrationSha: intent.integrationSha,
      branch: intent.branch,
    });
  }
  return {
    pass: true,
    active: true,
    local: true,
    pushed: false,
    status: completed.noChange ? "no_change" : "committed_local",
    branch: intent.branch,
    expectedSha: intent.expectedSha,
    actualSha: intent.integrationSha,
    integrationSha: intent.integrationSha,
    noChange: completed.noChange,
    worktreeSync,
    intentPath: path.relative(rootDir, intentPath),
  };
}

/** 渲染 delivery commit message：只带计划/任务/run 标识，不含设备或 owner 信息。 */
function renderDeliveryCommitMessage(options) {
  return [
    `wildarrange: deliver ${options.planId}/${options.taskId}`,
    "",
    `WildArrange-Task: ${options.planId}/${options.taskId}`,
    `WildArrange-Run: ${options.runId}`,
  ].join("\n");
}

/** 检查远端 branch 是否包含指定 integration commit。 */
async function inspectRemoteCommitContainment(rootDir, remote, branch, commitSha) {
  try {
    const advertisedSha = await remoteBranchHead(rootDir, remote, branch);
    if (!advertisedSha) return { actualSha: null, contains: false, error: null };
    if (advertisedSha === commitSha) {
      return { actualSha: advertisedSha, contains: true, error: null };
    }
    // ls-remote only reports an object ID; it does not put that object in the
    // local object database. Fetch before merge-base so a newly-added remote
    // descendant can be proven to contain our integration commit.
    const fetchedSha = await fetchRemoteBranch(rootDir, remote, branch);
    return {
      actualSha: fetchedSha,
      contains: await commitIsAncestor(rootDir, commitSha, fetchedSha),
      error: null,
    };
  } catch (error) {
    return {
      actualSha: null,
      contains: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** 返回 run/task integration intent JSON 路径。 */
function integrationIntentPath(rootDir, runId, taskId) {
  return resolveWildArrangePath(
    rootDir,
    "agent-runs",
    runId,
    `${String(taskId).replace(/[^A-Za-z0-9._-]/g, "_")}.integration.json`,
  );
}
