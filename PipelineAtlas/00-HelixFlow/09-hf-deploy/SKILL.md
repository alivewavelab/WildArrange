---
name: hf-deploy
description: 部署上线（HITL 硬门：人拍板）。Go/No-Go + 回滚 + CI watch。
allowed-tools: Read, Bash
stage: 9
role: 部署 Agent（执行）+ PM 放行（HITL）
---

## 注入提示词
对外/不可逆操作先确认。生成 Go/No-Go 检查单 + 回滚预案 + 监控计划。
CI watch + autofix 循环（最多 3 轮直到绿），失败不静默、不弱化/跳过断言。

## 输入 / 输出
- 输入：通过测试的变更
- 输出：上线 + PR + 监控

## 工具 / MCP
- gates-server.deploy_gate（MCP，HITL 硬门，必须人类拍板）；CI/部署 MCP（如 Vercel MCP）

## 质量门 GATE（HITL）
deploy_gate 必须人类拍板；CI 绿；回滚预案就位。
