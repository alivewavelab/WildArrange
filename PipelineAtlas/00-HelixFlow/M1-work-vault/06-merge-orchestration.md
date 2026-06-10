# 节点 06 · merge 收口 (R5 · 杀"做完没合并")
- 类型：独立调用
- 输入：所有 task 分支/worktree 状态
- 输出：合并收口；检测"完成但未合并"的工作并提示/兜底
- 触发：任务完成 / 关键词 `merge` / 周期巡检
- 逻辑：扫描在途分支→识别已完成未合并→引导/执行 merge→冲突上报；这是 oh-my 生态的空白(无一做 merge 编排)，HelixFlow 的差异化
- 工具/MCP：vault-server.merge（计划）
