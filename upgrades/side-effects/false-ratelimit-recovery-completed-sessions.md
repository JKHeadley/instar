# Side-Effects Review — Fix false rate-limit/error recovery on finished sessions + user-channel proof harness

**Version / slug:** `false-ratelimit-recovery-completed-sessions`
**Date:** `2026-06-24`
**Author:** Echo (autonomous, 8-hour run)
**Spec:** `docs/specs/false-ratelimit-recovery-completed-sessions.md` (review-convergence + approved)
**Second-pass reviewer:** REQUIRED (touches "sentinel"/"guard"/session-recovery) — verdict appended below.

## Summary of the change

A finished/idle session sitting at a prompt with a stale throttle string in its
scrollback was mistaken for a live-but-throttled session, so `RateLimitSentinel` (and
its sibling `CompactionSentinel`) ran a futile recovery and spammed the user with
`RATE_LIMIT_RESUME_NUDGE` ("the temporary server throttle should have cleared…").
Fleet-wide (shared detector). Fix makes a terminal session structurally incapable of
being a recovery target, and adds a reusable test capability that catches spurious
background messages before deploy.

Files modified:
- `src/monitoring/RateLimitSentinel.ts` — new optional `isSessionRecoverable?` dep,
  consulted in `report()` (no-op + no notice for a non-recoverable session),
  `attemptResume()` and `verify()` (silent `abort()` if the session finished mid-flight
  — new `rate-limit:aborted` event; `abort()` keeps the `recentReports` dedupe entry as
  a flap cooldown).
- `src/monitoring/CompactionSentinel.ts` — the SAME `isSessionRecoverable?` guard in
  `report()`.
- `src/commands/server.ts` — defines `isSessionRecoverable = (name) =>
  sessionManager.listRunningSessions().some(...)`; passes it to BOTH sentinels; adds a
  `sessionComplete` handler that clears both sentinels (the completion cleanup that had
  zero callers).
- `src/monitoring/QuotaCollector.ts` — the OAuth-429 `DegradationReport` now fires only
  when the 3-strike breaker trips (kills the `retry-after:0` log spam); the error is
  still recorded in `errors[]`, breaker + quota accounting unchanged.
- `src/core/LiveTestHarness.ts` — the prevention layer: an optional
  `ChannelDriver.collectMessages` + a scenario `absenceWindowMs` + `expect.noMessageMatching`
  / `expect.replyMustNotContain`. An absence scenario collects every channel message over
  the window and FAILs if any matches; an unsupported driver yields BLOCKED (never a
  silent pass).

Files added:
- `src/core/rateLimitFalsePositiveMatrix.ts` — the rate-limit user-role scenario matrix
  (happy-path reply + absence regression, optional Slack parity).
- `tests/unit/RateLimitSentinel-recoverable-guard.test.ts`,
  `tests/unit/CompactionSentinel-recoverable-guard.test.ts`,
  `tests/unit/rate-limit-false-positive-matrix.test.ts`,
  `tests/unit/sentinel-recoverable-wiring.test.ts`,
  `tests/integration/rate-limit-false-positive-prevention.test.ts`.
- Spec + ELI16 + convergence report.

## Decision-point inventory

- **Added** `isSessionRecoverable` guard — a bounded NO-OP that SUPPRESSES a recovery
  action; it never adds an authoritative block over a user. Signal-vs-authority: it
  removes a spurious action, the safe direction.
- **Added** harness absence assertion → a PASS/FAIL SIGNAL the already-dark, dry-run-
  default `LiveTestGate` consumes. BLOCKED (not silent-pass) when unverifiable. No new
  blocking authority.
- **Modified** `QuotaCollector` 429 path — a LOG-LEVEL decision only (report vs not);
  accounting + breaker untouched.

## Side effects & blast radius

- **Behavior change (intended):** a finished/killed session no longer receives recovery
  nudges; a recovery whose session ends mid-flight aborts silently (no escalation ping).
- **Preserved:** a genuinely-throttled RUNNING session still recovers — the notify
  templates are byte-for-byte unchanged; dep-absent installs (bare/test) behave exactly
  as before (regression-locked by tests).
- **Fail direction:** `listRunningSessions()` fails OPEN on a transient tmux error, so a
  hiccup cannot drop a live session and suppress a real recovery; only genuine
  termination removes it.
- **Machine-local:** each machine runs its own sentinels over its own running set; no
  cross-machine state introduced. The QuotaCollector poll is already per-machine.
- **Residual (scoped to CMT-1785):** a still-RUNNING idle session with stale throttle
  scrollback can still trigger one self-correcting "back online" message (not the
  6-nudge spam). The known fix (adopt the watchdog `evaluateThrottleSettle` settle-gate
  on the idle path) is tracked, driven evidence-first by the new absence harness.

## Migration parity

None required. All changes are server-internal wiring + a log-level change — no
`.claude/settings.json` hook, `.instar/config.json` default, CLAUDE.md template, or
built-in-skill change ships. Existing agents pick this up on the normal code-update path.

## Rollback

Each fix is independently revertible: F1 is additive (dep-absent = old behavior); F2 is
a pure cleanup addition; F4 is log-level only; the harness extension is additive (the
absence path only runs when a scenario sets `absenceWindowMs`).

## Tests

16 unit (guards both-sides + verify/abort lifecycle + harness absence + matrix + wiring-
integrity) + 2 integration (harness → signed artifact → `LiveTestGate` ALLOW on clean /
VETO on a reintroduced regression). No regression across the existing sentinel (96),
quota (53), and harness/gate (30) suites; clean `tsc`.

---

## Second-pass review

**Concur with the review.** Independent audit of the diff verified: the
`isSessionRecoverable` guard uses running-set membership (the correct criterion) and
genuinely fails OPEN via `isSessionAlive`'s catch-returns-true path, so no genuine
recovery is suppressed by a transient tmux error — only actual termination removes a
session. The `verify()`/`attemptResume()` abort returns BEFORE any user-facing
`notify()` (no escalation/"still throttled" ping for a finished session); `abort()`
correctly keeps `recentReports` as the flap cooldown. The `sessionComplete` cleanup is
best-effort try/catch and cannot break completion. The QuotaCollector change preserves
the 429 signal in `errors[]` + the breaker, suppressing only transient per-poll log
spam (no other consumer keys on that feature). The notify templates are byte-for-byte
unchanged (a genuinely-throttled RUNNING session recovers as before). The harness
returns BLOCKED (never a silent pass) when absence is unverifiable. All 322 relevant
tests green. — independent second-pass reviewer, 2026-06-24.
