# Side-Effects Review: locked-proof build can move the helper folder

**Version / slug:** `locked-proof-helper-dir`
**Date:** `2026-11-04`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1, test harness only: 5 files, about 90 lines, one review round, nothing under `src/` changes.

The locked-Mac proof is stuck on the Mac Mini. macOS keeps a permission row per program path, and the row at the kept helper's path names an older build. The row is invisible in System Settings, the plus button leaves its old requirement in place, and `tccutil` refuses a bare program. So:

1. `scripts/build-locked-proof.mjs --helper-dir desktop-helper-<name>` moves the kept helper's default folder, in the scratch copy of one test build only. The manifest records `helperDir`.
2. The same script now always makes a universal helper on a Mac. Retention keeps only a universal helper, and the last three proof builds needed a hand-run extra step for this.
3. `driver.mjs` writes every person step to `person-steps.jsonl` with whether it was delivered, and says so on stderr when it was not. A refused send used to vanish while the case timed out.

## Decision-point inventory

None added to any shipped path. `rewriteHelperRoot` refuses bad input at build time on a developer's Mac. `recordPersonStep` records a fact and blocks nothing.

## 1. Over-block

`--helper-dir` accepts only `desktop-helper-<lowercase name>`. That is deliberate, and no legitimate use needs more.

## 2. Under-block

A build moved to a new folder still needs one person trip for the grant. If macOS writes a stale requirement at a fresh path too, this does not help; the proof sitting measures that. The shipped product still has the stale-row dead end after a helper source change. That is tracked in feedback fb-a67570d1-f1d and fb-f21f34ff-491 and is not fixed here.

## 3. Level-of-abstraction fit

Right layer. The build script already rewrites a scratch copy for the proven-versions table. A config key would add a shipped option that only a proof needs.

## 4. Signal vs authority compliance

No blocking authority is added. The person-step record is a pure signal. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

The locked store stays at `~/.instar/desktop-helper/locked` (`DesktopLockedController`), and `driver.mjs` and `reset-attempts.py` pin that store, so they keep working. `resolve()` treats a new folder as a first grant.

## 6. External surfaces

None for users or other agents. Only `-lockedproof` builds, which are never published, can carry the moved folder.

## 7. Multi-machine posture

Machine-local: one build for one proof Mac. Nothing is replicated.

## 8. Rollback cost

Revert the commit. Without the flag the build output is as before, except that the helper is universal on a Mac.
