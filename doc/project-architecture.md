# WildArrange Project Architecture

> Refactor history and handoff notes for the five-zone layout described below: [doc/2026-07-21-five-zone-refactor-handoff.md](./2026-07-21-five-zone-refactor-handoff.md).

## Runtime Shape

The codebase is laid out in five dependency zones. Dependencies only flow downward; `test/dependency-boundary.test.mjs` enforces this on every `npm test` run, so it is not just a diagram.

```text
bin/helix.mjs
  -> src/helix-core.mjs (compatibility barrel, re-exports everything below)
  -> src/interface/*      (dashboard, adapters, doctor — host/human-facing edge)
       -> src/orchestration/*, src/infra/*
  -> src/orchestration/*  (workflow order, retry, gate sequencing)
       -> src/ai/*, src/capabilities/* (via gateway only), src/infra/*
  -> src/ai/*             (routing, injection, skills, hooks, context)
       -> src/orchestration/* (read-only), src/capabilities/* (via gateway only), src/infra/*
  -> src/capabilities/*   (verify, scope-guard, worker, review-gate, checkpoint, acceptance-proof, gateway)
       -> src/infra/*
  -> src/infra/*          (foundation, ledger, security, command-runner/safety, git, rules, llm, memory, ...)
  -> packs/wildarrange-linear/*
  -> .helix/*
```

Every old flat `src/helix-*.mjs` path still exists as a declarative `@deprecated` re-export shim with no business logic — most are a single `export * from "./<zone>/<file>.mjs"`, while modules whose implementation was split across several zoned files (e.g. `helix-gates.mjs`, `helix-review.mjs`) aggregate multiple named re-exports. Existing imports keep working while new code targets the zoned path directly.

## Five-Zone Layering

| Zone | Directory | Owns | Allowed to depend on |
| --- | --- | --- | --- |
| Interface | `src/interface/` | Dashboard HTTP API, Codex/Cursor adapter install, `doctor` health report — anything a human or host IDE talks to directly | `orchestration`, `infra` |
| Orchestration | `src/orchestration/` | Task/plan state, linear + parallel runtime loops, the shared `delivery-pipeline`, task board, change governance, status/attention report | `ai` (pinned edge list only), `capabilities` (gateway only), `infra` |
| AI | `src/ai/` | Routing, ArchivistRouter, prompt injection, skill matcher, agent context builder, host lifecycle hooks | `orchestration` (read-only), `capabilities` (gateway only), `infra` |
| Capabilities | `src/capabilities/` | The atomic gates themselves (verify, scope-guard, worker, review-gate, code-intel, acceptance-proof, checkpoint) plus `gateway.mjs`, the single seam every caller above must go through | `infra` |
| Infra | `src/infra/` | Foundation (paths/JSON/locks/config/snapshots), ledger, security, command-runner/safety, git diff/worktree, rule scanner, LLM provider, memory digest, path matching, success criteria, task predicates | nothing above it |

Six invariants beyond simple layering, all checked by `test/dependency-boundary.test.mjs`:

