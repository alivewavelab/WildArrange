/**
 * Adoption session state machine. Does not enter task.status or reuse
 * approvePlan. Dashboard is the only write approval surface.
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { invokeCapability } from "../capabilities/gateway.mjs";
import { inspectFileLock, withFileLock } from "../infra/file-lock.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import {
  createWorkId,
  nowIso,
  readJson,
  resolveWildArrangePath,
  writeJsonAtomic,
} from "../infra/runtime-store.mjs";
import { withTaskStateLock } from "../infra/task-state-lock.mjs";
import { loadTaskState } from "../infra/task-state-store.mjs";
import {
  adoptionTransactionDir,
  adoptionSessionDir,
  clearMaintenanceMarker,
  readMaintenanceMarker,
  restorePreimages,
  writeRecoveryManifest,
  writeMaintenanceMarker,
} from "../infra/recovery-transaction.mjs";
import { captureCardLiveSnapshot, fingerprintCard } from "../infra/verification-discovery.mjs";
import * as verificationRegistry from "../infra/verification-registry.mjs";
import {
  digestCanonical,
  digestGitComparableContent,
  evaluateRegistryFreshness,
  gitTreeContains,
  locatorConfigured,
  readGitHead,
  readLocator,
  readVerificationInventory,
} from "../infra/verification-registry.mjs";

const SESSION_STATES = new Set([
  "scanning",
  "reviewing",
  "ready",
  "applying",
  "awaiting_registry_commit",
  "awaiting_final_commit",
  "finalized",
  "needs_review",
  "recovery_required",
  "cancelled",
]);

const SENSITIVE_ACTIONS = new Set(["merge", "delete", "archive"]);
const SENSITIVE_PATH_RE = /(^|\/)(AGENTS\.md|package\.json|wildarrange\.config\.json)$/i;
function preparedResumeAction(cardId) {
  return `运行 wildarrange adoption resume 以继续中断的事务 ${cardId}，不要重新 capture`;
}

export async function startAdoption(rootDir, options = {}) {
  return withAdoptionLock(rootDir, options.sessionId || "start", async () => {
    await reconcileAdoptionUnlocked(rootDir, options);
    const existing = await findActiveSession(rootDir);
    if (existing && !["finalized", "cancelled"].includes(existing.status)) {
      if (existing.status === "recovery_required") {
        return { ok: false, status: "recovery_required", session: existing, nextAction: "运行 wildarrange adoption resume 并按恢复指令处理" };
      }
      if (["scanning", "reviewing", "ready", "applying", "awaiting_registry_commit", "awaiting_final_commit"].includes(existing.status)) {
        return { ok: false, status: "session_exists", session: existing, nextAction: "使用 adoption status / resume，不要并行 start" };
      }
    }

    const sessionId = options.sessionId || createWorkId("adopt");
    const session = {
      kind: "adoption_session",
      schemaVersion: 1,
      sessionId,
      status: "scanning",
      createdAt: nowIso(),
      rootDirHint: path.basename(rootDir),
      nextAction: "等待只读扫描完成",
    };
    await writeSessionFiles(rootDir, session, { cards: [], approvals: {}, scan: null });

    const scanEnvelope = await invokeCapability("verification-governance-scan", { rootDir, options });
    if (scanEnvelope.status !== "pass") {
      session.status = "needs_review";
      session.nextAction = "检查扫描失败原因后重试 start";
      session.error = scanEnvelope.error;
      await writeSessionFiles(rootDir, session, { scan: scanEnvelope.evidence });
      return { ok: false, session, scan: scanEnvelope.evidence };
    }

    const cards = (scanEnvelope.evidence.cards || []).map((card) => ({ ...card, status: "pending" }));
    session.status = "reviewing";
    session.scanDigest = scanEnvelope.evidence.scanDigest;
    session.universeFingerprint = scanEnvelope.evidence.universeFingerprint;
    session.scannedAt = nowIso();
    session.scanHeadSha = await captureProjectHeadSha(rootDir);
    session.scanGitAvailable = scanEnvelope.evidence.universe?.gitAvailable === true;
    session.scanWipPaths = scanEnvelope.evidence.universe?.wipPaths || [];
    session.cardCount = cards.length;
    session.nextAction = "在 Dashboard 逐卡批准 / 拒绝 / 暂缓";
    if (!session.scanGitAvailable) {
      session.nextAction = "This project is not a Git repository. Review cards now, but run git init before Apply because commit A/B are required.";
    }
    await writeSessionFiles(rootDir, session, { cards, scan: scanEnvelope.evidence, approvals: {} });

    let dashboard = null;
    if (options.serve !== false && typeof options.startServer === "function") {
      dashboard = await options.startServer({
        host: options.host || "127.0.0.1",
        port: options.port,
        token: options.token,
      });
    }

    return {
      ok: true,
      session,
      cards,
      url: dashboard?.url || null,
      nextAction: session.nextAction,
    };
  });
}

export async function statusAdoption(rootDir, options = {}) {
  const session = await loadSession(rootDir, options.sessionId);
  if (!session) {
    return { ok: true, status: "idle", nextAction: "运行 wildarrange adoption start" };
  }
  const files = await readSessionFiles(rootDir, session.sessionId);
  const freshness = await evaluateRegistryFreshness(rootDir).catch((error) => ({
    status: "check_failed",
    stale: false,
    reason: error instanceof Error ? error.message : String(error),
  }));
  return {
    ok: true,
    session,
    pending: files.cards.filter((card) => card.status === "pending").length,
    stale: files.cards.filter((card) => card.status === "stale").length,
    approved: files.cards.filter((card) => card.status === "approved").length,
    recovery: session.status === "recovery_required",
    freshness,
    nextAction: session.nextAction,
  };
}

export async function resumeAdoption(rootDir, options = {}) {
  return withAdoptionLock(rootDir, options.sessionId || "resume", async () => {
    const reconciled = await reconcileAdoptionUnlocked(rootDir, options);
    if (reconciled.session?.status === "recovery_required") {
      return { ok: false, ...reconciled, nextAction: reconciled.session.nextAction };
    }
    const prepared = reconciled.files ? findTransaction(reconciled.files.transactions, "prepared") : null;
    if (
      prepared
      && reconciled.session
      && !["finalized", "cancelled", "awaiting_registry_commit", "awaiting_final_commit"].includes(reconciled.session.status)
    ) {
      return applyApprovedCardsUnlocked(rootDir, {
        sessionId: reconciled.session.sessionId,
        cardId: prepared.cardId,
      });
    }
    if (options.serve !== false && typeof options.startServer === "function" && reconciled.session && !["finalized", "cancelled"].includes(reconciled.session.status)) {
      const dashboard = await options.startServer({
        host: options.host || "127.0.0.1",
        port: options.port,
        token: options.token,
      });
      return { ok: true, ...reconciled, url: dashboard?.url || null };
    }
    return { ok: true, ...reconciled };
  });
}

export async function recoverAdoption(rootDir, options = {}) {
  return withAdoptionLock(rootDir, options.sessionId || "recover", async () => {
    const session = await requiredSession(rootDir, options.sessionId);
    const files = await readSessionFiles(rootDir, session.sessionId);
    const recovery = findTransaction(files.transactions, "recovery_required");
    if (session.status !== "recovery_required" || !recovery) {
      throw adoptionError("recovery_not_required", `session status ${session.status} does not require recovery`);
    }
    const transactionDir = adoptionTransactionDir(rootDir, session.sessionId, recovery.cardId);
    try {
      const restored = await restorePreimages(
        rootDir,
        path.join(transactionDir, "preimage"),
        recovery.txn.preimage || [],
        { denyPrefixes: [path.join(rootDir, ".git")] },
      );
      const manifest = {
        ...recovery.txn,
        status: "rolled_back",
        statusAt: nowIso(),
        recoveredAt: nowIso(),
        restored,
      };
      await writeRecoveryManifest(path.join(transactionDir, "manifest.json"), manifest);
      files.transactions[recovery.cardId] = manifest;
      session.status = "needs_review";
      session.nextAction = `Recovery completed for ${recovery.cardId}; review the verifier failure before retrying`;
      await writeSessionFiles(rootDir, session, files);
      await clearMaintenanceMarker(rootDir);
      return { ok: true, status: "recovered", session, cardId: recovery.cardId, restored };
    } catch (error) {
      const manifest = {
        ...recovery.txn,
        status: "recovery_required",
        statusAt: nowIso(),
        diagnostic: {
          ...(typeof recovery.txn.diagnostic === "object" && recovery.txn.diagnostic ? recovery.txn.diagnostic : {}),
          recovery: error instanceof Error ? error.message : String(error),
        },
      };
      await writeRecoveryManifest(path.join(transactionDir, "manifest.json"), manifest);
      session.status = "recovery_required";
      session.nextAction = `Recovery still failed for ${recovery.cardId}; inspect ${path.relative(rootDir, transactionDir)}`;
      await writeSessionFiles(rootDir, session, files);
      return { ok: false, status: "recovery_required", session, cardId: recovery.cardId, error: session.nextAction };
    }
  });
}

export async function reconcileAdoption(rootDir, options = {}) {
  return withAdoptionLock(rootDir, options.sessionId || "reconcile", async () => {
    return reconcileAdoptionUnlocked(rootDir, options);
  });
}

async function reconcileAdoptionUnlocked(rootDir, options = {}) {
  const session = await loadSession(rootDir, options.sessionId);
  if (!session) return { session: null, status: "idle" };
  const files = await readSessionFiles(rootDir, session.sessionId);
  const recovery = findTransaction(files.transactions, "recovery_required");
  if (recovery) {
    session.status = "recovery_required";
    session.nextAction = `恢复事务 ${recovery.cardId} 后才能继续`;
    await writeSessionFiles(rootDir, session, files);
    return { session, status: session.status, files };
  }
  const prepared = findTransaction(files.transactions, "prepared");
  if (prepared && !["finalized", "cancelled", "awaiting_registry_commit", "awaiting_final_commit"].includes(session.status)) {
    session.status = "applying";
    session.nextAction = preparedResumeAction(prepared.cardId);
    await writeSessionFiles(rootDir, session, files);
    return { session, status: session.status, files };
  }
  if (session.status === "applying") {
    const committed = Object.entries(files.transactions || {}).find(([cardId, txn]) => {
      const card = files.cards.find((item) => item.id === cardId);
      return txn?.status === "committed" && card && !card.appliedAt;
    });
    if (committed) {
      const [cardId, transaction] = committed;
      const card = files.cards.find((item) => item.id === cardId);
      if (card && !card.appliedAt) card.appliedAt = transaction.statusAt || nowIso();
      recordAppliedEffect(session, cardId, transaction.postimage || []);
      await writeSessionFiles(rootDir, session, files);
      return concludeAfterCard(rootDir, session, files);
    }
    const nextApproved = files.cards.find((card) => card.status === "approved" && !card.appliedAt);
    if (nextApproved) {
      session.status = "ready";
      session.nextAction = `Resume Apply for ${nextApproved.id}`;
      await writeSessionFiles(rootDir, session, files);
      await clearMaintenanceMarker(rootDir);
      return { session, status: session.status, files };
    }
    return concludeAfterCard(rootDir, session, files);
  }
  if (session.status === "awaiting_registry_commit") {
    const locator = files.session.locator || session.locator || suggestedLocator(files.cards);
    await rememberArtifactDigests(rootDir, session, locator);
    const head = await readGitHead(rootDir);
    const registryMatch = await gitBlobDigestEqualsIfAvailable(
      rootDir,
      locator.registryPath,
      head.sha,
      session.registryDigest,
    );
    const locatorPath = session.locatorFile || "wildarrange.config.json";
    const locatorMatch = await gitBlobDigestEqualsIfAvailable(
      rootDir,
      locatorPath,
      head.sha,
      session.locatorDigest,
    );
    const effectsMatch = await appliedEffectsMatchHead(rootDir, session, head.sha);
    if (head.available && locator.registryPath && registryMatch === true && locatorMatch === true && effectsMatch) {
      const generated = await invokeCapability("verification-governance-generate-artifacts", {
        rootDir,
        options: {
          phase: "handoff",
          cards: files.cards,
          locator,
          baselineRef: head.sha,
          universeFingerprint: session.universeFingerprint,
        },
      });
      if (generated.status === "pass") {
        session.baselineRef = head.sha;
        session.status = "awaiting_final_commit";
        await captureWrittenArtifactDigests(rootDir, session, locator);
        session.nextAction = "用户自行 commit Bootstrap 与 Inventory（commit B）后运行 adoption resume";
        await writeSessionFiles(rootDir, session, files);
      } else {
        session.status = "awaiting_registry_commit";
        session.nextAction = artifactFailureNextAction(generated.error, "Bootstrap/Inventory 生成失败，处理冲突后再次运行 adoption resume");
        await writeSessionFiles(rootDir, session, files);
      }
    } else {
      session.commitDiagnostics = {
        phase: "commit_a",
        gitAvailable: head.available,
        registry: registryMatch === true ? "matched" : "mismatch",
        locator: locatorMatch === true ? "matched" : "mismatch",
        appliedEffects: effectsMatch ? "matched" : "mismatch",
      };
      session.nextAction = head.available
        ? `Commit A is incomplete: ${mismatchLabels(session.commitDiagnostics).join(", ")}`
        : "Commit A cannot be verified because this project is not a Git repository; run git init and commit the approved changes";
      await writeSessionFiles(rootDir, session, files);
    }
  }
  if (session.status === "awaiting_final_commit") {
    const locator = files.session.locator || session.locator || suggestedLocator(files.cards);
    await rememberArtifactDigests(rootDir, session, locator);
    const head = await readGitHead(rootDir);
    const bootstrapMatch = await gitBlobDigestEqualsIfAvailable(
      rootDir,
      locator.bootstrapPath,
      head.sha,
      session.bootstrapDigest,
    );
    const inventoryMatch = await gitBlobDigestEqualsIfAvailable(
      rootDir,
      locator.inventoryPath,
      head.sha,
      session.inventoryDigest,
    );
    const inventory = files.inventory || (locator.inventoryPath
      ? await readVerificationInventory(path.join(rootDir, locator.inventoryPath), null)
      : null);
    const inventoryDigestOk = inventoryDigestSelfConsistent(inventory);
    const effectsMatch = await appliedEffectsMatchHead(rootDir, session, head.sha);
    if (bootstrapMatch === true && inventoryMatch === true && inventoryDigestOk && effectsMatch) {
      const freshness = await evaluateRegistryFreshness(rootDir, {
        universeFingerprint: session.universeFingerprint,
        expectedDeclaredFingerprint: inventory?.declaredInputFingerprint,
      });
      if (!freshness.stale) {
        session.status = "finalized";
        session.finalRef = head.sha;
        session.nextAction = "接管完成；之后 doctor/status 只亮新鲜度黄灯";
        await writeSessionFiles(rootDir, session, files);
        await clearMaintenanceMarker(rootDir);
      } else {
        session.nextAction = freshness.nextAction || "声明输入已漂移，重新生成后再 commit B";
        await writeSessionFiles(rootDir, session, files);
      }
    } else {
      session.commitDiagnostics = {
        phase: "commit_b",
        bootstrap: bootstrapMatch === true ? "matched" : "mismatch",
        inventory: inventoryMatch === true ? "matched" : "mismatch",
        inventoryDigest: inventoryDigestOk ? "matched" : "mismatch",
        appliedEffects: effectsMatch ? "matched" : "mismatch",
      };
      session.nextAction = `Commit B is incomplete: ${mismatchLabels(session.commitDiagnostics).join(", ")}`;
      await writeSessionFiles(rootDir, session, files);
    }
  }
  return { session, status: session.status, files };
}

export async function decideAdoptionCard(rootDir, options = {}) {
  return withAdoptionLock(rootDir, options.sessionId || "decide", async () => {
    const session = await requiredSession(rootDir, options.sessionId);
    if (!["reviewing", "needs_review"].includes(session.status)) {
      throw adoptionError("session_not_reviewable", `session status ${session.status} 不能写入批准`);
    }
    const files = await readSessionFiles(rootDir, session.sessionId);
    const decisions = Array.isArray(options.decisions) ? options.decisions : [options];
    for (const decision of decisions) {
      const card = files.cards.find((item) => item.id === decision.cardId);
      if (!card) throw adoptionError("unknown_card", `unknown card: ${decision.cardId}`);
      if (decision.fingerprint && decision.fingerprint !== card.fingerprint) {
        card.status = "stale";
        session.status = "needs_review";
        session.nextAction = `Card ${card.id} changed after scanning; review it again`;
        await writeSessionFiles(rootDir, session, files);
        throw adoptionError("card_stale", `card ${card.id} fingerprint stale`);
      }
      if (!["approved", "rejected", "deferred"].includes(decision.decision)) {
        throw adoptionError("invalid_decision", `invalid decision: ${decision.decision}`);
      }
      if (decision.decision === "approved" && isSensitiveAdoptionCard(card) && decisions.length > 1) {
        throw adoptionError("sensitive_card", "删除/合并必须逐卡批准");
      }
      if (decision.decision === "approved" && SENSITIVE_PATH_RE.test(card.path) && decisions.length > 1) {
        throw adoptionError("sensitive_card", "AGENTS/CI/配置变化必须逐卡批准");
      }
      card.status = decision.decision === "approved" ? "approved" : decision.decision === "rejected" ? "rejected" : "deferred";
      files.approvals[card.id] = {
        decision: decision.decision,
        at: nowIso(),
        fingerprint: card.fingerprint,
        ...(decision.decision === "approved"
          ? {
            snapshot: await captureLiveApprovalSnapshot(rootDir, card),
            cardFingerprint: fingerprintLiveCard(card),
          }
          : {}),
      };
    }
    const pending = files.cards.filter((card) => card.status === "pending" || card.status === "stale");
    const approved = files.cards.filter((card) => card.status === "approved" && !card.appliedAt);
    if (pending.length > 0) {
      session.status = "reviewing";
      session.nextAction = "继续逐卡批准";
    } else if (approved.length === 0) {
      session.status = "needs_review";
      session.nextAction = "没有已批准的变更；批准 locator 以生成三文件，或取消接管";
    } else {
      session.status = "ready";
      session.nextAction = "在 Dashboard 执行 Apply";
    }
    await writeSessionFiles(rootDir, session, files);
    return { session, cards: files.cards };
  });
}

export async function applyApprovedCards(rootDir, options = {}) {
  return withAdoptionLock(rootDir, options.sessionId || "apply", async () => {
    return applyApprovedCardsUnlocked(rootDir, options);
  });
}

async function applyApprovedCardsUnlocked(rootDir, options = {}) {
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
    if (options.ignoreLiveFingerprint !== true && approvedFingerprint && approvedFingerprint !== currentFingerprint) {
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

async function concludeAfterCard(rootDir, session, files) {
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
  session.nextAction = "用户自行 commit Registry 与 locator（commit A），然后运行 adoption resume";
  await writeSessionFiles(rootDir, session, files);
  await clearMaintenanceMarker(rootDir);
  return { ok: true, session, generated: generated.evidence };
}

export async function cancelAdoption(rootDir, options = {}) {
  return withAdoptionLock(rootDir, options.sessionId || "cancel", async () => {
    const session = await requiredSession(rootDir, options.sessionId);
    const files = await readSessionFiles(rootDir, session.sessionId);
    const hasAppliedChanges = files.cards.some((card) => card.appliedAt)
      || Object.values(files.transactions || {}).some((txn) => txn?.status === "committed");
    if (session.status === "applying" || session.status === "recovery_required" || hasAppliedChanges) {
      throw adoptionError(
        session.status === "recovery_required" ? "recovery_required" : hasAppliedChanges ? "applied_changes_exist" : "session_applying",
        `${session.status} 会话不能直接取消`,
      );
    }
    session.status = "cancelled";
    session.nextAction = "会话已取消";
    await writeSessionFiles(rootDir, session, files);
    await clearMaintenanceMarker(rootDir);
    return { session };
  });
}

export async function loadAdoptionViewModel(rootDir, options = {}) {
  const status = await statusAdoption(rootDir, options);
  const files = status.session ? await readSessionFiles(rootDir, status.session.sessionId) : null;
  return {
    ...status,
    cards: files?.cards || [],
    approvals: files?.approvals || {},
  };
}

async function registerMaintenance(rootDir, session, files) {
  await withTaskStateLock(rootDir, `adoption:${session.sessionId}`, async () => {
    const activity = await detectActiveRun(rootDir);
    if (activity) {
      throw adoptionError("active_run", activity.message);
    }
    await writeMaintenanceMarker(rootDir, {
      sessionId: session.sessionId,
      status: "applying",
      cardCount: files.cards.length,
    });
  });
}

async function detectActiveRun(rootDir) {
  const taskState = await loadTaskState(rootDir).catch(() => null);
  const busy = (taskState?.tasks || []).find((task) => ["in_progress", "verifying"].includes(task.status));
  if (busy) return { message: `活动任务 ${busy.id} 处于 ${busy.status}，不能同时接管` };
  const lock = await inspectFileLock(rootDir, resolveWildArrangePath(rootDir, "team", "tasks.lock"));
  if (lock.locked && lock.pidAlive && lock.owner && !String(lock.owner).startsWith("adoption")) {
    return { message: `任务锁由 ${lock.owner} 持有，不能同时接管` };
  }
  return null;
}

async function withAdoptionLock(rootDir, sessionId, fn) {
  const lockPath = resolveWildArrangePath(rootDir, "adoption", "adoption.lock");
  await mkdir(path.dirname(lockPath), { recursive: true });
  return withFileLock(rootDir, lockPath, "adoption lock", `adoption:${sessionId}`, fn, { waitTimeoutMs: 15_000 });
}

async function findActiveSession(rootDir) {
  const root = resolveWildArrangePath(rootDir, "adoption");
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const sessions = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const session = await readJson(path.join(root, entry.name, "session.json"), null);
    if (session?.sessionId) sessions.push(session);
  }
  sessions.sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  return sessions[0] || null;
}

async function loadSession(rootDir, sessionId) {
  if (sessionId) return readJson(path.join(adoptionSessionDir(rootDir, sessionId), "session.json"), null);
  return findActiveSession(rootDir);
}

async function requiredSession(rootDir, sessionId) {
  const session = await loadSession(rootDir, sessionId);
  if (!session) throw adoptionError("no_session", "没有可操作的 adoption 会话");
  return session;
}

async function readSessionFiles(rootDir, sessionId) {
  const dir = adoptionSessionDir(rootDir, sessionId);
  const session = await readJson(path.join(dir, "session.json"), null);
  const cards = (await readJson(path.join(dir, "cards.json"), { cards: [] })).cards || [];
  const approvals = (await readJson(path.join(dir, "approvals.json"), { approvals: {} })).approvals || {};
  const scan = await readJson(path.join(dir, "scan.json"), null);
  const inventory = session?.locator?.inventoryPath
    ? await readVerificationInventory(path.join(rootDir, session.locator.inventoryPath), null)
    : null;
  const transactions = {};
  let txnEntries = [];
  try {
    txnEntries = await readdir(path.join(dir, "transactions"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const cardId of txnEntries) {
    transactions[cardId] = await readJson(path.join(dir, "transactions", cardId, "manifest.json"), null);
  }
  return { session, cards, approvals, scan, transactions, inventory };
}

async function writeSessionFiles(rootDir, session, files = {}) {
  if (!SESSION_STATES.has(session.status)) throw adoptionError("invalid_status", `invalid session status ${session.status}`);
  const dir = adoptionSessionDir(rootDir, session.sessionId);
  await writeJsonAtomic(path.join(dir, "session.json"), session);
  if (files.cards) await writeJsonAtomic(path.join(dir, "cards.json"), { cards: files.cards });
  if (files.approvals) await writeJsonAtomic(path.join(dir, "approvals.json"), { approvals: files.approvals });
  if (files.scan) await writeJsonAtomic(path.join(dir, "scan.json"), files.scan);
}

function takeApprovedLocator(cards) {
  const card = (cards || []).find((item) => item.asset === "config_locator" && item.status === "approved" && item.patch?.value?.verificationGovernance);
  return card?.patch?.value?.verificationGovernance || null;
}

function suggestedLocator(cards) {
  const card = (cards || []).find((item) => item.asset === "config_locator" && item.patch?.value?.verificationGovernance);
  return card?.patch?.value?.verificationGovernance || readLocator({});
}

function findTransaction(transactions, status) {
  for (const [cardId, txn] of Object.entries(transactions || {})) {
    if (txn?.status === status) return { cardId, txn };
  }
  return null;
}

async function captureLiveApprovalSnapshot(rootDir, card) {
  const snapshot = await captureCardLiveSnapshot(rootDir, card);
  return {
    ...snapshot,
    headSha: await captureProjectHeadSha(rootDir),
  };
}

async function captureProjectHeadSha(rootDir) {
  if (!existsSync(path.join(rootDir, ".git"))) return null;
  const head = await readGitHead(rootDir).catch(() => ({ available: false, sha: null }));
  return head.available ? head.sha : null;
}

function fingerprintLiveCard(card) {
  const clone = JSON.parse(JSON.stringify({ ...card, fingerprint: "" }));
  delete clone.status;
  return fingerprintCard(clone);
}

function snapshotsMatch(expected, actual) {
  if (!expected || !actual) return false;
  if (expected.targetDigest !== actual.targetDigest) return false;
  if (expected.evidenceDigest !== actual.evidenceDigest) return false;
  if ((expected.headSha || null) !== (actual.headSha || null)) return false;
  const left = expected.dependencyDigests || {};
  const right = actual.dependencyDigests || {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

async function fileUtf8Digest(rootDir, relativePath) {
  if (!relativePath) return null;
  const absolutePath = path.join(rootDir, relativePath);
  if (!existsSync(absolutePath)) return null;
  try {
    return digestGitComparableContent(await readFile(absolutePath));
  } catch (error) {
    if (["EISDIR", "ENOENT", "EACCES", "EPERM"].includes(error?.code)) return null;
    throw error;
  }
}

function artifactFailureNextAction(error, fallback) {
  return error?.next_action || error?.nextAction || fallback;
}

async function captureWrittenArtifactDigests(rootDir, session, locator = {}) {
  const registryDigest = await fileUtf8Digest(rootDir, locator.registryPath);
  if (registryDigest) session.registryDigest = registryDigest;
  const bootstrapDigest = await fileUtf8Digest(rootDir, locator.bootstrapPath);
  if (bootstrapDigest) session.bootstrapDigest = bootstrapDigest;
  const inventoryDigest = await fileUtf8Digest(rootDir, locator.inventoryPath);
  if (inventoryDigest) session.inventoryDigest = inventoryDigest;
  const locatorFile = session.locatorFile || "wildarrange.config.json";
  const locatorDigest = await fileUtf8Digest(rootDir, locatorFile);
  if (locatorDigest) {
    session.locatorDigest = locatorDigest;
    session.locatorFile = locatorFile;
  }
}

async function rememberArtifactDigests(rootDir, session, locator = {}) {
  if (!session.registryDigest) {
    const digest = await fileUtf8Digest(rootDir, locator.registryPath);
    if (digest) session.registryDigest = digest;
  }
  if (!session.bootstrapDigest) {
    const digest = await fileUtf8Digest(rootDir, locator.bootstrapPath);
    if (digest) session.bootstrapDigest = digest;
  }
  if (!session.inventoryDigest) {
    const digest = await fileUtf8Digest(rootDir, locator.inventoryPath);
    if (digest) session.inventoryDigest = digest;
  }
  if (!session.locatorDigest) {
    const locatorFile = session.locatorFile || "wildarrange.config.json";
    const digest = await fileUtf8Digest(rootDir, locatorFile);
    if (digest) {
      session.locatorDigest = digest;
      session.locatorFile = locatorFile;
    }
  }
}

function recordAppliedEffect(session, cardId, postimage = []) {
  const paths = (postimage || []).map((item) => ({
    path: item.path,
    digest: item.gitDigest || item.digest,
    presence: item.digest === "missing" ? "absent" : "present",
  }));
  const rest = (session.appliedEffects || []).filter((item) => item.cardId !== cardId);
  session.appliedEffects = [...rest, { cardId, paths }];
}

async function refreshLocatorAppliedEffect(rootDir, session) {
  const locatorFile = session.locatorFile || "wildarrange.config.json";
  const digest = session.locatorDigest || await fileUtf8Digest(rootDir, locatorFile);
  if (!digest) return;
  for (const effect of session.appliedEffects || []) {
    for (const entry of effect.paths || []) {
      if (normalizeAdoptionPath(entry.path) === normalizeAdoptionPath(locatorFile)) {
        entry.digest = digest;
        entry.presence = "present";
      }
    }
  }
}

async function appliedEffectsMatchHead(rootDir, session, headSha) {
  if (!headSha) return false;
  for (const effect of session.appliedEffects || []) {
    for (const entry of effect.paths || []) {
      if (!entry?.path) continue;
      if (entry.presence === "absent") {
        if (await gitTreeContains(rootDir, entry.path, headSha)) return false;
        continue;
      }
      const match = await gitBlobDigestEqualsIfAvailable(rootDir, entry.path, headSha, entry.digest);
      if (match !== true) return false;
    }
  }
  return true;
}

function inventoryDigestSelfConsistent(inventory) {
  if (!inventory || typeof inventory !== "object" || !inventory.digest) return false;
  const { digest: _digest, ...rest } = inventory;
  return inventory.digest === digestCanonical(rest);
}

function normalizeAdoptionPath(relativePath) {
  return String(relativePath || "").replaceAll("\\", "/");
}

async function gitBlobDigestEqualsIfAvailable(rootDir, relativePath, ref, expectedDigest) {
  const compare = verificationRegistry.gitBlobDigestEquals;
  if (typeof compare !== "function") return null;
  if (!relativePath || !ref || !expectedDigest) return false;
  return compare(rootDir, relativePath, ref, expectedDigest);
}

function adoptionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function mismatchLabels(diagnostics) {
  return Object.entries(diagnostics || {})
    .filter(([key, value]) => !["phase", "gitAvailable"].includes(key) && value !== "matched")
    .map(([key]) => key);
}

export function isSensitiveAdoptionCard(card) {
  return SENSITIVE_ACTIONS.has(card.action)
    || SENSITIVE_PATH_RE.test(card.path || "")
    || (Array.isArray(card.verify) && card.verify.length > 0);
}

export { locatorConfigured, readMaintenanceMarker };
