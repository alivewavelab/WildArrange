# 任务与缺陷治理入口

本项目使用 WildArrange 管理任务与缺陷。`.helix/team/tasks.json` 是唯一工单总账；Dashboard、CLI 摘要和 Markdown 投影都是它的视图，不在本文件重复维护任务表。

## 查看与登记

```bash
wildarrange task list --all
wildarrange task get --task T001
wildarrange task create --title "任务或缺陷" --type feature
wildarrange serve --host 127.0.0.1 --port 8765
```

## 治理规则

- 一项任务代表一个可以独立验收、交付或回滚的工作单元。
- BUG 使用 `--type bug`；原任务验收范围内的修正使用 `acceptance_correction` 并关联父任务。
- Agent 可以创建 draft、领取任务、更新事实和提交证据，不得自行改变人类确定的优先级、范围或批准边界。
- Agent 的 DoneClaim 不构成完成；必须经过 verifier、scope、review、acceptance proof 和 checkpoint。
- 取消或归档任务必须保留 ledger 历史，不通过删除记录制造“从未发生”。
- ClickUp、GitHub Issues 等外部系统只能作为明确配置的同步视图，不得与 WildArrange 同时成为任务真源。

## 项目确认

- 任务编号与前缀：[待确认；默认使用 WildArrange 生成的 T 编号]
- 人类验收负责人：[待确认]
- 可由 Agent 修改的字段：[待确认]
- 必须由人类决定的状态或字段：[待确认]
