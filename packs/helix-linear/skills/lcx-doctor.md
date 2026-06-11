# lcx-doctor

## 用途

诊断本地安装、插件注册、模型配置、MCP、运行时状态。适合“为什么工具不可用/插件没生效/命令找不到”。

## 检查项

- CLI 是否在 PATH。
- package/plugin 是否安装。
- 配置文件位置和内容。
- project scope 与 user scope 是否冲突。
- MCP server 是否可启动。
- prompt-pack 是否注册。
- `.helix/work.json`、`prompt-pack.json` 是否合法。
- Node 版本和权限。

## 输出

```json
{
  "status": "pass|warn|fail",
  "checks": [],
  "blockingIssues": [],
  "recommendedFixes": []
}
```

## 规则

- 先读真实本机状态。
- 不凭记忆解释。
- 修复建议必须可执行。
- 不暴露 secret。