1. **Gateway-only capability access.** Neither `orchestration/` nor `ai/` may `import` a capability implementation file (e.g. `capabilities/verify.mjs`) directly — they must call `invokeCapability(name, ctx)` from `capabilities/gateway.mjs`. Every gate outcome is reported through the same seven-field envelope (`capability`, `status`, `evidence`, `sideEffect`, `duration_ms`, `cost`, `error`). Adding a new *callable capability* touches only the implementation file plus one gateway registration line; adding a new *mandatory quality gate* additionally requires inserting it into the step sequence in `orchestration/delivery-pipeline.mjs` — but only there: the linear loop, parallel admission, and the single-step node workflow all follow the pipeline's definition.
2. **One-way `ai` <-> `capabilities`.** `ai/` may call into `capabilities/` (through the gateway) because hooks and context builders need to ask "is this path in scope" the same way orchestration does. `capabilities/` must never import anything from `ai/` — that direction is permanently blocked.
3. **Pinned `orchestration -> ai` edge list.** Because `ai -> orchestration` is also allowed, coupling between these two zones is kept in check by naming every `orchestration -> ai` edge explicitly in the test (currently only `linear-runtime.mjs -> ai/routing.mjs` for the workflow "route" node). Deterministic route-table reading lives in `infra/route-table.mjs`, so plan import and the task board do not touch the ai zone at all.
4. **No zoned file may import a legacy `src/helix-*.mjs` shim** (including `helix-core.mjs`). Shims re-export zoned files, so allowing them as import targets would be a laundering channel around the zone rules. Shims exist only for external/old callers.
5. **No module-level import cycles anywhere in `src/`**, guarding against a real cycle quietly forming inside the mutually-allowed `ai`/`orchestration` pair.
6. **No non-literal dynamic imports anywhere in `src/`**: the entire argument of every dynamic `import()` must be a single plain string literal. Variables, template literals, and concatenation expressions like `import("../x.mjs" + "")` are all invisible to static import scanning and could smuggle a reverse-zone dependency at runtime, so they are rejected outright.

The scanner itself is hardened against legal-source evasion: comment stripping is done by a lexical state machine (not a regex) that distinguishes real comments from `/*` / `*/` markers inside string literals, template literals, and regex literals, so an import cannot be hidden inside a span that a naive stripper would blank out. The adversarial samples are pinned by a regression subtest in the same file.

## Main Files

- `bin/helix.mjs`: CLI routing.
- `src/helix-core.mjs`: compatibility export surface for existing CLI/tests/imports; re-exports every zoned module below and must not grow new implementation.
- `src/infra/foundation.mjs`: shared constants, runtime initialization, config, locks, prompt-pack registry, snapshots, and resume context basics.
- `src/infra/ledger.mjs`: hash-chained ledger append, ledger verification, and verified-entry reads. Once the hash chain has started, unhashed appended lines are reported as tampering, and `doctor` only accepts chain-verified entries as completion evidence.
- `src/interface/adapters.mjs`: Codex/Cursor adapter install, uninstall, restore, report, backup logic, Codex `.codex/hooks.json` generation, Cursor soft-rule generation, and shared slash-command generation (Cursor `.cursor/commands/*.md`, Codex `.agents/skills/*/SKILL.md`).
- `src/orchestration/change-governance.mjs`: steering proposals, review blockers, ChangeRequest review, and explicit accept/reject resolution.
- `src/infra/failure-analysis.mjs`: failure reason classification, retry hints, and actionable failure summaries.
- `src/capabilities/acceptance-proof.mjs`: checkpoint proof chain that verifies worker, verifier, success criteria, scope, review, and review lanes before completion; also rejects no-op tasks whose worker and verify commands are all trivial with no writable paths.
- `src/ai/routing.mjs`: the full `routeRequest` flow (route request persistence, semantic shadow governance, optional LLM second opinion); re-exports the deterministic table helpers for compatibility.
- `src/infra/route-table.mjs`: deterministic route-table loading (routes.json + reviewed overrides) and signal matching (`loadRoutesConfig` / `resolveRouteDecision`), no LLM involved — usable from orchestration without touching the ai zone.
- `src/ai/archivist-router.mjs`: DeepSeek flash based archivist/router runtime, routing packet construction, deterministic fallback, hook-triggered archive updates, context injection packs, and keyword suggestion artifacts.
- `src/infra/memory-digest.mjs`: structured session/task/checkpoint digest generation for cross-session recovery.
- `src/infra/rule-scanner.mjs`: project rule scanning and rule-context generation from AGENTS/CLAUDE/Cursor-style files.
- `src/capabilities/worker.mjs` / `src/capabilities/review-gate.mjs`: worker execution and deterministic BaiZe/QiongQi/LuanNiao review lanes.
- `src/infra/command-safety.mjs`: high-risk shell command preflight shared by worker, verifier, review commands, quality gates, and child-agent runners; blocks destructive system commands and recursive deletion of project source/test/doc directories. Built-in patterns are an immutable floor; `commandSafety.extraPatterns` in config adds project-specific blocks (`compileCommandSafetyPatterns` compiles them and callers thread them via `runCommand` options).
- `src/infra/security.mjs`: config hash baselines, config verification, runtime state backup, backup listing, one-command state restore, and critical state verification.
- `src/interface/doctor.mjs`: consistency doctor that audits config structure/mounts, reconciles completed tasks against checkpoints/acceptance proofs/ledger events, verifies the ledger hash chain, and cross-checks the ledger against the latest backup to detect rewrites. It also checks the reverse direction: orphan completion events (a not-completed task that already has a chain-verified completion ledger event — an interrupted completion transaction, reported with a `helix run` recovery hint) and canonical/derived divergence (plan-mirror JSON or `tasks.md` task statuses disagreeing with the authoritative `team/tasks.json`).
- `src/capabilities/code-intel.mjs`: host-neutral code intelligence gates for LSP/typecheck commands, AST/structure commands, hashline anchors, and comment checking.
- `src/ai/injection.mjs`: injection-point resolution and mounted markdown/skill attachment loading.
- `src/ai/skill-matcher.mjs`: stage/route/agent/keyword skill matching and configurable prompt model variants.
- `src/ai/context.mjs`: agent context, resume snapshots, session lineage, and continuation directives.
- `src/ai/hooks.mjs`: host lifecycle hook handling and pre-tool-use scope guard output (scope checks go through `capabilities/gateway.mjs`, not a direct import).
- `src/orchestration/status.mjs`: workflow summary, status report, dashboard data, attention report (open ChangeRequests, failed tasks, user decisions, plans awaiting approval, child agents awaiting acceptance), and ledger tail reads. The attention report is the source of truth for the generic human-decision push: hooks inject it into the host AI context (SessionStart / UserPromptSubmit / PostCompact / Stop) and instruct the AI to surface pending items to the developer with options — no external IM binding.

