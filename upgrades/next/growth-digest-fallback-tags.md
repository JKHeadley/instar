<!-- bump: patch -->

## What Changed

Refreshing this branch against `main` tripped the `no-silent-fallbacks` ratchet at 497 against a
baseline of 495. Both new entries are this branch's own, in `GrowthDigestPublisher.ts` — the ratchet
post-dates this code, so it had never been measured against it.

Neither is a silent swallow. The audit catch reports through `deps.onError` and continues, because a
failing audit sink must not abort the digest it is recording. `escalationActive()` reports through
`deps.onError` and returns `false`, failing toward LEGACY exactly as its own doc comment already
promised. Both now carry `@silent-fallback-ok` with that reasoning inline.

The baseline stays at **495**. Raising it was the one-character alternative and would have retired the
ratchet for every future change.

## What to Tell Your User

Nothing — comments only, no behaviour change, in a feature that ships dark.

## Summary of New Capabilities

None.

## Evidence

- `tests/unit/no-silent-fallbacks.test.ts`: 1 failed → 5/5 green, baseline unchanged.
- The two entries were located by diffing per-file counts between `main` and this branch (main=0,
  branch=2), not by reading a 497-line list — line numbers shift between branches.
- Both match the exempt case the ratchet's own comments describe: "a fail-safe failing toward the safe
  direction — not a new swallow."
