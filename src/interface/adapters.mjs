// =============================================================================
// 文件名称：adapters.mjs
// 所属模块：interface
// 作用说明：
//   外置治理模式的 Adapter 编排：生成安装包（包内容见 adapter-bundles.mjs、
//   bridge 模板见 adapter-bridge-template.mjs）、显式激活 Cursor/Codex/Claude Code 用户级配置、
//   卸载、恢复备份与完整性检查。所有生成物与备份都留在 runtimeRoot 或用户配置目录，不写客户项目。
// =============================================================================
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROJECT_DIR } from "../infra/prompt-pack.mjs";
import { DEFAULT_PACKAGE_NAME } from "../infra/runtime-config.mjs";
import { runCommandFile } from "../infra/command-runner.mjs";
import { nowIso, readJson, resolveWildArrangePath, writeJsonAtomic } from "../infra/runtime-store.mjs";
import { renderHookBridge } from "./adapter-bridge-template.mjs";
import { resolveExecutorBin } from "./executor-cli.mjs";
import {
  buildCursorUserHooks,
  CLAUDE_MARKETPLACE_NAME,
  CLAUDE_PLUGIN_NAME,
  CODEX_PLUGIN_NAME,
  CURSOR_BRIDGE_NAME,
  KIMI_PLUGIN_NAME,
  writeClaudeBundle,
  writeCodexBundle,
  writeCursorBundle,
  writeKimiBundle,
} from "./adapter-bundles.mjs";

const ADAPTER_VERSION = 2;

const CURSOR_RULE_NAME = "wildarrange.mdc";
const POINTER_BEGIN = "<!-- wildarrange:begin -->";
const POINTER_END = "<!-- wildarrange:end -->";
const POINTER_BLOCK_PATTERN = /\n*<!-- wildarrange:begin -->[\s\S]*?<!-- wildarrange:end -->\n*/;
const BUNDLE_DIRECTORIES = { codex: "codex-marketplace", cursor: "cursor", kimi: "kimi", claude: "claude-marketplace" };
const HOSTS = ["codex", "cursor", "kimi", "claude"];
const TARGETS = new Set(["all", ...HOSTS]);
const CLAUDE_PLUGIN_ID = `${CLAUDE_PLUGIN_NAME}@${CLAUDE_MARKETPLACE_NAME}`;

// --- CLI 前缀 ---

/**
 * 根据 local/npx 模式返回 wildarrange CLI 调用前缀字符串。
 * @param {{ mode?: string, packageName?: string, localCliPath?: string }} [options]
 * @returns {string}
 */
export function adapterCliPrefix({ mode = "local", packageName = DEFAULT_PACKAGE_NAME, localCliPath } = {}) {
  if (!/^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packageName)) {
    throw new Error("adapter package must be a plain npm package name or @scope/name");
  }
  if (mode === "npx") return `npx -y ${packageName}`;
  if (mode !== "local") throw new Error("adapter mode must be local or npx");
  return `node "${path.resolve(localCliPath || path.join(PROJECT_DIR, "bin", "wildarrange.mjs"))}"`;
}

