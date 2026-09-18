// =============================================================================
// 文件名称：kimi-adapter.mjs
// 所属模块：interface
// 作用说明：
//   生成 Kimi Code 插件 manifest、hook bridge 与安装说明。
//   Kimi 侧 Hooks 为 fail-open，bridge 仅在 cwd 含治理标记时转发事件。
//
// 【运行原理速读】
//   可以把它想成「Kimi 插件包的内容工厂」：
//
//   · 谁调用？
//     adapters.mjs 写入 .wildarrange/adapters/kimi/plugin/，用户再 /plugins install。
//
//   · 它做了什么？
//     ① buildKimiPluginManifest 声明 SessionStart/PreToolUse 等 hook
//     ② bridge 解析 stdin → wildarrange hook run → 原样或 Stop 时 deny 续跑。
//
//   · 和其他宿主差异？
//     无自毁定时器（Kimi 合同 fail-open）；Stop 用 permissionDecision deny 触发续跑。
// =============================================================================
import path from "node:path";
import { renderHookBridgeExecution, renderHookBridgeUtilities } from "./hook-bridge-core.mjs";

/** Kimi 插件在 kimi.plugin.json 中的 name。 */
export const KIMI_ADAPTER_PLUGIN_NAME = "wildarrange-adapter";

/** 插件 manifest 版本号。 */
export const KIMI_ADAPTER_VERSION = "1.0.0";

const KIMI_WRITE_TOOL_MATCHER = "^(Bash|Write|Edit)$";

/**
 * 构建 Kimi Code 插件 manifest（hooks 列表与 interface 展示元数据）。
 * @returns {object}
 */
export function buildKimiPluginManifest() {
  const bridgeCommand = "node ./hooks/wildarrange-hook-bridge.mjs";
  const hook = (event, matcher) => ({
    event,
    ...(matcher ? { matcher } : {}),
    command: bridgeCommand,
    timeout: 10,
  });
  return {
    name: KIMI_ADAPTER_PLUGIN_NAME,
    version: KIMI_ADAPTER_VERSION,
    description: "WildArrange lifecycle governance bridge for Kimi Code",
    interface: {
      displayName: "WildArrange Adapter",
      shortDescription: "Connect Kimi Code lifecycle hooks to WildArrange governance.",
      developerName: "AliveWaveLab",
    },
    hooks: [
      hook("SessionStart", "^(startup|resume)$"),
      hook("UserPromptSubmit"),
      hook("PreToolUse", KIMI_WRITE_TOOL_MATCHER),
      hook("PostToolUse"),
      hook("PostToolUseFailure"),
      hook("PostCompact", "^(manual|auto)$"),
      hook("Stop"),
      hook("SubagentStop"),
    ],
  };
}

/**
 * 生成 Kimi hook bridge 脚本源码。
 * @param {{ mode: string, packageName: string, localCliPath: string, controlRoot: string }} options
 * @returns {string}
 */
export function renderKimiHookBridge({ mode, packageName, localCliPath, controlRoot }) {
  const cliSpec = mode === "npx"
    ? { kind: "npx", packageName }
    : { kind: "local", cliPath: path.resolve(localCliPath), packageName };
  return `#!/usr/bin/env node
import { existsSync, realpathSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const cliSpec = ${JSON.stringify(cliSpec)};
let input = "";
for await (const chunk of process.stdin) input += chunk;

let payload;
try {
  payload = JSON.parse(input);
} catch {
  console.error("WildArrange Kimi bridge received malformed hook JSON.");
  process.exit(1);
}

const projectDir = resolveWildArrangeProject(payload.cwd);
if (!projectDir) process.exit(0);
const normalizedPayload = { ...payload, cwd: projectDir };

// Kimi 宿主合同是 fail-open：这里不增加自毁定时器；宿主 timeout 后放行。
${renderHookBridgeExecution({ hostAdapter: "kimi", controlRoot, timeoutMs: null })}

if (payload.hook_event_name === "Stop" && result.continuation?.required === true) {
  const reason = [
    "WildArrange requires this task to continue.",
    result.continuation.reason || "",
    result.continuation.nextCommand ? \`Next command: \${result.continuation.nextCommand}\` : "",
  ].filter(Boolean).join(" ");
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  }) + "\\n");
  process.exit(0);
}

if (typeof result.output === "string") process.stdout.write(result.output);

/** Kimi hook 失败出口：写 stderr 并以指定码退出。 */
function failHook(message, exitCode = 1) {
  if (message) console.error(message);
  process.exit(exitCode);
}
${renderHookBridgeUtilities()}
`;
}

/**
 * 生成 Kimi adapter 安装与 enforcement 说明（Markdown）。
 * @returns {string}
 */
export function renderKimiAdapterReadme() {
  return `# WildArrange Kimi Code Adapter

Kimi Code already reads the project \`AGENTS.md\` and generated \`.agents/skills/wildarrange-*/SKILL.md\` files.
This plugin adds lifecycle Hook forwarding without modifying the user's global \`~/.kimi-code/config.toml\`.

## Install

Start Kimi Code from the project root, then run:

\`\`\`text
/plugins install .wildarrange/adapters/kimi/plugin
/reload
\`\`\`

Then run \`/wildarrange-doctor\` to verify the WildArrange runtime.
Kimi Code 0.27 treats quote characters in \`/plugins install\` as literal path characters, so do not wrap the path in quotes.

## Enforcement

- A healthy \`PreToolUse\` Hook can deny out-of-scope \`Write\`, \`Edit\`, and \`Bash\` calls.
- Kimi Hooks are fail-open when a Hook crashes or times out. Final completion still requires the WildArrange verifier, scope, review, success criteria, acceptance proof, and checkpoint gates.
- The installed plugin is user-scoped, but its bridge exits without side effects unless the event working directory contains a WildArrange runtime marker.

## Uninstall

Run \`/plugins remove ${KIMI_ADAPTER_PLUGIN_NAME}\` in Kimi Code, then:

\`\`\`bash
node ./bin/wildarrange.mjs adapter uninstall --target kimi
\`\`\`
`;
}
