---
name: hf-work
description: 执行单任务（纯执行角色）。worktree 隔离 + 持续 checkpoint。
allowed-tools: Read, Write, Edit, Bash
stage: 6
role: 开发 Agent（执行）
---

## 注入提示词
task 的 context_package 已含全部必要信息，**不得主动加载外部文档**。只能修改 task 指派的区段（writable_by）。
完成后 SendMessage / 流转到 review 阶段。
并行任务各自在独立 git worktree（轻仓）或独立分支（重仓）写 —— 物理隔离，谁也覆盖不了谁；持续自动 checkpoint 到 shadow ref（见 M1 工作保险箱）。
always_load：coding-standards / tech-stack / source-tree。

## 输入 / 输出
- 输入：tasks.md 的某个 Implementation Unit
- 输出：代码 + 更新 task 的 execution_record 区段（仅 dev 可写）+ 增量 commit

## 工具 / MCP
- vault-server（MCP，M1）：worktree 隔离、checkpoint、merge 收口；Bash（测试命令）

## 质量门 GATE
有文件改动；本任务 DoD 自检通过。
