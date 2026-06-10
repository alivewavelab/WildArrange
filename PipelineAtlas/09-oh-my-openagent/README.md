# oh-my-openagent — PipelineAtlas Node Map

Source repo: https://github.com/code-yeongyu/oh-my-openagent  
Clone provenance: `git clone --depth 1` on 2026-06-09  
Files copied from: `src/agents/`, `packages/prompts-core/prompts/`, `packages/model-core/src/`, `docs/guide/`

> **深化阅读**：基于 v4.8.1 全量克隆（`/tmp/omoa`）的源码级拆解见 [WORKFLOW.md](WORKFLOW.md) —— 运行时接线 / 62+ hooks 治理硬机制 / boulder 状态续作 / lazycodex 跨产品配方 / 可直接复用的纯库清单。HelixFlow v2 的源码依据。

---

## Node Map

| Node | File(s) | Role / Injection |
|------|---------|-----------------|
| `01-prometheus/` | `src/agents/prometheus/system-prompt.ts` + `prompts/prometheus/{default,gpt,gemini}.md` | **Planner agent.** Creates structured work plans saved to `.omo/plans/*.md`. The TS file is a loader that dispatches to per-model `.md` variants via `getPrometheusPrompt(model)`. Claude path: ~1,100-line mechanics-driven markdown prompt. GPT path: 3-principle ~121-line XML-structured prompt. Gemini path: separate variant. Model: claude-opus-4-7 (default), GPT-5.5/5.4, Gemini 3.1 Pro. |
| `02-metis/metis.ts` | `src/agents/metis.ts` | **Pre-planning consultant.** Analyzes requests BEFORE planning. Classifies intent (Refactoring / Build / Mid-sized / Collaborative / Architecture / Research), identifies hidden requirements, flags AI-slop patterns, generates clarifying questions, and produces actionable directives for Prometheus. READ-ONLY: no writes. Model: Claude family with extended thinking. |
| `03-momus/momus.ts` | `src/agents/momus.ts` | **Plan reviewer.** Reviews `.omo/plans/*.md` files for executability and reference validity. Dual-prompt: Claude (markdown mechanics) vs GPT (XML principles, `reasoningEffort: "medium"`). Approval bias — only rejects for true blockers (max 3 issues). Model: Claude or GPT. |
| `04-atlas/` | `src/agents/atlas/agent.ts` + `prompts/atlas/{default,gpt,gemini,kimi,opus-4-7}.md` | **Master orchestrator (primary agent).** Executes todo lists by coordinating specialized agents via `task()`. Routes to 5 prompt variants by model: opus-4-7 (literal-following + explicit fan-out), gpt (GPT-5.5 calibrated), gemini, kimi (Claude-base + K2.6 thinking-mode calibration), default (Claude 4.6 family). Dynamically injects available agents/skills/categories into the prompt at runtime. Temperature: 0.1. |
| `05-sisyphus/` | `src/agents/sisyphus.ts` + `src/agents/sisyphus/index.ts` + `sisyphus-agent-factory.ts` | **Lead orchestrator / primary executor (primary agent).** The "sociable lead" — coordinates agents, maintains context, delegates intelligently. 6 prompt variants: default, claude-opus-4-7, gemini, gpt-5-4, gpt-5-5, kimi-k2-6. ~1,100-line base prompt. Model default: claude-opus-4-7 (max), fallback to kimi-k2.5/k2.6, then glm-5. |
| `06-hephaestus/` | `src/agents/hephaestus/agent.ts` + `src/agents/hephaestus/index.ts` | **Deep specialist / autonomous coder (primary agent).** Principle-driven, stays autonomous. 3 GPT-native prompt variants: gpt-5-5, gpt-5-4, gpt (base). No Claude-family fallback by design. **Requires GPT-5.5** (or github-copilot/venice providing it). The only agent with a hard provider requirement. |
| `07-oracle/oracle.ts` | `src/agents/oracle.ts` | **Strategic technical advisor.** High-IQ read-only consultant for architecture decisions, hard debugging (2+ failed attempts), and self-review. Dual-prompt: Claude (XML + extended thinking) vs GPT-5.4/5.5 (concise principles, `reasoningEffort: "medium"`). Verbosity strictly constrained (2-3 sentence bottom line, ≤7 action steps). Model: gpt-5.5 (high) → gemini-3.1-pro → claude-opus-4-7 → glm-5.1. |
| `08-librarian/librarian.ts` | `src/agents/librarian.ts` | **External docs / open-source researcher.** Answers questions about libraries via GitHub CLI, Context7, and web search. READ-ONLY (no writes/edits/task). Classifies requests TYPE A–D, discovers official docs first. Model: gpt-5.4-mini-fast → qwen3.5-plus → minimax-m2.7-highspeed → minimax-m3. Cheap/fast category. |
| `09-explore/explore.ts` | `src/agents/explore.ts` | **Codebase search specialist.** Finds files, patterns, and code structures within the local repo. READ-ONLY. Fire multiple in parallel for broad searches. Supports LSP tools and ast-grep. Model: same chain as librarian (fast/cheap). Triggered by 2+ modules involved. |
| `10-ulw-loop/` | `docs/guide/orchestration.md` + `docs/guide/team-mode.md` + `prompts/ultrawork/{default,gpt,gemini,planner}.md` | **ULW (UltraWork Loop) orchestration docs + prompts.** The ultrawork prompts are injected into Atlas/Sisyphus for parallel task execution. `orchestration.md` explains the multi-agent delegation model. `team-mode.md` covers team-based parallel execution. These are the pipeline runtime docs, not standalone agent defs. |

