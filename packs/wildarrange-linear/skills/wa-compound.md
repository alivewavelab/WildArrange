# wa-compound

> **M1 当前真相**：WildArrange 产物写在 `.helix/`（计划 `.helix/plans/*.json`，任务 `.helix/team/tasks.json`）。本文若出现 `.workflow/`、`artifacts-server`、`gates-server`、`vault-server`、`SendMessage` 等，只是历史/概念词汇，**不得照做**。计划用 `node ./bin/helix.mjs plan --from plan.json`；并行用 `parallel run` / `parallel admit`；门控走 task 的 `verify_commands` / `review_commands` 与 `delivery-pipeline`。DiJiang / BaiZe / LuWu 不得进入 command worker。

## 用途

沉淀后置。问题解决后把结论沉淀到 `.helix/memory/` 的 digest / event / stage summary。复利飞轮的“存”，也是自进化载体。

## 注入提示词

触发：问题解决信号，例如“搞定了”“修好了”，或阶段收尾。

双轨 frontmatter schema：

- bug 轨：强制 `symptoms`、`root_cause`、`resolution_type`。
- knowledge 轨：可选 `applies_when`。
- 共用必填：`module`、`date`、`component`、`severity`。

五维重叠度评分：

- 问题（problem）。
- 根因（root_cause）。
- 方案（solution）。
- 文件（files）。
- 预防（prevention）。

高匹配时更新旧 digest 或追加事件引用，而不是新建平行知识库，防止文档漂移。

仅 orchestrator 写文件，子 Agent 只回文本，主交付物只 1 个。

自进化关键：bug 轨沉淀会被测试阶段消费，自动变成下次回归检查项。优先通过 `node ./bin/helix.mjs archivist run --text <summary> --stage <stage>` 或 runtime 自动 digest 写入；确需人工沉淀时，也必须写进 `.helix/memory/`，不要写到无人读取的目录。

如果 `CONCEPTS.md` 已存在，可顺手维护项目共享词汇；不存在时不要为了本 skill 单独创建，除非用户明确要求。

## 输入 / 输出

- 输入：对话历史和问题解决过程。
- 输出：`.helix/memory/digests/*`、`.helix/memory/events.jsonl` 或 `.helix/memory/stage-summaries/*`；可选更新既有 `CONCEPTS.md`。

## 工具 / MCP

- Write：orchestrator 独占。
- frontmatter 校验脚本。
