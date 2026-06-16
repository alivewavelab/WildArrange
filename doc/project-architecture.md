# WildArrange Project Architecture

## Runtime Shape

```text
bin/helix.mjs
  -> src/helix-core.mjs
     -> src/helix-foundation.mjs
     -> src/helix-adapters.mjs
     -> src/helix-change.mjs
     -> src/helix-failure.mjs
     -> src/helix-acceptance-proof.mjs
     -> src/helix-routing.mjs
     -> src/helix-archivist-router.mjs
     -> src/helix-memory-digest.mjs
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
     -> src/helix-agent-spawn.mjs
     -> src/helix-git-worktree.mjs
     -> src/helix-parallel-agents.mjs
     -> src/helix-gates.mjs
  -> src/helix-dashboard.mjs
  -> packs/wildarrange-linear/*
  -> .helix/*
```

## Main Files

- `bin/helix.mjs`: CLI routing.
- `src/helix-core.mjs`: compatibility export surface for existing CLI/tests/imports.
- `src/helix-foundation.mjs`: shared constants, runtime initialization, config, locks, prompt-pack registry, hash-chained ledger, ledger verification, snapshots, and resume context basics.
- `src/helix-adapters.mjs`: Codex/Cursor adapter install, uninstall, restore, report, backup logic, Codex `.codex/hooks.json` generation, and Cursor soft-rule generation.
- `src/helix-change.mjs`: steering proposals, review blockers, ChangeRequest review, and explicit accept/reject resolution.
- `src/helix-failure.mjs`: failure reason classification, retry hints, and actionable failure summaries.
- `src/helix-acceptance-proof.mjs`: checkpoint proof chain that verifies worker, verifier, success criteria, scope, review, and review lanes before completion.
- `src/helix-routing.mjs`: intent/domain/complexity routing, route request persistence, deterministic confidence, and optional semantic shadow routing.
- `src/helix-archivist-router.mjs`: DeepSeek flash based archivist/router runtime, routing packet construction, deterministic fallback, hook-triggered archive updates, context injection packs, and keyword suggestion artifacts.
- `src/helix-memory-digest.mjs`: structured session/task/checkpoint digest generation for cross-session recovery.
- `src/helix-rules.mjs`: project rule scanning and rule-context generation from AGENTS/CLAUDE/Cursor-style files.
- `src/helix-review.mjs`: worker execution and deterministic BaiZe/QiongQi/LuanNiao review lanes.
- `src/helix-code-intel.mjs`: host-neutral code intelligence gates for LSP/typecheck commands, AST/structure commands, hashline anchors, and comment checking.
- `src/helix-injection.mjs`: injection-point resolution and mounted markdown/skill attachment loading.
- `src/helix-skill-matcher.mjs`: stage/route/agent/keyword skill matching and configurable prompt model variants.
- `src/helix-context.mjs`: agent context, resume snapshots, session lineage, and continuation directives.
- `src/helix-hooks.mjs`: host lifecycle hook handling and pre-tool-use scope guard output.
- `src/helix-status.mjs`: workflow summary, status report, dashboard data, and ledger tail reads.
- `src/helix-workflow.mjs`: workflow entrypoint, sample plan generation, and plan template copying.
- `src/helix-node-runtime.mjs`: linear task node runtime for execute/verify/scope/review/checkpoint/retry.
- `src/helix-plan.mjs`: plan normalization, graph validation, plan import, route enrichment, and task-state loading.
- `src/helix-team.mjs`: team-lite tasks, claims, evidence recording, task-state persistence, outbox, and durable message board.
- `src/helix-agent-spawn.mjs`: host-neutral child-agent spawn command rendering for Codex/Cursor/custom command adapters.
- `src/helix-git-worktree.mjs`: Git worktree isolation, patch extraction, patch path parsing, and patch admission helpers.
- `src/helix-parallel-agents.mjs`: command-based child-agent batch runner, run-dir or Git worktree isolation, skipped-run detection, result collection, lifecycle status, explicit close/release/cleanup, team message publication, file/patch admission, and agent-run index.
- `src/helix-gates.mjs`: command execution, verifier, scope guard, path and realpath checks, checkpoints, change requests, review/failure reports, and wisdom ledger.
- `src/helix-dashboard.mjs`: local dashboard HTTP API and HTML UI with POST token, Host, and Origin protections.
- `packs/wildarrange-linear/agents`: role prompts.
- `packs/wildarrange-linear/skills`: skill prompts.
- `packs/wildarrange-linear/tools/tool-contract.json`: tool contract inventory.
- `helix.config.json`: local runtime configuration.

