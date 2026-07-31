# WildArrange

简体中文 | [English](./README.en.md)

WildArrange 是面向 Codex、Cursor 与 Kimi Code 的本地 Agent 治理运行时。第一版刻意保持精简：先跑通**可恢复、可验证的单线闭环**，再考虑多 Agent 并行。

## 它能做什么

WildArrange 把一次编码请求变成带门禁的工作流：

```text
init -> plan -> execute -> verify -> scope -> review -> checkpoint -> resume
```

核心规则：**worker 可以声称完成，但只有 gate 才能判定完成。**

核心运行时是宿主中立的。Codex / Cursor / Kimi adapter 负责注入与恢复增强，但仅凭 CLI 也能跑完整流程。

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

npm 和 Git 负责同步程序与项目配置，不负责同步正在运行的任务。`.helix/` 包含任务状态、ledger、checkpoint、备份和 Agent 运行记录，默认写入 `.gitignore`：

- 不要让两台设备同时写同一份 `.helix/`。
- 换设备只安装程序时，按上面的 `npm ci → init → adapter install → doctor` 流程操作。
- 需要把未完成任务迁移到另一台设备时，应先停止原设备写入并迁移完整、相互一致的运行态；不要只复制 `tasks.json` 或单个 checkpoint。
- 迁移前可执行 `npx wildarrange state backup --reason before-device-migration`，迁移后执行 `npx wildarrange state verify` 和 `npx wildarrange doctor`。

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
      "verify_commands": ["node -e \"const fs=require('fs'); if(fs.readFileSync('.helix/artifacts/smoke.txt','utf8').trim()!=='ok') process.exit(1)\""]
    }
  ]
}
```

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
- **Cursor**：项目规则写入 `.cursor/rules/wildarrange.mdc`。当前 Cursor 侧是 soft governance，不等同于 Codex PreToolUse 硬拦截。
- **Kimi Code**：生成项目专属 plugin 到 `.helix/adapters/kimi/plugin/`，复用项目根 `AGENTS.md` 和 `.agents/skills/`。WildArrange 不会静默改写用户级 `~/.kimi-code/config.toml`；从项目根启动 Kimi Code，显式执行 `/plugins install .helix/adapters/kimi/plugin`，再执行 `/reload`。不要给路径加引号，Kimi Code 0.27 会把引号当成路径字符。plugin 是用户级安装，但 bridge 会在非 WildArrange 项目中静默退出。

`adapter install` 还会生成一组快捷命令，省去手动开终端敲 `node ...`。三端从同一套命令集渲染（`helix-config` / `helix-doctor` / `helix-refresh` / `helix-status` / `helix-plan` / `helix-approve` / `helix-run`）：

- **Cursor**：`.cursor/commands/<name>.md`（纯 Markdown 斜杠命令，聊天输入 `/helix-doctor` 触发）。
- **Codex / Kimi Code**：共享 `.agents/skills/<name>/SKILL.md` 项目 Skill；Codex 可通过 `/skills` 或 `$helix-doctor` 触发，Kimi Code 按其项目 Skill 机制发现和调用。

每个命令本质是一段提示词，指示 AI 去执行对应的 `helix.mjs` 子命令并汇报结果——是"让 AI 代你敲 CLI"的快捷方式，不是原生按钮。

Kimi Hook 在正常运行时可拦截越界 Write/Edit 和明显高危 Bash，但 Kimi 的 Hook 执行器在 Hook 崩溃或超时时会 fail-open（失败放行）。因此它不能替代 WildArrange 的 verifier、scope、review、successCriteria、acceptance proof 与 checkpoint 最终质量门。

## 多 Agent 最小闭环

命令型子 Agent 可以先在隔离目录内并发运行；也可以通过 adapter 命令模板交给 Codex/Cursor 类宿主启动：

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
node ./bin/helix.mjs state verify
node ./bin/helix.mjs state list
node ./bin/helix.mjs state restore --backup <backupId>
node ./bin/helix.mjs doctor
node ./bin/helix.mjs governance audit
```

`doctor` 是一键体检：校验 config 结构与挂载、对账已完成任务（checkpoint / acceptance proof / ledger 事件必须齐全）、验证 ledger hash 链，并与最近一次备份交叉比对以发现整链重写。`state restore` 恢复前会自动再做一次备份，恢复错了可以再退回。

`governance audit` 是 LuWu 的只读巡检：检查目录级 `AGENTS.md`、README 中英文命令对等、Prompt Pack 登记、命名和真实代码注释，报告写入 `.helix/reports/governance/`。只看当前改动可加 `--changed-only`，它只触发变更文件及相关祖先规则/成对文档/架构台账；Git 变更不可读取时会安全回退为全量扫描。LuWu 不会自动移动、重命名或删除项目文件，运行时也会拒绝 LuWu、DiJiang、BaiZe 进入 command worker。

