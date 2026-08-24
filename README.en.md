# WildArrange

[简体中文](./README.md) | English

WildArrange is a local governance runtime for Codex, Cursor, and Kimi Code agent workflows. The first release is deliberately small: one recoverable linear loop before multi-agent parallel execution.

## What It Does

WildArrange turns a coding request into a gated workflow:

```text
init -> plan -> execute -> verify -> scope -> review -> acceptance-proof -> checkpoint -> resume
```

The key rule is simple: a worker can claim work is done, but only gates can complete it.

The core runtime is host-neutral. Codex, Cursor, and Kimi adapters improve injection and recovery, but the workflow can run through CLI commands alone.

**New here?** Open [doc/plans/2026-08-04-beginner-handbook.html](./doc/plans/2026-08-04-beginner-handbook.html) (Chinese beginner guide: deploy → insert your requirements at each step → judge every gate; covers Cursor / Codex / Kimi). Full reference: [使用说明书.md](./使用说明书.md).

## Agent Responsibilities

WildArrange keeps five long-lived Agents. The deterministic Router is a system node rather than an Agent, while specialist capabilities are mounted as Skills. Agents provide analysis and execution, while deterministic gates remain authoritative for completion.

| Agent | Responsibility |
|---|---|
| **Jiuwei (Nine-Tailed Fox)** | Lead orchestrator and linear executor; dispatches workers and connects verification, review, checkpoint, recovery, and ChangeRequests. |
| **DiJiang (Di Jiang)** | Converts goals into executable plans, task dependencies, scope, acceptance criteria, and verification commands. |
| **ZhuRong (Zhu Rong)** | Implements code or file changes within `writable_paths`, then returns a DoneClaim and evidence. |
| **BaiZe (Bai Ze)** | The sole independent reviewer; validates goals, evidence, risk, and acceptance without accepting worker self-certification. |
| **LuWu (Lu Wu)** | Read-only repository steward; checks layered `AGENTS.md`, README parity, naming, file placement, and code-comment policy. |

The system Router classifies requests and selects the primary Agent and Skills. `CangJie` remains an optional internal archivist/semantic-routing profile, not a long-lived Agent.

Specialist duties are Skills: `review-product-intent`, `map-user-journey`, `design-acceptance`, `review-ux-interaction`, `review-scope-tradeoff`, and `research-domain-benchmark`. `inspect-codebase` and `research-external-docs` absorb code exploration and external research.

Role prompts live under `packs/wildarrange-linear/agents/`, and Skills live under `packs/wildarrange-linear/skills/`. Prompts, Tools, and Skills are registered statically during development and ship with a release; they are not registered temporarily while a task is running.

## Install, Move Between Devices, and Upgrade

### Requirements

- Node.js 20 or newer.
- The public npm package can be installed without signing in. Only maintainers need npm authentication for `npm publish`.
- Git is required when using Git worktree isolation.

### Try It Without Pinning

For a quick trial in the current project:

```bash
npx @alivewavelab/wildarrange@latest init
npx @alivewavelab/wildarrange@latest adapter install --target all
npx @alivewavelab/wildarrange@latest doctor
```

This resolves the package through `npx` on each invocation. It is useful for evaluation, but it is not the recommended setup for a long-lived team project.

### Project-Local Installation (Recommended)

Pin WildArrange as a project `devDependency`:

```bash
npm install --save-dev @alivewavelab/wildarrange@latest
npx wildarrange init
npx wildarrange adapter install --target all --mode local
npx wildarrange doctor
```

Commit `package.json` and `package-lock.json`. Teammates and CI can then use `npm ci` to install the same version instead of silently following a newer `latest`.

`adapter install` is project-scoped. It generates Codex, Cursor, and Kimi Code integration files for the current project and device. Local runtime outputs such as `.helix/` and `.cursor/` are normally excluded from Git, so regenerate them on each device instead of copying generated files from another machine.

### Install on Another Device

Clone or update the application repository, then run from its root:

```bash
git clone <project-repository>
cd <project-directory>
npm ci
npx wildarrange init
npx wildarrange adapter install --target all --mode local
npx wildarrange doctor
```

If the project already exists, start with `git pull` and `npm ci`.

For Kimi Code, start Kimi Code from the project root and explicitly install the generated plugin on every device:

```text
/plugins install .helix/adapters/kimi/plugin
/reload
```

### Upgrade

Run from the project root:

```bash
npm install --save-dev @alivewavelab/wildarrange@latest
npx wildarrange adapter install --target all --mode local
npx wildarrange doctor
```

Commit the resulting `package.json` and `package-lock.json` changes. Other devices switch to the locked version by pulling the commit and running `npm ci`.

Check the installed and latest published versions:

```bash
npm ls @alivewavelab/wildarrange
npm view @alivewavelab/wildarrange version
```

The Kimi Code plugin is installed at user scope. After upgrading, refresh it so the Hook bridge uses the newly generated files:

```text
/plugins remove wildarrange-adapter
/plugins install .helix/adapters/kimi/plugin
/reload
```

### Runtime State and Device Boundaries

npm and Git synchronize the program and committed configuration, while `.helix/` remains local runtime state on each device. WildArrange uses the existing Git remote as a handoff cabinet by default: one remote write owner per task, with cross-device continuation carried by a checkpoint commit containing a task packet and ledger hash.

Register a stable identity once on every device. The name is descriptive; handoff authorization uses the returned `deviceId`:

```bash
npx wildarrange device register --name macbook
npx wildarrange device status
npx wildarrange coordination status
```

Claim and hand off a task:

```bash
# Source device: copy the target device's UUID into --to-device-id
npx wildarrange coordination claim --task T001 --owner ZhuRong
npx wildarrange handoff prepare --task T001 \
  --to-device-id <target-device-uuid> --to-device-name mac-mini
npx wildarrange handoff push --task T001

# Target device: its deviceId must match the handoff target
npx wildarrange device register --name mac-mini
npx wildarrange handoff accept --plan <planId> --task T001
```

`prepare` includes both working-tree changes and local commits not yet present on the remote task branch, then builds a temporary Git tree containing only project files inside `writable_paths`; `.helix/` is never handed off and the current index is untouched. Before `push`, WildArrange compares the current tree with the prepare-time fingerprint and requires a fresh prepare if editing continued. Push is always non-force and retry-safe through remote-SHA reconciliation and audit backfill. `accept` verifies the remote packet, target device UUID, and clean local tree before taking ownership; a same-name device cannot impersonate the target. After acceptance, execute, verify, scope, review, checkpoint, admission, and the monolithic `run` completion fence all fail closed on the old device.

Takeover is only for a confirmed abandoned owner and requires both the expected device and an evidence-bearing reason:

```bash
npx wildarrange handoff takeover --plan <planId> --task T001 \
  --expected-device-id <old-device-uuid> --reason "source device is offline and writes were manually stopped"
```

WildArrange never expires ownership from a local clock and never force-pushes. Any device may run admission, but it fetches and binds the remote integration-branch SHA before gates start. The current workspace must contain that base and may not carry dirty paths other than the current run result and explicitly attributed handoff paths. Only after all gates and the acceptance proof pass does it create a commit parented by that SHA and push it normally to the remote integration branch. A changed remote head, stale local base, or unattributed workspace change returns `revalidation_required`, safely rolls back this run's files, and writes no checkpoint. Once a remote push is known to have succeeded, later checkpoint/audit failure, main advancement, ownership change, or abnormal remote history can never trigger rollback; the same run must reconcile or remain `recovery_required`.

If a process was forcibly terminated and `parallel status` shows an empty run while a task is still claimed, confirm that the process is gone and run:

```bash
npx wildarrange parallel close --run <runId> --reason "confirmed process terminated"
```

The command scans task state by `runId` and releases a ghost `parallel_run_claim` even when the run has no result entries.

### Git Coordination Strength

