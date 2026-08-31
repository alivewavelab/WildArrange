export function renderHookBridgeExecution({ hostAdapter, timeoutMs = null }) {
  const timeoutBlock = Number.isInteger(timeoutMs) && timeoutMs > 0
    ? `const childTimer = setTimeout(() => {
  child.kill("SIGKILL");
  failHook("WildArrange hook subprocess timed out.");
}, ${timeoutMs});`
    : "const childTimer = null;";
  return `const invocation = resolveCliInvocation(cliSpec);
const child = spawn(invocation.command, [...invocation.args, "hook", "run", "--format", "json"], {
  cwd: projectDir,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: { ...process.env, HELIX_HOST_ADAPTER: ${JSON.stringify(hostAdapter)} },
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
      path.join(current, ".helix", "config.json"),
      path.join(current, "helix.config.json"),
    ];
    if (markers.some(isRegularFile)) return current;
    if (existsSync(path.join(current, ".git"))) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function isRegularFile(filePath) {
  if (!existsSync(filePath)) return false;
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

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
