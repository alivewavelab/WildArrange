// =============================================================================
// 文件名称：contract-governance.mjs
// 所属模块：infra
// 作用说明：
//   契约台账的存储原语：registry 路径与读写、扫描快照/差异卡落盘归档、治理锁、
//   ID/路径小工具。扫描、差异卡生成、批准与审查等业务在 capabilities/contract-governance.mjs。
//
// 【运行原理速读】
//   路径解析（外置模式归治理仓） → 加锁 → 原子写 current-scan/cards → 归档被取代的卡。
// =============================================================================
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { nowIso, readJson, resolveGovernancePaths, resolveWildArrangePath, writeJsonAtomic } from "./runtime-store.mjs";
import { withFileLock } from "./file-lock.mjs";

/** 契约 registry / scan 的 schema 版本。 */
export const CONTRACT_SCHEMA_VERSION = 1;
/** 合法 contract id 格式（单段、最长 200 字符）。 */
const CONTRACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/;

/**
 * contractGovernancePaths：本模块对外API。
 */
export function contractGovernancePaths(rootDir) {
  // 运行态目录走运行态根；台账与总图归治理仓，客户项目零写入
  const runtimeRoot = resolveWildArrangePath(rootDir, "contracts");
  const governanceRoot = resolveGovernancePaths(rootDir).rootDir;
  return {
    registry: path.join(governanceRoot, "contracts", "contract-registry.json"),
    runtimeRoot,
    currentScan: path.join(runtimeRoot, "current-scan.json"),
    cards: path.join(runtimeRoot, "cards"),
    archiveCards: path.join(runtimeRoot, "archive", "cards"),
    archiveSnapshots: path.join(runtimeRoot, "archive", "snapshots"),
    html: path.join(governanceRoot, "contracts", "contract-map.html"),
  };
}

/**
 * readContractRegistry：本模块对外异步 API。
 */
export async function readContractRegistry(rootDir) {
  const filePath = contractGovernancePaths(rootDir).registry;
  const registry = await readJson(filePath, null);
  if (!registry) return emptyContractRegistry();
  if (registry.kind !== "contract_registry" || registry.schemaVersion !== CONTRACT_SCHEMA_VERSION || !Array.isArray(registry.contracts)) {
    throw contractError("contract_registry_invalid", "contract registry has an unsupported shape");
  }
  return registry;
}

/**
 * emptyContractRegistry：本模块对外API。
 */
function emptyContractRegistry() {
  return {
    kind: "contract_registry",
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    updatedAt: null,
    contracts: [],
  };
}

/**
 * persistContractScan：本模块对外异步 API。
 */
export async function persistContractScan(rootDir, scan) {
  return withContractGovernanceLock(rootDir, "persist-scan", () => persistContractScanUnlocked(rootDir, scan));
}

/**
 * 在无锁前提下持久化契约扫描结果并归档 superseded cards。
 */
async function persistContractScanUnlocked(rootDir, scan) {
  const paths = contractGovernancePaths(rootDir);
  await mkdir(paths.cards, { recursive: true });
  // §3.4 锁顺序：先归档 current-scan 再写入新扫描，失败时可从 archive 回滚。
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

/**
 * withContractGovernanceLock：本模块对外异步 API。
 */
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

/**
 * archiveCurrentSnapshot 内部辅助。
 */
async function archiveCurrentSnapshot(paths, at) {
  const previous = await readJson(paths.currentScan, null);
  if (!previous) return;
  await mkdir(paths.archiveSnapshots, { recursive: true });
  const stamp = String(at || nowIso()).replace(/[^A-Za-z0-9_-]/g, "-");
  await rename(paths.currentScan, path.join(paths.archiveSnapshots, `${stamp}.json`));
}

/**
 * archiveSupersededCards 内部辅助。
 */
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

/**
 * expirePendingCard 内部辅助。
 */
function expirePendingCard(card, at) {
  const age = Date.parse(at) - Date.parse(card.createdAt);
  return Number.isFinite(age) && age >= 30 * 24 * 60 * 60 * 1000 ? { ...card, status: "expired" } : card;
}

/**
 * contractSourcePaths：本模块对外API。
 */
export function contractSourcePaths(contract) {
  if (!contract?.source) return [];
  return [...(contract.source.declarations || []), ...(contract.source.registrations || []), ...(contract.source.manualDeclarations || []), ...(contract.callers || [])].map((item) => item.path).filter(Boolean);
}

/**
 * safeCardName：本模块对外API。
 */
export function safeCardName(value) {
  return requireSafeId(value, "card id").replace(/[^A-Za-z0-9._-]/g, "_");
}

/**
 * requireSafeId：本模块对外API。
 */
export function requireSafeId(value, label) {
  const normalized = String(value || "").trim();
  if (!CONTRACT_ID_RE.test(normalized)) throw contractError("contract_id_invalid", `${label} is invalid`);
  return normalized;
}

/**
 * normalizeSlash：本模块对外API。
 */
export function normalizeSlash(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * relative：本模块对外API。
 */
export function relative(rootDir, value) {
  return normalizeSlash(path.relative(rootDir, value));
}

/**
 * contractError：本模块对外API。
 */
export function contractError(code, message) {
  return Object.assign(new Error(message), { code });
}
