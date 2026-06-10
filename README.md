# HelixFlow

HelixFlow is a local governance runtime for Codex and Cursor agent workflows.

It is inspired by oh-my-openagent, but the first release is deliberately smaller: one recoverable linear loop before multi-agent parallel execution.

## What It Does

HelixFlow turns a coding request into a gated workflow:

```text
init -> plan -> execute -> verify -> scope -> review -> checkpoint -> resume
```

The key rule is simple: a worker can claim work is done, but only gates can complete it.

## Install

From a published package:

```bash
npx helixflow@latest init
npx helixflow@latest adapter install
```

For a long-running project, install it as a project dependency so hooks do not need network access:

```bash
npm i -D helixflow
npx helixflow adapter install --mode local
```

Current local development entry:

```bash
node ./bin/helix.mjs init
node ./bin/helix.mjs adapter install --target all --mode local
```

## Minimal Workflow

Create a plan:

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

Or run a full sample:

```bash
node ./bin/helix.mjs workflow --sample
```

## Important API Contract

`runNextTask` returns an action result, not only the stored task status.

When a verifier fails, the task is moved back to `pending` for retry, while the returned result can be:

```json
{
  "status": "retry",
  "task": { "status": "pending" }
}
```

This is intentional. The result says what the runtime wants next; the task state says where the task is stored.

## Adapter Commands

```bash
node ./bin/helix.mjs adapter install --target all --mode local
node ./bin/helix.mjs adapter uninstall --target all
```

Install and uninstall both write reports under `.helix/adapters/`. Existing adapter files are backed up before overwrite or removal.

Cursor receives a project rule at `.cursor/rules/helixflow.mdc`. Codex receives an OMO-like hook bundle at `.helix/adapters/codex/hooks.json`; deeper host-level Codex plugin installation is still adapter work, not assumed by the runtime.

## Dashboard

Local dashboard:

```bash
node ./bin/helix.mjs serve --host 127.0.0.1 --port 8765
```

Binding to a non-loopback host requires a token:

```bash
node ./bin/helix.mjs serve --host 0.0.0.0 --port 8765 --token "$HELIX_DASHBOARD_TOKEN"
```

API requests then need either:

```text
Authorization: Bearer <token>
```

or:

```text
x-helix-token: <token>
```

## Runtime Files

- `.helix/team/tasks.json`: task state
- `.helix/ledger.jsonl`: append-only event ledger
- `.helix/checkpoints/`: completed task checkpoints
- `.helix/reports/`: workflow, review, and failure reports
- `.helix/snapshots/context.md`: cross-session resume context
- `.helix/adapters/`: adapter configs, reports, backups

## Configuration

`helix.config.json` configures agents, model providers, dynamic agents, and injection points.

Model names such as `gpt-5.5` are placeholders until a real provider implementation is connected. The deterministic gates work without model APIs; LLM review is a P0 follow-up.

## Development

```bash
npm test
npm pack --dry-run --cache /private/tmp/helix-npm-cache
```

Current status: linear governance loop is implemented and tested. OMO-equivalent multi-agent orchestration still needs LLM provider integration, LSP diagnostics gate, comment checker, and real sub-agent spawning.
