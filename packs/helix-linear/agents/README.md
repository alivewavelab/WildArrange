# HelixFlow Agent 提示词

本目录是 `helix-linear` prompt pack 的角色合同。提示词只写**当前 Helix 运行时行为**。

## Agent 职责

| Helix Agent | Helix 职责 |
|---|---|
| Router | 只读当前请求与 `.helix/` 状态，输出结构化路由 JSON |
| Sisyphus | 按 Router 裁决编排 plan / execute / verify / recover / change-request lane |
| Prometheus | 产出决策完备的计划与 tasks |
| Metis | 计划前只读分析：意图、歧义、范围与验收风险 |
| Momus | 计划执行就绪度审核：blocker only |
| Atlas | 线性派发 worker、独立验证、checkpoint、ledger |
| Hephaestus | 边界内实现 worker，返回 DoneClaim |
| Oracle | 只读技术验证与架构/调试顾问 |
| Explore | 只读代码库检索 |
| Librarian | 只读外部文档与开源研究 |

## 状态与路径映射

| 概念 | Helix M1 |
|---|---|
| 计划文件 | `.helix/plans/*.json` + `.helix/team/tasks.md` |
| 工作状态 | `.helix/work.json` |
| 经验沉淀 | `.helix/wisdom/*` |
| 执行任务 | `worker_command` 或 Codex/Cursor adapter |
| 外部验证 | `verify_commands` + Oracle/review contract |
| 完成标记 | 任务状态 `completed` + 重写 `tasks.md` |

## 路由裁剪说明

Helix M1 把 intent 分类、category/skills 委派、subagent 解析拆成：

1. **`router.md`**：intent → complexity → domain/category → skills → JSON 输出
2. **`routes.json`**：确定性信号与默认 nextCommand（供 runtime/工具读取）
3. **`sisyphus.md`**：收到 Router 裁决后，只负责 lane 编排与交付纪律

Intent/category 细则**不要**再写进 Sisyphus、Atlas 等下游 agent；下游只消费 Router 输出或 `routes.json`。

## 提示词维护原则

- 身份段写角色与边界，不写外部项目溯源。
- 历史对照和源码阅读证据只维护在 `doc/reports/`，不进入 prompt pack。
- 同一规则只保留一处：路由归 Router，执行归 Atlas，计划归 Prometheus
