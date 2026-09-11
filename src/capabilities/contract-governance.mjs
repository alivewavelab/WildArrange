import {
  persistContractScan,
  scanContractGovernanceUniverse,
} from "../infra/contract-governance.mjs";
import path from "node:path";
import { mkdir, rename, rm } from "node:fs/promises";
import { nowIso, readJson, writeJsonAtomic } from "../infra/runtime-store.mjs";
import { contractGovernancePaths, readContractRegistry, withContractGovernanceLock, requireSafeId, safeCardName, contractError, assertContractReferences, applyApprovedCard, relative, cardTouchesPaths, normalizeSlash, inspectApprovalRef, inspectContractReferences, declarationCoversSource, isContractScanPath } from "../infra/contract-governance.mjs";

export async function scanContractGovernance(rootDir, options = {}) {
  if (options.inspectTask) return inspectContractTask(rootDir, options.inspectTask, options.evidence || {}, options);
  const startedAt = Date.now();
  const scan = await scanContractGovernanceUniverse(rootDir, options);
  const written = options.write === false ? null : await persistContractScan(options.persistenceRoot || rootDir, scan);
  return {
    ...scan,
    durationMs: Date.now() - startedAt,
    written,
  };
}

export async function applyContractGovernanceCard(rootDir, options = {}) {
  return applyContractCardDecision(rootDir, options);
}

export async function generateContractGovernanceArtifacts(rootDir) {
  const paths = contractGovernancePaths(rootDir);
  return { kind: "contract_governance_view", registry: await readContractRegistry(rootDir), scan: await readJson(paths.currentScan, null) };
}

export async function runContractGovernanceReview(rootDir, task, evidence = {}, options = {}) {
  const result = await inspectContractTask(rootDir, task, evidence, options);
  return {
    kind: "contract_governance_review",
    at: nowIso(),
    ...result,
  };
}

export async function applyContractCardDecision(rootDir, options = {}) {
  return withContractGovernanceLock(rootDir, `apply-card:${options.cardId || "unknown"}`, () =>
    applyContractCardDecisionUnlocked(rootDir, options));
}

async function applyContractCardDecisionUnlocked(rootDir, options = {}) {
  const cardId = requireSafeId(options.cardId, "cardId");
  const decision = String(options.decision || "").trim();
  if (!new Set(["approve", "reject"]).has(decision)) {
    throw contractError("contract_decision_invalid", "decision must be approve or reject");
  }
  if (!String(options.reason || "").trim()) {
    throw contractError("contract_decision_reason_required", "contract decision requires --reason");
  }
  const paths = contractGovernancePaths(rootDir);
  const cardPath = path.join(paths.cards, `${safeCardName(cardId)}.json`);
  const card = await readJson(cardPath, null);
  if (!card) throw contractError("contract_card_missing", `contract card not found: ${cardId}`);
  if (!options.expectedFingerprint) throw contractError("contract_card_fingerprint_required", "contract decision requires expectedFingerprint");
  if (options.expectedFingerprint !== card.fingerprint) {
    throw contractError("contract_card_stale", "contract card fingerprint no longer matches");
  }
  const currentScan = await readJson(paths.currentScan, null);
  const currentCard = currentScan?.cards?.find((item) => item.id === card.id);
  if (!currentCard || currentCard.fingerprint !== card.fingerprint) {
    throw contractError("contract_card_superseded", "contract card is not part of the current scan");
  }
  let registry = await readContractRegistry(rootDir);
  if (decision === "approve") {
    if (card.candidate) await assertContractReferences(rootDir, card.candidate);
    registry = applyApprovedCard(registry, card);
  }
  const finalStatus = decision === "approve" ? "approved" : "rejected";
  const decided = {
    ...card,
    status: finalStatus,
    committed: true,
    decisionReason: String(options.reason).trim(),
    decidedAt: nowIso(),
  };
  await mkdir(paths.archiveCards, { recursive: true });
  const archivePath = path.join(paths.archiveCards, `${safeCardName(card.id)}.${Date.now()}.json`);
  await writeJsonAtomic(archivePath, { ...decided, status: "prepared", committed: false, intendedStatus: finalStatus });
  const retiredPath = `${cardPath}.${process.pid}.retired`;
  const renameFile = options.operations?.rename || rename;
  const removeFile = options.operations?.rm || rm;
  try {
    await renameFile(cardPath, retiredPath);
  } catch (error) {
    try {
      await removeFile(archivePath, { force: true });
    } catch {
      throw contractError("recovery_required", "contract card retirement failed and its prepared decision record could not be cleaned up");
    }
    throw contractError("contract_card_retire_failed", `contract card could not be retired: ${error?.message || error}`);
  }
  try {
    if (decision === "approve") await writeJsonAtomic(paths.registry, registry);
  } catch (error) {
    let restored = false;
    try {
      await renameFile(retiredPath, cardPath);
      await removeFile(archivePath, { force: true });
      restored = true;
    } catch {}
    if (!restored) throw contractError("recovery_required", "contract decision failed and the pending card could not be restored");
    throw error;
  }
  try {
    await writeJsonAtomic(archivePath, decided);
  } catch {
    throw contractError("recovery_required", "contract registry changed but the decision record could not be committed");
  }
  let cleanupWarning = null;
  try {
    await removeFile(retiredPath, { force: true });
  } catch (error) {
    cleanupWarning = `decision committed; retired card cleanup is pending: ${error?.message || error}`;
  }
  return {
    kind: "contract_governance_decision",
    status: decided.status,
    cardId: card.id,
    registryPath: decision === "approve" ? relative(rootDir, paths.registry) : null,
    archivePath: relative(rootDir, archivePath),
    cleanupWarning,
  };
}


