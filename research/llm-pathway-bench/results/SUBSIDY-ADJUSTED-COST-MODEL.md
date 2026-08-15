# Subsidy-Adjusted Cost Model — apples-to-apples $/token (topic 29723)

**Date:** 2026-07-02 · **Author:** Echo (on Opus 4.8; Fable-5 judging deferred until credits restored) · **Status:** first-order model, measured-value method. Refines with more burn-vs-utilization samples.

## The question this answers (Justin's #1 note)
> "compare the math with the subsidy included so we can have an apples-to-apples cost comparison … the Claude Max 20× subscription gives something like a 20× reduction … we need to find out those ratios and numbers … along with the Codex subsidy ratios."

The earlier report *asserted* "Claude Code on Max ~15–20× vs API" but never showed the arithmetic or a per-route effective-$/token column. This document computes the subsidy ratio from **measured usage**, not marketing.

## Method — value what we actually used at API list price
A subscription's real subsidy = (what the same tokens would have cost at pay-per-token API list price) ÷ (the flat subscription fee that delivered them). No guessing at fuzzy plan "message limits" — we read the token ledger and price it.

```
subsidy ratio  =  API-list value of measured usage (per month)
                  ─────────────────────────────────────────────
                  subscription plan price (per month)

effective $/Mtok (subscription route)  =  API-list $/Mtok  ÷  subsidy ratio
```

## Claude Max — MEASURED (this agent, 7-day window, Opus 4.8)

Token ledger, last 7 days (real, from `/tokens/summary`):

| Token class | Tokens (7d) | Opus-4.8 list $/Mtok | API-list value |
|---|---|---|---|
| cache-read | 257.1 M | $0.50 (10% of input) | $128.56 |
| cache-create | 19.5 M | $6.25 (1.25× input) | $121.99 |
| fresh input | 2.21 M | $5.00 | $11.04 |
| output | 1.84 M | $25.00 | $45.92 |
| **7-day total** | **280.7 M** | | **$307.50** |
| **≈ monthly** | | | **≈ $1,318** |

**Subsidy ratio (measured, cache-heavy agent workload):**
- vs Claude **Max $200/mo → ~6.6×**
- vs Claude **Max $100/mo → ~13.2×**

### The finding the marketing hides: the subsidy ratio is WORKLOAD-DEPENDENT
Our agent workload is **cache-dominated** — 92% of tokens are cache-read, priced at only $0.50/Mtok. So the API bill the subscription *displaces* is smaller than a fresh-token workload's would be, and the real subsidy is **~6–7×**, not 15–20×.

Counterfactual — the *same* token counts as **fresh input** (no prompt cache):
- API-list value ≈ **$6,172/mo → ~30.9× vs Max $200**.

**So "20×" is real only for fresh-token-heavy usage. For instar's cache-heavy agent traffic the honest number is ~6.6× on Max $200.** This matters for routing: the subsidy advantage of keeping a chatty, cache-warm sentinel on Claude is *smaller* than the sticker ratio implies — reinforcing the provider-fallback-default (route high-frequency internal work off Claude Code) on cost grounds, not just rate-limit grounds.

## Codex (GPT-5.x on subscription) — METHOD SET, awaiting samples
Codex plan: **Pro $200/mo** (confirmed live: `/codex/usage` → `planType: "pro"`, 5h primary window). This week's codex token ledger reads **0 tokens** (`/tokens/summary`.codex), so no measured value yet. Same method applies the moment codex traffic accrues: value the exec-json token counts at the GPT-5.5 list ($5/$30) or GPT-5.4-mini list ($0.75/$4.50) per the model actually run, ÷ $200. Codex's fixed per-call overhead is ~10k input tokens (R2 finding) — moderate, between pi (~1.1k) and claude-code (~20–24k).

## Gemini subscription — NO API SUBSIDY (structural)
Google's consumer subscription (AI Plus/Pro/Ultra) grants the Gemini **app** on an opaque "compute-used" quota with **no per-token API entitlement**. There is no subscription door to the Gemini API — paid API/Vertex is metered at list price. So Gemini's subsidy ratio is **1.0× (none)**; the native paid door bills at list. (This is exactly why the paid-Gemini-door bench needs a real billing-enabled key — pending operator payment-method setup.)

## Effective $/Mtok — apples-to-apples (first-order)
Blended $/Mtok assumes a 3:1 input:output mix; subscription effective = list ÷ subsidy ratio. Paid rows are list price (metered-prices.json, 2026-07-01).

| Route (model · door) | List $/Mtok in/out | Subsidy | **Effective $/Mtok (blended)** | Notes |
|---|---|---|---|---|
| Opus 4.8 · Claude Max $200 (cache-heavy) | 5 / 25 | ~6.6× | **~1.7** | measured; cache-dominated |
| Opus 4.8 · Claude Max $200 (fresh-heavy) | 5 / 25 | ~30× | **~0.37** | counterfactual ceiling |
| Opus 4.8 · OpenRouter | 5 / 25 | 1.0× | **~10.0** | list, +~5–6% top-up |
| GLM-5.2 · OpenRouter (paid) | 0.93 / 3.0 | 1.0× | **~1.45** | cheap frontier-ish, no ToS risk |
| DeepSeek-V4-Pro · OpenRouter | 0.435 / 0.87 | 1.0× | **~0.55** | benching now |
| GPT-5.5 · Codex Pro $200 sub | 5 / 30 | *tbd* | *tbd (~list÷ratio)* | awaiting codex samples |
| GPT-5.5 · OpenRouter | 5 / 30 | 1.0× | **~11.25** | list |
| Gemini-3.1-Pro · paid API | 2 / 12 | 1.0× | **~4.5** | needs billing-enabled key |
| Haiku 4.5 · API | 1 / 5 | 1.0× | **~2.0** | cheap Claude tier |
| Gemini-3.1-Flash-Lite · API | 0.25 / 1.5 | 1.0× | **~0.56** | cheap workhorse |

## The apples-to-apples takeaway
1. **Subscription Opus on Max $200 for cache-heavy work (~$1.7/Mtok effective) beats OpenRouter-Opus ($10) by ~6×** — but is only ~on par with paid GLM-5.2 ($1.45) and *loses* to DeepSeek-V4-Pro ($0.55). So Justin's instinct was right: even WITH the subsidy, a cheap paid frontier model can beat subsidized Claude on pure cost.
2. **The subsidy is not a flat 20×.** It's ~6.6× for our real cache-heavy workload; the 20× marketing figure only holds for fresh-token-heavy usage we don't actually generate.
3. **Cost is necessary but not sufficient** — this is the cost axis only. The routing default must weigh effective-$/token against quality (bench scores) and availability (Claude rate-limits, ToS). A model that's cheapest-per-token but fails the task, or walls on rate limits, is not the default.

## Sharpening steps (tracked)
- Capture **burn-vs-utilization** correlation as the subscription quota moves off 0% (currently freshly reset) → tighten the measured monthly-value extrapolation beyond the single 7-day window.
- Add Codex effective-$/Mtok once codex traffic accrues real token samples.
- Re-value once the paid-Gemini native door produces measured per-token costs.
