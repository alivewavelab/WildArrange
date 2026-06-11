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
npx wildarrange@latest init
npx wildarrange@latest adapter install
```

长期使用的项目建议安装为 devDependency，避免 hook 每次走网络：

```bash
npm i -D wildarrange
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
```

安装与卸载都会在 `.helix/adapters/` 写入报告；覆盖或删除前会备份已有 adapter 文件。

- **Cursor**：项目规则写入 `.cursor/rules/wildarrange.mdc`
- **Codex**：生命周期 hook 配置写入 `.helix/adapters/codex/hooks.json`（更深层的 Codex 插件安装仍属 adapter 工作，runtime 不假设已装好）

## 多 Agent 最小闭环

命令型子 Agent 可以先在隔离目录内并发运行：

```bash
node ./bin/helix.mjs parallel run --max-agents 2 --task T001,T002 --agent Kui --command "..."
node ./bin/helix.mjs parallel list
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

合入时不会直接信任子 Agent。`parallel admit` 会先检查 `writable_paths`，再跑 verifier、scope guard、review gate 和 checkpoint：

```bash
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

## 运行时文件

| 路径 | 作用 |
|---|---|
| `.helix/team/tasks.json` | 任务状态 |
| `.helix/ledger.jsonl` | 追加式事件账本 |
| `.helix/checkpoints/` | 已完成任务的 checkpoint |
| `.helix/reports/` | workflow / review / failure 报告 |
| `.helix/snapshots/context.md` | 跨会话恢复上下文 |
| `.helix/adapters/` | adapter 配置、报告与备份 |
| `.helix/agent-runs/` | 子 Agent 运行包、结果与 admission 记录 |
| `.helix/memory/` | ArchivistRouter 结构化记忆 |
| `.helix/routing/suggestions/` | 待审核的路由关键词建议 |

## 配置

`helix.config.json` 配置 Agent、模型 provider、动态类别与注入点。

`"provider": "host"` 的 Agent 交给宿主工具处理：Codex 侧由 Codex 选模型，Cursor 侧走 adapter 默认模型，**不需要** WildArrange 自备 OpenAI API key。

外部 provider 使用 OpenAI 兼容 HTTP 配置，详见 `helix.config.example.json`。环境变量模板见 `.env.wildarrange.example`：

```bash
# 复制后填入真实值，勿提交密钥
source .env.wildarrange
```

`apiKeyEnv` / `baseUrlEnv` 是**环境变量名**，不是密钥本身。`defaultBaseUrl` 在对应 env 未设置时作为回退地址。

确定性 gate 不依赖模型 API。当 `review.llm.required` 为 `false` 时，缺少外部 key 或 host provider 只会告警，不会阻断线性状态机。

LSP / 类型检查与注释检查走 CLI review gate，而非编辑器专属 hook：

```json
{
  "qualityGates": {
    "lspDiagnostics": {
      "enabled": true,
      "commands": ["npm run typecheck"]
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

当前状态：线性治理闭环已实现并通过测试；可选 LLM review、可配置 LSP/类型检查诊断与注释检查可通过 CLI review gate 启用。多 Agent 已具备命令型并行、结构化成果 admission 与消息板闭环；下一层是 Codex/Cursor 真实子 Agent 启动、Git worktree 隔离和后台进程管理。

## 更多文档

| 文档 | 说明 |
|---|---|
| [README.en.md](./README.en.md) | 英文版说明 |
| [CLAUDE.md](./CLAUDE.md) | Agent / 开发者治理规范 |
| [doc/concept.md](./doc/concept.md) | 产品概念与外部参考边界 |
| [doc/project-architecture.md](./doc/project-architecture.md) | 运行时架构与 gate 模型 |
| [doc/development-plan.md](./doc/development-plan.md) | P0 / P1 / P2 路线 |
