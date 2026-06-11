# WildArrange Project Architecture

## Runtime Shape

```text
bin/helix.mjs
  -> src/helix-core.mjs
     -> src/helix-foundation.mjs
     -> src/helix-adapters.mjs
     -> src/helix-change.mjs
     -> src/helix-failure.mjs
     -> src/helix-routing.mjs
     -> src/helix-archivist-router.mjs
     -> src/helix-rules.mjs
     -> src/helix-review.mjs
     -> src/helix-injection.mjs
     -> src/helix-context.mjs
     -> src/helix-hooks.mjs
     -> src/helix-status.mjs
     -> src/helix-workflow.mjs
     -> src/helix-node-runtime.mjs
     -> src/helix-plan.mjs
     -> src/helix-team.mjs
     -> src/helix-parallel-agents.mjs
     -> src/helix-gates.mjs
  -> src/helix-dashboard.mjs
  -> packs/wildarrange-linear/*
  -> .helix/*
```

## Main Files

- `bin/helix.mjs`: CLI routing.
- `src/helix-core.mjs`: compatibility export surface for existing CLI/tests/imports.
- `src/helix-foundation.mjs`: shared constants, runtime initialization, config, locks, prompt-pack registry, snapshots, and resume context basics.
- `src/helix-adapters.mjs`: Codex/Cursor adapter install, uninstall, report, and backup logic.
- `src/helix-change.mjs`: steering proposals, review blockers, ChangeRequest review, and explicit accept/reject resolution.
- `src/helix-failure.mjs`: failure reason classification, retry hints, and actionable failure summaries.
- `src/helix-routing.mjs`: intent/domain/complexity routing and route request persistence.
- `src/helix-archivist-router.mjs`: DeepSeek flash based archivist/router runtime, routing packet construction, deterministic fallback, structured memory updates, context injection packs, and keyword suggestion artifacts.
- `src/helix-rules.mjs`: project rule scanning and rule-context generation from AGENTS/CLAUDE/Cursor-style files.
- `src/helix-review.mjs`: worker execution and deterministic BaiZe/QiongQi/LuanNiao review lanes.
- `src/helix-injection.mjs`: injection-point resolution and mounted markdown/skill attachment loading.
- `src/helix-context.mjs`: agent context, resume snapshots, session lineage, and continuation directives.
- `src/helix-hooks.mjs`: host lifecycle hook handling and pre-tool-use scope guard output.
- `src/helix-status.mjs`: workflow summary, status report, dashboard data, and ledger tail reads.
- `src/helix-workflow.mjs`: workflow entrypoint, sample plan generation, and plan template copying.
- `src/helix-node-runtime.mjs`: linear task node runtime for execute/verify/scope/review/checkpoint/retry.
- `src/helix-plan.mjs`: plan normalization, graph validation, plan import, route enrichment, and task-state loading.
- `src/helix-team.mjs`: team-lite tasks, claims, evidence recording, task-state persistence, outbox, and durable message board.
- `src/helix-parallel-agents.mjs`: command-based child-agent batch runner, isolated run directories, result collection, team message publication, and agent-run index.
- `src/helix-gates.mjs`: command execution, verifier, scope guard, path checks, checkpoints, change requests, review/failure reports, and wisdom ledger.
- `src/helix-dashboard.mjs`: local dashboard HTTP API and HTML UI.
- `packs/wildarrange-linear/agents`: role prompts.
- `packs/wildarrange-linear/skills`: skill prompts.
- `packs/wildarrange-linear/tools/tool-contract.json`: tool contract inventory.
- `helix.config.json`: local runtime configuration.

## Runtime State

- `.helix/team/tasks.json`: durable task state.
- `.helix/ledger.jsonl`: append-only audit log.
- `.helix/checkpoints`: checkpoint JSON after all gates pass.
- `.helix/reports`: human-readable reports.
- `.helix/snapshots/context.md`: resume context.
- `.helix/agent-runs`: child-agent task packets, command results, structured result files, and run index.
- `.helix/memory/events.jsonl`: structured memory event stream for routing and stage archive facts.
- `.helix/memory/stage-summaries`: structured summaries for progress, decisions, artifacts, implementation notes, research notes, pitfalls, and open questions.
- `.helix/memory/index.json`: lightweight keyword/domain/artifact index for memory recall.
- `.helix/routing/suggestions`: ArchivistRouter keyword suggestions and user-preference routing notes.
- `.helix/adapters`: generated adapter files, reports, and backups.

