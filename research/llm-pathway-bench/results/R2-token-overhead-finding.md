# R2 Finding — Fixed per-call token overhead by framework (cost driver)

**Date:** 2026-07-01 · one-word prompt (input tokens are ~all fixed overhead, prompt itself ≈10 tok).

| Framework (route) | fixed input tokens / call | notes |
|---|---|---|
| **pi** (GPT-5.5) | **~1,088** | leanest — no heavy harness system prompt; also reports cost directly |
| codex (exec-json) | ~10,000 | moderate |
| gemini (flash) | ~5,960 | ~3,100 of it cache-read (cheap) |
| **claude-code** (all tiers) | **~20,000–24,000** | the Claude Code harness system prompt (tool defs); ~all cache-read after warm-up |

## Why this matters
- claude-code carries **~20x pi's fixed input overhead** and ~4x gemini's, per call. For
  HIGH-FREQUENCY internal calls (sentinels/gates firing constantly), this fixed overhead —
  not the prompt — dominates input-token cost.
- This is the hard-number justification for instar's provider-fallback-default policy
  (route internal sentinel/gate/reflector components OFF claude-code). Moving a chatty
  sentinel from claude-code (~23k/call) to pi (~1k/call) is a ~20x input-token reduction.
- Caveat: much of claude's overhead is `cache_read` (discounted ~10x vs fresh input), so the
  DOLLAR gap is smaller than the raw-token gap — but cache-read still bills, and pi/codex/
  gemini avoid the bulk entirely. R5/R6 will put dollar figures on it (pi surfaces cost
  directly; claude surfaces total_cost_usd; gemini needs a price table).

## Harness change enabling this
- Implemented token parsing for pi (`--mode json`, reads final message_end usage + cost) and
  gemini (`-o json`, reads stats.models.<model>.tokens). Both pathways switched to JSON mode.
  Closes the R2 "null tokens for pi/gemini" gap. Verified: pi meanIn=1088/out=6,
  gemini meanIn=5960/out=2.
