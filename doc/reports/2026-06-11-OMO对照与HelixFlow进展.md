# OMO 对照与 HelixFlow 进展

生成日期：2026-06-11  
项目目录：`/Users/boyanliu/Documents/Development/文档规范/工作范式`  
OMO 源码目录：`/private/tmp/oh-my-openagent-src`

## 结论

当前 HelixFlow 已经完成“线性治理闭环”的可运行骨架：初始化、计划导入、路由、任务执行、验证、范围门、复核门、checkpoint、恢复、消息板、dashboard、Codex/Cursor adapter 生成、npm/npx 包结构。

但它还不是 OMO 等价实现。差距不在“提示词有没有写”，而在 OMO 的宿主级工具链和后台运行时：真实子 Agent 启动、后台并发、模型 fallback、LSP 守门、评论检查、Skill MCP、OpenCode 会话管理、tmux/cmux 可视化、多 Agent team mode、真实 LLM review provider。  
按源码级能力看：线性闭环约 80%-85%；去掉多 Agent 并行后，目标 90% 的主要缺口是 LSP/comment checker、真实 LLM review gate、prompt/model variant、adapter 真安装。

## 已合并进当前本地实现的进展

说明：当前目录不是 Git 仓库，`git status` 返回 `fatal: not a git repository`，所以这里的“合并”指本地代码已集中到当前工作区运行时，不是 Git merge/commit。

| 模块 | 当前状态 | 作用 | 证据 |
|---|---:|---|---|
| npm/npx 包结构 | 已完成 | 让用户通过 `npx helixflow` 或安装 devDependency 使用 | `package.json` 暴露 `bin.helix`、`bin.helixflow`，`private=false` |
| CLI 主入口 | 已完成 | 提供 `init/config/adapter/hook/workflow/node/team/status/serve` 等命令 | `bin/helix.mjs` |
| 运行时核心 | 已完成 | 管理 `.helix` 状态、计划、任务、ledger、checkpoint、恢复 | `src/helix-core.mjs` |
| 线性 workflow | 已完成 | 一键走 `plan -> execute -> verify -> scope -> review -> checkpoint` | `runWorkflow`、`runWorkflowNode` |
| Codex adapter | 已完成到“生成配置” | 生成 OMO-like lifecycle hooks，不直接改用户全局 Codex 配置 | `.helix/adapters/codex/hooks.json` |
| Cursor adapter | 已完成到“规则注入” | 用 `.cursor/rules/helixflow.mdc` 做规则层约束，阻断能力依赖 Cursor hook 能力 | `.cursor/rules/helixflow.mdc` |
| Hook 注入点 | 已完成主路径 | 对齐 OMO 的 `SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/PostCompact/Stop/SubagentStop` | `runInjectionHook`、`buildCodexHooksConfig` |
| PreToolUse 范围门 | 已完成 | 工具执行前阻断计划外写入，返回 OMO-compatible `permissionDecision=deny` | `preToolUseGuard` |
| 项目规则扫描 | 已完成基础版 | 扫描 `AGENTS.md/CLAUDE.md/CONTEXT.md/.omo/.cursor/.github` 等规则并注入 | `scanProjectRules` |
| 跨会话恢复 | 已完成基础版 | 写 `.helix/snapshots/context.md`、continuation 指令，降低 Codex 会话丢失风险 | `resumeReport`、`continuationDirective` |
| 小黑板/任务板 | 已完成轻量版 | 用 `.helix/team/*` 模拟 team message/task create/list/get/claim | `team_send_message`、`team_task_create` |
| Prompt pack | 已完成裁剪版 | 已有 10 个 Agent、28 个 Skill、55 个 Tool 合同 | `packs/omo-linear/manifest.json`、`tools/tool-contract.json` |
| 测试 | 已完成本轮验证 | 本轮 `npm test` 在本机权限环境下 `37/37` 通过；沙箱内唯一失败是 dashboard 测试绑定 `127.0.0.1` 的 `listen EPERM` | `test/helix-core.test.mjs` |
| npm pack dry-run | 已完成本轮验证 | `npm pack --dry-run --cache /private/tmp/helix-npm-cache` 通过，包体 48 个文件，约 85.9 kB | `package.json` |

## OMO 核心设计对照

