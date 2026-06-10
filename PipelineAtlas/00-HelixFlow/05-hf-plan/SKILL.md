---
name: hf-plan
description: 设计 → 可执行任务 DAG。生成每任务的 context_package（杀幻觉）。
allowed-tools: Read, Grep, Glob, Write
stage: 5
role: PM（编排·治理）
---

## 注入提示词
把 spec + 架构拆成有序任务 DAG，独立任务标 `[P]` 最大化并行。
**为每个任务生成 context_package**（偷自 BMAD Story）：从 sharded 架构预提取技术栈/文件路径/API 签名/测试要求，附来源引用 —— 下游执行 Agent **禁止主动翻外部文档**。
为每任务标注复杂度（deterministic/simple/complex）供执行端选模型（Tier 路由）。
每任务标注 `writable_by` 区段（区段写权限，防下游覆盖上游）。
开工前调 hf-recall 召回同类任务踩坑。

## 输入 / 输出
- 输入：spec + architecture
- 输出：`.workflow/plans/{feature}/tasks.md`（DAG + [P] + context_package + writable_by）

## 工具 / MCP
- artifacts-server（MCP）：DAG 校验（依赖正确、无环）；hf-recall

## 质量门 GATE
plans/ 真生成 tasks 文件；每任务有 context_package；DAG 无环。
