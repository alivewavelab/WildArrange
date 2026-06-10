# 07 · compound-engineering（本机真实源文件 v3.11.1）

来源：`~/.claude/plugins/marketplaces/compound-engineering/plugins/compound-engineering/`（本地已装插件，整目录真实拷贝，含 references/assets/scripts）。

| 节点目录 | 真实源 | 注入/作用 |
|---|---|---|
| 01-ce-brainstorm | skills/ce-brainstorm/ | 需求探索(WHAT)，rigor probes，一次一问 |
| 02-ce-plan | skills/ce-plan/ | 研究扇出 + 计划生成(U-ID/Test/Trace)，Phase0.7 范围 GATE |
| 03-lfg-orchestrator | skills/lfg/ | 全流程带 GATE 状态机：plan→work→review→fix→test→pr→CI(3轮)→DONE |
| 04-ce-work | skills/ce-work/ | 执行(worktree 隔离/并行安全检查) |
| 05-ce-code-review | skills/ce-code-review/ | 四段管线：扇出→去重→置信门控→per-finding 独立验证；含 references/(persona-catalog/subagent-template/validator-template/findings-schema) |
| 06-ce-test-browser | skills/ce-test-browser/ | agent-browser E2E(pipeline 模式) |
| 07-ce-commit-push-pr | skills/ce-commit-push-pr/ | commit+push+PR(body 写 tmpfile) |
| 08-ce-compound | skills/ce-compound/ | 复利沉淀(双轨 schema)；含 references/schema.yaml + scripts/validate-frontmatter.py + assets/resolution-template.md |
| 09-agents-reviewers | agents/ce-*-reviewer.md + ce-learnings-researcher.md | 各 reviewer persona(always-on/conditional 在 description 自述) + 召回 agent |

看点：references/ 里的 schema.yaml(双轨 frontmatter)、persona-catalog.md(reviewer 选取)、validator-template.md(独立验证) 是整套复利+评审的真正实现，值得逐字读。