## Routing Model

Routing uses a hybrid model:

1. `src/helix-routing.mjs` runs the deterministic hot path from `packs/wildarrange-linear/routes.json`.
2. `ArchivistRouter` uses configured `CangJie` / `deepseek-v4-flash` when provider credentials exist, and falls back to deterministic routing when unavailable.
3. Prompt-count triggers are stage aware: ideate/plan/clarify defaults to 5 turns, normal work defaults to 10 turns, and execute/verify/review defaults to 15 turns with a 20-turn cap.
4. `ArchivistRouter` reads a bounded routing packet and structured memory instead of unlimited raw chat history.
5. Routing packets use conclusions-only capture: keep user intent, visible assistant conclusions, summarized tool results, evidence, progress, decisions, artifacts, implementation conclusions, research notes, pitfalls, and open questions; strip code blocks, diffs, raw command output, and intermediate process text by default.
6. It may produce route decisions, multi-intent segments, structured archive updates, context injection packs, user-preference notes, and keyword patch suggestions.
7. Keyword suggestions are written for review first. High-risk routing areas such as review, Git, permissions, safety, deletion, release, and scope changes require human or Jiuwei approval before updating `routes.json`.

## Parallel Agent Model

The first parallel runtime is intentionally narrow:

1. `parallel run` selects runnable pending tasks or explicit task IDs.
2. Each child receives a task packet under `.helix/agent-runs/<runId>/<taskId>/task.json`.
3. The configured runner command executes inside that isolated run directory.
4. Optional structured output is read from `agent-result.json`.
5. Results are written to `.helix/agent-runs`, published to the team message board, and appended to the ledger.

This does not yet merge child workspace changes into the main project. Git worktree isolation, verifier-before-merge, and merge admission are the next layer.

## Gate Model

Completion requires:

1. `worker_command` exits 0.
2. `verify_commands` exists and passes.
3. `successCriteria` passes.
4. `scope_guard` returns `pass`.
5. `review_gate` returns `pass`.

`inconclusive` is not completion evidence.

The review gate is host-neutral. It runs from the CLI and may include deterministic lanes, configured `review_commands`, configured `standards_commands`, optional LSP/typecheck commands, comment checking, and optional OpenAI-compatible LLM review.

## Adapter Model

Cursor receives `.cursor/rules/wildarrange.mdc`.

Codex receives `.helix/adapters/codex/hooks.json`, which mirrors host lifecycle hooks. Full host-level Codex plugin installation is still future adapter work.

## Provider Model

Default GPT-family agents use `provider: "host"`. That means Codex/Cursor owns model selection, authentication, and model routing. WildArrange does not require `OPENAI_API_KEY` for host-managed YingLong, ZhuRong, BaiZe, LuanNiao, QiongQi, Jiuwei, or generic `deep`/`ultrabrain` lanes.

External providers use `type: "openai-compatible"` and are configured with:

- `apiKeyEnv`: environment variable name that stores the API key.
- `baseUrlEnv`: optional environment variable name that overrides the endpoint.
- `defaultBaseUrl`: fallback endpoint when `baseUrlEnv` is not set.

`apiKeyEnv` and `baseUrlEnv` must not contain raw secret values.

## Commercial Boundary

WildArrange core must remain original code. External workflow projects may inform concepts, node names, and quality gates, but commercial builds must not ship copied source, copied prompt text, or tool implementations from licenses that restrict commercial redistribution.

Adapter-specific behavior belongs in `src/helix-adapters.mjs` or host-specific generated files. Core workflow, gates, ledger, and provider logic must run without Codex/Cursor private hooks.

## Known Architecture Debt

`src/helix-core.mjs` is now a compatibility barrel. New implementation should go into the focused modules above rather than growing `helix-core.mjs`.

## Maintenance Rules

- Keep `src/helix-core.mjs` as a compatibility export surface only.
- Add implementation to the focused module that owns the behavior; create a new `src/helix-*.mjs` module when no current owner fits.
- Keep source files under 1000 lines by default. At 700+ lines, review whether the file has more than one domain responsibility.
- Runtime modules should import concrete owner modules directly, not route internal dependencies through `src/helix-core.mjs`.
- Any new runtime module must be listed in this architecture map and in `CLAUDE.md`.
- Preserve gate invariants: verifier, scope, review, and success criteria must remain mandatory for completion.
