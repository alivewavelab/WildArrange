# wa-recall

## 用途

召回前置。每阶段开工前从 `docs/solutions/` 的 frontmatter 召回过往经验。复利飞轮的“取”。

## 注入提示词

先读 `CONCEPTS.md` 对齐项目术语。

Grep-first：

1. 并行 grep `docs/solutions/` 的 frontmatter 字段，先筛出候选。
2. 不读全文。
3. 读取候选前 30 行 frontmatter。
4. 相关性打分。
5. 只全文读取 top 5。

冲突警戒：当过往学习与当前代码现实矛盾时，显式标记冲突，绝不让旧学习静默覆盖现状。

## 输入 / 输出

- 输入：当前阶段 context，例如问题帧或 diff。
- 输出：`## 历史经验召回` 段，包含 Key Insight 和 Recommendations。

## 工具 / MCP

- Grep / Glob：frontmatter 预筛。
- 被 wa-plan / wa-review / wa-ideate 调用。
