// =============================================================================
// 文件名称：contract-governance.mjs
// 所属模块：capabilities
// 作用说明：
//   契约治理能力：扫描契约宇宙、生成差异卡、审查任务 contractChanges、
//   应用人类批准的差异卡（含事务回滚）。registry/锁/路径等存储原语在 infra。
//
// 【运行原理速读】
//   · 何时执行？review gate 的 contract_governance lane；CLI contracts 子命令。
//   · 做了什么？scan → 比对变更与声明 → apply-card 原子更新 registry。
//   · 缺了它会怎样？公开契约变更可绕过声明与审批直接合入。
// =============================================================================
import { mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { hashContent, nowIso, readJson, writeJsonAtomic } from "../infra/runtime-store.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { uniqueStrings } from "../infra/text-utils.mjs";
import {
  CONTRACT_SCHEMA_VERSION,
  contractError,
  contractGovernancePaths,
  contractSourcePaths,
  normalizeSlash,
  persistContractScan,
  readContractRegistry,
  relative,
  requireSafeId,
  safeCardName,
  withContractGovernanceLock,
} from "../infra/contract-governance.mjs";
import { discoverTauriIpcContracts, hasTauriRustRoot, normalizeContract } from "./contract-discovery.mjs";

// --- 扫描、差异卡与批准 ---
/**
 * scanContractGovernanceUniverse：本模块对外异步 API。
 */
export async function scanContractGovernanceUniverse(rootDir, options = {}) {
  const discoverer = "tauri-ipc";
  const registry = await readContractRegistry(options.projectRoot || rootDir);
  const declared = normalizeManualDeclarations(options.declarations || []);
  // 无 registry、无声明且无 Rust 侧扫描根时，契约治理未启用：不必每次 review 遍历全仓源码
  const enabled = registry.updatedAt !== null || registry.contracts.length > 0 || declared.length > 0 || hasTauriRustRoot(rootDir);
  const discovered = enabled ? await discoverTauriIpcContracts(rootDir) : { contracts: [], scannedRoots: [], scannedFiles: 0, unknown: [], manualRequired: [] };
  const declaredIds = new Set(declared.map((item) => item.id));
  const removalIds = new Set(declared.filter((item) => item.declarationAction === "remove").map((item) => item.id));
  const manual = declared.filter((item) => item.declarationAction !== "remove").map(withoutDeclarationAction);
  const carriedManual = registry.contracts.filter((item) => item.source?.discoverer === "manual" && item.lifecycle !== "retired" && !declaredIds.has(item.id));
  const carriedOverlays = registry.contracts.filter((item) => item.source?.manualApproved === true && item.lifecycle !== "retired" && !declaredIds.has(item.id)).map(approvedOverlay);
  const discoveredContracts = discovered.contracts.filter((item) => !removalIds.has(item.id));
  const contracts = mergeContracts([...discoveredContracts, ...carriedManual], [...carriedOverlays, ...manual]);
  const cards = buildContractDiffCards(registry.contracts, contracts, options.at || nowIso());
  return {
    kind: "contract_governance_scan",
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    at: options.at || nowIso(),
    discoverer,
    registryPresent: registry.updatedAt !== null || registry.contracts.length > 0,
    contracts,
    observedContracts: discovered.contracts,
    cards,
    coverage: {
      discoverer,
      scannedRoots: discovered.scannedRoots,
      scannedFiles: discovered.scannedFiles,
      discoveredContracts: discovered.contracts.length,
      manualContracts: declared.length,
      unknown: discovered.unknown,
      manualRequired: discovered.manualRequired,
    },
  };
}

/**
 * buildContractDiffCards：本模块对外API。
 */
function buildContractDiffCards(baseline = [], current = [], at = nowIso()) {
  const before = new Map(baseline.filter((item) => item.lifecycle !== "retired").map((item) => [item.id, normalizeContract(item)]));
  const after = new Map(current.map((item) => [item.id, normalizeContract(item)]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  return ids.flatMap((id) => {
    const oldValue = before.get(id) || null;
    const newValue = after.get(id) || null;
    if (oldValue && newValue && contractFingerprint(oldValue) === contractFingerprint(newValue)) return [];
    const action = !oldValue ? "add" : !newValue ? "remove" : "modify";
    const fingerprint = hashContent(JSON.stringify({ id, action, oldValue, newValue }));
    return [{
      id: `contract-card:${fingerprint.slice(0, 16)}`,
      contractId: id,
      action,
      status: "pending",
      createdAt: at,
      fingerprint,
      baseline: oldValue,
      candidate: newValue,
    }];
  });
}

/**
 * 归一化 ManualDeclarations 输入为稳定形态。
 */
function normalizeManualDeclarations(items) {
  return items.map((item, index) => ({ ...normalizeContract({
    id: requireSafeId(item.contractId || item.id || `manual:${index + 1}`, `declaration ${index + 1} contractId`),
    kind: item.kind || "manual",
    name: item.name || item.summary || item.contractId || `manual declaration ${index + 1}`,
    summary: item.summary || "",
    compatibility: item.compatibility || "",
    migration: item.migration || "",
    rollback: item.rollback || "",
    verificationRefs: uniqueStrings(item.verificationRefs || []),
    moduleRef: item.moduleRef || null,
    ownerRef: item.ownerRef || null,
    source: { discoverer: "manual", declarations: uniqueStrings(item.sourcePaths || []).map((sourcePath) => ({ path: normalizeSlash(sourcePath) })) },
    lifecycle: "active",
    status: "declared",
    expected: item.expected || null,
    unknown: [],
  }), declarationAction: String(item.action || "add").toLowerCase() }));
}

/**
 * withoutDeclarationAction 内部辅助。
 */
function withoutDeclarationAction(item) {
  const { declarationAction: _ignored, ...contract } = item;
  return contract;
}

/**
 * approvedOverlay 内部辅助。
 */
function approvedOverlay(item) {
  return {
    id: item.id,
    expected: item.expected ?? null,
    kind: item.kind,
    name: item.name,
    summary: item.summary || "",
    compatibility: item.compatibility || "",
    migration: item.migration || "",
    rollback: item.rollback || "",
    verificationRefs: item.verificationRefs || [],
    moduleRef: item.moduleRef || null,
    ownerRef: item.ownerRef || null,
    source: { discoverer: "manual", declarations: item.source.manualDeclarations || [] },
    lifecycle: "active",
    status: "declared",
    unknown: [],
  };
}

/**
 * 合并 Contracts 集合/对象。
 */
function mergeContracts(discovered, manual) {
  const merged = new Map(discovered.map((item) => [item.id, item]));
  for (const item of manual) {
    const existing = merged.get(item.id);
    merged.set(item.id, existing ? {
      ...existing,
      ...item,
      source: { ...existing.source, manualApproved: true, manualDeclarations: item.source.declarations || [] },
      callers: existing.callers || [],
      unknown: existing.unknown || [],
    } : item);
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * contractFingerprint 内部辅助。
 */
function contractFingerprint(value) {
  const copy = { ...value };
  delete copy.approvedAt;
  delete copy.retiredAt;
  return hashContent(JSON.stringify(sortObject(copy)));
}

/**
 * sortObject 内部辅助。
 */
function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

/**
 * applyApprovedCard：本模块对外API。
 */
export function applyApprovedCard(registry, card) {
  const contracts = new Map(registry.contracts.map((item) => [item.id, item]));
  if (card.action === "remove") {
    const existing = contracts.get(card.contractId);
    if (existing) contracts.set(card.contractId, { ...existing, lifecycle: "retired", retiredAt: nowIso() });
  } else if (card.candidate) {
    contracts.set(card.contractId, { ...card.candidate, approvedAt: nowIso() });
  }
  return {
    kind: "contract_registry",
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    updatedAt: nowIso(),
    contracts: [...contracts.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * cardTouchesPaths：本模块对外API。
 */
export function cardTouchesPaths(card, changedPaths) {
  if (changedPaths.size === 0) return false;
  const paths = [card.baseline, card.candidate].flatMap(contractSourcePaths);
  return paths.some((item) => changedPaths.has(normalizeSlash(item)));
}

/**
 * declarationCoversSource：本模块对外API。
 */
export function declarationCoversSource(declarations, sourcePath) {
  const normalized = normalizeSlash(sourcePath);
  return declarations.some((item) => item.kind === "database" && (item.sourcePaths || []).map(normalizeSlash).includes(normalized));
}

/**
 * isContractScanPath：本模块对外API。
 */
export function isContractScanPath(value) {
  const normalized = normalizeSlash(value);
  return /(^|\/)src-tauri\/src\/.*\.rs$/.test(normalized) || /(^|\/)client\/src\/.*\.(?:[cm]?[jt]sx?)$/.test(normalized);
}

/**
 * inspectContractReferences：本模块对外异步 API。
 */
export async function inspectContractReferences(rootDir, contract) {
  const findings = [];
  if (contract.moduleRef) {
    const moduleMap = await readJson(path.join(rootDir, "tooling", "arch-module-graph", "module-file-map.json"), null);
    if (!moduleMap?.modules || !Object.hasOwn(moduleMap.modules, contract.moduleRef)) {
      findings.push({ code: "contract_module_ref_unknown", ref: contract.moduleRef });
    }
  }
  const refs = uniqueStrings(contract.verificationRefs || []);
  if (refs.length > 0) {
    const loaded = await loadWildArrangeConfig(rootDir);
    const registryPath = loaded.config?.verificationGovernance?.registryPath;
    const absolute = registryPath ? path.resolve(rootDir, registryPath) : null;
    if (!absolute || !await realpathInside(rootDir, absolute)) {
      findings.push({ code: "contract_verification_registry_unavailable", refs });
    } else {
      const registry = await readJson(absolute, null);
      const known = new Set((registry?.cards || []).map((item) => item.id));
      for (const ref of refs) if (!known.has(ref)) findings.push({ code: "contract_verification_ref_unknown", ref });
    }
  }
  return findings;
}

/**
 * inspectApprovalRef：本模块对外异步 API。
 */
export async function inspectApprovalRef(rootDir, item) {
  const approvalRef = String(item.approvalRef || "").trim();
  if (!approvalRef) return { pass: false, reason: "approvalRef is missing" };
  const paths = contractGovernancePaths(rootDir);
  let entries = [];
  try { entries = await readdir(paths.archiveCards); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  for (const name of entries.filter((entry) => entry.endsWith(".json"))) {
    const record = await readJson(path.join(paths.archiveCards, name), null);
    if (record?.id === approvalRef && record.status === "approved" && record.committed === true && record.contractId === item.contractId && record.action === "remove") {
      return { pass: true, record };
    }
  }
  return { pass: false, reason: "approvalRef does not identify an approved remove decision for this contract" };
}

/**
 * assertContractReferences：本模块对外异步 API。
 */
export async function assertContractReferences(rootDir, contract) {
  const findings = await inspectContractReferences(rootDir, contract);
  if (findings.length > 0) {
    throw contractError("contract_reference_invalid", `contract references are invalid: ${findings.map((item) => item.code).join(", ")}`);
  }
}

/**
 * pathInside 内部辅助。
 */
function pathInside(rootDir, absolutePath) {
  const rel = path.relative(path.resolve(rootDir), path.resolve(absolutePath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * realpathInside 内部辅助。
 */
async function realpathInside(rootDir, absolutePath) {
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(rootDir), realpath(absolutePath)]);
    return pathInside(realRoot, realTarget);
  } catch {
    return false;
  }
}

// --- 对外能力入口 ---
/**
 * 扫描契约治理宇宙；inspectTask 时转为任务审查模式。
 * @param {string} rootDir 项目根
 * @param {object} [options] inspectTask、write、persistenceRoot
 * @returns {Promise<object>} 扫描结果，含 durationMs 与可选 written 路径
 */
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

/**
 * 应用契约差异卡（approve/reject）的公开入口，内部加锁。
 * @param {string} rootDir 项目根
 * @param {object} [options] cardId、decision、reason、expectedFingerprint
 * @returns {Promise<object>} kind=contract_governance_decision
 */
export async function applyContractGovernanceCard(rootDir, options = {}) {
  return applyContractCardDecision(rootDir, options);
}

/**
 * 对任务执行契约治理审查，包装为 review gate 可用的 evidence 形态。
 * @param {string} rootDir 执行根
 * @param {object} task 含 contractChanges
 * @param {object} [evidence] scopeResult 等
 * @param {object} [options] projectRoot
 * @returns {Promise<object>} kind=contract_governance_review
 */
export async function runContractGovernanceReview(rootDir, task, evidence = {}, options = {}) {
  const result = await inspectContractTask(rootDir, task, evidence, options);
  return {
    kind: "contract_governance_review",
    at: nowIso(),
    ...result,
  };
}

/**
 * 在文件锁保护下执行差异卡决策（approve/reject），含回滚与归档。
 * @param {string} rootDir 项目根目录
 * @param {object} options cardId、decision、reason、expectedFingerprint
 */
export async function applyContractCardDecision(rootDir, options = {}) {
  return withContractGovernanceLock(rootDir, `apply-card:${options.cardId || "unknown"}`, () =>
    applyContractCardDecisionUnlocked(rootDir, options));
}

/** 无锁状态下执行差异卡决策：归档、更新 registry、失败时回滚 pending 卡。 */
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
  // §3.4：指纹不匹配说明卡内容已被新 scan 覆盖，禁止基于 stale 卡做决策。
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
    // §3.4：registry 写入失败时尽量恢复 pending 卡，避免卡消失而 registry 未变。
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


/**
 * 审查任务的 contractChanges 是否与扫描结果、registry 及变更路径对齐。
 * @returns {Promise<object>} status 为 pass|fail|warn，含 findings 与 scan
 */
export async function inspectContractTask(rootDir, task, evidence = {}, options = {}) {
  const projectRoot = options.projectRoot || rootDir;
  const declarations = Array.isArray(task?.contractChanges?.items) ? task.contractChanges.items : [];
  const scan = await scanContractGovernanceUniverse(rootDir, { declarations, projectRoot });
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
      const approval = await inspectApprovalRef(projectRoot, item);
      if (!approval.pass) findings.push({ code: "contract_destructive_approval_missing", contractId: item.contractId || null, reason: approval.reason });
    }
    const referenceFindings = await inspectContractReferences(projectRoot, item);
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
