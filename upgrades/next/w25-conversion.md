---
change_type: fix
---

## What Changed

The Window 25 conversion release (PR #1973) lands the verified repairs from the Window 24
guard audit as one integrated, fully-tested release — 27 commits, validated by the complete
test suite (49,938 tests, zero failures) on the exact merged tree.

The headline behavioral change: **an emergency stop no longer erases the record of the
autonomous run it stops.** Previously, stopping a run deleted its state file, destroying the
evidence of what the run was doing and how far it got. The run record is now preserved and
marked stopped (`active: false` plus a `stopped_at` timestamp), so a stopped run can be
inspected, audited, and — where appropriate — resumed, instead of vanishing. The seam tests
that previously asserted the old delete-on-stop behavior were rewritten to pin the new
contract in full, with a comment on every changed line explaining the contract replacement.

Alongside it, the release removes two silent-fallback paths surfaced during integration
(the no-silent-fallbacks ratchet tightened from 496 to 495) and carries the selected
guard repairs proven on branches during the Window 24 measurement audit.

## Evidence

The release candidate was built by controlled composition: each repair merged and attributed
by A/B testing (same tree with and without the change), the excluded repair proven absent by
ancestry check, and the final gating suite run on the exact merge tip — 3,166 test files,
49,938 tests passed, 0 failed, exit 0. A revert control confirmed the emergency-stop repair:
reverting it restores both seam-test failures.

## Known Limits

One repair originally slated for this release was excluded: its fix conflicted with tests
asserting the old (incorrect) contract and was repaired and included only after that
contradiction was resolved; the interaction-only failures seen during composition did not
reproduce in four configurations and are tracked as flaky. The measurement blocker from
Window 24 (hook-event coverage reporting) remains open as a registered defect — this
release does not claim to fix it.
