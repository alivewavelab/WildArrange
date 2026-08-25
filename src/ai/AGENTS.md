# AI 区规范

本目录负责语义、上下文与宿主生命周期策略，不负责最终事实判定。

## 负责

- 请求路由、ArchivistRouter 和语义第二意见。
- Prompt 注入、Skill 匹配与任务绑定。
- Agent 上下文、会话恢复和生命周期 Hook 策略。

## 不负责

- 不直接推进任务状态、提交 checkpoint 或实现工作区事务。
- 不实现具体能力。
- 不把模型输出当作未经审计的权威状态。

## 依赖

- 可依赖 `infra/`。
- 对 `orchestration/` 只允许只读状态或报告访问。
- 调用能力只能经 `capabilities/gateway.mjs`；不得 import 具体能力文件。
- 不得依赖 `interface/` 或旧 shim。

## 本区不变量

- Deterministic 路由与证据优先；semantic shadow 只能作为低置信门控或第二意见。
- Router 是确定性系统节点，不是长期 Agent；路由结果只能选择 5 个长期 Agent 和已登记 Skill。
- ArchivistRouter 只摄入清洗后的结论包，不摄入代码块、raw diff 或完整命令输出。
- 无 LLM key 时必须 fallback，不阻断主线、Hook 或线性状态机。
- Hook 崩溃/超时按宿主约定 fail-open 时，最终完成仍由 delivery pipeline 的质量门决定。
- 动态 Skill 选择只能从配置的上界中做减法，不得通过请求文本加载未授权全文。
- `task.skills` 只在真实接通的执行前公开宿主入口作为可信任务绑定；M1 的复核与 checkpoint 仍只使用各自静态 Skill，不宣称自动消费任务绑定。任务 Skill 必须经过 Prompt Pack manifest / 项目 Skill 安全解析、安装根/realpath/hash 校验、数量上限和字符预算，不得绕过加载器。
- 截断必须显式报告，不能静默丢失上下文。

## 交付证据

- 路由变化同时覆盖 deterministic 结果、fallback、建议审核和低置信场景。
- Hook 变化覆盖格式错误、非目标项目、越界写入、Stop continuation 和失败放行边界。
- Prompt / Skill 变化覆盖预算、动态挂载和未匹配项降级为引用。
