# 问题聚类与五期优化计划（2026-09-17 初版）

> 本文档是整改开始前输出的原始执行计划，供复核 Agent 对照「计划 → 实际执行」是否一致。
> 配套材料：结构化发现与全部证据见 `review-result.json`（`evidence` 数组 E-001~E-092，含文件/行号/实证摘要）；报告正文见 `architecture-review.md`；执行结果与回归测试对照见 `2026-09-18-remediation-handoff.md`。
> 证据编号在正文中以（E-xxx）标注；实证复现脚本当时在 `.tmp/review-xcheck/`（gitignored，复核时可要求重新生成）。
> 执行状态：第 1~4 期已完成并提交（`cb6e1d5`），第 5 期未开始。

## 一句话总结

审查共发现 8 类问题。前两类是"门禁系统有几个洞"，每处只改几行就能堵上，必须先做；中间三类是"同一个东西抄了好几份"和"先办事后记账"，花中等功夫换长期不出事；最后三类是"文件太大、说法不一、测试冗余"，收益是以后改代码更省心，可以分期慢慢做。不需要推倒重来，整体架构是健康的。

排序原则：**改动行数 ÷ 堵住的真实风险**，改动小、堵真洞的排前面。

## 第 1 类：安全承诺的实证破洞 —— "门禁卡居然能自己刻"（★★★★★）

**人话版**：系统核心卖点是"任务不能说完成就完成，必须过五道检查"。但审查发现几个后门：导入一份计划文件就能直接把任务写成"已完成"；声明"只能改 src 目录"的任务用 `src/../` 绕一下就能改到系统账本；已被并行"工人"认领的任务主线还能再领走重复干。不是理论可能，是脚本实测复现的。

**技术版**（修复点均 ≤10 行）：

- `normalizeTask` 接受 `status=completed` 直接落库（plan-state.mjs:103,142,372；实证 importPlan 后读侧仍 completed）→ 降级为 pending/needs_user_decision
- `isTaskRunnable` 不查 `parallel_run_claim`（task-board.mjs:247；实证返回 true）→ 排除两类 claim（E-015 关联 ARC-015）
- `pathAllowed("src/../.wildarrange/ledger.jsonl", ["src/**"]) === true`（path-match.mjs:15 不折叠 `..`）→ 折叠并拒绝（CODE-020，复测确认）
- ledger 坏行后 `prevHash:null` 伪造条目仍被 `readVerifiedLedgerEntries` 标可信（实证）→ 失败后停标
- LLM 未知决策映射为 pass（llm-provider.mjs:55-56,64）→ 仅 PASS/FAIL/WARN 合法
- `review_blocked` 无解除边：`reviewBlockerFor` 只写不读（change-governance.mjs:74-76）→ 加解除路径
- `mark_blocked` 可改写 completed/verifying 终态（change-governance.mjs:236,354-361）
- state restore 写回无证明的 completed（security.mjs:247）→ 恢复后重验
- Cursor 两处桥接未闭合：allow 丢注入上下文（cursor-adapter.mjs:87-88）、无 projectDir 静默 exit 0（:69）→ 附带 additional_context、显式收口；注意被 deepEqual 锁死的测试同步改

## 第 2 类：一行到几行就能修的真 Bug —— "说明书和实物对不上"（★★★★★）

**人话版**：小字段写错、功能就骗人：主循环遇到"等你做决定"的任务空转 50 圈；`--maxSteps` 不带数字被当成跑 1 步；一项"范围检查"名字写错永远查不到；Windows 换行符导致规则文件头部配置整个读丢。每一个都让某功能"看起来在工作，实际没工作"。

**技术版**：

