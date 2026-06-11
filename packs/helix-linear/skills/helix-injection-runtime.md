# Helix Injection Runtime

## 目的

把 HelixFlow 的运行时上下文挂载到关键节点，让 Codex、Cursor 或普通 CLI 会话拿到同一类治理信息。

核心目标不是依赖某个宿主的私有 hook，而是确保每个关键节点都能读取：

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

| 注入点 | 作用 | HelixFlow 命令 |
| --- | --- | --- |
| `session_start` | 新会话恢复规则、状态和上下文 | `resume` + `rules collect` + `context build` |
| `user_prompt_submit` | 用户请求进入时做路由和规则补充 | `route` + `rules collect` |
| `pre_tool_use` | 工具执行前范围阻断 | `hook run`，计划外写入返回 `permissionDecision=deny` |
| `post_tool_use` | 工具执行后按目标文件刷新动态规则 | `rules collect --target <path>` + `scope_guard` |
| `post_compact` | 上下文压缩后恢复工作状态 | `resume` + `rules collect` |
| `before_execute` | worker 执行前注入任务包 | `context build --agent Atlas --task <id>` |
| `before_review` | reviewer 审核前注入证据包 | `context build --agent Oracle/Momus/Metis --task <id>` |
| `before_checkpoint` | checkpoint 前质量门 | `evidence record` + `review gate` |
| `stop` | 会话停止前生成续跑指令 | `continuation check` |

查看某个注入点最终挂载：

```bash
node ./bin/helix.mjs injection show --point before_review --agent Oracle --task T001
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

### Sisyphus

- 新会话先看 `session_start` / `stop` 注入结果。
- 如果宿主提供 hook payload，优先执行 `node ./bin/helix.mjs hook run --from hook.json`。
- 中途需求变化必须走 `helix steer` 或 ChangeRequest，不允许聊天里直接改计划。
- 如果配置缺少关键模型或注入点，先报告配置缺口。

### Atlas

- 执行前必须构建 `before_execute` 上下文。
- 写文件前如果宿主支持 `pre_tool_use`，必须接受 `permissionDecision=deny`。
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
