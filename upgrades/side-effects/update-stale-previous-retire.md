# Side-Effects Review — Update stale previous retire

**Version / slug:** update-stale-previous-retire
**Date:** 2026-11-07
**Author:** Echo
**Second-pass reviewer:** independent Claude subagent (see below)

## Summary of the change
Tier 1, 1 runtime file plus unit coverage, about 25 runtime lines. `applyUpdate` and `rollback` remove `shadow-install.previous` at their start when the active install's `dist/cli.js` exists. The delete runs under `withSyncOp`. Effort: no spec rounds.

## Decision-point inventory
- `promoteCandidate` refusal — pass-through: unchanged, now reached only if the removal failed or the active install has no entry file.
- Leftover backup handling at update start — add.

## 1. Over-block
Removes an over-block: a harmless leftover stopping all updates.

## 2. Under-block
If the removal fails, the update still refuses, with the same error plus a warning. The delete can be interrupted again; the next update retries it. The cause of restarts during the delete is not addressed.

## 3. Level-of-abstraction fit
`applyUpdate` already handles the opposite recovery at the same point.

## 4. Signal vs authority compliance
Required reference: docs/signal-vs-authority.md. A filesystem fact, not a judgment.

## 4b. Judgment-point check
None.

## 5. Interactions
It checks the active install's entry file, the same check the bash wrapper and supervisor use, not a full runnability proof. An active install with its entry file but broken otherwise loses a good backup; a failed update then leaves none. The boot wrapper and supervisor restore only when the active install is missing, so they are unaffected. Rollback reinstalls by version and does not read this backup, but its promotion refused a leftover too, so it now retires one as well. Two live servers on one state directory could race the check; `server.ts` is the only constructor, so that is theoretical.

## 6. External surfaces
All agents, on update. The removal is synchronous: about 9 s on a full install at load 10-20 by a reviewer's measure, under `withSyncOp`. The older retire step after promotion is left unchanged and can still be interrupted; the next update now clears what it leaves.

## 7. Multi-machine posture
Machine-local BY DESIGN: installs are per machine.

## 8. Rollback cost
Plain revert.

## Second-pass review
Concern raised, then addressed (independent subagent). It found no realistic way to lose the only runnable install except a shell active directory, now guarded by the entry-file check. It found rollback had the same trap (fixed with a test), and false or overstated statements here and in the notes (corrected). Added tests for a failed delete and a broken active install.
