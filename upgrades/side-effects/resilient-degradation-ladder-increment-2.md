# Side-Effects Review — Resilient Degradation Ladder Increment 2 (never-silent tracking)

**Slug:** `resilient-degradation-ladder-increment-2` · **Tier:** 2 (spec-driven; converged +
operator-approved). **Spec:** `docs/specs/resilient-degradation-ladder.md` §4, D6.

## Summary of the change

The never-silent half of the operator's principle ("never silently remain degraded indefinitely"),
dark/dev-gated:
- `DegradationReporter` gains an open-degradation lifecycle (§4): `openDegradation` /
  `resolveDegradation` / `sweepOpenDegradations` / `configureNeverSilent`, keyed on
  `(component, framework)`, bounded by MAX_OPEN, O(1) per open/resolve.
- `IntelligenceRouter` gains `onHeuristicFallthrough` (fired at each NON-gating throw — the caller
  will use its heuristic) + `onResolved` (fired at each successful real-LLM answer) hooks.
- Server wires the hooks to the reporter + calls `configureNeverSilent` (dev-gated via
  `resolveDevAgentGate`) + starts a 60s `unref`'d sweep timer.
- `DEV_GATED_FEATURES` registration (`degradationLadderNeverSilent`).

## Decision-point inventory

Frozen in spec §5 D6: escalateMs 15m, TTL 30m, MAX_OPEN 500, key (component, framework),
liveness-gated (≥1 retry to escalate; TTL-close otherwise), deduped per episode.

## 1. Over-block / false positive

The big false-positive class (round-1): a run-once / idle component that degrades once and never
calls again. Closed by the LIVENESS gate — a degradation with 0 retries since open AUTO-CLOSES at
the TTL instead of escalating (tested). Only a degradation that genuinely RE-attempted and still
fell to heuristic (≥1 retry) escalates. Escalation is deduped per episode (re-escalates only after
another full window — tested).

## 2. Under-block

Tracking only opens on a NON-gating heuristic fallthrough (where the heuristic actually runs); a
gating fail-closed is NOT tracked (it's the safe outcome, not a heuristic — tested:
onHeuristicFallthrough does NOT fire for a gating call). No-op when disabled.

## 4. Signal vs authority

The escalation is an attention SIGNAL (a deduped fixed-template Telegram line), never a gate. It
takes no destructive action. The auto-resolve is observational (a successful call clears the open
state). Consistent with Signal-vs-Authority.

## 5. Interactions — THE WEDGE-CRITICAL SECTION

§4 extends the exact `DegradationReporter` subsystem that caused the 2026-06-21 event-loop wedge
(`gateHealthAlert`→`toneGate.review`→router→`report`→`reportEvent`→recursion + growing-array
JSON.stringify). This increment is designed to NOT repeat it:
- The sweep NEVER calls `report()`/`reportEvent()`/`gateHealthAlert` — it surfaces an attention item
  via `telegramSender` DIRECTLY (no toneGate, no events-array growth, no recursion). Tested: the
  escalation path sends via the fake telegramSender, never through report.
- The open map is BOUNDED (MAX_OPEN; oldest evicted — tested) — no unbounded growth.
- open/resolve are O(1) Map mutations — no full-map serialize per event.
- The existing `_gatingHealthAlert` reentrancy guard + `MAX_EVENTS` cap are untouched.

## 6. External surfaces

No new route. The only new egress is the deduped escalation line (the operator's explicit want).
The new config (`intelligence.degradationLadder.neverSilent`) shipped in Increment 1's types.

## 6b. Operator-surface quality

N/A — no dashboard/approval surface. `openDegradationCount()` is a read-only observability getter.

## Framework generality

Framework-agnostic — the hooks key on the resolved framework; works for whichever framework the
component routes to.

## 7. Multi-machine posture

Machine-local: each machine's reporter tracks its own degradations + its own sweep timer. No
replicated state. (A sustained per-machine degradation could double-alert on a 2-machine setup for
one provider outage — accepted as a minor local-dedup limitation, noted in the spec §6.)

## 8. Rollback cost

Trivial: dark on the fleet (`configureNeverSilent({enabled:false})` when not dev/configured) — the
lifecycle methods are all `if (!enabled) return` no-ops and no sweep timer is started. The router
hooks are no-ops downstream when disabled. Revert = remove an unused-on-fleet code path.

## Evidence pointers

- `tests/unit/degradation-never-silent.test.ts` (6): open→resolve duration; run-once TTL-auto-close
  (NO escalation); stuck (≥1 retry) escalates once past the window + deduped + re-escalates after a
  new window; (component,framework) keying (no cross-resolution); bounded (MAX_OPEN evict);
  disabled=no-op.
- `tests/unit/degradation-ladder.test.ts` (+3 hook cases): onResolved on success; onHeuristicFallthrough
  on a non-gating exhaustion; onHeuristicFallthrough does NOT fire for a gating call.
- The `DEV_GATED_FEATURES` both-sides wiring test confirms `degradationLadderNeverSilent` resolves
  live-on-dev / dark-on-fleet. Full `npm run lint` (incl. lint-dev-agent-dark-gate) + `tsc` green.

## Conclusion

Delivers the never-silent guarantee — a heuristic fallback can no longer silently persist
indefinitely: it auto-resolves on recovery and escalates if genuinely stuck — built carefully to NOT
repeat the wedge it extends. Dark/dev-gated, no-op when off. Ship.
