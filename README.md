# HelixFlow

HelixFlow is a local governance runtime for Codex and Cursor agent workflows.

The first release is deliberately small: one recoverable linear loop before multi-agent parallel execution.

## What It Does

HelixFlow turns a coding request into a gated workflow:

```text
init -> plan -> execute -> verify -> scope -> review -> checkpoint -> resume
```

The key rule is simple: a worker can claim work is done, but only gates can complete it.

The core runtime is host-neutral. Codex and Cursor adapters improve injection and recovery, but the workflow can run through CLI commands alone.

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

Cursor receives a project rule at `.cursor/rules/helixflow.mdc`. Codex receives a lifecycle hook bundle at `.helix/adapters/codex/hooks.json`; deeper host-level Codex plugin installation is still adapter work, not assumed by the runtime.

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

Agents that use `"provider": "host"` are delegated to the installed host tool. In Codex, GPT-family model selection is handled by Codex. In Cursor, the default Cursor model is used by the adapter path. HelixFlow does not need an OpenAI API key for those host-managed agents.

External providers use OpenAI-compatible HTTP configuration:

```json
{
  "modelProviders": {
    "host": { "type": "host", "adapter": "auto" },
    "deepseek": {
      "type": "openai-compatible",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "baseUrlEnv": "DEEPSEEK_BASE_URL",
      "defaultBaseUrl": "https://api.deepseek.com"
    }
  },
  "agents": {
    "Momus": { "role": "skeptical_reviewer", "provider": "host", "model": "host-default" },
    "Librarian": { "role": "external_research", "provider": "deepseek", "model": "deepseek-v4-pro" }
  },
  "review": {
    "llm": {
      "enabled": false,
      "required": false,
      "agents": ["Momus"]
    }
  }
}
```

`apiKeyEnv` and `baseUrlEnv` are environment variable names, not secret values. `defaultBaseUrl` is the fallback endpoint used when the `baseUrlEnv` variable is not set.

Use `.env.helix.example` as the environment variable template:

```bash
source .env.helix
```

The deterministic gates work without model APIs. When `review.llm.required` is `false`, a missing external key or a host-managed provider produces a warning rather than blocking the workflow.

LSP/typecheck and comment checks live in the CLI review gate, not in editor-specific hooks:

```json
{
  "qualityGates": {
    "lspDiagnostics": {
      "enabled": true,
      "commands": ["npm run typecheck"]
    },
    "commentChecker": {
      "enabled": true,
      "blockOnFindings": false
    }
  }
}
```

## Commercial Boundary

HelixFlow is an original runtime inspired by agent governance patterns. It must not distribute copied source code, prompt text, or tool implementations from projects whose license blocks commercial redistribution.

Before a commercial release, run the publish review skill and confirm:

- No restricted third-party source or prompt text is included.
- `packs/` contains HelixFlow-authored prompts and contracts.
- External workflow references remain documentation or conceptual comparison only.

## Development

```bash
npm test
npm pack --dry-run --cache /private/tmp/helix-npm-cache
```

Current status: linear governance loop is implemented and tested. Optional LLM review, configurable LSP/typecheck diagnostics, and comment checking are available through the CLI review gate. Multi-agent orchestration still needs real sub-agent spawning and background task management.
