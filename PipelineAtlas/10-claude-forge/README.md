# claude-forge — Pipeline Atlas

Source: https://github.com/sangrokjung/claude-forge (cloned 2026-06-09, depth 1 + submodules)

## What is claude-forge?

A Claude Code plugin that installs a set of slash commands and sub-agents to enforce a plan → TDD → review → verify → ship pipeline. `install.sh` symlinks commands and agents into `~/.claude/` and `settings.local.json` locks down dangerous shell patterns while enabling the required tools.

---

## Node Map

| Node | Dir | Command file | Agent file | One-line purpose |
|------|-----|-------------|------------|-----------------|
| 01 · Plan | `01-plan/` | `plan.md` | `planner.md` | Restate requirements, identify risks, produce a phased step-plan — **blocks** implementation until user confirms |
| 02 · TDD | `02-tdd/` | `tdd.md` | `tdd-guide.md` | Scaffold interfaces → write failing tests (RED) → minimal implementation (GREEN) → refactor; enforces 80 %+ coverage |
| 03 · Code Review | `03-code-review/` | `code-review.md`, `security-review.md` | `code-reviewer.md`, `security-reviewer.md` | Quality pass + CWE-based security review (effort:max forced) on all uncommitted changes |
| 04 · Handoff-Verify | `04-handoff-verify/` | `handoff-verify.md` | `verify-agent.md` | Runs build / test / lint in a fresh sub-agent context so parent context is preserved; replaces the old 3-step `/handoff → /clear → /verify` |
| 05 · Commit-Push-PR | `05-commit-push-pr/` | `commit-push-pr.md` | — | Stages, commits, pushes, opens PR and optionally merges; v6 adds MCP notifications |
| 06 · Sync Docs | `06-sync/` | `sync-docs.md` | `doc-updater.md` | Syncs `prompt_plan.md`, `spec.md`, `CLAUDE.md`, and `rules/` after every task; infers work description from last 5 commits when no arg given |
| 07 · Auto | `07-auto/` | `auto.md` | — | One-button full pipeline (plan → TDD → review → verify → commit-push-pr); only halts on CRITICAL security issues |

---

## _install/

| File | Role |
|------|------|
| `install.sh` | Symlinks `commands/` and `agents/` into `~/.claude/commands/` and `~/.claude/agents/`; idempotent, safe to re-run |
| `settings.local.json` | Template for `~/.claude/settings.local.json`; allows all major tool types, denies ~30 destructive shell patterns (force-push to main, eval, rm -rf, etc.) |

The local-override pattern: `settings.json` ships defaults; users copy `settings.local.template.json` to `settings.local.json` and tweak without touching the tracked file.

---

## Coverage

All 7 nodes populated with real source files from the repo. No missing files.

Additional forge agents available but not mapped to nodes (present in source):
`architect.md`, `build-error-resolver.md`, `database-reviewer.md`, `e2e-runner.md`, `refactor-cleaner.md`
