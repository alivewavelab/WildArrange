---
name: configure-project-review
description: 配置项目自己的独立审查步骤、规范文档、必需 Skill 和执行能力握手。当用户要求添加审核规则、接入 Worker 或修复开工依赖缺失时使用；不用于执行业务任务或替代审查结论。
---

# 项目审查配置

## 步骤一：确定现有入口

读取项目规则、运行时注入的 CLI 绝对路径及 config show。以下命令的 wildarrange 指已安装 CLI；宿主提供绝对命令时使用该命令，不能假定目标仓库有 bin/wildarrange.mjs。
本流程只配置 review 与 executionReadiness。读取用户给出的规范全文；保留已有步骤，不因新增规则覆盖旧规则。来源冲突先说明冲突。

## 步骤二：把要求整理成审查清单

每个步骤给出 id、title、appliesTo、requirement、required、documents、skills、command。documents 是仓库内文件引用，skills 是已注册包 Skill 或 .agents/skills/<name>/SKILL.md 的名称。按用户要求的顺序排列，如架构、模块合规、注释。requirement 写可驳回标准，不用“质量好”等空话。R1–R5 职责与唯一事实审计始终由原环节负责，项目步骤不能关闭它。

配置 executionReadiness.workerProbe；任务需要调研时配置 researchProbe 与 researchSkills。复核可用每步 command 或 review.responsibility.command。它们必须连接真实执行服务，禁止用固定 PASS 或回显 JSON 充当真实 Agent。先读取执行服务文档确认接入方式。Worker 从 WILDARRANGE_EXECUTION_CONTEXT 读取任务和完整 Skill。

探测命令从 WILDARRANGE_READINESS_PACKET 读取探测包；Reviewer 从 WILDARRANGE_REVIEW_PACKET 读取。探测返回 ready、原 challenge、loadedSkills。Reviewer 的业务结果必须按包中协议给出结论与源码证据。握手只能证明此刻可调用与已确认上下文，不能证明业务实现正确。

## 步骤三：预览并应用

将仅含 review、executionReadiness 的配置补丁保存为 .wildarrange/plan-drafts/review-setup.json。运行：

~~~bash
wildarrange review configure --from .wildarrange/plan-drafts/review-setup.json
~~~

向用户展示每步检查什么、对哪些文件生效、必需或建议、引用哪份规范和哪个 Skill、执行服务及缺失项。得到对该具体配置的明确批准后执行同一命令加 --apply。已有批准可复用，不重复索取。缺失依赖允许先登记，但不能声称可以开工；修复相关项目文件仍须走正式任务。

## 步骤四：验证结果

对已批准任务运行 readiness --task <taskId>，然后 review checklist --task <taskId>。必需能力或完整文档缺失时报告 blocked 及修复项，不降低 required、不删验收命令。给出配置路径、每步结果和报告位置。只有真实任务经过审查与 checkpoint 才能说交付完成；配置完成不是项目接管完成。
