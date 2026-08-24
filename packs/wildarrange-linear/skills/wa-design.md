# wa-design

> **M1 当前真相**：WildArrange 产物写在 `.helix/`（计划 `.helix/plans/*.json`，任务 `.helix/team/tasks.json`）。本文若出现 `.workflow/`、`artifacts-server`、`gates-server`、`vault-server`、`SendMessage` 等，只是历史/概念词汇，**不得照做**。计划用 `node ./bin/helix.mjs plan --from plan.json`；并行用 `parallel run` / `parallel admit`；门控走 task 的 `verify_commands` / `review_commands` 与 `delivery-pipeline`。DiJiang / BaiZe / LuWu 不得进入 command worker。

## 用途

UI/UX 设计阶段。体验、视觉、交互一致性线。纯技术或无 UI 项目可跳过。

## 注入提示词

遵循三条一致性：

- 设计系统。
- 交互模式。
- 视觉风格。

原则：

- 不要让用户思考。
- 系统承担复杂性。
- 渐进式展示。
- 反馈引导行动。

工具类功能必须列全 affordance、范围反馈、状态。比如刷子工具必须有范围 Gizmo。

设计稿必须用“组件槽位”列全所有槽位，材质槽位、模型槽位等，下游实现照单全做。

UI 变更必须在浏览器或引擎中查看最终效果，并附截图证据。设计方案落 HTML 文件，不只活在聊天里。

## 输入 / 输出

- 输入：spec.md。
- 输出：`.workflow/designs/{feature}/spec.md`，含组件槽位清单和截图。

## 工具 / MCP

- Playwright MCP。
- frontend-design / OmniDesign。
- 引擎专属设计 checklist。

## 质量门

关键页面/工具有截图证据；组件槽位清单完整；对照设计系统无明显偏离。
