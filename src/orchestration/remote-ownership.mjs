// =============================================================================
// 文件名称：remote-ownership.mjs
// 所属模块：orchestration
// 作用说明：
//   Git 远端任务所有权：设备注册、task branch claim、ownership 断言与
//   coordination packet 编解码。保证单写 owner 与 handoff 前的远端一致性。
//
// 【运行原理速读】
//   可以把它想成「多设备协作时的写权限公证处」：
//
//   · 何时执行？
//     任务 claim、admission 前、handoff 各阶段与线性 worker 写前。
//
//   · 做了什么？
//     创 claim commit → 校验 deviceId 与 remoteHeadSha → 解析 packet。
//
//   · 约束？
//     force push 禁止；ownership 变化必须 revalidation，禁止静默接管。
// =============================================================================
import { createHash } from "node:crypto";
import { appendLedger, appendLedgerOnce, readLedgerTailHash } from "../infra/ledger.mjs";
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

/** 注册或刷新本机 coordination 设备身份并记入账本。 */
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

/** 返回 Git 协调模式、本机设备与 git 上下文的综合状态。 */
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

/**
 * 为任务在远端 task branch 上 claim 写所有权（或复用/降级/manual）。
 * @returns {Promise<object>} claimed | degraded | disabled | manual 等状态
 */
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
    const localTaskBranch = context.localGitAvailable === true
      ? taskBranchName(coordination, options.planId, options.task.id)
      : null;
    return {
      status: "degraded",
      mode: coordination.mode,
      deviceId: device.deviceId,
      deviceName: device.name,
      reason: context.reason,
      localGit: context.localGitAvailable === true,
      branch: localTaskBranch,
      baseSha: context.headSha || null,
      remoteHeadSha: context.headSha || null,
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

/**
 * 断言当前设备仍为任务远端写 owner 且 remoteHeadSha 未变；否则 fail-closed。
 */
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

/** 构建带 SHA256 校验的 coordination packet（上限 48KB）。 */
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

/** 渲染写入 Git commit message 的 coordination 包格式。 */
export function renderCoordinationCommitMessage(subject, packet) {
  return [
    `wildarrange(coordination): ${subject}`,
    "",
    `WildArrange-Packet-SHA256: ${packet.sha256}`,
    `WildArrange-Packet: ${packet.encoded}`,
  ].join("\n");
}

/** 从 commit message 解析并校验 coordination packet。 */
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

/** 从任务对象提取写入 coordination packet 的契约字段子集。 */
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

// 判重与追加由 appendLedgerOnce 在同一把 ledger 锁内原子完成（ARC-003）；
// 判重口径沿用此前的已校验条目（verified entries）。
async function recordRemoteClaimLedgerOnce(rootDir, planId, taskId, claim) {
  await appendLedgerOnce(rootDir, {
    type: "remote_task_claimed",
    planId,
    taskId,
    owner: claim.owner,
    deviceId: claim.deviceId,
    branch: claim.branch,
    remoteHeadSha: claim.remoteHeadSha,
    reconciled: claim.reconciled === true,
  }, (entry) => entry.type === "remote_task_claimed"
    && entry.planId === planId
    && entry.taskId === taskId
    && entry.remoteHeadSha === claim.remoteHeadSha);
}
