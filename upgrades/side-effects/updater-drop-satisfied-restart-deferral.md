# Side-Effects Review — a restart deferral the running process already satisfies is dropped at start

**Version / slug:** `updater-drop-satisfied-restart-deferral`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see the end)`

## Summary of the change

Tier 1. `AutoUpdater.start()` calls a new private `dropSatisfiedRestartDeferral()` before `ensureDeferredRestartRetry()`. It clears the durable restart deferral and saves state when all of these hold: a deferral is active; `ProcessIntegrity.getInstance()` exists; its `runningVersion` and the deferral's `targetVersion` both begin with a semver triple; the target is not newer than the running version. One source file, one test file.

Why: a deferral was cleared only by the updater's own restart. A restart by any other path left it on disk, the next boot resumed it, and the server restarted a second time onto the version it already ran, with Local Verify dispatch paused while it waited (Studio, 2026-11-13 19:20Z to 19:21Z).

## Decision-point inventory

One existing decision is touched: whether a durable deferral is resumed at start. It gains one exit, "already satisfied". No new decision to restart is added anywhere; the change can only remove a restart.

---

## 1. Over-block

"Blocks" here means a restart that is wanted but no longer happens. That needs a deferral whose target is at or below the version frozen at process boot while the process runs older code. `ProcessIntegrity.runningVersion` is read once at boot and never changes, so a later in-place install cannot move it. If no boot version was recorded, or either version does not parse, the deferral is kept.

## 2. Under-block

A satisfied deferral is dropped only at `start()`. A deferral created after start for a version the process already runs is not covered; no path creates one (a deferral is created for a version just installed, which is newer than the running process).

## 3. Level-of-abstraction fit

The updater owns the deferral record and is the only reader of it, so the check sits where the record is resumed. The other restart paths (planned restart request, supervisor) do not know the record exists and should not need to.

## 4. Signal vs authority compliance

No new blocking authority. The change removes a self-action (a restart) under a deterministic, fail-closed condition; when the condition cannot be evaluated the old behaviour stands.

## 5. Interactions

- **Local Verify dispatch pause:** ends as soon as the deferral is gone, instead of after a second restart.
- **Restart holds / max-deferral clock:** untouched for a deferral that is kept; `firstDeferredAt` still survives restarts for those.
- **Cascade dampener, restart-request file, handshake:** not written or read by the new method.
- **Spawn/kill:** none added; one restart is removed. Class `unbounded-self-action`: not applicable (no new self-action; an existing one is suppressed when redundant).

## 6. External surfaces

`GET /updates/status` shows `restartDeferral: null` after such a boot instead of an active deferral for the running version. One new log line: `Restart deferral for vX dropped: this process already runs vY`.

## 7. Multi-machine posture

Machine-local by design: each machine's updater holds its own deferral in its own state directory for its own process.

## 8. Rollback cost

Revert the commit. No state migration: a deferral record left by either version is read by the other.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose), read-only, 2026-11-13.

Verdict: "Concur with the change", no blockers. It confirmed: the boot version is read once from the loaded package and is read-only, and a wrong value (`0.0.0`) fails safe by keeping the deferral; `ProcessIntegrity.initialize` runs before `autoUpdater.start()` in `src/commands/server.ts`; only `gatedRestart` creates a deferral, so a satisfied one cannot come back after start; nothing else depends on the cleared record (admission fence and activation marker are in-memory, the handshake is verified separately, the planned-restart files belong to another path and are rightly left alone); Local Verify's dispatch pause reads `restartDeferral.active` live, so the drop ends it.

One should-fix, acted on: nothing pinned that start order. `tests/unit/stale-version-prevention.test.ts` now asserts `ProcessIntegrity.initialize(` precedes `autoUpdater.start()` in the server source. Notes recorded: a prerelease suffix is ignored by the comparison (harmless: a restart would boot the same install); a leftover `state/restart-requested.json` is a second, separate source of the dispatch pause and is outside this change.

**Reviewer concurred:** yes.
