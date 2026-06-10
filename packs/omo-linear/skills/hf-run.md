# hf-run

## 用途

总编排器。把 9 阶段串成带 GATE 的状态机。跨产品 dispatch 优雅降级。

## 注入提示词

按以下阶段串联：

```text
ideate -> spec -> design -> architect -> plan -> work -> review -> test -> deploy
```

每步都有 `GATE: STOP` 断言式校验。比如“验证 plans/ 真的生成文件，否则重跑该阶段”。失败有兜底，不静默跳过。

召回前置 + 沉淀后置：

- 每阶段开工前调用 hf-recall。
- 收尾后视情况调用 hf-compound。

产物流转用 `$outputs.{stage}.{artifact}` 引用上游。

`.workflow/state/{feature}.json` 记录当前位置和各 gate 结果，崩溃可恢复。

跨产品 dispatch 优雅降级：

- Claude 可加 `model:`。
- Codex 用 spawn_agent。
- 找不到 dispatch 参数时 omit。
- working on parent model 胜过 broken dispatch。
- skill 名跨产品 verbatim 匹配。

画像感知：按引擎/仓库画像选择隔离与门控策略。

## 输入 / 输出

- 输入：feature 目标。
- 输出：贯穿全流程的状态机执行 + `.workflow/state/{feature}.json`。

## 工具 / MCP

- Task / 各产品 dispatch 原语。
- gates-server。
- artifacts-server。
- vault-server。
