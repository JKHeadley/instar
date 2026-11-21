# The updater's npm layout probe states why a missing candidate is skipped

<!-- bump: patch -->

## What Changed

`main` counted 495 catch blocks against the no-silent-fallbacks ratchet's baseline of 494 after #3603 merged: `UpdateChecker.findBundledNpmCli` probes a few candidate paths for the npm bundled beside the runtime node, and its `catch { /* not this layout */ }` sits within the ratchet's 20-line window of the method's `return null;`. That catch now carries its in-brace `@silent-fallback-ok` reason (a candidate path that does not exist or is not a file is simply not this layout; the loop tries the next candidate). Comment only; no behaviour changes and the baseline is not raised. It rides on the takeover-ready pool spec branch because that branch's Local Verify run was the one that surfaced it; it heals `main` when either lands.

## What to Tell Your User

- Nothing changes for you. This is a one-line note inside the updater's code that keeps the project's own test gate honest; the updater behaves exactly as before.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| None (comment-only) | — |

## Evidence

- `tests/unit/no-silent-fallbacks.test.ts` passes on this branch merged with current `main` (and fails on `main` alone with 495 against 494).
- `tests/unit/UpdateChecker.test.ts` and `tests/unit/update-checker-apply.test.ts` pass on this branch (53 tests).
