# WildArrange 项目架构

> 可复用的五区规则见 [five-zone-decoupling-guidelines.md](./five-zone-decoupling-guidelines.md)。重构历史与交接说明见 [2026-07-21-five-zone-refactor-handoff.md](./2026-07-21-five-zone-refactor-handoff.md)。

## 运行时形态

代码库按五个依赖区分层。依赖只能自上而下流动；`test/dependency-boundary.test.mjs` 在每次 `npm test` 时强制校验，因此这不只是示意图。

```text
bin/helix.mjs
  -> 五区中的真实 owner（CLI 是组合入口，不经 barrel）
  -> src/interface/*      (dashboard, adapters, doctor — host/human-facing edge)
       -> src/orchestration/*, src/infra/*
  -> src/orchestration/*  (workflow order, retry, gate sequencing)
       -> src/ai/*, src/capabilities/* (via gateway only), src/infra/*
  -> src/ai/*             (routing, injection, skills, hooks, context)
       -> src/orchestration/* (read-only), src/capabilities/* (via gateway only), src/infra/*
  -> src/capabilities/*   (verify, scope-guard, worker, review-gate, checkpoint, acceptance-proof, gateway)
       -> src/infra/*
  -> src/infra/*          (runtime store/config/bootstrap, ledger, security, command runner/safety, git, rules, llm, memory, ...)
  -> packs/wildarrange-linear/*
  -> .helix/*
```

`src/` 根目录不再承载运行时 `.mjs` 文件。项目尚未形成需要维护的历史 JavaScript API，因此 CLI、测试和模块调用方都直接 import 五区中的真实 owner，不建立兼容 shim 或综合 barrel。

## Agent 与 Skill 模型

WildArrange 恰好有五个长期 Agent：Jiuwei（编排与线性交付）、DiJiang（计划）、ZhuRong（实现）、BaiZe（独立复核）、LuWu（只读仓库治理）。manifest、根 config 与确定性路由结果在机器层强制这一白名单。Router 是唯一系统节点，不是第六个 Agent。CangJie 是可选的内部 ArchivistRouter/语义 shadow profile，不能进入长期 manifest 或确定性路由。产品意图、用户旅程、验收设计、UX 复核、范围权衡、领域调研、代码检查、外部调研、风险复核与怀疑式验收，均以 Skill 形式挂载到上述长期角色上。

## 仅 Git 的多设备协调

跨设备状态通过现有 Git remote 协调，而非中心服务。`.helix/` 保持本地；共享的持久事实是 `wildarrange/task/<planId>/<taskId>` 上不可变的协调 commit。

```text
device identity
  -> unique remote claim commit
  -> one writable owner + isolated worktree
  -> handoff offer commit + non-force push
  -> target-device UUID accept commit
  -> admission fetches expected remote integration SHA
  -> ownership + local-base + remote-SHA revalidation
  -> acceptance proof
  -> integration commit + non-force push
  -> durable checkpoint
```

`gitCoordination.mode` 可选 `off`、`manual`、`guarded`（默认）或 `strict`。`guarded` 在有 remote 时启用远端 ownership 与 worktree 隔离，否则报告本地降级。`strict` 强制 Git、remote、worktree 隔离、干净 handoff 与 handoff 前验证。任何启用配置都不得允许双写 owner、force push、基于时钟的自动 takeover、未 push 的跨设备 handoff，或在 integration SHA 过期后 checkpoint。

协调 commit 用 `git commit-tree` 构建。handoff 准备使用临时 index，包含工作区变更与尚未出现在远端 task 分支上的本地已提交变更，且限于 `writable_paths` 允许的路径；`.helix/` 始终排除，开发者当前 index 不被触碰。准备的 tree SHA 会持久化，并在 push 前立即重算，因此 `prepare` 与 `push` 之间的编辑需要重新 prepare。packet 为带 SHA-256 digest（在 commit trailer 中）的 base64url JSON；接受方设备在发布普通 fast-forward acceptance commit 前验证 digest、目标设备 UUID、当前 remote HEAD 与干净工作区。push、accept、takeover 重试能识别自身已发布的 packet，并回填本地 task/audit 状态。

并行 admission 在应用子 Agent 结果前捕获并 fetch 远端 integration SHA。在 gate 之前及完成之前，它会再次检查 task ownership、验证 guarded SHA 是否为当前工作区祖先、确认远端 integration 分支未移动，并拒绝未归因于子 Agent 结果或已接受 handoff 的候选路径。gate 与 acceptance proof 全部通过后，创建以 guarded remote SHA 为父提交的临时 index integration commit，并普通 push（非 force）。只有此后本地 checkpoint 才能完成。远端移动、本地基线过期或无归属脏路径时，仅回滚本 run 的文件并返回 `revalidation_required`。一旦已知 integration push 成功，之后任何本地失败、ownership 变化、main 后代 commit 或异常历史都会使 claim 与 intent 处于 `recovery_required`；禁止回滚与释放 ownership。

## 五区分层

| 区 | 目录 | 职责 | 允许依赖 |
| --- | --- | --- | --- |
| Interface | `src/interface/` | Dashboard HTTP API、Codex/Cursor/Kimi adapter 安装、`doctor` 体检报告——任何人或宿主 IDE 直接交互的边界 | `orchestration`, `infra` |
| Orchestration | `src/orchestration/` | 任务/计划状态、线性 + 并行运行时循环、共享 `delivery-pipeline`、任务板、变更治理、status/attention 报告 | `ai`（仅白名单边）、`capabilities`（仅 gateway）、`infra` |
| AI | `src/ai/` | 路由、ArchivistRouter、prompt 注入、skill matcher、Agent 上下文构建、宿主生命周期 hook | `orchestration`（只读）、`capabilities`（仅 gateway）、`infra` |
| Capabilities | `src/capabilities/` | 原子 gate 本身（verify、scope-guard、worker、review-gate、code-intel、repository-governance、acceptance-proof、checkpoint）及 `gateway.mjs`——上层调用方必须经此单一接缝 | `infra` |
| Infra | `src/infra/` | runtime-store、agent-registry、runtime-config、task-state-lock、runtime-snapshot、prompt-pack、runtime-bootstrap，以及 ledger、security、command-runner/safety、git diff/worktree、rule scanner、LLM provider、memory digest、path matching、success criteria、task predicates | 不依赖上层 |

除简单分层外还有七条不变量，均由 `test/dependency-boundary.test.mjs` 检查：

