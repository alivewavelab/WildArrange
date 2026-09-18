// =============================================================================
// 文件名称：verification-discovery.mjs
// 所属模块：infra
// 作用说明：
//   从 package.json/CI 等发现 verify/review 命令候选。
//
// 【运行原理速读】
//   discoverVerificationCommands → 打分排序 → 去重输出。
// =============================================================================
/**
 * Deterministic read-only discovery of verification assets and consumer evidence.
 * Never executes discovered commands and never writes business files.
 */
import { existsSync } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { extractImportSpecifiers } from "./dependency-graph.mjs";
import { collectGitChangedPaths } from "./git-diff.mjs";
import { normalizeRelativePath, pathMatchesPattern } from "./path-match.mjs";
import { loadWildArrangeConfig } from "./runtime-config.mjs";
import { hashContent } from "./runtime-store.mjs";
import {
  buildAdoptionCards,
  CARD_SCHEMA_VERSION,
  cardFingerprintPayload,
  indexTextByPath,
  isCurrentSourceOfTruth,
  REVIEW_SCRIPT_RE,
  stableStringify,
  STATIC_SCRIPT_RE,
  SUCCESSOR_MARKER_RE,
  TEST_SCRIPT_RE,
  uniqueConsumers,
} from "./verification-cards.mjs";

/**
 * EVIDENCE_GRADES：本模块对外API。
 */
export const EVIDENCE_GRADES = Object.freeze(["direct", "runner", "registered", "clue", "unknown"]);

/** 验证宇宙 walk 时跳过的目录名。 */
const EXCLUDED_DIR_NAMES = new Set([
  ".git",
  ".wildarrange",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "outputs",
  ".tmp",
  "tmp",
  ".cache",
  ".next",
  "out",
]);

/** 识别测试文件的 glob 模式（相对仓库根）。 */
const TEST_FILE_GLOBS = [
  "test/**",
  "tests/**",
  "__tests__/**",
  "**/*.test.mjs",
  "**/*.test.js",
  "**/*.test.cjs",
  "**/*.test.ts",
  "**/*.spec.mjs",
  "**/*.spec.js",
  "**/*.spec.ts",
];

/** CI 配置文件 glob 模式。 */
const CI_GLOBS = [
  ".github/workflows/**",
  ".gitlab-ci.yml",
  "azure-pipelines.yml",
  ".circleci/config.yml",
];

/** 宿主 hook / git hook 配置 glob 模式。 */
const HOOK_GLOBS = [
  ".husky/**",
  ".cursor/hooks.json",
  ".codex/hooks.json",
  ".kimi-code/**",
];

/**
 * 检测命令文本是否含 eval/require 等动态执行线索。
 */
