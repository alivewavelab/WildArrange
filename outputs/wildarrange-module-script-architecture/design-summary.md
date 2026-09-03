# WildArrange 模块与脚本架构图 · Design Summary

- 最终产物：`doc/plans/2026-09-01-module-and-script-architecture.html`
- 风格：Fathom 深色精密信息图；signature device 为依赖总线与分区色标联动。
- 信息模型：CLI → Interface → Orchestration → AI / Capabilities → Infra → `.helix/`；五区模块板采用横向职责泳道，脚本与发布制品单独成轨。
- 交互：模块筛选、全文搜索、4 条运行链切换、统一底部抽屉、持久化 Tweaks。抽屉已升级为“输入载体 → 处理步骤 → 输出制品”，全部 23 个模块具备结构化契约；Adapter 额外含 Codex / Cursor / Kimi 18 行 Hook 事件矩阵。
- 事实来源：根 `AGENTS.md`、`module-file-map.json`、`package.json`、真实 CLI `--help --all`、实际 `src/**/*.mjs` 文件。
- 验证：74/74 运行时文件覆盖；两项 Omni 静态门通过；架构门通过；Node Playwright + Edge 桌面/移动渲染及交互通过。Adapter 抽屉为 5 输入 / 4 处理 / 5 输出 / 18 事件 / 4 owner；0 console/page errors、0 文本溢出、0 页面横向溢出。
- 已知限制：这是 2026-09-01 快照，不自动随仓库代码更新；长期产品总图仍以 `docs/product/architecture-overview.html` 为准。