1. **仅经 gateway 访问 capability。** `orchestration/` 与 `ai/` 不得直接 `import` capability 实现文件（如 `capabilities/verify.mjs`）——必须调用 `capabilities/gateway.mjs` 的 `invokeCapability(name, ctx)`。每个 gate 结果经同一七字段信封报告（`capability`, `status`, `evidence`, `sideEffect`, `duration_ms`, `cost`, `error`）。新增*可调用 capability* 只需改实现文件 + gateway 一行注册；新增*强制质量 gate* 还需在 `orchestration/delivery-pipeline.mjs` 的步骤序列中插入——且仅在此处：线性循环、并行 admission 与单步 node workflow 都遵循 pipeline 定义。
2. **`ai` ↔ `capabilities` 单向。** `ai/` 可经 gateway 调用 `capabilities/`（hook 与 context builder 需要与 orchestration 同样问「路径是否在范围内」）。`capabilities/` 永远不得 import `ai/`——该方向永久阻断。
3. **钉死的 `orchestration -> ai` 边列表。** 因允许 `ai -> orchestration`，两区耦合通过测试中显式命名每条 `orchestration -> ai` 边来约束（目前仅 `linear-runtime.mjs -> ai/routing.mjs` 用于 workflow 的「route」节点）。确定性路由表读取在 `infra/route-table.mjs`，计划导入与任务板完全不触 ai 区。
4. **`src/` 根目录不得放运行时 `.mjs`。** 所有实现必须归属五区，防止用根级 barrel 或 shim 绕开 owner 与依赖规则。
5. **`src/` 内任意位置不得有模块级 import 环**，防止在互允许的 `ai`/`orchestration` 对内悄悄形成真环。
6. **`src/` 内禁止非字面量动态 import**：每个动态 `import()` 的整个参数必须是单一纯字符串字面量。变量、模板字面量与 `import("../x.mjs" + "")` 等拼接对静态 import 扫描不可见，可能在运行时走私反向区依赖，因此一律拒绝。
7. **CLI 只做组合。** `bin/` 可直接 import 五区真实 owner，但不得复制业务实现、创建根级聚合入口或绕过运行时质量门。

扫描器本身经对抗加固：词法状态机为每个源文件生成掩码视图——注释 blank、字符串/模板/正则字面量内容替换为 sentinel 字节（定界符保留，`${}` 插值仍为代码）——import 语法只在掩码视图上匹配，因此字符串内的注释标记或文档中引用的 import 语句都不会误导边构建（假阴性与假阳性均防）。specifier 文本从原源码切片并在区分类前 unescape 解码，故 `"\u002e./ai/x.mjs"` 计为其真实相对路径；配套子测试还限制 `src/` 内所有 specifier 为相对路径、裸包名与 `node:` 内置模块——`file:`/`data:` URL 与绝对路径（加载真实模块却对静态扫描不透明）一律拒绝。对抗样本由同文件回归子测试钉死。

## 渐进式治理加载

项目规则使用嵌套 `AGENTS.md`，Agent 先收到全局不变量，进入相关目录时才收到局部工作规则。

```text
AGENTS.md                         # product goals, global boundaries, release gates
  bin/AGENTS.md                   # CLI-only rules
  doc/AGENTS.md                   # documentation hierarchy and parity
  packs/wildarrange-linear/AGENTS.md
  src/AGENTS.md                   # five-zone routing and shared source invariants
    interface/AGENTS.md
    orchestration/AGENTS.md
    ai/AGENTS.md
    capabilities/AGENTS.md
    infra/AGENTS.md
  test/AGENTS.md                  # test evidence and anti-weakening rules
```

嵌套文件是附加性的。它们可收窄目录职责并规定局部证据，但不得放松根级的依赖、gate、安全、测试或商业发布约束。这使根宪法稳定，同时将实现相关指引放在其治理的代码旁。

## 主要文件

