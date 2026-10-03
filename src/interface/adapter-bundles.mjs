// =============================================================================
// 文件名称：adapter-bundles.mjs
// 所属模块：interface
// 作用说明：
//   生成 Codex / Cursor / Kimi / Claude Code 四宿主的外置插件包文件（manifest、Hook 配置、
//   slash 命令 Skill）。只写 runtimeRoot 下的生成物，不写客户项目，
//   也不做激活；bridge 脚本内容由调用方（adapters.mjs）传入。
// =============================================================================
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PRODUCT_NAME } from "../infra/runtime-config.mjs";
import { writeJsonAtomic } from "../infra/runtime-store.mjs";

export const CODEX_PLUGIN_NAME = "wildarrange-governance";
export const KIMI_PLUGIN_NAME = "wildarrange-governance";
export const CLAUDE_PLUGIN_NAME = "wildarrange-governance";
export const CLAUDE_MARKETPLACE_NAME = "wildarrange-local";
export const CURSOR_BRIDGE_NAME = "wildarrange-external-hook-bridge.mjs";

/** 外置插件包内 slash 命令 Skill 的名称前缀。 */
const SLASH_COMMAND_PREFIX = "wildarrange";


/**
 * 统一的 slash 命令集：渲染成外置插件包内的 skills/<name>/SKILL.md。
 * @param {string} cliPrefix 已解析的 wildarrange CLI 调用前缀
 * @returns {Array<{ name: string, title: string, description: string, body: string }>}
 */
