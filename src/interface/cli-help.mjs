// =============================================================================
// 文件名称：cli-help.mjs
// 所属模块：interface
// 作用说明：
//   CLI 命令注册表与 --help / docs commands 的单一事实源。
//   登记每条 wildarrange 子命令的 usage 与中文说明；不实现命令逻辑本身。
//
// 【运行原理速读】
//   可以把它想成「命令菜单的总台账」：
//
//   · 谁调用？
//     bin/wildarrange.mjs 在 --help、--help --all 与 docs commands --write 时读取。
//
//   · 它做了什么？
//     ① 维护 CORE_COMMANDS 与 COMMAND_REGISTRY ② renderHelp 按 core/all 过滤输出
//     ③ renderCommandsMarkdown 生成 README 命令表。
//
//   · 和其他部分的关系？
//     新命令必须先登记再实现；governance audit 以 --help --all 输出校验命令真实性。
// =============================================================================
import { DEFAULT_EXECUTOR_AGENT, DEFAULT_LEAD_AGENT } from "../infra/agent-registry.mjs";
import { DEFAULT_PACKAGE_NAME, PRODUCT_NAME } from "../infra/runtime-config.mjs";

/** 默认 --help 展示的核心六命令（日常主循环）。 */
export const CORE_COMMANDS = ["setup", "plan", "run", "status", "decisions", "doctor"];

/**
 * 全部 CLI 子命令的 usage、说明与是否 core 标记。
 * 新命令须先登记再于 bin/wildarrange.mjs 实现；governance audit 以 --help --all 校验真实性。
 */
