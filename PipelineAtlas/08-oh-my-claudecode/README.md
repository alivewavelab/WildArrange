# oh-my-claudecode — PipelineAtlas Node Map

Source repo: https://github.com/Yeachan-Heo/oh-my-claudecode  
Clone provenance: `git clone --depth 1` on 2026-06-09  
Files copied from: `/tmp/omc/skills/`, `/tmp/omc/scripts/`, `/tmp/omc/agents/`

---

## Node Map

| Node | File | Role / Injection |
|------|------|-----------------|
| `01-team/SKILL.md` | `skills/team/SKILL.md` | Spawns N coordinated agents on a shared task list using Claude Code's native team tools. Invoked via `/oh-my-claudecode:team [N:agent-type] [ralph] <task>`. Level-4 skill; auto-sizes agent count from task decomposition. |
| `02-autopilot/SKILL.md` | `skills/autopilot/SKILL.md` | Full autonomous pipeline: requirements analysis → design → planning → parallel execution → QA cycling → multi-perspective validation. Triggered by keywords: "autopilot", "autonomous", "build me", etc. Level-4 skill. |
| `03-ralph/SKILL.md` | `skills/ralph/SKILL.md` | PRD-driven persistence loop. Keeps working until all user stories in `prd.json` pass and are reviewer-verified. Wraps ultrawork with session persistence and automatic retry. Triggered by "ralph", "don't stop", "must complete". Level-4 skill. |
| `04-ultrawork/SKILL.md` | `skills/ultrawork/SKILL.md` | Parallel execution engine. Fires multiple agents simultaneously with dependency-aware task graphs. Not a persistence mode — a composable component that ralph/autopilot layer on top of. Triggered by "ulw", "ultrawork". Level-4 skill. |
| `05-ultraqa/SKILL.md` | `skills/ultraqa/SKILL.md` | Autonomous QA cycling: qa-tester → architect verification → fix → repeat until quality gate passes. Supports `--tests`, `--build`, `--lint`, `--typecheck`, `--custom`. Level-3 skill. |
| `06-hooks/keyword-detector.mjs` | `scripts/keyword-detector.mjs` | **Keyword-as-interface hook.** PreToolUse or UserPromptSubmit hook. Detects magic words in user input (ralph, autopilot, ultrawork/ulw, ccg, ralplan, deep-interview, ai-slop-cleaner, tdd, code-review, security-review, ultrathink, deepsearch, analyze) and invokes the corresponding skill tool. Cross-platform Node.js ESM. |
| `06-hooks/persistent-mode.cjs` | `scripts/persistent-mode.cjs` | **Stop-continuation hook.** PostToolUse (or Stop) hook. After each agent turn, checks if an active OMC mode (ralph, autopilot, ultrapilot, swarm, ultrawork, ultraqa, pipeline, team) is still running and re-injects the continuation prompt to prevent the session from settling. CJS for maximum compatibility. |
| `_agents/planner.md` | `agents/planner.md` | Agent role definition for the Planner. Model: Opus. Responsible for interviewing users and writing work plans to `.omc/plans/*.md`. Does NOT implement — only plans. |
| `_agents/executor.md` | `agents/executor.md` | Agent role definition for the Executor. Model: Sonnet. Focused implementation agent. Writes/edits code within assigned task scope. Does not plan or architect. |
| `_agents/qa-tester.md` | `agents/qa-tester.md` | Agent role definition for the QA Tester. Model: Sonnet. Verifies real application behavior via interactive CLI testing in tmux. Does not implement features or write unit tests. |

---

## Architecture Notes

- **Skill hierarchy**: ultrawork ⊂ ralph ⊂ autopilot. Team is a parallel sibling.
- **Hook wiring**: `keyword-detector.mjs` fires on user input → invokes skill as tool. `persistent-mode.cjs` fires on stop → continues loop.
- **Agent routing**: ralph/autopilot delegate to planner for planning phases and executor for implementation; qa-tester handles verification.
- **Not present in this atlas**: The full `skills/` directory contains 40+ additional skills (debug, deep-dive, wiki, self-improve, etc.). Only the core pipeline skills are mapped here.