export function buildSlashCommands(cliPrefix) {
  const fence = (lines) => ["```bash", ...lines, "```"].join("\n");
  return [
    ...[{ suffix: "setup", skill: "configure-project-review", title: "项目审查与执行配置" },
      { suffix: "onboard", skill: "project-onboarding", title: "旧项目治理接管" },
      { suffix: "architecture", skill: "review-architecture-design", title: "架构设计审查与确认" }].map(entry => ({
      name: SLASH_COMMAND_PREFIX + "-" + entry.suffix, title: entry.title, description: entry.title,
      body: "先运行 " + cliPrefix + " prompts show --skill " + entry.skill + " 读取完整 Skill，再遵循其预览、批准和验收步骤。不能只凭名称执行，不能假定项目拥有工具源码。",
    })),
    {
      name: `${SLASH_COMMAND_PREFIX}-config`,
      title: `${PRODUCT_NAME} 配置表`,
      description: "生成并引导填写治理仓 policy/wildarrange.config.json（agents / providers / injectionPoints / qualityGates 等），填完用 config verify 校验。",
      body: [
        `目标：为开发者生成并逐块引导填写治理仓的 \`policy/wildarrange.config.json\`（唯一配置文件，改动需在治理仓提交）。`,
        "",
        "步骤：",
        `1. 执行下面的命令生成/更新根配置（已存在不会被覆盖，除非加 \`--force\`）：`,
        "",
        fence([`${cliPrefix} config init`]),
        "",
        "2. 打开治理仓 `policy/wildarrange.config.json`（`config show` 可查看生效配置），按下列检查项逐块引导用户填写，每块用一句话说明作用：",
        "   - `agents`：各角色用哪个 provider / model / reasoning。",
        "   - `modelProviders`：`host` 交给宿主；外部模型走 OpenAI 兼容配置，`apiKeyEnv` 填环境变量名而不是密钥本身。",
        "   - `injectionPoints`：每个注入点挂哪些 `tools` / `markdown` / `skills` / `rules`。",
        "   - `contextBudgets`：Prompt / Markdown / Skill 的字符预算。",
        "   - `skillMatcher.dynamicInjection`：技能按需挂载的 `enabled` / `maxSkills` / `alwaysMount`。",
        "   - `qualityGates`：`commentChecker`。",
        "   - `review.llm`：是否启用 LLM 复核；`required=false` 时无 key 只告警不阻断。",
        "",
        "3. 填写完成后执行校验，并提示可用 `/wildarrange-doctor` 做整体体检：",
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
      title: `${PRODUCT_NAME} 生成或导入计划`,
      description: "根据当前对话生成待确认计划，或导入已有 plan.json；每张任务必须明确实际负责人 task.owner。",
      body: [
        "如果命令后带有计划文件路径（例如 `/wildarrange-plan plan.json`），直接导入并校验：",
        "",
        fence([`${cliPrefix} plan --from <计划文件路径>`]),
        "",
        "如果用户没有给出路径，不要再向用户索要 plan.json。若请求包含新增功能或新的用户可见行为，先执行 `clarify-feature-design`：直接在当前对话中按编号澄清并展示功能设计确认稿；不要创建 MD/HTML 文件，也不要在开发者明确回复“确认”前生成 plan draft。确认后，再理解当前对话中的目标、约束与质量要求，生成计划草稿。草稿必须写到 Hook 上下文给出的草稿绝对路径（`draftPath`）；上下文里没有时，先执行 `" + cliPrefix + " project show` 取 `runtimeRoot`，写到 `<runtimeRoot>/plan-drafts/<session>-plan.json`。不要写进项目目录：WildArrange 不向客户项目写任何文件。",
        "",
        "每张任务还必须包含 responsibilityChanges 数组，每项写 script（精确目标脚本）、additions（新增内容）、responsibilityBefore、responsibilityAfter、facts 数组。每项事实写 name、ownerBefore、ownerAfter、access（统一读写入口）；无事实填 facts: []，新事实 ownerBefore 为 null。计划摘要用中文展示职责变化与事实归属，等待用户确认。交付 Review 必须独立审计 R1-R5：符合已批职责、无职责混杂、无重复事实、无绕过入口、无重复实现；缺少执行器或有效证据不得称通过。",
        "生成的 JSON 顶层必须写 `generated_by: \"host_semantic\"`、`title`、`objective`、`tasks`；如果路由返回 `featureDesign.id`，还必须原样写入 `feature_design_ref`，否则功能计划不能导入。每张任务必须写 `id`、`subject`、`description`、`owner`、`writable_paths`、`worker_command`、`verify_commands`、`successCriteria`。`worker_command` 必须是宿主可执行的真实实现命令，并在 WildArrange 准备的隔离任务 worktree 中产生 `writable_paths` 内的改动；不能用 `node --version`、`process.exit(0)`、`true` 等占位。`verify_commands` 必须是非空的命令字符串数组，不能写成对象数组。每条 successCriteria 是对象，至少写 `title` 与 `expectedEvidence`；能由验证命令证明时，`verifierCommandRefs` 填从 0 开始的命令索引数组，或填与 `verify_commands` 中完全一致的命令字符串数组。",
        "可执行工单的 `owner` 必须是 Jiuwei 或 ZhuRong：实现任务通常交给 ZhuRong，必要的流程执行交给 Jiuwei。DiJiang、BaiZe、LuWu 是只读长期 Agent，分别通过计划、独立复核和仓库治理阶段参与，不能成为 command worker。不要留空，也不要用执行阶段的默认值代替。",
        "",
        "写入草稿后执行导入命令。若用户明确只要求生成草稿或明确说不要导入，写完即停止，不得执行下面的导入命令。正式导入的计划都会进入待确认状态，不能直接 run：",
        "",
        fence([`${cliPrefix} plan --from "<草稿绝对路径>"`]),
        "",
        "最后用中文展示计划摘要：任务目标、先后关系、每张任务的 owner、可写范围与验收方式，并明确询问用户是否确认。只有用户明确确认后，才执行 `plan approve`。若校验失败，指出缺哪一项并修订草稿。",
      ].join("\n"),
    },
    {
      name: `${SLASH_COMMAND_PREFIX}-approve`,
      title: `${PRODUCT_NAME} 确认计划`,
      description: "向开发者展示已导入计划或新增职责声明的摘要，得到明确确认后放行执行（人工确认门）。",
      body: [
        "每个导入的计划、以及计划确认后新增或改动职责声明的任务（后补单、整改单、steer 加单），都需要开发者确认。请这样做：",
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
        "4. 若开发者要修改，不要 approve；协助修订 `plan.json` 后重新 `/wildarrange-plan` 导入。",
      ].join("\n"),
    },
    {
      name: `${SLASH_COMMAND_PREFIX}-run`,
      title: `${PRODUCT_NAME} 跑下一个任务`,
      description: "运行下一个可运行任务，自动走 worker→verify→scope→review→验收证明→checkpoint 全部门禁。",
      body: [
        "先构建执行前上下文。把输出中 `injectionPoint.skills` 的全文当作当前任务必须遵守的工作流；若 `skillSelection.missing` 非空，先报告并停止，不要在缺少任务 Skill 时盲跑：",
        "",
        fence([`${cliPrefix} context build --point before_execute`]),
        "",
        "确认任务 Skill 已加载后，再执行下列命令跑下一个可运行任务（会自动走 worker → verify → scope → review → 验收证明 → checkpoint 全部门禁）：",
        "",
        fence([`${cliPrefix} run`]),
        "",
        "用中文汇报结果：worker 是否退出 0、verifier 是否通过、范围守卫与复核门结论、任务最终状态。注意 worker 退出 0 只是\"声称完成\"，最终以 gate 结论为准。若失败，说明卡在哪个 gate 以及重试建议。",
      ].join("\n"),
    },
  ];
}


export async function writeCodexBundle(externalRoot, bridge, activationId, cliPrefix) {
  const marketplaceRoot = path.join(externalRoot, "codex-marketplace");
  const pluginRoot = path.join(marketplaceRoot, "plugins", CODEX_PLUGIN_NAME);
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const hooksPath = path.join(pluginRoot, "hooks", "hooks.json");
  const bridgePath = path.join(pluginRoot, "hooks", CURSOR_BRIDGE_NAME);
  await writeJsonAtomic(manifestPath, {
    name: CODEX_PLUGIN_NAME,
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
  await writeJsonAtomic(hooksPath, buildCodexHooksConfig(`node "\${PLUGIN_ROOT}/hooks/${CURSOR_BRIDGE_NAME}"`));
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
      name: CODEX_PLUGIN_NAME,
      source: { source: "local", path: `./plugins/${CODEX_PLUGIN_NAME}` },
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
    cliPrefix,
    activation: "manual_install_and_trust_required",
    nextActions: [
      `codex plugin marketplace add "${marketplaceRoot}"`,
      `在 Codex /plugins 中安装 ${CODEX_PLUGIN_NAME}`,
      "审查并信任插件 Hooks，然后在已连接项目中新开一次会话",
    ],
  };
}

export async function writeCursorBundle(externalRoot, bridge, activationId, cliPrefix) {
  const root = path.join(externalRoot, "cursor");
  const bridgePath = path.join(root, "hooks", CURSOR_BRIDGE_NAME);
  const hooksPath = path.join(root, "hooks.json");
  await mkdir(path.dirname(bridgePath), { recursive: true });
  await writeFile(bridgePath, bridge, "utf8");
  await writeJsonAtomic(hooksPath, buildCursorUserHooks(`node ./hooks/${CURSOR_BRIDGE_NAME}`));
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

export async function writeKimiBundle(externalRoot, bridge, activationId, cliPrefix) {
  const pluginRoot = path.join(externalRoot, "kimi", "plugin");
  const manifestPath = path.join(pluginRoot, "kimi.plugin.json");
  const bridgePath = path.join(pluginRoot, "hooks", CURSOR_BRIDGE_NAME);
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
    cliPrefix,
    activation: "manual_install_required",
    nextActions: [`/plugins install ${pluginRoot}`, "/reload", "在已连接项目中新开一次会话"],
  };
}

/** Claude Code 本地 marketplace：插件按相对路径登记，Claude Code 直接读取运行态里的文件。 */
export async function writeClaudeBundle(externalRoot, bridge, activationId, cliPrefix) {
  const marketplaceRoot = path.join(externalRoot, "claude-marketplace");
  const pluginRoot = path.join(marketplaceRoot, "plugins", CLAUDE_PLUGIN_NAME);
  const manifestPath = path.join(pluginRoot, ".claude-plugin", "plugin.json");
  const hooksPath = path.join(pluginRoot, "hooks", "hooks.json");
  const bridgePath = path.join(pluginRoot, "hooks", CURSOR_BRIDGE_NAME);
  const marketplacePath = path.join(marketplaceRoot, ".claude-plugin", "marketplace.json");
  const hooks = buildClaudeHooksConfig(`node "\${CLAUDE_PLUGIN_ROOT}/hooks/${CURSOR_BRIDGE_NAME}"`);
  // Claude Code 运行安装时缓存的副本，只按版本号决定是否刷新：版本号随包内容变化
  const contentDigest = createHash("sha256").update(JSON.stringify([bridge, hooks, buildSlashCommands(cliPrefix)])).digest("hex").slice(0, 12);
  const version = `1.0.0-${contentDigest}`;
  await writeJsonAtomic(manifestPath, {
    name: CLAUDE_PLUGIN_NAME,
    version,
    description: "Project-selective WildArrange governance hooks without repository files.",
    author: { name: "AliveWaveLab" },
  });
  await writeJsonAtomic(hooksPath, hooks);
  await mkdir(path.dirname(bridgePath), { recursive: true });
  await writeFile(bridgePath, bridge, "utf8");
  await writePluginSkills(pluginRoot, cliPrefix);
  await writeJsonAtomic(marketplacePath, {
    name: CLAUDE_MARKETPLACE_NAME,
    owner: { name: "AliveWaveLab" },
    plugins: [{ name: CLAUDE_PLUGIN_NAME, source: `./plugins/${CLAUDE_PLUGIN_NAME}`, description: "WildArrange external governance hooks" }],
  });
  return {
    status: "bundle_generated",
    activationId,
    pluginRoot,
    manifestPath,
    hooksPath,
    bridgePath,
    marketplacePath,
    version,
    cliPrefix,
    activation: "explicit_user_activation_required",
    nextActions: ["wildarrange adapter activate --target claude", "在已连接项目中新开一次 Claude Code 会话（已开会话可运行 /reload-plugins）"],
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
        matcher: "^(Bash|apply_patch|functions\\.apply_patch|write|Write|edit|Edit|multi_edit|multiedit|MultiEdit|create_goal|functions\\.create_goal)$",
        hooks: [hook(20, "WildArrange: checking planned scope")],
      }],
      PostToolUse: [{ hooks: [hook(15, "WildArrange: recording tool result")] }],
      PostCompact: [{ matcher: "manual|auto", hooks: [hook(20, "WildArrange: restoring governance context")] }],
      Stop: [{ hooks: [hook(15, "WildArrange: checking continuation")] }],
      SubagentStop: [{ hooks: [hook(15, "WildArrange: checking continuation")] }],
    },
  };
}

