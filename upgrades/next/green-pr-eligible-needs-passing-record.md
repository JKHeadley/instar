## What Changed

- The automatic merger only considers a pull request whose full test run passed. A failed run used to count as "verified", so a failed PR at the front of the line was attempted, refused and retried while ready PRs behind it waited.

## What to Tell Your User

Changes that passed their tests no longer wait behind one that failed.

## Evidence

- On a live agent the merger picked a PR whose test run had failed as the oldest ready one; it was refused, and the pass ended. Unit tests cover the passing-only rule and its wiring.

## Summary of New Capabilities

None.
