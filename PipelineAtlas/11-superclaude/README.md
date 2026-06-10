# SuperClaude_Framework — Pipeline Atlas

Source: https://github.com/SuperClaude-Org/SuperClaude_Framework (cloned 2026-06-09, depth 1)
Canonical paths used: `plugins/superclaude/commands/` and `plugins/superclaude/agents/` (mirror exists under `src/superclaude/`).

## What is SuperClaude?

A Claude Code plugin framework with 20+ slash commands (`/sc:<name>`), 20 specialist agent personas, 7 behavioral modes, and MCP server routing. PM Agent is the always-active orchestration layer — it fires at every session start without explicit invocation and coordinates all sub-agents.

---

## Node Map

| Node | Dir | Command file | Invokes | One-line injection |
|------|-----|-------------|---------|-------------------|
| 01 · PM | `01-pm/` | `pm.md` | `pm-agent` | Always-active session foundation: restores context via Serena MCP, routes all requests to specialists |
| 02 · Spawn | `02-spawn/` | `spawn.md` | — | Meta-orchestration for multi-domain tasks too complex for a single command; supports sequential/parallel/adaptive strategies |
| 03 · Workflow | `03-workflow/` | `workflow.md` | architect, frontend, backend, security, devops, pm | Converts PRDs and feature specs into structured, dependency-mapped multi-persona implementation workflows |
| 04 · Task | `04-task/` | `task.md` | architect, frontend, backend, security, devops, pm | Executes complex tasks with cross-session persistence, MCP routing, and optional parallel delegation |
| 05 · Brainstorm | `05-brainstorm/` | `brainstorm.md` | architect, analyzer, etc. | Socratic dialogue for requirements discovery; activates on vague/exploratory requests before any PRD exists |
| 06 · Research | `06-research/` | `research.md` | `deep-research-agent`, Tavily, Playwright | Multi-hop web research with adaptive planning; used for anything beyond knowledge cutoff |
| 07 · Implement | `07-implement/` | `implement.md` | frontend, backend, security, qa-specialist | Coordinates specialist personas for feature-level implementation with testing integration |
| 08 · Design | `08-design/` | `design.md` | — | Architecture, API, component, and database schema design; outputs diagrams/specs/code |
| 09 · Analyze | `09-analyze/` | `analyze.md` | — | Quality, security, performance, and architecture analysis across a codebase |
| 10 · Test | `10-test/` | `test.md` | `qa-specialist`, Playwright | Unit/integration/e2e execution with coverage analysis and automatic failure debugging |
| 11 · Improve | `11-improve/` | `improve.md` | architect, performance, quality, security | Systematic refactoring: quality, performance, maintainability, or style focus |
| 12 · Document | `12-document/` | `document.md` | — | Inline comments, API docs, external guides — scoped to a specific component or feature |
| 13 · Spec Panel | `13-spec-panel/` | `spec-panel.md` | technical-writer, system-architect, quality-engineer | Multi-expert panel review of specifications with Socratic/critique/discussion modes |
| 14 · Business Panel | `14-business-panel/` | `business-panel.md` | `business-panel-experts` | Business analysis by simulated thought leaders (Christensen, Porter, etc.) reviewing documents |

---

## _modes/

Behavioral mode files that alter Claude's interaction style when active. All 7 modes included.

| File | Mode | Effect |
|------|------|--------|
| `MODE_Brainstorming.md` | Brainstorming | Socratic dialogue, avoids assumptions, surfaces hidden requirements |
| `MODE_Business_Panel.md` | Business Panel | Multi-expert business framework analysis |
| `MODE_DeepResearch.md` | Deep Research | Multi-hop adaptive research with evidence synthesis |
| `MODE_Introspection.md` | Introspection | Self-review and quality reflection |
| `MODE_Orchestration.md` | Orchestration | Multi-agent coordination and delegation |
| `MODE_Task_Management.md` | Task Management | PDCA-cycle structured task execution |
| `MODE_Token_Efficiency.md` | Token Efficiency | Compressed output mode to reduce context consumption |

---

## _personas/

Three representative agent persona files (20 total in source).

| File | Role |
|------|------|
| `pm-agent.md` | Project Manager — the always-active orchestration persona |
| `system-architect.md` | System Architect — invoked for design and architecture nodes |
| `deep-research-agent.md` | Deep Research Agent — invoked by `/sc:research` |

---

## Coverage

All 14 nodes populated with real source files. No missing files.

Additional commands in source not mapped to nodes:
`agent.md`, `build.md`, `cleanup.md`, `estimate.md`, `explain.md`, `git.md`, `help.md`, `index.md`, `index-repo.md`, `load.md`, `recommend.md`, `reflect.md`, `save.md`, `sc.md`, `select-tool.md`, `troubleshoot.md`
