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
| 5 | 把全部 30+ 个 `src/helix-*.mjs` 实体搬进五区目录，逐一修好 import，激活边界测试，旧路径转成声明式 re-export 兼容 shim | `98a2f7b` → `a3124db` → `78f480d` → `bf2578c` → `27ee1b6` |
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

1. **能力网关（Capability Gateway）**：`orchestration/` 和 `ai/` 都不能直接 `import` 某个具体的检查文件（比如 `capabilities/verify.mjs`），必须走 `invokeCapability(name, ctx)`。每次调用都会拿到统一的七字段结果信封：`capability / status / evidence / sideEffect / duration_ms / cost / error`。新增改动的成本要分两种情况说：**新增一种"可调用能力"**（编排层按需调用）只要在 `capabilities/` 里新增文件 + 在 `gateway.mjs` 注册一行，编排层和 AI 层代码不用动；**新增一道"强制质量门"**（每个任务必须过）除了上面两步，还要在 `delivery-pipeline.mjs` 的步骤序列里加入它——但也仅此一处，线性主循环、并行 admission、单步 node 工作流都会自动跟上。
2. **共享交付流水线（delivery-pipeline）**：`verify → scope → review → acceptance-proof → checkpoint` 这条门控顺序原来在线性主流程和并行子 Agent admission 里各写一遍，现在统一收口到 `orchestration/delivery-pipeline.mjs`：线性主循环（`linear-runtime.mjs`）和并行 admission（`parallel-runtime.mjs` 的 `finalizeAdmission`）整条调用 `runDeliveryPipeline()`；单步 `node checkpoint` 工作流复用其中的完成段 `runCompletionSegment()`（acceptance-proof → checkpoint），并用 `collectGateEvidenceFromTask()` 按流水线自己的步骤清单回读各道门的证据，不再维护第二份门清单。两条完成性保障（均来自 2026-07-21 两轮交叉走查发现的 P0）：
   - **checkpoint 写入失败绝不会静默当成完成**：流水线检查 checkpoint 信封状态，失败时返回 `checkpoint_failed`，任务回 `pending` 并写失败报告、ledger 记 `checkpoint_write_failed`（网关会把能力抛出的异常吞成 fail 信封，所以必须查信封状态）。
   - **门控证据绑定执行轮**：每次新的 worker 运行（线性/单步 execute/并行 admission）都会清空 `last_verify_result` 等旧字段；`collectGateEvidenceFromTask()` 只认证据链上**位于最后一次 worker 记录之后**的门控证据（证据数组只追加，顺序即执行顺序）。上一轮全绿但 checkpoint 失败后，新一轮 execute 产出的工件必须重新过全部门，不能拿旧轮证据直接 checkpoint。
   - 配套的持久化保障：`persistTaskState()` 按"派生文件（tasks.md、plan 镜像）先写，权威 `tasks.json` 最后写"的顺序执行，`tasks.json` 是唯一读取源，充当提交点——派生写失败时任务状态不会半提交为 completed。
   - **完成事务顺序**（第三轮交叉走查 P0）：三条完成路径（线性 `task_verified`、单步 `node_checkpoint_completed`、并行 `parallel_agent_admission_completed`）统一为**完成 ledger 事件先写、权威 `tasks.json` 最后落盘**；并行的子 Agent `released` 生命周期更新也排在 ledger 与落盘之后。ledger 断供时任务保持可重跑状态，绝不会出现"状态已 completed / 子 Agent 已 released，但完成账目不存在"；反向的"账目多一条、状态未前进"由追加式账本天然容忍（重跑会补一条新事件）。
   - **恢复协议**（第四、五轮交叉走查逐步补齐；下面写清各场景的准确保障，不做笼统的"任何一步都幂等"承诺）：
     - **卡在 `verifying`**（ledger 完成事件已写、权威 `tasks.json` 未落盘）：`helix run` 发现没有 pending 任务但有 `verifying` 任务时，不再报 `blocked`，而是自动用单步 checkpoint 节点的裁决逻辑接管——本轮门控证据全绿就幂等补完（checkpoint/账目可重写重追加），证据缺失或过期就退回 `pending` 重新跑全流程；`in_progress` 任务刻意不碰（可能正被认领执行中）。
     - **并行 admission 是 claim 先行的**（第五轮 P0）：状态裁决、writable_paths 预检、任务 claim（置 verifying + 写入 admission 证据）、`parallel_agent_admission_started` 账目，全部在**同一把任务状态锁内、写任何工作区文件之前**完成，关掉了"检查与写文件之间"的竞态窗口。文件应用阶段的**任何失败**（写入报错、patch 失败、实际改动越界）都会回滚工作区并释放 claim：任务回 `pending` 并带 `admission_apply_failed` 失败记录，账目记 `parallel_agent_admission_apply_failed`，同一 run 修复后可直接重新 admit。
     - **并行任务已 completed、子 Agent 生命周期未 released**（释放写入失败）：重新 `parallel admit` 同一 run 会核验**链上是否存在该 run 的 completed 完成事件**——证据链上的 admission 记录不算数，因为失败后回滚的 run 也会留下同样的记录（第五轮 P1）。核验通过才只补做生命周期释放、不重新应用任何文件（返回 `resumed: true`）；任务是被别的途径完成的一律硬拒绝，且拒绝发生在碰任何文件之前。
     - **完成必备产物 vs 后置便利产物**（第五轮 P1）：wisdom 与 memory digest 写在完成事务**内部**（完成账目之后、权威落盘之前），写失败任务停在 `verifying`，恢复裁决会连它们一起重做，completed 任务不可能永久缺失它们；快照与 workflow summary 是提交后的便利产物，失败不回退完成状态，但会记 `completion_side_effect_failed` 账目并出现在返回值的 `sideEffectWarnings` 里，doctor 会晒出来。
     - **并行 run 不会失踪**（第五轮 P1）：run 在任何 Agent 启动前就预注册进 `index.json` 并写入 `running` 状态的批次 JSON；每次读 index 还会扫描 `agent-runs/` 目录，把有 result.json 却不在 index 里的孤儿 run 认领回来（记 `parallel_run_index_reconciled` 账目），落盘的结果不会对 `parallel status` 永久不可见。
