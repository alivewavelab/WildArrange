// =============================================================================
// 文件名称：verification-governance.mjs
// 所属模块：capabilities
// 作用说明：
//   验证治理的原子能力：扫描验证宇宙、应用单张已批准差异卡、生成
//   registry/bootstrap/inventory 制品。会话状态由 orchestration 持有。
//
// 【运行原理速读】
//   · 何时执行？adoption 流程、CLI verification 子命令、gateway 注册能力。
//   · 做了什么？scan → apply-card（ preimage/回滚/verify）→ generate 分阶段写制品。
//   · 缺了它会怎样？验证命令/registry 变更无法经卡片审批与可恢复事务落地。
// =============================================================================

import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCommand } from "../infra/command-runner.mjs";
import { evaluateCommandSafety } from "../infra/command-safety.mjs";
import { loadWildArrangeConfig } from "../infra/runtime-config.mjs";
import { nowIso, readJson, writeJsonAtomic, writeTextAtomic } from "../infra/runtime-store.mjs";
import {
  adoptionTransactionDir,
  assertRealpathInsideRoot,
  capturePreimages,
  createAdoptionRecoveryManifest,
  digestPath,
  readRecoveryManifest,
  resolveInboundPath,
  restorePreimages,
  writeRecoveryManifest,
} from "../infra/recovery-transaction.mjs";
import { fingerprintCard } from "../infra/verification-cards.mjs";
import { scanVerificationUniverse } from "../infra/verification-discovery.mjs";
import {
  buildBootstrap,
  buildInventory,
  buildRegistryFromCards,
  computeDeclaredInputFingerprint,
  declaredInputPaths,
  digestCanonical,
  digestGitComparableContent,
  parseVerificationInventory,
  readGitInventoryContext,
  readLocator,
  renderVerificationInventoryHtml,
} from "../infra/verification-registry.mjs";

// --- 公开 API ---

/**
 * 扫描验证治理宇宙，返回卡片与指纹等扫描结果。
 * @param {string} rootDir 项目根
 * @param {object} [options] 传给 scanVerificationUniverse 的选项
 * @returns {Promise<object>} kind=verification_governance_scan
 */
export async function scanVerificationGovernance(rootDir, options = {}) {
  const started = Date.now();
  const result = await scanVerificationUniverse(rootDir, options);
  return {
    kind: "verification_governance_scan",
    at: nowIso(),
    durationMs: Date.now() - started,
    businessWrites: 0,
    commandsExecuted: [],
    ...result,
  };
}

/**
 * 在 recovery 事务中应用单张验证差异卡：patch → verify → 提交或回滚。
 * @param {object} options card、sessionId、expectedFingerprint、config
 */
export async function applyVerificationCard(rootDir, options = {}) {
  const card = options.card;
  if (!card?.id) throw new Error("apply-card requires card.id");
  if (options.expectedFingerprint && options.expectedFingerprint !== card.fingerprint && options.expectedFingerprint !== fingerprintCard(card)) {
    const error = new Error("card fingerprint stale");
    error.code = "card_stale";
    throw error;
  }
  const sessionId = options.sessionId;
  const txnDir = adoptionTransactionDir(rootDir, sessionId, card.id);
  const stagingDir = path.join(txnDir, "preimage");
  const manifestPath = path.join(txnDir, "manifest.json");
  const existing = await readRecoveryManifest(manifestPath);
  const paths = existing?.paths?.length ? existing.paths : affectedPaths(card);
  for (const relativePath of paths) {
    const absolutePath = resolveInboundPath(rootDir, relativePath, {
      denyPrefixes: [path.join(rootDir, ".git")],
    });
    await assertRealpathInsideRoot(rootDir, absolutePath, relativePath);
  }
  // §3.4：recovery_required 事务复用已有 preimage，避免重复 capture 覆盖 staging。
  const reusePreimage = existing && ["prepared", "recovery_required"].includes(existing.status) && Array.isArray(existing.preimage);
  const preimage = reusePreimage
    ? existing.preimage
    : await capturePreimages(rootDir, paths, stagingDir, {
      denyPrefixes: [path.join(rootDir, ".git")],
    });
  let manifest = reusePreimage
    ? { ...existing, paths }
    : createAdoptionRecoveryManifest({
      transactionId: card.id,
      sessionId,
      cardId: card.id,
      paths,
      preimage,
    });
  await writeRecoveryManifest(manifestPath, manifest);

  try {
    if (card.action !== "defer" && card.status !== "rejected") {
      await applyPatch(rootDir, card);
    }
    const verifyResults = await runApprovedCommands(rootDir, card.verify || [], options.config);
    if (verifyResults.some((item) => item.exitCode !== 0)) {
      throw Object.assign(new Error("approved verifier failed"), { code: "verify_failed", verifyResults });
    }
    const postimage = [];
    for (const relativePath of paths) {
      postimage.push({
        path: relativePath,
        digest: await digestPath(path.join(rootDir, relativePath)),
        gitDigest: await gitComparablePathDigest(path.join(rootDir, relativePath)),
      });
    }
    manifest = {
      ...manifest,
      status: "committed",
      statusAt: nowIso(),
      postimage,
      verifyResults,
    };
    await writeRecoveryManifest(path.join(txnDir, "manifest.json"), manifest);
    await writeJsonAtomic(path.join(txnDir, "postimage.json"), postimage);
    return { kind: "verification_governance_apply", status: "committed", cardId: card.id, paths, verifyResults, manifest };
  } catch (error) {
    // §3.4：apply/verify 失败时先 restore preimage，再向上抛原错误或 recovery_required。
    try {
      await restorePreimages(rootDir, stagingDir, preimage, {
        denyPrefixes: [path.join(rootDir, ".git")],
      });
      manifest = {
        ...manifest,
        status: "rolled_back",
        statusAt: nowIso(),
        diagnostic: error instanceof Error ? error.message : String(error),
      };
      await writeRecoveryManifest(path.join(txnDir, "manifest.json"), manifest);
      error.recovered = true;
    } catch (restoreError) {
      manifest = {
        ...manifest,
        status: "recovery_required",
        statusAt: nowIso(),
        diagnostic: {
          apply: error instanceof Error ? error.message : String(error),
          restore: restoreError instanceof Error ? restoreError.message : String(restoreError),
        },
      };
      await writeRecoveryManifest(path.join(txnDir, "manifest.json"), manifest);
      const wrapped = new Error("adoption rollback failed");
      wrapped.code = "recovery_required";
      wrapped.cause = restoreError;
      throw wrapped;
    }
    throw error;
  }
}