- workflow.mjs:28 终止状态列表缺 `awaiting_user_decision`（空转至 maxSteps=50）
- bin/wildarrange.mjs:430 `--maxSteps` 缺 `!== true` 守卫（裸标志静默变 1）（CODE-002 / E-001）
- acceptance-proof.mjs:22 `latestEvidence(task,"scope_check")` 永不命中（实际 kind 是 `scope_guard`）
- gateway.mjs:56-59 contract-scan 信封恒 `status:"pass"`，fail/warn 被吞
- verification-discovery.mjs:840 恒假判定，`new Function` 永不标记 dynamicHint
- adoption.mjs:84-92 scan 异常会话永久卡 `scanning`
- rule-scanner.mjs:150 frontmatter 不兼容 CRLF（`---\r\n` 整个读丢）
- admission.mjs:911 `git diff --name-only` 不含未跟踪新文件，事后范围复核漏新建文件（E-014）
- delivery-pipeline.mjs:105,356 两处异常穿透、不留审计
- parallel-runtime.mjs:263-270 等三处 run index 无锁读写；file-lock.mjs:140 stale 回收窄竞态

## 第 3 类：死代码大扫除 —— "仓库里堆着再也不会用的旧家具"（★★★★☆）

**人话版**：一批"写了但没人用"的代码：6 处转发口；仪表盘约 110 行死界面代码——"路由复盘"的后台接口还在运行、还有测试，但页面上根本没入口能点到。不造成功能错误，但每个读代码的人都会在死胡同里浪费时间。

**技术版**：adoption.mjs:894、task-board.mjs:45、plan-state.mjs:286/708、routing.mjs:21、scope-guard.mjs:9-10 死 re-export；dashboard-panels.mjs:189-228/247-271 + dashboard-view.mjs:171-218/533-535/675-684 死 JS/CSS（对应 `/api/panels/routes` 等三个在线无 UI 接口）；adoption.mjs:512 死参数、:406-408 死检查；gate-arming.mjs:37 恒等式；tooling 两脚本 Rust/Python/Next.js 模板残留。决策项：仪表盘接口恢复 UI 入口或连接口删除。

## 第 4 类：同一个东西抄了好几份 —— "六把长得一样的钥匙"（★★★☆☆）

**人话版**：常用小功能被不同文件各抄一份，最多四份；抄的时候一样，后来各自改就不一样了——已有两处行为不一致（同一命令一处报 400 一处报 500）。以后修这类 bug 修了 A 忘了 B，永远修不干净。

**技术版**：`git rev-parse HEAD` 四份（E-041：git-coordination.mjs:75、verification-registry.mjs:227、memory-digest.mjs:113 等）；`uniqueStrings` 六处；`normalizeRelativePath` 三份（E-034，安全敏感）；dashboard.mjs:303-347 与 adoption-panel.mjs:445-479 的 HTTP 设施已漂移（E-051）；hooks.mjs:704-716 vs 732-735 双 shell 白名单（E-046）；bin 108 处 `args.x !== true` 手工守卫（抽 `strArg`）；linear-runtime.mjs:262-285 等三处失败处置块逐行重复；admission.mjs:537-805 rollback 恢复块复制 4 份（E-013）；ledger 幂等写法四种并存。

## 第 5 类：先记账后办事的顺序要统一 —— "先签字再放行"（★★★☆☆）

**人话版**：规矩是"状态变化先记审计账本再改实际状态"，主流程有统一函数保证，其他路径靠程序员自己记——已有四处写反：状态改了账还没记。万一那一瞬间崩溃，就出现"账本没有但实际发生了"的变化，审计承诺落空。

**技术版**（ARC-003）：plan-state.mjs:450 先于 :472 写账（E-022）；task-board.mjs:150-158 claim 先 persist 后 ledger（E-023）；admission-recovery.mjs:158-168 与 :184-210 同文件顺序相反；remote-ownership.mjs:228-243 读→判重→写非原子（E-076）。最短路径：task-state-lock 层加 `transactWithLedger` 助手。正面参照：delivery-pipeline.mjs:37 `commitTaskCompletionState`（E-069）。

## 第 6 类：文件太大、脚本管太宽 —— "一个房间堆四种用途"（★★☆☆☆）

**人话版**：项目自定"一个文件不超过 1000 行"，三个文件超了且都装着好几摊不相关的事：`hooks.mjs`（1144 行）把安全检查、界面渲染、事件接线挤一起；一个工具脚本管 8 种检查。不直接出错，但改起来容易碰倒东西，新人不敢动。放在安全洞修完、重复收敛之后再做，顺序错了会白做。

