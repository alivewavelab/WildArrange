# OpenSpec — Pipeline Atlas

Source: https://github.com/Fission-AI/OpenSpec  
Clone: `git clone --depth 1 https://github.com/Fission-AI/OpenSpec`  
Command prompt definitions are NOT standalone .md files — they are generated from TypeScript template modules at build time and deployed to `.claude/commands/opsx/`.  
Source lives in: `src/core/templates/workflows/*.ts`  
Each `.ts` file exports both a `SkillTemplate` (for Skill-tool invocation) and a `CommandTemplate` (for slash-command `content` field).

## Node → File Mapping

| Node | Dir | Source File | One-line Purpose |
|------|-----|-------------|-----------------|
| 01-explore | `01-explore/` | `src/core/templates/workflows/explore.ts` → `getOpsxExploreCommandTemplate()` | Enter free-form thinking/exploration mode; never implement, may create OpenSpec artifacts |
| 02-propose | `02-propose/` | `src/core/templates/workflows/propose.ts` → `getOpsxProposeCommandTemplate()` | Create a change + generate ALL artifacts (proposal, design, tasks) in one shot |
| 03-apply | `03-apply/` | `src/core/templates/workflows/apply-change.ts` → `getOpsxApplyCommandTemplate()` | Implement tasks from a change; loop until done or blocked |
| 04-verify | `04-verify/` | `src/core/templates/workflows/verify-change.ts` → `getOpsxVerifyCommandTemplate()` | Verify implementation against artifacts (completeness/correctness/coherence) before archiving |
| 05-sync | `05-sync/` | `src/core/templates/workflows/sync-specs.ts` → `getOpsxSyncCommandTemplate()` | Agent-driven merge of delta specs from a change into main `openspec/specs/` |
| 06-archive | `06-archive/` | `src/core/templates/workflows/archive-change.ts` → `getOpsxArchiveCommandTemplate()` | Finalize a change: check tasks, optionally sync specs, move to `changes/archive/YYYY-MM-DD-<name>` |
| 07-new-continue-ff | `07-new-continue-ff/` | `new-change.ts`, `continue-change.ts`, `ff-change.ts` | Three entry points: create new change scaffold; step-by-step artifact creation; fast-forward all artifacts at once |

## Schema / Templates (`_schema/`)

| File | Origin | Purpose |
|------|--------|---------|
| `spec-driven-schema.yaml` | `schemas/spec-driven/schema.yaml` | Canonical schema defining artifact graph (proposal→specs→design→tasks), `apply.requires`, rules, and instruction metadata |
| `proposal.md` | `schemas/spec-driven/templates/proposal.md` | Blank proposal template filled by propose/continue/ff commands |
| `spec.md` | `schemas/spec-driven/templates/spec.md` | Blank delta-spec template (ADDED/MODIFIED/REMOVED/RENAMED Requirements sections) |
| `design.md` | `schemas/spec-driven/templates/design.md` | Blank design template |
| `tasks.md` | `schemas/spec-driven/templates/tasks.md` | Blank tasks template with checkbox format |

## Architecture Note

Commands are generated at runtime via `src/core/command-generation/` adapters (one per AI tool: Claude, Copilot, Gemini, Cursor, etc.). The `content` field of each `CommandTemplate` IS the prompt that gets written to `.claude/commands/opsx/<name>.md` (or equivalent path per tool). The files in this atlas are the TypeScript source — the actual deployed command files are identical to the `content` string inside each `getOpsx*CommandTemplate()` export.

## Notes

- ⚠️ No `05-sync` standalone slash command exists separately — sync is invoked either directly (`/opsx:sync`) or triggered from within `/opsx:archive` via Task tool subagent.
- The `workspace-planning` schema (`schemas/workspace-planning/`) is a parallel schema variant; its templates mirror `spec-driven` but target multi-repo workspace contexts.
- The `onboard.ts`, `feedback.ts`, and `bulk-archive-change.ts` workflow templates exist in the same directory but are not mapped to the 7 primary nodes above.
