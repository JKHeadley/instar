## What Changed

Case12.8 now creates a bounded proof-account watch-end fault with independent recovery, then requires native end-of-watch failure and the same server's matching security item within ten seconds. Early repeated-unlock failure no longer satisfies that case.

## Evidence

Actual detached supervisor tests use inert temporary workers; harness tests cover ordering, deadlines, process/duty correlation and recovery failure. No live Mac acceptance result is claimed. See `docs/specs/locked-proof-watch-end.eli16.md` and `upgrades/side-effects/locked-proof-watch-end.md` for safeguards and limits.

## What to Tell Your User

No new user action is needed. This improves the developer proof harness; it does not claim that a live locked-Mac acceptance run has passed.

## Summary of New Capabilities

The proof harness can check an actual watch-end failure with bounded independent recovery and exact security-item timing. Product relock policy is unchanged.
