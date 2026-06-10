# 00 · HelixFlow（我们的框架 · DRAFT）

> 产品中立的全流程 Agent 工作流内核。可装入 Claude Code / Codex / Cursor，多产品共享成果物且不冲突、可插拔。
> 这里的节点是**我们设计的草稿**（SKILL.md 注入提示词 + 工具/MCP/GATE 说明），区别于其它 11 个目录是抓取的真实开源源文件。
> 完整设计见：`doc/plans/2026-06-09-通用Agent工作流内核方案.html`（总架构）、`doc/brainstorms/2026-06-09-HelixFlow-M1工作保险箱-requirements.html`（M1）。

## 三层中立内核（最大公约数）
- 指令层 `AGENTS.md`（瘦·路由）
- 能力层 `.agent/skills/*/SKILL.md`（这些节点）
- 工具层 MCP server（gates / artifacts / vault）

## 全流程 9 阶段 + 贯穿 + 编排
| 节点 | 角色 | 偷自 |
|---|---|---|
| 01-hf-ideate | 产品负责人(治理) | ce-brainstorm rigor probes |
| 02-hf-spec | 产品+架构(治理) | OpenSpec delta + RFC2119 |
| 03-hf-design | 设计负责人(治理) | BMAD ux-expert + 组件槽位(原创杀痛点5) |
| 04-hf-architect | 架构师(治理) | spec-kit 宪法门 + REQ 追溯 |
| 05-hf-plan | PM(治理) | BMAD context_package + claude-flow Tier 路由 |
| 06-hf-work | 开发(执行) | worktree 隔离 + 区段写权限 |
| 07-hf-review | reviewer 扇出(执行) | CE 四段管线(扇出→去重→置信门控→独立验证) |
| 08-hf-test | 测试(执行) | spec 场景→用例 + 自进化飞轮 |
| 09-hf-deploy | 部署(执行)+PM放行(HITL) | CI watch 三轮 |
| 10-hf-recall | 贯穿 | CE learnings-researcher（召回前置·Grep-first） |
| 11-hf-compound | 贯穿 | CE 双轨 schema（沉淀后置·自进化载体） |
| 12-hf-run | 编排 | lfg 带 GATE 状态机 + 跨产品优雅降级 |

## M1（先建·别丢东西）
见 `M1-work-vault/` —— 工作保险箱 8 节点（画像识别/隔离/checkpoint daemon/产物落地/一键恢复/merge收口/硬锁/跨产品）。多为 MCP/daemon/git 约定，是设计规格，待 ce-plan 落实。

## 引擎可追加
引擎专属规则(标志文件/不可合并文件/提示词)是可追加层 `.helix/engines/{unity,ue,...}.yml`，不绑死 Unity，不改内核。
