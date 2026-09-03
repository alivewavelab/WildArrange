# WildArrange 项目规范

> 面向 Agent 与维护者的治理约束。用户安装与快速上手见 [README.md](./README.md)（中文）/ [README.en.md](./README.en.md)（English）。

## 当前目标

实现 WildArrange M1 线性 Agent 循环，并以 5 个长期 Agent（Jiuwei、DiJiang、ZhuRong、BaiZe、LuWu）承载编排、计划、实现、独立复核与仓库治理。Router 是确定性系统节点，专项职责用 Skill 按需挂载。主线仍是可恢复、可验证的单线流程：

```text
init -> plan -> task -> worker -> verifier -> retry/checkpoint -> ledger
```

## 实现边界

- 先还原运行秩序：计划与执行分离、worker 不自证完成、独立验证、失败返工、证据入账。
- 不把任何宿主专属工具硬塞进 core（例如特定 editor plugin hooks、tmux layout）。
- Codex / Cursor / Kimi Code 适配放在 runtime adapter 层；核心状态机必须是产品中立的本地文件协议。
- Kimi Code 项目接入复用根 `AGENTS.md` 与 `.agents/skills/`；生命周期能力通过用户明确安装的 Kimi plugin 转发，不得由项目 CLI 静默改写用户级 `~/.kimi-code/config.toml`。
- Kimi Hook 为 fail-open：PreToolUse 可在 Hook 正常运行时阻断，但 Hook 崩溃或超时默认放行；不得把它宣传为唯一安全边界，最终完成仍必须经过 verifier / scope / review / successCriteria / acceptance proof / checkpoint。
- LLM review 通过 OpenAI-compatible provider 配置化接入；默认关闭，无 key 时不阻断线性状态机。
- 第一版不启动常驻多 Agent 集群；多 Agent 先以命令型子 Agent 的隔离运行目录跑通 spawn / collect / message / admission 闭环。
- 长期 Agent 白名单固定为 Jiuwei、DiJiang、ZhuRong、BaiZe、LuWu；Router 仅为系统节点，CangJie 仅为内部 profile。DiJiang、BaiZe、LuWu 不得进入任意 command worker，临时命令型子 Agent 不能借用这些只读身份。
- 子 Agent 不能直接自证完成；结构化文件成果必须通过 writable_paths、verifier、scope、review、checkpoint 后才能进入 completed。
- checkpoint 前必须写入 acceptance proof；proof 不通过不得把任务置为 completed。
- 子 Agent 成功运行后默认保留为 `awaiting_user_acceptance`，只有主线 admission/checkpoint 完成后才释放。
- admission 只有在成功提交或工作区成功回滚后才能释放任务所有权；回滚失败必须保留 `verifying` claim 与 rollback plan，并返回 `recovery_required`，直到原 run 完成恢复。
- Git 多设备协调默认使用 `guarded`：有 remote 时以任务分支 claim commit 维护单写 owner，可写并行 Agent 默认使用 worktree；无 remote 时明确降级为本地协调。`strict` 不允许降级。
- Git 协调只允许普通非强制 push；同一任务禁止双写，跨设备 handoff 必须绑定已 push commit 且 push 前复核 prepare 树指纹，takeover 必须显式记录预期旧设备和理由，不允许按本机时间自动过期 owner。
- 任意设备可执行 admission，但开始时必须获取并绑定远端集成分支 SHA，当前工作目录必须包含该基线，且候选树不得包含本 run / handoff 清单之外的无归属改动；gate 期间 owner/SHA 变化、基线落后或存在无归属改动必须安全回滚并返回 `revalidation_required`，不得写 acceptance proof/checkpoint。全部 gate 与 acceptance proof 通过后必须真实生成以该 SHA 为父提交的集成 commit 并普通 push，成功后才允许 checkpoint；push 已成功后任何本地/所有权/远端历史故障都不得回滚或释放原 run，只能对账恢复或保持 `recovery_required`。
- ArchivistRouter 只读取清洗后的结论包，不摄入代码块、raw diff 或完整命令输出；无 LLM key 时必须 fallback，不阻断主线或 hook。
- 路由必须保留 deterministic 证据；semantic shadow 只能作为第二意见和低置信门控，不得无审计地覆盖路由表。
- 路由写入任务的 `task.skills` 必须由执行前公开宿主入口真实挂载；M1 不得宣称尚未接通的复核/checkpoint 自动挂载。只允许加载 Prompt Pack manifest 或项目 Skill 根内的已登记文件，并校验安装根、realpath 与 hash，继续受数量和字符预算约束。未知或完整性失败的 Skill 必须显式报告，不能静默加载。
- 商业发布包不得包含受限第三方源码、prompt 原文或近似改写文本；外部项目只能作为概念参考和对照证据。

