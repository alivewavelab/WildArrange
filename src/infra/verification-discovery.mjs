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

export const CARD_ACTIONS = Object.freeze(["adopt", "change", "merge", "archive", "delete", "defer"]);
export const EVIDENCE_GRADES = Object.freeze(["direct", "runner", "registered", "clue", "unknown"]);
export const DANGEROUS_ACTIONS = Object.freeze(["archive", "merge", "delete"]);
export const CARD_SCHEMA_VERSION = 1;
const ACTIVE_CONSUMER_GRADES = new Set(["direct", "runner", "registered"]);
const OFFICIAL_NPM_SHORTCUTS = new Set(["test", "start", "stop", "restart", "lint"]);
const SUCCESSOR_MARKER_RE = /successor|superseded by|replaced by|归档至|历史方案/i;
const CURRENT_SOURCE_RES = [
  /(^|\/)AGENTS\.md$/i,
  /(^|\/)CLAUDE\.md$/i,
  /(^|\/)package\.json$/i,
  /(^|\/)wildarrange\.config\.json$/i,
  /(^|\/)packs\/[^/]+\/skills\//,
  /(^|\/)\.agents\/skills\//,
  /(^|\/)\.cursor\/skills\//,
];

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

const CI_GLOBS = [
  ".github/workflows/**",
  ".gitlab-ci.yml",
  "azure-pipelines.yml",
  ".circleci/config.yml",
];

const HOOK_GLOBS = [
  ".husky/**",
  ".cursor/hooks.json",
  ".codex/hooks.json",
  ".kimi-code/**",
];

