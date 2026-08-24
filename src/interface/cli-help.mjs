/**
 * CLI 命令注册表：--help 与文档生成物的单一事实源。
 *
 * 分层规则：core 六命令（init/plan/run/status/decisions/doctor）覆盖日常
 * 主循环，默认 --help 只显示它们；其余命令一律落 --help --all 非核心区。
 * 新命令必须先登记到这里再实现——README 命令真实性检查以 --help --all
 * 输出为准，未登记的命令会被 governance audit 拦截。
 */
import { DEFAULT_EXECUTOR_AGENT, DEFAULT_LEAD_AGENT } from "../infra/agent-registry.mjs";
import { DEFAULT_PACKAGE_NAME, PRODUCT_NAME } from "../infra/runtime-config.mjs";

export const CORE_COMMANDS = ["init", "plan", "run", "status", "decisions", "doctor"];

export const COMMAND_REGISTRY = [
  { usage: "init [--sample]", desc: "初始化运行时（可选导入样例计划）", core: true },
  { usage: "plan --from <plan.json>", desc: "导入计划并生成任务状态", core: true },
  { usage: "plan approve [--plan <planId>]", desc: "确认已导入计划（开启 planApproval 时才能 run）" },
  { usage: "run", desc: "跑下一个任务（worker→verifier→scope→review→checkpoint）", core: true },
  { usage: "status", desc: "查看状态（含门武装黄灯）", core: true },
  { usage: "decisions [--limit N] [--task T001] [--gate pre_tool_use] [--annotatable] [--format json]", desc: "查看门决策记录（每一次拦截/放行；--annotatable 只看可标注队列）", core: true },
  { usage: "doctor", desc: "一键体检：配置/完成状态/ledger/备份对账", core: true },

  { usage: "config init [--root] [--force] [--armed]", desc: "生成默认配置（--armed 直接武装质量门）" },
  { usage: "config show", desc: "查看生效配置" },
  { usage: "config baseline [--reason \"...\"]", desc: "写入 config hash 基线" },
  { usage: "config verify", desc: "校验 config 基线" },
  { usage: "device register [--name macbook] [--force]", desc: "登记当前设备" },
  { usage: "device status", desc: "查看设备登记状态" },
  { usage: "coordination status", desc: "查看 Git 协调状态" },
  { usage: "coordination claim --task T001 [--owner ZhuRong]", desc: "显式远端领取任务" },
  { usage: "handoff prepare --task T001 --to-device-id <uuid> [--to-device-name mac-mini] [--to-owner ZhuRong]", desc: "准备跨设备交接" },
  { usage: "handoff push --task T001", desc: "推送跨设备交接" },
  { usage: "handoff accept --task T001 [--plan P20260731]", desc: "接受跨设备交接" },
  { usage: "handoff takeover --plan P20260731 --task T001 --expected-device-id <uuid> --reason \"owner offline\"", desc: "显式接管（记录预期旧设备与理由）" },
  { usage: `adapter install [--target codex|cursor|kimi|all] [--mode local|npx] [--package ${DEFAULT_PACKAGE_NAME}]`, desc: "安装宿主 adapter" },
  { usage: "adapter uninstall [--target codex|cursor|kimi|all]", desc: "卸载宿主 adapter" },
  { usage: "adapter restore --backup <backupId>", desc: "恢复 adapter 备份" },
  { usage: "injection show --point before_review [--agent BaiZe] [--task T001] [--text \"...\"] [--stage plan]", desc: "查看注入点解析结果" },
  { usage: "hook run [--from hook.json] [--format text|json]", desc: "运行宿主生命周期 Hook" },
  { usage: "workflow --from <plan.json>", desc: "从计划跑完整 workflow" },
  { usage: "workflow --sample", desc: "跑样例 workflow" },
  { usage: "parallel run [--max-agents 2] [--task T001,T002] [--agent ZhuRong] [--adapter codex|cursor] [--isolation run-dir|git-worktree] [--coordinate] [--command \"...\"]", desc: "跑并行子 Agent" },
  { usage: "parallel admit --run <runId> --task T001", desc: "合入子 Agent 成果（admission 事务）" },
  { usage: "parallel list", desc: "列出并行 run" },
  { usage: "parallel status [--run <runId>]", desc: "查看并行运行记录与批次对账" },
  { usage: "parallel close --run <runId> [--task T001] [--reason \"...\"]", desc: "关闭保留的子 Agent 结果" },
  { usage: "parallel cleanup --run <runId>", desc: "清理 Git worktree 隔离目录" },
  { usage: "parallel retry --run <runId> [--command \"...\"] [--max-agents N]", desc: "只重跑未完成任务的局部重试" },
  { usage: "archivist packet [--text \"...\"] [--stage plan] [--turns turns.json]", desc: "生成档案路由包" },
  { usage: "archivist run [--text \"...\"] [--stage plan] [--turns turns.json] [--force]", desc: "运行档案路由员" },
  { usage: "archivist suggestions list", desc: "查看路由建议" },
  { usage: "archivist suggestions resolve --id <id> --decision accept|reject --evidence \"...\" --rationale \"...\"", desc: "审核路由建议" },
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
  { usage: `context build [--agent ${DEFAULT_EXECUTOR_AGENT}] [--task T001]`, desc: "构建 Agent 上下文" },
  { usage: "evidence record --task T001 --criterion C001 --status pass --evidence \"...\"", desc: "回填成功判据证据" },
  { usage: "steer --from <proposal.json>", desc: "任务变更治理入口" },
  { usage: "review-blockers record --from <blocker.json>", desc: "登记 Review Blocker" },
  { usage: "task list [--all] [--status draft|pending|completed] [--type feature|bug|acceptance_correction|maintenance] [--priority P0|P1|P2] [--plan <planId>] [--search \"text\"]", desc: "列出当前计划或全项目工单" },
  { usage: "task get --task T001 [--plan <planId>]", desc: "查看单个任务与历史" },
  { usage: `task claim [--task T001] [--owner ${DEFAULT_EXECUTOR_AGENT}]`, desc: "认领任务" },
  { usage: "task create --title \"修复登录失败\" [--type bug] [--priority P1] [--source user] [--parent <taskRef>] [--writable src/**] [--verify \"npm test\"] [--review \"npm test\"]", desc: "创建工单；验证信息不足时先进入 draft" },
  { usage: "task create --from <task.json>", desc: "从 JSON 创建工单" },
  { usage: "task ready --task T001 --from <task-details.json> [--plan <planId>]", desc: "补齐 draft 并转为可执行 pending" },
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
  { usage: "review suspicious [--limit N]", desc: "LLM 可疑判断异步审查（只进报告，不进完成链）" },
  { usage: "test [--zone interface|orchestration|ai|capabilities|infra] [changed-file...]", desc: "分区/影响面最小测试集" },
  { usage: "docs commands [--write]", desc: "从命令注册表生成命令文档（单一事实源）" },
  { usage: "state backup [--reason \"...\"]", desc: "备份运行态关键文件" },
  { usage: "state verify", desc: "校验运行态关键文件" },
  { usage: "state list", desc: "列出运行态备份" },
  { usage: "state restore --backup <backupId>", desc: "恢复运行态备份" },
  { usage: "serve [--host 127.0.0.1] [--port 8765] [--token <token>]", desc: "启动本地 dashboard（默认仅 loopback）" },
  { usage: "guard scope [--task T001]", desc: "校验任务范围" },
  { usage: "route --text \"request\"", desc: "请求路由" },
  { usage: "prompts list", desc: "列出提示词" },
  { usage: `prompts show --agent ${DEFAULT_EXECUTOR_AGENT}`, desc: "查看 Agent 提示词" },
  { usage: "prompts show --skill review-work", desc: "查看 Skill 提示词" },
  { usage: `prompts variant [--agent ${DEFAULT_EXECUTOR_AGENT}] [--provider host|deepseek|gemini|kimi] [--model "..."]`, desc: "查看提示词模型变体" },
  { usage: `skills match --text "request" [--stage plan] [--agent ${DEFAULT_EXECUTOR_AGENT}] [--limit 6]`, desc: "匹配 Skill" },
  { usage: "prompts show --tools", desc: "查看工具合同" },
  { usage: "prompts show --routes", desc: "查看路由表" },
];

const PLAN_SCHEMA = `
Plan schema:
  {
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
      "category": "quick|deep|ultrabrain|visual-engineering",
      "worker_command": "command that changes files",
      "verify_commands": ["command that must pass"]
    }]
  }
`;

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

export function renderCommandsMarkdown() {
  const rows = COMMAND_REGISTRY.map((entry) => `| \`wildarrange ${entry.usage}\` | ${entry.desc} |`);
  return [
    "<!-- 由 `node ./bin/helix.mjs docs commands --write` 从 src/interface/cli-help.mjs 生成，请勿手改 -->",
    "",
    "| 命令 | 说明 |",
    "| ---- | ---- |",
    ...rows,
    "",
  ].join("\n");
}
