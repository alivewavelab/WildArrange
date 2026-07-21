# WildArrange 五区解耦重构 — 总结与交接文档

> 分支：`refactor/five-zone`（尚未合并进 `main`）。
> 原始方案：[doc/plans/2026-07-17-wildarrange-five-zone-refactor.html](./plans/2026-07-17-wildarrange-five-zone-refactor.html)（重构前批准的设计图）。
> 落地后的架构细节：[doc/project-architecture.md](./project-architecture.md)（本文件只讲"做了什么、为什么、还剩什么"，具体每个文件的职责以那份文档为准）。

## 一句话总结

把 WildArrange 从"一层 `src/helix-*.mjs` 平铺 + 互相乱 import"的结构，重构成 **interface → orchestration → ai / capabilities → infra** 五个单向依赖区，新增了一个能力网关（`capabilities/gateway.mjs`）和一条共享交付流水线（`orchestration/delivery-pipeline.mjs`），并用自动化测试把依赖方向锁死，同时保证所有旧代码路径、CLI 命令、`.helix/` 数据格式零破坏。

## 为什么要做这次重构

用户是不改代码的项目维护者，核心诉求是"以后改一个东西，不用来回猜它牵动了什么"。重构前的主要问题：

- `src/helix-*.mjs` 30 多个文件全部平铺在 `src/` 下，靠文件名猜职责，互相 import 没有方向约束。
- `runNextTask`（线性主流程）和并行子 Agent 的 admission 各自手写一遍"verify → scope → review → acceptance-proof → checkpoint"的门控序列，改一次门控要改两个地方。
- 想加一种新的检查（gate）时，不知道该往哪个文件塞，容易塞进已经很大的 `helix-gates.mjs`。

## 六个 Phase 做了什么

| Phase | 内容 | 对应 commit |
| --- | --- | --- |
| 0 | 基线修复：修 `bin/helix.mjs` 重复导入、加 CLI smoke test、commit 保护现场 | `5677f0c` |
| 1 | 建五区目录骨架 + `test/dependency-boundary.test.mjs` 边界测试 + `capabilities/gateway.mjs`、`orchestration/delivery-pipeline.mjs` 首版 | `579dbdd` |
| 2 | 把 `helix-gates.mjs` 物理拆成独立能力文件（verify / scope-guard / checkpoint / command-runner），接入 gateway | `55d9684` |
| 3 | 线性主流程 `runNextTask` 改成调用共享的 `delivery-pipeline`，不再手写门控序列 | `c0b089b` |
| 4 | AI 层（hooks、routing、injection、skill-matcher）从编排状态里独立出来 | 并入 Phase 5 的搬迁提交 |
| 5 | 把全部 30+ 个 `src/helix-*.mjs` 实体搬进五区目录，逐一修好 import，激活边界测试，旧路径转成两行兼容 shim | `98a2f7b` → `a3124db` → `78f480d` → `bf2578c` → `27ee1b6` |
| 6 | 收尾：`AGENTS.md` / `CLAUDE.md` / `doc/project-architecture.md` 目录约定同步成新路径 | `27ee1b6` |

## 最终目录结构（五区，依赖只能往下走）

```text
interface/       dashboard、adapters（Codex/Cursor 安装）、doctor（一键体检）
    ↓ 只能依赖
orchestration/   任务/计划状态、线性+并行运行时、delivery-pipeline、任务板、ChangeRequest、status
    ↓ 只能依赖
ai/              路由、ArchivistRouter、prompt 注入、skill matcher、agent 上下文、宿主 hooks
capabilities/    verify / scope-guard / worker / review-gate / code-intel / acceptance-proof / checkpoint + gateway
    ↓ 都只能依赖
infra/           foundation、ledger、security、command-runner/safety、git、rule-scanner、llm、memory-digest……
```

`ai/` 和 `capabilities/` 是同一层的两个兄弟区，谁都不能反过来依赖 `orchestration/`（除了 `ai/` 对 `orchestration/` 有一条特批的单向只读依赖，见下）。

## 三个关键设计决策

1. **能力网关（Capability Gateway）**：`orchestration/` 和 `ai/` 都不能直接 `import` 某个具体的检查文件（比如 `capabilities/verify.mjs`），必须走 `invokeCapability(name, ctx)`。每次调用都会拿到统一的六字段结果信封：`capability / status / evidence / sideEffect / duration_ms / cost / error`。好处：以后想加一种新检查，只要在 `capabilities/` 里新增文件 + 在 `gateway.mjs` 注册一行，编排层和 AI 层代码完全不用动。
2. **共享交付流水线（delivery-pipeline）**：`verify → scope → review → acceptance-proof → checkpoint` 这条门控顺序原来在线性主流程和并行子 Agent admission 里各写一遍，现在两边都调用同一个 `orchestration/delivery-pipeline.mjs`（线性在 `linear-runtime.mjs` 主循环，并行在 `parallel-runtime.mjs` 的 `finalizeAdmission` 里，均在任务状态锁内执行）。以后想调整门控顺序或加减一道门，只改这一个文件。
3. **依赖边界用测试锁死，不是靠文档口头约定**：`test/dependency-boundary.test.mjs` 会扫描 `src/` 下所有 `.mjs` 文件的 import 语句（提取前先剥掉注释，避免注释里的路径造成误报），按五区分类，凡是违反允许依赖表的都会让 `npm test` 直接失败。边界规则在复查后收紧为：
   - `ai → orchestration`（只读，hooks/context 需要读任务板和 attentionReport）和 `ai → capabilities`（仅经 gateway）是允许项；反方向永久禁止。
   - `orchestration → ai` 收紧为**逐条钉死的白名单**，目前只有一条边（`linear-runtime.mjs → ai/routing.mjs` 的 `routeRequest`，工作流 route 节点需要语义路由）；新增任何一条都得改测试里的白名单，是显式决策。确定性路由表读取（`loadRoutesConfig`/`resolveRouteDecision`）已下沉到 `infra/route-table.mjs`，`plan-state`/`task-board` 不再碰 `ai/`。
   - 五区文件**禁止 import 任何旧 `helix-*.mjs` shim**（shim 转发到分区文件，若放行等于给了绕过分区规则的洗白通道）；shim 只服务外部旧调用方。
   - 另有一个全图**模块级循环依赖检测**子测试，防止 `ai ↔ orchestration` 双向放行下悄悄长出真环。

