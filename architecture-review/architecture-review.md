# 架构复盘 — wildarrange-2026-09-17-full-review

## 1. 结论与评分

对 WildArrange 全仓（src 五区 89 个 .mjs、bin、tooling、packs、test 44 文件）的全量只读架构审查。五区分层与 gateway 单一缝真实成立（依赖边界测试每次 npm test 强制），事务密集型编排层（admission 崩溃续跑、ledger hash 链、delivery pipeline）成熟度高于平均，测试体系 529 用例全绿且无越权扩张。主要债务：9 个 ≥700 行文件多数混合多种变化原因（3 个破千行线）、非完成路径缺统一审计顺序原语并已产生散点倒置缺陷、路由信号匹配三处分散语义不一致、Dashboard 前端改版半成品留下死代码与无 UI 的在线 API、死 re-export 违反项目自定 barrel 禁令。本报告已合并另一 Agent 第三轮审查的可实证声明（经本审查独立复测确认）：importPlan/steering 可持久化无证据 completed、parallel_run_claim 任务仍可被线性 run 选中两个 P0，以及 ledger 坏行后伪造链仍被读侧标 verified、pathAllowed 不折叠 .. 可绕过 scope、Cursor allow 丢注入上下文、review_blocked 无解除边等 P1——完成态权威与 scope 边界的收口比表面更弱。三项评分 82/71/78，不触发系统性整改路线，但安全相关的局部整改清单优先级很高。

| 维度 | 分数 | 置信度 | 判断 |
|---|---:|---|---|
| 奥卡姆剃刀 | 82/100 | 高 | 核心接缝（gateway、delivery pipeline、bridge 共享、词法扫描器）复杂度均有真实收益；扣分集中在死代码/死 re-export 与无 owner 的原语复制。 |
| 人类可维护性 | 71/100 | 高 | 阅读路径与诊断性优秀（目录约定、AGENTS 渐进披露、可诊断锁与体检）；主要债务是 9 个 ≥700 行文件混合变化原因、错误协议双轨、字符串混淆，以及状态写入权威未收口（completed 可经 import/steering/restore 绕门写入）。 |
| 实际可扩展性 | 78/100 | 高 | 同类能力扩展多数局部化（capability 注册一行、检查项注册一行、skill 走 pack）；扣分集中在决策点扩散（命令面/路由/白名单双事实源）与需改框架核心的扩展路径。 |

- 整改路线：不强制；三项分数 82/71/78：无两项低于 70，也无任一项低于 40，不触发系统性整改路线；但存在 8 个 must_address 架构问题与 2 个 P0 + 8 个 P1 常规缺陷（含完成态写权限与 scope 边界的实证绕过面），安全相关的局部整改优先级很高。注：另一 Agent 第三轮审查给出 58/64/59 并判定整改必需，分歧主要来自其把 P0/P1 门禁绕过洞计入架构扣分、并把 Archivist/Skill 群/Tauri discoverer 判为投机复杂度——本审查按规则只把共同结构性根因计入，产品已批准的特性不扣。该结果不自动阻断开发。

评分子维度：

### 奥卡姆剃刀子维度

| 子维度 | 来源 | 状态 | 扣分 | 结论 | 证据 |
|---|---|---|---:|---|---|
| 精简保留业务效果 | 固定 | 健康 | 0 | gate 纵深防御（acceptance-proof 独立重验 review 证据）经核实为有意设计，所有精简建议保留必要行为与已确认测试保障 | E-061、E-062、E-067 |
| 冗余架构层 | 固定 | 问题 | -8 | 6 处死 re-export 违反项目自定 barrel 禁令；security 三个零收益包装、adoption typeof 防御与死参数、Dashboard 约 110 行死 JS/CSS、tooling 多语言模板残留，均属无当前收益的层 | E-015、E-016、E-017、E-018、E-019、E-021、E-035、E-050、E-052、E-007、E-008、E-033 |
| 重复门禁与验证 | 固定 | 问题 | -8 | git 读原语四份、uniqueStrings 六处、normalizeRelativePath 三份、HTTP 设施复制且行为漂移、双 shell 白名单、路由信号匹配三处语义不一致、orchestration 失败处置块多处逐行重复 | E-041、E-034、E-051、E-046、E-047、E-011、E-013 |
| 中间件与抽象成本 | 固定 | 健康 | 0 | gateway 单一缝、hook-bridge-core 参数化共享、dependency-graph 词法掩码的复杂度均有证据证明收益覆盖成本 | E-064、E-067、E-070 |
| 投机性复杂度 | 固定 | 观察 | -2 | route-table 硬编码产品启发式与 llm-provider 单条目 profiles 属轻度预付，影响有限 | E-042 |

