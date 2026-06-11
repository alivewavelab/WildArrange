# hf-compound

## 用途

沉淀后置。问题解决后写双轨 schema 到 `docs/solutions/`。复利飞轮的“存”，也是自进化载体。

## 注入提示词

触发：问题解决信号，例如“搞定了”“修好了”，或阶段收尾。

双轨 frontmatter schema：

- bug 轨：强制 `symptoms`、`root_cause`、`resolution_type`。
- knowledge 轨：可选 `applies_when`。
- 共用 required：`module`、`date`、`component`、`severity`。

五维 overlap 评分：

- problem。
- root_cause。
- solution。
- files。
- prevention。

High 匹配时更新旧文档，而不是新建，防止文档漂移。

只 orchestrator 写文件，子 Agent 只回文本，主交付物只 1 个。

自进化关键：bug 轨沉淀会被测试阶段消费，自动变成下次回归检查项。

顺手维护 `CONCEPTS.md`，作为项目共享词汇表。

## 输入 / 输出

- 输入：对话历史和问题解决过程。
- 输出：`docs/solutions/{category}/*.md` + 可选更新 CONCEPTS.md。

## 工具 / MCP

- Write：orchestrator 独占。
- frontmatter 校验脚本。
