---
name: hf-spec
description: 需求 → 规格（约束所有下游的合同）。Use after ideation to produce the binding spec.
allowed-tools: Read, Grep, Glob, Write
stage: 2
role: 产品负责人 + 架构师复核（治理）
---

## 注入提示词
spec 是约束所有下游的合同，不是文档。每条 requirement 用 RFC2119 关键词标强度，配 Given/When/Then 场景。
**修改已有 spec 一律走 delta**（ADDED/MODIFIED/REMOVED）写入 `changes/`，不得直接改主 spec —— 多人/多 Agent 并行不冲突。
校验是否违反 `principles/constitution.md`（宪法级元约束）。

## 输入 / 输出
- 输入：`brief.md` + constitution.md
- 输出：`.workflow/specs/{feature}/spec.md` + `.workflow/changes/{feature}/specs/*.md`(delta)

## 工具 / MCP
- artifacts-server（MCP）：delta 合并、frontmatter 校验、spec 一致性检查

## 质量门 GATE
每条 SHALL/MUST 都有对应场景；constitution 合规；delta 无冲突。
