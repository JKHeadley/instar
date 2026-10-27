# Side-Effects Review — a waiting update restarts as soon as the verify ends

**Version / slug:** `local-verify-restart-recheck`
**Date:** `2026-10-27`
**Author:** `Echo`
**Second-pass reviewer:** `independent cross-model reviewer (see below)`

## Summary of the change

Amendment to `docs/specs/local-verify-merge-authority.md` (built 2026-10-27). Operator request (Telegram topic 130715): merge throughput is top priority.

- `src/core/AutoUpdater.ts`: new public `recheckRestartHolds()`: when the active restart deferral names a `local-verify:*` blocker, a retry timer is already pending (so never after `stop()`), no retry is in flight and no restart hold is active, schedule the deferred-restart retry in 1 s (`RESTART_HOLD_ENDED_RETRY_MS`) through the existing `scheduleDeferredRestartRetry` (which replaces the pending 5-minute timer).
- `src/localVerify/LocalVerifyService.ts`: `setRunEndedListener`; `onExit` calls it once per run end, after the in-flight run is cleared (so the service's restart hold is already gone).
- `src/localVerify/localVerifyWiring.ts`: `registerLocalVerifyRestartHold` wires the listener to `recheckRestartHolds` when the updater has it (optional in the view interface).

## Decision-point inventory

- `recheckRestartHolds` — add — whether to retry a deferred restart now. Deterministic over the deferral record and the live holds.
- The restart gate itself (sessions, window, dampener, holds, max deferral) — pass-through, unchanged; the retry re-runs it.

## 1. Over-block

None: the change only makes a retry earlier.

## 2. Under-block

- A restart could now happen up to ~5 minutes sooner after a verify ends. It still passes the whole gate (live sessions defer it as before; the pre-restart delay still applies). While an update waits, no new verify starts, so the earlier restart cannot cut into a verify.

## 3. Level-of-abstraction fit

The AutoUpdater already owns the retry timer; the service already owns knowing when a run ends. The listener is the narrow seam between them, set in the existing wiring function.

## 4. Signal vs authority compliance

The listener is a signal ("a hold may have ended"); the AutoUpdater's restart gate keeps all authority over whether a restart happens.

## 4b. Judgment-point check

None added.

## 5. Interactions

- **Pairing-invite holds:** a deferral not naming a `local-verify:*` blocker is left to its own re-check.
- **Retry in flight:** ignored (`deferralRetryInFlight`), so no double restart attempt.
- **Error auto-retry of a verify:** while an update is pending the service starts nothing, so the auto-retry waits for the restart, as before.

## 6. External surfaces

None (no route, config or record change). New log line "restart hold ended — attempting restart".

## 6b. Operator-surface quality

Nothing new for the operator.

## 7. Multi-machine posture

Machine-local, like both components.

## 8. Rollback cost

Revert; behaviour returns to the 5-minute re-check.

## Conclusion

Removes up to 5 minutes of idle verify slot per release with no change to what may block a restart.

## Class-Closure Declaration (display-only mirror)

`unbounded-self-action` — closure `n/a`: the retry fires at most once per verify run end, only re-schedules the existing single deferred-restart timer (replacing it), and the restart it may lead to still passes the full gate; nothing re-triggers it.

## Second-pass review

**Reviewer:** Independent cross-model reviewer (Codex read-only; two rounds, final concurrence).

Concurred. Independent cross-model reviewer (Codex, read-only), two rounds:
- Round 1 BLOCKED: (1) a run ending after `stop()` could arm a restart during shutdown — the recheck now only brings forward an already-scheduled retry (`deferralTimer` must exist), a no-op after `stop()`; (2) the service test stopped before the restart completed — it now waits through it and asserts one restart request; (3) missing cases — added: a next verify starting before the brought-forward retry (it defers on the new hold), recheck after `stop()`, a throwing listener.
- Round 2 **CLEAN** ("The timer guard addresses the shutdown issue, and the retry rechecks active holds through the existing restart gate").