- `bin/helix.mjs`：CLI 路由。
- `src/infra/runtime-store.mjs`：运行时路径、时间/ID、目录创建、JSON 原子写、持久化 task-status 枚举与 hash 原语。
- `src/infra/file-lock.mjs`：`.helix/team/tasks.lock` 与 `.helix/ledger.lock` 背后的共享文件锁原语。stale 锁自愈：owner pid 已死则立即 stale；空/不可解析 owner 文件在短 mtime 宽限后 stale。锁超时可诊断——错误给出当前 owner 标签、pid、pid 存活、获取时间与等待预算，便于粘贴给 AI 立即看出谁持锁。
- `src/infra/task-state-lock.mjs`：全局任务状态锁（`.helix/team/tasks.lock`），`file-lock.mjs` 的路径/默认参数封装。所有调用方在其上串行，为线性 run 与并行 admission 提供工作区级互斥。
- `src/infra/agent-registry.mjs`：固定长期 Agent 白名单、读写角色集、旧别名、显示名、归一化与 command-worker 资格。
- `src/infra/runtime-config.mjs`：默认配置、分层根/运行时 config 加载、归一化、深合并与不可削弱的 strict Git 协调标志。
- `src/infra/runtime-snapshot.mjs`：运行时 snapshot 持久化与 resume-context JSON/Markdown 渲染的唯一确定性 owner。`src/ai/context.mjs::writeContextSnapshot` 是其薄 public 包装，非第二套实现。
- `src/infra/prompt-pack.mjs`：prompt-pack 注册安装、固定运行时副本物化、条目加载、内容 hash、列表与校验渲染。外部/custom pack 先校验 source realpath，再复制到 `.helix/prompt-pack/installed`；运行时 Agent、Skill、routes、tool 与 matcher 全部只从这个固定根读取，不信任 registry 中可修改的根路径字段。
- `src/infra/runtime-bootstrap.mjs`：跨 config、work、prompt pack、ledger 与 snapshot 的一次性 `initRuntime` 顺序。长期 Agent 配置只保留在权威 config，不再生成无消费者的 `agents.json` / `categories.json` 投影。
- `src/interface/project-init.mjs`：只在显式 `init --project-docs` 时从发布包模板补建缺失治理文档，使用独占创建保证已有文件不被合并或覆盖，架构模板还需显式 `--architecture`。
- `src/infra/ledger.mjs`：hash 链 ledger 追加、ledger 校验与校验条目读取。hash 链启动后，无 hash 的追加行报告为篡改；`doctor` 仅接受链校验条目作为完成证据。追加在尾部损坏时 fail-closed（无效 JSON、链启动后的无 hash 尾行、或相对尾缓存的文件缩小会拒绝追加而非静默分叉链）；`.helix/ledger-tail.json` 的 size+hash 缓存使重复追加 O(1)，全扫描为 fallback；`verifyLedger` 仍是唯一权威。
- `src/interface/adapters.mjs`：Codex/Cursor/Kimi adapter 安装、卸载、恢复、报告、备份逻辑、Codex `.codex/hooks.json` 生成、Cursor hooks+rule 生成、Kimi plugin 生成与共享 command Skill 生成。
- `src/interface/kimi-adapter.mjs`：Kimi plugin manifest、项目感知 Hook bridge 与 Kimi 安装/readme 说明的纯渲染。Kimi 专用协议翻译留在此，不进入 workflow core。
- `src/interface/cursor-adapter.mjs`：Cursor `.cursor/hooks.json` 配置、项目感知 Hook bridge（camelCase 事件/工具映射、`permission`/`additional_context`/`followup_message` 输出协议）与 Cursor 安装/readme 说明的纯渲染。Write/Delete/Edit/Shell 的 `preToolUse` 与集成终端命令的 `beforeShellExecution` 为 fail-closed；bridge 将任何非显式 allow 决策视为 deny。
- `src/interface/hook-bridge-core.mjs`：两类 Hook bridge 共享的项目发现、CLI 子进程启动、stdout/stderr 收集与 JSON 解析模板。Cursor 显式传入 25 秒第二保险并由本地 `failHook` 实施 fail-closed；Kimi 显式不配置自毁定时器，保持宿主 timeout 后 fail-open 的合同，二者输出协议仍由各 adapter 自己翻译。
- `src/orchestration/change-governance.mjs`：转向提案、review blocker、ChangeRequest 复核与显式 accept/reject 决议。
- `src/infra/failure-analysis.mjs`：失败原因分类、重试提示与可行动失败摘要。
- `src/capabilities/acceptance-proof.mjs`：checkpoint 证明链，在完成前校验 worker、verifier、success criteria、scope、review 与 review 通道；还拒绝 worker 与 verify 命令全为 trivial 且无 writable_paths 的 no-op 任务，并失败于 `verify_commands` 全 trivial 的任务（`verify_not_trivial`——trivial 验证证明不了任何事）。第二硬底线是 `review_not_tautological`：review gate 无独立信号通道（无 `review_commands` / `standards_commands` / `review.llm` / 启用的质量 gate——与 `infra/gate-arming.mjs` 的 `hasRealReviewLane` 同谓词）的任务不能到 `completed`，因为同义反复的 review 证明不了任何事。`config init --armed` 写入 armed 质量 gate 的 config（blocking commentChecker + lspDiagnostics 命令槽），为底线提供命令级入门。
- `src/ai/routing.mjs`：完整 `routeRequest` 流（路由请求持久化、语义 shadow 治理、可选 LLM 第二意见）。
- `src/infra/route-table.mjs`：确定性路由表加载（routes.json + 已审核 overrides）与信号匹配（`loadRoutesConfig` / `resolveRouteDecision`），无 LLM——orchestration 可用而不触 ai 区。
- `src/ai/archivist-router.mjs`：基于 DeepSeek flash 的档案员/路由运行时、routing packet 构建、确定性 fallback、hook 触发的档案更新、上下文注入包与关键词建议产物。
- `src/infra/memory-digest.mjs`：跨会话恢复的结构化 session/task/checkpoint digest 生成。
- `src/infra/rule-scanner.mjs`：从 AGENTS/CLAUDE/Cursor 风格文件扫描项目规则并生成 rule-context，含每条目标路径上最近的嵌套 `AGENTS.md`。
- `src/infra/error-protocol.mjs`：统一错误协议 `{code, module, message, next_action}` 与内联单行渲染；覆盖三处结构化错误面（gateway 信封、delivery-pipeline 结果、CLI 非零退出）。
- `src/infra/gate-arming.mjs`：gate-arming 底线评估（「门未武装」黄灯）。纯只读：标记缺失/trivial `verify_commands`、同义反复 review（无 review/standards 命令、无 LLM review、无启用质量 gate）与无 required 质量 gate 的 config。`statusReport` 始终携带结果；自身不写 config 或翻转 gate。
- `src/infra/dependency-graph.mjs`：对抗加固的词法 import 扫描器（`maskSource`/`extractImportSpecifiers`），由 `test/dependency-boundary.test.mjs`（保持不可削弱的对抗底线）与 `computeImpact` / `helix impact` 背后的全仓 import 图共用（反向传递 importer + 待跑测试投影）。同一图支撑 `computeZoneTests` / `helix test --zone`（import 该区的测试 + 命名配对测试 + 始终运行的边界测试）与 `listRepoTests`；`helix test` CLI 在 spawn `node --test` 时剥离 `NODE_TEST_CONTEXT`/`NODE_TEST_ID`，避免从另一 test-runner 进程内调用时空洞 exit 0。
- `src/infra/decision-log.mjs`：统一决策记录（`.helix/decisions.jsonl`）。仅在四缝发射——delivery-pipeline gate（verify/scope/review/acceptance-proof/checkpoint + pipeline 结果）、`ai/hooks` pre/post-tool-use 决策、并行 admission 与路由。路由记录额外保留完整 `inputText` 与结构化 `routeResult`；工具 Hook 保留 `toolName`、目标路径和脱敏后的参数摘要，供同 `sessionId` 复盘。派生日志：非 hash 链（ledger 仍是审计权威）、无锁单行追加（行中途外部截断后自愈）、best-effort 发射且从不破坏主流程；读侧跳过并计数损坏或半写行。
- `src/capabilities/worker.mjs` / `src/capabilities/review-gate.mjs`：worker 执行与 BaiZe 独立 review 通道。风险复核与怀疑式验收是 BaiZe Skill 模式，非独立长期 Agent。
- `src/infra/command-safety.mjs`：worker、verifier、review 命令、质量 gate 与子 Agent runner 共用的高风险 shell 命令预检；阻断破坏性系统命令与对项目源/测试/文档目录的递归删除。内置模式为不可削弱底线；config 中 `commandSafety.extraPatterns` 追加项目规则（`compileCommandSafetyPatterns` 编译，调用方经 `runCommand` options 传入）。
- `src/infra/security.mjs`：config hash 基线、config 校验、运行时状态备份、归档精确恢复包、备份列表、一键状态恢复与关键状态校验。
- `src/interface/doctor.mjs`：一致性 doctor，审计 config 结构/mounts、将全局 task ledger 中所有 Plan 的 completed 任务与 checkpoint/acceptance proof/ledger 事件按 `<planId>:<taskId>` 对账、校验 ledger hash 链、ledger 与最新备份交叉检查，并展示最新仓库治理状态。旧完成事件缺 planId 时只在 taskId 全局唯一时兼容；无法唯一归属就报告 ambiguous，不猜。专用 `gateArming` 与 `adapters` 段展示未武装 gate（黄灯不再埋在 `status` JSON 里）、已启用但未安装的 adapter hook（`.cursor/` 不随每次 clone 传播——`.gitignore` 对 `.cursor/hooks.json` 与 `.cursor/hooks/` 例外以便 hard enforcement 可提交，doctor 验证各机器实际拥有），以及引用已不存在绝对路径的规则文件（机器/用户名变更后 stale）。诊断与 gating 隔离：各项检查独立 try/catch（崩溃仅标红本段 `check_failed`，其余仍报告），doctor 从不追加 hash 链 ledger。还检查反向：orphan completion 事件（未 completed 任务已有链校验 completion ledger 事件——中断的完成事务，带 `helix run` 恢复提示）、完成后副作用失败（snapshot/summary 在 commit 后写不出的 `completion_side_effect_failed` ledger 事件），以及 canonical/derived 分歧（各 Plan mirror JSON 或 active `tasks.md` 与权威 `team/tasks.json` 不一致）。
- Cursor adapter 安装会识别受管旧规则 `.cursor/rules/helixflow.mdc`，先写入 adapter backup 再移除，并生成当前 `wildarrange.mdc`；Doctor 同时报告尚未迁移的旧规则，避免新旧 alwaysApply 双注入。
- `src/capabilities/code-intel.mjs`：LSP/typecheck 命令、AST/结构命令、hashline anchor 与注释检查的宿主中立代码智能 gate。
- `src/infra/repository-layout.mjs` / `src/capabilities/repository-governance.mjs`：LuWu 只读仓库审计。确定性检查覆盖目录级 `AGENTS.md`、双语 README 命令与安全标记对等、真实 CLI `--help`、固定五 Agent 白名单、prompt-pack 注册、命名、文件放置策略与实际注释 token（含 JavaScript 模板表达式）；capability 经 gateway 写 JSON/Markdown 证据。`--changed-only` 将检查范围限于变更文件及相关结构不变量；Git 变更发现不可用时才全扫描 fallback。
- `src/ai/injection.mjs`：注入点解析与 markdown/skill 附件加载；把 `agents.<name>.skills` 作为该 Agent 的固定能力上界，安全读取 `.agents/skills/<name>/SKILL.md` 或 Prompt Pack Skill。固定绑定始终挂载，动态 Skill 仍按请求匹配和数量上限做减法；缺失项显式报告，路径穿越与越界软链接拒绝加载。
- `src/ai/skill-matcher.mjs`：stage/route/agent/keyword Skill 匹配与可解释加载提示；不维护脱离 Agent Prompt 的模型偏置旋钮。
- `src/ai/context.mjs`：Agent 上下文、hash 校验后的角色 Prompt 读取与预算化、resume snapshot、session 谱系与 continuation 指令。
- `src/ai/hooks.mjs`：宿主生命周期 hook 处理与 pre-tool-use scope guard 输出（scope 检查经 `capabilities/gateway.mjs`，非直接 import）。`SessionStart` 注入完整 Jiuwei 身份 Prompt，`PostCompact` 再注入用于恢复；`UserPromptSubmit` 不重复身份 Prompt。
- `src/orchestration/status.mjs`：workflow 摘要、active Plan status、全项目 task-ledger Dashboard ViewModel、attention 报告（含 draft 工单、开放 ChangeRequest、失败任务、用户决策、待批准计划、待 acceptance 子 Agent）与 ledger 尾读取。每个 status 报告携带 `gateArming`——来自 `infra/gate-arming.mjs` 的持久「门未武装」黄灯，任务列表全绿也不能伪装成已武装治理。attention 报告是通用人决策推送的真相源：hook 将其注入宿主 AI 上下文（SessionStart / UserPromptSubmit / PostCompact / Stop），指示 AI 向开发者展示待办与选项——无外部 IM 绑定。