### 人类可维护性子维度

| 子维度 | 来源 | 状态 | 扣分 | 结论 | 证据 |
|---|---|---|---:|---|---|
| 模块职责与所有权 | 固定 | 观察 | -5 | 五区边界由测试强制、职责登记完整；但 CLI 渗入业务流程、validate 脚本职能写爆、live config 漂移显示局部所有权失守 | E-002、E-003、E-006、E-009、E-079 |
| 阅读路径 | 固定 | 健康 | 0 | 目录约定逐文件登记职责+AGENTS 渐进披露+架构文档不变量，维护者可沿有限路径定位行为 | E-079、E-074 |
| 抽象可理解性 | 固定 | 观察 | -4 | 多处无注释字符串混淆（join 拼不变量键/别名/文件名），审查者无法 grep 到关键标识符 | E-024、E-036、E-075 |
| 状态与错误真源 | 固定 | 问题 | -10 | 完成路径有 commitTaskCompletionState 统一原语，但非完成路径（导入/批准/claim/恢复）无对应物：已产生 ledger/persist 顺序倒置、异常逃逸无审计，且 normalizeTask/steering/restore 可绕过 pipeline 直接写 completed（实证）；错误协议条文与 224 处裸 throw 长期分叉 | E-022、E-023、E-026、E-076、E-069、E-080、E-083、E-092 |
| 长文件职责 | 固定 | 问题 | -10 | 9 个 ≥700 行文件中至少 7 个混合两种以上变化原因，3 个破千行上限（hooks 1144、linear-runtime 1002、admission 1001）；部分拆分行数驱动而非内聚驱动 | E-045、E-012、E-013、E-040、E-054、E-030 |
| 可诊断性 | 固定 | 健康 | 0 | 锁超时带 owner/pid、ledger 篡改检测、doctor 独立容错分项、决策投影与 attention 报告构成完整诊断面 | E-063、E-073、E-066 |
| 嵌套深度与语法糖克制 | Agent 新增 | 健康 | 0 | 全区净嵌套最深 8 层仅 runProcess 一处，其余 ≤5 且多为事务/词法器固有深度；无 Proxy/元编程/过度函数式炫技；仅个别超长正则与嵌套三元 | E-038、E-037、E-049 |

### 实际可扩展性子维度

| 子维度 | 来源 | 状态 | 扣分 | 结论 | 证据 |
|---|---|---|---:|---|---|
| 同类能力局部性 | 固定 | 观察 | -4 | 新 capability/检查项/skill 局部化好；但新 hook 事件需改主函数+4 个映射函数、新 steering kind 三处同步、新契约 discoverer 需改核心注册表 | E-045、E-042 |
| 框架核心稳定性 | 固定 | 问题 | -6 | 320 行默认配置数据嵌 infra 核心，新增 injection point/skill/agent 默认值都要改底座；hooks 千行混合文件使安全策略/渲染/编排任一变化都改同一核心文件 | E-030、E-045、E-042 |
| 决策点扩散 | 固定 | 问题 | -7 | 命令面双事实源（bin if 链↔cli-help 注册表，测试单向）、路由信号三处语义不一致、双 shell 白名单、delivery-pipeline 六处平行表、108 处手工取值守卫（已漏出 P1） | E-005、E-047、E-046、E-001 |
| 接口与测试扩散半径 | 固定 | 健康 | 0 | gateway 信封统一、capability 注册一行、cli-help 单一事实源驱动物化文档；测试随改动同步由规范强制 | E-067、E-005、E-061 |
| 扩展点真实可用性 | 固定 | 观察 | -3 | 声明的扩展点真实可用（gateway 注册、routes.json、pack manifest）；但面板外挂模式未通用化（新面板改 dashboard-view 三处）、adapter 无注册表需改五处 | E-050、E-051 |
| 配置模板漂移 | Agent 新增 | 观察 | -2 | live config 落后 example 多个治理键，靠默认值兜底；新增配置面时漂移会放大集成成本 | E-009 |


