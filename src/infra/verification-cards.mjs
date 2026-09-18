// =============================================================================
// 文件名称：verification-cards.mjs
// 所属模块：infra
// 作用说明：
//   验证卡片 UI/CLI 投影：human-readable 验证状态与下一步。
//
// 【运行原理速读】
//   buildVerificationCards → 聚合 gate 结果 → markdown/html 片段。
// =============================================================================
/**
 * Adoption card construction for discovered verification assets.
 * Pure builders over scan facts; no filesystem or Git access.
 */
import path from "node:path";
import { normalizeRelativePath } from "./path-match.mjs";
import { hashContent } from "./runtime-store.mjs";

/**
 * CARD_ACTIONS：本模块对外API。
 */
export const CARD_ACTIONS = Object.freeze(["adopt", "change", "merge", "archive", "delete", "defer"]);
/**
 * 需人工确认的危险 adoption 动作集合。
 */
export const DANGEROUS_ACTIONS = Object.freeze(["archive", "merge", "delete"]);
/**
 * 验证卡片 JSON schema 版本。
 */
export const CARD_SCHEMA_VERSION = 1;
/** 视为「活跃消费者」的证据等级；unknown 触发危险动作门禁。 */
const ACTIVE_CONSUMER_GRADES = new Set(["direct", "runner", "registered"]);
/** npm lifecycle 官方 shortcut 名；discovery 不把它们当普通 script 推断。 */
const OFFICIAL_NPM_SHORTCUTS = new Set(["test", "start", "stop", "restart", "lint"]);
/**
 * SUCCESSOR_MARKER_RE：本模块对外API。
 */
export const SUCCESSOR_MARKER_RE = /successor|superseded by|replaced by|归档至|历史方案/i;
/** 识别「当前权威来源」文件路径的正则列表（AGENTS、config、skills 等）。 */
const CURRENT_SOURCE_RES = [
  /(^|\/)AGENTS\.md$/i,
  /(^|\/)CLAUDE\.md$/i,
  /(^|\/)package\.json$/i,
  /(^|\/)wildarrange\.config\.json$/i,
  /(^|\/)packs\/[^/]+\/skills\//,
  /(^|\/)\.agents\/skills\//,
  /(^|\/)\.cursor\/skills\//,
];

/**
 * STATIC_SCRIPT_RE：本模块对外API。
 */
export const STATIC_SCRIPT_RE = /^(lint|typecheck|types|format|fmt|eslint|tsc|check)([:_-]|$)/i;
/**
 * 识别 review/audit 类 npm script 的正则。
 */
export const REVIEW_SCRIPT_RE = /^(review|audit|inspect)([:_-]|$)/i;
/**
 * 识别 test/verify 类 npm script 的正则。
 */
