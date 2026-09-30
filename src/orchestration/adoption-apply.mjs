// =============================================================================
// 文件名称：adoption-apply.mjs
// 所属模块：orchestration
// 作用说明：
//   adoption 已批准卡的应用：事务准备、经 gateway 应用卡、生成产物与收尾。
// =============================================================================
import { invokeCapability } from "../capabilities/gateway.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { nowIso, resolveGovernancePaths } from "../infra/runtime-store.mjs";
import { clearMaintenanceMarker } from "../infra/recovery-transaction.mjs";
import {
  findTransaction,
  preparedResumeAction,
  readSessionFiles,
  registerMaintenance,
  requiredSession,
  takeApprovedLocator,
  withAdoptionLock,
  writeSessionFiles,
} from "./adoption-session.mjs";
import {
  artifactFailureNextAction,
  captureLiveApprovalSnapshot,
  captureWrittenArtifactDigests,
  fingerprintLiveCard,
  recordAppliedEffect,
  refreshLocatorAppliedEffect,
  snapshotsMatch,
} from "./adoption-git-reconcile.mjs";


/** 将已批准卡 apply 到 registry/项目文件（事务化 preimage）。 */
export async function applyApprovedCards(rootDir, options = {}) {
  return withAdoptionLock(rootDir, options.sessionId || "apply", async () => {
    return applyApprovedCardsUnlocked(rootDir, options);
  });
}

/** 锁内逐张应用已批准卡片并记录 postimage 效应。 */
export async function applyApprovedCardsUnlocked(rootDir, options = {}) {
  if (Array.isArray(options.cardIds) && options.cardIds.length !== 1) {
    return { ok: false, status: "single_card_required", nextAction: "一次只 Apply 一张卡" };
  }

  const session = await requiredSession(rootDir, options.sessionId);
  if (["finalized", "cancelled"].includes(session.status)) {
    return { ok: false, status: "session_not_applicable", nextAction: `session status ${session.status} cannot apply cards` };
  }
  const files = await readSessionFiles(rootDir, session.sessionId);
  const recovery = findTransaction(files.transactions, "recovery_required");
  if (recovery) {
    // §3.4：存在 recovery_required 事务时禁止新 apply，须先 resume/restore preimage。
    session.status = "recovery_required";
    session.nextAction = `卡片 ${recovery.cardId} 回滚失败，保留 maintenance marker`;
    await writeSessionFiles(rootDir, session, files);
    return { ok: false, status: "recovery_required", cardId: recovery.cardId };
  }

  const prepared = findTransaction(files.transactions, "prepared");
  const undecided = files.cards.filter((card) => card.status === "pending" || card.status === "stale");
  if (!prepared && undecided.length > 0) {
    return {
      ok: false,
      status: "pending_decisions",
      pending: undecided,
      nextAction: `先判完 ${undecided.length} 张卡`,
    };
  }
  if (!["ready", "applying"].includes(session.status)) {
    return { ok: false, status: "session_not_applicable", nextAction: `session status ${session.status} cannot apply cards` };
  }

  const requestedId = typeof options.cardId === "string" && options.cardId
    ? options.cardId
    : options.cardIds?.[0];
  const cardId = prepared?.cardId || requestedId;
  if (!cardId) {
    return { ok: false, status: "single_card_required", nextAction: "一次只 Apply 一张卡" };
  }

  const card = files.cards.find((item) => item.id === cardId);
  if (!card) {
    return { ok: false, status: "unknown_card", cardId, nextAction: `未知卡片 ${cardId}` };
  }

  if (files.transactions[cardId]?.status === "committed") {
    if (!card.appliedAt) card.appliedAt = nowIso();
    recordAppliedEffect(session, cardId, files.transactions[cardId].postimage || []);
    await writeSessionFiles(rootDir, session, files);
    return concludeAfterCard(rootDir, session, files);
  }

  if (!prepared && card.status !== "approved") {
    return { ok: false, status: "not_approved", cardId, nextAction: `卡片 ${cardId} 尚未批准` };
  }

  if (!prepared) {
    const liveSnapshot = await captureLiveApprovalSnapshot(rootDir, card);
    if (!snapshotsMatch(files.approvals[card.id]?.snapshot, liveSnapshot)) {
      card.status = "stale";
      session.status = "needs_review";
      session.nextAction = `卡片 ${card.id} 已过期，重新批准`;
      await writeSessionFiles(rootDir, session, files);
      return { ok: false, status: "stale", cardId };
    }
    const approvedFingerprint = files.approvals[card.id]?.cardFingerprint;
    const currentFingerprint = fingerprintLiveCard(card);
    if (approvedFingerprint && approvedFingerprint !== currentFingerprint) {
      card.status = "stale";
      session.status = "needs_review";
      session.nextAction = `卡片 ${card.id} 已过期，重新批准`;
      await writeSessionFiles(rootDir, session, files);
      return { ok: false, status: "stale", cardId };
    }
  }

  await registerMaintenance(rootDir, session, files);
  session.status = "applying";
  session.nextAction = prepared ? preparedResumeAction(card.id) : `正在 Apply ${card.id}`;
  await writeSessionFiles(rootDir, session, files);

  const envelope = await invokeCapability("verification-governance-apply-card", {
    rootDir,
    options: {
      sessionId: session.sessionId,
      card,
      expectedFingerprint: files.approvals[card.id]?.fingerprint,
      config: (await loadWildArrangeConfig(rootDir)).config,
    },
  });
  files.transactions[cardId] = envelope.evidence?.manifest || { status: envelope.status };
  if (envelope.error?.code === "recovery_required" || envelope.evidence?.manifest?.status === "recovery_required") {
    session.status = "recovery_required";
    session.nextAction = `卡片 ${card.id} 回滚失败，保留 maintenance marker`;
    await writeSessionFiles(rootDir, session, files);
    return { ok: false, status: "recovery_required", cardId, error: envelope.error };
  }
  if (envelope.status !== "pass") {
    session.status = "needs_review";
    session.nextAction = `卡片 ${card.id} 已回滚，检查验证失败后重试`;
    await writeSessionFiles(rootDir, session, files);
    await clearMaintenanceMarker(rootDir);
    return { ok: false, status: "rolled_back", cardId, error: envelope.error };
  }

  card.appliedAt = nowIso();
  recordAppliedEffect(session, cardId, envelope.evidence?.manifest?.postimage || envelope.evidence?.postimage || []);
  await writeSessionFiles(rootDir, session, files);
  return concludeAfterCard(rootDir, session, files);
}

