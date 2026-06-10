# OMO Injection Runtime

## 目的

把 oh-my-openagent 的 rules / continuation / tool-use 注入效果，裁剪成 HelixFlow 在 Codex 与 Cursor 都能执行的协议。

核心目标不是复制某个宿主的 hook 名字，而是确保每个关键节点都拿到同一类上下文：

- 项目规则。
- 当前任务状态。
- 最近 ledger / snapshot。
- 可用 tools。
- 必要 skills。
- 续跑指令。
- 不可削弱的验收 invariants。

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

| 注入点 | 对应 OMO 行为 | HelixFlow 命令 |
| --- | --- | --- |
| `session_start` | SessionStart 静态规则注入 | `resume` + `rules collect` + `context build` |
| `user_prompt_submit` | UserPromptSubmit 静态规则补注入 | `route` + `rules collect` |
| `pre_tool_use` | PreToolUse 工具执行前阻断 | `hook run`，计划外写入返回 `permissionDecision=deny` |
| `post_tool_use` | PostToolUse 按被改文件动态注入规则 | `rules collect --target <path>` + `scope_guard` |
| `post_compact` | PostCompact 压缩后恢复标记 | `resume` + `rules collect` |
| `before_execute` | worker 执行前注入任务包 | `context build --agent Atlas --task <id>` |
| `before_review` | reviewer 审核前注入证据包 | `context build --agent Oracle/Momus/Metis --task <id>` |
| `before_checkpoint` | checkpoint 前质量门 | `evidence record` + `review gate` |
| `stop` | start-work-continuation stop hook | `continuation check` |

查看某个注入点最终挂载：

```bash
node ./bin/helix.mjs injection show --point before_review --agent Oracle --task T001
```

Codex/Cursor adapter 应优先调用 hook 入口，让运行时自动选择注入点并输出 Markdown：

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

已支持事件：

- `SessionStart` -> `session_start`
- `UserPromptSubmit` -> `user_prompt_submit`
- `PreToolUse` -> `pre_tool_use`
- `PostToolUse` -> `post_tool_use`
- `PostCompact` -> `post_compact`
- `Stop` -> `stop`
- `SubagentStop` -> `stop`

## Agent 必须行为

### Sisyphus

- 新会话先看 `session_start` / `stop` 注入结果。
- 如果宿主提供 hook payload，优先执行 `node ./bin/helix.mjs hook run --from hook.json`，把输出视为实时上下文。
- 中途需求变化必须走 `helix steer` 或 ChangeRequest，不允许聊天里直接改计划。
- 如果配置缺少关键模型或注入点，先报告配置缺口，不要假装 OMO 注入已生效。

### Atlas

- 执行前必须构建 `before_execute` 上下文。
- 写文件前如果宿主支持 `PreToolUse`，必须接受 `permissionDecision=deny`，不要绕过 scope guard。
- verifier PASS 后必须确认 `successCriteria` 证据。
- checkpoint 前必须跑 `before_checkpoint`，不能只凭 worker DoneClaim。

### Oracle / Momus / Metis

- 审核前必须构建各自 `before_review` 上下文。
- 输出结构化 verdict：`PASS | FAIL | INCONCLUSIVE`。
- 证据不足只能 INCONCLUSIVE，不得 PASS。

## 不变量

- 注入内容不能降低验收标准。
- Skill / Markdown / Tool 挂载只能增加上下文，不能替代 verifier。
- `successCriteria` 不能被删除来制造 PASS。
- `review_blocked` 不能被当作 completed。
- `continuation check` 发现未完成任务时，下一会话必须恢复，不要求用户复述上下文。
