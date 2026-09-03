import { mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashContent, nowIso, readJson, writeJsonAtomic } from "./runtime-store.mjs";
import { loadWildArrangeConfig } from "./runtime-config.mjs";
import { extractImportSpecifiers, maskSource } from "./dependency-graph.mjs";

export const CONTRACT_SCHEMA_VERSION = 1;
export const CONTRACT_DISCOVERERS = Object.freeze(["tauri-ipc"]);

const SKIP_DIRS = new Set([".git", ".wildarrange", "node_modules", "target", "dist", "build", ".tmp"]);
const CONTRACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/;

export function contractGovernancePaths(rootDir) {
  const runtimeRoot = path.join(rootDir, ".wildarrange", "contracts");
  return {
    registry: path.join(rootDir, "tooling", "contracts", "contract-registry.json"),
    runtimeRoot,
    currentScan: path.join(runtimeRoot, "current-scan.json"),
    cards: path.join(runtimeRoot, "cards"),
    archiveCards: path.join(runtimeRoot, "archive", "cards"),
    archiveSnapshots: path.join(runtimeRoot, "archive", "snapshots"),
    html: path.join(rootDir, "docs", "contracts", "contract-map.html"),
  };
}

export async function readContractRegistry(rootDir) {
  const filePath = contractGovernancePaths(rootDir).registry;
  const registry = await readJson(filePath, null);
  if (!registry) return emptyContractRegistry();
  if (registry.kind !== "contract_registry" || registry.schemaVersion !== CONTRACT_SCHEMA_VERSION || !Array.isArray(registry.contracts)) {
    throw contractError("contract_registry_invalid", "contract registry has an unsupported shape");
  }
  return registry;
}

export function emptyContractRegistry() {
  return {
    kind: "contract_registry",
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    updatedAt: null,
    contracts: [],
  };
}

