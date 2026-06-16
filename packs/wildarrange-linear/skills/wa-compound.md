# wa-compound

## 用途

沉淀后置。问题解决后把结论沉淀到 `.helix/memory/` 的 digest / event / stage summary。复利飞轮的“存”，也是自进化载体。

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

High 匹配时更新旧 digest 或追加事件引用，而不是新建平行知识库，防止文档漂移。

只 orchestrator 写文件，子 Agent 只回文本，主交付物只 1 个。

自进化关键：bug 轨沉淀会被测试阶段消费，自动变成下次回归检查项。优先通过 `node ./bin/helix.mjs archivist run --text <summary> --stage <stage>` 或 runtime 自动 digest 写入；确需人工沉淀时，也必须写进 `.helix/memory/`，不要写到无人读取的目录。

如果 `CONCEPTS.md` 已存在，可顺手维护项目共享词汇；不存在时不要为了本 skill 单独创建，除非用户明确要求。

## 输入 / 输出

- 输入：对话历史和问题解决过程。
- 输出：`.helix/memory/digests/*`、`.helix/memory/events.jsonl` 或 `.helix/memory/stage-summaries/*`；可选更新既有 `CONCEPTS.md`。

## 工具 / MCP

- Write：orchestrator 独占。
- frontmatter 校验脚本。
