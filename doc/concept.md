# WildArrange 产品概念

WildArrange 是面向小团队的 AI 编程 Agent 治理层。

简单类比：工人可以说「我干完了」，但出库前仓库门口仍会验货。WildArrange 就是那道门。

## 产品意图

本项目旨在阻止三种常见失败：

1. Agent 未经真实验证就宣称完成。
2. Agent 修改了约定范围之外的文件。
3. Codex 或 Cursor 关闭后会话上下文丢失。

## 核心循环

```text
Plan -> Worker -> Verifier -> Scope Guard -> Review Gate -> Acceptance Proof -> Checkpoint
```

每一步都会把证据写入 `.wildarrange/`，新会话可以从磁盘恢复。

## 外部模式边界

- 专项 Agent 角色。
- 计划与执行分离。
- 信任但验证的复核纪律。
- 基于类别的路由。
- 智慧/上下文累积。
- 通过文件实现会话延续。

## 刻意保持更小的范围

M1 不运行常驻多 Agent 集群。命令型子 Agent 已可在隔离目录或 Git worktree 中运行，之后仅通过 admission 进入主线（`writable_paths` → verify → scope → review → acceptance proof → checkpoint）。宿主私有的后台进程控制仍属于 adapter 工作。

## 当前真相

WildArrange 对外暴露五个长期 Agent：Jiuwei、DiJiang、ZhuRong、BaiZe、LuWu。Router 是确定性系统节点；CangJie 是可选的内部档案员/语义路由 profile。产品、旅程、验收、UX、范围、调研、检查、风险复核与怀疑式验收等职责，以 Skill 形式按需挂载到对应 Agent 上。

BaiZe 是唯一的独立复核者。确定性门仍是权威；可选的 OpenAI 兼容 LLM review 在配置后提供第二意见。
