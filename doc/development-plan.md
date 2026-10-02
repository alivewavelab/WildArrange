# WildArrange 开发计划

> 只记录尚未完成的路线与状态，不替代当前架构事实。架构真相见根 `AGENTS.md` 与 [project-architecture.md](./project-architecture.md)；已完成事项以 Git 历史为准。

## 下一步

- 路由写入的 `task.skills` 进入执行前预算化加载器。`PARTIAL: before_execute 已接通；review/checkpoint 尚未接通`

## 多 Agent 运行时

- 实现 `codex_spawn_agent` 最小可行子 Agent 调用。`PARTIAL: host-neutral Codex/Cursor command-template spawn exists; host-private background agent API remains adapter work`
- 加入 Skill MCP 支持。`PARTIAL: skill/tool contracts are installable and matchable; external MCP server lifecycle remains adapter work`
- 加入项目 Agent Pack 支持，用于 GameYo 等垂直生产工作流：项目定义的阶段 worker、阶段循环、必需输出、可写路径与 gate 绑定；ProducerAgent 与治理 gate 仍由 WildArrange 拥有。`TODO`

## 暂缓

- decisions/ledger 日志轮转。`DEFERRED: experience/scale, not a completion-gate blocker`
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
