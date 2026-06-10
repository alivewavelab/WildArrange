# spec-workflow-mcp — Pipeline Atlas Node Map

Source: https://github.com/Pimzino/spec-workflow-mcp (depth-1 snapshot, 2026-06-09)

## Workflow Nodes

| Node | Directory | Source File | What prompt/state-machine it injects |
|------|-----------|-------------|--------------------------------------|
| 01-steering-guide | `01-steering-guide/` | `src/tools/steering-guide.ts` | Loads the steering-document creation workflow (product.md, tech.md, structure.md templates); called only on explicit user request, not part of the standard spec flow. |
| 02-requirements-design-tasks-guide | `02-requirements-design-tasks-guide/` | `src/tools/spec-workflow-guide.ts` | Injects the complete spec state machine: Requirements → Design → Tasks → Implementation; must be called first before any other spec tool. |
| 03-approvals-gate | `03-approvals-gate/` | `src/tools/approvals.ts` | Manages the approval gate: `request` posts a doc to the dashboard for human review, `status` polls it, `delete` clears resolved requests; agent blocks on pending approval before proceeding. |
| 04-log-implementation | `04-log-implementation/` | `src/tools/log-implementation.ts` | Records structured implementation details (API endpoints, components, utilities) for each completed task, building a searchable knowledge base that prevents future agents from duplicating work. |
| 05-spec-status | `05-spec-status/` | `src/tools/spec-status.ts` | Displays per-spec completion overview (phases done, task markers `[ ]` / `[-]` / `[x]`); call when resuming work or checking progress. |

## Reference Docs

| File | Path | Content |
|------|------|---------|
| `WORKFLOW.md` | `_docs/WORKFLOW.md` | Full workflow narrative: phase sequence, file structure, approval checkpoints. |
| `PROMPTING-GUIDE.md` | `_docs/PROMPTING-GUIDE.md` | Prompting patterns and best practices for driving the MCP tools effectively. |

## Coverage Notes

- All 5 `src/tools/*.ts` files confirmed present and copied.
- `docs/WORKFLOW.md` and `docs/PROMPTING-GUIDE.md` confirmed present and copied.
- No missing files.