export async function scanContractGovernanceUniverse(rootDir, options = {}) {
  const discoverer = options.discoverer || "tauri-ipc";
  if (!CONTRACT_DISCOVERERS.includes(discoverer)) {
    throw contractError("contract_discoverer_unknown", `unknown contract discoverer: ${discoverer}`);
  }
  const registry = await readContractRegistry(rootDir);
  const discovered = await discoverTauriIpcContracts(rootDir);
  const declared = normalizeManualDeclarations(options.declarations || []);
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

export async function persistContractScan(rootDir, scan) {
  const paths = contractGovernancePaths(rootDir);
  await mkdir(paths.cards, { recursive: true });
  await archiveCurrentSnapshot(paths, scan.at);
  await writeJsonAtomic(paths.currentScan, scan);
  await archiveSupersededCards(paths, new Set(scan.cards.map((card) => card.id)));
  const writtenCards = [];
  for (const card of scan.cards) {
    const filePath = path.join(paths.cards, `${safeCardName(card.id)}.json`);
    const existing = await readJson(filePath, null);
    const value = existing?.fingerprint === card.fingerprint
      ? expirePendingCard({ ...card, createdAt: existing.createdAt || card.createdAt }, scan.at)
      : card;
    await writeJsonAtomic(filePath, value);
    writtenCards.push(relative(rootDir, filePath));
  }
  return {
    currentScan: relative(rootDir, paths.currentScan),
    cards: writtenCards,
  };
}

export async function applyContractCardDecision(rootDir, options = {}) {
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

export async function generateContractArtifacts(rootDir) {
  const paths = contractGovernancePaths(rootDir);
  const registry = await readContractRegistry(rootDir);
  const scan = await readJson(paths.currentScan, null);
  await mkdir(path.dirname(paths.html), { recursive: true });
  await writeFile(paths.html, renderContractMapHtml(registry, scan), "utf8");
  return {
    kind: "contract_governance_artifacts",
    registryPath: relative(rootDir, paths.registry),
    htmlPath: relative(rootDir, paths.html),
    contracts: registry.contracts.length,
    unknown: scan?.coverage?.unknown?.length || 0,
  };
}

export async function inspectContractTask(rootDir, task, evidence = {}) {
  const declarations = Array.isArray(task?.contractChanges?.items) ? task.contractChanges.items : [];
  const scan = await scanContractGovernanceUniverse(rootDir, { declarations });
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
      const approval = await inspectApprovalRef(rootDir, item);
      if (!approval.pass) findings.push({ code: "contract_destructive_approval_missing", contractId: item.contractId || null, reason: approval.reason });
    }
    const referenceFindings = await inspectContractReferences(rootDir, item);
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

async function inspectApprovalRef(rootDir, item) {
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

async function assertContractReferences(rootDir, contract) {
  const findings = await inspectContractReferences(rootDir, contract);
  if (findings.length > 0) {
    throw contractError("contract_reference_invalid", `contract references are invalid: ${findings.map((item) => item.code).join(", ")}`);
  }
}

export async function discoverTauriIpcContracts(rootDir) {
  const files = await walkSourceFiles(rootDir);
  const rustFiles = files.filter((item) => item.endsWith(".rs"));
  const frontendFiles = files.filter((item) => /\.(?:[cm]?[jt]sx?)$/.test(item));
  const declared = new Map();
  const registered = new Map();
  const callers = new Map();
  const manualSql = new Set();
  const unsupportedInvokeImports = new Set();
  for (const filePath of rustFiles) {
    const source = await readFile(filePath, "utf8");
    for (const found of findTauriCommands(source)) addList(declared, found.name, { path: relative(rootDir, filePath), line: lineOf(source, found.index), signature: found.signature });
    for (const found of findRegisteredCommands(source)) addList(registered, found.name, { path: relative(rootDir, filePath), line: lineOf(source, found.index) });
    if (/\b(?:CREATE|ALTER|DROP)\s+TABLE\b/i.test(source)) manualSql.add(relative(rootDir, filePath));
  }
  for (const filePath of frontendFiles) {
    const source = await readFile(filePath, "utf8");
    const bindings = tauriInvokeBindings(source);
    if (bindings.length === 0) {
      if (importsTauriApi(source)) unsupportedInvokeImports.add(relative(rootDir, filePath));
      continue;
    }
    for (const found of findFrontendInvokes(source, bindings)) addList(callers, found.name, { path: relative(rootDir, filePath), line: lineOf(source, found.index) });
  }
  const names = [...new Set([...declared.keys(), ...registered.keys(), ...callers.keys()])].sort();
  const contracts = names.map((name) => normalizeContract({
    id: `tauri:${name}`,
    kind: "tauri_command",
    name,
    source: { discoverer: "tauri-ipc", declarations: declared.get(name) || [], registrations: registered.get(name) || [] },
    callers: callers.get(name) || [],
    lifecycle: "active",
    status: declared.has(name) && registered.has(name) ? "observed" : "unknown",
    unknown: [
      ...(!declared.has(name) ? ["backend_declaration"] : []),
      ...(!registered.has(name) ? ["handler_registration"] : []),
      "semantic_input_output",
    ],
  }));
  return {
    contracts,
    scannedRoots: sourceRoots(rootDir).map((item) => relative(rootDir, item)),
    scannedFiles: files.length,
    unknown: contracts.filter((item) => item.unknown.length > 0).map((item) => ({ contractId: item.id, fields: item.unknown })),
    manualRequired: [
      ...[...manualSql].sort().map((sourcePath) => ({ kind: "database_sql_in_source", sourcePath, reason: "SQL embedded in Rust source is not parsed by the Tauri IPC discoverer" })),
      ...[...unsupportedInvokeImports].sort().map((sourcePath) => ({ kind: "tauri_invoke_import_unsupported", sourcePath, reason: "Tauri API import style is not statically understood; declare affected contracts manually" })),
    ],
  };
}

export function findTauriCommands(source) {
  const pattern = /#\s*\[\s*tauri::command(?:\([^\]]*\))?\s*\][\s\S]{0,600}?\b(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\)(?:\s*->\s*[^\{;]+)?)/g;
  return [...maskSource(String(source)).matchAll(pattern)].map((match) => ({ name: match[1], signature: `${match[1]}${match[2].trim()}`, index: match.index }));
}

export function findRegisteredCommands(source) {
  const output = [];
  const pattern = /tauri::generate_handler!\s*\[([\s\S]*?)\]/g;
  for (const block of maskSource(String(source)).matchAll(pattern)) {
    for (const item of block[1].split(",")) {
      const cleaned = item.replace(/\/\/.*$/gm, "").trim();
      const name = cleaned.split("::").pop()?.trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name || "")) output.push({ name, index: block.index });
    }
  }
  return output;
}

export function findFrontendInvokes(source, bindingNames = ["invoke"]) {
  const original = String(source);
  const masked = maskSource(original);
  const names = uniqueStrings(bindingNames).map(escapeRegExp);
  if (names.length === 0) return [];
  const pattern = new RegExp(`\\b(?:${names.join("|")})(?:\\s*<[^>]+>)?\\s*\\(`, "g");
  const found = [];
  for (const match of masked.matchAll(pattern)) {
    let cursor = match.index + match[0].length;
    while (/\s/.test(original[cursor] || "")) cursor += 1;
    const quote = original[cursor];
    if (quote !== '"' && quote !== "'") continue;
    const end = original.indexOf(quote, cursor + 1);
    if (end < 0) continue;
    const name = original.slice(cursor + 1, end);
    if (/^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name)) found.push({ name, index: match.index });
  }
  return found;
}