计划批准 gate：当 `planApproval.required` 为 true，`importPlan` 将计划标为 `awaiting_plan_approval`，`runNextTask` 在 `approvePlan`（CLI `plan approve` / slash `/helix-approve`）记录批准前拒绝启动任务。默认关闭，线性循环不受影响除非显式开启。
- `src/orchestration/workflow.mjs`：workflow 入口、样例计划生成与计划模板复制。
- `src/orchestration/linear-runtime.mjs`：execute/verify/scope/review/checkpoint/retry 的线性任务节点运行时；每个 gate 调用经 `capabilities/gateway.mjs` 的 `invokeCapability`。
- `src/orchestration/delivery-pipeline.mjs`：线性运行时与并行 Agent admission（完整 pipeline）及单步 `node checkpoint` workflow（经 `runCompletionSegment` + `collectGateEvidenceFromTask`）共用的 verify -> scope -> review -> acceptance-proof -> checkpoint 序列，因此增删重排 gate 只有一处。`shouldFailDeliveryAttempt` 统一判断失败/重试，`commitTaskCompletionState` 只统一 ledger -> wisdom -> digest -> canonical `tasks.json` 的完成提交顺序；各调用方继续提供自己的 ledger 事件、digest reason 与提交后动作。checkpoint 写失败返回 `checkpoint_failed` 而非 `completed`——调用方将任务回 `pending` 并写 `checkpoint_write_failed` ledger 条目；完成严格需要 durable checkpoint。Gate 证据绑定执行轮次：每次新 worker run 清空 `last_*` gate 字段；`collectGateEvidenceFromTask` 只接受 append-only 证据链中最新 worker 条目之后的 gate 证据，checkpoint 失败轮次的 passing 证据不能借给后续未验证轮次。完成事务可幂等恢复：若在 completion ledger 事件之后、canonical `tasks.json` 保存之前中断，`run` 检测任务卡在 `verifying` 并用 checkpoint-node 逻辑裁决（全新全 pass 证据则幂等完成；否则回 `pending`）；`in_progress` 任务故意不动（可能正当 claim）；持有 `admission_claim` 的 `verifying` 任务 likewise 留给并行 admission owner（`run` 报告 `blocked` 与 resume 提示而非劫持进行中事务）。completed 任务必须有的产物（wisdom 行、memory digest）在事务**内**写入——completion ledger 事件之后、canonical persist 之前——失败则任务保持可恢复而非无产物完成；提交后便利（snapshot、workflow summary）经 `runPostCompletionSideEffects` best-effort，失败转为 `completion_side_effect_failed` ledger 事件与结果上 `sideEffectWarnings` 条目，而非 un-complete 任务。
- `src/orchestration/plan-state.mjs`：计划归一化、图校验、计划导入、路由 enrichment、任务状态加载与计划批准状态（`loadPlanApproval` / `approvePlan`）。
- `src/orchestration/task-board.mjs`：全项目工单总账编排；新功能、Bug、验收纠错和维护任务共享 Task 模型。信息不足时先写 `draft`，补齐 writable paths、success criteria 与 verify commands 后经 `task ready` 转为 `pending`。负责跨 Plan list/get、claim、证据记录、单文件状态持久化、outbox 与 durable 消息板；同一 Task 内 verifier 失败只追加 attempt/history，不制造新工单。
- `src/infra/task-state-store.mjs`：读取 `.helix/team/tasks.json` 的全项目 ledger，兼容旧 `{planId,tasks}` 格式，并向执行链投影 active Plan 的原有 `{planId,tasks}` 视图。未来 schema version fail-closed；旧 completed 不继承当前完成资格，而是投影为 `needs_user_decision` 等待重新验收。每个全局引用使用 `<planId>:<taskId>`，所以不同 Plan 可继续使用局部编号 `T001`。
- `src/infra/agent-spawn.mjs`：Codex/Cursor/自定义 command adapter 的宿主中立子 Agent spawn 命令渲染。
- `src/infra/git-worktree.mjs`：Git worktree 隔离、patch 提取、patch 路径解析、patch admission helper，以及每次 worker run 前基于 `git stash create` 的 pre-execute 工作区 snapshot。
- `src/infra/git-coordination.mjs`：设备安全的 remote 检查、metadata/checkpoint commit、普通 push/fetch、task 分支切换、working/tree-diff 检查、祖先检查与 integration-SHA guard 的参数数组 Git 原语。不决定 task 状态。
- `src/orchestration/remote-ownership.mjs`：稳定设备登记、模式解析、唯一 remote claim packet、ownership 校验与协调状态。
- `src/orchestration/handoff.mjs`：UUID 绑定的 `prepare -> push -> accept` 与显式带证据 takeover。将接受任务恢复到本地 `.helix/` 状态，remote commit 仍是跨设备权威；push/accept 重试协调 remote 状态并恢复缺失的本地 audit 记录。
- `src/orchestration/integration.mjs`：admission 使用的 remote-main integration fence 与 commit 事务：owner/base/main 重校验、durable integration intent、临时 index commit 创建、普通 push 与同 run 对账。
- `src/orchestration/admission-recovery.mjs`：回滚计划的持久化/加载/移除、补丁是否已应用的 argv Git 检查、文件/patch 回滚，以及 integration 前 revalidation 与 integration 后 recovery 的持久化策略。仅在安全回滚后释放 ownership；已知 integration 到达 remote main 的 run 永不回滚或释放。
- `src/orchestration/parallel-runtime.mjs`：基于 command 的子 Agent 批跑、run-dir 或 Git worktree 隔离、skipped-run 检测、结果收集、生命周期 status、显式 close/release/cleanup、team 消息发布与 agent-run index。默认 `guarded` 协调激活时，可写 run 自动用 worktree 并在 spawn 前每 task 持久化一个 `parallel_run_claim`。创建 run 前拒绝只读长期身份 DiJiang、BaiZe、LuWu；仅 Jiuwei 与 ZhuRong 可作为长期 Agent 进入 command worker，隔离的 ephemeral command agent 仍支持非保留名。run 在 agent 启动前预注册到 `index.json`（加 `running` 批 JSON），每次 index 读将 orphan run 目录收编回 index，磁盘上的结果不会对 `parallel status` 永久不可见。admission 事务本身在 `src/orchestration/admission.mjs`，在此 re-export。
- `src/orchestration/admission.mjs`：并行 Agent admission 事务（claim -> apply -> gates -> acceptance proof -> integration push -> checkpoint，或 rollback），经共享 `delivery-pipeline` gating。Admission 是 claim-first 且持久化 ownership：status 裁决、writable-paths 预检、task claim 与 `parallel_agent_admission_started` ledger 事件均在写任何工作区文件**之前**于 task-state lock 下发生，claim 本身持久化在 task 上（`admission_claim = { runId, phase }`）。apply 与 gate 在**同一次**全局锁连续持有下运行——工作区变更与评判它的 gate 是单一临界区，两个 admission（同 task 或不同 task、路径是否重叠）与并发线性 `run` 都不能在 gate run 之间交错工作区写。因 claim 与 apply 用两次锁持有，事务在 workspace I/O 前立即重读持久 owner 与 phase；持有 stale phase 的重复同 run 请求因此不能 re-apply 文件或将 lifecycle 降级为另一调用已完成的态。第一次文件写之前 pre-image rollback plan 持久化到 `agent-runs/<runId>/<taskId>.rollback-plan.json`，apply 中途崩溃不会 orphan 唯一原始内容副本——reclaim 以该持久 plan 为权威，永不用已变异工作区的 snapshot 替换。integration 前重校验 remote task owner、guarded main SHA 与本地祖先；仅全 pass 结果生成并 non-force push integration commit。push 前拒绝时工作区 rollback **先**发生，admission 仍拥有 claim。claim 与 rollback plan 仅在 rollback 报告 `rolled_back` 后释放；rollback 失败则 task 保持 `verifying`、ownership 留在同 run，admission 返回 `recovery_required`，阻止后继进入脏工作区。integration push 成功但 checkpoint 写失败时故意禁止 rollback，因 remote main 已含变更；durable integration intent 与同 run claim 保留直到 retry 对账完成 checkpoint。第二 run 试图 admit 已 claim task 被拒绝（一 task 无双 owner），finalize 重校验 committing run 仍持有 claim。文件落盘后 claim phase 推进到 `finalizing`；finalize 段任意处崩溃故意保留工作区、claim、rollback plan 与任何 integration intent——**同 run** 再 admit 跳过 apply 并 re-run/对账至完成，其他 run、`helix run` 与单步 checkpoint 均被拒绝。恢复 completed task 需要该 exact run 的链校验 completed ledger 事件； genuine resume 仅重做缺失 lifecycle release 而不 re-apply 文件，否则 outright 拒绝。
- `src/capabilities/gateway.mjs`：静态 capability 注册表 + 统一结果信封（`capability`/`status`/`evidence`/`sideEffect`/`duration_ms`/`cost`/`error`）；`orchestration/` 与 `ai/` 到达 `capabilities/verify.mjs`、`scope-guard.mjs`、`checkpoint.mjs`、`worker.mjs`、`review-gate.mjs`、`acceptance-proof.mjs` 的唯一门。

