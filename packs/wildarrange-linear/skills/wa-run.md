# wa-run

> **M1 当前真相**：WildArrange 产物写在 `.helix/`（计划 `.helix/plans/*.json`，任务 `.helix/team/tasks.json`）。本文若出现 `.workflow/`、`artifacts-server`、`gates-server`、`vault-server`、`SendMessage` 等，只是历史/概念词汇，**不得照做**。计划用 `node ./bin/helix.mjs plan --from plan.json`；并行用 `parallel run` / `parallel admit`；门控走 task 的 `verify_commands` / `review_commands` 与 `delivery-pipeline`。DiJiang / BaiZe / LuWu 不得进入 command worker。

## 用途

总编排器。把 9 阶段串成带 GATE 的 `.helix/` 状态机。不同宿主只影响启动方式，不改变治理门。

## 注入提示词

按以下阶段串联：

```text
ideate -> spec -> design -> architect -> plan -> work -> review -> test -> deploy
```

每步都有 `GATE: STOP` 断言式校验。比如“验证 plans/ 真的生成文件，否则重跑该阶段”。失败有兜底，不静默跳过。

召回前置 + 沉淀后置：

- 每阶段开工前调用 wa-recall。
- 收尾后视情况调用 wa-compound。

产物流转用 `$outputs.{stage}.{artifact}` 引用上游。

`.helix/work.json`、`.helix/team/tasks.json`、`.helix/snapshots/context.*` 和 `.helix/ledger.jsonl` 记录当前位置、任务状态、gate 结果和续跑线索，崩溃可恢复。

宿主能力分层：

- Codex 已安装并 trust hook 时，优先走 `.codex/hooks.json` + `hook run`。
- Cursor：受信任工作区中 `preToolUse`（Write/Delete/Edit/Shell）与 `beforeShellExecution` 为 fail-closed 硬拦截；`.cursor/rules/wildarrange.mdc` 仍是软规则层。宿主拦截只是早期预警，最终完成仍必须过 verifier / scope / review / successCriteria / acceptance proof / checkpoint。
- 子 Agent 统一用 `node ./bin/helix.mjs parallel run ...`，adapter 只负责渲染命令模板。
- 找不到可用 adapter 时，回到父会话线性执行，不能跳过 verifier / scope / review / acceptance proof。
- skill 名按 prompt-pack 精确匹配，匹配不到时不伪造 skill。

画像感知：按引擎/仓库画像选择隔离与门控策略。

## 输入 / 输出

- 输入：feature 目标。
- 输出：贯穿全流程的状态机执行 + `.helix/` 状态、ledger、snapshot 和验收证据。

## 工具 / MCP

- `node ./bin/helix.mjs run`。
- `node ./bin/helix.mjs parallel run|admit|status|cleanup|close`。
- `node ./bin/helix.mjs ledger verify`。
- `node ./bin/helix.mjs status|summary`。
