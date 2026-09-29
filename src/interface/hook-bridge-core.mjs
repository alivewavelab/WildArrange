// =============================================================================
// 文件名称：hook-bridge-core.mjs
// 所属模块：interface
// 作用说明：
//   各宿主外置 hook bridge 共享的代码生成片段：CLI 子进程执行、受治理项目判断与 CLI 调用解析。
//   输出为嵌入 bridge 脚本的字符串，非运行时模块。
//
// 【运行原理速读】
//   可以把它想成「bridge 脚本的公共模板库」：
//
//   · 谁调用？
//     external-adapters.mjs 在 renderExternalHookBridge 时拼接进生成脚本。
//
//   · 它做了什么？
//     ① renderHookBridgeExecution 生成 spawn wildarrange hook run 块（可选超时 SIGKILL）
//     ② renderGovernedProjectCheck / renderCliInvocationUtility 生成项目判断与 CLI 解析函数。
//
//   · 为什么单独抽离？
//     Cursor（fail-closed）与 Codex/Kimi（fail-open）共用同一 CLI 调用逻辑，失败策略由调用方决定。
// =============================================================================

/**
 * 生成 bridge 内调用 wildarrange hook run 并解析 JSON stdout 的代码块。
 * @param {{ hostAdapter: string, cliArgsSource: string, timeoutMs?: number|null }} options
 *   cliArgsSource 是 bridge 内求值为参数数组的 JS 表达式（传 --project-root 等）。
 * @returns {string}
 */
export function renderHookBridgeExecution({ hostAdapter, cliArgsSource, timeoutMs = null }) {
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
  failHook(stderr.trim() || \`WildArrange hook exited with code \${exitCode}.\`, exitCode);
}

let result;
try {
  result = JSON.parse(stdout);
} catch {
  failHook("WildArrange bridge received invalid hook output.");
}`;
}

/** 生成 bridge 内 resolveCliInvocation 源码：local 走当前 node + CLI 路径，npx 走包名。 */
export function renderCliInvocationUtility() {
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
export function renderGovernedProjectCheck() {
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
