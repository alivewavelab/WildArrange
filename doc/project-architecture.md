# WildArrange Project Architecture

> Reusable five-zone rules: [five-zone-decoupling-guidelines.md](./five-zone-decoupling-guidelines.md). Refactor history and handoff notes: [2026-07-21-five-zone-refactor-handoff.md](./2026-07-21-five-zone-refactor-handoff.md).

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

## Agent and Skill Model

WildArrange has exactly five long-lived Agents: Jiuwei (orchestration and linear delivery), DiJiang (planning), ZhuRong (implementation), BaiZe (independent review), and LuWu (read-only repository stewardship). The manifest, root config, and deterministic route result enforce this machine-level whitelist. Router is the only system node and is not a sixth Agent. CangJie is an optional internal ArchivistRouter/semantic-shadow profile and cannot enter the long-lived manifest or deterministic route. Product intent, user journey, acceptance design, UX review, scope tradeoff, domain research, code inspection, external research, risk review, and skeptical acceptance are Skills mounted onto those long-lived roles.

## Git-Only Multi-Device Coordination

Cross-device state is coordinated through the existing Git remote rather than a central service. `.helix/` stays local; the shared durable facts are immutable coordination commits on `wildarrange/task/<planId>/<taskId>`.

```text
device identity
  -> unique remote claim commit
  -> one writable owner + isolated worktree
  -> handoff offer commit + non-force push
  -> target-device UUID accept commit
  -> admission fetches expected remote integration SHA
  -> ownership + local-base + remote-SHA revalidation
  -> acceptance proof
  -> integration commit + non-force push
  -> durable checkpoint
```

`gitCoordination.mode` selects `off`, `manual`, `guarded` (default), or `strict`. `guarded` activates remote ownership and worktree isolation when a remote exists and reports a local fallback otherwise. `strict` makes Git, the remote, worktree isolation, clean handoff, and pre-handoff verification mandatory. No enabled profile can permit two write owners, force push, clock-based automatic takeover, unpushed cross-device handoff, or checkpoint after a stale integration SHA.

Coordination commits are built with `git commit-tree`. Handoff preparation uses a temporary index containing both working-tree changes and local committed changes not yet present on the remote task branch, limited to paths admitted by `writable_paths`; `.helix/` is always excluded and the developer's current index is untouched. The prepared tree SHA is persisted and recomputed immediately before push, so edits between `prepare` and `push` require a fresh prepare. Packets are base64url JSON with a SHA-256 digest in commit trailers; accepting devices verify the digest, target device UUID, current remote HEAD, and clean working tree before publishing a normal fast-forward acceptance commit. Push, accept, and takeover retries recognize their own already-published packet and backfill local task/audit state.

Parallel admission captures and fetches the remote integration SHA before applying a child result. Before gates and again before completion it rechecks task ownership, verifies that the guarded SHA is an ancestor of the current workspace, confirms that the remote integration branch has not moved, and rejects candidate paths not attributed to the child result or accepted handoff. After gates and acceptance proof pass, it creates a temporary-index integration commit whose parent is the guarded remote SHA and pushes it without force. Only then may the local checkpoint complete. A remote movement, stale local base, or unattributed dirty path rolls back only this run's files with `revalidation_required`. Once an integration push is known to have succeeded, any later local failure, ownership change, descendant main commit, or abnormal history leaves the claim and intent in `recovery_required`; rollback and ownership release are forbidden.

## Five-Zone Layering

| Zone | Directory | Owns | Allowed to depend on |
| --- | --- | --- | --- |
| Interface | `src/interface/` | Dashboard HTTP API, Codex/Cursor/Kimi adapter install, `doctor` health report — anything a human or host IDE talks to directly | `orchestration`, `infra` |
| Orchestration | `src/orchestration/` | Task/plan state, linear + parallel runtime loops, the shared `delivery-pipeline`, task board, change governance, status/attention report | `ai` (pinned edge list only), `capabilities` (gateway only), `infra` |
| AI | `src/ai/` | Routing, ArchivistRouter, prompt injection, skill matcher, agent context builder, host lifecycle hooks | `orchestration` (read-only), `capabilities` (gateway only), `infra` |
| Capabilities | `src/capabilities/` | The atomic gates themselves (verify, scope-guard, worker, review-gate, code-intel, repository-governance, acceptance-proof, checkpoint) plus `gateway.mjs`, the single seam every caller above must go through | `infra` |
| Infra | `src/infra/` | Foundation (paths/JSON/locks/config/snapshots), ledger, security, command-runner/safety, git diff/worktree, rule scanner, LLM provider, memory digest, path matching, success criteria, task predicates | nothing above it |

