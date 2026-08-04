import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import {
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import {
  commitIsAncestor,
  createTaskCheckpointCommit,
  ensureDeviceIdentity,
  fetchRemoteBranch,
  listTreeChanges,
  listWorkingTreeChanges,
  pushCommit,
  remoteBranchHead,
  verifyIntegrationGuard,
} from "../infra/git-coordination.mjs";
import { readVerifiedLedgerEntries } from "../infra/ledger.mjs";
import { loadTaskState } from "./plan-state.mjs";
import {
  assertCurrentTaskOwnership,
  buildCoordinationPacket,
  renderCoordinationCommitMessage,
  taskContract,
} from "./remote-ownership.mjs";

export async function readIntegrationIntent(rootDir, runId, taskId) {
  return readJson(integrationIntentPath(rootDir, runId, taskId), null);
}

export async function collectIntegrationCandidatePaths(rootDir, baseSha) {
  const [workingPaths, committedPaths] = await Promise.all([
    listWorkingTreeChanges(rootDir),
    listTreeChanges(rootDir, baseSha, "HEAD"),
  ]);
  return [...new Set([...workingPaths, ...committedPaths])]
    .filter((filePath) => filePath !== ".helix" && !filePath.startsWith(".helix/"))
    .sort();
}

export async function verifyAdmissionFences(rootDir, taskId, integrationGuard, recoveryIntent = null) {
  const state = await loadTaskState(rootDir);
  const task = state?.tasks.find((candidate) => candidate.id === taskId);
  let ownership;
  try {
    ownership = await assertCurrentTaskOwnership(rootDir, task);
  } catch (error) {
    return {
      pass: false,
      reason: "task_ownership_changed",
      ownership: { pass: false, error: error instanceof Error ? error.message : String(error) },
      integration: null,
      expectedSha: integrationGuard?.expectedSha || null,
      actualSha: null,
    };
  }
  const integration = await verifyIntegrationGuard(rootDir, integrationGuard);
  const remoteContainsPriorIntegration = integration.pass === true
    && recoveryIntent?.integrationSha
    && integrationGuard?.expectedSha
    ? await commitIsAncestor(rootDir, recoveryIntent.integrationSha, integrationGuard.expectedSha)
    : false;
  const workspaceBaseSha = recoveryIntent
    && (recoveryIntent.integrationSha === integrationGuard?.expectedSha || remoteContainsPriorIntegration)
    ? recoveryIntent.expectedSha
    : integrationGuard?.expectedSha;
  const workspaceContainsExpected = integration.pass === true && integrationGuard?.active
    ? await commitIsAncestor(rootDir, workspaceBaseSha, "HEAD")
    : true;
  return {
    pass: ownership.pass === true && integration.pass === true && workspaceContainsExpected,
    reason: integration.pass !== true
      ? "integration_head_changed"
      : workspaceContainsExpected
        ? null
        : "integration_base_not_present_in_workspace",
    ownership,
    integration,
    remoteContainsPriorIntegration,
    workspaceContainsExpected,
    expectedSha: integration.expectedSha || null,
    actualSha: integration.actualSha || null,
  };
}

export async function integrateAdmissionCommit(rootDir, options) {
  if (!options.integrationGuard?.active) {
    return { pass: true, active: false, pushed: false, reason: options.integrationGuard?.reason || null };
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
      expectedSha: options.integrationGuard.expectedSha,
      actualSha: await remoteBranchHead(rootDir, options.integrationGuard.remote, options.integrationGuard.branch),
    };
  }
  const fences = await verifyAdmissionFences(rootDir, options.taskId, options.integrationGuard, intent);
  const durablePushRisk = ["pushed", "push_outcome_unknown"].includes(intent?.status);
  if (!fences.pass) {
    return {
      ...fences,
      active: true,
      pushed: durablePushRisk,
      pushOutcome: intent?.pushOutcome || (intent?.status === "pushed" ? "confirmed" : null),
      reason: intent?.status === "push_outcome_unknown"
        ? "integration_push_outcome_unknown"
        : fences.reason,
      fenceReason: fences.reason,
    };
  }
  if (!intent) {
    const device = await ensureDeviceIdentity(rootDir);
    const packet = buildCoordinationPacket("task_integration", {
      planId: options.planId,
      task: taskContract(options.task),
      runId: options.runId,
      device,
      taskBranch: options.task.coordination?.branch || null,
      taskRemoteHeadSha: options.task.coordination?.remoteHeadSha || null,
      integrationBranch: options.integrationGuard.branch,
      expectedMainSha: options.integrationGuard.expectedSha,
      changedPaths: options.changedPaths || [],
    });
    const integrationSha = await createTaskCheckpointCommit(rootDir, {
      parentSha: options.integrationGuard.expectedSha,
      changedPaths: options.changedPaths || [],
      message: renderCoordinationCommitMessage(`integrate ${options.planId}/${options.taskId}`, packet),
    });
    intent = {
      kind: "task_integration_intent",
      version: 1,
      status: "prepared",
      planId: options.planId,
      taskId: options.taskId,
      runId: options.runId,
      remote: options.integrationGuard.remote,
      branch: options.integrationGuard.branch,
      expectedSha: options.integrationGuard.expectedSha,
      integrationSha,
      changedPaths: options.changedPaths || [],
      preparedAt: nowIso(),
    };
    await writeJsonAtomic(intentPath, intent);
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
  if (actualSha !== intent.expectedSha && !remoteContainsIntegration) {
    return {
      pass: false,
      active: true,
      pushed: durablePushRisk,
      reason: durablePushRisk
        ? "integrated_commit_not_on_remote_branch"
        : "integration_head_changed",
      expectedSha: intent.expectedSha,
      actualSha,
      integrationSha: intent.integrationSha,
    };
  }
  const reconciled = remoteContainsIntegration;
  let pushReconciled = reconciled;
  if (!reconciled) {
    const pushCommitFn = options.pushCommitFn || pushCommit;
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
          // not prove either outcome. Preserve the workspace and ownership;
          // rolling back here could contradict an accepted remote commit.
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
  const completed = {
    ...intent,
    status: "pushed",
    pushed: true,
    reconciled: pushReconciled,
    actualSha,
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
    intentPath: path.relative(rootDir, intentPath),
  };
}

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

function integrationIntentPath(rootDir, runId, taskId) {
  return resolveHelixPath(
    rootDir,
    "agent-runs",
    runId,
    `${String(taskId).replace(/[^A-Za-z0-9._-]/g, "_")}.integration.json`,
  );
}
