# WildArrange

[简体中文](./README.md) | English

WildArrange is a local governance runtime for Codex, Cursor, Kimi Code, and Claude Code agent workflows. The first release is deliberately small: one recoverable linear loop before multi-agent parallel execution.

## What It Does

WildArrange turns a coding request into a gated workflow:

```text
setup -> plan -> execute -> verify -> scope -> review -> acceptance-proof -> checkpoint -> resume
```

The key rule is simple: a worker can claim work is done, but only gates can complete it.

The core runtime is host-neutral. Codex, Cursor, and Kimi adapters improve injection and recovery, but the workflow can run through CLI commands alone.

There are only five design principles: **separate planning from execution → workers never self-certify → independent verification → rework on failure → evidence goes on the record**. All runtime state lives in a local runtime directory outside the project (the `runtimeRoot` printed by `wildarrange project show`; below, `runtime:<path>` names a file inside it); customer projects receive zero writes and nothing is tied to a particular editor. Internals and invariants are in [doc/project-architecture.md](./doc/project-architecture.md).

**New here?** Connect your project with [Install, Move Between Devices, and Upgrade](#install-move-between-devices-and-upgrade), then run your first task with [Minimal Workflow](#minimal-workflow). Full command list: `node ./bin/wildarrange.mjs --help --all` or [doc/generated/commands.md](./doc/generated/commands.md).

## Agent Responsibilities

WildArrange keeps five long-lived Agents. The deterministic Router is a system node rather than an Agent, while specialist capabilities are mounted as Skills. Agents provide analysis and execution, while deterministic gates remain authoritative for completion.

| Agent | Responsibility |
|---|---|
| **Jiuwei (Nine-Tailed Fox)** | Lead orchestrator and linear executor; dispatches workers and connects verification, review, checkpoint, recovery, and ChangeRequests. |
| **DiJiang (Di Jiang)** | Converts goals into executable plans, task dependencies, scope, acceptance criteria, and verification commands. |
| **ZhuRong (Zhu Rong)** | Implements code or file changes within `writable_paths`, then returns a DoneClaim and evidence. |
| **BaiZe (Bai Ze)** | The sole independent reviewer; validates goals, evidence, risk, and acceptance without accepting worker self-certification. |
| **LuWu (Lu Wu)** | Read-only repository steward; checks layered `AGENTS.md`, README parity, naming, file placement, and code-comment policy. |

The system Router classifies requests and selects the primary Agent and Skills.

Specialist duties are Skills: `review-product-intent`, `map-user-journey`, `design-acceptance`, `review-ux-interaction`, `review-scope-tradeoff`, and `research-domain-benchmark`. `inspect-codebase` and `research-external-docs` absorb code exploration and external research.

Role prompts live under `packs/wildarrange-linear/agents/`, and Skills live under `packs/wildarrange-linear/skills/`. Prompts, Tools, and Skills are registered statically during development and ship with a release; they are not registered temporarily while a task is running.

## Install, Move Between Devices, and Upgrade

### Requirements

- Node.js 20 or newer.
- The public npm package can be installed without signing in. Only maintainers need npm authentication for `npm publish`.
- Git is required when using Git worktree isolation.

### Connect a Project: `wildarrange setup` (the only runtime shape)

WildArrange has a single runtime shape, three-root mode: the customer repository owns product code and product tests, a separate governance repository owns policy, `policy/wildarrange.config.json` (the only config file) and the verification registry, and local state owns the ledger, locks, reports, backups, and installed Prompt Pack. WildArrange does not generate `AGENTS.md`, runtime files, or adapter files in the customer project.

Fastest path: from the customer project root, initialize the governance repository, attach it, initialize the runtime, and generate host adapter bundles in one step:

```bash
npx wildarrange setup \
  --governance-root ../my-project-governance \
  --repository https://github.com/example/my-project.git \
  --target all
```

`--repository` defaults to the project's `origin` remote; `--target` is `codex|cursor|kimi|claude|all` (default all). The command ends with the remaining in-host manual steps (Codex/Kimi install and trust, Cursor and Claude Code activation). To go step by step, use the commands below:

```bash
npx wildarrange project init-governance \
  --governance-root ../my-project-governance \
  --repository https://github.com/example/my-project.git \
  --default-branch main
```

This creates only missing files under the governance root: `wildarrange-governance.json`, `policy/AGENTS.md`, `policy/code-and-interface-conventions.md`, `policy/testing-and-acceptance.md` (three policy templates), `policy/wildarrange.config.json` (quality gates armed by default), `verification/registry.json`, and empty responsibility directories. It never overwrites existing files; if the governance root is not a Git repository it runs `git init` and makes an initial commit (skipped when it already is one), and never pushes. A policy file under `policy/` that still contains `[待确认]` placeholders is not injected into agents and `doctor` warns about it. Complete the policy, commit the governance repository, then connect it from the customer project:

```bash
npx wildarrange project attach --governance-root ../my-project-governance
npx wildarrange init
npx wildarrange project show
```

After attaching, `state verify`, `state backup`, and `state restore` operate on the external runtime state.

On plan import, `planDefaults.verify_commands`, `standards_commands`, and `review_commands` from the governance repository's `verification/registry.json` are additive and cannot be removed by the project plan. Its digest and both project/governance revisions are stored in the single task ledger. If the governance root is a Git repository with uncommitted changes, plan import fails closed.

In external mode, zero-project-file adapter bundles are generated under `runtimeRoot/adapters/external`:

```bash
npx wildarrange adapter install --target all --mode local
npx wildarrange adapter activate --target all   # Cursor hooks + user-level pointer rules + Claude Code plugin; or --target cursor / codex / claude
npx wildarrange doctor
```

`adapter activate` is an explicit user-level write that no ordinary command triggers. `--target cursor` backs up and merges the user-level `~/.cursor/hooks.json` (replacing only WildArrange-managed entries) and writes `~/.cursor/rules/wildarrange.mdc`, an alwaysApply one-line pointer telling the agent to run `wildarrange status` when the local project is connected. `--target codex` appends the same pointer to `~/.codex/AGENTS.md` inside `<!-- wildarrange:begin/end -->` markers. `--target claude` validates the runtime local marketplace with the local `claude` CLI and installs `wildarrange-governance@wildarrange-local` at user scope (`--scope user`); re-running only refreshes it. With `--user-root`, it sets `CLAUDE_CONFIG_DIR=<user-root>/.claude` and never touches the real `~/.claude`; with `--target all`, a machine without the `claude` command skips Claude Code without affecting other hosts. Everything is backed up first, activation is idempotent, and nothing is written into customer projects. `adapter uninstall` removes those user-level entries and pointers and deletes the runtime plugin bundles; `adapter restore --backup <backupId>` returns the user-level files to their state before that activation. `doctor` compares the Hook configuration digests recorded at install time and reports `external_adapter_config_modified` when a plugin `hooks.json` or a user Cursor entry was changed or removed. Codex and Kimi still require explicit installation, review, and trust through the `nextActions` returned by `adapter install`. Generated files or configured user hooks are not activation proof: `doctor` reports `execution_observed` only after a real lifecycle receipt matches the current `activationId`. A receipt only proves the plugin ran once: `doctor` also checks read-only whether the plugin is still installed and enabled (Claude Code via `claude plugin list`, Codex via `codex plugin list`, Kimi via `~/.kimi-code/plugins/installed.json`; Cursor is covered by the user hooks.json digest) and reports `external_adapter_removed` when it was uninstalled or disabled outside WildArrange; when it cannot check, it only warns. The bridge first reads the local registry (read-only) to decide whether the working directory, including project subdirectories and task worktrees, belongs to an attached project. Unattached projects, or a broken WildArrange installation, are always let through so unrelated projects are never blocked; only for an attached project does a failed subprocess follow the host policy (Cursor writes fail closed, Codex/Kimi fail open), and the subprocess has a timeout guard. The Kimi Stop hook pulls unfinished work back into the session.

Each plan task may declare `"repositoryTarget": "project"` (default) or `"governance"`. One task can write only one repository. Governance tasks use their own governance branch/worktree through the linear `wildarrange run` path, and cross-repository work must be split into separate tasks. Parallel admission still owns only the project repository; they reject governance tasks instead of falling back to the customer checkout. After both deliveries exist, bind their full SHAs in an integration receipt that modifies neither repository:

```bash
npx wildarrange integration accept \
  --project-sha <40-char-project-sha> \
  --governance-sha <40-char-governance-sha> \
  --reason "release candidate"
```

Task acceptance proof binds the imported two-repository baseline and that task's delivery SHA. `integration accept` also reloads and verifies the verification-registry digest from the specified governance commit.

### Try It Without Pinning

For a quick trial (keep the governance repository outside the project):

```bash
npx @alivewavelab/wildarrange@latest setup --governance-root ../my-project-governance
npx @alivewavelab/wildarrange@latest doctor
```

This resolves the package through `npx` on each invocation. It is useful for evaluation, but it is not the recommended setup for a long-lived team project.

### Pinned Installation

For long-term use, pin WildArrange as a project `devDependency`:

```bash
npm install --save-dev @alivewavelab/wildarrange@latest
npx wildarrange setup --governance-root ../my-project-governance --mode local
npx wildarrange doctor
```

Commit `package.json` and `package-lock.json`, so teammates and CI installing with `npm ci` get the same version. `--mode local` makes hooks and Skills call the installed CLI path; `--mode npx` uses the `npx -y <package>` prefix instead.

`setup` / `adapter install` generate external plugin packages: they never write to the customer repository and do not prove that a host loaded anything. Runtime state and generated files live in each device's local state directory, so run it on every device instead of copying another device's output. Codex Desktop additionally requires reviewing, trusting, and enabling the Hook under Settings > Hooks; Codex CLI uses `/hooks`. After at least one lifecycle Hook receipt, `doctor` should show `codex:configured/execution observed`. Never describe governance as effective while it shows `ACTIVATION UNVERIFIED`.

### Governance Policy Templates

`setup` and `project init-governance` create missing policy templates under the governance repository's `policy/` (`AGENTS.md`, code and interface conventions, testing and acceptance rules). Existing files are always preserved, never merged or overwritten, and WildArrange writes no documents into the customer project. Every `[待确认]` placeholder must be confirmed or removed by a human, especially the test strategy, standard commands, production/test entry points, and module boundaries.

The runtime task ledger `runtime:team/tasks.json` remains the single work-item ledger; the Dashboard is only an entry point and view, so do not maintain a second Markdown task table or a ClickUp source of truth.

### Install on Another Device

Clone the customer project and the governance repository, then run from the project root:

```bash
git clone <project-repository>
git clone <governance-repository>
cd <project-directory>
npm ci
npx wildarrange project attach --governance-root ../<governance-directory>
npx wildarrange init
npx wildarrange adapter install --target all --mode local
npx wildarrange doctor
```

For Kimi Code, explicitly run the `nextActions` returned by `adapter install` on each device:

```text
/plugins install <path returned by adapter install>
/reload
```

For Claude Code, run `npx wildarrange adapter activate --target claude` once on each device, then start a new Claude Code session.

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

First `/plugins remove` the old plugin, then `/plugins install` the path returned by `adapter install` and `/reload`. Claude Code reads the plugin files from the runtime directly, so after upgrading just start a new session or run `/reload-plugins`.

### Runtime State and Git Delivery

npm and Git synchronize the program and committed configuration, while the runtime directory remains local to each device. WildArrange does not coordinate multiple devices or users through the remote: when several people work, each uses their own branch, and the only constraint is that **two writable tasks may not develop on the same branch**.

One writable task maps to one isolated worktree and one task branch (`wildarrange/task/<planId>/<taskId>`). Execution starts from a clean commit baseline and may not carry dirty paths other than the current task result. If the target branch is already occupied by another writable task or worktree, the task refuses to start and names the occupant. Only after all gates and the acceptance proof pass does WildArrange create a delivery commit containing this task's paths: with a remote it pushes normally (never force) to the task's own remote branch; in a Git repository without a remote it retains the commit on the local task branch/worktree. Both paths bind checkpoint and acceptance proof to the same commit SHA and restore the shared checkout to a clean state. A task-branch push never moves `main`. One task normally keeps updating one Draft PR, and shared main changes only after a human approves and merges it on the hosting platform. Once a task-branch push is known to have succeeded, later checkpoint or audit failure cannot trigger rollback; the same run must reconcile or remain `recovery_required`.

If a process was forcibly terminated and `parallel status` shows an empty run while a task is still claimed, confirm that the process is gone and run:

```bash
npx wildarrange parallel close --run <runId> --reason "confirmed process terminated"
```

The command scans task state by `runId` and releases a ghost `parallel_run_claim` even when the run has no result entries.

### Git Delivery Configuration

Configure the behavior in the governance repository's `policy/wildarrange.config.json` (see `wildarrange.config.example.json` in this repository for an example):

```json
{
  "gitDelivery": {
    "remote": "origin",
    "integrationBranch": "auto",
    "taskBranchPrefix": "wildarrange/task",
    "requireWorktreeForParallelWrites": true
  }
}
```

`remote` is used for ordinary pushes of task branches; `integrationBranch` decides whether a delivery commit is already contained in the mainline before a worktree is cleaned up; `taskBranchPrefix` limits automatic pushes to task branches under that prefix; `requireWorktreeForParallelWrites` isolates writable parallel agents in worktrees. Whatever the configuration, these floors cannot be disabled: one task per branch, no force push, revalidation after task-branch baseline changes, and no automatic merge or business-code push to `main`.

### Developing This Repository

When maintaining WildArrange itself:

```bash
node ./bin/wildarrange.mjs setup --governance-root ../wildarrange-governance --repository <git-url>
```

This repository's own governance config lives in its governance repository, not in the repo root.

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
      "owner": "ZhuRong",
      "writable_paths": ["artifacts/smoke.txt"],
      "responsibilityChanges": [{ "script": "artifacts/smoke.txt", "additions": "Add a smoke artifact", "responsibilityBefore": "Absent", "responsibilityAfter": "Record one verifiable smoke result", "facts": [] }],
      "worker_command": "node -e \"const fs=require('fs'); fs.mkdirSync('artifacts',{recursive:true}); fs.writeFileSync('artifacts/smoke.txt','ok\\n')\"",
      "verify_commands": ["node -e \"const fs=require('fs'); if(fs.readFileSync('artifacts/smoke.txt','utf8').trim()!=='ok') process.exit(1)\""],
      "review_commands": ["node -e \"const fs=require('fs'); if(!fs.readFileSync('artifacts/smoke.txt','utf8').includes('ok')) process.exit(1)\""]
    }
  ]
}
```

> The acceptance proof requires an independent review result from this execution: a successful substantive `review_commands` / `standards_commands` command, a quality gate with actual inspection targets, or a successful LLM review. Configuration alone, skipped execution, missing-key fallback, `echo`, and `node --version` cannot authorize completion.

Plan import protects existing work: reimport cannot overwrite tasks in the same Plan that are executing, verifying, recovering, holding a task claim, or already completed. After the old Plan completes, a new Plan can be imported while retaining the previous tasks and delivery records.

Run it (every imported plan needs human approval; the readiness check requires a Worker handshake `executionReadiness.workerProbe` and a responsibility reviewer `review.responsibility.command`, configured with `/wildarrange-setup`; the built-in executors work out of the box and `doctor` prints recommended commands):

```bash
node ./bin/wildarrange.mjs plan --from plan.json
node ./bin/wildarrange.mjs plan approve
node ./bin/wildarrange.mjs run
node ./bin/wildarrange.mjs status
node ./bin/wildarrange.mjs summary
```

With an adapter installed in Codex, Cursor, Kimi Code, or Claude Code, describe the feature or bug in the host conversation. When the `UserPromptSubmit` route requires a plan, the host model is instructed to write the plan draft to the absolute path the Hook provides, `runtime:plan-drafts/<session>-plan.json` (never inside the project), from the conversation semantics instead of asking the user to hand-author the format. The file must include `generated_by: "host_semantic"` and an explicit `task.owner` on every executable task. That owner must be a command worker: Jiuwei or ZhuRong. Every task must also provide a real, non-trivial `worker_command` that WildArrange runs inside the isolated task worktree to change `writable_paths`; placeholders such as `node --version` and `process.exit(0)` are rejected before import. DiJiang, BaiZe, and LuWu participate through planning, review, and governance stages rather than executing `worker_command`. WildArrange validates the owner and Worker contract and waits for `plan approve`. Execution hooks, task claims, and parallel runs then read that same `task.owner`; there is no second assignee record.

While a plan awaits approval, the user can still edit `runtime:plan-drafts/*.json` and re-import it. Other file writes and arbitrary Shell commands are denied; only exact plan-management and read-only WildArrange commands are allowed. After approval, the draft directory returns to ordinary task `writable_paths` enforcement.

Manually authored or externally generated `plan.json` files still work with `plan --from`; they also need responsibility declarations and approval. Missing owners fall back to Jiuwei, but new plans should always declare an owner explicitly.

### Project-wide Work-item Ledger

Features, standalone bugs, post-completion acceptance corrections, and maintenance work all use the Task model and persist in `runtime:team/tasks.json`. Plans only group tasks; cross-plan references use `<planId>:<taskId>`. A request without verification commands or responsibility declarations yet can be captured as a non-runnable `draft`; `task ready` must add `responsibilityChanges`, after which the plan returns to approval. Untouched default success criteria generated at intake are bound to the verify commands that `task ready` adds:

```bash
node ./bin/wildarrange.mjs task create --title "Fix login failure" --type bug --priority P0
node ./bin/wildarrange.mjs task list --all --type bug
node ./bin/wildarrange.mjs task ready --task T001 --from task-details.json
```

A verifier failure inside the same Task adds an attempt and history evidence instead of creating duplicate work items. If a completed Task is rejected during later acceptance, create an `acceptance_correction` Task and link the original with `--parent <planId>:<taskId>`. The Dashboard work-item ledger shows every Plan and filters by type, status, Plan, and search text.

## Plan Fields and Import Validation

The plan is the entry point of the whole pipeline. Common task fields:

| Field | Required | Description |
|---|---|---|
| `id` | No | Task ID; generated as `T001`… when omitted |
| `subject` | **Yes** | Task title (`title` also works) |
| `description` | No | Task details |
| `owner` | Required for host_semantic plans | Jiuwei or ZhuRong only; manual plans fall back to Jiuwei |
| `writable_paths` | Strongly recommended | Path allowlist (globs supported); the scope guard rejects anything outside |
| `worker_command` | No | The command that actually produces changes |
| `verify_commands` | **Yes** | At least one; all must exit 0 |
| `review_commands` / `standards_commands` | No | Independent review / standards checks; optional at import, but without any independent review signal the task cannot complete |
| `successCriteria` | No | Acceptance criteria; when omitted, three verifier-bound defaults are generated (happy path / edge conditions / regression) |
| `blockedBy` | No | Prerequisite task IDs forming a DAG (do not use `dependsOn`; it is ignored) |
| `maxAttempts` | No | Maximum automatic retries, default 3 |
| `skills` | No | Skills suggested for this task |
| `repositoryTarget` | No | `project` (default) or `governance` |

A top-level `defaults` block adds default `verify_commands` / `review_commands` / `standards_commands` / `writable_paths` to every task. For `responsibilityChanges`, see "Responsibility and fact ownership audit" at the end.

Import validates layer by layer: `title` is required; every task needs `subject` and at least one `verify_commands`; `successCriteria` must be well formed and `verifierCommandRefs` must point at real verify commands; task IDs must be unique and `blockedBy` references must exist without cycles; a plan that matches product keywords and is routed as high risk needs at least 4 tasks including a verification/review task. Every executable task must carry `responsibilityChanges`; a read-only task (empty `writable_paths`) declares no file changes with an explicit empty array `[]`. A no-op task (no `writable_paths`, empty `worker_command`, and `verify_commands` that are only `true` / `process.exit(0)`) gets a `possible_noop_task` warning and is hard-blocked at the readiness check and at acceptance.

Plan approval gate: every imported plan enters `awaiting_plan_approval`; adding or changing responsibility declarations after approval (`task create` / `task ready`, review-blocker resolution tasks, `steer` additions or revisions) also returns the plan to approval. `run` then refuses to execute until `plan approve` (or `/wildarrange-approve` in chat, where the AI restates the plan before asking you to confirm). While another `run` is executing, a new `run` returns `busy` at once with the running process id instead of queueing.

### Retrying After a Scope Block

An out-of-scope task opens a ChangeRequest. Review it, clean up the offending paths, then retry the single node:

```bash
node ./bin/wildarrange.mjs changes list
node ./bin/wildarrange.mjs changes review --id CR-xxxx
node ./bin/wildarrange.mjs changes resolve --id CR-xxxx --decision accept --evidence "Scope expansion approved" --rationale "..."
# After cleaning up paths that are still out of scope
node ./bin/wildarrange.mjs node retry --task T001
```

Without an accepted ChangeRequest the result is `change_request_required`; if it was accepted but out-of-scope paths remain, the result is `scope_cleanup_required`. Single-step nodes are only `node route|execute|checkpoint|retry`: verify / scope / review run only inside the full pipeline, and `run` and `node checkpoint` run the acceptance proof before checkpoint automatically.

## Completion Gates and Traceability

A task reaches `completed` only after every gate below passes. Order: worker (outside the pipeline) → `verify → scope → review` (all run even after an earlier failure, to preserve evidence) → joint decision on worker / successCriteria / the three gates → acceptance proof → (in Git projects, a delivery commit first, pushed normally when a remote exists) → checkpoint.

| Gate | Owner | Decision |
|---|---|---|
| Worker exit code | System | `worker_command` must exit 0, which is only a claim of completion |
| Independent verification | System verifier | `verify_commands` exist and all exit 0 |
| Scope guard | System | Every changed path falls inside `writable_paths` (realpath-checked); a violation opens a ChangeRequest for human review |
| Review gate | BaiZe + on-demand Review Skills / quality gates | Main lane PASS and no high/critical security finding; `review_commands`, `standards_commands`, comment checks, and optional LLM review are judged together |
| Acceptance criteria | System | `successCriteria` pass with independent evidence, never a copy of the verifier |
| Acceptance proof | System | Re-checks the evidence chain and rejects no-op work, trivial verify (`verify_not_trivial`), and tautological review (`review_not_tautological`) |

`inconclusive` (Git change data unavailable, evidence missing) never counts as a pass. If any gate fails, the task returns to `pending` or is marked `failed`, with a failure report. The full pipeline definition is in "Gate model" of [doc/project-architecture.md](./doc/project-architecture.md).

Recovery from a bad change rests on these layers of evidence:

- **Hash-chained ledger `runtime:ledger.jsonl`**: every step appends an event; a rewritten line, broken chain, or unhashed inserted line is reported by `ledger verify`, and `doctor` accepts only verified events as completion evidence.
- **Pre-execution workspace snapshot**: see "Defensive Checks" below.
- **Resume snapshot `runtime:snapshots/context.md`**: records progress for resumption.
- **Backups and one-command restore**: `state backup` / `state restore`; restore first creates another backup.
- **Consistency check `doctor`**: reconciles completed tasks against checkpoints, acceptance proofs, and ledger events, verifies the hash chain, and cross-checks the latest backup.

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
node ./bin/wildarrange.mjs adapter install --target all --mode local
node ./bin/wildarrange.mjs adapter uninstall --target all
node ./bin/wildarrange.mjs adapter restore --backup <backupId>
```

Install, uninstall, and restore write reports under the runtime `adapters/external/`; `adapter activate` backs up user-level files before changing them. `restore` copies files from `adapters/backups/<backupId>/` back to their original user-level paths. All four hosts connect only through packages outside the project; nothing is written into the customer project:

- **Codex**: a local marketplace/plugin is generated under `adapters/external/codex-marketplace/`. In Codex Desktop, review, trust, and enable the plugin Hook under Settings > Hooks; in Codex CLI, use `/hooks`. Codex runs these hard hooks only after that.
- **Cursor**: `adapter activate --target cursor` backs up and merges the user-level `~/.cursor/hooks.json`; the bridge hard-blocks `preToolUse` (Write/Delete/Edit/Shell) and `beforeShellExecution` fail-closed in a trusted workspace and stays silent for unconnected projects.
- **Kimi Code**: a user plugin is generated under the runtime `adapters/external/kimi/`. WildArrange never silently edits the user-level `~/.kimi-code/config.toml`; run the `nextActions` from `adapter install` (`/plugins install <path>`, then `/reload`). Do not quote the path: Kimi Code 0.27 treats quotes as path characters. The plugin is a user-level install, but its bridge exits silently in unconnected projects.
- **Claude Code**: a local marketplace and plugin are generated under `adapters/external/claude-marketplace/`; `adapter activate --target claude` installs it at user scope through `claude plugin marketplace add` / `claude plugin install`, and `adapter uninstall --target claude` removes it through `claude plugin uninstall` / `marketplace remove`. Plugin hooks guard `Bash|Write|Edit|MultiEdit|NotebookEdit`; because Claude Code `PostCompact` cannot inject context, governance context is restored by `SessionStart` (`source: compact`) after compaction. Claude Code cloud sessions do not load local plugins and are not governed.

For Codex, `SessionStart` automatically injects the complete Jiuwei identity prompt, and `PostCompact` injects it again to restore identity after context compaction. Ordinary `UserPromptSubmit` events do not repeat the prompt. The prompt comes from the installed, hash-verified Prompt Pack, respects `contextBudgets.prompt.maxChars`, and reports truncation explicitly.

`adapter install` also generates shortcut command Skills inside the plugin packages so you don't have to open a terminal for common operations. `/wildarrange-plan` generates a draft from the current conversation when no path is supplied, and still imports an existing file when a path is supplied. All hosts render the same command set (`wildarrange-config` / `wildarrange-doctor` / `wildarrange-refresh` / `wildarrange-status` / `wildarrange-plan` / `wildarrange-approve` / `wildarrange-run`, plus `-setup` / `-onboard` / `-architecture`); they load with each host plugin and create no files in the customer project.

Each command is a prompt that tells the agent to run the matching `wildarrange.mjs` subcommand and report back — a shortcut that lets the agent run the CLI, not a native button. The commands:

| Command | Purpose |
|---|---|
| `/wildarrange-setup` / `-onboard` / `-architecture` | Read the matching Skill, then guide project configuration, legacy-project onboarding, and architecture design review |
| `/wildarrange-config` | Generate the governance repository's `policy/wildarrange.config.json`, guide you block by block, then run `config verify` |
| `/wildarrange-doctor` | One-shot health check: `doctor` + `config verify` + `ledger verify` + `state verify` |
| `/wildarrange-refresh` | Refresh the runtime after adding or changing Prompts, Skills, or injection points (idempotent; keeps tasks and ledger) |
| `/wildarrange-status` | Show progress, next steps, failed tasks, and pending decisions |
| `/wildarrange-plan` | Import and validate `plan.json`; without a path, draft a plan from the current conversation |
| `/wildarrange-approve` | Show the plan summary and ask you to confirm before execution is unlocked |
| `/wildarrange-run` | Run the next task through the full gates |

Healthy Kimi and Claude Code hooks can deny out-of-scope writes and clearly destructive Bash commands. Both hook runners are fail-open on hook crashes and timeouts, so this is an early warning layer rather than the final security boundary. Verifier, scope, review, success criteria, acceptance proof, and checkpoint gates remain authoritative.

### Hook Injection Points

Once an adapter is installed, the host calls `hook run` automatically at key moments; the runtime picks the injection point for the event and assembles the rules, Skills, and state to mount into the context returned to the model. This is passive injection and needs no manual trigger.

| Host event | Injection point | What it does |
|---|---|---|
| `SessionStart` | `session_start` | Restores progress, scans rules, builds the Agent context, and injects the Jiuwei identity prompt |
| `UserPromptSubmit` | `user_prompt_submit` | Routes the request and adds rules; issues the plan-draft directive when a plan is needed |
| `PreToolUse` | `pre_tool_use` | Pre-checks scope before a tool runs; out-of-plan writes return `permissionDecision=deny` |
| `PostToolUse` | `post_tool_use` | Refreshes rules for the target file after a tool runs and applies the tool-result and scope checks |
| `PostCompact` | `post_compact` | Restores working state, rules, and identity after context compaction |
| `Stop` | `stop` | Produces a continuation directive before the session stops so the next one resumes |

The config also defines orchestration injection points (`before_execute` / `before_review` / `before_checkpoint` / `repository_governance`); see `injectionPoints` in `config show` for the full list. Injected content is tiered with character budgets (Prompt default 12,000, Markdown default 12,000, Skill default 80,000), and anything over budget must be marked `truncated` rather than silently cut.

## Minimal Multi-Agent Loop

Command-based child agents can run concurrently. Writable agents automatically receive independent Git worktrees whenever the project is a Git repository with a baseline commit; the remote only determines whether the delivery commit is pushed automatically. With `gitDelivery.requireWorktreeForParallelWrites` set to `false`, `parallelAgents.isolation` remains in control:

```bash
node ./bin/wildarrange.mjs parallel run --max-agents 2 --task T001,T002 --agent ZhuRong --command "..."
node ./bin/wildarrange.mjs parallel run --task T001 --agent ZhuRong --adapter codex
node ./bin/wildarrange.mjs parallel list
node ./bin/wildarrange.mjs parallel status --run <runId>
node ./bin/wildarrange.mjs parallel cleanup --run <runId>
```

`parallel cleanup` retains worktrees awaiting acceptance, rework, recovery, or containing uncommitted changes. Cleanup requires a verifiable task identity and lifecycle, a clean worktree, and its current HEAD to be contained in `main`; it never force-deletes files added after acceptance.

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
node ./bin/wildarrange.mjs parallel admit --run <runId> --task T001
```

Successful child results remain `awaiting_user_acceptance` until admission/checkpoint releases them. After human acceptance, close retained results explicitly:

```bash
node ./bin/wildarrange.mjs parallel close --run <runId> --task T001 --reason user_accepted
```

You may also request worktree isolation explicitly. WildArrange extracts the patch and still runs `writable_paths` plus the full admission gates:

```bash
node ./bin/wildarrange.mjs parallel run --task T001 --isolation git-worktree --command "..."
node ./bin/wildarrange.mjs parallel admit --run <runId> --task T001
```

## Defensive Checks

```bash
node ./bin/wildarrange.mjs config baseline --reason reviewed
node ./bin/wildarrange.mjs config verify
node ./bin/wildarrange.mjs state backup --reason before-risky-agent
node ./bin/wildarrange.mjs state verify
node ./bin/wildarrange.mjs state list
node ./bin/wildarrange.mjs state restore --backup <backupId>
node ./bin/wildarrange.mjs task archive --task T001 --plan <planId> --delete --reason "obsolete"
node ./bin/wildarrange.mjs doctor
node ./bin/wildarrange.mjs governance audit
node ./bin/wildarrange.mjs impact "src/infra/ledger.mjs"
node ./bin/wildarrange.mjs decisions --limit 20
node ./bin/wildarrange.mjs decisions stats
node ./bin/wildarrange.mjs timeline --limit 30
node ./bin/wildarrange.mjs annotate --decision <decisionId> --category rule_wrong --reason "..."
node ./bin/wildarrange.mjs annotate stats
node ./bin/wildarrange.mjs test --zone infra
node ./bin/wildarrange.mjs docs commands --write
```

`doctor` is a one-command health check: it validates config structure and mounts, reconciles completed tasks across every Plan against checkpoints, acceptance proofs, and `planId:taskId` ledger events, verifies the ledger hash chain, and cross-checks the ledger against the latest backup to detect wholesale rewrites; the `decisionHealth` section adds a periodic health summary (per-gate trigger counts, never-fired gates, corrupt-line and orphan-annotation warnings). The checks are isolated — a crashed check only marks its own section — and doctor is read-only diagnostics that never appends to the ledger. `state restore` also creates a pre-restore backup first.

`task archive ... --delete` requires explicit deletion confirmation and first creates a runtime backup; `in_progress` and `verifying` tasks cannot be archived. Plan and Task IDs must be safe single-segment identifiers, canonical `planId:id` identities must be unique, and an explicit `--plan` must match exactly rather than falling back to another Plan. Deletion is a rollback-capable transaction that commits the canonical task ledger last. It removes only the target Task, an emptied Plan, its checkpoint / acceptance reports, that task's outbox DoneClaims, and exact non-glob artifacts under `runtime:artifacts/` that are not shared by another task. The exact deletion set is added to the backup's recovery package, so `state restore --backup <backupId>` can recover the Plan, proofs, DoneClaims, and artifacts after an interruption or rollback request. Emptying the active Plan leaves the runtime `idle`; another Plan is never activated implicitly. Historical ledger entries and backups are never deleted with an archived task.

`impact` is change impact analysis: it lists which files import a changed file directly or transitively, plus the tests that should run (always including the five-zone boundary test), so an AI edit can machine-prove "nothing else was touched".

`decisions` is the decision projection: every allow/deny across the four seams — the delivery-pipeline gates, PreToolUse/PostToolUse interception, admission, and routing — is appended to `runtime:decisions.jsonl` (a derived, droppable, truncatable log outside the hash chain). The command renders each record as three lines — what happened, which rule fired, where the evidence lives — so humans and asynchronous review agents can audit every decision. Supports `--task` / `--gate` filters and `--format json`. The reader streams backwards from the file tail, so `--limit` bounds real memory usage; after long runs you can simply `truncate -s 0 .wildarrange/decisions.jsonl` (truncate to zero, not to a half line — even then the writer self-heals with a newline and the reader skips the bad line).

`test` is zoned test selection: `--zone <zone>` runs the tests that import the zone plus naming-paired tests plus the always-on boundary test; with file arguments it runs the impact-derived list; with no arguments it runs everything. The exit code passes through from `node --test`, so you run exactly what your change touches without memorizing the test matrix.

`annotate` is the annotation feedback loop: decisions can be marked with `annotate --decision <id> --category confirmed|rule_wrong|case_wrong|mislabeled` as confirmed, rule error, case error, or mislabeled. The reason is optional; `annotate stats` aggregates by rule × category so a single annotation never hijacks a rule. **Annotations can never move gates** — the annotation path never writes config, `verify_commands`, or any gate switch (pinned by tests); only a human editing config moves a gate.

`decisions stats` is the deterministic statistical review (pure code, re-runnable, no LLM): per-gate trigger counts broken down by decision and rule code, the **never-fired gates** (the most direct signal that a gate exists only on paper), and annotation joins. Cold-start outputs counts, never rates. `timeline` merges the ledger (hash-chain-verified entries only), decisions, and annotations into one reverse-chronological feed answering "what happened in this repo recently", with `--task` / `--source` filters.

The CLI is layered: `--help` shows only the core six commands (setup / plan / run / status / decisions / doctor) covering the daily loop; the full list lives behind `--help --all`. The single source of truth for the command inventory is the registry in `src/interface/cli-help.mjs`, materialized to `doc/generated/commands.md` via `docs commands --write`; the README command-truthfulness check compares against the full `--help --all` output.

Legacy-project verification onboarding is a maintenance flow. It does not enter `task.status` and does not reuse `approvePlan`:

```text
node ./bin/wildarrange.mjs adoption start
node ./bin/wildarrange.mjs adoption status
node ./bin/wildarrange.mjs adoption resume
node ./bin/wildarrange.mjs adoption recover
```

`adoption start` scans test, gate, runner, hook, and archive assets read-only, then opens the Dashboard for per-card approval. When `--token` is omitted, the CLI creates a random token for this Dashboard session and injects it into the current tab. Only approved cards are applied; cards containing verifier commands, archives, merges, or critical configuration changes require individual approval. Registry waits for the user's commit A; WildArrange then generates Bootstrap and a browser-readable Inventory HTML and waits for commit B. The Inventory embeds its machine-readable record and shows current sources, historical archives, deferred decisions, and the applied change log. V1 does not perform physical deletion, so deletion tombstones remain a forward-compatible empty view. If an old-project file, directory, or link already occupies any of the three target names, onboarding pauses with the conflicting path and never overwrites it silently. Approved archives move into the project-commitable `docs/verification-archive/` directory (`verification-archive/` when `docs/` is absent), never into `runtime:`. Once a card has changed project files, cancelling the session cannot pretend to restore them; finish the two Git anchors, or run `adoption recover` when the session is `recovery_required`. `doctor` / `status` show `registryFreshness` as a yellow lamp only and do not block daily runs. There is no `approve` / `apply` / `delete` CLI.

External onboarding scans and verifies the product repository, while locator configuration, Registry, Bootstrap and Inventory belong to the governance repository. Registry uses the contract's `verificationRegistry` path; Bootstrap and Inventory are siblings. Commit A/B are made in governance. Any separately approved product changes require their own product commit, and both repositories are checked. Once the locator is approved, onboarding may populate the initialized empty Registry with a valid digest, preserving its original bytes under runtime `adoption/artifact-preimages/`. Nonempty, invalid-digest or concurrently changed content still causes a conflict.

The dashboard (`serve`) includes a work-item ledger, route review console, decision panel, ops panel, and verification adoption view. The route console groups the original request, structured route result, matched signals, and subsequent tool summaries by session and date. Reviewers can mark a route confirmed, rule-wrong, or case-wrong; common secret fields in tool inputs are redacted. Reviews only append annotations and never edit `routes.json` automatically.

The end-of-run gate summary is leveled by `reporting.verbosity`: the default `verbose` prints the per-gate three-line projection to stderr after each `run` (so every gate decision can be judged while the framework is new); once trust builds, set `normal` (one line) or `quiet` (JSON only). The machine-readable stdout JSON never changes across levels.

After an interrupted parallel run, `parallel status --run <runId>` shows `batchStatus` and `incompleteTasks` (claimed tasks with no passing result); `parallel retry --run <runId>` re-runs only the tasks that never passed (reusing the recorded command, overridable with `--command`), skipping tasks already passed, completed, or claimed by another run — the retry is a new run and never rewrites the original run's evidence.

Every `status` output carries a persistent `gateArming` yellow lamp: under default configs (all quality gates off, no independent review signal) it reports "gates not armed" with remediation guidance, so an all-green gate stream that proves nothing cannot be mistaken for a healthy project. The acceptance proof enforces two hard floors: it refuses tasks whose `verify_commands` are all trivial (e.g. `true`), and it refuses tasks whose review gate has no independent signal lane (no `review_commands` / `standards_commands` / `review.llm` / enabled quality gate) — a tautological review proves nothing and must not reach completed. `config init --armed` writes a config with armed quality gates (blocking commentChecker). `doctor` carries dedicated `gateArming` and `adapters` sections: unarmed gates, enabled adapters whose files are not configured on this machine, a generated Codex Hook without a current execution receipt, and rule files referencing paths that no longer exist all surface in the report. `configured` means files exist; only Codex `execution_observed` proves that the current Hook definition has run at least once.

`governance audit` is LuWu's read-only inspection. It checks directory-level `AGENTS.md`, Chinese/English README command parity, Prompt Pack registration, naming, and actual code comments, then writes evidence under `runtime:reports/governance/`. With `--changed-only`, only changed files and the related ancestor rules, paired docs, and architecture ledgers are inspected; if Git changes cannot be read, the audit safely falls back to a full scan. LuWu never moves, renames, or deletes project files automatically, and the runtime rejects LuWu, DiJiang, or BaiZe from command workers.

The first contract-governance discoverer reconciles Tauri Rust commands, handler registration, and frontend `invoke` calls. SQL embedded in Rust source is reported for manual declaration rather than claimed as scanned. Every diff card requires an explicit developer decision, while LuWu consumes the evidence inside the existing review step instead of creating a parallel gate:

```bash
node ./bin/wildarrange.mjs contracts scan
node ./bin/wildarrange.mjs contracts apply-card --card <id> --decision approve --reason "baseline confirmed" --expected-fingerprint <sha256>
node ./bin/wildarrange.mjs contracts generate
```

Exact contract definitions approved in the plan need no second decision. Unplanned interfaces or database fields pause the task while the lead explains necessity, impact, alternatives, and a recommendation. Approval binds the specific content; subsequent changes invalidate it.

```bash
node ./bin/wildarrange.mjs contracts propose --task T001 --from proposal.json
node ./bin/wildarrange.mjs contracts resolve --id <id> --decision accept --expected-fingerprint <sha256> --reason "Approve the specific changes in the report"
```

`proposal.json` requires `reason`, `impact`, `alternatives`, `recommendation`, and `items` (the task's `contractChanges.items` format; Tauri definitions require `expected.signatures`). Inside a running Loop, command workers emit one stdout line `WILDARRANGE_CONTRACT_CHANGE=<proposal JSON>` and exit for lead review; they must not call the locking `propose` command from that child process. Use `--decision reject` to keep the task paused without automatic retries. A new session surfaces the same request. See [runtime architecture](doc/project-architecture.md) for the full contract. Formal registration remains an explicit, versioned `scan/apply-card` operation; task approval does not silently modify the registry.

Before every worker run in a Git project, WildArrange records a workspace snapshot (`git stash create`); the snapshot hash and restore command are stored in task evidence and the ledger, so broken changes can be recovered with `git stash apply <hash>`.

WildArrange preflights shell commands and blocks clearly destructive commands such as deleting `.git`, recursively deleting project source/test/doc directories, `git reset --hard`, `git clean -fd`, `sudo`, or `curl | sh`. Normal project commands, verifiers, review commands, and child-agent runners continue to run.

## Routing

Routing uses only the deterministic route table (`routes.json`), and every result keeps its matched signals as evidence. An `execute` request with confidence below 0.5 is downgraded to `plan`, so vague requests do not start work directly.

## Skill Matching and Task Bindings

Skill matcher gives an explainable hint for which skills should load at the current stage:

```bash
node ./bin/wildarrange.mjs skills match --text "build a web reminders app" --stage design --agent Jiuwei
```

A stage is matching context, not a separate family of stage-prefixed Skills. Planning, execution, and verification are handled by the long-lived Agents, current specialist Skills, and the deterministic delivery pipeline.

Skill mounting at injection points is on-demand by default (`skillMatcher.dynamicInjection`). When request text is available, only configured skills that match the request are injected in full; the rest are demoted to on-demand references. `alwaysMount` skills (default `wildarrange-injection-runtime`) are always injected, and `maxSkills` (default 4) caps task-bound skills per mount. Points without request text (such as `pre_tool_use`) fall back to the static list. The dynamic matcher only subtracts within the point- and agent-bound set; `task.skills` is an additional explicit source constrained by safe loading and the same count budget.

Skills persisted in `task.skills` are mounted before execution through the PreToolUse Hook, `context build --point before_execute`, and the generated `/wildarrange-run`. M1 review/checkpoint points still use their static Skills and do not claim automatic task-binding delivery. Task bindings only accept Prompt Pack manifest entries or `.agents/skills/<name>/SKILL.md` files; installed-root, realpath, and SHA-256 checks plus count/character budgets remain enforced. Unknown or integrity-failed names are reported in `skillSelection.missing` instead of being loaded silently.

### Human decision channel and safety switches

- **Generic push (no external IM binding)**: all pending human decisions — plan awaiting approval, out-of-scope ChangeRequests, failed tasks, child agents awaiting acceptance — are injected into the host AI context by hooks (SessionStart / UserPromptSubmit / PostCompact / Stop), instructing the AI to proactively surface them to the developer with options. `attentionReport` is the source of truth; `status` / dashboard can also pull it.
- **Plan approval gate**: every imported plan, and every responsibility declaration added or changed after approval, enters `awaiting_plan_approval`. `run` refuses to execute until the developer runs `plan approve` (or `/wildarrange-approve` in chat).
- **Externalized command safety**: built-in high-risk command patterns are a floor that cannot be disabled; `commandSafety.extraPatterns` lets you add project-specific dangerous-command blocks (`{ id, pattern, flags, reason }`) without code changes.

## Custom Prompts, Skills, and Rules

### Prompts and Skills

The built-in Prompt Pack lives in `packs/wildarrange-linear/`: `manifest.json` (registers agents / skills / tools / routes), `agents/` (the five long-lived roles), `skills/`, `tools/tool-contract.json`, and `routes.json`. To add a skill, put a Markdown file under `skills/` and register it in the `skills` map of `manifest.json` (for example `"my-skill": "skills/my-skill.md"`). `init` is idempotent: it only recreates missing directories and re-registers the Prompt Pack without touching tasks or the ledger; almost every command and every hook re-registers automatically as well, and you can trigger it explicitly with `/wildarrange-refresh` or `node ./bin/wildarrange.mjs init`. Editing the body of a registered Skill takes effect immediately; the runtime records a hash of every prompt file to detect tampering. To replace the whole pack, copy and edit the directory, then point the programmatic `initRuntime(dir, { promptPackDir })` at it.

To have a Skill mounted at a given injection point, declare it as a candidate list (an upper bound) under `injectionPoints` in the governance repository's `policy/wildarrange.config.json`; the on-demand mounting rules are described in "Skill Matching and Task Bindings" above.

### Rule Documents and Rule Scanning

Coding standards, acceptance requirements, directory conventions, and similar documents enter the workflow through **rule scanning**; workflow and operating guidance belongs in Prompt Pack Skills. The runtime scans `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `.github/copilot-instructions.md`, and rule files under `.claude/rules/`, `.cursor/rules/`, and `.github/instructions/`. Global files such as `AGENTS.md` always match; a rule file applies by path through its frontmatter `globs`, and a rule with no `globs` (or with `alwaysApply`) applies globally:

```markdown
---
description: Frontend component rules
globs: [src/frontend/**, apps/web/**]
---

Frontend changes must follow the component rules and attach browser acceptance screenshots.
```

Matching uses the paths this task will change (`writable_paths` plus the paths Git actually reports), not the tab open in your editor, so editing backend code never injects frontend rules. To inspect what a change would match:

```bash
node ./bin/wildarrange.mjs rules collect --target src/app.js
```

Matched rules are written to `runtime:rules/context.md` and `context.json`, and over-budget content is explicitly marked truncated. Control-plane documents such as `AGENTS.md` and `CLAUDE.md` are read-only by default; the workflow never edits them. To avoid starting from scratch, copy `examples/fullstack-starter/` (annotated global red lines, three `globs` rule files for frontend/backend/database, a runnable `plan.example.json`, and a block-by-block config walkthrough) and follow its README checklist to get a first run passing.

## Dashboard

Local dashboard:

```bash
node ./bin/wildarrange.mjs serve --host 127.0.0.1 --port 8765
```

The loopback dashboard opens directly without a login form. The server creates a one-process HttpOnly session cookie, while Dashboard write actions still pass token, Host, and Origin checks behind the scenes.

Binding to a non-loopback host requires a token:

```bash
node ./bin/wildarrange.mjs serve --host 0.0.0.0 --port 8765 --token "$WILDARRANGE_DASHBOARD_TOKEN"
```

`GET /api/state` remains readable on loopback without a token. Browser writes use the automatic session cookie; non-browser clients still authenticate explicitly. The server validates Host / Origin headers to prevent browser-triggered local command execution.

Non-loopback API requests need either:

```text
Authorization: Bearer <token>
```

or:

```text
x-wildarrange-token: <token>
```

## Runtime Files

| Path | Purpose |
|---|---|
| `runtime:team/tasks.json` | Single project-wide work-item ledger: Tasks, types, links, status, and compact history across all Plans |
| `runtime:ledger.jsonl` | Hash-chained append-only event ledger; verify with `node ./bin/wildarrange.mjs ledger verify` |
| `runtime:security/config-baseline.json` | Config hash baseline; verify with `node ./bin/wildarrange.mjs config verify` |
| `runtime:backups/` | Runtime critical-file backups created by `state backup` |
| `runtime:checkpoints/` | Completed task checkpoints |
| `runtime:reports/` | Workflow, review, and failure reports |
| `runtime:reports/acceptance/` | Acceptance proof chain before checkpoint |
| `runtime:snapshots/context.md` | Cross-session resume context |
| `runtime:adapters/` | Adapter configs, reports, backups |
| `runtime:agent-runs/` | Child-agent packets, results, and admission records |

## Configuration

The governance repository's `policy/wildarrange.config.json` configures agents, model providers, dynamic categories, context budgets, and injection points.

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

External providers use OpenAI-compatible HTTP configuration. See `wildarrange.config.example.json` for a minimal example; keys it omits use the built-in defaults in `src/infra/default-config.mjs`. Use `.env.wildarrange.example` as the environment variable template:

```bash
# Copy and fill in real values; never commit secrets
source .env.wildarrange
```

`apiKeyEnv` and `baseUrlEnv` are environment variable names, not secret values. `defaultBaseUrl` is the fallback endpoint when the corresponding env var is unset.

Deterministic gates work without model APIs. When `review.llm.required` is `false`, a missing external key or a host-managed provider produces a warning rather than blocking the workflow.

Config block reference:

| Block | Purpose |
|---|---|
| `agents` | provider / model / reasoning per long-lived Agent; `skills` pins project Skills |
| `modelProviders` | Model providers: `host` delegates to the host, external ones use OpenAI-compatible HTTP |
| `injectionPoints` | Which `tools` / `markdown` / `skills` / `rules` each injection point mounts |
| `contextBudgets` | Character budgets for Prompt / Markdown / Skill; over budget is marked `truncated` |
| `skillMatcher.dynamicInjection` | On-demand Skill mounting: `enabled` / `maxSkills` / `alwaysMount` |
| `qualityGates` | Comment checks (`commentChecker`); put typecheck, lint, and similar commands in `standards_commands` |
| `review.llm` | Whether to enable LLM review; with `required=false` a missing key only warns |
| `commandSafety.extraPatterns` | Adds project-specific blocks on top of the built-in high-risk patterns (below) |

Agent config example (the simplest setup keeps all five long-lived Agents on `provider: "host"`; validate with `/wildarrange-config` or `config verify`):

```json
{
  "agents": {
    "Jiuwei": { "role": "workflow_orchestrator", "provider": "host", "model": "host-default", "reasoning": "high" },
    "BaiZe":  { "role": "independent_reviewer", "provider": "host", "model": "host-default", "reasoning": "xhigh" }
  }
}
```

`commandSafety.extraPatterns` can only add rules above the built-in floor; matching worker / verify / review commands are blocked (exit code 126). `pattern` is a regex string, `flags` defaults to `i`, and an invalid regex is safely skipped:

```json
{
  "commandSafety": {
    "extraPatterns": [
      { "id": "no_prod_deploy", "pattern": "deploy\\s+--env\\s+prod", "flags": "i", "reason": "Production deploys must go through the manual process" }
    ]
  }
}
```

`config init` writes an editable default config, and `config show` prints the effective one.

Comment checks live in the CLI review gate, not in editor-specific hooks; put typecheck, lint, or structure-check commands in the task or plan-default `standards_commands`:

```json
{
  "qualityGates": {
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
npm pack --dry-run --cache /private/tmp/wildarrange-npm-cache
```

Current status: the linear governance loop is implemented and tested; checkpoint writes an acceptance-proof chain first. Optional LLM review, `standards_commands` (typecheck/AST and similar), and comment checking are available through the CLI review gate. Codex Desktop hooks become hard after they are reviewed, trusted, and enabled under Settings > Hooks; Codex CLI uses `/hooks`. Cursor `preToolUse` / `beforeShellExecution` are fail-closed in trusted workspaces. Multi-agent support includes command-based parallel runs, Codex/Cursor command-template spawn, structured artifact admission, Git worktree patch admission, and retain-until-acceptance. Host-private background process management remains adapter work.

## Command Cheat Sheet

The authoritative list is `node ./bin/wildarrange.mjs --help --all` (same source as [doc/generated/commands.md](./doc/generated/commands.md)). Common scenarios:

| Scenario | Command |
|---|---|
| Connect external governance in one step | `node ./bin/wildarrange.mjs setup --governance-root <path>` |
| Generate / show governance config | `node ./bin/wildarrange.mjs config init` (`--armed` arms the quality gates) / `config show` |
| Install adapters | `node ./bin/wildarrange.mjs adapter install --target all --mode local` |
| Import / approve a plan | `node ./bin/wildarrange.mjs plan --from plan.json` / `plan approve` |
| Run the next task | `node ./bin/wildarrange.mjs run` |
| Single-step node | `node ./bin/wildarrange.mjs node execute --task T001` (also `node checkpoint` / `node retry` / `node route`) |
| Keep advancing an approved plan | `node ./bin/wildarrange.mjs workflow` (`--from <plan.json>` only imports and stops at approval) |
| Status / summary | `node ./bin/wildarrange.mjs status` / `summary` |
| Parallel child agents | `node ./bin/wildarrange.mjs parallel run --max-agents 2 --command "..."` |
| Admit / retry / close | `parallel admit --run <runId> --task <id>` / `parallel retry --run <runId>` / `parallel close --run <runId>` |
| Resolve a ChangeRequest | `node ./bin/wildarrange.mjs changes resolve --id CR-xxxx --decision accept --evidence "..."` |
| Collect matched rules / match Skills | `node ./bin/wildarrange.mjs rules collect --target <path>` / `skills match --text "..." --stage plan` |
| Decisions / timeline | `node ./bin/wildarrange.mjs decisions --limit 20` / `timeline` |
| Impact / zoned tests | `node ./bin/wildarrange.mjs impact src/infra/ledger.mjs` / `test --zone infra` |
| Health / verification | `node ./bin/wildarrange.mjs doctor` / `ledger verify` / `state verify` |
| Start the Dashboard | `node ./bin/wildarrange.mjs serve --host 127.0.0.1 --port 8765` |

## More Docs

| Doc | Purpose |
|---|---|
| [README.md](./README.md) | Chinese readme |
| [doc/generated/commands.md](./doc/generated/commands.md) | Full command list generated from the command registry |
| [CLAUDE.md](./CLAUDE.md) | Agent and developer governance rules |
| [doc/concept.md](./doc/concept.md) | Product concept and external reference boundary |
| [doc/project-architecture.md](./doc/project-architecture.md) | Runtime architecture and gate model |
| [doc/five-zone-decoupling-guidelines.md](./doc/five-zone-decoupling-guidelines.md) | Reusable five-zone decoupling and directory-level AGENTS.md guidance |
| [doc/development-plan.md](./doc/development-plan.md) | P0 / P1 / P2 roadmap |

## Responsibility and fact ownership audit

Every executable task (plan import, `task ready`, review-blocker resolution tasks, `steer` additions) requires `responsibilityChanges`: an array of `{script, additions, responsibilityBefore, responsibilityAfter, facts}`. Each fact has `{name, ownerBefore, ownerAfter, access}`. Use exact relative script paths, an empty facts array when no business facts are involved, and null for the absent side of a new/deleted fact. The planning agent supplies the declaration; the human confirms the displayed change. Dashboard and task summaries expose it, and resume preserves the same task fields.

The existing Review now audits R1 approved responsibility scope, R2 separation of independent responsibilities, R3 one authoritative fact maintainer, R4 access through the owning script, and R5 no duplicated business implementation. It supplies full target/owner scripts, project source and Git diff, not only added lines. File length alone is not a rejection reason. Reviewer decisions remain semantic judgments; matching source citations does not prove the judgment is correct.

Configure a real independent read-only reviewer using `review.responsibility.command`. The command reads the JSON packet at environment variable `WILDARRANGE_REVIEW_PACKET` and prints only `{decision:"PASS|RETURN", checks:[{rule:"R1",decision:"PASS|RETURN",reason:"..."}], findings:[{rule:"R3",file:"src/example.mjs",line:12,evidence:"exact source line",reason:"...",requiredFix:"..."}]}`. Cover R1–R5 exactly once; every RETURN rule requires a source-backed finding. Do not use a worker self-claim or constant PASS command. Alternatively, enable the existing `review.llm` and configure BaiZe's OpenAI-compatible provider. No CLI, credential or user-level configuration is installed automatically.

Missing reviewers, malformed replies, incomplete evidence, and source changes during review block completion. Evidence is never silently truncated; `review.responsibility.maxEvidenceChars` defaults to 500000. Declaration changes use existing `steer` / `revise_acceptance` with `responsibilityChanges` and reopen human plan approval. Approved declaration fingerprints use the existing ledger. No task skips the responsibility audit: a task without an approved declaration is returned, and no entry point can disable this requirement.

Tasks added after approval must also be declared and confirmed: `task create` without declarations stays draft; the `review-blockers record` blocker JSON must carry the resolution task's `responsibilityChanges`, and once that task completes, `review-blockers resolve --task <blocked task> --evidence ... --rationale ...` returns the blocked task to pending; `steer` additions and splits must carry declarations. An accepted scope change (a ChangeRequest that widens `writable_paths`) never fabricates declarations; submit covering declarations with `revise_acceptance` and approve again. Whenever declarations change, linear, stepwise, and parallel execution all wait for approval.

## Project onboarding and review

After adapter installation, use /wildarrange-setup to configure required Worker, Reviewer, research capabilities and project rules; /wildarrange-onboard inventories legacy plans, fact owners, tests and fixtures and migrates them through approved tasks. Read the full Skills with prompts show --skill configure-project-review or project-onboarding. Use the installed wildarrange command or adapter-provided absolute command, not a presumed source checkout.

Store project policy in the governance repository's policy/wildarrange.config.json: review.steps and executionReadiness. Task business fields remain separate. Each ordered review step has id, title, appliesTo, requirement, required, documents, skills and an optional command. Required failures return evidence with file, line, exact text and required fix; optional failures warn. Project steps do not replace R1–R5 responsibility auditing.

Use `project show` to get runtimeRoot, write a patch to `<runtimeRoot>/plan-drafts/review-setup.json`, preview with `wildarrange review configure --from "<runtimeRoot>/plan-drafts/review-setup.json"`, then add --apply after the user approves that configuration. Inspect review checklist --task T001; after plan approval, run readiness --task T001. Missing dependencies block Workers before an attempt is consumed. Incomplete configuration can be saved for repair.

Workers receive full Skill context through WILDARRANGE_EXECUTION_CONTEXT. Probes read WILDARRANGE_READINESS_PACKET; reviewers read WILDARRANGE_REVIEW_PACKET. Probes return ready, the current challenge and loadedSkills. Reviewers return PASS/RETURN/INCONCLUSIVE with the inputDigest and exact source evidence according to the packet protocol. Connect real services; a fixed response is not independent review. A successful handshake is not delivery.

No adapter script is needed: the built-in executor `wildarrange executor probe|review|work --cli codex|claude|kimi|cursor` hands the readiness packet, review packet, or task to a logged-in local model CLI (Codex, Claude Code, Kimi Code, Cursor Agent; when codex is not on PATH, the CLI bundled with the ChatGPT desktop app is used) and returns the answer in the format the gates require. When the handshake or reviewer is missing, `doctor` prints ready-to-copy commands based on the CLIs installed on this machine (the worker prefers codex for its OS sandbox, the reviewer prefers a different CLI from the worker; using the same CLI only warns). Example:

```json
{
  "executionReadiness": { "workerProbe": "wildarrange executor probe --cli claude" },
  "review": { "responsibility": { "command": "wildarrange executor review --cli kimi", "checkIntervalMs": 900000 } }
}
```

A task `worker_command` can be `wildarrange executor work --cli claude`. Handshakes and reviews are read-only: codex runs in the `--sandbox read-only` OS sandbox, claude disables shell and file-writing tools, kimi runs its built-in read-only `plan` profile (no shell, no file-writing tools), cursor uses `--mode ask`. Workers edit files in the task worktree: codex runs in `--sandbox workspace-write`, so even shell commands can only write the task directory and system temp directories; claude gets file tools only, without shell; kimi's non-interactive `-p` mode itself auto-approves every tool including shell, and cursor needs `--force` to edit non-interactively (also including shell); their results still pass every gate. Command-based formal reviews update `<packetPath>.status.json` next to their input packet every `review.responsibility.checkIntervalMs` (15 minutes by default). They keep waiting for the same process and collect its result immediately on exit; the interval never kills a running reviewer. `running` means the process has not exited, not that the model is making progress. `exited` is not review approval: evidence and verdict validation still apply. Ctrl+C / SIGTERM explicitly cancels the process tree; failed termination requires recovery. `review.responsibility.timeoutMs` still bounds reviewer readiness handshakes and HTTP reviews; existing values no longer limit formal command reviews. Status files expose the current run and do not provide session recovery after a host crash. The linear `run` worker timeout is `executionReadiness.workerTimeoutMs`, 30 minutes by default (previously a fixed 120 seconds, too short for model workers). Model sessions started by an executor are not affected by WildArrange host hook injection or continuation.

`review configure --from` only accepts drafts under the runtime `plan-drafts/` directory; pass the absolute path. Applied configuration lives at `<policyRoot>/wildarrange.config.json` in the governance repository; until it exists, built-in defaults apply. These governance files are not created in the product repository.

Use adoption inventory for discovery and the existing per-card adoption approval flow for registration. Registry.fixtures references original fixture locations and consumers, never copied business values. Legacy plan provenance goes in task.request.evidenceRefs; facts retain one read/write owner. Registration and verified migration are separate milestones. Historical completion claims require fresh verification.

Architecture design: project-document initialization returns a next-Skill hint. Invoke `/wildarrange-architecture` or request an “architecture design review”. Review existing designs for responsibilities, dependencies, fact ownership, flows and necessary complexity; propose a minimal design when none exists. A passing review still needs explicit human confirmation of that version, keeping one authoritative document. This is a host-executed Skill, not an automatic dialog, overwrite or diagram-to-code compliance gate.

### Task evidence packets and long-term documentation review

After readiness passes for an approved task and before its Worker starts, WildArrange creates `runtime:task-packets/<planId>/<taskId>/`. `baseline.json` freezes the first-start task scope and approval projection; `README.md` links to the existing readiness, review, failure, acceptance, and checkpoint reports; `research.md` indexes source references declared at the start. Retries preserve the original baseline. A listed report is evidence only after it exists. `runtime:team/tasks.json` remains the live task authority. Research results must be written to a task-approved `writable_paths` entry and cited in acceptance evidence; the packet does not expand Worker permissions.

The Worker context explains the documentation boundary. When a task changes root Markdown or long-term Markdown/HTML files under `doc/` or `docs/` (excluding task-history directories such as `plans/` and `reports/`), an independent reviewer also checks that they describe current behavior, structure, use, and limitations. Task timelines, raw logs, and unlanded proposals belong in task evidence; current facts have one authoritative source (verified translations may mirror it); obsolete designs are marked historical. The reviewer must cite each changed document and return exact source lines, reasons, and fixes for violations. A failed review prevents checkpoint.
