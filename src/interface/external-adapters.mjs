// =============================================================================
// 文件名称：external-adapters.mjs
// 所属模块：interface
// 作用说明：
//   为外置治理模式生成用户级宿主 Adapter 包，并显式激活 Cursor 用户 Hook。
//   所有生成物与备份都留在 runtimeRoot 或用户配置目录，不写客户项目。
// =============================================================================
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PACKAGE_NAME } from "../infra/runtime-config.mjs";
import { nowIso, readJson, resolveWildArrangePath, writeJsonAtomic } from "../infra/runtime-store.mjs";
import { adapterCliPrefix, buildSlashCommands } from "./adapters.mjs";
import { renderCliInvocationUtility, renderGovernedProjectCheck, renderHookBridgeExecution } from "./hook-bridge-core.mjs";

const EXTERNAL_ADAPTER_VERSION = 2;
const EXTERNAL_CODEX_PLUGIN_NAME = "wildarrange-governance";
const EXTERNAL_KIMI_PLUGIN_NAME = "wildarrange-governance";
export const EXTERNAL_CURSOR_BRIDGE_NAME = "wildarrange-external-hook-bridge.mjs";

/** bridge 子进程超时：须小于宿主 Hook 最短 timeout（15s），保证 bridge 先于宿主自行收尾。 */
const EXTERNAL_HOOK_TIMEOUT_MS = 14_000;

const CURSOR_RULE_NAME = "wildarrange.mdc";
const POINTER_BEGIN = "<!-- wildarrange:begin -->";
const POINTER_END = "<!-- wildarrange:end -->";
const POINTER_BLOCK_PATTERN = /\n*<!-- wildarrange:begin -->[\s\S]*?<!-- wildarrange:end -->\n*/;
const BUNDLE_DIRECTORIES = { codex: "codex-marketplace", cursor: "cursor", kimi: "kimi" };

const TARGETS = new Set(["all", "codex", "cursor", "kimi"]);