## 2. 必须处理的问题

### ARC-001 — hooks.mjs 1144 行混合安全门/渲染/编排三类变化原因

- 后果与根因：安全策略、渲染模板、事件接线任一变化都改同一破线文件；加 hook 事件需同步主函数+4 个映射函数；安全门恰恰是评审最需聚焦的代码却被稀释；宿主 Hook 全部职责单点聚合，行数上限治理失效
- 最短处理：拆出 pre-tool-guard.mjs（安全/解析）与 hook-render.mjs（渲染），依赖方向不变
- 验证与证据：npm test 中 hooks 相关测试与 cli-smoke 全绿；dependency-boundary 不新增边（E-045、E-046）

### ARC-002 — 三个千行/准千行 orchestration 文件混合多种变化原因

- 后果与根因：linear-runtime(1002)/admission(1001)/adoption(894)/task-board(891) 各混合 2-4 类变化原因；linear-runtime 三处失败处置块逐行重复正是历史上出过 P0 的同款分叉风险；千行上限治理压线失效，拆分以行数而非内聚为驱动
- 最短处理：先抽 linear-runtime 三处失败处置块为助手函数并删重复，再按变化原因拆 delivery worktree 段与 admission 投影段
- 验证与证据：checkpoint-integrity、runtime-integration、adoption-runtime 全绿；行数回到 ≤1000（E-011、E-012、E-013）

### ARC-003 — 非完成路径缺'审计先入 ledger'统一原语

- 后果与根因：plan-state importPlan 先写账后审计、task-board claim 先 persist 后 ledger、admission-recovery 同文件两处顺序相反、remote-ownership claim 非原子——同一根因的散点缺陷，崩溃窗口留无审计状态变更；完成路径有 commitTaskCompletionState，非完成路径（导入/批准/claim/恢复）无对应事务原语，顺序靠各自记性
- 最短处理：在 task-state-lock 层提供 transactWithLedger 助手（先 appendLedger 后 persist），迁移四处已知倒置点
- 验证与证据：checkpoint-integrity 与 state-migration 全绿；新增一条顺序回归测试（E-022、E-023、E-076、E-069）

### ARC-004 — 路由信号匹配三处分散且语义不一致

- 后果与根因：route-table 词边界正则与 skill-matcher 裸 includes 对同一批 signals 命中率不同；orchestration 三处直调 resolveRouteDecision 绕过 routeRequest 的 ledger/决策投影/semantic shadow；routing.mjs:21 死 re-export 正是归属犹豫的痕迹；'路由逻辑该住哪里'没有唯一答案，route-table/routing/skill-matcher 各自演化
- 最短处理：route-table 导出通用信号匹配，skill-matcher 改为复用；删 routing.mjs:21；在依赖边界测试或注释中钉死 resolveRouteDecision 用途
- 验证与证据：路由相关测试全绿；新增一条两处命中率一致性测试（E-047、E-042、E-018）

### ARC-005 — Dashboard 前端改版半成品：死代码与无 UI 的在线 API

- 后果与根因：约 110 行死 JS/CSS 每页运送；路由人工复盘这一治理功能在 UI 上实际不可达，而 /api/panels/routes 等三个 API 仍在线且有测试——功能状态对维护者不透明；面板改版只完成一半，容器删除后 JS/CSS/API 未同步收尾
- 最短处理：确认产品意图后删 renderRouteReviews/renderOpsPanel/renderInbox 等死函数与死 CSS，或恢复容器
- 验证与证据：dashboard-panels 测试按取舍同步更新后全绿（E-050、E-052）

### ARC-014 — 完成态写权限未收口：import/steering/restore 可绕过 pipeline 写 completed

