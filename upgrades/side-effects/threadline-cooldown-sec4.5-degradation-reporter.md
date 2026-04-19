# Side-Effects Review — Threadline §4.5 commit 2: DegradationReporter integration on edge transitions

**Version / slug:** `threadline-cooldown-sec4.5-degradation-reporter`
**Date:** 2026-04-19
**Author:** echo
**Second-pass reviewer:** not required (sink-only observability; transitions are detected on edges; sink errors are swallowed)

## Summary of the change

Final commit of §4.5. Wires SpawnRequestManager to emit edge-transition events for the two operator-actionable degradation states:

1. `spawn-penalty-tripped` — agent crossed the consecutive-failure threshold (3 strikes) and entered penalty cooldown.
2. `spawn-infra-degraded` — agent crossed the infra-failure threshold (5 in 10 min) and entered degraded admission.

Manager exposes a typed `SpawnDegradationEvent` union and an optional `onDegradation` callback in config. The server wires `onDegradation` to the global `DegradationReporter.getInstance().report(...)`.

Critical: events fire ONLY on the trip-edge (transition from non-degraded to degraded), not on every subsequent failure within the degradation window. This prevents log floods and matches the operator-mental-model "this is a state change worth knowing about."

Sink errors are caught with try/catch — observability failures must never affect spawn-flow correctness.

Files touched:
- `src/messaging/SpawnRequestManager.ts` — adds `SpawnDegradationEvent` union; adds `onDegradation?` callback to config; emits trip-edge events in `#applyFailureAttribution` (penalty) and `#recordInfraFailure` (infra). Refactored penalty-set logic to compute `prior` and only set penaltyUntil + emit on the trip-edge while still refreshing the timer on subsequent failures.
- `src/commands/server.ts` — wires `onDegradation` to `DegradationReporter.getInstance().report(...)` with feature-specific primary/fallback/reason/impact text. Catches sink errors defensively.
- `tests/unit/spawn-request-manager.test.ts` — 3 new tests: penalty-trip emits once on edge (not on subsequent), infra-degraded emits once on edge (not on subsequent), sink errors don't affect spawn flow.

## Decision-point inventory

1. **Edge-only emission.** Operators don't need a log entry for every cooldown denial. The state change ("this peer just entered penalty / degraded") is the actionable signal. Subsequent same-state failures are noise.
2. **Typed union for events.** `SpawnDegradationEvent` discriminated by `kind`. Lets the consumer dispatch cleanly without string-matching. Future events (e.g., `queue-truncated-trip`) extend the union.
3. **Manager doesn't know about DegradationReporter.** Decoupled via callback. Manager stays unit-testable; server wires the global singleton.
4. **Try/catch around the sink.** Observability sinks can fail (out of memory, file system errors, etc.). The spawn flow's correctness must be independent — verified by test asserting penalty applies even when the sink throws.
5. **Penalty-trip refactor preserves prior behavior.** Old code: set `penaltyUntil` whenever `next >= threshold`. New code: same set, plus emit only on the trip-edge. Subsequent failures still refresh the timer (matches "peer keeps misbehaving → penalty extends" semantics).
6. **Server's `onDegradation` text uses operator-friendly wording.** "Open spawn slot for peer" / "Spawn blocked for Xs" — readable in dashboards, not jargon.

## Blast radius

- **Existing callers without `onDegradation`:** zero behavior change. The callback is optional; absent → no emission.
- **Server in production:** edge transitions now flow into the existing DegradationReporter pipeline. Operators see new entries when penalty / infra-degraded states trip.
- **Spawn flow correctness:** unchanged. Penalty-set + degradation-tracking logic is preserved; only the emission is added.

## Over-block risk

None — this is purely observability. The reporter doesn't gate anything.

## Under-block risk

None.

## Level-of-abstraction fit

Event types live next to the manager. Wiring lives in the server next to the existing DegradationReporter calls. Both placements obvious.

## Signal-vs-authority compliance

`onDegradation` emits signals. Authority — the actual penalty/degradation decision — is made by the existing `#applyFailureAttribution` / `#recordInfraFailure` logic. Signal flow is downstream of authority. Compliant.

## Interactions

- **§4.2 penalty + infra soft limiter:** trips that previously only altered internal state now also flow to operators as breadcrumbs.
- **§4.5 commit 1 (triggeredBy):** complementary. `triggeredBy` tags the spawned session for filtering; degradation events tell operators when the system entered a degraded state.
- **DegradationReporter:** existing infrastructure with its own dedup + escalation policies. Adding two more sources is additive.

## Rollback cost

Revert. Events disappear; reporter no longer surfaces spawn-related degradations. Internal state-tracking is unaffected.

## Tests

- 3 new tests under `describe('§4.2 drain loop', ...)`: penalty-trip emits once on edge, infra-degraded emits once on edge, sink errors don't affect spawn flow.
- All 70 prior tests pass unmodified.
- `npx tsc --noEmit`: clean.

## Rollout

Ships on `feat/threadline-cooldown-queue-drain`. With this commit, the spec is **fully complete** at the level the SpawnRequestManager surface can deliver:

- §4.1 ✓ authenticated session affinity (3 commits)
- §4.2 ✓ coalesced drain loop with DRR + failure-suppressive reservation + infra soft limiter (3 commits)
- §4.3 ✓ queue shape with byte cap, hash, truncation marker, global cap (3 commits)
- §4.4 ✓ config plumbing + drain consumer wiring + runtime PATCH endpoint (3 commits)
- §4.5 ✓ triggeredBy plumbing + DegradationReporter edge events (2 commits)

Total: 14 commits. Spec-level deferred items (gate freeze/downgrade with epoch invalidation, per-trust-tier admission) are cross-cutting changes that belong in a follow-up spec — they require AutonomyGate + trust-state coupling that lives outside this layer.
