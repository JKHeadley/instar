---
bump: patch
---

## What Changed

Audit fix #4 under "No Unbounded Loops" (P19): the multi-machine heartbeat
writer. Grounding revealed the audit lead ("silent failure") was backwards and
worse — `HeartbeatManager.writeHeartbeat()` throws raw fs errors and the 2-min
timer tick called it UNGUARDED, so a transient disk error (ENOSPC/EACCES)
escaped as an uncaughtException and CRASHED the awake holder; in
`promoteToAwake` a throw aborted promotion midway (role flipped, writer never
started). Now: the periodic + boot writes go through a guarded funnel with the
new `FailureEpisodeLatch` (pure core class — the canonical extraction of
tonight's episode-latch pattern): first-failure log, one DegradationReporter
signal per episode at 6min sustained (before the peer's 15min failover
horizon), recovery log + re-arm, retries forever (declared Eternal Sentinel).
`promoteToAwake`'s initial write is rollback-and-rethrow per the adversarial
reviewer's finding: a promotion that cannot voice its liveness aborts cleanly
(role + registry rolled back) instead of silently completing voiceless.

## What to Tell Your User

If you run me on more than one machine: a disk hiccup can no longer crash the
machine that's actively serving you (previously a full disk at the wrong
moment did exactly that, every 2 minutes), machine takeovers can't
half-complete anymore, and if my "I'm alive" signal ever starts failing you
get a health-log note within 6 minutes — before the other machine would
assume I'm dead and take over.

## Summary of New Capabilities

- Heartbeat-write resilience: transient write failures are absorbed, bounded-
  logged, and surfaced once per outage (`MultiMachine.heartbeatWrite` in the
  degradation log); clean promotion abort on a failed initial write. No
  configuration needed.
- `FailureEpisodeLatch` (core): reusable episode-latch for P19 condition-4
  signals — first/threshold-once/recovery accounting, null-sentinel-safe.

## Evidence

Loop-safety audit lead (CMT-1109) re-grounded at source: unguarded
`writeHeartbeat()` in the `setInterval` tick + `server.ts`'s FATAL
uncaughtException path for fs errors = crash vector (worse than the claimed
silence). Adversarial second-pass: narrow OBJECT on the promote call site —
APPLIED pre-commit (rollback-and-rethrow); probes 2–4 CONCUR (CLI one-shot raw
calls safe; 6min < 15min failover horizon verified against
DEFAULT_FAILOVER_TIMEOUT_MS; DegradationReporter cannot throw into the catch).
Tests: 10 green in FailureEpisodeLatch.test.ts incl. the P19 bound (a week of
2-min failures → exactly 1 signal) — which caught a real zero-sentinel bug
pre-ship — + wiring pins (exactly two sanctioned raw call sites); neighbor
suites green (coordinator 22, leasePull 3); tsc clean.