## Runtime State

- `.helix/team/tasks.json`: durable task state.
- `.helix/ledger.jsonl`: hash-chained append-only audit log. `ledger verify` detects ordinary line edits or broken chains.
- `.helix/checkpoints`: checkpoint JSON after all gates pass.
- `.helix/reports`: human-readable reports.
- `.helix/snapshots/context.md`: resume context.
- `.helix/agent-runs`: child-agent task packets, command results, structured result files, and run index.
- `.helix/memory/events.jsonl`: structured memory event stream for routing and stage archive facts.
- `.helix/memory/digests`: structured task/session/post-compact digest artifacts.
- `.helix/memory/last-digest.json`: latest digest for session recovery and context injection.
- `.helix/memory/stage-summaries`: structured summaries for progress, decisions, artifacts, implementation notes, research notes, pitfalls, and open questions.
- `.helix/memory/index.json`: lightweight keyword/domain/artifact index for memory recall.
- `.helix/routing/suggestions`: ArchivistRouter keyword suggestions and user-preference routing notes.
- `.helix/routing/routes-overrides.json`: reviewed keyword patches applied on top of the installed route table.
- `.helix/routing/archivist-trigger-state.json`: Git HEAD and stage-aware prompt-window counters for ArchivistRouter scheduling.
- `.helix/adapters`: generated adapter files, reports, and backups.

## Routing Model

Routing uses a hybrid model:

1. `src/helix-routing.mjs` runs the deterministic hot path from `packs/wildarrange-linear/routes.json`.
2. `routeGovernance.semanticShadow` may ask configured `CangJie` for a semantic second opinion. The deterministic result remains visible, but low-confidence or conflicting execute routes can be downgraded to plan/ask.
3. `ArchivistRouter` uses configured `CangJie` / `deepseek-v4-flash` when provider credentials exist, and falls back to deterministic routing when unavailable.
4. Host hooks trigger ArchivistRouter on `SessionStart`, `UserPromptSubmit`, and `PostCompact`. The hook path is non-blocking: failures become warning facts, not denied prompts.
5. Prompt-count triggers are stage aware: ideate/plan/clarify defaults to 5 turns, normal work defaults to 10 turns, and execute/verify/review defaults to 15 turns with a 20-turn cap.
6. `ArchivistRouter` reads a bounded routing packet and structured memory instead of unlimited raw chat history.
7. Routing packets use conclusions-only capture: keep user intent, visible assistant conclusions, summarized tool results, evidence, progress, decisions, artifacts, implementation conclusions, research notes, pitfalls, and open questions; strip code blocks, diffs, raw command output, and intermediate process text by default.
8. It may produce route decisions, multi-intent segments, structured archive updates, context injection packs, user-preference notes, and keyword patch suggestions.
9. Keyword suggestions are written for review first. Accepted suggestions update `.helix/routing/routes-overrides.json`, not the installed prompt-pack source. High-risk routing areas such as review, Git, permissions, safety, deletion, release, and scope changes require evidence and rationale.

## Parallel Agent Model

The first parallel runtime is intentionally narrow:

1. `parallel run` selects runnable pending tasks or explicit task IDs.
2. Each child receives a task packet under `.helix/agent-runs/<runId>/<taskId>/task.json`.
3. The configured runner command executes inside an isolated run directory, or inside a Git worktree when `--isolation git-worktree` is used.
4. Optional structured output is read from `agent-result.json`.
5. Adapter command templates can be configured under `parallelAgents.spawnAdapters.codex` or `parallelAgents.spawnAdapters.cursor`; they receive `{taskJson}`, `{outputJson}`, `{runDir}`, `{workDir}`, `{taskId}`, and `{agent}`.
6. Results are written to `.helix/agent-runs`, published to the team message board, and appended to the ledger.
7. `parallel admit` accepts structured text file proposals from `agent-result.json.files` or Git worktree patches from `agent-result.json.patch`.
8. Admission rejects paths outside `writable_paths`.
9. Successful child results enter `awaiting_user_acceptance` instead of being treated as closed.
10. Accepted files or patches are applied to the main workspace, then verifier, scope guard, review gate, acceptance proof, and checkpoint run before the task can become `completed`.
11. If admission fails, file proposals or patches are rolled back from the main workspace and the child result stays visible for revision.
12. After admission completes, the child result lifecycle moves to `released`; failed admission keeps it visible for revision.
13. `parallel status` reads `.helix/agent-runs` and summarizes retained child-agent lifecycle states.
14. `parallel close` lets a user release retained child results after human acceptance without deleting evidence.

