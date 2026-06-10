# oh-my-openagent 源码级 Workflow 拆解（全量克隆阅读版）

阅读对象：`/tmp/omoa`（v4.8.1 全量克隆，commit 321309a，2026-06-10 读取）。
本文件是 README.md（节点映射）的深化：回答「运行时到底怎么串、治理到底怎么硬、能搬走什么」三个问题。
是 HelixFlow v2 设计（`doc/plans/2026-06-09-参考产品工作流图谱.html#helixflow`）的源码依据。

---

## 一 · 端到端工作流（运行时接线）

### 三条入口路径（天然对应 任务/模块/专项 三级）

| 路径 | 触发 | 计划 | 执行 | 终止条件 |
|---|---|---|---|---|
| **1 直干**（任务级） | 直接对 Sisyphus 说话 | 无 | Sisyphus 自己干或 `task(category=...)` 派 Sisyphus-Junior | 任务完成 |
| **2 计划链**（模块级） | `@plan` / 切到 Prometheus | Prometheus 访谈→Metis 查盲区→写 `.omo/plans/*.md`→Momus 验收（OKAY/REJECTED 循环） | `/start-work` 建 `boulder.json`→切 Atlas→按 Wave 并行派发 | plan 内 checkbox 全勾 + boulder 标 completed |
| **3 ULW**（专项级/懒人） | 消息含 `ulw`/`ultrawork` 关键词（`src/hooks/keyword-detector/`，正则 `\b(ultrawork\|ulw)\b`） | 2+ 步任务强制后台 spawn plan agent | Sisyphus + 后台 explore/librarian 并行 + TODO 强制循环 | todo-continuation-enforcer 放行（全部 `[x]`） |

### 状态机文件（边上的产物）

| 文件 | 写者 | 读者 | 作用 |
|---|---|---|---|
| `.omo/plans/{name}.md` | 仅 Prometheus（`prometheus-md-only` hook 强制） | Atlas / 用户 | 计划主产物：Objective/Scope(IN-OUT)/验收标准/**Wave 分组并行任务**/依赖矩阵；每任务带 `Category` + `Skills` + 验收条件 |
| `.omo/boulder.json` | start-work hook + atlas hook | 恢复逻辑 / CLI | 工作状态：active_plan、session_ids[]（会话血缘）、status、per-task 计时；**跨会话续作的根**。源码 `packages/boulder-state/` |
| `.omo/notepads/{plan}/*.md` | 子 agent（**append-only**，notepad-write-guard 强制） | 下一 Wave 的任务 | 智慧台账：conventions/successes/failures&gotchas/decisions/commands；Wave 间传递学到的东西 |

### 续作机制（不丢工作的核心）

- `atlas` hook 在每次 `tool.execute.after` 数 plan 的 checkbox：余 >0 → `injectBoulderContinuation()` 注入 `[Status: 5/8 completed, 3 remaining]` 自动续；余 =0 → boulder 标完成。
- 崩溃/换会话：新会话 `/start-work` 读 boulder.json 直接从断点续，session_ids 追加血缘。
- `todo-continuation-enforcer`（session.idle/error/compacted 触发）：有未完成 TODO 就不许结束回合，注入 SYSTEM REMINDER 强制继续；唯一出口是用户显式 `/stop-continuation`（由 `stop-continuation-guard` 持久化，用户消息也不能误清除）。

### 派发机制

- `task(category="quick|deep|ultrabrain|visual-engineering|...", load_skills=[...])` —— **按语义类别路由而非模型名**（模型名会让模型自我暗示，类别是「思考姿势」声明）。类别→模型回退链定义在 `src/tools/delegate-task/builtin-categories.ts` + `src/shared/model-requirements.ts`。
- `run_in_background=true` → 返回 `bg_...` ID，父会话继续干别的，`background_output(task_id)` 收结果；默认并发 5。
- skill 注入：`load_skills` 把 `packages/shared-skills/skills/{name}/SKILL.md` 前置进子 agent system prompt；优先级 project > opencode > user > builtin。

---

## 二 · 治理硬机制清单（62+ hooks 按强度分层）

**硬（抛错/拦截，约 12 个）—— 这是"治理强"的实体：**

| Hook | 触发 | 强制什么 | 源码 |
|---|---|---|---|
| todo-continuation-enforcer | session.idle/error/compacted | 有未完成 TODO 不许停，自动注入续作 | `src/hooks/todo-continuation-enforcer/` |
| stop-continuation-guard | chat.message | `/stop-continuation` 状态持久化，防误恢复 | `src/hooks/stop-continuation-guard/` |
| write-existing-file-guard | tool.execute.before | **没 Read 过的文件不许 Write/Edit**（按会话记 read 集合，canonical path 防符号链接绕过） | `src/hooks/write-existing-file-guard/` |
| notepad-write-guard | tool.execute.before | notepad 目录禁 Write 只许 Edit（append-only 审计） | `src/hooks/notepad-write-guard/` |
| team-tool-gating | tool.execute.before | team_* 工具按角色（lead/member）鉴权，违规抛错 | `src/hooks/team-tool-gating/` |
| plan-format-validator | tool.execute.after | 写 `.omo/plans/*.md` 时校验 checkbox 格式，解析不了的任务会被跳过→警告 | `src/hooks/plan-format-validator/` |
| no-sisyphus-gpt / no-hephaestus-non-gpt | agent 选择时 | agent×模型兼容矩阵，违规自动换 agent | `src/hooks/no-*-gpt/` |
| tool-pair-validator | messages.transform | 修复消息史里缺失的 tool result 块 | `src/hooks/tool-pair-validator/` |

