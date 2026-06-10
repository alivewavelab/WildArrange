# HelixFlow Project Architecture

## Runtime Shape

```text
bin/helix.mjs
  -> src/helix-core.mjs
     -> src/helix-foundation.mjs
     -> src/helix-adapters.mjs
     -> src/helix-routing.mjs
     -> src/helix-rules.mjs
     -> src/helix-review.mjs
     -> src/helix-plan.mjs
     -> src/helix-team.mjs
     -> src/helix-gates.mjs
  -> src/helix-dashboard.mjs
  -> packs/omo-linear/*
  -> .helix/*
```

## Main Files

- `bin/helix.mjs`: CLI routing.
- `src/helix-core.mjs`: orchestration runtime for task loop, workflow nodes, hooks, context, and change request review.
- `src/helix-foundation.mjs`: shared constants, runtime initialization, config, locks, prompt-pack registry, snapshots, and resume context basics.
- `src/helix-adapters.mjs`: Codex/Cursor adapter install, uninstall, report, and backup logic.
- `src/helix-routing.mjs`: intent/domain/complexity routing and route request persistence.
- `src/helix-rules.mjs`: project rule scanning and rule-context generation from AGENTS/CLAUDE/Cursor/OMO-style files.
- `src/helix-review.mjs`: worker execution and deterministic Oracle/Momus/Metis review lanes.
- `src/helix-plan.mjs`: plan normalization, graph validation, plan import, route enrichment, and task-state loading.
- `src/helix-team.mjs`: team-lite tasks, claims, evidence recording, task-state persistence, outbox, and durable message board.
- `src/helix-gates.mjs`: command execution, verifier, scope guard, path checks, checkpoints, change requests, review/failure reports, and wisdom ledger.
- `src/helix-dashboard.mjs`: local dashboard HTTP API and HTML UI.
- `packs/omo-linear/agents`: role prompts.
- `packs/omo-linear/skills`: skill prompts.
- `packs/omo-linear/tools/tool-contract.json`: tool contract inventory.
- `helix.config.json`: local runtime configuration.

## Runtime State

- `.helix/team/tasks.json`: durable task state.
- `.helix/ledger.jsonl`: append-only audit log.
- `.helix/checkpoints`: checkpoint JSON after all gates pass.
- `.helix/reports`: human-readable reports.
- `.helix/snapshots/context.md`: resume context.
- `.helix/adapters`: generated adapter files, reports, and backups.

## Gate Model

Completion requires:

1. `worker_command` exits 0.
2. `verify_commands` exists and passes.
3. `successCriteria` passes.
4. `scope_guard` returns `pass`.
5. `review_gate` returns `pass`.

`inconclusive` is not completion evidence.

## Adapter Model

Cursor receives `.cursor/rules/helixflow.mdc`.

Codex receives `.helix/adapters/codex/hooks.json`, which mirrors OMO-style lifecycle hooks. Full host-level Codex plugin installation is still future adapter work.

## Known Architecture Debt

`src/helix-core.mjs` is no longer a pure single-file runtime, but it still holds several domains. Before adding deeper LLM providers and LSP gates, continue splitting it into:

- `helix-task.mjs`
- `helix-hooks.mjs`
