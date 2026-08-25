# WildArrange

简体中文 | [English](./README.en.md)

WildArrange 是面向 Codex、Cursor 与 Kimi Code 的本地 Agent 治理运行时。第一版刻意保持精简：先跑通**可恢复、可验证的单线闭环**，再考虑多 Agent 并行。

## 它能做什么

WildArrange 把一次编码请求变成带门禁的工作流：

```text
init -> plan -> execute -> verify -> scope -> review -> acceptance-proof -> checkpoint -> resume
```

核心规则：**worker 可以声称完成，但只有 gate 才能判定完成。**

核心运行时是宿主中立的。Codex / Cursor / Kimi adapter 负责注入与恢复增强，但仅凭 CLI 也能跑完整流程。

**小白从这里开始：** 浏览器打开 [doc/plans/2026-08-04-beginner-handbook.html](./doc/plans/2026-08-04-beginner-handbook.html)（部署 → 每步怎么塞自己的要求 → 怎么核对每一道门对错；含 Cursor / Codex / Kimi）。完整命令参考见 [使用说明书.md](./使用说明书.md)。

## Agent 职责

WildArrange 只保留 5 个长期 Agent。确定性 Router 是系统节点，不占 Agent 名额；专项能力用 Skill 按需挂载。Agent 提供分析和执行能力，最终完成状态仍由确定性 gate 决定。

| Agent | 负责什么 |
|---|---|
| **Jiuwei（九尾狐）** | 主编排者兼线性执行官；组织计划、派发 worker，串联验证、复核、checkpoint、恢复和 ChangeRequest。 |
| **DiJiang（帝江）** | 把目标整理成可执行计划、任务依赖、范围、验收标准与验证命令。 |
| **ZhuRong（祝融）** | 在 `writable_paths` 内实现代码或文件改动，提交 DoneClaim 和证据。 |
| **BaiZe（白泽）** | 唯一独立复核者；验证目标、证据、风险和验收，不接受 worker 自证。 |
| **LuWu（陆吾）** | 只读维护仓库秩序；检查分层 `AGENTS.md`、README 同步、命名、文件归属及代码注释规则。 |

系统 Router 负责判断请求属于咨询、计划、执行、验证或恢复，并选择主 Agent 与 Skill。`CangJie` 是可选的内部档案/语义路由配置，不是长期 Agent。

专项职责改为 Skill：`review-product-intent` 检查产品目标，`map-user-journey` 补齐用户旅程，`design-acceptance` 设计可验证验收，`review-ux-interaction` 复核交互状态，`review-scope-tradeoff` 控制范围，`research-domain-benchmark` 做最小必要对标；`inspect-codebase` 与 `research-external-docs` 分别承接代码检索和外部研究。

角色 Prompt 位于 `packs/wildarrange-linear/agents/`，Skill 位于 `packs/wildarrange-linear/skills/`；Prompt、Tool 和 Skill 均在开发时静态登记并随版本发布，不在任务运行期间临时注册。

## 安装、跨设备与升级

### 环境要求

- Node.js 20 或更高版本。
- npm 公共包无需登录即可安装；只有发布者执行 `npm publish` 时需要登录。
- 使用 Git worktree 隔离时，项目还需要安装 Git。

### 临时体验

只想在当前项目快速试用时，可直接运行：

```bash
npx @alivewavelab/wildarrange@latest init
npx @alivewavelab/wildarrange@latest adapter install --target all
npx @alivewavelab/wildarrange@latest doctor
```

这种方式每次通过 `npx` 解析版本，适合体验，不适合作为团队项目的固定依赖。

### 项目内正式安装（推荐）

长期使用时，把 WildArrange 固定为项目的 `devDependency`：

```bash
npm install --save-dev @alivewavelab/wildarrange@latest
npx wildarrange init
npx wildarrange adapter install --target all --mode local
npx wildarrange doctor
```

把 `package.json` 和 `package-lock.json` 提交到项目仓库。这样团队成员与 CI 使用 `npm ci` 时会安装同一版本，不会因 `latest` 更新而悄悄改变行为。

`adapter install` 是项目级安装：它会根据当前设备和当前项目生成 Codex、Cursor、Kimi Code 的接入文件。`.helix/`、`.cursor/` 等本地运行产物通常不进入 Git，因此每台设备都应重新执行一次，而不是复制另一台设备的生成结果。

### 在另一台设备安装

先克隆或拉取业务项目，然后在项目根目录运行：

```bash
git clone <project-repository>
cd <project-directory>
npm ci
npx wildarrange init
npx wildarrange adapter install --target all --mode local
npx wildarrange doctor
```

如果项目已经存在，只需从 `git pull` 和 `npm ci` 开始。

对于 Kimi Code，还需从项目根启动 Kimi Code，并在每台设备显式执行：

