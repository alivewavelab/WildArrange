# WildArrange 项目规范

> 面向 Agent 与维护者的治理约束。用户安装与快速上手见 [README.md](./README.md)（中文）/ [README.en.md](./README.en.md)（English）。

## 当前目标

实现 WildArrange M1 线性 Agent 循环。第一版只做可恢复、可验证的单线流程：

```text
init -> plan -> task -> worker -> verifier -> retry/checkpoint -> ledger
```

## 实现边界

- 先还原运行秩序：计划与执行分离、worker 不自证完成、独立验证、失败返工、证据入账。
- 不把任何宿主专属工具硬塞进 core（例如特定 editor plugin hooks、tmux layout）。
- Codex / Cursor 适配放在 runtime adapter 层；核心状态机必须是产品中立的本地文件协议。
- LLM review 通过 OpenAI-compatible provider 配置化接入；默认关闭，无 key 时不阻断线性状态机。
- 第一版不启动常驻多 Agent 集群，只跑通线性状态机。
- 商业发布包不得包含受限第三方源码、prompt 原文或近似改写文本；外部项目只能作为概念参考和对照证据。

## 工程约束

- 使用 Node.js ESM，无外部 npm 依赖，保证 Codex / Cursor / 普通终端都能直接运行。
- 所有运行时状态写入 `.helix/`。
- 计划、任务、回执、验证结果必须同时具备机器可读 JSON 和人工可读摘要。
- worker 的 DoneClaim 不能直接让任务完成；必须有 verifier PASS。
- verifier FAIL 时任务回到 `pending`，并把失败证据写入 ledger。
- 所有新增功能必须有自动测试，并实际运行。
- `runNextTask` 的返回 `status` 表示运行时下一步动作；任务持久状态以 `task.status` 为准。例如 verifier 失败时可返回 `status: "retry"`，同时 `task.status === "pending"`。
- Dashboard 默认只绑定 `127.0.0.1`。任何非 loopback host 必须配置 `--token` 或 `HELIX_DASHBOARD_TOKEN`。

## 代码维护规范

- `src/helix-core.mjs` 只作为兼容导出层，不允许继续堆业务实现。
- 新增功能必须先归属到现有领域模块；无合适归属时新增 `src/helix-*.mjs`。
- 单文件默认保持 1000 行以内；超过 700 行必须评估是否按职责拆分。
- 模块内部必须直接 import 目标实现文件，不要通过 `src/helix-core.mjs` 绕一层。
- 新增运行时能力必须同时更新 `doc/project-architecture.md` 和本文件的目录约定。
- gate 安全不变量不能削弱：不得删除或清空 `verify_commands`，不得跳过 verifier / scope / review / successCriteria 完成 checkpoint。
- 重构后必须验证 `npm test`；涉及包内容变化时同时验证 `npm pack --dry-run --cache /private/tmp/helix-npm-cache`。

## 目录约定


| 路径                                                           | 职责                                            |
| ------------------------------------------------------------ | --------------------------------------------- |
| [README.md](./README.md) / [README.en.md](./README.en.md)    | 用户安装、初始化、最小工作流、dashboard 安全说明                 |
| [doc/concept.md](./doc/concept.md)                           | 产品概念与外部参考边界                                   |
| [doc/project-architecture.md](./doc/project-architecture.md) | 运行时架构、状态文件和 gate 模型                           |
| [doc/development-plan.md](./doc/development-plan.md)         | P0 / P1 / P2 路线                               |
| `bin/helix.mjs`                                              | CLI 入口                                        |
| `src/helix-core.mjs`                                         | 兼容导出层，禁止继续堆实现                                 |
| `src/helix-foundation.mjs`                                   | 路径、JSON、锁、ledger、快照等基础能力                      |
| `src/helix-plan.mjs`                                         | 计划导入、校验、路由 enrichment                         |
| `src/helix-node-runtime.mjs`                                 | 线性任务节点运行时、重试 / checkpoint                     |
| `src/helix-workflow.mjs`                                     | Workflow 入口、样例计划生成                            |
| `src/helix-gates.mjs`                                        | verifier、scope guard、review gate              |
| `src/helix-review.mjs`                                       | Worker 执行与 BaiZe / QiongQi / LuanNiao 确定性复核门  |
| `src/helix-review-findings.mjs`                              | LSP / 注释检查等质量发现                               |
| `src/helix-llm.mjs`                                          | OpenAI-compatible LLM provider 与可选 LLM review |
| `src/helix-change.mjs`                                       | 任务变更治理、Review Blocker、ChangeRequest           |
| `src/helix-failure.mjs`                                      | 失败原因分类、返工提示与失败摘要                              |
| `src/helix-rules.mjs`                                        | 项目规范扫描与规则上下文注入                                |
| `src/helix-injection.mjs`                                    | 注入点解析、Markdown / Skill 挂载加载                   |
| `src/helix-context.mjs`                                      | Agent 上下文、恢复快照、会话延续                           |
| `src/helix-hooks.mjs`                                        | 宿主生命周期 Hook、PreToolUse 范围拦截                   |
| `src/helix-adapters.mjs`                                     | Codex / Cursor adapter 安装与卸载                  |
| `src/helix-routing.mjs`                                      | 请求路由与类别决策                                     |
| `src/helix-team.mjs`                                         | 轻量任务板与消息板                                     |
| `src/helix-status.mjs`                                       | 状态报告、Workflow 总结与 Dashboard 数据                |
| `src/helix-dashboard.mjs`                                    | 本地 dashboard HTTP 服务                          |
| `test/*.test.mjs`                                            | Node 内置测试                                     |
| `.helix/`                                                    | 运行时状态目录，可由 CLI 生成                             |


## 常用命令


| 场景                | 命令                                                               |
| ----------------- | ---------------------------------------------------------------- |
| 初始化运行时            | `node ./bin/helix.mjs init`                                      |
| 生成默认配置            | `node ./bin/helix.mjs config init --root`                        |
| 安装 adapter        | `node ./bin/helix.mjs adapter install --target all --mode local` |
| 卸载 adapter        | `node ./bin/helix.mjs adapter uninstall --target all`            |
| 导入计划              | `node ./bin/helix.mjs plan --from plan.json`                     |
| 跑下一个任务            | `node ./bin/helix.mjs run`                                       |
| 跑 sample workflow | `node ./bin/helix.mjs workflow --sample`                         |
| 查看状态              | `node ./bin/helix.mjs status`                                    |
| 生成总结              | `node ./bin/helix.mjs summary`                                   |
| 启动本地 dashboard    | `node ./bin/helix.mjs serve --host 127.0.0.1 --port 8765`        |
| 完整测试              | `npm test`                                                       |
| npm 包体预检          | `npm pack --dry-run --cache /private/tmp/helix-npm-cache`        |
