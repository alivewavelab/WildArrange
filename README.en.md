# WildArrange

[简体中文](./README.md) | English

WildArrange is a local governance runtime for Codex, Cursor, and Kimi Code agent workflows. The first release is deliberately small: one recoverable linear loop before multi-agent parallel execution.

## What It Does

WildArrange turns a coding request into a gated workflow:

```text
init -> plan -> execute -> verify -> scope -> review -> checkpoint -> resume
```

The key rule is simple: a worker can claim work is done, but only gates can complete it.

The core runtime is host-neutral. Codex, Cursor, and Kimi adapters improve injection and recovery, but the workflow can run through CLI commands alone.

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

npm and Git synchronize the program and committed project configuration; they do not synchronize an active workflow. `.helix/` contains task state, the ledger, checkpoints, backups, and Agent run records, and is excluded by the default `.gitignore`:

- Do not let two devices write the same `.helix/` concurrently.
- When only installing the program on a new device, follow `npm ci → init → adapter install → doctor`.
- To move unfinished work, stop writes on the source device and transfer one complete, internally consistent runtime state. Do not copy only `tasks.json` or one checkpoint.
- Before migration, run `npx wildarrange state backup --reason before-device-migration`. After migration, run `npx wildarrange state verify` and `npx wildarrange doctor`.

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
      "verify_commands": ["node -e \"const fs=require('fs'); if(fs.readFileSync('.helix/artifacts/smoke.txt','utf8').trim()!=='ok') process.exit(1)\""]
    }
  ]
}
```

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
- **Cursor**: project rule at `.cursor/rules/wildarrange.mdc`. This is soft governance unless Cursor exposes a command lifecycle hook for the project.
- **Kimi Code**: a project-specific plugin is generated under `.helix/adapters/kimi/plugin/`, while project instructions and Skills reuse `AGENTS.md` and `.agents/skills/`. WildArrange never silently edits the user-level `~/.kimi-code/config.toml`; start Kimi Code from the project root, run `/plugins install .helix/adapters/kimi/plugin`, then run `/reload`. Do not quote the path because Kimi Code 0.27 treats quote characters as part of the path. Although plugin installation is user-scoped, its bridge exits silently outside WildArrange projects.

`adapter install` also generates shortcuts so you don't have to open a terminal for common operations. All three surfaces render from one shared command set (`helix-config` / `helix-doctor` / `helix-refresh` / `helix-status` / `helix-plan` / `helix-approve` / `helix-run`):

- **Cursor**: `.cursor/commands/<name>.md` (plain-Markdown slash commands; type `/helix-doctor` in chat).
- **Codex / Kimi Code**: shared `.agents/skills/<name>/SKILL.md` project Skills. Codex can invoke them through `/skills` or `$helix-doctor`; Kimi Code discovers and invokes them through its project Skill mechanism.

Each command is a prompt that tells the agent to run the matching `helix.mjs` subcommand and report back — a shortcut that lets the agent run the CLI, not a native button.

A healthy Kimi Hook can deny out-of-scope Write/Edit calls and clearly destructive Bash commands. Kimi's Hook runner is fail-open on hook crashes and timeouts, so this is an early warning layer rather than the final security boundary. Verifier, scope, review, success criteria, acceptance proof, and checkpoint gates remain authoritative.

## Minimal Multi-Agent Loop

Command-based child agents can run concurrently in isolated run directories:

```bash
node ./bin/helix.mjs parallel run --max-agents 2 --task T001,T002 --agent Kui --command "..."
node ./bin/helix.mjs parallel run --task T001 --agent Kui --adapter codex
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

Admission does not trust the child agent directly. `parallel admit` checks `writable_paths`, then runs verifier, scope guard, review gate, and checkpoint:

```bash
node ./bin/helix.mjs parallel admit --run <runId> --task T001
```

Successful child results remain `awaiting_user_acceptance` until admission/checkpoint releases them. After human acceptance, close retained results explicitly:

```bash
node ./bin/helix.mjs parallel close --run <runId> --task T001 --reason user_accepted
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
```

`doctor` is a one-command health check: it validates config structure and mounts, reconciles completed tasks against checkpoints, acceptance proofs, and ledger events, verifies the ledger hash chain, and cross-checks the ledger against the latest backup to detect wholesale rewrites. `state restore` automatically takes a pre-restore backup first, so a bad restore can itself be undone.

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

## Skills and Prompt Variants

Skill matcher gives an explainable hint for which skills should load at the current stage:

```bash
node ./bin/helix.mjs skills match --text "build a web reminders app" --stage design --agent YingLong
```

Skill mounting at injection points is on-demand by default (`skillMatcher.dynamicInjection`). When request text is available, only configured skills that match the request are injected in full; the rest are demoted to on-demand references. `alwaysMount` skills (default `wildarrange-injection-runtime`) are always injected, and `maxSkills` (default 4) caps a single mount. Points without request text (such as `pre_tool_use`) fall back to the static list. Dynamic matching only subtracts; it never injects full text of skills outside the configured list.

### Human decision channel and safety switches

- **Generic push (no external IM binding)**: all pending human decisions — plan awaiting approval, out-of-scope ChangeRequests, failed tasks, child agents awaiting acceptance — are injected into the host AI context by hooks (SessionStart / UserPromptSubmit / PostCompact / Stop), instructing the AI to proactively surface them to the developer with options. `attentionReport` is the source of truth; `status` / dashboard can also pull it.
- **Plan approval gate**: when `planApproval.required=true`, an imported plan enters `awaiting_plan_approval` and `run` refuses to execute until the developer runs `plan approve` (or `/helix-approve` in chat). Off by default.
- **Externalized command safety**: built-in high-risk command patterns are a floor that cannot be disabled; `commandSafety.extraPatterns` lets you add project-specific dangerous-command blocks (`{ id, pattern, flags, reason }`) without code changes.

Prompt variants append model-specific bias without replacing the base agent prompt:

```bash
node ./bin/helix.mjs prompts variant --agent YingLong --model gpt-5.5
node ./bin/helix.mjs prompts show --agent YingLong --variant gemini
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

Current status: the linear governance loop is implemented and tested. Optional LLM review, configurable LSP/typecheck diagnostics, AST/structure commands, hashline anchors, and comment checking are available through the CLI review gate. Multi-agent support now includes command-based parallel runs, structured artifact admission with rollback on failed gates, Git worktree patch admission, and the message board loop. The next layer is real Codex/Cursor child-agent spawning and background process management.

## More Docs

| Doc | Purpose |
|---|---|
| [README.md](./README.md) | Chinese readme |
| [CLAUDE.md](./CLAUDE.md) | Agent and developer governance rules |
| [doc/concept.md](./doc/concept.md) | Product concept and external reference boundary |
| [doc/project-architecture.md](./doc/project-architecture.md) | Runtime architecture and gate model |
| [doc/five-zone-decoupling-guidelines.md](./doc/five-zone-decoupling-guidelines.md) | Reusable five-zone decoupling and directory-level AGENTS.md guidance |
| [doc/development-plan.md](./doc/development-plan.md) | P0 / P1 / P2 roadmap |