This supports a narrow but real multi-agent admission loop: child agents can work in isolated directories or Git worktrees, but they still cannot self-certify completion.

## Gate Model

Completion requires:

1. `worker_command` exits 0.
2. `verify_commands` exists and passes.
3. `successCriteria` passes.
4. `scope_guard` returns `pass`.
5. `review_gate` returns `pass`.
6. `acceptance_proof` returns `pass` and writes `.helix/reports/acceptance/<planId>-<taskId>.json`.

`inconclusive` is not completion evidence.

The review gate is host-neutral. It runs from the CLI and may include deterministic lanes, configured `review_commands`, configured `standards_commands`, optional LSP/typecheck commands, AST/structure commands, hashline anchor checks, comment checking, and optional OpenAI-compatible LLM review. The default LLM review contract uses three roles when enabled: BaiZe for goal/evidence verification, LuanNiao for bug/risk review, and QiongQi for skeptical acceptance.

## Adapter Model

Codex receives `.codex/hooks.json`. This is the real project-local Codex hook entry and becomes hard enforcement after the project `.codex/` layer and hook definition are trusted through `/hooks`.

WildArrange also writes `.helix/adapters/codex/hooks.json` as an audit copy. Cursor receives `.cursor/rules/wildarrange.mdc`; this is soft governance because Cursor does not expose the same command hook lifecycle here.

Adapter install and uninstall always back up overwritten or removed files. `adapter restore --backup <backupId>` restores one backup directory to its original project paths.

## Success Criteria Evidence Model

`successCriteria` are independent completion evidence, not a mirror of verifier output. Explicit criteria remain pending until an agent records evidence or the criterion declares `verifierCommandRefs` that point to concrete passing `verify_commands`. Legacy tasks that omit `successCriteria` receive verifier-bound defaults for compatibility, but possible no-op tasks are marked with `governanceWarnings` so a trivial worker plus trivial verifier is visible.

Checkpoint still requires worker success, verifier pass, success criteria pass, scope pass, review pass, and acceptance proof pass.

## Dashboard Security Model

The dashboard remains local-first. Loopback `GET /api/state` can be read without a token for lightweight status checks. Every `POST` endpoint requires `Authorization: Bearer <token>` or `x-helix-token`, including on `127.0.0.1`, because POST endpoints can execute worker commands. The server also validates Host and Origin / Sec-Fetch-Site to reduce DNS rebinding and browser cross-site trigger risk.

## Skill And Prompt Variant Model

The base prompt pack remains the source of truth. `skills match` is an explainable loading hint that scores installed skills by explicit selection, stage boosts, route keyword signals, agent role, category, and request keywords. It does not mutate the route table.

Prompt variants are config-driven appendices. Host-managed GPT-family agents can use Codex/Cursor defaults, while Gemini, Kimi, DeepSeek, and custom providers can add narrow behavioral bias without replacing the original agent prompt.

## Context Budget Model

`src/helix-injection.mjs` treats prompt-like context as tiered material, not one flat blob:

1. Prompt variants stay short and stable. The default `contextBudgets.prompt.maxChars` is 12,000 chars.
2. Markdown mounts are for rules, snapshots, and live state. The default Markdown budget is 12,000 chars, with lighter hook budgets for `pre_tool_use` and `post_tool_use`.
3. Activated Skill mounts are workflow instructions. The default Skill budget is 80,000 chars, with narrower budgets on traffic-light hooks and wider budgets on execute/review hooks.
4. Any over-budget mount must expose `truncated: true`, original chars, loaded chars, and budget chars. Silent truncation is not allowed.

This follows the runtime philosophy that system prompts act like a constitution, Skills act like task manuals, references act like an archive, and hooks act like traffic lights. Long Skills may be acceptable when they are the actual workflow, but they should be activated by stage or route rather than loaded at every session start.

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
