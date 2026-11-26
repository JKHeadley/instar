# Review of unit snapshot RPC recovery

The first external review identified a changed-snapshot risk. The retry now checks that the merge worktree still has a clean Git status, and a regression injects a changed snapshot. The second external review requested coverage of the split-unit allowance and total deadline. Controlled-clock regressions cover both, and the spec identifies which command inputs remain identical. A third external call timed out.

A fresh-context source review identified a zero-error reporter record with missing or contradictory messages. The final diff requires the expected message list for both the original error and clean retry evidence. It preserves the existing assertion isolation rules and the final inventory and dirty-tree checks. The reader reviewed the revised source and tests and concurred without blockers.

The design has no unresolved decisions. The approved scope is one bounded retry for the specific unit worker failure using the existing verifier authority. The evidence does not identify the suite file or claim to recreate the original scheduling stall.
