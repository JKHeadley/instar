# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The coherence monitor now emits a proper degradation entry whenever it
detects that the process is running stale code (running version differs
from what's installed on disk, and the auto-updater has not yet flagged a
pending restart). Before this change the stale-process state was only
visible in the `versionMismatch` field of `/health`; it did not appear in
`degradationSummary` and triggered no Telegram alert.

The emission is deduped per on-disk version — exactly one entry per newly
observed mismatch, reset once the mismatch clears after a restart — and
still honors the existing `DegradationReporter` per-feature Telegram
cooldown, so there is no risk of spam from a long-lived stale process.

Feature key on the new entry: `ProcessIntegrity.versionMismatch`.

## What to Tell Your User

- **Better nudges when I'm running behind**: If I've quietly been running
  an older version of myself because I haven't restarted since an update,
  I'll now tell you about it instead of keeping quiet. You'll see a short
  note in the attention channel so you know a restart would bring in the
  latest fixes.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Stale-process degradation signal | Automatic — surfaces in degradationSummary and as a Telegram alert when the coherence monitor detects a version mismatch |

## Evidence

Not reproducible in dev without simulating a disk-only version bump mid-process.
The fix is a targeted wiring change: the existing else-branch of
`CoherenceMonitor.checkProcessIntegrity()` (the branch that already reports
`passed:false` with message "Running vX but disk has vY — restart needed")
now additionally calls `DegradationReporter.getInstance().report()` with
an in-memory dedup on `diskVersion`. Verified by code inspection:

- Before: CoherenceMonitor.ts had no `DegradationReporter` import; the
  else-branch returned a CoherenceCheckResult and nothing else.
- After: CoherenceMonitor.ts imports DegradationReporter, the else-branch
  checks `lastReportedMismatchDiskVersion !== integrity.diskVersion` before
  emitting, and the coherent-branch resets the dedup field.

`tests/unit/degradation-reporter.test.ts` (8 tests) and
`tests/unit/stale-version-prevention.test.ts` both pass after the change.
The pre-existing `tests/unit/no-silent-fallbacks.test.ts` baseline-count
failure is unrelated (174 vs baseline 86 — verified identical on a clean
checkout of main before the change was applied).
