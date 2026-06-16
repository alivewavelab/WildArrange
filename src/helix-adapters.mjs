import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PROJECT_DIR,
  DEFAULT_PACKAGE_NAME,
  PRODUCT_NAME,
  STATE_VERSION,
  appendLedger,
  ensureHelixDirs,
  initRuntime,
  nowIso,
  resolveHelixPath,
  writeJsonAtomic,
} from "./helix-foundation.mjs";

export async function installAdapter(rootDir, options = {}) {
  await initRuntime(rootDir);
  const target = options.target || "all";
  const mode = options.mode || "local";
  const packageName = options.packageName || options.package || DEFAULT_PACKAGE_NAME;
  const hookCommand = adapterHookCommand({ mode, packageName });
  const outputs = [];
  const backupId = createAdapterBackupId("install");

  if (target === "all" || target === "codex") {
    const codexHooks = buildCodexHooksConfig(hookCommand);
    const codexRuntimePath = path.join(rootDir, ".codex", "hooks.json");
    const codexRuntimeBackup = await backupExistingAdapterFile(rootDir, codexRuntimePath, backupId);
    await writeJsonAtomic(codexRuntimePath, codexHooks);
    outputs.push({
      target: "codex",
      path: path.relative(rootDir, codexRuntimePath),
      status: "generated",
      backup: codexRuntimeBackup,
      enforcement: "hard-after-trust",
      trustAction: "在 Codex 中执行 /hooks，review 并 trust 本项目 hook。",
    });

    const codexMirrorPath = resolveHelixPath(rootDir, "adapters", "codex", "hooks.json");
    const codexMirrorBackup = await backupExistingAdapterFile(rootDir, codexMirrorPath, backupId);
    await writeJsonAtomic(codexMirrorPath, codexHooks);
    outputs.push({ target: "codex", path: path.relative(rootDir, codexMirrorPath), status: "generated", backup: codexMirrorBackup, enforcement: "audit-copy" });
  }

  if (target === "all" || target === "cursor") {
    const cursorDir = path.join(rootDir, ".cursor", "rules");
    await mkdir(cursorDir, { recursive: true });
    const cursorRulePath = path.join(cursorDir, "wildarrange.mdc");
    const cursorRuleBackup = await backupExistingAdapterFile(rootDir, cursorRulePath, backupId);
    await writeFile(cursorRulePath, renderCursorRule({ hookCommand }), "utf8");
    const cursorReadmePath = resolveHelixPath(rootDir, "adapters", "cursor", "README.md");
    const cursorReadmeBackup = await backupExistingAdapterFile(rootDir, cursorReadmePath, backupId);
    await writeFile(cursorReadmePath, renderCursorAdapterReadme({ hookCommand }), "utf8");
    outputs.push({ target: "cursor", path: path.relative(rootDir, cursorRulePath), status: "generated", backup: cursorRuleBackup, enforcement: "soft" });
    outputs.push({ target: "cursor", path: path.relative(rootDir, cursorReadmePath), status: "generated", backup: cursorReadmeBackup, enforcement: "documentation" });
  }

  if (!["all", "codex", "cursor"].includes(target)) {
    throw new Error("adapter target must be all, codex, or cursor");
  }

  const report = {
    kind: "helix_adapter_install",
    version: STATE_VERSION,
    at: nowIso(),
    target,
    mode,
    packageName,
    hookCommand,
    backupId,
    outputs,
  };
  const reportJsonPath = resolveHelixPath(rootDir, "adapters", "install-report.json");
  const reportMdPath = resolveHelixPath(rootDir, "adapters", "install-report.md");
  report.reportJsonPath = path.relative(rootDir, reportJsonPath);
  report.reportMdPath = path.relative(rootDir, reportMdPath);
  await writeJsonAtomic(reportJsonPath, report);
  await writeFile(reportMdPath, renderAdapterInstallReport(report), "utf8");
  await appendLedger(rootDir, { type: "adapter_installed", target, mode, packageName, outputCount: outputs.length });
  return report;
}

