# Side-Effects Review — Durable Stop-Gate Breaker

**Version / slug:** `durable-stop-gate-breaker`
**Date:** `2026-07-19`
**Author:** `Instar-codey`
**Second-pass reviewer:** `stop_gate_breaker_review (independent sub-agent)`

## Summary of the change

This change makes the existing `UnjustifiedStopGate` unusable-authority breaker
restart-surviving through `StopGateDb`, adds a route-keyed atomic half-open lease,
status/reset tooling, and upgrades the P19 standard plus shared self-action
ratchet to prove restart survival. It preserves the Stop route's existing
fail-open direction and first-failure telemetry.

## Decision-point inventory

- `UnjustifiedStopGate.evaluate` probe admission — **modified** — durable
  cooldown/lease mechanically decides whether an authority attempt may run.
- `UnjustifiedStopGate` stop/continue judgment — **pass-through** — the same LLM
  authority, enumerated rules, and evidence validator remain sole judge.
- `reset-breaker` — **added invariant action** — authenticated explicit clearing
  after provider repair; it does not choose a stop verdict. Its write-domain
  registry entry is machine-local with the physical-provider and git-excluded
  StopGateDb convergence story.

## 1. Over-block

No new Stop event is blocked. While the breaker is open, events continue to
fail-open to `allow`. A repaired provider can be suppressed for at most the
existing five-minute cooldown; automatic half-open probing or authenticated reset
ends that delay.

## 2. Under-block

Persistence can fail or the SQLite file can be unavailable; the gate then uses
the existing in-memory breaker, so a restart during that degradation can still
mint a retry budget. This is reported distinctly as
`unjustifiedStopGate.breakerPersistence` and never hidden. Deliberate deletion or
manual corruption of the local database is outside the gate's drift-correction
threat boundary, but corrupt timestamps/counts are clamped.

## 3. Level-of-abstraction fit

Breaker persistence lives in the existing StopGateDb beside its decision state;
provider judgment stays in UnjustifiedStopGate. The deterministic lease is
mechanical capacity control, not a parallel semantic authority. The class guard
extends the existing self-action ratchet instead of creating a new test framework.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — the deterministic change has no semantic block/allow authority.

The breaker may only skip an expensive authority attempt and preserve the
pre-existing fail-open availability result. It never turns structural signals
into a stop/continue judgment. A usable LLM verdict remains the only positive
semantic authority result.

## 4b. Judgment-point check

No new static heuristic is placed at a competing-signals judgment point. The
closed/open/leased transitions are an enumerable resource invariant with a fixed
conservative result; the actual stop judgment remains LLM-backed.

## 5. Interactions

- **Shadowing:** an open breaker intentionally runs before the LLM call, exactly
  as the prior in-memory breaker did; parser/evidence validation still runs for a
  response that is admitted.
- **Double-fire:** `BEGIN IMMEDIATE` plus a matching-token lease permits one
  half-open probe; stale settlement cannot reset a newer lease.
- **Races:** production is single-server by `SingleInstanceLock`; database
  transaction/lease defensively bounds overlapping evaluations/handles.
- **Feedback loops:** the first `threshold-1` failures remain reportable; opening
  and half-open failure return `breakerOpen`, so restart/cooldown cannot create a
  fresh timeout-feedback stream. Suppression metrics flush best-effort off-path
  at most once per key per minute.

## 6. External surfaces

The local CLI status adds human-readable breaker state and gains the authenticated
`reset-breaker` command. The internal hot-path response adds a nullable `breaker`
object. The SQLite table is additive. There is no new messaging, external service,
URL, or public API. Operator action is conversationally executable by the agent;
the user is not asked to run a command.

## 6b. Operator-surface quality

No dashboard/HTML operator surface is touched. The CLI status is plain language,
contains no credential/provider secret, and reset is a secondary repair action.

## 7. Multi-machine posture

**Machine-local by design — physical credential locality.** The breaker describes
the CLI/provider route and credentials physically available on one machine.
Replicating it would let one machine suppress a healthy provider elsewhere. It
emits no new user-facing notice, strands no transferable work, and generates no
URL. Existing machine-qualified degradation forwarding remains unchanged.

## 8. Rollback cost

Revert and ship a patch. Older code ignores the additive SQLite table; no down
migration or user-state repair is required. During rollback the old in-memory
breaker returns, so release restarts may again generate the presenting feedback.

## Conclusion

The review changed the initial design from a singleton persisted count into a
route-keyed persistent circuit breaker with atomic leases, bounded corruption and
lock behavior, explicit repair, semantic-unusable coverage, durable visibility,
and a class-level restart ratchet. It is ready for independent second-pass review.

## Second-pass review (required)

**Reviewer:** `stop_gate_breaker_review`
**Independent read of the artifact:** Concur with the review. The reviewer
independently verified restart posture, route-keyed retention, strict lease-token
settlement, malformed-output K=2 behavior, coalesced suppression accounting,
authenticated status/reset behavior, and next-probe admission, then reran the
focused suite and TypeScript compilation with no remaining concern.

## Evidence pointers

- 179 live feedback events; first 2026-06-08T08:51:39.837Z, latest
  2026-07-19T23:25:02.920Z.
- 102 focused assertions passed across unit, integration, and E2E tiers; the
  independent reviewer separately reran 96 directly relevant assertions.
- TypeScript and full lint passed.

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `unbounded-self-action`
- **`closure`:** `guard`
- **`guardEvidence.type`:** `ratchet`
- **`guardEvidence.citation`:** `tests/unit/self-action-convergence.test.ts`
- **`guardEvidence.howCaught`:** Under unchanged slow-provider pressure, the
  restart-storm fixture reconstructs `stop-gate-authority-probe` before every
  tick and requires timeout-feedback emissions to remain at K=2. The old
  in-memory breaker would emit two more after every reconstruction and fail.
