# HelixFlow Agent 提示词

本目录是 `omo-linear` prompt pack 的角色合同。提示词只写**当前 Helix 运行时行为**；与 oh-my-openagent（OMO）的渊源、路径映射、裁剪说明放在本文，不占 agent 上下文。

## Agent 对照

| Helix Agent | OMO 来源 | Helix 职责 |
|---|---|---|
| Router | Sisyphus 的 intent gate + category resolver + delegate-task resolver | 只读当前请求与 `.helix/` 状态，输出结构化路由 JSON |
| Sisyphus | Sisyphus 主编排器（去掉路由细则） | 按 Router 裁决编排 plan / execute / verify / recover / change-request lane |
| Prometheus | Prometheus | 产出决策完备的计划与 tasks |
| Metis | Metis | 计划前只读分析：意图、歧义、范围与验收风险 |
| Momus | Momus | 计划执行就绪度审核：blocker only |
| Atlas | Atlas | 线性派发 worker、独立验证、checkpoint、ledger |
| Hephaestus | Hephaestus | 边界内实现 worker，返回 DoneClaim |
| Oracle | Oracle | 只读技术验证与架构/调试顾问 |
| Explore | Explore | 只读代码库检索 |
| Librarian | Librarian | 只读外部文档与开源研究 |

## 状态与路径映射

| OMO | Helix M1 |
|---|---|
| `.omo/plans/*.md` | `.helix/plans/*.json` + `.helix/team/tasks.md` |
| `.omo/boulder.json` | `.helix/work.json` |
| `.omo/notepads/{plan}` | `.helix/wisdom/*` |
| `task(category=...)` | `worker_command` 或 Codex/Cursor adapter |
| 外部 verifier task | `verify_commands` + Oracle/review contract |
| 勾选 plan checkbox | 任务状态 `completed` + 重写 `tasks.md` |

## 路由裁剪说明

OMO 把 intent 分类、category/skills 委派、subagent 解析揉在 Sisyphus 大 prompt 里。Helix M1 拆成：

1. **`router.md`**：intent → complexity → domain/category → skills → JSON 输出
2. **`routes.json`**：确定性信号与默认 nextCommand（供 runtime/工具读取）
3. **`sisyphus.md`**：收到 Router 裁决后，只负责 lane 编排与交付纪律

Intent/category 细则**不要**再写进 Sisyphus、Atlas 等下游 agent；下游只消费 Router 输出或 `routes.json`。

## 提示词维护原则

- 身份段写角色与边界，不写「改编自 OMO …」
- 对照表、历史路径、裁剪理由只维护在本 README 与 `manifest.json` / `routes.json` 的 `source` 字段
- 同一规则只保留一处：路由归 Router，执行归 Atlas，计划归 Prometheus