```text
/plugins install .helix/adapters/kimi/plugin
/reload
```

### 升级

在项目根目录执行：

```bash
npm install --save-dev @alivewavelab/wildarrange@latest
npx wildarrange adapter install --target all --mode local
npx wildarrange doctor
```

升级会修改 `package.json` / `package-lock.json`，应把这两个文件提交到项目仓库。其他设备拉取后运行 `npm ci`，即可切换到锁定的新版本。

检查本项目安装版本与 npm 最新版本：

```bash
npm ls @alivewavelab/wildarrange
npm view @alivewavelab/wildarrange version
```

Kimi Code 的 plugin 是用户级安装。升级后为确保 Hook bridge 使用新生成内容，在 Kimi Code 中执行：

```text
/plugins remove wildarrange-adapter
/plugins install .helix/adapters/kimi/plugin
/reload
```

### 运行状态与跨设备边界

npm 和 Git 负责同步程序与项目配置；`.helix/` 仍是每台设备自己的运行态，不直接互相覆盖。WildArrange 默认把现有 Git remote 当作“交接柜”：一个任务只有一个远端写 owner，换设备时用带任务包和 ledger hash 的 checkpoint commit 接力。

每台设备首次使用时登记稳定身份。名称只用于阅读，真正的交接目标是命令返回的 `deviceId`：

```bash
npx wildarrange device register --name macbook
npx wildarrange device status
npx wildarrange coordination status
```

领取和跨设备交接：

```bash
# 原设备：领取任务并工作；把目标设备查到的 UUID 填进 --to-device-id
npx wildarrange coordination claim --task T001 --owner ZhuRong
npx wildarrange handoff prepare --task T001 \
  --to-device-id <target-device-uuid> --to-device-name mac-mini
npx wildarrange handoff push --task T001

# 新设备：deviceId 必须与交接目标一致
npx wildarrange device register --name mac-mini
npx wildarrange handoff accept --plan <planId> --task T001
```

`prepare` 同时收集工作区改动和已经本地 commit、尚未进入远端任务分支的改动，只把 `writable_paths` 内的项目文件写入临时 Git tree；`.helix/` 永不进入交接，当前 index 也不会被污染。`push` 前会复核当前树与 prepare 时的指纹，期间又发生编辑时要求重新 prepare；推送只做普通非强制 push，失败后重试会先对账远端 SHA 并补齐审计。`accept` 校验远端 commit 包、目标设备 UUID 和本地干净状态后取得所有权，同名设备不能冒领。接受成功后，原设备的 execute / verify / scope / review / checkpoint / admission 都会因所有权变化而被拒绝；一体化 `run` 也会在完成前再次验权。

只有确认原 owner 不再工作时才能显式接管，并必须给出预期 owner 和理由：

```bash
npx wildarrange handoff takeover --plan <planId> --task T001 \
  --expected-device-id <old-device-uuid> --reason "原设备离线，已人工确认停止写入"
```

不会使用本机时间自动判定 owner 过期，也不会 force push。任意设备都能执行 admission，但开始时会获取并绑定远端集成分支 SHA；当前工作目录必须包含该基线，且除本 run 结果与已确认 handoff 路径外不能夹带其他脏改动。全部质量门与 acceptance proof 通过后，WildArrange 才生成以该 SHA 为父提交的集成 commit，并普通 push 到远端主分支；主分支变化、本地基线落后或存在无归属改动时返回 `revalidation_required`，安全回滚本 run 文件且不写 checkpoint。若远端 push 已成功、仅本地 checkpoint/审计写入失败，则保留同一 run 的所有权和集成意图；即使随后 main 前进、任务 owner 变化或远端历史异常，也绝不回滚已知 push，只允许同 run 对账恢复或进入 `recovery_required`。

进程被强制终止后，若 `parallel status` 显示 run 没有结果但任务仍被占用，可在人工确认进程已经结束后执行：

```bash
npx wildarrange parallel close --run <runId> --reason "confirmed process terminated"
```

该命令会按 `runId` 扫描任务状态并释放空结果的幽灵 `parallel_run_claim`，不依赖 `results` 列表。

### Git 协调强度

默认配置位于 `helix.config.json`：

```json
{
  "gitCoordination": {
    "mode": "guarded",
    "remote": "origin",
    "integrationBranch": "auto",
    "taskBranchPrefix": "wildarrange/task",
    "requireWorktreeForParallelWrites": true,
    "requireVerificationBeforeHandoff": false,
    "requireCleanHandoff": true,
    "requireTakeoverReason": true
  }
}
```