---

## Model-Capability-Class Routing

See `_model-routing/` for the authoritative source files.

| File | Contents |
|------|----------|
| `agent-model-matching.md` | Human-readable guide explaining *why* each agent maps to its model family. The "models as developers" metaphor. Recommended stack: OpenCode Go ($10/mo) + OpenAI Plus ($20/mo). |
| `agent-model-requirements.ts` | Machine-readable fallback chains per agent (sisyphus, hephaestus, oracle, librarian, explore, prometheus, atlas, metis, momus, multimodal-looker). Used at runtime by `model-resolution-pipeline.ts`. |
| `category-model-requirements.ts` | Fallback chains per task category (deep, quick, ultrabrain, visual-engineering, artistry, unspecified-low, unspecified-high). |

### Model Family Summary

| Family | Agents | Default Model | Rationale |
|--------|--------|--------------|-----------|
| Claude / Kimi (instruction-following) | Sisyphus, Atlas, Prometheus, Metis, Sisyphus-Junior | claude-opus-4-7 → kimi-k2.5/k2.6 → glm-5 | Mechanics-driven ~1,100-line prompts require fine-grained compliance |
| GPT (principle-driven, autonomous) | Hephaestus, Oracle, Momus (GPT path) | gpt-5.5 | Principle-driven prompts; deep autonomous exploration without hand-holding |
| Gemini / Qwen (visual) | visual-engineering, artistry, multimodal-looker | gemini-3.1-pro → qwen3.6-plus | Visual reasoning, UI/CSS, design tokens |
| Fast/Cheap (utility) | Librarian, Explore | gpt-5.4-mini-fast → qwen3.5-plus → minimax-m2.7 | High-frequency background probes; cost matters |

### Key Routing Rules
- Sisyphus and Atlas auto-detect model family at runtime and switch prompts via `isGptModel()` / `resolveVariant()`.
- Hephaestus has **no Claude-family fallback** — it will not activate without GPT access.
- Dual-prompt agents (Prometheus, Atlas, Oracle, Momus) ship separate prompt files per model family.
- Kimi K2.5/K2.6 is the recommended Claude substitute (follows nested todo+delegation prompts better than GLM).

---

## Architecture Notes

- **Prompt location**: Claude-path prompts for Prometheus and Atlas live in `packages/prompts-core/prompts/` as `.md` files and are loaded at runtime via `loadPromptSync()`. They are NOT embedded in the `.ts` agent files (which are just loaders/dispatchers).
- **Sisyphus vs Atlas**: Both are primary-mode orchestrators. Sisyphus is the main entry point for coding sessions. Atlas is invoked when a `.omo/plans/*.md` todo list exists and full sequential orchestration is needed.
- **Pipeline**: Metis → Prometheus → Momus → Atlas/Sisyphus → (Hephaestus | Oracle | Librarian | Explore) → verification.
- **Missing named agents**: Prometheus, Sisyphus, Hephaestus have NO standalone `.md` agent definitions — they are TypeScript modules with inline prompts or external `.md` variants in prompts-core. This is by design (compiled runtime injection).
- **10-ulw-loop**: The "ULW loop" concept maps to Atlas's todo-orchestration loop + the ultrawork prompts injected into it. There is no standalone "ulw-loop" agent — it is a behavior mode of Atlas/Sisyphus.