export async function uninstallAdapter(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const target = options.target || "all";
  if (!["all", "codex", "cursor"].includes(target)) {
    throw new Error("adapter target must be all, codex, or cursor");
  }

  const backupId = createAdapterBackupId("uninstall");
  const outputs = [];
  const candidates = [];
  if (target === "all" || target === "codex") {
    candidates.push({ target: "codex", path: path.join(rootDir, ".codex", "hooks.json") });
    candidates.push({ target: "codex", path: resolveHelixPath(rootDir, "adapters", "codex", "hooks.json") });
  }
  if (target === "all" || target === "cursor") {
    candidates.push({ target: "cursor", path: path.join(rootDir, ".cursor", "rules", "wildarrange.mdc") });
    candidates.push({ target: "cursor", path: path.join(rootDir, ".cursor", "rules", ["helix", "flow.mdc"].join("")) });
    candidates.push({ target: "cursor", path: resolveHelixPath(rootDir, "adapters", "cursor", "README.md") });
  }

  for (const candidate of candidates) {
    const relativePath = path.relative(rootDir, candidate.path);
    if (!existsSync(candidate.path)) {
      outputs.push({ target: candidate.target, path: relativePath, status: "missing" });
      continue;
    }
    const backup = await backupExistingAdapterFile(rootDir, candidate.path, backupId);
    await unlink(candidate.path);
    outputs.push({ target: candidate.target, path: relativePath, status: "removed", backup });
  }

  const report = {
    kind: "helix_adapter_uninstall",
    version: STATE_VERSION,
    at: nowIso(),
    target,
    backupId,
    outputs,
  };
  const reportJsonPath = resolveHelixPath(rootDir, "adapters", "uninstall-report.json");
  const reportMdPath = resolveHelixPath(rootDir, "adapters", "uninstall-report.md");
  report.reportJsonPath = path.relative(rootDir, reportJsonPath);
  report.reportMdPath = path.relative(rootDir, reportMdPath);
  await writeJsonAtomic(reportJsonPath, report);
  await writeFile(reportMdPath, renderAdapterUninstallReport(report), "utf8");
  await appendLedger(rootDir, { type: "adapter_uninstalled", target, outputCount: outputs.length });
  return report;
}

