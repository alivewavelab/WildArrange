# 架构审查与第 1~4 期整改复核交接（2026-09-18）

> 用途：交给另一位 Agent 复核本次审查结论与整改质量。本文档自包含；原始审查产物在 `architecture-review/`（`architecture-review.md` 报告正文、`review-result.json` 结构化发现与证据、`architecture-comparison.html` 当前/目标架构对比图）。
> 代码基线：整改前 HEAD `336de90`；整改已提交为 `cb6e1d5`（97 文件，+4997/−3164）。

## 1. 审查方法与范围

- 全量只读审查：src 五区全部 89 个 .mjs + bin + tooling + packs + test 44 个测试文件，由 8 个并行子代理逐文件阅读后汇总；`review-result.json` 经 schema 校验（VALID）。
- 审查前已合并并**独立复测**另一 Agent 第三轮审查的 11 项 P0/P1 声明，其中 10 项经复现脚本实证确认（复现脚本在 `.tmp/review-xcheck/xcheck.mjs`、`xcheck2.mjs`，该目录被 gitignore，复核时可要求重新生成）。
- 唯一保留分歧：「审查总线回放车道」本审查判为有意纵深防御，不计为缺陷。

## 2. 评分

| 维度 | 分数 | 关键扣分 |
|---|---:|---|
| 奥卡姆剃刀 | 82/100 | 死 re-export/死代码、无 owner 的原语复制 |
| 人类可维护性 | 71/100 | 长文件混合变化原因、非完成路径审计顺序无原语、字符串混淆 |
| 实际可扩展性 | 78/100 | 命令面/路由/白名单双事实源 |

## 3. 实证安全洞清单（第 1 期已全部修复，每项附证据与回归测试）

| # | 洞 | 实证（整改前） | 修复 | 回归测试 |
|---|---|---|---|---|
| 1 | importPlan 伪造 completed | `verify_commands:["true"]` 即可持久化 completed | `plan-state.mjs normalizeTask` 对 requestedStatus=completed 一律降级 needs_user_decision | runtime-integration「plan import never persists a requested completed status」 |
| 2 | claim 任务可被线性偷跑 | 带 parallel_run_claim 的 pending 返回 runnable=true | `task-board.mjs isTaskRunnable` 排除两类 claim | review-state-safety-regression「a claimed pending task is not runnable until the claim is released」 |
| 3 | scope 绕过 | `pathAllowed("src/../.wildarrange/ledger.jsonl",["src/**"])===true` | `path-match.mjs` 折叠并 fail-closed 拒绝 `..`/绝对路径 | 同文件单测三类断言 |
| 4 | ledger 伪造链读侧可信 | 坏行后 `prevHash:null` 伪造条目仍进 readVerifiedLedgerEntries | `ledger.mjs walkLedger` 断链后停标 verified | 「forged self-consistent entries after a broken line never enter the verified chain」 |
| 5 | LLM 未知决策放行 | 未知 decision 映射 pass | `llm-provider.mjs` 白名单 PASS/FAIL/WARN，其余 warn+pass=false | test/llm-provider.test.mjs |
| 6 | review_blocked 死状态 | reviewBlockerFor 只写不读，无解除边 | `change-governance.mjs` 加解除路径；mark_blocked 禁终态 | runtime-integration review blocker 用例 ×3 |
| 7 | restore 恢复伪造 completed | 备份恢复不重验完成证据 | `security.mjs restoreRuntimeStateBackup` 恢复后复核证据，不合格降级 | state-migration「state restore downgrades a forged completed task...」 |
| 8 | Cursor 桥接两缺口 | allow 丢注入上下文；无 projectDir 静默 exit 0 | `cursor-adapter.mjs` allow 附 additional_context；无 projectDir 显式收口 | cursor-adapter 12 用例（含被改写的锁死断言） |
| 9 | workflow 空转 | awaiting_user_decision 不在终止列表，空转 50 步 | `workflow.mjs` 终止列表补该状态 | p2-stability |
| 10 | --maxSteps 裸标志 | 静默解释为 1 | bin 补 `!== true` 守卫（第 3 期已整体收敛为 strArg） | cli-smoke 回归 |
| 11 | scope_check 永不命中 | evidence kind 写错 | `acceptance-proof.mjs` 改 scope_guard | project-review 绑定用例 |
| 12 | contract-scan 吞 fail/warn | 信封恒 pass | `gateway.mjs` 按 raw.status 透出，inspectTask sideEffect=none；配套 `contract-governance.mjs scanTask` 只对 error 信封抛错 | capability-gateway 新用例 |
| 13 | 恒假检测 | `new Function` 永不标 dynamicHint | `verification-discovery.mjs` 抽共享谓词 hasDynamicCodeHint | verification-discovery 新用例 |
| 14 | adoption 卡死 | scan 异常会话永久卡 scanning | try/catch 异常置 needs_review | adoption-runtime 新用例 |
| 15 | CRLF frontmatter 读丢 | `---\r\n` 不匹配 | `rule-scanner.mjs` 兼容 CRLF | 「project rules parse CRLF frontmatter」 |
| 16 | 准入漏新文件 | `git diff --name-only` 不含未跟踪文件 | `admission.mjs collectActualAdmissionPaths` 补 `git ls-files --others --exclude-standard` | admission-paths.test.mjs |
| 17 | pipeline 异常无审计 | 两处异常穿透 | `delivery-pipeline.mjs` 两处 try/catch 转 fail 证据走 finish() | 两个注入异常用例 |
| 18 | run index 并发丢写 | 三处 read-modify-write 无锁 | `parallel-runtime.mjs` 包 withFileLock | parallel-run-index-lock.test.mjs（并发 2 用例） |
| 19 | stale 锁竞态 | removeLock 未复核即删 | `file-lock.mjs` 删除前 stat 复核指纹 | 锁竞态单测 |

