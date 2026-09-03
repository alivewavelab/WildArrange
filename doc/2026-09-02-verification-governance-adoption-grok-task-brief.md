# WildArrange 老项目验证治理接管完整实现

> 给 Grok 的一次性执行任务书
> 状态：**待确认，不得开工**

## 0. 工作区保护（先读，违反即停止）

| 项目 | 冻结值 |
| --- | --- |
| Worktree | `D:\Development\WildArrange` |
| Branch | `main` |
| Baseline HEAD | `7b970a3dae15003549c1f749d46a10acc9de9f24` |
| 外部执行器 | Grok 主 Agent |
| 可用 subagent | 总并发上限 3（主 Agent + 最多 2 个 subagent；平台不足时串行） |
| 已有 WIP | 当前约 165 个 tracked dirty 文件及所有 untracked 文件全部属于既有 WIP；必须继承并保护。尤其禁止覆盖当前未跟踪的 `bin/wildarrange.mjs`、三份 2026-09-02 设计/计划 HTML、`wildarrange.config*.json` 和 `outputs/`。只有本任务书明确列入所有权的文件才允许在授权后逐文件增量编辑。 |

开工只读执行并记录：

```powershell
Get-Location
git branch --show-current
git rev-parse HEAD
git status --short
```

- Baseline HEAD 只用于核对，不授权把现场重置到该 commit。
- 只能留在 `D:\Development\WildArrange` 和 `main`。禁止 `switch`、`checkout`、`rebase`、`merge` 或移动到其他 worktree。
- 如果界面弹出 `Stash Changes / Commit Changes / Discard Changes`，三项都不要选，只能 `Cancel`。
- 禁止 `stash`、`reset --hard`、`clean`、整文件恢复、批量格式化、覆盖或提交不属于本任务的 WIP。
- 实际路径、分支或 HEAD 不符时立即停止写入，只报告现场四元组和 dirty 文件，不得自行纠正。
- 未经用户另行明确授权，不得 pull、fetch 后同步主线、commit、merge、rebase、push、删分支或删 worktree。
- 禁止执行 `D:\Development\WildArrange\.tmp\references\verification-governance-handoff-2026-09-02.zip` 中的任何脚本或二进制；只允许静态读取文本。
- 最终只交到 `ready for review`，不得自行合并。

### 开工前必须取得的两句明确授权

当前用户尚未明确批准以下两项；没有原话授权时只能只读核对，不得写代码：

1. “批准实施计划第 12 节所列的根 `AGENTS.md` 与 `src/capabilities/AGENTS.md` 最小事实更新。”
2. “授权以当前 dirty WIP 为真实实现基线逐文件协调；保护并保留所有非本任务改动。”

“继续”“修复”“开始开发”“按最佳实践处理”均不替代上述两项明确授权。

## 1. 结果目标

在 WildArrange 中完整实现一条用户可见的老项目验证治理接管流程：

```text
adoption start
  -> 全仓只读扫描
  -> Dashboard 展示逐项变更卡
  -> 用户批准 / 拒绝 / 暂缓
  -> 只执行获批项并可恢复
  -> Registry -> 用户 commit A
  -> Bootstrap + Inventory -> 用户 commit B
  -> doctor/status 持续检查新鲜度
```

最终用户能看清每个验证资产“是什么、有什么作用、谁在使用、为什么新增/修改/合并/归档/删除、完成后怎样、最大后果和恢复方法”，并由 WildArrange 接管测试、Gate、Runner、Hook 和历史档案的目录管理。

本轮只关闭三个阻塞点：

1. 没有确定性的消费者发现、证据分级和可执行 adopt 映射。
2. 没有逐卡批准、精确 Apply、本机中断恢复和安全互斥。
3. 没有三文件 Git 锚定、真实消费者、freshness 黄灯和单一 Skill 入口。

不在本轮：自动 commit/merge/push、跨设备继续未完成 adoption、穷举所有动态 Runtime Gate、建立测试运行历史数据库、修改 delivery pipeline 的完成链、增加新的长期 Agent、顺手重构其他脏 WIP。

## 2. 依据与业务边界