| 模式 | 行为 |
|---|---|
| `off` | 关闭 Git 协调，保留原本的单机流程。 |
| `manual` | 只有显式 `coordination` / `handoff` 命令使用远端协调；`parallel run --coordinate` 可单次启用。 |
| `guarded`（默认） | 有 Git remote 时自动 claim，并让可写并行 Agent 使用 worktree；无 remote 时降级为本地模式并返回原因。 |
| `strict` | Git 仓库、remote、worktree、交接前验证缺一即拒绝。 |

可调的是自动启用程度、无 remote 时能否降级、交接前是否强制验证。只要不是 `off`，单任务单写者、禁止 force push、跨设备 handoff 绑定已 push commit、远端 main 变化后重验、接管必须显式留证这些底线不可关闭。

### 本仓库开发

维护 WildArrange 源码本身时使用：

```bash
node ./bin/helix.mjs init
node ./bin/helix.mjs adapter install --target all --mode local
```

## 最小工作流

创建计划 `plan.json`：

```json
{
  "title": "Todo app smoke",
  "objective": "Write one verifiable artifact",
  "tasks": [
    {
      "id": "T001",
      "subject": "Write smoke artifact",
      "writable_paths": [".helix/artifacts/smoke.txt"],
      "worker_command": "node -e \"const fs=require('fs'); fs.mkdirSync('.helix/artifacts',{recursive:true}); fs.writeFileSync('.helix/artifacts/smoke.txt','ok\\n')\"",
      "verify_commands": ["node -e \"const fs=require('fs'); if(fs.readFileSync('.helix/artifacts/smoke.txt','utf8').trim()!=='ok') process.exit(1)\""],
      "review_commands": ["node -e \"const fs=require('fs'); if(!fs.readFileSync('.helix/artifacts/smoke.txt','utf8').includes('ok')) process.exit(1)\""]
    }
  ]
}
```

> `review_commands` 不能省：验收证明会拒绝「没有任何独立复核信号」的任务进入 completed（同义反复的复核不证明任何东西）。独立信号可以是 `review_commands` / `standards_commands` / `review.llm` / 已启用的质量门之一。

运行：

```bash
node ./bin/helix.mjs plan --from plan.json
node ./bin/helix.mjs run
node ./bin/helix.mjs status
node ./bin/helix.mjs summary
```

或直接跑内置样例：

```bash
node ./bin/helix.mjs workflow --sample
```

### 工单总账

新功能、独立 Bug、已完成任务的验收纠错和维护工作都使用同一个 Task 模型，并落盘到 `.helix/team/tasks.json`。Plan 只负责分组；跨 Plan 引用使用 `<planId>:<taskId>`。验证信息还没准备好时可以先建 `draft` 留底，draft 不能执行：

```bash
node ./bin/helix.mjs task create --title "修复登录失败" --type bug --priority P0
node ./bin/helix.mjs task list --all --type bug
node ./bin/helix.mjs task ready --task T001 --from task-details.json
```

同一次 Task 内 verifier 失败只增加 attempt 和历史证据；已经完成后又被验收打回，创建 `acceptance_correction` Task，并用 `--parent <planId>:<taskId>` 关联原任务。Dashboard 的“工单总账”页显示全部 Plan，支持按类型、状态、Plan 和关键词筛选，并可展开状态历史。

## 重要 API 约定

`runNextTask` 返回的是**运行时下一步动作**，不等于任务持久状态。

verifier 失败时，任务会回到 `pending` 等待重试，但返回值可能是：

```json
{
  "status": "retry",
  "task": { "status": "pending" }
}
```

这是有意设计：`result.status` 表示运行时建议的下一步；`task.status` 表示磁盘上的任务状态。

## Adapter

```bash
node ./bin/helix.mjs adapter install --target all --mode local
node ./bin/helix.mjs adapter uninstall --target all
node ./bin/helix.mjs adapter restore --backup <backupId>
```

安装、卸载、恢复都会在 `.helix/adapters/` 写入报告；覆盖或删除前会备份已有 adapter 文件。`restore` 用于把 `.helix/adapters/backups/<backupId>/` 里的文件恢复回原位置。

- **Codex**：生命周期 hook 写入 `.codex/hooks.json`，并在 `.helix/adapters/codex/hooks.json` 保留审计副本。Codex 需要在可信项目中通过 `/hooks` review / trust 后才会执行这些 hard hook。
- **Cursor**：项目级 hooks 写入 `.cursor/hooks.json`（含 `.cursor/hooks/wildarrange-hook-bridge.mjs` 桥接脚本），在受信任工作区中自动加载，`preToolUse`（Write/Delete/Edit/Shell）与 `beforeShellExecution`（集成终端命令）可硬拦截且 fail-closed；`.cursor/rules/wildarrange.mdc` 保留为软规则层。`.gitignore` 模板对 `.cursor/hooks.json` 与 `.cursor/hooks/` 留了例外，硬拦截配置可以随仓库提交共享给团队；每台机器是否真装了 hooks 由 `doctor` 的 `adapters` 分项检查。
- **Kimi Code**：生成项目专属 plugin 到 `.helix/adapters/kimi/plugin/`，复用项目根 `AGENTS.md` 和 `.agents/skills/`。WildArrange 不会静默改写用户级 `~/.kimi-code/config.toml`；从项目根启动 Kimi Code，显式执行 `/plugins install .helix/adapters/kimi/plugin`，再执行 `/reload`。不要给路径加引号，Kimi Code 0.27 会把引号当成路径字符。plugin 是用户级安装，但 bridge 会在非 WildArrange 项目中静默退出。

