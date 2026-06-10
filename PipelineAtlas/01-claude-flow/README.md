# PipelineAtlas — 01-claude-flow

Source: https://github.com/ruvnet/claude-flow (commit: depth-1 clone, 2026-06-09)

Each directory contains the real source file(s) from the repo that define the node's injected prompt/tool/logic, plus a `_extract.md` where the logic lives inside a shared file (with source path + line range noted at top).

---

## Node Map

| # | Directory | Real File(s) Copied | What it injects |
|---|-----------|--------------------|-|
| 01 | `01-session-start-hook` | `.claude/settings.json`, `.claude/helpers/hook-handler.cjs` (session-restore, lines 162-178), `.claude/helpers/auto-memory-hook.mjs`, `.claude/helpers/session.cjs` | On SessionStart: restores session state, initialises intelligence graph (pattern/edge counts), then imports persisted memory into context |
| 02 | `02-route-hook` | `.claude/helpers/router.cjs`, `.claude/helpers/hook-handler.cjs` (route handler, lines 110-131) | On every UserPromptSubmit: pattern-matches prompt against agent types, injects a routing recommendation box (agent name, confidence %, reason) |
| 03 | `03-session-end-hook` | `.claude/helpers/hook-handler.cjs` (session-end, lines 180-196), `.claude/helpers/auto-memory-hook.mjs`, `.claude/commands/hooks/session-end.md` | On SessionEnd: consolidates intelligence graph (PageRank recompute, new edges), ends session; on Stop: exports memory to persistent storage |
| 04 | `04-pre-task-hook` | `.claude/helpers/hook-handler.cjs` (pre-bash lines 133-146, pre-task lines 198-207), `.claude/commands/hooks/pre-task.md` | PreToolUse on Bash: blocks dangerous commands (rm -rf /, fork bomb, etc.); also increments task counter and routes task prompt |
| 05 | `05-swarm-init` | `.claude/commands/coordination/swarm-init.md`, `.claude/commands/swarm/swarm-init.md`, `.claude/commands/swarm/swarm.md`, `.claude/helpers/swarm-hooks.sh` | Initialises a multi-agent swarm with configurable topology (hierarchical/mesh/ring/star), max-agents, strategy, and optional memory/GitHub integration |
| 06 | `06-sparc-orchestrator` | `.claude/commands/sparc/orchestrator.md`, `.claude/commands/sparc/sparc.md`, `.claude/commands/sparc.md`, `plugins/ruflo-sparc/agents/sparc-orchestrator.md` | SPARC orchestrator mode: coordinates all SPARC sub-modes via MCP `sparc_mode{mode:"orchestrator"}`, dispatches spec/architect/code/tdd/debug/integration sub-agents |
| 07 | `07-sparc-spec-pseudocode` | `.claude/commands/sparc/spec-pseudocode.md`, `.claude/agents/sparc/pseudocode.md`, `.claude/agents/sparc/specification.md` | SPARC Spec/Pseudocode mode: generates detailed specifications and pseudocode blueprints before any implementation begins |
| 08 | `08-sparc-architect` | `.claude/commands/sparc/architect.md`, `.claude/agents/sparc/architecture.md` | SPARC Architect mode: designs system architecture, component boundaries, and data flows |
| 09 | `09-sparc-code` | `.claude/commands/sparc/code.md`, `.claude/commands/sparc/coder.md` | SPARC Code mode: implements features according to the architecture and spec, with hardcoded no-mock / TDD constraints |
| 10 | `10-sparc-tdd` | `.claude/commands/sparc/tdd.md`, `.claude/commands/sparc/tester.md` | SPARC TDD mode: writes failing tests first, then drives implementation to pass them; includes London-school mock patterns |
| 11 | `11-sparc-debug` | `.claude/commands/sparc/debug.md`, `.claude/commands/sparc/debugger.md` | SPARC Debug mode: systematic root-cause analysis, hypothesis generation, and targeted fix application |
| 12 | `12-sparc-security-review` | `.claude/commands/sparc/security-review.md`, `.claude/commands/sparc/reviewer.md` | SPARC Security Review mode: scans for OWASP top-10, secrets, injection vulnerabilities, and supply-chain risks |
| 13 | `13-sparc-refinement-optimization` | `.claude/commands/sparc/refinement-optimization-mode.md`, `.claude/commands/sparc/optimizer.md`, `.claude/agents/sparc/refinement.md` | SPARC Refinement/Optimization mode: performance profiling, algorithmic improvements, and code quality uplift post-implementation |
| 14 | `14-sparc-integration` | `.claude/commands/sparc/integration.md` | SPARC Integration mode: wires together independently developed components, verifies contracts, and runs end-to-end smoke tests |
| 15 | `15-sparc-docs-writer` | `.claude/commands/sparc/docs-writer.md`, `.claude/commands/sparc/documenter.md` | SPARC Docs-Writer mode: generates API docs, README sections, architectural decision records, and inline comments |
| 16 | `16-memory-store-search` | `.claude/commands/memory/memory-search.md`, `.claude/commands/memory/memory-persist.md`, `.claude/commands/claude-flow-memory.md`, `.claude/helpers/memory.cjs`, `plugins/ruflo-rag-memory/agents/memory-specialist.md` | Cross-agent memory: persist key facts/context to SQLite/HNSW store; semantic search retrieves relevant past context into the current agent's window |
| 17 | `17-intelligence-cycle` | `.claude/helpers/intelligence.cjs`, `plugins/ruflo-intelligence/README.md` | 4-step self-learning loop (RETRIEVE → JUDGE → DISTILL → CONSOLIDATE) using 29 MCP tools; local stub runs lightweight in-process version at session start/end |
| 18 | `18-background-workers` | `plugins/ruflo-loop-workers/agents/loop-worker-coordinator.md`, `plugins/ruflo-loop-workers/commands/ruflo-loop.md`, `plugins/ruflo-loop-workers/commands/ruflo-schedule.md`, `.claude/helpers/worker-manager.sh` | Scheduled/recurring background agents: loop workers run tasks on a cron or event trigger outside the main session |
| 19 | `19-post-task-hook` | `.claude/helpers/hook-handler.cjs` (post-task, lines 210-217), `.claude/commands/hooks/post-task.md` | On SubagentStop: calls `intelligence.feedback(true)` to record successful task outcomes into the learning graph |
| 20 | `20-post-deployment-monitoring` | `.claude/commands/sparc/post-deployment-monitoring-mode.md` | SPARC Post-Deployment Monitoring mode: sets up observability, health checks, alerting, and rollback triggers after a deployment |
| 21 | `21-feature-workflow` | `.claude/commands/workflows/development.md`, `.claude/commands/workflows/workflow-execute.md`, `.claude/commands/workflows/workflow-create.md`, `.claude/commands/automation/smart-agents.md`, `CLAUDE.md` | Full feature delivery pipeline: 1-message concurrency rules, 3-tier model routing, swarm init → agent spawn → SPARC sequence → memory coordination |

---

## Notes

- Nodes **01–04, 19** all share `.claude/helpers/hook-handler.cjs`; each node directory contains its own copy plus a `_extract.md` pinpointing the relevant lines.
- `hook-handler.cjs` is the central hook dispatcher (269 lines); all Claude Code lifecycle hooks (SessionStart, UserPromptSubmit, PreToolUse, SessionEnd, Stop, SubagentStop, PreCompact) route through it.
- No `.roomodes` file exists in this repo; SPARC modes are entirely in `.claude/commands/sparc/*.md` and `.claude/agents/sparc/*.md`.
- Node **17** (intelligence-cycle) has no dedicated command file — its logic is split between the in-process `intelligence.cjs` stub and the `ruflo-intelligence` plugin (29 MCP tools). The plugin README provides the authoritative pipeline spec.

---

Total files copied (excluding this README): 63