/** 在外部 runtime 生成各宿主安装包；只生成，不把文件存在冒充为宿主激活。 */
export async function installAdapters(projectRoot, workspace, options = {}) {
  assertWorkspace(workspace);
  const target = options.target || "all";
  if (!TARGETS.has(target)) throw new Error("external adapter target must be all, codex, cursor, kimi, or claude");
  const mode = options.mode || "local";
  const packageName = options.packageName || DEFAULT_PACKAGE_NAME;
  const localCliPath = path.resolve(options.localCliPath || path.join(process.cwd(), "bin", "wildarrange.mjs"));
  const cliPrefix = adapterCliPrefix({ mode, packageName, localCliPath });
  const externalRoot = resolveWildArrangePath(workspace.projectRoot, "adapters", "external");
  await mkdir(externalRoot, { recursive: true });
  const selected = target === "all" ? HOSTS : [target];
  const targets = {};
  for (const host of selected) {
    // 用户级插件可能服务多个已连接项目；activationId 绑定宿主桥版本与 CLI，
    // 不绑定某个 projectId。项目归属由各自 runtime ledger 隔离。
    const activationId = adapterActivationId(host, { mode, packageName, localCliPath });
    const bridge = renderHookBridge({ host, mode, packageName, localCliPath, activationId, hookTimeoutMs: options.hookTimeoutMs });
    if (host === "codex") targets.codex = await writeCodexBundle(externalRoot, bridge, activationId, cliPrefix);
    if (host === "cursor") targets.cursor = await writeCursorBundle(externalRoot, bridge, activationId, cliPrefix);
    if (host === "kimi") targets.kimi = await writeKimiBundle(externalRoot, bridge, activationId, cliPrefix);
    if (host === "claude") targets.claude = await writeClaudeBundle(externalRoot, bridge, activationId, cliPrefix);
  }
  const reportPath = path.join(externalRoot, "install-report.json");
  const previous = await readJson(reportPath, null);
  for (const [host, entry] of Object.entries(targets)) {
    // 记录生成物内容 digest，doctor 据此发现 Hook 配置被改；已有的用户级激活记录随重装保留。
    entry.integrity = await digestFiles([entry.hooksPath, entry.bridgePath, entry.manifestPath, entry.marketplacePath]);
    if (previous?.targets?.[host]?.user) entry.user = previous.targets[host].user;
  }
  const report = {
    kind: "wildarrange_external_adapter_install",
    schemaVersion: 1,
    at: nowIso(),
    projectId: workspace.projectId,
    projectRoot: workspace.projectRoot,
    runtimeRoot: workspace.runtimeRoot,
    mode,
    packageName,
    cliPrefix,
    activationVerified: false,
    targets: { ...(previous?.targets || {}), ...targets },
  };
  await writeJsonAtomic(reportPath, report);
  return report;
}

/** 显式合并 Cursor 用户级 Hook 并写入用户级指针规则；先备份，只替换 WildArrange 自己的条目。 */
export async function activateCursorAdapter(projectRoot, workspace, options = {}) {
  assertWorkspace(workspace);
  const { externalRoot, reportPath, report } = await loadReport(workspace);
  const cursor = report?.targets?.cursor;
  if (!cursor) throw new Error("external Cursor adapter bundle is missing; run adapter install --target cursor first");
  const userRoot = path.resolve(options.userRoot || os.homedir());
  const cursorRoot = path.join(userRoot, ".cursor");
  const hooksPath = path.join(cursorRoot, "hooks.json");
  const bridgePath = path.join(cursorRoot, "hooks", CURSOR_BRIDGE_NAME);
  const rulePath = path.join(cursorRoot, "rules", CURSOR_RULE_NAME);
  const sourceBridge = path.resolve(cursor.bridgePath);
  if (!existsSync(sourceBridge)) throw new Error(`external Cursor bridge is missing: ${sourceBridge}`);
  const existing = await readJson(hooksPath, { version: 1, hooks: {} });
  if (!existing || typeof existing !== "object" || Array.isArray(existing)
    || (existing.version !== undefined && existing.version !== 1)
    || (existing.hooks !== undefined && (typeof existing.hooks !== "object" || Array.isArray(existing.hooks)))) {
    throw new Error("existing Cursor user hooks.json is invalid; no files were changed");
  }
  const backup = await backupUserFiles(externalRoot, "cursor", [
    { name: "cursor-hooks.json", target: hooksPath },
    { name: "cursor-bridge.mjs", target: bridgePath },
    { name: "cursor-rule.mdc", target: rulePath },
  ]);
  await mkdir(path.dirname(bridgePath), { recursive: true });
  await copyFile(sourceBridge, bridgePath);
  const managed = buildCursorUserHooks(`node ./hooks/${CURSOR_BRIDGE_NAME}`);
  const hooks = { ...(existing.hooks || {}) };
  for (const [event, additions] of Object.entries(managed.hooks)) {
    const retained = Array.isArray(hooks[event])
      ? hooks[event].filter((entry) => !String(entry?.command || "").includes(CURSOR_BRIDGE_NAME))
      : [];
    hooks[event] = [...retained, ...additions];
  }
  await mkdir(cursorRoot, { recursive: true });
  const merged = { ...existing, version: 1, hooks };
  await writeJsonAtomic(hooksPath, merged);
  const ruleText = renderCursorPointerRule(cursor.cliPrefix);
  await mkdir(path.dirname(rulePath), { recursive: true });
  await writeFile(rulePath, ruleText, "utf8");
  cursor.user = {
    userRoot,
    hooksPath,
    bridgePath,
    rulePath,
    hooksDigest: managedCursorHooksDigest(merged),
    bridgeDigest: await digestFile(bridgePath),
    ruleDigest: sha256(ruleText),
    backupId: backup.backupId,
    activatedAt: nowIso(),
  };
  await writeJsonAtomic(reportPath, report);
  return {
    kind: "wildarrange_external_cursor_activation",
    status: "configured_waiting_for_lifecycle_receipt",
    activationId: cursor.activationId,
    hooksPath,
    bridgePath,
    rulePath,
    backupId: backup.backupId,
    backupPath: backup.files.find((file) => file.name === "cursor-hooks.json")?.existed ? path.join(backup.dir, "cursor-hooks.json") : null,
    projectFilesWritten: [],
  };
}