### Admission 状态机表

`admitParallelAgentResult` 的返回 `status` 与持久状态的对应关系（任务持久状态以 `task.status` / `admission_claim` 为准）：

| 返回 status | 触发条件 | 任务持久状态 | ownership / claim | 下一步 |
| ----------- | -------- | ------------ | ----------------- | ------ |
| `completed` | 全部 gate + acceptance proof + （有 remote 时）integration push + checkpoint 通过 | `completed` | 释放 | 子 Agent 结果进入 `awaiting_user_acceptance`，由主线 close |
| `retry` | pipeline 某门 FAIL（verify/scope/review 等）且工作区已安全回滚 | 回 `pending` | 释放 | 修正后重新 `parallel admit` 或重跑子 Agent |
| `apply_failed` | 应用子 Agent 文件失败且回滚成功 | 原状态 | 释放 | 检查 patch/冲突后重试 |
| `revalidation_required` | gate 期间 owner/SHA 变化、基线落后或存在无归属改动；已安全回滚 | 原状态 | 释放 | fetch 后重试 admission |
| `recovery_required` | 回滚失败，或 integration push 已成功但本地后续步骤失败 | `verifying`（保留） | **保留**（含 rollback plan / integration intent） | 同 run 恢复对账；禁止其他 run 进入 |
| `skipped` | 无可回滚计划等前置不满足 | 原状态 | 不变 | 按 reason 处理 |

不变量：push 已成功后任何故障都不得回滚或释放原 run（只能对账恢复）；claim 只有在成功提交或工作区成功回滚后才释放。
- `src/interface/dashboard.mjs`：本地 dashboard HTTP API 与 HTML UI，含全项目“工单总账”页（类型/状态/Plan/文本筛选、关联任务与状态历史）、人类表单建单，以及 POST token、Host 与 Origin 防护。
- `src/interface/dashboard-panels.mjs`：Dashboard 路由复盘、决策与运维面板。路由复盘按日期和 `sessionId` 关联原始请求、路由结果、语义第二意见与工具摘要，并展示 Stop Hook 生成的当日可读报告摘要；受保护 POST 只写人工标注，不自动修改路由规则。与 `dashboard.mjs` 分离以保持低于拆分线。
- `src/interface/timeline.mjs`：`helix timeline`——合并 hash 链校验 ledger 条目、decisions 与 annotations 为单一倒序只读投影。
- `src/interface/cli-help.mjs`：CLI 命令注册表（单一事实源）。默认 `--help` 仅显示 core 六命令（init/plan/run/status/decisions/doctor）；`--help --all` 列出全部；`docs commands --write` 物化 `doc/generated/commands.md`。README 命令真实性检查对照 `--help --all`。
- `src/ai/suspicion-review.mjs`：archivist 不变量下的异步 LLM 怀疑审查——仅 sanitized 结论包（无代码/diff/raw 输出）、无 key 时确定性 fallback、LLM decisionId 锚定 packet（幻觉 id 丢弃并计数），结论仅在 `.helix/reports/suspicion.*`，从不进入完成链。
- `packs/wildarrange-linear/agents`：角色 prompt。
- `packs/wildarrange-linear/skills`：skill prompt。
- `packs/wildarrange-linear/tools/tool-contract.json`：工具合同清单。
- M1 发布工具合同只登记真实 CLI、运行时内建能力、配置驱动能力和明确的宿主只读工具；不发布 roadmap-only 条目，也不把多条状态变更命令用 shell 管道拼接。路由持久化到 `task.skills` 的 Skill 只在真实接通的 `before_execute` 公开宿主入口作为任务绑定进入统一预算化加载器；`before_review` / `before_checkpoint` 仍使用静态阶段 Skill，不宣称自动消费任务绑定。未知、越界或完整性失败的 Skill 只报告、不注入。
- `helix.config.json`：项目根权威配置。它存在时不再把 `.helix/config.json` 当隐式底层，避免根配置删除字段后旧键复活。

