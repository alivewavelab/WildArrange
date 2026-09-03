# Prompt Pack 规范

本目录是 WildArrange 自有 Agent、Skill、路由表和工具合同的发布源。

## 内容边界

- `agents/`：角色目标、行为边界和输出契约。
- `skills/`：按需加载的任务工作流，不应在每次会话无差别注入。
- `routes.json`：确定性路由信号与 Skill 映射。
- `manifest.json`：包内 Agent/Skill 清单。
- `tools/tool-contract.json`：Agent 可见的 CLI 工具合同。
- `project-init/`：显式 `init --project-docs` 使用的项目治理文档模板；不属于 prompt 注入清单。根规则模板必须命名为 `AGENTS.template.md`，避免源码树里的模板被宿主误认成现行目录规范。

## 硬规则

- 长期 Agent 固定为 Jiuwei、DiJiang、ZhuRong、BaiZe、LuWu；Router 是系统节点，不计入 Agent 编制。
- Router 是系统节点；CangJie 是可选内部 profile，不是第六长期 Agent。
- DiJiang、BaiZe、LuWu 不得进入任意 command worker。
- 阶段只作为路由和匹配上下文，不建立阶段前缀 Skill；产物与门控只使用 `.wildarrange/`、真实 CLI 和 delivery pipeline。
- 窄职责必须优先建模为 Skill；只有具备独立目标、权限边界和生命周期时才新增 Agent Prompt。
- 商业发布包只能包含 WildArrange 自著内容；不得包含受限第三方源码、prompt 原文或近似改写。
- 新增或重命名 Agent/Skill 时，同步更新 manifest、routes、默认配置和对应测试。
- 项目初始化模板只允许补建缺失文件；不得覆盖、合并或猜测已有项目规范。
- CLI 能力变化时同步更新 `tool-contract.json`，避免 Agent 使用不存在或过期的命令。
- 发布工具合同不得含 `contract-only` 或把多个状态变更用 shell 管道拼成一条命令；宿主已有的只读工具明确标为 `host-provided`，未实现/roadmap 能力不进入 M1 合同。
- Skill 全文只在匹配后按需挂载；稳定总纲保持短，细节下沉到具体 Skill。
- 路由建议必须保留 deterministic 证据；语义模型不能无审计覆盖路由表。

## 验收

- 运行 Skill 匹配、任务绑定和注入预算相关测试。
- 检查清单与实际文件一一对应。
- 运行 npm 包体预检，确认应发布内容存在且无受限材料。