const STATIC_SCRIPT_RE = /^(lint|typecheck|types|format|fmt|eslint|tsc|check)([:_-]|$)/i;
const REVIEW_SCRIPT_RE = /^(review|audit|inspect)([:_-]|$)/i;
const TEST_SCRIPT_RE = /^(test|verify|coverage|spec)([:_-]|$)/i;
const DYNAMIC_HINT_RE = /\bimport\s*\(|\beval\s*\(|\bnew Function\b|\brequire\s*\(\s*[^'"`]/;

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

export function fingerprintCard(card) {
  return hashContent(stableStringify(cardFingerprintPayload(card)));
}

export function cardAllowsDangerousAction(card) {
  const unknown = card.consumers?.some((consumer) => consumer.grade === "unknown") || card.confidence === "unknown";
  return !unknown;
}

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

const NON_FILE_CONSUMER_BY = new Set(["", "scan", "dynamic-or-generated"]);
const REPO_RELATIVE_FILE_RE = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+/g;

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

function addLiveSnapshotPath(depPaths, value, targetPath) {
  const rel = resolveConsumerFilePath(value);
  if (!rel) return;
  if (targetPath && rel === targetPath && rel !== "package.json") return;
  depPaths.add(rel);
}

function resolveConsumerFilePath(value) {
  const raw = String(value || "").trim();
  if (!raw || NON_FILE_CONSUMER_BY.has(raw)) return null;
  if (raw.includes("://") || raw.includes("\0") || /^[A-Za-z]:/.test(raw) || raw.startsWith("/")) return null;
  const normalized = normalizeRelativePath(raw.replaceAll("\\", "/"));
  if (!normalized || normalized === ".." || normalized.startsWith("../")) return null;
  if (normalized.includes("/") || /\.[A-Za-z0-9]+$/.test(normalized)) return normalized;
  return null;
}

function cardFingerprintPayload(card) {
  const { status: _status, ...rest } = card;
  return rest;
}

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

export function buildAdoptionCards(assets, options = {}) {
  const cards = [];
  const packageFacts = options.packageFacts || { scripts: [], packages: [] };
  const existingCommands = collectExistingCommands(options.config);
  const locator = options.suggestedLocator || configuredLocator(options.config) || suggestLocator(assets);
  const usedPaths = new Set();
  const textIndex = options.textIndex || { registered: [], clues: [] };
  const files = options.files || [];
  const fileSet = options.fileSet || new Set(files.map((file) => file.path || file));
  const cardContext = {
    packageFacts,
    existingCommands,
    textIndex,
    files,
    fileSet,
    textByPath: indexTextByPath(textIndex),
  };

  if (locator) {
    cards.push(makeCard({
      action: "adopt",
      asset: "config_locator",
      path: "wildarrange.config.json",
      owner: "verification-governance",
      purpose: "记录 Registry / Bootstrap / Inventory 三个正式文件的逻辑定位",
      consumers: [{ grade: "registered", by: "wildarrange.config.json", evidence: "optional verificationGovernance locator" }],
      evidence: ["locator is configuration, not a gate"],
      confidence: "high",
      reason: "扫描建议正式文件落点，需用户批准后才写入 locator，init 不会静默创建三文件",
      afterState: `verificationGovernance.registryPath=${locator.registryPath}`,
      maxConsequence: "只增加三个路径标签，不改变现有质量门",
      patch: { kind: "json_merge", path: "wildarrange.config.json", value: { verificationGovernance: locator } },
      verify: [],
      rollback: "删除或还原 verificationGovernance 段",
      mappingLoss: null,
    }));
  }

  for (const asset of assets) {
    if (usedPaths.has(`${asset.action || ""}:${asset.path}`)) continue;
    const card = cardForAsset(asset, cardContext);
    if (!card) continue;
    if (card.action === "change" || card.action === "delete") {
      card.action = "defer";
      card.reason = `${card.reason}；扫描器不生成 change/delete 卡`;
      card.patch = null;
    }
    if (DANGEROUS_ACTIONS.includes(card.action) && !cardAllowsDangerousAction(card)) {
      card.action = "defer";
      card.reason = `${card.reason}；消费者未知，已降为暂缓，不提供合并/删除/归档`;
      card.patch = null;
    }
    usedPaths.add(`${card.action}:${card.path}`);
    cards.push(card);
  }

  const scriptGroups = groupEquivalentScripts(packageFacts.scripts);
  for (const group of scriptGroups) {
    if (group.names.length < 2) continue;
    const keep = pickKeepScriptName(group.names);
    const drop = group.names.filter((name) => name !== keep);
    const dropConsumers = uniqueConsumers(drop.flatMap((name) => findScriptNameConsumers(name, {
      packageFacts,
      textIndex,
      packagePath: group.packagePath,
    })));
    const unknown = group.unknown === true;
    const blocked = unknown || dropConsumers.length > 0;
    const reason = unknown
      ? "发现动态或变量脚本引用，无法安全合并"
      : dropConsumers.length > 0
        ? `同义脚本 ${group.names.join(", ")} 中 ${drop.join(", ")} 仍有名称消费者，缺少迁到 ${keep} 的精确 patch`
        : `多条脚本指向同一命令：${group.command}`;
    cards.push(makeCard({
      action: blocked ? "defer" : "merge",
      asset: "package_script",
      path: group.packagePath,
      owner: "package.json",
      purpose: `合并同义脚本 ${group.names.join(", ")}`,
      consumers: uniqueConsumers([...(group.consumers || []), ...dropConsumers]),
      evidence: [
        `keep=${keep}`,
        `drop=${drop.join(",")}`,
        ...dropConsumers.map((item) => `${item.by}: ${item.evidence}`),
        ...group.evidence,
      ],
      confidence: unknown ? "unknown" : "medium",
      reason,
      afterState: blocked
        ? `暂缓合并，保留全部脚本名：${group.names.join(", ")}`
        : `保留 ${keep}，删除 ${drop.join(", ")}`,
      maxConsequence: "合并错误会导致 CI 或本地脚本名失效",
      patch: blocked ? null : { kind: "json_script_merge", path: group.packagePath, keep, drop },
      keep,
      drop,
      verify: [],
      rollback: "还原 package.json scripts",
      mappingLoss: null,
    }));
  }

  return assignCardIds(cards);
}

function cardForAsset(asset, ctx = {}) {
  const { packageFacts, existingCommands } = ctx;
  const consumers = asset.consumers;
  const confidence = asset.confidence;
  if (asset.kind === "behavior_suite") {
    const command = inferCommand(asset.path, packageFacts, TEST_SCRIPT_RE) || `node --test ${asset.path}`;
    const exact = existingCommands.verify.includes(command);
    const similar = existingCommands.verify.find((item) => normalizeCommand(item) === normalizeCommand(command));
    return makeCard({
      action: exact ? "defer" : "adopt",
      asset: asset.kind,
      path: asset.path,
      owner: "planDefaults.verify_commands",
      purpose: "行为测试套件，后续由 Skill 写入真实计划/任务，不改活动任务",
      consumers,
      evidence: asset.evidence,
      confidence,
      reason: exact ? "已与现有 verify_commands 精确同义" : "扫描到可复用的行为测试入口",
      afterState: `Registry.planDefaults.verify_commands 增加 ${command}`,
      maxConsequence: "未来计划会跑这条命令；命令失败会挡住完成链",
      patch: exact ? null : { kind: "registry_plan_default", field: "verify_commands", command, sourcePath: asset.path },
      verify: [command],
      rollback: "从 Registry planDefaults.verify_commands 移除该命令",
      mappingLoss: !exact && similar ? `近似已有命令 ${similar}` : null,
    });
  }
  if (asset.kind === "static_check") {
    const command = inferCommand(asset.path, packageFacts, STATIC_SCRIPT_RE) || null;
    if (!command) {
      return makeCard({
        action: "defer",
        asset: asset.kind,
        path: asset.path,
        owner: "planDefaults.standards_commands",
        purpose: "静态检查入口，但无法确定可执行命令",
        consumers,
        evidence: asset.evidence,
        confidence: "low",
        reason: "只找到文件线索，没有可映射的精确命令",
        afterState: "保持原状并记入 deferred",
        maxConsequence: "暂缓不会改仓库",
        patch: null,
        verify: [],
        rollback: "无需回滚",
        mappingLoss: "缺少精确命令",
      });
    }
    const exactGate = existingCommands.qualityGates.includes(command);
    const exactStandard = existingCommands.standards.includes(command);
    return makeCard({
      action: exactStandard ? "defer" : "adopt",
      asset: asset.kind,
      path: asset.path,
      owner: exactGate ? "qualityGates" : "planDefaults.standards_commands",
      purpose: "静态工程检查",
      consumers,
      evidence: asset.evidence,
      confidence,
      reason: exactGate
        ? "与现有 qualityGates 精确同义，另出配置卡才会改门"
        : "映射到 standards_commands；近似映射会标明 mappingLoss",
      afterState: `Registry.planDefaults.standards_commands 增加 ${command}`,
      maxConsequence: "未来计划的 standards lane 会执行该命令",
      patch: exactStandard ? null : { kind: "registry_plan_default", field: "standards_commands", command, sourcePath: asset.path },
      verify: [command],
      rollback: "从 Registry 移除该 standards 命令",
      mappingLoss: !exactStandard && !exactGate && existingCommands.standards.length > 0
        ? "未与现有 qualityGates 精确同义，不自动改门"
        : null,
    });
  }
  if (asset.kind === "independent_review") {
    const command = inferCommand(asset.path, packageFacts, REVIEW_SCRIPT_RE) || `node ${asset.path}`;
    return makeCard({
      action: "adopt",
      asset: asset.kind,
      path: asset.path,
      owner: "planDefaults.review_commands",
      purpose: "独立复核入口，不得与 verifier 同义反复",
      consumers,
      evidence: asset.evidence,
      confidence,
      reason: "扫描到独立复核脚本或命令",
      afterState: `Registry.planDefaults.review_commands 增加 ${command}`,
      maxConsequence: "未来计划会把它当作独立复核，而不是完成证据",
      patch: { kind: "registry_plan_default", field: "review_commands", command, sourcePath: asset.path },
      verify: [command],
      rollback: "从 Registry 移除该 review 命令",
      mappingLoss: existingCommands.verify.includes(command) ? "与 verify 同义，Skill 必须拒绝写进完成链" : null,
    });
  }
  if (asset.kind === "runtime_gate" || asset.kind === "host_hook") {
    return makeCard({
      action: "adopt",
      asset: asset.kind,
      path: asset.path,
      owner: asset.kind === "host_hook" ? "hostHooks" : "runtimeGates",
      purpose: "登记实现位置、触发点和拒绝行为，保留原副作用前位置",
      consumers,
      evidence: asset.evidence,
      confidence,
      reason: "发现 Runtime Gate 或宿主 Hook，只建目录项，不搬进 verifier",
      afterState: `Registry.${asset.kind === "host_hook" ? "hostHooks" : "runtimeGates"} 增加 ${asset.path}`,
      maxConsequence: "不会改变现有拦截位置；错误描述可能导致后续适配建议偏差",
      patch: { kind: "registry_catalog", field: asset.kind === "host_hook" ? "hostHooks" : "runtimeGates", sourcePath: asset.path },
      verify: [],
      rollback: "从 Registry 目录移除该项",
      mappingLoss: "不做完整动态 Runtime Gate 穷举",
    });
  }
  if (asset.kind === "historical_archive") {
    return cardForArchive(asset, ctx);
  }
  return makeCard({
    action: "defer",
    asset: asset.kind,
    path: asset.path,
    owner: "deferred",
    purpose: asset.purpose,
    consumers,
    evidence: asset.evidence,
    confidence,
    reason: "现有字段无法安全承接，记入 deferred",
    afterState: "可见但不会伪造字段",
    maxConsequence: "暂缓不会改仓库",
    patch: null,
    verify: [],
    rollback: "无需回滚",
    mappingLoss: "无法映射到现有计划字段",
  });
}

function makeCard(fields) {
  return {
    schemaVersion: CARD_SCHEMA_VERSION,
    id: "",
    status: "pending",
    action: fields.action,
    asset: fields.asset,
    path: fields.path,
    owner: fields.owner,
    purpose: fields.purpose,
    consumers: fields.consumers || [],
    evidence: fields.evidence || [],
    confidence: fields.confidence,
    reason: fields.reason,
    afterState: fields.afterState,
    maxConsequence: fields.maxConsequence,
    patch: fields.patch,
    keep: fields.keep,
    drop: fields.drop,
    verify: fields.verify || [],
    rollback: fields.rollback,
    fingerprint: "",
    mappingLoss: fields.mappingLoss,
  };
}

function assignCardIds(cards) {
  return cards.map((card, index) => {
    const id = `card_${String(index + 1).padStart(3, "0")}_${hashContent(`${card.action}:${card.path}:${card.owner}`).slice(0, 8)}`;
    const withId = { ...card, id };
    return { ...withId, fingerprint: fingerprintCard({ ...withId, fingerprint: "" }) };
  });
}

function classifyFileKind(relativePath, packageFacts, config, headText = "") {
  if (relativePath === "wildarrange.config.json" || relativePath === ".wildarrange/config.json") return "runtime_gate";
  if (CI_GLOBS.some((pattern) => pathMatchesPattern(relativePath, pattern))) return "runtime_gate";
  if (HOOK_GLOBS.some((pattern) => pathMatchesPattern(relativePath, pattern))) return "host_hook";
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

function purposeForKind(kind, filePath, packageFacts) {
  if (kind === "behavior_suite") return `行为测试或 verify 入口：${filePath}`;
  if (kind === "static_check") return `静态检查入口：${filePath}`;
  if (kind === "independent_review") return `独立复核入口：${filePath}`;
  if (kind === "runtime_gate") return `运行时门或 CI 入口：${filePath}`;
  if (kind === "host_hook") return `宿主 Hook：${filePath}`;
  if (kind === "historical_archive") return `历史验证档案：${filePath}`;
  return packageFacts.scripts.find((item) => item.command.includes(filePath))?.name || filePath;
}

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

function uniqueConsumers(consumers) {
  const seen = new Set();
  const result = [];
  for (const consumer of consumers) {
    const key = `${consumer.grade}:${consumer.by}:${consumer.evidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(consumer);
  }
  return result;
}

function indexTextByPath(textIndex = {}) {
  const textByPath = new Map();
  for (const hit of [...(textIndex.registered || []), ...(textIndex.clues || [])]) {
    textByPath.set(hit.path, hit.text);
  }
  return textByPath;
}

function isCurrentSourceOfTruth(relativePath) {
  return CURRENT_SOURCE_RES.some((pattern) => pattern.test(relativePath));
}

function resolveArchiveRoot(files = []) {
  const hasDocs = files.some((file) => {
    const rel = file.path || file;
    return rel === "docs" || rel === "doc" || String(rel).startsWith("docs/") || String(rel).startsWith("doc/");
  });
  return hasDocs ? "docs/verification-archive" : "verification-archive";
}

function extractSuccessorPath(head) {
  const text = String(head || "").slice(0, 4096);
  if (!SUCCESSOR_MARKER_RE.test(text)) return null;
  const match = text.match(/(?:successor|superseded by|replaced by|归档至|历史方案)\s*[:：]?\s*`?([A-Za-z0-9][A-Za-z0-9_.\\/-]*\.[A-Za-z0-9]+)`?/i);
  return match ? normalizeRelativePath(match[1].replace(/\\/g, "/")) : null;
}

function findSuccessor(relativePath, head, fileSet) {
  const fromText = extractSuccessorPath(head);
  if (fromText && fileSet.has(fromText)) return fromText;
  if (/(^|\/)(legacy|archive|history)\//i.test(relativePath)) {
    const base = path.posix.basename(relativePath);
    const matches = [...fileSet].filter((candidate) => (
      candidate !== relativePath
      && path.posix.basename(candidate) === base
      && !/(^|\/)(legacy|archive|history)\//i.test(candidate)
    )).sort((left, right) => left.length - right.length || left.localeCompare(right));
    if (matches.length > 0) return matches[0];
  }
  return null;
}

function cardForArchive(asset, ctx = {}) {
  const missing = [];
  if (isCurrentSourceOfTruth(asset.path)) {
    missing.push("当前真源不得归档");
  }
  const head = String(ctx.textByPath?.get(asset.path) || "").slice(0, 4096);
  const successor = findSuccessor(asset.path, head, ctx.fileSet || new Set());
  if (!successor) {
    missing.push("缺少已存在的显式 successor 路径");
  }
  const active = (asset.consumers || []).filter((item) => ACTIVE_CONSUMER_GRADES.has(item.grade));
  if (asset.consumerUnknown || (asset.consumers || []).some((item) => item.grade === "unknown")) {
    missing.push("消费者未知，不能归档");
  } else if (active.length > 0) {
    missing.push(`仍有活动消费者 ${active.map((item) => item.by).join(", ")}`);
  }
  if (missing.length > 0) {
    return makeCard({
      action: "defer",
      asset: asset.kind,
      path: asset.path,
      owner: "inventory.blindSpots",
      purpose: "历史验证文档或旧任务档案",
      consumers: asset.consumers,
      evidence: asset.evidence,
      confidence: asset.confidence,
      reason: `归档证据不足：${missing.join("；")}`,
      afterState: "保持原状并记入 deferred",
      maxConsequence: "暂缓不会改仓库",
      patch: null,
      verify: [],
      rollback: "无需回滚",
      mappingLoss: null,
    });
  }
  const archiveRoot = resolveArchiveRoot(ctx.files || []);
  return makeCard({
    action: "archive",
    asset: asset.kind,
    path: asset.path,
    owner: "inventory.blindSpots",
    purpose: "历史验证文档或旧任务档案",
    consumers: asset.consumers,
    evidence: [...asset.evidence, `successor=${successor}`, `archiveRoot=${archiveRoot}`],
    confidence: asset.confidence,
    reason: `存在后继真源 ${successor} 且无活动消费者，建议归档而不是删除 Git 历史`,
    afterState: `移入 ${archiveRoot} 并在 Inventory 留 tombstone`,
    maxConsequence: "归档后日常扫描不再把它当现行入口",
    patch: { kind: "archive_move", path: asset.path, archiveRoot },
    verify: [],
    rollback: `从 ${archiveRoot} 移回原路径`,
    mappingLoss: null,
  });
}

function pickKeepScriptName(names) {
  return names.find((name) => OFFICIAL_NPM_SHORTCUTS.has(name)) || names[0];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scriptNameMentioned(text, name) {
  const escaped = escapeRegExp(name);
  if (new RegExp(`\\bnpm(?:\\.cmd)?\\s+run\\s+${escaped}\\b`).test(text)) return true;
  if (OFFICIAL_NPM_SHORTCUTS.has(name) && new RegExp(`\\bnpm(?:\\.cmd)?\\s+${escaped}\\b`).test(text)) return true;
  return new RegExp(`(?:["'\`]${escaped}["'\`]|\\bscripts?\\s*[:=]\\s*["'\`]?${escaped}\\b)`, "i").test(text);
}

function findScriptNameConsumers(name, { packageFacts, textIndex, packagePath }) {
  const consumers = [];
  for (const hit of textIndex.registered || []) {
    if (scriptNameMentioned(hit.text, name)) {
      consumers.push({ grade: "registered", by: hit.path, evidence: `引用脚本 ${name}` });
    }
  }
  for (const hit of textIndex.clues || []) {
    if (path.posix.basename(hit.path) === "package.json") continue;
    if (scriptNameMentioned(hit.text, name)) {
      consumers.push({ grade: "clue", by: hit.path, evidence: `文档引用脚本 ${name}` });
    }
  }
  for (const script of packageFacts.scripts || []) {
    if (script.packagePath === packagePath && script.name === name) continue;
    if (scriptNameMentioned(script.command, name)) {
      consumers.push({ grade: "runner", by: `${script.packagePath}#${script.name}`, evidence: script.command });
    }
  }
  return uniqueConsumers(consumers);
}

async function digestRelativeFile(rootDir, relativePath) {
  if (!relativePath) return "missing";
  const absolutePath = path.join(rootDir, relativePath);
  if (!existsSync(absolutePath)) return "missing";
  return hashContent(await readFile(absolutePath));
}

function strongestConfidence(consumers) {
  if (consumers.some((item) => item.grade === "unknown")) return "unknown";
  if (consumers.some((item) => item.grade === "direct")) return "high";
  if (consumers.some((item) => item.grade === "runner" || item.grade === "registered")) return "medium";
  return "low";
}

function inferCommand(relativePath, packageFacts, nameRe) {
  const hit = packageFacts.scripts.find((item) => nameRe.test(item.name) && (item.command.includes(relativePath) || item.command.includes(path.posix.basename(relativePath))));
  if (hit) return `npm run ${hit.name}`;
  const named = packageFacts.scripts.find((item) => nameRe.test(item.name));
  return named ? `npm run ${named.name}` : null;
}

function collectExistingCommands(config = {}) {
  const qualityGates = [];
  for (const gate of Object.values(config.qualityGates || {})) {
    for (const command of gate?.commands || []) qualityGates.push(command);
  }
  return {
    verify: [],
    standards: [],
    review: [],
    qualityGates,
  };
}

function groupEquivalentScripts(scripts) {
  const groups = new Map();
  for (const script of scripts) {
    const key = `${script.packagePath}:${normalizeCommand(script.command)}`;
    const current = groups.get(key) || {
      packagePath: script.packagePath,
      command: script.command,
      names: [],
      consumers: [],
      evidence: [],
      unknown: false,
    };
    current.names.push(script.name);
    current.consumers.push({ grade: "runner", by: `${script.packagePath}#${script.name}`, evidence: script.command });
    current.evidence.push(script.command);
    if (DYNAMIC_HINT_RE.test(script.command)) current.unknown = true;
    groups.set(key, current);
  }
  return [...groups.values()].filter((group) => group.names.length > 1);
}

function suggestLocator(assets) {
  const hasDocs = assets.some((asset) => asset.path.startsWith("doc/") || asset.path.startsWith("docs/"));
  const hasTooling = assets.some((asset) => asset.path.startsWith("tooling/"));
  if (hasTooling) {
    return {
      registryPath: "tooling/verification-registry.json",
      bootstrapPath: "tooling/verification-bootstrap.json",
      inventoryPath: "tooling/verification-inventory.html",
    };
  }
  if (hasDocs) {
    return {
      registryPath: "docs/verification-registry.json",
      bootstrapPath: "docs/verification-bootstrap.json",
      inventoryPath: "docs/verification-inventory.html",
    };
  }
  return {
    registryPath: "verification-registry.json",
    bootstrapPath: "verification-bootstrap.json",
    inventoryPath: "verification-inventory.html",
  };
}

function configuredLocator(config = {}) {
  const value = config.verificationGovernance;
  if (!value || typeof value !== "object") return null;
  const locator = {
    registryPath: typeof value.registryPath === "string" ? value.registryPath.trim() : "",
    bootstrapPath: typeof value.bootstrapPath === "string" ? value.bootstrapPath.trim() : "",
    inventoryPath: typeof value.inventoryPath === "string" ? value.inventoryPath.trim() : "",
    archiveRoot: typeof value.archiveRoot === "string" ? value.archiveRoot.trim() : "",
  };
  return locator.registryPath && locator.bootstrapPath && locator.inventoryPath ? locator : null;
}

async function listCandidateFiles(rootDir) {
  const files = [];
  await walk(rootDir, "", files);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

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
      dynamicHint = DYNAMIC_HINT_RE.test(text) && !extractImportSpecifiers(text).every((item) => typeof item === "string");
      if (/\bimport\s*\(\s*[^'"`]/.test(text) || /\beval\s*\(/.test(text)) dynamicHint = true;
    }
    files.push({ path: relativePath, dynamicHint });
  }
}

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

async function collectImportIndex(rootDir, files) {
  const edges = [];
  const unknown = new Set();
  const codeFiles = files.filter((file) => /\.(m?js|cjs|ts|tsx)$/.test(file.path));
  for (const file of codeFiles) {
    const absolutePath = path.join(rootDir, file.path);
    const source = await readTextLimited(absolutePath);
    if (/\bimport\s*\(\s*[^'"`]/.test(source) || /\beval\s*\(/.test(source) || /\bnew Function\b/.test(source)) {
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

async function readTextLimited(absolutePath, maxBytes = 200_000) {
  if (!existsSync(absolutePath)) return "";
  const handle = await readFile(absolutePath);
  return handle.subarray(0, maxBytes).toString("utf8");
}

function normalizeCommand(command) {
  return String(command || "").trim().replace(/\s+/g, " ");
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