Configure the built-in behavior in `helix.config.json`:

```json
{
  "gitCoordination": {
    "mode": "guarded",
    "remote": "origin",
    "integrationBranch": "auto",
    "taskBranchPrefix": "wildarrange/task",
    "requireWorktreeForParallelWrites": true,
    "requireVerificationBeforeHandoff": false,
    "requireCleanHandoff": true,
    "requireTakeoverReason": true
  }
}
```

| Mode | Behavior |
|---|---|
| `off` | Disable Git coordination and keep the original single-device flow. |
| `manual` | Only explicit `coordination` / `handoff` commands use the remote; `parallel run --coordinate` enables it for one run. |
| `guarded` (default) | Automatically claim and use worktrees when a Git remote exists; otherwise continue locally and return a degradation reason. |
| `strict` | Refuse execution unless the Git repository, remote, worktree, and pre-handoff verification are available. |

You may tune automatic activation, local fallback, and pre-handoff verification. In every mode except `off`, these floors cannot be disabled: one writer per task, no force push, pushed-commit handoff, revalidation after remote-main movement, and explicit evidence-bearing takeover.

### Developing This Repository

When maintaining WildArrange itself:

```bash
node ./bin/helix.mjs init
node ./bin/helix.mjs adapter install --target all --mode local
```

## Minimal Workflow

Create `plan.json`:

```json
{
  "title": "Todo app smoke",
  "objective": "Write one verifiable artifact",
  "tasks": [
    {
      "id": "T001",
      "subject": "Write smoke artifact",
      "writable_paths": [".helix/artifacts/smoke.txt"],
      "worker_command": "node -e \"const fs=require('fs'); fs.mkdirSync('.helix/artifacts',{recursive:true}); fs.writeFileSync('.helix/artifacts/smoke.txt','ok\\n')\"",
      "verify_commands": ["node -e \"const fs=require('fs'); if(fs.readFileSync('.helix/artifacts/smoke.txt','utf8').trim()!=='ok') process.exit(1)\""],
      "review_commands": ["node -e \"const fs=require('fs'); if(!fs.readFileSync('.helix/artifacts/smoke.txt','utf8').includes('ok')) process.exit(1)\""]
    }
  ]
}
```

> `review_commands` is required in practice: the acceptance proof refuses to complete a task whose review gate has no independent signal lane (a tautological review proves nothing). An independent signal is any of `review_commands` / `standards_commands` / `review.llm` / an enabled quality gate.

Run it:

```bash
node ./bin/helix.mjs plan --from plan.json
node ./bin/helix.mjs run
node ./bin/helix.mjs status
node ./bin/helix.mjs summary
```

Or run the built-in sample:

```bash
node ./bin/helix.mjs workflow --sample
```

## Important API Contract

`runNextTask` returns a runtime action, not only the stored task status.

When a verifier fails, the task moves back to `pending` for retry, while the returned result can be:

```json
{
  "status": "retry",
  "task": { "status": "pending" }
}
```

This is intentional. `result.status` says what the runtime wants next; `task.status` says where the task is stored on disk.

## Adapters

```bash
node ./bin/helix.mjs adapter install --target all --mode local
node ./bin/helix.mjs adapter uninstall --target all
node ./bin/helix.mjs adapter restore --backup <backupId>
```

Install, uninstall, and restore write reports under `.helix/adapters/`. Existing adapter files are backed up before overwrite or removal. `restore` copies files from `.helix/adapters/backups/<backupId>/` back to their original paths.

