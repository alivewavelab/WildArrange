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
- Plan/default/task 中的 Skill 名必须是安全的单段标识符；编排层只持久化绑定，不读取 Skill 文件，实际加载统一交给 AI 区预算化注入器。
- Checkpoint/acceptance 证据按 `<planId>/<taskId>` 分目录；归档删除旧扁平证据前必须检查全账本 legacy stem 碰撞与证据内身份，宁可保留歧义旧文件也不能误删另一 Task 的完成证据。
- 命令型并行运行必须在创建 run 之前拒绝 DiJiang、BaiZe、LuWu 这三个只读长期身份；Jiuwei、ZhuRong 可执行，非保留名的临时隔离子 Agent 仍可运行。
- Git 协调开启时，同一任务只能存在一个远端写 owner 和一个本地 `parallel_run_claim`；handoff 后旧设备必须 fail-closed，整链 `run` 与分步 checkpoint 都要在完成前二次验权。
- Handoff 必须按 `prepare → tree fingerprint recheck → non-force push → target accept` 推进；takeover 只能显式执行并记录预期旧设备与理由，不使用本机时间自动过期。push/accept/takeover 的远端成功、本地失败必须可由同一设备和原参数幂等补账。
- Admission 在 acceptance proof 前必须复核任务 owner、远端集成分支 SHA、当前工作目录基线和变更归属；通过 proof 后、checkpoint 前必须生成并普通 push 集成 commit。前置复核失败时只回滚本 run 路径并返回 `revalidation_required`；远端 push 一旦已知成功，之后任何故障都必须保留同一 run 与集成意图，不得回滚或释放。

## 交付证据

- 流程成功、失败、重试和崩溃恢复都要有测试。
- 修改完成路径时，至少覆盖 ledger/checkpoint 故障注入和旧证据不可复用。
- 修改并行 admission 时，至少覆盖并发 owner、apply 中断、回滚失败和幂等恢复。
- 修改 Git 协调时，至少覆盖双设备 claim 竞争、handoff 后旧 owner 被拒绝，以及 gate 期间 main 变化不产生 checkpoint。