3. **依赖边界用测试锁死，不是靠文档口头约定**：`test/dependency-boundary.test.mjs` 会扫描 `src/` 下所有 `.mjs` 文件的 import 语句，按五区分类，凡是违反允许依赖表的都会让 `npm test` 直接失败。扫描器经过两轮加固（第四、五轮交叉走查 P1）：词法状态机产出**掩码视图**——注释置空、字符串/模板/正则字面量的内容替换成哨兵字节（分隔符保留、`${}` 插值仍是代码）——import 语法只在掩码视图上匹配，所以字符串里的注释标记骗不了它（假阴性），文档字符串里写的 import 语句也不会被当成真实依赖（假阳性）；specifier 文本从原始源码切出并做转义解码，`"\u002e./ai/x.mjs"` 会被识别为它真正指向的相对路径；另有一个子测试把 `src/` 内允许的 specifier 限定为相对路径、裸包名和 `node:` 内建——`file:`/`data:` URL 和绝对路径（能加载真实模块但对静态扫描不透明）一律拒绝。对抗样例都固化成了回归子测试。边界规则在复查后收紧为：
   - `ai → orchestration`（只读，hooks/context 需要读任务板和 attentionReport）和 `ai → capabilities`（仅经 gateway）是允许项；反方向永久禁止。
   - `orchestration → ai` 收紧为**逐条钉死的白名单**，目前只有一条边（`linear-runtime.mjs → ai/routing.mjs` 的 `routeRequest`，工作流 route 节点需要语义路由）；新增任何一条都得改测试里的白名单，是显式决策。确定性路由表读取（`loadRoutesConfig`/`resolveRouteDecision`）已下沉到 `infra/route-table.mjs`，`plan-state`/`task-board` 不再碰 `ai/`。
   - 五区文件**禁止 import 任何旧 `helix-*.mjs` shim**（shim 转发到分区文件，若放行等于给了绕过分区规则的洗白通道）；shim 只服务外部旧调用方。
   - 另有一个全图**模块级循环依赖检测**子测试，防止 `ai ↔ orchestration` 双向放行下悄悄长出真环。

## 兼容策略（这次重构承诺"零破坏"）

| 不变的东西 | 怎么保证的 |
| --- | --- |
| 所有旧的 `import ... from "./helix-xxx.mjs"` | 每个旧路径都留了一个 `@deprecated` 的**声明式 re-export shim**（不含任何业务逻辑）。多数是一行 `export * from "./<zone>/<file>.mjs"`；个别旧模块（如 `helix-gates.mjs`、`helix-review.mjs`）的实现被拆进了多个分区文件，shim 相应是多行聚合/具名 re-export，这是允许的——约束是"只准声明式转发、不准写逻辑"，不是行数 |
| `src/helix-core.mjs` 这个兼容总入口 | 保留在原路径，继续汇总导出所有函数供 `bin/helix.mjs` 和外部旧调用方使用（五区内部文件已全部直连分区实现，不再经它中转） |
| CLI 命令和参数 | `bin/helix.mjs` 的子命令、参数语义完全没变 |
| `.helix/` 下的数据格式 | JSON schema、ledger 格式、snapshot 格式零改动 |
| 全部既有测试 | 重构起点 109 个测试全程保持绿（五轮交叉走查修复后新增至 134）；重构过程每个 Phase 结束都跑一次 `npm test` |
| npm 包内容 | `npm pack --dry-run` 验证过，正常打包（文件数随修复微增，以最新一次输出为准） |

