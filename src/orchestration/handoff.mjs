import path from "node:path";
import { appendLedger } from "../infra/ledger.mjs";
import {
  ensureHelixDirs,
  nowIso,
  readJson,
  resolveHelixPath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { loadHelixConfig } from "../infra/runtime-config.mjs";
import { withTaskStateLock } from "../infra/task-state-lock.mjs";
import {
  assertCleanWorkingTree,
  createMetadataCommit,
  createTaskCheckpointCommit,
  ensureDeviceIdentity,
  fetchRemoteBranch,
  gitTree,
  inspectGitCoordination,
  listWorkingTreeChanges,
  listTreeChanges,
  pushCommit,
  readCommitMessage,
  remoteBranchHead,
  switchToTaskBranch,
  taskBranchName,
} from "../infra/git-coordination.mjs";
import { invokeCapability } from "../capabilities/gateway.mjs";
import { readLedgerTailHash, readVerifiedLedgerEntries } from "../infra/ledger.mjs";
import { pathAllowed } from "../infra/path-match.mjs";
import { loadTaskState, normalizeTask } from "./plan-state.mjs";
import { persistTaskState } from "./task-board.mjs";
import {
  buildCoordinationPacket,
  parseCoordinationPacket,
  renderCoordinationCommitMessage,
  taskContract,
} from "./remote-ownership.mjs";

export async function prepareTaskHandoff(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `handoff-prepare:${options.taskId || "unknown"}`, () =>
    prepareTaskHandoffUnlocked(rootDir, options));
}

