# 节点 02 · 隔离 (R1.2 / R1.3)
- 类型：独立调用
- 输入：task id + profile
- 输出：隔离工作区
- 逻辑：light → `git worktree add .worktrees/<task> -b task/<task>`（多副本物理隔离）；heavy → 单副本 + `git switch -c task/<task>`（不多开副本，省 Library 重建）
- 触发：hf-work 开始一个任务 / 关键词 `isolate`
- 工具/MCP：vault-server.isolate（计划）
- 参考实现：opencode-worktree-session（session→建隔离 worktree→禁 main 分支）
