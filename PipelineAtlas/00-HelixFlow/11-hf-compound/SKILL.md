---
name: hf-compound
description: 沉淀后置。问题解决后写双轨 schema 到 docs/solutions/。复利飞轮的"存"。自进化的载体。
allowed-tools: Read, Write, Grep, Glob
role: 贯穿（治理）
---

## 注入提示词
触发：问题解决信号（"搞定了"/"修好了"）或阶段收尾。
**双轨 frontmatter schema**（偷自 CE）：problem_type 决定轨道 —— bug 轨(symptoms/root_cause/resolution_type 强制) / knowledge 轨(applies_when 可选)；共用 required: module/date/component/severity。
五维 overlap 评分（problem/root_cause/solution/files/prevention），High(4-5维匹配)→**更新旧文档而非新建**，防文档漂移。
**只 orchestrator 写文件，子 Agent 只回文本，主交付物只 1 个**。
**自进化关键**：bug 轨的沉淀会被 M3 的"自进化测试"消费，自动变成下次的回归检查项 —— 测试随项目越用越强。
顺手维护 `CONCEPTS.md`（项目共享词汇表）。

## 输入 / 输出
- 输入：对话历史（问题解决过程）
- 输出：`docs/solutions/{category}/*.md` + 可选更新 CONCEPTS.md

## 工具 / MCP
- Write（orchestrator 独占）；frontmatter 校验脚本
