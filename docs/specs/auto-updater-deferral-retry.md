# Auto-Updater Deferral Retry Recovery

## Problem

An installed update can be held while an interactive session is active. The
deferral details are durable, but the retry timer was memory-only. If that timer
was cleared, lost, or rejected once, later update checks hit the
already-installed loop breaker and returned without rebuilding the retry. The
agent could remain on old in-memory code indefinitely even after becoming idle.

## Contract

- Starting `AutoUpdater` re-arms any persisted active restart deferral.
- An overdue persisted deadline retries immediately.
- The already-installed loop breaker also verifies that an active durable
  deferral has a live timer and repairs it when missing.
- A rejected deferred-restart attempt records the error and schedules another
  bounded retry instead of ending the retry loop.
- The existing `UpdateGate` remains the authority for session activity. Healthy
  interactive sessions block; idle, dead, unresponsive, and safely idle job
  sessions do not.

## Evidence

`tests/unit/AutoUpdater.test.ts` covers restart-time re-arming, periodic
self-repair after deliberate timer loss, and retry continuation after a
rejected attempt. `tests/unit/UpdateGate.test.ts` continues to cover activity
classification.