- 后果与根因：normalizeTask 经 validateStatus 直接接受 status=completed（实证：importPlan 只需一条 trivial verify 命令即可持久化 completed，读侧不降级）；steering mark_blocked 可改写终态；state restore 写回无 proof completed——delivery pipeline 的 verify/scope/review/proof/checkpoint 全链可被状态写入入口绕过，doctor 标红但不纠正权威状态；状态写入没有统一权威：normalizeTask/steering/restore 各自接受终态，不经过完成证据校验（与 ARC-003 同族但更严重：不仅是审计顺序，是完成资格本身）
- 最短处理：normalizeTask 把 requestedStatus=completed 降级为 pending/needs_user_decision；steering 禁终态目标；restore 后跑完成证据校验并降级不合格项
- 验证与证据：复测脚本（.tmp/review-xcheck/）importPlan 不得再得到 completed；新增回归测试（E-083、E-092、E-025）

### ARC-015 — 并行 claim 与线性 runnable 未互斥

- 后果与根因：isTaskRunnable 只查 pending+blockers（实证：带 parallel_run_claim 的 pending 任务返回 true），linear-runtime 只守 admission_claim 不守 parallel_run_claim——子 Agent 已认领/已产出的任务可被 runNextTask 再开线性 worker 并独立 completed，破坏一任务一可写 worktree；claim 归属判断分散：并行 claim 写在 parallel-runtime，可运行判断在 task-board，二者不同步
- 最短处理：isTaskRunnable 排除两种 claim；线性入口同样拒绝并给出 resume 提示
- 验证与证据：并行 pass 后立即 run 必须 blocked；新增回归测试（E-084）

### ARC-016 — scope/宿主边界存在三处实证绕过面

- 后果与根因：pathAllowed 不折叠 ..（writable_paths=["src/**"] 可写 src/../.wildarrange/ledger.jsonl）；ledger 坏行后 prevHash:null 伪造链仍被读侧标 verified；Cursor allow 丢注入上下文且无 projectDir 时静默 exit 0——词法 scope 层与宿主桥接层各自的边界承诺比文档宣称的弱；路径归一化只做分隔符/斜杠规整不做 .. 折叠；ledger 读侧信任链重启；Cursor 桥接的 allow/发现失败分支未闭合
- 最短处理：normalizeRelativePath 折叠并拒绝 ..；walkLedger 失败后续条目标 unverified；cursor-adapter 改 allow 输出与 !projectDir 分支（被锁死的测试同步改）
- 验证与证据：复测脚本四项全部转负；新增对抗回归测试（E-086、E-085、E-087、E-088、E-093）

## 3. 目标架构与最短路线

- `keep` 五区分层与依赖边界测试、cap-gateway 单一缝与七字段信封、orch-delivery-pipeline 门序列唯一来源、infra-persistence 锁/ledger fail-closed 设计、packs-config 组织、test-suite 四层结构：复杂性均有证据证明收益，是本项目最成熟的部分（E-061、E-062、E-063、E-064、E-067、E-069、E-074）
- `delete` 6 处死 re-export/barrel 残留、Dashboard 死 JS/CSS（或恢复 UI，二选一）、adoption 死参数与死检查、gate-arming 恒等式、context-attachments 死检查、verification-discovery:840 恒假代码、tooling 多语言模板残留规则：无当前收益且有明确删除证据（消费方已 grep 核实）（E-015、E-016、E-017、E-018、E-019、E-021、E-033、E-039、E-050、E-052、E-007、E-008）
- `merge` git 读原语收敛 git-diff.mjs、uniqueStrings/normalizeRelativePath/truncate 单一实现、Dashboard HTTP 设施抽 http-utils、双 shell 白名单共享只读 pattern、linear-runtime 三处失败处置块抽助手：重复实现已观察到行为漂移，合并消除扩散（E-041、E-034、E-051、E-046、E-011）
- `move` CLI 内 archive 备份编排与 test runner 下沉 src、runtime-config 默认配置抽数据模块、hooks.mjs 拆安全门/渲染/编排、verification-discovery 卡构建段拆出、admission 尾部 agent-run 投影外移：职责错位与长文件混合变化原因，搬移后明确所有权（E-002、E-003、E-030、E-045、E-040、E-013）
- `clarify` 错误协议条文区分区内部 throw 与边界协议化、route-table 硬编码启发式归属（表数据 vs 内置策略）、resolveRouteDecision 限定计划富化只读用途、字符串混淆改字面量+注释：条文/自述与实现分叉，先明确归属再谈修改（E-080、E-042、E-047、E-024）