/** 显式在用户级 ~/.codex/AGENTS.md 写入带起止标记的指针段；Codex 插件本身仍需在其界面安装并信任。 */
export async function activateCodexAdapter(projectRoot, workspace, options = {}) {
  assertWorkspace(workspace);
  const { externalRoot, reportPath, report } = await loadReport(workspace);
  const codex = report?.targets?.codex;
  if (!codex) throw new Error("external Codex adapter bundle is missing; run adapter install --target codex first");
  const userRoot = path.resolve(options.userRoot || os.homedir());
  const agentsPath = path.join(userRoot, ".codex", "AGENTS.md");
  const backup = await backupUserFiles(externalRoot, "codex", [{ name: "codex-AGENTS.md", target: agentsPath }]);
  const current = existsSync(agentsPath) ? await readFile(agentsPath, "utf8") : "";
  const block = renderCodexPointerBlock(codex.cliPrefix);
  const base = current.replace(POINTER_BLOCK_PATTERN, "\n").replace(/\s+$/, "");
  await mkdir(path.dirname(agentsPath), { recursive: true });
  await writeFile(agentsPath, base ? `${base}\n\n${block}\n` : `${block}\n`, "utf8");
  codex.user = {
    userRoot,
    agentsPath,
    pointerDigest: sha256(block),
    backupId: backup.backupId,
    activatedAt: nowIso(),
  };
  await writeJsonAtomic(reportPath, report);
  return {
    kind: "wildarrange_external_codex_activation",
    status: "pointer_written_plugin_install_still_manual",
    agentsPath,
    backupId: backup.backupId,
    nextActions: codex.nextActions,
    projectFilesWritten: [],
  };
}

/**
 * 显式经 claude CLI 把运行态里的本地 marketplace 与插件装到用户级（不写客户项目）。
 * 重复执行只刷新 marketplace；同名 marketplace 指向别处时改指向当前包。
 */