export function buildContractDiffCards(baseline = [], current = [], at = nowIso()) {
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
    unknown: [],
  }), declarationAction: String(item.action || "add").toLowerCase() }));
}

function withoutDeclarationAction(item) {
  const { declarationAction: _ignored, ...contract } = item;
  return contract;
}

function approvedOverlay(item) {
  return {
    id: item.id,
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

function mergeContracts(discovered, manual) {
  const merged = new Map(discovered.map((item) => [item.id, item]));
  for (const item of manual) {
    const existing = merged.get(item.id);
    merged.set(item.id, existing ? {
      ...existing,
      ...item,
      source: { ...existing.source, manualApproved: true, manualDeclarations: item.source.declarations || [] },
      callers: existing.callers || [],
    } : item);
  }
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeContract(value) {
  const id = requireSafeId(value.id, "contract id");
  return {
    ...value,
    id,
    kind: String(value.kind || "unknown"),
    name: String(value.name || id),
    lifecycle: String(value.lifecycle || "active"),
    verificationRefs: uniqueStrings(value.verificationRefs || []),
    unknown: uniqueStrings(value.unknown || []),
  };
}

function applyApprovedCard(registry, card) {
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

async function archiveCurrentSnapshot(paths, at) {
  const previous = await readJson(paths.currentScan, null);
  if (!previous) return;
  await mkdir(paths.archiveSnapshots, { recursive: true });
  const stamp = String(at || nowIso()).replace(/[^A-Za-z0-9_-]/g, "-");
  await rename(paths.currentScan, path.join(paths.archiveSnapshots, `${stamp}.json`));
}

async function archiveSupersededCards(paths, currentIds) {
  let entries = [];
  try { entries = await readdir(paths.cards); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  for (const name of entries.filter((entry) => entry.endsWith(".json"))) {
    const sourcePath = path.join(paths.cards, name);
    const card = await readJson(sourcePath, null);
    if (!card?.id || currentIds.has(card.id)) continue;
    await mkdir(paths.archiveCards, { recursive: true });
    const archived = { ...card, status: "superseded", supersededAt: nowIso() };
    const archivePath = path.join(paths.archiveCards, `${safeCardName(card.id)}.${Date.now()}.json`);
    await writeJsonAtomic(archivePath, archived);
    await rm(sourcePath, { force: true });
  }
}

function expirePendingCard(card, at) {
  const age = Date.parse(at) - Date.parse(card.createdAt);
  return Number.isFinite(age) && age >= 30 * 24 * 60 * 60 * 1000 ? { ...card, status: "expired" } : card;
}

function cardTouchesPaths(card, changedPaths) {
  if (changedPaths.size === 0) return false;
  const paths = [card.baseline, card.candidate].flatMap(contractSourcePaths);
  return paths.some((item) => changedPaths.has(normalizeSlash(item)));
}

function declarationCoversSource(declarations, sourcePath) {
  const normalized = normalizeSlash(sourcePath);
  return declarations.some((item) => item.kind === "database" && (item.sourcePaths || []).map(normalizeSlash).includes(normalized));
}

function isContractScanPath(value) {
  const normalized = normalizeSlash(value);
  return /(^|\/)src-tauri\/src\/.*\.rs$/.test(normalized) || /(^|\/)client\/src\/.*\.(?:[cm]?[jt]sx?)$/.test(normalized);
}

function contractSourcePaths(contract) {
  if (!contract?.source) return [];
  return [...(contract.source.declarations || []), ...(contract.source.registrations || []), ...(contract.source.manualDeclarations || []), ...(contract.callers || [])].map((item) => item.path).filter(Boolean);
}

async function walkSourceFiles(rootDir) {
  const files = [];
  for (const sourceRoot of sourceRoots(rootDir)) await walk(sourceRoot, files);
  return [...new Set(files)];
}

function sourceRoots(rootDir) {
  return [path.join(rootDir, "src"), path.join(rootDir, "client", "src"), path.join(rootDir, "src-tauri", "src"), path.join(rootDir, "client", "src-tauri", "src")];
}

async function walk(directory, output) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  for (const entry of entries) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute, output);
    else if (/\.(?:rs|[cm]?[jt]sx?)$/.test(entry.name)) output.push(absolute);
  }
}

function renderContractMapHtml(registry, scan) {
  const cards = registry.contracts.map((item) => `<section><h2>${escapeHtml(item.name)}</h2><p><code>${escapeHtml(item.id)}</code> · ${escapeHtml(item.kind)} · ${escapeHtml(item.lifecycle)}</p><p>来源：${escapeHtml(contractSourcePaths(item).join(", ") || "人工登记")}</p><p>验证引用：${escapeHtml((item.verificationRefs || []).join(", ") || "未登记")}</p></section>`).join("\n");
  const unknown = (scan?.coverage?.unknown || []).map((item) => `<li>${escapeHtml(item.contractId)}：${escapeHtml((item.fields || []).join(", "))}</li>`).join("");
  const manual = (scan?.coverage?.manualRequired || []).map((item) => `<li>${escapeHtml(item.sourcePath)}：${escapeHtml(item.reason)}</li>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>项目契约总图</title><style>body{max-width:980px;margin:32px auto;padding:0 16px;background:#091019;color:#e7eef7;font:15px/1.6 system-ui}section{border:1px solid #294057;background:#111c29;padding:16px;margin:12px 0;border-radius:8px}code{color:#ffd978}.warn{border-left:4px solid #f6c85f}</style></head><body><h1>接口与数据库契约总图</h1><p>正式契约 ${registry.contracts.length} 项；本页由机器台账生成，不可手改。</p>${cards || "<section><p>尚无已批准契约。</p></section>"}<section class="warn"><h2>未知区域</h2><ul>${unknown || "<li>无</li>"}</ul><h2>需要人工申报</h2><ul>${manual || "<li>无</li>"}</ul></section></body></html>\n`;
}

function contractFingerprint(value) {
  const copy = { ...value };
  delete copy.approvedAt;
  delete copy.retiredAt;
  return hashContent(JSON.stringify(sortObject(copy)));
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

function addList(map, key, value) {
  map.set(key, [...(map.get(key) || []), value]);
}

function lineOf(source, index) {
  return String(source).slice(0, index).split("\n").length;
}

function importsTauriApi(source) {
  const specifiers = extractImportSpecifiers(source);
  return specifiers.some((item) => item === "@tauri-apps/api/core" || item === "@tauri-apps/api/tauri");
}

function tauriInvokeBindings(source) {
  if (!importsTauriApi(source)) return [];
  const original = String(source);
  const masked = maskSource(original);
  const pattern = /\bimport\s*\{([^}]*)\}\s*from\s*(["'])(@tauri-apps\/api\/(?:core|tauri))\2/g;
  const bindings = [];
  for (const match of original.matchAll(pattern)) {
    if (masked.slice(match.index, match.index + 6) !== "import") continue;
    for (const part of match[1].split(",")) {
      const imported = part.trim().match(/^invoke(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (imported) bindings.push(imported[1] || "invoke");
    }
  }
  return uniqueStrings(bindings);
}

function safeCardName(value) {
  return requireSafeId(value, "card id").replace(/[^A-Za-z0-9._-]/g, "_");
}

function requireSafeId(value, label) {
  const normalized = String(value || "").trim();
  if (!CONTRACT_ID_RE.test(normalized)) throw contractError("contract_id_invalid", `${label} is invalid`);
  return normalized;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
}

function normalizeSlash(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function relative(rootDir, value) {
  return normalizeSlash(path.relative(rootDir, value));
}

function pathInside(rootDir, absolutePath) {
  const rel = path.relative(path.resolve(rootDir), path.resolve(absolutePath));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function realpathInside(rootDir, absolutePath) {
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(rootDir), realpath(absolutePath)]);
    return pathInside(realRoot, realTarget);
  } catch {
    return false;
  }
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function contractError(code, message) {
  return Object.assign(new Error(message), { code });
}
