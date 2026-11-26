# Side-Effects Review — Jev→Luna referee cascade

**Version / slug:** `jev-luna-referee-cascade`
**Date:** `2026-09-26`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier 1; observe-only research instrument, no decision surface, off by default)`

## Summary of the change

Operator directive (topic 95267, 2026-09-26): every Jev integration defaults to
a confidence cascade — Jev when confident, GPT-6 Luna in the unsure band. Adds
`src/core/JevCascade.ts` (band selection with per-rule overrides + a per-state
audit draw, fenced referee prompt, strict parse, one bounded referee call) and
wires it into `JevSignalShadow` behind `jevSignalShadow.referee.enabled`. The
server builds a dedicated `codex-cli` provider (own `LlmCircuitBreaker`) whose
`fast` tier resolves to `gpt-6-luna`.

## Decision-point inventory

- *(none)* — the shadow decides nothing. This adds `kind: 'referee'` rows to a
  research log.

---

## 1. Over-block

Nothing is blocked. "Not referred" outcomes are explicit rows: `busy`,
`daily-cap`, `scrub-error`, plus `timeout`/`error`/`unparseable` from the call.

## 2. Under-block

Coverage gaps, stated: one referee call at a time, so bursts produce `busy`
rows; the daily cap (default 300) bounds cost and coverage together; states
over 8,000 characters are clipped before the referee sees them. The referee is
itself a model and can be wrong — its verdict is a stronger reference, not
ground truth. The audit share exists so confident Jev answers are measured too.

## 3. Level-of-abstraction fit

Selection/prompt/parse live in one shared module so later integrations reuse
the same cascade instead of re-deriving it (the directive makes this the
default path). The shadow calls it at the existing chokepoint right after the
compared row is written, with the text, Jev's answers and the detector signals
already in hand.

## 4. Signal vs authority compliance

Signal-only. Per `docs/signal-vs-authority.md`, nothing here gates or blocks;
the referee verdict is logged beside Jev's, and no reader acts on it. Every
failure path writes a reason row; `askReferee` never throws.

## 5. Interactions

- Detached from the Jev dispatch: the referee does not hold the Jev in-flight
  slot, so referee latency cannot turn into lost Jev comparisons (tested).
- Own Codex provider + breaker: a referee rate-limit trip cannot pause the
  shared intelligence provider or the tone gate. It still passes the host-wide
  spawn cap inside the factory, so it cannot fork-bomb.
- Attributed as `JevLunaReferee` (category other, deferrable) so its spend
  appears in `/metrics/features`.

## 6. External surfaces

New egress: the secret-scrubbed text of an escalated message goes to OpenAI via
the agent's own Codex subscription. The same text already goes to TypeSafe for
the Jev comparison, and internal components already route to Codex by default,
so this adds a provider already trusted with internal traffic, not a new class
of recipient. Off by default; only rows with verdicts are written locally.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN, like the rest of the shadow: each machine refers its
own traffic and keeps its own log. Nothing replicates; no conversation state.

## 8. Rollback cost

Set `referee.enabled` false or remove the block — the live config read stops
referee calls on the next message, no restart. Existing referee rows are extra
JSONL lines readers can ignore. Code rollback is a revert of one PR.