| OMO 条目 | OMO 作用 | HelixFlow 当前状态 | 缺口/下一步 |
|---|---|---:|---|
| IntentGate | 判断用户意图，决定走普通响应、ultrawork、规划、检索等路径 | 部分实现 | `helix_route` 有关键词/类别路由，缺少更完整的 intent classifier 与真实模型辅助路由 |
| Sisyphus | 默认主编排器，规划、委派、推进任务直到完成 | 已移植为提示词与配置 | 还缺真实并发委派工具；当前只在线性 workflow 中承担总控语义 |
| Hephaestus | GPT-native 深度执行者，适合复杂编码/调试 | 已移植为 Agent 提示词 | 还未接真实 provider 自动启动 |
| Prometheus | 访谈式战略规划，写计划、澄清范围 | 已移植为 Agent 提示词 | 还缺 OMO 的交互式 `@plan`/Tab agent 切换体验 |
| Atlas | 读取计划、拆任务、委派 worker、累计智慧、验收 | 已移植为线性 orchestrator | 目前 Atlas 直接驱动线性节点，缺少真正 `task(category)` 子 Agent 分发 |
| Oracle | 只读架构顾问/复杂调试顾问 | 已移植为 Agent 提示词 | 缺少工具权限 enforcement：只读、不可编辑、不可委派需要 adapter 层补齐 |
| Librarian | 文档/OSS/多仓检索，提供证据 | 已移植为 Agent 提示词 | 缺少 web/docs provider 和跨 repo 搜索工具实装 |
| Explore | 快速代码库 grep/模式查找 | 已移植为 Agent 提示词 | `grep/glob` 仍是合同能力，未封装成独立 Agent runtime |
| Metis | 计划前 gap analyzer，抓隐藏意图/歧义/AI 失误点 | 已移植为 Agent 提示词 | 缺少强制进入规划循环的自动门 |
| Momus | ruthless reviewer，高精度计划审核 | 已移植为 Agent 提示词 | 缺少真实 LLM review provider 接入 |
| Sisyphus-Junior | category worker，专注执行，禁止再委派 | 部分替代 | 当前用 Hephaestus/Atlas worker 语义替代；后续需要独立 `junior` worker prompt 和工具权限 |
| Multimodal-Looker | 图片/PDF/图表分析 | 未实现 | 可后置；Codex/Cursor 均有不同视觉能力，适合放 adapter 层 |

## Prompt/提示词对照

| OMO 提示词来源 | OMO 作用 | HelixFlow 状态 | 下一步 |
|---|---|---:|---|
| `prompts/prometheus/default.md` | Prometheus 默认规划提示词 | 已裁剪移植 | 继续补齐 high-accuracy loop 的硬门槛 |
| `prompts/prometheus/gpt.md` | GPT 模型专用 Prometheus 变体 | 未单独保留 | 加 `modelVariants.prometheus.gpt` |
| `prompts/prometheus/gemini.md` | Gemini 模型专用 Prometheus 变体 | 未单独保留 | 加 `modelVariants.prometheus.gemini` |
| `prompts/atlas/default.md` | Atlas 默认执行编排提示词 | 已裁剪移植 | 补“必须委派/不得写代码”的硬权限说明 |
| `prompts/atlas/gpt.md` | GPT 模型专用 Atlas 变体 | 未单独保留 | 加模型变体 |
| `prompts/atlas/gemini.md` | Gemini 模型专用 Atlas 变体 | 未单独保留 | 加模型变体 |
| `prompts/atlas/kimi.md` | Kimi 模型专用 Atlas 变体 | 未单独保留 | 加模型变体 |
| `prompts/atlas/opus-4-7.md` | Claude Opus 专用 Atlas 变体 | 未单独保留 | 对 Codex/Cursor 非首要，可记录为参考 |
| `prompts/ultrawork/default.md` | `ulw/ultrawork` 自动干活模式 | 已裁剪为 `hf-run`、router、Sisyphus 语义 | 补完整 ultrawork trigger 和持续推进协议 |
| `prompts/ultrawork/gpt.md` | GPT 模型专用 ultrawork | 未单独保留 | 加模型变体 |
| `prompts/ultrawork/gemini.md` | Gemini 模型专用 ultrawork | 未单独保留 | 加模型变体 |
| `prompts/ultrawork/planner.md` | ultrawork 内部规划器 | 部分移植 | 合入 `Router/Sisyphus` 或独立 `ultrawork-planner` |
| `prompts/mode/search.md` | 搜索模式 | 部分移植 | 对齐 Explore/Librarian 的搜索协议 |
| `prompts/mode/analyze.md` | 分析模式 | 部分移植 | 对齐 Oracle/Metis |
| `prompts/mode/team.md` | Team mode | 未实现 | 多 Agent 并行阶段再搬 |
| `prompts/mode/hyperplan.md` | 深度计划模式 | 部分移植 | 与 Prometheus high-accuracy loop 合并 |

