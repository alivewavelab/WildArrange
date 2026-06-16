# WildArrange Development Plan

## P0: Publishable M1

- Maintain README and onboarding docs.
- Keep `npm test` green.
- Keep `npm pack --dry-run` green.
- Make adapter install/uninstall reversible.
- Make adapter backup restore explicit. `DONE: adapter restore --backup <backupId>`
- Decide npm package name or organization scope. `DONE: @alivewavelab/wildarrange`
- Add ArchivistRouter runtime to the routing loop without making LLM calls mandatory. `DONE: packet/fallback/memory path + trigger scheduler + suggestion review flow`
- Add real LLM review provider for BaiZe/LuanNiao/QiongQi lanes. `DONE: OpenAI-compatible provider path and three-role review contract`
- Add checkpoint acceptance proof chain. `DONE: worker/verifier/successCriteria/scope/review proof artifact required before completion`
- Add LSP diagnostics gate. `DONE: host-neutral CLI command gate`
- Add AST/hashline code-intelligence gates. `DONE: astStructure command lane + hashline anchor lane in review_gate`
- Add comment checker. `DONE: configurable blocker/warn lane`

## P1: Linear Quality

- Implement ArchivistRouter with `deepseek-v4-flash` for SessionStart, Git HEAD changes, low-confidence routes, and periodic prompt summaries. `DONE: runtime, manual CLI, hooks, Git HEAD trigger state, and stage-aware prompt windows`
- Add local structured memory files for progress, decisions, artifacts, implementation notes, research notes, pitfalls, and context injection. `DONE: minimal structured-files backend`
- Add route suggestion artifacts under `.helix/routing/suggestions` with apply/reject review flow. `DONE: pending suggestions, accept/reject CLI, and reviewed route override layer`
- Add semantic route shadow and low-confidence execute downgrade. `DONE: deterministic route keeps evidence; CangJie shadow can force ambiguous execute into plan/ask`
- Add session/task digest files for recovery after accidental chat closure. `DONE: session_start/post_compact/task_completed/parallel_admission_completed digests`
- Add prompt model variants for GPT, Gemini, Kimi, DeepSeek, and host-managed models. `DONE: configurable promptVariants + prompts variant/show --variant`
- Add `pre-publish-review`, `publish`, and `get-unpublished-changes` skills.
- Add skill matcher and priority loading. `DONE: stage/route/agent/keyword matcher with explainable scores`
- Add adapter backup restore command if uninstall backup is not enough. `DONE`
- Add CI once repository remote exists.

## P2: Multi-Agent Runtime

- Implement `codex_spawn_agent` minimum viable child-agent call. `PARTIAL: host-neutral Codex/Cursor command-template spawn exists; host-private background agent API remains adapter work`
- Add background task/session manager. `DONE: run index, lifecycle status, awaiting_user_acceptance retention, explicit close/release commands; host-private long-lived process control remains adapter work`
- Add worktree isolation and merge admission. `DONE: Git worktree isolation, patch extraction, writable_paths check, patch apply, verifier/scope/review/checkpoint admission, failed admission rollback`
- Keep lightweight child-agent results open until user/mainline acceptance. `DONE: successful child results enter awaiting_user_acceptance and release after admission`
- Add Skill MCP support. `PARTIAL: skill/tool contracts are installable and matchable; external MCP server lifecycle remains adapter work`
- Add tmux/cmux visualization only after background agents work. `DEFERRED: not required for publishable CLI loop`

## Quality Bar

The product is not considered production-ready just because prompts exist.

The bar is:

- role prompts are loaded,
- tools are callable,
- gates can block,
- evidence is durable,
- failure is recoverable,
- and a user can install/uninstall without hand-editing hidden files.
