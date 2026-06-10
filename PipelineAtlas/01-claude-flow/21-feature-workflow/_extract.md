# Node: 21-feature-workflow
<!-- Source: CLAUDE.md lines 48-80 (concurrency rules + swarm orchestration) -->
<!-- Source: .claude/commands/workflows/development.md (full MCP+agent coordination flow) -->
<!-- Source: .claude/commands/workflows/workflow-execute.md -->

## What it injects
The end-to-end feature delivery workflow. The CLAUDE.md concurrency rules mandate that ALL related operations happen in ONE message; the development workflow command defines the MCP + Task tool sequence for shipping a feature:

1. `mcp__claude-flow__swarm_init` — hierarchical swarm, 8 agents, specialized strategy
2. Spawn architect + coder + tester agents concurrently via `mcp__claude-flow__agent_spawn`
3. `mcp__claude-flow__task_orchestrate` — coordinate implementation with dependency graph
4. Run SPARC sub-modes (spec → architect → code → tdd → integration → docs)
5. Memory store/retrieve for cross-agent context sharing

## Key CLAUDE.md rule extract (lines 48-58)
```
## Concurrency: 1 MESSAGE = ALL RELATED OPERATIONS
- ALWAYS batch ALL todos in ONE TodoWrite call (5-10+ minimum)
- ALWAYS spawn ALL agents in ONE message with full instructions via Task tool
- ALWAYS batch ALL file reads/writes/edits in ONE message
- ALWAYS batch ALL terminal operations in ONE Bash message
- ALWAYS batch ALL memory store/retrieve operations in ONE message
```

## 3-Tier Model Routing (ADR-026, ADR-143)
| Tier | Handler | Latency | Cost | Use Cases |
|------|---------|---------|------|-----------|
| 1 | Deterministic codemod | ~1ms | $0 | Structural transforms, no LLM |
| 2 | Haiku | ~500ms | $0.0002 | Simple tasks (<30% complexity) |
| 3 | Sonnet/Opus | 2-5s | $0.003-0.015 | Complex reasoning, architecture (>30%) |