## Skill 对照

### HelixFlow 当前已有 Skill

| Skill | 作用 | 状态 |
|---|---|---:|
| `start-work` | 启动/恢复工作，决定从 plan 或现有任务继续 | 已实现 |
| `omo-injection-runtime` | 描述 hook 注入协议、配置、PreToolUse 阻断格式 | 已实现 |
| `hf-ideate` | 需求/方案发散 | 已实现 |
| `hf-spec` | 规格整理 | 已实现 |
| `hf-design` | 设计方案 | 已实现 |
| `hf-architect` | 架构决策 | 已实现 |
| `hf-plan` | 任务计划 | 已实现 |
| `hf-work` | 编码执行纪律 | 已实现 |
| `hf-review` | 复核纪律 | 已实现 |
| `hf-test` | 测试纪律 | 已实现 |
| `hf-deploy` | 发布/部署前检查 | 已实现 |
| `hf-recall` | 跨会话恢复 | 已实现 |
| `hf-compound` | 复合任务编排 | 已实现 |
| `hf-run` | 一键跑线性工作流 | 已实现 |
| `programming` | 通用编码规范 | 已实现 |
| `debugging` | 调试流程 | 已实现 |
| `refactor` | 重构流程 | 已实现 |
| `review-work` | 代码/方案审核 | 已实现 |
| `frontend-ui-ux` | 前端 UI/UX 规范 | 已实现 |
| `visual-qa` | 视觉验收 | 已实现 |
| `git-master` | Git 操作纪律 | 已实现 |
| `init-deep` | 深度初始化/摸底 | 已实现 |
| `lsp-setup` | LSP 诊断准备 | 已有提示词，缺真实 LSP daemon |
| `remove-ai-slops` | 去除 AI 味/冗余代码 | 已实现 |
| `ultraresearch` | 深度研究 | 已实现 |
| `lcx-contribute-bug-fix` | 上游贡献 bug fix 流程 | 已实现 |
| `lcx-doctor` | 本地诊断 | 已实现 |
| `lcx-report-bug` | bug 报告流程 | 已实现 |

### OMO 源码 Skill 缺口

| OMO Skill | 作用 | HelixFlow 状态 | 处理建议 |
|---|---|---:|---|
| `pre-publish-review` | 发布前复核包内容、版本、敏感文件、测试 | 未搬 | 必须补，NPM 发布前有价值 |
| `publish` | 发布流程指令 | 未搬 | 必须补，但要改成 HelixFlow npm 发布 |
| `github-triage` | GitHub issue/PR 分诊 | 未搬 | 中优先级，接 GitHub 后补 |
| `work-with-pr` | 围绕 PR 做计划、修改、验证、描述 | 未搬 | 中优先级，后续 GitHub 工作流需要 |
| `get-unpublished-changes` | 找本地未发布改动 | 未搬 | 高优先级，发布/验收前需要 |
| `hyperplan` | 深度规划模式 | 部分被 `hf-plan/Prometheus` 覆盖 | 建议补成独立 high-accuracy planning skill |
| `omomomo` | OMO 自身 orchestration/维护命令 | 未搬 | 只搬通用治理语义，不搬名字和 OpenCode 专属命令 |
| `opencode-qa` | OpenCode CLI/Server/TUI 质量验证 | 暂不搬 | 我们只适配 Codex/Cursor，后续若接 OpenCode 再搬 |
| `remove-deadcode` | 删除死代码 | 部分被 `refactor/remove-ai-slops` 覆盖 | 可补独立 skill |
| `security-research` | 安全研究/漏洞分析 | 未搬 | 可补，适合作为 `security` 动态 Agent skill |

## Tool 对照

### OMO OpenCode 工具目录