- **Codex**: lifecycle hooks are written to `.codex/hooks.json`, with an audit copy at `.helix/adapters/codex/hooks.json`. Codex runs these hard hooks only after the trusted project layer and the hook definition are reviewed/trusted through `/hooks`.
- **Cursor**: project hooks at `.cursor/hooks.json` (with the `.cursor/hooks/wildarrange-hook-bridge.mjs` bridge) load automatically in a trusted workspace; `preToolUse` (Write/Delete/Edit/Shell) and `beforeShellExecution` (integrated terminal commands) can hard-deny and are fail-closed. `.cursor/rules/wildarrange.mdc` remains as the soft rule layer.
- **Kimi Code**: a project-specific plugin is generated under `.helix/adapters/kimi/plugin/`, while project instructions and Skills reuse `AGENTS.md` and `.agents/skills/`. WildArrange never silently edits the user-level `~/.kimi-code/config.toml`; start Kimi Code from the project root, run `/plugins install .helix/adapters/kimi/plugin`, then run `/reload`. Do not quote the path because Kimi Code 0.27 treats quote characters as part of the path. Although plugin installation is user-scoped, its bridge exits silently outside WildArrange projects.

For Codex, `SessionStart` automatically injects the complete Jiuwei identity prompt, and `PostCompact` injects it again to restore identity after context compaction. Ordinary `UserPromptSubmit` events do not repeat the prompt. The prompt comes from the installed, hash-verified Prompt Pack, respects `contextBudgets.prompt.maxChars`, and reports truncation explicitly.

`adapter install` also generates shortcuts so you don't have to open a terminal for common operations. All three surfaces render from one shared command set (`helix-config` / `helix-doctor` / `helix-refresh` / `helix-status` / `helix-plan` / `helix-approve` / `helix-run`):

- **Cursor**: `.cursor/commands/<name>.md` (plain-Markdown slash commands; type `/helix-doctor` in chat).
- **Codex / Kimi Code**: shared `.agents/skills/<name>/SKILL.md` project Skills. Codex can invoke them through `/skills` or `$helix-doctor`; Kimi Code discovers and invokes them through its project Skill mechanism.

Each command is a prompt that tells the agent to run the matching `helix.mjs` subcommand and report back — a shortcut that lets the agent run the CLI, not a native button.

A healthy Kimi Hook can deny out-of-scope Write/Edit calls and clearly destructive Bash commands. Kimi's Hook runner is fail-open on hook crashes and timeouts, so this is an early warning layer rather than the final security boundary. Verifier, scope, review, success criteria, acceptance proof, and checkpoint gates remain authoritative.

## Minimal Multi-Agent Loop

Command-based child agents can run concurrently. In default `guarded` mode with a configured remote, writable agents automatically receive independent Git worktrees. Without a remote, or in `manual/off`, `parallelAgents.isolation` remains in control:

```bash
node ./bin/helix.mjs parallel run --max-agents 2 --task T001,T002 --agent ZhuRong --command "..."
node ./bin/helix.mjs parallel run --task T001 --agent ZhuRong --adapter codex
node ./bin/helix.mjs parallel list
node ./bin/helix.mjs parallel status --run <runId>
node ./bin/helix.mjs parallel cleanup --run <runId>
```

To propose mainline artifacts, a child agent writes structured files to `agent-result.json`:

```json
{
  "summary": "artifact ready",
  "files": [
    { "path": "src/example.txt", "content": "ok\n" }
  ]
}
```

Admission does not trust the child agent directly. `parallel admit` checks `writable_paths`, then runs verifier, scope guard, review gate, acceptance proof, and checkpoint:

```bash
node ./bin/helix.mjs parallel admit --run <runId> --task T001
```

Successful child results remain `awaiting_user_acceptance` until admission/checkpoint releases them. After human acceptance, close retained results explicitly:

```bash
node ./bin/helix.mjs parallel close --run <runId> --task T001 --reason user_accepted
```

You may also request worktree isolation explicitly. WildArrange extracts the patch and still runs `writable_paths` plus the full admission gates:

```bash
node ./bin/helix.mjs parallel run --task T001 --isolation git-worktree --command "..."
node ./bin/helix.mjs parallel admit --run <runId> --task T001
```

## Defensive Checks

