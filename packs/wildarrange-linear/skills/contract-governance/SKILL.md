---
name: contract-governance
description: 在新增或修改功能、API、事件、跨进程调用、公开模块导出、数据库表或字段时，识别并申报契约变化，补齐兼容、迁移、回滚、验证引用与未知项；用于功能规划、任务生成前确认，以及执行前复核 task.contractChanges。
---

# 契约治理

## 规划时

1. 从用户目标和系统设计中识别 API、事件、Tauri command、公开模块导出、表、字段或约束变化。
2. 先理解语义再填写，不复制用户原话。
3. 只追问无法可靠推断且会改变方案的内容；其余内容由主模型补全并交开发者确认。
4. 在当前对话中展示确认稿，不把一个文件路径当成交付。
5. 开发者确认前，不生成可执行 task。

每项变化至少说明：`contractId`、`kind`、`action`、`summary`、`compatibility`、`migration`、`rollback`、`verificationRefs`、`sourcePaths` 和仍无法确认的内容。`verificationRefs` 只引用验证登记册卡片 ID，不复制测试命令。删除契约属于破坏性变化，必须取得开发者明确批准并填写 `approvalRef`。

## 生成任务时

把开发者确认的内容写入英文 task 字段：

```json
{
  "skills": ["contract-governance"],
  "contractChanges": {
    "declared": true,
    "items": [{
      "contractId": "tauri:launch_game",
      "kind": "tauri_command",
      "action": "add",
      "summary": "启动指定游戏并返回启动状态",
      "compatibility": "新增命令，不影响旧调用方",
      "migration": "不需要",
      "rollback": "删除前后端调用并恢复原入口",
      "verificationRefs": ["VG-001"],
      "sourcePaths": ["client/src-tauri/src/lib.rs", "client/src/features/game.ts"]
    }]
  }
}
```

确认没有契约变化时写入 `{ "contractChanges": { "declared": false, "items": [] } }`。

## 执行前

核对 `task.contractChanges` 与计划确认稿一致。不要替用户改变产品决定。代码触及未申报契约时停止扩张范围，返回 Jiuwei 补充确认。

## 扫描边界

使用 `wildarrange contracts scan` 获取机器发现结果。首版只自动发现 Tauri IPC；Rust 源码字符串中的 SQL 和未支持技术栈必须标记人工申报或 `unknown`，不得断言“没有变化”。
