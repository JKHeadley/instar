# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Every feature still waiting on its maturation ladder now records who decides its next step and by when. The ladder file gains an owner, a review date and a reason for that date on each waiting entry, and the ladder API returns them. A new development check fails a waiting entry that has no owner or no real calendar date. A review date that has passed is reported by name, but it never stops anyone's commit.

## What to Tell Your User

Nothing needs doing. If you look at a feature's maturation details, you may now see who owns its next step and when it is due for review.

## Summary of New Capabilities

- Every feature waiting on its next maturation step now records who decides that step (`tracking.owner`) and by when (`tracking.reviewDue`, a real calendar date). A new check on every commit refuses a waiting feature that is missing either one, and lists every overdue step by name without stopping anyone's commit.

## Evidence

Tests: tests/unit/lint-maturation-dated-owner.test.ts plus the existing ladder tests, 64 of 64. The lint reports 231 waiting entries, each with an owner and a date, and 0 past due.
