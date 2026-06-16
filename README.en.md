# WildArrange

[简体中文](./README.md) | English

WildArrange is a local governance runtime for Codex and Cursor agent workflows. The first release is deliberately small: one recoverable linear loop before multi-agent parallel execution.

## What It Does

WildArrange turns a coding request into a gated workflow:

```text
init -> plan -> execute -> verify -> scope -> review -> checkpoint -> resume
```

The key rule is simple: a worker can claim work is done, but only gates can complete it.

The core runtime is host-neutral. Codex and Cursor adapters improve injection and recovery, but the workflow can run through CLI commands alone.

## Install

From a published package:

```bash
npx @alivewavelab/wildarrange@latest init
npx @alivewavelab/wildarrange@latest adapter install
```

For a long-running project, install it as a project dependency so hooks do not need network access:

```bash
npm i -D @alivewavelab/wildarrange
npx wildarrange adapter install --mode local
```

Local development (this repo):

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
```

WildArrange preflights shell commands and blocks clearly destructive commands such as deleting `.git/.helix`, `git reset --hard`, `git clean -fd`, `sudo`, or `curl | sh`. Normal project commands, verifiers, review commands, and child-agent runners continue to run.

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
| [doc/development-plan.md](./doc/development-plan.md) | P0 / P1 / P2 roadmap |