## 兼容策略（这次重构承诺"零破坏"）

| 不变的东西 | 怎么保证的 |
| --- | --- |
| 所有旧的 `import ... from "./helix-xxx.mjs"` | 每个旧路径都留了一个两行的 `@deprecated` re-export shim，内容就是 `export * from "./<zone>/<file>.mjs"` |
| `src/helix-core.mjs` 这个兼容总入口 | 保留在原路径，继续汇总导出所有函数供 `bin/helix.mjs` 和外部旧调用方使用（五区内部文件已全部直连分区实现，不再经它中转） |
| CLI 命令和参数 | `bin/helix.mjs` 的子命令、参数语义完全没变 |
| `.helix/` 下的数据格式 | JSON schema、ledger 格式、snapshot 格式零改动 |
| 全部既有测试 | 109 个测试全程保持绿；重构过程每个 Phase 结束都跑一次 `npm test` |
| npm 包内容 | `npm pack --dry-run` 验证过，135 个文件正常打包 |

## 验证结果（最终状态）

- `npm test`：**109/109 全绿**。
- `npm pack --dry-run --cache /private/tmp/helix-npm-cache`：正常出包。
- 五区下每个 `.mjs` 文件单独 `import()` 都能独立加载，没有循环依赖、没有断链。
- `test/dependency-boundary.test.mjs` 五个子测试全部通过：①五区依赖方向合法 ②`orchestration`/`ai` 只能经 `gateway.mjs` 调 `capabilities` ③`capabilities` 不依赖 `ai` ④`orchestration → ai` 限定在钉死的白名单内 ⑤全 `src/` 无模块级 import 环。

## 已知遗留（下一个人接手时要知道的）

1. **`refactor/five-zone` 分支还没合并进 `main`**。是否合并、要不要开 PR 走 review，需要用户决定。
2. **旧 `src/helix-*.mjs` shim 还在，没有清理计划的时间表**。原方案里写的是"一个版本周期后删"，目前没有具体版本号绑定这件事；建议下次做一次全仓库 `grep` 统计还有多少地方在用旧路径 import，评估删除时机。
3. **`interface/` 区还缺 `cli.mjs` 和 `facade.mjs` 两个占位**（原方案图里画了，但 `bin/helix.mjs` 留在仓库根目录、`helix-core.mjs` 按项目治理规则留在 `src/` 根，没有物理搬进 `src/interface/`）。这是有意的：`AGENTS.md`/`CLAUDE.md` 明确把 `src/helix-core.mjs` 的路径写成治理约束，不属于本次重构范围。
4. **中间有一次会话被中断**，产生了一个叫 `initial` 的过渡 commit（`bf2578c`），内容就是几个 `git mv`，命名不规范但内容没问题，如果做 `git log` 整理/squash 时可以留意。

## 后续开发怎么改（"改 X 去哪改"速查）

| 我想改… | 去哪个文件/目录 | 绝对不要碰 |
| --- | --- | --- |
| 工作流顺序 / 重试 / 分支逻辑 | `src/orchestration/` | `capabilities/`、`ai/` 内部实现 |
| 门控顺序（加减一道 gate、调整顺序） | `src/orchestration/delivery-pipeline.mjs` | 具体某个能力内部逻辑 |
| AI 策略 / prompt / 技能匹配 / hooks | `src/ai/` | 编排顺序、具体检查逻辑 |
| 某个检查变严格/变宽松（比如 scope guard 规则） | `src/capabilities/` 对应文件 | 编排层、其它能力 |
| 新增一种检查能力 | `src/capabilities/` 新文件 + `capabilities/gateway.mjs` 里注册一行 | 编排层不需要改一行 |
| 账本 / 快照 / 配置 / 命令执行等底层设施 | `src/infra/` | 业务逻辑判断 |
| CLI / Dashboard / Codex-Cursor adapter | `src/interface/` | 不要往下反向依赖破坏分层 |

改完之后固定跑一遍：

```bash
npm test
npm pack --dry-run --cache /private/tmp/helix-npm-cache
```

`npm test` 里包含 `test/dependency-boundary.test.mjs`，如果改动引入了反向依赖，这里会直接报错并列出具体是哪个文件 import 了不该 import 的东西。
