import path from "node:path";
import { renderHookBridgeExecution, renderHookBridgeUtilities } from "./hook-bridge-core.mjs";

export const KIMI_ADAPTER_PLUGIN_NAME = "wildarrange-adapter";
export const KIMI_ADAPTER_VERSION = "1.0.0";

const KIMI_WRITE_TOOL_MATCHER = "^(Bash|Write|Edit)$";

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

export function renderKimiHookBridge({ mode, packageName, localCliPath }) {
  const cliSpec = mode === "npx"
    ? { kind: "npx", packageName }
    : { kind: "local", cliPath: path.resolve(localCliPath) };
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
${renderHookBridgeExecution({ hostAdapter: "kimi", timeoutMs: null })}

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

function failHook(message, exitCode = 1) {
  if (message) console.error(message);
  process.exit(exitCode);
}
${renderHookBridgeUtilities()}
`;
}

export function renderKimiAdapterReadme() {
  return `# WildArrange Kimi Code Adapter

Kimi Code already reads the project \`AGENTS.md\` and generated \`.agents/skills/helix-*/SKILL.md\` files.
This plugin adds lifecycle Hook forwarding without modifying the user's global \`~/.kimi-code/config.toml\`.

## Install

Start Kimi Code from the project root, then run:

\`\`\`text
/plugins install .helix/adapters/kimi/plugin
/reload
\`\`\`

Then run \`/helix-doctor\` to verify the WildArrange runtime.
Kimi Code 0.27 treats quote characters in \`/plugins install\` as literal path characters, so do not wrap the path in quotes.

## Enforcement

- A healthy \`PreToolUse\` Hook can deny out-of-scope \`Write\`, \`Edit\`, and \`Bash\` calls.
- Kimi Hooks are fail-open when a Hook crashes or times out. Final completion still requires the WildArrange verifier, scope, review, success criteria, acceptance proof, and checkpoint gates.
- The installed plugin is user-scoped, but its bridge exits without side effects unless the event working directory contains a WildArrange runtime marker.

## Uninstall

Run \`/plugins remove ${KIMI_ADAPTER_PLUGIN_NAME}\` in Kimi Code, then:

\`\`\`bash
node ./bin/helix.mjs adapter uninstall --target kimi
\`\`\`
`;
}
