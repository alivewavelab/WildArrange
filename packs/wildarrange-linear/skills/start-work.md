# start-work

## 目的

启动或恢复一个 WildArrange 计划：先读持久状态，再由 Jiuwei 推进。

## 入口条件

必须存在以下任一项：

- `.wildarrange/work.json` 中有 `activePlanId`。
- `.wildarrange/team/tasks.json` 存在。
- 通过 `wildarrange plan --from` 传入了计划 JSON。

如果没有计划，路由给 DiJiang。

## 恢复协议

1. 读取 `.wildarrange/work.json`。
2. 读取 `.wildarrange/team/tasks.json`。
3. 读取 `.wildarrange/ledger.jsonl`。
4. 判断状态：
   - 无 tasks -> 需要导入计划。
   - 有 pending runnable task -> Jiuwei run。
   - 有 in_progress/verifying task -> 从最新 ledger 证据恢复。
   - 有 failed task -> Jiuwei 决定 retry、BaiZe 或用户升级。
   - 全部 completed → 最终验证 / 报告。
5. 执行前写出紧凑状态摘要。

## 执行协议

运行：

```bash
node ./bin/wildarrange.mjs run
```

Jiuwei 必须处理完整的 worker -> verifier -> checkpoint/retry。不要绕过 Jiuwei 直接调用 worker。

## 完成协议

每次 run 后：

- 检查 `wildarrange status`。
- 读取任务板。
- 如果还有 pending runnable tasks，继续。
- 如果全部 completed，按需运行最终验证通道。
- 如果 blocked/failed，报告确切证据。

## 停止条件

只在以下情况停止：

- 全部任务完成。
- 没有 runnable task。
- 某任务超过 max attempts 后 failed。
- 需要 Jiuwei/user 决策。

不要因为一个 worker 返回 DoneClaim 就停止。