## 工程约束

- 使用 Node.js ESM，无外部 npm 依赖，保证 Codex / Cursor / Kimi Code / 普通终端都能直接运行。
- 所有运行时状态写入 `.wildarrange/`。
- 计划、任务、回执、验证结果必须同时具备机器可读 JSON 和人工可读摘要。
- worker 的 DoneClaim 不能直接让任务完成；必须有 verifier PASS。
- verifier FAIL 时任务回到 `pending`，并把失败证据写入 ledger。
- 所有新增功能必须有自动测试，并实际运行。
- `runNextTask` 的返回 `status` 表示运行时下一步动作；任务持久状态以 `task.status` 为准。例如 verifier 失败时可返回 `status: "retry"`，同时 `task.status === "pending"`。
- Dashboard 默认只绑定 `127.0.0.1`。任何非 loopback host 必须配置 `--token` 或 `WILDARRANGE_DASHBOARD_TOKEN`。

## 代码维护规范

- 项目按五区分层：`interface/ → orchestration/ → ai/ / capabilities/ → infra/`，新增功能必须先归属到对应区目录；无合适归属时才新增顶层 `src/<zone>/wildarrange-*.mjs`。
- `bin/` 是五区之上的 CLI 组合入口，只做参数解析与命令路由；它可以直接 import 五区中的真实 owner，但不得承载业务流程、复制实现或引用 `src/` 根级转发文件。
- 依赖方向只能从上往下：`interface` 可依赖 `orchestration`/`infra`；`orchestration` 可依赖 `ai`/`capabilities`/`infra`，其中 `orchestration → ai` 限定在 `test/dependency-boundary.test.mjs` 钉死的白名单边（目前仅 `linear-runtime.mjs → ai/routing.mjs`），新增必须显式改白名单；`ai` 可依赖 `orchestration`/`capabilities`/`infra`（`ai → orchestration`、`ai → capabilities` 均只读，且 `ai → capabilities` 必须走 `capabilities/gateway.mjs`）；`capabilities` 只能依赖 `infra`；`infra` 不依赖任何上层。反向依赖与模块级 import 环由 `test/dependency-boundary.test.mjs` 强制拦截，不得为了让测试变绿而放宽这些规则。
- `orchestration/` 和 `ai/` 都不得直接 import 具体能力实现文件（`capabilities/verify.mjs` 等），必须统一经 `capabilities/gateway.mjs` 的 `invokeCapability(name, ctx)`。
- 单文件默认保持 1000 行以内；超过 700 行必须评估是否按职责拆分。
- `src/` 根目录不放运行时 `.mjs` 文件；实现与公开 owner 必须位于五区目录，不建立兼容 shim 或综合 barrel。
- `src/` 下未知一级目录必须被依赖边界门直接拒绝；不保留 `legacy` 免检分区。
- 规范采用渐进式披露：根 `AGENTS.md` 保存全局目标与不可削弱不变量；`bin/`、`src/`、五区、`test/`、`doc/`、`packs/wildarrange-linear/` 的 `AGENTS.md` 只补充本目录职责和验收要求。进入目录修改前先读最近的 `AGENTS.md`，子目录规范不得覆盖根级安全约束。
- 新增运行时能力必须同时更新 `doc/project-architecture.md` 和本文件的目录约定。
- gate 安全不变量不能削弱：不得删除或清空 `verify_commands`，不得跳过 verifier / scope / review / successCriteria 完成 checkpoint。
- README 命令真实性必须对照真实 CLI `--help`，不得以源码中的注释或普通字符串充当实现证据；真实注释检查必须覆盖 JavaScript 模板表达式。
- 产品总图位于 `docs/product/architecture-overview.html`；新分区或新运行时模块必须同步登记 `tooling/arch-module-graph/module-file-map.json` 并更新总图。新脚本必须由映射表归属；总图的输入/输出必须来自真实导出签名或代码证据，不得编造。
- 总图交互固定为“点模块卡片 → 底部抽屉”，不为单个大模块增加第二种展开方式；顶部页签只按真实用户作业切片，不按引擎或网关类型堆目录。
- 总图门禁豁免测试文件、`index.*`、`mod.rs`、`__init__.py`、`*.types.*`、生成目录与 D 字典的目录节点；其余改动后运行 `npm run check:arch`。
- 重构后必须验证 `npm test`；该命令由 `tooling/run-tests.mjs` 逐文件隔离执行全部 `test/*.test.mjs`，避免 Windows 上 Git/npm/嵌套测试并发互锁。涉及包内容变化时同时验证 `npm pack --dry-run --cache /private/tmp/wildarrange-npm-cache`。

