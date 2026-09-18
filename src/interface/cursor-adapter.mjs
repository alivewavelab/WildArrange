// =============================================================================
// 文件名称：cursor-adapter.mjs
// 所属模块：interface
// 作用说明：
//   生成 Cursor 宿主适配产物：hooks.json 配置、hook bridge 脚本与 README。
//   将 Cursor 生命周期事件映射为 WildArrange 规范事件并 fail-closed 阻断越界写操作。
//
// 【运行原理速读】
//   可以把它想成「Cursor 与治理运行时的翻译层」：
//
//   · 谁调用？
//     adapters.mjs 在 adapter install --target cursor 时生成 .cursor/ 下文件。
//
//   · 它做了什么？
//     ① buildCursorHooksConfig 写 hooks.json ② renderCursorHookBridge 生成 bridge
//     ③ bridge  stdin 收 JSON → 调 wildarrange hook run → stdout 回 permission/context。
//
//   · 关键约束？
//     preToolUse / beforeShellExecution fail-closed；定位不到治理项目时阻断写类操作。
// =============================================================================
import path from "node:path";
import { renderHookBridgeExecution, renderHookBridgeUtilities } from "./hook-bridge-core.mjs";

/** Cursor hooks.json 的 version 字段。 */
export const CURSOR_HOOKS_VERSION = 1;

/** 相对项目根的 hook bridge 脚本路径。 */
export const CURSOR_BRIDGE_PATH = ".cursor/hooks/wildarrange-hook-bridge.mjs";

/** 覆盖 Cursor 文档已列出的写类工具名；未知名称不会匹配，无副作用。 */
const CURSOR_WRITE_TOOL_MATCHER = "Write|Delete|Edit|StrReplace|MultiEdit|Shell";

/** Cursor 事件名（camelCase）→ WildArrange 规范事件名（PascalCase）；beforeSubmitPrompt 无注入通道，beforeShellExecution 与 preToolUse 同协议。 */
const CURSOR_EVENT_MAP = {
  sessionStart: "SessionStart",
  beforeSubmitPrompt: "UserPromptSubmit",
  preToolUse: "PreToolUse",
  beforeShellExecution: "PreToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUseFailure",
  stop: "Stop",
  subagentStop: "SubagentStop",
};

/**
 * 构建 Cursor hooks.json 内容：写类工具与终端命令走 fail-closed PreToolUse。
 * @param {{ bridgeCommand: string }} options
 * @returns {object}
 */
export function buildCursorHooksConfig({ bridgeCommand }) {
  const hook = (extra = {}) => ({ command: bridgeCommand, ...extra });
  return {
    version: CURSOR_HOOKS_VERSION,
    hooks: {
      sessionStart: [hook({ timeout: 30 })],
      beforeSubmitPrompt: [hook({ timeout: 20, matcher: "UserPromptSubmit" })],
      preToolUse: [hook({ timeout: 20, matcher: CURSOR_WRITE_TOOL_MATCHER, failClosed: true })],
      beforeShellExecution: [hook({ timeout: 20, failClosed: true })],
      postToolUse: [hook({ timeout: 15 })],
      postToolUseFailure: [hook({ timeout: 15 })],
      stop: [hook({ timeout: 15 })],
      subagentStop: [hook({ timeout: 15 })],
    },
  };
}

/**
 * 生成 Cursor hook bridge 可执行脚本源码（嵌入 CLI 调用与 Cursor 输出协议）。
 * @param {{ mode: string, packageName: string, localCliPath: string, controlRoot: string }} options
 * @returns {string}
 */
