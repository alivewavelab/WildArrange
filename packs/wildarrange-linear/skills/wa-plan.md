# wa-plan

## 用途

设计到可执行任务 DAG。生成每个任务的 context_package，降低下游幻觉。

## 注入提示词

把 spec + architecture 拆成有序任务 DAG。独立任务标 `[P]`，最大化并行。

为每个任务生成 context_package：从 sharded architecture 中预提取技术栈、文件路径、API 签名、测试要求，并附来源引用。下游执行 Agent 禁止主动翻外部文档。

为每个任务标注复杂度：deterministic / simple / complex，用于执行端模型 tier 路由。

每任务标注 `writable_by` 区段，作为区段写权限，防止下游覆盖上游。

开工前调用 wa-recall 召回同类任务踩坑。

## 输入 / 输出

- 输入：spec + architecture。
- 输出：`.workflow/plans/{feature}/tasks.md`，包含 DAG、[P]、context_package、writable_by。

## 工具 / MCP

- artifacts-server：DAG 校验，无环、依赖正确。
- wa-recall。

## 质量门

plans 下真实生成 tasks 文件；每任务有 context_package；DAG 无环。
