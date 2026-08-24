# Side-effects review — W25 composition failures

**Change:** three files. `src/server/routes.ts` and `src/monitoring/SessionsReadDiscrepancyProbe.ts`
gain a `DegradationReporter` report before an existing fallback; `src/core/SessionManager.ts` teaches
the synchronous `isSessionAlive()` to read `#{pane_dead}||#{pane_dead_status}`, matching
`isSessionAliveAsync()`.

**Origin:** neither defect existed in any single branch. Both appeared only when Window 24's seven
preserved refs were composed into one candidate. Measured, not inferred: base `8e5b0d2c1` passes both
tests; candidate `70e896ab4` fails both; same machine, same environment, one variable changed.

## 1. Over-block — what legitimate inputs does this reject that it should not?

The fallback changes reject nothing: they ADD a report on a path that already fell back, and the
fallback still happens. No input that previously succeeded now fails.

The liveness change CAN newly return `false` where it previously returned `true` — specifically for a
pane that is dead but retained. That is the correction, not a side effect: the previous `true` was
wrong, and the async path already returned `false` for the same pane. The risk to weigh is a pane
that tmux reports as dead while its work is somehow still meaningful; no such state exists — a dead
pane has no process.

## 2. Under-block — what does this still miss?

The silent-fallback ratchet counts syntactic catch-blocks within a scanner window. It measures
"reports before falling back", not "reports something useful". Both new reports carry real context,
but the ratchet could not tell if they did not.

The liveness fix aligns the sync path with the async path. It does NOT prove the two cannot drift
again — nothing structurally binds them. A test asserting the two functions agree on the same pane
state would close that, and does not exist. Named, not built: this change is scoped to the failures
composition exposed, and building that guard belongs to whoever owns the liveness contract.

## 3. Level-of-abstraction fit

Correct layer for both. The reports sit exactly where the fallback happens, which is the only place
that knows what was lost. The liveness read sits in `SessionManager`, alongside the async twin it is
being aligned with — moving either into a shared helper is a refactor this change deliberately does
not attempt while a release is mid-flight.

## 4. Signal vs authority compliance

Compliant, and the direction is toward signal. `DegradationReporter` is a pure signal emitter — it
records and never blocks; adding two reports adds no authority anywhere. The liveness change touches
a function that IS consulted by authorities (the reaper, the sentinels), but it does not add or move
authority: it corrects a boolean those authorities were already reading, so that they read a true one
rather than a false one. No brittle check gains blocking power.

## 5. Interactions

The two reports feed the existing degradation surface, which is aggregate and deduped, so two more
sources cannot flood it.

The liveness change is the one with real interaction surface: `isSessionAlive()` is read by the
reaper, the silently-stopped sentinels, and the session census. All of them previously saw a retained
dead pane as alive. After this they see it as dead — which is what the async path already told them,
so this REDUCES a disagreement rather than creating one. The concrete effect is that a crashed
session is now reaped or reported promptly instead of lingering as a phantom live session. That is
the intended behaviour of the branch that introduced pane retention; this completes it rather than
altering it.

## 6. External surfaces

No API, route, schema, or message shape changes. No user-visible surface changes. One indirect
user-visible effect: a crashed session that would previously have shown as running until something
else noticed will now leave the running list promptly, which is more honest and is what the census
already claimed to report.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design**, both parts. A pane's liveness is a fact about the tmux server on the
machine holding it and is meaningful nowhere else; the existing async path is machine-local for the
same reason. Degradation reports are recorded per machine and read per machine, matching the existing
surface. Nothing here is replicated, nothing is proxied on read, and no generated URL or durable
cross-machine state is involved, so there is nothing to strand on a topic transfer.

## 8. Rollback cost

Cheap and complete: revert the three-file patch. No migration, no data change, no agent-state repair,
no persisted format touched. The candidate that carries it is preserved on origin under two backup
namespaces, so reverting loses nothing. Reverting restores exactly the two failures — proven, since
that is the must-fail control below.

## Must-fail controls (proven, not asserted)

Reverting this patch and re-running:
- `tests/unit/no-silent-fallbacks.test.ts` → `expected 498 to be less than or equal to 496`
- `tests/e2e/session-management-e2e.test.ts` "should handle sessions that crash during startup"
  → `waitFor timed out after 5000ms`

With the patch applied: the ratchet reads 496 and the e2e passes in 282ms. `tsc --noEmit` exit 0.

## What this review does NOT cover

Blocker B-1 (stop preserves the state record) and its lane-6 repair are a separate change with their
own evidence, reviewed separately. This artifact covers only the three files named above.