## 4. 问题聚类与分期（性价比排序）

1. **安全承诺实证破洞**（★★★★★）→ 第 1 期，已修（上表）
2. **一行级真 Bug**（★★★★★）→ 第 1 期，已修（含在上表 9~19）
3. **死代码**（★★★★☆）→ 第 2 期，已删：6 处死 re-export（loadTaskState 复核后保留，它有 16+ 真实消费方）、dashboard 死 JS/CSS 约 110 行、死参数/死检查/恒等式、tooling 模板残留
4. **原语复制**（★★★☆☆）→ 第 3 期，已收敛：uniqueStrings→`infra/text-utils.mjs`、normalizeRelativePath→`infra/path-match.mjs`、git 读原语→`infra/git-diff.mjs`、HTTP 设施→`interface/http-utils.mjs`（坏 JSON 统一 400）、strArg 收敛 bin 141 处守卫、linear-runtime 6 处失败处置与 admission 4 份 rollback 块去重
5. **审计顺序**（★★★☆☆）→ 第 3 期：新增 `transactWithLedger`（先 appendLedger 后 persist，锁方向任务状态锁外→ledger 锁内），迁移 importPlan/claimTeamTask/persistPostIntegrationRecovery/recordRemoteClaimLedgerOnce 四处倒置，7 个顺序回归测试
6. **长文件/脚本**（★★☆☆☆）→ 第 4 期，已拆：hooks 1135→335（+pre-tool-guard 501 +hook-render 316）、linear-runtime→900（+linear-delivery）、admission→875（+admission-projection）、verification-discovery→385（+verification-cards 555）、doctor→451（+doctor-completion）、runtime-config→226（+default-config 321）、validate 脚本拆 validate-flow-grid、bin 下沉 task-archive/test-runner
7. **双事实源**（★★★☆☆）→ 第 2/4 期部分：字符串混淆 7 处改字面量、config 补齐、skill-matcher 信号匹配统一到 route-table（词边界，有意收紧）、resolveRouteDecision 只读钉死、命令注册表↔bin 双向测试
8. **测试卫生**（★★★★☆）→ 未做，第 5 期