Codex 新会话的 `SessionStart` 会自动注入完整 Jiuwei 身份 Prompt；上下文压缩后的 `PostCompact` 会再注入一次用于恢复身份。普通 `UserPromptSubmit` 不重复注入，避免每轮对话浪费上下文。Prompt 来自已安装且经过 hash 校验的 Prompt Pack，并受 `contextBudgets.prompt.maxChars` 限制；截断会明确显示。

`adapter install` 还会生成一组快捷命令，省去手动开终端敲 `node ...`。三端从同一套命令集渲染（`helix-config` / `helix-doctor` / `helix-refresh` / `helix-status` / `helix-plan` / `helix-approve` / `helix-run`）：

- **Cursor**：`.cursor/commands/<name>.md`（纯 Markdown 斜杠命令，聊天输入 `/helix-doctor` 触发）。
- **Codex / Kimi Code**：共享 `.agents/skills/<name>/SKILL.md` 项目 Skill；Codex 可通过 `/skills` 或 `$helix-doctor` 触发，Kimi Code 按其项目 Skill 机制发现和调用。

每个命令本质是一段提示词，指示 AI 去执行对应的 `helix.mjs` 子命令并汇报结果——是"让 AI 代你敲 CLI"的快捷方式，不是原生按钮。

Kimi Hook 在正常运行时可拦截越界 Write/Edit 和明显高危 Bash，但 Kimi 的 Hook 执行器在 Hook 崩溃或超时时会 fail-open（失败放行）。因此它不能替代 WildArrange 的 verifier、scope、review、successCriteria、acceptance proof 与 checkpoint 最终质量门。

## 多 Agent 最小闭环

命令型子 Agent 可以并发运行；默认 `guarded` 且仓库存在 remote 时，可写 Agent 自动使用独立 Git worktree。无 remote 或配置为 `manual/off` 时沿用配置中的 `parallelAgents.isolation`：

```bash
node ./bin/helix.mjs parallel run --max-agents 2 --task T001,T002 --agent ZhuRong --command "..."
node ./bin/helix.mjs parallel run --task T001 --agent ZhuRong --adapter codex
node ./bin/helix.mjs parallel list
node ./bin/helix.mjs parallel status --run <runId>
node ./bin/helix.mjs parallel cleanup --run <runId>
```

子 Agent 若要提交主线成果，需要在 `agent-result.json` 写入结构化文件：

```json
{
  "summary": "artifact ready",
  "files": [
    { "path": "src/example.txt", "content": "ok\n" }
  ]
}
```

合入时不会直接信任子 Agent。`parallel admit` 会先检查 `writable_paths`，再跑 verifier、scope guard、review gate、acceptance proof 和 checkpoint：

```bash
node ./bin/helix.mjs parallel admit --run <runId> --task T001
```

成功的子 Agent 结果不会立即关闭，而是保留为 `awaiting_user_acceptance`。只有 `parallel admit` 跑完整 gate 并完成 checkpoint 后，才会标记为 `released`。

## 防御性校验

```bash
node ./bin/helix.mjs config baseline --reason reviewed
node ./bin/helix.mjs config verify
node ./bin/helix.mjs state backup --reason before-risky-agent
node ./bin/helix.mjs state migrate
node ./bin/helix.mjs state verify
node ./bin/helix.mjs state list
node ./bin/helix.mjs state restore --backup <backupId>
node ./bin/helix.mjs task archive --task T001 --plan <planId> --delete --reason "obsolete"
node ./bin/helix.mjs doctor
node ./bin/helix.mjs governance audit
node ./bin/helix.mjs impact "src/infra/ledger.mjs"
node ./bin/helix.mjs decisions --limit 20
node ./bin/helix.mjs decisions stats
node ./bin/helix.mjs timeline --limit 30
node ./bin/helix.mjs annotate --decision <decisionId> --category rule_wrong --reason "..."
node ./bin/helix.mjs annotate stats
node ./bin/helix.mjs test --zone infra
node ./bin/helix.mjs docs commands --write
node ./bin/helix.mjs review suspicious
```

