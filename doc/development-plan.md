# WildArrange Development Plan

## P0: Publishable M1

- Maintain README and onboarding docs.
- Keep `npm test` green.
- Keep `npm pack --dry-run` green.
- Make adapter install/uninstall reversible.
- Decide npm package name or organization scope.
- Add ArchivistRouter runtime to the routing loop without making LLM calls mandatory. `DONE: packet/fallback/memory path + trigger scheduler + suggestion review flow`
- Add real LLM review provider for BaiZe/LuanNiao/QiongQi lanes. `DONE: OpenAI-compatible provider path and three-role review contract`
- Add checkpoint acceptance proof chain. `DONE: worker/verifier/successCriteria/scope/review proof artifact required before completion`
- Add LSP diagnostics gate.
- Add comment checker.

## P1: Linear Quality

- Implement ArchivistRouter with `deepseek-v4-flash` for SessionStart, Git HEAD changes, low-confidence routes, and periodic prompt summaries. `DONE: runtime, manual CLI, hooks, Git HEAD trigger state, and stage-aware prompt windows`
- Add local structured memory files for progress, decisions, artifacts, implementation notes, research notes, pitfalls, and context injection. `DONE: minimal structured-files backend`
- Add route suggestion artifacts under `.helix/routing/suggestions` with apply/reject review flow. `DONE: pending suggestions, accept/reject CLI, and reviewed route override layer`
- Add semantic route shadow and low-confidence execute downgrade. `DONE: deterministic route keeps evidence; CangJie shadow can force ambiguous execute into plan/ask`
- Add session/task digest files for recovery after accidental chat closure. `DONE: session_start/post_compact/task_completed/parallel_admission_completed digests`
- Add prompt model variants for GPT, Gemini, and Kimi.
- Add `pre-publish-review`, `publish`, and `get-unpublished-changes` skills.
- Add skill matcher and priority loading.
- Add adapter backup restore command if uninstall backup is not enough.
- Add CI once repository remote exists.

## P2: Multi-Agent Runtime

- Implement `codex_spawn_agent` minimum viable child-agent call. `PARTIAL: host-neutral Codex/Cursor command-template spawn exists; host-private background agent API remains adapter work`
- Add background task/session manager. `PARTIAL: batch run index and admission records exist; process manager remains`
- Add worktree isolation and merge admission. `DONE: Git worktree isolation, patch extraction, writable_paths check, patch apply, verifier/scope/review/checkpoint admission`
- Keep lightweight child-agent results open until user/mainline acceptance. `DONE: successful child results enter awaiting_user_acceptance and release after admission`
- Add Skill MCP support.
- Add tmux/cmux visualization only after background agents work.

## Quality Bar

The product is not considered production-ready just because prompts exist.

The bar is:

- role prompts are loaded,
- tools are callable,
- gates can block,
- evidence is durable,
- failure is recoverable,
- and a user can install/uninstall without hand-editing hidden files.
