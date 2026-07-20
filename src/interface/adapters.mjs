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

const SLASH_COMMAND_PREFIX = "helix";

export async function installAdapter(rootDir, options = {}) {
  await initRuntime(rootDir);
  const target = options.target || "all";
  const mode = options.mode || "local";
  const packageName = options.packageName || options.package || DEFAULT_PACKAGE_NAME;
  const hookCommand = adapterHookCommand({ mode, packageName });
  const cliPrefix = adapterCliPrefix({ mode, packageName });
  const slashCommands = buildSlashCommands(cliPrefix);
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

    for (const command of slashCommands) {
      const skillPath = path.join(rootDir, ".agents", "skills", command.name, "SKILL.md");
      await mkdir(path.dirname(skillPath), { recursive: true });
      const skillBackup = await backupExistingAdapterFile(rootDir, skillPath, backupId);
      await writeFile(skillPath, renderCodexSkill(command), "utf8");
      outputs.push({ target: "codex", path: path.relative(rootDir, skillPath), status: "generated", backup: skillBackup, enforcement: "slash-command" });
    }
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

    const cursorCommandsDir = path.join(rootDir, ".cursor", "commands");
    await mkdir(cursorCommandsDir, { recursive: true });
    for (const command of slashCommands) {
      const commandPath = path.join(cursorCommandsDir, `${command.name}.md`);
      const commandBackup = await backupExistingAdapterFile(rootDir, commandPath, backupId);
      await writeFile(commandPath, renderCursorCommand(command), "utf8");
      outputs.push({ target: "cursor", path: path.relative(rootDir, commandPath), status: "generated", backup: commandBackup, enforcement: "slash-command" });
    }
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
  const slashCommands = buildSlashCommands("");
  const outputs = [];
  const candidates = [];
  if (target === "all" || target === "codex") {
    candidates.push({ target: "codex", path: path.join(rootDir, ".codex", "hooks.json") });
    candidates.push({ target: "codex", path: resolveHelixPath(rootDir, "adapters", "codex", "hooks.json") });
    for (const command of slashCommands) {
      candidates.push({ target: "codex", path: path.join(rootDir, ".agents", "skills", command.name, "SKILL.md") });
    }
  }
  if (target === "all" || target === "cursor") {
    candidates.push({ target: "cursor", path: path.join(rootDir, ".cursor", "rules", "wildarrange.mdc") });
    candidates.push({ target: "cursor", path: path.join(rootDir, ".cursor", "rules", ["helix", "flow.mdc"].join("")) });
    candidates.push({ target: "cursor", path: resolveHelixPath(rootDir, "adapters", "cursor", "README.md") });
    for (const command of slashCommands) {
      candidates.push({ target: "cursor", path: path.join(rootDir, ".cursor", "commands", `${command.name}.md`) });
    }
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

function adapterCliPrefix({ mode, packageName }) {
  if (mode === "npx") return `npx -y ${packageName}`;
  if (mode !== "local") throw new Error("adapter mode must be local or npx");
  return `node "${path.join(PROJECT_DIR, "bin", "helix.mjs")}"`;
}

function adapterHookCommand({ mode, packageName }) {
  return `${adapterCliPrefix({ mode, packageName })} hook run`;
}

// 统一的 slash 命令集：Cursor 渲染成 .cursor/commands/<name>.md，
// Codex 渲染成 .agents/skills/<name>/SKILL.md。两者本质都是"让 AI 代你执行 CLI"的提示词。
function buildSlashCommands(cliPrefix) {
  const fence = (lines) => ["```bash", ...lines, "```"].join("\n");
  return [
    {
      name: `${SLASH_COMMAND_PREFIX}-config`,
      title: `${PRODUCT_NAME} 配置表`,
      description: "生成并引导填写根配置文件 helix.config.json（agents / providers / injectionPoints / qualityGates 等），填完用 config verify 校验。",
      body: [
        `目标：为开发者生成并逐块引导填写根配置文件 \`helix.config.json\`。`,
        "",
        "步骤：",
        `1. 执行下面的命令生成/更新根配置（已存在不会被覆盖，除非加 \`--force\`）：`,
        "",
        fence([`${cliPrefix} config init --root`]),
        "",
        "2. 打开 `helix.config.json`，按下列检查项逐块引导用户填写，每块用一句话说明作用：",
        "   - `agents`：各角色用哪个 provider / model / reasoning。",
        "   - `modelProviders`：`host` 交给宿主；外部模型走 OpenAI 兼容配置，`apiKeyEnv` 填环境变量名而不是密钥本身。",
        "   - `injectionPoints`：每个注入点挂哪些 `tools` / `markdown` / `skills` / `rules`。",
        "   - `contextBudgets`：Prompt / Markdown / Skill 的字符预算。",
        "   - `skillMatcher.dynamicInjection`：技能按需挂载的 `enabled` / `maxSkills` / `alwaysMount`。",
        "   - `qualityGates`：`lspDiagnostics` / `astStructure` / `hashlineAnchors` / `commentChecker`。",
        "   - `review.llm`：是否启用 LLM 复核；`required=false` 时无 key 只告警不阻断。",
        "",
        "3. 填写完成后执行校验，并提示可用 `/helix-doctor` 做整体体检：",
        "",
        fence([`${cliPrefix} config verify`]),
        "",
        "不要建议删除或清空 `verify_commands` / `review_commands` / `successCriteria` 来让校验通过。",
      ].join("\n"),
    },
    {
      name: `${SLASH_COMMAND_PREFIX}-doctor`,
      title: `${PRODUCT_NAME} 一键体检`,
      description: "依次运行 doctor / config verify / ledger verify / state verify，汇总运行时健康状况与整改建议。",
      body: [
        "在项目根目录依次执行下列命令，然后用中文汇总每一步的结论（通过 / 告警 / 失败），并对失败项给出下一步建议：",
        "",
        fence([
          `${cliPrefix} doctor`,
          `${cliPrefix} config verify`,
          `${cliPrefix} ledger verify`,
          `${cliPrefix} state verify`,
        ]),
        "",
        "要求：不要跳过任何一条命令。如果 doctor 报出未完成任务对账失败、账本 hash 链断裂或配置基线不符，明确指出是哪一项，并说明是否需要 `state restore` 或人工介入。不得为了让结果好看而修改或删除校验命令本身。",
      ].join("\n"),
    },
    {
      name: `${SLASH_COMMAND_PREFIX}-refresh`,
      title: `${PRODUCT_NAME} 刷新运行时`,
      description: "新增或修改 prompt / skill / 注入点配置后，刷新运行时并确认注册结果（幂等，不清空任务与账本）。",
      body: [
        "当你新增或修改了 prompt / skill / 注入点配置后，执行下列命令刷新运行时（幂等，不会清空任务或账本）：",
        "",
        fence([`${cliPrefix} init`]),
        "",
        "然后确认新的 skill 是否已登记，并用中文汇报当前已注册的 agent 与 skill 数量：",
        "",
        fence([`${cliPrefix} prompts list`]),
        "",
        "若某个 skill 没出现，检查它是否已在 prompt 包的 `manifest.json` 中登记。",
      ].join("\n"),
    },
    {
      name: `${SLASH_COMMAND_PREFIX}-status`,
      title: `${PRODUCT_NAME} 状态`,
      description: "查看当前工作流进度、下一步动作、失败任务与待处理事项。",
      body: [
        "执行下列命令并用中文汇总当前进度、下一步动作、失败任务与待处理事项：",
        "",
        fence([
          `${cliPrefix} status`,
          `${cliPrefix} summary`,
        ]),
      ].join("\n"),
    },
    {
      name: `${SLASH_COMMAND_PREFIX}-plan`,
      title: `${PRODUCT_NAME} 导入计划`,
      description: "导入并校验一个计划文件（plan.json），报告任务数、质量门与字段完整性。",
      body: [
        "把用户提供的计划文件路径（本命令后面的文本，例如 `/helix-plan plan.json`）导入并校验：",
        "",
        fence([`${cliPrefix} plan --from <计划文件路径>`]),
        "",
        "如果用户没有给出路径，先询问计划文件路径。导入后用中文说明校验结果：任务数、是否命中高风险产品计划质量门、每个任务的 `writable_paths` 与 `verify_commands` 是否齐全。若校验失败，指出缺哪一项。",
      ].join("\n"),
    },
    {
      name: `${SLASH_COMMAND_PREFIX}-approve`,
      title: `${PRODUCT_NAME} 确认计划`,
      description: "向开发者展示已导入计划摘要，得到明确确认后放行执行（planApproval.required 时的人工确认门）。",
      body: [
        "当 `planApproval.required` 打开时，导入的计划要先经开发者确认才能 `run`。请这样做：",
        "",
        "1. 先展示当前计划摘要（任务数、每个任务的目标与 writable_paths）：",
        "",
        fence([`${cliPrefix} status`]),
        "",
        "2. **用中文向开发者复述计划要点，并明确询问：是否确认按此计划执行？** 给出\"确认 / 需要修改\"两个选项，不要替开发者做决定。",
        "3. 只有开发者明确回复\"确认\"后，才执行放行命令：",
        "",
        fence([`${cliPrefix} plan approve`]),
        "",
        "4. 若开发者要修改，不要 approve；协助修订 `plan.json` 后重新 `/helix-plan` 导入。",
      ].join("\n"),
    },
    {
      name: `${SLASH_COMMAND_PREFIX}-run`,
      title: `${PRODUCT_NAME} 跑下一个任务`,
      description: "运行下一个可运行任务，自动走 worker→verify→scope→review→验收证明→checkpoint 全部门禁。",
      body: [
        "执行下列命令跑下一个可运行任务（会自动走 worker → verify → scope → review → 验收证明 → checkpoint 全部门禁）：",
        "",
        fence([`${cliPrefix} run`]),
        "",
        "用中文汇报结果：worker 是否退出 0、verifier 是否通过、范围守卫与复核门结论、任务最终状态。注意 worker 退出 0 只是\"声称完成\"，最终以 gate 结论为准。若失败，说明卡在哪个 gate 以及重试建议。",
      ].join("\n"),
    },
  ];
}

function renderCursorCommand(command) {
  return `# ${command.title}\n\n> ${command.description}\n\n${command.body}\n`;
}

function renderCodexSkill(command) {
  return `---\nname: ${command.name}\ndescription: ${command.description}\n---\n\n# ${command.title}\n\n${command.body}\n`;
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
- At the start and end of each turn, check pending human decisions (run the hook above, or \`node ./bin/helix.mjs status\`) and proactively surface them to the developer in chat with clear options — plans awaiting approval, out-of-scope ChangeRequests, failed tasks, child agents awaiting acceptance. Do not decide on the developer's behalf, and do not make the developer dig through the terminal to find them.
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