/**
 * 按 phase 生成 registry 或 handoff（bootstrap+inventory）治理制品。
 * @param {object} options phase、cards、locator、registry、baselineRef
 */
export async function generateVerificationArtifacts(rootDir, options = {}) {
  const cards = options.cards || [];
  const locator = options.locator || readLocator((await loadWildArrangeConfig(rootDir)).config);
  if (!locator.registryPath) throw new Error("generate-artifacts requires an approved locator");
  const phase = options.phase || "registry";
  const written = [];
  if (phase === "registry" || phase === "all") {
    const plannedRegistry = buildRegistryFromCards(cards, { locator });
    const [preparedRegistry] = await prepareArtifactWrites(rootDir, [{
      relativePath: locator.registryPath,
      value: plannedRegistry,
      kind: "registry",
    }]);
    await commitPreparedArtifact(preparedRegistry);
    const registry = preparedRegistry.value;
    written.push({ path: locator.registryPath, digest: registry.digest, kind: "registry", reused: preparedRegistry.reused });
    if (options.writeLocator === true) {
      await mergeLocator(rootDir, locator);
      written.push({ path: "wildarrange.config.json", kind: "locator" });
    }
    return { kind: "verification_governance_generate", phase: "registry", written, registry };
  }
  if (phase === "handoff") {
    const registry = options.registry || await readJson(path.join(rootDir, locator.registryPath), null);
    if (!registry) throw new Error("registry missing; commit A must exist before generating Bootstrap/Inventory");
    const plannedBootstrap = buildBootstrap({
      baselineRef: options.baselineRef,
      registryDigest: registry.digest || digestCanonical(registry),
      locator,
    });
    const declared = declaredInputPaths(registry, locator);
    const declaredFingerprint = await computeDeclaredInputFingerprint(rootDir, declared, {
      exclude: [locator.inventoryPath, locator.bootstrapPath],
    });
    const [preparedBootstrap] = await prepareArtifactWrites(rootDir, [{
      relativePath: locator.bootstrapPath,
      value: plannedBootstrap,
      kind: "bootstrap",
    }]);
    const bootstrap = preparedBootstrap.value;
    const plannedInventory = buildInventory({
      registryDigest: registry.digest || digestCanonical(registry),
      bootstrapDigest: bootstrap.digest,
      declaredInputs: declared,
      universeFingerprint: options.universeFingerprint,
      declaredInputFingerprint: declaredFingerprint,
      cards,
      projectContext: await readGitInventoryContext(rootDir, options.baselineRef, {
        exclude: [locator.bootstrapPath, locator.inventoryPath],
      }),
    });
    const [preparedInventory] = await prepareArtifactWrites(rootDir, [{
      relativePath: locator.inventoryPath,
      value: plannedInventory,
      kind: "inventory",
      serialized: String(locator.inventoryPath).toLowerCase().endsWith(".html")
        ? renderVerificationInventoryHtml(plannedInventory)
        : undefined,
    }]);
    await commitPreparedArtifact(preparedBootstrap);
    await commitPreparedArtifact(preparedInventory);
    const inventory = preparedInventory.value;
    written.push({ path: locator.bootstrapPath, digest: bootstrap.digest, kind: "bootstrap", reused: preparedBootstrap.reused });
    written.push({ path: locator.inventoryPath, digest: inventory.digest, kind: "inventory", reused: preparedInventory.reused });
    return { kind: "verification_governance_generate", phase: "handoff", written, bootstrap, inventory };
  }
  throw new Error(`unsupported generate phase: ${phase}`);
}