`doctor` 是一键体检：校验 config 结构与挂载、对账所有 Plan 的已完成任务（checkpoint / acceptance proof / ledger 事件必须以 `planId:taskId` 对齐）、验证 ledger hash 链，并与最近一次备份交叉比对以发现整链重写；`decisionHealth` 分项给出周期健康摘要（各门触发计数、从未触发的门、坏行与孤儿标注预警）。各项检查各自隔离，单项崩溃只标红对应分项；doctor 只读诊断，不写 ledger。`state migrate` 会先自动备份，再迁移运行态任务总账并删除已退役的运行态投影；它不会改写项目根的 `helix.config.json`。没有当前 proof chain 的旧 `completed` 会进入 `needs_user_decision`，不会伪造新验收证据。`state restore` 恢复前也会自动再做一次备份。

`task archive ... --delete` 需要显式删除确认，并且会先做运行态备份；`in_progress` / `verifying` 任务不可归档。Plan/Task ID 必须是安全单段标识符，canonical `planId:id` 身份必须唯一，显式 `--plan` 必须精确命中，不能回退到其它 Plan；未索引旧 Plan 也只删除指定 Task。删除采用可回滚事务并最后提交权威任务总账，仅清理目标 Task、空 Plan、对应 checkpoint / acceptance report、该任务的 outbox DoneClaim，以及未被其它任务共用的 `.helix/artifacts/` 精确非 glob 产物。本次精确删除集会写入对应 backup 的 recovery package；进程中断或需要撤销时可执行 `state restore --backup <backupId>` 恢复 Plan、证明、DoneClaim 与 artifact。清空活动 Plan 后系统进入 `idle`，不会自动激活其它 Plan。历史 ledger 与 backups 不随归档删除。

`impact` 是改动影响分析：列出一个文件被哪些文件直接或间接 import，以及应该跑哪些测试（含常驻的五区边界测试），让 AI 改一处后能机器化证明「没碰别的模块」。

`decisions` 是决策投影：delivery-pipeline 五门、PreToolUse/PostToolUse 拦截、admission、routing 四个缝的每一次拦截/通过都会追加到 `.helix/decisions.jsonl`（可丢可截断的派生日志，不进 hash 链），`decisions` 命令把每条记录渲染成三行——发生了什么、命中哪条规则、证据在哪，方便人和异步审查 Agent 逐条复盘。支持 `--task` / `--gate` / `--annotatable`（只看可标注队列）过滤与 `--format json`。读侧从文件尾部流式倒读，`--limit` 约束真实内存占用；长期运行后可直接 `truncate -s 0 .helix/decisions.jsonl` 清空（请截到 0 而不是半行；即使截到半行，写入侧也会自动补换行，读侧跳过坏行）。

`test` 是分区测试选择：`--zone <区>` 跑「引用了该区文件的测试 + 命名对位测试 + 常驻边界测试」，带文件参数时按 impact 的应跑清单跑，不带参数跑全量；退出码透传 `node --test`。改了哪就跑哪，不必背测试矩阵。

`annotate` 是标注回写：决策可用 `annotate --decision <id> --category confirmed|rule_wrong|case_wrong|mislabeled` 标为确认正确、规则错、个案错或误标。理由可选；`annotate stats` 按「规则 × 标注」聚合，单条标注不绑架整条规则。**标注永远不能自动改门**——标注路径不写 config、不改 `verify_commands`、不动任何门开关（有测试钉死），调门只能由人显式改配置。

`decisions stats` 是确定性统计审查（纯代码、可重跑、无 LLM）：每个门的触发计数（按决策/规则细分）、**从未触发的门**（门形同虚设的直接信号）、以及标注与规则的关联。冷启动期只出计数不出率。`timeline` 把 ledger（仅 hash 链校验通过的条目）、decisions、annotations 合并成一条倒序时间线，回答「这个仓库最近发生了什么」，支持 `--task` / `--source` 过滤。

CLI 是分层的：`--help` 默认只显示核心六命令（init / plan / run / status / decisions / doctor），覆盖日常主循环；全部命令见 `--help --all`。命令清单的单一事实源是 `src/interface/cli-help.mjs` 的注册表，`docs commands --write` 把它物化成 `doc/generated/commands.md`；README 命令真实性检查对照的是 `--help --all` 全量输出。

`review suspicious` 是 LLM 可疑判断（异步审查，archivist 不变量）：只把清洗后的结论包（id/门/规则/摘要，绝无代码块、raw diff 或完整命令输出）发给配置的外部 provider，返回的可疑清单必须锚定输入包内的 decisionId（幻觉 id 直接丢弃并计数）；无 key 时确定性 fallback，不阻断任何流程。结论只写入 `.helix/reports/suspicion.*`——**不进完成链、不改配置、不动门开关**。