/** 在外部 runtime 生成三宿主安装包；只生成，不把文件存在冒充为宿主激活。 */
export async function installExternalAdapters(projectRoot, workspace, options = {}) {
  assertExternalWorkspace(workspace);
  const target = options.target || "all";
  if (!TARGETS.has(target)) throw new Error("external adapter target must be all, codex, cursor, or kimi");
  const mode = options.mode || "local";
  const packageName = options.packageName || DEFAULT_PACKAGE_NAME;
  const localCliPath = path.resolve(options.localCliPath || path.join(process.cwd(), "bin", "wildarrange.mjs"));
  const cliPrefix = adapterCliPrefix({ mode, packageName, localCliPath });
  const externalRoot = resolveWildArrangePath(workspace.projectRoot, "adapters", "external");
  await mkdir(externalRoot, { recursive: true });
  const selected = target === "all" ? ["codex", "cursor", "kimi"] : [target];
  const targets = {};
  for (const host of selected) {
    // 用户级插件可能服务多个已连接项目；activationId 绑定宿主桥版本与 CLI，
    // 不绑定某个 projectId。项目归属由各自 runtime ledger 隔离。
    const activationId = adapterActivationId(host, { mode, packageName, localCliPath });
    const bridge = renderExternalHookBridge({ host, mode, packageName, localCliPath, activationId, hookTimeoutMs: options.hookTimeoutMs });
    if (host === "codex") targets.codex = await writeCodexBundle(externalRoot, bridge, activationId, cliPrefix);
    if (host === "cursor") targets.cursor = await writeCursorBundle(externalRoot, bridge, activationId, cliPrefix);
    if (host === "kimi") targets.kimi = await writeKimiBundle(externalRoot, bridge, activationId, cliPrefix);
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
export async function activateExternalCursorAdapter(projectRoot, workspace, options = {}) {
  assertExternalWorkspace(workspace);
  const { externalRoot, reportPath, report } = await loadReport(workspace);
  const cursor = report?.targets?.cursor;
  if (!cursor) throw new Error("external Cursor adapter bundle is missing; run adapter install --target cursor first");
  const userRoot = path.resolve(options.userRoot || os.homedir());
  const cursorRoot = path.join(userRoot, ".cursor");
  const hooksPath = path.join(cursorRoot, "hooks.json");
  const bridgePath = path.join(cursorRoot, "hooks", EXTERNAL_CURSOR_BRIDGE_NAME);
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
  const managed = buildCursorUserHooks(`node ./hooks/${EXTERNAL_CURSOR_BRIDGE_NAME}`);
  const hooks = { ...(existing.hooks || {}) };
  for (const [event, additions] of Object.entries(managed.hooks)) {
    const retained = Array.isArray(hooks[event])
      ? hooks[event].filter((entry) => !String(entry?.command || "").includes(EXTERNAL_CURSOR_BRIDGE_NAME))
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
export async function activateExternalCodexAdapter(projectRoot, workspace, options = {}) {
  assertExternalWorkspace(workspace);
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

/** 卸载外置 Adapter：移除已激活的用户级 Hook 条目与指针，并删除 runtime 中的插件包；备份保留。 */
export async function uninstallExternalAdapters(projectRoot, workspace, options = {}) {
  assertExternalWorkspace(workspace);
  const target = options.target || "all";
  if (!TARGETS.has(target)) throw new Error("external adapter target must be all, codex, cursor, or kimi");
  const { externalRoot, reportPath, report } = await loadReport(workspace);
  const selected = target === "all" ? ["codex", "cursor", "kimi"] : [target];
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
    if (host === "codex" && user?.agentsPath && existsSync(user.agentsPath)) {
      const stripped = (await readFile(user.agentsPath, "utf8")).replace(POINTER_BLOCK_PATTERN, "\n").replace(/\s+$/, "");
      if (stripped) await writeFile(user.agentsPath, `${stripped}\n`, "utf8");
      else await rm(user.agentsPath, { force: true });
      removed.push(user.agentsPath);
    }
    const bundleRoot = path.join(externalRoot, BUNDLE_DIRECTORIES[host]);
    if (existsSync(bundleRoot)) { await rm(bundleRoot, { recursive: true, force: true }); removed.push(bundleRoot); }
    if (report?.targets?.[host]) delete report.targets[host];
    if (host === "codex") nextActions.push(`在 Codex /plugins 中移除 ${EXTERNAL_CODEX_PLUGIN_NAME}，并执行 codex plugin marketplace remove wildarrange-local`);
    if (host === "kimi") nextActions.push(`/plugins remove ${EXTERNAL_KIMI_PLUGIN_NAME}`);
  }
  if (report) await writeJsonAtomic(reportPath, report);
  return { kind: "wildarrange_external_adapter_uninstall", target, removed, nextActions, backupsKept: path.join(externalRoot, "backups") };
}

/** 按 activate 时的备份把用户级文件恢复到激活前状态；激活前不存在的文件会被移除。 */
export async function restoreExternalAdapterBackup(projectRoot, workspace, options = {}) {
  assertExternalWorkspace(workspace);
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
export async function inspectExternalAdapterIntegrity(host, entry) {
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
  if (host === "codex" && user?.agentsPath) {
    const text = existsSync(user.agentsPath) ? await readFile(user.agentsPath, "utf8") : "";
    const block = text.match(/<!-- wildarrange:begin -->[\s\S]*?<!-- wildarrange:end -->/)?.[0];
    if (!block || sha256(block) !== user.pointerDigest) issues.push({ file: user.agentsPath, problem: "pointer_changed_or_missing" });
  }
  return { status: issues.length === 0 ? "ok" : "modified", issues };
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
    const kept = Array.isArray(entries) ? entries.filter((entry) => !String(entry?.command || "").includes(EXTERNAL_CURSOR_BRIDGE_NAME)) : entries;
    if (!Array.isArray(kept) || kept.length > 0) hooks[event] = kept;
  }
  await writeJsonAtomic(hooksPath, { ...existing, hooks });
}

/** 用户 hooks.json 中 WildArrange 自己条目的 digest；与他人的条目无关。 */
function managedCursorHooksDigest(userHooks) {
  const managed = {};
  for (const event of Object.keys(userHooks?.hooks || {}).sort()) {
    const entries = Array.isArray(userHooks.hooks[event])
      ? userHooks.hooks[event].filter((entry) => String(entry?.command || "").includes(EXTERNAL_CURSOR_BRIDGE_NAME))
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

export async function loadExternalAdapterReport(projectRoot) {
  return readJson(resolveWildArrangePath(projectRoot, "adapters", "external", "install-report.json"), null);
}

async function writeCodexBundle(externalRoot, bridge, activationId, cliPrefix) {
  const marketplaceRoot = path.join(externalRoot, "codex-marketplace");
  const pluginRoot = path.join(marketplaceRoot, "plugins", EXTERNAL_CODEX_PLUGIN_NAME);
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const hooksPath = path.join(pluginRoot, "hooks", "hooks.json");
  const bridgePath = path.join(pluginRoot, "hooks", EXTERNAL_CURSOR_BRIDGE_NAME);
  await writeJsonAtomic(manifestPath, {
    name: EXTERNAL_CODEX_PLUGIN_NAME,
    version: "1.0.0",
    description: "Project-selective WildArrange governance hooks without repository files.",
    author: { name: "AliveWaveLab" },
    interface: {
      displayName: "WildArrange Governance",
      shortDescription: "External lifecycle governance for attached projects.",
      longDescription: "Loads policy and runtime state only for projects explicitly attached to an external governance repository.",
      developerName: "AliveWaveLab",
      category: "Developer Tools",
      capabilities: ["Read", "Write"],
      defaultPrompt: [
        "检查当前项目的 WildArrange 治理状态",
        "按 WildArrange 计划和门禁继续当前任务",
      ],
    },
  });
  await writeJsonAtomic(hooksPath, buildCodexHooksConfig(`node "\${PLUGIN_ROOT}/hooks/${EXTERNAL_CURSOR_BRIDGE_NAME}"`));
  await mkdir(path.dirname(bridgePath), { recursive: true });
  await writeFile(bridgePath, bridge, "utf8");
  await writePluginSkills(pluginRoot, cliPrefix);
  // Codex CLI discovers a local marketplace from the standard repository
  // manifest location under the marketplace root.
  const marketplacePath = path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json");
  await writeJsonAtomic(marketplacePath, {
    name: "wildarrange-local",
    interface: { displayName: "WildArrange Local" },
    plugins: [{
      name: EXTERNAL_CODEX_PLUGIN_NAME,
      source: { source: "local", path: `./plugins/${EXTERNAL_CODEX_PLUGIN_NAME}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools",
    }],
  });
  return {
    status: "bundle_generated",
    activationId,
    pluginRoot,
    hooksPath,
    bridgePath,
    marketplacePath,
    cliPrefix,
    activation: "manual_install_and_trust_required",
    nextActions: [
      `codex plugin marketplace add "${marketplaceRoot}"`,
      `在 Codex /plugins 中安装 ${EXTERNAL_CODEX_PLUGIN_NAME}`,
      "审查并信任插件 Hooks，然后在已连接项目中新开一次会话",
    ],
  };
}

async function writeCursorBundle(externalRoot, bridge, activationId, cliPrefix) {
  const root = path.join(externalRoot, "cursor");
  const bridgePath = path.join(root, "hooks", EXTERNAL_CURSOR_BRIDGE_NAME);
  const hooksPath = path.join(root, "hooks.json");
  await mkdir(path.dirname(bridgePath), { recursive: true });
  await writeFile(bridgePath, bridge, "utf8");
  await writeJsonAtomic(hooksPath, buildCursorUserHooks(`node ./hooks/${EXTERNAL_CURSOR_BRIDGE_NAME}`));
  return {
    status: "bundle_generated",
    activationId,
    hooksPath,
    bridgePath,
    activation: "explicit_user_activation_required",
    nextActions: ["wildarrange adapter activate --target cursor"],
    cliPrefix,
  };
}

async function writeKimiBundle(externalRoot, bridge, activationId, cliPrefix) {
  const pluginRoot = path.join(externalRoot, "kimi", "plugin");
  const manifestPath = path.join(pluginRoot, "kimi.plugin.json");
  const bridgePath = path.join(pluginRoot, "hooks", EXTERNAL_CURSOR_BRIDGE_NAME);
  await writeJsonAtomic(manifestPath, buildKimiManifest());
  await mkdir(path.dirname(bridgePath), { recursive: true });
  await writeFile(bridgePath, bridge, "utf8");
  await writePluginSkills(pluginRoot, cliPrefix);
  return {
    status: "bundle_generated",
    activationId,
    pluginRoot,
    manifestPath,
    bridgePath,
    cliPrefix,
    activation: "manual_install_required",
    nextActions: [`/plugins install ${pluginRoot}`, "/reload", "在已连接项目中新开一次会话"],
  };
}

async function writePluginSkills(pluginRoot, cliPrefix) {
  for (const command of buildSlashCommands(cliPrefix)) {
    const skillPath = path.join(pluginRoot, "skills", command.name, "SKILL.md");
    await mkdir(path.dirname(skillPath), { recursive: true });
    await writeFile(skillPath, `---
name: ${command.name}
description: ${command.description}
---

# ${command.title}

${command.body}
`, "utf8");
  }
}

function buildCodexHooksConfig(command) {
  const hook = (timeout, statusMessage) => ({ type: "command", command, timeout, statusMessage });
  return {
    hooks: {
      SessionStart: [{ hooks: [hook(30, "WildArrange: loading external governance")] }],
      UserPromptSubmit: [{ hooks: [hook(20, "WildArrange: routing with external governance")] }],
      PreToolUse: [{
        matcher: "^(Bash|apply_patch|functions\\.apply_patch|write|Write|edit|Edit|multi_edit|multiedit|MultiEdit|create_goal|functions\\.create_goal)$",
        hooks: [hook(20, "WildArrange: checking planned scope")],
      }],
      PostToolUse: [{ hooks: [hook(15, "WildArrange: recording tool result")] }],
      PostCompact: [{ matcher: "manual|auto", hooks: [hook(20, "WildArrange: restoring governance context")] }],
      Stop: [{ hooks: [hook(15, "WildArrange: checking continuation")] }],
      SubagentStop: [{ hooks: [hook(15, "WildArrange: checking continuation")] }],
    },
  };
}

function buildCursorUserHooks(command) {
  const hook = (extra = {}) => ({ command, ...extra });
  return {
    version: 1,
    hooks: {
      sessionStart: [hook({ timeout: 30 })],
      beforeSubmitPrompt: [hook({ timeout: 20 })],
      preToolUse: [hook({ timeout: 20, matcher: "Write|Delete|Edit|StrReplace|MultiEdit|Shell", failClosed: true })],
      beforeShellExecution: [hook({ timeout: 20, failClosed: true })],
      postToolUse: [hook({ timeout: 15 })],
      postToolUseFailure: [hook({ timeout: 15 })],
      stop: [hook({ timeout: 15 })],
      subagentStop: [hook({ timeout: 15 })],
    },
  };
}

function buildKimiManifest() {
  const command = `node ./hooks/${EXTERNAL_CURSOR_BRIDGE_NAME}`;
  const hook = (event, matcher) => ({ event, ...(matcher ? { matcher } : {}), command, timeout: 20 });
  return {
    name: EXTERNAL_KIMI_PLUGIN_NAME,
    version: "1.0.0",
    description: "Project-selective WildArrange lifecycle governance bridge.",
    skills: "./skills/",
    interface: {
      displayName: "WildArrange Governance",
      shortDescription: "External governance for explicitly attached projects.",
      developerName: "AliveWaveLab",
    },
    hooks: [
      hook("SessionStart", "^(startup|resume)$"),
      hook("UserPromptSubmit"),
      hook("PreToolUse", "^(Bash|Write|Edit)$"),
      hook("PostToolUse"),
      hook("PostToolUseFailure"),
      hook("PostCompact", "^(manual|auto)$"),
      hook("Stop"),
      hook("SubagentStop"),
    ],
  };
}

function renderExternalHookBridge({ host, mode, packageName, localCliPath, activationId, hookTimeoutMs = EXTERNAL_HOOK_TIMEOUT_MS }) {
  const cliSpec = mode === "npx"
    ? { kind: "npx", packageName }
    : { kind: "local", cliPath: path.resolve(localCliPath), packageName };
  const eventMap = host === "cursor" ? {
    sessionStart: "SessionStart",
    beforeSubmitPrompt: "UserPromptSubmit",
    preToolUse: "PreToolUse",
    beforeShellExecution: "PreToolUse",
    postToolUse: "PostToolUse",
    postToolUseFailure: "PostToolUseFailure",
    stop: "Stop",
    subagentStop: "SubagentStop",
  } : null;
  // 三宿主共用一个骨架：先只读 registry 判断是否受治理项目（未命中直接放行），
  // 命中后才调用 CLI；子进程超时/出错/退出非 0 由 failHook 按宿主策略处理。
  return `#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
const HOST = ${JSON.stringify(host)};
const ACTIVATION_ID = ${JSON.stringify(activationId)};
const cliSpec = ${JSON.stringify(cliSpec)};
const EVENT_MAP = ${JSON.stringify(eventMap)};
let input = "";
for await (const chunk of process.stdin) input += chunk;
let payload;
try { payload = JSON.parse(input); } catch { process.exit(1); }
const rawCwd = payload.cwd || payload.workspace_roots?.[0] || process.env.CURSOR_PROJECT_DIR || process.cwd();
let projectDir;
try { projectDir = realpathSync(rawCwd); } catch { process.exit(0); }
const event = EVENT_MAP ? EVENT_MAP[payload.hook_event_name] : payload.hook_event_name;
if (!event) process.exit(0);
// 用户级 Hook 只对 registry 已连接的项目生效；未连接项目与 WildArrange 自身安装损坏都不得阻断。
if (!isGovernedProject(projectDir)) process.exit(0);
const shell = HOST === "cursor" && payload.hook_event_name === "beforeShellExecution";
const normalizedPayload = {
  ...payload,
  hook_event_name: event,
  cwd: projectDir,
  session_id: payload.session_id || payload.conversation_id,
  prompt: payload.prompt || payload.user_prompt,
  tool_name: shell || payload.tool_name === "Shell" ? "Bash" : payload.tool_name,
  tool_input: shell ? { command: payload.command } : payload.tool_input,
};
${renderHookBridgeExecution({
    hostAdapter: host,
    timeoutMs: hookTimeoutMs,
    cliArgsSource: '["--project-root", projectDir, "--external-only", "--host", HOST, "--adapter-digest", ACTIVATION_ID]',
  })}
if (result.inactive === true) process.exit(0);
if (HOST === "cursor") {
  if (event === "PreToolUse") {
    if (result.decision === "allow") emit({ permission: "allow", ...(result.output ? { additional_context: result.output } : {}) });
    else emit({ permission: "deny", user_message: "WildArrange 已阻断本次操作。", agent_message: denyReason(result) });
  } else if ((event === "Stop" || event === "SubagentStop") && result.continuation?.required === true) {
    emit({ followup_message: result.continuation.nextCommand || result.continuation.reason || "WildArrange requires continuation." });
  } else if (result.output && event !== "UserPromptSubmit") emit({ additional_context: result.output });
  process.exit(0);
}
if (HOST === "kimi" && event === "Stop" && result.continuation?.required === true) {
  const reason = [
    "WildArrange requires this task to continue.",
    result.continuation.reason || "",
    result.continuation.nextCommand ? "Next command: " + result.continuation.nextCommand : "",
  ].filter(Boolean).join(" ");
  emit({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: reason } });
  process.exit(0);
}
if (HOST === "kimi") {
  if (typeof result.output === "string") process.stdout.write(result.output);
  process.exit(0);
}
if (event === "Stop" || event === "SubagentStop") {
  if (result.continuation?.required === true) {
    emit({ decision: "block", reason: result.continuation.nextCommand || result.continuation.reason || "WildArrange requires continuation." });
  } else emit({});
  process.exit(0);
}
if (typeof result.output === "string") process.stdout.write(result.output);
function emit(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
/** deny 只带原因摘要，不塞整段注入 JSON。 */
function denyReason(value) {
  try {
    const reason = JSON.parse(value.output)?.hookSpecificOutput?.permissionDecisionReason;
    if (typeof reason === "string" && reason) return reason.slice(0, 1000);
  } catch { /* 输出不是 JSON 时走通用文案 */ }
  return "WildArrange denied this operation.";
}
/** 已确认受治理后的失败出口：Cursor 写操作 fail-closed，其余宿主 fail-open（非 0 退出）。 */
function failHook(message, exitCode = 1) {
  if (message) console.error(String(message).slice(0, 2000));
  if (HOST === "cursor" && event === "PreToolUse") {
    emit({ permission: "deny", user_message: "WildArrange 外置治理 Hook 故障，已阻断写操作。", agent_message: "Run wildarrange doctor before retrying." });
    process.exit(0);
  }
  process.exit(exitCode || 1);
}
${renderGovernedProjectCheck()}
${renderCliInvocationUtility()}
`;
}

function adapterActivationId(host, options) {
  return createHash("sha256")
    .update(JSON.stringify({ version: EXTERNAL_ADAPTER_VERSION, host, ...options }))
    .digest("hex");
}

function assertExternalWorkspace(workspace) {
  if (!workspace || workspace.mode !== "external") {
    throw new Error("external adapter operations require an attached external governance workspace");
  }
}
