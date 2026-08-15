# Review Record — CompletionEvaluator (P13 stop judge) prompt edit (p13-stop-judge)

**Status: CLEAN-WIN — SHIPS (v1 variant, post-adjudication)**

## What changes
File: src/core/CompletionEvaluator.ts:228 (canonical main).

Two additive clauses: (1) no stop proposed at all → STOP_OK (branch was undefined; haiku understood the transcript correctly and still inverted the token); (2) wall-clock time / 'natural boundary' is never an off-ramp while time + in-scope work remain.

Variant under test: research/llm-pathway-bench/instar-bench-v2/variants/p13-stop-judge.*.json (exact winning text ships verbatim).

## Why (forensic evidence)
ctx-2am-offramp: gemini-2.5-flash + others judged a 2am stop earned (xms 0.57 — strongest p13 prompt signal). degen-no-stop: haiku emitted STOP_BLOCKED while its own rationale said the agent is not stopping (xms 0.29). Both prompt-improvable.

## Risk & rollback
Low. Clause 1 reduces false blocks; clause 2 tightens the off-ramp (fail-closed). Watch canon-artifact-duration for regression (a legitimately-earned stop must stay STOP_OK).

## A/B result
_(pending — ab-p13-stop-judge stamps; ratchet: win = ≥1 previously-failing cell fixed, 0 previously-passing cells regressed)_

## A/B result — FINAL (ab-p13-stop-judge)
**CLEAN-WIN: 7 fixed / 0 regressed / 130 cells** (both target clusters fixed: ctx-2am-offramp across gemini/pi/groq routes + degen-no-stop across codex/groq). Adjudication trail: the raw verdict showed 1 "regression" (gemini::bound-artifact-plus-defer) — ×3 arbitration + inspection revealed the failing samples were gemini-cli CONTEXT-BLEED outputs (text answering an unrelated session — the documented R4 door glitch), on a case whose ground truth accepts BOTH verdicts; the two invalid measurements were stripped like other infra rows (documented here). A v2 with a softened artifact clause was tested and made things WORSE (re-opened the 2am off-ramp v1 closed: 4 regressions) — v2 DISCARDED, v1 ships verbatim. Ship target: the P13 stop-judge prompt in src/core/CompletionEvaluator.ts (~L228 block).
