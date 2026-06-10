# Agent OS — Pipeline Atlas Node Map

Source: https://github.com/buildermethods/agent-os (depth-1 snapshot, 2026-06-09)

## Workflow Nodes

| Node | Directory | Source File | What it injects |
|------|-----------|-------------|-----------------|
| 01-plan-product | `01-plan-product/` | `commands/agent-os/plan-product.md` | Conversational prompt that establishes mission, roadmap, and tech stack docs under `agent-os/product/`. |
| 02-discover-standards | `02-discover-standards/` | `commands/agent-os/discover-standards.md` | Prompt that extracts tribal knowledge from an existing codebase into explicit, documented standards. |
| 03-index-standards | `03-index-standards/` | `commands/agent-os/index-standards.md` | Prompt that rebuilds and maintains `standards/index.yml`, keeping all discovered standards indexed and addressable. |
| 04-inject-standards | `04-inject-standards/` | `commands/agent-os/inject-standards.md` | Prompt that reads `index.yml` and injects only the relevant standards into the active context window before coding begins. |
| 05-shape-spec | `05-shape-spec/` | `commands/agent-os/shape-spec.md` | Plan-mode prompt that gathers context and structures a detailed spec for significant work before implementation starts. |

## Config

| File | Path | Notes |
|------|------|-------|
| `config.yml` | `_config/config.yml` | Top-level Agent OS config: version, default profile, optional profile inheritance map. |

## Coverage Notes

- All 5 command files confirmed present and copied from `commands/agent-os/`.
- ⚠️ No `standards/index.yml` example exists in the repo — the `_config/` directory holds only `config.yml`. The index is generated at runtime by the `03-index-standards` command; no static example was available to copy.