export const COMMAND_REGISTRY = [
  { usage: "setup --governance-root <path> [--repository <git-url>] [--target codex|cursor|kimi|all] [--default-branch main]", desc: "一步接入外置治理：创建治理仓（含 Git 初始提交与默认武装配置）→ attach → init → 生成宿主 Adapter 包；客户项目零写入", core: true },
  { usage: "project init-governance --governance-root <path> --repository <git-url> [--default-branch main]", desc: "在项目外创建不覆盖已有文件的治理仓库骨架与默认武装配置；非 Git 目录自动 git init 并提交初始 commit" },
  { usage: "project attach --governance-root <path> [--project-root <path>] [--runtime-root <path>]", desc: "把客户项目连接到独立治理仓库；映射写入项目外部状态目录" },
  { usage: "project show [--project-root <path>]", desc: "查看项目、治理仓库和运行态三根连接" },
  { usage: "integration accept --project-sha <40-char-sha> --governance-sha <40-char-sha> [--id <id>] [--reason \"...\"]", desc: "校验两个仓库的提交与治理注册表，并在项目外运行态写双 SHA 集成验收收据" },
  { usage: "review configure --from <setup.json> [--apply]", desc: "预览项目审查与执行准备配置；明确确认后 --apply，只能更新治理配置" },
  { usage: "review checklist --task <taskId>", desc: "解析本任务项目审查清单和必需依据，不启动执行器" },
  { usage: "readiness --task <taskId>", desc: "检查已批准任务必需的执行器、Skill、规范与握手，不启动业务 Worker" },
  { usage: "adoption inventory", desc: "只读扫描旧仓库文件与验证资产，供接管 Skill 建立来源映射" },
  { usage: "init [--sample]", desc: "在已连接项目的 runtimeRoot 初始化运行态（setup 已包含此步骤）；不写客户仓库" },
  { usage: "plan --from <plan.json>", desc: "导入含 responsibilityChanges 的计划；等待人工确认职责与事实归属", core: true },
  { usage: "plan approve [--plan <planId>]", desc: "确认待执行计划（语义生成计划或已开启 planApproval）" },
  { usage: "run", desc: "跑下一个任务（worker→verifier→scope→review→checkpoint）", core: true },
  { usage: "status", desc: "查看状态（含门武装黄灯）", core: true },
  { usage: "decisions [--limit N] [--task T001] [--gate pre_tool_use] [--annotatable] [--format json]", desc: "查看门决策记录（每一次拦截/放行；--annotatable 只看可标注队列）", core: true },
  { usage: "doctor", desc: "一键体检：配置/完成状态/ledger/备份对账", core: true },

  { usage: "config init [--force] [--armed]", desc: "在治理仓 policy/ 生成默认配置（--armed 直接武装质量门）" },
  { usage: "config show", desc: "查看生效配置" },
  { usage: "config baseline [--reason \"...\"]", desc: "写入 config hash 基线" },
  { usage: "config verify", desc: "校验 config 基线" },
  { usage: `adapter install [--target codex|cursor|kimi|all] [--mode local|npx] [--package ${DEFAULT_PACKAGE_NAME}]`, desc: "在 runtimeRoot 生成宿主外置插件包；--mode 选择 hook 调用 CLI 的前缀（local 当前 bin 路径 / npx 包名）" },
  { usage: "adapter activate [--target cursor|codex|all] [--user-root <path>]", desc: "显式写入用户级配置：Cursor Hook 与指针规则、Codex AGENTS.md 指针段；先备份且不写客户项目" },
  { usage: "adapter uninstall [--target codex|cursor|kimi|all]", desc: "卸载宿主 adapter：移除用户级条目与指针并删除 runtime 插件包" },
  { usage: "adapter restore --backup <backupId>", desc: "恢复 adapter 备份：还原到该次 activate 之前的用户级文件" },
  { usage: "injection show --point before_review [--agent BaiZe] [--task T001] [--text \"...\"] [--stage plan]", desc: "查看注入点解析结果" },
  { usage: "hook run [--from hook.json] [--format text|json] --adapter-digest <sha256>", desc: "运行宿主生命周期 Hook；只处理已连接项目，未连接项目静默放行" },
  { usage: "workflow --from <plan.json>", desc: "从计划跑完整 workflow" },
  { usage: "workflow --sample", desc: "跑样例 workflow" },
  { usage: "parallel run [--max-agents 2] [--task T001,T002] [--agent ZhuRong] [--adapter codex|cursor] [--isolation run-dir|git-worktree] [--command \"...\"]", desc: "跑并行子 Agent" },
  { usage: "parallel admit --run <runId> --task T001", desc: "合入子 Agent 成果（admission 事务）" },
  { usage: "parallel list", desc: "列出并行 run" },
  { usage: "parallel status [--run <runId>]", desc: "查看并行运行记录与批次对账" },
  { usage: "parallel close --run <runId> [--task T001] [--reason \"...\"]", desc: "关闭保留的子 Agent 结果" },
  { usage: "parallel cleanup --run <runId>", desc: "清理 Git worktree 隔离目录" },
  { usage: "parallel retry --run <runId> [--command \"...\"] [--max-agents N]", desc: "只重跑未完成任务的局部重试" },
  { usage: "node route --text \"request\"", desc: "单节点：路由" },
  { usage: "node execute [--task T001]", desc: "单节点：执行" },
  { usage: "node verify [--task T001]", desc: "单节点：验证" },
  { usage: "node scope [--task T001]", desc: "单节点：范围检查" },
  { usage: "node review [--task T001]", desc: "单节点：复核" },
  { usage: "node checkpoint [--task T001]", desc: "单节点：checkpoint" },
  { usage: "node retry [--task T001]", desc: "单节点：重试" },
  { usage: "resume [--session <id>]", desc: "恢复会话上下文" },
  { usage: "continuation check [--session <id>]", desc: "检查会话延续" },
  { usage: "summary", desc: "生成 workflow 总结" },
  { usage: "rules collect [--target src/app.js]", desc: "收集项目规则上下文" },
  { usage: "governance audit [--changed-only] [--force]", desc: "仓库治理检查" },
  { usage: "contracts scan [--from <contract-changes.json>]", desc: "扫描 Tauri IPC 契约并生成待审核差异卡" },
  { usage: "contracts apply-card --card <id> --decision approve|reject --reason \"...\" --expected-fingerprint <sha256>", desc: "由开发者批准或拒绝当前契约差异卡" },
  { usage: "contracts generate", desc: "从已批准契约台账生成人类可读总图" },
  { usage: "contracts propose --task <id> --from <proposal.json>", desc: "提出计划外接口或数据库变更，暂停任务等待人类决定" },
  { usage: "contracts resolve --id <id> --decision accept|reject --expected-fingerprint <sha256> --reason \"...\"", desc: "按当前变更内容记录人类决定，批准后重新验收" },
  { usage: `context build [--agent ${DEFAULT_EXECUTOR_AGENT}] [--task T001] [--plan <planId>] [--point before_execute]`, desc: "构建指定计划与注入点的 Agent 上下文" },
  { usage: "evidence record --task T001 --criterion C001 --status pass --evidence \"...\"", desc: "回填成功判据证据" },
  { usage: "steer --from <proposal.json>", desc: "任务变更治理入口" },
  { usage: "review-blockers record --from <blocker.json>", desc: "登记 Review Blocker" },
  { usage: `task list [--all] [--status draft|pending|completed] [--type feature|bug|acceptance_correction|maintenance] [--priority P0|P1|P2] [--owner ${DEFAULT_EXECUTOR_AGENT}] [--plan <planId>] [--search "text"]`, desc: "列出当前计划或全项目工单" },
  { usage: "task get --task T001 [--plan <planId>]", desc: "查看单个任务与历史" },
  { usage: `task claim [--task T001] [--owner ${DEFAULT_EXECUTOR_AGENT}]`, desc: "认领任务" },
  { usage: "task create --title \"修复登录失败\" [--type bug] [--priority P1] [--source user] [--parent <taskRef>] [--writable src/**] [--verify \"npm test\"] [--review \"npm test\"]", desc: "创建工单；验证信息不足时先进入 draft" },
  { usage: "task create --from <task.json>", desc: "从 JSON 创建工单" },
  { usage: "task ready --task T001 --from <task-details.json> [--plan <planId>]", desc: "补齐 draft 并转为可执行 pending" },
  { usage: "task archive --task T001 [--plan <planId>] --delete [--reason \"...\"]", desc: "备份后写 ledger 墓碑，并删除非运行中任务及其专属运行态文件" },
  { usage: `team send --to ${DEFAULT_EXECUTOR_AGENT} --from ${DEFAULT_LEAD_AGENT} --body "..."`, desc: "发送团队消息" },
  { usage: `team inbox [--agent ${DEFAULT_EXECUTOR_AGENT}]`, desc: "查看团队收件箱" },
  { usage: "changes list", desc: "列出 ChangeRequest" },
  { usage: "changes review --id CR-xxxx", desc: "查看 ChangeRequest" },
  { usage: "changes resolve --id CR-xxxx --decision accept|reject --evidence \"...\" --rationale \"...\" [--apply-scope]", desc: "裁决 ChangeRequest" },
  { usage: "ledger verify", desc: "校验 ledger hash 链" },
  { usage: "impact <changed-file...>", desc: "改动影响面分析（反向依赖闭包）" },
  { usage: "decisions stats", desc: "门触发统计：计数/从未触发的门/标注关联" },
  { usage: "timeline [--limit N] [--task T001] [--source ledger|decision|annotation] [--format json]", desc: "ledger+决策+标注统一时间线" },
  { usage: "annotate --decision <decisionId> --category <confirmed|rule_wrong|case_wrong|mislabeled> [--reason \"...\"] [--author name]", desc: "标注门决策（只进报告，不改配置）" },
  { usage: "annotate list [--limit N]", desc: "列出标注" },
  { usage: "annotate stats", desc: "标注聚合统计" },
  { usage: "test [--zone interface|orchestration|ai|capabilities|infra] [changed-file...]", desc: "分区/影响面最小测试集" },
  { usage: "docs commands [--write]", desc: "从命令注册表生成命令文档（单一事实源）" },
  { usage: "state backup [--reason \"...\"]", desc: "备份运行态关键文件" },
  { usage: "state verify", desc: "校验运行态关键文件" },
  { usage: "state list", desc: "列出运行态备份" },
  { usage: "state restore --backup <backupId>", desc: "恢复运行态备份" },
  { usage: "serve [--host 127.0.0.1] [--port 8765] [--token <token>]", desc: "启动本地 dashboard（默认仅 loopback）" },
  { usage: "adoption start [--host 127.0.0.1] [--port 8765] [--token <token>]", desc: "只读扫描老项目验证资产并打开 Dashboard 逐卡批准" },
  { usage: "adoption status [--session <sessionId>]", desc: "只读对账接管会话、待决策/过期卡和新鲜度黄灯" },
  { usage: "adoption resume [--session <sessionId>] [--host 127.0.0.1] [--port 8765] [--token <token>]", desc: "按磁盘事实恢复接管会话；不安全时只显示 recovery_required" },
  { usage: "adoption recover [--session <sessionId>]", desc: "重试恢复失败事务的 preimage，成功后释放维护锁" },
  { usage: "guard scope [--task T001]", desc: "校验任务范围" },
  { usage: "route --text \"request\"", desc: "请求路由" },
  { usage: "prompts list", desc: "列出提示词" },
  { usage: `prompts show --agent ${DEFAULT_EXECUTOR_AGENT}`, desc: "查看 Agent 提示词" },
  { usage: "prompts show --skill review-work", desc: "查看 Skill 提示词" },
  { usage: `skills match --text "request" [--stage plan] [--agent ${DEFAULT_EXECUTOR_AGENT}] [--limit 6]`, desc: "匹配 Skill" },
  { usage: "prompts show --tools", desc: "查看工具合同" },
  { usage: "prompts show --routes", desc: "查看路由表" },
];