## 验证结果（最终状态）

- `npm test`：**全绿**（五轮交叉走查修复后 134 个测试，具体数字以 `npm test` 输出为准）。
- `npm pack --dry-run --cache /private/tmp/helix-npm-cache`：正常出包。
- 五区下每个 `.mjs` 文件单独 `import()` 都能独立加载，没有循环依赖、没有断链。
- `test/dependency-boundary.test.mjs` 九个子测试全部通过：①五区依赖方向合法 ②`orchestration`/`ai` 只能经 `gateway.mjs` 调 `capabilities` ③`capabilities` 不依赖 `ai` ④`orchestration → ai` 限定在钉死的白名单内 ⑤动态 `import()` 的**整个参数必须是单一字符串字面量**（`import(变量)`、模板字符串、`import("…" + "")` 拼接等对静态扫描不可见的写法一律拦截）⑥specifier 只允许相对路径/裸包名/`node:` 内建（`file:`/`data:`/绝对路径拒绝）⑦掩码扫描不被字符串里的注释标记欺骗（含对抗样例回归）⑧字符串里的 import 文本不算依赖、转义 specifier 会被解码（含对抗样例回归）⑨全 `src/` 无模块级 import 环。
- `test/checkpoint-integrity.test.mjs`：19 个故障注入用例，覆盖 checkpoint 写失败（流水线/线性/单步/并行四条路径）、验收证明能力抛异常、**跨执行轮证据复用**（旧轮门控证据不得为新轮工件作证）、**持久化提交点**（派生文件写失败时权威 `tasks.json` 不得前进）、**完成账目断供**（ledger 只读时线性/单步/并行三条路径都不得产生 completed/released，修复后可正常续跑）、**中断事务的可见与自愈**（doctor 能报出孤立完成事件与派生分叉，`run` 能自动裁决卡在 `verifying` 的任务，且证据不全时只会退回 pending 不会盖章）、**并行 admission 恢复语义**（半应用失败回滚工作区并释放 claim、同一 run 修复后可重 admit；生命周期写失败后重 admit 只补释放、不重写文件；失败过的 run 不能假冒 resume；被别的途径完成的任务在碰任何文件之前就被拒绝）、**完成产物分级**（wisdom 写失败任务停在 verifying 可自愈；提交后快照失败不回退完成但留下账目痕迹）、**孤儿 run 认领**（index 丢失后 `parallel status` 能重新发现并照常 admit）。
- `helix doctor` 的完成审计除了"completed 但缺完成证据"，还反向检查**孤立完成事件**（任务未 completed、账本却已有完成事件——即被打断的完成事务，报 warn 并给出 `helix run` 恢复指引）、**完成后置副产物失败**（`completion_side_effect_failed` 账目逐条晒出）和 **canonical/派生分叉**（plan 镜像、`tasks.md` 的任务状态与权威 `tasks.json` 不一致时逐条报出）。

## 架构决策变更记录（对照原批准方案）

原方案（`doc/plans/2026-07-17-wildarrange-five-zone-refactor.html`，已在文首加"部分被替代"标注）规定严格单向：AI 只能依赖 Infra、AI 与 Capabilities 同级互不依赖。实施到 Phase 4/5 时发现两处放宽是必要的，均已写进边界测试的注释并由测试强制：

| 变更 | 原方案 | 实施决策 | 理由 |
| --- | --- | --- | --- |
| AI → Orchestration | 禁止 | 允许（只读） | `ai/hooks.mjs`、`ai/context.mjs` 必须读任务板/attentionReport 才能决定注入什么、拦截什么；完全剥离需把宿主钩子整体上提到编排层，成本与收益不成比例 |
| AI → Capabilities | 禁止（同级互不依赖） | 允许（仅经 gateway） | 钩子的 scope 预检必须与编排层用同一条能力封缝，否则会出现第二份 scope 逻辑 |
| Orchestration → AI | 允许（不设限） | 收紧为逐条钉死的白名单（现仅 1 条边） | 双向放行后必须防耦合扩散；配套全图模块级循环检测 |

因此本架构的准确称呼是**"五区受控依赖 + 无模块级循环（测试强制）"**，不是"严格单向"。

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