| OMO Tool 目录 | OMO 作用 | HelixFlow 状态 | 下一步 |
|---|---|---:|---|
| `delegate-task` | `task(category/subagent_type)`，按 category/model/fallback 创建子任务/子 Agent | 部分实现为合同 | 接真实 LLM provider 后实现 `codex_spawn_agent`/`cursor_spawn_agent` |
| `call-omo-agent` | 显式调用 OMO agent，支持同步/后台、会话复用、结果轮询 | 未实装 | 多 Agent 阶段核心任务 |
| `background-task` | 后台任务创建、取消、轮询、输出截断 | 未实装 | 多 Agent 并行前必须补 |
| `task` | 内部任务 create/list/get/update/todo sync | 部分实现 | `.helix/team/tasks.json` 已覆盖基础任务板，缺 todo sync |
| `skill` | Skill 发现、匹配、正文注入、优先级 | 部分实现 | 当前 prompt-pack 静态加载，缺 project/user/builtin 优先级和自动 matcher |
| `skill-mcp` | 读取 Skill frontmatter 里的 MCP 并按 session 隔离 | 未实装 | 重要，但可在 LLM provider 后补 |
| `grep` | 快速 grep，格式化搜索结果 | 合同已有，依赖宿主工具 | 可补 CLI 封装，优先级中 |
| `glob` | 文件枚举 | 合同已有，依赖宿主工具 | 可补 CLI 封装 |
| `hashline-edit` | 带 hash 的精确编辑，防误改/漂移 | 未搬 | Codex 已有 `apply_patch`，先不硬搬；后续可做安全编辑器 |
| `interactive-bash` | tmux 交互式 bash | 未搬 | 仅多 Agent/tmux 可视化需要 |
| `look-at` | 图片/PDF 多模态分析 | 未搬 | Codex/Cursor adapter 层分别适配 |
| `session-manager` | 管理 OpenCode session，支持 SDK/file fallback | 部分替代 | `.helix/sessions` 有恢复状态，但无宿主 session SDK |
| `slashcommand` | 发现/执行 slash command | 部分替代 | CLI 有命令；宿主内 slash command 体验未做 |

### HelixFlow 当前 Tool 合同

| Tool | 作用 | 实装状态 |
|---|---|---:|
| `helix_init` | 初始化 `.helix` 运行时 | 已实装 |
| `helix_config` | 读写模型、Agent、注入点配置 | 已实装 |
| `helix_injection_show` | 调试某注入点最终上下文 | 已实装 |
| `helix_hook_run` | Codex/Cursor hook 入口 | 已实装 |
| `helix_adapter_install` | 生成 Codex/Cursor adapter 配置 | 已实装 |
| `pre_tool_use_guard` | 工具执行前范围阻断 | 已实装 |
| `helix_resume` | 恢复会话上下文 | 已实装 |
| `helix_continuation_check` | Stop/SubagentStop 时提示续跑 | 已实装 |
| `helix_rules_collect` | 收集项目规则 | 已实装 |
| `helix_context_build` | 构建单 Agent 上下文包 | 已实装 |
| `helix_snapshot_write` | 写可恢复快照 | 已实装 |
| `helix_plan_import` | 导入计划 | 已实装 |
| `plan_validate` | 校验计划 DAG/任务字段 | 已实装 |
| `helix_run_next` | 执行下一个任务 | 已实装 |
| `helix_workflow` | 一键跑线性闭环 | 已实装 |
| `helix_node` | 单节点执行/测试 | 已实装 |
| `helix_serve` | 本地 dashboard | 已实装 |
| `helix_status` | 查看状态 | 已实装 |
| `helix_summary` | 生成 workflow 总结 | 已实装 |
| `helix_route` | 路由用户请求 | 已实装基础版 |
| `scope_guard` | checkpoint 前范围门 | 已实装 |
| `change_request_list` | 列变更请求 | 已实装 |
| `change_request_review` | 审核变更请求 | 已实装确定性版 |
| `change_request_resolve` | 接受/拒绝变更请求 | 已实装 |
| `helix_steer` | 动态加任务/拆任务/调整验收 | 已实装 |
| `helix_evidence_record` | 记录 criterion 证据 | 已实装 |
| `helix_review_blocker_record` | 记录 review blocker 并派生任务 | 已实装 |
| `review_gate` | 多 lane 复核 | 已实装确定性版，缺 LLM provider |
| `test_gate` | 任务必须有 verifier | 已实装 |
| `comment_check` | 注释质量检查 | 合同已有，真实 checker 缺 |
| `wisdom_append` | 累计智慧 | 已实装基础版 |
| `grep_search` | 文本搜索 | 合同已有 |
| `glob_search` | 文件枚举 | 合同已有 |
| `ast_grep_search` | 结构化搜索 | 合同已有 |
| `ast_grep_replace_dry_run` | 结构化替换预演 | 合同已有 |
| `lsp_diagnostics` | LSP 诊断 | 合同已有，daemon 缺 |
| `lsp_references` | 引用查询 | 合同已有，daemon 缺 |
| `lsp_rename` | LSP 重命名 | 合同已有，daemon 缺 |
| `git_status` | 工作区状态 | 合同已有，依赖宿主 git |
| `git_diff` | 差异证据 | 合同已有，运行时已有部分 diff 收集 |
| `git_checkpoint` | 可追溯 checkpoint | 部分实现 |
| `worktree_create` | 并行任务隔离 worktree | 合同已有，未启用 |
| `merge_admit` | worktree 合并准入 | 合同已有，未实装 |
| `team_task_create` | 创建小黑板任务 | 已实装 |
| `team_task_update` | 认领/更新任务 | 部分实装为 claim |
| `team_task_list` | 列任务 | 已实装 |
| `team_task_get` | 查单任务 | 已实装 |
| `team_send_message` | 文件消息板 | 已实装 |
| `team_read_inbox` | 读 inbox | 已实装 |
| `prompt_list` | 列 prompt pack | 已实装 |
| `prompt_show` | 展示 Agent prompt | 已实装 |
| `skill_show` | 展示 Skill | 已实装 |
| `codex_spawn_agent` | Codex 子 Agent 启动 | 合同已有，未实装 |
| `cursor_rule_sync` | Cursor 规则同步 | 部分实现 |
| `mcp_register` | 注册 MCP | 合同已有，未实装 |

