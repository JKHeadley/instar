# Gemini Door Parity — Native Paid API vs OpenRouter

**Run:** `crit-gnat` (native, metered_gemini_bench) vs `crit-metered` (OpenRouter door), 2026-07-02.
**Battery:** the same 11 critical-gate tasks / 109 cases × 2 samples (218 calls per route), post-fix prompt batteries (parity-checked against production prompt text).
**Spend:** the entire native run booked **$1.64** against the $15/day Gemini cap. Zero errors, zero rate-limit refusals — billing on the key is fully live.

## Headline

**The doors agree.** Unlike the Opus CLI-vs-API gap (0.75 vs 1.00 — a 25-point door effect), the Gemini native-vs-OpenRouter deltas are ≤2.8 points on every model. OpenRouter is a fair proxy for Gemini quality; door choice for Gemini is about latency, ops, and pricing — not correctness.

## Accuracy (pass rate, same 218 cells per door)

| Model (exact version) | Native paid API | OpenRouter | Δ (native − OR) |
|---|---|---|---|
| gemini-3.1-flash-lite | **98.6%** (215/218) | 97.7% (213/218) | +0.9 |
| gemini-3.5-flash | 95.9% (209/218) | 93.1% (203/218) | +2.8 |
| gemini-3.1-pro-preview | 95.9% (209/218) | 96.8% (211/218) | −0.9 |
| gemini-3-flash-preview | 94.0% (205/218) | — (native only) | |
| gemini-2.5-flash | 90.4% (197/218) | — (native only) | |

## Latency (median, ms)

| Model | Native | OpenRouter |
|---|---|---|
| gemini-3.1-flash-lite | **1,015** | 1,473 |
| gemini-3.5-flash | 3,402 | 1,822 |
| gemini-3.1-pro-preview | 4,432 | 5,400 |

## Findings

1. **gemini-3.1-flash-lite is the standout Gemini route**: 98.6% on the critical-gate battery at ~1s median — the best accuracy AND the best latency of any Gemini model, through either door. It belongs in the fast-lane fallback chains.
2. **The catalog scan found newer models**: gemini-3.5-flash and gemini-3-flash-preview were both benched (native). 3.5-flash matches 3.1-pro-preview on accuracy at ~¼ the pro's latency; 2.5-flash (the subscription-door model) is the WEAKEST of the family on this battery (90.4%) — the subscription Gemini door underperforms every paid Gemini option.
3. **Door effect is small for Gemini** (≤2.8 pts, mixed sign — within sampling noise at n=218 for deltas this size). Contrast with Opus-by-door (25 pts, mechanism: the Claude Code harness framing). This corroborates the mechanism: the door effect comes from HARNESS PROMPT WRAPPING, not from API-vs-aggregator plumbing — OpenRouter passes prompts through clean, so it scores like the native API.
4. **Pricing note:** native Gemini API and OpenRouter list near-identical per-token prices for these models (OpenRouter adds ~5% on credits purchase). The native door's value is first-party quota/SLA and the free door-diversity (a second independent lane when OpenRouter is down); the OR door's value is one key for everything.

## Routing consequences (folded into the matrix re-rank)

- Add **gemini-3.1-flash-lite (native)** to tier-1 fallbacks for bounded format-strict gate work.
- Keep the existing rule: **gemini-2.5-flash (subscription CLI door) stays OFF injection-exposed judging** — and now, with paid doors measured, it loses its remaining niche: every paid Gemini route beats it on accuracy.
- The Gemini injection-credulity finding from v2 is MODEL-GENERATION-specific, with a caveat. Adversarial-axis (planted-instruction) pass rates: gemini-2.5-flash **82%** (23/28 — the credulous one, confirming the v2 finding); the 3.x generation is materially more resistant — 3.5-flash and 3-flash-preview 100%, 3.1-pro 96–100%, but **3.1-flash-lite missed 2 of 28 on BOTH doors (93%)**. So: the hard "never" rule stays scoped to 2.5-flash; 3.1-flash-lite takes fast-lane slots but NOT the most injection-exposed judging slots (3.5-flash or 3.1-pro take those).