Seven invariants beyond simple layering, all checked by `test/dependency-boundary.test.mjs`:

1. **Gateway-only capability access.** Neither `orchestration/` nor `ai/` may `import` a capability implementation file (e.g. `capabilities/verify.mjs`) directly — they must call `invokeCapability(name, ctx)` from `capabilities/gateway.mjs`. Every gate outcome is reported through the same seven-field envelope (`capability`, `status`, `evidence`, `sideEffect`, `duration_ms`, `cost`, `error`). Adding a new *callable capability* touches only the implementation file plus one gateway registration line; adding a new *mandatory quality gate* additionally requires inserting it into the step sequence in `orchestration/delivery-pipeline.mjs` — but only there: the linear loop, parallel admission, and the single-step node workflow all follow the pipeline's definition.
2. **One-way `ai` <-> `capabilities`.** `ai/` may call into `capabilities/` (through the gateway) because hooks and context builders need to ask "is this path in scope" the same way orchestration does. `capabilities/` must never import anything from `ai/` — that direction is permanently blocked.
3. **Pinned `orchestration -> ai` edge list.** Because `ai -> orchestration` is also allowed, coupling between these two zones is kept in check by naming every `orchestration -> ai` edge explicitly in the test (currently only `linear-runtime.mjs -> ai/routing.mjs` for the workflow "route" node). Deterministic route-table reading lives in `infra/route-table.mjs`, so plan import and the task board do not touch the ai zone at all.
4. **No zoned file may import a legacy `src/helix-*.mjs` shim** (including `helix-core.mjs`). Shims re-export zoned files, so allowing them as import targets would be a laundering channel around the zone rules. Shims exist only for external/old callers.
5. **No module-level import cycles anywhere in `src/`**, guarding against a real cycle quietly forming inside the mutually-allowed `ai`/`orchestration` pair.
6. **No non-literal dynamic imports anywhere in `src/`**: the entire argument of every dynamic `import()` must be a single plain string literal. Variables, template literals, and concatenation expressions like `import("../x.mjs" + "")` are all invisible to static import scanning and could smuggle a reverse-zone dependency at runtime, so they are rejected outright.
7. **Legacy shims stay declarative.** Legacy `src/helix-*.mjs` files (including `helix-core.mjs`) are exempt from the zone rules during migration, which would otherwise let business logic quietly move back into a shim and bypass every boundary — so a dedicated subtest asserts that these files contain nothing but export/import declarations.

The scanner itself is hardened against legal-source evasion: a lexical state machine produces a masked view of every source file — comments blanked, string/template/regex literal contents replaced with sentinel bytes (delimiters kept, `${}` interpolations still code) — and import syntax is only matched on that masked view, so neither a comment marker inside a string nor an import statement quoted inside documentation text can mislead the edge builder (false negatives AND false positives). Specifier text is sliced from the original source and unescape-decoded before zone classification, so `"\u002e./ai/x.mjs"` counts as the relative path it really is; a companion subtest additionally restricts all specifiers in `src/` to relative paths, bare package names, and `node:` builtins — `file:`/`data:` URLs and absolute paths (which load real modules while looking opaque to static scanning) are rejected outright. The adversarial samples are pinned by regression subtests in the same file.

## Progressive Governance Loading

Project rules use nested `AGENTS.md` files so an Agent receives the global invariants first and the local working rules only when it enters a relevant directory.