export async function activateClaudeAdapter(projectRoot, workspace, options = {}) {
  assertWorkspace(workspace);
  const { externalRoot, reportPath, report } = await loadReport(workspace);
  const claude = report?.targets?.claude;
  if (!claude) throw new Error("external Claude Code adapter bundle is missing; run adapter install --target claude first");
  const claudeBin = options.claudeBin || "claude";
  // --user-root 时把 Claude Code 的用户配置（含插件与 marketplace 登记）一并隔离到该目录
  const configDir = options.userRoot ? path.join(path.resolve(options.userRoot), ".claude") : null;
  const claudeCli = (args) => runClaude(claudeBin, args, configDir, externalRoot);
  const marketplaceRoot = path.dirname(path.dirname(claude.marketplacePath));
  await claudeCli(["plugin", "validate", marketplaceRoot]);
  const marketplaces = parseJsonArray((await claudeCli(["plugin", "marketplace", "list", "--json"])).stdout);
  const registered = marketplaces.find((entry) => entry?.name === CLAUDE_MARKETPLACE_NAME);
  if (registered && samePath(registered.path || registered.installLocation, marketplaceRoot)) {
    await claudeCli(["plugin", "marketplace", "update", CLAUDE_MARKETPLACE_NAME]);
  } else {
    if (registered) await claudeCli(["plugin", "marketplace", "remove", CLAUDE_MARKETPLACE_NAME, "--scope", "user"]);
    await claudeCli(["plugin", "marketplace", "add", marketplaceRoot]);
  }
  const installed = parseJsonArray((await claudeCli(["plugin", "list", "--json"])).stdout)
    .find((entry) => entry?.id === CLAUDE_PLUGIN_ID && entry.scope === "user");
  const { version } = await readJson(claude.manifestPath, {});
  if (!installed) await claudeCli(["plugin", "install", CLAUDE_PLUGIN_ID, "--scope", "user"]);
  else {
    // 已装副本落后于当前包时刷新缓存；版本号随包内容变化（见 writeClaudeBundle）
    if (installed.version !== version) await claudeCli(["plugin", "update", CLAUDE_PLUGIN_ID, "--scope", "user"]);
    if (installed.enabled === false) await claudeCli(["plugin", "enable", CLAUDE_PLUGIN_ID, "--scope", "user"]);
  }
  claude.user = { claudeBin, configDir, marketplaceRoot, pluginId: CLAUDE_PLUGIN_ID, version, activatedAt: nowIso() };
  await writeJsonAtomic(reportPath, report);
  return {
    kind: "wildarrange_external_claude_activation",
    status: "installed_waiting_for_lifecycle_receipt",
    activationId: claude.activationId,
    pluginId: CLAUDE_PLUGIN_ID,
    marketplaceRoot,
    nextActions: ["在已连接项目中新开一次 Claude Code 会话（已开会话可运行 /reload-plugins），再运行 wildarrange doctor 确认 execution_observed"],
    projectFilesWritten: [],
  };
}

/** 卸载外置 Adapter：移除已激活的用户级 Hook 条目与指针，并删除 runtime 中的插件包；备份保留。 */
export async function uninstallAdapters(projectRoot, workspace, options = {}) {
  assertWorkspace(workspace);
  const target = options.target || "all";
  if (!TARGETS.has(target)) throw new Error("external adapter target must be all, codex, cursor, kimi, or claude");
  const { externalRoot, reportPath, report } = await loadReport(workspace);
  const selected = target === "all" ? HOSTS : [target];
  const removed = [];
  const nextActions = [];
  for (const host of selected) {
    const entry = report?.targets?.[host];
    const user = entry?.user;
    if (host === "cursor" && user) {
      await removeCursorUserEntries(user.hooksPath);
      for (const file of [user.bridgePath, user.rulePath]) {
        if (file && existsSync(file)) { await rm(file, { force: true }); removed.push(file); }
      }
    }
    if (host === "claude" && user) {
      // 先从 Claude Code 卸载，再删运行态包；CLI 失败时如实交给用户手工完成
      for (const args of [["plugin", "uninstall", CLAUDE_PLUGIN_ID, "--scope", "user"], ["plugin", "marketplace", "remove", CLAUDE_MARKETPLACE_NAME, "--scope", "user"]]) {
        const result = await runCommandFile(options.claudeBin || user.claudeBin || "claude", args, externalRoot, 120_000, claudeEnv(user.configDir));
        if (result.exitCode !== 0) nextActions.push(`claude ${args.join(" ")}`);
      }
    }
    if (host === "codex" && user?.agentsPath && existsSync(user.agentsPath)) {
      const stripped = (await readFile(user.agentsPath, "utf8")).replace(POINTER_BLOCK_PATTERN, "\n").replace(/\s+$/, "");
      if (stripped) await writeFile(user.agentsPath, `${stripped}\n`, "utf8");
      else await rm(user.agentsPath, { force: true });
      removed.push(user.agentsPath);
    }
    const bundleRoot = path.join(externalRoot, BUNDLE_DIRECTORIES[host]);
    if (existsSync(bundleRoot)) { await rm(bundleRoot, { recursive: true, force: true }); removed.push(bundleRoot); }
    if (report?.targets?.[host]) delete report.targets[host];
    if (host === "codex") nextActions.push(`在 Codex /plugins 中移除 ${CODEX_PLUGIN_NAME}，并执行 codex plugin marketplace remove wildarrange-local`);
    if (host === "kimi") nextActions.push(`/plugins remove ${KIMI_PLUGIN_NAME}`);
  }
  if (report) await writeJsonAtomic(reportPath, report);
  return { kind: "wildarrange_external_adapter_uninstall", target, removed, nextActions, backupsKept: path.join(externalRoot, "backups") };
}

