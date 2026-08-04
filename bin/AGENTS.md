# CLI 入口规范

`bin/helix.mjs` 只负责参数解析、命令路由、输出格式和退出码。

- 新命令必须调用已有分区公开函数，不在 CLI 内实现业务流程或原子能力。
- 命令名、参数、默认值与错误提示发生变化时，同步更新中英文 README、CLI `--help` 和 CLI smoke test。
- 破坏性或用户级配置操作必须保持显式，不得由普通项目命令静默触发。
- `handoff prepare` 必须使用 `--to-device-id <uuid>` 绑定目标，设备名只能作为展示字段；`handoff takeover` 必须显式要求 `--expected-device-id <uuid>` 与 `--reason`。CLI 不得提供 force push 或自动过期 owner 的入口。
- CLI 必须继续使用 Node.js ESM 和内置能力，不引入外部 npm 依赖。
- `bin/` 只允许 `.mjs` 入口文件（依赖边界测试按 `.mjs` 扫描）；新增其他扩展名的入口前必须先扩展扫描。
- 变更后至少运行 CLI smoke test；交付前运行完整 `npm test`。
