# BMAD-METHOD Pipeline Atlas

Source: https://github.com/24601/BMAD-AT-CLAUDE (`bmad-core/` branch)
Pulled: 2026-06-09 (depth-1 clone, commit HEAD)

Each node directory contains the real source files that define that role's system prompt and output templates. Load the agent `.md` as the AI persona, the task `.md` as the executable workflow, the template `.yaml` as the output scaffold, and the checklist `.md` as the gate criteria.

---

## Node Map

| Dir | Files Copied | Role & Injection Summary |
|-----|-------------|--------------------------|
| `01-orchestrator` | `bmad-orchestrator.md`, `bmad-master.md` | **BMad Orchestrator** — single system prompt injected into any chat session; dynamically transforms into any specialist agent via `*agent <id>` command; never pre-loads resources. `bmad-master.md` is a taskless variant (no persona, direct resource execution) for one-off runs without role switching. |
| `02-analyst` | `analyst.md`, `facilitate-brainstorming-session.md`, `project-brief-tmpl.yaml` | **Analyst (Mary)** — discovers market context and ideation signals; inject agent md + task md to run structured brainstorming; outputs a Project Brief using the yaml template. |
| `03-pm` | `pm.md`, `prd-tmpl.yaml`, `pm-checklist.md`, `shard-doc.md` | **Product Manager (John)** — authors PRDs; inject agent md + prd template for document creation; `shard-doc.md` is also included here as PM commonly calls it post-PRD to split large docs; pm-checklist.md is the output gate. Note: upstream references a `create-doc.md` task that is generated/resolved at runtime from the orchestrator — it is not a static file in the repo. |
| `04-ux-expert` | `ux-expert.md`, `front-end-spec-tmpl.yaml` | **UX Expert (Sally)** — produces front-end UX specs and AI UI generation prompts; inject agent md + template to drive spec creation. |
| `05-architect` | `architect.md`, `fullstack-architecture-tmpl.yaml`, `architect-checklist.md` | **Architect (Winston)** — designs holistic system architecture; inject agent md + fullstack template for greenfield or brownfield arch docs; checklist is the output gate. |
| `06-po-checklist` | `po.md`, `po-master-checklist.md` | **Product Owner (Sarah)** — validates artifact cohesion across PRD/arch/stories before dev begins; inject agent md + checklist to run the master gate review; also authorised to shard docs and run correct-course. |
| `07-sharding` | `shard-doc.md`, `core-config.yaml` | **Sharding task** — splits any large markdown doc at H2 boundaries into a folder of smaller files; `core-config.yaml` controls the `markdownExploder` flag and `devLoadAlwaysFiles` list; inject both files to execute. |
| `08-sm-draft` | `sm.md`, `create-next-story.md`, `story-tmpl.yaml`, `story-draft-checklist.md` | **Scrum Master (Bob)** — prepares the next implementation-ready story from PRD + arch; inject agent md + task + template; checklist gates the draft before handoff to Dev. SM is NOT authorised to write code or modify source files. |
| `09-dev` | `dev.md`, `story-dod-checklist.md` | **Developer (James)** — implements a single assigned story; reads `core-config.yaml → devLoadAlwaysFiles` on activation; only authorised to update story file sections: Tasks/Subtasks checkboxes, Dev Agent Record, File List, Change Log, Status. DoD checklist runs at completion before status → "Ready for Review". |
| `10-qa-review` | `qa.md`, `review-story.md` | **QA (Quinn)** — senior code review + test strategy on a completed story; inject agent md + task md; QA is ONLY authorised to append to the story's "QA Results" section — all other sections are read-only. |
| `11-change-control` | `correct-course.md`, `change-checklist.md` | **Change Control** — triggered when scope/requirements shift mid-sprint; task guides structured impact analysis across epics and artifacts; checklist frames the Sprint Change Proposal that must be approved before modifying any upstream docs. |

---

## Story-File Write-Permission Rules

BMAD enforces strict per-agent write scope on story files to prevent conflicting edits:

| Agent | Authorised Sections |
|-------|-------------------|
| **SM (08)** | Creates the full story file from template |
| **Dev (09)** | Tasks/Subtasks checkboxes, Dev Agent Record (Debug Log, Completion Notes, File List, Change Log), Status |
| **QA (10)** | QA Results section only — append, never overwrite |
| **All others** | Read-only on story files |

---

## Notes

- `create-doc.md` (referenced in analyst/pm/ux-expert/architect agent YAMLs as a dependency) is **not a static file** in the repo. It is an internal runtime task resolved by the orchestrator — the agent's `dependencies.tasks` list declares it as a reference, and the orchestrator injects it as a workflow step. Closest available static file is `shard-doc.md` for document-splitting workflows.
- `core-config.yaml` (in `07-sharding`) doubles as the project-level config loaded by Dev on startup via `devLoadAlwaysFiles`; it is the single source of truth for tool flags, team composition, and always-load file paths.
- All agent `.md` files are self-contained system prompts (YAML embedded in markdown); they require no additional files to activate — external dependencies load only on explicit `*task` or `*checklist` commands.
