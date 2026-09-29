// =============================================================================
// 文件名称：external-adapters.mjs
// 所属模块：interface
// 作用说明：
//   为外置治理模式生成用户级宿主 Adapter 包，并显式激活 Cursor 用户 Hook。
//   所有生成物与备份都留在 runtimeRoot 或用户配置目录，不写客户项目。
// =============================================================================
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PACKAGE_NAME } from "../infra/runtime-config.mjs";
import { nowIso, readJson, resolveWildArrangePath, writeJsonAtomic } from "../infra/runtime-store.mjs";
import { adapterCliPrefix, buildSlashCommands } from "./adapters.mjs";

const EXTERNAL_ADAPTER_VERSION = 2;
const EXTERNAL_CODEX_PLUGIN_NAME = "wildarrange-governance";
const EXTERNAL_KIMI_PLUGIN_NAME = "wildarrange-governance";
export const EXTERNAL_CURSOR_BRIDGE_NAME = "wildarrange-external-hook-bridge.mjs";

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
    const bridge = renderExternalHookBridge({ host, mode, packageName, localCliPath, activationId });
    if (host === "codex") targets.codex = await writeCodexBundle(externalRoot, bridge, activationId, cliPrefix);
    if (host === "cursor") targets.cursor = await writeCursorBundle(externalRoot, bridge, activationId, cliPrefix);
    if (host === "kimi") targets.kimi = await writeKimiBundle(externalRoot, bridge, activationId, cliPrefix);
  }
  const reportPath = path.join(externalRoot, "install-report.json");
  const previous = await readJson(reportPath, null);
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

/** 显式合并 Cursor 用户级 Hook；先备份，只替换 WildArrange 自己的条目。 */
export async function activateExternalCursorAdapter(projectRoot, workspace, options = {}) {
  assertExternalWorkspace(workspace);
  const externalRoot = resolveWildArrangePath(workspace.projectRoot, "adapters", "external");
  const reportPath = path.join(externalRoot, "install-report.json");
  const report = await readJson(reportPath, null);
  const cursor = report?.targets?.cursor;
  if (!cursor) throw new Error("external Cursor adapter bundle is missing; run adapter install --target cursor first");
  const userRoot = path.resolve(options.userRoot || os.homedir());
  const cursorRoot = path.join(userRoot, ".cursor");
  const hooksPath = path.join(cursorRoot, "hooks.json");
  const bridgePath = path.join(cursorRoot, "hooks", EXTERNAL_CURSOR_BRIDGE_NAME);
  const sourceBridge = path.resolve(cursor.bridgePath);
  if (!existsSync(sourceBridge)) throw new Error(`external Cursor bridge is missing: ${sourceBridge}`);
  const existing = await readJson(hooksPath, { version: 1, hooks: {} });
  if (!existing || typeof existing !== "object" || Array.isArray(existing)
    || (existing.version !== undefined && existing.version !== 1)
    || (existing.hooks !== undefined && (typeof existing.hooks !== "object" || Array.isArray(existing.hooks)))) {
    throw new Error("existing Cursor user hooks.json is invalid; no files were changed");
  }
  const backupId = `activate-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let backupPath = null;
  if (existsSync(hooksPath)) {
    backupPath = path.join(externalRoot, "backups", backupId, "cursor-hooks.json");
    await mkdir(path.dirname(backupPath), { recursive: true });
    await copyFile(hooksPath, backupPath);
  }
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
  await writeJsonAtomic(hooksPath, { ...existing, version: 1, hooks });
  cursor.configuredAt = nowIso();
  cursor.userHooksPath = hooksPath;
  cursor.userBridgePath = bridgePath;
  cursor.backupPath = backupPath;
  await writeJsonAtomic(reportPath, report);
  return {
    kind: "wildarrange_external_cursor_activation",
    status: "configured_waiting_for_lifecycle_receipt",
    activationId: cursor.activationId,
    hooksPath,
    bridgePath,
    backupPath,
    projectFilesWritten: [],
  };
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
        matcher: "^(Bash|apply_patch|functions\\.apply_patch|write|Write|edit|Edit|multi_edit|multiedit|MultiEdit)$",
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

function renderExternalHookBridge({ host, mode, packageName, localCliPath, activationId }) {
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
  return `#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { spawn } from "node:child_process";
const HOST = ${JSON.stringify(host)};
const ACTIVATION_ID = ${JSON.stringify(activationId)};
const CLI = ${JSON.stringify(cliSpec)};
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
const shell = HOST === "cursor" && payload.hook_event_name === "beforeShellExecution";
const normalized = {
  ...payload,
  hook_event_name: event,
  cwd: projectDir,
  session_id: payload.session_id || payload.conversation_id,
  prompt: payload.prompt || payload.user_prompt,
  tool_name: shell || payload.tool_name === "Shell" ? "Bash" : payload.tool_name,
  tool_input: shell ? { command: payload.command } : payload.tool_input,
};
const invocation = CLI.kind === "local"
  ? { command: process.execPath, args: [CLI.cliPath] }
  : { command: process.platform === "win32" ? "npx.cmd" : "npx", args: ["-y", CLI.packageName] };
const child = spawn(invocation.command, [
  ...invocation.args,
  "hook", "run", "--format", "json",
  "--adapter-mode", CLI.kind,
  "--adapter-package", CLI.packageName,
  "--project-root", projectDir,
  "--external-only",
  "--host", HOST,
  "--adapter-digest", ACTIVATION_ID,
], { cwd: projectDir, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let stdout = ""; let stderr = "";
child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdin.end(JSON.stringify(normalized));
const exitCode = await new Promise((resolve) => child.on("close", (code) => resolve(code ?? 1)));
if (exitCode !== 0) fail(stderr.trim() || "WildArrange exited with code " + exitCode);
let result;
try { result = JSON.parse(stdout); } catch { fail("WildArrange returned invalid hook JSON"); }
if (result.inactive === true) process.exit(0);
if (HOST === "cursor") {
  if (event === "PreToolUse") {
    if (result.decision === "allow") emit({ permission: "allow", ...(result.output ? { additional_context: result.output } : {}) });
    else emit({ permission: "deny", user_message: "WildArrange 已阻断本次操作。", agent_message: result.output || "WildArrange denied this operation." });
  } else if ((event === "Stop" || event === "SubagentStop") && result.continuation?.required === true) {
    emit({ followup_message: result.continuation.nextCommand || result.continuation.reason || "WildArrange requires continuation." });
  } else if (result.output && event !== "UserPromptSubmit") emit({ additional_context: result.output });
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
function fail(message) {
  if (message) console.error(message);
  if (HOST === "cursor" && event === "PreToolUse") {
    emit({ permission: "deny", user_message: "WildArrange 外置治理 Hook 故障，已阻断写操作。", agent_message: "Run wildarrange doctor before retrying." });
    process.exit(0);
  }
  process.exit(1);
}
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
