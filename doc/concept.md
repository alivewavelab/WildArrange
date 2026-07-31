# WildArrange Concept

WildArrange is a small-team governance layer for AI coding agents.

The simple analogy: a worker can say "I finished", but the warehouse gate still checks the package before it leaves. WildArrange is that gate.

## Product Intent

The project exists to stop three common failures:

1. Agent finishes without real verification.
2. Agent changes files outside the agreed scope.
3. Session context disappears when Codex or Cursor is closed.

## Core Loop

```text
Plan -> Worker -> Verifier -> Scope Guard -> Review Gate -> Checkpoint
```

Each step writes evidence to `.helix/`, so a new session can resume from disk.

## External Pattern Boundary

- Specialized agent roles.
- Planning and execution separation.
- Trust-but-verify review discipline.
- Category-based routing.
- Wisdom/context accumulation.
- Session continuity through files.

## What Is Deliberately Smaller

M1 does not yet run a real multi-agent cluster. It first makes one linear path reliable, then adds child agents and background workers.

## Current Truth

WildArrange exposes five long-lived Agents: Jiuwei, DiJiang, ZhuRong, BaiZe, and LuWu. Router is a deterministic system node; CangJie is an optional internal archivist/semantic-routing profile. Product, journey, acceptance, UX, scope, research, inspection, risk-review, and skeptical-review duties are Skills mounted onto the appropriate Agent.

BaiZe is the only independent reviewer. Deterministic gates remain authoritative, while optional OpenAI-compatible LLM review adds a second opinion when configured.