完整当前/目标结构见 `architecture-comparison.html`。

1. 修复实证安全洞（含第三轮审查声明经复测确认的项）：normalizeTask/steering 拒绝或降级 completed、isTaskRunnable 排除 parallel_run_claim、normalizeRelativePath 折叠并拒绝 ..、walkLedger 坏行后停止标 verified、Cursor allow 附带 additional_context 且 !projectDir 显式收口、review_blocked 提供解除边、LLM 未知决策不得映射 pass；保留：合法完成链（commitTaskCompletionState）与合法 scope 判定行为不变；验证：.tmp/review-xcheck 复测脚本全部转负 + 每项新增对抗回归测试 + npm test 全绿（E-083、E-084、E-085、E-086、E-087、E-088、E-089、E-090）
2. 修复 5 个 P1 功能缺陷：workflow.mjs:28 终止状态、bin:430 maxSteps 守卫、gateway.mjs:56-59 信封 status、verification-discovery.mjs:840 恒假检测、adoption.mjs scan 异常卡死；保留：各功能现有通过路径行为不变；验证：npm test 全绿 + 每个缺陷新增/更新对应回归测试（E-010、E-001、E-055、E-039、E-020）
3. 删除死代码包：6 处死 re-export、Dashboard 死 JS/CSS（或恢复 UI）、adoption 死参数/死检查、恒等式、恒假代码、tooling 模板残留；保留：所有现存可达功能不变；Dashboard 取舍需产品确认；验证：npm test 全绿；删除项均有 grep 无消费方证据（E-015、E-016、E-017、E-018、E-019、E-050、E-052）
4. 抽 strArg 参数守卫 helper 并修复所有缺守卫透传点；加注册表→bin 分支存在性测试；保留：全部 CLI 命令参数行为不变；验证：cli-smoke/cli-help 全绿；--maxSteps 裸标志行为有测试（E-001、E-005）
5. 在 task-state-lock 层提供 ledger 先行事务助手，迁移 plan-state/task-board/admission-recovery/remote-ownership 四处顺序倒置点；保留：状态机与 ledger 事件序列语义不变，仅顺序纠正；验证：checkpoint-integrity、state-migration 全绿 + 新增顺序回归测试（E-022、E-023、E-076）
6. 拆 hooks.mjs 为事件编排/pre-tool-guard/hook-render 三文件；统一信号匹配到 route-table 单一实现并删 routing.mjs:21；保留：六类宿主事件输出与 PreToolUse 判定完全一致；验证：hooks 相关测试与 dependency-boundary 全绿；新增两处命中率一致性测试（E-045、E-046、E-047、E-018）
7. 长文件治理：抽 linear-runtime 失败处置助手、拆 delivery worktree 段、admission 投影外移、verification-discovery 拆卡构建、doctor 拆 checkCompletionIntegrity、默认配置抽数据模块；保留：各模块对外行为不变；验证：npm test 全绿；目标文件回到 ≤1000 行（E-012、E-013、E-040、E-054、E-030）
8. 原语收敛与澄清：git 读原语归 git-diff、小工具归 path-match/runtime-store、HTTP 设施归 http-utils、CLI 业务流程下沉、字符串混淆改字面量+注释、错误协议条文修订（需用户批准）、live config 补齐、adoption-runtime 重复测试合并、doctor.ok 与 armed 拆分；保留：各调用方行为不变；验证：npm test + npm run check:arch 全绿；doctor 输出变化经确认（E-041、E-034、E-051、E-002、E-003、E-024、E-080、E-009、E-059、E-091）

## 4. 观察项与专项问题

### 值得观察的架构问题