async function prepareTaskHandoffUnlocked(rootDir, options = {}) {
  if (!options.taskId) throw new Error("handoff prepare requires taskId");
  const toDeviceId = String(options.toDeviceId || options.toDevice || "").trim();
  if (!isDeviceId(toDeviceId)) throw new Error("handoff prepare requires a target deviceId from `wildarrange device status`");
  const { config } = await loadHelixConfig(rootDir);
  if (config.gitCoordination.mode === "off") throw new Error("git coordination is disabled");
  const context = await inspectGitCoordination(rootDir, config.gitCoordination);
  if (!context.active) throw new Error(`handoff requires Git remote coordination: ${context.reason}`);
  const device = await ensureDeviceIdentity(rootDir);
  const taskState = await requireTaskState(rootDir);
  const task = requireTask(taskState, options.taskId);
  if (task.status !== "in_progress" && task.status !== "verifying") {
    throw new Error(`task ${task.id} cannot be handed off from status ${task.status}`);
  }
  if (task.admission_claim?.runId) {
    throw new Error(`task ${task.id} is in active admission run ${task.admission_claim.runId}; finish or recover that transaction before handoff`);
  }
  if (!task.coordination || !["claimed", "accepted"].includes(task.coordination.status)) {
    throw new Error(`task ${task.id} has no active remote ownership claim`);
  }
  if (task.coordination.deviceId !== device.deviceId) {
    throw new Error(`task ${task.id} is owned by device ${task.coordination.deviceName || task.coordination.deviceId}`);
  }
  const remoteHeadSha = await remoteBranchHead(rootDir, task.coordination.remote, task.coordination.branch);
  if (remoteHeadSha !== task.coordination.remoteHeadSha) {
    throw new Error(`task ${task.id} remote ownership changed; expected ${task.coordination.remoteHeadSha}, got ${remoteHeadSha || "missing"}`);
  }
  let handoffVerification = null;
  if (config.gitCoordination.requireVerificationBeforeHandoff) {
    const verifyEnvelope = await invokeCapability("verify", { rootDir, task });
    handoffVerification = verifyEnvelope.evidence;
    if (verifyEnvelope.status !== "pass" || handoffVerification?.pass !== true) {
      throw new Error(`task ${task.id} verifier must pass against the current handoff tree`);
    }
  }
  // Collect after verification because verifier commands are external
  // processes and may have changed the tree despite being intended as
  // read-only checks. The checkpoint must describe the tree that actually
  // passed, not the tree from just before verification.
  const workingChanges = await listWorkingTreeChanges(rootDir);
  const committedChanges = await listTreeChanges(rootDir, remoteHeadSha, "HEAD");
  const allChangedPaths = [...new Set([...workingChanges, ...committedChanges])].sort();
  const runtimePathsExcluded = allChangedPaths.filter(isHelixRuntimePath);
  const changedPaths = allChangedPaths.filter((filePath) => !isHelixRuntimePath(filePath));
  const writablePaths = task.writable_paths || [];
  const deniedPaths = changedPaths.filter((filePath) => !pathAllowed(filePath, writablePaths));
  if (config.gitCoordination.requireCleanHandoff && deniedPaths.length > 0) {
    throw new Error(`handoff has changes outside task writable_paths: ${deniedPaths.join(", ")}`);
  }
  const includedPaths = changedPaths.filter((filePath) => pathAllowed(filePath, writablePaths));
  const packet = buildCoordinationPacket("handoff_offer", {
    planId: taskState.planId,
    task: taskContract(task),
    owner: options.toOwner || task.owner,
    fromOwner: task.owner,
    fromDevice: device,
    toDeviceId,
    toDeviceName: options.toDeviceName || null,
    branch: task.coordination.branch,
    remote: task.coordination.remote,
    previousRemoteHeadSha: remoteHeadSha,
    ownerEpoch: Number(task.coordination.ownerEpoch || 1) + 1,
    ledgerTailHash: await readLedgerTailHash(rootDir),
    changedPaths: includedPaths,
    omittedPaths: deniedPaths,
    runtimePathsExcluded,
    handoffVerification,
  });
  const checkpointSha = await createTaskCheckpointCommit(rootDir, {
    parentSha: remoteHeadSha,
    changedPaths: includedPaths,
    message: renderCoordinationCommitMessage(`handoff ${taskState.planId}/${task.id} to ${options.toDeviceName || toDeviceId}`, packet),
  });
  const checkpointTreeSha = await gitTree(rootDir, checkpointSha);
  const record = {
    kind: "task_handoff",
    version: 1,
    status: "prepared",
    planId: taskState.planId,
    taskId: task.id,
    fromDevice: device,
    toDeviceId,
    toDeviceName: options.toDeviceName || null,
    toOwner: options.toOwner || task.owner,
    remote: task.coordination.remote,
    branch: task.coordination.branch,
    previousRemoteHeadSha: remoteHeadSha,
    checkpointSha,
    checkpointTreeSha,
    changedPaths: includedPaths,
    omittedPaths: deniedPaths,
    runtimePathsExcluded,
    preparedAt: nowIso(),
  };
  await writeHandoffRecord(rootDir, task.id, record);
  await appendLedger(rootDir, {
    type: "task_handoff_prepared",
    planId: taskState.planId,
    taskId: task.id,
    fromDeviceId: device.deviceId,
    toDeviceId: record.toDeviceId,
    checkpointSha,
    changedPaths: includedPaths,
    runtimePathsExcluded,
  });
  return record;
}

export async function pushTaskHandoff(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `handoff-push:${options.taskId || "unknown"}`, () =>
    pushTaskHandoffUnlocked(rootDir, options));
}

