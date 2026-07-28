# Side-Effects Review — Idle-aware poller cadence

**Version / slug:** `idle-poller-cadence`
**Date:** `2026-05-30`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

New `IdleAwareCadence` primitive (a self-rescheduling timer that runs short while
active, long while idle, re-sampling idle state each reschedule). Applied to
`TokenLedgerPoller` via optional `isIdle`/`idleIntervalMs`; `AgentServer` wires
`isIdle = no running sessions`. First slice of Level 1 (instar's own idle footprint).

## Decision-point inventory

None with authority. The only decision is "active vs idle interval," which affects
cadence, not control flow.

## 1. Over-block

**What legitimate work does this skip?** None. It changes only how often a
read-only scan runs. When idle, the token JSONL has no new content to attribute, so
the skipped scans were no-ops anyway. Resuming activity restores full cadence within
one idle interval.

## 2. Under-block

**What does it miss?** It does not (yet) back off the other ~26 pollers — incremental
by design. And the idle signal is coarse (no running sessions); a future refinement
could include recent inbound activity. Neither is a correctness gap.

## 3. Level-of-abstraction fit

**Right layer?** Yes. `IdleAwareCadence` is a generic monitoring primitive; the
poller opts in via a constructor option; the idle signal is injected by `AgentServer`
(which owns the session manager). The poller's scan logic is untouched.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No blocking authority. The change is cadence-only on a read-only observability
poller. The safety bias is explicit: an `isIdle()` throw degrades to ACTIVE (full
cadence = prior behavior), so failure means "no savings," never "missed work."

## 5. Interactions

`TokenLedgerPoller` without `isIdle` keeps the exact prior fixed `setInterval`
(backward-compatible — covered by a test). No interaction with the SessionReaper,
sentinels, burn-detector, or recovery paths — they each keep their own timers. The
reentry guard in `tick()` is preserved.

## 6. External surfaces

None. No HTTP route, no config key, no on-disk state, no notifications. Purely an
internal cadence change. The `/tokens/*` data is unaffected (same scan, just less
often while idle).

## 7. Rollback cost

Trivial. Omitting `isIdle` restores the prior behavior with zero code change at the
call site; a PR revert removes the helper + the poller option. No migration, no
schema, no irreversible op.

## Conclusion

Lowest-risk class: additive, behavior-cadence-only, backward-compatible, conservative
on ambiguity, no authority. Trims wasted idle-poller work and establishes the reusable
idle-cadence primitive that further pollers and agent-sleep (L3) build on.

## Second-pass review (if required)

Not required — cadence-only change, no authority, no decision logic.

## Evidence pointers

- `tests/unit/IdleAwareCadence.test.ts` — the primitive (active/idle intervals,
  re-evaluation, isIdle-throw⇒active, tick-throw-survives, stop, currentIntervalMs).
- `tests/unit/token-ledger-poller-idle.test.ts` — poller backs off while idle, full
  cadence while active, fixed cadence without `isIdle`.
- `tests/unit/token-ledger.test.ts` + `TokenLedgerPoller-codex.test.ts` — green
  (backward-compat).
- `upgrades/NEXT.md` — upgrade guide.