Dashboard（`serve`）包含全项目工单总账、路由复盘台、决策面板与运维面板。工单总账直接读取 `.helix/team/tasks.json`，展示全部 Plan、工单类型、优先级、关联任务与状态历史。路由复盘台按日期展示用户原文、结构化路由结果、命中信号、语义第二意见及同会话后续工具摘要，并可人工标记正确/规则错/个案错；工具参数中的常见密钥字段会脱敏。IDE `Stop` Hook 会主动更新中文日报 `.helix/reports/routing/latest.md`（同日归档为 `YYYY-MM-DD.md`），先给结论，再列全部判断和工具明细。复盘只写 annotation，不自动修改 `routes.json`。

`run` 结束时的门决策汇总按 `reporting.verbosity` 分级：默认 `verbose` 在 stderr 输出本次任务每个门的三行投影（框架初期让人能审判每一条门决策）；信任建立后可改为 `normal`（一行结果）或 `quiet`（只输出 JSON）。stdout 的机器可读 JSON 在任何级别下都不变。

并行运行中断后，`parallel status --run <runId>` 会显示 `batchStatus` 与 `incompleteTasks`（有头无尾的任务）；`parallel retry --run <runId>` 只重跑未通过的任务（复用原命令，可用 `--command` 覆盖），已通过/已完成/被其他 run 持有的任务跳过并说明，重试是新的 run，不改写原 run 证据。

`status` 输出顶部常驻 `gateArming` 黄灯：默认配置下质量门全关、review 门没有独立信号时会显示「门未武装」及修复指引，避免对着一条全绿但不证明任何东西的门流误判项目健康。验收证明（acceptance proof）有两条硬地板：拒绝 `verify_commands` 全是 trivial 命令（如 `true`）的任务；拒绝 review 门没有任何独立信号 lane（无 `review_commands` / `standards_commands` / `review.llm` / 已启用质量门）的任务——同义反复的复核不证明任何东西，不得进入 completed。`config init --armed` 可以直接生成一份武装了质量门（commentChecker 阻断 + lspDiagnostics 命令位）的配置。`doctor` 有独立的 `gateArming` 与 `adapters` 分项：门未武装、已启用 adapter 但本机没装 hooks、规则文件里残留指向不存在路径的命令，都会在体检报告里摆到台面上。

`governance audit` 是 LuWu 的只读巡检：检查目录级 `AGENTS.md`、README 中英文命令对等、Prompt Pack 登记、命名和真实代码注释，报告写入 `.helix/reports/governance/`。只看当前改动可加 `--changed-only`，它只触发变更文件及相关祖先规则/成对文档/架构台账；Git 变更不可读取时会安全回退为全量扫描。LuWu 不会自动移动、重命名或删除项目文件，运行时也会拒绝 LuWu、DiJiang、BaiZe 进入 command worker。

每次 worker 执行前，WildArrange 会在 Git 项目里自动记录一份工作区快照（`git stash create`），快照 hash 与恢复命令写入任务证据和 ledger，代码被改坏时可用 `git stash apply <hash>` 还原。

WildArrange 会在 shell 执行前阻断明显破坏性命令，例如删除 `.git/.helix`、递归删除 `src/test/doc` 等项目核心目录、`git reset --hard`、`git clean -fd`、`sudo` 或 `curl | sh`。正常项目命令、verifier、review command 和子 Agent runner 不受影响。

用户验收后可以显式关闭保留结果：

```bash
node ./bin/helix.mjs parallel close --run <runId> --task T001 --reason user_accepted
```

也可以显式要求 worktree。子 Agent 在独立 worktree 写文件，WildArrange 自动提取 patch；合入时同样先过 `writable_paths` 和完整 gate：

```bash
node ./bin/helix.mjs parallel run --task T001 --isolation git-worktree --command "..."
node ./bin/helix.mjs parallel admit --run <runId> --task T001
```

## ArchivistRouter

ArchivistRouter 是“档案员 + 任务路由”节点。它只读取清洗后的结论包，不摄入代码块、raw diff 或完整命令输出。

手动运行：

```bash
node ./bin/helix.mjs archivist packet --text "做一个网页版 TODO 工具" --stage plan
node ./bin/helix.mjs archivist run --text "做一个网页版 TODO 工具" --stage plan --force
```

当 `archivistRouter.enabled` 为 `true` 时，`SessionStart`、`UserPromptSubmit`、`PostCompact` hook 会自动触发 ArchivistRouter。没有 DeepSeek key 时会走 deterministic fallback，不阻断主流程。

路由采用双层策略：确定性关键词路由永远保留证据；如果配置了 `CangJie` provider，`routeGovernance.semanticShadow` 会给出语义第二意见。低置信或冲突的 `execute` 请求会降级为 `plan` / `ask`，避免模糊需求直接开工。

ArchivistRouter 的关键词学习不会直接改路由。建议先进入 `.helix/routing/suggestions/`，审核后才写入 `.helix/routing/routes-overrides.json`：