```bash
node ./bin/helix.mjs config baseline --reason reviewed
node ./bin/helix.mjs config verify
node ./bin/helix.mjs state backup --reason before-risky-agent
node ./bin/helix.mjs state verify
node ./bin/helix.mjs state list
node ./bin/helix.mjs state restore --backup <backupId>
node ./bin/helix.mjs doctor
node ./bin/helix.mjs governance audit
node ./bin/helix.mjs impact src/infra/ledger.mjs
node ./bin/helix.mjs decisions --limit 20
node ./bin/helix.mjs decisions stats
node ./bin/helix.mjs timeline --limit 30
node ./bin/helix.mjs annotate --decision <decisionId> --category rule_wrong --reason "..."
node ./bin/helix.mjs annotate stats
node ./bin/helix.mjs test --zone infra
node ./bin/helix.mjs docs commands --write
node ./bin/helix.mjs review suspicious
```

`doctor` is a one-command health check: it validates config structure and mounts, reconciles completed tasks against checkpoints, acceptance proofs, and ledger events, verifies the ledger hash chain, and cross-checks the ledger against the latest backup to detect wholesale rewrites; the `decisionHealth` section adds a periodic health summary (per-gate trigger counts, never-fired gates, corrupt-line and orphan-annotation warnings). The checks are isolated — a crashed check only marks its own section — and doctor is read-only diagnostics that never appends to the ledger. `state restore` automatically takes a pre-restore backup first, so a bad restore can itself be undone.

`impact` is change impact analysis: it lists which files import a changed file directly or transitively, plus the tests that should run (always including the five-zone boundary test), so an AI edit can machine-prove "nothing else was touched".

`decisions` is the decision projection: every allow/deny across the four seams — the delivery-pipeline gates, PreToolUse/PostToolUse interception, admission, and routing — is appended to `.helix/decisions.jsonl` (a derived, droppable, truncatable log outside the hash chain). The command renders each record as three lines — what happened, which rule fired, where the evidence lives — so humans and asynchronous review agents can audit every decision. Supports `--task` / `--gate` filters and `--format json`. The reader streams backwards from the file tail, so `--limit` bounds real memory usage; after long runs you can simply `truncate -s 0 .helix/decisions.jsonl` (truncate to zero, not to a half line — even then the writer self-heals with a newline and the reader skips the bad line).

`test` is zoned test selection: `--zone <zone>` runs the tests that import the zone plus naming-paired tests plus the always-on boundary test; with file arguments it runs the impact-derived list; with no arguments it runs everything. The exit code passes through from `node --test`, so you run exactly what your change touches without memorizing the test matrix.

`annotate` is the annotation feedback loop: decisions can be marked with `annotate --decision <id> --category confirmed|rule_wrong|case_wrong|mislabeled` as confirmed, rule error, case error, or mislabeled. The reason is optional; `annotate stats` aggregates by rule × category so a single annotation never hijacks a rule. **Annotations can never move gates** — the annotation path never writes config, `verify_commands`, or any gate switch (pinned by tests); only a human editing config moves a gate.

`decisions stats` is the deterministic statistical review (pure code, re-runnable, no LLM): per-gate trigger counts broken down by decision and rule code, the **never-fired gates** (the most direct signal that a gate exists only on paper), and annotation joins. Cold-start outputs counts, never rates. `timeline` merges the ledger (hash-chain-verified entries only), decisions, and annotations into one reverse-chronological feed answering "what happened in this repo recently", with `--task` / `--source` filters.

The CLI is layered: `--help` shows only the core six commands (init / plan / run / status / decisions / doctor) covering the daily loop; the full list lives behind `--help --all`. The single source of truth for the command inventory is the registry in `src/interface/cli-help.mjs`, materialized to `doc/generated/commands.md` via `docs commands --write`; the README command-truthfulness check compares against the full `--help --all` output.

`review suspicious` is the LLM suspicion pass (asynchronous audit, archivist invariants): it sends only a sanitized conclusion packet (ids/gates/rule codes/summaries — never code blocks, raw diffs, or full command output) to the configured external provider, and any returned suspicion must anchor to a decisionId present in the packet (hallucinated ids are dropped and counted). Without a key it falls back deterministically and never blocks. Conclusions land only in `.helix/reports/suspicion.*` — **never in the completion chain, never in config, never on a gate switch**.