## Hook/运行时组件对照

| OMO 组件 | OMO hook | OMO 作用 | HelixFlow 状态 | 缺口 |
|---|---|---|---:|---|
| `rules` | `SessionStart/UserPromptSubmit/PostToolUse/PostCompact` | 静态/动态项目规则注入、compact 后恢复、缓存与预算 | 部分实现 | 缺 context pressure、动态指纹、transcript rule filter、持久 cache 细节 |
| `ultrawork` | `UserPromptSubmit` | 检测 `ulw/ultrawork`，注入自动工作指令 | 部分实现 | 当前是路由/skill 语义，缺精确 trigger 行为 |
| `ulw-loop` | `UserPromptSubmit/PreToolUse(create_goal)` | 目标循环、预算限制、防止 create_goal 被滥用 | 部分实现 | 已阻断 create_goal 额外字段，缺完整 goal checkpoint/steering 语义 |
| `start-work-continuation` | `Stop/SubagentStop` | 会话停止前检查未完成任务，注入继续指令 | 已实现基础版 | 缺和真实宿主会话/子 Agent 停止事件的深度绑定 |
| `lsp` | `PostToolUse/PostCompact` | 编辑后自动跑 LSP diagnostics，compact 后清缓存 | 合同已有 | 缺 daemon 和真实 diagnostics gate |
| `comment-checker` | `PostToolUse` | 检查新增注释是否空泛/AI 味/无价值 | 合同已有 | 缺 checker 实现 |
| `git-bash` | `PreToolUse(Bash)/PostCompact` | Windows Git Bash MCP 提醒 | 暂不搬 | Codex/Cursor macOS 优先级低；Windows adapter 后补 |
| `telemetry` | `SessionStart` | 记录使用与诊断 | 未实现 | 先不做，涉及隐私/产品策略 |
| `auto-update` | `SessionStart(startup)` | 启动时检查更新 | 未实现 | npm 包稳定后再补 |

## 配置/模型能力对照

| OMO 能力 | 作用 | HelixFlow 状态 | 下一步 |
|---|---|---:|---|
| `agents` 配置 | 按 Agent 覆盖 model/prompt/tools/permission | 部分实现 | 已有 `helix.config.json.agents`，缺权限 enforcement 和 prompt_append |
| `categories` 配置 | 用语义类别选模型，隐藏模型名 | 部分实现 | 已有 `dynamicAgents`，缺完整 fallback_models/variant/tools |
| fallback chain | provider/model 失败时自动换模型 | 未实现 | 接 provider 后补 |
| provider config | 读取 API key/base URL/model 参数 | 部分实现 | 用户补 API 后接真实 call |
| permission model | agent 级 deny/ask/allow 工具权限 | 未实现 | adapter 层必须补，否则角色边界靠 prompt |
| background concurrency | 控制并行子 Agent 数量 | 未实现 | 多 Agent 阶段补 |
| skill priority | `project > opencode > user > builtin` | 未实现 | 改为 `project > workspace > user > builtin`，适配 Codex/Cursor |
| skill-embedded MCP | skill 自带 MCP，按 session 隔离 | 未实现 | LLM provider 后补 |

