# wa-spec

> **M1 当前真相**：WildArrange 产物写在 `.helix/`（计划 `.helix/plans/*.json`，任务 `.helix/team/tasks.json`）。本文若出现 `.workflow/`、`artifacts-server`、`gates-server`、`vault-server`、`SendMessage` 等，只是历史/概念词汇，**不得照做**。计划用 `node ./bin/helix.mjs plan --from plan.json`；并行用 `parallel run` / `parallel admit`；门控走 task 的 `verify_commands` / `review_commands` 与 `delivery-pipeline`。DiJiang / BaiZe / LuWu 不得进入 command worker。

## 用途

需求到规格。spec 是约束所有下游的合同，不是普通文档。

## 注入提示词

每条 requirement 用 RFC2119 关键词标强度，并配 Given / When / Then 场景。

修改已有 spec 一律走 delta：ADDED / MODIFIED / REMOVED，写入 `changes/`，不得直接改主 spec，避免多人和多 Agent 并行冲突。

校验是否违反 `principles/constitution.md` 这类宪法级元约束。

## 输入 / 输出

- 输入：`brief.md` + constitution.md。
- 输出：`.workflow/specs/{feature}/spec.md` + `.workflow/changes/{feature}/specs/*.md`。

## 工具 / MCP

- artifacts-server：delta 合并、frontmatter 校验、spec 一致性检查。

## 澄清纪律（重要）

规格是约束下游的合同，任何拍脑袋的假设都会被放大。遇到需求缺口或多义时，**必须先向开发者澄清，不得自行补全**。

### 触发条件（命中任一即先停）

- 需求边界不清（做什么 / 不做什么）。
- 非功能约束不清（性能、安全、隐私、兼容）。
- 优先级不清（先做哪个）。
- 验收口径不清（怎么算通过）。

### 提问模板

- 用中文列**编号澄清问题**。
- 每个问题尽量给**候选选项**（如 “A 方案 / B 方案 / 其他”）或“是 / 否确认”，让开发者一句话决策。
- 一次把关键缺口问全，避免来回挤牙膏。

### 未确认的处理

- 得到答复后才写进 spec。
- 未确认的点标注为**待澄清**，**不进 SHALL / MUST**。

### 下游调度

- 澄清确认后：用 artifacts-server 做 delta 合并、frontmatter 校验、spec 一致性检查。
- 修改已有 spec 一律走 delta（ADDED / MODIFIED / REMOVED），写入 `changes/`，不直接改主 spec。

## 质量门

每条 SHALL/MUST 都有对应场景；constitution 合规；delta 无冲突；缺口已澄清而非假设。
