<!-- 由 `node ./bin/wildarrange.mjs docs commands --write` 从 src/interface/cli-help.mjs 生成，请勿手改 -->

| 命令 | 说明 |
| ---- | ---- |
| `wildarrange init [--sample] [--project-docs] [--architecture]` | 初始化运行时；显式补建项目治理文档，可按需包含架构模板 |
| `wildarrange plan --from <plan.json>` | 导入计划并生成任务状态 |
| `wildarrange plan approve [--plan <planId>]` | 确认已导入计划（开启 planApproval 时才能 run） |
| `wildarrange run` | 跑下一个任务（worker→verifier→scope→review→checkpoint） |
| `wildarrange status` | 查看状态（含门武装黄灯） |
| `wildarrange decisions [--limit N] [--task T001] [--gate pre_tool_use] [--annotatable] [--format json]` | 查看门决策记录（每一次拦截/放行；--annotatable 只看可标注队列） |
| `wildarrange doctor` | 一键体检：配置/完成状态/ledger/备份对账 |
| `wildarrange config init [--root] [--force] [--armed]` | 生成默认配置（--armed 直接武装质量门） |
| `wildarrange config show` | 查看生效配置 |
| `wildarrange config baseline [--reason "..."]` | 写入 config hash 基线 |
| `wildarrange config verify` | 校验 config 基线 |
| `wildarrange device register [--name macbook] [--force]` | 登记当前设备 |
| `wildarrange device status` | 查看设备登记状态 |
| `wildarrange coordination status` | 查看 Git 协调状态 |
| `wildarrange coordination claim --task T001 [--owner ZhuRong]` | 显式远端领取任务 |
| `wildarrange handoff prepare --task T001 --to-device-id <uuid> [--to-device-name mac-mini] [--to-owner ZhuRong]` | 准备跨设备交接 |
| `wildarrange handoff push --task T001` | 推送跨设备交接 |
| `wildarrange handoff accept --task T001 [--plan P20260731]` | 接受跨设备交接 |
| `wildarrange handoff takeover --plan P20260731 --task T001 --expected-device-id <uuid> --reason "owner offline"` | 显式接管（记录预期旧设备与理由） |
| `wildarrange adapter install [--target codex|cursor|kimi|all] [--mode local|npx] [--package @alivewavelab/wildarrange]` | 安装宿主 adapter |
| `wildarrange adapter uninstall [--target codex|cursor|kimi|all]` | 卸载宿主 adapter |
| `wildarrange adapter restore --backup <backupId>` | 恢复 adapter 备份 |
| `wildarrange injection show --point before_review [--agent BaiZe] [--task T001] [--text "..."] [--stage plan]` | 查看注入点解析结果 |
| `wildarrange hook run [--from hook.json] [--format text|json]` | 运行宿主生命周期 Hook |
| `wildarrange workflow --from <plan.json>` | 从计划跑完整 workflow |
| `wildarrange workflow --sample` | 跑样例 workflow |
| `wildarrange parallel run [--max-agents 2] [--task T001,T002] [--agent ZhuRong] [--adapter codex|cursor] [--isolation run-dir|git-worktree] [--coordinate] [--command "..."]` | 跑并行子 Agent |
| `wildarrange parallel admit --run <runId> --task T001` | 合入子 Agent 成果（admission 事务） |
| `wildarrange parallel list` | 列出并行 run |
| `wildarrange parallel status [--run <runId>]` | 查看并行运行记录与批次对账 |
| `wildarrange parallel close --run <runId> [--task T001] [--reason "..."]` | 关闭保留的子 Agent 结果 |
| `wildarrange parallel cleanup --run <runId>` | 清理 Git worktree 隔离目录 |
| `wildarrange parallel retry --run <runId> [--command "..."] [--max-agents N]` | 只重跑未完成任务的局部重试 |
| `wildarrange archivist packet [--text "..."] [--stage plan] [--turns turns.json]` | 生成档案路由包 |
| `wildarrange archivist run [--text "..."] [--stage plan] [--turns turns.json] [--force]` | 运行档案路由员 |
| `wildarrange archivist suggestions list` | 查看路由建议 |
| `wildarrange archivist suggestions resolve --id <id> --decision accept|reject --evidence "..." --rationale "..."` | 审核路由建议 |
| `wildarrange node route --text "request"` | 单节点：路由 |
| `wildarrange node execute [--task T001]` | 单节点：执行 |
| `wildarrange node verify [--task T001]` | 单节点：验证 |
| `wildarrange node scope [--task T001]` | 单节点：范围检查 |
| `wildarrange node review [--task T001]` | 单节点：复核 |
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
| `wildarrange review suspicious [--limit N]` | LLM 可疑判断异步审查（只进报告，不进完成链） |
| `wildarrange test [--zone interface|orchestration|ai|capabilities|infra] [changed-file...]` | 分区/影响面最小测试集 |
| `wildarrange docs commands [--write]` | 从命令注册表生成命令文档（单一事实源） |
| `wildarrange state backup [--reason "..."]` | 备份运行态关键文件 |
| `wildarrange state migrate` | 备份后迁移运行态任务总账与旧投影；不改根 wildarrange.config.json |
| `wildarrange state verify` | 校验运行态关键文件 |
| `wildarrange state list` | 列出运行态备份 |
| `wildarrange state restore --backup <backupId>` | 恢复运行态备份 |
| `wildarrange serve [--host 127.0.0.1] [--port 8765] [--token <token>]` | 启动本地 dashboard（默认仅 loopback） |
| `wildarrange guard scope [--task T001]` | 校验任务范围 |
| `wildarrange route --text "request"` | 请求路由 |
| `wildarrange prompts list` | 列出提示词 |
| `wildarrange prompts show --agent Jiuwei` | 查看 Agent 提示词 |
| `wildarrange prompts show --skill review-work` | 查看 Skill 提示词 |
| `wildarrange skills match --text "request" [--stage plan] [--agent Jiuwei] [--limit 6]` | 匹配 Skill |
| `wildarrange prompts show --tools` | 查看工具合同 |
| `wildarrange prompts show --routes` | 查看路由表 |
