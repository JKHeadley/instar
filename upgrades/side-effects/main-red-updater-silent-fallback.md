# Side-Effects Review — Main red: updater npm-cli probe marked as a deliberate fallback

**Version / slug:** `main-red-updater-silent-fallback`
**Date:** `2026-11-21`
**Author:** Echo

## Summary

PR #3603 added a loop in `UpdateChecker` that tries several candidate paths for
npm's CLI script next to the runtime node and moves on when one does not exist.
Its catch block falls through to the next candidate, which the
`tests/unit/no-silent-fallbacks.test.ts` ratchet counts as a new silent fallback
(495 against a baseline of 494). Main has been red on that check since
2026-11-21 20:41 UTC and every queued pull request is held behind it.

This change adds the `@silent-fallback-ok` marker with its reason to that one
catch block. No behaviour changes; only a comment.

## Decision-point inventory

- None changed. The probe still tries the next candidate and returns null when
  none fits, exactly as merged in #3603.

## 1. Over-block

None: no runtime logic changes.

## 2. Under-block

The ratchet keeps its baseline of 494; nothing is hidden by raising the count.

## 3. Level-of-abstraction fit

A missing candidate path is the expected case for all but one layout, so
reporting it as a degradation would be noise. The marker is the ratchet's
documented exemption for exactly this.

## 4. Signal vs authority

Not applicable: no gate, sentinel or decision is touched.

## 5. Interactions

None. Comment-only change in one file.

## 6. External surfaces

None.

## 7. Rollback cost

Revert the one-line comment change.
