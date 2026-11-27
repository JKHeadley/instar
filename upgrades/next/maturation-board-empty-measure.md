# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The maturation board no longer drops a whole feature-maturation review when the review could not measure some features. A measure with every field empty is read as "no measure", the same as leaving it out. Before, one such feature made the board fall back silently to an older review.

## What to Tell Your User

The maturation board now always shows the latest review, even when some features could not be measured. Those features show no measure instead of hiding everyone's newest numbers.

## Summary of New Capabilities

None new. The board stays current when a review has unmeasured features.

## Evidence

Two unit tests in tests/unit/maturation-board.test.ts: a true placeholder reads as no measure, while a partial measure, a trend claim, a malformed trend or unknown keys stay invalid. On 2026-11-27 the Studio's board had rejected that day's review on features[16].measure.
