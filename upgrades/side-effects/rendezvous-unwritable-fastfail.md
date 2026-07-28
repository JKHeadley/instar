# Side-effects review — fast-fail a permanently unwritable test-runner rendezvous

**Change:** `tryTakeLockOnce` now surfaces the errno on its error branch; the test-runner semaphore
classifies EACCES/EPERM/EROFS as a permanent rendezvous failure and fail-open-admits immediately with
cause `rendezvous-unwritable`, instead of polling the full lane budget (60s targeted / 120s suite)
and reaching the same admit.

**Decision point touched?** Yes — the admission path of a safety bound. The DECISION is unchanged
(both before and after, an unwritable rendezvous ends in a fail-open admit); only its LATENCY changes.
That distinction is the whole review.

---

## 1. Over-block

None. The change only ever shortens a wait that already ended in admission; nothing that previously
proceeded is now refused. The one refusal path preserved deliberately: a genuine
`TestRunnerStormCeilingError` is re-thrown rather than swallowed, so the storm ceiling still refuses
when it is able to function.

## 2. Under-block

Real and worth stating precisely. When the rendezvous is unwritable the storm ceiling **cannot bound
fail-open admits** — it is implemented as witness files in that same directory. So N concurrent runs
in that environment all admit.

This is NOT introduced here: the previous path called `claimStormSlot()`, which threw EACCES on its
first `mkdirSync`, and the outer handler admitted anyway. The unbounded outcome is identical; this
change reaches it in 800ms instead of 60s. The honest framing is that an unwritable rendezvous means
the bound is not in force at all — and the ELI16 and the code comment both say so rather than implying
protection that is absent.

Also under-blocked: the classifier is narrow by design (EACCES/EPERM/EROFS). An exotic permanent
errno not on that list still burns the full budget. Chosen deliberately — a wrong fast-fail is worse
than a slow correct one, so anything unrecognised stays on the contention path.

## 3. Level-of-abstraction fit

Correct. The information needed (which errno) is produced at the syscall boundary in
`hostSemaphoreCore.tryTakeLockOnce` and consumed by the loop that decides whether waiting can help.
Surfacing it is additive — `reason` is unchanged, so the spawn-lane callers of the same primitive are
untouched.

## 4. Signal vs authority compliance

Compliant. The semaphore keeps exactly the authority it had. No new blocking power is introduced; a
detector (errno classification) feeds an existing decision. Per `docs/signal-vs-authority.md` this is
the good direction: a cheap deterministic signal informing an authority that already existed.

## 5. Interactions

`LockTakeResult` gains an optional `code` field on the error branch — additive, consumed only by the
test-runner semaphore. The spawn semaphore and its priority variant use the same primitive and are
unaffected (verified: 150 tests green across all five semaphore suites).

New ledger cause `rendezvous-unwritable`, distinct from the existing
`lock-unavailable-full-budget`, so the two are never conflated when reading the event log — an
environment that cannot host the bound looks different from a genuinely contended one.

`rendezvousUnwritable` is cleared on any successful lock take, so a transient permission blip that
later resolves cannot leave the semaphore latched into fast-fail.

## 6. External surfaces

None. No endpoint, no config key, no user-visible behaviour. The observable difference is that a run
in an unwritable-rendezvous environment starts ~60s sooner and its ledger row names a different
cause.

## 7. Multi-machine posture

**Machine-local by design, and inherently so.** The rendezvous is a host-wide coordination point
under `~/.instar` — its entire purpose is bounding concurrency on ONE machine's CPU. There is nothing
to replicate: another machine's test concurrency is not this machine's concern, and a shared
rendezvous across machines would be actively wrong. No new state surface is introduced; this changes
the latency of an existing per-host read/write path.

## 8. Rollback cost

Trivial. Remove the fast-fail branch and the errno field; behaviour returns to polling the full
budget. No persisted state, no schema, no migration — the only durable trace is ledger rows carrying
the new cause string, which readers already tolerate as free-form.