| 类型 | 真源或证据 |
| --- | --- |
| 父任务 / 验收项 | 无独立工单；以本任务书与两份 HTML 为一次性交付边界 |
| 产品设计 | `D:\Development\WildArrange\doc\plans\2026-09-02-legacy-project-verification-onboarding-product-design.html` |
| 实施计划 | `D:\Development\WildArrange\doc\plans\2026-09-02-legacy-project-verification-onboarding-implementation-plan.html` |
| 融合评估 | `D:\Development\WildArrange\doc\plans\2026-09-02-verification-governance-integration-assessment.html` |
| 外部复审 | `D:\Development\gamecopilot\audit-wildarrange\2026-09-02-verification-onboarding-audit.md` |
| 原始参考包 | `D:\Development\WildArrange\.tmp\references\verification-governance-handoff-2026-09-02.zip`，只读文本，禁止执行 |
| 根规范 | `D:\Development\WildArrange\AGENTS.md` |
| 就近规范 | `doc/AGENTS.md`、`bin/AGENTS.md`、`src/AGENTS.md`、五区 `AGENTS.md`、`test/AGENTS.md`、`packs/wildarrange-linear/AGENTS.md`；进入相应目录前完整阅读当前版本 |

业务最短链：

```text
老项目仓库
-> 静态证据扫描
-> 用户可判对的变更卡
-> 逐卡可恢复执行
-> Registry / Bootstrap / Inventory
-> 后续计划与 doctor/status 真实消费
```

必须保留现有公共完成链：

```text
verify -> scope -> review -> acceptance-proof -> checkpoint
```

Adoption 是初始化维护流程，不进入 `task.status`，不复用 `approvePlan`，不把 Hook 当最终安全边界。旁路 task/admission 状态机不等于删除或削弱现有模块。

## 3. 允许保留的阻断条件

| 条件 | 防止的真实事故 | 失败粒度 | 实现位置 |
| --- | --- | --- | --- |
| 消费者未知时无 merge/delete 动作 | 动态调用被误删，测试或生产拦截消失 | 单卡 | `verification-discovery.mjs` + card builder |
| 卡片指纹 stale | 批准后现场变化仍按旧方案施工 | 单卡 | `orchestration/adoption.mjs` |
| 路径/realpath 越界拒绝 | symlink 或 `..` 写出项目根 | 单卡 | `path-match.mjs` + recovery transaction |
| 活动 run/admission 与 adoption 互斥 | 两套写流程同时改同一仓库 | 会话 | 短 task lock + maintenance marker + adoption lock |
| 单卡验证失败自动回滚 | 半完成修改继续污染后续卡片 | 单卡 | adoption apply transaction |
| 回滚失败进入 `recovery_required` 并保留 marker | 脏现场被错误宣称可继续 | 会话 | recovery transaction + adoption state |
| commit A/B 或声明输入不一致不得 finalized | 三文件与真实仓库脱节 | 会话 | registry fingerprint + reconcile |
| Dashboard 写 API 安全检查 | 跨站或未授权批准危险变更 | 单请求 | Interface 现有 Host/Origin/token/payload 防护 |

除表中条件外，不得新增会阻断日常 run 的授权状态、哈希门、审查层或第二套账本。`registryFreshness` 漂移只亮黄灯并给出显式下一步，不自动全仓扫描、不阻断日常 run。

## 4. 必须删除或旁路

本任务不是清理旧模块任务，不主动物理删除现有生产机制。只处理以下错误路径：

| 机制 | 动作 | 范围 | 完成证据 |
| --- | --- | --- | --- |
| 用 `approvePlan` 承担逐卡批准 | 不接入 | adoption 新流程 | adoption import/调用搜索为零 |
| 用 `task_archive_recovery` 冒充通用事务 | 从 adoption 路径旁路；抽产品中立底层原语 | `security.mjs` 与新 recovery owner | 旧 API/manifest 逐字段等价测试 |
| Apply 全程持 15 秒全局 task lock | 不采用；改成短锁登记 marker 后释放 | adoption 启动/结束缝 | 并发与超时定向测试 |
| Hook 静默触发全仓扫描 | 禁止接入 | Kimi/Cursor/Codex hook 路径 | 路由/Hook 引用搜索与测试 |
| M1/M2 半成品 CLI | 不进入 help/tool-contract/README | CLI 注册表 | M3 前公开命令搜索为零 |
| Gamecopilot 专属路径或产品名 | 不复制；使用逻辑 locator 与目标项目习惯 | 生成器、模板、文档 | fixture 覆盖非 Gamecopilot 目录 |

删除公共组件前必须先查其他消费者；只要求从 adoption 链旁路时，不得扩大成物理删除。

## 5. 必须实现的最短行为