export async function restoreAdapterBackup(rootDir, options = {}) {
  await ensureHelixDirs(rootDir);
  const backupId = options.backupId || options.backup;
  if (!backupId || typeof backupId !== "string") {
    throw new Error("adapter restore requires --backup <backupId>");
  }
  if (backupId.includes("..") || path.isAbsolute(backupId)) {
    throw new Error("adapter backup id must be a local backup directory name");
  }
  const backupRoot = resolveHelixPath(rootDir, "adapters", "backups", backupId);
  if (!existsSync(backupRoot)) {
    throw new Error(`adapter backup not found: ${path.relative(rootDir, backupRoot)}`);
  }

  const files = await listBackupFiles(backupRoot);
  const outputs = [];
  for (const relativePath of files) {
    const sourcePath = path.join(backupRoot, relativePath);
    const targetPath = path.join(rootDir, relativePath);
    assertInsideRoot(rootDir, targetPath, relativePath);
    const backup = await backupExistingAdapterFile(rootDir, targetPath, createAdapterBackupId("pre-restore"));
    await mkdir(path.dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    outputs.push({
      path: normalizeRelativePath(relativePath),
      status: "restored",
      backup,
    });
  }

  const report = {
    kind: "helix_adapter_restore",
    version: STATE_VERSION,
    at: nowIso(),
    backupId,
    outputs,
  };
  const reportJsonPath = resolveHelixPath(rootDir, "adapters", "restore-report.json");
  const reportMdPath = resolveHelixPath(rootDir, "adapters", "restore-report.md");
  report.reportJsonPath = path.relative(rootDir, reportJsonPath);
  report.reportMdPath = path.relative(rootDir, reportMdPath);
  await writeJsonAtomic(reportJsonPath, report);
  await writeFile(reportMdPath, renderAdapterRestoreReport(report), "utf8");
  await appendLedger(rootDir, { type: "adapter_restored", backupId, outputCount: outputs.length });
  return report;
}

function createAdapterBackupId(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function backupExistingAdapterFile(rootDir, filePath, backupId) {
  if (!existsSync(filePath)) return null;
  const relativePath = path.relative(rootDir, filePath);
  const backupPath = resolveHelixPath(rootDir, "adapters", "backups", backupId, relativePath);
  await mkdir(path.dirname(backupPath), { recursive: true });
  await copyFile(filePath, backupPath);
  return path.relative(rootDir, backupPath);
}

function adapterHookCommand({ mode, packageName }) {
  if (mode === "npx") return `npx -y ${packageName} hook run`;
  if (mode !== "local") throw new Error("adapter mode must be local or npx");
  return `node "${path.join(PROJECT_DIR, "bin", "helix.mjs")}" hook run`;
}

function buildCodexHooksConfig(command) {
  const hook = (timeout, statusMessage) => ({ type: "command", command, timeout, statusMessage });
  const writeToolMatcher = "^(Bash|apply_patch|functions\\.apply_patch|write|Write|edit|Edit|multi_edit|multiedit|MultiEdit)$";
  return {
    hooks: {
      SessionStart: [{ hooks: [hook(10, `${PRODUCT_NAME}: Loading governance context`)] }],
      UserPromptSubmit: [{ hooks: [hook(10, `${PRODUCT_NAME}: Routing and loading governance context`)] }],
      PreToolUse: [{
        matcher: "^(Bash|apply_patch|functions\\.apply_patch|write|Write|edit|Edit|multi_edit|multiedit|MultiEdit|create_goal|functions\\.create_goal)$",
        hooks: [hook(10, `${PRODUCT_NAME}: Checking planned scope before tool use`)],
      }],
      PostToolUse: [{
        matcher: writeToolMatcher,
        hooks: [hook(10, `${PRODUCT_NAME}: Matching project rules after tool use`)],
      }],
      PostCompact: [{
        matcher: "manual|auto",
        hooks: [hook(10, `${PRODUCT_NAME}: Rehydrating governance context after compaction`)],
      }],
      Stop: [{ hooks: [hook(10, `${PRODUCT_NAME}: Checking continuation state`)] }],
      SubagentStop: [{ hooks: [hook(10, `${PRODUCT_NAME}: Checking continuation state`)] }],
    },
  };
}

function renderCursorRule({ hookCommand }) {
  return `---
alwaysApply: true
---
# ${PRODUCT_NAME} Governance Runtime

This project uses ${PRODUCT_NAME} for local agent governance.

Required behavior:

- Before planning or implementing, run \`${hookCommand}\` with a \`UserPromptSubmit\` payload when available.
- Before editing files for a ${PRODUCT_NAME} task, verify task scope with \`node ./bin/helix.mjs guard scope --task <taskId>\` or \`node ./bin/helix.mjs hook run\` using a \`PreToolUse\` payload.
- Treat worker completion as a claim only. Completion requires verifier, scope guard, review gate, success criteria evidence, and checkpoint.
- Do not weaken \`verify_commands\`, \`review_commands\`, \`standards_commands\`, project rules, or \`successCriteria\` to manufacture PASS.
- If Cursor cannot execute lifecycle hooks automatically, run \`node ./bin/helix.mjs continuation check\` before stopping a task.
`;
}

function renderCursorAdapterReadme({ hookCommand }) {
  return `# ${PRODUCT_NAME} Cursor Adapter

Cursor does not provide the same Codex plugin hook lifecycle in this runtime, so this adapter installs a persistent Cursor rule at \`.cursor/rules/wildarrange.mdc\`.

Hook command for manual or future adapter use:

\`\`\`bash
${hookCommand}
\`\`\`

This gives Cursor the same governance contract, but hard blocking depends on Cursor exposing a lifecycle hook API. Codex can use the generated hooks JSON under \`.helix/adapters/codex/hooks.json\`.
`;
}

function renderAdapterInstallReport(report) {
  const lines = [
    `# ${PRODUCT_NAME} Adapter Install Report`,
    "",
    `Generated: ${report.at}`,
    `Target: ${report.target}`,
    `Mode: ${report.mode}`,
    `Package: ${report.packageName}`,
    "",
    "## Hook Command",
    "",
    "```bash",
    report.hookCommand,
    "```",
    "",
    "## Outputs",
    "",
  ];
  for (const output of report.outputs) {
    lines.push(`- ${output.target}: ${output.path} (${output.status}${output.enforcement ? `, enforcement: ${output.enforcement}` : ""}${output.backup ? `, backup: ${output.backup}` : ""})`);
    if (output.trustAction) lines.push(`  - Trust action: ${output.trustAction}`);
  }
  lines.push("");
  lines.push("## Install Model");
  lines.push("");
  lines.push("- Codex project hooks are hard enforcement only after Codex trusts the project `.codex/` layer and the hook definition via `/hooks`.");
  lines.push("- Cursor rules are soft governance prompts unless Cursor exposes a command lifecycle hook for this project.");
  lines.push(`- Recommended user entry: \`npx ${DEFAULT_PACKAGE_NAME}@latest init\` or \`npx ${DEFAULT_PACKAGE_NAME}@latest adapter install\`.`);
  lines.push(`- Recommended persistent project setup after publish: add \`${DEFAULT_PACKAGE_NAME}\` as a devDependency so hook commands do not require network access.`);
  return `${lines.join("\n")}\n`;
}

function renderAdapterUninstallReport(report) {
  const lines = [
    `# ${PRODUCT_NAME} Adapter Uninstall Report`,
    "",
    `Generated: ${report.at}`,
    `Target: ${report.target}`,
    `Backup ID: ${report.backupId}`,
    "",
    "## Outputs",
    "",
  ];
  for (const output of report.outputs) {
    lines.push(`- ${output.target}: ${output.path} (${output.status}${output.backup ? `, backup: ${output.backup}` : ""})`);
  }
  lines.push("");
  lines.push("Removed files were copied under `.helix/adapters/backups/` before deletion when they existed.");
  return `${lines.join("\n")}\n`;
}

function renderAdapterRestoreReport(report) {
  const lines = [
    `# ${PRODUCT_NAME} Adapter Restore Report`,
    "",
    `Generated: ${report.at}`,
    `Backup ID: ${report.backupId}`,
    "",
    "## Outputs",
    "",
  ];
  for (const output of report.outputs) {
    lines.push(`- ${output.path} (${output.status}${output.backup ? `, previous file backup: ${output.backup}` : ""})`);
  }
  return `${lines.join("\n")}\n`;
}

async function listBackupFiles(rootDir, baseDir = rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listBackupFiles(absolutePath, baseDir));
      continue;
    }
    if (!entry.isFile()) continue;
    const entryStat = await stat(absolutePath);
    if (!entryStat.isFile()) continue;
    files.push(path.relative(baseDir, absolutePath));
  }
  return files.sort();
}

function assertInsideRoot(rootDir, absolutePath, displayPath) {
  const relative = path.relative(rootDir, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`adapter restore path escapes project root: ${displayPath}`);
  }
}

function normalizeRelativePath(filePath) {
  return String(filePath || "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}
