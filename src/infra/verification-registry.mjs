/**
 * Shared schema, canonical digest, declared-input fingerprint and freshness
 * for Registry / Bootstrap / Inventory. doctor, status and generators must
 * consume this owner instead of recomputing.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runCommandFile } from "./command-runner.mjs";
import { normalizeRelativePath } from "./path-match.mjs";
import { loadWildArrangeConfig } from "./runtime-config.mjs";
import { hashContent, nowIso, readJson } from "./runtime-store.mjs";
import { fingerprintCard, stableStringify } from "./verification-discovery.mjs";

export const REGISTRY_SCHEMA_VERSION = 1;
export const BOOTSTRAP_SCHEMA_VERSION = 1;
export const INVENTORY_SCHEMA_VERSION = 1;

export function emptyLocator() {
  return { registryPath: "", bootstrapPath: "", inventoryPath: "", archiveRoot: "" };
}

export function readLocator(config = {}) {
  const raw = config.verificationGovernance || {};
  return {
    registryPath: typeof raw.registryPath === "string" ? raw.registryPath.trim() : "",
    bootstrapPath: typeof raw.bootstrapPath === "string" ? raw.bootstrapPath.trim() : "",
    inventoryPath: typeof raw.inventoryPath === "string" ? raw.inventoryPath.trim() : "",
    archiveRoot: typeof raw.archiveRoot === "string" ? raw.archiveRoot.trim() : "",
  };
}

export function locatorConfigured(locator) {
  return Boolean(locator?.registryPath && locator?.bootstrapPath && locator?.inventoryPath);
}

export function digestCanonical(value) {
  return hashContent(stableStringify(value));
}

export function digestGitComparableContent(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
  return hashContent(text.replaceAll("\r\n", "\n"));
}

export function buildRegistryFromCards(cards, options = {}) {
  const adopted = (cards || []).filter((card) => card.status === "approved" && card.action === "adopt");
  const deferred = (cards || []).filter((card) => card.action === "defer" || card.status === "deferred");
  const planDefaults = {
    verify_commands: [],
    standards_commands: [],
    review_commands: [],
  };
  const runtimeGates = [];
  const hostHooks = [];
  for (const card of adopted) {
    if (card.patch?.kind === "registry_plan_default" && planDefaults[card.patch.field]) {
      if (!planDefaults[card.patch.field].includes(card.patch.command)) {
        planDefaults[card.patch.field].push(card.patch.command);
      }
    }
    if (card.patch?.kind === "registry_catalog" && card.patch.field === "runtimeGates") {
      runtimeGates.push({ path: card.patch.sourcePath, purpose: card.purpose });
    }
    if (card.patch?.kind === "registry_catalog" && card.patch.field === "hostHooks") {
      hostHooks.push({ path: card.patch.sourcePath, purpose: card.purpose });
    }
  }
  const registry = {
    kind: "verification_registry",
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    generatedAt: options.generatedAt || nowIso(),
    locator: options.locator || emptyLocator(),
    planDefaults,
    runtimeGates,
    hostHooks,
    deferred: deferred.map((card) => ({
      id: card.id,
      path: card.path,
      reason: card.reason,
      mappingLoss: card.mappingLoss,
    })),
    cards: (cards || []).map((card) => ({
      id: card.id,
      action: card.action,
      path: card.path,
      fingerprint: card.fingerprint || fingerprintCard(card),
      status: card.status,
    })),
  };
  return { ...registry, digest: digestCanonical(withoutDigest(registry)) };
}

export function buildBootstrap({ baselineRef, registryDigest, locator }) {
  const bootstrap = {
    kind: "verification_bootstrap",
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
    generatedAt: nowIso(),
    baselineRef: baselineRef || null,
    registryDigest,
    locator: locator || emptyLocator(),
  };
  return { ...bootstrap, digest: digestCanonical(withoutDigest(bootstrap)) };
}

export function buildInventory({
  registryDigest,
  bootstrapDigest,
  declaredInputs,
  universeFingerprint,
  declaredInputFingerprint,
  cards = [],
  projectContext = {},
}) {
  const inventory = {
    kind: "verification_inventory",
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    generatedAt: nowIso(),
    registryDigest,
    bootstrapDigest,
    declaredInputs: [...new Set(declaredInputs || [])].sort(),
    discoveryUniverseFingerprint: universeFingerprint || null,
    projectContext: {
      baselineRef: projectContext.baselineRef || null,
      headSha: projectContext.headSha || null,
      branch: projectContext.branch || null,
      wip: Array.isArray(projectContext.wip) ? projectContext.wip : [],
    },
    views: buildInventoryViews(cards),
  };
  if (declaredInputFingerprint !== undefined) {
    inventory.declaredInputFingerprint = declaredInputFingerprint;
  }
  return { ...inventory, digest: digestCanonical(withoutDigest(inventory)) };
}

export function renderVerificationInventoryHtml(inventory) {
  const views = inventory?.views || buildInventoryViews([]);
  const data = JSON.stringify(inventory).replaceAll("<", "\\u003c");
  const section = (title, plain, entries, emptyText) => `
    <section class="card">
      <h2>${escapeHtml(title)}</h2>
      <p class="plain">生活化解释：${escapeHtml(plain)}</p>
      ${entries.length > 0 ? entries.map(renderInventoryEntry).join("\n") : `<p class="empty">${escapeHtml(emptyText)}</p>`}
    </section>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WildArrange 验证资产总账</title>
  <style>
    :root{color-scheme:light;background:#f4f6f8;color:#17212b;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}body{max-width:1080px;margin:0 auto;padding:32px 20px 64px}h1,h2{margin:.2em 0}.lead,.plain,.empty{color:#536170}.flow{display:flex;gap:12px;align-items:stretch;margin:24px 0}.flow div,.card{background:#fff;border:1px solid #dce2e8;border-radius:14px;padding:18px;box-shadow:0 3px 12px #17212b0d}.flow div{flex:1}.arrow{align-self:center;font-size:24px;color:#64748b}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:16px}.entry{border-top:1px solid #e7ebef;padding:14px 0}.entry:first-of-type{border-top:0}.tag{display:inline-block;padding:3px 9px;border-radius:999px;background:#e8f0ff;color:#2457a7;font-size:12px}dl{display:grid;grid-template-columns:96px 1fr;gap:7px 12px;margin:10px 0 0}dt{font-weight:700}dd{margin:0;word-break:break-word}code{background:#eef2f5;padding:2px 5px;border-radius:5px}@media(max-width:680px){.flow{display:block}.arrow{text-align:center}.grid{display:block}.card{margin-bottom:14px}dl{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <header><p class="tag">WildArrange · Verification Inventory</p><h1>验证资产总账</h1><p class="lead">这是接管完成后的人工视图：先看当前仍在工作的入口，需要追溯时再看历史、删除墓碑和暂缓项。</p></header>
  <div class="flow" aria-label="输入到输出流程"><div><strong>输入</strong><p>测试、Runner、CI、Hook、Gate 与历史文档</p></div><div class="arrow">→</div><div><strong>处理</strong><p>静态搜证、逐卡批准、可恢复执行、Git 锚定</p></div><div class="arrow">→</div><div><strong>输出</strong><p>当前真源、历史去向、风险与待确认事项</p></div></div>
  <p><strong>输入 → 处理 → 输出</strong>。生成时间：<code>${escapeHtml(inventory?.generatedAt || "未知")}</code>；基线数据摘要：<code>${escapeHtml(inventory?.digest || "缺失")}</code></p>
  <section class="card" style="margin-bottom:16px"><h2>生成现场</h2><p class="plain">生活化解释：像交接单上的房屋地址和现场遗留物，避免以后拿错版本。</p><dl><dt>Git 基线</dt><dd><code>${escapeHtml(inventory?.projectContext?.baselineRef || "未提供")}</code></dd><dt>生成时 HEAD</dt><dd><code>${escapeHtml(inventory?.projectContext?.headSha || "非 Git 仓库")}</code></dd><dt>当前分支</dt><dd>${escapeHtml(inventory?.projectContext?.branch || "未知")}</dd><dt>未提交改动</dt><dd>${escapeHtml((inventory?.projectContext?.wip || []).join("；") || "无")}</dd></dl></section>
  <main class="grid">
    ${section("当前真源", "现在项目真正依靠的检查清单。", views.currentSources || [], "没有登记当前真源。")}
    ${section("历史档案", "像资料室，退出日常入口但需要时还能找回。", views.historicalArchives || [], "没有归档项。")}
    ${section("已删除墓碑", "像销毁登记，说明删过什么以及如何追溯。", views.deletedTombstones || [], "没有删除项。")}
    ${section("暂缓确认", "像贴着待办标签的物品，原地不动，等证据齐了再决定。", views.deferredConfirmations || [], "没有暂缓项。")}
  </main>
  <section class="card" style="margin-top:16px"><h2>本次变更记录</h2><p class="plain">生活化解释：这是本次施工单的结果清单。</p>${(views.changeLog || []).map(renderInventoryEntry).join("\n") || '<p class="empty">没有变更记录。</p>'}</section>
  <script id="wildarrange-verification-inventory" type="application/json">${data}</script>
</body>
</html>\n`;
}

export function parseVerificationInventory(text) {
  const source = String(text || "").trim();
  if (!source) return null;
  if (source.startsWith("{")) return JSON.parse(source);
  const match = source.match(/<script\s+id=["']wildarrange-verification-inventory["']\s+type=["']application\/json["']>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  return JSON.parse(match[1]);
}

export async function readVerificationInventory(filePath, fallback = undefined) {
  try {
    return parseVerificationInventory(await readFile(filePath, "utf8"));
  } catch (error) {
    if (fallback !== undefined && error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function computeDeclaredInputFingerprint(rootDir, relativePaths, options = {}) {
  const exclude = new Set((options.exclude || []).map((item) => normalizeRelativePath(item)));
  const fingerprints = [];
  for (const relativePath of [...new Set(relativePaths || [])].sort()) {
    const normalized = normalizeRelativePath(relativePath);
    if (exclude.has(normalized)) continue;
    const absolutePath = path.join(rootDir, normalized);
    if (!existsSync(absolutePath)) {
      fingerprints.push({ path: normalized, digest: "missing" });
      continue;
    }
    fingerprints.push({ path: normalized, digest: hashContent(await readFile(absolutePath)) });
  }
  return digestCanonical(fingerprints);
}

export function declaredInputPaths(registry, locator, extra = []) {
  const paths = [
    locator?.registryPath,
    "package.json",
    "wildarrange.config.json",
    ...extra,
    ...(registry?.runtimeGates || []).map((item) => item.path),
    ...(registry?.hostHooks || []).map((item) => item.path),
    ...(registry?.planDefaults?.verify_commands || []).map(commandHintPath),
    ...(registry?.planDefaults?.standards_commands || []).map(commandHintPath),
    ...(registry?.planDefaults?.review_commands || []).map(commandHintPath),
  ].filter(Boolean).map((item) => normalizeRelativePath(item)).filter((item) => !item.includes(" "));
  return [...new Set(paths)].sort();
}

export async function readGitHead(rootDir) {
  const result = await runCommandFile("git", ["-C", rootDir, "rev-parse", "HEAD"], rootDir, 15_000);
  if (result.exitCode !== 0) return { available: false, sha: null, reason: result.stderr || "git rev-parse failed" };
  return { available: true, sha: result.stdout.trim() };
}

export async function gitTreeContains(rootDir, relativePath, ref) {
  if (!relativePath || !ref) return false;
  const result = await runCommandFile("git", ["-C", rootDir, "cat-file", "-e", `${ref}:${normalizeRelativePath(relativePath)}`], rootDir, 15_000);
  return result.exitCode === 0;
}

export async function readGitBlobDigest(rootDir, relativePath, ref) {
  if (!relativePath || !ref) return { available: false, digest: null };
  const spec = `${ref}:${normalizeRelativePath(relativePath)}`;
  const result = await runCommandFile("git", ["-C", rootDir, "cat-file", "-p", spec], rootDir, 15_000);
  if (result.exitCode !== 0) return { available: false, digest: null, reason: result.stderr || "git cat-file failed" };
  return { available: true, digest: digestGitComparableContent(result.stdout) };
}

export async function gitBlobDigestEquals(rootDir, relativePath, ref, expectedDigest) {
  if (!expectedDigest) return false;
  const blob = await readGitBlobDigest(rootDir, relativePath, ref);
  return blob.available === true && blob.digest === expectedDigest;
}

export async function evaluateRegistryFreshness(rootDir, options = {}) {
  const { config } = options.config ? { config: options.config } : await loadWildArrangeConfig(rootDir).catch(() => ({ config: {} }));
  const locator = readLocator(config);
  if (!locatorConfigured(locator)) {
    return {
      kind: "registry_freshness",
      status: "not_adopted",
      stale: false,
      reason: "verificationGovernance locator 未配置，表示尚未接管",
      nextAction: "需要时运行 wildarrange adoption start",
    };
  }
  const registry = await readJson(path.join(rootDir, locator.registryPath), null);
  const bootstrap = await readJson(path.join(rootDir, locator.bootstrapPath), null);
  const inventory = await readVerificationInventory(path.join(rootDir, locator.inventoryPath), null);
  if (!registry || !bootstrap || !inventory) {
    return {
      kind: "registry_freshness",
      status: "missing_artifacts",
      stale: true,
      reason: "locator 指向的三文件缺失",
      nextAction: "运行 wildarrange adoption resume 或重新生成三文件",
      locator,
    };
  }
  const currentRegistryDigest = digestCanonical(withoutDigest(registry));
  const currentBootstrapDigest = digestCanonical(withoutDigest(bootstrap));
  if (inventory.registryDigest !== currentRegistryDigest || inventory.bootstrapDigest !== currentBootstrapDigest) {
    return {
      kind: "registry_freshness",
      status: "artifact_drift",
      stale: true,
      reason: "Inventory 中的 Registry/Bootstrap digest 与磁盘文件不一致",
      nextAction: "重新生成 Inventory 或检查未批准的手工改动",
      locator,
    };
  }
  const declared = declaredInputPaths(registry, locator, options.extraDeclaredInputs || []);
  const currentDeclared = await computeDeclaredInputFingerprint(rootDir, declared, {
    exclude: [locator.inventoryPath, locator.bootstrapPath],
  });
  const expectedDeclared = inventory.declaredInputFingerprint || options.expectedDeclaredFingerprint;
  if (expectedDeclared && expectedDeclared !== currentDeclared) {
    return {
      kind: "registry_freshness",
      status: "declared_input_drift",
      stale: true,
      reason: "声明输入（Registry/Runner/入口/发现范围）已变化",
      nextAction: "运行 wildarrange adoption start 重新扫描并批准变更",
      locator,
      declaredInputFingerprint: currentDeclared,
    };
  }
  if (options.universeFingerprint && inventory.discoveryUniverseFingerprint && options.universeFingerprint !== inventory.discoveryUniverseFingerprint) {
    return {
      kind: "registry_freshness",
      status: "universe_drift",
      stale: true,
      reason: "发现范围变化，Registry 可能过期",
      nextAction: "运行 wildarrange adoption start 重新扫描",
      locator,
    };
  }
  return {
    kind: "registry_freshness",
    status: "fresh",
    stale: false,
    reason: "三文件与声明输入一致",
    nextAction: null,
    locator,
    baselineRef: bootstrap.baselineRef || null,
  };
}

function commandHintPath(command) {
  const match = String(command || "").match(/(?:^|\s)((?:[\w./-]+)\.(?:mjs|js|cjs|ts|json|yml|yaml))\b/);
  return match ? match[1] : "";
}

function withoutDigest(value) {
  if (!value || typeof value !== "object") return value;
  const { digest: _digest, ...rest } = value;
  return rest;
}

export async function readGitInventoryContext(rootDir, baselineRef = null, options = {}) {
  const head = await readGitHead(rootDir);
  if (!head.available) return { baselineRef, headSha: null, branch: null, wip: [] };
  const [branchResult, statusResult] = await Promise.all([
    runCommandFile("git", ["-C", rootDir, "branch", "--show-current"], rootDir, 15_000),
    runCommandFile("git", ["-C", rootDir, "status", "--short"], rootDir, 15_000),
  ]);
  const excluded = new Set((options.exclude || []).map((item) => normalizeRelativePath(item)));
  const wip = statusResult.exitCode === 0
    ? statusResult.stdout.split(/\r?\n/).filter(Boolean).filter((line) => {
      const relativePath = normalizeRelativePath(line.slice(3).trim().replace(/^"|"$/g, ""));
      return !excluded.has(relativePath);
    })
    : [];
  return {
    baselineRef,
    headSha: head.sha,
    branch: branchResult.exitCode === 0 ? branchResult.stdout.trim() || "detached" : null,
    wip,
  };
}

function buildInventoryViews(cards) {
  const summaries = (cards || []).map(summarizeInventoryCard);
  return {
    currentSources: summaries.filter((item) => ["adopt", "change", "merge"].includes(item.action) && !["rejected", "deferred"].includes(item.status)),
    historicalArchives: summaries.filter((item) => item.action === "archive" && Boolean(item.appliedAt)),
    deletedTombstones: summaries.filter((item) => item.action === "delete" && Boolean(item.appliedAt)),
    deferredConfirmations: summaries.filter((item) => item.action === "defer" || item.status === "deferred"),
    changeLog: summaries,
  };
}

function summarizeInventoryCard(card = {}) {
  return {
    id: card.id || "",
    action: card.action || "defer",
    status: card.status || "unknown",
    appliedAt: card.appliedAt || null,
    path: card.path || "",
    owner: card.owner || "",
    purpose: card.purpose || "",
    reason: card.reason || "",
    afterState: card.afterState || "",
    maxConsequence: card.maxConsequence || "",
    rollback: card.rollback || "",
    evidence: Array.isArray(card.evidence) ? card.evidence : [],
  };
}

function renderInventoryEntry(entry) {
  return `<article class="entry"><span class="tag">${escapeHtml(entry.action)} · ${escapeHtml(entry.status)}</span><h3>${escapeHtml(entry.path || entry.id || "未命名资产")}</h3><dl><dt>是什么</dt><dd>${escapeHtml(entry.owner || "未登记 Owner")}</dd><dt>作用</dt><dd>${escapeHtml(entry.purpose || "未说明")}</dd><dt>为什么</dt><dd>${escapeHtml(entry.reason || "未说明")}</dd><dt>完成后</dt><dd>${escapeHtml(entry.afterState || "保持原状")}</dd><dt>最大后果</dt><dd>${escapeHtml(entry.maxConsequence || "未发现额外后果")}</dd><dt>如何恢复</dt><dd>${escapeHtml(entry.rollback || "无需恢复")}</dd></dl></article>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