```text
AGENTS.md                         # product goals, global boundaries, release gates
  bin/AGENTS.md                   # CLI-only rules
  doc/AGENTS.md                   # documentation hierarchy and parity
  packs/wildarrange-linear/AGENTS.md
  src/AGENTS.md                   # five-zone routing and shared source invariants
    interface/AGENTS.md
    orchestration/AGENTS.md
    ai/AGENTS.md
    capabilities/AGENTS.md
    infra/AGENTS.md
  test/AGENTS.md                  # test evidence and anti-weakening rules
```

Nested files are additive. They may narrow a directory's responsibilities and prescribe local evidence, but they cannot relax root-level dependency, gate, safety, testing, or commercial-release constraints. This keeps the root constitution stable while moving implementation-specific guidance next to the code it governs.

## Main Files

- `bin/helix.mjs`: CLI routing.
- `src/helix-core.mjs`: compatibility export surface for existing CLI/tests/imports; re-exports every zoned module below and must not grow new implementation.
- `src/infra/foundation.mjs`: shared constants, runtime initialization, config, locks, prompt-pack registry, snapshots, and resume context basics. The task-state lock (`.helix/team/tasks.lock`) is one global file lock: every `withTaskStateLock` caller serializes on it, which is what gives the linear run and parallel admission workspace-level mutual exclusion. Stale-lock recovery is self-healing: a lock owned by a dead pid is stale immediately (no fixed age wait), and an empty/unparseable lock (owner line never written because the acquiring process died between creating the file and writing it) goes stale after a short mtime grace instead of blocking forever.
- `src/infra/ledger.mjs`: hash-chained ledger append, ledger verification, and verified-entry reads. Once the hash chain has started, unhashed appended lines are reported as tampering, and `doctor` only accepts chain-verified entries as completion evidence.
- `src/interface/adapters.mjs`: Codex/Cursor/Kimi adapter install, uninstall, restore, report, backup logic, Codex `.codex/hooks.json` generation, Cursor soft-rule generation, Kimi plugin generation, and shared command Skill generation.
- `src/interface/kimi-adapter.mjs`: pure rendering for the Kimi plugin manifest, project-aware Hook bridge, and Kimi install/readme instructions. Kimi-specific protocol translation stays here instead of entering the workflow core.
- `src/orchestration/change-governance.mjs`: steering proposals, review blockers, ChangeRequest review, and explicit accept/reject resolution.
- `src/infra/failure-analysis.mjs`: failure reason classification, retry hints, and actionable failure summaries.
- `src/capabilities/acceptance-proof.mjs`: checkpoint proof chain that verifies worker, verifier, success criteria, scope, review, and review lanes before completion; also rejects no-op tasks whose worker and verify commands are all trivial with no writable paths.
- `src/ai/routing.mjs`: the full `routeRequest` flow (route request persistence, semantic shadow governance, optional LLM second opinion); re-exports the deterministic table helpers for compatibility.
- `src/infra/route-table.mjs`: deterministic route-table loading (routes.json + reviewed overrides) and signal matching (`loadRoutesConfig` / `resolveRouteDecision`), no LLM involved — usable from orchestration without touching the ai zone.
- `src/ai/archivist-router.mjs`: DeepSeek flash based archivist/router runtime, routing packet construction, deterministic fallback, hook-triggered archive updates, context injection packs, and keyword suggestion artifacts.
- `src/infra/memory-digest.mjs`: structured session/task/checkpoint digest generation for cross-session recovery.
- `src/infra/rule-scanner.mjs`: project rule scanning and rule-context generation from AGENTS/CLAUDE/Cursor-style files, including the nearest nested `AGENTS.md` files on each target path.
- `src/capabilities/worker.mjs` / `src/capabilities/review-gate.mjs`: worker execution and BaiZe independent review lanes. Risk review and skeptical acceptance are BaiZe Skill modes rather than separate long-lived Agents.
- `src/infra/command-safety.mjs`: high-risk shell command preflight shared by worker, verifier, review commands, quality gates, and child-agent runners; blocks destructive system commands and recursive deletion of project source/test/doc directories. Built-in patterns are an immutable floor; `commandSafety.extraPatterns` in config adds project-specific blocks (`compileCommandSafetyPatterns` compiles them and callers thread them via `runCommand` options).
- `src/infra/security.mjs`: config hash baselines, config verification, runtime state backup, backup listing, one-command state restore, and critical state verification.
- `src/interface/doctor.mjs`: consistency doctor that audits config structure/mounts, reconciles completed tasks against checkpoints/acceptance proofs/ledger events, verifies the ledger hash chain, cross-checks the ledger against the latest backup, and surfaces the latest repository-governance status. It also checks the reverse direction: orphan completion events (a not-completed task that already has a chain-verified completion ledger event — an interrupted completion transaction, reported with a `helix run` recovery hint), post-completion side-effect failures (`completion_side_effect_failed` ledger events for snapshots/summaries that could not be written after the commit), and canonical/derived divergence (plan-mirror JSON or `tasks.md` task statuses disagreeing with the authoritative `team/tasks.json`).
- `src/capabilities/code-intel.mjs`: host-neutral code intelligence gates for LSP/typecheck commands, AST/structure commands, hashline anchors, and comment checking.
- `src/infra/repository-layout.mjs` / `src/capabilities/repository-governance.mjs`: LuWu's read-only repository audit. The deterministic checker covers directory-level `AGENTS.md`, bilingual README command and safety-marker parity, real CLI `--help`, the fixed five-Agent whitelist, prompt-pack registration, naming, file placement policy, and actual comment tokens including JavaScript template expressions; the capability writes JSON/Markdown evidence through the gateway. `--changed-only` scopes checks to changed files and the related structural invariants, with a full-scan fallback only when Git change discovery is unavailable.
- `src/ai/injection.mjs`: injection-point resolution and mounted markdown/skill attachment loading.
- `src/ai/skill-matcher.mjs`: stage/route/agent/keyword skill matching and configurable prompt model variants.
- `src/ai/context.mjs`: agent context, resume snapshots, session lineage, and continuation directives.
- `src/ai/hooks.mjs`: host lifecycle hook handling and pre-tool-use scope guard output (scope checks go through `capabilities/gateway.mjs`, not a direct import).
- `src/orchestration/status.mjs`: workflow summary, status report, dashboard data, attention report (open ChangeRequests, failed tasks, user decisions, plans awaiting approval, child agents awaiting acceptance), and ledger tail reads. The attention report is the source of truth for the generic human-decision push: hooks inject it into the host AI context (SessionStart / UserPromptSubmit / PostCompact / Stop) and instruct the AI to surface pending items to the developer with options — no external IM binding.

