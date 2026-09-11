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
      "expected": { "signatures": ["launch_game(id: String) -> Result<(), String>"] },
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

计划批准绑定规范化声明的内容指纹。Tauri 的 `expected.signatures` 必须与实际 Rust 签名一致；数据库使用 `kind: "database"`，在 `expected` 中声明表、字段、类型、约束和迁移影响，并绑定真实验证卡片。批准过的精确内容不重复追问，内容变更必须重新提交。

## Loop 中发现计划外变化

worker 先说明 `reason`（必要性）、`impact`（影响）、`alternatives`（替代方案）、`recommendation`（建议）和完整的拟议 `items`。命令 worker 向 stdout 输出一行 `WILDARRANGE_CONTRACT_CHANGE=<上述 JSON>`，然后退出。Loop 持有任务锁，不要在 worker 子进程内运行 `contracts propose` 或 `contracts resolve`。

Loop 外的主 Agent 可执行 `wildarrange contracts propose --task <id> --from <proposal.json>`。收到 `awaiting_user_decision` 后，把说明讲给开发者；自动扫描生成的说明只是线索，主 Agent 必须补充真实必要性与影响，不能把文件路径当作解释。仅在开发者明确批准/拒绝当前内容后，执行 `wildarrange contracts resolve --id <id> --decision accept|reject --expected-fingerprint <sha256> --reason <开发者决定>`。不得自行代批。新会话引用原请求；等待/拒绝期间不重复催问，不重跑该任务。

批准后重跑质量门；并行 admission 等待前恢复共享目录，保留原 run 成果，批准后由原 run 重放。正式契约登记与任务批准分开：`scan/apply-card` 更新版本化台账，必须在登记任务允许路径内交付；扫描、生成总图或验收不会替代登记。

## 扫描边界

使用 `wildarrange contracts scan` 获取机器发现结果。首版只自动发现 Tauri IPC；Rust 源码字符串中的 SQL 和未支持技术栈必须标记人工申报或 `unknown`，不得断言“没有变化”。