## 运行时状态

- `.helix/team/tasks.json`：全项目唯一工单总账。包含所有 Plan 的 Task、`workType/source/priority/parentTaskRef`、当前状态与精简 `history`；`activePlanId` 决定执行链当前投影。`state migrate` 自动先备份，再把旧单 Plan 格式、旧 Agent owner 与 active config 显式迁移，并删除无消费者的 `.helix/agents.json` / `.helix/categories.json`；缺少当前 proof chain 的旧 completed 进入 `needs_user_decision`，历史 checkpoint/ledger 保持不变。
- `.helix/ledger.jsonl`：hash 链 append-only 审计日志。`ledger verify` 检测普通行编辑或断链。
- `.helix/decisions.jsonl`：派生决策投影日志（四缝：pipeline gate、tool-use hook、admission、routing）。可丢弃与截断；非 hash 链部分。经 `helix decisions` 读取。每条记录带 `id` 锚点与 `annotatable` 标志——仅 deny 与非确定性 allow（LLM review、routing shadow、admission 归因）进入标注队列；确定性 PASS 记录仅作流式记录。
- `.helix/reports/routing/latest.md`：IDE Stop Hook 自动更新的中文路由日报；同日归档位于 `.helix/reports/routing/YYYY-MM-DD.md`。先给结论，再列问题、待复盘项和每次判断/工具明细，只读不改规则。
- `.helix/annotations.jsonl`：决策记录的人工/复核标注（`confirmed|rule_wrong|case_wrong|mislabeled`）。类别强制；统计按 rule × category 聚合，单条标注不能劫持 rule。硬约束（`test/annotation.test.mjs` 钉死）：标注路径永不写 config、`verify_commands`、路由表或任何 gate 开关——标注告知人，不移动 gate。
- `.helix/security/config-baseline.json`：已审核 config 指纹。`config verify` 检测 baseline 之后增删改的 config 文件。
- `.helix/backups`：`state backup` 创建的 ledger、work、tasks、snapshots 与 config baseline 时点副本；归档操作会把本次 Plan/checkpoint/acceptance/DoneClaim/精确 artifact 删除集追加到同一 backup 的 recovery package，并记录 `prepared|committed|rolled_back|recovery_required` 事务状态与 staging 诊断路径。`state migrate` 与 `state restore --backup <id>` 都会先自动创建恢复点。
- 任务退出活动运行态使用 `task archive --task <id> --delete`：CLI 先备份，编排层先校验 Plan/Task 为安全单段标识符、canonical `planId:id` 身份唯一，并拒绝归档 `in_progress` / `verifying`。显式 `--plan` 必须精确命中，不回退到其它 Plan；未索引旧 Plan 也只删除指定 Task 并保留其它任务。删除使用同卷 staging 与镜像/权威总账回滚事务，权威总账最后提交；随后写完成墓碑并清理目标 Task、空 Plan、精确 checkpoint/acceptance report、该任务的 outbox DoneClaim，以及未被其它任务共用的 `.helix/artifacts/` 精确非 glob 产物。进程中断时 recovery package 保留恢复材料，执行 `state restore --backup <id>` 可恢复整个精确删除集。清空活动 Plan 后进入 `idle`，不会自动激活其它 Plan；下一 Plan 必须显式选择并重新建立批准状态。Ledger 与 backups 不属于归档删除范围。
- `.helix/reports/doctor.json` / `.helix/reports/doctor.md`：最新 `doctor` 健康报告，覆盖 config mounts、完成对账、ledger 校验、ledger 与备份交叉检查及最新仓库治理摘要。
- `.helix/reports/governance/latest.json` / `.helix/reports/governance/latest.md`：LuWu 最新确定性仓库审计证据。
- `.helix/checkpoints`：全部 gate 通过后的 checkpoint JSON。
- `.helix/reports`：人类可读报告。
- `.helix/snapshots/context.md`：resume 上下文。
- `.helix/agent-runs`：子 Agent task packet、command 结果、结构化结果文件与 run index。
- `.helix/memory/events.jsonl`：路由与阶段档案事实的结构化记忆事件流。
- `.helix/memory/digests`：结构化 task/session/post-compact digest 产物。
- `.helix/memory/last-digest.json`：session 恢复与上下文注入的最新 digest。
- `.helix/memory/stage-summaries`：进度、决策、产物、实现笔记、调研笔记、坑点与开放问题的结构化摘要。
- `.helix/memory/index.json`：记忆召回的轻量 keyword/domain/artifact index。
- `.helix/routing/suggestions`：ArchivistRouter 关键词建议与用户偏好路由笔记。
- `.helix/routing/routes-overrides.json`：叠在已安装路由表上的已审核关键词 patch。
- `.helix/routing/archivist-trigger-state.json`：ArchivistRouter 调度的 Git HEAD 与 stage 感知 prompt 窗口计数。
- `.helix/adapters`：生成的 adapter 文件、报告与备份。

## 路由模型

路由采用混合模型：

1. `src/infra/route-table.mjs` 从 `packs/wildarrange-linear/routes.json` 跑确定性热路径；`src/ai/routing.mjs` 在其上叠加 LLM/语义部分。
2. `routeGovernance.semanticShadow` 可问已配置的 `CangJie` 要语义第二意见。确定性结果仍可见，但低置信或冲突的 execute 路由可降级为 plan/ask。
3. `ArchivistRouter` 在 provider 凭证存在时使用已配置 `CangJie` / `deepseek-v4-flash`，不可用时 fallback 到确定性路由。
4. 宿主 hook 在 `SessionStart`、`UserPromptSubmit`、`PostCompact` 触发 ArchivistRouter。hook 路径非阻塞：失败变为 warning 事实，不 deny prompt。
5. Prompt 计数触发是 stage 感知的：ideate/plan/clarify 默认 5 轮，普通工作默认 10 轮，execute/verify/review 默认 15 轮，上限 20 轮。
6. `ArchivistRouter` 读取有界 routing packet 与结构化记忆，而非无限 raw 聊天历史。
7. Routing packet 采用仅结论捕获：保留用户意图、可见 assistant 结论、摘要化 tool 结果、证据、进度、决策、产物、实现结论、调研笔记、坑点与开放问题；默认剥离代码块、diff、raw 命令输出与中间过程文本。
8. 可产出路由决策、多意图分段、结构化档案更新、上下文注入包、用户偏好笔记与关键词 patch 建议。
9. 关键词建议先写待审。接受的建议更新 `.helix/routing/routes-overrides.json`，而非已安装 prompt-pack 源。review、Git、权限、安全、删除、发布与范围变更等高风险路由区需要证据与 rationale。