/** 按 activate 时的备份把用户级文件恢复到激活前状态；激活前不存在的文件会被移除。 */
export async function restoreAdapterBackup(projectRoot, workspace, options = {}) {
  assertWorkspace(workspace);
  const backupId = String(options.backupId || "");
  const { externalRoot, reportPath, report } = await loadReport(workspace);
  const dir = path.join(externalRoot, "backups", backupId);
  const manifest = /^[A-Za-z0-9_.-]+$/.test(backupId) ? await readJson(path.join(dir, "manifest.json"), null) : null;
  if (!manifest) throw new Error(`external adapter backup not found: ${backupId || "(empty)"}`);
  const restored = [];
  for (const file of manifest.files) {
    if (file.existed) {
      await mkdir(path.dirname(file.target), { recursive: true });
      await copyFile(path.join(dir, file.name), file.target);
    } else {
      await rm(file.target, { force: true });
    }
    restored.push(file.target);
  }
  if (report?.targets?.[manifest.scope]) {
    delete report.targets[manifest.scope].user;
    await writeJsonAtomic(reportPath, report);
  }
  return { kind: "wildarrange_external_adapter_restore", backupId, scope: manifest.scope, restored };
}

/**
 * 比对生成物与用户级配置的当前内容和安装/激活时记录的 digest；返回不一致项。
 * doctor 用它发现"回执还在但 Hook 配置已被改动/删除"。
 */
export async function inspectAdapterIntegrity(host, entry) {
  const issues = [];
  for (const [file, digest] of Object.entries(entry?.integrity?.files || {})) {
    const actual = await digestFile(file);
    if (actual === null) issues.push({ file, problem: "missing" });
    else if (actual !== digest) issues.push({ file, problem: "modified" });
  }
  const user = entry?.user;
  if (host === "cursor" && user) {
    const hooks = await readJson(user.hooksPath, null);
    if (!hooks || managedCursorHooksDigest(hooks) !== user.hooksDigest) issues.push({ file: user.hooksPath, problem: "managed_entries_changed" });
    if (await digestFile(user.bridgePath) !== user.bridgeDigest) issues.push({ file: user.bridgePath, problem: "modified_or_missing" });
    if (await digestFile(user.rulePath) !== user.ruleDigest) issues.push({ file: user.rulePath, problem: "modified_or_missing" });
  }
  if (host === "claude" && user?.version) {
    const current = (await readJson(entry.manifestPath, null))?.version;
    if (current !== user.version) issues.push({ file: entry.manifestPath, problem: `stale installed plugin ${user.version}; bundle is ${current || "missing"}` });
  }
  if (host === "codex" && user?.agentsPath) {
    const text = existsSync(user.agentsPath) ? await readFile(user.agentsPath, "utf8") : "";
    const block = text.match(/<!-- wildarrange:begin -->[\s\S]*?<!-- wildarrange:end -->/)?.[0];
    if (!block || sha256(block) !== user.pointerDigest) issues.push({ file: user.agentsPath, problem: "pointer_changed_or_missing" });
  }
  return { status: issues.length === 0 ? "ok" : "modified", issues };
}

