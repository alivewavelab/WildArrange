# 工作范式项目规范

## 当前目标

本项目正在实现 HelixFlow 的 M1 线性 Agent 循环。第一版只做可恢复、可验证的单线流程：

`init -> plan -> task -> worker -> verifier -> retry/checkpoint -> ledger`

## 实现边界

- 先还原 oh-my-openagent 的运行秩序：计划与执行分离、worker 不自证完成、独立验证、失败返工、证据入账。
- 不直接移植 OpenCode Ultimate 专属工具，例如 `team_*`、OpenCode plugin hooks、tmux layout。
- Codex / Cursor 适配放到 runtime adapter 层；核心状态机必须是产品中立的本地文件协议。
- 第一版不接真实模型 API key，不启动常驻多 Agent 集群，只跑通线性状态机。

## 工程约束

- 使用 Node.js ESM，无外部 npm 依赖，保证 Codex / Cursor / 普通终端都能直接运行。
- 所有运行时状态写入 `.helix/`。
- 计划、任务、回执、验证结果必须同时具备机器可读 JSON 和人工可读摘要。
- worker 的 `DoneClaim` 不能直接让任务完成；必须有 verifier PASS。
- verifier FAIL 时任务回到 `pending`，并把失败证据写入 ledger。
- 所有新增功能必须有自动测试，并实际运行。
- `runNextTask` 的返回 `status` 表示运行时下一步动作；任务持久状态以 `task.status` 为准。例如 verifier 失败时可返回 `status: "retry"`，同时 `task.status === "pending"`。
- Dashboard 默认只绑定 `127.0.0.1`。任何非 loopback host 必须配置 `--token` 或 `HELIX_DASHBOARD_TOKEN`。

## 目录约定

- `README.md`：新用户安装、初始化、最小工作流和 dashboard 安全说明。
- `doc/concept.md`：产品概念与 OMO 借鉴边界。
- `doc/project-architecture.md`：运行时架构、状态文件和 gate 模型。
- `doc/development-plan.md`：P0/P1/P2 路线。
- `bin/helix.mjs`：CLI 入口。
- `src/helix-core.mjs`：线性循环核心逻辑。
- `test/*.test.mjs`：Node 内置测试。
- `.helix/`：运行时状态目录，可由 CLI 生成。

## 常用命令

| 场景 | 命令 |
|---|---|
| 初始化运行时 | `node ./bin/helix.mjs init` |
| 生成默认配置 | `node ./bin/helix.mjs config init --root` |
| 安装 adapter | `node ./bin/helix.mjs adapter install --target all --mode local` |
| 卸载 adapter | `node ./bin/helix.mjs adapter uninstall --target all` |
| 导入计划 | `node ./bin/helix.mjs plan --from plan.json` |
| 跑下一个任务 | `node ./bin/helix.mjs run` |
| 跑 sample workflow | `node ./bin/helix.mjs workflow --sample` |
| 查看状态 | `node ./bin/helix.mjs status` |
| 生成总结 | `node ./bin/helix.mjs summary` |
| 启动本地 dashboard | `node ./bin/helix.mjs serve --host 127.0.0.1 --port 8765` |
| 完整测试 | `npm test` |
| npm 包体预检 | `npm pack --dry-run --cache /private/tmp/helix-npm-cache` |
