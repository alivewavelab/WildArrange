<!-- 由 `node ./bin/wildarrange.mjs docs commands --write` 从 src/interface/cli-help.mjs 生成，请勿手改 -->

| 命令 | 说明 |
| ---- | ---- |
| `wildarrange setup --governance-root <path> [--repository <git-url>] [--target codex|cursor|kimi|all] [--default-branch main]` | 一步接入外置治理：创建治理仓（含 Git 初始提交与默认武装配置）→ attach → init → 生成宿主 Adapter 包；客户项目零写入 |
| `wildarrange project init-governance --governance-root <path> --repository <git-url> [--default-branch main]` | 在项目外创建不覆盖已有文件的治理仓库骨架与默认武装配置；非 Git 目录自动 git init 并提交初始 commit |
| `wildarrange project attach --governance-root <path> [--project-root <path>] [--runtime-root <path>]` | 把客户项目连接到独立治理仓库；映射写入项目外部状态目录 |
| `wildarrange project show [--project-root <path>]` | 查看项目、治理仓库和运行态三根连接 |
| `wildarrange integration accept --project-sha <40-char-sha> --governance-sha <40-char-sha> [--id <id>] [--reason "..."]` | 校验两个仓库的提交与治理注册表，并在项目外运行态写双 SHA 集成验收收据 |
| `wildarrange review configure --from <setup.json> [--apply]` | 预览项目审查与执行准备配置；明确确认后 --apply，只能更新治理配置 |
| `wildarrange review checklist --task <taskId>` | 解析本任务项目审查清单和必需依据，不启动执行器 |
| `wildarrange readiness --task <taskId>` | 检查已批准任务必需的执行器、Skill、规范与握手，不启动业务 Worker |
| `wildarrange adoption inventory` | 只读扫描旧仓库文件与验证资产，供接管 Skill 建立来源映射 |
| `wildarrange init [--sample]` | 在已连接项目的 runtimeRoot 初始化运行态（setup 已包含此步骤）；不写客户仓库 |
| `wildarrange plan --from <plan.json>` | 导入含 responsibilityChanges 的计划；等待人工确认职责与事实归属 |
| `wildarrange plan approve [--plan <planId>]` | 确认待执行计划（语义生成计划或已开启 planApproval） |
| `wildarrange run` | 跑下一个任务（worker→verifier→scope→review→checkpoint） |
| `wildarrange status` | 查看状态（含门武装黄灯） |
| `wildarrange decisions [--limit N] [--task T001] [--gate pre_tool_use] [--annotatable] [--format json]` | 查看门决策记录（每一次拦截/放行；--annotatable 只看可标注队列） |
| `wildarrange doctor` | 一键体检：配置/完成状态/ledger/备份对账 |
| `wildarrange config init [--force] [--armed]` | 在治理仓 policy/ 生成默认配置（--armed 直接武装质量门） |
| `wildarrange config show` | 查看生效配置 |
| `wildarrange config baseline [--reason "..."]` | 写入 config hash 基线 |
| `wildarrange config verify` | 校验 config 基线 |
| `wildarrange adapter install [--target codex|cursor|kimi|all] [--mode local|npx] [--package @alivewavelab/wildarrange]` | 在 runtimeRoot 生成宿主外置插件包；--mode 选择 hook 调用 CLI 的前缀（local 当前 bin 路径 / npx 包名） |
| `wildarrange adapter activate [--target cursor|codex|all] [--user-root <path>]` | 显式写入用户级配置：Cursor Hook 与指针规则、Codex AGENTS.md 指针段；先备份且不写客户项目 |
| `wildarrange adapter uninstall [--target codex|cursor|kimi|all]` | 卸载宿主 adapter：移除用户级条目与指针并删除 runtime 插件包 |
| `wildarrange adapter restore --backup <backupId>` | 恢复 adapter 备份：还原到该次 activate 之前的用户级文件 |
| `wildarrange injection show --point before_review [--agent BaiZe] [--task T001] [--text "..."] [--stage plan]` | 查看注入点解析结果 |
| `wildarrange hook run [--from hook.json] [--format text|json] --adapter-digest <sha256>` | 运行宿主生命周期 Hook；只处理已连接项目，未连接项目静默放行 |
| `wildarrange workflow --from <plan.json>` | 从计划跑完整 workflow |
| `wildarrange workflow --sample` | 跑样例 workflow |
| `wildarrange parallel run [--max-agents 2] [--task T001,T002] [--agent ZhuRong] [--adapter codex|cursor] [--isolation run-dir|git-worktree] [--command "..."]` | 跑并行子 Agent |
| `wildarrange parallel admit --run <runId> --task T001` | 合入子 Agent 成果（admission 事务） |
| `wildarrange parallel list` | 列出并行 run |
| `wildarrange parallel status [--run <runId>]` | 查看并行运行记录与批次对账 |
| `wildarrange parallel close --run <runId> [--task T001] [--reason "..."]` | 关闭保留的子 Agent 结果 |
| `wildarrange parallel cleanup --run <runId>` | 清理 Git worktree 隔离目录 |
| `wildarrange parallel retry --run <runId> [--command "..."] [--max-agents N]` | 只重跑未完成任务的局部重试 |
| `wildarrange node route --text "request"` | 单节点：路由 |
| `wildarrange node execute [--task T001]` | 单节点：执行 |
| `wildarrange node checkpoint [--task T001]` | 单节点：checkpoint |
| `wildarrange node retry [--task T001]` | 单节点：重试 |
| `wildarrange resume [--session <id>]` | 恢复会话上下文 |
| `wildarrange continuation check [--session <id>]` | 检查会话延续 |
| `wildarrange summary` | 生成 workflow 总结 |
| `wildarrange rules collect [--target src/app.js]` | 收集项目规则上下文 |
| `wildarrange governance audit [--changed-only] [--force]` | 仓库治理检查 |
| `wildarrange contracts scan [--from <contract-changes.json>]` | 扫描 Tauri IPC 契约并生成待审核差异卡 |
| `wildarrange contracts apply-card --card <id> --decision approve|reject --reason "..." --expected-fingerprint <sha256>` | 由开发者批准或拒绝当前契约差异卡 |
| `wildarrange contracts generate` | 从已批准契约台账生成人类可读总图 |
| `wildarrange contracts propose --task <id> --from <proposal.json>` | 提出计划外接口或数据库变更，暂停任务等待人类决定 |
| `wildarrange contracts resolve --id <id> --decision accept|reject --expected-fingerprint <sha256> --reason "..."` | 按当前变更内容记录人类决定，批准后重新验收 |
| `wildarrange context build [--agent Jiuwei] [--task T001] [--plan <planId>] [--point before_execute]` | 构建指定计划与注入点的 Agent 上下文 |
| `wildarrange evidence record --task T001 --criterion C001 --status pass --evidence "..."` | 回填成功判据证据 |
| `wildarrange steer --from <proposal.json>` | 任务变更治理入口 |
| `wildarrange review-blockers record --from <blocker.json>` | 登记 Review Blocker |
| `wildarrange task list [--all] [--status draft|pending|completed] [--type feature|bug|acceptance_correction|maintenance] [--priority P0|P1|P2] [--owner Jiuwei] [--plan <planId>] [--search "text"]` | 列出当前计划或全项目工单 |
| `wildarrange task get --task T001 [--plan <planId>]` | 查看单个任务与历史 |
| `wildarrange task claim [--task T001] [--owner Jiuwei]` | 认领任务 |
| `wildarrange task create --title "修复登录失败" [--type bug] [--priority P1] [--source user] [--parent <taskRef>] [--writable src/**] [--verify "npm test"] [--review "npm test"]` | 创建工单；验证信息不足时先进入 draft |
| `wildarrange task create --from <task.json>` | 从 JSON 创建工单 |
| `wildarrange task ready --task T001 --from <task-details.json> [--plan <planId>]` | 补齐 draft 并转为可执行 pending |
| `wildarrange task archive --task T001 [--plan <planId>] --delete [--reason "..."]` | 备份后写 ledger 墓碑，并删除非运行中任务及其专属运行态文件 |
| `wildarrange team send --to Jiuwei --from Jiuwei --body "..."` | 发送团队消息 |
| `wildarrange team inbox [--agent Jiuwei]` | 查看团队收件箱 |
| `wildarrange changes list` | 列出 ChangeRequest |
| `wildarrange changes review --id CR-xxxx` | 查看 ChangeRequest |
| `wildarrange changes resolve --id CR-xxxx --decision accept|reject --evidence "..." --rationale "..." [--apply-scope]` | 裁决 ChangeRequest |
| `wildarrange ledger verify` | 校验 ledger hash 链 |
| `wildarrange impact <changed-file...>` | 改动影响面分析（反向依赖闭包） |
| `wildarrange decisions stats` | 门触发统计：计数/从未触发的门/标注关联 |
| `wildarrange timeline [--limit N] [--task T001] [--source ledger|decision|annotation] [--format json]` | ledger+决策+标注统一时间线 |
| `wildarrange annotate --decision <decisionId> --category <confirmed|rule_wrong|case_wrong|mislabeled> [--reason "..."] [--author name]` | 标注门决策（只进报告，不改配置） |
| `wildarrange annotate list [--limit N]` | 列出标注 |
| `wildarrange annotate stats` | 标注聚合统计 |
| `wildarrange test [--zone interface|orchestration|ai|capabilities|infra] [changed-file...]` | 分区/影响面最小测试集 |
| `wildarrange docs commands [--write]` | 从命令注册表生成命令文档（单一事实源） |
| `wildarrange state backup [--reason "..."]` | 备份运行态关键文件 |
| `wildarrange state verify` | 校验运行态关键文件 |
| `wildarrange state list` | 列出运行态备份 |
| `wildarrange state restore --backup <backupId>` | 恢复运行态备份 |
| `wildarrange serve [--host 127.0.0.1] [--port 8765] [--token <token>]` | 启动本地 dashboard（默认仅 loopback） |
| `wildarrange adoption start [--host 127.0.0.1] [--port 8765] [--token <token>]` | 只读扫描老项目验证资产并打开 Dashboard 逐卡批准 |
| `wildarrange adoption status [--session <sessionId>]` | 只读对账接管会话、待决策/过期卡和新鲜度黄灯 |
| `wildarrange adoption resume [--session <sessionId>] [--host 127.0.0.1] [--port 8765] [--token <token>]` | 按磁盘事实恢复接管会话；不安全时只显示 recovery_required |
| `wildarrange adoption recover [--session <sessionId>]` | 重试恢复失败事务的 preimage，成功后释放维护锁 |
| `wildarrange guard scope [--task T001]` | 校验任务范围 |
| `wildarrange route --text "request"` | 请求路由 |
| `wildarrange prompts list` | 列出提示词 |
| `wildarrange prompts show --agent Jiuwei` | 查看 Agent 提示词 |
| `wildarrange prompts show --skill review-work` | 查看 Skill 提示词 |
| `wildarrange skills match --text "request" [--stage plan] [--agent Jiuwei] [--limit 6]` | 匹配 Skill |
| `wildarrange prompts show --tools` | 查看工具合同 |
| `wildarrange prompts show --routes` | 查看路由表 |