/** Claude Code 的 PostCompact 不能注入上下文：压缩后的恢复由 SessionStart(source=compact) 承担，bridge 负责映射。 */
function buildClaudeHooksConfig(command) {
  const hook = (timeout, statusMessage) => ({ type: "command", command, timeout, statusMessage });
  const tools = "Bash|Write|Edit|MultiEdit|NotebookEdit";
  return {
    hooks: {
      SessionStart: [{ hooks: [hook(30, "WildArrange: loading external governance")] }],
      UserPromptSubmit: [{ hooks: [hook(20, "WildArrange: routing with external governance")] }],
      PreToolUse: [{ matcher: tools, hooks: [hook(20, "WildArrange: checking planned scope")] }],
      PostToolUse: [{ matcher: tools, hooks: [hook(15, "WildArrange: recording tool result")] }],
      Stop: [{ hooks: [hook(15, "WildArrange: checking continuation")] }],
      SubagentStop: [{ hooks: [hook(15, "WildArrange: checking continuation")] }],
    },
  };
}

export function buildCursorUserHooks(command) {
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
  const command = `node ./hooks/${CURSOR_BRIDGE_NAME}`;
  const hook = (event, matcher) => ({ event, ...(matcher ? { matcher } : {}), command, timeout: 20 });
  return {
    name: KIMI_PLUGIN_NAME,
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
