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

## 澄清纪律（重要）

计划从产品文档与技术文档提炼，不是让开发者从零手填。遇到缺失或模糊，**必须先在对话中向开发者澄清，不得擅自假设后硬塞进计划**。澄清是硬要求，不是可选礼貌；宁可多问一轮，也不要用猜测污染计划。

### 触发条件（命中任一即先停）

- 缺目标（这次要达成什么）。
- 缺验收标准（怎么算完成）。
- 缺影响范围 `writable_paths`（允许改哪些路径）。
- 缺依赖关系（任务先后 / 阻塞）。
- 缺优先级（先做哪个）。

### 提问模板

- 用中文把缺口整理成**编号问题清单**。
- 尽量给出**候选选项**让开发者选（例如 “A 方案 / B 方案 / 其他”），或请求确认。

### 未确认的处理

- 开发者答复后再补全计划。
- 答复前**不要生成会被下游当成既定事实的字段**（目标、验收、writable_by、依赖等）。

### 下游调度

- 开工前调用 **wa-recall** 召回同类任务踩坑。
- 用 artifacts-server 做 DAG 校验（无环、依赖正确）。
- 澄清完成后再拆有序任务 DAG，为每个任务生成 context_package 并标注 `writable_by`。

## 质量门

plans 下真实生成 tasks 文件；每任务有 context_package；DAG 无环；缺失关键信息时已向开发者澄清而非自行假设。
