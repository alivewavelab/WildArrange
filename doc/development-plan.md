# WildArrange 开发计划

> 只记录路线与状态，不替代当前架构事实。架构真相见根 `AGENTS.md` 与 [project-architecture.md](./project-architecture.md)。

## P0：可发布的 M1

- 维护 README 与 onboarding 文档。`DONE`
- 保持 `npm test` 全绿。`DONE`（持续）
- 保持 `npm pack --dry-run` 全绿。`DONE`（持续）
- adapter 安装/卸载可逆。`DONE`
- adapter 备份恢复路径明确。`DONE: adapter restore --backup <backupId>`
- 确定 npm 包名或组织 scope。`DONE: @alivewavelab/wildarrange`
- 在路由循环中加入 ArchivistRouter 运行时，但不强制 LLM 调用。`DONE: packet/fallback/memory path + trigger scheduler + suggestion review flow`
- 为 BaiZe review 通道接入真实 LLM review provider。`DONE: OpenAI-compatible provider path；原 LuanNiao/QiongQi 视角现为 BaiZe Skill`
- 加入 checkpoint 验收证明链。`DONE: worker/verifier/successCriteria/scope/review proof artifact required before completion`
- 加入 LSP 诊断门。`DONE: host-neutral CLI command gate`
- 加入 AST/hashline 代码智能门。`DONE: astStructure command lane + hashline anchor lane in review_gate`
- 加入注释检查器。`DONE: configurable blocker/warn lane`
- 五区解耦 + 共享 delivery pipeline + 依赖边界测试。`DONE`
- 拆分 `foundation.mjs` 为聚焦的 infra 模块并删除旧聚合入口。`DONE: callers import concrete infra owners`

## P1：线性质量

- 用 `deepseek-v4-flash` 实现 ArchivistRouter，覆盖 SessionStart、Git HEAD 变更、低置信路由与周期性 prompt 摘要。`DONE: runtime, manual CLI, hooks, Git HEAD trigger state, and stage-aware prompt windows`
- 加入本地结构化记忆文件：进度、决策、产物、实现笔记、调研笔记、坑点与上下文注入。`DONE: minimal structured-files backend`
- 在 `.helix/routing/suggestions` 下加入路由建议产物及 apply/reject 审核流。`DONE: pending suggestions, accept/reject CLI, and reviewed route override layer`
- 加入语义路由 shadow 与低置信 execute 降级。`DONE: deterministic route keeps evidence; CangJie shadow can force ambiguous execute into plan/ask`
- 加入 session/task digest 文件，用于误关聊天后的恢复。`DONE: session_start/post_compact/task_completed/parallel_admission_completed digests`
- 为 GPT、Gemini、Kimi、DeepSeek 与宿主托管模型加入 prompt 模型变体。`DONE: configurable promptVariants + prompts variant/show --variant`
- 加入 `pre-publish-review`、`publish`、`get-unpublished-changes` skill。`DONE: packs/wildarrange-linear/skills/`
- 加入 skill matcher 与优先级加载。`DONE: stage/route/agent/keyword matcher with explainable scores`
- 若 uninstall 备份不足，加入 adapter 备份恢复命令。`DONE`
- 加入 LuWu 仓库治理能力及 `governance audit`。`DONE`
- 加入 Kimi Code adapter P0/P1（plugin + fail-open Hook bridge）。`DONE`；宿主私有 spawn 仍为 P2
- 加入弱代码可维护性面：`decisions` / `timeline` / `annotate`、Cursor hooks fail-closed、gate-arming 黄灯。`DONE`
- 加入产品架构总图 + `tooling/arch-module-graph` + `npm run check:arch`。`DONE`
- 仓库有 remote 后加入 CI。`TODO`
- decisions/ledger 日志轮转。`DEFERRED: experience/scale, not a completion-gate blocker`

## P2：多 Agent 运行时

- 实现 `codex_spawn_agent` 最小可行子 Agent 调用。`PARTIAL: host-neutral Codex/Cursor command-template spawn exists; host-private background agent API remains adapter work`
- 加入后台 task/session 管理器。`DONE: run index, lifecycle status, awaiting_user_acceptance retention, explicit close/release commands; host-private long-lived process control remains adapter work`
- 加入 worktree 隔离与 merge admission。`DONE: Git worktree isolation, patch extraction, writable_paths check, patch apply, verifier/scope/review/acceptance-proof/checkpoint admission, failed admission rollback`
- 轻量子 Agent 结果在 user/mainline acceptance 前保持开放。`DONE: successful child results enter awaiting_user_acceptance and release after admission`
- Git 多设备协调（`guarded`/`strict`、handoff、integration SHA fence、admission-recovery）。`DONE`
- 加入 Skill MCP 支持。`PARTIAL: skill/tool contracts are installable and matchable; external MCP server lifecycle remains adapter work`
- 加入项目 Agent Pack 支持，用于 GameYo 等垂直生产工作流：项目定义的阶段 worker、阶段循环、必需输出、可写路径与 gate 绑定；ProducerAgent 与治理 gate 仍由 WildArrange 拥有。`TODO`
- tmux/cmux 可视化仅在后台 Agent 跑通之后。`DEFERRED: not required for publishable CLI loop`

## 质量门槛

产品不会因为「prompt 写出来了」就被视为生产就绪。

门槛是：

- 角色 prompt 已加载，
- 工具可调用，
- gate 能阻断，
- 证据可持久化，
- 失败可恢复，
- 用户安装/卸载时无需手改隐藏文件。
