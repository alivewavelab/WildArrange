# 节点 08 · 跨产品一致 (R7)
- 类型：常驻（机制层）
- 输入：—
- 输出：Claude/Codex/Cursor 行为一致
- 逻辑：核心全在 git 层 + 薄 MCP/CLI；hooks 不可用的产品(Codex/Cursor 弱)用 git 侧 pre-commit/后台 daemon 兜底持续快照
- 分发：一份源 → symlink/编译投影到各产品（借 spec-kit CommandRegistrar / CE 转换器 / forge symlink / wshobson make generate）
- 工具/MCP：MCP server（三产品统一）+ adapters/build 投影