## 优先级建议

| 优先级 | 模块 | 为什么先做 |
|---:|---|---|
| P0 | 真实 LLM review provider | 没有它，Momus/Metis/Oracle 只能是提示词语义，不能形成“质疑式验收” |
| P0 | LSP diagnostics gate | OMO 的实际质量提升很大一部分来自编辑后自动诊断 |
| P0 | comment checker | 对小团队治理有直接价值，能阻断 AI 味和低质量注释 |
| P0 | adapter 真安装/卸载/备份 | 用户装插件时不能只生成配置，必须有可撤销安装流程 |
| P1 | prompt model variants | 让 GPT/Kimi/Gemini 各吃各的提示词，接近 OMO 原效果 |
| P1 | publish/pre-publish/get-unpublished skills | npm 发布前需要，且能提高交付安全 |
| P1 | `codex_spawn_agent` 最小实现 | 先跑“简单上下文子 Agent”，再进入并行集群 |
| P2 | background task/session manager | 多 Agent 并行必需，但在线性 90% 目标后做 |
| P2 | skill matcher + skill MCP | 提升自动装载效果，降低手动配置 |
| P3 | tmux/cmux/OpenClaw/telemetry/auto-update | 更像 OMO，但不是当前 Codex/Cursor 线性治理的必要条件 |

## NPM 组织结论

不一定必须注册组织，取决于包名策略：

| 发布方式 | 是否需要你注册组织 | 用户安装入口 | 适合场景 |
|---|---:|---|---|
| unscoped 包：`helixflow` | 不需要组织，只需要 npm 账号 | `npx helixflow@latest init` | 包名未被占用、个人项目快速发布 |
| user-scoped 包：`@你的npm用户名/helixflow` | 不需要组织，只需要 npm 账号 | `npx @你的npm用户名/helixflow@latest init` | 包名被占用，或先用个人账号发版 |
| org-scoped 包：`@组织名/helixflow` | 需要你先在 npm 创建组织 | `npx @组织名/helixflow@latest init` | 未来多人维护、品牌化、权限分工 |

建议：如果这是要给小团队长期使用的治理插件，最好注册一个 npm organization，然后发 `@组织名/helixflow`。原因很简单：包名像门牌号，先挂在个人名下能用，但以后迁移组织会牵涉用户入口变化；一开始放组织 scope，权限和品牌更稳。

发布前硬门槛：

1. 用 npm registry 确认 `helixflow` 是否已被占用。
2. 决定 scope：`helixflow`、`@boyanliu/helixflow`、或 `@组织名/helixflow`。
3. 修改 `package.json.name`。
4. 跑 `npm test`、`npm pack --dry-run`。
5. scoped public package 发布时使用 `npm publish --access public`。

## 证据来源

- OMO 源码 hook：`/private/tmp/oh-my-openagent-src/packages/omo-codex/plugin/hooks/hooks.json`
- OMO Codex components：`/private/tmp/oh-my-openagent-src/packages/omo-codex/plugin/components/*`
- OMO orchestration docs：`/private/tmp/oh-my-openagent-src/docs/guide/orchestration.md`
- OMO feature docs：`/private/tmp/oh-my-openagent-src/docs/reference/features.md`
- OMO config docs：`/private/tmp/oh-my-openagent-src/docs/reference/configuration.md`
- OMO prompt core：`/private/tmp/oh-my-openagent-src/packages/prompts-core/prompts/*`
- OMO OpenCode tools：`/private/tmp/oh-my-openagent-src/packages/omo-opencode/src/tools/*`
- HelixFlow runtime：`/Users/boyanliu/Documents/Development/文档规范/工作范式/src/helix-core.mjs`
- HelixFlow CLI：`/Users/boyanliu/Documents/Development/文档规范/工作范式/bin/helix.mjs`
- HelixFlow prompt pack：`/Users/boyanliu/Documents/Development/文档规范/工作范式/packs/omo-linear`
- npm scoped package 官方文档：`https://docs.npmjs.com/creating-and-publishing-scoped-public-packages`
- npm organization 官方文档：`https://docs.npmjs.com/creating-an-organization`
