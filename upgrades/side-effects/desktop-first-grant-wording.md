# First-grant permission wording

Tier 1. Two production files (`src/core/DesktopProbeReadiness.ts`, `src/core/DesktopHelperPermissionNotice.ts`), one test file, one implementation pass. Wording only.

## Decision and operator impact

`helperChangeReason` gave the `first-grant` case the retained-helper migration story ("Instar now keeps one permanent copy ... allow it again"). The retention record cannot tell a Mac moving to the kept copy from a freshly installed or rebuilt Mac: both have `grantedSourceHash: null`. The new wording is true in both cases: macOS has not yet allowed the kept copy, it will not fix itself, allow it once, then the same settings path, helper path and Retry step. The `source-changed` wording is unchanged. The Attention item title drops "again" for `first-grant` only.

Found live: the rebuilt Mac Studio (20 November 2026, after the 19 November outage) reported the migration story on a Mac that had never granted anything.

## Verification and rollback

`tests/unit/DesktopHelperPermissionNotice.test.ts` now asserts the first-grant reason (active session and locked screen) contains no "again", no update version and no "now keeps", and that the Attention title for a first grant has no "again". The five related unit files pass (81 tests); `tsc --noEmit` is clean. No routes, fields, readiness decisions or persisted state change. Revert the commit to restore the old wording.

## Class-Closure Declaration

The defect class is claim-vs-evidence: a status sentence asserted a history ("again", an update) that the record does not hold. The test pins both sides of the boundary: `source-changed` still names the update; `first-grant` asserts nothing about history.

## 6b. Operator-surface quality

ELI16: docs/specs/desktop-first-grant-wording.eli16.md.

One plain sentence on what is wrong, then the one action, as before. The steps now handle both an unlisted helper (add it with the plus button) and a listed one (turn it on, or off and on).