async function pushTaskHandoffUnlocked(rootDir, options = {}) {
  if (!options.taskId) throw new Error("handoff push requires taskId");
  const record = await readHandoffRecord(rootDir, options.taskId);
  if (!record || !["prepared", "pushed"].includes(record.status)) {
    throw new Error(`task ${options.taskId} has no prepared handoff`);
  }
  const taskState = await requireTaskState(rootDir);
  const task = requireTask(taskState, options.taskId);
  const [workingPaths, committedPaths] = await Promise.all([
    listWorkingTreeChanges(rootDir),
    listTreeChanges(rootDir, record.previousRemoteHeadSha, "HEAD"),
  ]);
  const currentPaths = [...new Set([...workingPaths, ...committedPaths])]
    .filter((filePath) => !isHelixRuntimePath(filePath))
    .sort();
  const deniedPaths = currentPaths.filter((filePath) => !pathAllowed(filePath, task.writable_paths || []));
  if (deniedPaths.length > 0) {
    throw new Error(`handoff changed after prepare and now contains out-of-scope paths: ${deniedPaths.join(", ")}`);
  }
  const includedPaths = currentPaths.filter((filePath) => pathAllowed(filePath, task.writable_paths || []));
  const currentCheckpointSha = await createTaskCheckpointCommit(rootDir, {
    parentSha: record.previousRemoteHeadSha,
    changedPaths: includedPaths,
    message: "wildarrange(coordination): validate prepared handoff tree",
  });
  const [preparedTreeSha, currentTreeSha] = await Promise.all([
    record.checkpointTreeSha ? Promise.resolve(record.checkpointTreeSha) : gitTree(rootDir, record.checkpointSha),
    gitTree(rootDir, currentCheckpointSha),
  ]);
  if (preparedTreeSha !== currentTreeSha
    || JSON.stringify(includedPaths) !== JSON.stringify(record.changedPaths || [])) {
    throw new Error(`handoff workspace changed after prepare; run handoff prepare --task ${options.taskId} again`);
  }
  const actualSha = await remoteBranchHead(rootDir, record.remote, record.branch);
  const alreadyPushed = actualSha === record.checkpointSha;
  if (!alreadyPushed && actualSha !== record.previousRemoteHeadSha) {
    throw new Error(`handoff push refused: remote task head changed from ${record.previousRemoteHeadSha} to ${actualSha || "missing"}`);
  }
  if (!alreadyPushed) {
    const pushed = await pushCommit(rootDir, {
      remote: record.remote,
      branch: record.branch,
      commitSha: record.checkpointSha,
    });
    if (!pushed.ok) throw new Error(`handoff push failed without force: ${pushed.stderr || pushed.stdout}`);
  }
  task.coordination = {
    ...task.coordination,
    status: "offered",
    handoffToDeviceId: record.toDeviceId,
    handoffCheckpointSha: record.checkpointSha,
    handedOffAt: nowIso(),
  };
  await persistTaskState(rootDir, taskState);
  const pushedRecord = {
    ...record,
    status: "pushed",
    pushedAt: record.pushedAt || nowIso(),
    remoteHeadSha: record.checkpointSha,
    reconciled: alreadyPushed,
  };
  await writeHandoffRecord(rootDir, task.id, pushedRecord);
  const ledgerEntries = await readVerifiedLedgerEntries(rootDir);
  if (!ledgerEntries.some((entry) => entry.type === "task_handoff_pushed"
    && entry.taskId === task.id
    && entry.remoteHeadSha === record.checkpointSha)) {
    await appendLedger(rootDir, {
      type: "task_handoff_pushed",
      planId: taskState.planId,
      taskId: task.id,
      toDeviceId: record.toDeviceId,
      remoteHeadSha: record.checkpointSha,
      reconciled: alreadyPushed,
    });
  }
  return pushedRecord;
}

export async function acceptTaskHandoff(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `handoff-accept:${options.taskId || "unknown"}`, () =>
    acceptTaskHandoffUnlocked(rootDir, options));
}

