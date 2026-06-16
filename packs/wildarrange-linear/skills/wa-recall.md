# wa-recall

## 用途

召回前置。每阶段开工前从 `.helix/memory/` 召回过往 digest、档案路由结果和踩坑记录。复利飞轮的“取”。

## 注入提示词

如果 `CONCEPTS.md` 存在，先读它对齐项目术语；不存在时不阻塞，以项目规范、`.helix/memory/` 索引和当前代码事实为准，不要声称已读取词汇表。

Grep-first：

1. 优先读取 `.helix/memory/last-digest.json`、`.helix/memory/digest-index.json` 和 `.helix/memory/last-archivist-result.json`。
2. 按关键词、阶段、任务 ID、路由类别筛出候选 digest 或 stage summary。
3. 不读全文，先看摘要字段和索引。
4. 相关性打分。
5. 只全文读取 top 5。

冲突警戒：当过往学习与当前代码现实矛盾时，显式标记冲突，绝不让旧学习静默覆盖现状。

## 输入 / 输出

- 输入：当前阶段 context，例如问题帧或 diff。
- 输出：`## 历史经验召回` 段，包含 Key Insight 和 Recommendations。

## 工具 / MCP

- Grep / Glob：frontmatter 预筛。
- 被 wa-plan / wa-review / wa-ideate 调用。