Plan approval gate: when `planApproval.required` is true, `importPlan` marks the plan `awaiting_plan_approval` and `runNextTask` refuses to start tasks until `approvePlan` (CLI `plan approve` / slash `/helix-approve`) records approval. Off by default so the linear loop is unaffected unless opted in.
- `src/orchestration/workflow.mjs`: workflow entrypoint, sample plan generation, and plan template copying.
- `src/orchestration/linear-runtime.mjs`: linear task node runtime for execute/verify/scope/review/checkpoint/retry; every gate call goes through `invokeCapability` from `capabilities/gateway.mjs`.
- `src/orchestration/delivery-pipeline.mjs`: the shared verify -> scope -> review -> acceptance-proof -> checkpoint sequence used by the linear runtime and parallel-agent admission (full pipeline) and by the single-step `node checkpoint` workflow (via `runCompletionSegment` + `collectGateEvidenceFromTask`), so there is one place to add/remove/reorder a gate. A failed checkpoint write returns `checkpoint_failed` instead of `completed` — callers put the task back to `pending` with a `checkpoint_write_failed` ledger entry; completion strictly requires a durable checkpoint. Gate evidence is bound to the execution round: every new worker run clears the `last_*` gate fields, and `collectGateEvidenceFromTask` only accepts gate evidence appended after the latest worker entry in the append-only evidence trail, so a round whose checkpoint failed cannot lend its passing evidence to a later, unverified round. The completion transaction is idempotently recoverable: if it is interrupted after the completion ledger event but before the canonical `tasks.json` save, `run` detects the task stuck in `verifying` and adjudicates it with the checkpoint-node logic (fresh all-pass evidence completes idempotently; anything else goes back to `pending`); `in_progress` tasks are deliberately left alone because they may be legitimately claimed, and a `verifying` task holding an `admission_claim` is likewise left to its parallel admission owner (`run` reports `blocked` with a resume hint instead of hijacking the in-flight transaction). Artifacts that a completed task must have (wisdom line, memory digest) are written INSIDE the transaction — after the completion ledger event, before the canonical persist — so their failure keeps the task recoverable instead of completing without them; post-commit conveniences (snapshot, workflow summary) are best-effort via `runPostCompletionSideEffects`, which converts a failure into a `completion_side_effect_failed` ledger event plus a `sideEffectWarnings` entry on the result rather than un-completing the task.
- `src/orchestration/plan-state.mjs`: plan normalization, graph validation, plan import, route enrichment, task-state loading, and plan approval state (`loadPlanApproval` / `approvePlan`).
- `src/orchestration/task-board.mjs`: team-lite tasks, claims, evidence recording, task-state persistence, outbox, and durable message board.
- `src/infra/agent-spawn.mjs`: host-neutral child-agent spawn command rendering for Codex/Cursor/custom command adapters.
- `src/infra/git-worktree.mjs`: Git worktree isolation, patch extraction, patch path parsing, patch admission helpers, and pre-execute workspace snapshots (`git stash create` based) recorded before every worker run.
- `src/infra/git-coordination.mjs`: argument-array Git primitives for device-safe remote inspection, metadata/checkpoint commits, normal push/fetch, task-branch switching, working/tree-diff inspection, ancestry checks, and integration-SHA guards. It never decides task status.
- `src/orchestration/remote-ownership.mjs`: stable device registration, mode resolution, unique remote claim packets, ownership validation, and coordination status.
- `src/orchestration/handoff.mjs`: UUID-bound `prepare -> push -> accept` and explicit evidence-bearing takeover. It restores the accepted task into local `.helix/` state while the remote commit remains the cross-device authority; push/accept retries reconcile remote state and restore any missing local audit record.
- `src/orchestration/integration.mjs`: the remote-main integration fence and commit transaction used by admission: owner/base/main revalidation, durable integration intent, temporary-index commit creation, ordinary push, and same-run reconciliation.
- `src/orchestration/admission-recovery.mjs`: persistence policy for pre-integration revalidation versus post-integration recovery. It releases ownership only after a safe rollback, and never rolls back or releases a run whose integration is known to have reached remote main.
- `src/orchestration/parallel-runtime.mjs`: command-based child-agent batch runner, run-dir or Git worktree isolation, skipped-run detection, result collection, lifecycle status, explicit close/release/cleanup, team message publication, and agent-run index. With active default `guarded` coordination, writable runs automatically use worktrees and persist one `parallel_run_claim` per task before spawning. Before creating a run, it rejects the read-only long-lived identities DiJiang, BaiZe, and LuWu; only Jiuwei and ZhuRong may enter a command worker as long-lived Agents, while isolated ephemeral command agents remain supported under non-reserved names. Runs are pre-registered in `index.json` (plus a `running` batch JSON) before agents start, and every index read adopts orphan run directories back into the index, so results on disk can never become permanently invisible to `parallel status`. The admission transaction itself lives in `src/orchestration/admission.mjs` and is re-exported here.
- `src/orchestration/admission.mjs`: the parallel-agent admission transaction (claim -> apply -> gates -> acceptance proof -> integration push -> checkpoint, or rollback), gated through the shared `delivery-pipeline`. Admission is claim-first with persisted ownership: status adjudication, the writable-paths precheck, the task claim, and the `parallel_agent_admission_started` ledger event all happen under the task-state lock BEFORE any workspace file is written, and the claim itself is persisted on the task (`admission_claim = { runId, phase }`). The apply and the gates then run under ONE continuous hold of the same global lock — the workspace mutation and the gates that judge it are a single critical section, so two admissions (same or different tasks, overlapping paths or not) and a concurrent linear `run` can never interleave workspace writes with each other's gate runs. Because claim and apply use two lock holds, the transaction re-reads the persisted owner and phase immediately before workspace I/O; a duplicate same-run request holding a stale phase therefore cannot re-apply files or downgrade a lifecycle that another call already completed. Before the first file write the pre-image rollback plan is persisted to `agent-runs/<runId>/<taskId>.rollback-plan.json`, so a crash mid-apply cannot orphan the only copy of the original contents — a reclaim uses that persisted plan as its authority and never replaces it with a snapshot of the already-mutated workspace. Before integration it revalidates the remote task owner, guarded main SHA, and local ancestry; only an all-pass result generates and non-force-pushes an integration commit. On a pre-push rejection the workspace rollback happens FIRST, while the admission still owns the claim. The claim and rollback plan are released only after rollback reports `rolled_back`; if rollback fails, the task stays `verifying`, ownership stays with the same run, and the admission returns `recovery_required`, preventing a successor from entering the dirty workspace. If integration push succeeds but checkpoint writing fails, rollback is deliberately forbidden because remote main already contains the change; the durable integration intent and same-run claim remain until retry reconciliation finishes the checkpoint. A second run trying to admit a claimed task is refused (no two owners for one task), and finalize re-validates that the committing run still holds the claim. Once the files are on disk the claim phase advances to `finalizing`, and a crash anywhere in the finalize segment deliberately keeps the workspace, the claim, rollback plan, and any integration intent — re-admitting the SAME run skips the apply and re-runs/reconciles to completion, while other runs, `helix run`, and the single-step checkpoint are all refused. Resuming a completed task requires a chain-verified completed ledger event for that exact run; a genuine resume only redoes the missing lifecycle release without re-applying files, and anything else is refused outright.
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
- `.helix/reports/doctor.json` / `.helix/reports/doctor.md`: latest `doctor` health report covering config mounts, completion reconciliation, ledger verification, ledger-vs-backup cross-check, and the latest repository-governance summary.
- `.helix/reports/governance/latest.json` / `.helix/reports/governance/latest.md`: LuWu's latest deterministic repository audit evidence.
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

