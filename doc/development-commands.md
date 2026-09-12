# WildArrange 开发命令

> 本文保留原根 AGENTS 的常用命令。命令从仓库根执行；先按根入口读取相关执行边界。完整 CLI 用法以 `node ./bin/wildarrange.mjs --help --all` 为准；表内 `/private/tmp/` 是原有 macOS 缓存路径示例，其他系统应使用本机可写的临时缓存目录。

## 常用命令


| 场景                | 命令                                                               |
| ----------------- | ---------------------------------------------------------------- |
| 初始化运行时            | `node ./bin/wildarrange.mjs init`                                      |
| 生成默认配置            | `node ./bin/wildarrange.mjs config init --root`（`--armed` 直接武装质量门） |
| 登记当前设备            | `node ./bin/wildarrange.mjs device register --name macbook`             |
| 查看 Git 协调状态       | `node ./bin/wildarrange.mjs coordination status`                        |
| 显式远端领取任务        | `node ./bin/wildarrange.mjs coordination claim --task T001 --owner ZhuRong` |
| 准备跨设备交接          | `node ./bin/wildarrange.mjs handoff prepare --task T001 --to-device-id <uuid> --to-device-name mac-mini` |
| 推送跨设备交接          | `node ./bin/wildarrange.mjs handoff push --task T001`                    |
| 接受跨设备交接          | `node ./bin/wildarrange.mjs handoff accept --plan <planId> --task T001`  |
| 安装 adapter        | `node ./bin/wildarrange.mjs adapter install --target all --mode local` |
| 卸载 adapter        | `node ./bin/wildarrange.mjs adapter uninstall --target all`            |
| 恢复 adapter        | `node ./bin/wildarrange.mjs adapter restore --backup <backupId>`       |
| 导入计划              | `node ./bin/wildarrange.mjs plan --from plan.json`                     |
| 跑下一个任务            | `node ./bin/wildarrange.mjs run`                                       |
| 跑 sample workflow | `node ./bin/wildarrange.mjs workflow --sample`                         |
| 跑并行子 Agent       | `node ./bin/wildarrange.mjs parallel run --max-agents 2 --command "..."` |
| 用 worktree 跑子 Agent | `node ./bin/wildarrange.mjs parallel run --task T001 --isolation git-worktree --command "..."` |
| 合入子 Agent 成果     | `node ./bin/wildarrange.mjs parallel admit --run <runId> --task T001`     |
| 查看并行运行记录        | `node ./bin/wildarrange.mjs parallel status --run <runId>`             |
| 关闭保留的子 Agent 结果 | `node ./bin/wildarrange.mjs parallel close --run <runId> --task T001 --reason user_accepted` |
| 清理 Git worktree 隔离目录 | `node ./bin/wildarrange.mjs parallel cleanup --run <runId>` |
| 重跑 run 中未通过的任务 | `node ./bin/wildarrange.mjs parallel retry --run <runId> [--command "..."]` |
| 标注一条决策 | `node ./bin/wildarrange.mjs annotate --decision <decisionId> --category rule_wrong --reason "..."` |
| 查看标注与统计 | `node ./bin/wildarrange.mjs annotate list` / `annotate stats` |
| 门触发统计审查 | `node ./bin/wildarrange.mjs decisions stats` |
| 统一时间线 | `node ./bin/wildarrange.mjs timeline [--limit N] [--task T001]` |
| LLM 可疑判断（异步审查） | `node ./bin/wildarrange.mjs review suspicious` |
| 全量命令 / 物化命令文档 | `node ./bin/wildarrange.mjs --help --all` / `docs commands --write` |
| 匹配 Skill          | `node ./bin/wildarrange.mjs skills match --text "..." --stage plan`    |
| 仓库治理检查           | `node ./bin/wildarrange.mjs governance audit` |
| 生成档案路由包         | `node ./bin/wildarrange.mjs archivist packet --text "..." --stage plan` |
| 运行档案路由员         | `node ./bin/wildarrange.mjs archivist run --text "..." --stage plan --force` |
| 查看路由建议           | `node ./bin/wildarrange.mjs archivist suggestions list`                 |
| 审核路由建议           | `node ./bin/wildarrange.mjs archivist suggestions resolve --id <id> --decision accept --evidence "..." --rationale "..."` |
| 查看状态              | `node ./bin/wildarrange.mjs status`                                    |
| 写入 config 基线      | `node ./bin/wildarrange.mjs config baseline --reason reviewed`          |
| 校验 config 基线      | `node ./bin/wildarrange.mjs config verify`                              |
| 校验 ledger hash 链   | `node ./bin/wildarrange.mjs ledger verify`                             |
| 改动影响分析 | `node ./bin/wildarrange.mjs impact src/infra/ledger.mjs` |
| 查看决策投影 | `node ./bin/wildarrange.mjs decisions --limit 20` |
| 分区/影响面测试 | `node ./bin/wildarrange.mjs test --zone infra` |
| 备份运行态关键文件      | `node ./bin/wildarrange.mjs state backup --reason before-risky-agent`   |
| 迁移旧运行态           | `node ./bin/wildarrange.mjs state migrate`（自动先备份；旧 completed 无当前 proof 时回到待决策） |
| 归档并删除旧任务        | `node ./bin/wildarrange.mjs task archive --task T001 [--plan <planId>] --delete --reason "obsolete"` |
| 校验运行态关键文件      | `node ./bin/wildarrange.mjs state verify`                               |
| 列出运行态备份        | `node ./bin/wildarrange.mjs state list`                                 |
| 恢复运行态备份        | `node ./bin/wildarrange.mjs state restore --backup <backupId>`          |
| 一键体检            | `node ./bin/wildarrange.mjs doctor`                                     |
| 老项目验证治理接管    | `node ./bin/wildarrange.mjs adoption start` / `status` / `resume` |
| 生成总结              | `node ./bin/wildarrange.mjs summary`                                   |
| 启动本地 dashboard    | `node ./bin/wildarrange.mjs serve --host 127.0.0.1 --port 8765`        |
| 完整测试              | `npm test`                                                       |
| npm 包体预检          | `npm pack --dry-run --cache /private/tmp/wildarrange-npm-cache`        |
