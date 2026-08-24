# `src/` 开发总则

本文件适用于 `src/` 下全部代码；进入具体分区后，继续遵守该目录自己的 `AGENTS.md`。根目录 [`AGENTS.md`](../AGENTS.md) 仍是最高层项目规范，子目录文件只做渐进式补充，不覆盖根级安全不变量。

## 先判断归属

| 变化内容 | 归属 |
| --- | --- |
| CLI、Dashboard、Codex/Cursor/Kimi adapter、人机协议 | `interface/` |
| 流程顺序、重试、状态推进、事务、质量门编排 | `orchestration/` |
| 路由、prompt、上下文、Skill、Hook 策略 | `ai/` |
| verifier、scope、review、checkpoint 等原子能力 | `capabilities/` |
| 文件、锁、命令、Git、配置、ledger 等技术底座 | `infra/` |

无法用一句话说明归属时，先拆清职责，不要直接新建“综合模块”。

## 全区不变量

- 五区依赖方向以根 `AGENTS.md` 和 `test/dependency-boundary.test.mjs` 为准。
- `src/` 根目录不放运行时 `.mjs` 文件；所有实现必须归属五区，不建立兼容 shim 或综合 barrel。
- 禁止非字面量动态 `import()`、模块级 import 环、绝对路径或 `file:` / `data:` 模块加载。
- `orchestration/` 与 `ai/` 调用原子能力时，只能进入 `capabilities/gateway.mjs`。
- 不得削弱 verifier、scope、review、success criteria、acceptance proof、checkpoint 完成链。

## 修改顺序

1. 先在所属分区的 `AGENTS.md` 确认职责和允许依赖。
2. 修改实现及对应自动测试。
3. 新增跨区边时，先更新根规范和依赖边界测试，再改实现。
4. 新增运行时模块或改变架构职责时，同步更新 `doc/project-architecture.md`、根 `AGENTS.md` 目录约定，并登记 `tooling/arch-module-graph/module-file-map.json` / `docs/product/architecture-overview.html`。
5. 至少运行相关测试；交付前运行 `npm test`。包内容变化时再运行 `npm pack --dry-run --cache /private/tmp/helix-npm-cache`。总图相关改动再跑 `npm run check:arch`。
