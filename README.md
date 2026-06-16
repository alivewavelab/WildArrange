# WildArrange

简体中文 | [English](./README.en.md)

WildArrange 是面向 Codex 与 Cursor 的本地 Agent 治理运行时。第一版刻意保持精简：先跑通**可恢复、可验证的单线闭环**，再考虑多 Agent 并行。

## 它能做什么

WildArrange 把一次编码请求变成带门禁的工作流：

```text
init -> plan -> execute -> verify -> scope -> review -> checkpoint -> resume
```

核心规则：**worker 可以声称完成，但只有 gate 才能判定完成。**

核心运行时是宿主中立的。Codex / Cursor adapter 负责注入与恢复增强，但仅凭 CLI 也能跑完整流程。

## 安装

从 npm 包使用：

```bash
npx @alivewavelab/wildarrange@latest init
npx @alivewavelab/wildarrange@latest adapter install
```

长期使用的项目建议安装为 devDependency，避免 hook 每次走网络：

```bash
npm i -D @alivewavelab/wildarrange
npx wildarrange adapter install --mode local
```

本地开发（本仓库）：

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

## 多 Agent 最小闭环

命令型子 Agent 可以先在隔离目录内并发运行；也可以通过 adapter 命令模板交给 Codex/Cursor 类宿主启动：

```bash
node ./bin/helix.mjs parallel run --max-agents 2 --task T001,T002 --agent Kui --command "..."
node ./bin/helix.mjs parallel run --task T001 --agent Kui --adapter codex
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
```

WildArrange 会在 shell 执行前阻断明显破坏性命令，例如删除 `.git/.helix`、`git reset --hard`、`git clean -fd`、`sudo` 或 `curl | sh`。正常项目命令、verifier、review command 和子 Agent runner 不受影响。

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
node ./bin/helix.mjs skills match --text "做一个网页版提醒事项 App" --stage design --agent YingLong
```

提示词变体不替代 Agent 原始提示词，只追加模型偏置。GPT 系列和 Codex/Cursor 主模型默认走 `host` / `gpt` 配置，外部模型可按 provider 选择：

```bash
node ./bin/helix.mjs prompts variant --agent YingLong --model gpt-5.5
node ./bin/helix.mjs prompts show --agent YingLong --variant gemini
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
| [doc/development-plan.md](./doc/development-plan.md) | P0 / P1 / P2 路线 |
