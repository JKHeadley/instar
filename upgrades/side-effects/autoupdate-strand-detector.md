# Side-Effects Review — Auto-update version-strand detector

**Version / slug:** `autoupdate-strand-detector`
**Date:** `2026-06-23`
**Author:** Echo (autonomous)
**Tier:** 1 (observe-only diagnostic — no change to update behavior, no new config, no decision points)
**Second-pass reviewer:** not-required (Tier 1; the new method + a corrected log/notify branch, covered by unit tests)

## Summary of the change

The AutoUpdater has a loop-breaker (`if lastAppliedVersion === latestVersion`) that, on every tick, assumes the recorded-applied version is genuinely installed in the shadow and prints a benign "downloaded, waiting for a restart" message. But `getInstalledVersion()` caches the version the running process booted with — it does NOT reflect the LIVE shadow on disk.

If the shadow REVERTS after a successful apply (e.g., crash-loop collateral, or a partial re-install) while `lastAppliedVersion` still records the new version, the agent is **stranded**: the updater believes it is current, the loop-breaker never re-applies, and the misleading "waiting for a restart" message hides a permanent stuck state. This actually happened (an agent stranded on the old version while `lastAppliedVersion` claimed the new one).

## The change

- `src/core/UpdateChecker.ts` — new `getShadowInstalledVersion(): string | null`, an **uncached** read of `{stateDir}/shadow-install/node_modules/instar/package.json`. Distinct from `getInstalledVersion()` (which caches the running-process version).
- `src/core/AutoUpdater.ts` — in the loop-breaker, read the live shadow-disk version; if it differs from `lastAppliedVersion` (the shadow doesn't actually have what the record claims), emit a distinct loud STRAND warning + a one-time honest notification ("an update was recorded as installed but isn't on disk — I'm stuck until it's re-applied") instead of the benign "awaiting restart" message.
- `tests/unit/UpdateChecker.test.ts` — 4 tests for `getShadowInstalledVersion` (reads the disk version, reflects a reverted version uncached, returns null when absent / version-less).

## Side effects & risk

- **Observe-only.** Update behavior is unchanged: the strand path still `return`s (no auto re-apply — a bounded auto-heal is a deliberate follow-up). The change only corrects the diagnosis and the one-time notification text.
- **No false positives on the benign case.** A genuine "applied, awaiting restart" has shadow-disk === lastAppliedVersion → `updateAvailable` is false → the tick returns before the loop-breaker. Reaching the loop-breaker with shadow-disk ≠ lastAppliedVersion is the strand.
- **Fail-safe reads.** `getShadowInstalledVersion()` returns null on any read error; a null shadow version never trips the strand branch (it falls through to the existing benign messages).
- **Risk:** low. New diagnostic method + a corrected branch, both covered by unit tests; AutoUpdater's existing 29 tests stay green.

## Verification

- `tsc --noEmit`: 0 errors.
- `tests/unit/UpdateChecker.test.ts`: 17/17 (incl. 4 new).
- `tests/unit/AutoUpdater.test.ts` + `tests/unit/auto-updater-failures.test.ts`: 29/29.

## Rollout

No flag, no migration. Strictly additive diagnostic — surfaces a previously-silent stuck state. The bounded auto-re-apply self-heal (which would also FIX the strand, not just surface it) is a tracked Tier-2 follow-up (it mutates the critical update path and warrants spec-converge review).
