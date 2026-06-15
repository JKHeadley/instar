<!-- internal-only -->

## What Changed

`scripts/safe-merge.mjs` gained a `--auto` flag: it arms GitHub native
auto-merge (`gh pr merge --auto`) and returns immediately, instead of polling
the PR's checks until a deadline and force-merging with `--admin`. Native
auto-merge lets GitHub merge the PR the instant every required check passes —
it bypasses no check (strictly safer than `--admin`, which it then has to
re-impose) and it never times out (the failure mode that wedged hot-branch
merges: the poll watcher gets killed at ~18min before slow CI finishes).

`--auto` and `--admin` are mutually exclusive (parser-enforced). New exit code
`5 = auto-merge-armed` (distinct from `0 = merged-confirmed`). The existing
`--admin` synchronous path is byte-untouched and remains the fallback for repos
without "Allow auto-merge" enabled.

## Evidence

- `scripts/safe-merge.mjs`: new `--auto` flag, mutual-exclusion guard,
  `native-auto-merge` capability + `autoMergeArmed:5` exit code, and the
  arm-and-confirm block in `main()` (early-returns before the poll loop, so the
  `--admin` path is unaffected).
- `tests/unit/safe-merge-hardening.test.ts`: +4 tests (parses `--auto`, defaults
  off, rejects `--auto --admin` both orders, capabilities exposes the new
  feature + exit code). 29/29 green.
- Second-pass review (merge machinery): CONCUR.

Follow-up (separately spec'd, NOT in this PR): switch the green-pr-automerge
watcher (`MergeRunner`) to `--auto` so the automated path also stops timing out.