## 目录约定

按依赖方向从上到下列出五区（`interface → orchestration → ai/capabilities → infra`）；CLI 与测试直接 import 下表中的真实 owner。

| 路径                                                           | 职责                                            |
| ------------------------------------------------------------ | --------------------------------------------- |
| [README.md](./README.md) / [README.en.md](./README.en.md)    | 用户安装、初始化、最小工作流、dashboard 安全说明                 |
| [CLAUDE.md](./CLAUDE.md)                                    | Claude 宿主发现入口；只指向本文件，不复制第二份规范                |
| [doc/concept.md](./doc/concept.md)                           | 产品概念与外部参考边界                                   |
| [doc/project-architecture.md](./doc/project-architecture.md) | 运行时架构、状态文件和 gate 模型                           |
| [doc/five-zone-decoupling-guidelines.md](./doc/five-zone-decoupling-guidelines.md) | 可复制到其他项目的五区受控解耦准则、实施顺序与 Review 清单 |
| [doc/low-code-project-governance.md](./doc/low-code-project-governance.md) | 低代码开发者 + AI 维护的通用掌控手册、测试纪律与 L0–L3 成熟度 |
| [doc/development-plan.md](./doc/development-plan.md)         | P0 / P1 / P2 路线                               |
| [doc/2026-07-21-five-zone-refactor-handoff.md](./doc/2026-07-21-five-zone-refactor-handoff.md) | 五区解耦重构总结与交接（六个 Phase、关键决策、已知遗留、改 X 去哪改速查） |
| `bin/AGENTS.md`                                             | CLI 参数、路由、帮助文本和退出码的局部约束 |
| `doc/AGENTS.md`                                             | README / 架构 / 可复用准则 / HTML 方案的文档分层 |
| `packs/wildarrange-linear/AGENTS.md`                        | Agent、Skill、路由、工具合同与项目初始化模板的发布边界 |
| `bin/wildarrange.mjs`                                              | CLI 入口                                        |
| `src/AGENTS.md`                                              | 五区归属判断、全区依赖不变量和统一修改顺序 |
| **interface/**（宿主/人机交互边界，只依赖 orchestration、infra） |  |
| `src/interface/AGENTS.md`                                    | Interface 局部职责、宿主安全边界和验收要求 |
| `src/interface/dashboard.mjs`                                | 本地 dashboard HTTP 服务、POST token 与 Host/Origin 防护 |
| `src/interface/adapters.mjs`                                 | Codex / Cursor / Kimi adapter 安装、卸载、恢复、共享 Skill 命令生成 |
| `src/interface/kimi-adapter.mjs`                             | Kimi plugin manifest、Hook bridge 与安装说明的纯渲染逻辑 |
| `src/interface/cursor-adapter.mjs` | Cursor `.cursor/hooks.json`、项目感知 Hook bridge（事件/工具名映射与输出协议翻译）与安装说明的纯渲染逻辑；preToolUse 对 Write/Delete/Shell fail-closed |
| `src/interface/hook-bridge-core.mjs` | Kimi/Cursor bridge 共享的项目发现、CLI 子进程与输出解析渲染；宿主超时和失败策略由调用方显式传入 |
| `src/interface/doctor.mjs`                                   | 一键体检：各项检查各自独立 try/catch（单项崩只标红本分项），含 gateArming 门武装、adapters 硬拦截安装/陈旧规则、decisionHealth 周期健康摘要；诊断不再写 ledger |
| `src/interface/decisions.mjs` | `wildarrange decisions` 只读投影：每条决策三行（发生了什么/命中规则/证据），坏行降级；`decisions stats` 确定性统计审查（计数/从未触发的门/标注关联，无 LLM） |
| `src/interface/timeline.mjs` | `wildarrange timeline`：ledger（仅校验通过条目）+ decisions + annotations 统一倒序时间线投影，只读 |
| `src/interface/dashboard-panels.mjs` | Dashboard 决策面板 + 运维面板：只读 ViewModel 与渲染片段（防 dashboard.mjs 超拆分线） |
| `src/interface/cli-help.mjs` | CLI 命令注册表单一事实源：core 六命令分层 help、`docs commands` Markdown 物化 |
| `src/interface/project-init.mjs` | 显式、非覆盖式补建项目治理文档，并返回需要人类确认的清单 |
| **orchestration/**（工作流顺序、重试、gate 编排，只依赖 ai、capabilities、infra） |  |
| `src/orchestration/AGENTS.md`                                | 编排、事务、恢复与完成状态不变量 |
| `src/orchestration/plan-state.mjs`                            | 计划导入、校验、路由 enrichment、任务状态加载                 |
| `src/orchestration/linear-runtime.mjs`                        | 线性任务节点运行时、重试 / checkpoint，经 gateway 调用能力       |
| `src/orchestration/parallel-runtime.mjs`                      | 命令型子 Agent 并行运行、隔离结果、skipped/cleanup 生命周期状态、runner 崩溃逐任务容错、中断对账（incompleteTasks）与 `parallel retry` partial 重试 |
| `src/orchestration/remote-ownership.mjs`                      | 设备登记、远端任务 claim、单写 owner 校验与协调状态 |
| `src/orchestration/handoff.mjs`                               | 跨设备 prepare/push/accept 与显式 takeover |
| `src/orchestration/admission.mjs`                             | 并行 admission 事务：claim → apply → gates → commit/rollback；回滚失败保持 ownership，全程持全局任务锁 |
| `src/orchestration/admission-recovery.mjs`                    | admission 回滚计划、补丁恢复、revalidation / 已集成恢复状态落盘，禁止已 push 成果回滚 |
| `src/orchestration/delivery-pipeline.mjs`                     | 共享交付流水线与完成提交顺序：verify → scope → review → acceptance-proof → checkpoint；ledger → wisdom → digest → tasks.json |
| `src/orchestration/integration.mjs`                           | admission 集成事务：owner/base/main 三重 fence、临时索引 commit、普通 push 与故障对账 |
| `src/orchestration/task-board.mjs`                            | 全项目工单总账、draft/ready、任务 claim/证据/持久化与消息板 |
| `src/orchestration/change-governance.mjs`                     | 任务变更治理、Review Blocker、ChangeRequest           |
| `src/orchestration/status.mjs`                                | 状态报告、Workflow 总结、attentionReport 与 Dashboard 数据 |
| `src/orchestration/workflow.mjs`                               | Workflow 入口、样例计划生成                            |
| **ai/**（AI 策略/prompt/技能匹配/hooks，只依赖 orchestration、capabilities、infra，且 capabilities 只能经 gateway） |  |
| `src/ai/AGENTS.md`                                           | AI 策略、只读边、fallback 与上下文预算约束 |
| `src/ai/routing.mjs`                                          | 请求路由、类别决策与 Stop Hook 每日可读复盘报告                 |
| `src/ai/archivist-router.mjs`                                 | 档案路由员：routing packet、结构化记忆、路由建议              |
| `src/ai/injection.mjs`                                        | 注入点解析、Agent 固定 Skill 绑定、项目 Skill 安全加载、Markdown / Skill 分级预算与按需（动态匹配）挂载 |
| `src/ai/skill-matcher.mjs`                                    | Skill 匹配、优先级打分与可解释路由提示                       |
| `src/ai/context.mjs`                                          | Agent 上下文、身份 Prompt 预算化、恢复快照、会话延续           |
| `src/ai/hooks.mjs`                                            | 宿主生命周期 Hook、Jiuwei 会话身份注入、PreToolUse 范围拦截    |
| `src/ai/suspicion-review.mjs` | LLM 可疑判断异步审查：只读清洗结论包、无 key 确定性 fallback、decisionId 防幻觉锚定；结论只进 `.wildarrange/reports/suspicion.*`，不进完成链 |
| **capabilities/**（原子能力 + gateway，只依赖 infra；orchestration/ai 只能经 `gateway.mjs` 调用） |  |
| `src/capabilities/AGENTS.md`                                 | 原子能力、网关信封和失败语义约束 |
| `src/capabilities/gateway.mjs`                                | 能力网关：静态注册表 + 统一结果信封（capability/status/evidence/sideEffect/duration_ms/cost/error） |
| `src/capabilities/contract-governance.mjs`                    | 接口与数据库契约治理原子能力：scan / apply-card / generate-artifacts；首版接入 Tauri IPC 发现器 |
| `src/capabilities/verify.mjs`                                 | verifier                                       |
| `src/capabilities/scope-guard.mjs`                             | scope guard、realpath 范围校验                      |
| `src/capabilities/worker.mjs`                                 | Worker 执行                                      |
| `src/capabilities/review-gate.mjs`                             | BaiZe 独立复核门（风险/怀疑模式由 Skill 挂载）              |
| `src/capabilities/code-intel.mjs`                              | LSP/typecheck、AST 结构命令、hashline anchor、注释检查门 |
| `src/capabilities/repository-governance.mjs`                  | LuWu 仓库治理报告能力，经 gateway 调用 |
| `src/capabilities/acceptance-proof.mjs`                        | checkpoint 前验收证明链                                 |
| `src/capabilities/checkpoint.mjs`                              | checkpoint 落盘                                  |
| **infra/**（基础设施，不依赖任何上层区） |  |
| `src/infra/AGENTS.md`                                        | 最低层依赖、确定性、文件/锁/命令安全约束 |
| `src/infra/runtime-store.mjs`                                 | 路径、时间/ID、目录、JSON 原子写与 hash 原语 |
| `src/infra/file-lock.mjs`                                     | 统一文件锁原语：stale 恢复（死 pid 立即、不可解析按 mtime 宽限）与可诊断超时（错误带 owner/pid/存活状态） |
| `src/infra/task-state-lock.mjs`                               | 全局任务状态锁（file-lock 原语的路径与默认参数封装） |
| `src/infra/agent-registry.mjs`                                | 固定 Agent 白名单、别名、显示名与 command-worker 资格 |
| `src/infra/runtime-config.mjs`                                | 默认配置、配置合并/归一化（含 reporting.verbosity 汇报分级）与 strict 安全底线 |
| `src/infra/runtime-snapshot.mjs`                              | 运行态 snapshot 与恢复上下文的确定性文件读取/渲染 owner |
| `src/infra/prompt-pack.mjs`                                   | Prompt Pack 安装后物化到固定运行时根，统一校验路径/realpath/hash 后读取 |
| `src/infra/runtime-bootstrap.mjs`                             | `initRuntime` 一次性运行时初始化顺序 |
| `src/infra/ledger.mjs`                                        | hash 链 ledger 追加、校验与可信条目读取（链启动后无 hash 行视为篡改；锁经 file-lock 具备 stale 恢复） |
| `src/infra/command-runner.mjs`                                 | 子进程命令执行、输出截断、超时与 spawn 级失败兜底（error 事件转 127 结果） |
| `src/infra/annotation-log.mjs`                                 | 决策标注回写：强制分类（confirmed/rule_wrong/case_wrong/mislabeled）、规则×标注统计；硬约束——绝不写 config/verify_commands/门开关 |
| `src/infra/command-safety.mjs`                                 | shell 命令高风险预检，阻断明显破坏性 worker/verifier/review 命令；内置正则为不可削弱底线，`commandSafety.extraPatterns` 可外置追加项目规则 |
| `src/infra/error-protocol.mjs` | 统一错误协议 `{code, module, message, next_action}` 与内联单行渲染；覆盖 gateway 信封、delivery-pipeline 返回、CLI 非零退出三处 |
| `src/infra/gate-arming.mjs` | 门未武装黄灯地板：trivial/缺失 verify、同义反复 review、无 required 质量门的只读评估，status 常驻携带 |
| `src/infra/dependency-graph.mjs` | 对抗加固的词法 import 扫描器（边界测试与 `wildarrange impact` 共用）、反向波及分析 `computeImpact`、分区测试选择 `computeZoneTests`/`listRepoTests`（供 `wildarrange test`） |
| `src/infra/security.mjs`                                      | config hash 基线、运行态备份、归档精确恢复包、备份列表与一键恢复、关键状态完整性检查 |
| `src/infra/contract-governance.mjs`                           | 技术栈中立的契约台账、差异卡、覆盖报告、快照生命周期与静态发现器登记；首版发现 Tauri IPC，未知来源降级人工申报 |
| `src/infra/review-findings.mjs`                                | LSP / AST / hashline / 注释检查等质量发现              |
| `src/infra/llm-provider.mjs`                                   | OpenAI-compatible LLM provider 与可选 LLM review |
| `src/infra/agent-spawn.mjs`                                    | Codex / Cursor / 自定义命令型子 Agent spawn 模板渲染       |
| `src/infra/git-worktree.mjs`                                   | Git worktree 隔离、patch 提取与 patch admission        |
| `src/infra/git-coordination.mjs`                               | 设备安全的 Git remote/commit/push/fetch 与集成 SHA 乐观锁原语 |
| `src/infra/git-diff.mjs`                                       | git diff / changed-paths 收集与 manifest 变更分类     |
| `src/infra/path-match.mjs`                                     | 路径归一化、项目根边界断言与 glob/精确/目录匹配（`pathAllowed`）           |
| `src/infra/route-table.mjs`                                    | 确定性路由表加载（含 overrides）与信号匹配（`loadRoutesConfig`/`resolveRouteDecision`），无 LLM |
| `src/infra/failure-analysis.mjs`                                | 失败原因分类、返工提示与失败摘要                              |
| `src/infra/task-reports.mjs`                                    | wisdom / failure report / review report 落盘      |
| `src/infra/task-state-store.mjs`                                | 单文件全项目 Task ledger 读取、旧格式兼容与 active Plan 投影 |
| `src/infra/task-predicates.mjs`                                 | no-op / trivial command 等纯任务形状判断              |
| `src/infra/success-criteria.mjs`                                | 成功判据状态机与 verifier 证据回填                        |
| `src/infra/rule-scanner.mjs`                                    | 项目规范扫描与规则上下文注入                                |
| `src/infra/repository-layout.mjs`                                | 目录边界、README 对等、Prompt 清单、命名与真实注释的只读检查 |
| `src/infra/memory-digest.mjs`                                   | 跨会话 digest、任务完成 digest 与恢复索引                   |
| `src/infra/decision-log.mjs` | `.wildarrange/decisions.jsonl` 统一决策记录：只在 pipeline/hooks/admission/routing 四缝发射，best-effort 不反噬主流程，坏行读侧跳过 |
| `src/infra/hook-result-gate.mjs`                                | PostToolUse 结果门校验                              |
| `test/dependency-boundary.test.mjs`                             | 五区依赖方向强制测试，每次 `npm test` 都会跑                |
| `test/AGENTS.md`                                             | 单元、集成、对抗、包体测试的局部规范 |
| `test/*.test.mjs`                                              | Node 内置测试                                     |
| `.wildarrange/`                                                      | 运行时状态目录，可由 CLI 生成                             |


## 常用命令


| 场景                | 命令                                                               |
| ----------------- | ---------------------------------------------------------------- |
| 初始化运行时            | `node ./bin/wildarrange.mjs init`                                      |
| 生成默认配置            | `node ./bin/wildarrange.mjs config init --root`（`--armed` 直接武装质量门） |
| 登记当前设备            | `node ./bin/wildarrange.mjs device register --name macbook`             |
| 查看 Git 协调状态       | `node ./bin/wildarrange.mjs coordination status`                        |
| 显式远端领取任务        | `node ./bin/wildarrange.mjs coordination claim --task T001 --owner ZhuRong` |
| 准备跨设备交接          | `node ./bin/wildarrange.mjs handoff prepare --task T001 --to-device-id <uuid> --to-device-name mac-mini` |
| 推送跨设备交接          | `node ./bin/wildarrange.mjs handoff push --task T001`                    |
| 接受跨设备交接          | `node ./bin/wildarrange.mjs handoff accept --plan <planId> --task T001`  |
| 安装 adapter        | `node ./bin/wildarrange.mjs adapter install --target all --mode local` |
| 卸载 adapter        | `node ./bin/wildarrange.mjs adapter uninstall --target all`            |
| 恢复 adapter        | `node ./bin/wildarrange.mjs adapter restore --backup <backupId>`       |
| 导入计划              | `node ./bin/wildarrange.mjs plan --from plan.json`                     |
| 跑下一个任务            | `node ./bin/wildarrange.mjs run`                                       |
| 跑 sample workflow | `node ./bin/wildarrange.mjs workflow --sample`                         |
| 跑并行子 Agent       | `node ./bin/wildarrange.mjs parallel run --max-agents 2 --command "..."` |
| 用 worktree 跑子 Agent | `node ./bin/wildarrange.mjs parallel run --task T001 --isolation git-worktree --command "..."` |
| 合入子 Agent 成果     | `node ./bin/wildarrange.mjs parallel admit --run <runId> --task T001`     |
| 查看并行运行记录        | `node ./bin/wildarrange.mjs parallel status --run <runId>`             |
| 关闭保留的子 Agent 结果 | `node ./bin/wildarrange.mjs parallel close --run <runId> --task T001 --reason user_accepted` |
| 清理 Git worktree 隔离目录 | `node ./bin/wildarrange.mjs parallel cleanup --run <runId>` |
| 重跑 run 中未通过的任务 | `node ./bin/wildarrange.mjs parallel retry --run <runId> [--command "..."]` |
| 标注一条决策 | `node ./bin/wildarrange.mjs annotate --decision <decisionId> --category rule_wrong --reason "..."` |
| 查看标注与统计 | `node ./bin/wildarrange.mjs annotate list` / `annotate stats` |
| 门触发统计审查 | `node ./bin/wildarrange.mjs decisions stats` |
| 统一时间线 | `node ./bin/wildarrange.mjs timeline [--limit N] [--task T001]` |
| LLM 可疑判断（异步审查） | `node ./bin/wildarrange.mjs review suspicious` |
| 全量命令 / 物化命令文档 | `node ./bin/wildarrange.mjs --help --all` / `docs commands --write` |
| 匹配 Skill          | `node ./bin/wildarrange.mjs skills match --text "..." --stage plan`    |
| 仓库治理检查           | `node ./bin/wildarrange.mjs governance audit` |
| 生成档案路由包         | `node ./bin/wildarrange.mjs archivist packet --text "..." --stage plan` |
| 运行档案路由员         | `node ./bin/wildarrange.mjs archivist run --text "..." --stage plan --force` |
| 查看路由建议           | `node ./bin/wildarrange.mjs archivist suggestions list`                 |
| 审核路由建议           | `node ./bin/wildarrange.mjs archivist suggestions resolve --id <id> --decision accept --evidence "..." --rationale "..."` |
| 查看状态              | `node ./bin/wildarrange.mjs status`                                    |
| 写入 config 基线      | `node ./bin/wildarrange.mjs config baseline --reason reviewed`          |
| 校验 config 基线      | `node ./bin/wildarrange.mjs config verify`                              |
| 校验 ledger hash 链   | `node ./bin/wildarrange.mjs ledger verify`                             |
| 改动影响分析 | `node ./bin/wildarrange.mjs impact src/infra/ledger.mjs` |
| 查看决策投影 | `node ./bin/wildarrange.mjs decisions --limit 20` |
| 分区/影响面测试 | `node ./bin/wildarrange.mjs test --zone infra` |
| 备份运行态关键文件      | `node ./bin/wildarrange.mjs state backup --reason before-risky-agent`   |
| 迁移旧运行态           | `node ./bin/wildarrange.mjs state migrate`（自动先备份；旧 completed 无当前 proof 时回到待决策） |
| 归档并删除旧任务        | `node ./bin/wildarrange.mjs task archive --task T001 [--plan <planId>] --delete --reason "obsolete"` |
| 校验运行态关键文件      | `node ./bin/wildarrange.mjs state verify`                               |
| 列出运行态备份        | `node ./bin/wildarrange.mjs state list`                                 |
| 恢复运行态备份        | `node ./bin/wildarrange.mjs state restore --backup <backupId>`          |
| 一键体检            | `node ./bin/wildarrange.mjs doctor`                                     |
| 生成总结              | `node ./bin/wildarrange.mjs summary`                                   |
| 启动本地 dashboard    | `node ./bin/wildarrange.mjs serve --host 127.0.0.1 --port 8765`        |
| 完整测试              | `npm test`                                                       |
| npm 包体预检          | `npm pack --dry-run --cache /private/tmp/wildarrange-npm-cache`        |
