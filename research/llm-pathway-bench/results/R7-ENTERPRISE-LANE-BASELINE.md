# R7 — Enterprise-Lane Baseline (metered via OpenRouter, budget-funnel enforced)

**Run**: 2026-07-01 17:38–18:15 PDT · label `r7-enterprise-baseline` · prompt `ping` (obedience-sensitive) · N=30/model, c=1, 95s timeout · ALL calls through `metered-funnel.mjs` (budget-guard Layer 3) · **600 calls, 598 OK, total actual cost $0.2067** (worst-case projection was $1.39 — pessimistic by design).

## Results (per tier, sorted by p50)

| tier | model | ok | p50 ms | p95 ms | mean out-tok | cost/30 |
|---|---|---|---|---|---|---|
| large | openai/gpt-5.5 | 30/30 | 1660 | 2480 | 15 | $0.0170 |
| large | deepseek/deepseek-v4-pro | 30/30 | 2037 | 4186 | 31 | $0.0011 |
| large | moonshotai/kimi-k2.6 | 30/30 | 2770 | 6834 | 71 | $0.0072 |
| large | google/gemini-3.1-pro-preview | 30/30 | 3179 | 12505 | 135 | $0.0496 |
| large | qwen/qwen3.7-max | 30/30 | 5240 | 6620 | 203 | $0.0239 |
| large | z-ai/glm-5.2 | 30/30 | 8547 | 12980 | 152 | $0.0150 |
| large | anthropic/claude-opus-4.8 | 30/30 | 9200 | 11230 | 5 | $0.0087 |
| mid | openai/gpt-5.4 | 30/30 | 1163 | 1705 | 6 | $0.0045 |
| mid | google/gemini-3.5-flash | 30/30 | 1957 | 2396 | 129 | $0.0357 |
| mid | deepseek/deepseek-v4-flash | 30/30 | 2566 | 9563 | 28 | $0.0002 |
| mid | anthropic/claude-sonnet-5 | 30/30 | 2938 | 5137 | 5 | $0.0035 |
| mid | z-ai/glm-5-turbo | 30/30 | 3013 | 4617 | 143 | $0.0180 |
| mid | qwen/qwen3.7-plus | 30/30 | 5772 | 7974 | 203 | $0.0081 |
| small | meta-llama/llama-4-scout | 30/30 | 734 | 1284 | 3 | $0.0001 |
| small | openai/gpt-5.4-nano | 30/30 | 915 | 2608 | 6 | $0.0004 |
| small | google/gemini-3.1-flash-lite | 30/30 | 1071 | 1763 | 2 | $0.0002 |
| small | openai/gpt-5.4-mini | 30/30 | 1105 | 2342 | 6 | $0.0013 |
| small | anthropic/claude-haiku-4.5 | 30/30 | 1726 | 2636 | 6 | $0.0017 |
| small | qwen/qwen3.6-flash | 30/30 | 3347 | 3982 | 248 | $0.0085 |
| small | z-ai/glm-4.7-flash | 28/30 | 3525 | 10605 | 152 | $0.0019 |

## Findings

1. **Same-model, different door — the door dominates.** GPT-5.5: 1.66s via OpenRouter vs ~18s via codex CLI (Phase 1) — 10.9x. Claude Haiku 4.5: 1.7s vs 3.5s via claude CLI, AND ~24 mean input tokens vs ~23,662 through claude-code — a ~1000x fixed-overhead difference. The CLI wrappers, not the models, were most of our "slow model" experience.
2. **Counter-example: Claude Opus 4.8 is SLOWER metered** (9.2s p50 via OpenRouter vs ~3.0s via claude CLI in Phase 1). The subscription path stays the fast door for Opus. Likely provider-side serving-tier differences; worth a re-check at different hours.
3. **The small tier is effectively free and fast**: llama-4-scout 734ms/$0.000004-per-call-actual; gpt-5.4-nano 915ms; gemini-3.1-flash-lite 1071ms. A sentinel firing 1,000×/day on scout ≈ **$0.004/day**. This is the hard number for the enterprise-tier "background checks on metered small models" strategy.
4. **Instruction discipline varies wildly** (out-tokens on "reply with exactly PONG"): Claude (5-6), GPT (6-15), llama-scout (3), gemini-lite (2) obey; GLM (143-152), Qwen (203-248), gemini-pro/3.5-flash (129-135) burn 20-40x the tokens on a one-word task — latency + cost tax and a gate-prompt discipline risk. GLM-5.2/Qwen quality may still win on complex tasks — this round only measures obedience-sensitive latency/cost.
5. **Reliability**: 100% everywhere except glm-4.7-flash (2 failures/30). No rate-limiting observed at c=1.
6. **Budget guard held throughout**: all 600 calls passed the funnel; ledger + OpenRouter usage agree (~$0.21); caps never approached ($2 daily).

## Next candidates (R8+)
- Latency-under-load + throttle ceilings per model (c=4/8/16 sweeps) — Justin's first-class metric ask.
- Quality parity on real component prompts (tone-gate/sentinel prompts in prompts/).
- Re-run Opus-via-OpenRouter at other hours; add Groq (open-weight speed king) when its key lands.
- Time-of-day variance windows per the R2 methodology.