## 并行 Agent 模型

第一版并行运行时故意收窄：

1. `parallel run` 选择可跑的 pending 任务或显式 task ID。
2. 每个子 Agent 在 `.helix/agent-runs/<runId>/<taskId>/task.json` 收到 task packet。
3. 配置的 runner 命令在隔离 run 目录内执行，或 `--isolation git-worktree` 时在 Git worktree 内执行。
4. 可选结构化输出从 `agent-result.json` 读取。
5. adapter command 模板可配置在 `parallelAgents.spawnAdapters.codex` 或 `parallelAgents.spawnAdapters.cursor`；接收 `{taskJson}`、`{outputJson}`、`{runDir}`、`{workDir}`、`{taskId}`、`{agent}`。
6. 结果写入 `.helix/agent-runs`、发布到 team 消息板并追加 ledger。
7. `parallel admit` 接受来自 `agent-result.json.files` 的结构化文本文件提案，或来自 `agent-result.json.patch` 的 Git worktree patch。
8. Admission 拒绝 `writable_paths` 外的路径。
9. 成功的子 Agent 结果进入 `awaiting_user_acceptance`，而非视为已关闭。
10. 接受的文件或 patch 应用到主工作区，然后 verifier、scope guard、review gate、acceptance proof 与 checkpoint 运行后任务才能 `completed`。
11. admission 失败时，文件提案或 patch 在释放 ownership 前 rollback。若 rollback 本身失败，原 run 保持 claim 与 rollback plan，`recovery_required` 直到恢复成功。
12. admission 完成后，子 Agent 结果 lifecycle 移至 `released`；失败 admission 保持可见以便修订。
13. `parallel status` 读 `.helix/agent-runs` 并摘要保留的子 Agent lifecycle 状态，加中断对账：批 JSON 持久化 `taskIds`/`command`/`agent`，`batchStatus` 与 `incompleteTasks`（已 claim 但无 passing 结果）始终可见。
14. `parallel close` 让用户在人工 acceptance 后释放保留的子 Agent 结果，不删证据。
15. 崩溃的 runner（spawn 级失败、worktree/磁盘错误）变为 per-task `fail` 结果——从不拒绝整批或丢失 sibling 结果；spawn 级进程失败表现为 exit code 127 与 `spawnError: true`。
16. `parallel retry --run <runId>` 仅重跑无 passing 结果的任务（复用记录的 command/agent/isolation，可用 flag 覆盖）。已通过、completed 或被另一 run claim 的任务带 reason 跳过；retry 是新 run，永不改写原 run 证据。

这支持窄但真实的 multi-agent admission 循环：子 Agent 可在隔离目录或 Git worktree 工作，但仍不能自证完成。

## Gate 模型

完成需要：

1. `worker_command` exit 0。
2. `verify_commands` 存在且通过。
3. `successCriteria` 通过。
4. `scope_guard` 返回 `pass`。
5. `review_gate` 返回 `pass`。
6. `acceptance_proof` 返回 `pass` 并写入 `.helix/reports/acceptance/<planId>/<taskId>.json`；checkpoint 同样写入 `.helix/checkpoints/<planId>/<taskId>.json`。Plan/Task 分目录使两个允许连字符的 ID 仍保持一一对应；旧扁平路径只在 JSON 身份匹配或不存在碰撞时兼容读取/清理。

`inconclusive` 不是完成证据。

review gate 是宿主中立的。从 CLI 运行，可含确定性通道、配置的 `review_commands`、配置的 `standards_commands`、可选 LSP/typecheck 命令、AST/结构命令、hashline anchor 检查、注释检查与可选 OpenAI 兼容 LLM review。BaiZe 是唯一独立 review Agent；目标/证据、bug/风险与怀疑式验收视角作为 review Skill 或模式选择。

## Adapter 模型

Codex 收到 `.codex/hooks.json`。这是真实的项目本地 Codex hook 入口，在项目 `.codex/` 层与 hook 定义经 `/hooks` 信任后变为 hard enforcement。

Codex 主会话身份由 lifecycle hook 自动建立：`SessionStart` 从已安装且 hash 校验通过的 Prompt Pack 读取 Jiuwei Prompt 并注入一次；发生上下文压缩时，`PostCompact` 再注入一次。普通用户消息只做路由和动态上下文匹配，不重复加载完整角色 Prompt。

WildArrange 还将 `.helix/adapters/codex/hooks.json` 写为审计副本。Cursor 收到 `.cursor/hooks.json` 与项目感知 bridge `.cursor/hooks/wildarrange-hook-bridge.mjs`（工作区信任后为 hard enforcement；`preToolUse` fail-closed），`.cursor/rules/wildarrange.mdc` 仍为 soft fallback 层。

Kimi 在 `.helix/adapters/kimi/plugin/` 下收到生成的 plugin。项目 CLI 永不编辑用户级 `~/.kimi-code/config.toml`；开发者从项目根启动 Kimi Code，通过 `/plugins install .helix/adapters/kimi/plugin` 显式安装生成的 plugin，并用 `/reload` 激活。相对路径避免 Kimi Code 0.27 将引号字符当作字面路径字符。Kimi plugin 安装是用户 scope，其 Hook bridge 先验证事件 `cwd` 含真实 WildArrange 运行时标记，无关项目不创建文件即退出。Kimi Hook runner 在 hook 崩溃与超时时 fail-open：健康的 `PreToolUse` 可 deny 范围外 Write/Edit/Bash，但最终安全与完成仍由宿主中立 delivery pipeline 与 checkpoint gate 强制。

adapter 安装还生成一组 command，用户不必开终端做常见操作。所有面从同一共享 command 集渲染（`helix-config`、`helix-doctor`、`helix-refresh`、`helix-status`、`helix-plan`、`helix-approve`、`helix-run`）：

- Cursor：`.cursor/commands/<name>.md`（纯 Markdown slash command，文件名 = 命令名）。
- Codex 与 Kimi：`.agents/skills/<name>/SKILL.md`（共享项目 Skill 目录，带 `name`/`description` metadata）。

每个 command 是指示 agent 运行匹配 `helix.mjs` CLI 子命令并报告结果的 prompt；它们是让 agent 跑 CLI 的快捷方式，不是原生按钮。

adapter 安装与卸载始终备份被覆盖或删除的文件，含生成的 slash command。`adapter restore --backup <backupId>` 将一备份目录恢复到原项目路径。

## Success Criteria 证据模型

`successCriteria` 是独立的完成证据，不是 verifier 输出的镜像。显式 criteria 保持 pending，直到 agent 记录证据或 criterion 声明指向具体 passing `verify_commands` 的 `verifierCommandRefs`。省略 `successCriteria` 的旧任务为兼容收到 verifier 绑定默认值，但可能的 no-op 任务标 `governanceWarnings`，使 trivial worker + trivial verifier 可见。

