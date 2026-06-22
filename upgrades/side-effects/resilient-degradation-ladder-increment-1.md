# Side-Effects Review — Resilient Degradation Ladder Increment 1 (path-dependent ladder core)

**Slug:** `resilient-degradation-ladder-increment-1` · **Tier:** 2 (spec-driven; converged +
operator-approved). **Spec:** `docs/specs/resilient-degradation-ladder.md` §3 (rungs a + gating
budget), §5 D1–D3.

## Summary of the change

The v1 core of the degradation ladder, dark/dev-gated, in `IntelligenceRouter`'s gating-failure
`catch`:
- `attribution.deferrable` flag (types.ts) — marks BACKGROUND work not synchronously awaited.
- `intelligence.degradationLadder` config (types.ts) — `gatingLadderBudgetMs`, `backoff` bounds.
- Router ladder: a DEFERRABLE call on a rate-limit BACKS OFF (sets `options.rateLimitWaitMs` so the
  provider-layer `acquireOrWait` waits, bounded + jittered, ≤ maxAttempts) before swapping; a GATING
  call gets NO backoff and the whole failure path is capped by a single `gatingLadderBudgetMs`
  wall-clock deadline (responsiveness); framework-swap now applies to deferrable too.
- Server wiring (server.ts) resolves the ladder via `resolveDevAgentGate` (live-on-dev / dark-fleet);
  `DEV_GATED_FEATURES` registration (devGatedFeatures.ts).

NOT in this increment (later): the queue rung, the never-silent tracking, the per-call account-swap.

## Decision-point inventory

All frozen in spec §5 (D1 config + dark rollout; D2 backoff bounds 500/×2/3/8s/60s; D3
gatingLadderBudgetMs=6s, load-bearing). No callsite decision introduced.

## 1. Over-block (false positive)

The deferrable backoff only fires on `isRateLimitError(err)` (RateLimitError name OR a
rate-limit/usage-limit/429 message); a HARD error skips backoff and goes straight to swap (tested).
So a non-rate-limit failure is never slowed. The gating budget only CAPS the gating failure path
sooner — a gate still fails closed (never a heuristic); capping at 6s is more responsive, never less
safe.

## 2. Under-block

Backoff applies only to DEFERRABLE (caller-declared) calls. A gating call (awaited) gets no backoff
(can't stall) and is never queued (gating dominates deferrable — tested). When the ladder is OFF
(fleet default, unconfigured) the router is byte-for-byte today's behavior (tested:
"ladder absent ⇒ today's behavior").

## 4. Signal vs authority

The router takes no destructive action; it only chooses which provider serves a call and reports
each transition via the existing `onDegrade` (→ DegradationReporter / /metrics/features). The
heuristic last-resort and the gating fail-closed are UNCHANGED behaviors; this increment only
re-orders the deferrable path and bounds the gating path.

## 5. Interactions

The existing framework-swap loop is preserved; the gating-budget deadline check is added at the TOP
of each swap iteration (so a gating call that exceeds its budget stops swapping). The existing
`swapAttemptTimeoutMs` per-attempt cap is unchanged. The deferrable backoff is NEW and only runs on
a rate-limit before the swap. The existing `provider-fallback-swap-timeout.test.ts` (the swap loop's
own tests) is unaffected.

## 6. External surfaces

No new route. Additive config (`intelligence.degradationLadder`) + one additive attribution field
(`deferrable`), both optional. No persistence, no messaging.

## 6b. Operator-surface quality

N/A — no operator/dashboard/approval surface (enabling is a config edit / the dev-agent gate).

## Framework generality

The ladder operates DOWNSTREAM of framework routing (inside the resolved framework's failure
`catch`), so it is framework-agnostic — it works for whichever framework a component routed to. The
account-global breaker scope (the wait it leans on) is documented in the spec §2.

## 7. Multi-machine posture

Per-process / machine-local: each machine's router handles its own internal calls. No replicated
state, no cross-machine contract. (Rung-b account-swap, the only cross-machine concern raised in
review, is out of v1.)

## 8. Rollback cost

Trivial: the ladder is dark on the fleet (the construction returns `undefined` unless dev-gated /
configured), so reverting is removing an unused-on-fleet code path. An operator who enabled it sets
`intelligence.degradationLadder.backoff.enabled: false`. The `attribution.deferrable` field defaults
false at every unmodified callsite.

## Evidence pointers

- `tests/unit/degradation-ladder.test.ts` (8): deferrable backoff retries+succeeds (sets
  rateLimitWaitMs); backoff-exhausted→swap; gating has NO backoff (fail closed); gating-budget
  consumed→stops swapping before all targets; non-gating-non-deferrable=today's behavior;
  gating-dominates-deferrable; backoff-only-on-rate-limit; ladder-absent=today's behavior.
- The `DEV_GATED_FEATURES` both-sides wiring test confirms the new entry resolves live-on-dev /
  dark-on-fleet.
- `provider-fallback-swap-timeout.test.ts` (existing swap-loop tests) unaffected. Full `npm run lint`
  (incl. lint-dev-agent-dark-gate) + `tsc` green.

## Conclusion

The behavior-preserving-when-off, dev-gated v1 of the degradation ladder: deferrable work slows down
before switching; an awaited gate stays responsive (6s budget) and still fails closed. Ship.