async function acceptTaskHandoffUnlocked(rootDir, options = {}) {
  if (!options.taskId) throw new Error("handoff accept requires taskId");
  const { config } = await loadHelixConfig(rootDir);
  if (config.gitCoordination.mode === "off") throw new Error("git coordination is disabled");
  const context = await inspectGitCoordination(rootDir, config.gitCoordination);
  if (!context.active) throw new Error(`handoff requires Git remote coordination: ${context.reason}`);
  const device = await ensureDeviceIdentity(rootDir);
  const taskState = await loadTaskState(rootDir);
  const planId = options.planId || taskState?.planId;
  if (!planId) throw new Error("handoff accept requires planId when no local plan is imported");
  const branch = taskBranchName(config.gitCoordination, planId, options.taskId);
  const checkpointSha = await fetchRemoteBranch(rootDir, context.remote, branch);
  const offer = parseCoordinationPacket(await readCommitMessage(rootDir, checkpointSha));
  if (offer.kind === "handoff_accept") {
    if (offer.planId !== planId || offer.task?.id !== options.taskId) {
      throw new Error(`remote branch ${branch} contains an acceptance for another task`);
    }
    if (offer.acceptedByDevice?.deviceId !== device.deviceId) {
      throw new Error(`task ${options.taskId} was already accepted by device ${offer.acceptedByDevice?.name || offer.acceptedByDevice?.deviceId || "unknown"}`);
    }
    await assertCleanWorkingTree(rootDir);
    await switchToTaskBranch(rootDir, branch, checkpointSha);
    const resumedTask = await restoreAcceptedTask(rootDir, {
      planId,
      task: offer.task,
      owner: offer.owner,
      coordination: {
        status: "accepted",
        mode: config.gitCoordination.mode,
        remote: context.remote,
        branch,
        baseSha: offer.previousRemoteHeadSha,
        remoteHeadSha: checkpointSha,
        claimSha: offer.previousRemoteHeadSha,
        ownerEpoch: offer.ownerEpoch,
        owner: offer.owner,
        deviceId: device.deviceId,
        deviceName: device.name,
        acceptedAt: offer.acceptedAt || nowIso(),
        handoffCheckpointSha: offer.checkpointSha,
        handoffChangedPaths: offer.changedPaths || [],
      },
    });
    const resumedRecord = {
      kind: "task_handoff",
      version: 1,
      status: "accepted",
      resumed: true,
      planId,
      taskId: options.taskId,
      branch,
      remote: context.remote,
      checkpointSha: offer.checkpointSha,
      acceptSha: checkpointSha,
      device,
      acceptedAt: offer.acceptedAt || nowIso(),
      task: resumedTask,
    };
    await writeHandoffRecord(rootDir, options.taskId, resumedRecord);
    const ledgerEntries = await readVerifiedLedgerEntries(rootDir);
    if (!ledgerEntries.some((entry) => entry.type === "task_handoff_accepted"
      && entry.taskId === options.taskId
      && entry.acceptSha === checkpointSha)) {
      await appendLedger(rootDir, {
        type: "task_handoff_accepted",
        planId,
        taskId: options.taskId,
        deviceId: device.deviceId,
        checkpointSha: offer.checkpointSha,
        acceptSha: checkpointSha,
        resumed: true,
      });
    }
    return resumedRecord;
  }
  if (offer.kind !== "handoff_offer" || offer.planId !== planId || offer.task?.id !== options.taskId) {
    throw new Error(`remote branch ${branch} does not contain the expected handoff offer`);
  }
  if (offer.toDeviceId !== device.deviceId) {
    throw new Error(`handoff targets deviceId ${offer.toDeviceId}; current deviceId is ${device.deviceId}`);
  }
  await assertCleanWorkingTree(rootDir);

  const acceptancePacket = buildCoordinationPacket("handoff_accept", {
    ...offer,
    acceptedByDevice: device,
    acceptedAt: nowIso(),
    checkpointSha,
  });
  const acceptSha = await createMetadataCommit(rootDir, {
    parentSha: checkpointSha,
    message: renderCoordinationCommitMessage(`accept ${planId}/${options.taskId} on ${device.name}`, acceptancePacket),
  });
  const remoteBeforePush = await remoteBranchHead(rootDir, context.remote, branch);
  if (remoteBeforePush !== checkpointSha) {
    throw new Error(`handoff accept refused: remote task head changed from ${checkpointSha} to ${remoteBeforePush || "missing"}`);
  }
  const pushed = await pushCommit(rootDir, { remote: context.remote, branch, commitSha: acceptSha });
  if (!pushed.ok) throw new Error(`handoff accept lost ownership race: ${pushed.stderr || pushed.stdout}`);
  await switchToTaskBranch(rootDir, branch, acceptSha);

  const restored = await restoreAcceptedTask(rootDir, {
    planId,
    task: offer.task,
    owner: offer.owner,
    coordination: {
      status: "accepted",
      mode: config.gitCoordination.mode,
      remote: context.remote,
      branch,
      baseSha: offer.previousRemoteHeadSha,
      remoteHeadSha: acceptSha,
      claimSha: offer.previousRemoteHeadSha,
      ownerEpoch: offer.ownerEpoch,
      owner: offer.owner,
      deviceId: device.deviceId,
      deviceName: device.name,
      acceptedAt: nowIso(),
      handoffCheckpointSha: checkpointSha,
      handoffChangedPaths: offer.changedPaths || [],
    },
  });
  const record = {
    kind: "task_handoff",
    version: 1,
    status: "accepted",
    planId,
    taskId: options.taskId,
    branch,
    remote: context.remote,
    checkpointSha,
    acceptSha,
    device,
    acceptedAt: nowIso(),
  };
  await writeHandoffRecord(rootDir, options.taskId, record);
  await appendLedger(rootDir, {
    type: "task_handoff_accepted",
    planId,
    taskId: options.taskId,
    deviceId: device.deviceId,
    checkpointSha,
    acceptSha,
  });
  return { ...record, task: restored };
}