| ID | 问题 | 实际影响 | 证据 |
|---|---|---|---|
| ARC-006 | 死 re-export/barrel 违反项目明文禁令（6 处） | adoption/task-board/plan-state/routing/scope-guard 的死转口与'禁止 barrel/shim'规范直接冲突，给读者制造虚假归属 | E-015、E-016、E-017、E-018、E-019 |
| ARC-007 | git 读原语与安全敏感小工具无 owner 多点复制 | rev-parse HEAD 四份、变更探针两套、uniqueStrings 六处、normalizeRelativePath 三份（路径归一化是安全敏感函数）——漂移时已观察到行为差异 | E-041、E-034 |
| ARC-008 | 错误协议条文与实现双轨（224 处裸 throw） | 规范写 {code,module,message,next_action}，orchestration 全区 224 处裸 throw、infra 仅 ledger 走协议工厂、task-state-lock 手工拼 camelCase 字段——新代码无所适从，下游按协议解析会漏 | E-080、E-069 |
| ARC-009 | validate-module-file-map 单脚本 8 类门禁+多语言模板残留 | 一个 489 行上帝脚本混合文件归属/命名/测试对位/registry 同步/HTML 卡片计数 8 类关注，含对本仓库无用的 Rust/Python/Next 规则——'脚本职能写爆'实锤 | E-006、E-007、E-008 |
| ARC-010 | 320 行产品默认配置嵌 infra 核心 | 新增 injection point/skill/agent 默认值都要改 runtime-config.mjs 底座文件，配置调整与加载机制修复两种变化原因互相污染 | E-030 |
| ARC-011 | Dashboard HTTP 设施复制且行为漂移 | adoption-panel 复制 sendJson/readJsonBody/SAFE_ID 后已漂移：JSON 解析失败 400 vs 500、空 body 判断不同——同一 API 面两种错误行为 | E-051、E-077 |
| ARC-012 | 命令面双事实源与 108 处手工取值守卫 | bin if 链与 cli-help 注册表需手工同步，测试只单向覆盖；取值守卫惯用法手工复制 108 处，已漏出 --maxSteps 静默变 1 的 P1 | E-005、E-001 |
| ARC-013 | live config 与 example 配置键漂移 | 本仓库自用的治理配置落后于自己发布的模板（缺 routeGovernance/gitCoordination/skillMatcher 等 9 组键），靠 runtime-config 默认值兜底，真实行为与文件所见不一致 | E-009 |
| ARC-017 | review_blocked 状态机只接了一半 | reviewBlockerFor 只写不读，review_blocked 无任何回到 pending 的转移边——被阻断任务只能停留在终态之外的孤岛，resolution task 完成也不会联动解除 | E-089 |

### 代码风格一致性（不评分）

状态：存在不一致；基线：根 AGENTS.md + doc/code-maintenance.md + src/AGENTS.md 明文规范；项目无 formatter/linter 配置，以同一职责内主导写法为基线（Node ESM、camelCase、async/await、静态 import、node:assert/strict）

- STYLE-001 [watch] 无注释的字符串混淆写法：change-governance.mjs:96、agent-registry.mjs:8-26、runtime-config.mjs:432、adapters.mjs:102/236、doctor.mjs:572 共 7 处改字面量加注释（E-024、E-036、E-075）
- STYLE-002 [must_address] 108 处手工复制的参数取值守卫无 helper：抽 5 行 helper，先修已漏点再逐步替换（E-001）
- STYLE-003 [watch] 行尾 CRLF/LF 不一致：两文件转 LF（E-078）
- STYLE-004 [watch] 函数体内动态 import 偏离静态主导：三处提升到顶部（E-081）
- STYLE-005 [watch] 嵌套三元偏离 if/return 主导写法：两处改直排 if（E-037）
- STYLE-006 [watch] 同模块双 import 语句与未使用 import：合并/删除三处（E-082）

### 测试边界与投入（不评分）

状态：存在局部问题；批准基线：doc/testing-and-acceptance.md 缺失（已记录）；以 test/AGENTS.md 明文授权的四层（单元/集成/对抗故障注入/包体冒烟）与硬规则（断言持久状态、失败路径证明）为项目批准基线

- TEST-001 [watch] adoption-runtime 三对近重复测试：合并 :373/:460、:390/:484、:182/:546 三对，保留持久状态断言更全的一例；保留：并发互斥、维护标记、锁 TOCTOU 三项业务保障全部保留（E-059）
- TEST-002 [watch] runtime-integration 5261 行单文件逼近超时：按域拆 3-4 个文件，不增删用例；保留：124 个用例全部保留（E-060）

