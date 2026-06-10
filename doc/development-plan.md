# HelixFlow Development Plan

## P0: Publishable M1

- Maintain README and onboarding docs.
- Keep `npm test` green.
- Keep `npm pack --dry-run` green.
- Make adapter install/uninstall reversible.
- Decide npm package name or organization scope.
- Add real LLM review provider for at least one Momus lane.
- Add LSP diagnostics gate.
- Add comment checker.

## P1: Near-OMO Linear Quality

- Add prompt model variants for GPT, Gemini, and Kimi.
- Add `pre-publish-review`, `publish`, and `get-unpublished-changes` skills.
- Add skill matcher and priority loading.
- Add adapter backup restore command if uninstall backup is not enough.
- Add CI once repository remote exists.

## P2: Multi-Agent Runtime

- Implement `codex_spawn_agent` minimum viable child-agent call.
- Add background task/session manager.
- Add worktree isolation and merge admission.
- Add Skill MCP support.
- Add tmux/cmux visualization only after background agents work.

## Quality Bar

The product is not considered OMO-like just because prompts exist.

The bar is:

- role prompts are loaded,
- tools are callable,
- gates can block,
- evidence is durable,
- failure is recoverable,
- and a user can install/uninstall without hand-editing hidden files.
