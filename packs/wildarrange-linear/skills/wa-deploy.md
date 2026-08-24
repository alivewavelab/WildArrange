# wa-deploy

> **M1 当前真相**：WildArrange 产物写在 `.helix/`（计划 `.helix/plans/*.json`，任务 `.helix/team/tasks.json`）。本文若出现 `.workflow/`、`artifacts-server`、`gates-server`、`vault-server`、`SendMessage` 等，只是历史/概念词汇，**不得照做**。计划用 `node ./bin/helix.mjs plan --from plan.json`；并行用 `parallel run` / `parallel admit`；门控走 task 的 `verify_commands` / `review_commands` 与 `delivery-pipeline`。DiJiang / BaiZe / LuWu 不得进入 command worker。

## 用途

部署上线阶段。HITL 硬门：必须人拍板。包含 Go/No-Go、回滚、CI watch。

## 注入提示词

对外或不可逆操作必须先确认。

生成：

- Go/No-Go 检查单。
- 回滚预案。
- 监控计划。

CI watch + autofix 循环最多 3 轮直到绿。失败不静默，不弱化或跳过断言。

## 输入 / 输出

- 输入：通过测试的变更。
- 输出：上线 / PR / 监控。

## 工具 / MCP

- gates-server.deploy_gate：HITL 硬门，必须人类拍板。
- CI/部署 MCP，例如 Vercel MCP。

## 质量门

deploy_gate 必须人类拍板；CI 绿；回滚预案就位。
