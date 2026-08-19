---
change_type: fix
---

<!-- internal-only -->

## What Changed

The standards-coverage report now measures enforcement against a closed rule census and evidence read from the protected branch. Removing a rule is reported as a direction failure instead of improving the score. Empty, missing, candidate-only, structurally hollow, and executable-but-unproven references no longer receive enforcement credit merely because a path exists or an assertion executes.

References are graded on the existing ratchet, gate, lint, spec-only, and documented-only ladder. A content-bound certified verdict from the protected side can supersede structural grading only when its evidence binds the cited rule to an independent subject and records the same real check passing cleanly before a landed rule-violation mutation makes an assertion fail. The candidate rule digest, observer, and subject must still match that protected proof; candidate-authored verdict records are ignored. Empty or unreadable populations fail measurement rather than reporting 100%.

## Evidence

The live protected baseline measures 0 of 88 rules at proven ratchet, gate, or lint strength because it contains no protected relevance + fail-direction proof ledger; all 88 are reported as unverified rather than receiving structural credit. Mandatory controls prove that deleting an unenforced rule leaves the score unchanged and reports the removal, emptying a cited test drops its contribution, adding a rule with a prose-only test does not increase enforcement, and an already-censused executable `expect(true)` assertion is refused proven strength.

## Known Limits

This change measures protected, behaviorally certified enforcement evidence and uses structural inspection only to explain why an uncertified reference is hollow or unverified. It does not itself certify a guard or alter CI wiring. Independent judge re-certification of this measurement remains pending.
