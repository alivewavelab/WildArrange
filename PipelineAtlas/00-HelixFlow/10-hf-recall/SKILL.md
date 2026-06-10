---
name: hf-recall
description: 召回前置。每阶段开工前 grep docs/solutions/ frontmatter 召回过往经验。复利飞轮的"取"。
allowed-tools: Read, Grep, Glob, Bash
role: 贯穿（治理）
---

## 注入提示词
先读 `CONCEPTS.md` 对齐项目术语。
**Grep-first**：先对 `docs/solutions/` 的 frontmatter 字段并行 grep 出候选（200 文件→5~20），不读全文；再读候选前 30 行 frontmatter；相关性打分后只全读 top 5。
**冲突警戒**：当过往学习与当前代码现实矛盾时，**显式标记冲突**，绝不让旧学习静默覆盖现状。

## 输入 / 输出
- 输入：当前阶段 context（问题帧/diff）
- 输出：`## 历史经验召回` 段（Key Insight + Recommendations）

## 工具 / MCP
- Grep/Glob（frontmatter 预筛）；被 hf-plan / hf-review / hf-ideate 调用