// --- 卡片路径解析 ---

const DENIED_ARCHIVE_ROOTS = new Set([".wildarrange", ".git", "node_modules"]);

/** 计算 archive_move 的目标相对路径，禁止写入 .wildarrange/.git 等根。 */
function archiveDestination(card, archiveRootHint = "") {
  const source = String(card.patch?.path || card.path || "").replaceAll("\\", "/");
  const rawRoot = String(card.patch?.archiveRoot || archiveRootHint || "").trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  const archiveRoot = rawRoot || "docs/verification-archive";
  const rootHead = archiveRoot.split("/")[0];
  if (!archiveRoot || DENIED_ARCHIVE_ROOTS.has(rootHead)) {
    const error = new Error("archive root must be a project-committable directory");
    error.code = "archive_root_denied";
    throw error;
  }
  return `${archiveRoot}/${source}`.replace(/\/+/g, "/");
}

/** 从差异卡解析 apply/verify 阶段需 preimage 的所有相对路径。 */
function affectedPaths(card) {
  const paths = new Set();
  if (card.path && card.patch) paths.add(card.path);
  if (card.patch?.path) paths.add(card.patch.path);
  if (card.patch?.kind === "archive_move" || card.action === "archive") {
    paths.add(card.patch?.path || card.path);
    paths.add(archiveDestination(card));
  }
  return [...paths].filter(Boolean);
}

// --- Patch 应用 ---

/** 按 patch.kind 应用 json_merge、write_text、archive_move 等变更。 */
async function applyPatch(rootDir, card) {
  const patch = card.patch;
  if (!patch) return;
  if (patch.kind === "json_merge") {
    const absolutePath = resolveInboundPath(rootDir, patch.path);
    const current = await readJson(absolutePath, {});
    await writeJsonAtomic(absolutePath, deepMerge(current, patch.value || {}));
    return;
  }
  if (patch.kind === "json_script_merge") {
    const absolutePath = resolveInboundPath(rootDir, patch.path);
    const current = await readJson(absolutePath, {});
    const scripts = { ...(current.scripts || {}) };
    for (const name of patch.drop || []) delete scripts[name];
    await writeJsonAtomic(absolutePath, { ...current, scripts });
    return;
  }
  if (patch.kind === "write_text") {
    const absolutePath = resolveInboundPath(rootDir, patch.path);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, patch.content || "", "utf8");
    return;
  }
  if (patch.kind === "archive_move") {
    const destRel = archiveDestination(card);
    const source = resolveInboundPath(rootDir, patch.path);
    const target = resolveInboundPath(rootDir, destRel);
    await assertRealpathInsideRoot(rootDir, path.dirname(target), destRel);
    try {
      await readFile(target);
      const error = new Error(`archive destination exists; refuse to overwrite: ${destRel}`);
      error.code = "archive_conflict";
      throw error;
    } catch (error) {
      if (error?.code === "archive_conflict") throw error;
      if (error?.code !== "ENOENT") throw error;
    }
    await mkdir(path.dirname(target), { recursive: true });
    const bytes = await readFile(source);
    await writeFile(target, bytes);
    await rm(source, { force: true });
    return;
  }
  if (patch.kind === "delete") {
    await rm(resolveInboundPath(rootDir, patch.path), { recursive: Boolean(patch.recursive), force: true });
    return;
  }
  if (patch.kind === "registry_plan_default" || patch.kind === "registry_catalog") {
    return;
  }
  throw new Error(`unsupported patch kind: ${patch.kind}`);
}

// --- 批准命令执行 ---

