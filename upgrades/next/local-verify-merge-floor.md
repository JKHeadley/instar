## What Changed

- **safe-merge reads `main`'s branch protection the way a non-admin can.** It used to call `GET /branches/<b>/protection`, which answers 404 for a non-admin login, and treated that as "no protection", so it never saw the 12 GitHub Actions checks classic protection requires. It now reads `GET /branches/<b>` (`protection.required_status_checks`). Those 12 contexts are pinned with their producer in `ACTIONS_FLOOR_CONTEXTS` (`REQUIRED_CONTEXTS_FLOOR` plus the classic list, excluding `instar/local-verify`), which the synchronous path, `--admin` included, now enforces. A required `instar/local-verify` is read from the combined-status API.
- **A `local` merge floor for safe-merge and the green-PR watcher** (spec `docs/specs/local-verify-merge-authority.md` §3, piece 3 of 4). Off unless `monitoring.greenPrAutoMerge.floor` is `local` and the server reports the floor as effective, which requires GitHub's own settings to require `instar/local-verify` and no classic checks. Under it, safe-merge skips the Actions waits and admits a PR only on the server's local-verify record for that exact head and base (plus the merge-time body checks, operator approval of the exact head for harness-changing or protected PRs, and the main-health repair rule); anything unreadable refuses, and it never falls back to Actions. The watcher's candidate filter becomes record-gated and local merges run through a new `sync` MergeRunner strategy (no `--auto`, no `--admin`). New shared module `scripts/local-verify-floor.mjs`.

## What to Tell Your User

Nothing changes yet for you. The merge tool now correctly sees which GitHub checks your main branch requires; it used to miss them. The part that lets merges trust my own local test run instead of waiting on GitHub stays off until you approve the switch.

## Summary of New Capabilities

- safe-merge `--capabilities` reports `floorModes`.
- `monitoring.greenPrAutoMerge.floor` (`actions` default, `local`).

## Evidence

- `tests/unit/safe-merge-hardening.test.ts` (protection read as a non-admin, the pinned floor, `instar/local-verify` from commit statuses)
- `tests/unit/safe-merge-local-floor.test.ts` and `tests/integration/safe-merge-local-floor.test.ts` (every predicate rule both ways against a stub server; no fallback; verify-pending; GIT_* stripped)
- `tests/unit/green-pr-local-floor.test.ts`, `tests/unit/merge-runner.test.ts`, `tests/unit/green-pr-logic.test.ts` (`sync` passes neither flag; record-gated candidates; disarm once on the switch; import-closure hash pin)
