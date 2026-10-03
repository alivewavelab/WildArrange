// =============================================================================
// 文件名称：adapter-bridge-template.mjs
// 所属模块：interface
// 作用说明：
//   渲染四宿主共用的 Hook bridge 脚本（字符串模板）。本文件里的函数产出
//   嵌入 bridge 的源码，不是运行时逻辑：项目发现、CLI 调用、超时与错误处理骨架
//   在此，fail-open/fail-closed 与输出协议由各宿主分支显式决定。
// =============================================================================
import path from "node:path";

/** bridge 子进程超时：须小于宿主 Hook 最短 timeout（15s），保证 bridge 先于宿主自行收尾。 */
const HOOK_TIMEOUT_MS = 14_000;

export function renderHookBridge({ host, mode, packageName, localCliPath, activationId, hookTimeoutMs = HOOK_TIMEOUT_MS }) {
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
  // 四宿主共用一个骨架：先只读 registry 判断是否受治理项目（未命中直接放行），
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
// 内置执行者（wildarrange executor）启动的模型子会话：不注入、不拦截、不续跑，避免治理流程嵌套干扰执行者。
if (process.env.WILDARRANGE_EXECUTOR_SESSION === "1") process.exit(0);
let input = "";
for await (const chunk of process.stdin) input += chunk;
let payload;
try { payload = JSON.parse(input); } catch { process.exit(1); }
const rawCwd = payload.cwd || payload.workspace_roots?.[0] || process.env.CURSOR_PROJECT_DIR || process.cwd();
let projectDir;
try { projectDir = realpathSync(rawCwd); } catch { process.exit(0); }
const hostEvent = EVENT_MAP ? EVENT_MAP[payload.hook_event_name] : payload.hook_event_name;
// Claude Code 的 PostCompact 不能注入上下文；压缩后的 SessionStart(source=compact) 承担恢复。
const event = HOST === "claude" && hostEvent === "SessionStart" && payload.source === "compact" ? "PostCompact" : hostEvent;
if (!event) process.exit(0);
// Claude Code 已因 Stop Hook 继续过一轮：放行停止，避免空转到它的连续拦截上限（官方推荐用法）。
if (HOST === "claude" && payload.stop_hook_active === true && (event === "Stop" || event === "SubagentStop")) process.exit(0);
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
    cliArgsSource: '["--project-root", projectDir, "--host", HOST, "--adapter-digest", ACTIVATION_ID]',
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
// Claude Code 只把 SessionStart/UserPromptSubmit 的纯文本 stdout 放进上下文，PostToolUse 须走 additionalContext。
if (HOST === "claude" && event === "PostToolUse") {
  if (result.output) emit({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: result.output } });
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
/** 已确认受治理后的失败出口：Cursor 写操作 fail-closed，其余宿主 fail-open。退出码固定为 1：Claude Code/Codex 把 2 视为拦截。 */
function failHook(message) {
  if (message) console.error(String(message).slice(0, 2000));
  if (HOST === "cursor" && event === "PreToolUse") {
    emit({ permission: "deny", user_message: "WildArrange 外置治理 Hook 故障，已阻断写操作。", agent_message: "Run wildarrange doctor before retrying." });
    process.exit(0);
  }
  process.exit(1);
}
${renderGovernedProjectCheck()}
${renderCliInvocationUtility()}
`;
}

// --- bridge 脚本共享片段：输出为嵌入 bridge 的字符串，非运行时代码 ---

/**
 * 生成 bridge 内调用 wildarrange hook run 并解析 JSON stdout 的代码块。
 * @param {{ hostAdapter: string, cliArgsSource: string, timeoutMs?: number|null }} options
 *   cliArgsSource 是 bridge 内求值为参数数组的 JS 表达式（传 --project-root 等）。
 * @returns {string}
 */
function renderHookBridgeExecution({ hostAdapter, cliArgsSource, timeoutMs = null }) {
  const trailingArgs = `...${cliArgsSource},`;
  // 子进程挂死时 SIGKILL 并走 failHook；timeoutMs 为 null 则不生成定时器。
  const timeoutBlock = Number.isInteger(timeoutMs) && timeoutMs > 0
    ? `const childTimer = setTimeout(() => {
  child.kill("SIGKILL");
  failHook("WildArrange hook subprocess timed out.");
}, ${timeoutMs});`
    : "const childTimer = null;";
  return `const invocation = resolveCliInvocation(cliSpec);
const child = spawn(invocation.command, [
  ...invocation.args,
  "hook", "run", "--format", "json",
  "--adapter-mode", cliSpec.kind,
  "--adapter-package", cliSpec.packageName,
  ${trailingArgs}
], {
  cwd: projectDir,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, WILDARRANGE_HOST_ADAPTER: ${JSON.stringify(hostAdapter)} },
});

