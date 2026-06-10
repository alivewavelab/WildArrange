---
name: hf-design
description: UI/UX 设计（体验/视觉一致性线）。可拔：纯技术/无UI项目跳过本阶段。
allowed-tools: Read, Write, Bash
stage: 3
role: 设计负责人（治理）
engine-appendable: true
---

## 注入提示词
遵循设计系统 + 交互模式 + 视觉风格三条一致性。原则：不要让用户思考、系统承担复杂性、渐进式展示、反馈引导行动。
**杀痛点6（无产品思维）**：工具类功能必须列全 affordance/范围反馈/状态（如刷子必须有 Gizmo 显示范围）——见领域 checklist。
**杀痛点5（实现不全）**：设计稿必须用 `组件槽位` 区段列全所有槽位（材质槽位/模型槽位…），下游实现照单全做。
UI 变更必须在浏览器/引擎中查看最终效果并附截图证据。设计方案落 HTML 文件，不只活在聊天里。

## 输入 / 输出
- 输入：spec.md
- 输出：`.workflow/designs/{feature}/spec.md`（含组件槽位清单）+ 截图

## 工具 / MCP
- Playwright MCP（Web 截图）；可挂现有设计 skill（frontend-design / OmniDesign）；引擎专属设计 checklist（可追加：Unity/UE…）

## 质量门 GATE
关键页面/工具有截图证据；组件槽位清单完整；对照设计系统无明显偏离。