| 输入 | 处理 | 输出 / 失败表现 |
| --- | --- | --- |
| `adoption start` | 核对现场，创建自包含 session，只读扫描并启动本地 Dashboard | 变更卡总览；业务文件零修改 |
| 验证资产候选 | import/script/glob/CI/Hook/副作用调用点静态追踪并分级 | direct/runner/registered/clue/unknown 证据；unknown 禁止危险动作 |
| 行为测试 Suite | 生成 Registry `planDefaults.verify_commands` 与可选计划模板精确 patch | 以后由 Skill 写入真实 task/plan；不偷改活动任务 |
| 静态检查 / 独立复核 | 映射到 `standards_commands` / `review_commands`；精确同义时才建议既有 `qualityGates` | 近似映射显示 `mappingLoss`，否则 defer |
| Runtime Gate / Hook | 登记实现位置、触发点、拒绝行为和 adapter 建议 | 保持原副作用前位置，不搬进 verifier |
| 用户逐卡决定 | Dashboard 写入内容指纹绑定的 approved/rejected/deferred | 敏感卡逐项批准；无第二套 CLI 批准入口 |
| Apply | preimage -> 精确路径修改 -> 获批验证 -> postimage -> 单卡提交 | 失败回滚本卡；回滚失败 `recovery_required` |
| 所有卡完成 | 生成 Registry 与 locator patch | `awaiting_registry_commit`，等待用户 commit A |
| commit A 存在 | 锚定 `baselineRef`，生成 Bootstrap/Inventory | `awaiting_final_commit`，等待用户 commit B |
| commit B 存在且输入一致 | 重算 Registry/Bootstrap digest 与 discovery universe | `finalized`；漂移则继续黄灯/重新生成 |
| `doctor` / `status` | 读取同一 freshness owner | 过期黄灯、原因与显式修复动作；单项异常不拖垮 doctor |

补充约束：

- 批次边界：一个 session 接管一个仓库；Apply 一次只提交一张卡。
- 冲突所有权：同一路径只能属于一张可执行卡；多来源建议必须先合成一张卡或 defer。
- 幂等与失败撤回：`start/status/resume/reconcile` 先按磁盘事实对账；重复调用不能重复 Apply。
- 日志：只记录 sessionId、cardId、阶段、路径、pre/post digest、验证结果、recovery transaction 和下一步；不造第二套 task ledger。
- 敏感信息：不得把 token、环境变量值、命令输出中的 secret 写入 Registry/Inventory/session。
- 外部命令：扫描阶段绝不执行发现到的命令；Apply 只运行卡片中已展示且用户批准的验证命令，并先过现有 command safety。
- 兼容：没有 Git、配置或已知 Runner 时输出 defer/unknown，不假装完整接管。

### 数据与状态合同

本机会话：

```text
.wildarrange/adoption/<sessionId>/
  session.json
  scan.json
  cards.json
  approvals.json
  transactions/<cardId>/manifest.json + preimage + postimage
```

状态：

```text
scanning -> reviewing -> ready -> applying
         -> awaiting_registry_commit
         -> awaiting_final_commit
         -> finalized

exception: needs_review | recovery_required | cancelled
card: pending | approved | rejected | deferred | stale
```

正式 locator：在 `wildarrange.config.json` 增加可选 `verificationGovernance`，只保存 `registryPath / bootstrapPath / inventoryPath`。它不是新 Gate 类型。路径由扫描建议并通过卡片批准，init 不静默创建。

## 6. 文件所有权与 subagent 分工

Grok 总控先冻结每路文件所有权。未取得第 0 节两项授权前，各路只能只读。

### 路 1：Core Evidence & Recovery Writer

当前阻塞点：扫描证据与通用恢复原语不存在。

唯一生产文件所有权：

- 新增 `src/infra/recovery-transaction.mjs`
- 新增 `src/infra/verification-discovery.mjs`
- 新增 `src/infra/verification-registry.mjs`
- 新增 `src/capabilities/verification-governance.mjs`
- 修改 `src/infra/security.mjs`
- 修改 `src/capabilities/gateway.mjs`

唯一测试所有权：

- 新增 `test/recovery-transaction.test.mjs`
- 新增 `test/verification-discovery.test.mjs`
- 新增 `test/verification-governance.test.mjs`
- 仅在确有必要时增量修改 `test/capability-gateway.test.mjs` 和现有 archive/state restore 测试

交付：M0 合同夹具、M1 扫描/卡片事实、M2-0 通用恢复、M3 digest/fingerprint 算法。

定向验证：上述新增测试 + 现有 capability gateway/archive/state restore 测试。必须证明 `prepareArchiveRecoveryPackage`、`updateArchiveRecoveryPackage`、`kind: task_archive_recovery`、manifest 路径和返回字段不变。

### 路 2：Adoption Orchestration & CLI Writer

当前阻塞点：没有会话状态机、互斥、逐卡事务和 CLI 启动/恢复。