Checkpoint 仍需要 worker 成功、verifier pass、success criteria pass、scope pass、review pass 与 acceptance proof pass。

## Dashboard 安全模型

dashboard 保持 local-first。loopback `GET /api/state` 可无 token 读取做轻量 status 检查。每个 `POST` 端点需要 `Authorization: Bearer <token>` 或 `x-helix-token`，包括在 `127.0.0.1` 上，因为 POST 可执行 worker 命令。服务器还校验 Host 与 Origin / Sec-Fetch-Site，降低 DNS rebinding 与浏览器跨站触发风险。

## Skill 匹配与任务绑定模型

基础 prompt pack 仍是真相源。`skills match` 是可解释的加载提示，按显式选择、stage boost、路由 keyword 信号、Agent 角色、category 与请求 keyword 对已安装 skill 打分。不 mutate 路由表。

注入点的 Skill 挂载在请求文本可用时为按需（`skillMatcher.dynamicInjection`，默认启用）：

- 动态 matcher 只在注入点与 Agent 的显式 skill 集合内做减法；`task.skills` 是独立的任务级显式来源，只会在真实接通的执行前交付入口加入候选集合。
- `alwaysMount` skill（默认：`wildarrange-injection-runtime`）始终挂载；其他配置 skill 仅当 matcher 在请求相关信号上得分 >0 时挂载。仅 Agent 身份 boost 不算匹配，因其 per agent 恒定，会退化为静态挂载。
- `maxSkills`（默认 4）按分数 cap 动态挂载 skill 数。
- 未挂载 skill 在注入输出中降级为按需引用（name + load command），agent 需要时可显式拉取。
- 无请求文本时（如 `pre_tool_use`），该点回退静态挂载并在 `skillSelection` 报告原因。

阶段名只作为 matcher 的上下文信号，不映射为另一套阶段前缀 Skill。阶段职责由五个长期 Agent、当前专项 Skill 与确定性 delivery pipeline 共同承担，Prompt Pack 不发布历史阶段剧本。

`resolveInjectionPoint` 接受可选 `{ text, stage, taskSkills }` 上下文（hook 传用户 prompt 或 resume next-action；agent context 传 task subject 与任务绑定）。动态选择只在注入点与 Agent 的显式集合内做减法；任务绑定作为受限的额外显式来源，只在 `before_execute` 挂载。PreToolUse Hook 会解析当前 runnable Task、构建 ZhuRong 执行上下文并把任务 Skill 全文交给宿主；`context build --point before_execute` 与生成的 `/helix-run` 走同一路径。匹配或任务绑定的 Skill 以全文加载，未匹配项降级为 agent 稍后经 `prompts show --skill <name>` 加载的路径引用。任务绑定只认安全名称与 Prompt Pack manifest / 项目 Skill；Prompt Pack 读取校验安装根、相对路径、realpath 与 SHA-256，未知或完整性失败项进入 `skillSelection.missing`。`skillMatcher.dynamicInjection` 控制动态匹配（`enabled`、`maxSkills`、`alwaysMount`）；无请求文本或禁用时，注入点回退静态列表。独立 Prompt 变体因未进入真实上下文已退役，模型差异由 Agent provider/model/reasoning 与宿主 adapter 承担。

## 上下文预算模型

`src/ai/injection.mjs` 将类 prompt 上下文视为分级材料，非单一扁平 blob：

1. Agent 身份 Prompt 保持稳定。默认 `contextBudgets.prompt.maxChars` 为 12,000 字符；身份 Prompt 只在会话启动和压缩恢复时进入 hook 输出。
2. Markdown 挂载用于规则、snapshot 与 live 状态。默认 Markdown 预算 12,000 字符，`pre_tool_use` 与 `post_tool_use` 用更轻 hook 预算。
3. 激活的 Skill 挂载是工作流指令。默认 Skill 预算 80,000 字符，traffic-light hook 更窄，execute/review hook 更宽。
4. 任何超预算挂载必须暴露 `truncated: true`、原始字符、加载字符与预算字符。不允许静默截断。

这遵循运行时哲学：system prompt 像宪法，Skill 像任务手册，reference 像档案，hook 像红绿灯。长 Skill 在确实是工作流时可接受，但应按 stage 或 route 激活而非每次 session start 全加载。

## Provider 模型

默认 GPT 族 agent 用 `provider: "host"`。即 Codex/Cursor 拥有模型选择、认证与模型路由。WildArrange 对宿主托管的 Jiuwei、DiJiang、ZhuRong、BaiZe、LuWu 或 generic `deep`/`ultrabrain` 通道不要求 `OPENAI_API_KEY`。

外部 provider 用 `type: "openai-compatible"` 配置：

- `apiKeyEnv`：存 API key 的环境变量名。
- `baseUrlEnv`：可选，覆盖 endpoint 的环境变量名。
- `defaultBaseUrl`：未设 `baseUrlEnv` 时的 fallback endpoint。

`apiKeyEnv` 与 `baseUrlEnv` 不得含 raw secret 值。

## 商业边界

WildArrange core 必须保持原创代码。外部 workflow 项目可 inform 概念、节点名与质量 gate，但商业构建不得 ship 复制源码、复制 prompt 文本或限制商业再分发许可的工具实现。

adapter 专用行为属于 `src/interface/adapters.mjs`、`src/interface/kimi-adapter.mjs` 或宿主专用生成文件。core workflow、gate、ledger 与 provider 逻辑必须在没有 Codex/Cursor/Kimi 私有 hook 的情况下运行。

## 维护规则

- 新实现放在拥有该行为的区（`interface`/`orchestration`/`ai`/`capabilities`/`infra`）；无当前 owner 时新建 `src/<zone>/helix-*.mjs` 模块。
- 尊重上文「五区分层」的单向依赖图。`orchestration/` 与 `ai/` 到达 `capabilities/` 只能经 `capabilities/gateway.mjs` 的 `invokeCapability(name, ctx)`；永不直接 import capability 实现文件。
- 源文件默认保持 1000 行以内。700+ 行时评估是否超过一个领域职责。
- CLI、测试与运行时模块直接 import 具体分区 owner，不建立根级 barrel 或兼容 shim。
- 任何新运行时模块必须列入本架构图与根 `AGENTS.md`；`CLAUDE.md` 只作为宿主发现入口指向根规范，不复制第二份规则。还要登记 `tooling/arch-module-graph/module-file-map.json` 并更新 `docs/product/architecture-overview.html`；运行 `npm run check:arch`。
- 经 gateway 调用的 capability 目前含 `worker`、`verify`、`scope`、`review`、`acceptance-proof`、`checkpoint`、`command`、`command-safety`、`repository-governance`。`code-intel` 是 `review-gate.mjs` 内 import 的 review 子 capability，非 `invokeCapability` 名。
- 目录级 `AGENTS.md` 指引保持附加与局部。目录职责变化时更新最近文件；勿把完整根策略复制到每个文件夹。
- `test/dependency-boundary.test.mjs` 每次 `npm test` 运行；边界测试失败意味着依赖图被违反，不是应放宽测试。
- 保留 gate 不变量：verifier、scope、review 与 success criteria 对完成仍为 mandatory。
