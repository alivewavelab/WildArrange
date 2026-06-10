# 节点 05 · 一键恢复 (R4)
- 类型：CLI + MCP tool（保证 agent-native 对等）
- 输入：（无）/ 指定 snapshot|task
- 输出：在途工作总览；一步还原任意在途状态（目标 <1min）
- 触发：用户 `helix vault` / `helix restore <id>`；或 Agent 会话内调 MCP
- 逻辑：列出所有 in-flight 任务/分支/shadow 快照及归属（借 oh-my-claudecode 的 agent-replay jsonl：每任务记 {session_id,branch,worktree,start_commit}）→ 按记录 checkout
- 工具/MCP：CLI `helix vault|restore` + vault-server.list/restore（计划）
- M1 不做本地面板（过度）
