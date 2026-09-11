import { mkdir, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { hashContent, nowIso, readJson, writeJsonAtomic } from "./runtime-store.mjs";
import { loadWildArrangeConfig } from "./runtime-config.mjs";
import { extractImportSpecifiers, maskSource } from "./dependency-graph.mjs";
import { withFileLock } from "./file-lock.mjs";

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
  const registry = await readContractRegistry(options.controlRoot || rootDir);
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

export async function persistContractScan(rootDir, scan) {
  return withContractGovernanceLock(rootDir, "persist-scan", () => persistContractScanUnlocked(rootDir, scan));
}

async function persistContractScanUnlocked(rootDir, scan) {
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

export async function withContractGovernanceLock(rootDir, ownerTag, fn) {
  const paths = contractGovernancePaths(rootDir);
  await mkdir(paths.runtimeRoot, { recursive: true });
  return withFileLock(
    rootDir,
    path.join(paths.runtimeRoot, "governance.lock"),
    "contract governance lock",
    `contract-governance:${ownerTag}`,
    fn,
  );
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

export async function assertContractReferences(rootDir, contract) {
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
    expected: item.expected || null,
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

export function cardTouchesPaths(card, changedPaths) {
  if (changedPaths.size === 0) return false;
  const paths = [card.baseline, card.candidate].flatMap(contractSourcePaths);
  return paths.some((item) => changedPaths.has(normalizeSlash(item)));
}

export function declarationCoversSource(declarations, sourcePath) {
  const normalized = normalizeSlash(sourcePath);
  return declarations.some((item) => item.kind === "database" && (item.sourcePaths || []).map(normalizeSlash).includes(normalized));
}

export function isContractScanPath(value) {
  const normalized = normalizeSlash(value);
  return /(^|\/)src-tauri\/src\/.*\.rs$/.test(normalized) || /(^|\/)client\/src\/.*\.(?:[cm]?[jt]sx?)$/.test(normalized);
}

export function contractSourcePaths(contract) {
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

export function safeCardName(value) {
  return requireSafeId(value, "card id").replace(/[^A-Za-z0-9._-]/g, "_");
}

export function requireSafeId(value, label) {
  const normalized = String(value || "").trim();
  if (!CONTRACT_ID_RE.test(normalized)) throw contractError("contract_id_invalid", `${label} is invalid`);
  return normalized;
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))];
}

export function normalizeSlash(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

export function relative(rootDir, value) {
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function contractError(code, message) {
  return Object.assign(new Error(message), { code });
}