// --- 动态代码检测 ---
export function hasDynamicCodeHint(text) {
  return /\bimport\s*\(\s*[^'"`]/.test(text) || /\beval\s*\(/.test(text) || /\bnew Function\b/.test(text);
}

/**
 * scanVerificationUniverse：本模块对外异步 API。
 */
// --- 验证宇宙扫描 ---
export async function scanVerificationUniverse(rootDir, options = {}) {
  const files = await listCandidateFiles(rootDir);
  const packageFacts = await collectPackageFacts(rootDir, files);
  const textIndex = await collectTextIndex(rootDir, files);
  const importIndex = await collectImportIndex(rootDir, files);
  const wip = await collectGitChangedPaths(rootDir).catch(() => ({ available: false, paths: [] }));
  const { config } = await loadWildArrangeConfig(rootDir).catch(() => ({ config: {} }));
  const fileSet = new Set(files.map((file) => file.path));
  const assets = classifyAssets({ files, packageFacts, textIndex, importIndex, config });
  const cards = buildAdoptionCards(assets, {
    packageFacts,
    config,
    suggestedLocator: options.suggestedLocator,
    textIndex,
    files,
    fileSet,
  });
  const universe = {
    kind: "verification_discovery",
    schemaVersion: CARD_SCHEMA_VERSION,
    fileCount: files.length,
    files: files.map((file) => file.path),
    wipPaths: wip.available ? wip.paths : [],
    gitAvailable: wip.available === true && wip.source === "git",
  };
  return {
    assets,
    cards,
    universe,
    universeFingerprint: hashContent(stableStringify({ files: universe.files, cards: cards.map(cardFingerprintPayload) })),
    scanDigest: hashContent(stableStringify({ assets, cards: cards.map(cardFingerprintPayload) })),
  };
}

/**
 * captureCardLiveSnapshot：本模块对外异步 API。
 */
// --- 卡片实时快照 ---
export async function captureCardLiveSnapshot(rootDir, card) {
  const targetDigest = await digestRelativeFile(rootDir, card?.path);
  const dependencyDigests = {};
  for (const rel of await collectLiveSnapshotPaths(rootDir, card)) {
    dependencyDigests[rel] = await digestRelativeFile(rootDir, rel);
  }
  return {
    targetDigest,
    dependencyDigests,
    evidenceDigest: hashContent(stableStringify({
      action: card?.action,
      path: card?.path,
      evidence: card?.evidence || [],
      consumers: card?.consumers || [],
      patch: card?.patch || null,
    })),
  };
}

/** consumer.by 非文件路径时的占位值（scan/动态生成等）。 */
const NON_FILE_CONSUMER_BY = new Set(["", "scan", "dynamic-or-generated"]);
/** 从文本中提取 repo 相对文件路径的全局正则（consumer 线索扫描用）。 */
const REPO_RELATIVE_FILE_RE = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+/g;

/**
 * 收集 LiveSnapshotPaths 条目。
 */
async function collectLiveSnapshotPaths(rootDir, card) {
  const depPaths = new Set(["package.json"]);
  addLiveSnapshotPath(depPaths, card?.patch?.path, card?.path);
  for (const consumer of card?.consumers || []) {
    addLiveSnapshotPath(depPaths, String(consumer?.by || "").split("#")[0], card?.path);
    for (const token of String(consumer?.evidence || "").match(REPO_RELATIVE_FILE_RE) || []) {
      addLiveSnapshotPath(depPaths, token, card?.path);
    }
  }
  for (const rel of await listKnownConsumerFiles(rootDir)) {
    addLiveSnapshotPath(depPaths, rel, card?.path);
  }
  return [...depPaths].sort();
}

/**
 * 列出 KnownConsumerFiles 条目。
 */
async function listKnownConsumerFiles(rootDir) {
  const found = [];
  for (const rel of [".cursor/hooks.json", ".husky/pre-commit"]) {
    if (existsSync(path.join(rootDir, rel))) found.push(rel);
  }
  const workflowDir = path.join(rootDir, ".github", "workflows");
  if (!existsSync(workflowDir)) return found;
  let entries = [];
  try {
    entries = await readdir(workflowDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isFile()) found.push(`.github/workflows/${entry.name}`);
  }
  return found;
}

/**
 * addLiveSnapshotPath 内部辅助。
 */
function addLiveSnapshotPath(depPaths, value, targetPath) {
  const rel = resolveConsumerFilePath(value);
  if (!rel) return;
  if (targetPath && rel === targetPath && rel !== "package.json") return;
  depPaths.add(rel);
}

/**
 * 解析 ConsumerFilePath 路径或引用，越界/逃逸抛错。
 */
function resolveConsumerFilePath(value) {
  const raw = String(value || "").trim();
  if (!raw || NON_FILE_CONSUMER_BY.has(raw)) return null;
  if (raw.includes("://") || raw.includes("\0") || /^[A-Za-z]:/.test(raw) || raw.startsWith("/")) return null;
  const normalized = normalizeRelativePath(raw.replaceAll("\\", "/"));
  if (!normalized || normalized === ".." || normalized.startsWith("../")) return null;
  if (normalized.includes("/") || /\.[A-Za-z0-9]+$/.test(normalized)) return normalized;
  return null;
}

/**
 * classifyAssets 内部辅助。
 */
function classifyAssets({ files, packageFacts, textIndex, importIndex, config }) {
  const textByPath = indexTextByPath(textIndex);
  const assets = [];
  for (const file of files) {
    const kind = classifyFileKind(file.path, packageFacts, config, textByPath.get(file.path) || "");
    if (!kind) continue;
    const consumers = findConsumers(file.path, { packageFacts, textIndex, importIndex });
    const unknown = consumers.some((consumer) => consumer.grade === "unknown") || file.dynamicHint === true;
    assets.push({
      path: file.path,
      kind,
      purpose: purposeForKind(kind, file.path, packageFacts),
      consumers,
      consumerUnknown: unknown,
      evidence: consumers.map((consumer) => consumer.evidence),
      confidence: unknown ? "unknown" : strongestConfidence(consumers),
    });
  }
  assets.sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
  return assets;
}

/**
 * classifyFileKind 内部辅助。
 */
function classifyFileKind(relativePath, packageFacts, config, headText = "") {
  if (relativePath === "wildarrange.config.json" || relativePath === ".wildarrange/config.json") return "runtime_gate";
  if (CI_GLOBS.some((pattern) => pathMatchesPattern(relativePath, pattern))) return "runtime_gate";
  if (HOOK_GLOBS.some((pattern) => pathMatchesPattern(relativePath, pattern))) return "host_hook";
  if (/(^|\/)(__fixtures__|fixtures)(\/|$)/i.test(relativePath)) return "test_fixture";
  if (TEST_FILE_GLOBS.some((pattern) => pathMatchesPattern(relativePath, pattern))) return "behavior_suite";
  if (/(^|\/)(AGENTS|TESTING|ACCEPTANCE|VERIFICATION)[^/]*\.(md|html)$/i.test(relativePath)) return "historical_archive";
  if (/(^|\/)(legacy|archive|history)\/.*\.(md|json|txt)$/i.test(relativePath)) return "historical_archive";
  if (isCurrentSourceOfTruth(relativePath) && /\.(md|html)$/i.test(relativePath)) return "historical_archive";
  if (headText && SUCCESSOR_MARKER_RE.test(String(headText).slice(0, 4096))) return "historical_archive";
  const script = packageFacts.scripts.find((item) => item.command.includes(relativePath) || item.command.endsWith(path.posix.basename(relativePath)));
  if (script) {
    if (TEST_SCRIPT_RE.test(script.name)) return "behavior_suite";
    if (STATIC_SCRIPT_RE.test(script.name)) return "static_check";
    if (REVIEW_SCRIPT_RE.test(script.name)) return "independent_review";
  }
  if (config?.qualityGates && relativePath.endsWith(".mjs") && /gate|lint|typecheck/.test(relativePath)) return "static_check";
  return null;
}

/**
 * purposeForKind 内部辅助。
 */
function purposeForKind(kind, filePath, packageFacts) {
  if (kind === "test_fixture") return `测试夹具：${filePath}`;
  if (kind === "behavior_suite") return `行为测试或 verify 入口：${filePath}`;
  if (kind === "static_check") return `静态检查入口：${filePath}`;
  if (kind === "independent_review") return `独立复核入口：${filePath}`;
  if (kind === "runtime_gate") return `运行时门或 CI 入口：${filePath}`;
  if (kind === "host_hook") return `宿主 Hook：${filePath}`;
  if (kind === "historical_archive") return `历史验证档案：${filePath}`;
  return packageFacts.scripts.find((item) => item.command.includes(filePath))?.name || filePath;
}

/**
 * 查找 Consumers 匹配项。
 */
function findConsumers(relativePath, { packageFacts, textIndex, importIndex }) {
  const consumers = [];
  const base = path.posix.basename(relativePath);
  for (const edge of importIndex.edges) {
    if (edge.to === relativePath || edge.to.endsWith(`/${base}`)) {
      consumers.push({ grade: "direct", by: edge.from, evidence: `static import ${edge.specifier}` });
    }
  }
  for (const script of packageFacts.scripts) {
    if (script.command.includes(relativePath) || script.command.includes(base)) {
      consumers.push({ grade: "runner", by: `${script.packagePath}#${script.name}`, evidence: script.command });
    }
  }
  for (const hit of textIndex.registered) {
    if (hit.text.includes(relativePath) || hit.text.includes(base)) {
      consumers.push({ grade: "registered", by: hit.path, evidence: "CI/Hook 入口文本命中" });
    }
  }
  for (const hit of textIndex.clues) {
    if (hit.path !== relativePath && (hit.text.includes(relativePath) || hit.text.includes(base))) {
      consumers.push({ grade: "clue", by: hit.path, evidence: "文档或配置字符串命中" });
    }
  }
  if (importIndex.unknown.has(relativePath) || importIndex.unknown.has(base)) {
    consumers.push({ grade: "unknown", by: "dynamic-or-generated", evidence: "动态 import / 变量 / eval / 生成配置" });
  }
  if (consumers.length === 0) {
    consumers.push({ grade: "clue", by: "scan", evidence: "未发现静态消费者" });
  }
  return uniqueConsumers(consumers);
}

/**
 * strongestConfidence 内部辅助。
 */
function strongestConfidence(consumers) {
  if (consumers.some((item) => item.grade === "unknown")) return "unknown";
  if (consumers.some((item) => item.grade === "direct")) return "high";
  if (consumers.some((item) => item.grade === "runner" || item.grade === "registered")) return "medium";
  return "low";
}

/**
 * digestRelativeFile 内部辅助。
 */
async function digestRelativeFile(rootDir, relativePath) {
  if (!relativePath) return "missing";
  const absolutePath = path.join(rootDir, relativePath);
  if (!existsSync(absolutePath)) return "missing";
  return hashContent(await readFile(absolutePath));
}

/**
 * 列出 CandidateFiles 条目。
 */
async function listCandidateFiles(rootDir) {
  const files = [];
  await walk(rootDir, "", files);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

/**
 * 递归遍历目录，跳过 ignored 目录名。
 */
async function walk(rootDir, relativeDir, files) {
  const absoluteDir = relativeDir ? path.join(rootDir, relativeDir) : rootDir;
  let entries = [];
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EACCES" || error?.code === "EPERM") return;
    throw error;
  }
  for (const entry of entries) {
    const relativePath = normalizeRelativePath(relativeDir ? `${relativeDir}/${entry.name}` : entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      await walk(rootDir, relativePath, files);
      continue;
    }
    let dynamicHint = false;
    const absolutePath = path.join(rootDir, relativePath);
    try {
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        try {
          const real = await realpath(absolutePath);
          const rootReal = await realpath(rootDir);
          if (real !== rootReal && !real.startsWith(`${rootReal}${path.sep}`)) continue;
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
    if (/\.(m?js|cjs|ts|tsx)$/.test(entry.name)) {
      const text = await readTextLimited(absolutePath);
      dynamicHint = hasDynamicCodeHint(text);
    }
    files.push({ path: relativePath, dynamicHint });
  }
}

/**
 * 收集 PackageFacts 条目。
 */
async function collectPackageFacts(rootDir, files) {
  const packages = [];
  const scripts = [];
  for (const file of files.filter((item) => path.posix.basename(item.path) === "package.json")) {
    const raw = await readTextLimited(path.join(rootDir, file.path));
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    packages.push({ path: file.path, name: parsed.name || null });
    for (const [name, command] of Object.entries(parsed.scripts || {})) {
      scripts.push({ packagePath: file.path, name, command: String(command) });
    }
  }
  scripts.sort((left, right) => left.packagePath.localeCompare(right.packagePath) || left.name.localeCompare(right.name));
  return { packages, scripts };
}

/**
 * 收集 TextIndex 条目。
 */
async function collectTextIndex(rootDir, files) {
  const registered = [];
  const clues = [];
  for (const file of files) {
    const isRegistered = [...CI_GLOBS, ...HOOK_GLOBS].some((pattern) => pathMatchesPattern(file.path, pattern));
    const isClue = /\.(md|yml|yaml|json|txt)$/.test(file.path);
    if (!isRegistered && !isClue) continue;
    const text = await readTextLimited(path.join(rootDir, file.path));
    if (isRegistered) registered.push({ path: file.path, text });
    else clues.push({ path: file.path, text });
  }
  return { registered, clues };
}

/**
 * 收集 ImportIndex 条目。
 */
async function collectImportIndex(rootDir, files) {
  const edges = [];
  const unknown = new Set();
  const codeFiles = files.filter((file) => /\.(m?js|cjs|ts|tsx)$/.test(file.path));
  for (const file of codeFiles) {
    const absolutePath = path.join(rootDir, file.path);
    const source = await readTextLimited(absolutePath);
    if (hasDynamicCodeHint(source)) {
      unknown.add(file.path);
    }
    for (const specifier of extractImportSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const resolved = normalizeRelativePath(path.posix.normalize(path.posix.join(path.posix.dirname(file.path), specifier)));
      edges.push({ from: file.path, to: resolved, specifier });
    }
  }
  return { edges, unknown };
}

/**
 * 读取 TextLimited 并返回结构化结果。
 */
async function readTextLimited(absolutePath, maxBytes = 200_000) {
  if (!existsSync(absolutePath)) return "";
  const handle = await readFile(absolutePath);
  return handle.subarray(0, maxBytes).toString("utf8");
}