export const TEST_SCRIPT_RE = /^(test|verify|coverage|spec)([:_-]|$)/i;
/** package.json scripts 中含动态执行线索时的降级标记正则。 */
const DYNAMIC_HINT_RE = /\bimport\s*\(|\beval\s*\(|\bnew Function\b|\brequire\s*\(\s*[^'"`]/;

/**
 * fingerprintCard：本模块对外API。
 */
// --- 卡片指纹与危险动作 ---
export function fingerprintCard(card) {
  return hashContent(stableStringify(cardFingerprintPayload(card)));
}

/**
 * cardAllowsDangerousAction：本模块对外API。
 */
export function cardAllowsDangerousAction(card) {
  const unknown = card.consumers?.some((consumer) => consumer.grade === "unknown") || card.confidence === "unknown";
  return !unknown;
}

/**
 * cardFingerprintPayload：本模块对外API。
 */
export function cardFingerprintPayload(card) {
  const { status: _status, ...rest } = card;
  return rest;
}

/**
 * buildAdoptionCards：本模块对外API。
 */
// --- 卡片构建 ---
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

/**
 * 为指定资产构造 verification card。
 */
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
  if (asset.kind === "test_fixture") {
    return makeCard({ action: "adopt", asset: asset.kind, path: asset.path,
      owner: "fixtures", purpose: asset.purpose, consumers, evidence: asset.evidence, confidence,
      reason: "登记夹具原位置和消费者，不复制数据，也不把数据文件当测试执行",
      afterState: "Registry.fixtures 引用原夹具", maxConsequence: "仅登记引用，不证明测试已通过",
      patch: { kind: "registry_catalog", field: "fixtures", sourcePath: asset.path },
      verify: [], rollback: "移除本目录项，原夹具不变", mappingLoss: consumers.length ? null : "消费者尚未查明，迁移任务需补证据" });
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

/**
 * 构造 Card 实例。
 */
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

/**
 * 分配 CardIds 标识。
 */
function assignCardIds(cards) {
  return cards.map((card, index) => {
    const id = `card_${String(index + 1).padStart(3, "0")}_${hashContent(`${card.action}:${card.path}:${card.owner}`).slice(0, 8)}`;
    const withId = { ...card, id };
    return { ...withId, fingerprint: fingerprintCard({ ...withId, fingerprint: "" }) };
  });
}

/**
 * isCurrentSourceOfTruth：本模块对外API。
 */
export function isCurrentSourceOfTruth(relativePath) {
  return CURRENT_SOURCE_RES.some((pattern) => pattern.test(relativePath));
}

/**
 * 解析 ArchiveRoot 路径或引用，越界/逃逸抛错。
 */
function resolveArchiveRoot(files = []) {
  const hasDocs = files.some((file) => {
    const rel = file.path || file;
    return rel === "docs" || rel === "doc" || String(rel).startsWith("docs/") || String(rel).startsWith("doc/");
  });
  return hasDocs ? "docs/verification-archive" : "verification-archive";
}

/**
 * 从内容中提取 SuccessorPath。
 */
function extractSuccessorPath(head) {
  const text = String(head || "").slice(0, 4096);
  if (!SUCCESSOR_MARKER_RE.test(text)) return null;
  const match = text.match(/(?:successor|superseded by|replaced by|归档至|历史方案)\s*[:：]?\s*`?([A-Za-z0-9][A-Za-z0-9_.\\/-]*\.[A-Za-z0-9]+)`?/i);
  return match ? normalizeRelativePath(match[1].replace(/\\/g, "/")) : null;
}

/**
 * 查找 Successor 匹配项。
 */
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

// --- 归档与脚本推断 ---
/**
 * 为指定资产构造 verification card。
 */
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

/**
 * 从候选中选择 KeepScriptName。
 */
function pickKeepScriptName(names) {
  return names.find((name) => OFFICIAL_NPM_SHORTCUTS.has(name)) || names[0];
}

/**
 * 转义 RegExp 特殊字符。
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * scriptNameMentioned 内部辅助。
 */
function scriptNameMentioned(text, name) {
  const escaped = escapeRegExp(name);
  if (new RegExp(`\\bnpm(?:\\.cmd)?\\s+run\\s+${escaped}\\b`).test(text)) return true;
  if (OFFICIAL_NPM_SHORTCUTS.has(name) && new RegExp(`\\bnpm(?:\\.cmd)?\\s+${escaped}\\b`).test(text)) return true;
  return new RegExp(`(?:["'\`]${escaped}["'\`]|\\bscripts?\\s*[:=]\\s*["'\`]?${escaped}\\b)`, "i").test(text);
}

/**
 * 查找 ScriptNameConsumers 匹配项。
 */
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

/**
 * 从上下文推断 Command。
 */
function inferCommand(relativePath, packageFacts, nameRe) {
  const hit = packageFacts.scripts.find((item) => nameRe.test(item.name) && (item.command.includes(relativePath) || item.command.includes(path.posix.basename(relativePath))));
  if (hit) return `npm run ${hit.name}`;
  const named = packageFacts.scripts.find((item) => nameRe.test(item.name));
  return named ? `npm run ${named.name}` : null;
}

/**
 * 收集 ExistingCommands 条目。
 */
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

/**
 * 将 EquivalentScripts 按等价关系分组。
 */
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

/**
 * 建议 Locator 候选。
 */
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

/**
 * 读取已配置的 Locator。
 */
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

/**
 * uniqueConsumers：本模块对外API。
 */
// --- 消费者与序列化 ---
export function uniqueConsumers(consumers) {
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

/**
 * indexTextByPath：本模块对外API。
 */
export function indexTextByPath(textIndex = {}) {
  const textByPath = new Map();
  for (const hit of [...(textIndex.registered || []), ...(textIndex.clues || [])]) {
    textByPath.set(hit.path, hit.text);
  }
  return textByPath;
}

/**
 * 归一化 Command 输入为稳定形态。
 */
function normalizeCommand(command) {
  return String(command || "").trim().replace(/\s+/g, " ");
}

/**
 * stableStringify：本模块对外API。
 */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