```bash
node ./bin/helix.mjs archivist suggestions list
node ./bin/helix.mjs archivist suggestions resolve --id <id> --decision accept --evidence "..." --rationale "..."
```

跨会话记忆会写入 `.helix/memory/digests/`。任务完成、并行 admission 完成、`SessionStart` 和 `PostCompact` 会生成结构化 digest，用于恢复进展、决策、成果物、实现结论和踩坑记录。

## Skill 匹配与任务绑定

Skill matcher 是路由之外的轻量解释层，用来判断当前阶段应加载哪些 skill：

```bash
node ./bin/helix.mjs skills match --text "做一个网页版提醒事项 App" --stage design --agent Jiuwei
```

阶段只作为匹配上下文，不对应另一套阶段前缀 Skill。计划、执行与验证分别由长期 Agent、当前专项 Skill 和确定性 delivery pipeline 承担。

注入点的 Skill 挂载默认按需生效（`skillMatcher.dynamicInjection`）：有请求文本时，只有与本次请求匹配的已配置 skill 才注入全文，其余降级为"按需可加载"引用；`alwaysMount`（默认 `wildarrange-injection-runtime`）始终注入，`maxSkills`（默认 4）限制单次任务绑定数量。没有请求文本的注入点（如 `pre_tool_use`）回落到静态清单。动态 matcher 只在注入点与 Agent 的显式集合内做减法；`task.skills` 是受安全加载与数量预算约束的额外显式来源。

路由写进任务总账的 `task.skills` 会由 PreToolUse Hook、`context build --point before_execute` 和生成的 `/helix-run` 在执行前真实挂载。M1 的 `before_review` / `before_checkpoint` 仍使用各自静态 Skill，不宣称自动消费任务绑定。任务绑定只认 Prompt Pack manifest 或 `.agents/skills/<name>/SKILL.md`，并校验安装根、realpath 与 SHA-256，继续受数量/字符预算约束；未知或完整性失败的 Skill 会显示在 `skillSelection.missing`，不会静默加载。

### 人工决策通道与安全开关

- **通用推送（不绑任何外部 IM）**：所有"待人决策"的事项——计划待确认、改动越界的 ChangeRequest、失败任务、子 Agent 待验收——由 hook 在 SessionStart / UserPromptSubmit / PostCompact / Stop 时注入宿主 AI 上下文，要求 AI 主动向开发者复述并给出选项。`attentionReport` 是这份待办的真相源，`status` / dashboard 也能拉取。
- **计划确认门**：`planApproval.required=true` 时，`plan --from` 导入的计划进入 `awaiting_plan_approval`，`run` 拒绝执行直到开发者 `plan approve`（或对话里用 `/helix-approve`）。默认关闭。
- **命令安全外置**：内置高危命令正则是不可关闭的底线；`commandSafety.extraPatterns` 允许在其之上追加项目专属危险命令拦截（`{ id, pattern, flags, reason }`），无需改代码。

## Dashboard

本地启动：

```bash
node ./bin/helix.mjs serve --host 127.0.0.1 --port 8765
```

路由复盘数据可直接查看；如需在页面点击“正确/规则错/个案错”写入标注，请用 `--token` 启动，因为所有 Dashboard POST 写操作都要求 token。

绑定非 loopback 地址时必须带 token：

```bash
node ./bin/helix.mjs serve --host 0.0.0.0 --port 8765 --token "$HELIX_DASHBOARD_TOKEN"
```

API 请求需携带以下之一：

```text
Authorization: Bearer <token>
```

或：

```text
x-helix-token: <token>
```

本地 dashboard 的 `GET /api/state` 可在 loopback 下免 token 查看；所有 `POST` 写操作即使绑定 `127.0.0.1` 也必须带 token，并会校验 Host / Origin，避免网页静默触发本机 worker 命令。

## 运行时文件

| 路径 | 作用 |
|---|---|
| `.helix/team/tasks.json` | 全项目唯一工单总账：所有 Plan 的 Task、类型、关联、状态与精简历史 |
| `.helix/ledger.jsonl` | 带 hash 链的追加式事件账本，可用 `node ./bin/helix.mjs ledger verify` 检查篡改 |
| `.helix/security/config-baseline.json` | config hash 基线，可用 `node ./bin/helix.mjs config verify` 检查质量门是否被改弱 |
| `.helix/backups/` | `state backup` 生成的运行态关键文件备份 |
| `.helix/checkpoints/` | 已完成任务的 checkpoint |
| `.helix/reports/` | workflow / review / failure 报告 |
| `.helix/reports/acceptance/` | checkpoint 前的验收证明链 |
| `.helix/snapshots/context.md` | 跨会话恢复上下文 |
| `.helix/adapters/` | adapter 配置、报告与备份 |
| `.helix/agent-runs/` | 子 Agent 运行包、结果与 admission 记录 |
| `.helix/memory/` | ArchivistRouter 结构化记忆 |
| `.helix/memory/digests/` | 跨会话恢复 digest |
| `.helix/routing/suggestions/` | 待审核的路由关键词建议 |

