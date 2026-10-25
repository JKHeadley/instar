# Side-Effects Review — graceful shutdown has a hard deadline

**Version / slug:** `shutdown-hard-deadline`
**Date:** `2026-10-06`
**Author:** `echo`
**Second-pass reviewer:** `not required (bounded exit path; no decision authority)`

## Summary of the change

instar#2122: "The Luna server on the Studio ignores SIGTERM. Only SIGKILL stops it, whereas the laptop's stops on SIGTERM." The server's `shutdown` handler awaits ~10 subsystem stops in sequence (origin worker close, notification flush, tunnel, Threadline relay, Telegram, HTTP server) with no overall bound, so one hanging stop kept the process alive indefinitely. Now:

1. `armShutdownDeadline` (new `src/core/shutdownDeadline.ts`) arms an unref'd timer at the start of teardown (default 20 s, `INSTAR_SHUTDOWN_DEADLINE_MS` override, floor 2 s). On expiry it logs the step in flight, closes SQLite handles and releases the single-instance lock best-effort, and exits 1.
2. A second SIGINT/SIGTERM during teardown exits immediately with the same cleanup, naming the step.
3. The awaited steps are labelled (`telegram-origin`, `notification-flush`, `tunnel`, `threadline`, `telegram`, `http-server`, `sqlite`) so the log says what hung.

## Decision-point inventory

None. An exit-path bound.

## 1. Over-block

A teardown that genuinely needs more than 20 s is cut short with exit code 1; the operator can raise `INSTAR_SHUTDOWN_DEADLINE_MS`. The existing `process.on('exit')` SQLite net still runs. Resume-UUID saving and the sidecar flush happen early in the sequence, before the steps that have hung in practice.

## 2. Under-block

Does not diagnose WHICH subsystem hangs on Luna's Studio; the new step label in the log will. The lifeline's own supervisor restart behaviour is unchanged.

## 3. Level-of-abstraction fit

The bound belongs where the sequence is awaited; the helper is extracted only so the timing is testable.

## 4. Signal vs authority compliance

No authority added.

## 4b. Judgment-point check

Not a decision point.

## 5. Interactions

The restart/update paths that send SIGTERM (lifeline supervisor, launchd, `instar server restart`) now see the process exit within the bound instead of escalating to SIGKILL after their own timeouts. Exit code 1 on a forced exit lets a supervisor tell a clean stop from a cut-short one.

## 6. External surfaces

Two new log lines on an overrun or a second signal.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design; each machine's process bounds its own teardown.

## 8. Rollback cost

Revert; no state change.

## Conclusion

A SIGTERM now always ends the process, and the log names the step that would have hung forever.

## Class-Closure Declaration (display-only mirror)

`{defectClass: "unbounded-self-action", closure: "n/a", reason: "no self-triggered action: a one-shot bound on an operator/supervisor-initiated shutdown; it fires at most once per process"}`
