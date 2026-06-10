# 节点 03 · 持续 checkpoint（安全网核心 R2）
- 类型：常驻（后台 daemon，已确认接受）
- 输入：文件变更事件（fswatch/chokidar）
- 输出：自动快照到 shadow ref `refs/helix/snapshots/<task>/<ts>`
- 触发：文件变更去抖(债 5–15s) + 会话空闲；有 hooks 的产品(Claude)叠任务标记
- 逻辑：`git add -A` → 写独立 shadow ref（不进分支、可 GC）；尊重 .gitignore；LFS 资产只快照指针不存 blob；保留=每任务留最近 N 个 + 超 X 天 prune（防膨胀 R2.3）
- 跨产品(R7)：daemon 产品中立(辞 Claude/Codex/Cursor 都兼、连崩溃都兜)；hooks 弱的产品靠 daemon + git pre-commit 兜底
- 工具/MCP：`helix watch`（CLI daemon）
- 参考：opencode `"snapshot": true` 文件级追踪
