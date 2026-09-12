# WildArrange 开发与交付规范

> 本文承接根 AGENTS 的目标、实现边界与工程约束；由根入口按场景要求读取，仍属于项目规范。代码路径均相对仓库根。

> 面向 Agent 与维护者的治理约束。用户安装与快速上手见 [README.md](../README.md)（中文）/ [README.en.md](../README.en.md)（English）。

## 当前目标

实现 WildArrange M1 线性 Agent 循环，并以 5 个长期 Agent（Jiuwei、DiJiang、ZhuRong、BaiZe、LuWu）承载编排、计划、实现、独立复核与仓库治理。Router 是确定性系统节点，专项职责用 Skill 按需挂载。主线仍是可恢复、可验证的单线流程：

```text
init -> plan -> task-worktree -> worker -> verifier -> delivery-commit -> task-branch-push -> PR -> human-merge -> cleanup/ledger
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
- 一个可写任务只能有一个 owner、一个独立 worktree 和一个独立 task branch；两个可写 worktree 不得共享同一分支。开发与 BUG 修复默认从干净 commit 基线创建隔离 worktree；无归属改动优先自动隔离，无法隔离、同文件冲突或所有权不明时才询问开发者。
- 子 Agent 成功运行后默认保留为 `awaiting_user_acceptance`。实现任务通过全部 gate 后必须形成只含本任务路径的本地 delivery commit，并可自动 push 到该任务独占的远端 task branch；acceptance proof 与 checkpoint 必须绑定同一 delivery commit SHA。没有文件变化时记录 `no_change`，不得制造空 commit。
- task branch 中允许保存明确标记的中间 WIP commit，但 WIP 不能使任务 completed。AI 或人类对任务成果的后续修复都必须形成新 commit，不能以长期 dirty 工作区代替版本历史。
- admission 只有在成功提交或工作区成功回滚后才能释放任务所有权；回滚失败必须保留 `verifying` claim 与 rollback plan，并返回 `recovery_required`，直到原 run 完成恢复。
- Git 多设备协调默认使用 `guarded`：有 remote 时以任务分支 claim commit 维护单写 owner，可写并行 Agent 默认使用 worktree；无 remote 时明确降级为本地协调。`strict` 不允许降级。
- Git 协调只允许普通非强制 push；同一任务禁止双写，跨设备 handoff 必须绑定已 push 的 task-branch commit 且 push 前复核 prepare 树指纹，takeover 必须显式记录预期旧设备和理由，不允许按本机时间自动过期 owner。
- task branch 的 delivery commit/push 是任务自身交付，不代表获准进入共享主线。共享主线统一称为 `main`；task branch 进入 `main` 必须通过一个持续更新的 PR、自动检查与独立验收，并由人类明确批准 merge。系统不得以 checkpoint、admission 或本地确认字段代替 Git 托管平台的真实 merge 审批。
- PR 可由系统自动创建或更新为 Draft；Approve 与 Merge 是不同动作。默认由人类批准进入 `main`，生产部署是与 merge 分离的另一项人类授权；development、staging、production 是部署环境，不默认复制为长期 `develop`/`production` 分支。
- 强耦合改动若不能独立验收，归为一个任务在同一 worktree/branch 联合交付；若可拆分，则使用两个任务、两个 worktree、两个 branch，再由独立 integration task 绑定双方 commit SHA 做联合验收。Integration 自身同样拥有独立 worktree/branch，不能写回原实现 worktree。
- task 处于等待验收、返工或 `recovery_required` 时保留 branch/worktree。确认 `main` 已包含 delivery commit 后，先证明 worktree 干净并删除 worktree，再删除本地 branch；删除远端 branch 属于远端变更，必须由人类确认。Worktree 不是长期档案。
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
