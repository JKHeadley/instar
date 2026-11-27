# Transport expiry evidence

## Summary

Tier 1. Three implementation and test files, 15 insertions and four deletions. One independent review of the verdict change and an additional assertion requested by the reviewers. The normal commit gate runs after the targeted tests.

## Effects and verification

The two expiry verdicts remain failed until a server-side expiry observation can establish ordering against Enter. A disconnect or a caller-supplied measurement cannot satisfy the expectation. The existing grace-window check still reports early duty closure alongside missing expiry evidence. Other verdicts use their existing evidence. The change affects proof reporting only and introduces no runtime action, permission or state migration.

Two synthetic cases reproduced false passes before the change. The reproduction and targeted timing and driver tests exercise the corrected verdict. Reverting the commit restores the previous verdict and its two false passes.

The first normal commit attempt blocked on the minimum overview length. The expanded overview explains the ambiguous ordering and how to interpret the synthetic tests.
