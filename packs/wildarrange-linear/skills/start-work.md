# start-work

## 目的

启动或恢复一个 WildArrange 计划：先读持久状态，再交给 YingLong 执行。

## 入口条件

必须存在以下任一项：

- `.helix/work.json` 中有 `activePlanId`。
- `.helix/team/tasks.json` 存在。
- 通过 `helix plan --from` 传入了计划 JSON。

如果没有计划，路由给 DiJiang。

## 恢复协议

1. 读取 `.helix/work.json`。
2. 读取 `.helix/team/tasks.json`。
3. 读取 `.helix/ledger.jsonl`。
4. 判断状态：
   - 无 tasks -> 需要导入计划。
   - 有 pending runnable task -> YingLong run。
   - 有 in_progress/verifying task -> 从最新 ledger 证据恢复。
   - 有 failed task -> Jiuwei 决定 retry、BaiZe 或用户升级。
   - 全部 completed -> final verification / report。
5. 执行前写出紧凑状态摘要。

## 执行协议

运行：

```bash
node ./bin/helix.mjs run
```

YingLong 必须处理完整的 worker -> verifier -> checkpoint/retry。不要绕过 YingLong 直接调用 worker。

## 完成协议

每次 run 后：

- 检查 `helix status`。
- 读取任务板。
- 如果还有 pending runnable tasks，继续。
- 如果全部 completed，按需运行 final verification lanes。
- 如果 blocked/failed，报告确切证据。

## 停止条件

只在以下情况停止：

- 全部任务完成。
- 没有 runnable task。
- 某任务超过 max attempts 后 failed。
- 需要 Jiuwei/user 决策。

不要因为一个 worker 返回 DoneClaim 就停止。
