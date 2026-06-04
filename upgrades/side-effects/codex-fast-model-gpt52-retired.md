# Side-Effects Review — Codex `fast` tier off retired `gpt-5.2`

**Version / slug:** `codex-fast-model-gpt52-retired`
**Date:** `2026-06-03`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier-1 bug fix — model-string re-point + tests, no decision surface)`

## Summary of the change

Two Codex model-tier maps hardcoded `fast`/`haiku` → `gpt-5.2`. OpenAI retired `gpt-5.2`
from the ChatGPT-account Codex surface (live 400 as of 2026-06-03), silently breaking every
cheap Codex call fleet-wide. Both maps now resolve `fast`/`haiku` → `gpt-5.4-mini` (the
cheapest model still accepted). A new unit test pins both resolvers and guards the retired
name. No routes, config, schema, or external surface change.

## Decision-point inventory

1. **Which replacement model?** Candidates still accepted (empirically probed 2026-06-03):
   `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5`. Chose `gpt-5.4-mini` — the cheapest (it is already
   the validated `balanced` tier; "mini" < plain `gpt-5.4`). `gpt-5.2` was the only
   *non-reasoning* model, so no zero-reasoning option remains; this is the least-cost working
   choice, not a free one.
2. **Re-point now vs. build the drift-resilient fallback first?** Chose to ship the re-point
   immediately (it stops an active fleet-wide failure) and leave the structural fallback
   (validate-against-known-good + auto-fall-back on a 400) as a follow-up. Rationale: the
   urgent fix is small and regression-safe; the fallback is a larger, separately-testable
   surface that shouldn't gate the stop-the-bleeding change.

## 1. Cost / quota

`fast` was the cheap non-reasoning tier (gpt-5.2 ≈ 103 tokens on a trivial prompt vs ~5–7k
for reasoning models). Moving it to a reasoning model (`gpt-5.4-mini`) raises per-call token
burn for all cheap Codex calls. This is **unavoidable** (gpt-5.2 is gone) but worth flagging
against the known self-inflicted cheap-call 429 pressure on the shared ChatGPT account — it
makes the structural drift-resilient fallback (and any cheap-call-volume reduction) more
valuable, not less. No way to keep the old cost without the retired model.

## 2. Tier collapse

`fast` now equals `balanced` (`gpt-5.4-mini`). Callers that distinguished the two tiers by
cost no longer get a cheaper `fast`. Acceptable: there is no cheaper accepted model. Reverts
automatically if/when a cheaper non-reasoning model is re-added to the map.

## 3. Blast radius / reversibility

Two string literals + comment updates + one new test + two updated assertions. Fully
reversible (revert the two map entries). Claude and Gemini resolvers are untouched
(framework-scoped branches). No effect on API-key callers passing raw model names (those
pass through verbatim — unchanged).

## 4. Tests

- New `tests/unit/codex-model-tier-resolution.test.ts`: both resolvers per tier + a
  retired-`gpt-5.2` regression guard over `fast/balanced/capable/haiku/sonnet/opus` and the
  undefined default.
- Updated `session-manager-behavioral` (codex session spawn: haiku → `gpt-5.4-mini`) and
  `StallTriageNurse` (legacy haiku alias → `gpt-5.4-mini`).
- Transcript-fixture tests that contain `model: 'gpt-5.2'` (TokenLedger, CodexRolloutParser)
  are unchanged — they parse historical rollouts and a past session legitimately used gpt-5.2.