**中（自动修复/注入）**：rules-injector（见下）、comment-checker（外部二进制扫 AI 垃圾注释，违规写进输出逼 agent 自己改）、preemptive-compaction（token 到 75% 主动压缩）、session-recovery、compaction-todo-preserver（压缩后恢复 todo 明细）。

**软（提醒）**：agent-usage-reminder（提醒编排者派活别自己干，每会话最多 3 次）、keyword-detector、task-reminder、各类通知。

**rules-engine**（`packages/rules-engine/`）—— 跨产品规则统一的关键现货：按优先级扫 `.omo/rules` > `.claude/rules` > `.cursor/rules` > `.github/instructions` > `~/.omo/rules`...，glob 匹配 + 内容哈希去重 + 就近覆盖。**它本来就同时读 Claude/Cursor 的规则目录** —— 一份规则三产品生效的机制现成。

---

## 三 · 跨产品层（修正「Claude Code 是期货」的结论）

### 实际状态比 README 宣传的更近

| 方向 | 状态 | 证据 |
|---|---|---|
| opencode 读 **Claude Code 资产** | **生产级**：CC 的 plugins/agents/commands/skills/`.mcp.json`/settings.json hooks 全能加载 | `src/features/claude-code-plugin-loader/`、`claude-code-mcp-loader/`、`claude-code-agent-loader/`、`src/hooks/claude-code-hooks/`（~2110 行，PreToolUse→tool.execute.before 等事件映射） |
| omoa 跑在 **Codex CLI** 上 | **已发货**（lazycodex）：8 组件经 Codex 原生插件系统注入 | `packages/omo-codex/`，装到 `~/.codex/plugins/`，改 `~/.codex/config.toml` |
| omoa 跑在 **Claude Code** 上 | 路线图探索项（Multi-Harness Support） | `ROADMAP.md`；分层重构已提出 7 个纯 TS Core 包 |

### lazycodex 的 8 组件（= 薄适配的现成模板）

rules / comment-checker / lsp(MCP) / git-bash(MCP, Windows) / ultrawork(关键词) / **ulw-loop**(`.omo/ulw-loop/` 审计的持久循环) / **start-work-continuation**(Stop/SubagentStop hook 读 boulder.json 续作) / telemetry。
**砍掉的**：11 个 agent（用 Codex 原生 agent）、team mode、slash 命令、skill 大部分。
→ 结论：**强治理(hooks) + 状态续作(boulder) 可移植，agent 编排层不可移植**——各产品用自家原生 agent。

### 直接可用的产品中立资产（Claude Code / Cursor 今天就能挂）

| 包 | 能力 | 接入 |
|---|---|---|
| `packages/lsp-tools-mcp` | LSP 诊断/跳转/引用/重命名 | stdio MCP，`.mcp.json` 加一条即可 |
| `packages/ast-grep-mcp` | AST 级搜索/替换 | 同上 |
| `packages/boulder-state` | 工作状态/计划进度纯 TS 库 | 直接 import（helix-vault 的现成地基） |
| `packages/rules-engine` | 多源规则发现/匹配/注入 | 直接 import |
| `packages/comment-checker-core` | AI 垃圾注释检测 | 外部二进制 + 薄包装 |

### 上游分层架构（我们抄的姿势）

```
Core（纯 TS 包：boulder-state / rules-engine / model-core / comment-checker-core ...）
  ↓ 单向依赖
Adapters（opencode 插件｜lazycodex Codex 组件｜future: Claude Code / Pi）
  ↓
Platform（二进制分发）
```

### 裁剪 = 改配置（双作用域 JSONC，项目 `.opencode/` > 用户 `~/.config/opencode/`）

`disabled_agents` / `disabled_hooks`（56 个枚举值）/ `disabled_mcps` / `disabled_skills` / `agents.{name}.model`（模型收敛）/ `categories.{name}.model` / `model_fallback` / `team_mode.enabled` / `keyword_detector.disabled_keywords`。
合并规则：数组并集、对象深合并、标量项目覆盖用户。源码 `src/plugin-config/config-merger.ts`，文档 `docs/reference/configuration.md`。

---

## 四 · 对 HelixFlow v2 的直接输入（哪些机制搬去哪）

| omoa 机制 | 搬到 | 在 Claude Code 上的等价实现 |
|---|---|---|
| boulder.json + plan Wave 格式 + 续作注入 | helix-vault | `.helix/state.json` + Stop hook 检查未完成任务注入续作 |
| todo-continuation-enforcer + stop-continuation-guard | helix-gate | Claude Code Stop hook：todo 未清返回 block |
| write-existing-file-guard / notepad append-only | helix-gate | PreToolUse hook 拦 Write/Edit |
| plan-format-validator | helix-gate | PostToolUse hook 校验计划文件 schema |
| notepads 智慧台账（append-only，Wave 间传递） | helix-compound | 同构：`docs/solutions/` 双轨 schema + 任务间注入 |
| category 语义路由（不写模型名） | hf-plan / 编排 | 任务标 category，dispatch 时映射各产品模型参数 |
| rules-engine 多源优先级 | 三产品统一规则 | 一份规则放 `.claude/rules/`，Cursor/omoa 原生就读 |
| Metis 预审（盲区/AI-slop/隐藏需求） | hf-spec 前置 | 子 agent 调用，READ-ONLY |
| Momus OKAY/REJECTED 验收循环（最多挑 3 刺） | hf-plan 出口门 | 子 agent 审计划，REJECTED 则改后重提 |
| lsp/ast-grep MCP | 三产品共用 | `.mcp.json` 直挂 |
