# WildArrange 注入运行时

## 目的

把 WildArrange 的运行时上下文挂载到关键节点，让 Codex、Cursor、Kimi Code 或普通 CLI 会话拿到同一类治理信息。

核心目标不是把治理藏进某个宿主的私有能力，而是让不同宿主按能力分层接入同一套本地协议：

- Codex：adapter 写入项目 `.codex/hooks.json`，并保留 `.helix/adapters/codex/hooks.json` 审计副本；只有在可信项目里通过 `/hooks` review / trust 后，才具备 hard hook 拦截。
- Cursor：adapter 写入 `.cursor/rules/wildarrange.mdc`，属于 soft 规则注入；模型必须主动执行 CLI，不能假装宿主会强制拦截。
- Kimi Code：adapter 生成 `.helix/adapters/kimi/plugin/`，用户显式安装后由 Hook bridge 转发宿主事件；复用 `AGENTS.md` 与 `.agents/skills/`，不改用户级配置。Kimi Hook 崩溃或超时时会 fail-open，最终完成仍以 WildArrange gate 为准。
- 普通 CLI：手动运行 `node ./bin/helix.mjs ...`，用文件状态和 gate 命令完成治理闭环。

无论宿主强弱，每个关键节点都应能读取：

- 项目规则。
- 当前任务状态。
- 最近 ledger / snapshot。
- 可用 tools。
- 必要 skills。
- 续跑指令。
- 不可削弱的验收 invariants。

## 上下文治理哲学

把上下文当成工具箱，不当成仓库搬家：

- **系统提示词是宪法**：只放稳定、短、硬的行为边界，不承载完整工作流。
- **Skill 是作业指导书**：只有任务真的需要时才激活；一旦激活，应尽量完整加载，不能用静默截断破坏步骤。
- **References 是档案库**：大型案例、长规范、历史资料不要常驻；先给目录、触发条件和路径，再按需读取。
- **Hook 是交通灯**：在正确时机给正确信号。`pre_tool_use` 只做范围和规则阻断，`before_execute` 才给执行工作流，`before_review` 才给复核证据。

Agent 看到挂载信息时必须先判断：

1. 本次任务是否真的需要该 Skill。
2. 挂载是否显示 `truncated=true`。
3. 如果工作流依赖被截断部分，先读取源文件或相关 references，再执行。
4. 不因为上下文很长就降低 verifier、scope、review、acceptance proof 的标准。

## 配置真相源

优先级：

1. `helix.config.json`
2. `.helix/config.json`
3. runtime 默认配置

查看最终配置：

```bash
node ./bin/helix.mjs config show
```

生成可编辑根配置：

```bash
node ./bin/helix.mjs config init --root
```

## 注入点

| 注入点 | 作用 | WildArrange 命令 |
| --- | --- | --- |
| `session_start` | 新会话恢复规则、状态和上下文 | `resume` + `rules collect` + `context build` |
| `user_prompt_submit` | 用户请求进入时做路由和规则补充 | `route` + `rules collect` |
| `pre_tool_use` | 工具执行前范围阻断 | `hook run`，计划外写入返回 `permissionDecision=deny` |
| `post_tool_use` | 工具执行后按目标文件刷新动态规则 | `rules collect --target <path>` + `scope_guard` |
| `post_compact` | 上下文压缩后恢复工作状态 | `resume` + `rules collect` |
| `before_execute` | worker 执行前注入任务包 | `context build --agent YingLong --task <id>` |
| `before_review` | reviewer 审核前注入证据包 | `context build --agent BaiZe/QiongQi/LuanNiao --task <id>` |
| `before_checkpoint` | checkpoint 前质量门 | `evidence record` + `review gate` |
| `stop` | 会话停止前生成续跑指令 | `continuation check` |

查看某个注入点最终挂载：

```bash
node ./bin/helix.mjs injection show --point before_review --agent BaiZe --task T001
```

adapter 应优先调用 hook 入口，让运行时自动选择注入点并输出 Markdown：

```bash
node ./bin/helix.mjs hook run --from hook.json
```

`hook.json` 最小格式：

```json
{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "session-1",
  "cwd": "/path/to/project",
  "prompt": "用户当前请求"
}
```

## Agent 必须行为

### Jiuwei

- 新会话先看 `session_start` / `stop` 注入结果。
- 如果宿主提供 hook payload，优先执行 `node ./bin/helix.mjs hook run --from hook.json`。
- 中途需求变化必须走 `helix steer` 或 ChangeRequest，不允许聊天里直接改计划。
- 如果配置缺少关键模型或注入点，先报告配置缺口。

### YingLong

- 执行前必须构建 `before_execute` 上下文。
- 写文件前如果宿主支持 `pre_tool_use`，必须接受 `permissionDecision=deny`。
- verifier PASS 后必须确认 `successCriteria` 证据；显式 criteria 只有绑定具体 `verifierCommandRefs` 且对应命令 PASS，或已有人工 evidence 时才可通过。
- checkpoint 前必须跑 `before_checkpoint`，不能只凭 worker DoneClaim。

### BaiZe / QiongQi / LuanNiao

- 审核前必须构建各自 `before_review` 上下文。
- BaiZe / LuanNiao 输出结构化 verdict：`PASS | FAIL | INCONCLUSIVE`；QiongQi 输出 `[OKAY] | [REJECT]`，缺上下文时必须 `[REJECT]`。
- 证据不足只能 INCONCLUSIVE，不得 PASS。

## 不变量

- 注入内容不能降低验收标准。
- Skill / Markdown / Tool 挂载只能增加上下文，不能替代 verifier。
- Markdown 适合短规则和当前状态；Skill 可以更长，但必须按任务激活。
- 超出预算的挂载必须明示截断信息，不能假装完整。
- `successCriteria` 不能被删除来制造 PASS。
- `review_blocked` 不能被当作 completed。
- `continuation check` 发现未完成任务时，下一会话必须恢复，不要求用户复述上下文。
