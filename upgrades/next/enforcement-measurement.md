---
change_type: fix
---

<!-- internal-only -->

## What Changed

The standards-coverage report now measures enforcement against a closed rule census and evidence read from the protected branch. Removing a rule is reported as a direction failure instead of improving the score. Empty, missing, candidate-only, and structurally hollow references no longer receive enforcement credit merely because a path exists.

References are graded on the existing ratchet, gate, lint, spec-only, and documented-only ladder. A content-bound certified verdict from the protected side can supersede structural grading; candidate-authored verdict records are ignored. Empty or unreadable populations fail measurement rather than reporting 100%.

## Evidence

The live protected baseline measures 58 of 88 rules at executable ratchet, gate, or lint strength. Mandatory controls prove that deleting an unenforced rule leaves the score unchanged and reports the removal, emptying a cited test drops its contribution, and adding a rule with a prose-only test does not increase enforcement.

## Known Limits

This change measures structural enforcement evidence and consumes certified verdicts when a protected verdict ledger exists. It does not itself certify a guard or alter CI wiring. Independent judge certification of this measurement remains pending.
