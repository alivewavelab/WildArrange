# WildArrange

简体中文 | [English](./README.en.md)

WildArrange 是面向 Codex、Cursor、Kimi Code 与 Claude Code 的本地 Agent 治理运行时。第一版刻意保持精简：先跑通**可恢复、可验证的单线闭环**，再考虑多 Agent 并行。

## 它能做什么

WildArrange 把一次编码请求变成带门禁的工作流：

```text
setup -> plan -> execute -> verify -> scope -> review -> acceptance-proof -> checkpoint -> resume
```

核心规则：**worker 可以声称完成，但只有 gate 才能判定完成。**

核心运行时是宿主中立的。Codex / Cursor / Kimi adapter 负责注入与恢复增强，但仅凭 CLI 也能跑完整流程。

设计原则只有五条：**计划与执行分离 → worker 不自证完成 → 独立验证 → 失败返工 → 证据入账**。所有运行时状态都写在项目之外的本机运行态目录（`wildarrange project show` 输出的 `runtimeRoot`；下文用 `runtime:<路径>` 表示其中的文件），客户项目零写入，不绑定任何特定编辑器。内部实现与不变量见 [doc/project-architecture.md](./doc/project-architecture.md)。

**小白从这里开始：** 按下文「[安装、跨设备与升级](#安装跨设备与升级)」接入项目，再照「[最小工作流](#最小工作流)」跑通第一个任务。完整命令清单见 `node ./bin/wildarrange.mjs --help --all` 或 [doc/generated/commands.md](./doc/generated/commands.md)。

## Agent 职责

WildArrange 只保留 5 个长期 Agent。确定性 Router 是系统节点，不占 Agent 名额；专项能力用 Skill 按需挂载。Agent 提供分析和执行能力，最终完成状态仍由确定性 gate 决定。

| Agent | 负责什么 |
|---|---|
| **Jiuwei（九尾狐）** | 主编排者兼线性执行官；组织计划、派发 worker，串联验证、复核、checkpoint、恢复和 ChangeRequest。 |
| **DiJiang（帝江）** | 把目标整理成可执行计划、任务依赖、范围、验收标准与验证命令。 |
| **ZhuRong（祝融）** | 在 `writable_paths` 内实现代码或文件改动，提交 DoneClaim 和证据。 |
| **BaiZe（白泽）** | 唯一独立复核者；验证目标、证据、风险和验收，不接受 worker 自证。 |
| **LuWu（陆吾）** | 只读维护仓库秩序；检查分层 `AGENTS.md`、README 同步、命名、文件归属及代码注释规则。 |

系统 Router 负责判断请求属于咨询、计划、执行、验证或恢复，并选择主 Agent 与 Skill。

专项职责改为 Skill：`review-product-intent` 检查产品目标，`map-user-journey` 补齐用户旅程，`design-acceptance` 设计可验证验收，`review-ux-interaction` 复核交互状态，`review-scope-tradeoff` 控制范围，`research-domain-benchmark` 做最小必要对标；`inspect-codebase` 与 `research-external-docs` 分别承接代码检索和外部研究。

角色 Prompt 位于 `packs/wildarrange-linear/agents/`，Skill 位于 `packs/wildarrange-linear/skills/`；Prompt、Tool 和 Skill 均在开发时静态登记并随版本发布，不在任务运行期间临时注册。

## 安装、跨设备与升级

### 环境要求

- Node.js 20 或更高版本。
- npm 公共包无需登录即可安装；只有发布者执行 `npm publish` 时需要登录。
- 使用 Git worktree 隔离时，项目还需要安装 Git。

### 接入项目：`wildarrange setup`（唯一运行形态）

WildArrange 只有一种运行形态，三根模式：客户项目仓库保存产品代码与产品测试，独立治理仓库保存政策、`policy/wildarrange.config.json`（唯一配置）和验证注册表，本机状态目录保存 ledger、锁、报告、备份与 Prompt Pack。WildArrange 不会向客户项目生成 `AGENTS.md`、运行态文件或 Adapter 文件。

最快路径：在客户项目根一步完成治理仓初始化、连接、运行态初始化与宿主 Adapter 包生成：

```bash
npx wildarrange setup \
  --governance-root ../my-project-governance \
  --repository https://github.com/example/my-project.git \
  --target all
```

`--repository` 省略时取项目 `origin` 远端；`--target` 可选 `codex|cursor|kimi|claude|all`（默认 all）。命令结束会列出剩余的宿主内手工步骤（Codex/Kimi 安装与信任、Cursor 与 Claude Code 激活）。想分步执行时使用下面的命令：

```bash
npx wildarrange project init-governance \
  --governance-root ../my-project-governance \
  --repository https://github.com/example/my-project.git \
  --default-branch main
```

该命令只在治理目录创建缺失的 `wildarrange-governance.json`、`policy/AGENTS.md`、`policy/code-and-interface-conventions.md`、`policy/testing-and-acceptance.md`（三份政策模板）、`policy/wildarrange.config.json`（默认武装质量门）、`verification/registry.json` 和空职责目录，不覆盖已有文件；治理目录不是 Git 仓库时会自动 `git init` 并提交初始 commit（已是 Git 仓库则跳过），从不 push。`policy/` 里仍含 `[待确认]` 的政策不会注入给 Agent，`doctor` 会告警。人工补齐政策并提交治理仓库后，回到客户项目连接：

```bash
npx wildarrange project attach --governance-root ../my-project-governance
npx wildarrange init
npx wildarrange project show
```

连接后 `state verify`、`state backup` 和 `state restore` 都操作外置运行态。

计划导入时，治理仓库 `verification/registry.json` 的 `planDefaults.verify_commands`、`standards_commands` 和 `review_commands` 只会叠加，项目计划不能删减；registry 摘要与项目/治理 revision 会写入唯一 task ledger。若治理仓库是 Git 仓库且存在未提交改动，计划导入会拒绝，防止功能 Agent 偷改门槛后立即自证。

外置模式的零项目文件 Adapter 会生成到 `runtimeRoot/adapters/external`，不会写客户仓库：

```bash
npx wildarrange adapter install --target all --mode local
npx wildarrange adapter activate --target all   # Cursor Hook + 用户级指针规则 + Claude Code 插件；也可 --target cursor / codex / claude
npx wildarrange doctor
```

`adapter activate` 是显式的用户级写入，普通命令不会触发：`--target cursor` 备份并合并用户级 `~/.cursor/hooks.json`（只替换 WildArrange 自己的条目），并写入 `~/.cursor/rules/wildarrange.mdc`（alwaysApply 的一句话指针：本机项目若已连接 WildArrange，先运行 `wildarrange status`）；`--target codex` 在 `~/.codex/AGENTS.md` 追加带 `<!-- wildarrange:begin/end -->` 标记的同样指针段。`--target claude` 经本机 `claude` CLI 校验运行态里的本地 marketplace，并以用户级（`--scope user`）安装 `wildarrange-governance@wildarrange-local`，重复执行只刷新；传 `--user-root` 时设置 `CLAUDE_CONFIG_DIR=<user-root>/.claude`，不碰真实 `~/.claude`；`--target all` 时本机没有 `claude` 命令会跳过 Claude Code，不影响其它宿主。写前都会备份，重复执行幂等，客户项目里不写任何文件。`adapter uninstall` 会移除这些用户级条目、指针并删除 runtime 中的插件包；`adapter restore --backup <backupId>` 把用户级文件恢复到该次 activate 之前。`doctor` 会比对安装时记录的 Hook 配置 digest，插件 `hooks.json` 或用户 Cursor 条目被改动/删除时报 `external_adapter_config_modified`。Codex 与 Kimi 仍要求按 `adapter install` 返回的 `nextActions` 在各自插件界面显式安装、审查和信任。文件已生成或用户配置已写入都不等于激活；只有与当前 `activationId` 匹配的真实生命周期回执出现后，`doctor` 才报告 `execution_observed`。回执只证明插件曾经运行过：`doctor` 还会只读核对插件此刻是否仍安装并启用（Claude Code 查 `claude plugin list`，Codex 查 `codex plugin list`，Kimi 读 `~/.kimi-code/plugins/installed.json`，Cursor 由用户级 hooks.json digest 覆盖），在 WildArrange 之外被卸载或禁用时报 `external_adapter_removed`；无法查询时只告警。Bridge 先只读本机 registry 判断工作目录（含项目子目录与任务 worktree）是否属于已连接项目：未连接项目、或 WildArrange 自身安装损坏时一律放行，不会阻断无关项目；已连接项目上子进程失败才按宿主策略处理（Cursor 写操作 fail-closed，Codex/Kimi fail-open），子进程有超时保险。Kimi 的 Stop 会把未完成任务拉回续跑。

每张计划任务可声明 `"repositoryTarget": "project"`（默认）或 `"governance"`。一个任务只能写一个仓库；治理任务从治理仓库自己的 branch/worktree 走线性 `wildarrange run` 交付，跨仓依赖必须拆成两张任务。当前并行 admission 仍只拥有项目仓库，遇到治理任务会明确拒绝，不会回落写客户仓库。两个交付都完成后，用完整 SHA 写不修改任一仓库的集成验收收据：

```bash
npx wildarrange integration accept \
  --project-sha <40-char-project-sha> \
  --governance-sha <40-char-governance-sha> \
  --reason "release candidate"
```

任务 acceptance proof 会绑定计划导入时的双仓基线与本任务交付 SHA；`integration accept` 还会从指定治理 commit 重新校验 verification registry 摘要。

### 临时体验

只想快速试用时，可直接运行（治理仓库放在项目之外的任意目录）：

```bash
npx @alivewavelab/wildarrange@latest setup --governance-root ../my-project-governance
npx @alivewavelab/wildarrange@latest doctor
```

这种方式每次通过 `npx` 解析版本，适合体验，不适合作为团队项目的固定依赖。

### 固定版本安装

长期使用时，把 WildArrange 固定为项目的 `devDependency`：

```bash
npm install --save-dev @alivewavelab/wildarrange@latest
npx wildarrange setup --governance-root ../my-project-governance --mode local
npx wildarrange doctor
```

把 `package.json` 和 `package-lock.json` 提交到项目仓库。这样团队成员与 CI 使用 `npm ci` 时会安装同一版本，不会因 `latest` 更新而悄悄改变行为。`--mode local` 让 Hook 与 Skill 调用当前安装的 CLI 路径，`--mode npx` 改用 `npx -y <package>` 前缀。

`setup` / `adapter install` 生成的是外置插件包，不写客户仓库，也不证明宿主已经加载；运行态与生成物都在每台设备自己的本地状态目录，因此每台设备都应重新执行一次，而不是复制另一台设备的结果。Codex 桌面版还必须在设置 > Hooks 中审查、信任并启用当前 Hook；Codex CLI 使用 `/hooks`。至少产生一次生命周期 Hook 回执后，`doctor` 应显示 `codex:configured/execution observed`。显示 `ACTIVATION UNVERIFIED` 时不得把治理说成已生效。

### 治理政策模板

`setup` 与 `project init-governance` 会在治理仓 `policy/` 下补建缺失的政策模板（`AGENTS.md`、代码与接口规范、测试与验收规则），已有文件一律保留，不合并也不覆盖；WildArrange 不会向客户项目写入任何文档。生成后的 `[待确认]` 必须由人类确认或删除，尤其是测试策略、标准命令、生产/测试入口和模块边界。

WildArrange 的 `runtime:team/tasks.json` 是唯一工单总账，Dashboard 只是入口和视图，不要再同步维护第二份 Markdown 任务表或 ClickUp 真源。

### 在另一台设备安装

先克隆客户项目与治理仓库，然后在项目根目录运行：

```bash
git clone <project-repository>
git clone <governance-repository>
cd <project-directory>
npm ci
npx wildarrange project attach --governance-root ../<governance-directory>
npx wildarrange init
npx wildarrange adapter install --target all --mode local
npx wildarrange doctor
```

对于 Kimi Code，还需在每台设备显式执行 `adapter install` 输出的 `nextActions`：

```text
/plugins install <runtimeRoot>/adapters/external/kimi/...   # 以 adapter install 返回的路径为准
/reload
```

对于 Claude Code，在每台设备执行一次 `npx wildarrange adapter activate --target claude`，再新开一次 Claude Code 会话。

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

Kimi Code 的 plugin 是用户级安装。升级后为确保 Hook bridge 使用新生成内容，在 Kimi Code 中先 `/plugins remove` 旧 plugin，再按 `adapter install` 返回的路径重新 `/plugins install` 并 `/reload`。Claude Code 直接读取运行态里的插件文件，升级后新开会话或运行 `/reload-plugins` 即可。

### 运行状态与 Git 交付

npm 和 Git 负责同步程序、项目与治理仓；运行态目录位于每台设备自己的本地状态目录，不直接互相覆盖。WildArrange 不做多设备或多用户的远端协调：多人协作时每人各用自己的分支，唯一约束是**两个可写任务不能在同一分支上开发**。

一个可写任务对应一个隔离 worktree 和一个 task branch（`wildarrange/task/<planId>/<taskId>`）；开始执行前必须绑定干净 commit 基线，除本任务结果外不能夹带其他脏改动。目标分支已被另一个可写任务或 worktree 占用时，任务会被拒绝启动并说明占用者。全部质量门与 acceptance proof 通过后，WildArrange 才生成只含本任务路径的 delivery commit：有 remote 时普通非强制 push 到该任务独占的远端 task branch；无 remote 但仍是 Git 仓库时，commit 保留在本地 task branch/worktree。两种路径都会让 checkpoint 与 acceptance proof 绑定同一 commit SHA，并把共享 checkout 恢复干净。task branch push 不会移动 `main`，一个任务通常持续更新一个 Draft PR，只有人类在托管平台批准并执行 merge 后才进入共享主线。若 task branch push 已成功、仅本地 checkpoint/审计写入失败，则保留同一 run 的 claim 和交付意图，禁止回滚已知 push，只允许同 run 对账恢复或进入 `recovery_required`。

进程被强制终止后，若 `parallel status` 显示 run 没有结果但任务仍被占用，可在人工确认进程已经结束后执行：

```bash
npx wildarrange parallel close --run <runId> --reason "confirmed process terminated"
```

该命令会按 `runId` 扫描任务状态并释放空结果的幽灵 `parallel_run_claim`，不依赖 `results` 列表。

### Git 交付配置

默认配置位于治理仓 `policy/wildarrange.config.json`（示例见仓库根 `wildarrange.config.example.json`，可复制为治理配置）：

```json
{
  "gitDelivery": {
    "remote": "origin",
    "integrationBranch": "auto",
    "taskBranchPrefix": "wildarrange/task",
    "requireWorktreeForParallelWrites": true
  }
}
```

`remote` 用于 task branch 的普通 push；`integrationBranch` 用于清理 worktree 前判断 delivery commit 是否已并入主线；`taskBranchPrefix` 限定自动 push 只能写入该前缀下的任务分支；`requireWorktreeForParallelWrites` 让可写并行 Agent 使用独立 worktree。无论如何配置，单任务独占分支、禁止 force push、task branch 基线变化后重验、不得自动 merge/push 业务代码到 `main` 这些底线都不可关闭。

### 本仓库开发

维护 WildArrange 源码本身时使用：

```bash
node ./bin/wildarrange.mjs setup --governance-root ../wildarrange-governance --repository <git-url>
```

本仓库自己的治理配置保存在其治理仓库，不在仓库根目录。

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
      "owner": "ZhuRong",
      "writable_paths": ["artifacts/smoke.txt"],
      "responsibilityChanges": [{ "script": "artifacts/smoke.txt", "additions": "新增冒烟产物", "responsibilityBefore": "不存在", "responsibilityAfter": "记录一次可验证的冒烟结果", "facts": [] }],
      "worker_command": "node -e \"const fs=require('fs'); fs.mkdirSync('artifacts',{recursive:true}); fs.writeFileSync('artifacts/smoke.txt','ok\\n')\"",
      "verify_commands": ["node -e \"const fs=require('fs'); if(fs.readFileSync('artifacts/smoke.txt','utf8').trim()!=='ok') process.exit(1)\""],
      "review_commands": ["node -e \"const fs=require('fs'); if(!fs.readFileSync('artifacts/smoke.txt','utf8').includes('ok')) process.exit(1)\""]
    }
  ]
}
```

> 验收证明要求本轮实际取得独立复核结果：成功执行的非空转 `review_commands` / `standards_commands`、有检查对象的质量门，或成功的 LLM review。只配置通道、跳过执行、无 key fallback、`echo` 或 `node --version` 都不能作为完成依据。

计划导入会保护已有成果：同一 Plan 中仍在执行、验证、恢复、持有任务 claim 或已经完成的任务不能被重新导入覆盖。已完成旧 Plan 后可以导入新的 Plan，旧任务及其交付记录继续保留。

运行（每个导入的计划都要人工确认；开工检查要求先用 `/wildarrange-setup` 配好 Worker 握手 `executionReadiness.workerProbe` 与职责审查者 `review.responsibility.command`，可直接使用内置执行者，`doctor` 会给出推荐命令）：

```bash
node ./bin/wildarrange.mjs plan --from plan.json
node ./bin/wildarrange.mjs plan approve
node ./bin/wildarrange.mjs run
node ./bin/wildarrange.mjs status
node ./bin/wildarrange.mjs summary
```

在已安装 adapter 的 Codex / Cursor / Kimi Code / Claude Code 中，直接描述一个需要开发的需求或 Bug 即可。`UserPromptSubmit` 路由判断需要计划时，会要求当前宿主大模型根据对话语义把计划草稿写到 Hook 给出的绝对路径 `runtime:plan-drafts/<session>-plan.json`（不写进项目），而不是让用户手写格式。生成文件必须带 `generated_by: "host_semantic"`，并为每张可执行任务明确填写 `task.owner`；owner 只能是具备 command-worker 资格的 Jiuwei 或 ZhuRong。每张任务还必须提供真实、非空转的 `worker_command`，由 WildArrange 在隔离任务 worktree 中执行并产出 `writable_paths` 内的改动；`node --version`、`process.exit(0)` 等占位命令不能导入。DiJiang、BaiZe、LuWu 分别通过计划、复核和治理阶段参与，不执行 `worker_command`。WildArrange 导入时校验 owner 与 Worker 合同，并等待用户 `plan approve`。执行 Hook、任务领取和并行运行随后读取同一个 `task.owner`，不会再另建一套实际负责人。

计划待确认期间，用户仍可修改 `runtime:plan-drafts/*.json` 并重新导入；其它文件写入和任意 Shell 默认阻断，只放行精确匹配的计划管理与只读命令。批准后，草稿目录重新受当前工单的 `writable_paths` 限制。

手工编写或外部生成的 `plan.json` 仍可直接使用 `plan --from` 导入，同样需要职责声明并等待确认。缺省 owner 会回落到 Jiuwei；但新计划应始终显式填写 owner。

### 工单总账

新功能、独立 Bug、已完成任务的验收纠错和维护工作都使用同一个 Task 模型，并落盘到 `runtime:team/tasks.json`。Plan 只负责分组；跨 Plan 引用使用 `<planId>:<taskId>`。验证命令或职责声明还没准备好时可以先建 `draft` 留底，draft 不能执行；`task ready` 转为可执行时必须补齐 `responsibilityChanges`，随后计划回到待确认。建单时自动生成的默认验收标准未改动过时，会自动绑定 `task ready` 补齐的 verify 命令：

```bash
node ./bin/wildarrange.mjs task create --title "修复登录失败" --type bug --priority P0
node ./bin/wildarrange.mjs task list --all --type bug
node ./bin/wildarrange.mjs task ready --task T001 --from task-details.json
```

同一次 Task 内 verifier 失败只增加 attempt 和历史证据；已经完成后又被验收打回，创建 `acceptance_correction` Task，并用 `--parent <planId>:<taskId>` 关联原任务。Dashboard 的“工单总账”页显示全部 Plan，支持按类型、状态、Plan 和关键词筛选，并可展开状态历史。

## 计划字段与导入校验

计划是整条流水线的入口。一个任务（task）的常用字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 否 | 任务 ID，不填自动生成 `T001`… |
| `subject` | **是** | 任务标题（`title` 也可） |
| `description` | 否 | 任务详述 |
| `owner` | host_semantic 计划必填 | 只能是 Jiuwei 或 ZhuRong；手工计划缺省回落到 Jiuwei |
| `writable_paths` | 强烈建议 | 允许改动的路径白名单（支持 glob），范围守卫据此判定越界 |
| `worker_command` | 否 | 真正产出改动的命令 |
| `verify_commands` | **是** | 至少一条，全部 exit 0 才算通过 |
| `review_commands` / `standards_commands` | 否 | 独立复核 / 规范检查命令；导入可不写，但没有任何独立复核信号则无法 completed |
| `successCriteria` | 否 | 验收标准；不填时按 verifier 生成默认三条（主路径 / 边界 / 回归） |
| `blockedBy` | 否 | 依赖的前置任务 ID，构成 DAG（不要写 `dependsOn`，会被忽略） |
| `maxAttempts` | 否 | 最大自动重试次数，默认 3 |
| `skills` | 否 | 本任务建议激活的 Skill |
| `repositoryTarget` | 否 | `project`（默认）或 `governance` |

顶层还可写 `defaults`（对所有任务叠加的默认 `verify_commands` / `review_commands` / `standards_commands` / `writable_paths` 等）。`responsibilityChanges` 见文末「职责与事实审计」。

导入时逐层校验：`title` 必填；每个任务有 `subject` 与至少一条 `verify_commands`；`successCriteria` 结构合法且 `verifierCommandRefs` 指向真实存在的验证命令；任务 ID 不重复、`blockedBy` 引用存在且无环；命中产品类关键词且路由判为高风险的计划必须至少 4 个任务并包含验证/复核类任务。每张可执行任务都必须带 `responsibilityChanges`；只读任务（`writable_paths` 为空）用空数组 `[]` 明确声明不改文件。没有 `writable_paths`、`worker_command` 为空且 `verify_commands` 只是 `true` / `process.exit(0)` 的空转任务会被标记 `possible_noop_task`，并在开工检查与验收阶段被硬拦。

计划确认门：每个导入的计划都进入 `awaiting_plan_approval`；计划确认后再新增或改动职责声明（`task create` / `task ready`、review blocker 整改单、`steer` 加单或改声明）也会让计划回到待确认。此时 `run` 会拒绝执行，直到 `plan approve`（或对话里用 `/wildarrange-approve`，AI 会先复述计划再请你确认）。另一个 `run` 正在执行时，新的 `run` 会立即返回 `busy` 并给出正在运行的进程号，不会排队等待。

### 范围越界被挡住后重试

越界任务会生成 ChangeRequest。先审再清理越界路径，最后单步重试：

```bash
node ./bin/wildarrange.mjs changes list
node ./bin/wildarrange.mjs changes review --id CR-xxxx
node ./bin/wildarrange.mjs changes resolve --id CR-xxxx --decision accept --evidence "同意扩大范围" --rationale "..."
# 清理仍越界的路径后
node ./bin/wildarrange.mjs node retry --task T001
```

未 accept 时返回 `change_request_required`；已 accept 但越界路径仍未清理时返回 `scope_cleanup_required`。单步节点只有 `node route|execute|checkpoint|retry`：verify / scope / review 只随完整 pipeline 运行，`run` 与 `node checkpoint` 在 checkpoint 前会自动跑验收证明。

## 完成门与追溯

一个任务要 `completed`，必须过完下列门，缺一不可。执行顺序：worker（在 pipeline 之外）→ `verify → scope → review`（即使前面失败也全部跑完以留证据）→ 一并判定 worker / successCriteria / 三门 → 验收证明 →（Git 项目先生成 delivery commit，有 remote 时普通 push）→ checkpoint。

| 门 | 谁把关 | 判定 |
|---|---|---|
| worker 退出码 | 系统 | `worker_command` 必须 exit 0，但这只是“声称完成” |
| 独立验证 | 系统 verifier | `verify_commands` 存在且全部 exit 0 |
| 范围守卫 | 系统 | 改动路径全部落在 `writable_paths` 内（realpath 防穿越）；越界会生成 ChangeRequest 等人审 |
| 复核门 | BaiZe + 按需 Review Skill / 质量门 | 主 lane PASS，安全无 high/critical；`review_commands`、`standards_commands`、注释检查与可选 LLM review 共同判定 |
| 验收标准 | 系统 | `successCriteria` 通过；必须来自独立证据，不能照抄 verifier |
| 验收证明 | 系统 | 逐项核验以上证据链，并拒绝 no-op、trivial verify（`verify_not_trivial`）与同义反复 review（`review_not_tautological`） |

`inconclusive`（拿不到 Git 改动信息、证据缺失）不算通过。任一门失败，任务回到 `pending` 或标记 `failed` 并写失败报告。门与 pipeline 的完整定义见 [doc/project-architecture.md](./doc/project-architecture.md) 的「Gate 模型」。

改坏了怎么救，靠这几层证据：

- **hash 链账本 `runtime:ledger.jsonl`**：每步追加事件，改一行、断链或插入未哈希行都会被 `ledger verify` 报出；`doctor` 只把通过校验的事件当作完成证据。
- **执行前工作区快照**：见下文「防御性校验」。
- **恢复快照 `runtime:snapshots/context.md`**：记录进度，供续跑恢复。
- **备份与一键恢复**：`state backup` / `state restore`，恢复前会自动再备份一次。
- **一致性体检 `doctor`**：核对完成任务的 checkpoint / 验收证明 / 账本事件是否齐全，校验 hash 链，并与最近备份交叉比对。

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
node ./bin/wildarrange.mjs adapter install --target all --mode local
node ./bin/wildarrange.mjs adapter uninstall --target all
node ./bin/wildarrange.mjs adapter restore --backup <backupId>
```

安装、卸载、恢复都会在运行态 `adapters/external/` 写入报告；`adapter activate` 覆盖用户级文件前会备份。`restore` 用于把 `adapters/backups/<backupId>/` 里的备份恢复回用户级原位置。四个宿主都只通过项目外的插件包接入，客户项目里不写任何文件：

- **Codex**：本地 marketplace/plugin 生成在 `adapters/external/codex-marketplace/`；Codex 桌面版需在设置 > Hooks 中审查、信任并启用；Codex CLI 使用 `/hooks`。完成后才会执行这些 hard hook。
- **Cursor**：`adapter activate --target cursor` 备份并合并用户级 `~/.cursor/hooks.json`；bridge 在受信任工作区中对 `preToolUse`（Write/Delete/Edit/Shell）与 `beforeShellExecution` 硬拦截且 fail-closed，未连接项目静默放行。
- **Kimi Code**：生成用户 plugin 到运行态 `adapters/external/kimi/`。WildArrange 不会静默改写用户级 `~/.kimi-code/config.toml`；按 `adapter install` 返回的 `nextActions` 显式执行 `/plugins install <路径>`，再执行 `/reload`。不要给路径加引号，Kimi Code 0.27 会把引号当成路径字符。plugin 是用户级安装，但 bridge 会在未连接项目中静默退出。
- **Claude Code**：本地 marketplace 与插件生成在 `adapters/external/claude-marketplace/`；`adapter activate --target claude` 经 `claude plugin marketplace add` / `claude plugin install` 以用户级安装，`adapter uninstall --target claude` 经 `claude plugin uninstall` / `marketplace remove` 移除。插件 Hook 拦截 `Bash|Write|Edit|MultiEdit|NotebookEdit`；Claude Code 的 `PostCompact` 不能注入上下文，压缩后由 `SessionStart`（`source: compact`）恢复治理上下文。Claude Code 云端会话不加载本机插件，不受此治理。

Codex 新会话的 `SessionStart` 会自动注入完整 Jiuwei 身份 Prompt；上下文压缩后的 `PostCompact` 会再注入一次用于恢复身份。普通 `UserPromptSubmit` 不重复注入，避免每轮对话浪费上下文。Prompt 来自已安装且经过 hash 校验的 Prompt Pack，并受 `contextBudgets.prompt.maxChars` 限制；截断会明确显示。

`adapter install` 还会在插件包内生成一组快捷命令 Skill，省去手动开终端敲 `node ...`。其中 `/wildarrange-plan` 在未提供路径时会根据当前对话生成计划草稿，提供路径时仍导入已有文件。三端从同一套命令集渲染（`wildarrange-config` / `wildarrange-doctor` / `wildarrange-refresh` / `wildarrange-status` / `wildarrange-plan` / `wildarrange-approve` / `wildarrange-run`，另有 `-setup` / `-onboard` / `-architecture`），随各宿主插件加载，不在客户项目里生成文件。

每个命令本质是一段提示词，指示 AI 去执行对应的 `wildarrange.mjs` 子命令并汇报结果——是"让 AI 代你敲 CLI"的快捷方式，不是原生按钮。命令一览：

| 命令 | 作用 |
|---|---|
| `/wildarrange-setup` / `-onboard` / `-architecture` | 读取对应 Skill 后引导项目配置、旧项目接管、架构设计审查 |
| `/wildarrange-config` | 生成治理仓 `policy/wildarrange.config.json` 并逐块引导填写，最后 `config verify` 校验 |
| `/wildarrange-doctor` | 一键体检：`doctor` + `config verify` + `ledger verify` + `state verify` |
| `/wildarrange-refresh` | 新增/改了 Prompt、Skill 或注入点后刷新运行时（幂等，不清任务与账本） |
| `/wildarrange-status` | 看进度、下一步、失败任务与待办 |
| `/wildarrange-plan` | 导入并校验 `plan.json`；未给路径时按当前对话生成计划草稿 |
| `/wildarrange-approve` | 展示计划摘要并请你确认，确认后才放行执行 |
| `/wildarrange-run` | 跑下一个任务，走完整门禁 |

Kimi 与 Claude Code 的 Hook 在正常运行时可拦截越界写入和明显高危 Bash，但两者的 Hook 执行器在 Hook 崩溃或超时时都会 fail-open（失败放行）。因此它不能替代 WildArrange 的 verifier、scope、review、successCriteria、acceptance proof 与 checkpoint 最终质量门。

### Hook 注入时机

装了 adapter 后，宿主会在关键时机自动调用 `hook run`，运行时按事件挑选注入点，把该挂的规则、Skill 与状态拼成上下文返回给模型——这是被动注入，无需手动触发。

| 宿主事件 | 注入点 | 做了什么 |
|---|---|---|
| `SessionStart` | `session_start` | 恢复上次进度、扫规则、构建 Agent 上下文并注入 Jiuwei 身份 Prompt |
| `UserPromptSubmit` | `user_prompt_submit` | 对请求做路由决策并补规则；需要计划时下发计划草稿指令 |
| `PreToolUse` | `pre_tool_use` | 工具执行前做范围预检，计划外写入返回 `permissionDecision=deny` |
| `PostToolUse` | `post_tool_use` | 工具执行后按目标文件刷新规则，做工具结果门与范围检查 |
| `PostCompact` | `post_compact` | 上下文压缩后恢复工作状态、规则与身份 |
| `Stop` | `stop` | 会话停止前生成续跑指令，下次自动接上 |

配置里还有编排注入点（`before_execute` / `before_review` / `before_checkpoint` / `repository_governance`），完整列表见 `config show` 的 `injectionPoints`。注入内容分级设字符预算（Prompt 默认 12,000、Markdown 默认 12,000、Skill 默认 80,000），超预算必须显式标 `truncated`，不允许静默截断。

## 多 Agent 最小闭环

命令型子 Agent 可以并发运行；只要项目是具有基线 commit 的 Git 仓库，可写 Agent 就自动使用独立 Git worktree；remote 只决定 delivery commit 是否自动 push。`gitDelivery.requireWorktreeForParallelWrites` 设为 `false` 时沿用 `parallelAgents.isolation`：

```bash
node ./bin/wildarrange.mjs parallel run --max-agents 2 --task T001,T002 --agent ZhuRong --command "..."
node ./bin/wildarrange.mjs parallel run --task T001 --agent ZhuRong --adapter codex
node ./bin/wildarrange.mjs parallel list
node ./bin/wildarrange.mjs parallel status --run <runId>
node ./bin/wildarrange.mjs parallel cleanup --run <runId>
```

`parallel cleanup` 会保留等待验收、返工、恢复中或仍有未提交改动的 worktree。只有任务身份与生命周期可核实、worktree 干净且当前 HEAD 已进入 `main` 时才允许清理；不会强制删除验收后的新增文件。

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
node ./bin/wildarrange.mjs parallel admit --run <runId> --task T001
```

成功的子 Agent 结果不会立即关闭，而是保留为 `awaiting_user_acceptance`。只有 `parallel admit` 跑完整 gate 并完成 checkpoint 后，才会标记为 `released`。

## 防御性校验

```bash
node ./bin/wildarrange.mjs config baseline --reason reviewed
node ./bin/wildarrange.mjs config verify
node ./bin/wildarrange.mjs state backup --reason before-risky-agent
node ./bin/wildarrange.mjs state verify
node ./bin/wildarrange.mjs state list
node ./bin/wildarrange.mjs state restore --backup <backupId>
node ./bin/wildarrange.mjs task archive --task T001 --plan <planId> --delete --reason "obsolete"
node ./bin/wildarrange.mjs doctor
node ./bin/wildarrange.mjs governance audit
node ./bin/wildarrange.mjs impact "src/infra/ledger.mjs"
node ./bin/wildarrange.mjs decisions --limit 20
node ./bin/wildarrange.mjs decisions stats
node ./bin/wildarrange.mjs timeline --limit 30
node ./bin/wildarrange.mjs annotate --decision <decisionId> --category rule_wrong --reason "..."
node ./bin/wildarrange.mjs annotate stats
node ./bin/wildarrange.mjs test --zone infra
node ./bin/wildarrange.mjs docs commands --write
```

`doctor` 是一键体检：校验 config 结构与挂载、对账所有 Plan 的已完成任务（checkpoint / acceptance proof / ledger 事件必须以 `planId:taskId` 对齐）、验证 ledger hash 链，并与最近一次备份交叉比对以发现整链重写；`decisionHealth` 分项给出周期健康摘要（各门触发计数、从未触发的门、坏行与孤儿标注预警）。各项检查各自隔离，单项崩溃只标红对应分项；doctor 只读诊断，不写 ledger。`state restore` 恢复前会自动再做一次备份。

`task archive ... --delete` 需要显式删除确认，并且会先做运行态备份；`in_progress` / `verifying` 任务不可归档。Plan/Task ID 必须是安全单段标识符，canonical `planId:id` 身份必须唯一，显式 `--plan` 必须精确命中，不能回退到其它 Plan；删除采用可回滚事务并最后提交权威任务总账，仅清理目标 Task、空 Plan、对应 checkpoint / acceptance report、该任务的 outbox DoneClaim，以及未被其它任务共用的 `runtime:artifacts/` 精确非 glob 产物。本次精确删除集会写入对应 backup 的 recovery package；进程中断或需要撤销时可执行 `state restore --backup <backupId>` 恢复 Plan、证明、DoneClaim 与 artifact。清空活动 Plan 后系统进入 `idle`，不会自动激活其它 Plan。历史 ledger 与 backups 不随归档删除。

`impact` 是改动影响分析：列出一个文件被哪些文件直接或间接 import，以及应该跑哪些测试（含常驻的五区边界测试），让 AI 改一处后能机器化证明「没碰别的模块」。

`decisions` 是决策投影：delivery-pipeline 五门、PreToolUse/PostToolUse 拦截、admission、routing 四个缝的每一次拦截/通过都会追加到 `runtime:decisions.jsonl`（可丢可截断的派生日志，不进 hash 链），`decisions` 命令把每条记录渲染成三行——发生了什么、命中哪条规则、证据在哪，方便人和异步审查 Agent 逐条复盘。支持 `--task` / `--gate` / `--annotatable`（只看可标注队列）过滤与 `--format json`。读侧从文件尾部流式倒读，`--limit` 约束真实内存占用；长期运行后可直接 `truncate -s 0 .wildarrange/decisions.jsonl` 清空（请截到 0 而不是半行；即使截到半行，写入侧也会自动补换行，读侧跳过坏行）。

`test` 是分区测试选择：`--zone <区>` 跑「引用了该区文件的测试 + 命名对位测试 + 常驻边界测试」，带文件参数时按 impact 的应跑清单跑，不带参数跑全量；退出码透传 `node --test`。改了哪就跑哪，不必背测试矩阵。

`annotate` 是标注回写：决策可用 `annotate --decision <id> --category confirmed|rule_wrong|case_wrong|mislabeled` 标为确认正确、规则错、个案错或误标。理由可选；`annotate stats` 按「规则 × 标注」聚合，单条标注不绑架整条规则。**标注永远不能自动改门**——标注路径不写 config、不改 `verify_commands`、不动任何门开关（有测试钉死），调门只能由人显式改配置。

`decisions stats` 是确定性统计审查（纯代码、可重跑、无 LLM）：每个门的触发计数（按决策/规则细分）、**从未触发的门**（门形同虚设的直接信号）、以及标注与规则的关联。冷启动期只出计数不出率。`timeline` 把 ledger（仅 hash 链校验通过的条目）、decisions、annotations 合并成一条倒序时间线，回答「这个仓库最近发生了什么」，支持 `--task` / `--source` 过滤。

CLI 是分层的：`--help` 默认只显示核心六命令（setup / plan / run / status / decisions / doctor），覆盖日常主循环；全部命令见 `--help --all`。命令清单的单一事实源是 `src/interface/cli-help.mjs` 的注册表，`docs commands --write` 把它物化成 `doc/generated/commands.md`；README 命令真实性检查对照的是 `--help --all` 全量输出。

老项目验证治理接管是独立维护流程，不进入 `task.status`，也不复用 `approvePlan`：

```text
node ./bin/wildarrange.mjs adoption start
node ./bin/wildarrange.mjs adoption status
node ./bin/wildarrange.mjs adoption resume
node ./bin/wildarrange.mjs adoption recover
```

`adoption start` 只读扫描测试、Gate、Runner、Hook 和历史档案，打开 Dashboard 逐卡批准；未传 `--token` 时会自动生成本次专用随机口令并注入当前标签页。只执行获批项；带验证命令、归档、合并或关键配置的卡片必须逐张批准。Registry 等待用户自行 commit A，随后生成 Bootstrap 与可直接用浏览器打开的 Inventory HTML，再等待 commit B。Inventory 同时内嵌机器可读记录，展示当前真源、历史档案、暂缓确认和本次变更；V1 不执行物理删除，因此删除墓碑只保留为未来兼容视图。三个目标名称若已被老项目文件、目录或链接占用，流程会暂停并指出冲突，绝不静默覆盖。获批 archive 默认移入项目可提交的 `docs/verification-archive/`（没有 `docs/` 时用 `verification-archive/`），不会放进 `runtime:`。一旦已有卡片改变项目文件，就不能用“取消会话”冒充恢复；应完成两次 Git 锚定，或在 `recovery_required` 时运行 `adoption recover`。`doctor` / `status` 的 `registryFreshness` 过期只亮黄灯，不阻断日常 run。没有 `approve` / `apply` / `delete` CLI。

外置接管扫描和验证仍使用业务仓库；locator 配置、Registry、Bootstrap、Inventory 写入治理仓库。Registry 使用治理合同的 `verificationRegistry` 路径，Bootstrap 和 Inventory 放在其同级目录；commit A/B 在治理仓库完成。若另有已批准的业务文件改动，它们须在业务仓库单独提交，系统分别核对两仓内容。初始化生成且摘要完整的空 Registry 可在 locator 获批后填充，原始内容保存在运行态 `adoption/artifact-preimages/`；非空、摘要异常或生成期间已变化的内容仍报冲突。

Dashboard（`serve`）包含全项目工单总账、路由复盘台、决策面板、运维面板与验证接管页。工单总账直接读取 `runtime:team/tasks.json`，展示全部 Plan、工单类型、优先级、关联任务与状态历史。路由复盘台按日期展示用户原文、结构化路由结果、命中信号及同会话后续工具摘要，并可人工标记正确/规则错/个案错；工具参数中的常见密钥字段会脱敏。复盘只写 annotation，不自动修改 `routes.json`。

`run` 结束时的门决策汇总按 `reporting.verbosity` 分级：默认 `verbose` 在 stderr 输出本次任务每个门的三行投影（框架初期让人能审判每一条门决策）；信任建立后可改为 `normal`（一行结果）或 `quiet`（只输出 JSON）。stdout 的机器可读 JSON 在任何级别下都不变。

并行运行中断后，`parallel status --run <runId>` 会显示 `batchStatus` 与 `incompleteTasks`（有头无尾的任务）；`parallel retry --run <runId>` 只重跑未通过的任务（复用原命令，可用 `--command` 覆盖），已通过/已完成/被其他 run 持有的任务跳过并说明，重试是新的 run，不改写原 run 证据。

`status` 输出顶部常驻 `gateArming` 黄灯：默认配置下质量门全关、review 门没有独立信号时会显示「门未武装」及修复指引，避免对着一条全绿但不证明任何东西的门流误判项目健康。验收证明（acceptance proof）有两条硬地板：拒绝 `verify_commands` 全是 trivial 命令（如 `true`）的任务；拒绝 review 门没有任何独立信号 lane（无 `review_commands` / `standards_commands` / `review.llm` / 已启用质量门）的任务——同义反复的复核不证明任何东西，不得进入 completed。`config init --armed` 可以直接生成一份武装了质量门（commentChecker 阻断）的配置。`doctor` 有独立的 `gateArming` 与 `adapters` 分项：门未武装、已启用 adapter 但本机没生成 hooks、Codex Hook 已生成却没有当前配置的真实执行回执、规则文件里残留指向不存在路径的命令，都会在体检报告里摆到台面上。Adapter 使用 `configured` 表示文件已生成；只有 Codex 显示 `execution_observed` 才表示当前 Hook 配置至少真实运行过一次。

`governance audit` 是 LuWu 的只读巡检：检查目录级 `AGENTS.md`、README 中英文命令对等、Prompt Pack 登记、命名和真实代码注释，报告写入 `runtime:reports/governance/`。只看当前改动可加 `--changed-only`，它只触发变更文件及相关祖先规则/成对文档/架构台账；Git 变更不可读取时会安全回退为全量扫描。LuWu 不会自动移动、重命名或删除项目文件，运行时也会拒绝 LuWu、DiJiang、BaiZe 进入 command worker。

接口与数据库契约治理首版自动对照 Tauri Rust command、handler 注册和前端 `invoke`；Rust 源码字符串中的 SQL 只标记为需要人工申报，不伪装成已扫描。扫描生成的差异必须由开发者显式批准或拒绝，LuWu 在既有 review 内检查当前任务触及的契约，不新增平行门禁：

```bash
node ./bin/wildarrange.mjs contracts scan
node ./bin/wildarrange.mjs contracts apply-card --card <id> --decision approve --reason "baseline confirmed" --expected-fingerprint <sha256>
node ./bin/wildarrange.mjs contracts generate
```

计划里已明确批准的契约内容不重复询问；临时新增接口/数据库字段会暂停任务，由主 Agent 解释必要性、影响、替代方案和建议，等待你的明确决定。批准绑定具体内容，改动内容后旧批准失效。

```bash
node ./bin/wildarrange.mjs contracts propose --task T001 --from proposal.json
node ./bin/wildarrange.mjs contracts resolve --id <id> --decision accept --expected-fingerprint <sha256> --reason "同意报告中的具体变更"
```

`proposal.json` 包含 `reason`、`impact`、`alternatives`、`recommendation` 和 `items`（与任务 `contractChanges.items` 相同结构；Tauri 接口需 `expected.signatures`）。Loop 内的命令 worker 输出 `WILDARRANGE_CONTRACT_CHANGE=<proposal JSON>` 单行并退出，由主 Agent 接办，不在 worker 子进程内再次调用 `propose`。拒绝使用 `--decision reject`，任务保持等待，不自动重试；新会话继续提示同一请求。完整声明与职责见 [运行时架构](doc/project-architecture.md)。正式台账仍由显式 `scan/apply-card` 更新并版本化，任务批准不会偷偷改写台账。

每次 worker 执行前，WildArrange 会在 Git 项目里自动记录一份工作区快照（`git stash create`），快照 hash 与恢复命令写入任务证据和 ledger，代码被改坏时可用 `git stash apply <hash>` 还原。

WildArrange 会在 shell 执行前阻断明显破坏性命令，例如删除 `.git`、递归删除 `src/test/doc` 等项目核心目录、`git reset --hard`、`git clean -fd`、`sudo` 或 `curl | sh`。正常项目命令、verifier、review command 和子 Agent runner 不受影响。

用户验收后可以显式关闭保留结果：

```bash
node ./bin/wildarrange.mjs parallel close --run <runId> --task T001 --reason user_accepted
```

也可以显式要求 worktree。子 Agent 在独立 worktree 写文件，WildArrange 自动提取 patch；合入时同样先过 `writable_paths` 和完整 gate：

```bash
node ./bin/wildarrange.mjs parallel run --task T001 --isolation git-worktree --command "..."
node ./bin/wildarrange.mjs parallel admit --run <runId> --task T001
```

## 路由

路由只使用确定性路由表（`routes.json`），结果保留命中信号作为证据。置信度低于 0.5 的 `execute` 请求会降级为 `plan`，避免模糊需求直接开工。

## Skill 匹配与任务绑定

Skill matcher 是路由之外的轻量解释层，用来判断当前阶段应加载哪些 skill：

```bash
node ./bin/wildarrange.mjs skills match --text "做一个网页版提醒事项 App" --stage design --agent Jiuwei
```

阶段只作为匹配上下文，不对应另一套阶段前缀 Skill。计划、执行与验证分别由长期 Agent、当前专项 Skill 和确定性 delivery pipeline 承担。

注入点的 Skill 挂载默认按需生效（`skillMatcher.dynamicInjection`）：有请求文本时，只有与本次请求匹配的已配置 skill 才注入全文，其余降级为"按需可加载"引用；`alwaysMount`（默认 `wildarrange-injection-runtime`）始终注入，`maxSkills`（默认 4）限制单次任务绑定数量。没有请求文本的注入点（如 `pre_tool_use`）回落到静态清单。动态 matcher 只在注入点与 Agent 的显式集合内做减法；`task.skills` 是受安全加载与数量预算约束的额外显式来源。

路由写进任务总账的 `task.skills` 会由 PreToolUse Hook、`context build --point before_execute` 和生成的 `/wildarrange-run` 在执行前真实挂载。M1 的 `before_review` / `before_checkpoint` 仍使用各自静态 Skill，不宣称自动消费任务绑定。任务绑定只认 Prompt Pack manifest 或 `.agents/skills/<name>/SKILL.md`，并校验安装根、realpath 与 SHA-256，继续受数量/字符预算约束；未知或完整性失败的 Skill 会显示在 `skillSelection.missing`，不会静默加载。

### 人工决策通道与安全开关

- **通用推送（不绑任何外部 IM）**：所有"待人决策"的事项——计划待确认、改动越界的 ChangeRequest、失败任务、子 Agent 待验收——由 hook 在 SessionStart / UserPromptSubmit / PostCompact / Stop 时注入宿主 AI 上下文，要求 AI 主动向开发者复述并给出选项。`attentionReport` 是这份待办的真相源，`status` / dashboard 也能拉取。
- **计划确认门**：每个导入的计划、以及确认后新增或改动的职责声明，都进入 `awaiting_plan_approval`。`run` 拒绝执行，直到开发者 `plan approve`（或对话里用 `/wildarrange-approve`）。
- **命令安全外置**：内置高危命令正则是不可关闭的底线；`commandSafety.extraPatterns` 允许在其之上追加项目专属危险命令拦截（`{ id, pattern, flags, reason }`），无需改代码。

## 自定义 Prompt、技能与规范

### Prompt 与 Skill

内置 Prompt 包在 `packs/wildarrange-linear/`：`manifest.json`（登记 agent / skill / tools / routes）、`agents/`（五个长期角色）、`skills/`、`tools/tool-contract.json`、`routes.json`。新增一个技能：在 `skills/` 放 Markdown 文件，并在 `manifest.json` 的 `skills` 里登记（如 `"my-skill": "skills/my-skill.md"`）。`init` 是幂等的，只补建缺失目录并重新登记 Prompt 包，不动任务与账本；几乎每个命令和每次 hook 也会自动重新登记，想显式触发用 `/wildarrange-refresh` 或 `node ./bin/wildarrange.mjs init`。已登记 Skill 改正文立即生效；运行时会记录每个 Prompt 文件的 hash 用于防篡改。整包替换用编程接口 `initRuntime(dir, { promptPackDir })` 指向复制改好的目录。

想让 Skill 在某个注入点被挂载，在治理仓 `policy/wildarrange.config.json` 的 `injectionPoints` 声明候选清单（上限）；按需挂载规则见下文「Skill 匹配与任务绑定」。

### 规范文档与规则扫描

编码规范、验收要求、目录约定等通过**规则扫描**进入流程，工作流与作业指导才放进 Prompt 包的 Skill。运行时自动扫描：`AGENTS.md`、`CLAUDE.md`、`CONTEXT.md`、`.github/copilot-instructions.md`，以及 `.claude/rules/`、`.cursor/rules/`、`.github/instructions/` 下的规则文件。`AGENTS.md` 这类全局文件始终命中；规则文件用 frontmatter `globs` 按路径按需生效，没写 `globs`（或声明 `alwaysApply`）则全局生效：

```markdown
---
description: 前端组件规范
globs: [src/frontend/**, apps/web/**]
---

前端改动必须遵守组件规范，并附浏览器验收截图。
```

匹配依据是本次任务要改动的文件路径（`writable_paths` + Git 实际改动路径），不是编辑器里打开的标签页；改后端不会注入前端规范。手动查看命中结果：

```bash
node ./bin/wildarrange.mjs rules collect --target src/app.js
```

命中的规范写入 `runtime:rules/context.md` 与 `context.json`，超预算会显式标记截断。`AGENTS.md`、`CLAUDE.md` 这类控制面文档默认只读，流程不会去改它们。不想从零写规范：复制 `examples/fullstack-starter/`（带注释的全局红线、前后端/数据库三份带 `globs` 的规则文件、可跑通的 `plan.example.json` 与逐块注释的配置讲解），照其 README 的自检清单先跑通一次。

## Dashboard

本地启动：

```bash
node ./bin/wildarrange.mjs serve --host 127.0.0.1 --port 8765
```

本机打开后可直接查看和操作，无需填写登录信息。服务会为当前进程创建一次性 HttpOnly 会话 cookie；Dashboard 写操作仍在后台经过 token、Host 与 Origin 校验。

绑定非 loopback 地址时必须带 token：

```bash
node ./bin/wildarrange.mjs serve --host 0.0.0.0 --port 8765 --token "$WILDARRANGE_DASHBOARD_TOKEN"
```

非本机 API 请求需携带以下之一：

```text
Authorization: Bearer <token>
```

或：

```text
x-wildarrange-token: <token>
```

本地 dashboard 的 `GET /api/state` 可在 loopback 下免 token 查看；所有 `POST` 写操作即使绑定 `127.0.0.1` 也必须带 token，并会校验 Host / Origin，避免网页静默触发本机 worker 命令。

## 运行时文件

| 路径 | 作用 |
|---|---|
| `runtime:team/tasks.json` | 全项目唯一工单总账：所有 Plan 的 Task、类型、关联、状态与精简历史 |
| `runtime:ledger.jsonl` | 带 hash 链的追加式事件账本，可用 `node ./bin/wildarrange.mjs ledger verify` 检查篡改 |
| `runtime:security/config-baseline.json` | config hash 基线，可用 `node ./bin/wildarrange.mjs config verify` 检查质量门是否被改弱 |
| `runtime:backups/` | `state backup` 生成的运行态关键文件备份 |
| `runtime:checkpoints/` | 已完成任务的 checkpoint |
| `runtime:reports/` | workflow / review / failure 报告 |
| `runtime:reports/acceptance/` | checkpoint 前的验收证明链 |
| `runtime:snapshots/context.md` | 跨会话恢复上下文 |
| `runtime:adapters/` | adapter 配置、报告与备份 |
| `runtime:agent-runs/` | 子 Agent 运行包、结果与 admission 记录 |

## 配置

治理仓 `policy/wildarrange.config.json` 配置 Agent、模型 provider、动态类别、上下文预算与注入点。

每个长期 Agent 还可用 `skills` 固定绑定项目 Skill。把自定义 Skill 放到 `.agents/skills/<name>/SKILL.md`，再写入对应 Agent；它会在该 Agent 的注入点始终可用，其他 Agent 不会继承。外部 Agent CLI 可以封装在 Skill 中，WildArrange 只负责安全加载调用说明，不把具体 CLI 写死进 core：

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

外部 provider 使用 OpenAI 兼容 HTTP 配置，最小示例见 `wildarrange.config.example.json`，未列出的键取 `src/infra/default-config.mjs` 的内置默认值。环境变量模板见 `.env.wildarrange.example`：

```bash
# 复制后填入真实值，勿提交密钥
source .env.wildarrange
```

`apiKeyEnv` / `baseUrlEnv` 是**环境变量名**，不是密钥本身。`defaultBaseUrl` 在对应 env 未设置时作为回退地址。

确定性 gate 不依赖模型 API。当 `review.llm.required` 为 `false` 时，缺少外部 key 或 host provider 只会告警，不会阻断线性状态机。

配置块速查：

| 配置块 | 作用 |
|---|---|
| `agents` | 每个长期 Agent 的 provider / model / reasoning，可用 `skills` 固定绑定项目 Skill |
| `modelProviders` | 模型 provider：`host` 交给宿主，外部走 OpenAI 兼容 HTTP |
| `injectionPoints` | 每个注入点挂哪些 `tools` / `markdown` / `skills` / `rules` |
| `contextBudgets` | Prompt / Markdown / Skill 的字符预算，超了显式标 `truncated` |
| `skillMatcher.dynamicInjection` | Skill 按需挂载：`enabled` / `maxSkills` / `alwaysMount` |
| `qualityGates` | 注释检查（`commentChecker`）；类型检查、lint 等写进 `standards_commands` |
| `review.llm` | 是否启用 LLM 复核；`required=false` 时无 key 只告警不阻断 |
| `commandSafety.extraPatterns` | 在内置高危命令正则之上追加项目专属拦截（见下） |

Agent 配置示例（5 个长期 Agent 全部使用 `provider: "host"` 最省事；`/wildarrange-config` 或 `config verify` 校验）：

```json
{
  "agents": {
    "Jiuwei": { "role": "workflow_orchestrator", "provider": "host", "model": "host-default", "reasoning": "high" },
    "BaiZe":  { "role": "independent_reviewer", "provider": "host", "model": "host-default", "reasoning": "xhigh" }
  }
}
```

`commandSafety.extraPatterns` 只能在内置底线之上追加规则，命中的 worker / verify / review 命令会被拦下（退出码 126）；`pattern` 是正则字符串，`flags` 默认 `i`，写错的正则会被安全跳过：

```json
{
  "commandSafety": {
    "extraPatterns": [
      { "id": "no_prod_deploy", "pattern": "deploy\\s+--env\\s+prod", "flags": "i", "reason": "生产部署必须走人工流程" }
    ]
  }
}
```

`config init` 生成可编辑的默认配置，`config show` 查看最终生效配置。

注释检查走 CLI review gate，而非编辑器专属 hook；类型检查、lint、结构检查等命令请写进任务或计划默认的 `standards_commands`：

```json
{
  "qualityGates": {
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
npm pack --dry-run --cache /private/tmp/wildarrange-npm-cache
```

当前状态：线性治理闭环已实现并通过测试；checkpoint 前会生成验收证明链，显式 `successCriteria` 只有绑定具体 verifier 命令或人工证据后才会通过。Codex 外置插件在设置 > Hooks 中审查、信任并启用后具备 hard hook 拦截，Codex CLI 则使用 `/hooks`；Cursor 用户级 Hook 经 `adapter activate` 合并后，受信任工作区中 `preToolUse` 与 `beforeShellExecution` 硬拦截且 fail-closed。所有生成物都在项目之外，客户项目零写入。ledger 具备 hash 链校验；多 Agent 已具备命令型并行、Codex/Cursor 命令模板 spawn、结构化文件 admission、Git worktree patch admission、验收前保留与 admission 后释放。

## 命令速查

完整清单以 `node ./bin/wildarrange.mjs --help --all` 为准（同源文档 [doc/generated/commands.md](./doc/generated/commands.md)）。常用场景：

| 场景 | 命令 |
|---|---|
| 一步接入外置治理 | `node ./bin/wildarrange.mjs setup --governance-root <路径>` |
| 生成 / 查看治理配置 | `node ./bin/wildarrange.mjs config init`（`--armed` 直接武装质量门）/ `config show` |
| 安装 adapter | `node ./bin/wildarrange.mjs adapter install --target all --mode local` |
| 导入 / 确认计划 | `node ./bin/wildarrange.mjs plan --from plan.json` / `plan approve` |
| 跑下一个任务 | `node ./bin/wildarrange.mjs run` |
| 单步节点 | `node ./bin/wildarrange.mjs node execute --task T001`（另有 `node checkpoint` / `node retry` / `node route`） |
| 连续推进已确认的计划 | `node ./bin/wildarrange.mjs workflow`（`--from <plan.json>` 只导入并停在待确认） |
| 看状态 / 总结 | `node ./bin/wildarrange.mjs status` / `summary` |
| 并行子 Agent | `node ./bin/wildarrange.mjs parallel run --max-agents 2 --command "..."` |
| 合入 / 重试 / 关闭 | `parallel admit --run <runId> --task <id>` / `parallel retry --run <runId>` / `parallel close --run <runId>` |
| 裁决变更申请 | `node ./bin/wildarrange.mjs changes resolve --id CR-xxxx --decision accept --evidence "..."` |
| 收集命中规范 / 匹配 Skill | `node ./bin/wildarrange.mjs rules collect --target <path>` / `skills match --text "..." --stage plan` |
| 决策 / 时间线 | `node ./bin/wildarrange.mjs decisions --limit 20` / `timeline` |
| 影响面 / 分区测试 | `node ./bin/wildarrange.mjs impact src/infra/ledger.mjs` / `test --zone infra` |
| 体检 / 校验 | `node ./bin/wildarrange.mjs doctor` / `ledger verify` / `state verify` |
| 启动 Dashboard | `node ./bin/wildarrange.mjs serve --host 127.0.0.1 --port 8765` |

## 更多文档

| 文档 | 说明 |
|---|---|
| [README.en.md](./README.en.md) | 英文版说明 |
| [doc/generated/commands.md](./doc/generated/commands.md) | 由命令注册表生成的完整命令清单 |
| [CLAUDE.md](./CLAUDE.md) | Agent / 开发者治理规范 |
| [doc/concept.md](./doc/concept.md) | 产品概念与外部参考边界 |
| [doc/project-architecture.md](./doc/project-architecture.md) | 运行时架构与 gate 模型 |
| [doc/five-zone-decoupling-guidelines.md](./doc/five-zone-decoupling-guidelines.md) | 可复用的五区受控解耦与目录级 AGENTS.md 准则 |
| [doc/development-plan.md](./doc/development-plan.md) | P0 / P1 / P2 路线 |

## 职责与事实审计

每张可执行任务（计划导入、`task ready`、review blocker 整改单、`steer` 加单）都必须带 `responsibilityChanges`。由计划 Agent 填写，人工确认；不是让用户编写技术设计。每项包含 `script`（精确目标脚本）、`additions`、`responsibilityBefore`、`responsibilityAfter`、`facts`。每项事实包含 `name`、`ownerBefore`、`ownerAfter`、`access`；无事实填空数组，新增/删除事实的不存在一侧填 `null`。任务摘要和 Dashboard 展示这些内容，恢复快照保留同一任务字段。

```json
{
  "responsibilityChanges": [{
    "script": "src/config-router.mjs",
    "additions": "按游戏版本选择配置",
    "responsibilityBefore": "按游戏选择配置",
    "responsibilityAfter": "按游戏和版本选择配置，仍只负责路由",
    "facts": [{
      "name": "gameId 与 buildId 的对应关系",
      "ownerBefore": "src/game-records.mjs",
      "ownerAfter": "src/game-records.mjs",
      "access": "通过 game-records.readGame() 查询，不新增存储"
    }]
  }]
}
```

Worker 之后的既有 Review 增加独立职责审计：R1 符合批准方案；R2 无独立职责混杂；R3 无重复维护事实；R4 不绕过统一读写入口；R5 无重复业务实现。审查完整目标脚本、事实负责脚本、项目源码和 Git 差异。文件长度本身不是退回理由。审查者逐条返回 PASS/RETURN；RETURN 必须带规则编号、文件行号、源码原文、原因和整改建议，运行时检查证据位置与原文匹配。模型判断仍需人类裁决争议，不能把机械证据检查宣传为语义正确性证明。

配置独立审查执行器有两种方式：
- `review.responsibility.command`：只读宿主审查命令；从环境变量 `WILDARRANGE_REVIEW_PACKET` 指向的 JSON 读取任务与源码，stdout 仅返回审计 JSON。必须配置真正独立的审查者，不可复用 worker 自证或输出固定 PASS。
- 未配置上述命令时，使用启用的 `review.llm` 和 BaiZe OpenAI-compatible provider。不会自动安装 CLI、申请 API key 或更改用户级配置。

审查协议：`{ "decision": "PASS|RETURN", "checks": [{ "rule": "R1", "decision": "PASS|RETURN", "reason": "..." }], "findings": [{ "rule": "R3", "file": "src/example.mjs", "line": 12, "evidence": "该行源码原文", "reason": "...", "requiredFix": "..." }] }`。checks 必须恰好覆盖 R1–R5；每条 RETURN 有对应 finding。缺少执行器、证据超预算、响应格式错误、审查期间代码变化都不能通过 Review。`review.responsibility.maxEvidenceChars` 默认 500000；超限明确阻止审计，不截断后放行。

职责变化通过现有 `steer` 的 `revise_acceptance` 提交 `responsibilityChanges`；原任务保持 pending，计划重新等待人工批准。批准指纹进入现有 ledger，不增加第二个事实台账。没有「跳过职责审计」的任务：缺少已批准声明的任务一律退回，任何入口都没有关闭此校验的开关。

计划确认后补进来的任务同样要声明并经人确认：`task create` 缺声明时只能停在 draft；`review-blockers record` 的 blocker JSON 必须带整改单的 `responsibilityChanges`，整改单完成后用 `review-blockers resolve --task <原任务> --evidence ... --rationale ...` 放回原任务；`steer` 加单或拆单必须带声明。人工接受的范围变更（ChangeRequest 扩大 `writable_paths`）不会自动生成声明，需用 `revise_acceptance` 补交覆盖新路径的声明并重新确认。只要职责声明发生变化，整链运行、分步执行、并行启动都不得抢跑。

## 项目接管与项目审查

安装 adapter 后，使用 /wildarrange-setup 配置必需的 Worker、Reviewer、调研能力和项目规范；使用 /wildarrange-onboard 盘点旧计划、事实维护者、测试与夹具，并通过正式计划迁移。Skill 正文也可用 prompts show --skill configure-project-review 或 project-onboarding 读取。目标项目使用已安装的 wildarrange 命令或 adapter 给出的绝对路径，不需要拥有工具源码。

配置保存在治理仓 policy/wildarrange.config.json 的 review.steps 与 executionReadiness；任务业务字段仍只描述本次工作。每个 Review 步骤声明 id、title、appliesTo、requirement、required、documents、skills 和可选 command，按数组顺序运行。必需步骤不通过就驳回，记录规则、文件行号、原文和整改要求；建议步骤只告警。原有 R1–R5 审计不能被项目步骤替代。

先用 `project show` 取 runtimeRoot，将配置补丁保存到 `<runtimeRoot>/plan-drafts/review-setup.json`，执行 `wildarrange review configure --from "<runtimeRoot>/plan-drafts/review-setup.json"` 预览，用户确认后再加 --apply。用 review checklist --task T001 查看清单，已批准后用 readiness --task T001 检查开工依赖。配置依赖缺失可先保存，但业务 Worker 不会启动，不消耗重试次数。

Worker 读取 WILDARRANGE_EXECUTION_CONTEXT 的完整任务 Skill；探测器读取 WILDARRANGE_READINESS_PACKET，Reviewer 读取 WILDARRANGE_REVIEW_PACKET。探测返回 ready、原 challenge、loadedSkills；Reviewer 按包内协议返回带 inputDigest 的 PASS/RETURN/INCONCLUSIVE 与准确源码证据。请连接真实服务，固定回显不是独立审核。握手通过不等于功能交付。

不需要自己写适配脚本：内置执行者 `wildarrange executor probe|review|work --cli codex|claude|kimi|cursor` 会把握手包、审查包或任务交给本机已登录的模型 CLI（Codex、Claude Code、Kimi Code、Cursor Agent；codex 不在 PATH 时自动使用 ChatGPT 桌面版自带的 CLI），并把回答整理成门禁要求的格式。`doctor` 发现握手或审查者未配置时，会按本机已装的 CLI 给出可直接复制的命令（Worker 优先选带操作系统沙盒的 codex，审查者优先选与 Worker 不同的 CLI；审查者与 Worker 用同一 CLI 时只告警）。配置示例：

```json
{
  "executionReadiness": { "workerProbe": "wildarrange executor probe --cli claude" },
  "review": { "responsibility": { "command": "wildarrange executor review --cli kimi", "checkIntervalMs": 900000 } }
}
```

任务的 `worker_command` 可写 `wildarrange executor work --cli claude`。握手与审查只读：codex 使用 `--sandbox read-only` 操作系统沙盒，claude 禁用 Shell 与写文件工具，kimi 使用内置只读 `plan` 档案（无 Shell、无写文件工具），cursor 使用 `--mode ask`。Worker 在任务 worktree 中改文件：codex 使用 `--sandbox workspace-write`，Shell 也只能写任务目录与系统临时目录；claude 只开放文件工具、不开放 Shell；kimi 的非交互 `-p` 模式本身自动批准全部工具（含 Shell），cursor 需 `--force` 才能非交互改文件（同样含 Shell），成果仍须通过全部门禁。命令型正式审查按 `review.responsibility.checkIntervalMs`（默认 15 分钟）更新审查输入文件旁的 `<packetPath>.status.json`；仍在运行就继续等待同一进程，结束即收取结果，不因检查间隔到期而终止。状态 `running` 仅表示尚未退出，不证明模型持续取得进展；`exited` 也不等于审查通过，结果仍须通过证据与结论校验。Ctrl+C / SIGTERM 显式取消时回收进程树，取消失败进入恢复状态。`review.responsibility.timeoutMs` 仍用于开工审查者握手及 HTTP 审查；旧配置里的该值不再限制命令型正式审查。状态文件用于查看当前进程，不提供宿主崩溃后的会话恢复。线性 `run` 的 Worker 超时由 `executionReadiness.workerTimeoutMs` 控制，默认 30 分钟（此前固定 120 秒，模型 Worker 不够用）。执行者启动的模型子会话不受 WildArrange 宿主 Hook 注入与续跑影响。

`review configure --from` 只接受运行态 `plan-drafts/` 下的草稿，请传绝对路径。正式配置保存到治理仓库 `<policyRoot>/wildarrange.config.json`；尚无正式配置时使用内置默认值。业务仓库不新增这些治理文件。

旧项目扫描用 adoption inventory，登记继续使用 adoption 的逐卡批准流程。Registry.fixtures 只保存夹具位置与消费者；旧计划来源保存在 task.request.evidenceRefs，事实读写仍属于唯一 owner。登记完成与实际迁移完成分别报告，历史“已完成”必须重新验证才成为当前完成。

架构设计环节：初始化项目文档后会返回下一步 Skill 提示；也可主动运行 `/wildarrange-architecture`，或说“审查旧架构图”。已有设计按职责、依赖、事实归属、流程、必要复杂度五项审查，无设计则按需求提出最小方案。通过后仍须人工确认具体版本，沿用一个权威文档。此环节由宿主执行 Skill，不会自动弹窗、修改旧设计或建立图与代码一致性门禁。

### 任务证据夹与长期文档审计

获准任务通过开工检查后、Worker 启动前，会自动建立 `runtime:task-packets/<planId>/<taskId>/`：`baseline.json` 冻结首次开工时的任务范围与批准投影，`README.md` 指向现有 readiness、review、failure、acceptance、checkpoint 报告，`research.md` 索引任务启动时已声明的来源。重试不会覆盖首次基线；列出的报告只有实际生成后才是证据。当前任务状态始终以 `runtime:team/tasks.json` 为准。研究成果仍须写入任务批准的 `writable_paths` 并在验收证据中引用；证据夹不扩大 Worker 权限。

Worker 上下文会提示文档边界。若实际改动项目根 Markdown，或 `doc/`、`docs/` 下的长期 Markdown/HTML 文档（不含 `plans/`、`reports/` 等任务历史目录），独立 Reviewer 额外执行当前事实审计：长期文档保留当前有效的功能、结构、用法与限制；任务时间线、原始日志和未落地方案归任务证据；同一当前事实只由权威来源维护，已验证同步的翻译可保留；旧方案明确标为历史。Reviewer 必须逐份引用改动文档的源码行；违规时给出行号、原因和整改，未通过不能 checkpoint。