The dashboard (`serve`) includes a route review console, decision panel, and ops panel. The route console groups the original request, structured route result, matched signals, semantic second opinion, and subsequent tool summaries by session and date. Reviewers can mark a route confirmed, rule-wrong, or case-wrong; common secret fields in tool inputs are redacted. The IDE `Stop` hook actively refreshes a human-readable daily report at `.helix/reports/routing/latest.md` (also archived as `YYYY-MM-DD.md`), with the conclusion first and full decision/tool details below. Reviews only append annotations and never edit `routes.json` automatically.

The end-of-run gate summary is leveled by `reporting.verbosity`: the default `verbose` prints the per-gate three-line projection to stderr after each `run` (so every gate decision can be judged while the framework is new); once trust builds, set `normal` (one line) or `quiet` (JSON only). The machine-readable stdout JSON never changes across levels.

After an interrupted parallel run, `parallel status --run <runId>` shows `batchStatus` and `incompleteTasks` (claimed tasks with no passing result); `parallel retry --run <runId>` re-runs only the tasks that never passed (reusing the recorded command, overridable with `--command`), skipping tasks already passed, completed, or claimed by another run — the retry is a new run and never rewrites the original run's evidence.

Every `status` output carries a persistent `gateArming` yellow lamp: under default configs (all quality gates off, no independent review signal) it reports "gates not armed" with remediation guidance, so an all-green gate stream that proves nothing cannot be mistaken for a healthy project. The acceptance proof enforces two hard floors: it refuses tasks whose `verify_commands` are all trivial (e.g. `true`), and it refuses tasks whose review gate has no independent signal lane (no `review_commands` / `standards_commands` / `review.llm` / enabled quality gate) — a tautological review proves nothing and must not reach completed. `config init --armed` writes a config with armed quality gates (blocking commentChecker + an lspDiagnostics command slot). `doctor` carries dedicated `gateArming` and `adapters` sections: unarmed gates, enabled adapters whose hooks are not installed on this machine, and rule files referencing paths that no longer exist all surface in the report.

`governance audit` is LuWu's read-only inspection. It checks directory-level `AGENTS.md`, Chinese/English README command parity, Prompt Pack registration, naming, and actual code comments, then writes evidence under `.helix/reports/governance/`. With `--changed-only`, only changed files and the related ancestor rules, paired docs, and architecture ledgers are inspected; if Git changes cannot be read, the audit safely falls back to a full scan. LuWu never moves, renames, or deletes project files automatically, and the runtime rejects LuWu, DiJiang, or BaiZe from command workers.

Before every worker run in a Git project, WildArrange records a workspace snapshot (`git stash create`); the snapshot hash and restore command are stored in task evidence and the ledger, so broken changes can be recovered with `git stash apply <hash>`.

WildArrange preflights shell commands and blocks clearly destructive commands such as deleting `.git/.helix`, recursively deleting project source/test/doc directories, `git reset --hard`, `git clean -fd`, `sudo`, or `curl | sh`. Normal project commands, verifiers, review commands, and child-agent runners continue to run.

## ArchivistRouter

ArchivistRouter is the archivist plus task-router node. It reads conclusions-only packets and strips code blocks, raw diffs, and full command output.

Manual commands:

```bash
node ./bin/helix.mjs archivist packet --text "build a web TODO app" --stage plan
node ./bin/helix.mjs archivist run --text "build a web TODO app" --stage plan --force
```

When `archivistRouter.enabled` is `true`, `SessionStart`, `UserPromptSubmit`, and `PostCompact` hooks trigger ArchivistRouter automatically. Without a DeepSeek key it falls back to deterministic routing and does not block the main flow.

Cross-session memory is written to `.helix/memory/digests/`. Task completion, parallel admission completion, `SessionStart`, and `PostCompact` emit structured digests used to recover progress, decisions, artifacts, implementation notes, and pitfalls.