1. `src/infra/route-table.mjs` runs the deterministic hot path from `packs/wildarrange-linear/routes.json`; `src/ai/routing.mjs` layers the LLM/semantic parts on top (`src/helix-routing.mjs` is only a compatibility shim over them).
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
11. If admission fails, file proposals or patches are rolled back before ownership is released. If rollback itself fails, the original run keeps its claim and rollback plan with `recovery_required` until recovery succeeds.
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

The review gate is host-neutral. It runs from the CLI and may include deterministic lanes, configured `review_commands`, configured `standards_commands`, optional LSP/typecheck commands, AST/structure commands, hashline anchor checks, comment checking, and optional OpenAI-compatible LLM review. BaiZe is the only independent review Agent; goal/evidence, bug/risk, and skeptical-acceptance perspectives are selected as review Skills or modes.

## Adapter Model

Codex receives `.codex/hooks.json`. This is the real project-local Codex hook entry and becomes hard enforcement after the project `.codex/` layer and hook definition are trusted through `/hooks`.

WildArrange also writes `.helix/adapters/codex/hooks.json` as an audit copy. Cursor receives `.cursor/rules/wildarrange.mdc`; this is soft governance because Cursor does not expose the same command hook lifecycle here.

Kimi receives a generated plugin under `.helix/adapters/kimi/plugin/`. The project CLI never edits user-level `~/.kimi-code/config.toml`; the developer starts Kimi Code from the project root, explicitly installs the generated plugin through `/plugins install .helix/adapters/kimi/plugin`, and activates it with `/reload`. The relative path avoids Kimi Code 0.27 treating quote characters as literal path characters. Kimi plugin installation is user-scoped, so its Hook bridge first verifies that the event `cwd` contains a real WildArrange runtime marker and exits without creating files in unrelated projects. Kimi's Hook runner is fail-open on hook crashes and timeouts: a healthy `PreToolUse` can deny out-of-scope Write/Edit/Bash calls, but final security and completion remain enforced by the host-neutral delivery pipeline and checkpoint gates.

