# Side-Effects Review — Auto-Updater Deferral Retry Recovery

**Version / slug:** `auto-updater-deferral-retry`
**Date:** `2026-07-23`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `updater_deferral_review`

## Summary of the change

`src/core/AutoUpdater.ts` now treats the persisted restart-deferral deadline as
durable retry intent. Startup and the already-installed update-check path rebuild
a missing timer, while rejected retry attempts retain the deferral and schedule
another bounded five-minute attempt. `tests/unit/AutoUpdater.test.ts` exercises
restart recovery, deliberate timer loss, and rejected attempts. The existing
`UpdateGate` remains the sole authority over active-versus-idle session state.

## Decision-point inventory

- `UpdateGate.canRestart` — pass-through — still decides whether active work
  permits a restart; its classification logic is unchanged.
- `AutoUpdater.ensureDeferredRestartRetry` — add — mechanically restores a
  timer from already-authorized durable retry intent.
- `AutoUpdater.retryDeferredRestart` — add — handles transport/execution errors
  without making an activity decision.

## 1. Over-block

No new block/allow surface. A future `nextRetryAt` remains respected rather than
being pulled forward, so restart-window deferrals are not shortened. An invalid
or missing deadline waits the standard five minutes.

## 2. Under-block

The fix does not repair a corrupted or missing `auto-updater.json`, nor can it
restart when the supervisor cannot consume `restart-requested.json`. Those are
separate integrity and supervisor boundaries. The periodic update tick provides
a second re-arm path if startup re-arming itself is interrupted.

## 3. Level-of-abstraction fit

The change is at the AutoUpdater timer/durability layer. It does not duplicate
session activity classification: every retry re-enters `gatedRestart`, which
delegates to `UpdateGate`. The timer is replaceable mechanism; the persisted
deferral row is durable intent.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no new block/allow surface.

The existing context-rich session-health gate retains restart authority. The new
code only ensures that gate is asked again at the persisted time.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Deadline parsing
is a structural timer operation; active-work judgment remains in `UpdateGate`.

## 5. Interactions

- **Shadowing:** the installed-version loop breaker still prevents reapplying
  bytes, but now repairs retry machinery before returning.
- **Double-fire:** one `deferralTimer` plus a `deferralRetryInFlight` latch form
  the chokepoint. The watchdog refuses to schedule while an async retry is
  unsettled, preventing duplicate attempts during notification/restart delays.
- **Races:** startup is wired after session dependencies, so an overdue retry
  reaches the real activity gate. A simultaneous periodic tick sees either the
  live timer or in-flight latch and does not add another. `stop()` advances a
  lifecycle generation, invalidating older callbacks without breaking valid
  manually driven updater cycles that were never started periodically.
- **Feedback loops:** blocked retries write a new deadline through the existing
  path. Unexpected rejection retries use the same five-minute rate floor.

## 6. External surfaces

No API shape or operator action changes. Users may now observe an installed
update activate after idle where it previously remained stuck. The existing
restart request file and updater state schema are reused. No new URLs or
external-service calls are introduced.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local by design: update installation, running process version, session
activity, timers, and restart requests are truths of one machine. Each machine
owns its own `state/auto-updater.json` and must independently converge onto its
installed version. This code emits no new user-facing notice, creates no URL,
and does not move state with topic ownership.

## 8. Rollback cost

Pure code change using the existing state schema. Revert and ship a patch; no
data migration or agent-state repair is required. Existing persisted deferrals
remain readable by both old and new code.

## Conclusion

The change closes the lost-timer class without altering restart authority or
activity detection. Durable intent is now reconnected to replaceable timers at
startup, during normal polling, and after transient callback failures. The
independent review additionally produced a single-flight latch and stop-safe
rescheduling before shipment.

## Second-pass review

**Reviewer:** `updater_deferral_review`
**Independent read of the artifact:** concur

The single-flight latch closes the double-fire race, the lifecycle generation
makes stop terminal for older callbacks, and the held-promise test exercises the
real polling collision. Retry convergence and activity-gate authority are
preserved.

## Evidence pointers

- `tests/unit/AutoUpdater.test.ts`
- `tests/unit/UpdateGate.test.ts`
- `tests/unit/auto-updater-failures.test.ts`
- `tests/integration/auto-updater-lifeline-handshake.test.ts`

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`,
`guardEvidence: { enforcementType: ratchet, citation:
tests/unit/AutoUpdater.test.ts, howCaught: the startup, timer-loss, and rejected
retry tests exercise the control-loop edges; a single deferral timer is the
chokepoint, the in-flight latch prevents concurrent actions, retries have a
five-minute rate floor, and a successful or newly blocked evaluation settles
through gatedRestart rather than accumulating parallel timers }`.