**技术版**（ARC-001/ARC-002）：hooks.mjs(1144) 拆 事件编排/pre-tool-guard/hook-render；linear-runtime.mjs(1002)、admission.mjs(1001)、adoption.mjs(894)、task-board.mjs(891)、verification-discovery.mjs(916) 按变化原因拆；doctor.mjs(708) 拆 checkCompletionIntegrity(186 行)；runtime-config.mjs 的 320 行默认配置抽数据模块；validate-module-file-map.mjs(489，8 类门禁) 拆 flow-grid lint；bin 的 archive 备份编排/test runner 下沉 src。

## 第 7 类：同一种事有两种说法 —— "两个本子记同一本账"（★★★☆☆）

**人话版**：同一件事要在两个地方各登记一遍，靠人记：命令要在两个文件各注册一次，测试只查一个方向；路由信号在三处各有匹配逻辑，同一句话判断结果可能不一样；规范说"错误按统一格式返回"，实际 224 处没用。新增功能漏登记一边，就出现"菜单有、后厨没有"。

**技术版**：bin if 链 ↔ cli-help.mjs:14-118 注册表（测试单向，E-005）；route-table.mjs:95 词边界正则 vs skill-matcher.mjs:107-124 裸 includes vs orchestration 三处直调 resolveRouteDecision；错误协议条文 vs orchestration 224 处裸 throw（建议修条文，需批准）；字符串混淆 7 处（change-governance.mjs:96 等，join 拼不变量键）改字面量+注释；live config 落后 example 9 组键；doctor.mjs:66 ok 对全 warn 为真（建议拆分 ok/armed）；route-table.mjs:104-168 硬编码启发式与"纯表查询"自述矛盾。

## 第 8 类：测试自身的卫生 —— "考场纪律有点小毛病"（★★★★☆）

**人话版**：测试体系整体高分（529 用例全绿、无越界扩张），但三组测试是同一考场的重复卷；一个测试文件 5261 行跑 62 秒，快撞 180 秒单文件超时线。改语义时两处同步改容易漏；大文件继续长大会随机超时。

**技术版**：adoption-runtime.test.mjs 三对近重复（:373/:460、:390/:484、:182/:546）；runtime-integration.test.mjs 5261 行/124 用例/62.4s 按域拆；plan-control-root.test.mjs:9 固定临时路径改 mkdtemp。

---

# 五期计划

> 原则：先止血（真洞），再清扫（死代码），再收敛（重复与顺序），后结构（拆分），最后卫生（测试与规范）。每期结束都必须 `npm test` 全绿 + 对应回归测试；安全相关期另加对抗测试。每期可独立交付、独立验证（仅第 4 期建议在第 3 期之后，避免拆分与收敛互相返工）。

| 期 | 主题 | 内容 | 状态 |
|---|---|---|---|
| 1 | 安全止血（1~2 天） | 第 1、2 类全部：实证安全洞 + 一行级 Bug，每项配回归测试 | ✅ 已完成 |
| 2 | 清扫（1 天） | 第 3 类 + 第 7 类低成本项：死代码删除、混淆字面量、CRLF、config 补齐；仪表盘接口去留待拍板 | ✅ 已完成（接口保留，决策点移交） |
| 3 | 收敛（2~3 天） | 第 4、5 类：strArg/git 原语/http-utils/白名单合一；transactWithLedger + 四处迁移；失败处置与 rollback 去重 | ✅ 已完成 |
| 4 | 结构（3~5 天） | 第 6 类 + 第 7 类路由项：长文件拆分、bin 下沉、路由信号统一、命令面双向钉死 | ✅ 已完成 |
| 5 | 卫生与规范（1 天 + 持续） | 第 8 类：测试重复合并、runtime-integration 拆分；需批准的规范修订（错误协议条文、doctor.ok/armed 拆分）；观察项转 backlog 三个月后复盘 | ⬜ 未开始 |

**总工作量估计 8~12 天当量**；第 1、2 期做完即消除全部已知实证风险。