唯一生产文件所有权：

- 新增 `src/orchestration/adoption.mjs`
- 修改 `src/infra/runtime-config.mjs`
- 修改当前未跟踪的 `bin/wildarrange.mjs`，只能在用户确认其为真实 WIP 基线后增量编辑
- 修改 `src/interface/cli-help.mjs`
- 修改 `src/orchestration/status.mjs`

唯一测试所有权：

- 新增 `test/adoption-runtime.test.mjs`
- 增量修改 `test/cli-help.test.mjs`、`test/cli-smoke.test.mjs`
- 仅在必须验证互斥/完成链不变时增量修改 `test/runtime-integration.test.mjs`

依赖：先与路 1 冻结 scan/apply/generate 与 recovery/freshness 函数合同；可并行写状态纯逻辑，不得复制路 1 实现。

交付：状态机、maintenance marker、adoption lock、start/status/resume/reconcile、逐卡事务编排。

定向验证：并发 start、活动 task/admission、stale、越界、验证失败、回滚失败、每个写入点中断、重复 resume 幂等、两次 commit 状态推进。

### 路 3：Dashboard, Skill & Delivery Writer

当前阻塞点：没有唯一批准界面、Skill 入口、freshness 体检和最终用户文档。

唯一生产文件所有权：

- 新增 `src/interface/adoption-panel.mjs`
- 修改 `src/interface/dashboard.mjs`
- 修改 `src/interface/dashboard-panels.mjs`
- 修改 `src/interface/doctor.mjs`
- 新增 `packs/wildarrange-linear/skills/verification-governance.md`
- 修改 `packs/wildarrange-linear/manifest.json`
- 修改 `packs/wildarrange-linear/routes.json`
- 修改 `packs/wildarrange-linear/tools/tool-contract.json`
- Release Gate 才修改 `README.md`、`README.en.md`、`doc/project-architecture.md`、`docs/product/architecture-overview.html`、`doc/generated/commands.md` 和配置示例

唯一测试所有权：

- 新增 `test/adoption-dashboard.test.mjs`
- 增量修改 `test/dashboard-panels.test.mjs`、`test/doctor.test.mjs`
- 增量修改现有 Prompt Pack、adapter、package boundary 测试中直接相关断言

依赖：使用路 2 的 orchestration API；Interface 不直接 import capabilities/ai。Skill 显式调用产品命令，Hook 不触发扫描。

交付：Dashboard 卡片交互、安全 API、doctor freshness、单一 Skill、发布文档。

定向验证：Dashboard Host/Origin/token/payload/ID；敏感卡逐项批准；doctor 单项隔离；manifest/routes/tool contract/真实 CLI 对应；Skill 能随包安装。

### 最后：Grok Integration

- 不抢 Writer 所有权，只处理跨路合同对齐与一次最终集成。
- 只有 Grok 总控可在取得用户明确批准后修改根 `AGENTS.md` 与 `src/capabilities/AGENTS.md`：根目录表增加 6 个新 owner；capabilities 注册名清单增加 scan/apply-card/generate-artifacts。不得改 schema、允许路径清单或放宽依赖白名单。
- `tooling/arch-module-graph/module-file-map.json` 当前按五区目录 include；先运行 `check:arch`。只有验证器实际报告新文件未归属，才提出精确修改，不做机械编辑。
- 同一生产文件只能由一个 Writer 写。Writer 交卷后先核对，再把槽位用于剩余缺口。

## 7. 分阶段门禁

### M0：合同与失败测试

- 冻结 fixture、卡片 schema、三文件 schemaVersion、状态与错误码。
- 证明扫描业务文件零写入、未知消费者无危险动作、发现命令不执行。
- 不公开 CLI、Dashboard 路由、help 或 tool contract。

### M1：只读扫描与可判对卡片

- 复用 `dependency-graph.mjs`、`git-diff.mjs`、`path-match.mjs`、`rule-scanner.mjs`、`repository-layout.mjs` 的现有事实边界。
- package JSON 结构化解析；CI YAML、shell/batch、Hook 只做入口级静态证据。
- direct import、package script、Runner glob、CI/Hook 注册、生产调用点分级；动态 import/变量/eval/generated config 为 unknown。
- 每张卡具备完整解释、精确 patch、验证、回滚、最大后果与 mappingLoss。
- 退出：重复扫描同序同 ID 同 digest；M1 仍无公开入口。

### M2-0：通用恢复原语

- 只泛化底层 copy/path/digest/manifest/restore；不统一旧 archive 的持久 schema。
- 旧 task archive 与 admission 全部行为等价测试通过，M2-1 才能开始。

