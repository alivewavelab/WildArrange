# 测试目录规范

本目录证明运行时与架构约束真实成立，不负责替实现兜底。

## 测试层级

- 单元测试：原子函数、纯判断与结果信封。
- 集成测试：CLI、adapter、delivery pipeline、Dashboard 与状态持久化。
- 对抗/故障注入：ledger、checkpoint、锁、apply、rollback、并发与恢复。
- 包体冒烟：`npm pack` 后真实安装并运行公开 CLI。

## 硬规则

- 发现实现违反依赖边界时修实现，不得为求绿放宽 `dependency-boundary.test.mjs`。
- 新的跨区例外必须先有书面理由，再增加最窄文件级白名单。
- 测试必须断言持久状态与证据，不能只断言函数返回值。
- 失败路径要证明没有 checkpoint、没有错误释放 owner、没有留下越界写入。
- 时间、并发和端口测试应使用隔离临时目录/端口，不依赖开发者现有 `.wildarrange/`。
- 环境沙箱导致的 `EPERM` 与真实断言失败必须区分；交付前在允许所需本地能力的环境重跑。

## 交付命令

```bash
npm test
npm pack --dry-run --cache /private/tmp/wildarrange-npm-cache
```

只改文档也要检查命令、路径和中英文示例是否一致；包内容变化时必须执行包体预检。