export async function inspectContractTask(rootDir, task, evidence = {}, options = {}) {
  const controlRoot = options.controlRoot || rootDir;
  const declarations = Array.isArray(task?.contractChanges?.items) ? task.contractChanges.items : [];
  const scan = await scanContractGovernanceUniverse(rootDir, { declarations, controlRoot });
  const changedPaths = new Set((evidence.scopeResult?.changedPaths || []).map(normalizeSlash));
  const touchedCards = scan.cards.filter((card) => cardTouchesPaths(card, changedPaths));
  const findings = [];
  if (touchedCards.length > 0 && declarations.length === 0) {
    findings.push({ code: "contract_declaration_missing", cards: touchedCards.map((card) => card.id) });
  }
  for (const item of declarations) {
    const action = String(item.action || "").toLowerCase();
    if (!item.kind || !action || !String(item.summary || "").trim()) {
      findings.push({ code: "contract_declaration_incomplete", contractId: item.contractId || null });
    }
    if (new Set(["modify", "remove"]).has(action) && !String(item.compatibility || "").trim()) {
      findings.push({ code: "contract_compatibility_missing", contractId: item.contractId || null });
    }
    if (action === "remove") {
      const approval = await inspectApprovalRef(controlRoot, item);
      if (!approval.pass) findings.push({ code: "contract_destructive_approval_missing", contractId: item.contractId || null, reason: approval.reason });
    }
    const referenceFindings = await inspectContractReferences(controlRoot, item);
    findings.push(...referenceFindings.map((finding) => ({ ...finding, contractId: item.contractId || null })));
  }
  const touchedManualRequired = scan.coverage.manualRequired.filter((item) => changedPaths.has(normalizeSlash(item.sourcePath)) && !declarationCoversSource(declarations, item.sourcePath));
  for (const item of touchedManualRequired) findings.push({ code: "contract_manual_declaration_required", sourcePath: item.sourcePath, reason: item.reason });
  const touchesScanRoot = [...changedPaths].some(isContractScanPath);
  if (!scan.registryPresent && touchesScanRoot) findings.push({ code: "contract_baseline_required", changedPaths: [...changedPaths].filter(isContractScanPath) });
  if (!scan.registryPresent && findings.length === 0) return { status: "warn", summary: "contract registry is not initialized", scan, findings };
  if (touchedCards.length > 0) {
    findings.push({ code: "contract_cards_pending", cards: touchedCards.map((card) => card.id) });
  }
  return {
    status: findings.length === 0 ? "pass" : "fail",
    summary: findings.length === 0 ? "contract declarations and approved registry are aligned" : `${findings.length} contract governance finding(s)`,
    findings,
    scan,
  };
}
