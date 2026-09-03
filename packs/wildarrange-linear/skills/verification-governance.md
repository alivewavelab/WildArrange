# verification-governance

## 目的

把老项目已有的测试、Gate、Runner、Hook 和历史文档盘点成可判对的变更卡。用户逐卡批准后，WildArrange 才执行接管，并持续提示 Registry 新鲜度。

## 入口条件

- 目标是已经存在验证资产的老项目仓库。
- 用户明确要求接管、盘点或重新生成 Registry、Bootstrap、Inventory。
- 普通 `run`、Hook 和日常完成链不得静默触发全仓扫描。

## 执行协议

只调用真实产品命令，不发明第二套批准 CLI：

```bash
node ./bin/wildarrange.mjs adoption start
node ./bin/wildarrange.mjs adoption status
node ./bin/wildarrange.mjs adoption resume
node ./bin/wildarrange.mjs adoption recover
```

1. `start` 只读扫描并打开 Dashboard，业务文件必须保持不变。未传 `--token` 时，CLI 自动生成本次专用随机口令，并通过 URL fragment 注入当前标签页。
2. 用户在 Dashboard 逐卡批准、拒绝或暂缓。带验证命令的卡片，以及 archive、merge、AGENTS、CI、Hook 或配置变化，必须单独批准。
3. 消费者未知的卡片不提供合并、归档或删除。V1 不执行物理删除；证据不足的历史文件只能暂缓。获批 archive 默认进入 `docs/verification-archive/`，不进入 `.wildarrange/`。
4. Apply 一次只施工一张已批准卡；失败回滚本卡。成功回滚后释放维护锁，回滚失败则进入 `recovery_required`。
5. Registry 与 locator 生成后等待用户自行 commit A；不得自动 commit、merge 或 push。
6. commit A 内容校验通过后生成 Bootstrap 与可直接打开的 Inventory HTML，再等待用户自行 commit B。
7. 中断后运行 `resume`，按已有 transaction manifest 续跑，不重新捕获 preimage。
8. `recovery_required` 时运行 `recover`；Dashboard 的“对账”按钮也会进入恢复。只有 preimage 恢复成功后才释放维护锁。
9. 完成后用 `doctor` 或 `status` 查看 `registryFreshness` 黄灯；过期只提醒，不阻断日常 run。

## 完成协议

- 会话状态为 `finalized`，或用户在尚未修改业务文件前明确取消。
- 三文件路径来自已批准 locator，不使用 Gamecopilot 专属目录。
- 三个目标名称被已有文件、目录或链接占用时必须暂停并解释冲突，不得覆盖或自行改名。
- 一旦存在已生效改动，禁止用“取消会话”冒充恢复；应完成 Git 锚定，或在恢复态执行 `recover`。
- Hook 不得改成静默全仓扫描。

## 停止条件

- 会话处于 `recovery_required` 且 `recover` 仍失败：保留维护锁和恢复证据，按 `nextAction` 处理。
- 活动 run 或 admission 正在写同一仓库：等待其结束。
- 用户在任何业务写入前取消会话。
