# Side-Effects Review — Resilient Degradation Ladder Increment 3 (queue rung)

**Slug:** `resilient-degradation-ladder-increment-3` · **Tier:** 2 (spec-driven; the spec converged +
operator-approved, rode Increments 1/2). **Spec:** `docs/specs/resilient-degradation-ladder.md` §3b.3,
§3c, D1/D5/D7.

## Summary of the change

The third (and final) rung of the operator's degradation principle — "prefer slowing down over
falling back". Dark/dev-gated:

- `IntelligenceRouter` gains a DEFERRABLE **queue rung** (`tryDeferrableQueue`): a non-gating call
  that has exhausted backoff + framework-swap now WAITS for capacity in a dedicated `LlmQueue`
  (`background` lane) before dropping to the caller's heuristic. The enqueued `provider.evaluate`
  honors the account-global breaker's `retryAfterMs` via `acquireOrWait` — that IS the §3b.3
  rate-awareness. Inserted at BOTH fall-through points (no-swap-configured AND swap-exhausted) before
  the existing `onHeuristicFallthrough` + throw.
- A structural `DeferrableQueue` interface declared in `core` (the real `LlmQueue` satisfies it) so
  `core` does NOT import `monitoring` (no layering cycle).
- `LlmQueue` gains an opt-in `backgroundDispatchMinGapMs` (§3c herd guard): a jittered minimum gap
  between BACKGROUND-lane dispatches; interactive bypasses. Default 0 = OFF (today's greedy drain).
- Server wires a DEDICATED `LlmQueue` for the rung (built ONLY when the gate-resolved `queueEnabled`
  is true), gate-resolves `queueEnabled`/`queueAttemptTimeoutMs` via `resolveDevAgentGate`, and the
  ladder object is now present when ANY rung (backoff OR queue) is active.
- `DEV_GATED_FEATURES` registration (`degradationLadderQueue`).
- Config type extended: `degradationLadder.queue` → `{ enabled?, attemptTimeoutMs?, drainMinGapMs? }`.

## Decision-point inventory (frozen)

D1 (config + dark rollout), D5 (`gating:true` ⇒ queue-skipped, code-enforced), D7 (reason taxonomy
`queued` / `queue-rejected`). Increment-3 bounds (sensible defaults, dark/reversible, fit D1's
`{enabled, …bounds}` structure): `queueAttemptTimeoutMs` 60000, dedicated queue `maxConcurrent` 1 +
`maxDailyCents` 25, `drainMinGapMs` 0 (off).

**D9 (new, recorded here) — the §3c herd guard is opt-in, realized two ways:** (1) the PRIMARY
rate-awareness is the provider-layer `acquireOrWait` — each enqueued `evaluate` waits for the
account-global breaker window, so queued calls don't hammer a rate-limited account; (2) the dedicated
queue's `maxConcurrent: 1` serializes deferrable retries (naturally herd-safe); (3) `drainMinGapMs`
adds an OPTIONAL jittered inter-dispatch gap (off by default). Explicit pacing is opt-in so existing
`LlmQueue` callers (PresenceProxy / PromiseBeacon) see ZERO behavior change. This faithfully delivers
§3b.3/§3c without rebuilding shared infrastructure (round-1 "extend, don't rebuild").

## 1. Over-block / false positive

The rung only ADDS a wait-for-capacity step on a DEFERRABLE call that already exhausted swap; it never
blocks an interactive/gating call. A queued call that fails or is rejected falls through to exactly
today's heuristic — strictly no worse than before. No new block surface.

## 2. Under-block

A GATING call NEVER reaches the queue rung: `deferrable = !gating && options.deferrable === true`, so
`if (deferrable) …tryDeferrableQueue` is structurally unreachable for a gate (D5). Unit-tested
(`GATING is NEVER queued`). The gating fail-closed boundary is unchanged.

## 4. Signal vs authority

The queue rung takes no destructive action — it waits for capacity then returns a real answer, or
falls through. The two `onDegrade` emissions (`queued` / `queue-rejected`) are observability signals
(D7), never gates. Consistent with Signal-vs-Authority.

## 5. Interactions — wedge-safety

Reuses the EXISTING `LlmQueue` (the wedge-safe, bounded, daily-capped queue). The new drain-pacing is
a bounded `setTimeout` coalesced to at most one pending timer (no stacking), `unref`'d (never holds the
process open). No new recursion, no growing array, no `report()`/`reportEvent()` call from the rung —
the 2026-06-21 DegradationReporter wedge class cannot recur here. The dedicated queue is built only
when the rung is active, so the fleet allocates nothing.

## 6. External surfaces

No new route. No new egress — a queued call is the SAME provider.evaluate that would otherwise have
run; it just waits for capacity. The new config (`intelligence.degradationLadder.queue.*`) is opt-in.

## Framework generality

Framework-agnostic — the rung keys on the resolved framework and enqueues whatever provider the
component routes to.

## 7. Multi-machine posture

Machine-local: each machine's router + its dedicated queue are independent. No replicated state, no
cross-machine contract (the dedicated queue is per-process, same posture as the existing per-sentinel
queues).

## 8. Rollback cost

Trivial: dark on the fleet (`queueEnabled` resolves dark; no dedicated queue is built, the ladder's
`queueEnabled` is false, and `tryDeferrableQueue` returns `{ ok: false }` immediately ⇒ exactly
today's heuristic-on-exhaustion). Revert = remove an unused-on-fleet code path. `drainMinGapMs` defaults
0 so existing `LlmQueue` callers are untouched.

## Evidence pointers

- `tests/unit/degradation-ladder.test.ts` (+7 queue cases): queue success + onResolved; order
  backoff/swap → queue → success; GATING never queued (D5); enqueue REJECTION ⇒ heuristic fallthrough
  + onHeuristicFallthrough; non-deferrable never queued; queueEnabled-but-no-llmQueue no-op;
  queueEnabled:false not enqueued.
- `tests/unit/LlmQueue.test.ts` (+3 pacing cases): paces a 2nd background dispatch when the gap is set;
  no pacing when off (both start at once); interactive bypasses pacing.
- `tests/unit/devGatedFeatures-wiring.test.ts` auto-covers `degradationLadderQueue` (live-on-dev /
  dark-on-fleet). `tests/unit/no-silent-fallbacks.test.ts` stays at baseline 476. Full `tsc` +
  `lint-dev-agent-dark-gate` green.

## Conclusion

Delivers the final rung of the operator's degradation principle — a deferrable call now WAITS for
capacity (slow down) before ever dropping to a brittle heuristic, with the provider breaker supplying
rate-awareness and an opt-in herd gap on top. Dark/dev-gated, no-op when off, wedge-safe. Ship.