## 5. 验证证据

- 每期结束后全量 `npm test`：第 1/2 期 50/50 文件绿；第 3 期 52/52；第 4 期 52/52（约 560+ 用例）。
- `npm run check:arch` 每次通过（最终 105 watched files、0 unowned、0 orphans、flow-grid 0 失配）。
- `npm pack --dry-run` 通过（199 文件，新模块全部入包）。
- 多数安全修复做了变异验证（还原修复→新测试如期变红→恢复后绿）。
- 已知环境噪声：Windows 沙箱 `EPERM: rename` 抖动（prompt-pack staging 与 ledger-tail.json 原子重命名），全量跑中随机出现、单跑即绿，零断言失败；test/AGENTS.md 已要求区分此类抖动。复核时如遇同样现象，单跑该文件确认。

## 6. 建议复核重点（按风险）

1. `normalizeTask` 降级与 `task-state-store.mjs` 对旧 completed 记录的读侧兼容（新旧数据交互）。
2. `isTaskRunnable` claim 互斥是否可能饿死合法任务（claim 清除路径：closeParallelAgentRun / clearParallelRunClaims）。
3. `path-match.mjs` fail-closed 归一化对所有现存调用点的语义影响（hooks、admission、code-intel、context-attachments、rule-scanner 已换 import）。
4. `transactWithLedger` 锁方向与失败语义（ledger 失败→状态不变；persist 失败→账本留痕），及尚未迁移的 approvePlan/recordTaskEvidence 等同类点。
5. Cursor 收口对真实宿主的兼容性（无 cwd/workspace_roots 事件现在会 false-deny，符合 failClosed 设计但需在真实 Cursor 验证一次）。
6. gateway 如实透出 fail/warn 后 `scanTask` 的连带改动（只对 error 信封抛错）。

## 7. 有意行为变化清单（复核时请逐条确认是否认可）

- dashboard 坏 JSON body：500 → 400；adoption 纯空白 body：400 → 按 {} 处理；错误消息统一为 "invalid JSON body"。
- skill-matcher 路由信号从子串匹配收紧为词边界（`bug` 不再因 "debugging" 命中；中文信号不变）。
-  admission/code-intel 等换用 path-match 归一化后，`a/../b` 归一为 `b`（旧实现拒绝），越界仍被拒——方向更严格。
- `wildarrange.config.json` 照抄 example 补齐缺失键（含 `routeGovernance.semanticShadow.enabled: true`），改变本仓 dogfooding 运行行为。
- Cursor：判定 allow 的输出新增 `additional_context` 字段；无 projectDir 从静默放行改为显式收口。

## 8. 遗留决策点与观察项（未整改）

1. 仪表盘 `/api/panels/routes`、`/api/panels/ops`、`/api/panels/routes/annotate` 三个接口在线但无 UI 入口——恢复入口或连接口删除，待产品拍板。
2. E-077：dashboard 错误响应形状不统一（`{error}` vs `{ok:false,error}`），500 直出 error.message 可能泄漏内部路径。
3. 建议给 `writeTextAtomic`/`materializePromptPack` 加 EPERM 重试（今天 10+ 次抖动）。
4. 同类残留：`updateAgentRunLifecycle` 是 run index.json 第四处无锁写入（第 4 期已随 admission-projection 搬迁，锁未加）；tooling 脚本还有第二层 py/rs 模板残留（ENTRY_BASENAMES/PY_EXT 等）；git「变更探针两套」语义刻意不同未合并。
5. 第 5 期待做：adoption-runtime 三对重复合并、runtime-integration（5261 行/62s）按域拆分、错误协议条文修订与 `doctor.ok/armed` 拆分（后两项需用户批准）。