## 配置

`helix.config.json` 配置 Agent、模型 provider、动态类别、上下文预算与注入点。

每个长期 Agent 还可用 `skills` 固定绑定项目 Skill。把自定义 Skill 放到 `.agents/skills/<name>/SKILL.md`，再写入对应 Agent；它会在该 Agent 的注入点始终可用，其他 Agent 不会继承。外部 Agent CLI 可以封装在 Skill 中，Helix 只负责安全加载调用说明，不把具体 CLI 写死进 core：

```json
{
  "agents": {
    "Jiuwei": {
      "provider": "host",
      "model": "host-default",
      "skills": ["baize-cli"]
    }
  }
}
```

绑定名只允许字母、数字、`_`、`-`；缺失 Skill 会在注入报告中显式告警，目录穿越或指向项目 Skill 根目录之外的软链接不会加载。

`contextBudgets` 区分 Prompt、Markdown 与 Skill：Prompt / Markdown 默认保持短预算，已激活 Skill 默认可加载到 80,000 字符；超过预算时注入结果会显式标记 `truncated: true`，不会静默裁断。

`"provider": "host"` 的 Agent 交给宿主工具处理：Codex 侧由 Codex 选模型，Cursor 侧走 adapter 默认模型，**不需要** WildArrange 自备 OpenAI API key。

外部 provider 使用 OpenAI 兼容 HTTP 配置，详见 `helix.config.example.json`。环境变量模板见 `.env.wildarrange.example`：

```bash
# 复制后填入真实值，勿提交密钥
source .env.wildarrange
```

`apiKeyEnv` / `baseUrlEnv` 是**环境变量名**，不是密钥本身。`defaultBaseUrl` 在对应 env 未设置时作为回退地址。

确定性 gate 不依赖模型 API。当 `review.llm.required` 为 `false` 时，缺少外部 key 或 host provider 只会告警，不会阻断线性状态机。

LSP / 类型检查、AST 结构检查、hashline anchor 与注释检查走 CLI review gate，而非编辑器专属 hook：

```json
{
  "qualityGates": {
    "lspDiagnostics": {
      "enabled": true,
      "commands": ["npm run typecheck"]
    },
    "astStructure": {
      "enabled": true,
      "commands": ["ast-grep --pattern 'console.log($A)' --lang ts --json src || true"]
    },
    "hashlineAnchors": {
      "enabled": true,
      "anchors": [
        { "file": "src/app.ts", "line": 12, "sha256": "<hashLine>" }
      ]
    },
    "commentChecker": {
      "enabled": true,
      "blockOnFindings": false
    }
  }
}
```

## 商业边界

WildArrange 是受 Agent 治理模式启发的原创运行时，**不得**分发受限第三方项目的源码、prompt 原文或近似改写。

商业发布前请确认：

- 未包含受限第三方源码或 prompt 文本
- `packs/` 中为 WildArrange 自著 prompt 与 tool 合同
- 外部工作流参考仅保留为文档或概念对照

## 开发

```bash
npm test
npm pack --dry-run --cache /private/tmp/helix-npm-cache
```

当前状态：线性治理闭环已实现并通过测试；checkpoint 前会生成验收证明链，显式 `successCriteria` 只有绑定具体 verifier 命令或人工证据后才会通过。Codex adapter 已能写入项目 `.codex/hooks.json`，通过 `/hooks` trust 后具备 hard hook 拦截；Cursor adapter 已能写入项目 `.cursor/hooks.json`，受信任工作区中 `preToolUse` 与 `beforeShellExecution` 硬拦截且 fail-closed。跨会话 digest 与 ArchivistRouter 会进入 hook 注入块；ledger 具备 hash 链校验；多 Agent 已具备命令型并行、Codex/Cursor 命令模板 spawn、结构化文件 admission、Git worktree patch admission、验收前保留与 admission 后释放。

## 更多文档

| 文档 | 说明 |
|---|---|
| [README.en.md](./README.en.md) | 英文版说明 |
| [CLAUDE.md](./CLAUDE.md) | Agent / 开发者治理规范 |
| [doc/concept.md](./doc/concept.md) | 产品概念与外部参考边界 |
| [doc/project-architecture.md](./doc/project-architecture.md) | 运行时架构与 gate 模型 |
| [doc/five-zone-decoupling-guidelines.md](./doc/five-zone-decoupling-guidelines.md) | 可复用的五区受控解耦与目录级 AGENTS.md 准则 |
| [doc/development-plan.md](./doc/development-plan.md) | P0 / P1 / P2 路线 |
