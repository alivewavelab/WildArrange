// =============================================================================
// 文件名称：hook-bridge-core.mjs
// 所属模块：interface
// 作用说明：
//   各宿主 hook bridge 共享的代码生成片段：CLI 子进程执行与项目根解析工具。
//   输出为嵌入 bridge 脚本的字符串，非运行时模块。
//
// 【运行原理速读】
//   可以把它想成「bridge 脚本的公共模板库」：
//
//   · 谁调用？
//     cursor-adapter.mjs、kimi-adapter.mjs 在 render*HookBridge 时拼接进生成脚本。
//
//   · 它做了什么？
//     ① renderHookBridgeExecution 生成 spawn wildarrange hook run 块（可选超时 SIGKILL）
//     ② renderHookBridgeUtilities 生成 resolveWildArrangeProject 等辅助函数。
//
//   · 为什么单独抽离？
//     Cursor（fail-closed + 25s 超时）与 Kimi（fail-open、无超时）共用同一 CLI 调用逻辑。
// =============================================================================
import path from "node:path";

/**
 * 生成 bridge 内调用 wildarrange hook run 并解析 JSON stdout 的代码块。
 * @param {{ hostAdapter: string, controlRoot: string, timeoutMs?: number|null }} options
 * @returns {string}
 */
export function renderHookBridgeExecution({ hostAdapter, controlRoot, timeoutMs = null }) {
  // Cursor 要求 fail-closed：子进程挂死时 SIGKILL 并走 failHook；Kimi 传 null 则不生成定时器。
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
  "--control-root", ${JSON.stringify(path.resolve(controlRoot))},
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
  failHook(stderr.trim() || \`WildArrange hook exited with code \${exitCode}.\`, exitCode);
}

let result;
try {
  result = JSON.parse(stdout);
} catch {
  failHook("WildArrange bridge received invalid hook output.");
}`;
}

/** 生成 bridge 内 resolveWildArrangeProject、resolveCliInvocation 等工具函数源码。 */
export function renderHookBridgeUtilities() {
  return `function resolveWildArrangeProject(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  let current;
  try {
    current = realpathSync(cwd);
  } catch {
    return null;
  }
  while (true) {
    const markers = [
      path.join(current, ".wildarrange", "config.json"),
      path.join(current, "wildarrange.config.json"),
    ];
    if (markers.some(isRegularFile)) return current;
    if (existsSync(path.join(current, ".git"))) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** 判断路径存在且为普通文件（非目录）。 */
function isRegularFile(filePath) {
  if (!existsSync(filePath)) return false;
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** 将 hook bridge 配置解析为可 spawn 的 CLI 命令与参数。 */
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