Routing suggestions remain review-only until explicitly resolved:

```bash
node ./bin/helix.mjs archivist suggestions list
node ./bin/helix.mjs archivist suggestions resolve --id <id> --decision accept --evidence "..." --rationale "..."
```

## Skills and Prompt Variants

Skill matcher gives an explainable hint for which skills should load at the current stage:

```bash
node ./bin/helix.mjs skills match --text "build a web reminders app" --stage design --agent Jiuwei
```

Skill mounting at injection points is on-demand by default (`skillMatcher.dynamicInjection`). When request text is available, only configured skills that match the request are injected in full; the rest are demoted to on-demand references. `alwaysMount` skills (default `wildarrange-injection-runtime`) are always injected, and `maxSkills` (default 4) caps a single mount. Points without request text (such as `pre_tool_use`) fall back to the static list. Dynamic matching only subtracts; it never injects full text of skills outside the configured list.

### Human decision channel and safety switches

- **Generic push (no external IM binding)**: all pending human decisions — plan awaiting approval, out-of-scope ChangeRequests, failed tasks, child agents awaiting acceptance — are injected into the host AI context by hooks (SessionStart / UserPromptSubmit / PostCompact / Stop), instructing the AI to proactively surface them to the developer with options. `attentionReport` is the source of truth; `status` / dashboard can also pull it.
- **Plan approval gate**: when `planApproval.required=true`, an imported plan enters `awaiting_plan_approval` and `run` refuses to execute until the developer runs `plan approve` (or `/helix-approve` in chat). Off by default.
- **Externalized command safety**: built-in high-risk command patterns are a floor that cannot be disabled; `commandSafety.extraPatterns` lets you add project-specific dangerous-command blocks (`{ id, pattern, flags, reason }`) without code changes.

Prompt variants append model-specific bias without replacing the base agent prompt:

```bash
node ./bin/helix.mjs prompts variant --agent Jiuwei --model gpt-5.5
node ./bin/helix.mjs prompts show --agent Jiuwei --variant gemini
```

## Dashboard

Local dashboard:

```bash
node ./bin/helix.mjs serve --host 127.0.0.1 --port 8765
```

Binding to a non-loopback host requires a token:

```bash
node ./bin/helix.mjs serve --host 0.0.0.0 --port 8765 --token "$HELIX_DASHBOARD_TOKEN"
```

`GET /api/state` remains readable on loopback without a token. Every `POST` write operation requires a token even on `127.0.0.1`, and the server validates Host / Origin headers to prevent browser-triggered local command execution.

API write requests need either:

```text
Authorization: Bearer <token>
```

or:

```text
x-helix-token: <token>
```

## Runtime Files

| Path | Purpose |
|---|---|
| `.helix/team/tasks.json` | Task state |
| `.helix/ledger.jsonl` | Hash-chained append-only event ledger; verify with `node ./bin/helix.mjs ledger verify` |
| `.helix/security/config-baseline.json` | Config hash baseline; verify with `node ./bin/helix.mjs config verify` |
| `.helix/backups/` | Runtime critical-file backups created by `state backup` |
| `.helix/checkpoints/` | Completed task checkpoints |
| `.helix/reports/` | Workflow, review, and failure reports |
| `.helix/reports/acceptance/` | Acceptance proof chain before checkpoint |
| `.helix/snapshots/context.md` | Cross-session resume context |
| `.helix/adapters/` | Adapter configs, reports, backups |
| `.helix/agent-runs/` | Child-agent packets, results, and admission records |
| `.helix/memory/` | ArchivistRouter structured memory |
| `.helix/memory/digests/` | Cross-session recovery digests |
| `.helix/routing/suggestions/` | Route keyword suggestions pending review |

## Configuration

`helix.config.json` configures agents, model providers, dynamic categories, context budgets, and injection points.

