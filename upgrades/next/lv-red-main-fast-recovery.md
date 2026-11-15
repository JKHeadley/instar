# A broken main is re-tested within minutes, and a failed lint step stops doomed test runs

<!-- bump: patch -->

## What Changed

Two changes to Local Verify, both from the 2026-11-15 incident in which `main` failed `scripts/lint-framework-name-ratchet.mjs` for an hour and merging stayed closed for 2 h 34 min.

1. `decideMainHeadEnqueue` (`src/localVerify/mainHealth.ts`) takes `opts.healthy`. When `main` is suspect or red, a newly observed `main` head is enqueued for its verify once it has read the same for 2 minutes (`MAIN_VERIFY_LIMITS.unhealthyDebounceMs`), capped at 10 minutes after the first unverified head (`unhealthyDebounceCapMs`), instead of 10 and 30. `LocalVerifyService.noteMainHead` passes `this.health.isHealthy()`. Still one verify per head (`handled`); a healthy `main` behaves exactly as before. The wait is two minutes and not zero because the head is read from GitHub once a minute, and one stale read of the previous, failed head must not start a second verify of it or displace the repair's. On 2026-11-15 the repair merged at 01:13Z and `main` was only re-verified after a server restart at 02:24Z; two green PRs waited at `main-red · repair-only`.
2. `mainFailureFromRunDetail` (`src/localVerify/mainRedHold.ts`) also reads the run's reasons: `lint-failed:node scripts/<path>.{js,mjs,cjs}` adds that script to the failing files the main-red hold matches repairs against (new pure helper `lintScriptFromReason`). Until now a lint failure named no file, the hold answered `failing-files-unknown`, and every queued PR ran and failed the same step: 21 runs that day. A PR that touches the script or names its path, basename or stem is a repair candidate and runs; the others keep their place until `main` is green. Any other lint reason shape (the type check, a shell pipeline) still holds nothing.

No config, no migration, no change to what may merge.

## What to Tell Your User

Nothing changes for you. If the project's main line ever breaks one of its own quick checks, the test line now stops spending runs on changes that cannot fix it and reopens merging as soon as the repair is confirmed, instead of after a waiting period.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| A suspect or red main is re-verified 2 minutes after a new head appears (10 at most) | Automatic |
| The main-red hold covers a failing lint script | Automatic; kill switch unchanged (`monitoring.localVerify.mainRedHold: false`) |

## Evidence

- `tests/unit/localVerify/mainHealth.test.ts`: pure (unhealthy: ready after 2 unchanged minutes, not at first sight; one stale read of the failed head starts nothing; a head that never settles gets one verify per 10 minutes; healthy or unstated: 10 minutes as before; once per head) and service (after red, the repair head starts its verify 2 minutes after it is seen, through a stale read; a healthy main keeps the 10-minute debounce).
- `tests/unit/localVerify/mainRedHold.test.ts`: `lintScriptFromReason` shapes; the script joins the failing files after test files, once, under the cap; the incident replayed (PR 3182's text is a repair candidate, unrelated PRs are held); an unreadable lint shape still holds nothing.
- `tests/unit/localVerify/mainRedHoldService.test.ts`: a failed `main` whose lint step names a repo script activates the hold through the real service; the repair that names it takes the slot ahead of a PR queued first.