export async function takeoverTaskOwnership(rootDir, options = {}) {
  return withTaskStateLock(rootDir, `handoff-takeover:${options.taskId || "unknown"}`, () =>
    takeoverTaskOwnershipUnlocked(rootDir, options));
}

async function takeoverTaskOwnershipUnlocked(rootDir, options = {}) {
  if (!options.taskId) throw new Error("handoff takeover requires taskId");
  if (!options.planId) throw new Error("handoff takeover requires planId");
  if (!isDeviceId(options.expectedDeviceId || options.expectedDevice)) throw new Error("handoff takeover requires expectedDeviceId");
  const reason = String(options.reason || "").trim();
  if (!reason) throw new Error("handoff takeover requires a non-empty reason");
  const { config } = await loadHelixConfig(rootDir);
  if (config.gitCoordination.mode === "off") throw new Error("git coordination is disabled");
  const context = await inspectGitCoordination(rootDir, config.gitCoordination);
  if (!context.active) throw new Error(`takeover requires Git remote coordination: ${context.reason}`);
  const device = await ensureDeviceIdentity(rootDir);
  const branch = taskBranchName(config.gitCoordination, options.planId, options.taskId);
  const previousSha = await fetchRemoteBranch(rootDir, context.remote, branch);
  const previousPacket = parseCoordinationPacket(await readCommitMessage(rootDir, previousSha));
  const expectedDeviceId = String(options.expectedDeviceId || options.expectedDevice);
  if (previousPacket.kind === "task_takeover"
    && previousPacket.device?.deviceId === device.deviceId) {
    if (previousPacket.previousOwnerDevice?.deviceId !== expectedDeviceId) {
      throw new Error(`expected deviceId ${expectedDeviceId} does not match takeover's previous owner ${previousPacket.previousOwnerDevice?.deviceId || "unknown"}`);
    }
    await assertCleanWorkingTree(rootDir);
    await switchToTaskBranch(rootDir, branch, previousSha);
    const resumedTask = await restoreAcceptedTask(rootDir, {
      planId: options.planId,
      task: previousPacket.task,
      owner: previousPacket.owner,
      coordination: {
        status: "accepted",
        mode: config.gitCoordination.mode,
        remote: context.remote,
        branch,
        remoteHeadSha: previousSha,
        ownerEpoch: previousPacket.ownerEpoch,
        owner: previousPacket.owner,
        deviceId: device.deviceId,
        deviceName: device.name,
        takeoverReason: previousPacket.reason,
        handoffChangedPaths: previousPacket.changedPaths || [],
        acceptedAt: previousPacket.createdAt || nowIso(),
      },
    });
    await recordTakeoverLedgerOnce(rootDir, {
      planId: options.planId,
      taskId: options.taskId,
      deviceId: device.deviceId,
      previousRemoteHeadSha: previousPacket.previousRemoteHeadSha,
      remoteHeadSha: previousSha,
      reason: previousPacket.reason,
      resumed: true,
    });
    return {
      status: "accepted",
      resumed: true,
      planId: options.planId,
      taskId: options.taskId,
      branch,
      takeoverSha: previousSha,
      task: resumedTask,
    };
  }
  const previousDevice = previousPacket.acceptedByDevice || previousPacket.fromDevice || previousPacket.device;
  if (previousDevice?.deviceId !== expectedDeviceId) {
    throw new Error(`expected deviceId ${expectedDeviceId} does not match remote owner ${previousDevice?.deviceId || "unknown"}`);
  }
  await assertCleanWorkingTree(rootDir);
  const packet = buildCoordinationPacket("task_takeover", {
    planId: options.planId,
    task: previousPacket.task,
    owner: options.owner || previousPacket.owner,
    previousOwnerDevice: previousDevice,
    device,
    branch,
    remote: context.remote,
    previousRemoteHeadSha: previousSha,
    ownerEpoch: Number(previousPacket.ownerEpoch || 1) + 1,
    reason,
    changedPaths: previousPacket.changedPaths || [],
    ledgerTailHash: await readLedgerTailHash(rootDir),
  });
  const takeoverSha = await createMetadataCommit(rootDir, {
    parentSha: previousSha,
    message: renderCoordinationCommitMessage(`takeover ${options.planId}/${options.taskId} on ${device.name}`, packet),
  });
  const pushed = await pushCommit(rootDir, { remote: context.remote, branch, commitSha: takeoverSha });
  if (!pushed.ok) throw new Error(`task takeover lost ownership race: ${pushed.stderr || pushed.stdout}`);
  await switchToTaskBranch(rootDir, branch, takeoverSha);
  const task = await restoreAcceptedTask(rootDir, {
    planId: options.planId,
    task: previousPacket.task,
    owner: options.owner || previousPacket.owner,
    coordination: {
      status: "accepted",
      mode: config.gitCoordination.mode,
      remote: context.remote,
      branch,
      remoteHeadSha: takeoverSha,
      ownerEpoch: packet.body.ownerEpoch,
      owner: options.owner || previousPacket.owner,
      deviceId: device.deviceId,
      deviceName: device.name,
      takeoverReason: reason,
      handoffChangedPaths: previousPacket.changedPaths || [],
      acceptedAt: nowIso(),
    },
  });
  await recordTakeoverLedgerOnce(rootDir, {
    planId: options.planId,
    taskId: options.taskId,
    deviceId: device.deviceId,
    previousRemoteHeadSha: previousSha,
    remoteHeadSha: takeoverSha,
    reason,
  });
  return { status: "accepted", planId: options.planId, taskId: options.taskId, branch, takeoverSha, task };
}