/** --help 末尾附带的 plan.json 最小 schema 说明（供宿主语义生成计划时对照）。 */
const PLAN_SCHEMA = `
Plan schema:
  {
    "generated_by": "host_semantic",
    "title": "Feature name",
    "objective": "What must be true",
    "defaults": {
      "verify_commands": ["shared verifier for every task"],
      "review_commands": ["shared review gate"],
      "standards_commands": ["project standards gate"],
      "writable_paths": ["src/**"]
    },
    "tasks": [{
      "id": "T001",
      "subject": "Implement one thing",
      "repositoryTarget": "project|governance",
      "description": "What this task delivers",
      "owner": "Jiuwei|ZhuRong",
      "category": "quick|deep|ultrabrain|visual-engineering",
      "writable_paths": ["src/**"],
      "worker_command": "command that changes files",
      "verify_commands": ["command that must pass"],
      "successCriteria": [{
        "title": "observable acceptance condition",
        "expectedEvidence": "what proves it",
        "verifierCommandRefs": [0]
      }]
    }]
  }

generated_by=host_semantic means the host conversation generated this plan.
Such plans must declare a command-worker task.owner (Jiuwei or ZhuRong) on every task and always wait for plan approve.
Each host semantic task must also use a real, non-trivial worker_command that changes writable_paths inside its isolated task worktree; version checks and process.exit(0) are placeholders, not implementation.
`;