Each long-lived agent can also bind project Skills through `skills`. Put a custom Skill at `.agents/skills/<name>/SKILL.md` and list it on the target agent. The Skill stays available at that agent's injection points and is not inherited by other agents. An external agent CLI can be wrapped by such a Skill while the core remains vendor-neutral:

```json
{
  "agents": {
    "Jiuwei": {
      "provider": "host",
      "model": "host-default",
      "skills": ["baize-cli"]
    }
  }
}
```

Binding names may contain letters, numbers, `_`, and `-`. Missing Skills are reported explicitly; traversal names and symlinks that escape the project Skill root are not loaded.

`contextBudgets` separates Prompt, Markdown, and Skill loading. Prompt / Markdown mounts keep shorter defaults, while activated Skills can load up to 80,000 chars by default. Over-budget mounts expose `truncated: true` instead of silently cutting context.

Agents with `"provider": "host"` are delegated to the installed host tool. In Codex, GPT-family model selection is handled by Codex. In Cursor, the default Cursor model is used by the adapter path. WildArrange does not need an OpenAI API key for those host-managed agents.

External providers use OpenAI-compatible HTTP configuration. See `helix.config.example.json` for the full schema. Use `.env.wildarrange.example` as the environment variable template:

```bash
# Copy and fill in real values; never commit secrets
source .env.wildarrange
```

`apiKeyEnv` and `baseUrlEnv` are environment variable names, not secret values. `defaultBaseUrl` is the fallback endpoint when the corresponding env var is unset.

Deterministic gates work without model APIs. When `review.llm.required` is `false`, a missing external key or a host-managed provider produces a warning rather than blocking the workflow.

LSP/typecheck, AST/structure checks, hashline anchors, and comment checks live in the CLI review gate, not in editor-specific hooks:

```json
{
  "qualityGates": {
    "lspDiagnostics": {
      "enabled": true,
      "commands": ["npm run typecheck"]
    },
    "astStructure": {
      "enabled": true,
      "commands": ["ast-grep --pattern 'console.log($A)' --lang ts --json src || true"]
    },
    "hashlineAnchors": {
      "enabled": true,
      "anchors": [
        { "file": "src/app.ts", "line": 12, "sha256": "<hashLine>" }
      ]
    },
    "commentChecker": {
      "enabled": true,
      "blockOnFindings": false
    }
  }
}
```

## Commercial Boundary

WildArrange is an original runtime inspired by agent governance patterns. It must not distribute copied source code, prompt text, or tool implementations from projects whose license blocks commercial redistribution.

Before a commercial release, confirm:

- No restricted third-party source or prompt text is included
- `packs/` contains WildArrange-authored prompts and contracts
- External workflow references remain documentation or conceptual comparison only

## Development

```bash
npm test
npm pack --dry-run --cache /private/tmp/helix-npm-cache
```

Current status: the linear governance loop is implemented and tested; checkpoint writes an acceptance-proof chain first. Optional LLM review, configurable LSP/typecheck diagnostics, AST/structure commands, hashline anchors, and comment checking are available through the CLI review gate. Codex hooks become hard after `/hooks` trust; Cursor `preToolUse` / `beforeShellExecution` are fail-closed in trusted workspaces. Multi-agent support includes command-based parallel runs, Codex/Cursor command-template spawn, structured artifact admission, Git worktree patch admission, and retain-until-acceptance. Host-private background process management remains adapter work.

## More Docs

| Doc | Purpose |
|---|---|
| [README.md](./README.md) | Chinese readme |
| [CLAUDE.md](./CLAUDE.md) | Agent and developer governance rules |
| [doc/concept.md](./doc/concept.md) | Product concept and external reference boundary |
| [doc/project-architecture.md](./doc/project-architecture.md) | Runtime architecture and gate model |
| [doc/five-zone-decoupling-guidelines.md](./doc/five-zone-decoupling-guidelines.md) | Reusable five-zone decoupling and directory-level AGENTS.md guidance |
| [doc/development-plan.md](./doc/development-plan.md) | P0 / P1 / P2 roadmap |