Adapter install also generates a set of commands so users do not have to open a terminal for common operations. All surfaces render from one shared command set (`helix-config`, `helix-doctor`, `helix-refresh`, `helix-status`, `helix-plan`, `helix-approve`, `helix-run`):

- Cursor: `.cursor/commands/<name>.md` (plain-Markdown slash commands, filename = command name).
- Codex and Kimi: `.agents/skills/<name>/SKILL.md` (shared project Skill directory with `name`/`description` metadata).

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

`src/ai/injection.mjs` treats prompt-like context as tiered material, not one flat blob:

1. Prompt variants stay short and stable. The default `contextBudgets.prompt.maxChars` is 12,000 chars.
2. Markdown mounts are for rules, snapshots, and live state. The default Markdown budget is 12,000 chars, with lighter hook budgets for `pre_tool_use` and `post_tool_use`.
3. Activated Skill mounts are workflow instructions. The default Skill budget is 80,000 chars, with narrower budgets on traffic-light hooks and wider budgets on execute/review hooks.
4. Any over-budget mount must expose `truncated: true`, original chars, loaded chars, and budget chars. Silent truncation is not allowed.

This follows the runtime philosophy that system prompts act like a constitution, Skills act like task manuals, references act like an archive, and hooks act like traffic lights. Long Skills may be acceptable when they are the actual workflow, but they should be activated by stage or route rather than loaded at every session start.

