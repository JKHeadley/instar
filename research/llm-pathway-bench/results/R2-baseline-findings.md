# R2 Finding — Baseline latency/throughput (uncontended, N=30, concurrency 1)

**Date:** 2026-07-01 · synthetic `ping` prompt · warm (steady-state) · isolated clean-CWD.
Codex baseline (3 pathways) runs separately in the background (~50s/call); appended when done.

## Fast pathways (complete)
| Pathway | model | p50 | p95 | p99 | meanIn | meanOut | okRate |
|---|---|---|---|---|---|---|---|
| claude-sonnet | claude-sonnet-4-6 | 2,899ms | 5,514ms | — | 22,903 | 6 | 1.00 |
| claude-opus | claude-opus-4-8 | 3,036ms | 5,785ms | — | 19,544 | 5 | 1.00 |
| claude-haiku | claude-haiku-4-5 | 3,544ms | 5,821ms | — | 23,662 | 62 | 1.00 |
| pi-gpt55 | openai-codex/gpt-5.5 | 4,607ms | 7,157ms | — | (n/a) | (n/a) | 1.00 |
| gemini-flash | gemini-2.5-flash | 8,538ms | 15,726ms | — | (n/a) | (n/a) | 1.00 |

## Findings
1. **Warm ≪ cold.** Steady-state p50 (~3s claude, ~4.6s pi) is 2–7s faster than the
   single-shot smoke (R1b). Cold-start (CLI boot) dominates one-off calls; anything doing
   repeated calls amortizes it. Relevant for bursty sentinel traffic vs a warm session.
2. **claude tiers cluster tight (~2.9–3.5s p50)** — for a trivial prompt, tier (haiku/
   sonnet/opus) barely changes latency; the fixed CLI+harness overhead dominates over model
   compute. Model choice for tiny classification calls is about quality/cost, not speed.
3. **Instruction-following signal: haiku emitted 62 output tokens** for "reply with exactly
   one word", vs 5–6 for sonnet/opus. haiku is the least tight at following a terse-output
   instruction — a quality caveat when using haiku for single-token classifiers.
4. **gemini is the slowest + most variable fast pathway** (p50 8.5s, p95 15.7s — a 1.85x
   p50→p95 spread vs ~1.6x for claude). Higher tail risk under a latency SLO.
5. **pi (GPT-5.5) at 4.6s p50 is competitive** and materially faster than codex's GPT-5.5
   (R1b: ~61s cold) — reinforces the R5 redundant-route signal.

## Harness limitation found
- **Token parsing is unimplemented for pi and gemini** (`meanIn/meanOut` = null). The
  parseTokens() function only handles claude JSON + codex exec-json. pi's `message` mode and
  gemini's `yolo` mode outputs aren't parsed. Cost comparison for pi/gemini needs either a
  parser addition or an out-of-band token source. Logged as an R2 gap; revisit in R5 (cost
  parity) — may require probing each CLI's usage-reporting format.

## Confidence
- N=30/cell, single time window so far. A second-window repeat (variance check) is pending;
  the codex baseline naturally runs in a later window, giving a cross-window read for at
  least the claude tiers when repeated.

## Codex baseline (appended — codex-gpt55 complete N=30; mini/plain finishing)
| Pathway | p50 | p95 | p99 | max | meanIn | okRate | errors |
|---|---|---|---|---|---|---|---|
| codex-gpt55 | 18,053ms | 43,343ms | 86,241ms | 86,241ms | 11,735 | 0.967 | 1 timeout |

**The codex story is the TAIL, not the median.** Median 18s is already 6x claude's ~3s, but the
p95 (43s) and p99 (86s) are the real problem: even warm and uncontended at concurrency 1, a codex
call can randomly take 86 seconds. 1 of 30 hit the 120s wall (a wedge) with quota 96% free.
This is worse than "consistently slow" — it's UNPREDICTABLE, so any fixed gate/timeout budget will
be intermittently blown. Directly reinforces R4 (codex-quota-free-errors): the 30s internal timeout
is below codex's p50→p95 band, so cold/tail calls time out as false errors. mini/plain rows append
when their N=30 runs finish.

## R2 COMPLETE — full 8-pathway baseline (N=30, c=1, uncontended)
| Pathway | p50 | p95 | p99 | okRate | fixed-in-tok* |
|---|---|---|---|---|---|
| claude-sonnet | 2,899ms | 5,514ms | 23,928ms | 1.00 | ~22,903 |
| claude-opus | 3,036ms | 5,785ms | 7,441ms | 1.00 | ~19,544 |
| claude-haiku | 3,544ms | 5,821ms | 8,069ms | 1.00 | ~23,662 |
| pi-gpt55 | 4,607ms | 7,157ms | 11,547ms | 1.00 | ~1,088* |
| gemini-flash | 8,538ms | 15,726ms | 17,228ms | 1.00 | ~5,960* |
| codex-gpt54mini | 15,523ms | 38,678ms | 51,192ms | 1.00 | ~10,004 |
| codex-gpt55-plain | 15,586ms | 40,625ms | 41,223ms | 1.00 | (plain mode; ~11k) |
| codex-gpt55 | 18,053ms | 43,343ms | 86,241ms | 0.967 | ~11,735 |
*pi/gemini token counts from the dedicated token-parse test (their baseline runs predate the parser fix).

**Conclusions:** (1) three latency tiers — fast (claude ~3s), mid (pi 4.6s, gemini 8.5s), slow
(codex 15-18s). (2) Codex is uniformly slow across ALL models+modes with a brutal tail (p99 41-86s)
— it's the pathway itself, not a model choice. (3) claude has the tightest tail (except one sonnet
outlier at 24s). (4) Cost/latency both favor pi for high-frequency work. R2 confidence: N=30/cell,
okRate 0.97-1.00; codex's single timeout corroborates R4.