export function renderCursorHookBridge({ mode, packageName, localCliPath, controlRoot }) {
  const cliSpec = mode === "npx"
    ? { kind: "npx", packageName }
    : { kind: "local", cliPath: path.resolve(localCliPath), packageName };
  return `#!/usr/bin/env node
import { existsSync, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const cliSpec = ${JSON.stringify(cliSpec)};
const EVENT_MAP = ${JSON.stringify(CURSOR_EVENT_MAP)};
let input = "";
for await (const chunk of process.stdin) input += chunk;

let payload;
try {
  payload = JSON.parse(input);
} catch {
  // 此时无法得知事件类型，无法输出协议正确的 deny；preToolUse /
  // beforeShellExecution 在 hooks.json 配了 failClosed，宿主会阻断。
  console.error("WildArrange Cursor bridge received malformed hook JSON.");
  process.exit(1);
}

const event = EVENT_MAP[payload.hook_event_name];
if (!event) process.exit(0);

const projectDir = resolveWildArrangeProject(payload.cwd || payload.workspace_roots?.[0]);
if (!projectDir) {
  // fail-closed：定位不到治理项目时，写类事件显式阻断而不是静默放行；
  // 其余事件无写权限通道，保持静默退出。
  if (event === "PreToolUse") {
    writeCursorOutput({
      permission: "deny",
      user_message: "WildArrange 未能确认当前目录属于受治理项目，已按 fail-closed 阻断本次写操作。",
      agent_message: "WildArrange could not resolve a governed project for this working directory and denied the write fail-closed. Run the tool from the WildArrange project root or its registered task worktree.",
    });
  }
  process.exit(0);
}

const isShellExecution = payload.hook_event_name === "beforeShellExecution";
const normalizedPayload = {
  ...payload,
  hook_event_name: event,
  cwd: projectDir,
  session_id: payload.conversation_id || payload.session_id,
  // Cursor 的 Shell 工具与 beforeShellExecution 终端命令都等价于治理侧的 Bash；
  // 命令安全预检只认后者。
  tool_name: isShellExecution || payload.tool_name === "Shell" ? "Bash" : payload.tool_name,
  tool_input: isShellExecution ? { command: payload.command } : payload.tool_input,
};

// 宿主 timeout 之外的第二道保险：子进程挂死时按 fail-closed 收口。
${renderHookBridgeExecution({ hostAdapter: "cursor", controlRoot, timeoutMs: 25_000 })}

if (event === "PreToolUse") {
  if (result.decision === "allow") {
    // 放行也把判定依据回传给宿主，避免宿主对治理结论一无所知。
    const output = { permission: "allow" };
    if (typeof result.output === "string" && result.output.trim()) {
      output.additional_context = result.output;
    }
    writeCursorOutput(output);
  } else {
    // fail-closed：deny 之外的任何结论（含 null/未知值）都按阻断处理。
    const reason = result.decision === "deny"
      ? extractDenyReason(result.output)
      : "governance hook returned no explicit allow decision";
    writeCursorOutput({
      permission: "deny",
      user_message: \`WildArrange 已阻断本次操作：\${reason}\`,
      agent_message: \`WildArrange pre-tool-use guard denied this call: \${reason}. Do not retry the same target; adjust the plan or writable_paths through the governance flow.\`,
    });
  }
  process.exit(0);
}

if (event === "Stop" || event === "SubagentStop") {
  if (result.continuation?.required === true) {
    const followup = [
      "WildArrange requires this task to continue.",
      result.continuation.reason || "",
      result.continuation.nextCommand ? \`Next command: \${result.continuation.nextCommand}\` : "",
    ].filter(Boolean).join(" ");
    writeCursorOutput({ followup_message: followup });
  }
  process.exit(0);
}

// beforeSubmitPrompt 无注入通道，保持静默；SessionStart / PostToolUse* 走 additional_context。
if (typeof result.output === "string" && result.output.trim() && event !== "UserPromptSubmit") {
  writeCursorOutput({ additional_context: result.output });
}
process.exit(0);

/** 从 hook JSON 输出提取 deny 原因，解析失败时用默认文案。 */
function extractDenyReason(output) {
  if (typeof output !== "string") return "out of planned scope";
  try {
    const parsed = JSON.parse(output);
    return parsed?.hookSpecificOutput?.permissionDecisionReason || "out of planned scope";
  } catch {
    return "out of planned scope";
  }
}

/** 向 Cursor 写一行 JSON hook 响应。 */
function writeCursorOutput(value) {
  process.stdout.write(JSON.stringify(value) + "\\n");
}

/** Cursor hook 失败出口：PreToolUse 时 fail-closed 返回 deny。 */
function failHook(message) {
  console.error(message);
  if (event === "PreToolUse") {
    // fail-closed：钩子自身故障时阻断写操作，并给出可执行的下一步。
    writeCursorOutput({
      permission: "deny",
      user_message: "WildArrange 治理钩子故障，已按 fail-closed 阻断写操作。请运行 node ./bin/wildarrange.mjs doctor 诊断后重试。",
      agent_message: "The WildArrange governance hook failed and is fail-closed for write operations. Ask the developer to run node ./bin/wildarrange.mjs doctor, then retry.",
    });
    process.exit(0);
  }
  process.exit(1);
}

${renderHookBridgeUtilities()}
`;
}

/**
 * 生成 Cursor adapter 说明文档（硬 hook + 软 rules 双层 enforcement 说明）。
 * @param {{ hookCommand: string }} options
 * @returns {string}
 */
export function renderCursorAdapterReadme({ hookCommand }) {
  return `# WildArrange Cursor Adapter

This adapter installs two layers:

1. **Hard hooks** at \`.cursor/hooks.json\` + \`.cursor/hooks/wildarrange-hook-bridge.mjs\` — Cursor loads project hooks automatically in a **trusted workspace**. \`preToolUse\` (Write/Delete/Edit/Shell) and \`beforeShellExecution\` (integrated terminal commands) are fail-closed: hook failures block the action instead of allowing it through.
2. **Soft rules** at \`.cursor/rules/wildarrange.mdc\` and slash commands under \`.cursor/commands/\` as a fallback narrative layer.

Hook command used by the bridge:

\`\`\`bash
${hookCommand}
\`\`\`

## Enforcement

- \`preToolUse\` can deny out-of-scope \`Write\`/\`Delete\`/\`Edit\` and high-risk \`Shell\` calls before they happen; \`beforeShellExecution\` applies the same command-safety gate to integrated terminal commands. Denial reasons are fed back to the agent.
- \`sessionStart\` injects governance context; \`postToolUse\` records every tool result for route review and returns any applicable context via \`additional_context\`.
- \`stop\`/\`subagentStop\` auto-continue unfinished tasks via \`followup_message\` (Cursor loop limit applies, default 5).
- \`beforeSubmitPrompt\` has no context-injection channel in Cursor; it is used for routing and decision records only.
- Hooks are early interception, not the final boundary: completion still requires verifier, scope, review, success criteria, acceptance proof, and checkpoint.

## Uninstall

\`\`\`bash
node ./bin/wildarrange.mjs adapter uninstall --target cursor
\`\`\`
`;
}