### M2-1：Dashboard 批准、Apply 与恢复

- Dashboard 是唯一写批准入口；CLI 无 approve/apply/delete 子命令。
- 短 task lock 只登记 maintenance marker；实际流程持 adoption lock。
- 一卡一事务、一卡一验证、一卡一回滚；故障后磁盘能确定唯一下一步。
- 退出：任何故障注入下无越界写、无错误释放 marker、无重复 Apply。

### M3：三文件、Git 锚定和 Skill

- Registry 与 locator 完成后等待用户 commit A；严禁自动 commit。
- Bootstrap 锚定 commit A；Inventory 保存 registry/bootstrap digest 与排除 Inventory 自身的声明输入 fingerprint。
- commit B 后重算一致才 finalized；影响 Registry/Runner/入口/发现范围的变化使其过期，无关业务变化不假报警。
- doctor/status 只读黄灯；全仓扫描只由用户/Skill 显式命令触发。
- 完整联调前不得在 help/tool-contract/README 暴露半成品命令。

### Release Gate

- 同步中英文 README、架构文档、总图、真实 CLI help、生成命令文档、Prompt Pack 和包体。
- 人工完整跑一次 fixture 流程后才宣布入口可用。

## 8. 最小验证

每个 Writer 只跑自身定向测试，候选冻结后由 Integration 统一跑一次：

```powershell
node --test test/recovery-transaction.test.mjs
node --test test/verification-discovery.test.mjs
node --test test/verification-governance.test.mjs
node --test test/adoption-runtime.test.mjs
node --test test/adoption-dashboard.test.mjs
node --test test/capability-gateway.test.mjs
node --test test/doctor.test.mjs
node --test test/cli-help.test.mjs
node --test test/cli-smoke.test.mjs
npm test
npm run check:arch
npm pack --dry-run --cache /private/tmp/wildarrange-npm-cache
git diff --check
```

人工验收只用临时 fixture：

1. 记录初始 HEAD/WIP/文件摘要，运行 `adoption start`，确认业务树不变。
2. 保留动态消费者 unknown，确认无 merge/delete 按钮。
3. 分别批准 adopt/archive，拒绝 change，暂缓 unknown，确认只改获批路径。
4. 注入 Apply 失败和回滚失败，确认回滚或 `recovery_required`。
5. 生成 Registry，用户自行 commit A，再生成 Bootstrap/Inventory。
6. commit B 前改 Runner 输入，确认过期；恢复后 commit B 才 finalized。
7. 改无关业务文件不假报警；改 Registry/声明输入后 doctor/status 黄灯。

- 不新增大测试矩阵、重复 fixture、快照系统、第二套哈希门、对抗框架或旧制品兼容体系。
- 自动化通过不等于用户已经确认删除/合并建议，也不等于跨设备 adoption 已实现。
- Windows 沙箱 `EPERM` 必须与真实断言失败分开报告；不得把零命中测试当 PASS。

## 9. 允许中断用户的情况

只有以下情况才停下询问：

- 第 0 节 worktree、branch、HEAD 任一不符；
- 尚未取得两项开工授权；
- 需要处理未列入本任务所有权的既有 WIP；
- 需要不可逆操作、外部权限、执行 ZIP 内容或真实危险验证脚本；
- 发现必须修改 AGENTS schema、允许路径清单、依赖白名单或削弱 gate；
- 发现会改变交付、验收、回滚或用户批准边界的真实范围升级；
- 缺少无法通过只读调查取得的关键输入。

普通实现细节自行选择最短方案并记录证据，不要逐项打断用户。

## 10. 一次性交卷格式

一次返回：

1. 实际 worktree、branch、baseline HEAD、最终 HEAD；
2. 明确说明未 commit/merge/push，或列出用户另行授权的 Git 动作与真实结果；
3. 三条业务阻塞点如何关闭，哪些旧路径只是旁路而未物理删除；
4. 每路交付物、文件所有权和最终修改文件清单；
5. 生产代码、测试、文档净增减；
6. 新增阻断点数量；若非零，逐项说明防止的真实事故和用户收益；
7. 所有定向/全量/架构/包体验证命令、退出码和真实结果；
8. 人工 fixture 验收每一步的真实结果，未执行项明确写“未验收”；
9. Registry、Bootstrap、Inventory 示例路径及关键字段，不含敏感内容；
10. 只列会阻止下一步的真实缺口；
11. 明确状态为 `ready for review`。

不得宣称未发生的 merge、push、跨设备接管、动态 Runtime Gate 穷举、真实老项目删除验收、完整能力或 100% 验收。
