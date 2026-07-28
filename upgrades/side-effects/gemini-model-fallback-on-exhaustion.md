# Side-Effects Review — Gemini per-model exhaustion switches model before deferring

**Version / slug:** `gemini-model-fallback-on-exhaustion`
**Date:** `2026-06-04`
**Author:** `echo`
**Second-pass reviewer:** `required (LLM-routing behavior change)`

## Summary of the change

When a Gemini call hit a capacity limit, `decideGeminiCapacityPolicy` (after its
short-window immediate-retry path) went straight to a GLOBAL `defer` on the SAME
model, and `recordGeminiCapacityDeferral` wrote a `quota-state.json` snapshot with
`fiveHourPercent: 100` / `recommendation: 'stop'`. But the known Gemini models —
`gemini-2.5-flash` and `gemini-2.5-pro` — draw on **separate** quotas. So one model
exhausting (e.g. "You have exhausted your capacity on this model. Quota resets after
46m") was recorded as a full account-wide block, and any reader of `quota-state.json`
(including the agent itself, the mentor, the escalation monitor) saw `recommendation:
'stop'` and concluded the whole Gemini agent was down — even when the account had
headroom on the other model. This caused repeated false "Gemi is blocked" reports
(confirmed live this session: a `gemini -p` probe returned that exact error while
`/stats` showed the account at 20% remaining on Auto).

The fix (mirrors the existing codex auto-swap-on-limit policy, #31): on per-model
exhaustion, record the exhausted model's reset window, then switch to a known model
with headroom and retry. Only when **every** known model is exhausted do we globally
defer and write the stop-state — now tagged `scope: 'account'`. Because the caller
records a deferral only on `action: 'defer'`, switching models also means a single-
model exhaustion no longer writes a global stop at all.

## Decision-point inventory

1. **`decideGeminiCapacityPolicy` (long-reset branch):** record `model` as exhausted
   (time-based, `now + deferMs`); pick a fallback via `pickGeminiFallbackModel`; if
   one exists → `retry` with that model; else → `defer`.
2. **`pickGeminiFallbackModel`:** a candidate qualifies when known, ≠ the exhausted
   model, and not itself inside a recorded exhaustion window at `now`. Prefers an
   operator-configured `fallbackModel`, else the first known model with headroom.

## 1. Over-block (what still defers / blocks)

- When ALL known models are in an exhaustion window → `defer` + the global stop-state
  (now `scope: 'account'`). That is the genuine account-wide block and still gates
  scheduler spawns exactly as before. (tests: "defers once ALL models exhausted",
  integration "defers after a long quota reset", e2e lifecycle.)
- The short-window immediate-retry path (attempt < maxImmediateRetries, small reset)
  is unchanged.
- Non-capacity errors are unchanged — `decide` returns `none` and the error surfaces.

## 2. Under-block (what it now allows that it didn't)

- A single model exhausting now triggers ONE extra Gemini spawn on the other model
  (the switch) before any deferral. Worst-case cost when BOTH models are exhausted:
  two spawns instead of one (flash then pro) before the global defer — bounded at 2
  (one per known model; each is recorded exhausted so it is never retried within its
  window). The model-switch retry uses a 250ms backoff (not the 5s same-model
  backoff) since a different model needs no wait.
- Loop-safety: `modelExhaustedUntil` is time-based and self-clears once a window
  passes, so there is no permanent state and no A→B→A switch loop (each model is
  recorded before fallback selection; once both are recorded, `pickGeminiFallbackModel`
  returns undefined → defer). (tests: "returns undefined once both exhausted",
  "windows self-clear once the reset passes".)

## 3. Blast radius

- One file of logic: `src/providers/adapters/gemini-cli/observability/geminiCapacityPolicy.ts`
  (new module state `modelExhaustedUntil`, new export `pickGeminiFallbackModel`, a
  `now?` param on `decide`, the switch-before-defer branch, `scope` on the stop-state,
  reset clears the map).
- NO consumer signature changes: both callers (`transport/oneShotCompletion.ts`,
  `core/GeminiCliIntelligenceProvider.ts`) already switch to `decision.model` on
  `action:'retry'` and record a deferral only on `action:'defer'`.
- Affects only Gemini-CLI agents. Claude / codex paths untouched. The added
  `scope` field is additive (readers that don't know it are unaffected).

## 4. Reversibility

Fully reversible: revert the one policy file + the test updates. Module state is
in-process and time-based (no persistence); the `quota-state.json` shape only gains
an additive `scope` field. Verified: `tsc --noEmit` clean; 21 tests green across
unit + integration + e2e + escalation tiers (both the switch path and the genuine
all-models-defer path).
