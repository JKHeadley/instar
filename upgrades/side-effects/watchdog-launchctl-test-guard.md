# Side-Effects Review — fleet-watchdog launchctl test-harness guard (Tier 1)

**Version / slug:** `watchdog-launchctl-test-guard`
**Date:** `2026-06-09`
**Author:** `Echo`
**Second-pass reviewer:** `not required (Tier-1 lite lane; analysis below covers both directions)`

## Summary of the change

`PostUpdateMigrator.migrateFleetWatchdog` runs in every `migrate()` pass and,
on darwin, refreshed the machine-global launchd service via `launchctl
bootout` + `bootstrap`. launchd is NOT scoped by `$HOME`, so every unit test
that ran `migrate()` inside a redirected test HOME booted out the REAL fleet
watchdog and bootstrapped one pointing at the test tmpdir: (a) its RunAtLoad
run wrote `watchdog-launchd.{log,err}` into the tmpdir mid-cleanup — the
worktree-spotlight-exclusion ENOTEMPTY failure family (6 tests); (b) after
cleanup, the machine's `ai.instar.watchdog` service pointed at a DELETED
plist — fleet watchdog silently dead on every darwin dev machine that runs
the suite. CI (linux, no launchd) can never catch it.

Fix: the `launchctl` pair is skipped when `process.env.VITEST` or
`NODE_ENV === 'test'` is set. File writes (script + plist into the
HOME-scoped paths) remain active, so tests stay hermetic and can assert
content. The machine's real watchdog was re-bootstrapped from
`~/Library/LaunchAgents/ai.instar.watchdog.plist` and verified pointing at
the canonical paths.

## Files touched

- src/core/PostUpdateMigrator.ts (the `if (plistChanged)` launchctl block in `migrateFleetWatchdog` only)

## 1. Over-block

If the env sniff ever misfires in a REAL update context (an operator running
instar with NODE_ENV=test, or some harness exporting VITEST), the plist is
still written but launchd is not reloaded: the OLD watchdog keeps running
until the next clean update or login reload. Mild, self-healing degradation;
the plist content changes rarely. No legitimate test context is blocked —
tests keep full file-level coverage.

## 2. Under-block

Other test runners that set neither VITEST nor NODE_ENV=test would still
mutate launchd. The repo's only runner is vitest (sets VITEST in every
worker), so this is theoretical today; the guard is two ORed conditions wide
to cover the common alternates.

## 3. Level-of-abstraction fit

The guard sits exactly at the one launchd chokepoint in the migrator (the
only `launchctl` callsite in the file, verified by grep). A broader "no
side effects under test" framework would be the wrong altitude for a
two-line incident fix; if a second global-registry mutation appears, promote
the pattern then.

## 4. Signal vs authority compliance

No decision point over agent behavior or information flow — a test-context
guard on an OS mutation. The deterministic env check holds no blocking
authority over any judgment call.

## 5. Interactions

The migration still reports `fleet-watchdog: updated` under tests (file
writes happen), which existing tests rely on. No other component reads
launchd state. The skipped reload cannot race anything: production behavior
is byte-identical (env vars absent).

## 6. External surfaces

Restores the intended invariant that tests NEVER mutate machine state
outside their tmpdir. The one-time machine repair (re-bootstrap from the
canonical plist) was performed and verified this session.

## 7. Rollback cost

Revert the guard — production path was never altered. No data, no migration.

## Conclusion

Tier-1 (small, low-risk, test-environment-safety) — declared with
`--tier 1`. The risk-asymmetry is strongly favorable: the guard prevents a
machine-level breakage and its own worst failure mode is a deferred launchd
reload.
