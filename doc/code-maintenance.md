# WildArrange 代码维护规范

> 本文承接根 AGENTS 的代码维护要求；由根入口在修改文件前要求读取，仍属于项目规范。代码路径均相对仓库根。

## 代码维护规范

- 项目按五区分层：`interface/ → orchestration/ → ai/ / capabilities/ → infra/`，新增功能必须先归属到对应区目录；无合适归属时才新增顶层 `src/<zone>/wildarrange-*.mjs`。
- `bin/` 是五区之上的 CLI 组合入口，只做参数解析与命令路由；它可以直接 import 五区中的真实 owner，但不得承载业务流程、复制实现或引用 `src/` 根级转发文件。
- 依赖方向只能从上往下：`interface` 可依赖 `orchestration`/`infra`；`orchestration` 可依赖 `ai`/`capabilities`/`infra`，其中 `orchestration → ai` 限定在 `test/dependency-boundary.test.mjs` 钉死的白名单边（目前仅 `linear-runtime.mjs → ai/routing.mjs`），新增必须显式改白名单；`ai` 可依赖 `orchestration`/`capabilities`/`infra`（`ai → orchestration`、`ai → capabilities` 均只读，且 `ai → capabilities` 必须走 `capabilities/gateway.mjs`）；`capabilities` 只能依赖 `infra`；`infra` 不依赖任何上层。反向依赖与模块级 import 环由 `test/dependency-boundary.test.mjs` 强制拦截，不得为了让测试变绿而放宽这些规则。
- `orchestration/` 和 `ai/` 都不得直接 import 具体能力实现文件（`capabilities/verify.mjs` 等），必须统一经 `capabilities/gateway.mjs` 的 `invokeCapability(name, ctx)`。
- 单文件默认保持 1000 行以内；超过 700 行必须评估是否按职责拆分。
- `src/` 根目录不放运行时 `.mjs` 文件；实现与公开 owner 必须位于五区目录，不建立兼容 shim 或综合 barrel。
- `src/` 下未知一级目录必须被依赖边界门直接拒绝；不保留 `legacy` 免检分区。
- 规范采用渐进式披露：根 `AGENTS.md` 保存必读场景与入口，其引用的规范正文承载全局目标与不可削弱不变量；`bin/`、`src/`、五区、`test/`、`doc/`、`packs/wildarrange-linear/` 的 `AGENTS.md` 只补充本目录职责和验收要求。进入目录修改前先读最近的 `AGENTS.md`，子目录规范不得覆盖根级安全约束。
- 新增运行时能力必须更新 `doc/project-architecture.md`，包括其「目录约定」中的职责登记。
- gate 安全不变量不能削弱：不得删除或清空 `verify_commands`，不得跳过 verifier / scope / review / successCriteria 完成 checkpoint。
- README 命令真实性必须对照真实 CLI `--help`，不得以源码中的注释或普通字符串充当实现证据；真实注释检查必须覆盖 JavaScript 模板表达式。
- 产品总图位于 `docs/product/architecture-overview.html`；新分区或新运行时模块必须同步登记 `tooling/arch-module-graph/module-file-map.json` 并更新总图。新脚本必须由映射表归属；总图的输入/输出必须来自真实导出签名或代码证据，不得编造。
- 总图交互固定为“点模块卡片 → 底部抽屉”，不为单个大模块增加第二种展开方式；顶部页签只按真实用户作业切片，不按引擎或网关类型堆目录。
- 总图门禁豁免测试文件、`index.*`、`mod.rs`、`__init__.py`、`*.types.*`、生成目录与 D 字典的目录节点；其余改动后运行 `npm run check:arch`。
- 重构后必须验证 `npm test`；该命令由 `tooling/run-tests.mjs` 逐文件隔离执行全部 `test/*.test.mjs`，避免 Windows 上 Git/npm/嵌套测试并发互锁。涉及包内容变化时同时验证 `npm pack --dry-run --cache /private/tmp/wildarrange-npm-cache`。
