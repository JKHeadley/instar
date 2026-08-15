# Review Record — CompletionEvaluator (goal-met judge) prompt edit (completion-judge)

**Status: NO-SHIP (incumbent stands after 3 variants) — finding recorded**

## What changes
File: src/core/CompletionEvaluator.ts:137 (canonical main).

Adds the claim-is-not-evidence discriminator: an agent SAYING a check passed is a claim; evidence is the surfaced artifact/output the condition names; a bare assertion = NOT_MET.

Variant under test: research/llm-pathway-bench/instar-bench-v2/variants/completion-judge.*.json (exact winning text ships verbatim).

## Why (forensic evidence)
bound-bare-assertion failed on 5 models across doors (xms 0.6): llama-3.3-70b, glm-5.2, llama-4-scout, gpt-oss-20b (metered) + gemini-2.5-flash (CLI). gpt-oss-20b even fabricated 'displayed the summary output'. Verdicts: prompt-improvable cluster in both runs.

## Risk & rollback
Low. Tightens toward NOT_MET (fail-closed direction for a stop gate). Watch A/B for regressions on MET-expected cases (canon-met-artifact, bound-met-exact, ctx-buried-evidence).

## A/B result
_(pending — ab-completion-judge stamps; ratchet: win = ≥1 previously-failing cell fixed, 0 previously-passing cells regressed)_

## A/B result — v1 variant (ab-completion-judge, FINAL after infra-exclusion)
**REGRESSION — must not ship: fixed 3, regressed 10.** The clause fixed its target (bound-bare-assertion on opus/gemini-flash/llama-scout) but OVER-TIGHTENED: canon-met-artifact (MET-expected, real evidence shown) regressed on 6 routes — models began rejecting surfaced evidence as insufficient. v2 authored with a balancing side (surfaced evidence COUNTS; do not demand beyond the condition; do not reject evidence because the agent also asserts). Re-A/B queued after the driver sequence.

## Final ruling after v2 + v3 (2026-07-02 ~04:10)
- v2 (balanced evidence-counts clause): arbitrated at x3 — one REAL regression held (sonnet::canon-met-artifact 0/3: with any claim-vs-evidence language present, sonnet re-classifies agent-stated specifics as assertions).
- v3 (specificity discriminator: SHA/numeric-summary/PR-number count even when agent-stated): NO-GAIN — 0 fixed, 0 regressed. The discriminator removed the over-tightening but stopped fixing the original bare-assertion cells.
- RULING: the incumbent prompt stands. The bare-assertion weakness is REAL (5 models across doors credit unspecific claims) but is better addressed by ROUTING (models that pass: sonnet/haiku/codex/pi tiers) than by prompt surgery — three wordings each failed the ratchet differently. Re-visit only with a redesigned case battery separating speaker-vs-specificity axes.
