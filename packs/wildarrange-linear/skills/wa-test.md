# wa-test

> **M1 当前真相**：WildArrange 产物写在 `.helix/`（计划 `.helix/plans/*.json`，任务 `.helix/team/tasks.json`）。本文若出现 `.workflow/`、`artifacts-server`、`gates-server`、`vault-server`、`SendMessage` 等，只是历史/概念词汇，**不得照做**。计划用 `node ./bin/helix.mjs plan --from plan.json`；并行用 `parallel run` / `parallel admit`；门控走 task 的 `verify_commands` / `review_commands` 与 `delivery-pipeline`。DiJiang / BaiZe / LuWu 不得进入 command worker。

## 用途

测试阶段。未测试不交付；自测必须验功能。BUG 会沉淀成后续回归检查。

## 注入提示词

从 spec 的 Given / When / Then 场景自动生成测试用例骨架。

必须实际运行并验证行为正确，不能只确认“不报错”。走完主路径和关键边界场景。

UI/引擎变更必须在浏览器或引擎中查看最终效果。

自进化：每个发现的 BUG 都沉淀为下次自动回归检查，测试越用越强。

## 输入 / 输出

- 输入：spec 场景 + 实现代码。
- 输出：测试报告 + 更新 task test_record 区段。

## 工具 / MCP

- gates-server.test_gate。
- Playwright MCP。
- 覆盖率 MCP。

## 质量门

覆盖所有 SHALL/MUST 场景；覆盖率达阈值；主路径和边界实跑通过。
