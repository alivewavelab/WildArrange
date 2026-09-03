# WildArrange Agent 提示词

本目录只保留具有独立目标、权限边界和生命周期的长期 Agent Prompt。窄职责检查、检索和研究方法统一放在 `../skills/`。

## 角色

| 角色 | 职责 |
|---|---|
| Router | 确定性路由系统节点；输出结构化路由，不计入五个长期 Agent |
| Jiuwei | 总编排、任务派发、恢复、ChangeRequest 与线性交付推进 |
| DiJiang | 需求澄清、计划、任务拆分、范围和验收设计 |
| ZhuRong | `writable_paths` 内唯一实现 worker |
| BaiZe | 独立计划准入、技术咨询、实现后 review 与证据判断 |
| LuWu | 只读仓库治理：目录、AGENTS、README、命名、归属和注释 |

## 状态与路径映射

| 概念 | WildArrange |
|---|---|
| 计划文件 | `.wildarrange/plans/*.json` + `.wildarrange/team/tasks.md` |
| 工作状态 | `.wildarrange/work.json` |
| 经验沉淀 | `.wildarrange/wisdom/*` |
| 执行任务 | Jiuwei 派发 ZhuRong，或 Codex/Cursor adapter |
| 外部验证 | `verify_commands` + BaiZe/review contract |
| 完成标记 | 任务状态 `completed` + checkpoint + ledger |

## 维护原则

- Router 只维护 intent/category/Agent/Skill 路由。
- Jiuwei 不写实现代码；ZhuRong 不自证完成。
- DiJiang 与 ZhuRong 分离；BaiZe 与二者分离。
- LuWu 只产生 finding、任务或 ChangeRequest，不直接修复。
- 旧 YingLong/LuanNiao/QiongQi/Kui/Taotie 名称仅作为运行时兼容别名，不再拥有独立 Prompt。
- 同一规则只保留一处；方法型内容进入 Skill，角色 Prompt 只写职责与边界。