/**
 * 调用 claude CLI；失败时带上子命令与输出抛错，找不到 CLI 时给出安装提示。
 * 在运行态目录执行：在客户项目里执行会读到项目级设置，用户级状态因此被误判。
 */
async function runClaude(claudeBin, args, configDir, cwd) {
  const result = await runCommandFile(claudeBin, args, cwd, 120_000, claudeEnv(configDir));
  if (result.spawnError) throw new Error(`claude CLI not found (${claudeBin}); install Claude Code or pass its path, then retry`);
  if (result.exitCode !== 0) throw new Error(`claude ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  return result;
}

function claudeEnv(configDir) {
  return configDir ? { env: { CLAUDE_CONFIG_DIR: configDir } } : {};
}

function parseJsonArray(text) {
  try {
    const value = JSON.parse(text || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function samePath(left, right) {
  const canonical = (value) => { try { return realpathSync(value); } catch { return path.resolve(value); } };
  return Boolean(left) && canonical(left) === canonical(right);
}

/**
 * 查询宿主里 WildArrange 插件此刻是否仍安装且启用（只读，不调用模型）。
 * 历史回执只能证明"曾经运行过"；插件在 WildArrange 之外被卸载或禁用时靠这里发现。
 * @param {string} host claude | codex | kimi（cursor 由用户级 hooks.json digest 覆盖，返回 unknown）
 * @param {object} entry install-report 中该宿主的条目
 * @param {{ claudeBin?: string, codexBin?: string, homeDir?: string, cwd?: string }} [options]
 * @returns {Promise<{ status: "present"|"missing"|"disabled"|"unknown", detail: string }>}
 */
export async function inspectPluginPresence(host, entry, options = {}) {
  const cwd = options.cwd || os.tmpdir();
  if (host === "claude") {
    const user = entry?.user;
    if (!user) return { status: "unknown", detail: "Claude Code plugin was not activated through WildArrange" };
    const result = await runCommandFile(options.claudeBin || user.claudeBin || "claude", ["plugin", "list", "--json"], cwd, 60_000, claudeEnv(user.configDir));
    if (result.spawnError || result.exitCode !== 0) return { status: "unknown", detail: `claude plugin list failed: ${(result.stderr || result.stdout).trim().slice(0, 200)}` };
    const plugin = parseJsonArray(result.stdout).find((item) => item?.id === CLAUDE_PLUGIN_ID && item.scope === "user");
    if (!plugin) return { status: "missing", detail: `${CLAUDE_PLUGIN_ID} is not installed in Claude Code` };
    return plugin.enabled === false ? { status: "disabled", detail: `${CLAUDE_PLUGIN_ID} is disabled in Claude Code` } : { status: "present", detail: "installed and enabled" };
  }
  if (host === "codex") {
    const result = await runCommandFile(options.codexBin || resolveExecutorBin("codex"), ["plugin", "list"], cwd, 60_000);
    if (result.spawnError || result.exitCode !== 0) return { status: "unknown", detail: `codex plugin list failed: ${(result.stderr || result.stdout).trim().slice(0, 200)}` };
    const pluginId = `${CODEX_PLUGIN_NAME}@wildarrange-local`;
    const row = result.stdout.split(/\r?\n/).find((line) => line.trim().startsWith(`${pluginId} `));
    if (!row || /not installed/i.test(row)) return { status: "missing", detail: `${pluginId} is not installed in Codex` };
    return /disabled/i.test(row) ? { status: "disabled", detail: `${pluginId} is disabled in Codex` } : { status: "present", detail: "installed and enabled" };
  }
  if (host === "kimi") {
    const installedPath = path.join(options.homeDir || os.homedir(), ".kimi-code", "plugins", "installed.json");
    if (!existsSync(installedPath)) return { status: "missing", detail: `${installedPath} does not exist` };
    let installed;
    try { installed = JSON.parse(await readFile(installedPath, "utf8")); } catch (error) { return { status: "unknown", detail: `cannot read ${installedPath}: ${error.message}` }; }
    const plugin = (installed?.plugins || []).find((item) => item?.id === KIMI_PLUGIN_NAME);
    if (!plugin) return { status: "missing", detail: `${KIMI_PLUGIN_NAME} is not installed in Kimi Code` };
    return plugin.enabled === false ? { status: "disabled", detail: `${KIMI_PLUGIN_NAME} is disabled in Kimi Code` } : { status: "present", detail: "installed and enabled" };
  }
  return { status: "unknown", detail: `${host} plugin presence is covered by the user hook digest` };
}

async function loadReport(workspace) {
  const externalRoot = resolveWildArrangePath(workspace.projectRoot, "adapters", "external");
  const reportPath = path.join(externalRoot, "install-report.json");
  return { externalRoot, reportPath, report: await readJson(reportPath, null) };
}

/** 备份将被 activate 触碰的用户级文件，并写 manifest 记录"激活前是否存在"，供 restore 精确还原。 */
async function backupUserFiles(externalRoot, scope, files) {
  const backupId = `activate-${scope}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const dir = path.join(externalRoot, "backups", backupId);
  await mkdir(dir, { recursive: true });
  const entries = [];
  for (const file of files) {
    const existed = existsSync(file.target);
    if (existed) await copyFile(file.target, path.join(dir, file.name));
    entries.push({ name: file.name, target: file.target, existed });
  }
  await writeJsonAtomic(path.join(dir, "manifest.json"), { kind: "wildarrange_external_adapter_backup", scope, backupId, at: nowIso(), files: entries });
  return { backupId, dir, files: entries };
}

async function removeCursorUserEntries(hooksPath) {
  const existing = hooksPath ? await readJson(hooksPath, null) : null;
  if (!existing?.hooks) return;
  const hooks = {};
  for (const [event, entries] of Object.entries(existing.hooks)) {
    const kept = Array.isArray(entries) ? entries.filter((entry) => !String(entry?.command || "").includes(CURSOR_BRIDGE_NAME)) : entries;
    if (!Array.isArray(kept) || kept.length > 0) hooks[event] = kept;
  }
  await writeJsonAtomic(hooksPath, { ...existing, hooks });
}

/** 用户 hooks.json 中 WildArrange 自己条目的 digest；与他人的条目无关。 */
function managedCursorHooksDigest(userHooks) {
  const managed = {};
  for (const event of Object.keys(userHooks?.hooks || {}).sort()) {
    const entries = Array.isArray(userHooks.hooks[event])
      ? userHooks.hooks[event].filter((entry) => String(entry?.command || "").includes(CURSOR_BRIDGE_NAME))
      : [];
    if (entries.length > 0) managed[event] = entries;
  }
  return sha256(JSON.stringify(managed));
}

function pointerText(cliPrefix) {
  const command = cliPrefix ? `\`wildarrange status\`（本机 CLI：\`${cliPrefix} status\`）` : "`wildarrange status`";
  return `本机项目若已连接 WildArrange 外置治理，先运行 ${command} 并读取其治理上下文，再改代码；未连接的项目忽略本条。`;
}

function renderCursorPointerRule(cliPrefix) {
  return `---
description: WildArrange governance pointer
alwaysApply: true
---

${pointerText(cliPrefix)}
`;
}

function renderCodexPointerBlock(cliPrefix) {
  return `${POINTER_BEGIN}\n## WildArrange\n\n${pointerText(cliPrefix)}\n${POINTER_END}`;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function digestFile(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  return sha256(await readFile(filePath));
}

async function digestFiles(paths) {
  const files = {};
  for (const filePath of paths) {
    if (filePath) files[filePath] = await digestFile(filePath);
  }
  return { files };
}

export async function loadAdapterReport(projectRoot) {
  return readJson(resolveWildArrangePath(projectRoot, "adapters", "external", "install-report.json"), null);
}

function adapterActivationId(host, options) {
  return createHash("sha256")
    .update(JSON.stringify({ version: ADAPTER_VERSION, host, ...options }))
    .digest("hex");
}

function assertWorkspace(workspace) {
  if (!workspace) {
    throw new Error("adapter operations require a project connected to WildArrange governance; run `wildarrange setup` first");
  }
}
