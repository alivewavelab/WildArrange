import { createHash } from "node:crypto";
import { appendLedger } from "../infra/ledger.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { nowIso } from "../infra/runtime-store.mjs";
import {
  createRemoteClaim,
  ensureDeviceIdentity,
  fetchRemoteBranch,
  inspectGitCoordination,
  readCommitMessage,
  remoteBranchHead,
  taskBranchName,
} from "../infra/git-coordination.mjs";
import { readLedgerTailHash, readVerifiedLedgerEntries } from "../infra/ledger.mjs";

export async function registerCoordinationDevice(rootDir, options = {}) {
  const device = await ensureDeviceIdentity(rootDir, options);
  await appendLedger(rootDir, {
    type: "coordination_device_registered",
    deviceId: device.deviceId,
    deviceName: device.name,
    forced: options.force === true,
  });
  return device;
}

export async function coordinationStatus(rootDir) {
  const { config, sourcePath } = await loadWildArrangeConfig(rootDir);
  const device = await ensureDeviceIdentity(rootDir);
  const context = await inspectGitCoordination(rootDir, config.gitCoordination);
  return {
    kind: "git_coordination_status",
    mode: config.gitCoordination.mode,
    configSource: sourcePath,
    device,
    git: context,
    safetyFloor: {
      singleWriteOwner: true,
      forcePushAllowed: false,
      staleIntegrationRequiresRevalidation: true,
      crossDeviceHandoffRequiresPushedCommit: true,
      automaticTakeoverAllowed: false,
    },
  };
}

export async function coordinateTaskClaim(rootDir, options) {
  const { config } = await loadWildArrangeConfig(rootDir);
  const coordination = config.gitCoordination;
  const forced = options.force === true;
  if (options.task?.coordination && ["claimed", "accepted"].includes(options.task.coordination.status)) {
    await assertCurrentTaskOwnership(rootDir, options.task);
    return { ...options.task.coordination, reused: true };
  }
  if (coordination.mode === "off" || (coordination.mode === "manual" && !forced)) {
    return {
      status: coordination.mode === "off" ? "disabled" : "manual",
      mode: coordination.mode,
      reason: coordination.mode === "off"
        ? "git coordination is disabled"
        : "manual mode requires an explicit coordination claim",
    };
  }
  const device = await ensureDeviceIdentity(rootDir);
  const context = await inspectGitCoordination(rootDir, coordination);
  if (!context.active) {
    if (forced) throw new Error(`cannot claim remote task ownership: ${context.reason}`);
    return {
      status: "degraded",
      mode: coordination.mode,
      deviceId: device.deviceId,
      deviceName: device.name,
      reason: context.reason,
    };
  }
  const branch = taskBranchName(coordination, options.planId, options.task.id);
  const ledgerTailHash = await readLedgerTailHash(rootDir);
  const packet = buildCoordinationPacket("task_claim", {
    planId: options.planId,
    task: taskContract(options.task),
    owner: options.owner,
    device,
    baseSha: context.headSha,
    branch,
    ledgerTailHash,
    ownerEpoch: 1,
  });
  let existingSha = await remoteBranchHead(rootDir, context.remote, branch);
  if (existingSha) {
    // ls-remote only returns an object id; another clone may not have that
    // object yet. Fetch into FETCH_HEAD before reading the coordination
    // packet, without moving a local branch.
    existingSha = await fetchRemoteBranch(rootDir, context.remote, branch);
    const existingPacket = parseCoordinationPacket(await readCommitMessage(rootDir, existingSha));
    if (existingPacket.kind !== "task_claim"
      || existingPacket.planId !== options.planId
      || existingPacket.task?.id !== options.task.id
      || existingPacket.device?.deviceId !== device.deviceId) {
      throw new Error(`task branch ${context.remote}/${branch} is already claimed at ${existingSha}`);
    }
    const reconciled = {
      status: "claimed",
      mode: coordination.mode,
      remote: context.remote,
      branch,
      baseSha: existingPacket.baseSha,
      remoteHeadSha: existingSha,
      claimSha: existingSha,
      ownerEpoch: existingPacket.ownerEpoch || 1,
      owner: existingPacket.owner,
      deviceId: device.deviceId,
      deviceName: device.name,
      claimedAt: existingPacket.createdAt,
      reconciled: true,
    };
    await recordRemoteClaimLedgerOnce(rootDir, options.planId, options.task.id, reconciled);
    return reconciled;
  }
  const claim = await createRemoteClaim(rootDir, {
    remote: context.remote,
    branch,
    baseSha: context.headSha,
    message: renderCoordinationCommitMessage(`claim ${options.planId}/${options.task.id}`, packet),
  });
  const result = {
    status: "claimed",
    mode: coordination.mode,
    remote: context.remote,
    branch,
    baseSha: claim.baseSha,
    remoteHeadSha: claim.remoteHeadSha,
    claimSha: claim.claimSha,
    ownerEpoch: 1,
    owner: options.owner,
    deviceId: device.deviceId,
    deviceName: device.name,
    claimedAt: nowIso(),
  };
  await recordRemoteClaimLedgerOnce(rootDir, options.planId, options.task.id, result);
  return result;
}