Plan approval gate: when `planApproval.required` is true, `importPlan` marks the plan `awaiting_plan_approval` and `runNextTask` refuses to start tasks until `approvePlan` (CLI `plan approve` / slash `/helix-approve`) records approval. Off by default so the linear loop is unaffected unless opted in.
- `src/orchestration/workflow.mjs`: workflow entrypoint, sample plan generation, and plan template copying.
- `src/orchestration/linear-runtime.mjs`: linear task node runtime for execute/verify/scope/review/checkpoint/retry; every gate call goes through `invokeCapability` from `capabilities/gateway.mjs`.
- `src/orchestration/delivery-pipeline.mjs`: the shared verify -> scope -> review -> acceptance-proof -> checkpoint sequence used by the linear runtime and parallel-agent admission (full pipeline) and by the single-step `node checkpoint` workflow (via `runCompletionSegment` + `collectGateEvidenceFromTask`), so there is one place to add/remove/reorder a gate. A failed checkpoint write returns `checkpoint_failed` instead of `completed` — callers put the task back to `pending` with a `checkpoint_write_failed` ledger entry; completion strictly requires a durable checkpoint. Gate evidence is bound to the execution round: every new worker run clears the `last_*` gate fields, and `collectGateEvidenceFromTask` only accepts gate evidence appended after the latest worker entry in the append-only evidence trail, so a round whose checkpoint failed cannot lend its passing evidence to a later, unverified round. The completion transaction is idempotently recoverable: if it is interrupted after the completion ledger event but before the canonical `tasks.json` save, `run` detects the task stuck in `verifying` and adjudicates it with the checkpoint-node logic (fresh all-pass evidence completes idempotently; anything else goes back to `pending`); `in_progress` tasks are deliberately left alone because they may be legitimately claimed.
- `src/orchestration/plan-state.mjs`: plan normalization, graph validation, plan import, route enrichment, task-state loading, and plan approval state (`loadPlanApproval` / `approvePlan`).
- `src/orchestration/task-board.mjs`: team-lite tasks, claims, evidence recording, task-state persistence, outbox, and durable message board.
- `src/infra/agent-spawn.mjs`: host-neutral child-agent spawn command rendering for Codex/Cursor/custom command adapters.
- `src/infra/git-worktree.mjs`: Git worktree isolation, patch extraction, patch path parsing, patch admission helpers, and pre-execute workspace snapshots (`git stash create` based) recorded before every worker run.
- `src/orchestration/parallel-runtime.mjs`: command-based child-agent batch runner, run-dir or Git worktree isolation, skipped-run detection, result collection, lifecycle status, explicit close/release/cleanup, team message publication, file/patch admission, and agent-run index; admission gating runs through the shared `delivery-pipeline` under the task-state lock. Admission validates the task status BEFORE applying any file to the workspace; a task already completed by this same run (i.e. the lifecycle release was interrupted) is resumed idempotently — only the missing release is redone, no file is re-applied — while a task completed by any other means is refused outright.
- `src/capabilities/gateway.mjs`: static capability registry + unified result envelope (`capability`/`status`/`evidence`/`sideEffect`/`duration_ms`/`cost`/`error`); the only door `orchestration/` and `ai/` may use to reach `capabilities/verify.mjs`, `scope-guard.mjs`, `checkpoint.mjs`, `worker.mjs`, `review-gate.mjs`, `acceptance-proof.mjs`.
- `src/interface/dashboard.mjs`: local dashboard HTTP API and HTML UI with POST token, Host, and Origin protections.
- `packs/wildarrange-linear/agents`: role prompts.
- `packs/wildarrange-linear/skills`: skill prompts.
- `packs/wildarrange-linear/tools/tool-contract.json`: tool contract inventory.
- `helix.config.json`: local runtime configuration.