/** 执行卡上批准的 verify 命令，不安全命令以 exitCode 126 记录而不执行。 */
async function runApprovedCommands(rootDir, commands, config) {
  const results = [];
  for (const command of commands) {
    const safety = evaluateCommandSafety(command, { extraPatterns: config?.commandSafety?.extraPatterns || [] });
    if (!safety.allowed) {
      results.push({ command, exitCode: 126, blocked: true, findings: safety.findings, stdout: "", stderr: "" });
      continue;
    }
    const raw = await runCommand(command, rootDir, 120_000);
    results.push({
      command,
      exitCode: raw.exitCode,
      stdout: redactSecrets(raw.stdout || ""),
      stderr: redactSecrets(raw.stderr || ""),
    });
  }
  return results;
}

/** 读取文件内容计算 git 可比 digest；缺失目录返回固定标记。 */
async function gitComparablePathDigest(absolutePath) {
  try {
    return digestGitComparableContent(await readFile(absolutePath));
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    if (error?.code === "EISDIR") return digestPath(absolutePath);
    throw error;
  }
}

// --- 制品写入 ---

/** 校验目标路径可写且语义一致；已有同义制品则标记 reused 跳过写入。 */
async function prepareArtifactWrites(rootDir, artifacts) {
  const prepared = [];
  for (const artifact of artifacts) {
    const absolutePath = resolveInboundPath(rootDir, artifact.relativePath);
    await assertRealpathInsideRoot(rootDir, path.dirname(absolutePath), artifact.relativePath);
    let info = null;
    try {
      info = await lstat(absolutePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw artifactConflict(artifact.relativePath, "目标无法安全读取");
    }
    if (!info) {
      prepared.push({ ...artifact, absolutePath, reused: false });
      continue;
    }
    if (info.isSymbolicLink()) throw artifactConflict(artifact.relativePath, "目标是符号链接");
    if (!info.isFile()) throw artifactConflict(artifact.relativePath, "目标不是普通文件");
    let existing;
    try {
      const text = await readFile(absolutePath, "utf8");
      existing = artifact.kind === "inventory" ? parseVerificationInventory(text) : JSON.parse(text);
      if (!existing) throw new Error("missing embedded inventory record");
    } catch {
      throw artifactConflict(artifact.relativePath, "目标是已有文件且不是可复用的治理产物");
    }
    if (!sameArtifactMeaning(existing, artifact.value)) {
      throw artifactConflict(artifact.relativePath, "目标已有不同内容");
    }
    prepared.push({ ...artifact, absolutePath, value: existing, reused: true });
  }
  return prepared;
}

/** 非 reused 制品原子写入；写入前再次确认目标仍为 ENOENT。 */
async function commitPreparedArtifact(prepared) {
  if (prepared.reused) return;
  try {
    await lstat(prepared.absolutePath);
    throw artifactConflict(prepared.relativePath, "目标在生成期间被占用");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (prepared.serialized !== undefined) {
    await writeTextAtomic(prepared.absolutePath, prepared.serialized);
  } else {
    await writeJsonAtomic(prepared.absolutePath, prepared.value);
  }
}

/** 比较两制品语义（忽略 generatedAt/digest 元字段）是否相同。 */
function sameArtifactMeaning(left, right) {
  return digestCanonical(artifactMeaning(left)) === digestCanonical(artifactMeaning(right));
}

/** 剥离时间戳与 digest 后返回制品可比对的语义体。 */
function artifactMeaning(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { generatedAt: _generatedAt, digest: _digest, ...meaning } = value;
  return meaning;
}

/** 构造 artifact_conflict 错误，含 nextAction 指引人工移走冲突文件。 */
function artifactConflict(relativePath, reason) {
  const error = new Error(`治理文件目标冲突：${relativePath}（${reason}）`);
  error.code = "artifact_conflict";
  error.nextAction = `请先把 ${relativePath} 移走或改名，再重试；WildArrange 未覆盖现有内容`;
  error.evidence = { path: relativePath, reason };
  return error;
}

// --- 工具函数 ---

/** 将 approved locator 合并写入 wildarrange.config.json。 */
async function mergeLocator(rootDir, locator) {
  const configPath = path.join(rootDir, "wildarrange.config.json");
  const current = await readJson(configPath, {});
  await writeJsonAtomic(configPath, {
    ...current,
    verificationGovernance: locator,
  });
}

/** 递归合并 JSON 对象；overlay 数组整体替换 base 数组。 */
function deepMerge(base, overlay) {
  if (Array.isArray(overlay)) return overlay.slice();
  if (!overlay || typeof overlay !== "object") return overlay;
  const result = { ...(base && typeof base === "object" ? base : {}) };
  for (const [key, value] of Object.entries(overlay)) {
    result[key] = key in result ? deepMerge(result[key], value) : value;
  }
  return result;
}

/** 脱敏命令输出中的 token/secret/api_key/password 赋值片段。 */
function redactSecrets(text) {
  return String(text).replace(/(token|secret|api[_-]?key|password)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}