async function restoreAcceptedTask(rootDir, options) {
  await ensureHelixDirs(rootDir);
  let state = await loadTaskState(rootDir);
  if (state && state.planId !== options.planId) {
    throw new Error(`local active plan ${state.planId} differs from handoff plan ${options.planId}`);
  }
  if (!state) {
    const task = normalizeTask(options.task, 0, {});
    state = { version: 1, planId: options.planId, tasks: [task], updatedAt: nowIso() };
    await writeJsonAtomic(resolveHelixPath(rootDir, "plans", `${options.planId}.json`), {
      version: 1,
      id: options.planId,
      title: `Restored handoff ${options.planId}`,
      objective: `Continue task ${options.task.id} from a verified Git handoff packet.`,
      defaults: {},
      tasks: state.tasks,
      updatedAt: nowIso(),
    });
  }
  let task = state.tasks.find((candidate) => candidate.id === options.task.id);
  if (!task) {
    task = normalizeTask(options.task, state.tasks.length, {});
    state.tasks.push(task);
  }
  task.status = "in_progress";
  task.owner = options.owner;
  task.coordination = options.coordination;
  task.updatedAt = nowIso();
  await persistTaskState(rootDir, state);
  return task;
}

async function requireTaskState(rootDir) {
  const taskState = await loadTaskState(rootDir);
  if (!taskState) throw new Error("no imported plan found; run wildarrange plan --from <file>");
  return taskState;
}

function requireTask(taskState, taskId) {
  const task = taskState.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`unknown task: ${taskId}`);
  return task;
}

function handoffRecordPath(rootDir, taskId) {
  const safeTaskId = String(taskId).replace(/[^A-Za-z0-9._-]/g, "_");
  return resolveHelixPath(rootDir, "coordination", "handoffs", `${safeTaskId}.json`);
}

function isHelixRuntimePath(filePath) {
  return filePath === ".helix" || filePath.startsWith(".helix/");
}

function isDeviceId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

async function readHandoffRecord(rootDir, taskId) {
  return readJson(handoffRecordPath(rootDir, taskId), null);
}

async function writeHandoffRecord(rootDir, taskId, record) {
  await writeJsonAtomic(handoffRecordPath(rootDir, taskId), record);
  return path.relative(rootDir, handoffRecordPath(rootDir, taskId));
}

async function recordTakeoverLedgerOnce(rootDir, event) {
  const entries = await readVerifiedLedgerEntries(rootDir);
  if (entries.some((entry) => entry.type === "task_ownership_taken_over"
    && entry.taskId === event.taskId
    && entry.remoteHeadSha === event.remoteHeadSha)) return;
  await appendLedger(rootDir, {
    type: "task_ownership_taken_over",
    ...event,
  });
}