## Runtime State

- `.helix/team/tasks.json`: durable task state.
- `.helix/ledger.jsonl`: hash-chained append-only audit log. `ledger verify` detects ordinary line edits or broken chains.
- `.helix/security/config-baseline.json`: reviewed config fingerprints. `config verify` detects config files added, removed, or changed after baseline.
- `.helix/backups`: point-in-time copies of ledger, work, tasks, snapshots, and config baseline created by `state backup`; list with `state list`, restore with `state restore --backup <id>` (a pre-restore backup is taken automatically).
- `.helix/reports/doctor.json` / `.helix/reports/doctor.md`: latest `doctor` health report covering config mounts, completion reconciliation, ledger verification, and ledger-vs-backup cross-check.
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

Adapter install also generates a set of slash commands so users do not have to open a terminal for common operations. Both surfaces render from one shared command set (`helix-config`, `helix-doctor`, `helix-refresh`, `helix-status`, `helix-plan`, `helix-run`):

- Cursor: `.cursor/commands/<name>.md` (plain-Markdown slash commands, filename = command name).
- Codex: `.agents/skills/<name>/SKILL.md` (skill directory with `name`/`description` metadata, since custom prompts were removed in Codex 0.117).

Each command is a prompt that instructs the agent to run the matching `helix.mjs` CLI subcommand and report the result; they are shortcuts that let the agent run the CLI, not native buttons.

Adapter install and uninstall always back up overwritten or removed files, including generated slash commands. `adapter restore --backup <backupId>` restores one backup directory to its original project paths.

## Success Criteria Evidence Model

`successCriteria` are independent completion evidence, not a mirror of verifier output. Explicit criteria remain pending until an agent records evidence or the criterion declares `verifierCommandRefs` that point to concrete passing `verify_commands`. Legacy tasks that omit `successCriteria` receive verifier-bound defaults for compatibility, but possible no-op tasks are marked with `governanceWarnings` so a trivial worker plus trivial verifier is visible.

Checkpoint still requires worker success, verifier pass, success criteria pass, scope pass, review pass, and acceptance proof pass.