/**
 * 渲染终端 --help 文本；默认仅 core 六命令，--all 时输出完整注册表。
 * @param {{ all?: boolean }} [options]
 * @returns {string}
 */
export function renderHelp({ all = false } = {}) {
  const entries = all ? COMMAND_REGISTRY : COMMAND_REGISTRY.filter((entry) => entry.core === true);
  const lines = entries.map((entry) => `  wildarrange ${entry.usage}`);
  const hint = all
    ? ""
    : `\n（仅显示核心六命令；全部 ${COMMAND_REGISTRY.length} 条命令见 wildarrange --help --all）\n`;
  return `${PRODUCT_NAME} linear runtime

Usage:
${lines.join("\n")}
${hint}${PLAN_SCHEMA}`;
}

/**
 * 从 COMMAND_REGISTRY 生成 Markdown 命令表，供 docs commands --write 写入文档。
 * @returns {string}
 */
export function renderCommandsMarkdown() {
  const rows = COMMAND_REGISTRY.map((entry) => `| \`wildarrange ${entry.usage}\` | ${entry.desc} |`);
  return [
    "<!-- 由 `node ./bin/wildarrange.mjs docs commands --write` 从 src/interface/cli-help.mjs 生成，请勿手改 -->",
    "",
    "| 命令 | 说明 |",
    "| ---- | ---- |",
    ...rows,
    "",
  ].join("\n");
}

/**
 * 从 COMMAND_REGISTRY 生成 Prompt Pack 的 Agent 工具合同（tools/tool-contract.json）。
 * 与 --help 同源，避免手写合同漂移；由 tooling/generate-tool-contract.mjs 落盘。
 * @returns {string}
 */
export function renderToolContract() {
  const seen = new Map();
  const tools = COMMAND_REGISTRY.map((entry) => {
    const words = entry.usage.split(/\s+/);
    const firstArg = words.findIndex((word) => /^[-<[\"]/.test(word));
    const commandWords = firstArg === -1 ? words : words.slice(0, firstArg);
    let name = `wildarrange_${commandWords.join("_").replace(/-/g, "_")}`;
    if (seen.has(name)) {
      const flag = words.find((word) => word.startsWith("--"))?.replace(/^--/, "").replace(/-/g, "_");
      name = flag ? `${name}_${flag}` : `${name}_${seen.get(name) + 1}`;
    }
    seen.set(name, (seen.get(name) || 0) + 1);
    return { name, command: `wildarrange ${entry.usage}`, purpose: entry.desc };
  });
  return `${JSON.stringify({ version: 2, runtime: "wildarrange-linear", generatedFrom: "src/interface/cli-help.mjs", tools }, null, 2)}\n`;
}
