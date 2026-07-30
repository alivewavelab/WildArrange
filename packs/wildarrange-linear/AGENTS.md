# Prompt Pack 规范

本目录是 WildArrange 自有 Agent、Skill、路由表和工具合同的发布源。

## 内容边界

- `agents/`：角色目标、行为边界和输出契约。
- `skills/`：按需加载的任务工作流，不应在每次会话无差别注入。
- `routes.json`：确定性路由信号与 Skill 映射。
- `manifest.json`：包内 Agent/Skill 清单。
- `tools/tool-contract.json`：Agent 可见的 CLI 工具合同。

## 硬规则

- 商业发布包只能包含 WildArrange 自著内容；不得包含受限第三方源码、prompt 原文或近似改写。
- 新增或重命名 Agent/Skill 时，同步更新 manifest、routes、默认配置和对应测试。
- CLI 能力变化时同步更新 `tool-contract.json`，避免 Agent 使用不存在或过期的命令。
- Skill 全文只在匹配后按需挂载；稳定总纲保持短，细节下沉到具体 Skill。
- 路由建议必须保留 deterministic 证据；语义模型不能无审计覆盖路由表。

## 验收

- 运行 Skill 匹配、Prompt 变体和注入预算相关测试。
- 检查清单与实际文件一一对应。
- 运行 npm 包体预检，确认应发布内容存在且无受限材料。