/** 单卡应用后更新会话阶段、inventory 与下一阶段动作。 */
export async function concludeAfterCard(rootDir, session, files) {
  const remaining = files.cards.filter((item) => item.status === "approved" && !item.appliedAt);
  if (remaining.length > 0) {
    session.status = "ready";
    session.nextAction = `继续 Apply 下一张卡 ${remaining[0].id}`;
    await writeSessionFiles(rootDir, session, files);
    await clearMaintenanceMarker(rootDir);
    return { ok: true, session, nextAction: session.nextAction };
  }

  const locator = takeApprovedLocator(files.cards) || session.locator;
  session.locator = locator;
  const generated = await invokeCapability("verification-governance-generate-artifacts", {
    rootDir,
    options: {
      phase: "registry",
      cards: files.cards,
      locator,
      writeLocator: Boolean(locator && files.cards.some((item) => item.action === "adopt" && item.asset === "config_locator" && item.status === "approved")),
    },
  });
  if (generated.status !== "pass") {
    session.status = "needs_review";
    session.nextAction = artifactFailureNextAction(generated.error, "Registry 生成失败，检查 locator 后重试 Apply");
    await writeSessionFiles(rootDir, session, files);
    await clearMaintenanceMarker(rootDir);
    return { ok: false, status: "generate_failed", session, nextAction: session.nextAction, error: generated.error };
  }
  await captureWrittenArtifactDigests(rootDir, session, locator);
  await refreshLocatorAppliedEffect(rootDir, session);
  session.status = "awaiting_registry_commit";
  session.nextAction = `在 ${resolveGovernancePaths(rootDir).rootDir} 提交 Registry 与 locator（commit A）；已批准的业务改动在业务仓库单独提交，然后运行 adoption resume`;
  await writeSessionFiles(rootDir, session, files);
  await clearMaintenanceMarker(rootDir);
  return { ok: true, session, generated: generated.evidence };
}