${timeoutBlock}

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.on("error", (error) => failHook(error instanceof Error ? error.message : String(error)));
child.stdin.end(JSON.stringify(normalizedPayload));

const exitCode = await new Promise((resolve) => child.on("close", (code) => {
  if (childTimer) clearTimeout(childTimer);
  resolve(code ?? 1);
}));
if (exitCode !== 0) {
  failHook(stderr.trim() || \`WildArrange hook exited with code \${exitCode}.\`);
}

let result;
try {
  result = JSON.parse(stdout);
} catch {
  failHook("WildArrange bridge received invalid hook output.");
}`;
}

/** 生成 bridge 内 resolveCliInvocation 源码：local 走当前 node + CLI 路径，npx 走包名。 */
function renderCliInvocationUtility() {
  return `/** 将 hook bridge 配置解析为可 spawn 的 CLI 命令与参数。 */
function resolveCliInvocation(spec) {
  if (spec.kind === "local") {
    return { command: process.execPath, args: [spec.cliPath] };
  }
  return {
    command: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["-y", spec.packageName],
  };
}`;
}

/**
 * 生成外置 bridge 的"是否受治理项目"判断源码：只读 WILDARRANGE_STATE_HOME/registry.json，
 * 按 cwd 落在已注册项目根/运行态根内，或 Git common-dir 身份命中来判定；
 * 任何读取失败都视为未连接（放行），用户级 Hook 不得因本机状态损坏波及无关项目。
 */
function renderGovernedProjectCheck() {
  return `function defaultStateHome() {
  const env = process.env;
  if (typeof env.WILDARRANGE_STATE_HOME === "string" && env.WILDARRANGE_STATE_HOME.trim()) return path.resolve(env.WILDARRANGE_STATE_HOME);
  if (process.platform === "win32") return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "WildArrange");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "WildArrange");
  return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "wildarrange");
}

function comparable(value) {
  let resolved = path.resolve(value);
  try { resolved = realpathSync.native(resolved); } catch { /* 路径不存在时按原样比较 */ }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root, candidate) {
  const base = comparable(root);
  const target = comparable(candidate);
  return target === base || target.startsWith(base + path.sep);
}

/** 只读 registry 判断 dir 是否属于已连接的外置治理项目。 */
function isGovernedProject(dir) {
  let registry;
  try { registry = JSON.parse(readFileSync(path.join(defaultStateHome(), "registry.json"), "utf8")); } catch { return false; }
  const entries = registry && typeof registry.projects === "object" && registry.projects ? registry.projects : {};
  const list = Object.entries(entries);
  if (list.length === 0) return false;
  for (const [, entry] of list) {
    if (typeof entry?.projectRoot === "string" && isInside(entry.projectRoot, dir)) return true;
    if (typeof entry?.runtimeRoot === "string" && isInside(entry.runtimeRoot, dir)) return true;
  }
  const git = spawnSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 5000, windowsHide: true });
  if (git.status !== 0 || !git.stdout.trim()) return false;
  const raw = git.stdout.trim();
  const commonDir = comparable(path.isAbsolute(raw) ? raw : path.resolve(dir, raw));
  const id = "project_" + createHash("sha256").update(commonDir).digest("hex").slice(0, 24);
  return Object.prototype.hasOwnProperty.call(entries, id);
}`;
}
