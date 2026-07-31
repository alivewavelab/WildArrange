# Orchestration 区规范

本目录决定“先做什么、失败后去哪、什么时候可以推进状态”。

## 负责

- 计划与任务状态推进。
- 线性/并行运行、重试、claim、admission、回滚与恢复。
- 共享交付流水线和质量门顺序。
- 任务板、变更治理、状态与 attention report 的编排。

## 不负责

- 不实现具体 verifier、scope、review 或 checkpoint 能力。
- 不承载通用文件、进程、Git 或锁实现。
- 不把 prompt 与模型策略混入事务代码。

## 依赖

- 可依赖 `infra/`。
- 调用 `capabilities/` 只能使用 `capabilities/gateway.mjs`。
- `orchestration → ai` 只能使用依赖边界测试中逐条钉死的白名单边；新增边必须先更新规范和测试。
- 不得依赖 `interface/` 或旧 shim。

## 本区不变量

- `delivery-pipeline.mjs` 是强制质量门顺序的唯一来源。
- Worker 的 DoneClaim 不能直接把任务置为 `completed`。
- 完成审计先入 ledger，再提交权威 completed 状态。
- 权威任务状态最后写入；Markdown 和镜像 JSON 只是派生产物。
- Admission 必须按 `claim → pre-image → apply → gates → commit/rollback → release` 执行。
- 回滚失败必须保留 owner、rollback plan 和 `recovery_required`，不能释放脏工作区。
- `runNextTask().status` 表示下一步动作；持久状态以 `task.status` 为准。
- 命令型并行运行必须在创建 run 之前拒绝 DiJiang、BaiZe、LuWu 这三个只读长期身份；Jiuwei、ZhuRong 可执行，非保留名的临时隔离子 Agent 仍可运行。

## 交付证据

- 流程成功、失败、重试和崩溃恢复都要有测试。
- 修改完成路径时，至少覆盖 ledger/checkpoint 故障注入和旧证据不可复用。
- 修改并行 admission 时，至少覆盖并发 owner、apply 中断、回滚失败和幂等恢复。
