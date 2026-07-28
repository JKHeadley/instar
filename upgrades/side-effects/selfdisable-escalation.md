# Side-effects review — escalate the self-disable warning at the point of use

**Change:** when the test-runner bound is skipped via `INSTAR_HOST_TEST_SEMAPHORE=off`, the existing
deterministic warning is followed by an escalation naming how many self-disables the shared detector
already sees in its window, and that `dev:preflight` fails on the signature.

**Decision point touched?** No gate, no blocking, no new authority. It adds output to an existing
logging path. The bound's behaviour is unchanged in every posture.

---

## 1. Over-block

None possible — it prints lines. It cannot refuse, delay, or fail a run. Explicitly considered and
rejected: making the chokepoint REFUSE on a sustained pattern. The kill switch exists for genuine
emergencies, and a kill switch that stops working after three uses is not a kill switch. Escalating
the signal is the correct lever; removing the escape hatch is not.

## 2. Under-block

It is only louder text. A reader determined to ignore it still can, and someone scripting `off`
permanently will see it scroll past forever. This narrows the gap between the moment of the decision
and the moment of the consequence; it does not close it.

It also fires only for `reason === 'off'`. The other loud skip (spoofed CI on a dev host) is graded
"like off" by the spec and is NOT escalated here — deliberate scope, since that path has a different
population and I have no measurement for it.

## 3. Level-of-abstraction fit

Correct: the chokepoint is where the decision is observable at the moment it is made. The detector
already existed but was consumed only by `dev:preflight`, hours downstream. This wires the same
detector to the earliest surface, and reuses it rather than re-counting so threshold and window
cannot drift between the two consumers.

## 4. Signal vs authority compliance

Pure signal, and deliberately kept so. The escalation informs; the human or agent decides; the
existing preflight check retains whatever authority it had.

## 5. Interactions

`skipLine` becomes async and is awaited at all seven call sites in `globalSetup`. That is load-bearing
rather than cosmetic: the first implementation used fire-and-forget and the escalation never printed,
because globalSetup returns before the promise settles.

The lookup dynamically imports `scripts/lib/test-runner-selfdisable-patterns.mjs` from a test setup
file. Wrapped so a resolution failure degrades to the plain line.

Adds one ledger read (bounded to the detector's own `DEFAULT_MAX_EVENTS`) per SKIPPED run only — never
on the acquire path.

## 6. External surfaces

None. Test-run stderr only; no endpoint, no config key, no user-facing behaviour.

## 7. Multi-machine posture

Machine-local by design and inherently so: the ledger records what THIS host did, and the bound is a
per-host concurrency limit. A cross-machine count would be meaningless — another machine's
self-disables say nothing about this one's.

## 8. Rollback cost

Trivial: drop the escalation block and revert `skipLine` to sync. No state, no schema, no consumers.

## What this change's own construction demonstrated

Two implementations produced NO output and NO error. The first attached the lookup to an un-awaited
promise; the second guessed the detector's shape and had the mistake swallowed by the best-effort
catch that exists so a louder warning cannot break a run. Both were found by running it and reading
the output, not by anything failing.

That is the same failure class as the change's subject, twice, inside the change. The response was
structural rather than resolving to be careful: the fallible mapping is now a pure exported function
pinned against the detector's real output shape, so a future shape change fails a test instead of
disappearing into the catch. The catch stays — it is correct that this cannot break a run — but it no
longer has anything unverified to hide.
