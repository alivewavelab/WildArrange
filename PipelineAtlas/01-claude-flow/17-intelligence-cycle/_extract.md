# Node: 17-intelligence-cycle
<!-- Source: .claude/helpers/intelligence.cjs (full file — ADR-050 stub) -->
<!-- Source: plugins/ruflo-intelligence/README.md lines 30-52 (4-step pipeline) -->

## What it injects
A self-learning cycle that runs across session boundaries. The local stub (`intelligence.cjs`) provides the in-process API; the full ruflo-intelligence plugin wraps 29 MCP tools into four phases:

| Step | What happens | Key tools |
|------|-------------|-----------|
| RETRIEVE | Pull relevant patterns from HNSW index | `hooks_intelligence_pattern-search`, `agentdb_semantic-route` |
| JUDGE | Score candidates with success/failure verdicts | `hooks_intelligence_attention`, `neural_predict` |
| DISTILL | Extract learnings via LoRA/SONA adaptation | `ruvllm_sona_adapt`, `neural_train` |
| CONSOLIDATE | Prevent catastrophic forgetting via EWC++ | `agentdb_consolidate`, `neural_compress` |

## End-to-end pipeline call sequence (from README)
```
hooks_pretrain
  → hooks_intelligence_trajectory-start
    → (each step) hooks_intelligence_trajectory-step
  → hooks_intelligence_trajectory-end
  → hooks_intelligence_learn
  → ruvllm_sona_adapt    # DISTILL
  → agentdb_consolidate  # CONSOLIDATE
  → neural_compress      # storage efficiency
```

## Local stub functions (intelligence.cjs)
- `init()` — loads ranked-context.json + auto-memory-store.json into graph
- `getContext(prompt)` — returns relevant context snippet for the prompt
- `recordEdit(file)` — adds a file-edit event to pending-insights.jsonl
- `feedback(success)` — records task outcome
- `consolidate()` — runs PageRank, writes ranked-context.json, appends new edges
- `stats(json)` — prints graph statistics