### 常规代码问题（不参与架构评分）

- CODE-001 [P1] workflow 主循环缺 awaiting_user_decision 终止状态：workflow.mjs:28 的 includes 列表加 awaiting_user_decision（E-010）
- CODE-002 [P1] --maxSteps 裸标志静默解释为 1：bin/wildarrange.mjs:430 比照 :596 补守卫；抽 strArg helper（E-001）
- CODE-003 [P1] contract-scan 信封 status 失真：gateway.mjs:56-59 按 raw.status 映射；inspectTask 路径 sideEffect 报 none（E-055）
- CODE-004 [P1] verification-discovery 动态检测恒假死代码：删 :840，把 :841 扩为与 :888 同一判定（抽共享谓词）（E-039）
- CODE-005 [P1] adoption scan 异常会话永久卡死：scan 调用包 try/catch，异常置 needs_review 并记录错误（E-020）
- CODE-006 [P2] acceptance-proof scope_check 死分支：acceptance-proof.mjs:22 改为 scope_guard（E-056）
- CODE-007 [P2] admission 实际路径复核漏未跟踪新文件：改用 git status --porcelain 或补 git ls-files --others（E-014）
- CODE-008 [P2] importPlan 审计顺序倒置：appendLedger 移到状态写入之前（E-022）
- CODE-009 [P2] mark_blocked 可改写终态任务：validate 中对 mark_blocked 禁终态目标（E-025）
- CODE-010 [P2] file-lock stale 回收窄竞态：removeLock 前 stat 复核 mtime/内容指纹一致再删（E-029）
- CODE-011 [P2] rule-scanner frontmatter 不兼容 CRLF：startsWith 改 /^---\r?\n/ 匹配（E-043）
- CODE-012 [P2] parallel run index.json 无锁读写：三处统一包 withFileLock（E-027）
- CODE-013 [P2] delivery-pipeline 两处异常逃逸无审计：L105/L356 包 try/catch 转 fail 证据走 finish（E-026）
- CODE-014 [P2] 无界扫描与重复走查的性能隐患：校验传 limit+filter 提前终止；ledger 导出 {entries,verification} 合一走查（E-031、E-032）
- CODE-015 [P3] doctor 陈旧规则检测硬编码 macOS 路径：doctor.mjs:564 正则覆盖 Windows 用户路径形态（E-053）
- CODE-016 [P3] code-intel 路径校验无 realpath：pathInsideRoot 复用 scope-guard 的 realpath 校验（E-057）
- CODE-017 [P0] importPlan/steering 可持久化无证据 completed（第三轮审查声明，本审查复测确认）：normalizeTask 对 requestedStatus=completed 降级为 pending/needs_user_decision；steering 同样禁终态（E-083、E-093）
- CODE-018 [P0] 带 parallel_run_claim 的任务仍可被线性 run 选中（复测确认）：isTaskRunnable 排除 parallel_run_claim/admission_claim；线性入口拒绝并给 resume 提示（E-084、E-093）
- CODE-019 [P1] ledger 坏行后 prevHash:null 伪造链仍被读侧标 verified（复测确认）：walkLedger 在 failures 出现后停止将后续条目标 verified（或要求链重启带显式授权事件）（E-085、E-093）
- CODE-020 [P1] pathAllowed 不折叠 .. 可绕过 writable_paths（复测确认）：normalizeRelativePath 折叠并拒绝 .. 与绝对路径（E-086、E-093）
- CODE-021 [P1] Cursor allow 路径丢弃执行前 Skill 上下文：allow 输出附带 additional_context: result.output；被 deepEqual 锁死的测试同步改（E-087）
- CODE-022 [P1] Cursor 桥接发现失败静默 exit 0：!projectDir 分支显式 deny 或回退烘焙 controlRoot；补 gitfile 无标记测试（E-088）
- CODE-023 [P1] review_blocked 无合法解除边：完成钩子联动解除或加显式 unblock 命令（E-089）
- CODE-024 [P2] LLM 未知决策映射为 PASS：仅 PASS/FAIL/WARN 合法；其余按 WARN 且 pass=false 处理（E-090）
- CODE-025 [P2] doctor.ok 对全部 warn 为真：门未武装与假完成至少一项升 error，或拆分 ok 与 armed 两个字段（E-091）
- CODE-026 [P2] state restore 可写回无 proof 的 completed：restore 后跑完成证据校验，不合格项降级 needs_user_decision（E-092）

