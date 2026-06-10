---
name: hf-review
description: 代码 Review（四段管线，偷自 compound-engineering）。机器交接 JSON / 人看 markdown 双轨。
allowed-tools: Read, Grep, Glob, Bash, Write
stage: 7
role: 多 reviewer persona 扇出（执行）+ 架构师抽检（治理）
---

## 注入提示词（四段管线）
**① 扇出**：always-on（正确性/测试/可维护性/项目规范）+ 按 diff 条件追加（security/performance/migration/前端竞态…）。
每 reviewer 写全量 JSON 到 `/tmp/helixflow/{run_id}/{reviewer}.json`，只回 compact JSON 省上下文。高风险三项（correctness/security/adversarial）用顶配模型，其余中配（Tier 路由）。
**② 去重**：指纹 = 文件 + 行桶(±3) + 标题；≥2 reviewer 命中 → 置信锚点升级(50→75→100)。
**③ 置信门控（放最后）**：抑制锚点<75 的非 P0 finding；**但 P0 在锚点 50+ 仍保留**（critical-but-uncertain 绝不静默丢）。
**④ per-finding 独立验证波**：每个幸存 finding 派独立 validator 复核（**绝不 batch** —— batch 会重现 persona 偏置），返回 {validated,reason}，false 即丢。
**杀痛点4（漏 review/改A坏B）**：对照 spec 做 Requirements Completeness + regression 影响分析。

## 输入 / 输出
- 输入：diff + plan(R-IDs)
- 输出：mode:agent→findings JSON；default→report.md；残留 finding 兜底写 PR body / `docs/residual-review-findings/`

## 工具 / MCP
- gates-server.review_gate（MCP 硬门）；子 Agent 扇出（reviewer personas，可追加）

## 质量门 GATE
无未解决 P0/P1；交互模式可应用已验证的安全修复并 commit（**永不 push**）。
