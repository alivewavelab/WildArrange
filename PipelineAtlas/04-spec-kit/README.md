# spec-kit — Pipeline Atlas

Source: https://github.com/github/spec-kit  
Clone: `git clone --depth 1 https://github.com/github/spec-kit`  
Command templates live at: `templates/commands/*.md`

## Node → File Mapping

| Node | Dir | Source File | One-line Purpose |
|------|-----|-------------|-----------------|
| 01-constitution | `01-constitution/` | `templates/commands/constitution.md` | Create/update project constitution; propagate principle changes to all dependent templates |
| 02-specify | `02-specify/` | `templates/commands/specify.md` | Turn a natural-language feature description into a structured spec.md with quality checklist |
| 03-clarify | `03-clarify/` | `templates/commands/clarify.md` | Ask up to 5 targeted questions to reduce spec ambiguity and encode answers back into spec.md |
| 04-checklist | `04-checklist/` | `templates/commands/checklist.md` | Generate domain-specific "unit tests for requirements" checklists (clarity, completeness, coverage) |
| 05-plan | `05-plan/` | `templates/commands/plan.md` | Execute planning workflow: research unknowns, produce data-model, contracts, quickstart artifacts |
| 06-tasks | `06-tasks/` | `templates/commands/tasks.md` | Generate dependency-ordered tasks.md organized by user story with phase structure |
| 07-analyze | `07-analyze/` | `templates/commands/analyze.md` | Read-only cross-artifact consistency analysis (spec/plan/tasks) before implementation |
| 08-implement | `08-implement/` | `templates/commands/implement.md` | Execute tasks.md phase-by-phase, checking checklists and marking tasks complete |
| 09-taskstoissues | `09-taskstoissues/` | `templates/commands/taskstoissues.md` | Convert tasks.md into GitHub Issues via GitHub MCP server |

## Shared Templates (`_shared-templates/`)

| File | Purpose |
|------|---------|
| `spec-template.md` | Blank spec structure used by `specify` command |
| `plan-template.md` | Blank plan structure used by `plan` command |
| `tasks-template.md` | Blank tasks structure used by `tasks` command |

## Cross-Product Compiler (`_cross-product-compiler/`)

| File | Purpose |
|------|---------|
| `__init__.py` | Integration registry (`INTEGRATION_REGISTRY`) — maps 30+ AI assistant keys (claude, copilot, gemini, cursor-agent, …) to `IntegrationBase` instances; `_register_builtins()` wires them all at import time |

## Notes

- The `checklist-template.md` also exists at `templates/checklist-template.md` (referenced by the checklist command for ID/format structure).
- The `constitution-template.md` lives at `templates/constitution-template.md` and is copied to `.specify/memory/constitution.md` during project setup.
- All commands support before/after extension hooks via `.specify/extensions.yml`.