## 5. 范围、覆盖与限制

- 根范围：`D:/Development/WildArrange`（`repository`）
- 版本/快照：336de904b12e32662283954e9f6c6bf6c244ab78（当前工作区快照，git status 干净）
- 证据截止：2026-09-17T18:30:00+08:00
- 必审模块：bin-cli、interface-dashboard、interface-adapters、interface-doctor、interface-read-models、orch-linear-runtime、orch-admission、orch-parallel-runtime、orch-adoption、orch-task-board、orch-plan-state、orch-delivery-pipeline、orch-git-sync、orch-governance、orch-status、ai-hooks、ai-routing、ai-context、cap-gateway、cap-gates、cap-governance、infra-runtime、infra-persistence、infra-command、infra-git、infra-analysis、infra-verification、tooling、packs-config、test-suite
- 覆盖结果：已审查 30、已排除 0、证据不足 0
- 包含：src/、bin/、tooling/、test/、packs/、wildarrange.config.json、wildarrange.config.example.json、package.json
- 排除：doc/、docs/、examples/、outputs/、.wildarrange/、.tmp/、node_modules、README 等纯文档内容
- 已读规则：AGENTS.md、doc/development-workflow.md、doc/code-maintenance.md、doc/project-architecture.md、doc/AGENTS.md、bin/AGENTS.md、src/AGENTS.md、src/interface/AGENTS.md、src/orchestration/AGENTS.md、src/ai/AGENTS.md、src/capabilities/AGENTS.md、src/infra/AGENTS.md、test/AGENTS.md、packs/wildarrange-linear/AGENTS.md
- 运行证据：npm test 实测：44/44 测试文件、529 用例全绿，总耗时 256.7s（2026-09-17，最慢 runtime-integration 62.4s / git-coordination 62.2s / checkpoint-integrity 38.5s）、分区抽跑：capabilities 相关 5 测试文件全绿；git-coordination/dependency-boundary/verification-discovery/contract-governance/recovery-transaction 84 用例全绿、CLI 实测：未知命令走错误协议 exit 1；node --check 全部 .mjs 通过；--maxSteps 裸标志静默变 1 经 node -e 实证
- 限制：项目规范 doc/standards/code-and-interface-conventions.md 缺失：以 AGENTS 链与 doc/code-maintenance.md 作为代码与接口一致性基线；项目测试策略 doc/testing-and-acceptance.md 缺失：以 test/AGENTS.md 明文授权的四层结构作为批准基线，未推断更高测试强度已获批准；architecture-review/ 目录在审查前已存在另一 Agent 第三轮审查产物（评分 58/64/59），已备份至 .tmp/architecture-review-prev/；本报告独立形成后，对其全部 P0/P1 声明做了逐项交叉验证（脚本在 .tmp/review-xcheck/）：11 项中 10 项复现确认并合入本报告，仅'审查总线回放车道属同义反复'一项保留分歧（本审查判为有意纵深防御）；其评分更严的主因是把常规 BUG 计入架构扣分并把产品已批准特性判为投机复杂度，与本审查规则不同；npm test 单次全绿不能证明无 flaky；file-lock 竞态、index.json 并发互丢等多进程问题未实机复现，按代码证据定级；Windows 实机行为（rule-scanner CRLF、doctor macOS 正则、大小写不敏感 FS 的 realpath 比较）部分为静态推断；Cursor 宿主对空输出的默认放行语义未在真实宿主点击确认；prompt 文件（packs agents/skills 正文）未逐字全读，仅评估组织与边界

完整模块矩阵、专项检查、证据位置和全部结构化字段见 `review-result.json`。

## 6. 正式产物

- 人类决策报告：`architecture-review.md`
- 完整结构化事实源：`review-result.json`
- 当前/目标架构对比图：`architecture-comparison.html`