## Dashboard Security Model

The dashboard remains local-first. Loopback `GET /api/state` can be read without a token for lightweight status checks. Every `POST` endpoint requires `Authorization: Bearer <token>` or `x-helix-token`, including on `127.0.0.1`, because POST endpoints can execute worker commands. The server also validates Host and Origin / Sec-Fetch-Site to reduce DNS rebinding and browser cross-site trigger risk.

## Skill And Prompt Variant Model

The base prompt pack remains the source of truth. `skills match` is an explainable loading hint that scores installed skills by explicit selection, stage boosts, route keyword signals, agent role, category, and request keywords. It does not mutate the route table.

Skill mounting at injection points is on-demand when request text is available (`skillMatcher.dynamicInjection`, enabled by default):

- The static skill list configured on an injection point is the upper bound; dynamic matching only subtracts, it never injects full text of skills outside the configured list.
- `alwaysMount` skills (default: `wildarrange-injection-runtime`) are always mounted; other configured skills are mounted only when the matcher scores them above zero on request-related signals. Agent-identity boosts alone do not qualify, because they are constant per agent and would degenerate into static mounting.
- `maxSkills` (default 4) caps the number of dynamically mounted skills by score.
- Unmounted skills are demoted to on-demand references (name + load command) in the injection output, so the agent can pull them explicitly when needed.
- Without request text (for example `pre_tool_use`), the point falls back to static mounting and reports the reason in `skillSelection`.

Skill mounting at injection points is on-demand when request text is available. `resolveInjectionPoint` accepts an optional `{ text, stage }` context (hooks pass the user prompt or resume next-action; agent context passes the task subject). Dynamic selection is subtractive only: the configured skill list of an injection point is the upper bound, matched skills are mounted with full content, unmatched skills are demoted to path references the agent can load later via `prompts show --skill <name>`, and skills outside the configured list are never injected as full text no matter how the request is phrased. Agent-identity score alone does not count as a match, since it is constant per request. `skillMatcher.dynamicInjection` controls this behavior (`enabled`, `maxSkills` for the dynamic slots, `alwaysMount` for baseline skills such as `wildarrange-injection-runtime`). Without request text, or when disabled, mounting falls back to the static list.

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

Adapter-specific behavior belongs in `src/interface/adapters.mjs` or host-specific generated files. Core workflow, gates, ledger, and provider logic must run without Codex/Cursor private hooks.

## Known Architecture Debt

`src/helix-core.mjs` is now a compatibility barrel over the five zoned directories. New implementation should go into the focused zoned modules rather than growing `helix-core.mjs`, and the ~29 flat `src/helix-*.mjs` shim files should shrink toward zero usage over time as callers migrate their imports to the zoned paths directly (the shims themselves must stay declarative re-exports, not grow logic).

## Maintenance Rules

- Keep `src/helix-core.mjs` as a compatibility export surface only.
- Place new implementation in the zone that owns the behavior (`interface`/`orchestration`/`ai`/`capabilities`/`infra`); create a new `src/<zone>/helix-*.mjs` module when no current owner fits.
- Respect the one-way dependency graph in "Five-Zone Layering" above. `orchestration/` and `ai/` must reach `capabilities/` only through `capabilities/gateway.mjs`'s `invokeCapability(name, ctx)`; never import a capability implementation file directly.
- Keep source files under 1000 lines by default. At 700+ lines, review whether the file has more than one domain responsibility.
- Runtime modules should import concrete zoned owner modules directly, not route internal dependencies through `src/helix-core.mjs` or through a flat `src/helix-*.mjs` shim.
- Any new runtime module must be listed in this architecture map and in `CLAUDE.md`/`AGENTS.md`.
- `test/dependency-boundary.test.mjs` runs on every `npm test`; a failing boundary test means the dependency graph was violated, not that the test should be loosened.
- Preserve gate invariants: verifier, scope, review, and success criteria must remain mandatory for completion.