export async function assertCurrentTaskOwnership(rootDir, task) {
  if (!task?.coordination || ["disabled", "manual", "degraded"].includes(task.coordination.status)) {
    return { pass: true, active: false, reason: task?.coordination?.reason || null };
  }
  const coordination = task.coordination;
  if (coordination.status !== "claimed" && coordination.status !== "accepted") {
    throw new Error(`task ${task.id} is not writable: coordination status is ${coordination.status || "unknown"}`);
  }
  const device = await ensureDeviceIdentity(rootDir);
  if (coordination.deviceId !== device.deviceId) {
    throw new Error(`task ${task.id} is owned by device ${coordination.deviceName || coordination.deviceId}; current device is ${device.name}`);
  }
  const actualSha = await remoteBranchHead(rootDir, coordination.remote, coordination.branch);
  if (actualSha !== coordination.remoteHeadSha) {
    throw new Error(`task ${task.id} remote ownership changed from ${coordination.remoteHeadSha} to ${actualSha || "missing"}; local writer must stop`);
  }
  return { pass: true, active: true, remoteHeadSha: actualSha, deviceId: device.deviceId };
}

export function buildCoordinationPacket(kind, fields) {
  const body = { ...fields, version: 1, kind, createdAt: nowIso() };
  const canonical = JSON.stringify(body);
  if (Buffer.byteLength(canonical, "utf8") > 48_000) {
    throw new Error("coordination packet exceeds 48 KB; reduce task description or command metadata");
  }
  return {
    body,
    sha256: createHash("sha256").update(canonical).digest("hex"),
    encoded: Buffer.from(canonical, "utf8").toString("base64url"),
  };
}

export function renderCoordinationCommitMessage(subject, packet) {
  return [
    `wildarrange(coordination): ${subject}`,
    "",
    `WildArrange-Packet-SHA256: ${packet.sha256}`,
    `WildArrange-Packet: ${packet.encoded}`,
  ].join("\n");
}

export function parseCoordinationPacket(message) {
  const encoded = String(message || "").match(/^WildArrange-Packet:\s*(\S+)\s*$/m)?.[1];
  const expectedHash = String(message || "").match(/^WildArrange-Packet-SHA256:\s*([0-9a-f]+)\s*$/mi)?.[1];
  if (!encoded || !expectedHash) throw new Error("commit does not contain a WildArrange coordination packet");
  let canonical;
  try {
    canonical = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new Error("WildArrange coordination packet is not valid base64url");
  }
  const actualHash = createHash("sha256").update(canonical).digest("hex");
  if (actualHash !== expectedHash) throw new Error("WildArrange coordination packet hash mismatch");
  const body = JSON.parse(canonical);
  if (body?.version !== 1 || typeof body.kind !== "string") throw new Error("unsupported WildArrange coordination packet");
  return body;
}

export function taskContract(task) {
  const keys = [
    "id",
    "subject",
    "description",
    "category",
    "writable_paths",
    "worker_command",
    "verify_commands",
    "review_commands",
    "standards_commands",
    "successCriteria",
    "blockedBy",
    "skills",
    "route_decision",
    "maxAttempts",
  ];
  return Object.fromEntries(keys.filter((key) => task[key] !== undefined).map((key) => [key, task[key]]));
}

async function recordRemoteClaimLedgerOnce(rootDir, planId, taskId, claim) {
  const entries = await readVerifiedLedgerEntries(rootDir);
  if (entries.some((entry) => entry.type === "remote_task_claimed"
    && entry.planId === planId
    && entry.taskId === taskId
    && entry.remoteHeadSha === claim.remoteHeadSha)) return;
  await appendLedger(rootDir, {
    type: "remote_task_claimed",
    planId,
    taskId,
    owner: claim.owner,
    deviceId: claim.deviceId,
    branch: claim.branch,
    remoteHeadSha: claim.remoteHeadSha,
    reconciled: claim.reconciled === true,
  });
}
