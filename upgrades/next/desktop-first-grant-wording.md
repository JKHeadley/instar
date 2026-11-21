<!-- bump: patch -->
## What Changed

A Mac whose Remote Desktop helper has never been allowed by macOS (a new Mac, or one erased and rebuilt) no longer reads "Instar now keeps one permanent copy ... allow it again". The `first-grant` reason in `desktopProbeUnavailableReason` now says macOS has not yet allowed the helper on this Mac and asks someone at the Mac to allow it once, with the same settings path, helper path and Retry step. The Attention item title for this case drops "again". A helper that changed in an update keeps its existing wording.

## What to Tell Your User

On a new or rebuilt Mac, Remote Desktop now says plainly that the Mac has not allowed it yet and what to turn on, instead of talking about an update that never happened.

## Summary of New Capabilities

None — wording fix only; no routes, fields or readiness decisions change.

## Evidence

- Unit: `tests/unit/DesktopHelperPermissionNotice.test.ts` — first-grant reason (active and locked screen) has no "again", no update version, no "now keeps"; first-grant Attention title has no "again"; source-changed wording unchanged. Five related unit files: 81 tests pass.
- Live: the rebuilt Mac Studio's `/desktop/diagnostics` (20 Nov 2026) showed `helperChange.kind: "first-grant"` with the old update story on a Mac that never granted anything.
