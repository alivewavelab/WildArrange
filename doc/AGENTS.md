# 文档目录规范

本目录承载产品概念、架构、路线、交接和方案证据。

## 信息分层

- `README.md` / `README.en.md`：面向用户，保留安装、升级、最小工作流和常见操作。
- `project-architecture.md`：面向维护者，记录当前真实架构和运行时不变量。
- `five-zone-decoupling-guidelines.md`：面向复用，记录不依赖 WildArrange 业务名的通用准则。
- `low-code-project-governance.md`：面向复用，记录「低代码开发者 + AI 维护」的掌控方法论、测试纪律与成熟度分级。
- `development-plan.md`：只记录路线与状态，不替代当前架构事实。
- `plans/*.html`：需要评审或确认的方案、计划与流程可视化。
- 交接文档：记录一次变更的决策和遗留，不作为长期唯一真相。

## 硬规则

- 用户命令或行为变化必须同步更新中文与英文 README。
- 架构职责、依赖方向、状态模型或质量门变化必须更新 `project-architecture.md`。
- 可复用治理原则变化必须更新 `five-zone-decoupling-guidelines.md`。
- 低代码开发者掌控流程、角色分工或成熟度模型变化必须更新 `low-code-project-governance.md`。
- 需要确认的方案/流程使用 `doc/plans/YYYY-MM-DD-[名称].html`，不要用新的 Markdown 计划替代。
- 文档中的命令必须能从项目根直接运行；路径、包名、plugin 名和版本策略要与实现一致。
- 不复制受限第三方 prompt、源码或近似改写文本。

## 验收

- 检查 README 中英文标题、命令和关键警告保持对应。
- 用 `rg` 核对旧命令、旧路径和旧宿主表述没有残留。
- 包内容变化时运行 `npm pack --dry-run --cache /private/tmp/helix-npm-cache`，确认用户文档进入发布包。