## Provider Model

Default GPT-family agents use `provider: "host"`. That means Codex/Cursor owns model selection, authentication, and model routing. WildArrange does not require `OPENAI_API_KEY` for host-managed Jiuwei, DiJiang, ZhuRong, BaiZe, LuWu, or generic `deep`/`ultrabrain` lanes.

External providers use `type: "openai-compatible"` and are configured with:

- `apiKeyEnv`: environment variable name that stores the API key.
- `baseUrlEnv`: optional environment variable name that overrides the endpoint.
- `defaultBaseUrl`: fallback endpoint when `baseUrlEnv` is not set.

`apiKeyEnv` and `baseUrlEnv` must not contain raw secret values.

## Commercial Boundary

WildArrange core must remain original code. External workflow projects may inform concepts, node names, and quality gates, but commercial builds must not ship copied source, copied prompt text, or tool implementations from licenses that restrict commercial redistribution.

Adapter-specific behavior belongs in `src/interface/adapters.mjs`, `src/interface/kimi-adapter.mjs`, or host-specific generated files. Core workflow, gates, ledger, and provider logic must run without Codex/Cursor/Kimi private hooks.

## Known Architecture Debt

`src/helix-core.mjs` is now a compatibility barrel over the five zoned directories. New implementation should go into the focused zoned modules rather than growing `helix-core.mjs`, and the ~29 flat `src/helix-*.mjs` shim files should shrink toward zero usage over time as callers migrate their imports to the zoned paths directly (the shims themselves must stay declarative re-exports, not grow logic).

## Maintenance Rules

- Keep `src/helix-core.mjs` as a compatibility export surface only.
- Place new implementation in the zone that owns the behavior (`interface`/`orchestration`/`ai`/`capabilities`/`infra`); create a new `src/<zone>/helix-*.mjs` module when no current owner fits.
- Respect the one-way dependency graph in "Five-Zone Layering" above. `orchestration/` and `ai/` must reach `capabilities/` only through `capabilities/gateway.mjs`'s `invokeCapability(name, ctx)`; never import a capability implementation file directly.
- Keep source files under 1000 lines by default. At 700+ lines, review whether the file has more than one domain responsibility.
- Runtime modules should import concrete zoned owner modules directly, not route internal dependencies through `src/helix-core.mjs` or through a flat `src/helix-*.mjs` shim.
- Any new runtime module must be listed in this architecture map and in `CLAUDE.md`/`AGENTS.md`.
- Keep directory-level `AGENTS.md` guidance additive and local. Update the nearest file when a directory responsibility changes; do not duplicate the full root policy into every folder.
- `test/dependency-boundary.test.mjs` runs on every `npm test`; a failing boundary test means the dependency graph was violated, not that the test should be loosened.
- Preserve gate invariants: verifier, scope, review, and success criteria must remain mandatory for completion.
