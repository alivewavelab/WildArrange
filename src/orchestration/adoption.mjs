// =============================================================================
// 文件名称：adoption.mjs
// 所属模块：orchestration
// 作用说明：
//   验证卡 adoption 会话状态机：start/status/resume/recover/reconcile/decide/cancel；不进入 task.status，不复用 approvePlan，dashboard 是唯一写批准面。
//   会话存储见 adoption-session，Git 对账见 adoption-git-reconcile，卡应用见 adoption-apply。
// =============================================================================
import path from "node:path";
import { invokeCapability } from "../capabilities/gateway.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { createWorkId, nowIso, resolveGovernancePaths } from "../infra/runtime-store.mjs";
import { adoptionTransactionDir, clearMaintenanceMarker, restorePreimages, writeRecoveryManifest } from "../infra/recovery-transaction.mjs";
import { evaluateRegistryFreshness, readLocator, readVerificationInventory } from "../infra/verification-registry.mjs";
import { readGitHead } from "../infra/git-diff.mjs";
import {
  adoptionError,
  findActiveSession,
  findTransaction,
  loadSession,
  preparedResumeAction,
  readSessionFiles,
  requiredSession,
  suggestedLocator,
  withAdoptionLock,
  writeSessionFiles,
} from "./adoption-session.mjs";
import { applyApprovedCardsUnlocked, concludeAfterCard } from "./adoption-apply.mjs";
import {
  appliedEffectsMatchHead,
  artifactFailureNextAction,
  captureLiveApprovalSnapshot,
  captureProjectHeadSha,
  captureWrittenArtifactDigests,
  fingerprintLiveCard,
  gitBlobDigestEqualsIfAvailable,
  inventoryDigestSelfConsistent,
  mismatchLabels,
  recordAppliedEffect,
  rememberArtifactDigests,
} from "./adoption-git-reconcile.mjs";

/** 须逐卡人类批准的敏感卡动作（merge/delete/archive）。 */
const SENSITIVE_ACTIONS = new Set(["merge", "delete", "archive"]);

/** 匹配 AGENTS.md、package.json、wildarrange.config.json 的敏感路径正则。 */
const SENSITIVE_PATH_RE = /(^|\/)(AGENTS\.md|package\.json|wildarrange\.config\.json)$/i;


/** 启动 adoption 扫描会话或恢复已有 active session。 */
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

    let scanEnvelope;
    try {
      scanEnvelope = await invokeCapability("verification-governance-scan", { rootDir, options });
    } catch (error) {
      session.status = "needs_review";
      session.nextAction = "扫描异常中断，排查原因后重新运行 adoption start";
      session.error = {
        code: typeof error?.code === "string" ? error.code : "scan_crashed",
        message: error instanceof Error ? error.message : String(error),
      };
      await writeSessionFiles(rootDir, session);
      return { ok: false, session, error: session.error };
    }
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

/** 返回当前 adoption 会话状态与卡列表摘要。 */
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

/** 从中断的 apply/registry commit 事务 resume 继续执行。 */
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

/** 从 recovery_required 状态恢复：还原 preimage 并重置会话。 */
export async function recoverAdoption(rootDir, options = {}) {
  return withAdoptionLock(rootDir, options.sessionId || "recover", async () => {
    const session = await requiredSession(rootDir, options.sessionId);
    const files = await readSessionFiles(rootDir, session.sessionId);
    const recovery = findTransaction(files.transactions, "recovery_required");
    if (session.status !== "recovery_required" || !recovery) {
      throw adoptionError("recovery_not_required", `session status ${session.status} does not require recovery`);
    }
    const recoveryRoot = recovery.txn.repositoryTarget === "governance" ? resolveGovernancePaths(rootDir).rootDir : rootDir;
    const transactionDir = adoptionTransactionDir(rootDir, session.sessionId, recovery.cardId);
    try {
      const restored = await restorePreimages(
        recoveryRoot,
        path.join(transactionDir, "preimage"),
        recovery.txn.preimage || [],
        { denyPrefixes: [path.join(recoveryRoot, ".git")] },
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


/** 对账会话与 registry/git 现实，修复 stale 状态或标记 needs_review。 */
export async function reconcileAdoption(rootDir, options = {}) {
  return withAdoptionLock(rootDir, options.sessionId || "reconcile", async () => {
    return reconcileAdoptionUnlocked(rootDir, options);
  });
}

/** 锁内对账 adoption 会话与 Git/artifact 锚点，修复中断状态。 */
async function reconcileAdoptionUnlocked(rootDir, options = {}) {
  const governanceRoot = resolveGovernancePaths(rootDir).rootDir;
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
    const head = await readGitHead(governanceRoot);
    const registryMatch = await gitBlobDigestEqualsIfAvailable(
      governanceRoot,
      locator.registryPath,
      head.sha,
      session.registryDigest,
    );
    const locatorPath = session.locatorFile || resolveGovernancePaths(rootDir).configPath;
    const locatorMatch = await gitBlobDigestEqualsIfAvailable(
      governanceRoot,
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
        session.nextAction = `在 ${governanceRoot} 提交 Bootstrap 与 Inventory（commit B）后运行 adoption resume`;
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
    const head = await readGitHead(governanceRoot);
    const bootstrapMatch = await gitBlobDigestEqualsIfAvailable(
      governanceRoot,
      locator.bootstrapPath,
      head.sha,
      session.bootstrapDigest,
    );
    const inventoryMatch = await gitBlobDigestEqualsIfAvailable(
      governanceRoot,
      locator.inventoryPath,
      head.sha,
      session.inventoryDigest,
    );
    const inventory = files.inventory || (locator.inventoryPath
      ? await readVerificationInventory(path.join(resolveGovernancePaths(rootDir).rootDir, locator.inventoryPath), null)
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

/** 人类对单张 adoption 卡批准、拒绝、暂缓或撤销决定（dashboard 写批准面）。 */
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
      if (!["approved", "rejected", "deferred", "pending"].includes(decision.decision)) {
        throw adoptionError("invalid_decision", `invalid decision: ${decision.decision}`);
      }
      if (decision.decision === "approved" && isSensitiveAdoptionCard(card) && decisions.length > 1) {
        throw adoptionError("sensitive_card", "删除/合并必须逐卡批准");
      }
      if (decision.decision === "pending") {
        card.status = "pending";
        delete files.approvals[card.id];
      } else {
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

/** 取消 adoption 会话并清理临时状态。 */
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

/** 组装 dashboard adoption 面板所需的完整视图模型。 */
export async function loadAdoptionViewModel(rootDir, options = {}) {
  const status = await statusAdoption(rootDir, options);
  const files = status.session ? await readSessionFiles(rootDir, status.session.sessionId) : null;
  const configResult = await loadWildArrangeConfig(rootDir).catch(() => ({ config: {} }));
  const locator = readLocator(configResult.config);
  const inventory = locator.inventoryPath
    ? await readVerificationInventory(path.join(resolveGovernancePaths(rootDir).rootDir, locator.inventoryPath), null)
    : null;
  return {
    ...status,
    cards: files?.cards || [],
    approvals: files?.approvals || {},
    inventory,
  };
}

/** 判断 adoption 卡是否触及敏感路径或 merge/delete/archive 动作。 */
function isSensitiveAdoptionCard(card) {
  return SENSITIVE_ACTIONS.has(card.action)
    || SENSITIVE_PATH_RE.test(card.path || "")
    || (Array.isArray(card.verify) && card.verify.length > 0);
}