每次 worker 执行前，WildArrange 会在 Git 项目里自动记录一份工作区快照（`git stash create`），快照 hash 与恢复命令写入任务证据和 ledger，代码被改坏时可用 `git stash apply <hash>` 还原。

WildArrange 会在 shell 执行前阻断明显破坏性命令，例如删除 `.git/.helix`、递归删除 `src/test/doc` 等项目核心目录、`git reset --hard`、`git clean -fd`、`sudo` 或 `curl | sh`。正常项目命令、verifier、review command 和子 Agent runner 不受影响。

用户验收后可以显式关闭保留结果：

```bash
node ./bin/helix.mjs parallel close --run <runId> --task T001 --reason user_accepted
```

Git 项目可以使用 worktree 隔离。子 Agent 在独立 worktree 写文件，WildArrange 自动提取 patch；合入时同样先过 `writable_paths` 和完整 gate：

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

## Skill 与提示词变体

Skill matcher 是路由之外的轻量解释层，用来判断当前阶段应加载哪些 skill：

```bash
node ./bin/helix.mjs skills match --text "做一个网页版提醒事项 App" --stage design --agent Jiuwei
```

注入点的 Skill 挂载默认按需生效（`skillMatcher.dynamicInjection`）：有请求文本时，只有与本次请求匹配的已配置 skill 才注入全文，其余降级为"按需可加载"引用；`alwaysMount`（默认 `wildarrange-injection-runtime`）始终注入，`maxSkills`（默认 4）限制单次挂载数量。没有请求文本的注入点（如 `pre_tool_use`）回落到静态清单。动态匹配只做减法，不会把清单之外的 skill 全文塞进上下文。

### 人工决策通道与安全开关

- **通用推送（不绑任何外部 IM）**：所有"待人决策"的事项——计划待确认、改动越界的 ChangeRequest、失败任务、子 Agent 待验收——由 hook 在 SessionStart / UserPromptSubmit / PostCompact / Stop 时注入宿主 AI 上下文，要求 AI 主动向开发者复述并给出选项。`attentionReport` 是这份待办的真相源，`status` / dashboard 也能拉取。
- **计划确认门**：`planApproval.required=true` 时，`plan --from` 导入的计划进入 `awaiting_plan_approval`，`run` 拒绝执行直到开发者 `plan approve`（或对话里用 `/helix-approve`）。默认关闭。
- **命令安全外置**：内置高危命令正则是不可关闭的底线；`commandSafety.extraPatterns` 允许在其之上追加项目专属危险命令拦截（`{ id, pattern, flags, reason }`），无需改代码。

提示词变体不替代 Agent 原始提示词，只追加模型偏置。GPT 系列和 Codex/Cursor 主模型默认走 `host` / `gpt` 配置，外部模型可按 provider 选择：

```bash
node ./bin/helix.mjs prompts variant --agent Jiuwei --model gpt-5.5
node ./bin/helix.mjs prompts show --agent Jiuwei --variant gemini
```

## Dashboard

本地启动：

```bash
node ./bin/helix.mjs serve --host 127.0.0.1 --port 8765
```

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
| `.helix/team/tasks.json` | 任务状态 |
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

当前状态：线性治理闭环已实现并通过测试；checkpoint 前会生成验收证明链，显式 `successCriteria` 只有绑定具体 verifier 命令或人工证据后才会通过。Codex adapter 已能写入项目 `.codex/hooks.json`，通过 `/hooks` trust 后具备 hard hook 拦截；Cursor 仍是 soft 规则注入。跨会话 digest 与 ArchivistRouter 会进入 hook 注入块；ledger 具备 hash 链校验；多 Agent 已具备命令型并行、Codex/Cursor 命令模板 spawn、结构化文件 admission、Git worktree patch admission、验收前保留与 admission 后释放。

## 更多文档

| 文档 | 说明 |
|---|---|
| [README.en.md](./README.en.md) | 英文版说明 |
| [CLAUDE.md](./CLAUDE.md) | Agent / 开发者治理规范 |
| [doc/concept.md](./doc/concept.md) | 产品概念与外部参考边界 |
| [doc/project-architecture.md](./doc/project-architecture.md) | 运行时架构与 gate 模型 |
| [doc/five-zone-decoupling-guidelines.md](./doc/five-zone-decoupling-guidelines.md) | 可复用的五区受控解耦与目录级 AGENTS.md 准则 |
| [doc/development-plan.md](./doc/development-plan.md) | P0 / P1 / P2 路线 |
