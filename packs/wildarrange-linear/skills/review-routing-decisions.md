# review-routing-decisions

## 用途

复盘指定日期的路由判断，找出重复误判模式并提出最小规则调整建议。

## 输入

- `.wildarrange/decisions.jsonl` 中 `gate=routing` 的原始请求与结构化路由结果。
- `.wildarrange/annotations.jsonl` 中人工确认、规则错误与个案错误标注。
- 同一 `sessionId` 下的工具活动摘要。

## 工作方式

默认由 IDE `Stop` Hook 主动触发：每次会话结束时更新当天报告。它不是后台常驻进程，也不等待用户手动召唤。

1. 先按日期汇总路由总数、已复盘数、确认正确数和问题数。
2. 只分析已有证据，逐条引用 decision id、原文、命中信号和最终路线。
3. 将问题区分为规则错误、个案错误和语义复核冲突。
4. 只有同类误判重复出现时，才建议调整 `routes.json`；单个个案不升级成通用规则。

## 输出（给人看）

- 先给“一眼结论”：判断数、正确数、问题数、待复盘数。
- 再列已确认问题和重复误判模式。
- 最后列每次判断的用户原文、路由结果、命中信号、人工结论和后续工具。
- 人类可读报告：`.wildarrange/reports/routing/latest.md`。
- 同日归档：`.wildarrange/reports/routing/YYYY-MM-DD.md`。

只读分析，不编辑 `routes.json`、配置、质量门或任务状态。建议必须等待人工确认。
