# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Test-hygiene: unit tests no longer load plists into the real launchd.** The
auto-start installer (`installMacOSLaunchAgent` / fleet-watchdog) did a real
`launchctl bootstrap` after writing a plist — so a unit test exercising the
plist-writing path loaded tmpdir-pointed plists into the operator's real launchd,
leaving inert stale entries behind. New `launchctlLoadAllowed()` gate skips the
live load under a test runner (vitest sets `VITEST`) or when
`INSTAR_SKIP_LAUNCHCTL_LOAD` is set. Production behavior is unchanged.

## What to Tell Your User

- Internal test-hygiene fix: my test suite no longer accidentally registers
  throwaway background-service entries on the machine it runs on. Nothing
  user-facing; production startup is unchanged.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| `launchctlLoadAllowed()` gate | Automatic — skips the live `launchctl bootstrap` under VITEST / `INSTAR_SKIP_LAUNCHCTL_LOAD`; production loads normally. |

## Evidence

**One helper + two install-path wraps; production load path unchanged.** Unit
test `tests/unit/launchctl-load-guard.test.ts` (3): false under VITEST, false
under the explicit opt-out, true in production. Verified the merged Track C test
now runs with NO real-launchd pollution (no stale mmtest* entries) while still
passing. `tsc` clean. Side-effects review:
`upgrades/side-effects/launchctl-test-hygiene.md`. Follow-up to Track C of
`docs/specs/MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC.md`.
